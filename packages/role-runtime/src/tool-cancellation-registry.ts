export interface ToolCancellationInput {
  threadId: string;
  toolCallId: string;
  toolName: string;
  cancel(reason: string): Promise<void>;
}

export interface ToolCancellationRegistration {
  unregister(): void;
  isCancelled(): boolean;
  cancellationReason(): string | null;
  cancelled(): Promise<string>;
}

export interface ToolCancellationRegistry {
  register(input: ToolCancellationInput): ToolCancellationRegistration;
  cancel(input: {
    threadId: string;
    toolCallIds: string[];
    reason: string;
  }): Promise<Array<{ toolCallId: string; active: boolean; cancelled: boolean; error?: string }>>;
}

interface ActiveToolCancellationEntry {
  threadId: string;
  toolCallId: string;
  toolName: string;
  cancel(reason: string): Promise<void>;
  cancelled: boolean;
  cancellationReason: string | null;
  resolveCancelled(reason: string): void;
  cancelledPromise: Promise<string>;
}

export class InMemoryToolCancellationRegistry implements ToolCancellationRegistry {
  private readonly active = new Map<string, ActiveToolCancellationEntry>();

  register(input: ToolCancellationInput): ToolCancellationRegistration {
    let resolveCancelled!: (reason: string) => void;
    const cancelledPromise = new Promise<string>((resolve) => {
      resolveCancelled = resolve;
    });
    const entry: ActiveToolCancellationEntry = {
      ...input,
      cancelled: false,
      cancellationReason: null,
      resolveCancelled,
      cancelledPromise,
    };
    const key = cancellationKey(input.threadId, input.toolCallId);
    this.active.set(key, entry);
    return {
      unregister: () => {
        if (this.active.get(key) === entry) {
          this.active.delete(key);
        }
      },
      isCancelled: () => entry.cancelled,
      cancellationReason: () => entry.cancellationReason,
      cancelled: () => entry.cancelledPromise,
    };
  }

  async cancel(input: {
    threadId: string;
    toolCallIds: string[];
    reason: string;
  }): Promise<Array<{ toolCallId: string; active: boolean; cancelled: boolean; error?: string }>> {
    const results: Array<{ toolCallId: string; active: boolean; cancelled: boolean; error?: string }> = [];
    for (const toolCallId of input.toolCallIds) {
      const entry = this.active.get(cancellationKey(input.threadId, toolCallId));
      if (!entry) {
        results.push({ toolCallId, active: false, cancelled: false });
        continue;
      }
      try {
        await entry.cancel(input.reason);
        entry.cancelled = true;
        entry.cancellationReason = input.reason;
        entry.resolveCancelled(input.reason);
        results.push({ toolCallId, active: true, cancelled: true });
      } catch (error) {
        results.push({
          toolCallId,
          active: true,
          cancelled: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }
}

function cancellationKey(threadId: string, toolCallId: string): string {
  return `${threadId}:${toolCallId}`;
}
