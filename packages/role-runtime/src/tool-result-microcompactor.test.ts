import assert from "node:assert/strict";
import test from "node:test";

import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import {
  MICROCOMPACTED_TOOL_RESULT_PROTOCOL,
  microcompactOldToolResults,
} from "./tool-result-microcompactor";

test("microcompactor replaces only old paired plain tool results", () => {
  const messages = [
    { role: "system", content: "stable system" },
    { role: "user", content: "stable task" },
    ...toolUnit("call-1", `EARLY_EVIDENCE_MARKER ${"x".repeat(2_000)}`),
    ...toolUnit("call-2", JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      status: "completed",
      result: "typed evidence must remain intact",
    })),
    ...toolUnit("call-3", `old plain result ${"y".repeat(2_000)}`),
    ...toolUnit("call-4", "recent four 1"),
    ...toolUnit("call-5", "recent four 2"),
    ...toolUnit("call-6", "recent four 3"),
    ...toolUnit("call-7", "recent four 4"),
  ] satisfies LLMMessage[];

  const result = microcompactOldToolResults(messages, {
    recentProtocolUnits: 4,
    previewBytes: 128,
  });
  const firstReference = JSON.parse(String(result.messages[3]?.content)) as Record<string, unknown>;
  const thirdReference = JSON.parse(String(result.messages[7]?.content)) as Record<string, unknown>;

  assert.equal(result.compactedToolResults, 2);
  assert.equal(firstReference["protocol"], MICROCOMPACTED_TOOL_RESULT_PROTOCOL);
  assert.equal(firstReference["tool_call_id"], "call-1");
  assert.match(String(firstReference["preview"]), /EARLY_EVIDENCE_MARKER/);
  assert.match(String(firstReference["sha256"]), /^[a-f0-9]{64}$/);
  assert.equal(thirdReference["tool_call_id"], "call-3");
  assert.equal(messages[5]?.content, result.messages[5]?.content, "typed evidence must remain unchanged");
  assert.deepEqual(result.messages.slice(-8), messages.slice(-8));
});

test("microcompactor leaves unpaired tool protocol and checkpoints unchanged", () => {
  const checkpoint: LLMMessage = {
    role: "user",
    content: "TurnkeyAI runtime checkpoint v1\n{\"protocol\":\"turnkeyai.runtime_checkpoint.v1\"}",
  };
  const pendingAssistant: LLMMessage = {
    role: "assistant",
    content: [{ type: "tool_use", id: "pending", name: "lookup", input: {} }],
  };
  const orphanTool: LLMMessage = {
    role: "tool",
    toolCallId: "orphan",
    name: "lookup",
    content: "orphan body",
  };
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
    checkpoint,
    pendingAssistant,
    orphanTool,
    ...toolUnit("recent-1", "one"),
    ...toolUnit("recent-2", "two"),
    ...toolUnit("recent-3", "three"),
    ...toolUnit("recent-4", "four"),
  ];

  const result = microcompactOldToolResults(messages);

  assert.equal(result.compactedToolResults, 0);
  assert.deepEqual(result.messages, messages);
});

function toolUnit(id: string, content: string): [LLMMessage, LLMMessage] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "lookup", input: { id } }],
    },
    { role: "tool", toolCallId: id, name: "lookup", content },
  ];
}
