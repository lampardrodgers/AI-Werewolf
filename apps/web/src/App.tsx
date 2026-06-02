import {
  Award,
  Bot,
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
  DEFAULT_AI_CONFIG,
  DEFAULT_COST_CONTROLS,
  DEFAULT_DEBUG_MODE,
  DEFAULT_PERSONAS,
  GameSetup,
  LLMCallLog,
  PlayerId,
  ProviderAccount,
  ProviderType,
  ROLE_DEFINITIONS,
  RoleId,
  STANDARD_PRESET
} from "@langrensha/shared";
import { AIDecisionStatus, loadAIConfig, loadAIDecisionStatus, requestAIDecision, saveAIConfig, testProvider } from "./api";

type AppScreen = "setup" | "game" | "admin";
type AdminSection = "overview" | "ai" | "roles" | "logs";
type GameSideTab = "chat" | "votes" | "exposure" | "records" | "rules";
type LocalProviderApiKeys = Record<string, string>;
type ProviderTestState = "testing" | "success" | "failed";
type ProviderTestResults = Record<string, ProviderTestState>;

const AUTO_STEP_DELAY_MS = 700;
const LOCAL_PROVIDER_KEYS_STORAGE_KEY = "langrensha.localProviderApiKeys.v1";
const LOCAL_SECRET_SENTINEL = "__local_browser__";
const PRIVATE_NIGHT_PHASES = new Set<GameState["phase"]["type"]>(["night_guard", "night_wolves", "night_seer", "night_witch"]);
const PRIVATE_NIGHT_ACTIONS = new Set<PendingAction["kind"]>(["guard_protect", "seer_check", "witch_action", "wolf_discussion"]);

const DEFAULT_SETUP: GameSetup = {
  totalPlayers: 8,
  humanPlayers: 1,
  aiPlayers: 7,
  seed: "langrensha-001",
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
    supportsModelList: true
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
    supportsModelList: true
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
    supportsModelList: true
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
    supportsModelList: true
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
    supportsModelList: true
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
    supportsModelList: false
  }
};

