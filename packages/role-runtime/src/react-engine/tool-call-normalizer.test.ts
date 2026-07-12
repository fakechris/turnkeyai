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
import { produceTaskIntentEnvelope } from "../runtime-facts/task-intent-producer";

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

test("normalizeEngineToolCalls preserves model-proposed source timeouts", () => {
  const taskPrompt = [
    "Evaluate a slow source for a release-risk note.",
    "Slow source: http://127.0.0.1:43123/slow",
    "Use a bounded attempt and explain how the mission can continue after a timeout.",
    "A follow-up may resume the same source-check context.",
  ].join("\n");
  const taskFacts = produceTaskIntentEnvelope({ taskPrompt, messages: [] }).facts;
  assert.equal(taskFacts.timeoutRecoveryRequested, true);
  assert.equal(taskFacts.sourceCheckContinuationRequested, true);

  const normalized = normalizeEngineToolCalls(
    [
      {
        id: "call-default",
        name: "sessions_spawn",
        input: {
          agent_id: "explore",
          label: "bounded source check",
          task: "Inspect http://127.0.0.1:43123/slow and return source evidence.",
        },
      },
      {
        id: "call-long",
        name: "sessions_spawn",
        input: {
          agent_id: "explore",
          label: "bounded source check",
          task: "Inspect http://127.0.0.1:43124/slow and return source evidence.",
          timeout_seconds: 90,
        },
      },
      {
        id: "call-short",
        name: "sessions_spawn",
        input: {
          agent_id: "explore",
          label: "bounded source check",
          task: "Inspect http://127.0.0.1:43125/slow and return source evidence.",
          timeout_seconds: 5,
        },
      },
    ],
    baseContext({ taskPrompt, taskFacts, exploreAvailable: true }),
  );

  assert.deepEqual(
    normalized.map((call) => call.input.timeout_seconds),
    [undefined, 90, 5],
  );
});

test("normalizeEngineToolCalls does not add task-derived timeout after a routing rewrite", () => {
  const taskPrompt = [
    "Evaluate a slow source for a release-risk note.",
    "Slow source: http://127.0.0.1:43123/slow",
    "Use a bounded attempt and explain how the mission can continue after a timeout.",
    "A follow-up may resume the same source-check context.",
  ].join("\n");
  const taskFacts = produceTaskIntentEnvelope({ taskPrompt, messages: [] }).facts;

  const normalized = normalizeEngineToolCalls(
    [
      {
        id: "call-local-fetch",
        name: "web_fetch",
        input: { url: "http://127.0.0.1:43123/slow" },
      },
    ],
    baseContext({
      taskPrompt,
      taskFacts,
      browserAvailable: true,
      exploreAvailable: true,
    }),
  );

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.name, "sessions_spawn");
  assert.equal(normalized[0]?.input.timeout_seconds, undefined);
});

test("normalizeEngineToolCalls does not infer the bounded source budget without typed facts", () => {
  const call: LLMToolCall = {
    id: "call-untyped",
    name: "sessions_spawn",
    input: {
      agent_id: "explore",
      task: "Inspect http://127.0.0.1:43123/slow after a timeout.",
    },
  };

  const normalized = normalizeEngineToolCalls(
    [call],
    baseContext({
      taskPrompt: "Use a bounded attempt and continue after a timeout.",
      exploreAvailable: true,
    }),
  );

  assert.equal(normalized[0]?.input.timeout_seconds, undefined);
});

test("normalizeEngineToolCalls does not add task-derived timeout after a prior spawn", () => {
  const taskPrompt = [
    "Evaluate a slow source with a bounded attempt.",
    "Continue the same source-check context after a timeout.",
  ].join("\n");
  const taskFacts = produceTaskIntentEnvelope({ taskPrompt, messages: [] }).facts;
  const normalized = normalizeEngineToolCalls(
    [
      {
        id: "call-later",
        name: "sessions_spawn",
        input: { agent_id: "explore", task: "Inspect a second source." },
      },
    ],
    baseContext({
      taskPrompt,
      taskFacts,
      toolTrace: [
        {
          round: 0,
          calls: [
            {
              id: "call-initial",
              name: "sessions_spawn",
              input: { agent_id: "explore", task: "Inspect the initial source." },
            },
          ],
          results: [],
        },
      ],
    }),
  );

  assert.equal(normalized[0]?.input.timeout_seconds, undefined);
});

test("normalizeEngineToolCalls does not inject a supplemental probe effect or timeout", () => {
  const taskPrompt = [
    "Continue the same slow-source source-check context after a timeout.",
    "Source: http://127.0.0.1:43123/slow",
  ].join("\n");
  const taskFacts = produceTaskIntentEnvelope({ taskPrompt, messages: [] }).facts;
  const normalized = normalizeEngineToolCalls(
    [
      {
        id: "call-model-retry",
        name: "sessions_send",
        input: {
          session_key: "worker:explore:source-check",
          message: "Retry http://127.0.0.1:43123/slow in a browser.",
        },
      },
    ],
    baseContext({
      taskPrompt,
      taskFacts,
      messages: [
        {
          role: "user",
          content: [
            "Runtime correction: resumed timeout evidence is still content-poor.",
            "Open http://127.0.0.1:43123/slow with a supplemental browser probe.",
          ].join("\n"),
        },
      ],
    }),
  );

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.name, "sessions_send");
  assert.equal(normalized[0]?.input.session_key, "worker:explore:source-check");
  assert.equal(normalized[0]?.input.timeout_seconds, undefined);
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

test("buildToolCallNormalizationContext stops lookup rewrites after a successful session list", () => {
  const ctx = buildToolCallNormalizationContext({
    taskPrompt: [
      "Task brief:",
      "Continue from the slow-source attempt in this mission.",
      "Resume the existing source-check context if possible.",
      "",
      "Recent turns:",
      "[user] Continue from the slow-source attempt in this mission.",
    ].join("\n"),
    messages: [],
    toolTrace: [
      {
        round: 0,
        calls: [{ id: "list-1", name: "sessions_list", input: { limit: 5 } }],
        results: [
          {
            toolCallId: "list-1",
            toolName: "sessions_list",
            isError: false,
            contentBytes: 2,
            content: "{}",
          },
        ],
      },
    ],
    repairMarkers: [],
  });

  assert.equal(ctx.sessionContinuationLookupDirective, null);
});

test("normalizeEngineToolCalls looks up the worker kind from a truncated continuation key", () => {
  const taskPrompt = [
    "Original user goal (verbatim):",
    "Evaluate a slow source with a bounded attempt.",
    "Latest user direction (verbatim):",
    "Continue from the previous slow-source attempt and resume the existing source-check context.",
    "[sessions_spawn]: {",
    '"status": "timeout",',
    '"agent_id": "explore",',
    '"session_key": "worker:explore:task:TASK-1:call_timeout_…"',
    "}",
  ].join("\n");
  const ctx = buildToolCallNormalizationContext({
    taskPrompt,
    messages: [],
    toolTrace: [],
    repairMarkers: [],
    capabilityInspection: { availableWorkers: ["browser", "explore"] },
  });

  const normalized = normalizeEngineToolCalls(
    [
      {
        id: "call-model-spawn",
        name: "sessions_spawn",
        input: {
          agent_id: "browser",
          task: "Retry the source with a different worker.",
        },
      },
    ],
    ctx,
  );

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.name, "sessions_list");
  assert.equal(normalized[0]?.input.agent_id, "explore");
  assert.deepEqual(normalized[0]?.input.kinds, ["explore"]);
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
