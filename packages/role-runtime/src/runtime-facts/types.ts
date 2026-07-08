import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RoleToolExecutionResult } from "../tool-use";

export type RuntimeFactKind =
  | "task_intent"
  | "session_evidence"
  | "permission_evidence"
  | "browser_evidence"
  | "usable_evidence";

export type EvidenceEnvelopeSource =
  | "task_prompt"
  | "activation"
  | "message"
  | "native_tool_trace"
  | "tool_result"
  | "tool_progress"
  | "legacy_trace_importer";

export interface EvidenceProvenance {
  source: EvidenceEnvelopeSource;
  toolName: string | null;
  toolCallId: string | null;
  roundIndex: number | null;
  traceIndex: number | null;
  messageIndex: number | null;
}

export interface EvidenceEnvelope<TKind extends RuntimeFactKind, TFacts> {
  kind: TKind;
  schemaVersion: 1;
  facts: TFacts;
  provenance: EvidenceProvenance[];
}

export interface RuntimeFactInput {
  taskPrompt: string;
  activation?: RoleActivationInput | undefined;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}

export interface RuntimeRoundFactInput {
  results: RoleToolExecutionResult[];
}

export interface TaskIntentFacts {
  requestedTableColumns: string[];
  providerSupportSchemaRequested: boolean;
  browserVisibleEvidenceRequired: boolean;
  productSignalDashboardEvidenceRequested: boolean;
  timeoutRecoveryRequested: boolean;
  sourceCheckContinuationRequested: boolean;
  awaitingContextSetupOnly: boolean;
  requiredIndependentEvidenceStreams: number;
  permissionToolsAllowed: boolean;
  approvalAlreadyApplied: boolean;
  approvalGatedBrowserActionRequested: boolean;
  approvedBrowserActionExecutionForbidden: boolean;
  approvalWaitTimeoutCloseoutRequested: boolean;
  stopAtPendingApprovalAllowed: boolean;
  appliedApprovalBrowserContinuation: boolean;
  coverageCriticalDelegation: boolean;
  providerSearchPricingResearch: boolean;
  explicitSessionContinuationRequested: boolean;
  exactFinalAnswerShapeExpected: boolean;
}

export interface CompletedSessionFact {
  toolName: string | null;
  sessionKey: string | null;
  agentId: string | null;
  finalContents: string[];
  streamLabel: string | null;
  browserRecoverySummary: string | null;
  browserRecoverySummaries: string[];
}

export interface TimeoutSignalFact {
  toolName: string | null;
  sessionKey: string | null;
  agentId: string | null;
  seconds: number | null;
  resumable: boolean;
  evidenceAvailable: boolean;
}

export interface SessionEvidenceFacts {
  completedSession: CompletedSessionFact | null;
  completedSessions: CompletedSessionFact[];
  completedSessionFinalContents: string[] | null;
  completedStreamLabels: string[];
  timeoutSignal: TimeoutSignalFact | null;
  timeoutSignals: TimeoutSignalFact[];
  resumableTimeouts: TimeoutSignalFact[];
}

export type PermissionStatus =
  | "none"
  | "pending"
  | "applied"
  | "denied"
  | "wait_timeout";

export interface PermissionEvidenceFacts {
  latestStatus: PermissionStatus;
  latestToolName: string | null;
  latestResultStatus: string | null;
  pendingApproval: boolean;
  appliedApproval: boolean;
  deniedApproval: boolean;
  waitTimeout: boolean;
}

export type BrowserEvidenceEventKind =
  | "rendered_page"
  | "browser_snapshot"
  | "browser_recovery"
  | "product_signal_dashboard";

export type BrowserFailureBucket =
  | "browser_timeout"
  | "browser_navigation_failed"
  | "browser_runtime_error"
  | "browser_missing_rendered_content"
  | "unknown_browser_failure";

export interface BrowserEvidenceEvent {
  kind: BrowserEvidenceEventKind;
  toolName: string | null;
  toolCallId: string | null;
  url: string | null;
  title: string | null;
}

export interface BrowserEvidenceFacts {
  events: BrowserEvidenceEvent[];
  browserVisibleEvidenceEvents: BrowserEvidenceEvent[];
  productSignalDashboardEvidenceEvents: BrowserEvidenceEvent[];
  failureBuckets: BrowserFailureBucket[];
  missingBrowserVisibleEvidence: boolean;
  missingProductSignalDashboardEvidence: boolean;
  missingBrowserEvidenceDimensions: boolean;
}

export interface UsableEvidenceFacts {
  usableEvidence: boolean;
}

export interface RuntimePolicySnapshot {
  taskIntent: TaskIntentFacts;
  session: SessionEvidenceFacts;
  permission: PermissionEvidenceFacts;
  browser: BrowserEvidenceFacts;
  usable: UsableEvidenceFacts;
}

export interface FinalSynthesisTextViews {
  sourceBoundedEvidenceText: string;
  completedSessionEvidenceText: string;
  naturalFinishEvidenceText: string;
  toolTraceResultContent: string;
  approvalWaitTimeoutRuntimeEvidence: string;
  toolResultContentText: string;
}

export interface RuntimeFactBundle {
  envelopes: readonly EvidenceEnvelope<RuntimeFactKind, unknown>[];
  policy: RuntimePolicySnapshot;
  finalText: FinalSynthesisTextViews;
}

export interface RuntimeRoundPolicySnapshot {
  session: SessionEvidenceFacts;
  permission: PermissionEvidenceFacts;
  usable: UsableEvidenceFacts;
}

export interface RuntimeRoundFinalTextViews {
  toolResultContentText: string;
}

export interface RuntimeRoundFactBundle {
  envelopes: readonly EvidenceEnvelope<RuntimeFactKind, unknown>[];
  policy: RuntimeRoundPolicySnapshot;
  finalText: RuntimeRoundFinalTextViews;
}
