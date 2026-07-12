import assert from "node:assert/strict";
import test from "node:test";

import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import { produceTaskIntentEnvelope } from "../runtime-facts/task-intent-producer";
import { createContinuationController } from "./continuation-controller";

const sessionKey = "worker:explore:task-source:toolu-timeout";

function taskPromptWithSession(): string {
  return [
    "Task brief:",
    "Continue from the slow-source attempt in this mission.",
    "Resume the existing source-check context if possible.",
    "",
    "Previous tool result:",
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      session_key: sessionKey,
      agent_id: "explore",
      status: "timeout",
      result: "slow source timed out",
    }),
    "",
    "Recent turns:",
    "[user] Continue from the slow-source attempt in this mission.",
  ].join("\n");
}

function taskPromptWithoutSessionKey(): string {
  return [
    "Task brief:",
    "Continue from the slow-source attempt in this mission.",
    "Resume the existing source-check context if possible.",
    "",
    "Recent turns:",
    "[user] Continue from the slow-source attempt in this mission.",
  ].join("\n");
}

function sentTrace(sentSessionKey = sessionKey): NativeToolRoundTrace[] {
  return [
    {
      round: 1,
      calls: [
        {
          id: "toolu-sent",
          name: "sessions_send",
          input: { session_key: sentSessionKey, message: "already sent" },
        },
      ],
      results: [],
    },
  ];
}

function contentPoorTimeoutEvidence(): string {
  return [
    "The resumed source-check timed out before completion.",
    "No HTTP status was obtained, headers are unavailable, and no response body was retrieved.",
    "The URL remained unverified: http://127.0.0.1:4173/source.",
  ].join("\n");
}

const incompleteBrowserSessionKey = "worker:browser:approved-submit:toolu-browser";

function permissionAppliedTrace(
  includePriorSend = false,
): NativeToolRoundTrace[] {
  return [
    {
      round: 1,
      calls: [
        {
          id: "toolu-permission",
          name: "permission_applied",
          input: { approval_id: "ap-1" },
        },
        ...(includePriorSend
          ? [
              {
                id: "toolu-prior-send",
                name: "sessions_send",
                input: {
                  session_key: incompleteBrowserSessionKey,
                  message: "already continued",
                },
              },
            ]
          : []),
      ],
      results: [],
    },
  ];
}

function incompleteApprovedBrowserResults(): Array<{
  toolName: string;
  content: string;
}> {
  return [
    {
      toolName: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-1",
        status: "completed",
        session_key: incompleteBrowserSessionKey,
        agent_id: "browser",
        tool_chain: ["browser"],
        result:
          "The approved submit was not completed because browser_act could not be called. No form submission ran.",
        final_content:
          "The approved submit was not completed because browser_act could not be called. No form submission ran.",
        payload: null,
      }),
    },
  ];
}

function approvedBrowserActionTaskPrompt(): string {
  return [
    "Operator approval ap-1 is already applied.",
    "Use browser.form.submit to submit the form and verify the post-submit page state.",
  ].join("\n");
}

function independentEvidenceTaskPrompt(): string {
  return [
    "This task declares three independent evidence streams.",
    "Research source: use an explore session for source A.",
    "Capability source: use an explore session for source B.",
    "Live readiness dashboard: use a browser session for source C.",
  ].join("\n");
}

function independentEvidenceTrace(): NativeToolRoundTrace[] {
  return [
    {
      round: 1,
      calls: [
        {
          id: "toolu-source-a",
          name: "sessions_spawn",
          input: { agent_id: "explore", task: "source A" },
        },
      ],
      results: [
        {
          toolCallId: "toolu-source-a",
          toolName: "sessions_spawn",
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-1",
            status: "completed",
            session_key: "worker:explore:source-a:toolu-source-a",
            agent_id: "explore",
            tool_chain: ["explore"],
            result: "Source A evidence.",
            final_content: "Source A evidence.",
            payload: null,
          }),
          isError: false,
          contentBytes: 0,
        },
      ],
    },
  ];
}

function missingApprovalGateTaskPrompt(): string {
  return [
    "Use the browser to submit the enrollment form.",
    "This is an approval-gated browser.form.submit action.",
    "Request operator approval before the browser mutation, then verify the submitted page state.",
  ].join("\n");
}

