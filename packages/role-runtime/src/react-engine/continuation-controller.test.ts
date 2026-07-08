import assert from "node:assert/strict";
import test from "node:test";

import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import { createContinuationController } from "./continuation-controller";
import { createEvidenceLedger } from "./evidence-ledger";

const sessionKey = "worker:explore:task-source:toolu-timeout";
const originalVendorAlphaSessionKey =
  "worker:explore:task:TASK-1783328702260-1168:call_function_msr6cg35iv3d_1";
const recoveryVendorAlphaSessionKey =
  "worker:explore:task:TASK-1783328748095-1510:call_function_14yvy85wf801_1";

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

function taskPromptWithSessionContinuationLabel(): string {
  return [
    "Task brief:",
    "Continue from the slow-source attempt in this mission.",
    "",
    "Previous tool result:",
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      session_key: sessionKey,
      agent_id: "explore",
      status: "completed",
      result: "source evidence complete",
    }),
    "",
    "Recent turns:",
    '[user] Continue this mission from the existing explore child session. The sessions_send input must include label "Mission route follow-up continuation" so mission source coverage can be audited.',
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

function vendorAlphaFollowupTaskPrompt(): string {
  return [
    "Original user goal (verbatim):",
    "Natural follow-up continuation",
    "Start a source-backed review of Vendor Alpha for a product lead.",
    "Source: http://127.0.0.1:51519/vendor-alpha",
    "Keep the work useful for a likely follow-up comparison rather than writing a one-off trivia answer.",
    "Focus on pricing, strength, and risk, and keep source labels visible in the answer.",
    "",
    "Latest user direction (verbatim):",
    "Continue from the previous work on this mission.",
    "Ask the same Vendor Alpha research thread to revisit its notes and turn the evidence into a decision note for a product lead.",
    "Keep continuity with that earlier research thread rather than starting the same Vendor Alpha work from scratch.",
    "Keep the answer source-bounded and call out any remaining risk or uncertainty from the collected evidence.",
  ].join("\n");
}

