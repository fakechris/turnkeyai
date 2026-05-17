import { mkdir } from "node:fs/promises";
import path from "node:path";

import type {
  MissionId,
  WorkItem,
  WorkItemStore,
} from "@turnkeyai/core-types/mission";
import {
  listJsonFiles,
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
    const dir = this.missionDir(missionId);
    await mkdir(dir, { recursive: true });
    const files = await listJsonFiles(dir);
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
