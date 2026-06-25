import assert from "node:assert/strict";
import test from "node:test";

import type { LLMToolCall } from "@turnkeyai/llm-adapter/types";
import type { Tool, ToolContext } from "./tool";
import { createToolkit } from "./toolkit";
import type { ModelClient, ReActEvent, ReActHooks } from "./react-loop";
import { collectReActRun, createReActAgent } from "./react-agent";

type Ctx = ToolContext;
type Turn = { text: string; toolCalls?: LLMToolCall[]; stopReason?: string; throws?: string };

function scriptedModel(turns: Turn[]): ModelClient & {
  seen: Array<{ messageCount: number; hadTools: boolean; toolChoice: unknown }>;
} {
  const seen: Array<{ messageCount: number; hadTools: boolean; toolChoice: unknown }> = [];
  let i = 0;
  return {
    seen,
    async generate(input) {
      seen.push({ messageCount: input.messages.length, hadTools: (input.tools?.length ?? 0) > 0, toolChoice: input.toolChoice });
      const turn = turns[Math.min(i, turns.length - 1)]!;
      i += 1;
      if (turn.throws) throw new Error(turn.throws);
      return { text: turn.text, ...(turn.toolCalls ? { toolCalls: turn.toolCalls } : {}), ...(turn.stopReason ? { stopReason: turn.stopReason } : {}) };
    },
  };
}

function echoTool(name: string): Tool<Ctx> {
  return {
    definition: { name, description: name, inputSchema: { type: "object" } },
    async execute(call) {
      return { toolCallId: call.id, toolName: name, content: `ran ${name}` };
    },
  };
}

const call = (id: string, name: string): LLMToolCall => ({ id, name, input: {} });

async function drain(events: AsyncIterable<ReActEvent>): Promise<ReActEvent[]> {
  const out: ReActEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const run = (model: ModelClient, hooks: ReActHooks<Ctx>, tools = [echoTool("search")], maxRounds?: number) =>
  drain(
    createReActAgent<Ctx>({ model, toolkit: createToolkit(tools), ...(maxRounds ? { maxRounds } : {}), hooks }).run({
      messages: [{ role: "user", content: "hi" }],
      ctx: {},
    })
  );

test("filterTools restricts the tool definitions offered to the model", async () => {
  const model = scriptedModel([{ text: "answer" }]);
  let offered: string[] = [];
  await run(model, { filterTools: (defs) => { offered = defs.map((d) => d.name); return []; } }, [echoTool("a"), echoTool("b")]);
  assert.deepEqual(offered, ["a", "b"]);
  assert.equal(model.seen[0]!.hadTools, false); // filtered to none
});

test("onRoundMessages can force a tool-free synthesis round", async () => {
  const model = scriptedModel([{ text: "acknowledged", stopReason: "end_turn" }]);
  const events = await run(model, {
    onRoundMessages: (messages) => ({ messages: [...messages, { role: "user", content: "just acknowledge" }], forceToolChoice: "none" }),
  });
  assert.equal(model.seen[0]!.toolChoice, "none");
  assert.equal(model.seen[0]!.hadTools, false); // tool schemas dropped for a forced tool-free round
  assert.equal(model.seen[0]!.messageCount, 2); // injected message persisted
  assert.equal(events.at(-1)?.type === "final" && events.at(-1)!.type, "final");
});

test("onModelCallError recovers a thrown model call into a terminal synthesis", async () => {
  const model = scriptedModel([{ text: "", throws: "model exploded" }]);
  const events = await run(model, {
    onModelCallError: () => ({ text: "recovered from error" }),
  });
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "recovered from error");
  assert.equal(final?.type === "final" && final.closeoutReason, "model_call_error");
});

test("onRoundEmpty injects calls to override natural termination (forced continuation)", async () => {
  // model never asks for a tool; onRoundEmpty forces one search on round 0
  const model = scriptedModel([
    { text: "I think I'm done" },
    { text: "actually here is the answer", stopReason: "end_turn" },
  ]);
  let injected = false;
  const events = await run(model, {
    onRoundEmpty: () => {
      if (injected) return "terminate";
      injected = true;
      return { injectedCalls: [call("forced", "search")] };
    },
  });
  // a tool actually ran despite the model requesting none
  assert.ok(events.some((e) => e.type === "tool_result"));
  assert.equal(events.at(-1)?.type === "final" && events.at(-1)!.type, "final");
});

