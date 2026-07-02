import type { ToolResult } from "@turnkeyai/agent-core/tool";
import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import { shouldSerializeToolBatch } from "../react/predicates";
import {
  buildFinalRecoveryBudgetCloseoutReasonLines,
  buildToolCallLimitExceededResult,
  createToolExecutionSignal,
  formatDurationMs,
  isAbortError,
  resolveEffectiveToolLoopWallClockMs,
  withFinalToolRoundWarning,
} from "../tool-loop-shared";

// Stage 8 engine cleanup — ExecutionBudgetController.
//
// Current authority: own the engine path's budget mechanics that are pure
// functions of pending calls, model round counters, and configured caps:
// - final-allowed tool-round warning injection;
// - final-recovery pending-call truncation;
// - per-round tool-call cap admission and synthetic skipped results.
// - tool-batch execution concurrency, wall-clock signal setup, and per-call
//   non-abort failure shaping.
//
// This module must not choose whether closeout reasons apply or synthesize
// terminal answers. It may build budget closeout snapshots after the caller has
// selected the policy, so later closeout registries can consume one shape.
export const EXECUTION_BUDGET_CONTROLLER_MODULE =
  "execution-budget-controller" as const;

export interface FinalToolRoundWarningInput {
  messages: LLMMessage[];
  active: boolean;
  round: number;
  maxRounds: number;
}

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

export type ExecutionBudgetCloseoutMetadata =
  | {
      reason: "recovery_tool_budget";
      maxRounds: number;
      pendingToolCallCount: number;
      toolCallCount: number;
      roundCount: number;
      evidenceAvailable: boolean;
    }
  | {
      reason: "wall_clock_budget";
      maxRounds: number;
      maxWallClockMs: number;
      pendingToolCallCount: number;
      toolCallCount: number;
      roundCount: number;
      evidenceAvailable: boolean;
    }
  | {
      reason: "round_limit";
      maxRounds: number;
      pendingToolCallCount?: number;
      toolCallCount: number;
      roundCount: number;
      evidenceAvailable: boolean;
    };

export interface ExecutionBudgetCloseoutSnapshot {
  reasonLines: string[];
  closeout: ExecutionBudgetCloseoutMetadata;
}

export interface RecoveryToolBudgetCloseoutSnapshotInput {
  maxRounds: number;
  maxToolCalls: number;
  pendingToolCallCount: number;
  usedToolCalls: number;
  roundCount: number;
  evidenceAvailable: boolean;
}

export interface WallClockBudgetCloseoutSnapshotInput {
  maxRounds: number;
  maxWallClockMs: number;
  pendingToolCallCount: number;
  usedToolCalls: number;
  roundCount: number;
  evidenceAvailable: boolean;
}

export interface RoundLimitCloseoutSnapshotInput {
  maxRounds: number;
  pendingToolCallCount?: number;
  usedToolCalls: number;
  roundCount: number;
  evidenceAvailable: boolean;
}

export interface RunToolBatchContext {
  signal?: AbortSignal;
}

export interface RunToolBatchInput<
  Ctx extends RunToolBatchContext = RunToolBatchContext,
> {
  calls: LLMToolCall[];
  ctx: Ctx;
  now(): number;
  toolLoopStartedAtMs: number;
  maxParallelToolCalls?: number;
  maxWallClockMs?: number;
  execute?: (
    call: LLMToolCall,
    ctx: Ctx,
    signal: AbortSignal | undefined,
  ) => Promise<ToolResult>;
}

export class ExecutionBudgetController {
  applyFinalToolRoundWarning(input: FinalToolRoundWarningInput): LLMMessage[] {
    return withFinalToolRoundWarning(input.messages, {
      active: input.active,
      round: input.round,
      maxRounds: input.maxRounds,
    });
  }

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

