import path from "node:path";

import type { ThreadMemoryRecord, ThreadMemoryStore } from "@turnkeyai/core-types/team";
import { readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileThreadMemoryStoreOptions {
  rootDir: string;
}

export class FileThreadMemoryStore implements ThreadMemoryStore {
  private readonly rootDir: string;

  constructor(options: FileThreadMemoryStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(threadId: string): Promise<ThreadMemoryRecord | null> {
    return readJsonFile<ThreadMemoryRecord>(this.filePath(threadId));
  }

  async put(record: ThreadMemoryRecord): Promise<void> {
    await writeJsonFileAtomic(this.filePath(record.threadId), record);
  }

  private filePath(threadId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(threadId)}.json`);
  }
}
