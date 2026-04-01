import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ScheduledTaskRecord, ScheduledTaskStore } from "@turnkeyai/core-types/team";
import { FileReplayRecorder } from "@turnkeyai/qc-runtime/file-replay-recorder";

import { DefaultScheduledTaskRuntime } from "./scheduled-task-runtime";

test("scheduled task runtime persists tasks and dispatches due capsules", async () => {
  const tasks = new Map<string, ScheduledTaskRecord>();
  const dispatchedTaskIds: string[] = [];

  const store: ScheduledTaskStore = {
    async get(taskId) {
      return tasks.get(taskId) ?? null;
    },
    async put(task) {
      tasks.set(task.taskId, task);
    },
    async listByThread(threadId) {
      return [...tasks.values()].filter((task) => task.threadId === threadId);
    },
    async listDue(now) {
      return [...tasks.values()].filter((task) => task.schedule.nextRunAt <= now);
    },
    async claimDue(taskId, expectedUpdatedAt, leaseUntil) {
      const task = tasks.get(taskId);
      if (!task || task.updatedAt !== expectedUpdatedAt) {
        return null;
      }
      tasks.set(taskId, {
        ...task,
        schedule: {
          ...task.schedule,
          nextRunAt: leaseUntil,
        },
        updatedAt: leaseUntil,
      });
      return task;
    },
  };

  const runtime = new DefaultScheduledTaskRuntime({
    scheduledTaskStore: store,
    coordinationEngine: {
      async handleScheduledTask(task) {
        dispatchedTaskIds.push(task.taskId);
      },
    },
    clock: {
      now: () => Date.UTC(2026, 2, 27, 0, 0, 0),
    },
    idGenerator: {
      taskId: () => "TASK-scheduled-1",
    },
  });

  const scheduled = await runtime.schedule({
    threadId: "thread-1",
    targetRoleId: "role-operator",
    targetWorker: "browser",
    schedule: {
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Asia/Shanghai",
    },
    capsule: {
      title: "Daily check",
      instructions: "Review daily metrics.",
      expectedOutput: "Short digest",
    },
  });

  assert.equal((await runtime.listByThread("thread-1")).length, 1);

  const triggered = await runtime.triggerDue(Date.UTC(2026, 2, 28, 2, 0, 0));

  assert.deepEqual(dispatchedTaskIds, ["TASK-scheduled-1"]);
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0]?.task.taskId, scheduled.taskId);
  assert.ok((tasks.get(scheduled.taskId)?.schedule.nextRunAt ?? 0) > scheduled.createdAt);
});

