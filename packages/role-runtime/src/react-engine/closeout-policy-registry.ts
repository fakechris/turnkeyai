// Stage 8 engine cleanup — CloseoutPolicyRegistry (module shell).
//
// Authority: own terminal closeout decisions and their precedence. The
// precedence is declared by ENGINE_CLOSEOUT_POLICY_ORDER (defined here in
// Batch 3). recovery_tool_budget stays first in the order. It does NOT own model
// synthesis, repair prompt construction, or tool execution. Policy functions
// return a decision object, they do not write into run state directly.
//
// The exported order array below is the source of truth for closeout
// precedence; it is defined in Batch 0 so the contract is pinnable, and the
// evaluating registry methods are added in Batch 3.
import {
  containsAnyToolCallForm,
  findExcessiveSessionContinuationCall,
  findRepeatedSessionInspectionCall,
  shouldCloseoutCancelledSessionWithoutContinuation,
  shouldRepairFinalRecoveryBudgetCloseout,
} from "../tool-loop-shared";
import { findRepeatedFailedToolCall } from "../react/predicates";
import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { ExecutionBudgetCloseoutSnapshot } from "./execution-budget-controller";
import type {
  CloseoutDecision,
  CloseoutDeferDecision,
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

export interface WallClockBudgetCloseoutSignal {
  maxWallClockMs: number | undefined;
  requiredTimeoutContinuationPastWallClock: boolean;
  readElapsedMs(): number;
  buildCloseoutSnapshot(maxWallClockMs: number): ExecutionBudgetCloseoutSnapshot;
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

export interface PostExecuteCloseoutInput {
  completedSession: unknown | null;
  timeoutSignal: unknown | null;
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

export interface CloseoutPolicyRegistry {
  evaluateRecoveryToolBudget(
    input: RecoveryToolBudgetCloseoutInput,
  ): RecoveryToolBudgetCloseoutDecision | null;

  evaluateRemainingPendingCalls(
    input: RemainingPendingCallsCloseoutInput,
  ): RemainingPendingCallsCloseoutDecision | null;

  evaluatePostExecute(
    input: PostExecuteCloseoutInput,
  ): PostExecuteCloseoutDecision | null;
}

class DefaultCloseoutPolicyRegistry implements CloseoutPolicyRegistry {
  evaluateRecoveryToolBudget(
    input: RecoveryToolBudgetCloseoutInput,
  ): RecoveryToolBudgetCloseoutDecision | null {
    const budget = input.recoveryToolBudget;
    if (!budget || input.usedToolCalls < budget.maxToolCalls) {
      return null;
    }
    if (
      input.pendingToolCallCount === 0 &&
      shouldRepairFinalRecoveryBudgetCloseout({
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        resultText: input.resultText,
      })
    ) {
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
      !wallClockBudget.requiredTimeoutContinuationPastWallClock &&
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
}

function isPositiveFiniteBudgetValue(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function createCloseoutPolicyRegistry(): CloseoutPolicyRegistry {
  return new DefaultCloseoutPolicyRegistry();
}
