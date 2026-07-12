import path from "node:path";

import type {
  WorkerJoinRecord,
  WorkerResultInboxStore,
  WorkerResultNotification,
} from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import {
  listJsonFiles,
  readJsonFile,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";

export class FileWorkerResultInboxStore implements WorkerResultInboxStore {
  private readonly mutex = new KeyedAsyncMutex<string>();
  private readonly rootDir: string;

  constructor(options: { rootDir: string }) {
    this.rootDir = options.rootDir;
  }

  getNotification(notificationId: string): Promise<WorkerResultNotification | null> {
    return readJsonFile(this.notificationPath(notificationId));
  }

  putNotification(record: WorkerResultNotification): Promise<WorkerResultNotification> {
    return this.mutex.run(`notification:${record.notificationId}`, async () => {
      const existing = await this.getNotification(record.notificationId);
      if (existing) {
        assertSameNotificationIdentity(existing, record);
        return existing;
      }
      assertNotification(record);
      await writeJsonFileAtomic(this.notificationPath(record.notificationId), record);
      return record;
    });
  }

  async listNotifications(input: {
    ownerScopeId: string;
    state?: WorkerResultNotification["state"];
  }): Promise<WorkerResultNotification[]> {
    const records = await readRecords<WorkerResultNotification>(
      path.join(this.rootDir, "notifications"),
    );
    return records
      .filter((record) => record.ownerScopeId === input.ownerScopeId)
      .filter((record) => input.state === undefined || record.state === input.state)
      .sort(compareCreatedRecords);
  }

  consumeNotification(input: {
    notificationId: string;
    consumedAt: number;
    consumedByMessageId: string;
  }): Promise<WorkerResultNotification> {
    return this.mutex.run(`notification:${input.notificationId}`, async () => {
      const existing = await this.getNotification(input.notificationId);
      if (!existing) throw new Error(`unknown worker result notification: ${input.notificationId}`);
      if (existing.state === "consumed") {
        if (existing.consumedByMessageId !== input.consumedByMessageId) {
          throw new Error(`worker result notification already consumed: ${input.notificationId}`);
        }
        return existing;
      }
      const consumed: WorkerResultNotification = {
        ...existing,
        state: "consumed",
        consumedAt: input.consumedAt,
        consumedByMessageId: input.consumedByMessageId,
      };
      await writeJsonFileAtomic(this.notificationPath(input.notificationId), consumed);
      return consumed;
    });
  }

  getJoin(joinId: string): Promise<WorkerJoinRecord | null> {
    return readJsonFile(this.joinPath(joinId));
  }

  putJoin(record: WorkerJoinRecord): Promise<WorkerJoinRecord> {
    return this.mutex.run("joins", async () => {
      const existing = await this.getJoin(record.joinId);
      if (existing) {
        assertSameJoinIdentity(existing, record);
        return existing;
      }
      assertJoin(record);
      await writeJsonFileAtomic(this.joinPath(record.joinId), record);
      return record;
    });
  }

  satisfyWaitingJoins(input: {
    sourceScopeId: string;
    notificationId: string;
    resolvedAt: number;
  }): Promise<WorkerJoinRecord[]> {
    return this.mutex.run("joins", async () => {
      const joins = await this.listJoins();
      const changed: WorkerJoinRecord[] = [];
      for (const join of joins) {
        if (join.sourceScopeId !== input.sourceScopeId || join.state !== "waiting") continue;
        if (join.expiresAt !== undefined && input.resolvedAt > join.expiresAt) continue;
        const satisfied: WorkerJoinRecord = {
          ...join,
          state: "satisfied",
          notificationId: input.notificationId,
          resolvedAt: input.resolvedAt,
        };
        await writeJsonFileAtomic(this.joinPath(join.joinId), satisfied);
        changed.push(satisfied);
      }
      return changed;
    });
  }

  abandonExpiredJoins(input: {
    now: number;
    ownerScopeId?: string;
  }): Promise<WorkerJoinRecord[]> {
    return this.mutex.run("joins", async () => {
      const joins = await this.listJoins();
      const changed: WorkerJoinRecord[] = [];
      for (const join of joins) {
        if (join.state !== "waiting") continue;
        if (input.ownerScopeId !== undefined && join.ownerScopeId !== input.ownerScopeId) continue;
        if (join.expiresAt === undefined || join.expiresAt > input.now) continue;
        const abandoned: WorkerJoinRecord = {
          ...join,
          state: "abandoned",
          resolvedAt: input.now,
        };
        await writeJsonFileAtomic(this.joinPath(join.joinId), abandoned);
        changed.push(abandoned);
      }
      return changed;
    });
  }

  private async listJoins(): Promise<WorkerJoinRecord[]> {
    return readRecords(path.join(this.rootDir, "joins"));
  }

  private notificationPath(notificationId: string): string {
    return path.join(this.rootDir, "notifications", `${encodeURIComponent(notificationId)}.json`);
  }

  private joinPath(joinId: string): string {
    return path.join(this.rootDir, "joins", `${encodeURIComponent(joinId)}.json`);
  }
}

async function readRecords<T>(rootDir: string): Promise<T[]> {
  const paths = await listJsonFiles(rootDir);
  const records: T[] = [];
  for (const file of paths) {
    const record = await readJsonFile<T>(file);
    if (record !== null) records.push(record);
  }
  return records;
}

function compareCreatedRecords(
  left: WorkerResultNotification,
  right: WorkerResultNotification,
): number {
  return left.createdAt - right.createdAt || left.notificationId.localeCompare(right.notificationId);
}

function assertNotification(record: WorkerResultNotification): void {
  if (!record.notificationId || !record.ownerScopeId || !record.sourceScopeId || !record.resultRef) {
    throw new Error("worker result notification identity is incomplete");
  }
  if (!Number.isFinite(record.sourceVersion) || !Number.isFinite(record.createdAt)) {
    throw new Error("worker result notification version/time is invalid");
  }
  if (record.state !== "pending" || record.consumedAt !== undefined || record.consumedByMessageId !== undefined) {
    throw new Error("new worker result notification must be pending");
  }
}

function assertSameNotificationIdentity(
  existing: WorkerResultNotification,
  candidate: WorkerResultNotification,
): void {
  if (
    existing.ownerScopeId !== candidate.ownerScopeId ||
    existing.sourceScopeId !== candidate.sourceScopeId ||
    existing.sourceVersion !== candidate.sourceVersion ||
    existing.resultRef !== candidate.resultRef ||
    existing.createdAt !== candidate.createdAt
  ) {
    throw new Error(`worker result notification id reused: ${candidate.notificationId}`);
  }
}

function assertJoin(record: WorkerJoinRecord): void {
  if (!record.joinId || !record.ownerScopeId || !record.sourceScopeId) {
    throw new Error("worker join identity is incomplete");
  }
  if (record.state !== "waiting" || record.notificationId !== undefined || record.resolvedAt !== undefined) {
    throw new Error("new worker join must be waiting");
  }
}

function assertSameJoinIdentity(existing: WorkerJoinRecord, candidate: WorkerJoinRecord): void {
  if (
    existing.ownerScopeId !== candidate.ownerScopeId ||
    existing.sourceScopeId !== candidate.sourceScopeId ||
    existing.createdAt !== candidate.createdAt ||
    existing.expiresAt !== candidate.expiresAt
  ) {
    throw new Error(`worker join id reused: ${candidate.joinId}`);
  }
}
