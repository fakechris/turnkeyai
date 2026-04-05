import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

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
    assert.equal(run?.version, 1);

    const runs = await store.listByThread("thread-1");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.recoveryRunId, "recovery:task-1");
    assert.equal(runs[0]?.version, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file recovery run store persists attempts as append-only attempt records", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-attempt-store-"));
  try {
    const store = new FileRecoveryRunStore({
      rootDir,
    });

    await store.put({
      recoveryRunId: "recovery:task-1",
      threadId: "thread-1",
      sourceGroupId: "task-1",
      latestStatus: "failed",
      status: "retrying",
      nextAction: "retry_same_layer",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "retry dispatched",
      attempts: [
        {
          attemptId: "recovery:task-1:attempt:1",
          action: "retry",
          requestedAt: 11,
          updatedAt: 12,
          status: "retrying",
          nextAction: "retry_same_layer",
          summary: "retry dispatched",
        },
      ],
      createdAt: 10,
      updatedAt: 20,
    });

    const stored = await store.get("recovery:task-1");
    assert.equal(stored?.attempts.length, 1);
    assert.equal(stored?.attempts[0]?.attemptId, "recovery:task-1:attempt:1");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file recovery run store merges legacy attempts with newer journal attempts", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-attempt-legacy-"));
  try {
    await writeJsonFileAtomic(path.join(rootDir, "recovery%3Atask-1.json"), {
      recoveryRunId: "recovery:task-1",
      threadId: "thread-1",
      sourceGroupId: "task-1",
      latestStatus: "failed",
      status: "failed",
      nextAction: "inspect_then_resume",
      autoDispatchReady: false,
      requiresManualIntervention: true,
      latestSummary: "legacy",
      attempts: [
        {
          attemptId: "recovery:task-1:attempt:1",
          action: "retry",
          requestedAt: 11,
          updatedAt: 12,
          status: "failed",
          nextAction: "stop",
          summary: "legacy failed",
        },
      ],
      createdAt: 10,
      updatedAt: 20,
    });

    const store = new FileRecoveryRunStore({
      rootDir,
    });

    await store.put({
      recoveryRunId: "recovery:task-1",
      threadId: "thread-1",
      sourceGroupId: "task-1",
      latestStatus: "partial",
      status: "retrying",
      nextAction: "retry_same_layer",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "new",
      attempts: [
        {
          attemptId: "recovery:task-1:attempt:1",
          action: "retry",
          requestedAt: 11,
          updatedAt: 22,
          status: "retrying",
          nextAction: "retry_same_layer",
          summary: "retrying again",
        },
        {
          attemptId: "recovery:task-1:attempt:2",
          action: "fallback",
          requestedAt: 23,
          updatedAt: 24,
          status: "fallback_running",
          nextAction: "fallback_transport",
          summary: "fallback dispatched",
        },
      ],
      createdAt: 10,
      updatedAt: 25,
    });

    const stored = await store.get("recovery:task-1");
    assert.equal(stored?.attempts.length, 2);
    assert.equal(stored?.attempts[0]?.summary, "retrying again");
    assert.equal(stored?.attempts[1]?.attemptId, "recovery:task-1:attempt:2");
    assert.equal(stored?.version, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file recovery run store increments projection versions on overwrite", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-version-store-"));
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
      attempts: [],
      createdAt: 10,
      updatedAt: 20,
    });
    const created = await store.get("recovery:task-1");
    assert.equal(created?.version, 1);

    await store.put({
      ...created!,
      latestStatus: "partial",
      status: "resumed",
      nextAction: "auto_resume",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      updatedAt: 30,
    });

    const updated = await store.get("recovery:task-1");
    assert.equal(updated?.version, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file recovery run store rejects stale expected versions", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-conflict-store-"));
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
      attempts: [],
      createdAt: 10,
      updatedAt: 20,
    });

    await assert.rejects(
      () =>
        store.put(
          {
            recoveryRunId: "recovery:task-1",
            threadId: "thread-1",
            sourceGroupId: "task-1",
            latestStatus: "partial",
            status: "resumed",
            nextAction: "auto_resume",
            autoDispatchReady: true,
            requiresManualIntervention: false,
            latestSummary: "resuming",
            attempts: [],
            createdAt: 10,
            updatedAt: 30,
          },
          { expectedVersion: 0 }
        ),
      /recovery run version conflict/
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
