import path from "node:path";

import type {
  BrowserSession,
  BrowserSessionOwnerType,
  BrowserSessionStore,
} from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileBrowserSessionStoreOptions {
  rootDir: string;
}

export class FileBrowserSessionStore implements BrowserSessionStore {
  private readonly rootDir: string;

  constructor(options: FileBrowserSessionStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(browserSessionId: string): Promise<BrowserSession | null> {
    return readJsonFile<BrowserSession>(this.filePath(browserSessionId));
  }

  async put(session: BrowserSession): Promise<void> {
    await writeJsonFileAtomic(this.filePath(session.browserSessionId), session);
  }

  async list(): Promise<BrowserSession[]> {
    return this.listAll();
  }

  async listByOwner(ownerType: BrowserSessionOwnerType, ownerId: string): Promise<BrowserSession[]> {
    const sessions = await this.listAll();
    return sessions.filter((session) => session.ownerType === ownerType && session.ownerId === ownerId);
  }

  async listActiveByProfile(profileId: string): Promise<BrowserSession[]> {
    const sessions = await this.listAll();
    return sessions.filter(
      (session) => session.profileId === profileId && session.status !== "closed" && session.status !== "disconnected"
    );
  }

  private async listAll(): Promise<BrowserSession[]> {
    const filePaths = await listJsonFiles(this.rootDir);
    const sessions = await Promise.all(filePaths.map((filePath) => readJsonFile<BrowserSession>(filePath)));
    return sessions.filter((session): session is BrowserSession => session !== null);
  }

  private filePath(browserSessionId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(browserSessionId)}.json`);
  }
}
