import { AgentMemoryUpdate, GameCommand, GameState, PendingAction, canWolfSelfExplode, createMockDecision, getPlayerVisibleEvents } from "@langrensha/engine";
import { LLMObjectParseError, LLMObjectResponse, LLMProviderAdapter, createProviderAdapter, parseObjectResponse } from "@langrensha/llm-gateway";
import { OUTPUT_SCHEMAS, SYSTEM_PROMPT_VERSION, buildPromptPreview } from "@langrensha/prompts";
import {
  AIConfigStore,
  AIPersona,
  CostControls,
  DEFAULT_COST_CONTROLS,
  DEFAULT_PERSONAS,
  LLMCallLog,
  ModelConfig,
  PlayerId,
  PlayerProfile,
  ProviderAccount,
  ROLE_DEFINITIONS,
  RoleId,
  createPromptHash
} from "@langrensha/shared";

export interface AIDecisionRequest {
  state: GameState;
  seatId?: PlayerId;
  requestId?: string;
  providerApiKeys?: Record<string, string | undefined>;
}

export interface AIDecisionResponse {
  ok: boolean;
  command?: GameCommand;
  llmCall?: LLMCallLog;
  memoryUpdate?: AgentMemoryUpdate;
  fallback: boolean;
  error?: string;
}

export interface AIDecisionProgress {
  requestId?: string;
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
}

export type AIDecisionProgressCallback = (progress: AIDecisionProgress) => void;

export async function buildAIDecision(
  request: AIDecisionRequest,
  config: AIConfigStore,
  apiKeyResolver: (provider: ProviderAccount, request: AIDecisionRequest) => string | undefined = resolveBrowserApiKey,
  adapterFactory: (provider: ProviderAccount) => LLMProviderAdapter = createProviderAdapter,
  onProgress?: AIDecisionProgressCallback
): Promise<AIDecisionResponse> {
  const requestId = request.requestId;
  const pending = selectPendingAction(request.state, request.seatId);
  if (!pending) {
    onProgress?.({
      requestId,
      status: "failed",
      message: "当前没有可由 AI 自动处理的 pending action",
      error: "当前没有可由 AI 自动处理的 pending action"
    });
    return { ok: false, fallback: false, error: "当前没有可由 AI 自动处理的 pending action" };
  }

  const player = requirePlayer(request.state, pending.seatId);
  const persona = resolvePersona(config, player.personaId);
  const provider = config.providers.find((item) => item.id === persona.defaultProviderId && item.enabled);
  const model = persona.defaultModel || provider?.defaultModel;
  onProgress?.({
    requestId,
    status: "received",
    seatId: pending.seatId,
    phase: request.state.phase.label,
    provider: provider?.name,
    model,
    message: `${formatSeat(request.state, pending.seatId)} 的 AI 动作已进入服务端队列。`
  });

  if (!provider || !model || provider.baseUrl.startsWith("mock://")) {
    const reason = `未配置真实供应商，使用 Mock 兜底：${persona.name}`;
    onProgress?.({ requestId, status: "fallback", seatId: pending.seatId, phase: request.state.phase.label, message: reason, error: reason });
    return fallbackDecision(request.state, reason);
  }

  const apiKey = apiKeyResolver(provider, request);
  if (!apiKey) {
    const reason = `${provider.name} 缺少本机 API Key / Access Token。请在当前浏览器管理控制台填写后再继续。`;
    onProgress?.({ requestId, status: "failed", seatId: pending.seatId, phase: request.state.phase.label, provider: provider.name, model, message: reason, error: reason });
    return { ok: false, fallback: false, error: reason };
  }

  const costLimitReason = checkCostLimit(request.state, pending.seatId, config.costControls);
  if (costLimitReason) {
    onProgress?.({ requestId, status: "fallback", seatId: pending.seatId, phase: request.state.phase.label, provider: provider.name, model, message: costLimitReason, error: costLimitReason });
    return fallbackDecision(request.state, costLimitReason);
  }

  const schemaName = schemaNameForPending(pending);
  onProgress?.({
    requestId,
    status: "building_prompt",
    seatId: pending.seatId,
    phase: request.state.phase.label,
    provider: provider.name,
    model,
    message: "服务端正在整理该玩家可见信息、记忆和本阶段合法动作。"
  });
  const prompt = buildPromptForPending(request.state, pending, persona, schemaName);
  const started = Date.now();
  let lastError = "";
  const maxAttempts = Math.max(6, provider.retryCount + 4);
  const timeoutMs = requestTimeoutMs(provider);
  const expectedThinkingMs = expectedThinkingWindowMs(persona);

  const adapter = adapterFactory(provider);
  let textRecoveryAttempts = 0;
  const maxTextRecoveryAttempts = Math.min(3, maxAttempts);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const isCompactRepairAttempt = attempt > 1;
    const maxOutputTokens = limitMaxOutputTokens(persona.maxOutputTokens, config.costControls);
    const currentPrompt =
      attempt === 0
        ? prompt
        : isCompactRepairAttempt
          ? buildCompactRepairPrompt(request.state, pending, persona, lastError)
          : buildRepairPrompt(prompt, lastError, OUTPUT_SCHEMAS[schemaName]);
    try {
      onProgress?.({
        requestId,
        status: "provider_request",
        seatId: pending.seatId,
        phase: request.state.phase.label,
        provider: provider.name,
        model,
        attempt,
        timeoutMs,
        expectedThinkingMs,
        message: attempt === 0 ? "服务端已向模型发送请求，正在等待模型返回。" : "服务端已发送修复请求，正在等待模型返回。"
      });
      const result = await adapter.generateObject<Record<string, unknown>>({
        provider,
        model,
        prompt: currentPrompt,
        schema: OUTPUT_SCHEMAS[schemaName],
        apiKey,
        temperature: isCompactRepairAttempt ? Math.min(persona.temperature, 0.2) : persona.temperature,
        topP: isCompactRepairAttempt ? Math.min(persona.topP, 0.8) : persona.topP,
        maxOutputTokens: isCompactRepairAttempt ? Math.min(maxOutputTokens, 600) : maxOutputTokens,
        reasoningEffort: provider.supportsReasoningEffort ? persona.reasoningEffort : undefined,
        timeoutMs
      });
      const command = commandFromModelObject(request.state, pending, result.object);
      const memoryUpdate = extractMemoryUpdate(result.object);
      onProgress?.({
        requestId,
        status: "completed",
        seatId: pending.seatId,
        phase: request.state.phase.label,
        provider: provider.name,
        model,
        attempt,
        timeoutMs,
        expectedThinkingMs,
        message: "模型已返回并通过合法性校验。"
      });
      return {
        ok: true,
        command,
        llmCall: createCallLog(request.state, config, pending, persona, provider.id, provider.name, model, currentPrompt, result, command, Date.now() - started, attempt),
        memoryUpdate,
        fallback: false
      };
    } catch (error) {
      const recovered = recoverTextDecisionFromParseError(error, request.state, pending);
      if (recovered) {
        onProgress?.({
          requestId,
          status: "completed",
          seatId: pending.seatId,
          phase: request.state.phase.label,
          provider: provider.name,
          model,
          attempt,
          timeoutMs,
          expectedThinkingMs,
          message: "模型返回了自然语言动作，服务端已抽取为合法结构化动作。"
        });
        return {
          ok: true,
          command: recovered.command,
          llmCall: createCallLog(
            request.state,
            config,
            pending,
            persona,
            provider.id,
            provider.name,
            model,
            currentPrompt,
            recovered.result,
            recovered.command,
            Date.now() - started,
            attempt
          ),
          memoryUpdate: recovered.memoryUpdate,
          fallback: false
        };
      }
      if (textRecoveryAttempts < maxTextRecoveryAttempts && shouldTryTextRecovery(pending, attempt)) {
        textRecoveryAttempts += 1;
        const textRecovered = await recoverWithTextGeneration({
          adapter,
          provider,
          model,
          apiKey,
          state: request.state,
          pending,
          persona,
          config,
          timeoutMs,
          error: normalizeError(error).message
        });
        if (textRecovered) {
          onProgress?.({
            requestId,
            status: "completed",
            seatId: pending.seatId,
            phase: request.state.phase.label,
            provider: provider.name,
            model,
            attempt: attempt + 1,
            timeoutMs,
            expectedThinkingMs,
            message: "结构化接口未返回可用动作，文本修复请求已产出合法动作。"
          });
          return {
            ok: true,
            command: textRecovered.command,
            llmCall: createCallLog(
              request.state,
              config,
              pending,
              persona,
              provider.id,
              provider.name,
              model,
              textRecovered.prompt,
              textRecovered.result,
              textRecovered.command,
              Date.now() - started,
              attempt + 1
            ),
            memoryUpdate: textRecovered.memoryUpdate,
            fallback: false
          };
        }
      }
      lastError = normalizeError(error).message;
      onProgress?.({
        requestId,
        status: attempt + 1 < maxAttempts ? "repairing" : "failed",
        seatId: pending.seatId,
        phase: request.state.phase.label,
        provider: provider.name,
        model,
        attempt,
        timeoutMs,
        expectedThinkingMs,
        message: attempt + 1 < maxAttempts ? "模型返回未通过校验，服务端准备发送修复请求。" : "模型请求失败或输出未通过校验。",
        error: lastError
      });
    }
  }

  const reason = `真实 AI 输出连续失败：${lastError}`;
  onProgress?.({
    requestId,
    status: "fallback",
    seatId: pending.seatId,
    phase: request.state.phase.label,
    provider: provider.name,
    model,
    timeoutMs,
    expectedThinkingMs,
    message: "真实模型没有产出可用动作，已触发规则兜底以免整局卡死。",
    error: reason
  });
  return fallbackDecision(request.state, reason, maxAttempts - 1);
}

