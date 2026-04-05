import path from "node:path";

import type { BrowserTarget, BrowserTargetStore } from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileBrowserTargetStoreOptions {
  rootDir: string;
}

export class FileBrowserTargetStore implements BrowserTargetStore {
  private readonly rootDir: string;

  constructor(options: FileBrowserTargetStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(targetId: string): Promise<BrowserTarget | null> {
    return readJsonFile<BrowserTarget>(this.filePath(targetId));
  }

  async put(target: BrowserTarget): Promise<void> {
    await writeJsonFileAtomic(this.filePath(target.targetId), target);
  }

  async listBySession(browserSessionId: string): Promise<BrowserTarget[]> {
    const targets = await this.listAll();
    return targets.filter((target) => target.browserSessionId === browserSessionId);
  }

  private async listAll(): Promise<BrowserTarget[]> {
    const filePaths = await listJsonFiles(this.rootDir);
    const targets = await Promise.all(filePaths.map((filePath) => readJsonFile<BrowserTarget>(filePath)));
    return targets.filter((target): target is BrowserTarget => target !== null);
  }

  private filePath(targetId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(targetId)}.json`);
  }
}