function pendingApprovalTrace(
  includePermissionResult = false,
): NativeToolRoundTrace[] {
  return [
    {
      round: 1,
      calls: [
        {
          id: "toolu-permission-query",
          name: "permission_query",
          input: { action: "browser.form.submit" },
        },
      ],
      results: includePermissionResult
        ? [
            {
              toolCallId: "toolu-permission-result",
              toolName: "permission_result",
              content: JSON.stringify({
                status: "pending",
                approval_id: "ap-1",
              }),
              isError: false,
              contentBytes: 0,
            },
          ]
        : [],
      progress: [
        {
          toolCallId: "toolu-permission-query",
          toolName: "permission_query",
          phase: "completed",
          summary: "permission query pending",
          detail: {
            eventType: "permission.query",
            status: "pending",
            approval_id: "ap-1",
          },
          ts: 1,
        },
      ],
    },
  ];
}

function approvalWaitTimeoutTaskPrompt(): string {
  return [
    "Submit the form only if the operator approves.",
    "If the operator decision does not arrive during this attempt, check the pending permission result before closing out.",
  ].join("\n");
}

test("ContinuationController injects sessions_send for an empty continuation round", () => {
  const controller = createContinuationController();

  const action = controller.onRoundEmpty({
    active: true,
    messages: [],
    round: 0,
    taskPrompt: taskPromptWithSession(),
    toolTrace: [],
    tools: [{ name: "sessions_send" }, { name: "sessions_list" }],
  });

  assert.equal(action.kind, "inject_calls");
  assert.equal(action.kind === "inject_calls" && action.reason, "empty_round_session_continuation");
  assert.equal(action.kind === "inject_calls" && action.calls[0]?.id, "runtime-continuation-1");
  assert.equal(action.kind === "inject_calls" && action.calls[0]?.name, "sessions_send");
  assert.equal(
    action.kind === "inject_calls" &&
      action.calls[0]?.input["session_key"],
    sessionKey,
  );
  assert.match(
    String(action.kind === "inject_calls" && action.calls[0]?.input["message"]),
    /Continue from the slow-source attempt in this mission/,
  );
});

test("ContinuationController prefers sessions_send over continuation lookup", () => {
  const controller = createContinuationController();

  const action = controller.onRoundEmpty({
    active: true,
    messages: [],
    round: 2,
    taskPrompt: taskPromptWithSession(),
    toolTrace: [],
    tools: [{ name: "sessions_send" }, { name: "sessions_list" }],
  });

  assert.equal(action.kind, "inject_calls");
  assert.equal(
    action.kind === "inject_calls" && action.calls[0]?.name,
    "sessions_send",
  );
  assert.equal(
    action.kind === "inject_calls" && action.calls[0]?.id,
    "runtime-continuation-3",
  );
});

test("ContinuationController injects sessions_list when continuation lacks a session key", () => {
  const controller = createContinuationController();

  const action = controller.onRoundEmpty({
    active: true,
    messages: [],
    round: 0,
    taskPrompt: taskPromptWithoutSessionKey(),
    toolTrace: [],
    tools: [{ name: "sessions_list" }],
  });

  assert.equal(action.kind, "inject_calls");
  assert.equal(
    action.kind === "inject_calls" && action.calls[0]?.id,
    "runtime-continuation-lookup-1",
  );
  assert.equal(
    action.kind === "inject_calls" && action.calls[0]?.name,
    "sessions_list",
  );
  assert.deepEqual(
    action.kind === "inject_calls" && action.calls[0]?.input,
    { limit: 5 },
  );
});

test("ContinuationController does not repeat an already-sent continuation or inject unavailable tools", () => {
  const controller = createContinuationController();

  assert.deepEqual(
    controller.onRoundEmpty({
      active: true,
      messages: [],
      round: 0,
      taskPrompt: taskPromptWithSession(),
      toolTrace: sentTrace(),
      tools: [{ name: "sessions_send" }, { name: "sessions_list" }],
    }),
    { kind: "none" },
  );
  assert.deepEqual(
    controller.onRoundEmpty({
      active: true,
      messages: [],
      round: 0,
      taskPrompt: taskPromptWithSession(),
      toolTrace: [],
      tools: [],
    }),
    { kind: "none" },
  );
});

test("ContinuationController applies empty-round actions as hook decisions", () => {
  const controller = createContinuationController();
  const action = controller.onRoundEmpty({
    active: true,
    messages: [],
    round: 0,
    taskPrompt: taskPromptWithSession(),
    toolTrace: [],
    tools: [{ name: "sessions_send" }],
  });

  assert.deepEqual(controller.applyRoundEmptyAction(action), {
    injectedCalls: action.kind === "inject_calls" ? action.calls : [],
  });
  assert.equal(
    controller.applyRoundEmptyAction({ kind: "none" }),
    "terminate",
  );
});

