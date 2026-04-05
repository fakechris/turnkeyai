import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

import { FilePermissionCacheStore } from "./file-permission-cache-store";

test("file permission cache store reads and lists records by thread", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-permission-cache-store-"));
  try {
    const store = new FilePermissionCacheStore({ rootDir });

    await store.put({
      cacheKey: "thread-1:explore:mutate:approval",
      threadId: "thread-1",
      workerType: "explore",
      requirement: {
        level: "approval",
        scope: "mutate",
        rationale: "mutating remote state",
        cacheKey: "thread-1:explore:mutate:approval",
      },
      decision: "prompt_required",
      createdAt: 10,
      updatedAt: 20,
    });

    await store.put({
      cacheKey: "thread-2:browser:read:none",
      threadId: "thread-2",
      workerType: "browser",
      requirement: {
        level: "none",
        scope: "read",
        rationale: "read-only worker execution",
        cacheKey: "thread-2:browser:read:none",
      },
      decision: "granted",
      createdAt: 15,
      updatedAt: 25,
    });

    const record = await store.get("thread-1:explore:mutate:approval");
    assert.ok(record);
    assert.equal(record?.threadId, "thread-1");

    const records = await store.listByThread("thread-1");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.cacheKey, "thread-1:explore:mutate:approval");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file permission cache store handles missing, legacy, and unknown-thread lookups", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-permission-cache-store-"));
  try {
    const store = new FilePermissionCacheStore({ rootDir });
    assert.equal(await store.get("non-existent-key"), null);

    const legacyRecord = {
      cacheKey: "thread-legacy:explore:read:none",
      threadId: "thread-legacy",
      workerType: "explore",
      requirement: {
        level: "none",
        scope: "read",
        rationale: "legacy fallback",
        cacheKey: "thread-legacy:explore:read:none",
      },
      decision: "granted",
      createdAt: 30,
      updatedAt: 40,
    } as const;

    await writeJsonFileAtomic(
      path.join(rootDir, "thread-legacy_explore_read_none.json"),
      legacyRecord
    );

    const restored = await store.get("thread-legacy:explore:read:none");
    assert.deepEqual(restored, legacyRecord);

    const missingThread = await store.listByThread("unknown-thread");
    assert.deepEqual(missingThread, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
