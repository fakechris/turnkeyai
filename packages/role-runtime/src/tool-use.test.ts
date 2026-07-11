import assert from "node:assert/strict";
import test from "node:test";

import type {
  RoleActivationInput,
  WorkerExecutionResult,
  WorkerInvocationInput,
  WorkerMessageInput,
  WorkerRuntime,
  WorkerSessionState,
} from "@turnkeyai/core-types/team";
import type { LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "./native-tool-messages";
import type { ToolResultArtifactStore } from "./tool-result-artifact-store";
import type { TaskToolService } from "./task-tool-service";
import type { RolePromptPacket } from "./prompt-policy";
import { parseBackgroundWorkerSessionAccepted } from "./background-worker-session";
import { InMemoryToolCancellationRegistry } from "./tool-cancellation-registry";
import type { ToolPermissionService } from "./tool-permission-service";
import {
  createWorkerSessionToolExecutor,
  executeRoleToolCalls,
  executeRuntimeForcedToolRound,
  emitRoleToolProgressSafely,
  recordRoleToolProgressSafely,
  type RoleToolProgressEvent,
} from "./tool-use";

test("sessions_spawn launches independent background workers without awaiting completion", async () => {
  let spawnCount = 0;
  let sendStarted = 0;
  let sendCompleted = 0;
  const releases: Array<() => void> = [];
  const workerRuntime = {
    async spawn() {
      spawnCount += 1;
      return {
        workerType: "explore",
        workerRunKey: `worker:explore:background:${spawnCount}`,
      };
    },
    async send() {
      sendStarted += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      sendCompleted += 1;
      return {
        workerType: "explore",
        status: "completed",
        summary: "background source complete",
        payload: {},
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
  });
  const deadlineAt = Date.now() + 60_000;
  const executions = Promise.all(
    ["a", "b", "c"].map((suffix) =>
      executor.execute({
        call: {
          id: `call-background-${suffix}`,
          name: "sessions_spawn",
          input: {
            agent_id: "explore",
            task: `Inspect independent source ${suffix}.`,
            label: `source ${suffix}`,
            run_in_background: true,
          },
        },
        activation: buildActivation(),
        packet: buildPacket(),
        deadlineAt,
      }),
    ),
  );
  await waitUntilForTest(() => sendStarted === 3);
  const early = await Promise.race([
    executions.then((results) => ({ returned: true as const, results })),
    sleep(10).then(() => ({ returned: false as const })),
  ]);
  assert.equal(sendCompleted, 0);
  for (const release of releases) release();
  const results = early.returned ? early.results : await executions;

  assert.equal(early.returned, true);
  assert.equal(spawnCount, 3);
  for (const [index, result] of results.entries()) {
    const accepted = parseBackgroundWorkerSessionAccepted(result.content);
    assert.equal(accepted?.status, "running");
    assert.equal(accepted?.tool_call_id, `call-background-${["a", "b", "c"][index]}`);
    assert.equal(accepted?.deadline_at, deadlineAt);
  }
  await waitUntilForTest(() => sendCompleted === 3);
});

test("sessions_spawn consumes background rejection and deduplicates the tool call", async () => {
  let spawnCount = 0;
  let sendCount = 0;
  const observedErrors: unknown[] = [];
  const failure = new Error("background worker failed");
  const workerRuntime = {
    async spawn() {
      spawnCount += 1;
      return { workerType: "explore", workerRunKey: "worker:explore:deduped" };
    },
    async send() {
      sendCount += 1;
      throw failure;
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
    onBackgroundWorkerError: (error) => observedErrors.push(error),
  });
  const execute = () => executor.execute({
    call: {
      id: "call-background-deduped",
      name: "sessions_spawn",
      input: {
        agent_id: "explore",
        task: "Inspect one source exactly once.",
        run_in_background: true,
      },
    },
    activation: buildActivation(),
    packet: buildPacket(),
  });

  const [first, second] = await Promise.all([execute(), execute()]);
  await waitUntilForTest(() => observedErrors.length === 1);

  assert.equal(first.content, second.content);
  assert.equal(spawnCount, 1);
  assert.equal(sendCount, 1);
  assert.equal(observedErrors[0], failure);
});

test("recordRoleToolProgressSafely records runtime tool progress", async () => {
  const events: Array<{
    progressId: string;
    summary: string;
    phase: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const call: LLMToolCall = {
    id: "call-1",
    name: "sessions_spawn",
    input: { agent_id: "browser" },
  };
  const progress: RoleToolProgressEvent = {
    phase: "completed",
    toolName: "sessions_spawn",
    summary: "Tool call completed: sessions_spawn",
    detail: { status: "ok" },
  };

  await recordRoleToolProgressSafely({
    recorder: {
      async record(event) {
        events.push(event as (typeof events)[number]);
      },
    },
    activation: buildActivation(),
    call,
    progress,
  });

  assert.equal(events.length, 1);
  assert.match(events[0]!.progressId, /^progress:tool:/);
  assert.equal(events[0]!.phase, "completed");
  assert.equal(events[0]!.summary, "Tool call completed: sessions_spawn");
  assert.deepEqual(events[0]!.metadata, {
    toolCallId: "call-1",
    toolName: "sessions_spawn",
    detail: { status: "ok" },
  });
});

test("recordRoleToolProgressSafely swallows recorder failures", async () => {
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    await recordRoleToolProgressSafely({
      recorder: {
        async record() {
          throw new Error("progress recorder unavailable");
        },
      },
      activation: buildActivation(),
      call: {
        id: "call-1",
        name: "sessions_spawn",
        input: {},
      },
      progress: {
        phase: "started",
        toolName: "sessions_spawn",
        summary: "Tool call started: sessions_spawn",
      },
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.[0], "runtime tool progress recording failed");
});

test("artifacts_read exposes bounded tool-result artifact pages", async () => {
  const store: ToolResultArtifactStore = {
    async put() {
      throw new Error("not used");
    },
    async read(input) {
      assert.deepEqual(input, {
        artifactId: "tool-result-1",
        offsetBytes: 512,
        limitBytes: 4_096,
      });
      return {
        record: {
          protocol: "turnkeyai.tool_result_artifact.v1",
          artifactId: "tool-result-1",
          threadId: "thread-1",
          runKey: "run-1",
          toolCallId: "source-call",
          toolName: "web_fetch",
          sizeBytes: 70_000,
          sha256: "a".repeat(64),
          createdAt: 1,
        },
        content: "page content",
        offsetBytes: 512,
        nextOffsetBytes: 524,
        eof: false,
      };
    },
  };
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    toolResultArtifactStore: store,
  });

  assert.equal(
    executor.definitions().some((definition) => definition.name === "artifacts_read"),
    true,
  );
  const result = await executor.execute({
    call: {
      id: "read-1",
      name: "artifacts_read",
      input: {
        artifact_id: "tool-result-1",
        offset_bytes: 512,
        limit_bytes: 4_096,
      },
    },
    activation: buildActivation(),
    packet: buildPacket(),
  });
  const payload = JSON.parse(result.content) as Record<string, unknown>;

  assert.equal(payload["artifact_id"], "tool-result-1");
  assert.equal(payload["content"], "page content");
  assert.equal(payload["next_offset_bytes"], 524);
  assert.equal(payload["eof"], false);
  assert.equal(payload["sha256"], "a".repeat(64));
});

test("emitRoleToolProgressSafely records runtime progress and forwards to observer", async () => {
  const events: unknown[] = [];
  const forwarded: Array<{ call: LLMToolCall; progress: RoleToolProgressEvent }> = [];
  const call: LLMToolCall = {
    id: "call-1",
    name: "sessions_spawn",
    input: {},
  };
  const progress: RoleToolProgressEvent = {
    phase: "started",
    toolName: "sessions_spawn",
    summary: "Tool call started: sessions_spawn",
  };

  await emitRoleToolProgressSafely({
    recorder: {
      async record(event) {
        events.push(event);
      },
    },
    activation: buildActivation(),
    call,
    progress,
    onProgress: async (progressCall, progressEvent) => {
      forwarded.push({ call: progressCall, progress: progressEvent });
    },
  });

  assert.equal(events.length, 1);
  assert.deepEqual(forwarded, [{ call, progress }]);
});

test("emitRoleToolProgressSafely swallows observer progress failures", async () => {
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    await emitRoleToolProgressSafely({
      recorder: undefined,
      activation: buildActivation(),
      call: {
        id: "call-1",
        name: "sessions_spawn",
        input: {},
      },
      progress: {
        phase: "started",
        toolName: "sessions_spawn",
        summary: "Tool call started: sessions_spawn",
      },
      onProgress: async () => {
        throw new Error("observer unavailable");
      },
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.[0], "native tool message progress persistence failed");
});

test("executeRoleToolCalls emits lifecycle progress and forwards tool results", async () => {
  const forwarded: RoleToolProgressEvent[] = [];
  const results: unknown[] = [];
  const call: LLMToolCall = {
    id: "call-1",
    name: "sessions_spawn",
    input: {},
  };

  const executed = await executeRoleToolCalls({
    toolLoop: {
      executor: {
        definitions: () => [],
        async execute() {
          return {
            toolCallId: "call-1",
            toolName: "sessions_spawn",
            content: "done",
            progress: [
              {
                phase: "progress",
                toolName: "sessions_spawn",
                summary: "running",
              },
            ],
          };
        },
      },
    },
    runtimeProgressRecorder: undefined,
    deferToolObservability: false,
    now: () => 1000,
    activation: buildActivation(),
    packet: buildPacket(),
    toolCalls: [call],
    toolLoopStartedAtMs: 900,
    onProgress: async (_call, progress) => {
      forwarded.push(progress);
    },
    onResult: async (result) => {
      results.push(result);
    },
  });

  assert.equal(executed.length, 1);
  assert.equal(results.length, 1);
  assert.deepEqual(
    forwarded.map((progress) => progress.phase),
    ["started", "progress", "completed"],
  );
});

test("executeRoleToolCalls emits skipped results for calls over the per-round cap", async () => {
  const forwarded: RoleToolProgressEvent[] = [];
  const executed = await executeRoleToolCalls({
    toolLoop: {
      maxToolCallsPerRound: 1,
      executor: {
        definitions: () => [],
        async execute(input) {
          return {
            toolCallId: input.call.id,
            toolName: input.call.name,
            content: "done",
          };
        },
      },
    },
    runtimeProgressRecorder: undefined,
    deferToolObservability: false,
    now: () => 1000,
    activation: buildActivation(),
    packet: buildPacket(),
    toolCalls: [
      { id: "call-1", name: "sessions_spawn", input: {} },
      { id: "call-2", name: "web_fetch", input: {} },
    ],
    toolLoopStartedAtMs: 900,
    onProgress: async (_call, progress) => {
      forwarded.push(progress);
    },
  });

  assert.equal(executed.length, 2);
  assert.equal(executed[1]?.skipped, true);
  assert.equal(executed[1]?.isError, true);
  assert.deepEqual(
    forwarded.map((progress) => progress.summary),
    [
      "Tool call started: sessions_spawn",
      "Tool call completed: sessions_spawn",
      "Skipped web_fetch: per-turn tool call limit exceeded.",
    ],
  );
});

test("executeRuntimeForcedToolRound records native trace, appends messages, and records provider protocol", async () => {
  const toolTrace: NativeToolRoundTrace[] = [];
  const persistCalls: Array<{ forceBlocking?: boolean | undefined }> = [];
  const providerRounds: Array<{ round: number; messagesLength: number }> = [];
  const call: LLMToolCall = {
    id: "call-1",
    name: "sessions_spawn",
    input: {},
  };

  const result = await executeRuntimeForcedToolRound({
    toolLoop: {
      executor: {
        definitions: () => [],
        async execute() {
          return {
            toolCallId: "call-1",
            toolName: "sessions_spawn",
            content: "done",
          };
        },
      },
    },
    runtimeProgressRecorder: undefined,
    deferToolObservability: false,
    now: () => 1234,
    activation: buildActivation(),
    packet: buildPacket(),
    messages: [{ role: "user", content: "run it" }],
    toolTrace,
    toolCalls: [call],
    round: 4,
    toolLoopStartedAtMs: 1200,
    assistantText: "I'll run it.",
    persistNativeToolTrace: async (options) => {
      persistCalls.push(options ?? {});
    },
    recordProviderToolProtocolRound: async (input) => {
      providerRounds.push({
        round: input.round,
        messagesLength: input.messages.length,
      });
    },
  });

  assert.equal(result.toolResults.length, 1);
  assert.equal(result.messages.at(-2)?.role, "assistant");
  assert.equal(result.messages.at(-1)?.role, "tool");
  assert.equal(toolTrace.length, 1);
  assert.equal(toolTrace[0]?.round, 4);
  assert.equal(toolTrace[0]?.progress?.[0]?.phase, "started");
  assert.equal(toolTrace[0]?.results[0]?.toolCallId, "call-1");
  assert.deepEqual(persistCalls, [
    { forceBlocking: true },
    { forceBlocking: false },
    {},
  ]);
  assert.deepEqual(providerRounds, [{ round: 4, messagesLength: 3 }]);
});

test("executeRuntimeForcedToolRound externalizes history without changing returned evidence", async () => {
  const originalContent = "original oversized evidence";
  const referenceContent = JSON.stringify({
    protocol: "turnkeyai.tool_result_artifact.v1",
    artifact_id: "tool-result-1",
  });
  const result = await executeRuntimeForcedToolRound({
    toolLoop: {
      executor: {
        definitions: () => [],
        async execute() {
          return {
            toolCallId: "call-1",
            toolName: "web_fetch",
            content: originalContent,
          };
        },
      },
    },
    runtimeProgressRecorder: undefined,
    now: () => 1234,
    activation: buildActivation(),
    packet: buildPacket(),
    messages: [{ role: "user", content: "fetch it" }],
    toolTrace: [],
    toolCalls: [{ id: "call-1", name: "web_fetch", input: {} }],
    round: 1,
    toolLoopStartedAtMs: 1200,
    assistantText: "Fetching.",
    mapToolResultsForHistory: async (results) =>
      results.map((toolResult) => ({
        ...toolResult,
        content: referenceContent,
      })),
    persistNativeToolTrace: async () => undefined,
    recordProviderToolProtocolRound: async () => undefined,
  });

  assert.equal(result.toolResults[0]?.content, originalContent);
  assert.equal(result.messages.at(-1)?.role, "tool");
  const historyContent = result.messages.at(-1)?.content;
  assert.equal(Array.isArray(historyContent), true);
  assert.equal(
    Array.isArray(historyContent) && historyContent[0]?.type === "tool_result"
      ? historyContent[0].content
      : undefined,
    referenceContent,
  );
});

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

test("web_fetch directly returns structured public page evidence", async () => {
  const calls: string[] = [];
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    webFetchEnabled: true,
    fetchFn: async (url) => {
      calls.push(String(url));
      return new Response(
        "<html><head><title>Example Domain</title></head><body><p>This domain is for use in documentation examples without needing permission.</p></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html" },
        }
      );
    },
  });

  assert.equal(executor.definitions().some((definition) => definition.name === "web_fetch"), true);
  const result = await executor.execute({
    call: {
      id: "call-web-fetch",
      name: "web_fetch",
      input: {
        url: "https://example.com",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Fetch https://example.com.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as {
    status: string;
    requested_url: string;
    final_url: string;
    title: string;
    text_excerpt: string;
  };
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ["https://example.com/"]);
  assert.equal(body.status, "ok");
  assert.equal(body.requested_url, "https://example.com/");
  assert.equal(body.final_url, "https://example.com/");
  assert.equal(body.title, "Example Domain");
  assert.match(body.text_excerpt, /documentation examples/);
  assert.equal(result.progress?.at(-1)?.phase, "completed");
});

test("web_fetch rejects localhost and private-network URLs", async () => {
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    webFetchEnabled: true,
    fetchFn: async () => {
      throw new Error("fetch must not be called for blocked hosts");
    },
  });

  const result = await executor.execute({
    call: {
      id: "call-web-fetch-localhost",
      name: "web_fetch",
      input: {
        url: "http://127.0.0.1:4100/app",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Fetch localhost.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /blocked web_fetch URL host: 127\.0\.0\.1/);
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

test("sessions_spawn maps null worker output with timeout summary state to resumable timeout", async () => {
  const workerRuntime = {
    async spawn() {
      return { workerType: "browser", workerRunKey: "worker:browser:timeout-null" };
    },
    async send() {
      return null;
    },
    async getState() {
      return {
        workerRunKey: "worker:browser:timeout-null",
        workerType: "browser",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
        continuationDigest: {
          reason: "timeout_summary",
          summary: "Browser opened the loopback source and captured a timeout before DOMContentLoaded.",
          createdAt: 2,
        },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["browser"] });

  const result = await executor.execute({
    call: {
      id: "call-timeout-null",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open the slow loopback page.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Open the slow loopback page.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as {
    status: string;
    evidence_available: boolean;
    evidence_summary: string;
    result: string;
  };
  assert.equal(result.isError, true);
  assert.equal(body.status, "timeout");
  assert.equal(body.evidence_available, true);
  assert.match(body.evidence_summary, /loopback source/);
  assert.doesNotMatch(body.result, /no executable result/i);
  assert.equal(result.progress?.at(-1)?.detail?.status, "timeout");
});

test("sessions_spawn preserves a worker absolute-deadline result as resumable timeout", async () => {
  const workerRuntime = {
    async spawn() {
      return { workerType: "explore", workerRunKey: "worker:explore:absolute-deadline" };
    },
    async send() {
      return {
        workerType: "explore",
        status: "timeout",
        summary: "Sub-agent timed out: run deadline exceeded at 12345",
        payload: {
          mode: "llm_sub_agent",
          workerType: "explore",
          resumableReason: "run_deadline_exceeded",
          deadlineAt: 12_345,
        },
      } as unknown as WorkerExecutionResult;
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
  });

  const result = await executor.execute({
    call: {
      id: "call-absolute-deadline",
      name: "sessions_spawn",
      input: {
        agent_id: "explore",
        task: "Inspect the source within the parent absolute deadline.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Inspect the source within the parent absolute deadline.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as {
    status: string;
    resumable?: boolean;
    result: string;
  };
  assert.equal(result.isError, true);
  assert.equal(body.status, "timeout");
  assert.equal(body.resumable, true);
  assert.match(body.result, /run deadline exceeded at 12345/i);
  assert.equal(result.progress?.at(-1)?.phase, "failed");
  assert.equal(result.progress?.at(-1)?.detail?.status, "timeout");
});

test("sessions_spawn floors model-short timeout for slow loopback browser tasks", async () => {
  const workerRuntime = {
    async spawn() {
      return { workerType: "browser", workerRunKey: "worker:browser:slow-loopback" };
    },
    async send() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        workerType: "browser",
        status: "completed",
        summary: "Slow loopback check completed.",
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    maxSessionToolTimeoutMs: 100,
    hardTimeoutGraceMs: 1,
  });

  const result = await executor.execute({
    call: {
      id: "call-slow-loopback-floor",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Inspect the localhost slow source at http://127.0.0.1:61930/slow-fixture with a bounded browser attempt.",
        timeout_seconds: 0.001,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Inspect this localhost slow source through a browser-visible local-runtime path.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; result: string };
  assert.equal(result.isError, undefined);
  assert.equal(body.status, "completed");
  assert.equal(body.result, "Slow loopback check completed.");
});

test("sessions_spawn floors model-short timeout for local approval browser tasks", async () => {
  const toolPermissionService: ToolPermissionService = {
    async request(input) {
      return {
        status: "pending",
        approvalId: "ap.thread-1.local-approval-floor",
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
      return {
        status: "approved",
        approvalId: input.approvalId,
        action: "browser.form.submit",
        message: "Approved.",
      };
    },
    async apply(input) {
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
      return { workerType: "browser", workerRunKey: "worker:browser:approval-form" };
    },
    async send() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        workerType: "browser",
        status: "completed",
        summary: "Approval form submitted after permission.",
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    maxSessionToolTimeoutMs: 100,
    hardTimeoutGraceMs: 1,
    toolPermissionService,
  });

  const result = await executor.execute({
    call: {
      id: "call-local-approval-floor",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open http://127.0.0.1:61930/approval-form and submit the dry-run form after approval.",
        timeout_seconds: 0.001,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Complete the local approval dry-run action after the operator approves browser.form.submit.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; result: string };
  assert.equal(result.isError, undefined);
  assert.equal(body.status, "completed");
  assert.equal(body.result, "Approval form submitted after permission.");
});

test("sessions_spawn lets supplemental local timeout browser probe exceed foreground cap", async () => {
  const workerRuntime = {
    async spawn() {
      return { workerType: "browser", workerRunKey: "worker:browser:supplemental-timeout-probe" };
    },
    async send() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        workerType: "browser",
        status: "completed",
        summary: "Supplemental probe returned bounded negative evidence.",
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    maxSessionToolTimeoutMs: 1,
    hardTimeoutGraceMs: 1,
  });

  const result = await executor.execute({
    call: {
      id: "call-supplemental-browser-probe",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: [
          "Supplemental local timeout probe mode: call browser_open with timeout_ms 10000.",
          "Open http://127.0.0.1:61930/slow-fixture as an operator would see it.",
        ].join("\n"),
        timeout_seconds: 90,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue a content-poor slow loopback timeout follow-up.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; result: string };
  assert.equal(result.isError, undefined);
  assert.equal(body.status, "completed");
  assert.equal(body.result, "Supplemental probe returned bounded negative evidence.");
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
      instructions: [
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

test("sessions_spawn reinforces parent source URL when delegated task has a matching label but wrong URL", async () => {
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
      id: "call-wrong-url",
      name: "sessions_spawn",
      input: {
        agent_id: "explore",
        task: "Fetch http://127.0.0.0.1:4101/vendor-beta for Vendor Beta pricing and risk.",
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

  assert.match(capturedTaskPrompt, /http:\/\/127\.0\.0\.0\.1:4101\/vendor-beta/);
  assert.match(capturedTaskPrompt, /Parent mission context relevant to this delegated task/);
  assert.match(capturedTaskPrompt, /Vendor Beta source: http:\/\/127\.0\.0\.1:4101\/vendor-beta/);
  assert.doesNotMatch(capturedTaskPrompt, /vendor-alpha[\s\S]*Parent mission context relevant/i);
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

test("sessions_spawn routes public read-only browser source extraction to explore when available", async () => {
  let capturedPreferredWorkers: unknown = null;
  const workerRuntime = {
    async spawn(input: WorkerInvocationInput) {
      capturedPreferredWorkers = input.packet.preferredWorkerKinds;
      return { workerType: "explore", workerRunKey: "worker:explore:task-1" };
    },
    async send() {
      return {
        workerType: "explore",
        status: "completed",
        summary: "Pricing source extracted.",
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser", "explore"],
  });

  const result = await executor.execute({
    call: {
      id: "call-public-source",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Fetch and extract pricing from https://example.com/pricing for a public source comparison.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Compare pricing pages.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { agent_id?: string };
  assert.deepEqual(capturedPreferredWorkers, ["explore"]);
  assert.equal(body.agent_id, "explore");
  assert.match(result.progress?.[0]?.summary ?? "", /Started explore sub-agent/);
});

test("sessions_spawn routes localhost read-only browser extraction to explore when available", async () => {
  let capturedPreferredWorkers: unknown = null;
  const workerRuntime = {
    async spawn(input: WorkerInvocationInput) {
      capturedPreferredWorkers = input.packet.preferredWorkerKinds;
      return { workerType: "explore", workerRunKey: "worker:explore:task-local" };
    },
    async send() {
      return {
        workerType: "explore",
        status: "completed",
        summary: "Local vendor source pages extracted.",
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser", "explore"],
  });

  const result = await executor.execute({
    call: {
      id: "call-local-browser-extract",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        label: "Vendor Alpha & Beta browser extraction",
        task: [
          "Extract a structured comparison from two localhost vendor pages.",
          "For each URL, retrieve the page title, pricing, strength, and risk.",
          "URLs: http://127.0.0.1:60266/vendor-alpha and http://127.0.0.1:60266/vendor-beta.",
        ].join(" "),
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Compare local vendor source pages.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { agent_id?: string };
  assert.deepEqual(capturedPreferredWorkers, ["explore"]);
  assert.equal(body.agent_id, "explore");
  assert.match(result.progress?.[0]?.summary ?? "", /Started explore sub-agent/);
});

test("sessions_spawn keeps browser for rendered, interactive, or user-session source tasks", async () => {
  let capturedPreferredWorkers: unknown = null;
  const workerRuntime = {
    async spawn(input: WorkerInvocationInput) {
      capturedPreferredWorkers = input.packet.preferredWorkerKinds;
      return { workerType: "browser", workerRunKey: "worker:browser:task-1" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Rendered dashboard inspected.",
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser", "explore"],
  });

  const result = await executor.execute({
    call: {
      id: "call-rendered-dashboard",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open https://example.com/dashboard and inspect the JS-rendered dashboard as a user would see it.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Review dashboard.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { agent_id?: string };
  assert.deepEqual(capturedPreferredWorkers, ["browser"]);
  assert.equal(body.agent_id, "browser");
  assert.match(result.progress?.[0]?.summary ?? "", /Started browser sub-agent/);
});

test("sessions_spawn keeps browser for approval form inspection before dry-run submission", async () => {
  let capturedPreferredWorkers: unknown = null;
  const workerRuntime = {
    async spawn(input: WorkerInvocationInput) {
      capturedPreferredWorkers = input.packet.preferredWorkerKinds;
      return { workerType: "browser", workerRunKey: "worker:browser:approval-form" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Approval form inspected.",
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser", "explore"],
  });

  const result = await executor.execute({
    call: {
      id: "call-approval-form",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        label: "Inspect approval form structure",
        task: [
          "Navigate to http://127.0.0.1:61930/approval-form and inspect the form structure.",
          "Extract all form fields, their IDs, names, types, labels, and placeholders.",
          "Also list whether a submission control exists and whether the page states any approval/dry-run language.",
        ].join(" "),
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { agent_id?: string };
  assert.deepEqual(capturedPreferredWorkers, ["browser"]);
  assert.equal(body.agent_id, "browser");
  assert.match(result.progress?.[0]?.summary ?? "", /Started browser sub-agent/);
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

test("sessions_spawn allows pre-approval browser inspection when parent goal later requires submission approval", async () => {
  let spawnCalled = false;
  let requestedAction = "";
  const toolPermissionService: ToolPermissionService = {
    async request(input) {
      requestedAction = input.action;
      return {
        status: "pending",
        approvalId: "ap.thread-1.call-parent-approval",
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
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Rendered approval form inspected. No submit action ran.",
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
      id: "call-parent-approval",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: [
          "Pre-approval browser inspection only.",
          "Navigate to http://127.0.0.1:61930/approval-form and inspect the page.",
          "Report whether marker TURNKEYAI_APPROVAL_FIXTURE_OK is present and that no external mutation is performed.",
          "Do not submit the form; the form submission remains blocked until permission approval clears.",
        ].join(" "),
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        "Actually carry the safe local dry-run through the approval gate; do not stop at a plan or a generic approval explanation.",
        "Request approval before applying the browser action, then report what was approved and what evidence the page showed.",
      ].join("\n"),
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; agent_id: string };
  assert.equal(spawnCalled, true);
  assert.equal(requestedAction, "");
  assert.equal(result.isError, undefined);
  assert.equal(body.status, "completed");
  assert.equal(body.agent_id, "browser");
});

test("sessions_spawn proceeds with browser side effects after permission cache grants the action", async () => {
  let spawnCalled = false;
  let spawnedTaskPrompt = "";
  let approvedRuntimeAction = "";
  const activation = buildActivation();
  activation.handoff.payload = {
    threadId: "thread-1",
    intent: {
      relayBrief: "",
      instructions: "Local approval fixture source: http://127.0.0.1:4101/approval-form",
      recentMessages: [],
    },
  };
  const toolPermissionService: ToolPermissionService = {
    async request(input) {
      return {
        status: "already_granted",
        action: input.action,
        requirement: {
          level: input.requirement.level,
          scope: input.requirement.scope,
          cacheKey: "http://approval-cache.invalid/key",
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
    async spawn(input: WorkerInvocationInput) {
      spawnCalled = true;
      spawnedTaskPrompt = input.packet.taskPrompt;
      approvedRuntimeAction = input.packet.runtimeApprovalContext?.browserSideEffects?.[0]?.action ?? "";
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
    activation,
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
  assert.match(spawnedTaskPrompt, /parent runtime approval is granted/i);
  assert.match(spawnedTaskPrompt, /permission cache is already applied/i);
  assert.match(spawnedTaskPrompt, /browser\.form\.submit/i);
  assert.match(spawnedTaskPrompt, /Required approved action: submit the local browser form/i);
  assert.match(spawnedTaskPrompt, /browser_act on the submit control with submit=true/i);
  assert.match(spawnedTaskPrompt, /Do not stop after inspection/i);
  assert.match(spawnedTaskPrompt, /Parent mission context relevant to this delegated task/);
  assert.match(spawnedTaskPrompt, /Local approval fixture source: http:\/\/127\.0\.0\.1:4101\/approval-form/);
  assert.equal(approvedRuntimeAction, "browser.form.submit");
});

test("sessions_spawn does not reuse completed browser submit results before approval", async () => {
  let spawnCalled = false;
  const lastResult = {
    workerType: "browser" as const,
    status: "completed" as const,
    summary:
      "The approved browser.form.submit action was executed via browser_act with submit=true and the post-submit page was verified.",
    payload: {
      mode: "llm_sub_agent",
      workerType: "browser",
      content: "Dry-run submitted locally after approval; no external mutation was performed.",
    },
  };
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:submitted",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-browser",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
            parentSessionKey: "role:role-lead:thread:thread-1",
            toolCallId: "call-original",
            label: "approval-gated-browser-e2e",
          },
          state: {
            workerRunKey: "worker:browser:submitted",
            workerType: "browser",
            status: "done",
            createdAt: 1,
            updatedAt: 2,
            lastResult,
          },
        },
      ];
    },
    async spawn() {
      spawnCalled = true;
      throw new Error("browser side effect must not start before approval");
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["browser"] });

  const result = await executor.execute({
    call: {
      id: "call-repeat-submit-spawn",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        label: "approval-gated-browser-e2e",
        task:
          "The action browser.form.submit has been approved by the runtime permission gate. Navigate to the approval form and submit the dry-run form again.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Complete the local approval dry-run action.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(spawnCalled, false);
  assert.equal(result.isError, true);
  assert.match(result.content, /Permission approval is required/i);
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

test("sessions_spawn does not require mutation approval for submitting a read-only summary to the operator", async () => {
  let spawnCalled = false;
  let permissionRequested = false;
  const toolPermissionService: ToolPermissionService = {
    async request() {
      permissionRequested = true;
      throw new Error("read-only browser summary should not request mutation approval");
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
      return { workerType: "browser", workerRunKey: "worker:browser:task-summary" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Reviewed dashboard.",
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
      id: "call-readonly-submit-summary",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open the rendered dashboard, review the queue status, and submit a summary to the operator with owner and next action.",
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

test("sessions_spawn does not require mutation approval for read-only navigation links named submit", async () => {
  let spawnCalled = false;
  let permissionRequested = false;
  const toolPermissionService: ToolPermissionService = {
    async request() {
      permissionRequested = true;
      throw new Error("read-only navigation link inventory must not request mutation approval");
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
      return { workerType: "browser", workerRunKey: "worker:browser:task-navigation-links" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Reviewed navigation links.",
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
      id: "call-readonly-submit-navigation-link",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: [
          "Navigate to https://news.ycombinator.com/ and inspect the browser-rendered page as a user would see it.",
          "Summarize visible story listings and navigation links such as new, past, comments, ask, show, jobs, submit, and login.",
          "Do not click, submit, or change anything; this is a read-only browser review.",
        ].join("\n"),
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Review live external page.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(spawnCalled, true);
  assert.equal(permissionRequested, false);
  assert.equal(result.isError, undefined);
});

test("sessions_spawn does not require mutation approval for read-only dashboard next-action review", async () => {
  for (const [id, task] of [
    [
      "dynamic-dashboard-review",
      "Review the operations dashboard at http://127.0.0.1:4101/ops-dashboard as a user would see it in the browser. Wait for full client-side rendering, then identify the operational state, escalation trigger, owner, and recommended next action for an operator.",
    ],
    [
      "dashboard-before-paging-review",
      "Navigate to http://127.0.0.1:4101/ops-dashboard and wait for the page to fully load and render. The operator wants help reading the live operations dashboard before paging anyone. Explain whether the escalation policy is triggered, who should own the next action, and what risk remains after the check.",
    ],
    [
      "dashboard-whether-to-page-review",
      "Open the rendered dashboard, review the queue status, and determine whether to send a page to the on-call operator. Do not page anyone; return the verified status and residual risk.",
    ],
    [
      "send-next-action",
      "Open the rendered dashboard, review the queue status, and send the recommended next action to the operator with residual risk.",
    ],
    [
      "send-back-next-action",
      "Open the rendered dashboard, review the queue status, and send back the recommended next action to the operator with residual risk.",
    ],
    [
      "asiawalk-read-only-planning",
      [
        "This is a read-only planning brief.",
        "Do not click forms, submit anything, simulate deposits, or request approval; only inspect the listed sources and synthesize a recommendation.",
        "Open http://127.0.0.1:4101/asiawalk-live and inspect the rendered readiness dashboard.",
      ].join("\n"),
    ],
  ] as const) {
    let spawnCalled = false;
    let permissionRequested = false;
    const toolPermissionService: ToolPermissionService = {
      async request() {
        permissionRequested = true;
        throw new Error(`${id} should not request mutation approval`);
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
        return { workerType: "browser", workerRunKey: `worker:browser:${id}` };
      },
      async send() {
        return {
          workerType: "browser",
          status: "completed",
          summary: "Reviewed dashboard.",
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
        id,
        name: "sessions_spawn",
        input: {
          agent_id: "browser",
          task,
        },
      },
      activation: buildActivation(),
      packet: {
        roleId: "role-lead",
        roleName: "Lead",
        seat: "lead",
        systemPrompt: "Lead.",
        taskPrompt: "Review rendered dashboard.",
        outputContract: "Return result.",
        suggestedMentions: [],
      },
    });

    assert.equal(spawnCalled, true);
    assert.equal(permissionRequested, false);
    assert.equal(result.isError, undefined);
  }
});

test("sessions_spawn does not require publish approval for read-only browser-visible source evidence", async () => {
  let spawnCalled = false;
  let permissionRequested = false;
  const toolPermissionService: ToolPermissionService = {
    async request() {
      permissionRequested = true;
      throw new Error("read-only source evidence extraction must not request publish approval");
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
      return { workerType: "browser", workerRunKey: "worker:browser:vendor-evidence" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Extracted vendor evidence.",
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
      id: "call-browser-visible-vendor-evidence",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: [
          "Open the local/private URL as a browser-visible source instead of using web_fetch.",
          "URL: http://127.0.0.1:4101/vendor-beta",
          "Extract online evidence for pricing, strengths, risks, published positioning, and release-risk notes.",
          "Report only observed source evidence for a vendor comparison recommendation.",
        ].join("\n"),
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: [
        "Review these two source pages: http://127.0.0.1:4101/vendor-alpha and http://127.0.0.1:4101/vendor-beta.",
        "Return a recommendation comparing pricing, strengths, risks, and tradeoff.",
        "Use only evidence collected during this mission.",
      ].join("\n"),
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(spawnCalled, true);
  assert.equal(permissionRequested, false);
  assert.equal(result.isError, undefined);
});

test("sessions_spawn does not require credential approval for token pricing research", async () => {
  let permissionRequested = false;
  let spawnedTaskPrompt = "";
  const workerRuntime = {
    async spawn(input: { packet: { taskPrompt: string } }) {
      spawnedTaskPrompt = input.packet.taskPrompt;
      return { workerType: "browser", workerRunKey: "worker:browser:token-pricing" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "DeepSeek V4 Flash token pricing page inspected.",
        payload: {
          sources: [
            {
              label: "DeepSeek provider pricing",
              url: "http://127.0.0.1:53034/deepseek-provider-pricing",
              text: "OpenRouter input $0.28 output $0.42; Together input $0.20 output $0.40.",
            },
          ],
        },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService: {
      async request() {
        permissionRequested = true;
        throw new Error("token pricing is not credential access");
      },
      async result() {
        throw new Error("permission_result should not be called");
      },
      async apply() {
        throw new Error("permission_applied should not be called");
      },
    },
  });

  const result = await executor.execute({
    call: {
      id: "call-token-pricing",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: [
          "Open the local/private URL as a browser-visible source instead of using web_fetch.",
          "URL: http://127.0.0.1:53034/deepseek-provider-pricing",
          "Identify provider search support and input/output token pricing.",
          "This is source-bounded pricing research; do not use credentials or mutate anything.",
        ].join("\n"),
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Research DeepSeek V4 Flash provider support and token pricing.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(permissionRequested, false);
  assert.equal(result.isError, undefined);
  assert.match(spawnedTaskPrompt, /token pricing/i);
});

test("sessions_spawn does not require publish approval for provider search support recovery", async () => {
  let spawnCalled = false;
  let permissionRequested = false;
  const workerRuntime = {
    async spawn() {
      spawnCalled = true;
      return { workerType: "browser", workerRunKey: "worker:browser:provider-recovery" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Provider support evidence collected.",
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService: {
      async request() {
        permissionRequested = true;
        throw new Error("provider search support recovery is read-only source work");
      },
      async result() {
        throw new Error("not used");
      },
      async apply() {
        throw new Error("not used");
      },
    },
  });

  const result = await executor.execute({
    call: {
      id: "call-provider-recovery",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        label: "local-url-fetch",
        task: [
          "Open the local/private URL as a browser-visible source instead of using web_fetch.",
          "URL: http://127.0.0.1:53034/deepseek-provider-pricing",
          "Extract observed provider support, search/web_search support, input/output token pricing, and production decision risk.",
          "Use only source evidence and report what remains unverified; do not publish, release, deploy, or mutate anything.",
        ].join("\n"),
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt:
        "System recovery: the previous final answer did not satisfy required goal slots. Continue the original DeepSeek V4 Flash provider search pricing research.",
      outputContract: "Return provider support, search support, pricing, recommendation, and residual risk.",
      suggestedMentions: [],
    },
  });

  assert.equal(spawnCalled, true);
  assert.equal(permissionRequested, false);
  assert.equal(result.isError, undefined);
});

test("sessions_spawn requires mutation approval for ambiguous browser submit output wording", async () => {
  for (const [id, task] of [
    ["submit-review", "Open the page and submit review."],
    ["submit-report-abuse", "Open the page and submit report abuse."],
  ] as const) {
    let spawnCalled = false;
    let requestedAction = "";
    const toolPermissionService: ToolPermissionService = {
      async request(input) {
        requestedAction = input.action;
        return {
          status: "pending",
          approvalId: `ap.thread-1.${id}`,
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
        return { workerType: "browser", workerRunKey: `worker:browser:${id}` };
      },
    } as unknown as WorkerRuntime;
    const executor = createWorkerSessionToolExecutor({
      workerRuntime,
      availableWorkerKinds: ["browser"],
      toolPermissionService,
    });

    const result = await executor.execute({
      call: {
        id: `call-${id}`,
        name: "sessions_spawn",
        input: {
          agent_id: "browser",
          task,
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

    const body = JSON.parse(result.content) as { status: string; blocked_before_side_effect: boolean };
    assert.equal(spawnCalled, false);
    assert.equal(requestedAction, "browser.form.submit");
    assert.equal(result.isError, true);
    assert.equal(body.status, "requires_approval");
    assert.equal(body.blocked_before_side_effect, true);
  }
});

test("sessions_spawn requires mutation approval for explicit browser paging action", async () => {
  let spawnCalled = false;
  let requestedAction = "";
  const toolPermissionService: ToolPermissionService = {
    async request(input) {
      requestedAction = input.action;
      return {
        status: "pending",
        approvalId: "ap.thread-1.page-on-call",
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
      return { workerType: "browser", workerRunKey: "worker:browser:page-on-call" };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService,
  });

  const result = await executor.execute({
    call: {
      id: "call-page-on-call",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open the dashboard and send a page to the on-call operator.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Send a page to on-call.",
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
  let spawnedTaskPrompt = "";
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
    async spawn(input: { packet: { taskPrompt: string } }) {
      events.push("spawn");
      spawnedTaskPrompt = input.packet.taskPrompt;
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
        task: [
          "Open the local approval form.",
          "Use permission_query before submitting the form.",
          "Request approval before applying the browser action.",
          'Verify the page says "Approval required before submitting".',
          "Submit the final account update form and verify the result.",
        ].join("\n"),
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
  assert.match(spawnedTaskPrompt, /parent runtime approval is granted/i);
  assert.match(spawnedTaskPrompt, /permission cache is already applied/i);
  assert.match(spawnedTaskPrompt, /browser\.form\.submit/i);
  assert.match(spawnedTaskPrompt, /Open the local approval form/);
  assert.match(spawnedTaskPrompt, /Approval required before submitting/);
  assert.match(spawnedTaskPrompt, /Submit the final account update form and verify the result/);
  assert.doesNotMatch(spawnedTaskPrompt, /permission_query/i);
  assert.doesNotMatch(spawnedTaskPrompt, /Request approval before applying/i);
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

test("sessions_spawn returns approval wait-timeout when operator decision stays pending", async () => {
  const previousWaitMs = process.env.TURNKEYAI_TOOL_PERMISSION_WAIT_MS;
  process.env.TURNKEYAI_TOOL_PERMISSION_WAIT_MS = "25";
  let observedTimeoutMs: number | undefined;
  let spawnCalled = false;
  try {
    const toolPermissionService: ToolPermissionService = {
      async request(input) {
        return {
          status: "pending",
          approvalId: "ap.thread-1.call-approval-timeout",
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
        observedTimeoutMs = input.timeoutMs;
        return {
          status: "pending",
          approvalId: input.approvalId,
          action: "browser.form.submit",
          message: "Permission request is still pending.",
        };
      },
      async apply() {
        throw new Error("not reached");
      },
    };
    const workerRuntime = {
      async spawn() {
        spawnCalled = true;
        throw new Error("worker must not start while approval is pending");
      },
    } as unknown as WorkerRuntime;
    const executor = createWorkerSessionToolExecutor({
      workerRuntime,
      availableWorkerKinds: ["browser"],
      toolPermissionService,
    });

    const result = await executor.execute({
      call: {
        id: "call-approval-timeout",
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
    assert.equal(observedTimeoutMs, 25);
    assert.equal(spawnCalled, false);
    assert.equal(result.isError, true);
    assert.equal(body.status, "approval_wait_timeout");
    assert.equal(body.blocked_before_side_effect, true);
    assert.match(body.message, /still pending/i);
    assert.match(body.message, /side effect was not performed/i);
    assert.equal(result.progress?.some((event) => event.detail?.eventType === "permission.query"), true);
    assert.equal(result.progress?.some((event) => event.detail?.eventType === "permission.result"), true);
    assert.equal(result.progress?.some((event) => event.detail?.eventType === "permission.applied"), false);
  } finally {
    if (previousWaitMs === undefined) {
      delete process.env.TURNKEYAI_TOOL_PERMISSION_WAIT_MS;
    } else {
      process.env.TURNKEYAI_TOOL_PERMISSION_WAIT_MS = previousWaitMs;
    }
  }
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

  const result = await Promise.race([
    executePromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("cancelled sessions_spawn did not return before worker send unwound")), 50)
    ),
  ]);
  resolveSend();
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

test("sessions_spawn returns cancelled when the worker session was cancelled outside the registry", async () => {
  const workerRuntime = {
    async spawn() {
      return { workerType: "browser", workerRunKey: "worker:browser:task-1" };
    },
    async send() {
      return null;
    },
    async getState() {
      return {
        workerRunKey: "worker:browser:task-1",
        workerType: "browser",
        status: "cancelled",
        createdAt: 1,
        updatedAt: 2,
        lastError: {
          code: "WORKER_FAILED",
          message: "operator cancelled browser work",
          retryable: false,
        },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["browser"] });

  const result = await executor.execute({
    call: {
      id: "call-cancel-fallback",
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

  const body = JSON.parse(result.content) as { status?: string; result?: string };
  assert.equal(result.cancelled, true);
  assert.equal(result.isError, true);
  assert.equal(body.status, "cancelled");
  assert.equal(body.result, "operator cancelled browser work");
});

test("sessions_send returns cancelled when the worker session was cancelled outside the registry", async () => {
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:task-1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "role:lead",
          },
          state: {
            workerRunKey: "worker:browser:task-1",
            workerType: "browser",
            status: "running",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ];
    },
    async resume() {
      return null;
    },
    async send() {
      throw new Error("sessions_send should resume the existing session instead of starting a bare send");
    },
    async getState() {
      return {
        workerRunKey: "worker:browser:task-1",
        workerType: "browser",
        status: "cancelled",
        createdAt: 1,
        updatedAt: 2,
        lastError: {
          code: "WORKER_FAILED",
          message: "operator cancelled browser work",
          retryable: false,
        },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["browser"] });

  const result = await executor.execute({
    call: {
      id: "call-send-cancel-fallback",
      name: "sessions_send",
      input: {
        session_key: "worker:browser:task-1",
        message: "Continue the slow browser page.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue the slow browser page.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status?: string; result?: string };
  assert.equal(result.cancelled, true);
  assert.equal(result.isError, true);
  assert.equal(body.status, "cancelled");
  assert.equal(body.result, "operator cancelled browser work");
});

test("sessions_send maps null resumed output with timeout summary state to resumable timeout", async () => {
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:timeout-followup",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "role:lead",
          },
          state: {
            workerRunKey: "worker:browser:timeout-followup",
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
        workerRunKey: "worker:browser:timeout-followup",
        workerType: "browser",
        status: "resumable",
        createdAt: 1,
        updatedAt: 3,
        continuationDigest: {
          reason: "timeout_summary",
          summary: "Follow-up browser worker retried the slow source and preserved the timeout evidence.",
          createdAt: 3,
        },
      };
    },
    async resume() {
      return null;
    },
    async send() {
      throw new Error("sessions_send should resume the existing session instead of starting a bare send");
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["browser"] });

  const result = await executor.execute({
    call: {
      id: "call-send-timeout-null",
      name: "sessions_send",
      input: {
        session_key: "worker:browser:timeout-followup",
        message: "Continue the slow browser page.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue the slow browser page.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as {
    status: string;
    evidence_available: boolean;
    evidence_summary: string;
    result: string;
  };
  assert.equal(result.isError, true);
  assert.equal(body.status, "timeout");
  assert.equal(body.evidence_available, true);
  assert.match(body.evidence_summary, /timeout evidence/);
  assert.doesNotMatch(body.result, /no executable result/i);
  assert.equal(result.progress?.at(-1)?.detail?.status, "timeout");
});

test("sessions_send floors resumable continuation timeout for slow loopback browser tasks", async () => {
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:slow-loopback-followup",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "role:lead",
          },
          state: {
            workerRunKey: "worker:browser:slow-loopback-followup",
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
        workerRunKey: "worker:browser:slow-loopback-followup",
        workerType: "browser",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async resume() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        workerType: "browser",
        status: "completed",
        summary: "Slow loopback follow-up completed.",
      };
    },
    async send() {
      throw new Error("sessions_send should resume the existing session instead of starting a bare send");
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    maxSessionToolTimeoutMs: 100,
    hardTimeoutGraceMs: 1,
  });

  const result = await executor.execute({
    call: {
      id: "call-send-slow-loopback-floor",
      name: "sessions_send",
      input: {
        session_key: "worker:browser:slow-loopback-followup",
        message: "Continue http://127.0.0.1:61930/slow-fixture with a bounded slow-source browser check.",
        timeout_seconds: 0.001,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue the same browser/local slow-source diagnostic.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; result: string };
  assert.equal(result.isError, undefined);
  assert.equal(body.status, "completed");
  assert.equal(body.result, "Slow loopback follow-up completed.");
});

test("sessions_send cancels the active resumed worker before the worker send unwinds", async () => {
  let resolveResume!: () => void;
  let resumeStarted!: () => void;
  let cancelledReason: string | null = null;
  const resumeStartedPromise = new Promise<void>((resolve) => {
    resumeStarted = resolve;
  });
  const releaseResumePromise = new Promise<void>((resolve) => {
    resolveResume = resolve;
  });
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:task-1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "role:lead",
          },
          state: {
            workerRunKey: "worker:browser:task-1",
            workerType: "browser",
            status: "running",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:browser:task-1",
        workerType: "browser",
        status: "running",
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async resume() {
      resumeStarted();
      await releaseResumePromise;
      return {
        workerType: "browser",
        status: "completed",
        summary: "Should not be used after cancellation.",
        payload: null,
      };
    },
    async send() {
      throw new Error("sessions_send should resume the existing session instead of starting a bare send");
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
      id: "call-send-cancel",
      name: "sessions_send",
      input: {
        session_key: "worker:browser:task-1",
        message: "Continue the slow browser page.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue the slow browser page.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  await resumeStartedPromise;
  await toolCancellationRegistry.cancel({
    threadId: "thread-1",
    toolCallIds: ["call-send-cancel"],
    reason: "operator stopped resumed browser work",
  });

  const result = await Promise.race([
    executePromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("cancelled sessions_send did not return before worker resume unwound")), 50)
    ),
  ]);
  resolveResume();
  const body = JSON.parse(result.content) as { status?: string; result?: string };
  assert.equal(cancelledReason, "operator stopped resumed browser work");
  assert.equal(result.cancelled, true);
  assert.equal(result.isError, true);
  assert.equal(body.status, "cancelled");
  assert.equal(body.result, "operator stopped resumed browser work");
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

test("sessions_spawn preserves cooperative partial evidence inside a resumable timeout result", async () => {
  let sendStarted!: () => void;
  let releasePartial!: () => void;
  let interruptedReason: string | null = null;
  const sendStartedPromise = new Promise<void>((resolve) => {
    sendStarted = resolve;
  });
  const releasePartialPromise = new Promise<void>((resolve) => {
    releasePartial = resolve;
  });
  const workerRuntime = {
    async spawn() {
      return { workerType: "browser", workerRunKey: "worker:browser:rendered-evidence" };
    },
    async send() {
      sendStarted();
      await releasePartialPromise;
      return {
        workerType: "browser",
        status: "partial",
        summary: "Rendered browser evidence captured before parent timeout.",
        payload: {
          page: {
            finalUrl: "https://the-internet.herokuapp.com/dynamic_loading/1",
            title: "The Internet",
            textExcerpt: "Dynamically Loaded Page Elements Example 1 Hello World!",
          },
          artifactIds: ["browser-step:hello-world"],
          screenshotPaths: ["/Users/chris/.turnkeyai/data/browser-artifacts/hello-world.png"],
        },
      };
    },
    async interrupt(input: { reason?: string; preserveLateResult?: boolean }) {
      interruptedReason = input.reason ?? null;
      assert.equal(input.preserveLateResult, true);
      releasePartial();
      return {
        workerRunKey: "worker:browser:rendered-evidence",
        workerType: "browser",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async getState() {
      return {
        workerRunKey: "worker:browser:rendered-evidence",
        workerType: "browser",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    hardTimeoutGraceMs: 50,
  });

  const executePromise = executor.execute({
    call: {
      id: "call-rendered-evidence-timeout",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open the dynamic page, click Start, and verify Hello World.",
        timeout_seconds: 0.001,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Verify rendered Hello World.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  await sendStartedPromise;
  const result = await executePromise;
  const body = JSON.parse(result.content) as {
    status: string;
    result: string;
    resumable?: boolean;
    evidence_summary?: string;
  };
  assert.match(interruptedReason ?? "", /sessions_spawn timed out/);
  assert.equal(result.isError, true);
  assert.equal(body.status, "timeout");
  assert.equal(body.resumable, true);
  assert.match(body.result, /timed out/);
  assert.match(body.evidence_summary ?? "", /Hello World/);
  assert.equal(result.progress?.at(-1)?.phase, "failed");
  assert.equal(result.progress?.at(-1)?.detail?.status, "timeout");
  assert.equal(result.progress?.at(-1)?.detail?.evidence_available, true);
});

test("sessions_spawn keeps timeout result when worker returns completed after timeout interrupt", async () => {
  let sendStarted!: () => void;
  let releaseCompleted!: () => void;
  let interruptedReason: string | null = null;
  const sendStartedPromise = new Promise<void>((resolve) => {
    sendStarted = resolve;
  });
  const releaseCompletedPromise = new Promise<void>((resolve) => {
    releaseCompleted = resolve;
  });
  const workerRuntime = {
    async spawn() {
      return { workerType: "explore", workerRunKey: "worker:explore:late-complete" };
    },
    async send() {
      sendStarted();
      await releaseCompletedPromise;
      return {
        workerType: "explore",
        status: "completed",
        summary: "Source finished after parent timeout.",
        payload: { content: "Late complete evidence." },
      };
    },
    async interrupt(input: { reason?: string; preserveLateResult?: boolean }) {
      interruptedReason = input.reason ?? null;
      assert.equal(input.preserveLateResult, true);
      releaseCompleted();
      return {
        workerRunKey: "worker:explore:late-complete",
        workerType: "explore",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
        continuationDigest: {
          reason: "timeout_summary",
          summary: "Parent timeout boundary was reached before completion.",
          createdAt: 2,
        },
      };
    },
    async resume() {
      return null;
    },
    async getState() {
      return {
        workerRunKey: "worker:explore:late-complete",
        workerType: "explore",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
        lastResult: {
          workerType: "explore",
          status: "completed",
          summary: "Source finished after parent timeout.",
          payload: { content: "Late complete evidence." },
        },
        continuationDigest: {
          reason: "timeout_summary",
          summary: "Parent timeout boundary was reached before completion.",
          createdAt: 2,
        },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
    hardTimeoutGraceMs: 50,
  });

  const executePromise = executor.execute({
    call: {
      id: "call-late-complete-timeout",
      name: "sessions_spawn",
      input: {
        agent_id: "explore",
        task: "Read a slow source.",
        timeout_seconds: 0.001,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Read a slow source.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  await sendStartedPromise;
  const result = await executePromise;
  const body = JSON.parse(result.content) as {
    status: string;
    resumable: boolean;
    evidence_available: boolean;
    evidence_summary: string;
  };
  assert.match(interruptedReason ?? "", /sessions_spawn timed out/);
  assert.equal(result.isError, true);
  assert.equal(body.status, "timeout");
  assert.equal(body.resumable, true);
  assert.equal(body.evidence_available, true);
  assert.match(body.evidence_summary, /Source finished after parent timeout|Parent timeout boundary/);
});

test("sessions_send treats tool-loop wall-clock abort as resumable timeout", async () => {
  let resumeStarted!: () => void;
  let interruptedReason: string | null = null;
  const resumeStartedPromise = new Promise<void>((resolve) => {
    resumeStarted = resolve;
  });
  const controller = new AbortController();
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:slow-followup",
          workerType: "explore",
          context: {
            threadId: "thread-1",
            label: "slow follow-up",
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:explore:slow-followup",
        workerType: "explore",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
        continuationDigest: {
          reason: "timeout_summary",
          summary: "Verified the release page title before the active tool budget expired.",
          createdAt: 2,
        },
      };
    },
    async resume() {
      resumeStarted();
      await new Promise(() => undefined);
      return null;
    },
    async interrupt(input: { reason?: string }) {
      interruptedReason = input.reason ?? null;
      return {
        workerRunKey: "worker:explore:slow-followup",
        workerType: "explore",
        status: "resumable",
        createdAt: 1,
        updatedAt: 3,
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
    maxSessionToolTimeoutMs: 480_000,
    hardTimeoutGraceMs: 1,
  });

  const executePromise = executor.execute({
    call: {
      id: "call-wall-clock-abort",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:slow-followup",
        message: "Continue the slow source check.",
        timeout_seconds: 150,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue the slow source.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
    signal: controller.signal,
  });

  await resumeStartedPromise;
  controller.abort("Tool-use wall-clock budget reached (2m).");
  const result = await executePromise;
  const body = JSON.parse(result.content) as {
    status: string;
    timeout_seconds: number;
    evidence_available: boolean;
    evidence_summary: string;
  };
  assert.match(interruptedReason ?? "", /Tool-use wall-clock budget reached/);
  assert.equal(result.isError, true);
  assert.equal(body.status, "timeout");
  assert.equal(body.timeout_seconds, 45);
  assert.equal(body.evidence_available, true);
  assert.match(body.evidence_summary, /release page title/);
});

test("sessions_send caps running follow-up timeout to the foreground continuation budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resumeStarted!: () => void;
  let interrupted = false;
  const resumeStartedPromise = new Promise<void>((resolve) => {
    resumeStarted = resolve;
  });
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:running-followup",
          workerType: "explore",
          context: { threadId: "thread-1" },
          createdAt: 1,
          updatedAt: 2,
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:explore:running-followup",
        workerType: "explore",
        status: interrupted ? "resumable" : "running",
        createdAt: 1,
        updatedAt: interrupted ? 3 : 2,
        ...(interrupted
          ? {
              continuationDigest: {
                reason: "timeout_summary",
                summary: "Collected partial follow-up evidence before timeout.",
                createdAt: 3,
              },
            }
          : {}),
      };
    },
    async resume() {
      resumeStarted();
      await new Promise(() => undefined);
      return null;
    },
    async interrupt() {
      interrupted = true;
      return {
        workerRunKey: "worker:explore:running-followup",
        workerType: "explore",
        status: "resumable",
        createdAt: 1,
        updatedAt: 3,
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
    maxSessionToolTimeoutMs: 480_000,
    hardTimeoutGraceMs: 0,
  });

  const executePromise = executor.execute({
    call: {
      id: "call-running-followup-cap",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:running-followup",
        message: "Continue the slow source check.",
        timeout_seconds: 150,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue the slow source.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  await resumeStartedPromise;
  t.mock.timers.tick(45_000);
  await Promise.resolve();
  t.mock.timers.tick(0);
  await Promise.resolve();
  const result = await executePromise;
  const body = JSON.parse(result.content) as {
    status: string;
    timeout_seconds: number;
    evidence_summary: string;
  };
  assert.equal(interrupted, true);
  assert.equal(result.isError, true);
  assert.equal(body.status, "timeout");
  assert.equal(body.timeout_seconds, 45);
  assert.match(body.evidence_summary, /partial follow-up evidence/);
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

test("sessions_spawn caps browser default timeout when timeout_seconds is absent", async () => {
  let interruptedReason: string | null = null;
  const workerRuntime = {
    async spawn() {
      return { workerType: "browser", workerRunKey: "worker:browser:default-product-timeout" };
    },
    async send() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        workerType: "browser",
        status: "completed",
        summary: "Dynamic browser evidence completed.",
      };
    },
    async interrupt(input: { reason?: string }) {
      interruptedReason = input.reason ?? null;
      return {
        workerRunKey: "worker:browser:default-product-timeout",
        workerType: "browser",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    maxSessionToolTimeoutMs: 1,
    hardTimeoutGraceMs: 1,
  });

  const result = await executor.execute({
    call: {
      id: "call-browser-default-product-timeout",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: "Open https://the-internet.herokuapp.com/dynamic_loading/1, click Start, wait for Hello World, and take a screenshot.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Use browser-rendered evidence.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string; timeout_seconds: number };
  assert.equal(result.isError, true);
  assert.equal(body.status, "timeout");
  assert.equal(body.timeout_seconds, 0.001);
  assert.match(interruptedReason ?? "", /sessions_spawn timed out/);
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

test("sessions_spawn keeps the timeout boundary even when the active worker finishes during grace", async () => {
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
      return {
        workerRunKey: "worker:explore:slow-success",
        workerType: "explore",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
        continuationDigest: {
          reason: "timeout_summary",
          summary: "Soft timeout reached before the worker result was accepted.",
          createdAt: 2,
        },
      };
    },
    async resume() {
      return null;
    },
    async getState() {
      return {
        workerRunKey: "worker:explore:slow-success",
        workerType: "explore",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
        continuationDigest: {
          reason: "timeout_summary",
          summary: "Soft timeout reached before the worker result was accepted.",
          createdAt: 2,
        },
      };
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

  const body = JSON.parse(result.content) as { status: string; resumable: boolean; result: string };
  assert.equal(interruptCalled, true);
  assert.equal(result.isError, true);
  assert.equal(body.status, "timeout");
  assert.equal(body.resumable, true);
  assert.match(body.result, /timed out/);
});

test("sessions_spawn runs one no-tools timeout summary continuation for LLM sub-agent sessions", async () => {
  let sendCount = 0;
  const summaryPackets: RolePromptPacket[] = [];
  let state: WorkerSessionState = {
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
      const result = {
        workerType: "explore",
        status: "partial",
        summary: "Evidence-only summary after timeout.",
        payload: {
          mode: "llm_sub_agent",
          workerType: "explore",
          content: "Verified source A before timeout; source B not verified.",
        },
      } as const;
      state = {
        ...state,
        status: "resumable",
        updatedAt: 3,
        lastResult: result,
        history: [
          ...(state.history ?? []),
          {
            id: "history-timeout-summary",
            role: "assistant",
            content: "Evidence-only summary after timeout.",
            createdAt: 3,
            metadata: { kind: "assistant_final" },
          },
        ],
        continuationDigest: {
          reason: "timeout_summary",
          summary: result.summary,
          createdAt: 3,
        },
      };
      return result;
    },
    async interrupt() {
      state = {
        ...state,
        status: "resumable",
        updatedAt: 2,
        lastError: {
          code: "WORKER_TIMEOUT",
          message: "sessions_spawn timed out after 0.001s.",
          retryable: true,
        },
      };
      return {
        workerRunKey: "worker:explore:timeout-summary",
        workerType: "explore",
        status: "resumable",
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async getState() {
      return state;
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

  const body = JSON.parse(result.content) as {
    status: string;
    result: string;
    evidence_summary: string;
    resumable: boolean;
  };
  assert.equal(sendCount, 2);
  assert.equal(summaryPackets[0]?.toolUseMode, "disabled");
  assert.match(summaryPackets[0]?.taskPrompt ?? "", /Do not call tools/);
  assert.equal(result.isError, true);
  assert.equal(body.status, "timeout");
  assert.equal(body.resumable, true);
  assert.match(body.result, /Sub-agent session timed out/);
  assert.match(body.evidence_summary, /Verified source A before timeout/);
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

test("sessions_send resolves unique ellipsized session_key against same-thread sessions", async () => {
  let resumedKey: string | null = null;
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:task:TASK-1:call_function_pvrs7la5ao2m_1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:explore:task:TASK-1:call_function_pvrs7la5ao2m_1",
            workerType: "explore",
            status: "cancelled",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ];
    },
    async getState(workerRunKey: string) {
      assert.equal(workerRunKey, "worker:explore:task:TASK-1:call_function_pvrs7la5ao2m_1");
      return {
        workerRunKey,
        workerType: "explore" as const,
        status: "cancelled" as const,
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async resume(input: { workerRunKey: string }) {
      resumedKey = input.workerRunKey;
      return {
        workerType: "explore" as const,
        status: "completed" as const,
        summary: "Continuation evidence gathered.",
        payload: { mode: "llm_sub_agent", workerType: "explore", content: "Verified continuation evidence." },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  const result = await executor.execute({
    call: {
      id: "call-follow-up",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:task:TASK-1:call_func…",
        message: "Continue the existing research task with fresh evidence.",
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

  const body = JSON.parse(result.content) as { session_key: string; final_content: string };
  assert.equal(result.isError, undefined);
  assert.equal(resumedKey, "worker:explore:task:TASK-1:call_function_pvrs7la5ao2m_1");
  assert.equal(body.session_key, "worker:explore:task:TASK-1:call_function_pvrs7la5ao2m_1");
  assert.equal(body.final_content, "Verified continuation evidence.");
});

test("sessions_send resolves a unique clean truncated session_key prefix against same-thread sessions", async () => {
  let resumedKey: string | null = null;
  const fullSessionKey = "worker:explore:task:TASK-1780270698619-6:call_function_bk9x7m4q2p_1";
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: fullSessionKey,
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: fullSessionKey,
            workerType: "explore",
            status: "cancelled",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ];
    },
    async getState(workerRunKey: string) {
      assert.equal(workerRunKey, fullSessionKey);
      return {
        workerRunKey,
        workerType: "explore" as const,
        status: "cancelled" as const,
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async resume(input: { workerRunKey: string }) {
      resumedKey = input.workerRunKey;
      return {
        workerType: "explore" as const,
        status: "completed" as const,
        summary: "Continuation evidence gathered.",
        payload: { mode: "llm_sub_agent", workerType: "explore", content: "Verified continuation evidence." },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  const result = await executor.execute({
    call: {
      id: "call-follow-up",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:task:TASK-1780270698619-6:call_function_bk",
        message: "Continue the existing research task with fresh evidence.",
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

  const body = JSON.parse(result.content) as { session_key: string; final_content: string };
  assert.equal(result.isError, undefined);
  assert.equal(resumedKey, fullSessionKey);
  assert.equal(body.session_key, fullSessionKey);
  assert.equal(body.final_content, "Verified continuation evidence.");
});

test("sessions_send resolves a unique same-task session_key with a corrupted tool-call suffix", async () => {
  let resumedKey: string | null = null;
  const fullSessionKey = "worker:explore:task:TASK-1780271315378-107:call_function_tjy4fgvtsps9_1";
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: fullSessionKey,
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "TASK-1780271315378-107",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: fullSessionKey,
            workerType: "explore",
            status: "cancelled",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ];
    },
    async getState(workerRunKey: string) {
      assert.equal(workerRunKey, fullSessionKey);
      return {
        workerRunKey,
        workerType: "explore" as const,
        status: "cancelled" as const,
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async resume(input: { workerRunKey: string }) {
      resumedKey = input.workerRunKey;
      return {
        workerType: "explore" as const,
        status: "completed" as const,
        summary: "Continuation evidence gathered.",
        payload: { mode: "llm_sub_agent", workerType: "explore", content: "Verified continuation evidence." },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  const result = await executor.execute({
    call: {
      id: "call-follow-up",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:task:TASK-1780271315378-107:call_function_sessions_spawn_1780271315380_107",
        message: "Continue the existing research task with fresh evidence.",
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

  const body = JSON.parse(result.content) as { session_key: string; final_content: string };
  assert.equal(result.isError, undefined);
  assert.equal(resumedKey, fullSessionKey);
  assert.equal(body.session_key, fullSessionKey);
  assert.equal(body.final_content, "Verified continuation evidence.");
});

test("sessions_send resolves a malformed continuation key when one same-thread session exists", async () => {
  let resumedKey: string | null = null;
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:task:TASK-1:call_function_lvrrnmdym6lp_1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:explore:task:TASK-1:call_function_lvrrnmdym6lp_1",
            workerType: "explore",
            status: "cancelled",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ];
    },
    async getState(workerRunKey: string) {
      return {
        workerRunKey,
        workerType: "explore" as const,
        status: "cancelled" as const,
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async resume(input: { workerRunKey: string }) {
      resumedKey = input.workerRunKey;
      return {
        workerType: "explore" as const,
        status: "completed" as const,
        summary: "Continuation evidence gathered.",
        payload: { mode: "llm_sub_agent", workerType: "explore", content: "Verified continuation evidence." },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  const result = await executor.execute({
    call: {
      id: "call-follow-up",
      name: "sessions_send",
      input: {
        session_key: "work… | Natural cancellation follow-up continuation",
        message: "Continue the existing research task with fresh evidence.",
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

  const body = JSON.parse(result.content) as { session_key: string };
  assert.equal(result.isError, undefined);
  assert.equal(resumedKey, "worker:explore:task:TASK-1:call_function_lvrrnmdym6lp_1");
  assert.equal(body.session_key, "worker:explore:task:TASK-1:call_function_lvrrnmdym6lp_1");
});

test("sessions_send does not resolve an unrelated clean session_key to the only same-thread session", async () => {
  let resumeCalled = false;
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:task:TASK-1:call_function_lvrrnmdym6lp_1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:explore:task:TASK-1:call_function_lvrrnmdym6lp_1",
            workerType: "explore",
            status: "cancelled",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ];
    },
    async getState() {
      assert.fail("getState should not be called for an unrelated clean key");
    },
    async resume() {
      resumeCalled = true;
      assert.fail("resume should not be called for an unrelated clean key");
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  const result = await executor.execute({
    call: {
      id: "call-follow-up",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:task:TASK-2:call_abc123_1",
        message: "Continue the existing research task with fresh evidence.",
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

  assert.equal(result.isError, true);
  assert.equal(result.content, "session not found: worker:explore:task:TASK-2:call_abc123_1");
  assert.equal(resumeCalled, false);
});

test("sessions_send does not resolve an ambiguous clean truncated session_key prefix", async () => {
  let resumeCalled = false;
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:explore:task:TASK-1780270698619-6:call_function_bk111111_1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous-a",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:explore:task:TASK-1780270698619-6:call_function_bk111111_1",
            workerType: "explore",
            status: "cancelled",
            createdAt: 1,
            updatedAt: 2,
          },
        },
        {
          workerRunKey: "worker:explore:task:TASK-1780270698619-6:call_function_bk222222_1",
          executionToken: 2,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous-b",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:explore:task:TASK-1780270698619-6:call_function_bk222222_1",
            workerType: "explore",
            status: "cancelled",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ];
    },
    async getState() {
      assert.fail("getState should not be called for an ambiguous clean prefix");
    },
    async resume() {
      resumeCalled = true;
      assert.fail("resume should not be called for an ambiguous clean prefix");
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  const result = await executor.execute({
    call: {
      id: "call-follow-up",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:task:TASK-1780270698619-6:call_function_bk",
        message: "Continue the existing research task with fresh evidence.",
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

  assert.equal(result.isError, true);
  assert.equal(result.content, "session not found: worker:explore:task:TASK-1780270698619-6:call_function_bk");
  assert.equal(resumeCalled, false);
});

test("sessions_send does not treat legacy clean session keys as malformed continuation keys", async () => {
  let resumeCalled = false;
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:task:TASK-1:call_function_lvrrnmdym6lp_1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:browser:task:TASK-1:call_function_lvrrnmdym6lp_1",
            workerType: "browser",
            status: "cancelled",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ];
    },
    async getState() {
      assert.fail("getState should not be called for a missing legacy clean key");
    },
    async resume() {
      resumeCalled = true;
      assert.fail("resume should not be called for a missing legacy clean key");
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["browser"] });

  const result = await executor.execute({
    call: {
      id: "call-follow-up",
      name: "sessions_send",
      input: {
        session_key: "worker:browser:existing",
        message: "Continue the existing browser session.",
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

  assert.equal(result.isError, true);
  assert.equal(result.content, "session not found: worker:browser:existing");
  assert.equal(resumeCalled, false);
});

test("sessions_send carries approved browser context into resumed sessions", async () => {
  let resumedTaskPrompt = "";
  let approvedRuntimeAction = "";
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:existing",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-browser",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
            parentSessionKey: "role:role-lead:thread:thread-1",
            toolCallId: "call-original",
          },
          state: {
            workerRunKey: "worker:browser:existing",
            workerType: "browser",
            status: "done",
            createdAt: 1,
            updatedAt: 2,
            lastResult: { workerType: "browser", status: "completed", summary: "Existing browser work.", payload: null },
          },
        },
      ];
    },
    async getState() {
      return {
        workerRunKey: "worker:browser:existing",
        workerType: "browser",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async resume(input: { packet: { taskPrompt: string; runtimeApprovalContext?: { browserSideEffects?: Array<{ action: string }> } } }) {
      resumedTaskPrompt = input.packet.taskPrompt;
      approvedRuntimeAction = input.packet.runtimeApprovalContext?.browserSideEffects?.[0]?.action ?? "";
      return {
        workerType: "browser",
        status: "completed",
        summary: "Submitted resumed browser action.",
        payload: { submitted: true },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["browser"],
    toolPermissionService: {
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
    },
  });

  const result = await executor.execute({
    call: {
      id: "call-send-approved",
      name: "sessions_send",
      input: {
        session_key: "worker:browser:existing",
        message: "Submit the approved follow-up form.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue browser work.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(result.isError, undefined);
  assert.match(result.content, /Submitted resumed browser action/);
  assert.match(resumedTaskPrompt, /parent runtime approval is granted/i);
  assert.match(resumedTaskPrompt, /permission cache is already applied/i);
  assert.equal(approvedRuntimeAction, "browser.form.submit");
});

test("sessions_send does not reuse completed browser submit results before approval", async () => {
  let resumeCalled = false;
  const lastResult = {
    workerType: "browser" as const,
    status: "completed" as const,
    summary:
      "The approved browser.form.submit action was executed via browser_act with submit=true and the post-submit page was verified.",
    payload: {
      mode: "llm_sub_agent",
      workerType: "browser",
      content: "Dry-run submitted locally after approval; no external mutation was performed.",
    },
  };
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:submitted",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-browser",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
            parentSessionKey: "role:role-lead:thread:thread-1",
            toolCallId: "call-original",
          },
          state: {
            workerRunKey: "worker:browser:submitted",
            workerType: "browser",
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
        workerRunKey: "worker:browser:submitted",
        workerType: "browser",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
        lastResult,
      };
    },
    async resume() {
      resumeCalled = true;
      throw new Error("browser side effect must not resume before approval");
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["browser"] });

  const result = await executor.execute({
    call: {
      id: "call-repeat-submit",
      name: "sessions_send",
      input: {
        session_key: "worker:browser:submitted",
        message:
          "The runtime approval is already applied. Continue with the approved browser.form.submit action and submit the dry-run form.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Complete the local approval dry-run action.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(resumeCalled, false);
  assert.equal(result.isError, true);
  assert.match(result.content, /Permission approval is required/i);
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

test("sessions_send resolves a task-only session key prefix when one visible session matches", async () => {
  const fullSessionKey = "worker:explore:task:TASK-1780322295338-120:call_function_abc123_1";
  const lastResult = {
    workerType: "explore" as const,
    status: "completed" as const,
    summary: "Research completed.",
    payload: {
      mode: "llm_sub_agent",
      workerType: "explore",
      content: "Full cached final report from the existing child session.",
    },
  };
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: fullSessionKey,
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-previous",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: fullSessionKey,
            workerType: "explore",
            status: "done",
            createdAt: 1,
            updatedAt: 2,
            lastResult,
          },
        },
      ];
    },
    async getState(workerRunKey: string) {
      assert.equal(workerRunKey, fullSessionKey);
      return {
        workerRunKey: fullSessionKey,
        workerType: "explore",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
        lastResult,
      };
    },
    async send() {
      throw new Error("summary-only continuation should reuse cached result");
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["explore"] });

  const result = await executor.execute({
    call: {
      id: "call-task-prefix-summary",
      name: "sessions_send",
      input: {
        session_key: "worker:explore:task:TASK-1780322295338-120",
        message: "Please return your complete final report from the existing child session.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue from the existing child session.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { session_key: string; final_content?: string };
  assert.equal(result.isError, undefined);
  assert.equal(body.session_key, fullSessionKey);
  assert.equal(body.final_content, "Full cached final report from the existing child session.");
  assert.equal(result.progress?.at(-1)?.detail?.session_key, fullSessionKey);
});

test("sessions_send resolves a browser session id to its owning worker session", async () => {
  const fullSessionKey = "worker:browser:task:TASK-1780334683757-6:call_function_browser_1";
  const browserSessionId = "browser-session-1780334689255";
  let sendWorkerRunKey = "";
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: fullSessionKey,
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-browser",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: fullSessionKey,
            workerType: "browser",
            status: "done",
            createdAt: 1,
            updatedAt: 2,
            lastResult: {
              workerType: "browser",
              status: "completed",
              summary: "Browser dashboard reviewed.",
              payload: { sessionId: browserSessionId, targetId: "target-1" },
            },
          },
        },
      ];
    },
    async getState(workerRunKey: string) {
      assert.equal(workerRunKey, fullSessionKey);
      return {
        workerRunKey: fullSessionKey,
        workerType: "browser",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
        lastResult: {
          workerType: "browser",
          status: "completed",
          summary: "Browser dashboard reviewed.",
          payload: { sessionId: browserSessionId, targetId: "target-1" },
        },
      };
    },
    async resume(input: WorkerMessageInput) {
      sendWorkerRunKey = input.workerRunKey;
      return {
        workerType: "browser",
        status: "completed",
        summary: "Re-checked rendered dashboard state.",
        payload: { sessionId: browserSessionId, targetId: "target-1" },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["browser"] });

  const result = await executor.execute({
    call: {
      id: "call-browser-session-id",
      name: "sessions_send",
      input: {
        session_key: browserSessionId,
        message: "Re-check the rendered dashboard state from the same browser context.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue browser work.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { session_key: string; final_content?: string };
  assert.equal(result.isError, undefined);
  assert.equal(sendWorkerRunKey, fullSessionKey);
  assert.equal(body.session_key, fullSessionKey);
  assert.match(result.content, /Re-checked rendered dashboard state/);
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
  let requestedCacheKey = "";
  let requestedWorkerType = "";
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    toolPermissionService: {
      async request(input) {
        calls.push(`request:${input.action}`);
        requestedCacheKey = input.requirement.cacheKey ?? "";
        requestedWorkerType = input.requirement.workerType ?? "";
        return {
          status: "pending",
          approvalId: "ap.thread-1.call-permission",
          missionId: "msn.1",
          action: input.action,
          requirement: {
            level: input.requirement.level,
            scope: input.requirement.scope,
            cacheKey: input.requirement.cacheKey ?? "missing",
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
        worker_kind: "explore",
      },
    },
    activation,
    packet,
  });
  assert.equal(query.isError, undefined);
  assert.equal(requestedCacheKey, "thread-1:browser:mutate:approval:browser.form.submit");
  assert.equal(requestedWorkerType, "browser");
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

test("permission_query rejects browser mutation approvals during read-only source work", async () => {
  let permissionRequested = false;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    toolPermissionService: {
      async request() {
        permissionRequested = true;
        throw new Error("read-only source work must not create an approval");
      },
      async result() {
        throw new Error("permission_result should not be called");
      },
      async apply() {
        throw new Error("permission_applied should not be called");
      },
    },
  });

  const result = await executor.execute({
    call: {
      id: "call-readonly-permission",
      name: "permission_query",
      input: {
        action: "browser.form.submit",
        title: "Submit isolated local form",
        risk: "Applies an approval-gated browser form submission in an isolated local dry-run page.",
        level: "approval",
        scope: "mutate",
        rationale: "The runtime should not accept this for source-bounded review work.",
        worker_kind: "browser",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt:
        "Continue a source-bounded Vendor Alpha review. Revisit the existing notes and turn the evidence into a decision note for a product lead.",
      outputContract: "Return source-backed pricing, strength, risk, and remaining uncertainty.",
      suggestedMentions: [],
    },
  });

  assert.equal(permissionRequested, false);
  assert.equal(result.isError, true);
  assert.match(result.content, /read-only\/source-bounded/i);
  assert.equal(result.progress?.at(-1)?.phase, "failed");
});

test("permission_query rejects approvals negated by read-only planning instructions", async () => {
  let permissionRequested = false;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    toolPermissionService: {
      async request() {
        permissionRequested = true;
        throw new Error("read-only planning must not create an approval");
      },
      async result() {
        throw new Error("permission_result should not be called");
      },
      async apply() {
        throw new Error("permission_applied should not be called");
      },
    },
  });

  const result = await executor.execute({
    call: {
      id: "call-asiawalk-approval",
      name: "permission_query",
      input: {
        action: "browser.form.submit",
        title: "Commit pilot deposit",
        risk: "Would simulate committing deposits for the AsiaWalk pilot.",
        level: "approval",
        scope: "mutate",
        rationale: "The model should not ask this during a read-only planning brief.",
        worker_kind: "browser",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: [
        "Prepare a decision-ready AsiaWalk pilot brief.",
        "Treat route, budget, and live readiness as separate evidence streams.",
        "This is a read-only planning brief. Do not click forms, submit anything, simulate deposits, or request approval; only inspect the listed sources and synthesize a recommendation.",
      ].join("\n"),
      outputContract: "Return route, budget, rendered readiness, recommendation, next action, and residual risk.",
      suggestedMentions: [],
    },
  });

  assert.equal(permissionRequested, false);
  assert.equal(result.isError, true);
  assert.match(result.content, /read-only\/source-bounded/i);
});

test("permission_query rejects source research approvals even when recent messages mention a mistaken approval", async () => {
  let permissionRequested = false;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    toolPermissionService: {
      async request() {
        permissionRequested = true;
        throw new Error("source research must not enter approval flow");
      },
      async result() {
        throw new Error("permission_result should not be called");
      },
      async apply() {
        throw new Error("permission_applied should not be called");
      },
    },
  });
  const activation = buildActivation();
  activation.handoff.payload = {
    ...activation.handoff.payload,
    intent: {
      relayBrief: "DeepSeek provider pricing research.",
      recentMessages: [
        {
          messageId: "msg-mistaken-approval",
          role: "assistant",
          name: "Lead",
          content:
            "Mistaken draft: permission_query for browser.form.submit may be needed for an approval-gated dry-run page.",
          createdAt: 2,
        },
      ],
    },
  };

  const result = await executor.execute({
    call: {
      id: "call-provider-wrong-approval",
      name: "permission_query",
      input: {
        action: "browser.form.submit",
        title: "Submit isolated local form",
        risk: "Applies an approval-gated browser form submission in an isolated local dry-run page.",
        level: "approval",
        scope: "mutate",
        rationale: "This approval is unrelated to provider pricing research.",
        worker_kind: "browser",
      },
    },
    activation,
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt:
        "Lead. General tool policy: browser.form.submit requires approval for real browser mutations.",
      taskPrompt:
        "A product manager needs a source-backed DeepSeek V4 Flash API provider note. Identify provider support, search support, input pricing, output pricing, and production decision risk from the listed source.",
      outputContract: "Use only evidence collected during this mission; return provider support, search support, pricing, recommendation, and residual risk.",
      suggestedMentions: [],
    },
  });

  assert.equal(permissionRequested, false);
  assert.equal(result.isError, true);
  assert.match(result.content, /read-only\/source-bounded/i);
});

test("permission_query rejects release-risk source approvals when approval is only a business risk", async () => {
  let permissionRequested = false;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime: {} as WorkerRuntime,
    toolPermissionService: {
      async request() {
        permissionRequested = true;
        throw new Error("release-risk source work must not create a browser approval");
      },
      async result() {
        throw new Error("permission_result should not be called");
      },
      async apply() {
        throw new Error("permission_applied should not be called");
      },
    },
  });

  const result = await executor.execute({
    call: {
      id: "call-release-risk-wrong-approval",
      name: "permission_query",
      input: {
        action: "browser.form.submit",
        title: "Approve local dry-run browser form submission",
        risk: "Applies an approval-gated browser form submission in an isolated local dry-run page.",
        level: "approval",
        scope: "mutate",
        rationale: "This approval is unrelated to the release-risk source check.",
        worker_kind: "browser",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt:
        "Evaluate this slow source for a release-risk note. Use a bounded source-check, separate verified facts from unverified items, and assess the runbook gap before launch approval.",
      outputContract:
        "Return source status, owner, risk, mitigation, residual risk, and how to continue after timeout if needed.",
      suggestedMentions: [],
    },
  });

  assert.equal(permissionRequested, false);
  assert.equal(result.isError, true);
  assert.match(result.content, /read-only\/source-bounded/i);
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
    inspection_guidance: string;
  };
  assert.deepEqual(body.sessions.map((session) => session.session_key), ["worker:browser:recent"]);
  assert.equal(body.sessions[0]?.label, "Live browser check");
  assert.equal(body.sessions[0]?.parent_session_key, "role:role-lead:thread:thread-1");
  assert.equal(body.sessions[0]?.tool_call_id, "call-browser");
  assert.equal(body.sessions[0]?.message_count, 1);
  assert.match(body.inspection_guidance, /Do not call sessions_list repeatedly/);
  assert.match(body.inspection_guidance, /sessions_history or continue it with sessions_send/);
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
    inspection_guidance: string;
    messages: Array<{ id: string; content: string }>;
  };
  assert.equal(body.tail, true);
  assert.equal(body.offset, 2);
  assert.equal(body.has_more, false);
  assert.deepEqual(body.messages.map((message) => message.id), ["history-3"]);
  assert.equal(body.messages[0]?.content, "Final evidence ledger.");
  assert.match(body.inspection_guidance, /no later transcript entries/);
  assert.match(body.inspection_guidance, /otherwise synthesize from this history/);

  const completeResult = await executor.execute({
    call: {
      id: "call-tail-complete",
      name: "sessions_history",
      input: {
        session_key: "worker:explore:tail",
        limit: 5,
        tail: true,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Read complete tail history.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });
  const completeBody = JSON.parse(completeResult.content) as {
    has_more_before: boolean;
    inspection_guidance: string;
  };
  assert.equal(completeBody.has_more_before, false);
  assert.match(completeBody.inspection_guidance, /complete available transcript/);
  assert.match(completeBody.inspection_guidance, /Do not call sessions_history or sessions_list again/);
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

test("sessions_history resolves a unique truncated session_key against same-thread sessions", async () => {
  const fullSessionKey = "worker:browser:task:TASK-1780419742666-2414:call_function_51fzkl5zklts_1";
  let readStateKey: string | null = null;
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: fullSessionKey,
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "TASK-1780419742666-2414",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: fullSessionKey,
            workerType: "browser",
            status: "cancelled",
            createdAt: 90,
            updatedAt: 140,
          },
        },
        {
          workerRunKey: "worker:browser:task:TASK-1780419742666-2414:call_function_foreign_1",
          executionToken: 2,
          context: {
            threadId: "thread-foreign",
            flowId: "flow-foreign",
            taskId: "TASK-1780419742666-2414",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-foreign",
          },
          state: {
            workerRunKey: "worker:browser:task:TASK-1780419742666-2414:call_function_foreign_1",
            workerType: "browser",
            status: "cancelled",
            createdAt: 90,
            updatedAt: 140,
          },
        },
      ];
    },
    async getState(workerRunKey: string) {
      readStateKey = workerRunKey;
      return {
        workerRunKey,
        workerType: "browser" as const,
        status: "cancelled" as const,
        createdAt: 90,
        updatedAt: 140,
        currentTaskId: "TASK-1780419742666-2414",
        history: [
          {
            id: "worker-history:slow-source:assistant-final",
            role: "assistant" as const,
            content: "Slow source timed out; resumable follow-up required.",
            createdAt: 140,
            metadata: { kind: "assistant_final" },
          },
        ],
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["browser"] });

  const result = await executor.execute({
    call: {
      id: "call-history-truncated",
      name: "sessions_history",
      input: {
        session_key: "worker:browser:task:TASK-1780419742666-2414:call_function_51fzk…",
        tail: true,
        limit: 10,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Read slow-source history.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { session_key: string; messages: Array<{ content: string }> };
  assert.equal(result.isError, undefined);
  assert.equal(readStateKey, fullSessionKey);
  assert.equal(body.session_key, fullSessionKey);
  assert.equal(body.messages[0]?.content, "Slow source timed out; resumable follow-up required.");
});

test("sessions_history does not resolve an ambiguous truncated session_key", async () => {
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:task:TASK-1:call_function_bk111111_1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "TASK-1",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:browser:task:TASK-1:call_function_bk111111_1",
            workerType: "browser",
            status: "cancelled",
            createdAt: 90,
            updatedAt: 140,
          },
        },
        {
          workerRunKey: "worker:browser:task:TASK-1:call_function_bk222222_1",
          executionToken: 2,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "TASK-1",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:browser:task:TASK-1:call_function_bk222222_1",
            workerType: "browser",
            status: "cancelled",
            createdAt: 90,
            updatedAt: 140,
          },
        },
      ];
    },
    async getState() {
      assert.fail("getState should not be called for an ambiguous history key");
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["browser"] });

  const result = await executor.execute({
    call: {
      id: "call-history-ambiguous",
      name: "sessions_history",
      input: {
        session_key: "worker:browser:task:TASK-1:call_function_bk",
        tail: true,
        limit: 10,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Read slow-source history.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.content, "session not found: worker:browser:task:TASK-1:call_function_bk");
});

test("sessions_history does not resolve a foreign malformed key to the only visible session", async () => {
  const workerRuntime = {
    async listSessions() {
      return [
        {
          workerRunKey: "worker:browser:task:TASK-local:call_function_local_1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "TASK-local",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:browser:task:TASK-local:call_function_local_1",
            workerType: "browser",
            status: "done",
            createdAt: 90,
            updatedAt: 140,
          },
        },
      ];
    },
    async getState() {
      assert.fail("getState should not be called for a foreign malformed history key");
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({ workerRuntime, availableWorkerKinds: ["browser"] });

  const result = await executor.execute({
    call: {
      id: "call-history-foreign-malformed",
      name: "sessions_history",
      input: {
        session_key: "work… | unrelated foreign continuation",
        tail: true,
        limit: 10,
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Read slow-source history.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.content, "session not found: work… | unrelated foreign continuation");
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

function buildPacket(): RolePromptPacket {
  return {
    roleId: "role-lead",
    roleName: "Lead",
    seat: "lead",
    systemPrompt: "Lead role.",
    taskPrompt: "Inspect history.",
    outputContract: "Return a concise answer.",
    suggestedMentions: [],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilForTest(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await sleep(2);
  }
  throw new Error("condition was not met");
}

test("sessions_list accepts snake_case filters matching its own output fields", async () => {
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
          },
          state: {
            workerRunKey: "worker:browser:recent",
            workerType: "browser",
            status: "done",
            createdAt: now - 60_000,
            updatedAt: now - 30_000,
          },
        },
        {
          workerRunKey: "worker:browser:stale",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-2",
            roleId: "role-lead",
            parentSpanId: "role:role:role-lead:thread:thread-1",
            parentSessionKey: "role:role-other:thread:thread-1",
          },
          state: {
            workerRunKey: "worker:browser:stale",
            workerType: "browser",
            status: "done",
            createdAt: now - 7_200_000,
            updatedAt: now - 7_200_000,
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
      // Models copy the snake_case field names straight out of a previous
      // sessions_list result; these must filter identically to camelCase.
      input: {
        agent_id: "browser",
        parent_session_key: "role:role-lead:thread:thread-1",
        active_minutes: 10,
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

test("sessions_spawn marks structured worker failures as error results", async () => {
  const workerRuntime = {
    async spawn() {
      return { workerType: "explore", workerRunKey: "worker:explore:failed-run" };
    },
    async send() {
      return {
        workerType: "explore",
        status: "failed",
        summary: "Worker crashed while fetching the source.",
        payload: { error: "fetch exploded" },
      };
    },
  } as unknown as WorkerRuntime;
  const executor = createWorkerSessionToolExecutor({
    workerRuntime,
    availableWorkerKinds: ["explore"],
  });

  const result = await executor.execute({
    call: {
      id: "call-failed-run",
      name: "sessions_spawn",
      input: {
        agent_id: "explore",
        task: "Fetch the source and extract facts.",
      },
    },
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Research the source.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  const body = JSON.parse(result.content) as { status: string };
  assert.equal(body.status, "failed");
  // Without isError the repeated-failure breaker never counts this run and
  // the persisted tool turn reads as a successful round.
  assert.equal(result.isError, true);
  assert.equal(result.progress?.at(-1)?.phase, "failed");
});
