export type RemoteAIDecisionCanceller = (requestId: string) => Promise<unknown>;

export function isCurrentAIStatus(options: {
  expectedRequestId: string;
  statusRequestId: string;
  activeStatusRequestId: string | null | undefined;
  expectedActionKey: string;
  activeActionKey: string | null;
  expectedEpoch: number;
  currentEpoch: number;
  aborted: boolean;
}): boolean {
  return (
    !options.aborted &&
    options.expectedEpoch === options.currentEpoch &&
    options.statusRequestId === options.expectedRequestId &&
    options.activeStatusRequestId === options.expectedRequestId &&
    options.activeActionKey === options.expectedActionKey
  );
}

export class ActiveAIDecisionRequests {
  private readonly controllers = new Map<string, AbortController>();

  begin(requestId: string): AbortController {
    this.controllers.get(requestId)?.abort();
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    return controller;
  }

  finish(requestId: string, controller: AbortController): void {
    if (this.controllers.get(requestId) === controller) {
      this.controllers.delete(requestId);
    }
  }

  cancelAll(cancelRemote: RemoteAIDecisionCanceller): string[] {
    const active = [...this.controllers.entries()];
    this.controllers.clear();
    for (const [requestId, controller] of active) {
      controller.abort();
      void cancelRemote(requestId).catch(() => undefined);
    }
    return active.map(([requestId]) => requestId);
  }

  get size(): number {
    return this.controllers.size;
  }
}
