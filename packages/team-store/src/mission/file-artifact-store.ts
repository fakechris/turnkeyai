import { mkdir } from "node:fs/promises";
import path from "node:path";

import type {
  Artifact,
  ArtifactStore,
  MissionId,
} from "@turnkeyai/core-types/mission";
import {
  listJsonFiles,
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
    const dir = this.missionDir(missionId);
    await mkdir(dir, { recursive: true });
    const files = await listJsonFiles(dir);
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
