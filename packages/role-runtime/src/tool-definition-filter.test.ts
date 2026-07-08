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
  taskRequestsToolFreeRewriteOnlyRecovery,
  toolRoundLimitForTask,
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
  tool("sessions_history"),
  tool("sessions_list"),
  tool("memory_search"),
  tool("memory_get"),
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

test("filterToolDefinitionsForTask removes permission tools for visible approval fields in browser page reviews", () => {
  const filtered = filterToolDefinitionsForTask(
    allTools,
    [
      "Review this complex browser page as an operator would see it.",
      "The page combines an embedded source frame, a shadow-style review component, and a details popup workflow.",
      "Locate and click the details popup trigger, then summarize the visible operational state, owner, approval requirement, and residual risk.",
      "Use only what the browser-visible page state actually shows.",
    ].join("\n"),
  );

  assert.ok(!names(filtered).includes("permission_query"));
  assert.ok(!names(filtered).includes("permission_result"));
  assert.ok(!names(filtered).includes("permission_applied"));
  assert.ok(names(filtered).includes("sessions_spawn"));
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

test("filterToolDefinitionsForTask removes all tools for awaiting-context setup-only turns", () => {
  const prompt = [
    "Start a launch-planning thread for Helios-47.",
    "No research is needed yet; briefly acknowledge that the mission can continue when launch context is available.",
  ].join("\n");
  const filtered = filterToolDefinitionsForTask(allTools, prompt);

  assert.deepEqual(names(filtered), []);
});

test("filterToolDefinitionsForTask narrows focused durable-memory recall to memory tools", () => {
  const prompt = "Check durable memory and inspect any candidate memory.";
  const filtered = filterToolDefinitionsForTask(allTools, prompt);

  assert.equal(taskRequestsFocusedDurableMemoryRecall(prompt), true);
  assert.deepEqual(names(filtered), ["memory_search", "memory_get"]);
});

test("filterToolDefinitionsForTask treats business announcement constraints as memory-only recall", () => {
  const prompt = [
    "Continue from the corrected Borealis-23 launch handoff in this mission.",
    "Please use durable memory lookup for Borealis-23 rather than relying on the visible thread summary, then recover the current launch window, owner, hard constraint, and residual risk if they are available.",
    "Inspect any candidate memory entry before relying on it.",
    "Hard constraint: external announcement remains conditional until Legal Review confirms the data-processing addendum.",
    "If older Borealis-23 launch details conflict with the corrected handoff, treat them as stale without repeating the old values in the final answer.",
  ].join("\n");
  const filtered = filterToolDefinitionsForTask(allTools, prompt);

  assert.equal(taskRequestsFocusedDurableMemoryRecall(prompt), true);
  assert.deepEqual(names(filtered), ["memory_search", "memory_get"]);
  assert.equal(toolRoundLimitForTask(prompt, 8), 5);
});

test("filterToolDefinitionsForTask removes all tools for rewrite-only recovery", () => {
  const prompt = [
    "System recovery: the previous final answer did not satisfy required goal slots.",
    "Continue the original mission by rewriting the final answer from existing browser evidence only; missing or unverified final-answer slots: rendered/browser wording.",
    "This recovery is for completed browser-rendered closeout wording.",
    "Do not call sessions_spawn, sessions_send, or browser tools again just to repair the final wording.",
  ].join("\n");
  const filtered = filterToolDefinitionsForTask(allTools, prompt);

  assert.equal(taskRequestsToolFreeRewriteOnlyRecovery(prompt), true);
  assert.deepEqual(names(filtered), []);
});

test("focused durable-memory recall is disabled by public-source conflicts", () => {
  const prompt =
    "Check durable memory and public documentation URL before answering.";
  const filtered = filterToolDefinitionsForTask(allTools, prompt);

  assert.equal(taskRequestsFocusedDurableMemoryRecall(prompt), false);
  assert.ok(names(filtered).includes("memory_search"));
  assert.ok(names(filtered).includes("web_fetch"));
});

test("tool definition filter context builders preserve task, intent, and user message text", () => {
  const activation = {
    handoff: {
      payload: {
        intent: {
          relayBrief: "relay brief",
          recentMessages: [
            { content: "recent text" },
            { content: { nested: "value" } },
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
  assert.match(taskContext, /relay brief/);
  assert.match(taskContext, /recent text/);
  assert.match(taskContext, /"nested":"value"/);
  assert.equal(messageContext, "first user\nsecond user");
});
