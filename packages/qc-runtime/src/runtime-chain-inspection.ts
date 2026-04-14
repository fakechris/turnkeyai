import type {
  FlowLedger,
  OperatorCaseState,
  RecoveryRun,
  RecoveryRunEvent,
  RoleRunState,
  RuntimeChain,
  RuntimeChainCanonicalState,
  RuntimeContinuityState,
  RuntimeChainEvent,
  RuntimeChainPhase,
  RuntimeChainSpan,
  RuntimeChainStatus,
  RuntimeProgressEvent,
  RuntimeSummaryEntry,
  RuntimeSummaryReport,
  ReplayRecord,
  WorkerSessionState,
} from "@turnkeyai/core-types/team";
import { decodeBrowserSessionPayload } from "@turnkeyai/core-types/browser-session-payload";

import { buildFlowConsoleReport } from "./operator-inspection";
import { buildRecoveryRunProgress, buildRecoveryRunTimeline, buildReplayIncidentBundle } from "./replay-inspection";

export interface RuntimeChainDetail {
  chain: RuntimeChain;
  status: RuntimeChainStatus;
  spans: RuntimeChainSpan[];
  events: RuntimeChainEvent[];
}

const RUNTIME_HEARTBEAT_STALE_AFTER_MS = 3 * 60 * 1000;
const RUNTIME_WAITING_STALE_AFTER_MS = 15 * 60 * 1000;
const RUNTIME_RECONNECT_WINDOW_MS = 60 * 1000;

interface RuntimeChainCaseContext {
  caseKey: string;
  caseState: OperatorCaseState;
  severity: "warning" | "critical";
  headline: string;
  nextStep: string;
}

export function deriveRuntimeChainCanonicalState(
  status: RuntimeChainStatus,
  now = Date.now()
): RuntimeChainCanonicalState {
  if (status.phase === "resolved" || status.phase === "completed" || status.phase === "cancelled") {
    return "resolved";
  }
  if (status.phase === "failed") {
    return "failed";
  }
  if (status.continuityState === "reconnecting") {
    return status.stale ? "degraded" : "heartbeat";
  }
  if (status.phase === "degraded" || isRuntimeChainStale(status, now)) {
    return "degraded";
  }
  if (status.phase === "heartbeat") {
    return "heartbeat";
  }
  if (status.phase === "waiting") {
    return "waiting";
  }
  return "open";
}

export function isRuntimeChainStale(status: RuntimeChainStatus, now = Date.now()): boolean {
  return buildRuntimeChainStaleReason(status, now) != null;
}

export function decorateRuntimeChainStatus(input: {
  chain: RuntimeChain;
  status: RuntimeChainStatus;
  now?: number;
  flow?: FlowLedger | null;
  records?: ReplayRecord[];
  recoveryRun?: RecoveryRun | null;
  progressEvents?: RuntimeProgressEvent[];
}): RuntimeChainStatus {
  const now = input.now ?? Date.now();
  const progressAugmentedStatus = applyRuntimeProgressToStatus(stripRuntimeChainDecorations(input.status), input.progressEvents);
  const staleReason = buildRuntimeChainStaleReason(progressAugmentedStatus, now);
  const provisionalStatus = staleReason
    ? {
        ...progressAugmentedStatus,
        stale: true,
        staleReason,
      }
    : progressAugmentedStatus;
  const canonicalState = deriveRuntimeChainCanonicalState(provisionalStatus, now);
  const caseContext = buildRuntimeChainCaseContext(input);
  return {
    ...provisionalStatus,
    canonicalState,
    continuityState: staleReason
      ? deriveRuntimeContinuityState(provisionalStatus)
      : progressAugmentedStatus.continuityState ?? deriveRuntimeContinuityState(provisionalStatus),
    ...(staleReason && !progressAugmentedStatus.continuityReason ? { continuityReason: staleReason } : {}),
    ...(caseContext
      ? {
          caseKey: caseContext.caseKey,
          caseState: caseContext.caseState,
          severity: caseContext.severity,
          headline: caseContext.headline,
          nextStep: caseContext.nextStep,
        }
      : {}),
  };
}

export function buildRuntimeSummaryReport(input: {
  entries: Array<{ chain: RuntimeChain; status: RuntimeChainStatus }>;
  limit?: number;
  now?: number;
}): RuntimeSummaryReport {
  const limit = input.limit ?? 10;
  const sorted = [...input.entries].sort((left, right) => right.status.updatedAt - left.status.updatedAt);
  const stateCounts: RuntimeSummaryReport["stateCounts"] = {};
  const continuityCounts: RuntimeSummaryReport["continuityCounts"] = {};
  const caseStateCounts: RuntimeSummaryReport["caseStateCounts"] = {};
  let activeCount = 0;
  let waitingCount = 0;
  let failedCount = 0;
  let resolvedCount = 0;
  let staleCount = 0;
  let attentionCount = 0;

  const summaries = sorted.map((entry) => {
    const status = decorateRuntimeChainStatus(
      input.now == null
        ? {
            chain: entry.chain,
            status: entry.status,
          }
        : {
            chain: entry.chain,
            status: entry.status,
            now: input.now,
          }
    );
    const summary = buildRuntimeSummaryEntry(entry.chain, status);
    stateCounts[summary.canonicalState] = (stateCounts[summary.canonicalState] ?? 0) + 1;
    if (summary.continuityState) {
      continuityCounts[summary.continuityState] = (continuityCounts[summary.continuityState] ?? 0) + 1;
    }
    if (summary.caseState) {
      caseStateCounts[summary.caseState] = (caseStateCounts[summary.caseState] ?? 0) + 1;
    }
    if (summary.canonicalState !== "resolved" && summary.canonicalState !== "failed") {
      activeCount += 1;
    }
    if (summary.canonicalState === "waiting") {
      waitingCount += 1;
    }
    if (summary.canonicalState === "failed") {
      failedCount += 1;
    }
    if (summary.canonicalState === "resolved") {
      resolvedCount += 1;
    }
    if (summary.stale) {
      staleCount += 1;
    }
    if (summary.attention) {
      attentionCount += 1;
    }
    return summary;
  });

  return {
    totalChains: summaries.length,
    activeCount,
    waitingCount,
    failedCount,
    resolvedCount,
    staleCount,
    attentionCount,
    stateCounts,
    continuityCounts,
    caseStateCounts,
    attentionChains: summaries
      .filter(
        (entry) =>
          entry.attention ||
          entry.stale ||
          entry.canonicalState === "failed" ||
          entry.canonicalState === "degraded" ||
          entry.canonicalState === "waiting"
      )
      .slice(0, limit),
    activeChains: summaries
      .filter((entry) => ["open", "heartbeat", "waiting", "degraded"].includes(entry.canonicalState))
      .slice(0, limit),
    waitingChains: summaries.filter((entry) => entry.canonicalState === "waiting").slice(0, limit),
    staleChains: summaries.filter((entry) => entry.stale).slice(0, limit),
    failedChains: summaries.filter((entry) => entry.canonicalState === "failed").slice(0, limit),
    recentlyResolved: summaries.filter((entry) => entry.canonicalState === "resolved").slice(0, limit),
  };
}

