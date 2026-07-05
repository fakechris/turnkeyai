import assert from "node:assert/strict";
import test from "node:test";

import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import {
  createEngineRunState,
  createRoleEngineRunState,
  type DefaultEngineRunStateValues,
} from "./engine-run-state";

interface TestRunStateValues extends DefaultEngineRunStateValues {
  ToolLoopCloseout: { reason: string; roundCount: number };
  CloseoutResult: { text: string };
  Reduction: { metadata: { id: string } };
  ReductionSnapshot: { metadata: { id: string } } | undefined;
  MemoryFlush: { metadata: { id: string } };
  CompletedSession: { metadata: { id: string } };
  CompletedSessionToolResults: string[];
  TimeoutSignal: { metadata: { id: string } };
  PendingCloseout: { reasonLines: string[]; closeout: { reason: string } };
}

test("EngineRunState keeps sticky and overwrite closeout metadata separate", () => {
  const state = createEngineRunState<TestRunStateValues>();

  state.recordToolLoopCloseoutIfAbsent({ reason: "completed", roundCount: 1 });
  state.recordToolLoopCloseoutIfAbsent({
    reason: "completed-later",
    roundCount: 2,
  });
  assert.deepEqual(state.toolLoopCloseout(), {
    reason: "completed",
    roundCount: 1,
  });

  state.recordToolLoopCloseout({ reason: "timeout", roundCount: 3 });
  assert.deepEqual(state.snapshot().toolLoopCloseout, {
    reason: "timeout",
    roundCount: 3,
  });
});

test("EngineRunState records reduction as last-wins and memory flushes as append-only", () => {
  const state = createEngineRunState<TestRunStateValues>();

  state.recordReduction({
    reduction: { metadata: { id: "r1" } },
    reductionSnapshot: { metadata: { id: "s1" } },
  });
  state.recordReduction({
    reduction: { metadata: { id: "r2" } },
    reductionSnapshot: { metadata: { id: "s2" } },
  });
  state.recordMemoryFlush({ metadata: { id: "m1" } });
  state.recordMemoryFlush({ metadata: { id: "m2" } });

  assert.deepEqual(state.reduction(), { metadata: { id: "r2" } });
  assert.deepEqual(state.reductionSnapshot(), { metadata: { id: "s2" } });
  assert.deepEqual(state.memoryFlushes(), [
    { metadata: { id: "m1" } },
    { metadata: { id: "m2" } },
  ]);
});

test("EngineRunState captures final messages by array snapshot and only fills absent values", () => {
  const state = createEngineRunState<TestRunStateValues>();
  const firstMessages: LLMMessage[] = [{ role: "user", content: "first" }];
  const secondMessages: LLMMessage[] = [{ role: "user", content: "second" }];

  state.captureFinalMessagesIfAbsent(firstMessages);
  firstMessages.push({ role: "assistant", content: "mutated after capture" });
  state.captureFinalMessagesIfAbsent(secondMessages);
  assert.deepEqual(state.finalMessages(), [{ role: "user", content: "first" }]);

  state.captureFinalMessages(secondMessages);
  assert.deepEqual(state.snapshot().finalMessages, [
    { role: "user", content: "second" },
  ]);
});

test("EngineRunState records terminal signals and pending closeout payloads", () => {
  const state = createEngineRunState<TestRunStateValues>();

  state.recordPendingCloseout({
    reasonLines: ["line"],
    closeout: { reason: "wall_clock_budget" },
  });
  state.recordCompletedSession({
    session: { metadata: { id: "completed" } },
    toolResults: ["tool-result"],
  });
  state.recordTimeoutSignal({ metadata: { id: "timeout" } });

  assert.deepEqual(state.pendingCloseout(), {
    reasonLines: ["line"],
    closeout: { reason: "wall_clock_budget" },
  });
  assert.deepEqual(state.completedSession(), {
    metadata: { id: "completed" },
  });
  assert.deepEqual(state.completedSessionToolResults(), ["tool-result"]);
  assert.deepEqual(state.timeoutSignal(), { metadata: { id: "timeout" } });
});

test("createRoleEngineRunState provides the role-runtime typed run-state shape", () => {
  const state = createRoleEngineRunState();

  state.recordToolLoopCloseout({
    reason: "round_limit",
    toolCallCount: 3,
    roundCount: 2,
  });
  state.recordReduction({
    reduction: { level: "compact", omittedSections: ["tool_history"] },
    reductionSnapshot: undefined,
  });
  state.recordMemoryFlush({
    status: "written",
    preferences: ["pref"],
    constraints: [],
    longTermNotes: [],
  });
  state.recordPendingCloseout({
    reasonLines: ["Round limit reached."],
    closeout: {
      reason: "round_limit",
      toolCallCount: 3,
      roundCount: 2,
    },
  });

  assert.deepEqual(state.toolLoopCloseout(), {
    reason: "round_limit",
    toolCallCount: 3,
    roundCount: 2,
  });
  assert.deepEqual(state.reduction(), {
    level: "compact",
    omittedSections: ["tool_history"],
  });
  assert.deepEqual(state.memoryFlushes(), [
    {
      status: "written",
      preferences: ["pref"],
      constraints: [],
      longTermNotes: [],
    },
  ]);
  assert.deepEqual(state.pendingCloseout(), {
    reasonLines: ["Round limit reached."],
    closeout: {
      reason: "round_limit",
      toolCallCount: 3,
      roundCount: 2,
    },
  });
});
