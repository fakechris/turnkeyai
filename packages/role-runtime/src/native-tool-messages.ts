import type { RoleActivationInput, TeamMessage } from "@turnkeyai/core-types/team";
import type { RoleToolExecutionResult } from "./tool-use";
import { parseSessionToolResult } from "./session-tool-result-protocol";

export interface NativeToolTrace {
  rounds: NativeToolRoundTrace[];
}

export interface NativeToolRoundTrace {
  round: number;
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  results: NativeToolResultTrace[];
  progress?: NativeToolProgressTrace[];
}

export interface NativeToolResultTrace {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  contentBytes: number;
  content?: string;
  contentTruncated?: boolean;
  cancelled?: boolean;
  skipped?: boolean;
}

export interface NativeToolProgressTrace {
  toolCallId: string;
  toolName: string;
  phase: NonNullable<TeamMessage["toolProgress"]>[number]["phase"];
  summary: string;
  detail?: Record<string, unknown>;
  ts: number;
}

export function canonicalizeSessionToolTraceCalls(
  roundTrace: NativeToolRoundTrace,
  toolResults: RoleToolExecutionResult[],
): boolean {
  let changed = false;
  for (const result of toolResults) {
    if (
      result.toolName !== "sessions_send" &&
      result.toolName !== "sessions_history"
    ) {
      continue;
    }
    const parsed = parseSessionToolResult(result.content);
    if (!parsed?.session_key) {
      continue;
    }
    const call = roundTrace.calls.find((item) => item.id === result.toolCallId);
    if (!call || call.input.session_key === parsed.session_key) {
      continue;
    }
    call.input = {
      ...call.input,
      session_key: parsed.session_key,
    };
    changed = true;
  }
  return changed;
}

export function countNativeToolCalls(rounds: NativeToolRoundTrace[]): number {
  return rounds.reduce((sum, round) => sum + round.calls.length, 0);
}

export function buildNativeToolMessages(
  input: RoleActivationInput,
  metadata: Record<string, unknown>,
  baseTimestamp: number
): TeamMessage[] {
  const trace = parseToolUseTrace(metadata.toolUse);
  if (!trace || trace.rounds.length === 0) {
    return [];
  }

  const role = input.thread.roles.find((item) => item.roleId === input.runState.roleId);
  const roleName = role?.name ?? input.runState.roleId;
  const route = role?.seat === "lead" ? "lead-role" : "member-worker";
  const messages: TeamMessage[] = [];
  let ordinal = 0;

  for (const round of trace.rounds) {
    const roundToolCalls = round.calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.input,
    }));
    const roundProgress = buildRoundToolProgress(round, baseTimestamp + ordinal);
    const roundTimeCost = computeProgressTimeCost(roundProgress);
    const assistantToolMessage: TeamMessage = {
      id: `${input.handoff.taskId}:tool-round:${round.round}:assistant`,
      threadId: input.thread.threadId,
      role: "assistant",
      roleId: input.runState.roleId,
      name: roleName,
      content: "",
      createdAt: baseTimestamp + ordinal,
      updatedAt: baseTimestamp + ordinal,
      source: {
        type: "worker",
        chatType: "group",
        route,
        speakerType: "Role",
        speakerName: roleName,
      },
      toolCalls: roundToolCalls,
      toolProgress: roundProgress,
      toolStatus:
        round.results.length < round.calls.length
          ? "pending"
          : round.results.some((result) => result.cancelled)
              ? "cancelled"
              : round.results.some((result) => result.isError && !result.skipped)
                ? "failed"
                : "completed",
      ...(roundTimeCost > 0 ? { timeCost: roundTimeCost } : {}),
      metadata: {
        activationType: input.handoff.activationType,
        flowId: input.flow.flowId,
        runtimeMode: "policy-driven",
        nativeToolUse: true,
        toolRound: round.round,
      },
    };
    messages.push(assistantToolMessage);
    ordinal += 1;

    for (const result of round.results) {
      const content = result.content ?? "";
      const toolTimeCost = computeProgressTimeCost(
        roundProgress.filter((progress) => progress.toolCallId === result.toolCallId)
      );
      const toolMessage: TeamMessage = {
        id: `${input.handoff.taskId}:tool-round:${round.round}:result:${result.toolCallId}`,
        threadId: input.thread.threadId,
        role: "tool",
        roleId: input.runState.roleId,
        name: result.toolName,
        content,
        createdAt: baseTimestamp + ordinal,
        updatedAt: baseTimestamp + ordinal,
        source: {
          type: "worker",
          chatType: "group",
          route: "worker",
          speakerType: "Tool",
          speakerName: result.toolName,
        },
        toolCallId: result.toolCallId,
        toolStatus: result.cancelled ? "cancelled" : result.isError ? "failed" : "completed",
        ...(toolTimeCost > 0 ? { timeCost: toolTimeCost } : {}),
        metadata: {
          activationType: input.handoff.activationType,
          flowId: input.flow.flowId,
          runtimeMode: "policy-driven",
          nativeToolUse: true,
          toolRound: round.round,
          toolName: result.toolName,
          contentBytes: result.contentBytes,
          ...(result.skipped ? { admission: "skipped" } : {}),
          ...(result.contentTruncated ? { contentTruncated: true } : {}),
        },
      };
      messages.push(toolMessage);
      ordinal += 1;
    }
  }

  return messages;
}

