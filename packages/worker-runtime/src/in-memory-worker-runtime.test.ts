import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkerExecutionResult,
  WorkerHandler,
  WorkerInvocationInput,
  WorkerRegistry,
  WorkerSessionRecord,
  WorkerSessionStore,
} from "@turnkeyai/core-types/team";
import { normalizeRelayPayload } from "@turnkeyai/core-types/team";

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

test("in-memory worker runtime keeps durable per-session message history", async () => {
  let now = 1000;
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(): Promise<WorkerExecutionResult | null> {
      now += 10;
      return {
        workerType: "browser",
        status: "completed",
        summary: "Captured browser evidence.",
        payload: { url: "https://example.test" },
      };
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => now++,
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);
  await runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: {
      ...input.packet,
      taskPrompt: "Open the target page and summarize it.",
    },
    toolCallId: "call-browser",
  });
  await runtime.cancel({
    workerRunKey: spawned.workerRunKey,
    reason: "operator stopped the session",
  });

  const state = await runtime.getState(spawned.workerRunKey);
  assert.equal(state?.history?.length, 3);
  assert.equal(state?.history?.[0]?.role, "user");
  assert.equal(state?.history?.[0]?.content, "Open the target page and summarize it.");
  assert.equal(state?.history?.[0]?.toolCallId, "call-browser");
  assert.equal(state?.history?.[1]?.role, "tool");
  assert.equal(state?.history?.[1]?.content, "Captured browser evidence.");
  assert.equal(state?.history?.[1]?.toolCallId, "call-browser");
  assert.deepEqual(state?.history?.[1]?.payload, { url: "https://example.test" });
  assert.equal(state?.history?.[2]?.role, "system");
  assert.equal(state?.history?.[2]?.status, "cancelled");
});

test("in-memory worker runtime appends child transcript entries from worker results", async () => {
  let now = 2000;
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(): Promise<WorkerExecutionResult | null> {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Browser sub-agent finished.",
        payload: { final: true },
        sessionHistoryEntries: [
          {
            id: "child-assistant-tool-call",
            role: "assistant",
            content: "Requested browser_snapshot.",
            createdAt: 2010,
            taskId: "task-1",
            toolCallId: "call-snapshot",
            toolName: "browser_snapshot",
            metadata: { kind: "assistant_tool_call" },
          },
          {
            id: "child-tool-result",
            role: "tool",
            content: "Snapshot captured.",
            createdAt: 2011,
            taskId: "task-1",
            toolCallId: "call-snapshot",
            toolName: "browser_snapshot",
            status: "completed",
          },
          {
            id: "child-assistant-final",
            role: "assistant",
            content: "The page evidence is ready.",
            createdAt: 2012,
            taskId: "task-1",
            status: "completed",
            metadata: { kind: "assistant_final" },
          },
        ],
      };
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => now++,
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);
  await runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
    toolCallId: "call-browser",
  });

  const state = await runtime.getState(spawned.workerRunKey);
  assert.deepEqual(state?.history?.map((entry) => entry.id), [
    "worker-history:worker:browser:task:task-1:task-1:user:2001",
    "child-assistant-tool-call",
    "child-tool-result",
    "child-assistant-final",
    "worker-history:worker:browser:task:task-1:task-1:tool:2002",
  ]);
  assert.equal(state?.history?.[1]?.role, "assistant");
  assert.equal(state?.history?.[1]?.toolName, "browser_snapshot");
  assert.equal(state?.history?.[2]?.role, "tool");
  assert.equal(state?.history?.[3]?.metadata?.kind, "assistant_final");
});

