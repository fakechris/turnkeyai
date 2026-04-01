import path from "node:path";

import { KeyedAsyncMutex } from "@turnkeyai/core-types/async-mutex";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/core-types/file-store-utils";
import type { RecoveryRunEvent, RecoveryRunEventStore } from "@turnkeyai/core-types/team";

interface FileRecoveryRunEventStoreOptions {
  rootDir: string;
}

export class FileRecoveryRunEventStore implements RecoveryRunEventStore {
  private readonly rootDir: string;
  private readonly mutex = new KeyedAsyncMutex<string>();

  constructor(options: FileRecoveryRunEventStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async append(event: RecoveryRunEvent): Promise<void> {
    await this.mutex.run(event.recoveryRunId, async () => {
      const filePath = this.byRecoveryRunFilePath(event.recoveryRunId);
      const existing =
        (await readJsonFile<RecoveryRunEvent[]>(filePath)) ??
        (await readJsonFile<RecoveryRunEvent[]>(this.legacyFlatFilePath(event.recoveryRunId))) ??
        [];
      await writeJsonFileAtomic(filePath, [...existing, event]);
      try {
        await writeJsonFileAtomic(this.threadEventFilePath(event.threadId, event.eventId), event);
      } catch (error) {
        console.error("failed to persist thread-scoped recovery event", {
          error,
          eventId: event.eventId,
          threadId: event.threadId,
          recoveryRunId: event.recoveryRunId,
          filePath: this.threadEventFilePath(event.threadId, event.eventId),
        });
      }
    });
  }

  async listByRecoveryRun(recoveryRunId: string): Promise<RecoveryRunEvent[]> {
    const events =
      (await readJsonFile<RecoveryRunEvent[]>(this.byRecoveryRunFilePath(recoveryRunId))) ??
      (await readJsonFile<RecoveryRunEvent[]>(this.legacyFlatFilePath(recoveryRunId))) ??
      [];
    return [...events].sort((left, right) => left.recordedAt - right.recordedAt);
  }

  async listByThread(threadId: string): Promise<RecoveryRunEvent[]> {
    const threadFilePaths = await listJsonFiles(this.threadDir(threadId));
    // Thread-scoped files store one event per file; the root dir only contains
    // legacy recovery-run arrays kept for backwards-compatible fallback reads.
    const threadRecords = await Promise.all(threadFilePaths.map((filePath) => readJsonFile<RecoveryRunEvent>(filePath)));
    const threadEvents = threadRecords.filter((event): event is RecoveryRunEvent => event !== null);
    if (threadEvents.length > 0) {
      return threadEvents.sort((left, right) => left.recordedAt - right.recordedAt);
    }

    const legacyFilePaths = await listJsonFiles(this.rootDir);
    const records = await Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RecoveryRunEvent[]>(filePath)));
    return records
      .flatMap((events) => events ?? [])
      .filter((event) => event.threadId === threadId)
      .sort((left, right) => left.recordedAt - right.recordedAt);
  }

  private byRecoveryRunFilePath(recoveryRunId: string): string {
    return path.join(this.rootDir, "by-run", `${encodeURIComponent(recoveryRunId)}.json`);
  }

  private threadDir(threadId: string): string {
    return path.join(this.rootDir, "threads", encodeURIComponent(threadId));
  }

  private threadEventFilePath(threadId: string, eventId: string): string {
    return path.join(this.threadDir(threadId), `${encodeURIComponent(eventId)}.json`);
  }

  private legacyFlatFilePath(recoveryRunId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(recoveryRunId)}.json`);
  }
}
