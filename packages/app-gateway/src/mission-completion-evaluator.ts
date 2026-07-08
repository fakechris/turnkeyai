import type { Mission } from "@turnkeyai/core-types/mission";
import type {
  MissionTerminalReport,
  RoleRunState,
  TeamMessage,
  WorkerSessionRecord,
} from "@turnkeyai/core-types/team";
import { isLifecycleStatusText } from "./mission-final-answer-guard";
import {
  evaluateMissionGoalSlotCoverage,
  looksLikeHonestPartialBlockedAnswer,
  missionAuthorizesPartialCloseout,
} from "./mission-goal-slot-coverage";

export type MissionCompletionReason =
  | "terminal"
  | "pending_approval"
  | "existing_blocker"
  | "final_answer"
  | "completed_tool_turn"
  | "incomplete_final_answer"
  | "skipped_tool_turn"
  | "stalled_tool_turn"
  | "active_execution"
  | "awaiting_work";

export type MissionCompletionDecision =
  | {
      action: "none";
      reason: MissionCompletionReason;
      completion?: MissionCompletionSignal;
    }
  | {
      action: "update";
      reason: MissionCompletionReason;
      patch: Partial<
        Pick<Mission, "status" | "progress" | "blockers" | "pendingApprovals" | "closeout" | "terminalReason">
      >;
      completion?: MissionCompletionSignal;
      recovery?: MissionCompletionRecovery;
    };

export type MissionCompletionSignal = {
  source: "self_report" | "structural" | "verifier" | "evidence" | "advisory";
  verified: boolean;
};

export type MissionIncompleteFinalReason =
  | "max_tokens"
  | "truncated_markdown"
  | "stale_pending_approval"
  | "goal_slots_unverified";

export type MissionCompletionRecovery =
  | {
      kind: "incomplete_final_answer";
      message: TeamMessage;
      reason: MissionIncompleteFinalReason;
      goalText: string;
    }
  | {
      kind: "stalled_tool_turn";
      message: TeamMessage;
      status:
        | "pending"
        | "completed"
        | "failed"
        | "cancelled"
        | "skipped"
        | "timeout"
        | "waiting_input"
        | "waiting_external"
        | "resumable";
    };

