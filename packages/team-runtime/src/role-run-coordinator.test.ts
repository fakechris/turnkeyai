import assert from "node:assert/strict";
import test from "node:test";

import type { RoleRunState, RoleRunStore } from "@turnkeyai/core-types/team";

import { DefaultRoleRunCoordinator } from "./role-run-coordinator";

function createInMemoryRoleRunStore(): RoleRunStore & { records: Map<string, RoleRunState> } {
  const records = new Map<string, RoleRunState>();
  return {
    records,
    async get(runKey) {
      return records.get(runKey) ?? null;
    },
    async put(runState) {
      records.set(runState.runKey, runState);
    },
    async delete(runKey) {
      records.delete(runKey);
    },
    async listByThread(threadId) {
      return [...records.values()].filter((runState) => runState.threadId === threadId);
    },
    async listAll() {
      return [...records.values()];
    },
  };
}

test("role run coordinator canonicalizes enqueued legacy handoff payloads", async () => {
  const roleRunStore = createInMemoryRoleRunStore();
  const coordinator = new DefaultRoleRunCoordinator({
    roleRunStore,
    runtimeLimits: {
      memberMaxIterations: 4,
      maxQueuedHandoffsPerRole: 4,
    },
    now: () => 10,
  });

  const run = await coordinator.getOrCreate("thread-1", "role-lead");
  await coordinator.enqueue(run.runKey, {
    taskId: "task-1",
    flowId: "flow-1",
    sourceMessageId: "message-1",
    targetRoleId: "role-lead",
    activationType: "mention",
    threadId: "thread-1",
    payload: {
      threadId: "thread-1",
      relayBrief: "Continue with the browser session.",
      recentMessages: [],
    },
    createdAt: 10,
  });

  const storedRun = await roleRunStore.get(run.runKey);
  assert.equal(storedRun?.inbox.length, 1);
  assert.equal(storedRun?.inbox[0]?.payload.intent?.relayBrief, "Continue with the browser session.");
  assert.deepEqual(storedRun?.inbox[0]?.payload.intent?.recentMessages, []);
  assert.equal(storedRun?.inbox[0]?.payload.relayBrief, "Continue with the browser session.");
});
