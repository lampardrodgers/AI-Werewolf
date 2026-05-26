import { AgentMemoryUpdate, GameCommand, GameState } from "@langrensha/engine";
import { AIConfigStore, LLMCallLog, PlayerId } from "@langrensha/shared";

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

export async function requestAIDecision(state: GameState, seatId?: PlayerId, requestId?: string): Promise<{
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
    body: JSON.stringify({ state, seatId, requestId })
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

export async function loadAIDecisionStatus(requestId: string): Promise<AIDecisionStatus | undefined> {
  const response = await fetch(`/api/ai/status/${encodeURIComponent(requestId)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error("读取 AI 状态失败");
  const body = (await response.json()) as { ok: boolean; status?: AIDecisionStatus };
  return body.status;
}
