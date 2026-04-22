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
export type ValidationOpsClosedLoopStatus =
  | "completed"
  | "actionable"
  | "silent_failure"
  | "ambiguous_failure";

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

export interface ValidationOpsRunStore {
  put(record: ValidationOpsRunRecord): Promise<void>;
  list(limit?: number): Promise<ValidationOpsRunRecord[]>;
}
