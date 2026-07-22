import { afterEach, describe, expect, it, vi } from "vitest";
import { createGame } from "@langrensha/engine";
import { DEFAULT_DEBUG_MODE, STANDARD_PRESET } from "@langrensha/shared";
import { cancelAIDecision, requestAIDecision } from "../src/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("AI decision API cancellation", () => {
  it("passes the AbortSignal to the decision fetch", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, fallback: false }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const controller = new AbortController();
    const game = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "api-signal",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });

    await requestAIDecision(game, undefined, "request-signal", undefined, undefined, controller.signal);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", signal: controller.signal });
  });

  it("uses the server cancellation endpoint with an encoded request id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, cancelled: true }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(cancelAIDecision("batch/player 1")).resolves.toEqual({ ok: true, cancelled: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/ai/cancel/batch%2Fplayer%201", { method: "POST", keepalive: true });
  });
});
