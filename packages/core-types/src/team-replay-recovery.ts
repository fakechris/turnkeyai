import type {
  BrowserContinuationHint,
  FlowId,
  FlowLedger,
  FlowStatus,
  RoleId,
  RunKey,
  ShardGroupRecord,
  TaskId,
  TeamEvent,
  ThreadId,
  RuntimeSummaryEntry,
  RuntimeSummaryReport,
  WorkerKind,
} from "./team-core";
import type {
  BrowserResumeMode,
  BrowserSessionStatus,
  BrowserTargetStatus,
  BrowserTaskResult,
  BrowserTransportDiagnosticBucket,
  BrowserTransportMode,
} from "./browser";
import type {
  EvidenceTrustLevel,
  PermissionDecision,
  PermissionEvaluation,
  PermissionRequirementLevel,
  PermissionScope,
  PromptAdmissionMode,
  TransportKind,
} from "./team-runtime-support";

export type ReplayLayer = "scheduled" | "role" | "worker" | "browser";
export type ReplayStatus = "completed" | "partial" | "failed";
export type FailureCategory =
  | "timeout"
  | "permission_denied"
  | "transport_failed"
  | "stale_session"
  | "invalid_resume"
  | "blocked"
  | "merge_failure"
  | "terminal"
  | "unknown";
export type FailureRecommendedAction =
  | "resume"
  | "retry"
  | "fallback"
  | "request_approval"
  | "abort"
  | "inspect";

export interface FailureSummary {
  category: FailureCategory;
  layer: ReplayLayer;
  retryable: boolean;
  message: string;
  recommendedAction: FailureRecommendedAction;
  details?: Record<string, unknown>;
}

export interface ReplayRecord {
  replayId: string;
  layer: ReplayLayer;
  status: ReplayStatus;
  recordedAt: number;
  threadId: ThreadId;
  summary: string;
  flowId?: FlowId;
  roleId?: RoleId;
  workerType?: WorkerKind;
  workerRunKey?: RunKey;
  taskId?: TaskId;
  parentReplayId?: string;
  failure?: FailureSummary;
  metadata?: Record<string, unknown>;
}

export interface ReplayStore {
  record(record: ReplayRecord): Promise<string>;
  get(replayId: string): Promise<ReplayRecord | null>;
  list(input?: { threadId?: ThreadId; layer?: ReplayLayer; limit?: number }): Promise<ReplayRecord[]>;
}

export interface ReplayLayerSnapshot {
  replayId: string;
  layer: ReplayLayer;
  status: ReplayStatus;
  recordedAt: number;
  summary: string;
  workerType?: WorkerKind;
  failure?: FailureSummary;
}

export interface ReplayTaskSummary {
  groupId: string;
  threadId: ThreadId;
  taskId?: TaskId;
  flowId?: FlowId;
  roleId?: RoleId;
  latestRecordedAt: number;
  latestStatus: ReplayStatus;
  layersSeen: ReplayLayer[];
  replayIds: string[];
  byLayer: Partial<Record<ReplayLayer, ReplayLayerSnapshot>>;
  lastHealthyLayer?: ReplayLayer;
  failedLayer?: ReplayLayer;
  rootFailureCategory?: FailureCategory;
  latestFailure?: FailureSummary;
  recommendedAction?: FailureRecommendedAction;
  recoveryHint: ReplayRecoveryHint;
  requiresFollowUp: boolean;
  browserContinuity?: ReplayBrowserContinuitySummary;
}

export interface ReplayInspectionReport {
  totalReplays: number;
  totalGroups: number;
  incidents: ReplayTaskSummary[];
  groups: ReplayTaskSummary[];
  layerCounts: Partial<Record<ReplayLayer, number>>;
  failureCounts: Partial<Record<FailureCategory, number>>;
}

export interface ReplayRecoveryHint {
  action: FailureRecommendedAction | "none";
  reason: string;
  preferredLayer?: ReplayLayer;
  failedLayer?: ReplayLayer;
  lastHealthyLayer?: ReplayLayer;
}

