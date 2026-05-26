import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_CONFIG, ProviderAccount } from "@langrensha/shared";
import { createProviderAdapter } from "../src/index";

describe("LLM gateway", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Anthropic's x-api-key header instead of bearer auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            content: [{ text: "{\"ok\":true}" }],
            usage: { input_tokens: 12, output_tokens: 4 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    const provider: ProviderAccount = {
      ...DEFAULT_AI_CONFIG.providers[0],
      id: "anthropic-provider",
      name: "Anthropic",
      type: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-test"
    };

    const adapter = createProviderAdapter(provider);
    const response = await adapter.generateText({
      provider,
      model: "claude-test",
      prompt: "Return JSON.",
      apiKey: "test-secret",
      maxOutputTokens: 64
    });

    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers["x-api-key"]).toBe("test-secret");
    expect(headers.Authorization).toBeUndefined();
    expect(response.text).toBe("{\"ok\":true}");
  });

  it("passes sampling and reasoning options to OpenAI-compatible chat requests", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 10, completion_tokens: 3 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    const provider: ProviderAccount = {
      ...DEFAULT_AI_CONFIG.providers[0],
      id: "compatible-provider",
      name: "Compatible",
      type: "openai_compatible",
      baseUrl: "https://example.test/v1",
      defaultModel: "compatible-model",
      supportsReasoningEffort: true
    };

    const adapter = createProviderAdapter(provider);
    await adapter.generateText({
      provider,
      model: "compatible-model",
      prompt: "Return text.",
      apiKey: "test-secret",
      temperature: 0.2,
      topP: 0.7,
      reasoningEffort: "high",
      maxOutputTokens: 128
    });

    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(calls[0].url).toBe("https://example.test/v1/chat/completions");
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.7);
    expect(body.reasoning_effort).toBe("high");
    expect(body.max_tokens).toBe(128);
  });

  it("sends JSON schema response_format for OpenAI-compatible object requests when enabled", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "{\"vote_target\":\"abstain\",\"private_reason\":\"测试结构化输出请求体。\",\"confidence\":0.5}" } }],
            usage: { prompt_tokens: 10, completion_tokens: 3 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    const provider: ProviderAccount = {
      ...DEFAULT_AI_CONFIG.providers[0],
      id: "compatible-provider",
      name: "Compatible",
      type: "openai_compatible",
      baseUrl: "https://example.test/v1",
      defaultModel: "compatible-model",
      supportsJsonSchema: true
    };

    const adapter = createProviderAdapter(provider);
    await adapter.generateObject({
      provider,
      model: "compatible-model",
      prompt: "Return vote JSON.",
      apiKey: "test-secret",
      schema: {
        type: "object",
        required: ["vote_target", "private_reason", "confidence"],
        properties: {
          vote_target: { type: "string" },
          private_reason: { type: "string" },
          confidence: { type: "number" }
        }
      }
    });

    const body = JSON.parse(String(calls[0].init.body)) as { response_format?: { type?: string; json_schema?: { name?: string; schema?: unknown } } };
    expect(calls[0].url).toBe("https://example.test/v1/chat/completions");
    expect(body.response_format?.type).toBe("json_schema");
    expect(body.response_format?.json_schema?.name).toBe("werewolf_action");
    expect(body.response_format?.json_schema?.schema).toMatchObject({ type: "object" });
  });

  it("uses xAI as an OpenAI-compatible API endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    const provider: ProviderAccount = {
      ...DEFAULT_AI_CONFIG.providers[0],
      id: "xai-provider",
      name: "xAI",
      type: "xai",
      baseUrl: "",
      defaultModel: "grok-test"
    };

    const adapter = createProviderAdapter(provider);
    await adapter.generateText({
      provider,
      model: "grok-test",
      prompt: "Return text.",
      apiKey: "test-secret"
    });

    expect(calls[0].url).toBe("https://api.x.ai/v1/chat/completions");
  });
});