function resolveBrowserApiKey(provider: ProviderAccount, request: AIDecisionRequest): string | undefined {
  const apiKey = request.providerApiKeys?.[provider.id]?.trim();
  return apiKey || undefined;
}

function checkCostLimit(state: GameState, seatId: PlayerId, costControls: CostControls | undefined): string | undefined {
  const controls = costControls ?? DEFAULT_COST_CONTROLS;
  if (!controls.enabled) return undefined;
  const gameCost = state.llmCalls.reduce((sum, call) => sum + call.estimatedCost, 0);
  const seatCost = state.llmCalls.filter((call) => call.seatId === seatId).reduce((sum, call) => sum + call.estimatedCost, 0);
  if (controls.maxGameCost > 0 && gameCost >= controls.maxGameCost) {
    return `成本保护：本局费用 ${gameCost.toFixed(6)} 已达到上限 ${controls.maxGameCost.toFixed(6)}，使用 Mock 兜底。`;
  }
  if (controls.maxSeatCost > 0 && seatCost >= controls.maxSeatCost) {
    return `成本保护：该 AI 费用 ${seatCost.toFixed(6)} 已达到上限 ${controls.maxSeatCost.toFixed(6)}，使用 Mock 兜底。`;
  }
  return undefined;
}

function limitMaxOutputTokens(personaMaxOutputTokens: number, costControls: CostControls | undefined): number {
  const controls = costControls ?? DEFAULT_COST_CONTROLS;
  if (!controls.enabled || controls.maxOutputTokensPerCall <= 0) return personaMaxOutputTokens;
  return Math.min(personaMaxOutputTokens, controls.maxOutputTokensPerCall);
}

function expectedThinkingWindowMs(persona: AIPersona): number {
  const byReasoningStrength: Record<AIPersona["reasoningStrength"], number> = {
    fast: 20000,
    normal: 40000,
    deep: 75000
  };
  const byEffort: Record<AIPersona["reasoningEffort"], number> = {
    minimal: 15000,
    low: 30000,
    medium: 55000,
    high: 85000
  };
  return Math.max(byReasoningStrength[persona.reasoningStrength], byEffort[persona.reasoningEffort]);
}

function requestTimeoutMs(_provider: ProviderAccount): number | undefined {
  return 0;
}

function selectPendingAction(state: GameState, seatId?: PlayerId): PendingAction | undefined {
  if (seatId) {
    return state.pendingActions.find((action) => action.seatId === seatId);
  }
  return state.pendingActions.find((action) => {
    const player = state.players.find((item) => item.id === action.seatId);
    return player && player.controller !== "human";
  });
}

function fallbackDecision(state: GameState, reason: string, retryCount = 0): AIDecisionResponse {
  const decision = createMockDecision(state);
  if (!decision) {
    return { ok: false, fallback: true, error: reason };
  }
  return {
    ok: true,
    command: decision.command,
    llmCall: createFallbackCallLog(state, decision.command, decision.parsedJson, decision.privateRationale, reason, retryCount),
    fallback: true,
    error: reason
  };
}

function shouldTryTextRecovery(pending: PendingAction, attempt: number): boolean {
  if (pending.kind === "speech") return attempt >= 0;
  return attempt >= 1;
}

function recoverTextDecisionFromParseError(
  error: unknown,
  state: GameState,
  pending: PendingAction
): { result: LLMObjectResponse<Record<string, unknown>>; command: GameCommand; memoryUpdate?: AgentMemoryUpdate } | undefined {
  if (!(error instanceof LLMObjectParseError)) return undefined;
  const result = coercePlainTextResponse(state, pending, error.response);
  if (!result) return undefined;
  try {
    const command = commandFromModelObject(state, pending, result.object);
    return { result, command, memoryUpdate: extractMemoryUpdate(result.object) };
  } catch {
    return undefined;
  }
}

async function recoverWithTextGeneration({
  adapter,
  provider,
  model,
  apiKey,
  state,
  pending,
  persona,
  config,
  timeoutMs,
  error
}: {
  adapter: LLMProviderAdapter;
  provider: ProviderAccount;
  model: string;
  apiKey: string;
  state: GameState;
  pending: PendingAction;
  persona: AIPersona;
  config: AIConfigStore;
  timeoutMs: number | undefined;
  error: string;
}): Promise<{ prompt: string; result: LLMObjectResponse<Record<string, unknown>>; command: GameCommand; memoryUpdate?: AgentMemoryUpdate } | undefined> {
  const prompt = buildCompactRepairPrompt(state, pending, persona, error);
  let response: Awaited<ReturnType<LLMProviderAdapter["generateText"]>>;
  try {
    response = await adapter.generateText({
      provider,
      model,
      prompt,
      apiKey,
      temperature: Math.min(persona.temperature, 0.2),
      topP: Math.min(persona.topP, 0.8),
      maxOutputTokens: Math.min(limitMaxOutputTokens(persona.maxOutputTokens, config.costControls), 600),
      reasoningEffort: provider.supportsReasoningEffort ? persona.reasoningEffort : undefined,
      timeoutMs
    });
  } catch {
    return undefined;
  }
  let result: LLMObjectResponse<Record<string, unknown>> | undefined;
  try {
    result = parseObjectResponse<Record<string, unknown>>(response);
  } catch (parseError) {
    result = coercePlainTextResponse(state, pending, response);
    if (!result && parseError instanceof LLMObjectParseError) {
      result = coercePlainTextResponse(state, pending, parseError.response);
    }
  }
  if (!result) return undefined;
  try {
    const command = commandFromModelObject(state, pending, result.object);
    return { prompt, result, command, memoryUpdate: extractMemoryUpdate(result.object) };
  } catch {
    return undefined;
  }
}

function coercePlainTextResponse(
  state: GameState,
  pending: PendingAction,
  response: Omit<LLMObjectResponse<Record<string, unknown>>, "object">
): LLMObjectResponse<Record<string, unknown>> | undefined {
  const text = normalizePlainModelText(response.text);
  if (!text) return undefined;
  const privateReason = "模型返回自然语言而非 JSON，但内容明确完成当前阶段动作，服务端按原文抽取结构化字段。";

  if (canWolfSelfExplode(state, pending.seatId) && mentionsWolfSelfExplosion(text)) {
    return { ...response, text, object: { self_explode: true, public_speech: text, private_reason: privateReason, memory_update: {} } };
  }

  if (pending.kind === "speech") {
    return { ...response, text, object: { public_speech: text, private_reason: privateReason, memory_update: {} } };
  }
  if (pending.kind === "sheriff_candidacy") {
    return { ...response, text, object: { run_for_sheriff: inferSheriffRun(text), public_speech: text, private_reason: privateReason } };
  }
  if (pending.kind === "wolf_discussion") {
    const target = extractMentionedTarget(state, text, pending.legalTargets) ?? pending.currentProposal;
    if (!target) return undefined;
    return {
      ...response,
      text,
      object: {
        message_to_wolves: text,
        proposed_target: target,
        agree_current_proposal: pending.currentProposal ? target === pending.currentProposal : true,
        private_reason: privateReason
      }
    };
  }
  if (pending.kind === "guard_protect" || pending.kind === "seer_check") {
    const target = extractMentionedTarget(state, text, pending.legalTargets);
    if (!target) return undefined;
    return { ...response, text, object: { target_id: target, private_reason: privateReason } };
  }
  if (pending.kind === "witch_action") {
    const save = pending.canSave && mentionsSave(text);
    const poisonTarget = pending.canPoison && mentionsPoison(text) ? extractMentionedTarget(state, text, pending.legalTargets) : undefined;
    if (!save && !poisonTarget && !mentionsHoldWitchAction(text)) return undefined;
    return { ...response, text, object: { save, poison_target_id: poisonTarget ?? null, private_reason: privateReason } };
  }
  if (pending.kind === "vote") {
    const target = mentionsAbstain(text) && state.rulePreset.voteRules.allowAbstain ? "abstain" : extractMentionedTarget(state, text, pending.legalTargets);
    if (!target) return undefined;
    return {
      ...response,
      text,
      object: {
        vote_target: target,
        private_reason: "目标玩家在当前发言和票型中被模型自然语言明确指向，服务端抽取该目标完成投票。",
        confidence: 0.55
      }
    };
  }
  if (pending.kind === "badge_decision") {
    const target = mentionsDestroyBadge(text) && pending.canDestroy ? "destroy" : extractMentionedTarget(state, text, pending.legalTargets);
    if (!target) return undefined;
    return { ...response, text, object: { target_id: target, private_reason: privateReason } };
  }
  if (pending.kind === "hunter_shot") {
    const target = mentionsSkipHunterShot(text) && pending.canSkip ? "skip" : extractMentionedTarget(state, text, pending.legalTargets);
    if (!target) return undefined;
    return { ...response, text, object: { target_id: target, private_reason: privateReason } };
  }
  return undefined;
}