export function buildAugmentedFlowRuntimeChainEntry(input: {
  chain: RuntimeChain;
  status: RuntimeChainStatus;
  flow?: FlowLedger | null;
  records?: ReplayRecord[];
  roleRuns: RoleRunState[];
  workerStatesByRunKey: Map<string, WorkerSessionState>;
  now?: number;
}): {
  chain: RuntimeChain;
  status: RuntimeChainStatus;
} {
  const projection = projectLiveFlowState(input);
  const decoratedStatusInput = {
    chain: input.chain,
    status: projection.status,
    ...(input.flow !== undefined ? { flow: input.flow } : {}),
    ...(input.records !== undefined ? { records: input.records } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  };
  return {
    chain: input.chain,
    status: decorateRuntimeChainStatus(decoratedStatusInput),
  };
}

export function buildAugmentedFlowRuntimeChainDetail(input: {
  chain: RuntimeChain;
  status: RuntimeChainStatus;
  spans: RuntimeChainSpan[];
  events: RuntimeChainEvent[];
  flow?: FlowLedger | null;
  records?: ReplayRecord[];
  roleRuns: RoleRunState[];
  workerStatesByRunKey: Map<string, WorkerSessionState>;
  now?: number;
  progressEvents?: RuntimeProgressEvent[];
}): RuntimeChainDetail {
  const projection = projectLiveFlowState(input);
  const existingSpanIds = new Set(input.spans.map((span) => span.spanId));
  const spans = [...input.spans];
  for (const span of projection.syntheticSpans) {
    if (!existingSpanIds.has(span.spanId)) {
      spans.push(span);
    }
  }

  const existingEventIds = new Set(input.events.map((event) => event.eventId));
  const events = [...input.events];
  for (const event of projection.syntheticEvents) {
    if (!existingEventIds.has(event.eventId)) {
      events.push(event);
    }
  }

  const status = decorateRuntimeChainStatus({
    chain: input.chain,
    status: projection.status,
    ...(input.flow !== undefined ? { flow: input.flow } : {}),
    ...(input.records !== undefined ? { records: input.records } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.progressEvents !== undefined ? { progressEvents: input.progressEvents } : {}),
  });
  const staleEvent = buildRuntimeStaleEvent(input.chain, status);
  if (staleEvent && !existingEventIds.has(staleEvent.eventId)) {
    events.push(staleEvent);
  }

  return {
    chain: input.chain,
    status,
    spans: spans.sort((left, right) => left.updatedAt - right.updatedAt),
    events: events.sort((left, right) => left.recordedAt - right.recordedAt),
  };
}

export function buildDerivedRecoveryRuntimeChain(run: RecoveryRun): {
  chain: RuntimeChain;
  status: RuntimeChainStatus;
} {
  const progress = buildRecoveryRunProgress(run);
  const chain: RuntimeChain = {
      chainId: run.recoveryRunId,
      threadId: run.threadId,
      rootKind: "recovery",
      rootId: run.recoveryRunId,
      ...(run.flowId ? { flowId: run.flowId } : {}),
      ...(run.taskId ? { taskId: run.taskId } : {}),
      ...(run.roleId ? { roleId: run.roleId } : {}),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  const status = decorateRuntimeChainStatus({
    chain,
    status: {
      chainId: run.recoveryRunId,
      threadId: run.threadId,
      activeSpanId: buildRecoveryRunSpanId(run.recoveryRunId),
      activeSubjectKind: "recovery_run",
      activeSubjectId: run.recoveryRunId,
      phase: mapRecoveryStatusToChainPhase(run.status),
      ...(run.waitingReason ? { waitingReason: run.waitingReason } : {}),
      latestSummary: progress.phaseSummary,
      lastHeartbeatAt: run.updatedAt,
      continuityState: mapRecoveryStatusToContinuityState(run.status),
      ...(run.waitingReason ? { continuityReason: run.waitingReason } : {}),
      ...(run.status === "running" || run.status === "retrying" || run.status === "fallback_running" || run.status === "resumed"
        ? { responseTimeoutAt: run.updatedAt + RUNTIME_HEARTBEAT_STALE_AFTER_MS }
        : run.status === "waiting_approval" || run.status === "waiting_external"
          ? { responseTimeoutAt: run.updatedAt + RUNTIME_WAITING_STALE_AFTER_MS }
          : {}),
      latestChildSpanId: buildRecoveryRunSpanId(run.recoveryRunId),
      attention: run.status === "failed" || run.status === "waiting_approval" || run.status === "waiting_external",
      updatedAt: run.updatedAt,
      ...(run.waitingReason
        ? {
            currentWaitingSpanId: buildRecoveryRunSpanId(run.recoveryRunId),
            currentWaitingPoint: run.waitingReason,
          }
        : {}),
      ...(run.browserSession && run.status === "resumed"
        ? { reconnectWindowUntil: run.updatedAt + RUNTIME_RECONNECT_WINDOW_MS }
        : {}),
      ...(run.status === "failed" ? { closeKind: "worker_failed" as const } : run.status === "aborted" ? { closeKind: "cancelled" as const } : {}),
      ...(run.status === "recovered" ? { lastCompletedSpanId: buildRecoveryRunSpanId(run.recoveryRunId) } : {}),
      ...(run.status === "failed" ? { lastFailedSpanId: buildRecoveryRunSpanId(run.recoveryRunId) } : {}),
    },
    recoveryRun: run,
  });
  return {
    chain,
    status,
  };
}

export function buildDerivedRecoveryRuntimeChainDetail(input: {
  run: RecoveryRun;
  records: ReplayRecord[];
  events: RecoveryRunEvent[];
}): RuntimeChainDetail {
  const summary = buildDerivedRecoveryRuntimeChain(input.run);
  summary.status = decorateRuntimeChainStatus({
    chain: summary.chain,
    status: summary.status,
    records: input.records,
    recoveryRun: input.run,
  });
  const recoverySpanId = buildRecoveryRunSpanId(input.run.recoveryRunId);
  const timeline = buildRecoveryRunTimeline(input.run, input.records, input.events);
  const spans: RuntimeChainSpan[] = [
    {
      spanId: recoverySpanId,
      chainId: input.run.recoveryRunId,
      subjectKind: "recovery_run",
      subjectId: input.run.recoveryRunId,
      threadId: input.run.threadId,
      ...(input.run.flowId ? { flowId: input.run.flowId } : {}),
      ...(input.run.taskId ? { taskId: input.run.taskId } : {}),
      ...(input.run.roleId ? { roleId: input.run.roleId } : {}),
      ...(input.run.targetWorker ? { workerType: input.run.targetWorker } : {}),
      createdAt: input.run.createdAt,
      updatedAt: input.run.updatedAt,
    },
  ];

  const seenSpanIds = new Set(spans.map((span) => span.spanId));
  const runtimeEvents: RuntimeChainEvent[] = [];

  for (const entry of timeline) {
    const subjectKind =
      entry.source === "replay"
        ? entry.layer === "browser"
          ? "browser_session"
          : "replay_group"
        : "recovery_run";
    const subjectId =
      entry.source === "replay"
        ? entry.groupId ?? entry.replayId ?? input.run.sourceGroupId
        : input.run.recoveryRunId;
    const spanId =
      subjectKind === "browser_session"
        ? buildBrowserRuntimeSpanId(input.run.recoveryRunId, subjectId)
        : subjectKind === "replay_group"
          ? buildReplayGroupRuntimeSpanId(input.run.recoveryRunId, subjectId)
          : recoverySpanId;
    if (!seenSpanIds.has(spanId) && subjectKind !== "recovery_run") {
      spans.push({
        spanId,
        chainId: input.run.recoveryRunId,
        parentSpanId: recoverySpanId,
        subjectKind,
        subjectId,
        threadId: input.run.threadId,
        ...(input.run.flowId ? { flowId: input.run.flowId } : {}),
        ...(input.run.taskId ? { taskId: input.run.taskId } : {}),
        ...(input.run.roleId ? { roleId: input.run.roleId } : {}),
        createdAt: entry.recordedAt,
        updatedAt: entry.recordedAt,
      });
      seenSpanIds.add(spanId);
    }

    runtimeEvents.push({
      eventId: `runtime:${input.run.recoveryRunId}:${entry.entryId}`,
      chainId: input.run.recoveryRunId,
      spanId,
      ...(spanId !== recoverySpanId ? { parentSpanId: recoverySpanId } : {}),
      threadId: input.run.threadId,
      subjectKind,
      subjectId,
      phase: mapTimelineEntryToChainPhase(entry.status),
      recordedAt: entry.recordedAt,
      summary: entry.summary,
      ...(entry.failure?.message ? { statusReason: entry.failure.message } : {}),
      artifacts: {
        ...(entry.replayId ? { replayId: entry.replayId } : {}),
        recoveryRunId: input.run.recoveryRunId,
        ...(input.run.browserSession?.sessionId ? { browserSessionId: input.run.browserSession.sessionId } : {}),
        ...(input.run.browserSession?.targetId ? { browserTargetId: input.run.browserSession.targetId } : {}),
      },
      metadata: {
        ...(entry.kind ? { kind: entry.kind } : {}),
        ...(entry.action ? { action: entry.action } : {}),
        ...(entry.groupId ? { groupId: entry.groupId } : {}),
        ...(entry.layer ? { layer: entry.layer } : {}),
        ...(entry.browserOutcome ? { browserOutcome: entry.browserOutcome } : {}),
      },
    });
  }

  const staleEvent = buildRuntimeStaleEvent(summary.chain, summary.status);
  if (staleEvent) {
    runtimeEvents.push(staleEvent);
  }

  return {
    chain: summary.chain,
    status: summary.status,
    spans,
    events: runtimeEvents.sort((left, right) => left.recordedAt - right.recordedAt),
  };
}

export function isRecoveryRuntimeChainId(chainId: string): boolean {
  return chainId.startsWith("recovery:");
}

function buildRuntimeChainStaleReason(status: RuntimeChainStatus, now: number): string | undefined {
  const heartbeatAt = status.lastHeartbeatAt ?? status.updatedAt;
  if (status.reconnectWindowUntil && now > status.reconnectWindowUntil) {
    return status.continuityReason
      ? `reconnect window expired: ${status.continuityReason}`
      : "reconnect window expired";
  }
  if (status.responseTimeoutAt && now > status.responseTimeoutAt) {
    return status.waitingReason
      ? `response timeout: ${status.waitingReason}`
      : "response timeout";
  }
  if (status.phase === "heartbeat" && now - heartbeatAt > RUNTIME_HEARTBEAT_STALE_AFTER_MS) {
    return "heartbeat overdue";
  }
  if (status.phase === "waiting" && now - heartbeatAt > RUNTIME_WAITING_STALE_AFTER_MS) {
    return status.waitingReason ? `waiting too long: ${status.waitingReason}` : "waiting too long";
  }
  return undefined;
}

function buildRuntimeSummaryEntry(chain: RuntimeChain, status: RuntimeChainStatus): RuntimeSummaryEntry {
  return {
    chainId: chain.chainId,
    threadId: chain.threadId,
    rootKind: chain.rootKind,
    rootId: chain.rootId,
    phase: status.phase,
    canonicalState: status.canonicalState ?? deriveRuntimeChainCanonicalState(status),
    ...(status.continuityState ? { continuityState: status.continuityState } : {}),
    attention: status.attention,
    updatedAt: status.updatedAt,
    ...(status.stale ? { stale: true } : {}),
    ...(status.staleReason ? { staleReason: status.staleReason } : {}),
    ...(status.activeSubjectKind ? { activeSubjectKind: status.activeSubjectKind } : {}),
    ...(status.activeSubjectId ? { activeSubjectId: status.activeSubjectId } : {}),
    ...(status.waitingReason ? { waitingReason: status.waitingReason } : {}),
    ...(status.currentWaitingPoint ? { currentWaitingPoint: status.currentWaitingPoint } : {}),
    ...(status.latestChildSpanId ? { latestChildSpanId: status.latestChildSpanId } : {}),
    ...(status.lastCompletedSpanId ? { lastCompletedSpanId: status.lastCompletedSpanId } : {}),
    ...(status.lastFailedSpanId ? { lastFailedSpanId: status.lastFailedSpanId } : {}),
    ...(status.caseKey ? { caseKey: status.caseKey } : {}),
    ...(status.caseState ? { caseState: status.caseState } : {}),
    ...(status.headline ? { headline: status.headline } : {}),
    ...(status.nextStep ? { nextStep: status.nextStep } : {}),
  };
}

function buildRuntimeChainCaseContext(input: {
  chain: RuntimeChain;
  status: RuntimeChainStatus;
  flow?: FlowLedger | null;
  records?: ReplayRecord[];
  recoveryRun?: RecoveryRun | null;
}): RuntimeChainCaseContext | null {
  if (input.recoveryRun) {
    return buildRecoveryRuntimeCaseContext(input.recoveryRun, input.records ?? []);
  }

  if (input.chain.taskId && input.records && input.records.length > 0) {
    const bundle = buildReplayIncidentBundle(input.records, input.chain.taskId);
    if (bundle?.caseState) {
      return {
        caseKey: `incident:${input.chain.taskId}`,
        caseState: bundle.caseState,
        severity: mapCaseStateToSeverity(bundle.caseState),
        headline: bundle.caseHeadline ?? input.status.latestSummary,
        nextStep: bundle.recovery?.nextAction ?? bundle.recoveryWorkflow?.nextAction ?? "observe current runtime chain",
      };
    }
  }

  if (input.flow) {
    return buildFlowRuntimeCaseContext(input.flow);
  }

  return null;
}

function applyRuntimeProgressToStatus(
  status: RuntimeChainStatus,
  progressEvents?: RuntimeProgressEvent[]
): RuntimeChainStatus {
  if (!progressEvents?.length) {
    return status;
  }

  const latest = [...progressEvents].sort((left, right) => right.recordedAt - left.recordedAt)[0];
  if (!latest || latest.recordedAt <= status.updatedAt) {
    return status;
  }

  const carriesWaitingState =
    latest.phase === "waiting" ||
    ((latest.phase === "heartbeat" || latest.progressKind === "heartbeat") && status.phase === "waiting");
  const nextStatusBase = carriesWaitingState ? status : stripRuntimeChainActivity(status);
  const nextStatus: RuntimeChainStatus = {
    ...nextStatusBase,
    updatedAt: latest.recordedAt,
    lastHeartbeatAt: latest.recordedAt,
    latestSummary: latest.summary || status.latestSummary,
    ...(latest.phase === "waiting"
      ? {
          waitingReason: latest.statusReason ?? status.waitingReason,
          currentWaitingSpanId: latest.spanId ?? status.currentWaitingSpanId,
          currentWaitingPoint: latest.summary,
        }
      : {}),
    ...(latest.phase === "completed" && latest.spanId
      ? { lastCompletedSpanId: latest.spanId }
      : {}),
    ...(latest.phase === "failed" && latest.spanId
      ? { lastFailedSpanId: latest.spanId }
      : {}),
    ...(latest.subjectKind ? { activeSubjectKind: latest.subjectKind } : {}),
    ...(latest.subjectId ? { activeSubjectId: latest.subjectId } : {}),
    ...(latest.spanId ? { activeSpanId: latest.spanId } : {}),
    ...(latest.continuityState ? { continuityState: latest.continuityState } : {}),
    ...(latest.statusReason ? { continuityReason: latest.statusReason } : {}),
    ...(latest.responseTimeoutAt ? { responseTimeoutAt: latest.responseTimeoutAt } : {}),
    ...(latest.reconnectWindowUntil ? { reconnectWindowUntil: latest.reconnectWindowUntil } : {}),
    ...(latest.closeKind ? { closeKind: latest.closeKind } : {}),
  };

  if (latest.phase === "heartbeat" || latest.progressKind === "heartbeat") {
    nextStatus.phase = status.phase === "waiting" ? "waiting" : "heartbeat";
  } else if (latest.phase === "degraded" || latest.progressKind === "boundary") {
    nextStatus.phase = latest.phase;
  } else if (latest.phase) {
    nextStatus.phase = latest.phase;
  }

  return nextStatus;
}

function buildRecoveryRuntimeCaseContext(run: RecoveryRun, records: ReplayRecord[]): RuntimeChainCaseContext {
  const bundle = buildReplayIncidentBundle(records, run.sourceGroupId);
  const runtimeCaseState = mapRecoveryStatusToCaseState(run.status);
  const caseState =
    bundle?.caseState && hasAtLeastCaseSeverity(bundle.caseState, runtimeCaseState)
      ? bundle.caseState
      : runtimeCaseState;
  const headline =
    bundle?.caseHeadline && bundle.caseState === caseState
      ? bundle.caseHeadline
      : `${run.sourceGroupId} ${caseState} next=${run.nextAction}`;
  return {
    caseKey: `incident:${run.sourceGroupId}`,
    caseState,
    severity: mapCaseStateToSeverity(caseState),
    headline,
    nextStep:
      runtimeCaseState === "waiting_manual"
        ? run.nextAction
        : bundle?.recovery?.nextAction ??
          bundle?.recoveryWorkflow?.nextAction ??
          mapRecoveryStatusToNextStep(run),
  };
}

function buildFlowRuntimeCaseContext(flow: FlowLedger): RuntimeChainCaseContext | null {
  const report = buildFlowConsoleReport([flow], Number.MAX_SAFE_INTEGER);
  const group = [...report.attentionGroups].sort(compareFlowAttentionGroups)[0];
  if (!group) {
    return null;
  }
  return {
    caseKey: `flow:${group.flowId}:${group.groupId}`,
    caseState: group.caseState,
    severity: mapCaseStateToSeverity(group.caseState),
    headline: `${group.flowId}:${group.groupId} ${group.caseState} reason=${group.reasons[0] ?? group.status}`,
    nextStep: mapFlowCaseStateToNextStep(group.caseState),
  };
}

function buildRuntimeStaleEvent(chain: RuntimeChain, status: RuntimeChainStatus): RuntimeChainEvent | null {
  if (!status.stale || !status.staleReason || !status.activeSubjectKind || !status.activeSubjectId || !status.activeSpanId) {
    return null;
  }
  return {
    eventId: `runtime:${chain.chainId}:stale:${status.activeSubjectKind}:${status.activeSubjectId}:${status.updatedAt}`,
    chainId: chain.chainId,
    spanId: status.activeSpanId,
    threadId: chain.threadId,
    subjectKind: status.activeSubjectKind,
    subjectId: status.activeSubjectId,
    phase: "degraded",
    recordedAt: status.updatedAt,
    summary: status.latestSummary,
    statusReason: status.staleReason,
  };
}

function mapRecoveryStatusToCaseState(status: RecoveryRun["status"]): OperatorCaseState {
  switch (status) {
    case "recovered":
      return "resolved";
    case "waiting_approval":
    case "waiting_external":
      return "waiting_manual";
    case "failed":
    case "aborted":
      return "blocked";
    case "retrying":
    case "fallback_running":
    case "resumed":
    case "running":
    case "superseded":
      return "recovering";
    case "planned":
    default:
      return "open";
  }
}

function mapRecoveryStatusToNextStep(run: RecoveryRun): string {
  if (run.status === "recovered") {
    return "no action required";
  }
  if (run.status === "waiting_approval") {
    return "review and approve or reject the recovery run";
  }
  if (run.status === "waiting_external") {
    return "inspect the external dependency and resume when ready";
  }
  if (run.status === "failed" || run.status === "aborted") {
    return "inspect the failed recovery run and decide on fallback or manual follow-up";
  }
  return `continue via ${run.nextAction}`;
}

function compareFlowAttentionGroups(
  left: ReturnType<typeof buildFlowConsoleReport>["attentionGroups"][number],
  right: ReturnType<typeof buildFlowConsoleReport>["attentionGroups"][number]
): number {
  return (
    compareCaseState(left.caseState, right.caseState) ||
    left.groupId.localeCompare(right.groupId)
  );
}

function mapFlowCaseStateToNextStep(caseState: OperatorCaseState): string {
  switch (caseState) {
    case "blocked":
      return "inspect conflicting or duplicate shard results before merging";
    case "recovering":
      return "wait for shard retry or follow-up completion";
    case "waiting_manual":
      return "review the follow-up requirement before continuing";
    case "resolved":
      return "no action required";
    case "open":
    default:
      return "complete missing shard coverage and re-evaluate merge readiness";
  }
}

function mapCaseStateToSeverity(caseState: OperatorCaseState): "warning" | "critical" {
  return caseState === "blocked" || caseState === "waiting_manual" ? "critical" : "warning";
}

function compareCaseState(left: OperatorCaseState, right: OperatorCaseState): number {
  return caseStateRank(right) - caseStateRank(left);
}

function hasAtLeastCaseSeverity(candidate: OperatorCaseState, baseline: OperatorCaseState): boolean {
  return caseStateRank(candidate) >= caseStateRank(baseline);
}

function caseStateRank(caseState: OperatorCaseState): number {
  switch (caseState) {
    case "blocked":
      return 4;
    case "waiting_manual":
      return 3;
    case "recovering":
      return 2;
    case "open":
      return 1;
    case "resolved":
    default:
      return 0;
  }
}

function projectLiveFlowState(input: {
  chain: RuntimeChain;
  status: RuntimeChainStatus;
  flow?: FlowLedger | null;
  roleRuns: RoleRunState[];
  workerStatesByRunKey: Map<string, WorkerSessionState>;
}): {
  status: RuntimeChainStatus;
  syntheticSpans: RuntimeChainSpan[];
  syntheticEvents: RuntimeChainEvent[];
} {
  const flow = input.flow ?? null;
  const flowSpanId = input.chain.rootKind === "flow" ? `flow:${input.chain.rootId}` : undefined;
  const liveRoleRuns = selectRelevantRoleRuns(flow, input.chain, input.roleRuns);
  const liveRoleSpans = liveRoleRuns.map((run) => buildRoleRunSpan(input.chain, run, flowSpanId));
  const liveWorkerSpans: RuntimeChainSpan[] = [];
  const liveBrowserSpans: RuntimeChainSpan[] = [];
  const liveWorkerEvents: RuntimeChainEvent[] = [];
  const liveBrowserEvents: RuntimeChainEvent[] = [];

  for (const run of liveRoleRuns) {
    const roleSpanId = buildRoleRunSpanId(run.runKey);
    for (const workerRunKey of Object.values(run.workerSessions ?? {})) {
      if (!workerRunKey) {
        continue;
      }
      const workerState = input.workerStatesByRunKey.get(workerRunKey);
      if (!workerState) {
        continue;
      }
      const workerSpanId = buildWorkerRunSpanId(workerState.workerRunKey);
      liveWorkerSpans.push(buildWorkerRunSpan(input.chain, run, workerState, roleSpanId));
      liveWorkerEvents.push(buildWorkerRunEvent(input.chain, run, workerState, roleSpanId));
      const browserSession = workerState.workerType === "browser" ? decodeBrowserSessionPayload(workerState.lastResult?.payload) : null;
      if (browserSession?.sessionId) {
        liveBrowserSpans.push(buildLiveBrowserSessionSpan(input.chain, run, workerState, browserSession, workerSpanId));
        liveBrowserEvents.push(buildLiveBrowserSessionEvent(input.chain, run, workerState, browserSession, workerSpanId));
      }
    }
  }

  const liveRoleEvents = liveRoleRuns.map((run) => buildRoleRunEvent(input.chain, run, flowSpanId));
  const activeWorker = selectActiveWorker(input.workerStatesByRunKey, liveRoleRuns);
  const activeRole = selectActiveRole(liveRoleRuns);

  if (activeWorker) {
    return {
      status: buildWorkerDerivedStatus(input.status, activeWorker),
      syntheticSpans: [...liveRoleSpans, ...liveWorkerSpans, ...liveBrowserSpans],
      syntheticEvents: [...liveRoleEvents, ...liveWorkerEvents, ...liveBrowserEvents],
    };
  }

  if (activeRole) {
    return {
      status: buildRoleDerivedStatus(input.status, activeRole),
      syntheticSpans: [...liveRoleSpans, ...liveWorkerSpans, ...liveBrowserSpans],
      syntheticEvents: [...liveRoleEvents, ...liveWorkerEvents, ...liveBrowserEvents],
    };
  }

  return {
    status: flow ? buildFlowDerivedStatus(input.status, flow, input.chain) : input.status,
    syntheticSpans: [...liveRoleSpans, ...liveWorkerSpans, ...liveBrowserSpans],
    syntheticEvents: [...liveRoleEvents, ...liveWorkerEvents, ...liveBrowserEvents],
  };
}

function buildRecoveryRunSpanId(recoveryRunId: string): string {
  return `recovery_run:${recoveryRunId}`;
}

function buildReplayGroupRuntimeSpanId(recoveryRunId: string, groupId: string): string {
  return `replay_group:${recoveryRunId}:${groupId}`;
}

function buildBrowserRuntimeSpanId(recoveryRunId: string, subjectId: string): string {
  return `browser_session:${recoveryRunId}:${subjectId}`;
}

function buildRoleRunSpanId(runKey: string): string {
  return `role_run:${runKey}`;
}

function buildWorkerRunSpanId(workerRunKey: string): string {
  return `worker_run:${workerRunKey}`;
}

function buildLiveBrowserSessionSpanId(chainId: string, browserSessionId: string): string {
  return `browser_session:${chainId}:${browserSessionId}`;
}

function mapRecoveryStatusToChainPhase(status: RecoveryRun["status"]): RuntimeChainStatus["phase"] {
  switch (status) {
    case "recovered":
      return "resolved";
    case "failed":
      return "failed";
    case "aborted":
      return "cancelled";
    case "waiting_approval":
    case "waiting_external":
      return "waiting";
    case "running":
    case "retrying":
    case "fallback_running":
    case "resumed":
    case "superseded":
      return "heartbeat";
    case "planned":
    default:
      return "started";
  }
}

function selectRelevantRoleRuns(
  flow: FlowLedger | null,
  chain: RuntimeChain,
  roleRuns: RoleRunState[]
): RoleRunState[] {
  const relevantRoleIds = new Set<string>();
  if (chain.roleId) {
    relevantRoleIds.add(chain.roleId);
  }
  if (flow?.nextExpectedRoleId) {
    relevantRoleIds.add(flow.nextExpectedRoleId);
  }
  for (const roleId of flow?.activeRoleIds ?? []) {
    relevantRoleIds.add(roleId);
  }
  return roleRuns
    .filter((run) => relevantRoleIds.has(run.roleId))
    .sort((left, right) => right.lastActiveAt - left.lastActiveAt);
}

function selectActiveRole(roleRuns: RoleRunState[]): RoleRunState | null {
  return (
    roleRuns.find((run) => !["idle", "done"].includes(run.status)) ??
    roleRuns.find((run) => run.status === "failed") ??
    null
  );
}

function selectActiveWorker(
  workerStatesByRunKey: Map<string, WorkerSessionState>,
  roleRuns: RoleRunState[]
): { run: RoleRunState; worker: WorkerSessionState } | null {
  const candidates: Array<{ run: RoleRunState; worker: WorkerSessionState }> = [];
  for (const run of roleRuns) {
    for (const workerRunKey of Object.values(run.workerSessions ?? {})) {
      if (!workerRunKey) {
        continue;
      }
      const worker = workerStatesByRunKey.get(workerRunKey);
      if (!worker) {
        continue;
      }
      if (["done", "cancelled"].includes(worker.status)) {
        continue;
      }
      candidates.push({ run, worker });
    }
  }
  candidates.sort((left, right) => right.worker.updatedAt - left.worker.updatedAt);
  return candidates[0] ?? null;
}

function buildRoleRunSpan(chain: RuntimeChain, run: RoleRunState, parentSpanId?: string): RuntimeChainSpan {
  return {
    spanId: buildRoleRunSpanId(run.runKey),
    chainId: chain.chainId,
    ...(parentSpanId ? { parentSpanId } : {}),
    subjectKind: "role_run",
    subjectId: run.runKey,
    threadId: run.threadId,
    ...(chain.flowId ? { flowId: chain.flowId } : {}),
    roleId: run.roleId,
    createdAt: run.lastUserTouchAt ?? run.lastActiveAt,
    updatedAt: run.lastActiveAt,
  };
}

function buildWorkerRunSpan(
  chain: RuntimeChain,
  run: RoleRunState,
  worker: WorkerSessionState,
  parentSpanId?: string
): RuntimeChainSpan {
  return {
    spanId: buildWorkerRunSpanId(worker.workerRunKey),
    chainId: chain.chainId,
    ...(parentSpanId ? { parentSpanId } : {}),
    subjectKind: "worker_run",
    subjectId: worker.workerRunKey,
    threadId: chain.threadId,
    ...(chain.flowId ? { flowId: chain.flowId } : {}),
    ...(worker.currentTaskId ? { taskId: worker.currentTaskId } : {}),
    roleId: run.roleId,
    workerType: worker.workerType,
    createdAt: worker.createdAt,
    updatedAt: worker.updatedAt,
  };
}

function buildRoleRunEvent(chain: RuntimeChain, run: RoleRunState, parentSpanId?: string): RuntimeChainEvent {
  const statusReason = buildRoleRunWaitingReason(run);
  return {
    eventId: `runtime-live:${chain.chainId}:${buildRoleRunSpanId(run.runKey)}:${run.lastActiveAt}`,
    chainId: chain.chainId,
    spanId: buildRoleRunSpanId(run.runKey),
    ...(parentSpanId ? { parentSpanId } : {}),
    threadId: chain.threadId,
    subjectKind: "role_run",
    subjectId: run.runKey,
    phase: mapRoleStatusToChainPhase(run.status),
    recordedAt: run.lastActiveAt,
    summary: summarizeRoleRun(run),
    ...(statusReason ? { statusReason } : {}),
    metadata: {
      roleId: run.roleId,
      status: run.status,
      inboxSize: run.inbox.length,
      iterationCount: run.iterationCount,
    },
  };
}

function buildWorkerRunEvent(
  chain: RuntimeChain,
  run: RoleRunState,
  worker: WorkerSessionState,
  parentSpanId?: string
): RuntimeChainEvent {
  const browserSession = worker.workerType === "browser" ? decodeBrowserSessionPayload(worker.lastResult?.payload) : null;
  const statusReason = buildWorkerRunWaitingReason(worker);
  return {
    eventId: `runtime-live:${chain.chainId}:${buildWorkerRunSpanId(worker.workerRunKey)}:${worker.updatedAt}`,
    chainId: chain.chainId,
    spanId: buildWorkerRunSpanId(worker.workerRunKey),
    ...(parentSpanId ? { parentSpanId } : {}),
    threadId: chain.threadId,
    subjectKind: "worker_run",
    subjectId: worker.workerRunKey,
    phase: mapWorkerStatusToChainPhase(worker.status),
    recordedAt: worker.updatedAt,
    summary: summarizeWorkerRun(worker),
    ...(statusReason ? { statusReason } : {}),
    artifacts: {
      ...(worker.currentTaskId ? { dispatchTaskId: worker.currentTaskId } : {}),
      ...(browserSession?.sessionId ? { browserSessionId: browserSession.sessionId } : {}),
      ...(browserSession?.targetId ? { browserTargetId: browserSession.targetId } : {}),
    },
    metadata: {
      roleId: run.roleId,
      workerType: worker.workerType,
      status: worker.status,
      ...(worker.continuationDigest?.reason ? { continuationReason: worker.continuationDigest.reason } : {}),
      ...(browserSession?.resumeMode ? { browserResumeMode: browserSession.resumeMode } : {}),
    },
  };
}

function buildLiveBrowserSessionSpan(
  chain: RuntimeChain,
  run: RoleRunState,
  worker: WorkerSessionState,
  browserSession: ReturnType<typeof decodeBrowserSessionPayload> & { sessionId: string },
  parentSpanId?: string
): RuntimeChainSpan {
  return {
    spanId: buildLiveBrowserSessionSpanId(chain.chainId, browserSession.sessionId),
    chainId: chain.chainId,
    ...(parentSpanId ? { parentSpanId } : {}),
    subjectKind: "browser_session",
    subjectId: browserSession.sessionId,
    threadId: chain.threadId,
    ...(chain.flowId ? { flowId: chain.flowId } : {}),
    ...(worker.currentTaskId ? { taskId: worker.currentTaskId } : {}),
    roleId: run.roleId,
    workerType: worker.workerType,
    createdAt: worker.createdAt,
    updatedAt: worker.updatedAt,
  };
}

function buildLiveBrowserSessionEvent(
  chain: RuntimeChain,
  run: RoleRunState,
  worker: WorkerSessionState,
  browserSession: ReturnType<typeof decodeBrowserSessionPayload> & { sessionId: string },
  parentSpanId?: string
): RuntimeChainEvent {
  return {
    eventId: `runtime-live:${chain.chainId}:${buildLiveBrowserSessionSpanId(chain.chainId, browserSession.sessionId)}:${worker.updatedAt}`,
    chainId: chain.chainId,
    spanId: buildLiveBrowserSessionSpanId(chain.chainId, browserSession.sessionId),
    ...(parentSpanId ? { parentSpanId } : {}),
    threadId: chain.threadId,
    subjectKind: "browser_session",
    subjectId: browserSession.sessionId,
    phase: mapWorkerStatusToChainPhase(worker.status),
    recordedAt: worker.updatedAt,
    summary: `Browser session ${browserSession.sessionId} is ${worker.status}.`,
    artifacts: {
      browserSessionId: browserSession.sessionId,
      ...(browserSession.targetId ? { browserTargetId: browserSession.targetId } : {}),
      ...(worker.currentTaskId ? { dispatchTaskId: worker.currentTaskId } : {}),
    },
    metadata: {
      roleId: run.roleId,
      ...(browserSession.resumeMode ? { browserResumeMode: browserSession.resumeMode } : {}),
    },
  };
}

function buildRoleDerivedStatus(base: RuntimeChainStatus, run: RoleRunState): RuntimeChainStatus {
  const strippedBase = stripRuntimeChainActivity(base);
  const waitingReason = buildRoleRunWaitingReason(run);
  const spanId = buildRoleRunSpanId(run.runKey);
  return {
    ...strippedBase,
    activeSpanId: spanId,
    activeSubjectKind: "role_run",
    activeSubjectId: run.runKey,
    phase: mapRoleStatusToChainPhase(run.status),
    continuityState: mapRoleStatusToContinuityState(run.status),
    ...(waitingReason ? { continuityReason: waitingReason } : {}),
    latestSummary: summarizeRoleRun(run),
    lastHeartbeatAt: run.lastActiveAt,
    ...(run.status === "running" || run.status === "resuming"
      ? { responseTimeoutAt: run.lastActiveAt + RUNTIME_HEARTBEAT_STALE_AFTER_MS }
      : waitingReason
        ? { responseTimeoutAt: run.lastActiveAt + RUNTIME_WAITING_STALE_AFTER_MS }
        : {}),
    latestChildSpanId: spanId,
    attention: base.attention || run.status === "failed",
    updatedAt: Math.max(base.updatedAt, run.lastActiveAt),
    ...(waitingReason ? { waitingReason, currentWaitingSpanId: spanId, currentWaitingPoint: waitingReason } : {}),
    ...(run.status === "failed" ? { closeKind: "worker_failed" as const } : {}),
    ...(run.status === "failed" ? { lastFailedSpanId: spanId } : {}),
  };
}

function buildWorkerDerivedStatus(
  base: RuntimeChainStatus,
  input: { run: RoleRunState; worker: WorkerSessionState }
): RuntimeChainStatus {
  const strippedBase = stripRuntimeChainActivity(base);
  const waitingReason = buildWorkerRunWaitingReason(input.worker);
  const spanId = buildWorkerRunSpanId(input.worker.workerRunKey);
  return {
    ...strippedBase,
    activeSpanId: spanId,
    activeSubjectKind: "worker_run",
    activeSubjectId: input.worker.workerRunKey,
    phase: mapWorkerStatusToChainPhase(input.worker.status),
    continuityState: mapWorkerStatusToContinuityState(input.worker.status, input.worker.lastError?.retryable),
    ...(waitingReason ? { continuityReason: waitingReason } : {}),
    latestSummary: summarizeWorkerRun(input.worker),
    lastHeartbeatAt: input.worker.updatedAt,
    ...(input.worker.status === "running"
      ? { responseTimeoutAt: input.worker.updatedAt + RUNTIME_HEARTBEAT_STALE_AFTER_MS }
      : waitingReason
        ? { responseTimeoutAt: input.worker.updatedAt + RUNTIME_WAITING_STALE_AFTER_MS }
        : {}),
    latestChildSpanId: spanId,
    attention: base.attention || input.worker.status === "failed",
    updatedAt: Math.max(base.updatedAt, input.worker.updatedAt),
    ...(waitingReason ? { waitingReason, currentWaitingSpanId: spanId, currentWaitingPoint: waitingReason } : {}),
    ...(input.worker.status === "failed" && input.worker.lastError?.retryable
      ? { closeKind: "transport_failure" as const }
      : {}),
    ...(input.worker.status === "failed" ? { lastFailedSpanId: spanId } : {}),
  };
}

function buildFlowDerivedStatus(base: RuntimeChainStatus, flow: FlowLedger, chain: RuntimeChain): RuntimeChainStatus {
  const strippedBase = stripRuntimeChainActivity(base);
  const spanId = chain.rootKind === "flow" ? `flow:${chain.rootId}` : undefined;
  const updatedAt = Math.max(base.updatedAt, flow.updatedAt);
  const waitingReason =
    flow.status === "waiting_role"
      ? flow.nextExpectedRoleId
        ? `waiting on role ${flow.nextExpectedRoleId}`
        : "waiting on next role"
      : flow.status === "waiting_worker"
        ? "waiting on worker"
        : undefined;

  return {
    ...strippedBase,
    ...(spanId ? { activeSpanId: spanId } : {}),
    activeSubjectKind: "flow",
    activeSubjectId: flow.flowId,
    phase:
      flow.status === "running"
        ? "heartbeat"
        : flow.status === "waiting_role" || flow.status === "waiting_worker"
          ? "waiting"
          : flow.status === "completed"
            ? "completed"
            : flow.status === "failed"
              ? "failed"
              : flow.status === "aborted"
                ? "cancelled"
                : "started",
    continuityState:
      flow.status === "running"
        ? "alive"
        : flow.status === "waiting_role" || flow.status === "waiting_worker"
          ? "waiting"
          : flow.status === "failed" || flow.status === "aborted"
            ? "terminal"
            : flow.status === "completed"
              ? "resolved"
              : "alive",
    ...(waitingReason ? { continuityReason: waitingReason } : {}),
    latestSummary:
      flow.status === "running"
        ? "Flow is actively running."
        : flow.status === "waiting_role"
          ? "Flow is waiting on the next role."
          : flow.status === "waiting_worker"
            ? "Flow is waiting on a worker."
            : flow.status === "completed"
              ? "Flow completed."
              : flow.status === "failed"
                ? "Flow failed."
                : flow.status === "aborted"
                  ? "Flow aborted."
                  : "Flow created.",
    ...(flow.status === "running" || flow.status === "waiting_role" || flow.status === "waiting_worker"
      ? { lastHeartbeatAt: flow.updatedAt }
      : {}),
    ...(flow.status === "running"
      ? { responseTimeoutAt: flow.updatedAt + RUNTIME_HEARTBEAT_STALE_AFTER_MS }
      : waitingReason
        ? { responseTimeoutAt: flow.updatedAt + RUNTIME_WAITING_STALE_AFTER_MS }
        : {}),
    ...(spanId ? { latestChildSpanId: spanId } : {}),
    attention: base.attention || flow.status === "failed",
    updatedAt,
    ...(waitingReason
      ? {
          waitingReason,
          ...(spanId ? { currentWaitingSpanId: spanId } : {}),
          currentWaitingPoint: waitingReason,
        }
      : {}),
    ...(flow.status === "completed" && spanId ? { lastCompletedSpanId: spanId } : {}),
    ...(flow.status === "failed" && spanId ? { lastFailedSpanId: spanId } : {}),
  };
}

function deriveRuntimeContinuityState(status: RuntimeChainStatus): RuntimeContinuityState {
  if (status.stale) {
    return "transient_failure";
  }
  if (status.closeKind === "session_not_found" || status.closeKind === "detached_target") {
    return "reconnecting";
  }
  if (
    status.closeKind === "lease_conflict" ||
    status.closeKind === "transport_failure" ||
    status.closeKind === "timeout"
  ) {
    return "transient_failure";
  }
  if (status.closeKind === "owner_mismatch" || status.closeKind === "worker_failed" || status.closeKind === "cancelled") {
    return "terminal";
  }
  switch (status.phase) {
    case "completed":
    case "cancelled":
    case "resolved":
      return "resolved";
    case "failed":
      return "terminal";
    case "waiting":
      return "waiting";
    case "degraded":
      return status.stale ? "transient_failure" : "reconnecting";
    case "heartbeat":
    case "started":
    default:
      return "alive";
  }
}

function mapRoleStatusToChainPhase(status: RoleRunState["status"]): RuntimeChainPhase {
  switch (status) {
    case "queued":
    case "waiting_worker":
      return "waiting";
    case "running":
    case "resuming":
      return "heartbeat";
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "idle":
    default:
      return "started";
  }
}

function mapRoleStatusToContinuityState(status: RoleRunState["status"]): RuntimeContinuityState {
  switch (status) {
    case "queued":
    case "waiting_worker":
      return "waiting";
    case "running":
    case "resuming":
      return "alive";
    case "failed":
      return "terminal";
    case "done":
    case "idle":
    default:
      return "resolved";
  }
}

function mapWorkerStatusToChainPhase(status: WorkerSessionState["status"]): RuntimeChainPhase {
  switch (status) {
    case "running":
      return "heartbeat";
    case "waiting_input":
    case "waiting_external":
    case "resumable":
      return "waiting";
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "idle":
    default:
      return "started";
  }
}

function mapWorkerStatusToContinuityState(
  status: WorkerSessionState["status"],
  retryable?: boolean
): RuntimeContinuityState {
  switch (status) {
    case "running":
      return "alive";
    case "waiting_input":
    case "waiting_external":
    case "resumable":
      return "waiting";
    case "failed":
      return retryable ? "transient_failure" : "terminal";
    case "cancelled":
      return "terminal";
    case "done":
    case "idle":
    default:
      return "resolved";
  }
}

function mapRecoveryStatusToContinuityState(status: RecoveryRun["status"]): RuntimeContinuityState {
  switch (status) {
    case "waiting_approval":
    case "waiting_external":
      return "waiting";
    case "running":
    case "retrying":
    case "fallback_running":
    case "resumed":
    case "superseded":
      return "alive";
    case "failed":
      return "transient_failure";
    case "aborted":
      return "terminal";
    case "recovered":
      return "resolved";
    case "planned":
    default:
      return "alive";
  }
}

function summarizeRoleRun(run: RoleRunState): string {
  if (run.status === "waiting_worker") {
    return `${run.roleId} is waiting on a worker.`;
  }
  if (run.status === "queued") {
    return `${run.roleId} has ${run.inbox.length} queued handoff(s).`;
  }
  if (run.status === "running" || run.status === "resuming") {
    return `${run.roleId} is actively processing group work.`;
  }
  if (run.status === "failed") {
    return `${run.roleId} failed during group execution.`;
  }
  if (run.status === "done") {
    return `${run.roleId} completed group execution.`;
  }
  return `${run.roleId} is idle.`;
}

function summarizeWorkerRun(worker: WorkerSessionState): string {
  if (worker.lastError?.message && worker.status === "failed") {
    return worker.lastError.message;
  }
  if (worker.continuationDigest?.summary && ["waiting_input", "waiting_external", "resumable"].includes(worker.status)) {
    return worker.continuationDigest.summary;
  }
  if (worker.lastResult?.summary) {
    return worker.lastResult.summary;
  }
  return `${worker.workerType} worker is ${worker.status}.`;
}

function buildRoleRunWaitingReason(run: RoleRunState): string | undefined {
  if (run.status === "waiting_worker") {
    return "waiting on worker";
  }
  if (run.status === "queued") {
    return "handoff queued";
  }
  return undefined;
}

function buildWorkerRunWaitingReason(worker: WorkerSessionState): string | undefined {
  if (worker.status === "waiting_external") {
    return worker.lastError?.message ?? "waiting on external dependency";
  }
  if (worker.status === "waiting_input" || worker.status === "resumable") {
    return worker.continuationDigest?.summary ?? worker.lastResult?.summary ?? "waiting for follow-up input";
  }
  return undefined;
}

function stripRuntimeChainActivity(status: RuntimeChainStatus): RuntimeChainStatus {
  const {
    waitingReason: _waitingReason,
    currentWaitingSpanId: _currentWaitingSpanId,
    currentWaitingPoint: _currentWaitingPoint,
    responseTimeoutAt: _responseTimeoutAt,
    reconnectWindowUntil: _reconnectWindowUntil,
    closeKind: _closeKind,
    continuityReason: _continuityReason,
    stale: _stale,
    staleReason: _staleReason,
    canonicalState: _canonicalState,
    caseKey: _caseKey,
    caseState: _caseState,
    severity: _severity,
    headline: _headline,
    nextStep: _nextStep,
    ...rest
  } = status;
  return rest;
}

function stripRuntimeChainDecorations(status: RuntimeChainStatus): RuntimeChainStatus {
  const {
    stale: _stale,
    staleReason: _staleReason,
    canonicalState: _canonicalState,
    ...rest
  } = status;
  return rest;
}

function mapTimelineEntryToChainPhase(
  status: RecoveryRunEvent["status"] | "completed" | "partial" | "failed" | undefined
): RuntimeChainEvent["phase"] {
  if (status === "completed" || status === "recovered") {
    return "completed";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "aborted") {
    return "cancelled";
  }
  if (status === "waiting_approval" || status === "waiting_external" || status === "partial") {
    return "waiting";
  }
  if (status === "planned") {
    return "started";
  }
  return "heartbeat";
}
