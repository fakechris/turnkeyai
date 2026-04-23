export type ValidationOpsRunType =
  | "release-readiness"
  | "validation-profile"
  | "soak-series"
  | "transport-soak"
  | "phase1-baseline";
export type ValidationOpsIssueKind =
  | "validation-item"
  | "release-check"
  | "soak-suite"
  | "transport-target"
  | "baseline-run";
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
  | "validation"
  | "baseline";
export type ValidationOpsRecommendedAction =
  | "inspect"
  | "rerun-release"
  | "rerun-profile"
  | "rerun-soak"
  | "rerun-transport-soak"
  | "rerun-baseline";
export type ValidationOpsClosedLoopStatus =
  | "completed"
  | "actionable"
  | "silent_failure"
  | "ambiguous_failure";
export type ValidationOpsBaselineStatus = "fresh-passing" | "fresh-failing" | "stale" | "missing";

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

export interface ValidationOpsClosedLoopMetric {
  closedLoopStatus: ValidationOpsClosedLoopStatus;
  totalCases: number;
  completedCases: number;
  actionableCases: number;
  silentFailureCases: number;
  ambiguousFailureCases: number;
  closedLoopCases: number;
  closedLoopRate: number;
  rerunCommand: string;
  timeToActionableMs?: number;
  manualGateReason?: string;
  failureBucket?: ValidationOpsFailureBucket;
}

export interface ValidationOpsClosedLoopReport extends ValidationOpsClosedLoopMetric {
  measuredRuns: number;
  statusCounts: Partial<Record<ValidationOpsClosedLoopStatus, number>>;
  nextCommand: string;
  latestRunId?: string;
}

export interface ValidationOpsBaselineRunDetails {
  requiredRuns: number;
  consecutivePassedRuns: number;
  transportCycles: number;
  soakCycles: number;
  releaseSkipBuild: boolean;
  finalReadinessStatus: "passed" | "failed" | "missing";
  finalClosedLoopStatus: ValidationOpsClosedLoopStatus;
  finalClosedLoopRate: number;
  finalClosedLoopCases: number;
  finalTotalCases: number;
  silentFailureCases: number;
  ambiguousFailureCases: number;
  failureReasons: string[];
}

export interface ValidationOpsBaselineReport {
  status: ValidationOpsBaselineStatus;
  summary: string;
  nextCommand: string;
  staleAfterMs: number;
  latestRunId?: string;
  recordedAt?: number;
  ageMs?: number;
  requiredRuns?: number;
  consecutivePassedRuns?: number;
  transportCycles?: number;
  soakCycles?: number;
  releaseSkipBuild?: boolean;
  finalReadinessStatus?: "passed" | "failed" | "missing";
  finalClosedLoopStatus?: ValidationOpsClosedLoopStatus;
  finalClosedLoopRate?: number;
  finalClosedLoopCases?: number;
  finalTotalCases?: number;
  silentFailureCases?: number;
  ambiguousFailureCases?: number;
  failureReasons?: string[];
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
  closedLoop?: ValidationOpsClosedLoopMetric;
  baseline?: ValidationOpsBaselineRunDetails;
}

export type ValidationOpsReadinessGateId =
  | "phase1-e2e-profile"
  | "release-readiness"
  | "transport-soak"
  | "soak-series";

export interface ValidationOpsReadinessGate {
  gateId: ValidationOpsReadinessGateId;
  title: string;
  status: "passed" | "failed" | "missing";
  summary: string;
  commandHint: string;
  latestRunId?: string;
  recordedAt?: number;
}

export interface ValidationOpsReadinessReport {
  status: "passed" | "failed" | "missing";
  summary: string;
  passedGates: number;
  failedGates: number;
  missingGates: number;
  nextCommand: string;
  gates: ValidationOpsReadinessGate[];
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
  readiness: ValidationOpsReadinessReport;
  closedLoop: ValidationOpsClosedLoopReport;
  baseline: ValidationOpsBaselineReport;
}

export type Phase1ReadinessRunStageId =
  | "validation-profile"
  | "transport-soak"
  | "release-readiness"
  | "soak-series";

export interface Phase1ReadinessRunStage {
  stageId: Phase1ReadinessRunStageId;
  title: string;
  status: "passed" | "failed";
  runId: string;
  durationMs: number;
  summary: string;
  commandHint: string;
  artifactPath?: string;
}

export interface Phase1ReadinessRunResult {
  status: "passed" | "failed";
  startedAt: number;
  completedAt: number;
  durationMs: number;
  totalStages: number;
  passedStages: number;
  failedStages: number;
  nextCommand: string;
  stages: Phase1ReadinessRunStage[];
  validationOps: ValidationOpsReport;
  northStar: ValidationOpsClosedLoopReport;
}

export interface Phase1BaselineRunSummary {
  runNumber: number;
  status: "passed" | "failed";
  durationMs: number;
  failedStages: number;
  nextCommand: string;
  readinessStatus: ValidationOpsReadinessReport["status"];
  northStarStatus: ValidationOpsClosedLoopReport["closedLoopStatus"];
  closedLoopCases: number;
  totalCases: number;
  closedLoopRate: number;
  silentFailureCases: number;
  ambiguousFailureCases: number;
  stages: Array<{
    stageId: Phase1ReadinessRunStageId;
    status: "passed" | "failed";
    summary: string;
    commandHint: string;
    artifactPath?: string;
  }>;
}

export interface Phase1BaselineRunResult {
  status: "passed" | "failed";
  startedAt: number;
  completedAt: number;
  durationMs: number;
  requiredRuns: number;
  consecutivePassedRuns: number;
  transportCycles: number;
  soakCycles: number;
  releaseSkipBuild: boolean;
  nextCommand: string;
  runs: Phase1BaselineRunSummary[];
  failureReasons: string[];
  validationOps: ValidationOpsReport;
  northStar: ValidationOpsClosedLoopReport;
  baseline: ValidationOpsBaselineReport;
}

export interface ValidationOpsRunStore {
  put(record: ValidationOpsRunRecord): Promise<void>;
  list(limit?: number): Promise<ValidationOpsRunRecord[]>;
}
