// Stage 8 engine cleanup — CloseoutPolicyRegistry (module shell).
//
// Authority: own terminal closeout decisions and their precedence. The
// precedence is declared by ENGINE_CLOSEOUT_POLICY_ORDER (defined here in
// Batch 3). recovery_tool_budget stays first in the order. It does NOT own model
// synthesis, repair prompt construction, or tool execution. Policy evaluation
// functions return decision objects; explicit application helpers write those
// decisions into injected state targets.
//
// The exported order array below is the source of truth for closeout
// precedence; it is defined in Batch 0 so the contract is pinnable, and the
// evaluating registry methods are added in Batch 3.
import { buildCompletedBrowserEvidenceDimensionCarryForwardLines } from "../runtime-policy/prompt-renderers";
import {
  buildContinuationDirectiveContext,
  containsAnyToolCallForm,
  sliceUtf8,
} from "../tool-protocol";
import {
  findExcessiveSessionContinuationCall,
  findRepeatedSessionInspectionCall,
  shouldPreserveRecoveredTimeoutCloseout,
  shouldCloseoutCancelledSessionWithoutContinuation,
} from "../runtime-facts/text-fallback-readers";
import { buildRecoveryToolBudgetCloseoutFacts } from "../runtime-facts/closeout-policy-facts";
import { selectRecoveryToolBudgetCloseoutPolicy } from "../runtime-policy/closeout-policy-core";
import { findRepeatedFailedToolCall } from "../react/predicates";
import {
  countNativeToolCalls,
  type NativeToolRoundTrace,
} from "../native-tool-messages";
import type {
  ExecutionBudgetController,
  ExecutionBudgetCloseoutSnapshot,
  WallClockBudgetCloseoutSignal,
} from "./execution-budget-controller";
import type {
  ContinuationController,
  ContinuationToolDefinition,
} from "./continuation-controller";
import type {
  CompletedSessionEvidenceFact,
  EvidenceRunSnapshotter,
  PermissionEvidenceFacts,
  TimeoutEvidenceFact,
} from "./evidence-ledger";
import type { PermissionPolicy } from "./permission-policy";
import type {
  CloseoutDecision,
  CloseoutDeferDecision,
  EngineCloseoutReason,
  LLMMessage,
  LLMToolCall,
} from "./types";

export const ENGINE_CLOSEOUT_POLICY_ORDER = [
  "recovery_tool_budget",
  "operator_cancelled",
  "pseudo_tool_call",
  "wall_clock_budget",
  "round_limit",
  "repeated_tool_failure",
  "repeated_session_inspection",
  "excessive_session_continuation",
  "sub_agent_timeout",
  "completed_sub_agent_final",
  "tool_evidence_fallback",
  "model_error",
] as const;

export type EngineCloseoutPolicyId = (typeof ENGINE_CLOSEOUT_POLICY_ORDER)[number];

export type CloseoutPolicyPhase =
  | "pending_calls"
  | "post_execute"
  | "model_error"
  | "round_limit"
  | "terminate";

export interface CloseoutPolicy {
  id: EngineCloseoutPolicyId;
  phase: CloseoutPolicyPhase;
}

export interface RecoveryToolBudgetSignal {
  maxToolCalls: number;
}

export interface RecoveryToolBudgetCloseoutInput {
  recoveryToolBudget: RecoveryToolBudgetSignal | null;
  usedToolCalls: number;
  pendingToolCallCount: number;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
  buildCloseoutSnapshot(): ExecutionBudgetCloseoutSnapshot;
}

export interface OperatorCancelledCloseoutMetadata {
  reason: "operator_cancelled";
  maxRounds: number;
  toolCallCount: number;
  roundCount: number;
  evidenceAvailable: boolean;
}

export interface PseudoToolCallCloseoutMetadata {
  reason: "pseudo_tool_call";
  maxRounds: number;
  toolCallCount: number;
  roundCount: number;
  evidenceAvailable: boolean;
}

export interface RepeatedToolFailureCloseoutMetadata {
  reason: "repeated_tool_failure";
  maxRounds: number;
  pendingToolCallCount: number;
  toolName: string;
  toolCallCount: number;
  roundCount: number;
  evidenceAvailable: boolean;
}

export interface RepeatedSessionInspectionCloseoutMetadata {
  reason: "repeated_session_inspection";
  maxRounds: number;
  pendingToolCallCount: number;
  toolName: string;
  toolCallCount: number;
  roundCount: number;
  evidenceAvailable: boolean;
}

export interface ExcessiveSessionContinuationCloseoutMetadata {
  reason: "excessive_session_continuation";
  maxRounds: number;
  pendingToolCallCount: number;
  toolName: string;
  toolCallCount: number;
  roundCount: number;
  evidenceAvailable: boolean;
}

export interface RemainingPendingCallsCloseoutInput {
  pendingCalls: LLMToolCall[];
  pendingToolCallCount: number;
  pendingContinuation: boolean;
  lastText: string;
  wallClockBudget: WallClockBudgetCloseoutSignal | null;
  taskPrompt: string;
  messages: LLMMessage[];
  sessionContext: string;
  toolTrace: NativeToolRoundTrace[];
  maxRounds: number;
  usedToolCalls: number;
  roundCount: number;
  evidenceAvailable: boolean;
  buildRoundLimitCloseoutSnapshot(): ExecutionBudgetCloseoutSnapshot;
}

