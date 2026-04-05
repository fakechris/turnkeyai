import path from "node:path";

import type { RoleScratchpadRecord, RoleScratchpadStore } from "@turnkeyai/core-types/team";
import { readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileRoleScratchpadStoreOptions {
  rootDir: string;
}

export class FileRoleScratchpadStore implements RoleScratchpadStore {
  private readonly rootDir: string;

  constructor(options: FileRoleScratchpadStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(threadId: string, roleId: string): Promise<RoleScratchpadRecord | null> {
    return readJsonFile<RoleScratchpadRecord>(this.filePath(threadId, roleId));
  }

  async put(record: RoleScratchpadRecord): Promise<void> {
    await writeJsonFileAtomic(this.filePath(record.threadId, record.roleId), record);
  }

  private filePath(threadId: string, roleId: string): string {
    return path.join(this.rootDir, encodeURIComponent(threadId), `${encodeURIComponent(roleId)}.json`);
  }
}
