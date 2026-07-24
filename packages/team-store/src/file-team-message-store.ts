import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import type {
  MessageId,
  TeamMessage,
  TeamMessageAppendIfAbsentResult,
  TeamMessageStore,
  ThreadId,
} from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileTeamMessageStoreOptions {
  rootDir: string;
}

export class FileTeamMessageStore implements TeamMessageStore {
  private readonly rootDir: string;
  private readonly threadMutex = new KeyedAsyncMutex<ThreadId>();
  private readonly idMutex = new KeyedAsyncMutex<MessageId>();
  private legacyByIdBackfillPromise: Promise<void> | null = null;

  constructor(options: FileTeamMessageStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async append(message: TeamMessage): Promise<void> {
    await this.withThreadLock(message.threadId, async () => {
      await this.appendUnlocked(message);
    });
  }

  async appendIfAbsent(message: TeamMessage): Promise<TeamMessageAppendIfAbsentResult> {
    // The id-level lock serializes redundant outbox redeliveries of the same
    // message within this process. The thread-level lock inside `appendUnlocked`
    // serializes per-thread file IO. Together they make the get-then-write
    // check-then-act safe for at-least-once delivery callers.
    return this.idMutex.run(message.id, async () => {
      // Route through `get()` rather than reading the by-id projection directly:
      // legacy thread-files (pre-journal upgrade) only surface a message after
      // backfillLegacyByIdProjectionsOnce has run, and a redelivered outbox
      // intent for one of those messages must observe it as existing.
      const existing = await this.get(message.id);
      if (existing) {
        if (existing.threadId !== message.threadId) {
          return {
            written: false,
            existing,
            threadIdConflict: { existing: existing.threadId, requested: message.threadId },
          };
        }
        return { written: false, existing };
      }
      // We just observed no by-id projection; pass that knowledge into the
      // unlocked write so it doesn't re-read the same file.
      await this.withThreadLock(message.threadId, async () => {
        await this.appendUnlocked(message, null);
      });
      return { written: true };
    });
  }

  private async appendUnlocked(message: TeamMessage, existingProjection?: TeamMessage | null): Promise<void> {
    const byIdPath = this.byIdFilePath(message.id);
    const projection =
      existingProjection !== undefined ? existingProjection : await readJsonFile<TeamMessage>(byIdPath);
    const normalizedMessage =
      projection?.threadId === message.threadId && message.createdAt !== projection.createdAt
        ? { ...message, createdAt: projection.createdAt }
        : message;
    const entryPath = this.entryFilePath(normalizedMessage.threadId, normalizedMessage);
    if (projection?.threadId === normalizedMessage.threadId && normalizedMessage.updatedAt < projection.updatedAt) {
      return;
    }
    const shouldUpdateProjection = !projection || normalizedMessage.updatedAt >= projection.updatedAt;
    const supersededEntryPath =
      shouldUpdateProjection && projection?.threadId === normalizedMessage.threadId
        ? this.entryFilePath(projection.threadId, projection)
        : null;

    let entryWritten = false;
    try {
      await writeJsonFileAtomic(entryPath, normalizedMessage);
      entryWritten = true;
      if (shouldUpdateProjection) {
        await writeJsonFileAtomic(byIdPath, normalizedMessage);
      }
    } catch (error) {
      if (entryWritten) {
        await removeFileIfExists(entryPath);
      }
      throw error;
    }
    if (supersededEntryPath && supersededEntryPath !== entryPath) {
      await removeFileIfExists(supersededEntryPath);
    }
  }

  async list(threadId: ThreadId, limit?: number): Promise<TeamMessage[]> {
    const messages = await this.readThreadMessages(threadId);
    if (limit == null) {
      return messages;
    }
    return messages.slice(-limit);
  }

  async listAfter(
    threadId: ThreadId,
    afterMessageId: MessageId | null,
    limit: number,
  ): Promise<TeamMessage[]> {
    const boundedLimit = Math.max(0, Math.floor(limit));
    if (boundedLimit === 0) {
      return [];
    }
    // Build the ordered index from entry-file NAMES (a single readdir) plus
    // the legacy array, without reading each entry's contents — that read
    // is the O(N) cost we are avoiding per drain.
    const index = await this.buildThreadIndex(threadId);
    const startIndex =
      afterMessageId === null
        ? 0
        : index.findIndex((ref) => ref.id === afterMessageId) + 1;
    // findIndex returns -1 (start 0) when the anchor was pruned/unknown, so
    // resumption re-emits from the beginning; downstream extraction is
    // idempotent, so this never loses events.
    const slice = index.slice(startIndex, startIndex + boundedLimit);
    const materialized = await Promise.all(
      slice.map((ref) => this.materializeEntry(ref)),
    );
    return materialized.filter(
      (message): message is TeamMessage => message !== null,
    );
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
    const index = await this.buildThreadIndex(threadId);
    const materialized = await Promise.all(
      index.map((ref) => this.materializeEntry(ref)),
    );
    return materialized.filter(
      (message): message is TeamMessage => message !== null,
    );
  }

  /**
   * Ordered, de-duplicated index of a thread's messages built from entry
   * filenames (which encode createdAt-updatedAt-id) plus the legacy array,
   * without reading each entry's contents. Ordering matches the historical
   * (createdAt, updatedAt, id) sort so `list` stays behavior-identical.
   */
  private async buildThreadIndex(threadId: ThreadId): Promise<ThreadEntryRef[]> {
    const [legacyMessages, entryNames] = await Promise.all([
      readJsonFile<TeamMessage[]>(this.filePath(threadId), {
        onCorruption: "quarantine",
      }),
      this.listEntryNames(threadId),
    ]);
    const byId = new Map<MessageId, ThreadEntryRef>();
    const consider = (ref: ThreadEntryRef): void => {
      const existing = byId.get(ref.id);
      if (!existing || ref.updatedAt >= existing.updatedAt) {
        byId.set(ref.id, ref);
      }
    };
    for (const message of legacyMessages ?? []) {
      consider({
        id: message.id,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        legacy: message,
      });
    }
    for (const name of entryNames) {
      const parsed = parseEntryName(name);
      if (!parsed) continue;
      consider({
        ...parsed,
        entryPath: path.join(this.entryDir(threadId), name),
      });
    }
    return [...byId.values()].sort(compareEntryRefs);
  }

  private async materializeEntry(
    ref: ThreadEntryRef,
  ): Promise<TeamMessage | null> {
    if (ref.entryPath) {
      // The entry file is authoritative; its contents win over any stale
      // legacy copy carrying the same id.
      const message = await readJsonFile<TeamMessage>(ref.entryPath, {
        onCorruption: "quarantine",
      });
      if (message) return message;
    }
    return ref.legacy ?? null;
  }

  private async listEntryNames(threadId: ThreadId): Promise<string[]> {
    const dir = this.entryDir(threadId);
    await mkdir(dir, { recursive: true });
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
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

interface ThreadEntryRef {
  id: MessageId;
  createdAt: number;
  updatedAt: number;
  entryPath?: string;
  legacy?: TeamMessage;
}

/**
 * Parse an entry filename of the form
 * `<createdAt padStart16>-<updatedAt padStart16>-<encodeURIComponent(id)>.json`.
 * Message ids may themselves contain `-` (encodeURIComponent leaves it
 * intact), so only the first two `-`-delimited fields are timestamps and
 * the remainder rejoins to the encoded id.
 */
function parseEntryName(
  name: string,
): { id: MessageId; createdAt: number; updatedAt: number } | null {
  if (!name.endsWith(".json")) return null;
  const base = name.slice(0, -".json".length);
  const parts = base.split("-");
  if (parts.length < 3) return null;
  const createdAt = Number(parts[0]);
  const updatedAt = Number(parts[1]);
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return null;
  const encodedId = parts.slice(2).join("-");
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    return null;
  }
  return { id: id as MessageId, createdAt, updatedAt };
}

function compareEntryRefs(left: ThreadEntryRef, right: ThreadEntryRef): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt - right.updatedAt;
  }
  return left.id.localeCompare(right.id);
}

async function readFileList(rootDir: string): Promise<string[]> {
  return readdir(rootDir);
}

async function readDirectoryList(rootDir: string) {
  return readdir(rootDir, { withFileTypes: true });
}
