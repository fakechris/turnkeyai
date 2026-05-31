import type {
  LLMContentBlock,
  LLMMessage,
  LLMToolCall,
  LLMToolDefinition,
} from "@turnkeyai/llm-adapter/index";
import {
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
import {
  buildSessionToolCancelledResult,
  buildSessionToolResult,
  buildSessionToolTimeoutResult,
  serializeSessionToolResult,
  sanitizeEvidenceSummary,
} from "./session-tool-result-protocol";
import {
  countWorkerSessionTranscriptMessages,
  readWorkerSessionTranscript,
  serializeWorkerHistoryEntry,
  summarizeWorkerSessionEvidence,
} from "./worker-session-transcript";

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
  skipped?: boolean;
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
const TOOL_PERMISSION_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_WORKER_TOOL_HARD_ABORT_GRACE_MS = 60_000;
const DEFAULT_WORKER_TIMEOUT_SUMMARY_GRACE_MS = 60_000;
const WORKER_TOOL_TIMEOUT = Symbol("worker_tool_timeout");

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
  maxSessionToolTimeoutMs?: number;
  hardTimeoutGraceMs?: number;
  sessionConcurrency?: WorkerSessionConcurrencyLimits;
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
      ...(options.maxSessionToolTimeoutMs
        ? { maxSessionToolTimeoutSeconds: options.maxSessionToolTimeoutMs / 1_000 }
        : {}),
      permissionsEnabled: Boolean(options.toolPermissionService),
      memoryEnabled: Boolean(options.memoryResolver),
      tasksEnabled: Boolean(options.taskToolService),
    });
  const definitions = toolCapabilityRegistry.definitions();
  const executableWorkerKinds = new Set(toolCapabilityRegistry.availableWorkerKinds());
  const sessionSpawnGate = new AsyncSerialGate();
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
            options.toolPermissionService,
            options.maxSessionToolTimeoutMs,
            options.hardTimeoutGraceMs,
            options.sessionConcurrency,
            sessionSpawnGate
          );
        case "sessions_send":
          return executeSessionsSend(
            workerRuntime,
            input,
            options.toolCancellationRegistry,
            options.toolPermissionService,
            options.maxSessionToolTimeoutMs,
            options.hardTimeoutGraceMs
          );
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
  if (verb === "order") {
    const prefix = input.slice(Math.max(0, index - 40), index).toLowerCase();
    return /\b(?:priority|sort|sorted|display|list|ranking|ranked)\s+$/.test(prefix);
  }
  return false;
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
  toolPermissionService?: ToolPermissionService,
  maxSessionToolTimeoutMs?: number,
  hardTimeoutGraceMs?: number,
  sessionConcurrency?: WorkerSessionConcurrencyLimits,
  sessionSpawnGate?: AsyncSerialGate
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
  const label = requiredString(input.call.input.label);
  const delegatedTaskPrompt = buildDelegatedTaskPrompt(
    task,
    input.activation.handoff.payload,
    gate?.approvedContext
  );
  const runtimeApprovalContext = appendRuntimeBrowserApprovalContext(
    input.packet.runtimeApprovalContext,
    gate?.approvedContext
  );
  const packet = {
    ...input.packet,
    taskPrompt: delegatedTaskPrompt,
    preferredWorkerKinds: [agentId],
    continuityMode: "fresh" as const,
    ...(runtimeApprovalContext ? { runtimeApprovalContext } : {}),
    workerSession: {
      parentSessionKey: input.activation.runState.runKey,
      toolCallId: input.call.id,
      ...(label ? { label } : {}),
    },
  };
  const workerActivation = scopeWorkerActivationToToolCall(input.activation, input.call.id);
  const timeoutMs = resolveToolTimeoutMs(input.call.input.timeout_seconds, agentId, maxSessionToolTimeoutMs);
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
      `sessions_spawn timed out after ${formatTimeoutSeconds(timeoutMs)}.`,
      hardTimeoutGraceMs
    );
    if (sendResult === WORKER_TOOL_TIMEOUT) {
      const timeoutState = await getWorkerStateSafely(workerRuntime, spawned.workerRunKey);
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
  const missingResultMessage = `${agentId} sub-agent returned no executable result. The requested task did not match the worker's implemented capability.`;
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
    ...(result ? {} : { isError: true }),
    content: serializeSessionToolResult(sessionToolResult),
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

function buildDelegatedTaskPrompt(
  task: string,
  payload: RoleActivationInput["handoff"]["payload"],
  approvalContext?: BrowserSideEffectApprovalContext
): string {
  const hasUrl = /https?:\/\//i.test(task);
  const taskWithApproval = approvalContext ? appendBrowserApprovalContext(task, approvalContext) : task;
  if (hasUrl) return taskWithApproval;
  const parentContext = extractDelegationParentContext(task, payload);
  if (!parentContext) {
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
  return [
    task,
    "",
    "Runtime approval context:",
    `- The parent runtime approval is granted and the permission cache is already applied for scoped browser action ${context.action}.`,
    `- Scope: ${context.scope}.`,
    ...(context.cacheKey ? [`- Permission cache key: ${context.cacheKey}.`] : []),
    "- Perform only this approved scoped browser action, then verify the browser result.",
  ].join("\n");
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
  if (state.status === "done" && state.lastResult && isCachedSummaryRequest(message)) {
    return cachedCompletedSessionResult(input.call, {
      taskId: input.activation.handoff.taskId,
      sessionKey,
      result: state.lastResult,
      context: record.context,
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
  const timeoutMs = resolveContinuationToolTimeoutMs(
    input.call.input.timeout_seconds,
    state.workerType,
    state.status,
    maxSessionToolTimeoutMs
  );
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
        resumeExisting: true,
      },
      timeoutMs,
      `sessions_send timed out after ${formatTimeoutSeconds(timeoutMs)}.`,
      hardTimeoutGraceMs
    );
    if (sendResult === WORKER_TOOL_TIMEOUT) {
      const timeoutState = await getWorkerStateSafely(workerRuntime, sessionKey);
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
    ...(result ? {} : { isError: true }),
    content: serializeSessionToolResult(sessionToolResult),
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

function resolveWorkerSessionRecord(
  records: WorkerSessionRecord[],
  requestedSessionKey: string,
  callerThreadId: string
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
  const truncatedPrefix = readTruncatedSessionKeyPrefix(requestedSignature);
  if (truncatedPrefix) {
    const prefixMatches = visibleRecords.filter((record) =>
      relaxedSessionKeySignature(record.workerRunKey).startsWith(truncatedPrefix)
    );
    if (prefixMatches.length === 1) {
      return prefixMatches[0]!;
    }
  }
  if (isMalformedOrTruncatedSessionKey(requestedSessionKey) && visibleRecords.length === 1) {
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

function isMalformedOrTruncatedSessionKey(sessionKey: string): boolean {
  if (/…|\.{3}|\n|\|/.test(sessionKey)) {
    return true;
  }
  return !/^worker:[A-Za-z0-9_-]+:task[:|-][A-Za-z0-9_:-]+$/.test(sessionKey);
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
    ...(input.result.status === "failed" ? { isError: true } : {}),
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

function isCachedSummaryRequest(message: string): boolean {
  const normalized = message.toLowerCase();
  const englishSummaryOnlyAsk =
    /\b(return|provide|give|summari[sz]e|recap|produce|extract)\b/.test(normalized) &&
    /\b(final|complete|summary|report|result|plain text|findings|evidence|overview|conclusion|key points)\b/.test(normalized);
  const chineseSummaryOnlyAsk =
    /(提取|总结|汇总|概括|返回|给出|提供|整理|复述)/.test(message) &&
    /(最终|完整|总结|摘要|报告|结果|结论|证据|要点|核心)/.test(message);
  const isSummaryOnlyAsk = englishSummaryOnlyAsk || chineseSummaryOnlyAsk;
  const includesFreshWork =
    /\b(new|another|additional|recheck|re-run|rerun|visit|open|fetch|search|click|navigate|update|create|submit|delete|purchase|send)\b/.test(
      normalized
    ) || /(重新|再次|新的|继续查|访问|打开|抓取|搜索|点击|导航|更新|创建|提交|删除|购买|发送)/.test(message);
  return isSummaryOnlyAsk && !includesFreshWork;
}

function mapCachedWorkerResultPhase(
  status: WorkerExecutionResult["status"]
): "completed" | "progress" | "failed" {
  return (
    status === "failed" ? "failed" : status === "partial" ? "progress" : "completed"
  );
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
  hardTimeoutGraceMs = DEFAULT_WORKER_TOOL_HARD_ABORT_GRACE_MS
): Promise<WorkerExecutionResult | null | typeof WORKER_TOOL_TIMEOUT> {
  const executeWorker = (): Promise<WorkerExecutionResult | null> =>
    input.resumeExisting
      ? workerRuntime.resume({
          workerRunKey: input.workerRunKey,
          activation: input.activation,
          packet: input.packet,
          ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        })
      : workerRuntime.send(input);
  if (timeoutMs === null) {
    return executeWorker();
  }
  const graceMs =
    typeof hardTimeoutGraceMs === "number" && Number.isFinite(hardTimeoutGraceMs) && hardTimeoutGraceMs >= 0
      ? Math.floor(hardTimeoutGraceMs)
      : DEFAULT_WORKER_TOOL_HARD_ABORT_GRACE_MS;
  let softTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let hardTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let hardTimeoutFired = false;
  const sendPromise = executeWorker();
  sendPromise.catch(() => {
    // The caller may already have received a timeout result while the
    // interrupted worker is still unwinding. Keep observing that original
    // send so a later rejection cannot terminate the daemon.
  });
  const timeoutPromise = new Promise<WorkerExecutionResult | typeof WORKER_TOOL_TIMEOUT>((resolve) => {
    softTimeoutHandle = setTimeout(() => {
      hardTimeoutHandle = setTimeout(() => {
        hardTimeoutFired = true;
        void workerRuntime
          .interrupt({ workerRunKey: input.workerRunKey, reason: timeoutReason })
          .then(() => runWorkerTimeoutSummaryPass(workerRuntime, input, timeoutReason, graceMs))
          .catch((error) => {
            console.error("worker timeout interrupt failed", {
              workerRunKey: input.workerRunKey,
              error,
            });
            return null;
          })
          .then(() => resolve(WORKER_TOOL_TIMEOUT));
      }, graceMs);
    }, timeoutMs);
  });
  try {
    return await Promise.race([sendPromise, timeoutPromise]);
  } finally {
    if (!hardTimeoutFired) {
      if (softTimeoutHandle) {
        clearTimeout(softTimeoutHandle);
      }
      if (hardTimeoutHandle) {
        clearTimeout(hardTimeoutHandle);
      }
    }
  }
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
    typeof summaryGraceMs === "number" && Number.isFinite(summaryGraceMs) && summaryGraceMs > 0
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
  return parseToolTimeoutMs(value, maxTimeoutMs) ?? boundDefaultToolTimeoutMs(defaultToolTimeoutMs(workerKind), maxTimeoutMs);
}

function resolveContinuationToolTimeoutMs(
  value: unknown,
  workerKind: WorkerKind,
  currentStatus: WorkerSessionState["status"],
  maxTimeoutMs?: number
): number {
  const timeoutMs = resolveToolTimeoutMs(value, workerKind, maxTimeoutMs);
  if (currentStatus !== "cancelled") {
    return timeoutMs;
  }
  return Math.max(timeoutMs, boundDefaultToolTimeoutMs(defaultToolTimeoutMs(workerKind), maxTimeoutMs));
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