function listedVendorAlphaSessionsMessage(): LLMMessage {
  return {
    role: "tool",
    content: JSON.stringify({
      sessions: [
        {
          session_key: recoveryVendorAlphaSessionKey,
          agent_id: "explore",
          status: "resumable",
          label: "Vendor Alpha pricing extraction",
          created_at: 1783328762218,
          last_active_at: 1783328838139,
        },
        {
          session_key: originalVendorAlphaSessionKey,
          agent_id: "explore",
          status: "completed",
          label: "Vendor Alpha review",
          created_at: 1783328713209,
          last_active_at: 1783328726562,
        },
      ],
    }),
    toolCallId: "runtime-continuation-lookup-1",
    name: "sessions_list",
  };
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

function supplementalProbeTrace(): NativeToolRoundTrace[] {
  return [
    {
      round: 1,
      calls: [
        {
          id: "toolu-resume",
          name: "sessions_send",
          input: {
            session_key: "worker:explore:slow-source:toolu-timeout",
            message: "resume slow source",
          },
        },
      ],
      results: [],
    },
  ];
}

function supplementalProbeTaskPrompt(): string {
  return [
    "Continue the slow-source source-check after the previous timeout.",
    "Verify the local fixture at http://127.0.0.1:4173/source with browser-visible evidence.",
    "Do not finalize until response status/body/header or rendered page evidence is available.",
  ].join("\n");
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

function completedApprovedBrowserResultsWithPreSubmitEvidence(): Array<{
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
        evidence_summary: [
          "browser_open: Dry-run has not been submitted.",
          "browser_act: Dry-run submitted locally after approval; no external mutation was performed. TURNKEYAI_APPROVAL_FIXTURE_OK.",
        ].join("\n"),
        result:
          "Approved browser.form.submit completed. Post-submit page state verified.",
        final_content: [
          "Approved action: browser.form.submit triggered via browser_act with submit=true.",
          "Post-submit page state: Dry-run submitted locally after approval; no external mutation was performed. TURNKEYAI_APPROVAL_FIXTURE_OK.",
        ].join("\n"),
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

function completedSessionResult(
  toolCallId: string,
  finalContent: string,
): NativeToolRoundTrace["results"][number] {
  return {
    toolCallId,
    toolName: "sessions_spawn",
    content: JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      task_id: `task-${toolCallId}`,
      status: "completed",
      session_key: `worker:explore:${toolCallId}`,
      agent_id: "explore",
      tool_chain: ["explore"],
      result: finalContent,
      final_content: finalContent,
      payload: null,
    }),
    isError: false,
    contentBytes: 0,
  };
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

test("ContinuationController preserves requested sessions_send label in injected continuation", () => {
  const controller = createContinuationController();

  const action = controller.onRoundEmpty({
    active: true,
    messages: [],
    round: 1,
    taskPrompt: taskPromptWithSessionContinuationLabel(),
    toolTrace: [],
    tools: [{ name: "sessions_send" }, { name: "sessions_list" }],
  });

  assert.equal(action.kind, "inject_calls");
  assert.equal(
    action.kind === "inject_calls" && action.calls[0]?.name,
    "sessions_send",
  );
  assert.equal(
    action.kind === "inject_calls" && action.calls[0]?.input["label"],
    "Mission route follow-up continuation",
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
  assert.equal(
    action.kind === "inject_calls" && action.calls[0]?.input["limit"],
    5,
  );
  assert.match(
    String(action.kind === "inject_calls" && action.calls[0]?.input["reason"]),
    /^continuation lookup: Continue from the slow-source attempt in this mission/,
  );
});

test("ContinuationController resumes the original research thread from a same-thread session list", () => {
  const controller = createContinuationController();

  const action = controller.onRoundEmpty({
    active: true,
    messages: [listedVendorAlphaSessionsMessage()],
    round: 1,
    taskPrompt: vendorAlphaFollowupTaskPrompt(),
    toolTrace: [],
    tools: [{ name: "sessions_send" }, { name: "sessions_list" }],
  });

  assert.equal(action.kind, "inject_calls");
  assert.equal(
    action.kind === "inject_calls" && action.calls[0]?.name,
    "sessions_send",
  );
  assert.equal(
    action.kind === "inject_calls" &&
      action.calls[0]?.input["session_key"],
    originalVendorAlphaSessionKey,
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
      currentRoundEvidenceText: contentPoorTimeoutEvidence(),
      results: [],
      repairMarkers: [],
      tools: [{ name: "sessions_send" }, { name: "sessions_spawn" }],
      browserAvailable: true,
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

test("ContinuationController closes out repeated partial sessions_send evidence without more tools", async () => {
  const controller = createContinuationController();
  const partialContent = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "TASK-vendor-alpha-followup",
    session_key: originalVendorAlphaSessionKey,
    agent_id: "explore",
    status: "partial",
    tool_chain: ["explore"],
    result: "Partial evidence is available for the Vendor Alpha follow-up.",
    final_content:
      "Vendor Alpha verified pricing is $19 per seat. Strength: browser automation. Risk: limited API catalog remains unverified.",
    payload: {
      mode: "llm_sub_agent",
      workerType: "explore",
      resumableReason: "round_limit",
    },
  });
  const currentResult = {
    toolCallId: "toolu-current-send",
    toolName: "sessions_send",
    content: partialContent,
  };
  const messages: LLMMessage[] = [{ role: "user", content: vendorAlphaFollowupTaskPrompt() }];

  const ordinaryPartial = await controller.applyAfterExecuteContinuation(
    {
      messages,
      taskPrompt:
        "Continue the operations dashboard review; do not complete from resumable partial evidence.",
      toolTrace: [
        {
          round: 1,
          calls: [
            {
              id: "toolu-current-send",
              name: "sessions_send",
              input: { session_key: originalVendorAlphaSessionKey },
            },
          ],
          results: [],
        },
      ],
      timeoutSignal: null,
      completedSessionFinalContents: null,
      currentRoundEvidenceText: partialContent,
      results: [currentResult],
      repairMarkers: [],
      tools: [{ name: "sessions_send" }],
      browserAvailable: false,
    },
    async () => {
      throw new Error("forced round should not execute");
    },
  );
  assert.equal(ordinaryPartial, null);

  const synthesisPartial = await controller.applyAfterExecuteContinuation(
    {
      messages,
      taskPrompt: vendorAlphaFollowupTaskPrompt(),
      toolTrace: [
        {
          round: 1,
          calls: [
            {
              id: "toolu-current-send",
              name: "sessions_send",
              input: { session_key: originalVendorAlphaSessionKey },
            },
          ],
          results: [],
        },
      ],
      timeoutSignal: null,
      completedSessionFinalContents: null,
      currentRoundEvidenceText: partialContent,
      results: [currentResult],
      repairMarkers: [],
      tools: [{ name: "sessions_send" }],
      browserAvailable: false,
    },
    async () => {
      throw new Error("forced round should not execute");
    },
  );
  assert.equal(synthesisPartial?.forceToolChoice, "none");
  assert.match(
    String(synthesisPartial?.messages.at(-1)?.content),
    /source-synthesis follow-up/i,
  );

  const repeatedPartial = await controller.applyAfterExecuteContinuation(
    {
      messages,
      taskPrompt: vendorAlphaFollowupTaskPrompt(),
      toolTrace: [
        {
          round: 1,
          calls: [
            {
              id: "toolu-prior-send",
              name: "sessions_send",
              input: { session_key: originalVendorAlphaSessionKey },
            },
          ],
          results: [],
        },
        {
          round: 2,
          calls: [
            {
              id: "toolu-current-send",
              name: "sessions_send",
              input: { session_key: originalVendorAlphaSessionKey },
            },
          ],
          results: [],
        },
      ],
      timeoutSignal: null,
      completedSessionFinalContents: null,
      currentRoundEvidenceText: partialContent,
      results: [currentResult],
      repairMarkers: [],
      tools: [{ name: "sessions_send" }],
      browserAvailable: false,
    },
    async () => {
      throw new Error("forced round should not execute");
    },
  );

  assert.equal(repeatedPartial?.forceToolChoice, "none");
  assert.match(
    String(repeatedPartial?.messages.at(-1)?.content),
    /same delegated session returned partial evidence after repeated continuation/i,
  );
  assert.match(String(repeatedPartial?.messages.at(-1)?.content), /\$19 per seat/);
  assert.doesNotMatch(String(repeatedPartial?.messages.at(-1)?.content), /Call sessions_send exactly once/i);
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

test("ContinuationController runs a supplemental local timeout probe without a completed session", () => {
  const controller = createContinuationController();

  const action = controller.continueSupplementalLocalTimeoutProbe({
    messages: [{ role: "user", content: "tool result history" }],
    taskPrompt: supplementalProbeTaskPrompt(),
    toolTrace: supplementalProbeTrace(),
    evidenceText: contentPoorTimeoutEvidence(),
    completedSessionEvidence: false,
    timeoutSignal: {
      toolName: "sessions_send",
      sessionKey: "worker:explore:slow-source:toolu-timeout",
      agentId: "explore",
      timeoutSeconds: 45,
      evidenceAvailable: true,
    },
    tools: [{ name: "sessions_spawn" }],
    browserAvailable: true,
  });

  assert.equal(action.kind, "continue");
  assert.equal(
    action.kind === "continue" && action.reason,
    "supplemental_local_timeout_probe",
  );
  assert.deepEqual(
    action.kind === "continue" && action.forceToolChoice,
    { name: "sessions_spawn" },
  );
  assert.match(
    String(action.kind === "continue" && action.messages.at(-1)?.content),
    /resumed timeout evidence is still content-poor/,
  );
});

test("ContinuationController runs a supplemental local timeout probe for completed session evidence", () => {
  const controller = createContinuationController();

  const action = controller.continueSupplementalLocalTimeoutProbe({
    messages: [{ role: "user", content: "tool result history" }],
    taskPrompt: supplementalProbeTaskPrompt(),
    toolTrace: supplementalProbeTrace(),
    evidenceText: contentPoorTimeoutEvidence(),
    completedSessionEvidence: true,
    timeoutSignal: null,
    tools: [{ name: "sessions_spawn" }],
    browserAvailable: true,
  });

  assert.equal(action.kind, "continue");
  assert.equal(
    action.kind === "continue" && action.reason,
    "supplemental_local_timeout_probe",
  );
});

test("ContinuationController does not run the no-completed supplemental probe for browser timeouts", () => {
  const controller = createContinuationController();

  assert.deepEqual(
    controller.continueSupplementalLocalTimeoutProbe({
      messages: [{ role: "user", content: "tool result history" }],
      taskPrompt: supplementalProbeTaskPrompt(),
      toolTrace: supplementalProbeTrace(),
      evidenceText: contentPoorTimeoutEvidence(),
      completedSessionEvidence: false,
      timeoutSignal: {
        toolName: "sessions_send",
        sessionKey: "worker:browser:slow-source:toolu-timeout",
        agentId: "browser",
        timeoutSeconds: 45,
        evidenceAvailable: true,
      },
      tools: [{ name: "sessions_spawn" }],
      browserAvailable: true,
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

test("ContinuationController does not continue a completed approved browser session with pre-submit history", () => {
  const controller = createContinuationController();

  assert.deepEqual(
    controller.continueIncompleteApprovedBrowserSession({
      results: completedApprovedBrowserResultsWithPreSubmitEvidence(),
      messages: [{ role: "user", content: "tool result history" }],
      taskPrompt: approvedBrowserActionTaskPrompt(),
      toolTrace: permissionAppliedTrace(),
      tools: [{ name: "sessions_send" }],
    }),
    { kind: "none" },
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

test("ContinuationController does not continue independent evidence streams completed in the current round", async () => {
  const controller = createContinuationController();
  const results = [
    completedSessionResult("toolu-alpha", "Vendor Alpha evidence."),
    completedSessionResult("toolu-beta", "Vendor Beta evidence."),
  ];

  const action = await controller.applyAfterExecuteContinuationHook(
    {
      messages: [{ role: "user", content: "tool result history" }],
      taskPrompt: [
        "Compare two independent sources.",
        "Call sessions_spawn exactly twice: one child session for Vendor Alpha and one child session for Vendor Beta.",
        "Do not finalize until both streams complete.",
      ].join("\n"),
      toolTrace: [
        {
          round: 1,
          calls: [
            { id: "toolu-alpha", name: "sessions_spawn", input: {} },
            { id: "toolu-beta", name: "sessions_spawn", input: {} },
          ],
          results,
        },
      ],
      results,
      repairMarkers: [],
      tools: [{ name: "sessions_spawn" }],
      browserAvailable: true,
      observer: { onProviderToolProtocolRound: async () => {} },
      evidence: createEvidenceLedger(),
    },
    async () => {
      throw new Error("forced continuation should not run");
    },
  );

  assert.equal(action, null);
});

test("ContinuationController forces missing named independent evidence source when source URLs are explicit", () => {
  const controller = createContinuationController();

  const action = controller.continueIndependentEvidenceStreams({
    messages: [{ role: "user", content: "tool result history" }],
    taskPrompt: [
      "Prepare a decision-ready AsiaWalk pilot brief for a travel product lead.",
      "Route source: http://127.0.0.1:61992/asiawalk-route",
      "Budget source: http://127.0.0.1:61992/asiawalk-budget",
      "Live readiness dashboard: http://127.0.0.1:61992/asiawalk-live",
      "Treat route, budget, and live readiness as separate evidence streams.",
      "Do not finalize until all three streams have returned.",
    ].join("\n"),
    toolTrace: [
      {
        round: 1,
        calls: [
          {
            id: "toolu-route",
            name: "sessions_spawn",
            input: { agent_id: "browser", task: "route" },
          },
          {
            id: "toolu-budget",
            name: "sessions_spawn",
            input: { agent_id: "browser", task: "budget" },
          },
        ],
        results: [
          {
            toolCallId: "toolu-route",
            toolName: "sessions_spawn",
            content: JSON.stringify({
              protocol: "turnkeyai.session_tool_result.v1",
              task_id: "task-asiawalk",
              status: "completed",
              session_key: "worker:browser:task-asiawalk:toolu-route",
              agent_id: "browser",
              label: "AsiaWalk Route Stream",
              tool_chain: ["browser"],
              result:
                "Route source URL http://127.0.0.1:61992/asiawalk-route verified.",
              final_content:
                "Route source URL http://127.0.0.1:61992/asiawalk-route verified.",
              payload: null,
            }),
            isError: false,
            contentBytes: 0,
          },
          {
            toolCallId: "toolu-budget",
            toolName: "sessions_spawn",
            content: JSON.stringify({
              protocol: "turnkeyai.session_tool_result.v1",
              task_id: "task-asiawalk",
              status: "completed",
              session_key: "worker:browser:task-asiawalk:toolu-budget",
              agent_id: "browser",
              label: "AsiaWalk Budget Stream",
              tool_chain: ["browser"],
              result:
                "Budget source URL http://127.0.0.1:61992/asiawalk-budget verified.",
              final_content:
                "Budget source URL http://127.0.0.1:61992/asiawalk-budget verified.",
              payload: null,
            }),
            isError: false,
            contentBytes: 0,
          },
        ],
      },
    ],
    tools: [{ name: "sessions_spawn" }],
  });

  assert.equal(action.kind, "forced_tool_round");
  assert.equal(
    action.kind === "forced_tool_round" && action.reason,
    "missing_named_independent_evidence_stream",
  );
  assert.equal(
    action.kind === "forced_tool_round" && action.calls[0]?.name,
    "sessions_spawn",
  );
  assert.equal(
    action.kind === "forced_tool_round" &&
      action.calls[0]?.input["agent_id"],
    "browser",
  );
  assert.match(
    String(
      action.kind === "forced_tool_round" && action.calls[0]?.input["task"],
    ),
    /asiawalk-live/,
  );
});

test("ContinuationController keeps model correction when named source matches are ambiguous", () => {
  const controller = createContinuationController();

  const action = controller.continueIndependentEvidenceStreams({
    messages: [{ role: "user", content: "tool result history" }],
    taskPrompt: [
      "Prepare a product-ready brief about the next release.",
      "Research source: http://127.0.0.1/source-one",
      "Capability source: http://127.0.0.1/source-two",
      "Live signal dashboard: http://127.0.0.1/source-three",
    ].join("\n"),
    toolTrace: [
      {
        round: 1,
        calls: [
          {
            id: "toolu-one",
            name: "sessions_spawn",
            input: { agent_id: "explore", task: "broad product pass" },
          },
        ],
        results: [
          {
            toolCallId: "toolu-one",
            toolName: "sessions_spawn",
            content: JSON.stringify({
              protocol: "turnkeyai.session_tool_result.v1",
              task_id: "task-one",
              status: "completed",
              session_key: "worker:explore:task-one:toolu-one",
              agent_id: "explore",
              label: "broad product brief",
              result: "broad product brief evidence complete.",
              final_content:
                "broad product brief verified evidence. Residual risk: local fixture only.",
              payload: null,
            }),
            isError: false,
            contentBytes: 0,
          },
        ],
      },
    ],
    tools: [{ name: "sessions_spawn" }],
  });

  assert.equal(action.kind, "continue");
  assert.equal(
    action.kind === "continue" && action.reason,
    "independent_evidence_stream_continuation",
  );
});

test("ContinuationController repeats independent evidence stream correction until required streams complete", () => {
  const controller = createContinuationController();

  const action = controller.continueIndependentEvidenceStreams({
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
  });

  assert.equal(action.kind, "continue");
  assert.match(
    String(action.kind === "continue" && action.messages.at(-1)?.content),
    /Only 1 of 3 required delegated evidence stream/,
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
