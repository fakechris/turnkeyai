import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkerExecutionResult,
  WorkerHandler,
  WorkerInvocationInput,
  WorkerRegistry,
} from "@turnkeyai/core-types/team";

import { InMemoryWorkerRuntime } from "./in-memory-worker-runtime";

test("in-memory worker runtime marks null worker results as done", async () => {
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(): Promise<WorkerExecutionResult | null> {
      return null;
    },
  };

  const registry: WorkerRegistry = {
    async selectHandler(input: WorkerInvocationInput) {
      return handler;
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: registry,
    now: () => 123,
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);
  const result = await runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });

  assert.equal(result, null);
  const state = await runtime.getState(spawned.workerRunKey);
  assert.equal(state?.status, "done");
});

test("in-memory worker runtime marks partial results as resumable and supports resume/cancel", async () => {
  let callCount = 0;
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(): Promise<WorkerExecutionResult | null> {
      callCount += 1;
      return {
        workerType: "browser",
        status: callCount === 1 ? "partial" : "completed",
        summary: callCount === 1 ? "Need one more step." : "Done.",
        payload: { step: callCount },
      };
    },
  };

  const registry: WorkerRegistry = {
    async selectHandler() {
      return handler;
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: registry,
    now: () => 456,
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);

  const partial = await runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });
  assert.equal(partial?.status, "partial");
  assert.equal((await runtime.getState(spawned.workerRunKey))?.status, "resumable");

  const resumed = await runtime.resume({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });
  assert.equal(resumed?.status, "completed");
  assert.equal((await runtime.getState(spawned.workerRunKey))?.status, "done");

  const cancelled = await runtime.cancel({
    workerRunKey: spawned.workerRunKey,
    reason: "user aborted",
  });
  assert.equal(cancelled?.status, "cancelled");
});

test("in-memory worker runtime emits runtime progress across start, wait, resume, and cancel", async () => {
  let callCount = 0;
  const phases: string[] = [];
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(): Promise<WorkerExecutionResult | null> {
      callCount += 1;
      return {
        workerType: "browser",
        status: callCount === 1 ? "partial" : "completed",
        summary: callCount === 1 ? "Need follow-up." : "Done.",
        payload: { callCount },
      };
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => 777,
    runtimeProgressRecorder: {
      async record(event) {
        phases.push(event.phase);
      },
    },
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);
  await runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });
  await runtime.resume({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });
  await runtime.cancel({
    workerRunKey: spawned.workerRunKey,
    reason: "stop",
  });

  assert.deepEqual(phases, ["started", "waiting", "started", "completed", "cancelled"]);
});

test("in-memory worker runtime emits long-running heartbeat ticks while a worker remains active", async () => {
  const phases: string[] = [];
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(): Promise<WorkerExecutionResult | null> {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        workerType: "browser",
        status: "completed",
        summary: "Done.",
        payload: null,
      };
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => Date.now(),
    heartbeatIntervalMs: 5,
    runtimeProgressRecorder: {
      async record(event) {
        phases.push(event.phase);
      },
    },
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);
  await runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });

  assert.ok(phases.includes("heartbeat"));
});

test("in-memory worker runtime stops stale heartbeats after execution token changes", async () => {
  let heartbeatCount = 0;
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(): Promise<WorkerExecutionResult | null> {
      await new Promise((resolve) => setTimeout(resolve, 35));
      return {
        workerType: "browser",
        status: "completed",
        summary: "Done.",
        payload: null,
      };
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => Date.now(),
    heartbeatIntervalMs: 5,
    runtimeProgressRecorder: {
      async record(event) {
        if (event.phase === "heartbeat") {
          heartbeatCount += 1;
        }
      },
    },
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);
  const sendPromise = runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  await runtime.interrupt({
    workerRunKey: spawned.workerRunKey,
    reason: "soft timeout reached",
  });
  const countAfterInterrupt = heartbeatCount;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await sendPromise;

  assert.equal(heartbeatCount, countAfterInterrupt);
});

test("in-memory worker runtime ignores heartbeat recorder failures", async () => {
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(): Promise<WorkerExecutionResult | null> {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        workerType: "browser",
        status: "completed",
        summary: "Done.",
        payload: null,
      };
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => Date.now(),
    heartbeatIntervalMs: 5,
    runtimeProgressRecorder: {
      async record(event) {
        if (event.phase === "heartbeat") {
          throw new Error("heartbeat recorder unavailable");
        }
      },
    },
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);
  const result = await runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });

  assert.equal(result?.status, "completed");
});

test("in-memory worker runtime does not re-dispatch done workers on resume", async () => {
  let callCount = 0;
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(): Promise<WorkerExecutionResult | null> {
      callCount += 1;
      return {
        workerType: "browser",
        status: "completed",
        summary: "Done.",
        payload: { callCount },
      };
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => 789,
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);
  const first = await runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });
  const resumed = await runtime.resume({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });

  assert.equal(callCount, 1);
  assert.deepEqual(resumed, first);
});

