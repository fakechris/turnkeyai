export type ValidationOpsRunType =
  | "release-readiness"
  | "validation-profile"
  | "soak-series"
  | "transport-soak"
  | "phase1-baseline"
  | "real-llm-acceptance";
export type ValidationOpsIssueKind =
  | "validation-item"
  | "release-check"
  | "soak-suite"
  | "transport-target"
  | "baseline-run"
  | "real-llm-gate";
export type ValidationOpsIssueSeverity = "warning" | "critical";
export type ValidationOpsFailureBucket =
  | "browser"
  | "recovery"
  | "context"
  | "parallel"
  | "governance"
  | "runtime"
  | "operator"
  | "llm"
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
  | "rerun-baseline"
  | "rerun-real-acceptance";
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
  nextCommand: string;
  finalReadinessStatus: "passed" | "failed" | "missing";
  finalClosedLoopStatus: ValidationOpsClosedLoopStatus;
  finalClosedLoopRate: number;
  finalClosedLoopCases: number;
  finalTotalCases: number;
  silentFailureCases: number;
  ambiguousFailureCases: number;
  failureReasons: string[];
}

export type ValidationOpsRealAcceptanceCoverageStatus = "full" | "focused" | "skipped";

export interface ValidationOpsRealAcceptanceCoverage {
  status: ValidationOpsRealAcceptanceCoverageStatus;
  requested: number;
  expected: number;
  missing: number;
}

export interface ValidationOpsRealAcceptanceReleaseCoverage {
  status: ValidationOpsRealAcceptanceCoverageStatus;
  tooluse: ValidationOpsRealAcceptanceCoverage;
  mission: ValidationOpsRealAcceptanceCoverage;
  naturalMission: ValidationOpsRealAcceptanceCoverage;
}

