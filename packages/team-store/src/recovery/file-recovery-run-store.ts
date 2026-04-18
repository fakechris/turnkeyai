import { readdir } from "node:fs/promises";
import path from "node:path";

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";
import type { RecoveryRun, RecoveryRunAttempt, RecoveryRunStore } from "@turnkeyai/core-types/team";

interface FileRecoveryRunStoreOptions {
  rootDir: string;
}

type RecoveryRunProjectionSource = "legacy" | "by-id" | "thread";

interface SourcedRecoveryRun {
  source: RecoveryRunProjectionSource;
  run: RecoveryRun;
}

interface RecoveryRunReadResult {
  run: RecoveryRun;
  repairNeeded: boolean;
}

export class FileRecoveryRunStore implements RecoveryRunStore {
  private readonly rootDir: string;
  private readonly runMutex = new KeyedAsyncMutex<string>();

  constructor(options: FileRecoveryRunStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(recoveryRunId: string): Promise<RecoveryRun | null> {
    return this.runMutex.run(recoveryRunId, async () => {
      const result = await this.readRecoveryRunWithRepairState(recoveryRunId);
      if (!result) {
        return null;
      }
      if (result.repairNeeded) {
        await this.repairCanonicalStorageBestEffort(result.run);
      }
      return result.run;
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
    const results = await this.mergeRunsForThread(threadId, [
      ...legacyRecords.filter((record): record is RecoveryRun => record !== null).map((run) => ({ source: "legacy" as const, run })),
      ...byIdRecords.filter((record): record is RecoveryRun => record !== null).map((run) => ({ source: "by-id" as const, run })),
      ...threadRecords.filter((record): record is RecoveryRun => record !== null).map((run) => ({ source: "thread" as const, run })),
    ]);
    await Promise.all(
      results
        .filter((result) => result.repairNeeded)
        .map((result) =>
        this.runMutex.run(result.run.recoveryRunId, async () => {
          await this.repairCanonicalStorageBestEffort(result.run);
        })
      )
    );
    return results.map((result) => result.run);
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
    const results = await this.mergeAllRuns([
      ...legacyRecords.filter((record): record is RecoveryRun => record !== null).map((run) => ({ source: "legacy" as const, run })),
      ...byIdRecords.filter((record): record is RecoveryRun => record !== null).map((run) => ({ source: "by-id" as const, run })),
      ...threadRecords.filter((record): record is RecoveryRun => record !== null).map((run) => ({ source: "thread" as const, run })),
    ]);
    await Promise.all(
      results
        .filter((result) => result.repairNeeded)
        .map((result) =>
        this.runMutex.run(result.run.recoveryRunId, async () => {
          await this.repairCanonicalStorageBestEffort(result.run);
        })
      )
    );
    return results.map((result) => result.run);
  }

  private async readRecoveryRun(recoveryRunId: string): Promise<RecoveryRun | null> {
    return (await this.readRecoveryRunWithRepairState(recoveryRunId))?.run ?? null;
  }

  private async readRecoveryRunWithRepairState(recoveryRunId: string): Promise<RecoveryRunReadResult | null> {
    const [byIdRun, legacyRun, threadScopedRun] = await Promise.all([
      readJsonFile<RecoveryRun>(this.byIdFilePath(recoveryRunId)),
      readJsonFile<RecoveryRun>(this.legacyFlatFilePath(recoveryRunId)),
      this.readThreadScopedRecoveryRun(recoveryRunId),
    ]);
    const sourced = [
      legacyRun ? { source: "legacy" as const, run: legacyRun } : null,
      byIdRun ? { source: "by-id" as const, run: byIdRun } : null,
      threadScopedRun ? { source: "thread" as const, run: threadScopedRun } : null,
    ].filter((record): record is SourcedRecoveryRun => record !== null);
    if (sourced.length === 0) {
      return null;
    }
    return this.hydrateMergedRun(sourced);
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

  private async mergeRunsForThread(threadId: string, records: SourcedRecoveryRun[]): Promise<RecoveryRunReadResult[]> {
    const grouped = new Map<string, SourcedRecoveryRun[]>();
    for (const record of records) {
      if (record.run.threadId !== threadId) {
        continue;
      }
      const bucket = grouped.get(record.run.recoveryRunId) ?? [];
      bucket.push(record);
      grouped.set(record.run.recoveryRunId, bucket);
    }
    const hydrated = await Promise.all([...grouped.values()].map((records) => this.hydrateMergedRun(records)));
    return hydrated.sort((left, right) => right.run.updatedAt - left.run.updatedAt);
  }

  private async mergeAllRuns(records: SourcedRecoveryRun[]): Promise<RecoveryRunReadResult[]> {
    const grouped = new Map<string, SourcedRecoveryRun[]>();
    for (const record of records) {
      const bucket = grouped.get(record.run.recoveryRunId) ?? [];
      bucket.push(record);
      grouped.set(record.run.recoveryRunId, bucket);
    }
    const hydrated = await Promise.all([...grouped.values()].map((records) => this.hydrateMergedRun(records)));
    return hydrated.sort((left, right) => right.run.updatedAt - left.run.updatedAt);
  }

  private async hydrateMergedRun(records: SourcedRecoveryRun[]): Promise<RecoveryRunReadResult> {
    const latest = records.reduce<RecoveryRun | null>((current, record) => {
      if (!current || record.run.updatedAt >= current.updatedAt) {
        return record.run;
      }
      return current;
    }, null);
    if (!latest) {
      throw new Error("cannot hydrate empty recovery run group");
    }
    const embeddedAttempts = mergeEmbeddedAttempts(records.map((record) => record.run));
    const run = await this.hydrateAttempts({
      ...latest,
      attempts: embeddedAttempts,
    });
    return {
      run,
      repairNeeded: shouldRepairRunSources(records),
    };
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

  private async repairCanonicalStorage(run: RecoveryRun): Promise<void> {
    const normalizedRun = normalizeRecoveryRunVersion(run);
    const strippedRun = stripAttempts(normalizedRun);
    const byIdPath = this.byIdFilePath(normalizedRun.recoveryRunId);
    const threadPath = this.threadFilePath(normalizedRun.threadId, normalizedRun.recoveryRunId);
    const [existingById, existingThread, attemptPaths] = await Promise.all([
      readJsonFile<RecoveryRun>(byIdPath),
      readJsonFile<RecoveryRun>(threadPath),
      listJsonFiles(this.attemptDir(normalizedRun.recoveryRunId)),
    ]);
    const existingAttempts = new Map(
      (
        await Promise.all(attemptPaths.map((filePath) => readJsonFile<RecoveryRunAttempt>(filePath)))
      )
        .filter((attempt): attempt is RecoveryRunAttempt => attempt !== null)
        .map((attempt) => [attempt.attemptId, attempt])
    );

    const writes: Promise<void>[] = [];
    if (shouldRepairRunProjection(existingById, strippedRun)) {
      writes.push(writeJsonFileAtomic(byIdPath, strippedRun));
    }
    if (shouldRepairRunProjection(existingThread, strippedRun)) {
      writes.push(writeJsonFileAtomic(threadPath, strippedRun));
    }
    for (const attempt of normalizedRun.attempts) {
      const existingAttempt = existingAttempts.get(attempt.attemptId) ?? null;
      if (shouldRepairAttemptProjection(existingAttempt, attempt)) {
        writes.push(writeJsonFileAtomic(this.attemptFilePath(normalizedRun.recoveryRunId, attempt.attemptId), attempt));
      }
    }
    await Promise.all(writes);
  }

  private async repairCanonicalStorageBestEffort(run: RecoveryRun): Promise<void> {
    try {
      await this.repairCanonicalStorage(run);
    } catch {
      // Preserve successful reads; repair is best-effort during migration.
    }
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

function mergeEmbeddedAttempts(runs: RecoveryRun[]): RecoveryRunAttempt[] {
  const merged = new Map<string, RecoveryRunAttempt>();
  for (const run of runs) {
    for (const attempt of run.attempts) {
      const existing = merged.get(attempt.attemptId);
      if (!existing || attempt.updatedAt >= existing.updatedAt) {
        merged.set(attempt.attemptId, attempt);
      }
    }
  }
  return [...merged.values()].sort(compareRecoveryAttempts);
}

function shouldRepairRunSources(records: SourcedRecoveryRun[]): boolean {
  const sources = new Set(records.map((record) => record.source));
  if (sources.has("legacy")) {
    return true;
  }
  if (!sources.has("by-id") || !sources.has("thread")) {
    return true;
  }
  return records.some((record) => record.run.attempts.length > 0);
}

function shouldRepairRunProjection(current: RecoveryRun | null, desired: RecoveryRun): boolean {
  if (!current) {
    return true;
  }
  const normalizedCurrent = stripAttempts(normalizeRecoveryRunVersion(current));
  if ((normalizedCurrent.version ?? 0) > (desired.version ?? 0)) {
    return false;
  }
  if (normalizedCurrent.updatedAt > desired.updatedAt) {
    return false;
  }
  return JSON.stringify(normalizedCurrent) !== JSON.stringify(desired);
}

function shouldRepairAttemptProjection(current: RecoveryRunAttempt | null, desired: RecoveryRunAttempt): boolean {
  if (!current) {
    return true;
  }
  if (current.updatedAt > desired.updatedAt) {
    return false;
  }
  return JSON.stringify(current) !== JSON.stringify(desired);
}