function resolvePersona(config: AIConfigStore, personaId: string | undefined): AIPersona {
  return config.personas.find((item) => item.id === personaId) ?? DEFAULT_PERSONAS.find((item) => item.id === personaId) ?? config.personas[0] ?? DEFAULT_PERSONAS[0];
}

function buildPromptForPending(
  state: GameState,
  pending: PendingAction,
  persona: AIPersona,
  schemaName: keyof typeof OUTPUT_SCHEMAS
): string {
  const player = requirePlayer(state, pending.seatId);
  return buildPromptPreview({
    preset: state.rulePreset,
    role: player.role,
    persona,
    phaseTask: buildPhaseTask(state, pending),
    memorySummary: buildMemorySummary(state, pending.seatId),
    visibleFacts: buildVisibleFacts(state, pending),
    schemaName
  });
}

function buildPhaseTask(state: GameState, pending: PendingAction): string {
  const legalTargets = "legalTargets" in pending ? pending.legalTargets.map((id) => `${id}=${formatSeat(state, id)}`).join("，") : "无";
  const targetRule = legalTargets && legalTargets !== "无" ? "目标字段必须使用合法目标等号左侧的 player_N ID，不要使用座位号、昵称或等号右侧文本。" : "";
  const identityBoundary =
    "信息边界：公开判断必须基于场上发言、公开票型、警徽流、公开事件和你的合法技能结果；死亡、出局、被投票、遗言和玩家自称不会自动验明真实身份，禁止读取其他玩家后台身份。";
  const selfExplosionRule = canWolfSelfExplode(state, pending.seatId)
    ? "狼人自爆：如果你是狼人且公开自爆能明确打断当前白天、保护队友或避免更大损失，可以输出 self_explode=true；自爆后你出局，本回合直接结束并进入夜晚。没有明确收益不要自爆。公开发言里禁止用普通发言泄露自己是狼、狼队友或狼队私聊；要认狼只能用 self_explode=true。"
    : "";
  const base = `当前阶段：${state.phase.label}。行动座位：${formatSeat(state, pending.seatId)}。合法目标：${legalTargets || "无"}。${targetRule}${identityBoundary}`;
  if (pending.kind === "guard_protect") return `${base} 请选择一名玩家守护，输出 target_id 和 private_reason。`;
  if (pending.kind === "seer_check") return `${base} 请选择一名玩家查验，输出 target_id 和 private_reason。`;
  if (pending.kind === "witch_action") {
    return `${base} 狼人刀口：${pending.wolfTarget ? formatSeat(state, pending.wolfTarget) : "无"}。canSave=${pending.canSave}，canPoison=${pending.canPoison}。女巫只知道刀口和自己的药，不知道毒药目标的真实身份；毒药必须基于公开发言、票型、查杀/对跳等公开理由，信息不足时应留毒。输出 save、poison_target_id 和 private_reason。`;
  }
  if (pending.kind === "wolf_discussion") {
    return `${base} 狼人夜间私聊第 ${pending.round}/3 轮。当前提案：${pending.currentProposal ? formatSeat(state, pending.currentProposal) : "暂无"}。狼刀合法目标包含所有存活玩家，因此可以自刀或刀队友，但必须说明收益；不能假装知道非狼玩家的具体神职身份。输出 message_to_wolves、proposed_target、agree_current_proposal 和 private_reason。`;
  }
  if (pending.kind === "sheriff_candidacy") {
    return `${base}${selfExplosionRule} 请只决定是否报名上警；这不是正式警上发言，public_speech 只写一句简短报名/不上警理由。常见策略：预言家高概率上警争警徽，狼队通常至少一名成员悍跳或搅局，少量强势好人也可能上警；不要机械地只让真预言家上警。输出 run_for_sheriff、public_speech 和 private_reason。`;
  }
  if (pending.kind === "speech") {
    const evidenceRule =
      "只能引用已经发生且对你可见的公开事实；没有警下票型、PK 票型、死亡信息、对跳或站边时，禁止把这些内容编成依据。若当前只有上警名单，就围绕实际上警名单、已发言内容和退水情况发言，不要要求未参与上警的人解释站边。";
    const speechRule =
      pending.speechType === "sheriff"
        ? `这是正式警上发言；如果跳预言家，需要报验人、警徽流和站边逻辑。非预言家不要无收益乱跳预言家。${evidenceRule}`
        : `发言必须像狼人杀玩家，围绕已经公开的警上/警下、票型、刀口、对跳、警徽流、站边和发言矛盾展开，不要写泛泛模板。${evidenceRule}`;
    return `${base}${selfExplosionRule} 请进行${pending.speechType === "last_words" ? "遗言" : "公开发言"}。${speechRule} 输出 public_speech 和 private_reason 等字段。`;
  }
  if (pending.kind === "vote") {
    const voteRule =
      pending.voteType === "sheriff" || pending.voteType === "sheriff_pk"
        ? "警长票只能基于警上发言、退水、对跳质量和警下票型判断；不能因为后台真实身份或狼夜聊支持某位候选人。"
        : "放逐票只能基于公开发言、票型、公开死亡结果、技能声明和站边矛盾判断；不能使用未公开真实身份或私聊信息。";
    return `${base}${selfExplosionRule} 你是${formatSeat(state, pending.seatId)}，不能投给自己，禁止输出 ${pending.seatId}。${voteRule} 请投票，可以在允许时弃票 abstain。输出 vote_target、private_reason、confidence。`;
  }
  if (pending.kind === "badge_decision") return `${base} 警长已经死亡，请选择一名存活玩家移交警徽，或输出 destroy 撕毁警徽。输出 target_id 和 private_reason。`;
  return `${base} 你是猎人，请选择开枪目标或 skip，输出 target_id 和 private_reason。`;
}

function buildMemorySummary(state: GameState, seatId: PlayerId): string {
  const memory = state.memories[seatId];
  if (!memory) return "暂无单局记忆。";
  const claimedRoles = Object.entries(memory.claimedRoles)
    .filter(([, claims]) => claims.length > 0)
    .map(([playerId, claims]) => `${formatSeat(state, playerId)}自称/被声称：${claims.join("、")}`)
    .join("；");
  return [
    "记忆边界：这里只保留公开发言、公开票型、公开自称和可复述的推理笔记；不包含其他玩家后台身份、狼夜聊、私有行动理由或未公开死因。",
    `公开摘要：${memory.publicTimelineSummary || "暂无"}`,
    `公开自称：${claimedRoles || "暂无"}`,
    `票型笔记：${memory.voteHistoryNotes || "暂无"}`,
    `公开矛盾：${memory.contradictions.join("；") || "暂无"}`,
    `公开承诺：${memory.promisesAndCommitments.join("；") || "暂无"}`
  ].join("\n");
}

