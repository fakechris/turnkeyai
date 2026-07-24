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

export class FileWorkspaceMemoryStore implements WorkspaceMemoryStore {
  private readonly rootDir: string;
  private readonly mutex = new KeyedAsyncMutex<string>();
  private readonly index: MemorySearchIndex | undefined;

  constructor(options: {
    rootDir: string;
    index?: MemorySearchIndex;
  }) {
    this.rootDir = options.rootDir;
    this.index = options.index;
  }

  async getSnapshot(workspaceId: string): Promise<WorkspaceMemorySnapshot> {
    return (
      await readJsonFile<WorkspaceMemorySnapshot>(
        this.snapshotPath(workspaceId),
      )
    ) ?? emptySnapshot(workspaceId);
  }

  async get(memoryId: string): Promise<DurableMemoryRecord | null> {
    const files = await listJsonFiles(this.rootDir);
    for (const file of files) {
      const snapshot = await readJsonFile<WorkspaceMemorySnapshot>(file);
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
    return snapshot.records.filter((record) =>
      sameOrNarrowerScope(record.scope, scope) &&
      (plane === undefined || record.plane === plane)
    );
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
      };
      const next: WorkspaceMemorySnapshot = {
        workspaceId: input.workspaceId,
        records: [...records.values()].sort((left, right) =>
          left.memoryId.localeCompare(right.memoryId)
        ),
        cursor: structuredClone(input.cursor),
        audits: [...current.audits, audit].slice(-MAX_AUDITS),
      };
      await writeJsonFileAtomic(
        this.snapshotPath(input.workspaceId),
        next,
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

function sameOrNarrowerScope(
  record: MemoryScope,
  query: MemoryScope,
): boolean {
  return record.workspaceId === query.workspaceId &&
    (query.threadId === undefined || record.threadId === query.threadId) &&
    (query.roleId === undefined || record.roleId === query.roleId);
}
