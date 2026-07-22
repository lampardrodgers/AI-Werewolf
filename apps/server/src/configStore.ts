import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  AIConfigStore,
  AIPersona,
  DEFAULT_AI_CONFIG,
  DEFAULT_CONTEXT_COMPRESSION,
  DEFAULT_COST_CONTROLS,
  ModelConfig,
  ProviderAccount
} from "@langrensha/shared";

const PROVIDER_TYPES = new Set(["openai", "openai_compatible", "anthropic", "gemini", "xai", "codex_cli_local"]);
const AUTH_TYPES = new Set(["api_key", "oauth", "access_token"]);
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "max"]);
const THINKING_MODES = new Set(["auto", "enabled", "disabled"]);
const SPEECH_STYLES = new Set(["冷静", "激进", "幽默", "老玩家", "新手", "阴阳怪气", "简洁"]);
const REASONING_STRENGTHS = new Set(["fast", "normal", "deep"]);
const SPEECH_LENGTHS = new Set(["short", "medium", "long"]);

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export function validateAndNormalizeAIConfig(input: unknown): AIConfigStore {
  const root = record(input, "配置");
  const providers = array(root.providers, "providers").map((value, index) => parseProvider(value, `providers[${index}]`));
  const models = array(root.models, "models").map((value, index) => normalizeModelConfig(parseModel(value, `models[${index}]`)));
  const personas = array(root.personas, "personas").map((value, index) => parsePersona(value, `personas[${index}]`));
  if (providers.length === 0 || models.length === 0 || personas.length === 0) {
    throw new ConfigValidationError("providers、models 和 personas 都至少需要一项。");
  }
  assertUnique(providers.map((provider) => provider.id), "provider id");
  assertUnique(models.map((model) => model.id), "model id");
  assertUnique(models.map((model) => `${model.providerId}\u0000${model.name}`), "provider/model");
  assertUnique(personas.map((persona) => persona.id), "persona id");

  const providerIds = new Set(providers.map((provider) => provider.id));
  const modelKeys = new Set(models.map((model) => `${model.providerId}\u0000${model.name}`));
  for (const model of models) {
    if (!providerIds.has(model.providerId)) throw new ConfigValidationError(`模型 ${model.id} 指向不存在的供应商 ${model.providerId}。`);
  }
  for (const persona of personas) {
    if (!providerIds.has(persona.defaultProviderId)) {
      throw new ConfigValidationError(`角色卡 ${persona.id} 指向不存在的供应商 ${persona.defaultProviderId}。`);
    }
    if (!modelKeys.has(`${persona.defaultProviderId}\u0000${persona.defaultModel}`)) {
      throw new ConfigValidationError(`角色卡 ${persona.id} 指向不存在的模型 ${persona.defaultProviderId}/${persona.defaultModel}。`);
    }
  }

  const controlsSource = root.costControls === undefined ? DEFAULT_COST_CONTROLS : record(root.costControls, "costControls");
  const compressionSource = root.contextCompression === undefined ? DEFAULT_CONTEXT_COMPRESSION : record(root.contextCompression, "contextCompression");
  return {
    providers,
    models,
    personas,
    costControls: {
      enabled: booleanValue(controlsSource.enabled, "costControls.enabled"),
      maxGameCost: finiteNumber(controlsSource.maxGameCost, "costControls.maxGameCost", 0),
      maxSeatCost: finiteNumber(controlsSource.maxSeatCost, "costControls.maxSeatCost", 0),
      maxOutputTokensPerCall: finiteNumber(controlsSource.maxOutputTokensPerCall, "costControls.maxOutputTokensPerCall", 1, 10_000_000, true)
    },
    contextCompression: {
      enabled: booleanValue(compressionSource.enabled, "contextCompression.enabled"),
      mode: enumValue(compressionSource.mode, new Set(["auto", "full_only"]), "contextCompression.mode") as "auto" | "full_only"
    }
  };
}

