import { ProviderAccount } from "@langrensha/shared";

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
}

export interface LLMTextRequest {
  provider: ProviderAccount;
  model: string;
  prompt: string;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  apiKey?: string;
  timeoutMs?: number;
}

export interface LLMTextResponse {
  text: string;
  raw: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedTokens?: number;
  };
  latencyMs: number;
}

export interface LLMObjectRequest<TSchema = unknown> extends LLMTextRequest {
  schema: TSchema;
}

export interface LLMObjectResponse<TObject = unknown> extends LLMTextResponse {
  object: TObject;
}

export interface LLMProviderAdapter {
  listModels(provider: ProviderAccount, apiKey?: string): Promise<ModelInfo[]>;
  generateText(req: LLMTextRequest): Promise<LLMTextResponse>;
  generateObject<TObject = unknown>(req: LLMObjectRequest): Promise<LLMObjectResponse<TObject>>;
}

export function createProviderAdapter(provider: ProviderAccount): LLMProviderAdapter {
  if (provider.baseUrl.startsWith("mock://")) return new MockAdapter();
  if (provider.type === "anthropic") return new AnthropicAdapter();
  if (provider.type === "gemini") return new GeminiAdapter();
  if (provider.type === "openai") return new OpenAIResponsesAdapter();
  return new OpenAICompatibleAdapter(provider.type === "xai" ? "https://api.x.ai/v1" : provider.baseUrl);
}

class MockAdapter implements LLMProviderAdapter {
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "deterministic-mock", name: "Deterministic Mock", contextWindow: 32000 }];
  }

  async generateText(req: LLMTextRequest): Promise<LLMTextResponse> {
    return {
      text: "Mock response",
      raw: { provider: req.provider.name, model: req.model },
      usage: { inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: 4 },
      latencyMs: 1
    };
  }

  async generateObject<TObject>(req: LLMObjectRequest): Promise<LLMObjectResponse<TObject>> {
    const object = { ok: true, mock: true, model: req.model } as TObject;
    return {
      text: JSON.stringify(object),
      object,
      raw: object,
      usage: { inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: 16 },
      latencyMs: 1
    };
  }
}

class OpenAIResponsesAdapter implements LLMProviderAdapter {
  async listModels(provider: ProviderAccount, apiKey?: string): Promise<ModelInfo[]> {
    const started = Date.now();
    const response = await fetchWithTimeout(`${provider.baseUrl || "https://api.openai.com/v1"}/models`, {
      headers: authHeaders(apiKey)
    }, provider.timeoutMs);
    const data = (await response.json()) as { data?: Array<{ id: string }> };
    void started;
    return (data.data ?? []).map((model) => ({ id: model.id, name: model.id }));
  }

  async generateText(req: LLMTextRequest): Promise<LLMTextResponse> {
    const started = Date.now();
    const response = await fetchWithTimeout(`${req.provider.baseUrl || "https://api.openai.com/v1"}/responses`, {
      method: "POST",
      headers: { ...authHeaders(req.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        input: req.prompt,
        temperature: req.temperature,
        top_p: req.topP,
        max_output_tokens: req.maxOutputTokens,
        reasoning: req.reasoningEffort ? { effort: req.reasoningEffort } : undefined
      })
    }, req.timeoutMs ?? req.provider.timeoutMs);
    const raw = (await response.json()) as OpenAIResponsePayload;
    return {
      text: extractOpenAIText(raw),
      raw,
      usage: {
        inputTokens: raw.usage?.input_tokens ?? 0,
        outputTokens: raw.usage?.output_tokens ?? 0,
        reasoningTokens: raw.usage?.output_tokens_details?.reasoning_tokens ?? 0,
        cachedTokens: raw.usage?.input_tokens_details?.cached_tokens ?? 0
      },
      latencyMs: Date.now() - started
    };
  }

