import assert from "node:assert/strict";
import test from "node:test";

import type {
  RoleActivationInput,
  RuntimeProgressEvent,
} from "@turnkeyai/core-types/team";
import type { GenerateTextResult } from "@turnkeyai/llm-adapter/index";

import {
  createEngineFinalResponseBuilder,
  recordEngineReductionBoundary,
} from "./engine-final-response";
import type { EnginePolicyTrace } from "./types";
import type { ModelCallBoundaryTrace } from "../model-call-trace";
import type { RolePromptPacket } from "../prompt-policy";
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

test("createEngineFinalResponseBuilder suppresses completed tool-loop routing mentions", () => {
  const builder = createEngineFinalResponseBuilder({
    taskPrompt: "Summarize completed browser evidence.",
    initialMessages: [{ role: "user", content: "Review dashboard." }],
    readToolTraceResultContent: () => "browser evidence complete",
    policyTrace: {
      record() {},
      snapshot: () => [],
    },
    enginePolicyTraceDebugEnabled: () => false,
  });

  const reply = builder({
    finalText: "Dashboard evidence is complete. @{role-browser}",
    toolTrace: [{ round: 1, calls: [], results: [] }],
    modelCallTrace: [],
    memoryFlushes: [],
    toolLoopCloseout: {
      reason: "completed_sub_agent_final",
      toolCallCount: 1,
      roundCount: 1,
      toolName: "sessions_send",
    },
  });

  assert.equal(reply.content, "Dashboard evidence is complete. @{role-browser}");
  assert.deepEqual(reply.mentions, []);
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

test("recordEngineReductionBoundary records request-envelope reduction snapshot", async () => {
  const events: RuntimeProgressEvent[] = [];

  await recordEngineReductionBoundary({
    activation: activation(),
    packet: packet(),
    runtimeProgressRecorder: {
      async record(event) {
        events.push(event);
      },
    },
    selection: {
      modelId: "model-a",
      modelChainId: "chain-a",
    },
    reduction: {
      level: "compact",
      omittedSections: ["tool_history"],
      artifactIds: ["artifact-1"],
      envelopeHint: { toolResultCount: 2 },
    },
  });

  assert.equal(events.length, 1);
  assert.equal(
    events[0]?.metadata?.boundaryKind,
    "request_envelope_reduction",
  );
  assert.equal(events[0]?.metadata?.modelId, "model-a");
  assert.equal(events[0]?.metadata?.modelChainId, "chain-a");
  assert.equal(events[0]?.metadata?.assemblyFingerprint, "fingerprint-1");
  assert.equal(events[0]?.metadata?.reductionLevel, "compact");
  assert.deepEqual(events[0]?.metadata?.omittedSections, ["tool_history"]);
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

function activation(): RoleActivationInput {
  return {
    thread: { threadId: "thread-1" },
    flow: { flowId: "flow-1" },
    handoff: { taskId: "task-1" },
    runState: {
      runKey: "run-1",
      roleId: "role:researcher",
      lastDequeuedTaskId: "dispatch-task-1",
    },
  } as unknown as RoleActivationInput;
}

function packet(): RolePromptPacket {
  return {
    roleId: "role:researcher",
    roleName: "Researcher",
    seat: "member" as const,
    systemPrompt: "system",
    taskPrompt: "task",
    outputContract: "answer",
    suggestedMentions: [],
    promptAssembly: {
      assemblyFingerprint: "fingerprint-1",
      sectionOrder: ["task", "memory"],
      tokenEstimate: 1234,
    },
  } as unknown as RolePromptPacket;
}
