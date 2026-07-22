import { describe, expect, it, vi } from "vitest";
import { ActiveAIDecisionRequests, isCurrentAIStatus } from "../src/aiRequestLifecycle";

describe("AI request lifecycle", () => {
  it("aborts every local request and asks the server to cancel every request id", async () => {
    const active = new ActiveAIDecisionRequests();
    const first = active.begin("request-1");
    const second = active.begin("request-2");
    const cancelRemote = vi.fn(async () => ({ ok: true, cancelled: true }));

    expect(active.cancelAll(cancelRemote)).toEqual(["request-1", "request-2"]);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(active.size).toBe(0);
    expect(cancelRemote).toHaveBeenCalledTimes(2);
    expect(cancelRemote).toHaveBeenCalledWith("request-1");
    expect(cancelRemote).toHaveBeenCalledWith("request-2");
  });

  it("does not remove a replacement controller when an old request finishes late", () => {
    const active = new ActiveAIDecisionRequests();
    const oldController = active.begin("same-id");
    const replacement = active.begin("same-id");

    active.finish("same-id", oldController);
    expect(oldController.signal.aborted).toBe(true);
    expect(replacement.signal.aborted).toBe(false);
    expect(active.size).toBe(1);

    active.finish("same-id", replacement);
    expect(active.size).toBe(0);
  });

  it("accepts status only for the current request, action key, and request epoch", () => {
    const current = {
      expectedRequestId: "request-2",
      statusRequestId: "request-2",
      activeStatusRequestId: "request-2",
      expectedActionKey: "game-2:player-1:vote",
      activeActionKey: "game-2:player-1:vote",
      expectedEpoch: 4,
      currentEpoch: 4,
      aborted: false
    };

    expect(isCurrentAIStatus(current)).toBe(true);
    expect(isCurrentAIStatus({ ...current, statusRequestId: "request-1" })).toBe(false);
    expect(isCurrentAIStatus({ ...current, activeStatusRequestId: "request-3" })).toBe(false);
    expect(isCurrentAIStatus({ ...current, activeActionKey: "game-2:player-2:vote" })).toBe(false);
    expect(isCurrentAIStatus({ ...current, currentEpoch: 5 })).toBe(false);
    expect(isCurrentAIStatus({ ...current, aborted: true })).toBe(false);
  });

  it("rejects a delayed status from an earlier retry with the same action key and epoch", () => {
    expect(
      isCurrentAIStatus({
        expectedRequestId: "request-first",
        statusRequestId: "request-first",
        activeStatusRequestId: "request-second",
        expectedActionKey: "same-game:same-seat:same-pending",
        activeActionKey: "same-game:same-seat:same-pending",
        expectedEpoch: 7,
        currentEpoch: 7,
        aborted: false
      })
    ).toBe(false);
  });
});
