import { GameState, createSnapshotFixture, restoreSnapshotFixture } from "@langrensha/engine";
import { ContextCompressionConfig } from "@langrensha/shared";

export const LOCAL_GAME_SESSION_STORAGE_KEY = "langrensha.gameSession.v1";
export const LOCAL_GAME_SESSION_VERSION = "langrensha-game-session-v2" as const;
const LEGACY_GAME_SESSION_VERSION = "langrensha-game-session-v1" as const;

export type GameSessionAIMode = "mock" | "llm";

export interface GameSessionPreferences {
  aiMode: GameSessionAIMode;
  gameContextCompression?: ContextCompressionConfig;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredGameSessionV2 {
  version: typeof LOCAL_GAME_SESSION_VERSION;
  savedAt: string;
  snapshot: ReturnType<typeof createSnapshotFixture>;
  preferences: GameSessionPreferences;
}

export interface StoredGameSessionLoadResult {
  game?: GameState;
  aiMode?: GameSessionAIMode;
  gameContextCompression?: ContextCompressionConfig;
  error?: string;
  hasStoredSession: boolean;
}

export function normalizeSingleBrowserHumanPlayers(value: number): 0 | 1 {
  return Number.isFinite(value) && Math.round(value) >= 1 ? 1 : 0;
}

export function assertSingleBrowserGame(game: GameState): GameState {
  if (
    !isRecord(game) ||
    typeof game.id !== "string" ||
    !isRecord(game.setup) ||
    !Number.isInteger(game.setup.totalPlayers) ||
    !Number.isInteger(game.setup.humanPlayers) ||
    !Number.isInteger(game.setup.aiPlayers) ||
    game.setup.totalPlayers < 6 ||
    game.setup.totalPlayers > 12 ||
    game.setup.humanPlayers + game.setup.aiPlayers !== game.setup.totalPlayers ||
    !isRecord(game.phase) ||
    typeof game.phase.type !== "string" ||
    typeof game.phase.label !== "string" ||
    !isRecord(game.rulePreset) ||
    !Array.isArray(game.players) ||
    !Array.isArray(game.pendingActions) ||
    !Array.isArray(game.events) ||
    !Array.isArray(game.llmCalls) ||
    !isRecord(game.resources) ||
    !isRecord(game.memories) ||
    !isRecord(game.round) ||
    !isRecord(game.round.sheriff) ||
    !Array.isArray(game.round.lastWordsQueue) ||
    !Array.isArray(game.round.lastDeaths)
  ) {
    throw new Error("本机对局存档缺少必要字段或字段格式不正确。");
  }
  if (
    game.players.some(
      (player) =>
        !isRecord(player) ||
        typeof player.id !== "string" ||
        !Number.isInteger(player.seatNumber) ||
        !["human", "ai", "mock", "remote"].includes(player.controller) ||
        typeof player.role !== "string" ||
        typeof player.alive !== "boolean"
    )
  ) {
    throw new Error("本机对局存档包含无效的玩家数据。");
  }
  const playerIds = new Set(game.players.map((player) => player.id));
  if (playerIds.size !== game.players.length || game.pendingActions.some((pending) => !isRecord(pending) || !playerIds.has(pending.seatId))) {
    throw new Error("本机对局存档包含无效的座位引用。");
  }
  const humanPlayers = game.players.filter((player) => player.controller === "human");
  if (game.setup.humanPlayers > 1 || humanPlayers.length > 1) {
    throw new Error("当前单浏览器版本仅支持 0 或 1 名真人，无法载入包含多名真人的旧对局。");
  }
  if (game.setup.humanPlayers !== humanPlayers.length) {
    throw new Error("存档中的真人数量与座位控制方式不一致。");
  }
  return game;
}

export function serializeGameSession(game: GameState, preferences: GameSessionPreferences = { aiMode: "mock" }): string {
  const stored: StoredGameSessionV2 = {
    version: LOCAL_GAME_SESSION_VERSION,
    savedAt: new Date().toISOString(),
    snapshot: createSnapshotFixture(compactGameForPersistence(assertSingleBrowserGame(game))),
    preferences: normalizeSessionPreferences(preferences)
  };
  return JSON.stringify(stored);
}

export function compactGameForPersistence(game: GameState): GameState {
  return {
    id: game.id,
    setup: game.setup,
    rulePreset: game.rulePreset,
    players: game.players,
    phase: game.phase,
    pendingActions: game.pendingActions,
    day: game.day,
    sheriffSeatId: game.sheriffSeatId,
    badgeDestroyed: game.badgeDestroyed,
    status: game.status,
    winner: game.winner,
    endReason: game.endReason,
    events: game.events,
    llmCalls: game.llmCalls.map((call) => ({
      ...call,
      promptTextRedacted: truncate(call.promptTextRedacted, 800) ?? "",
      rawResponse: "",
      parsedJson: {},
      publicSpeech: truncate(call.publicSpeech, 1200),
      privateRationale: truncate(call.privateRationale, 800),
      error: truncate(call.error, 500)
    })),
    resources: game.resources,
    memories: game.memories,
    round: game.round
  };
}

export function restoreGameSession(raw: string): GameState {
  return restoreGameSessionWithPreferences(raw).game;
}

export function restoreGameSessionWithPreferences(raw: string): { game: GameState } & GameSessionPreferences {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("本机对局存档不是有效的 JSON。");
  }
  if (
    !isRecord(value) ||
    (value.version !== LOCAL_GAME_SESSION_VERSION && value.version !== LEGACY_GAME_SESSION_VERSION) ||
    !isRecord(value.snapshot)
  ) {
    throw new Error("本机对局存档版本不受支持。");
  }
  const game = assertSingleBrowserGame(restoreSnapshotFixture(value.snapshot));
  if (value.version === LEGACY_GAME_SESSION_VERSION) {
    return { game, aiMode: "mock" };
  }
  if (!isRecord(value.preferences)) {
    throw new Error("本机对局存档缺少运行模式设置。");
  }
  return { game, ...parseSessionPreferences(value.preferences) };
}

