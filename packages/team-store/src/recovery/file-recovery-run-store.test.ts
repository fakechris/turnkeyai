import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

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

test("file recovery run store repairs legacy flat runs into canonical by-id, thread, and attempt projections on read", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-repair-legacy-"));
  try {
    await writeJsonFileAtomic(path.join(rootDir, "recovery%3Atask-legacy.json"), {
      recoveryRunId: "recovery:task-legacy",
      threadId: "thread-legacy",
      sourceGroupId: "task-legacy",
      latestStatus: "failed",
      status: "retrying",
      nextAction: "retry_same_layer",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "legacy only",
      attempts: [
        {
          attemptId: "recovery:task-legacy:attempt:1",
          action: "retry",
          requestedAt: 11,
          updatedAt: 12,
          status: "retrying",
          nextAction: "retry_same_layer",
          summary: "legacy attempt",
        },
      ],
      createdAt: 10,
      updatedAt: 20,
    });

    const store = new FileRecoveryRunStore({ rootDir });
    const restored = await store.get("recovery:task-legacy");

    assert.ok(restored);
    assert.equal(restored?.attempts.length, 1);
    assert.deepEqual(
      await readJsonFile(path.join(rootDir, "by-id", "recovery%3Atask-legacy.json")),
      {
        ...restored,
        attempts: [],
      }
    );
    assert.deepEqual(
      await readJsonFile(path.join(rootDir, "threads", "thread-legacy", "recovery%3Atask-legacy.json")),
      {
        ...restored,
        attempts: [],
      }
    );
    assert.deepEqual(
      await readJsonFile(path.join(rootDir, "attempts", "recovery%3Atask-legacy", "recovery%3Atask-legacy%3Aattempt%3A1.json")),
      restored?.attempts[0]
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file recovery run store repairs thread-scoped projections from by-id records during thread reads", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-repair-thread-"));
  try {
    await writeJsonFileAtomic(path.join(rootDir, "by-id", "recovery%3Atask-1.json"), {
      recoveryRunId: "recovery:task-1",
      threadId: "thread-1",
      sourceGroupId: "task-1",
      latestStatus: "partial",
      status: "retrying",
      nextAction: "retry_same_layer",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "by-id only",
      attempts: [],
      createdAt: 10,
      updatedAt: 20,
      version: 1,
    });

    const store = new FileRecoveryRunStore({ rootDir });
    const runs = await store.listByThread("thread-1");

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.latestSummary, "by-id only");
    assert.deepEqual(
      await readJsonFile(path.join(rootDir, "threads", "thread-1", "recovery%3Atask-1.json")),
      {
        ...runs[0],
        attempts: [],
      }
    );
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

test("file recovery run store merges thread-scoped, by-id, and legacy runs during partial migration reads", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-partial-migration-"));
  try {
    await writeJsonFileAtomic(path.join(rootDir, "recovery%3Atask-1.json"), {
      recoveryRunId: "recovery:task-1",
      threadId: "thread-1",
      sourceGroupId: "task-1",
      latestStatus: "failed",
      status: "waiting_approval",
      nextAction: "request_approval",
      autoDispatchReady: false,
      requiresManualIntervention: true,
      latestSummary: "legacy",
      attempts: [],
      createdAt: 10,
      updatedAt: 20,
    });
    await writeJsonFileAtomic(path.join(rootDir, "by-id", "recovery%3Atask-1.json"), {
      recoveryRunId: "recovery:task-1",
      threadId: "thread-1",
      sourceGroupId: "task-1",
      latestStatus: "partial",
      status: "retrying",
      nextAction: "retry_same_layer",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "by-id",
      attempts: [],
      createdAt: 10,
      updatedAt: 25,
    });
    await writeJsonFileAtomic(path.join(rootDir, "threads", "thread-1", "recovery%3Atask-1.json"), {
      recoveryRunId: "recovery:task-1",
      threadId: "thread-1",
      sourceGroupId: "task-1",
      latestStatus: "partial",
      status: "running",
      nextAction: "auto_resume",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "thread-scoped",
      attempts: [],
      createdAt: 10,
      updatedAt: 30,
    });
    await writeJsonFileAtomic(path.join(rootDir, "threads", "thread-1", "recovery%3Atask-2.json"), {
      recoveryRunId: "recovery:task-2",
      threadId: "thread-1",
      sourceGroupId: "task-2",
      latestStatus: "failed",
      status: "aborted",
      nextAction: "stop",
      autoDispatchReady: false,
      requiresManualIntervention: true,
      latestSummary: "thread-only",
      attempts: [],
      createdAt: 11,
      updatedAt: 31,
    });

    const store = new FileRecoveryRunStore({ rootDir });
    const threadScopedOnlyRun = await store.get("recovery:task-2");
    const threadRuns = await store.listByThread("thread-1");
    const allRuns = await store.listAll();

    assert.equal(threadScopedOnlyRun?.latestSummary, "thread-only");
    assert.equal(threadScopedOnlyRun?.version, 1);
    assert.deepEqual(
      threadRuns.map((run) => [run.recoveryRunId, run.latestSummary]),
      [
        ["recovery:task-2", "thread-only"],
        ["recovery:task-1", "thread-scoped"],
      ]
    );
    assert.deepEqual(
      allRuns.map((run) => [run.recoveryRunId, run.latestSummary]),
      [
        ["recovery:task-2", "thread-only"],
        ["recovery:task-1", "thread-scoped"],
      ]
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file recovery run store uses thread-scoped version for expectedVersion checks", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-thread-version-"));
  try {
    await writeJsonFileAtomic(path.join(rootDir, "by-id", "recovery%3Atask-1.json"), {
      recoveryRunId: "recovery:task-1",
      threadId: "thread-1",
      sourceGroupId: "task-1",
      latestStatus: "failed",
      status: "waiting_approval",
      nextAction: "request_approval",
      autoDispatchReady: false,
      requiresManualIntervention: true,
      latestSummary: "by-id",
      attempts: [],
      createdAt: 10,
      updatedAt: 20,
      version: 1,
    });
    await writeJsonFileAtomic(path.join(rootDir, "threads", "thread-1", "recovery%3Atask-1.json"), {
      recoveryRunId: "recovery:task-1",
      threadId: "thread-1",
      sourceGroupId: "task-1",
      latestStatus: "partial",
      status: "retrying",
      nextAction: "retry_same_layer",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "thread-scoped",
      attempts: [],
      createdAt: 10,
      updatedAt: 30,
      version: 2,
    });

    const store = new FileRecoveryRunStore({ rootDir });

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
            updatedAt: 40,
          },
          { expectedVersion: 1 }
        ),
      /recovery run version conflict/
    );
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