test("ContinuationController owns round-empty hook selection and application", () => {
  const controller = createContinuationController();

  const injected = controller.applyRoundEmptyHook({
    active: true,
    messages: [],
    round: 0,
    taskPrompt: taskPromptWithSession(),
    toolTrace: [],
    tools: [{ name: "sessions_send" }],
  });

  assert.notEqual(injected, "terminate");
  assert.equal(
    injected !== "terminate" && injected.injectedCalls[0]?.id,
    "runtime-continuation-1",
  );
  assert.equal(
    injected !== "terminate" && injected.injectedCalls[0]?.name,
    "sessions_send",
  );
  assert.equal(
    injected !== "terminate" &&
      injected.injectedCalls[0]?.input["session_key"],
    sessionKey,
  );
  assert.match(
    String(
      injected !== "terminate" &&
        injected.injectedCalls[0]?.input["message"],
    ),
    /Continuation context from the original task/,
  );
  assert.equal(
    controller.applyRoundEmptyHook({
      active: false,
      messages: [],
      round: 0,
      taskPrompt: taskPromptWithSession(),
      toolTrace: [],
      tools: [{ name: "sessions_send" }],
    }),
    "terminate",
  );
});

test("ContinuationController forces one resumable bounded source check when the model returns only text", () => {
  const controller = createContinuationController();
  const taskPrompt = [
    "Evaluate this source for a release-risk note: https://slow.example/source.",
    "Use a bounded attempt first and close out if it does not return in time.",
    "A follow-up may ask you to resume that same source-check context.",
  ].join("\n");
  const taskFacts = produceTaskIntentEnvelope({
    taskPrompt,
    activation: undefined,
    messages: [],
  }).facts;

  const action = controller.onRoundEmpty({
    active: true,
    messages: [],
    round: 0,
    taskPrompt,
    toolTrace: [],
    tools: [{ name: "sessions_spawn" }],
    taskFacts,
  });

  assert.equal(action.kind, "inject_calls");
  assert.deepEqual(action.kind === "inject_calls" && action.calls[0], {
    id: "runtime-bounded-source-check-1",
    name: "sessions_spawn",
    input: {
      agent_id: "explore",
      label: "Bounded source check",
      task: taskPrompt,
      timeout_seconds: 25,
    },
  });
});

test("ContinuationController continues an approved browser timeout before coverage timeout", () => {
  const controller = createContinuationController();
  const timeoutSignal = {
    toolName: "sessions_spawn",
    sessionKey: "worker:browser:approved-submit:toolu-submit",
    agentId: "browser",
    timeoutSeconds: 45,
    evidenceAvailable: true,
  };

  const action = controller.onAfterExecuteTimeoutContinuation({
    messages: [{ role: "user", content: "tool result history" }],
    taskPrompt: [
      "Operator decision recorded for approval ap-1.",
      "Action: browser.form.submit.",
      "The operator approved it, and the runtime has already recorded permission.result and permission.applied; the runtime permission cache is already applied.",
      "Do not call permission tools again. Continue from the approved point: perform only the approved scoped action now and verify the result before the final answer.",
      "Compare provider web search pricing across https://a.example, https://b.example, and https://c.example; do not finalize until all three sources are checked.",
    ].join("\n"),
    toolTrace: [],
    timeoutSignal,
    tools: [{ name: "sessions_send" }],
  });

  assert.equal(action.kind, "continue");
  assert.equal(action.kind === "continue" && action.reason, "approved_browser_timeout_continuation");
  assert.deepEqual(
    action.kind === "continue" && action.forceToolChoice,
    { name: "sessions_send" },
  );
  assert.match(
    String(action.kind === "continue" && action.messages.at(-1)?.content),
    /approved browser action timed out before verification/,
  );
});

test("ContinuationController applies continue actions as hook continuations", () => {
  const controller = createContinuationController();
  const repairMarker: LLMMessage = {
    role: "user",
    content: "Runtime correction: request approval first.",
  };
  const messages: LLMMessage[] = [
    { role: "user", content: "original task" },
    repairMarker,
  ];
  const recorded: LLMMessage[] = [];

  assert.deepEqual(
    controller.applyContinueAction(
      {
        kind: "continue",
        messages,
        forceToolChoice: { name: "permission_query" },
        repairMarker,
        reason: "missing_approval_gate_repair_continuation",
      },
      {
        recordRepairMarker: (marker) => {
          recorded.push(marker);
        },
      },
    ),
    {
      messages,
      forceToolChoice: { name: "permission_query" },
    },
  );
  assert.deepEqual(recorded, [repairMarker]);
  assert.equal(controller.applyContinueAction({ kind: "none" }), null);
});