export function evaluateMissionCompletion(input: {
  mission: Mission;
  messages: TeamMessage[];
  roleRuns?: RoleRunState[] | "unknown";
  workerSessions?: WorkerSessionRecord[] | "unknown" | undefined;
}): MissionCompletionDecision {
  const { mission, messages } = input;
  if (mission.status === "archived" || mission.status === "draft") {
    return { action: "none", reason: "terminal" };
  }

  if (
    mission.pendingApprovals > 0 &&
    hasCompletePendingApprovalWaitTimeoutCloseout(mission, messages) &&
    !hasActiveExecution(input.roleRuns, input.workerSessions)
  ) {
    // Terminal, but NOT a goal-achieved completion: the approval never got a
    // decision and the gated action was never performed. Do not fake 100%
    // progress; tag the closeout so humans can tell this apart from "done".
    return {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", pendingApprovals: 0, closeout: "approval_timeout" },
    };
  }

  if (mission.pendingApprovals === 0 && hasCompletePendingApprovalWaitTimeoutCloseout(mission, messages)) {
    return {
      action: "update",
      reason: "pending_approval",
      patch: { status: "needs_approval", pendingApprovals: 1, progress: Math.min(mission.progress, 0.95) },
    };
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

  if (mission.blockers > 0 && hasKnownActiveExecution(input.roleRuns, input.workerSessions)) {
    return {
      action: "update",
      reason: "active_execution",
      patch: {
        status: "working",
        blockers: 0,
        progress: Math.min(mission.progress, 0.95),
      },
    };
  }

  if (mission.status === "blocked" && mission.progress >= 1) {
    return {
      action: "update",
      reason: "existing_blocker",
      patch: { progress: 0.95 },
    };
  }

  const typedTerminal = evaluateTypedMissionTerminalReport(input);
  if (typedTerminal) {
    return typedTerminal;
  }

  const latestAnswerBeforeIncompleteCheck = findLatestLeadAnswerCandidateWithIndex(mission, messages);
  const stalledBeforeIncompleteFinal =
    latestAnswerBeforeIncompleteCheck &&
    hasUnresolvedLeadToolTurnBeforeAnswer(mission, messages, latestAnswerBeforeIncompleteCheck.index)
      ? findStalledLeadToolTurn(mission, messages, input.workerSessions)
      : null;
  if (stalledBeforeIncompleteFinal) {
    if (hasActiveExecution(input.roleRuns, input.workerSessions)) {
      return { action: "none", reason: "active_execution" };
    }
    return {
      action: "update",
      reason: "stalled_tool_turn",
      patch: { status: "blocked", blockers: 1 },
      recovery: { kind: "stalled_tool_turn", ...stalledBeforeIncompleteFinal },
    };
  }

  const incompleteFinal = findIncompleteLeadFinalAnswer(mission, messages);
  if (incompleteFinal) {
    if (hasActiveExecutionAfterAnswer(input.roleRuns, input.workerSessions, incompleteFinal.message.createdAt)) {
      if (mission.status === "done") {
        return {
          action: "update",
          reason: "active_execution",
          patch: { status: "working", progress: Math.min(mission.progress, 0.95) },
        };
      }
      return { action: "none", reason: "active_execution" };
    }
    if (mission.status === "blocked" && mission.blockers > 0) {
      return { action: "none", reason: "existing_blocker" };
    }
    return {
      action: "update",
      reason: "incomplete_final_answer",
      patch:
        mission.status === "done"
          ? { status: "blocked", blockers: 1, progress: 0.95 }
          : { status: "blocked", blockers: 1 },
      recovery: { kind: "incomplete_final_answer", ...incompleteFinal },
    };
  }

  if (
    mission.status === "done" &&
    hasUserFollowUpAfterLatestLeadAnswer(mission, messages) &&
    !findLatestLeadToolMessageAfterLatestUser(mission, messages)
  ) {
    if (hasActiveExecution(input.roleRuns, input.workerSessions)) {
      return {
        action: "update",
        reason: "active_execution",
        patch: { status: "working", blockers: 0, progress: Math.min(mission.progress, 0.95) },
      };
    }
    return {
      action: "update",
      reason: "awaiting_work",
      patch: { status: "working", blockers: 0, progress: Math.min(mission.progress, 0.99) },
    };
  }

  if (mission.status === "done" && hasFinalLeadAssistantMessage(mission, messages)) {
    return { action: "none", reason: "terminal" };
  }

  if (
    mission.blockers === 0 &&
    hasCompleteBrowserBoundedFailureCloseout(mission, messages) &&
    !hasActiveExecution(input.roleRuns, input.workerSessions)
  ) {
    // Terminal bounded failure: automated work could not proceed and the
    // lead closed out with verified/unverified/next-action. The flow is over
    // but the goal was not achieved — keep progress honest and tag it.
    return {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", blockers: 0, closeout: "bounded_failure" },
    };
  }

  if (
    mission.blockers > 0 &&
    hasCompleteBoundedFailureCloseout(mission, messages) &&
    !hasActiveExecution(input.roleRuns, input.workerSessions)
  ) {
    // Terminal bounded failure: automated work could not proceed and the
    // lead closed out with verified/unverified/next-action. The flow is over
    // but the goal was not achieved — keep progress honest and tag it.
    return {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", blockers: 0, closeout: "bounded_failure" },
    };
  }

  if (mission.blockers > 0 && canClearExistingBlockerWithFinalAnswer(mission, messages)) {
    return {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1, blockers: 0 },
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

  if (
    hasAuthorizedPartialBlockedCloseout(mission, messages) &&
    !hasActiveExecution(input.roleRuns, input.workerSessions)
  ) {
    // Mission authorized a partial/blocked result and the lead delivered an
    // honest one (declares partial/blocked + names the unverified gaps). This
    // is a legitimate NON-success terminal: settle it (tagged, progress not
    // forced to 1) instead of marking it a plain "done" or looping recovery.
    return {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", blockers: 0, closeout: "bounded_failure" },
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
    if (hasActiveExecution(input.roleRuns, input.workerSessions)) {
      return { action: "none", reason: "active_execution" };
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
    if (hasActiveExecution(input.roleRuns, input.workerSessions)) {
      return { action: "none", reason: "active_execution" };
    }
    return {
      action: "update",
      reason: "completed_tool_turn",
      patch: { status: "blocked", blockers: 1 },
      recovery: { kind: "stalled_tool_turn", ...completed },
    };
  }

  const stalled = findStalledLeadToolTurn(mission, messages, input.workerSessions);
  if (stalled) {
    if (hasActiveExecution(input.roleRuns, input.workerSessions)) {
      return { action: "none", reason: "active_execution" };
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

function evaluateTypedMissionTerminalReport(input: {
  mission: Mission;
  messages: TeamMessage[];
  roleRuns?: RoleRunState[] | "unknown";
  workerSessions?: WorkerSessionRecord[] | "unknown" | undefined;
}): MissionCompletionDecision | null {
  const { mission, messages } = input;
  const latest = findLatestLeadAnswerCandidateWithIndex(mission, messages);
  if (!latest) return null;
  const report = readMissionTerminalReport(latest.message.metadata);
  if (!report) return null;
  if (hasUnresolvedLeadToolTurnBeforeAnswer(mission, messages, latest.index)) return null;
  if (hasActiveExecutionAfterAnswer(input.roleRuns, input.workerSessions, latest.message.createdAt)) {
    if (mission.status === "done") {
      return {
        action: "update",
        reason: "active_execution",
        patch: { status: "working", progress: Math.min(mission.progress, 0.95) },
        completion: { source: "self_report", verified: false },
      };
    }
    return {
      action: "none",
      reason: "active_execution",
      completion: { source: "self_report", verified: false },
    };
  }

  if (report.status === "completed") {
    if (isIncompleteLeadFinalAnswer(mission, latest.message, messages)) {
      return null;
    }
    return {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1, blockers: 0 },
      completion: { source: "self_report", verified: true },
    };
  }

  const terminalReason = report.reason?.trim() || report.status;
  return {
    action: "update",
    reason: "final_answer",
    patch: {
      status: "done",
      blockers: 0,
      progress: Math.min(mission.progress, 0.95),
      closeout: report.status === "partial" ? "partial" : "bounded_failure",
      terminalReason,
    },
    completion: { source: "self_report", verified: true },
  };
}

function hasActiveExecution(
  roleRuns: RoleRunState[] | "unknown" | undefined,
  workerSessions: WorkerSessionRecord[] | "unknown" | undefined
): boolean {
  return hasActiveRoleRun(roleRuns) || hasActiveWorkerSession(workerSessions);
}

function hasKnownActiveExecution(
  roleRuns: RoleRunState[] | "unknown" | undefined,
  workerSessions: WorkerSessionRecord[] | "unknown" | undefined
): boolean {
  if (roleRuns === "unknown" || workerSessions === "unknown") {
    return false;
  }
  return hasActiveExecution(roleRuns, workerSessions);
}

function hasActiveExecutionAfterAnswer(
  roleRuns: RoleRunState[] | "unknown" | undefined,
  workerSessions: WorkerSessionRecord[] | "unknown" | undefined,
  answerCreatedAt: number
): boolean {
  return hasActiveRoleRunAtOrAfter(roleRuns, answerCreatedAt) || hasActiveWorkerSession(workerSessions);
}

function hasActiveRoleRun(roleRuns: RoleRunState[] | "unknown" | undefined): boolean {
  if (roleRuns === undefined || roleRuns === "unknown") return true;
  return roleRuns.some(isActiveRoleRun);
}

function hasActiveRoleRunAtOrAfter(
  roleRuns: RoleRunState[] | "unknown" | undefined,
  createdAt: number
): boolean {
  if (roleRuns === undefined || roleRuns === "unknown") return true;
  return roleRuns.some(
    (run) => isActiveRoleRun(run) && (typeof run.lastActiveAt !== "number" || run.lastActiveAt >= createdAt)
  );
}

function hasActiveWorkerSession(workerSessions: WorkerSessionRecord[] | "unknown" | undefined): boolean {
  if (workerSessions === undefined) return false;
  if (workerSessions === "unknown") return true;
  return workerSessions.some(isActiveWorkerSession);
}

function hasFinalLeadAssistantMessage(
  mission: Mission,
  messages: TeamMessage[]
): boolean {
  const latest = findLatestLeadAnswerCandidateWithIndex(mission, messages);
  return Boolean(
    latest &&
      !isIncompleteLeadFinalAnswer(mission, latest.message, messages) &&
      !hasUnresolvedLeadToolTurnBeforeAnswer(mission, messages, latest.index)
  );
}

function hasCompleteBoundedFailureCloseout(mission: Mission, messages: TeamMessage[]): boolean {
  const latest = findLatestLeadAnswerCandidateWithIndex(mission, messages);
  return Boolean(
    latest &&
      !isIncompleteLeadFinalAnswer(mission, latest.message, messages) &&
      !hasUnresolvedLeadToolTurnBeforeAnswer(mission, messages, latest.index) &&
      looksLikeCompleteBoundedFailureCloseout(mission.desc, latest.message.content)
  );
}

function hasCompleteBrowserBoundedFailureCloseout(mission: Mission, messages: TeamMessage[]): boolean {
  const latest = findLatestLeadAnswerCandidateWithIndex(mission, messages);
  return Boolean(
    latest &&
      missionAllowsBrowserBoundedFailureCloseout(mission.desc) &&
      !isIncompleteLeadFinalAnswer(mission, latest.message, messages) &&
      !hasUnresolvedLeadToolTurnBeforeAnswer(mission, messages, latest.index) &&
      looksLikeCompleteBoundedFailureCloseout(mission.desc, latest.message.content)
  );
}

function hasAuthorizedPartialBlockedCloseout(mission: Mission, messages: TeamMessage[]): boolean {
  const latest = findLatestLeadAnswerCandidateWithIndex(mission, messages);
  if (!latest) return false;
  if (hasUnresolvedLeadToolTurnBeforeAnswer(mission, messages, latest.index)) return false;
  return (
    missionAuthorizesPartialCloseout(missionGoalTextForAnswer(mission, messages, latest.message)) &&
    looksLikeHonestPartialBlockedAnswer(latest.message.content)
  );
}

function canClearExistingBlockerWithFinalAnswer(mission: Mission, messages: TeamMessage[]): boolean {
  const latest = findLatestLeadAnswerCandidateWithIndex(mission, messages);
  if (!latest) return false;
  if (isIncompleteLeadFinalAnswer(mission, latest.message, messages)) return false;
  if (hasUnresolvedLeadToolTurnBeforeAnswer(mission, messages, latest.index)) return false;
  return !looksLikeBlockedOrFailedCloseout(latest.message.content);
}

function hasCompletePendingApprovalWaitTimeoutCloseout(mission: Mission, messages: TeamMessage[]): boolean {
  const latest = findLatestLeadAnswerCandidateWithIndex(mission, messages);
  return Boolean(
    latest &&
      !hasUnresolvedLeadToolTurnBeforeAnswer(mission, messages, latest.index) &&
      looksLikeCompletePendingApprovalWaitTimeoutCloseout(latest.message.content)
  );
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
): { message: TeamMessage; reason: MissionIncompleteFinalReason; goalText: string } | null {
  const latest = findLatestLeadAnswerCandidateWithIndex(mission, messages);
  return latest ? isIncompleteLeadFinalAnswer(mission, latest.message, messages) : null;
}

function findLatestLeadAnswerCandidateWithIndex(
  mission: Mission,
  messages: TeamMessage[]
): { message: TeamMessage; index: number } | null {
  const staleBeforeIndex = Math.max(
    findLatestUserMessageIndex(messages),
    findLatestLeadToolMessageIndex(mission, messages)
  );
  let latest: { message: TeamMessage; index: number } | null = null;
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    const content = message.content.trim();
    if (content.length === 0) continue;
    if (isLifecycleStatusText(content)) continue;
    if (!isLeadAssistantMessage(mission, message)) continue;
    if ((message.toolCalls?.length ?? 0) > 0) continue;
    if (message.toolStatus === "pending") continue;
    if (index <= staleBeforeIndex) continue;
    if (hasDispatchMention(content)) continue;
    latest = { message, index };
  }
  return latest;
}

function hasUserFollowUpAfterLatestLeadAnswer(mission: Mission, messages: TeamMessage[]): boolean {
  const latestUserIndex = findLatestUserMessageIndex(messages);
  if (latestUserIndex < 0) return false;
  const latestAnswerIndex = findLatestLeadAnswerIndexIgnoringStaleness(mission, messages);
  return latestAnswerIndex >= 0 && latestUserIndex > latestAnswerIndex;
}

function findLatestLeadAnswerIndexIgnoringStaleness(mission: Mission, messages: TeamMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const content = message.content.trim();
    if (content.length === 0) continue;
    if (isLifecycleStatusText(content)) continue;
    if (!isLeadAssistantMessage(mission, message)) continue;
    if ((message.toolCalls?.length ?? 0) > 0) continue;
    if (message.toolStatus === "pending") continue;
    if (hasDispatchMention(content)) continue;
    return index;
  }
  return -1;
}

function hasDispatchMention(content: string): boolean {
  const normalized = content.trim();
  if (/^@(?:role-)?[A-Za-z0-9_-]+(?:\s+@(?:role-)?[A-Za-z0-9_-]+)*[.!?。！]*$/.test(normalized)) {
    return true;
  }
  for (const match of content.matchAll(/@\{([^}]+)\}/g)) {
    const mention = match[1]?.trim();
    if (!mention) continue;
    if (/^<[^>]+>$/.test(mention)) continue;
    return true;
  }
  return false;
}

function hasUnresolvedLeadToolTurnBeforeAnswer(
  mission: Mission,
  messages: TeamMessage[],
  answerIndex: number
): boolean {
  const latestToolIndex = findLatestLeadToolMessageIndex(mission, messages);
  if (latestToolIndex < 0 || latestToolIndex >= answerIndex) return false;
  const latestTool = messages[latestToolIndex];
  if (!latestTool || latestTool.toolStatus !== "pending") return false;
  const toolCalls = latestTool.toolCalls ?? [];
  if (toolCalls.length === 0) return false;
  return !hasToolResultMessagesForAllCalls(messages, latestToolIndex, answerIndex, toolCalls.map((call) => call.id));
}

function hasToolResultMessagesForAllCalls(
  messages: TeamMessage[],
  afterIndex: number,
  beforeIndex: number,
  toolCallIds: string[]
): boolean {
  const remaining = new Set(toolCallIds);
  for (let index = afterIndex + 1; index < beforeIndex; index += 1) {
    const message = messages[index];
    if (message?.role !== "tool" || !message.toolCallId) continue;
    remaining.delete(message.toolCallId);
    if (remaining.size === 0) break;
  }
  return remaining.size === 0;
}

function findLatestUserMessageIndex(messages: TeamMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

function isIncompleteLeadFinalAnswer(
  mission: Mission,
  message: TeamMessage,
  messages: TeamMessage[]
): { message: TeamMessage; reason: MissionIncompleteFinalReason; goalText: string } | null {
  if (looksLikeCompleteApprovalCloseout(message.content)) {
    return null;
  }
  if (looksLikeCompleteAwaitingContextCloseout(mission.desc, message.content)) {
    return null;
  }
  if (looksLikeCompleteBoundedFailureCloseout(mission.desc, message.content)) {
    return null;
  }
  if (looksLikeStalePendingApprovalAnswer(message.content)) {
    return { message, reason: "stale_pending_approval", goalText: missionGoalTextForAnswer(mission, messages, message) };
  }
  if (looksLikeIncompleteApprovalGateAnswer(message.content)) {
    return { message, reason: "goal_slots_unverified", goalText: missionGoalTextForAnswer(mission, messages, message) };
  }
  const stopReason = readStringMetadata(message.metadata, "stopReason");
  if (isMaxTokensStopReason(stopReason)) {
    return { message, reason: "max_tokens", goalText: missionGoalTextForAnswer(mission, messages, message) };
  }
  if (looksLikeTruncatedMarkdown(message.content)) {
    return { message, reason: "truncated_markdown", goalText: missionGoalTextForAnswer(mission, messages, message) };
  }
  // When the mission explicitly authorizes a partial/blocked outcome (e.g.
  // "把结论标为 blocked/partial", "必须写未验证", "do not dress it up as
  // complete"), an honest answer that declares partial/blocked AND surfaces the
  // unverified items is the REQUESTED result — not an incomplete final. Letting
  // the goal-slot guard flag it as `goal_slots_unverified` here would loop
  // recovery against the mission's own instructions. Settling is handled by the
  // authorized-partial terminal branch in evaluateMissionCompletion.
  if (
    missionAuthorizesPartialCloseout(missionGoalTextForAnswer(mission, messages, message)) &&
    looksLikeHonestPartialBlockedAnswer(message.content)
  ) {
    return null;
  }
  const goalText = missionGoalTextForAnswer(mission, messages, message);
  const goalCoverage = evaluateMissionGoalSlotCoverage({
    goalText,
    finalText: message.content,
    evidence: {
      completedSessionResultCount: countCompletedSessionResultsBeforeAnswer(messages, message),
    },
  });
  if (goalCoverage.issues.length > 0) {
    return { message, reason: "goal_slots_unverified", goalText };
  }
  return null;
}

function countCompletedSessionResultsBeforeAnswer(messages: TeamMessage[], answer: TeamMessage): number {
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.createdAt > answer.createdAt) continue;
    if (message.role !== "tool") continue;
    if (message.name !== "sessions_spawn" && message.name !== "sessions_send") continue;
    if (!isCompletedSessionToolResult(message)) continue;
    seen.add(readCompletedSessionEvidenceKey(message));
    for (const progress of message.toolProgress ?? []) {
      if (
        (progress.toolName === "sessions_spawn" || progress.toolName === "sessions_send") &&
        progress.phase === "completed"
      ) {
        seen.add(progress.toolCallId);
      }
    }
  }
  return seen.size;
}

function isCompletedSessionToolResult(message: TeamMessage): boolean {
  if (message.toolStatus && message.toolStatus !== "completed") return false;
  const parsed = parseSessionToolResultStatus(message.content);
  if (parsed) {
    return parsed.status === "completed";
  }
  return /\bcompleted\b/i.test(message.content) && !/\b(?:partial|failed|timeout|timed out|cancelled|canceled|blocked|unverified)\b/i.test(message.content);
}

function readCompletedSessionEvidenceKey(message: TeamMessage): string {
  const parsed = parseSessionToolResultStatus(message.content);
  return parsed?.sessionKey ?? message.toolCallId ?? message.id;
}

function parseSessionToolResultStatus(content: string): { status: string; sessionKey?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : null;
  if (!status) return null;
  const sessionKey = typeof record.session_key === "string" && record.session_key.trim() ? record.session_key : undefined;
  return { status, ...(sessionKey ? { sessionKey } : {}) };
}

function missionGoalText(mission: Mission): string {
  return [mission.title, mission.desc].filter((part) => part.trim()).join("\n");
}

function missionGoalTextForAnswer(mission: Mission, messages: TeamMessage[], answer: TeamMessage): string {
  const latestUser = latestUserMessageBeforeAnswer(messages, answer);
  const latestUserText = latestUser?.content.trim() ?? "";
  const activeGoalText =
    shouldPreferLatestUserGoal(latestUserText)
      ? latestUserText
      : mission.desc;
  return uniqueNonEmptyStrings([mission.title, activeGoalText]).join("\n");
}

function shouldPreferLatestUserGoal(text: string): boolean {
  if (!text) return false;
  if (looksLikeAutomaticRecoveryUserMessage(text)) return false;
  if (/^user says\s+\S+$/i.test(text)) return false;
  if (/^(?:继续|继续吧|go on|continue|keep going|resume)$/i.test(text.trim())) return false;
  return true;
}

function looksLikeAutomaticRecoveryUserMessage(text: string): boolean {
  return /^\s*System recovery:\s+/i.test(text) || /\bAutomatic recovery attempt\s+\d+\s+of\s+\d+\b/i.test(text);
}

function latestUserMessageBeforeAnswer(messages: TeamMessage[], answer: TeamMessage): TeamMessage | null {
  let latest: TeamMessage | null = null;
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (message.createdAt > answer.createdAt) continue;
    latest = message;
  }
  return latest;
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function looksLikeStalePendingApprovalAnswer(content: string): boolean {
  return /\b(?:approval pending|approval is pending|approval is still pending|approval request is pending|approval request is still pending|permission request is pending|permission request is still pending|pending operator approval|pending operator decision|awaiting (?:decision|your decision|operator approval|operator decision|operator)|waiting for (?:your|operator|the operator(?:'s)?) decision|waiting for operator|waiting on operator approval|once you approve|after you approve|before (?:the )?(?:browser worker )?can)\b/i.test(
    content
  );
}

function looksLikeIncompleteApprovalGateAnswer(content: string): boolean {
  return /\b(?:status\s*:\s*)?incomplete\b[\s\S]{0,180}\b(?:permission|approval)\b[\s\S]{0,180}\b(?:not finalized|not finali[sz]ed|not complete|incomplete|missing)|\b(?:permission|approval)\s+loop\b[\s\S]{0,160}\b(?:not finalized|not finali[sz]ed|incomplete|not complete|missing)\b/i.test(
    content
  );
}

function looksLikeCompletePendingApprovalWaitTimeoutCloseout(content: string): boolean {
  return (
    /\b(?:approval|permission|operator decision)\b[\s\S]{0,180}\b(?:did not arrive|still pending|pending|timed out|timeout|wait[- ]timeout|wait boundary|attempt cycle)\b/i.test(
      content
    ) &&
    /\b(?:did not|will not|was not|not|no)\s+(?:be\s+)?(?:submit(?:ted)?|apply|perform(?:ed)?|run|complete(?:d)?|execute(?:d)?|take|taken)|\b(?:action|side effect)\s+(?:not performed|did not run)\b|\bno (?:browser )?(?:form submission|browser action|browser mutation|mutation|side effects?|side effect|state) (?:was |were )?(?:(?:or will be )?performed|executed|taken|applied|changed|mutated|occurred)\b|\bno form submission or browser side effect was performed\b|\bno browser navigation,\s*no form submission,\s*no side effects?\b|\bno form submission,\s*no side effects?\b/i.test(
      content
    ) &&
    /\b(?:next action|safest next step|safe fallback|ask the operator|retry|continue|re-?run|re-?initiate|flow is complete|closeout confirmed)\b/i.test(
      content
    )
  );
}

function looksLikeCompleteAwaitingContextCloseout(missionDesc: string, content: string): boolean {
  if (
    !/\bno research (?:is )?needed\b|\bno action (?:is )?needed\b|\bcontext (?:is )?available\b|\bwhen .*context .*available\b/i.test(
      missionDesc
    )
  ) {
    return false;
  }
  const strictCloseout =
    /\b(?:resume|continue|proceed)\b[\s\S]{0,120}\b(?:context|available|provided)\b/i.test(content) &&
    /\bno research (?:is )?(?:needed|required)\b|\bno research required\b/i.test(content) &&
    /\b(?:flow|mission|task)\b[\s\S]{0,80}\b(?:closed|complete|completed|ready)\b/i.test(content);
  const conciseSetupAck =
    /\b(?:thread|mission|task)\b[\s\S]{0,80}\b(?:opened|queued|ready|initiated|acknowledged)\b/i.test(content) &&
    /\b(?:awaiting|waiting for|when|once)\b[\s\S]{0,120}\b(?:context|details|input|provided|available)\b/i.test(content);
  return strictCloseout || conciseSetupAck;
}

function looksLikeCompleteBoundedFailureCloseout(missionDesc: string, content: string): boolean {
  if (looksLikeCompleteTimeoutFollowupRecovery(missionDesc, content)) {
    return true;
  }
  if (looksLikeCompleteCancelledSourceCloseout(missionDesc, content)) {
    return true;
  }
  if (missionAllowsBrowserBoundedFailureCloseout(missionDesc)) {
    return (
      /\b(?:browser|CDP|Chrome DevTools|automation|browser automation|target|snapshot|screenshot|capture|scroll)\b[\s\S]{0,200}\b(?:unavailable|unreachable|cannot be reached|could not be reached|connection refused|ECONNREFUSED|could not establish|cannot establish|browser_cdp_unavailable|timed out|timeouts?|timeout|cdp_command_timeout|detached_target|detached|detaches?|attach_failed|attach failed|target attach failed|browser target attach failed|failed to attach|cannot attach|can't attach)\b|\b(?:timed out|timeouts?|timeout|cdp_command_timeout|detached_target|detached|detaches?|attach_failed|attach failed|target attach failed|browser target attach failed|failed to attach|cannot attach|can't attach)\b[\s\S]{0,200}\b(?:browser|CDP|Chrome DevTools|automation|target|snapshot|screenshot|capture|scroll)\b/i.test(
        content
      ) &&
      /\bwhat was verified\b|\bverified\b[\s\S]{0,100}\b(?:URL|target|reachable|connection|port)\b/i.test(content) &&
      /\bwhat remains unverified\b|\b(?:remains? )?unverified\b|\bnot verified\b/i.test(content) &&
      /\bnext action\b|\boperator\b[\s\S]{0,120}\b(?:should|can|must|next)\b|\bmanual(?:ly)?\b/i.test(content) &&
      hasTerminalBrowserFailureRationale(content)
    );
  }
  if (!missionAllowsSourceBoundedFailureCloseout(missionDesc)) {
    return false;
  }
  return (
    /\b(?:slow source|source|endpoint|URL|fixture)\b[\s\S]{0,220}\b(?:timed out|timeouts?|timeout|did not respond|no response|no HTTP response|does not return|didn't return)\b|\b(?:timed out|timeouts?|timeout|did not respond|no response|no HTTP response)\b[\s\S]{0,220}\b(?:slow source|source|endpoint|URL|fixture)\b/i.test(
      content
    ) &&
    hasSourceTimeoutAttemptEvidence(content) &&
    /\bwhat remains unverified\b|\b(?:remains? )?unverified\b|\bnot verified\b/i.test(content) &&
    /\b(?:how to continue|next action|continue|retry|increase the timeout|check the service|resume)\b/i.test(content) &&
    /\b(?:release[- ]risk note|partial evidence closeout|partial closeout|bounded attempt|source[- ]bounded|closeout)\b/i.test(content)
  );
}

function hasSourceTimeoutAttemptEvidence(content: string): boolean {
  return (
    /\bwhat was verified\b|\bverified\b[\s\S]{0,100}\b(?:URL|target|reachable|connection|port|source|status)\b/i.test(
      content
    ) ||
    /\b(?:source|target URL|URL)\b[\s\S]{0,120}\bhttps?:\/\/[^\s)`|]+/i.test(content) ||
    /\b(?:status|attempt result|outcome|content received)\b[\s\S]{0,120}\b(?:timed out|timeout|no response|none|no HTTP response)\b/i.test(
      content
    )
  );
}

function hasTerminalBrowserFailureRationale(content: string): boolean {
  return (
    /\b(?:flow|mission|task|automated work)\b[\s\S]{0,120}\b(?:closed|complete|completed|no further|not possible|cannot continue)\b/i.test(
      content
    ) ||
    /\b(?:source[- ]bounded|bounded to|scope (?:is )?limited|scope of the fixture|cannot validate real[- ]world)\b/i.test(
      content
    ) ||
    /\b(?:browser runtime|browser infrastructure|browser automation|CDP|Chrome DevTools)\b[\s\S]{0,80}\b(?:infrastructure|connectivity|transport|runtime|failure|issue|unavailable|detached)\b/i.test(
      content
    ) ||
    /\b(?:browser_cdp_unavailable|cdp_command_timeout|detached_target|attach_failed|target_not_found)\b/i.test(
      content
    ) ||
    /\b(?:target application|target app|page[- ]load|endpoint|dashboard service|server)\b[\s\S]{0,100}\b(?:not the source|not the cause|not a source|not an endpoint|not a page[- ]load)\b/i.test(
      content
    ) ||
    /\b(?:not a|is not a)\b[\s\S]{0,80}\b(?:page[- ]load|endpoint|dashboard service|server)\b[\s\S]{0,80}\b(?:issue|failure|problem)\b/i.test(
      content
    ) ||
    /\b(?:restart|repair|re[- ]?submit|resubmit|retry)\b[\s\S]{0,80}\b(?:browser runtime|browser automation|CDP|Chrome DevTools|review task|task)\b/i.test(
      content
    ) ||
    /\bno live production system is affected\b/i.test(content)
  );
}

function looksLikeCompleteTimeoutFollowupRecovery(missionDesc: string, content: string): boolean {
  if (!missionAllowsSourceBoundedFailureCloseout(missionDesc)) {
    return false;
  }
  if (!/\bfollow[- ]?up\b|\bcontinue\b|\bresume\b/i.test(missionDesc)) {
    return false;
  }
  return (
    /\b(?:resume(?:d)?|retry|continued?|cold resume|recovered)\b[\s\S]{0,160}\b(?:completed|finished|succeeded|success)\b|\b(?:completed|finished|succeeded|success)\b[\s\S]{0,160}\b(?:resume(?:d)?|retry|continued?|cold resume|recovered)\b/i.test(
      content
    ) &&
    /\b(?:browser|rendered|screenshot|snapshot|visible text|page shows|content rendered|full content rendered)\b/i.test(
      content
    ) &&
    /\bverified facts?\b|\bverified\b[\s\S]{0,120}\b(?:owner|risk|source|content|URL)\b/i.test(content) &&
    /\bunverified\b|\bresidual risks?\b|\bremaining risk\b|\b(?:timeout|earlier timeout)\b[\s\S]{0,160}\b(?:does not|doesn't|no longer|still|limits?|limit)\b/i.test(
      content
    )
  );
}

function looksLikeCompleteCancelledSourceCloseout(missionDesc: string, content: string): boolean {
  if (
      !/\b(?:operator|user)\b[\s\S]{0,120}\b(?:cancel(?:s|led|ed|ling|ing)?|canceled)\b[\s\S]{0,160}\b(?:source check|source-check|source|active work|active tool)\b[\s\S]{0,220}\b(?:close out|closeout|how to continue|continue later|resume)\b/i.test(
        missionDesc
      )
  ) {
    return false;
  }
  return (
    /\bcancel(?:led|ed)?\b|\bcanceled\b/i.test(content) &&
    /\b(?:source check|source-check|target URL|URL|source|content)\b[\s\S]{0,180}\b(?:not retrieved|was not retrieved|not fetched|no content|none|not verified|unverified|before any content was fetched)\b/i.test(
      content
    ) &&
    /\b(?:continue|resume|follow-up|follow up|later|retry|next action)\b/i.test(content)
  );
}

function looksLikeBlockedOrFailedCloseout(content: string): boolean {
  if (looksLikeCompleteAnswerWithBoundedResidualScope(content)) {
    return false;
  }
  return /\b(?:blocked|unavailable|unreachable|cannot be reached|could not be reached|connection refused|ECONNREFUSED|timed out|timeouts?|timeout|not verified|unverified|failed|failure|did not complete|not completed|could not complete)\b/i.test(
    content
  );
}

function looksLikeCompleteAnswerWithBoundedResidualScope(content: string): boolean {
  return (
    /\b(?:residual risk|unverified scope|remaining risk)\b/i.test(content) &&
    /\b(?:source[- ]bounded|local fixture|production freshness|external availability|deeper pricing tiers|not verified elsewhere|outside (?:the )?source|outside (?:the )?captured page)\b/i.test(
      content
    ) &&
    !/\b(?:blocked|unavailable|unreachable|cannot be reached|could not be reached|connection refused|ECONNREFUSED|timed out|timeouts?|timeout|failed|failure|did not complete|not completed|could not complete)\b/i.test(
      content
    )
  );
}

function missionAllowsBrowserBoundedFailureCloseout(missionDesc: string): boolean {
  return /\bif\b[\s\S]{0,120}\b(?:browser|CDP|automation|target)\b[\s\S]{0,120}\b(?:cannot|can't|unavailable|unreachable|refused|cannot be reached|could not be reached|times? out|timed out|timeout|detaches?|detached|detached_target|attach(?:es|ed|ing)?|attach_failed|failed to attach)\b[\s\S]{0,160}\b(?:close out|closeout|what was verified|remains? unverified|next action)\b/i.test(
    missionDesc
  );
}

function missionAllowsSourceBoundedFailureCloseout(missionDesc: string): boolean {
  if (/\b(?:provider|providers|pricing|price|search support|web search|model support)\b|价格|搜索|联网|供应商|提供商/iu.test(missionDesc)) {
    return false;
  }
  return (
    /\bbounded\b[\s\S]{0,120}\b(?:attempt|try|window|timeout)\b/i.test(missionDesc) &&
    /\bif\b[\s\S]{0,180}\b(?:source|endpoint|page|service|fixture)\b[\s\S]{0,180}\b(?:does not return|doesn't return|fails? to return|times? out|timed out|timeout)\b[\s\S]{0,220}\b(?:close out|closeout|available evidence|verified facts?|unverified items?|how to continue)\b/i.test(
      missionDesc
    )
  );
}

function readMissionTerminalReport(metadata: Record<string, unknown> | undefined): MissionTerminalReport | null {
  const raw = metadata?.missionReport;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const status = record.status;
  if (status !== "completed" && status !== "partial" && status !== "blocked") return null;
  const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason : undefined;
  const unverifiedSlots = readStringArray(record.unverifiedSlots);
  const evidenceRefs = readStringArray(record.evidenceRefs);
  const authorizedPartial =
    typeof record.authorizedPartial === "boolean" ? record.authorizedPartial : undefined;
  const source =
    record.source === "runtime_derived" || record.source === "model_report" ? record.source : undefined;
  return {
    status,
    ...(reason ? { reason } : {}),
    ...(unverifiedSlots.length ? { unverifiedSlots } : {}),
    ...(evidenceRefs.length ? { evidenceRefs } : {}),
    ...(authorizedPartial !== undefined ? { authorizedPartial } : {}),
    ...(source ? { source } : {}),
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
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
  return hasUnclosedTrailingInlineMarkdown(lastNonEmpty);
}

function hasUnclosedTrailingInlineMarkdown(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.endsWith("[")) return true;
  if (trimmed.endsWith("**")) {
    return countOccurrences(trimmed, "**") % 2 === 1;
  }
  if (trimmed.endsWith("__")) {
    return countOccurrences(trimmed, "__") % 2 === 1;
  }
  return false;
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const next = value.indexOf(needle, index);
    if (next < 0) return count;
    count += 1;
    index = next + needle.length;
  }
}

function looksLikeCompleteApprovalCloseout(content: string): boolean {
  return looksLikeCompleteDeniedApprovalCloseout(content) || looksLikeCompleteApprovedApprovalCloseout(content);
}

function looksLikeCompleteDeniedApprovalCloseout(content: string): boolean {
  return (
    /\bdenied\b/i.test(content) &&
    /\b(?:safe closeout|safe fallback|closed safely|task closed safely)\b/i.test(content) &&
    /\b(?:no mutation was performed|no side effects? (?:occurred|were applied)|no form submission was (?:or will be )?performed|form submission was never submitted|was never submitted|side effect did not run|action not performed|no action was performed)\b/i.test(
      content
    ) &&
    /\b(?:complete|closed out|closes cleanly|halts cleanly|no further browser work is queued|safe next action|re-?initiate|re-?review)\b/i.test(
      content
    )
  );
}

function looksLikeCompleteApprovedApprovalCloseout(content: string): boolean {
  if (hasApprovedCloseoutFailureText(content)) {
    return false;
  }
  return (
    /\bapproved\b/i.test(content) &&
    /\b(?:permission|approval|action)\b/i.test(content) &&
    /\b(?:applied|granted|authorized)\b/i.test(content) &&
    /\b(?:submit(?:ted|tal)?|form submission|click(?:ed)?|browser action)\b/i.test(content) &&
    /\b(?:evidence|observed|showed|confirmed|result)\b/i.test(content) &&
    /\b(?:complete|completed|done|no external side effects?|residual risk|boundary)\b/i.test(content)
  );
}

function hasApprovedCloseoutFailureText(content: string): boolean {
  if (/\b(?:not completed|not available|cannot be traversed)\b/i.test(content)) {
    return true;
  }
  return hasUnnegatedTerm(content, /\b(?:blocked|unavailable|disabled)\b/gi);
}

function hasUnnegatedTerm(content: string, pattern: RegExp): boolean {
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    const prefix = content.slice(Math.max(0, index - 24), index);
    if (/(?:\bnot\s+|\bnever\s+|\bno longer\s+)$/i.test(prefix)) {
      continue;
    }
    return true;
  }
  return false;
}

function findStalledLeadToolTurn(
  mission: Mission,
  messages: TeamMessage[],
  workerSessions: WorkerSessionRecord[] | "unknown" | undefined
): {
  message: TeamMessage;
  status: "pending" | "failed" | "cancelled" | "timeout" | "waiting_input" | "waiting_external" | "resumable";
} | null {
  const latestEntry = findLatestLeadToolMessageAfterLatestUser(mission, messages);
  const latest = latestEntry?.message;
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
  if (latest.toolStatus === "pending") {
    const pausedWorkerStatus = findPausedLinkedWorkerStatus(latest, workerSessions);
    if (pausedWorkerStatus) {
      return { message: latest, status: pausedWorkerStatus };
    }
  }
  return { message: latest, status: latest.toolStatus };
}

function findSkippedLeadToolTurn(
  mission: Mission,
  messages: TeamMessage[]
): { message: TeamMessage; status: "skipped" } | null {
  const latestEntry = findLatestLeadToolMessageAfterLatestUser(mission, messages);
  const latest = latestEntry?.message;
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
  const latestEntry = findLatestLeadToolMessageAfterLatestUser(mission, messages);
  const latest = latestEntry?.message;
  if (!latest || latest.toolStatus !== "completed") return null;
  if (latest.content.trim().length > 0) return null;
  return { message: latest, status: "completed" };
}

function findLatestLeadToolMessage(mission: Mission, messages: TeamMessage[]): TeamMessage | null {
  const index = findLatestLeadToolMessageIndex(mission, messages);
  return index >= 0 ? messages[index]! : null;
}

function findLatestLeadToolMessageAfterLatestUser(
  mission: Mission,
  messages: TeamMessage[]
): { message: TeamMessage; index: number } | null {
  const latestUserIndex = findLatestUserMessageIndex(messages);
  for (let index = messages.length - 1; index > latestUserIndex; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "assistant" &&
      isLeadAssistantMessage(mission, message) &&
      (message.toolCalls?.length ?? 0) > 0
    ) {
      return { message, index };
    }
  }
  return null;
}

function findLatestLeadToolMessageIndex(mission: Mission, messages: TeamMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "assistant" &&
      isLeadAssistantMessage(mission, message) &&
      (message.toolCalls?.length ?? 0) > 0
    ) {
      return index;
    }
  }
  return -1;
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

function findPausedLinkedWorkerStatus(
  assistant: TeamMessage,
  workerSessions: WorkerSessionRecord[] | "unknown" | undefined
): "waiting_input" | "waiting_external" | "resumable" | null {
  if (!Array.isArray(workerSessions)) return null;
  const callIds = new Set((assistant.toolCalls ?? []).map((call) => call.id));
  if (callIds.size === 0) return null;
  const linkedSessions = workerSessions
    .filter((session) => session.context?.toolCallId && callIds.has(session.context.toolCallId))
    .sort((left, right) => right.state.updatedAt - left.state.updatedAt);
  const paused = linkedSessions.find(
    (session) =>
      session.state.status === "resumable" ||
      session.state.status === "waiting_external" ||
      session.state.status === "waiting_input"
  );
  const status = paused?.state.status;
  return status === "resumable" || status === "waiting_external" || status === "waiting_input" ? status : null;
}

function isActiveRoleRun(run: RoleRunState): boolean {
  return (
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "waiting_worker" ||
    run.status === "resuming"
  );
}

function isActiveWorkerSession(session: WorkerSessionRecord): boolean {
  return session.state.status === "running";
}
