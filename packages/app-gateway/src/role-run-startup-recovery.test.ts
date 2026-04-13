import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRelayPayload, type FlowLedger, type HandoffEnvelope, type RoleRunState, type TeamThread } from "@turnkeyai/core-types/team";

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
    payload: normalizeRelayPayload({
      threadId: input.threadId,
      relayBrief: input.relayBrief,
      recentMessages: [],
    }),
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

test("role run startup recovery retries orphaned run failure after a version conflict", async () => {
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
  ];
  const snapshotRun: RoleRunState = {
    runKey: "run:orphaned-retry",
    threadId: "thread-orphan",
    roleId: "role-1",
    mode: "group",
    status: "waiting_worker",
    iterationCount: 1,
    maxIterations: 4,
    inbox: [],
    lastActiveAt: 10,
    version: 1,
    workerSessions: {
      browser: "worker:orphaned",
    },
  };
  let latestRun: RoleRunState = { ...snapshotRun };
  let putAttempts = 0;

  const result = await recoverRoleRunsOnStartup({
    teamThreadStore: {
      async list() {
        return threads;
      },
    } as any,
    flowLedgerStore: {
      async get() {
        return null;
      },
    } as any,
    roleRunStore: {
      async listByThread() {
        return [];
      },
      async listAll() {
        return [snapshotRun];
      },
      async get(runKey: string) {
        return runKey === latestRun.runKey ? latestRun : null;
      },
      async put(runState: RoleRunState, options?: { expectedVersion?: number }) {
        putAttempts += 1;
        if (putAttempts === 1) {
          assert.equal(options?.expectedVersion, 1);
          latestRun = {
            ...latestRun,
            version: 2,
            lastActiveAt: 11,
          };
          throw new Error("role run version conflict for run:orphaned-retry: expected 1, found 2");
        }
        assert.equal(options?.expectedVersion, 2);
        latestRun = {
          ...runState,
          version: 3,
        };
      },
    } as any,
    roleLoopRunner: {
      async ensureRunning() {},
    } as any,
  });

  assert.equal(putAttempts, 2);
  assert.deepEqual(result, {
    totalRoleRuns: 1,
    restartedQueuedRuns: 0,
    restartedRunningRuns: 0,
    restartedResumingRuns: 0,
    restartedRunKeys: [],
    orphanedThreadRuns: 1,
    failedOrphanedRuns: 1,
    failedRunKeys: ["run:orphaned-retry"],
    clearedInvalidHandoffs: 0,
    queuedRunsIdled: 0,
  });
  assert.equal(latestRun.status, "failed");
  assert.deepEqual(latestRun.workerSessions, {});
});

test("role run startup recovery retries inbox cleanup after a version conflict", async () => {
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
  ];
  const snapshotRun: RoleRunState = {
    runKey: "run:queued-retry",
    threadId: "thread-1",
    roleId: "role-1",
    mode: "group",
    status: "queued",
    iterationCount: 0,
    maxIterations: 4,
    inbox: [
      buildHandoff({
        taskId: "task-invalid",
        flowId: "flow-missing",
        sourceMessageId: "msg-1",
        targetRoleId: "role-1",
        threadId: "thread-1",
        relayBrief: "invalid",
        createdAt: 10,
      }),
    ],
    lastActiveAt: 10,
    version: 1,
  };
  let latestRun: RoleRunState = { ...snapshotRun };
  let putAttempts = 0;

  const result = await recoverRoleRunsOnStartup({
    teamThreadStore: {
      async list() {
        return threads;
      },
    } as any,
    flowLedgerStore: {
      async get() {
        return null;
      },
    } as any,
    roleRunStore: {
      async listByThread(threadId: string) {
        return threadId === "thread-1" ? [snapshotRun] : [];
      },
      async get(runKey: string) {
        return runKey === latestRun.runKey ? latestRun : null;
      },
      async put(runState: RoleRunState, options?: { expectedVersion?: number }) {
        putAttempts += 1;
        if (putAttempts === 1) {
          assert.equal(options?.expectedVersion, 1);
          latestRun = {
            ...latestRun,
            version: 2,
            lastActiveAt: 11,
          };
          throw new Error("role run version conflict for run:queued-retry: expected 1, found 2");
        }
        assert.equal(options?.expectedVersion, 2);
        latestRun = {
          ...runState,
          version: 3,
        };
      },
      async listAll() {
        return [snapshotRun];
      },
    } as any,
    roleLoopRunner: {
      async ensureRunning() {},
    } as any,
  });

  assert.equal(putAttempts, 2);
  assert.deepEqual(result, {
    totalRoleRuns: 1,
    restartedQueuedRuns: 0,
    restartedRunningRuns: 0,
    restartedResumingRuns: 0,
    restartedRunKeys: [],
    orphanedThreadRuns: 0,
    failedOrphanedRuns: 0,
    failedRunKeys: [],
    clearedInvalidHandoffs: 1,
    queuedRunsIdled: 1,
  });
  assert.equal(latestRun.status, "idle");
  assert.deepEqual(latestRun.inbox, []);
});