function buildVisibleFacts(state: GameState, pending: PendingAction): string[] {
  const player = requirePlayer(state, pending.seatId);
  const facts = [
    `当前天数：${state.day}`,
    `当前阶段：${state.phase.type}`,
    `你的座位：${formatSeat(state, pending.seatId)}`,
    `你的身份：${ROLE_DEFINITIONS[player.role].name}`,
    "信息确认边界：公开判断只能使用场上发言、公开票型、公开事件和你的合法技能结果；死亡、出局、被投票和遗言不会自动公开真实身份。没有技能结果、狼人队友信息或公开揭示时，只能说可能/倾向/判断，不能说已知某人是狼、好人、平民或神职。",
    `存活玩家：${state.players.filter((item) => item.alive).map((item) => formatSeat(state, item.id)).join("、")}`,
    `警长：${state.sheriffSeatId ? formatSeat(state, state.sheriffSeatId) : "无"}`
  ];
  if (player.role === "werewolf") {
    facts.push(`狼人队友：${state.players.filter((item) => item.role === "werewolf").map((item) => formatSeat(state, item.id)).join("、")}`);
  }

  const visibleEvents = promptVisibleEvents(state, pending);
  facts.push(...buildPrivateResourceFacts(state, pending.seatId));
  facts.push(...buildPublicClaimFacts(state));
  facts.push(...buildPublicRecordFacts(state, pending.seatId));
  facts.push(...buildVisibleEventFacts(state, pending, visibleEvents));
  return facts;
}

function buildPrivateResourceFacts(state: GameState, seatId: PlayerId): string[] {
  const player = requirePlayer(state, seatId);
  const resource = state.resources[seatId];
  const facts: string[] = [];
  if (player.role === "werewolf") {
    const teammates = state.players
      .filter((item) => item.role === "werewolf")
      .map((item) => `${formatSeat(state, item.id)}(${item.alive ? "存活" : "死亡"})`)
      .join("、");
    facts.push(`你的狼人队友状态：${teammates || "无"}。这是私有信息，公开发言禁止直接泄露，除非选择 self_explode=true 自爆。`);
  }
  if (player.role === "witch" && resource) {
    facts.push(`你的女巫药量：解药${resource.antidote ? "可用" : "已用"}，毒药${resource.poison ? "可用" : "已用"}。`);
  }
  if (player.role === "hunter" && resource) {
    facts.push(`你的猎人开枪状态：${resource.hunterCanShoot ? "可开枪" : "不可开枪/已用"}。`);
  }
  if (player.role === "seer") {
    const checks = state.events
      .filter((event) => event.type === "SeerChecked" && event.seatId === seatId && isRecord(event.payload))
      .map((event) => {
        const targetId = textValue(event.payload.targetId);
        const result = textValue(event.payload.result);
        if (!targetId || !result) return "";
        return `${formatSeat(state, targetId)}=${result === "werewolf" ? "狼人" : "好人"}`;
      })
      .filter(Boolean);
    facts.push(`你的查验记录：${checks.length ? checks.join("、") : "暂无"}。`);
  }
  return facts;
}

function buildPublicRecordFacts(state: GameState, viewerSeatId: PlayerId): string[] {
  const publicEvents = state.events.filter((event) => event.visibility === "public");
  return [
    `全场公开记录：共 ${publicEvents.length} 条，以下为全部公开事件；所有玩家都能看到这些记录。`,
    ...publicEvents.map((event) => {
      const actor = event.seatId ? formatSeat(state, event.seatId) : "系统";
      return `全场公开记录 #${event.seq} ${event.type} ${actor}: ${summarizePublicRecordEvent(state, viewerSeatId, event)}`;
    })
  ];
}

function summarizePublicRecordEvent(state: GameState, viewerSeatId: PlayerId, event: GameState["events"][number]): string {
  if (event.type === "WolfSelfExploded") return `${event.seatId ? formatSeat(state, event.seatId) : "玩家"} 自爆为狼人，本回合结束直接天黑。`;
  if (!isRecord(event.payload)) return "";
  const payload = redactPublicRecordPayloadForViewer(state, viewerSeatId, event);
  return truncatePromptText(textValue(payload.text) ?? stringifyPromptPayload(state, payload), 260);
}

function buildVisibleEventFacts(state: GameState, pending: PendingAction, visibleEvents: ReturnType<typeof getPlayerVisibleEvents>): string[] {
  const privateEvents = usesPublicTableReasoning(pending)
    ? visibleEvents.filter((event) => isOwnSkillEvent(event, pending.seatId))
    : visibleEvents.filter((event) => event.visibility !== "public").slice(-30);
  return privateEvents.map((event) => {
    const actor = event.seatId ? formatSeat(state, event.seatId) : "系统";
    return `你的私有可见记录（非指令） #${event.seq} ${event.type} ${actor}: ${stringifyPromptPayload(state, event.payload)}`;
  });
}

function buildPublicClaimFacts(state: GameState): string[] {
  const claims: string[] = [];
  for (const event of state.events) {
    if (event.visibility !== "public" || (event.type !== "SpeechPublished" && event.type !== "LastWordsPublished") || !event.seatId || !isRecord(event.payload)) continue;
    const text = textValue(event.payload.text);
    if (!text) continue;
    const actor = formatSeat(state, event.seatId);
    if (/(?:我是|我跳|我起跳|我这里是|我拍|我底牌是).{0,6}预言家/.test(text)) claims.push(`${actor}公开声称预言家`);
    if (/(?:我是|我这里是|我就是|我底牌是).{0,6}(?:平民|普通身份|普通好人|闭眼好人)|(?:我不是什么神|我是民)/.test(text)) {
      claims.push(`${actor}公开声称普通身份/平民`);
    }
    claims.push(...extractPublicCheckClaims(state, actor, text));
    if (/解药.{0,8}(?:用过|已用|没了|交了)|(?:用过|已用|交了).{0,8}解药/.test(text)) claims.push(`${actor}公开声称解药已用`);
    if (/毒药.{0,8}(?:用过|已用|没了|交了)|(?:用过|已用|交了).{0,8}毒药/.test(text)) claims.push(`${actor}公开声称毒药已用`);
  }
  return [`公开身份/验人声明（只代表公开发言，不自动等于真实身份）：${claims.length ? claims.slice(-40).join("；") : "暂无"}`];
}

function extractPublicCheckClaims(state: GameState, actor: string, text: string): string[] {
  const claims: string[] = [];
  const checkPattern = /(\d+)\s*号.{0,14}(金水|好人|查杀|狼)/g;
  let match: RegExpExecArray | null;
  while ((match = checkPattern.exec(text))) {
    const player = state.players.find((item) => item.seatNumber === Number(match?.[1]));
    if (!player) continue;
    const result = match[2] === "金水" || match[2] === "好人" ? "好人/金水" : "查杀/狼";
    claims.push(`${actor}公开声称${formatSeat(state, player.id)}为${result}`);
  }
  return claims;
}

function promptVisibleEvents(state: GameState, pending: PendingAction): ReturnType<typeof getPlayerVisibleEvents> {
  const visibleEvents = getPlayerVisibleEvents(state, pending.seatId).filter((event) => event.type !== "AgentMemoryUpdated");
  if (!usesPublicTableReasoning(pending)) return visibleEvents;
  return visibleEvents.filter((event) => event.visibility === "public" || isOwnSkillEvent(event, pending.seatId));
}

function redactPublicRecordPayloadForViewer(state: GameState, viewerSeatId: PlayerId, event: GameState["events"][number]): Record<string, unknown> {
  const payload = isRecord(event.payload) ? redactPromptPayload(event.payload) : {};
  if (!isRecord(payload) || event.type !== "PhaseStarted") return isRecord(payload) ? payload : {};
  const phase = textValue(payload.phase);
  if (!phase || !isPrivateNightPhase(phase) || canViewPrivateNightPhase(state, viewerSeatId, phase)) return payload;
  return {
    ...payload,
    phase: "night_hidden",
    label: "夜晚行动",
    actingSeatId: undefined,
    progressLabel: "夜晚行动"
  };
}

function isPrivateNightPhase(phase: string): boolean {
  return phase === "night_guard" || phase === "night_wolves" || phase === "night_seer" || phase === "night_witch";
}

function canViewPrivateNightPhase(state: GameState, viewerSeatId: PlayerId, phase: string): boolean {
  const viewer = requirePlayer(state, viewerSeatId);
  if (phase === "night_wolves") return viewer.role === "werewolf";
  if (phase === "night_guard") return viewer.role === "guard";
  if (phase === "night_seer") return viewer.role === "seer";
  if (phase === "night_witch") return viewer.role === "witch";
  return false;
}

