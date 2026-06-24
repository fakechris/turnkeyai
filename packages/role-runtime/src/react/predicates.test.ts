import assert from "node:assert/strict";
import test from "node:test";

import type { LLMToolCall } from "@turnkeyai/llm-adapter/types";
import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  findRepeatedFailedToolCall,
  isPositiveFiniteBudget,
  normalizeToolInputForSignature,
  roundLimitReached,
  shouldSerializeToolBatch,
  stableJson,
  toolCallSignature,
} from "./predicates";

const call = (id: string, name: string, input: Record<string, unknown> = {}): LLMToolCall => ({ id, name, input });

test("shouldSerializeToolBatch only serializes multi-call batches touching order-dependent tools", () => {
  assert.equal(shouldSerializeToolBatch([call("c1", "web_fetch")]), false); // single call
  assert.equal(shouldSerializeToolBatch([call("c1", "web_fetch"), call("c2", "sessions_spawn")]), false); // none order-dependent
  assert.equal(shouldSerializeToolBatch([call("c1", "memory_search"), call("c2", "web_fetch")]), true);
  assert.equal(shouldSerializeToolBatch([call("c1", "tasks_update"), call("c2", "tasks_list")]), true);
});

test("toolCallSignature is stable across key order and whitespace, and distinguishes inputs", () => {
  const a = toolCallSignature(call("x", "t", { a: 1, b: "  two   words " }));
  const b = toolCallSignature(call("y", "t", { b: "two words", a: 1 }));
  assert.equal(a, b); // key order + whitespace normalized; id ignored
  assert.notEqual(a, toolCallSignature(call("z", "t", { a: 2, b: "two words" })));
  assert.notEqual(a, toolCallSignature(call("z", "other", { a: 1, b: "two words" })));
});

test("normalizeToolInputForSignature collapses whitespace recursively", () => {
  assert.deepEqual(normalizeToolInputForSignature({ q: "  a   b ", nested: ["  c  d "] }), {
    q: "a b",
    nested: ["c d"],
  });
});

test("stableJson is JSON.stringify", () => {
  assert.equal(stableJson({ a: 1 }), JSON.stringify({ a: 1 }));
});

function round(calls: LLMToolCall[], results: NativeToolRoundTrace["results"]): NativeToolRoundTrace {
  return { calls, results } as NativeToolRoundTrace;
}

test("findRepeatedFailedToolCall flags a pending call that already failed maxFailures times", () => {
  const failing = call("c1", "web_fetch", { url: "x" });
  const trace: NativeToolRoundTrace[] = [
    round([failing], [{ toolCallId: "c1", isError: true } as NativeToolRoundTrace["results"][number]]),
    round([{ ...failing, id: "c2" }], [{ toolCallId: "c2", isError: true } as NativeToolRoundTrace["results"][number]]),
  ];
  const hit = findRepeatedFailedToolCall([{ ...failing, id: "c3" }], trace);
  assert.equal(hit?.toolName, "web_fetch");
  assert.equal(hit?.failureCount, 2);
});

test("findRepeatedFailedToolCall ignores cancelled results and one-off failures", () => {
  const c = call("c1", "web_fetch", { url: "x" });
  const trace: NativeToolRoundTrace[] = [
    round([c], [{ toolCallId: "c1", isError: true, cancelled: true } as NativeToolRoundTrace["results"][number]]),
    round([{ ...c, id: "c2" }], [{ toolCallId: "c2", isError: true } as NativeToolRoundTrace["results"][number]]),
  ];
  assert.equal(findRepeatedFailedToolCall([{ ...c, id: "c3" }], trace), null); // only 1 real failure
});

test("roundLimitReached", () => {
  assert.equal(roundLimitReached(7, 8), false);
  assert.equal(roundLimitReached(8, 8), true);
  assert.equal(roundLimitReached(9, 8), true);
});

test("isPositiveFiniteBudget guards positive finite numbers only", () => {
  assert.equal(isPositiveFiniteBudget(1000), true);
  assert.equal(isPositiveFiniteBudget(0), false);
  assert.equal(isPositiveFiniteBudget(-5), false);
  assert.equal(isPositiveFiniteBudget(Number.POSITIVE_INFINITY), false);
  assert.equal(isPositiveFiniteBudget(undefined), false);
});
