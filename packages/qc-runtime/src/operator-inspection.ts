import type {
  FlowConsoleReport,
  FlowLedger,
  GovernanceConsoleReport,
  OperatorAttentionReport,
  OperatorAttentionItem,
  OperatorAttentionCaseSummary,
  OperatorCaseState,
  OperatorSummaryReport,
  PermissionCacheRecord,
  RecoveryConsoleReport,
  RecoveryRun,
  ReplayRecord,
  RoleId,
  ShardResultRecord,
  TeamEvent,
} from "@turnkeyai/core-types/team";
import { describeRecoveryRunGate } from "@turnkeyai/core-types/recovery-operator-semantics";
import { detectConflictRoleIds, detectDuplicateRoleIds } from "@turnkeyai/core-types/shard-result-analysis";
import {
  buildRecoveryRunProgress,
  buildReplayConsoleReport,
  buildReplayIncidentBundle,
  buildReplayInspectionReport,
  listActionableReplayIncidents,
} from "./replay-inspection";

export function buildFlowConsoleReport(flows: FlowLedger[], limit = 10): FlowConsoleReport {
  const statusCounts: FlowConsoleReport["statusCounts"] = {};
  const attentionStateCounts: FlowConsoleReport["attentionStateCounts"] = {};
  const shardStatusCounts: FlowConsoleReport["shardStatusCounts"] = {};
  let totalShardGroups = 0;
  let groupsWithMissingRoles = 0;
  let groupsWithRetries = 0;
  let groupsWithDuplicates = 0;
  let groupsWithConflicts = 0;
  let activeRoleCount = 0;
  const attentionGroups: FlowConsoleReport["attentionGroups"] = [];

  for (const flow of flows) {
    statusCounts[flow.status] = (statusCounts[flow.status] ?? 0) + 1;
    activeRoleCount += flow.activeRoleIds.length;

    for (const group of flow.shardGroups ?? []) {
      totalShardGroups += 1;
      shardStatusCounts[group.status] = (shardStatusCounts[group.status] ?? 0) + 1;
      const reasons: string[] = [];

      const missing = group.expectedRoleIds.some(
        (roleId) =>
          !group.completedRoleIds.includes(roleId) &&
          !group.failedRoleIds.includes(roleId) &&
          !group.cancelledRoleIds.includes(roleId)
      );
      if (missing) {
        groupsWithMissingRoles += 1;
        reasons.push("missing");
      }

      if (group.status !== "merged" && Object.values(group.retryCounts).some((count) => (count ?? 0) > 0)) {
        groupsWithRetries += 1;
        if (group.status !== "ready_to_merge") {
          reasons.push("retry");
        }
      }

      if (detectDuplicateRoleIds(group.shardResults).length > 0) {
        groupsWithDuplicates += 1;
        reasons.push("duplicate");
      }
      if (detectConflictRoleIds(group.shardResults).length > 0) {
        groupsWithConflicts += 1;
        reasons.push("conflict");
      }

      if (reasons.length > 0) {
        const caseState = deriveFlowCaseState(group.status, reasons);
        attentionStateCounts[caseState] = (attentionStateCounts[caseState] ?? 0) + 1;
        attentionGroups.push({
          flowId: flow.flowId,
          groupId: group.groupId,
          status: group.status,
          caseState,
          reasons,
        });
      }
    }
  }

  return {
    totalFlows: flows.length,
    statusCounts,
    totalShardGroups,
    attentionCount: attentionGroups.length,
    attentionStateCounts,
    shardStatusCounts,
    groupsWithMissingRoles,
    groupsWithRetries,
    groupsWithDuplicates,
    groupsWithConflicts,
    activeRoleCount,
    latestFlows: [...flows].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit),
    attentionGroups: attentionGroups.slice(0, limit),
  };
}

