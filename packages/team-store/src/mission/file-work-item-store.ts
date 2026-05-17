import { readdir } from "node:fs/promises";
import path from "node:path";

import type {
  MissionId,
  WorkItem,
  WorkItemStore,
} from "@turnkeyai/core-types/mission";
import {
  readJsonFile,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";

interface FileWorkItemStoreOptions {
  rootDir: string;
}

/**
 * Per-mission directory of work-item JSON files:
 *   <rootDir>/<missionId>/<workItemId>.json
 *
 * Stored per-mission rather than flat because the dashboard always
 * reads "all work items for mission X" — a per-mission folder makes
 * that a single listJsonFiles call instead of a full scan.
 */
export class FileWorkItemStore implements WorkItemStore {
  private readonly rootDir: string;

  constructor(options: FileWorkItemStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async listByMission(missionId: MissionId): Promise<WorkItem[]> {
    // Read-only: do NOT mkdir here (codex K2 #1). Any read-scope token
    // can hit /missions/:id/work-items; auto-creating the dir would let
    // a caller mint arbitrary mission-id folders just by polling. Walk
    // the dir directly so the shared listJsonFiles helper (which
    // auto-mkdirs) is bypassed for this read path.
    const dir = this.missionDir(missionId);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name));
    const all = await Promise.all(files.map((file) => readJsonFile<WorkItem>(file)));
    const items = all.filter((w): w is WorkItem => w !== null);
    items.sort((a, b) => a.n - b.n);
    return items;
  }

  async put(item: WorkItem): Promise<void> {
    await writeJsonFileAtomic(this.workItemPath(item.missionId, item.id), item);
  }

  private missionDir(missionId: MissionId): string {
    return path.join(this.rootDir, encodeURIComponent(missionId));
  }

  private workItemPath(missionId: MissionId, id: string): string {
    return path.join(this.missionDir(missionId), `${encodeURIComponent(id)}.json`);
  }
}
