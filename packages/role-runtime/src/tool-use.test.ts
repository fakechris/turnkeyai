import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput, WorkerInvocationInput, WorkerRuntime } from "@turnkeyai/core-types/team";

import type { TaskToolService } from "./task-tool-service";
import type { RolePromptPacket } from "./prompt-policy";
import { InMemoryToolCancellationRegistry } from "./tool-cancellation-registry";
import type { ToolPermissionService } from "./tool-permission-service";
import { createWorkerSessionToolExecutor } from "./tool-use";

test("sessions tool definitions only advertise registered worker kinds when provided", () => {
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    availableWorkerKinds: ["browser", "explore", "finance"],
  });

  const spawn = executor.definitions().find((definition) => definition.name === "sessions_spawn");
  const list = executor.definitions().find((definition) => definition.name === "sessions_list");
  const history = executor.definitions().find((definition) => definition.name === "sessions_history");

  const spawnSchema = spawn?.inputSchema as {
    properties?: { agent_id?: { enum?: string[] }; timeout_seconds?: { minimum?: number; maximum?: number } };
  };
  const listSchema = list?.inputSchema as {
    properties?: { agent_id?: { enum?: string[] }; kinds?: { items?: { enum?: string[] } } };
  };
  const historySchema = history?.inputSchema as {
    properties?: { cursor?: { type?: string }; tail?: { type?: string } };
  };
  assert.deepEqual(spawnSchema.properties?.agent_id?.enum, ["browser", "explore", "finance"]);
  assert.equal(spawnSchema.properties?.timeout_seconds?.minimum, 0.001);
  assert.equal(spawnSchema.properties?.timeout_seconds?.maximum, 1800);
  assert.deepEqual(listSchema.properties?.agent_id?.enum, ["browser", "explore", "finance"]);
  assert.deepEqual(listSchema.properties?.kinds?.items?.enum, ["browser", "explore", "finance"]);
  assert.equal(historySchema.properties?.cursor?.type, "string");
  assert.equal(historySchema.properties?.tail?.type, "boolean");
});

test("sessions tool definitions expose configured production timeout cap", () => {
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    availableWorkerKinds: ["browser", "explore"],
    maxSessionToolTimeoutMs: 45_000,
  });

  const spawn = executor.definitions().find((definition) => definition.name === "sessions_spawn");
  const send = executor.definitions().find((definition) => definition.name === "sessions_send");
  const spawnSchema = spawn?.inputSchema as {
    properties?: { timeout_seconds?: { maximum?: number } };
  };
  const sendSchema = send?.inputSchema as {
    properties?: { timeout_seconds?: { maximum?: number } };
  };

  assert.equal(spawnSchema.properties?.timeout_seconds?.maximum, 45);
  assert.equal(sendSchema.properties?.timeout_seconds?.maximum, 45);
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
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

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

