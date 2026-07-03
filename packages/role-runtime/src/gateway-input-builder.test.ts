import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type { GenerateTextInput, LLMMessage } from "@turnkeyai/llm-adapter/index";

import type { RolePromptPacket } from "./prompt-policy";
import {
  buildFinalSynthesisSourceMessages,
  buildGatewayInput,
  buildToolCallArtifactCleanupMessages,
  buildToolFreeGatewayInput,
  enforceRequestedThreeLineLabelShape,
  extractMentions,
  finalSynthesisFormatContract,
  hasToolDefinition,
  replaceInitialPromptMessages,
  withoutToolUse,
} from "./gateway-input-builder";

function activation(): RoleActivationInput {
  return {
    runState: { roleId: "role:researcher" },
    thread: { threadId: "thread-1" },
    flow: { flowId: "flow-1" },
  } as RoleActivationInput;
}

function packet(): RolePromptPacket {
  return {
    roleId: "role:researcher",
    roleName: "Researcher",
    seat: "member",
    systemPrompt: "system prompt",
    taskPrompt: "task prompt",
    outputContract: "answer clearly",
    suggestedMentions: [],
    promptAssembly: {
      usedArtifacts: ["artifact-from-packet"],
      envelopeHint: {
        toolResultCount: 3,
        toolResultBytes: 300,
        inlineAttachmentBytes: 20,
        inlineImageCount: 1,
        inlineImageBytes: 10,
        inlinePdfCount: 0,
        inlinePdfBytes: 0,
        multimodalPartCount: 2,
      },
    },
  } as unknown as RolePromptPacket;
}

function tool(name: string): NonNullable<GenerateTextInput["tools"]>[number] {
  return {
    name,
    description: `${name} tool`,
    inputSchema: {},
  };
}

test("buildGatewayInput constructs prompt messages, metadata, envelope, and continuation directive", () => {
  const tools = [tool("sessions_send")];
  const gatewayInput = buildGatewayInput({
    activation: activation(),
    packet: packet(),
    modelId: "model-a",
    modelChainId: "chain-a",
    overrideSystemPrompt: "override system",
    overrideTaskPrompt: "override task",
    artifactIds: ["artifact-override"],
    envelopeHint: { toolResultCount: 4, toolResultBytes: 400 },
    tools,
    toolChoice: { type: "tool", name: "sessions_send" },
    sessionContinuationDirective: {
      sessionKey: "session-1",
      messageHint: "continue this exact session",
    },
  });

  assert.equal(gatewayInput.modelId, "model-a");
  assert.equal(gatewayInput.modelChainId, "chain-a");
  assert.equal(gatewayInput.messages[0]?.content, "override system");
  assert.match(
    String(gatewayInput.messages[1]?.content),
    /Runtime session continuation directive/,
  );
  assert.match(String(gatewayInput.messages[1]?.content), /session-1/);
  assert.deepEqual(gatewayInput.metadata, {
    roleId: "role:researcher",
    threadId: "thread-1",
    flowId: "flow-1",
  });
  assert.deepEqual(gatewayInput.envelope?.artifactIds, ["artifact-override"]);
  assert.equal(gatewayInput.envelope?.toolCount, 1);
  assert.equal(gatewayInput.envelope?.toolResultCount, 4);
  assert.equal(gatewayInput.envelope?.toolResultBytes, 400);
  assert.equal(gatewayInput.envelope?.inlineImageCount, 1);
});

test("withoutToolUse strips tool definitions and forces no tool choice", () => {
  const gatewayInput: GenerateTextInput = {
    messages: [{ role: "user", content: "task" }],
    tools: [tool("web_fetch")],
    toolChoice: { type: "tool", name: "web_fetch" },
  };

  const stripped = withoutToolUse(gatewayInput);

  assert.equal(stripped.toolChoice, "none");
  assert.equal("tools" in stripped, false);
  assert.deepEqual(stripped.messages, gatewayInput.messages);
});

test("buildToolFreeGatewayInput strips tools, replaces messages, and recomputes tool-result envelope", () => {
  const baseGatewayInput: GenerateTextInput = {
    messages: [{ role: "user", content: "old task" }],
    tools: [tool("web_fetch")],
    toolChoice: { type: "tool", name: "web_fetch" },
    envelope: {
      toolCount: 1,
      toolSchemaBytes: 123,
      toolResultCount: 99,
      toolResultBytes: 999,
      artifactIds: ["artifact-1"],
    },
  };
  const messages: LLMMessage[] = [
    { role: "user", content: "new task" },
    {
      role: "tool",
      toolCallId: "toolu-1",
      name: "web_fetch",
      content: "fresh tool evidence",
    },
  ];

  const gatewayInput = buildToolFreeGatewayInput({
    baseGatewayInput,
    messages,
  });

  assert.equal("tools" in gatewayInput, false);
  assert.equal(gatewayInput.toolChoice, "none");
  assert.deepEqual(gatewayInput.messages, messages);
  assert.equal(gatewayInput.envelope?.toolCount, 0);
  assert.equal(gatewayInput.envelope?.toolSchemaBytes, 0);
  assert.equal(gatewayInput.envelope?.toolResultCount, 1);
  assert.ok((gatewayInput.envelope?.toolResultBytes ?? 0) > 0);
  assert.deepEqual(gatewayInput.envelope?.artifactIds, ["artifact-1"]);
});

