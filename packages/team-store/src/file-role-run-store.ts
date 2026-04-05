import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { RoleRunState, RoleRunStore, RunKey, ThreadId } from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileRoleRunStoreOptions {
  rootDir: string;
}

export class FileRoleRunStore implements RoleRunStore {
  private readonly rootDir: string;
  private readonly runMutex = new KeyedAsyncMutex<string>();

  constructor(options: FileRoleRunStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(runKey: RunKey): Promise<RoleRunState | null> {
    return this.runMutex.run(runKey, async () => {
      const runState = await readJsonFile<RoleRunState>(this.filePath(runKey));
      return runState ? normalizeRoleRunStateVersion(runState) : null;
    });
  }

  async put(runState: RoleRunState): Promise<void> {
    await this.runMutex.run(runState.runKey, async () => {
      const filePath = this.filePath(runState.runKey);
      const existing = await readJsonFile<RoleRunState>(filePath);
      const existingVersion = existing?.version ?? 0;
      await writeJsonFileAtomic(filePath, normalizeRoleRunStateVersion({
        ...runState,
        version: existingVersion + 1,
      }));
    });
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

    return runs
      .filter((runState): runState is RoleRunState => runState !== null)
      .map((runState) => normalizeRoleRunStateVersion(runState));
  }

  private filePath(runKey: RunKey): string {
    return path.join(this.rootDir, encodeURIComponent(runKey) + ".json");
  }
}

function normalizeRoleRunStateVersion(runState: RoleRunState): RoleRunState {
  return {
    ...runState,
    version: runState.version && runState.version > 0 ? runState.version : 1,
  };
}