test("sessions_spawn exposes sub-agent final content at top level", async () => {
  let capturedWorkerSession: unknown = null;
  const workerRuntime = {
    async spawn(input: WorkerInvocationInput) {
      capturedWorkerSession = input.packet.workerSession;
      return { workerType: "explore", workerRunKey: "worker:explore:task-1" };
    },
    async send() {
      return {
        workerType: "explore",
        status: "completed",
        summary: "Evidence gathered.",
        payload: {
          mode: "llm_sub_agent",
          workerType: "explore",
          content: "Full evidence ledger with source URLs.",
        },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  const result = await executor.execute({
    call: {
      id: "call-result",
      name: "sessions_spawn",
      input: {
        agent_id: "explore",
        task: "Research target.",
        label: "Primary research",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Research target.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as {
    protocol?: string;
    final_content?: string;
    label?: string;
    parent_session_key?: string;
    tool_call_id?: string;
    payload?: { content?: string };
  };
  assert.equal(body.protocol, "turnkeyai.session_tool_result.v1");
  assert.equal(body.final_content, "Full evidence ledger with source URLs.");
  assert.equal(body.label, "Primary research");
  assert.equal(body.parent_session_key, "role:role-lead:thread:thread-1");
  assert.equal(body.tool_call_id, "call-result");
  assert.equal(body.payload?.content, "Full evidence ledger with source URLs.");
  assert.deepEqual(capturedWorkerSession, {
    parentSessionKey: "role:role-lead:thread:thread-1",
    toolCallId: "call-result",
    label: "Primary research",
  });
});

test("sessions_spawn carries parent source URLs into delegated tasks that omitted them", async () => {
  let capturedTaskPrompt = "";
  const activation = buildActivation();
  activation.handoff.payload = {
    threadId: "thread-1",
    intent: {
      relayBrief: "",
      instructions: [
        "Compare these source pages.",
        "Vendor Alpha source: http://127.0.0.1:4101/vendor-alpha",
        "Vendor Beta source: http://127.0.0.1:4101/vendor-beta",
      ].join("\n"),
      recentMessages: [],
    },
  };
  const workerRuntime = {
    async spawn(input: WorkerInvocationInput) {
      capturedTaskPrompt = input.packet.taskPrompt;
      return { workerType: "explore", workerRunKey: "worker:explore:task-1" };
    },
    async send() {
      return {
        workerType: "explore",
        status: "completed",
        summary: "Evidence gathered.",
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  await executor.execute({
    call: {
      id: "call-parent-context",
      name: "sessions_spawn",
      input: {
        agent_id: "explore",
        task: "Review Vendor Beta pricing and risk.",
      },
    },
    activation,
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Compare vendors.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.match(capturedTaskPrompt, /Review Vendor Beta pricing and risk/);
  assert.match(capturedTaskPrompt, /Parent mission context relevant to this delegated task/);
  assert.match(capturedTaskPrompt, /Vendor Beta source: http:\/\/127\.0\.0\.1:4101\/vendor-beta/);
  assert.doesNotMatch(capturedTaskPrompt, /vendor-alpha[\s\S]*vendor-beta/i, "matched Beta source should be prioritized before Alpha");
});

test("sessions_spawn does not append parent URL context when the delegated task is already self-contained", async () => {
  let capturedTaskPrompt = "";
  const activation = buildActivation();
  activation.handoff.payload = {
    threadId: "thread-1",
    intent: {
      relayBrief: "",
      instructions: "Vendor Alpha source: http://127.0.0.1:4101/vendor-alpha",
      recentMessages: [],
    },
  };
  const workerRuntime = {
    async spawn(input: WorkerInvocationInput) {
      capturedTaskPrompt = input.packet.taskPrompt;
      return { workerType: "explore", workerRunKey: "worker:explore:task-1" };
    },
    async send() {
      return {
        workerType: "explore",
        status: "completed",
        summary: "Evidence gathered.",
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  await executor.execute({
    call: {
      id: "call-self-contained",
      name: "sessions_spawn",
      input: {
        agent_id: "explore",
        task: "Fetch http://127.0.0.1:4101/vendor-alpha and summarize pricing.",
      },
    },
    activation,
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Compare vendors.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(capturedTaskPrompt, "Fetch http://127.0.0.1:4101/vendor-alpha and summarize pricing.");
});

test("sessions_spawn rejects worker kinds that were not advertised as executable", async () => {
  let spawnCalled = false;
  const workerRuntime = {
    async spawn() {
      spawnCalled = true;
      return { workerType: "browser", workerRunKey: "worker:browser:task-1" };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
  });

  const result = await executor.execute({
    call: {
      id: "call-unavailable",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open a browser page.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Open a browser page.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(spawnCalled, false);
  assert.equal(result.isError, true);
  assert.match(result.content, /Worker kind browser is not available/);
  assert.match(result.content, /explore/);
});

test("sessions_spawn enforces per-parent active sub-agent concurrency before spawning", async () => {
  let spawnCalled = false;
  const activation = buildActivation();
  const workerRuntime = {
    async listSessions() {
      return Array.from({ length: 5 }, (_, index) => ({
        workerRunKey: `worker:browser:active-${index}`,
        executionToken: 1,
        context: {
          threadId: "thread-1",
          flowId: "flow-1",
          taskId: `task-active-${index}`,
          roleId: "role-lead",
          parentSpanId: `role:${activation.runState.runKey}`,
        },
        state: {
          workerRunKey: `worker:browser:active-${index}`,
          workerType: "browser",
          status: "running",
          createdAt: index,
          updatedAt: index,
        },
      }));
    },
    async spawn() {
      spawnCalled = true;
      return { workerType: "browser", workerRunKey: "worker:browser:extra" };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    sessionConcurrency: { maxPerParentConcurrent: 5, maxGlobalActive: 12 },
  });

  const result = await executor.execute({
    call: {
      id: "call-parent-limit",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open another browser page.",
      },
    },
    activation,
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Open another browser page.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as {
    status: string;
    scope: string;
    active_sessions: number;
    limit: number;
    result: string;
  };
  assert.equal(spawnCalled, false);
  assert.equal(result.isError, true);
  assert.equal(body.status, "sub_agent_concurrency_limit");
  assert.equal(body.scope, "parent");
  assert.equal(body.active_sessions, 5);
  assert.equal(body.limit, 5);
  assert.match(body.result, /sub_agent_concurrency_limit/);
});

test("sessions_spawn checks concurrency atomically with spawn under parallel tool execution", async () => {
  const activation = buildActivation();
  const records: Array<{
    workerRunKey: string;
    executionToken: number;
    context: {
      threadId: string;
      flowId: string;
      taskId: string;
      roleId: string;
      parentSpanId: string;
    };
    state: {
      workerRunKey: string;
      workerType: "browser";
      status: "idle";
      createdAt: number;
      updatedAt: number;
    };
  }> = [];
  let spawnCount = 0;
  const workerRuntime = {
    async listSessions() {
      return [...records];
    },
    async spawn() {
      spawnCount += 1;
      const workerRunKey = `worker:browser:atomic-${spawnCount}`;
      records.push({
        workerRunKey,
        executionToken: 0,
        context: {
          threadId: "thread-1",
          flowId: "flow-1",
          taskId: `task-atomic-${spawnCount}`,
          roleId: "role-lead",
          parentSpanId: `role:${activation.runState.runKey}`,
        },
        state: {
          workerRunKey,
          workerType: "browser",
          status: "idle",
          createdAt: spawnCount,
          updatedAt: spawnCount,
        },
      });
      return { workerType: "browser", workerRunKey };
    },
    async send(input: { workerRunKey: string }) {
      return {
        workerType: "browser",
        status: "completed",
        summary: `Completed ${input.workerRunKey}.`,
        payload: null,
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    sessionConcurrency: { maxPerParentConcurrent: 1, maxGlobalActive: 12 },
  });
  const packet = {
    roleId: "role-lead",
    roleName: "Lead",
    seat: "lead" as const,
    systemPrompt: "Lead.",
    taskPrompt: "Open two pages.",
    outputContract: "Return result.",
    suggestedMentions: [],
  };

  const results = await Promise.all([
    executor.execute({
      call: { id: "call-atomic-1", name: "sessions_spawn", input: { agent_id: "browser", task: "Open page A." } },
      activation,
      packet,
    }),
    executor.execute({
      call: { id: "call-atomic-2", name: "sessions_spawn", input: { agent_id: "browser", task: "Open page B." } },
      activation,
      packet,
    }),
  ]);

  assert.equal(spawnCount, 1);
  assert.equal(results.filter((result) => result.isError).length, 1);
  assert.equal(results.filter((result) => !result.isError).length, 1);
  assert.equal(
    results.some((result) => result.content.includes('"status": "sub_agent_concurrency_limit"')),
    true
  );
});

test("sessions_spawn enforces global active sub-agent concurrency before spawning", async () => {
  let spawnCalled = false;
  const workerRuntime = {
    async listSessions() {
      return Array.from({ length: 12 }, (_, index) => ({
        workerRunKey: `worker:explore:active-${index}`,
        executionToken: 1,
        context: {
          threadId: `thread-${index}`,
          flowId: `flow-${index}`,
          taskId: `task-active-${index}`,
          roleId: "role-lead",
          parentSpanId: `role:other-${index}`,
        },
        state: {
          workerRunKey: `worker:explore:active-${index}`,
          workerType: "explore",
          status: index % 2 === 0 ? "running" : "waiting_external",
          createdAt: index,
          updatedAt: index,
        },
      }));
    },
    async spawn() {
      spawnCalled = true;
      return { workerType: "explore", workerRunKey: "worker:explore:extra" };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
    sessionConcurrency: { maxPerParentConcurrent: 5, maxGlobalActive: 12 },
  });

  const result = await executor.execute({
    call: {
      id: "call-global-limit",
      name: "sessions_spawn",
      input: {
        agent_id: "explore",
        task: "Research another source.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Research another source.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; scope: string; active_sessions: number; limit: number };
  assert.equal(spawnCalled, false);
  assert.equal(result.isError, true);
  assert.equal(body.status, "sub_agent_concurrency_limit");
  assert.equal(body.scope, "global");
  assert.equal(body.active_sessions, 12);
  assert.equal(body.limit, 12);
});

test("sessions_spawn blocks browser side effects before worker execution until approved", async () => {
  let spawnCalled = false;
  let requestedCacheKey = "";
  const toolPermissionService: ToolPermissionService = {
    async request(input) {
      requestedCacheKey = input.requirement.cacheKey ?? "";
      assert.equal(input.action, "browser.form.submit");
      assert.equal(input.toolCallId, "call-submit");
      return {
        status: "pending",
        approvalId: "ap.thread-1.call-submit",
        action: input.action,
        requirement: {
          level: input.requirement.level,
          scope: input.requirement.scope,
          cacheKey: input.requirement.cacheKey ?? "missing",
          rationale: input.requirement.rationale,
          workerType: input.requirement.workerType ?? "browser",
        },
        message: "Approval is pending.",
      };
    },
    async result() {
      throw new Error("not used");
    },
    async apply() {
      throw new Error("not used");
    },
  };
  const workerRuntime = {
    async spawn() {
      spawnCalled = true;
      return { workerType: "browser", workerRunKey: "worker:browser:task-1" };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService,
  });

  const result = await executor.execute({
    call: {
      id: "call-submit",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open the billing page and submit the purchase form.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Open the billing page and submit the purchase form.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; blocked_before_side_effect: boolean; approval_id: string };
  assert.equal(spawnCalled, false);
  assert.equal(result.isError, true);
  assert.equal(body.status, "requires_approval");
  assert.equal(body.blocked_before_side_effect, true);
  assert.equal(body.approval_id, "ap.thread-1.call-submit");
  assert.equal(requestedCacheKey, "thread-1:browser:mutate:approval:browser.form.submit");
  assert.equal(result.progress?.[0]?.detail?.eventType, "permission.query");
});

test("sessions_spawn proceeds with browser side effects after permission cache grants the action", async () => {
  let spawnCalled = false;
  const toolPermissionService: ToolPermissionService = {
    async request(input) {
      return {
        status: "already_granted",
        action: input.action,
        requirement: {
          level: input.requirement.level,
          scope: input.requirement.scope,
          cacheKey: input.requirement.cacheKey ?? "missing",
          rationale: input.requirement.rationale,
          workerType: input.requirement.workerType ?? "browser",
        },
        message: "Already granted.",
      };
    },
    async result() {
      throw new Error("not used");
    },
    async apply() {
      throw new Error("not used");
    },
  };
  const workerRuntime = {
    async spawn() {
      spawnCalled = true;
      return { workerType: "browser", workerRunKey: "worker:browser:task-1" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Submitted after approval.",
        payload: { submitted: true },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService,
  });

  const result = await executor.execute({
    call: {
      id: "call-submit-approved",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Submit the approved form.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Submit the approved form.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(spawnCalled, true);
  assert.equal(result.isError, undefined);
  assert.match(result.content, /Submitted after approval/);
});

test("sessions_spawn does not require publish approval for read-only package publish metadata", async () => {
  let spawnCalled = false;
  let permissionRequested = false;
  let spawnedTaskId = "";
  const toolPermissionService: ToolPermissionService = {
    async request() {
      permissionRequested = true;
      throw new Error("read-only metadata lookup must not request approval");
    },
    async result() {
      throw new Error("not used");
    },
    async apply() {
      throw new Error("not used");
    },
  };
  const workerRuntime = {
    async spawn(input: { activation: RoleActivationInput }) {
      spawnCalled = true;
      spawnedTaskId = input.activation.handoff.taskId;
      return { workerType: "browser", workerRunKey: "worker:browser:task-readonly" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Fetched package metadata.",
        payload: { readOnly: true },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService,
  });

  const result = await executor.execute({
    call: {
      id: "call-readonly-publish-date",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Research the multica npm package. Find weekly downloads, version, last publish date, and release cadence. Report metrics only.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Research package publish metadata.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(spawnCalled, true);
  assert.equal(spawnedTaskId, "task-1:call-readonly-publish-date");
  assert.equal(permissionRequested, false);
  assert.equal(result.isError, undefined);
  assert.match(result.content, /Fetched package metadata/);
});

test("sessions_spawn does not require publish approval for read-only release information", async () => {
  let spawnCalled = false;
  let permissionRequested = false;
  let spawnedTaskId = "";
  const toolPermissionService: ToolPermissionService = {
    async request() {
      permissionRequested = true;
      throw new Error("read-only release lookup must not request approval");
    },
    async result() {
      throw new Error("not used");
    },
    async apply() {
      throw new Error("not used");
    },
  };
  const workerRuntime = {
    async spawn(input: { activation: RoleActivationInput }) {
      spawnCalled = true;
      spawnedTaskId = input.activation.handoff.taskId;
      return { workerType: "browser", workerRunKey: "worker:browser:task-readonly-release" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Fetched release metadata.",
        payload: { readOnly: true },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService,
  });

  const result = await executor.execute({
    call: {
      id: "call-readonly-release-info",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open GitHub repository pages and collect release information, last release version, release count, and release history. Do not publish or change anything.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Research repository release metadata.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(spawnCalled, true);
  assert.equal(spawnedTaskId, "task-1:call-readonly-release-info");
  assert.equal(permissionRequested, false);
  assert.equal(result.isError, undefined);
  assert.match(result.content, /Fetched release metadata/);
});

test("sessions_spawn does not require publish approval for release-risk notes", async () => {
  let permissionRequested = false;
  const toolPermissionService: ToolPermissionService = {
    async request() {
      permissionRequested = true;
      throw new Error("release-risk analysis should not request publish approval");
    },
    async result() {
      throw new Error("not used");
    },
    async apply() {
      throw new Error("not used");
    },
  };
  const workerRuntime = {
    async spawn() {
      return { workerType: "browser", workerRunKey: "worker:browser:task-release-risk" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Fetched release-risk source.",
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService,
  });

  const result = await executor.execute({
    call: {
      id: "call-release-risk",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Attempt to fetch a slow source for a release-risk note. Do not publish or change anything.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Evaluate slow source.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(permissionRequested, false);
  assert.equal(result.isError, undefined);
  assert.match(result.content, /release-risk source/);
});

test("sessions_spawn does not require mutation approval for read-only priority order wording", async () => {
  let spawnCalled = false;
  let permissionRequested = false;
  const toolPermissionService: ToolPermissionService = {
    async request() {
      permissionRequested = true;
      throw new Error("read-only browser review should not request mutation approval");
    },
    async result() {
      throw new Error("not used");
    },
    async apply() {
      throw new Error("not used");
    },
  };
  const workerRuntime = {
    async spawn() {
      spawnCalled = true;
      return { workerType: "browser", workerRunKey: "worker:browser:task-1" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Reviewed page.",
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService,
  });

  const result = await executor.execute({
    call: {
      id: "call-readonly-priority",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open the source page and review focus areas in priority order: pricing, strength, risk.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Review page.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(spawnCalled, true);
  assert.equal(permissionRequested, false);
  assert.equal(result.isError, undefined);
});

test("sessions_spawn does not require mutation approval for read-only submit findings wording", async () => {
  let spawnCalled = false;
  let permissionRequested = false;
  const toolPermissionService: ToolPermissionService = {
    async request() {
      permissionRequested = true;
      throw new Error("read-only browser findings should not request mutation approval");
    },
    async result() {
      throw new Error("not used");
    },
    async apply() {
      throw new Error("not used");
    },
  };
  const workerRuntime = {
    async spawn() {
      spawnCalled = true;
      return { workerType: "browser", workerRunKey: "worker:browser:task-1" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Reviewed page.",
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService,
  });

  const result = await executor.execute({
    call: {
      id: "call-readonly-submit-findings",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open the dashboard, re-check the rendered values, and submit findings to the operator as a read-only report.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Review page.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(spawnCalled, true);
  assert.equal(permissionRequested, false);
  assert.equal(result.isError, undefined);
});

test("sessions_spawn still requires approval when a later order action follows read-only priority order", async () => {
  let spawnCalled = false;
  let requestedAction = "";
  const toolPermissionService: ToolPermissionService = {
    async request(input) {
      requestedAction = input.action;
      return {
        status: "pending",
        approvalId: "ap.thread-1.call-order",
        action: input.action,
        requirement: {
          level: input.requirement.level,
          scope: input.requirement.scope,
          cacheKey: input.requirement.cacheKey ?? "missing",
          rationale: input.requirement.rationale,
          workerType: input.requirement.workerType ?? "browser",
        },
        message: "Approval is pending.",
      };
    },
    async result() {
      throw new Error("not used");
    },
    async apply() {
      throw new Error("not used");
    },
  };
  const workerRuntime = {
    async spawn() {
      spawnCalled = true;
      return { workerType: "browser", workerRunKey: "worker:browser:task-order" };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService,
  });

  const result = await executor.execute({
    call: {
      id: "call-order",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Review the options in priority order, then order the cheapest one.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Review options and order the cheapest.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; blocked_before_side_effect: boolean };
  assert.equal(spawnCalled, false);
  assert.equal(requestedAction, "browser.mutate");
  assert.equal(result.isError, true);
  assert.equal(body.status, "requires_approval");
  assert.equal(body.blocked_before_side_effect, true);
});

test("sessions_spawn waits for approval and resumes the same tool call before browser side effects", async () => {
  const events: string[] = [];
  let sendToolCallId: string | undefined;
  const toolPermissionService: ToolPermissionService = {
    async request(input) {
      events.push(`query:${input.toolCallId}`);
      return {
        status: "pending",
        approvalId: "ap.thread-1.call-approve",
        action: input.action,
        requirement: {
          level: input.requirement.level,
          scope: input.requirement.scope,
          cacheKey: input.requirement.cacheKey ?? "missing",
          rationale: input.requirement.rationale,
          workerType: input.requirement.workerType ?? "browser",
        },
        message: "Approval is pending.",
      };
    },
    async result() {
      throw new Error("not used");
    },
    async waitForDecision(input) {
      events.push(`result:${input.approvalId}`);
      return {
        status: "approved",
        approvalId: input.approvalId,
        action: "browser.form.submit",
        message: "Approved.",
      };
    },
    async apply(input) {
      events.push(`applied:${input.approvalId}`);
      return {
        status: "applied",
        approvalId: input.approvalId,
        cacheKey: "thread-1:browser:mutate:approval:browser.form.submit",
        message: "Applied.",
      };
    },
  };
  const workerRuntime = {
    async spawn() {
      events.push("spawn");
      return { workerType: "browser", workerRunKey: "worker:browser:task-1" };
    },
    async send(input: { toolCallId?: string }) {
      sendToolCallId = input.toolCallId;
      events.push("send");
      return {
        workerType: "browser",
        status: "completed",
        summary: "Submitted after same-call approval.",
        payload: { submitted: true },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService,
  });

  const result = await executor.execute({
    call: {
      id: "call-approve",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Submit the final account update form.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Submit the final account update form.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.deepEqual(events, [
    "query:call-approve",
    "result:ap.thread-1.call-approve",
    "applied:ap.thread-1.call-approve",
    "spawn",
    "send",
  ]);
  assert.equal(sendToolCallId, "call-approve");
  assert.equal(result.isError, undefined);
  assert.equal(result.progress?.some((event) => event.detail?.eventType === "permission.applied"), true);
  assert.match(result.content, /Submitted after same-call approval/);
});

test("sessions_spawn returns structured permission error when approval wait fails", async () => {
  const toolPermissionService: ToolPermissionService = {
    async request(input) {
      return {
        status: "pending",
        approvalId: "ap.thread-1.call-approval-error",
        action: input.action,
        requirement: {
          level: input.requirement.level,
          scope: input.requirement.scope,
          cacheKey: input.requirement.cacheKey ?? "missing",
          rationale: input.requirement.rationale,
          workerType: input.requirement.workerType ?? "browser",
        },
        message: "Approval is pending.",
      };
    },
    async result() {
      throw new Error("not used");
    },
    async waitForDecision() {
      throw new Error("approval store unavailable");
    },
    async apply() {
      throw new Error("not reached");
    },
  };
  const workerRuntime = {
    async spawn() {
      throw new Error("worker must not start before permission is applied");
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService,
  });

  const result = await executor.execute({
    call: {
      id: "call-approval-error",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Submit the final account update form.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Submit the final account update form.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; blocked_before_side_effect: boolean; message: string };
  assert.equal(result.isError, true);
  assert.equal(body.status, "permission_error");
  assert.equal(body.blocked_before_side_effect, true);
  assert.match(body.message, /approval store unavailable/);
  assert.equal(result.progress?.some((event) => event.detail?.eventType === "permission.error"), true);
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
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["browser"], toolCancellationRegistry });

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
  const body = JSON.parse(result.content) as {
    protocol?: string;
    session_key?: string;
    status?: string;
    result?: string;
  };
  assert.equal(body.protocol, "turnkeyai.session_tool_result.v1");
  assert.equal(body.session_key, "worker:browser:task-1");
  assert.equal(body.status, "cancelled");
  assert.equal(body.result, "operator stopped browser work");
  assert.equal(result.progress?.at(-1)?.phase, "cancelled");
});

test("sessions_spawn interrupts the worker and returns a resumable timeout result", async () => {
  let sendStarted!: () => void;
  let interruptedReason: string | null = null;
  const sendStartedPromise = new Promise<void>((resolve) => {
    sendStarted = resolve;
  });
  const workerRuntime = {
    async spawn() {
      return { workerType: "browser", workerRunKey: "worker:browser:task-1" };
    },
    async send() {
      sendStarted();
      await new Promise(() => undefined);
      return null;
    },
    async interrupt(input: { reason?: string }) {
      interruptedReason = input.reason ?? null;
      return {
        workerRunKey: "worker:browser:task-1",
        workerType: "browser",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
        continuationDigest: {
          reason: "timeout_summary",
          summary: "Collected the pricing page title and first two form labels before timeout.",
          createdAt: 2,
        },
      };
    },
    async getState() {
      return {
        workerRunKey: "worker:browser:task-1",
        workerType: "browser",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
        continuationDigest: {
          reason: "timeout_summary",
          summary: "Collected the pricing page title and first two form labels before timeout.",
          createdAt: 2,
        },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    hardTimeoutGraceMs: 1,
  });

  const executePromise = executor.execute({
    call: {
      id: "call-timeout",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open a slow browser page.",
        timeout_seconds: 0.001,
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
  const result = await executePromise;
  const body = JSON.parse(result.content) as {
    session_key: string;
    status: string;
    resumable: boolean;
    timeout_seconds: number;
    evidence_available: boolean;
    evidence_summary: string;
  };
  assert.match(interruptedReason ?? "", /sessions_spawn timed out/);
  assert.equal(result.isError, true);
  assert.equal(body.session_key, "worker:browser:task-1");
  assert.equal(body.status, "timeout");
  assert.equal(body.resumable, true);
  assert.equal(body.timeout_seconds, 0.001);
  assert.equal(body.evidence_available, true);
  assert.match(body.evidence_summary, /pricing page title/);
  assert.equal(result.progress?.at(-1)?.phase, "failed");
  assert.equal(result.progress?.at(-1)?.detail?.status, "timeout");
  assert.equal(result.progress?.at(-1)?.detail?.evidence_available, true);
});

test("sessions_spawn observes late worker rejection after returning timeout", async () => {
  let unhandled: unknown = null;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.once("unhandledRejection", onUnhandled);
  try {
    const workerRuntime = {
      async spawn() {
        return { workerType: "explore", workerRunKey: "worker:explore:late-reject" };
      },
      async send() {
        await sleep(25);
        throw new Error("late worker failure after timeout");
      },
      async interrupt() {
        return null;
      },
      async getState() {
        return {
          workerRunKey: "worker:explore:late-reject",
          workerType: "explore",
          status: "resumable",
          createdAt: 1,
          updatedAt: 2,
        };
      },
    } as unknown as WorkerRuntime;
    const executor = createWorkerSessionToolExecutor({
      workerRuntime,
      availableWorkerKinds: ["explore"],
      hardTimeoutGraceMs: 1,
    });

    const result = await executor.execute({
      call: {
        id: "call-late-reject",
        name: "sessions_spawn",
        input: {
          agent_id: "explore",
          task: "Run a worker that rejects after timeout.",
          timeout_seconds: 0.001,
        },
      },
      activation: buildActivation(),
      packet: {
        roleId: "role-lead",
        roleName: "Lead",
        seat: "lead",
        systemPrompt: "Lead.",
        taskPrompt: "Run slow worker.",
        outputContract: "Return result.",
        suggestedMentions: [],
      },
    });

    const body = JSON.parse(result.content) as { status: string };
    assert.equal(body.status, "timeout");
    await sleep(50);
    assert.equal(unhandled, null);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("sessions_spawn applies a default timeout when timeout_seconds is absent", async () => {
  let sendStarted!: () => void;
  let interruptedReason: string | null = null;
  const sendStartedPromise = new Promise<void>((resolve) => {
    sendStarted = resolve;
  });
  const workerRuntime = {
    async spawn() {
      return { workerType: "explore", workerRunKey: "worker:explore:default-timeout" };
    },
    async send() {
      sendStarted();
      await new Promise(() => undefined);
      return null;
    },
    async interrupt(input: { reason?: string }) {
      interruptedReason = input.reason ?? null;
      return {
        workerRunKey: "worker:explore:default-timeout",
        workerType: "explore",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
        continuationDigest: {
          reason: "timeout_summary",
          summary: "Collected two source snippets before timeout.",
          createdAt: 2,
        },
      };
    },
    async getState() {
      return {
        workerRunKey: "worker:explore:default-timeout",
        workerType: "explore",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
        continuationDigest: {
          reason: "timeout_summary",
          summary: "Collected two source snippets before timeout.",
          createdAt: 2,
        },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
    maxSessionToolTimeoutMs: 1,
    hardTimeoutGraceMs: 1,
  });

  const executePromise = executor.execute({
    call: {
      id: "call-default-timeout",
      name: "sessions_spawn",
      input: {
        agent_id: "explore",
        task: "Research a slow source without an explicit timeout.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Research a slow source.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  await sendStartedPromise;
  const result = await executePromise;
  const body = JSON.parse(result.content) as {
    session_key: string;
    status: string;
    timeout_seconds: number;
    evidence_available: boolean;
    evidence_summary: string;
  };
  assert.match(interruptedReason ?? "", /sessions_spawn timed out/);
  assert.equal(result.isError, true);
  assert.equal(body.session_key, "worker:explore:default-timeout");
  assert.equal(body.status, "timeout");
  assert.equal(body.timeout_seconds, 0.001);
  assert.equal(body.evidence_available, true);
  assert.match(body.evidence_summary, /source snippets/);
});

test("sessions_spawn defaults explore and finance sessions to the research timeout budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capturedTimeouts: Array<{ agentId: string; timeoutSeconds: number }> = [];

  for (const agentId of ["explore", "finance"] as const) {
    let sendStarted!: () => void;
    const sendStartedPromise = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    const workerRunKey = `worker:${agentId}:default-timeout`;
    const workerRuntime = {
      async spawn() {
        return { workerType: agentId, workerRunKey };
      },
      async send() {
        sendStarted();
        await new Promise(() => undefined);
        return null;
      },
      async interrupt() {
        return {
          workerRunKey,
          workerType: agentId,
          status: "resumable",
          createdAt: 1,
          updatedAt: 2,
        };
      },
      async getState() {
        return {
          workerRunKey,
          workerType: agentId,
          status: "resumable",
          createdAt: 1,
          updatedAt: 2,
        };
      },
    } as unknown as WorkerRuntime;
    const executor = createWorkerSessionToolExecutor({
      workerRuntime,
      availableWorkerKinds: [agentId],
      hardTimeoutGraceMs: 0,
    });

    const executePromise = executor.execute({
      call: {
        id: `call-${agentId}-default-timeout`,
        name: "sessions_spawn",
        input: {
          agent_id: agentId,
          task: `Research a slow ${agentId} source without an explicit timeout.`,
        },
      },
      activation: buildActivation(),
      packet: {
        roleId: "role-lead",
        roleName: "Lead",
        seat: "lead",
        systemPrompt: "Lead.",
        taskPrompt: "Research a slow source.",
        outputContract: "Return result.",
        suggestedMentions: [],
      },
    });

    await sendStartedPromise;
    t.mock.timers.tick(480_000);
    await Promise.resolve();
    t.mock.timers.tick(0);
    await Promise.resolve();
    const result = await executePromise;
    const body = JSON.parse(result.content) as { status: string; timeout_seconds: number };
    assert.equal(result.isError, true);
    assert.equal(body.status, "timeout");
    capturedTimeouts.push({ agentId, timeoutSeconds: body.timeout_seconds });
  }

  assert.deepEqual(capturedTimeouts, [
    { agentId: "explore", timeoutSeconds: 480 },
    { agentId: "finance", timeoutSeconds: 480 },
  ]);
});

test("sessions_spawn waits through the soft timeout grace for the active worker result", async () => {
  let interruptCalled = false;
  const workerRuntime = {
    async spawn() {
      return { workerType: "explore", workerRunKey: "worker:explore:slow-success" };
    },
    async send() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        workerType: "explore",
        status: "completed",
        summary: "Finished during soft-timeout grace.",
        payload: { sources: 2 },
      };
    },
    async interrupt() {
      interruptCalled = true;
      return null;
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
    hardTimeoutGraceMs: 50,
  });

  const result = await executor.execute({
    call: {
      id: "call-soft-timeout",
      name: "sessions_spawn",
      input: {
        agent_id: "explore",
        task: "Research a slow source.",
        timeout_seconds: 0.001,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Research a slow source.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; result: string };
  assert.equal(interruptCalled, false);
  assert.equal(result.isError, undefined);
  assert.equal(body.status, "completed");
  assert.equal(body.result, "Finished during soft-timeout grace.");
});

test("sessions_spawn runs one no-tools timeout summary continuation for LLM sub-agent sessions", async () => {
  let sendCount = 0;
  const summaryPackets: RolePromptPacket[] = [];
  const workerRuntime = {
    async spawn() {
      return { workerType: "explore", workerRunKey: "worker:explore:timeout-summary" };
    },
    async send(input: { packet: RolePromptPacket }) {
      sendCount += 1;
      if (sendCount === 1) {
        await new Promise(() => undefined);
        return null;
      }
      summaryPackets.push(input.packet);
      return {
        workerType: "explore",
        status: "partial",
        summary: "Evidence-only summary after timeout.",
        payload: {
          mode: "llm_sub_agent",
          workerType: "explore",
          content: "Verified source A before timeout; source B not verified.",
        },
      };
    },
    async interrupt() {
      return {
        workerRunKey: "worker:explore:timeout-summary",
        workerType: "explore",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async getState() {
      return {
        workerRunKey: "worker:explore:timeout-summary",
        workerType: "explore",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
        history: [
          {
            id: "history-final",
            role: "assistant",
            content: "Partial transcript from an LLM sub-agent.",
            createdAt: 2,
            metadata: { kind: "assistant_final" },
          },
        ],
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
    hardTimeoutGraceMs: 1,
  });

  const result = await executor.execute({
    call: {
      id: "call-timeout-summary",
      name: "sessions_spawn",
      input: {
        agent_id: "explore",
        task: "Research a slow source.",
        timeout_seconds: 0.001,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Research a slow source.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; result: string; final_content: string | null };
  assert.equal(sendCount, 2);
  assert.equal(summaryPackets[0]?.toolUseMode, "disabled");
  assert.match(summaryPackets[0]?.taskPrompt ?? "", /Do not call tools/);
  assert.equal(result.isError, undefined);
  assert.equal(body.status, "partial");
  assert.equal(body.result, "Evidence-only summary after timeout.");
  assert.equal(body.final_content, "Verified source A before timeout; source B not verified.");
});

test("sessions_send interrupts a follow-up worker call on timeout", async () => {
  let interruptedReason: string | null = null;
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:existing",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:browser:existing",
            workerType: "browser",
            status: "resumable",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:browser:existing",
        workerType: "browser",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async send() {
      throw new Error("sessions_send should resume the existing session instead of starting a bare send");
    },
    async resume() {
      await new Promise(() => undefined);
      return null;
    },
    async interrupt(input: { reason?: string }) {
      interruptedReason = input.reason ?? null;
      return null;
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    hardTimeoutGraceMs: 1,
  });

  const result = await executor.execute({
    call: {
      id: "call-send-timeout",
      name: "sessions_send",
      input: {
        session_key: "worker:browser:existing",
        message: "Continue the slow browser task.",
        timeout_seconds: 0.001,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { session_key: string; status: string; resumable: boolean };
  assert.match(interruptedReason ?? "", /sessions_send timed out/);
  assert.equal(result.isError, true);
  assert.equal(body.session_key, "worker:browser:existing");
  assert.equal(body.status, "timeout");
  assert.equal(body.resumable, true);
});

test("sessions_send timeout does not treat worker errors as usable evidence", async () => {
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:error-only",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:explore:error-only",
            workerType: "explore",
            status: "resumable",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:explore:error-only",
        workerType: "explore",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
        lastError: {
          message: "network failed before collecting sources",
          at: 2,
        },
      };
    },
    async send() {
      throw new Error("sessions_send should resume the existing session instead of starting a bare send");
    },
    async resume() {
      await new Promise(() => undefined);
      return null;
    },
    async interrupt() {
      return null;
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
    hardTimeoutGraceMs: 1,
  });

  const result = await executor.execute({
    call: {
      id: "call-send-timeout-error-only",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:error-only",
        message: "Continue the slow research task.",
        timeout_seconds: 0.001,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as {
    status: string;
    evidence_available: boolean;
    evidence_summary?: string;
  };
  assert.equal(body.status, "timeout");
  assert.equal(body.evidence_available, false);
  assert.equal(body.evidence_summary, undefined);
});

test("sessions_send uses the worker default timeout floor when resuming a cancelled session", async () => {
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:cancelled",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:explore:cancelled",
            workerType: "explore",
            status: "cancelled",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:explore:cancelled",
        workerType: "explore",
        status: "cancelled",
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async send() {
      throw new Error("sessions_send should resume the existing session instead of starting a bare send");
    },
    async resume() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        workerType: "explore",
        status: "completed",
        summary: "Cancelled source check resumed.",
        payload: {
          mode: "llm_sub_agent",
          workerType: "explore",
          content: "Cancelled source check resumed.",
        },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
    hardTimeoutGraceMs: 1,
  });

  const result = await executor.execute({
    call: {
      id: "call-send-cancelled",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:cancelled",
        message: "Continue the cancelled research task.",
        timeout_seconds: 0.001,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; result: string };
  assert.equal(result.isError, undefined);
  assert.equal(body.status, "completed");
  assert.equal(body.result, "Cancelled source check resumed.");
});

test("sessions_send uses the current follow-up label in its session result envelope", async () => {
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:existing",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
            label: "Original source",
            toolCallId: "call-original",
          },
          state: {
            workerRunKey: "worker:explore:existing",
            workerType: "explore",
            status: "done",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:explore:existing",
        workerType: "explore",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async resume() {
      return {
        workerType: "explore",
        status: "completed",
        summary: "Continuation evidence gathered.",
        payload: { step: "continued" },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  const result = await executor.execute({
    call: {
      id: "call-follow-up",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:existing",
        message: "Continue the existing research task with fresh evidence.",
        label: "Follow-up source",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { label: string; tool_call_id: string; result: string };
  assert.equal(result.isError, undefined);
  assert.equal(body.label, "Follow-up source");
  assert.equal(body.tool_call_id, "call-follow-up");
  assert.equal(body.result, "Continuation evidence gathered.");
});

test("sessions_send reuses a completed session for summary-only follow-ups", async () => {
  let sendCalled = false;
  const lastResult = {
    workerType: "explore" as const,
    status: "completed" as const,
    summary: "Research completed.",
    payload: {
      mode: "llm_sub_agent",
      workerType: "explore",
      content: "Full cached final report.",
    },
  };
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:done",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:explore:done",
            workerType: "explore",
            status: "done",
            createdAt: 1,
            updatedAt: 2,
            lastResult,
          },
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:explore:done",
        workerType: "explore",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
        lastResult,
      };
    },
    async send() {
      sendCalled = true;
      return null;
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  const result = await executor.execute({
    call: {
      id: "call-cached-summary",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:done",
        message: "Please return your complete final research report as plain text.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Synthesize.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { cached: boolean; final_content?: string };
  assert.equal(sendCalled, false);
  assert.equal(body.cached, true);
  assert.equal(body.final_content, "Full cached final report.");
  assert.equal(result.progress?.at(-1)?.detail?.cached, true);
});

test("sessions_send reuses a completed session for Chinese evidence extraction follow-ups", async () => {
  let sendCalled = false;
  const lastResult = {
    workerType: "explore" as const,
    status: "completed" as const,
    summary: "Research completed.",
    payload: {
      mode: "llm_sub_agent",
      workerType: "explore",
      content: "已缓存的完整证据报告。",
    },
  };
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:done-cn",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:explore:done-cn",
            workerType: "explore",
            status: "done",
            createdAt: 1,
            updatedAt: 2,
            lastResult,
          },
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:explore:done-cn",
        workerType: "explore",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
        lastResult,
      };
    },
    async send() {
      sendCalled = true;
      return null;
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  const result = await executor.execute({
    call: {
      id: "call-cached-summary-cn",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:done-cn",
        message: "请提取你的最终研究结论中的核心证据和要点，每个点给出具体证据来源。",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Synthesize.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { cached: boolean; final_content?: string };
  assert.equal(sendCalled, false);
  assert.equal(body.cached, true);
  assert.equal(body.final_content, "已缓存的完整证据报告。");
});

test("sessions_send does not reuse a completed session for mixed action follow-ups", async () => {
  let resumeCalled = false;
  const lastResult = {
    workerType: "explore" as const,
    status: "completed" as const,
    summary: "Explore inspection completed.",
    payload: {
      mode: "llm_sub_agent",
      workerType: "explore",
      content: "Cached explore result.",
    },
  };
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:done",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:explore:done",
            workerType: "explore",
            status: "done",
            createdAt: 1,
            updatedAt: 2,
            lastResult,
          },
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:explore:done",
        workerType: "explore",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
        lastResult,
      };
    },
    async send() {
      throw new Error("sessions_send should resume the existing session instead of starting a bare send");
    },
    async resume() {
      resumeCalled = true;
      return {
        workerType: "explore" as const,
        status: "completed" as const,
        summary: "Follow-up action executed.",
        payload: { action: "create" },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  const result = await executor.execute({
    call: {
      id: "call-mixed-action",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:done",
        message: "Please summarize the current findings and create a new search plan.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { cached?: boolean; result: string };
  assert.equal(resumeCalled, true);
  assert.equal(body.cached, undefined);
  assert.equal(body.result, "Follow-up action executed.");
});

test("sessions_send cached result preserves failed worker status", async () => {
  let sendCalled = false;
  const lastResult = {
    workerType: "explore" as const,
    status: "failed" as const,
    summary: "Search provider unavailable.",
    payload: {
      mode: "llm_sub_agent",
      workerType: "explore",
      content: "No final report; search provider unavailable.",
    },
  };
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:done-failed",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:explore:done-failed",
            workerType: "explore",
            status: "done",
            createdAt: 1,
            updatedAt: 2,
            lastResult,
          },
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:explore:done-failed",
        workerType: "explore",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
        lastResult,
      };
    },
    async send() {
      sendCalled = true;
      return null;
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  const result = await executor.execute({
    call: {
      id: "call-cached-failed",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:done-failed",
        message: "Please provide the final result summary.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Synthesize.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { cached: boolean; status: string };
  assert.equal(sendCalled, false);
  assert.equal(result.isError, true);
  assert.equal(result.progress?.at(-1)?.phase, "failed");
  assert.equal(body.cached, true);
  assert.equal(body.status, "failed");
});

test("permission tools request, observe, and apply operator approval", async () => {
  const calls: string[] = [];
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    toolPermissionService: {
      async request(input) {
        calls.push(`request:${input.action}`);
        return {
          status: "pending",
          approvalId: "ap.thread-1.call-permission",
          missionId: "msn.1",
          action: input.action,
          requirement: {
            level: input.requirement.level,
            scope: input.requirement.scope,
            cacheKey: "thread-1:browser:mutate:approval",
            rationale: input.requirement.rationale,
            workerType: "browser",
          },
          message: "Permission request ap.thread-1.call-permission is pending operator decision.",
        };
      },
      async result(input) {
        calls.push(`result:${input.approvalId}`);
        return {
          status: "approved",
          approvalId: input.approvalId,
          missionId: "msn.1",
          action: "browser.form.submit",
          decidedBy: "operator",
          decidedAtMs: 1,
          message: "Permission request ap.thread-1.call-permission was approved.",
        };
      },
      async apply(input) {
        calls.push(`apply:${input.approvalId}`);
        return {
          status: "applied",
          approvalId: input.approvalId,
          cacheKey: "thread-1:browser:mutate:approval",
          message: "Permission request ap.thread-1.call-permission applied.",
        };
      },
    },
  });

  assert.equal(executor.definitions().some((definition) => definition.name === "permission_query"), true);
  const activation = buildActivation();
  const packet = {
    roleId: "role-lead",
    roleName: "Lead",
    seat: "lead" as const,
    systemPrompt: "Lead.",
    taskPrompt: "Submit form.",
    outputContract: "Return result.",
    suggestedMentions: [],
  };
  const query = await executor.execute({
    call: {
      id: "call-permission",
      name: "permission_query",
      input: {
        action: "browser.form.submit",
        title: "Submit pricing form",
        risk: "Submits account data to the website.",
        level: "approval",
        scope: "mutate",
        rationale: "The task requires checking the submitted pricing flow.",
      },
    },
    activation,
    packet,
  });
  assert.equal(query.isError, undefined);
  assert.equal(query.progress?.[0]?.detail?.eventType, "permission.query");
  assert.match(query.content, /"status": "pending"/);
  assert.match(query.content, /"event_type": "permission\.query"/);

  const result = await executor.execute({
    call: {
      id: "call-result",
      name: "permission_result",
      input: { approval_id: "ap.thread-1.call-permission" },
    },
    activation,
    packet,
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.progress?.[0]?.detail?.eventType, "permission.result");
  assert.match(result.content, /"status": "approved"/);
  assert.match(result.content, /"event_type": "permission\.result"/);

  const applied = await executor.execute({
    call: {
      id: "call-applied",
      name: "permission_applied",
      input: { approval_id: "ap.thread-1.call-permission" },
    },
    activation,
    packet,
  });
  assert.equal(applied.isError, undefined);
  assert.equal(applied.progress?.[0]?.detail?.eventType, "permission.applied");
  assert.match(applied.content, /"event_type": "permission\.applied"/);
  assert.deepEqual(calls, [
    "request:browser.form.submit",
    "result:ap.thread-1.call-permission",
    "apply:ap.thread-1.call-permission",
  ]);
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
            parentSessionKey: "role:role-lead:thread:thread-1",
            toolCallId: "call-browser",
            label: "Live browser check",
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

  const body = JSON.parse(result.content) as {
    sessions: Array<{
      session_key: string;
      label: string | null;
      parent_session_key: string | null;
      tool_call_id: string | null;
      message_count: number;
    }>;
  };
  assert.deepEqual(body.sessions.map((session) => session.session_key), ["worker:browser:recent"]);
  assert.equal(body.sessions[0]?.label, "Live browser check");
  assert.equal(body.sessions[0]?.parent_session_key, "role:role-lead:thread:thread-1");
  assert.equal(body.sessions[0]?.tool_call_id, "call-browser");
  assert.equal(body.sessions[0]?.message_count, 1);
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
      toolCallId: "call-browser",
      toolName: "browser" as const,
      status: "completed" as const,
      payload: { title: "Example" },
      metadata: { parentToolCallId: "call-browser" },
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
            lastResult: {
              workerType: "browser",
              status: "completed",
              summary: "Stale summary that must not replace durable transcript.",
              payload: { title: "Stale" },
            },
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
        lastResult: {
          workerType: "browser",
          status: "completed",
          summary: "Stale summary that must not replace durable transcript.",
          payload: { title: "Stale" },
        },
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
    messages: Array<{ role: string; content: string; tool_call_id?: string; metadata?: unknown; payload?: unknown }>;
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
      tool_call_id: "call-browser",
      name: "browser",
      status: "completed",
      metadata: { parentToolCallId: "call-browser" },
      payload: { title: "Example" },
    },
  ]);
});

test("sessions_history can read the latest entries with tail=true", async () => {
  const history = [
    {
      id: "history-1",
      role: "user" as const,
      content: "First.",
      createdAt: 100,
      taskId: "task-1",
    },
    {
      id: "history-2",
      role: "assistant" as const,
      content: "Middle.",
      createdAt: 110,
      taskId: "task-1",
    },
    {
      id: "history-3",
      role: "assistant" as const,
      content: "Final evidence ledger.",
      createdAt: 120,
      taskId: "task-1",
      status: "completed" as const,
    },
  ];
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:tail",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:explore:tail",
            workerType: "explore",
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
        workerRunKey: "worker:explore:tail",
        workerType: "explore",
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
      id: "call-tail",
      name: "sessions_history",
      input: {
        session_key: "worker:explore:tail",
        limit: 1,
        tail: true,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Read tail history.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as {
    offset: number;
    tail: boolean;
    has_more: boolean;
    messages: Array<{ id: string; content: string }>;
  };
  assert.equal(body.tail, true);
  assert.equal(body.offset, 2);
  assert.equal(body.has_more, false);
  assert.deepEqual(body.messages.map((message) => message.id), ["history-3"]);
  assert.equal(body.messages[0]?.content, "Final evidence ledger.");
});

test("sessions_history returns opaque cursors for long transcript pagination", async () => {
  const history = Array.from({ length: 5 }, (_, index) => ({
    id: `history-${index + 1}`,
    role: "assistant" as const,
    content: `Entry ${index + 1}.`,
    createdAt: 100 + index,
    taskId: "task-1",
  }));
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:cursor",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
          },
          state: {
            workerRunKey: "worker:explore:cursor",
            workerType: "explore",
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
        workerRunKey: "worker:explore:cursor",
        workerType: "explore",
        status: "done",
        createdAt: 90,
        updatedAt: 120,
        history,
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime });
  const packet: RolePromptPacket = {
    roleId: "role-lead",
    roleName: "Lead",
    seat: "lead",
    systemPrompt: "Lead.",
    taskPrompt: "Read history.",
    outputContract: "Return result.",
    suggestedMentions: [],
  };

  const first = await executor.execute({
    call: {
      id: "call-history-1",
      name: "sessions_history",
      input: {
        session_key: "worker:explore:cursor",
        limit: 2,
      },
    },
    activation: buildActivation(),
    packet,
  });
  const firstBody = JSON.parse(first.content) as {
    messages: Array<{ id: string }>;
    has_more_after: boolean;
    next_cursor: string | null;
    has_more_before: boolean;
    previous_cursor: string | null;
  };
  assert.deepEqual(firstBody.messages.map((message) => message.id), ["history-1", "history-2"]);
  assert.equal(firstBody.has_more_after, true);
  assert.ok(firstBody.next_cursor);
  assert.equal(firstBody.has_more_before, false);
  assert.equal(firstBody.previous_cursor, null);

  const second = await executor.execute({
    call: {
      id: "call-history-2",
      name: "sessions_history",
      input: {
        session_key: "worker:explore:cursor",
        limit: 2,
        cursor: firstBody.next_cursor,
      },
    },
    activation: buildActivation(),
    packet,
  });
  const secondBody = JSON.parse(second.content) as {
    messages: Array<{ id: string }>;
    offset: number;
    has_more_after: boolean;
    next_cursor: string | null;
    has_more_before: boolean;
    previous_cursor: string | null;
  };
  assert.deepEqual(secondBody.messages.map((message) => message.id), ["history-3", "history-4"]);
  assert.equal(secondBody.offset, 2);
  assert.equal(secondBody.has_more_after, true);
  assert.ok(secondBody.next_cursor);
  assert.equal(secondBody.has_more_before, true);
  assert.ok(secondBody.previous_cursor);
});

test("sessions_history rejects malformed or cross-session cursors", async () => {
  const history = [
    {
      id: "history-1",
      role: "assistant" as const,
      content: "Entry.",
      createdAt: 100,
      taskId: "task-1",
    },
  ];
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:cursor",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
          },
          state: {
            workerRunKey: "worker:explore:cursor",
            workerType: "explore",
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
        workerRunKey: "worker:explore:cursor",
        workerType: "explore",
        status: "done",
        createdAt: 90,
        updatedAt: 120,
        history,
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime });
  const crossSessionCursor = Buffer.from(
    JSON.stringify({ v: 1, session_key: "worker:explore:other", offset: 1 }),
    "utf8"
  ).toString("base64url");
  const packet: RolePromptPacket = {
    roleId: "role-lead",
    roleName: "Lead",
    seat: "lead",
    systemPrompt: "Lead.",
    taskPrompt: "Read history.",
    outputContract: "Return result.",
    suggestedMentions: [],
  };

  for (const cursor of ["not-a-cursor", crossSessionCursor]) {
    const result = await executor.execute({
      call: {
        id: "call-history-bad-cursor",
        name: "sessions_history",
        input: {
          session_key: "worker:explore:cursor",
          limit: 2,
          cursor,
        },
      },
      activation: buildActivation(),
      packet,
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /sessions_history cursor is invalid/);
  }
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

test("memory_search and memory_get expose durable thread memory to the role", async () => {
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    memoryResolver: {
      async retrieveMemory(input) {
        assert.equal(input.threadId, "thread-1");
        assert.equal(input.roleId, "role-lead");
        const hits = [
          {
            memoryId: "thread-1:decision:1",
            source: "thread-memory" as const,
            score: 0.92,
            content: "Decision: Use direct provider APIs before browser fallback.",
            rationale: "thread summary memory",
          },
          {
            memoryId: "thread-1:preference:1",
            source: "user-preference" as const,
            score: 0.74,
            content: "Preference: Keep final answers concise.",
          },
        ];
        if (input.queryText.includes("thread 1 decision 1")) {
          return hits.filter((hit) => hit.memoryId === "thread-1:decision:1");
        }
        return hits;
      },
      async getMemory(input) {
        assert.equal(input.threadId, "thread-1");
        assert.equal(input.roleId, "role-lead");
        assert.equal(input.memoryId, "thread-1:decision:1");
        return {
          memoryId: "thread-1:decision:1",
          source: "thread-memory" as const,
          score: 0.92,
          content: "Decision: Use direct provider APIs before browser fallback.",
          rationale: "thread summary memory",
        };
      },
    },
  });
  assert.deepEqual(
    executor.definitions().filter((definition) => definition.name.startsWith("memory_")).map((definition) => definition.name),
    ["memory_search", "memory_get"]
  );

  const activation = buildActivation();
  const packet = {
    roleId: "role-lead",
    roleName: "Lead",
    seat: "lead" as const,
    systemPrompt: "Lead.",
    taskPrompt: "Recall prior decision.",
    outputContract: "Return result.",
    suggestedMentions: [],
  };
  const search = await executor.execute({
    call: {
      id: "call-memory-search",
      name: "memory_search",
      input: { query: "What did we decide about browser fallback?", limit: 1 },
    },
    activation,
    packet,
  });
  const searchBody = JSON.parse(search.content) as { showing: number; memories: Array<{ memory_id: string; score: number }> };
  assert.equal(searchBody.showing, 1);
  assert.deepEqual(searchBody.memories, [
    {
      memory_id: "thread-1:decision:1",
      source: "thread-memory",
      score: 0.92,
      content: "Decision: Use direct provider APIs before browser fallback.",
      rationale: "thread summary memory",
    },
  ]);
  assert.equal(search.progress?.[0]?.phase, "completed");

  const get = await executor.execute({
    call: {
      id: "call-memory-get",
      name: "memory_get",
      input: { memory_id: "thread-1:decision:1" },
    },
    activation,
    packet,
  });
  const getBody = JSON.parse(get.content) as { memory: { memory_id: string; content: string } };
  assert.equal(getBody.memory.memory_id, "thread-1:decision:1");
  assert.match(getBody.memory.content, /direct provider APIs/);
});

test("task tools expose mission work-item list, create, and update operations", async () => {
  const calls: string[] = [];
  const taskToolService: TaskToolService = {
    async list(input) {
      calls.push(`list:${input.threadId}:${input.status ?? "all"}`);
      return { mission_id: input.missionId ?? "msn.1", tasks: [] };
    },
    async create(input) {
      calls.push(`create:${input.title}:${input.agentId ?? input.roleId}`);
      return { mission_id: input.missionId ?? "msn.1", task: { id: "wi.task-1", title: input.title } };
    },
    async update(input) {
      calls.push(`update:${input.workItemId}:${input.status ?? "same"}`);
      return { mission_id: input.missionId ?? "msn.1", task: { id: input.workItemId, status: input.status } };
    },
  };
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    taskToolService,
  });
  assert.deepEqual(
    executor.definitions().filter((definition) => definition.name.startsWith("tasks_")).map((definition) => definition.name),
    ["tasks_list", "tasks_create", "tasks_update"]
  );

  const activation = buildActivation();
  const packet = {
    roleId: "role-lead",
    roleName: "Lead",
    seat: "lead" as const,
    systemPrompt: "Lead.",
    taskPrompt: "Plan tracked work.",
    outputContract: "Return result.",
    suggestedMentions: [],
  };
  const list = await executor.execute({
    call: { id: "call-tasks-list", name: "tasks_list", input: { status: "working", limit: 10 } },
    activation,
    packet,
  });
  const create = await executor.execute({
    call: { id: "call-tasks-create", name: "tasks_create", input: { title: "Verify browser evidence", agent_id: "role-lead" } },
    activation,
    packet,
  });
  const update = await executor.execute({
    call: { id: "call-tasks-update", name: "tasks_update", input: { work_item_id: "wi.task-1", status: "done", progress: 1 } },
    activation,
    packet,
  });

  assert.equal(JSON.parse(list.content).mission_id, "msn.1");
  assert.equal(JSON.parse(create.content).task.id, "wi.task-1");
  assert.equal(JSON.parse(update.content).task.status, "done");
  assert.deepEqual(calls, ["list:thread-1:working", "create:Verify browser evidence:role-lead", "update:wi.task-1:done"]);
  assert.equal(update.progress?.[0]?.phase, "completed");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