  async generateObject<TObject>(req: LLMObjectRequest): Promise<LLMObjectResponse<TObject>> {
    const started = Date.now();
    const response = await fetchWithTimeout(`${req.provider.baseUrl || "https://api.openai.com/v1"}/responses`, {
      method: "POST",
      headers: { ...authHeaders(req.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        input: req.prompt,
        temperature: req.temperature,
        top_p: req.topP,
        max_output_tokens: req.maxOutputTokens,
        reasoning: req.reasoningEffort ? { effort: req.reasoningEffort } : undefined,
        text: req.provider.supportsJsonSchema ? { format: jsonSchemaTextFormat(req.schema) } : undefined
      })
    }, req.timeoutMs ?? req.provider.timeoutMs);
    const raw = (await response.json()) as OpenAIResponsePayload;
    const text = extractOpenAIText(raw);
    return {
      text,
      object: parseJsonObject<TObject>(text),
      raw,
      usage: {
        inputTokens: raw.usage?.input_tokens ?? 0,
        outputTokens: raw.usage?.output_tokens ?? 0,
        reasoningTokens: raw.usage?.output_tokens_details?.reasoning_tokens ?? 0,
        cachedTokens: raw.usage?.input_tokens_details?.cached_tokens ?? 0
      },
      latencyMs: Date.now() - started
    };
  }
}

class OpenAICompatibleAdapter implements LLMProviderAdapter {
  constructor(private readonly defaultBaseUrl: string) {}

  async listModels(provider: ProviderAccount, apiKey?: string): Promise<ModelInfo[]> {
    const response = await fetchWithTimeout(`${provider.baseUrl || this.defaultBaseUrl}/models`, {
      headers: authHeaders(apiKey)
    }, provider.timeoutMs);
    const data = (await response.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((model) => ({ id: model.id, name: model.id }));
  }

  async generateText(req: LLMTextRequest): Promise<LLMTextResponse> {
    const started = Date.now();
    const response = await fetchWithTimeout(`${req.provider.baseUrl || this.defaultBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...authHeaders(req.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: "user", content: req.prompt }],
        temperature: req.temperature,
        top_p: req.topP,
        max_tokens: req.maxOutputTokens,
        reasoning_effort: req.reasoningEffort
      })
    }, req.timeoutMs ?? req.provider.timeoutMs);
    const raw = (await response.json()) as ChatCompletionPayload;
    return {
      text: raw.choices?.[0]?.message?.content ?? "",
      raw,
      usage: {
        inputTokens: raw.usage?.prompt_tokens ?? 0,
        outputTokens: raw.usage?.completion_tokens ?? 0
      },
      latencyMs: Date.now() - started
    };
  }

  async generateObject<TObject>(req: LLMObjectRequest): Promise<LLMObjectResponse<TObject>> {
    const started = Date.now();
    const response = await fetchWithTimeout(`${req.provider.baseUrl || this.defaultBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...authHeaders(req.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: "user", content: `${req.prompt}\n\n只输出 JSON，Schema: ${JSON.stringify(req.schema)}` }],
        temperature: req.temperature,
        top_p: req.topP,
        max_tokens: req.maxOutputTokens,
        reasoning_effort: req.reasoningEffort,
        response_format: req.provider.supportsJsonSchema ? jsonSchemaResponseFormat(req.schema) : undefined
      })
    }, req.timeoutMs ?? req.provider.timeoutMs);
    const raw = (await response.json()) as ChatCompletionPayload;
    const text = raw.choices?.[0]?.message?.content ?? "";
    return {
      text,
      object: parseJsonObject<TObject>(text),
      raw,
      usage: {
        inputTokens: raw.usage?.prompt_tokens ?? 0,
        outputTokens: raw.usage?.completion_tokens ?? 0
      },
      latencyMs: Date.now() - started
    };
  }
}

class AnthropicAdapter implements LLMProviderAdapter {
  async listModels(provider: ProviderAccount, apiKey?: string): Promise<ModelInfo[]> {
    const response = await fetchWithTimeout(`${provider.baseUrl || "https://api.anthropic.com/v1"}/models`, {
      headers: { ...anthropicAuthHeaders(apiKey), "anthropic-version": "2023-06-01" }
    }, provider.timeoutMs);
    const data = (await response.json()) as { data?: Array<{ id: string; display_name?: string }> };
    return (data.data ?? []).map((model) => ({ id: model.id, name: model.display_name ?? model.id }));
  }

