import type {
  RuntimeProgressEvent,
  RuntimeProgressRecorder,
  RuntimeProgressStore,
  TeamEventBus,
} from "@turnkeyai/core-types/team";

import { FileBatchOutbox } from "./file-batch-outbox";
import { OutboxBatchShipper } from "./outbox-batch-shipper";
import { SerialBatchUploader } from "./serial-batch-uploader";

interface DefaultRuntimeProgressRecorderOptions {
  progressStore: RuntimeProgressStore;
  teamEventBus?: TeamEventBus;
  maxBufferedItems?: number;
  maxBatchItems?: number;
  maxBufferedBytes?: number;
  maxBatchBytes?: number;
  remoteSink?: (events: RuntimeProgressEvent[]) => Promise<void>;
  remoteSinkTimeoutMs?: number;
  remoteOutboxRootDir?: string;
}

const DEFAULT_REMOTE_SINK_TIMEOUT_MS = 2_000;

export class DefaultRuntimeProgressRecorder implements RuntimeProgressRecorder {
  private readonly progressStore: RuntimeProgressStore;
  private readonly teamEventBus: TeamEventBus | undefined;
  private readonly remoteSink: ((events: RuntimeProgressEvent[]) => Promise<void>) | undefined;
  private readonly remoteSinkTimeoutMs: number;
  private readonly remoteSinkShipper: OutboxBatchShipper<RuntimeProgressEvent> | undefined;
  private readonly uploader: SerialBatchUploader<RuntimeProgressEvent>;

