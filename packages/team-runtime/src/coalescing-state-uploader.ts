export interface CoalescingStateUploaderOptions<T> {
  sink: (items: T[]) => Promise<void>;
  maxPendingKeys?: number;
  maxPendingBytes?: number;
  maxBatchItems?: number;
  maxBatchBytes?: number;
  estimateBytes?: (item: T) => number;
  maxRetries?: number;
  retryDelayMs?: number;
  backoffMultiplier?: number;
  maxRetryDelayMs?: number;
  drainMode?: "eager" | "scheduled";
  scheduleDelayMs?: number;
  onDroppedKeys?: (count: number) => void | Promise<void>;
  onFailedBatch?: (items: T[], error: unknown) => void | Promise<void>;
  onRetryScheduled?: (items: T[], attempt: number, delayMs: number, error: unknown) => void | Promise<void>;
}

export class CoalescingStateUploader<K, T> {
  private readonly sink: (items: T[]) => Promise<void>;
  private readonly maxPendingKeys: number;
  private readonly maxPendingBytes: number;
  private readonly maxBatchItems: number;
  private readonly maxBatchBytes: number;
  private readonly estimateBytes: (item: T) => number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly maxRetryDelayMs: number;
  private readonly drainMode: "eager" | "scheduled";
  private readonly scheduleDelayMs: number;
  private readonly onDroppedKeys: (count: number) => void | Promise<void>;
  private readonly onFailedBatch: (items: T[], error: unknown) => void | Promise<void>;
  private readonly onRetryScheduled: (items: T[], attempt: number, delayMs: number, error: unknown) => void | Promise<void>;
  private readonly pending = new Map<K, { value: T; bytes: number }>();
  private draining = false;
  private pendingBytes = 0;
  private scheduledDrain: Promise<void> | null = null;
  private scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledResolve: (() => void) | null = null;

  constructor(options: CoalescingStateUploaderOptions<T>) {
    this.sink = options.sink;
    this.maxPendingKeys = options.maxPendingKeys ?? 256;
    this.maxPendingBytes = options.maxPendingBytes ?? 512 * 1024;
    this.maxBatchItems = options.maxBatchItems ?? 32;
    this.maxBatchBytes = options.maxBatchBytes ?? 96 * 1024;
    this.estimateBytes = options.estimateBytes ?? ((item) => JSON.stringify(item).length);
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 25;
    this.backoffMultiplier = Math.max(options.backoffMultiplier ?? 2, 1);
    this.maxRetryDelayMs = Math.max(options.maxRetryDelayMs ?? 2_000, this.retryDelayMs);
    this.drainMode = options.drainMode ?? "eager";
    this.scheduleDelayMs = options.scheduleDelayMs ?? 0;
    this.onDroppedKeys = options.onDroppedKeys ?? (() => {});
    this.onFailedBatch = options.onFailedBatch ?? (() => {});
    this.onRetryScheduled = options.onRetryScheduled ?? (() => {});
  }

  async upsert(key: K, value: T): Promise<void> {
    const bytes = Math.max(1, this.estimateBytes(value));
    const existing = this.pending.get(key);
    if (existing) {
      this.pendingBytes -= existing.bytes;
    }
    this.pending.set(key, { value, bytes });
    this.pendingBytes += bytes;
    await this.enforceBounds();
    if (this.drainMode === "scheduled") {
      this.scheduleDrain();
      return;
    }
    await this.drain();
  }

  async flush(): Promise<void> {
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = null;
      const pendingDrain = this.scheduledDrain;
      const resolveDrain = this.scheduledResolve;
      this.scheduledDrain = null;
      this.scheduledResolve = null;
      await this.drain();
      resolveDrain?.();
      await pendingDrain;
    } else if (this.scheduledDrain) {
      await this.scheduledDrain;
    }
    await this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.pending.size > 0) {
        const values = this.takeBatch();
        await this.deliver(values);
      }
    } finally {
      this.draining = false;
    }
  }

  private async deliver(items: T[]): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await this.sink(items);
        return;
      } catch (error) {
        if (attempt >= this.maxRetries) {
          await this.onFailedBatch(items, error);
          return;
        }
        attempt += 1;
        const delayMs = Math.min(
          Math.round(this.retryDelayMs * this.backoffMultiplier ** Math.max(attempt - 1, 0)),
          this.maxRetryDelayMs
        );
        this.triggerRetryScheduled(items, attempt, delayMs, error);
        await delay(delayMs);
      }
    }
  }

  private async enforceBounds(): Promise<void> {
    if (this.pending.size <= this.maxPendingKeys && this.pendingBytes <= this.maxPendingBytes) {
      return;
    }

    let dropped = 0;
    while (this.pending.size > this.maxPendingKeys || this.pendingBytes > this.maxPendingBytes) {
      const firstKey = this.pending.keys().next().value as K | undefined;
      if (firstKey == null) {
        break;
      }
      const removed = this.pending.get(firstKey);
      this.pending.delete(firstKey);
      this.pendingBytes -= removed?.bytes ?? 0;
      dropped += 1;
    }

    if (dropped > 0) {
      await this.onDroppedKeys(dropped);
    }
  }

  private takeBatch(): T[] {
    const batch: T[] = [];
    let batchBytes = 0;
    while (this.pending.size > 0 && batch.length < this.maxBatchItems) {
      const firstKey = this.pending.keys().next().value as K | undefined;
      if (firstKey == null) {
        break;
      }
      const entry = this.pending.get(firstKey);
      if (!entry) {
        this.pending.delete(firstKey);
        continue;
      }
      if (batch.length > 0 && batchBytes + entry.bytes > this.maxBatchBytes) {
        break;
      }
      this.pending.delete(firstKey);
      this.pendingBytes -= entry.bytes;
      batch.push(entry.value);
      batchBytes += entry.bytes;
    }
    return batch;
  }

  private scheduleDrain(): void {
    if (this.scheduledDrain) {
      return;
    }
    this.scheduledDrain = new Promise<void>((resolve) => {
      this.scheduledResolve = resolve;
      this.scheduledTimer = setTimeout(async () => {
        this.scheduledTimer = null;
        try {
          await this.drain();
        } finally {
          this.scheduledDrain = null;
          this.scheduledResolve = null;
          resolve();
        }
      }, this.scheduleDelayMs);
    });
  }

  private triggerRetryScheduled(items: T[], attempt: number, delayMs: number, error: unknown): void {
    void Promise.resolve()
      .then(async () => this.onRetryScheduled(items, attempt, delayMs, error))
      .catch((hookError) => {
        console.error("coalescing state uploader retry hook failed", {
          attempt,
          delayMs,
          error: hookError,
        });
      });
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
