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

test("onModelCallError { messages } continuation runs another round instead of finalizing", async () => {
  // round 0 throws; the hook hands back rewritten messages (a host forced-recovery
  // round) so the engine adopts them and runs round 1 instead of closing out.
  const model = scriptedModel([
    { text: "", throws: "transient model error" },
    { text: "answer after forced recovery", stopReason: "end_turn" },
  ]);
  let recovered = 0;
  const events = await run(model, {
    onModelCallError: (_error, state) => {
      recovered += 1;
      return { messages: [...state.messages, { role: "user", content: "forced recovery evidence" }] };
    },
  });
  const final = events.at(-1);
  // continued to a real answer, NOT a model_call_error finalize
  assert.equal(final?.type === "final" && final.text, "answer after forced recovery");
  assert.notEqual(final?.type === "final" && final.closeoutReason, "model_call_error");
  assert.equal(recovered, 1); // the recovery fired exactly once
  assert.equal(model.seen.length, 2); // round 0 (threw) + round 1 (the adopted continuation)
  assert.equal(model.seen[1]!.messageCount, 2); // the injected recovery message was adopted
});

test("onModelCallError is awaited (an async recovery synthesis still finalizes)", async () => {
  const model = scriptedModel([{ text: "", throws: "boom" }]);
  const events = await run(model, {
    onModelCallError: async () => ({ text: "async recovery" }),
  });
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "async recovery");
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

test("onAfterExecuteContinue runs another round and pre-empts the onAfterExecute closeout", async () => {
  // round 0 executes a tool; the continuation hook fires once (handing back rewritten
  // messages, as a host forced round would) so the engine loops to round 1 instead of
  // letting onAfterExecute close the run out. The continuation must run BEFORE
  // onAfterExecute, so the closeout never fires on round 0.
  const model = scriptedModel([
    { text: "go", toolCalls: [call("c1", "search")] },
    { text: "final after forced round", stopReason: "end_turn" },
  ]);
  let continued = 0;
  const events = await run(model, {
    onAfterExecuteContinue: (_results, state) => {
      if (continued > 0) return null;
      continued += 1;
      return { messages: [...state.messages, { role: "user", content: "forced permission_result evidence" }] };
    },
    onAfterExecute: () => "would_close_out", // must be pre-empted on round 0
    onTerminate: (reason) => ({ text: `closed: ${reason}` }),
  });
  const final = events.at(-1);
  // the continuation pre-empted the closeout: a real answer, not "closed: would_close_out"
  assert.equal(final?.type === "final" && final.text, "final after forced round");
  assert.equal(continued, 1);
  assert.equal(model.seen.length, 2); // round 0 + the adopted continuation round
  assert.equal(model.seen[1]!.messageCount, 4); // user + assistant-toolcall + tool-result + injected
});

test("onAfterExecuteContinue forceToolChoice is carried into the next model call", async () => {
  // A re-prompt continuation (append a message + force a tool choice, like an inline
  // timeout-continuation that forces sessions_send) carries forceToolChoice into the
  // next round's model call.
  const model = scriptedModel([
    { text: "go", toolCalls: [call("c1", "search")] },
    { text: "done", stopReason: "end_turn" },
  ]);
  let continued = 0;
  await run(model, {
    onAfterExecuteContinue: (_results, state) => {
      if (continued > 0) return null;
      continued += 1;
      return { messages: [...state.messages, { role: "user", content: "continue via the forced tool" }], forceToolChoice: { name: "sessions_send" } };
    },
  });
  assert.equal(model.seen.length, 2);
  assert.deepEqual(model.seen[1]!.toolChoice, { name: "sessions_send" }); // carried into round 1
  assert.equal(model.seen[1]!.hadTools, true); // a real (non-"none") forced round keeps tool schemas
});

test("onAfterExecuteContinue returning null falls through to onAfterExecute", async () => {
  const model = scriptedModel([{ text: "go", toolCalls: [call("c1", "search")] }, { text: "unreached" }]);
  const events = await run(model, {
    onAfterExecuteContinue: () => null,
    onAfterExecute: () => "evidence_complete",
    onTerminate: (reason) => ({ text: `closed: ${reason}` }),
  });
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "closed: evidence_complete");
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

test("onSuppressToolCalls drops the round's calls and forces a tool-free next round without executing", async () => {
  const model = scriptedModel([
    { text: "go", toolCalls: [call("c1", "search")] },
    { text: "acknowledged", stopReason: "end_turn" },
  ]);
  let fired = 0;
  const events = await run(model, {
    onSuppressToolCalls: (calls, state) =>
      calls.length > 0 && fired++ === 0
        ? { messages: [...state.messages, { role: "user", content: "setup-only" }], forceToolChoice: "none" }
        : null,
  });
  // the suppressed round was NOT emitted/executed/traced...
  assert.equal(events.filter((e) => e.type === "tool_started").length, 0);
  assert.equal(events.filter((e) => e.type === "tool_result").length, 0);
  assert.equal(events.filter((e) => e.type === "model_response").length, 1); // only round 1
  // ...the next round was forced tool-free (tools dropped, toolChoice "none") with
  // the injected message, and finalized on the 2nd turn.
  assert.equal(model.seen[1]!.toolChoice, "none");
  assert.equal(model.seen[1]!.hadTools, false);
  assert.equal(model.seen[1]!.messageCount, 2); // injected "setup-only" message persisted
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "acknowledged");
});

test("onToolCallsClose wins over onSuppressToolCalls (a pre-execute closeout precedes suppression)", async () => {
  // A host that orders some pending-call closeouts BEFORE its suppression branch
  // keeps them in onToolCallsClose; the engine must check onToolCallsClose first so
  // those closeouts win over a drop (e.g. operator-cancelled beats setup-only).
  const model = scriptedModel([{ text: "go", toolCalls: [call("c1", "search")] }, { text: "unreached" }]);
  let suppressFired = false;
  const events = await run(model, {
    onToolCallsClose: (calls) => (calls.length > 0 ? "cancelled" : null),
    onSuppressToolCalls: (_calls, state) => {
      suppressFired = true;
      return { messages: state.messages, forceToolChoice: "none" };
    },
    onTerminate: (reason) => ({ text: `closed: ${reason}` }),
  });
  assert.equal(suppressFired, false); // the closeout short-circuited before suppression
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "closed: cancelled");
  assert.equal(final?.type === "final" && final.closeoutReason, "cancelled");
});