test("ContinuationController continues a coverage-critical sibling timeout", () => {
  const controller = createContinuationController();
  const timeoutSignal = {
    toolName: "sessions_spawn",
    sessionKey: "worker:explore:source-b:toolu-timeout",
    agentId: "explore",
    timeoutSeconds: 45,
    evidenceAvailable: true,
  };

  const action = controller.onAfterExecuteTimeoutContinuation({
    messages: [{ role: "user", content: "tool result history" }],
    taskPrompt: [
      "Compare providers with web search pricing evidence.",
      "Check all three sources before final: https://a.example, https://b.example, https://c.example.",
      "Do not finalize until all three sources are verified.",
    ].join("\n"),
    toolTrace: [],
    timeoutSignal,
    tools: [{ name: "sessions_send" }],
  });

  assert.equal(action.kind, "continue");
  assert.equal(action.kind === "continue" && action.reason, "coverage_timeout_continuation");
  assert.deepEqual(
    action.kind === "continue" && action.forceToolChoice,
    { name: "sessions_send" },
  );
  assert.match(
    String(action.kind === "continue" && action.messages.at(-1)?.content),
    /required delegated evidence stream timed out/,
  );
});

test("ContinuationController applies the post-execute continuation cascade", async () => {
  const controller = createContinuationController();
  const timeoutSignal = {
    toolName: "sessions_spawn",
    sessionKey: "worker:explore:source-b:toolu-timeout",
    agentId: "explore",
    timeoutSeconds: 45,
    evidenceAvailable: true,
  };

  const result = await controller.applyAfterExecuteContinuation(
    {
      messages: [{ role: "user", content: "tool result history" }],
      taskPrompt: [
        "Compare providers with web search pricing evidence.",
        "Check all three sources before final: https://a.example, https://b.example, https://c.example.",
        "Do not finalize until all three sources are verified.",
      ].join("\n"),
      toolTrace: [],
      timeoutSignal,
      completedSessionFinalContents: null,
      results: [],
      repairMarkers: [],
      tools: [{ name: "sessions_send" }, { name: "sessions_spawn" }],
    },
    async () => {
      throw new Error("forced round should not execute");
    },
  );

  assert.deepEqual(result?.forceToolChoice, { name: "sessions_send" });
  assert.match(
    String(result?.messages.at(-1)?.content),
    /required delegated evidence stream timed out/,
  );
});

test("ContinuationController owns after-execute continuation hook flow", async () => {
  const controller = createContinuationController();
  const messages: LLMMessage[] = [
    { role: "user", content: "Collect all independent streams." },
  ];
  const toolTrace = independentEvidenceTrace();
  const results = [
    {
      toolCallId: "toolu-source-a",
      toolName: "sessions_spawn",
      content: "Source A evidence.",
      isError: false,
      contentBytes: 18,
    },
  ];
  const events: string[] = [];

  const hookResult = await controller.applyAfterExecuteContinuationHook(
    {
      messages,
      taskPrompt: independentEvidenceTaskPrompt(),
      toolTrace,
      results,
      repairMarkers: [],
      tools: [{ name: "sessions_spawn" }],
      browserAvailable: true,
      observer: {
        onProviderToolProtocolRound: async (input) => {
          events.push("observer");
          assert.equal(input.round, 1);
          assert.deepEqual(input.toolCalls, [
            { id: "toolu-source-a", name: "sessions_spawn", input: {} },
          ]);
          assert.equal(input.toolResults, results);
          assert.equal(input.messages, messages);
        },
      },
      evidence: {
        currentRound: (roundResults) => {
          events.push("evidence");
          assert.equal(roundResults, results);
          return {
            timeoutSignals: [],
            completedSessions: [
              {
                toolName: "sessions_spawn",
                finalContents: ["Source A evidence."],
                browserRecoverySummaries: [],
              },
            ],
            roundEvidenceText: "Source A evidence.",
          };
        },
      },
    },
    async () => {
      throw new Error("forced round should not execute");
    },
  );

  assert.deepEqual(events, ["observer", "evidence"]);
  assert.deepEqual(hookResult?.forceToolChoice, { name: "sessions_spawn" });
  assert.match(
    String(hookResult?.messages.at(-1)?.content),
    /multiple independent evidence streams/,
  );
});