test("scheduled task runtime continues dispatching after one task throws", async () => {
  const tasks = new Map<string, ScheduledTaskRecord>();
  const dispatchedTaskIds: string[] = [];

  const store: ScheduledTaskStore = {
    async get(taskId) {
      return tasks.get(taskId) ?? null;
    },
    async put(task) {
      tasks.set(task.taskId, task);
    },
    async listByThread(threadId) {
      return [...tasks.values()].filter((task) => task.threadId === threadId);
    },
    async listDue(now) {
      return [...tasks.values()].filter((task) => task.schedule.nextRunAt <= now);
    },
    async claimDue(taskId, expectedUpdatedAt, leaseUntil) {
      const task = tasks.get(taskId);
      if (!task || task.updatedAt !== expectedUpdatedAt) {
        return null;
      }
      tasks.set(taskId, {
        ...task,
        schedule: {
          ...task.schedule,
          nextRunAt: leaseUntil,
        },
        updatedAt: leaseUntil,
      });
      return task;
    },
  };

  tasks.set("TASK-1", {
    taskId: "TASK-1",
    threadId: "thread-1",
    targetRoleId: "role-operator",
    sessionTarget: "main",
    schedule: {
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Asia/Shanghai",
      nextRunAt: 1,
    },
    capsule: {
      title: "Broken task",
      instructions: "This one fails.",
    },
    createdAt: 1,
    updatedAt: 1,
  });
  tasks.set("TASK-2", {
    taskId: "TASK-2",
    threadId: "thread-1",
    targetRoleId: "role-operator",
    sessionTarget: "main",
    schedule: {
      kind: "cron",
      expr: "0 10 * * *",
      tz: "Asia/Shanghai",
      nextRunAt: 1,
    },
    capsule: {
      title: "Healthy task",
      instructions: "This one succeeds.",
    },
    createdAt: 1,
    updatedAt: 1,
  });

  const runtime = new DefaultScheduledTaskRuntime({
    scheduledTaskStore: store,
    coordinationEngine: {
      async handleScheduledTask(task) {
        dispatchedTaskIds.push(task.taskId);
        if (task.taskId === "TASK-1") {
          throw new Error("boom");
        }
      },
    },
    clock: {
      now: () => Date.UTC(2026, 2, 28, 1, 0, 0),
    },
    idGenerator: {
      taskId: () => "TASK-unused",
    },
  });

  const triggered = await runtime.triggerDue(Date.UTC(2026, 2, 28, 2, 0, 0));
  const failedTask = tasks.get("TASK-1");
  const healthyTask = tasks.get("TASK-2");

  assert.deepEqual(dispatchedTaskIds, ["TASK-1", "TASK-2"]);
  assert.equal(triggered.length, 2);
  assert.equal(failedTask?.schedule.nextRunAt, Date.UTC(2026, 2, 28, 2, 1, 0));
  assert.equal(healthyTask != null && healthyTask.schedule.nextRunAt > Date.UTC(2026, 2, 28, 2, 1, 0), true);
});

test("scheduled task runtime records replay entries for dispatch", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "scheduled-replay-"));
  const tasks = new Map<string, ScheduledTaskRecord>();

  const store: ScheduledTaskStore = {
    async get(taskId) {
      return tasks.get(taskId) ?? null;
    },
    async put(task) {
      tasks.set(task.taskId, task);
    },
    async listByThread(threadId) {
      return [...tasks.values()].filter((task) => task.threadId === threadId);
    },
    async listDue(now) {
      return [...tasks.values()].filter((task) => task.schedule.nextRunAt <= now);
    },
    async claimDue(taskId, expectedUpdatedAt, leaseUntil) {
      const task = tasks.get(taskId);
      if (!task || task.updatedAt !== expectedUpdatedAt) {
        return null;
      }
      tasks.set(taskId, {
        ...task,
        schedule: {
          ...task.schedule,
          nextRunAt: leaseUntil,
        },
        updatedAt: leaseUntil,
      });
      return task;
    },
  };

  tasks.set("TASK-replay", {
    taskId: "TASK-replay",
    threadId: "thread-1",
    targetRoleId: "role-operator",
    targetWorker: "browser",
    sessionTarget: "worker",
    schedule: {
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Asia/Shanghai",
      nextRunAt: 1,
    },
    capsule: {
      title: "Replay task",
      instructions: "Continue browser work.",
    },
    createdAt: 1,
    updatedAt: 1,
  });

  const replayRecorder = new FileReplayRecorder({
    rootDir: tempDir,
  });

  try {
    const runtime = new DefaultScheduledTaskRuntime({
      scheduledTaskStore: store,
      coordinationEngine: {
        async handleScheduledTask() {},
      },
      clock: {
        now: () => Date.UTC(2026, 2, 28, 1, 0, 0),
      },
      idGenerator: {
        taskId: () => "TASK-unused",
      },
      replayRecorder,
    });

    await runtime.triggerDue(Date.UTC(2026, 2, 28, 2, 0, 0));
    const replay = await replayRecorder.get("TASK-replay:scheduled");
    assert.equal(replay?.layer, "scheduled");
    assert.equal(replay?.status, "completed");
    assert.equal(replay?.workerType, "browser");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
