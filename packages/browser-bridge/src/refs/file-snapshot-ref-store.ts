import path from "node:path";

import type { BrowserSnapshotArtifact, ResolvedRef, SnapshotRefStore } from "@turnkeyai/core-types/team";
import { readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileSnapshotRefStoreOptions {
  rootDir: string;
}

type SnapshotRefFile = {
  browserSessionId: string;
  targetId: string;
  latestSnapshotId: string;
  snapshots: Array<{
    snapshotId: string;
    refEntries: BrowserSnapshotArtifact["refEntries"];
    finalUrl: string;
    title: string;
    updatedAt: number;
  }>;
  updatedAt: number;
};

export class FileSnapshotRefStore implements SnapshotRefStore {
  private readonly rootDir: string;

  constructor(options: FileSnapshotRefStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async save(snapshot: BrowserSnapshotArtifact): Promise<void> {
    const existing = await this.readSnapshotFile(this.filePath(snapshot.browserSessionId, snapshot.targetId), {
      browserSessionId: snapshot.browserSessionId,
      targetId: snapshot.targetId,
    });
    const snapshots = [
      ...(existing?.snapshots ?? []).filter((item) => item.snapshotId !== snapshot.snapshotId),
      {
        snapshotId: snapshot.snapshotId,
        refEntries: snapshot.refEntries,
        finalUrl: snapshot.finalUrl,
        title: snapshot.title,
        updatedAt: snapshot.createdAt,
      },
    ]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 5);
    const payload: SnapshotRefFile = {
      browserSessionId: snapshot.browserSessionId,
      targetId: snapshot.targetId,
      latestSnapshotId: snapshot.snapshotId,
      snapshots,
      updatedAt: snapshot.createdAt,
    };

    await writeJsonFileAtomic(this.snapshotIndexPath(snapshot.snapshotId), {
      browserSessionId: snapshot.browserSessionId,
      targetId: snapshot.targetId,
    });
    await writeJsonFileAtomic(this.filePath(snapshot.browserSessionId, snapshot.targetId), payload);
  }

  async resolve(input: {
    browserSessionId: string;
    targetId: string;
    refId: string;
  }): Promise<ResolvedRef | null> {
    const payload = await this.readSnapshotFile(this.filePath(input.browserSessionId, input.targetId), {
      browserSessionId: input.browserSessionId,
      targetId: input.targetId,
    });
    const entry = payload?.snapshots
      .flatMap((snapshot) => snapshot.refEntries)
      .find((item) => item.refId === input.refId);
    if (!entry) {
      return null;
    }

    const resolved: ResolvedRef = {
      refId: entry.refId,
      strategy: "snapshot-cache",
    };

    if (entry.selectors) {
      resolved.selectors = entry.selectors;
    }

    if (entry.label) {
      resolved.label = entry.label;
    }

    return resolved;
  }

  async expire(snapshotId: string): Promise<void> {
    const index = await readJsonFile<{ browserSessionId: string; targetId: string }>(this.snapshotIndexPath(snapshotId));
    if (!index) {
      return;
    }

    const filePath = this.filePath(index.browserSessionId, index.targetId);
    const payload = await this.readSnapshotFile(filePath, {
      browserSessionId: index.browserSessionId,
      targetId: index.targetId,
    });
    if (!payload) {
      await removeFileIfExists(this.snapshotIndexPath(snapshotId));
      return;
    }

    const snapshots = payload.snapshots.filter((item) => item.snapshotId !== snapshotId);
    if (snapshots.length === 0) {
      await removeFileIfExists(filePath);
      await removeFileIfExists(this.snapshotIndexPath(snapshotId));
      return;
    }

    const latest = snapshots[0]!;
    await writeJsonFileAtomic(filePath, {
      ...payload,
      latestSnapshotId: latest.snapshotId,
      snapshots,
      updatedAt: latest.updatedAt,
    });
    await removeFileIfExists(this.snapshotIndexPath(snapshotId));
  }

  private filePath(browserSessionId: string, targetId: string): string {
    return path.join(this.rootDir, encodeURIComponent(browserSessionId), `${encodeURIComponent(targetId)}.json`);
  }

  private snapshotIndexPath(snapshotId: string): string {
    return path.join(this.rootDir, "_snapshot-index", `${encodeURIComponent(snapshotId)}.json`);
  }

  private async readSnapshotFile(
    filePath: string,
    fallback?: { browserSessionId: string; targetId: string }
  ): Promise<SnapshotRefFile | null> {
    const payload = await readJsonFile<Record<string, unknown>>(filePath);
    if (!payload) {
      return null;
    }

    const browserSessionId =
      typeof payload.browserSessionId === "string" && payload.browserSessionId.length > 0
        ? payload.browserSessionId
        : (fallback?.browserSessionId ?? "");
    const targetId =
      typeof payload.targetId === "string" && payload.targetId.length > 0
        ? payload.targetId
        : (fallback?.targetId ?? "");

    if (Array.isArray(payload.snapshots)) {
      const snapshots = payload.snapshots
        .map((entry) => this.normalizeSnapshotEntry(entry))
        .filter((entry): entry is SnapshotRefFile["snapshots"][number] => entry !== null)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      if (snapshots.length === 0) {
        return null;
      }

      return {
        browserSessionId,
        targetId,
        latestSnapshotId:
          typeof payload.latestSnapshotId === "string" && payload.latestSnapshotId.length > 0
            ? payload.latestSnapshotId
            : snapshots[0]!.snapshotId,
        snapshots,
        updatedAt:
          typeof payload.updatedAt === "number" && Number.isFinite(payload.updatedAt)
            ? payload.updatedAt
            : snapshots[0]!.updatedAt,
      };
    }

    const legacyRefEntries = Array.isArray(payload.refEntries)
      ? (payload.refEntries as BrowserSnapshotArtifact["refEntries"])
      : null;
    if (!legacyRefEntries) {
      return null;
    }

    const latestSnapshotId =
      typeof payload.latestSnapshotId === "string" && payload.latestSnapshotId.length > 0
        ? payload.latestSnapshotId
        : "legacy-snapshot";
    const updatedAt =
      typeof payload.updatedAt === "number" && Number.isFinite(payload.updatedAt)
        ? payload.updatedAt
        : 0;

    return {
      browserSessionId,
      targetId,
      latestSnapshotId,
      snapshots: [
        {
          snapshotId: latestSnapshotId,
          refEntries: legacyRefEntries,
          finalUrl: typeof payload.finalUrl === "string" ? payload.finalUrl : "",
          title: typeof payload.title === "string" ? payload.title : "",
          updatedAt,
        },
      ],
      updatedAt,
    };
  }

  private normalizeSnapshotEntry(entry: unknown): SnapshotRefFile["snapshots"][number] | null {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    const record = entry as Record<string, unknown>;
    const snapshotId = typeof record.snapshotId === "string" && record.snapshotId.length > 0 ? record.snapshotId : null;
    const refEntries = Array.isArray(record.refEntries) ? (record.refEntries as BrowserSnapshotArtifact["refEntries"]) : null;
    if (!snapshotId || !refEntries) {
      return null;
    }

    return {
      snapshotId,
      refEntries,
      finalUrl: typeof record.finalUrl === "string" ? record.finalUrl : "",
      title: typeof record.title === "string" ? record.title : "",
      updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    };
  }
}
