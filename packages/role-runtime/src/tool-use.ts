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
import type { MemoryHit, RoleMemoryResolver } from "./context/role-memory-resolver";
import type { TaskToolService } from "./task-tool-service";
import type { ToolCancellationRegistry } from "./tool-cancellation-registry";
import type {
  ToolPermissionAppliedResult,
  ToolPermissionDecisionResult,
  ToolPermissionQueryResult,
  ToolPermissionService,
} from "./tool-permission-service";

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
const MAX_SESSION_TOOL_TIMEOUT_SECONDS = 900;
const TOOL_PERMISSION_WAIT_MS = 15 * 60 * 1000;
const WORKER_TOOL_TIMEOUT = Symbol("worker_tool_timeout");

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
  taskToolService?: TaskToolService;
  memoryResolver?: Pick<RoleMemoryResolver, "retrieveMemory" | "getMemory">;
}): RoleToolExecutor {
  const { workerRuntime } = options;
  const toolCapabilityRegistry =
    options.toolCapabilityRegistry ??
    createNativeToolCapabilityRegistry({
      ...(options.availableWorkerKinds ? { availableWorkerKinds: options.availableWorkerKinds } : {}),
      permissionsEnabled: Boolean(options.toolPermissionService),
      memoryEnabled: Boolean(options.memoryResolver),
      tasksEnabled: Boolean(options.taskToolService),
    });
  const definitions = toolCapabilityRegistry.definitions();
  const executableWorkerKinds = new Set(toolCapabilityRegistry.availableWorkerKinds());
  return {
    definitions() {
      return definitions;
    },

    async execute(input) {
      switch (input.call.name) {
        case "sessions_spawn":
          return executeSessionsSpawn(
            workerRuntime,
            input,
            executableWorkerKinds,
            options.toolCancellationRegistry,
            options.toolPermissionService
          );
        case "sessions_send":
          return executeSessionsSend(workerRuntime, input, options.toolCancellationRegistry, options.toolPermissionService);
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
        case "memory_search":
          return executeMemorySearch(input, options.memoryResolver);
        case "memory_get":
          return executeMemoryGet(input, options.memoryResolver);
        case "tasks_list":
          return executeTasksList(input, options.taskToolService);
        case "tasks_create":
          return executeTasksCreate(input, options.taskToolService);
        case "tasks_update":
          return executeTasksUpdate(input, options.taskToolService);
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

interface BrowserSideEffectGateOutcome {
  blocked?: RoleToolExecutionResult;
  progress?: RoleToolProgressEvent[];
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
  const risk = classifyBrowserSideEffect(input.instruction);
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
        timeoutMs: TOOL_PERMISSION_WAIT_MS,
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
  if (/\b(password|2fa|mfa|otp|credential|api key|secret|token)\b/.test(normalized)) {
    return {
      action: "browser.credential.access",
      scope: "credential",
      title: "Use browser credentials",
      risk: "May expose or use account credentials or authentication secrets.",
    };
  }
  if (
    /\b(post publicly|go live)\b/.test(normalized) ||
    hasBrowserActionVerb(
      normalized,
      ["publish", "deploy", "release"],
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
      ["date", "time", "version", "history", "status", "frequency", "metadata", "count", "counts", "stats", "statistics"]
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

function hasBrowserActionVerb(input: string, verbs: string[], readOnlyFollowers: string[]): boolean {
  for (const verb of verbs) {
    const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = input.match(new RegExp(`\\b${escaped}\\b(?:\\s+([a-z][a-z_-]*))?`, "i"));
    if (!match) continue;
    if (isNegatedBrowserActionVerb(input, match.index ?? 0)) {
      continue;
    }
    const next = match[1]?.toLowerCase();
    if (next && readOnlyFollowers.includes(next)) {
      continue;
    }
    return true;
  }
  return false;
}

function isNegatedBrowserActionVerb(input: string, index: number): boolean {
  const prefix = input.slice(Math.max(0, index - 32), index).toLowerCase();
  return /(?:do\s+not|don't|not|never|without|no)\s+$/.test(prefix);
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
  toolPermissionService?: ToolPermissionService
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
  const gate = await maybeGateBrowserSideEffect({
    input,
    workerType: agentId,
    instruction: task,
    toolPermissionService,
  });
  if (gate?.blocked) {
    return gate.blocked;
  }
  const approvalProgress = gate?.progress ?? [];
  const packet = {
    ...input.packet,
    taskPrompt: task,
    preferredWorkerKinds: [agentId],
    continuityMode: "fresh" as const,
  };
  const workerActivation = scopeWorkerActivationToToolCall(input.activation, input.call.id);
  const timeoutMs = parseToolTimeoutMs(input.call.input.timeout_seconds);
  const spawned = await workerRuntime.spawn({ activation: workerActivation, packet });
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
    const sendResult = await sendWorkerWithOptionalTimeout(
      workerRuntime,
      {
        workerRunKey: spawned.workerRunKey,
        activation: workerActivation,
        packet,
        toolCallId: input.call.id,
      },
      timeoutMs,
      `sessions_spawn timed out after ${formatTimeoutSeconds(timeoutMs)}.`
    );
    if (sendResult === WORKER_TOOL_TIMEOUT) {
      return timedOutResult(input.call, {
        sessionKey: spawned.workerRunKey,
        agentId: spawned.workerType,
        taskId: input.activation.handoff.taskId,
        timeoutMs,
      });
    }
    result = sendResult;
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
      ...approvalProgress,
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

function scopeWorkerActivationToToolCall(activation: RoleActivationInput, toolCallId: string): RoleActivationInput {
  return {
    ...activation,
    handoff: {
      ...activation.handoff,
      taskId: `${activation.handoff.taskId}:${toolCallId}`,
    },
  };
}

async function executeSessionsSend(
  workerRuntime: WorkerRuntime,
  input: RoleToolExecutionInput,
  toolCancellationRegistry?: ToolCancellationRegistry,
  toolPermissionService?: ToolPermissionService
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
  const packet = {
    ...input.packet,
    taskPrompt: message,
    preferredWorkerKinds: [state.workerType],
    continuityMode: "resume-existing" as const,
  };
  const timeoutMs = parseToolTimeoutMs(input.call.input.timeout_seconds);
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
    const sendResult = await sendWorkerWithOptionalTimeout(
      workerRuntime,
      {
        workerRunKey: sessionKey,
        activation: input.activation,
        packet,
        toolCallId: input.call.id,
      },
      timeoutMs,
      `sessions_send timed out after ${formatTimeoutSeconds(timeoutMs)}.`
    );
    if (sendResult === WORKER_TOOL_TIMEOUT) {
      return timedOutResult(input.call, {
        sessionKey,
        agentId: state.workerType,
        taskId: input.activation.handoff.taskId,
        timeoutMs,
      });
    }
    result = sendResult;
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
      ...approvalProgress,
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
    ...(entry.toolCallId ? { tool_call_id: entry.toolCallId } : {}),
    ...(entry.toolName ? { name: entry.toolName } : {}),
    ...(entry.status ? { status: entry.status } : {}),
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
    ...(includePayload && "payload" in entry ? { payload: entry.payload } : {}),
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

function timedOutResult(
  call: LLMToolCall,
  input: { sessionKey: string; agentId: WorkerKind; taskId: string; timeoutMs: number | null }
): RoleToolExecutionResult {
  const timeoutSeconds = input.timeoutMs == null ? null : Number((input.timeoutMs / 1_000).toFixed(3));
  const message =
    timeoutSeconds == null
      ? "Sub-agent session timed out."
      : `Sub-agent session timed out after ${formatTimeoutSeconds(input.timeoutMs)}.`;
  return {
    toolCallId: call.id,
    toolName: call.name,
    isError: true,
    content: JSON.stringify(
      {
        task_id: input.taskId,
        session_key: input.sessionKey,
        agent_id: input.agentId,
        status: "timeout",
        timeout_seconds: timeoutSeconds,
        resumable: true,
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
          session_key: input.sessionKey,
          agent_id: input.agentId,
          status: "timeout",
          ...(timeoutSeconds == null ? {} : { timeout_seconds: timeoutSeconds }),
        },
      },
    ],
  };
}

async function sendWorkerWithOptionalTimeout(
  workerRuntime: WorkerRuntime,
  input: {
    workerRunKey: string;
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    toolCallId?: string;
  },
  timeoutMs: number | null,
  timeoutReason: string
): Promise<WorkerExecutionResult | null | typeof WORKER_TOOL_TIMEOUT> {
  if (timeoutMs === null) {
    return workerRuntime.send(input);
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timeoutFired = false;
  const timeoutPromise = new Promise<typeof WORKER_TOOL_TIMEOUT>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timeoutFired = true;
      void workerRuntime
        .interrupt({ workerRunKey: input.workerRunKey, reason: timeoutReason })
        .catch((error) => {
          console.error("worker timeout interrupt failed", {
            workerRunKey: input.workerRunKey,
            error,
          });
        })
        .finally(() => resolve(WORKER_TOOL_TIMEOUT));
    }, timeoutMs);
  });
  try {
    return await Promise.race([workerRuntime.send(input), timeoutPromise]);
  } finally {
    if (!timeoutFired && timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
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

function parseToolTimeoutMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const boundedSeconds = Math.min(value, MAX_SESSION_TOOL_TIMEOUT_SECONDS);
  return Math.max(1, Math.round(boundedSeconds * 1_000));
}

function formatTimeoutSeconds(timeoutMs: number | null): string {
  if (timeoutMs === null) {
    return "the configured timeout";
  }
  const seconds = timeoutMs / 1_000;
  return `${Number(seconds.toFixed(3))}s`;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function boundedProgress(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function matchesParentSessionKey(parentSpanId: string | undefined, parentSessionKey: string): boolean {
  return parentSpanId === parentSessionKey || parentSpanId === `role:${parentSessionKey}`;
}
