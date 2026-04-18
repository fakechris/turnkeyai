import assert from "node:assert/strict";
import test from "node:test";

import { createRelayPayload, createScheduledTaskRecord, normalizeRelayPayload, requireScheduledDispatch } from "./team";

test("normalizeRelayPayload fills canonical relay payload fields", () => {
  const payload = normalizeRelayPayload({
    threadId: "thread-1",
    relayBrief: "Inspect pricing",
    recentMessages: [{ messageId: "message-1", role: "user", name: "User", content: "Check pricing.", createdAt: 1 }],
    instructions: "Open the pricing page",
    dispatchPolicy: {
      allowParallel: true,
      allowReenter: true,
      sourceFlowMode: "parallel",
    },
    preferredWorkerKinds: ["browser"],
    continuationContext: {
      source: "follow_up",
      summary: "Continue the same browser session",
    },
  });

  assert.equal(payload.intent?.relayBrief, "Inspect pricing");
  assert.equal(payload.constraints?.dispatchPolicy.sourceFlowMode, "parallel");
  assert.deepEqual(payload.constraints?.preferredWorkerKinds, ["browser"]);
  assert.equal(payload.continuity?.context?.source, "follow_up");
});

test("createRelayPayload writes canonical relay payloads", () => {
  const payload = createRelayPayload({
    threadId: "thread-1",
    relayBrief: "Continue",
    recentMessages: [],
    dispatchPolicy: {
      allowParallel: false,
      allowReenter: true,
      sourceFlowMode: "serial",
    },
    preferredWorkerKinds: ["browser"],
  });

  assert.equal(payload.intent?.relayBrief, "Continue");
  assert.deepEqual(payload.constraints?.preferredWorkerKinds, ["browser"]);
});

test("createScheduledTaskRecord writes canonical dispatch payloads", () => {
  const task = createScheduledTaskRecord({
    taskId: "task-1",
    threadId: "thread-1",
    dispatch: {
      targetRoleId: "role-1",
      targetWorker: "browser",
      sessionTarget: "worker",
      continuity: {
        context: {
          source: "recovery_dispatch",
          workerType: "browser",
          recovery: {
            parentGroupId: "group-1",
            action: "retry_same_layer",
          },
        },
      },
      constraints: {
        preferredWorkerKinds: ["browser"],
      },
    },
    capsule: {
      title: "Recover",
      instructions: "Retry browser work",
    },
    schedule: {
      kind: "cron",
      expr: "* * * * *",
      tz: "UTC",
      nextRunAt: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  });

  assert.equal(task.dispatch?.targetRoleId, "role-1");
  assert.equal(task.dispatch?.targetWorker, "browser");
  assert.equal(task.dispatch?.sessionTarget, "worker");
  assert.equal(task.dispatch?.continuity?.context?.recovery?.parentGroupId, "group-1");
});

test("requireScheduledDispatch rejects tasks without canonical dispatch", () => {
  assert.throws(
    () =>
      requireScheduledDispatch({
        taskId: "task-legacy",
        threadId: "thread-1",
        schedule: {
          kind: "cron",
          expr: "* * * * *",
          tz: "UTC",
          nextRunAt: 1,
        },
        capsule: {
          title: "Legacy",
          instructions: "Recover manually",
        },
        createdAt: 1,
        updatedAt: 1,
      }),
    /missing canonical dispatch payload/
  );
});
