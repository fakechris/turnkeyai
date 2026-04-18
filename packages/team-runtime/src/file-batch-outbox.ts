import path from "node:path";

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

export type OutboxBatchState = "pending" | "inflight" | "dead_letter";

export interface OutboxBatchRecord<T> {
  batchId: string;
  createdAt: number;
  availableAt: number;
  attemptCount: number;
  items: T[];
  state: OutboxBatchState;
  leaseId?: string;
  leasedAt?: number;
  leaseExpiresAt?: number;
  deadLetteredAt?: number;
  lastAttemptAt?: number;
  lastError?: string;
}

export interface OutboxClaimRecord<T> extends OutboxBatchRecord<T> {
  state: "inflight";
  leaseId: string;
  leasedAt: number;
  leaseExpiresAt: number;
}

export interface OutboxInspectionResult {
  totalBatches: number;
  pendingBatches: number;
  dueBatches: number;
  inflightBatches: number;
  expiredInflightBatches: number;
  deadLetterBatches: number;
  affectedBatchIds: string[];
}

interface FileBatchOutboxOptions {
  rootDir: string;
  now?: () => number;
}

function sanitize(value: string): string {
  return encodeURIComponent(value);
}

function isExpiredInflightBatch<T>(record: OutboxBatchRecord<T>, now: number): boolean {
  return record.state === "inflight" && (record.leaseExpiresAt ?? 0) <= now;
}

export class FileBatchOutbox<T> {
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly mutex = new KeyedAsyncMutex<string>();

  constructor(options: FileBatchOutboxOptions) {
    this.rootDir = options.rootDir;
    this.now = options.now ?? (() => Date.now());
  }

  async enqueue(items: T[]): Promise<OutboxBatchRecord<T>> {
    return this.withLock(async () => {
      const now = this.now();
      const record: OutboxBatchRecord<T> = {
        batchId: `batch:${now}:${Math.random().toString(36).slice(2, 10)}`,
        createdAt: now,
        availableAt: now,
        attemptCount: 0,
        items,
        state: "pending",
      };
      await writeJsonFileAtomic(this.filePath(record.batchId), record);
      return record;
    });
  }

  async get(batchId: string): Promise<OutboxBatchRecord<T> | null> {
    return this.withLock(async () => this.readRecord(batchId));
  }

  async listAll(): Promise<Array<OutboxBatchRecord<T>>> {
    return this.withLock(async () => this.readAllRecords());
  }

  async listDue(limit = 32, now = this.now()): Promise<Array<OutboxBatchRecord<T>>> {
    return this.withLock(async () =>
      this.selectDueRecords(await this.readAllRecords(), Math.max(limit, 1), now)
    );
  }

  async claimDue(input?: {
    limit?: number;
    leaseDurationMs?: number;
    now?: number;
  }): Promise<Array<OutboxClaimRecord<T>>> {
    return this.withLock(async () => {
      const now = input?.now ?? this.now();
      const leaseDurationMs = Math.max(input?.leaseDurationMs ?? 30_000, 1);
      const due = this.selectDueRecords(
        await this.readAllRecords(),
        Math.max(input?.limit ?? 32, 1),
        now
      );
      const claimed: Array<OutboxClaimRecord<T>> = [];
      for (const record of due) {
        const leaseId = `lease:${now}:${Math.random().toString(36).slice(2, 10)}`;
        const next: OutboxClaimRecord<T> = {
          ...record,
          state: "inflight",
          leaseId,
          leasedAt: now,
          leaseExpiresAt: now + leaseDurationMs,
          lastAttemptAt: now,
        };
        await writeJsonFileAtomic(this.filePath(record.batchId), next);
        claimed.push(next);
      }
      return claimed;
    });
  }

  async ack(batchId: string, leaseId?: string): Promise<boolean> {
    return this.withLock(async () => {
      const current = await this.readRecord(batchId);
      if (!current) {
        return false;
      }
      if (leaseId && current.leaseId !== leaseId) {
        return false;
      }
      await removeFileIfExists(this.filePath(batchId));
      return true;
    });
  }

  async reschedule(
    batchId: string,
    input: { attemptCount: number; delayMs: number; items: T[]; error?: unknown; leaseId?: string }
  ): Promise<OutboxBatchRecord<T>> {
    return this.withLock(async () => {
      const current = await this.requireRecord(batchId);
      if (input.leaseId && current.leaseId !== input.leaseId) {
        throw new Error(`outbox batch lease mismatch for ${batchId}`);
      }
      const now = this.now();
      const next: OutboxBatchRecord<T> = {
        ...current,
        availableAt: now + Math.max(input.delayMs, 0),
        attemptCount: input.attemptCount,
        items: input.items,
        state: "pending",
        lastAttemptAt: current.lastAttemptAt ?? now,
        ...(input.error ? { lastError: input.error instanceof Error ? input.error.message : String(input.error) } : {}),
      };
      delete next.leaseId;
      delete next.leasedAt;
      delete next.leaseExpiresAt;
      delete next.deadLetteredAt;
      await writeJsonFileAtomic(this.filePath(batchId), next);
      return next;
    });
  }

