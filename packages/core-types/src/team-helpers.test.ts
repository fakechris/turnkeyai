import assert from "node:assert/strict";
import test from "node:test";

import { createRelayPayload, normalizeRelayPayload, normalizeScheduledTaskRecord } from "./team";

test("normalizeRelayPayload fills canonical and mirrored relay payload fields", () => {
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
  assert.equal(payload.dispatchPolicy?.sourceFlowMode, "parallel");
  assert.deepEqual(payload.preferredWorkerKinds, ["browser"]);
  assert.equal(payload.continuationContext?.source, "follow_up");
});

test("createRelayPayload writes canonical relay payloads with mirrored compatibility fields", () => {
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
  assert.equal(payload.relayBrief, "Continue");
  assert.deepEqual(payload.constraints?.preferredWorkerKinds, ["browser"]);
  assert.deepEqual(payload.preferredWorkerKinds, ["browser"]);
});

test("normalizeScheduledTaskRecord derives dispatch and mirrored fields from either path", () => {
  const fromLegacy = normalizeScheduledTaskRecord({
    taskId: "task-1",
    threadId: "thread-1",
    targetRoleId: "role-1",
    targetWorker: "browser",
    sessionTarget: "worker",
    recoveryContext: {
      parentGroupId: "group-1",
      action: "retry_same_layer",
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

  assert.equal(fromLegacy.dispatch?.targetRoleId, "role-1");
  assert.equal(fromLegacy.dispatch?.targetWorker, "browser");
  assert.equal(fromLegacy.dispatch?.sessionTarget, "worker");
  assert.equal(fromLegacy.dispatch?.continuity?.context?.recovery?.parentGroupId, "group-1");

  const fromCanonical = normalizeScheduledTaskRecord({
    taskId: "task-2",
    threadId: "thread-1",
    dispatch: {
      targetRoleId: "role-2",
      targetWorker: "explore",
      sessionTarget: "worker",
      constraints: {
        preferredWorkerKinds: ["explore"],
      },
    },
    capsule: {
      title: "Inspect",
      instructions: "Continue explore work",
    },
    schedule: {
      kind: "cron",
      expr: "* * * * *",
      tz: "UTC",
      nextRunAt: 2,
    },
    createdAt: 2,
    updatedAt: 2,
  });

  assert.equal(fromCanonical.targetRoleId, "role-2");
  assert.equal(fromCanonical.targetWorker, "explore");
  assert.equal(fromCanonical.sessionTarget, "worker");
});
