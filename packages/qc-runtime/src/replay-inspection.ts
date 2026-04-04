import type {
  BrowserContinuationHint,
  FailureCategory,
  RecoveryBrowserOutcome,
  ReplayBrowserContinuitySummary,
  RecoveryRun,
  RecoveryRunEvent,
  RecoveryRunProgress,
  RecoveryRunAttempt,
  RecoveryRunTimelineEntry,
  RecoveryTransitionReason,
  ReplayConsoleReport,
  ReplayIncidentBundle,
  ReplayInspectionReport,
  ReplayLayer,
  ReplayRecoveryPlan,
  ReplayRecord,
  ReplayRecoveryHint,
  ReplayTaskSummary,
  ReplayTimelineEntry,
} from "@turnkeyai/core-types/team";
import { describeRecoveryRunGate, listAllowedRecoveryRunActions } from "@turnkeyai/core-types/recovery-operator-semantics";

const REPLAY_LAYER_ORDER: ReplayLayer[] = ["scheduled", "role", "worker", "browser"];
const MAX_RETRY_ATTEMPTS_BEFORE_ESCALATION = 2;
const MAX_FALLBACK_ATTEMPTS_BEFORE_INSPECTION = 2;

export interface RelayDiagnosticsSnapshot {
  peers: Array<{
    peerId: string;
    label?: string;
    transportLabel?: string;
    lastSeenAt: number;
    status: "online" | "stale";
  }>;
  targets: Array<{
    relayTargetId: string;
    peerId: string;
    url: string;
    title?: string;
    status?: "open" | "attached" | "detached" | "closed";
    lastSeenAt: number;
  }>;
}

export function buildReplayInspectionReport(records: ReplayRecord[]): ReplayInspectionReport {
  const layerCounts: Partial<Record<ReplayLayer, number>> = {};
  const failureCounts: Partial<Record<FailureCategory, number>> = {};
  const groups = new Map<string, ReplayTaskSummary>();

  for (const record of records) {
    layerCounts[record.layer] = (layerCounts[record.layer] ?? 0) + 1;
    if (record.failure) {
      failureCounts[record.failure.category] = (failureCounts[record.failure.category] ?? 0) + 1;
    }

    const groupId = record.taskId ?? record.replayId;
    const existing = groups.get(groupId);
    const layerSnapshot = {
      replayId: record.replayId,
      layer: record.layer,
      status: record.status,
      recordedAt: record.recordedAt,
      summary: record.summary,
      ...(record.workerType ? { workerType: record.workerType } : {}),
      ...(record.failure ? { failure: record.failure } : {}),
    };

    if (!existing) {
      groups.set(groupId, {
        groupId,
        threadId: record.threadId,
        ...(record.taskId ? { taskId: record.taskId } : {}),
        ...(record.flowId ? { flowId: record.flowId } : {}),
        ...(record.roleId ? { roleId: record.roleId } : {}),
        latestRecordedAt: record.recordedAt,
        latestStatus: record.status,
        layersSeen: [record.layer],
        replayIds: [record.replayId],
        byLayer: {
          [record.layer]: layerSnapshot,
        },
        ...(record.status === "completed" ? { lastHealthyLayer: record.layer } : {}),
        ...(record.status !== "completed" ? { failedLayer: record.layer } : {}),
        ...(record.failure ? { rootFailureCategory: record.failure.category } : {}),
        ...(record.failure ? { latestFailure: record.failure, recommendedAction: record.failure.recommendedAction } : {}),
        recoveryHint: buildRecoveryHint({
          latestStatus: record.status,
          latestFailure: record.failure,
          lastHealthyLayer: record.status === "completed" ? record.layer : undefined,
          failedLayer: record.status !== "completed" ? record.layer : undefined,
          requiresFollowUp: record.status !== "completed" || Boolean(record.failure),
        }),
        requiresFollowUp: record.status !== "completed" || Boolean(record.failure),
        ...(extractReplayBrowserContinuity(record)
          ? { browserContinuity: extractReplayBrowserContinuity(record)! }
          : {}),
      });
      continue;
    }

    existing.replayIds.push(record.replayId);
    if (!existing.layersSeen.includes(record.layer)) {
      existing.layersSeen.push(record.layer);
      existing.layersSeen.sort((left, right) => REPLAY_LAYER_ORDER.indexOf(left) - REPLAY_LAYER_ORDER.indexOf(right));
    }

    const existingLayer = existing.byLayer[record.layer];
    if (!existingLayer || existingLayer.recordedAt <= record.recordedAt) {
      existing.byLayer[record.layer] = layerSnapshot;
    }

    if (record.recordedAt >= existing.latestRecordedAt) {
      existing.latestRecordedAt = record.recordedAt;
      existing.latestStatus = record.status;
      if (record.flowId) {
        existing.flowId = record.flowId;
      }
      if (record.roleId) {
        existing.roleId = record.roleId;
      }
    }

    if (record.status === "completed") {
      const currentHealthyRank = existing.lastHealthyLayer ? REPLAY_LAYER_ORDER.indexOf(existing.lastHealthyLayer) : -1;
      const nextHealthyRank = REPLAY_LAYER_ORDER.indexOf(record.layer);
      if (nextHealthyRank >= currentHealthyRank) {
        existing.lastHealthyLayer = record.layer;
      }
    } else {
      existing.failedLayer = record.layer;
    }

    const latestFailureRecordedAt = existing.latestFailure
      ? (existing.byLayer[existing.latestFailure.layer]?.recordedAt ?? 0)
      : 0;
    if (record.failure && (!existing.latestFailure || latestFailureRecordedAt <= record.recordedAt)) {
      existing.latestFailure = record.failure;
      existing.recommendedAction = record.failure.recommendedAction;
      existing.rootFailureCategory = record.failure.category;
    }

    const browserContinuity = extractReplayBrowserContinuity(record);
    if (browserContinuity) {
      if (!existing.browserContinuity || existing.browserContinuity.latestRecordedAt <= browserContinuity.latestRecordedAt) {
        existing.browserContinuity = mergeBrowserContinuity(existing.browserContinuity, browserContinuity);
      } else {
        existing.browserContinuity = mergeBrowserContinuity(browserContinuity, existing.browserContinuity);
      }
    }

    existing.requiresFollowUp =
      existing.requiresFollowUp ||
      record.status !== "completed" ||
      Boolean(record.failure);
    existing.recoveryHint = buildRecoveryHint({
      latestStatus: existing.latestStatus,
      latestFailure: existing.latestFailure,
      lastHealthyLayer: existing.lastHealthyLayer,
      failedLayer: existing.failedLayer,
      requiresFollowUp: existing.requiresFollowUp,
    });
  }

  const sortedGroups = [...groups.values()].sort((left, right) => right.latestRecordedAt - left.latestRecordedAt);
  const incidents = sortedGroups.filter((group) => group.requiresFollowUp);

  return {
    totalReplays: records.length,
    totalGroups: sortedGroups.length,
    incidents,
    groups: sortedGroups,
    layerCounts,
    failureCounts,
  };
}

export function findReplayTaskSummary(
  records: ReplayRecord[],
  groupId: string,
  report?: ReplayInspectionReport
): ReplayTaskSummary | null {
  const resolvedReport = report ?? buildReplayInspectionReport(records);
  return resolvedReport.groups.find((group) => group.groupId === groupId) ?? null;
}

export function buildReplayRecoveryPlans(
  records: ReplayRecord[],
  report?: ReplayInspectionReport
): ReplayRecoveryPlan[] {
  const resolvedReport = report ?? buildReplayInspectionReport(records);
  return resolvedReport.groups
    .filter((group) => group.requiresFollowUp)
    .map((group) => buildReplayRecoveryPlan(group));
}

export function findReplayRecoveryPlan(
  records: ReplayRecord[],
  groupId: string,
  report?: ReplayInspectionReport
): ReplayRecoveryPlan | null {
  const summary = findReplayTaskSummary(records, groupId, report);
  if (!summary || !summary.requiresFollowUp) {
    return null;
  }
  return buildReplayRecoveryPlan(summary);
}