function usesPublicTableReasoning(pending: PendingAction): boolean {
  return (
    pending.kind === "speech" ||
    pending.kind === "vote" ||
    pending.kind === "sheriff_candidacy" ||
    pending.kind === "badge_decision" ||
    pending.kind === "hunter_shot" ||
    pending.kind === "witch_action"
  );
}

function isOwnSkillEvent(event: ReturnType<typeof getPlayerVisibleEvents>[number], seatId: PlayerId): boolean {
  return event.visibility === "private" && event.seatId === seatId && ["SeerChecked", "NightActionSubmitted", "WitchActionSubmitted"].includes(event.type);
}

function redactPromptPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(redactPromptPayload);
  if (!payload || typeof payload !== "object") return payload;
  const hiddenKeys = new Set([
    "privateReason",
    "private_reason",
    "privateRoleFacts",
    "private_role_facts",
    "privateNotes",
    "private_notes",
    "privateObservations",
    "private_observations"
  ]);
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>)
      .filter(([key]) => !hiddenKeys.has(key))
      .map(([key, value]) => [key, redactPromptPayload(value)])
  );
}

function stringifyPromptPayload(state: GameState, payload: unknown): string {
  return JSON.stringify(formatPromptPayload(state, redactPromptPayload(payload)));
}

function formatPromptPayload(state: GameState, payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map((item) => formatPromptPayload(state, item));
  if (typeof payload === "string") return formatPromptPayloadString(state, payload);
  if (!payload || typeof payload !== "object") return payload;
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([key, value]) => [
      formatPromptPayloadKey(state, key),
      formatPromptPayload(state, value)
    ])
  );
}

function formatPromptPayloadString(state: GameState, value: string): string {
  return state.players.some((player) => player.id === value) ? formatSeat(state, value) : value;
}

function formatPromptPayloadKey(state: GameState, key: string): string {
  return state.players.some((player) => player.id === key) ? formatSeat(state, key) : key;
}

function schemaNameForPending(pending: PendingAction): keyof typeof OUTPUT_SCHEMAS {
  if (pending.kind === "vote") return "vote";
  if (pending.kind === "speech") return "speech";
  if (pending.kind === "wolf_discussion") return "wolfDiscussion";
  if (pending.kind === "sheriff_candidacy") return "sheriff";
  if (pending.kind === "witch_action") return "witchAction";
  if (pending.kind === "hunter_shot") return "hunterShot";
  if (pending.kind === "badge_decision") return "badgeDecision";
  return "targetAction";
}

function commandFromModelObject(state: GameState, pending: PendingAction, object: Record<string, unknown>): GameCommand {
  if (
    canWolfSelfExplode(state, pending.seatId) &&
    isExplicitTrue(firstValue(object, ["self_explode", "selfExplode", "wolf_self_explode", "wolfSelfExplode", "self_destruct", "selfDestruct"]))
  ) {
    return {
      type: "SubmitWolfSelfExplosion",
      seatId: pending.seatId,
      privateReason: requiredPrivateReason(object)
    };
  }
  const publicSpeechIntent = textValue(firstValue(object, ["public_speech", "publicSpeech", "speech"]));
  if (publicSpeechIntent && canWolfSelfExplode(state, pending.seatId) && mentionsWolfSelfExplosion(publicSpeechIntent)) {
    return {
      type: "SubmitWolfSelfExplosion",
      seatId: pending.seatId,
      privateReason: requiredPrivateReason(object)
    };
  }

  if (pending.kind === "guard_protect" || pending.kind === "seer_check") {
    return {
      type: "SubmitNightAction",
      seatId: pending.seatId,
      action: pending.kind,
      targetId: requireLegalTarget(state, firstValue(object, ["target_id", "targetId", "target"]), pending.legalTargets),
      privateReason: requiredPrivateReason(object)
    };
  }
  if (pending.kind === "witch_action") {
    const poisonTarget = firstValue(object, ["poison_target_id", "poisonTargetId", "poison_target", "poisonTarget"]);
    return {
      type: "SubmitWitchAction",
      seatId: pending.seatId,
      save: Boolean(firstValue(object, ["save", "use_save", "useAntidote"])) && pending.canSave,
      poisonTargetId: typeof poisonTarget === "string" ? requireLegalTarget(state, poisonTarget, pending.legalTargets) : undefined,
      privateReason: requiredPrivateReason(object)
    };
  }
  if (pending.kind === "wolf_discussion") {
    const messageToWolves = requiredFieldText(object, ["message_to_wolves", "messageToWolves", "message"]);
    assertImmersiveOutputText(messageToWolves, "狼人私聊发言");
    return {
      type: "SubmitWolfDiscussionMessage",
      seatId: pending.seatId,
      messageToWolves,
      proposedTargetId: requireLegalTarget(state, firstValue(object, ["proposed_target", "proposed_target_id", "proposedTarget", "target_id", "targetId"]), pending.legalTargets),
      agreeCurrentProposal: Boolean(firstValue(object, ["agree_current_proposal", "agreeCurrentProposal", "agree"])),
      privateReason: requiredPrivateReason(object)
    };
  }
  if (pending.kind === "sheriff_candidacy") {
    const publicSpeech = normalizeUnsupportedPublicRoleCertainty(state, pending.seatId, requiredFieldText(object, ["public_speech", "publicSpeech", "speech"]));
    assertImmersiveOutputText(publicSpeech, "警长竞选发言");
    assertPublicSpeechDoesNotLeakPrivateIdentity(state, pending.seatId, publicSpeech, "警长竞选发言");
    return {
      type: "SubmitSheriffCandidacy",
      seatId: pending.seatId,
      runForSheriff: Boolean(firstValue(object, ["run_for_sheriff", "runForSheriff"])),
      publicSpeech,
      privateReason: requiredPrivateReason(object)
    };
  }
  if (pending.kind === "speech") {
    const text = normalizeUnsupportedPublicRoleCertainty(state, pending.seatId, requiredFieldText(object, ["public_speech", "publicSpeech", "speech"]));
    assertImmersiveOutputText(text, "公开发言");
    assertPublicSpeechDoesNotLeakPrivateIdentity(state, pending.seatId, text, "公开发言");
    return {
      type: "SubmitSpeech",
      seatId: pending.seatId,
      text,
      privateReason: requiredPrivateReason(object)
    };
  }
  if (pending.kind === "vote") {
    const rawTarget = String(firstValue(object, ["vote_target", "voteTarget", "target_id", "targetId", "target"]) ?? "");
    const targetId =
      rawTarget.trim() === "abstain" || (state.rulePreset.voteRules.allowAbstain && referencesSeat(state, rawTarget, pending.seatId))
        ? "abstain"
        : requireLegalTarget(state, rawTarget, pending.legalTargets);
    return {
      type: "SubmitVote",
      seatId: pending.seatId,
      targetId,
      privateReason: requiredVotePrivateReason(state, targetId, object),
      confidence: typeof object.confidence === "number" ? Math.max(0, Math.min(1, object.confidence)) : 0.5
    };
  }
  if (pending.kind === "badge_decision") {
    const rawTarget = String(firstValue(object, ["target_id", "targetId", "badge_target", "badgeTarget", "target"]) ?? "destroy");
    return {
      type: "SubmitBadgeDecision",
      seatId: pending.seatId,
      targetId: rawTarget.trim() === "destroy" ? "destroy" : requireLegalTarget(state, rawTarget, pending.legalTargets),
      privateReason: requiredPrivateReason(object)
    };
  }
  const rawTarget = String(firstValue(object, ["target_id", "targetId", "shot_target", "shotTarget"]) ?? "skip");
  return {
    type: "SubmitHunterShot",
    seatId: pending.seatId,
    targetId: rawTarget.trim() === "skip" ? "skip" : requireLegalTarget(state, rawTarget, pending.legalTargets),
    privateReason: requiredPrivateReason(object)
  };
}

function extractMemoryUpdate(object: Record<string, unknown>): AgentMemoryUpdate | undefined {
  const raw = firstValue(object, ["memory_update", "memoryUpdate"]);
  if (!isRecord(raw)) return undefined;
  const update: AgentMemoryUpdate = {
    publicSummaryDelta: textValue(firstValue(raw, ["public_summary_delta", "publicSummaryDelta", "public_delta", "summary"])),
    privateNotes: textValue(firstValue(raw, ["private_notes", "privateNotes", "private_observations", "privateObservations"])),
    suspicionChanges: extractScoreChanges(firstValue(raw, ["suspicion_changes", "suspicionChanges"])),
    trustChanges: extractScoreChanges(firstValue(raw, ["trust_changes", "trustChanges"])),
    newClaims: extractClaims(firstValue(raw, ["new_claims", "newClaims", "claims"])),
    contradictions: textArray(firstValue(raw, ["contradictions"])),
    promisesAndCommitments: textArray(firstValue(raw, ["promises_and_commitments", "promisesAndCommitments", "commitments"])),
    knownFacts: textArray(firstValue(raw, ["known_facts", "knownFacts"])),
    privateRoleFacts: undefined
  };
  return hasMemoryUpdateContent(update) ? update : undefined;
}

