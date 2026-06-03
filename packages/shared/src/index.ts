export type ControllerKind = "human" | "ai" | "mock" | "remote";

export type RoleId = "werewolf" | "villager" | "seer" | "witch" | "hunter" | "guard";

export type Team = "wolves" | "good";

export type WinCondition = "slay_side" | "slay_all_good";

export type PlayerId = string;

export interface RoleDefinition {
  id: RoleId;
  name: string;
  team: Team;
  category: "werewolf" | "villager" | "god";
  icon: string;
  publicDescription: string;
  privateDescription: string;
}

export const ROLE_DEFINITIONS: Record<RoleId, RoleDefinition> = {
  werewolf: {
    id: "werewolf",
    name: "狼人",
    team: "wolves",
    category: "werewolf",
    icon: "moon",
    publicDescription: "夜晚与狼人阵营协商并击杀一名玩家。",
    privateDescription: "知道狼人队友，可以伪装、倒钩、冲票，目标是屠边获胜。"
  },
  villager: {
    id: "villager",
    name: "平民",
    team: "good",
    category: "villager",
    icon: "user",
    publicDescription: "没有夜间技能，通过发言和投票帮助好人阵营。",
    privateDescription: "没有额外信息，依靠公开发言、投票和死亡信息推理。"
  },
  seer: {
    id: "seer",
    name: "预言家",
    team: "good",
    category: "god",
    icon: "eye",
    publicDescription: "每晚查验一名玩家属于狼人阵营还是好人阵营。",
    privateDescription: "需要规划警徽流，决定是否起跳并保护关键查验信息。"
  },
  witch: {
    id: "witch",
    name: "女巫",
    team: "good",
    category: "god",
    icon: "flask",
    publicDescription: "拥有一瓶解药和一瓶毒药，每瓶只能使用一次。",
    privateDescription: "每晚看到狼人刀口，默认同晚不能同时使用解药和毒药。"
  },
  hunter: {
    id: "hunter",
    name: "猎人",
    team: "good",
    category: "god",
    icon: "crosshair",
    publicDescription: "死亡时通常可以开枪带走一名玩家。",
    privateDescription: "被女巫毒死时默认不能开枪；关键轮次可用身份压制狼坑。"
  },
  guard: {
    id: "guard",
    name: "守卫",
    team: "good",
    category: "god",
    icon: "shield",
    publicDescription: "每晚守护一名玩家，使其免受狼人击杀。",
    privateDescription: "需要避开连续机械守护，默认守救同目标不导致死亡。"
  }
};

export type NightStep =
  | "guard_protect"
  | "wolf_discussion"
  | "seer_check"
  | "witch_action"
  | "resolve_deaths";

export interface VoteRules {
  allowAbstain: boolean;
  sheriffVoteWeight: number;
  secondTiePolicy: "no_exile" | "random";
}

export interface WitchRules {
  allowSelfSaveFirstNight: boolean;
  allowSaveAndPoisonSameNight: boolean;
  guardSaveSameTargetDies: boolean;
  poisonedHunterCanShoot: boolean;
}

export interface RulePreset {
  id: string;
  name: string;
  minPlayers: number;
  maxPlayers: number;
  roleAllocator: "table" | "formula" | "custom";
  roleTable: Record<number, RoleId[]>;
  enabledRoles: RoleId[];
  sheriffEnabled: boolean;
  winCondition: WinCondition;
  nightOrder: NightStep[];
  voteRules: VoteRules;
  witchRules: WitchRules;
}

