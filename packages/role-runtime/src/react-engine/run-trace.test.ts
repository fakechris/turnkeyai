import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderRequestError,
  RequestEnvelopeOverflowError,
} from "@turnkeyai/llm-adapter/index";

import type { ModelCallBoundaryTrace } from "../model-call-trace";
import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RunLifecycleSnapshot } from "./run-lifecycle";
import {
  RUN_INCIDENT_CATEGORIES,
  RUN_TRACE_MAX_BYTES,
  buildRunTrace,
  classifyRunFailure,
  runTraceSerializedBytes,
} from "./run-trace";

test("RunTrace unifies bounded model, tool, policy, compaction, and closeout diagnostics", () => {
  const oversizedEvidence = "e".repeat(1024 * 1024);
  const modelCalls: ModelCallBoundaryTrace[] = [
    {
      index: 1,
      phase: "tool_round",
      round: 3,
      durationMs: 125,
      modelId: "model-a",
      providerId: "provider-a",
      protocol: "openai-compatible",
      adapterName: "adapter-a",
      messageCount: 9,
      toolSchemaCount: 2,
      toolCallsReturned: 1,
      contentBlockCount: 1,
      textBytes: 14,
      usage: {
        inputTokens: 720,
        uncachedInputTokens: 120,
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 100,
        outputTokens: 35,
      },
      requestEnvelope: {
        messageCount: 9,
        promptChars: 2_000,
        promptBytes: 2_100,
        metadataBytes: 10,
        artifactCount: 0,
        toolCount: 2,
        toolSchemaBytes: 300,
        toolResultCount: 1,
        toolResultBytes: 800,
        inlineAttachmentBytes: 0,
        inlineImageCount: 0,
        inlineImageBytes: 0,
        inlinePdfCount: 0,
        inlinePdfBytes: 0,
        multimodalPartCount: 0,
        totalSerializedBytes: 3_210,
        estimatedInputTokens: 700,
        inputTokenLimit: 1_000,
        overLimitKeys: [],
      },
      retryDiagnostics: {
        totalAttempts: 3,
        totalRetries: 2,
        models: [
          {
            modelId: "model-a",
            attempts: 3,
            retries: 2,
            errors: ["server_error", "timeout"],
          },
        ],
      },
    },
  ];
  const toolRounds: NativeToolRoundTrace[] = [
    {
      round: 3,
      calls: [{ id: "call-1", name: "web_fetch", input: { url: "https://example.test" } }],
      results: [
        {
          toolCallId: "call-1",
          toolName: "web_fetch",
          isError: true,
          skipped: true,
          contentBytes: Buffer.byteLength(oversizedEvidence),
          content: JSON.stringify({
            protocol: "turnkeyai.tool_argument_error.v1",
            code: "invalid_tool_arguments",
            oversizedEvidence,
          }),
        },
      ],
    },
  ];

  const trace = buildRunTrace({
    startedAt: 1_000,
    completedAt: 1_500,
    resumedAfterCrash: true,
    modelCalls,
    toolRounds,
    policyEntries: [
      {
        phase: "before_execute",
        policyId: "tool_argument_validation",
        outcome: "applied",
        reason: "invalid arguments were returned to the model",
      },
    ],
    compactions: [
      {
        round: 2,
        forced: false,
        messageCountBefore: 24,
        messageCountAfter: 8,
        sourceMessageCount: 16,
      },
    ],
    pruning: [
      {
        round: 3,
        prunedToolResults: 1,
        toolResultBytesBefore: 90_000,
        toolResultBytesAfter: 4_000,
        messageCountBefore: 20,
        messageCountAfter: 12,
        reasons: ["hard_limit"],
      },
    ],
    externalizations: [
      {
        round: 3,
        toolCallId: "call-1",
        toolName: "web_fetch",
        bytes: 90_000,
        artifactId: "artifact-1",
        sha256: "sha-1",
      },
    ],
    closeoutReason: "round_limit",
    finalText: "Partial answer with durable evidence.",
  });

  assert.equal(trace.protocol, "turnkeyai.run_trace.v1");
  assert.equal(trace.wallClock.durationMs, 500);
  assert.deepEqual(trace.modelCalls[0]?.tokens, {
    estimatedInput: 700,
    actualInput: 720,
    uncachedInput: 120,
    cacheRead: 500,
    cacheCreation: 100,
    output: 35,
    inputLimit: 1_000,
  });
  assert.equal(trace.toolRounds[0]?.results[0]?.contentBytes, 1024 * 1024);
  assert.equal(typeof trace.toolRounds[0]?.results[0]?.contentSha256, "string");
  assert.equal(JSON.stringify(trace).includes(oversizedEvidence), false);
  assert.equal(trace.incidents.provider_5xx, 1);
  assert.equal(trace.incidents.provider_timeout, 1);
  assert.equal(trace.incidents.tool_arg_invalid, 1);
  assert.equal(trace.incidents.round_limit, 1);
  assert.equal(trace.incidents.resume_after_crash, 1);
  assert.equal(trace.outcome.status, "partial");
  assert.ok(runTraceSerializedBytes(trace) <= RUN_TRACE_MAX_BYTES);
});