export interface PendingCallsWallClockBudgetSignalInput {
  pendingCalls: LLMToolCall[];
  pendingContinuation: LLMToolCall | null;
}

export interface PendingCallsCloseoutInput {
  pendingCalls: LLMToolCall[];
  lastText: string;
  taskPrompt: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  maxRounds: number;
  usedToolCalls: number;
  recoveryUsedToolCalls: number;
  roundCount: number;
  evidenceAvailable: boolean;
  recoveryToolBudget: RecoveryToolBudgetSignal | null;
  readOnlyPermissionQuerySuppressed(): boolean;
  previewEmptyRoundContinuation(): LLMToolCall | null;
  buildRecoveryToolBudgetCloseoutSnapshot(): ExecutionBudgetCloseoutSnapshot;
  buildWallClockBudgetCloseoutSignal(
    input: PendingCallsWallClockBudgetSignalInput,
  ): WallClockBudgetCloseoutSignal | null;
  buildRoundLimitCloseoutSnapshot(): ExecutionBudgetCloseoutSnapshot;
}

export interface PendingCallsCloseoutHookInput {
  active: boolean;
  pendingCalls: LLMToolCall[];
  lastText: string;
  taskPrompt: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  round: number;
  maxRounds: number;
  recoveryToolCallsBeforeActivation: number;
  recoveryToolBudget: RecoveryToolBudgetSignal | null;
  permissionPolicy: Pick<
    PermissionPolicy,
    "wouldSuppressReadOnlyPermissionQuery"
  >;
  continuation: Pick<ContinuationController, "previewEmptyRoundContinuation">;
  executionBudget: Pick<
    ExecutionBudgetController,
    | "buildRecoveryToolBudgetCloseoutSnapshot"
    | "buildPendingCallsWallClockBudgetCloseoutSignal"
    | "buildRoundLimitCloseoutSnapshot"
  >;
  evidence: EvidenceRunSnapshotter;
  now(): number;
  toolLoopStartedAtMs: number;
  activeMaxWallClockMs?: number;
  tools?: readonly ContinuationToolDefinition[];
}

export interface RemainingPendingCallsSessionContextInput {
  taskPrompt: string;
  messages: LLMMessage[];
}

export function buildRemainingPendingCallsSessionContext(
  input: RemainingPendingCallsSessionContextInput,
): string {
  return `${input.taskPrompt}\n${buildContinuationDirectiveContext(
    input.taskPrompt,
    input.messages,
  )}`;
}

export interface PostExecuteCloseoutInput {
  completedSession: unknown | null;
  timeoutSignal: unknown | null;
}

export interface PendingTerminateCloseout<TCloseout = unknown> {
  reason: EngineCloseoutReason;
  reasonLines: string[];
  closeout: TCloseout;
}

export interface CompletedSessionTerminateSignal {
  toolName: string;
  finalContents: readonly string[];
  browserRecoverySummaries: readonly string[];
}

export interface SubAgentTimeoutTerminateSignal {
  toolName: string;
  timeoutSeconds?: number | null;
  evidenceAvailable: boolean;
}

export interface TerminateCloseoutInput {
  reason: EngineCloseoutReason;
  pendingCloseout: PendingTerminateCloseout | null;
  completedSession: CompletedSessionTerminateSignal | null;
  timeoutSignal: SubAgentTimeoutTerminateSignal | null;
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  maxRounds: number;
  usedToolCalls: number;
  roundCount: number;
  evidenceAvailable: boolean;
  buildRoundLimitCloseoutSnapshot(): ExecutionBudgetCloseoutSnapshot;
}

export interface TerminateCloseoutEvidenceSnapshot {
  usableEvidence: boolean;
  approvalEvidenceText: string;
  permission: PermissionEvidenceFacts;
}

export interface TerminateCloseoutEvidenceSnapshotter {
  snapshot(messages: LLMMessage[]): TerminateCloseoutEvidenceSnapshot;
}

export interface TerminateCloseoutStateSnapshotter {
  pendingCloseout():
    | {
        reasonLines: string[];
        closeout: { reason: EngineCloseoutReason };
      }
    | undefined;
  completedSession(): CompletedSessionTerminateSignal | undefined;
  timeoutSignal(): SubAgentTimeoutTerminateSignal | undefined;
}

export interface TerminateCloseoutHookInput {
  reason: EngineCloseoutReason;
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  maxRounds: number;
  state: TerminateCloseoutStateSnapshotter;
  evidence: TerminateCloseoutEvidenceSnapshotter;
  executionBudget: Pick<
    ExecutionBudgetController,
    "buildRoundLimitCloseoutSnapshot"
  >;
}

export interface TerminateApprovalWaitTimeoutFallbackInput {
  toolCallCount: number;
  roundCount: number;
  evidenceText: string;
}

export interface TerminateCloseoutHookResult {
  decision: TerminateCloseoutDecision;
  approvalWaitTimeoutFallback: TerminateApprovalWaitTimeoutFallbackInput;
}

