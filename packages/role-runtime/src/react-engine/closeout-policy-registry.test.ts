import assert from "node:assert/strict";
import test from "node:test";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { ExecutionBudgetCloseoutSnapshot } from "./execution-budget-controller";
import type { RemainingPendingCallsCloseoutInput } from "./closeout-policy-registry";
import type { LLMToolCall } from "./types";
import {
  createCloseoutPolicyRegistry,
  ENGINE_CLOSEOUT_POLICY_ORDER,
} from "./closeout-policy-registry";

function recoverySnapshot(): ExecutionBudgetCloseoutSnapshot {
  return {
    reasonLines: ["Final recovery tool budget reached (2 tool calls)."],
    closeout: {
      reason: "recovery_tool_budget",
      maxRounds: 3,
      pendingToolCallCount: 1,
      toolCallCount: 2,
      roundCount: 2,
      evidenceAvailable: false,
    },
  };
}

function cancelledSessionTaskPrompt(latestUserText = "Summarize the status."): string {
  return [
    "Task brief:",
    latestUserText,
    "",
    "Previous tool result:",
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      session_key: "worker:explore:cancelled:toolu-cancel",
      agent_id: "explore",
      status: "cancelled",
      result: "cancelled by operator",
    }),
    "",
    "Recent turns:",
    `[user] ${latestUserText}`,
  ].join("\n");
}

function roundLimitSnapshot(): ExecutionBudgetCloseoutSnapshot {
  return {
    reasonLines: ["Tool-use round limit reached (3)."],
    closeout: {
      reason: "round_limit",
      maxRounds: 3,
      pendingToolCallCount: 1,
      toolCallCount: 2,
      roundCount: 3,
      evidenceAvailable: true,
    },
  };
}

function wallClockSnapshot(): ExecutionBudgetCloseoutSnapshot {
  return {
    reasonLines: ["Tool-use wall-clock budget reached (1m 30s)."],
    closeout: {
      reason: "wall_clock_budget",
      maxRounds: 3,
      maxWallClockMs: 90_000,
      pendingToolCallCount: 1,
      toolCallCount: 2,
      roundCount: 3,
      evidenceAvailable: true,
    },
  };
}

function remainingPendingInput(
  overrides: Partial<RemainingPendingCallsCloseoutInput> = {},
): RemainingPendingCallsCloseoutInput {
  return {
    pendingCalls: [],
    pendingToolCallCount: 1,
    pendingContinuation: false,
    lastText: "running sessions",
    wallClockBudget: null,
    taskPrompt: "Summarize the gathered evidence.",
    messages: [],
    sessionContext: "",
    toolTrace: [],
    maxRounds: 3,
    usedToolCalls: 2,
    roundCount: 2,
    evidenceAvailable: true,
    buildRoundLimitCloseoutSnapshot: roundLimitSnapshot,
    ...overrides,
  };
}

function toolCall(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): LLMToolCall {
  return { id, name, input };
}

function traceRound(
  round: number,
  calls: LLMToolCall[],
  results: NativeToolRoundTrace["results"],
): NativeToolRoundTrace {
  return { round, calls, results };
}

test("ENGINE_CLOSEOUT_POLICY_ORDER pins terminal closeout precedence", () => {
  assert.deepEqual([...ENGINE_CLOSEOUT_POLICY_ORDER], [
    "recovery_tool_budget",
    "operator_cancelled",
    "pseudo_tool_call",
    "wall_clock_budget",
    "round_limit",
    "repeated_tool_failure",
    "repeated_session_inspection",
    "excessive_session_continuation",
    "sub_agent_timeout",
    "completed_sub_agent_final",
    "tool_evidence_fallback",
    "model_error",
  ]);
  assert.equal(
    new Set(ENGINE_CLOSEOUT_POLICY_ORDER).size,
    ENGINE_CLOSEOUT_POLICY_ORDER.length,
  );
});

test("CloseoutPolicyRegistry returns null before recovery budget is exhausted", () => {
  const registry = createCloseoutPolicyRegistry();
  let builtSnapshot = false;

  const decision = registry.evaluateRecoveryToolBudget({
    recoveryToolBudget: { maxToolCalls: 3 },
    usedToolCalls: 2,
    pendingToolCallCount: 1,
    messages: [],
    repairMarkers: [],
    resultText: "still running",
    buildCloseoutSnapshot: () => {
      builtSnapshot = true;
      return recoverySnapshot();
    },
  });

  assert.equal(decision, null);
  assert.equal(builtSnapshot, false);
});

