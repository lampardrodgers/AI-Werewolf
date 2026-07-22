export type AIRequestRegistryResult<T> =
  | { kind: "created" | "reused"; promise: Promise<T> }
  | { kind: "conflict" }
  | { kind: "cancelled" };

interface AIRequestEntry<T> {
  fingerprint: string;
  controller: AbortController;
  promise: Promise<T>;
  active: boolean;
  updatedAt: number;
}

export class AIRequestRegistry<T> {
  private readonly entries = new Map<string, AIRequestEntry<T>>();
  private readonly cancellationTombstones = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  getOrCreate(requestId: string, fingerprint: string, run: (signal: AbortSignal) => Promise<T>): AIRequestRegistryResult<T> {
    this.prune();
    if (this.cancellationTombstones.has(requestId)) {
      return { kind: "cancelled" };
    }
    const existing = this.entries.get(requestId);
    if (existing) {
      existing.updatedAt = Date.now();
      if (existing.fingerprint !== fingerprint) return { kind: "conflict" };
      return { kind: "reused", promise: existing.promise };
    }

    const controller = new AbortController();
    const entry: AIRequestEntry<T> = {
      fingerprint,
      controller,
      promise: Promise.resolve(undefined as T),
      active: true,
      updatedAt: Date.now()
    };
    entry.promise = Promise.resolve()
      .then(() => run(controller.signal))
      .finally(() => {
        entry.active = false;
        entry.updatedAt = Date.now();
      });
    this.entries.set(requestId, entry);
    return { kind: "created", promise: entry.promise };
  }

  cancel(requestId: string): boolean {
    this.prune();
    const entry = this.entries.get(requestId);
    if (!entry) {
      this.cancellationTombstones.set(requestId, Date.now());
      return true;
    }
    if (!entry.active) return false;
    entry.updatedAt = Date.now();
    entry.controller.abort(new Error("AI 请求已取消"));
    return true;
  }

  isActive(requestId: string): boolean {
    return this.entries.get(requestId)?.active ?? false;
  }

  prune(now = Date.now()): void {
    for (const [requestId, entry] of this.entries) {
      if (!entry.active && now - entry.updatedAt >= this.ttlMs) {
        this.entries.delete(requestId);
      }
    }
    for (const [requestId, cancelledAt] of this.cancellationTombstones) {
      if (now - cancelledAt >= this.ttlMs) {
        this.cancellationTombstones.delete(requestId);
      }
    }
  }
}
