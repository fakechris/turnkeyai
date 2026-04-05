import path from "node:path";

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";
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
      await writeJsonFileAtomic(this.recoveryRunEventFilePath(event.recoveryRunId, event.eventId), event);
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
    const [legacyEvents, eventPaths] = await Promise.all([
      readJsonFile<RecoveryRunEvent[]>(this.legacyFlatFilePath(recoveryRunId)),
      listJsonFiles(this.recoveryRunEventDir(recoveryRunId)),
    ]);
    const journalEvents = (
      await Promise.all(eventPaths.map((filePath) => readJsonFile<RecoveryRunEvent>(filePath)))
    ).filter((event): event is RecoveryRunEvent => event !== null);
    const merged = new Map<string, RecoveryRunEvent>();
    for (const event of [...(legacyEvents ?? []), ...journalEvents]) {
      const existing = merged.get(event.eventId);
      if (!existing || event.recordedAt >= existing.recordedAt) {
        merged.set(event.eventId, event);
      }
    }
    return [...merged.values()].sort((left, right) => left.recordedAt - right.recordedAt);
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

  private recoveryRunDir(recoveryRunId: string): string {
    return path.join(this.rootDir, "by-run", encodeURIComponent(recoveryRunId));
  }

  private recoveryRunEventDir(recoveryRunId: string): string {
    return path.join(this.recoveryRunDir(recoveryRunId), "events");
  }

  private recoveryRunEventFilePath(recoveryRunId: string, eventId: string): string {
    return path.join(this.recoveryRunEventDir(recoveryRunId), `${encodeURIComponent(eventId)}.json`);
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