export interface ReplayRecoveryPlan {
  groupId: string;
  threadId: ThreadId;
  taskId?: TaskId;
  flowId?: FlowId;
  roleId?: RoleId;
  latestStatus: ReplayStatus;
  recoveryHint: ReplayRecoveryHint;
  latestFailure?: FailureSummary;
  layersSeen: ReplayLayer[];
  canAutoResume: boolean;
  requiresManualIntervention: boolean;
  autoDispatchReady: boolean;
  targetWorker?: WorkerKind;
  nextAction:
    | "auto_resume"
    | "retry_same_layer"
    | "fallback_transport"
    | "request_approval"
    | "inspect_then_resume"
    | "stop";
  targetLayer?: ReplayLayer;
}

export interface ReplayTimelineEntry {
  replayId: string;
  groupId: string;
  threadId: ThreadId;
  layer: ReplayLayer;
  status: ReplayStatus;
  recordedAt: number;
  summary: string;
  attemptId?: string;
  flowId?: FlowId;
  roleId?: RoleId;
  workerType?: WorkerKind;
  failure?: FailureSummary;
}

export interface ReplayBrowserContinuitySummary {
  latestRecordedAt: number;
  state: "stable" | "recovered" | "attention";
  summary: string;
  sessionId?: string;
  targetId?: string;
  transportMode?: BrowserTransportMode;
  transportLabel?: string;
  transportPeerId?: string;
  transportTargetId?: string;
  browserDiagnosticBucket?: BrowserTransportDiagnosticBucket;
  browserDiagnosticSummary?: string;
  resumeMode?: BrowserResumeMode;
  targetResolution?: BrowserTaskResult["targetResolution"];
  outcome?: RecoveryBrowserOutcome;
  relayPeerStatus?: "online" | "stale" | "missing";
  relayTargetStatus?: BrowserTargetStatus | "missing";
  relayDiagnosticBucket?:
    | "peer_missing"
    | "peer_stale"
    | "target_missing"
    | "target_detached"
    | "target_closed"
    | "content_script_unavailable"
    | "action_timeout"
    | "action_failed";
  relayDiagnosticSummary?: string;
}

export interface ReplayConsoleReport {
  totalReplays: number;
  totalGroups: number;
  openIncidents: number;
  recoveredGroups: number;
  attentionCount: number;
  actionCounts: Partial<Record<ReplayRecoveryPlan["nextAction"], number>>;
  workflowStatusCounts: Partial<Record<NonNullable<ReplayIncidentBundle["recoveryWorkflow"]>["status"], number>>;
  caseStateCounts: Partial<Record<OperatorCaseState, number>>;
  operatorCaseStateCounts: Partial<Record<OperatorCaseState, number>>;
  browserContinuityCounts: Partial<Record<ReplayBrowserContinuitySummary["state"], number>>;
  layerCounts: Partial<Record<ReplayLayer, number>>;
  failureCounts: Partial<Record<FailureCategory, number>>;
  latestIncidents: ReplayRecoveryPlan[];
  latestBundles: Array<{
    groupId: string;
    latestStatus: ReplayTaskSummary["latestStatus"];
    nextAction: ReplayRecoveryPlan["nextAction"] | "none";
    autoDispatchReady: boolean;
    caseState?: OperatorCaseState;
    workflowStatus?: NonNullable<ReplayIncidentBundle["recoveryWorkflow"]>["status"];
    workflowSummary?: string;
    caseHeadline?: string;
    browserContinuityState?: ReplayBrowserContinuitySummary["state"];
    browserTransportLabel?: string;
    browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
    relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
    targetLayer?: ReplayRecoveryPlan["targetLayer"];
    targetWorker?: ReplayRecoveryPlan["targetWorker"];
    operatorCaseState?: OperatorCaseState;
    operatorGate?: string;
    operatorAllowedActions?: RecoveryRunAction[];
  }>;
  latestResolvedBundles: Array<{
    groupId: string;
    latestStatus: ReplayTaskSummary["latestStatus"];
    nextAction: ReplayRecoveryPlan["nextAction"] | "none";
    autoDispatchReady: boolean;
    caseState?: OperatorCaseState;
    workflowStatus?: NonNullable<ReplayIncidentBundle["recoveryWorkflow"]>["status"];
    workflowSummary?: string;
    caseHeadline?: string;
    browserContinuityState?: ReplayBrowserContinuitySummary["state"];
    browserTransportLabel?: string;
    browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
    relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
    targetLayer?: ReplayRecoveryPlan["targetLayer"];
    targetWorker?: ReplayRecoveryPlan["targetWorker"];
    operatorCaseState?: OperatorCaseState;
    operatorGate?: string;
    operatorAllowedActions?: RecoveryRunAction[];
  }>;
  latestGroups: ReplayTaskSummary[];
}

