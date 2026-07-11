import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileWorkerSessionStore } from "./file-worker-session-store";

test("file worker session store reads and lists persisted sessions", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-worker-session-store-"));
  try {
    const store = new FileWorkerSessionStore({ rootDir });

    await store.put({
      workerRunKey: "worker:browser:task:task-1",
      executionToken: 1,
      state: {
        workerRunKey: "worker:browser:task:task-1",
        workerType: "browser",
        status: "resumable",
        createdAt: 10,
        updatedAt: 30,
        currentTaskId: "task-1",
        history: [
          {
            id: "history-1",
            role: "user",
            content: "Open example.com.",
            createdAt: 21,
            taskId: "task-1",
          },
          {
            id: "history-2",
            role: "tool",
            content: "Captured Example Domain.",
            createdAt: 29,
            taskId: "task-1",
            toolName: "browser",
            status: "completed",
            payload: { title: "Example Domain" },
          },
        ],
        continuationDigest: {
          reason: "supervisor_retry",
          summary: "Resume from the latest safe checkpoint.",
          createdAt: 30,
        },
      },
      context: {
        threadId: "thread-1",
        flowId: "flow-1",
        taskId: "task-1",
        roleId: "role-operator",
        parentSpanId: "role:role-operator:thread:thread-1",
      },
    });

    await store.put({
      workerRunKey: "worker:explore:task:task-2",
      executionToken: 2,
      state: {
        workerRunKey: "worker:explore:task:task-2",
        workerType: "explore",
        status: "done",
        createdAt: 12,
        updatedAt: 20,
      },
    });

    const record = await store.get("worker:browser:task:task-1");
    assert.ok(record);
    assert.equal(record?.state.status, "resumable");
    assert.equal(record?.state.history?.length, 2);
    assert.deepEqual(record?.state.history?.[1]?.payload, { title: "Example Domain" });

    const records = await store.list();
    assert.equal(records.length, 2);
    assert.equal(records[0]?.workerRunKey, "worker:browser:task:task-1");
    assert.equal(records[1]?.workerRunKey, "worker:explore:task:task-2");

    const threadRecords = await store.listByThread("thread-1");
    assert.equal(threadRecords.length, 1);
    assert.equal(threadRecords[0]?.workerRunKey, "worker:browser:task:task-1");

    const missingThreadRecords = await store.listByThread("thread-missing");
    assert.deepEqual(missingThreadRecords, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file worker session store backfills thread index for legacy records", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-worker-session-store-"));
  try {
    const store = new FileWorkerSessionStore({ rootDir });

    await store.put({
      workerRunKey: "worker:browser:task:task-legacy",
      executionToken: 1,
      state: {
        workerRunKey: "worker:browser:task:task-legacy",
        workerType: "browser",
        status: "done",
        createdAt: 10,
        updatedAt: 20,
      },
      context: {
        threadId: "thread-legacy",
        flowId: "flow-1",
        taskId: "task-legacy",
        roleId: "role-operator",
        parentSpanId: "role:role-operator:thread:thread-legacy",
      },
    });

    await rm(path.join(rootDir, "by-thread"), { recursive: true, force: true });

    const indexed = await store.listByThread("thread-legacy");
    assert.equal(indexed.length, 1);
    assert.equal(indexed[0]?.workerRunKey, "worker:browser:task:task-legacy");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file worker session store discovers a record left unindexed by an interrupted put", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-worker-session-store-"));
  try {
    const store = new FileWorkerSessionStore({ rootDir });
    const record = (workerRunKey: string, updatedAt: number) => ({
      workerRunKey,
      executionToken: 1,
      state: {
        workerRunKey,
        workerType: "explore" as const,
        status: "done" as const,
        createdAt: 10,
        updatedAt,
      },
      context: {
        threadId: "thread-interrupted",
        flowId: "flow-1",
        taskId: `task-${updatedAt}`,
        roleId: "role-operator",
        parentSpanId: "role:role-operator:thread:thread-interrupted",
      },
    });

    await store.put(record("worker:explore:indexed", 20));
    await store.put(record("worker:explore:unindexed", 30));
    await rm(
      path.join(
        rootDir,
        "by-thread",
        encodeURIComponent("thread-interrupted"),
        `${encodeURIComponent("worker:explore:unindexed")}.json`,
      ),
    );

    const records = await store.listByThread("thread-interrupted");
    assert.deepEqual(
      records.map((entry) => entry.workerRunKey),
      ["worker:explore:unindexed", "worker:explore:indexed"],
    );

    const recordsAfterBackfill = await store.listByThread("thread-interrupted");
    assert.deepEqual(
      recordsAfterBackfill.map((entry) => entry.workerRunKey),
      ["worker:explore:unindexed", "worker:explore:indexed"],
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