export function buildReplayConsoleReport(
  records: ReplayRecord[],
  limit = 10,
  recoveryRuns: RecoveryRun[] = [],
  relayDiagnostics?: RelayDiagnosticsSnapshot
): ReplayConsoleReport {
  const report = buildReplayInspectionReport(records);
  const incidentGroups = listActionableReplayIncidents(records, report);
  const recoveries = incidentGroups.map((group) => buildReplayRecoveryPlan(group));
  const recoveryRunByGroupId = new Map(recoveryRuns.map((run) => [run.sourceGroupId, run]));
  const bundleByGroupId = new Map(
    incidentGroups.map((group) => [
      group.groupId,
      buildReplayConsoleBundle(records, group.groupId, recoveryRunByGroupId, relayDiagnostics),
    ])
  );
  const actionableGroupIds = new Set(incidentGroups.map((group) => group.groupId));
  const replayParentByGroupId = buildReplayParentByGroupId(records);
  const actionCounts: ReplayConsoleReport["actionCounts"] = {};
  const workflowStatusCounts: ReplayConsoleReport["workflowStatusCounts"] = {};
  const caseStateCounts: ReplayConsoleReport["caseStateCounts"] = {};
  const operatorCaseStateCounts: ReplayConsoleReport["operatorCaseStateCounts"] = {};
  const browserContinuityCounts: ReplayConsoleReport["browserContinuityCounts"] = {};
  const resolvedRootGroupIds = new Set<string>();
  const resolvedBundles: ReplayIncidentBundle[] = [];

  const countBundleStates = (bundle: ReplayIncidentBundle | null) => {
    if (!bundle) {
      return;
    }
    if (bundle.recoveryWorkflow?.status) {
      workflowStatusCounts[bundle.recoveryWorkflow.status] = (workflowStatusCounts[bundle.recoveryWorkflow.status] ?? 0) + 1;
    }
    if (bundle.caseState) {
      caseStateCounts[bundle.caseState] = (caseStateCounts[bundle.caseState] ?? 0) + 1;
    }
    if (bundle.recoveryOperator?.caseState) {
      operatorCaseStateCounts[bundle.recoveryOperator.caseState] =
        (operatorCaseStateCounts[bundle.recoveryOperator.caseState] ?? 0) + 1;
    }
  };

  for (const recovery of recoveries) {
    actionCounts[recovery.nextAction] = (actionCounts[recovery.nextAction] ?? 0) + 1;
  }
  for (const bundle of bundleByGroupId.values()) {
    countBundleStates(bundle);
  }
  for (const group of report.groups) {
    if (group.browserContinuity) {
      browserContinuityCounts[group.browserContinuity.state] =
        (browserContinuityCounts[group.browserContinuity.state] ?? 0) + 1;
    }
    const rootGroupId = resolveReplayRootGroupId(group.groupId, replayParentByGroupId);
    if (rootGroupId !== group.groupId || actionableGroupIds.has(rootGroupId)) {
      continue;
    }
    const bundle = buildReplayConsoleBundle(records, rootGroupId, recoveryRunByGroupId, relayDiagnostics);
    if (bundle?.caseState === "resolved") {
      resolvedRootGroupIds.add(rootGroupId);
      resolvedBundles.push(bundle);
      countBundleStates(bundle);
    }
  }

  resolvedBundles.sort((left, right) => {
    const leftAt = left.browserContinuity?.latestRecordedAt ?? left.group.latestRecordedAt;
    const rightAt = right.browserContinuity?.latestRecordedAt ?? right.group.latestRecordedAt;
    return rightAt - leftAt;
  });

  return {
    totalReplays: report.totalReplays,
    totalGroups: report.totalGroups,
    openIncidents: recoveries.length,
    recoveredGroups: resolvedRootGroupIds.size,
    attentionCount: recoveries.length,
    actionCounts,
    workflowStatusCounts,
    caseStateCounts,
    operatorCaseStateCounts,
    browserContinuityCounts,
    layerCounts: report.layerCounts,
    failureCounts: report.failureCounts,
    latestIncidents: recoveries.slice(0, limit),
    latestBundles: recoveries
      .slice(0, limit)
      .map((recovery) => buildReplayConsoleBundleEntry(bundleByGroupId.get(recovery.groupId) ?? null, recovery)),
    latestResolvedBundles: resolvedBundles.slice(0, limit).map((bundle) => buildReplayConsoleBundleEntry(bundle, null)),
    latestGroups: report.groups.slice(0, limit),
  };
}

function buildReplayConsoleBundle(
  records: ReplayRecord[],
  groupId: string,
  recoveryRunByGroupId: ReadonlyMap<string, RecoveryRun>,
  relayDiagnostics?: RelayDiagnosticsSnapshot
): ReplayIncidentBundle | null {
  const bundle = buildReplayIncidentBundle(records, groupId, relayDiagnostics);
  if (!bundle) {
    return null;
  }
  const recoveryRun = recoveryRunByGroupId.get(groupId);
  if (recoveryRun) {
    attachRecoveryRunToReplayIncidentBundle({
      bundle,
      run: recoveryRun,
      records,
    });
  }
  return bundle;
}

function buildReplayConsoleBundleEntry(
  bundle: ReplayIncidentBundle | null,
  recovery: ReplayRecoveryPlan | null
): ReplayConsoleReport["latestBundles"][number] {
  const workflowNextAction = bundle?.recoveryWorkflow?.nextAction;
  const operatorNextAction = bundle?.recoveryOperator?.nextAction;
  const recoveryNextAction = recovery?.nextAction;
  const nextAction =
    workflowNextAction && workflowNextAction !== "none"
      ? workflowNextAction
      : recoveryNextAction
        ? recoveryNextAction
        : operatorNextAction && operatorNextAction !== "none"
          ? operatorNextAction
          : "none";
  return {
    groupId: bundle?.group.groupId ?? recovery?.groupId ?? "unknown",
    latestStatus: bundle?.group.latestStatus ?? recovery?.latestStatus ?? "failed",
    nextAction,
    autoDispatchReady: recovery?.autoDispatchReady ?? false,
    ...(bundle?.caseState ? { caseState: bundle.caseState } : {}),
    ...(bundle?.recoveryWorkflow?.status ? { workflowStatus: bundle.recoveryWorkflow.status } : {}),
    ...(bundle?.recoveryWorkflow?.summary ? { workflowSummary: bundle.recoveryWorkflow.summary } : {}),
    ...(bundle?.caseHeadline ? { caseHeadline: bundle.caseHeadline } : {}),
    ...(bundle?.browserContinuity?.state ? { browserContinuityState: bundle.browserContinuity.state } : {}),
    ...(bundle?.browserContinuity?.transportLabel ? { browserTransportLabel: bundle.browserContinuity.transportLabel } : {}),
    ...(bundle?.browserContinuity?.browserDiagnosticBucket
      ? { browserDiagnosticBucket: bundle.browserContinuity.browserDiagnosticBucket }
      : {}),
    ...(bundle?.browserContinuity?.relayDiagnosticBucket
      ? { relayDiagnosticBucket: bundle.browserContinuity.relayDiagnosticBucket }
      : {}),
    ...(recovery?.targetLayer ? { targetLayer: recovery.targetLayer } : {}),
    ...(recovery?.targetWorker ? { targetWorker: recovery.targetWorker } : {}),
    ...(bundle?.recoveryOperator?.caseState ? { operatorCaseState: bundle.recoveryOperator.caseState } : {}),
    ...(bundle?.recoveryOperator?.currentGate ? { operatorGate: bundle.recoveryOperator.currentGate } : {}),
    ...(bundle?.recoveryOperator?.allowedActions?.length
      ? { operatorAllowedActions: bundle.recoveryOperator.allowedActions }
      : {}),
  };
}

export function listActionableReplayIncidents(
  records: ReplayRecord[],
  report = buildReplayInspectionReport(records)
): ReplayTaskSummary[] {
  const replayParentByGroupId = buildReplayParentByGroupId(records);
  return report.incidents.filter((group) => {
    const bundle = buildReplayIncidentBundle(records, group.groupId);
    if (bundle?.recoveryWorkflow?.status === "recovered") {
      return false;
    }

    const rootGroupId = resolveReplayRootGroupId(group.groupId, replayParentByGroupId);
    if (rootGroupId !== group.groupId) {
      const rootBundle = buildReplayIncidentBundle(records, rootGroupId);
      if (rootBundle?.recoveryWorkflow?.status === "recovered") {
        return false;
      }
    }

    return true;
  });
}