  async generateText(req: LLMTextRequest): Promise<LLMTextResponse> {
    const started = Date.now();
    const response = await fetchWithTimeout(`${req.provider.baseUrl || "https://api.anthropic.com/v1"}/messages`, {
      method: "POST",
      headers: { ...anthropicAuthHeaders(req.apiKey), "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxOutputTokens ?? 800,
        temperature: req.temperature,
        top_p: req.topP,
        messages: [{ role: "user", content: req.prompt }]
      })
    }, req.timeoutMs ?? req.provider.timeoutMs);
    const raw = (await response.json()) as AnthropicPayload;
    return {
      text: raw.content?.map((item) => item.text ?? "").join("") ?? "",
      raw,
      usage: {
        inputTokens: raw.usage?.input_tokens ?? 0,
        outputTokens: raw.usage?.output_tokens ?? 0
      },
      latencyMs: Date.now() - started
    };
  }

  async generateObject<TObject>(req: LLMObjectRequest): Promise<LLMObjectResponse<TObject>> {
    const response = await this.generateText({ ...req, prompt: `${req.prompt}\n\n只输出 JSON，Schema: ${JSON.stringify(req.schema)}` });
    return { ...response, object: parseJsonObject<TObject>(response.text) };
  }
}

class GeminiAdapter implements LLMProviderAdapter {
  async listModels(provider: ProviderAccount, apiKey?: string): Promise<ModelInfo[]> {
    const key = apiKey ? `?key=${encodeURIComponent(apiKey)}` : "";
    const response = await fetchWithTimeout(`${provider.baseUrl || "https://generativelanguage.googleapis.com/v1beta"}/models${key}`, {}, provider.timeoutMs);
    const data = (await response.json()) as { models?: Array<{ name: string; displayName?: string }> };
    return (data.models ?? []).map((model) => ({ id: model.name.replace(/^models\//, ""), name: model.displayName ?? model.name }));
  }

  async generateText(req: LLMTextRequest): Promise<LLMTextResponse> {
    const started = Date.now();
    const key = req.apiKey ? `?key=${encodeURIComponent(req.apiKey)}` : "";
    const response = await fetchWithTimeout(`${req.provider.baseUrl || "https://generativelanguage.googleapis.com/v1beta"}/models/${req.model}:generateContent${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: req.prompt }] }],
        generationConfig: {
          temperature: req.temperature,
          topP: req.topP,
          maxOutputTokens: req.maxOutputTokens
        }
      })
    }, req.timeoutMs ?? req.provider.timeoutMs);
    const raw = (await response.json()) as GeminiPayload;
    return {
      text: raw.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "",
      raw,
      usage: {
        inputTokens: raw.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: raw.usageMetadata?.candidatesTokenCount ?? 0
      },
      latencyMs: Date.now() - started
    };
  }

  async generateObject<TObject>(req: LLMObjectRequest): Promise<LLMObjectResponse<TObject>> {
    const started = Date.now();
    const key = req.apiKey ? `?key=${encodeURIComponent(req.apiKey)}` : "";
    const response = await fetchWithTimeout(`${req.provider.baseUrl || "https://generativelanguage.googleapis.com/v1beta"}/models/${req.model}:generateContent${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: req.prompt }] }],
        generationConfig: {
          temperature: req.temperature,
          topP: req.topP,
          maxOutputTokens: req.maxOutputTokens,
          responseMimeType: req.provider.supportsJsonSchema ? "application/json" : undefined,
          responseSchema: req.provider.supportsJsonSchema ? req.schema : undefined
        }
      })
    }, req.timeoutMs ?? req.provider.timeoutMs);
    const raw = (await response.json()) as GeminiPayload;
    const text = raw.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    return {
      text,
      object: parseJsonObject<TObject>(text),
      raw,
      usage: {
        inputTokens: raw.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: raw.usageMetadata?.candidatesTokenCount ?? 0
      },
      latencyMs: Date.now() - started
    };
  }
}

interface OpenAIResponsePayload {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

interface ChatCompletionPayload {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface AnthropicPayload {
  content?: Array<{ text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface GeminiPayload {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function extractOpenAIText(raw: OpenAIResponsePayload): string {
  if (raw.output_text) return raw.output_text;
  return raw.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("") ?? "";
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function anthropicAuthHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { "x-api-key": apiKey } : {};
}

function jsonSchemaResponseFormat(schema: unknown): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "werewolf_action",
      strict: false,
      schema
    }
  };
}

function jsonSchemaTextFormat(schema: unknown): Record<string, unknown> {
  return {
    type: "json_schema",
    name: "werewolf_action",
    strict: false,
    schema
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${response.statusText}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonObject<TObject>(text: string): TObject {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(unfenced) as TObject;
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(unfenced.slice(start, end + 1)) as TObject;
    }
    throw new Error("LLM response did not contain a valid JSON object");
  }
}
