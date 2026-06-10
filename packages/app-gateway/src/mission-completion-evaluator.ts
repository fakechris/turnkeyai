import type { Mission } from "@turnkeyai/core-types/mission";
import type {
  RoleRunState,
  TeamMessage,
  WorkerSessionRecord,
} from "@turnkeyai/core-types/team";

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
    }
  | {
      action: "update";
      reason: MissionCompletionReason;
      patch: Partial<Pick<Mission, "status" | "progress" | "blockers" | "pendingApprovals" | "closeout">>;
      recovery?: MissionCompletionRecovery;
    };

export type MissionCompletionRecovery =
  | {
      kind: "incomplete_final_answer";
      message: TeamMessage;
      reason: "max_tokens" | "truncated_markdown" | "stale_pending_approval";
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

  if (mission.status === "done") {
    return { action: "none", reason: "terminal" };
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
    if (hasActiveExecution(input.roleRuns, input.workerSessions)) {
      return { action: "none", reason: "active_execution" };
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

function hasActiveExecution(
  roleRuns: RoleRunState[] | "unknown" | undefined,
  workerSessions: WorkerSessionRecord[] | "unknown" | undefined
): boolean {
  return hasActiveRoleRun(roleRuns) || hasActiveWorkerSession(workerSessions);
}

function hasActiveRoleRun(roleRuns: RoleRunState[] | "unknown" | undefined): boolean {
  if (roleRuns === undefined || roleRuns === "unknown") return true;
  return roleRuns.some(isActiveRoleRun);
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
      !isIncompleteLeadFinalAnswer(mission, latest.message) &&
      !hasUnresolvedLeadToolTurnBeforeAnswer(mission, messages, latest.index)
  );
}

function hasCompleteBoundedFailureCloseout(mission: Mission, messages: TeamMessage[]): boolean {
  const latest = findLatestLeadAnswerCandidateWithIndex(mission, messages);
  return Boolean(
    latest &&
      !isIncompleteLeadFinalAnswer(mission, latest.message) &&
      !hasUnresolvedLeadToolTurnBeforeAnswer(mission, messages, latest.index) &&
      looksLikeCompleteBoundedFailureCloseout(mission.desc, latest.message.content)
  );
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
): { message: TeamMessage; reason: "max_tokens" | "truncated_markdown" | "stale_pending_approval" } | null {
  const latest = findLatestLeadAnswerCandidateWithIndex(mission, messages);
  return latest ? isIncompleteLeadFinalAnswer(mission, latest.message) : null;
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
    if (!isLeadAssistantMessage(mission, message)) continue;
    if ((message.toolCalls?.length ?? 0) > 0) continue;
    if (message.toolStatus === "pending") continue;
    if (index <= staleBeforeIndex) continue;
    if (hasDispatchMention(content)) continue;
    latest = { message, index };
  }
  return latest;
}

function hasDispatchMention(content: string): boolean {
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
  message: TeamMessage
): { message: TeamMessage; reason: "max_tokens" | "truncated_markdown" | "stale_pending_approval" } | null {
  if (looksLikeCompleteApprovalCloseout(message.content)) {
    return null;
  }
  if (looksLikeCompleteAwaitingContextCloseout(mission.desc, message.content)) {
    return null;
  }
  if (looksLikeStalePendingApprovalAnswer(message.content)) {
    return { message, reason: "stale_pending_approval" };
  }
  const stopReason = readStringMetadata(message.metadata, "stopReason");
  if (isMaxTokensStopReason(stopReason)) {
    return { message, reason: "max_tokens" };
  }
  if (looksLikeTruncatedMarkdown(message.content)) {
    return { message, reason: "truncated_markdown" };
  }
  return null;
}

function looksLikeStalePendingApprovalAnswer(content: string): boolean {
  return /\b(?:approval pending|approval is pending|approval is still pending|approval request is pending|approval request is still pending|permission request is pending|permission request is still pending|pending operator approval|pending operator decision|awaiting (?:decision|your decision|operator approval|operator decision|operator)|waiting for (?:your|operator) decision|waiting for operator|once you approve|after you approve)\b/i.test(
    content
  );
}

function looksLikeCompletePendingApprovalWaitTimeoutCloseout(content: string): boolean {
  return (
    /\b(?:approval|permission|operator decision)\b[\s\S]{0,180}\b(?:did not arrive|still pending|pending|timed out|timeout|wait[- ]timeout|wait boundary|attempt cycle)\b/i.test(
      content
    ) &&
    /\b(?:did not|will not|was not|not|no)\s+(?:be\s+)?(?:submit(?:ted)?|apply|perform(?:ed)?|run|complete(?:d)?|execute(?:d)?|take|taken)|\b(?:action|side effect)\s+(?:not performed|did not run)\b|\bno (?:form submission|browser action|browser mutation|mutation|side effects?|state) (?:was |were )?(?:(?:or will be )?performed|executed|taken|applied|changed|mutated)\b|\bno form submission or browser side effect was performed\b/i.test(
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
  if (!missionAllowsBrowserBoundedFailureCloseout(missionDesc)) {
    return false;
  }
  return (
    /\b(?:browser|CDP|Chrome DevTools|automation|browser automation|snapshot|screenshot|capture|scroll)\b[\s\S]{0,200}\b(?:unavailable|unreachable|cannot be reached|could not be reached|connection refused|ECONNREFUSED|could not establish|cannot establish|browser_cdp_unavailable|timed out|timeouts?|timeout|cdp_command_timeout)\b|\b(?:timed out|timeouts?|timeout|cdp_command_timeout)\b[\s\S]{0,200}\b(?:browser|CDP|Chrome DevTools|automation|snapshot|screenshot|capture|scroll)\b/i.test(
      content
    ) &&
    /\bwhat was verified\b|\bverified\b[\s\S]{0,100}\b(?:URL|target|reachable|connection|port)\b/i.test(content) &&
    /\bwhat remains unverified\b|\b(?:remains? )?unverified\b|\bnot verified\b/i.test(content) &&
    /\bnext action\b|\boperator\b[\s\S]{0,120}\b(?:should|can|must|next)\b|\bmanual(?:ly)?\b/i.test(content) &&
    /\b(?:flow|mission|task|automated work)\b[\s\S]{0,120}\b(?:closed|complete|completed|no further|not possible|cannot continue)\b|\b(?:source[- ]bounded|bounded to|scope (?:is )?limited|scope of the fixture|cannot validate real[- ]world)\b|\b(?:browser runtime infrastructure issue|target application is not the source of the failure|restart or repair the browser runtime|re-submit the review task|resubmit the review task|no live production system is affected)\b/i.test(
      content
    )
  );
}

function missionAllowsBrowserBoundedFailureCloseout(missionDesc: string): boolean {
  return /\bif\b[\s\S]{0,120}\b(?:browser|CDP|automation)\b[\s\S]{0,120}\b(?:cannot|can't|unavailable|unreachable|refused|cannot be reached|could not be reached|times? out|timed out|timeout)\b[\s\S]{0,160}\b(?:close out|closeout|what was verified|remains? unverified|next action)\b/i.test(
    missionDesc
  );
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
  const index = findLatestLeadToolMessageIndex(mission, messages);
  return index >= 0 ? messages[index]! : null;
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