test("onBeforeExecute can reject a call, surfacing a synthetic result", async () => {
  const model = scriptedModel([
    { text: "go", toolCalls: [call("c1", "search")] },
    { text: "done" },
  ]);
  const events = await run(model, {
    onBeforeExecute: (calls) => ({
      executable: [],
      rejected: calls.map((c) => ({ toolCallId: c.id, toolName: c.name, isError: true, content: "blocked by policy" })),
    }),
  });
  const toolResult = events.find((e) => e.type === "tool_result");
  assert.ok(toolResult?.type === "tool_result" && toolResult.result.content === "blocked by policy");
  // nothing was actually started (all rejected)
  assert.equal(events.filter((e) => e.type === "tool_started").length, 0);
});

test("onAfterExecute can close out the loop with a reason", async () => {
  const model = scriptedModel([{ text: "go", toolCalls: [call("c1", "search")] }, { text: "should-not-reach" }]);
  const events = await run(model, {
    onAfterExecute: () => "evidence_complete",
    onTerminate: (reason) => ({ text: `closed: ${reason}` }),
  });
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "closed: evidence_complete");
  assert.equal(final?.type === "final" && final.closeoutReason, "evidence_complete");
});

test("onToolCallsClose closes out on the pending calls before they execute", async () => {
  const model = scriptedModel([{ text: "go", toolCalls: [call("c1", "search")] }, { text: "should-not-reach" }]);
  const events = await run(model, {
    onToolCallsClose: (calls) => (calls.length > 0 ? "pending_cap" : null),
    onTerminate: (reason) => ({ text: `closed: ${reason}` }),
  });
  // the pending round never executed and never entered the event stream, so a
  // host building its trace from events leaves this round out of the trace.
  assert.equal(events.filter((e) => e.type === "model_response").length, 0);
  assert.equal(events.filter((e) => e.type === "tool_started").length, 0);
  assert.equal(events.filter((e) => e.type === "tool_result").length, 0);
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "closed: pending_cap");
  assert.equal(final?.type === "final" && final.closeoutReason, "pending_cap");
});

test("onToolCallsClose returning null lets the round execute normally", async () => {
  const model = scriptedModel([{ text: "go", toolCalls: [call("c1", "search")] }, { text: "done" }]);
  const events = await run(model, { onToolCallsClose: () => null });
  // the round proceeded: model_response emitted and the tool actually ran
  assert.ok(events.some((e) => e.type === "model_response"));
  assert.ok(events.some((e) => e.type === "tool_result"));
  assert.equal(events.at(-1)?.type === "final" && events.at(-1)!.type, "final");
});

test("onRepairRound re-synthesizes a tool-free candidate then finalizes", async () => {
  // round 0: a draft answer (no tools) -> onRepairRound injects a repair + forces
  // a tool-free round -> round 1: the fixed answer -> onRepairRound returns null
  // -> finalize with the repaired text.
  const model = scriptedModel([{ text: "draft" }, { text: "fixed", stopReason: "end_turn" }]);
  let repaired = false;
  const events = await run(model, {
    onRepairRound: (state) => {
      if (repaired) return null;
      repaired = true;
      return {
        messages: [...state.messages, { role: "user", content: "repair: fix it" }],
        forceToolChoice: "none",
      };
    },
  });
  // the repair round was forced tool-free and saw the injected message
  assert.equal(model.seen[1]!.toolChoice, "none");
  assert.equal(model.seen[1]!.hadTools, false);
  assert.equal(model.seen[1]!.messageCount, 2); // ["hi", "repair: fix it"]
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "fixed");
});

test("onRepairRound returning null finalizes the candidate answer unchanged", async () => {
  const model = scriptedModel([{ text: "done", stopReason: "end_turn" }]);
  const events = await run(model, { onRepairRound: () => null });
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "done");
  assert.equal(model.seen.length, 1); // no extra round
});

