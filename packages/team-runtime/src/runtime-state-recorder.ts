import type {
  RuntimeChain,
  RuntimeChainStatus,
  RuntimeStateRecorder,
  TeamEventBus,
} from "@turnkeyai/core-types/team";

import { FileBatchOutbox } from "./file-batch-outbox";
import { CoalescingStateUploader } from "./coalescing-state-uploader";
import { OutboxBatchShipper } from "./outbox-batch-shipper";

interface DefaultRuntimeStateRecorderOptions {
  teamEventBus: TeamEventBus;
  maxPendingKeys?: number;
  scheduleDelayMs?: number;
  remoteSink?: (
    items: Array<{ chain: RuntimeChain; status: RuntimeChainStatus }>
  ) => Promise<void>;
  remoteSinkTimeoutMs?: number;
  remoteOutboxRootDir?: string;
}

const DEFAULT_REMOTE_SINK_TIMEOUT_MS = 2_000;

export class DefaultRuntimeStateRecorder implements RuntimeStateRecorder {
  private readonly teamEventBus: TeamEventBus;
  private readonly remoteSink:
    | ((
        items: Array<{ chain: RuntimeChain; status: RuntimeChainStatus }>
      ) => Promise<void>)
    | undefined;
  private readonly remoteSinkTimeoutMs: number;
  private readonly remoteSinkShipper:
    | OutboxBatchShipper<{ chain: RuntimeChain; status: RuntimeChainStatus }>
    | undefined;
  private readonly uploader: CoalescingStateUploader<string, { chain: RuntimeChain; status: RuntimeChainStatus }>;

