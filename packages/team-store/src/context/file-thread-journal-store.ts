import path from "node:path";

import type { ThreadJournalRecord, ThreadJournalStore } from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileThreadJournalStoreOptions {
  rootDir: string;
}

export class FileThreadJournalStore implements ThreadJournalStore {
  private readonly rootDir: string;

  constructor(options: FileThreadJournalStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(threadId: string, dateKey: string): Promise<ThreadJournalRecord | null> {
    return readJsonFile<ThreadJournalRecord>(this.filePath(threadId, dateKey));
  }

  async put(record: ThreadJournalRecord): Promise<void> {
    await writeJsonFileAtomic(this.filePath(record.threadId, record.dateKey), record);
  }

  async listByThread(threadId: string, limit = 7): Promise<ThreadJournalRecord[]> {
    const rootDir = path.join(this.rootDir, encodeURIComponent(threadId));
    const filePaths = await listJsonFiles(rootDir);
    const records = await Promise.all(filePaths.map((filePath) => readJsonFile<ThreadJournalRecord>(filePath)));
    return records
      .filter((record): record is ThreadJournalRecord => record !== null)
      .sort((left, right) => right.dateKey.localeCompare(left.dateKey))
      .slice(0, limit);
  }

  private filePath(threadId: string, dateKey: string): string {
    return path.join(this.rootDir, encodeURIComponent(threadId), `${encodeURIComponent(dateKey)}.json`);
  }
}
