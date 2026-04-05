import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

import { FileFlowLedgerStore } from "./file-flow-ledger-store";

test("file flow ledger store assigns and increments projection versions", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-flow-ledger-store-"));
  try {
    const store = new FileFlowLedgerStore({ rootDir });
    await store.put({
      flowId: "flow-1",
      threadId: "thread-1",
      rootMessageId: "message-1",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: ["lead"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 0,
      maxHops: 5,
      edges: [],
      createdAt: 10,
      updatedAt: 10,
    });

    const created = await store.get("flow-1");
    assert.equal(created?.version, 1);

    await store.put({
      ...created!,
      status: "completed",
      activeRoleIds: [],
      completedRoleIds: ["lead"],
      updatedAt: 20,
    });

    const updated = await store.get("flow-1");
    assert.equal(updated?.version, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file flow ledger store backfills version for legacy records", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-flow-ledger-legacy-"));
  try {
    await writeJsonFileAtomic(path.join(rootDir, "flow-legacy.json"), {
      flowId: "flow-legacy",
      threadId: "thread-1",
      rootMessageId: "message-1",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: ["lead"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 0,
      maxHops: 5,
      edges: [],
      createdAt: 10,
      updatedAt: 10,
    });

    const store = new FileFlowLedgerStore({ rootDir });
    const flow = await store.get("flow-legacy");
    assert.equal(flow?.version, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file flow ledger store rejects stale expected versions", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-flow-ledger-conflict-"));
  try {
    const store = new FileFlowLedgerStore({ rootDir });
    await store.put({
      flowId: "flow-1",
      threadId: "thread-1",
      rootMessageId: "message-1",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: ["lead"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 0,
      maxHops: 5,
      edges: [],
      createdAt: 10,
      updatedAt: 10,
    });

    await assert.rejects(
      () =>
        store.put(
          {
            flowId: "flow-1",
            threadId: "thread-1",
            rootMessageId: "message-1",
            mode: "serial",
            status: "completed",
            currentStageIndex: 0,
            activeRoleIds: [],
            completedRoleIds: ["lead"],
            failedRoleIds: [],
            hopCount: 0,
            maxHops: 5,
            edges: [],
            createdAt: 10,
            updatedAt: 20,
          },
          { expectedVersion: 0 }
        ),
      /flow version conflict/
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