export interface FlowConsoleReport {
  totalFlows: number;
  statusCounts: Partial<Record<FlowStatus, number>>;
  totalShardGroups: number;
  attentionCount: number;
  attentionStateCounts: Partial<Record<OperatorCaseState, number>>;
  shardStatusCounts: Partial<Record<ShardGroupRecord["status"], number>>;
  groupsWithMissingRoles: number;
  groupsWithRetries: number;
  groupsWithDuplicates: number;
  groupsWithConflicts: number;
  activeRoleCount: number;
  latestFlows: FlowLedger[];
  attentionGroups: Array<{
    flowId: FlowId;
    groupId: string;
    status: ShardGroupRecord["status"];
    caseState: OperatorCaseState;
    reasons: string[];
  }>;
}

export interface ReplayIncidentBundle {
  group: ReplayTaskSummary;
  caseState?: OperatorCaseState;
  caseHeadline?: string;
  browserContinuity?: ReplayBrowserContinuitySummary;
  recovery?: ReplayRecoveryPlan;
  timeline: ReplayTimelineEntry[];
  relatedReplays: ReplayRecord[];
  recoveryDispatches: ReplayRecord[];
  followUpGroups: ReplayTaskSummary[];
  followUpReplays?: ReplayRecord[];
  followUpTimeline: ReplayTimelineEntry[];
  recoveryTimeline?: RecoveryRunTimelineEntry[];
  recoveryProgress?: RecoveryRunProgress;
  recoveryOperator?: {
    caseState: OperatorCaseState;
    currentGate: string;
    allowedActions: RecoveryRunAction[];
    nextAction: RecoveryRun["nextAction"];
    phase: RecoveryRunProgress["phase"];
    phaseSummary: string;
    latestSummary: string;
    latestBrowserOutcome?: RecoveryBrowserOutcome;
  };
  recoveryWorkflow?: {
    status: "not_started" | "running" | "recovered" | "recovery_failed" | "manual_follow_up";
    nextAction: ReplayRecoveryPlan["nextAction"] | "none";
    summary: string;
    latestDispatchReplayId?: string;
    latestFollowUpGroupId?: string;
    latestFailure?: FailureSummary;
  };
  followUpSummary?: {
    totalGroups: number;
    openGroups: number;
    closedGroups: number;
    browserContinuityCounts: Partial<Record<ReplayBrowserContinuitySummary["state"], number>>;
    actionCounts: Partial<Record<ReplayRecoveryHint["action"] | "none", number>>;
  };
  recoveryRun?: RecoveryRun;
}

export type OperatorCaseState = "open" | "recovering" | "waiting_manual" | "blocked" | "resolved";

export interface GovernanceConsoleReport {
  totalPermissionRecords: number;
  attentionCount: number;
  permissionDecisionCounts: Partial<Record<PermissionDecision, number>>;
  permissionScopeCounts: Partial<Record<PermissionScope, number>>;
  requirementLevelCounts: Partial<Record<PermissionRequirementLevel, number>>;
  totalAuditEvents: number;
  transportCounts: Partial<Record<TransportKind | "none", number>>;
  trustCounts: Partial<Record<EvidenceTrustLevel, number>>;
  admissionCounts: Partial<Record<PromptAdmissionMode | "unknown", number>>;
  recommendedActionCounts: Partial<
    Record<NonNullable<PermissionEvaluation["recommendedAction"]> | "unknown", number>
  >;
  latestAudits: TeamEvent[];
}

export interface RecoveryConsoleReport {
  totalRuns: number;
  attentionCount: number;
  statusCounts: Partial<Record<RecoveryRunStatus, number>>;
  phaseCounts: Partial<Record<RecoveryRunProgress["phase"], number>>;
  gateCounts: Record<string, number>;
  nextActionCounts: Partial<Record<RecoveryRun["nextAction"], number>>;
  browserResumeCounts: Partial<Record<BrowserResumeMode, number>>;
  browserOutcomeCounts: Partial<Record<RecoveryBrowserOutcome, number>>;
  latestRuns: RecoveryRun[];
}

