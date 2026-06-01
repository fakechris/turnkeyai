import { rm, stat } from "node:fs/promises";
import path from "node:path";

import type { BrowserArtifactLifecycle, BrowserArtifactRecord, BrowserArtifactStore } from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

export const DEFAULT_BROWSER_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_BROWSER_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_BROWSER_SESSION_ARTIFACT_BUDGET_BYTES = 100 * 1024 * 1024;

interface FileBrowserArtifactStoreOptions {
  rootDir: string;
  artifactRootDir?: string;
  retentionMs?: number;
  maxArtifactBytes?: number;
  sessionBudgetBytes?: number;
  cleanupOnSessionClose?: boolean;
  now?: () => number;
}

export class FileBrowserArtifactStore implements BrowserArtifactStore {
  private readonly rootDir: string;
  private readonly artifactRootDir: string | undefined;
  private readonly retentionMs: number;
  private readonly maxArtifactBytes: number;
  private readonly sessionBudgetBytes: number;
  private readonly cleanupOnSessionClose: boolean;
  private readonly now: () => number;

  constructor(options: FileBrowserArtifactStoreOptions) {
    this.rootDir = options.rootDir;
    this.artifactRootDir = options.artifactRootDir;
    this.retentionMs = options.retentionMs ?? DEFAULT_BROWSER_ARTIFACT_RETENTION_MS;
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_BROWSER_ARTIFACT_MAX_BYTES;
    this.sessionBudgetBytes = options.sessionBudgetBytes ?? DEFAULT_BROWSER_SESSION_ARTIFACT_BUDGET_BYTES;
    this.cleanupOnSessionClose = options.cleanupOnSessionClose ?? false;
    this.now = options.now ?? Date.now;
  }

  async put(record: BrowserArtifactRecord): Promise<void> {
    const existing = await this.get(record.artifactId);
    if (existing && existing.browserSessionId !== record.browserSessionId) {
      throw new Error(`browser artifact id already belongs to another session: ${record.artifactId}`);
    }
    const next = await this.withLifecycle(record);
    this.assertArtifactSize(next);
    await this.assertSessionBudget(next, existing);
    await writeJsonFileAtomic(this.filePath(record.artifactId), next);
  }

  async get(artifactId: string): Promise<BrowserArtifactRecord | null> {
    return readJsonFile<BrowserArtifactRecord>(this.filePath(artifactId));
  }

  async listBySession(browserSessionId: string): Promise<BrowserArtifactRecord[]> {
    const records = await this.listAll();
    return records
      .filter((record) => record.browserSessionId === browserSessionId)
      .sort(compareArtifacts);
  }

  async pruneExpired(input: { now?: number } = {}): Promise<{ recordsDeleted: number; filesDeleted: number }> {
    const now = input.now ?? this.now();
    const records = await this.listAll();
    const expiredRecords = records.filter(
      (record) => (record.lifecycle?.expiresAt ?? Number.POSITIVE_INFINITY) <= now
    );
    const results = await Promise.allSettled(expiredRecords.map((record) => this.pruneExpiredRecord(record)));
    let recordsDeleted = 0;
    let filesDeleted = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        recordsDeleted += result.value.recordsDeleted;
        filesDeleted += result.value.filesDeleted;
      }
    }
    return { recordsDeleted, filesDeleted };
  }

  private async listAll(): Promise<BrowserArtifactRecord[]> {
    const filePaths = await listJsonFiles(this.rootDir);
    const records = await Promise.all(filePaths.map((filePath) => readJsonFile<BrowserArtifactRecord>(filePath)));
    return records.filter((record): record is BrowserArtifactRecord => record !== null);
  }

  private async withLifecycle(record: BrowserArtifactRecord): Promise<BrowserArtifactRecord> {
    const sizeBytes = record.sizeBytes ?? (await readFileSize(record.path));
    const lifecycle = this.lifecycleFor(record);
    return {
      ...record,
      ...(sizeBytes !== null ? { sizeBytes } : {}),
      lifecycle,
    };
  }

  private lifecycleFor(record: BrowserArtifactRecord): BrowserArtifactLifecycle {
    return {
      storageBackend: "file",
      refType: "local-path",
      retentionMs: record.lifecycle?.retentionMs ?? this.retentionMs,
      expiresAt: record.lifecycle?.expiresAt ?? record.createdAt + (record.lifecycle?.retentionMs ?? this.retentionMs),
      maxArtifactBytes: record.lifecycle?.maxArtifactBytes ?? this.maxArtifactBytes,
      sessionBudgetBytes: record.lifecycle?.sessionBudgetBytes ?? this.sessionBudgetBytes,
      cleanupOnSessionClose: record.lifecycle?.cleanupOnSessionClose ?? this.cleanupOnSessionClose,
      orphanReconciliation: "delete_expired",
    };
  }

  private assertArtifactSize(record: BrowserArtifactRecord): void {
    if (record.sizeBytes !== undefined && record.sizeBytes > (record.lifecycle?.maxArtifactBytes ?? this.maxArtifactBytes)) {
      throw new Error(
        `browser artifact exceeds per-artifact budget: ${record.artifactId} (${record.sizeBytes} bytes)`
      );
    }
  }

  private async assertSessionBudget(record: BrowserArtifactRecord, existing: BrowserArtifactRecord | null): Promise<void> {
    const sizeBytes = record.sizeBytes ?? 0;
    if (sizeBytes === 0) {
      return;
    }
    const sessionBudgetBytes = record.lifecycle?.sessionBudgetBytes ?? this.sessionBudgetBytes;
    const currentBytes = (await this.listBySession(record.browserSessionId))
      .filter((candidate) => candidate.artifactId !== existing?.artifactId)
      .reduce((total, candidate) => total + (candidate.sizeBytes ?? 0), 0);
    if (currentBytes + sizeBytes > sessionBudgetBytes) {
      throw new Error(
        `browser session artifact budget exceeded: ${record.browserSessionId} (${currentBytes + sizeBytes} bytes)`
      );
    }
  }

  private isManagedArtifactPath(candidatePath: string): boolean {
    if (!this.artifactRootDir) {
      return false;
    }
    const relative = path.relative(this.artifactRootDir, candidatePath);
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  private async pruneExpiredRecord(record: BrowserArtifactRecord): Promise<{ recordsDeleted: number; filesDeleted: number }> {
    let recordsDeleted = 0;
    let filesDeleted = 0;
    try {
      await rm(this.filePath(record.artifactId), { force: true });
      recordsDeleted = 1;
    } catch {
      return { recordsDeleted, filesDeleted };
    }
    if (this.isManagedArtifactPath(record.path)) {
      filesDeleted = await rm(record.path, { force: true }).then(
        () => 1,
        () => 0
      );
    }
    return { recordsDeleted, filesDeleted };
  }

  private filePath(artifactId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(artifactId)}.json`);
  }
}

async function readFileSize(filePath: string): Promise<number | null> {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

function compareArtifacts(left: BrowserArtifactRecord, right: BrowserArtifactRecord): number {
  if (right.createdAt !== left.createdAt) {
    return right.createdAt - left.createdAt;
  }
  return left.artifactId.localeCompare(right.artifactId);
}
