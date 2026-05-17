import { readdir } from "node:fs/promises";
import path from "node:path";

import type {
  Artifact,
  ArtifactStore,
  MissionId,
} from "@turnkeyai/core-types/mission";
import {
  readJsonFile,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";

interface FileArtifactStoreOptions {
  rootDir: string;
}

/**
 * Per-mission folder of artifact descriptor JSONs:
 *   <rootDir>/<missionId>/<artifactId>.json
 *
 * The descriptor only records WHERE the artifact lives + sha + size.
 * The actual bytes live wherever .path points (often a sibling
 * artifact-store managed by the daemon). This split lets the dashboard
 * list "what artifacts does mission X have?" without scanning blob
 * storage.
 */
export class FileArtifactStore implements ArtifactStore {
  private readonly rootDir: string;

  constructor(options: FileArtifactStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async listByMission(missionId: MissionId): Promise<Artifact[]> {
    // Read-only: do NOT mkdir on the read path (codex K2 #1). Same
    // reasoning as FileWorkItemStore — read-token holders shouldn't be
    // able to mint arbitrary mission directories by hitting unknown IDs.
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
    const all = await Promise.all(files.map((file) => readJsonFile<Artifact>(file)));
    const items = all.filter((a): a is Artifact => a !== null);
    items.sort((a, b) => b.createdAtMs - a.createdAtMs);
    return items;
  }

  async put(artifact: Artifact): Promise<void> {
    await writeJsonFileAtomic(this.artifactPath(artifact.missionId, artifact.id), artifact);
  }

  private missionDir(missionId: MissionId): string {
    return path.join(this.rootDir, encodeURIComponent(missionId));
  }

  private artifactPath(missionId: MissionId, id: string): string {
    return path.join(this.missionDir(missionId), `${encodeURIComponent(id)}.json`);
  }
}
