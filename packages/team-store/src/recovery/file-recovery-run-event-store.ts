import { readdir } from "node:fs/promises";
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
    const [legacyEvents, byRunArrayEvents, eventPaths] = await Promise.all([
      readJsonFile<RecoveryRunEvent[]>(this.legacyFlatFilePath(recoveryRunId)),
      readJsonFile<RecoveryRunEvent[]>(this.byRunArrayFilePath(recoveryRunId)),
      listJsonFiles(this.recoveryRunEventDir(recoveryRunId)),
    ]);
    const journalEvents = (
      await Promise.all(eventPaths.map((filePath) => readJsonFile<RecoveryRunEvent>(filePath)))
    ).filter((event): event is RecoveryRunEvent => event !== null);
    const merged = new Map<string, RecoveryRunEvent>();
    for (const event of [...(legacyEvents ?? []), ...(byRunArrayEvents ?? []), ...journalEvents]) {
      const existing = merged.get(event.eventId);
      if (!existing || event.recordedAt >= existing.recordedAt) {
        merged.set(event.eventId, event);
      }
    }
    return [...merged.values()].sort((left, right) => left.recordedAt - right.recordedAt);
  }

  async listByThread(threadId: string): Promise<RecoveryRunEvent[]> {
    const [threadFilePaths, legacyFilePaths, byRunArrayPaths, byRunEventPaths] = await Promise.all([
      listJsonFiles(this.threadDir(threadId)),
      listJsonFiles(this.rootDir),
      listJsonFiles(path.join(this.rootDir, "by-run")),
      this.listByRunEventPaths(),
    ]);
    // Thread-scoped files store one event per file. During migration, legacy root arrays
    // older by-run arrays, and canonical per-run journals can still coexist.
    const [threadRecords, legacyArrays, byRunArrays, byRunJournalEvents] = await Promise.all([
      Promise.all(threadFilePaths.map((filePath) => readJsonFile<RecoveryRunEvent>(filePath))),
      Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RecoveryRunEvent[]>(filePath))),
      Promise.all(byRunArrayPaths.map((filePath) => readJsonFile<RecoveryRunEvent[]>(filePath))),
      Promise.all(byRunEventPaths.map((filePath) => readJsonFile<RecoveryRunEvent>(filePath))),
    ]);
    const merged = new Map<string, RecoveryRunEvent>();
    for (const event of [
      ...legacyArrays.flatMap((events) => events ?? []),
      ...byRunArrays.flatMap((events) => events ?? []),
      ...byRunJournalEvents.filter((item): item is RecoveryRunEvent => item !== null),
      ...threadRecords.filter((item): item is RecoveryRunEvent => item !== null),
    ]) {
      if (event.threadId !== threadId) {
        continue;
      }
      const existing = merged.get(event.eventId);
      if (!existing || event.recordedAt >= existing.recordedAt) {
        merged.set(event.eventId, event);
      }
    }
    return [...merged.values()].sort((left, right) => left.recordedAt - right.recordedAt);
  }

  private async listByRunEventPaths(): Promise<string[]> {
    const byRunRoot = path.join(this.rootDir, "by-run");
    let entries;
    try {
      entries = await readdir(byRunRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const eventPathLists = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => listJsonFiles(path.join(byRunRoot, entry.name, "events")))
    );
    return eventPathLists.flat();
  }

  private recoveryRunDir(recoveryRunId: string): string {
    return path.join(this.rootDir, "by-run", encodeURIComponent(recoveryRunId));
  }

  private byRunArrayFilePath(recoveryRunId: string): string {
    return path.join(this.rootDir, "by-run", `${encodeURIComponent(recoveryRunId)}.json`);
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
