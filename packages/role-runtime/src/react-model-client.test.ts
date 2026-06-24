import assert from "node:assert/strict";
import test from "node:test";

import type { GenerateTextInput, GenerateTextResult } from "@turnkeyai/llm-adapter/types";
import type { ToolContext } from "@turnkeyai/agent-core/tool";
import { createToolkit } from "@turnkeyai/agent-core/toolkit";
import { collectReActRun, createBasicReActAgent } from "@turnkeyai/agent-core/basic-react-agent";
import { gatewayModelClient } from "./react-model-client";

function fakeGateway(handler: (input: GenerateTextInput) => Partial<GenerateTextResult>): {
  generate(input: GenerateTextInput): Promise<GenerateTextResult>;
  seen: GenerateTextInput[];
} {
  const seen: GenerateTextInput[] = [];
  return {
    seen,
    async generate(input) {
      seen.push(input);
      const out = handler(input);
      return {
        text: out.text ?? "",
        ...(out.toolCalls ? { toolCalls: out.toolCalls } : {}),
        ...(out.stopReason ? { stopReason: out.stopReason } : {}),
        modelId: "m",
        providerId: "p",
        protocol: "anthropic-compatible",
        adapterName: "fake",
        raw: {},
      } as GenerateTextResult;
    },
  };
}

test("gatewayModelClient maps tool choice and applies defaults", async () => {
  const gateway = fakeGateway(() => ({ text: "ok", stopReason: "end_turn" }));
  const client = gatewayModelClient(gateway, { modelId: "claude-x", temperature: 0.2 });
  const result = await client.generate({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "t", description: "", inputSchema: { type: "object" } }],
    toolChoice: { name: "t" },
  });
  assert.equal(result.text, "ok");
  assert.equal(result.stopReason, "end_turn");
  const req = gateway.seen[0]!;
  assert.deepEqual(req.toolChoice, { type: "tool", name: "t" });
  assert.equal(req.modelId, "claude-x");
  assert.equal(req.temperature, 0.2);
});

test("gatewayModelClient passes string tool choices through unchanged", async () => {
  const gateway = fakeGateway(() => ({ text: "ok" }));
  const client = gatewayModelClient(gateway);
  await client.generate({ messages: [{ role: "user", content: "hi" }], toolChoice: "none" });
  assert.equal(gateway.seen[0]!.toolChoice, "none");
});

test("the real gateway adapter drives the ReAct engine end to end", async () => {
  // round 0 -> tool call; round 1 -> final answer
  let turn = 0;
  const gateway = fakeGateway(() => {
    turn += 1;
    return turn === 1
      ? { text: "searching", toolCalls: [{ id: "c1", name: "search", input: {} }] }
      : { text: "answer", stopReason: "end_turn" };
  });
  const echo: Parameters<typeof createToolkit<ToolContext>>[0] = [
    {
      definition: { name: "search", description: "search", inputSchema: { type: "object" } },
      async execute(call) {
        return { toolCallId: call.id, toolName: "search", content: "found it" };
      },
    },
  ];
  const agent = createBasicReActAgent<ToolContext>({
    model: gatewayModelClient(gateway),
    toolkit: createToolkit<ToolContext>(echo),
  });
  const out = await collectReActRun(agent.run({ messages: [{ role: "user", content: "find x" }], ctx: {} }));
  assert.equal(out.text, "answer");
  assert.equal(out.rounds, 2);
  // gateway saw the tool result in the second call
  assert.ok(gateway.seen[1]!.messages.length > gateway.seen[0]!.messages.length);
});
