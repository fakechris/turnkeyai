import { readdir } from "node:fs/promises";
import path from "node:path";

import type {
  CreateMissionInput,
  Mission,
  MissionId,
  MissionStore,
} from "@turnkeyai/core-types/mission";
import {
  readJsonFile,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";

interface FileMissionStoreOptions {
  rootDir: string;
}

/**
 * File-backed mission store. One JSON file per mission, named by ID.
 *
 * Same shape as FileTeamThreadStore — list returns every JSON under
 * rootDir, get reads one by ID. K2 only needs create + get + list;
 * status transitions and progress updates will be added with K3/K4
 * once mutations come online.
 *
 * `create()` takes a separately-provided id generator + clock so the
 * store stays I/O-only and the daemon owns the env-aware concerns.
 */
export class FileMissionStore implements MissionStore {
  private readonly rootDir: string;

  constructor(options: FileMissionStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(id: MissionId): Promise<Mission | null> {
    return readJsonFile<Mission>(this.missionPath(id));
  }

  async list(): Promise<Mission[]> {
    // Read-only: do NOT mkdir here. If the rootDir hasn't been created
    // yet (fresh daemon, no bootstrap run), return [] cleanly.
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.rootDir, entry.name));
    const all = await Promise.all(files.map((file) => readJsonFile<Mission>(file)));
    return all.filter((m): m is Mission => m !== null);
  }

  async create(
    input: CreateMissionInput,
    ids: { missionIdGen: () => MissionId; shortIdGen: () => string; clock: { now(): number } }
  ): Promise<Mission> {
    const nowMs = ids.clock.now();
    const mission: Mission = {
      id: ids.missionIdGen(),
      shortId: ids.shortIdGen(),
      title: input.title,
      desc: input.desc,
      status: "draft",
      mode: input.mode,
      modeLabel: input.modeLabel,
      owner: input.owner,
      ownerLabel: input.ownerLabel,
      createdAt: new Date(nowMs).toISOString(),
      createdAtMs: nowMs,
      agents: [...input.agents],
      progress: 0,
      pendingApprovals: 0,
      blockers: 0,
      contextSummary: [],
    };
    await writeJsonFileAtomic(this.missionPath(mission.id), mission);
    return mission;
  }

  /**
   * K2 helper used by the bootstrap-demo route to upsert a fully-formed
   * fixture mission. Not part of the MissionStore contract because
   * normal callers should go through create() + status updates.
   */
  async putRaw(mission: Mission): Promise<void> {
    await writeJsonFileAtomic(this.missionPath(mission.id), mission);
  }

  private missionPath(id: MissionId): string {
    return path.join(this.rootDir, `${encodeURIComponent(id)}.json`);
  }
}