export function buildGovernanceConsoleReport(
  permissionRecords: PermissionCacheRecord[],
  events: TeamEvent[],
  limit = 10
): GovernanceConsoleReport {
  const permissionDecisionCounts: GovernanceConsoleReport["permissionDecisionCounts"] = {};
  const permissionScopeCounts: GovernanceConsoleReport["permissionScopeCounts"] = {};
  const requirementLevelCounts: GovernanceConsoleReport["requirementLevelCounts"] = {};
  const transportCounts: GovernanceConsoleReport["transportCounts"] = {};
  const trustCounts: GovernanceConsoleReport["trustCounts"] = {};
  const admissionCounts: GovernanceConsoleReport["admissionCounts"] = {};
  const recommendedActionCounts: GovernanceConsoleReport["recommendedActionCounts"] = {};

  for (const record of permissionRecords) {
    permissionDecisionCounts[record.decision] = (permissionDecisionCounts[record.decision] ?? 0) + 1;
    permissionScopeCounts[record.requirement.scope] = (permissionScopeCounts[record.requirement.scope] ?? 0) + 1;
    requirementLevelCounts[record.requirement.level] = (requirementLevelCounts[record.requirement.level] ?? 0) + 1;
  }

  const auditEvents = events
    .filter((event) => event.kind === "audit.logged")
    .sort((left, right) => right.createdAt - left.createdAt);
  let attentionCount = 0;

  for (const event of auditEvents) {
    const payload = event.payload ?? {};
    const transport =
      typeof payload.transport === "string" ? (payload.transport as keyof GovernanceConsoleReport["transportCounts"]) : "none";
    const trust =
      typeof payload.trustLevel === "string" ? (payload.trustLevel as keyof GovernanceConsoleReport["trustCounts"]) : null;
    const admission =
      typeof payload.admission === "object" && payload.admission && typeof (payload.admission as { mode?: unknown }).mode === "string"
        ? (((payload.admission as { mode: string }).mode) as keyof GovernanceConsoleReport["admissionCounts"])
        : typeof payload.admissionMode === "string"
          ? (payload.admissionMode as keyof GovernanceConsoleReport["admissionCounts"])
          : "unknown";
    const permission = typeof payload.permission === "object" && payload.permission
      ? (payload.permission as { recommendedAction?: unknown })
      : null;
    const recommendedAction =
      typeof permission?.recommendedAction === "string"
        ? (permission.recommendedAction as keyof GovernanceConsoleReport["recommendedActionCounts"])
        : "unknown";

    transportCounts[transport] = (transportCounts[transport] ?? 0) + 1;
    admissionCounts[admission] = (admissionCounts[admission] ?? 0) + 1;
    recommendedActionCounts[recommendedAction] = (recommendedActionCounts[recommendedAction] ?? 0) + 1;
    if (recommendedAction !== "proceed" && recommendedAction !== "unknown") {
      attentionCount += 1;
    }
    if (trust) {
      trustCounts[trust] = (trustCounts[trust] ?? 0) + 1;
    }
  }

  return {
    totalPermissionRecords: permissionRecords.length,
    attentionCount,
    permissionDecisionCounts,
    permissionScopeCounts,
    requirementLevelCounts,
    totalAuditEvents: auditEvents.length,
    transportCounts,
    trustCounts,
    admissionCounts,
    recommendedActionCounts,
    latestAudits: auditEvents.slice(0, limit),
  };
}