export type PromptBoundaryKind = "prompt_compaction" | "request_envelope_reduction";
export type PromptBoundaryReductionLevel = "compact" | "minimal" | "reference-only";

export interface PromptAssemblyContinuityDiagnostics {
  hasThreadSummary: boolean;
  hasSessionMemory: boolean;
  hasRoleScratchpad: boolean;
  hasContinuationContext: boolean;
  carriesPendingWork: boolean;
  carriesWaitingOn: boolean;
  carriesOpenQuestions: boolean;
  carriesDecisionOrConstraint: boolean;
}

export interface PromptAssemblyRecentTurnsDiagnostics {
  availableCount: number;
  selectedCount: number;
  packedCount: number;
  salientEarlierCount: number;
  compacted: boolean;
}

export interface PromptAssemblyRetrievedMemoryDiagnostics {
  availableCount: number;
  selectedCount: number;
  packedCount: number;
  compacted: boolean;
  userPreferenceCount: number;
  threadMemoryCount: number;
  sessionMemoryCount: number;
  knowledgeNoteCount: number;
  journalNoteCount: number;
}

export interface PromptAssemblyWorkerEvidenceDiagnostics {
  totalCount: number;
  admittedCount: number;
  selectedCount: number;
  packedCount: number;
  compacted: boolean;
  promotableCount: number;
  observationalCount: number;
  fullCount: number;
  summaryOnlyCount: number;
  continuationRelevantCount: number;
}

export interface PromptAssemblyContextDiagnostics {
  continuity: PromptAssemblyContinuityDiagnostics;
  recentTurns: PromptAssemblyRecentTurnsDiagnostics;
  retrievedMemory: PromptAssemblyRetrievedMemoryDiagnostics;
  workerEvidence: PromptAssemblyWorkerEvidenceDiagnostics;
}

export interface PromptBoundaryEntry {
  progressId: string;
  recordedAt: number;
  summary: string;
  threadId: ThreadId;
  roleId?: RoleId;
  flowId?: FlowId;
  taskId?: TaskId;
  chainId?: string;
  spanId?: string;
  boundaryKind: PromptBoundaryKind;
  modelId?: string;
  modelChainId?: string;
  assemblyFingerprint?: string;
  sectionOrder?: string[];
  compactedSegments?: string[];
  omittedSections?: string[];
  usedArtifacts?: string[];
  reductionLevel?: PromptBoundaryReductionLevel;
  tokenEstimate?: {
    inputTokens: number;
    outputTokensReserved: number;
    totalProjectedTokens: number;
    overBudget: boolean;
  };
  contextDiagnostics?: PromptAssemblyContextDiagnostics;
  envelopeHint?: {
    toolResultCount?: number;
    toolResultBytes?: number;
    inlineAttachmentBytes?: number;
    inlineImageCount?: number;
    inlineImageBytes?: number;
    inlinePdfCount?: number;
    inlinePdfBytes?: number;
    multimodalPartCount?: number;
  };
}

export interface PromptConsoleReport {
  totalBoundaries: number;
  compactionCount: number;
  reductionCount: number;
  boundaryKindCounts: Partial<Record<PromptBoundaryKind, number>>;
  reductionLevelCounts: Partial<Record<PromptBoundaryReductionLevel, number>>;
  modelCounts: Record<string, number>;
  modelChainCounts: Record<string, number>;
  roleCounts: Record<string, number>;
  compactedSegmentCounts: Record<string, number>;
  uniqueAssemblyFingerprintCount: number;
  totalRecentTurnsSelected: number;
  totalRecentTurnsPacked: number;
  totalRetrievedMemoryCandidates: number;
  totalRetrievedMemoryPacked: number;
  totalWorkerEvidenceCandidates: number;
  totalWorkerEvidencePacked: number;
  continuityCarryForwardCounts: {
    continuationContext: number;
    pendingWork: number;
    waitingOn: number;
    openQuestions: number;
    decisionsOrConstraints: number;
  };
  latestBoundaries: PromptBoundaryEntry[];
}

export type ValidationOpsRunType = "release-readiness" | "validation-profile" | "soak-series" | "transport-soak";
export type ValidationOpsIssueKind = "validation-item" | "release-check" | "soak-suite" | "transport-target";
export type ValidationOpsIssueSeverity = "warning" | "critical";
export type ValidationOpsFailureBucket =
  | "browser"
  | "recovery"
  | "context"
  | "parallel"
  | "governance"
  | "runtime"
  | "operator"
  | "release"
  | "soak"
  | "transport"
  | "validation";
