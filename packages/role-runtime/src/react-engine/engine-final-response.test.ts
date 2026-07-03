import assert from "node:assert/strict";
import test from "node:test";

import type { GenerateTextResult } from "@turnkeyai/llm-adapter/index";

import { createEngineFinalResponseBuilder } from "./engine-final-response";
import type { EnginePolicyTrace } from "./types";
import type { ModelCallBoundaryTrace } from "../model-call-trace";
import type { ToolLoopCloseoutMetadata } from "../runtime-derived-mission-report";

test("createEngineFinalResponseBuilder assembles engine final metadata from selected run state", () => {
  const policyTrace: EnginePolicyTrace = {
    record() {},
    snapshot: () => [
      {
        phase: "finalize",
        policyId: "finalization_pipeline",
        outcome: "applied",
        reason: "final response assembled",
      },
    ],
  };
  const closeout: ToolLoopCloseoutMetadata = {
    reason: "round_limit",
    toolCallCount: 2,
    roundCount: 1,
    evidenceAvailable: true,
  };
  const modelCallTrace: ModelCallBoundaryTrace[] = [
    {
      index: 1,
      phase: "tool_round",
      durationMs: 7,
      modelId: "model-trace",
      providerId: "provider-trace",
      protocol: "openai-compatible",
      adapterName: "adapter-trace",
      messageCount: 2,
      toolSchemaCount: 1,
      toolCallsReturned: 0,
      contentBlockCount: 0,
      textBytes: 4,
      usage: { inputTokens: 3, outputTokens: 5 },
    },
  ];
  const builder = createEngineFinalResponseBuilder({
    taskPrompt: "Reply to @{role-reviewer} with a concise summary.",
    initialMessages: [{ role: "user", content: "Summarize." }],
    readToolTraceResultContent: () => "tool evidence",
    policyTrace,
    enginePolicyTraceDebugEnabled: () => true,
  });

  const reply = builder({
    finalText: "Done for @{role-reviewer}.",
    closeoutResult: generateResult({
      adapterName: "closeout-adapter",
      providerId: "closeout-provider",
      modelId: "closeout-model",
      protocol: "anthropic-compatible",
      stopReason: "stop",
    }),
    lastModelResult: generateResult({
      adapterName: "last-adapter",
      providerId: "last-provider",
      modelId: "last-model",
      protocol: "openai-compatible",
    }),
    finalMessages: [{ role: "assistant", content: "Earlier." }],
    toolTrace: [{ round: 1, calls: [], results: [] }],
    modelCallTrace,
    reduction: { level: "compact", omittedSections: ["tool_history"] },
    memoryFlushes: [
      {
        status: "written",
        preferences: ["pref"],
        constraints: [],
        longTermNotes: [],
      },
    ],
    toolLoopCloseout: closeout,
  });

  assert.equal(reply.content, "Done for @{role-reviewer}.");
  assert.deepEqual(reply.mentions, ["role-reviewer"]);
  assert.equal(reply.metadata?.adapterName, "closeout-adapter");
  assert.equal(reply.metadata?.providerId, "closeout-provider");
  assert.equal(reply.metadata?.modelId, "closeout-model");
  assert.equal(reply.metadata?.protocol, "anthropic-compatible");
  assert.equal(reply.metadata?.stopReason, "stop");
  assert.deepEqual(reply.metadata?.requestEnvelopeReduction, {
    level: "compact",
    omittedSections: ["tool_history"],
  });
  assert.deepEqual(reply.metadata?.preCompactionMemoryFlushes, [
    {
      status: "written",
      preferences: ["pref"],
      constraints: [],
      longTermNotes: [],
    },
  ]);
  assert.deepEqual(reply.metadata?.toolLoopCloseout, closeout);
  assert.deepEqual(reply.metadata?.missionReport, {
    status: "partial",
    reason: "round_limit",
    source: "runtime_derived",
  });
  assert.deepEqual(reply.metadata?.modelUse, {
    calls: modelCallTrace,
    callCount: 1,
    source: "turnkeyai-role-runtime",
    totalInputTokens: 3,
    totalOutputTokens: 5,
  });
  assert.deepEqual(reply.metadata?.toolUse, {
    rounds: [{ round: 1, calls: [], results: [] }],
    toolCallCount: 0,
  });
  assert.deepEqual(reply.metadata?.enginePolicyTrace, [
    {
      phase: "finalize",
      policyId: "finalization_pipeline",
      outcome: "applied",
      reason: "final response assembled",
    },
  ]);
  assert.equal(reply.metadata?.reactEngine, true);
});

test("createEngineFinalResponseBuilder omits policy trace metadata when debug is disabled", () => {
  const builder = createEngineFinalResponseBuilder({
    taskPrompt: "Summarize.",
    initialMessages: [],
    readToolTraceResultContent: () => "",
    policyTrace: {
      record() {},
      snapshot: () => [
        {
          phase: "finalize",
          policyId: "finalization_pipeline",
          outcome: "applied",
          reason: "final response assembled",
        },
      ],
    },
    enginePolicyTraceDebugEnabled: () => false,
  });

  const reply = builder({
    finalText: "Done.",
    toolTrace: [],
    modelCallTrace: [],
    memoryFlushes: [],
  });

  assert.equal(reply.content, "Done.");
  assert.equal(reply.metadata?.reactEngine, true);
  assert.equal("enginePolicyTrace" in (reply.metadata ?? {}), false);
});

function generateResult(
  overrides: Partial<GenerateTextResult>,
): GenerateTextResult {
  return {
    text: "model text",
    adapterName: "adapter",
    providerId: "provider",
    modelId: "model",
    protocol: "openai-compatible",
    raw: {},
    ...overrides,
  };
}