export interface TerminateCloseoutDecision {
  kind: "closeout";
  policyId: EngineCloseoutReason;
  reason: EngineCloseoutReason;
  reasonLines?: string[];
  closeout: unknown;
  sticky?: boolean;
}

export type RecoveryToolBudgetCloseoutDecision =
  | (CloseoutDecision<ExecutionBudgetCloseoutSnapshot["closeout"]> & {
      closeout: ExecutionBudgetCloseoutSnapshot["closeout"];
    })
  | CloseoutDeferDecision;

export type RemainingPendingCallsCloseoutDecision =
  | (CloseoutDecision<OperatorCancelledCloseoutMetadata> & {
      closeout: OperatorCancelledCloseoutMetadata;
    })
  | (CloseoutDecision<PseudoToolCallCloseoutMetadata> & {
      closeout: PseudoToolCallCloseoutMetadata;
    })
  | (CloseoutDecision<ExecutionBudgetCloseoutSnapshot["closeout"]> & {
      closeout: ExecutionBudgetCloseoutSnapshot["closeout"];
    })
  | (CloseoutDecision<RepeatedToolFailureCloseoutMetadata> & {
      closeout: RepeatedToolFailureCloseoutMetadata;
    })
  | (CloseoutDecision<RepeatedSessionInspectionCloseoutMetadata> & {
      closeout: RepeatedSessionInspectionCloseoutMetadata;
    })
  | (CloseoutDecision<ExcessiveSessionContinuationCloseoutMetadata> & {
      closeout: ExcessiveSessionContinuationCloseoutMetadata;
    });

export type PostExecuteCloseoutDecision =
  | {
      kind: "closeout";
      policyId: "completed_sub_agent_final";
      reason: "completed_sub_agent_final";
    }
  | {
      kind: "closeout";
      policyId: "sub_agent_timeout";
      reason: "sub_agent_timeout";
    };

export type PendingCloseoutApplicationDecision =
  | RecoveryToolBudgetCloseoutDecision
  | RemainingPendingCallsCloseoutDecision;

type AppliedPendingCloseoutDecision = Extract<
  PendingCloseoutApplicationDecision,
  { kind: "closeout" }
>;

export interface PendingCloseoutApplicationTarget {
  recordPendingCloseout(input: {
    reasonLines: string[];
    closeout: AppliedPendingCloseoutDecision["closeout"];
  }): void;
}

export interface PostExecuteCloseoutApplicationInput<
  TCompletedSession = unknown,
  TTimeoutSignal = unknown,
  TToolResult = unknown,
> {
  completedSession: TCompletedSession | null;
  timeoutSignal: TTimeoutSignal | null;
  toolResults: TToolResult[];
}

export interface PostExecuteCloseoutEvidenceSnapshot<
  TCompletedSession = unknown,
  TTimeoutSignal = unknown,
> {
  completedSession: TCompletedSession | null;
  completedSessions: readonly TCompletedSession[];
  timeoutSignal: TTimeoutSignal | null;
  timeoutSignals: readonly TTimeoutSignal[];
}

export type TypedPostExecuteCloseoutEvidenceSnapshot =
  PostExecuteCloseoutEvidenceSnapshot<
    CompletedSessionEvidenceFact,
    TimeoutEvidenceFact
  >;

export interface PostExecuteCloseoutHookInput<
  TCompletedSession = unknown,
  TTimeoutSignal = unknown,
  TToolResult = unknown,
> {
  toolResults: TToolResult[];
  evidence: {
    currentRound(
      results: TToolResult[],
    ): PostExecuteCloseoutEvidenceSnapshot<
      TCompletedSession,
      TTimeoutSignal
    >;
  };
}

export interface PostExecuteCloseoutApplicationTarget<
  TCompletedSession = unknown,
  TTimeoutSignal = unknown,
  TToolResult = unknown,
> {
  recordCompletedSession(input: {
    session: TCompletedSession;
    toolResults: TToolResult[];
  }): void;
  recordTimeoutSignal(input: TTimeoutSignal): void;
}

export interface CloseoutPolicyRegistry {
  evaluateRecoveryToolBudget(
    input: RecoveryToolBudgetCloseoutInput,
  ): RecoveryToolBudgetCloseoutDecision | null;

  evaluateRemainingPendingCalls(
    input: RemainingPendingCallsCloseoutInput,
  ): RemainingPendingCallsCloseoutDecision | null;

  applyRecoveryToolBudgetCloseout(
    input: RecoveryToolBudgetCloseoutInput,
    target: PendingCloseoutApplicationTarget,
  ): EngineCloseoutReason | null;

  applyRemainingPendingCallsCloseout(
    input: RemainingPendingCallsCloseoutInput,
    target: PendingCloseoutApplicationTarget,
  ): EngineCloseoutReason | null;

  applyPendingCallsCloseout(
    input: PendingCallsCloseoutInput,
    target: PendingCloseoutApplicationTarget,
  ): EngineCloseoutReason | null;

  applyPendingCallsCloseoutHook(
    input: PendingCallsCloseoutHookInput,
    target: PendingCloseoutApplicationTarget,
  ): EngineCloseoutReason | null;

