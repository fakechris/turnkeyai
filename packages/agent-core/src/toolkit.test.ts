import assert from "node:assert/strict";
import test from "node:test";

import type { LLMToolCall } from "@turnkeyai/llm-adapter/types";
import type { Tool, ToolContext } from "./tool";
import { createToolkit } from "./toolkit";

interface TestCtx extends ToolContext {
  marker?: string;
}

function fakeTool(name: string, run: (call: LLMToolCall, ctx: TestCtx) => string): Tool<TestCtx> {
  return {
    definition: { name, description: `desc:${name}`, inputSchema: { type: "object" } },
    async execute(call, ctx) {
      return { toolCallId: call.id, toolName: call.name, content: run(call, ctx) };
    },
  };
}

const call = (name: string, input: Record<string, unknown> = {}): LLMToolCall => ({
  id: `call-${name}`,
  name,
  input,
});

test("createToolkit dispatches by tool name", async () => {
  const toolkit = createToolkit<TestCtx>([
    fakeTool("alpha", () => "ran-alpha"),
    fakeTool("beta", () => "ran-beta"),
  ]);
  const result = await toolkit.execute(call("beta"), {});
  assert.equal(result.toolName, "beta");
  assert.equal(result.content, "ran-beta");
  assert.equal(result.isError, undefined);
});

test("createToolkit returns an Unknown tool error for an unregistered name", async () => {
  const toolkit = createToolkit<TestCtx>([fakeTool("alpha", () => "ran-alpha")]);
  const result = await toolkit.execute(call("missing"), {});
  assert.equal(result.isError, true);
  assert.equal(result.content, "Unknown tool: missing");
  assert.equal(result.toolCallId, "call-missing");
  assert.equal(result.toolName, "missing");
});

test("createToolkit preserves insertion order in definitions()", () => {
  const toolkit = createToolkit<TestCtx>([
    fakeTool("one", () => ""),
    fakeTool("two", () => ""),
    fakeTool("three", () => ""),
  ]);
  assert.deepEqual(
    toolkit.definitions().map((d) => d.name),
    ["one", "two", "three"]
  );
});

test("createToolkit exposes has() for registered names", () => {
  const toolkit = createToolkit<TestCtx>([fakeTool("alpha", () => "")]);
  assert.equal(toolkit.has("alpha"), true);
  assert.equal(toolkit.has("nope"), false);
});

test("createToolkit threads ctx through to the tool", async () => {
  const toolkit = createToolkit<TestCtx>([fakeTool("alpha", (_call, ctx) => ctx.marker ?? "none")]);
  const result = await toolkit.execute(call("alpha"), { marker: "from-ctx" });
  assert.equal(result.content, "from-ctx");
});

test("createToolkit is last-wins on name override for both execute() and definitions()", async () => {
  const toolkit = createToolkit<TestCtx>([
    fakeTool("dup", () => "first"),
    fakeTool("solo", () => "solo"),
    fakeTool("dup", () => "second"),
  ]);
  // execute dispatches the last registration...
  const result = await toolkit.execute(call("dup"), {});
  assert.equal(result.content, "second");
  // ...and definitions() exposes exactly one entry per name (no stale duplicate),
  // in first-seen order.
  assert.deepEqual(
    toolkit.definitions().map((d) => d.name),
    ["dup", "solo"]
  );
});