  constructor(options: DefaultRuntimeStateRecorderOptions) {
    this.teamEventBus = options.teamEventBus;
    this.remoteSink = options.remoteSink;
    this.remoteSinkTimeoutMs = options.remoteSinkTimeoutMs ?? DEFAULT_REMOTE_SINK_TIMEOUT_MS;
    this.remoteSinkShipper =
      this.remoteSink && options.remoteOutboxRootDir
        ? new OutboxBatchShipper<{ chain: RuntimeChain; status: RuntimeChainStatus }>({
            outbox: new FileBatchOutbox({
              rootDir: options.remoteOutboxRootDir,
            }),
            sink: async (items) => {
              await Promise.race([
                this.remoteSink!(items),
                createTimeout(this.remoteSinkTimeoutMs, "runtime state remote sink timed out"),
              ]);
            },
            onDroppedBatch: async (batch) => {
              const threadId = batch.items[0]?.chain.threadId ?? "system";
              await this.publishAuditEvent({
                eventId: `audit:runtime-state-remote-drop:${Date.now()}:${threadId}`,
                threadId,
                kind: "audit.logged",
                createdAt: Date.now(),
                payload: {
                  category: "runtime_observability",
                  severity: "warning",
                  component: "runtime-state-recorder",
                  summary: `Dropped ${batch.items.length} runtime state update(s) after exhausting remote sink retries.`,
                  count: batch.items.length,
                },
              });
            },
            onRetryScheduled: async (batch, attempt, delayMs, error) => {
              const threadId = batch.items[0]?.chain.threadId ?? "system";
              await this.publishAuditEvent({
                eventId: `audit:runtime-state-remote-retry:${Date.now()}:${threadId}:${attempt}`,
                threadId,
                kind: "audit.logged",
                createdAt: Date.now(),
                payload: {
                  category: "runtime_observability",
                  severity: "warning",
                  component: "runtime-state-recorder",
                  summary: `Retrying remote sink delivery for ${batch.items.length} runtime state update(s) in ${delayMs}ms.`,
                  attempt,
                  delayMs,
                  count: batch.items.length,
                  error: error instanceof Error ? error.message : String(error),
                },
              });
            },
          })
        : undefined;
    this.uploader = new CoalescingStateUploader({
      maxPendingKeys: options.maxPendingKeys ?? 512,
      drainMode: "scheduled",
      scheduleDelayMs: options.scheduleDelayMs ?? 10,
      onDroppedKeys: async (count) => {
        await this.publishAuditEvent({
          eventId: `audit:runtime-state-drop:${Date.now()}:${count}`,
          threadId: "system",
          kind: "audit.logged",
          createdAt: Date.now(),
          payload: {
            category: "runtime_observability",
            severity: "warning",
            component: "runtime-state-recorder",
            summary: `Dropped ${count} coalesced runtime state update(s) because the pending state buffer was full.`,
            count,
          },
        });
      },
      onFailedBatch: async (items, error) => {
        const threadId = items[0]?.chain.threadId ?? "system";
        await this.publishAuditEvent({
          eventId: `audit:runtime-state-failed:${Date.now()}:${threadId}`,
          threadId,
          kind: "audit.logged",
          createdAt: Date.now(),
          payload: {
            category: "runtime_observability",
            severity: "warning",
            component: "runtime-state-recorder",
            summary: `Failed to publish ${items.length} runtime state update(s).`,
            count: items.length,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      },
      onRetryScheduled: async (items, attempt, delayMs, error) => {
        const threadId = items[0]?.chain.threadId ?? "system";
        await this.publishAuditEvent({
          eventId: `audit:runtime-state-retry:${Date.now()}:${threadId}:${attempt}`,
          threadId,
          kind: "audit.logged",
          createdAt: Date.now(),
          payload: {
            category: "runtime_observability",
            severity: "warning",
            component: "runtime-state-recorder",
            summary: `Retrying ${items.length} runtime state update(s) in ${delayMs}ms.`,
            attempt,
            delayMs,
            count: items.length,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      },
      sink: async (items) => {
        for (const item of items) {
          await this.teamEventBus.publish({
            eventId: `runtime-state:${item.chain.chainId}:${item.status.updatedAt}`,
            threadId: item.chain.threadId,
            kind: "runtime.state",
            createdAt: item.status.updatedAt,
            payload: {
              chainId: item.chain.chainId,
              rootKind: item.chain.rootKind,
              rootId: item.chain.rootId,
              ...(item.chain.flowId ? { flowId: item.chain.flowId } : {}),
              ...(item.chain.taskId ? { taskId: item.chain.taskId } : {}),
              ...(item.chain.roleId ? { roleId: item.chain.roleId } : {}),
              phase: item.status.phase,
              ...(item.status.canonicalState ? { canonicalState: item.status.canonicalState } : {}),
              ...(item.status.continuityState ? { continuityState: item.status.continuityState } : {}),
              ...(item.status.continuityReason ? { continuityReason: item.status.continuityReason } : {}),
              ...(item.status.responseTimeoutAt ? { responseTimeoutAt: item.status.responseTimeoutAt } : {}),
              ...(item.status.reconnectWindowUntil ? { reconnectWindowUntil: item.status.reconnectWindowUntil } : {}),
              ...(item.status.closeKind ? { closeKind: item.status.closeKind } : {}),
              ...(item.status.waitingReason ? { waitingReason: item.status.waitingReason } : {}),
              ...(item.status.stale ? { stale: true } : {}),
              ...(item.status.staleReason ? { staleReason: item.status.staleReason } : {}),
              ...(item.status.activeSpanId ? { activeSpanId: item.status.activeSpanId } : {}),
              ...(item.status.activeSubjectKind ? { activeSubjectKind: item.status.activeSubjectKind } : {}),
              ...(item.status.activeSubjectId ? { activeSubjectId: item.status.activeSubjectId } : {}),
              ...(item.status.latestChildSpanId ? { latestChildSpanId: item.status.latestChildSpanId } : {}),
              ...(item.status.currentWaitingSpanId ? { currentWaitingSpanId: item.status.currentWaitingSpanId } : {}),
              ...(item.status.currentWaitingPoint ? { currentWaitingPoint: item.status.currentWaitingPoint } : {}),
              ...(item.status.lastCompletedSpanId ? { lastCompletedSpanId: item.status.lastCompletedSpanId } : {}),
              ...(item.status.lastFailedSpanId ? { lastFailedSpanId: item.status.lastFailedSpanId } : {}),
              latestSummary: item.status.latestSummary,
              ...(item.status.caseKey ? { caseKey: item.status.caseKey } : {}),
              ...(item.status.caseState ? { caseState: item.status.caseState } : {}),
              ...(item.status.severity ? { severity: item.status.severity } : {}),
              ...(item.status.headline ? { headline: item.status.headline } : {}),
              ...(item.status.nextStep ? { nextStep: item.status.nextStep } : {}),
              attention: item.status.attention,
            },
          });
        }
        if (!this.remoteSink) {
          return;
        }
        this.forwardRemoteSink(items);
      },
    });
  }

  async record(input: { chain: RuntimeChain; status: RuntimeChainStatus }): Promise<void> {
    await this.uploader.upsert(input.chain.chainId, input);
  }

  async flush(): Promise<void> {
    await this.uploader.flush();
    await this.remoteSinkShipper?.flush();
  }

  private forwardRemoteSink(items: Array<{ chain: RuntimeChain; status: RuntimeChainStatus }>): void {
    if (!this.remoteSink) {
      return;
    }
    const threadId = items[0]?.chain.threadId ?? "system";
    if (this.remoteSinkShipper) {
      void this.remoteSinkShipper.enqueue(items).catch(async (error) => {
        await this.publishAuditEvent({
          eventId: `audit:runtime-state-remote-outbox-failed:${Date.now()}:${threadId}`,
          threadId,
          kind: "audit.logged",
          createdAt: Date.now(),
          payload: {
            category: "runtime_observability",
            severity: "warning",
            component: "runtime-state-recorder",
            summary: `Failed to enqueue ${items.length} runtime state update(s) to the remote outbox.`,
            count: items.length,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
      return;
    }
    void Promise.resolve()
      .then(async () => {
        await Promise.race([
          this.remoteSink!(items),
          createTimeout(this.remoteSinkTimeoutMs, "runtime state remote sink timed out"),
        ]);
      })
      .catch(async (error) => {
        await this.publishAuditEvent({
          eventId: `audit:runtime-state-remote-failed:${Date.now()}:${threadId}`,
          threadId,
          kind: "audit.logged",
          createdAt: Date.now(),
          payload: {
            category: "runtime_observability",
            severity: "warning",
            component: "runtime-state-recorder",
            summary: `Failed to forward ${items.length} runtime state update(s) to the remote sink.`,
            count: items.length,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
  }

  private async publishAuditEvent(event: {
    eventId: string;
    threadId: string;
    kind: "audit.logged";
    createdAt: number;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.teamEventBus.publish(event);
    } catch (error) {
      console.error("runtime state audit publish failed", {
        eventId: event.eventId,
        error,
      });
    }
  }
}

function createTimeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}