  evaluatePostExecute(
    input: PostExecuteCloseoutInput,
  ): PostExecuteCloseoutDecision | null;

  applyPostExecuteCloseout<TCompletedSession, TTimeoutSignal, TToolResult>(
    input: PostExecuteCloseoutApplicationInput<
      TCompletedSession,
      TTimeoutSignal,
      TToolResult
    >,
    target: PostExecuteCloseoutApplicationTarget<
      TCompletedSession,
      TTimeoutSignal,
      TToolResult
    >,
  ): EngineCloseoutReason | null;

  applyPostExecuteCloseoutHook<TCompletedSession, TTimeoutSignal, TToolResult>(
    input: PostExecuteCloseoutHookInput<
      TCompletedSession,
      TTimeoutSignal,
      TToolResult
    >,
    target: PostExecuteCloseoutApplicationTarget<
      TCompletedSession,
      TTimeoutSignal,
      TToolResult
    >,
  ): EngineCloseoutReason | null;

  applyPendingCloseoutDecision(
    decision: PendingCloseoutApplicationDecision | null,
    target: PendingCloseoutApplicationTarget,
  ): EngineCloseoutReason | null;

  applyPostExecuteCloseoutDecision<
    TCompletedSession,
    TTimeoutSignal,
    TToolResult,
  >(
    decision: PostExecuteCloseoutDecision | null,
    input: PostExecuteCloseoutApplicationInput<
      TCompletedSession,
      TTimeoutSignal,
      TToolResult
    >,
    target: PostExecuteCloseoutApplicationTarget<
      TCompletedSession,
      TTimeoutSignal,
      TToolResult
    >,
  ): EngineCloseoutReason | null;

  evaluateTerminate(input: TerminateCloseoutInput): TerminateCloseoutDecision;

  evaluateTerminateHook(input: TerminateCloseoutHookInput): TerminateCloseoutHookResult;
}

class DefaultCloseoutPolicyRegistry implements CloseoutPolicyRegistry {
  evaluateRecoveryToolBudget(
    input: RecoveryToolBudgetCloseoutInput,
  ): RecoveryToolBudgetCloseoutDecision | null {
    const budget = input.recoveryToolBudget;
    if (!budget || input.usedToolCalls < budget.maxToolCalls) {
      return null;
    }
    const decision = selectRecoveryToolBudgetCloseoutPolicy({
      budgetExceeded: true,
      facts: buildRecoveryToolBudgetCloseoutFacts({
        pendingToolCallCount: input.pendingToolCallCount,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        resultText: input.resultText,
      }),
    });
    if (decision.kind === "defer") {
      return {
        kind: "defer",
        policyId: "recovery_tool_budget",
        deferTo: "repair_round",
        reason: "final_recovery_budget_closeout_repair",
      };
    }
    const snapshot = input.buildCloseoutSnapshot();
    return {
      kind: "closeout",
      policyId: "recovery_tool_budget",
      reason: "recovery_tool_budget",
      reasonLines: snapshot.reasonLines,
      closeout: snapshot.closeout,
    };
  }