export interface ValidationOpsRealAcceptanceDetails {
  tooluseScenarios: string[];
  missionScenarios: string[];
  naturalMissionScenarios?: string[];
  browserTooluseEnabled: boolean;
  totalCases: number;
  releaseCoverage?: ValidationOpsRealAcceptanceReleaseCoverage;
  tooluseArtifactPath?: string;
  naturalArtifactPath?: string;
  tooluseReport?: {
    status: "passed" | "failed";
    scenarioCount: number;
    scenarioIds?: string[];
    passedScenarios: number;
    failedScenarios: number;
    qualityFailures: number;
    finalBytes: number;
    evidenceBullets: number;
    toolCalls: number;
    sessionsSpawned: number;
    childTranscriptMessages: number;
    permissionEvents: number;
    scenarioProofs?: Array<{
      scenario: string;
      passed: boolean;
      finalBytes: number;
      evidenceBullets: number;
      qualityFailures: number;
      toolCallNames: string[];
      sessionsSpawned: number;
      childTranscriptMessages: number;
      permissionEvents: number;
    }>;
  };
  missionReport?: {
    status: "passed" | "failed";
    scenarioCount: number;
    scenarioIds?: string[];
    passedScenarios: number;
    failedScenarios: number;
    qualityFailures: number;
    toolRequested: number;
    toolResults: number;
    toolFailed: number;
    toolCancelled: number;
    toolTimeouts: number;
    sessionsSpawned: number;
    sessionsContinued: number;
    browserProfileFallbacks: number;
    browserFailureBuckets: number;
    approvalsRequested: number;
    approvalsDecided: number;
    approvalsApplied: number;
    livenessActive: number;
    livenessWaiting: number;
    livenessStale: number;
    qualityCheckWarnings: number;
    qualityCheckFailures: number;
    sourceCoverageWarnings: number;
    sourceCoverageFailures: number;
    evidenceEvents: number;
    recoveryEvents: number;
    scenarioProofs?: Array<{
      scenario: string;
      passed: boolean;
      qualityFailures: number;
      toolRequested: number;
      toolResults: number;
      toolFailed: number;
      toolCancelled: number;
      toolTimeouts: number;
      sessionsSpawned: number;
      sessionsContinued: number;
      browserProfileFallbacks: number;
      browserFailureBuckets: number;
      approvalsRequested: number;
      approvalsDecided: number;
      approvalsApplied: number;
      livenessActive: number;
      livenessWaiting: number;
      livenessStale: number;
      qualityCheckFailures: number;
      sourceCoverageFailures: number;
      evidenceEvents: number;
      recoveryEvents: number;
    }>;
  };
  naturalMissionReport?: {
    status: "passed" | "failed";
    progressClaim?: string;
    capabilityClaim?: string;
    scenarioCount: number;
    scenarioIds?: string[];
    passedScenarios: number;
    failedScenarios: number;
    completed: number;
    stuckOrLoop: number;
    reasonableToolUse: number;
    browserUsed: number;
    subAgentCompleted: number;
    approvalExercised: number;
    finalAnswerHasEvidence: number;
    finalAnswerUseful: number;
    weakAnswerSignals: number;
    toolRequested: number;
    toolResults: number;
    toolFailed: number;
    toolCancelled: number;
    toolTimeouts: number;
    sessionsSpawned: number;
    sessionsContinued: number;
    browserProfileFallbacks: number;
    browserFailureBuckets: number;
    approvalsRequested: number;
    approvalsDecided: number;
    approvalsApplied: number;
    livenessActive: number;
    livenessWaiting: number;
    livenessStale: number;
    evidenceEvents: number;
    sourceAnswerTermsCovered: number;
    sourceAnswerTermsTotal: number;
    sourceAnswerTermsMissing: number;
    sourceAnswerPatternsCovered: number;
    sourceAnswerPatternsTotal: number;
    sourceAnswerPatternsMissing: number;
    sourceEvidencePatternsCovered: number;
    sourceEvidencePatternsTotal: number;
    sourceEvidencePatternsMissing: number;
    sourceEvidenceEventsObserved: number;
    sourceEvidenceEventsRequired: number;
    sourceResidualRiskVisible: number;
    sourceUnsupportedClaims: number;
    recoveryEvents: number;
    dimensionScoreTotal?: number;
    dimensionScoreMax?: number;
    lowDimensionScores?: number;
    failureBuckets?: string[];
    scenarioProofs?: Array<{
      scenario: string;
      passed: boolean;
      completed: boolean;
      stuckOrLoop: boolean;
      reasonableToolUse: boolean;
      browserUsed: boolean;
      subAgentCompleted: boolean;
      approvalExercised: boolean;
      finalAnswerHasEvidence: boolean;
      finalAnswerUseful: boolean;
      weakAnswerSignals: number;
      toolFailed: number;
      toolCancelled: number;
      toolTimeouts: number;
      sessionsSpawned: number;
      sessionsContinued: number;
      browserProfileFallbacks: number;
      browserFailureBuckets: number;
      approvalsRequested: number;
      approvalsDecided: number;
      approvalsApplied: number;
      livenessActive: number;
      livenessWaiting: number;
      livenessStale: number;
      evidenceEvents: number;
      recoveryEvents: number;
      sourceResidualRiskVisible: boolean;
      sourceUnsupportedClaims: number;
      sourceAnswerTermsMissing: number;
      sourceAnswerPatternsMissing: number;
      sourceEvidencePatternsMissing: number;
      dimensionScores?: {
        taskCompletion: number;
        evidenceQuality: number;
        toolUseAppropriateness: number;
        browserAuthenticity: number;
        subAgentIndependence: number;
        continuationBehavior: number;
        permissionCorrectness: number;
        timeoutCloseoutQuality: number;
      };
      failureBuckets?: string[];
    }>;
  };
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
  realAcceptance?: ValidationOpsRealAcceptanceDetails;
}

export type ValidationOpsReadinessGateId =
  | "phase1-e2e-profile"
  | "real-llm-acceptance"
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
