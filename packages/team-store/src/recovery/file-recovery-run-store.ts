import path from "node:path";

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";
import type { RecoveryRun, RecoveryRunAttempt, RecoveryRunStore } from "@turnkeyai/core-types/team";

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
      return this.readRecoveryRun(recoveryRunId);
    });
  }

  async put(run: RecoveryRun, options?: { expectedVersion?: number | undefined }): Promise<void> {
    await this.runMutex.run(run.recoveryRunId, async () => {
      const byIdPath = this.byIdFilePath(run.recoveryRunId);
      const threadPath = this.threadFilePath(run.threadId, run.recoveryRunId);
      const existing = await this.readRecoveryRun(run.recoveryRunId);
      const existingVersion = existing?.version ?? 0;
      if (options?.expectedVersion != null && existingVersion !== options.expectedVersion) {
        throw new Error(
          `recovery run version conflict for ${run.recoveryRunId}: expected ${options.expectedVersion}, found ${existingVersion}`
        );
      }
      const storedRun = stripAttempts({
        ...run,
        version: existingVersion + 1,
      });
      await writeJsonFileAtomic(byIdPath, storedRun);
      try {
        await writeJsonFileAtomic(threadPath, storedRun);
        await Promise.all(run.attempts.map((attempt) => writeJsonFileAtomic(this.attemptFilePath(run.recoveryRunId, attempt.attemptId), attempt)));
      } catch (error) {
        await removeFileIfExists(byIdPath);
        throw error;
      }
    });
  }

  async listByThread(threadId: string): Promise<RecoveryRun[]> {
    const threadFilePaths = await listJsonFiles(this.threadDir(threadId));
    const records = await Promise.all(threadFilePaths.map((filePath) => readJsonFile<RecoveryRun>(filePath)));
    const threadScoped = await Promise.all(
      records
        .filter((record): record is RecoveryRun => record !== null)
        .map((record) => this.hydrateAttempts(record))
    );
    if (threadScoped.length > 0) {
      return threadScoped.sort((left, right) => right.updatedAt - left.updatedAt);
    }

    const legacyFilePaths = await listJsonFiles(this.rootDir);
    const legacyRecords = await Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RecoveryRun>(filePath)));
    const hydratedLegacy = await Promise.all(
      legacyRecords
        .filter((record): record is RecoveryRun => record !== null && record.threadId === threadId)
        .map((record) => this.hydrateAttempts(record))
    );
    return hydratedLegacy
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async listAll(): Promise<RecoveryRun[]> {
    const byIdFilePaths = await listJsonFiles(path.join(this.rootDir, "by-id"));
    if (byIdFilePaths.length > 0) {
      const records = await Promise.all(byIdFilePaths.map((filePath) => readJsonFile<RecoveryRun>(filePath)));
      const hydrated = await Promise.all(
        records
          .filter((record): record is RecoveryRun => record !== null)
          .map((record) => this.hydrateAttempts(record))
      );
      return hydrated
        .sort((left, right) => right.updatedAt - left.updatedAt);
    }

    const legacyFilePaths = await listJsonFiles(this.rootDir);
    const records = await Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RecoveryRun>(filePath)));
    const hydrated = await Promise.all(
      records
        .filter((record): record is RecoveryRun => record !== null)
        .map((record) => this.hydrateAttempts(record))
    );
    return hydrated
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async readRecoveryRun(recoveryRunId: string): Promise<RecoveryRun | null> {
    const run =
      (await readJsonFile<RecoveryRun>(this.byIdFilePath(recoveryRunId))) ??
      (await readJsonFile<RecoveryRun>(this.legacyFlatFilePath(recoveryRunId)));
    if (!run) {
      return null;
    }
    return this.hydrateAttempts(run);
  }

  private async hydrateAttempts(run: RecoveryRun): Promise<RecoveryRun> {
    const attemptPaths = await listJsonFiles(this.attemptDir(run.recoveryRunId));
    if (attemptPaths.length === 0) {
      return normalizeRecoveryRunVersion({
        ...run,
        attempts: [...run.attempts].sort(compareRecoveryAttempts),
      });
    }
    const journalAttempts = (
      await Promise.all(attemptPaths.map((filePath) => readJsonFile<RecoveryRunAttempt>(filePath)))
    ).filter((attempt): attempt is RecoveryRunAttempt => attempt !== null);
    const mergedAttempts = new Map<string, RecoveryRunAttempt>();
    for (const attempt of [...run.attempts, ...journalAttempts]) {
      const existing = mergedAttempts.get(attempt.attemptId);
      if (!existing || attempt.updatedAt >= existing.updatedAt) {
        mergedAttempts.set(attempt.attemptId, attempt);
      }
    }
    return normalizeRecoveryRunVersion({
      ...run,
      attempts: [...mergedAttempts.values()].sort(compareRecoveryAttempts),
    });
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

  private attemptDir(recoveryRunId: string): string {
    return path.join(this.rootDir, "attempts", encodeURIComponent(recoveryRunId));
  }

  private attemptFilePath(recoveryRunId: string, attemptId: string): string {
    return path.join(this.attemptDir(recoveryRunId), `${encodeURIComponent(attemptId)}.json`);
  }
}

function stripAttempts(run: RecoveryRun): RecoveryRun {
  return {
    ...run,
    attempts: [],
  };
}

function normalizeRecoveryRunVersion(run: RecoveryRun): RecoveryRun {
  return {
    ...run,
    version: run.version && run.version > 0 ? run.version : 1,
  };
}

function compareRecoveryAttempts(left: RecoveryRunAttempt, right: RecoveryRunAttempt): number {
  if (left.requestedAt !== right.requestedAt) {
    return left.requestedAt - right.requestedAt;
  }
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt - right.updatedAt;
  }
  return left.attemptId.localeCompare(right.attemptId);
}