export function buildRecoveryConsoleReport(runs: RecoveryRun[], limit = 10): RecoveryConsoleReport {
  const statusCounts: RecoveryConsoleReport["statusCounts"] = {};
  const phaseCounts: RecoveryConsoleReport["phaseCounts"] = {};
  const gateCounts: RecoveryConsoleReport["gateCounts"] = {};
  const nextActionCounts: RecoveryConsoleReport["nextActionCounts"] = {};
  const browserResumeCounts: RecoveryConsoleReport["browserResumeCounts"] = {};
  const browserOutcomeCounts: RecoveryConsoleReport["browserOutcomeCounts"] = {};
  let attentionCount = 0;

  for (const run of runs) {
    statusCounts[run.status] = (statusCounts[run.status] ?? 0) + 1;
    const progress = buildRecoveryRunProgress(run);
    phaseCounts[progress.phase] = (phaseCounts[progress.phase] ?? 0) + 1;
    const gate = describeRecoveryRunGate(run.status);
    gateCounts[gate] = (gateCounts[gate] ?? 0) + 1;
    nextActionCounts[run.nextAction] = (nextActionCounts[run.nextAction] ?? 0) + 1;
    if (run.browserSession?.resumeMode) {
      browserResumeCounts[run.browserSession.resumeMode] = (browserResumeCounts[run.browserSession.resumeMode] ?? 0) + 1;
    }

    const latestBrowserOutcome =
      [...run.attempts]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .find((attempt) => attempt.browserOutcome)?.browserOutcome ?? null;
    if (latestBrowserOutcome) {
      browserOutcomeCounts[latestBrowserOutcome] = (browserOutcomeCounts[latestBrowserOutcome] ?? 0) + 1;
    }

    if (
      run.requiresManualIntervention ||
      run.status === "waiting_approval" ||
      run.status === "waiting_external" ||
      run.status === "failed" ||
      run.status === "aborted"
    ) {
      attentionCount += 1;
    }
  }

  return {
    totalRuns: runs.length,
    attentionCount,
    statusCounts,
    phaseCounts,
    gateCounts,
    nextActionCounts,
    browserResumeCounts,
    browserOutcomeCounts,
    latestRuns: [...runs].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit),
  };
}

export function buildOperatorSummaryReport(input: {
  flows: FlowLedger[];
  permissionRecords: PermissionCacheRecord[];
  events: TeamEvent[];
  replays: ReplayRecord[];
  recoveryRuns: RecoveryRun[];
  limit?: number;
}): OperatorSummaryReport {
  const limit = input.limit ?? 10;
  const flow = buildFlowConsoleReport(input.flows, limit);
  const replay = buildReplayConsoleReport(input.replays, limit);
  const governance = buildGovernanceConsoleReport(input.permissionRecords, input.events, limit);
  const recovery = buildRecoveryConsoleReport(input.recoveryRuns, limit);
  const attention = buildOperatorAttentionReport({ ...input, limit: Number.MAX_SAFE_INTEGER });
  const resolvedRecentCases = buildResolvedRecentCaseSummaries(input.replays, Math.min(limit, 5));
  const activeCases = attention.cases
    .slice()
    .sort(compareOperatorAttentionCases)
    .slice(0, Math.min(limit, 5))
    .map((entry) => ({
      caseKey: entry.caseKey,
      headline: entry.headline,
      caseState: entry.caseState,
      severity: entry.severity,
      lifecycle: entry.lifecycle,
      ...(entry.gate ? { gate: entry.gate } : {}),
      ...(entry.action ? { action: entry.action } : {}),
      ...(entry.browserContinuityState ? { browserContinuityState: entry.browserContinuityState } : {}),
      ...(entry.reasons && entry.reasons.length > 0 ? { reasonPreview: entry.reasons[0] } : {}),
      latestUpdate: entry.latestUpdate,
      nextStep: entry.nextStep,
    }));
  return {
    flow,
    replay,
    governance,
    recovery,
    totalAttentionCount: flow.attentionCount + replay.attentionCount + governance.attentionCount + recovery.attentionCount,
    attentionOverview: {
      uniqueCaseCount: attention.uniqueCaseCount,
      caseStateCounts: {
        open: attention.caseStateCounts.open ?? 0,
        recovering: attention.caseStateCounts.recovering ?? 0,
        waiting_manual: attention.caseStateCounts.waiting_manual ?? 0,
        blocked: attention.caseStateCounts.blocked ?? 0,
        resolved: replay.recoveredGroups,
      },
      severityCounts: attention.severityCounts,
      lifecycleCounts: attention.lifecycleCounts,
      activeCases,
      ...(resolvedRecentCases.length > 0 ? { resolvedRecentCases } : {}),
      topCases: activeCases,
    },
  };
}

