import path from "node:path";

import type { BrowserSessionHistoryEntry, BrowserSessionHistoryStore } from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileBrowserSessionHistoryStoreOptions {
  rootDir: string;
}

export class FileBrowserSessionHistoryStore implements BrowserSessionHistoryStore {
  private readonly rootDir: string;

  constructor(options: FileBrowserSessionHistoryStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async append(entry: BrowserSessionHistoryEntry): Promise<void> {
    await writeJsonFileAtomic(this.filePath(entry.browserSessionId, entry.entryId), entry);
  }

  async listBySession(browserSessionId: string, limit?: number): Promise<BrowserSessionHistoryEntry[]> {
    const sessionDir = this.sessionDir(browserSessionId);
    const filePaths = await listJsonFiles(sessionDir);
    const entries = await Promise.all(filePaths.map((filePath) => readJsonFile<BrowserSessionHistoryEntry>(filePath)));
    const sorted = entries
      .filter((entry): entry is BrowserSessionHistoryEntry => entry !== null)
      .sort((left, right) => left.historyCursor - right.historyCursor);

    if (!limit || limit <= 0) {
      return sorted;
    }

    return sorted.slice(-limit);
  }

  private sessionDir(browserSessionId: string): string {
    return path.join(this.rootDir, encodeURIComponent(browserSessionId));
  }

  private filePath(browserSessionId: string, entryId: string): string {
    return path.join(this.sessionDir(browserSessionId), `${encodeURIComponent(entryId)}.json`);
  }
}