export function loadStoredGameSession(storage: StorageLike): StoredGameSessionLoadResult {
  let raw: string | null;
  try {
    raw = storage.getItem(LOCAL_GAME_SESSION_STORAGE_KEY);
  } catch (error) {
    return {
      hasStoredSession: false,
      error: error instanceof Error ? `无法读取本机对局：${error.message}` : "无法读取本机对局。"
    };
  }
  if (!raw) return { hasStoredSession: false };
  try {
    const restored = restoreGameSessionWithPreferences(raw);
    return { ...restored, hasStoredSession: true };
  } catch (error) {
    return {
      hasStoredSession: true,
      error: error instanceof Error ? error.message : "本机对局恢复失败。"
    };
  }
}

export function saveStoredGameSession(storage: StorageLike, game: GameState, preferences: GameSessionPreferences = { aiMode: "mock" }): void {
  storage.setItem(LOCAL_GAME_SESSION_STORAGE_KEY, serializeGameSession(game, preferences));
}

export function clearStoredGameSession(storage: StorageLike): void {
  storage.removeItem(LOCAL_GAME_SESSION_STORAGE_KEY);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function normalizeSessionPreferences(preferences: GameSessionPreferences): GameSessionPreferences {
  return parseSessionPreferences(preferences as unknown as Record<string, unknown>);
}

function parseSessionPreferences(value: Record<string, unknown>): GameSessionPreferences {
  if (value.aiMode !== "mock" && value.aiMode !== "llm") {
    throw new Error("本机对局存档中的 AI 运行模式无效。");
  }
  const rawCompression = value.gameContextCompression;
  if (rawCompression === undefined) return { aiMode: value.aiMode };
  if (
    !isRecord(rawCompression) ||
    typeof rawCompression.enabled !== "boolean" ||
    (rawCompression.mode !== "auto" && rawCompression.mode !== "full_only")
  ) {
    throw new Error("本机对局存档中的上下文压缩设置无效。");
  }
  return {
    aiMode: value.aiMode,
    gameContextCompression: { enabled: rawCompression.enabled, mode: rawCompression.mode }
  };
}
