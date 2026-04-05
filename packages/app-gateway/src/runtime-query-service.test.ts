import assert from "node:assert/strict";
import test from "node:test";

import type {
  RoleRunState,
  RuntimeSummaryReport,
  TeamThread,
  WorkerRuntime,
  WorkerSessionRecord,
} from "@turnkeyai/core-types/team";

import { createRuntimeQueryService } from "./runtime-query-service";

test("runtime query service surfaces worker session health for scoped thread summaries", async () => {
  const workerSessions: WorkerSessionRecord[] = [
    {
      workerRunKey: "worker:browser:task:task-bound",
      executionToken: 1,
      state: {
        workerRunKey: "worker:browser:task:task-bound",
        workerType: "browser",
        status: "resumable",
        createdAt: 10,
        updatedAt: 20,
      },
      context: {
        threadId: "thread-1",
        flowId: "flow-1",
        taskId: "task-bound",
        roleId: "role-1",
        parentSpanId: "role:run-1",
      },
    },
    {
      workerRunKey: "worker:browser:task:task-orphan",
      executionToken: 1,
      state: {
        workerRunKey: "worker:browser:task:task-orphan",
        workerType: "browser",
        status: "waiting_input",
        createdAt: 11,
        updatedAt: 21,
      },
      context: {
        threadId: "thread-1",
        flowId: "flow-1",
        taskId: "task-orphan",
        roleId: "role-1",
        parentSpanId: "role:run-1",
      },
    },
    {
      workerRunKey: "worker:browser:task:task-missing-context",
      executionToken: 1,
      state: {
        workerRunKey: "worker:browser:task:task-missing-context",
        workerType: "browser",
        status: "running",
        createdAt: 12,
        updatedAt: 22,
      },
    },
    {
      workerRunKey: "worker:browser:task:task-terminal",
      executionToken: 1,
      state: {
        workerRunKey: "worker:browser:task:task-terminal",
        workerType: "browser",
        status: "done",
        createdAt: 13,
        updatedAt: 23,
      },
      context: {
        threadId: "thread-1",
        flowId: "flow-1",
        taskId: "task-terminal",
        roleId: "role-1",
        parentSpanId: "role:run-1",
      },
    },
    {
      workerRunKey: "worker:browser:task:task-other-thread",
      executionToken: 1,
      state: {
        workerRunKey: "worker:browser:task:task-other-thread",
        workerType: "browser",
        status: "resumable",
        createdAt: 14,
        updatedAt: 24,
      },
      context: {
        threadId: "thread-2",
        flowId: "flow-2",
        taskId: "task-other-thread",
        roleId: "role-2",
        parentSpanId: "role:run-2",
      },
    },
  ];
  const workerRuntime: WorkerRuntime = {
    async spawn() {
      return null;
    },
    async send() {
      return null;
    },
    async resume() {
      return null;
    },
    async interrupt() {
      return null;
    },
    async cancel() {
      return null;
    },
    async getState() {
      return null;
    },
    async maybeRunForRole() {
      return null;
    },
    async listSessions() {
      return workerSessions;
    },
  };
  const roleRunsByThread = new Map<string, RoleRunState[]>([
    [
      "thread-1",
      [
        {
          runKey: "run:thread-1:role-1",
          threadId: "thread-1",
          roleId: "role-1",
          mode: "group",
          status: "waiting_worker",
          iterationCount: 1,
          maxIterations: 4,
          inbox: [],
          lastActiveAt: 20,
          workerSessions: {
            browser: "worker:browser:task:task-bound",
          },
        },
      ],
    ],
    ["thread-2", []],
  ]);
  const threads: TeamThread[] = [
    {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Demo",
      leadRoleId: "role-lead",
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
      leadRoleId: "role-lead",
      roles: [],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  const service = createRuntimeQueryService({
    clock: { now: () => 1000 },
    workerRuntime,
    teamThreadStore: {
      async list() {
        return threads;
      },
    } as any,
    flowLedgerStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    roleRunStore: {
      async listByThread(threadId: string) {
        return roleRunsByThread.get(threadId) ?? [];
      },
    } as any,
    runtimeChainStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainStatusStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainSpanStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeChainEventStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeProgressStore: {
      async listByThread() {
        return [];
      },
      async listByChain() {
        return [];
      },
    } as any,
    recoveryRunStore: {
      async get() {
        return null;
      },
      async listByThread() {
        return [];
      },
    } as any,
    recoveryRunEventStore: {
      async listByRecoveryRun() {
        return [];
      },
    } as any,
    loadRecoveryRuntime: async () => ({
      records: [],
      report: {} as never,
      runs: [],
    }),
  });

  const report = await service.loadRuntimeSummary("thread-1", 10);

  assert.deepEqual(report.workerSessionHealth, {
    totalSessions: 3,
    activeSessions: 2,
    orphanedSessions: 1,
    missingContextSessions: 0,
  } satisfies RuntimeSummaryReport["workerSessionHealth"]);
});

test("runtime query service lists scoped worker sessions in reverse update order", async () => {
  const workerSessions: WorkerSessionRecord[] = [
    {
      workerRunKey: "worker:old",
      executionToken: 1,
      state: {
        workerRunKey: "worker:old",
        workerType: "browser",
        status: "resumable",
        createdAt: 10,
        updatedAt: 20,
      },
      context: {
        threadId: "thread-1",
        flowId: "flow-1",
        taskId: "task-1",
        roleId: "role-1",
        parentSpanId: "role:run-1",
      },
    },
    {
      workerRunKey: "worker:new",
      executionToken: 1,
      state: {
        workerRunKey: "worker:new",
        workerType: "browser",
        status: "waiting_external",
        createdAt: 11,
        updatedAt: 30,
      },
      context: {
        threadId: "thread-1",
        flowId: "flow-1",
        taskId: "task-2",
        roleId: "role-1",
        parentSpanId: "role:run-2",
      },
    },
    {
      workerRunKey: "worker:other-thread",
      executionToken: 1,
      state: {
        workerRunKey: "worker:other-thread",
        workerType: "browser",
        status: "resumable",
        createdAt: 12,
        updatedAt: 40,
      },
      context: {
        threadId: "thread-2",
        flowId: "flow-2",
        taskId: "task-3",
        roleId: "role-2",
        parentSpanId: "role:run-3",
      },
    },
  ];

  const service = createRuntimeQueryService({
    clock: { now: () => 1000 },
    workerRuntime: {
      async spawn() {
        return null;
      },
      async send() {
        return null;
      },
      async resume() {
        return null;
      },
      async interrupt() {
        return null;
      },
      async cancel() {
        return null;
      },
      async getState() {
        return null;
      },
      async maybeRunForRole() {
        return null;
      },
      async listSessions() {
        return workerSessions;
      },
    },
    teamThreadStore: {
      async list() {
        return [];
      },
    } as any,
    flowLedgerStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    roleRunStore: {
      async listByThread() {
        return [];
      },
    } as any,
    runtimeChainStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainStatusStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainSpanStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeChainEventStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeProgressStore: {
      async listByThread() {
        return [];
      },
      async listByChain() {
        return [];
      },
    } as any,
    recoveryRunStore: {
      async get() {
        return null;
      },
      async listByThread() {
        return [];
      },
    } as any,
    recoveryRunEventStore: {
      async listByRecoveryRun() {
        return [];
      },
    } as any,
    loadRecoveryRuntime: async () => ({
      records: [],
      report: {} as never,
      runs: [],
    }),
  });

  const scoped = await service.listWorkerSessions(10, "thread-1");
  assert.deepEqual(
    scoped.map((record) => record.workerRunKey),
    ["worker:new", "worker:old"]
  );

  const unscoped = await service.listWorkerSessions(2);
  assert.deepEqual(
    unscoped.map((record) => record.workerRunKey),
    ["worker:other-thread", "worker:new"]
  );
});

test("runtime query service attaches startup reconcile summary when available", async () => {
  const service = createRuntimeQueryService({
    clock: { now: () => 1000 },
    workerRuntime: {
      async spawn() {
        return null;
      },
      async send() {
        return null;
      },
      async resume() {
        return null;
      },
      async interrupt() {
        return null;
      },
      async cancel() {
        return null;
      },
      async getState() {
        return null;
      },
      async maybeRunForRole() {
        return null;
      },
    },
    getWorkerStartupReconcileResult: () => ({
      totalSessions: 3,
      downgradedRunningSessions: 2,
    }),
    teamThreadStore: {
      async list() {
        return [];
      },
    } as any,
    flowLedgerStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    roleRunStore: {
      async listByThread() {
        return [];
      },
    } as any,
    runtimeChainStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainStatusStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainSpanStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeChainEventStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeProgressStore: {
      async listByThread() {
        return [];
      },
      async listByChain() {
        return [];
      },
    } as any,
    recoveryRunStore: {
      async get() {
        return null;
      },
      async listByThread() {
        return [];
      },
    } as any,
    recoveryRunEventStore: {
      async listByRecoveryRun() {
        return [];
      },
    } as any,
    loadRecoveryRuntime: async () => ({
      records: [],
      report: {} as never,
      runs: [],
    }),
  });

  const report = await service.loadRuntimeSummary(null, 10);

  assert.deepEqual(report.workerStartupReconcile, {
    totalSessions: 3,
    downgradedRunningSessions: 2,
  });
});

test("runtime query service attaches worker binding reconcile summary when available", async () => {
  const service = createRuntimeQueryService({
    clock: { now: () => 1000 },
    workerRuntime: {
      async spawn() {
        return null;
      },
      async send() {
        return null;
      },
      async resume() {
        return null;
      },
      async interrupt() {
        return null;
      },
      async cancel() {
        return null;
      },
      async getState() {
        return null;
      },
      async maybeRunForRole() {
        return null;
      },
    },
    getWorkerBindingReconcileResult: () => ({
      totalRoleRuns: 4,
      totalBindings: 5,
      clearedMissingBindings: 1,
      clearedTerminalBindings: 2,
      clearedCrossThreadBindings: 1,
      roleRunsNeedingAttention: 2,
      roleRunsRequeued: 1,
      roleRunsFailed: 1,
    }),
    teamThreadStore: {
      async list() {
        return [];
      },
    } as any,
    flowLedgerStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    roleRunStore: {
      async listByThread() {
        return [];
      },
    } as any,
    runtimeChainStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainStatusStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainSpanStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeChainEventStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeProgressStore: {
      async listByThread() {
        return [];
      },
      async listByChain() {
        return [];
      },
    } as any,
    recoveryRunStore: {
      async get() {
        return null;
      },
      async listByThread() {
        return [];
      },
    } as any,
    recoveryRunEventStore: {
      async listByRecoveryRun() {
        return [];
      },
    } as any,
    loadRecoveryRuntime: async () => ({
      records: [],
      report: {} as never,
      runs: [],
    }),
  });

  const report = await service.loadRuntimeSummary(null, 10);

  assert.deepEqual(report.workerBindingReconcile, {
    totalRoleRuns: 4,
    totalBindings: 5,
    clearedMissingBindings: 1,
    clearedTerminalBindings: 2,
    clearedCrossThreadBindings: 1,
    roleRunsNeedingAttention: 2,
    roleRunsRequeued: 1,
    roleRunsFailed: 1,
  });
});

test("runtime query service attaches role run startup recovery summary when available", async () => {
  const service = createRuntimeQueryService({
    clock: { now: () => 1000 },
    workerRuntime: {
      async spawn() {
        return null;
      },
      async send() {
        return null;
      },
      async resume() {
        return null;
      },
      async interrupt() {
        return null;
      },
      async cancel() {
        return null;
      },
      async getState() {
        return null;
      },
      async maybeRunForRole() {
        return null;
      },
    },
    getRoleRunStartupRecoveryResult: () => ({
      totalRoleRuns: 5,
      restartedQueuedRuns: 2,
      restartedRunningRuns: 1,
      restartedResumingRuns: 1,
      restartedRunKeys: ["run:q1", "run:q2", "run:r1", "run:resume1"],
      orphanedThreadRuns: 1,
      failedOrphanedRuns: 1,
      failedRunKeys: ["run:orphaned"],
      clearedInvalidHandoffs: 2,
      queuedRunsIdled: 1,
    }),
    teamThreadStore: {
      async list() {
        return [];
      },
    } as any,
    flowLedgerStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    roleRunStore: {
      async listByThread() {
        return [];
      },
    } as any,
    runtimeChainStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainStatusStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainSpanStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeChainEventStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeProgressStore: {
      async listByThread() {
        return [];
      },
      async listByChain() {
        return [];
      },
    } as any,
    recoveryRunStore: {
      async get() {
        return null;
      },
      async listByThread() {
        return [];
      },
    } as any,
    recoveryRunEventStore: {
      async listByRecoveryRun() {
        return [];
      },
    } as any,
    loadRecoveryRuntime: async () => ({
      records: [],
      report: {} as never,
      runs: [],
    }),
  });

  const report = await service.loadRuntimeSummary(null, 10);

  assert.deepEqual(report.roleRunStartupRecovery, {
    totalRoleRuns: 5,
    restartedQueuedRuns: 2,
    restartedRunningRuns: 1,
    restartedResumingRuns: 1,
    restartedRunKeys: ["run:q1", "run:q2", "run:r1", "run:resume1"],
    orphanedThreadRuns: 1,
    failedOrphanedRuns: 1,
    failedRunKeys: ["run:orphaned"],
    clearedInvalidHandoffs: 2,
    queuedRunsIdled: 1,
  });
});

test("runtime query service attaches flow recovery startup reconcile summary when available", async () => {
  const service = createRuntimeQueryService({
    clock: { now: () => 1000 },
    workerRuntime: {
      async spawn() {
        return null;
      },
      async send() {
        return null;
      },
      async resume() {
        return null;
      },
      async interrupt() {
        return null;
      },
      async cancel() {
        return null;
      },
      async getState() {
        return null;
      },
      async maybeRunForRole() {
        return null;
      },
    },
    getFlowRecoveryStartupReconcileResult: () => ({
      orphanedFlows: 1,
      abortedOrphanedFlows: 1,
      orphanedRecoveryRuns: 1,
      missingFlowRecoveryRuns: 2,
      crossThreadFlowRecoveryRuns: 1,
      failedRecoveryRuns: 3,
      affectedFlowIds: ["flow:1"],
      affectedRecoveryRunIds: ["recovery:1", "recovery:2", "recovery:3"],
    }),
    teamThreadStore: {
      async list() {
        return [];
      },
    } as any,
    flowLedgerStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    roleRunStore: {
      async listByThread() {
        return [];
      },
    } as any,
    runtimeChainStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainStatusStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainSpanStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeChainEventStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeProgressStore: {
      async listByThread() {
        return [];
      },
      async listByChain() {
        return [];
      },
    } as any,
    recoveryRunStore: {
      async get() {
        return null;
      },
      async listByThread() {
        return [];
      },
    } as any,
    recoveryRunEventStore: {
      async listByRecoveryRun() {
        return [];
      },
    } as any,
    loadRecoveryRuntime: async () => ({
      records: [],
      report: {} as never,
      runs: [],
    }),
  });

  const report = await service.loadRuntimeSummary(null, 10);

  assert.deepEqual(report.flowRecoveryStartupReconcile, {
    orphanedFlows: 1,
    abortedOrphanedFlows: 1,
    orphanedRecoveryRuns: 1,
    missingFlowRecoveryRuns: 2,
    crossThreadFlowRecoveryRuns: 1,
    failedRecoveryRuns: 3,
    affectedFlowIds: ["flow:1"],
    affectedRecoveryRunIds: ["recovery:1", "recovery:2", "recovery:3"],
  });
});

test("runtime query service attaches runtime chain startup reconcile summary when available", async () => {
  const service = createRuntimeQueryService({
    clock: { now: () => 1000 },
    workerRuntime: {
      async spawn() {
        return null;
      },
      async send() {
        return null;
      },
      async resume() {
        return null;
      },
      async interrupt() {
        return null;
      },
      async cancel() {
        return null;
      },
      async getState() {
        return null;
      },
      async maybeRunForRole() {
        return null;
      },
    },
    getRuntimeChainStartupReconcileResult: () => ({
      orphanedThreadChains: 1,
      missingFlowChains: 2,
      crossThreadFlowChains: 1,
      affectedChainIds: ["chain:1", "chain:2"],
    }),
    teamThreadStore: {
      async list() {
        return [];
      },
    } as any,
    flowLedgerStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    roleRunStore: {
      async listByThread() {
        return [];
      },
    } as any,
    runtimeChainStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainStatusStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainSpanStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeChainEventStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeProgressStore: {
      async listByThread() {
        return [];
      },
      async listByChain() {
        return [];
      },
    } as any,
    recoveryRunStore: {
      async get() {
        return null;
      },
      async listByThread() {
        return [];
      },
    } as any,
    recoveryRunEventStore: {
      async listByRecoveryRun() {
        return [];
      },
    } as any,
    loadRecoveryRuntime: async () => ({
      records: [],
      report: {} as never,
      runs: [],
    }),
  });

  const report = await service.loadRuntimeSummary(null, 10);

  assert.deepEqual(report.runtimeChainStartupReconcile, {
    orphanedThreadChains: 1,
    missingFlowChains: 2,
    crossThreadFlowChains: 1,
    affectedChainIds: ["chain:1", "chain:2"],
  });
});

test("runtime query service attaches runtime chain artifact startup reconcile summary when available", async () => {
  const service = createRuntimeQueryService({
    clock: { now: () => 1000 },
    workerRuntime: {
      async spawn() {
        return null;
      },
      async send() {
        return null;
      },
      async resume() {
        return null;
      },
      async interrupt() {
        return null;
      },
      async cancel() {
        return null;
      },
      async getState() {
        return null;
      },
      async maybeRunForRole() {
        return null;
      },
    },
    getRuntimeChainArtifactStartupReconcileResult: () => ({
      orphanedStatuses: 1,
      crossThreadStatuses: 1,
      orphanedSpans: 2,
      crossThreadSpans: 1,
      crossFlowSpans: 1,
      orphanedEvents: 1,
      missingSpanEvents: 2,
      crossThreadEvents: 1,
      crossChainEvents: 1,
      affectedChainIds: ["chain:1", "chain:2"],
    }),
    teamThreadStore: {
      async list() {
        return [];
      },
    } as any,
    flowLedgerStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    roleRunStore: {
      async listByThread() {
        return [];
      },
    } as any,
    runtimeChainStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainStatusStore: {
      async listByThread() {
        return [];
      },
      async get() {
        return null;
      },
    } as any,
    runtimeChainSpanStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeChainEventStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeProgressStore: {
      async listByThread() {
        return [];
      },
      async listByChain() {
        return [];
      },
    } as any,
    recoveryRunStore: {
      async get() {
        return null;
      },
      async listByThread() {
        return [];
      },
    } as any,
    recoveryRunEventStore: {
      async listByRecoveryRun() {
        return [];
      },
    } as any,
    loadRecoveryRuntime: async () => ({
      records: [],
      report: {} as never,
      runs: [],
    }),
  });

  const report = await service.loadRuntimeSummary(null, 10);

  assert.deepEqual(report.runtimeChainArtifactStartupReconcile, {
    orphanedStatuses: 1,
    crossThreadStatuses: 1,
    orphanedSpans: 2,
    crossThreadSpans: 1,
    crossFlowSpans: 1,
    orphanedEvents: 1,
    missingSpanEvents: 2,
    crossThreadEvents: 1,
    crossChainEvents: 1,
    affectedChainIds: ["chain:1", "chain:2"],
  });
});