export function buildRecoveryRuns(
  records: ReplayRecord[],
  existingRuns: RecoveryRun[] = [],
  now = Date.now()
): RecoveryRun[] {
  const report = buildReplayInspectionReport(records);
  const plans = buildReplayRecoveryPlans(records, report);
  const planByGroupId = new Map(plans.map((plan) => [plan.groupId, plan]));
  const groupById = new Map(report.groups.map((group) => [group.groupId, group]));
  const existingBySourceGroupId = new Map(existingRuns.map((run) => [run.sourceGroupId, run]));
  const sourceGroupIds = unique([
    ...plans.map((plan) => plan.groupId),
    ...existingRuns.map((run) => run.sourceGroupId),
  ]);

  return sourceGroupIds
    .map((sourceGroupId) => {
      const existing = existingBySourceGroupId.get(sourceGroupId);
      const group = groupById.get(sourceGroupId);
      const plan = planByGroupId.get(sourceGroupId);

      if (!existing && !plan && (!group || !group.requiresFollowUp)) {
        return null;
      }

      const bundle = group ? buildReplayIncidentBundle(records, sourceGroupId) : null;
      return materializeRecoveryRun({
        sourceGroupId,
        existing: existing ?? null,
        group: group ?? null,
        plan: plan ?? null,
        bundle,
        now,
      });
    })
    .filter((run): run is RecoveryRun => run !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function findRecoveryRun(
  records: ReplayRecord[],
  recoveryRunId: string,
  existingRuns: RecoveryRun[] = [],
  now = Date.now()
): RecoveryRun | null {
  return buildRecoveryRuns(records, existingRuns, now).find((run) => run.recoveryRunId === recoveryRunId) ?? null;
}

export function buildReplayIncidentBundle(
  records: ReplayRecord[],
  groupId: string,
  relayDiagnostics?: RelayDiagnosticsSnapshot
): ReplayIncidentBundle | null {
  const report = buildReplayInspectionReport(records);
  const group = findReplayTaskSummary(records, groupId, report);
  if (!group) {
    return null;
  }

  const relatedReplays = records
    .filter((record) => (record.taskId ?? record.replayId) === group.groupId)
    .sort((left, right) => left.recordedAt - right.recordedAt);

  const recoveryDispatches = records
    .filter((record) => extractRecoveryParentGroupId(record) === groupId && record.layer === "scheduled")
    .sort((left, right) => left.recordedAt - right.recordedAt);

  const followUpGroupIds = unique(
    records
      .filter((record) => extractRecoveryParentGroupId(record) === groupId)
      .map((record) => record.taskId)
      .filter((taskId): taskId is string => Boolean(taskId && taskId !== groupId))
  );
  const followUpGroups = followUpGroupIds
    .map((followUpGroupId) => report.groups.find((candidate) => candidate.groupId === followUpGroupId) ?? null)
    .filter(
      (group): group is ReplayTaskSummary =>
        group !== null && group.layersSeen.some((layer) => layer !== "scheduled")
    );
  const followUpReplays = records
    .filter((record) => {
      const taskGroupId = record.taskId ?? record.replayId;
      return followUpGroupIds.includes(taskGroupId) || extractRecoveryParentGroupId(record) === groupId;
    })
    .sort((left, right) => left.recordedAt - right.recordedAt);
  const followUpTimeline = followUpReplays.map((record) => buildReplayTimelineEntry(record));
  const recoveryWorkflow = buildRecoveryWorkflow({
    group,
    recoveryDispatches,
    followUpGroups,
  });
  const followUpSummary = buildFollowUpSummary(followUpGroups);
  const browserContinuity = mergeLatestBrowserContinuity(
    [group.browserContinuity, ...followUpGroups.map((item) => item.browserContinuity)].filter(
      (item): item is ReplayBrowserContinuitySummary => Boolean(item)
    )
  );
  const enrichedBrowserContinuity = enrichBrowserContinuityDiagnostics(browserContinuity, group, relayDiagnostics);

  const caseState = deriveBundleCaseState(group, recoveryWorkflow, enrichedBrowserContinuity);
  const caseHeadline = buildBundleCaseHeadline(groupId, caseState, recoveryWorkflow, enrichedBrowserContinuity, group);

  return {
    group,
    ...(caseState ? { caseState } : {}),
    ...(caseHeadline ? { caseHeadline } : {}),
    ...(enrichedBrowserContinuity ? { browserContinuity: enrichedBrowserContinuity } : {}),
    ...(group.requiresFollowUp ? { recovery: buildReplayRecoveryPlan(group) } : {}),
    timeline: relatedReplays.map((record) => buildReplayTimelineEntry(record)),
    relatedReplays,
    recoveryDispatches,
    followUpGroups,
    followUpReplays,
    followUpTimeline,
    ...(followUpSummary ? { followUpSummary } : {}),
    ...(recoveryWorkflow ? { recoveryWorkflow } : {}),
  };
}

export function attachRecoveryRunToReplayIncidentBundle(input: {
  bundle: ReplayIncidentBundle;
  run: RecoveryRun;
  records: ReplayRecord[];
  events?: RecoveryRunEvent[];
}): ReplayIncidentBundle {
  const progress = buildRecoveryRunProgress(input.run);
  const latestBrowserOutcome = [...input.run.attempts]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .find((attempt) => attempt.browserOutcome)?.browserOutcome;
  input.bundle.recoveryRun = input.run;
  input.bundle.recoveryProgress = progress;
  input.bundle.recoveryTimeline = buildRecoveryRunTimeline(input.run, input.records, input.events ?? []);
  input.bundle.recoveryOperator = {
    caseState: deriveRecoveryRunOperatorCaseState(input.run),
    currentGate: describeRecoveryRunGate(input.run.status),
    allowedActions: listAllowedRecoveryRunActions(input.run.status).filter((action) => action !== "dispatch"),
    nextAction: input.run.nextAction,
    phase: progress.phase,
    phaseSummary: progress.phaseSummary,
    latestSummary: input.run.latestSummary,
    ...(latestBrowserOutcome ? { latestBrowserOutcome } : {}),
  };
  return input.bundle;
}

function deriveRecoveryRunOperatorCaseState(run: RecoveryRun): NonNullable<ReplayIncidentBundle["caseState"]> {
  switch (run.status) {
    case "waiting_approval":
    case "waiting_external":
      return "waiting_manual";
    case "running":
    case "retrying":
    case "fallback_running":
    case "resumed":
    case "superseded":
      return "recovering";
    case "recovered":
      return "resolved";
    case "failed":
    case "aborted":
      return "blocked";
    case "planned":
    default:
      return "open";
  }
}

function buildBundleCaseHeadline(
  groupId: string,
  caseState: ReplayIncidentBundle["caseState"],
  workflow: ReplayIncidentBundle["recoveryWorkflow"] | undefined,
  browserContinuity: ReplayIncidentBundle["browserContinuity"] | undefined,
  group: ReplayTaskSummary
): string | undefined {
  if (!caseState) {
    return undefined;
  }
  const action = workflow?.nextAction && workflow.nextAction !== "none" ? ` next=${workflow.nextAction}` : "";
  const browser = browserContinuity ? ` browser=${browserContinuity.state}` : "";
  const diagnostic =
    browserContinuity?.transportMode === "relay" && browserContinuity.relayDiagnosticBucket
      ? ` relay=${browserContinuity.relayDiagnosticBucket}`
      : browserContinuity?.browserDiagnosticBucket
        ? ` diag=${browserContinuity.browserDiagnosticBucket}`
        : "";
  const reason =
    workflow?.latestFailure?.category
      ? ` reason=${workflow.latestFailure.category}`
      : group.rootFailureCategory
        ? ` reason=${group.rootFailureCategory}`
        : "";
  return `${groupId} ${caseState}${action}${browser}${diagnostic}${reason}`;
}

export function buildRecoveryRunProgress(run: RecoveryRun): RecoveryRunProgress {
  const activeAttempt = run.attempts.find((attempt) => attempt.attemptId === run.currentAttemptId) ?? null;
  const settledAttempts = run.attempts.filter((attempt) => attempt.completedAt != null);
  const lastSettledAttempt = [...settledAttempts].sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))[0] ?? null;
  const phase = deriveRecoveryRunPhase(run.status);

  return {
    phase,
    phaseSummary: run.waitingReason ?? activeAttempt?.summary ?? run.latestSummary,
    totalAttempts: run.attempts.length,
    settledAttempts: settledAttempts.length,
    supersededAttempts: run.attempts.filter((attempt) => attempt.status === "superseded").length,
    recoveredAttempts: run.attempts.filter((attempt) => attempt.status === "recovered").length,
    failedAttempts: run.attempts.filter((attempt) => attempt.status === "failed").length,
    waitingAttempts: run.attempts.filter((attempt) => attempt.status === "waiting_approval" || attempt.status === "waiting_external").length,
    ...(activeAttempt ? { activeAttemptId: activeAttempt.attemptId, activeAction: activeAttempt.action, activeStatus: activeAttempt.status } : {}),
    ...(lastSettledAttempt ? { lastSettledAttemptId: lastSettledAttempt.attemptId, lastSettledStatus: lastSettledAttempt.status } : {}),
  };
}

function deriveRecoveryRunPhase(runStatus: RecoveryRun["status"]): RecoveryRunProgress["phase"] {
  switch (runStatus) {
    case "waiting_approval":
      return "awaiting_approval";
    case "waiting_external":
      return "awaiting_external";
    case "retrying":
      return "retrying_same_layer";
    case "fallback_running":
      return "running_fallback";
    case "resumed":
      return "resuming_session";
    case "running":
    case "superseded":
      return "running_dispatch";
    case "recovered":
      return "recovered";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
    case "planned":
    default:
      return "planned";
  }
}

