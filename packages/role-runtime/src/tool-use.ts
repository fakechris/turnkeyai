import type {
  LLMContentBlock,
  LLMMessage,
  LLMToolCall,
  LLMToolDefinition,
} from "@turnkeyai/llm-adapter/index";
import type {
  RoleActivationInput,
  RuntimeProgressRecorder,
  WorkerExecutionResult,
  WorkerSessionHistoryEntry,
  WorkerSessionState,
  WorkerKind,
  WorkerRuntime,
} from "@turnkeyai/core-types/team";

import type { RolePromptPacket } from "./prompt-policy";
import {
  createNativeToolCapabilityRegistry,
  type ToolCapabilityRegistry,
} from "./tool-capability-registry";
import type { ToolCancellationRegistry } from "./tool-cancellation-registry";
import type { ToolPermissionService } from "./tool-permission-service";

export interface RoleToolExecutionInput {
  call: LLMToolCall;
  activation: RoleActivationInput;
  packet: RolePromptPacket;
}

export interface RoleToolExecutionResult {
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
  cancelled?: boolean;
  progress?: RoleToolProgressEvent[];
  raw?: unknown;
}

export interface RoleToolProgressEvent {
  phase: "started" | "progress" | "completed" | "failed" | "cancelled";
  toolName: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface RoleToolExecutor {
  definitions(): LLMToolDefinition[];
  execute(input: RoleToolExecutionInput): Promise<RoleToolExecutionResult>;
}

export interface RoleToolLoopOptions {
  executor: RoleToolExecutor;
  maxRounds?: number;
  runtimeProgressRecorder?: RuntimeProgressRecorder;
}

export const DEFAULT_ROLE_TOOL_MAX_ROUNDS = 8;

export function appendAssistantToolCallMessage(
  messages: LLMMessage[],
  input: { text: string; contentBlocks?: LLMContentBlock[]; toolCalls: LLMToolCall[] }
): LLMMessage[] {
  const contentBlocks =
    input.contentBlocks && input.contentBlocks.length > 0
      ? input.contentBlocks
      : [
          ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
          ...input.toolCalls.map((call) => ({
            type: "tool_use" as const,
            id: call.id,
            name: call.name,
            input: call.input,
          })),
        ];
  return [
    ...messages,
    {
      role: "assistant",
      content: contentBlocks,
    },
  ];
}

export function appendToolResultMessages(
  messages: LLMMessage[],
  results: RoleToolExecutionResult[]
): LLMMessage[] {
  return [
    ...messages,
    ...results.map((result) => ({
      role: "tool" as const,
      name: result.toolName,
      toolCallId: result.toolCallId,
      content: [
        {
          type: "tool_result" as const,
          toolUseId: result.toolCallId,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        },
      ],
    })),
  ];
}

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

export function createWorkerSessionToolExecutor(options: {
  workerRuntime: WorkerRuntime;
  availableWorkerKinds?: WorkerKind[];
  toolCapabilityRegistry?: ToolCapabilityRegistry;
  toolCancellationRegistry?: ToolCancellationRegistry;
  toolPermissionService?: ToolPermissionService;
}): RoleToolExecutor {
  const { workerRuntime } = options;
  const toolCapabilityRegistry =
    options.toolCapabilityRegistry ??
    createNativeToolCapabilityRegistry({
      ...(options.availableWorkerKinds ? { availableWorkerKinds: options.availableWorkerKinds } : {}),
      permissionsEnabled: Boolean(options.toolPermissionService),
    });
  const definitions = toolCapabilityRegistry.definitions();
  return {
    definitions() {
      return definitions;
    },

    async execute(input) {
      switch (input.call.name) {
        case "sessions_spawn":
          return executeSessionsSpawn(workerRuntime, input, options.toolCancellationRegistry);
        case "sessions_send":
          return executeSessionsSend(workerRuntime, input, options.toolCancellationRegistry);
        case "sessions_list":
          return executeSessionsList(workerRuntime, input);
        case "sessions_history":
          return executeSessionsHistory(workerRuntime, input);
        case "permission_query":
          return executePermissionQuery(input, options.toolPermissionService);
        case "permission_result":
          return executePermissionResult(input, options.toolPermissionService);
        case "permission_applied":
          return executePermissionApplied(input, options.toolPermissionService);
        default:
          return {
            toolCallId: input.call.id,
            toolName: input.call.name,
            isError: true,
            content: `Unknown tool: ${input.call.name}`,
          };
      }
    },
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
  const role = input.activation.thread.roles.find((item) => item.roleId === input.activation.runState.roleId);
  const cacheKey = requiredString(input.call.input.cache_key);
  const workerType = parseWorkerKind(input.call.input.worker_kind);
  const missionId = requiredString(input.call.input.mission_id);
  const affects = readStringArray(input.call.input.affects);
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
      ...(workerType ? { workerType } : {}),
    },
    ...(missionId ? { missionId } : {}),
    ...(affects.length ? { affects } : {}),
    ...(isRecord(input.call.input.payload) ? { payload: input.call.input.payload } : {}),
  });
  return {
    toolCallId: input.call.id,
    toolName: input.call.name,
    content: JSON.stringify(result, null, 2),
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
    content: JSON.stringify(result, null, 2),
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
    content: JSON.stringify(result, null, 2),
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

async function executeSessionsSpawn(
  workerRuntime: WorkerRuntime,
  input: RoleToolExecutionInput,
  toolCancellationRegistry?: ToolCancellationRegistry
): Promise<RoleToolExecutionResult> {
  const task = requiredString(input.call.input.task);
  const agentId = requiredString(input.call.input.agent_id) as WorkerKind | null;
  if (!task || !agentId) {
    return errorResult(input.call, "sessions_spawn requires task and agent_id");
  }
  const packet = {
    ...input.packet,
    taskPrompt: task,
    preferredWorkerKinds: [agentId],
    continuityMode: "fresh" as const,
  };
  const spawned = await workerRuntime.spawn({ activation: input.activation, packet });
  if (!spawned) {
    return errorResult(input.call, `No worker handler available for ${agentId}`);
  }
  const registration = toolCancellationRegistry?.register({
    threadId: input.activation.thread.threadId,
    toolCallId: input.call.id,
    toolName: input.call.name,
    cancel: async (reason) => {
      await workerRuntime.cancel({ workerRunKey: spawned.workerRunKey, reason });
    },
  });
  let result: WorkerExecutionResult | null;
  try {
    result = await workerRuntime.send({
      workerRunKey: spawned.workerRunKey,
      activation: input.activation,
      packet,
    });
  } finally {
    registration?.unregister();
  }
  if (registration?.isCancelled()) {
    return cancelledResult(input.call, registration.cancellationReason() ?? "Tool call cancelled.");
  }
  const missingResultMessage = `${agentId} sub-agent returned no executable result. The requested task did not match the worker's implemented capability.`;
  return {
    toolCallId: input.call.id,
    toolName: input.call.name,
    ...(result ? {} : { isError: true }),
    content: JSON.stringify(
      {
        task_id: input.activation.handoff.taskId,
        session_key: spawned.workerRunKey,
        agent_id: spawned.workerType,
        status: result?.status ?? "failed",
        tool_chain: result ? [result.workerType] : [],
        result: result?.summary ?? missingResultMessage,
        payload: result?.payload ?? null,
      },
      null,
      2
    ),
    progress: [
      {
        phase: "started",
        toolName: input.call.name,
        summary: `Started ${agentId} sub-agent session ${spawned.workerRunKey}.`,
        detail: { session_key: spawned.workerRunKey, agent_id: spawned.workerType },
      },
      {
        phase: !result || result.status === "failed" ? "failed" : "completed",
        toolName: input.call.name,
        summary: result?.summary ?? missingResultMessage,
        detail: { session_key: spawned.workerRunKey, status: result?.status ?? "failed" },
      },
    ],
    raw: result,
  };
}

async function executeSessionsSend(
  workerRuntime: WorkerRuntime,
  input: RoleToolExecutionInput,
  toolCancellationRegistry?: ToolCancellationRegistry
): Promise<RoleToolExecutionResult> {
  const sessionKey = requiredString(input.call.input.session_key);
  const message = requiredString(input.call.input.message);
  if (!sessionKey || !message) {
    return errorResult(input.call, "sessions_send requires session_key and message");
  }
  // codex K3.5: enforce thread ownership before sending — without
  // this, a lead role on thread A could drive sub-agents owned by
  // thread B.
  const callerThreadId = input.activation.thread.threadId;
  const record = workerRuntime.listSessions
    ? (await workerRuntime.listSessions()).find((r) => r.workerRunKey === sessionKey)
    : null;
  if (!record || record.context?.threadId !== callerThreadId) {
    return errorResult(input.call, `session not found: ${sessionKey}`);
  }
  const state = await workerRuntime.getState(sessionKey);
  if (!state) {
    return errorResult(input.call, `session not found: ${sessionKey}`);
  }
  const packet = {
    ...input.packet,
    taskPrompt: message,
    preferredWorkerKinds: [state.workerType],
    continuityMode: "resume-existing" as const,
  };
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
    result = await workerRuntime.send({
      workerRunKey: sessionKey,
      activation: input.activation,
      packet,
    });
  } finally {
    registration?.unregister();
  }
  if (registration?.isCancelled()) {
    return cancelledResult(input.call, registration.cancellationReason() ?? "Tool call cancelled.");
  }
  const missingResultMessage = `${state.workerType} sub-agent returned no executable result for the follow-up.`;
  return {
    toolCallId: input.call.id,
    toolName: input.call.name,
    ...(result ? {} : { isError: true }),
    content: JSON.stringify(
      {
        task_id: input.activation.handoff.taskId,
        session_key: sessionKey,
        agent_id: state.workerType,
        status: result?.status ?? "failed",
        tool_chain: result ? [result.workerType] : [],
        result: result?.summary ?? missingResultMessage,
        payload: result?.payload ?? null,
      },
      null,
      2
    ),
    progress: [
      {
        phase: !result || result.status === "failed" ? "failed" : "completed",
        toolName: input.call.name,
        summary: result?.summary ?? missingResultMessage,
        detail: { session_key: sessionKey, status: result?.status ?? "failed" },
      },
    ],
    raw: result,
  };
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
  const parentSessionKey = requiredString(input.call.input.parentSessionKey);
  const activeMinutes = positiveInteger(input.call.input.activeMinutes);
  const limit = positiveInteger(input.call.input.limit) ?? 20;
  const activeAfter = activeMinutes ? Date.now() - activeMinutes * 60 * 1000 : null;
  const filtered = records
    .filter((record) => record.context?.threadId === callerThreadId)
    .filter((record) => !agentId || record.state.workerType === agentId)
    .filter((record) => kinds.length === 0 || kinds.includes(record.state.workerType))
    .filter((record) => !parentSessionKey || matchesParentSessionKey(record.context?.parentSpanId, parentSessionKey))
    .filter((record) => activeAfter === null || record.state.updatedAt >= activeAfter)
    .slice(0, limit)
    .map((record) => ({
      session_key: record.workerRunKey,
      agent_id: record.state.workerType,
      status: record.state.status,
      created_at: record.state.createdAt,
      last_active_at: record.state.updatedAt,
      current_task_id: record.state.currentTaskId ?? null,
      message_count: record.state.history?.length ?? (record.state.lastResult ? 1 : 0),
    }));
  return {
    toolCallId: input.call.id,
    toolName: input.call.name,
    content: JSON.stringify({ sessions: filtered }, null, 2),
  };
}