  buildRecoveryToolBudgetCloseoutSnapshot(
    input: RecoveryToolBudgetCloseoutSnapshotInput,
  ): ExecutionBudgetCloseoutSnapshot {
    return {
      reasonLines: buildFinalRecoveryBudgetCloseoutReasonLines(
        input.maxToolCalls,
      ),
      closeout: {
        reason: "recovery_tool_budget",
        maxRounds: input.maxRounds,
        pendingToolCallCount: input.pendingToolCallCount,
        toolCallCount: input.usedToolCalls,
        roundCount: input.roundCount,
        evidenceAvailable: input.evidenceAvailable,
      },
    };
  }

  buildWallClockBudgetCloseoutSnapshot(
    input: WallClockBudgetCloseoutSnapshotInput,
  ): ExecutionBudgetCloseoutSnapshot {
    return {
      reasonLines: [
        `Tool-use wall-clock budget reached (${formatDurationMs(input.maxWallClockMs)}).`,
        "Do not call more tools. Produce the best final answer from the evidence already gathered.",
        "State uncertainties and missing verification explicitly instead of trying another lookup.",
      ],
      closeout: {
        reason: "wall_clock_budget",
        maxRounds: input.maxRounds,
        maxWallClockMs: input.maxWallClockMs,
        pendingToolCallCount: input.pendingToolCallCount,
        toolCallCount: input.usedToolCalls,
        roundCount: input.roundCount,
        evidenceAvailable: input.evidenceAvailable,
      },
    };
  }

  buildRoundLimitCloseoutSnapshot(
    input: RoundLimitCloseoutSnapshotInput,
  ): ExecutionBudgetCloseoutSnapshot {
    return {
      reasonLines: [
        `Tool-use round limit reached (${input.maxRounds}).`,
        "Do not call more tools. Produce the best final answer from the evidence already gathered.",
        "State uncertainties and missing verification explicitly instead of trying another lookup.",
      ],
      closeout: {
        reason: "round_limit",
        maxRounds: input.maxRounds,
        ...(input.pendingToolCallCount === undefined
          ? {}
          : { pendingToolCallCount: input.pendingToolCallCount }),
        toolCallCount: input.usedToolCalls,
        roundCount: input.roundCount,
        evidenceAvailable: input.evidenceAvailable,
      },
    };
  }

  async runToolBatch<Ctx extends RunToolBatchContext>(
    input: RunToolBatchInput<Ctx>,
  ): Promise<ToolResult[]> {
    const execute =
      input.execute ??
      (async (call: LLMToolCall): Promise<ToolResult> => ({
        toolCallId: call.id,
        toolName: call.name,
        isError: true,
        content: `Unknown tool: ${call.name}`,
      }));
    const maxParallel = resolvePositiveIntegerLimit(
      input.maxParallelToolCalls,
      input.calls.length,
    );
    const step = Math.max(
      1,
      shouldSerializeToolBatch(input.calls) ? 1 : maxParallel,
    );
    const results: ToolResult[] = [];
    for (let index = 0; index < input.calls.length; index += step) {
      const chunk = input.calls.slice(index, index + step);
      const wallClockMs = resolveEffectiveToolLoopWallClockMs({
        ...(input.maxWallClockMs === undefined
          ? {}
          : { maxWallClockMs: input.maxWallClockMs }),
        toolCalls: chunk,
      });
      const execSignal = createToolExecutionSignal({
        elapsedMs: input.now() - input.toolLoopStartedAtMs,
        ...(input.ctx.signal ? { parentSignal: input.ctx.signal } : {}),
        ...(wallClockMs === undefined ? {} : { maxWallClockMs: wallClockMs }),
      });
      try {
        const chunkResults = await Promise.all(
          chunk.map(async (call) => {
            try {
              return await execute(call, input.ctx, execSignal.signal);
            } catch (error) {
              if (isAbortError(error)) {
                throw error;
              }
              return {
                toolCallId: call.id,
                toolName: call.name,
                isError: true,
                content: error instanceof Error ? error.message : String(error),
              };
            }
          }),
        );
        results.push(...chunkResults);
      } finally {
        execSignal.dispose();
      }
    }
    return results;
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