export function buildRecoveryRunTimeline(
  run: RecoveryRun,
  records: ReplayRecord[],
  events: RecoveryRunEvent[] = []
): RecoveryRunTimelineEntry[] {
  const bundle = buildReplayIncidentBundle(records, run.sourceGroupId);
  const fallbackReplayEntries = bundle
    ? []
    : records
        .filter((record) => {
          const groupId = record.taskId ?? record.replayId;
          return groupId === run.sourceGroupId || extractRecoveryParentGroupId(record) === run.sourceGroupId;
        })
        .sort((left, right) => left.recordedAt - right.recordedAt)
        .map((record) => buildReplayTimelineEntry(record));
  const replayEntries = [...(bundle?.timeline ?? []), ...(bundle?.followUpTimeline ?? []), ...fallbackReplayEntries].map<
    RecoveryRunTimelineEntry
  >((entry) => ({
    entryId: `replay:${entry.replayId}`,
    source: "replay",
    recordedAt: entry.recordedAt,
    kind: entry.layer,
    summary: entry.summary,
    status: entry.status,
    ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
    replayId: entry.replayId,
    groupId: entry.groupId,
    layer: entry.layer,
    ...(entry.failure ? { failure: entry.failure } : {}),
  }));
  const eventEntries = events.map<RecoveryRunTimelineEntry>((event) => ({
    entryId: event.eventId,
    source: "event",
    recordedAt: event.recordedAt,
    kind: event.kind,
    summary: event.summary,
    status: event.status,
    ...(event.action ? { action: event.action } : {}),
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    ...(event.triggeredByAttemptId ? { triggeredByAttemptId: event.triggeredByAttemptId } : {}),
    ...(event.transitionReason ? { transitionReason: event.transitionReason } : {}),
    ...(event.dispatchReplayId ? { replayId: event.dispatchReplayId } : {}),
    groupId: event.resultingGroupId ?? event.sourceGroupId,
    ...(event.browserOutcome ? { browserOutcome: event.browserOutcome } : {}),
    ...(event.failure ? { failure: event.failure } : {}),
  }));

  return [...eventEntries, ...replayEntries].sort((left, right) => {
    if (left.recordedAt !== right.recordedAt) {
      return left.recordedAt - right.recordedAt;
    }
    return left.entryId.localeCompare(right.entryId);
  });
}

function materializeRecoveryRun(input: {
  sourceGroupId: string;
  existing?: RecoveryRun | null;
  group: ReplayTaskSummary | null;
  plan: ReplayRecoveryPlan | null;
  bundle: ReplayIncidentBundle | null;
  now: number;
}): RecoveryRun | null {
  if (!input.existing && !input.plan && !input.group) {
    return null;
  }

  const runId = input.existing?.recoveryRunId ?? buildRecoveryRunId(input.sourceGroupId);
  const attempts = materializeRecoveryAttempts({
    existingAttempts: input.existing?.attempts ?? [],
    bundle: input.bundle,
    plan: input.plan,
  });
  const latestAttempt = attempts.at(-1);
  const status = deriveRecoveryRunStatus(
    latestAttempt
      ? {
          existing: input.existing ?? null,
          plan: input.plan,
          bundle: input.bundle,
          latestAttempt,
        }
      : {
          existing: input.existing ?? null,
          plan: input.plan,
          bundle: input.bundle,
        }
  );
  const latestFailure =
    latestAttempt?.failure ??
    input.bundle?.recoveryWorkflow?.latestFailure ??
    input.plan?.latestFailure ??
    input.existing?.latestFailure;
  const latestSummary =
    latestAttempt?.summary ??
    input.bundle?.recoveryWorkflow?.summary ??
    input.plan?.recoveryHint.reason ??
    input.group?.latestFailure?.message ??
    input.group?.byLayer[input.group.failedLayer ?? input.group.lastHealthyLayer ?? "role"]?.summary ??
    input.existing?.latestSummary ??
    "Recovery requires follow-up.";
  const latestStatus =
    input.group?.latestStatus ??
    input.existing?.latestStatus ??
    (status === "recovered" ? "completed" : "failed");
  const createdAt = input.existing?.createdAt ?? input.group?.latestRecordedAt ?? input.now;
  const updatedAt = Math.max(
    input.now,
    input.existing?.updatedAt ?? 0,
    input.group?.latestRecordedAt ?? 0,
    latestAttempt?.updatedAt ?? 0
  );
  const recoveryDecision = deriveRecoveryRunDecision({
    status,
    ...(latestAttempt ? { latestAttempt } : {}),
    ...(latestFailure ? { latestFailure } : {}),
    attempts,
    plan: input.plan,
    existing: input.existing ?? null,
  });

  return {
    recoveryRunId: runId,
    threadId: input.group?.threadId ?? input.existing?.threadId ?? input.plan?.threadId ?? "unknown-thread",
    sourceGroupId: input.sourceGroupId,
    ...(input.group?.taskId ? { taskId: input.group.taskId } : input.existing?.taskId ? { taskId: input.existing.taskId } : {}),
    ...(input.group?.flowId ? { flowId: input.group.flowId } : input.existing?.flowId ? { flowId: input.existing.flowId } : {}),
    ...(input.group?.roleId ? { roleId: input.group.roleId } : input.existing?.roleId ? { roleId: input.existing.roleId } : {}),
    ...(input.plan?.targetLayer ? { targetLayer: input.plan.targetLayer } : input.existing?.targetLayer ? { targetLayer: input.existing.targetLayer } : {}),
    ...(input.plan?.targetWorker ? { targetWorker: input.plan.targetWorker } : input.existing?.targetWorker ? { targetWorker: input.existing.targetWorker } : {}),
    latestStatus,
    status,
    nextAction: recoveryDecision.nextAction,
    autoDispatchReady: recoveryDecision.autoDispatchReady,
    requiresManualIntervention: recoveryDecision.requiresManualIntervention,
    latestSummary,
    ...(status === "waiting_approval" || status === "waiting_external"
      ? { waitingReason: input.bundle?.recoveryWorkflow?.summary ?? input.plan?.recoveryHint.reason ?? latestSummary }
      : {}),
    ...(latestFailure ? { latestFailure } : {}),
    ...(latestAttempt ? { currentAttemptId: latestAttempt.attemptId } : {}),
    ...(latestAttempt?.browserSession
      ? { browserSession: latestAttempt.browserSession }
      : input.existing?.browserSession
        ? { browserSession: input.existing.browserSession }
        : {}),
    attempts,
    createdAt,
    updatedAt,
  };
}

function materializeRecoveryAttempts(input: {
  existingAttempts: RecoveryRunAttempt[];
  bundle: ReplayIncidentBundle | null;
  plan: ReplayRecoveryPlan | null;
}): RecoveryRunAttempt[] {
  return input.existingAttempts.map((attempt) => {
    if (attempt.status === "superseded" || attempt.supersededByAttemptId) {
      return {
        ...attempt,
        status: "superseded",
        completedAt: attempt.completedAt ?? attempt.supersededAt ?? attempt.updatedAt,
      };
    }

    const followUpGroup = input.bundle?.followUpGroups.find(
      (group) => group.groupId === attempt.dispatchedTaskId || group.groupId === attempt.resultingGroupId
    );
    const dispatchReplay = input.bundle?.recoveryDispatches.find(
      (record) => record.replayId === attempt.dispatchReplayId || record.taskId === attempt.dispatchedTaskId
    );

    if (attempt.action === "reject") {
      return {
        ...attempt,
        status: "aborted",
        completedAt: attempt.completedAt ?? attempt.updatedAt,
      };
    }

    if (followUpGroup) {
      const browserOutcome = deriveBrowserRecoveryOutcome(input.bundle, attempt);
      const browserOutcomePatch = browserOutcome
        ? {
            browserOutcome: browserOutcome.outcome,
            browserOutcomeSummary: browserOutcome.summary,
          }
        : {};
      if (!followUpGroup.requiresFollowUp && followUpGroup.latestStatus === "completed") {
        return {
          ...attempt,
          status: "recovered",
          summary: "Recovery follow-up completed successfully.",
          resultingGroupId: followUpGroup.groupId,
          updatedAt: followUpGroup.latestRecordedAt,
          completedAt: followUpGroup.latestRecordedAt,
          ...browserOutcomePatch,
        };
      }

      if (followUpGroup.latestFailure) {
        const waitingForManual =
          followUpGroup.recoveryHint.action === "request_approval" || followUpGroup.recoveryHint.action === "inspect";
        return {
          ...attempt,
          status: followUpGroup.recoveryHint.action === "request_approval" ? "waiting_approval" : followUpGroup.recoveryHint.action === "inspect" ? "waiting_external" : "failed",
          summary: followUpGroup.latestFailure.message,
          resultingGroupId: followUpGroup.groupId,
          failure: followUpGroup.latestFailure,
          updatedAt: followUpGroup.latestRecordedAt,
          completedAt: attempt.completedAt ?? followUpGroup.latestRecordedAt,
          ...browserOutcomePatch,
          ...(waitingForManual ? {} : { nextAction: "stop" }),
        };
      }

      return {
        ...attempt,
        status: statusForAttemptAction(attempt.action),
        summary: "Recovery follow-up is still running.",
        resultingGroupId: followUpGroup.groupId,
        updatedAt: followUpGroup.latestRecordedAt,
        ...browserOutcomePatch,
      };
    }

    if (dispatchReplay) {
      return {
        ...attempt,
        status: statusForAttemptAction(attempt.action),
        summary: "Recovery dispatch was accepted and is waiting for follow-up execution.",
        updatedAt: dispatchReplay.recordedAt,
      };
    }

    if (
      input.plan &&
      attempt.completedAt == null &&
      !attempt.failure &&
      (attempt.action === "approve" || attempt.action === "resume" || attempt.action === "retry" || attempt.action === "fallback")
    ) {
      return {
        ...attempt,
        status: statusForAttemptAction(attempt.action),
      };
    }

    return attempt;
  });
}

