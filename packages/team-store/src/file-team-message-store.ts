import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import type { MessageId, TeamMessage, TeamMessageStore, ThreadId } from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileTeamMessageStoreOptions {
  rootDir: string;
}

export class FileTeamMessageStore implements TeamMessageStore {
  private readonly rootDir: string;
  private readonly threadMutex = new KeyedAsyncMutex<ThreadId>();
  private legacyByIdBackfillPromise: Promise<void> | null = null;

  constructor(options: FileTeamMessageStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async append(message: TeamMessage): Promise<void> {
    await this.withThreadLock(message.threadId, async () => {
      const entryPath = this.entryFilePath(message.threadId, message);
      const byIdPath = this.byIdFilePath(message.id);
      const existingProjection = await readJsonFile<TeamMessage>(byIdPath);
      const shouldUpdateProjection = !existingProjection || message.updatedAt >= existingProjection.updatedAt;

      let entryWritten = false;
      try {
        await writeJsonFileAtomic(entryPath, message);
        entryWritten = true;
        if (shouldUpdateProjection) {
          await writeJsonFileAtomic(byIdPath, message);
        }
      } catch (error) {
        if (entryWritten) {
          await removeFileIfExists(entryPath);
        }
        throw error;
      }
    });
  }

  async list(threadId: ThreadId, limit?: number): Promise<TeamMessage[]> {
    const messages = await this.readThreadMessages(threadId);
    if (limit == null) {
      return messages;
    }
    return messages.slice(-limit);
  }

  async get(messageId: MessageId): Promise<TeamMessage | null> {
    const projected = await readJsonFile<TeamMessage>(this.byIdFilePath(messageId));
    if (projected) {
      return projected;
    }

    await this.backfillLegacyByIdProjectionsOnce();
    return readJsonFile<TeamMessage>(this.byIdFilePath(messageId));
  }

  private async listThreadIds(): Promise<ThreadId[]> {
    await mkdir(this.rootDir, { recursive: true });
    const legacyThreadIds = (await readFileList(this.rootDir))
      .filter((name) => name.endsWith(".json"))
      .map((name) => decodeURIComponent(name.replace(/\.json$/, "")));
    const threadRoot = this.threadRootDir();
    await mkdir(threadRoot, { recursive: true });
    const journalThreadIds = (await readDirectoryList(threadRoot))
      .filter((entry) => entry.isDirectory())
      .map((entry) => decodeURIComponent(entry.name));
    return [...new Set([...legacyThreadIds, ...journalThreadIds])];
  }

  private filePath(threadId: ThreadId): string {
    return path.join(this.rootDir, `${encodeURIComponent(threadId)}.json`);
  }

  private async readThreadMessages(threadId: ThreadId): Promise<TeamMessage[]> {
    const [legacyMessages, entryPaths] = await Promise.all([
      readJsonFile<TeamMessage[]>(this.filePath(threadId)),
      listJsonFiles(this.entryDir(threadId)),
    ]);
    const journalMessages = (
      await Promise.all(entryPaths.map((filePath) => readJsonFile<TeamMessage>(filePath)))
    ).filter((message): message is TeamMessage => message !== null);
    const merged = new Map<MessageId, TeamMessage>();
    for (const message of [...(legacyMessages ?? []), ...journalMessages]) {
      const existing = merged.get(message.id);
      if (!existing || message.updatedAt >= existing.updatedAt) {
        merged.set(message.id, message);
      }
    }
    return [...merged.values()].sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
      }
      if (left.updatedAt !== right.updatedAt) {
        return left.updatedAt - right.updatedAt;
      }
      return left.id.localeCompare(right.id);
    });
  }

  private async withThreadLock<T>(threadId: ThreadId, work: () => Promise<T>): Promise<T> {
    return this.threadMutex.run(threadId, work);
  }

  private threadRootDir(): string {
    return path.join(this.rootDir, "threads");
  }

  private byIdDir(): string {
    return path.join(this.rootDir, "by-id");
  }

  private byIdFilePath(messageId: MessageId): string {
    return path.join(this.byIdDir(), `${encodeURIComponent(messageId)}.json`);
  }

  private threadDir(threadId: ThreadId): string {
    return path.join(this.threadRootDir(), encodeURIComponent(threadId));
  }

  private entryDir(threadId: ThreadId): string {
    return path.join(this.threadDir(threadId), "entries");
  }

  private entryFilePath(threadId: ThreadId, message: TeamMessage): string {
    const createdAt = String(message.createdAt).padStart(16, "0");
    const updatedAt = String(message.updatedAt).padStart(16, "0");
    const messageId = encodeURIComponent(message.id);
    return path.join(this.entryDir(threadId), `${createdAt}-${updatedAt}-${messageId}.json`);
  }

  private async backfillByIdProjection(message: TeamMessage): Promise<void> {
    await this.withThreadLock(message.threadId, async () => {
      const byIdPath = this.byIdFilePath(message.id);
      const existingProjection = await readJsonFile<TeamMessage>(byIdPath);
      if (existingProjection && existingProjection.updatedAt >= message.updatedAt) {
        return;
      }
      await writeJsonFileAtomic(byIdPath, message);
    });
  }

  private async backfillLegacyByIdProjectionsOnce(): Promise<void> {
    if (!this.legacyByIdBackfillPromise) {
      this.legacyByIdBackfillPromise = this.backfillLegacyByIdProjections();
    }
    return this.legacyByIdBackfillPromise;
  }

  private async backfillLegacyByIdProjections(): Promise<void> {
    const markerPath = this.legacyBackfillMarkerPath();
    const marker = await readJsonFile<{ completedAt: number }>(markerPath);
    if (marker) {
      return;
    }
    const legacyThreadPaths = await listJsonFiles(this.rootDir);
    for (const filePath of legacyThreadPaths) {
      const messages = await readJsonFile<TeamMessage[]>(filePath);
      for (const message of messages ?? []) {
        await this.backfillByIdProjection(message);
      }
    }
    await writeJsonFileAtomic(markerPath, { completedAt: Date.now() });
  }

  private legacyBackfillMarkerPath(): string {
    return path.join(this.rootDir, ".migration", "legacy-by-id-backfill-complete");
  }
}

async function readFileList(rootDir: string): Promise<string[]> {
  return readdir(rootDir);
}

async function readDirectoryList(rootDir: string) {
  return readdir(rootDir, { withFileTypes: true });
}
