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
}

export class InMemoryToolCancellationRegistry implements ToolCancellationRegistry {
  private readonly active = new Map<string, ActiveToolCancellationEntry>();

  register(input: ToolCancellationInput): ToolCancellationRegistration {
    const entry: ActiveToolCancellationEntry = {
      ...input,
      cancelled: false,
      cancellationReason: null,
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
      entry.cancelled = true;
      entry.cancellationReason = input.reason;
      try {
        await entry.cancel(input.reason);
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
