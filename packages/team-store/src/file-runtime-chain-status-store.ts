import path from "node:path";

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";
import type { RuntimeChainStatus, RuntimeChainStatusStore, ThreadId } from "@turnkeyai/core-types/team";

interface FileRuntimeChainStatusStoreOptions {
  rootDir: string;
}

export class FileRuntimeChainStatusStore implements RuntimeChainStatusStore {
  private readonly rootDir: string;
  private readonly chainMutex = new KeyedAsyncMutex<string>();

  constructor(options: FileRuntimeChainStatusStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(chainId: string): Promise<RuntimeChainStatus | null> {
    return this.chainMutex.run(chainId, async () => {
      return (
        (await readJsonFile<RuntimeChainStatus>(this.byIdFilePath(chainId))) ??
        (await readJsonFile<RuntimeChainStatus>(this.legacyFlatFilePath(chainId)))
      );
    });
  }

  async put(status: RuntimeChainStatus): Promise<void> {
    await this.chainMutex.run(status.chainId, async () => {
      const byIdPath = this.byIdFilePath(status.chainId);
      const threadPath = this.threadFilePath(status.threadId, status.chainId);
      const previousById = await readJsonFile<RuntimeChainStatus>(byIdPath);
      await writeJsonFileAtomic(byIdPath, status);
      try {
        await writeJsonFileAtomic(threadPath, status);
      } catch (error) {
        if (previousById) {
          await writeJsonFileAtomic(byIdPath, previousById);
        } else {
          await removeFileIfExists(byIdPath);
        }
        await removeFileIfExists(threadPath);
        throw error;
      }
    });
  }

  async listByThread(threadId: ThreadId): Promise<RuntimeChainStatus[]> {
    const threadFilePaths = await listJsonFiles(this.threadDir(threadId));
    const records = await Promise.all(threadFilePaths.map((filePath) => readJsonFile<RuntimeChainStatus>(filePath)));
    const threadScoped = records.filter((record): record is RuntimeChainStatus => record !== null);
    if (threadScoped.length > 0) {
      return threadScoped.sort((left, right) => right.updatedAt - left.updatedAt);
    }

    const legacyFilePaths = await listJsonFiles(this.rootDir);
    const legacyRecords = await Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RuntimeChainStatus>(filePath)));
    return legacyRecords
      .filter((record): record is RuntimeChainStatus => record !== null && record.threadId === threadId)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async listActive(limit?: number): Promise<RuntimeChainStatus[]> {
    const byIdFiles = await listJsonFiles(path.join(this.rootDir, "by-id"));
    const records = await Promise.all(byIdFiles.map((filePath) => readJsonFile<RuntimeChainStatus>(filePath)));
    const active = records
      .filter((record): record is RuntimeChainStatus => record !== null)
      .filter((record) => !["resolved", "completed", "failed", "cancelled"].includes(record.phase))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    if (limit && limit > 0) {
      return active.slice(0, limit);
    }
    return active;
  }

  async listAll(): Promise<RuntimeChainStatus[]> {
    const byIdFiles = await listJsonFiles(path.join(this.rootDir, "by-id"));
    if (byIdFiles.length > 0) {
      const records = await Promise.all(byIdFiles.map((filePath) => readJsonFile<RuntimeChainStatus>(filePath)));
      return records
        .filter((record): record is RuntimeChainStatus => record !== null)
        .sort((left, right) => right.updatedAt - left.updatedAt);
    }

    const legacyFilePaths = await listJsonFiles(this.rootDir);
    const records = await Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RuntimeChainStatus>(filePath)));
    return records
      .filter((record): record is RuntimeChainStatus => record !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private byIdFilePath(chainId: string): string {
    return path.join(this.rootDir, "by-id", `${sanitizeChainId(chainId)}.json`);
  }

  private threadDir(threadId: string): string {
    return path.join(this.rootDir, "threads", encodeURIComponent(threadId));
  }

  private threadFilePath(threadId: string, chainId: string): string {
    return path.join(this.threadDir(threadId), `${sanitizeChainId(chainId)}.json`);
  }

  private legacyFlatFilePath(chainId: string): string {
    return path.join(this.rootDir, `${sanitizeChainId(chainId)}.json`);
  }
}

function sanitizeChainId(chainId: string): string {
  return chainId.replace(/[^a-z0-9._:-]+/gi, "_");
}
