import assert from "node:assert/strict";
import test from "node:test";

import type {
  FlowLedger,
  FlowLedgerStore,
  HandoffEnvelope,
  RoleRunCoordinator,
  RoleRunState,
  RoleRunStore,
  TeamMessageStore,
  TeamThread,
  TeamThreadStore,
} from "@turnkeyai/core-types/team";

import { InlineRoleLoopRunner } from "./inline-role-loop-runner";

test("inline role loop runner persists worker bindings returned by the role runtime", async () => {
  const runKey = "role:role-operator:thread:thread-1";
  const handoff: HandoffEnvelope = {
    taskId: "task-1",
    flowId: "flow-1",
    sourceMessageId: "msg-1",
    targetRoleId: "role-operator",
    activationType: "mention",
    threadId: "thread-1",
    payload: {
      threadId: "thread-1",
      relayBrief: "Continue using the browser worker.",
      recentMessages: [],
      dispatchPolicy: {
        allowParallel: false,
        allowReenter: true,
        sourceFlowMode: "serial",
      },
    },
    createdAt: 1,
  };

  const runState: RoleRunState = {
    runKey,
    threadId: "thread-1",
    roleId: "role-operator",
    mode: "group",
    status: "queued",
    iterationCount: 0,
    maxIterations: 6,
    inbox: [handoff],
    lastActiveAt: 1,
  };

  const roleRunStore: RoleRunStore = {
    async get(key) {
      return key === runKey ? runState : null;
    },
    async put(next) {
      Object.assign(runState, next);
    },
    async delete() {},
    async listByThread() {
      return [runState];
    },
  };

  const flow: FlowLedger = {
    flowId: "flow-1",
    threadId: "thread-1",
    rootMessageId: "msg-root",
    mode: "serial",
    status: "running",
    currentStageIndex: 0,
    activeRoleIds: ["role-operator"],
    completedRoleIds: [],
    failedRoleIds: [],
    hopCount: 0,
    maxHops: 5,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const flowLedgerStore: FlowLedgerStore = {
    async get(flowId) {
      return flowId === flow.flowId ? flow : null;
    },
    async put() {},
    async listByThread() {
      return [flow];
    },
  };

  const thread: TeamThread = {
    threadId: "thread-1",
    teamId: "team-1",
    teamName: "Demo",
    leadRoleId: "role-lead",
    roles: [
      { roleId: "role-lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "role-operator", name: "Operator", seat: "member", runtime: "local", capabilities: ["browser"] },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  const teamThreadStore: TeamThreadStore = {
    async get(threadId) {
      return threadId === thread.threadId ? thread : null;
    },
    async list() {
      return [thread];
    },
    async create() {
      throw new Error("not used");
    },
    async update() {
      throw new Error("not used");
    },
    async delete() {},
  };

  const boundSessions: Array<{ workerType: string; workerRunKey: string }> = [];
  const roleRunCoordinator: RoleRunCoordinator = {
    async getOrCreate() {
      return runState;
    },
    async enqueue(_, nextHandoff) {
      runState.inbox.push(nextHandoff);
      return runState;
    },
    async dequeue() {
      return runState.inbox.shift() ?? null;
    },
    async ack(_, taskId) {
      runState.lastDequeuedTaskId = taskId;
    },
    async bindWorkerSession(_, workerType, workerRunKey) {
      boundSessions.push({ workerType, workerRunKey });
      runState.workerSessions = {
        ...(runState.workerSessions ?? {}),
        [workerType]: workerRunKey,
      };
    },
    async clearWorkerSession() {},
    async setStatus(_, status) {
      runState.status = status;
    },
    async incrementIteration() {
      runState.iterationCount += 1;
      return runState.iterationCount;
    },
    async fail(_, error) {
      runState.status = "failed";
      if (!error.retryable) {
        runState.lastUserTouchAt = Date.now();
      }
    },
    async finish() {
      runState.status = "done";
    },
  };

  const runner = new InlineRoleLoopRunner({
    roleRunStore,
    flowLedgerStore,
    teamThreadStore,
    teamMessageStore: {
      async append() {},
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    } as TeamMessageStore,
    roleRunCoordinator,
    roleRuntime: {
      async runActivation() {
        return {
          status: "ok",
          workerBindings: [{ workerType: "browser", workerRunKey: "worker-run-1" }],
          message: {
            id: "msg-operator-1",
            threadId: "thread-1",
            role: "assistant",
            roleId: "role-operator",
            name: "Operator",
            content: "Done.",
            createdAt: 2,
            updatedAt: 2,
          },
        };
      },
    },
    onHandoffAck: async () => {},
    onRoleReply: async () => {},
    onRoleFailure: async () => {
      throw new Error("not used");
    },
  });

  await runner.ensureRunning(runKey);

  assert.deepEqual(boundSessions, [{ workerType: "browser", workerRunKey: "worker-run-1" }]);
  assert.deepEqual(runState.workerSessions, { browser: "worker-run-1" });
});

test("inline role loop runner emits runtime progress for worker-waiting transitions", async () => {
  const runKey = "role:role-operator:thread:thread-2";
  const handoff: HandoffEnvelope = {
    taskId: "task-2",
    flowId: "flow-2",
    sourceMessageId: "msg-2",
    targetRoleId: "role-operator",
    activationType: "mention",
    threadId: "thread-2",
    payload: {
      threadId: "thread-2",
      relayBrief: "Continue.",
      recentMessages: [],
      dispatchPolicy: {
        allowParallel: false,
        allowReenter: true,
        sourceFlowMode: "serial",
      },
    },
    createdAt: 2,
  };
  const runState: RoleRunState = {
    runKey,
    threadId: "thread-2",
    roleId: "role-operator",
    mode: "group",
    status: "queued",
    iterationCount: 0,
    maxIterations: 6,
    inbox: [handoff],
    lastActiveAt: 2,
  };
  const recordedPhases: string[] = [];

  const runner = new InlineRoleLoopRunner({
    roleRunStore: {
      async get(key) {
        return key === runKey ? runState : null;
      },
      async put(next) {
        Object.assign(runState, next);
      },
      async delete() {},
      async listByThread() {
        return [runState];
      },
    },
    flowLedgerStore: {
      async get() {
        return {
          flowId: "flow-2",
          threadId: "thread-2",
          rootMessageId: "msg-root",
          mode: "serial",
          status: "running",
          currentStageIndex: 0,
          activeRoleIds: ["role-operator"],
          completedRoleIds: [],
          failedRoleIds: [],
          hopCount: 0,
          maxHops: 5,
          edges: [],
          createdAt: 1,
          updatedAt: 2,
        };
      },
      async put() {},
      async listByThread() {
        return [];
      },
    },
    teamThreadStore: {
      async get() {
        return {
          threadId: "thread-2",
          teamId: "team-1",
          teamName: "Demo",
          leadRoleId: "role-lead",
          roles: [
            { roleId: "role-lead", name: "Lead", seat: "lead", runtime: "local" },
            { roleId: "role-operator", name: "Operator", seat: "member", runtime: "local" },
          ],
          participantLinks: [],
          metadataVersion: 1,
          createdAt: 1,
          updatedAt: 1,
        };
      },
      async list() {
        return [];
      },
      async create() {
        throw new Error("not used");
      },
      async update() {
        throw new Error("not used");
      },
      async delete() {},
    },
    teamMessageStore: {
      async append() {},
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    } as TeamMessageStore,
    roleRunCoordinator: {
      async getOrCreate() {
        return runState;
      },
      async enqueue(_, nextHandoff) {
        runState.inbox.push(nextHandoff);
        return runState;
      },
      async dequeue() {
        return runState.inbox.shift() ?? null;
      },
      async ack(_, taskId) {
        runState.lastDequeuedTaskId = taskId;
      },
      async bindWorkerSession() {},
      async clearWorkerSession() {},
      async setStatus(_, status) {
        runState.status = status;
      },
      async incrementIteration() {
        runState.iterationCount += 1;
        return runState.iterationCount;
      },
      async fail() {
        runState.status = "failed";
      },
      async finish() {
        runState.status = "done";
      },
    },
    roleRuntime: {
      async runActivation() {
        return {
          status: "delegated",
          workerBindings: [{ workerType: "browser", workerRunKey: "worker-run-2" }],
        };
      },
    },
    onHandoffAck: async () => {},
    onRoleReply: async () => {},
    onRoleFailure: async () => {},
    runtimeProgressRecorder: {
      async record(event) {
        recordedPhases.push(event.phase);
      },
    },
  });

  await runner.ensureRunning(runKey);

  assert.deepEqual(recordedPhases, ["started", "waiting"]);
});

test("inline role loop runner emits long-running heartbeat ticks while a role stays active", async () => {
  const runKey = "role:role-operator:thread:thread-heartbeat";
  const handoff: HandoffEnvelope = {
    taskId: "task-heartbeat",
    flowId: "flow-heartbeat",
    sourceMessageId: "msg-heartbeat",
    targetRoleId: "role-operator",
    activationType: "mention",
    threadId: "thread-heartbeat",
    payload: {
      threadId: "thread-heartbeat",
      relayBrief: "Keep running.",
      recentMessages: [],
      dispatchPolicy: {
        allowParallel: false,
        allowReenter: true,
        sourceFlowMode: "serial",
      },
    },
    createdAt: 1,
  };
  const runState: RoleRunState = {
    runKey,
    threadId: "thread-heartbeat",
    roleId: "role-operator",
    mode: "group",
    status: "queued",
    iterationCount: 0,
    maxIterations: 4,
    inbox: [handoff],
    lastActiveAt: 1,
  };
  const phases: string[] = [];

  const runner = new InlineRoleLoopRunner({
    roleRunStore: {
      async get(key) {
        return key === runKey ? runState : null;
      },
      async put(next) {
        Object.assign(runState, next);
      },
      async delete() {},
      async listByThread() {
        return [runState];
      },
    },
    flowLedgerStore: {
      async get() {
        return {
          flowId: "flow-heartbeat",
          threadId: "thread-heartbeat",
          rootMessageId: "msg-root",
          mode: "serial",
          status: "running",
          currentStageIndex: 0,
          activeRoleIds: ["role-operator"],
          completedRoleIds: [],
          failedRoleIds: [],
          hopCount: 0,
          maxHops: 4,
          edges: [],
          createdAt: 1,
          updatedAt: 1,
        };
      },
      async put() {},
      async listByThread() {
        return [];
      },
    },
    teamThreadStore: {
      async get() {
        return {
          threadId: "thread-heartbeat",
          teamId: "team-1",
          teamName: "Demo",
          leadRoleId: "role-lead",
          roles: [
            { roleId: "role-lead", name: "Lead", seat: "lead", runtime: "local" },
            { roleId: "role-operator", name: "Operator", seat: "member", runtime: "local" },
          ],
          participantLinks: [],
          metadataVersion: 1,
          createdAt: 1,
          updatedAt: 1,
        };
      },
      async list() {
        return [];
      },
      async create() {
        throw new Error("not used");
      },
      async update() {
        throw new Error("not used");
      },
      async delete() {},
    },
    teamMessageStore: {
      async append() {},
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    } as TeamMessageStore,
    roleRunCoordinator: {
      async getOrCreate() {
        return runState;
      },
      async enqueue() {
        return runState;
      },
      async dequeue() {
        return runState.inbox.shift() ?? null;
      },
      async ack(_, taskId) {
        runState.lastDequeuedTaskId = taskId;
      },
      async bindWorkerSession() {},
      async clearWorkerSession() {},
      async setStatus(_, status) {
        runState.status = status;
      },
      async incrementIteration() {
        runState.iterationCount += 1;
        return runState.iterationCount;
      },
      async fail() {
        runState.status = "failed";
      },
      async finish() {
        runState.status = "done";
      },
    },
    roleRuntime: {
      async runActivation() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          status: "ok",
          message: {
            id: "msg-done",
            threadId: "thread-heartbeat",
            role: "assistant",
            roleId: "role-operator",
            name: "Operator",
            content: "Done.",
            createdAt: 2,
            updatedAt: 2,
          },
        };
      },
    },
    onHandoffAck: async () => {},
    onRoleReply: async () => {},
    onRoleFailure: async () => {
      throw new Error("not used");
    },
    runtimeProgressRecorder: {
      async record(event) {
        phases.push(event.phase);
      },
    },
    heartbeatIntervalMs: 5,
  });

  await runner.ensureRunning(runKey);

  assert.ok(phases.includes("heartbeat"));
});

test("inline role loop runner ignores heartbeat recorder failures", async () => {
  const runKey = "role:role-operator:thread:thread-heartbeat-failure";
  const handoff: HandoffEnvelope = {
    taskId: "task-heartbeat-failure",
    flowId: "flow-heartbeat-failure",
    sourceMessageId: "msg-heartbeat-failure",
    targetRoleId: "role-operator",
    activationType: "mention",
    threadId: "thread-heartbeat-failure",
    payload: {
      threadId: "thread-heartbeat-failure",
      relayBrief: "Continue.",
      recentMessages: [],
      dispatchPolicy: {
        allowParallel: false,
        allowReenter: true,
        sourceFlowMode: "serial",
      },
    },
    createdAt: 1,
  };
  const runState: RoleRunState = {
    runKey,
    threadId: "thread-heartbeat-failure",
    roleId: "role-operator",
    mode: "group",
    status: "queued",
    iterationCount: 0,
    maxIterations: 6,
    inbox: [handoff],
    lastActiveAt: 1,
  };

  const runner = new InlineRoleLoopRunner({
    roleRunStore: {
      async get(key) {
        return key === runKey ? runState : null;
      },
      async put(next) {
        Object.assign(runState, next);
      },
      async delete() {},
      async listByThread() {
        return [runState];
      },
    },
    flowLedgerStore: {
      async get() {
        return {
          flowId: "flow-heartbeat-failure",
          threadId: "thread-heartbeat-failure",
          rootMessageId: "msg-root",
          mode: "serial",
          status: "running",
          currentStageIndex: 0,
          activeRoleIds: ["role-operator"],
          completedRoleIds: [],
          failedRoleIds: [],
          hopCount: 0,
          maxHops: 4,
          edges: [],
          createdAt: 1,
          updatedAt: 1,
        };
      },
      async put() {},
      async listByThread() {
        return [];
      },
    },
    teamThreadStore: {
      async get() {
        return {
          threadId: "thread-heartbeat-failure",
          teamId: "team-1",
          teamName: "Demo",
          leadRoleId: "role-lead",
          roles: [
            { roleId: "role-lead", name: "Lead", seat: "lead", runtime: "local" },
            { roleId: "role-operator", name: "Operator", seat: "member", runtime: "local" },
          ],
          participantLinks: [],
          metadataVersion: 1,
          createdAt: 1,
          updatedAt: 1,
        };
      },
      async list() {
        return [];
      },
      async create() {
        throw new Error("not used");
      },
      async update() {
        throw new Error("not used");
      },
      async delete() {},
    },
    teamMessageStore: {
      async append() {},
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    } as TeamMessageStore,
    roleRunCoordinator: {
      async getOrCreate() {
        return runState;
      },
      async enqueue() {
        return runState;
      },
      async dequeue() {
        return runState.inbox.shift() ?? null;
      },
      async ack(_, taskId) {
        runState.lastDequeuedTaskId = taskId;
      },
      async bindWorkerSession() {},
      async clearWorkerSession() {},
      async setStatus(_, status) {
        runState.status = status;
      },
      async incrementIteration() {
        runState.iterationCount += 1;
        return runState.iterationCount;
      },
      async fail() {
        runState.status = "failed";
      },
      async finish() {
        runState.status = "done";
      },
    },
    roleRuntime: {
      async runActivation() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          status: "ok",
          message: {
            id: "msg-done",
            threadId: "thread-heartbeat-failure",
            role: "assistant",
            roleId: "role-operator",
            name: "Operator",
            content: "Done.",
            createdAt: 2,
            updatedAt: 2,
          },
        };
      },
    },
    onHandoffAck: async () => {},
    onRoleReply: async () => {},
    onRoleFailure: async () => {
      throw new Error("not used");
    },
    runtimeProgressRecorder: {
      async record(event) {
        if (event.phase === "heartbeat") {
          throw new Error("heartbeat recorder unavailable");
        }
      },
    },
    heartbeatIntervalMs: 5,
  });

  await runner.ensureRunning(runKey);
  assert.equal(runState.status, "idle");
});
