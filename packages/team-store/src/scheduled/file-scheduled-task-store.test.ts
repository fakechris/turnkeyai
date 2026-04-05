import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

import { FileScheduledTaskStore } from "./file-scheduled-task-store";

test("file scheduled task store assigns and increments projection versions", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-scheduled-task-store-"));

  try {
    const store = new FileScheduledTaskStore({ rootDir });
    await store.put({
      taskId: "TASK-1",
      threadId: "thread-1",
      dispatch: {
        targetRoleId: "role-operator",
        sessionTarget: "main",
      },
      schedule: {
        kind: "cron",
        expr: "0 9 * * *",
        tz: "Asia/Shanghai",
        nextRunAt: 1,
      },
      capsule: {
        title: "Daily check",
        instructions: "Inspect queue.",
      },
      createdAt: 1,
      updatedAt: 1,
    });

    const created = await store.get("TASK-1");
    assert.equal(created?.version, 1);

    await store.put(
      {
        ...created!,
        updatedAt: 2,
      },
      { expectedVersion: created?.version }
    );

    const updated = await store.get("TASK-1");
    assert.equal(updated?.version, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file scheduled task store backfills version for legacy records", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-scheduled-task-store-legacy-"));

  try {
    await writeJsonFileAtomic(path.join(rootDir, `${encodeURIComponent("TASK-legacy")}.json`), {
      taskId: "TASK-legacy",
      threadId: "thread-legacy",
      targetRoleId: "role-operator",
      sessionTarget: "main",
      schedule: {
        kind: "cron",
        expr: "0 9 * * *",
        tz: "Asia/Shanghai",
        nextRunAt: 1,
      },
      capsule: {
        title: "Legacy task",
        instructions: "Inspect queue.",
      },
      createdAt: 1,
      updatedAt: 1,
    });

    const store = new FileScheduledTaskStore({ rootDir });
    const task = await store.get("TASK-legacy");

    assert.equal(task?.version, 1);
    assert.equal(task?.dispatch?.targetRoleId, "role-operator");

    const persisted = JSON.parse(
      await readFile(path.join(rootDir, `${encodeURIComponent("TASK-legacy")}.json`), "utf8")
    ) as { version?: number; dispatch?: { targetRoleId?: string }; targetRoleId?: string };
    assert.equal(persisted.version, 1);
    assert.equal(persisted.dispatch?.targetRoleId, "role-operator");
    assert.equal(persisted.targetRoleId, "role-operator");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file scheduled task store rejects stale expected versions", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-scheduled-task-store-version-"));

  try {
    const store = new FileScheduledTaskStore({ rootDir });
    await store.put({
      taskId: "TASK-stale",
      threadId: "thread-1",
      dispatch: {
        targetRoleId: "role-operator",
        sessionTarget: "main",
      },
      schedule: {
        kind: "cron",
        expr: "0 9 * * *",
        tz: "Asia/Shanghai",
        nextRunAt: 1,
      },
      capsule: {
        title: "Daily check",
        instructions: "Inspect queue.",
      },
      createdAt: 1,
      updatedAt: 1,
    });

    await assert.rejects(
      () =>
        store.put(
          {
            taskId: "TASK-stale",
            threadId: "thread-1",
            dispatch: {
              targetRoleId: "role-operator",
              sessionTarget: "main",
            },
            schedule: {
              kind: "cron",
              expr: "0 9 * * *",
              tz: "Asia/Shanghai",
              nextRunAt: 2,
            },
            capsule: {
              title: "Daily check",
              instructions: "Inspect queue.",
            },
            createdAt: 1,
            updatedAt: 2,
          },
          { expectedVersion: 0 }
        ),
      /scheduled task version conflict/
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file scheduled task store can update a legacy task without deadlocking", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-scheduled-task-store-update-legacy-"));

  try {
    const filePath = path.join(rootDir, `${encodeURIComponent("TASK-update-legacy")}.json`);
    await writeJsonFileAtomic(filePath, {
      taskId: "TASK-update-legacy",
      threadId: "thread-legacy",
      targetRoleId: "role-operator",
      sessionTarget: "main",
      schedule: {
        kind: "cron",
        expr: "0 9 * * *",
        tz: "Asia/Shanghai",
        nextRunAt: 1,
      },
      capsule: {
        title: "Legacy task",
        instructions: "Inspect queue.",
      },
      createdAt: 1,
      updatedAt: 1,
    });

    const store = new FileScheduledTaskStore({ rootDir });
    const current = await store.get("TASK-update-legacy");
    await store.put(
      {
        ...current!,
        updatedAt: 2,
      },
      { expectedVersion: current?.version }
    );

    const updated = await store.get("TASK-update-legacy");
    assert.equal(updated?.version, 2);
    assert.equal(updated?.dispatch?.targetRoleId, "role-operator");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
