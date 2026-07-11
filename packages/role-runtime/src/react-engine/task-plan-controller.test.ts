import assert from "node:assert/strict";
import test from "node:test";

import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import { createTaskPlanController } from "./task-plan-controller";

const tools = [
  { name: "tasks_update", description: "", inputSchema: {} },
];
const workingPlan = [
  JSON.stringify({ id: "wi.1", title: "Verify source", status: "working" }),
];

test("TaskPlanController nudges a stale nonterminal plan after ten quiet rounds", () => {
  const repairMarkers: LLMMessage[] = [];
  const controller = createTaskPlanController();

  const result = controller.applyRoundMessagesHook({
    messages: [{ role: "user", content: "task" }],
    round: 11,
    tools,
    toolTrace: taskTrace(1),
    planState: workingPlan,
    repairMarkers,
  });

  assert.equal(result.messages.length, 2);
  assert.match(
    String(result.messages.at(-1)?.content),
    /turnkeyai\.task_plan_nudge\.v1/,
  );
  assert.match(String(result.messages.at(-1)?.content), /tasks_update/);
  assert.equal(repairMarkers.length, 1);
});

test("TaskPlanController skips fresh, terminal, or unavailable plans", () => {
  const controller = createTaskPlanController();
  const messages: LLMMessage[] = [{ role: "user", content: "task" }];

  assert.equal(
    controller.applyRoundMessagesHook({
      messages,
      round: 10,
      tools,
      toolTrace: taskTrace(1),
      planState: workingPlan,
      repairMarkers: [],
    }).messages,
    messages,
  );
  assert.equal(
    controller.applyRoundMessagesHook({
      messages,
      round: 20,
      tools,
      toolTrace: taskTrace(1),
      planState: [JSON.stringify({ id: "wi.1", status: "done" })],
      repairMarkers: [],
    }).messages,
    messages,
  );
  assert.equal(
    controller.applyRoundMessagesHook({
      messages,
      round: 20,
      tools: [],
      toolTrace: taskTrace(1),
      planState: workingPlan,
      repairMarkers: [],
    }).messages,
    messages,
  );
});

test("TaskPlanController does not repeat a nudge until task state changes", () => {
  const repairMarkers: LLMMessage[] = [];
  const controller = createTaskPlanController();
  const messages: LLMMessage[] = [{ role: "user", content: "task" }];
  const first = controller.applyRoundMessagesHook({
    messages,
    round: 11,
    tools,
    toolTrace: taskTrace(1),
    planState: workingPlan,
    repairMarkers,
  });

  const repeated = controller.applyRoundMessagesHook({
    messages: first.messages,
    round: 20,
    tools,
    toolTrace: taskTrace(1),
    planState: workingPlan,
    repairMarkers,
  });
  const afterUpdate = controller.applyRoundMessagesHook({
    messages: repeated.messages,
    round: 21,
    tools,
    toolTrace: taskTrace(12),
    planState: workingPlan,
    repairMarkers,
  });
  const staleAgain = controller.applyRoundMessagesHook({
    messages: afterUpdate.messages,
    round: 22,
    tools,
    toolTrace: taskTrace(12),
    planState: workingPlan,
    repairMarkers,
  });

  assert.equal(repeated.messages, first.messages);
  assert.equal(afterUpdate.messages, repeated.messages);
  assert.equal(staleAgain.messages.length, repeated.messages.length + 1);
});

function taskTrace(round: number): NativeToolRoundTrace[] {
  return [
    {
      round,
      calls: [{ id: `task-${round}`, name: "tasks_update", input: {} }],
      results: [],
    },
  ];
}