export class AIConfigRepository {
  readonly backupPath: string;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    readonly configPath: string,
    private readonly legacyConfigPath?: string
  ) {
    this.backupPath = `${configPath}.last-good`;
  }

  async load(): Promise<AIConfigStore> {
    return this.enqueue(() => this.loadUnlocked());
  }

  async save(input: unknown): Promise<AIConfigStore> {
    const normalized = validateAndNormalizeAIConfig(input);
    return this.enqueue(async () => {
      await this.writeConfig(normalized);
      return normalized;
    });
  }

  private async loadUnlocked(): Promise<AIConfigStore> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const normalized = validateAndNormalizeAIConfig(parsed);
      if (hasStoredProviderSecrets(parsed)) {
        await this.writeConfig(normalized);
      } else {
        await this.ensureBackup(normalized);
      }
      return normalized;
    } catch (primaryError) {
      if (isMissing(primaryError)) {
        const migrated = await this.loadLegacyConfig();
        const initial = migrated ?? validateAndNormalizeAIConfig(DEFAULT_AI_CONFIG);
        await this.writeConfig(initial);
        return initial;
      }
      try {
        const backupRaw = await fs.readFile(this.backupPath, "utf8");
        const backup = validateAndNormalizeAIConfig(JSON.parse(backupRaw) as unknown);
        await this.writeConfig(backup);
        return backup;
      } catch {
        throw primaryError;
      }
    }
  }

  private enqueue<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.writeTail.then(operation);
    this.writeTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async loadLegacyConfig(): Promise<AIConfigStore | undefined> {
    if (!this.legacyConfigPath || this.legacyConfigPath === this.configPath) return undefined;
    try {
      return validateAndNormalizeAIConfig(JSON.parse(await fs.readFile(this.legacyConfigPath, "utf8")) as unknown);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private async writeConfig(config: AIConfigStore): Promise<void> {
    const text = `${JSON.stringify(config, null, 2)}\n`;
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await atomicWriteFile(this.configPath, text);
    await atomicWriteFile(this.backupPath, text);
  }

  private async ensureBackup(config: AIConfigStore): Promise<void> {
    const text = `${JSON.stringify(config, null, 2)}\n`;
    try {
      if ((await fs.readFile(this.backupPath, "utf8")) === text) return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await atomicWriteFile(this.backupPath, text);
  }
}

function parseProvider(input: unknown, label: string): ProviderAccount {
  const value = record(input, label);
  const baseUrl = nonEmptyString(value.baseUrl, `${label}.baseUrl`);
  validateBaseUrl(baseUrl, `${label}.baseUrl`);
  const rateLimit = record(value.rateLimit, `${label}.rateLimit`);
  const provider: ProviderAccount = {
    id: nonEmptyString(value.id, `${label}.id`),
    name: nonEmptyString(value.name, `${label}.name`),
    type: enumValue(value.type, PROVIDER_TYPES, `${label}.type`) as ProviderAccount["type"],
    baseUrl,
    apiKeyEncrypted: undefined,
    authType: enumValue(value.authType, AUTH_TYPES, `${label}.authType`) as ProviderAccount["authType"],
    enabled: booleanValue(value.enabled, `${label}.enabled`),
    rateLimit: {
      rpm: finiteNumber(rateLimit.rpm, `${label}.rateLimit.rpm`, 1, Number.MAX_SAFE_INTEGER, true),
      tpm: finiteNumber(rateLimit.tpm, `${label}.rateLimit.tpm`, 1, Number.MAX_SAFE_INTEGER, true),
      concurrency: finiteNumber(rateLimit.concurrency, `${label}.rateLimit.concurrency`, 1, 1024, true)
    },
    timeoutMs: finiteNumber(value.timeoutMs, `${label}.timeoutMs`, 0, 3_600_000, true),
    retryCount: finiteNumber(value.retryCount, `${label}.retryCount`, 0, 2, true),
    defaultModel: nonEmptyString(value.defaultModel, `${label}.defaultModel`),
    supportsJsonSchema: booleanValue(value.supportsJsonSchema, `${label}.supportsJsonSchema`),
    supportsToolCall: booleanValue(value.supportsToolCall, `${label}.supportsToolCall`),
    supportsStreaming: booleanValue(value.supportsStreaming, `${label}.supportsStreaming`),
    supportsReasoningEffort: booleanValue(value.supportsReasoningEffort, `${label}.supportsReasoningEffort`),
    supportsModelList: booleanValue(value.supportsModelList, `${label}.supportsModelList`)
  };
  if (value.reasoningEffort !== undefined) provider.reasoningEffort = enumValue(value.reasoningEffort, REASONING_EFFORTS, `${label}.reasoningEffort`) as ProviderAccount["reasoningEffort"];
  if (value.thinkingMode !== undefined) provider.thinkingMode = enumValue(value.thinkingMode, THINKING_MODES, `${label}.thinkingMode`) as ProviderAccount["thinkingMode"];
  if (provider.baseUrl.includes("api.deepseek.com") && (provider.reasoningEffort ?? "minimal") === "minimal") {
    provider.thinkingMode = "enabled";
    provider.reasoningEffort = "high";
  }
  return provider;
}

function parseModel(input: unknown, label: string): ModelConfig {
  const value = record(input, label);
  const contextWindow = finiteNumber(value.contextWindow, `${label}.contextWindow`, 512, 10_000_000, true);
  const maxOutputTokens = finiteNumber(value.maxOutputTokens, `${label}.maxOutputTokens`, 1, contextWindow, true);
  return {
    id: nonEmptyString(value.id, `${label}.id`),
    providerId: nonEmptyString(value.providerId, `${label}.providerId`),
    name: nonEmptyString(value.name, `${label}.name`),
    displayName: nonEmptyString(value.displayName, `${label}.displayName`),
    contextWindow,
    maxOutputTokens,
    inputPricePerMillion: finiteNumber(value.inputPricePerMillion, `${label}.inputPricePerMillion`, 0),
    outputPricePerMillion: finiteNumber(value.outputPricePerMillion, `${label}.outputPricePerMillion`, 0),
    supportsStructuredOutput: booleanValue(value.supportsStructuredOutput, `${label}.supportsStructuredOutput`),
    supportsReasoningEffort: booleanValue(value.supportsReasoningEffort, `${label}.supportsReasoningEffort`),
    supportsCachedTokens: booleanValue(value.supportsCachedTokens, `${label}.supportsCachedTokens`),
    enabled: booleanValue(value.enabled, `${label}.enabled`),
    notes: stringValue(value.notes, `${label}.notes`)
  };
}

function parsePersona(input: unknown, label: string): AIPersona {
  const value = record(input, label);
  const contextLimit = finiteNumber(value.contextLimit, `${label}.contextLimit`, 512, 10_000_000, true);
  return {
    id: nonEmptyString(value.id, `${label}.id`),
    name: nonEmptyString(value.name, `${label}.name`),
    avatar: stringValue(value.avatar, `${label}.avatar`),
    personality: stringValue(value.personality, `${label}.personality`),
    speechStyle: enumValue(value.speechStyle, SPEECH_STYLES, `${label}.speechStyle`) as AIPersona["speechStyle"],
    reasoningStrength: enumValue(value.reasoningStrength, REASONING_STRENGTHS, `${label}.reasoningStrength`) as AIPersona["reasoningStrength"],
    aggression: finiteNumber(value.aggression, `${label}.aggression`, 0, 100),
    conservatism: finiteNumber(value.conservatism, `${label}.conservatism`, 0, 100),
    riskTolerance: finiteNumber(value.riskTolerance, `${label}.riskTolerance`, 0, 100),
    deceptionSkill: finiteNumber(value.deceptionSkill, `${label}.deceptionSkill`, 0, 100),
    bussingTendency: finiteNumber(value.bussingTendency, `${label}.bussingTendency`, 0, 100),
    claimTendency: finiteNumber(value.claimTendency, `${label}.claimTendency`, 0, 100),
    voteIndependence: finiteNumber(value.voteIndependence, `${label}.voteIndependence`, 0, 100),
    speechLength: enumValue(value.speechLength, SPEECH_LENGTHS, `${label}.speechLength`) as AIPersona["speechLength"],
    catchphrase: stringValue(value.catchphrase, `${label}.catchphrase`),
    customPrompt: stringValue(value.customPrompt, `${label}.customPrompt`),
    defaultProviderId: nonEmptyString(value.defaultProviderId, `${label}.defaultProviderId`),
    defaultModel: nonEmptyString(value.defaultModel, `${label}.defaultModel`),
    contextLimit,
    temperature: finiteNumber(value.temperature, `${label}.temperature`, 0, 2),
    topP: finiteNumber(value.topP, `${label}.topP`, 0, 1),
    maxOutputTokens: finiteNumber(value.maxOutputTokens, `${label}.maxOutputTokens`, 1, contextLimit, true),
    reasoningEffort: enumValue(value.reasoningEffort, REASONING_EFFORTS, `${label}.reasoningEffort`) as AIPersona["reasoningEffort"],
    allowRandomSelection: booleanValue(value.allowRandomSelection, `${label}.allowRandomSelection`),
    weight: finiteNumber(value.weight, `${label}.weight`, 0)
  };
}

function normalizeModelConfig(model: ModelConfig): ModelConfig {
  const normalized = { ...model };
  if (normalized.providerId === "deepseek-provider" || normalized.name.startsWith("deepseek-v4-")) {
    if (normalized.id === "model-deepseek-v4-pro") {
      normalized.name = "deepseek-v4-pro";
      normalized.displayName = "DeepSeek V4 Pro";
    }
    if (normalized.name === "deepseek-v4-flash" || normalized.name === "deepseek-v4-pro") {
      normalized.contextWindow = 1_000_000;
      normalized.maxOutputTokens = 384_000;
    }
  }
  return normalized;
}

async function atomicWriteFile(targetPath: string, text: string): Promise<void> {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, targetPath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateBaseUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigValidationError(`${label} 必须是合法 URL。`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "mock:") {
    throw new ConfigValidationError(`${label} 只允许 http、https 或 mock 协议。`);
  }
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new ConfigValidationError(`${label} 重复：${value.replace("\u0000", "/")}。`);
    seen.add(value);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigValidationError(`${label} 必须是对象。`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ConfigValidationError(`${label} 必须是数组。`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ConfigValidationError(`${label} 必须是字符串。`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  const text = stringValue(value, label).trim();
  if (!text) throw new ConfigValidationError(`${label} 不能为空。`);
  return text;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ConfigValidationError(`${label} 必须是布尔值。`);
  return value;
}

function enumValue(value: unknown, allowed: Set<string>, label: string): string {
  if (typeof value !== "string" || !allowed.has(value)) throw new ConfigValidationError(`${label} 取值非法。`);
  return value;
}

function finiteNumber(value: unknown, label: string, min: number, max = Number.MAX_VALUE, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ConfigValidationError(`${label} 必须是${integer ? "整数" : "有限数值"}，范围 ${min}..${max}。`);
  }
  return value;
}

function hasStoredProviderSecrets(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const providers = (value as Record<string, unknown>).providers;
  return Array.isArray(providers) && providers.some((provider) => {
    return typeof provider === "object" && provider !== null && !Array.isArray(provider) && Boolean((provider as Record<string, unknown>).apiKeyEncrypted);
  });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