test("in-memory worker runtime includes durable child transcript when resuming a session", async () => {
  let callCount = 0;
  const prompts: string[] = [];
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(input): Promise<WorkerExecutionResult | null> {
      callCount += 1;
      prompts.push(input.packet.taskPrompt);
      if (callCount === 1) {
        return {
          workerType: "browser",
          status: "partial",
          summary: "Need another browser step.",
          payload: { step: 1 },
          sessionHistoryEntries: [
            {
              id: "resume-child-assistant-tool-call",
              role: "assistant",
              content: "Requested browser_snapshot.",
              createdAt: 3010,
              taskId: "task-1",
              toolCallId: "call-snapshot",
              toolName: "browser_snapshot",
            },
            {
              id: "resume-child-tool-result",
              role: "tool",
              content: "Snapshot found the pricing table.",
              createdAt: 3011,
              taskId: "task-1",
              toolCallId: "call-snapshot",
              toolName: "browser_snapshot",
              status: "completed",
            },
          ],
        };
      }
      return {
        workerType: "browser",
        status: "completed",
        summary: "Finished from prior evidence.",
        payload: { step: 2 },
      };
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => 3000 + callCount,
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

  assert.match(prompts[1] ?? "", /Recent sub-session transcript:/);
  assert.match(prompts[1] ?? "", /assistant tool=browser_snapshot: Requested browser_snapshot\./);
  assert.match(prompts[1] ?? "", /tool tool=browser_snapshot status=completed: Snapshot found the pricing table\./);
});

test("in-memory worker runtime aborts the active handler on cancel", async () => {
  let observedAbortReason: string | null = null;
  let markHandlerStarted!: () => void;
  let releaseHandler!: () => void;
  const handlerStarted = new Promise<void>((resolve) => {
    markHandlerStarted = resolve;
  });
  const handlerRunning = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(input): Promise<WorkerExecutionResult | null> {
      input.signal?.addEventListener("abort", () => {
        observedAbortReason = typeof input.signal?.reason === "string" ? input.signal.reason : "aborted";
        releaseHandler();
      });
      markHandlerStarted();
      await handlerRunning;
      throw new Error("handler stopped after abort");
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => 123,
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);
  const sendPromise = runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
    toolCallId: "call-cancel",
  });

  await handlerStarted;
  await runtime.cancel({
    workerRunKey: spawned.workerRunKey,
    reason: "operator cancelled browser work",
  });
  const result = await sendPromise;
  const state = await runtime.getState(spawned.workerRunKey);

  assert.equal(result, null);
  assert.equal(observedAbortReason, "operator cancelled browser work");
  assert.equal(state?.status, "cancelled");
});

test("in-memory worker runtime does not return stale resolved results after cancel", async () => {
  let observedAbortReason: string | null = null;
  let markHandlerStarted!: () => void;
  let releaseHandler!: () => void;
  const handlerStarted = new Promise<void>((resolve) => {
    markHandlerStarted = resolve;
  });
  const handlerRunning = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  const handler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      return true;
    },
    async run(input): Promise<WorkerExecutionResult | null> {
      input.signal?.addEventListener("abort", () => {
        observedAbortReason = typeof input.signal?.reason === "string" ? input.signal.reason : "aborted";
        releaseHandler();
      });
      markHandlerStarted();
      await handlerRunning;
      return {
        workerType: "browser",
        status: "completed",
        summary: "stale completion",
        payload: { stale: true },
      };
    },
  };

  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
    },
    now: () => 123,
  });

  const input = buildWorkerInvocationInput();
  const spawned = await runtime.spawn(input);
  assert.ok(spawned);
  const sendPromise = runtime.send({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
    toolCallId: "call-cancel-success",
  });

  await handlerStarted;
  await runtime.cancel({
    workerRunKey: spawned.workerRunKey,
    reason: "operator cancelled browser work",
  });
  const result = await sendPromise;
  const state = await runtime.getState(spawned.workerRunKey);

  assert.equal(result, null);
  assert.equal(observedAbortReason, "operator cancelled browser work");
  assert.equal(state?.status, "cancelled");
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
  const doneState = await runtime.getState(spawned.workerRunKey);
  assert.equal(doneState?.status, "done");
  assert.equal(new Set(doneState?.history?.map((entry) => entry.id)).size, doneState?.history?.length);

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