function deriveRecoveryRunStatus(input: {
  existing: RecoveryRun | null;
  plan: ReplayRecoveryPlan | null;
  bundle: ReplayIncidentBundle | null;
  latestAttempt?: RecoveryRunAttempt;
}): RecoveryRun["status"] {
  if (input.latestAttempt?.status === "aborted") {
    return "aborted";
  }
  if (input.latestAttempt?.status === "superseded") {
    return input.plan?.requiresManualIntervention
      ? input.plan.nextAction === "request_approval"
        ? "waiting_approval"
        : "waiting_external"
      : input.existing?.status ?? "planned";
  }

  const workflowStatus = input.bundle?.recoveryWorkflow?.status;
  if (workflowStatus === "recovered") {
    return "recovered";
  }
  if (workflowStatus === "recovery_failed") {
    return "failed";
  }
  if (workflowStatus === "manual_follow_up") {
    return input.plan?.nextAction === "request_approval" ? "waiting_approval" : "waiting_external";
  }
  if (workflowStatus === "running") {
    return input.latestAttempt?.status ?? "running";
  }

  if (input.latestAttempt) {
    return input.latestAttempt.status;
  }

  if (input.plan?.nextAction === "request_approval") {
    return "waiting_approval";
  }
  if (input.plan?.requiresManualIntervention) {
    return "waiting_external";
  }
  if (!input.plan && input.existing?.status) {
    return input.existing.status;
  }
  return "planned";
}

function deriveRecoveryRunDecision(input: {
  status: RecoveryRun["status"];
  latestAttempt?: RecoveryRunAttempt;
  latestFailure?: RecoveryRun["latestFailure"];
  attempts: RecoveryRunAttempt[];
  plan: ReplayRecoveryPlan | null;
  existing: RecoveryRun | null;
}): Pick<RecoveryRun, "nextAction" | "autoDispatchReady" | "requiresManualIntervention"> {
  const baseAutoDispatchReady = input.plan?.autoDispatchReady ?? input.existing?.autoDispatchReady ?? false;
  const nextAction = deriveRecoveryRunNextAction(input, baseAutoDispatchReady);
  const requiresManualIntervention =
    input.status === "waiting_approval" ||
    input.status === "waiting_external" ||
    nextAction === "request_approval" ||
    nextAction === "inspect_then_resume";
  const autoDispatchReady =
    !requiresManualIntervention &&
    nextAction !== "stop" &&
    (input.status === "planned" ||
      input.status === "running" ||
      input.status === "retrying" ||
      input.status === "fallback_running" ||
      input.status === "resumed" ||
      input.status === "failed") &&
    baseAutoDispatchReady;

  return {
    nextAction,
    autoDispatchReady,
    requiresManualIntervention,
  };
}

function deriveRecoveryRunNextAction(
  input: {
    status: RecoveryRun["status"];
    latestAttempt?: RecoveryRunAttempt;
    latestFailure?: RecoveryRun["latestFailure"];
    attempts: RecoveryRunAttempt[];
    plan: ReplayRecoveryPlan | null;
    existing: RecoveryRun | null;
  },
  canAutoResume: boolean
): RecoveryRun["nextAction"] {
  if (input.status === "recovered" || input.status === "aborted") {
    return "stop";
  }
  if (input.status === "superseded") {
    return input.plan?.nextAction ?? input.existing?.nextAction ?? "inspect_then_resume";
  }
  if (input.status === "waiting_approval") {
    return "request_approval";
  }
  if (input.status === "waiting_external") {
    return "inspect_then_resume";
  }
  if (input.status === "retrying") {
    return "retry_same_layer";
  }
  if (input.status === "fallback_running") {
    return "fallback_transport";
  }
  if (input.status === "resumed") {
    return "auto_resume";
  }
  const failedRetryAttempts = countFailedAttempts(input.attempts, "retry");
  const failedFallbackAttempts = countFailedAttempts(input.attempts, "fallback");
  if (input.status === "failed" && input.latestFailure) {
    if (
      input.latestAttempt?.action === "retry" &&
      failedRetryAttempts >= MAX_RETRY_ATTEMPTS_BEFORE_ESCALATION
    ) {
      return "fallback_transport";
    }
    if (
      input.latestAttempt?.action === "fallback" &&
      failedFallbackAttempts >= MAX_FALLBACK_ATTEMPTS_BEFORE_INSPECTION
    ) {
      return "inspect_then_resume";
    }
    return mapNextAction(input.latestFailure.recommendedAction, canAutoResume);
  }
  return input.plan?.nextAction ?? input.existing?.nextAction ?? "inspect_then_resume";
}

function countFailedAttempts(attempts: RecoveryRunAttempt[], action: RecoveryRunAttempt["action"]): number {
  return attempts.filter((attempt) => attempt.action === action && attempt.status === "failed").length;
}

function statusForAttemptAction(action: RecoveryRunAttempt["action"]): RecoveryRun["status"] {
  switch (action) {
    case "retry":
      return "retrying";
    case "fallback":
      return "fallback_running";
    case "resume":
    case "approve":
      return "resumed";
    case "reject":
      return "aborted";
    case "dispatch":
    default:
      return "running";
  }
}

function buildRecoveryHint(input: {
  latestStatus: ReplayTaskSummary["latestStatus"];
  latestFailure?: ReplayTaskSummary["latestFailure"];
  lastHealthyLayer?: ReplayTaskSummary["lastHealthyLayer"];
  failedLayer?: ReplayTaskSummary["failedLayer"];
  requiresFollowUp: boolean;
}): ReplayRecoveryHint {
  const preferredLayer = input.failedLayer ?? input.lastHealthyLayer;

  if (!input.requiresFollowUp) {
    return {
      action: "none",
      reason: "Execution completed without follow-up.",
      ...(input.lastHealthyLayer ? { lastHealthyLayer: input.lastHealthyLayer } : {}),
    };
  }

  if (input.latestFailure) {
    return {
      action: input.latestFailure.recommendedAction,
      reason: input.latestFailure.message,
      ...(input.failedLayer ? { failedLayer: input.failedLayer } : {}),
      ...(input.lastHealthyLayer ? { lastHealthyLayer: input.lastHealthyLayer } : {}),
      ...(preferredLayer ? { preferredLayer } : {}),
    };
  }

  if (input.latestStatus === "partial") {
    return {
      action: "resume",
      reason: "Execution ended with partial output and should continue from the latest live context.",
      ...(input.failedLayer ? { failedLayer: input.failedLayer } : {}),
      ...(input.lastHealthyLayer ? { lastHealthyLayer: input.lastHealthyLayer } : {}),
      ...(preferredLayer ? { preferredLayer } : {}),
    };
  }

  return {
    action: "inspect",
    reason: "Execution needs manual inspection before it can continue safely.",
    ...(input.failedLayer ? { failedLayer: input.failedLayer } : {}),
    ...(input.lastHealthyLayer ? { lastHealthyLayer: input.lastHealthyLayer } : {}),
    ...(preferredLayer ? { preferredLayer } : {}),
  };
}

