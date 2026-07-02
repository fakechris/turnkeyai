import type { ToolResult } from "@turnkeyai/agent-core/tool";
import type { LLMToolCall } from "@turnkeyai/llm-adapter/index";

import { buildToolCallLimitExceededResult } from "../tool-loop-shared";

// Stage 8 engine cleanup — ExecutionBudgetController.
//
// Current authority: own the engine path's admission mechanics that are pure
// functions of pending calls and configured caps:
// - final-recovery pending-call truncation;
// - per-round tool-call cap admission and synthetic skipped results.
//
// Later slices still need to move wall-clock checks, batching, and closeout
// signal data. This module must not choose closeout reasons or synthesize text.
export const EXECUTION_BUDGET_CONTROLLER_MODULE =
  "execution-budget-controller" as const;

export interface RecoveryToolBudget {
  maxToolCalls: number;
}

export interface TruncateForRecoveryBudgetInput {
  calls: LLMToolCall[];
  recoveryToolBudget: RecoveryToolBudget | null;
  usedToolCalls: number;
}

export interface LimitToolCallsPerRoundInput {
  calls: LLMToolCall[];
  maxToolCallsPerRound?: number;
}

export interface ToolCallAdmissionDecision {
  executable: LLMToolCall[];
  rejected: ToolResult[];
}

export class ExecutionBudgetController {
  truncateForRecoveryBudget(
    input: TruncateForRecoveryBudgetInput,
  ): LLMToolCall[] {
    const budget = input.recoveryToolBudget;
    if (!budget) {
      return input.calls;
    }
    const remainingToolCalls = budget.maxToolCalls - input.usedToolCalls;
    if (remainingToolCalls > 0 && input.calls.length > remainingToolCalls) {
      return input.calls.slice(0, remainingToolCalls);
    }
    return input.calls;
  }

  limitToolCallsPerRound(
    input: LimitToolCallsPerRoundInput,
  ): ToolCallAdmissionDecision {
    const maxToolCallsPerRound = resolvePositiveIntegerLimit(
      input.maxToolCallsPerRound,
      input.calls.length,
    );
    if (maxToolCallsPerRound >= input.calls.length) {
      return { executable: input.calls, rejected: [] };
    }
    const requestedToolCalls = input.calls.length;
    return {
      executable: input.calls.slice(0, maxToolCallsPerRound),
      rejected: input.calls
        .slice(maxToolCallsPerRound)
        .map((call) =>
          buildToolCallLimitExceededResult(
            call,
            maxToolCallsPerRound,
            requestedToolCalls,
          ),
        ),
    };
  }
}

export function createExecutionBudgetController(): ExecutionBudgetController {
  return new ExecutionBudgetController();
}

function resolvePositiveIntegerLimit(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
