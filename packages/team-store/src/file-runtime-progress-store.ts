import path from "node:path";

import type { RuntimeProgressEvent, RuntimeProgressStore, ThreadId } from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileRuntimeProgressStoreOptions {
  rootDir: string;
}

function sanitize(value: string): string {
  return encodeURIComponent(value);
}

export class FileRuntimeProgressStore implements RuntimeProgressStore {
  private readonly rootDir: string;
  private readonly writeMutex = new KeyedAsyncMutex<string>();

  constructor(options: FileRuntimeProgressStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async append(event: RuntimeProgressEvent): Promise<void> {
    const eventPath = this.filePathForEvent(event.threadId, event.progressId);
    const threadPath = this.threadScopedFilePath(event.threadId, event.progressId);
    const chainPath = event.chainId ? this.chainScopedFilePath(event.chainId, event.progressId) : null;
    await this.writeMutex.run(event.progressId, async () => {
      await writeJsonFileAtomic(eventPath, event);
      try {
        await writeJsonFileAtomic(threadPath, event);
        if (chainPath) {
          await writeJsonFileAtomic(chainPath, event);
        }
      } catch (error) {
        await removeFileIfExists(threadPath);
        if (chainPath) {
          await removeFileIfExists(chainPath);
        }
        throw error;
      }
    });
  }

  async listByThread(threadId: ThreadId, limit = 50): Promise<RuntimeProgressEvent[]> {
    return this.listFromDir(this.threadDir(threadId), limit);
  }

  async listByChain(chainId: string, limit = 50): Promise<RuntimeProgressEvent[]> {
    return this.listFromDir(this.chainDir(chainId), limit);
  }

  private async listFromDir(dir: string, limit: number): Promise<RuntimeProgressEvent[]> {
    const files = await listJsonFiles(dir);
    const events = (
      await Promise.all(files.map(async (filePath) => readJsonFile<RuntimeProgressEvent>(filePath)))
    ).filter((value): value is RuntimeProgressEvent => value != null);
    return events
      .sort((left, right) => left.recordedAt - right.recordedAt)
      .slice(-Math.max(limit, 1));
  }

  private eventDir(): string {
    return path.join(this.rootDir, "events");
  }

  private threadDir(threadId: string): string {
    return path.join(this.rootDir, "by-thread", sanitize(threadId));
  }

  private chainDir(chainId: string): string {
    return path.join(this.rootDir, "by-chain", sanitize(chainId));
  }

  private filePathForEvent(threadId: string, progressId: string): string {
    return path.join(this.eventDir(), sanitize(threadId), `${sanitize(progressId)}.json`);
  }

  private threadScopedFilePath(threadId: string, progressId: string): string {
    return path.join(this.threadDir(threadId), `${sanitize(progressId)}.json`);
  }

  private chainScopedFilePath(chainId: string, progressId: string): string {
    return path.join(this.chainDir(chainId), `${sanitize(progressId)}.json`);
  }
}
