import type {
  FlowConsoleReport,
  FlowLedger,
  GovernanceConsoleReport,
  OperatorAttentionReport,
  OperatorAttentionItem,
  OperatorAttentionCaseSummary,
  OperatorCaseState,
  OperatorSummaryReport,
  OperatorTriageFocusArea,
  OperatorTriageReport,
  PermissionCacheRecord,
  PromptBoundaryEntry,
  PromptConsoleReport,
  RecoveryConsoleReport,
  RecoveryRun,
  ReplayBrowserContinuitySummary,
  ReplayRecord,
  RoleId,
  RuntimeProgressEvent,
  RuntimeSummaryReport,
  ShardResultRecord,
  TeamEvent,
} from "@turnkeyai/core-types/team";
import { describeRecoveryRunGate, listAllowedRecoveryRunActions } from "@turnkeyai/core-types/recovery-operator-semantics";
import { detectConflictRoleIds, detectDuplicateRoleIds } from "@turnkeyai/core-types/shard-result-analysis";
import {
  attachRecoveryRunToReplayIncidentBundle,
  buildRecoveryRunProgress,
  buildReplayConsoleReport,
  buildReplayIncidentBundle,
  buildReplayInspectionReport,
  listActionableReplayIncidents,
  type RelayDiagnosticsSnapshot,
} from "./replay-inspection";
import { buildPromptConsoleReport } from "./prompt-inspection";

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
  progressEvents?: RuntimeProgressEvent[];
  relayDiagnostics?: RelayDiagnosticsSnapshot;
  limit?: number;
}): OperatorSummaryReport {
  const limit = input.limit ?? 10;
  const flow = buildFlowConsoleReport(input.flows, limit);
  const replay = buildReplayConsoleReport(input.replays, limit, input.recoveryRuns, input.relayDiagnostics);
  const governance = buildGovernanceConsoleReport(input.permissionRecords, input.events, limit);
  const recovery = buildRecoveryConsoleReport(input.recoveryRuns, limit);
  const prompt = buildPromptConsoleReport(input.progressEvents ?? [], limit);
  const attention = buildOperatorAttentionReport({ ...input, limit: Number.MAX_SAFE_INTEGER });
  const promptAttentionCount = attention.sourceCounts.prompt ?? 0;
  const resolvedRecentCases = buildResolvedRecentCaseSummaries(
    input.replays,
    input.recoveryRuns,
    Math.min(limit, 5),
    input.relayDiagnostics
  );
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
      ...(entry.allowedActions && entry.allowedActions.length > 0 ? { allowedActions: entry.allowedActions } : {}),
      ...(entry.browserContinuityState ? { browserContinuityState: entry.browserContinuityState } : {}),
      ...(entry.browserTransportLabel ? { browserTransportLabel: entry.browserTransportLabel } : {}),
      ...(entry.relayDiagnosticBucket ? { relayDiagnosticBucket: entry.relayDiagnosticBucket } : {}),
      ...(entry.reasons && entry.reasons.length > 0 ? { reasonPreview: entry.reasons[0] } : {}),
      latestUpdate: entry.latestUpdate,
      nextStep: entry.nextStep,
    }));
  return {
    flow,
    replay,
    governance,
    recovery,
    prompt,
    promptAttentionCount,
    totalAttentionCount:
      flow.attentionCount + replay.attentionCount + governance.attentionCount + recovery.attentionCount + promptAttentionCount,
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
  progressEvents?: RuntimeProgressEvent[];
  relayDiagnostics?: RelayDiagnosticsSnapshot;
  limit?: number;
}): OperatorAttentionReport {
  const limit = input.limit ?? 20;
  const fullReportLimit = Number.MAX_SAFE_INTEGER;
  const flow = buildFlowConsoleReport(input.flows, fullReportLimit);
  const replay = buildReplayConsoleReport(input.replays, fullReportLimit, input.recoveryRuns, input.relayDiagnostics);
  const replayInspection = buildReplayInspectionReport(input.replays);
  const replayIncidents = listActionableReplayIncidents(input.replays, replayInspection);
  const governance = buildGovernanceConsoleReport(input.permissionRecords, input.events, fullReportLimit);
  const recovery = buildRecoveryConsoleReport(input.recoveryRuns, fullReportLimit);
  const prompt = buildPromptConsoleReport(input.progressEvents ?? [], fullReportLimit);
  const bundleByGroupId = new Map(
    replayIncidents.map((incident) => [
      incident.groupId,
      buildReplayIncidentBundle(input.replays, incident.groupId, input.relayDiagnostics),
    ])
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
    ...replayIncidents.map((incident) => {
      const bundle = bundleByGroupId.get(incident.groupId) ?? null;
      const lifecycle = deriveReplayAttentionLifecycle(bundle);
      const browserContinuity = bundle?.browserContinuity ?? incident.browserContinuity;
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
          ...(browserContinuity?.browserDiagnosticBucket ? [browserContinuity.browserDiagnosticBucket] : []),
        ],
        ...(browserContinuity ? { browserContinuityState: browserContinuity.state } : {}),
        ...(browserContinuity?.transportLabel ? { browserTransportLabel: browserContinuity.transportLabel } : {}),
        ...(browserContinuity?.browserDiagnosticBucket
          ? { browserDiagnosticBucket: browserContinuity.browserDiagnosticBucket }
          : {}),
        ...(browserContinuity?.relayDiagnosticBucket
          ? { relayDiagnosticBucket: browserContinuity.relayDiagnosticBucket }
          : {}),
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
      allowedActions: listAllowedRecoveryRunActions(run.status).filter((candidate) => candidate !== "dispatch"),
      ...(run.browserSession?.resumeMode === "hot"
        ? { browserContinuityState: "stable" as const }
        : run.browserSession?.resumeMode
          ? { browserContinuityState: "recovered" as const }
          : {}),
      summary: run.latestSummary,
      ...(run.nextAction !== "none" ? { action: run.nextAction } : {}),
    })),
    ...buildPromptAttentionItems(prompt),
  ].sort(compareOperatorAttentionItems);
  const promptAttentionCount = allItems.filter((item) => item.source === "prompt").length;

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
    totalItems:
      flow.attentionCount +
      replay.attentionCount +
      governance.attentionCount +
      recovery.attentionCount +
      promptAttentionCount,
    returnedItems: items.length,
    uniqueCaseCount: new Set(allItems.map((item) => item.caseKey)).size,
    sourceCounts: {
      flow: flow.attentionCount,
      replay: replay.attentionCount,
      governance: governance.attentionCount,
      recovery: recovery.attentionCount,
      prompt: promptAttentionCount,
    },
    caseStateCounts,
    severityCounts,
    lifecycleCounts,
    returnedCases: cases.length,
    cases,
    items,
  };
}

