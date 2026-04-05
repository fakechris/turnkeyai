import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
