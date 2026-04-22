import type { FlowId, RoleId, TaskId, ThreadId } from "./team-core";

export type PromptBoundaryKind = "prompt_compaction" | "request_envelope_reduction";
export type PromptBoundaryReductionLevel = "compact" | "minimal" | "reference-only";
export type PromptContextRiskSignal =
  | "missing_continuation_context"
  | "missing_pending_work"
  | "missing_waiting_on"
  | "missing_open_questions"
  | "missing_decision_or_constraint"
  | "recent_turn_pressure"
  | "retrieved_memory_pressure"
  | "worker_evidence_pressure"
  | "continuation_relevant_evidence_pressure"
  | "observational_evidence_pressure";

export interface PromptAssemblyContinuityDiagnostics {
  hasThreadSummary: boolean;
  hasSessionMemory: boolean;
  hasRoleScratchpad: boolean;
  hasContinuationContext: boolean;
  carriesPendingWork: boolean;
  carriesWaitingOn: boolean;
  carriesOpenQuestions: boolean;
  carriesDecisionOrConstraint: boolean;
  sourceHasContinuationContext?: boolean;
  sourceHasPendingWork?: boolean;
  sourceHasWaitingOn?: boolean;
  sourceHasOpenQuestions?: boolean;
  sourceHasDecisionOrConstraint?: boolean;
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
  contextRiskSignals?: PromptContextRiskSignal[];
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
  contextRiskCounts: Partial<Record<PromptContextRiskSignal, number>>;
  latestBoundaries: PromptBoundaryEntry[];
}