export function buildOperatorAttentionReport(input: {
  flows: FlowLedger[];
  permissionRecords: PermissionCacheRecord[];
  events: TeamEvent[];
  replays: ReplayRecord[];
  recoveryRuns: RecoveryRun[];
  limit?: number;
}): OperatorAttentionReport {
  const limit = input.limit ?? 20;
  const fullReportLimit = Number.MAX_SAFE_INTEGER;
  const flow = buildFlowConsoleReport(input.flows, fullReportLimit);
  const replay = buildReplayConsoleReport(input.replays, fullReportLimit);
  const replayInspection = buildReplayInspectionReport(input.replays);
  const replayIncidents = listActionableReplayIncidents(input.replays, replayInspection);
  const governance = buildGovernanceConsoleReport(input.permissionRecords, input.events, fullReportLimit);
  const recovery = buildRecoveryConsoleReport(input.recoveryRuns, fullReportLimit);
  const bundleByGroupId = new Map(
    replayIncidents.map((incident) => [incident.groupId, buildReplayIncidentBundle(input.replays, incident.groupId)])
  );

  const flowUpdatedAtById = new Map(input.flows.map((flow) => [flow.flowId, flow.updatedAt]));
  const governanceAttentionEvents = governance.latestAudits.filter((event) => {
    const payload = event.payload ?? {};
    const permission = typeof payload.permission === "object" && payload.permission
      ? (payload.permission as { recommendedAction?: unknown })
      : null;
    return typeof permission?.recommendedAction === "string" && permission.recommendedAction !== "proceed";
  });
  const recoveryAttentionRuns = recovery.latestRuns.filter((run) =>
    run.requiresManualIntervention ||
    run.status === "waiting_approval" ||
    run.status === "waiting_external" ||
    run.status === "failed" ||
    run.status === "aborted"
  );

  const allItems: OperatorAttentionItem[] = [
    ...flow.attentionGroups.map((group) => ({
      source: "flow" as const,
      key: `${group.flowId}:${group.groupId}`,
      caseKey: `flow:${group.flowId}:${group.groupId}`,
      headline: "",
      recordedAt: flowUpdatedAtById.get(group.flowId) ?? 0,
      severity: deriveFlowAttentionSeverity(group.reasons),
      lifecycle: mapCaseStateToLifecycle(group.caseState),
      status: group.status,
      gate: group.caseState,
      reasons: group.reasons,
      summary: `Flow ${group.flowId} shard ${group.groupId} needs attention: ${group.reasons.join(", ")}.`,
      action: group.status === "ready_to_merge" ? "merge" : "inspect_shard_group",
    })),
    ...replayIncidents.slice(0, Math.max(limit, 20)).map((incident) => {
      const bundle = bundleByGroupId.get(incident.groupId) ?? null;
      const lifecycle = deriveReplayAttentionLifecycle(bundle);
      return {
        source: "replay" as const,
        key: incident.groupId,
        caseKey: `incident:${incident.groupId}`,
        headline: "",
        recordedAt: incident.latestRecordedAt,
        severity: deriveReplayAttentionSeverity(bundle),
        lifecycle,
        status: incident.latestStatus,
        gate:
          bundle?.recoveryWorkflow?.status === "manual_follow_up"
            ? "manual_follow_up"
            : incident.requiresFollowUp
              ? "follow_up_required"
              : "stable",
        reasons: [
          ...(incident.rootFailureCategory ? [incident.rootFailureCategory] : []),
          ...(incident.recoveryHint.action !== "none" ? [incident.recoveryHint.action] : []),
          ...(bundle?.recoveryWorkflow?.status ? [bundle.recoveryWorkflow.status] : []),
        ],
        ...(incident.browserContinuity ? { browserContinuityState: incident.browserContinuity.state } : {}),
        summary: incident.latestFailure?.message ?? incident.recoveryHint.reason,
        ...(incident.recoveryHint.action ? { action: incident.recoveryHint.action } : {}),
      };
    }),
    ...governanceAttentionEvents.map((event) => {
      const payload = event.payload ?? {};
      const permission = typeof payload.permission === "object" && payload.permission
        ? (payload.permission as { recommendedAction?: unknown })
        : null;
      const admission =
        typeof payload.admission === "object" && payload.admission && typeof (payload.admission as { mode?: unknown }).mode === "string"
          ? (payload.admission as { mode: string }).mode
          : typeof payload.admissionMode === "string"
            ? payload.admissionMode
            : "unknown";
      return {
        source: "governance" as const,
        key: event.eventId,
        caseKey: `governance:${event.eventId}`,
        headline: "",
        recordedAt: event.createdAt,
        severity:
          typeof permission?.recommendedAction === "string" && permission.recommendedAction === "request_approval"
            ? ("warning" as const)
            : ("critical" as const),
        lifecycle:
          typeof permission?.recommendedAction === "string" && permission.recommendedAction === "request_approval"
            ? ("waiting_manual" as const)
            : ("blocked" as const),
        status: String(payload.status ?? "unknown"),
        gate: typeof permission?.recommendedAction === "string" ? permission.recommendedAction : "inspect_governance",
        reasons: [
          String(payload.transport ?? "none"),
          admission,
        ],
        summary: `Governance audit for ${String(payload.workerType ?? "unknown worker")} via ${String(payload.transport ?? "none")} requires attention.`,
        ...(typeof permission?.recommendedAction === "string" ? { action: permission.recommendedAction } : {}),
      };
    }),
    ...recoveryAttentionRuns.map((run) => ({
      source: "recovery" as const,
      key: run.recoveryRunId,
      caseKey: `incident:${run.sourceGroupId}`,
      headline: "",
      recordedAt: run.updatedAt,
      severity: deriveRecoveryAttentionSeverity(run),
      lifecycle: deriveRecoveryAttentionLifecycle(run),
      status: run.status,
      gate: describeRecoveryRunGate(run.status),
      reasons: [
        run.status,
        ...(run.waitingReason ? [run.waitingReason] : []),
      ],
      ...(run.browserSession?.resumeMode === "hot"
        ? { browserContinuityState: "stable" as const }
        : run.browserSession?.resumeMode
          ? { browserContinuityState: "recovered" as const }
          : {}),
      summary: run.latestSummary,
      ...(run.nextAction !== "none" ? { action: run.nextAction } : {}),
    })),
  ].sort(compareOperatorAttentionItems);

  const groupedByCase = new Map<string, OperatorAttentionItem[]>();
  for (const item of allItems) {
    const group = groupedByCase.get(item.caseKey) ?? [];
    group.push(item);
    groupedByCase.set(item.caseKey, group);
  }
  for (const item of allItems) {
    item.headline = buildAttentionHeadline(groupedByCase.get(item.caseKey) ?? [item]);
  }

  const allCases = [...groupedByCase.entries()]
    .map(([caseKey, caseItems]) => buildAttentionCaseSummary(caseKey, caseItems))
    .sort(compareOperatorAttentionCases);

  const severityCounts: OperatorAttentionReport["severityCounts"] = {};
  const caseStateCounts: OperatorAttentionReport["caseStateCounts"] = {};
  const lifecycleCounts: OperatorAttentionReport["lifecycleCounts"] = {};
  for (const item of allItems) {
    severityCounts[item.severity] = (severityCounts[item.severity] ?? 0) + 1;
    const caseState = mapLifecycleToCaseState(item.lifecycle);
    caseStateCounts[caseState] = (caseStateCounts[caseState] ?? 0) + 1;
    lifecycleCounts[item.lifecycle] = (lifecycleCounts[item.lifecycle] ?? 0) + 1;
  }
  const items = allItems.slice(0, limit);
  const cases = allCases.slice(0, limit);

  return {
    totalItems: flow.attentionCount + replay.attentionCount + governance.attentionCount + recovery.attentionCount,
    returnedItems: items.length,
    uniqueCaseCount: new Set(allItems.map((item) => item.caseKey)).size,
    sourceCounts: {
      flow: flow.attentionCount,
      replay: replay.attentionCount,
      governance: governance.attentionCount,
      recovery: recovery.attentionCount,
    },
    caseStateCounts,
    severityCounts,
    lifecycleCounts,
    returnedCases: cases.length,
    cases,
    items,
  };
}