  constructor(options: DefaultRuntimeProgressRecorderOptions) {
    this.progressStore = options.progressStore;
    this.teamEventBus = options.teamEventBus;
    this.remoteSink = options.remoteSink;
    this.remoteSinkTimeoutMs = options.remoteSinkTimeoutMs ?? DEFAULT_REMOTE_SINK_TIMEOUT_MS;
    this.remoteSinkShipper =
      this.remoteSink && options.remoteOutboxRootDir
        ? new OutboxBatchShipper<RuntimeProgressEvent>({
            outbox: new FileBatchOutbox<RuntimeProgressEvent>({
              rootDir: options.remoteOutboxRootDir,
            }),
            sink: async (items) => {
              await Promise.race([
                this.remoteSink!(items),
                createTimeout(this.remoteSinkTimeoutMs, "runtime progress remote sink timed out"),
              ]);
            },
            onDroppedBatch: async (batch) => {
              const threadId = batch.items[0]?.threadId ?? "system";
              await this.publishAuditEvent({
                eventId: `audit:runtime-progress-remote-drop:${Date.now()}:${threadId}`,
                threadId,
                kind: "audit.logged",
                createdAt: Date.now(),
                payload: {
                  category: "runtime_observability",
                  severity: "warning",
                  component: "runtime-progress-recorder",
                  summary: `Dropped ${batch.items.length} runtime progress event(s) after exhausting remote sink retries.`,
                  count: batch.items.length,
                },
              });
            },
            onRetryScheduled: async (batch, attempt, delayMs, error) => {
              const threadId = batch.items[0]?.threadId ?? "system";
              await this.publishAuditEvent({
                eventId: `audit:runtime-progress-remote-retry:${Date.now()}:${threadId}:${attempt}`,
                threadId,
                kind: "audit.logged",
                createdAt: Date.now(),
                payload: {
                  category: "runtime_observability",
                  severity: "warning",
                  component: "runtime-progress-recorder",
                  summary: `Retrying remote sink delivery for ${batch.items.length} runtime progress event(s) in ${delayMs}ms.`,
                  attempt,
                  delayMs,
                  count: batch.items.length,
                  error: error instanceof Error ? error.message : String(error),
                },
              });
            },
          })
        : undefined;
    this.uploader = new SerialBatchUploader<RuntimeProgressEvent>({
      maxBufferedItems: options.maxBufferedItems ?? 512,
      maxBatchItems: options.maxBatchItems ?? 32,
      maxBufferedBytes: options.maxBufferedBytes ?? 512 * 1024,
      maxBatchBytes: options.maxBatchBytes ?? 96 * 1024,
      onDropped: async (count) => {
        await this.publishAuditEvent({
          eventId: `audit:runtime-progress-drop:${Date.now()}:${count}`,
          threadId: "system",
          kind: "audit.logged",
          createdAt: Date.now(),
          payload: {
            category: "runtime_observability",
            severity: "warning",
            component: "runtime-progress-recorder",
            summary: `Dropped ${count} runtime progress event(s) because the progress uploader buffer was full.`,
            count,
          },
        });
      },
      onFailedBatch: async (items, error) => {
        const threadId = items[0]?.threadId ?? "system";
        await this.publishAuditEvent({
          eventId: `audit:runtime-progress-failed:${Date.now()}:${threadId}`,
          threadId,
          kind: "audit.logged",
          createdAt: Date.now(),
          payload: {
            category: "runtime_observability",
            severity: "warning",
            component: "runtime-progress-recorder",
            summary: `Failed to persist ${items.length} runtime progress event(s).`,
            count: items.length,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      },
      onRetryScheduled: async (items, attempt, delayMs, error) => {
        const threadId = items[0]?.threadId ?? "system";
        await this.publishAuditEvent({
          eventId: `audit:runtime-progress-retry:${Date.now()}:${threadId}:${attempt}`,
          threadId,
          kind: "audit.logged",
          createdAt: Date.now(),
          payload: {
            category: "runtime_observability",
            severity: "warning",
            component: "runtime-progress-recorder",
            summary: `Retrying ${items.length} runtime progress event(s) in ${delayMs}ms.`,
            attempt,
            delayMs,
            count: items.length,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      },
      sink: async (items) => {
        for (const item of items) {
          await this.progressStore.append(item);
        }
        this.forwardRemoteSink(items);
      },
    });
  }

  async record(event: RuntimeProgressEvent): Promise<void> {
    await this.uploader.enqueue(event);
    if (!this.teamEventBus) {
      return;
    }
    await this.teamEventBus.publish({
      eventId: event.progressId,
      threadId: event.threadId,
      kind: "runtime.progress",
      createdAt: event.recordedAt,
      payload: {
        ...(event.chainId ? { chainId: event.chainId } : {}),
        ...(event.spanId ? { spanId: event.spanId } : {}),
        subjectKind: event.subjectKind,
        subjectId: event.subjectId,
        phase: event.phase,
        ...(event.progressKind ? { progressKind: event.progressKind } : {}),
        ...(event.heartbeatSource ? { heartbeatSource: event.heartbeatSource } : {}),
        ...(event.continuityState ? { continuityState: event.continuityState } : {}),
        ...(event.responseTimeoutAt ? { responseTimeoutAt: event.responseTimeoutAt } : {}),
        ...(event.reconnectWindowUntil ? { reconnectWindowUntil: event.reconnectWindowUntil } : {}),
        ...(event.closeKind ? { closeKind: event.closeKind } : {}),
        summary: event.summary,
        ...(event.statusReason ? { statusReason: event.statusReason } : {}),
        ...(event.flowId ? { flowId: event.flowId } : {}),
        ...(event.taskId ? { taskId: event.taskId } : {}),
        ...(event.roleId ? { roleId: event.roleId } : {}),
        ...(event.workerType ? { workerType: event.workerType } : {}),
        ...(event.artifacts ? { artifacts: event.artifacts } : {}),
        ...(event.metadata ? { metadata: event.metadata } : {}),
      },
    });
  }

  async flush(): Promise<void> {
    await this.uploader.flush();
    await this.remoteSinkShipper?.flush();
  }

  private forwardRemoteSink(items: RuntimeProgressEvent[]): void {
    if (!this.remoteSink) {
      return;
    }
    const threadId = items[0]?.threadId ?? "system";
    if (this.remoteSinkShipper) {
      void this.remoteSinkShipper.enqueue(items).catch(async (error) => {
        await this.publishAuditEvent({
          eventId: `audit:runtime-progress-remote-outbox-failed:${Date.now()}:${threadId}`,
          threadId,
          kind: "audit.logged",
          createdAt: Date.now(),
          payload: {
            category: "runtime_observability",
            severity: "warning",
            component: "runtime-progress-recorder",
            summary: `Failed to enqueue ${items.length} runtime progress event(s) to the remote outbox.`,
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
          createTimeout(this.remoteSinkTimeoutMs, "runtime progress remote sink timed out"),
        ]);
      })
      .catch(async (error) => {
        await this.publishAuditEvent({
          eventId: `audit:runtime-progress-remote-failed:${Date.now()}:${threadId}`,
          threadId,
          kind: "audit.logged",
          createdAt: Date.now(),
          payload: {
            category: "runtime_observability",
            severity: "warning",
            component: "runtime-progress-recorder",
            summary: `Failed to forward ${items.length} runtime progress event(s) to the remote sink.`,
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
    if (!this.teamEventBus) {
      return;
    }
    try {
      await this.teamEventBus.publish(event);
    } catch (error) {
      console.error("runtime progress audit publish failed", {
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
