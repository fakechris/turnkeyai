import type { Mission } from "@turnkeyai/core-types/mission";
import type { RoleRunState, TeamMessage } from "@turnkeyai/core-types/team";

export type MissionCompletionReason =
  | "terminal"
  | "pending_approval"
  | "existing_blocker"
  | "final_answer"
  | "completed_tool_turn"
  | "incomplete_final_answer"
  | "skipped_tool_turn"
  | "stalled_tool_turn"
  | "active_role_run"
  | "awaiting_work";

export type MissionCompletionDecision =
  | {
      action: "none";
      reason: MissionCompletionReason;
    }
  | {
      action: "update";
      reason: MissionCompletionReason;
      patch: Partial<Pick<Mission, "status" | "progress" | "blockers">>;
      recovery?: MissionCompletionRecovery;
    };

export type MissionCompletionRecovery =
  | {
      kind: "incomplete_final_answer";
      message: TeamMessage;
      reason: "max_tokens" | "truncated_markdown";
    }
  | {
      kind: "stalled_tool_turn";
      message: TeamMessage;
      status: "pending" | "completed" | "failed" | "cancelled" | "skipped" | "timeout";
    };

export function evaluateMissionCompletion(input: {
  mission: Mission;
  messages: TeamMessage[];
  roleRuns?: RoleRunState[] | "unknown";
}): MissionCompletionDecision {
  const { mission, messages } = input;
  if (mission.status === "done" || mission.status === "archived" || mission.status === "draft") {
    return { action: "none", reason: "terminal" };
  }

  if (mission.pendingApprovals > 0) {
    if (mission.status === "needs_approval") {
      return { action: "none", reason: "pending_approval" };
    }
    return {
      action: "update",
      reason: "pending_approval",
      patch: { status: "needs_approval" },
    };
  }

  if (mission.blockers > 0) {
    if (mission.status === "blocked") {
      return { action: "none", reason: "existing_blocker" };
    }
    return {
      action: "update",
      reason: "existing_blocker",
      patch: { status: "blocked" },
    };
  }

  const incompleteFinal = findIncompleteLeadFinalAnswer(mission, messages);
  if (incompleteFinal) {
    if (hasActiveRoleRun(input.roleRuns)) {
      return { action: "none", reason: "active_role_run" };
    }
    return {
      action: "update",
      reason: "incomplete_final_answer",
      patch: { status: "blocked", blockers: 1 },
      recovery: { kind: "incomplete_final_answer", ...incompleteFinal },
    };
  }

  if (hasFinalLeadAssistantMessage(mission, messages)) {
    return {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    };
  }

  const skipped = findSkippedLeadToolTurn(mission, messages);
  if (skipped) {
    if (hasActiveRoleRun(input.roleRuns)) {
      return { action: "none", reason: "active_role_run" };
    }
    return {
      action: "update",
      reason: "skipped_tool_turn",
      patch: { status: "blocked", blockers: 1 },
      recovery: { kind: "stalled_tool_turn", ...skipped },
    };
  }

  const completed = findCompletedLeadToolTurnWithoutFinal(mission, messages);
  if (completed) {
    if (hasActiveRoleRun(input.roleRuns)) {
      return { action: "none", reason: "active_role_run" };
    }
    return {
      action: "update",
      reason: "completed_tool_turn",
      patch: { status: "blocked", blockers: 1 },
      recovery: { kind: "stalled_tool_turn", ...completed },
    };
  }

  const stalled = findStalledLeadToolTurn(mission, messages);
  if (stalled) {
    if (hasActiveRoleRun(input.roleRuns)) {
      return { action: "none", reason: "active_role_run" };
    }
    return {
      action: "update",
      reason: "stalled_tool_turn",
      patch: { status: "blocked", blockers: 1 },
      recovery: { kind: "stalled_tool_turn", ...stalled },
    };
  }

  if (mission.status === "needs_approval" || mission.status === "blocked") {
    return {
      action: "update",
      reason: "awaiting_work",
      patch: { status: "working" },
    };
  }
  return { action: "none", reason: "awaiting_work" };
}

function hasActiveRoleRun(roleRuns: RoleRunState[] | "unknown" | undefined): boolean {
  if (roleRuns === undefined || roleRuns === "unknown") return true;
  return roleRuns.some(isActiveRoleRun);
}

function hasFinalLeadAssistantMessage(
  mission: Mission,
  messages: TeamMessage[]
): boolean {
  const latest = findLatestLeadAnswerCandidate(mission, messages);
  return Boolean(latest && !isIncompleteLeadFinalAnswer(latest));
}

function isLeadAssistantMessage(mission: Mission, message: TeamMessage): boolean {
  if (message.source?.route === "lead-role") return true;
  const primaryAgent = mission.agents[0];
  if (primaryAgent && message.roleId === primaryAgent) return true;
  if (message.roleId === "role-lead") return true;
  return message.name.toLowerCase() === "lead";
}

function findIncompleteLeadFinalAnswer(
  mission: Mission,
  messages: TeamMessage[]
): { message: TeamMessage; reason: "max_tokens" | "truncated_markdown" } | null {
  const latest = findLatestLeadAnswerCandidate(mission, messages);
  return latest ? isIncompleteLeadFinalAnswer(latest) : null;
}