test("in-memory worker runtime persists sessions and rehydrates running work as resumable", async () => {
  const stored = new Map<string, Awaited<ReturnType<WorkerSessionStore["get"]>>>();
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

  const sessionStore: WorkerSessionStore = {
    async get(workerRunKey) {
      return stored.get(workerRunKey) ?? null;
    },
    async put(record) {
      stored.set(record.workerRunKey, {
        ...record,
        state: {
          ...record.state,
          ...(record.state.lastResult ? { lastResult: { ...record.state.lastResult } } : {}),
          ...(record.state.lastError ? { lastError: { ...record.state.lastError } } : {}),
          ...(record.state.continuationDigest ? { continuationDigest: { ...record.state.continuationDigest } } : {}),
        },
        ...(record.context ? { context: { ...record.context } } : {}),
      });
    },
    async list() {
      return [...stored.values()].filter((value): value is NonNullable<typeof value> => Boolean(value));
    },
  };

  const initialRuntime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
      async getHandler(kind) {
        return kind === "browser" ? handler : null;
      },
    },
    sessionStore,
    now: () => 1000,
  });

  const input = buildWorkerInvocationInput();
  const spawned = await initialRuntime.spawn(input);
  assert.ok(spawned);

  const persistedBeforeRestart = stored.get(spawned.workerRunKey);
  assert.equal(persistedBeforeRestart?.state.status, "idle");

  stored.set(spawned.workerRunKey, {
    workerRunKey: spawned.workerRunKey,
    executionToken: 3,
    state: {
      workerRunKey: spawned.workerRunKey,
      workerType: "browser",
      status: "running",
      createdAt: 1000,
      updatedAt: 1005,
      currentTaskId: "task-1",
      history: [
        {
          id: "history-before-restart",
          role: "user",
          content: "Open the page before restart.",
          createdAt: 1004,
          taskId: "task-1",
        },
      ],
    },
    context: {
      threadId: "thread-1",
      flowId: "flow-1",
      taskId: "task-1",
      roleId: "role-operator",
      parentSpanId: "role:role:operator:thread:1",
    },
  });

  const restartedRuntime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return handler;
      },
      async getHandler(kind) {
        return kind === "browser" ? handler : null;
      },
    },
    sessionStore,
    now: () => 2000,
  });

  const rehydrated = await restartedRuntime.getState(spawned.workerRunKey);
  assert.equal(rehydrated?.status, "resumable");
  assert.equal(rehydrated?.continuationDigest?.reason, "supervisor_retry");
  assert.match(rehydrated?.continuationDigest?.summary ?? "", /runtime restarted/i);
  assert.equal(rehydrated?.history?.[0]?.id, "history-before-restart");
  assert.equal(rehydrated?.history?.at(-1)?.role, "system");
  assert.equal(rehydrated?.history?.at(-1)?.status, "interrupted");
  assert.match(rehydrated?.history?.at(-1)?.content ?? "", /runtime restarted/i);

  const resumed = await restartedRuntime.resume({
    workerRunKey: spawned.workerRunKey,
    activation: input.activation,
    packet: input.packet,
  });
  assert.equal(resumed?.status, "completed");
  const stateAfterResume = await restartedRuntime.getState(spawned.workerRunKey);
  assert.equal(stateAfterResume?.status, "done");
  assert.equal(stateAfterResume?.history?.some((entry) => entry.status === "interrupted"), true);
  assert.equal(stateAfterResume?.history?.at(-1)?.role, "tool");
  assert.equal(stateAfterResume?.history?.at(-1)?.content, "Done 1.");
});

test("in-memory worker runtime exposes startup reconcile summary after hydration", async () => {
  const stored = new Map<string, WorkerSessionRecord>([
    [
      "worker:browser:task:task-running",
      {
        workerRunKey: "worker:browser:task:task-running",
        executionToken: 3,
        state: {
          workerRunKey: "worker:browser:task:task-running",
          workerType: "browser",
          status: "running",
          createdAt: 10,
          updatedAt: 20,
          currentTaskId: "task-running",
        },
        context: {
          threadId: "thread-1",
          flowId: "flow-1",
          taskId: "task-running",
          roleId: "role-operator",
          parentSpanId: "role:role-operator:thread:1",
        },
      },
    ],
    [
      "worker:finance:task:task-done",
      {
        workerRunKey: "worker:finance:task:task-done",
        executionToken: 1,
        state: {
          workerRunKey: "worker:finance:task:task-done",
          workerType: "finance",
          status: "done",
          createdAt: 30,
          updatedAt: 40,
        },
      },
    ],
  ]);
  const sessionStore: WorkerSessionStore = {
    async get(workerRunKey) {
      return stored.get(workerRunKey) ?? null;
    },
    async put(record) {
      stored.set(record.workerRunKey, record);
    },
    async list() {
      return Array.from(stored.values());
    },
  };
  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return {
          kind: "browser",
          async canHandle() {
            return true;
          },
          async run() {
            return null;
          },
        };
      },
      async getHandler(kind) {
        if (kind !== "browser") {
          return null;
        }
        return {
          kind: "browser",
          async canHandle() {
            return true;
          },
          async run() {
            return null;
          },
        };
      },
    },
    sessionStore,
    now: () => 500,
  });

  const result = await runtime.reconcileStartup();

  assert.deepEqual(result, {
    totalSessions: 2,
    downgradedRunningSessions: 1,
    unrecoverableSessions: 0,
    unrecoverableMissingContextSessions: 0,
    unrecoverableUnavailableHandlerSessions: 0,
  });
  assert.equal(stored.get("worker:browser:task:task-running")?.state.status, "resumable");
});

