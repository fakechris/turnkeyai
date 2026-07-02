import assert from "node:assert/strict";
import test from "node:test";

import type { LLMToolCall } from "@turnkeyai/llm-adapter/index";

import {
  buildToolCallNormalizationContext,
  ENGINE_TOOL_CALL_NORMALIZATION_ORDER,
  normalizeEngineToolCalls,
  type ToolCallNormalizationContext,
} from "./tool-call-normalizer";
import type { PermissionPolicy } from "./permission-policy";

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
