import path from "node:path";

import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

export interface OutboxBatchRecord<T> {
  batchId: string;
  createdAt: number;
  availableAt: number;
  attemptCount: number;
  items: T[];
  lastError?: string;
}

interface FileBatchOutboxOptions {
  rootDir: string;
  now?: () => number;
}

function sanitize(value: string): string {
  return encodeURIComponent(value);
}

export class FileBatchOutbox<T> {
  private readonly rootDir: string;
  private readonly now: () => number;

  constructor(options: FileBatchOutboxOptions) {
    this.rootDir = options.rootDir;
    this.now = options.now ?? (() => Date.now());
  }

  async enqueue(items: T[]): Promise<OutboxBatchRecord<T>> {
    const record: OutboxBatchRecord<T> = {
      batchId: `batch:${this.now()}:${Math.random().toString(36).slice(2, 10)}`,
      createdAt: this.now(),
      availableAt: this.now(),
      attemptCount: 0,
      items,
    };
    await writeJsonFileAtomic(this.filePath(record.batchId), record);
    return record;
  }

  async listDue(limit = 32, now = this.now()): Promise<Array<OutboxBatchRecord<T>>> {
    const files = await listJsonFiles(this.rootDir);
    const records = (
      await Promise.all(files.map(async (filePath) => readJsonFile<OutboxBatchRecord<T>>(filePath)))
    ).filter((value): value is OutboxBatchRecord<T> => value != null);
    return records
      .filter((record) => record.availableAt <= now)
      .sort((left, right) => {
        const dueDelta = left.availableAt - right.availableAt;
        if (dueDelta !== 0) {
          return dueDelta;
        }
        return left.createdAt - right.createdAt;
      })
      .slice(0, Math.max(limit, 1));
  }

  async ack(batchId: string): Promise<void> {
    await removeFileIfExists(this.filePath(batchId));
  }

  async reschedule(batchId: string, input: { attemptCount: number; delayMs: number; items: T[]; error?: unknown }): Promise<void> {
    await writeJsonFileAtomic(this.filePath(batchId), {
      batchId,
      createdAt: this.now(),
      availableAt: this.now() + input.delayMs,
      attemptCount: input.attemptCount,
      items: input.items,
      ...(input.error ? { lastError: input.error instanceof Error ? input.error.message : String(input.error) } : {}),
    } satisfies OutboxBatchRecord<T>);
  }

  private filePath(batchId: string): string {
    return path.join(this.rootDir, `${sanitize(batchId)}.json`);
  }
}