export function buildOperatorTriageReport(input: {
  summary: OperatorSummaryReport;
  attention: OperatorAttentionReport;
  runtime: RuntimeSummaryReport;
  limit?: number;
}): OperatorTriageReport {
  const limit = input.limit ?? 5;
  const focusAreas: OperatorTriageFocusArea[] = [
    ...input.attention.cases.map((entry) => mapAttentionCaseToTriageFocus(entry)),
  ];

  if (input.runtime.staleCount > 0) {
    const stale = input.runtime.staleChains[0];
    focusAreas.push({
      area: "runtime",
      label: "runtime-stale",
      severity: "critical",
      headline: `runtime stale chains=${input.runtime.staleCount}`,
      reason:
        stale
          ? stale.staleReason ??
            stale.currentWaitingPoint ??
            stale.headline ??
            "Runtime has stale chains that need inspection."
          : "Runtime reports stale chains but no chain details are available.",
      nextStep: "inspect_stale_runtime",
      commandHint: "runtime-stale 10",
      ...(stale?.chainId ? { caseKey: stale.chainId } : {}),
      ...(stale?.canonicalState ? { state: stale.canonicalState } : {}),
    });
  } else if (input.runtime.waitingCount > 0) {
    const waiting = input.runtime.waitingChains[0];
    focusAreas.push({
      area: "runtime",
      label: "runtime-waiting",
      severity: "warning",
      headline: `runtime waiting chains=${input.runtime.waitingCount}`,
      reason:
        waiting?.currentWaitingPoint ??
        waiting?.waitingReason ??
        waiting?.headline ??
        "Runtime still has active waiting chains.",
      nextStep: "inspect_waiting_runtime",
      commandHint: "runtime-waiting 10",
      ...(waiting?.chainId ? { caseKey: waiting.chainId } : {}),
      ...(waiting?.canonicalState ? { state: waiting.canonicalState } : {}),
    });
  }

  const promptPrimary = input.summary.prompt.latestBoundaries[0];
  const hasPromptCase = input.attention.cases.some((entry) => entry.sources.includes("prompt"));
  if (!hasPromptCase && (input.summary.prompt.reductionCount > 0 || input.summary.promptAttentionCount > 0)) {
    focusAreas.push({
      area: "prompt",
      label: "prompt-pressure",
      severity: input.summary.prompt.reductionCount > 0 ? "critical" : "warning",
      headline: `prompt pressure boundaries=${input.summary.prompt.totalBoundaries}`,
      reason:
        promptPrimary?.summary ??
        "Prompt pressure reduced or compacted the request envelope.",
      nextStep: "inspect_prompt_boundary",
      commandHint: "prompt-console 10",
      ...(promptPrimary?.progressId ? { caseKey: `prompt:${promptPrimary.progressId}` } : {}),
      ...(promptPrimary?.boundaryKind ? { state: promptPrimary.boundaryKind } : {}),
    });
  }

  const orderedFocusAreas = focusAreas
    .sort(compareOperatorTriageFocusAreas)
    .slice(0, limit);

  return {
    totalAttentionCount: input.summary.totalAttentionCount,
    uniqueCaseCount: input.attention.uniqueCaseCount,
    blockedCaseCount: input.attention.caseStateCounts.blocked ?? 0,
    waitingManualCaseCount: input.attention.caseStateCounts.waiting_manual ?? 0,
    recoveringCaseCount: input.attention.caseStateCounts.recovering ?? 0,
    runtimeWaitingCount: input.runtime.waitingCount,
    runtimeStaleCount: input.runtime.staleCount,
    runtimeFailedCount: input.runtime.failedCount,
    promptReductionCount: input.summary.prompt.reductionCount,
    promptAttentionCount: input.summary.promptAttentionCount,
    ...(orderedFocusAreas[0]?.commandHint ? { recommendedEntryPoint: orderedFocusAreas[0].commandHint } : {}),
    focusAreas: orderedFocusAreas,
  };
}