export function App(): JSX.Element {
  const [setup, setSetup] = useState<GameSetup>(DEFAULT_SETUP);
  const [game, setGame] = useState<GameState | null>(null);
  const [autoRun, setAutoRun] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [screen, setScreen] = useState<AppScreen>("setup");
  const [tab, setTab] = useState<GameSideTab>("chat");
  const [adminSection, setAdminSection] = useState<AdminSection>("ai");
  const [speechText, setSpeechText] = useState("");
  const [selectedTarget, setSelectedTarget] = useState<PlayerId | "abstain" | "skip" | "destroy">("abstain");
  const [wolfAgree, setWolfAgree] = useState(true);
  const [sheriffRun, setSheriffRun] = useState(false);
  const [config, setConfig] = useState<AIConfigStore>(DEFAULT_AI_CONFIG);
  const [configStatus, setConfigStatus] = useState("配置尚未保存");
  const [providerTestStatus, setProviderTestStatus] = useState("");
  const [providerTestResults, setProviderTestResults] = useState<ProviderTestResults>({});
  const [providerApiKeys, setProviderApiKeys] = useState<LocalProviderApiKeys>(() => loadLocalProviderApiKeys());
  const [aiMode, setAiMode] = useState<"mock" | "llm">("mock");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiElapsedSeconds, setAiElapsedSeconds] = useState(0);
  const [aiProgress, setAiProgress] = useState<AIDecisionStatus | null>(null);
  const [aiStepStatus, setAiStepStatus] = useState("等待玩家行动。");
  const [streamingSpeech, setStreamingSpeech] = useState("");
  const [streamingSpeechSeatId, setStreamingSpeechSeatId] = useState<PlayerId | undefined>();
  const [batchResult, setBatchResult] = useState<MockBatchRunResult | null>(null);
  const [debugStatus, setDebugStatus] = useState("");
  const streamingTimerRef = useRef<number | undefined>();

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

  useEffect(() => {
    loadAIConfig()
      .then((loaded) => {
        setConfig(stripProviderSecrets({ ...loaded, costControls: loaded.costControls ?? DEFAULT_COST_CONTROLS }));
        setConfigStatus("已从后端读取配置");
      })
      .catch((error) => setConfigStatus(error instanceof Error ? error.message : "读取配置失败"));
  }, []);

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
    setSheriffRun(false);
    setWolfAgree(true);
  }, [game?.rulePreset.voteRules.allowAbstain, humanPending?.kind, humanPending?.seatId, humanPending && "round" in humanPending ? humanPending.round : undefined]);

  function startGame(): void {
    const normalized: GameSetup = {
      ...setup,
      aiPlayers: setup.totalPlayers - setup.humanPlayers,
      seed: setup.seed.trim() || `seed-${Date.now()}`
    };
    setSetup(normalized);
    setGame(assignPersonasToAISeats(createGame(normalized), config.personas, normalized.seed));
    setBatchResult(null);
    setIsPaused(false);
    setAutoRun(true);
    clearStreamingOutput();
    setAiProgress(null);
    setTab("chat");
    setScreen("game");
  }

  function restartGame(): void {
    setIsPaused(false);
    setAutoRun(true);
    const normalized: GameSetup = {
      ...setup,
      aiPlayers: setup.totalPlayers - setup.humanPlayers,
      seed: setup.seed.trim() || `seed-${Date.now()}`
    };
    setGame(assignPersonasToAISeats(createGame(normalized), config.personas, normalized.seed));
    clearStreamingOutput();
    setAiProgress(null);
    setBatchResult(null);
    setTab("chat");
    setScreen("game");
  }

  async function stepAI(): Promise<void> {
    if (!game || game.status === "ended" || aiBusy) return;
    const pending = game.pendingActions.find((action) => game.players.find((player) => player.id === action.seatId)?.controller !== "human");
    if (!pending) {
      setAiStepStatus("当前没有 AI 待处理动作。");
      return;
    }
    if (aiMode === "mock") {
      const next = applyMockStep(game);
      setGame(next);
      setAiStepStatus(`${seatName(game, pending.seatId)} 已完成 ${pendingLabel(pending)}。`);
      clearStreamingOutput();
      const publicText = officialOutputForPending(next, pending, humanPlayerId);
      if (publicText) streamOfficialOutput(publicText, pending.seatId);
      pauseAfterReadableAIOutput(pending, publicText, next);
      return;
    }

    const pendingPlayer = game.players.find((player) => player.id === pending.seatId);
    const persona = config.personas.find((item) => item.id === pendingPlayer?.personaId) ?? config.personas[0] ?? DEFAULT_PERSONAS[0];
    const provider = config.providers.find((item) => item.id === persona.defaultProviderId && item.enabled);
    if (provider && !provider.baseUrl.startsWith("mock://") && !providerApiKeys[provider.id]?.trim()) {
      setAutoRun(false);
      setIsPaused(true);
      setAiStepStatus(`${provider.name} 缺少本机 API Key / Access Token。请在管理控制台填写后继续。`);
      return;
    }

    setAiBusy(true);
    const requestId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
          if (status) setAiProgress(status);
        })
        .catch(() => undefined);
    }, 1000);
    try {
      const result = await requestAIDecision(game, pending.seatId, requestId, providerApiKeys);
      if (!result.ok || !result.command) {
        setAiStepStatus(result.error ? `自动处理失败：${result.error}` : "自动处理失败，请稍后重试。");
        return;
      }
      void loadAIDecisionStatus(requestId)
        .then((status) => {
          if (status) setAiProgress(status);
        })
        .catch(() => undefined);
      setGame((current) => {
        if (!current) return current;
        let next = applyCommand(current, result.command as GameCommand);
        if (result.memoryUpdate) {
          next = applyAgentMemoryUpdate(next, pending.seatId, result.memoryUpdate as AgentMemoryUpdate);
        }
        if (result.llmCall) next.llmCalls.push(result.llmCall as LLMCallLog);
        return next;
      });
      const publicText = officialOutputForCommand(game, pending, result.command, humanPlayerId);
      if (publicText) streamOfficialOutput(publicText, pending.seatId);
      setAiStepStatus(result.fallback ? "真实模型未返回可用动作，已用规则兜底继续。" : `${seatName(game, pending.seatId)} 已完成 ${pendingLabel(pending)}。`);
      if (result.command) {
        const nextState = applyCommand(game, result.command as GameCommand);
        pauseAfterReadableAIOutput(pending, publicText, nextState);
      }
    } catch (error) {
      setAiStepStatus(error instanceof Error ? `自动处理失败：${error.message}` : "自动处理失败，请稍后重试。");
    } finally {
      window.clearInterval(pollTimer);
      setAiBusy(false);
    }
  }

  function pauseAfterReadableAIOutput(pending: PendingAction, publicText: string, nextState: GameState): void {
    if (!humanPlayerId) return;
    const hasReadableSpeech = Boolean(publicText) && (pending.kind === "speech" || pending.kind === "wolf_discussion");
    if (!hasReadableSpeech) return;
    setAutoRun(false);
    setIsPaused(true);
    setAiStepStatus(`${seatName(nextState, pending.seatId)} 发言结束，点击继续进入下一位。`);
  }

  function submitHumanAction(): void {
    if (!game || !humanPending) return;
    const command = buildHumanCommand(game, humanPending, selectedTarget, speechText, wolfAgree, sheriffRun);
    if (!command) return;
    setGame(applyCommand(game, command));
  }

  function withdrawSheriffCandidacy(): void {
    if (!game || !humanPlayerId || !canWithdrawSheriff(game, humanPlayerId)) return;
    setGame(applyCommand(game, { type: "WithdrawSheriffCandidacy", seatId: humanPlayerId, privateReason: "真人警上退水。" }));
  }

  function submitWolfSelfExplosion(): void {
    if (!game || !humanPlayerId || !canWolfSelfExplode(game, humanPlayerId)) return;
    const next = applyCommand(game, {
      type: "SubmitWolfSelfExplosion",
      seatId: humanPlayerId,
      privateReason: "真人狼人选择自爆，结束当前回合并直接进入夜晚。"
    });
    setGame(next);
    setAutoRun(true);
    setIsPaused(false);
    clearStreamingOutput();
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
      const restored = restoreSnapshotFixture(JSON.parse(await file.text()));
      setGame(restored);
      setSetup(restored.setup);
      setAutoRun(true);
      setBatchResult(null);
      clearStreamingOutput();
      setAiProgress(null);
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
    setGame((current) =>
      current
        ? applyCommand(current, {
            type: "DebugForceKill",
            seatId,
            reason: "手动调试强制死亡。"
          })
        : current
    );
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
    setStreamingSpeechSeatId(undefined);
  }

  function streamOfficialOutput(text: string, seatId: PlayerId): void {
    let index = 0;
    clearStreamingOutput();
    setStreamingSpeechSeatId(seatId);
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
      setConfig(stripProviderSecrets(saved));
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
          setConfig((current) => upsertFetchedModels(current, provider.id, incoming));
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
          <SetupScreen setup={setup} setSetup={setSetup} onStart={startGame} />
        </>
      ) : (
        <GameRoom
          game={game}
          visibleEvents={visibleEvents}
          sideTab={tab}
          setSideTab={setTab}
          autoRun={autoRun}
          isPaused={isPaused}
          aiBusy={aiBusy}
          aiElapsedSeconds={aiElapsedSeconds}
          aiProgress={aiProgress}
          aiStepStatus={aiStepStatus}
          streamingSpeech={streamingSpeech}
          streamingSpeechSeatId={streamingSpeechSeatId}
          humanPlayerId={humanPlayerId}
          humanPending={humanPending}
          selectedTarget={selectedTarget}
          setSelectedTarget={setSelectedTarget}
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
            setIsPaused((current) => {
              const next = !current;
              setAutoRun(!next);
              return next;
            });
          }}
          onRestart={restartGame}
          onOpenAdmin={() => setScreen("admin")}
          onNewGame={() => {
            setAutoRun(false);
            setIsPaused(false);
            setGame(null);
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

function GameRoom({
  game,
  visibleEvents,
  sideTab,
  setSideTab,
  autoRun,
  isPaused,
  aiBusy,
  aiElapsedSeconds,
  aiProgress,
  aiStepStatus,
  streamingSpeech,
  streamingSpeechSeatId,
  humanPlayerId,
  humanPending,
  selectedTarget,
  setSelectedTarget,
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
  sideTab: GameSideTab;
  setSideTab: (tab: GameSideTab) => void;
  autoRun: boolean;
  isPaused: boolean;
  aiBusy: boolean;
  aiElapsedSeconds: number;
  aiProgress: AIDecisionStatus | null;
  aiStepStatus: string;
  streamingSpeech: string;
  streamingSpeechSeatId?: PlayerId;
  humanPlayerId?: PlayerId;
  humanPending?: PendingAction;
  selectedTarget: PlayerId | "abstain" | "skip" | "destroy";
  setSelectedTarget: (value: PlayerId | "abstain" | "skip" | "destroy") => void;
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
  const sheriffNotice = useMemo(() => buildSheriffElectionNotice(game), [game.events.length, game.id]);
  const showSheriffNotice = Boolean(sheriffNotice && sheriffNotice.seq > dismissedNoticeSeq);
  const flowNotice = useMemo(
    () => buildFlowNotice(game, visibleEvents, humanPlayerId, dismissedFlowNoticeKeys),
    [dismissedFlowNoticeKeys, game.events.length, game.id, humanPlayerId, visibleEvents]
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
          <span>{visiblePhaseLabel(game, humanPlayerId)}</span>
          <strong>{visiblePhaseProgress(game, humanPlayerId)}</strong>
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
        <SeatPanel game={game} humanPlayerId={humanPlayerId} />
        <CenterPanel
          game={game}
          visibleEvents={visibleEvents}
          aiBusy={aiBusy}
          aiElapsedSeconds={aiElapsedSeconds}
          aiProgress={aiProgress}
          aiStepStatus={aiStepStatus}
          streamingSpeech={streamingSpeech}
          streamingSpeechSeatId={streamingSpeechSeatId}
          isPaused={isPaused}
          autoRun={autoRun}
          humanPlayerId={humanPlayerId}
          humanPending={humanPending}
          onTogglePause={onTogglePause}
        />
        <aside className="right-panel room-side">
          <TabBar active={sideTab} onChange={setSideTab} />
          {sideTab === "chat" && (
            <ActionPanel
              game={game}
              visibleEvents={visibleEvents}
              humanPending={humanPending}
              selectedTarget={selectedTarget}
              setSelectedTarget={setSelectedTarget}
              speechText={speechText}
              setSpeechText={setSpeechText}
              wolfAgree={wolfAgree}
              setWolfAgree={setWolfAgree}
              sheriffRun={sheriffRun}
              setSheriffRun={setSheriffRun}
              canWithdrawSheriff={canWithdrawSheriff}
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
      <footer className="room-dock">
        <button className="primary-button" onClick={() => setSideTab("chat")}>
          <FileText size={17} />
          发言/行动
        </button>
        <button className="ghost-button" onClick={() => setSideTab("votes")}>
          <Vote size={17} />
          投票
        </button>
        <button className="ghost-button" onClick={() => setSideTab("records")}>
          <FileText size={17} />
          记录
        </button>
        <button className="ghost-button" onClick={() => setSideTab("exposure")}>
          <Eye size={17} />
          暴露模式
        </button>
        <div className="dock-status">{isPaused ? "AI 自动行动已暂停" : "AI 自动行动已开启"}</div>
      </footer>
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
  onStart
}: {
  setup: GameSetup;
  setSetup: (setup: GameSetup) => void;
  onStart: () => void;
}): JSX.Element {
  const aiPlayers = setup.totalPlayers - setup.humanPlayers;

  function patch(next: Partial<GameSetup>): void {
    const totalPlayers = clampNumber(next.totalPlayers ?? setup.totalPlayers, 6, 12);
    const humanPlayers = clampNumber(next.humanPlayers ?? setup.humanPlayers, 0, totalPlayers);
    setSetup({ ...setup, ...next, totalPlayers, humanPlayers, aiPlayers: totalPlayers - humanPlayers });
  }

  return (
    <section className="setup-page">
      <div className="setup-copy">
        <h2>创建可观战/可参与的 AI 狼人杀</h2>
        <p>第一版聚焦稳定规则、API 接入、透明日志和可顺畅跑完一局。真人数可以为 0，剩余座位由 AI 补齐。</p>
      </div>
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
            <input type="range" min={0} max={setup.totalPlayers} value={setup.humanPlayers} onChange={(event) => patch({ humanPlayers: Number(event.target.value) })} />
            <input
              aria-label="真人数量数字"
              type="number"
              min={0}
              max={setup.totalPlayers}
              value={setup.humanPlayers}
              onChange={(event) => patch({ humanPlayers: Number(event.target.value) })}
            />
          </div>
          <strong>{setup.humanPlayers} 真人 · {aiPlayers} AI</strong>
        </label>
        <label>
          随机种子
          <input value={setup.seed} onChange={(event) => patch({ seed: event.target.value })} />
        </label>
        <div className="setup-visibility-note">
          <strong>普通视角</strong>
          <p>游戏房间默认隐藏其他玩家身份、AI 后台理由、prompt 和思考日志；测试时在右侧“暴露模式”查看。</p>
        </div>
        <Toggle label="允许暴露模式手动调试" checked={setup.debugMode.allowManualOverride} onChange={(value) => patch({ debugMode: { ...setup.debugMode, allowManualOverride: value } })} />
        <button className="primary-button large" onClick={onStart}>
          <Play size={18} />
          开始游戏
        </button>
      </div>
    </section>
  );
}

function SeatPanel({ game, humanPlayerId }: { game: GameState; humanPlayerId?: PlayerId }): JSX.Element {
  const human = humanPlayerId ? game.players.find((player) => player.id === humanPlayerId) : undefined;
  const role = human ? ROLE_DEFINITIONS[human.role] : undefined;
  const wolfTeammates =
    human?.role === "werewolf" ? game.players.filter((player) => player.role === "werewolf" && player.id !== human.id) : [];
  const steps = ["夜晚行动", "警长竞选", "白天发言", "投票放逐", "游戏结束"];
  const activeStep = game.status === "ended" ? 4 : game.phase.type.startsWith("night") ? 0 : game.phase.type.startsWith("sheriff") ? 1 : game.phase.type.includes("vote") ? 3 : 2;
  const phaseLabel = visiblePhaseLabel(game, humanPlayerId);
  const phaseProgress = visiblePhaseProgress(game, humanPlayerId);
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
      <section className="record-shortcut">
        <FileText size={18} />
        <div>
          <strong>游戏记录</strong>
          <p>公开发言、投票和死亡记录会实时写入复盘。</p>
        </div>
      </section>
    </aside>
  );
}

function CenterPanel({
  game,
  visibleEvents,
  aiBusy,
  aiElapsedSeconds,
  aiProgress,
  aiStepStatus,
  streamingSpeech,
  streamingSpeechSeatId,
  isPaused,
  autoRun,
  humanPlayerId,
  humanPending,
  onTogglePause
}: {
  game: GameState;
  visibleEvents: ReturnType<typeof getVisibleEvents>;
  aiBusy: boolean;
  aiElapsedSeconds: number;
  aiProgress: AIDecisionStatus | null;
  aiStepStatus: string;
  streamingSpeech: string;
  streamingSpeechSeatId?: PlayerId;
  isPaused: boolean;
  autoRun: boolean;
  humanPlayerId?: PlayerId;
  humanPending?: PendingAction;
  onTogglePause: () => void;
}): JSX.Element {
  const aiPending = game.pendingActions.find((action) => game.players.find((player) => player.id === action.seatId)?.controller !== "human");
  const visibleActingSeat = visibleActingSeatId(game, humanPlayerId);
  const actingPlayer = visibleActingSeat ? game.players.find((player) => player.id === visibleActingSeat) : undefined;
  const activePending = visibleActingSeat ? game.pendingActions.find((action) => action.seatId === visibleActingSeat) : undefined;
  const activePendingExpectsSpeech =
    activePending?.kind === "speech" || activePending?.kind === "wolf_discussion" || activePending?.kind === "sheriff_candidacy";
  const activeStreamingSpeech = visibleActingSeat && streamingSpeechSeatId === visibleActingSeat ? streamingSpeech : "";
  const latestActingSpeech =
    visibleActingSeat === undefined || activePendingExpectsSpeech
      ? undefined
      : [...visibleEvents]
          .reverse()
          .find(
            (event) =>
              event.seatId === visibleActingSeat &&
              (event.type === "SpeechPublished" || event.type === "LastWordsPublished" || event.type === "WolfDiscussionMessage")
          );
  const statusText = buildActionStatusText(game, humanPlayerId, humanPending, aiPending, aiBusy, aiElapsedSeconds, aiProgress, isPaused, autoRun, aiStepStatus);
  const speechLabel = aiBusy ? thinkingLabel(aiProgress, aiElapsedSeconds) : activeStreamingSpeech ? "流式输出" : latestActingSpeech ? "最近发言" : "当前玩家发言";
  const phaseLabel = visiblePhaseLabel(game, humanPlayerId);
  const phaseProgress = visiblePhaseProgress(game, humanPlayerId);
  return (
    <section className="center-panel table-panel">
      <div className="table-scene">
        <div className="moonlit-table">
          {game.players.map((player, index) => {
            const angle = -90 + (360 / game.players.length) * index;
            const active = visibleActingSeat === player.id;
            return (
              <div
                className={`table-seat ${active ? "active" : ""} ${!player.alive ? "dead" : ""}`}
                style={{ "--seat-angle": `${angle}deg` } as CSSProperties}
                key={player.id}
              >
                <div className="seat-orbit-card">
                  <span className="seat-number">{player.seatNumber}</span>
                  <div className="avatar portrait">{publicPlayerAvatar(player)}</div>
                  {player.id === visibleActingSeat && (
                    <span className={`thinking-dot ${aiBusy ? "thinking" : ""}`}>
                      {seatActivityLabel(player, humanPending, aiBusy, isPaused, autoRun)}
                    </span>
                  )}
                  <strong>{publicPlayerLabel(player)}</strong>
                  <p>{player.alive ? "存活" : deathReasonForViewer(game, player, humanPlayerId)}</p>
                  {player.isSheriff && <Award size={15} className="sheriff-icon" />}
                </div>
              </div>
            );
          })}
          <div className="table-core">
            <StatusBadge game={game} />
            <h2>{phaseLabel}</h2>
            <strong>
              {actingPlayer
                ? `${seatName(game, actingPlayer.id)} · ${seatActivityLabel(actingPlayer, humanPending, aiBusy, isPaused, autoRun)}`
                : phaseProgress}
            </strong>
            <div className="table-speech">
              <span>{speechLabel}</span>
              <p>
                {activeStreamingSpeech ||
                  (latestActingSpeech ? eventSummary(game, latestActingSpeech.type, latestActingSpeech.payload, latestActingSpeech.seatId) : "等待当前玩家发言。")}
              </p>
            </div>
          </div>
        </div>
        <div className="speech-stream">
          <span>系统状态</span>
          <p>{statusText}</p>
          {isPaused && aiPending && !humanPending && (
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
    return `轮到你进行${pendingLabel(humanPending)}，请在右侧提交发言或目标。没有倒计时限制。`;
  }
  if (isPaused) return "已暂停。AI 自动行动已停止，点击继续后恢复。";
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
  if ((phaseType === "night_wolves" || pendingKind === "wolf_discussion") && human.role === "werewolf") return true;
  return actingSeatId === human.id;
}

function thinkingLabel(progress: AIDecisionStatus | null, elapsedSeconds: number): string {
  const elapsed = elapsedSeconds > 0 ? ` · ${elapsedSeconds}s` : "";
  if (!progress) return `AI 思考中${elapsed}`;
  if (progress.status === "building_prompt") return `整理可见信息${elapsed}`;
  if (progress.status === "provider_request") return `模型思考中${elapsed}`;
  if (progress.status === "repairing") return `格式校验中${elapsed}`;
  return `AI 思考中${elapsed}`;
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
            {legal.length > 0 && (
              <label>
                目标
                <select value={selectedTarget} onChange={(event) => setSelectedTarget(event.target.value as PlayerId)}>
                  {humanPending.kind === "vote" && allowAbstain && <option value="abstain">弃票</option>}
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
              <div className="toggle-grid compact">
                <Toggle label="使用解药" checked={selectedTarget === "abstain"} onChange={(value) => setSelectedTarget(value ? "abstain" : legal[0] ?? "abstain")} />
              </div>
            )}
            {humanPending.kind === "wolf_discussion" && (
              <Toggle label="同意当前提案" checked={wolfAgree} onChange={setWolfAgree} />
            )}
            {humanPending.kind === "sheriff_candidacy" && (
              <Toggle label="上警竞选" checked={sheriffRun} onChange={setSheriffRun} />
            )}
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
  const [selectedProviderId, setSelectedProviderId] = useState(config.providers[0]?.id ?? "");
  const selectedProvider = config.providers.find((provider) => provider.id === selectedProviderId) ?? config.providers[0];
  const apiSummary = buildApiAccessSummary(readinessConfig, providerApiKeys, providerTestResults);
  const testedProviders = config.providers.filter((provider) => providerTestResults[provider.id]);

  useEffect(() => {
    if (!selectedProvider || !config.providers.some((provider) => provider.id === selectedProviderId)) {
      setSelectedProviderId(config.providers[0]?.id ?? "");
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
                  <input value={selectedProvider.defaultModel} onChange={(event) => updateProvider(selectedProvider.id, { defaultModel: event.target.value })} />
                </label>
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
  aiBusy
}: {
  game: GameState;
  batchResult: MockBatchRunResult | null;
  debugStatus: string;
  aiBusy: boolean;
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
          game.llmCalls.slice(-8).map((call) => (
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
                <span>Prompt {call.promptHash}</span>
              </div>
              {call.error && <p className="call-error">{call.error}</p>}
              <pre>{JSON.stringify(call.parsedJson, null, 2)}</pre>
              {call.promptTextRedacted && <pre>{call.promptTextRedacted}</pre>}
            </details>
          ))
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
  if (pending.kind !== "speech" && pending.kind !== "wolf_discussion") return "";
  if (pending.kind === "wolf_discussion") return canViewerSeeWolfChat(state, viewerId) ? latestEventText(state, ["WolfDiscussionMessage"]) : "";
  return latestEventText(state, ["SpeechPublished", "LastWordsPublished"]);
}

function officialOutputForCommand(state: GameState, pending: PendingAction, command: GameCommand, viewerId?: PlayerId): string {
  if (pending.kind === "speech" && "text" in command) return command.text;
  if (pending.kind === "wolf_discussion" && "messageToWolves" in command && canViewerSeeWolfChat(state, viewerId)) return command.messageToWolves;
  return "";
}

function latestEventText(state: GameState, types: string[]): string {
  const event = [...state.events].reverse().find((item) => types.includes(item.type));
  if (!event) return "";
  const payload = event.payload as { text?: unknown; publicSpeech?: unknown; messageToWolves?: unknown };
  return String(payload.text ?? payload.publicSpeech ?? payload.messageToWolves ?? "");
}

function canViewerSeeWolfChat(state: GameState, viewerId?: PlayerId): boolean {
  if (state.setup.debugMode.revealRoles || state.setup.debugMode.revealWolfChat || state.setup.debugMode.revealNightActions) return true;
  return state.players.find((player) => player.id === viewerId)?.role === "werewolf";
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
  return (
    <div className="status-badge running">
      <Moon size={16} />
      进行中
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

function publicPlayerLabel(player: GameState["players"][number]): string {
  return player.controller === "human" ? player.name : "玩家";
}

function publicPlayerAvatar(player: GameState["players"][number]): string {
  return player.controller === "human" ? player.avatar : String(player.seatNumber);
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
  wolfAgree: boolean,
  sheriffRun: boolean
): GameCommand | undefined {
  if (pending.kind === "guard_protect" || pending.kind === "seer_check") {
    const targetId = selectedTarget !== "abstain" && selectedTarget !== "skip" ? selectedTarget : pending.legalTargets[0];
    return {
      type: "SubmitNightAction",
      seatId: pending.seatId,
      action: pending.kind,
      targetId,
      privateReason: "真人玩家提交夜间行动。"
    };
  }
  if (pending.kind === "witch_action") {
    const save = selectedTarget === "abstain" && pending.canSave;
    const poisonTargetId = selectedTarget !== "abstain" && selectedTarget !== "skip" ? selectedTarget : undefined;
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
  return Boolean(player?.isSheriffCandidate && !player.hasWithdrawnSheriff && game.phase.type === "sheriff_speech");
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
  return {
    seq: conclusion.seq,
    title: winner ? `${seatName(game, winner)} 当选警长` : "本局无警长",
    voteRows: votes
      ? Object.entries(votes).map(([voterId, targetId]) => `${seatName(game, voterId)} ${targetId === "abstain" ? "弃票" : `投给 ${seatName(game, targetId)}`}`)
      : [],
    tallyRows: tally ? Object.entries(tally).map(([targetId, count]) => `${seatName(game, targetId)} ${count}票`) : [],
    result: winner ? `最终警徽给到 ${seatName(game, winner)}。` : `结果：${String(conclusionPayload.reason ?? "无人当选")}。`
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
  const phaseKeys = new Set<string>();
  for (const event of visibleEvents) {
    const notice = flowNoticeForEvent(game, event, humanPlayerId, phaseKeys);
    if (notice && !dismissedKeys.includes(notice.key)) return notice;
  }
  return undefined;
}

function flowNoticeForEvent(
  game: GameState,
  event: ReturnType<typeof getVisibleEvents>[number],
  humanPlayerId: PlayerId,
  phaseKeys: Set<string>
): FlowNotice | undefined {
  const data = event.payload as Record<string, unknown>;
  if (event.type === "PhaseStarted") return phaseNotice(game, event, humanPlayerId, phaseKeys);
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
    const action = String(data.action ?? "");
    return {
      key: event.id,
      kicker: "你的夜间行动",
      title: action === "guard_protect" ? "守护已确认" : "夜间行动已确认",
      body: data.targetId ? `你本晚选择了 ${seatName(game, data.targetId as PlayerId)}。` : "你的夜间行动已提交。",
      rows: [],
      chips: []
    };
  }
  if (event.type === "WitchActionSubmitted" && event.seatId === humanPlayerId) {
    const rows = [
      data.wolfTarget ? `今晚刀口：${seatName(game, data.wolfTarget as PlayerId)}` : "今晚没有刀口信息",
      data.save ? "你选择使用解药" : "你选择不使用解药",
      data.poisonTargetId ? `毒药目标：${seatName(game, data.poisonTargetId as PlayerId)}` : "未使用毒药"
    ];
    return {
      key: event.id,
      kicker: "你的夜间行动",
      title: "女巫行动已确认",
      body: "你的用药选择已记录，其他玩家不会看到你的药况。",
      rows,
      chips: []
    };
  }
  if (event.type === "WolfKillLocked") {
    return {
      key: event.id,
      kicker: "狼人夜间结果",
      title: "刀口已确认",
      body: `狼队今晚的刀口是 ${seatName(game, data.targetId as PlayerId)}。`,
      rows: [],
      chips: []
    };
  }
  if (event.type === "SheriffVoteResolved") {
    const top = (data.top as PlayerId[] | undefined) ?? [];
    const voteType = String(data.voteType ?? "");
    if (voteType !== "sheriff" || top.length <= 1) return undefined;
    const votes = formatVoteRows(game, data.votes as Record<PlayerId, PlayerId | "abstain"> | undefined);
    const tiedPlayers = top.map((id) => seatName(game, id)).join("、");
    return {
      key: event.id,
      kicker: "警长投票结果",
      title: "首轮平票，进入 PK",
      body: tiedPlayers ? `平票玩家：${tiedPlayers}。进入警长 PK 发言。` : "首轮警长投票平票，进入 PK 发言。",
      rows: votes ? [votes] : [],
      chips: tallyChips(game, data.tally as Record<PlayerId, number> | undefined)
    };
  }
  if (event.type === "DayVoteResolved") {
    const votes = formatVoteRows(game, data.votes as Record<PlayerId, PlayerId | "abstain"> | undefined);
    return {
      key: event.id,
      kicker: "投票结果",
      title: String(data.voteType ?? "") === "day_pk" ? "PK 投票结束" : "白天投票结束",
      body: votes || "投票已经结算。",
      rows: [],
      chips: tallyChips(game, data.tally as Record<PlayerId, number> | undefined)
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

function phaseNotice(
  game: GameState,
  event: ReturnType<typeof getVisibleEvents>[number],
  humanPlayerId: PlayerId,
  phaseKeys: Set<string>
): FlowNotice | undefined {
  const data = event.payload as Record<string, unknown>;
  const phase = String(data.phase ?? "");
  const day = Number(data.day ?? game.day);
  const actingSeatId = typeof data.actingSeatId === "string" ? data.actingSeatId : undefined;
  const key = phaseNoticeKey(phase, day, actingSeatId === humanPlayerId);
  if (!key || phaseKeys.has(key)) return undefined;
  phaseKeys.add(key);

  if (phase === "night_hidden") {
    return {
      key,
      kicker: "夜晚阶段",
      title: "天黑请闭眼",
      body: day === 0 ? "首夜开始，夜间行动将按规则顺序进行。" : `第 ${day + 1} 夜开始，夜间行动将按规则顺序进行。`,
      rows: [],
      chips: []
    };
  }
  if (phase === "night_guard" && actingSeatId === humanPlayerId) {
    return { key, kicker: "夜晚阶段", title: "守卫行动", body: "请选择今晚要守护的玩家。", rows: [], chips: [] };
  }
  if (phase === "night_wolves" && canViewerSeeWolfChat(game, humanPlayerId)) {
    return { key, kicker: "夜晚阶段", title: "狼人夜聊", body: "狼队可以讨论并确认今晚刀口。", rows: [], chips: [] };
  }
  if (phase === "night_seer" && actingSeatId === humanPlayerId) {
    return { key, kicker: "夜晚阶段", title: "预言家查验", body: "请选择今晚要查验的玩家，提交后会显示查验结果。", rows: [], chips: [] };
  }
  if (phase === "night_witch" && actingSeatId === humanPlayerId) {
    return { key, kicker: "夜晚阶段", title: "女巫行动", body: "请根据今晚刀口和药量选择是否用药。", rows: [], chips: [] };
  }
  if (phase === "sheriff_candidacy") {
    return { key, kicker: "警长竞选", title: "是否上警", body: "请选择是否参与警长竞选；这一步不是正式警上发言。", rows: [], chips: [] };
  }
  if (phase === "sheriff_speech" || phase === "sheriff_pk_speech") {
    return { key, kicker: "警长竞选", title: phase === "sheriff_pk_speech" ? "警长 PK 发言" : "警上发言开始", body: "候选人依次发言，可以在投票前退水。", rows: [], chips: [] };
  }
  if (phase === "sheriff_vote" || phase === "sheriff_pk_vote") {
    return { key, kicker: "警长竞选", title: "警长投票", body: "警下玩家投票决定警长归属。", rows: [], chips: [] };
  }
  if (phase === "last_words") {
    return { key, kicker: "死亡发言", title: "遗言阶段", body: "出局玩家依次发表遗言。", rows: [], chips: [] };
  }
  if (phase === "day_speech" || phase === "day_pk_speech") {
    return { key, kicker: "白天阶段", title: phase === "day_pk_speech" ? "放逐 PK 发言" : "白天发言开始", body: "所有存活玩家按顺序发言，请根据公开信息判断。", rows: [], chips: [] };
  }
  if (phase === "day_vote" || phase === "day_pk_vote") {
    return { key, kicker: "投票阶段", title: phase === "day_pk_vote" ? "PK 投票" : "投票放逐", body: "请根据发言、票型和公开信息投票。", rows: [], chips: [] };
  }
  if (phase === "hunter_shot") {
    return { key, kicker: "猎人开枪", title: "猎人行动", body: "猎人可以选择是否开枪带走一名玩家。", rows: [], chips: [] };
  }
  if (phase === "badge_decision") {
    return { key, kicker: "警徽移交", title: "警长死亡", body: "警长需要选择移交警徽或撕毁警徽。", rows: [], chips: [] };
  }
  if (phase === "ended") {
    return { key, kicker: "游戏结束", title: game.winner === "wolves" ? "狼人胜利" : "好人胜利", body: game.endReason ?? "对局结束。", rows: [], chips: [] };
  }
  return undefined;
}

function phaseNoticeKey(phase: string, day: number, isHumanActor: boolean): string | undefined {
  if (phase === "death_announcement" || phase === "night_resolve") return undefined;
  if (phase === "night_hidden") return `phase:night:${day}`;
  if (phase === "night_guard" || phase === "night_seer" || phase === "night_witch") return isHumanActor ? `phase:${phase}:${day}` : `phase:night:${day}`;
  if (phase === "night_wolves") return `phase:night:${day}:wolves`;
  if (phase === "sheriff_speech" || phase === "sheriff_pk_speech") return `phase:${phase}:${day}`;
  if (phase === "day_speech" || phase === "day_pk_speech") return `phase:${phase}:${day}`;
  if (phase) return `phase:${phase}:${day}`;
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
  if (type === "NightActionSubmitted") return `${seatName(game, seatId)} 已提交夜间行动：${seatName(game, data.targetId as PlayerId)}`;
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
    const votes = formatVoteRows(game, data.votes as Record<PlayerId, PlayerId | "abstain"> | undefined);
    const tally = formatTally(game, data.tally as Record<PlayerId, number> | undefined);
    return `${type === "DayVoteResolved" ? "白天投票" : "警长投票"}结算：${votes ? `${votes}；` : ""}票型：${tally}`;
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
  return Object.entries(tally)
    .map(([id, count]) => `${seatName(game, id)} ${count}票`)
    .join("，");
}

function tallyChips(game: GameState, tally: Record<PlayerId, number> | undefined): string[] {
  if (!tally) return [];
  return Object.entries(tally).map(([id, count]) => `${seatName(game, id)} ${count}票`);
}

function formatVoteRows(game: GameState, votes: Record<PlayerId, PlayerId | "abstain"> | undefined): string {
  if (!votes) return "";
  return Object.entries(votes)
    .map(([voterId, targetId]) => `${seatName(game, voterId)}${targetId === "abstain" ? "弃票" : `投给${seatName(game, targetId)}`}`)
    .join("，");
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
        supportsReasoningEffort: provider.supportsReasoningEffort,
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
