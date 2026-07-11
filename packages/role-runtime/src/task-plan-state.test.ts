import assert from "node:assert/strict";
import test from "node:test";

import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import { readTaskPlanState } from "./task-plan-state";

test("readTaskPlanState merges task lists and later typed task updates", () => {
  const messages: LLMMessage[] = [
    taskResult("tasks_list", {
      total: 2,
      showing: 2,
      tasks: [
        { id: "wi.1", n: 1, title: "Collect evidence", status: "working" },
        { id: "wi.2", n: 2, title: "Write report", status: "planning" },
      ],
    }),
    taskResult("tasks_update", {
      task: {
        id: "wi.1",
        n: 1,
        title: "Collect evidence",
        status: "done",
        output: "Verified.",
      },
    }),
  ];

  const state = readTaskPlanState(messages);

  assert.deepEqual(state.map((item) => JSON.parse(item)), [
    {
      id: "wi.1",
      n: 1,
      title: "Collect evidence",
      status: "done",
      output: "Verified.",
    },
    { id: "wi.2", n: 2, title: "Write report", status: "planning" },
  ]);
});

test("readTaskPlanState carries checkpoint plan state across compacted history", () => {
  const previous = [
    JSON.stringify({
      id: "wi.1",
      n: 1,
      title: "Collect evidence",
      status: "working",
    }),
  ];

  const state = readTaskPlanState(
    [
      taskResult("tasks_create", {
        task: {
          id: "wi.2",
          n: 2,
          title: "Write report",
          status: "planning",
        },
      }),
    ],
    previous,
  );

  assert.deepEqual(state.map((item) => JSON.parse(item)), [
    {
      id: "wi.1",
      n: 1,
      title: "Collect evidence",
      status: "working",
    },
    { id: "wi.2", n: 2, title: "Write report", status: "planning" },
  ]);
});

test("readTaskPlanState ignores malformed and unrelated tool results", () => {
  assert.deepEqual(
    readTaskPlanState([
      { role: "tool", name: "web_fetch", toolCallId: "a", content: "{}" },
      { role: "tool", name: "tasks_list", toolCallId: "b", content: "bad" },
    ]),
    [],
  );
});

function taskResult(name: string, value: unknown): LLMMessage {
  return {
    role: "tool",
    name,
    toolCallId: `${name}-call`,
    content: JSON.stringify(value),
  };
}