function deriveReplayAttentionLifecycle(
  bundle: ReturnType<typeof buildReplayIncidentBundle> | null
): OperatorAttentionItem["lifecycle"] {
  const workflowStatus = bundle?.recoveryWorkflow?.status;
  if (workflowStatus === "running") {
    return "recovering";
  }
  if (workflowStatus === "manual_follow_up") {
    return "waiting_manual";
  }
  if (workflowStatus === "recovery_failed") {
    return "blocked";
  }
  return "open";
}

function deriveFlowAttentionSeverity(reasons: string[]): OperatorAttentionItem["severity"] {
  if (reasons.includes("conflict") || reasons.includes("missing")) {
    return "critical";
  }
  return "warning";
}

function deriveFlowCaseState(
  status: FlowConsoleReport["attentionGroups"][number]["status"],
  reasons: string[]
): OperatorCaseState {
  if (reasons.includes("conflict")) {
    return "blocked";
  }
  if (status === "waiting_retry" || reasons.includes("retry")) {
    return "recovering";
  }
  if (reasons.includes("duplicate")) {
    return "blocked";
  }
  if (status === "merged") {
    return "resolved";
  }
  return "open";
}

function deriveReplayAttentionSeverity(
  bundle: ReturnType<typeof buildReplayIncidentBundle> | null
): OperatorAttentionItem["severity"] {
  const workflowStatus = bundle?.recoveryWorkflow?.status;
  if (workflowStatus === "recovery_failed") {
    return "critical";
  }
  return "warning";
}