async function executeSessionsHistory(
  workerRuntime: WorkerRuntime,
  input: RoleToolExecutionInput
): Promise<RoleToolExecutionResult> {
  const sessionKey = requiredString(input.call.input.session_key);
  if (!sessionKey) {
    return errorResult(input.call, "sessions_history requires session_key");
  }
  // codex K3.5: enforce thread ownership. workerRuntime.getState
  // doesn't take a thread filter; we read the full record and reject
  // when its context.threadId doesn't match the caller. Same
  // not-found error code so the lead can't probe for foreign session
  // existence.
  const callerThreadId = input.activation.thread.threadId;
  const record = workerRuntime.listSessions
    ? (await workerRuntime.listSessions()).find((r) => r.workerRunKey === sessionKey)
    : null;
  if (!record || record.context?.threadId !== callerThreadId) {
    return errorResult(input.call, `session not found: ${sessionKey}`);
  }
  const state = await workerRuntime.getState(sessionKey);
  if (!state) {
    return errorResult(input.call, `session not found: ${sessionKey}`);
  }
  const offset = nonNegativeInteger(input.call.input.offset) ?? 0;
  const limit = positiveInteger(input.call.input.limit) ?? 50;
  const history =
    state.history && state.history.length > 0
      ? state.history
      : [
          ...(state.lastResult
            ? [createLegacyWorkerHistoryEntry(sessionKey, state)]
            : []),
        ];
  const messages = history
    .slice(offset, offset + limit)
    .map((entry) => serializeWorkerHistoryEntry(entry, input.call.input.include_tools === true));
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
        has_more: offset + messages.length < history.length,
        messages,
      },
      null,
      2
    ),
  };
}

