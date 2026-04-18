import type {
  RuntimeSummaryReport,
  TeamEvent,
} from "./team-core";
import type {
  EvidenceTrustLevel,
  PermissionDecision,
  PermissionEvaluation,
  PermissionRequirementLevel,
  PermissionScope,
  PromptAdmissionMode,
  TransportKind,
} from "./team-governance";
import type { TruthAlignment, TruthRemediation, TruthSource } from "./team-truth";
import type { PromptConsoleReport } from "./team-prompt-types";
import type {
  FlowConsoleReport,
  OperatorCaseState,
  OperatorSummaryRuntimeHealth,
  ReplayBrowserContinuitySummary,
  ReplayConsoleReport,
} from "./team-replay-types";
import type {
  RecoveryBrowserOutcome,
  RecoveryConsoleReport,
  RecoveryRun,
  RecoveryRunAction,
} from "./team-recovery-types";

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

export interface OperatorSummaryReport extends OperatorSummaryRuntimeHealth {
  flow: FlowConsoleReport;
  replay: ReplayConsoleReport;
  governance: GovernanceConsoleReport;
  recovery: RecoveryConsoleReport;
  prompt: PromptConsoleReport;
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
  truthState?: TruthAlignment["truthState"];
  truthSource?: TruthSource;
  remediation?: TruthRemediation[];
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
  truthState?: TruthAlignment["truthState"];
  truthSource?: TruthSource;
  remediation?: TruthRemediation[];
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