export const STANDARD_PRESET: RulePreset = {
  id: "standard-progressive",
  name: "标准渐进预女猎守",
  minPlayers: 6,
  maxPlayers: 12,
  roleAllocator: "table",
  roleTable: {
    6: ["werewolf", "werewolf", "seer", "witch", "villager", "villager"],
    7: ["werewolf", "werewolf", "seer", "witch", "hunter", "villager", "villager"],
    8: ["werewolf", "werewolf", "werewolf", "seer", "witch", "hunter", "villager", "villager"],
    9: ["werewolf", "werewolf", "werewolf", "seer", "witch", "hunter", "villager", "villager", "villager"],
    10: [
      "werewolf",
      "werewolf",
      "werewolf",
      "seer",
      "witch",
      "hunter",
      "guard",
      "villager",
      "villager",
      "villager"
    ],
    11: [
      "werewolf",
      "werewolf",
      "werewolf",
      "seer",
      "witch",
      "hunter",
      "guard",
      "villager",
      "villager",
      "villager",
      "villager"
    ],
    12: [
      "werewolf",
      "werewolf",
      "werewolf",
      "werewolf",
      "seer",
      "witch",
      "hunter",
      "guard",
      "villager",
      "villager",
      "villager",
      "villager"
    ]
  },
  enabledRoles: ["werewolf", "seer", "witch", "hunter", "guard", "villager"],
  sheriffEnabled: true,
  winCondition: "slay_side",
  nightOrder: ["guard_protect", "wolf_discussion", "seer_check", "witch_action", "resolve_deaths"],
  voteRules: {
    allowAbstain: true,
    sheriffVoteWeight: 1.5,
    secondTiePolicy: "no_exile"
  },
  witchRules: {
    allowSelfSaveFirstNight: true,
    allowSaveAndPoisonSameNight: false,
    guardSaveSameTargetDies: false,
    poisonedHunterCanShoot: false
  }
};

export interface DebugMode {
  revealRoles: boolean;
  revealPrompts: boolean;
  revealPrivateRationales: boolean;
  revealWolfChat: boolean;
  revealNightActions: boolean;
  allowManualOverride: boolean;
  deterministicSeed: boolean;
}

export interface GameSetup {
  totalPlayers: number;
  humanPlayers: number;
  aiPlayers: number;
  seed: string;
  rulePresetId: string;
  debugMode: DebugMode;
}

export interface PlayerProfile {
  id: PlayerId;
  seatNumber: number;
  name: string;
  avatar: string;
  controller: ControllerKind;
  personaId?: string;
}

export interface GameEvent<TPayload = Record<string, unknown>> {
  id: string;
  gameId: string;
  seq: number;
  type: string;
  visibility: "public" | "private" | "admin";
  seatId?: PlayerId;
  payload: TPayload;
  createdAt: string;
}

export interface LLMCallLog {
  id: string;
  gameId: string;
  phase: string;
  seatId?: PlayerId;
  personaId?: string;
  provider: string;
  model: string;
  promptVersion: string;
  promptHash: string;
  promptTextRedacted: string;
  rawResponse: string;
  parsedJson: unknown;
  publicSpeech?: string;
  privateRationale?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  estimatedCost: number;
  latencyMs: number;
  retryCount: number;
  promptCompressionLevel?: "FULL" | "COMPACT" | "OVERFLOW_FALLBACK";
  estimatedInputTokens?: number;
  promptBudgetTokens?: number;
  promptPreviewTruncated?: boolean;
  error?: string;
}

export type ProviderType =
  | "openai"
  | "openai_compatible"
  | "anthropic"
  | "gemini"
  | "xai"
  | "codex_cli_local";

export interface ProviderAccount {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKeyEncrypted?: string;
  authType: "api_key" | "oauth" | "access_token";
  enabled: boolean;
  rateLimit: {
    rpm: number;
    tpm: number;
    concurrency: number;
  };
  timeoutMs: number;
  retryCount: number;
  defaultModel: string;
  supportsJsonSchema: boolean;
  supportsToolCall: boolean;
  supportsStreaming: boolean;
  supportsReasoningEffort: boolean;
  supportsModelList: boolean;
}

export interface ModelConfig {
  id: string;
  providerId: string;
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  supportsStructuredOutput: boolean;
  supportsReasoningEffort: boolean;
  supportsCachedTokens: boolean;
  enabled: boolean;
  notes: string;
}

export type ReasoningStrength = "fast" | "normal" | "deep";
export type SpeechLength = "short" | "medium" | "long";
export type SpeechStyle = "冷静" | "激进" | "幽默" | "老玩家" | "新手" | "阴阳怪气" | "简洁";

export interface AIPersona {
  id: string;
  name: string;
  avatar: string;
  personality: string;
  speechStyle: SpeechStyle;
  reasoningStrength: ReasoningStrength;
  aggression: number;
  conservatism: number;
  riskTolerance: number;
  deceptionSkill: number;
  bussingTendency: number;
  claimTendency: number;
  voteIndependence: number;
  speechLength: SpeechLength;
  catchphrase: string;
  customPrompt: string;
  defaultProviderId: string;
  defaultModel: string;
  contextLimit: number;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  reasoningEffort: "minimal" | "low" | "medium" | "high";
  allowRandomSelection: boolean;
  weight: number;
}

