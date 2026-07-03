import type { ToolResult } from "@turnkeyai/agent-core/tool";
import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import { shouldSerializeToolBatch } from "../react/predicates";
import { shouldAllowRequiredTimeoutContinuationPastWallClock } from "../tool-result-evidence";
import type { RoleToolContext, RoleToolLoopOptions } from "../tool-use";
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

export interface EngineBeforeExecuteHookInput {
  calls: LLMToolCall[];
  activeToolLoop?: Pick<RoleToolLoopOptions, "maxToolCallsPerRound">;
}

export interface EngineToolBatchHookInput {
  calls: LLMToolCall[];
  ctx: RoleToolContext;
  now(): number;
  toolLoopStartedAtMs: number;
  activeToolLoop?:
    | Pick<
        RoleToolLoopOptions,
        "executor" | "maxParallelToolCalls" | "maxWallClockMs"
      >
    | undefined;
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

export interface WallClockBudgetCloseoutSignal {
  maxWallClockMs: number | undefined;
  requiredTimeoutContinuationPastWallClock: boolean;
  readElapsedMs(): number;
  buildCloseoutSnapshot(maxWallClockMs: number): ExecutionBudgetCloseoutSnapshot;
}

export interface WallClockBudgetCloseoutSignalInput {
  toolCalls: LLMToolCall[];
  pendingToolCallCount: number;
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  maxRounds: number;
  usedToolCalls: number;
  roundCount: number;
  evidenceAvailable: boolean;
  now(): number;
  toolLoopStartedAtMs: number;
  maxWallClockMs?: number;
}

export interface PendingCallsWallClockBudgetCloseoutSignalInput
  extends Omit<
    WallClockBudgetCloseoutSignalInput,
    "toolCalls" | "pendingToolCallCount"
  > {
  pendingCalls: LLMToolCall[];
  pendingContinuation: LLMToolCall | null;
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

  applyEngineBeforeExecuteHook(
    input: EngineBeforeExecuteHookInput,
  ): ToolCallAdmissionDecision {
    return this.limitToolCallsPerRound({
      calls: input.calls,
      ...(input.activeToolLoop?.maxToolCallsPerRound === undefined
        ? {}
        : { maxToolCallsPerRound: input.activeToolLoop.maxToolCallsPerRound }),
    });
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

  buildWallClockBudgetCloseoutSignal(
    input: WallClockBudgetCloseoutSignalInput,
  ): WallClockBudgetCloseoutSignal {
    const maxWallClockMs = resolveEffectiveToolLoopWallClockMs({
      ...(input.maxWallClockMs === undefined
        ? {}
        : { maxWallClockMs: input.maxWallClockMs }),
      toolCalls: input.toolCalls,
    });
    const requiredTimeoutContinuationPastWallClock =
      shouldAllowRequiredTimeoutContinuationPastWallClock({
        taskPrompt: input.taskPrompt,
        messages: input.messages,
        toolCalls: input.toolCalls,
        toolTrace: input.toolTrace,
      });
    return {
      maxWallClockMs,
      requiredTimeoutContinuationPastWallClock,
      readElapsedMs: () => input.now() - input.toolLoopStartedAtMs,
      buildCloseoutSnapshot: (activeMaxWallClockMs: number) =>
        this.buildWallClockBudgetCloseoutSnapshot({
          maxRounds: input.maxRounds,
          maxWallClockMs: activeMaxWallClockMs,
          pendingToolCallCount: input.pendingToolCallCount,
          usedToolCalls: input.usedToolCalls,
          roundCount: input.roundCount,
          evidenceAvailable: input.evidenceAvailable,
      }),
    };
  }

  buildPendingCallsWallClockBudgetCloseoutSignal(
    input: PendingCallsWallClockBudgetCloseoutSignalInput,
  ): WallClockBudgetCloseoutSignal | null {
    if (input.pendingCalls.length > 0) {
      return this.buildWallClockBudgetCloseoutSignal({
        ...input,
        toolCalls: input.pendingCalls,
        pendingToolCallCount: input.pendingCalls.length,
      });
    }
    if (!input.pendingContinuation) {
      return null;
    }
    return this.buildWallClockBudgetCloseoutSignal({
      ...input,
      toolCalls: [input.pendingContinuation],
      pendingToolCallCount: 1,
    });
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

  async runEngineToolBatchHook(
    input: EngineToolBatchHookInput,
  ): Promise<ToolResult[]> {
    const activeToolLoop = input.activeToolLoop;
    return this.runToolBatch<RoleToolContext>({
      calls: input.calls,
      ctx: input.ctx,
      now: input.now,
      toolLoopStartedAtMs: input.toolLoopStartedAtMs,
      ...(activeToolLoop?.maxParallelToolCalls === undefined
        ? {}
        : { maxParallelToolCalls: activeToolLoop.maxParallelToolCalls }),
      ...(activeToolLoop?.maxWallClockMs === undefined
        ? {}
        : { maxWallClockMs: activeToolLoop.maxWallClockMs }),
      ...(activeToolLoop
        ? {
            execute: (call, ctx, signal) =>
              activeToolLoop.executor.execute({
                call,
                activation: ctx.activation,
                packet: ctx.packet,
                ...(signal ? { signal } : {}),
              }),
          }
        : {}),
    });
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