test("onRepairRound runs the repair round even at the round budget edge", async () => {
  // maxRounds=1: round 0 is the only allowed round. A repair requested on it must
  // still re-synthesize rather than fall through to round_limit — a repair round
  // is not a tool round, matching an unbounded host loop that repairs before
  // checking the round limit.
  const model = scriptedModel([{ text: "draft" }, { text: "fixed", stopReason: "end_turn" }]);
  let repaired = false;
  const events = await run(
    model,
    {
      onRepairRound: (state) => {
        if (repaired) return null;
        repaired = true;
        return { messages: [...state.messages, { role: "user", content: "fix" }], forceToolChoice: "none" };
      },
      onTerminate: () => ({ text: "ROUND_LIMIT_SYNTH" }),
    },
    [echoTool("search")],
    1,
  );
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "fixed"); // the repair ran
});

test("terminationPredicates fire before the model call and route through onTerminate", async () => {
  const model = scriptedModel([{ text: "unused" }]);
  const events = await run(model, {
    terminationPredicates: [(state) => (state.round >= 0 ? "cap_hit" : null)],
    onTerminate: (reason) => ({ text: `stopped: ${reason}` }),
  });
  assert.equal(model.seen.length, 0); // predicate fired before any model call
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "stopped: cap_hit");
});

test("onTerminate with no model call avoids an extra generate", async () => {
  // round budget exhausted; custom onTerminate returns text directly
  const model = scriptedModel([{ text: "r", toolCalls: [call("c", "search")] }]);
  const events = await run(model, { onTerminate: () => ({ text: "FINAL" }) }, [echoTool("search")], 1);
  assert.equal(model.seen.length, 1); // only the single tool round; no synthesis call
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "FINAL");
});

test("onFinalize transforms the terminal text", async () => {
  const model = scriptedModel([{ text: "raw answer", stopReason: "end_turn" }]);
  const events = await run(model, { onFinalize: (text) => `[shaped] ${text}` });
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "[shaped] raw answer");
});

test("onProgress observes every emitted event", async () => {
  const model = scriptedModel([{ text: "go", toolCalls: [call("c1", "search")] }, { text: "done" }]);
  const observed: string[] = [];
  await run(model, { onProgress: (e) => observed.push(e.type) });
  assert.deepEqual(observed, ["model_response", "tool_started", "tool_result", "model_response", "final"]);
});

test("collectReActRun surfaces the closeout reason", async () => {
  const model = scriptedModel([{ text: "go", toolCalls: [call("c1", "search")] }, { text: "x" }]);
  const out = await collectReActRun(
    createReActAgent<Ctx>({
      model,
      toolkit: createToolkit([echoTool("search")]),
      hooks: { onAfterExecute: () => "done_reason", onTerminate: () => ({ text: "ok", stopReason: "stop" }) },
    }).run({ messages: [{ role: "user", content: "hi" }], ctx: {} })
  );
  assert.deepEqual(out, { text: "ok", rounds: 0, stopReason: "stop", closeoutReason: "done_reason" });
});

test("runToolBatch receives the executable calls and its result order drives tool_result events", async () => {
  const seen: string[] = [];
  const model = scriptedModel([
    { text: "fan out", toolCalls: [call("c1", "a"), call("c2", "b")] },
    { text: "done" },
  ]);
  const events = await run(
    model,
    {
      // Run serially, reversed, to prove the host controls execution + order.
      runToolBatch: async (calls, runOne) => {
        const out: Awaited<ReturnType<typeof runOne>>[] = [];
        for (const call of [...calls].reverse()) {
          seen.push(call.name);
          out.push(await runOne(call));
        }
        return out;
      },
    },
    [echoTool("a"), echoTool("b")]
  );
  assert.deepEqual(seen, ["b", "a"]); // host ran them serially, reversed
  const results = events.filter((e) => e.type === "tool_result");
  assert.deepEqual(
    results.map((e) => (e.type === "tool_result" ? e.result.toolName : "")),
    ["b", "a"] // tool_result order follows runToolBatch's returned order
  );
});

test("without runToolBatch the engine still runs the default Promise.all", async () => {
  const model = scriptedModel([
    { text: "go", toolCalls: [call("c1", "a")] },
    { text: "done" },
  ]);
  const events = await run(model, {}, [echoTool("a")]);
  assert.equal(events.filter((e) => e.type === "tool_result").length, 1);
});