export type ValidationOpsRecommendedAction =
  | "inspect"
  | "rerun-release"
  | "rerun-profile"
  | "rerun-soak"
  | "rerun-transport-soak";

export interface ValidationOpsIssueRecord {
  issueId: string;
  kind: ValidationOpsIssueKind;
  scope: string;
  summary: string;
  bucket: ValidationOpsFailureBucket;
  severity: ValidationOpsIssueSeverity;
  recommendedAction: ValidationOpsRecommendedAction;
  commandHint: string;
}

export interface ValidationOpsRunRecord {
  runId: string;
  runType: ValidationOpsRunType;
  title: string;
  status: "passed" | "failed";
  startedAt: number;
  completedAt: number;
  durationMs: number;
  issueCount: number;
  profileId?: string;
  selectors?: string[];
  cycles?: number;
  targets?: string[];
  artifactPath?: string;
  issues: ValidationOpsIssueRecord[];
}

export interface ValidationOpsReport {
  totalRuns: number;
  failedRuns: number;
  passedRuns: number;
  attentionCount: number;
  runTypeCounts: Partial<Record<ValidationOpsRunType, number>>;
  bucketCounts: Partial<Record<ValidationOpsFailureBucket, number>>;
  severityCounts: Partial<Record<ValidationOpsIssueSeverity, number>>;
  recommendedActionCounts: Partial<Record<ValidationOpsRecommendedAction, number>>;
  latestRuns: ValidationOpsRunRecord[];
  activeIssues: Array<
    ValidationOpsIssueRecord & {
      runId: string;
      runType: ValidationOpsRunType;
      title: string;
      recordedAt: number;
    }
  >;
}

export interface OperatorSummaryReport {
  flow: FlowConsoleReport;
  replay: ReplayConsoleReport;
  governance: GovernanceConsoleReport;
  recovery: RecoveryConsoleReport;
  prompt: PromptConsoleReport;
  workerStartupReconcile?: RuntimeSummaryReport["workerStartupReconcile"];
  workerSessionHealth?: RuntimeSummaryReport["workerSessionHealth"];
  workerBindingReconcile?: RuntimeSummaryReport["workerBindingReconcile"];
  roleRunStartupRecovery?: RuntimeSummaryReport["roleRunStartupRecovery"];
  flowRecoveryStartupReconcile?: RuntimeSummaryReport["flowRecoveryStartupReconcile"];
  runtimeChainStartupReconcile?: RuntimeSummaryReport["runtimeChainStartupReconcile"];
  runtimeChainArtifactStartupReconcile?: RuntimeSummaryReport["runtimeChainArtifactStartupReconcile"];
  promptAttentionCount: number;
  totalAttentionCount: number;
  attentionOverview?: {
    uniqueCaseCount: number;
    caseStateCounts: Partial<Record<OperatorCaseState, number>>;
    severityCounts: Partial<Record<OperatorAttentionItem["severity"], number>>;
    lifecycleCounts: Partial<Record<OperatorAttentionItem["lifecycle"], number>>;
    activeCases?: Array<{
      caseKey: string;
      headline: string;
      caseState: OperatorCaseState;
      severity: OperatorAttentionItem["severity"];
      lifecycle: OperatorAttentionItem["lifecycle"];
      gate?: string;
      action?: string;
      allowedActions?: RecoveryRunAction[];
      browserContinuityState?: ReplayBrowserContinuitySummary["state"];
      browserTransportLabel?: string;
      browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
      relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
      reasonPreview?: string;
      latestUpdate: string;
      nextStep: string;
    }>;
    resolvedRecentCases?: Array<{
      caseKey: string;
      headline: string;
      caseState: "resolved";
      source: "replay";
      gate?: string;
      action?: string;
      browserContinuityState?: ReplayBrowserContinuitySummary["state"];
      browserTransportLabel?: string;
      browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
      relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
      reasonPreview?: string;
      latestUpdate: string;
      nextStep: string;
    }>;
    topCases?: Array<{
      caseKey: string;
      headline: string;
      caseState: OperatorCaseState;
      severity: OperatorAttentionItem["severity"];
      lifecycle: OperatorAttentionItem["lifecycle"];
      gate?: string;
      action?: string;
      browserContinuityState?: ReplayBrowserContinuitySummary["state"];
      browserTransportLabel?: string;
      browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
      relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
      reasonPreview?: string;
      latestUpdate: string;
      nextStep: string;
    }>;
  };
}