function buildReplayRecoveryPlan(group: ReplayTaskSummary): ReplayRecoveryPlan {
  const hint = group.recoveryHint;
  const targetLayer = hint.preferredLayer ?? group.failedLayer ?? group.lastHealthyLayer;
  const targetWorker = group.byLayer.worker?.failure || group.byLayer.worker
    ? inferTargetWorker(group)
    : undefined;
  const canAutoResume =
    (hint.action === "resume" || hint.action === "retry" || hint.action === "fallback") &&
    Boolean(targetLayer);
  const autoDispatchReady =
    canAutoResume &&
    Boolean(group.roleId) &&
    (targetLayer !== "worker" || Boolean(targetWorker));

  return {
    groupId: group.groupId,
    threadId: group.threadId,
    ...(group.taskId ? { taskId: group.taskId } : {}),
    ...(group.flowId ? { flowId: group.flowId } : {}),
    ...(group.roleId ? { roleId: group.roleId } : {}),
    latestStatus: group.latestStatus,
    recoveryHint: hint,
    ...(group.latestFailure ? { latestFailure: group.latestFailure } : {}),
    layersSeen: group.layersSeen,
    canAutoResume,
    requiresManualIntervention:
      hint.action === "request_approval" ||
      hint.action === "inspect" ||
      hint.action === "abort" ||
      !canAutoResume,
    autoDispatchReady,
    ...(targetWorker ? { targetWorker } : {}),
    nextAction: mapNextAction(hint.action, canAutoResume),
    ...(targetLayer ? { targetLayer } : {}),
  };
}

function mapNextAction(
  action: ReplayRecoveryHint["action"],
  canAutoResume: boolean
): ReplayRecoveryPlan["nextAction"] {
  switch (action) {
    case "resume":
      return canAutoResume ? "auto_resume" : "inspect_then_resume";
    case "retry":
      return canAutoResume ? "retry_same_layer" : "inspect_then_resume";
    case "fallback":
      return canAutoResume ? "fallback_transport" : "inspect_then_resume";
    case "request_approval":
      return "request_approval";
    case "abort":
      return "stop";
    case "inspect":
      return "inspect_then_resume";
    case "none":
    default:
      return "stop";
  }
}

function buildRecoveryWorkflow(input: {
  group: ReplayTaskSummary;
  recoveryDispatches: ReplayRecord[];
  followUpGroups: ReplayTaskSummary[];
}): ReplayIncidentBundle["recoveryWorkflow"] | undefined {
  if (input.recoveryDispatches.length === 0) {
    if (!input.group.requiresFollowUp) {
      return {
        status: "recovered",
        nextAction: "none",
        summary: "No recovery workflow is needed.",
      };
    }
    return {
      status: "not_started",
      nextAction: input.group.recoveryHint.action === "none" ? "none" : mapNextAction(input.group.recoveryHint.action, false),
      summary: "Recovery has not been dispatched yet.",
    };
  }

  const latestDispatch = input.recoveryDispatches.at(-1)!;
  const latestFollowUp = input.followUpGroups.sort((left, right) => right.latestRecordedAt - left.latestRecordedAt)[0];

  if (!latestFollowUp) {
    return {
      status: "running",
      nextAction: "inspect_then_resume",
      summary: "Recovery dispatch was created and follow-up execution has not been observed yet.",
      latestDispatchReplayId: latestDispatch.replayId,
    };
  }

  if (!latestFollowUp.requiresFollowUp && latestFollowUp.latestStatus === "completed") {
    return {
      status: "recovered",
      nextAction: "none",
      summary: "Recovery dispatch completed successfully.",
      latestDispatchReplayId: latestDispatch.replayId,
      latestFollowUpGroupId: latestFollowUp.groupId,
    };
  }

  if (latestFollowUp.latestFailure) {
    return {
      status: latestFollowUp.recoveryHint.action === "inspect" || latestFollowUp.recoveryHint.action === "request_approval"
        ? "manual_follow_up"
        : "recovery_failed",
      nextAction: mapNextAction(latestFollowUp.recoveryHint.action, false),
      summary: latestFollowUp.latestFailure.message,
      latestDispatchReplayId: latestDispatch.replayId,
      latestFollowUpGroupId: latestFollowUp.groupId,
      latestFailure: latestFollowUp.latestFailure,
    };
  }

  return {
    status: "running",
    nextAction: mapNextAction(latestFollowUp.recoveryHint.action, false),
    summary: "Recovery is in progress and still requires follow-up.",
    latestDispatchReplayId: latestDispatch.replayId,
    latestFollowUpGroupId: latestFollowUp.groupId,
  };
}

function deriveBundleCaseState(
  group: ReplayTaskSummary,
  workflow: ReplayIncidentBundle["recoveryWorkflow"] | undefined,
  browserContinuity: ReplayBrowserContinuitySummary | undefined
): ReplayIncidentBundle["caseState"] {
  switch (workflow?.status) {
    case "recovered":
      return "resolved";
    case "running":
      return "recovering";
    case "manual_follow_up":
      return workflow.nextAction === "request_approval" ? "waiting_manual" : "blocked";
    case "recovery_failed":
      return "blocked";
    case "not_started":
      return "open";
    default:
      if (!group.requiresFollowUp && browserContinuity?.state === "recovered") {
        return "resolved";
      }
      return group.requiresFollowUp ? "open" : "resolved";
  }
}

function mergeLatestBrowserContinuity(
  items: ReplayBrowserContinuitySummary[]
): ReplayBrowserContinuitySummary | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const ordered = [...items].sort((left, right) => right.latestRecordedAt - left.latestRecordedAt);
  const latest = ordered[0]!;
  return ordered.slice(1).reduce(
    (current, candidate) => mergeBrowserContinuity(candidate, current),
    latest
  );
}

function mergeBrowserContinuity(
  fallback: ReplayBrowserContinuitySummary | undefined,
  current: ReplayBrowserContinuitySummary
): ReplayBrowserContinuitySummary {
  return {
    ...current,
    ...(current.sessionId ? {} : fallback?.sessionId ? { sessionId: fallback.sessionId } : {}),
    ...(current.targetId ? {} : fallback?.targetId ? { targetId: fallback.targetId } : {}),
    ...(current.transportMode ? {} : fallback?.transportMode ? { transportMode: fallback.transportMode } : {}),
    ...(current.transportLabel ? {} : fallback?.transportLabel ? { transportLabel: fallback.transportLabel } : {}),
    ...(current.transportPeerId ? {} : fallback?.transportPeerId ? { transportPeerId: fallback.transportPeerId } : {}),
    ...(current.transportTargetId ? {} : fallback?.transportTargetId ? { transportTargetId: fallback.transportTargetId } : {}),
    ...(current.browserDiagnosticBucket
      ? {}
      : fallback?.browserDiagnosticBucket
        ? { browserDiagnosticBucket: fallback.browserDiagnosticBucket }
        : {}),
    ...(current.browserDiagnosticSummary
      ? {}
      : fallback?.browserDiagnosticSummary
        ? { browserDiagnosticSummary: fallback.browserDiagnosticSummary }
        : {}),
    ...(current.resumeMode ? {} : fallback?.resumeMode ? { resumeMode: fallback.resumeMode } : {}),
    ...(current.targetResolution ? {} : fallback?.targetResolution ? { targetResolution: fallback.targetResolution } : {}),
    ...(current.outcome ? {} : fallback?.outcome ? { outcome: fallback.outcome } : {}),
    ...(current.relayPeerStatus ? {} : fallback?.relayPeerStatus ? { relayPeerStatus: fallback.relayPeerStatus } : {}),
    ...(current.relayTargetStatus ? {} : fallback?.relayTargetStatus ? { relayTargetStatus: fallback.relayTargetStatus } : {}),
    ...(current.relayDiagnosticBucket
      ? {}
      : fallback?.relayDiagnosticBucket
        ? { relayDiagnosticBucket: fallback.relayDiagnosticBucket }
        : {}),
    ...(current.relayDiagnosticSummary
      ? {}
      : fallback?.relayDiagnosticSummary
        ? { relayDiagnosticSummary: fallback.relayDiagnosticSummary }
        : {}),
  };
}

function enrichBrowserContinuityDiagnostics(
  continuity: ReplayBrowserContinuitySummary | undefined,
  group: ReplayTaskSummary,
  relayDiagnostics?: RelayDiagnosticsSnapshot
): ReplayBrowserContinuitySummary | undefined {
  if (!continuity) {
    return continuity;
  }

  if (isRelayContinuity(continuity) && relayDiagnostics) {
    const target =
      continuity.transportTargetId != null
        ? relayDiagnostics.targets.find((item) => item.relayTargetId === continuity.transportTargetId) ?? null
        : null;
    const peerId = continuity.transportPeerId ?? target?.peerId;
    const peer = peerId != null ? relayDiagnostics.peers.find((item) => item.peerId === peerId) ?? null : null;
    const relayPeerStatus: ReplayBrowserContinuitySummary["relayPeerStatus"] =
      peerId == null ? undefined : peer?.status ?? "missing";
    const relayTargetStatus: ReplayBrowserContinuitySummary["relayTargetStatus"] =
      continuity.transportTargetId == null ? undefined : target?.status ?? "missing";
    const relayDiagnostic = deriveRelayDiagnostic(group, continuity, relayPeerStatus, relayTargetStatus);

    return {
      ...continuity,
      ...(peerId ? { transportPeerId: peerId } : {}),
      ...(relayPeerStatus ? { relayPeerStatus } : {}),
      ...(relayTargetStatus ? { relayTargetStatus } : {}),
      ...(relayDiagnostic?.bucket ? { browserDiagnosticBucket: relayDiagnostic.bucket } : {}),
      ...(relayDiagnostic?.summary ? { browserDiagnosticSummary: relayDiagnostic.summary } : {}),
      ...(relayDiagnostic?.bucket ? { relayDiagnosticBucket: relayDiagnostic.bucket } : {}),
      ...(relayDiagnostic?.summary ? { relayDiagnosticSummary: relayDiagnostic.summary } : {}),
    };
  }

  const transportDiagnostic = deriveTransportDiagnostic(group, continuity);

  return {
    ...continuity,
    ...(transportDiagnostic?.bucket ? { browserDiagnosticBucket: transportDiagnostic.bucket } : {}),
    ...(transportDiagnostic?.summary ? { browserDiagnosticSummary: transportDiagnostic.summary } : {}),
  };
}

