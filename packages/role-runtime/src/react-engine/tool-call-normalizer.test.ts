import assert from "node:assert/strict";
import test from "node:test";

import type { LLMToolCall } from "@turnkeyai/llm-adapter/index";

import {
  applyEngineToolCallsHook,
  buildToolCallNormalizationContext,
  ENGINE_TOOL_CALL_NORMALIZATION_ORDER,
  normalizeEngineToolCalls,
  type ToolCallNormalizationContext,
} from "./tool-call-normalizer";
import { createExecutionBudgetController } from "./execution-budget-controller";
import {
  createPermissionPolicy,
  type PermissionPolicy,
} from "./permission-policy";

function baseContext(
  overrides: Partial<ToolCallNormalizationContext> = {},
): ToolCallNormalizationContext {
  return {
    taskPrompt: "",
    messages: [],
    toolTrace: [],
    repairMarkers: [],
    sessionContinuationContext: "",
    sessionContinuationDirective: null,
    sessionContinuationLookupDirective: null,
    browserAvailable: false,
    exploreAvailable: false,
    ...overrides,
  };
}

test("ENGINE_TOOL_CALL_NORMALIZATION_ORDER pins the engine normalizer sequence", () => {
  assert.deepEqual(ENGINE_TOOL_CALL_NORMALIZATION_ORDER, [
    "sessionToolAlias",
    "enforceMissingApprovalGateRepair",
    "supplementalLocalTimeoutProbe",
    "sessionContinuationDirective",
    "sessionContinuationLookupDirective",
    "explicitContinuationHistory",
    "sessionToolCalls",
    "loopbackSpawnCallUrls",
    "privateUrlResearchSpawn",
    "localUrlWebFetch",
    "boundedTimeoutSourceSpawn",
    "boundedTimeoutDuplicateSourceSpawn",
    "sessionContinuationDirectiveRepeat",
    "approvalGatedBrowserSpawn",
    "limitIndependentEvidenceSpawn",
  ]);
});

test("normalizeEngineToolCalls invokes PermissionPolicy at the two approval-gate positions", () => {
  const calls: LLMToolCall[] = [
    { id: "call-1", name: "web_fetch", input: { url: "https://example.com" } },
  ];
  const seen: string[] = [];
  const permissionPolicy: PermissionPolicy = {
    normalizeMissingApprovalGateRepair(input) {
      seen.push("missing");
      return input.calls;
    },
    normalizeApprovalGatedBrowserSpawn(input) {
      seen.push("approval");
      return input.calls;
    },
    suppressReadOnlyPermissionQuery() {
      return { kind: "none" };
    },
    applySuppressDecision() {
      return null;
    },
    applySuppressToolCallsHook() {
      return null;
    },
    wouldSuppressReadOnlyPermissionQuery() {
      return false;
    },
  };

  normalizeEngineToolCalls(calls, baseContext({ permissionPolicy }));

  assert.deepEqual(seen, ["missing", "approval"]);
});

test("normalizeEngineToolCalls does not mutate the input call array", () => {
  const calls: LLMToolCall[] = [
    { id: "call-1", name: "web_fetch", input: { url: "https://example.com" } },
  ];
  const before = JSON.stringify(calls);

  normalizeEngineToolCalls(calls, baseContext());

  assert.equal(JSON.stringify(calls), before);
});

test("buildToolCallNormalizationContext resolves live continuation context and workers", () => {
  const sessionKey = "worker:browser:task-abc123";
  const ctx = buildToolCallNormalizationContext({
    taskPrompt: [
      "Original user goal (verbatim):",
      "Inspect the page.",
      "Latest user direction (verbatim):",
      "Continue the same browser session.",
    ].join("\n"),
    messages: [
      {
        role: "tool",
        toolCallId: "call-1",
        name: "sessions_spawn",
        content: [
          {
            type: "tool_result",
            toolUseId: "call-1",
            content: JSON.stringify({
              protocol: "turnkeyai.session_tool_result.v1",
              status: "completed",
              agent_id: "browser",
              session_key: sessionKey,
              final: "loaded page evidence",
            }),
          },
        ],
      },
    ],
    toolTrace: [],
    repairMarkers: [],
    capabilityInspection: {
      availableWorkers: ["browser"],
    },
  });

  assert.match(ctx.sessionContinuationContext, new RegExp(sessionKey));
  assert.equal(ctx.sessionContinuationDirective?.sessionKey, sessionKey);
  assert.equal(ctx.sessionContinuationLookupDirective, null);
  assert.equal(ctx.browserAvailable, true);
  assert.equal(ctx.exploreAvailable, false);
});

