import { describe, expect, it } from "vitest";
import { AIRequestRegistry } from "../src/aiRequestRegistry";

describe("AI request registry", () => {
  it("reuses the same in-flight and completed promise for a requestId", async () => {
    const registry = new AIRequestRegistry<string>(60_000);
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async () => {
      calls += 1;
      await gate;
      return "result";
    };

    const first = registry.getOrCreate("request-1", "fingerprint", run);
    const duplicate = registry.getOrCreate("request-1", "fingerprint", run);
    expect(first.kind).toBe("created");
    expect(duplicate.kind).toBe("reused");
    if (!("promise" in first) || !("promise" in duplicate)) throw new Error("unexpected registry rejection");
    expect(first.promise).toBe(duplicate.promise);
    release?.();
    await expect(first.promise).resolves.toBe("result");

    const completedDuplicate = registry.getOrCreate("request-1", "fingerprint", run);
    expect(completedDuplicate.kind).toBe("reused");
    if (!("promise" in completedDuplicate)) throw new Error("unexpected registry rejection");
    await expect(completedDuplicate.promise).resolves.toBe("result");
    expect(calls).toBe(1);
  });

  it("rejects reuse of a requestId for a different decision fingerprint", () => {
    const registry = new AIRequestRegistry<string>(60_000);
    registry.getOrCreate("request-1", "fingerprint-a", async () => "a");

    expect(registry.getOrCreate("request-1", "fingerprint-b", async () => "b")).toEqual({ kind: "conflict" });
  });

  it("aborts active work and does not report completed work as cancelled", async () => {
    const registry = new AIRequestRegistry<string>(60_000);
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const result = registry.getOrCreate("request-1", "fingerprint", async (signal) => {
      notifyStarted?.();
      return await new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
      });
    });
    if (!("promise" in result)) throw new Error("unexpected registry rejection");
    await started;

    expect(registry.cancel("request-1")).toBe(true);
    await expect(result.promise).resolves.toBe("cancelled");
    expect(registry.isActive("request-1")).toBe(false);
    expect(registry.cancel("request-1")).toBe(false);
  });

  it("keeps active requests during pruning and removes settled entries after TTL", async () => {
    const registry = new AIRequestRegistry<string>(10);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = registry.getOrCreate("request-1", "fingerprint", async () => {
      await gate;
      return "done";
    });
    if (!("promise" in result)) throw new Error("unexpected registry rejection");

    registry.prune(Date.now() + 1000);
    expect(registry.isActive("request-1")).toBe(true);
    release?.();
    await result.promise;
    registry.prune(Date.now() + 1000);
    expect(registry.isActive("request-1")).toBe(false);
    expect(registry.getOrCreate("request-1", "new-fingerprint", async () => "new").kind).toBe("created");
  });

  it("keeps a short cancellation tombstone when cancel arrives before registration", async () => {
    const registry = new AIRequestRegistry<string>(60_000);
    let calls = 0;

    expect(registry.cancel("late-request")).toBe(true);
    const result = registry.getOrCreate("late-request", "fingerprint", async () => {
      calls += 1;
      return "should-not-run";
    });

    expect(result).toEqual({ kind: "cancelled" });
    expect(calls).toBe(0);
  });

  it("expires cancellation tombstones after the registry TTL", () => {
    const registry = new AIRequestRegistry<string>(10);
    expect(registry.cancel("late-request")).toBe(true);

    registry.prune(Date.now() + 1_000);

    expect(registry.getOrCreate("late-request", "fingerprint", async () => "new").kind).toBe("created");
  });
});