export function omitToolUseTrace(metadata: Record<string, unknown>): Record<string, unknown> {
  const { toolUse: _toolUse, ...rest } = metadata;
  return rest;
}

function parseToolUseTrace(value: unknown): NativeToolTrace | null {
  if (!isRecord(value) || !Array.isArray(value.rounds)) return null;
  const rounds = value.rounds
    .filter(isRecord)
    .map((round) => {
      const calls = Array.isArray(round.calls)
        ? round.calls.filter(isRecord).map((call) => ({
            id: typeof call.id === "string" ? call.id : "",
            name: typeof call.name === "string" ? call.name : "",
            input: isRecord(call.input) ? call.input : {},
          }))
        : [];
      const results = Array.isArray(round.results)
        ? round.results.filter(isRecord).map((result) => ({
            toolCallId: typeof result.toolCallId === "string" ? result.toolCallId : "",
            toolName: typeof result.toolName === "string" ? result.toolName : "",
            isError: result.isError === true,
            contentBytes: typeof result.contentBytes === "number" ? result.contentBytes : 0,
            ...(typeof result.content === "string" ? { content: result.content } : {}),
            ...(result.contentTruncated === true ? { contentTruncated: true } : {}),
            ...(result.cancelled === true ? { cancelled: true } : {}),
            ...(result.skipped === true ? { skipped: true } : {}),
          }))
        : [];
      const progress = Array.isArray(round.progress)
        ? round.progress.filter(isRecord).map((event) => ({
            toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : "",
            toolName: typeof event.toolName === "string" ? event.toolName : "",
            phase: parseToolProgressPhase(event.phase),
            summary: typeof event.summary === "string" ? event.summary : "",
            ...(isRecord(event.detail) ? { detail: event.detail } : {}),
            ts: typeof event.ts === "number" ? event.ts : 0,
          }))
        : [];
      return {
        round: typeof round.round === "number" ? round.round : 0,
        calls: calls.filter((call) => call.id && call.name),
        results: results.filter((result) => result.toolCallId && result.toolName),
        ...(progress.length
          ? { progress: progress.filter((event) => event.toolCallId && event.toolName && event.summary) }
          : {}),
      };
    })
    .filter((round) => round.calls.length > 0 || round.results.length > 0);
  return { rounds };
}

function buildRoundToolProgress(
  round: NativeToolRoundTrace,
  baseTimestamp: number
): NonNullable<TeamMessage["toolProgress"]> {
  if (round.progress?.length) {
    return round.progress.map((event, index) => ({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      phase: event.phase,
      summary: event.summary,
      ...(event.detail ? { detail: event.detail } : {}),
      ts: event.ts || baseTimestamp + index,
    }));
  }

  const progress: NonNullable<TeamMessage["toolProgress"]> = [];
  let offset = 0;
  for (const call of round.calls) {
    progress.push({
      toolCallId: call.id,
      toolName: call.name,
      phase: "started",
      summary: `Tool call started: ${call.name}`,
      detail: { input: call.input },
      ts: baseTimestamp + offset,
    });
    offset += 1;
  }
  for (const result of round.results) {
    progress.push({
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      phase: result.cancelled ? "cancelled" : result.isError ? "failed" : "completed",
      summary: result.skipped
        ? `Tool call skipped: ${result.toolName}`
        : result.cancelled
        ? `Tool call cancelled: ${result.toolName}`
        : result.isError
          ? `Tool call failed: ${result.toolName}`
          : `Tool call completed: ${result.toolName}`,
      detail: {
        contentBytes: result.contentBytes,
        ...(result.contentTruncated ? { contentTruncated: true } : {}),
        ...(result.skipped ? { admission: "skipped", reason: "max_tool_calls_per_round" } : {}),
      },
      ts: baseTimestamp + offset,
    });
    offset += 1;
  }
  return progress;
}

function computeProgressTimeCost(progress: NonNullable<TeamMessage["toolProgress"]>): number {
  if (progress.length === 0) {
    return 0;
  }
  const timestamps = progress.map((event) => event.ts).filter((ts) => Number.isFinite(ts));
  if (timestamps.length === 0) {
    return 0;
  }
  const start = Math.min(...timestamps);
  const end = Math.max(...timestamps);
  return Math.max(0, Math.floor(end - start));
}

function parseToolProgressPhase(value: unknown): NativeToolProgressTrace["phase"] {
  switch (value) {
    case "started":
    case "progress":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "progress";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
