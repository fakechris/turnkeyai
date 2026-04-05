import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RoleRunState } from "@turnkeyai/core-types/team";
import { writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

import { FileRoleRunStore } from "./file-role-run-store";

test("file role run store assigns and increments projection versions", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-role-run-store-"));
  try {
    const store = new FileRoleRunStore({ rootDir });
    await store.put({
      runKey: "role:lead:thread:thread-1",
      threadId: "thread-1",
      roleId: "lead",
      mode: "group",
      status: "queued",
      iterationCount: 0,
      maxIterations: 5,
      inbox: [],
      lastActiveAt: 10,
    });

    const created = await store.get("role:lead:thread:thread-1");
    assert.equal(created?.version, 1);

    await store.put({
      ...created!,
      status: "running",
      lastActiveAt: 20,
    });

    const updated = await store.get("role:lead:thread:thread-1");
    assert.equal(updated?.version, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file role run store backfills version for legacy records", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-role-run-legacy-"));
  try {
    await writeJsonFileAtomic(path.join(rootDir, encodeURIComponent("role:lead:thread:thread-1") + ".json"), {
      runKey: "role:lead:thread:thread-1",
      threadId: "thread-1",
      roleId: "lead",
      mode: "group",
      status: "queued",
      iterationCount: 0,
      maxIterations: 5,
      inbox: [],
      lastActiveAt: 10,
    });

    const store = new FileRoleRunStore({ rootDir });
    const runState = await store.get("role:lead:thread:thread-1");
    assert.equal(runState?.version, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file role run store canonicalizes legacy handoff payloads on read", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-role-run-payload-legacy-"));
  try {
    const filePath = path.join(rootDir, encodeURIComponent("role:lead:thread:thread-1") + ".json");
    await writeJsonFileAtomic(filePath, {
      runKey: "role:lead:thread:thread-1",
      threadId: "thread-1",
      roleId: "lead",
      mode: "group",
      status: "queued",
      iterationCount: 0,
      maxIterations: 5,
      inbox: [
        {
          taskId: "task-1",
          flowId: "flow-1",
          sourceMessageId: "msg-1",
          targetRoleId: "lead",
          activationType: "message",
          threadId: "thread-1",
          createdAt: 10,
          payload: {
            threadId: "thread-1",
            relayBrief: "Inspect the queue",
            recentMessages: [],
            preferredWorkerKinds: ["browser"],
            dispatchPolicy: {
              allowParallel: false,
              allowReenter: true,
              sourceFlowMode: "group",
            },
          },
        },
      ],
      lastActiveAt: 10,
    });

    const store = new FileRoleRunStore({ rootDir });
    const runState = await store.get("role:lead:thread:thread-1");
    assert.equal(runState?.inbox[0]?.payload.intent?.relayBrief, "Inspect the queue");
    assert.deepEqual(runState?.inbox[0]?.payload.constraints?.preferredWorkerKinds, ["browser"]);

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as RoleRunState;
    assert.equal(persisted.inbox[0]?.payload.intent?.relayBrief, "Inspect the queue");
    assert.deepEqual(persisted.inbox[0]?.payload.constraints?.preferredWorkerKinds, ["browser"]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file role run store rejects stale expected versions", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-role-run-conflict-"));
  try {
    const store = new FileRoleRunStore({ rootDir });
    await store.put({
      runKey: "role:lead:thread:thread-1",
      threadId: "thread-1",
      roleId: "lead",
      mode: "group",
      status: "queued",
      iterationCount: 0,
      maxIterations: 5,
      inbox: [],
      lastActiveAt: 10,
    });

    await assert.rejects(
      () =>
        store.put(
          {
            runKey: "role:lead:thread:thread-1",
            threadId: "thread-1",
            roleId: "lead",
            mode: "group",
            status: "running",
            iterationCount: 0,
            maxIterations: 5,
            inbox: [],
            lastActiveAt: 20,
          },
          { expectedVersion: 0 }
        ),
      /role run version conflict/
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