test("CloseoutPolicyRegistry defers exhausted recovery budget to repair when needed", () => {
  const registry = createCloseoutPolicyRegistry();
  let builtSnapshot = false;

  const decision = registry.evaluateRecoveryToolBudget({
    recoveryToolBudget: { maxToolCalls: 2 },
    usedToolCalls: 2,
    pendingToolCallCount: 0,
    messages: [],
    repairMarkers: [],
    resultText: "@{role-explore} continue the recovery",
    buildCloseoutSnapshot: () => {
      builtSnapshot = true;
      return recoverySnapshot();
    },
  });

  assert.deepEqual(decision, {
    kind: "defer",
    policyId: "recovery_tool_budget",
    deferTo: "repair_round",
    reason: "final_recovery_budget_closeout_repair",
  });
  assert.equal(builtSnapshot, false);
});

test("CloseoutPolicyRegistry returns exhausted recovery budget closeout decision", () => {
  const registry = createCloseoutPolicyRegistry();
  let builtSnapshot = 0;

  const decision = registry.evaluateRecoveryToolBudget({
    recoveryToolBudget: { maxToolCalls: 2 },
    usedToolCalls: 2,
    pendingToolCallCount: 1,
    messages: [],
    repairMarkers: [],
    resultText: "blocked: source remains unverified",
    buildCloseoutSnapshot: () => {
      builtSnapshot += 1;
      return recoverySnapshot();
    },
  });

  assert.equal(builtSnapshot, 1);
  assert.deepEqual(decision, {
    kind: "closeout",
    policyId: "recovery_tool_budget",
    reason: "recovery_tool_budget",
    reasonLines: ["Final recovery tool budget reached (2 tool calls)."],
    closeout: recoverySnapshot().closeout,
  });
});

test("CloseoutPolicyRegistry returns operator-cancelled closeout decision", () => {
  const registry = createCloseoutPolicyRegistry();

  const decision = registry.evaluateRemainingPendingCalls(remainingPendingInput({
    pendingToolCallCount: 1,
    taskPrompt: cancelledSessionTaskPrompt(),
  }));

  assert.equal(decision?.kind, "closeout");
  assert.equal(decision?.reason, "operator_cancelled");
  assert.match(decision?.reasonLines[0] ?? "", /cancelled by the operator/);
  assert.deepEqual(decision?.closeout, {
    reason: "operator_cancelled",
    maxRounds: 3,
    toolCallCount: 2,
    roundCount: 2,
    evidenceAvailable: true,
  });
});

test("CloseoutPolicyRegistry skips operator-cancelled without pending calls", () => {
  const registry = createCloseoutPolicyRegistry();

  assert.equal(
    registry.evaluateRemainingPendingCalls(remainingPendingInput({
      pendingToolCallCount: 0,
      taskPrompt: cancelledSessionTaskPrompt(),
    })),
    null,
  );
});

test("CloseoutPolicyRegistry skips operator-cancelled when the user asks to continue", () => {
  const registry = createCloseoutPolicyRegistry();

  assert.equal(
    registry.evaluateRemainingPendingCalls(remainingPendingInput({
      pendingToolCallCount: 1,
      taskPrompt: cancelledSessionTaskPrompt(
        "Continue the cancelled source-check session.",
      ),
    })),
    null,
  );
});

test("CloseoutPolicyRegistry returns pseudo tool-call closeout decision", () => {
  const registry = createCloseoutPolicyRegistry();

  const decision = registry.evaluateRemainingPendingCalls(remainingPendingInput({
    pendingToolCallCount: 0,
    pendingContinuation: false,
    lastText: "<tool_call>{}</tool_call>",
  }));

  assert.equal(decision?.kind, "closeout");
  assert.equal(decision?.reason, "pseudo_tool_call");
  assert.match(decision?.reasonLines[0] ?? "", /pseudo tool-call markup/);
  assert.deepEqual(decision?.closeout, {
    reason: "pseudo_tool_call",
    maxRounds: 3,
    toolCallCount: 2,
    roundCount: 2,
    evidenceAvailable: true,
  });
});