export interface OperatorTriageFocusArea {
  area: "case" | "runtime" | "prompt";
  label: string;
  severity: "warning" | "critical";
  headline: string;
  reason: string;
  nextStep: string;
  commandHint: string;
  caseKey?: string;
  source?: OperatorAttentionItem["source"];
  state?: string;
  gate?: string;
  browserContinuityState?: ReplayBrowserContinuitySummary["state"];
  browserTransportLabel?: string;
  browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
  relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
}

export interface OperatorTriageReport {
  totalAttentionCount: number;
  uniqueCaseCount: number;
  blockedCaseCount: number;
  waitingManualCaseCount: number;
  recoveringCaseCount: number;
  runtimeWaitingCount: number;
  runtimeStaleCount: number;
  runtimeFailedCount: number;
  workerSessionOrphanCount: number;
  workerSessionMissingContextCount: number;
  promptReductionCount: number;
  promptAttentionCount: number;
  recommendedEntryPoint?: string;
  focusAreas: OperatorTriageFocusArea[];
}

export interface OperatorAttentionItem {
  source: "flow" | "replay" | "governance" | "recovery" | "prompt";
  key: string;
  caseKey: string;
  headline: string;
  recordedAt: number;
  severity: "warning" | "critical";
  lifecycle: "open" | "recovering" | "waiting_manual" | "blocked";
  status: string;
  summary: string;
  gate?: string;
  reasons?: string[];
  browserContinuityState?: ReplayBrowserContinuitySummary["state"];
  browserTransportLabel?: string;
  browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
  relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
  action?: string;
  allowedActions?: RecoveryRunAction[];
}

export interface OperatorAttentionCaseSummary {
  caseKey: string;
  headline: string;
  caseState: OperatorCaseState;
  severity: OperatorAttentionItem["severity"];
  lifecycle: OperatorAttentionItem["lifecycle"];
  latestUpdate: string;
  nextStep: string;
  latestRecordedAt: number;
  itemCount: number;
  sources: OperatorAttentionItem["source"][];
  gate?: string;
  action?: string;
  allowedActions?: RecoveryRunAction[];
  browserContinuityState?: ReplayBrowserContinuitySummary["state"];
  browserTransportLabel?: string;
  browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
  relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
  reasons?: string[];
}

export interface OperatorAttentionReport {
  totalItems: number;
  returnedItems: number;
  uniqueCaseCount: number;
  sourceCounts: Partial<Record<OperatorAttentionItem["source"], number>>;
  caseStateCounts: Partial<Record<OperatorCaseState, number>>;
  severityCounts: Partial<Record<OperatorAttentionItem["severity"], number>>;
  lifecycleCounts: Partial<Record<OperatorAttentionItem["lifecycle"], number>>;
  returnedCases: number;
  cases: OperatorAttentionCaseSummary[];
  items: OperatorAttentionItem[];
}

export type RecoveryRunStatus =
  | "planned"
  | "running"
  | "waiting_approval"
  | "waiting_external"
  | "retrying"
  | "fallback_running"
  | "resumed"
  | "superseded"
  | "recovered"
  | "failed"
  | "aborted";

export type RecoveryRunAction = "dispatch" | "retry" | "fallback" | "resume" | "approve" | "reject";

export type RecoveryTransitionReason =
  | "manual_dispatch"
  | "manual_retry"
  | "manual_fallback"
  | "manual_resume"
  | "manual_approval"
  | "manual_reject";

export type RecoveryBrowserOutcome =
  | "hot_reuse"
  | "warm_attach"
  | "cold_reopen"
  | "detached_target_recovered"
  | "resume_failed";