test("ContinuationController skips timeout continuation after marker or prior send", () => {
  const controller = createContinuationController();
  const timeoutSignal = {
    toolName: "sessions_spawn",
    sessionKey: "worker:explore:source-b:toolu-timeout",
    agentId: "explore",
    timeoutSeconds: 45,
    evidenceAvailable: true,
  };

  assert.deepEqual(
    controller.onAfterExecuteTimeoutContinuation({
      messages: [
        {
          role: "user",
          content:
            "Runtime correction: a required delegated evidence stream timed out.",
        },
      ],
      taskPrompt: [
        "Compare providers with web search pricing evidence.",
        "Check all three sources before final: https://a.example, https://b.example, https://c.example.",
        "Do not finalize until all three sources are verified.",
      ].join("\n"),
      toolTrace: [],
      timeoutSignal,
      tools: [{ name: "sessions_send" }],
    }),
    { kind: "none" },
  );
  assert.deepEqual(
    controller.onAfterExecuteTimeoutContinuation({
      messages: [{ role: "user", content: "tool result history" }],
      taskPrompt: [
        "Compare providers with web search pricing evidence.",
        "Check all three sources before final: https://a.example, https://b.example, https://c.example.",
        "Do not finalize until all three sources are verified.",
      ].join("\n"),
      toolTrace: sentTrace(timeoutSignal.sessionKey),
      timeoutSignal,
      tools: [{ name: "sessions_send" }],
    }),
    { kind: "none" },
  );
});

test("ContinuationController continues an incomplete approved browser session", () => {
  const controller = createContinuationController();

  const action = controller.continueIncompleteApprovedBrowserSession({
    results: incompleteApprovedBrowserResults(),
    messages: [{ role: "user", content: "tool result history" }],
    taskPrompt: approvedBrowserActionTaskPrompt(),
    toolTrace: permissionAppliedTrace(),
    tools: [{ name: "sessions_send" }],
  });

  assert.equal(action.kind, "continue");
  assert.equal(
    action.kind === "continue" && action.reason,
    "incomplete_approved_browser_session_continuation",
  );
  assert.deepEqual(
    action.kind === "continue" && action.forceToolChoice,
    { name: "sessions_send" },
  );
  assert.match(
    String(action.kind === "continue" && action.messages.at(-1)?.content),
    new RegExp(incompleteBrowserSessionKey),
  );
});

test("ContinuationController does not repeat an incomplete approved browser continuation", () => {
  const controller = createContinuationController();

  assert.deepEqual(
    controller.continueIncompleteApprovedBrowserSession({
      results: incompleteApprovedBrowserResults(),
      messages: [{ role: "user", content: "tool result history" }],
      taskPrompt: approvedBrowserActionTaskPrompt(),
      toolTrace: permissionAppliedTrace(true),
      tools: [{ name: "sessions_send" }],
    }),
    { kind: "none" },
  );
});

test("ContinuationController continues incomplete independent evidence streams", () => {
  const controller = createContinuationController();

  const action = controller.continueIndependentEvidenceStreams({
    messages: [{ role: "user", content: "tool result history" }],
    taskPrompt: independentEvidenceTaskPrompt(),
    toolTrace: independentEvidenceTrace(),
    tools: [{ name: "sessions_spawn" }],
  });

  assert.equal(action.kind, "continue");
  assert.equal(
    action.kind === "continue" && action.reason,
    "independent_evidence_stream_continuation",
  );
  assert.deepEqual(
    action.kind === "continue" && action.forceToolChoice,
    { name: "sessions_spawn" },
  );
  assert.match(
    String(action.kind === "continue" && action.messages.at(-1)?.content),
    /Only 1 of 3 required delegated evidence stream/,
  );
});

test("ContinuationController does not repeat an independent evidence stream prompt", () => {
  const controller = createContinuationController();

  assert.deepEqual(
    controller.continueIndependentEvidenceStreams({
      messages: [
        {
          role: "user",
          content:
            "Runtime correction: this task declares multiple independent evidence streams.",
        },
      ],
      taskPrompt: independentEvidenceTaskPrompt(),
      toolTrace: independentEvidenceTrace(),
      tools: [{ name: "sessions_spawn" }],
    }),
    { kind: "none" },
  );
});