test("CloseoutPolicyRegistry skips pseudo tool-call when continuation is pending", () => {
  const registry = createCloseoutPolicyRegistry();

  assert.equal(
    registry.evaluateRemainingPendingCalls(remainingPendingInput({
      pendingToolCallCount: 0,
      pendingContinuation: true,
      lastText: "<tool_call>{}</tool_call>",
      taskPrompt: "Continue the source check.",
    })),
    null,
  );
});

test("CloseoutPolicyRegistry skips pseudo tool-call when native calls are pending", () => {
  const registry = createCloseoutPolicyRegistry();

  assert.equal(
    registry.evaluateRemainingPendingCalls(remainingPendingInput({
      pendingToolCallCount: 1,
      lastText: "<tool_call>{}</tool_call>",
    })),
    null,
  );
});

test("CloseoutPolicyRegistry returns wall-clock budget closeout decision", () => {
  const registry = createCloseoutPolicyRegistry();

  const decision = registry.evaluateRemainingPendingCalls(remainingPendingInput({
    roundCount: 3,
    wallClockBudget: {
      maxWallClockMs: 90_000,
      requiredTimeoutContinuationPastWallClock: false,
      readElapsedMs: () => 90_000,
      buildCloseoutSnapshot: wallClockSnapshot,
    },
  }));

  assert.equal(decision?.kind, "closeout");
  assert.equal(decision?.reason, "wall_clock_budget");
  assert.deepEqual(decision?.closeout, wallClockSnapshot().closeout);
});

test("CloseoutPolicyRegistry lets required timeout continuation pass wall-clock budget", () => {
  const registry = createCloseoutPolicyRegistry();

  assert.equal(
    registry.evaluateRemainingPendingCalls(remainingPendingInput({
      roundCount: 1,
      wallClockBudget: {
        maxWallClockMs: 90_000,
        requiredTimeoutContinuationPastWallClock: true,
        readElapsedMs: () => 90_000,
        buildCloseoutSnapshot: wallClockSnapshot,
      },
    })),
    null,
  );
});

test("CloseoutPolicyRegistry skips wall-clock budget before any executed round", () => {
  const registry = createCloseoutPolicyRegistry();
  let elapsedReads = 0;

  assert.equal(
    registry.evaluateRemainingPendingCalls(remainingPendingInput({
      roundCount: 0,
      wallClockBudget: {
        maxWallClockMs: 90_000,
        requiredTimeoutContinuationPastWallClock: false,
        readElapsedMs: () => {
          elapsedReads += 1;
          return 90_000;
        },
        buildCloseoutSnapshot: wallClockSnapshot,
      },
    })),
    null,
  );
  assert.equal(elapsedReads, 0);
});

test("CloseoutPolicyRegistry returns round-limit closeout decision", () => {
  const registry = createCloseoutPolicyRegistry();

  const decision = registry.evaluateRemainingPendingCalls(remainingPendingInput({
    pendingToolCallCount: 1,
    roundCount: 3,
  }));

  assert.equal(decision?.kind, "closeout");
  assert.equal(decision?.reason, "round_limit");
  assert.deepEqual(decision?.closeout, roundLimitSnapshot().closeout);
});

test("CloseoutPolicyRegistry skips round-limit for a tool-free final candidate", () => {
  const registry = createCloseoutPolicyRegistry();

  assert.equal(
    registry.evaluateRemainingPendingCalls(remainingPendingInput({
      pendingToolCallCount: 0,
      roundCount: 3,
    })),
    null,
  );
});

test("CloseoutPolicyRegistry returns repeated tool failure closeout decision", () => {
  const registry = createCloseoutPolicyRegistry();
  const first = toolCall("c1", "web_fetch", { url: "https://example.test" });
  const second = toolCall("c2", "web_fetch", { url: "https://example.test" });
  const pending = toolCall("c3", "web_fetch", { url: "https://example.test" });

  const decision = registry.evaluateRemainingPendingCalls(remainingPendingInput({
    pendingCalls: [pending],
    toolTrace: [
      traceRound(1, [first], [
        {
          toolCallId: "c1",
          toolName: "web_fetch",
          isError: true,
          contentBytes: 0,
        },
      ]),
      traceRound(2, [second], [
        {
          toolCallId: "c2",
          toolName: "web_fetch",
          isError: true,
          contentBytes: 0,
        },
      ]),
    ],
  }));

  assert.equal(decision?.kind, "closeout");
  assert.equal(decision?.reason, "repeated_tool_failure");
  assert.match(decision?.reasonLines[0] ?? "", /web_fetch failed 2 times/);
  assert.deepEqual(decision?.closeout, {
    reason: "repeated_tool_failure",
    maxRounds: 3,
    pendingToolCallCount: 1,
    toolName: "web_fetch",
    toolCallCount: 2,
    roundCount: 2,
    evidenceAvailable: true,
  });
});