function isRelayContinuity(continuity: ReplayBrowserContinuitySummary): boolean {
  return (
    continuity.transportMode === "relay" ||
    continuity.transportLabel === "chrome-relay" ||
    continuity.transportPeerId != null ||
    continuity.transportTargetId != null
  );
}

function deriveRelayDiagnostic(
  group: ReplayTaskSummary,
  continuity: ReplayBrowserContinuitySummary,
  relayPeerStatus: ReplayBrowserContinuitySummary["relayPeerStatus"],
  relayTargetStatus: ReplayBrowserContinuitySummary["relayTargetStatus"]
):
  | {
      bucket: NonNullable<ReplayBrowserContinuitySummary["relayDiagnosticBucket"]>;
      summary: string;
    }
  | undefined {
  if (relayPeerStatus === "missing") {
    return {
      bucket: "peer_missing",
      summary: continuity.transportPeerId
        ? `Relay peer ${continuity.transportPeerId} is no longer registered.`
        : "Relay peer is no longer registered.",
    };
  }
  if (relayPeerStatus === "stale") {
    return {
      bucket: "peer_stale",
      summary: continuity.transportPeerId
        ? `Relay peer ${continuity.transportPeerId} is stale and may need to reconnect.`
        : "Relay peer is stale and may need to reconnect.",
    };
  }
  if (relayTargetStatus === "missing") {
    return {
      bucket: "target_missing",
      summary: continuity.transportTargetId
        ? `Relay target ${continuity.transportTargetId} is no longer reported by the active peer.`
        : "Relay target is no longer reported by the active peer.",
    };
  }
  if (relayTargetStatus === "detached") {
    return {
      bucket: "target_detached",
      summary: continuity.transportTargetId
        ? `Relay target ${continuity.transportTargetId} is detached and needs recovery.`
        : "Relay target is detached and needs recovery.",
    };
  }
  if (relayTargetStatus === "closed") {
    return {
      bucket: "target_closed",
      summary: continuity.transportTargetId
        ? `Relay target ${continuity.transportTargetId} is closed and cannot be reused.`
        : "Relay target is closed and cannot be reused.",
    };
  }

  const failureMessage = group.latestFailure?.message ?? continuity.summary;
  if (/receiving end does not exist|content script unavailable|message port closed|frame with id .* was removed|cannot access contents of url/i.test(failureMessage)) {
    return {
      bucket: "content_script_unavailable",
      summary: "Relay content script is unavailable for the current tab and needs reinjection or reload.",
    };
  }
  if (/timed out|timeout/i.test(failureMessage)) {
    return {
      bucket: "action_timeout",
      summary: "Relay action execution timed out before the peer returned a result.",
    };
  }
  if (group.latestFailure?.category === "transport_failed") {
    return {
      bucket: "action_failed",
      summary: group.latestFailure.message,
    };
  }

  return undefined;
}

function deriveTransportDiagnostic(
  group: ReplayTaskSummary,
  continuity: ReplayBrowserContinuitySummary
):
  | {
      bucket: NonNullable<ReplayBrowserContinuitySummary["browserDiagnosticBucket"]>;
      summary: string;
    }
  | undefined {
  if (continuity.transportMode !== "direct-cdp" && continuity.transportLabel !== "direct-cdp") {
    return undefined;
  }

  const failureMessage = [continuity.summary, group.latestFailure?.message]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");

  if (/needs confirmation before resume|manual confirmation.*resume|inspect.*resume|target needs.*resume/i.test(failureMessage)) {
    return {
      bucket: "reconnect_required",
      summary: continuity.transportTargetId
        ? `Direct CDP target ${continuity.transportTargetId} needs confirmation before resume.`
        : "Direct CDP target needs confirmation before resume.",
    };
  }
  if (/timed out|timeout/i.test(failureMessage)) {
    return {
      bucket: "action_timeout",
      summary: "Direct CDP action timed out and may need reconnect or manual confirmation.",
    };
  }
  if (/disconnected|session dropped|connect over cdp|endpoint .*unreachable|failed to connect|browser disconnected/i.test(failureMessage)) {
    return {
      bucket: "endpoint_unreachable",
      summary: "Direct CDP endpoint is unavailable or the browser disconnected.",
    };
  }
  if (continuity.state === "attention" && continuity.targetResolution === "reconnect") {
    return {
      bucket: "reconnect_required",
      summary: "Direct CDP recovery requires reconnect confirmation before resume.",
    };
  }
  return undefined;
}

function buildFollowUpSummary(
  followUpGroups: ReplayTaskSummary[]
): ReplayIncidentBundle["followUpSummary"] | undefined {
  if (followUpGroups.length === 0) {
    return undefined;
  }

  const browserContinuityCounts: NonNullable<ReplayIncidentBundle["followUpSummary"]>["browserContinuityCounts"] = {};
  const actionCounts: NonNullable<ReplayIncidentBundle["followUpSummary"]>["actionCounts"] = {};

  for (const group of followUpGroups) {
    actionCounts[group.recoveryHint.action] = (actionCounts[group.recoveryHint.action] ?? 0) + 1;
    if (group.browserContinuity) {
      browserContinuityCounts[group.browserContinuity.state] =
        (browserContinuityCounts[group.browserContinuity.state] ?? 0) + 1;
    }
  }

  return {
    totalGroups: followUpGroups.length,
    openGroups: followUpGroups.filter((group) => group.requiresFollowUp).length,
    closedGroups: followUpGroups.filter((group) => !group.requiresFollowUp).length,
    browserContinuityCounts,
    actionCounts,
  };
}

function inferTargetWorker(group: ReplayTaskSummary): ReplayRecoveryPlan["targetWorker"] {
  const explicitWorkerType = group.byLayer.worker?.workerType;
  if (explicitWorkerType) {
    return explicitWorkerType;
  }

  const workerReplayId = group.byLayer.worker?.replayId;
  if (!workerReplayId) {
    return undefined;
  }

  // Fallback for older replay ids that encode the worker kind as `:worker:<type>:task:`.
  const match = workerReplayId.match(/:worker:([^:]+):task:/);
  if (!match?.[1]) {
    return undefined;
  }

  if (match[1] === "browser" || match[1] === "explore" || match[1] === "finance" || match[1] === "coder" || match[1] === "harness") {
    return match[1];
  }

  return undefined;
}

function buildReplayTimelineEntry(record: ReplayRecord): ReplayTimelineEntry {
  const recoveryContext = extractRecoveryContext(record);
  return {
    replayId: record.replayId,
    groupId: record.taskId ?? record.replayId,
    threadId: record.threadId,
    layer: record.layer,
    status: record.status,
    recordedAt: record.recordedAt,
    summary: record.summary,
    ...(recoveryContext?.attemptId ? { attemptId: recoveryContext.attemptId } : {}),
    ...(record.flowId ? { flowId: record.flowId } : {}),
    ...(record.roleId ? { roleId: record.roleId } : {}),
    ...(record.workerType ? { workerType: record.workerType } : {}),
    ...(record.failure ? { failure: record.failure } : {}),
  };
}

