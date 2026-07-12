import type { LLMMessage, LLMToolCall, LLMToolDefinition } from "@turnkeyai/llm-adapter/index";
import type { NativeToolRoundTrace } from "./native-tool-messages";
import {
  MAX_BROWSER_OPEN_TIMEOUT_MS,
  getInstructions,
  getRecentMessages,
  getRelayBrief,
} from "@turnkeyai/core-types/team";
import type {
  RoleActivationInput,
  BrowserSideEffectApprovalContext,
  RuntimeProgressRecorder,
  WorkerExecutionResult,
  WorkerSessionState,
  WorkerSessionRecord,
  WorkerKind,
  WorkerRuntime,
} from "@turnkeyai/core-types/team";
import { decodeBrowserSessionPayload } from "@turnkeyai/core-types/browser-session-payload";
import type { Tool, ToolContext, ToolProgressEvent, ToolResult } from "@turnkeyai/agent-core/tool";
import { createToolkit } from "@turnkeyai/agent-core/toolkit";
import {
  appendAssistantToolCallMessage,
  appendToolResultMessages,
} from "@turnkeyai/agent-core/tool-messages";

import type { RolePromptPacket } from "./prompt-policy";
import {
  buildArtifactToolDefinitions,
  buildMemoryToolDefinitions,
  buildPermissionToolDefinitions,
  buildSessionToolDefinitions,
  buildTaskToolDefinitions,
  buildWebToolDefinitions,
  createNativeToolCapabilityRegistry,
  type ToolCapabilityRegistry,
} from "./tool-capability-registry";
import type { ToolResultArtifactStore } from "./tool-result-artifact-store";
import type { MemoryHit, RoleMemoryResolver } from "./context/role-memory-resolver";
import type { TaskToolService } from "./task-tool-service";
import {
  buildBackgroundWorkerSessionAccepted,
  serializeBackgroundWorkerSessionAccepted,
} from "./background-worker-session";
import type { ToolCancellationRegistration, ToolCancellationRegistry } from "./tool-cancellation-registry";
import type {
  ToolPermissionAppliedResult,
  ToolPermissionDecisionResult,
  ToolPermissionQueryResult,
  ToolPermissionService,
} from "./tool-permission-service";
import {
  buildSessionToolCancelledResult,
  buildSessionToolResult,
  buildSessionToolTimeoutResult,
  extractWorkerEvidenceSummary,
  serializeSessionToolResult,
  sanitizeEvidenceSummary,
} from "./session-tool-result-protocol";
import {
  countWorkerSessionTranscriptMessages,
  readWorkerSessionTranscript,
  serializeWorkerHistoryEntry,
  summarizeWorkerSessionEvidence,
} from "./worker-session-transcript";
import {
  buildToolCallLimitExceededResult,
  createToolExecutionSignal,
  isAbortError,
  resolveEffectiveToolLoopWallClockMs,
  throwIfAborted,
  toNativeToolProgressTrace,
  toNativeToolResultTrace,
} from "./tool-protocol";
import { shouldSerializeToolBatch } from "./react/predicates";

export interface RoleToolExecutionInput {
  call: LLMToolCall;
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  signal?: AbortSignal;
  deadlineAt?: number;
}

// Structural aliases of the reusable agent-core tool types. The field shapes
// are identical, so the existing public names keep working for downstream
// importers while the canonical definitions now live in @turnkeyai/agent-core.
export type RoleToolExecutionResult = ToolResult;
export type RoleToolProgressEvent = ToolProgressEvent;

/**
 * Role-aware per-call tool context. Carries the TurnkeyAI activation/packet
 * that native tool executors read. agent-core never inspects this — it only
 * flows it back to the tools through the generic `Ctx` type parameter.
 */
export interface RoleToolContext extends ToolContext {
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  /** Stage 6: the per-run repair-idempotency ledger (injected repair prompts).
   *  The engine path sets it so `onRepairRound` can guard `shouldRepair*` across
   *  re-synthesis rounds; absent on contexts that never repair. */
  repairMarkers?: LLMMessage[];
  deadlineAt?: number;
}

export interface RoleToolExecutor {
  definitions(): LLMToolDefinition[];
  execute(input: RoleToolExecutionInput): Promise<RoleToolExecutionResult>;
  /** Read-only lookup by the stable tool-call/effect id. It must never dispatch
   * the effect. Returning null means the external outcome cannot be proven. */
  reconcile?(input: RoleToolExecutionInput): Promise<RoleToolExecutionResult | null>;
}

export interface RoleToolLoopOptions {
  executor: RoleToolExecutor;
  maxRounds?: number;
  maxWallClockMs?: number;
  maxParallelToolCalls?: number;
  maxToolCallsPerRound?: number;
  runtimeProgressRecorder?: RuntimeProgressRecorder;
}

export const DEFAULT_ROLE_TOOL_MAX_ROUNDS = 128;
const MAX_SESSION_TOOL_TIMEOUT_SECONDS = 1800;
const DEFAULT_BROWSER_SESSION_TOOL_TIMEOUT_MS = 18 * 60 * 1_000;
const DEFAULT_EXPLORE_SESSION_TOOL_TIMEOUT_MS = 8 * 60 * 1_000;
const DEFAULT_GENERAL_SESSION_TOOL_TIMEOUT_MS = 3 * 60 * 1_000;
const DEFAULT_RESUMABLE_CONTINUATION_TOOL_TIMEOUT_MS = 45_000;
const SUPPLEMENTAL_LOCAL_TIMEOUT_BROWSER_PROBE_TIMEOUT_MS = 90_000;
const LOCAL_APPROVAL_BROWSER_TASK_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_PERMISSION_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_WORKER_TOOL_HARD_ABORT_GRACE_MS = 60_000;
const DEFAULT_WORKER_TIMEOUT_SUMMARY_GRACE_MS = 60_000;
const WORKER_TOOL_TIMEOUT = Symbol("worker_tool_timeout");
const WORKER_TOOL_CANCELLED = Symbol("worker_tool_cancelled");

interface WorkerToolTimeout {
  kind: typeof WORKER_TOOL_TIMEOUT;
  lateResult: WorkerExecutionResult | null;
}

export interface WorkerSessionConcurrencyLimits {
  maxPerParentConcurrent?: number;
  maxGlobalActive?: number;
}

class AsyncSerialGate {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

// Moved verbatim into the reusable agent-core package; re-exported here so the
// existing `./tool-use` import path keeps working for in-repo consumers.
export { appendAssistantToolCallMessage, appendToolResultMessages };

// gemini K3.5: Date.now() can repeat within the same millisecond
// when parallel tool calls fire via Promise.all and each emits a
// "started" + "completed" event. Stamp progressIds with a
// per-process monotonic counter alongside the timestamp to break
// ties.
let roleToolProgressSeq = 0;

export async function recordRoleToolProgress(input: {
  recorder: RuntimeProgressRecorder | undefined;
  activation: RoleActivationInput;
  call: LLMToolCall;
  progress: RoleToolProgressEvent;
}): Promise<void> {
  if (!input.recorder) return;
  const seq = (++roleToolProgressSeq).toString(36);
  await input.recorder.record({
    progressId: `progress:tool:${input.activation.handoff.taskId}:${input.call.id}:${Date.now()}:${seq}`,
    threadId: input.activation.thread.threadId,
    chainId: `flow:${input.activation.flow.flowId}`,
    spanId: `role:${input.activation.runState.runKey}`,
    ...(input.activation.runState.lastDequeuedTaskId
      ? { parentSpanId: `dispatch:${input.activation.runState.lastDequeuedTaskId}` }
      : {}),
    subjectKind: "role_run",
    subjectId: input.activation.runState.runKey,
    phase:
      input.progress.phase === "failed"
        ? "failed"
        : input.progress.phase === "completed"
          ? "completed"
          : input.progress.phase === "cancelled"
            ? "cancelled"
            : "started",
    progressKind: "boundary",
    heartbeatSource: "control_path",
    continuityState: input.progress.phase === "failed" || input.progress.phase === "cancelled" ? "terminal" : "alive",
    summary: input.progress.summary,
    recordedAt: Date.now(),
    flowId: input.activation.flow.flowId,
    taskId: input.activation.handoff.taskId,
    roleId: input.activation.runState.roleId,
    metadata: {
      toolCallId: input.call.id,
      toolName: input.call.name,
      ...(input.progress.detail ? { detail: input.progress.detail } : {}),
    },
  });
}

export async function recordRoleToolProgressSafely(input: {
  recorder: RuntimeProgressRecorder | undefined;
  activation: RoleActivationInput;
  call: LLMToolCall;
  progress: RoleToolProgressEvent;
  defer?: boolean | undefined;
}): Promise<void> {
  const work = async () => {
    await recordRoleToolProgress(input);
  };
  const onError = (error: unknown) => {
    console.error("runtime tool progress recording failed", {
      threadId: input.activation.thread.threadId,
      flowId: input.activation.flow.flowId,
      taskId: input.activation.handoff.taskId,
      toolName: input.call.name,
      error,
    });
  };
  if (input.defer) {
    void work().catch(onError);
    return;
  }
  try {
    await work();
  } catch (error) {
    onError(error);
  }
}

export async function emitRoleToolProgressSafely(input: {
  recorder: RuntimeProgressRecorder | undefined;
  activation: RoleActivationInput;
  call: LLMToolCall;
  progress: RoleToolProgressEvent;
  defer?: boolean | undefined;
  onProgress?:
    | ((
        call: LLMToolCall,
        progress: RoleToolProgressEvent,
      ) => Promise<void>)
    | undefined;
}): Promise<void> {
  await recordRoleToolProgressSafely(input);
  try {
    await input.onProgress?.(input.call, input.progress);
  } catch (error) {
    console.error("native tool message progress persistence failed", {
      threadId: input.activation.thread.threadId,
      flowId: input.activation.flow.flowId,
      taskId: input.activation.handoff.taskId,
      toolName: input.call.name,
      error,
    });
  }
}

export async function executeRoleToolCalls(input: {
  toolLoop: RoleToolLoopOptions | undefined;
  runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  deferToolObservability?: boolean | undefined;
  now: () => number;
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  toolCalls: LLMToolCall[];
  toolLoopStartedAtMs: number;
  signal?: AbortSignal | undefined;
  onAdmitted?: ((call: LLMToolCall) => Promise<void>) | undefined;
  onStarted?: ((call: LLMToolCall) => Promise<void>) | undefined;
  onProgress?:
    | ((
        call: LLMToolCall,
        progress: RoleToolProgressEvent,
      ) => Promise<void>)
    | undefined;
  onResult?: ((result: RoleToolExecutionResult) => Promise<void>) | undefined;
}): Promise<RoleToolExecutionResult[]> {
  const activeToolLoop =
    input.packet.toolUseMode === "disabled" ? undefined : input.toolLoop;
  if (!activeToolLoop) return [];
  const maxParallelToolCalls =
    typeof activeToolLoop.maxParallelToolCalls === "number" &&
    Number.isFinite(activeToolLoop.maxParallelToolCalls) &&
    activeToolLoop.maxParallelToolCalls > 0
      ? Math.floor(activeToolLoop.maxParallelToolCalls)
      : input.toolCalls.length;
  const maxToolCallsPerRound =
    typeof activeToolLoop.maxToolCallsPerRound === "number" &&
    Number.isFinite(activeToolLoop.maxToolCallsPerRound) &&
    activeToolLoop.maxToolCallsPerRound > 0
      ? Math.floor(activeToolLoop.maxToolCallsPerRound)
      : input.toolCalls.length;
  const results: RoleToolExecutionResult[] = [];
  const executableCalls = input.toolCalls.slice(0, maxToolCallsPerRound);
  const rejectedCalls = input.toolCalls.slice(maxToolCallsPerRound);
  const effectiveMaxParallelToolCalls = shouldSerializeToolBatch(
    executableCalls,
  )
    ? 1
    : maxParallelToolCalls;
  const emitProgress = (
    call: LLMToolCall,
    progress: RoleToolProgressEvent,
  ) =>
    emitRoleToolProgressSafely({
      recorder:
        input.toolLoop?.runtimeProgressRecorder ?? input.runtimeProgressRecorder,
      activation: input.activation,
      call,
      progress,
      defer: input.deferToolObservability,
      onProgress: input.onProgress,
    });
  for (
    let index = 0;
    index < executableCalls.length;
    index += effectiveMaxParallelToolCalls
  ) {
    throwIfAborted(input.signal);
    const chunk = executableCalls.slice(
      index,
      index + effectiveMaxParallelToolCalls,
    );
    const maxWallClockMs = resolveEffectiveToolLoopWallClockMs({
      ...(activeToolLoop.maxWallClockMs !== undefined
        ? { maxWallClockMs: activeToolLoop.maxWallClockMs }
        : {}),
      toolCalls: chunk,
    });
    const toolExecutionSignal = createToolExecutionSignal({
      elapsedMs: input.now() - input.toolLoopStartedAtMs,
      ...(input.signal ? { parentSignal: input.signal } : {}),
      ...(maxWallClockMs ? { maxWallClockMs } : {}),
    });
    try {
      const chunkResults = await Promise.all(
        chunk.map(async (call) => {
          throwIfAborted(input.signal);
          await input.onAdmitted?.(call);
          await input.onStarted?.(call);
          await emitProgress(call, {
            phase: "started",
            toolName: call.name,
            summary: `Tool call started: ${call.name}`,
          });
          try {
            throwIfAborted(input.signal);
            const result = await activeToolLoop.executor.execute({
              call,
              activation: input.activation,
              packet: input.packet,
              ...(toolExecutionSignal.signal
                ? { signal: toolExecutionSignal.signal }
                : {}),
            });
            throwIfAborted(input.signal);
            for (const progress of result.progress ?? []) {
              await emitProgress(call, progress);
            }
            await emitProgress(call, {
              phase: result.cancelled
                ? "cancelled"
                : result.isError
                  ? "failed"
                  : "completed",
              toolName: call.name,
              summary: result.cancelled
                ? `Tool call cancelled: ${call.name}`
                : result.isError
                  ? `Tool call failed: ${call.name}`
                  : `Tool call completed: ${call.name}`,
            });
            await input.onResult?.(result);
            return result;
          } catch (error) {
            if (isAbortError(error)) {
              throw error;
            }
            const content =
              error instanceof Error ? error.message : String(error);
            await emitProgress(call, {
              phase: "failed",
              toolName: call.name,
              summary: `Tool call failed: ${call.name}: ${content}`,
            });
            const result = {
              toolCallId: call.id,
              toolName: call.name,
              content,
              isError: true,
            };
            await input.onResult?.(result);
            return result;
          }
        }),
      );
      results.push(...chunkResults);
    } finally {
      toolExecutionSignal.dispose();
    }
  }
  for (const call of rejectedCalls) {
    throwIfAborted(input.signal);
    const result: RoleToolExecutionResult = buildToolCallLimitExceededResult(
      call,
      maxToolCallsPerRound,
      input.toolCalls.length,
    );
    for (const progress of result.progress ?? []) {
      await emitProgress(call, progress);
    }
    await input.onResult?.(result);
    results.push(result);
  }
  return results;
}

export interface RuntimeForcedToolRoundObserver {
  observeRuntimeForcedToolRound(input: {
    round: number;
    messages: LLMMessage[];
    assistantText: string;
    toolCalls: LLMToolCall[];
    executeToolCalls(handlers: {
      onProgress(
        call: LLMToolCall,
        progress: RoleToolProgressEvent,
      ): Promise<void>;
      onResult(result: RoleToolExecutionResult): Promise<void>;
    }): Promise<RoleToolExecutionResult[]>;
  }): Promise<{ messages: LLMMessage[]; toolResults: RoleToolExecutionResult[] }>;
}

export interface RuntimeForcedToolEffectLifecycle {
  onAdmitted(input: { round: number; call: LLMToolCall }): Promise<void>;
  onStarted(input: { round: number; call: LLMToolCall }): Promise<void>;
  onResult(input: {
    round: number;
    result: RoleToolExecutionResult;
  }): Promise<void>;
}

export async function executeRuntimeForcedToolRound(input: {
  toolLoop: RoleToolLoopOptions | undefined;
  runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  deferToolObservability?: boolean | undefined;
  now: () => number;
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  observer?: RuntimeForcedToolRoundObserver | undefined;
  toolCalls: LLMToolCall[];
  round: number;
  toolLoopStartedAtMs: number;
  signal?: AbortSignal | undefined;
  assistantText: string;
  persistNativeToolTrace(options?: {
    forceBlocking?: boolean | undefined;
  }): Promise<void>;
  recordProviderToolProtocolRound(input: {
    round: number;
    toolCalls: LLMToolCall[];
    toolResults: RoleToolExecutionResult[];
    messages: LLMMessage[];
  }): Promise<void>;
  mapToolResultsForHistory?(
    results: RoleToolExecutionResult[],
  ): Promise<RoleToolExecutionResult[]>;
  effectLifecycle?: RuntimeForcedToolEffectLifecycle | undefined;
}): Promise<{ messages: LLMMessage[]; toolResults: RoleToolExecutionResult[] }> {
  if (input.observer) {
    return input.observer.observeRuntimeForcedToolRound({
      round: input.round,
      messages: input.messages,
      assistantText: input.assistantText,
      toolCalls: input.toolCalls,
      executeToolCalls: ({ onProgress, onResult }) =>
        executeRoleToolCalls({
          toolLoop: input.toolLoop,
          runtimeProgressRecorder: input.runtimeProgressRecorder,
          deferToolObservability: input.deferToolObservability,
          now: input.now,
          activation: input.activation,
          packet: input.packet,
          toolCalls: input.toolCalls,
          toolLoopStartedAtMs: input.toolLoopStartedAtMs,
          ...(input.signal ? { signal: input.signal } : {}),
          onAdmitted: (call) =>
            input.effectLifecycle?.onAdmitted({ round: input.round, call }) ??
            Promise.resolve(),
          onStarted: (call) =>
            input.effectLifecycle?.onStarted({ round: input.round, call }) ??
            Promise.resolve(),
          onProgress,
          onResult: async (result) => {
            await input.effectLifecycle?.onResult({
              round: input.round,
              result,
            });
            await onResult(result);
          },
        }),
      ...(input.mapToolResultsForHistory
        ? { mapToolResultsForHistory: input.mapToolResultsForHistory }
        : {}),
    });
  }

  const roundTrace: NativeToolRoundTrace = {
    round: input.round,
    calls: input.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      input: call.input,
    })),
    results: [],
    progress: [],
  };
  input.toolTrace.push(roundTrace);
  const toolResults = await executeRoleToolCalls({
    toolLoop: input.toolLoop,
    runtimeProgressRecorder: input.runtimeProgressRecorder,
    deferToolObservability: input.deferToolObservability,
    now: input.now,
    activation: input.activation,
    packet: input.packet,
    toolCalls: input.toolCalls,
    toolLoopStartedAtMs: input.toolLoopStartedAtMs,
    ...(input.signal ? { signal: input.signal } : {}),
    onAdmitted: (call) =>
      input.effectLifecycle?.onAdmitted({ round: input.round, call }) ??
      Promise.resolve(),
    onStarted: (call) =>
      input.effectLifecycle?.onStarted({ round: input.round, call }) ??
      Promise.resolve(),
    onProgress: async (call, progress) => {
      roundTrace.progress?.push(
        toNativeToolProgressTrace(call, progress, input.now()),
      );
      await input.persistNativeToolTrace({
        forceBlocking: progress.phase === "started",
      });
    },
    onResult: async (toolResult) => {
      await input.effectLifecycle?.onResult({
        round: input.round,
        result: toolResult,
      });
      roundTrace.results.push(toNativeToolResultTrace(toolResult));
      await input.persistNativeToolTrace();
    },
  });
  const historyResults = input.mapToolResultsForHistory
    ? await input.mapToolResultsForHistory(toolResults)
    : toolResults;
  let messages = appendAssistantToolCallMessage(input.messages, {
    text: input.assistantText,
    toolCalls: input.toolCalls,
  });
  messages = appendToolResultMessages(messages, historyResults);
  await input.recordProviderToolProtocolRound({
    round: input.round,
    toolCalls: input.toolCalls,
    toolResults,
    messages,
  });
  return { messages, toolResults };
}