test("role run startup recovery re-reads missing flows after a version conflict", async () => {
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
  ];
  const handoff = buildHandoff({
    taskId: "task-retry-flow",
    flowId: "flow-late",
    sourceMessageId: "msg-1",
    targetRoleId: "role-1",
    threadId: "thread-1",
    relayBrief: "retry later",
    createdAt: 10,
  });
  const snapshotRun: RoleRunState = {
    runKey: "run:queued-refresh-flow",
    threadId: "thread-1",
    roleId: "role-1",
    mode: "group",
    status: "queued",
    iterationCount: 0,
    maxIterations: 4,
    inbox: [handoff],
    lastActiveAt: 10,
    version: 1,
  };
  let latestRun: RoleRunState = { ...snapshotRun };
  let putAttempts = 0;
  let flowGetAttempts = 0;
  let latestFlow: FlowLedger | null = null;

  const result = await recoverRoleRunsOnStartup({
    teamThreadStore: {
      async list() {
        return threads;
      },
    } as any,
    flowLedgerStore: {
      async get(flowId: string) {
        flowGetAttempts += 1;
        if (flowId !== "flow-late") {
          return null;
        }
        return latestFlow;
      },
    } as any,
    roleRunStore: {
      async listByThread(threadId: string) {
        return threadId === "thread-1" ? [snapshotRun] : [];
      },
      async get(runKey: string) {
        return runKey === latestRun.runKey ? latestRun : null;
      },
      async put(runState: RoleRunState, options?: { expectedVersion?: number }) {
        putAttempts += 1;
        if (putAttempts === 1) {
          assert.equal(options?.expectedVersion, 1);
          latestFlow = {
            flowId: "flow-late",
            threadId: "thread-1",
            rootMessageId: "msg-1",
            mode: "serial",
            status: "running",
            currentStageIndex: 0,
            activeRoleIds: ["role-1"],
            completedRoleIds: [],
            failedRoleIds: [],
            hopCount: 0,
            maxHops: 4,
            edges: [],
            version: 1,
            createdAt: 1,
            updatedAt: 1,
          };
          latestRun = {
            ...latestRun,
            version: 2,
            lastActiveAt: 11,
          };
          throw new Error("role run version conflict for run:queued-refresh-flow: expected 1, found 2");
        }
        latestRun = {
          ...runState,
          version: 3,
        };
      },
      async listAll() {
        return [snapshotRun];
      },
    } as any,
    roleLoopRunner: {
      async ensureRunning() {},
    } as any,
  });

  assert.equal(putAttempts, 1);
  assert.deepEqual(result, {
    totalRoleRuns: 1,
    restartedQueuedRuns: 1,
    restartedRunningRuns: 0,
    restartedResumingRuns: 0,
    restartedRunKeys: ["run:queued-refresh-flow"],
    orphanedThreadRuns: 0,
    failedOrphanedRuns: 0,
    failedRunKeys: [],
    clearedInvalidHandoffs: 0,
    queuedRunsIdled: 0,
  });
  assert.deepEqual(latestRun.inbox, [
    {
      ...handoff,
      payload: {
        ...handoff.payload,
        intent: {
          relayBrief: "retry later",
          recentMessages: [],
        },
      },
    },
  ]);
  assert.equal(latestRun.status, "queued");
});
