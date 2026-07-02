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
  shouldCloseoutCancelledSessionWithoutContinuation,
  shouldRepairFinalRecoveryBudgetCloseout,
} from "../tool-loop-shared";
import type { ExecutionBudgetCloseoutSnapshot } from "./execution-budget-controller";
import type {
  CloseoutDecision,
  CloseoutDeferDecision,
  LLMMessage,
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

export interface RemainingPendingCallsCloseoutInput {
  pendingToolCallCount: number;
  pendingContinuation: boolean;
  lastText: string;
  taskPrompt: string;
  messages: LLMMessage[];
  maxRounds: number;
  usedToolCalls: number;
  roundCount: number;
  evidenceAvailable: boolean;
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
    });

export interface CloseoutPolicyRegistry {
  evaluateRecoveryToolBudget(
    input: RecoveryToolBudgetCloseoutInput,
  ): RecoveryToolBudgetCloseoutDecision | null;

  evaluateRemainingPendingCalls(
    input: RemainingPendingCallsCloseoutInput,
  ): RemainingPendingCallsCloseoutDecision | null;
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
    return null;
  }
}

export function createCloseoutPolicyRegistry(): CloseoutPolicyRegistry {
  return new DefaultCloseoutPolicyRegistry();
}
