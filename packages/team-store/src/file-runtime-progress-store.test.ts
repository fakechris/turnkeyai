import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileRuntimeProgressStore } from "./file-runtime-progress-store";

test("runtime progress store persists by thread and by chain views", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-runtime-progress-"));

  try {
    const store = new FileRuntimeProgressStore({
      rootDir: path.join(rootDir, "progress"),
    });

    await store.append({
      progressId: "progress-1",
      threadId: "thread-1",
      chainId: "flow:flow-1",
      spanId: "role:run-1",
      subjectKind: "role_run",
      subjectId: "run-1",
      phase: "started",
      continuityState: "alive",
      summary: "role started",
      recordedAt: 10,
      flowId: "flow-1",
      roleId: "role-lead",
    });
    await store.append({
      progressId: "progress-2",
      threadId: "thread-1",
      chainId: "flow:flow-1",
      spanId: "worker:worker-1",
      parentSpanId: "role:run-1",
      subjectKind: "worker_run",
      subjectId: "worker-1",
      phase: "waiting",
      continuityState: "waiting",
      summary: "worker waiting",
      recordedAt: 20,
      flowId: "flow-1",
      taskId: "task-1",
      roleId: "role-lead",
      workerType: "browser",
    });
    await store.append({
      progressId: "progress-3",
      threadId: "thread-2",
      chainId: "flow:flow-2",
      subjectKind: "role_run",
      subjectId: "run-2",
      phase: "completed",
      continuityState: "resolved",
      summary: "other thread",
      recordedAt: 30,
      flowId: "flow-2",
      roleId: "role-lead",
    });

    const threadEvents = await store.listByThread("thread-1", 10);
    const chainEvents = await store.listByChain("flow:flow-1", 10);

    assert.deepEqual(
      threadEvents.map((event) => event.progressId),
      ["progress-1", "progress-2"]
    );
    assert.deepEqual(
      chainEvents.map((event) => event.progressId),
      ["progress-1", "progress-2"]
    );
    assert.equal(chainEvents[1]?.continuityState, "waiting");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