test("RunTrace classifies terminal provider and envelope errors without message matching", () => {
  assert.equal(
    classifyRunFailure(
      new ProviderRequestError("upstream failed", {
        status: 503,
        code: "server_error",
        retryable: true,
      }),
    ),
    "provider_5xx",
  );
  assert.equal(
    classifyRunFailure(
      new ProviderRequestError("idle timeout", {
        code: "timeout",
        retryable: true,
      }),
    ),
    "provider_timeout",
  );
  assert.equal(
    classifyRunFailure(
      new ProviderRequestError("provider aborted a partial response", {
        code: "incomplete_response",
        retryable: true,
      }),
    ),
    "provider_incomplete_response",
  );
  assert.equal(
    classifyRunFailure(
      new RequestEnvelopeOverflowError({
        diagnostics: {
          messageCount: 1,
          promptChars: 1,
          promptBytes: 1,
          metadataBytes: 0,
          artifactCount: 0,
          toolCount: 0,
          toolSchemaBytes: 0,
          toolResultCount: 0,
          toolResultBytes: 0,
          inlineAttachmentBytes: 0,
          inlineImageCount: 0,
          inlineImageBytes: 0,
          inlinePdfCount: 0,
          inlinePdfBytes: 0,
          multimodalPartCount: 0,
          totalSerializedBytes: 1,
          overLimitKeys: ["messageCount"],
        },
      }),
    ),
    "envelope_overflow_terminal",
  );
});

test("RunTrace reports started but unfinished provider attempts without replay responses", () => {
  const lifecycle: RunLifecycleSnapshot = {
    events: [
      {
        kind: "model_attempt_started",
        at: 100,
        attemptId: "tool_round:4:1:1",
        phase: "tool_round",
        round: 4,
      },
      {
        kind: "provider_activity",
        at: 150,
        attemptId: "tool_round:4:1:1",
        activity: "body",
      },
    ],
    totals: {
      startedModelAttempts: 1,
      completedModelAttempts: 0,
      failedModelAttempts: 0,
      retryWaits: 0,
      providerActivityEvents: 1,
    },
    lastProviderActivityAt: 150,
    inFlightAttemptIds: ["tool_round:4:1:1"],
  };
  const trace = buildRunTrace({
    startedAt: 50,
    completedAt: 200,
    resumedAfterCrash: false,
    modelCalls: [],
    toolRounds: [],
    policyEntries: [],
    compactions: [],
    pruning: [],
    externalizations: [],
    finalText: "",
    lifecycle,
    failureCategory: "provider_timeout",
  });

  assert.equal(trace.lifecycle.startedModelAttempts, 1);
  assert.equal(trace.lifecycle.completedModelAttempts, 0);
  assert.equal(trace.totals.modelCalls, 0);
  assert.equal(trace.lifecycle.lastProviderActivityAt, 150);
  assert.deepEqual(trace.lifecycle.inFlightAttemptIds, [
    "tool_round:4:1:1",
  ]);
  assert.deepEqual(trace.modelCalls, []);
});

test("RunTrace treats completed sub-agent closeout as a completed outcome", () => {
  const trace = buildRunTrace({
    startedAt: 1,
    completedAt: 2,
    resumedAfterCrash: false,
    modelCalls: [],
    toolRounds: [],
    policyEntries: [],
    compactions: [],
    pruning: [],
    externalizations: [],
    closeoutReason: "completed_sub_agent_final",
    finalText: "Complete evidence-backed answer.",
  });

  assert.equal(trace.outcome.status, "completed");
  assert.deepEqual(trace.incidents, {});
});

test("RunTrace incident taxonomy is closed and duplicate-free", () => {
  assert.equal(new Set(RUN_INCIDENT_CATEGORIES).size, RUN_INCIDENT_CATEGORIES.length);
  assert.deepEqual([...RUN_INCIDENT_CATEGORIES].sort(), [
    "envelope_overflow_terminal",
    "excessive_session_continuation",
    "model_error_unknown",
    "operator_cancelled",
    "provider_authentication",
    "provider_5xx",
    "provider_incomplete_response",
    "provider_network",
    "provider_not_found",
    "provider_rate_limit",
    "provider_timeout",
    "pseudo_tool_call",
    "recovery_tool_budget",
    "repair_non_convergence",
    "repeated_session_inspection",
    "resume_after_crash",
    "round_limit",
    "sub_agent_timeout",
    "tool_arg_invalid",
    "wall_clock_budget",
  ].sort());
});
