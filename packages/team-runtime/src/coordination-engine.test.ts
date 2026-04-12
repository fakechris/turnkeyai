import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  FlowLedger,
  FlowLedgerStore,
  HandoffEnvelope,
  HandoffPlanner,
  ReplayRecord,
  RecoveryDirector,
  RuntimeChainRecorder,
  RoleLoopRunner,
  RoleRunCoordinator,
  RoleRunState,
  SummaryBuilder,
  TeamMessage,
  TeamMessageStore,
  TeamThread,
  TeamThreadStore,
  WorkerRuntime,
} from "@turnkeyai/core-types/team";
import { buildReplayInspectionReport } from "@turnkeyai/qc-runtime/replay-inspection";

import { CoordinationEngine } from "./coordination-engine";
import { FileBatchOutbox } from "./file-batch-outbox";

test("coordination engine aborts flow when hop limit is reached before dispatch", async () => {
  const thread: TeamThread = {
    threadId: "thread-1",
    teamId: "team-1",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [
      { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "operator", name: "Operator", seat: "member", runtime: "local" },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  const sourceMessage: TeamMessage = {
    id: "msg-1",
    threadId: thread.threadId,
    role: "assistant",
    roleId: "lead",
    name: "Lead",
    content: "@{operator} Please continue",
    createdAt: 1,
    updatedAt: 1,
  };

  let storedFlow: FlowLedger = {
    flowId: "flow-1",
    threadId: thread.threadId,
    rootMessageId: "msg-0",
    mode: "serial",
    status: "running",
    currentStageIndex: 0,
    activeRoleIds: [],
    completedRoleIds: [],
    failedRoleIds: [],
    nextExpectedRoleId: "lead",
    hopCount: 1,
    maxHops: 1,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const flowLedgerStore: FlowLedgerStore = {
    async get(flowId) {
      return flowId === storedFlow.flowId ? storedFlow : null;
    },
    async put(flow) {
      storedFlow = flow;
    },
    async listByThread(threadId) {
      return threadId === storedFlow.threadId ? [storedFlow] : [];
    },
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

  const teamMessageStore: TeamMessageStore = {
    async append() {},
    async list() {
      return [sourceMessage];
    },
    async get() {
      return null;
    },
  };

  let ensureRunningCalled = false;
  const roleLoopRunner: RoleLoopRunner = {
    async ensureRunning() {
      ensureRunningCalled = true;
    },
  };

  const roleRunCoordinator: RoleRunCoordinator = {
    async getOrCreate(): Promise<RoleRunState> {
      throw new Error("should not create run when hop limit is reached");
    },
    async enqueue() {
      throw new Error("should not enqueue when hop limit is reached");
    },
    async dequeue() {
      return null;
    },
    async ack() {},
    async bindWorkerSession() {},
    async clearWorkerSession() {},
    async setStatus() {},
    async incrementIteration() {
      return 0;
    },
    async fail() {},
    async finish() {},
  };

  const handoffPlanner: HandoffPlanner = {
    parseMentions() {
      return [];
    },
    async validateMentionTargets() {
      return { allowed: true, mode: "serial", targetRoleIds: [] };
    },
    async buildHandoffs() {
      return [];
    },
  };

  const recoveryDirector: RecoveryDirector = {
    async onUserMessage() {
      return { action: "complete" };
    },
    async onRoleReply() {
      return { action: "complete" };
    },
    async onRoleFailure() {
      return { action: "abort", reason: "fail" };
    },
  };

  const summaryBuilder: SummaryBuilder = {
    async getRecentMessages() {
      return [];
    },
  };

  const engine = new CoordinationEngine({
    teamThreadStore,
    teamMessageStore,
    flowLedgerStore,
    roleRunCoordinator,
    handoffPlanner,
    recoveryDirector,
    roleLoopRunner,
    summaryBuilder,
    relayBriefBuilder: {
      build() {
        return "brief";
      },
    },
    idGenerator: {
      flowId: () => "flow-generated",
      messageId: () => "msg-generated",
      taskId: () => "task-generated",
    },
    runtimeLimits: {
      flowMaxHops: 1,
    },
    clock: {
      now: () => 2,
    },
  });

  await engine.dispatchToRole({
    thread,
    flow: storedFlow,
    sourceMessage,
    fromRoleId: "lead",
    toRoleId: "operator",
    activationType: "mention",
  });

  assert.equal(storedFlow.status, "aborted");
  assert.equal(ensureRunningCalled, false);
});

test("coordination engine caps and truncates recent messages before dispatch payloads", async () => {
  const thread: TeamThread = {
    threadId: "thread-cap",
    teamId: "team-cap",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [
      { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "operator", name: "Operator", seat: "member", runtime: "local" },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  let storedFlow: FlowLedger | null = null;
  const enqueued: HandoffEnvelope[] = [];
  const flowLedgerStore: FlowLedgerStore = {
    async get(flowId) {
      return storedFlow?.flowId === flowId ? storedFlow : null;
    },
    async put(flow) {
      storedFlow = flow;
    },
    async listByThread() {
      return storedFlow ? [storedFlow] : [];
    },
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
  const teamMessageStore: TeamMessageStore = {
    async append() {},
    async list() {
      return [];
    },
    async get() {
      return null;
    },
  };
  const summaryBuilder: SummaryBuilder = {
    async getRecentMessages(_threadId, limit) {
      assert.equal(limit, 8);
      return Array.from({ length: 12 }, (_, index) => ({
        messageId: `msg-${index + 1}`,
        role: index % 2 === 0 ? "user" : "assistant",
        name: index % 2 === 0 ? "user" : "Lead",
        content: `Recent message ${index + 1}: ${"x".repeat(400)}`,
        createdAt: index + 1,
      }));
    },
  };
  const roleRunCoordinator: RoleRunCoordinator = {
    async getOrCreate() {
      return {
        runKey: "role:lead:thread:thread-cap",
        threadId: thread.threadId,
        roleId: "lead",
        mode: "group",
        status: "running",
        iterationCount: 0,
        maxIterations: 3,
        inbox: [],
        updatedAt: 1,
        lastActiveAt: 1,
      };
    },
    async enqueue(_, handoff) {
      enqueued.push(handoff);
      return {
        runKey: "role:lead:thread:thread-cap",
        threadId: thread.threadId,
        roleId: "lead",
        mode: "group",
        status: "queued",
        iterationCount: 0,
        maxIterations: 3,
        inbox: [handoff],
        updatedAt: 1,
        lastActiveAt: 1,
      };
    },
    async dequeue() {
      return null;
    },
    async ack() {},
    async bindWorkerSession() {},
    async clearWorkerSession() {},
    async setStatus() {},
    async incrementIteration() {
      return 0;
    },
    async fail() {},
    async finish() {},
  };
  const engine = new CoordinationEngine({
    teamThreadStore,
    teamMessageStore,
    flowLedgerStore,
    roleRunCoordinator,
    handoffPlanner: {
      parseMentions() {
        return [];
      },
      async validateMentionTargets() {
        return { allowed: true, mode: "serial", targetRoleIds: [] };
      },
      async buildHandoffs() {
        return [];
      },
    },
    recoveryDirector: {
      async onUserMessage() {
        return null;
      },
      async onRoleReply() {
        return null;
      },
      async onRoleFailure() {
        return null;
      },
    } as unknown as RecoveryDirector,
    roleLoopRunner: {
      async ensureRunning() {},
    },
    summaryBuilder,
    relayBriefBuilder: {
      build(input) {
        return (input.recentMessages ?? []).map((message) => message.content).join("\n");
      },
    },
    idGenerator: {
      flowId: () => "flow-cap",
      messageId: () => "msg-user",
      taskId: () => "task-cap",
    },
    runtimeLimits: {
      flowMaxHops: 6,
    },
    clock: {
      now: () => 1,
    },
  });

  await engine.handleUserPost({
    threadId: thread.threadId,
    content: "Start the capped dispatch.",
  });

  const firstHandoff = enqueued[0];
  assert.ok(firstHandoff);
  const recentMessages = firstHandoff.payload.recentMessages ?? [];
  assert.equal(enqueued.length, 1);
  assert.equal(recentMessages.length, 8);
  assert.equal(firstHandoff.payload.intent?.recentMessages.length, 8);
  assert.ok((recentMessages[0]?.content.length ?? 0) <= 320);
  assert.match(recentMessages[0]?.content ?? "", /…$/);
});

test("coordination engine dedupes repeated handoffs and advances edge state to closed", async () => {
  const thread: TeamThread = {
    threadId: "thread-2",
    teamId: "team-2",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [
      { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "operator", name: "Operator", seat: "member", runtime: "local" },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  const sourceMessage: TeamMessage = {
    id: "msg-source",
    threadId: thread.threadId,
    role: "assistant",
    roleId: "lead",
    name: "Lead",
    content: "@{operator} Please continue",
    createdAt: 1,
    updatedAt: 1,
  };

  const replyMessage: TeamMessage = {
    id: "msg-reply",
    threadId: thread.threadId,
    role: "assistant",
    roleId: "operator",
    name: "Operator",
    content: "Handled",
    createdAt: 2,
    updatedAt: 2,
  };

  let storedFlow: FlowLedger = {
    flowId: "flow-2",
    threadId: thread.threadId,
    rootMessageId: "msg-root",
    mode: "serial",
    status: "running",
    currentStageIndex: 0,
    activeRoleIds: [],
    completedRoleIds: [],
    failedRoleIds: [],
    nextExpectedRoleId: "lead",
    hopCount: 0,
    maxHops: 5,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const flowLedgerStore: FlowLedgerStore = {
    async get(flowId) {
      return flowId === storedFlow.flowId ? storedFlow : null;
    },
    async put(flow) {
      storedFlow = flow;
    },
    async listByThread(threadId) {
      return threadId === storedFlow.threadId ? [storedFlow] : [];
    },
  };

  const appendedMessages: TeamMessage[] = [];
  const teamMessageStore: TeamMessageStore = {
    async append(message) {
      appendedMessages.push(message);
    },
    async list() {
      return [sourceMessage];
    },
    async get() {
      return null;
    },
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

  let ensureRunningCalls = 0;
  const roleLoopRunner: RoleLoopRunner = {
    async ensureRunning() {
      ensureRunningCalls += 1;
    },
  };

  const roleRunState: RoleRunState = {
    runKey: "role:operator:thread:thread-2",
    threadId: thread.threadId,
    roleId: "operator",
    mode: "group",
    status: "idle",
    iterationCount: 0,
    maxIterations: 6,
    inbox: [],
    lastActiveAt: 1,
  };

  const roleRunCoordinator: RoleRunCoordinator = {
    async getOrCreate() {
      return roleRunState;
    },
    async enqueue() {
      return roleRunState;
    },
    async dequeue() {
      return null;
    },
    async ack() {},
    async bindWorkerSession() {},
    async clearWorkerSession() {},
    async setStatus() {},
    async incrementIteration() {
      return 0;
    },
    async fail() {},
    async finish() {},
  };

  const handoffPlanner: HandoffPlanner = {
    parseMentions() {
      return [];
    },
    async validateMentionTargets() {
      return { allowed: true, mode: "serial", targetRoleIds: [] };
    },
    async buildHandoffs() {
      return [];
    },
  };

  const recoveryDirector: RecoveryDirector = {
    async onUserMessage() {
      return { action: "complete" };
    },
    async onRoleReply() {
      return { action: "complete" };
    },
    async onRoleFailure() {
      return { action: "abort", reason: "fail" };
    },
  };

  const summaryBuilder: SummaryBuilder = {
    async getRecentMessages() {
      return [];
    },
  };

  const engine = new CoordinationEngine({
    teamThreadStore,
    teamMessageStore,
    flowLedgerStore,
    roleRunCoordinator,
    handoffPlanner,
    recoveryDirector,
    roleLoopRunner,
    summaryBuilder,
    relayBriefBuilder: {
      build() {
        return "brief";
      },
    },
    idGenerator: {
      flowId: () => "flow-generated",
      messageId: () => "msg-generated",
      taskId: () => "task-1",
    },
    runtimeLimits: {
      flowMaxHops: 5,
    },
    clock: {
      now: () => 10,
    },
  });

  await engine.dispatchToRole({
    thread,
    flow: storedFlow,
    sourceMessage,
    fromRoleId: "lead",
    toRoleId: "operator",
    activationType: "mention",
  });

  await engine.dispatchToRole({
    thread,
    flow: storedFlow,
    sourceMessage,
    fromRoleId: "lead",
    toRoleId: "operator",
    activationType: "mention",
  });

  assert.equal(storedFlow.edges.length, 1);
  assert.equal(ensureRunningCalls, 1);
  assert.equal(storedFlow.edges[0]?.state, "delivered");

  await engine.onHandoffAck({ flowId: storedFlow.flowId, taskId: "task-1" });
  assert.equal(storedFlow.edges[0]?.state, "acked");

  await engine.handleRoleReply({
    flow: storedFlow,
    thread,
    runState: roleRunState,
    handoff: {
      taskId: "task-1",
      flowId: storedFlow.flowId,
      sourceMessageId: sourceMessage.id,
      sourceRoleId: "lead",
      targetRoleId: "operator",
      activationType: "mention",
      threadId: thread.threadId,
      payload: {
        threadId: thread.threadId,
        relayBrief: "brief",
        recentMessages: [],
        dispatchPolicy: {
          allowParallel: false,
          allowReenter: true,
          sourceFlowMode: "serial",
        },
      },
      createdAt: 1,
    },
    message: replyMessage,
  });

  assert.equal(appendedMessages.length, 1);
  assert.equal(storedFlow.edges[0]?.state, "closed");
  assert.equal(storedFlow.edges[0]?.respondedAt, 10);
  assert.equal(storedFlow.edges[0]?.closedAt, 10);

  await engine.onHandoffAck({ flowId: storedFlow.flowId, taskId: "task-1" });
  assert.equal(storedFlow.edges[0]?.state, "closed");
});

test("coordination engine does not abort flow at hop limit while roles are still active", async () => {
  const thread: TeamThread = {
    threadId: "thread-3",
    teamId: "team-3",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [
      { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "operator", name: "Operator", seat: "member", runtime: "local" },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  const sourceMessage: TeamMessage = {
    id: "msg-3",
    threadId: thread.threadId,
    role: "assistant",
    roleId: "lead",
    name: "Lead",
    content: "@{operator} Please continue",
    createdAt: 1,
    updatedAt: 1,
  };

  let storedFlow: FlowLedger = {
    flowId: "flow-3",
    threadId: thread.threadId,
    rootMessageId: "msg-root",
    mode: "serial",
    status: "waiting_role",
    currentStageIndex: 0,
    activeRoleIds: ["lead"],
    completedRoleIds: [],
    failedRoleIds: [],
    nextExpectedRoleId: "lead",
    hopCount: 2,
    maxHops: 2,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const flowLedgerStore: FlowLedgerStore = {
    async get(flowId) {
      return flowId === storedFlow.flowId ? storedFlow : null;
    },
    async put(flow) {
      storedFlow = flow;
    },
    async listByThread(threadId) {
      return threadId === storedFlow.threadId ? [storedFlow] : [];
    },
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

  const teamMessageStore: TeamMessageStore = {
    async append() {},
    async list() {
      return [sourceMessage];
    },
    async get() {
      return null;
    },
  };

  const roleLoopRunner: RoleLoopRunner = {
    async ensureRunning() {
      throw new Error("should not schedule new run when hop limit is reached");
    },
  };

  const roleRunCoordinator: RoleRunCoordinator = {
    async getOrCreate(): Promise<RoleRunState> {
      throw new Error("should not create run when hop limit is reached");
    },
    async enqueue() {
      throw new Error("should not enqueue when hop limit is reached");
    },
    async dequeue() {
      return null;
    },
    async ack() {},
    async bindWorkerSession() {},
    async clearWorkerSession() {},
    async setStatus() {},
    async incrementIteration() {
      return 0;
    },
    async fail() {},
    async finish() {},
  };

  const engine = buildEngine({
    teamThreadStore,
    teamMessageStore,
    flowLedgerStore,
    roleRunCoordinator,
    roleLoopRunner,
  });

  await engine.dispatchToRole({
    thread,
    flow: storedFlow,
    sourceMessage,
    fromRoleId: "lead",
    toRoleId: "operator",
    activationType: "mention",
  });

  assert.equal(storedFlow.status, "waiting_role");
  assert.deepEqual(storedFlow.activeRoleIds, ["lead"]);
});

test("coordination engine removes active role when run setup fails", async () => {
  const thread: TeamThread = {
    threadId: "thread-4",
    teamId: "team-4",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [
      { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "operator", name: "Operator", seat: "member", runtime: "local" },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  const sourceMessage: TeamMessage = {
    id: "msg-4",
    threadId: thread.threadId,
    role: "assistant",
    roleId: "lead",
    name: "Lead",
    content: "@{operator} Please continue",
    createdAt: 1,
    updatedAt: 1,
  };

  let storedFlow: FlowLedger = {
    flowId: "flow-4",
    threadId: thread.threadId,
    rootMessageId: "msg-root",
    mode: "serial",
    status: "running",
    currentStageIndex: 0,
    activeRoleIds: [],
    completedRoleIds: [],
    failedRoleIds: [],
    nextExpectedRoleId: "lead",
    hopCount: 0,
    maxHops: 5,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const flowLedgerStore: FlowLedgerStore = {
    async get(flowId) {
      return flowId === storedFlow.flowId ? storedFlow : null;
    },
    async put(flow) {
      storedFlow = flow;
    },
    async listByThread(threadId) {
      return threadId === storedFlow.threadId ? [storedFlow] : [];
    },
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

  const teamMessageStore: TeamMessageStore = {
    async append() {},
    async list() {
      return [sourceMessage];
    },
    async get() {
      return null;
    },
  };

  const roleLoopRunner: RoleLoopRunner = {
    async ensureRunning() {
      throw new Error("should not run after setup failure");
    },
  };

  const roleRunCoordinator: RoleRunCoordinator = {
    async getOrCreate(): Promise<RoleRunState> {
      throw new Error("coordinator setup failed");
    },
    async enqueue() {
      throw new Error("not used");
    },
    async dequeue() {
      return null;
    },
    async ack() {},
    async bindWorkerSession() {},
    async clearWorkerSession() {},
    async setStatus() {},
    async incrementIteration() {
      return 0;
    },
    async fail() {},
    async finish() {},
  };

  const engine = buildEngine({
    teamThreadStore,
    teamMessageStore,
    flowLedgerStore,
    roleRunCoordinator,
    roleLoopRunner,
  });

  await assert.rejects(() =>
    engine.dispatchToRole({
      thread,
      flow: storedFlow,
      sourceMessage,
      fromRoleId: "lead",
      toRoleId: "operator",
      activationType: "mention",
    })
  );

  assert.deepEqual(storedFlow.activeRoleIds, []);
  assert.equal(storedFlow.edges[0]?.state, "cancelled");
});

test("coordination engine retries persisted dispatch delivery through the outbox", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "coordination-engine-dispatch-outbox-"));
  try {
    const thread: TeamThread = {
      threadId: "thread-outbox",
      teamId: "team-outbox",
      teamName: "Demo",
      leadRoleId: "lead",
      roles: [
        { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
        { roleId: "operator", name: "Operator", seat: "member", runtime: "local" },
      ],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    };

    const sourceMessage: TeamMessage = {
      id: "msg-outbox",
      threadId: thread.threadId,
      role: "assistant",
      roleId: "lead",
      name: "Lead",
      content: "@{operator} Please continue",
      createdAt: 1,
      updatedAt: 1,
    };

    let storedFlow: FlowLedger = {
      flowId: "flow-outbox",
      threadId: thread.threadId,
      rootMessageId: "msg-root",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: [],
      completedRoleIds: [],
      failedRoleIds: [],
      nextExpectedRoleId: "lead",
      hopCount: 0,
      maxHops: 5,
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    };

    const flowLedgerStore: FlowLedgerStore = {
      async get(flowId) {
        return flowId === storedFlow.flowId ? storedFlow : null;
      },
      async put(flow) {
        storedFlow = flow;
      },
      async listByThread(threadId) {
        return threadId === storedFlow.threadId ? [storedFlow] : [];
      },
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

    const teamMessageStore: TeamMessageStore = {
      async append() {},
      async list() {
        return [sourceMessage];
      },
      async get() {
        return null;
      },
    };

    const runState: RoleRunState = {
      runKey: "role:operator:thread:thread-outbox",
      threadId: thread.threadId,
      roleId: "operator",
      mode: "group",
      status: "idle",
      iterationCount: 0,
      maxIterations: 6,
      inbox: [],
      lastActiveAt: 1,
    };

    let enqueueCalls = 0;
    let ensureRunningCalls = 0;
    const roleRunCoordinator: RoleRunCoordinator = {
      async getOrCreate() {
        return runState;
      },
      async enqueue(_runKey, handoff) {
        enqueueCalls += 1;
        if (enqueueCalls === 1) {
          throw new Error("transient dispatch failure");
        }
        runState.inbox = [...runState.inbox, handoff];
        runState.status = "queued";
        return runState;
      },
      async dequeue() {
        return null;
      },
      async ack() {},
      async bindWorkerSession() {},
      async clearWorkerSession() {},
      async setStatus() {},
      async incrementIteration() {
        return 0;
      },
      async fail() {},
      async finish() {},
    };

    const engine = new CoordinationEngine({
      teamThreadStore,
      teamMessageStore,
      flowLedgerStore,
      roleRunCoordinator,
      handoffPlanner: {
        parseMentions() {
          return [];
        },
        async validateMentionTargets() {
          return { allowed: true, mode: "serial", targetRoleIds: [] };
        },
        async buildHandoffs() {
          return [];
        },
      },
      recoveryDirector: {
        async onUserMessage() {
          return { action: "complete" as const };
        },
        async onRoleReply() {
          return { action: "complete" as const };
        },
        async onRoleFailure() {
          return { action: "abort" as const, reason: "fail" };
        },
      },
      roleLoopRunner: {
        async ensureRunning() {
          ensureRunningCalls += 1;
        },
      },
      summaryBuilder: {
        async getRecentMessages() {
          return [];
        },
      },
      relayBriefBuilder: {
        build() {
          return "brief";
        },
      },
      idGenerator: {
        flowId: () => "flow-generated",
        messageId: () => "msg-generated",
        taskId: () => "task-outbox",
      },
      runtimeLimits: {
        flowMaxHops: 5,
      },
      clock: {
        now: () => Date.now(),
      },
      dispatchOutboxRootDir: tempDir,
      dispatchOutboxRetryDelayMs: 5,
      dispatchOutboxMaxRetryDelayMs: 5,
      dispatchOutboxMaxRetries: 3,
    });

    await assert.rejects(() =>
      engine.dispatchToRole({
        thread,
        flow: storedFlow,
        sourceMessage,
        fromRoleId: "lead",
        toRoleId: "operator",
        activationType: "mention",
      }),
      /transient dispatch failure/
    );

    assert.equal(storedFlow.edges[0]?.state, "created");
    assert.deepEqual(storedFlow.activeRoleIds, ["operator"]);

    const outbox = new FileBatchOutbox<unknown>({ rootDir: tempDir });
    await waitFor(async () => {
      const remaining = await outbox.listDue(32, Date.now() + 1_000);
      return remaining.length === 0 && storedFlow.edges[0]?.state === "delivered";
    });

    assert.equal(enqueueCalls, 2);
    assert.equal(storedFlow.edges[0]?.state, "delivered");
    assert.deepEqual(storedFlow.activeRoleIds, ["operator"]);
    assert.ok(ensureRunningCalls >= 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("coordination engine replays user-post ingress through the outbox after partial persistence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "coordination-engine-ingress-outbox-"));
  try {
    const thread: TeamThread = {
      threadId: "thread-ingress",
      teamId: "team-ingress",
      teamName: "Demo",
      leadRoleId: "lead",
      roles: [
        { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      ],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    };

    const messages = new Map<string, TeamMessage>();
    let storedFlow: FlowLedger | null = null;
    let putAttempts = 0;
    let ensureRunningCalls = 0;

    const flowLedgerStore: FlowLedgerStore = {
      async get(flowId) {
        return storedFlow?.flowId === flowId ? storedFlow : null;
      },
      async put(flow, options) {
        putAttempts += 1;
        if (putAttempts === 1) {
          throw new Error("transient flow persistence failure");
        }
        const existingVersion = storedFlow?.version ?? 0;
        if (options?.expectedVersion != null && existingVersion !== options.expectedVersion) {
          throw new Error(`flow version conflict: expected ${options.expectedVersion}, found ${existingVersion}`);
        }
        storedFlow = {
          ...flow,
          version: existingVersion + 1,
        };
      },
      async listByThread(threadId) {
        return storedFlow && storedFlow.threadId === threadId ? [storedFlow] : [];
      },
    };

    const engine = new CoordinationEngine({
      teamThreadStore: {
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
      },
      teamMessageStore: {
        async append(message) {
          messages.set(message.id, message);
        },
        async list(threadId) {
          return [...messages.values()].filter((message) => message.threadId === threadId);
        },
        async get(messageId) {
          return messages.get(messageId) ?? null;
        },
      },
      flowLedgerStore,
      roleRunCoordinator: {
        async getOrCreate() {
          return {
            runKey: "role:lead:thread:thread-ingress",
            threadId: thread.threadId,
            roleId: "lead",
            mode: "group",
            status: "idle",
            iterationCount: 0,
            maxIterations: 3,
            inbox: [],
            lastActiveAt: 1,
            version: 1,
          };
        },
        async enqueue(_runKey, handoff) {
          return {
            runKey: "role:lead:thread:thread-ingress",
            threadId: thread.threadId,
            roleId: "lead",
            mode: "group",
            status: "queued",
            iterationCount: 0,
            maxIterations: 3,
            inbox: [handoff],
            lastActiveAt: 1,
            version: 2,
          };
        },
        async dequeue() {
          return null;
        },
        async ack() {},
        async bindWorkerSession() {},
        async clearWorkerSession() {},
        async setStatus() {},
        async incrementIteration() {
          return 0;
        },
        async fail() {},
        async finish() {},
      },
      handoffPlanner: {
        parseMentions() {
          return [];
        },
        async validateMentionTargets() {
          return { allowed: true, mode: "serial", targetRoleIds: [] };
        },
        async buildHandoffs() {
          return [];
        },
      },
      recoveryDirector: {
        async onUserMessage() {
          return { action: "complete" as const };
        },
        async onRoleReply() {
          return { action: "complete" as const };
        },
        async onRoleFailure() {
          return { action: "abort" as const, reason: "fail" };
        },
      },
      roleLoopRunner: {
        async ensureRunning() {
          ensureRunningCalls += 1;
        },
      },
      summaryBuilder: {
        async getRecentMessages(threadId) {
          return [...messages.values()]
            .filter((message) => message.threadId === threadId)
            .map((message) => ({
              messageId: message.id,
              role: message.role,
              ...(message.roleId ? { roleId: message.roleId } : {}),
              name: message.name,
              content: message.content,
              createdAt: message.createdAt,
            }));
        },
      },
      relayBriefBuilder: {
        build() {
          return "brief";
        },
      },
      idGenerator: {
        flowId: () => "flow-ingress",
        messageId: () => "msg-ingress",
        taskId: () => "task-ingress",
      },
      runtimeLimits: {
        flowMaxHops: 4,
      },
      clock: {
        now: () => Date.now(),
      },
      ingressOutboxRootDir: path.join(tempDir, "ingress"),
      ingressOutboxRetryDelayMs: 5,
      ingressOutboxMaxRetryDelayMs: 5,
      ingressOutboxMaxRetries: 3,
    });

    await engine.handleUserPost({
      threadId: thread.threadId,
      content: "Recover this flow start.",
    });

    assert.equal(messages.size, 1);
    assert.equal(storedFlow, null);

    const outbox = new FileBatchOutbox<unknown>({ rootDir: path.join(tempDir, "ingress") });
    await waitFor(async () => {
      const remaining = await outbox.listDue(32, Date.now() + 1_000);
      return remaining.length === 0 && storedFlow?.status === "waiting_role";
    });

    assert.equal(messages.size, 1);
    const replayedFlow = await flowLedgerStore.get("flow-ingress");
    if (!replayedFlow) {
      throw new Error("expected replayed flow to be persisted");
    }
    assert.equal(replayedFlow.rootMessageId, "msg-ingress");
    assert.equal(replayedFlow.edges.length, 1);
    assert.equal(replayedFlow.edges[0]?.state, "delivered");
    assert.equal(ensureRunningCalls, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("coordination engine records exhausted ingress outbox batches into replay incidents", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "coordination-engine-ingress-drop-"));
  try {
    const thread: TeamThread = {
      threadId: "thread-ingress-drop",
      teamId: "team-ingress-drop",
      teamName: "Demo",
      leadRoleId: "lead",
      roles: [{ roleId: "lead", name: "Lead", seat: "lead", runtime: "local" }],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    };

    const messages = new Map<string, TeamMessage>();
    const replayRecords: ReplayRecord[] = [];

    const engine = new CoordinationEngine({
      teamThreadStore: {
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
      },
      teamMessageStore: {
        async append(message) {
          messages.set(message.id, message);
        },
        async list(threadId) {
          return [...messages.values()].filter((message) => message.threadId === threadId);
        },
        async get(messageId) {
          return messages.get(messageId) ?? null;
        },
      },
      flowLedgerStore: {
        async get() {
          return null;
        },
        async put() {
          throw new Error("permanent flow persistence failure");
        },
        async listByThread() {
          return [];
        },
      },
      roleRunCoordinator: {
        async getOrCreate() {
          throw new Error("not used");
        },
        async enqueue() {
          throw new Error("not used");
        },
        async dequeue() {
          return null;
        },
        async ack() {},
        async bindWorkerSession() {},
        async clearWorkerSession() {},
        async setStatus() {},
        async incrementIteration() {
          return 0;
        },
        async fail() {},
        async finish() {},
      },
      handoffPlanner: {
        parseMentions() {
          return [];
        },
        async validateMentionTargets() {
          return { allowed: true, mode: "serial", targetRoleIds: [] };
        },
        async buildHandoffs() {
          return [];
        },
      },
      recoveryDirector: {
        async onUserMessage() {
          return { action: "complete" as const };
        },
        async onRoleReply() {
          return { action: "complete" as const };
        },
        async onRoleFailure() {
          return { action: "abort" as const, reason: "fail" };
        },
      },
      roleLoopRunner: {
        async ensureRunning() {
          throw new Error("not used");
        },
      },
      summaryBuilder: {
        async getRecentMessages() {
          return [];
        },
      },
      relayBriefBuilder: {
        build() {
          return "brief";
        },
      },
      replayRecorder: {
        async record(record) {
          replayRecords.push(record);
          return record.replayId;
        },
        async get(replayId) {
          return replayRecords.find((record) => record.replayId === replayId) ?? null;
        },
        async list() {
          return replayRecords;
        },
      },
      idGenerator: {
        flowId: () => "flow-ingress-drop",
        messageId: () => "msg-ingress-drop",
        taskId: () => "task-ingress-drop",
      },
      runtimeLimits: {
        flowMaxHops: 4,
      },
      clock: {
        now: () => Date.now(),
      },
      ingressOutboxRootDir: path.join(tempDir, "ingress"),
      ingressOutboxRetryDelayMs: 5,
      ingressOutboxMaxRetryDelayMs: 5,
      ingressOutboxMaxRetries: 0,
    });

    await engine.handleUserPost({
      threadId: thread.threadId,
      content: "This intent should end up in replay incidents.",
    });

    const outbox = new FileBatchOutbox<unknown>({ rootDir: path.join(tempDir, "ingress") });
    await waitFor(async () => {
      const remaining = await outbox.listDue(32, Date.now() + 1_000);
      return remaining.length === 0 && replayRecords.length === 1;
    });

    assert.equal(replayRecords[0]?.threadId, thread.threadId);
    assert.equal(replayRecords[0]?.flowId, "flow-ingress-drop");
    assert.equal(replayRecords[0]?.status, "failed");
    assert.equal(replayRecords[0]?.failure?.recommendedAction, "inspect");
    assert.equal(replayRecords[0]?.metadata?.source, "ingress_outbox_dropped");
    assert.equal(replayRecords[0]?.metadata?.messageId, "msg-ingress-drop");

    const report = buildReplayInspectionReport(replayRecords);
    assert.equal(report.incidents.length, 1);
    assert.equal(report.incidents[0]?.recoveryHint.action, "inspect");
    assert.equal(report.incidents[0]?.groupId, "flow-ingress-drop:start:ingress-dropped");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("coordination engine carries scheduled worker resume hints into the handoff payload", async () => {
  const thread: TeamThread = {
    threadId: "thread-scheduled",
    teamId: "team-scheduled",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [
      { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "operator", name: "Operator", seat: "member", runtime: "local", capabilities: ["browser"] },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  let storedFlow: FlowLedger = {
    flowId: "flow-scheduled",
    threadId: thread.threadId,
    rootMessageId: "msg-root",
    mode: "serial",
    status: "created",
    currentStageIndex: 0,
    activeRoleIds: [],
    completedRoleIds: [],
    failedRoleIds: [],
    hopCount: 0,
    maxHops: 5,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const enqueued: Array<{
    runKey: string;
    handoff: {
      payload: {
        preferredWorkerKinds?: ("browser" | "coder" | "finance" | "explore" | "harness")[];
        sessionTarget?: "main" | "worker";
        instructions?: string;
        continuationContext?: {
          source: "scheduled_reentry" | "timeout_summary" | "follow_up" | "recovery_dispatch";
          workerType?: "browser" | "coder" | "finance" | "explore" | "harness";
          workerRunKey?: string;
          summary?: string;
          recovery?: {
            parentGroupId: string;
            action: "auto_resume" | "retry_same_layer" | "fallback_transport" | "request_approval" | "inspect_then_resume" | "stop";
            dispatchReplayId?: string;
          };
        };
      };
    };
  }> = [];

  const engine = buildEngine({
    teamThreadStore: {
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
    },
    teamMessageStore: {
      async append() {},
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    },
    flowLedgerStore: {
      async get(flowId) {
        return flowId === storedFlow.flowId ? storedFlow : null;
      },
      async put(flow) {
        storedFlow = flow;
      },
      async listByThread(threadId) {
        return threadId === storedFlow.threadId ? [storedFlow] : [];
      },
    },
    roleRunCoordinator: {
      async getOrCreate() {
        return {
          runKey: "role:operator:thread:thread-scheduled",
          threadId: thread.threadId,
          roleId: "operator",
          mode: "group",
          status: "idle",
          iterationCount: 0,
          maxIterations: 5,
          inbox: [],
          lastActiveAt: 1,
          workerSessions: {
            browser: "worker-run-existing",
          },
        };
      },
      async enqueue(runKey, handoff) {
        const payload = {
          ...(handoff.payload.preferredWorkerKinds ? { preferredWorkerKinds: handoff.payload.preferredWorkerKinds } : {}),
          ...(handoff.payload.sessionTarget ? { sessionTarget: handoff.payload.sessionTarget } : {}),
          ...(handoff.payload.instructions ? { instructions: handoff.payload.instructions } : {}),
          ...(handoff.payload.continuationContext
            ? { continuationContext: handoff.payload.continuationContext }
            : {}),
        };
        enqueued.push({
          runKey,
          handoff: {
            payload,
          },
        });
        return {
          runKey,
          threadId: thread.threadId,
          roleId: "operator",
          mode: "group",
          status: "queued",
          iterationCount: 0,
          maxIterations: 5,
          inbox: [handoff],
          lastActiveAt: 2,
        };
      },
      async dequeue() {
        return null;
      },
      async ack() {},
      async bindWorkerSession() {},
      async clearWorkerSession() {},
      async setStatus() {},
      async incrementIteration() {
        return 0;
      },
      async fail() {},
      async finish() {},
    },
    roleLoopRunner: {
      async ensureRunning() {},
    },
    workerRuntime: {
      async getState() {
        return {
          workerRunKey: "worker-run-existing",
          workerType: "browser",
          status: "resumable",
          createdAt: 1,
          updatedAt: 2,
          continuationDigest: {
            reason: "timeout_summary",
            summary: "Collected partial browser evidence.",
            createdAt: 2,
          },
          lastResult: {
            workerType: "browser",
            status: "partial",
            summary: "Collected partial browser evidence.",
            payload: {
              sessionId: "browser-session-1",
              targetId: "target-1",
              resumeMode: "warm",
            },
          },
        };
      },
    },
  });

  await engine.handleScheduledTask({
    taskId: "TASK-browser-check",
    threadId: thread.threadId,
    targetRoleId: "operator",
    targetWorker: "browser",
    sessionTarget: "worker",
    schedule: {
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Asia/Shanghai",
      nextRunAt: 10,
    },
    capsule: {
      title: "Browser follow-up",
      instructions: "Continue the same browser review.",
    },
    createdAt: 1,
    updatedAt: 1,
  });

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0]?.handoff.payload.preferredWorkerKinds, ["browser"]);
  assert.equal(enqueued[0]?.handoff.payload.sessionTarget, "worker");
  assert.match(enqueued[0]?.handoff.payload.instructions ?? "", /Resume the existing worker session when available/);
  assert.match(enqueued[0]?.handoff.payload.instructions ?? "", /Collected partial browser evidence/);
  assert.deepEqual(enqueued[0]?.handoff.payload.continuationContext, {
    source: "scheduled_reentry",
    workerType: "browser",
    workerRunKey: "worker-run-existing",
    summary: "Collected partial browser evidence.",
    browserSession: {
      sessionId: "browser-session-1",
      targetId: "target-1",
      resumeMode: "warm",
      ownerType: "thread",
      ownerId: thread.threadId,
      leaseHolderRunKey: "worker-run-existing",
    },
  });
});

test("coordination engine treats scheduled continuation lookup as best effort", async () => {
  const thread: TeamThread = {
    threadId: "thread-scheduled-fallback",
    teamId: "team-scheduled-fallback",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [
      { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "operator", name: "Operator", seat: "member", runtime: "local", capabilities: ["browser"] },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  let storedFlow: FlowLedger = {
    flowId: "flow-scheduled-fallback",
    threadId: thread.threadId,
    rootMessageId: "msg-root",
    mode: "serial",
    status: "created",
    currentStageIndex: 0,
    activeRoleIds: [],
    completedRoleIds: [],
    failedRoleIds: [],
    hopCount: 0,
    maxHops: 5,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const enqueued: HandoffEnvelope[] = [];
  let getOrCreateCalls = 0;
  const engine = buildEngine({
    teamThreadStore: {
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
    },
    teamMessageStore: {
      async append() {},
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    },
    flowLedgerStore: {
      async get(flowId) {
        return flowId === storedFlow.flowId ? storedFlow : null;
      },
      async put(flow) {
        storedFlow = flow;
      },
      async listByThread(threadId) {
        return threadId === storedFlow.threadId ? [storedFlow] : [];
      },
    },
    roleRunCoordinator: {
      async getOrCreate() {
        return {
          runKey: "role:operator:thread:thread-scheduled-fallback",
          threadId: thread.threadId,
          roleId: "operator",
          mode: "group",
          status: "idle",
          iterationCount: 0,
          maxIterations: 5,
          inbox: [],
          lastActiveAt: 1,
          workerSessions: {
            browser: "worker-run-existing",
          },
        };
      },
      async enqueue(runKey, handoff) {
        enqueued.push(handoff);
        return {
          runKey,
          threadId: thread.threadId,
          roleId: "operator",
          mode: "group",
          status: "queued",
          iterationCount: 0,
          maxIterations: 5,
          inbox: [handoff],
          lastActiveAt: 2,
        };
      },
      async dequeue() {
        return null;
      },
      async ack() {},
      async bindWorkerSession() {},
      async clearWorkerSession() {},
      async setStatus() {},
      async incrementIteration() {
        return 0;
      },
      async fail() {},
      async finish() {},
    },
    roleLoopRunner: {
      async ensureRunning() {},
    },
    workerRuntime: {
      async getState() {
        throw new Error("lookup failed");
      },
    },
  });

  await engine.handleScheduledTask({
    taskId: "TASK-browser-fallback",
    threadId: thread.threadId,
    targetRoleId: "operator",
    targetWorker: "browser",
    sessionTarget: "worker",
    schedule: {
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Asia/Shanghai",
      nextRunAt: 10,
    },
    capsule: {
      title: "Browser follow-up",
      instructions: "Continue the same browser review.",
    },
    createdAt: 1,
    updatedAt: 1,
  });

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.payload.continuationContext, undefined);
  assert.match(enqueued[0]?.payload.instructions ?? "", /Resume the existing worker session when available/);
});

test("coordination engine preserves recovery context for main-target recovery dispatches", async () => {
  const thread: TeamThread = {
    threadId: "thread-recovery-main",
    teamId: "team-recovery-main",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [{ roleId: "lead", name: "Lead", seat: "lead", runtime: "local" }],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  let storedFlow: FlowLedger = {
    flowId: "flow-recovery-main",
    threadId: thread.threadId,
    rootMessageId: "msg-root",
    mode: "serial",
    status: "created",
    currentStageIndex: 0,
    activeRoleIds: [],
    completedRoleIds: [],
    failedRoleIds: [],
    hopCount: 0,
    maxHops: 5,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const enqueued: HandoffEnvelope[] = [];
  let getOrCreateCalls = 0;
  const engine = buildEngine({
    teamThreadStore: {
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
    },
    teamMessageStore: {
      async append() {},
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    },
    flowLedgerStore: {
      async get(flowId) {
        return flowId === storedFlow.flowId ? storedFlow : null;
      },
      async put(flow) {
        storedFlow = flow;
      },
      async listByThread(threadId) {
        return threadId === storedFlow.threadId ? [storedFlow] : [];
      },
    },
    roleRunCoordinator: {
      async getOrCreate() {
        return {
          runKey: "role:lead:thread:thread-recovery-main",
          threadId: thread.threadId,
          roleId: "lead",
          mode: "group",
          status: "idle",
          iterationCount: 0,
          maxIterations: 5,
          inbox: [],
          lastActiveAt: 1,
        };
      },
      async enqueue(runKey, handoff) {
        enqueued.push(handoff);
        return {
          runKey,
          threadId: thread.threadId,
          roleId: "lead",
          mode: "group",
          status: "queued",
          iterationCount: 0,
          maxIterations: 5,
          inbox: [handoff],
          lastActiveAt: 2,
        };
      },
      async dequeue() {
        return null;
      },
      async ack() {},
      async bindWorkerSession() {},
      async clearWorkerSession() {},
      async setStatus() {},
      async incrementIteration() {
        return 0;
      },
      async fail() {},
      async finish() {},
    },
    roleLoopRunner: {
      async ensureRunning() {},
    },
  });

  await engine.handleScheduledTask({
    taskId: "TASK-recovery-main",
    threadId: thread.threadId,
    targetRoleId: "lead",
    sessionTarget: "main",
    schedule: {
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Asia/Shanghai",
      nextRunAt: 10,
    },
    capsule: {
      title: "Recovery follow-up",
      instructions: "Pick up the recovery workflow from the latest failure.",
    },
    recoveryContext: {
      parentGroupId: "group-1",
      action: "inspect_then_resume",
      dispatchReplayId: "TASK-recovery-main:scheduled",
    },
    createdAt: 1,
    updatedAt: 1,
  });

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0]?.payload.continuationContext, {
    source: "recovery_dispatch",
    recovery: {
      parentGroupId: "group-1",
      action: "inspect_then_resume",
      dispatchReplayId: "TASK-recovery-main:scheduled",
    },
  });
});

test("coordination engine preserves recovery context when worker continuation lookup throws", async () => {
  const thread: TeamThread = {
    threadId: "thread-recovery-worker-fallback",
    teamId: "team-recovery-worker-fallback",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [
      { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "operator", name: "Operator", seat: "member", runtime: "local", capabilities: ["browser"] },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  let storedFlow: FlowLedger = {
    flowId: "flow-recovery-worker-fallback",
    threadId: thread.threadId,
    rootMessageId: "msg-root",
    mode: "serial",
    status: "created",
    currentStageIndex: 0,
    activeRoleIds: [],
    completedRoleIds: [],
    failedRoleIds: [],
    hopCount: 0,
    maxHops: 5,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const enqueued: HandoffEnvelope[] = [];
  let getOrCreateCalls = 0;
  const engine = buildEngine({
    teamThreadStore: {
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
    },
    teamMessageStore: {
      async append() {},
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    },
    flowLedgerStore: {
      async get(flowId) {
        return flowId === storedFlow.flowId ? storedFlow : null;
      },
      async put(flow) {
        storedFlow = flow;
      },
      async listByThread(threadId) {
        return threadId === storedFlow.threadId ? [storedFlow] : [];
      },
    },
    roleRunCoordinator: {
      async getOrCreate() {
        getOrCreateCalls += 1;
        if (getOrCreateCalls === 1) {
          throw new Error("lookup failed");
        }
        return {
          runKey: "role:operator:thread:thread-recovery-worker-fallback",
          threadId: thread.threadId,
          roleId: "operator",
          mode: "group",
          status: "idle",
          iterationCount: 0,
          maxIterations: 5,
          inbox: [],
          lastActiveAt: 1,
        };
      },
      async enqueue(runKey, handoff) {
        enqueued.push(handoff);
        return {
          runKey,
          threadId: thread.threadId,
          roleId: "operator",
          mode: "group",
          status: "queued",
          iterationCount: 0,
          maxIterations: 5,
          inbox: [handoff],
          lastActiveAt: 2,
        };
      },
      async dequeue() {
        return null;
      },
      async ack() {},
      async bindWorkerSession() {},
      async clearWorkerSession() {},
      async setStatus() {},
      async incrementIteration() {
        return 0;
      },
      async fail() {},
      async finish() {},
    },
    roleLoopRunner: {
      async ensureRunning() {},
    },
    workerRuntime: {
      async getState() {
        throw new Error("not used");
      },
    },
  });

  await engine.handleScheduledTask({
    taskId: "TASK-recovery-worker-fallback",
    threadId: thread.threadId,
    targetRoleId: "operator",
    targetWorker: "browser",
    sessionTarget: "worker",
    schedule: {
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Asia/Shanghai",
      nextRunAt: 10,
    },
    capsule: {
      title: "Recovery worker follow-up",
      instructions: "Retry the browser recovery flow.",
    },
    recoveryContext: {
      parentGroupId: "group-2",
      action: "retry_same_layer",
      dispatchReplayId: "TASK-recovery-worker-fallback:scheduled",
    },
    createdAt: 1,
    updatedAt: 1,
  });

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0]?.payload.continuationContext, {
    source: "recovery_dispatch",
    workerType: "browser",
    recovery: {
      parentGroupId: "group-2",
      action: "retry_same_layer",
      dispatchReplayId: "TASK-recovery-worker-fallback:scheduled",
    },
  });
  assert.equal(enqueued[0]?.payload.continuity?.mode, undefined);
});

test("coordination engine keeps legacy dispatch policy aligned with expected next roles", async () => {
  const thread: TeamThread = {
    threadId: "thread-dispatch-policy",
    teamId: "team-1",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [
      { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "operator", name: "Operator", seat: "member", runtime: "local" },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  const sourceMessage: TeamMessage = {
    id: "msg-dispatch-policy",
    threadId: thread.threadId,
    role: "user",
    name: "User",
    content: "Hello",
    createdAt: 1,
    updatedAt: 1,
  };

  let storedFlow: FlowLedger = {
    flowId: "flow-dispatch-policy",
    threadId: thread.threadId,
    rootMessageId: sourceMessage.id,
    mode: "serial",
    status: "running",
    currentStageIndex: 0,
    activeRoleIds: [],
    completedRoleIds: [],
    failedRoleIds: [],
    nextExpectedRoleId: "lead",
    hopCount: 0,
    maxHops: 4,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const enqueued: HandoffEnvelope[] = [];
  const engine = new CoordinationEngine({
    teamThreadStore: {
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
    },
    teamMessageStore: {
      async append() {},
      async list() {
        return [sourceMessage];
      },
      async get() {
        return null;
      },
    },
    flowLedgerStore: {
      async get(flowId) {
        return flowId === storedFlow.flowId ? storedFlow : null;
      },
      async put(flow) {
        storedFlow = flow;
      },
      async listByThread(threadId) {
        return threadId === storedFlow.threadId ? [storedFlow] : [];
      },
    },
    roleRunCoordinator: {
      async getOrCreate(): Promise<RoleRunState> {
        return {
          runKey: "role:operator:thread:thread-dispatch-policy",
          threadId: thread.threadId,
          roleId: "operator",
          mode: "group",
          status: "idle",
          iterationCount: 0,
          maxIterations: 5,
          inbox: [],
          lastActiveAt: 1,
        };
      },
      async enqueue(runKey, handoff) {
        enqueued.push(handoff);
        return {
          runKey,
          threadId: thread.threadId,
          roleId: "operator",
          mode: "group",
          status: "queued",
          iterationCount: 0,
          maxIterations: 5,
          inbox: [handoff],
          lastActiveAt: 2,
        };
      },
      async dequeue() {
        return null;
      },
      async ack() {},
      async bindWorkerSession() {},
      async clearWorkerSession() {},
      async setStatus() {},
      async incrementIteration() {
        return 0;
      },
      async fail() {},
      async finish() {},
    },
    handoffPlanner: {
      parseMentions() {
        return [];
      },
      async validateMentionTargets() {
        return { allowed: true, mode: "serial", targetRoleIds: [] };
      },
      async buildHandoffs() {
        return [];
      },
    },
    recoveryDirector: {
      async onUserMessage() {
        return { action: "complete" as const };
      },
      async onRoleReply() {
        return { action: "complete" as const };
      },
      async onRoleFailure() {
        return { action: "complete" as const };
      },
    },
    roleLoopRunner: {
      async ensureRunning() {},
    },
    summaryBuilder: {
      async getRecentMessages() {
        return [
          {
            messageId: sourceMessage.id,
            role: sourceMessage.role,
            name: sourceMessage.name,
            content: sourceMessage.content,
            createdAt: sourceMessage.createdAt,
            ...(sourceMessage.roleId ? { roleId: sourceMessage.roleId } : {}),
          },
        ];
      },
    },
    relayBriefBuilder: {
      build() {
        return "relay brief";
      },
    },
    idGenerator: {
      flowId: () => "flow-generated",
      messageId: () => "msg-generated",
      taskId: () => "task-dispatch-policy",
    },
    runtimeLimits: {
      flowMaxHops: 4,
    },
    clock: {
      now: () => 10,
    },
  });

  await engine.dispatchToRole({
    thread,
    flow: storedFlow,
    sourceMessage,
    toRoleId: "operator",
    activationType: "cascade",
  });

  assert.deepEqual(enqueued[0]?.payload.constraints?.dispatchPolicy?.expectedNextRoleIds, ["lead"]);
  assert.deepEqual(enqueued[0]?.payload.dispatchPolicy?.expectedNextRoleIds, ["lead"]);
});

test("coordination engine fan-out waits for all shards before dispatching merge back to lead", async () => {
  const thread: TeamThread = {
    threadId: "thread-fanout",
    teamId: "team-fanout",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [
      { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "research", name: "Research", seat: "member", runtime: "local" },
      { roleId: "finance", name: "Finance", seat: "member", runtime: "local" },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  let storedFlow: FlowLedger = {
    flowId: "flow-fanout",
    threadId: thread.threadId,
    rootMessageId: "msg-root",
    mode: "parallel",
    status: "running",
    currentStageIndex: 0,
    activeRoleIds: [],
    completedRoleIds: [],
    failedRoleIds: [],
    nextExpectedRoleId: "lead",
    hopCount: 0,
    maxHops: 8,
    edges: [
      {
        edgeId: "task-lead-1:edge",
        flowId: "flow-fanout",
        toRoleId: "lead",
        sourceMessageId: "msg-user",
        state: "acked",
        createdAt: 1,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };

  const enqueued: Array<{ runKey: string; handoff: HandoffEnvelope }> = [];
  const roleRunState = (roleId: string) => ({
    runKey: `role:${roleId}:thread:${thread.threadId}`,
    threadId: thread.threadId,
    roleId,
    mode: "group" as const,
    status: "idle" as const,
    iterationCount: 0,
    maxIterations: 6,
    inbox: [],
    lastActiveAt: 1,
  });

  const engine = buildEngine({
    teamThreadStore: {
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
    },
    teamMessageStore: {
      async append() {},
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    },
    flowLedgerStore: {
      async get(flowId) {
        return flowId === storedFlow.flowId ? storedFlow : null;
      },
      async put(flow) {
        storedFlow = flow;
      },
      async listByThread(threadId) {
        return threadId === storedFlow.threadId ? [storedFlow] : [];
      },
    },
    roleRunCoordinator: {
      async getOrCreate(threadId, roleId) {
        return roleRunState(roleId);
      },
      async enqueue(runKey, handoff) {
        enqueued.push({ runKey, handoff });
        return {
          ...roleRunState(handoff.targetRoleId),
          runKey,
          status: "queued",
          inbox: [handoff],
        };
      },
      async dequeue() {
        return null;
      },
      async ack() {},
      async bindWorkerSession() {},
      async clearWorkerSession() {},
      async setStatus() {},
      async incrementIteration() {
        return 0;
      },
      async fail() {},
      async finish() {},
    },
    roleLoopRunner: {
      async ensureRunning() {},
    },
    handoffPlanner: {
      parseMentions() {
        return [];
      },
      async validateMentionTargets(_thread, input) {
        if (input.content.includes("@{research}") || input.content.includes("@{finance}")) {
          return { allowed: true, mode: "parallel", targetRoleIds: ["research", "finance"] };
        }

        return { allowed: true, mode: "parallel", targetRoleIds: [] };
      },
      async buildHandoffs() {
        return [];
      },
    },
  });

  const sourceHandoff: HandoffEnvelope = {
    taskId: "task-lead-1",
    flowId: storedFlow.flowId,
    sourceMessageId: "msg-user",
    targetRoleId: "lead",
    activationType: "cascade",
    threadId: thread.threadId,
    payload: {
      threadId: thread.threadId,
      relayBrief: "Split the work.",
      recentMessages: [],
      dispatchPolicy: {
        allowParallel: true,
        allowReenter: true,
        sourceFlowMode: "parallel",
      },
    },
    createdAt: 1,
  };

  await engine.handleRoleReply({
    flow: storedFlow,
    thread,
    runState: roleRunState("lead"),
    handoff: sourceHandoff,
    message: {
      id: "msg-lead-fanout",
      threadId: thread.threadId,
      role: "assistant",
      roleId: "lead",
      name: "Lead",
      content: "@{research} @{finance} Please investigate in parallel.",
      createdAt: 2,
      updatedAt: 2,
    },
  });

  assert.equal(enqueued.length, 2);
  const fanOutGroupId = enqueued[0]?.handoff.payload.dispatchPolicy?.fanOutGroupId;
  assert.ok(fanOutGroupId);
  assert.equal(enqueued[1]?.handoff.payload.dispatchPolicy?.fanOutGroupId, fanOutGroupId);
  assert.deepEqual(enqueued[0]?.handoff.payload.dispatchPolicy?.coverageTargetRoleIds, ["research", "finance"]);
  assert.equal(enqueued[0]?.handoff.payload.parallelContext?.kind, "research_shard");

  const researchHandoff = enqueued[0]!.handoff;
  await engine.handleRoleReply({
    flow: storedFlow,
    thread,
    runState: roleRunState("research"),
    handoff: researchHandoff,
    message: {
      id: "msg-research",
      threadId: thread.threadId,
      role: "assistant",
      roleId: "research",
      name: "Research",
      content: "Research shard done.",
      createdAt: 3,
      updatedAt: 3,
    },
  });

  assert.equal(enqueued.length, 2);

  const financeHandoff = enqueued[1]!.handoff;
  await engine.handleRoleReply({
    flow: storedFlow,
    thread,
    runState: roleRunState("finance"),
    handoff: financeHandoff,
    message: {
      id: "msg-finance",
      threadId: thread.threadId,
      role: "assistant",
      roleId: "finance",
      name: "Finance",
      content: "Finance shard done.",
      createdAt: 4,
      updatedAt: 4,
    },
  });

  assert.deepEqual(
    storedFlow.edges
      .filter((edge) => edge.fanOutGroupId === fanOutGroupId)
      .map((edge) => edge.state),
    ["closed", "closed"]
  );
  assert.equal(enqueued.length, 3);
  assert.equal(enqueued[2]?.handoff.targetRoleId, "lead");
  assert.equal(enqueued[2]?.handoff.payload.parallelContext?.kind, "merge_synthesis");
  assert.deepEqual(enqueued[2]?.handoff.payload.mergeContext, {
    fanOutGroupId,
    expectedRoleIds: ["research", "finance"],
    completedRoleIds: ["research", "finance"],
    failedRoleIds: [],
    cancelledRoleIds: [],
    missingRoleIds: [],
    duplicateRoleIds: [],
    conflictRoleIds: [],
    shardSummaries: [
      {
        roleId: "research",
        status: "completed",
        summary: "Research shard done.",
      },
      {
        roleId: "finance",
        status: "completed",
        summary: "Finance shard done.",
      },
    ],
    followUpRequired: false,
  });
  assert.match(enqueued[2]?.handoff.payload.instructions ?? "", /Fan-out group completed/);
  assert.match(enqueued[2]?.handoff.payload.instructions ?? "", /Covered roles: research, finance/);
  assert.match(enqueued[2]?.handoff.payload.instructions ?? "", /Completed: research, finance/);
});

test("coordination engine retries failed shard before merge synthesis", async () => {
  const thread: TeamThread = {
    threadId: "thread-fanout-retry",
    teamId: "team-fanout",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [
      { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "research", name: "Research", seat: "member", runtime: "local" },
      { roleId: "finance", name: "Finance", seat: "member", runtime: "local" },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  let storedFlow: FlowLedger = {
    flowId: "flow-fanout-retry",
    threadId: thread.threadId,
    rootMessageId: "msg-root",
    mode: "parallel",
    status: "running",
    currentStageIndex: 0,
    activeRoleIds: [],
    completedRoleIds: [],
    failedRoleIds: [],
    nextExpectedRoleId: "lead",
    hopCount: 0,
    maxHops: 8,
    edges: [
      {
        edgeId: "task-lead-retry:edge",
        flowId: "flow-fanout-retry",
        toRoleId: "lead",
        sourceMessageId: "msg-user",
        state: "acked",
        createdAt: 1,
      },
    ],
    shardGroups: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const enqueued: Array<{ runKey: string; handoff: HandoffEnvelope }> = [];
  const roleRunState = (roleId: string) => ({
    runKey: `role:${roleId}:thread:${thread.threadId}`,
    threadId: thread.threadId,
    roleId,
    mode: "group" as const,
    status: "idle" as const,
    iterationCount: 0,
    maxIterations: 6,
    inbox: [],
    lastActiveAt: 1,
  });

  const engine = buildEngine({
    teamThreadStore: {
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
    },
    teamMessageStore: {
      async append() {},
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    },
    flowLedgerStore: {
      async get(flowId) {
        return flowId === storedFlow.flowId ? storedFlow : null;
      },
      async put(flow) {
        storedFlow = flow;
      },
      async listByThread(threadId) {
        return threadId === storedFlow.threadId ? [storedFlow] : [];
      },
    },
    roleRunCoordinator: {
      async getOrCreate(_threadId, roleId) {
        return roleRunState(roleId);
      },
      async enqueue(runKey, handoff) {
        enqueued.push({ runKey, handoff });
        return {
          ...roleRunState(handoff.targetRoleId),
          runKey,
          status: "queued",
          inbox: [handoff],
        };
      },
      async dequeue() {
        return null;
      },
      async ack() {},
      async bindWorkerSession() {},
      async clearWorkerSession() {},
      async setStatus() {},
      async incrementIteration() {
        return 0;
      },
      async fail() {},
      async finish() {},
    },
    roleLoopRunner: {
      async ensureRunning() {},
    },
    handoffPlanner: {
      parseMentions() {
        return [];
      },
      async validateMentionTargets(_thread, input) {
        if (input.content.includes("@{research}") || input.content.includes("@{finance}")) {
          return { allowed: true, mode: "parallel", targetRoleIds: ["research", "finance"] };
        }
        return { allowed: true, mode: "parallel", targetRoleIds: [] };
      },
      async buildHandoffs() {
        return [];
      },
    },
  });

  await engine.handleRoleReply({
    flow: storedFlow,
    thread,
    runState: roleRunState("lead"),
    handoff: {
      taskId: "task-lead-retry",
      flowId: storedFlow.flowId,
      sourceMessageId: "msg-user",
      targetRoleId: "lead",
      activationType: "cascade",
      threadId: thread.threadId,
      payload: {
        threadId: thread.threadId,
        relayBrief: "Split the work.",
        recentMessages: [],
        dispatchPolicy: {
          allowParallel: true,
          allowReenter: true,
          sourceFlowMode: "parallel",
        },
      },
      createdAt: 1,
    },
    message: {
      id: "msg-lead-retry",
      threadId: thread.threadId,
      role: "assistant",
      roleId: "lead",
      name: "Lead",
      content: "@{research} @{finance} Investigate in parallel.",
      createdAt: 2,
      updatedAt: 2,
    },
  });

  const researchHandoff = enqueued[0]!.handoff;
  await engine.onRoleFailure({
    flow: storedFlow,
    thread,
    runState: roleRunState("research"),
    handoff: researchHandoff,
    error: {
      code: "WORKER_FAILED",
      message: "temporary fetch failure",
      retryable: true,
    },
  });

  assert.equal(enqueued.length, 3);
  assert.equal(enqueued[2]?.handoff.targetRoleId, "research");
  assert.equal(enqueued[2]?.handoff.activationType, "retry");
  assert.match(enqueued[2]?.handoff.payload.instructions ?? "", /Retry shard research/);
});

test("coordination engine emits runtime chain records for new flows and dispatches", async () => {
  const thread: TeamThread = {
    threadId: "thread-runtime",
    teamId: "team-runtime",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [{ roleId: "lead", name: "Lead", seat: "lead", runtime: "local" }],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  let storedFlow: FlowLedger | null = null;
  let flowCreatedCount = 0;
  let flowSyncCount = 0;
  let dispatchCount = 0;

  const engine = buildEngine({
    teamThreadStore: {
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
    },
    teamMessageStore: {
      async append() {},
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    },
    flowLedgerStore: {
      async get(flowId) {
        return storedFlow?.flowId === flowId ? storedFlow : null;
      },
      async put(flow) {
        storedFlow = flow;
      },
      async listByThread() {
        return storedFlow ? [storedFlow] : [];
      },
    },
    roleRunCoordinator: {
      async getOrCreate() {
        return {
          runKey: "role:lead:thread-runtime",
          threadId: thread.threadId,
          roleId: "lead",
          mode: "group",
          status: "running",
          iterationCount: 0,
          maxIterations: 3,
          inbox: [],
          lastActiveAt: 1,
        };
      },
      async enqueue(_runKey, handoff) {
        return {
          runKey: "role:lead:thread-runtime",
          threadId: thread.threadId,
          roleId: "lead",
          mode: "group",
          status: "queued",
          iterationCount: 0,
          maxIterations: 3,
          inbox: [handoff],
          lastActiveAt: 1,
        };
      },
      async dequeue() {
        return null;
      },
      async ack() {},
      async bindWorkerSession() {},
      async clearWorkerSession() {},
      async setStatus() {},
      async incrementIteration() {
        return 0;
      },
      async fail() {},
      async finish() {},
    },
    roleLoopRunner: {
      async ensureRunning() {},
    },
    runtimeChainRecorder: {
      async recordFlowCreated() {
        flowCreatedCount += 1;
      },
      async syncFlowStatus() {
        flowSyncCount += 1;
      },
      async recordDispatchEnqueued() {
        dispatchCount += 1;
      },
    },
  });

  await engine.handleUserPost({
    threadId: thread.threadId,
    content: "start runtime chain",
  });

  assert.equal(flowCreatedCount, 1);
  assert.ok(flowSyncCount >= 1);
  assert.equal(dispatchCount, 1);
});

test("coordination engine treats runtime chain recorder failures as best effort", async () => {
  const thread: TeamThread = {
    threadId: "thread-runtime-best-effort",
    teamId: "team-runtime",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [{ roleId: "lead", name: "Lead", seat: "lead", runtime: "local" }],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  let storedFlow: FlowLedger | null = null;
  const engine = buildEngine({
    teamThreadStore: {
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
    },
    teamMessageStore: {
      async append() {},
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    },
    flowLedgerStore: {
      async get(flowId) {
        return storedFlow?.flowId === flowId ? storedFlow : null;
      },
      async put(flow) {
        storedFlow = flow;
      },
      async listByThread() {
        return storedFlow ? [storedFlow] : [];
      },
    },
    roleRunCoordinator: {
      async getOrCreate() {
        return {
          runKey: "role:lead:thread-runtime-best-effort",
          threadId: thread.threadId,
          roleId: "lead",
          mode: "group",
          status: "running",
          iterationCount: 0,
          maxIterations: 3,
          inbox: [],
          lastActiveAt: 1,
        };
      },
      async enqueue(_runKey, handoff) {
        return {
          runKey: "role:lead:thread-runtime-best-effort",
          threadId: thread.threadId,
          roleId: "lead",
          mode: "group",
          status: "queued",
          iterationCount: 0,
          maxIterations: 3,
          inbox: [handoff],
          lastActiveAt: 1,
        };
      },
      async dequeue() {
        return null;
      },
      async ack() {},
      async bindWorkerSession() {},
      async clearWorkerSession() {},
      async setStatus() {},
      async incrementIteration() {
        return 0;
      },
      async fail() {},
      async finish() {},
    },
    roleLoopRunner: {
      async ensureRunning() {},
    },
    runtimeChainRecorder: {
      async recordFlowCreated() {
        throw new Error("record flow failed");
      },
      async syncFlowStatus() {
        throw new Error("sync flow failed");
      },
      async recordDispatchEnqueued() {
        throw new Error("dispatch failed");
      },
    },
  });

  await engine.handleUserPost({
    threadId: thread.threadId,
    content: "start despite recorder failure",
  });

  const currentFlow: FlowLedger | null = storedFlow;
  if (!currentFlow) {
    assert.fail("expected flow to be persisted");
  }
  assert.equal((currentFlow as FlowLedger).status, "waiting_role");
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 500, intervalMs = 10): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}

function buildEngine(input: {
  teamThreadStore: TeamThreadStore;
  teamMessageStore: TeamMessageStore;
  flowLedgerStore: FlowLedgerStore;
  roleRunCoordinator: RoleRunCoordinator;
  roleLoopRunner: RoleLoopRunner;
  workerRuntime?: Pick<WorkerRuntime, "getState">;
  runtimeChainRecorder?: RuntimeChainRecorder;
  handoffPlanner?: HandoffPlanner;
}): CoordinationEngine {
  const handoffPlanner: HandoffPlanner = input.handoffPlanner ?? {
    parseMentions() {
      return [];
    },
    async validateMentionTargets() {
      return { allowed: true, mode: "serial", targetRoleIds: [] };
    },
    async buildHandoffs() {
      return [];
    },
  };

  const recoveryDirector: RecoveryDirector = {
    async onUserMessage() {
      return { action: "complete" };
    },
    async onRoleReply() {
      return { action: "complete" };
    },
    async onRoleFailure() {
      return { action: "abort", reason: "fail" };
    },
  };

  const summaryBuilder: SummaryBuilder = {
    async getRecentMessages() {
      return [];
    },
  };

  let flowIdCounter = 0;
  let messageIdCounter = 0;
  let taskIdCounter = 0;

  return new CoordinationEngine({
    teamThreadStore: input.teamThreadStore,
    teamMessageStore: input.teamMessageStore,
    flowLedgerStore: input.flowLedgerStore,
    roleRunCoordinator: input.roleRunCoordinator,
    handoffPlanner,
    recoveryDirector,
    roleLoopRunner: input.roleLoopRunner,
    summaryBuilder,
    relayBriefBuilder: {
      build() {
        return "brief";
      },
    },
    idGenerator: {
      flowId: () => `flow-generated-${++flowIdCounter}`,
      messageId: () => `msg-generated-${++messageIdCounter}`,
      taskId: () => `task-generated-${++taskIdCounter}`,
    },
    runtimeLimits: {
      flowMaxHops: 5,
    },
    clock: {
      now: () => 2,
    },
    ...(input.workerRuntime ? { workerRuntime: input.workerRuntime } : {}),
    ...(input.runtimeChainRecorder ? { runtimeChainRecorder: input.runtimeChainRecorder } : {}),
  });
}