test("in-memory worker runtime marks persisted sessions without context as unrecoverable on startup", async () => {
  const stored = new Map<string, WorkerSessionRecord>([
    [
      "worker:browser:task:task-missing-context",
      {
        workerRunKey: "worker:browser:task:task-missing-context",
        executionToken: 1,
        state: {
          workerRunKey: "worker:browser:task:task-missing-context",
          workerType: "browser",
          status: "resumable",
          createdAt: 10,
          updatedAt: 20,
          currentTaskId: "task-missing-context",
        },
      },
    ],
  ]);
  const sessionStore: WorkerSessionStore = {
    async get(workerRunKey) {
      return stored.get(workerRunKey) ?? null;
    },
    async put(record) {
      stored.set(workerRunKeyOf(record), record);
    },
    async list() {
      return Array.from(stored.values());
    },
  };
  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return null;
      },
      async getHandler() {
        return null;
      },
    },
    sessionStore,
    now: () => 500,
  });

  const result = await runtime.reconcileStartup();
  const restored = await runtime.getState("worker:browser:task:task-missing-context");

  assert.deepEqual(result, {
    totalSessions: 1,
    downgradedRunningSessions: 0,
    unrecoverableSessions: 1,
    unrecoverableMissingContextSessions: 1,
    unrecoverableUnavailableHandlerSessions: 0,
  });
  assert.equal(restored?.status, "failed");
  assert.match(restored?.lastError?.message ?? "", /context was missing/i);
});

test("in-memory worker runtime marks persisted sessions with unavailable handlers as unrecoverable on startup", async () => {
  const stored = new Map<string, WorkerSessionRecord>([
    [
      "worker:finance:task:task-missing-handler",
      {
        workerRunKey: "worker:finance:task:task-missing-handler",
        executionToken: 1,
        state: {
          workerRunKey: "worker:finance:task:task-missing-handler",
          workerType: "finance",
          status: "waiting_external",
          createdAt: 10,
          updatedAt: 20,
          currentTaskId: "task-missing-handler",
        },
        context: {
          threadId: "thread-1",
          flowId: "flow-1",
          taskId: "task-missing-handler",
          roleId: "role-operator",
          parentSpanId: "role:role-operator:thread:1",
        },
      },
    ],
  ]);
  const sessionStore: WorkerSessionStore = {
    async get(workerRunKey) {
      return stored.get(workerRunKey) ?? null;
    },
    async put(record) {
      stored.set(workerRunKeyOf(record), record);
    },
    async list() {
      return Array.from(stored.values());
    },
  };
  const runtime = new InMemoryWorkerRuntime({
    workerRegistry: {
      async selectHandler() {
        return null;
      },
      async getHandler() {
        return null;
      },
    },
    sessionStore,
    now: () => 600,
  });

  const result = await runtime.reconcileStartup();
  const restored = await runtime.getState("worker:finance:task:task-missing-handler");

  assert.deepEqual(result, {
    totalSessions: 1,
    downgradedRunningSessions: 0,
    unrecoverableSessions: 1,
    unrecoverableMissingContextSessions: 0,
    unrecoverableUnavailableHandlerSessions: 1,
  });
  assert.equal(restored?.status, "failed");
  assert.match(restored?.lastError?.message ?? "", /no handler is available/i);
});

function workerRunKeyOf(record: WorkerSessionRecord): string {
  return record.workerRunKey;
}

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
        payload: normalizeRelayPayload({
          threadId: "thread-1",
          relayBrief: "",
          recentMessages: [],
          instructions: "Open https://example.com",
          dispatchPolicy: {
            allowParallel: false,
            allowReenter: true,
            sourceFlowMode: "serial",
          },
        }),
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
