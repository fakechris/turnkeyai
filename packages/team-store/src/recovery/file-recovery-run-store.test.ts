import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileRecoveryRunStore } from "./file-recovery-run-store";

test("file recovery run store reads and lists runs by thread", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-store-"));
  try {
    const store = new FileRecoveryRunStore({
      rootDir,
    });

    await store.put({
      recoveryRunId: "recovery:task-1",
      threadId: "thread-1",
      sourceGroupId: "task-1",
      latestStatus: "failed",
      status: "waiting_approval",
      nextAction: "request_approval",
      autoDispatchReady: false,
      requiresManualIntervention: true,
      latestSummary: "approval required",
      waitingReason: "approval required",
      attempts: [],
      createdAt: 10,
      updatedAt: 20,
    });

    await store.put({
      recoveryRunId: "recovery:task-2",
      threadId: "thread-2",
      sourceGroupId: "task-2",
      latestStatus: "partial",
      status: "resumed",
      nextAction: "auto_resume",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "resuming",
      attempts: [],
      createdAt: 15,
      updatedAt: 25,
    });

    const run = await store.get("recovery:task-1");
    assert.ok(run);
    assert.equal(run?.threadId, "thread-1");

    const runs = await store.listByThread("thread-1");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.recoveryRunId, "recovery:task-1");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