test("ContinuationController continues missing approval-gate repair", () => {
  const controller = createContinuationController();

  const action = controller.continueMissingApprovalGateRepair({
    messages: [{ role: "user", content: "tool result history" }],
    taskPrompt: missingApprovalGateTaskPrompt(),
    resultText: "The browser form submission completed.",
    repairMarkers: [],
    toolTrace: [],
    tools: [{ name: "permission_query" }],
  });

  assert.equal(action.kind, "continue");
  assert.equal(
    action.kind === "continue" && action.reason,
    "missing_approval_gate_repair_continuation",
  );
  assert.deepEqual(
    action.kind === "continue" && action.forceToolChoice,
    { name: "permission_query" },
  );
  assert.match(
    String(action.kind === "continue" && action.repairMarker?.content),
    /approval-gated browser action/,
  );
  assert.deepEqual(
    action.kind === "continue" && action.messages.at(-1),
    action.kind === "continue" && action.repairMarker,
  );
});

test("ContinuationController does not repeat missing approval-gate repair after marker", () => {
  const controller = createContinuationController();

  assert.deepEqual(
    controller.continueMissingApprovalGateRepair({
      messages: [{ role: "user", content: "tool result history" }],
      taskPrompt: missingApprovalGateTaskPrompt(),
      resultText: "The browser form submission completed.",
      repairMarkers: [
        {
          role: "user",
          content:
            "Runtime correction: approval-gated browser action was finalized or described without native approval/tool evidence.",
        },
      ],
      toolTrace: [],
      tools: [{ name: "permission_query" }],
    }),
    { kind: "none" },
  );
});

test("ContinuationController skips missing approval-gate repair after permission evidence", () => {
  const controller = createContinuationController();

  assert.deepEqual(
    controller.continueMissingApprovalGateRepair({
      messages: [{ role: "user", content: "tool result history" }],
      taskPrompt: missingApprovalGateTaskPrompt(),
      resultText: "The browser form submission completed.",
      repairMarkers: [],
      toolTrace: pendingApprovalTrace(),
      tools: [{ name: "permission_query" }],
    }),
    { kind: "none" },
  );
});

test("ContinuationController builds a forced pending approval permission_result round", () => {
  const controller = createContinuationController();

  const action =
    controller.forcePendingApprovalWaitTimeoutPermissionResult({
      taskPrompt: approvalWaitTimeoutTaskPrompt(),
      toolTrace: pendingApprovalTrace(),
      tools: [{ name: "permission_result" }],
    });

  assert.equal(action.kind, "forced_tool_round");
  assert.equal(
    action.kind === "forced_tool_round" && action.reason,
    "forced_pending_approval_wait_timeout_permission_result",
  );
  assert.equal(
    action.kind === "forced_tool_round" && action.calls[0]?.name,
    "permission_result",
  );
  assert.equal(
    action.kind === "forced_tool_round" &&
      action.calls[0]?.input["approval_id"],
    "ap-1",
  );
  assert.match(
    action.kind === "forced_tool_round" ? action.assistantText : "",
    /Checking the pending approval result/,
  );
});

test("ContinuationController applies a forced permission_result round as hook continuation", async () => {
  const controller = createContinuationController();
  const action =
    controller.forcePendingApprovalWaitTimeoutPermissionResult({
      taskPrompt: approvalWaitTimeoutTaskPrompt(),
      toolTrace: pendingApprovalTrace(),
      tools: [{ name: "permission_result" }],
    });
  const forcedMessages: LLMMessage[] = [
    { role: "user", content: "original task" },
    {
      role: "tool",
      name: "permission_result",
      content: "pending",
    } as LLMMessage,
  ];
  const executed: unknown[] = [];

  assert.deepEqual(
    await controller.applyForcedToolRoundContinuation(action, async (round) => {
      executed.push(round);
      return { messages: forcedMessages };
    }),
    { messages: forcedMessages },
  );
  assert.deepEqual(executed, [action]);
  assert.equal(
    await controller.applyForcedToolRoundContinuation(
      { kind: "none" },
      async () => {
        throw new Error("should not execute");
      },
    ),
    null,
  );
});

test("ContinuationController does not repeat forced permission_result after a result exists", () => {
  const controller = createContinuationController();

  assert.deepEqual(
    controller.forcePendingApprovalWaitTimeoutPermissionResult({
      taskPrompt: approvalWaitTimeoutTaskPrompt(),
      toolTrace: pendingApprovalTrace(true),
      tools: [{ name: "permission_result" }],
    }),
    { kind: "none" },
  );
});
