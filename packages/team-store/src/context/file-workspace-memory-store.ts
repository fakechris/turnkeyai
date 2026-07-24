import path from "node:path";
import { createHash } from "node:crypto";

import type {
  DurableMemoryRecord,
  MemoryPlane,
  MemorySearchIndex,
  MemoryScope,
  WorkspaceMemoryAuditRecord,
  WorkspaceMemoryMutation,
  WorkspaceMemorySnapshot,
  WorkspaceMemoryStore,
} from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import {
  listJsonFiles,
  readJsonFile,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";

const MAX_AUDITS = 100;
const DEFAULT_MAX_RECORDS_PER_WORKSPACE = 500;

export class FileWorkspaceMemoryStore implements WorkspaceMemoryStore {
  private readonly rootDir: string;
  private readonly mutex = new KeyedAsyncMutex<string>();
  private readonly index: MemorySearchIndex | undefined;
  private readonly now: () => number;
  private readonly maxRecords: number;

  constructor(options: {
    rootDir: string;
    index?: MemorySearchIndex;
    now?: () => number;
    maxRecordsPerWorkspace?: number;
  }) {
    this.rootDir = options.rootDir;
    this.index = options.index;
    this.now = options.now ?? (() => Date.now());
    this.maxRecords =
      options.maxRecordsPerWorkspace ?? DEFAULT_MAX_RECORDS_PER_WORKSPACE;
  }

  async getSnapshot(workspaceId: string): Promise<WorkspaceMemorySnapshot> {
    return (
      await readJsonFile<WorkspaceMemorySnapshot>(
        this.snapshotPath(workspaceId),
        { onCorruption: "quarantine" },
      )
    ) ?? emptySnapshot(workspaceId);
  }

  async get(memoryId: string): Promise<DurableMemoryRecord | null> {
    const files = await listJsonFiles(this.rootDir);
    for (const file of files) {
      // One corrupt workspace file must not fail lookups across every
      // other workspace; quarantine it and keep scanning.
      const snapshot = await readJsonFile<WorkspaceMemorySnapshot>(file, {
        onCorruption: "quarantine",
      });
      const record = snapshot?.records.find(
        (candidate) => candidate.memoryId === memoryId,
      );
      if (record) return record;
    }
    return null;
  }

  async list(
    scope: MemoryScope,
    plane?: MemoryPlane,
  ): Promise<DurableMemoryRecord[]> {
    const snapshot = await this.getSnapshot(scope.workspaceId);
    const now = this.now();
    return snapshot.records.filter((record) =>
      !isExpiredRecord(record, now) &&
      sameOrNarrowerScope(record.scope, scope) &&
      (plane === undefined || record.plane === plane)
    );
  }

  async reconcileIndex(): Promise<void> {
    if (!this.index) return;
    const records: DurableMemoryRecord[] = [];
    for (const file of await listJsonFiles(this.rootDir)) {
      const snapshot = await readJsonFile<WorkspaceMemorySnapshot>(file, {
        onCorruption: "quarantine",
      });
      if (snapshot) records.push(...snapshot.records);
    }
    await this.index.rebuild(records);
  }

  async commit(input: {
    workspaceId: string;
    expectedLastSequence: number;
    cursor: WorkspaceMemorySnapshot["cursor"];
    audit: WorkspaceMemoryAuditRecord;
    mutations: WorkspaceMemoryMutation[];
  }): Promise<WorkspaceMemorySnapshot> {
    return this.mutex.run(input.workspaceId, async () => {
      const current = await this.getSnapshot(input.workspaceId);
      if (current.cursor.lastSequence !== input.expectedLastSequence) {
        throw new Error(
          `workspace memory cursor conflict: expected ${input.expectedLastSequence}, found ${current.cursor.lastSequence}`,
        );
      }
      if (
        input.cursor.workspaceId !== input.workspaceId ||
        input.cursor.lastSequence < current.cursor.lastSequence
      ) {
        throw new Error("invalid workspace memory cursor");
      }
      const records = new Map(
        current.records.map((record) => [record.memoryId, record]),
      );
      const rejected = [...input.audit.rejectedMutations];
      const applied: WorkspaceMemoryMutation[] = [];
      for (const mutation of input.mutations) {
        const reason = mutationRejectionReason(
          mutation,
          records,
          input.workspaceId,
        );
        if (reason) {
          rejected.push({ mutation, reason });
          continue;
        }
        applyMutation(mutation, records);
        applied.push(mutation);
      }
      // Lifecycle passes over the post-mutation record set: fold near
      // duplicates into a single re-confirmed record, drop expired
      // records, then evict lowest-value records to stay within the cap.
      const now = this.now();
      const deduped = mergeNearDuplicateRecords(records);
      const expired = dropExpiredRecords(records, now);
      const evicted = enforceRecordCapacity(records, this.maxRecords);
      const audit: WorkspaceMemoryAuditRecord = {
        ...input.audit,
        mutations: applied,
        rejectedMutations: rejected,
        beforeDigest: recordsDigest(current.records),
        afterDigest: recordsDigest([...records.values()]),
        status:
          applied.length > 0
            ? "written"
            : input.audit.status === "failed"
              ? "failed"
              : "noop",
        ...(expired.length > 0 ? { expired } : {}),
        ...(evicted.length > 0 ? { evicted } : {}),
        ...(deduped.length > 0 ? { deduped } : {}),
      };
      const next: WorkspaceMemorySnapshot = {
        workspaceId: input.workspaceId,
        records: [...records.values()].sort((left, right) =>
          left.memoryId.localeCompare(right.memoryId)
        ),
        cursor: structuredClone(input.cursor),
        audits: [...current.audits, audit].slice(-MAX_AUDITS),
      };
      // Authoritative memory: fsync so a power loss cannot silently reset
      // a workspace's records and cursor to empty.
      await writeJsonFileAtomic(
        this.snapshotPath(input.workspaceId),
        next,
        { durability: "strict" },
      );
      try {
        await this.index?.replaceWorkspace(
          input.workspaceId,
          next.records,
        );
      } catch (error) {
        console.error("workspace memory index update failed", {
          workspaceId: input.workspaceId,
          error,
        });
      }
      return next;
    });
  }

  private snapshotPath(workspaceId: string): string {
    return path.join(
      this.rootDir,
      `${encodeURIComponent(workspaceId)}.json`,
    );
  }
}

function recordsDigest(records: DurableMemoryRecord[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...records]
          .sort((left, right) =>
            left.memoryId.localeCompare(right.memoryId)
          )
          .map((record) => ({
            memoryId: record.memoryId,
            content: record.content,
            confidence: record.confidence,
            sourceRefs: record.sourceRefs,
            invalidationKeys: record.invalidationKeys,
          })),
      ),
    )
    .digest("hex");
}

