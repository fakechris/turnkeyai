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
}

export interface ValidationOpsRunStore {
  put(record: ValidationOpsRunRecord): Promise<void>;
  list(limit?: number): Promise<ValidationOpsRunRecord[]>;
}
