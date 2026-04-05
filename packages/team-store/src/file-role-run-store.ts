import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { RoleRunState, RoleRunStore, RunKey, ThreadId } from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileRoleRunStoreOptions {
  rootDir: string;
}

export class FileRoleRunStore implements RoleRunStore {
  private readonly rootDir: string;

  constructor(options: FileRoleRunStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(runKey: RunKey): Promise<RoleRunState | null> {
    return readJsonFile<RoleRunState>(this.filePath(runKey));
  }

  async put(runState: RoleRunState): Promise<void> {
    await writeJsonFileAtomic(this.filePath(runState.runKey), runState);
  }

  async delete(runKey: RunKey): Promise<void> {
    await removeFileIfExists(this.filePath(runKey));
  }

  async listByThread(threadId: ThreadId): Promise<RoleRunState[]> {
    const all = await this.listAll();
    return all.filter((runState) => runState.threadId === threadId);
  }

  async listAll(): Promise<RoleRunState[]> {
    await mkdir(this.rootDir, { recursive: true });
    const filePaths = await listJsonFiles(this.rootDir);
    const runs = await Promise.all(filePaths.map((filePath) => readJsonFile<RoleRunState>(filePath)));

    return runs.filter((runState): runState is RoleRunState => runState !== null);
  }

  private filePath(runKey: RunKey): string {
    return path.join(this.rootDir, encodeURIComponent(runKey) + ".json");
  }
}
