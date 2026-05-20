import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput, WorkerRuntime } from "@turnkeyai/core-types/team";

import { InMemoryToolCancellationRegistry } from "./tool-cancellation-registry";
import { createWorkerSessionToolExecutor } from "./tool-use";

test("sessions tool definitions only advertise registered worker kinds when provided", () => {
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    availableWorkerKinds: ["browser", "explore", "finance"],
  });

  const spawn = executor.definitions().find((definition) => definition.name === "sessions_spawn");
  const list = executor.definitions().find((definition) => definition.name === "sessions_list");

  const spawnSchema = spawn?.inputSchema as {
    properties?: { agent_id?: { enum?: string[] } };
  };
  const listSchema = list?.inputSchema as {
    properties?: { agent_id?: { enum?: string[] }; kinds?: { items?: { enum?: string[] } } };
  };
  assert.deepEqual(spawnSchema.properties?.agent_id?.enum, ["browser", "explore", "finance"]);
  assert.deepEqual(listSchema.properties?.agent_id?.enum, ["browser", "explore", "finance"]);
  assert.deepEqual(listSchema.properties?.kinds?.items?.enum, ["browser", "explore", "finance"]);
});

test("sessions_spawn marks a selected worker with no executable result as a failed tool call", async () => {
  const workerRuntime = {
    async spawn() {
      return { workerType: "explore", workerRunKey: "worker:explore:task-1" };
    },
    async send() {
      return null;
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime });

  const result = await executor.execute({
    call: {
      id: "call-no-result",
      name: "sessions_spawn",
      input: {
        agent_id: "explore",
        task: "Research an unsupported target.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Research an unsupported target.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; result: string };
  assert.equal(result.isError, true);
  assert.equal(body.status, "failed");
  assert.match(body.result, /no executable result/i);
  assert.equal(result.progress?.at(-1)?.phase, "failed");
});

test("sessions_spawn cancels the active worker when the tool call is cancelled", async () => {
  let resolveSend!: () => void;
  let sendStarted!: () => void;
  let cancelledReason: string | null = null;
  const sendStartedPromise = new Promise<void>((resolve) => {
    sendStarted = resolve;
  });
  const releaseSendPromise = new Promise<void>((resolve) => {
    resolveSend = resolve;
  });
  const workerRuntime = {
    async spawn() {
      return { workerType: "browser", workerRunKey: "worker:browser:task-1" };
    },
    async send() {
      sendStarted();
      await releaseSendPromise;
      return {
        workerType: "browser",
        status: "completed",
        summary: "Should not be used after cancellation.",
        payload: null,
      };
    },
    async cancel(input: { reason?: string }) {
      cancelledReason = input.reason ?? null;
      return null;
    },
  } as unknown as WorkerRuntime;
  const toolCancellationRegistry = new InMemoryToolCancellationRegistry();
  const executor = createWorkerSessionToolExecutor({ workerRuntime, toolCancellationRegistry });

  const executePromise = executor.execute({
    call: {
      id: "call-cancel",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open a slow browser page.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Open a slow browser page.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  await sendStartedPromise;
  await toolCancellationRegistry.cancel({
    threadId: "thread-1",
    toolCallIds: ["call-cancel"],
    reason: "operator stopped browser work",
  });
  resolveSend();

  const result = await executePromise;
  assert.equal(cancelledReason, "operator stopped browser work");
  assert.equal(result.isError, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.content, "operator stopped browser work");
  assert.equal(result.progress?.at(-1)?.phase, "cancelled");
});

test("sessions_list filters by thread, kind, agent_id, parentSessionKey, and activeMinutes", async () => {
  const now = Date.now();
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:recent",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:browser:recent",
            workerType: "browser",
            status: "done",
            createdAt: now - 60_000,
            updatedAt: now - 30_000,
            lastResult: { workerType: "browser", status: "completed", summary: "ok", payload: null },
          },
        },
        {
          workerRunKey: "worker:explore:recent",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-2",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:explore:recent",
            workerType: "explore",
            status: "done",
            createdAt: now - 60_000,
            updatedAt: now - 30_000,
          },
        },
        {
          workerRunKey: "worker:browser:foreign",
          executionToken: 1,
          context: {
            threadId: "thread-2",
            flowId: "flow-2",
            taskId: "task-3",
            roleId: "role-lead",
            parentSpanId: "role:foreign",
          },
          state: {
            workerRunKey: "worker:browser:foreign",
            workerType: "browser",
            status: "done",
            createdAt: now - 60_000,
            updatedAt: now - 30_000,
          },
        },
      ];
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime });

  const result = await executor.execute({
    call: {
      id: "call-1",
      name: "sessions_list",
      input: {
        agent_id: "browser",
        parentSessionKey: "role:role-lead:thread:thread-1",
        activeMinutes: 10,
      },
    },
    activation: {
      thread: {
        threadId: "thread-1",
        teamId: "team-1",
        teamName: "Team",
        leadRoleId: "role-lead",
        roles: [{ roleId: "role-lead", name: "Lead", seat: "lead", runtime: "local" }],
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
        activeRoleIds: ["role-lead"],
        completedRoleIds: [],
        failedRoleIds: [],
        hopCount: 1,
        maxHops: 4,
        edges: [],
        createdAt: 1,
        updatedAt: 1,
      },
      runState: {
        runKey: "role:role-lead:thread:thread-1",
        threadId: "thread-1",
        roleId: "role-lead",
        mode: "group",
        status: "running",
        iterationCount: 1,
        maxIterations: 4,
        inbox: [],
        lastActiveAt: 1,
      },
      handoff: {
        taskId: "task-1",
        flowId: "flow-1",
        sourceMessageId: "msg-root",
        targetRoleId: "role-lead",
        activationType: "cascade",
        threadId: "thread-1",
        payload: {
          threadId: "thread-1",
          intent: { relayBrief: "List sessions", recentMessages: [] },
        },
        createdAt: 1,
      },
    },
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "List sessions.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { sessions: Array<{ session_key: string }> };
  assert.deepEqual(body.sessions.map((session) => session.session_key), ["worker:browser:recent"]);
});

test("sessions_history reads durable session history with pagination and payload gating", async () => {
  const history = [
    {
      id: "history-1",
      role: "user" as const,
      content: "Open the page.",
      createdAt: 100,
      taskId: "task-1",
    },
    {
      id: "history-2",
      role: "tool" as const,
      content: "Snapshot captured.",
      createdAt: 110,
      taskId: "task-1",
      toolName: "browser" as const,
      status: "completed" as const,
      payload: { title: "Example" },
    },
    {
      id: "history-3",
      role: "user" as const,
      content: "Click the login button.",
      createdAt: 120,
      taskId: "task-2",
    },
  ];
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:recent",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:browser:recent",
            workerType: "browser",
            status: "done",
            createdAt: 90,
            updatedAt: 120,
            history,
          },
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:browser:recent",
        workerType: "browser",
        status: "done",
        createdAt: 90,
        updatedAt: 120,
        history,
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime });

  const result = await executor.execute({
    call: {
      id: "call-1",
      name: "sessions_history",
      input: {
        session_key: "worker:browser:recent",
        offset: 1,
        limit: 1,
        include_tools: true,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Read history.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as {
    total_messages: number;
    showing: number;
    has_more: boolean;
    messages: Array<{ role: string; content: string; payload?: unknown }>;
  };
  assert.equal(body.total_messages, 3);
  assert.equal(body.showing, 1);
  assert.equal(body.has_more, true);
  assert.deepEqual(body.messages, [
    {
      id: "history-2",
      role: "tool",
      content: "Snapshot captured.",
      created_at: 110,
      task_id: "task-1",
      name: "browser",
      status: "completed",
      payload: { title: "Example" },
    },
  ]);
});

test("sessions_history falls back to legacy lastResult when durable history is absent", async () => {
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:legacy",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-legacy",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:browser:legacy",
            workerType: "browser",
            status: "done",
            createdAt: 90,
            updatedAt: 140,
            currentTaskId: "task-legacy",
            lastResult: {
              workerType: "browser",
              status: "completed",
              summary: "Legacy result summary.",
              payload: { title: "Legacy" },
            },
          },
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:browser:legacy",
        workerType: "browser",
        status: "done",
        createdAt: 90,
        updatedAt: 140,
        currentTaskId: "task-legacy",
        lastResult: {
          workerType: "browser",
          status: "completed",
          summary: "Legacy result summary.",
          payload: { title: "Legacy" },
        },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime });

  const result = await executor.execute({
    call: {
      id: "call-legacy",
      name: "sessions_history",
      input: {
        session_key: "worker:browser:legacy",
        include_tools: true,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Read legacy history.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { messages: Array<Record<string, unknown>> };
  assert.deepEqual(body.messages, [
    {
      id: "worker-history:worker:browser:legacy:legacy-result",
      role: "tool",
      content: "Legacy result summary.",
      created_at: 140,
      task_id: "task-legacy",
      name: "browser",
      status: "completed",
      payload: { title: "Legacy" },
    },
  ]);
});

function buildActivation(): RoleActivationInput {
  return {
    thread: {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Team",
      leadRoleId: "role-lead",
      roles: [{ roleId: "role-lead", name: "Lead", seat: "lead", runtime: "local" }],
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
      activeRoleIds: ["role-lead"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 1,
      maxHops: 4,
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    },
    runState: {
      runKey: "role:role-lead:thread:thread-1",
      threadId: "thread-1",
      roleId: "role-lead",
      mode: "group",
      status: "running",
      iterationCount: 1,
      maxIterations: 4,
      inbox: [],
      lastActiveAt: 1,
    },
    handoff: {
      taskId: "task-1",
      flowId: "flow-1",
      sourceMessageId: "msg-root",
      targetRoleId: "role-lead",
      activationType: "cascade",
      threadId: "thread-1",
      payload: {
        threadId: "thread-1",
        intent: { relayBrief: "Inspect history", recentMessages: [] },
      },
      createdAt: 1,
    },
  };
}