export function createWorkerSessionToolExecutor(options: {
  workerRuntime: WorkerRuntime;
  availableWorkerKinds?: WorkerKind[];
  maxSessionToolTimeoutMs?: number;
  hardTimeoutGraceMs?: number;
  sessionConcurrency?: WorkerSessionConcurrencyLimits;
  toolCapabilityRegistry?: ToolCapabilityRegistry;
  toolCancellationRegistry?: ToolCancellationRegistry;
  toolPermissionService?: ToolPermissionService;
  taskToolService?: TaskToolService;
  memoryResolver?: Pick<RoleMemoryResolver, "retrieveMemory" | "getMemory">;
  toolResultArtifactStore?: ToolResultArtifactStore;
  webFetchEnabled?: boolean;
  fetchFn?: typeof fetch;
  onBackgroundWorkerError?: (error: unknown, workerRunKey: string) => void;
}): RoleToolExecutor {
  const { workerRuntime } = options;
  const toolCapabilityRegistry =
    options.toolCapabilityRegistry ??
    createNativeToolCapabilityRegistry({
      ...(options.availableWorkerKinds ? { availableWorkerKinds: options.availableWorkerKinds } : {}),
      ...(options.maxSessionToolTimeoutMs
        ? { maxSessionToolTimeoutSeconds: options.maxSessionToolTimeoutMs / 1_000 }
        : {}),
      permissionsEnabled: Boolean(options.toolPermissionService),
      memoryEnabled: Boolean(options.memoryResolver),
      tasksEnabled: Boolean(options.taskToolService),
      webFetchEnabled: options.webFetchEnabled === true,
      artifactsEnabled: Boolean(options.toolResultArtifactStore),
    });
  const definitions = toolCapabilityRegistry.definitions();
  const executableWorkerKinds = new Set(toolCapabilityRegistry.availableWorkerKinds());
  const sessionSpawnGate = new AsyncSerialGate();
  const backgroundSpawnByToolCall = new Map<
    string,
    Promise<RoleToolExecutionResult>
  >();

  // Source a definition for every dispatchable tool name so the toolkit carries
  // honest schemas. The capability registry above stays the authority for which
  // definitions are *offered* to the model (`definitions()` below); the toolkit
  // only routes execution by name — exactly like the previous switch, including
  // the unknown-tool fallback.
  const workerKinds = toolCapabilityRegistry.availableWorkerKinds();
  const toolDefinitionsByName = new Map<string, LLMToolDefinition>();
  for (const definition of [
    ...buildWebToolDefinitions(),
    ...buildArtifactToolDefinitions(),
    ...buildSessionToolDefinitions(
      workerKinds,
      options.maxSessionToolTimeoutMs
        ? { maxTimeoutSeconds: options.maxSessionToolTimeoutMs / 1_000 }
        : {}
    ),
    ...buildPermissionToolDefinitions(workerKinds),
    ...buildMemoryToolDefinitions(),
    ...buildTaskToolDefinitions(),
  ]) {
    toolDefinitionsByName.set(definition.name, definition);
  }
  const definitionFor = (name: string): LLMToolDefinition =>
    toolDefinitionsByName.get(name) ?? { name, description: "", inputSchema: { type: "object" } };
  const roleTool = (
    name: string,
    run: (input: RoleToolExecutionInput) => Promise<RoleToolExecutionResult>
  ): Tool<RoleToolContext> => ({
    definition: definitionFor(name),
    execute(call, ctx) {
      const input: RoleToolExecutionInput = {
        call,
        activation: ctx.activation,
        packet: ctx.packet,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.deadlineAt === undefined ? {} : { deadlineAt: ctx.deadlineAt }),
      };
      return run(input);
    },
  });

  const toolkit = createToolkit<RoleToolContext>([
    roleTool("sessions_spawn", (input) => {
      const launch = () => executeSessionsSpawn(
        workerRuntime,
        input,
        executableWorkerKinds,
        options.toolCancellationRegistry,
        options.toolPermissionService,
        options.maxSessionToolTimeoutMs,
        options.hardTimeoutGraceMs,
        options.sessionConcurrency,
        sessionSpawnGate,
        options.onBackgroundWorkerError,
      );
      if (input.call.input.run_in_background !== true) return launch();
      const key = `${input.activation.runState.runKey}:${input.call.id}`;
      const existing = backgroundSpawnByToolCall.get(key);
      if (existing) return existing;
      const pending = launch();
      backgroundSpawnByToolCall.set(key, pending);
      return pending;
    }),
    roleTool("sessions_send", (input) =>
      executeSessionsSend(
        workerRuntime,
        input,
        options.toolCancellationRegistry,
        options.toolPermissionService,
        options.maxSessionToolTimeoutMs,
        options.hardTimeoutGraceMs
      )
    ),
    roleTool("sessions_list", (input) => executeSessionsList(workerRuntime, input)),
    roleTool("sessions_history", (input) => executeSessionsHistory(workerRuntime, input)),
    roleTool("web_fetch", (input) => executeWebFetch(input, options.fetchFn ?? fetch)),
    roleTool("artifacts_read", (input) =>
      executeArtifactRead(input, options.toolResultArtifactStore)
    ),
    roleTool("permission_query", (input) => executePermissionQuery(input, options.toolPermissionService)),
    roleTool("permission_result", (input) => executePermissionResult(input, options.toolPermissionService)),
    roleTool("permission_applied", (input) => executePermissionApplied(input, options.toolPermissionService)),
    roleTool("memory_search", (input) => executeMemorySearch(input, options.memoryResolver)),
    roleTool("memory_get", (input) => executeMemoryGet(input, options.memoryResolver)),
    roleTool("tasks_list", (input) => executeTasksList(input, options.taskToolService)),
    roleTool("tasks_create", (input) => executeTasksCreate(input, options.taskToolService)),
    roleTool("tasks_update", (input) => executeTasksUpdate(input, options.taskToolService)),
  ]);

  return {
    definitions() {
      return definitions;
    },
    async execute(input) {
      const ctx: RoleToolContext = {
        activation: input.activation,
        packet: input.packet,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      };
      return toolkit.execute(input.call, ctx);
    },
  };
}

async function executeArtifactRead(
  input: RoleToolExecutionInput,
  store?: ToolResultArtifactStore,
): Promise<RoleToolExecutionResult> {
  return executeToolResultArtifactRead(input.call, store);
}

export async function executeToolResultArtifactRead(
  call: LLMToolCall,
  store?: ToolResultArtifactStore,
): Promise<RoleToolExecutionResult> {
  if (!store) {
    return errorResult(call, "tool result artifact store is not configured");
  }
  const artifactId = requiredString(call.input.artifact_id);
  if (!artifactId) {
    return errorResult(call, "artifacts_read requires artifact_id");
  }
  const offsetBytes = nonNegativeInteger(call.input.offset_bytes) ?? 0;
  const limitBytes = Math.min(
    positiveInteger(call.input.limit_bytes) ?? 8 * 1024,
    32 * 1024,
  );
  try {
    const page = await store.read({ artifactId, offsetBytes, limitBytes });
    if (!page) {
      return errorResult(call, `tool result artifact not found: ${artifactId}`);
    }
    return {
      toolCallId: call.id,
      toolName: call.name,
      content: JSON.stringify({
        protocol: "turnkeyai.tool_result_artifact_page.v1",
        artifact_id: page.record.artifactId,
        source_tool_call_id: page.record.toolCallId,
        source_tool_name: page.record.toolName,
        offset_bytes: page.offsetBytes,
        next_offset_bytes: page.nextOffsetBytes,
        eof: page.eof,
        total_bytes: page.record.sizeBytes,
        sha256: page.record.sha256,
        content: page.content,
      }),
      raw: page,
    };
  } catch (error) {
    return errorResult(
      call,
      error instanceof Error ? error.message : "artifacts_read failed",
    );
  }
}

async function executeWebFetch(
  input: RoleToolExecutionInput,
  fetchFn: typeof fetch
): Promise<RoleToolExecutionResult> {
  const rawUrl = requiredString(input.call.input.url);
  if (!rawUrl) {
    return errorResult(input.call, "web_fetch requires url");
  }
  const maxChars = clampWebFetchMaxChars(input.call.input.max_chars);
  let safeUrl: string;
  try {
    safeUrl = validatePublicWebFetchUrl(rawUrl);
  } catch (error) {
    return errorResult(input.call, error instanceof Error ? error.message : "invalid web_fetch URL");
  }

  try {
    const startedAt = Date.now();
    const { response, finalUrl } = await webFetchWithRedirects(fetchFn, safeUrl, input.signal);
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const page = parseFetchedPage({
      requestedUrl: safeUrl,
      finalUrl,
      statusCode: response.status,
      contentType,
      body,
      maxChars,
    });
    const completedAt = Date.now();
    return {
      toolCallId: input.call.id,
      toolName: input.call.name,
      ...(response.ok ? {} : { isError: true }),
      content: JSON.stringify(page, null, 2),
      progress: [
        {
          phase: response.ok ? "completed" : "failed",
          toolName: input.call.name,
          summary: response.ok
            ? `Fetched public page ${page.final_url}.`
            : `web_fetch returned HTTP ${response.status} for ${page.final_url}.`,
          detail: {
            requested_url: page.requested_url,
            final_url: page.final_url,
            status: page.status,
            status_code: page.status_code,
            title: page.title,
            content_type: page.content_type,
            elapsed_ms: completedAt - startedAt,
          },
        },
      ],
      raw: page,
    };
  } catch (error) {
    return errorResult(input.call, error instanceof Error ? error.message : "web_fetch failed");
  }
}

async function executeMemorySearch(
  input: RoleToolExecutionInput,
  memoryResolver?: Pick<RoleMemoryResolver, "retrieveMemory" | "getMemory">
): Promise<RoleToolExecutionResult> {
  if (!memoryResolver) {
    return errorResult(input.call, "memory resolver is not configured");
  }
  const query = requiredString(input.call.input.query);
  if (!query) {
    return errorResult(input.call, "memory_search requires query");
  }
  const limit = Math.min(positiveInteger(input.call.input.limit) ?? 6, 10);
  const hits = await memoryResolver.retrieveMemory({
    threadId: input.activation.thread.threadId,
    roleId: input.activation.runState.roleId,
    queryText: query,
  });
  const memories = hits.slice(0, limit).map(serializeMemoryHit);
  return {
    toolCallId: input.call.id,
    toolName: input.call.name,
    content: JSON.stringify(
      {
        query,
        total_hits: hits.length,
        showing: memories.length,
        memories,
      },
      null,
      2
    ),
    progress: [
      {
        phase: "completed",
        toolName: input.call.name,
        summary: `Memory search returned ${memories.length} hit(s).`,
        detail: { query, total_hits: hits.length, showing: memories.length },
      },
    ],
  };
}

async function executeMemoryGet(
  input: RoleToolExecutionInput,
  memoryResolver?: Pick<RoleMemoryResolver, "retrieveMemory" | "getMemory">
): Promise<RoleToolExecutionResult> {
  if (!memoryResolver) {
    return errorResult(input.call, "memory resolver is not configured");
  }
  const memoryId = requiredString(input.call.input.memory_id);
  if (!memoryId) {
    return errorResult(input.call, "memory_get requires memory_id");
  }
  const hit = await memoryResolver.getMemory({
    threadId: input.activation.thread.threadId,
    roleId: input.activation.runState.roleId,
    memoryId,
  });
  if (!hit) {
    return errorResult(input.call, `memory not found: ${memoryId}`);
  }
  return {
    toolCallId: input.call.id,
    toolName: input.call.name,
    content: JSON.stringify({ memory: serializeMemoryHit(hit) }, null, 2),
    progress: [
      {
        phase: "completed",
        toolName: input.call.name,
        summary: `Read memory ${memoryId}.`,
        detail: { memory_id: memoryId, source: hit.source, score: hit.score },
      },
    ],
  };
}