test("in-memory worker runtime re-dispatches done workers when continuity mode explicitly resumes", async () => {
  let callCount = 0;
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(): Promise<WorkerExecutionResult | null> {
      callCount += 1;
      return {
        workerType: "browser",
        status: "completed",
        summary: `Done ${callCount}.`,
        payload: { callCount },
      };
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => 790,
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);
  await runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });
  const resumed = await runtime.resume({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: {
      ...input.packet,
      continuityMode: "resume-existing",
    },
  });

  assert.equal(callCount, 2);
  assert.equal(resumed?.summary, "Done 2.");
});

test("in-memory worker runtime passes pre-execution resumable state into resumed handlers", async () => {
  let observedSessionStateStatus: string | undefined;
  let observedSessionPayload: unknown;
  let observedTaskPrompt = "";
  let callCount = 0;
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(input): Promise<WorkerExecutionResult | null> {
      callCount += 1;
      observedSessionStateStatus = input.sessionState?.status;
      observedSessionPayload = input.sessionState?.lastResult?.payload;
      observedTaskPrompt = input.packet.taskPrompt;
      return {
        workerType: "browser",
        status: callCount === 1 ? "partial" : "completed",
        summary: "ok",
        payload: {
          sessionId: "browser-session-77",
        },
      };
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => 900,
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);
  await runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });

  await runtime.resume({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });

  assert.equal(observedSessionStateStatus, "resumable");
  assert.deepEqual(observedSessionPayload, {
    sessionId: "browser-session-77",
  });
  assert.match(observedTaskPrompt, /Continuation context:/);
  assert.match(observedTaskPrompt, /Last result: ok/);
});

test("in-memory worker runtime builds a timeout continuation digest on interrupt", async () => {
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(): Promise<WorkerExecutionResult | null> {
      return {
        workerType: "browser",
        status: "partial",
        summary: "Collected partial browser evidence.",
        payload: { step: 1 },
      };
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => 901,
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);
  await runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });

  const interrupted = await runtime.interrupt({
    workerRunKey: spawned.workerRunKey,
    reason: "soft timeout reached",
  });

  assert.equal(interrupted?.status, "resumable");
  assert.equal(interrupted?.continuationDigest?.reason, "timeout_summary");
  assert.match(interrupted?.continuationDigest?.summary ?? "", /Collected partial browser evidence/);
});

test("in-memory worker runtime keeps continuity metadata when only currentTaskId is available", async () => {
  let observedTaskPrompt = "";
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(input): Promise<WorkerExecutionResult | null> {
      observedTaskPrompt = input.packet.taskPrompt;
      return {
        workerType: "browser",
        status: "completed",
        summary: "Done.",
        payload: {},
      };
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => 902,
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);

  await runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });

  const session = await runtime.getState(spawned.workerRunKey);
  assert.ok(session);
  delete session!.lastResult;
  delete session!.lastError;
  delete session!.continuationDigest;
  session!.status = "waiting_input";

  await runtime.resume({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });

  assert.match(observedTaskPrompt, /Continuation context:/);
  assert.match(observedTaskPrompt, /Current task: task-1/);
});

function buildWorkerInvocationInput(): WorkerInvocationInput {
  return {
    activation: {
      runState: {
        runKey: "role:operator:thread:1",
        threadId: "thread-1",
        roleId: "role-operator",
        mode: "group",
        status: "idle",
        iterationCount: 0,
        maxIterations: 6,
        inbox: [],
        lastActiveAt: 1,
      },
      thread: {
        threadId: "thread-1",
        teamId: "team-1",
        teamName: "Demo",
        leadRoleId: "role-lead",
        roles: [{ roleId: "role-operator", name: "Operator", seat: "member", runtime: "local", capabilities: ["browser"] }],
        participantLinks: [],
        metadataVersion: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      flow: {
        flowId: "flow-1",
        threadId: "thread-1",
        rootMessageId: "msg-root",
        mode: "serial",
        status: "running",
        currentStageIndex: 0,
        activeRoleIds: [],
        completedRoleIds: [],
        failedRoleIds: [],
        hopCount: 0,
        maxHops: 5,
        edges: [],
        createdAt: 1,
        updatedAt: 1,
      },
      handoff: {
        taskId: "task-1",
        flowId: "flow-1",
        sourceMessageId: "msg-1",
        targetRoleId: "role-operator",
        activationType: "mention",
        threadId: "thread-1",
        payload: {
          threadId: "thread-1",
          relayBrief: "",
          recentMessages: [],
          instructions: "Open https://example.com",
          dispatchPolicy: {
            allowParallel: false,
            allowReenter: true,
            sourceFlowMode: "serial",
          },
        },
        createdAt: 1,
      },
    },
    packet: {
      roleId: "role-operator",
      roleName: "Operator",
      systemPrompt: "browser operator",
      taskPrompt: "Use the browser worker for the assigned task.",
      outputContract: "Return a brief result.",
      suggestedMentions: [],
    },
  };
}