export interface CostControls {
  enabled: boolean;
  maxGameCost: number;
  maxSeatCost: number;
  maxOutputTokensPerCall: number;
}

export interface ContextCompressionConfig {
  enabled: boolean;
  mode: "auto" | "full_only";
}

export interface AIConfigStore {
  providers: ProviderAccount[];
  models: ModelConfig[];
  personas: AIPersona[];
  costControls?: CostControls;
  contextCompression?: ContextCompressionConfig;
}

export interface AIReadinessItem {
  label: string;
  detail: string;
  ok: boolean;
}

export interface AIReadinessReport {
  ready: boolean;
  items: AIReadinessItem[];
}

export const DEFAULT_DEBUG_MODE: DebugMode = {
  revealRoles: true,
  revealPrompts: true,
  revealPrivateRationales: true,
  revealWolfChat: true,
  revealNightActions: true,
  allowManualOverride: true,
  deterministicSeed: true
};

export const DEFAULT_PERSONAS: AIPersona[] = [
  {
    id: "persona-calm",
    name: "冷静盘逻辑",
    avatar: "青",
    personality: "偏理性，优先引用事实和投票线。",
    speechStyle: "冷静",
    reasoningStrength: "normal",
    aggression: 42,
    conservatism: 68,
    riskTolerance: 38,
    deceptionSkill: 55,
    bussingTendency: 45,
    claimTendency: 35,
    voteIndependence: 76,
    speechLength: "medium",
    catchphrase: "我先按信息量来盘。",
    customPrompt: "",
    defaultProviderId: "mock-provider",
    defaultModel: "deterministic-mock",
    contextLimit: 16000,
    temperature: 0.4,
    topP: 0.9,
    maxOutputTokens: 600,
    reasoningEffort: "medium",
    allowRandomSelection: true,
    weight: 3
  },
  {
    id: "persona-pressure",
    name: "高压进攻",
    avatar: "锋",
    personality: "发言直接，喜欢点名压迫和归票。",
    speechStyle: "激进",
    reasoningStrength: "normal",
    aggression: 82,
    conservatism: 28,
    riskTolerance: 71,
    deceptionSkill: 72,
    bussingTendency: 62,
    claimTendency: 58,
    voteIndependence: 54,
    speechLength: "medium",
    catchphrase: "这个位置必须交身份压力。",
    customPrompt: "",
    defaultProviderId: "mock-provider",
    defaultModel: "deterministic-mock",
    contextLimit: 16000,
    temperature: 0.55,
    topP: 0.95,
    maxOutputTokens: 700,
    reasoningEffort: "medium",
    allowRandomSelection: true,
    weight: 2
  },
  {
    id: "persona-brief",
    name: "简洁跟线",
    avatar: "简",
    personality: "少说废话，偏跟随强逻辑位但会保留自己的票型。",
    speechStyle: "简洁",
    reasoningStrength: "fast",
    aggression: 36,
    conservatism: 74,
    riskTolerance: 30,
    deceptionSkill: 48,
    bussingTendency: 34,
    claimTendency: 22,
    voteIndependence: 45,
    speechLength: "short",
    catchphrase: "我先跟这条线。",
    customPrompt: "",
    defaultProviderId: "mock-provider",
    defaultModel: "deterministic-mock",
    contextLimit: 12000,
    temperature: 0.35,
    topP: 0.9,
    maxOutputTokens: 400,
    reasoningEffort: "low",
    allowRandomSelection: true,
    weight: 2
  }
];

export const DEFAULT_COST_CONTROLS: CostControls = {
  enabled: true,
  maxGameCost: 1,
  maxSeatCost: 0.25,
  maxOutputTokensPerCall: 1200
};

export const DEFAULT_CONTEXT_COMPRESSION: ContextCompressionConfig = {
  enabled: true,
  mode: "auto"
};