function buildPromptAttentionItems(prompt: PromptConsoleReport): OperatorAttentionItem[] {
  return prompt.latestBoundaries
    .filter((boundary) => boundary.boundaryKind === "request_envelope_reduction" || shouldEscalatePromptCompaction(boundary))
    .map((boundary) => ({
      source: "prompt" as const,
      key: boundary.progressId,
      caseKey: buildPromptCaseKey(boundary),
      headline: "",
      recordedAt: boundary.recordedAt,
      severity: boundary.boundaryKind === "request_envelope_reduction" ? "critical" : "warning",
      lifecycle: boundary.boundaryKind === "request_envelope_reduction" ? "blocked" : "open",
      status: boundary.boundaryKind,
      gate: boundary.boundaryKind === "request_envelope_reduction" ? "request_envelope_reduction" : "prompt_compaction",
      reasons: compactPromptReasons(boundary),
      summary: boundary.summary,
      action: "inspect_prompt_boundary",
    }));
}

function buildPromptCaseKey(boundary: PromptBoundaryEntry): string {
  if (boundary.taskId) {
    return `prompt:${boundary.taskId}`;
  }
  if (boundary.flowId) {
    return `prompt:${boundary.flowId}`;
  }
  return `prompt:${boundary.progressId}`;
}

function shouldEscalatePromptCompaction(boundary: PromptBoundaryEntry): boolean {
  if (boundary.boundaryKind !== "prompt_compaction") {
    return false;
  }
  const diagnostics = boundary.contextDiagnostics;
  if (!diagnostics) {
    return (boundary.compactedSegments?.length ?? 0) >= 2;
  }
  return (
    diagnostics.recentTurns.packedCount < diagnostics.recentTurns.selectedCount ||
    diagnostics.retrievedMemory.packedCount < diagnostics.retrievedMemory.selectedCount ||
    diagnostics.workerEvidence.packedCount < diagnostics.workerEvidence.selectedCount
  );
}

