import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import path from "node:path";

import type {
  ActivityEvent,
  ActivityEventStore,
  MissionId,
} from "@turnkeyai/core-types/mission";

interface FileActivityEventStoreOptions {
  rootDir: string;
}

/**
 * Append-only JSONL log per mission.
 *
 * Activity events are append-heavy and read mostly as "give me the last
 * N for mission X". Storing as JSONL (one event per line) lets append()
 * be a constant-time fs.appendFile call without a read-modify-write.
 * listByMission reads the whole file (small in K2; will switch to a
 * tail-reader if missions get long).
 *
 * Files live at <rootDir>/<missionId>.jsonl.
 */
export class FileActivityEventStore implements ActivityEventStore {
  private readonly rootDir: string;

  constructor(options: FileActivityEventStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async listByMission(
    missionId: MissionId,
    options?: { limit?: number }
  ): Promise<ActivityEvent[]> {
    const file = this.missionFile(missionId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const lines = raw.split("\n").filter((line) => line.length > 0);
    const events: ActivityEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as ActivityEvent);
      } catch {
        // Skip malformed lines rather than throwing — log corruption
        // shouldn't block the dashboard from reading the rest.
      }
    }
    events.sort((a, b) => a.tMs - b.tMs);
    if (typeof options?.limit === "number" && options.limit > 0) {
      return events.slice(-options.limit);
    }
    return events;
  }

  async append(event: ActivityEvent): Promise<void> {
    const file = this.missionFile(event.missionId);
    await mkdir(this.rootDir, { recursive: true });
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  }

  /**
   * Replace the entire log for a mission. Used by bootstrap-demo to
   * rewrite a clean fixture; normal callers append.
   *
   * Atomic via temp-file-then-rename (CodeRabbit K2 review): a crash
   * mid-write on the target file would leave a partial JSONL that the
   * next listByMission would silently drop most entries from. Writing
   * to a temp file in the same directory and renaming ensures the
   * target is either the full new content or untouched.
   */
  async replaceAll(missionId: MissionId, events: ActivityEvent[]): Promise<void> {
    const file = this.missionFile(missionId);
    await mkdir(this.rootDir, { recursive: true });
    const body =
      events.map((event) => JSON.stringify(event)).join("\n") +
      (events.length > 0 ? "\n" : "");
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, file);
  }

  private missionFile(missionId: MissionId): string {
    return path.join(this.rootDir, `${encodeURIComponent(missionId)}.jsonl`);
  }
}
