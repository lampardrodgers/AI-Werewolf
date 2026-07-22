import { describe, expect, it } from "vitest";
import { createGame, runUntilBlocked, type GameState } from "@langrensha/engine";
import { DEFAULT_DEBUG_MODE, STANDARD_PRESET } from "@langrensha/shared";
import {
  LOCAL_GAME_SESSION_STORAGE_KEY,
  clearStoredGameSession,
  compactGameForPersistence,
  loadStoredGameSession,
  normalizeSingleBrowserHumanPlayers,
  restoreGameSession,
  saveStoredGameSession,
  serializeGameSession
} from "../src/gameSession";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function makeGame(humanPlayers = 1): GameState {
  return createGame({
    totalPlayers: 6,
    humanPlayers,
    aiPlayers: 6 - humanPlayers,
    seed: `web-session-${humanPlayers}`,
    rulePresetId: STANDARD_PRESET.id,
    debugMode: DEFAULT_DEBUG_MODE
  });
}

describe("single-browser game sessions", () => {
  it("normalizes every setup to spectator or one-human mode", () => {
    expect(normalizeSingleBrowserHumanPlayers(-1)).toBe(0);
    expect(normalizeSingleBrowserHumanPlayers(0)).toBe(0);
    expect(normalizeSingleBrowserHumanPlayers(0.49)).toBe(0);
    expect(normalizeSingleBrowserHumanPlayers(1)).toBe(1);
    expect(normalizeSingleBrowserHumanPlayers(2)).toBe(1);
  });

  it("round-trips a versioned running game without browser-only secrets", () => {
    const game = makeGame();
    const secret = "sk-must-not-enter-game-snapshot";
    const gameWithBrowserOnlySecret = { ...game, providerApiKeys: { provider: secret } } as GameState & { providerApiKeys: Record<string, string> };
    const raw = serializeGameSession(gameWithBrowserOnlySecret);
    const restored = restoreGameSession(raw);

    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("providerApiKeys");
    expect(restored).toEqual(game);
  });

  it("restores the game AI mode and per-game context compression settings", () => {
    const storage = new MemoryStorage();
    const game = makeGame();
    saveStoredGameSession(storage, game, {
      aiMode: "mock",
      gameContextCompression: { enabled: false, mode: "full_only" }
    });

    const restored = loadStoredGameSession(storage);
    expect(restored.game?.id).toBe(game.id);
    expect(restored.aiMode).toBe("mock");
    expect(restored.gameContextCompression).toEqual({ enabled: false, mode: "full_only" });
  });

  it("migrates legacy v1 sessions to mock mode so an unknown old mode cannot trigger real calls", () => {
    const storage = new MemoryStorage();
    const current = JSON.parse(serializeGameSession(makeGame())) as Record<string, unknown>;
    current.version = "langrensha-game-session-v1";
    delete current.preferences;
    storage.setItem(LOCAL_GAME_SESSION_STORAGE_KEY, JSON.stringify(current));

    const restored = loadStoredGameSession(storage);
    expect(restored.game).toBeDefined();
    expect(restored.aiMode).toBe("mock");
    expect(restored.gameContextCompression).toBeUndefined();
  });

  it("compacts large model diagnostics without mutating the in-memory game", () => {
    const game = makeGame();
    const longPrompt = "p".repeat(5_000);
    const longResponse = "r".repeat(20_000);
    game.llmCalls.push({
      id: "call-1",
      gameId: game.id,
      phase: game.phase.type,
      provider: "provider",
      model: "model",
      promptVersion: "v1",
      promptHash: "hash",
      promptTextRedacted: longPrompt,
      rawResponse: longResponse,
      parsedJson: { verbose: longResponse },
      publicSpeech: "公开发言",
      privateRationale: "理由".repeat(1_000),
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 10,
      cachedTokens: 0,
      estimatedCost: 0.01,
      latencyMs: 100,
      retryCount: 0
    });

    const compacted = compactGameForPersistence(game);
    expect(compacted.llmCalls[0].rawResponse).toBe("");
    expect(compacted.llmCalls[0].parsedJson).toEqual({});
    expect(compacted.llmCalls[0].promptTextRedacted.length).toBeLessThan(longPrompt.length);
    expect(compacted.llmCalls[0].estimatedCost).toBe(0.01);
    expect(game.llmCalls[0].rawResponse).toBe(longResponse);
    expect(game.llmCalls[0].parsedJson).toEqual({ verbose: longResponse });
  });

  it("persists ended games until the user explicitly clears the room", () => {
    const storage = new MemoryStorage();
    const game = runUntilBlocked(makeGame(0));
    expect(game.status).toBe("ended");

    saveStoredGameSession(storage, game);
    const restored = loadStoredGameSession(storage).game;
    expect(restored?.id).toBe(game.id);
    expect(restored?.status).toBe("ended");
    expect(restored?.winner).toBe(game.winner);
    expect(restored?.pendingActions).toEqual([]);

    clearStoredGameSession(storage);
    expect(storage.getItem(LOCAL_GAME_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("reports corrupt and unsupported sessions without silently deleting them", () => {
    const storage = new MemoryStorage();
    storage.setItem(LOCAL_GAME_SESSION_STORAGE_KEY, "{not-json");

    const result = loadStoredGameSession(storage);
    expect(result.game).toBeUndefined();
    expect(result.error).toContain("有效的 JSON");
    expect(result.hasStoredSession).toBe(true);
    expect(storage.getItem(LOCAL_GAME_SESSION_STORAGE_KEY)).toBe("{not-json");

    expect(() => restoreGameSession(JSON.stringify({ version: "future-version", snapshot: {} }))).toThrow("版本不受支持");
  });

  it("leaves the current in-memory game intact when local storage rejects a write", () => {
    const game = makeGame();
    const before = structuredClone(game);
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };

    expect(() => saveStoredGameSession(storage, game)).toThrow("Quota exceeded");
    expect(game).toEqual(before);
    expect(storage.getItem(LOCAL_GAME_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("rejects legacy snapshots that expose more than one human seat", () => {
    const game = makeGame();
    const unsafe = {
      ...game,
      setup: { ...game.setup, humanPlayers: 2, aiPlayers: 4 },
      players: game.players.map((player, index) => (index < 2 ? { ...player, controller: "human" as const } : player))
    };

    expect(() => serializeGameSession(unsafe)).toThrow("仅支持 0 或 1 名真人");
  });

  it("accepts every supported non-human controller kind", () => {
    const game = makeGame();
    const withRemoteControllers = {
      ...game,
      players: game.players.map((player, index) =>
        index === 1 ? { ...player, controller: "mock" as const } : index === 2 ? { ...player, controller: "remote" as const } : player
      )
    };

    expect(restoreGameSession(serializeGameSession(withRemoteControllers)).players.map((player) => player.controller)).toContain("mock");
    expect(restoreGameSession(serializeGameSession(withRemoteControllers)).players.map((player) => player.controller)).toContain("remote");
  });
});
