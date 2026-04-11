import path from "node:path";
import { access } from "node:fs/promises";

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";
import type { RuntimeChainSpan, RuntimeChainSpanStore } from "@turnkeyai/core-types/team";

interface FileRuntimeChainSpanStoreOptions {
  rootDir: string;
}

export class FileRuntimeChainSpanStore implements RuntimeChainSpanStore {
  private readonly rootDir: string;
  private readonly spanMutex = new KeyedAsyncMutex<string>();
  private readonly chainMutex = new KeyedAsyncMutex<string>();

  constructor(options: FileRuntimeChainSpanStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(spanId: string): Promise<RuntimeChainSpan | null> {
    return this.spanMutex.run(spanId, async () => {
      return (
        (await readJsonFile<RuntimeChainSpan>(this.byIdFilePath(spanId))) ??
        (await readJsonFile<RuntimeChainSpan>(this.legacyFlatFilePath(spanId)))
      );
    });
  }

  async put(span: RuntimeChainSpan, options?: { expectedVersion?: number | undefined }): Promise<void> {
    await this.chainMutex.run(span.chainId, async () => {
      await this.spanMutex.run(span.spanId, async () => {
        const byIdPath = this.byIdFilePath(span.spanId);
        const chainPath = this.chainFilePath(span.chainId, span.spanId);
        const existing =
          (await readJsonFile<RuntimeChainSpan>(byIdPath)) ??
          (await readJsonFile<RuntimeChainSpan>(this.legacyFlatFilePath(span.spanId)));
        const existingVersion = existing?.version ?? 0;
        if (options?.expectedVersion != null && existingVersion !== options.expectedVersion) {
          throw new Error(
            `runtime chain span version conflict for ${span.spanId}: expected ${options.expectedVersion}, found ${existingVersion}`
          );
        }
        const byIdExisted = await fileExists(byIdPath);
        const next = {
          ...span,
          version: existingVersion + 1,
        } satisfies RuntimeChainSpan;
        await writeJsonFileAtomic(byIdPath, next);
        try {
          await writeJsonFileAtomic(chainPath, next);
        } catch (error) {
          if (!byIdExisted) {
            await removeFileIfExists(byIdPath);
          }
          await removeFileIfExists(chainPath);
          throw error;
        }
      });
    });
  }

  async listByChain(chainId: string): Promise<RuntimeChainSpan[]> {
    return this.chainMutex.run(chainId, async () => {
      const chainFilePaths = await listJsonFiles(this.chainDir(chainId));
      const records = await Promise.all(chainFilePaths.map((filePath) => readJsonFile<RuntimeChainSpan>(filePath)));
      const chainScoped = records.filter((record): record is RuntimeChainSpan => record !== null);
      if (chainScoped.length > 0) {
        return chainScoped.sort((left, right) => left.createdAt - right.createdAt);
      }

      const legacyFilePaths = await listJsonFiles(this.rootDir);
      const legacyRecords = await Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RuntimeChainSpan>(filePath)));
      return legacyRecords
        .filter((record): record is RuntimeChainSpan => record !== null && record.chainId === chainId)
        .sort((left, right) => left.createdAt - right.createdAt);
    });
  }

  async listAll(): Promise<RuntimeChainSpan[]> {
    const byIdFilePaths = await listJsonFiles(path.join(this.rootDir, "by-id"));
    if (byIdFilePaths.length > 0) {
      const records = await Promise.all(byIdFilePaths.map((filePath) => readJsonFile<RuntimeChainSpan>(filePath)));
      return records
        .filter((record): record is RuntimeChainSpan => record !== null)
        .sort((left, right) => left.createdAt - right.createdAt);
    }

    const legacyFilePaths = await listJsonFiles(this.rootDir);
    const records = await Promise.all(legacyFilePaths.map((filePath) => readJsonFile<RuntimeChainSpan>(filePath)));
    return records
      .filter((record): record is RuntimeChainSpan => record !== null)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  private byIdFilePath(spanId: string): string {
    return path.join(this.rootDir, "by-id", `${sanitizeSpanId(spanId)}.json`);
  }

  private chainDir(chainId: string): string {
    return path.join(this.rootDir, "chains", sanitizeChainId(chainId));
  }

  private chainFilePath(chainId: string, spanId: string): string {
    return path.join(this.chainDir(chainId), `${sanitizeSpanId(spanId)}.json`);
  }

  private legacyFlatFilePath(spanId: string): string {
    return path.join(this.rootDir, `${sanitizeSpanId(spanId)}.json`);
  }
}

function sanitizeChainId(chainId: string): string {
  return chainId.replace(/[^a-z0-9._:-]+/gi, "_");
}

function sanitizeSpanId(spanId: string): string {
  return spanId.replace(/[^a-z0-9._:-]+/gi, "_");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