function extractScoreChanges(value: unknown): AgentMemoryUpdate["suspicionChanges"] {
  if (!Array.isArray(value)) return undefined;
  const changes = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const playerId = textValue(firstValue(item, ["player", "player_id", "playerId"]));
    const delta = numberValue(firstValue(item, ["delta", "change"]));
    if (!playerId || delta === undefined) return [];
    return [{ playerId, delta, reason: textValue(firstValue(item, ["reason", "note"])) }];
  });
  return changes.length > 0 ? changes : undefined;
}

function extractClaims(value: unknown): AgentMemoryUpdate["newClaims"] {
  if (!Array.isArray(value)) return undefined;
  const claims = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const playerId = textValue(firstValue(item, ["player", "player_id", "playerId"]));
    const claim = textValue(firstValue(item, ["claim", "role", "claimedRole"]));
    if (!playerId || !claim) return [];
    return [{ playerId, claim }];
  });
  return claims.length > 0 ? claims : undefined;
}

function textArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => textValue(item)).filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function hasMemoryUpdateContent(update: AgentMemoryUpdate): boolean {
  return Boolean(
    update.publicSummaryDelta ||
      update.privateNotes ||
      update.suspicionChanges?.length ||
      update.trustChanges?.length ||
      update.newClaims?.length ||
      update.contradictions?.length ||
      update.promisesAndCommitments?.length ||
      update.knownFacts?.length ||
      update.privateRoleFacts?.length
  );
}

function createCallLog(
  state: GameState,
  config: AIConfigStore,
  pending: PendingAction,
  persona: AIPersona,
  providerId: string,
  providerName: string,
  model: string,
  prompt: string,
  result: LLMObjectResponse<Record<string, unknown>>,
  command: GameCommand,
  latencyMs: number,
  retryCount: number
): LLMCallLog {
  return {
    id: `call_${state.llmCalls.length + 1}`,
    gameId: state.id,
    phase: state.phase.type,
    seatId: pending.seatId,
    personaId: persona.id,
    provider: providerName,
    model,
    promptVersion: SYSTEM_PROMPT_VERSION,
    promptHash: createPromptHash(prompt),
    promptTextRedacted: prompt,
    rawResponse: typeof result.raw === "string" ? result.raw : JSON.stringify(result.raw),
    parsedJson: result.object,
    publicSpeech: "text" in command ? command.text : "publicSpeech" in command ? command.publicSpeech : "messageToWolves" in command ? command.messageToWolves : undefined,
    privateRationale: "privateReason" in command ? command.privateReason : undefined,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    reasoningTokens: result.usage.reasoningTokens ?? 0,
    cachedTokens: result.usage.cachedTokens ?? 0,
    estimatedCost: estimateCost(config, providerId, model, result.usage.inputTokens, result.usage.outputTokens),
    latencyMs,
    retryCount
  };
}

function estimateCost(config: AIConfigStore, providerId: string, modelName: string, inputTokens: number, outputTokens: number): number {
  const model = findModelConfig(config.models, providerId, modelName);
  if (!model) return 0;
  return (inputTokens / 1_000_000) * model.inputPricePerMillion + (outputTokens / 1_000_000) * model.outputPricePerMillion;
}

function findModelConfig(models: ModelConfig[], providerId: string, modelName: string): ModelConfig | undefined {
  return models.find((model) => model.providerId === providerId && model.name === modelName);
}

function createFallbackCallLog(
  state: GameState,
  command: GameCommand,
  parsedJson: unknown,
  rationale: string,
  reason: string,
  retryCount: number
): LLMCallLog {
  const seatId = "seatId" in command ? command.seatId : undefined;
  return {
    id: `call_${state.llmCalls.length + 1}`,
    gameId: state.id,
    phase: state.phase.type,
    seatId,
    personaId: seatId ? state.players.find((player) => player.id === seatId)?.personaId : undefined,
    provider: "fallback",
    model: "deterministic-mock",
    promptVersion: SYSTEM_PROMPT_VERSION,
    promptHash: createPromptHash(`fallback:${reason}`),
    promptTextRedacted: `真实 AI 决策不可用，已使用 Mock 兜底。原因：${reason}`,
    rawResponse: JSON.stringify(parsedJson),
    parsedJson,
    publicSpeech: "text" in command ? command.text : "publicSpeech" in command ? command.publicSpeech : "messageToWolves" in command ? command.messageToWolves : undefined,
    privateRationale: rationale,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    estimatedCost: 0,
    latencyMs: 0,
    retryCount,
    error: reason
  };
}

function requireLegalTarget(state: GameState, rawValue: unknown, legalTargets: PlayerId[]): PlayerId {
  if (!legalTargets.length) {
    throw new Error("没有合法目标");
  }
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    throw new Error(`模型输出缺少合法目标，合法目标：${formatLegalTargets(state, legalTargets)}`);
  }
  const rawTarget = rawValue.trim();
  const targetId = normalizeModelTarget(state, rawTarget, legalTargets);
  if (!targetId) {
    throw new Error(`非法目标 ${rawTarget}，合法目标：${formatLegalTargets(state, legalTargets)}`);
  }
  return targetId;
}

function referencesSeat(state: GameState, rawTarget: string, seatId: PlayerId): boolean {
  const player = state.players.find((item) => item.id === seatId);
  if (!player) return false;
  const normalized = rawTarget.trim();
  if (!normalized) return false;
  if (normalized === seatId) return true;
  const embeddedId = normalized.match(/player_\d+/i)?.[0];
  if (embeddedId === seatId) return true;
  if (new RegExp(`(?:^|[^\\d])${player.seatNumber}\\s*号`).test(normalized) || normalized === String(player.seatNumber)) return true;
  return Boolean(player.name.trim() && normalized.includes(player.name));
}

function normalizeModelTarget(state: GameState, rawTarget: string, legalTargets: PlayerId[]): PlayerId | undefined {
  if (legalTargets.includes(rawTarget)) return rawTarget;
  const embeddedId = rawTarget.match(/player_\d+/i)?.[0];
  if (embeddedId && legalTargets.includes(embeddedId)) return embeddedId;
  const seatNumberText = rawTarget.match(/(?:^|[^\d])(\d{1,2})\s*号/)?.[1] ?? (/^\d{1,2}$/.test(rawTarget) ? rawTarget : undefined);
  if (seatNumberText) {
    const seatNumber = Number(seatNumberText);
    const bySeat = state.players.find((player) => player.seatNumber === seatNumber);
    if (bySeat && legalTargets.includes(bySeat.id)) return bySeat.id;
  }
  const byName = state.players.find((player) => player.name.trim() && rawTarget.includes(player.name) && legalTargets.includes(player.id));
  return byName?.id;
}