test("file recovery run store restores thread, by-id, and attempts when by-id write fails", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-rollback-"));
  const byIdDir = path.join(rootDir, "by-id");

  try {
    const store = new FileRecoveryRunStore({ rootDir });

    await store.put({
      recoveryRunId: "recovery:rollback",
      threadId: "thread-1",
      sourceGroupId: "task-rollback",
      latestStatus: "failed",
      status: "retrying",
      nextAction: "retry_same_layer",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "first attempt",
      attempts: [
        {
          attemptId: "recovery:rollback:attempt:1",
          action: "retry",
          requestedAt: 11,
          updatedAt: 12,
          status: "retrying",
          nextAction: "retry_same_layer",
          summary: "first retry",
        },
      ],
      createdAt: 10,
      updatedAt: 20,
    });

    const original = await store.get("recovery:rollback");
    assert.ok(original);

    if (process.platform === "win32") {
      return;
    }

    await chmod(byIdDir, 0o500);
    await assert.rejects(
      () =>
        store.put(
          {
            ...original!,
            latestSummary: "updated summary",
            updatedAt: 30,
            attempts: [
              {
                ...original!.attempts[0]!,
                updatedAt: 31,
                summary: "updated retry summary",
              },
            ],
          },
          { expectedVersion: original?.version }
        )
    );
    await chmod(byIdDir, 0o700);

    const restored = await store.get("recovery:rollback");
    assert.deepEqual(restored, original);
    assert.deepEqual((await store.listByThread("thread-1"))[0], original);
    assert.equal(restored?.attempts[0]?.summary, "first retry");
  } finally {
    await chmod(byIdDir, 0o700).catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
});