  async deadLetter(
    batchId: string,
    input: { attemptCount: number; items: T[]; error?: unknown; leaseId?: string }
  ): Promise<OutboxBatchRecord<T>> {
    return this.withLock(async () => {
      const current = await this.requireRecord(batchId);
      if (input.leaseId && current.leaseId !== input.leaseId) {
        throw new Error(`outbox batch lease mismatch for ${batchId}`);
      }
      const now = this.now();
      const next: OutboxBatchRecord<T> = {
        ...current,
        availableAt: current.availableAt,
        attemptCount: input.attemptCount,
        items: input.items,
        state: "dead_letter",
        deadLetteredAt: now,
        lastAttemptAt: current.lastAttemptAt ?? now,
        ...(input.error ? { lastError: input.error instanceof Error ? input.error.message : String(input.error) } : {}),
      };
      delete next.leaseId;
      delete next.leasedAt;
      delete next.leaseExpiresAt;
      await writeJsonFileAtomic(this.filePath(batchId), next);
      return next;
    });
  }

  async listDeadLetters(limit = 32): Promise<Array<OutboxBatchRecord<T>>> {
    return this.withLock(async () => {
      const records = await this.readAllRecords();
      return records
        .filter((record) => record.state === "dead_letter")
        .sort((left, right) => (right.deadLetteredAt ?? right.createdAt) - (left.deadLetteredAt ?? left.createdAt))
        .slice(0, Math.max(limit, 1));
    });
  }

  async inspect(now = this.now(), limit = 16): Promise<OutboxInspectionResult> {
    return this.withLock(async () => {
      const records = await this.readAllRecords();
      const pendingBatches = records.filter((record) => record.state === "pending");
      const inflightBatches = records.filter((record) => record.state === "inflight");
      const deadLetterBatches = records.filter((record) => record.state === "dead_letter");
      const dueBatches = pendingBatches.filter((record) => record.availableAt <= now);
      const expiredInflightBatches = inflightBatches.filter((record) => isExpiredInflightBatch(record, now));
      return {
        totalBatches: records.length,
        pendingBatches: pendingBatches.length,
        dueBatches: dueBatches.length,
        inflightBatches: inflightBatches.length,
        expiredInflightBatches: expiredInflightBatches.length,
        deadLetterBatches: deadLetterBatches.length,
        affectedBatchIds: [...deadLetterBatches, ...expiredInflightBatches]
          .map((record) => record.batchId)
          .slice(0, Math.max(limit, 1)),
      };
    });
  }

  private async readAllRecords(): Promise<Array<OutboxBatchRecord<T>>> {
    const files = await listJsonFiles(this.rootDir);
    const records = (
      await Promise.all(files.map(async (filePath) => readJsonFile<OutboxBatchRecord<T>>(filePath)))
    ).filter((value): value is OutboxBatchRecord<T> => value != null);
    return records.sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
      }
      return left.batchId.localeCompare(right.batchId);
    });
  }

  private selectDueRecords(
    records: Array<OutboxBatchRecord<T>>,
    limit: number,
    now: number
  ): Array<OutboxBatchRecord<T>> {
    return records
      .filter(
        (record) =>
          (record.state === "pending" && record.availableAt <= now) || isExpiredInflightBatch(record, now)
      )
      .sort((left, right) => {
        const dueDelta = left.availableAt - right.availableAt;
        if (dueDelta !== 0) {
          return dueDelta;
        }
        return left.createdAt - right.createdAt;
      })
      .slice(0, limit);
  }

  private async readRecord(batchId: string): Promise<OutboxBatchRecord<T> | null> {
    return readJsonFile<OutboxBatchRecord<T>>(this.filePath(batchId));
  }

  private async requireRecord(batchId: string): Promise<OutboxBatchRecord<T>> {
    const record = await this.readRecord(batchId);
    if (!record) {
      throw new Error(`outbox batch not found: ${batchId}`);
    }
    return record;
  }

  private filePath(batchId: string): string {
    return path.join(this.rootDir, `${sanitize(batchId)}.json`);
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    return this.mutex.run(this.rootDir, work);
  }
}