test("buildFinalSynthesisSourceMessages appends format contract and default closeout guidance", () => {
  const messages: LLMMessage[] = [{ role: "user", content: "Compare plans." }];

  const finalMessages = buildFinalSynthesisSourceMessages({
    packet: packet(),
    messages,
    maxRounds: 4,
  });

  assert.equal(finalMessages.length, 2);
  assert.equal(finalMessages[0], messages[0]);
  const guidance = String(finalMessages[1]?.content);
  assert.match(guidance, /Final synthesis format contract:/);
  assert.match(guidance, /Tool-use round limit reached \(4\)\./);
  assert.match(
    guidance,
    /Do not call more tools\. Produce the best final answer/,
  );

  const customMessages = buildFinalSynthesisSourceMessages({
    packet: packet(),
    messages,
    maxRounds: 4,
    reasonLines: ["custom closeout reason"],
  });
  assert.match(String(customMessages[1]?.content), /custom closeout reason/);
  assert.doesNotMatch(
    String(customMessages[1]?.content),
    /Tool-use round limit reached/,
  );
});

test("buildToolCallArtifactCleanupMessages appends assistant text and cleanup prompt", () => {
  const messages: LLMMessage[] = [{ role: "user", content: "Finish." }];

  const repairMessages = buildToolCallArtifactCleanupMessages({
    messages,
    resultText: "<tool_call>{}</tool_call>",
  });

  assert.deepEqual(repairMessages.slice(0, 1), messages);
  assert.deepEqual(repairMessages[1], {
    role: "assistant",
    content: "<tool_call>{}</tool_call>",
  });
  assert.match(
    String(repairMessages[2]?.content),
    /attempted to emit a tool call/,
  );
  assert.match(String(repairMessages[2]?.content), /Produce only the final/);
});

test("replaceInitialPromptMessages swaps prompt messages and preserves tool-loop history", () => {
  const messages: LLMMessage[] = [
    { role: "system", content: "old system" },
    { role: "user", content: "old task" },
    { role: "assistant", content: "used a tool" },
    { role: "tool", content: "tool result", toolCallId: "toolu-1", name: "web_fetch" },
  ];
  const reducedPromptMessages: LLMMessage[] = [
    { role: "system", content: "new system" },
    { role: "user", content: "new task" },
  ];

  assert.deepEqual(
    replaceInitialPromptMessages(messages, reducedPromptMessages),
    [...reducedPromptMessages, messages[2], messages[3]],
  );
});

test("finalSynthesisFormatContract preserves requested table columns", () => {
  const messages: LLMMessage[] = [
    {
      role: "user",
      content: "table: provider, price, evidence URL",
    },
  ];

  const contract = finalSynthesisFormatContract(
    "Compare options.",
    messages,
  ).join("\n");

  assert.match(
    contract,
    /Exact requested table columns detected: provider \| price \| evidence URL/,
  );
});

test("enforceRequestedThreeLineLabelShape normalizes requested labels only for exact three-line answers", () => {
  const taskPrompt =
    "仅需回答三行：状态、最终可见文本、证据 URL。";
  const result = enforceRequestedThreeLineLabelShape({
    taskPrompt,
    resultText:
      "**状态：** ok\n**最终可见文本：** Launched\n**证据 URL：** https://example.com",
  });

  assert.equal(
    result,
    "状态: ok\n最终可见文本: Launched\n证据 URL: https://example.com",
  );
  assert.equal(
    enforceRequestedThreeLineLabelShape({
      taskPrompt: "Summarize normally.",
      resultText: "unchanged",
    }),
    "unchanged",
  );
});

test("extractMentions and hasToolDefinition expose final reply helpers", () => {
  const tools = [tool("web_fetch")];

  assert.deepEqual(extractMentions("handoff to @{role:a} and @{role:b}"), [
    "role:a",
    "role:b",
  ]);
  assert.equal(hasToolDefinition(tools, "web_fetch"), true);
  assert.equal(hasToolDefinition(tools, "sessions_send"), false);
});