  evaluateRemainingPendingCalls(
    input: RemainingPendingCallsCloseoutInput,
  ): RemainingPendingCallsCloseoutDecision | null {
    if (
      input.pendingToolCallCount > 0 &&
      shouldCloseoutCancelledSessionWithoutContinuation({
        taskPrompt: input.taskPrompt,
        messages: input.messages,
      })
    ) {
      return {
        kind: "closeout",
        policyId: "operator_cancelled",
        reason: "operator_cancelled",
        reasonLines: [
          "A previous sub-agent session was cancelled by the operator.",
          "The latest user message did not ask to continue, resume, or retry that cancelled session.",
          "Do not call more tools or spawn a replacement session. Produce the final answer from the cancellation evidence already present.",
          "State what remains unverified and how the user can continue later if they want the cancelled work resumed.",
        ],
        closeout: {
          reason: "operator_cancelled",
          maxRounds: input.maxRounds,
          toolCallCount: input.usedToolCalls,
          roundCount: input.roundCount,
          evidenceAvailable: input.evidenceAvailable,
        },
      };
    }
    if (
      input.pendingToolCallCount === 0 &&
      !input.pendingContinuation &&
      containsAnyToolCallForm({ text: input.lastText })
    ) {
      return {
        kind: "closeout",
        policyId: "pseudo_tool_call",
        reason: "pseudo_tool_call",
        reasonLines: [
          "The previous assistant response attempted to emit XML, JSON, or pseudo tool-call markup without a native tool call.",
          "Tools are not available through text markup. Do not call more tools.",
          "Produce only the final user-facing answer from the evidence already present in the conversation.",
        ],
        closeout: {
          reason: "pseudo_tool_call",
          maxRounds: input.maxRounds,
          toolCallCount: input.usedToolCalls,
          roundCount: input.roundCount,
          evidenceAvailable: input.evidenceAvailable,
        },
      };
    }
    const wallClockBudget = input.wallClockBudget;
    if (
      wallClockBudget &&
      input.roundCount > 0 &&
      isPositiveFiniteBudgetValue(wallClockBudget.maxWallClockMs) &&
      wallClockBudget.readElapsedMs() >= wallClockBudget.maxWallClockMs
    ) {
      const snapshot = wallClockBudget.buildCloseoutSnapshot(
        wallClockBudget.maxWallClockMs,
      );
      return {
        kind: "closeout",
        policyId: "wall_clock_budget",
        reason: "wall_clock_budget",
        reasonLines: snapshot.reasonLines,
        closeout: snapshot.closeout,
      };
    }
    if (input.roundCount >= input.maxRounds && input.pendingToolCallCount > 0) {
      const snapshot = input.buildRoundLimitCloseoutSnapshot();
      return {
        kind: "closeout",
        policyId: "round_limit",
        reason: "round_limit",
        reasonLines: snapshot.reasonLines,
        closeout: snapshot.closeout,
      };
    }
    const repeatedFailure = findRepeatedFailedToolCall(
      input.pendingCalls,
      input.toolTrace,
    );
    if (repeatedFailure) {
      return {
        kind: "closeout",
        policyId: "repeated_tool_failure",
        reason: "repeated_tool_failure",
        reasonLines: [
          `Repeated failing tool call detected: ${repeatedFailure.toolName} failed ${repeatedFailure.failureCount} times with the same arguments.`,
          "Do not call the same tool again with those arguments, and do not spawn a fallback session for the same target.",
          "Produce the best final answer from evidence already gathered. If no usable evidence exists, say verification did not complete and name the next operator/user input needed.",
        ],
        closeout: {
          reason: "repeated_tool_failure",
          maxRounds: input.maxRounds,
          pendingToolCallCount: input.pendingToolCallCount,
          toolName: repeatedFailure.toolName,
          toolCallCount: input.usedToolCalls,
          roundCount: input.roundCount,
          evidenceAvailable: input.evidenceAvailable,
        },
      };
    }
    const repeatedSessionInspection = findRepeatedSessionInspectionCall(
      input.pendingCalls,
      input.toolTrace,
      input.taskPrompt,
      input.sessionContext,
    );
    if (repeatedSessionInspection) {
      return {
        kind: "closeout",
        policyId: "repeated_session_inspection",
        reason: "repeated_session_inspection",
        reasonLines: [
          `Repeated session inspection detected: ${repeatedSessionInspection.toolName} already inspected ${repeatedSessionInspection.sessionKey}.`,
          "Do not call sessions_history or sessions_list again for the same session.",
          "Produce the final answer from the session evidence already gathered. If the gathered evidence is insufficient, state exactly what remains unverified and what follow-up is needed.",
        ],
        closeout: {
          reason: "repeated_session_inspection",
          maxRounds: input.maxRounds,
          pendingToolCallCount: input.pendingToolCallCount,
          toolName: repeatedSessionInspection.toolName,
          toolCallCount: input.usedToolCalls,
          roundCount: input.roundCount,
          evidenceAvailable: input.evidenceAvailable,
        },
      };
    }
    const excessiveSessionContinuation = findExcessiveSessionContinuationCall(
      input.pendingCalls,
      input.toolTrace,
    );
    if (excessiveSessionContinuation) {
      return {
        kind: "closeout",
        policyId: "excessive_session_continuation",
        reason: "excessive_session_continuation",
        reasonLines: [
          `Repeated session continuation detected: ${excessiveSessionContinuation.sessionKey} was already continued ${excessiveSessionContinuation.continuationCount} times.`,
          "Do not call sessions_send again for the same session.",
          "Produce the final answer from the gathered session evidence now. If the evidence is incomplete, state the exact unverified scope and the bounded follow-up needed.",
        ],
        closeout: {
          reason: "excessive_session_continuation",
          maxRounds: input.maxRounds,
          pendingToolCallCount: input.pendingToolCallCount,
          toolName: excessiveSessionContinuation.toolName,
          toolCallCount: input.usedToolCalls,
          roundCount: input.roundCount,
          evidenceAvailable: input.evidenceAvailable,
        },
      };
    }
    return null;
  }

  evaluatePostExecute(
    input: PostExecuteCloseoutInput,
  ): PostExecuteCloseoutDecision | null {
    if (input.completedSession) {
      return {
        kind: "closeout",
        policyId: "completed_sub_agent_final",
        reason: "completed_sub_agent_final",
      };
    }
    if (input.timeoutSignal) {
      return {
        kind: "closeout",
        policyId: "sub_agent_timeout",
        reason: "sub_agent_timeout",
      };
    }
    return null;
  }

  applyRecoveryToolBudgetCloseout(
    input: RecoveryToolBudgetCloseoutInput,
    target: PendingCloseoutApplicationTarget,
  ): EngineCloseoutReason | null {
    return this.applyPendingCloseoutDecision(
      this.evaluateRecoveryToolBudget(input),
      target,
    );
  }

  applyRemainingPendingCallsCloseout(
    input: RemainingPendingCallsCloseoutInput,
    target: PendingCloseoutApplicationTarget,
  ): EngineCloseoutReason | null {
    return this.applyPendingCloseoutDecision(
      this.evaluateRemainingPendingCalls(input),
      target,
    );
  }

