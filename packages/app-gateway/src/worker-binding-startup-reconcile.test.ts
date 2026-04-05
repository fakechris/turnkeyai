import assert from "node:assert/strict";
import test from "node:test";

import type {
  RoleRunState,
  TeamThread,
  WorkerRuntime,
  WorkerSessionRecord,
} from "@turnkeyai/core-types/team";

import { reconcileWorkerBindingsOnStartup } from "./worker-binding-startup-reconcile";

test("worker binding startup reconcile clears missing, terminal, and cross-thread bindings", async () => {
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
          runKey: "run:1",
          threadId: "thread-1",
          roleId: "role-1",
          mode: "group",
          status: "waiting_worker",
          iterationCount: 1,
          maxIterations: 4,
          inbox: [],
          lastActiveAt: 10,
          workerSessions: {
            browser: "worker:bound",
            finance: "worker:missing",
            explore: "worker:terminal",
          },
        },
        {
          runKey: "run:2",
          threadId: "thread-1",
          roleId: "role-2",
          mode: "group",
          status: "resuming",
          iterationCount: 1,
          maxIterations: 4,
          inbox: [],
          lastActiveAt: 11,
          workerSessions: {
            browser: "worker:cross-thread",
          },
        },
      ],
    ],
    ["thread-2", []],
  ]);
  const persisted = new Map<string, RoleRunState>();
  const workerSessions: WorkerSessionRecord[] = [
    {
      workerRunKey: "worker:bound",
      executionToken: 1,
      state: {
        workerRunKey: "worker:bound",
        workerType: "browser",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
      },
      context: {
        threadId: "thread-1",
        flowId: "flow-1",
        taskId: "task-1",
        roleId: "role-1",
        parentSpanId: "role:1",
      },
    },
    {
      workerRunKey: "worker:terminal",
      executionToken: 1,
      state: {
        workerRunKey: "worker:terminal",
        workerType: "explore",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
      },
      context: {
        threadId: "thread-1",
        flowId: "flow-1",
        taskId: "task-2",
        roleId: "role-1",
        parentSpanId: "role:1",
      },
    },
    {
      workerRunKey: "worker:cross-thread",
      executionToken: 1,
      state: {
        workerRunKey: "worker:cross-thread",
        workerType: "browser",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
      },
      context: {
        threadId: "thread-2",
        flowId: "flow-2",
        taskId: "task-3",
        roleId: "role-3",
        parentSpanId: "role:3",
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

  const result = await reconcileWorkerBindingsOnStartup({
    teamThreadStore: {
      async list() {
        return threads;
      },
    } as any,
    roleRunStore: {
      async listByThread(threadId: string) {
        return roleRuns.get(threadId) ?? [];
      },
      async put(runState: RoleRunState) {
        persisted.set(runState.runKey, runState);
      },
    } as any,
    workerRuntime,
  });

  assert.deepEqual(result, {
    totalRoleRuns: 2,
    totalBindings: 4,
    clearedMissingBindings: 1,
    clearedTerminalBindings: 1,
    clearedCrossThreadBindings: 1,
    roleRunsNeedingAttention: 1,
    roleRunsRequeued: 0,
    roleRunsFailed: 1,
  });
  assert.deepEqual(persisted.get("run:1")?.workerSessions, {
    browser: "worker:bound",
  });
  assert.deepEqual(persisted.get("run:2")?.workerSessions, {});
  assert.equal(persisted.get("run:2")?.status, "failed");
});