function compactPromptReasons(boundary: PromptBoundaryEntry): string[] {
  const reasons: string[] = [];
  if (boundary.reductionLevel) {
    reasons.push(boundary.reductionLevel);
  }
  if ((boundary.compactedSegments?.length ?? 0) > 0) {
    reasons.push(...(boundary.compactedSegments ?? []).slice(0, 3));
  }
  if (boundary.contextDiagnostics) {
    if (boundary.contextDiagnostics.continuity.carriesPendingWork) {
      reasons.push("pending");
    }
    if (boundary.contextDiagnostics.continuity.carriesWaitingOn) {
      reasons.push("waiting");
    }
    if (boundary.contextDiagnostics.continuity.carriesOpenQuestions) {
      reasons.push("open_questions");
    }
  }
  return [...new Set(reasons)];
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
  const browserTransportLabel = ordered.find((item) => item.browserTransportLabel)?.browserTransportLabel;
  const browserDiagnosticBucket = ordered.find((item) => item.browserDiagnosticBucket)?.browserDiagnosticBucket;
  const relayDiagnosticBucket = ordered.find((item) => item.relayDiagnosticBucket)?.relayDiagnosticBucket;
  const sources = unique(ordered.map((item) => item.source));
  const action = primary.action ? ` next=${primary.action}` : "";
  const browser = primary.browserContinuityState ? ` browser=${primary.browserContinuityState}` : "";
  const transport = browserTransportLabel ? ` transport=${browserTransportLabel}` : "";
  const relay = relayDiagnosticBucket ? ` relay=${relayDiagnosticBucket}` : browserDiagnosticBucket ? ` diag=${browserDiagnosticBucket}` : "";
  const reason =
    primary.reasons && primary.reasons.length > 0
      ? ` reason=${primary.reasons[0]}`
      : "";
  return `${primary.caseKey} ${primary.lifecycle} via ${sources.join("+")}${action}${browser}${transport}${relay}${reason}`;
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
  const browserTransportLabel = ordered.find((item) => item.browserTransportLabel)?.browserTransportLabel;
  const browserDiagnosticBucket = ordered.find((item) => item.browserDiagnosticBucket)?.browserDiagnosticBucket;
  const relayDiagnosticBucket = ordered.find((item) => item.relayDiagnosticBucket)?.relayDiagnosticBucket;
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
    ...(primary.allowedActions && primary.allowedActions.length > 0 ? { allowedActions: primary.allowedActions } : {}),
    ...(primary.browserContinuityState ? { browserContinuityState: primary.browserContinuityState } : {}),
    ...(browserTransportLabel ? { browserTransportLabel } : {}),
    ...(browserDiagnosticBucket ? { browserDiagnosticBucket } : {}),
    ...(relayDiagnosticBucket ? { relayDiagnosticBucket } : {}),
    ...(primary.reasons && primary.reasons.length > 0 ? { reasons: primary.reasons } : {}),
  };
}