async function executePermissionQuery(
  input: RoleToolExecutionInput,
  toolPermissionService?: ToolPermissionService
): Promise<RoleToolExecutionResult> {
  if (!toolPermissionService) {
    return errorResult(input.call, "permission service is not configured");
  }
  const action = requiredString(input.call.input.action);
  const title = requiredString(input.call.input.title);
  const risk = requiredString(input.call.input.risk);
  const level = parsePermissionLevel(input.call.input.level);
  const scope = parsePermissionScope(input.call.input.scope);
  const rationale = requiredString(input.call.input.rationale);
  if (!action || !title || !risk || !level || !scope || !rationale) {
    return errorResult(input.call, "permission_query requires action, title, risk, level, scope, and rationale");
  }
  const readOnlyMismatch = rejectReadOnlyPermissionQuery(input, action, scope);
  if (readOnlyMismatch) {
    return readOnlyMismatch;
  }
  const role = input.activation.thread.roles.find((item) => item.roleId === input.activation.runState.roleId);
  const workerType = parseWorkerKind(input.call.input.worker_kind);
  const effectiveWorkerType = action.startsWith("browser.") ? "browser" : workerType;
  const missionId = requiredString(input.call.input.mission_id);
  const affects = readStringArray(input.call.input.affects);
  const explicitCacheKey = requiredString(input.call.input.cache_key);
  const cacheKey =
    explicitCacheKey ??
    (effectiveWorkerType === "browser" && level === "approval" && action.startsWith("browser.")
      ? browserSideEffectCacheKey(input.activation.thread.threadId, action, scope)
      : null);
  const result = await toolPermissionService.request({
    threadId: input.activation.thread.threadId,
    roleId: input.activation.runState.roleId,
    roleName: role?.name ?? input.activation.runState.roleId,
    toolCallId: input.call.id,
    action,
    title,
    risk,
    requirement: {
      level,
      scope,
      rationale,
      ...(cacheKey ? { cacheKey } : {}),
      ...(effectiveWorkerType ? { workerType: effectiveWorkerType } : {}),
    },
    ...(missionId ? { missionId } : {}),
    ...(affects.length ? { affects } : {}),
    ...(isRecord(input.call.input.payload) ? { payload: input.call.input.payload } : {}),
  });
  return {
    toolCallId: input.call.id,
    toolName: input.call.name,
    content: JSON.stringify(withPermissionEventType("permission.query", result), null, 2),
    progress: [
      {
        phase: "progress",
        toolName: input.call.name,
        summary:
          result.status === "already_granted"
            ? `Permission already granted for ${action}.`
            : `Permission requested for ${action}.`,
        detail: {
          eventType: "permission.query",
          status: result.status,
          ...(result.approvalId ? { approval_id: result.approvalId } : {}),
          scope,
          level,
        },
      },
    ],
    raw: result,
  };
}

async function executePermissionResult(
  input: RoleToolExecutionInput,
  toolPermissionService?: ToolPermissionService
): Promise<RoleToolExecutionResult> {
  if (!toolPermissionService) {
    return errorResult(input.call, "permission service is not configured");
  }
  const approvalId = requiredString(input.call.input.approval_id);
  if (!approvalId) {
    return errorResult(input.call, "permission_result requires approval_id");
  }
  const result = await toolPermissionService.result({
    threadId: input.activation.thread.threadId,
    approvalId,
  });
  return {
    toolCallId: input.call.id,
    toolName: input.call.name,
    ...(result.status === "denied" ? { isError: true } : {}),
    content: JSON.stringify(withPermissionEventType("permission.result", result), null, 2),
    progress: [
      {
        phase: "progress",
        toolName: input.call.name,
        summary: result.message,
        detail: {
          eventType: "permission.result",
          status: result.status,
          approval_id: approvalId,
        },
      },
    ],
    raw: result,
  };
}

async function executePermissionApplied(
  input: RoleToolExecutionInput,
  toolPermissionService?: ToolPermissionService
): Promise<RoleToolExecutionResult> {
  if (!toolPermissionService) {
    return errorResult(input.call, "permission service is not configured");
  }
  const approvalId = requiredString(input.call.input.approval_id);
  if (!approvalId) {
    return errorResult(input.call, "permission_applied requires approval_id");
  }
  const result = await toolPermissionService.apply({
    threadId: input.activation.thread.threadId,
    approvalId,
  });
  return {
    toolCallId: input.call.id,
    toolName: input.call.name,
    ...(result.status !== "applied" ? { isError: true } : {}),
    content: JSON.stringify(withPermissionEventType("permission.applied", result), null, 2),
    progress: [
      {
        phase: result.status === "applied" ? "completed" : "failed",
        toolName: input.call.name,
        summary: result.message,
        detail: {
          eventType: "permission.applied",
          status: result.status,
          approval_id: approvalId,
          ...(result.cacheKey ? { cache_key: result.cacheKey } : {}),
        },
      },
    ],
    raw: result,
  };
}

function withPermissionEventType<T extends object>(eventType: string, result: T): T & { event_type: string } {
  return { event_type: eventType, ...result };
}

interface BrowserSideEffectGateOutcome {
  blocked?: RoleToolExecutionResult;
  progress?: RoleToolProgressEvent[];
  approvedContext?: BrowserSideEffectApprovalContext;
}

