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
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "max";
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
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

export class LLMObjectParseError extends Error {
  constructor(
    message: string,
    public readonly response: LLMTextResponse
  ) {
    super(message);
    this.name = "LLMObjectParseError";
  }
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
        reasoning: requestReasoningEffort(req) ? { effort: requestReasoningEffort(req) } : undefined
      })
    }, req.timeoutMs ?? req.provider.timeoutMs, req.signal);
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
        reasoning: requestReasoningEffort(req) ? { effort: requestReasoningEffort(req) } : undefined,
        text: req.provider.supportsJsonSchema ? { format: jsonSchemaTextFormat(req.schema) } : undefined
      })
    }, req.timeoutMs ?? req.provider.timeoutMs, req.signal);
    const raw = (await response.json()) as OpenAIResponsePayload;
    const text = extractOpenAIText(raw);
    return parseObjectResponse<TObject>({
      text,
      raw,
      usage: {
        inputTokens: raw.usage?.input_tokens ?? 0,
        outputTokens: raw.usage?.output_tokens ?? 0,
        reasoningTokens: raw.usage?.output_tokens_details?.reasoning_tokens ?? 0,
        cachedTokens: raw.usage?.input_tokens_details?.cached_tokens ?? 0
      },
      latencyMs: Date.now() - started
    });
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
    const thinking = deepSeekThinkingOption(req.provider);
    const reasoningEffort = requestReasoningEffort(req);
    const response = await fetchWithTimeout(`${req.provider.baseUrl || this.defaultBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...authHeaders(req.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: "user", content: req.prompt }],
        temperature: req.temperature,
        top_p: req.topP,
        max_tokens: req.maxOutputTokens,
        reasoning_effort: thinking?.type === "disabled" ? undefined : reasoningEffort,
        thinking
      })
    }, req.timeoutMs ?? req.provider.timeoutMs, req.signal);
    const raw = (await response.json()) as ChatCompletionPayload;
    return {
      text: extractChatCompletionText(raw, { allowReasoningJson: true }),
      raw,
      usage: chatCompletionUsage(raw),
      latencyMs: Date.now() - started
    };
  }

  async generateObject<TObject>(req: LLMObjectRequest): Promise<LLMObjectResponse<TObject>> {
    const started = Date.now();
    const responseFormat = responseFormatForObjectRequest(req.provider, req.schema);
    const thinking = deepSeekThinkingOption(req.provider);
    const reasoningEffort = requestReasoningEffort(req);
    const response = await fetchWithTimeout(`${req.provider.baseUrl || this.defaultBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...authHeaders(req.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: "user", content: `${req.prompt}\n\n只输出 JSON/json，Schema: ${JSON.stringify(req.schema)}` }],
        temperature: req.temperature,
        top_p: req.topP,
        max_tokens: req.maxOutputTokens,
        reasoning_effort: thinking?.type === "disabled" ? undefined : reasoningEffort,
        thinking,
        response_format: responseFormat
      })
    }, req.timeoutMs ?? req.provider.timeoutMs, req.signal);
    const raw = (await response.json()) as ChatCompletionPayload;
    const text = extractChatCompletionText(raw, { allowReasoningJson: true });
    return parseObjectResponse<TObject>({
      text,
      raw,
      usage: chatCompletionUsage(raw),
      latencyMs: Date.now() - started
    });
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
    }, req.timeoutMs ?? req.provider.timeoutMs, req.signal);
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
    return parseObjectResponse<TObject>(response);
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
    }, req.timeoutMs ?? req.provider.timeoutMs, req.signal);
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
    }, req.timeoutMs ?? req.provider.timeoutMs, req.signal);
    const raw = (await response.json()) as GeminiPayload;
    const text = raw.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    return parseObjectResponse<TObject>({
      text,
      raw,
      usage: {
        inputTokens: raw.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: raw.usageMetadata?.candidatesTokenCount ?? 0
      },
      latencyMs: Date.now() - started
    });
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
  choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
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

function extractChatCompletionText(raw: ChatCompletionPayload, options: { allowReasoningJson?: boolean } = {}): string {
  const message = raw.choices?.[0]?.message;
  const content = message?.content?.trim();
  if (content) return content;
  if (!options.allowReasoningJson) return "";
  const reasoning = message?.reasoning_content?.trim();
  if (!reasoning) return "";
  return firstParseableJsonObjectText(reasoning) ?? "";
}

function firstParseableJsonObjectText(text: string): string | undefined {
  for (const candidate of extractJsonObjectCandidates(stripMarkdownFence(text))) {
    if (tryParseJson(candidate).ok) return candidate;
    const escaped = escapeControlCharsInJsonStrings(candidate);
    if (tryParseJson(escaped).ok) return escaped;
  }
  return undefined;
}