test("onSuppressToolCalls consumes the round budget (it is not a free repair round)", async () => {
  // The model always asks for a tool and the host always suppresses. If suppression
  // were a free repair (round--), the round index would never advance and the loop
  // would never terminate; because the suppressed round consumes the budget, the
  // loop is bounded by maxRounds (NOT MAX_REPAIR_ROUNDS=32).
  const model = scriptedModel([{ text: "go", toolCalls: [call("c1", "search")] }]);
  const events = await run(
    model,
    {
      onSuppressToolCalls: (calls, state) =>
        calls.length > 0
          ? { messages: [...state.messages, { role: "user", content: "again" }], forceToolChoice: "none" }
          : null,
      onTerminate: (reason) => ({ text: `closed: ${reason}` }),
    },
    [echoTool("search")],
    3,
  );
  // bounded by maxRounds (3 suppressed rounds), not the 32-round repair backstop.
  assert.ok(model.seen.length <= 4, `expected <=4 model calls, got ${model.seen.length}`);
  assert.equal(events.filter((e) => e.type === "tool_result").length, 0);
  assert.equal(events.at(-1)?.type === "final" && events.at(-1)!.type, "final");
});

test("onRepairRound consumesRound charges the forced tool round against the budget", async () => {
  // round 0 is a tool-free candidate; onRepairRound re-arms a REAL tool round with
  // consumesRound:true (a forced search). The forced round and each greedy follow-up
  // consume the budget, so with maxRounds=4 exactly 3 tool rounds execute before the
  // limit. Without consumesRound the forced round would be freed (round--) and a 4th
  // tool round would fit — so this count is the load-bearing guard for the flag.
  const model = scriptedModel([{ text: "draft" }, { text: "go", toolCalls: [call("c", "search")] }]);
  const events = await run(
    model,
    {
      onRepairRound: (state) =>
        state.lastText === "draft"
          ? {
              messages: [...state.messages, { role: "user", content: "get evidence" }],
              forceToolChoice: { name: "search" },
              consumesRound: true,
            }
          : null,
      onTerminate: (reason) => ({ text: `closed: ${reason}` }),
    },
    [echoTool("search")],
    4,
  );
  // the forced round is charged: exactly 3 tool rounds fit before maxRounds (a freed
  // round-- forced round would allow 4).
  assert.equal(events.filter((e) => e.type === "tool_result").length, 3);
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.type, "final");
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

test("onRepairRound { closeout } aborts the candidate and terminates with that reason", async () => {
  // A loop-breaker: instead of repairing or finalizing the candidate, onRepairRound
  // forces a closeout (routed through onTerminate) — e.g. a local-evidence fallback
  // after a repair re-synthesis still left the answer incomplete.
  const model = scriptedModel([{ text: "incomplete candidate" }]);
  const events = await run(model, {
    onRepairRound: () => ({ closeout: "forced_fallback" }),
    onTerminate: (reason) => ({ text: `closed: ${reason}` }),
  });
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "closed: forced_fallback");
  assert.equal(final?.type === "final" && final.closeoutReason, "forced_fallback");
  assert.equal(model.seen.length, 1); // no repair round ran; the candidate was aborted
});

test("onTerminate can re-arm a forced round instead of finalizing", async () => {
  // The closeout fires (onAfterExecute), but onTerminate ABORTS it the first time —
  // returning a reArm directive (rewritten messages + a forced tool choice) to run
  // another round (like a completed synthesis that still needs browser evidence). The
  // second time it finalizes. No `final` is emitted for the aborted closeout.
  const model = scriptedModel([
    { text: "r0", toolCalls: [call("c1", "search")] },
    { text: "r1", toolCalls: [call("c2", "search")] },
  ]);
  let terminates = 0;
  const events = await run(model, {
    onAfterExecute: () => "needs_more",
    onTerminate: (_reason, state) => {
      terminates += 1;
      if (terminates === 1) {
        return { reArm: { messages: [...state.messages, { role: "user", content: "gather more" }], forceToolChoice: { name: "search" } } };
      }
      return { text: `closed after ${terminates} terminates` };
    },
  });
  const finals = events.filter((e) => e.type === "final");
  assert.equal(finals.length, 1); // the aborted closeout emitted no final
  const final = events.at(-1);
  assert.equal(final?.type === "final" && final.text, "closed after 2 terminates");
  assert.equal(terminates, 2);
  assert.equal(model.seen.length, 2); // round 0 + the re-armed round 1
  assert.deepEqual(model.seen[1]!.toolChoice, { name: "search" }); // the forced choice carried
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
