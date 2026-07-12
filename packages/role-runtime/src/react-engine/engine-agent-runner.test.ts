import assert from "node:assert/strict";
import test from "node:test";

import type {
  ModelClient,
  ReActEvent,
  ReActLoop,
  ReActHooks,
} from "@turnkeyai/agent-core/react-loop";
import type { Toolkit } from "@turnkeyai/agent-core/toolkit";
import type { ToolContext, ToolResult } from "@turnkeyai/agent-core/tool";
import type { LLMToolCall } from "@turnkeyai/llm-adapter/index";

import {
  createRoleEngineAgentRunner,
  runEngineAgent,
} from "./engine-agent-runner";

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
    { type: "tool_admitted", round: 0, call },
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
        if (event.type === "tool_started") {
          await input.onToolExecutionStart?.({
            round: event.round,
            call: event.call,
          });
        }
        if (event.type === "tool_result") {
          await input.onToolExecutionResult?.({
            round: event.round,
            result: event.result,
          });
        }
        yield event;
      }
    },
  };

  const finalText = await runEngineAgent({
    agent,
    messages: [{ role: "user", content: "Start." }],
    ctx: { activation: "activation" },
    effectLifecycle: {
      async onAdmitted(input) {
        seen.push(`admit:${input.round}:${input.call.name}`);
      },
      async onStarted(input) {
        seen.push(`ledger-start:${input.round}:${input.call.name}`);
      },
      async onResult(input) {
        seen.push(`ledger-result:${input.result.toolName}`);
      },
    },
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
    "admit:0:memory_search",
    "ledger-start:0:memory_search",
    "start:0:memory_search",
    "ledger-result:memory_search",
    "result:memory_search",
  ]);
});

test("runEngineAgent forwards a resumed initial round to agent-core", async () => {
  let observedInitialRound: number | undefined;
  const agent: ReActLoop<TestContext> = {
    async *run(input) {
      observedInitialRound = input.initialRound;
      yield { type: "final", text: "resumed", rounds: 7 };
    },
  };

  const finalText = await runEngineAgent({
    agent,
    messages: [{ role: "user", content: "Resume." }],
    initialRound: 7,
    ctx: { activation: "activation" },
    observer: {
      onModelResponse() {},
      async onToolStarted() {},
      async onToolResult() {},
    },
  });

  assert.equal(finalText, "resumed");
  assert.equal(observedInitialRound, 7);
});

test("createRoleEngineAgentRunner preserves the boundary model round for pending-call closeout", async () => {
  const call: LLMToolCall = {
    id: "call-1",
    name: "memory_search",
    input: { query: "status" },
  };
  const closeRounds: number[] = [];
  const modelCalls: Array<{ toolChoice: unknown; toolCount: number }> = [];
  const model: ModelClient = {
    async generate(input) {
      modelCalls.push({
        toolChoice: input.toolChoice,
        toolCount: input.tools?.length ?? 0,
      });
      return {
        text: "Searching",
        toolCalls: [call],
      };
    },
  };
  const toolkit: Toolkit<TestContext> = {
    definitions: () => [
      { name: "memory_search", description: "", inputSchema: {} },
    ],
    has: (name) => name === "memory_search",
    async execute(toolCall) {
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: "found",
      };
    },
  };
  const hooks: ReActHooks<TestContext> = {
    onToolCallsClose: (_calls, state) => {
      closeRounds.push(state.round);
      return state.round === 1 ? "round_limit" : null;
    },
    onTerminate: (reason) => ({
      text: `closed:${reason}`,
    }),
  };
  const run = createRoleEngineAgentRunner<TestContext>({
    model,
    toolkit,
    maxRounds,
    hooks,
  });

  const finalText = await run({
    messages: [{ role: "user", content: "Start." }],
    ctx: { activation: "activation" },
    observer: {
      onModelResponse() {},
      async onToolStarted() {},
      async onToolResult() {},
    },
  });

  assert.equal(finalText, "closed:round_limit");
  assert.deepEqual(closeRounds, [0, 1]);
  assert.equal(modelCalls.length, 2);
});

const maxRounds = 1;
