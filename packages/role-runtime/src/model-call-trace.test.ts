import assert from "node:assert/strict";
import test from "node:test";

import type {
  GenerateTextInput,
  GenerateTextResult,
} from "@turnkeyai/llm-adapter/index";

import {
  appendModelCallBoundary,
  summarizeModelUseTrace,
  type ModelCallBoundaryTrace,
} from "./model-call-trace";

function result(overrides: Partial<GenerateTextResult> = {}): GenerateTextResult {
  return {
    text: "hello",
    modelId: "model-a",
    providerId: "provider-a",
    protocol: "openai-compatible",
    adapterName: "adapter-a",
    raw: {},
    ...overrides,
  } as GenerateTextResult;
}

test("appendModelCallBoundary records gateway/result metadata", () => {
  const trace: ModelCallBoundaryTrace[] = [];
  const gatewayInput: GenerateTextInput = {
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
    ],
    tools: [
      {
        name: "web_fetch",
        description: "fetch",
        inputSchema: {},
      },
    ],
    toolChoice: { type: "tool", name: "web_fetch" },
  };

  appendModelCallBoundary(trace, {
    phase: "tool_round",
    round: 2,
    startedAt: 100,
    completedAt: 135,
    gatewayInput,
    result: result({
      modelChainId: "chain-a",
      attemptedModelIds: ["model-a", "model-b"],
      stopReason: "tool_calls",
      toolCalls: [{ id: "call-1", name: "web_fetch", input: {} }],
      contentBlocks: [{ type: "text", text: "hello" }],
      usage: { inputTokens: 10, outputTokens: 5 },
      requestEnvelope: {
        messageCount: 2,
      } as NonNullable<GenerateTextResult["requestEnvelope"]>,
    }),
    reductionLevel: "compact",
  });

  assert.deepEqual(trace[0], {
    index: 1,
    phase: "tool_round",
    round: 2,
    durationMs: 35,
    modelId: "model-a",
    providerId: "provider-a",
    protocol: "openai-compatible",
    adapterName: "adapter-a",
    modelChainId: "chain-a",
    attemptedModelIds: ["model-a", "model-b"],
    stopReason: "tool_calls",
    messageCount: 2,
    toolSchemaCount: 1,
    toolChoice: "tool:web_fetch",
    toolCallsReturned: 1,
    contentBlockCount: 1,
    textBytes: 5,
    usage: { inputTokens: 10, outputTokens: 5 },
    requestEnvelope: { messageCount: 2 },
    reductionLevel: "compact",
    replayResponse: {
      text: "hello",
      contentBlocks: [{ type: "text", text: "hello" }],
      toolCalls: [{ id: "call-1", name: "web_fetch", input: {} }],
      modelId: "model-a",
      modelChainId: "chain-a",
      providerId: "provider-a",
      protocol: "openai-compatible",
      adapterName: "adapter-a",
      attemptedModelIds: ["model-a", "model-b"],
      stopReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 5 },
      requestEnvelope: { messageCount: 2 },
    },
  });
  assert.equal(
    "replayResponse" in
      ((summarizeModelUseTrace(trace).calls as Array<Record<string, unknown>>)[0] ?? {}),
    false,
  );
});

test("summarizeModelUseTrace sums provider cache economics", () => {
  const trace: ModelCallBoundaryTrace[] = [
    {
      index: 1,
      phase: "final_synthesis",
      durationMs: 1,
      modelId: "a",
      providerId: "p",
      protocol: "openai-compatible",
      adapterName: "adapter",
      messageCount: 2,
      toolSchemaCount: 0,
      toolCallsReturned: 0,
      contentBlockCount: 0,
      textBytes: 3,
      usage: {
        inputTokens: 1000,
        uncachedInputTokens: 200,
        cacheReadInputTokens: 800,
        outputTokens: 25,
      },
    },
    {
      index: 2,
      phase: "final_synthesis_repair",
      durationMs: 2,
      modelId: "b",
      providerId: "p",
      protocol: "openai-compatible",
      adapterName: "adapter",
      messageCount: 3,
      toolSchemaCount: 0,
      toolCallsReturned: 0,
      contentBlockCount: 0,
      textBytes: 4,
      usage: {
        inputTokens: 600,
        uncachedInputTokens: 100,
        cacheCreationInputTokens: 500,
        outputTokens: 15,
      },
    },
  ];

  assert.deepEqual(summarizeModelUseTrace(trace), {
    calls: trace,
    callCount: 2,
    source: "turnkeyai-role-runtime",
    totalInputTokens: 1600,
    totalUncachedInputTokens: 300,
    totalCacheReadInputTokens: 800,
    totalCacheCreationInputTokens: 500,
    totalOutputTokens: 40,
    cacheHitCalls: 1,
  });
});