function emptySnapshot(workspaceId: string): WorkspaceMemorySnapshot {
  return {
    workspaceId,
    records: [],
    cursor: {
      workspaceId,
      lastSequence: 0,
      updatedAt: 0,
    },
    audits: [],
  };
}

function mutationRejectionReason(
  mutation: WorkspaceMemoryMutation,
  records: Map<string, DurableMemoryRecord>,
  workspaceId: string,
): string | null {
  if (mutation.kind === "delete") {
    const target = records.get(mutation.memoryId);
    if (!target) return "target_not_found";
    if (
      target.confidence === "authoritative" &&
      !mutation.sourceRefs.some((ref) => ref.startsWith("user:"))
    ) {
      return "authoritative_memory_requires_user_source";
    }
    return null;
  }
  const record = mutation.record;
  if (
    record.scope.workspaceId !== workspaceId ||
    record.plane !== "workspace"
  ) {
    return "writer_scope_escape";
  }
  if (
    !record.memoryId ||
    !record.content.trim() ||
    record.sourceRefs.length === 0
  ) {
    return "incomplete_memory_record";
  }
  const supersededIds =
    mutation.kind === "supersede"
      ? mutation.supersedes
      : record.supersedes;
  for (const memoryId of supersededIds) {
    const target = records.get(memoryId);
    if (!target) continue;
    if (
      target.confidence === "authoritative" &&
      record.confidence !== "authoritative"
    ) {
      return "inferred_memory_cannot_supersede_authoritative";
    }
  }
  return null;
}