async function maybeGateBrowserSideEffect(input: {
  input: RoleToolExecutionInput;
  workerType: WorkerKind;
  instruction: string;
  toolPermissionService: ToolPermissionService | undefined;
}): Promise<BrowserSideEffectGateOutcome | null> {
  if (input.workerType !== "browser") {
    return null;
  }
  const risk =
    classifyBrowserSideEffect(input.instruction) ??
    classifyParentRequiredBrowserSideEffect(input.input.packet.taskPrompt, input.instruction);
  if (!risk) {
    return null;
  }
  if (!input.toolPermissionService) {
    return {
      blocked: errorResult(
        input.input.call,
        `Permission approval is required before ${risk.action}, but permission service is not configured.`
      ),
    };
  }
  const role = input.input.activation.thread.roles.find(
    (item) => item.roleId === input.input.activation.runState.roleId
  );
  const missionId = requiredString(input.input.call.input.mission_id);
  let result: ToolPermissionQueryResult;
  try {
    result = await input.toolPermissionService.request({
      threadId: input.input.activation.thread.threadId,
      roleId: input.input.activation.runState.roleId,
      roleName: role?.name ?? input.input.activation.runState.roleId,
      toolCallId: input.input.call.id,
      action: risk.action,
      title: risk.title,
      risk: risk.risk,
      requirement: {
        level: "approval",
        scope: risk.scope,
        rationale: "Browser worker instruction appears to perform a side effect that must be approved before execution.",
        workerType: "browser",
        cacheKey: browserSideEffectCacheKey(
          input.input.activation.thread.threadId,
          risk.action,
          risk.scope
        ),
      },
      ...(missionId ? { missionId } : {}),
      payload: {
        tool_name: input.input.call.name,
        instruction: truncateForPermissionPayload(input.instruction),
      },
    });
  } catch (error) {
    return {
      blocked: errorResult(
        input.input.call,
        `Permission approval is required before ${risk.action}, but approval could not be requested: ${
          error instanceof Error ? error.message : String(error)
        }`
      ),
    };
  }
  if (result.status === "already_granted") {
    return {
      approvedContext: buildBrowserSideEffectApprovalContext(risk.action, risk.scope, result.requirement.cacheKey),
      progress: [
        {
          phase: "progress",
          toolName: input.input.call.name,
          summary: `Permission already granted for ${risk.action}.`,
          detail: {
            eventType: "permission.query",
            status: result.status,
            action: risk.action,
            scope: risk.scope,
            level: "approval",
          },
        },
      ],
    };
  }
  const queryProgress: RoleToolProgressEvent = {
    phase: "progress",
    toolName: input.input.call.name,
    summary: `Approval required before ${risk.action}.`,
    detail: {
      eventType: "permission.query",
      status: result.status,
      approval_id: result.approvalId,
      action: risk.action,
      scope: risk.scope,
      level: "approval",
      blocked_before_side_effect: true,
    },
  };
  if (result.approvalId && input.toolPermissionService.waitForDecision) {
    let decision: ToolPermissionDecisionResult;
    try {
      decision = await input.toolPermissionService.waitForDecision({
        threadId: input.input.activation.thread.threadId,
        approvalId: result.approvalId,
        timeoutMs: readToolPermissionWaitMs(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        blocked: permissionBlockedResult(input.input.call, {
          result,
          progress: [queryProgress, permissionErrorProgress(input.input.call.name, result.approvalId, message)],
          status: "permission_error",
          message,
          isError: true,
        }),
      };
    }
    const decisionProgress: RoleToolProgressEvent = {
      phase: "progress",
      toolName: input.input.call.name,
      summary: decision.message,
      detail: {
        eventType: "permission.result",
        status: decision.status,
        approval_id: result.approvalId,
      },
    };
    if (decision.status === "approved") {
      let applied: ToolPermissionAppliedResult;
      try {
        applied = await input.toolPermissionService.apply({
          threadId: input.input.activation.thread.threadId,
          approvalId: result.approvalId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          blocked: permissionBlockedResult(input.input.call, {
            result,
            progress: [
              queryProgress,
              decisionProgress,
              permissionErrorProgress(input.input.call.name, result.approvalId, message),
            ],
            status: "permission_error",
            message,
            isError: true,
          }),
        };
      }
      if (applied.status === "applied") {
        return {
          approvedContext: buildBrowserSideEffectApprovalContext(risk.action, risk.scope, applied.cacheKey),
          progress: [
            queryProgress,
            decisionProgress,
            {
              phase: "progress",
              toolName: input.input.call.name,
              summary: applied.message,
              detail: {
                eventType: "permission.applied",
                status: applied.status,
                approval_id: result.approvalId,
                ...(applied.cacheKey ? { cache_key: applied.cacheKey } : {}),
              },
            },
          ],
        };
      }
      return {
        blocked: permissionBlockedResult(input.input.call, {
          result,
          progress: [queryProgress, decisionProgress],
          status: applied.status,
          message: applied.message,
          isError: true,
        }),
      };
    }
    if (decision.status === "denied") {
      return {
        blocked: permissionBlockedResult(input.input.call, {
          result,
          progress: [queryProgress, decisionProgress],
          status: decision.status,
          message: decision.message,
          isError: true,
        }),
      };
    }
    return {
      blocked: permissionBlockedResult(input.input.call, {
        result,
        progress: [queryProgress, decisionProgress],
        status: "approval_wait_timeout",
        message: `${decision.message} The browser side effect was not performed because no operator decision arrived before the approval wait timeout.`,
        isError: true,
      }),
    };
  }
  return {
    blocked: permissionBlockedResult(input.input.call, {
      result,
      progress: [queryProgress],
      status: "requires_approval",
      message: result.message,
      isError: true,
    }),
  };
}

function readToolPermissionWaitMs(): number {
  const raw = process.env.TURNKEYAI_TOOL_PERMISSION_WAIT_MS;
  if (!raw) {
    return DEFAULT_TOOL_PERMISSION_WAIT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TOOL_PERMISSION_WAIT_MS;
  }
  return Math.floor(parsed);
}

function permissionErrorProgress(toolName: string, approvalId: string, message: string): RoleToolProgressEvent {
  return {
    phase: "progress",
    toolName,
    summary: message,
    detail: {
      eventType: "permission.error",
      approval_id: approvalId,
      error: message,
    },
  };
}

function permissionBlockedResult(
  call: LLMToolCall,
  input: {
    result: ToolPermissionQueryResult;
    progress: RoleToolProgressEvent[];
    status: string;
    message: string;
    isError: boolean;
  }
): RoleToolExecutionResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    ...(input.isError ? { isError: true } : {}),
    content: JSON.stringify(
      {
        status: input.status,
        approval_id: input.result.approvalId,
        action: input.result.action,
        requirement: input.result.requirement,
        message: input.message,
        blocked_before_side_effect: true,
      },
      null,
      2
    ),
    progress: input.progress,
    raw: input.result,
  };
}

function classifyBrowserSideEffect(
  instruction: string
): { action: string; scope: "mutate" | "publish" | "credential"; title: string; risk: string } | null {
  const normalized = instruction.toLowerCase();
  if (hasCredentialAccessSignal(normalized)) {
    return {
      action: "browser.credential.access",
      scope: "credential",
      title: "Use browser credentials",
      risk: "May expose or use account credentials or authentication secrets.",
    };
  }
  if (
    isExplicitReadOnlyBrowserInspectionInstruction(normalized) ||
    isReadOnlyBrowserSourceEvidenceInstruction(normalized)
  ) {
    return null;
  }
  if (isReadOnlySourceUrlTaskWithoutExplicitPublishIntent(normalized)) {
    return null;
  }
  if (
    /\b(post publicly|go live)\b/.test(normalized) ||
    /\brelease\s+(?:this|the)\s+(?:draft|post|article|page|change|changes|build|version)\b/.test(normalized) ||
    hasBrowserActionVerb(
      normalized,
      ["publish", "deploy"],
      ["date", "time", "version", "history", "status", "notes", "metadata", "frequency", "schedule", "cadence", "information", "info", "details", "count", "counts"]
    )
  ) {
    return {
      action: "browser.publish",
      scope: "publish",
      title: "Publish from browser",
      risk: "May publish externally visible content or make a public change.",
    };
  }
  if (
    hasBrowserActionVerb(
      normalized,
      [
        "submit",
        "send",
        "save",
        "create",
        "update",
        "delete",
        "remove",
        "archive",
        "checkout",
        "purchase",
        "buy",
        "order",
        "book",
        "reserve",
        "invite",
        "approve",
        "accept",
        "reject",
        "cancel",
      ],
      [
        "date",
        "time",
        "version",
        "history",
        "status",
        "frequency",
        "metadata",
        "count",
        "counts",
        "stats",
        "statistics",
        "answer",
        "answers",
        "evidence",
        "finding",
        "findings",
        "recommendation",
        "recommendations",
        "report",
        "reports",
        "result",
        "results",
        "review",
        "summary",
        "summaries",
      ]
    )
  ) {
    return {
      action: /\bsubmit\b/.test(normalized) ? "browser.form.submit" : "browser.mutate",
      scope: "mutate",
      title: "Approve browser mutation",
      risk: "May change account state, submit data, or trigger an external action.",
    };
  }
  return null;
}

function classifyParentRequiredBrowserSideEffect(
  parentTaskPrompt: string,
  instruction: string
): { action: string; scope: "mutate"; title: string; risk: string } | null {
  const parent = parentTaskPrompt.toLowerCase();
  const child = instruction.toLowerCase();
  if (!/\b(?:browser\.form\.submit|form submission|submit(?:ting)?|dry[- ]run)\b/.test(parent)) {
    return null;
  }
  const parentRequiresApprovalAction =
    /\bactually\s+carry\b[\s\S]{0,180}\b(?:approval gate|operator approval|operator review|browser action|form submission)\b/.test(parent) ||
    /\bcarry\b[\s\S]{0,120}\b(?:dry[- ]run|form submission|browser action)\b[\s\S]{0,120}\b(?:approval gate|operator approval|operator review)\b/.test(parent) ||
    /\brequest approval before applying\b[\s\S]{0,160}\b(?:browser action|form submission|submit|side[- ]effect)\b/.test(parent) ||
    /\bafter the runtime approval gate is cleared\b[\s\S]{0,180}\b(?:browser task|browser worker|submit|form submission|browser\.form\.submit)\b/.test(parent) ||
    /\bruntime approval gate\b[\s\S]{0,160}\b(?:exercised|cleared|applied)\b/.test(parent);
  if (!parentRequiresApprovalAction) {
    return null;
  }
  if (isBrowserInspectionOnlyBeforeApproval(child)) {
    return null;
  }
  if (
    !/\b(?:approval[- ]gated|approval form|approval fixture|browser\.form\.submit|form submission|submit(?:ting)?|dry[- ]run)\b/.test(
      child
    )
  ) {
    return null;
  }
  return {
    action: "browser.form.submit",
    scope: "mutate",
    title: "Approve browser mutation",
    risk: "May change account state, submit data, or trigger an external action.",
  };
}

function isBrowserInspectionOnlyBeforeApproval(text: string): boolean {
  return (
    /\b(?:pre[- ]approval\s+)?(?:browser\s+)?inspection only\b/.test(text) ||
    (/\b(?:inspect|observe|review|open|snapshot|screenshot|visible|rendered)\b[\s\S]{0,220}\b(?:before|without|until)\b[\s\S]{0,120}\b(?:approval|permission|submission|submit|side[- ]effect|mutation)\b/.test(
      text
    ) &&
      /\b(?:do not|don't|no|without|blocked until|remains blocked until)\b[\s\S]{0,180}\b(?:submit|submission|click the submit|mutat(?:e|ion)|side[- ]effect|save|apply)\b/.test(
        text
      ))
  );
}

function hasCredentialAccessSignal(input: string): boolean {
  const normalized = input.replace(
    /\b(?:do not|don't|no)\b[^.;\n]{0,100}\b(?:credentials?|api keys?|secrets?|tokens?)\b/g,
    " "
  );
  return (
    /\b(password|2fa|mfa|otp|credential|credentials|api key|secret)\b/.test(normalized) ||
    /\b(?:auth|access|bearer|session|refresh|login|credential|secret)\s+token\b/.test(normalized) ||
    /\btoken\b[\s\S]{0,40}\b(?:auth|access|bearer|session|refresh|login|credential|secret)\b/.test(normalized)
  );
}

function rejectReadOnlyPermissionQuery(
  input: RoleToolExecutionInput,
  action: string,
  scope: "navigate" | "mutate" | "publish" | "credential"
): RoleToolExecutionResult | null {
  if (!action.startsWith("browser.") || scope === "navigate") {
    return null;
  }
  const primaryContext = buildPermissionQueryPrimaryTaskContext(input).toLowerCase();
  if (
    primaryContext &&
    hasReadOnlySourceWorkSignal(primaryContext) &&
    !hasExplicitBrowserSideEffectIntent(primaryContext)
  ) {
    return errorResult(
      input.call,
      `permission_query rejected: ${action} is a browser side-effect request, but the current task context is read-only/source-bounded. Continue with read-only evidence collection or final synthesis instead of creating an approval.`
    );
  }
  const context = buildPermissionQueryTaskContext(input).toLowerCase();
  if (!context || !hasReadOnlySourceWorkSignal(context) || hasExplicitBrowserSideEffectIntent(context)) {
    return null;
  }
  return errorResult(
    input.call,
    `permission_query rejected: ${action} is a browser side-effect request, but the current task context is read-only/source-bounded. Continue with read-only evidence collection or final synthesis instead of creating an approval.`
  );
}

function buildPermissionQueryPrimaryTaskContext(input: RoleToolExecutionInput): string {
  return [
    input.packet.taskPrompt,
    input.packet.outputContract,
    getInstructions(input.activation.handoff.payload),
    getRelayBrief(input.activation.handoff.payload),
  ]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join("\n");
}

function buildPermissionQueryTaskContext(input: RoleToolExecutionInput): string {
  const payload = input.activation.handoff.payload;
  return [
    input.packet.systemPrompt,
    input.packet.taskPrompt,
    input.packet.outputContract,
    getInstructions(payload),
    getRelayBrief(payload),
    ...getRecentMessages(payload).map((item) => item.content),
  ]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join("\n");
}

function hasReadOnlySourceWorkSignal(input: string): boolean {
  return (
    /\bread[- ]only\b/.test(input) ||
    /\bsource[- ](?:backed|bounded)\b/.test(input) ||
    /\b(?:review|research|inspect|revisit|notes|evidence|decision note|synthesi[sz]e|summari[sz]e|comparison|pricing|strength|risk)\b/.test(
      input
    )
  );
}

function hasExplicitBrowserSideEffectIntent(input: string): boolean {
  const normalized = input.replace(
    /\b(?:do not|don't|no)\b[^.;\n]{0,160}\b(?:click|submit|form|forms|deposit|deposits|purchase|buy|order|book|reserve|save|update|delete|remove|archive|mutation|side[- ]effect|approval|permission)\b/g,
    " "
  );
  return (
    /\b(?:operator review|operator approval|operator decision|dry[- ]run|dry run)\b/.test(normalized) ||
    /\b(?:permission|approval)\b[\s\S]{0,100}\b(?:form|submit|browser action|browser mutation|mutation|side[- ]effect)\b/.test(normalized) ||
    /\b(?:form|submit|browser action|browser mutation|mutation|side[- ]effect)\b[\s\S]{0,100}\b(?:permission|approval)\b/.test(normalized) ||
    /\bapproval[- ]gated\b[\s\S]{0,80}\b(?:form|submit|browser action|mutation|side[- ]effect)\b/.test(normalized) ||
    /\b(?:form|submit|submitted|send|save|create|update|delete|remove|archive|checkout|purchase|buy|order|book|reserve|invite|accept|reject|cancel|publish|deploy|go live)\b/.test(
      normalized
    )
  );
}

function isExplicitReadOnlyBrowserInspectionInstruction(input: string): boolean {
  return (
    /\bread[- ]only\b/.test(input) &&
    /\b(?:only\s+(?:inspect|open|review|read|observe)|inspect\s+the\s+listed\s+sources|synthesize\s+a\s+recommendation|no\s+mutations?\s+performed|strictly\s+read[- ]only)\b/.test(
      input,
    ) &&
    /\b(?:do\s+not|don't|no)\b[\s\S]{0,180}\b(?:click|submit|form|deposit|purchase|buy|order|book|reserve|save|update|delete|remove|archive|mutation|side[- ]effect|approval)\b/.test(
      input,
    )
  );
}

function isReadOnlyBrowserSourceEvidenceInstruction(input: string): boolean {
  if (!/https?:\/\//i.test(input)) {
    return false;
  }
  if (
    !/\b(?:open|navigate|fetch|extract|collect|review|inspect|read|compare|research|summari[sz]e|report|identify|verify)\b/.test(
      input
    )
  ) {
    return false;
  }
  if (
    !/\b(?:source|sources|evidence|pricing|price|risk|strength|recommendation|vendor|url|page|pages|browser-visible|rendered)\b/.test(
      input
    )
  ) {
    return false;
  }
  return !hasDefiniteBrowserSideEffectCommand(input);
}

function isReadOnlySourceUrlTaskWithoutExplicitPublishIntent(input: string): boolean {
  return (
    /https?:\/\//i.test(input) &&
    hasReadOnlySourceWorkSignal(input) &&
    /\b(?:source|evidence|pricing|price|provider|search|risk|strength|review|research|compare|comparison|extract)\b/i.test(
      input
    ) &&
    !hasExplicitPublishIntent(input)
  );
}

function hasExplicitPublishIntent(input: string): boolean {
  const normalized = input.replace(
    /\b(?:do not|don't|no)\b[^.;\n]{0,180}\b(?:publish|release|deploy|go live|post publicly)\b/g,
    " "
  );
  return (
    /\bpost publicly\b|\bgo live\b/.test(normalized) ||
    /\bpublish\s+(?:this|the|a|an|draft|post|article|page|change|changes|build|version|release|announcement|note|notes)\b/.test(
      normalized
    ) ||
    /\bdeploy\s+(?:this|the|a|an|change|changes|build|version|release)\b/.test(normalized) ||
    /\brelease\s+(?:this|the|a|an|draft|post|article|page|change|changes|build|version|announcement|note|notes)\b/.test(
      normalized
    )
  );
}

function hasDefiniteBrowserSideEffectCommand(input: string): boolean {
  const normalized = input.replace(
    /\b(?:do not|don't|no)\b[^.;\n]{0,180}\b(?:click|submit|form|forms|publish|release|deploy|deposit|deposits|purchase|buy|order|book|reserve|save|update|delete|remove|archive|mutation|side[- ]effect|approval|permission)\b/g,
    " "
  );
  if (/\bgo live\b/.test(normalized)) {
    return true;
  }
  if (/\b(?:click|press|select|activate)\b[\s\S]{0,80}\b(?:submit|send|save|publish|delete|remove|checkout|purchase|buy|order|book|reserve|approve|accept|reject|cancel|deploy|release)\b/.test(normalized)) {
    return true;
  }
  return hasBrowserActionVerb(
    normalized,
    [
      "submit",
      "send",
      "save",
      "create",
      "update",
      "delete",
      "remove",
      "archive",
      "checkout",
      "purchase",
      "buy",
      "order",
      "book",
      "reserve",
      "invite",
      "approve",
      "accept",
      "reject",
      "cancel",
      "publish",
      "deploy",
      "release",
    ],
    [
      "answer",
      "summary",
      "findings",
      "report",
      "review",
      "recommendation",
      "recommendations",
      "result",
      "results",
      "date",
      "time",
      "version",
      "history",
      "status",
      "notes",
      "metadata",
      "frequency",
      "schedule",
      "cadence",
      "information",
      "info",
      "details",
      "count",
      "counts",
      "risk",
      "risks",
    ]
  );
}

function hasBrowserActionVerb(input: string, verbs: string[], readOnlyFollowers: string[]): boolean {
  const contextualReadOnlyFollowers = new Set([
    "answer",
    "answers",
    "evidence",
    "finding",
    "findings",
    "recommendation",
    "recommendations",
    "report",
    "reports",
    "result",
    "results",
    "review",
    "summary",
    "summaries",
  ]);
  for (const verb of verbs) {
    const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = input.matchAll(new RegExp(`\\b${escaped}\\b(?:\\s+([a-z][a-z_-]*))?`, "gi"));
    for (const match of matches) {
      const index = match.index ?? 0;
      if (isReadOnlyBrowserActionVerbContext(input, verb, index)) {
        continue;
      }
      if (isNegatedBrowserActionVerb(input, index)) {
        continue;
      }
      const next = match[1]?.toLowerCase();
      if (next && readOnlyFollowers.includes(next)) {
        if (
          contextualReadOnlyFollowers.has(next) &&
          !hasReadOnlyOutputFollowerContext(input, index + match[0].length)
        ) {
          return true;
        }
        continue;
      }
      return true;
    }
  }
  return false;
}

function isReadOnlyBrowserActionVerbContext(input: string, verb: string, index: number): boolean {
  if (isReadOnlyOperationalDecisionContext(input, verb, index)) {
    return true;
  }
  if (verb === "order") {
    const prefix = input.slice(Math.max(0, index - 40), index).toLowerCase();
    return /\b(?:priority|sort|sorted|display|list|ranking|ranked)\s+$/.test(prefix);
  }
  if (verb === "send" || verb === "submit") {
    if (verb === "submit" && isReadOnlySubmitNavigationCueContext(input, index)) {
      return true;
    }
    const suffix = input
      .slice(Math.max(0, index + verb.length), Math.max(0, index + verb.length + 120))
      .toLowerCase();
    return /^\s+(?:back\s+)?(?:a\s+|an\s+|the\s+|your\s+)?(?:(?:recommended\s+)?next\s+actions?|answer|summary|summar(?:y|ies)|report|findings|review|recommendation|recommendations|result|results|evidence)\b[\s\S]{0,60}\b(?:to|for)\s+(?:the\s+)?(?:operator|user|lead|requester|product leader|product lead)\b/.test(
      suffix
    );
  }
  return false;
}

function isReadOnlyOperationalDecisionContext(input: string, verb: string, index: number): boolean {
  if (!["send", "approve", "accept", "reject", "cancel"].includes(verb)) {
    return false;
  }
  const prefix = input.slice(Math.max(0, index - 90), index).toLowerCase();
  if (
    !/\b(?:whether|should|determine|identify|explain|assess|evaluate|review|check|verify)\b[\s\S]{0,80}$/.test(prefix)
  ) {
    return false;
  }
  const suffix = input.slice(index + verb.length, index + verb.length + 120).toLowerCase();
  return /^\s+(?:a\s+|an\s+|the\s+|any\s+)?(?:page|pages|pager|paging|alert|alerts|notification|notifications|escalation|incident|on-call|operator)\b/.test(
    suffix
  );
}

function isReadOnlySubmitNavigationCueContext(input: string, index: number): boolean {
  const context = input.slice(Math.max(0, index - 120), index + 80).toLowerCase();
  if (!/\b(?:navigation|nav|links?|menus?|items?|cues?|visible)\b/.test(context)) {
    return false;
  }
  const prefix = input.slice(Math.max(0, index - 40), index).toLowerCase();
  if (/\b(?:click|press|select|activate|use|follow)\b[\s\S]{0,40}$/.test(prefix)) {
    return false;
  }
  if (/\bsubmit\s+(?:form|review|report|abuse|request|order|purchase|application|changes?|data)\b/.test(context)) {
    return false;
  }
  return true;
}

function hasReadOnlyOutputFollowerContext(input: string, followerEndIndex: number): boolean {
  const suffix = input.slice(followerEndIndex, followerEndIndex + 100).toLowerCase();
  if (
    /^\s+(?:to\s+(?:the\s+)?operator|as\s+(?:a\s+)?read-only\b|for\s+(?:operator|review|analysis|evidence|summary)\b|with\s+(?:evidence|citations|sources)\b)/.test(
      suffix
    )
  ) {
    return true;
  }
  const context = input.slice(Math.max(0, followerEndIndex - 80), followerEndIndex + 80).toLowerCase();
  return /\bread-only\s+(?:answer|answers|evidence|finding|findings|recommendation|recommendations|report|reports|result|results|review|summary|summaries)\b/.test(
    context
  );
}

function isNegatedBrowserActionVerb(input: string, index: number): boolean {
  const prefix = input.slice(Math.max(0, index - 32), index).toLowerCase();
  return (
    /(?:do\s+not|don't|not|never|without|no)\s+$/.test(prefix) ||
    /(?:do\s+not|don't|never|without|no)\b(?:\s+\w+|,\s*|\s+or\s+|\s+and\s+){0,6}$/.test(prefix)
  );
}

function browserSideEffectCacheKey(threadId: string, action: string, scope: string): string {
  return `${threadId}:browser:${scope}:approval:${action}`;
}

function truncateForPermissionPayload(value: string): string {
  return value.length > 2000 ? `${value.slice(0, 1997)}...` : value;
}

async function executeSessionsSpawn(
  workerRuntime: WorkerRuntime,
  input: RoleToolExecutionInput,
  executableWorkerKinds: ReadonlySet<WorkerKind>,
  toolCancellationRegistry?: ToolCancellationRegistry,
  toolPermissionService?: ToolPermissionService,
  maxSessionToolTimeoutMs?: number,
  hardTimeoutGraceMs?: number,
  sessionConcurrency?: WorkerSessionConcurrencyLimits,
  sessionSpawnGate?: AsyncSerialGate,
  onBackgroundWorkerError?: (error: unknown, workerRunKey: string) => void,
): Promise<RoleToolExecutionResult> {
  const task = requiredString(input.call.input.task);
  const agentId = requiredString(input.call.input.agent_id) as WorkerKind | null;
  if (!task || !agentId) {
    return errorResult(input.call, "sessions_spawn requires task and agent_id");
  }
  if (!executableWorkerKinds.has(agentId)) {
    const available = [...executableWorkerKinds].join(", ") || "(none)";
    return errorResult(input.call, `Worker kind ${agentId} is not available. Available worker kinds: ${available}.`);
  }
  const effectiveAgentId = resolveEffectiveSessionSpawnWorkerKind({
    requestedAgentId: agentId,
    task,
    executableWorkerKinds,
  });
  const gate = await maybeGateBrowserSideEffect({
    input,
    workerType: effectiveAgentId,
    instruction: task,
    toolPermissionService,
  });
  if (gate?.blocked) {
    return gate.blocked;
  }
  const approvalProgress = gate?.progress ?? [];
  const label = requiredString(input.call.input.label);
  const runInBackground = input.call.input.run_in_background === true;
  const delegatedTaskPrompt = buildDelegatedTaskPrompt(
    task,
    input.activation.handoff.payload,
    gate?.approvedContext
  );
  const runtimeApprovalContext = appendRuntimeBrowserApprovalContext(
    input.packet.runtimeApprovalContext,
    gate?.approvedContext
  );
  const timeoutMs = resolveToolTimeoutMsForTask({
    value: input.call.input.timeout_seconds,
    workerKind: effectiveAgentId,
    ...(maxSessionToolTimeoutMs !== undefined ? { maxTimeoutMs: maxSessionToolTimeoutMs } : {}),
    taskText: task,
    parentTaskPrompt: input.packet.taskPrompt,
  });
  const acceptedAt = Date.now();
  const backgroundDeadlineAt = Math.min(
    acceptedAt + timeoutMs,
    input.deadlineAt ?? Number.POSITIVE_INFINITY,
  );
  const packet = {
    ...input.packet,
    taskPrompt: delegatedTaskPrompt,
    preferredWorkerKinds: [effectiveAgentId],
    continuityMode: "fresh" as const,
    ...(runtimeApprovalContext ? { runtimeApprovalContext } : {}),
    workerSession: {
      parentSessionKey: input.activation.runState.runKey,
      toolCallId: input.call.id,
      ...(label ? { label } : {}),
      ...(runInBackground
        ? { background: true, deadlineAt: backgroundDeadlineAt }
        : {}),
    },
  };
  const workerActivation = scopeWorkerActivationToToolCall(input.activation, input.call.id);
  const spawnAttempt = await (sessionSpawnGate ?? new AsyncSerialGate()).run(async () => {
    const concurrencyError = await maybeRejectSessionConcurrency(workerRuntime, input, sessionConcurrency);
    if (concurrencyError) {
      return { concurrencyError, spawned: null };
    }
    return {
      concurrencyError: null,
      spawned: await workerRuntime.spawn({ activation: workerActivation, packet }),
    };
  });
  if (spawnAttempt.concurrencyError) {
    return spawnAttempt.concurrencyError;
  }
  const spawned = spawnAttempt.spawned;
  if (!spawned) {
    return errorResult(input.call, `No worker handler available for ${effectiveAgentId}`);
  }
  const registration = toolCancellationRegistry?.register({
    threadId: input.activation.thread.threadId,
    toolCallId: input.call.id,
    toolName: input.call.name,
    cancel: async (reason) => {
      await workerRuntime.cancel({ workerRunKey: spawned.workerRunKey, reason });
    },
  });
  if (runInBackground) {
    const accepted = buildBackgroundWorkerSessionAccepted({
      taskId: input.activation.handoff.taskId,
      sessionKey: spawned.workerRunKey,
      agentId: spawned.workerType,
      label: label ?? `${spawned.workerType} sub-agent`,
      toolCallId: input.call.id,
      acceptedAt,
      deadlineAt: backgroundDeadlineAt,
    });
    const backgroundSend = workerRuntime.send({
      workerRunKey: spawned.workerRunKey,
      activation: workerActivation,
      packet,
      toolCallId: input.call.id,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    void backgroundSend
      .catch((error) => {
        if (onBackgroundWorkerError) {
          onBackgroundWorkerError(error, spawned.workerRunKey);
        } else {
          console.error("background worker execution failed", {
            workerRunKey: spawned.workerRunKey,
            error,
          });
        }
      })
      .finally(() => registration?.unregister());
    return {
      toolCallId: input.call.id,
      toolName: input.call.name,
      content: serializeBackgroundWorkerSessionAccepted(accepted),
      progress: [
        ...approvalProgress,
        {
          phase: "started",
          toolName: input.call.name,
          summary: `Started ${effectiveAgentId} background sub-agent session ${spawned.workerRunKey}.`,
          detail: {
            session_key: spawned.workerRunKey,
            agent_id: spawned.workerType,
            status: "running",
          },
        },
      ],
      raw: accepted,
    };
  }
  let result: WorkerExecutionResult | null;
  try {
    const sendResult = await sendWorkerWithOptionalCancellation(
      workerRuntime,
      {
        workerRunKey: spawned.workerRunKey,
        activation: workerActivation,
        packet,
        toolCallId: input.call.id,
      },
      timeoutMs,
      `sessions_spawn timed out after ${formatTimeoutSeconds(timeoutMs)}.`,
      hardTimeoutGraceMs,
      registration,
      input.signal
    );
    if (sendResult === WORKER_TOOL_CANCELLED) {
      return cancelledSessionToolResult(input.call, {
        taskId: input.activation.handoff.taskId,
        sessionKey: spawned.workerRunKey,
        agentId: spawned.workerType,
        reason: registration?.cancellationReason() ?? "Tool call cancelled.",
        label,
        parentSessionKey: input.activation.runState.runKey,
        toolCallId: input.call.id,
      });
    }
    if (isWorkerToolTimeout(sendResult)) {
      const timeoutState = await getWorkerStateSafely(workerRuntime, spawned.workerRunKey);
      return timedOutResult(input.call, {
        sessionKey: spawned.workerRunKey,
        agentId: spawned.workerType,
        taskId: input.activation.handoff.taskId,
        timeoutMs,
        evidenceSummary:
          extractWorkerEvidenceSummary(sendResult.lateResult) ??
          summarizeWorkerEvidence(timeoutState),
        label,
        parentSessionKey: input.activation.runState.runKey,
        toolCallId: input.call.id,
      });
    }
    if (sendResult === null) {
      const timeoutState = await getWorkerStateSafely(workerRuntime, spawned.workerRunKey);
      if (isWorkerTimeoutSummaryState(timeoutState)) {
        return timedOutResult(input.call, {
          sessionKey: spawned.workerRunKey,
          agentId: spawned.workerType,
          taskId: input.activation.handoff.taskId,
          timeoutMs,
          evidenceSummary: summarizeWorkerEvidence(timeoutState),
          label,
          parentSessionKey: input.activation.runState.runKey,
          toolCallId: input.call.id,
        });
      }
    }
    result = sendResult;
  } finally {
    registration?.unregister();
  }
  const cancelledState =
    registration?.isCancelled() || result ? null : await getCancelledWorkerState(workerRuntime, spawned.workerRunKey);
  if (registration?.isCancelled() || cancelledState) {
    return cancelledSessionToolResult(input.call, {
      taskId: input.activation.handoff.taskId,
      sessionKey: spawned.workerRunKey,
      agentId: spawned.workerType,
      reason: registration?.cancellationReason() ?? cancelledState?.lastError?.message ?? "Tool call cancelled.",
      label,
      parentSessionKey: input.activation.runState.runKey,
      toolCallId: input.call.id,
    });
  }
  const missingResultMessage = `${effectiveAgentId} sub-agent returned no executable result. The requested task did not match the worker's implemented capability.`;
  const sessionToolResult = buildSessionToolResult({
    taskId: input.activation.handoff.taskId,
    sessionKey: spawned.workerRunKey,
    agentId: spawned.workerType,
    result,
    missingResultMessage,
    label,
    parentSessionKey: input.activation.runState.runKey,
    toolCallId: input.call.id,
  });
  return {
    toolCallId: input.call.id,
    toolName: input.call.name,
    // A failed worker run is an error result even when the worker returned a
    // structured failure payload — otherwise the repeated-failure breaker
    // (findRepeatedFailedToolCall) never counts it and the message-level
    // toolStatus reads as a successful turn.
    ...(!result || isFailedOrTimedOutWorkerResult(result) ? { isError: true } : {}),
    content: serializeSessionToolResult(sessionToolResult),
    progress: [
      ...approvalProgress,
      {
        phase: "started",
        toolName: input.call.name,
        summary: `Started ${effectiveAgentId} sub-agent session ${spawned.workerRunKey}.`,
        detail: { session_key: spawned.workerRunKey, agent_id: spawned.workerType },
      },
      {
        phase: !result || isFailedOrTimedOutWorkerResult(result) ? "failed" : "completed",
        toolName: input.call.name,
        summary: result?.summary ?? missingResultMessage,
        detail: { session_key: spawned.workerRunKey, status: result?.status ?? "failed" },
      },
    ],
    raw: result,
  };
}

function resolveEffectiveSessionSpawnWorkerKind(input: {
  requestedAgentId: WorkerKind;
  task: string;
  executableWorkerKinds: ReadonlySet<WorkerKind>;
}): WorkerKind {
  if (
    input.requestedAgentId === "browser" &&
    input.executableWorkerKinds.has("explore") &&
    shouldRoutePublicReadOnlySourceTaskToExplore(input.task)
  ) {
    return "explore";
  }
  return input.requestedAgentId;
}

function shouldRoutePublicReadOnlySourceTaskToExplore(task: string): boolean {
  const normalized = task.toLowerCase();
  if (hasLocalReadOnlySourceSignal(normalized) && !hasHardBrowserRequiredSignal(normalized)) return true;
  if (!hasPublicReadOnlySourceSignal(normalized)) return false;
  if (hasBrowserRequiredSignal(normalized)) return false;
  return true;
}

function hasLocalReadOnlySourceSignal(input: string): boolean {
  return (
    /\b(?:localhost|127\.0\.0\.1|\[::1\]|::1)\b/i.test(input) &&
    /\b(?:source pages?|pricing|price|url extraction|read-only url|fetch|extract|retrieve|research|review|compare|comparison|evidence)\b/i.test(
      input
    ) &&
    /https?:\/\//i.test(input)
  );
}

function hasPublicReadOnlySourceSignal(input: string): boolean {
  return (
    /\b(?:pricing|price|docs?|documentation|source pages?|public sources?|url extraction|read-only url|fetch|extract|research|compare|comparison|evidence ledger)\b/i.test(
      input
    ) && /https?:\/\//i.test(input)
  );
}

function hasBrowserRequiredSignal(input: string): boolean {
  return /\b(?:authenticated|login|logged in|account|session|interactive|click|fill|submit|submission|form|approval|dry-run|dry run|operator review|side effect|side-effect|mutation|save|purchase|delete|update|visual|screenshot|snapshot|js-rendered|javascript-rendered|client-side|rendered dashboard|dashboard|as a user would see|browser session|active browser)\b/i.test(
    input
  );
}

function hasHardBrowserRequiredSignal(input: string): boolean {
  return /\b(?:authenticated|login|logged in|account|password|2fa|mfa|otp|credential|api key|secret|token|interactive|click|fill|submit|submission|form|approval|dry-run|dry run|operator review|side effect|side-effect|mutation|save|purchase|delete|update|visual|screenshot|snapshot|js-rendered|javascript-rendered|client-side|rendered dashboard|dashboard|as a user would see)\b/i.test(
    input
  );
}

function scopeWorkerActivationToToolCall(activation: RoleActivationInput, toolCallId: string): RoleActivationInput {
  return {
    ...activation,
    handoff: {
      ...activation.handoff,
      taskId: `${activation.handoff.taskId}:${toolCallId}`,
    },
  };
}

function buildDelegatedTaskPrompt(
  task: string,
  payload: RoleActivationInput["handoff"]["payload"],
  approvalContext?: BrowserSideEffectApprovalContext
): string {
  const hasUrl = /https?:\/\//i.test(task);
  const taskWithApproval = approvalContext ? appendBrowserApprovalContext(task, approvalContext) : task;
  const parentContext = extractDelegationParentContext(task, payload);
  if (!parentContext) {
    return taskWithApproval;
  }
  if (hasUrl && !hasMissingParentSourceUrl(taskWithApproval, parentContext)) {
    return taskWithApproval;
  }
  return [
    taskWithApproval,
    "",
    "Parent mission context relevant to this delegated task:",
    parentContext,
  ].join("\n");
}

function appendRuntimeBrowserApprovalContext(
  existing: RolePromptPacket["runtimeApprovalContext"],
  context: BrowserSideEffectApprovalContext | undefined
): RolePromptPacket["runtimeApprovalContext"] | undefined {
  if (!context) return existing;
  return {
    ...existing,
    browserSideEffects: [...(existing?.browserSideEffects ?? []), context],
  };
}

function buildBrowserSideEffectApprovalContext(
  action: string,
  scope: BrowserSideEffectApprovalContext["scope"],
  cacheKey?: string
): BrowserSideEffectApprovalContext {
  return {
    action,
    scope,
    ...(cacheKey ? { cacheKey } : {}),
  };
}

function appendBrowserApprovalContext(
  task: string,
  context: BrowserSideEffectApprovalContext
): string {
  const delegatedTask = sanitizeApprovedBrowserTaskForSubAgent(task);
  return [
    delegatedTask,
    "",
    "Runtime approval context:",
    `- The parent runtime approval is granted and the permission cache is already applied for scoped browser action ${context.action}.`,
    `- Scope: ${context.scope}.`,
    ...(context.cacheKey ? [`- Permission cache key: ${context.cacheKey}.`] : []),
    ...approvedBrowserActionInstructions(context),
  ].join("\n");
}

function sanitizeApprovedBrowserTaskForSubAgent(task: string): string {
  const keptLines = task
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isParentApprovalInstruction(line));
  const cleaned = keptLines.join("\n").trim();
  return cleaned || task;
}

function approvedBrowserActionInstructions(context: BrowserSideEffectApprovalContext): string[] {
  if (context.action === "browser.form.submit") {
    return [
      "- Required approved action: submit the local browser form under this approval.",
      "- Use browser_open and browser_snapshot as needed, then use browser_act on the submit control with submit=true.",
      "- Do not stop after inspection; verify the post-submit browser result before returning.",
    ];
  }
  return ["- Perform only this approved scoped browser action, then verify the browser result."];
}

function isParentApprovalInstruction(line: string): boolean {
  return (
    /^\s*(?:[-*]\s*)?(?:use\s+)?permission_(?:query|result|applied)\b/i.test(line) ||
    /^\s*(?:[-*]\s*)?(?:request|ask|obtain|wait for|await|requires?|need(?:s|ed)?|must have)\b.{0,80}\b(?:approval|permission)\b/i.test(
      line
    ) ||
    /\bparent agent\b.{0,80}\b(?:approval|permission)\b/i.test(line) ||
    /^\s*(?:[-*]\s*)?(?:do not|don't)\b.{0,80}\bwithout\b.{0,80}\b(?:approval|permission)\b/i.test(line)
  );
}

function extractDelegationParentContext(
  task: string,
  payload: RoleActivationInput["handoff"]["payload"]
): string | null {
  const sourceLines = [
    getInstructions(payload),
    getRelayBrief(payload),
    ...getRecentMessages(payload).map((item) => item.content),
  ]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .flatMap((item) => item.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const entries = sourceLines.flatMap((line, index) =>
    Array.from(line.matchAll(/https?:\/\/[^\s)]+/gi)).map((match) => ({
      line,
      index,
      url: sanitizeDelegationUrl(match[0] ?? ""),
      score: scoreDelegationContextLine(task, `${line} ${match[0] ?? ""}`),
    }))
  ).filter((entry) => entry.url.length > 0);
  if (entries.length === 0) {
    return null;
  }
  const selected = entries
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 6)
    .map((entry) => entry.line.includes(entry.url) ? entry.line : `${entry.line} ${entry.url}`);
  return [...new Set(selected)].join("\n");
}

function hasMissingParentSourceUrl(task: string, parentContext: string): boolean {
  const taskUrls = new Set(
    Array.from(task.matchAll(/https?:\/\/[^\s)]+/gi))
      .map((match) => sanitizeDelegationUrl(match[0] ?? ""))
      .filter(Boolean)
  );
  const primaryContextLine = parentContext.split(/\r?\n/).find((line) => /https?:\/\//i.test(line)) ?? "";
  return Array.from(primaryContextLine.matchAll(/https?:\/\/[^\s)]+/gi)).some((match) => {
    const url = sanitizeDelegationUrl(match[0] ?? "");
    return url.length > 0 && !taskUrls.has(url);
  });
}

function scoreDelegationContextLine(task: string, line: string): number {
  const normalizedLine = line.toLowerCase();
  const keywords = task
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g)
    ?.filter((word) => !DELEGATION_CONTEXT_STOP_WORDS.has(word)) ?? [];
  return keywords.reduce((score, word) => score + (normalizedLine.includes(word) ? 1 : 0), 0);
}

const DELEGATION_CONTEXT_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "source",
  "sources",
  "page",
  "pages",
  "review",
  "research",
  "compare",
  "summarize",
  "vendor",
]);

function sanitizeDelegationUrl(raw: string): string {
  return raw.replace(/["'`,;:.!?。，“”‘’！？：]+$/g, "");
}

async function executeSessionsSend(
  workerRuntime: WorkerRuntime,
  input: RoleToolExecutionInput,
  toolCancellationRegistry?: ToolCancellationRegistry,
  toolPermissionService?: ToolPermissionService,
  maxSessionToolTimeoutMs?: number,
  hardTimeoutGraceMs?: number
): Promise<RoleToolExecutionResult> {
  const requestedSessionKey = requiredString(input.call.input.session_key);
  const message = requiredString(input.call.input.message);
  if (!requestedSessionKey || !message) {
    return errorResult(input.call, "sessions_send requires session_key and message");
  }
  const requestedMode = input.call.input.mode;
  const mode = requestedMode === undefined || requestedMode === "continue"
    ? "continue"
    : requestedMode === "read_result"
      ? "read_result"
      : null;
  if (!mode) {
    return errorResult(input.call, "sessions_send mode must be continue or read_result");
  }
  // codex K3.5: enforce thread ownership before sending — without
  // this, a lead role on thread A could drive sub-agents owned by
  // thread B.
  const callerThreadId = input.activation.thread.threadId;
  const records = workerRuntime.listSessions ? await workerRuntime.listSessions() : [];
  const record = resolveWorkerSessionRecord(records, requestedSessionKey, callerThreadId);
  const sessionKey = record?.workerRunKey ?? requestedSessionKey;
  if (!record || record.context?.threadId !== callerThreadId) {
    return errorResult(input.call, `session not found: ${requestedSessionKey}`);
  }
  const state = await workerRuntime.getState(sessionKey);
  if (!state) {
    return errorResult(input.call, `session not found: ${sessionKey}`);
  }
  const label = requiredString(input.call.input.label) ?? record.context?.label ?? null;
  if (mode === "read_result") {
    if (
      state.status !== "done" ||
      !state.lastResult ||
      state.lastResult.status !== "completed"
    ) {
      return errorResult(
        input.call,
        `sessions_send read_result requires a completed session result: ${sessionKey}`
      );
    }
    return cachedCompletedSessionResult(input.call, {
      taskId: input.activation.handoff.taskId,
      sessionKey,
      result: state.lastResult,
      ...(record.context ? { context: record.context } : {}),
      label,
    });
  }
  const gate = await maybeGateBrowserSideEffect({
    input,
    workerType: state.workerType,
    instruction: message,
    toolPermissionService,
  });
  if (gate?.blocked) {
    return gate.blocked;
  }
  const approvalProgress = gate?.progress ?? [];
  const runtimeApprovalContext = appendRuntimeBrowserApprovalContext(
    input.packet.runtimeApprovalContext,
    gate?.approvedContext
  );
  const packet = {
    ...input.packet,
    taskPrompt: gate?.approvedContext ? appendBrowserApprovalContext(message, gate.approvedContext) : message,
    preferredWorkerKinds: [state.workerType],
    continuityMode: "resume-existing" as const,
    ...(runtimeApprovalContext ? { runtimeApprovalContext } : {}),
  };
  const timeoutMs = resolveContinuationToolTimeoutMsForTask({
    value: input.call.input.timeout_seconds,
    workerKind: state.workerType,
    currentStatus: state.status,
    ...(maxSessionToolTimeoutMs !== undefined ? { maxTimeoutMs: maxSessionToolTimeoutMs } : {}),
    taskText: message,
    parentTaskPrompt: input.packet.taskPrompt,
  });
  const registration = toolCancellationRegistry?.register({
    threadId: input.activation.thread.threadId,
    toolCallId: input.call.id,
    toolName: input.call.name,
    cancel: async (reason) => {
      await workerRuntime.cancel({ workerRunKey: sessionKey, reason });
    },
  });
  let result: WorkerExecutionResult | null;
  try {
    const sendResult = await sendWorkerWithOptionalCancellation(
      workerRuntime,
      {
        workerRunKey: sessionKey,
        activation: input.activation,
        packet,
        toolCallId: input.call.id,
        resumeExisting: true,
      },
      timeoutMs,
      `sessions_send timed out after ${formatTimeoutSeconds(timeoutMs)}.`,
      hardTimeoutGraceMs,
      registration,
      input.signal
    );
    if (sendResult === WORKER_TOOL_CANCELLED) {
      return cancelledSessionToolResult(input.call, {
        taskId: input.activation.handoff.taskId,
        sessionKey,
        agentId: state.workerType,
        reason: registration?.cancellationReason() ?? "Tool call cancelled.",
        label,
        parentSessionKey: record.context?.parentSessionKey ?? record.context?.parentSpanId ?? null,
        toolCallId: input.call.id,
      });
    }
    if (isWorkerToolTimeout(sendResult)) {
      const timeoutState = await getWorkerStateSafely(workerRuntime, sessionKey);
      return timedOutResult(input.call, {
        sessionKey,
        agentId: state.workerType,
        taskId: input.activation.handoff.taskId,
        timeoutMs,
        evidenceSummary:
          extractWorkerEvidenceSummary(sendResult.lateResult) ??
          summarizeWorkerEvidence(timeoutState),
        label,
        parentSessionKey: record.context?.parentSessionKey ?? record.context?.parentSpanId ?? null,
        toolCallId: input.call.id,
      });
    }
    if (sendResult === null) {
      const timeoutState = await getWorkerStateSafely(workerRuntime, sessionKey);
      if (isWorkerTimeoutSummaryState(timeoutState)) {
        return timedOutResult(input.call, {
          sessionKey,
          agentId: state.workerType,
          taskId: input.activation.handoff.taskId,
          timeoutMs,
          evidenceSummary: summarizeWorkerEvidence(timeoutState),
          label,
          parentSessionKey: record.context?.parentSessionKey ?? record.context?.parentSpanId ?? null,
          toolCallId: input.call.id,
        });
      }
    }
    result = sendResult;
  } finally {
    registration?.unregister();
  }
  const cancelledState = registration?.isCancelled() || result ? null : await getCancelledWorkerState(workerRuntime, sessionKey);
  if (registration?.isCancelled() || cancelledState) {
    return cancelledSessionToolResult(input.call, {
      taskId: input.activation.handoff.taskId,
      sessionKey,
      agentId: state.workerType,
      reason: registration?.cancellationReason() ?? cancelledState?.lastError?.message ?? "Tool call cancelled.",
      label,
      parentSessionKey: record.context?.parentSessionKey ?? record.context?.parentSpanId ?? null,
      toolCallId: input.call.id,
    });
  }
  const missingResultMessage = `${state.workerType} sub-agent returned no executable result for the follow-up.`;
  const sessionToolResult = buildSessionToolResult({
    taskId: input.activation.handoff.taskId,
    sessionKey,
    agentId: state.workerType,
    result,
    missingResultMessage,
    label,
    parentSessionKey: record.context?.parentSessionKey ?? record.context?.parentSpanId ?? null,
    toolCallId: input.call.id,
  });
  return {
    toolCallId: input.call.id,
    toolName: input.call.name,
    // Same rule as sessions_spawn: a structured failure is still an error
    // result for the breaker and message toolStatus.
    ...(!result || isFailedOrTimedOutWorkerResult(result) ? { isError: true } : {}),
    content: serializeSessionToolResult(sessionToolResult),
    progress: [
      ...approvalProgress,
      {
        phase: !result || isFailedOrTimedOutWorkerResult(result) ? "failed" : "completed",
        toolName: input.call.name,
        summary: result?.summary ?? missingResultMessage,
        detail: { session_key: sessionKey, status: result?.status ?? "failed" },
      },
    ],
    raw: result,
  };
}

function resolveWorkerSessionRecord(
  records: WorkerSessionRecord[],
  requestedSessionKey: string,
  callerThreadId: string,
  options: { allowSingletonMalformedFallback?: boolean } = { allowSingletonMalformedFallback: true }
): WorkerSessionRecord | null {
  const visibleRecords = records.filter((record) => record.context?.threadId === callerThreadId);
  const exact = visibleRecords.find((record) => record.workerRunKey === requestedSessionKey);
  if (exact) {
    return exact;
  }
  const requestedSignature = relaxedSessionKeySignature(requestedSessionKey);
  const signatureMatches = visibleRecords.filter(
    (record) => relaxedSessionKeySignature(record.workerRunKey) === requestedSignature
  );
  if (signatureMatches.length === 1) {
    return signatureMatches[0]!;
  }
  const browserSessionMatches = visibleRecords.filter((record) => {
    if (record.state.workerType !== "browser") return false;
    return decodeBrowserSessionPayload(record.state.lastResult?.payload)?.sessionId === requestedSessionKey;
  });
  if (browserSessionMatches.length === 1) {
    return browserSessionMatches[0]!;
  }
  const truncatedPrefix = readTruncatedSessionKeyPrefix(requestedSignature);
  if (truncatedPrefix) {
    const prefixMatches = visibleRecords.filter((record) =>
      relaxedSessionKeySignature(record.workerRunKey).startsWith(truncatedPrefix)
    );
    if (prefixMatches.length === 1) {
      return prefixMatches[0]!;
    }
  }
  const cleanPrefix = readCleanTruncatedSessionKeyPrefix(requestedSignature);
  if (cleanPrefix) {
    const prefixMatches = visibleRecords.filter((record) =>
      relaxedSessionKeySignature(record.workerRunKey).startsWith(cleanPrefix)
    );
    if (prefixMatches.length === 1) {
      return prefixMatches[0]!;
    }
  }
  const taskPrefix = readWorkerTaskSessionPrefix(requestedSignature);
  if (taskPrefix) {
    const taskMatches = visibleRecords.filter(
      (record) => readWorkerTaskSessionPrefix(relaxedSessionKeySignature(record.workerRunKey)) === taskPrefix
    );
    if (taskMatches.length === 1) {
      return taskMatches[0]!;
    }
  }
  if (
    options.allowSingletonMalformedFallback !== false &&
    isMalformedOrTruncatedSessionKey(requestedSessionKey) &&
    visibleRecords.length === 1
  ) {
    return visibleRecords[0]!;
  }
  return null;
}

function relaxedSessionKeySignature(sessionKey: string): string {
  return sessionKey
    .replace(/call_function_/g, "call_")
    .replace(/call_func_/g, "call_")
    .replace(/call_funct(?:ion)?(?=…|\.{3})/g, "call_")
    .replace(/call_func(?=…|\.{3})/g, "call_");
}

function readTruncatedSessionKeyPrefix(sessionKey: string): string | null {
  const ellipsisIndex = sessionKey.search(/…|\.\.\./);
  if (ellipsisIndex < 0) {
    return null;
  }
  const prefix = sessionKey.slice(0, ellipsisIndex);
  return prefix.length >= 24 ? prefix : null;
}

function readCleanTruncatedSessionKeyPrefix(sessionKey: string): string | null {
  if (/…|\.{3}|\n|\|/.test(sessionKey)) {
    return null;
  }
  if (!/^worker:[A-Za-z0-9_-]+:task[:|-][A-Za-z0-9_:-]+$/.test(sessionKey)) {
    return null;
  }
  if (!/:call_[A-Za-z0-9]{2,}$/.test(sessionKey)) {
    return null;
  }
  return sessionKey.length >= 40 ? sessionKey : null;
}

function readWorkerTaskSessionPrefix(sessionKey: string): string | null {
  const match = sessionKey.match(/^(worker:[A-Za-z0-9_-]+:task[:|-][A-Za-z0-9_-]+)(?::|$)/);
  return match?.[1] ?? null;
}

function isMalformedOrTruncatedSessionKey(sessionKey: string): boolean {
  if (/…|\.{3}|\n|\|/.test(sessionKey)) {
    return true;
  }
  return !(
    /^worker:[A-Za-z0-9_-]+:task[:|-][A-Za-z0-9_:-]+$/.test(sessionKey) ||
    /^worker:[A-Za-z0-9_-]+:existing$/.test(sessionKey)
  );
}

function cachedCompletedSessionResult(
  call: LLMToolCall,
  input: {
    taskId: string;
    sessionKey: string;
    result: WorkerExecutionResult;
    context?: { label?: string; parentSessionKey?: string; parentSpanId?: string; toolCallId?: string };
    label?: string | null;
  }
): RoleToolExecutionResult {
  const phase = mapCachedWorkerResultPhase(input.result.status);
  const sessionToolResult = buildSessionToolResult({
    taskId: input.taskId,
    sessionKey: input.sessionKey,
    agentId: input.result.workerType,
    result: input.result,
    missingResultMessage: input.result.summary,
    cached: true,
    label: input.label ?? input.context?.label ?? null,
    parentSessionKey: input.context?.parentSessionKey ?? input.context?.parentSpanId ?? null,
    toolCallId: call.id,
  });
  return {
    toolCallId: call.id,
    toolName: call.name,
    ...(isFailedOrTimedOutWorkerResult(input.result) ? { isError: true } : {}),
    content: serializeSessionToolResult(sessionToolResult),
    progress: [
      {
        phase,
        toolName: call.name,
        summary: `Reused cached ${input.result.workerType} sub-agent result with status ${input.result.status}.`,
        detail: {
          session_key: input.sessionKey,
          status: input.result.status,
          cached: true,
        },
      },
    ],
    raw: input.result,
  };
}

function mapCachedWorkerResultPhase(
  status: WorkerExecutionResult["status"]
): "completed" | "progress" | "failed" {
  return (
    status === "failed" || status === "timeout"
      ? "failed"
      : status === "partial"
        ? "progress"
        : "completed"
  );
}

function isFailedOrTimedOutWorkerResult(result: WorkerExecutionResult): boolean {
  return result.status === "failed" || result.status === "timeout";
}

async function executeSessionsList(
  workerRuntime: WorkerRuntime,
  input: RoleToolExecutionInput
): Promise<RoleToolExecutionResult> {
  // codex K3.5: filter to the calling thread. workerRuntime.listSessions
  // returns sessions from EVERY thread the daemon has ever run;
  // returning them unfiltered would let one mission's lead role see
  // and reference sub-agents owned by another mission. Records
  // without a context.threadId (legacy / pre-K3.5) are excluded —
  // the lead can't address them anyway since their lifecycle is
  // unknown.
  const callerThreadId = input.activation.thread.threadId;
  const records = workerRuntime.listSessions ? await workerRuntime.listSessions() : [];
  const kinds = stringArray(input.call.input.kinds);
  const agentId = requiredString(input.call.input.agent_id);
  // Accept both spellings: the tool's own output uses snake_case field names
  // and models copy those back as filter arguments.
  const parentSessionKey =
    requiredString(input.call.input.parent_session_key) ?? requiredString(input.call.input.parentSessionKey);
  const activeMinutes =
    positiveInteger(input.call.input.active_minutes) ?? positiveInteger(input.call.input.activeMinutes);
  const limit = positiveInteger(input.call.input.limit) ?? 20;
  const activeAfter = activeMinutes ? Date.now() - activeMinutes * 60 * 1000 : null;
  const filtered = records
    .filter((record) => record.context?.threadId === callerThreadId)
    .filter((record) => !agentId || record.state.workerType === agentId)
    .filter((record) => kinds.length === 0 || kinds.includes(record.state.workerType))
    .filter((record) => !parentSessionKey || matchesParentSessionKey(record.context, parentSessionKey))
    .filter((record) => activeAfter === null || record.state.updatedAt >= activeAfter)
    .slice(0, limit)
    .map((record) => ({
      session_key: record.workerRunKey,
      agent_id: record.state.workerType,
      status: record.state.status,
      label: record.context?.label ?? null,
      parent_session_key: record.context?.parentSessionKey ?? record.context?.parentSpanId ?? null,
      tool_call_id: record.context?.toolCallId ?? null,
      created_at: record.state.createdAt,
      last_active_at: record.state.updatedAt,
      current_task_id: record.state.currentTaskId ?? null,
      message_count: countWorkerSessionTranscriptMessages(record.workerRunKey, record.state),
    }));
  return {
    toolCallId: input.call.id,
    toolName: input.call.name,
    content: JSON.stringify(
      {
        sessions: filtered,
        inspection_guidance:
          "Use sessions_list only to choose a session key. Do not call sessions_list repeatedly in the same turn; after selecting the relevant session, inspect it once with sessions_history or continue it with sessions_send if the user asked to continue.",
      },
      null,
      2
    ),
  };
}

async function executeSessionsHistory(
  workerRuntime: WorkerRuntime,
  input: RoleToolExecutionInput
): Promise<RoleToolExecutionResult> {
  const requestedSessionKey = requiredString(input.call.input.session_key);
  if (!requestedSessionKey) {
    return errorResult(input.call, "sessions_history requires session_key");
  }
  // codex K3.5: enforce thread ownership. workerRuntime.getState
  // doesn't take a thread filter; we read the full record and reject
  // when its context.threadId doesn't match the caller. Same
  // not-found error code so the lead can't probe for foreign session
  // existence.
  const callerThreadId = input.activation.thread.threadId;
  const records = workerRuntime.listSessions ? await workerRuntime.listSessions() : [];
  // Truncated or model-abbreviated keys cannot use a direct get(id)
  // lookup. Keep this O(N) scan scoped to the caller's thread inside
  // resolveWorkerSessionRecord until WorkerRuntime grows an indexed
  // canonical-key resolver.
  const record = resolveWorkerSessionRecord(records, requestedSessionKey, callerThreadId, {
    allowSingletonMalformedFallback: false,
  });
  if (!record) {
    return errorResult(input.call, `session not found: ${requestedSessionKey}`);
  }
  const sessionKey = record.workerRunKey;
  const state = await workerRuntime.getState(sessionKey);
  if (!state) {
    return errorResult(input.call, `session not found: ${sessionKey}`);
  }
  const limit = positiveInteger(input.call.input.limit) ?? 50;
  const history = readWorkerSessionTranscript(sessionKey, state);
  const decodedCursor = decodeSessionHistoryCursor(requiredString(input.call.input.cursor), sessionKey);
  if (decodedCursor === "invalid") {
    return errorResult(input.call, "sessions_history cursor is invalid");
  }
  const tail = decodedCursor === null && input.call.input.tail === true;
  const requestedOffset = nonNegativeInteger(input.call.input.offset);
  const offset = tail
    ? Math.max(history.length - limit, 0)
    : decodedCursor?.offset ?? requestedOffset ?? 0;
  const messages = history
    .slice(offset, offset + limit)
    .map((entry) => serializeWorkerHistoryEntry(entry, input.call.input.include_tools === true));
  const nextOffset = offset + messages.length;
  const hasMore = nextOffset < history.length;
  const hasMoreBefore = offset > 0;
  const inspectionGuidance = hasMore
    ? "More later transcript entries exist. Use next_cursor only if those entries are needed for the user's current decision."
    : hasMoreBefore
      ? "This page has no later transcript entries. Use previous_cursor only if earlier entries are needed for the user's current decision; otherwise synthesize from this history."
      : "This result contains the complete available transcript for the session. Do not call sessions_history or sessions_list again for the same session in this turn; synthesize from this result or use at most one sessions_send if the user explicitly asked to continue.";
  return {
    toolCallId: input.call.id,
    toolName: input.call.name,
    content: JSON.stringify(
      {
        session_key: sessionKey,
        total_messages: history.length,
        showing: messages.length,
        offset,
        limit,
        tail,
        has_more: hasMore,
        has_more_after: hasMore,
        next_cursor: hasMore ? encodeSessionHistoryCursor(sessionKey, nextOffset) : null,
        has_more_before: hasMoreBefore,
        previous_cursor: hasMoreBefore ? encodeSessionHistoryCursor(sessionKey, Math.max(offset - limit, 0)) : null,
        inspection_guidance: inspectionGuidance,
        messages,
      },
      null,
      2
    ),
  };
}

async function executeTasksList(
  input: RoleToolExecutionInput,
  taskToolService?: TaskToolService
): Promise<RoleToolExecutionResult> {
  if (!taskToolService) {
    return errorResult(input.call, "task tool service is not configured");
  }
  const limit = Math.min(positiveInteger(input.call.input.limit) ?? 20, 50);
  return runTaskTool(input.call, "Listed mission tasks.", () =>
    taskToolService.list({
      threadId: input.activation.thread.threadId,
      roleId: input.activation.runState.roleId,
      ...(requiredString(input.call.input.mission_id) ? { missionId: requiredString(input.call.input.mission_id)! } : {}),
      ...(parseMissionStatus(input.call.input.status) ? { status: parseMissionStatus(input.call.input.status)! } : {}),
      ...(requiredString(input.call.input.agent_id) ? { agentId: requiredString(input.call.input.agent_id)! } : {}),
      limit,
    })
  );
}

async function executeTasksCreate(
  input: RoleToolExecutionInput,
  taskToolService?: TaskToolService
): Promise<RoleToolExecutionResult> {
  if (!taskToolService) {
    return errorResult(input.call, "task tool service is not configured");
  }
  const title = requiredString(input.call.input.title);
  if (!title) {
    return errorResult(input.call, "tasks_create requires title");
  }
  return runTaskTool(input.call, "Created mission task.", () =>
    taskToolService.create({
      threadId: input.activation.thread.threadId,
      roleId: input.activation.runState.roleId,
      title,
      ...(requiredString(input.call.input.mission_id) ? { missionId: requiredString(input.call.input.mission_id)! } : {}),
      ...(requiredString(input.call.input.agent_id) ? { agentId: requiredString(input.call.input.agent_id)! } : {}),
      ...(parseMissionStatus(input.call.input.status) ? { status: parseMissionStatus(input.call.input.status)! } : {}),
      ...(readStringArray(input.call.input.context_refs).length
        ? { contextRefs: readStringArray(input.call.input.context_refs) }
        : {}),
      ...(requiredString(input.call.input.output) ? { output: requiredString(input.call.input.output)! } : {}),
    })
  );
}

async function executeTasksUpdate(
  input: RoleToolExecutionInput,
  taskToolService?: TaskToolService
): Promise<RoleToolExecutionResult> {
  if (!taskToolService) {
    return errorResult(input.call, "task tool service is not configured");
  }
  const workItemId = requiredString(input.call.input.work_item_id);
  if (!workItemId) {
    return errorResult(input.call, "tasks_update requires work_item_id");
  }
  const clearBlocker = input.call.input.clear_blocker === true;
  return runTaskTool(input.call, "Updated mission task.", () =>
    taskToolService.update({
      threadId: input.activation.thread.threadId,
      roleId: input.activation.runState.roleId,
      workItemId,
      ...(requiredString(input.call.input.mission_id) ? { missionId: requiredString(input.call.input.mission_id)! } : {}),
      ...(parseMissionStatus(input.call.input.status) ? { status: parseMissionStatus(input.call.input.status)! } : {}),
      ...(requiredString(input.call.input.output) ? { output: requiredString(input.call.input.output)! } : {}),
      ...(clearBlocker ? { blocker: null } : requiredString(input.call.input.blocker) ? { blocker: requiredString(input.call.input.blocker)! } : {}),
      ...(boundedProgress(input.call.input.progress) !== null ? { progress: boundedProgress(input.call.input.progress)! } : {}),
    })
  );
}

async function runTaskTool(
  call: LLMToolCall,
  summary: string,
  operation: () => Promise<unknown>
): Promise<RoleToolExecutionResult> {
  try {
    return taskToolResult(call, await operation(), summary);
  } catch (error) {
    return errorResult(call, error instanceof Error ? error.message : String(error));
  }
}

function taskToolResult(call: LLMToolCall, result: unknown, summary: string): RoleToolExecutionResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    content: JSON.stringify(result, null, 2),
    progress: [
      {
        phase: "completed",
        toolName: call.name,
        summary,
      },
    ],
    raw: result,
  };
}

function serializeMemoryHit(hit: MemoryHit): Record<string, unknown> {
  return {
    memory_id: hit.memoryId,
    source: hit.source,
    score: Number(hit.score.toFixed(3)),
    content: hit.content,
    ...(hit.rationale ? { rationale: hit.rationale } : {}),
  };
}

function errorResult(call: LLMToolCall, content: string): RoleToolExecutionResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError: true,
    progress: [
      {
        phase: "failed",
        toolName: call.name,
        summary: content,
      },
    ],
  };
}

function cancelledSessionToolResult(
  call: LLMToolCall,
  input: {
    taskId: string;
    sessionKey: string;
    agentId: WorkerKind;
    reason: string;
    label?: string | null;
    parentSessionKey?: string | null;
    toolCallId?: string | null;
  }
): RoleToolExecutionResult {
  const sessionToolResult = buildSessionToolCancelledResult({
    taskId: input.taskId,
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    result: input.reason,
    ...(input.label ? { label: input.label } : {}),
    ...(input.parentSessionKey ? { parentSessionKey: input.parentSessionKey } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
  });
  return {
    toolCallId: call.id,
    toolName: call.name,
    content: serializeSessionToolResult(sessionToolResult),
    isError: true,
    cancelled: true,
    progress: [
      {
        phase: "cancelled",
        toolName: call.name,
        summary: input.reason,
        detail: {
          session_key: input.sessionKey,
          agent_id: input.agentId,
          status: "cancelled",
        },
      },
    ],
  };
}

async function maybeRejectSessionConcurrency(
  workerRuntime: WorkerRuntime,
  input: RoleToolExecutionInput,
  limits: WorkerSessionConcurrencyLimits | undefined
): Promise<RoleToolExecutionResult | null> {
  if (!workerRuntime.listSessions || !limits) {
    return null;
  }
  const maxPerParent =
    typeof limits.maxPerParentConcurrent === "number" &&
    Number.isFinite(limits.maxPerParentConcurrent) &&
    limits.maxPerParentConcurrent > 0
      ? Math.floor(limits.maxPerParentConcurrent)
      : null;
  const maxGlobal =
    typeof limits.maxGlobalActive === "number" &&
    Number.isFinite(limits.maxGlobalActive) &&
    limits.maxGlobalActive > 0
      ? Math.floor(limits.maxGlobalActive)
      : null;
  if (maxPerParent === null && maxGlobal === null) {
    return null;
  }
  const records = await workerRuntime.listSessions();
  const activeRecords = records.filter((record) => isActiveWorkerSession(record.state.status));
  const globalActive = activeRecords.length;
  if (maxGlobal !== null && globalActive >= maxGlobal) {
    return sessionConcurrencyLimitResult(input.call, {
      scope: "global",
      active: globalActive,
      limit: maxGlobal,
    });
  }
  if (maxPerParent === null) {
    return null;
  }
  const parentSpanId = `role:${input.activation.runState.runKey}`;
  const parentActive = activeRecords.filter(
    (record) =>
      record.context?.threadId === input.activation.thread.threadId &&
      record.context?.parentSpanId === parentSpanId
  ).length;
  if (parentActive >= maxPerParent) {
    return sessionConcurrencyLimitResult(input.call, {
      scope: "parent",
      active: parentActive,
      limit: maxPerParent,
      parentSpanId,
    });
  }
  return null;
}

function isActiveWorkerSession(status: WorkerSessionState["status"]): boolean {
  return status === "idle" || status === "running" || status === "waiting_input" || status === "waiting_external";
}

function sessionConcurrencyLimitResult(
  call: LLMToolCall,
  input: { scope: "parent" | "global"; active: number; limit: number; parentSpanId?: string }
): RoleToolExecutionResult {
  const message =
    input.scope === "global"
      ? `sub_agent_concurrency_limit: global active sub-agent limit reached (${input.active}/${input.limit}). Reuse existing sessions or wait for active work to finish.`
      : `sub_agent_concurrency_limit: parent active sub-agent limit reached (${input.active}/${input.limit}). Keep spawned work independent, reuse sessions_history/sessions_send, or wait for active work to finish.`;
  return {
    toolCallId: call.id,
    toolName: call.name,
    isError: true,
    content: JSON.stringify(
      {
        status: "sub_agent_concurrency_limit",
        scope: input.scope,
        active_sessions: input.active,
        limit: input.limit,
        ...(input.parentSpanId ? { parent_span_id: input.parentSpanId } : {}),
        result: message,
      },
      null,
      2
    ),
    progress: [
      {
        phase: "failed",
        toolName: call.name,
        summary: message,
        detail: {
          status: "sub_agent_concurrency_limit",
          scope: input.scope,
          active_sessions: input.active,
          limit: input.limit,
        },
      },
    ],
  };
}

function timedOutResult(
  call: LLMToolCall,
  input: {
    sessionKey: string;
    agentId: WorkerKind;
    taskId: string;
    timeoutMs: number | null;
    evidenceSummary?: string | null;
    label?: string | null;
    parentSessionKey?: string | null;
    toolCallId?: string | null;
  }
): RoleToolExecutionResult {
  const timeoutSeconds = input.timeoutMs == null ? null : Number((input.timeoutMs / 1_000).toFixed(3));
  const message =
    timeoutSeconds == null
      ? "Sub-agent session timed out."
      : `Sub-agent session timed out after ${formatTimeoutSeconds(input.timeoutMs)}.`;
  const evidenceSummary = sanitizeEvidenceSummary(input.evidenceSummary);
  const evidenceAvailable = evidenceSummary != null;
  const result =
    `${message} ${
      evidenceAvailable
        ? "The session is resumable, but do not call another tool just to recover from this timeout; synthesize from the evidence summary unless the user asks to continue."
        : "No usable evidence was gathered before timeout; do not spawn fallback tools for this timeout. Produce a bounded final answer that says verification did not complete, or wait for the user to continue."
    } ` +
    "Do not treat the timeout itself as evidence." +
    (evidenceSummary ? ` Current evidence summary: ${evidenceSummary}` : "");
  return {
    toolCallId: call.id,
    toolName: call.name,
    isError: true,
    content: serializeSessionToolResult(
      buildSessionToolTimeoutResult({
        taskId: input.taskId,
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        result,
        timeoutSeconds,
        evidenceSummary,
        ...(input.label ? { label: input.label } : {}),
        ...(input.parentSessionKey ? { parentSessionKey: input.parentSessionKey } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      })
    ),
    progress: [
      {
        phase: "failed",
        toolName: call.name,
        summary: message,
        detail: {
          session_key: input.sessionKey,
          agent_id: input.agentId,
          status: "timeout",
          evidence_available: evidenceAvailable,
          ...(timeoutSeconds == null ? {} : { timeout_seconds: timeoutSeconds }),
        },
      },
    ],
  };
}

function summarizeWorkerEvidence(state: WorkerSessionState | null): string | null {
  return summarizeWorkerSessionEvidence(state);
}

async function getWorkerStateSafely(workerRuntime: WorkerRuntime, workerRunKey: string): Promise<WorkerSessionState | null> {
  try {
    return await workerRuntime.getState(workerRunKey);
  } catch {
    return null;
  }
}

async function getCancelledWorkerState(workerRuntime: WorkerRuntime, workerRunKey: string): Promise<WorkerSessionState | null> {
  const state = await getWorkerStateSafely(workerRuntime, workerRunKey);
  return state?.status === "cancelled" ? state : null;
}

function isWorkerTimeoutSummaryState(state: WorkerSessionState | null): state is WorkerSessionState {
  return state?.status === "resumable" && state.continuationDigest?.reason === "timeout_summary";
}

async function sendWorkerWithOptionalTimeout(
  workerRuntime: WorkerRuntime,
  input: {
    workerRunKey: string;
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    toolCallId?: string;
    resumeExisting?: boolean;
  },
  timeoutMs: number | null,
  timeoutReason: string,
  hardTimeoutGraceMs = DEFAULT_WORKER_TOOL_HARD_ABORT_GRACE_MS,
  cancellationPromise?: Promise<typeof WORKER_TOOL_CANCELLED>,
  abortSignal?: AbortSignal
): Promise<WorkerExecutionResult | null | WorkerToolTimeout | typeof WORKER_TOOL_CANCELLED> {
  const executeWorker = (): Promise<WorkerExecutionResult | null> =>
    input.resumeExisting
      ? workerRuntime.resume({
          workerRunKey: input.workerRunKey,
          activation: input.activation,
          packet: input.packet,
          ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        })
      : workerRuntime.send(input);
  const sendPromise = executeWorker();
  sendPromise.catch(() => {
    // The caller may already have received a timeout or cancellation result
    // while the interrupted worker is still unwinding. Keep observing that
    // original send so a later rejection cannot terminate the daemon.
  });
  const graceMs =
    typeof hardTimeoutGraceMs === "number" && Number.isFinite(hardTimeoutGraceMs) && hardTimeoutGraceMs >= 0
      ? Math.floor(hardTimeoutGraceMs)
      : DEFAULT_WORKER_TOOL_HARD_ABORT_GRACE_MS;
  const abortWatcher = createWorkerAbortWatcher(workerRuntime, input, sendPromise, abortSignal, graceMs);
  if (timeoutMs === null) {
    try {
      return await Promise.race([
        sendPromise,
        ...(cancellationPromise ? [cancellationPromise] : []),
        ...(abortWatcher ? [abortWatcher.promise] : []),
      ]);
    } finally {
      abortWatcher?.dispose();
    }
  }
  let softTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let softTimeoutFired = false;
  const foregroundSendPromise = sendPromise.then(
    (result) =>
      softTimeoutFired
        ? new Promise<WorkerExecutionResult | null>(() => undefined)
        : result,
    (error) => {
      if (softTimeoutFired) {
        return new Promise<WorkerExecutionResult | null>(() => undefined);
      }
      throw error;
    },
  );
  const timeoutPromise = new Promise<WorkerToolTimeout>((resolve) => {
    softTimeoutHandle = setTimeout(() => {
      softTimeoutFired = true;
      void workerRuntime
        .interrupt({ workerRunKey: input.workerRunKey, reason: timeoutReason, preserveLateResult: true })
        .then(() => raceTimeoutSummary(sendPromise, graceMs))
        .then(async (lateResult) => {
          if (lateResult?.status === "partial") {
            return lateResult;
          }
          return runWorkerTimeoutSummaryPass(
            workerRuntime,
            input,
            timeoutReason,
            graceMs,
          );
        })
        .catch((error) => {
          console.error("worker timeout interrupt failed", {
            workerRunKey: input.workerRunKey,
            error,
          });
          return null;
        })
        .then((lateResult) =>
          resolve({ kind: WORKER_TOOL_TIMEOUT, lateResult }),
        );
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      foregroundSendPromise,
      timeoutPromise,
      ...(cancellationPromise ? [cancellationPromise] : []),
      ...(abortWatcher ? [abortWatcher.promise] : []),
    ]);
  } finally {
    abortWatcher?.dispose();
    if (!softTimeoutFired) {
      if (softTimeoutHandle) {
        clearTimeout(softTimeoutHandle);
      }
    }
  }
}

async function sendWorkerWithOptionalCancellation(
  workerRuntime: WorkerRuntime,
  input: {
    workerRunKey: string;
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    toolCallId?: string;
    resumeExisting?: boolean;
  },
  timeoutMs: number | null,
  timeoutReason: string,
  hardTimeoutGraceMs: number | undefined,
  registration: ToolCancellationRegistration | undefined,
  abortSignal?: AbortSignal
): Promise<WorkerExecutionResult | null | WorkerToolTimeout | typeof WORKER_TOOL_CANCELLED> {
  if (!registration) {
    return sendWorkerWithOptionalTimeout(
      workerRuntime,
      input,
      timeoutMs,
      timeoutReason,
      hardTimeoutGraceMs,
      undefined,
      abortSignal
    );
  }
  const cancellationPromise: Promise<typeof WORKER_TOOL_CANCELLED> = registration
    .cancelled()
    .then(() => WORKER_TOOL_CANCELLED);
  const sendPromise = sendWorkerWithOptionalTimeout(
    workerRuntime,
    input,
    timeoutMs,
    timeoutReason,
    hardTimeoutGraceMs,
    cancellationPromise,
    abortSignal
  );
  const result = await Promise.race([sendPromise, cancellationPromise]);
  if (result === WORKER_TOOL_CANCELLED) {
    sendPromise.catch(() => {
      // The worker may still be unwinding after the parent tool result has
      // already been cancelled. Observe late rejection to keep the daemon up.
    });
  }
  return result;
}

function createWorkerAbortWatcher(
  workerRuntime: WorkerRuntime,
  input: {
    workerRunKey: string;
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    toolCallId?: string;
    resumeExisting?: boolean;
  },
  sendPromise: Promise<WorkerExecutionResult | null>,
  signal: AbortSignal | undefined,
  graceMs: number
):
  | {
      promise: Promise<WorkerExecutionResult | WorkerToolTimeout | typeof WORKER_TOOL_CANCELLED>;
      dispose(): void;
    }
  | null {
  if (!signal) {
    return null;
  }
  let onAbort: (() => void) | null = null;
  const runAbort = async (): Promise<WorkerExecutionResult | WorkerToolTimeout | typeof WORKER_TOOL_CANCELLED> => {
    const reason = readAbortReason(signal, "Tool call aborted.");
    if (isToolLoopWallClockAbort(reason)) {
      await workerRuntime.interrupt({ workerRunKey: input.workerRunKey, reason, preserveLateResult: true });
      const lateResult = await raceTimeoutSummary(sendPromise, graceMs);
      const timeoutSummary =
        lateResult ??
        (await runWorkerTimeoutSummaryPass(
          workerRuntime,
          input,
          reason,
          graceMs,
        ));
      return { kind: WORKER_TOOL_TIMEOUT, lateResult: timeoutSummary };
    }
    await workerRuntime.cancel({ workerRunKey: input.workerRunKey, reason });
    return WORKER_TOOL_CANCELLED;
  };
  const recoverAbortFailure = (error: unknown): typeof WORKER_TOOL_CANCELLED => {
    console.error("worker abort failed", {
      workerRunKey: input.workerRunKey,
      error,
    });
    return WORKER_TOOL_CANCELLED;
  };
  const promise: Promise<WorkerExecutionResult | WorkerToolTimeout | typeof WORKER_TOOL_CANCELLED> = signal.aborted
    ? runAbort().catch(recoverAbortFailure)
    : new Promise<WorkerExecutionResult | WorkerToolTimeout | typeof WORKER_TOOL_CANCELLED>((resolve) => {
        onAbort = () => {
          void runAbort()
            .catch(recoverAbortFailure)
            .then(resolve);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
  return {
    promise,
    dispose() {
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function isWorkerToolTimeout(value: unknown): value is WorkerToolTimeout {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === WORKER_TOOL_TIMEOUT
  );
}

function readAbortReason(signal: AbortSignal, fallback: string): string {
  const reason = signal.reason;
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message.trim();
  }
  return fallback;
}

function isToolLoopWallClockAbort(reason: string): boolean {
  return /tool-use wall-clock budget reached/i.test(reason);
}

async function runWorkerTimeoutSummaryPass(
  workerRuntime: WorkerRuntime,
  input: {
    workerRunKey: string;
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    toolCallId?: string;
    resumeExisting?: boolean;
  },
  timeoutReason: string,
  summaryGraceMs: number
): Promise<WorkerExecutionResult | null> {
  const state = await getWorkerStateSafely(workerRuntime, input.workerRunKey);
  if (!isLlmSubAgentSession(state)) {
    return null;
  }
  const timeoutSummaryPacket = buildTimeoutSummaryPacket(input.packet, timeoutReason);
  const timeoutSummaryPromise = input.resumeExisting
    ? workerRuntime.resume({ ...input, packet: timeoutSummaryPacket })
    : workerRuntime.send({ ...input, packet: timeoutSummaryPacket });
  return raceTimeoutSummary(timeoutSummaryPromise, summaryGraceMs);
}

async function raceTimeoutSummary(
  summaryPromise: Promise<WorkerExecutionResult | null>,
  summaryGraceMs: number
): Promise<WorkerExecutionResult | null> {
  const graceMs =
    typeof summaryGraceMs === "number" && Number.isFinite(summaryGraceMs) && summaryGraceMs >= 0
      ? Math.floor(summaryGraceMs)
      : DEFAULT_WORKER_TIMEOUT_SUMMARY_GRACE_MS;
  summaryPromise.catch(() => {
    // If the no-tools summary pass exceeds its grace window, it may still
    // reject later while the parent has already moved on with timeout
    // recovery. Observe it to preserve process liveness.
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), graceMs);
  });
  try {
    return await Promise.race([summaryPromise, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function buildTimeoutSummaryPacket(packet: RolePromptPacket, timeoutReason: string): RolePromptPacket {
  return {
    ...packet,
    taskPrompt: [
      "The previous sub-agent run reached its timeout boundary.",
      `Timeout reason: ${timeoutReason}`,
      "",
      "Produce an evidence-only timeout summary from this session's existing transcript/state.",
      "Do not call tools. Do not browse, search, click, fetch, mutate, or spawn sessions.",
      "If no verified evidence is present, say that no usable evidence was gathered.",
      "Return only verified facts, remaining uncertainty, and the best continuation point.",
    ].join("\n"),
    outputContract: [
      "Return a concise timeout summary for the parent agent.",
      "Use only evidence already present in the child session.",
      "Mark missing or unverified claims as not verified.",
    ].join("\n"),
    continuityMode: "resume-existing",
    toolUseMode: "disabled",
  };
}

function isLlmSubAgentSession(state: WorkerSessionState | null): boolean {
  if (!state) {
    return false;
  }
  if (isLlmSubAgentPayload(state.lastResult?.payload)) {
    return true;
  }
  return (state.history ?? []).some(
    (entry) =>
      entry.metadata?.kind === "assistant_tool_call" ||
      entry.metadata?.kind === "tool_progress" ||
      entry.metadata?.kind === "tool_result" ||
      entry.metadata?.kind === "assistant_final" ||
      isLlmSubAgentPayload(entry.payload)
  );
}

function isLlmSubAgentPayload(value: unknown): boolean {
  return isRecord(value) && value.mode === "llm_sub_agent";
}

function encodeSessionHistoryCursor(sessionKey: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, session_key: sessionKey, offset }), "utf8").toString("base64url");
}

function decodeSessionHistoryCursor(
  value: string | null,
  sessionKey: string
): { offset: number } | "invalid" | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!isRecord(decoded)) return "invalid";
    const offset = nonNegativeInteger(decoded.offset);
    if (decoded.v !== 1 || decoded.session_key !== sessionKey || offset === null) {
      return "invalid";
    }
    return { offset };
  } catch {
    return "invalid";
  }
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parsePermissionLevel(value: unknown): "confirm" | "approval" | null {
  return value === "confirm" || value === "approval" ? value : null;
}

function parsePermissionScope(value: unknown): "navigate" | "mutate" | "publish" | "credential" | null {
  switch (value) {
    case "navigate":
    case "mutate":
    case "publish":
    case "credential":
      return value;
    default:
      return null;
  }
}

function parseWorkerKind(value: unknown): WorkerKind | null {
  return typeof value === "string" && value.trim().length > 0 ? (value.trim() as WorkerKind) : null;
}

function parseMissionStatus(value: unknown):
  | "draft"
  | "planning"
  | "working"
  | "needs_approval"
  | "blocked"
  | "done"
  | "archived"
  | null {
  switch (value) {
    case "draft":
    case "planning":
    case "working":
    case "needs_approval":
    case "blocked":
    case "done":
    case "archived":
      return value;
    default:
      return null;
  }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function parseToolTimeoutMs(value: unknown, maxTimeoutMs?: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const configuredMaxSeconds =
    typeof maxTimeoutMs === "number" && Number.isFinite(maxTimeoutMs) && maxTimeoutMs > 0
      ? maxTimeoutMs / 1_000
      : MAX_SESSION_TOOL_TIMEOUT_SECONDS;
  const boundedSeconds = Math.min(value, configuredMaxSeconds, MAX_SESSION_TOOL_TIMEOUT_SECONDS);
  return Math.max(1, Math.round(boundedSeconds * 1_000));
}

function resolveToolTimeoutMs(value: unknown, workerKind: WorkerKind, maxTimeoutMs?: number): number {
  const explicitTimeoutMs = parseToolTimeoutMs(value, maxTimeoutMs);
  if (explicitTimeoutMs !== null) {
    return explicitTimeoutMs;
  }
  return boundDefaultToolTimeoutMs(
    defaultToolTimeoutMs(workerKind),
    maxTimeoutMs
  );
}

function resolveToolTimeoutMsForTask(input: {
  value: unknown;
  workerKind: WorkerKind;
  maxTimeoutMs?: number;
  taskText: string;
  parentTaskPrompt: string;
}): number {
  if (input.workerKind === "browser" && isSupplementalLocalTimeoutProbeTask(input.taskText)) {
    return Math.max(
      parseToolTimeoutMs(input.value, undefined) ?? 0,
      SUPPLEMENTAL_LOCAL_TIMEOUT_BROWSER_PROBE_TIMEOUT_MS
    );
  }
  const timeoutMs = resolveToolTimeoutMs(input.value, input.workerKind, input.maxTimeoutMs);
  return applyLocalBrowserTaskTimeoutFloors(timeoutMs, input);
}

function resolveContinuationToolTimeoutMs(
  value: unknown,
  workerKind: WorkerKind,
  currentStatus: WorkerSessionState["status"],
  maxTimeoutMs?: number
): number {
  const timeoutMs = resolveToolTimeoutMs(value, workerKind, maxTimeoutMs);
  if (currentStatus !== "cancelled") {
    return Math.min(
      timeoutMs,
      boundDefaultToolTimeoutMs(DEFAULT_RESUMABLE_CONTINUATION_TOOL_TIMEOUT_MS, maxTimeoutMs)
    );
  }
  return Math.max(timeoutMs, boundDefaultToolTimeoutMs(defaultToolTimeoutMs(workerKind), maxTimeoutMs));
}

function resolveContinuationToolTimeoutMsForTask(input: {
  value: unknown;
  workerKind: WorkerKind;
  currentStatus: WorkerSessionState["status"];
  maxTimeoutMs?: number;
  taskText: string;
  parentTaskPrompt: string;
}): number {
  const timeoutMs = resolveContinuationToolTimeoutMs(
    input.value,
    input.workerKind,
    input.currentStatus,
    input.maxTimeoutMs
  );
  return applyLocalBrowserTaskTimeoutFloors(timeoutMs, input);
}

function applyLocalBrowserTaskTimeoutFloors(
  timeoutMs: number,
  input: { workerKind: WorkerKind; maxTimeoutMs?: number; taskText: string; parentTaskPrompt: string }
): number {
  if (input.workerKind !== "browser") {
    return timeoutMs;
  }
  if (isSlowLoopbackBrowserTask(input.taskText)) {
    return Math.max(timeoutMs, boundDefaultToolTimeoutMs(MAX_BROWSER_OPEN_TIMEOUT_MS, input.maxTimeoutMs));
  }
  if (isLocalApprovalBrowserTask(input.taskText, input.parentTaskPrompt)) {
    return Math.max(timeoutMs, boundDefaultToolTimeoutMs(LOCAL_APPROVAL_BROWSER_TASK_TIMEOUT_MS, input.maxTimeoutMs));
  }
  return timeoutMs;
}

function isSlowLoopbackBrowserTask(taskText: string): boolean {
  if (!/\b(?:slow[-\s]?source|slow[-\s]?fixture|bounded|does not finish|doesn't finish|timeout|wait boundedly|loading in time)\b/i.test(taskText)) {
    return false;
  }
  const urls = taskText.match(/https?:\/\/[^\s)]+/gi) ?? [];
  return urls.some(isLoopbackUrl);
}

function isSupplementalLocalTimeoutProbeTask(taskText: string): boolean {
  return /\bsupplemental local timeout probe\b/i.test(taskText);
}

function isLocalApprovalBrowserTask(taskText: string, parentTaskPrompt: string): boolean {
  const text = `${parentTaskPrompt}\n${taskText}`;
  if (!/\b(?:approval|approve|approved|permission|dry[-\s]?run|form|submit|browser\.form\.submit)\b/i.test(text)) {
    return false;
  }
  const urls = text.match(/https?:\/\/[^\s)]+/gi) ?? [];
  return urls.some(isLoopbackUrl);
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const parsed = new URL(sanitizeDelegationUrl(raw));
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function defaultToolTimeoutMs(workerKind: WorkerKind): number {
  if (workerKind === "browser") {
    return DEFAULT_BROWSER_SESSION_TOOL_TIMEOUT_MS;
  }
  if (workerKind === "explore" || workerKind === "finance") {
    return DEFAULT_EXPLORE_SESSION_TOOL_TIMEOUT_MS;
  }
  return DEFAULT_GENERAL_SESSION_TOOL_TIMEOUT_MS;
}

function boundDefaultToolTimeoutMs(defaultTimeoutMs: number, maxTimeoutMs?: number): number {
  const configuredMaxMs =
    typeof maxTimeoutMs === "number" && Number.isFinite(maxTimeoutMs) && maxTimeoutMs > 0
      ? maxTimeoutMs
      : MAX_SESSION_TOOL_TIMEOUT_SECONDS * 1_000;
  return Math.max(1, Math.min(defaultTimeoutMs, configuredMaxMs, MAX_SESSION_TOOL_TIMEOUT_SECONDS * 1_000));
}

function formatTimeoutSeconds(timeoutMs: number | null): string {
  if (timeoutMs === null) {
    return "the configured timeout";
  }
  const seconds = timeoutMs / 1_000;
  return `${Number(seconds.toFixed(3))}s`;
}

function clampWebFetchMaxChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1200;
  }
  return Math.max(200, Math.min(4000, Math.floor(value)));
}

async function webFetchWithRedirects(
  fetchFn: typeof fetch,
  inputUrl: string,
  signal: AbortSignal | undefined,
  redirectCount = 0
): Promise<{ response: Response; finalUrl: string }> {
  if (signal?.aborted) {
    throw new Error(typeof signal.reason === "string" ? signal.reason : "web_fetch cancelled");
  }
  const response = await fetchFn(inputUrl, {
    redirect: "manual",
    headers: {
      "user-agent": "turnkeyai/0.1 web_fetch",
      accept: "text/html, text/plain, application/xhtml+xml, application/xml;q=0.9, */*;q=0.5",
    },
    ...(signal ? { signal } : {}),
  });
  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= 3) {
      throw new Error(`too many redirects for ${inputUrl}`);
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`redirect without location for ${inputUrl}`);
    }
    const nextUrl = validatePublicWebFetchUrl(new URL(location, inputUrl).toString());
    return webFetchWithRedirects(fetchFn, nextUrl, signal, redirectCount + 1);
  }
  return { response, finalUrl: inputUrl };
}

function parseFetchedPage(input: {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  body: string;
  maxChars: number;
}): {
  status: "ok" | "http_error";
  requested_url: string;
  final_url: string;
  status_code: number;
  content_type: string;
  title: string;
  text_excerpt: string;
} {
  const titleMatch = input.body.match(/<title[^>]*>([^<]+)<\/title>/i);
  const text = stripFetchedHtml(input.body).slice(0, input.maxChars);
  return {
    status: input.statusCode >= 200 && input.statusCode < 300 ? "ok" : "http_error",
    requested_url: input.requestedUrl,
    final_url: input.finalUrl,
    status_code: input.statusCode,
    content_type: input.contentType,
    title: decodeBasicHtmlEntities(titleMatch?.[1]?.trim() ?? ""),
    text_excerpt: decodeBasicHtmlEntities(text),
  };
}

function stripFetchedHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<(?:p|div|li|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeBasicHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function validatePublicWebFetchUrl(inputUrl: string): string {
  const parsed = new URL(inputUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported web_fetch URL protocol: ${parsed.protocol}`);
  }

  const hostname = normalizeWebFetchHostname(parsed.hostname);
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.startsWith("127.") ||
    hostname.endsWith(".local") ||
    hostname === "0.0.0.0" ||
    hostname === "169.254.169.254" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
    hostname.startsWith("169.254.") ||
    hostname.startsWith("fe80:") ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd")
  ) {
    throw new Error(`blocked web_fetch URL host: ${hostname}`);
  }
  return parsed.toString();
}

function normalizeWebFetchHostname(hostname: string): string {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return parseWebFetchIpv4MappedIpv6Host(normalized) ?? normalized;
}

function parseWebFetchIpv4MappedIpv6Host(hostname: string): string | null {
  const dotted = hostname.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) {
    return dotted[1];
  }

  const hex = hostname.match(/^(?:::ffff:|::ffff:0:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex?.[1] || !hex[2]) {
    return null;
  }
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    return null;
  }
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function boundedProgress(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function matchesParentSessionKey(
  recordContext: { parentSpanId?: string; parentSessionKey?: string } | undefined,
  parentSessionKey: string
): boolean {
  const explicit = recordContext?.parentSessionKey;
  if (explicit) {
    return explicit === parentSessionKey || `role:${explicit}` === parentSessionKey;
  }
  const parentSpanId = recordContext?.parentSpanId;
  return parentSpanId === parentSessionKey || parentSpanId === `role:${parentSessionKey}`;
}
