import path from "node:path";

import type { ThreadSummaryRecord, ThreadSummaryStore } from "@turnkeyai/core-types/team";
import { readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileThreadSummaryStoreOptions {
  rootDir: string;
}

export class FileThreadSummaryStore implements ThreadSummaryStore {
  private readonly rootDir: string;

  constructor(options: FileThreadSummaryStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(threadId: string): Promise<ThreadSummaryRecord | null> {
    return readJsonFile<ThreadSummaryRecord>(this.filePath(threadId));
  }

  async put(record: ThreadSummaryRecord): Promise<void> {
    await writeJsonFileAtomic(this.filePath(record.threadId), record);
  }

  private filePath(threadId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(threadId)}.json`);
  }
}