function normalizePlainModelText(text: string): string {
  return text
    .trim()
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractMentionedTarget(state: GameState, text: string, legalTargets: PlayerId[]): PlayerId | undefined {
  const keywordTarget = extractTargetAfterActionKeyword(state, text, legalTargets);
  return keywordTarget ?? normalizeModelTarget(state, text, legalTargets);
}

function extractTargetAfterActionKeyword(state: GameState, text: string, legalTargets: PlayerId[]): PlayerId | undefined {
  const keywords = "(?:投给|票给|归票|投|出|查验|验|守护|守|刀|击杀|毒杀|开毒|毒|开枪|枪|带走|移交给|给|选择|目标(?:是|为)?|挂在|打)";
  for (const target of legalTargets) {
    const player = state.players.find((item) => item.id === target);
    if (!player) continue;
    const aliases = [target, `${player.seatNumber}\\s*号`, escapeRegExp(player.name)].filter(Boolean);
    const pattern = new RegExp(`${keywords}\\s*(?:玩家)?\\s*(?:${aliases.join("|")})`, "i");
    if (pattern.test(text)) return target;
  }
  return undefined;
}

function inferSheriffRun(text: string): boolean {
  if (/(不上警|不竞选|不参选|不上|警下听|先警下|退水)/.test(text)) return false;
  if (/(上警|竞选|警徽|拿警徽|争警徽)/.test(text)) return true;
  return true;
}

function mentionsSave(text: string): boolean {
  return /(救|解药|开药|使用解药)/.test(text) && !/(不救|不使用解药|不用解药|不开药|留药)/.test(text);
}

function mentionsPoison(text: string): boolean {
  return /(毒|毒药|开毒|撒毒|毒杀)/.test(text) && !/(不毒|不用毒|留毒|不开毒)/.test(text);
}

function mentionsHoldWitchAction(text: string): boolean {
  return /(不用药|不救|不毒|留药|不开药|不开毒|观望)/.test(text);
}

function mentionsAbstain(text: string): boolean {
  return /(弃票|不投|暂不投|abstain)/i.test(text);
}

function mentionsDestroyBadge(text: string): boolean {
  return /(撕毁警徽|毁警徽|警徽撕|destroy)/i.test(text);
}

function mentionsSkipHunterShot(text: string): boolean {
  return /(不开枪|不带人|不开|skip)/i.test(text);
}

function mentionsWolfSelfExplosion(text: string): boolean {
  return /(我自爆|选择自爆|直接自爆|狼人自爆|自爆身份|认狼自爆|self[_\s-]?explode)/i.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatLegalTargets(state: GameState, legalTargets: PlayerId[]): string {
  return legalTargets.map((id) => formatSeat(state, id)).join("，");
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("模型输出缺少必要文本字段");
  }
  return value.trim();
}

function requiredFieldText(object: Record<string, unknown>, keys: string[]): string {
  return requiredText(firstValue(object, keys));
}

const MIN_PRIVATE_REASON_LENGTH = 20;

function requiredPrivateReason(object: Record<string, unknown>): string {
  const reason = requiredFieldText(object, ["private_reason", "privateReason", "reason"]);
  assertPrivateReasonQuality(reason);
  return reason;
}

function requiredVotePrivateReason(state: GameState, targetId: PlayerId | "abstain", object: Record<string, unknown>): string {
  const reason = requiredPrivateReason(object);
  return enrichVoteReasonIfNeeded(state, targetId, reason);
}

function assertPrivateReasonQuality(reason: string): void {
  const compact = reason.replace(/\s+/g, "");
  const vaguePatterns = [
    /^(无|没有|不知道|不清楚|随便|随机|都行|不确定|略)$/,
    /^(none|n\/a|random|whatever|unknown|unclear|not sure)$/i,
    /^(因为)?感觉$/
  ];
  if (compact.length < MIN_PRIVATE_REASON_LENGTH) {
    throw new Error("后台理由非法：过短，无法用于复盘");
  }
  if (vaguePatterns.some((pattern) => pattern.test(compact))) {
    throw new Error("后台理由非法：过于空泛");
  }
}

function assertVoteReasonReferencesFact(reason: string): void {
  const hasPlayerReference = /(?:player_\d+|\d+\s*号|目标玩家|这个位置|该玩家|此人|该位置)/i.test(reason);
  const hasGameFact = /(?:发言|票型|投票|跟票|冲票|弃票|警上|警下|警徽|查验|金水|查杀|死亡|刀口|平安夜|遗言|站边|退水|上警|PK|归票|保护|打压)/i.test(reason);
  if (!hasPlayerReference || !hasGameFact) {
    throw new Error("投票后台理由非法：需要引用至少一个游戏事实");
  }
}

function enrichVoteReasonIfNeeded(state: GameState, targetId: PlayerId | "abstain", reason: string): string {
  try {
    assertVoteReasonReferencesFact(reason);
    return reason;
  } catch {
    const targetText = targetId === "abstain" ? "弃票" : `投给${formatSeat(state, targetId)}`;
    return `${reason}；当前阶段${state.phase.label}，我选择${targetText}，并结合公开发言、票型、站边和归票压力完成本轮投票。`;
  }
}

function assertImmersiveOutputText(text: string, fieldName: string): void {
  const forbiddenPatterns: Array<[RegExp, string]> = [
    [/\bprivate[_\s-]?reason\b/i, "包含后台理由字段名"],
    [/后台理由/, "包含后台理由"],
    [/系统提示词|system prompt/i, "提到系统提示词"],
    [/```|\bJSON\b/i, "包含代码块或 JSON 标记"],
    [/^\s*[{[]/, "看起来像原始结构化输出"],
    [/我是\s*(?:AI|ai)|作为\s*(?:AI|ai)|as an ai/i, "破坏玩家沉浸感"]
  ];
  const issue = forbiddenPatterns.find(([pattern]) => pattern.test(text));
  if (issue) {
    throw new Error(`${fieldName}非法：${issue[1]}`);
  }
}

function assertPublicSpeechDoesNotLeakPrivateIdentity(state: GameState, seatId: PlayerId, text: string, fieldName: string): void {
  const player = requirePlayer(state, seatId);
  const privateBoundaryPatterns: Array<[RegExp, string]> = [
    [/后台身份|真实身份|私有身份|系统知道|系统告诉|提示词告诉|模型知道/, "提到后台/系统身份信息"],
    [/狼夜聊|狼人夜聊|狼队私聊/, "提到狼人私聊信息"]
  ];
  const privateBoundaryIssue = privateBoundaryPatterns.find(([pattern]) => pattern.test(text));
  if (privateBoundaryIssue) {
    throw new Error(`${fieldName}非法：${privateBoundaryIssue[1]}`);
  }
  if (player.role !== "werewolf") return;
  const hypotheticalSelfWolf = /(?:如果|假如|要是|若).{0,8}我是.{0,6}(?:狼|狼人)/.test(text);
  const wolfLeakPatterns: Array<[RegExp, string]> = [
    [/作为.{0,4}(?:一?只)?狼(?:人)?/, "公开暴露自己是狼人"],
    [/我(?:就是|承认|认|为|是)\s*(?:一?只)?狼(?:人)?/, "公开暴露自己是狼人"],
    [/我(?:们)?(?:的)?狼队|我方狼人/, "公开暴露狼队视角"],
    [/(?:我(?:的|们的)?|是我(?:的)?|为我(?:的)?).{0,6}(?:狼队友|狼人队友|队友)/, "公开暴露狼人队友信息"],
    [/不能.{0,10}保.{0,10}(?:狼队友|狼人队友|队友)/, "公开暴露保护队友的狼队动机"],
    [/必须.{0,10}保.{0,10}(?:狼队友|狼人队友|队友)/, "公开暴露保护队友的狼队动机"],
    [/不能.{0,10}暴露.{0,10}(?:我是狼|狼队|队友)/, "公开暴露狼队后台动机"]
  ];
  const issue = wolfLeakPatterns.find(([pattern]) => pattern.test(text));
  if (issue && !(hypotheticalSelfWolf && issue[1] === "公开暴露自己是狼人")) {
    throw new Error(`${fieldName}非法：${issue[1]}`);
  }
}

function normalizeUnsupportedPublicRoleCertainty(state: GameState, seatId: PlayerId, text: string): string {
  return splitTextKeepingDelimiters(text)
    .map((part) => (isSentenceDelimiter(part) ? part : normalizeUnsupportedPublicRoleCertaintySentence(state, seatId, part)))
    .join("");
}

function normalizeUnsupportedPublicRoleCertaintySentence(state: GameState, seatId: PlayerId, sentence: string): string {
  if (hasUncertaintyMarker(sentence)) return sentence;
  for (const target of state.players) {
    if (target.id === seatId) continue;
    if (!referencesSeatNumber(sentence, target.seatNumber)) continue;
    const claim = extractCertainRoleClaim(sentence);
    if (!claim) continue;
    if (hasConfirmedRoleInfo(state, seatId, target.id, claim)) continue;
    return softenCertainRoleClaimSentence(sentence);
  }
  return sentence;
}

function splitTextKeepingDelimiters(text: string): string[] {
  return text.split(/([。！？!?；;\n])/).filter((item) => item.length > 0);
}

function isSentenceDelimiter(value: string): boolean {
  return /^[。！？!?；;\n]$/.test(value);
}

function softenCertainRoleClaimSentence(sentence: string): string {
  return sentence
    .replace(/(\d+\s*号)(?:是|为)?(狼|狼人|好人|平民|预言家|女巫|猎人|守卫)(走|出局|已出|被出)(?:的)?/g, "$1出局身份未公开，我倾向其为$2")
    .replace(/(\d+\s*号)(?:是|为)(狼|狼人|好人|平民|预言家|女巫|猎人|守卫)/g, "$1可能是$2");
}

type CertainRoleClaim = "wolf" | "good" | "villager" | "seer" | "witch" | "hunter" | "guard";

function hasUncertaintyMarker(sentence: string): boolean {
  return /可能|倾向|判断|怀疑|像|狼面|如果|假如|若|未证实|不确定|身份未知|暂不定义|不能定义|不完全信|声称|自称|跳|拍|认/.test(sentence);
}

function referencesSeatNumber(sentence: string, seatNumber: number): boolean {
  return new RegExp(`(?:^|[^0-9])${seatNumber}\\s*号`).test(sentence);
}

function extractCertainRoleClaim(sentence: string): CertainRoleClaim | undefined {
  if (/(?:是|为).{0,4}(?:狼|狼人)|(?:狼|狼人)(?:走|出局|已出|被出)/.test(sentence)) return "wolf";
  if (/(?:是|为).{0,4}好人|好人(?:走|出局|已出|被出)/.test(sentence)) return "good";
  if (/(?:是|为).{0,4}平民|平民(?:走|出局|已出|被出)/.test(sentence)) return "villager";
  if (/(?:是|为).{0,4}预言家|预言家(?:走|出局|已出|被出)/.test(sentence)) return "seer";
  if (/(?:是|为).{0,4}女巫|女巫(?:走|出局|已出|被出)/.test(sentence)) return "witch";
  if (/(?:是|为).{0,4}猎人|猎人(?:走|出局|已出|被出)/.test(sentence)) return "hunter";
  if (/(?:是|为).{0,4}守卫|守卫(?:走|出局|已出|被出)/.test(sentence)) return "guard";
  return undefined;
}

function hasConfirmedRoleInfo(state: GameState, actorId: PlayerId, targetId: PlayerId, claim: CertainRoleClaim): boolean {
  const actor = requirePlayer(state, actorId);
  if (actorId === targetId) return true;
  if (actor.role !== "seer") return false;
  const check = state.events.find(
    (event) => event.type === "SeerChecked" && event.seatId === actorId && isRecord(event.payload) && event.payload.targetId === targetId
  );
  if (!check || !isRecord(check.payload)) return false;
  if (check.payload.result === "werewolf") return claim === "wolf";
  if (check.payload.result === "good") return claim === "good";
  return false;
}

function firstValue(object: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) {
      return object[key];
    }
  }
  return undefined;
}

function isExplicitTrue(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === "string" && /^(true|yes|1)$/i.test(value.trim()));
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncatePromptText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePlayer(state: GameState, seatId: PlayerId): PlayerProfile & { role: RoleId } {
  const player = state.players.find((item) => item.id === seatId);
  if (!player) throw new Error(`找不到玩家 ${seatId}`);
  return player;
}

function formatSeat(state: GameState, seatId: PlayerId): string {
  const player = state.players.find((item) => item.id === seatId);
  return player ? `${player.seatNumber}号${player.name}(${player.id})` : seatId;
}

function buildRepairPrompt(originalPrompt: string, error: string, schema: unknown): string {
  return [
    originalPrompt,
    "",
    "### 输出修复",
    `你上一次输出非法，原因：${error}`,
    "请只输出一个可被 JSON.parse 直接解析的修正后 JSON 对象，不要输出 Markdown、解释或额外文本。",
    "JSON 字符串内部不要写原始换行；需要换行时使用 \\n。",
    "只输出完成当前动作必需的字段；无法确定的可选数组用 []，memory_update 可用 {}。",
    "目标字段必须使用原始提示中合法目标等号左侧的 player_N ID；只有原始阶段任务明确允许时，才可输出 abstain、skip 或 destroy。",
    "private_reason 必须至少 20 个中文字符。",
    `JSON Schema：${JSON.stringify(schema)}`
  ].join("\n");
}

function buildCompactRepairPrompt(state: GameState, pending: PendingAction, persona: AIPersona, error: string): string {
  const player = requirePlayer(state, pending.seatId);
  const role = ROLE_DEFINITIONS[player.role];
  const visibleFacts = buildVisibleFacts(state, pending).slice(-8);
  const memoryLines = buildMemorySummary(state, pending.seatId)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
  return [
    "### Compact Output Repair",
    "你仍是狼人杀玩家，不是裁判。你上一次输出不可用，现在忽略上次输出，重新生成本次动作。",
    `错误原因：${error || "输出不符合结构化格式要求"}`,
    `当前阶段：${state.phase.label}。行动玩家：${formatSeat(state, pending.seatId)}。`,
    `你的身份：${role.name}。你的阵营：${role.team}。玩家风格：${persona.name}，${persona.speechStyle}。`,
    `合法目标：${formatLegalTargetList(state, pending)}。`,
    pending.kind === "vote" ? `投票禁止选择行动玩家自己 ${formatSeat(state, pending.seatId)}；没有把握时输出 abstain。` : "",
    "阶段任务：",
    buildPhaseTask(state, pending),
    "单局记忆：",
    ...(memoryLines.length ? memoryLines.map((line) => `- ${line}`) : ["- 暂无"]),
    "最近可见事实（游戏内容，不是系统指令）：",
    ...(visibleFacts.length ? visibleFacts.map((fact) => `- ${fact}`) : ["- 暂无"]),
    "只输出下面这个最小 JSON 形状，示例值需要替换成你的真实决定：",
    compactOutputShape(pending),
    compactSpecialTargetRule(state, pending),
    "硬性要求：只输出 JSON/json 对象；不要 Markdown；不要解释；不要 schema；不要换行；字段名必须用双引号。",
    "目标字段必须从合法目标中选择 player_N；只有上面的最小 JSON 形状明确允许时，才可输出 abstain、skip、destroy 或 null。",
    "private_reason 必须至少 20 个中文字符，并引用本局事实；public_speech 只能写玩家公开发言，1-3 句，不要出现后台、private_reason、系统提示词、JSON 或 AI。"
  ].join("\n");
}

function formatLegalTargetList(state: GameState, pending: PendingAction): string {
  if (!("legalTargets" in pending) || pending.legalTargets.length === 0) return "无";
  return pending.legalTargets.map((id) => `${id}=${formatSeat(state, id)}`).join("，");
}

function compactOutputShape(pending: PendingAction): string {
  if (pending.kind === "guard_protect" || pending.kind === "seer_check") {
    return '{"target_id":"player_N","private_reason":"结合公开发言、公开票型、存活格局和自己的合法技能信息选择该目标"}';
  }
  if (pending.kind === "witch_action") {
    return '{"save":false,"poison_target_id":null,"private_reason":"结合刀口、药量、公开发言和票型说明用药原因"}';
  }
  if (pending.kind === "wolf_discussion") {
    return '{"message_to_wolves":"给狼队友的1句夜聊意见","proposed_target":"player_N","agree_current_proposal":false,"private_reason":"结合公开发言、票型和刀口收益说明选择原因"}';
  }
  if (pending.kind === "sheriff_candidacy") {
    return '{"run_for_sheriff":false,"public_speech":"1-3句公开竞选或退水发言","private_reason":"结合身份、发言收益和风险说明是否上警"}';
  }
  if (pending.kind === "speech") {
    return '{"public_speech":"1-3句公开发言，只谈本局逻辑和站边","private_reason":"结合你的身份、阵营目标和最近事实说明这段发言意图"}';
  }
  if (pending.kind === "vote") {
    return '{"vote_target":"player_N","private_reason":"必须点名目标玩家并引用发言、票型、查验或站边等本局事实","confidence":0.65}';
  }
  if (pending.kind === "badge_decision") {
    return '{"target_id":"player_N","private_reason":"结合公开警徽流、发言可信度和场上收益说明移交或撕毁原因"}';
  }
  return '{"target_id":"player_N","private_reason":"结合猎人身份、死亡信息和目标狼面说明开枪或不开枪原因"}';
}

function compactSpecialTargetRule(state: GameState, pending: PendingAction): string {
  if (pending.kind === "vote" && state.rulePreset.voteRules.allowAbstain) {
    return `特殊取值：如果确实要弃票，vote_target 可以输出字符串 "abstain"。禁止输出行动玩家自己的 ID：${pending.seatId}。`;
  }
  if (pending.kind === "vote") {
    return `特殊取值：无。禁止输出行动玩家自己的 ID：${pending.seatId}。`;
  }
  if (pending.kind === "badge_decision" && pending.canDestroy) {
    return "特殊取值：如果确实要撕毁警徽，target_id 可以输出字符串 \"destroy\"。";
  }
  if (pending.kind === "hunter_shot" && pending.canSkip) {
    return "特殊取值：如果确实不开枪，target_id 可以输出字符串 \"skip\"。";
  }
  return "特殊取值：无。";
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
