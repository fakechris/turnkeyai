import assert from "node:assert/strict";
import test from "node:test";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { ExecutionBudgetCloseoutSnapshot } from "./execution-budget-controller";
import type {
  RemainingPendingCallsCloseoutInput,
  TerminateCloseoutInput,
} from "./closeout-policy-registry";
import type { LLMToolCall } from "./types";
import {
  buildRemainingPendingCallsSessionContext,
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

function permissionFacts(runtimeEvidenceText = "") {
  return {
    latestStatus: runtimeEvidenceText ? ("pending" as const) : ("none" as const),
    latestToolName: runtimeEvidenceText ? "permission_result" : null,
    latestResultStatus: runtimeEvidenceText ? "pending" : null,
    pendingApproval: Boolean(runtimeEvidenceText),
    appliedApproval: false,
    deniedApproval: false,
    waitTimeout: false,
    runtimeEvidenceText,
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

function terminateInput(
  overrides: Partial<TerminateCloseoutInput> = {},
): TerminateCloseoutInput {
  return {
    reason: "round_limit",
    pendingCloseout: null,
    completedSession: null,
    timeoutSignal: null,
    taskPrompt: "Summarize the gathered evidence.",
    messages: [],
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

test("CloseoutPolicyRegistry applies pending closeout decisions through a target", () => {
  const registry = createCloseoutPolicyRegistry();
  const writes: unknown[] = [];
  const target = {
    recordPendingCloseout(input: unknown) {
      writes.push(input);
    },
  };

  const decision = registry.evaluateRecoveryToolBudget({
    recoveryToolBudget: { maxToolCalls: 2 },
    usedToolCalls: 2,
    pendingToolCallCount: 1,
    messages: [],
    repairMarkers: [],
    resultText: "blocked: source remains unverified",
    buildCloseoutSnapshot: recoverySnapshot,
  });

  assert.equal(
    registry.applyPendingCloseoutDecision(decision, target),
    "recovery_tool_budget",
  );
  assert.deepEqual(writes, [
    {
      reasonLines: ["Final recovery tool budget reached (2 tool calls)."],
      closeout: recoverySnapshot().closeout,
    },
  ]);

  const deferred = registry.evaluateRecoveryToolBudget({
    recoveryToolBudget: { maxToolCalls: 2 },
    usedToolCalls: 2,
    pendingToolCallCount: 0,
    messages: [],
    repairMarkers: [],
    resultText: "@{role-explore} continue the recovery",
    buildCloseoutSnapshot: recoverySnapshot,
  });
  assert.equal(registry.applyPendingCloseoutDecision(deferred, target), null);
  assert.equal(registry.applyPendingCloseoutDecision(null, target), null);
  assert.equal(writes.length, 1);
});

test("CloseoutPolicyRegistry applies recovery-budget closeout through a target", () => {
  const registry = createCloseoutPolicyRegistry();
  const writes: unknown[] = [];
  const target = {
    recordPendingCloseout(input: unknown) {
      writes.push(input);
    },
  };

  assert.equal(
    registry.applyRecoveryToolBudgetCloseout(
      {
        recoveryToolBudget: { maxToolCalls: 2 },
        usedToolCalls: 2,
        pendingToolCallCount: 1,
        messages: [],
        repairMarkers: [],
        resultText: "blocked: source remains unverified",
        buildCloseoutSnapshot: recoverySnapshot,
      },
      target,
    ),
    "recovery_tool_budget",
  );
  assert.deepEqual(writes, [
    {
      reasonLines: ["Final recovery tool budget reached (2 tool calls)."],
      closeout: recoverySnapshot().closeout,
    },
  ]);
});

test("CloseoutPolicyRegistry applies remaining pending closeout through a target", () => {
  const registry = createCloseoutPolicyRegistry();
  const writes: unknown[] = [];
  const target = {
    recordPendingCloseout(input: unknown) {
      writes.push(input);
    },
  };

  assert.equal(
    registry.applyRemainingPendingCallsCloseout(
      remainingPendingInput({
        pendingToolCallCount: 1,
        taskPrompt: cancelledSessionTaskPrompt(),
      }),
      target,
    ),
    "operator_cancelled",
  );
  assert.equal(writes.length, 1);
  assert.match(
    (writes[0] as { reasonLines: string[] }).reasonLines[0] ?? "",
    /cancelled by the operator/,
  );
  assert.deepEqual((writes[0] as { closeout: unknown }).closeout, {
    reason: "operator_cancelled",
    maxRounds: 3,
    toolCallCount: 2,
    roundCount: 2,
    evidenceAvailable: true,
  });
});

test("CloseoutPolicyRegistry pending-call flow honors read-only suppression preemption", () => {
  const registry = createCloseoutPolicyRegistry();
  const order: string[] = [];
  const writes: unknown[] = [];
  const target = {
    recordPendingCloseout(input: unknown) {
      writes.push(input);
    },
  };

  const reason = registry.applyPendingCallsCloseout(
    {
      pendingCalls: [toolCall("c1", "permission_query")],
      lastText: "I need permission.",
      taskPrompt: "Read-only status report.",
      messages: [],
      repairMarkers: [],
      toolTrace: [],
      maxRounds: 3,
      usedToolCalls: 2,
      recoveryUsedToolCalls: 2,
      roundCount: 2,
      evidenceAvailable: true,
      recoveryToolBudget: { maxToolCalls: 2 },
      readOnlyPermissionQuerySuppressed: () => {
        order.push("suppress");
        return true;
      },
      previewEmptyRoundContinuation: () => {
        order.push("preview");
        return null;
      },
      buildRecoveryToolBudgetCloseoutSnapshot: () => {
        order.push("recovery");
        return recoverySnapshot();
      },
      buildWallClockBudgetCloseoutSignal: () => {
        order.push("wall-clock");
        return null;
      },
      buildRoundLimitCloseoutSnapshot: () => {
        order.push("round-limit");
        return roundLimitSnapshot();
      },
    },
    target,
  );

  assert.equal(reason, null);
  assert.deepEqual(order, ["suppress"]);
  assert.deepEqual(writes, []);
});

test("CloseoutPolicyRegistry pending-call flow applies recovery before continuation preview", () => {
  const registry = createCloseoutPolicyRegistry();
  const order: string[] = [];
  const writes: unknown[] = [];
  const target = {
    recordPendingCloseout(input: unknown) {
      writes.push(input);
    },
  };

  const reason = registry.applyPendingCallsCloseout(
    {
      pendingCalls: [toolCall("c1", "sessions_spawn")],
      lastText: "Checking one more source.",
      taskPrompt: "Summarize the gathered evidence.",
      messages: [],
      repairMarkers: [],
      toolTrace: [],
      maxRounds: 3,
      usedToolCalls: 2,
      recoveryUsedToolCalls: 2,
      roundCount: 2,
      evidenceAvailable: false,
      recoveryToolBudget: { maxToolCalls: 2 },
      readOnlyPermissionQuerySuppressed: () => {
        order.push("suppress");
        return false;
      },
      previewEmptyRoundContinuation: () => {
        order.push("preview");
        return toolCall("runtime-continuation-1", "sessions_send");
      },
      buildRecoveryToolBudgetCloseoutSnapshot: () => {
        order.push("recovery");
        return recoverySnapshot();
      },
      buildWallClockBudgetCloseoutSignal: () => {
        order.push("wall-clock");
        return null;
      },
      buildRoundLimitCloseoutSnapshot: () => {
        order.push("round-limit");
        return roundLimitSnapshot();
      },
    },
    target,
  );

  assert.equal(reason, "recovery_tool_budget");
  assert.deepEqual(order, ["suppress", "recovery"]);
  assert.deepEqual(writes, [
    {
      reasonLines: ["Final recovery tool budget reached (2 tool calls)."],
      closeout: recoverySnapshot().closeout,
    },
  ]);
});

test("CloseoutPolicyRegistry pending-call hook computes live budget and evidence inputs", () => {
  const registry = createCloseoutPolicyRegistry();
  const pendingCalls = [toolCall("pending-1", "sessions_spawn")];
  const priorCall = toolCall("prior-1", "sessions_spawn");
  const messages = [{ role: "user" as const, content: "Summarize status." }];
  let permissionInput: unknown;
  let evidenceMessages: unknown;
  let recoveryInput: unknown;
  let previewCalls = 0;
  let wallClockCalls = 0;
  let roundLimitCalls = 0;
  const writes: unknown[] = [];
  const target = {
    recordPendingCloseout(input: unknown) {
      writes.push(input);
    },
  };

  const reason = registry.applyPendingCallsCloseoutHook(
    {
      active: true,
      pendingCalls,
      lastText: "still checking",
      taskPrompt: "Summarize the gathered evidence.",
      messages,
      repairMarkers: [],
      toolTrace: [
        traceRound(1, [priorCall], [
          {
            toolCallId: priorCall.id,
            toolName: priorCall.name,
            isError: false,
            contentBytes: 12,
          },
        ]),
      ],
      round: 4,
      maxRounds: 3,
      recoveryToolBudget: { maxToolCalls: 2 },
      recoveryToolCallsBeforeActivation: 1,
      permissionPolicy: {
        wouldSuppressReadOnlyPermissionQuery(input: unknown) {
          permissionInput = input;
          return false;
        },
      },
      continuation: {
        previewEmptyRoundContinuation() {
          previewCalls += 1;
          return null;
        },
      },
      executionBudget: {
        buildRecoveryToolBudgetCloseoutSnapshot(input: unknown) {
          recoveryInput = input;
          return recoverySnapshot();
        },
        buildPendingCallsWallClockBudgetCloseoutSignal() {
          wallClockCalls += 1;
          return null;
        },
        buildRoundLimitCloseoutSnapshot() {
          roundLimitCalls += 1;
          return roundLimitSnapshot();
        },
      },
      evidence: {
        snapshot(inputMessages: unknown) {
          evidenceMessages = inputMessages;
          return {
            sourceBoundedEvidenceText: "",
            completedSessionEvidenceText: "",
            naturalFinishEvidenceText: "",
            synthesisEvidenceText: "",
            toolTraceResultContent: "",
            approvalWaitTimeoutRuntimeEvidence: "",
            approvalEvidenceText: "",
            permission: permissionFacts(),
            usableEvidence: false,
          };
        },
      },
      now: () => 100,
      toolLoopStartedAtMs: 10,
      activeMaxWallClockMs: 90_000,
      tools: [{ name: "sessions_send" }],
    },
    target,
  );

  assert.equal(reason, "recovery_tool_budget");
  assert.deepEqual(
    (permissionInput as { calls: unknown; taskPrompt: unknown }).calls,
    pendingCalls,
  );
  assert.equal(
    (permissionInput as { taskPrompt: unknown }).taskPrompt,
    "Summarize the gathered evidence.",
  );
  assert.equal(evidenceMessages, messages);
  assert.deepEqual(recoveryInput, {
    maxRounds: 3,
    maxToolCalls: 2,
    pendingToolCallCount: 1,
    usedToolCalls: 2,
    roundCount: 1,
    evidenceAvailable: false,
  });
  assert.equal(previewCalls, 0);
  assert.equal(wallClockCalls, 0);
  assert.equal(roundLimitCalls, 0);
  assert.deepEqual(writes, [
    {
      reasonLines: ["Final recovery tool budget reached (2 tool calls)."],
      closeout: recoverySnapshot().closeout,
    },
  ]);
});

test("CloseoutPolicyRegistry pending-call flow passes continuation preview into remaining closeouts", () => {
  const registry = createCloseoutPolicyRegistry();
  const order: string[] = [];
  const continuation = toolCall("runtime-continuation-1", "sessions_send");
  const writes: unknown[] = [];
  const target = {
    recordPendingCloseout(input: unknown) {
      writes.push(input);
    },
  };

  const reason = registry.applyPendingCallsCloseout(
    {
      pendingCalls: [],
      lastText: "<tool_call>{}</tool_call>",
      taskPrompt: "Continue the browser session if needed.",
      messages: [],
      repairMarkers: [],
      toolTrace: [],
      maxRounds: 3,
      usedToolCalls: 2,
      recoveryUsedToolCalls: 2,
      roundCount: 2,
      evidenceAvailable: true,
      recoveryToolBudget: null,
      readOnlyPermissionQuerySuppressed: () => {
        order.push("suppress");
        return false;
      },
      previewEmptyRoundContinuation: () => {
        order.push("preview");
        return continuation;
      },
      buildRecoveryToolBudgetCloseoutSnapshot: () => {
        order.push("recovery");
        return recoverySnapshot();
      },
      buildWallClockBudgetCloseoutSignal: (input) => {
        order.push("wall-clock");
        assert.deepEqual(input.pendingCalls, []);
        assert.equal(input.pendingContinuation, continuation);
        return {
          maxWallClockMs: 90_000,
          requiredTimeoutContinuationPastWallClock: false,
          readElapsedMs: () => 90_000,
          buildCloseoutSnapshot: wallClockSnapshot,
        };
      },
      buildRoundLimitCloseoutSnapshot: () => {
        order.push("round-limit");
        return roundLimitSnapshot();
      },
    },
    target,
  );

  assert.equal(reason, "wall_clock_budget");
  assert.deepEqual(order, ["suppress", "preview", "wall-clock"]);
  assert.deepEqual(writes, [
    {
      reasonLines: ["Tool-use wall-clock budget reached (1m 30s)."],
      closeout: wallClockSnapshot().closeout,
    },
  ]);
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

test("buildRemainingPendingCallsSessionContext resolves live continuation evidence", () => {
  const sessionKey = "worker:browser:task-closeout";
  const context = buildRemainingPendingCallsSessionContext({
    taskPrompt: "Continue the browser session if needed.",
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
              final: "browser evidence",
            }),
          },
        ],
      },
    ],
  });

  assert.match(context, /Continue the browser session/);
  assert.match(context, new RegExp(sessionKey));
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

test("CloseoutPolicyRegistry applies post-execute closeouts through a target", () => {
  const registry = createCloseoutPolicyRegistry();
  const completedSession = {
    toolName: "sessions_spawn",
    finalContents: ["done"],
    browserRecoverySummaries: [],
  };
  const timeoutSignal = {
    toolName: "sessions_spawn",
    sessionKey: "worker:source:task-1",
    agentId: "source",
    timeoutSeconds: null,
    evidenceAvailable: false,
  };
  const toolResults = [{ toolCallId: "call-1" }];
  const writes: unknown[] = [];
  const target = {
    recordCompletedSession(input: unknown) {
      writes.push({ kind: "completed", input });
    },
    recordTimeoutSignal(input: unknown) {
      writes.push({ kind: "timeout", input });
    },
  };

  const completedDecision = registry.evaluatePostExecute({
    completedSession,
    timeoutSignal,
  });
  assert.equal(
    registry.applyPostExecuteCloseoutDecision(
      completedDecision,
      { completedSession, timeoutSignal, toolResults },
      target,
    ),
    "completed_sub_agent_final",
  );
  assert.deepEqual(writes, [
    {
      kind: "completed",
      input: { session: completedSession, toolResults },
    },
  ]);

  const timeoutDecision = registry.evaluatePostExecute({
    completedSession: null,
    timeoutSignal,
  });
  assert.equal(
    registry.applyPostExecuteCloseoutDecision(
      timeoutDecision,
      { completedSession: null, timeoutSignal, toolResults },
      target,
    ),
    "sub_agent_timeout",
  );
  assert.deepEqual(writes[1], { kind: "timeout", input: timeoutSignal });
  assert.equal(
    registry.applyPostExecuteCloseoutDecision(null, {
      completedSession: null,
      timeoutSignal: null,
      toolResults,
    }, target),
    null,
  );
  assert.equal(writes.length, 2);
});

test("CloseoutPolicyRegistry applies post-execute closeout from hook input", () => {
  const registry = createCloseoutPolicyRegistry();
  const completedSession = {
    toolName: "sessions_spawn",
    finalContents: ["done"],
    browserRecoverySummaries: [],
  };
  const timeoutSignal = {
    toolName: "sessions_spawn",
    evidenceAvailable: false,
  };
  const toolResults = [{ toolCallId: "call-1" }];
  const writes: unknown[] = [];
  const target = {
    recordCompletedSession(input: unknown) {
      writes.push({ kind: "completed", input });
    },
    recordTimeoutSignal(input: unknown) {
      writes.push({ kind: "timeout", input });
    },
  };

  assert.equal(
    registry.applyPostExecuteCloseout(
      { completedSession, timeoutSignal, toolResults },
      target,
    ),
    "completed_sub_agent_final",
  );
  assert.deepEqual(writes, [
    {
      kind: "completed",
      input: { session: completedSession, toolResults },
    },
  ]);

  assert.equal(
    registry.applyPostExecuteCloseout(
      { completedSession: null, timeoutSignal, toolResults },
      target,
    ),
    "sub_agent_timeout",
  );
  assert.deepEqual(writes[1], { kind: "timeout", input: timeoutSignal });
});

test("CloseoutPolicyRegistry owns post-execute hook evidence lookup", () => {
  const registry = createCloseoutPolicyRegistry();
  const completedSession = {
    toolName: "sessions_spawn",
    finalContents: ["done"],
    browserRecoverySummaries: [],
  };
  const timeoutSignal = {
    toolName: "sessions_spawn",
    evidenceAvailable: false,
  };
  const toolResults = [{ toolCallId: "call-1" }];
  const writes: unknown[] = [];
  const target = {
    recordCompletedSession(input: unknown) {
      writes.push({ kind: "completed", input });
    },
    recordTimeoutSignal(input: unknown) {
      writes.push({ kind: "timeout", input });
    },
  };

  assert.equal(
    registry.applyPostExecuteCloseoutHook(
      {
        toolResults,
        evidence: {
          currentRound(results: unknown[]) {
            assert.equal(results, toolResults);
            return {
              completedSession,
              completedSessions: [completedSession],
              completedSessionFinalContents: ["done"],
              timeoutSignal,
              timeoutSignals: [timeoutSignal],
              toolResultContentText: "done",
            };
          },
        },
      },
      target,
    ),
    "completed_sub_agent_final",
  );
  assert.deepEqual(writes, [
    {
      kind: "completed",
      input: { session: completedSession, toolResults },
    },
  ]);
});

test("CloseoutPolicyRegistry passes through pending terminate closeout", () => {
  const registry = createCloseoutPolicyRegistry();
  const pending = {
    reason: "pseudo_tool_call" as const,
    maxRounds: 3,
    toolCallCount: 2,
    roundCount: 2,
    evidenceAvailable: true,
  };

  const decision = registry.evaluateTerminate(terminateInput({
    reason: "pseudo_tool_call",
    pendingCloseout: {
      reason: "pseudo_tool_call",
      reasonLines: ["pending closeout line"],
      closeout: pending,
    },
  }));

  assert.deepEqual(decision, {
    kind: "closeout",
    policyId: "pseudo_tool_call",
    reason: "pseudo_tool_call",
    reasonLines: ["pending closeout line"],
    closeout: pending,
  });
});

test("CloseoutPolicyRegistry builds completed terminate closeout", () => {
  const registry = createCloseoutPolicyRegistry();

  const decision = registry.evaluateTerminate(terminateInput({
    reason: "completed_sub_agent_final",
    taskPrompt: "Use the product-signals live signal dashboard evidence.",
    completedSession: {
      toolName: "sessions_spawn",
      finalContents: [
        [
          "Rendered browser-visible product signal dashboard counters.",
          "Active signals: 12.",
          "Conversion rate: 34%.",
          "Recommendation count: 3.",
        ].join(" "),
      ],
      browserRecoverySummaries: ["reopened worker:browser:abc"],
    },
    usedToolCalls: 4,
    roundCount: 3,
  }));

  assert.equal(decision.kind, "closeout");
  assert.equal(decision.reason, "completed_sub_agent_final");
  assert.equal(decision.sticky, true);
  assert.equal(
    decision.reasonLines?.some((line) =>
      line.includes(
        "Completed browser evidence verifies product signal dashboard counters",
      ),
    ),
    true,
  );
  assert.equal(
    decision.reasonLines?.some((line) =>
      line.includes("Browser continuity 1: reopened worker:browser:abc"),
    ),
    true,
  );
  assert.equal(
    decision.reasonLines?.some((line) => line.startsWith("Source 1 evidence:")),
    true,
  );
  assert.deepEqual(decision.closeout, {
    reason: "completed_sub_agent_final",
    maxRounds: 3,
    toolName: "sessions_spawn",
    finalContentCount: 1,
    toolCallCount: 4,
    roundCount: 3,
    evidenceAvailable: true,
  });
});

test("CloseoutPolicyRegistry builds sub-agent timeout terminate closeout", () => {
  const registry = createCloseoutPolicyRegistry();

  const decision = registry.evaluateTerminate(terminateInput({
    reason: "sub_agent_timeout",
    timeoutSignal: {
      toolName: "sessions_spawn",
      timeoutSeconds: 45,
      evidenceAvailable: false,
    },
    usedToolCalls: 5,
    roundCount: 4,
    evidenceAvailable: false,
  }));

  assert.equal(decision.reason, "sub_agent_timeout");
  assert.match(decision.reasonLines?.[0] ?? "", /timed out after 45s/);
  assert.deepEqual(decision.closeout, {
    reason: "sub_agent_timeout",
    maxRounds: 3,
    toolName: "sessions_spawn",
    timeoutSeconds: 45,
    evidenceAvailable: false,
    toolCallCount: 5,
    roundCount: 4,
  });
});

test("CloseoutPolicyRegistry builds round-limit terminate closeout", () => {
  const registry = createCloseoutPolicyRegistry();
  let builtSnapshot = 0;

  const decision = registry.evaluateTerminate(terminateInput({
    reason: "round_limit",
    buildRoundLimitCloseoutSnapshot: () => {
      builtSnapshot += 1;
      return roundLimitSnapshot();
    },
  }));

  assert.equal(builtSnapshot, 1);
  assert.equal(decision.reason, "round_limit");
  assert.deepEqual(decision.closeout, roundLimitSnapshot().closeout);
});

test("CloseoutPolicyRegistry builds generic terminate closeout", () => {
  const registry = createCloseoutPolicyRegistry();

  const decision = registry.evaluateTerminate(terminateInput({
    reason: "repeated_tool_failure",
    usedToolCalls: 7,
    roundCount: 6,
    evidenceAvailable: false,
  }));

  assert.equal(decision.reason, "repeated_tool_failure");
  assert.equal(decision.reasonLines, undefined);
  assert.deepEqual(decision.closeout, {
    reason: "repeated_tool_failure",
    maxRounds: 3,
    toolCallCount: 7,
    roundCount: 6,
    evidenceAvailable: false,
  });
});

test("CloseoutPolicyRegistry owns terminate hook state and evidence assembly", () => {
  const registry = createCloseoutPolicyRegistry();
  const messages = [{ role: "user" as const, content: "Summarize evidence." }];
  const toolTrace = [
    traceRound(1, [toolCall("call-1", "web_fetch")], []),
    traceRound(2, [
      toolCall("call-2", "sessions_spawn"),
      toolCall("call-3", "permission_query"),
    ], []),
  ];
  const calls: string[] = [];
  let evidenceMessages: unknown;
  let roundLimitInput: unknown;

  const result = registry.evaluateTerminateHook({
    reason: "round_limit",
    taskPrompt: "Summarize the gathered evidence.",
    messages,
    toolTrace,
    maxRounds: 5,
    state: {
      pendingCloseout: () => {
        calls.push("pending");
        return undefined;
      },
      completedSession: () => {
        calls.push("completed");
        return {
          toolName: "sessions_spawn",
          finalContents: ["ignored for round limit"],
          browserRecoverySummaries: [],
        };
      },
      timeoutSignal: () => {
        calls.push("timeout");
        return undefined;
      },
    },
    evidence: {
      snapshot: (capturedMessages) => {
        calls.push("evidence");
        evidenceMessages = capturedMessages;
        return {
          usableEvidence: true,
          approvalEvidenceText: "permission_result pending",
          permission: permissionFacts("permission_result pending"),
        };
      },
    },
    executionBudget: {
      buildRoundLimitCloseoutSnapshot: (input) => {
        calls.push("round-limit");
        roundLimitInput = input;
        return {
          reasonLines: ["Tool-use round limit reached (5)."],
          closeout: {
            reason: "round_limit",
            maxRounds: 5,
            toolCallCount: input.usedToolCalls,
            roundCount: input.roundCount,
            evidenceAvailable: input.evidenceAvailable,
          },
        };
      },
    },
  });

  assert.deepEqual(calls, [
    "evidence",
    "pending",
    "completed",
    "timeout",
    "round-limit",
  ]);
  assert.equal(evidenceMessages, messages);
  assert.deepEqual(roundLimitInput, {
    maxRounds: 5,
    usedToolCalls: 3,
    roundCount: 2,
    evidenceAvailable: true,
  });
  assert.deepEqual(result, {
    decision: {
      kind: "closeout",
      policyId: "round_limit",
      reason: "round_limit",
      reasonLines: ["Tool-use round limit reached (5)."],
      closeout: {
        reason: "round_limit",
        maxRounds: 5,
        toolCallCount: 3,
        roundCount: 2,
        evidenceAvailable: true,
      },
    },
    approvalWaitTimeoutFallback: {
      toolCallCount: 3,
      roundCount: 2,
      evidenceText: "permission_result pending",
    },
  });
});