export interface RecoveryRunAttempt {
  attemptId: string;
  action: RecoveryRunAction;
  requestedAt: number;
  updatedAt: number;
  status: RecoveryRunStatus;
  nextAction: ReplayRecoveryPlan["nextAction"] | "none";
  summary: string;
  targetLayer?: ReplayLayer;
  targetWorker?: WorkerKind;
  dispatchReplayId?: string;
  dispatchedTaskId?: TaskId;
  resultingGroupId?: string;
  browserSession?: BrowserContinuationHint;
  browserOutcome?: RecoveryBrowserOutcome;
  browserOutcomeSummary?: string;
  failure?: FailureSummary;
  triggeredByAttemptId?: string;
  transitionReason?: RecoveryTransitionReason;
  supersededByAttemptId?: string;
  supersededAt?: number;
  completedAt?: number;
}

export type RecoveryRunEventKind =
  | "action_requested"
  | "action_dispatched"
  | "action_superseded"
  | "action_failed"
  | "waiting_approval"
  | "waiting_external"
  | "follow_up_observed"
  | "recovered"
  | "aborted";

export interface RecoveryRunEvent {
  eventId: string;
  recoveryRunId: string;
  threadId: ThreadId;
  sourceGroupId: string;
  kind: RecoveryRunEventKind;
  status: RecoveryRunStatus;
  recordedAt: number;
  summary: string;
  action?: RecoveryRunAction;
  attemptId?: string;
  triggeredByAttemptId?: string;
  transitionReason?: RecoveryTransitionReason;
  dispatchReplayId?: string;
  taskId?: TaskId;
  resultingGroupId?: string;
  browserSession?: BrowserContinuationHint;
  browserOutcome?: RecoveryBrowserOutcome;
  failure?: FailureSummary;
}

export interface RecoveryRunTimelineEntry {
  entryId: string;
  source: "event" | "replay";
  recordedAt: number;
  kind: string;
  summary: string;
  status?: RecoveryRunStatus | ReplayStatus;
  action?: RecoveryRunAction;
  attemptId?: string;
  triggeredByAttemptId?: string;
  transitionReason?: RecoveryTransitionReason;
  replayId?: string;
  groupId?: string;
  layer?: ReplayLayer;
  browserOutcome?: RecoveryBrowserOutcome;
  failure?: FailureSummary;
}

export interface RecoveryRun {
  recoveryRunId: string;
  threadId: ThreadId;
  sourceGroupId: string;
  taskId?: TaskId;
  flowId?: FlowId;
  roleId?: RoleId;
  targetLayer?: ReplayLayer;
  targetWorker?: WorkerKind;
  latestStatus: ReplayStatus;
  status: RecoveryRunStatus;
  nextAction: ReplayRecoveryPlan["nextAction"] | "none";
  autoDispatchReady: boolean;
  requiresManualIntervention: boolean;
  latestSummary: string;
  waitingReason?: string;
  latestFailure?: FailureSummary;
  currentAttemptId?: string;
  browserSession?: BrowserContinuationHint;
  attempts: RecoveryRunAttempt[];
  version?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RecoveryRunProgress {
  phase:
    | "planned"
    | "awaiting_approval"
    | "awaiting_external"
    | "retrying_same_layer"
    | "running_fallback"
    | "resuming_session"
    | "running_dispatch"
    | "recovered"
    | "failed"
    | "aborted";
  phaseSummary: string;
  totalAttempts: number;
  settledAttempts: number;
  supersededAttempts: number;
  recoveredAttempts: number;
  failedAttempts: number;
  waitingAttempts: number;
  activeAttemptId?: string;
  activeAction?: RecoveryRunAction;
  activeStatus?: RecoveryRunStatus;
  lastSettledAttemptId?: string;
  lastSettledStatus?: RecoveryRunStatus;
}

export interface RecoveryRunStore {
  get(recoveryRunId: string): Promise<RecoveryRun | null>;
  put(run: RecoveryRun, options?: { expectedVersion?: number | undefined }): Promise<void>;
  listByThread(threadId: ThreadId): Promise<RecoveryRun[]>;
  listAll?(): Promise<RecoveryRun[]>;
}

export interface RecoveryRunEventStore {
  append(event: RecoveryRunEvent): Promise<void>;
  listByRecoveryRun(recoveryRunId: string): Promise<RecoveryRunEvent[]>;
}

export interface ValidationOpsRunStore {
  put(record: ValidationOpsRunRecord): Promise<void>;
  list(limit?: number): Promise<ValidationOpsRunRecord[]>;
}
