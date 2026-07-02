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

test("ExecutionBudgetController serializes order-dependent tool batches", async () => {
  const controller = createExecutionBudgetController();
  const calls = [
    { ...call("a"), name: "permission_query" },
    call("b"),
  ];
  let active = 0;
  let maxActive = 0;

  await controller.runToolBatch({
    calls,
    ctx: {},
    now: () => 0,
    toolLoopStartedAtMs: 0,
    maxParallelToolCalls: 2,
    execute: async (toolCall) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: "ok",
      };
    },
  });

  assert.equal(maxActive, 1);
});

test("ExecutionBudgetController runs concurrency-safe chunks concurrently", async () => {
  const controller = createExecutionBudgetController();
  const calls = [call("a"), call("b"), call("c")];
  let active = 0;
  let maxActive = 0;

  await controller.runToolBatch({
    calls,
    ctx: {},
    now: () => 0,
    toolLoopStartedAtMs: 0,
    maxParallelToolCalls: 2,
    execute: async (toolCall) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: "ok",
      };
    },
  });

  assert.equal(maxActive, 2);
});

test("ExecutionBudgetController converts non-abort tool failures to error results", async () => {
  const controller = createExecutionBudgetController();

  const results = await controller.runToolBatch({
    calls: [call("a")],
    ctx: {},
    now: () => 0,
    toolLoopStartedAtMs: 0,
    execute: async () => {
      throw new Error("tool exploded");
    },
  });

  assert.deepEqual(results, [
    {
      toolCallId: "a",
      toolName: "tool_a",
      isError: true,
      content: "tool exploded",
    },
  ]);
});

test("ExecutionBudgetController rethrows abort tool failures", async () => {
  const controller = createExecutionBudgetController();
  const abort = new Error("aborted");
  abort.name = "AbortError";

  await assert.rejects(
    controller.runToolBatch({
      calls: [call("a")],
      ctx: {},
      now: () => 0,
      toolLoopStartedAtMs: 0,
      execute: async () => {
        throw abort;
      },
    }),
    (error) => error === abort,
  );
});
