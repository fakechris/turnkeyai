import path from "node:path";

import type { SessionMemoryRefreshJobRecord, SessionMemoryRefreshJobStore } from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileSessionMemoryRefreshJobStoreOptions {
  rootDir: string;
}

function sanitize(value: string): string {
  return encodeURIComponent(value);
}

export class FileSessionMemoryRefreshJobStore implements SessionMemoryRefreshJobStore {
  private readonly rootDir: string;

  constructor(options: FileSessionMemoryRefreshJobStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(threadId: string): Promise<SessionMemoryRefreshJobRecord | null> {
    return readJsonFile<SessionMemoryRefreshJobRecord>(this.filePath(threadId));
  }

  async put(record: SessionMemoryRefreshJobRecord): Promise<void> {
    await writeJsonFileAtomic(this.filePath(record.threadId), record);
  }

  async delete(threadId: string): Promise<void> {
    await removeFileIfExists(this.filePath(threadId));
  }

  async list(limit = 128): Promise<SessionMemoryRefreshJobRecord[]> {
    const files = await listJsonFiles(this.rootDir);
    const records = (
      await Promise.all(files.map(async (filePath) => readJsonFile<SessionMemoryRefreshJobRecord>(filePath)))
    ).filter((value): value is SessionMemoryRefreshJobRecord => value != null);
    return records
      .sort((left, right) => {
        const dueDelta = left.notBeforeAt - right.notBeforeAt;
        if (dueDelta !== 0) {
          return dueDelta;
        }
        return left.enqueuedAt - right.enqueuedAt;
      })
      .slice(0, Math.max(limit, 1));
  }

  private filePath(threadId: string): string {
    return path.join(this.rootDir, `${sanitize(threadId)}.json`);
  }
}
