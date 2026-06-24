import assert from "node:assert/strict";
import test from "node:test";

import type { LLMContentBlock, LLMMessage } from "@turnkeyai/llm-adapter/types";
import type { ToolResult } from "./tool";
import { appendAssistantToolCallMessage, appendToolResultMessages } from "./tool-messages";

test("appendAssistantToolCallMessage synthesizes text + tool_use blocks", () => {
  const out = appendAssistantToolCallMessage([], {
    text: "thinking",
    toolCalls: [{ id: "c1", name: "alpha", input: { a: 1 } }],
  });
  assert.equal(out.length, 1);
  const message = out[0]!;
  assert.equal(message.role, "assistant");
  assert.deepEqual(message.content, [
    { type: "text", text: "thinking" },
    { type: "tool_use", id: "c1", name: "alpha", input: { a: 1 } },
  ]);
});

test("appendAssistantToolCallMessage omits the text block when text is empty", () => {
  const out = appendAssistantToolCallMessage([], {
    text: "",
    toolCalls: [{ id: "c1", name: "alpha", input: {} }],
  });
  assert.deepEqual(out[0]!.content, [{ type: "tool_use", id: "c1", name: "alpha", input: {} }]);
});

test("appendAssistantToolCallMessage prefers explicit content blocks", () => {
  const blocks: LLMContentBlock[] = [{ type: "text", text: "explicit" }];
  const out = appendAssistantToolCallMessage([], {
    text: "ignored",
    contentBlocks: blocks,
    toolCalls: [{ id: "c1", name: "alpha", input: {} }],
  });
  assert.deepEqual(out[0]!.content, blocks);
});

test("appendToolResultMessages builds one tool message per result", () => {
  const base: LLMMessage[] = [{ role: "user", content: "hi" }];
  const results: ToolResult[] = [
    { toolCallId: "c1", toolName: "alpha", content: "ok" },
    { toolCallId: "c2", toolName: "beta", content: "boom", isError: true },
  ];
  const out = appendToolResultMessages(base, results);
  assert.equal(out.length, 3);
  assert.deepEqual(out[1], {
    role: "tool",
    name: "alpha",
    toolCallId: "c1",
    content: [{ type: "tool_result", toolUseId: "c1", content: "ok" }],
  });
  assert.deepEqual(out[2], {
    role: "tool",
    name: "beta",
    toolCallId: "c2",
    content: [{ type: "tool_result", toolUseId: "c2", content: "boom", isError: true }],
  });
});
