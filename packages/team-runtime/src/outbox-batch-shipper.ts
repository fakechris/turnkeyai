import { FileBatchOutbox, type OutboxBatchRecord } from "./file-batch-outbox";

interface OutboxBatchShipperOptions<T> {
  outbox: FileBatchOutbox<T>;
  sink: (items: T[]) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
  retryDelayMs?: number;
  backoffMultiplier?: number;
  maxRetryDelayMs?: number;
  onDroppedBatch?: (batch: OutboxBatchRecord<T>) => Promise<void> | void;
  onRetryScheduled?: (
    batch: OutboxBatchRecord<T>,
    attempt: number,
    delayMs: number,
    error: unknown
  ) => Promise<void> | void;
}

export class OutboxBatchShipper<T> {
  private readonly outbox: FileBatchOutbox<T>;
  private readonly sink: (items: T[]) => Promise<void>;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly maxRetryDelayMs: number;
  private readonly onDroppedBatch: (batch: OutboxBatchRecord<T>) => Promise<void> | void;
  private readonly onRetryScheduled: (
    batch: OutboxBatchRecord<T>,
    attempt: number,
    delayMs: number,
    error: unknown
  ) => Promise<void> | void;
  private draining = false;
  private scheduled: ReturnType<typeof setTimeout> | null = null;

  constructor(options: OutboxBatchShipperOptions<T>) {
    this.outbox = options.outbox;
    this.sink = options.sink;
    this.now = options.now ?? (() => Date.now());
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    this.backoffMultiplier = Math.max(options.backoffMultiplier ?? 2, 1);
    this.maxRetryDelayMs = Math.max(options.maxRetryDelayMs ?? 5_000, this.retryDelayMs);
    this.onDroppedBatch = options.onDroppedBatch ?? (() => {});
    this.onRetryScheduled = options.onRetryScheduled ?? (() => {});
  }

  async enqueue(items: T[]): Promise<void> {
    await this.outbox.enqueue(items);
    this.kick(0);
  }

  async flush(): Promise<void> {
    await this.drain(true);
  }

  private kick(delayMs: number): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      void this.drain(false).catch((error) => {
        console.error("outbox batch shipper drain failed", { error });
      });
    }, delayMs);
    this.scheduled.unref?.();
  }

  private async drain(force: boolean): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (true) {
        const batches = await this.outbox.listDue(32, this.now());
        if (batches.length === 0) {
          break;
        }
        for (const batch of batches) {
          await this.processBatch(batch, force);
        }
      }
    } finally {
      this.draining = false;
      this.kick(100);
    }
  }

  private async processBatch(batch: OutboxBatchRecord<T>, force: boolean): Promise<void> {
    try {
      await this.sink(batch.items);
      await this.outbox.ack(batch.batchId);
    } catch (error) {
      const attempt = batch.attemptCount + 1;
      if (attempt > this.maxRetries) {
        await this.outbox.ack(batch.batchId);
        await this.onDroppedBatch(batch);
        return;
      }
      const delayMs = force ? 0 : this.nextDelayMs(attempt);
      await this.onRetryScheduled(batch, attempt, delayMs, error);
      await this.outbox.reschedule(batch.batchId, {
        attemptCount: attempt,
        delayMs,
        items: batch.items,
        error,
      });
    }
  }

  private nextDelayMs(attempt: number): number {
    return Math.min(
      Math.round(this.retryDelayMs * this.backoffMultiplier ** Math.max(attempt - 1, 0)),
      this.maxRetryDelayMs
    );
  }
}