  applyPendingCallsCloseout(
    input: PendingCallsCloseoutInput,
    target: PendingCloseoutApplicationTarget,
  ): EngineCloseoutReason | null {
    if (input.readOnlyPermissionQuerySuppressed()) {
      return null;
    }

    const pendingToolCallCount = input.pendingCalls.length;
    const recoveryCloseoutReason = this.applyRecoveryToolBudgetCloseout(
      {
        recoveryToolBudget: input.recoveryToolBudget,
        usedToolCalls: input.recoveryUsedToolCalls,
        pendingToolCallCount,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        resultText: input.lastText,
        buildCloseoutSnapshot: input.buildRecoveryToolBudgetCloseoutSnapshot,
      },
      target,
    );
    if (recoveryCloseoutReason) {
      return recoveryCloseoutReason;
    }

    const pendingContinuation =
      pendingToolCallCount === 0 ? input.previewEmptyRoundContinuation() : null;
    return this.applyRemainingPendingCallsCloseout(
      {
        pendingCalls: input.pendingCalls,
        pendingToolCallCount,
        pendingContinuation: pendingContinuation !== null,
        lastText: input.lastText,
        wallClockBudget: input.buildWallClockBudgetCloseoutSignal({
          pendingCalls: input.pendingCalls,
          pendingContinuation,
        }),
        taskPrompt: input.taskPrompt,
        messages: input.messages,
        sessionContext: buildRemainingPendingCallsSessionContext({
          taskPrompt: input.taskPrompt,
          messages: input.messages,
        }),
        toolTrace: input.toolTrace,
        maxRounds: input.maxRounds,
        usedToolCalls: input.usedToolCalls,
        roundCount: input.roundCount,
        evidenceAvailable: input.evidenceAvailable,
        buildRoundLimitCloseoutSnapshot: input.buildRoundLimitCloseoutSnapshot,
      },
      target,
    );
  }

  applyPendingCallsCloseoutHook(
    input: PendingCallsCloseoutHookInput,
    target: PendingCloseoutApplicationTarget,
  ): EngineCloseoutReason | null {
    if (!input.active) {
      return null;
    }

    const roundCount = input.toolTrace.length;
    const usedToolCalls = countNativeToolCalls(input.toolTrace);
    const evidence = input.evidence.snapshot(input.messages);
    return this.applyPendingCallsCloseout(
      {
        pendingCalls: input.pendingCalls,
        lastText: input.lastText,
        taskPrompt: input.taskPrompt,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        toolTrace: input.toolTrace,
        maxRounds: input.maxRounds,
        usedToolCalls,
        recoveryUsedToolCalls:
          input.recoveryToolCallsBeforeActivation + usedToolCalls,
        roundCount,
        evidenceAvailable: evidence.usableEvidence,
        recoveryToolBudget: input.recoveryToolBudget,
        readOnlyPermissionQuerySuppressed: () =>
          input.permissionPolicy.wouldSuppressReadOnlyPermissionQuery({
            calls: input.pendingCalls,
            taskPrompt: input.taskPrompt,
            sessionContext: buildContinuationDirectiveContext(
              input.taskPrompt,
              input.messages,
            ),
          }),
        previewEmptyRoundContinuation: () =>
          input.continuation.previewEmptyRoundContinuation({
            active: input.active,
            messages: input.messages,
            round: input.round,
            taskPrompt: input.taskPrompt,
            toolTrace: input.toolTrace,
            ...(input.tools === undefined ? {} : { tools: input.tools }),
          }),
        buildRecoveryToolBudgetCloseoutSnapshot: () =>
          input.executionBudget.buildRecoveryToolBudgetCloseoutSnapshot({
            maxRounds: input.maxRounds,
            maxToolCalls: input.recoveryToolBudget?.maxToolCalls ?? 0,
            pendingToolCallCount: input.pendingCalls.length,
            usedToolCalls:
              input.recoveryToolCallsBeforeActivation + usedToolCalls,
            roundCount,
            evidenceAvailable: evidence.usableEvidence,
          }),
        buildWallClockBudgetCloseoutSignal: (wallClockInput) =>
          input.executionBudget.buildPendingCallsWallClockBudgetCloseoutSignal({
            pendingCalls: wallClockInput.pendingCalls,
            pendingContinuation: wallClockInput.pendingContinuation,
            maxRounds: input.maxRounds,
            usedToolCalls,
            roundCount,
            evidenceAvailable: evidence.usableEvidence,
            now: input.now,
            toolLoopStartedAtMs: input.toolLoopStartedAtMs,
            ...(input.activeMaxWallClockMs === undefined
              ? {}
              : { maxWallClockMs: input.activeMaxWallClockMs }),
          }),
        buildRoundLimitCloseoutSnapshot: () =>
          input.executionBudget.buildRoundLimitCloseoutSnapshot({
            maxRounds: input.maxRounds,
            pendingToolCallCount: input.pendingCalls.length,
            usedToolCalls,
            roundCount,
            evidenceAvailable: evidence.usableEvidence,
          }),
      },
      target,
    );
  }