function applyMutation(
  mutation: WorkspaceMemoryMutation,
  records: Map<string, DurableMemoryRecord>,
): void {
  if (mutation.kind === "delete") {
    records.delete(mutation.memoryId);
    return;
  }
  const supersededIds =
    mutation.kind === "supersede"
      ? mutation.supersedes
      : mutation.record.supersedes;
  for (const memoryId of supersededIds) records.delete(memoryId);
  records.set(mutation.record.memoryId, structuredClone(mutation.record));
}

function isExpiredRecord(record: DurableMemoryRecord, now: number): boolean {
  return record.expiresAt !== undefined && record.expiresAt <= now;
}

function dropExpiredRecords(
  records: Map<string, DurableMemoryRecord>,
  now: number,
): string[] {
  const dropped: string[] = [];
  for (const [memoryId, record] of records) {
    if (isExpiredRecord(record, now)) {
      records.delete(memoryId);
      dropped.push(memoryId);
    }
  }
  return dropped;
}

const CONFIDENCE_RANK: Record<DurableMemoryRecord["confidence"], number> = {
  inferred: 0,
  confirmed: 1,
  authoritative: 2,
};

function normalizeMemoryContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Fold records with identical normalized content in the same thread scope
 * into a single survivor (highest confidence, then most recently
 * confirmed), bumping the survivor's lastConfirmedAt to the group maximum
 * so a restated fact reads as a re-confirmation instead of a duplicate.
 * Returns the memory ids that were folded away.
 */
function mergeNearDuplicateRecords(
  records: Map<string, DurableMemoryRecord>,
): string[] {
  const groups = new Map<string, DurableMemoryRecord[]>();
  for (const record of records.values()) {
    const key = `${record.scope.workspaceId} ${record.scope.threadId ?? ""} ${normalizeMemoryContent(record.content)}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const folded: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const survivor = group.reduce((best, candidate) =>
      CONFIDENCE_RANK[candidate.confidence] > CONFIDENCE_RANK[best.confidence] ||
      (CONFIDENCE_RANK[candidate.confidence] === CONFIDENCE_RANK[best.confidence] &&
        candidate.lastConfirmedAt > best.lastConfirmedAt)
        ? candidate
        : best
    );
    survivor.lastConfirmedAt = Math.max(
      ...group.map((record) => record.lastConfirmedAt),
    );
    for (const record of group) {
      if (record.memoryId !== survivor.memoryId) {
        records.delete(record.memoryId);
        folded.push(record.memoryId);
      }
    }
  }
  return folded;
}

/**
 * Keep the workspace within its record cap by evicting the lowest-value
 * non-authoritative records (lowest confidence, then oldest confirmation).
 * Authoritative records are never auto-evicted; they can only leave via a
 * user-sourced supersede/delete.
 */
function enforceRecordCapacity(
  records: Map<string, DurableMemoryRecord>,
  cap: number,
): string[] {
  if (records.size <= cap) return [];
  const evictable = [...records.values()]
    .filter((record) => record.confidence !== "authoritative")
    .sort((left, right) =>
      CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence] ||
      left.lastConfirmedAt - right.lastConfirmedAt ||
      left.memoryId.localeCompare(right.memoryId)
    );
  const evicted: string[] = [];
  for (const record of evictable) {
    if (records.size <= cap) break;
    records.delete(record.memoryId);
    evicted.push(record.memoryId);
  }
  return evicted;
}

function sameOrNarrowerScope(
  record: MemoryScope,
  query: MemoryScope,
): boolean {
  return record.workspaceId === query.workspaceId &&
    (query.threadId === undefined || record.threadId === query.threadId) &&
    (query.roleId === undefined || record.roleId === query.roleId);
}
