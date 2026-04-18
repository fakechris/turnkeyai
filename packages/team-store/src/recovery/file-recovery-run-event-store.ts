import { readdir } from "node:fs/promises";
import path from "node:path";

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";
import type { RecoveryRunEvent, RecoveryRunEventStore } from "@turnkeyai/core-types/team";

interface FileRecoveryRunEventStoreOptions {
  rootDir: string;
}

type RecoveryRunEventSource = "legacy" | "by-run-array" | "by-run-journal" | "thread";

interface SourcedRecoveryRunEvent {
  source: RecoveryRunEventSource;
  event: RecoveryRunEvent;
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
    const sourcedEvents: SourcedRecoveryRunEvent[] = [
      ...(legacyEvents ?? []).map((event) => ({ source: "legacy" as const, event })),
      ...(byRunArrayEvents ?? []).map((event) => ({ source: "by-run-array" as const, event })),
      ...journalEvents.map((event) => ({ source: "by-run-journal" as const, event })),
    ];
    const results = mergeSourcedEvents(sourcedEvents);
    const events = results.map((result) => result.event);
    if (results.some((result) => result.repairNeeded)) {
      await this.mutex.run(recoveryRunId, async () => {
        await this.repairCanonicalStorageBestEffort(
          results.filter((result) => result.repairNeeded).map((result) => result.event)
        );
      });
    }
    return events;
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
    const results = mergeSourcedEvents([
      ...legacyArrays.flatMap((events) => events ?? []).map((event) => ({ source: "legacy" as const, event })),
      ...byRunArrays.flatMap((events) => events ?? []).map((event) => ({ source: "by-run-array" as const, event })),
      ...byRunJournalEvents
        .filter((item): item is RecoveryRunEvent => item !== null)
        .map((event) => ({ source: "by-run-journal" as const, event })),
      ...threadRecords
        .filter((item): item is RecoveryRunEvent => item !== null)
        .map((event) => ({ source: "thread" as const, event })),
    ]).filter((result) => result.event.threadId === threadId);
    const events = results.map((result) => result.event);
    const eventsByRecoveryRun = new Map<string, RecoveryRunEvent[]>();
    for (const { event, repairNeeded } of results) {
      if (!repairNeeded) {
        continue;
      }
      const bucket = eventsByRecoveryRun.get(event.recoveryRunId);
      if (bucket) {
        bucket.push(event);
      } else {
        eventsByRecoveryRun.set(event.recoveryRunId, [event]);
      }
    }
    if (eventsByRecoveryRun.size > 0) {
      await Promise.all(
        [...eventsByRecoveryRun.entries()].map(([recoveryRunId, recoveryRunEvents]) =>
          this.mutex.run(recoveryRunId, async () => {
            await this.repairCanonicalStorageBestEffort(recoveryRunEvents);
          })
        )
      );
    }
    return events;
  }

  private async listByRunEventPaths(): Promise<string[]> {
    const byRunRoot = path.join(this.rootDir, "by-run");
    let entries;
    try {
      entries = await readdir(byRunRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
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

  private async repairCanonicalStorage(events: RecoveryRunEvent[]): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const event of events) {
      const [existingByRunEvent, existingThreadEvent] = await Promise.all([
        readJsonFile<RecoveryRunEvent>(this.recoveryRunEventFilePath(event.recoveryRunId, event.eventId)),
        readJsonFile<RecoveryRunEvent>(this.threadEventFilePath(event.threadId, event.eventId)),
      ]);
      if (shouldRepairEventProjection(existingByRunEvent, event)) {
        writes.push(writeJsonFileAtomic(this.recoveryRunEventFilePath(event.recoveryRunId, event.eventId), event));
      }
      if (shouldRepairEventProjection(existingThreadEvent, event)) {
        writes.push(writeJsonFileAtomic(this.threadEventFilePath(event.threadId, event.eventId), event));
      }
    }
    await Promise.all(writes);
  }

  private async repairCanonicalStorageBestEffort(events: RecoveryRunEvent[]): Promise<void> {
    try {
      await this.repairCanonicalStorage(events);
    } catch {
      // Preserve successful reads; repair is best-effort during migration.
    }
  }
}

function shouldRepairEventProjection(current: RecoveryRunEvent | null, desired: RecoveryRunEvent): boolean {
  if (!current) {
    return true;
  }
  if (current.recordedAt > desired.recordedAt) {
    return false;
  }
  return JSON.stringify(current) !== JSON.stringify(desired);
}

function mergeSourcedEvents(events: SourcedRecoveryRunEvent[]): Array<{ event: RecoveryRunEvent; repairNeeded: boolean }> {
  const grouped = new Map<string, SourcedRecoveryRunEvent[]>();
  for (const item of events) {
    const bucket = grouped.get(item.event.eventId) ?? [];
    bucket.push(item);
    grouped.set(item.event.eventId, bucket);
  }
  return [...grouped.values()]
    .map((items) => ({
      event: latestEvent(items.map((item) => item.event)),
      repairNeeded: shouldRepairEventSources(items),
    }))
    .sort((left, right) => left.event.recordedAt - right.event.recordedAt);
}

function latestEvent(events: RecoveryRunEvent[]): RecoveryRunEvent {
  return events.reduce((latest, event) => {
    if (event.recordedAt >= latest.recordedAt) {
      return event;
    }
    return latest;
  });
}

function shouldRepairEventSources(events: SourcedRecoveryRunEvent[]): boolean {
  const sources = new Set(events.map((item) => item.source));
  if (sources.has("legacy") || sources.has("by-run-array")) {
    return true;
  }
  return !sources.has("by-run-journal") || !sources.has("thread");
}