  applyPostExecuteCloseout<TCompletedSession, TTimeoutSignal, TToolResult>(
    input: PostExecuteCloseoutApplicationInput<
      TCompletedSession,
      TTimeoutSignal,
      TToolResult
    >,
    target: PostExecuteCloseoutApplicationTarget<
      TCompletedSession,
      TTimeoutSignal,
      TToolResult
    >,
  ): EngineCloseoutReason | null {
    return this.applyPostExecuteCloseoutDecision(
      this.evaluatePostExecute({
        completedSession: input.completedSession,
        timeoutSignal: input.timeoutSignal,
      }),
      input,
      target,
    );
  }

  applyPostExecuteCloseoutHook<TCompletedSession, TTimeoutSignal, TToolResult>(
    input: PostExecuteCloseoutHookInput<
      TCompletedSession,
      TTimeoutSignal,
      TToolResult
    >,
    target: PostExecuteCloseoutApplicationTarget<
      TCompletedSession,
      TTimeoutSignal,
      TToolResult
    >,
  ): EngineCloseoutReason | null {
    const roundEvidence = input.evidence.currentRound(input.toolResults);
    return this.applyPostExecuteCloseout(
      {
        completedSession:
          roundEvidence.completedSessions.length > 0
            ? roundEvidence.completedSession
            : null,
        timeoutSignal: roundEvidence.timeoutSignals[0] ?? null,
        toolResults: input.toolResults,
      },
      target,
    );
  }

  applyPendingCloseoutDecision(
    decision: PendingCloseoutApplicationDecision | null,
    target: PendingCloseoutApplicationTarget,
  ): EngineCloseoutReason | null {
    if (!decision || decision.kind !== "closeout") {
      // Defer decisions are intentionally non-terminal; their owning repair hook
      // handles the follow-up.
      return null;
    }
    target.recordPendingCloseout({
      reasonLines: decision.reasonLines,
      closeout: decision.closeout,
    });
    return decision.reason;
  }

  applyPostExecuteCloseoutDecision<
    TCompletedSession,
    TTimeoutSignal,
    TToolResult,
  >(
    decision: PostExecuteCloseoutDecision | null,
    input: PostExecuteCloseoutApplicationInput<
      TCompletedSession,
      TTimeoutSignal,
      TToolResult
    >,
    target: PostExecuteCloseoutApplicationTarget<
      TCompletedSession,
      TTimeoutSignal,
      TToolResult
    >,
  ): EngineCloseoutReason | null {
    if (!decision) {
      return null;
    }
    if (
      decision.reason === "completed_sub_agent_final" &&
      input.completedSession
    ) {
      target.recordCompletedSession({
        session: input.completedSession,
        toolResults: input.toolResults,
      });
      return decision.reason;
    }
    if (decision.reason === "sub_agent_timeout" && input.timeoutSignal) {
      target.recordTimeoutSignal(input.timeoutSignal);
      return decision.reason;
    }
    return null;
  }