test("CloseoutPolicyRegistry returns repeated session inspection closeout decision", () => {
  const registry = createCloseoutPolicyRegistry();
  const inspected = toolCall("h1", "sessions_history", {
    session_key: "worker:explore:1",
  });
  const pending = toolCall("h2", "sessions_history", {
    session_key: "worker:explore:1",
  });

  const decision = registry.evaluateRemainingPendingCalls(remainingPendingInput({
    pendingCalls: [pending],
    toolTrace: [
      traceRound(1, [inspected], [
        {
          toolCallId: "h1",
          toolName: "sessions_history",
          isError: false,
          contentBytes: 12,
        },
      ]),
    ],
  }));

  assert.equal(decision?.kind, "closeout");
  assert.equal(decision?.reason, "repeated_session_inspection");
  assert.match(decision?.reasonLines[0] ?? "", /already inspected/);
  assert.deepEqual(decision?.closeout, {
    reason: "repeated_session_inspection",
    maxRounds: 3,
    pendingToolCallCount: 1,
    toolName: "sessions_history",
    toolCallCount: 2,
    roundCount: 2,
    evidenceAvailable: true,
  });
});

test("CloseoutPolicyRegistry returns excessive session continuation closeout decision", () => {
  const registry = createCloseoutPolicyRegistry();
  const first = toolCall("s1", "sessions_send", {
    session_key: "worker:explore:1",
  });
  const second = toolCall("s2", "sessions_send", {
    session_key: "worker:explore:1",
  });
  const pending = toolCall("s3", "sessions_send", {
    session_key: "worker:explore:1",
  });

  const decision = registry.evaluateRemainingPendingCalls(remainingPendingInput({
    pendingCalls: [pending],
    toolTrace: [
      traceRound(1, [first], [
        {
          toolCallId: "s1",
          toolName: "sessions_send",
          isError: false,
          contentBytes: 12,
        },
      ]),
      traceRound(2, [second], [
        {
          toolCallId: "s2",
          toolName: "sessions_send",
          isError: false,
          contentBytes: 12,
        },
      ]),
    ],
  }));

  assert.equal(decision?.kind, "closeout");
  assert.equal(decision?.reason, "excessive_session_continuation");
  assert.match(decision?.reasonLines[0] ?? "", /already continued 2 times/);
  assert.deepEqual(decision?.closeout, {
    reason: "excessive_session_continuation",
    maxRounds: 3,
    pendingToolCallCount: 1,
    toolName: "sessions_send",
    toolCallCount: 2,
    roundCount: 2,
    evidenceAvailable: true,
  });
});

test("CloseoutPolicyRegistry returns completed sub-agent post-execute closeout", () => {
  const registry = createCloseoutPolicyRegistry();

  const decision = registry.evaluatePostExecute({
    completedSession: { toolName: "sessions_spawn" },
    timeoutSignal: null,
  });

  assert.deepEqual(decision, {
    kind: "closeout",
    policyId: "completed_sub_agent_final",
    reason: "completed_sub_agent_final",
  });
});

test("CloseoutPolicyRegistry returns sub-agent timeout post-execute closeout", () => {
  const registry = createCloseoutPolicyRegistry();

  const decision = registry.evaluatePostExecute({
    completedSession: null,
    timeoutSignal: { toolName: "sessions_spawn" },
  });

  assert.deepEqual(decision, {
    kind: "closeout",
    policyId: "sub_agent_timeout",
    reason: "sub_agent_timeout",
  });
});

test("CloseoutPolicyRegistry gives completed session precedence over timeout", () => {
  const registry = createCloseoutPolicyRegistry();

  const decision = registry.evaluatePostExecute({
    completedSession: { toolName: "sessions_history" },
    timeoutSignal: { toolName: "sessions_spawn" },
  });

  assert.equal(decision?.reason, "completed_sub_agent_final");
});