export const DEFAULT_AI_CONFIG: AIConfigStore = {
  providers: [
    {
      id: "mock-provider",
      name: "Mock AI",
      type: "openai_compatible",
      baseUrl: "mock://local",
      authType: "api_key",
      enabled: true,
      rateLimit: { rpm: 9999, tpm: 999999, concurrency: 12 },
      timeoutMs: 0,
      retryCount: 1,
      defaultModel: "deterministic-mock",
      supportsJsonSchema: true,
      supportsToolCall: false,
      supportsStreaming: false,
      supportsReasoningEffort: false,
      supportsModelList: false
    }
  ],
  models: [
    {
      id: "model-mock",
      providerId: "mock-provider",
      name: "deterministic-mock",
      displayName: "Deterministic Mock",
      contextWindow: 32000,
      maxOutputTokens: 800,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      supportsStructuredOutput: true,
      supportsReasoningEffort: false,
      supportsCachedTokens: false,
      enabled: true,
      notes: "本地测试用，不调用真实模型。"
    }
  ],
  personas: DEFAULT_PERSONAS,
  costControls: DEFAULT_COST_CONTROLS,
  contextCompression: DEFAULT_CONTEXT_COMPRESSION
};

export function buildAIReadiness(config: AIConfigStore): AIReadinessReport {
  const realProviders = config.providers.filter((provider) => provider.enabled && !provider.baseUrl.startsWith("mock://") && provider.type !== "codex_cli_local");
  const providerIds = new Set(realProviders.map((provider) => provider.id));
  const randomPersonas = config.personas.filter((persona) => persona.allowRandomSelection && persona.weight > 0);
  const realPersonas = randomPersonas.filter((persona) => providerIds.has(persona.defaultProviderId));
  const personaModels = realPersonas.map((persona) => `${persona.defaultProviderId}:${persona.defaultModel}`);
  const modelKeys = new Set(config.models.filter((model) => model.enabled).map((model) => `${model.providerId}:${model.name}`));
  const missingModelCount = personaModels.filter((key) => !modelKeys.has(key)).length;
  const realProviderWithSecret = realProviders.filter((provider) => Boolean(provider.apiKeyEncrypted?.trim()));
  const schemaProviderCount = realProviders.filter((provider) => provider.supportsJsonSchema).length;
  const controls = config.costControls ?? DEFAULT_COST_CONTROLS;
  const items: AIReadinessItem[] = [
    {
      label: "启用真实供应商",
      ok: realProviders.length > 0,
      detail: realProviders.length > 0 ? `已启用 ${realProviders.length} 个非 Mock 供应商。` : "至少启用一个 OpenAI、OpenAI Compatible、Anthropic、Gemini 或 xAI 供应商。"
    },
    {
      label: "本机密钥可用",
      ok: realProviders.length > 0 && realProviderWithSecret.length === realProviders.length,
      detail:
        realProviders.length === 0
          ? "还没有可检查的真实供应商。"
          : realProviderWithSecret.length === realProviders.length
            ? "所有启用的真实供应商都有本机 API Key / Access Token。"
            : `${realProviders.length - realProviderWithSecret.length} 个启用供应商还缺本机 API Key / Access Token。`
    },
    {
      label: "随机角色卡指向真实供应商",
      ok: realPersonas.length > 0,
      detail:
        realPersonas.length > 0
          ? `${realPersonas.length}/${Math.max(1, randomPersonas.length)} 个可随机角色卡会使用真实供应商。`
          : "点击“应用首个真实供应商”或手动为 AI 角色卡选择真实供应商。"
    },
    {
      label: "模型管理记录",
      ok: realPersonas.length > 0 && missingModelCount === 0,
      detail:
        realPersonas.length === 0
          ? "角色卡还未指向真实模型。"
          : missingModelCount === 0
            ? "角色卡使用的真实模型已在模型管理中启用。"
            : `${missingModelCount} 个角色卡模型缺少启用的模型管理记录，费用估算可能不完整。`
    },
    {
      label: "结构化输出策略",
      ok: realProviders.length > 0,
      detail:
        schemaProviderCount > 0
          ? `${schemaProviderCount} 个真实供应商声明支持 JSON Schema。`
          : "未声明 JSON Schema 时会使用 prompt 约束 JSON 输出，适合 DeepSeek 等 OpenAI-compatible 供应商。"
    },
    {
      label: "成本保护",
      ok: controls.enabled && controls.maxOutputTokensPerCall > 0 && controls.maxGameCost > 0 && controls.maxSeatCost > 0,
      detail: controls.enabled ? "已启用单局、单 AI 和单次输出限制。" : "建议开启成本保护，避免真实模型自动跑局时失控。"
    }
  ];
  return { ready: items.every((item) => item.ok), items };
}

export function createPromptHash(prompt: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < prompt.length; index += 1) {
    hash ^= prompt.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
