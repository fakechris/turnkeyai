import path from "node:path";

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";
import type { RuntimeChainEvent, RuntimeChainEventStore } from "@turnkeyai/core-types/team";

interface FileRuntimeChainEventStoreOptions {
  rootDir: string;
}

export class FileRuntimeChainEventStore implements RuntimeChainEventStore {
  private readonly rootDir: string;
  private readonly chainMutex = new KeyedAsyncMutex<string>();

  constructor(options: FileRuntimeChainEventStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async append(event: RuntimeChainEvent): Promise<void> {
    await this.chainMutex.run(event.chainId, async () => {
      const filePath = this.chainFilePath(event.chainId);
      const existing =
        (await readJsonFile<RuntimeChainEvent[]>(filePath)) ??
        (await readJsonFile<RuntimeChainEvent[]>(this.legacyFlatFilePath(event.chainId))) ??
        [];
      await writeJsonFileAtomic(filePath, [...existing, event]);
    });
  }

  async listByChain(chainId: string, limit?: number): Promise<RuntimeChainEvent[]> {
    const events =
      (await readJsonFile<RuntimeChainEvent[]>(this.chainFilePath(chainId))) ??
      (await readJsonFile<RuntimeChainEvent[]>(this.legacyFlatFilePath(chainId))) ??
      [];
    const sorted = [...events].sort((left, right) => left.recordedAt - right.recordedAt);
    if (limit && limit > 0) {
      return sorted.slice(-limit);
    }
    return sorted;
  }

  async listAll(): Promise<RuntimeChainEvent[]> {
    const byChainFiles = await listJsonFiles(path.join(this.rootDir, "by-chain"));
    if (byChainFiles.length > 0) {
      const records = await Promise.all(byChainFiles.map((filePath) => readJsonFile<RuntimeChainEvent[]>(filePath)));
      return records
        .flatMap((record) => record ?? [])
        .sort((left, right) => left.recordedAt - right.recordedAt);
    }

    const legacyFiles = await listJsonFiles(this.rootDir);
    const records = await Promise.all(legacyFiles.map((filePath) => readJsonFile<RuntimeChainEvent[]>(filePath)));
    return records
      .flatMap((record) => record ?? [])
      .sort((left, right) => left.recordedAt - right.recordedAt);
  }

  private chainFilePath(chainId: string): string {
    return path.join(this.rootDir, "by-chain", `${sanitizeChainId(chainId)}.json`);
  }

  private legacyFlatFilePath(chainId: string): string {
    return path.join(this.rootDir, `${sanitizeChainId(chainId)}.json`);
  }
}

function sanitizeChainId(chainId: string): string {
  return chainId.replace(/[^a-z0-9._:-]+/gi, "_");
}
