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

    const records = await store.list();
    assert.equal(records.length, 2);
    assert.equal(records[0]?.workerRunKey, "worker:browser:task:task-1");
    assert.equal(records[1]?.workerRunKey, "worker:explore:task:task-2");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
