import cors from "@fastify/cors";
import Fastify from "fastify";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderAdapter } from "@langrensha/llm-gateway";
import { AIDecisionProgress, AIDecisionRequest, AIDecisionResponse, buildAIDecision } from "./aiDecision";
import { AIRequestRegistry } from "./aiRequestRegistry";
import { AIConfigRepository, ConfigValidationError } from "./configStore";
import { buildAllowedOrigins, isAllowedCorsOrigin } from "./cors";

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DATA_DIR = process.env.LANGRENSHA_DATA_DIR ? path.resolve(process.env.LANGRENSHA_DATA_DIR) : path.join(WORKSPACE_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "ai-config.json");
const LEGACY_CONFIG_PATH = path.join(WORKSPACE_ROOT, "apps/server/data/ai-config.json");
const configRepository = new AIConfigRepository(CONFIG_PATH, LEGACY_CONFIG_PATH);
const ALLOWED_ORIGINS = buildAllowedOrigins(process.env.LANGRENSHA_ALLOWED_ORIGINS);
const AI_STATUS_TTL_MS = 10 * 60 * 1000;
const aiStatuses = new Map<string, AIDecisionProgress & { startedAt: string; updatedAt: string; active: boolean }>();
const aiRequests = new AIRequestRegistry<AIDecisionResponse>(AI_STATUS_TTL_MS);

const fastify = Fastify({
  logger: true,
  bodyLimit: Number(process.env.LANGRENSHA_BODY_LIMIT_BYTES ?? 10 * 1024 * 1024)
});
await fastify.register(cors, {
  origin: (origin, callback) => {
    callback(null, isAllowedCorsOrigin(origin, ALLOWED_ORIGINS));
  }
});

fastify.get("/api/health", async () => ({ ok: true }));

fastify.get("/api/config", async () => configRepository.load());

fastify.put<{ Body: unknown }>("/api/config", async (request, reply) => {
  try {
    return await configRepository.save(request.body);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return reply.code(422).send({ ok: false, error: error.message });
    }
    throw error;
  }
});

fastify.post<{
  Body: {
    providerId: string;
    apiKey?: string;
  };
}>("/api/llm/test", async (request) => {
  const config = await configRepository.load();
  const provider = config.providers.find((item) => item.id === request.body.providerId);
  if (!provider) {
    return { ok: false, error: "找不到供应商配置" };
  }
  try {
    const adapter = createProviderAdapter(provider);
    const apiKey = request.body.apiKey?.trim();
    if (!provider.baseUrl.startsWith("mock://") && !apiKey) {
      return { ok: false, error: "缺少本机 API Key / Access Token" };
    }
    const models = await adapter.listModels(provider, apiKey);
    return { ok: true, models: models.slice(0, 20) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

fastify.get<{ Params: { requestId: string } }>("/api/ai/status/:requestId", async (request) => {
  pruneAIStatuses();
  const status = aiStatuses.get(request.params.requestId);
  if (!status) {
    return { ok: false, error: "找不到 AI 请求状态" };
  }
  return { ok: true, status };
});

fastify.post<{ Body: AIDecisionRequest }>("/api/ai/decision", async (request) => {
  const requestId = request.body.requestId || crypto.randomUUID();
  const fingerprint = decisionFingerprint(request.body);
  const registration = aiRequests.getOrCreate(requestId, fingerprint, async (signal) => {
    recordAIProgress({
      requestId,
      status: "received",
      message: "服务端已收到 AI 决策请求。"
    });
    try {
      const config = await configRepository.load();
      return await buildAIDecision({ ...request.body, requestId, signal }, config, undefined, createProviderAdapter, recordAIProgress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordAIProgress({ requestId, status: "failed", message: "AI 决策请求失败。", error: message });
      return { ok: false, fallback: false, error: message };
    } finally {
      markAIRequestSettled(requestId);
    }
  });
  if (registration.kind === "conflict") {
    return { ok: false, fallback: false, error: "requestId 已用于不同 AI 决策" };
  }
  if (registration.kind === "cancelled") {
    return { ok: false, fallback: false, error: "AI 请求已取消" };
  }
  return registration.promise;
});

fastify.post<{ Params: { requestId: string } }>("/api/ai/cancel/:requestId", async (request) => {
  const cancelled = aiRequests.cancel(request.params.requestId);
  if (cancelled) {
    recordAIProgress({
      requestId: request.params.requestId,
      status: "failed",
      message: "AI 请求已取消",
      error: "AI 请求已取消"
    });
  }
  return { ok: true, cancelled };
});

const port = Number(process.env.PORT ?? 12001);
const host = process.env.HOST ?? "127.0.0.1";
await fastify.listen({ port, host });

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
    updatedAt: now,
    active: !["completed", "fallback", "failed"].includes(progress.status)
  });
  pruneAIStatuses();
}

function markAIRequestSettled(requestId: string): void {
  const status = aiStatuses.get(requestId);
  if (!status) return;
  aiStatuses.set(requestId, { ...status, active: false, updatedAt: new Date().toISOString() });
}

function pruneAIStatuses(): void {
  const cutoff = Date.now() - AI_STATUS_TTL_MS;
  for (const [requestId, status] of aiStatuses.entries()) {
    if (!status.active && new Date(status.updatedAt).getTime() < cutoff) {
      aiStatuses.delete(requestId);
    }
  }
  aiRequests.prune();
}

function decisionFingerprint(request: AIDecisionRequest): string {
  // Include every non-secret decision input so a reused requestId cannot return
  // a result built from stale events, memory, resources, or compression rules.
  const canonicalInput = JSON.stringify({
    state: request.state,
    seatId: request.seatId,
    contextCompression: request.contextCompression
  });
  return crypto.createHash("sha256").update(canonicalInput).digest("hex");
}
