import { AgentMemoryUpdate, GameCommand, GameState } from "@langrensha/engine";
import { AIConfigStore, ContextCompressionConfig, LLMCallLog, PlayerId } from "@langrensha/shared";

export interface AIDecisionStatus {
  requestId: string;
  status: "received" | "building_prompt" | "provider_request" | "repairing" | "completed" | "fallback" | "failed";
  seatId?: PlayerId;
  phase?: string;
  provider?: string;
  model?: string;
  attempt?: number;
  timeoutMs?: number;
  expectedThinkingMs?: number;
  message: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

export async function loadAIConfig(): Promise<AIConfigStore> {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("读取 AI 配置失败");
  return (await response.json()) as AIConfigStore;
}

export async function saveAIConfig(config: AIConfigStore): Promise<AIConfigStore> {
  const response = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  });
  if (!response.ok) throw new Error("保存 AI 配置失败");
  return (await response.json()) as AIConfigStore;
}

export async function testProvider(providerId: string, apiKey?: string): Promise<{ ok: boolean; error?: string; models?: Array<{ id: string; name: string }> }> {
  const response = await fetch("/api/llm/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId, apiKey })
  });
  if (!response.ok) throw new Error("测试连接请求失败");
  return (await response.json()) as { ok: boolean; error?: string; models?: Array<{ id: string; name: string }> };
}

export async function requestAIDecision(
  state: GameState,
  seatId?: PlayerId,
  requestId?: string,
  providerApiKeys?: Record<string, string>,
  contextCompression?: ContextCompressionConfig,
  signal?: AbortSignal
): Promise<{
  ok: boolean;
  command?: GameCommand;
  llmCall?: LLMCallLog;
  memoryUpdate?: AgentMemoryUpdate;
  fallback: boolean;
  error?: string;
}> {
  const response = await fetch("/api/ai/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      state: compactStateForAIDecision(state),
      seatId,
      requestId,
      providerApiKeys: sanitizeProviderApiKeys(providerApiKeys),
      contextCompression
    })
  });
  if (!response.ok) throw new Error("AI 决策请求失败");
  return (await response.json()) as {
    ok: boolean;
    command?: GameCommand;
    llmCall?: LLMCallLog;
    memoryUpdate?: AgentMemoryUpdate;
    fallback: boolean;
    error?: string;
  };
}

export async function cancelAIDecision(requestId: string): Promise<{ ok: boolean; cancelled: boolean }> {
  const response = await fetch(`/api/ai/cancel/${encodeURIComponent(requestId)}`, { method: "POST", keepalive: true });
  if (!response.ok) throw new Error("取消 AI 决策请求失败");
  return (await response.json()) as { ok: boolean; cancelled: boolean };
}

function compactStateForAIDecision(state: GameState): GameState {
  return {
    ...state,
    llmCalls: state.llmCalls.map((call) => ({
      ...call,
      promptTextRedacted: "",
      rawResponse: "",
      parsedJson: {},
      publicSpeech: truncateText(call.publicSpeech, 600),
      privateRationale: truncateText(call.privateRationale, 400),
      error: truncateText(call.error, 500)
    }))
  };
}

function truncateText(value: string | undefined, maxLength: number): string | undefined {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function sanitizeProviderApiKeys(providerApiKeys: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!providerApiKeys) return undefined;
  const sanitized = Object.fromEntries(Object.entries(providerApiKeys).filter(([, value]) => value.trim()));
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export async function loadAIDecisionStatus(requestId: string): Promise<AIDecisionStatus | undefined> {
  const response = await fetch(`/api/ai/status/${encodeURIComponent(requestId)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error("读取 AI 状态失败");
  const body = (await response.json()) as { ok: boolean; status?: AIDecisionStatus };
  return body.status;
}
