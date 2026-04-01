export interface SerialBatchUploaderOptions<T> {
  maxBufferedItems?: number;
  maxBufferedBytes?: number;
  maxBatchItems?: number;
  estimateBytes?: (item: T) => number;
  maxBatchBytes?: number;
  sink: (items: T[]) => Promise<void>;
  maxRetries?: number;
  retryDelayMs?: number;
  backoffMultiplier?: number;
  maxRetryDelayMs?: number;
  onDropped?: (count: number) => void | Promise<void>;
  onFailedBatch?: (items: T[], error: unknown) => void | Promise<void>;
  onRetryScheduled?: (items: T[], attempt: number, delayMs: number, error: unknown) => void | Promise<void>;
}

export class SerialBatchUploader<T> {
  private readonly maxBufferedItems: number;
  private readonly maxBufferedBytes: number;
  private readonly maxBatchItems: number;
  private readonly estimateBytes: (item: T) => number;
  private readonly maxBatchBytes: number;
  private readonly sink: (items: T[]) => Promise<void>;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly maxRetryDelayMs: number;
  private readonly onDropped: (count: number) => void | Promise<void>;
  private readonly onFailedBatch: (items: T[], error: unknown) => void | Promise<void>;
  private readonly onRetryScheduled: (items: T[], attempt: number, delayMs: number, error: unknown) => void | Promise<void>;
  private readonly queue: Array<{ item: T; bytes: number }> = [];
  private draining = false;
  private bufferedBytes = 0;

  constructor(options: SerialBatchUploaderOptions<T>) {
    this.maxBufferedItems = options.maxBufferedItems ?? 256;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 512 * 1024;
    this.maxBatchItems = options.maxBatchItems ?? 32;
    this.estimateBytes = options.estimateBytes ?? ((item) => JSON.stringify(item).length);
    this.maxBatchBytes = options.maxBatchBytes ?? 64 * 1024;
    this.sink = options.sink;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 25;
    this.backoffMultiplier = Math.max(options.backoffMultiplier ?? 2, 1);
    this.maxRetryDelayMs = Math.max(options.maxRetryDelayMs ?? 2_000, this.retryDelayMs);
    this.onDropped = options.onDropped ?? (() => {});
    this.onFailedBatch = options.onFailedBatch ?? (() => {});
    this.onRetryScheduled = options.onRetryScheduled ?? (() => {});
  }

  async enqueue(item: T): Promise<void> {
    const bytes = Math.max(1, this.estimateBytes(item));
    this.queue.push({ item, bytes });
    this.bufferedBytes += bytes;
    await this.enforceBufferBounds();
    await this.drain();
  }

  async flush(): Promise<void> {
    await this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.takeBatch();
        await this.deliver(batch);
      }
    } finally {
      this.draining = false;
    }
  }

  private takeBatch(): Array<{ item: T; bytes: number }> {
    const batch: Array<{ item: T; bytes: number }> = [];
    let batchBytes = 0;
    while (this.queue.length > 0 && batch.length < this.maxBatchItems) {
      const candidate = this.queue[0];
      if (!candidate) {
        break;
      }
      const candidateBytes = candidate.bytes;
      if (batch.length > 0 && batchBytes + candidateBytes > this.maxBatchBytes) {
        break;
      }
      this.queue.shift();
      batch.push(candidate);
      batchBytes += candidateBytes;
      this.bufferedBytes -= candidateBytes;
    }
    return batch;
  }

  private async deliver(batch: Array<{ item: T; bytes: number }>): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await this.sink(batch.map((entry) => entry.item));
        return;
      } catch (error) {
        if (attempt >= this.maxRetries) {
          await this.onFailedBatch(
            batch.map((entry) => entry.item),
            error
          );
          return;
        }
        attempt += 1;
        const delayMs = Math.min(
          Math.round(this.retryDelayMs * this.backoffMultiplier ** Math.max(attempt - 1, 0)),
          this.maxRetryDelayMs
        );
        this.triggerRetryScheduled(
          batch.map((entry) => entry.item),
          attempt,
          delayMs,
          error
        );
        await delay(delayMs);
      }
    }
  }

  private async enforceBufferBounds(): Promise<void> {
    let dropped = 0;
    while (this.queue.length > this.maxBufferedItems || this.bufferedBytes > this.maxBufferedBytes) {
      const removed = this.queue.shift();
      if (!removed) {
        break;
      }
      this.bufferedBytes -= removed.bytes;
      dropped += 1;
    }
    if (dropped > 0) {
      await this.onDropped(dropped);
    }
  }

  private triggerRetryScheduled(items: T[], attempt: number, delayMs: number, error: unknown): void {
    void Promise.resolve()
      .then(async () => this.onRetryScheduled(items, attempt, delayMs, error))
      .catch((hookError) => {
        console.error("serial batch uploader retry hook failed", {
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
