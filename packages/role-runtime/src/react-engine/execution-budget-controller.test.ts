import assert from "node:assert/strict";
import test from "node:test";

import type { LLMToolCall } from "@turnkeyai/llm-adapter/index";

import { createExecutionBudgetController } from "./execution-budget-controller";

function call(id: string): LLMToolCall {
  return {
    id,
    name: `tool_${id}`,
    input: { id },
  };
}

test("ExecutionBudgetController truncates pending calls to remaining recovery budget", () => {
  const controller = createExecutionBudgetController();
  const calls = [call("a"), call("b"), call("c")];

  const truncated = controller.truncateForRecoveryBudget({
    calls,
    recoveryToolBudget: { maxToolCalls: 4 },
    usedToolCalls: 2,
  });

  assert.deepEqual(
    truncated.map((item) => item.id),
    ["a", "b"],
  );
});

test("ExecutionBudgetController leaves calls unchanged when recovery budget is absent or exhausted", () => {
  const controller = createExecutionBudgetController();
  const calls = [call("a"), call("b")];

  assert.equal(
    controller.truncateForRecoveryBudget({
      calls,
      recoveryToolBudget: null,
      usedToolCalls: 0,
    }),
    calls,
  );
  assert.equal(
    controller.truncateForRecoveryBudget({
      calls,
      recoveryToolBudget: { maxToolCalls: 1 },
      usedToolCalls: 1,
    }),
    calls,
  );
});

test("ExecutionBudgetController admits executable calls and emits skipped results for over-cap calls", () => {
  const controller = createExecutionBudgetController();
  const calls = [call("a"), call("b"), call("c")];

  const decision = controller.limitToolCallsPerRound({
    calls,
    maxToolCallsPerRound: 1,
  });

  assert.deepEqual(
    decision.executable.map((item) => item.id),
    ["a"],
  );
  assert.deepEqual(
    decision.rejected.map((result) => ({
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      isError: result.isError,
      skipped: result.skipped,
      progressPhase: result.progress?.[0]?.phase,
      progressReason: result.progress?.[0]?.detail?.reason,
    })),
    [
      {
        toolCallId: "b",
        toolName: "tool_b",
        isError: true,
        skipped: true,
        progressPhase: "failed",
        progressReason: "max_tool_calls_per_round",
      },
      {
        toolCallId: "c",
        toolName: "tool_c",
        isError: true,
        skipped: true,
        progressPhase: "failed",
        progressReason: "max_tool_calls_per_round",
      },
    ],
  );
});

test("ExecutionBudgetController treats invalid per-round caps as no cap", () => {
  const controller = createExecutionBudgetController();
  const calls = [call("a"), call("b")];

  const decision = controller.limitToolCallsPerRound({
    calls,
    maxToolCallsPerRound: 0,
  });

  assert.equal(decision.executable, calls);
  assert.deepEqual(decision.rejected, []);
});
