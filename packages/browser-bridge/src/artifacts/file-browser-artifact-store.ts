import path from "node:path";

import type { BrowserArtifactRecord, BrowserArtifactStore } from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileBrowserArtifactStoreOptions {
  rootDir: string;
}

export class FileBrowserArtifactStore implements BrowserArtifactStore {
  private readonly rootDir: string;

  constructor(options: FileBrowserArtifactStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async put(record: BrowserArtifactRecord): Promise<void> {
    await writeJsonFileAtomic(this.filePath(record.artifactId), record);
  }

  async get(artifactId: string): Promise<BrowserArtifactRecord | null> {
    return readJsonFile<BrowserArtifactRecord>(this.filePath(artifactId));
  }

  async listBySession(browserSessionId: string): Promise<BrowserArtifactRecord[]> {
    const records = await this.listAll();
    return records.filter((record) => record.browserSessionId === browserSessionId);
  }

  private async listAll(): Promise<BrowserArtifactRecord[]> {
    const filePaths = await listJsonFiles(this.rootDir);
    const records = await Promise.all(filePaths.map((filePath) => readJsonFile<BrowserArtifactRecord>(filePath)));
    return records.filter((record): record is BrowserArtifactRecord => record !== null);
  }

  private filePath(artifactId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(artifactId)}.json`);
  }
}
