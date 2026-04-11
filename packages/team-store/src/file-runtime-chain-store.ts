import path from "node:path";
import { access } from "node:fs/promises";

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";
import type { RuntimeChain, RuntimeChainStore, ThreadId } from "@turnkeyai/core-types/team";

interface FileRuntimeChainStoreOptions {
  rootDir: string;
}

export class FileRuntimeChainStore implements RuntimeChainStore {
  private readonly rootDir: string;
  private readonly chainMutex = new KeyedAsyncMutex<string>();

  constructor(options: FileRuntimeChainStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(chainId: string): Promise<RuntimeChain | null> {
    return this.chainMutex.run(chainId, async () => {
      return (
        (await readJsonFile<RuntimeChain>(this.byIdFilePath(chainId))) ??
        (await readJsonFile<RuntimeChain>(this.legacyFlatFilePath(chainId)))
      );
    });
  }

  async put(chain: RuntimeChain, options?: { expectedVersion?: number | undefined }): Promise<void> {
    await this.chainMutex.run(chain.chainId, async () => {
      const byIdPath = this.byIdFilePath(chain.chainId);
      const threadPath = this.threadFilePath(chain.threadId, chain.chainId);
      const existing =
        (await readJsonFile<RuntimeChain>(byIdPath)) ??
        (await readJsonFile<RuntimeChain>(this.legacyFlatFilePath(chain.chainId)));
      const existingVersion = existing?.version ?? 0;
      if (options?.expectedVersion != null && existingVersion !== options.expectedVersion) {
        throw new Error(
          `runtime chain version conflict for ${chain.chainId}: expected ${options.expectedVersion}, found ${existingVersion}`
        );
      }
      const byIdExisted = await fileExists(byIdPath);
      const next = {
        ...chain,
        version: existingVersion + 1,
      } satisfies RuntimeChain;
      await writeJsonFileAtomic(byIdPath, next);
      try {
        await writeJsonFileAtomic(threadPath, next);
      } catch (error) {
        if (!byIdExisted) {
          await removeFileIfExists(byIdPath);
        }
        await removeFileIfExists(threadPath);
        throw error;
      }
    });
  }

  async listByThread(threadId: ThreadId): Promise<RuntimeChain[]> {
    const threadFilePaths = await listJsonFiles(this.threadDir(threadId));
    const threadRecords = await Promise.all(threadFilePaths.map((filePath) => readJsonFile<RuntimeChain>(filePath)));
    const legacyFilePaths = await listJsonFiles(this.rootDir);
    const legacyRecords = await Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RuntimeChain>(filePath)));
    const merged = new Map<string, RuntimeChain>();
    for (const record of [...threadRecords, ...legacyRecords]) {
      if (!record || record.threadId !== threadId) {
        continue;
      }
      const existing = merged.get(record.chainId);
      if (!existing || record.updatedAt >= existing.updatedAt) {
        merged.set(record.chainId, record);
      }
    }
    return [...merged.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async listAll(): Promise<RuntimeChain[]> {
    const byIdFilePaths = await listJsonFiles(path.join(this.rootDir, "by-id"));
    if (byIdFilePaths.length > 0) {
      const records = await Promise.all(byIdFilePaths.map((filePath) => readJsonFile<RuntimeChain>(filePath)));
      return records
        .filter((record): record is RuntimeChain => record !== null)
        .sort((left, right) => right.updatedAt - left.updatedAt);
    }

    const legacyFilePaths = await listJsonFiles(this.rootDir);
    const records = await Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RuntimeChain>(filePath)));
    return records
      .filter((record): record is RuntimeChain => record !== null)
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
