import assert from "node:assert/strict";
import test from "node:test";

import type { HandoffEnvelope, RoleRunState, TeamThread } from "@turnkeyai/core-types/team";

import { recoverRoleRunsOnStartup } from "./role-run-startup-recovery";

function buildHandoff(input: {
  taskId: string;
  flowId: string;
  threadId: string;
  targetRoleId: string;
  sourceMessageId: string;
  relayBrief: string;
  createdAt: number;
}): HandoffEnvelope {
  return {
    taskId: input.taskId,
    flowId: input.flowId,
    sourceMessageId: input.sourceMessageId,
    targetRoleId: input.targetRoleId,
    activationType: "mention",
    threadId: input.threadId,
    payload: {
      threadId: input.threadId,
      relayBrief: input.relayBrief,
      recentMessages: [],
    },
    createdAt: input.createdAt,
  };
}

test("role run startup recovery restarts queued running and resuming role runs", async () => {
  const threads: TeamThread[] = [
    {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Demo",
      leadRoleId: "lead",
      roles: [],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      threadId: "thread-2",
      teamId: "team-1",
      teamName: "Demo",
      leadRoleId: "lead",
      roles: [],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const roleRuns = new Map<string, RoleRunState[]>([
    [
      "thread-1",
      [
        {
          runKey: "run:queued",
          threadId: "thread-1",
          roleId: "role-1",
          mode: "group",
          status: "queued",
          iterationCount: 0,
          maxIterations: 4,
          inbox: [
            buildHandoff({
              taskId: "task-queued-valid",
              flowId: "flow-1",
              sourceMessageId: "msg-1",
              targetRoleId: "role-1",
              threadId: "thread-1",
              relayBrief: "valid",
              createdAt: 10,
            }),
            buildHandoff({
              taskId: "task-queued-invalid",
              flowId: "flow-missing",
              sourceMessageId: "msg-2",
              targetRoleId: "role-1",
              threadId: "thread-1",
              relayBrief: "invalid",
              createdAt: 11,
            }),
          ],
          lastActiveAt: 10,
        },
        {
          runKey: "run:running",
          threadId: "thread-1",
          roleId: "role-1",
          mode: "group",
          status: "running",
          iterationCount: 1,
          maxIterations: 4,
          inbox: [
            buildHandoff({
              taskId: "task-running-valid",
              flowId: "flow-1",
              sourceMessageId: "msg-3",
              targetRoleId: "role-1",
              threadId: "thread-1",
              relayBrief: "running",
              createdAt: 12,
            }),
          ],
          lastActiveAt: 11,
        },
      ],
    ],
    [
      "thread-2",
      [
        {
          runKey: "run:resuming",
          threadId: "thread-2",
          roleId: "role-2",
          mode: "group",
          status: "resuming",
          iterationCount: 1,
          maxIterations: 4,
          inbox: [
            buildHandoff({
              taskId: "task-resuming-valid",
              flowId: "flow-2",
              sourceMessageId: "msg-4",
              targetRoleId: "role-2",
              threadId: "thread-2",
              relayBrief: "resuming",
              createdAt: 13,
            }),
          ],
          lastActiveAt: 12,
        },
        {
          runKey: "run:waiting",
          threadId: "thread-2",
          roleId: "role-2",
          mode: "group",
          status: "waiting_worker",
          iterationCount: 1,
          maxIterations: 4,
          inbox: [
            buildHandoff({
              taskId: "task-waiting-invalid-thread",
              flowId: "flow-2",
              sourceMessageId: "msg-5",
              targetRoleId: "role-2",
              threadId: "thread-1",
              relayBrief: "bad-thread",
              createdAt: 14,
            }),
          ],
          lastActiveAt: 13,
        },
        {
          runKey: "run:queued-empty",
          threadId: "thread-2",
          roleId: "role-2",
          mode: "group",
          status: "queued",
          iterationCount: 0,
          maxIterations: 4,
          inbox: [
            buildHandoff({
              taskId: "task-queued-empty-invalid",
              flowId: "flow-missing-2",
              sourceMessageId: "msg-6",
              targetRoleId: "role-2",
              threadId: "thread-2",
              relayBrief: "bad-flow",
              createdAt: 15,
            }),
          ],
          lastActiveAt: 16,
        },
      ],
    ],
    [
      "thread-orphan",
      [
        {
          runKey: "run:orphaned",
          threadId: "thread-orphan",
          roleId: "role-3",
          mode: "group",
          status: "waiting_worker",
          iterationCount: 1,
          maxIterations: 4,
          inbox: [],
          lastActiveAt: 14,
          workerSessions: {
            browser: "worker:orphaned",
          },
        },
      ],
    ],
  ]);
  const restartedRunKeys: string[] = [];
  const persistedRuns = new Map<string, RoleRunState>();

  const result = await recoverRoleRunsOnStartup({
    teamThreadStore: {
      async list() {
        return threads;
      },
    } as any,
    flowLedgerStore: {
      async get(flowId: string) {
        if (flowId === "flow-1") {
          return { flowId, threadId: "thread-1" };
        }
        if (flowId === "flow-2") {
          return { flowId, threadId: "thread-2" };
        }
        return null;
      },
    } as any,
    roleRunStore: {
      async listByThread(threadId: string) {
        return roleRuns.get(threadId) ?? [];
      },
      async listAll() {
        return [...roleRuns.values()].flat();
      },
      async put(runState: RoleRunState) {
        persistedRuns.set(runState.runKey, runState);
      },
    } as any,
    roleLoopRunner: {
      async ensureRunning(runKey: string) {
        restartedRunKeys.push(runKey);
      },
    } as any,
  });

  assert.deepEqual(result, {
    totalRoleRuns: 6,
    restartedQueuedRuns: 1,
    restartedRunningRuns: 1,
    restartedResumingRuns: 1,
    restartedRunKeys: ["run:queued", "run:running", "run:resuming"],
    orphanedThreadRuns: 1,
    failedOrphanedRuns: 1,
    failedRunKeys: ["run:orphaned"],
    clearedInvalidHandoffs: 3,
    queuedRunsIdled: 1,
  });
  assert.deepEqual(restartedRunKeys, ["run:queued", "run:running", "run:resuming"]);
  assert.deepEqual(persistedRuns.get("run:queued")?.inbox.map((handoff) => handoff.taskId), ["task-queued-valid"]);
  assert.equal(
    persistedRuns.get("run:queued")?.inbox[0]?.payload.intent?.relayBrief,
    "valid"
  );
  assert.deepEqual(persistedRuns.get("run:waiting")?.inbox, []);
  assert.equal(persistedRuns.get("run:queued-empty")?.status, "idle");
  assert.deepEqual(persistedRuns.get("run:queued-empty")?.inbox, []);
  assert.deepEqual(persistedRuns.get("run:orphaned"), {
    runKey: "run:orphaned",
    threadId: "thread-orphan",
    roleId: "role-3",
    mode: "group",
    status: "failed",
    iterationCount: 1,
    maxIterations: 4,
    inbox: [],
    lastActiveAt: 14,
    workerSessions: {},
  });
});
