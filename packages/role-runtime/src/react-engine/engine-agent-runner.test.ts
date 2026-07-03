import assert from "node:assert/strict";
import test from "node:test";

import type { ReActEvent, ReActLoop } from "@turnkeyai/agent-core/react-loop";
import type { ToolContext, ToolResult } from "@turnkeyai/agent-core/tool";
import type { LLMToolCall } from "@turnkeyai/llm-adapter/index";

import { runEngineAgent } from "./engine-agent-runner";

interface TestContext extends ToolContext {
  activation: unknown;
}

test("runEngineAgent consumes ReAct events and dispatches engine observer callbacks", async () => {
  const call: LLMToolCall = {
    id: "call-1",
    name: "memory_search",
    input: { query: "status" },
  };
  const result: ToolResult = {
    toolCallId: "call-1",
    toolName: "memory_search",
    content: "found",
  };
  const events: ReActEvent[] = [
    { type: "model_response", round: 0, text: "Searching", toolCalls: [call] },
    { type: "tool_started", round: 0, call },
    { type: "tool_result", round: 0, result },
    { type: "final", text: "Done.", rounds: 1 },
  ];
  const seen: string[] = [];
  const agent: ReActLoop<TestContext> = {
    async *run(input) {
      assert.equal(input.ctx.activation, "activation");
      assert.deepEqual(input.messages, [{ role: "user", content: "Start." }]);
      for (const event of events) {
        yield event;
      }
    },
  };

  const finalText = await runEngineAgent({
    agent,
    messages: [{ role: "user", content: "Start." }],
    ctx: { activation: "activation" },
    observer: {
      onModelResponse(input) {
        seen.push(`model:${input.round}:${input.toolCalls.length}`);
      },
      async onToolStarted(input) {
        seen.push(`start:${input.round}:${input.call.name}`);
      },
      async onToolResult(input) {
        seen.push(`result:${input.result.toolName}`);
      },
    },
  });

  assert.equal(finalText, "Done.");
  assert.deepEqual(seen, [
    "model:0:1",
    "start:0:memory_search",
    "result:memory_search",
  ]);
});
