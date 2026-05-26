import cors from "@fastify/cors";
import Fastify from "fastify";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderAdapter } from "@langrensha/llm-gateway";
import { AIConfigStore, DEFAULT_AI_CONFIG, DEFAULT_COST_CONTROLS } from "@langrensha/shared";
import { AIDecisionProgress, AIDecisionRequest, buildAIDecision } from "./aiDecision";
import { buildAllowedOrigins, isAllowedCorsOrigin } from "./cors";

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DATA_DIR = process.env.LANGRENSHA_DATA_DIR ? path.resolve(process.env.LANGRENSHA_DATA_DIR) : path.join(WORKSPACE_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "ai-config.json");
const LEGACY_CONFIG_PATH = path.join(WORKSPACE_ROOT, "apps/server/data/ai-config.json");
const STORED_SECRET_SENTINEL = "__stored__";
const ALLOWED_ORIGINS = buildAllowedOrigins(process.env.LANGRENSHA_ALLOWED_ORIGINS);
const AI_STATUS_TTL_MS = 10 * 60 * 1000;
const aiStatuses = new Map<string, AIDecisionProgress & { startedAt: string; updatedAt: string }>();

const fastify = Fastify({ logger: true });
await fastify.register(cors, {
  origin: (origin, callback) => {
    callback(null, isAllowedCorsOrigin(origin, ALLOWED_ORIGINS));
  }
});

fastify.get("/api/health", async () => ({ ok: true }));

fastify.get("/api/config", async () => maskConfig(await loadConfig()));

fastify.put<{ Body: AIConfigStore }>("/api/config", async (request) => {
  const existing = await loadConfig();
  const normalized = normalizeIncomingConfig(request.body, existing);
  await saveConfig(normalized);
  return maskConfig(normalized);
});

fastify.post<{
  Body: {
    providerId: string;
    apiKey?: string;
  };
}>("/api/llm/test", async (request) => {
  const config = await loadConfig();
  const provider = config.providers.find((item) => item.id === request.body.providerId);
  if (!provider) {
    return { ok: false, error: "找不到供应商配置" };
  }
  try {
    const adapter = createProviderAdapter(provider);
    const apiKey = request.body.apiKey || decryptSecret(provider.apiKeyEncrypted);
    const models = await adapter.listModels(provider, apiKey);
    return { ok: true, models: models.slice(0, 20) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

fastify.get<{ Params: { requestId: string } }>("/api/ai/status/:requestId", async (request, reply) => {
  pruneAIStatuses();
  const status = aiStatuses.get(request.params.requestId);
  if (!status) {
    reply.code(404);
    return { ok: false, error: "找不到 AI 请求状态" };
  }
  return { ok: true, status };
});

fastify.post<{ Body: AIDecisionRequest }>("/api/ai/decision", async (request) => {
  const config = await loadConfig();
  const requestId = request.body.requestId || crypto.randomUUID();
  recordAIProgress({
    requestId,
    status: "received",
    message: "服务端已收到 AI 决策请求。"
  });
  return buildAIDecision({ ...request.body, requestId }, config, decryptSecret, createProviderAdapter, recordAIProgress);
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
await fastify.listen({ port, host });

async function loadConfig(): Promise<AIConfigStore> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await migrateLegacyConfig();
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return withConfigDefaults(JSON.parse(raw) as AIConfigStore);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await saveConfig(DEFAULT_AI_CONFIG);
    return DEFAULT_AI_CONFIG;
  }
}

async function saveConfig(config: AIConfigStore): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function recordAIProgress(progress: AIDecisionProgress): void {
  const now = new Date().toISOString();
  const requestId = progress.requestId;
  if (!requestId) return;
  const existing = aiStatuses.get(requestId);
  aiStatuses.set(requestId, {
    ...existing,
    ...progress,
    requestId,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now
  });
  pruneAIStatuses();
}

function pruneAIStatuses(): void {
  const cutoff = Date.now() - AI_STATUS_TTL_MS;
  for (const [requestId, status] of aiStatuses.entries()) {
    if (new Date(status.updatedAt).getTime() < cutoff) {
      aiStatuses.delete(requestId);
    }
  }
}

function normalizeIncomingConfig(next: AIConfigStore, existing: AIConfigStore): AIConfigStore {
  const existingProviders = new Map(existing.providers.map((provider) => [provider.id, provider]));
  return {
    ...next,
    costControls: next.costControls ?? existing.costControls ?? DEFAULT_COST_CONTROLS,
    providers: next.providers.map((provider) => {
      const previous = existingProviders.get(provider.id);
      const incomingSecret = provider.apiKeyEncrypted;
      let apiKeyEncrypted = incomingSecret;
      if (!incomingSecret || incomingSecret === STORED_SECRET_SENTINEL) {
        apiKeyEncrypted = previous?.apiKeyEncrypted;
      } else if (!incomingSecret.startsWith("enc:v1:")) {
        apiKeyEncrypted = encryptSecret(incomingSecret);
      }
      return { ...provider, apiKeyEncrypted };
    })
  };
}

function withConfigDefaults(config: AIConfigStore): AIConfigStore {
  return {
    ...config,
    costControls: config.costControls ?? DEFAULT_COST_CONTROLS
  };
}

function maskConfig(config: AIConfigStore): AIConfigStore {
  return {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      apiKeyEncrypted: provider.apiKeyEncrypted ? STORED_SECRET_SENTINEL : undefined
    }))
  };
}

function encryptSecret(secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(encrypted: string | undefined): string | undefined {
  if (!encrypted) return undefined;
  if (!encrypted.startsWith("enc:v1:")) return encrypted;
  const [, , ivText, tagText, payloadText] = encrypted.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payloadText, "base64")), decipher.final()]).toString("utf8");
}

function getEncryptionKey(): Buffer {
  const secret = process.env.LANGRENSHA_CONFIG_SECRET || "langrensha-local-development-secret";
  return crypto.createHash("sha256").update(secret).digest();
}

async function migrateLegacyConfig(): Promise<void> {
  if (CONFIG_PATH === LEGACY_CONFIG_PATH) return;
  const [rootExists, legacyExists] = await Promise.all([fileExists(CONFIG_PATH), fileExists(LEGACY_CONFIG_PATH)]);
  if (!rootExists && legacyExists) {
    await fs.copyFile(LEGACY_CONFIG_PATH, CONFIG_PATH);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