test("buildToolCallNormalizationContext does not inject session continuation for rewrite-only recovery", () => {
  const sessionKey = "worker:browser:task-abc123";
  const ctx = buildToolCallNormalizationContext({
    taskPrompt: [
      "Original user goal (verbatim):",
      "Inspect the browser-visible dashboard.",
      "Latest user direction (verbatim):",
      "System recovery: the previous final answer did not satisfy required goal slots.",
      "Continue the original mission by rewriting the final answer from existing browser evidence only.",
      "Do not call sessions_spawn, sessions_send, or browser tools again just to repair the final wording.",
    ].join("\n"),
    messages: [
      {
        role: "tool",
        toolCallId: "call-1",
        name: "sessions_spawn",
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: sessionKey,
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Browser evidence completed.",
          final_content: "Browser evidence completed.",
          payload: null,
        }),
      },
    ],
    toolTrace: [],
    repairMarkers: [],
    capabilityInspection: {
      availableWorkers: ["browser"],
    },
  });

  assert.equal(ctx.sessionContinuationDirective, null);
  assert.equal(ctx.sessionContinuationLookupDirective, null);
});

test("normalizeEngineToolCalls rewrites Source URL continuations to the matching session evidence stream", () => {
  const routeSessionKey =
    "worker:explore:task:TASK-asiawalk:call_function_route_1";
  const liveSessionKey =
    "worker:browser:task:TASK-asiawalk:call_function_live_1";
  const calls: LLMToolCall[] = [
    {
      id: "call-1",
      name: "sessions_send",
      input: {
        session_key: liveSessionKey,
        message: [
          "Source URL: http://127.0.0.1:61992/asiawalk-route",
          "Required dimensions: route shape, operator notes, route risks, stop list, distances/durations.",
        ].join("\n"),
      },
    },
  ];

  const result = normalizeEngineToolCalls(
    calls,
    baseContext({
      sessionContinuationContext: [
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-asiawalk",
          session_key: routeSessionKey,
          agent_id: "explore",
          label: "AsiaWalk Route Stream",
          status: "completed",
          tool_chain: ["explore"],
          evidence_excerpt:
            "## AsiaWalk Route Evidence\nSource URL: http://127.0.0.1:61992/asiawalk-route\nRoute shape: Seoul, Taipei, Tokyo.",
          result: "AsiaWalk route evidence completed.",
          final_content: "AsiaWalk route evidence completed.",
          payload: null,
        }),
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-asiawalk",
          session_key: liveSessionKey,
          agent_id: "browser",
          label: "AsiaWalk Live Readiness Stream",
          status: "completed",
          tool_chain: ["browser"],
          evidence_excerpt:
            "## AsiaWalk Live Readiness\nSource URL: http://127.0.0.1:61992/asiawalk-live\nReadiness: yellow.",
          result: "AsiaWalk live readiness browser evidence completed.",
          final_content: "AsiaWalk live readiness browser evidence completed.",
          payload: null,
        }),
      ].join("\n"),
    }),
  );

  assert.equal(result[0]?.input["session_key"], routeSessionKey);
});

test("applyEngineToolCallsHook normalizes before recovery-budget truncation", () => {
  const calls: LLMToolCall[] = [
    { id: "call-1", name: "sessions_history", input: {} },
    { id: "call-2", name: "web_fetch", input: { url: "https://example.com" } },
  ];
  const permissionPolicy: PermissionPolicy = {
    normalizeMissingApprovalGateRepair(input) {
      return input.calls;
    },
    normalizeApprovalGatedBrowserSpawn(input) {
      return input.calls;
    },
    suppressReadOnlyPermissionQuery() {
      return { kind: "none" };
    },
    applySuppressDecision() {
      return null;
    },
    applySuppressToolCallsHook() {
      return null;
    },
    wouldSuppressReadOnlyPermissionQuery() {
      return false;
    },
  };

  const result = applyEngineToolCallsHook({
    active: true,
    calls,
    messages: [],
    taskPrompt: "",
    toolTrace: [],
    repairMarkers: [],
    permissionPolicy,
    executionBudget: createExecutionBudgetController(),
    recoveryToolBudget: { maxToolCalls: 1 },
    recoveryToolCallsBeforeActivation: 0,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "sessions_history");
});

test("applyEngineToolCallsHook returns calls unchanged when no active tool loop exists", () => {
  const calls: LLMToolCall[] = [
    { id: "call-1", name: "sessions_history", input: {} },
  ];

  const result = applyEngineToolCallsHook({
    active: false,
    calls,
    messages: [],
    taskPrompt: "Continue a session.",
    toolTrace: [],
    repairMarkers: [],
    permissionPolicy: createPermissionPolicy(),
    executionBudget: createExecutionBudgetController(),
    recoveryToolBudget: { maxToolCalls: 0 },
    recoveryToolCallsBeforeActivation: 10,
  });

  assert.equal(result, calls);
});
