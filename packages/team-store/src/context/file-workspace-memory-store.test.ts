import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  DurableMemoryRecord,
  WorkspaceMemoryAuditRecord,
} from "@turnkeyai/core-types/team";

import { FileWorkspaceMemoryStore } from "./file-workspace-memory-store";

function record(
  memoryId: string,
  confidence: DurableMemoryRecord["confidence"],
  content = memoryId,
): DurableMemoryRecord {
  return {
    memoryId,
    plane: "workspace",
    scope: { workspaceId: "workspace-1", threadId: "thread-1" },
    content,
    sourceRefs: [`user:${memoryId}`],
    createdBy: confidence === "authoritative" ? "user" : "memory-writer",
    confidence,
    createdAt: 100,
    lastConfirmedAt: 100,
    supersedes: [],
    invalidationKeys: ["preferred-format"],
  };
}

function audit(
  auditId: string,
): WorkspaceMemoryAuditRecord {
  return {
    auditId,
    workspaceId: "workspace-1",
    trigger: "manual",
    sourceEventIds: ["event-1"],
    mutations: [],
    rejectedMutations: [],
    beforeDigest: createHash("sha256").update("before").digest("hex"),
    afterDigest: createHash("sha256").update("after").digest("hex"),
    startedAt: 100,
    completedAt: 101,
    status: "written",
  };
}

async function store() {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "turnkeyai-workspace-memory-"),
  );
  return new FileWorkspaceMemoryStore({ rootDir });
}

test("workspace memory store commits mutations and cursor atomically", async () => {
  const memoryStore = await store();
  const snapshot = await memoryStore.commit({
    workspaceId: "workspace-1",
    expectedLastSequence: 0,
    cursor: {
      workspaceId: "workspace-1",
      lastSequence: 1,
      lastEventId: "event-1",
      updatedAt: 101,
    },
    audit: audit("audit-1"),
    mutations: [{ kind: "add", record: record("memory-1", "authoritative") }],
  });

  assert.equal(snapshot.records[0]?.memoryId, "memory-1");
  assert.equal(snapshot.cursor.lastSequence, 1);
  assert.equal(snapshot.audits[0]?.status, "written");
});

test("workspace memory store rejects inferred supersession of user authority", async () => {
  const memoryStore = await store();
  await memoryStore.commit({
    workspaceId: "workspace-1",
    expectedLastSequence: 0,
    cursor: {
      workspaceId: "workspace-1",
      lastSequence: 1,
      updatedAt: 101,
    },
    audit: audit("audit-1"),
    mutations: [{ kind: "add", record: record("memory-1", "authoritative") }],
  });
  const replacement = {
    ...record("memory-2", "inferred", "agent guessed replacement"),
    sourceRefs: ["runtime:event-2"],
    supersedes: ["memory-1"],
  };
  const snapshot = await memoryStore.commit({
    workspaceId: "workspace-1",
    expectedLastSequence: 1,
    cursor: {
      workspaceId: "workspace-1",
      lastSequence: 2,
      updatedAt: 102,
    },
    audit: { ...audit("audit-2"), sourceEventIds: ["event-2"] },
    mutations: [{
      kind: "supersede",
      record: replacement,
      supersedes: ["memory-1"],
    }],
  });

  assert.equal(snapshot.records[0]?.memoryId, "memory-1");
  assert.match(
    snapshot.audits.at(-1)?.rejectedMutations[0]?.reason ?? "",
    /cannot_supersede_authoritative/,
  );
});

test("workspace memory store enforces cursor compare-and-set", async () => {
  const memoryStore = await store();
  await assert.rejects(
    memoryStore.commit({
      workspaceId: "workspace-1",
      expectedLastSequence: 1,
      cursor: {
        workspaceId: "workspace-1",
        lastSequence: 2,
        updatedAt: 102,
      },
      audit: audit("audit-1"),
      mutations: [],
    }),
    /cursor conflict/,
  );
});
