import path from "node:path";

import type { ThreadSessionMemoryRecord, ThreadSessionMemoryStore } from "@turnkeyai/core-types/team";
import { readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileThreadSessionMemoryStoreOptions {
  rootDir: string;
}

export class FileThreadSessionMemoryStore implements ThreadSessionMemoryStore {
  private readonly rootDir: string;

  constructor(options: FileThreadSessionMemoryStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(threadId: string): Promise<ThreadSessionMemoryRecord | null> {
    return readJsonFile<ThreadSessionMemoryRecord>(this.filePath(threadId));
  }

  async put(record: ThreadSessionMemoryRecord): Promise<void> {
    await writeJsonFileAtomic(this.filePath(record.threadId), record);
  }

  private filePath(threadId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(threadId)}.json`);
  }
}
