import path from "node:path";

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";
import type { PermissionCacheRecord, PermissionCacheStore } from "@turnkeyai/core-types/team";

interface FilePermissionCacheStoreOptions {
  rootDir: string;
}

export class FilePermissionCacheStore implements PermissionCacheStore {
  private readonly rootDir: string;
  private readonly cacheMutex = new KeyedAsyncMutex<string>();
  private readonly threadMutex = new KeyedAsyncMutex<string>();

  constructor(options: FilePermissionCacheStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(cacheKey: string): Promise<PermissionCacheRecord | null> {
    return this.cacheMutex.run(cacheKey, async () => {
      return (
        (await readJsonFile<PermissionCacheRecord>(this.byIdFilePath(cacheKey))) ??
        (await readJsonFile<PermissionCacheRecord>(this.legacyFlatFilePath(cacheKey)))
      );
    });
  }

  async put(record: PermissionCacheRecord): Promise<void> {
    await this.threadMutex.run(record.threadId, async () => {
      await this.cacheMutex.run(record.cacheKey, async () => {
        const byIdPath = this.byIdFilePath(record.cacheKey);
        const threadPath = this.threadFilePath(record.threadId, record.cacheKey);
        await writeJsonFileAtomic(byIdPath, record);
        try {
          await writeJsonFileAtomic(threadPath, record);
        } catch (error) {
          await removeFileIfExists(byIdPath);
          throw error;
        }
      });
    });
  }

  async listByThread(threadId: string): Promise<PermissionCacheRecord[]> {
    return this.threadMutex.run(threadId, async () => {
      const threadFilePaths = await listJsonFiles(this.threadDir(threadId));
      const records = await Promise.all(threadFilePaths.map((filePath) => readJsonFile<PermissionCacheRecord>(filePath)));
      const threadScoped = records.filter((record): record is PermissionCacheRecord => record !== null);
      if (threadScoped.length > 0) {
        return threadScoped;
      }

      const legacyFilePaths = await listJsonFiles(this.rootDir);
      const legacyRecords = await Promise.all(legacyFilePaths.map((filePath) => readJsonFile<PermissionCacheRecord>(filePath)));
      return legacyRecords.filter((record): record is PermissionCacheRecord => record !== null && record.threadId === threadId);
    });
  }

  private byIdFilePath(cacheKey: string): string {
    return path.join(this.rootDir, "by-id", `${sanitizeCacheKey(cacheKey)}.json`);
  }

  private threadDir(threadId: string): string {
    return path.join(this.rootDir, "threads", encodeURIComponent(threadId));
  }

  private threadFilePath(threadId: string, cacheKey: string): string {
    return path.join(this.threadDir(threadId), `${sanitizeCacheKey(cacheKey)}.json`);
  }

  private legacyFlatFilePath(cacheKey: string): string {
    return path.join(this.rootDir, `${sanitizeCacheKey(cacheKey)}.json`);
  }
}

function sanitizeCacheKey(cacheKey: string): string {
  return cacheKey.replace(/[^a-z0-9._-]+/gi, "_");
}
