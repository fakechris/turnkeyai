import path from "node:path";

import type { WorkerSessionRecord, WorkerSessionStore } from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileWorkerSessionStoreOptions {
  rootDir: string;
}

export class FileWorkerSessionStore implements WorkerSessionStore {
  private readonly rootDir: string;

  constructor(options: FileWorkerSessionStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(workerRunKey: string): Promise<WorkerSessionRecord | null> {
    return readJsonFile<WorkerSessionRecord>(this.filePath(workerRunKey));
  }

  async put(record: WorkerSessionRecord): Promise<void> {
    await writeJsonFileAtomic(this.filePath(record.workerRunKey), record);
  }

  async list(limit?: number): Promise<WorkerSessionRecord[]> {
    const filePaths = await listJsonFiles(this.rootDir);
    const records = await Promise.all(filePaths.map((filePath) => readJsonFile<WorkerSessionRecord>(filePath)));
    const sorted = records
      .filter((record): record is WorkerSessionRecord => record !== null)
      .sort((left, right) => right.state.updatedAt - left.state.updatedAt);
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? sorted.slice(0, limit) : sorted;
  }

  private filePath(workerRunKey: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(workerRunKey)}.json`);
  }
}
