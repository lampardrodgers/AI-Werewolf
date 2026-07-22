import {
  Award,
  Bot,
  Dices,
  Download,
  Eye,
  FileJson,
  FileText,
  Moon,
  Pause,
  Play,
  Plus,
  Save,
  Settings,
  Shield,
  Skull,
  StepForward,
  Sun,
  Upload,
  Vote
} from "lucide-react";
import { type CSSProperties, type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentMemoryUpdate,
  GameCommand,
  GameState,
  MockBatchRunResult,
  PendingAction,
  applyCommand,
  applyAgentMemoryUpdate,
  applyMockStep,
  canWolfSelfExplode,
  createSnapshotFixture,
  createGame,
  generateMarkdownLog,
  getVisibleEvents,
  restoreSnapshotFixture,
  runMockBatch
} from "@langrensha/engine";
import {
  AIConfigStore,
  AIPersona,
  ContextCompressionConfig,
  DEFAULT_AI_CONFIG,
  DEFAULT_CONTEXT_COMPRESSION,
  DEFAULT_COST_CONTROLS,
  DEFAULT_DEBUG_MODE,
  DEFAULT_PERSONAS,
  GameSetup,
  LLMCallLog,
  ModelConfig,
  PlayerId,
  ProviderAccount,
  ProviderType,
  ROLE_DEFINITIONS,
  ReasoningEffort,
  RoleId,
  STANDARD_PRESET,
  ThinkingMode
} from "@langrensha/shared";
import { AIDecisionStatus, cancelAIDecision, loadAIConfig, loadAIDecisionStatus, requestAIDecision, saveAIConfig, testProvider } from "./api";
import { ActiveAIDecisionRequests, isCurrentAIStatus } from "./aiRequestLifecycle";
import {
  assertSingleBrowserGame,
  clearStoredGameSession,
  loadStoredGameSession,
  normalizeSingleBrowserHumanPlayers,
  saveStoredGameSession
} from "./gameSession";

type AppScreen = "setup" | "game" | "admin";
type AdminSection = "overview" | "ai" | "roles" | "logs";
type GameSideTab = "chat" | "votes" | "exposure" | "records" | "rules";
type LocalProviderApiKeys = Record<string, string>;
type ProviderTestState = "testing" | "success" | "failed";
type ProviderTestResults = Record<string, ProviderTestState>;
type ReadableOutputPause = {
  seatId: PlayerId;
  phaseLabel: string;
  publicText: string;
  outputLabel?: string;
  progressLabel?: string;
  doneLabel?: string;
};
type AIDecisionResult = Awaited<ReturnType<typeof requestAIDecision>>;
type ParallelAIDecisionResult = {
  pending: PendingAction;
  requestId: string;
  result?: AIDecisionResult;
  error?: string;
};

const AUTO_STEP_DELAY_MS = 700;
const LOCAL_PROVIDER_KEYS_STORAGE_KEY = "langrensha.localProviderApiKeys.v1";
const LOCAL_SECRET_SENTINEL = "__local_browser__";
const PRIVATE_NIGHT_PHASES = new Set<GameState["phase"]["type"]>(["night_guard", "night_wolves", "night_seer", "night_witch"]);
const PRIVATE_NIGHT_ACTIONS = new Set<PendingAction["kind"]>(["guard_protect", "seer_check", "witch_action", "wolf_discussion"]);

function contextCompressionFromToggle(checked: boolean): ContextCompressionConfig {
  return checked ? { ...DEFAULT_CONTEXT_COMPRESSION } : { enabled: false, mode: "full_only" };
}

function isContextCompressionAuto(config?: ContextCompressionConfig): boolean {
  const current = config ?? DEFAULT_CONTEXT_COMPRESSION;
  return current.enabled && current.mode === "auto";
}

const SEED_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANDOM_SEED_LENGTH = 16;

function createRandomSeed(): string {
  const alphabetSize = SEED_ALPHABET.length;
  const unbiasedLimit = Math.floor(256 / alphabetSize) * alphabetSize;
  let value = "";

  while (value.length < RANDOM_SEED_LENGTH) {
    const bytes = new Uint8Array(RANDOM_SEED_LENGTH - value.length);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }

    for (const byte of bytes) {
      if (byte >= unbiasedLimit) {
        continue;
      }
      value += SEED_ALPHABET[byte % alphabetSize];
      if (value.length >= RANDOM_SEED_LENGTH) {
        break;
      }
    }
  }

  return `langrensha-${value}`;
}

function createDefaultSetup(): GameSetup {
  return {
    totalPlayers: 8,
    humanPlayers: 1,
    aiPlayers: 7,
    seed: createRandomSeed(),
    rulePresetId: STANDARD_PRESET.id,
    debugMode: {
      ...DEFAULT_DEBUG_MODE,
      revealRoles: false,
      revealPrompts: false,
      revealPrivateRationales: false,
      revealWolfChat: false,
      revealNightActions: false
    }
  };
}

const ROLE_PICKER_ORDER: RoleId[] = ["werewolf", "seer", "witch", "hunter", "guard", "villager"];

function defaultRolesForTotal(totalPlayers: number): RoleId[] {
  return [...(STANDARD_PRESET.roleTable[totalPlayers] ?? STANDARD_PRESET.roleTable[8])];
}

function normalizeRoleOverrides(totalPlayers: number, roles?: RoleId[]): RoleId[] {
  const defaults = defaultRolesForTotal(totalPlayers);
  return Array.from({ length: totalPlayers }, (_, index) => roles?.[index] ?? defaults[index] ?? "villager");
}

function normalizeSetupForGame(setup: GameSetup): GameSetup {
  const totalPlayers = clampNumber(setup.totalPlayers, STANDARD_PRESET.minPlayers, STANDARD_PRESET.maxPlayers);
  const humanPlayers = normalizeSingleBrowserHumanPlayers(setup.humanPlayers);
  const roleOverrides = setup.roleOverrides ? normalizeRoleOverrides(totalPlayers, setup.roleOverrides) : undefined;
  return {
    ...setup,
    totalPlayers,
    humanPlayers,
    aiPlayers: totalPlayers - humanPlayers,
    seed: setup.seed.trim() || createRandomSeed(),
    roleOverrides
  };
}

const PROVIDER_PRESETS: Record<ProviderType, Omit<ProviderAccount, "id" | "apiKeyEncrypted">> = {
  openai: {
    name: "OpenAI",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    authType: "api_key",
    enabled: true,
    rateLimit: { rpm: 60, tpm: 120000, concurrency: 3 },
    timeoutMs: 0,
    retryCount: 1,
    defaultModel: "model-name",
    supportsJsonSchema: true,
    supportsToolCall: true,
    supportsStreaming: true,
    supportsReasoningEffort: true,
    supportsModelList: true,
    reasoningEffort: "medium",
    thinkingMode: "auto"
  },
  openai_compatible: {
    name: "OpenAI Compatible",
    type: "openai_compatible",
    baseUrl: "https://api.example.com/v1",
    authType: "api_key",
    enabled: true,
    rateLimit: { rpm: 60, tpm: 120000, concurrency: 3 },
    timeoutMs: 0,
    retryCount: 1,
    defaultModel: "model-name",
    supportsJsonSchema: true,
    supportsToolCall: false,
    supportsStreaming: false,
    supportsReasoningEffort: false,
    supportsModelList: true,
    reasoningEffort: "medium",
    thinkingMode: "disabled"
  },
  anthropic: {
    name: "Anthropic",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    authType: "api_key",
    enabled: true,
    rateLimit: { rpm: 60, tpm: 120000, concurrency: 3 },
    timeoutMs: 0,
    retryCount: 1,
    defaultModel: "model-name",
    supportsJsonSchema: false,
    supportsToolCall: true,
    supportsStreaming: true,
    supportsReasoningEffort: false,
    supportsModelList: true,
    reasoningEffort: "medium",
    thinkingMode: "auto"
  },
  gemini: {
    name: "Gemini",
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    authType: "api_key",
    enabled: true,
    rateLimit: { rpm: 60, tpm: 120000, concurrency: 3 },
    timeoutMs: 0,
    retryCount: 1,
    defaultModel: "model-name",
    supportsJsonSchema: true,
    supportsToolCall: true,
    supportsStreaming: true,
    supportsReasoningEffort: false,
    supportsModelList: true,
    reasoningEffort: "medium",
    thinkingMode: "auto"
  },
  xai: {
    name: "xAI",
    type: "xai",
    baseUrl: "https://api.x.ai/v1",
    authType: "api_key",
    enabled: true,
    rateLimit: { rpm: 60, tpm: 120000, concurrency: 3 },
    timeoutMs: 0,
    retryCount: 1,
    defaultModel: "model-name",
    supportsJsonSchema: true,
    supportsToolCall: true,
    supportsStreaming: true,
    supportsReasoningEffort: false,
    supportsModelList: true,
    reasoningEffort: "medium",
    thinkingMode: "auto"
  },
  codex_cli_local: {
    name: "Codex Local",
    type: "codex_cli_local",
    baseUrl: "mock://codex-cli-local",
    authType: "oauth",
    enabled: false,
    rateLimit: { rpm: 10, tpm: 50000, concurrency: 1 },
    timeoutMs: 0,
    retryCount: 0,
    defaultModel: "codex-cli-local",
    supportsJsonSchema: false,
    supportsToolCall: false,
    supportsStreaming: false,
    supportsReasoningEffort: false,
    supportsModelList: false,
    reasoningEffort: "medium",
    thinkingMode: "disabled"
  }
};

const REASONING_EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "minimal", label: "minimal" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "max", label: "max" }
];

const DEEPSEEK_REASONING_EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "high", label: "high" },
  { value: "max", label: "max" }
];

const THINKING_MODE_OPTIONS: Array<{ value: ThinkingMode; label: string }> = [
  { value: "auto", label: "auto" },
  { value: "enabled", label: "enabled" },
  { value: "disabled", label: "disabled" },
];

