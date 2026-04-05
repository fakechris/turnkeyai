import path from "node:path";

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";
import type { RecoveryRun, RecoveryRunStore } from "@turnkeyai/core-types/team";

interface FileRecoveryRunStoreOptions {
  rootDir: string;
}

export class FileRecoveryRunStore implements RecoveryRunStore {
  private readonly rootDir: string;
  private readonly runMutex = new KeyedAsyncMutex<string>();

  constructor(options: FileRecoveryRunStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(recoveryRunId: string): Promise<RecoveryRun | null> {
    return this.runMutex.run(recoveryRunId, async () => {
      return (
        (await readJsonFile<RecoveryRun>(this.byIdFilePath(recoveryRunId))) ??
        (await readJsonFile<RecoveryRun>(this.legacyFlatFilePath(recoveryRunId)))
      );
    });
  }

  async put(run: RecoveryRun): Promise<void> {
    await this.runMutex.run(run.recoveryRunId, async () => {
      const byIdPath = this.byIdFilePath(run.recoveryRunId);
      const threadPath = this.threadFilePath(run.threadId, run.recoveryRunId);
      await writeJsonFileAtomic(byIdPath, run);
      try {
        await writeJsonFileAtomic(threadPath, run);
      } catch (error) {
        await removeFileIfExists(byIdPath);
        throw error;
      }
    });
  }

  async listByThread(threadId: string): Promise<RecoveryRun[]> {
    const threadFilePaths = await listJsonFiles(this.threadDir(threadId));
    const records = await Promise.all(threadFilePaths.map((filePath) => readJsonFile<RecoveryRun>(filePath)));
    const threadScoped = records.filter((record): record is RecoveryRun => record !== null);
    if (threadScoped.length > 0) {
      return threadScoped.sort((left, right) => right.updatedAt - left.updatedAt);
    }

    const legacyFilePaths = await listJsonFiles(this.rootDir);
    const legacyRecords = await Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RecoveryRun>(filePath)));
    return legacyRecords
      .filter((record): record is RecoveryRun => record !== null && record.threadId === threadId)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async listAll(): Promise<RecoveryRun[]> {
    const byIdFilePaths = await listJsonFiles(path.join(this.rootDir, "by-id"));
    if (byIdFilePaths.length > 0) {
      const records = await Promise.all(byIdFilePaths.map((filePath) => readJsonFile<RecoveryRun>(filePath)));
      return records
        .filter((record): record is RecoveryRun => record !== null)
        .sort((left, right) => right.updatedAt - left.updatedAt);
    }

    const legacyFilePaths = await listJsonFiles(this.rootDir);
    const records = await Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RecoveryRun>(filePath)));
    return records
      .filter((record): record is RecoveryRun => record !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private byIdFilePath(recoveryRunId: string): string {
    return path.join(this.rootDir, "by-id", `${encodeURIComponent(recoveryRunId)}.json`);
  }

  private threadDir(threadId: string): string {
    return path.join(this.rootDir, "threads", encodeURIComponent(threadId));
  }

  private threadFilePath(threadId: string, recoveryRunId: string): string {
    return path.join(this.threadDir(threadId), `${encodeURIComponent(recoveryRunId)}.json`);
  }

  private legacyFlatFilePath(recoveryRunId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(recoveryRunId)}.json`);
  }
}