function buildResolvedRecentCaseSummaries(
  records: ReplayRecord[],
  recoveryRuns: RecoveryRun[],
  limit: number,
  relayDiagnostics?: RelayDiagnosticsSnapshot
): Array<{
  caseKey: string;
  headline: string;
  caseState: "resolved";
  source: "replay";
  gate?: string;
  action?: string;
  browserContinuityState?: "stable" | "recovered" | "attention";
  browserTransportLabel?: string;
  browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
  relayDiagnosticBucket?: "peer_missing" | "peer_stale" | "target_missing" | "target_detached" | "target_closed" | "content_script_unavailable" | "action_timeout" | "action_failed";
  reasonPreview?: string;
  latestUpdate: string;
  nextStep: string;
}> {
  const consoleReport = buildReplayConsoleReport(records, Math.max(limit, 20), recoveryRuns, relayDiagnostics);
  const report = buildReplayInspectionReport(records);
  const actionable = new Set(listActionableReplayIncidents(records, report).map((item) => item.groupId));
  const replayParentByGroupId = buildReplayParentByGroupId(records);
  return report.groups
    .filter((group) => resolveReplayRootGroupId(group.groupId, replayParentByGroupId) === group.groupId)
    .filter((group) => !actionable.has(group.groupId))
    .map((group) => {
      const bundle = buildReplayIncidentBundle(records, group.groupId, relayDiagnostics);
      if (!bundle) {
        return null;
      }
      const run = recoveryRuns.find((item) => item.sourceGroupId === group.groupId) ?? null;
      return run
        ? attachRecoveryRunToReplayIncidentBundle({
            bundle,
            run,
            records,
          })
        : bundle;
    })
    .filter(
      (bundle): bundle is NonNullable<typeof bundle> =>
        bundle != null &&
        bundle.caseState === "resolved" &&
        (bundle.recoveryOperator?.caseState ?? "resolved") === "resolved"
    )
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
        ...(bundle.browserContinuity?.transportLabel ? { browserTransportLabel: bundle.browserContinuity.transportLabel } : {}),
        ...(bundle.browserContinuity?.browserDiagnosticBucket
          ? { browserDiagnosticBucket: bundle.browserContinuity.browserDiagnosticBucket }
          : {}),
        ...(bundle.browserContinuity?.relayDiagnosticBucket
          ? { relayDiagnosticBucket: bundle.browserContinuity.relayDiagnosticBucket }
          : {}),
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

function mapAttentionCaseToTriageFocus(entry: OperatorAttentionCaseSummary): OperatorTriageFocusArea {
  const primarySource = entry.sources[0] ?? "replay";
  return {
    area: "case",
    label: primarySource,
    severity: entry.severity,
    headline: entry.headline,
    reason: entry.latestUpdate,
    nextStep: entry.nextStep,
    commandHint: deriveTriageCommandHint(entry),
    caseKey: entry.caseKey,
    source: primarySource,
    ...(entry.gate ? { gate: entry.gate } : {}),
    ...(entry.caseState ? { state: entry.caseState } : {}),
    ...(entry.browserContinuityState ? { browserContinuityState: entry.browserContinuityState } : {}),
    ...(entry.browserTransportLabel ? { browserTransportLabel: entry.browserTransportLabel } : {}),
    ...(entry.browserDiagnosticBucket ? { browserDiagnosticBucket: entry.browserDiagnosticBucket } : {}),
    ...(entry.relayDiagnosticBucket ? { relayDiagnosticBucket: entry.relayDiagnosticBucket } : {}),
  };
}

function deriveTriageCommandHint(entry: OperatorAttentionCaseSummary): string {
  if (entry.caseKey.startsWith("incident:")) {
    return `replay-bundle ${entry.caseKey.slice("incident:".length)}`;
  }
  if (entry.sources.includes("recovery")) {
    return "recovery-summary 10";
  }
  if (entry.sources.includes("flow")) {
    return "flows-summary";
  }
  if (entry.sources.includes("governance")) {
    return "governance workers 20";
  }
  if (entry.sources.includes("prompt")) {
    return "prompt-console 10";
  }
  return "operator-attention 10";
}

function compareOperatorTriageFocusAreas(left: OperatorTriageFocusArea, right: OperatorTriageFocusArea): number {
  const areaDelta = triageAreaRank(right.area) - triageAreaRank(left.area);
  if (areaDelta !== 0) {
    return areaDelta;
  }
  const sourceDelta = triageSourceRank(right.source) - triageSourceRank(left.source);
  if (sourceDelta !== 0) {
    return sourceDelta;
  }
  const severityDelta = severityRank(right.severity) - severityRank(left.severity);
  if (severityDelta !== 0) {
    return severityDelta;
  }
  const leftCase = left.caseKey ?? left.label;
  const rightCase = right.caseKey ?? right.label;
  return leftCase.localeCompare(rightCase);
}

function triageAreaRank(area: OperatorTriageFocusArea["area"]): number {
  switch (area) {
    case "case":
      return 3;
    case "runtime":
      return 2;
    case "prompt":
    default:
      return 1;
  }
}

function triageSourceRank(source: OperatorTriageFocusArea["source"] | undefined): number {
  switch (source) {
    case "replay":
      return 5;
    case "recovery":
      return 4;
    case "flow":
      return 3;
    case "governance":
      return 2;
    case "prompt":
      return 1;
    default:
      return 0;
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