export function App(): JSX.Element {
  const [initialSession] = useState(() => (typeof window === "undefined" ? { hasStoredSession: false } : loadStoredGameSession(window.localStorage)));
  const restoredGame = initialSession.game ?? null;
  const [setup, setSetup] = useState<GameSetup>(() => restoredGame?.setup ?? createDefaultSetup());
  const [game, setGame] = useState<GameState | null>(() => restoredGame);
  const [autoRun, setAutoRun] = useState(false);
  const [isPaused, setIsPaused] = useState(Boolean(restoredGame?.status === "running"));
  const [screen, setScreen] = useState<AppScreen>(restoredGame ? "game" : "setup");
  const [tab, setTab] = useState<GameSideTab>("chat");
  const [adminSection, setAdminSection] = useState<AdminSection>("ai");
  const [speechText, setSpeechText] = useState("");
  const [selectedTarget, setSelectedTarget] = useState<PlayerId | "abstain" | "skip" | "destroy">("abstain");
  const [witchSave, setWitchSave] = useState(false);
  const [witchPoisonTarget, setWitchPoisonTarget] = useState<PlayerId | "skip">("skip");
  const [wolfAgree, setWolfAgree] = useState(true);
  const [sheriffRun, setSheriffRun] = useState(false);
  const [config, setConfig] = useState<AIConfigStore>(DEFAULT_AI_CONFIG);
  const [gameContextCompression, setGameContextCompression] = useState<ContextCompressionConfig | undefined>(initialSession.gameContextCompression);
  const [configStatus, setConfigStatus] = useState("配置尚未保存");
  const [providerTestStatus, setProviderTestStatus] = useState("");
  const [providerTestResults, setProviderTestResults] = useState<ProviderTestResults>({});
  const [providerApiKeys, setProviderApiKeys] = useState<LocalProviderApiKeys>(() => loadLocalProviderApiKeys());
  const [aiMode, setAiMode] = useState<"mock" | "llm">(initialSession.aiMode ?? "llm");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiElapsedSeconds, setAiElapsedSeconds] = useState(0);
  const [aiProgress, setAiProgress] = useState<AIDecisionStatus | null>(null);
  const [aiStepStatus, setAiStepStatus] = useState(
    restoredGame ? (restoredGame.status === "ended" ? "已从本机恢复已结束的对局。" : "已从本机恢复对局，当前保持暂停；点击继续后恢复自动流程。") : "等待玩家行动。"
  );
  const [streamingSpeech, setStreamingSpeech] = useState("");
  const [readableOutputPause, setReadableOutputPause] = useState<ReadableOutputPause | null>(null);
  const [batchResult, setBatchResult] = useState<MockBatchRunResult | null>(null);
  const [debugStatus, setDebugStatus] = useState(restoredGame ? `已从本机恢复对局：${restoredGame.id}` : "");
  const [sessionRecoveryError, setSessionRecoveryError] = useState(initialSession.error ?? "");
  const streamingTimerRef = useRef<number | undefined>();
  const aiInFlightRef = useRef<string | null>(null);
  const aiRequestEpochRef = useRef(0);
  const activeAIRequestsRef = useRef(new ActiveAIDecisionRequests());
  const gameRef = useRef<GameState | null>(restoredGame);
  const sessionPreferencesRef = useRef({ aiMode, gameContextCompression });
  sessionPreferencesRef.current = { aiMode, gameContextCompression };

  const humanPlayerId = useMemo(() => game?.players.find((player) => player.controller === "human")?.id, [game]);
  const publicGame = useMemo(() => (game ? toPublicViewState(game) : null), [game]);
  const visibleEvents = useMemo(() => (publicGame ? getVisibleEvents(publicGame, humanPlayerId) : []), [publicGame, humanPlayerId]);
  const humanPending = useMemo(() => {
    if (!game) return undefined;
    return game.pendingActions.find((action) => game.players.find((player) => player.id === action.seatId)?.controller === "human");
  }, [game]);
  const automatablePending = useMemo(() => {
    if (!game) return false;
    return game.pendingActions.some((action) => game.players.find((player) => player.id === action.seatId)?.controller !== "human");
  }, [game]);
  const canHumanSelfExplode = useMemo(() => Boolean(game && humanPlayerId && canWolfSelfExplode(game, humanPlayerId)), [game, humanPlayerId]);
  const configWithLocalSecretStatus = useMemo(() => markLocalProviderSecretStatus(config, providerApiKeys), [config, providerApiKeys]);
  const effectiveContextCompression = gameContextCompression ?? config.contextCompression ?? DEFAULT_CONTEXT_COMPRESSION;

  useEffect(() => {
    loadAIConfig()
      .then((loaded) => {
        setConfig(
          stripProviderSecrets({
            ...loaded,
            costControls: loaded.costControls ?? DEFAULT_COST_CONTROLS,
            contextCompression: loaded.contextCompression ?? DEFAULT_CONTEXT_COMPRESSION
          })
        );
        setConfigStatus("已从后端读取配置");
      })
      .catch((error) => setConfigStatus(error instanceof Error ? error.message : "读取配置失败"));
  }, []);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    if (!game || typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      try {
        saveStoredGameSession(window.localStorage, game, { aiMode, gameContextCompression });
      } catch (error) {
        setDebugStatus(error instanceof Error ? `自动保存失败：${error.message}。当前对局仍可继续。` : "自动保存失败，当前对局仍可继续。");
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [aiMode, game, gameContextCompression]);

  useEffect(() => {
    function handlePageHide(): void {
      if (gameRef.current) {
        try {
          saveStoredGameSession(window.localStorage, gameRef.current, sessionPreferencesRef.current);
        } catch {
          // 页面离开时无法可靠展示错误；运行期间的自动保存会提供可见提示。
        }
      }
      invalidateAIRequests();
      setAiBusy(false);
      setAutoRun(false);
      setIsPaused(true);
    }
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, []);

  function commitGame(next: GameState | null): void {
    gameRef.current = next;
    setGame(next);
  }

  function invalidateAIRequests(): void {
    aiRequestEpochRef.current += 1;
    activeAIRequestsRef.current.cancelAll(cancelAIDecision);
    aiInFlightRef.current = null;
  }

  useEffect(() => {
    if (!autoRun || isPaused || !game || game.status === "ended") return undefined;
    if (!automatablePending) return undefined;
    if (aiBusy) return undefined;
    const timer = window.setTimeout(() => {
      void stepAI();
    }, AUTO_STEP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [autoRun, automatablePending, game, aiBusy, aiMode, isPaused]);

  useEffect(() => {
    return () => {
      aiRequestEpochRef.current += 1;
      activeAIRequestsRef.current.cancelAll(cancelAIDecision);
      if (streamingTimerRef.current !== undefined) {
        window.clearInterval(streamingTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!aiBusy) {
      setAiElapsedSeconds(0);
      return undefined;
    }
    const startedAt = Date.now();
    setAiElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setAiElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [aiBusy]);

  useEffect(() => {
    if (!humanPending) return;
    const legal = legalTargetsFor(humanPending);
    setSelectedTarget(defaultTargetFor(humanPending, legal, game?.rulePreset.voteRules.allowAbstain ?? true));
    setSpeechText(defaultSpeechFor(humanPending));
    setWitchSave(false);
    setWitchPoisonTarget("skip");
    setSheriffRun(humanPending.kind === "sheriff_withdrawal");
    setWolfAgree(true);
  }, [game?.rulePreset.voteRules.allowAbstain, humanPending?.kind, humanPending?.seatId, humanPending && "round" in humanPending ? humanPending.round : undefined]);

  function startGame(): void {
    invalidateAIRequests();
    const normalized = normalizeSetupForGame(setup);
    setSetup(normalized);
    commitGame(assignPersonasToAISeats(createGame(normalized), config.personas, normalized.seed));
    setBatchResult(null);
    setIsPaused(false);
    setAutoRun(true);
    clearStreamingOutput();
    setReadableOutputPause(null);
    setAiProgress(null);
    setGameContextCompression(undefined);
    setSessionRecoveryError("");
    setTab("chat");
    setScreen("game");
  }

  function restartGame(): void {
    invalidateAIRequests();
    setAiBusy(false);
    setIsPaused(false);
    setAutoRun(true);
    const normalized = normalizeSetupForGame(setup);
    commitGame(assignPersonasToAISeats(createGame(normalized), config.personas, normalized.seed));
    clearStreamingOutput();
    setReadableOutputPause(null);
    setAiProgress(null);
    setGameContextCompression(undefined);
    setBatchResult(null);
    setTab("chat");
    setScreen("game");
  }

  async function stepAI(): Promise<void> {
    if (!game || game.status === "ended" || aiBusy || aiInFlightRef.current) return;
    const parallelPending = parallelAIPendingActions(game);
    if (parallelPending.length >= 2) {
      await stepAIParallel(parallelPending);
      return;
    }
    const pending = game.pendingActions.find((action) => game.players.find((player) => player.id === action.seatId)?.controller !== "human");
    if (!pending) {
      setAiStepStatus("当前没有 AI 待处理动作。");
      return;
    }
    const actionKey = aiPendingKey(game, pending);
    aiInFlightRef.current = actionKey;
    if (aiMode === "mock") {
      try {
        const next = applyMockStep(game);
        commitGame(next);
        setAiStepStatus(`${seatName(game, pending.seatId)} 已完成 ${pendingLabel(pending)}。`);
        clearStreamingOutput();
        const publicText = officialOutputForPending(next, pending, humanPlayerId);
        if (publicText) streamOfficialOutput(publicText);
        if (!pauseAfterReadableAIOutput(pending, undefined, publicText, next, game.phase.label)) {
          pauseAfterTransitionEvents(game, next, game.phase.label);
        }
      } finally {
        window.setTimeout(() => {
          if (aiInFlightRef.current === actionKey) aiInFlightRef.current = null;
        }, 0);
      }
      return;
    }

    const pendingPlayer = game.players.find((player) => player.id === pending.seatId);
    const persona = config.personas.find((item) => item.id === pendingPlayer?.personaId) ?? config.personas[0] ?? DEFAULT_PERSONAS[0];
    const provider = config.providers.find((item) => item.id === persona.defaultProviderId && item.enabled);
    if (provider && !provider.baseUrl.startsWith("mock://") && !providerApiKeys[provider.id]?.trim()) {
      aiInFlightRef.current = null;
      setAutoRun(false);
      setIsPaused(true);
      setAiStepStatus(`${provider.name} 缺少本机 API Key / Access Token。请在管理控制台填写后继续。`);
      return;
    }

    setAiBusy(true);
    const requestId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const requestEpoch = aiRequestEpochRef.current;
    const requestController = activeAIRequestsRef.current.begin(requestId);
    const startedAt = new Date().toISOString();
    setAiProgress({
      requestId,
      status: "received",
      seatId: pending.seatId,
      phase: game.phase.label,
      message: "AI 行动已提交，正在等待回应。",
      startedAt,
      updatedAt: startedAt
    });
    clearStreamingOutput();
    setAiStepStatus(`${seatName(game, pending.seatId)} 正在${pendingLabel(pending)}。`);
    const pollTimer = window.setInterval(() => {
      void loadAIDecisionStatus(requestId)
        .then((status) => {
          if (!status) return;
          setAiProgress((current) =>
            isCurrentAIStatus({
              expectedRequestId: requestId,
              statusRequestId: status.requestId,
              activeStatusRequestId: current?.requestId,
              expectedActionKey: actionKey,
              activeActionKey: aiInFlightRef.current,
              expectedEpoch: requestEpoch,
              currentEpoch: aiRequestEpochRef.current,
              aborted: requestController.signal.aborted
            })
              ? status
              : current
          );
        })
        .catch(() => undefined);
    }, 1000);
    try {
      const result = await requestAIDecision(game, pending.seatId, requestId, providerApiKeys, effectiveContextCompression, requestController.signal);
      if (requestEpoch !== aiRequestEpochRef.current || requestController.signal.aborted) return;
      if (aiInFlightRef.current !== actionKey) return;
      if (!result.ok || !result.command) {
        setAiStepStatus(result.error ? `自动处理失败：${result.error}` : "自动处理失败，请稍后重试。");
        return;
      }
      void loadAIDecisionStatus(requestId)
        .then((status) => {
          if (!status) return;
          setAiProgress((current) =>
            isCurrentAIStatus({
              expectedRequestId: requestId,
              statusRequestId: status.requestId,
              activeStatusRequestId: current?.requestId,
              expectedActionKey: actionKey,
              activeActionKey: aiInFlightRef.current,
              expectedEpoch: requestEpoch,
              currentEpoch: aiRequestEpochRef.current,
              aborted: requestController.signal.aborted
            })
              ? status
              : current
          );
        })
        .catch(() => undefined);
      const latestGame = gameRef.current;
      if (!latestGame || latestGame.id !== game.id) return;
      const latestPending = findMatchingPending(latestGame, pending);
      if (!latestPending) {
        setAiStepStatus(`${seatName(game, pending.seatId)} 的 ${pendingLabel(pending)} 已不再等待，忽略旧 AI 返回。`);
        return;
      }
      let nextState = applyCommand(latestGame, result.command as GameCommand);
      if (result.memoryUpdate) {
        nextState = applyAgentMemoryUpdate(nextState, latestPending.seatId, result.memoryUpdate as AgentMemoryUpdate);
      }
      if (result.llmCall) nextState.llmCalls.push(result.llmCall as LLMCallLog);
      commitGame(nextState);
      const publicText = officialOutputForCommand(latestGame, latestPending, result.command, humanPlayerId);
      if (publicText) streamOfficialOutput(publicText);
      setAiStepStatus(
        result.fallback
          ? `真实模型未返回可用动作，已用规则兜底继续。${fallbackDetailText(result) ? `原因：${fallbackDetailText(result)}` : ""}`
          : `${seatName(latestGame, latestPending.seatId)} 已完成 ${pendingLabel(latestPending)}。`
      );
      if (!pauseAfterReadableAIOutput(latestPending, result.command as GameCommand, publicText, nextState, latestGame.phase.label)) {
        pauseAfterTransitionEvents(latestGame, nextState, latestGame.phase.label);
      }
    } catch (error) {
      if (requestEpoch !== aiRequestEpochRef.current || requestController.signal.aborted) return;
      setAiStepStatus(error instanceof Error ? `自动处理失败：${error.message}` : "自动处理失败，请稍后重试。");
    } finally {
      window.clearInterval(pollTimer);
      activeAIRequestsRef.current.finish(requestId, requestController);
      if (requestEpoch === aiRequestEpochRef.current) {
        setAiBusy(false);
        if (aiInFlightRef.current === actionKey) aiInFlightRef.current = null;
      }
    }
  }

  async function stepAIParallel(pendingBatch: PendingAction[]): Promise<void> {
    if (!game || game.status === "ended" || aiBusy || aiInFlightRef.current) return;
    const batchKey = aiPendingBatchKey(game, pendingBatch);
    const batchLabel = parallelBatchLabel(pendingBatch[0]);
    aiInFlightRef.current = batchKey;
    if (aiMode === "mock") {
      try {
        let next = game;
        for (let index = 0; index < pendingBatch.length; index += 1) {
          next = applyMockStep(next);
        }
        commitGame(next);
        clearStreamingOutput();
        setAiStepStatus(`${pendingBatch.length} 名 AI 已并行完成${batchLabel}。`);
        pauseAfterTransitionEvents(game, next, game.phase.label);
      } finally {
        window.setTimeout(() => {
          if (aiInFlightRef.current === batchKey) aiInFlightRef.current = null;
        }, 0);
      }
      return;
    }

    const missingProvider = firstMissingProviderForBatch(game, pendingBatch, config, providerApiKeys);
    if (missingProvider) {
      aiInFlightRef.current = null;
      setAutoRun(false);
      setIsPaused(true);
      setAiStepStatus(`${missingProvider.name} 缺少本机 API Key / Access Token。请在管理控制台填写后继续。`);
      return;
    }

    setAiBusy(true);
    clearStreamingOutput();
    const snapshot = game;
    const batchId = `ai_batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const requestEpoch = aiRequestEpochRef.current;
    const startedAt = new Date().toISOString();
    setAiProgress({
      requestId: batchId,
      status: "provider_request",
      phase: snapshot.phase.label,
      message: `${pendingBatch.length} 名 AI 正在并行${batchLabel}。`,
      startedAt,
      updatedAt: startedAt
    });
    setAiStepStatus(`${pendingBatch.length} 名 AI 正在并行${batchLabel}。`);

    try {
      const results = await Promise.all(
        pendingBatch.map(async (pending): Promise<ParallelAIDecisionResult> => {
          const requestId = `${batchId}_${pending.seatId}`;
          const requestController = activeAIRequestsRef.current.begin(requestId);
          try {
            const result = await requestAIDecision(snapshot, pending.seatId, requestId, providerApiKeys, effectiveContextCompression, requestController.signal);
            return { pending, requestId, result };
          } catch (error) {
            return { pending, requestId, error: error instanceof Error ? error.message : "AI 决策请求失败" };
          } finally {
            activeAIRequestsRef.current.finish(requestId, requestController);
          }
        })
      );
      if (requestEpoch !== aiRequestEpochRef.current) return;
      if (aiInFlightRef.current !== batchKey) return;
      const successes = results.filter((item) => item.result?.ok && item.result.command);
      const failures = results.filter((item) => !item.result?.ok || !item.result.command);
      const latestGame = gameRef.current;
      if (!latestGame || latestGame.id !== snapshot.id) return;
      let nextState = latestGame;
      const appliedSuccesses: ParallelAIDecisionResult[] = [];

      if (successes.length > 0) {
        for (const item of successes) {
          const result = item.result;
          if (!result?.command) continue;
          const latestPending = findMatchingPending(nextState, item.pending);
          if (!latestPending) continue;
          nextState = applyCommand(nextState, result.command as GameCommand);
          if (result.memoryUpdate) {
            nextState = applyAgentMemoryUpdate(nextState, latestPending.seatId, result.memoryUpdate as AgentMemoryUpdate);
          }
          if (result.llmCall) nextState.llmCalls.push(result.llmCall as LLMCallLog);
          appliedSuccesses.push(item);
        }
        if (appliedSuccesses.length > 0) commitGame(nextState);
      }

      const fallbackCount = appliedSuccesses.filter((item) => item.result?.fallback).length;
      const fallbackReason = appliedSuccesses.map((item) => (item.result ? fallbackDetailText(item.result) : "")).find(Boolean);
      const finishedAt = new Date().toISOString();
      setAiProgress({
        requestId: batchId,
        status: failures.length > 0 ? "failed" : fallbackCount > 0 ? "fallback" : "completed",
        phase: snapshot.phase.label,
        message:
          failures.length > 0
            ? `${appliedSuccesses.length} 名 AI 已完成，${failures.length} 名失败，已暂停等待处理。`
            : `${appliedSuccesses.length} 名 AI 已并行完成${batchLabel}${fallbackCount > 0 ? `，其中 ${fallbackCount} 名使用兜底${fallbackReason ? `：${fallbackReason}` : ""}` : ""}。`,
        startedAt,
        updatedAt: finishedAt
      });
      if (failures.length > 0) {
        setAutoRun(false);
        setIsPaused(true);
        const failedSeats = failures.map((item) => seatName(snapshot, item.pending.seatId)).join("、");
        const errorText = parallelFailureReason(failures);
        setAiStepStatus(`${appliedSuccesses.length} 名 AI 已完成${batchLabel}，${failedSeats} 失败，已暂停。${errorText ? `原因：${errorText}` : ""}`);
      } else {
        setAiStepStatus(`${appliedSuccesses.length} 名 AI 已并行完成${batchLabel}${fallbackCount > 0 ? `，其中 ${fallbackCount} 名使用兜底${fallbackReason ? `：${fallbackReason}` : ""}` : ""}。`);
        if (appliedSuccesses.length > 0) {
          pauseAfterTransitionEvents(latestGame, nextState, latestGame.phase.label);
        }
      }
    } finally {
      if (requestEpoch === aiRequestEpochRef.current) {
        setAiBusy(false);
        if (aiInFlightRef.current === batchKey) aiInFlightRef.current = null;
      }
    }
  }

  function pauseAfterReadableAIOutput(pending: PendingAction, command: GameCommand | undefined, publicText: string, nextState: GameState, phaseLabel: string): boolean {
    if (!humanPlayerId) return false;
    const hasReadableSpeech = Boolean(publicText) && (pending.kind === "speech" || pending.kind === "wolf_discussion");
    const hasReadableWithdrawal = Boolean(publicText) && isWithdrawalOutputCommand(command);
    const hasReadableWithdrawalRound = Boolean(publicText) && pending.kind === "sheriff_withdrawal";
    const labels = readableOutputPauseLabels(pending, command);
    const canPause = hasReadableSpeech || hasReadableWithdrawal || hasReadableWithdrawalRound;
    if (!canPause) return false;
    setReadableOutputPause({ seatId: pending.seatId, phaseLabel, publicText, ...labels });
    setAutoRun(false);
    setIsPaused(true);
    setAiStepStatus(`${seatName(nextState, pending.seatId)} ${labels.doneLabel}`);
    return true;
  }

  function pauseAfterTransitionEvents(previous: GameState, nextState: GameState, phaseLabel: string): boolean {
    if (!humanPlayerId) return false;
    const notice = transitionNoticeForNewEvents(previous, nextState, humanPlayerId);
    if (!notice) return false;
    clearStreamingOutput();
    setReadableOutputPause({ phaseLabel, ...notice });
    setAutoRun(false);
    setIsPaused(true);
    setAiStepStatus(notice.doneLabel ?? "事件已结算，点击继续进入下一步。");
    return true;
  }

  function submitHumanAction(): void {
    const currentGame = gameRef.current ?? game;
    const currentHumanPending = currentGame?.pendingActions.find((action) => currentGame.players.find((player) => player.id === action.seatId)?.controller === "human");
    if (!currentGame || !currentHumanPending || (readableOutputPause && isPaused)) return;
    const command = buildHumanCommand(currentGame, currentHumanPending, selectedTarget, speechText, witchSave, witchPoisonTarget, wolfAgree, sheriffRun);
    if (!command) return;
    const next = applyCommand(currentGame, command);
    commitGame(next);
    clearStreamingOutput();
    setReadableOutputPause(null);
    const skipTransitionNotice = currentHumanPending.kind === "speech" || currentHumanPending.kind === "wolf_discussion";
    const pausedForNotice = skipTransitionNotice ? false : pauseAfterTransitionEvents(currentGame, next, currentGame.phase.label);
    if (!pausedForNotice) {
      setIsPaused(false);
      setAutoRun(true);
      setAiStepStatus(`${seatName(currentGame, currentHumanPending.seatId)} 已提交 ${pendingLabel(currentHumanPending)}，自动流程继续。`);
    }
  }

  function withdrawSheriffCandidacy(): void {
    if (!game || !humanPlayerId || !canWithdrawSheriff(game, humanPlayerId)) return;
    const pending = game.pendingActions.find((action) => action.seatId === humanPlayerId);
    if (pending?.kind === "sheriff_withdrawal") {
      const next = applyCommand(game, { type: "SubmitSheriffWithdrawalDecision", seatId: humanPlayerId, withdraw: true, privateReason: "真人投票前退水。" });
      commitGame(next);
      pauseAfterTransitionEvents(game, next, game.phase.label);
      return;
    }
    const next = applyCommand(game, { type: "WithdrawSheriffCandidacy", seatId: humanPlayerId, privateReason: "真人警上退水。" });
    commitGame(next);
    pauseAfterTransitionEvents(game, next, game.phase.label);
  }

  function submitWolfSelfExplosion(): void {
    if (!game || !humanPlayerId || !canWolfSelfExplode(game, humanPlayerId)) return;
    invalidateAIRequests();
    setAiBusy(false);
    const next = applyCommand(game, {
      type: "SubmitWolfSelfExplosion",
      seatId: humanPlayerId,
      privateReason: "真人狼人选择自爆，结束当前回合并直接进入夜晚。"
    });
    commitGame(next);
    setAutoRun(true);
    setIsPaused(false);
    clearStreamingOutput();
    setReadableOutputPause(null);
    setAiProgress(null);
    setAiStepStatus(`${seatName(game, humanPlayerId)} 自爆，当前回合结束，直接进入夜晚。`);
    setTab("chat");
  }

  function exportMarkdown(): void {
    if (!game) return;
    downloadText(`${game.id}.md`, generateMarkdownLog(game), "text/markdown");
    setDebugStatus("Markdown 复盘已生成。");
  }

  function exportJson(): void {
    if (!game) return;
    downloadText(`${game.id}.events.json`, JSON.stringify(game.events, null, 2), "application/json");
    setDebugStatus("JSON 事件流已生成。");
  }

  function exportSnapshot(): void {
    if (!game) return;
    downloadText(`${game.id}.snapshot.json`, JSON.stringify(createSnapshotFixture(game), null, 2), "application/json");
    setDebugStatus("测试用例快照已生成。");
  }

  async function importSnapshot(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const restored = assertSingleBrowserGame(restoreSnapshotFixture(JSON.parse(await file.text())));
      invalidateAIRequests();
      setAiBusy(false);
      setAutoRun(false);
      setIsPaused(true);
      commitGame(restored);
      setSetup(normalizeSetupForGame(restored.setup));
      setAutoRun(true);
      setBatchResult(null);
      clearStreamingOutput();
      setReadableOutputPause(null);
      setAiProgress(null);
      setGameContextCompression(undefined);
      setIsPaused(false);
      setTab("exposure");
      setScreen("game");
      setDebugStatus(`已导入测试用例：${restored.id}，可继续 AI 自动行动或真实 AI 测试。`);
    } catch (error) {
      setDebugStatus(error instanceof Error ? `导入失败：${error.message}` : "导入失败。");
    } finally {
      input.value = "";
    }
  }

  function forceKillPlayer(seatId: PlayerId): void {
    setGame((current) => {
      const next = current
        ? applyCommand(current, {
            type: "DebugForceKill",
            seatId,
            reason: "手动调试强制死亡。"
          })
        : current;
      gameRef.current = next;
      return next;
    });
  }

  function runMockBatchFromCurrentSetup(): void {
    const base = game?.setup ?? setup;
    const result = runMockBatch(
      {
        ...base,
        humanPlayers: 0,
        aiPlayers: base.totalPlayers,
        seed: `${base.seed || "langrensha"}:batch`
      },
      100,
      500
    );
    setBatchResult(result);
    setTab("exposure");
  }

  function clearStreamingOutput(): void {
    if (streamingTimerRef.current !== undefined) {
      window.clearInterval(streamingTimerRef.current);
      streamingTimerRef.current = undefined;
    }
    setStreamingSpeech("");
  }

  function streamOfficialOutput(text: string): void {
    let index = 0;
    clearStreamingOutput();
    streamingTimerRef.current = window.setInterval(() => {
      index += 3;
      setStreamingSpeech(text.slice(0, index));
      if (index >= text.length && streamingTimerRef.current !== undefined) {
        window.clearInterval(streamingTimerRef.current);
        streamingTimerRef.current = undefined;
      }
    }, 24);
  }

  async function saveConfig(): Promise<void> {
    try {
      const synced = syncHiddenAIProviderConfig(config);
      const saved = await saveAIConfig(stripProviderSecrets(synced));
      setConfig(
        stripProviderSecrets({
          ...saved,
          costControls: saved.costControls ?? DEFAULT_COST_CONTROLS,
          contextCompression: saved.contextCompression ?? DEFAULT_CONTEXT_COMPRESSION
        })
      );
      setConfigStatus("配置已保存到后端，密钥仅保留在当前浏览器");
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : "保存失败");
    }
  }

  async function runProviderTest(provider: ProviderAccount): Promise<void> {
    setProviderTestStatus(`正在测试 ${provider.name} 连接...`);
    setProviderTestResults((current) => ({ ...current, [provider.id]: "testing" }));
    try {
      const result = await testProvider(provider.id, providerApiKeys[provider.id]?.trim() || undefined);
      if (result.ok) {
        const incoming = result.models ?? [];
        if (incoming.length > 0) {
          setConfig((current) => selectFetchedDefaultModel(upsertFetchedModels(current, provider.id, incoming), provider.id, incoming));
        }
        setProviderTestResults((current) => ({ ...current, [provider.id]: "success" }));
        setProviderTestStatus(`${provider.name} 连接成功，返回 ${incoming.length} 个模型`);
      } else {
        setProviderTestResults((current) => ({ ...current, [provider.id]: "failed" }));
        setProviderTestStatus(`${provider.name} 连接失败：${result.error}`);
      }
    } catch (error) {
      setProviderTestResults((current) => ({ ...current, [provider.id]: "failed" }));
      setProviderTestStatus(error instanceof Error ? `${provider.name} 测试失败：${error.message}` : `${provider.name} 测试失败`);
    }
  }

  function setLocalProviderApiKey(providerId: string, apiKey: string): void {
    setProviderTestResults((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
    setProviderApiKeys((current) => {
      const next = { ...current };
      if (apiKey.trim()) {
        next[providerId] = apiKey;
      } else {
        delete next[providerId];
      }
      saveLocalProviderApiKeys(next);
      return next;
    });
  }

  if (screen === "admin") {
    return (
      <AdminConsole
        section={adminSection}
        setSection={setAdminSection}
        config={config}
        readinessConfig={configWithLocalSecretStatus}
        setConfig={setConfig}
        configStatus={configStatus}
        providerTestStatus={providerTestStatus}
        providerTestResults={providerTestResults}
        providerApiKeys={providerApiKeys}
        onProviderApiKeyChange={setLocalProviderApiKey}
        onProviderConfigChange={(providerId) =>
          setProviderTestResults((current) => {
            const next = { ...current };
            delete next[providerId];
            return next;
          })
        }
        aiMode={aiMode}
        setAiMode={setAiMode}
        onSave={saveConfig}
        onTestProvider={runProviderTest}
        onBack={() => setScreen(game ? "game" : "setup")}
      />
    );
  }

  return (
    <main className={`app-shell ${game ? "game-shell" : "setup-shell"}`}>
      {!game || screen === "setup" ? (
        <>
          <header className="topbar setup-topbar">
            <div className="brand">
              <Moon size={24} />
              <div>
                <h1>暗月庄园 · 狼人杀</h1>
                <p>Web 可玩 · 规则引擎稳定 · API 接入在管理控制台</p>
              </div>
            </div>
            <div className="topbar-actions">
              <button className="ghost-button" onClick={() => setScreen("admin")}>
                <Settings size={16} />
                管理控制台
              </button>
              <button className="primary-button" onClick={startGame}>
                <Play size={16} />
                创建房间
              </button>
            </div>
          </header>
          <SetupScreen
            setup={setup}
            setSetup={setSetup}
            onStart={startGame}
            sessionRecoveryError={sessionRecoveryError}
            onClearBrokenSession={() => {
              try {
                clearStoredGameSession(window.localStorage);
                setSessionRecoveryError("");
              } catch (error) {
                setSessionRecoveryError(error instanceof Error ? `清除失败：${error.message}` : "清除本机对局失败。");
              }
            }}
          />
        </>
      ) : (
        <GameRoom
          game={game}
          visibleEvents={visibleEvents}
          config={config}
          aiMode={aiMode}
          sideTab={tab}
          setSideTab={setTab}
          autoRun={autoRun}
          isPaused={isPaused}
          aiBusy={aiBusy}
          aiElapsedSeconds={aiElapsedSeconds}
          aiProgress={aiProgress}
          aiStepStatus={aiStepStatus}
          contextCompression={effectiveContextCompression}
          onContextCompressionChange={setGameContextCompression}
          streamingSpeech={streamingSpeech}
          readableOutputPause={readableOutputPause}
          humanPlayerId={humanPlayerId}
          humanPending={humanPending}
          selectedTarget={selectedTarget}
          setSelectedTarget={setSelectedTarget}
          witchSave={witchSave}
          setWitchSave={setWitchSave}
          witchPoisonTarget={witchPoisonTarget}
          setWitchPoisonTarget={setWitchPoisonTarget}
          speechText={speechText}
          setSpeechText={setSpeechText}
          wolfAgree={wolfAgree}
          setWolfAgree={setWolfAgree}
          sheriffRun={sheriffRun}
          setSheriffRun={setSheriffRun}
          canWithdrawSheriff={Boolean(humanPlayerId && canWithdrawSheriff(game, humanPlayerId))}
          canSelfExplode={canHumanSelfExplode}
          batchResult={batchResult}
          debugStatus={debugStatus}
          onSubmitHuman={submitHumanAction}
          onWithdrawSheriff={withdrawSheriffCandidacy}
          onSelfExplode={submitWolfSelfExplosion}
          onStepAI={stepAI}
          onPauseForNotice={() => {
            setAutoRun(false);
            setIsPaused(true);
          }}
          onContinueAfterNotice={() => {
            setIsPaused(false);
            setAutoRun(true);
          }}
          onTogglePause={() => {
            if (isPaused) {
              clearStreamingOutput();
              setReadableOutputPause(null);
            }
            setIsPaused((current) => {
              const next = !current;
              setAutoRun(!next);
              return next;
            });
          }}
          onRestart={restartGame}
          onOpenAdmin={() => setScreen("admin")}
          onNewGame={() => {
            invalidateAIRequests();
            setAiBusy(false);
            setAutoRun(false);
            setIsPaused(false);
            commitGame(null);
            try {
              clearStoredGameSession(window.localStorage);
              setSessionRecoveryError("");
            } catch (error) {
              setSessionRecoveryError(error instanceof Error ? `清除本机对局失败：${error.message}` : "清除本机对局失败。");
            }
            setSetup((current) => ({ ...current, seed: createRandomSeed() }));
            setGameContextCompression(undefined);
            setReadableOutputPause(null);
            setScreen("setup");
            setTab("chat");
          }}
          onExportMarkdown={exportMarkdown}
          onExportJson={exportJson}
          onExportSnapshot={exportSnapshot}
          onImportSnapshot={importSnapshot}
          onForceKill={forceKillPlayer}
          onRunMockBatch={runMockBatchFromCurrentSetup}
        />
      )}
    </main>
  );
}

function AdminConsole({
  section,
  setSection,
  config,
  readinessConfig,
  setConfig,
  configStatus,
  providerTestStatus,
  providerTestResults,
  providerApiKeys,
  onProviderApiKeyChange,
  onProviderConfigChange,
  aiMode,
  setAiMode,
  onSave,
  onTestProvider,
  onBack
}: {
  section: AdminSection;
  setSection: (section: AdminSection) => void;
  config: AIConfigStore;
  readinessConfig: AIConfigStore;
  setConfig: (config: AIConfigStore) => void;
  configStatus: string;
  providerTestStatus: string;
  providerTestResults: ProviderTestResults;
  providerApiKeys: LocalProviderApiKeys;
  onProviderApiKeyChange: (providerId: string, apiKey: string) => void;
  onProviderConfigChange: (providerId: string) => void;
  aiMode: "mock" | "llm";
  setAiMode: (value: "mock" | "llm") => void;
  onSave: () => void;
  onTestProvider: (provider: ProviderAccount) => void;
  onBack: () => void;
}): JSX.Element {
  const apiSummary = buildApiAccessSummary(config, providerApiKeys, providerTestResults);
  const nav: Array<{ id: AdminSection; label: string }> = [
    { id: "overview", label: "控制台" },
    { id: "ai", label: "API 接入" },
    { id: "roles", label: "游戏规则" },
    { id: "logs", label: "日志记录" }
  ];
  const sectionDescriptions: Record<AdminSection, string> = {
    overview: "查看当前运行模式、接口接入状态和基础规则入口。",
    ai: "只配置供应商接口、密钥和模型；游戏身份分配不在这里处理。",
    roles: "查看创建房间时使用的规则包、人数和身份分配摘要。",
    logs: "查看复盘、事件导出和真实模型调用记录说明。"
  };
  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <div className="brand admin-brand">
          <Moon size={28} />
          <div>
            <h1>暗月庄园</h1>
            <p>管理控制台</p>
          </div>
        </div>
        <nav className="admin-nav">
          {nav.map((item) => (
            <button className={section === item.id ? "selected" : ""} onClick={() => setSection(item.id)} key={item.id}>
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="admin-main">
        <header className="admin-topbar">
          <div>
            <h2>{nav.find((item) => item.id === section)?.label}</h2>
            <p>{sectionDescriptions[section]}</p>
          </div>
          <div className="admin-actions">
            <div className="admin-mode-switch" aria-label="当前 AI 模式">
              <button className={aiMode === "mock" ? "selected" : ""} onClick={() => setAiMode("mock")}>
                Mock AI
              </button>
              <button className={aiMode === "llm" ? "selected" : ""} onClick={() => setAiMode("llm")}>
                真实供应商
              </button>
            </div>
            <button className="primary-button" onClick={onSave}>
              <Save size={16} />
              保存配置
            </button>
            <button className="ghost-button" onClick={onBack}>
              返回游戏
            </button>
          </div>
        </header>
        {section === "overview" && (
          <div className="admin-grid admin-overview-grid">
            <section className={`readiness-panel ${apiSummary.ready ? "ready" : "pending"}`}>
              <div className="panel-title">
                <Bot size={17} />
                API 接入状态
              </div>
              <p>{apiSummary.ready ? "真实供应商已具备跑局条件。" : "真实供应商跑局前还需要补齐接口信息。"}</p>
              <div className="readiness-list">
                {apiSummary.items.map((item) => (
                  <div className={`readiness-item ${item.ok ? "ok" : "warn"}`} key={item.label}>
                    <strong>{item.ok ? "通过" : "待补"}</strong>
                    <span>{item.label}</span>
                    <p>{item.detail}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="compact-table">
              <h3>配置概览</h3>
              <div className="stats-grid">
                <div><span>供应商</span><strong>{config.providers.length}</strong></div>
                <div><span>已启用</span><strong>{config.providers.filter((provider) => provider.enabled).length}</strong></div>
                <div><span>已填密钥</span><strong>{Object.values(providerApiKeys).filter((value) => value.trim()).length}</strong></div>
                <div><span>连接成功</span><strong>{Object.values(providerTestResults).filter((value) => value === "success").length}</strong></div>
              </div>
              <p className="muted">{configStatus}</p>
            </section>
          </div>
        )}
        {section === "ai" && (
          <ApiAccessPanel
            config={config}
            readinessConfig={readinessConfig}
            setConfig={setConfig}
            configStatus={configStatus}
            providerTestStatus={providerTestStatus}
            providerTestResults={providerTestResults}
            providerApiKeys={providerApiKeys}
            onProviderApiKeyChange={onProviderApiKeyChange}
            onProviderConfigChange={onProviderConfigChange}
            onSave={onSave}
            onTestProvider={onTestProvider}
            aiMode={aiMode}
            setAiMode={setAiMode}
            onOpenRules={() => setSection("roles")}
          />
        )}
        {section === "roles" && <RoleSettingsPanel />}
        {section === "logs" && (
          <section className="compact-table">
            <h3>日志记录</h3>
            <p className="muted">游戏内导出的 Markdown、JSON 事件和测试用例快照用于复盘；真实模型调用记录会出现在暴露模式和 Markdown 复盘中。</p>
          </section>
        )}
      </section>
    </main>
  );
}

function RoleSettingsPanel(): JSX.Element {
  return (
    <div className="admin-grid">
      <section className="compact-table">
        <h3>身份分配摘要</h3>
        {Object.values(ROLE_DEFINITIONS).map((role) => (
          <div className="role-row" key={role.id}>
            <div className="avatar small">{role.name.slice(0, 1)}</div>
            <div>
              <strong>{role.name}</strong>
              <p>{role.publicDescription}</p>
            </div>
            <span>{role.team === "wolves" ? "狼人阵营" : "好人阵营"}</span>
          </div>
        ))}
      </section>
      <section className="compact-table">
        <h3>标准渐进规则包</h3>
        <p className="muted">创建房间时会按人数自动分配身份；API 接入页不会处理这些游戏身份。</p>
        {Object.entries(STANDARD_PRESET.roleTable).map(([players, roles]) => (
          <div className="table-row" key={players}>
            <span>{players} 人</span>
            <strong>{formatRoleCounts(roles)}</strong>
          </div>
        ))}
      </section>
    </div>
  );
}

interface ApiAccessItem {
  label: string;
  detail: string;
  ok: boolean;
}

interface ApiAccessSummary {
  ready: boolean;
  items: ApiAccessItem[];
}

function buildApiAccessSummary(config: AIConfigStore, apiKeys: LocalProviderApiKeys, testResults: ProviderTestResults): ApiAccessSummary {
  const enabledRealProviders = config.providers.filter((provider) => provider.enabled && isRealProvider(provider));
  const firstProvider = enabledRealProviders[0];
  const hasRealProvider = Boolean(firstProvider);
  const keyReady = Boolean(firstProvider && hasProviderSecret(firstProvider, apiKeys));
  const modelReady = Boolean(firstProvider?.defaultModel.trim());
  const testReady = enabledRealProviders.some((provider) => testResults[provider.id] === "success");
  const ready = hasRealProvider && keyReady && modelReady && testReady;
  return {
    ready,
    items: [
      {
        label: "已填写 API Key",
        ok: keyReady,
        detail: keyReady ? `${firstProvider?.name ?? "供应商"} 已有本机密钥。` : "先选择一个真实供应商，并粘贴供应商给你的 API Key。"
      },
      {
        label: "已选择模型",
        ok: modelReady,
        detail: modelReady ? `默认模型：${firstProvider?.defaultModel}` : "填写这个供应商要使用的模型名。"
      },
      {
        label: "连接测试通过",
        ok: testReady,
        detail: testReady ? "至少一个启用的真实供应商连接成功。" : "点击“测试连接”，确认接口地址、密钥和模型可用。"
      },
      {
        label: "可用于真实 AI 跑局",
        ok: ready,
        detail: ready ? "保存配置后，真实供应商可用于自动跑局。" : hasRealProvider ? "补齐上面的项目后再切换真实供应商跑局。" : "先添加并启用一个真实供应商。"
      }
    ]
  };
}

function isRealProvider(provider: ProviderAccount): boolean {
  return !provider.baseUrl.startsWith("mock://") && provider.type !== "codex_cli_local";
}

function isDeepSeekProvider(provider: ProviderAccount): boolean {
  return provider.baseUrl.includes("api.deepseek.com");
}

function providerSupportsReasoningEffort(provider: ProviderAccount): boolean {
  return provider.supportsReasoningEffort || isDeepSeekProvider(provider);
}

function providerThinkingMode(provider: ProviderAccount): ThinkingMode {
  return provider.thinkingMode ?? (isDeepSeekProvider(provider) ? "enabled" : "auto");
}

function providerReasoningEffort(provider: ProviderAccount): ReasoningEffort {
  if (isDeepSeekProvider(provider)) {
    return provider.reasoningEffort === "max" ? "max" : "high";
  }
  return provider.reasoningEffort ?? "medium";
}

function hasProviderSecret(provider: ProviderAccount, apiKeys: LocalProviderApiKeys): boolean {
  return Boolean(apiKeys[provider.id]?.trim() || provider.apiKeyEncrypted?.trim());
}

function providerTypeLabel(type: ProviderType): string {
  const labels: Record<ProviderType, string> = {
    openai: "OpenAI",
    openai_compatible: "兼容接口",
    anthropic: "Anthropic",
    gemini: "Gemini",
    xai: "xAI",
    codex_cli_local: "本地"
  };
  return labels[type];
}

function providerKeyLabel(provider: ProviderAccount, apiKeys: LocalProviderApiKeys): string {
  if (!isRealProvider(provider)) return "无需密钥";
  return hasProviderSecret(provider, apiKeys) ? "已设置" : "未设置";
}

function providerKeyClass(provider: ProviderAccount, apiKeys: LocalProviderApiKeys): string {
  if (!isRealProvider(provider)) return "neutral";
  return hasProviderSecret(provider, apiKeys) ? "success" : "danger";
}

function providerTestLabel(state: ProviderTestState | undefined): string {
  if (state === "testing") return "测试中";
  if (state === "success") return "已连接";
  if (state === "failed") return "失败";
  return "待测试";
}

function providerTestClass(state: ProviderTestState | undefined): string {
  if (state === "testing") return "pending";
  if (state === "success") return "success";
  if (state === "failed") return "danger";
  return "neutral";
}

function preferredProviderId(providers: ProviderAccount[]): string {
  return providers.find((provider) => provider.enabled && isRealProvider(provider))?.id ?? providers.find(isRealProvider)?.id ?? providers[0]?.id ?? "";
}

function providerModelOptions(config: AIConfigStore, providerId: string): ModelConfig[] {
  return config.models
    .filter((model) => model.providerId === providerId && model.enabled)
    .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.name.localeCompare(right.name));
}

function GameRoom({
  game,
  visibleEvents,
  config,
  aiMode,
  sideTab,
  setSideTab,
  autoRun,
  isPaused,
  aiBusy,
  aiElapsedSeconds,
  aiProgress,
  aiStepStatus,
  contextCompression,
  onContextCompressionChange,
  streamingSpeech,
  readableOutputPause,
  humanPlayerId,
  humanPending,
  selectedTarget,
  setSelectedTarget,
  witchSave,
  setWitchSave,
  witchPoisonTarget,
  setWitchPoisonTarget,
  speechText,
  setSpeechText,
  wolfAgree,
  setWolfAgree,
  sheriffRun,
  setSheriffRun,
  canWithdrawSheriff,
  canSelfExplode,
  batchResult,
  debugStatus,
  onSubmitHuman,
  onWithdrawSheriff,
  onSelfExplode,
  onStepAI,
  onPauseForNotice,
  onContinueAfterNotice,
  onTogglePause,
  onRestart,
  onOpenAdmin,
  onNewGame,
  onExportMarkdown,
  onExportJson,
  onExportSnapshot,
  onImportSnapshot,
  onForceKill,
  onRunMockBatch
}: {
  game: GameState;
  visibleEvents: ReturnType<typeof getVisibleEvents>;
  config: AIConfigStore;
  aiMode: "mock" | "llm";
  sideTab: GameSideTab;
  setSideTab: (tab: GameSideTab) => void;
  autoRun: boolean;
  isPaused: boolean;
  aiBusy: boolean;
  aiElapsedSeconds: number;
  aiProgress: AIDecisionStatus | null;
  aiStepStatus: string;
  contextCompression: ContextCompressionConfig;
  onContextCompressionChange: (config: ContextCompressionConfig) => void;
  streamingSpeech: string;
  readableOutputPause: ReadableOutputPause | null;
  humanPlayerId?: PlayerId;
  humanPending?: PendingAction;
  selectedTarget: PlayerId | "abstain" | "skip" | "destroy";
  setSelectedTarget: (value: PlayerId | "abstain" | "skip" | "destroy") => void;
  witchSave: boolean;
  setWitchSave: (value: boolean) => void;
  witchPoisonTarget: PlayerId | "skip";
  setWitchPoisonTarget: (value: PlayerId | "skip") => void;
  speechText: string;
  setSpeechText: (value: string) => void;
  wolfAgree: boolean;
  setWolfAgree: (value: boolean) => void;
  sheriffRun: boolean;
  setSheriffRun: (value: boolean) => void;
  canWithdrawSheriff: boolean;
  canSelfExplode: boolean;
  batchResult: MockBatchRunResult | null;
  debugStatus: string;
  onSubmitHuman: () => void;
  onWithdrawSheriff: () => void;
  onSelfExplode: () => void;
  onStepAI: () => void;
  onPauseForNotice: () => void;
  onContinueAfterNotice: () => void;
  onTogglePause: () => void;
  onRestart: () => void;
  onOpenAdmin: () => void;
  onNewGame: () => void;
  onExportMarkdown: () => void;
  onExportJson: () => void;
  onExportSnapshot: () => void;
  onImportSnapshot: (event: ChangeEvent<HTMLInputElement>) => void;
  onForceKill: (seatId: PlayerId) => void;
  onRunMockBatch: () => void;
}): JSX.Element {
  const [dismissedNoticeSeq, setDismissedNoticeSeq] = useState(0);
  const [dismissedFlowNoticeKeys, setDismissedFlowNoticeKeys] = useState<string[]>([]);
  const humanPlayer = humanPlayerId ? game.players.find((player) => player.id === humanPlayerId) : undefined;
  const shouldShowFlowNotices = Boolean(humanPlayer?.alive);
  const isWaitingReadableOutputAck = Boolean(readableOutputPause && isPaused);
  const interactiveHumanPending = isWaitingReadableOutputAck ? undefined : humanPending;
  const interactiveCanWithdrawSheriff = isWaitingReadableOutputAck ? false : canWithdrawSheriff;
  const displayPhaseLabel = readableOutputPause && isPaused ? readableOutputPause.phaseLabel : visiblePhaseLabel(game, humanPlayerId);
  const displayPhaseProgress =
    readableOutputPause && isPaused ? `${seatName(game, readableOutputPause.seatId)} ${readableOutputPause.progressLabel ?? "已发言"}` : visiblePhaseProgress(game, humanPlayerId);
  const sheriffNotice = useMemo(() => buildSheriffElectionNotice(game), [game.events.length, game.id]);
  const showSheriffNotice = shouldShowFlowNotices && !isWaitingReadableOutputAck && Boolean(sheriffNotice && sheriffNotice.seq > dismissedNoticeSeq);
  const flowNotice = useMemo(
    () => (shouldShowFlowNotices && !isWaitingReadableOutputAck ? buildFlowNotice(game, visibleEvents, humanPlayerId, dismissedFlowNoticeKeys) : undefined),
    [dismissedFlowNoticeKeys, game.events.length, game.id, humanPlayerId, isWaitingReadableOutputAck, shouldShowFlowNotices, visibleEvents]
  );
  const activeNotice = showSheriffNotice && sheriffNotice ? sheriffNoticeToFlowNotice(sheriffNotice) : flowNotice;

  useEffect(() => {
    setDismissedNoticeSeq(0);
    setDismissedFlowNoticeKeys([]);
  }, [game.id]);

  useEffect(() => {
    if (activeNotice && humanPlayerId && !isPaused) onPauseForNotice();
  }, [activeNotice?.key, humanPlayerId, isPaused, onPauseForNotice]);

  function closeNotice(): void {
    if (!activeNotice) return;
    if (showSheriffNotice && sheriffNotice) {
      setDismissedNoticeSeq(sheriffNotice.seq);
    } else {
      setDismissedFlowNoticeKeys((current) => (current.includes(activeNotice.key) ? current : [...current, activeNotice.key]));
    }
    onContinueAfterNotice();
  }

  return (
    <section className="room-shell">
      <header className="room-topbar">
        <div className="brand compact">
          <Moon size={24} />
          <div>
            <h1>暗月庄园 · 狼人杀</h1>
            <p>{game.setup.totalPlayers}人标准场 · 房间 {game.id.replace("game_", "")}</p>
          </div>
        </div>
        <div className="room-phase-head">
          <span>{displayPhaseLabel}</span>
          <strong>{displayPhaseProgress}</strong>
        </div>
        <div className="room-actions">
          {canSelfExplode && (
            <button className="danger-button self-explode-button" onClick={onSelfExplode}>
              <Skull size={16} />
              自爆
            </button>
          )}
          <button className="ghost-button" onClick={onOpenAdmin}>
            <Settings size={16} />
            管理控制台
          </button>
          <button className={`ghost-button ${isPaused ? "selected-action" : ""}`} onClick={onTogglePause}>
            {isPaused ? <Play size={16} /> : <Pause size={16} />}
            {isPaused ? "继续" : "暂停"}
          </button>
          <button className="ghost-button" onClick={onRestart}>
            <Play size={16} />
            重启
          </button>
          <button className="danger-button" onClick={onNewGame}>
            退出房间
          </button>
        </div>
      </header>
      <div className="room-layout">
        <SeatPanel game={game} humanPlayerId={humanPlayerId} readableOutputPause={readableOutputPause} onOpenRecords={() => setSideTab("records")} />
        <CenterPanel
          game={game}
          config={config}
          aiMode={aiMode}
          visibleEvents={visibleEvents}
          aiBusy={aiBusy}
          aiElapsedSeconds={aiElapsedSeconds}
          aiProgress={aiProgress}
          aiStepStatus={aiStepStatus}
          streamingSpeech={streamingSpeech}
          readableOutputPause={readableOutputPause}
          isPaused={isPaused}
          autoRun={autoRun}
          humanPlayerId={humanPlayerId}
          humanPending={interactiveHumanPending}
          onTogglePause={onTogglePause}
        />
        <aside className="right-panel room-side">
          <TabBar active={sideTab} onChange={setSideTab} />
          {sideTab === "chat" && (
            <ActionPanel
              game={game}
              visibleEvents={visibleEvents}
              humanPending={interactiveHumanPending}
              selectedTarget={selectedTarget}
              setSelectedTarget={setSelectedTarget}
              witchSave={witchSave}
              setWitchSave={setWitchSave}
              witchPoisonTarget={witchPoisonTarget}
              setWitchPoisonTarget={setWitchPoisonTarget}
              speechText={speechText}
              setSpeechText={setSpeechText}
              wolfAgree={wolfAgree}
              setWolfAgree={setWolfAgree}
              sheriffRun={sheriffRun}
              setSheriffRun={setSheriffRun}
              canWithdrawSheriff={interactiveCanWithdrawSheriff}
              onSubmitHuman={onSubmitHuman}
              onWithdrawSheriff={onWithdrawSheriff}
            />
          )}
          {sideTab === "votes" && <VotePanel game={game} events={visibleEvents} />}
          {sideTab === "exposure" && (
            <DebugPanel
              game={game}
              batchResult={batchResult}
              debugStatus={debugStatus}
              aiBusy={aiBusy}
              contextCompression={contextCompression}
              onContextCompressionChange={onContextCompressionChange}
              onExportMarkdown={onExportMarkdown}
              onExportJson={onExportJson}
              onExportSnapshot={onExportSnapshot}
              onImportSnapshot={onImportSnapshot}
              onForceKill={onForceKill}
              onRunMockBatch={onRunMockBatch}
              onStepAI={onStepAI}
            />
          )}
          {sideTab === "records" && <RecordPanel events={visibleEvents} game={game} />}
          {sideTab === "rules" && <RulesPanel />}
        </aside>
      </div>
      {activeNotice && humanPlayerId && (
        <div className="notice-backdrop" role="dialog" aria-modal="true" aria-label={activeNotice.kicker}>
          <div className="notice-dialog">
            <div>
              <span className="phase-kicker">{activeNotice.kicker}</span>
              <h2>{activeNotice.title}</h2>
            </div>
            {activeNotice.rows.length > 0 && (
              <div className="notice-list">
                {activeNotice.rows.map((row) => (
                  <p key={row}>{row}</p>
                ))}
              </div>
            )}
            {activeNotice.chips.length > 0 && (
              <div className="notice-tally">
                {activeNotice.chips.map((row) => (
                  <span key={row}>{row}</span>
                ))}
              </div>
            )}
            <p>{activeNotice.body}</p>
            <button className="primary-button" onClick={closeNotice}>
              <StepForward size={16} />
              继续
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function SetupScreen({
  setup,
  setSetup,
  onStart,
  sessionRecoveryError,
  onClearBrokenSession
}: {
  setup: GameSetup;
  setSetup: (setup: GameSetup) => void;
  onStart: () => void;
  sessionRecoveryError: string;
  onClearBrokenSession: () => void;
}): JSX.Element {
  const aiPlayers = setup.totalPlayers - setup.humanPlayers;
  const customRoles = setup.roleOverrides ? normalizeRoleOverrides(setup.totalPlayers, setup.roleOverrides) : undefined;

  function patch(next: Partial<GameSetup>): void {
    const totalPlayers = clampNumber(next.totalPlayers ?? setup.totalPlayers, 6, 12);
    const humanPlayers = normalizeSingleBrowserHumanPlayers(next.humanPlayers ?? setup.humanPlayers);
    const incomingRoles = next.roleOverrides !== undefined ? next.roleOverrides : setup.roleOverrides;
    const roleOverrides = incomingRoles ? normalizeRoleOverrides(totalPlayers, incomingRoles) : undefined;
    setSetup({ ...setup, ...next, totalPlayers, humanPlayers, aiPlayers: totalPlayers - humanPlayers, roleOverrides });
  }

  function setRoleOverride(index: number, role: RoleId): void {
    const roles = normalizeRoleOverrides(setup.totalPlayers, setup.roleOverrides);
    roles[index] = role;
    patch({ roleOverrides: roles });
  }

  return (
    <section className="setup-page">
      <div className="setup-copy">
        <h2>创建可观战/可参与的 AI 狼人杀</h2>
        <p>第一版支持纯 AI 观战或单人参与；当前浏览器只承载一名真人身份，其余座位由 AI 补齐。</p>
      </div>
      {sessionRecoveryError && (
        <div className="setup-visibility-note" role="alert">
          <strong>无法恢复上次对局</strong>
          <p>{sessionRecoveryError}</p>
          <button type="button" className="ghost-button mini" onClick={onClearBrokenSession}>
            清除损坏的本机存档
          </button>
        </div>
      )}
      <div className="setup-grid">
        <label>
          总人数
          <div className="range-with-number">
            <input type="range" min={6} max={12} value={setup.totalPlayers} onChange={(event) => patch({ totalPlayers: Number(event.target.value) })} />
            <input
              aria-label="总人数数字"
              type="number"
              min={6}
              max={12}
              value={setup.totalPlayers}
              onChange={(event) => patch({ totalPlayers: Number(event.target.value) })}
            />
          </div>
          <strong>{setup.totalPlayers} 人</strong>
        </label>
        <label>
          真人数量
          <div className="range-with-number">
            <input type="range" min={0} max={1} step={1} value={setup.humanPlayers} onChange={(event) => patch({ humanPlayers: Number(event.target.value) })} />
            <input
              aria-label="真人数量数字"
              type="number"
              min={0}
              max={1}
              step={1}
              value={setup.humanPlayers}
              onChange={(event) => patch({ humanPlayers: Number(event.target.value) })}
            />
          </div>
          <strong>{setup.humanPlayers} 真人 · {aiPlayers} AI</strong>
        </label>
        <label>
          随机种子
          <div className="seed-field">
            <input value={setup.seed} onChange={(event) => patch({ seed: event.target.value })} />
            <button type="button" className="icon-button" aria-label="随机生成种子" title="随机生成种子" onClick={() => patch({ seed: createRandomSeed() })}>
              <Dices size={18} />
            </button>
          </div>
        </label>
        <div className="setup-visibility-note">
          <strong>普通视角</strong>
          <p>游戏房间默认隐藏其他玩家身份、AI 后台理由、prompt 和思考日志；测试时在右侧“暴露模式”查看。</p>
        </div>
        <Toggle label="允许暴露模式手动调试" checked={setup.debugMode.allowManualOverride} onChange={(value) => patch({ debugMode: { ...setup.debugMode, allowManualOverride: value } })} />
        <Toggle
          label="测试身份模式"
          checked={Boolean(customRoles)}
          onChange={(value) => patch({ roleOverrides: value ? normalizeRoleOverrides(setup.totalPlayers, setup.roleOverrides) : undefined })}
        />
        {customRoles && (
          <div className="test-role-panel">
            <div className="test-role-panel-header">
              <strong>座位身份</strong>
              <button type="button" className="ghost-button mini" onClick={() => patch({ roleOverrides: defaultRolesForTotal(setup.totalPlayers) })}>
                标准配置
              </button>
            </div>
            <div className="test-role-grid">
              {customRoles.map((role, index) => (
                <label key={index}>
                  {index + 1}号
                  <select aria-label={`测试身份 ${index + 1}号`} value={role} onChange={(event) => setRoleOverride(index, event.target.value as RoleId)}>
                    {ROLE_PICKER_ORDER.map((roleId) => (
                      <option key={roleId} value={roleId}>
                        {ROLE_DEFINITIONS[roleId].name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>
        )}
        <button className="primary-button large" onClick={onStart}>
          <Play size={18} />
          开始游戏
        </button>
      </div>
    </section>
  );
}

function SeatPanel({
  game,
  humanPlayerId,
  readableOutputPause,
  onOpenRecords
}: {
  game: GameState;
  humanPlayerId?: PlayerId;
  readableOutputPause: ReadableOutputPause | null;
  onOpenRecords: () => void;
}): JSX.Element {
  const human = humanPlayerId ? game.players.find((player) => player.id === humanPlayerId) : undefined;
  const role = human ? ROLE_DEFINITIONS[human.role] : undefined;
  const wolfTeammates =
    human?.role === "werewolf" ? game.players.filter((player) => player.role === "werewolf" && player.id !== human.id) : [];
  const steps = ["夜晚行动", "警长竞选", "白天发言", "投票放逐", "游戏结束"];
  const activeStep = game.status === "ended" ? 4 : game.phase.type.startsWith("night") ? 0 : game.phase.type.startsWith("sheriff") ? 1 : game.phase.type.includes("vote") ? 3 : 2;
  const phaseLabel = readableOutputPause ? readableOutputPause.phaseLabel : visiblePhaseLabel(game, humanPlayerId);
  const phaseProgress = readableOutputPause ? `${seatName(game, readableOutputPause.seatId)} ${readableOutputPause.progressLabel ?? "已发言"}` : visiblePhaseProgress(game, humanPlayerId);
  return (
    <aside className="seat-panel room-left">
      <section className="identity-card hero-identity">
        <div className="panel-title">
          <Eye size={17} />
          我的身份
        </div>
        {human && role ? (
          <>
            <div className="role-portrait">
              <div className="avatar large">{human.avatar}</div>
              <div>
                <strong>{role.name}</strong>
                <span>{role.team === "wolves" ? "狼人阵营" : "好人阵营"}</span>
              </div>
            </div>
            <p>{role.privateDescription}</p>
            {wolfTeammates.length > 0 && (
              <div className="wolf-allies">
                <strong>狼队友</strong>
                <div>
                  {wolfTeammates.map((player) => (
                    <span key={player.id}>
                      {seatName(game, player.id)}
                      {!player.alive && ` · ${deathReasonForViewer(game, player, humanPlayerId)}`}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="role-portrait">
              <div className="avatar large">观</div>
              <div>
                <strong>观战模式</strong>
                <span>0 真人玩家</span>
              </div>
            </div>
            <p>你正在观看自动对局。普通视角只展示状态和公开发言。</p>
          </>
        )}
      </section>
      <section className="phase-card">
        <div className="panel-title">
          <Moon size={17} />
          当前环节
        </div>
        <strong>{phaseLabel}</strong>
        <p>{phaseProgress}</p>
        <div className="phase-track">
          {steps.map((step, index) => (
            <div className={`phase-step ${index <= activeStep ? "done" : ""} ${index === activeStep ? "current" : ""}`} key={step}>
              <span />
              <p>{step}</p>
            </div>
          ))}
        </div>
      </section>
      <button className="record-shortcut" type="button" onClick={onOpenRecords}>
        <FileText size={18} />
        <div>
          <strong>游戏记录</strong>
          <p>公开发言、投票和死亡记录会实时写入复盘。</p>
        </div>
      </button>
    </aside>
  );
}

function CenterPanel({
  game,
  config,
  aiMode,
  visibleEvents,
  aiBusy,
  aiElapsedSeconds,
  aiProgress,
  aiStepStatus,
  streamingSpeech,
  readableOutputPause,
  isPaused,
  autoRun,
  humanPlayerId,
  humanPending,
  onTogglePause
}: {
  game: GameState;
  config: AIConfigStore;
  aiMode: "mock" | "llm";
  visibleEvents: ReturnType<typeof getVisibleEvents>;
  aiBusy: boolean;
  aiElapsedSeconds: number;
  aiProgress: AIDecisionStatus | null;
  aiStepStatus: string;
  streamingSpeech: string;
  readableOutputPause: ReadableOutputPause | null;
  isPaused: boolean;
  autoRun: boolean;
  humanPlayerId?: PlayerId;
  humanPending?: PendingAction;
  onTogglePause: () => void;
}): JSX.Element {
  const aiPending = game.pendingActions.find((action) => game.players.find((player) => player.id === action.seatId)?.controller !== "human");
  const parallelPending = parallelAIPendingActions(game);
  const parallelSeatIds = new Set(parallelPending.map((action) => action.seatId));
  const isParallelThinking = aiBusy && parallelPending.length >= 2;
  const visibleActingSeat = visibleActingSeatId(game, humanPlayerId);
  const displayActingSeat = readableOutputPause && isPaused ? readableOutputPause.seatId : isParallelThinking ? undefined : visibleActingSeat;
  const activePending = displayActingSeat ? game.pendingActions.find((action) => action.seatId === displayActingSeat) : undefined;
  const activePendingExpectsSpeech =
    activePending?.kind === "speech" || activePending?.kind === "wolf_discussion" || activePending?.kind === "sheriff_candidacy";
  const activePendingWaitingText = activePending ? pendingWaitingText(activePending) : "等待当前玩家发言。";
  const activePlayer = displayActingSeat ? game.players.find((player) => player.id === displayActingSeat) : undefined;
  const coreSeatLabel = isParallelThinking ? `${parallelPending.length}名 AI` : activePlayer ? `${activePlayer.seatNumber}号玩家` : "当前流程";
  const coreActionLabel = isParallelThinking
    ? "并行思考中"
    : centerActionLabel(activePlayer, activePending, {
        aiBusy,
        autoRun,
        humanPending,
        isPaused,
        readableOutputPause,
        streamingSpeech
      });
  const activeStreamingSpeech = streamingSpeech;
  const latestActingSpeech =
    displayActingSeat === undefined || readableOutputPause || activePendingExpectsSpeech
      ? undefined
      : [...visibleEvents]
          .reverse()
          .find(
            (event) =>
              event.seatId === displayActingSeat &&
              (event.type === "SpeechPublished" || event.type === "LastWordsPublished" || event.type === "WolfDiscussionMessage")
          );
  const statusText =
    readableOutputPause && isPaused
      ? aiStepStatus
      : buildActionStatusText(game, humanPlayerId, humanPending, aiPending, aiBusy, aiElapsedSeconds, aiProgress, isPaused, autoRun, aiStepStatus);
  return (
    <section className="center-panel table-panel">
      <div className="table-scene">
        <div className="moonlit-table">
          {game.players.map((player, index) => {
            const placement = tableSeatPlacement(index, game.players.length);
            const active = displayActingSeat === player.id || (isParallelThinking && parallelSeatIds.has(player.id));
            const runtime = aiRuntimeStatus(game, player, aiMode, config);
            return (
              <div
                className={`table-seat side-${placement.side} ${active ? "active" : ""} ${!player.alive ? "dead" : ""}`}
                style={{ "--seat-x": `${placement.x}%`, "--seat-y": `${placement.y}%` } as CSSProperties}
                key={player.id}
              >
                <div className="seat-orbit-card">
                  <span className="seat-number">{player.seatNumber}</span>
                  <div className="avatar portrait">{publicPlayerAvatar(player)}</div>
                  {active && (
                    <span className={`thinking-dot ${aiBusy ? "thinking" : ""}`}>
                      {isParallelThinking && parallelSeatIds.has(player.id) ? "并行思考" : seatActivityLabel(player, humanPending, aiBusy, isPaused, autoRun)}
                    </span>
                  )}
                  <strong>{publicPlayerLabel(player, config, aiMode, game)}</strong>
                  <p>{player.alive ? `存活${runtime ? ` · ${runtime.label}` : ""}` : deathReasonForViewer(game, player, humanPlayerId)}</p>
                  {player.isSheriff && <Award size={15} className="sheriff-icon" />}
                </div>
              </div>
            );
          })}
          <div className="table-core">
            <div className="table-core-meta">
              <span className="core-meta-pill core-meta-seat">{coreSeatLabel}</span>
              <StatusBadge game={game} />
              <span className="core-meta-pill core-meta-action">{coreActionLabel}</span>
            </div>
            <div className="table-speech">
              <p>
                {activeStreamingSpeech ||
                  readableOutputPause?.publicText ||
                  (latestActingSpeech
                    ? eventSummary(game, latestActingSpeech.type, latestActingSpeech.payload, latestActingSpeech.seatId)
                    : isParallelThinking
                      ? `${parallelPending.length} 名 AI 正在${parallelBatchLabel(parallelPending[0])}。`
                      : activePendingWaitingText)}
              </p>
            </div>
          </div>
        </div>
        <div className="speech-stream">
          <span>系统状态</span>
          <p>{statusText}</p>
          {isPaused && readableOutputPause && (
            <button className="primary-button continue-button" onClick={onTogglePause}>
              <StepForward size={16} />
              继续下一位
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function seatActivityLabel(
  player: GameState["players"][number],
  humanPending: PendingAction | undefined,
  aiBusy: boolean,
  isPaused: boolean,
  autoRun: boolean
): string {
  if (humanPending?.seatId === player.id) return "轮到你";
  if (isPaused) return "已暂停";
  if (player.controller !== "human") return aiBusy ? "思考中" : autoRun ? "自动行动中" : "待处理";
  return "行动中";
}

function parallelAIPendingActions(game: GameState): PendingAction[] {
  const aiActions = game.pendingActions.filter((action) => game.players.find((player) => player.id === action.seatId)?.controller !== "human");
  const batch = aiActions.filter((action) => isParallelThinkingAction(game, action));
  if (batch.length < 2 || batch.length !== aiActions.length) return [];
  const signature = parallelActionSignature(batch[0]);
  if (batch.some((action) => parallelActionSignature(action) !== signature)) return [];
  return [...batch].sort((left, right) => seatNumberFor(game, left.seatId) - seatNumberFor(game, right.seatId));
}

function isParallelThinkingAction(game: GameState, action: PendingAction): boolean {
  if (game.phase.type === "sheriff_candidacy") return action.kind === "sheriff_candidacy";
  if (game.phase.type === "sheriff_withdrawal") return action.kind === "sheriff_withdrawal";
  if (game.phase.type === "sheriff_vote" || game.phase.type === "sheriff_pk_vote") {
    return action.kind === "vote" && (action.voteType === "sheriff" || action.voteType === "sheriff_pk");
  }
  if (game.phase.type === "day_vote" || game.phase.type === "day_pk_vote") {
    return action.kind === "vote" && (action.voteType === "day" || action.voteType === "day_pk");
  }
  return false;
}

function parallelActionSignature(action: PendingAction): string {
  if (action.kind === "vote") return `${action.kind}:${action.voteType}`;
  if (action.kind === "sheriff_withdrawal") return `${action.kind}:${action.voteType}`;
  return action.kind;
}

function parallelBatchLabel(action: PendingAction): string {
  if (action.kind === "sheriff_candidacy") return "判断是否上警";
  if (action.kind === "sheriff_withdrawal") return action.voteType === "sheriff_pk" ? "判断 PK 是否退水" : "判断是否退水";
  if (action.kind === "vote" && action.voteType === "sheriff") return "进行警长投票";
  if (action.kind === "vote" && action.voteType === "sheriff_pk") return "进行警长 PK 投票";
  if (action.kind === "vote" && action.voteType === "day_pk") return "进行放逐 PK 投票";
  return "进行白天放逐投票";
}

function firstMissingProviderForBatch(
  game: GameState,
  pendingBatch: PendingAction[],
  config: AIConfigStore,
  providerApiKeys: LocalProviderApiKeys
): ProviderAccount | undefined {
  for (const pending of pendingBatch) {
    const player = game.players.find((item) => item.id === pending.seatId);
    const persona = config.personas.find((item) => item.id === player?.personaId) ?? config.personas[0] ?? DEFAULT_PERSONAS[0];
    const provider = config.providers.find((item) => item.id === persona.defaultProviderId && item.enabled);
    if (provider && isRealProvider(provider) && !providerApiKeys[provider.id]?.trim()) return provider;
  }
  return undefined;
}

function parallelFailureReason(failures: ParallelAIDecisionResult[]): string | undefined {
  return failures.find((item) => item.error)?.error ?? failures.find((item) => item.result?.error)?.result?.error;
}

function fallbackDetailText(result: AIDecisionResult): string {
  const raw = result.error || result.llmCall?.error || "";
  return fallbackReasonLabel(raw);
}

function fallbackReasonLabel(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  if (/未配置真实供应商|Mock 兜底|mock:\/\//i.test(text)) return "未配置真实供应商";
  if (/context_overflow|上下文|预算/i.test(text)) return "上下文超限";
  if (/成本保护|费用|cost/i.test(text)) return "成本保护";
  if (/API Key|Access Token|密钥|缺少/i.test(text)) return "缺少密钥";
  if (/timeout|aborted|network|fetch failed|LLM request failed/i.test(text)) return "请求失败";
  return text.length > 30 ? `${text.slice(0, 30)}...` : text;
}

function aiPendingKey(game: GameState, pending: PendingAction): string {
  return [game.id, game.phase.type, game.phase.day, game.phase.actingSeatId ?? "", pendingActionSignature(pending), game.events.length].join(":");
}

function aiPendingBatchKey(game: GameState, pendingBatch: PendingAction[]): string {
  return [
    game.id,
    game.phase.type,
    game.phase.day,
    pendingBatch.map((pending) => `${pending.seatId}/${pendingActionSignature(pending)}`).join("|"),
    game.events.length
  ].join(":");
}

function findMatchingPending(game: GameState, pending: PendingAction): PendingAction | undefined {
  const signature = pendingActionSignature(pending);
  return game.pendingActions.find((action) => action.seatId === pending.seatId && pendingActionSignature(action) === signature);
}

function pendingActionSignature(pending: PendingAction): string {
  if (pending.kind === "vote") return `${pending.kind}:${pending.voteType}:${pending.legalTargets.join(",")}`;
  if (pending.kind === "sheriff_withdrawal") return `${pending.kind}:${pending.voteType}`;
  if (pending.kind === "speech") return `${pending.kind}:${pending.speechType}`;
  if (pending.kind === "wolf_discussion") return `${pending.kind}:${pending.round}:${pending.currentProposal ?? ""}`;
  return pending.kind;
}

function seatNumberFor(game: GameState, seatId: PlayerId): number {
  return game.players.find((player) => player.id === seatId)?.seatNumber ?? Number.MAX_SAFE_INTEGER;
}

function centerActionLabel(
  player: GameState["players"][number] | undefined,
  pending: PendingAction | undefined,
  options: {
    aiBusy: boolean;
    autoRun: boolean;
    humanPending?: PendingAction;
    isPaused: boolean;
    readableOutputPause: ReadableOutputPause | null;
    streamingSpeech: string;
  }
): string {
  if (options.readableOutputPause && options.isPaused) return options.readableOutputPause.progressLabel ?? "等待确认";
  if (options.streamingSpeech) return "正在发表言论";
  if (options.humanPending && player?.controller === "human") return "等待你操作";
  if (options.aiBusy && player?.controller !== "human") return "正在思考";
  if (options.isPaused) return "已暂停";
  if (!pending) return options.autoRun ? "等待自动行动" : "等待继续";
  if (pending.kind === "speech" || pending.kind === "wolf_discussion" || pending.kind === "sheriff_candidacy") return "准备发言";
  if (pending.kind.includes("vote")) return "等待投票";
  return `等待${pendingLabel(pending)}`;
}

type TableSeatSide = "top" | "right" | "bottom" | "left";

function tableSeatPlacement(index: number, total: number): { x: number; y: number; side: TableSeatSide } {
  const angle = Math.PI + (Math.PI * 2 * index) / Math.max(total, 1);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const halfWidth = 42;
  const halfHeight = 36;
  const xScale = Math.abs(dx) < 0.001 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const yScale = Math.abs(dy) < 0.001 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  const scale = Math.min(xScale, yScale);
  const x = 50 + dx * scale;
  const y = 50 + dy * scale;
  const side =
    Math.abs(dx) > Math.abs(dy)
      ? dx > 0
        ? "right"
        : "left"
      : dy > 0
        ? "bottom"
        : "top";
  return { x: Math.max(8, Math.min(92, x)), y: Math.max(12, Math.min(88, y)), side };
}

function buildActionStatusText(
  game: GameState,
  humanPlayerId: PlayerId | undefined,
  humanPending: PendingAction | undefined,
  aiPending: PendingAction | undefined,
  aiBusy: boolean,
  aiElapsedSeconds: number,
  aiProgress: AIDecisionStatus | null,
  isPaused: boolean,
  autoRun: boolean,
  aiStepStatus: string
): string {
  if (game.status === "ended") return "对局已结束，可重启或退出房间。";
  if (humanPending) {
    if (humanPending.kind === "witch_action") return "轮到你进行女巫行动：先查看今晚刀口，再决定是否使用解药和毒药。没有倒计时限制。";
    return `轮到你进行${pendingLabel(humanPending)}，请在右侧提交发言或目标。没有倒计时限制。`;
  }
  if (isPaused) return "已暂停。AI 自动行动已停止，点击继续后恢复。";
  const parallelPending = parallelAIPendingActions(game);
  if (aiBusy && parallelPending.length >= 2) {
    const elapsed = aiElapsedSeconds > 0 ? `，已等待 ${aiElapsedSeconds}s` : "";
    const progress = aiProgress ? `当前状态：${displayAIProgressMessage(aiProgress)}` : "当前状态：等待 AI 返回。";
    const stuck = thinkingWatchdogText(aiProgress, aiElapsedSeconds);
    return `${parallelPending.length} 名 AI 正在并行${parallelBatchLabel(parallelPending[0])}${elapsed}。${progress}${stuck} 结果会一起写入。`;
  }
  if (aiBusy && aiPending) {
    const elapsed = aiElapsedSeconds > 0 ? `，已等待 ${aiElapsedSeconds}s` : "";
    const progress = aiProgress ? `当前状态：${displayAIProgressMessage(aiProgress)}` : "当前状态：等待 AI 返回。";
    const stuck = thinkingWatchdogText(aiProgress, aiElapsedSeconds);
    if (shouldHidePendingAction(game, aiPending, humanPlayerId)) {
      return `夜晚行动正在处理${elapsed}。${progress}${stuck} 结果会在可见时显示。`;
    }
    return `${seatName(game, aiPending.seatId)} 正在${pendingLabel(aiPending)}${elapsed}。${progress}${stuck} 发言或行动完成后会显示。`;
  }
  if (aiPending && shouldHidePendingAction(game, aiPending, humanPlayerId) && autoRun) return "夜晚行动即将自动处理。";
  if (aiPending && shouldHidePendingAction(game, aiPending, humanPlayerId)) return "夜晚行动等待 AI 处理，继续后会自动行动。";
  if (aiPending && autoRun) return `${seatName(game, aiPending.seatId)} 即将自动进行${pendingLabel(aiPending)}。`;
  if (aiPending) return `${seatName(game, aiPending.seatId)} 等待 AI 处理，继续后会自动行动。`;
  return aiStepStatus;
}

function pendingWaitingText(pending: PendingAction): string {
  if (pending.kind === "speech" || pending.kind === "wolf_discussion" || pending.kind === "sheriff_candidacy") return "等待当前玩家发言。";
  if (pending.kind === "witch_action") return "等待当前玩家决定是否使用解药和毒药。";
  return "等待当前玩家提交行动。";
}

function displayAIProgressMessage(progress: AIDecisionStatus): string {
  return cleanAIProgressMessage(progress.message);
}

function cleanAIProgressMessage(message: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/客户端已提交 AI 决策请求，等待服务端确认。/g, "AI 行动已提交，正在等待回应。"],
    [/服务端正在整理该玩家可见信息、记忆和本阶段合法动作。/g, "正在整理该玩家可见信息和本阶段可做动作。"],
    [/服务端已向模型发送请求，正在等待模型返回。/g, "AI 正在思考，等待结果。"],
    [/服务端已发送修复请求，正在等待模型返回。/g, "AI 正在校验发言格式，等待结果。"],
    [/的 AI 动作已进入服务端队列。/g, "的 AI 行动已排队处理。"],
    [/服务端/g, "系统"],
    [/客户端/g, "页面"],
    [/后台/g, "系统"],
    [/供应商/g, "模型"]
  ];
  return replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), message);
}

function visiblePhaseLabel(game: GameState, humanPlayerId?: PlayerId): string {
  return shouldHideCurrentPhaseDetails(game, humanPlayerId) ? "夜晚行动" : game.phase.label;
}

function visiblePhaseProgress(game: GameState, humanPlayerId?: PlayerId): string {
  if (shouldHideCurrentPhaseDetails(game, humanPlayerId)) return "夜晚行动中";
  if (game.phase.actingSeatId) return `${seatName(game, game.phase.actingSeatId)} 行动中`;
  return game.phase.progressLabel ?? "等待行动";
}

function visibleActingSeatId(game: GameState, humanPlayerId?: PlayerId): PlayerId | undefined {
  return shouldHideCurrentPhaseDetails(game, humanPlayerId) ? undefined : game.phase.actingSeatId;
}

function shouldHideCurrentPhaseDetails(game: GameState, humanPlayerId?: PlayerId): boolean {
  if (!PRIVATE_NIGHT_PHASES.has(game.phase.type)) return false;
  return !canViewerSeeNightPhase(game, humanPlayerId, game.phase.type, game.phase.actingSeatId);
}

function shouldHidePendingAction(game: GameState, pending: PendingAction, humanPlayerId?: PlayerId): boolean {
  if (!PRIVATE_NIGHT_ACTIONS.has(pending.kind)) return false;
  return !canViewerSeeNightPhase(game, humanPlayerId, game.phase.type, pending.seatId, pending.kind);
}

function canViewerSeeNightPhase(
  game: GameState,
  humanPlayerId: PlayerId | undefined,
  phaseType: GameState["phase"]["type"],
  actingSeatId?: PlayerId,
  pendingKind?: PendingAction["kind"]
): boolean {
  if (game.setup.debugMode.revealRoles || game.setup.debugMode.revealNightActions || game.setup.debugMode.revealWolfChat) return true;
  const human = humanPlayerId ? game.players.find((player) => player.id === humanPlayerId) : undefined;
  if (!human) return false;
  if (!human.alive) return true;
  if ((phaseType === "night_wolves" || pendingKind === "wolf_discussion") && human.role === "werewolf") return true;
  return actingSeatId === human.id;
}

function thinkingWatchdogText(progress: AIDecisionStatus | null, elapsedSeconds: number): string {
  const elapsedMs = elapsedSeconds * 1000;
  const expectedMs = progress?.expectedThinkingMs ?? (progress?.timeoutMs ? Math.floor(progress.timeoutMs * 0.7) : undefined);
  if (progress?.timeoutMs && elapsedMs >= progress.timeoutMs) return " 已超过常规等待时间，仍在等待 AI 返回。";
  if (expectedMs !== undefined && elapsedMs >= expectedMs) return " 已超过该思考档位的常规等待，仍在等待 AI 返回。";
  return "";
}

function TabBar({ active, onChange }: { active: GameSideTab; onChange: (tab: GameSideTab) => void }): JSX.Element {
  const tabs: Array<{ id: GameSideTab; label: string }> = [
    { id: "chat", label: "聊天" },
    { id: "votes", label: "票型" },
    { id: "exposure", label: "暴露模式" },
    { id: "records", label: "记录" },
    { id: "rules", label: "规则" }
  ];
  return (
    <nav className="tabs">
      {tabs.map((tab) => (
        <button className={active === tab.id ? "selected" : ""} key={tab.id} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

function ActionPanel({
  game,
  visibleEvents,
  humanPending,
  selectedTarget,
  setSelectedTarget,
  witchSave,
  setWitchSave,
  witchPoisonTarget,
  setWitchPoisonTarget,
  speechText,
  setSpeechText,
  wolfAgree,
  setWolfAgree,
  sheriffRun,
  setSheriffRun,
  canWithdrawSheriff,
  onSubmitHuman,
  onWithdrawSheriff
}: {
  game: GameState;
  visibleEvents: ReturnType<typeof getVisibleEvents>;
  humanPending?: PendingAction;
  selectedTarget: PlayerId | "abstain" | "skip" | "destroy";
  setSelectedTarget: (value: PlayerId | "abstain" | "skip" | "destroy") => void;
  witchSave: boolean;
  setWitchSave: (value: boolean) => void;
  witchPoisonTarget: PlayerId | "skip";
  setWitchPoisonTarget: (value: PlayerId | "skip") => void;
  speechText: string;
  setSpeechText: (value: string) => void;
  wolfAgree: boolean;
  setWolfAgree: (value: boolean) => void;
  sheriffRun: boolean;
  setSheriffRun: (value: boolean) => void;
  canWithdrawSheriff: boolean;
  onSubmitHuman: () => void;
  onWithdrawSheriff: () => void;
}): JSX.Element {
  const legal = humanPending ? legalTargetsFor(humanPending) : [];
  const allowAbstain = game.rulePreset.voteRules.allowAbstain;
  const chatEvents = visibleEvents.filter(
    (event) =>
      event.type === "SpeechPublished" ||
      event.type === "LastWordsPublished" ||
      event.type === "WolfDiscussionMessage" ||
      event.type === "WolfSelfExploded" ||
      event.type === "SheriffCandidatesAnnounced" ||
      event.type === "NightDeathsAnnounced"
  );
  return (
    <div className="tab-content">
      <section className="chat-history">
        <div className="panel-title">
          <FileText size={17} />
          聊天
        </div>
        {chatEvents.length === 0 ? (
          <p className="muted">暂无公开发言。</p>
        ) : (
          chatEvents.slice(-18).map((event) => (
            <article className="chat-message" key={event.id}>
              <div className="avatar mini">{seatName(game, event.seatId).slice(0, 1)}</div>
              <div>
                <header>
                  <strong>{seatName(game, event.seatId)}</strong>
                  <span>#{event.seq}</span>
                </header>
                <p>{eventSummary(game, event.type, event.payload, event.seatId)}</p>
              </div>
            </article>
          ))
        )}
      </section>

      <section className={`control-group ${humanPending ? "active-action" : ""}`}>
        <div className="panel-title">
          <Vote size={17} />
          发言 / 投票
        </div>
        {!humanPending ? (
          canWithdrawSheriff ? (
            <div className="action-form">
              <p className="pending-label">你仍在警上，可在投票前退水。</p>
              <button className="ghost-button" onClick={onWithdrawSheriff}>
                退水
              </button>
            </div>
          ) : (
            <p className="muted">当前没有等待你输入的动作，AI 会自动行动；需要暂停时使用顶部按钮。</p>
          )
        ) : (
          <div className="action-form">
            <p className="pending-label">轮到你 · {pendingLabel(humanPending)} · {seatName(game, humanPending.seatId)}</p>
            {(humanPending.kind === "speech" || humanPending.kind === "wolf_discussion") && (
              <textarea value={speechText} onChange={(event) => setSpeechText(event.target.value)} rows={5} />
            )}
            {humanPending.kind === "guard_protect" && (
              <div className="guard-skip-control">
                <Toggle label="本晚空守" checked={selectedTarget === "skip"} onChange={(checked) => setSelectedTarget(checked ? "skip" : legal[0])} />
                <p className="muted">开启后今晚不守任何人，用于规避连续机械守护或守救冲突。</p>
              </div>
            )}
            {legal.length > 0 && humanPending.kind !== "witch_action" && (
              <label>
                目标
                <select
                  value={selectedTarget}
                  disabled={humanPending.kind === "guard_protect" && selectedTarget === "skip"}
                  onChange={(event) => setSelectedTarget(event.target.value as PlayerId | "abstain" | "skip" | "destroy")}
                >
                  {humanPending.kind === "vote" && allowAbstain && <option value="abstain">弃票</option>}
                  {humanPending.kind === "guard_protect" && <option value="skip">空守</option>}
                  {humanPending.kind === "hunter_shot" && <option value="skip">不开枪</option>}
                  {humanPending.kind === "badge_decision" && <option value="destroy">撕毁警徽</option>}
                  {legal.map((id) => (
                    <option value={id} key={id}>
                      {seatName(game, id)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {humanPending.kind === "witch_action" && (
              <div className="witch-action-flow">
                <div className="witch-step">
                  <span>1</span>
                  <div>
                    <strong>今晚刀口</strong>
                    <p>{humanPending.wolfTarget ? `狼人今晚击杀：${seatName(game, humanPending.wolfTarget)}。` : "今晚没有狼人刀口。"}</p>
                  </div>
                </div>
                <div className="witch-step">
                  <span>2</span>
                  <div>
                    <strong>解药</strong>
                    {humanPending.canSave && humanPending.wolfTarget ? (
                      <Toggle label={`使用解药救 ${seatName(game, humanPending.wolfTarget)}`} checked={witchSave} onChange={setWitchSave} />
                    ) : (
                      <p className="muted">{humanPending.wolfTarget ? "当前不能使用解药。" : "没有刀口，不需要使用解药。"}</p>
                    )}
                  </div>
                </div>
                <div className="witch-step">
                  <span>3</span>
                  <div>
                    <strong>毒药</strong>
                    {humanPending.canPoison && (!witchSave || game.rulePreset.witchRules.allowSaveAndPoisonSameNight) ? (
                      <label>
                        毒药目标
                        <select value={witchPoisonTarget} onChange={(event) => setWitchPoisonTarget(event.target.value as PlayerId | "skip")}>
                          <option value="skip">不使用毒药</option>
                          {legal.map((id) => (
                            <option value={id} key={id}>
                              {seatName(game, id)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <p className="muted">{witchSave && !game.rulePreset.witchRules.allowSaveAndPoisonSameNight ? "本规则下同晚不能同时使用解药和毒药。" : "毒药已不可用。"}</p>
                    )}
                  </div>
                </div>
              </div>
            )}
            {humanPending.kind === "wolf_discussion" && (
              <Toggle label="同意当前提案" checked={wolfAgree} onChange={setWolfAgree} />
            )}
            {humanPending.kind === "sheriff_candidacy" && <Toggle label="上警竞选" checked={sheriffRun} onChange={setSheriffRun} />}
            {humanPending.kind === "sheriff_withdrawal" && <Toggle label="继续竞选" checked={sheriffRun} onChange={setSheriffRun} />}
            <div className="button-row">
              <button className="primary-button" onClick={onSubmitHuman}>
                <Save size={16} />
                提交
              </button>
              {canWithdrawSheriff && (
                <button className="ghost-button" onClick={onWithdrawSheriff}>
                  退水
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function RecordPanel({ events, game }: { events: ReturnType<typeof getVisibleEvents>; game: GameState }): JSX.Element {
  return (
    <div className="tab-content">
      <section className="compact-table">
        <h3>公开/可见记录</h3>
        {events.slice(-24).map((event) => (
          <div className="log-line" key={event.id}>
            <span>#{event.seq}</span>
            <p>{eventSummary(game, event.type, event.payload, event.seatId)}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

function VotePanel({ game, events }: { game: GameState; events: ReturnType<typeof getVisibleEvents> }): JSX.Element {
  const votes = events.filter((event) => event.type === "VoteCast" || event.type === "DayVoteResolved" || event.type === "SheriffVoteResolved");
  return (
    <div className="tab-content">
      <section className="compact-table">
        <h3>投票记录</h3>
        {votes.map((event) => (
          <div className="log-line" key={event.id}>
            <span>{seatName(game, event.seatId)}</span>
            <p>{eventSummary(game, event.type, event.payload, event.seatId)}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

function RulesPanel(): JSX.Element {
  return (
    <div className="tab-content">
      <section className="rules-list">
        <div className="panel-title">
          <Shield size={17} />
          {STANDARD_PRESET.name}
        </div>
        <p>6-12 人标准渐进规则包，默认启用警长、预言家、女巫、猎人、守卫，胜利条件为屠边。</p>
        <ul>
          <li>夜晚顺序：守卫 → 狼人私聊并刀人 → 预言家查验 → 女巫行动 → 死亡结算。</li>
          <li>狼人每晚最多 3 轮私聊，全员同意同一目标会提前锁刀。</li>
          <li>存活狼人可在公开回合随时自爆；自爆后该狼出局，当前回合结束并直接进入夜晚。</li>
          <li>警长白天投票权重为 1.5，首次平票进入 PK，再平票无人当选或无人出局。</li>
          <li>女巫解药和毒药各一次，默认同晚不能同时救毒，首夜允许自救。</li>
        </ul>
      </section>
      <section className="compact-table">
        <h3>规则包配置</h3>
        <div className="rule-config-grid">
          <div>
            <span>人数范围</span>
            <strong>{STANDARD_PRESET.minPlayers}-{STANDARD_PRESET.maxPlayers}</strong>
          </div>
          <div>
            <span>身份分配</span>
            <strong>{STANDARD_PRESET.roleAllocator}</strong>
          </div>
          <div>
            <span>警长竞选</span>
            <strong>{STANDARD_PRESET.sheriffEnabled ? "启用" : "关闭"}</strong>
          </div>
          <div>
            <span>胜利条件</span>
            <strong>{STANDARD_PRESET.winCondition === "slay_side" ? "屠边" : "屠城"}</strong>
          </div>
          <div>
            <span>弃票</span>
            <strong>{STANDARD_PRESET.voteRules.allowAbstain ? "允许" : "禁止"}</strong>
          </div>
          <div>
            <span>警长票权</span>
            <strong>{STANDARD_PRESET.voteRules.sheriffVoteWeight}</strong>
          </div>
          <div>
            <span>再次平票</span>
            <strong>{STANDARD_PRESET.voteRules.secondTiePolicy === "no_exile" ? "无人出局" : "随机出局"}</strong>
          </div>
          <div>
            <span>守救同目标</span>
            <strong>{STANDARD_PRESET.witchRules.guardSaveSameTargetDies ? "死亡" : "不死亡"}</strong>
          </div>
        </div>
      </section>
      <section className="compact-table">
        <h3>身份人数表</h3>
        <div className="role-count-table">
          {Object.entries(STANDARD_PRESET.roleTable)
            .sort(([left], [right]) => Number(left) - Number(right))
            .map(([totalPlayers, roles]) => (
              <div className="role-count-row" key={totalPlayers}>
                <strong>{totalPlayers} 人</strong>
                <span>{formatRoleCounts(roles)}</span>
              </div>
            ))}
        </div>
      </section>
      <section className="compact-table">
        <h3>游戏身份牌配置</h3>
        <div className="role-card-grid">
          {Object.values(ROLE_DEFINITIONS).map((role) => (
            <div className="role-config-card" key={role.id}>
              <div>
                <strong>{role.name}</strong>
                <span>{teamLabel(role.team)} · {role.category}</span>
              </div>
              <p>{role.publicDescription}</p>
              <p>{role.privateDescription}</p>
              <dl>
                <div>
                  <dt>默认启用</dt>
                  <dd>{STANDARD_PRESET.enabledRoles.includes(role.id) ? "是" : "否"}</dd>
                </div>
                <div>
                  <dt>适用人数</dt>
                  <dd>{roleUsageRange(role.id)}</dd>
                </div>
                <div>
                  <dt>夜间阶段</dt>
                  <dd>{roleNightPhase(role.id)}</dd>
                </div>
                <div>
                  <dt>能力模板</dt>
                  <dd>{roleAbilityTemplate(role.id)}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function formatRoleCounts(roles: RoleId[]): string {
  const counts = new Map<RoleId, number>();
  for (const role of roles) {
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return [...counts.entries()].map(([role, count]) => `${ROLE_DEFINITIONS[role].name} x${count}`).join("、");
}

function roleUsageRange(roleId: RoleId): string {
  const totals = Object.entries(STANDARD_PRESET.roleTable)
    .filter(([, roles]) => roles.includes(roleId))
    .map(([total]) => Number(total));
  if (totals.length === 0) return "未加入当前规则包";
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  return min === max ? `${min} 人` : `${min}-${max} 人`;
}

function teamLabel(team: string): string {
  return team === "wolves" ? "狼人阵营" : "好人阵营";
}

function roleNightPhase(roleId: RoleId): string {
  const phases: Partial<Record<RoleId, string>> = {
    werewolf: "wolf_discussion",
    seer: "seer_check",
    witch: "witch_action",
    guard: "guard_protect"
  };
  return phases[roleId] ?? "无夜间阶段";
}

function roleAbilityTemplate(roleId: RoleId): string {
  const templates: Record<RoleId, string> = {
    werewolf: "夜间单目标击杀",
    villager: "无技能，发言投票",
    seer: "夜间单目标查验",
    witch: "一次性解救 / 一次性毒杀",
    hunter: "死亡开枪",
    guard: "夜间单目标守护"
  };
  return templates[roleId];
}

function ApiAccessPanel({
  config,
  readinessConfig,
  setConfig,
  configStatus,
  providerTestStatus,
  providerTestResults,
  providerApiKeys,
  onProviderApiKeyChange,
  onProviderConfigChange,
  onSave,
  onTestProvider,
  aiMode,
  setAiMode,
  onOpenRules
}: {
  config: AIConfigStore;
  readinessConfig: AIConfigStore;
  setConfig: (config: AIConfigStore) => void;
  configStatus: string;
  providerTestStatus: string;
  providerTestResults: ProviderTestResults;
  providerApiKeys: LocalProviderApiKeys;
  onProviderApiKeyChange: (providerId: string, apiKey: string) => void;
  onProviderConfigChange: (providerId: string) => void;
  onSave: () => void;
  onTestProvider: (provider: ProviderAccount) => void;
  aiMode: "mock" | "llm";
  setAiMode: (value: "mock" | "llm") => void;
  onOpenRules: () => void;
}): JSX.Element {
  const [selectedProviderId, setSelectedProviderId] = useState(() => preferredProviderId(config.providers));
  const didAutoSelectRealProvider = useRef(false);
  const selectedProvider = config.providers.find((provider) => provider.id === selectedProviderId) ?? config.providers[0];
  const apiSummary = buildApiAccessSummary(readinessConfig, providerApiKeys, providerTestResults);
  const testedProviders = config.providers.filter((provider) => providerTestResults[provider.id]);

  useEffect(() => {
    const preferred = preferredProviderId(config.providers);
    if (!selectedProvider || !config.providers.some((provider) => provider.id === selectedProviderId)) {
      setSelectedProviderId(preferred);
      return;
    }
    if (!didAutoSelectRealProvider.current && !isRealProvider(selectedProvider) && preferred && preferred !== selectedProvider.id) {
      didAutoSelectRealProvider.current = true;
      setSelectedProviderId(preferred);
    }
  }, [config.providers, selectedProvider, selectedProviderId]);

  function updateProvider(id: string, patch: Partial<ProviderAccount>): void {
    onProviderConfigChange(id);
    setConfig({ ...config, providers: config.providers.map((provider) => (provider.id === id ? { ...provider, ...patch } : provider)) });
  }

  function updateProviderType(id: string, type: ProviderType): void {
    const preset = PROVIDER_PRESETS[type];
    onProviderConfigChange(id);
    setConfig({
      ...config,
      providers: config.providers.map((provider) =>
        provider.id === id
          ? {
              ...provider,
              ...preset,
              id: provider.id
            }
          : provider
      )
    });
  }

  function addProvider(type: ProviderType = "openai_compatible"): void {
    const id = `provider-${Date.now()}`;
    setConfig({
      ...config,
      providers: [...config.providers, { id, ...PROVIDER_PRESETS[type] }]
    });
    setSelectedProviderId(id);
  }

  const selectedProviderModels = selectedProvider ? providerModelOptions(config, selectedProvider.id) : [];
  const selectedModelInList = Boolean(selectedProvider && selectedProviderModels.some((model) => model.name === selectedProvider.defaultModel));
  const selectedThinkingMode = selectedProvider ? providerThinkingMode(selectedProvider) : "auto";
  const selectedReasoningEffort = selectedProvider ? providerReasoningEffort(selectedProvider) : "medium";
  const showDeepSeekThinkingNote = Boolean(selectedProvider && isDeepSeekProvider(selectedProvider));
  const reasoningEffortOptions = showDeepSeekThinkingNote ? DEEPSEEK_REASONING_EFFORT_OPTIONS : REASONING_EFFORT_OPTIONS;

  return (
    <div className="api-access-layout">
      <div className="api-main-column">
        <section className="api-panel api-mode-panel">
          <div className="panel-title">
            <Bot size={17} />
            接入模式
          </div>
          <div className="mode-choice-grid">
            <button className={aiMode === "mock" ? "selected" : ""} onClick={() => setAiMode("mock")}>
              <strong>Mock AI</strong>
              <span>使用内置模拟 AI 测试规则和流程</span>
            </button>
            <button className={aiMode === "llm" ? "selected" : ""} onClick={() => setAiMode("llm")}>
              <strong>真实供应商</strong>
              <span>使用外部 API 服务进行真实跑局</span>
            </button>
          </div>
        </section>

        <section className="api-panel provider-setup-panel">
          <div className="section-head">
            <div className="panel-title">
              <Settings size={17} />
              供应商配置
            </div>
            <button className="ghost-button" onClick={() => addProvider()}>
              <Plus size={16} />
              添加供应商
            </button>
          </div>
          {selectedProvider ? (
            <>
              <div className="provider-picker-row">
                <label>
                  当前编辑
                  <select value={selectedProvider.id} onChange={(event) => setSelectedProviderId(event.target.value)}>
                    {config.providers.map((provider) => (
                      <option value={provider.id} key={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className={`status-chip ${providerTestClass(providerTestResults[selectedProvider.id])}`}>
                  {providerTestLabel(providerTestResults[selectedProvider.id])}
                </span>
              </div>
              <div className="api-form-grid">
                <label>
                  供应商
                  <div className="split-field">
                    <input value={selectedProvider.name} onChange={(event) => updateProvider(selectedProvider.id, { name: event.target.value })} />
                    <select value={selectedProvider.type} onChange={(event) => updateProviderType(selectedProvider.id, event.target.value as ProviderType)}>
                      <option value="openai">OpenAI</option>
                      <option value="openai_compatible">OpenAI Compatible</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="gemini">Gemini</option>
                      <option value="xai">xAI</option>
                      <option value="codex_cli_local">Codex Local</option>
                    </select>
                  </div>
                </label>
                <label>
                  Base URL
                  <input value={selectedProvider.baseUrl} onChange={(event) => updateProvider(selectedProvider.id, { baseUrl: event.target.value })} />
                </label>
                <label>
                  API Key
                  <input
                    type="password"
                    value={providerApiKeys[selectedProvider.id] ?? ""}
                    placeholder={isRealProvider(selectedProvider) ? "粘贴供应商给你的密钥" : "Mock 模式不需要密钥"}
                    onChange={(event) => onProviderApiKeyChange(selectedProvider.id, event.target.value)}
                    disabled={!isRealProvider(selectedProvider)}
                  />
                </label>
                <label>
                  默认模型
                  <div className="model-field">
                    <select
                      value={selectedModelInList ? selectedProvider.defaultModel : "__custom__"}
                      onChange={(event) => {
                        if (event.target.value !== "__custom__") updateProvider(selectedProvider.id, { defaultModel: event.target.value });
                      }}
                    >
                      <option value="__custom__">手动输入模型名</option>
                      {selectedProviderModels.map((model) => (
                        <option value={model.name} key={model.id}>
                          {model.displayName || model.name}
                        </option>
                      ))}
                    </select>
                    <input
                      value={selectedProvider.defaultModel}
                      placeholder={selectedProviderModels.length ? "也可以手动输入其他模型名" : "测试连接后可选择，或直接手动填写"}
                      onChange={(event) => updateProvider(selectedProvider.id, { defaultModel: event.target.value })}
                    />
                  </div>
                </label>
                <label>
                  thinking
                  <select
                    value={selectedThinkingMode}
                    onChange={(event) => updateProvider(selectedProvider.id, { thinkingMode: event.target.value as ThinkingMode })}
                    disabled={!isRealProvider(selectedProvider)}
                  >
                    {THINKING_MODE_OPTIONS.map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  reasoning_effort
                  <select
                    value={selectedReasoningEffort}
                    onChange={(event) => updateProvider(selectedProvider.id, { reasoningEffort: event.target.value as ReasoningEffort })}
                    disabled={!providerSupportsReasoningEffort(selectedProvider)}
                  >
                    {reasoningEffortOptions.map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="field-note api-form-note">
                  {showDeepSeekThinkingNote
                    ? "DeepSeek 支持 thinking=enabled/disabled；reasoning_effort 只提供官方 high/max。开启 thinking 会产生 reasoning tokens。"
                    : providerSupportsReasoningEffort(selectedProvider)
                      ? "reasoning_effort 会随真实模型请求发送；thinking=auto 表示由模型或供应商默认策略处理。"
                      : "当前供应商未声明支持 reasoning_effort；该值会保存，但真实请求不会发送。"}
                </p>
              </div>
              <div className="api-action-row">
                <button className="primary-button" onClick={() => onTestProvider(selectedProvider)} disabled={!selectedProvider.enabled}>
                  <Eye size={16} />
                  测试连接
                </button>
                <button className="ghost-button" onClick={() => onProviderApiKeyChange(selectedProvider.id, "")} disabled={!providerApiKeys[selectedProvider.id]}>
                  清除密钥
                </button>
                <label className="switch-field">
                  <input type="checkbox" checked={selectedProvider.enabled} onChange={(event) => updateProvider(selectedProvider.id, { enabled: event.target.checked })} />
                  <span>启用</span>
                </label>
                <button className="ghost-button" onClick={onSave}>
                  <Save size={16} />
                  保存配置
                </button>
              </div>
              <p className="muted">{configStatus}</p>
              {providerTestStatus && <p className="muted">{providerTestStatus}</p>}
            </>
          ) : (
            <p className="muted">暂无供应商配置，请先添加一个供应商。</p>
          )}
        </section>

        <section className="api-panel">
          <div className="section-head">
            <h3>已配置的供应商</h3>
            <span className="muted">启用的真实供应商会按列表顺序优先使用</span>
          </div>
          <div className="provider-table">
            <div className="provider-table-head">
              <span>供应商名称</span>
              <span>类型</span>
              <span>默认模型</span>
              <span>密钥状态</span>
              <span>连接测试</span>
              <span>启用</span>
            </div>
            {config.providers.map((provider) => (
              <div
                className={`provider-table-row ${selectedProvider?.id === provider.id ? "selected" : ""}`}
                key={provider.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedProviderId(provider.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") setSelectedProviderId(provider.id);
                }}
              >
                <strong>{provider.name}</strong>
                <span>{providerTypeLabel(provider.type)}</span>
                <span>{provider.defaultModel || "-"}</span>
                <span className={`status-chip ${providerKeyClass(provider, providerApiKeys)}`}>{providerKeyLabel(provider, providerApiKeys)}</span>
                <span className={`status-chip ${providerTestClass(providerTestResults[provider.id])}`}>{providerTestLabel(providerTestResults[provider.id])}</span>
                <label className="switch-only" onClick={(event) => event.stopPropagation()}>
                  <input type="checkbox" checked={provider.enabled} onChange={(event) => updateProvider(provider.id, { enabled: event.target.checked })} />
                  <span />
                </label>
              </div>
            ))}
          </div>
        </section>
      </div>

      <aside className="api-side-column">
        <section className={`api-panel readiness-panel ${apiSummary.ready ? "ready" : "pending"}`}>
          <div className="panel-title">
            <Bot size={17} />
            接入状态检查
          </div>
          <div className="readiness-list compact">
            {apiSummary.items.map((item) => (
              <div className={`readiness-item ${item.ok ? "ok" : "warn"}`} key={item.label}>
                <strong>{item.ok ? "通过" : "待补"}</strong>
                <span>{item.label}</span>
                <p>{item.detail}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="api-panel">
          <div className="panel-title">
            <FileText size={17} />
            上下文策略
          </div>
          <Toggle
            label="长局自动压缩"
            checked={isContextCompressionAuto(config.contextCompression)}
            onChange={(checked) => setConfig({ ...config, contextCompression: contextCompressionFromToggle(checked) })}
          />
          <p className="muted">公开记录优先全文；超过模型上下文时自动压缩为关键事实。</p>
        </section>
        <section className="api-panel help-panel">
          <h3>如何填写</h3>
          <div className="help-row">
            <strong>供应商</strong>
            <p>选择你正在使用的 AI 服务商，例如 OpenAI、DeepSeek 或其他兼容接口。</p>
          </div>
          <div className="help-row">
            <strong>Base URL</strong>
            <p>填写供应商给你的接口地址，通常以 https:// 开头。</p>
          </div>
          <div className="help-row">
            <strong>API Key</strong>
            <p>在供应商控制台创建密钥后粘贴到这里，只保存在当前浏览器。</p>
          </div>
          <div className="help-row">
            <strong>默认模型</strong>
            <p>填写你要用于跑局的模型名，例如 deepseek-chat。</p>
          </div>
          <div className="help-row">
            <strong>thinking</strong>
            <p>控制供应商是否启用思考参数；DeepSeek 开启后会产生 reasoning tokens，关闭时不发送 reasoning_effort。</p>
          </div>
          <div className="help-row">
            <strong>reasoning_effort</strong>
            <p>控制支持该参数的模型推理强度；如果与 thinking 冲突，请求层会优先避免接口报错。</p>
          </div>
        </section>
        <section className="api-panel">
          <div className="section-head">
            <h3>最近连接测试</h3>
            <span className="muted">{testedProviders.length ? `${testedProviders.length} 条` : "暂无"}</span>
          </div>
          {testedProviders.length > 0 ? (
            <div className="test-log-list">
              {testedProviders.map((provider) => (
                <div className="test-log-row" key={provider.id}>
                  <span className={`status-dot ${providerTestClass(providerTestResults[provider.id])}`} />
                  <strong>{provider.name}</strong>
                  <span>{providerTestLabel(providerTestResults[provider.id])}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">点击“测试连接”后会在这里显示结果。</p>
          )}
        </section>
        <section className="api-panel">
          <div className="panel-title">
            <FileText size={17} />
            游戏规则说明
          </div>
          <p className="muted">狼人、预言家、女巫等身份由游戏规则和创建房间流程自动分配，不属于 API 接入设置。</p>
          <button className="ghost-button full-width" onClick={onOpenRules}>
            前往游戏规则
            <StepForward size={16} />
          </button>
        </section>
      </aside>
    </div>
  );
}

function DebugPanel({
  game,
  batchResult,
  debugStatus,
  onExportMarkdown,
  onExportJson,
  onExportSnapshot,
  onImportSnapshot,
  onForceKill,
  onRunMockBatch,
  onStepAI,
  aiBusy,
  contextCompression,
  onContextCompressionChange
}: {
  game: GameState;
  batchResult: MockBatchRunResult | null;
  debugStatus: string;
  aiBusy: boolean;
  contextCompression: ContextCompressionConfig;
  onContextCompressionChange: (config: ContextCompressionConfig) => void;
  onExportMarkdown: () => void;
  onExportJson: () => void;
  onExportSnapshot: () => void;
  onImportSnapshot: (event: ChangeEvent<HTMLInputElement>) => void;
  onForceKill: (seatId: PlayerId) => void;
  onRunMockBatch: () => void;
  onStepAI: () => void;
}): JSX.Element {
  const totalInput = game.llmCalls.reduce((sum, call) => sum + call.inputTokens, 0);
  const totalOutput = game.llmCalls.reduce((sum, call) => sum + call.outputTokens, 0);
  const totalReasoning = game.llmCalls.reduce((sum, call) => sum + call.reasoningTokens, 0);
  const totalCached = game.llmCalls.reduce((sum, call) => sum + call.cachedTokens, 0);
  const totalCost = game.llmCalls.reduce((sum, call) => sum + call.estimatedCost, 0);
  const failedCalls = game.llmCalls.filter((call) => call.error).length;
  const totalRetries = game.llmCalls.reduce((sum, call) => sum + call.retryCount, 0);
  const averageCost = game.llmCalls.length > 0 ? totalCost / game.llmCalls.length : 0;
  const mostExpensiveCall = game.llmCalls.reduce<LLMCallLog | undefined>(
    (current, call) => (!current || call.estimatedCost > current.estimatedCost ? call : current),
    undefined
  );
  const byPlayer = summarizeCalls(game.llmCalls, (call) => (call.seatId ? seatName(game, call.seatId) : "-"));
  const byProvider = summarizeCalls(game.llmCalls, (call) => call.provider);
  const byModel = summarizeCalls(game.llmCalls, (call) => `${call.provider} / ${call.model}`);
  const byPhase = summarizeCalls(game.llmCalls, (call) => call.phase);
  const alivePlayers = game.players.filter((player) => player.alive);
  const [debugTarget, setDebugTarget] = useState<PlayerId>(alivePlayers[0]?.id ?? "");
  const alivePlayerIds = alivePlayers.map((player) => player.id).join("|");
  const reasonEvents = game.events
    .map((event) => ({
      event,
      privateReason: typeof (event.payload as { privateReason?: unknown }).privateReason === "string" ? (event.payload as { privateReason: string }).privateReason : ""
    }))
    .filter((item) => item.privateReason.trim().length > 0);

  useEffect(() => {
    if (!alivePlayers.some((player) => player.id === debugTarget)) {
      setDebugTarget(alivePlayers[0]?.id ?? "");
    }
  }, [alivePlayerIds, debugTarget]);

  return (
    <div className="tab-content">
      <section className="compact-table exposure-primary">
        <h3>身份总览</h3>
        <div className="role-exposure-grid">
          {game.players.map((player) => {
            const role = ROLE_DEFINITIONS[player.role];
            return (
              <article className={`exposure-player ${player.alive ? "" : "dead"}`} key={player.id}>
                <div className="avatar small">{player.avatar}</div>
                <div>
                  <strong>{player.seatNumber}号 {player.name}</strong>
                  <p>{role.name} · {teamLabel(role.team)} · {player.alive ? "存活" : deathReason(player.death?.reason)}</p>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <section className="compact-table">
        <h3>后台理由 / 思考日志</h3>
        {reasonEvents.length === 0 ? (
          <p className="muted">暂无后台理由。真实 AI 或 Mock AI 产生行动后会在这里记录，不会出现在普通视角。</p>
        ) : (
          reasonEvents.slice(-18).map(({ event, privateReason }) => (
            <div className="log-line" key={event.id}>
              <span>#{event.seq} {seatName(game, event.seatId)}</span>
              <p>
                <strong>{eventName(event.type)}</strong>：{privateReason}
              </p>
            </div>
          ))
        )}
      </section>
      <section className="compact-table">
        <h3>最近 AI 调用</h3>
        {game.llmCalls.length === 0 ? (
          <p className="muted">暂无真实模型调用。DeepSeek 或其他真实供应商测试后会显示调用、解析结果和脱敏 prompt。</p>
        ) : (
          game.llmCalls.slice(-8).map((call) => {
            const reasoningTrace = extractReasoningTrace(call.rawResponse);
            return (
              <details className="call-detail" key={call.id}>
                <summary>
                  <span>{seatName(game, call.seatId)}</span>
                  <strong>{call.phase} · {call.provider} · {call.model}</strong>
                </summary>
                <p>{call.privateRationale || "暂无私有推理摘要。"}</p>
                <div className="call-metrics">
                  <span>输入 {call.inputTokens}</span>
                  <span>输出 {call.outputTokens}</span>
                  <span>推理 {call.reasoningTokens}</span>
                  <span>缓存 {call.cachedTokens}</span>
                  <span>费用 {call.estimatedCost.toFixed(6)}</span>
                  <span>耗时 {call.latencyMs}ms</span>
                  <span>重试 {call.retryCount}</span>
                  {call.promptCompressionLevel && <span>上下文 {call.promptCompressionLevel}</span>}
                  {call.estimatedInputTokens !== undefined && <span>估算 {call.estimatedInputTokens}/{call.promptBudgetTokens ?? "-"}</span>}
                  <span>Prompt {call.promptHash}</span>
                </div>
                {call.error && <p className="call-error">{call.error}</p>}
                <div className="reasoning-trace">
                  <strong>模型 thinking / reasoning_content</strong>
                  {reasoningTrace ? <pre>{reasoningTrace}</pre> : <p className="muted">本次响应没有返回 thinking / reasoning_content。</p>}
                </div>
                <strong className="call-block-title">解析结果</strong>
                <pre>{JSON.stringify(call.parsedJson, null, 2)}</pre>
                {call.promptTextRedacted && (
                  <>
                    <strong className="call-block-title">Prompt 预览</strong>
                    <pre>{call.promptTextRedacted}</pre>
                  </>
                )}
                {call.rawResponse && (
                  <details className="raw-response-detail">
                    <summary>原始返回</summary>
                    <pre>{call.rawResponse}</pre>
                  </details>
                )}
              </details>
            );
          })
        )}
      </section>
      <section className="control-group">
        <div className="panel-title">
          <FileText size={17} />
          暴露模式与导出
        </div>
        <div className="button-row">
          <button className="ghost-button" onClick={onExportMarkdown}>
            <Download size={16} />
            Markdown
          </button>
          <button className="ghost-button" onClick={onExportJson}>
            <FileJson size={16} />
            JSON 事件
          </button>
          <button className="ghost-button" onClick={onExportSnapshot}>
            <FileJson size={16} />
            测试用例
          </button>
          <label className="ghost-button file-button">
            <Upload size={16} />
            导入测试用例
            <input type="file" accept="application/json,.json" onChange={onImportSnapshot} />
          </label>
        </div>
        {debugStatus && <p className="muted">{debugStatus}</p>}
        <div className="stats-grid">
          <div>
            <span>调用次数</span>
            <strong>{game.llmCalls.length}</strong>
          </div>
          <div>
            <span>失败调用</span>
            <strong>{failedCalls}</strong>
          </div>
          <div>
            <span>重试次数</span>
            <strong>{totalRetries}</strong>
          </div>
          <div>
            <span>输入 Token</span>
            <strong>{totalInput}</strong>
          </div>
          <div>
            <span>输出 Token</span>
            <strong>{totalOutput}</strong>
          </div>
          <div>
            <span>推理 Token</span>
            <strong>{totalReasoning}</strong>
          </div>
          <div>
            <span>缓存 Token</span>
            <strong>{totalCached}</strong>
          </div>
          <div>
            <span>费用估算</span>
            <strong>{totalCost.toFixed(4)}</strong>
          </div>
          <div>
            <span>平均费用</span>
            <strong>{averageCost.toFixed(6)}</strong>
          </div>
          <div>
            <span>最贵调用</span>
            <strong>{(mostExpensiveCall?.estimatedCost ?? 0).toFixed(6)}</strong>
          </div>
        </div>
      </section>
      <section className="control-group">
        <h3>手动调试</h3>
        <Toggle
          label="本局上下文压缩"
          checked={isContextCompressionAuto(contextCompression)}
          onChange={(checked) => onContextCompressionChange(contextCompressionFromToggle(checked))}
        />
        <p className="muted">只影响本局后续 AI 请求，不保存到管理控制台。</p>
        <button className="ghost-button" onClick={onStepAI} disabled={game.status === "ended" || aiBusy}>
          <StepForward size={16} />
          {aiBusy ? "AI 思考中" : "调试推进 1 个 AI 动作"}
        </button>
        {game.setup.debugMode.allowManualOverride ? (
          <>
            <label>
              强制死亡
              <select value={debugTarget} onChange={(event) => setDebugTarget(event.target.value)}>
                {alivePlayers.map((player) => (
                  <option value={player.id} key={player.id}>
                    {seatName(game, player.id)}
                  </option>
                ))}
              </select>
            </label>
            <button className="ghost-button" onClick={() => onForceKill(debugTarget)} disabled={!debugTarget}>
              <Skull size={16} />
              强制死亡
            </button>
          </>
        ) : (
          <p className="muted">开局前开启“手动调试”后可使用强制死亡工具。</p>
        )}
      </section>
      <section className="control-group">
        <h3>Mock 批量跑局</h3>
        <button className="ghost-button" onClick={onRunMockBatch}>
          <StepForward size={16} />
          Mock 跑 100 局
        </button>
        {batchResult ? (
          <>
            <div className="stats-grid">
              <div>
                <span>完成局数</span>
                <strong>{batchResult.endedGames}/{batchResult.totalGames}</strong>
              </div>
              <div>
                <span>好人胜利</span>
                <strong>{batchResult.goodWins}</strong>
              </div>
              <div>
                <span>狼人胜利</span>
                <strong>{batchResult.wolfWins}</strong>
              </div>
              <div>
                <span>阻塞局数</span>
                <strong>{batchResult.blockedGames}</strong>
              </div>
            </div>
            <p className="muted">
              平均事件 {batchResult.averageEvents}，平均 Mock 调用 {batchResult.averageCalls}，步数上限 {batchResult.maxSteps}。
            </p>
            {batchResult.blockedSeeds.length > 0 && <p className="call-error">阻塞种子：{batchResult.blockedSeeds.slice(0, 8).join("、")}</p>}
          </>
        ) : (
          <p className="muted">用当前人数和规则包生成 0 真人全 AI Mock 对局，快速检查规则引擎是否能稳定跑完。</p>
        )}
      </section>
      <section className="compact-table token-dashboard">
        <h3>Token 仪表盘</h3>
        <div className="breakdown-grid">
          <TokenBreakdown title="按玩家" rows={byPlayer} />
          <TokenBreakdown title="按供应商" rows={byProvider} />
          <TokenBreakdown title="按模型" rows={byModel} />
          <TokenBreakdown title="按阶段" rows={byPhase} />
        </div>
      </section>
      <section className="compact-table">
        <h3>AI 当前记忆</h3>
        {game.players
          .filter((player) => player.controller !== "human")
          .map((player) => {
            const memory = game.memories[player.id];
            return (
              <details className="memory-detail" key={player.id}>
                <summary>
                  <span>{seatName(game, player.id)}</span>
                  <strong>{memory?.publicTimelineSummary.split("\n").at(-1) ?? "暂无记忆"}</strong>
                </summary>
                {memory ? (
                  <div className="memory-body">
                    <MemoryBlock title="公开摘要" value={memory.publicTimelineSummary} />
                    <MemoryBlock title="私有观察" value={memory.privateObservations} />
                    <MemoryList title="已知事实" items={memory.knownFacts} />
                    <MemoryList title="矛盾点" items={memory.contradictions} />
                    <MemoryList title="承诺/约定" items={memory.promisesAndCommitments} />
                    <MemoryClaims game={game} claims={memory.claimedRoles} />
                    <MemoryScores title="嫌疑分" game={game} scores={memory.suspicionScores} />
                    <MemoryScores title="信任分" game={game} scores={memory.trustScores} />
                  </div>
                ) : (
                  <p className="muted">暂无记忆。</p>
                )}
              </details>
            );
          })}
      </section>
    </div>
  );
}

interface CallSummary {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cost: number;
}

function summarizeCalls(calls: LLMCallLog[], keyOf: (call: LLMCallLog) => string): CallSummary[] {
  const groups = new Map<string, CallSummary>();
  for (const call of calls) {
    const key = keyOf(call);
    const summary = groups.get(key) ?? {
      key,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cost: 0
    };
    summary.calls += 1;
    summary.inputTokens += call.inputTokens;
    summary.outputTokens += call.outputTokens;
    summary.reasoningTokens += call.reasoningTokens;
    summary.cost += call.estimatedCost;
    groups.set(key, summary);
  }
  return [...groups.values()].sort((left, right) => right.cost - left.cost || right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens));
}

function TokenBreakdown({ title, rows }: { title: string; rows: CallSummary[] }): JSX.Element {
  return (
    <div className="breakdown-table">
      <strong>{title}</strong>
      <div className="breakdown-head">
        <span>项目</span>
        <span>次数</span>
        <span>输入</span>
        <span>输出</span>
        <span>费用</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted">暂无调用。</p>
      ) : (
        rows.slice(0, 8).map((row) => (
          <div className="breakdown-row" key={row.key}>
            <span>{row.key}</span>
            <span>{row.calls}</span>
            <span>{row.inputTokens}</span>
            <span>{row.outputTokens}</span>
            <span>{row.cost.toFixed(6)}</span>
          </div>
        ))
      )}
    </div>
  );
}

function MemoryBlock({ title, value }: { title: string; value: string }): JSX.Element {
  return (
    <div className="memory-block">
      <strong>{title}</strong>
      <p>{value || "暂无"}</p>
    </div>
  );
}

function MemoryList({ title, items }: { title: string; items: string[] }): JSX.Element {
  return (
    <div className="memory-block">
      <strong>{title}</strong>
      {items.length === 0 ? (
        <p>暂无</p>
      ) : (
        <ul>
          {items.slice(-8).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MemoryClaims({ game, claims }: { game: GameState; claims: Record<PlayerId, string[]> }): JSX.Element {
  const entries = Object.entries(claims).filter(([, roles]) => roles.length > 0);
  return (
    <div className="memory-block">
      <strong>身份声明</strong>
      {entries.length === 0 ? (
        <p>暂无</p>
      ) : (
        <ul>
          {entries.slice(-8).map(([playerId, roles]) => (
            <li key={playerId}>
              {seatName(game, playerId)}：{roles.join("、")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MemoryScores({ title, game, scores }: { title: string; game: GameState; scores: Record<PlayerId, number> }): JSX.Element {
  const rows = Object.entries(scores)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);
  return (
    <div className="memory-block">
      <strong>{title}</strong>
      <div className="memory-score-list">
        {rows.map(([playerId, score]) => (
          <span key={playerId}>
            {seatName(game, playerId)} {score}
          </span>
        ))}
      </div>
    </div>
  );
}

function toPublicViewState(state: GameState): GameState {
  return {
    ...state,
    setup: {
      ...state.setup,
      debugMode: {
        ...state.setup.debugMode,
        revealRoles: false,
        revealPrompts: false,
        revealPrivateRationales: false,
        revealWolfChat: false,
        revealNightActions: false
      }
    }
  };
}

function officialOutputForPending(state: GameState, pending: PendingAction, viewerId?: PlayerId): string {
  if (pending.kind === "wolf_discussion") return canViewerSeeWolfChat(state, viewerId) ? latestEventText(state, ["WolfDiscussionMessage"]) : "";
  if (pending.kind === "sheriff_withdrawal") return latestWithdrawalText(state, pending.seatId);
  if (pending.kind !== "speech") return "";
  if (pending.speechType === "sheriff" && state.phase.type === "sheriff_speech") {
    const withdrawalText = latestWithdrawalText(state, pending.seatId);
    if (withdrawalText) return withdrawalText;
  }
  return latestEventText(state, ["SpeechPublished", "LastWordsPublished"]);
}

function officialOutputForCommand(state: GameState, pending: PendingAction, command: GameCommand, viewerId?: PlayerId): string {
  if (isWithdrawalOutputCommand(command)) return `${seatName(state, command.seatId)} 退水。`;
  if (pending.kind === "speech" && "text" in command) return command.text;
  if (pending.kind === "wolf_discussion" && "messageToWolves" in command && canViewerSeeWolfChat(state, viewerId)) return command.messageToWolves;
  return "";
}

function latestWithdrawalText(state: GameState, seatId: PlayerId): string {
  const event = [...state.events].reverse().find((item) => item.type === "SheriffCandidateWithdrawn" && item.seatId === seatId);
  return event ? `${seatName(state, seatId)} 退水。` : "";
}

function extractReasoningTrace(rawResponse: string): string {
  if (!rawResponse.trim()) return "";
  try {
    const parsed = JSON.parse(rawResponse) as unknown;
    const found = collectReasoningFields(parsed);
    return found.join("\n\n").trim();
  } catch {
    return "";
  }
}

function collectReasoningFields(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectReasoningFields);
  const record = value as Record<string, unknown>;
  const current = ["reasoning_content", "reasoningContent", "reasoning", "thinking"]
    .map((key) => record[key])
    .flatMap((item) => {
      if (typeof item === "string") return item.trim() ? [item.trim()] : [];
      if (item && typeof item === "object") {
        const text = JSON.stringify(item, null, 2);
        return text.trim() ? [text] : [];
      }
      return [];
    });
  const nested = Object.entries(record)
    .filter(([key]) => !["reasoning_content", "reasoningContent", "reasoning", "thinking"].includes(key))
    .flatMap(([, item]) => collectReasoningFields(item));
  return [...current, ...nested];
}

function isWithdrawalOutputCommand(command: GameCommand | undefined): boolean {
  if (!command) return false;
  if (command.type === "WithdrawSheriffCandidacy") return true;
  return command.type === "SubmitSheriffWithdrawalDecision" && command.withdraw;
}

function readableOutputPauseLabels(
  pending: PendingAction,
  command: GameCommand | undefined
): { outputLabel: string; progressLabel: string; doneLabel: string } {
  if (isWithdrawalOutputCommand(command) || pending.kind === "sheriff_withdrawal") {
    return {
      outputLabel: "退水提示",
      progressLabel: "已退水",
      doneLabel: "退水完成，点击继续进入下一位。"
    };
  }
  return {
    outputLabel: "刚刚发言",
    progressLabel: "已发言",
    doneLabel: "发言结束，点击继续进入下一位。"
  };
}

function transitionNoticeForNewEvents(
  previous: GameState,
  nextState: GameState,
  viewerId: PlayerId
): Pick<ReadableOutputPause, "seatId" | "publicText" | "outputLabel" | "progressLabel" | "doneLabel"> | undefined {
  const newPublicEvents = nextState.events.slice(previous.events.length).filter((event) => event.visibility === "public" && event.type !== "PhaseStarted");
  if (newPublicEvents.length === 0) return undefined;
  const fallbackSeatId = viewerId || nextState.players[0]?.id;
  const noticeFrom = (
    events: Array<GameState["events"][number]>,
    outputLabel: string,
    progressLabel: string,
    doneLabel: string
  ) => {
    if (events.length === 0 || !fallbackSeatId) return undefined;
    return {
      seatId: events[0].seatId ?? fallbackSeatId,
      publicText: events.map((event) => eventSummary(nextState, event.type, event.payload, event.seatId)).filter(Boolean).join("\n"),
      outputLabel,
      progressLabel,
      doneLabel
    };
  };

  const hunterEvents = newPublicEvents.filter((event) => event.type === "HunterShotResolved" || event.type === "HunterShotSkipped");
  const hunterNotice = noticeFrom(hunterEvents, "猎人结算", "猎人已行动", "猎人开枪结算完成，点击继续进入下一步。");
  if (hunterNotice) return hunterNotice;

  const badgeEvents = newPublicEvents.filter((event) => event.type === "BadgePassed" || event.type === "BadgeDestroyed");
  const badgeNotice = noticeFrom(badgeEvents, "警徽结算", "警徽已处理", "警徽处理完成，点击继续进入下一步。");
  if (badgeNotice) return badgeNotice;

  const withdrawalEvents = newPublicEvents.filter((event) => event.type === "SheriffCandidateWithdrawn");
  if (withdrawalEvents.length > 0) {
    const related = newPublicEvents.filter(
      (event) => event.type === "SheriffCandidateWithdrawn" || event.type === "SheriffElected" || event.type === "SheriffSkipped" || event.type === "NightDeathsAnnounced"
    );
    const withdrawalNotice = noticeFrom(related, "退水提示", "已退水", "退水信息已确认，点击继续进入投票或下一步。");
    if (withdrawalNotice) return withdrawalNotice;
  }

  const voteEvents = newPublicEvents.filter(
    (event) =>
      event.type === "SheriffVoteResolved" ||
      event.type === "DayVoteResolved" ||
      event.type === "SheriffElected" ||
      event.type === "SheriffSkipped" ||
      event.type === "PlayerExiled" ||
      event.type === "NoExile" ||
      event.type === "NightDeathsAnnounced"
  );
  const voteNotice = noticeFrom(voteEvents, "投票结算", "投票已结算", "投票结果已结算，点击继续进入下一步。");
  if (voteNotice) return voteNotice;

  const candidacyEvents = newPublicEvents.filter(
    (event) => event.type === "SheriffCandidatesAnnounced" || event.type === "SheriffElected" || event.type === "SheriffSkipped" || event.type === "NightDeathsAnnounced"
  );
  const candidacyNotice = noticeFrom(candidacyEvents, "上警名单", "上警名单已公布", "上警名单已公布，点击继续进入警上发言。");
  if (candidacyNotice) return candidacyNotice;

  const deathEvents = newPublicEvents.filter((event) => event.type === "NightDeathsAnnounced");
  const deathNotice = noticeFrom(deathEvents, "夜晚死亡", "死亡已公布", "夜晚死亡已公布，点击继续进入下一步。");
  if (deathNotice) return deathNotice;

  const selfExplosionEvents = newPublicEvents.filter((event) => event.type === "WolfSelfExploded");
  const selfExplosionNotice = noticeFrom(selfExplosionEvents, "狼人自爆", "自爆已结算", "自爆已结算，点击继续进入夜晚。");
  if (selfExplosionNotice) return selfExplosionNotice;

  return undefined;
}

function latestEventText(state: GameState, types: string[]): string {
  const event = [...state.events].reverse().find((item) => types.includes(item.type));
  if (!event) return "";
  const payload = event.payload as { text?: unknown; publicSpeech?: unknown; messageToWolves?: unknown };
  return String(payload.text ?? payload.publicSpeech ?? payload.messageToWolves ?? "");
}

function canViewerSeeWolfChat(state: GameState, viewerId?: PlayerId): boolean {
  if (state.setup.debugMode.revealRoles || state.setup.debugMode.revealWolfChat || state.setup.debugMode.revealNightActions) return true;
  const viewer = state.players.find((player) => player.id === viewerId);
  return Boolean(viewer && (viewer.role === "werewolf" || !viewer.alive));
}

function StatusBadge({ game }: { game: GameState }): JSX.Element {
  if (game.status === "ended") {
    return (
      <div className={`status-badge ${game.winner}`}>
        <Skull size={16} />
        {game.winner === "wolves" ? "狼人胜利" : "好人胜利"}
      </div>
    );
  }
  const isNight = game.phase.type.startsWith("night");
  return (
    <div className={`status-badge ${isNight ? "night" : "day"}`}>
      {isNight ? <Moon size={16} /> : <Sun size={16} />}
      {isNight ? "夜晚" : "白天"}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function assignPersonasToAISeats(state: GameState, personas: AIPersona[], seed: string): GameState {
  const pool = personas.filter((persona) => persona.allowRandomSelection && persona.weight > 0);
  const candidates = pool.length > 0 ? pool : DEFAULT_PERSONAS;
  const rng = createWebRng(`${seed}:ai-personas`);
  for (const player of state.players) {
    if (player.controller === "human") continue;
    const persona = chooseWeightedPersona(candidates, rng);
    player.personaId = persona.id;
  }
  syncRoleAssignedEventNames(state);
  return state;
}

function syncRoleAssignedEventNames(state: GameState): void {
  for (const event of state.events) {
    if (event.type !== "RoleAssigned") continue;
    const payload = event.payload as { seatId?: PlayerId; playerName?: string; personaId?: string };
    const player = payload.seatId ? state.players.find((item) => item.id === payload.seatId) : undefined;
    if (!player) continue;
    payload.playerName = player.name;
    payload.personaId = player.personaId;
  }
}

function publicPlayerLabel(player: GameState["players"][number], config: AIConfigStore, aiMode: "mock" | "llm", game?: GameState): string {
  if (player.controller === "human") return player.name;
  if (aiMode === "mock") return "Mock";
  const latestCall = game ? latestCallForSeat(game, player.id) : undefined;
  if (latestCall?.model) return latestCall.model;
  const persona = config.personas.find((item) => item.id === player.personaId) ?? DEFAULT_PERSONAS.find((item) => item.id === player.personaId);
  const provider =
    config.providers.find((item) => item.id === persona?.defaultProviderId && item.enabled) ??
    config.providers.find((item) => item.id === persona?.defaultProviderId);
  return persona?.defaultModel || provider?.defaultModel || player.name;
}

function latestCallForSeat(game: GameState, seatId: PlayerId): LLMCallLog | undefined {
  return [...game.llmCalls].reverse().find((call) => call.seatId === seatId);
}

function aiRuntimeStatus(game: GameState, player: GameState["players"][number], aiMode: "mock" | "llm", config: AIConfigStore): { label: string } | undefined {
  if (player.controller === "human") return undefined;
  if (aiMode === "mock") return { label: "MockAI" };
  const latestCall = latestCallForSeat(game, player.id);
  if (latestCall) {
    if (latestCall.provider === "fallback") return { label: `兜底AI${latestCall.error ? ` · ${fallbackReasonLabel(latestCall.error)}` : ""}` };
    if (latestCall.provider === "mock") return { label: "MockAI" };
    if (latestCall.error) return { label: "失败" };
    return { label: "真实AI" };
  }
  const persona = config.personas.find((item) => item.id === player.personaId) ?? DEFAULT_PERSONAS.find((item) => item.id === player.personaId);
  const provider =
    config.providers.find((item) => item.id === persona?.defaultProviderId && item.enabled) ??
    config.providers.find((item) => item.id === persona?.defaultProviderId);
  return { label: provider && !isRealProvider(provider) ? "MockAI" : "真实AI" };
}

function publicPlayerAvatar(player: GameState["players"][number]): string {
  return player.name;
}

function chooseWeightedPersona(personas: AIPersona[], rng: () => number): AIPersona {
  const total = personas.reduce((sum, persona) => sum + Math.max(0, persona.weight), 0);
  if (total <= 0) return personas[0];
  let cursor = rng() * total;
  for (const persona of personas) {
    cursor -= Math.max(0, persona.weight);
    if (cursor <= 0) return persona;
  }
  return personas[personas.length - 1];
}

function createWebRng(seed: string): () => number {
  let a = hashWebSeed(seed);
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashWebSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let index = 0; index < seed.length; index += 1) {
    h = Math.imul(h ^ seed.charCodeAt(index), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function buildHumanCommand(
  game: GameState,
  pending: PendingAction,
  selectedTarget: PlayerId | "abstain" | "skip" | "destroy",
  speechText: string,
  witchSave: boolean,
  witchPoisonTarget: PlayerId | "skip",
  wolfAgree: boolean,
  sheriffRun: boolean
): GameCommand | undefined {
  if (pending.kind === "guard_protect" || pending.kind === "seer_check") {
    const targetId = pending.kind === "guard_protect" && selectedTarget === "skip" ? "skip" : selectedTarget !== "abstain" && selectedTarget !== "skip" ? selectedTarget : pending.legalTargets[0];
    return {
      type: "SubmitNightAction",
      seatId: pending.seatId,
      action: pending.kind,
      targetId,
      privateReason: "真人玩家提交夜间行动。"
    };
  }
  if (pending.kind === "witch_action") {
    const save = pending.canSave && witchSave;
    const canUsePoison = pending.canPoison && (!save || game.rulePreset.witchRules.allowSaveAndPoisonSameNight);
    const poisonTargetId = canUsePoison && witchPoisonTarget !== "skip" ? witchPoisonTarget : undefined;
    return { type: "SubmitWitchAction", seatId: pending.seatId, save, poisonTargetId, privateReason: "真人女巫行动。" };
  }
  if (pending.kind === "wolf_discussion") {
    const defaultWolfTarget = pending.legalTargets.find((id) => id !== pending.seatId) ?? pending.legalTargets[0];
    const proposedTargetId = selectedTarget !== "abstain" && selectedTarget !== "skip" ? selectedTarget : defaultWolfTarget;
    return {
      type: "SubmitWolfDiscussionMessage",
      seatId: pending.seatId,
      messageToWolves: speechText,
      proposedTargetId,
      agreeCurrentProposal: wolfAgree,
      privateReason: "真人狼人夜聊提交。"
    };
  }
  if (pending.kind === "sheriff_candidacy") {
    return {
      type: "SubmitSheriffCandidacy",
      seatId: pending.seatId,
      runForSheriff: sheriffRun,
      publicSpeech: sheriffRun ? "我选择上警，正式警上发言再展开。" : "我不上警，警下听发言和票型。",
      privateReason: sheriffRun ? "真人选择上警。" : "真人选择不上警。"
    };
  }
  if (pending.kind === "sheriff_withdrawal") {
    return {
      type: "SubmitSheriffWithdrawalDecision",
      seatId: pending.seatId,
      withdraw: !sheriffRun,
      privateReason: sheriffRun ? "真人选择继续留警。" : "真人选择在投票前退水。"
    };
  }
  if (pending.kind === "speech") {
    return { type: "SubmitSpeech", seatId: pending.seatId, text: speechText, privateReason: "真人公开发言。" };
  }
  if (pending.kind === "vote") {
    const requestedTarget = selectedTarget === "skip" ? "abstain" : selectedTarget;
    const targetId = requestedTarget === "abstain" && !game.rulePreset.voteRules.allowAbstain ? pending.legalTargets[0] : requestedTarget;
    return { type: "SubmitVote", seatId: pending.seatId, targetId, privateReason: "真人玩家投票。", confidence: 1 };
  }
  if (pending.kind === "badge_decision") {
    const targetId = selectedTarget === "abstain" || selectedTarget === "skip" ? "destroy" : selectedTarget;
    return { type: "SubmitBadgeDecision", seatId: pending.seatId, targetId, privateReason: "真人警长处理警徽。" };
  }
  if (pending.kind === "hunter_shot") {
    return {
      type: "SubmitHunterShot",
      seatId: pending.seatId,
      targetId: selectedTarget === "abstain" ? "skip" : selectedTarget,
      privateReason: "真人猎人行动。"
    };
  }
  return undefined;
}

function legalTargetsFor(pending: PendingAction): PlayerId[] {
  return "legalTargets" in pending ? pending.legalTargets : [];
}

function canWithdrawSheriff(game: GameState, seatId: PlayerId): boolean {
  const player = game.players.find((item) => item.id === seatId);
  return Boolean(player?.isSheriffCandidate && !player.hasWithdrawnSheriff && (game.phase.type === "sheriff_speech" || game.phase.type === "sheriff_withdrawal"));
}

function defaultTargetFor(
  pending: PendingAction,
  legalTargets: PlayerId[],
  allowAbstain: boolean
): PlayerId | "abstain" | "skip" | "destroy" {
  if (pending.kind === "wolf_discussion") return legalTargets.find((id) => id !== pending.seatId) ?? legalTargets[0] ?? "abstain";
  if (pending.kind === "hunter_shot") return "skip";
  if (pending.kind === "badge_decision") return "destroy";
  if (pending.kind === "vote") return allowAbstain ? "abstain" : legalTargets[0] ?? "abstain";
  if (legalTargets[0]) return legalTargets[0];
  return "abstain";
}

function defaultSpeechFor(pending: PendingAction): string {
  if (pending.kind === "speech") return "我先按目前公开信息发言。";
  if (pending.kind === "wolf_discussion") return "我建议今晚先刀这个位置，理由是他像关键好人。";
  if (pending.kind === "sheriff_candidacy") return "我说明一下我的上警选择和今天的观察。";
  return "";
}

function pendingLabel(pending: PendingAction): string {
  const labels: Record<PendingAction["kind"], string> = {
    guard_protect: "守卫守护",
    wolf_discussion: "狼人私聊",
    seer_check: "预言家查验",
    witch_action: "女巫行动",
    sheriff_candidacy: "警长竞选",
    sheriff_withdrawal: "退水确认",
    speech: "公开发言",
    vote: "投票",
    badge_decision: "移交警徽",
    hunter_shot: "猎人开枪"
  };
  return labels[pending.kind];
}

function eventName(type: string): string {
  const names: Record<string, string> = {
    GameStarted: "游戏开始",
    RoleAssigned: "身份分配",
    PhaseStarted: "阶段开始",
    NightActionSubmitted: "夜间行动",
    NightActionPrivateReason: "夜间行动理由",
    WolfDiscussionMessage: "狼人私聊",
    WolfDiscussionPrivateReason: "后台理由",
    WolfKillLocked: "狼人锁刀",
    WolfKillLockedPrivateReason: "锁刀理由",
    WolfSelfExploded: "狼人自爆",
    WolfSelfExplosionPrivateReason: "自爆理由",
    SeerChecked: "预言家查验",
    SeerCheckPrivateReason: "查验理由",
    WitchActionSubmitted: "女巫行动",
    WitchActionPrivateReason: "女巫行动理由",
    NightDeathsResolved: "夜晚结算",
    NightDeathsAnnounced: "死亡公布",
    SpeechPublished: "发言",
    LastWordsPublished: "遗言",
    SheriffCandidateWithdrawn: "警上退水",
    SheriffSkipped: "警长跳过",
    VoteCast: "投票",
    DayVoteResolved: "投票结算",
    SheriffElected: "警长当选",
    BadgeDecisionPending: "警徽待处理",
    BadgePassed: "警徽移交",
    BadgeDestroyed: "警徽撕毁",
    BadgeDecisionPrivateReason: "警徽理由",
    HunterShotResolved: "猎人开枪",
    HunterShotSkipped: "猎人不开枪",
    AgentMemoryUpdated: "AI 记忆更新",
    DebugForceKill: "调试强制死亡",
    PlayerKilled: "玩家死亡",
    PlayerDeathCauseRecorded: "死亡原因记录",
    PlayerExiled: "玩家放逐",
    GameEnded: "游戏结束"
  };
  return names[type] ?? type;
}

interface SheriffElectionNotice {
  seq: number;
  title: string;
  voteRows: string[];
  tallyRows: string[];
  result: string;
}

interface FlowNotice {
  key: string;
  kicker: string;
  title: string;
  body: string;
  rows: string[];
  chips: string[];
}

function buildSheriffElectionNotice(game: GameState): SheriffElectionNotice | undefined {
  const conclusion = [...game.events].reverse().find((event) => event.type === "SheriffElected" || event.type === "SheriffSkipped");
  if (!conclusion) return undefined;
  const voteEvent = [...game.events].reverse().find((event) => event.seq <= conclusion.seq && event.type === "SheriffVoteResolved");
  const conclusionPayload = conclusion.payload as Record<string, unknown>;
  const votePayload = voteEvent?.payload as Record<string, unknown> | undefined;
  const votes = votePayload?.votes as Record<PlayerId, PlayerId | "abstain"> | undefined;
  const tally = votePayload?.tally as Record<PlayerId, number> | undefined;
  const winner = conclusionPayload.sheriffId as PlayerId | undefined;
  const summary = votePayload ? formatVoteResolutionHeader("SheriffVoteResolved", votePayload) : undefined;
  return {
    seq: conclusion.seq,
    title: winner ? `${seatName(game, winner)} 当选警长` : "本局无警长",
    voteRows: formatGroupedVoteRows(game, votes, tally),
    tallyRows: tallyChips(game, tally),
    result: `${summary ? `${summary}。` : ""}${winner ? `最终警徽给到 ${seatName(game, winner)}。` : `结果：${String(conclusionPayload.reason ?? "无人当选")}。`}`
  };
}

function sheriffNoticeToFlowNotice(notice: SheriffElectionNotice): FlowNotice {
  return {
    key: `sheriff:${notice.seq}`,
    kicker: "警长竞选结果",
    title: notice.title,
    body: notice.result,
    rows: notice.voteRows,
    chips: notice.tallyRows
  };
}

function buildFlowNotice(
  game: GameState,
  visibleEvents: ReturnType<typeof getVisibleEvents>,
  humanPlayerId: PlayerId | undefined,
  dismissedKeys: string[]
): FlowNotice | undefined {
  if (!humanPlayerId) return undefined;
  for (const event of visibleEvents) {
    const notice = flowNoticeForEvent(game, event, humanPlayerId);
    if (notice && !dismissedKeys.includes(notice.key)) return notice;
  }
  return undefined;
}

function flowNoticeForEvent(
  game: GameState,
  event: ReturnType<typeof getVisibleEvents>[number],
  humanPlayerId: PlayerId
): FlowNotice | undefined {
  const data = event.payload as Record<string, unknown>;
  if (event.type === "PhaseStarted") return undefined;
  if (event.type === "NightDeathsAnnounced") {
    const deaths = (data.deaths as PlayerId[] | undefined) ?? [];
    return {
      key: event.id,
      kicker: "天亮了",
      title: deaths.length === 0 ? "昨夜平安夜" : `昨夜死亡 ${deaths.length} 人`,
      body: deaths.length === 0 ? "昨夜无人死亡。" : `死亡玩家：${deaths.map((id) => seatName(game, id)).join("、")}。`,
      rows: deaths.map((id) => `${seatName(game, id)} 死亡`),
      chips: []
    };
  }
  if (event.type === "SeerChecked" && event.seatId === humanPlayerId) {
    return {
      key: event.id,
      kicker: "你的夜间行动",
      title: "查验结果",
      body: `${seatName(game, data.targetId as PlayerId)} 的查验结果是：${data.result === "werewolf" ? "狼人" : "好人"}。`,
      rows: [],
      chips: [data.result === "werewolf" ? "狼人" : "好人"]
    };
  }
  if (event.type === "NightActionSubmitted" && event.seatId === humanPlayerId) {
    return undefined;
  }
  if (event.type === "WitchActionSubmitted" && event.seatId === humanPlayerId) {
    return undefined;
  }
  if (event.type === "WolfKillLocked") {
    return undefined;
  }
  if (event.type === "SheriffVoteResolved") {
    const top = (data.top as PlayerId[] | undefined) ?? [];
    const voteType = String(data.voteType ?? "");
    if (voteType !== "sheriff" || top.length <= 1) return undefined;
    const votes = data.votes as Record<PlayerId, PlayerId | "abstain"> | undefined;
    const tally = data.tally as Record<PlayerId, number> | undefined;
    const tiedPlayers = top.map((id) => seatName(game, id)).join("、");
    return {
      key: event.id,
      kicker: "警长投票结果",
      title: "首轮平票，进入 PK",
      body: `${formatVoteResolutionHeader(event.type, data)}。${tiedPlayers ? `平票玩家：${tiedPlayers}。进入警长 PK 发言。` : "首轮警长投票平票，进入 PK 发言。"}`,
      rows: formatGroupedVoteRows(game, votes, tally),
      chips: tallyChips(game, tally)
    };
  }
  if (event.type === "DayVoteResolved") {
    const votes = data.votes as Record<PlayerId, PlayerId | "abstain"> | undefined;
    const tally = data.tally as Record<PlayerId, number> | undefined;
    return {
      key: event.id,
      kicker: "投票结果",
      title: String(data.voteType ?? "") === "day_pk" ? "PK 投票结束" : "白天投票结束",
      body: formatVoteResolutionHeader(event.type, data),
      rows: formatGroupedVoteRows(game, votes, tally),
      chips: tallyChips(game, tally)
    };
  }
  if (event.type === "NoExile") {
    return {
      key: event.id,
      kicker: "投票结果",
      title: "无人出局",
      body: String(data.reason ?? "本轮无人被放逐。"),
      rows: [],
      chips: []
    };
  }
  if (event.type === "PlayerExiled") {
    return {
      key: event.id,
      kicker: "放逐结果",
      title: `${seatName(game, data.targetId as PlayerId)} 被放逐`,
      body: "放逐公开发生，身份不会自动翻开。",
      rows: [],
      chips: []
    };
  }
  if (event.type === "WolfSelfExploded") {
    return {
      key: event.id,
      kicker: "狼人自爆",
      title: `${seatName(game, event.seatId)} 自爆`,
      body: "狼人公开自爆，本回合立即结束并进入夜晚。",
      rows: [],
      chips: ["直接天黑"]
    };
  }
  if (event.type === "BadgePassed") {
    return {
      key: event.id,
      kicker: "警徽移交",
      title: "警徽已移交",
      body: `${seatName(game, data.fromSeatId as PlayerId)} 将警徽移交给 ${seatName(game, data.toSeatId as PlayerId)}。`,
      rows: [],
      chips: [seatName(game, data.toSeatId as PlayerId)]
    };
  }
  if (event.type === "BadgeDestroyed") {
    return {
      key: event.id,
      kicker: "警徽撕毁",
      title: "警徽已撕毁",
      body: `${seatName(game, data.seatId as PlayerId)} 选择撕毁警徽。`,
      rows: [],
      chips: []
    };
  }
  if (event.type === "HunterShotResolved") {
    return {
      key: event.id,
      kicker: "猎人开枪",
      title: `${seatName(game, event.seatId)} 开枪`,
      body: `${seatName(game, event.seatId)} 带走了 ${seatName(game, data.targetId as PlayerId)}。`,
      rows: [],
      chips: []
    };
  }
  if (event.type === "HunterShotSkipped") {
    return {
      key: event.id,
      kicker: "猎人开枪",
      title: `${seatName(game, event.seatId)} 不开枪`,
      body: "猎人选择不开枪。",
      rows: [],
      chips: []
    };
  }
  return undefined;
}

function eventSummary(game: GameState, type: string, payload: unknown, seatId?: PlayerId): string {
  const data = payload as Record<string, unknown>;
  if (type === "GameStarted") {
    return `创建 ${String(data.totalPlayers)} 人局：规则包 ${String(data.rulePreset)}，种子 ${String(data.seed)}。`;
  }
  if (type === "RoleAssigned") {
    return `${seatName(game, data.seatId as PlayerId)} 分配身份：${String(data.roleName ?? data.role)}`;
  }
  if (type === "SheriffCandidacySubmitted") {
    return `${seatName(game, seatId)} ${data.runForSheriff ? "选择上警" : "选择不上警"}：${String(data.publicSpeech ?? "")}`;
  }
  if (type === "SheriffCandidatesAnnounced") {
    const candidates = (data.candidates as PlayerId[] | undefined) ?? [];
    return candidates.length ? `上警名单：${candidates.map((id) => seatName(game, id)).join("、")}` : "无人上警";
  }
  if (type === "SheriffCandidateWithdrawn") return `${seatName(game, seatId)} 退水`;
  if (type === "SheriffSkipped") return `本局无警长：${String(data.reason ?? "")}`;
  if (type === "NightActionSubmitted") {
    if (data.action === "guard_protect" && !data.targetId) return `${seatName(game, seatId)} 空守`;
    return `${seatName(game, seatId)} 已提交夜间行动：${seatName(game, data.targetId as PlayerId)}`;
  }
  if (type === "NightActionPrivateReason") return "后台理由已记录，可在导出记录中追溯。";
  if (type === "SeerChecked") return `${seatName(game, seatId)} 查验 ${seatName(game, data.targetId as PlayerId)}：${data.result === "werewolf" ? "狼人" : "好人"}`;
  if (type === "SeerCheckPrivateReason") return "后台理由已记录，可在导出记录中追溯。";
  if (type === "WitchActionSubmitted") {
    const poisonTarget = data.poisonTargetId ? `，毒 ${seatName(game, data.poisonTargetId as PlayerId)}` : "";
    return `${seatName(game, seatId)} 女巫行动：${data.save ? "救人" : "不救"}${poisonTarget}`;
  }
  if (type === "WitchActionPrivateReason") return "后台理由已记录，可在导出记录中追溯。";
  if (type === "NightDeathsResolved") return "夜晚死亡已结算";
  if (type === "WolfKillLocked") return `狼人锁定刀口：${seatName(game, data.targetId as PlayerId)}`;
  if (type === "WolfKillLockedPrivateReason") return "后台理由已记录，可在导出记录中追溯。";
  if (type === "WolfDiscussionPrivateReason") return "后台理由已记录，可在导出记录中追溯。";
  if (type === "DayVoteResolved" || type === "SheriffVoteResolved") {
    const votes = data.votes as Record<PlayerId, PlayerId | "abstain"> | undefined;
    const tally = formatTally(game, data.tally as Record<PlayerId, number> | undefined);
    const rows = formatGroupedVoteRows(game, votes, data.tally as Record<PlayerId, number> | undefined);
    return `${formatVoteResolutionHeader(type, data)}${rows.length > 0 ? `\n${rows.join("\n")}` : ""}\n票数统计：${tally}`;
  }
  if (type === "SpeechPublished" || type === "LastWordsPublished") return `${seatName(game, seatId)}：${String(data.text ?? "")}`;
  if (type === "WolfDiscussionMessage") return `${seatName(game, seatId)}：${String(data.messageToWolves ?? "")}`;
  if (type === "WolfSelfExploded") return `${seatName(game, seatId)} 自爆为狼人，本回合结束，直接天黑`;
  if (type === "VoteCast") return `${seatName(game, seatId)} ${data.targetId === "abstain" ? "弃票" : `投给 ${seatName(game, data.targetId as PlayerId)}`}`;
  if (type === "AgentMemoryUpdated") return `${seatName(game, seatId)} 的 AI 记忆已更新`;
  if (type === "NightDeathsAnnounced") {
    const deaths = (data.deaths as PlayerId[] | undefined) ?? [];
    return deaths.length ? `昨夜死亡：${deaths.map((id) => seatName(game, id)).join("、")}` : "昨夜平安夜";
  }
  if (type === "PlayerKilled") return `${seatName(game, data.targetId as PlayerId)} 死亡`;
  if (type === "PlayerExiled") return `${seatName(game, data.targetId as PlayerId)} 被放逐`;
  if (type === "SheriffElected") return `${seatName(game, data.sheriffId as PlayerId)} 当选警长`;
  if (type === "BadgeDecisionPending") return `${seatName(game, data.seatId as PlayerId)} 需要处理警徽`;
  if (type === "BadgePassed") return `${seatName(game, data.fromSeatId as PlayerId)} 将警徽移交给 ${seatName(game, data.toSeatId as PlayerId)}`;
  if (type === "BadgeDestroyed") return `${seatName(game, data.seatId as PlayerId)} 撕毁警徽`;
  if (type === "BadgeDecisionPrivateReason") return "后台理由已记录，可在导出记录中追溯。";
  if (type === "HunterShotResolved") return `${seatName(game, seatId)} 开枪带走 ${seatName(game, data.targetId as PlayerId)}`;
  if (type === "HunterShotSkipped") return `${seatName(game, seatId)} 选择不开枪`;
  if (type === "DebugForceKill") return `调试强制 ${seatName(game, data.targetId as PlayerId)} 死亡：${String(data.reason ?? "")}`;
  if (type === "GameEnded") return `${data.winner === "wolves" ? "狼人胜利" : "好人胜利"}：${String(data.reason ?? "")}`;
  if (type === "PhaseStarted") return String(data.label ?? "");
  return JSON.stringify(sanitizeEventPayload(payload));
}

function sanitizeEventPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(sanitizeEventPayload);
  if (!payload || typeof payload !== "object") return payload;
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>)
      .filter(([key]) => key !== "privateReason")
      .map(([key, value]) => [key, sanitizeEventPayload(value)])
  );
}

function formatTally(game: GameState, tally: Record<PlayerId, number> | undefined): string {
  if (!tally) return "暂无票型";
  return sortedTallyEntries(game, tally)
    .map(([id, count]) => `${seatName(game, id)} ${formatVoteCount(count)}票`)
    .join("，");
}

function tallyChips(game: GameState, tally: Record<PlayerId, number> | undefined): string[] {
  if (!tally) return [];
  return sortedTallyEntries(game, tally).map(([id, count]) => `${seatName(game, id)} ${formatVoteCount(count)}票`);
}

function formatVoteResolutionHeader(type: string, data: Record<string, unknown>): string {
  const votes = data.votes as Record<PlayerId, PlayerId | "abstain"> | undefined;
  const tally = data.tally as Record<PlayerId, number> | undefined;
  const voteCount = votes ? Object.keys(votes).length : 0;
  const abstainCount = votes ? Object.values(votes).filter((targetId) => targetId === "abstain").length : 0;
  const candidateCount = tally ? Object.keys(tally).length : 0;
  if (type === "SheriffVoteResolved") {
    const title = String(data.voteType ?? "") === "sheriff_pk" ? "警长 PK 投票结算" : "警长投票结算";
    return `${title}（最终候选 ${candidateCount} 人，警下投票 ${voteCount} 人，弃权 ${abstainCount} 人，退水玩家不可投票）`;
  }
  if (String(data.voteType ?? "") === "day_pk") {
    return `PK 投票结算（最终候选 ${candidateCount} 人，投票 ${voteCount} 人，弃权 ${abstainCount} 人）`;
  }
  return `白天投票结算（投票 ${voteCount} 人，弃权 ${abstainCount} 人）`;
}

function formatGroupedVoteRows(
  game: GameState,
  votes: Record<PlayerId, PlayerId | "abstain"> | undefined,
  tally: Record<PlayerId, number> | undefined
): string[] {
  if (!votes) return [];
  const grouped = new Map<PlayerId | "abstain", PlayerId[]>();
  for (const [voterId, targetId] of Object.entries(votes)) {
    const voters = grouped.get(targetId) ?? [];
    voters.push(voterId);
    grouped.set(targetId, voters);
  }
  for (const voters of grouped.values()) {
    voters.sort((left, right) => seatNumberFor(game, left) - seatNumberFor(game, right));
  }

  const rows: string[] = [];
  const targetIds = sortedVoteTargets(game, grouped, tally);
  for (const targetId of targetIds) {
    const voters = grouped.get(targetId) ?? [];
    const count = tally?.[targetId] ?? voters.length;
    if (count === 0 && voters.length === 0) continue;
    rows.push(`${compactSeatName(game, targetId)}（${formatVoteCount(count)}票）：${formatCompactSeatList(game, voters)}`);
  }
  const abstainVoters = grouped.get("abstain") ?? [];
  if (abstainVoters.length > 0) {
    rows.push(`弃票（${abstainVoters.length}票）：${formatCompactSeatList(game, abstainVoters)}`);
  }
  return rows;
}

function sortedVoteTargets(
  game: GameState,
  grouped: Map<PlayerId | "abstain", PlayerId[]>,
  tally: Record<PlayerId, number> | undefined
): PlayerId[] {
  const targetIds = new Set<PlayerId>();
  if (tally) {
    for (const targetId of Object.keys(tally)) targetIds.add(targetId);
  }
  for (const targetId of grouped.keys()) {
    if (targetId !== "abstain") targetIds.add(targetId);
  }
  return [...targetIds].sort((left, right) => {
    const countDiff = (tally?.[right] ?? grouped.get(right)?.length ?? 0) - (tally?.[left] ?? grouped.get(left)?.length ?? 0);
    if (countDiff !== 0) return countDiff;
    return seatNumberFor(game, left) - seatNumberFor(game, right);
  });
}

function sortedTallyEntries(game: GameState, tally: Record<PlayerId, number>): Array<[PlayerId, number]> {
  return Object.entries(tally).sort(([leftId, leftCount], [rightId, rightCount]) => {
    const countDiff = rightCount - leftCount;
    if (countDiff !== 0) return countDiff;
    return seatNumberFor(game, leftId) - seatNumberFor(game, rightId);
  });
}

function formatCompactSeatList(game: GameState, seatIds: PlayerId[]): string {
  return seatIds.length > 0 ? seatIds.map((id) => compactSeatName(game, id)).join("、") : "无";
}

function compactSeatName(game: GameState, id: PlayerId): string {
  const player = game.players.find((item) => item.id === id);
  return player ? `${player.seatNumber}号` : seatName(game, id);
}

function formatVoteCount(count: number): string {
  if (Number.isInteger(count)) return String(count);
  return count.toFixed(1).replace(/\.0$/, "");
}

function seatName(game: GameState, id?: PlayerId): string {
  if (!id) return "系统";
  const player = game.players.find((item) => item.id === id);
  if (!player) return id;
  return player.controller === "human" ? `${player.seatNumber}号${player.name}` : `${player.seatNumber}号玩家`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function deathReason(reason: string | undefined): string {
  if (reason === "wolf") return "狼刀";
  if (reason === "poison") return "毒杀";
  if (reason === "exile") return "放逐";
  if (reason === "hunter") return "猎枪";
  if (reason === "self_explosion") return "自爆";
  if (reason === "debug") return "调试";
  return "未知";
}

function deathReasonForViewer(game: GameState, player: GameState["players"][number], viewerId?: PlayerId): string {
  if (!player.death) return "出局";
  if (game.status === "ended" || game.setup.debugMode.revealRoles || game.setup.debugMode.revealNightActions) return deathReason(player.death.reason);
  if (player.id === viewerId && player.death.reason !== "wolf" && player.death.reason !== "poison") return deathReason(player.death.reason);
  if (player.death.reason === "exile" || player.death.reason === "hunter" || player.death.reason === "self_explosion" || player.death.reason === "debug") return deathReason(player.death.reason);
  return "死亡";
}

function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function upsertFetchedModels(
  config: AIConfigStore,
  providerId: string,
  models: Array<{ id: string; name: string; contextWindow?: number }>
): AIConfigStore {
  const existing = new Map(config.models.map((model) => [`${model.providerId}:${model.name}`, model]));
  const nextModels = [...config.models];
  for (const model of models) {
    const name = model.id || model.name;
    const key = `${providerId}:${name}`;
    if (existing.has(key)) continue;
    nextModels.push({
      id: `model-${providerId}-${name}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
      providerId,
      name,
      displayName: model.name || name,
      contextWindow: model.contextWindow ?? 32000,
      maxOutputTokens: 1000,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      supportsStructuredOutput: true,
      supportsReasoningEffort: false,
      supportsCachedTokens: false,
      enabled: true,
      notes: "由测试连接自动拉取。"
    });
  }
  return { ...config, models: nextModels };
}

function selectFetchedDefaultModel(config: AIConfigStore, providerId: string, models: Array<{ id: string; name: string }>): AIConfigStore {
  const firstModel = models.map((model) => model.id || model.name).find(Boolean);
  if (!firstModel) return config;
  return {
    ...config,
    providers: config.providers.map((provider) => {
      if (provider.id !== providerId) return provider;
      const current = provider.defaultModel.trim();
      if (current && current !== "model-name") return provider;
      return { ...provider, defaultModel: firstModel };
    })
  };
}

function syncHiddenAIProviderConfig(config: AIConfigStore): AIConfigStore {
  const provider = config.providers.find((item) => item.enabled && isRealProvider(item));
  const modelName = provider?.defaultModel.trim();
  if (!provider || !modelName) return config;
  const personas = config.personas.map((persona) => ({
    ...persona,
    defaultProviderId: provider.id,
    defaultModel: modelName
  }));
  return ensureDefaultModelRecord({ ...config, personas }, provider, modelName);
}

function ensureDefaultModelRecord(config: AIConfigStore, provider: ProviderAccount, modelName: string): AIConfigStore {
  const hasModel = config.models.some((model) => model.providerId === provider.id && model.name === modelName);
  if (hasModel) return config;
  return {
    ...config,
    models: [
      ...config.models,
      {
        id: `model-${provider.id}-${modelName}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
        providerId: provider.id,
        name: modelName,
        displayName: modelName,
        contextWindow: 32000,
        maxOutputTokens: 1000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        supportsStructuredOutput: true,
        supportsReasoningEffort: providerSupportsReasoningEffort(provider),
        supportsCachedTokens: false,
        enabled: true,
        notes: "由 API 接入页默认模型自动创建。"
      }
    ]
  };
}

function stripProviderSecrets(config: AIConfigStore): AIConfigStore {
  return {
    ...config,
    providers: config.providers.map((provider) => ({ ...provider, apiKeyEncrypted: undefined }))
  };
}

function markLocalProviderSecretStatus(config: AIConfigStore, apiKeys: LocalProviderApiKeys): AIConfigStore {
  return {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      apiKeyEncrypted: apiKeys[provider.id]?.trim() ? LOCAL_SECRET_SENTINEL : undefined
    }))
  };
}

function loadLocalProviderApiKeys(): LocalProviderApiKeys {
  try {
    const raw = window.localStorage.getItem(LOCAL_PROVIDER_KEYS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function saveLocalProviderApiKeys(apiKeys: LocalProviderApiKeys): void {
  const sanitized = Object.fromEntries(Object.entries(apiKeys).filter(([, value]) => value.trim()));
  window.localStorage.setItem(LOCAL_PROVIDER_KEYS_STORAGE_KEY, JSON.stringify(sanitized));
}
