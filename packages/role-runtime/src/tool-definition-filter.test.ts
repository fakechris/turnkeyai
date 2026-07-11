import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type { GenerateTextInput, LLMMessage } from "@turnkeyai/llm-adapter/index";

import {
  buildToolDefinitionFilterMessageContext,
  buildToolDefinitionFilterTaskContext,
  filterToolDefinitionsForTask,
  taskAllowsTaskTrackingTools,
  taskRequestsFocusedDurableMemoryRecall,
} from "./tool-definition-filter";

function tool(name: string): NonNullable<GenerateTextInput["tools"]>[number] {
  return {
    name,
    description: `${name} tool`,
    inputSchema: {},
  };
}

const allTools = [
  tool("web_fetch"),
  tool("sessions_send"),
  tool("sessions_spawn"),
  tool("memory_search"),
  tool("memory_get"),
  tool("artifacts_read"),
  tool("permission_query"),
  tool("permission_result"),
  tool("permission_applied"),
  tool("tasks_list"),
  tool("tasks_create"),
  tool("tasks_update"),
];

function names(tools: GenerateTextInput["tools"]): string[] {
  return (tools ?? []).map((item) => item.name);
}

test("filterToolDefinitionsForTask removes permission tools for read-only tasks", () => {
  const filtered = filterToolDefinitionsForTask(
    allTools,
    "Read public documentation and summarize the release notes.",
  );

  assert.ok(!names(filtered).includes("permission_query"));
  assert.ok(!names(filtered).includes("permission_result"));
  assert.ok(!names(filtered).includes("permission_applied"));
  assert.ok(names(filtered).includes("web_fetch"));
  assert.ok(names(filtered).includes("tasks_list"));
});

test("filterToolDefinitionsForTask removes task tracking tools for source-check continuations", () => {
  const prompt =
    "slow-source source-check continue after timeout and residual risk; please continue the same source-check context.";
  const filtered = filterToolDefinitionsForTask(allTools, prompt);

  assert.equal(taskAllowsTaskTrackingTools(prompt), false);
  assert.ok(!names(filtered).includes("tasks_list"));
  assert.ok(!names(filtered).includes("tasks_create"));
  assert.ok(!names(filtered).includes("tasks_update"));
  assert.ok(names(filtered).includes("sessions_send"));
});

test("filterToolDefinitionsForTask narrows focused durable-memory recall to memory tools", () => {
  const prompt = "Check durable memory and inspect any candidate memory.";
  const filtered = filterToolDefinitionsForTask(allTools, prompt);

  assert.equal(taskRequestsFocusedDurableMemoryRecall(prompt), true);
  assert.deepEqual(names(filtered), [
    "memory_search",
    "memory_get",
    "artifacts_read",
  ]);
});

test("focused durable-memory recall is disabled by public-source conflicts", () => {
  const prompt =
    "Check durable memory and public documentation URL before answering.";
  const filtered = filterToolDefinitionsForTask(allTools, prompt);

  assert.equal(taskRequestsFocusedDurableMemoryRecall(prompt), false);
  assert.ok(names(filtered).includes("memory_search"));
  assert.ok(names(filtered).includes("web_fetch"));
});

test("tool definition filter context builders preserve task and user message text", () => {
  const activation = {
    handoff: {
      payload: {
        intent: {
          relayBrief: "relay brief",
          recentMessages: [
            { role: "user", content: "recent text" },
            { role: "user", content: { nested: "value" } },
          ],
        },
      },
    },
  } as RoleActivationInput;
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "first user" },
    {
      role: "assistant",
      content: "assistant",
    },
    {
      role: "user",
      content: [{ type: "text", text: "second user" }],
    },
  ];

  const taskContext = buildToolDefinitionFilterTaskContext(
    activation,
    "task prompt",
  );
  const messageContext = buildToolDefinitionFilterMessageContext(messages);

  assert.match(taskContext, /task prompt/);
  assert.match(taskContext, /recent text/);
  assert.match(taskContext, /"nested":"value"/);
  assert.doesNotMatch(taskContext, /relay brief/);
  assert.equal(messageContext, "first user\nsecond user");
});

test("assistant history cannot grant permission tools during read-only recovery", () => {
  const activation = {
    handoff: {
      payload: {
        intent: {
          relayBrief: "Continue the original read-only dashboard review.",
          recentMessages: [
            {
              role: "user",
              content: "Review the rendered dashboard and report residual risk.",
            },
            {
              role: "assistant",
              content:
                "An approval-gated browser.form.submit dry-run action is available.",
            },
            {
              role: "tool",
              content: "permission_query can request operator approval.",
            },
          ],
        },
      },
    },
  } as RoleActivationInput;
  const taskContext = buildToolDefinitionFilterTaskContext(
    activation,
    "System recovery: verify only the missing rendered browser evidence and residual risk.",
  );

  const filtered = filterToolDefinitionsForTask(allTools, taskContext);

  assert.ok(!names(filtered).includes("permission_query"));
  assert.ok(!names(filtered).includes("permission_result"));
  assert.ok(!names(filtered).includes("permission_applied"));
});
