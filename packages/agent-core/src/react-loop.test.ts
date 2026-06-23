import assert from "node:assert/strict";
import test from "node:test";

import type { LLMToolCall } from "@turnkeyai/llm-adapter/types";
import type { Tool, ToolContext } from "./tool";
import { createToolkit } from "./toolkit";
import type { ModelClient, ReActEvent } from "./react-loop";
import { collectReActRun, createBasicReActAgent } from "./basic-react-agent";

type Ctx = ToolContext;

type ModelTurn = { text: string; toolCalls?: LLMToolCall[]; stopReason?: string };

/** A ModelClient that replays a scripted list of turns and records what it saw. */
function scriptedModel(turns: ModelTurn[]): ModelClient & { seen: Array<{ messageCount: number; hadTools: boolean }> } {
  const seen: Array<{ messageCount: number; hadTools: boolean }> = [];
  let i = 0;
  return {
    seen,
    async generate(input) {
      seen.push({ messageCount: input.messages.length, hadTools: (input.tools?.length ?? 0) > 0 });
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return { text: turn!.text, ...(turn!.toolCalls ? { toolCalls: turn!.toolCalls } : {}), ...(turn!.stopReason ? { stopReason: turn!.stopReason } : {}) };
    },
  };
}

function echoTool(name: string): Tool<Ctx> {
  return {
    definition: { name, description: name, inputSchema: { type: "object" } },
    async execute(call) {
      return { toolCallId: call.id, toolName: name, content: `ran ${name}(${JSON.stringify(call.input)})` };
    },
  };
}

const toolCall = (id: string, name: string, input: Record<string, unknown> = {}): LLMToolCall => ({ id, name, input });

async function drain(events: AsyncIterable<ReActEvent>): Promise<ReActEvent[]> {
  const out: ReActEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

test("runs one tool round then a final answer, in order", async () => {
  const model = scriptedModel([
    { text: "let me look", toolCalls: [toolCall("c1", "search")] },
    { text: "done", stopReason: "end_turn" },
  ]);
  const agent = createBasicReActAgent<Ctx>({ model, toolkit: createToolkit([echoTool("search")]) });
  const events = await drain(agent.run({ messages: [{ role: "user", content: "hi" }], ctx: {} }));

  assert.deepEqual(
    events.map((e) => e.type),
    ["model_response", "tool_started", "tool_result", "model_response", "final"]
  );
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "done");
  assert.equal(final?.type === "final" && final.rounds, 2);
  // second model call must have seen the appended assistant + tool-result messages
  assert.equal(model.seen[0]!.messageCount, 1);
  assert.ok(model.seen[1]!.messageCount > model.seen[0]!.messageCount);
});

test("a response with no tool calls finishes immediately", async () => {
  const model = scriptedModel([{ text: "answer", stopReason: "end_turn" }]);
  const agent = createBasicReActAgent<Ctx>({ model, toolkit: createToolkit([echoTool("search")]) });
  const events = await drain(agent.run({ messages: [{ role: "user", content: "hi" }], ctx: {} }));
  assert.deepEqual(events.map((e) => e.type), ["model_response", "final"]);
  assert.equal(model.seen.length, 1);
});

test("executes multiple tool calls in one round and emits each lifecycle", async () => {
  const model = scriptedModel([
    { text: "fan out", toolCalls: [toolCall("c1", "a"), toolCall("c2", "b")] },
    { text: "synthesized" },
  ]);
  const agent = createBasicReActAgent<Ctx>({ model, toolkit: createToolkit([echoTool("a"), echoTool("b")]) });
  const events = await drain(agent.run({ messages: [{ role: "user", content: "hi" }], ctx: {} }));
  const started = events.filter((e) => e.type === "tool_started");
  const results = events.filter((e) => e.type === "tool_result");
  assert.equal(started.length, 2);
  assert.equal(results.length, 2);
});

test("onToolCalls can suppress tool calls to end the loop", async () => {
  const model = scriptedModel([{ text: "acknowledged", toolCalls: [toolCall("c1", "search")] }]);
  const agent = createBasicReActAgent<Ctx>({
    model,
    toolkit: createToolkit([echoTool("search")]),
    onToolCalls: () => [],
  });
  const events = await drain(agent.run({ messages: [{ role: "user", content: "hi" }], ctx: {} }));
  assert.deepEqual(events.map((e) => e.type), ["model_response", "final"]);
  assert.equal(model.seen.length, 1);
});

test("forces a tool-free synthesis when the round budget is exhausted", async () => {
  // model always wants a tool; maxRounds=2 -> 2 tool rounds then 1 tool-free call
  const model = scriptedModel([
    { text: "r0", toolCalls: [toolCall("c", "loop")] },
    { text: "r1", toolCalls: [toolCall("c", "loop")] },
    { text: "FINAL", stopReason: "end_turn" },
  ]);
  const agent = createBasicReActAgent<Ctx>({ model, toolkit: createToolkit([echoTool("loop")]), maxRounds: 2 });
  const events = await drain(agent.run({ messages: [{ role: "user", content: "go" }], ctx: {} }));
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "FINAL");
  assert.equal(final?.type === "final" && final.rounds, 2);
  // 3 model calls: 2 tool rounds + 1 forced synthesis; the last had no tools
  assert.equal(model.seen.length, 3);
  assert.equal(model.seen[2]!.hadTools, false);
});

test("collectReActRun returns the terminal answer", async () => {
  const model = scriptedModel([
    { text: "thinking", toolCalls: [toolCall("c1", "search")] },
    { text: "result", stopReason: "stop" },
  ]);
  const agent = createBasicReActAgent<Ctx>({ model, toolkit: createToolkit([echoTool("search")]) });
  const out = await collectReActRun(agent.run({ messages: [{ role: "user", content: "hi" }], ctx: {} }));
  assert.deepEqual(out, { text: "result", rounds: 2, stopReason: "stop" });
});

test("aborts before calling the model when the signal is already aborted", async () => {
  const model = scriptedModel([{ text: "should not run" }]);
  const agent = createBasicReActAgent<Ctx>({ model, toolkit: createToolkit([echoTool("search")]) });
  const controller = new AbortController();
  controller.abort(new Error("stop now"));
  await assert.rejects(
    () => drain(agent.run({ messages: [{ role: "user", content: "hi" }], ctx: {}, signal: controller.signal })),
    /stop now/
  );
  assert.equal(model.seen.length, 0);
});