function createLegacyWorkerHistoryEntry(
  sessionKey: string,
  state: WorkerSessionState
): WorkerSessionHistoryEntry {
  return {
    id: `worker-history:${sessionKey}:legacy-result`,
    role: "tool",
    toolName: state.workerType,
    status: state.lastResult!.status,
    content: state.lastResult!.summary,
    payload: state.lastResult!.payload,
    createdAt: state.updatedAt,
    ...(state.currentTaskId ? { taskId: state.currentTaskId } : {}),
  };
}

function serializeWorkerHistoryEntry(entry: WorkerSessionHistoryEntry, includePayload: boolean): Record<string, unknown> {
  return {
    id: entry.id,
    role: entry.role,
    content: entry.content,
    created_at: entry.createdAt,
    ...(entry.taskId ? { task_id: entry.taskId } : {}),
    ...(entry.toolName ? { name: entry.toolName } : {}),
    ...(entry.status ? { status: entry.status } : {}),
    ...(includePayload && "payload" in entry ? { payload: entry.payload } : {}),
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

function cancelledResult(call: LLMToolCall, content: string): RoleToolExecutionResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError: true,
    cancelled: true,
    progress: [
      {
        phase: "cancelled",
        toolName: call.name,
        summary: content,
      },
    ],
  };
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

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function matchesParentSessionKey(parentSpanId: string | undefined, parentSessionKey: string): boolean {
  return parentSpanId === parentSessionKey || parentSpanId === `role:${parentSessionKey}`;
}
