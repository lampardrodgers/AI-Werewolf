import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_CONFIG, ProviderAccount } from "@langrensha/shared";
import { LLMObjectParseError, createProviderAdapter } from "../src/index";

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

  it("uses JSON object response_format for DeepSeek object requests with enabled default thinking", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "{\"ok\":true}" } }],
            usage: { prompt_tokens: 10, completion_tokens: 3 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    const provider: ProviderAccount = {
      ...DEFAULT_AI_CONFIG.providers[0],
      id: "deepseek-provider",
      name: "DeepSeek",
      type: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-flash",
      supportsJsonSchema: false,
      supportsReasoningEffort: false,
      thinkingMode: undefined
    };

    const adapter = createProviderAdapter(provider);
    await adapter.generateObject({
      provider,
      model: "deepseek-v4-flash",
      prompt: "Return JSON.",
      apiKey: "test-secret",
      reasoningEffort: "high",
      schema: { type: "object", properties: { ok: { type: "boolean" } } }
    });

    const body = JSON.parse(String(calls[0].init.body)) as {
      messages?: Array<{ content?: string }>;
      response_format?: { type?: string; json_schema?: unknown };
      thinking?: { type?: string };
      reasoning_effort?: string;
    };
    expect(calls[0].url).toBe("https://api.deepseek.com/chat/completions");
    expect(body.response_format?.type).toBe("json_object");
    expect(body.response_format?.json_schema).toBeUndefined();
    expect(body.thinking?.type).toBe("enabled");
    expect(body.reasoning_effort).toBe("high");
    expect(body.messages?.[0]?.content).toContain("Return JSON.");
    expect(body.messages?.[0]?.content).toContain("JSON/json");
    expect(body.messages?.[0]?.content).toContain("Schema:");
  });

  it("uses official DeepSeek thinking disabled mode for text repair requests", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "{\"ok\":true}" } }],
            usage: { prompt_tokens: 10, completion_tokens: 3 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    const provider: ProviderAccount = {
      ...DEFAULT_AI_CONFIG.providers[0],
      id: "deepseek-provider",
      name: "DeepSeek",
      type: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-pro",
      supportsJsonSchema: false,
      supportsReasoningEffort: false,
      thinkingMode: "disabled"
    };

    const adapter = createProviderAdapter(provider);
    await adapter.generateText({
      provider,
      model: "deepseek-v4-pro",
      prompt: "Return JSON.",
      apiKey: "test-secret",
      reasoningEffort: "high"
    });

    const body = JSON.parse(String(calls[0].init.body)) as { thinking?: { type?: string }; reasoning_effort?: string };
    expect(body.thinking?.type).toBe("disabled");
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("passes reasoning effort to DeepSeek when thinking mode is auto", async () => {
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
      id: "deepseek-provider",
      name: "DeepSeek",
      type: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-flash",
      supportsReasoningEffort: true,
      thinkingMode: "auto"
    };

    const adapter = createProviderAdapter(provider);
    await adapter.generateText({
      provider,
      model: "deepseek-v4-flash",
      prompt: "Return text.",
      apiKey: "test-secret",
      reasoningEffort: "low"
    });

    const body = JSON.parse(String(calls[0].init.body)) as { thinking?: { type?: string }; reasoning_effort?: string };
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBe("high");
  });

  it("passes max reasoning effort to DeepSeek when thinking mode is enabled", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 3,
              prompt_cache_hit_tokens: 4,
              completion_tokens_details: { reasoning_tokens: 2 }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    const provider: ProviderAccount = {
      ...DEFAULT_AI_CONFIG.providers[0],
      id: "deepseek-provider",
      name: "DeepSeek",
      type: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-pro",
      supportsReasoningEffort: false,
      thinkingMode: "enabled"
    };

    const adapter = createProviderAdapter(provider);
    const response = await adapter.generateText({
      provider,
      model: "deepseek-v4-pro",
      prompt: "Return text.",
      apiKey: "test-secret",
      reasoningEffort: "max"
    });

    const body = JSON.parse(String(calls[0].init.body)) as { thinking?: { type?: string }; reasoning_effort?: string };
    expect(body.thinking?.type).toBe("enabled");
    expect(body.reasoning_effort).toBe("max");
    expect(response.usage.reasoningTokens).toBe(2);
    expect(response.usage.cachedTokens).toBe(4);
  });

  it("includes provider error body when chat completions fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "Unrecognized request argument supplied: thinking" } }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json" }
        })
      )
    );
    const provider: ProviderAccount = {
      ...DEFAULT_AI_CONFIG.providers[0],
      id: "compatible-provider",
      name: "Compatible",
      type: "openai_compatible",
      baseUrl: "https://example.test/v1",
      defaultModel: "compatible-model"
    };

    const adapter = createProviderAdapter(provider);
    await expect(
      adapter.generateText({
        provider,
        model: "compatible-model",
        prompt: "Return text.",
        apiKey: "test-secret"
      })
    ).rejects.toThrow("Unrecognized request argument supplied: thinking");
  });

  it("parses JSON from reasoning content when chat content is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "", reasoning_content: "先思考，最后输出 {\"ok\":true,\"message\":\"done\"}" } }],
            usage: { prompt_tokens: 10, completion_tokens: 12 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const provider: ProviderAccount = {
      ...DEFAULT_AI_CONFIG.providers[0],
      id: "compatible-provider",
      name: "Compatible",
      type: "openai_compatible",
      baseUrl: "https://example.test/v1",
      defaultModel: "compatible-model"
    };

    const adapter = createProviderAdapter(provider);
    const response = await adapter.generateObject<{ ok: boolean; message: string }>({
      provider,
      model: "compatible-model",
      prompt: "Return JSON.",
      schema: { type: "object", properties: { ok: { type: "boolean" }, message: { type: "string" } } }
    });

    expect(response.object).toEqual({ ok: true, message: "done" });
  });

  it("extracts the first parseable JSON object from noisy model text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "前置说明 {not json} {\"ok\":true,\"message\":\"done\"} 后置 {ignored}" } }],
            usage: { prompt_tokens: 10, completion_tokens: 3 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const provider: ProviderAccount = {
      ...DEFAULT_AI_CONFIG.providers[0],
      id: "compatible-provider",
      name: "Compatible",
      type: "openai_compatible",
      baseUrl: "https://example.test/v1",
      defaultModel: "compatible-model"
    };

    const adapter = createProviderAdapter(provider);
    const response = await adapter.generateObject<{ ok: boolean; message: string }>({
      provider,
      model: "compatible-model",
      prompt: "Return JSON.",
      schema: { type: "object", properties: { ok: { type: "boolean" }, message: { type: "string" } } }
    });

    expect(response.object).toEqual({ ok: true, message: "done" });
  });

  it("escapes raw line breaks inside JSON strings before parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "{\"ok\":true,\"text\":\"第一行\n第二行\"}" } }],
            usage: { prompt_tokens: 10, completion_tokens: 3 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const provider: ProviderAccount = {
      ...DEFAULT_AI_CONFIG.providers[0],
      id: "compatible-provider",
      name: "Compatible",
      type: "openai_compatible",
      baseUrl: "https://example.test/v1",
      defaultModel: "compatible-model"
    };

    const adapter = createProviderAdapter(provider);
    const response = await adapter.generateObject<{ ok: boolean; text: string }>({
      provider,
      model: "compatible-model",
      prompt: "Return JSON.",
      schema: { type: "object", properties: { ok: { type: "boolean" }, text: { type: "string" } } }
    });

    expect(response.object).toEqual({ ok: true, text: "第一行\n第二行" });
  });

  it("keeps raw model text on object parse errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "我先按警上发言和票型看，暂时不急着归死票。" } }],
            usage: { prompt_tokens: 10, completion_tokens: 12 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const provider: ProviderAccount = {
      ...DEFAULT_AI_CONFIG.providers[0],
      id: "compatible-provider",
      name: "Compatible",
      type: "openai_compatible",
      baseUrl: "https://example.test/v1",
      defaultModel: "compatible-model"
    };

    const adapter = createProviderAdapter(provider);

    await expect(
      adapter.generateObject({
        provider,
        model: "compatible-model",
        prompt: "Return JSON.",
        schema: { type: "object", properties: { ok: { type: "boolean" } } }
      })
    ).rejects.toMatchObject({
      name: "LLMObjectParseError",
      response: {
        text: "我先按警上发言和票型看，暂时不急着归死票。",
        usage: { inputTokens: 10, outputTokens: 12 }
      }
    });

    try {
      await adapter.generateObject({
        provider,
        model: "compatible-model",
        prompt: "Return JSON.",
        schema: { type: "object", properties: { ok: { type: "boolean" } } }
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LLMObjectParseError);
    }
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
