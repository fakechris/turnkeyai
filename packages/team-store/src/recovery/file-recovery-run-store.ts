import { readdir } from "node:fs/promises";
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
      const previousById = await readJsonFile<RecoveryRun>(byIdPath);
      const previousThread = await readJsonFile<RecoveryRun>(threadPath);
      const existingVersion = existing?.version ?? 0;
      if (options?.expectedVersion != null && existingVersion !== options.expectedVersion) {
        throw new Error(
          `recovery run version conflict for ${run.recoveryRunId}: expected ${options.expectedVersion}, found ${existingVersion}`
        );
      }
      const existingAttemptsById = new Map((existing?.attempts ?? []).map((attempt) => [attempt.attemptId, attempt]));
      const storedRun = stripAttempts({
        ...run,
        version: existingVersion + 1,
      });
      const writtenAttemptPaths: string[] = [];
      const previousAttempts = new Map<string, RecoveryRunAttempt | null>();
      try {
        await writeJsonFileAtomic(threadPath, storedRun);
        for (const attempt of run.attempts) {
          const attemptPath = this.attemptFilePath(run.recoveryRunId, attempt.attemptId);
          previousAttempts.set(attemptPath, existingAttemptsById.get(attempt.attemptId) ?? null);
          await writeJsonFileAtomic(attemptPath, attempt);
          writtenAttemptPaths.push(attemptPath);
        }
        await writeJsonFileAtomic(byIdPath, storedRun);
      } catch (error) {
        const safeRollback = async (op: () => Promise<void>) => {
          try {
            await op();
          } catch {
            // Preserve the original write failure; rollback is best-effort.
          }
        };
        for (const filePath of writtenAttemptPaths) {
          const previousAttempt = previousAttempts.get(filePath);
          await safeRollback(() =>
            previousAttempt ? writeJsonFileAtomic(filePath, previousAttempt) : removeFileIfExists(filePath)
          );
        }
        if (!previousById) {
          await safeRollback(() => removeFileIfExists(byIdPath));
        }
        await safeRollback(() =>
          previousThread ? writeJsonFileAtomic(threadPath, previousThread) : removeFileIfExists(threadPath)
        );
        throw error;
      }
    });
  }

  async listByThread(threadId: string): Promise<RecoveryRun[]> {
    const [threadFilePaths, byIdFilePaths, legacyFilePaths] = await Promise.all([
      listJsonFiles(this.threadDir(threadId)),
      listJsonFiles(path.join(this.rootDir, "by-id")),
      listJsonFiles(this.rootDir),
    ]);
    const [threadRecords, byIdRecords, legacyRecords] = await Promise.all([
      Promise.all(threadFilePaths.map((filePath) => readJsonFile<RecoveryRun>(filePath))),
      Promise.all(byIdFilePaths.map((filePath) => readJsonFile<RecoveryRun>(filePath))),
      Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RecoveryRun>(filePath))),
    ]);
    return this.mergeRunsForThread(threadId, [
      ...legacyRecords.filter((record): record is RecoveryRun => record !== null),
      ...byIdRecords.filter((record): record is RecoveryRun => record !== null),
      ...threadRecords.filter((record): record is RecoveryRun => record !== null),
    ]);
  }

  async listAll(): Promise<RecoveryRun[]> {
    const [byIdFilePaths, legacyFilePaths, threadScopedPaths] = await Promise.all([
      listJsonFiles(path.join(this.rootDir, "by-id")),
      listJsonFiles(this.rootDir),
      this.listThreadScopedPaths(),
    ]);
    const [byIdRecords, legacyRecords, threadRecords] = await Promise.all([
      Promise.all(byIdFilePaths.map((filePath) => readJsonFile<RecoveryRun>(filePath))),
      Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RecoveryRun>(filePath))),
      Promise.all(threadScopedPaths.map((filePath) => readJsonFile<RecoveryRun>(filePath))),
    ]);
    return this.mergeAllRuns([
      ...legacyRecords.filter((record): record is RecoveryRun => record !== null),
      ...byIdRecords.filter((record): record is RecoveryRun => record !== null),
      ...threadRecords.filter((record): record is RecoveryRun => record !== null),
    ]);
  }

  private async readRecoveryRun(recoveryRunId: string): Promise<RecoveryRun | null> {
    const [byIdRun, legacyRun, threadScopedRun] = await Promise.all([
      readJsonFile<RecoveryRun>(this.byIdFilePath(recoveryRunId)),
      readJsonFile<RecoveryRun>(this.legacyFlatFilePath(recoveryRunId)),
      this.readThreadScopedRecoveryRun(recoveryRunId),
    ]);
    const run = [legacyRun, byIdRun, threadScopedRun].reduce<RecoveryRun | null>((latest, candidate) => {
      if (!candidate) {
        return latest;
      }
      if (!latest || candidate.updatedAt >= latest.updatedAt) {
        return candidate;
      }
      return latest;
    }, null);
    if (!run) {
      return null;
    }
    return this.hydrateAttempts(run);
  }

  private async readThreadScopedRecoveryRun(recoveryRunId: string): Promise<RecoveryRun | null> {
    const threadScopedPaths = await this.listThreadScopedPaths();
    const encodedFileName = `${encodeURIComponent(recoveryRunId)}.json`;
    const matchedPath = threadScopedPaths.find((filePath) => path.basename(filePath) === encodedFileName);
    if (!matchedPath) {
      return null;
    }
    return readJsonFile<RecoveryRun>(matchedPath);
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

  private async mergeRunsForThread(threadId: string, records: RecoveryRun[]): Promise<RecoveryRun[]> {
    const merged = new Map<string, RecoveryRun>();
    for (const record of records) {
      if (record.threadId !== threadId) {
        continue;
      }
      const existing = merged.get(record.recoveryRunId);
      if (!existing || record.updatedAt >= existing.updatedAt) {
        merged.set(record.recoveryRunId, record);
      }
    }
    const hydrated = await Promise.all([...merged.values()].map((record) => this.hydrateAttempts(record)));
    return hydrated.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async mergeAllRuns(records: RecoveryRun[]): Promise<RecoveryRun[]> {
    const merged = new Map<string, RecoveryRun>();
    for (const record of records) {
      const existing = merged.get(record.recoveryRunId);
      if (!existing || record.updatedAt >= existing.updatedAt) {
        merged.set(record.recoveryRunId, record);
      }
    }
    const hydrated = await Promise.all([...merged.values()].map((record) => this.hydrateAttempts(record)));
    return hydrated.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async listThreadScopedPaths(): Promise<string[]> {
    const threadsRoot = path.join(this.rootDir, "threads");
    let threadDirs;
    try {
      threadDirs = await readdir(threadsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const fileLists = await Promise.all(
      threadDirs
        .filter((entry) => entry.isDirectory())
        .map((entry) => listJsonFiles(path.join(threadsRoot, entry.name)))
    );
    return fileLists.flat();
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