  evaluateTerminate(input: TerminateCloseoutInput): TerminateCloseoutDecision {
    const pendingCloseout = input.pendingCloseout;
    if (pendingCloseout && pendingCloseout.reason === input.reason) {
      return {
        kind: "closeout",
        policyId: pendingCloseout.reason,
        reason: pendingCloseout.reason,
        reasonLines: pendingCloseout.reasonLines,
        closeout: pendingCloseout.closeout,
      };
    }
    const completedSession = input.completedSession;
    if (input.reason === "completed_sub_agent_final" && completedSession) {
      const preserveRecoveredTimeoutCloseout =
        shouldPreserveRecoveredTimeoutCloseout({
          taskPrompt: input.taskPrompt,
          messages: input.messages,
          toolTrace: input.toolTrace,
          evidenceText: completedSession.finalContents.join("\n\n"),
        });
      return {
        kind: "closeout",
        policyId: "completed_sub_agent_final",
        reason: "completed_sub_agent_final",
        reasonLines: [
          `${completedSession.toolName} returned completed delegated session evidence.`,
          "Do not call sessions_history or sessions_list just to restate this delegated result.",
          "Use the delegated session evidence below as the source of truth. Do not override it with memory, assumptions, or general product knowledge.",
          "Do not add capabilities, target users, pricing, open-source claims, or product positioning unless they are stated in this source content.",
          "Do not add DNS/IP resolution, IANA allocation details, production-environment bans, real-service claims, security-scanner claims, or abuse-risk claims unless those exact facts are stated in this source content.",
          "If the source states a narrow scope limit or usage caveat, preserve its exact wording (or state that wider use is outside the verified scope); do not upgrade a narrow caveat into a broader production-environment or real-service ban.",
          ...buildCompletedBrowserEvidenceDimensionCarryForwardLines({
            taskPrompt: input.taskPrompt,
            finalContents: completedSession.finalContents,
          }),
          "If a requested dimension is missing or uncertain in the source content, write not verified.",
          "Preserve uncertainty labels. Preserve source URLs only when the original user did not forbid links or source URLs.",
          "For each Source N evidence block below, carry at least one verified fact into the final answer or explicitly say that source did not verify a required dimension.",
          "For approval-gated work, include the approved action, the evidence observed after the approved action, and the residual risk or no-external-side-effect boundary.",
          ...(preserveRecoveredTimeoutCloseout
            ? [
                "This completed source followed a timeout or timed-out continuation.",
                "Preserve user-visible timeout closeout: say what was recovered, whether the timeout still limits the conclusion, and what continue/retry/longer-timeout path remains if future evidence is missing.",
                "Do not reduce the timeout closeout to 'no action required' solely because resumed evidence eventually arrived.",
              ]
            : []),
          ...(completedSession.browserRecoverySummaries.length
            ? [
                "The source also includes browser continuity metadata.",
                "If the user asked to continue, recover, reopen, reconnect, or handle an unavailable browser session, include one concise user-visible continuity sentence in the final answer.",
                ...completedSession.browserRecoverySummaries.map(
                  (summary, index) =>
                    `Browser continuity ${index + 1}: ${summary}`,
                ),
              ]
            : []),
          ...completedSession.finalContents.map(
            (content, index) =>
              `Source ${index + 1} evidence:\n${sliceUtf8(content, 8 * 1024)}`,
          ),
        ],
        closeout: {
          reason: "completed_sub_agent_final",
          maxRounds: input.maxRounds,
          toolName: completedSession.toolName,
          finalContentCount: completedSession.finalContents.length,
          toolCallCount: input.usedToolCalls,
          roundCount: input.roundCount,
          evidenceAvailable: true,
        },
        sticky: true,
      };
    }
    const timeoutSignal = input.timeoutSignal;
    if (input.reason === "sub_agent_timeout" && timeoutSignal) {
      return {
        kind: "closeout",
        policyId: "sub_agent_timeout",
        reason: "sub_agent_timeout",
        reasonLines: [
          `${timeoutSignal.toolName} timed out${timeoutSignal.timeoutSeconds == null ? "" : ` after ${timeoutSignal.timeoutSeconds}s`}.`,
          "Do not call more tools or spawn fallback sessions for this timeout.",
          "Do not copy internal fetch URLs, local fixture URLs, session keys, or raw tool arguments into the final answer unless the original user requested those exact raw identifiers.",
          timeoutSignal.evidenceAvailable
            ? "Produce the best final answer from the evidence already gathered and state any remaining uncertainty."
            : "No usable evidence was gathered before the timeout. Say that verification did not complete, summarize what was attempted, and tell the user they can ask to continue.",
          "Include one concise continuation sentence: the user can continue the same source check if the missing evidence is still worth waiting for.",
        ],
        closeout: {
          reason: "sub_agent_timeout",
          maxRounds: input.maxRounds,
          toolName: timeoutSignal.toolName,
          ...(timeoutSignal.timeoutSeconds == null
            ? {}
            : { timeoutSeconds: timeoutSignal.timeoutSeconds }),
          evidenceAvailable: timeoutSignal.evidenceAvailable,
          toolCallCount: input.usedToolCalls,
          roundCount: input.roundCount,
        },
      };
    }
    if (input.reason === "round_limit") {
      const snapshot = input.buildRoundLimitCloseoutSnapshot();
      return {
        kind: "closeout",
        policyId: "round_limit",
        reason: "round_limit",
        reasonLines: snapshot.reasonLines,
        closeout: snapshot.closeout,
      };
    }
    return {
      kind: "closeout",
      policyId: input.reason,
      reason: input.reason,
      closeout: {
        reason: input.reason,
        maxRounds: input.maxRounds,
        toolCallCount: input.usedToolCalls,
        roundCount: input.roundCount,
        evidenceAvailable: input.evidenceAvailable,
      },
    };
  }

  evaluateTerminateHook(input: TerminateCloseoutHookInput): TerminateCloseoutHookResult {
    const usedToolCalls = countNativeToolCalls(input.toolTrace);
    const roundCount = input.toolTrace.length;
    const terminateEvidence = input.evidence.snapshot(input.messages);
    const evidenceAvailable = terminateEvidence.usableEvidence;
    const pendingCloseout = input.state.pendingCloseout();
    const completedSession = input.state.completedSession() ?? null;
    const timeoutSignal = input.state.timeoutSignal() ?? null;

    return {
      decision: this.evaluateTerminate({
        reason: input.reason,
        pendingCloseout: pendingCloseout
          ? {
              reason: pendingCloseout.closeout.reason,
              reasonLines: pendingCloseout.reasonLines,
              closeout: pendingCloseout.closeout,
            }
          : null,
        completedSession,
        timeoutSignal,
        taskPrompt: input.taskPrompt,
        messages: input.messages,
        toolTrace: input.toolTrace,
        maxRounds: input.maxRounds,
        usedToolCalls,
        roundCount,
        evidenceAvailable,
        buildRoundLimitCloseoutSnapshot: () =>
          input.executionBudget.buildRoundLimitCloseoutSnapshot({
            maxRounds: input.maxRounds,
            usedToolCalls,
            roundCount,
            evidenceAvailable,
          }),
      }),
      approvalWaitTimeoutFallback: {
        toolCallCount: usedToolCalls,
        roundCount,
        evidenceText: terminateEvidence.approvalEvidenceText,
      },
    };
  }
}

function isPositiveFiniteBudgetValue(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function createCloseoutPolicyRegistry(): CloseoutPolicyRegistry {
  return new DefaultCloseoutPolicyRegistry();
}