function deriveRecoveryAttentionLifecycle(run: RecoveryRun): OperatorAttentionItem["lifecycle"] {
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
    case "failed":
    case "aborted":
      return "blocked";
    case "planned":
    default:
      return "open";
  }
}

function deriveRecoveryAttentionSeverity(run: RecoveryRun): OperatorAttentionItem["severity"] {
  switch (run.status) {
    case "failed":
    case "aborted":
      return "critical";
    default:
      return "warning";
  }
}

function severityRank(severity: OperatorAttentionItem["severity"]): number {
  switch (severity) {
    case "critical":
      return 2;
    case "warning":
    default:
      return 1;
  }
}

function lifecycleRank(lifecycle: OperatorAttentionItem["lifecycle"]): number {
  switch (lifecycle) {
    case "blocked":
      return 4;
    case "waiting_manual":
      return 3;
    case "recovering":
      return 2;
    case "open":
    default:
      return 1;
  }
}

function mapCaseStateToLifecycle(state: OperatorCaseState): OperatorAttentionItem["lifecycle"] {
  switch (state) {
    case "recovering":
      return "recovering";
    case "waiting_manual":
      return "waiting_manual";
    case "blocked":
      return "blocked";
    case "resolved":
      return "open";
    case "open":
    default:
      return "open";
  }
}

function mapLifecycleToCaseState(lifecycle: OperatorAttentionItem["lifecycle"]): OperatorCaseState {
  switch (lifecycle) {
    case "recovering":
      return "recovering";
    case "waiting_manual":
      return "waiting_manual";
    case "blocked":
      return "blocked";
    case "open":
    default:
      return "open";
  }
}