function findLatestLeadAnswerCandidate(
  mission: Mission,
  messages: TeamMessage[]
): TeamMessage | null {
  const candidates = messages
    .filter((message) => {
      if (message.role !== "assistant") return false;
      const content = message.content.trim();
      if (content.length === 0) return false;
      if (!isLeadAssistantMessage(mission, message)) return false;
      if (message.toolStatus === "pending") return false;
      if (/@\{[^}]+\}/.test(content)) return false;
      return true;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
  return candidates.at(-1) ?? null;
}

function isIncompleteLeadFinalAnswer(
  message: TeamMessage
): { message: TeamMessage; reason: "max_tokens" | "truncated_markdown" } | null {
  const stopReason = readStringMetadata(message.metadata, "stopReason");
  if (isMaxTokensStopReason(stopReason)) {
    return { message, reason: "max_tokens" };
  }
  if (looksLikeTruncatedMarkdown(message.content)) {
    return { message, reason: "truncated_markdown" };
  }
  return null;
}

function readStringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function isMaxTokensStopReason(stopReason: string | undefined): boolean {
  if (!stopReason) return false;
  return /^(max_tokens|length|finish_reason_length)$/i.test(stopReason);
}

function looksLikeTruncatedMarkdown(content: string): boolean {
  const trimmed = content.trimEnd();
  if (!trimmed) return false;
  const fenceCount = (trimmed.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) return true;
  const lastLfIndex = trimmed.lastIndexOf("\n");
  const lastNonEmpty = trimmed.slice(Math.max(0, lastLfIndex + 1));
  const pipeCount = (lastNonEmpty.match(/\|/g) ?? []).length;
  if (lastNonEmpty.trimStart().startsWith("|") && pipeCount < 2) return true;
  return /(\*\*|__|\[)$/.test(lastNonEmpty.trim());
}

function findStalledLeadToolTurn(
  mission: Mission,
  messages: TeamMessage[]
): { message: TeamMessage; status: "pending" | "failed" | "cancelled" | "timeout" } | null {
  const latest = findLatestLeadToolMessage(mission, messages);
  if (!latest) return null;
  if (
    latest.toolStatus !== "pending" &&
    latest.toolStatus !== "failed" &&
    latest.toolStatus !== "cancelled"
  ) {
    return null;
  }
  if (!latest.toolCalls || latest.toolCalls.length === 0) return null;
  if (latest.toolStatus === "failed" && isTimeoutToolTurn(latest, messages)) {
    return { message: latest, status: "timeout" };
  }
  return { message: latest, status: latest.toolStatus };
}

function findSkippedLeadToolTurn(
  mission: Mission,
  messages: TeamMessage[]
): { message: TeamMessage; status: "skipped" } | null {
  const latest = findLatestLeadToolMessage(mission, messages);
  if (!latest) return null;
  if (latest.content.trim().length > 0) return null;
  if (latest.toolStatus !== "completed") return null;

  const toolCalls = latest.toolCalls ?? [];
  if (toolCalls.length === 0) return null;
  const callIds = new Set(toolCalls.map((call) => call.id));
  const skippedIds = new Set<string>();
  for (const progress of latest.toolProgress ?? []) {
    if (
      callIds.has(progress.toolCallId) &&
      progress.phase === "completed" &&
      progress.detail?.["admission"] === "skipped"
    ) {
      skippedIds.add(progress.toolCallId);
    }
  }
  for (const message of messages) {
    if (
      message.role === "tool" &&
      message.createdAt >= latest.createdAt &&
      message.toolCallId &&
      callIds.has(message.toolCallId) &&
      readStringMetadata(message.metadata, "admission") === "skipped"
    ) {
      skippedIds.add(message.toolCallId);
    }
  }
  if (skippedIds.size === callIds.size) {
    return { message: latest, status: "skipped" };
  }
  return null;
}

function findCompletedLeadToolTurnWithoutFinal(
  mission: Mission,
  messages: TeamMessage[]
): { message: TeamMessage; status: "completed" } | null {
  const latest = findLatestLeadToolMessage(mission, messages);
  if (!latest || latest.toolStatus !== "completed") return null;
  if (latest.content.trim().length > 0) return null;
  return { message: latest, status: "completed" };
}

function findLatestLeadToolMessage(mission: Mission, messages: TeamMessage[]): TeamMessage | null {
  const leadMessages = messages
    .filter((message) => message.role === "assistant" && isLeadAssistantMessage(mission, message))
    .filter((message) => (message.toolCalls?.length ?? 0) > 0)
    .sort((a, b) => a.createdAt - b.createdAt);
  return leadMessages.at(-1) ?? null;
}

function isTimeoutToolTurn(assistant: TeamMessage, messages: TeamMessage[]): boolean {
  const callIds = new Set((assistant.toolCalls ?? []).map((call) => call.id));
  if (callIds.size === 0) return false;
  for (const progress of assistant.toolProgress ?? []) {
    if (
      callIds.has(progress.toolCallId) &&
      (progress.phase === "failed" || progress.phase === "cancelled") &&
      mentionsTimeout(`${progress.summary} ${JSON.stringify(progress.detail ?? {})}`)
    ) {
      return true;
    }
  }
  for (const message of messages) {
    if (
      message.role === "tool" &&
      message.createdAt >= assistant.createdAt &&
      message.toolCallId &&
      callIds.has(message.toolCallId) &&
      mentionsTimeout(`${message.content} ${JSON.stringify(message.metadata ?? {})}`)
    ) {
      return true;
    }
  }
  return false;
}

function mentionsTimeout(text: string): boolean {
  return /\btime(?:d)?\s*out\b|\btimeout\b/i.test(text);
}

function isActiveRoleRun(run: RoleRunState): boolean {
  return (
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "waiting_worker" ||
    run.status === "resuming"
  );
}