function extractReplayBrowserContinuity(record: ReplayRecord): ReplayBrowserContinuitySummary | null {
  const failure = record.failure;
  const payload = extractBrowserPayload(record);
  const outcome = extractBrowserRecoveryOutcomeFromReplay(record);

  if (!payload && !outcome && !failure) {
    return null;
  }

  if (failure && (failure.category === "invalid_resume" || failure.category === "stale_session")) {
    return {
      latestRecordedAt: record.recordedAt,
      state: "attention",
      summary: failure.message,
      ...(payload?.sessionId ? { sessionId: payload.sessionId } : {}),
      ...(payload?.targetId ? { targetId: payload.targetId } : {}),
      ...(payload?.transportMode ? { transportMode: payload.transportMode } : {}),
      ...(payload?.transportLabel ? { transportLabel: payload.transportLabel } : {}),
      ...(payload?.transportPeerId ? { transportPeerId: payload.transportPeerId } : {}),
      ...(payload?.transportTargetId ? { transportTargetId: payload.transportTargetId } : {}),
      ...(payload?.resumeMode ? { resumeMode: payload.resumeMode } : {}),
      ...(payload?.targetResolution ? { targetResolution: payload.targetResolution } : {}),
    };
  }

  if (outcome) {
    return {
      latestRecordedAt: record.recordedAt,
      state: outcome.outcome === "hot_reuse" ? "stable" : "recovered",
      summary: outcome.summary,
      ...(payload?.sessionId ? { sessionId: payload.sessionId } : {}),
      ...(payload?.targetId ? { targetId: payload.targetId } : {}),
      ...(payload?.transportMode ? { transportMode: payload.transportMode } : {}),
      ...(payload?.transportLabel ? { transportLabel: payload.transportLabel } : {}),
      ...(payload?.transportPeerId ? { transportPeerId: payload.transportPeerId } : {}),
      ...(payload?.transportTargetId ? { transportTargetId: payload.transportTargetId } : {}),
      ...(payload?.resumeMode ? { resumeMode: payload.resumeMode } : {}),
      ...(payload?.targetResolution ? { targetResolution: payload.targetResolution } : {}),
      outcome: outcome.outcome,
    };
  }

  if (!payload) {
    return null;
  }

  return {
    latestRecordedAt: record.recordedAt,
    state: "stable",
    summary: "Browser continuity metadata observed on the latest execution.",
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.targetId ? { targetId: payload.targetId } : {}),
    ...(payload.transportMode ? { transportMode: payload.transportMode } : {}),
    ...(payload.transportLabel ? { transportLabel: payload.transportLabel } : {}),
    ...(payload.transportPeerId ? { transportPeerId: payload.transportPeerId } : {}),
    ...(payload.transportTargetId ? { transportTargetId: payload.transportTargetId } : {}),
    ...(payload.resumeMode ? { resumeMode: payload.resumeMode } : {}),
    ...(payload.targetResolution ? { targetResolution: payload.targetResolution } : {}),
  };
}

function extractRecoveryParentGroupId(record: ReplayRecord): string | undefined {
  const recoveryContext = extractRecoveryContext(record);
  return recoveryContext?.parentGroupId;
}

function buildReplayParentByGroupId(records: ReplayRecord[]): Map<string, string> {
  const parentByGroupId = new Map<string, string>();
  for (const record of records) {
    const groupId = record.taskId ?? record.replayId;
    const parentGroupId = extractRecoveryParentGroupId(record);
    if (!groupId || !parentGroupId || parentByGroupId.has(groupId)) {
      continue;
    }
    parentByGroupId.set(groupId, parentGroupId);
  }
  return parentByGroupId;
}

function resolveReplayRootGroupId(groupId: string, parentByGroupId: Map<string, string>): string {
  let current = groupId;
  const visited = new Set<string>();
  while (parentByGroupId.has(current) && !visited.has(current)) {
    visited.add(current);
    current = parentByGroupId.get(current)!;
  }
  return current;
}

function extractRecoveryContext(
  record: ReplayRecord
): { parentGroupId?: string; attemptId?: string } | undefined {
  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>)
      : null;
  const recoveryContext =
    metadata?.recoveryContext && typeof metadata.recoveryContext === "object"
      ? (metadata.recoveryContext as Record<string, unknown>)
      : null;

  if (!recoveryContext) {
    return undefined;
  }

  const parentGroupId = typeof recoveryContext?.parentGroupId === "string" ? recoveryContext.parentGroupId : undefined;
  const attemptId = typeof recoveryContext?.attemptId === "string" ? recoveryContext.attemptId : undefined;
  if (!parentGroupId && !attemptId) {
    return undefined;
  }

  return {
    ...(parentGroupId ? { parentGroupId } : {}),
    ...(attemptId ? { attemptId } : {}),
  };
}

function deriveBrowserRecoveryOutcome(
  bundle: ReplayIncidentBundle | null,
  attempt: RecoveryRunAttempt
): { outcome: RecoveryBrowserOutcome; summary: string } | null {
  const candidateGroupIds = [attempt.resultingGroupId, attempt.dispatchedTaskId].filter(
    (value): value is string => Boolean(value)
  );
  if (candidateGroupIds.length === 0) {
    return null;
  }

  const followUpReplays = bundle?.followUpReplays ?? [];
  const candidateRecords = followUpReplays
    .filter((record) => {
      const groupId = record.taskId ?? record.replayId;
      return candidateGroupIds.includes(groupId);
    })
    .sort((left, right) => right.recordedAt - left.recordedAt);

  for (const record of candidateRecords) {
    const outcome = extractBrowserRecoveryOutcomeFromReplay(record);
    if (outcome) {
      return outcome;
    }
  }

  return null;
}

function extractBrowserRecoveryOutcomeFromReplay(
  record: ReplayRecord
): { outcome: RecoveryBrowserOutcome; summary: string } | null {
  const failure = record.failure;
  if (failure && (failure.category === "invalid_resume" || failure.category === "stale_session")) {
    return {
      outcome: "resume_failed",
      summary: failure.message,
    };
  }

  const browserPayload = extractBrowserPayload(record);
  if (!browserPayload) {
    return null;
  }

  const resumeMode = browserPayload.resumeMode;
  const targetResolution = browserPayload.targetResolution;

  if (resumeMode === "hot" && targetResolution === "attach") {
    return {
      outcome: "hot_reuse",
      summary: "Reused the existing live browser target.",
    };
  }
  if (targetResolution === "reconnect") {
    return {
      outcome: "detached_target_recovered",
      summary: "Recovered a detached browser target via reconnect.",
    };
  }
  if (resumeMode === "warm") {
    return {
      outcome: "warm_attach",
      summary: "Resumed the browser session from stored session state.",
    };
  }
  if (targetResolution === "reopen" || targetResolution === "new_target" || resumeMode === "cold") {
    return {
      outcome: "cold_reopen",
      summary: "Reopened the browser target from persisted state.",
    };
  }

  return null;
}

function extractBrowserPayload(
  record: ReplayRecord
):
  | {
      sessionId?: string;
      targetId?: string;
      transportMode?: ReplayBrowserContinuitySummary["transportMode"];
      transportLabel?: string;
      transportPeerId?: string;
      transportTargetId?: string;
      resumeMode?: ReplayBrowserContinuitySummary["resumeMode"];
      targetResolution?: ReplayBrowserContinuitySummary["targetResolution"];
    }
  | null {
  const metadata = record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : null;
  if (!metadata) {
    return null;
  }

  const browserPayload =
    record.layer === "browser"
      ? (metadata.result && typeof metadata.result === "object" ? (metadata.result as Record<string, unknown>) : null)
      : record.layer === "worker"
        ? (metadata.payload && typeof metadata.payload === "object" ? (metadata.payload as Record<string, unknown>) : null)
        : null;
  if (!browserPayload) {
    return null;
  }

  return {
    ...(typeof browserPayload.sessionId === "string" ? { sessionId: browserPayload.sessionId } : {}),
    ...(typeof browserPayload.targetId === "string" ? { targetId: browserPayload.targetId } : {}),
    ...(isBrowserTransportMode(browserPayload.transportMode) ? { transportMode: browserPayload.transportMode } : {}),
    ...(typeof browserPayload.transportLabel === "string" ? { transportLabel: browserPayload.transportLabel } : {}),
    ...(typeof browserPayload.transportPeerId === "string" ? { transportPeerId: browserPayload.transportPeerId } : {}),
    ...(typeof browserPayload.transportTargetId === "string"
      ? { transportTargetId: browserPayload.transportTargetId }
      : {}),
    ...(isBrowserResumeMode(browserPayload.resumeMode) ? { resumeMode: browserPayload.resumeMode } : {}),
    ...(isBrowserTargetResolution(browserPayload.targetResolution)
      ? { targetResolution: browserPayload.targetResolution }
      : {}),
  };
}

function isBrowserTransportMode(value: unknown): value is ReplayBrowserContinuitySummary["transportMode"] {
  return value === "relay" || value === "direct-cdp" || value === "local";
}

function isBrowserResumeMode(value: unknown): value is ReplayBrowserContinuitySummary["resumeMode"] {
  return value === "hot" || value === "warm" || value === "cold";
}

function isBrowserTargetResolution(value: unknown): value is ReplayBrowserContinuitySummary["targetResolution"] {
  return value === "attach" || value === "reconnect" || value === "reopen" || value === "new_target";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function buildRecoveryRunId(sourceGroupId: string): string {
  return `recovery:${sourceGroupId}`;
}
