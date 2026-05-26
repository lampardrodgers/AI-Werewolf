import { describe, expect, it } from "vitest";
import { AIConfigStore, DEFAULT_AI_CONFIG, buildAIReadiness, createPromptHash } from "../src";

describe("AI readiness", () => {
  it("reports default mock-only config as not ready for real AI", () => {
    const readiness = buildAIReadiness(cloneConfig(DEFAULT_AI_CONFIG));

    expect(readiness.ready).toBe(false);
    expect(item(readiness, "启用真实供应商").ok).toBe(false);
    expect(item(readiness, "密钥或令牌已保存").ok).toBe(false);
    expect(item(readiness, "随机角色卡指向真实供应商").ok).toBe(false);
    expect(item(readiness, "成本保护").ok).toBe(true);
  });

  it("reports a complete real provider, model, and persona setup as ready", () => {
    const config = withRealProvider();

    const readiness = buildAIReadiness(config);

    expect(readiness.ready).toBe(true);
    expect(readiness.items.every((entry) => entry.ok)).toBe(true);
  });

  it("allows OpenAI-compatible providers that rely on prompt-constrained JSON output", () => {
    const config = withRealProvider();
    config.providers = config.providers.map((provider) =>
      provider.id === "real-provider" ? { ...provider, supportsJsonSchema: false } : provider
    );
    config.models = config.models.map((model) =>
      model.providerId === "real-provider" ? { ...model, supportsStructuredOutput: false } : model
    );

    const readiness = buildAIReadiness(config);

    expect(readiness.ready).toBe(true);
    expect(item(readiness, "结构化输出策略")).toMatchObject({
      ok: true,
      detail: expect.stringContaining("prompt")
    });
  });

  it("requires enabled model records for real persona models", () => {
    const config = withRealProvider();
    config.models = config.models.filter((model) => model.providerId !== "real-provider");

    const readiness = buildAIReadiness(config);

    expect(readiness.ready).toBe(false);
    expect(item(readiness, "模型管理记录")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("缺少")
    });
  });

  it("creates stable prompt hashes without exposing prompt text", () => {
    expect(createPromptHash("same prompt")).toBe(createPromptHash("same prompt"));
    expect(createPromptHash("same prompt")).not.toBe(createPromptHash("different prompt"));
    expect(createPromptHash("secret prompt body")).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
  });
});

function cloneConfig(config: AIConfigStore): AIConfigStore {
  return JSON.parse(JSON.stringify(config)) as AIConfigStore;
}

function withRealProvider(): AIConfigStore {
  const config = cloneConfig(DEFAULT_AI_CONFIG);
  config.providers.push({
    id: "real-provider",
    name: "Real Provider",
    type: "openai_compatible",
    baseUrl: "https://example.com/v1",
    apiKeyEncrypted: "__stored__",
    authType: "api_key",
    enabled: true,
    rateLimit: { rpm: 60, tpm: 120000, concurrency: 3 },
    timeoutMs: 30000,
    retryCount: 1,
    defaultModel: "real-model",
    supportsJsonSchema: true,
    supportsToolCall: false,
    supportsStreaming: false,
    supportsReasoningEffort: false,
    supportsModelList: true
  });
  config.models.push({
    id: "model-real",
    providerId: "real-provider",
    name: "real-model",
    displayName: "Real Model",
    contextWindow: 128000,
    maxOutputTokens: 1200,
    inputPricePerMillion: 1,
    outputPricePerMillion: 2,
    supportsStructuredOutput: true,
    supportsReasoningEffort: false,
    supportsCachedTokens: false,
    enabled: true,
    notes: ""
  });
  config.personas = config.personas.map((persona) => ({
    ...persona,
    defaultProviderId: "real-provider",
    defaultModel: "real-model"
  }));
  return config;
}

function item(readiness: ReturnType<typeof buildAIReadiness>, label: string) {
  const found = readiness.items.find((entry) => entry.label === label);
  if (!found) throw new Error(`missing readiness item: ${label}`);
  return found;
}
