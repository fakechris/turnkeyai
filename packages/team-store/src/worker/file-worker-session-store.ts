import path from "node:path";

import type { WorkerSessionRecord, WorkerSessionStore } from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileWorkerSessionStoreOptions {
  rootDir: string;
}

export class FileWorkerSessionStore implements WorkerSessionStore {
  private readonly rootDir: string;
  private readonly byThreadRootDir: string;

  constructor(options: FileWorkerSessionStoreOptions) {
    this.rootDir = options.rootDir;
    this.byThreadRootDir = path.join(options.rootDir, "by-thread");
  }

  async get(workerRunKey: string): Promise<WorkerSessionRecord | null> {
    return readJsonFile<WorkerSessionRecord>(this.filePath(workerRunKey));
  }

  async put(record: WorkerSessionRecord): Promise<void> {
    await writeJsonFileAtomic(this.filePath(record.workerRunKey), record);
    if (record.context?.threadId) {
      await writeJsonFileAtomic(this.threadIndexPath(record.context.threadId, record.workerRunKey), {
        workerRunKey: record.workerRunKey,
      });
    }
  }

  async list(limit?: number): Promise<WorkerSessionRecord[]> {
    const filePaths = await listJsonFiles(this.rootDir);
    const records = await Promise.all(filePaths.map((filePath) => readJsonFile<WorkerSessionRecord>(filePath)));
    const sorted = records
      .filter((record): record is WorkerSessionRecord => record !== null)
      .sort((left, right) => right.state.updatedAt - left.state.updatedAt);
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? sorted.slice(0, limit) : sorted;
  }

  async listByThread(threadId: string, limit?: number): Promise<WorkerSessionRecord[]> {
    const indexed = await this.listByThreadFromIndex(threadId, limit);
    if (indexed.length > 0) {
      return indexed;
    }

    const legacyRecords = (await this.list()).filter((record) => record.context?.threadId === threadId);
    await Promise.allSettled(
      legacyRecords.map((record) =>
        writeJsonFileAtomic(this.threadIndexPath(threadId, record.workerRunKey), {
          workerRunKey: record.workerRunKey,
        })
      )
    );
    const sorted = legacyRecords.sort((left, right) => right.state.updatedAt - left.state.updatedAt);
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? sorted.slice(0, limit) : sorted;
  }

  private filePath(workerRunKey: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(workerRunKey)}.json`);
  }

  private threadIndexPath(threadId: string, workerRunKey: string): string {
    return path.join(
      this.byThreadRootDir,
      encodeURIComponent(threadId),
      `${encodeURIComponent(workerRunKey)}.json`
    );
  }

  private async listByThreadFromIndex(threadId: string, limit?: number): Promise<WorkerSessionRecord[]> {
    const indexFiles = await listJsonFiles(path.join(this.byThreadRootDir, encodeURIComponent(threadId)));
    const indexEntries = await Promise.all(
      indexFiles.map((filePath) => readJsonFile<{ workerRunKey?: unknown }>(filePath))
    );
    const keys = indexEntries
      .map((entry) => (typeof entry?.workerRunKey === "string" ? entry.workerRunKey : null))
      .filter((workerRunKey): workerRunKey is string => Boolean(workerRunKey));
    const records = await Promise.all(keys.map((workerRunKey) => this.get(workerRunKey)));
    const sorted = records
      .filter(
        (record): record is WorkerSessionRecord =>
          record !== null && record.context?.threadId === threadId
      )
      .sort((left, right) => right.state.updatedAt - left.state.updatedAt);
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? sorted.slice(0, limit) : sorted;
  }
}