function chatCompletionUsage(raw: ChatCompletionPayload): LLMTextResponse["usage"] {
  return {
    inputTokens: raw.usage?.prompt_tokens ?? 0,
    outputTokens: raw.usage?.completion_tokens ?? 0,
    reasoningTokens: raw.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: raw.usage?.prompt_cache_hit_tokens ?? 0
  };
}

function deepSeekThinkingOption(provider: ProviderAccount): { type: "enabled" | "disabled" } | undefined {
  if (!isDeepSeekProvider(provider)) return undefined;
  const mode = provider.thinkingMode ?? "enabled";
  if (mode === "enabled") return { type: "enabled" };
  if (mode === "disabled") return { type: "disabled" };
  return undefined;
}

function requestReasoningEffort(req: LLMTextRequest): "minimal" | "low" | "medium" | "high" | "max" | undefined {
  if (isDeepSeekProvider(req.provider)) {
    if ((req.provider.thinkingMode ?? "enabled") === "disabled") return undefined;
    return req.reasoningEffort === "max" ? "max" : req.reasoningEffort ? "high" : undefined;
  }
  if (!req.provider.supportsReasoningEffort) return undefined;
  return req.reasoningEffort === "max" ? "high" : req.reasoningEffort;
}

function isDeepSeekProvider(provider: ProviderAccount): boolean {
  return provider.baseUrl.includes("api.deepseek.com");
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

function responseFormatForObjectRequest(provider: ProviderAccount, schema: unknown): Record<string, unknown> | undefined {
  if (provider.supportsJsonSchema) return jsonSchemaResponseFormat(schema);
  if (provider.baseUrl.includes("api.deepseek.com")) return { type: "json_object" };
  return undefined;
}

function jsonSchemaTextFormat(schema: unknown): Record<string, unknown> {
  return {
    type: "json_schema",
    name: "werewolf_action",
    strict: false,
    schema
  };
}

export function parseObjectResponse<TObject>(response: LLMTextResponse): LLMObjectResponse<TObject> {
  try {
    return { ...response, object: parseJsonObject<TObject>(response.text) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LLMObjectParseError(message, response);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number, externalSignal?: AbortSignal): Promise<Response> {
  const signal = externalSignal ?? init.signal ?? undefined;
  if (!timeoutMs || timeoutMs <= 0) {
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) {
      throw new Error(await formatHttpError(response));
    }
    return response;
  }
  const controller = new AbortController();
  const abortFromExternalSignal = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(await formatHttpError(response));
    }
    return response;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromExternalSignal);
  }
}

async function formatHttpError(response: Response): Promise<string> {
  let detail = "";
  try {
    detail = (await response.text()).trim();
  } catch {
    detail = "";
  }
  const suffix = detail ? `: ${previewErrorBody(detail)}` : "";
  return `LLM request failed: ${response.status} ${response.statusText}${suffix}`;
}

function previewErrorBody(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 500);
}

function parseJsonObject<TObject>(text: string): TObject {
  const trimmed = text.trim();
  const unfenced = stripMarkdownFence(trimmed);
  const direct = tryParseJson<TObject>(unfenced);
  if (direct.ok) return direct.value;

  for (const candidate of extractJsonObjectCandidates(unfenced)) {
    const parsed = tryParseJson<TObject>(candidate);
    if (parsed.ok) return parsed.value;
    const escaped = tryParseJson<TObject>(escapeControlCharsInJsonStrings(candidate));
    if (escaped.ok) return escaped.value;
  }

  throw new Error(`LLM response did not contain a valid JSON object: ${previewInvalidJsonText(text)}`);
}

function previewInvalidJsonText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 180) : "<empty>";
}

function stripMarkdownFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced?.[1] ?? text).trim();
}

function tryParseJson<TObject>(text: string): { ok: true; value: TObject } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as TObject };
  } catch {
    return { ok: false };
  }
}

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function escapeControlCharsInJsonStrings(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!inString) {
      result += char;
      if (char === "\"") inString = true;
      continue;
    }

    if (escaped) {
      result += char;
      escaped = false;
    } else if (char === "\\") {
      result += char;
      escaped = true;
    } else if (char === "\"") {
      result += char;
      inString = false;
    } else if (char === "\r") {
      if (text[index + 1] === "\n") index += 1;
      result += "\\n";
    } else if (char === "\n") {
      result += "\\n";
    } else if (char === "\t") {
      result += "\\t";
    } else {
      result += char;
    }
  }

  return result;
}