function buildAttentionHeadline(items: OperatorAttentionItem[]): string {
  const ordered = [...items].sort((left, right) => {
    const severityDelta = severityRank(right.severity) - severityRank(left.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return right.recordedAt - left.recordedAt;
  });
  const primary = ordered[0]!;
  const sources = unique(ordered.map((item) => item.source));
  const action = primary.action ? ` next=${primary.action}` : "";
  const browser = primary.browserContinuityState ? ` browser=${primary.browserContinuityState}` : "";
  const reason =
    primary.reasons && primary.reasons.length > 0
      ? ` reason=${primary.reasons[0]}`
      : "";
  return `${primary.caseKey} ${primary.lifecycle} via ${sources.join("+")}${action}${browser}${reason}`;
}

function buildAttentionCaseSummary(
  caseKey: string,
  items: OperatorAttentionItem[]
): OperatorAttentionCaseSummary {
  const ordered = [...items].sort((left, right) => {
    const lifecycleDelta = lifecycleRank(right.lifecycle) - lifecycleRank(left.lifecycle);
    if (lifecycleDelta !== 0) {
      return lifecycleDelta;
    }
    const severityDelta = severityRank(right.severity) - severityRank(left.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return right.recordedAt - left.recordedAt;
  });
  const primary = ordered[0]!;
  const lifecycle = primary.lifecycle;
  return {
    caseKey,
    headline: primary.headline,
    caseState: mapLifecycleToCaseState(lifecycle),
    severity: primary.severity,
    lifecycle,
    latestUpdate: primary.summary,
    nextStep: deriveAttentionNextStep(primary),
    latestRecordedAt: Math.max(...ordered.map((item) => item.recordedAt)),
    itemCount: ordered.length,
    sources: unique(ordered.map((item) => item.source)),
    ...(primary.gate ? { gate: primary.gate } : {}),
    ...(primary.action ? { action: primary.action } : {}),
    ...(primary.browserContinuityState ? { browserContinuityState: primary.browserContinuityState } : {}),
    ...(primary.reasons && primary.reasons.length > 0 ? { reasons: primary.reasons } : {}),
  };
}

function buildResolvedRecentCaseSummaries(
  records: ReplayRecord[],
  limit: number
): Array<{
  caseKey: string;
  headline: string;
  caseState: "resolved";
  source: "replay";
  gate?: string;
  action?: string;
  browserContinuityState?: "stable" | "recovered" | "attention";
  reasonPreview?: string;
  latestUpdate: string;
  nextStep: string;
}> {
  const consoleReport = buildReplayConsoleReport(records, Math.max(limit, 20));
  const report = buildReplayInspectionReport(records);
  const actionable = new Set(listActionableReplayIncidents(records, report).map((item) => item.groupId));
  const replayParentByGroupId = buildReplayParentByGroupId(records);
  return report.groups
    .filter((group) => resolveReplayRootGroupId(group.groupId, replayParentByGroupId) === group.groupId)
    .filter((group) => !actionable.has(group.groupId))
    .map((group) => buildReplayIncidentBundle(records, group.groupId))
    .filter((bundle): bundle is NonNullable<typeof bundle> => bundle != null && bundle.caseState === "resolved")
    .sort((left, right) => {
      const leftRecordedAt = Math.max(
        left.group.latestRecordedAt,
        left.followUpTimeline.at(-1)?.recordedAt ?? 0,
        left.recoveryTimeline?.at(-1)?.recordedAt ?? 0
      );
      const rightRecordedAt = Math.max(
        right.group.latestRecordedAt,
        right.followUpTimeline.at(-1)?.recordedAt ?? 0,
        right.recoveryTimeline?.at(-1)?.recordedAt ?? 0
      );
      const recordedDelta = rightRecordedAt - leftRecordedAt;
      if (recordedDelta !== 0) {
        return recordedDelta;
      }
      return left.group.groupId.localeCompare(right.group.groupId);
    })
    .slice(0, limit)
    .map((bundle) => {
      const reasonPreview = extractResolvedReasonPreview(bundle);
      return {
        caseKey: `incident:${bundle.group.groupId}`,
        headline: bundle.caseHeadline ?? `${bundle.group.groupId} resolved`,
        caseState: "resolved" as const,
        source: "replay" as const,
        ...(bundle.recoveryWorkflow?.status ? { gate: bundle.recoveryWorkflow.status } : {}),
        ...(bundle.recoveryWorkflow?.nextAction && bundle.recoveryWorkflow.nextAction !== "none"
          ? { action: bundle.recoveryWorkflow.nextAction }
          : {}),
        ...(bundle.browserContinuity?.state ? { browserContinuityState: bundle.browserContinuity.state } : {}),
        ...(reasonPreview ? { reasonPreview } : {}),
        latestUpdate:
          bundle.recoveryWorkflow?.summary ??
          bundle.browserContinuity?.summary ??
          bundle.group.latestFailure?.message ??
          "Case resolved.",
        nextStep: "none",
      };
    });
}

function buildReplayParentByGroupId(records: ReplayRecord[]): Map<string, string> {
  const parentByGroupId = new Map<string, string>();
  for (const record of records) {
    const groupId = record.taskId ?? record.replayId;
    const recoveryContext =
      record.metadata &&
      typeof record.metadata === "object" &&
      record.metadata.recoveryContext &&
      typeof record.metadata.recoveryContext === "object"
        ? (record.metadata.recoveryContext as Record<string, unknown>)
        : null;
    const parentGroupId = typeof recoveryContext?.parentGroupId === "string" ? recoveryContext.parentGroupId : undefined;
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

function deriveAttentionNextStep(item: OperatorAttentionItem): string {
  if (item.action) {
    return item.action;
  }
  switch (item.lifecycle) {
    case "recovering":
      return "monitor_recovery";
    case "waiting_manual":
      return "review_and_continue";
    case "blocked":
      return "inspect_and_unblock";
    case "open":
    default:
      return "inspect_case";
  }
}

function compareOperatorAttentionItems(left: OperatorAttentionItem, right: OperatorAttentionItem): number {
  const severityDelta = severityRank(right.severity) - severityRank(left.severity);
  if (severityDelta !== 0) {
    return severityDelta;
  }
  const lifecycleDelta = lifecycleRank(right.lifecycle) - lifecycleRank(left.lifecycle);
  if (lifecycleDelta !== 0) {
    return lifecycleDelta;
  }
  const recordedDelta = right.recordedAt - left.recordedAt;
  if (recordedDelta !== 0) {
    return recordedDelta;
  }
  const caseDelta = left.caseKey.localeCompare(right.caseKey);
  if (caseDelta !== 0) {
    return caseDelta;
  }
  return left.key.localeCompare(right.key);
}

function compareOperatorAttentionCases(left: OperatorAttentionCaseSummary, right: OperatorAttentionCaseSummary): number {
  const severityDelta = severityRank(right.severity) - severityRank(left.severity);
  if (severityDelta !== 0) {
    return severityDelta;
  }
  const lifecycleDelta = lifecycleRank(right.lifecycle) - lifecycleRank(left.lifecycle);
  if (lifecycleDelta !== 0) {
    return lifecycleDelta;
  }
  const recordedDelta = right.latestRecordedAt - left.latestRecordedAt;
  if (recordedDelta !== 0) {
    return recordedDelta;
  }
  return left.caseKey.localeCompare(right.caseKey);
}

function extractResolvedReasonPreview(bundle: NonNullable<ReturnType<typeof buildReplayIncidentBundle>>): string | undefined {
  if (bundle.recoveryWorkflow?.latestFailure?.category) {
    return bundle.recoveryWorkflow.latestFailure.category;
  }
  if (bundle.group.latestFailure?.category) {
    return bundle.group.latestFailure.category;
  }
  if (bundle.group.rootFailureCategory) {
    return bundle.group.rootFailureCategory;
  }
  const headlineMatch = bundle.caseHeadline?.match(/\breason=([^\s]+)/);
  if (headlineMatch?.[1]) {
    return headlineMatch[1];
  }
  return undefined;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
