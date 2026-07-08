import assert from "node:assert/strict";
import test from "node:test";

import type {
  GenerateTextResult,
  LLMMessage,
  LLMToolCall,
} from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RolePromptPacket } from "../prompt-policy";
import { createCompletedCloseoutController } from "./completed-closeout-controller";
import { createRepairPolicyRegistry } from "./repair-policy-registry";

function textResult(
  text: string,
  toolCalls?: LLMToolCall[],
): GenerateTextResult {
  return {
    text,
    ...(toolCalls ? { toolCalls } : {}),
    modelId: "test-model",
    providerId: "test-provider",
    protocol: "anthropic-compatible",
    adapterName: "test-adapter",
    raw: null,
  };
}

function messageText(message: LLMMessage | undefined): string {
  assert.ok(message);
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => JSON.stringify(block)).join("\n");
}

function packet(
  taskPrompt: string,
  outputContract = "",
): RolePromptPacket {
  return {
    roleId: "role:test",
    roleName: "Test Role",
    seat: "member",
    systemPrompt: "You are testing.",
    taskPrompt,
    outputContract,
    suggestedMentions: [],
  } as RolePromptPacket;
}

function sessionTrace(input: {
  toolName?: "sessions_spawn" | "sessions_send";
  status?: "completed" | "timeout";
  result: string;
}): NativeToolRoundTrace[] {
  const toolName = input.toolName ?? "sessions_send";
  const content = JSON.stringify({
    task_id: "task-1",
    session_key: "worker:browser:task-1",
    agent_id: "browser",
    status: input.status ?? "completed",
    result: input.result,
  });
  return [
    {
      round: 1,
      calls: [{ id: "toolu-session", name: toolName, input: {} }],
      results: [
        {
          toolCallId: "toolu-session",
          toolName,
          content,
          isError: false,
          contentBytes: content.length,
        },
      ],
    },
  ];
}

test("CompletedCloseoutController repairs completed-only synthesis and cleans up tool-call artifacts", async () => {
  const controller = createCompletedCloseoutController();
  const repairMessagesSeen: LLMMessage[][] = [];
  const cleanupMessagesSeen: LLMMessage[][] = [];
  const repairMarkers: LLMMessage[] = [];

  const result = await controller.runRepairLoop({
    taskPrompt:
      "Review the delegated session's pricing finding and tell me the next action the operator should take.",
    toolTrace: [],
    repairMessages: [],
    repairMarkers,
    completedSessionFinalContents: [
      "The delegated session verified the plan is $10 per month.",
    ],
    completedEvidenceText:
      "The delegated session verified the plan is $10 per month.",
    delegatedEvidenceText:
      "The delegated session verified the plan is $10 per month.",
    initialResult: textResult("The plan is verified at $10 per month."),
    repairPolicy: createRepairPolicyRegistry(),
    synthesizeRepair: async ({ messages }) => {
      repairMessagesSeen.push(messages);
      return {
        result: textResult("Calling a tool.", [
          { id: "toolu-artifact", name: "sessions_spawn", input: {} },
        ]),
        memoryFlush: "repair-flush",
      };
    },
    synthesizeToolCallArtifactCleanup: async ({ messages }) => {
      cleanupMessagesSeen.push(messages);
      return {
        result: textResult(
          "The plan is verified at $10 per month. Next action: monitor the pricing page for changes.",
        ),
        memoryFlush: "cleanup-flush",
      };
    },
  });

  assert.equal(result.kind, "final");
  assert.match(result.result.text, /Next action/i);
  assert.deepEqual(result.memoryFlushes, ["repair-flush", "cleanup-flush"]);
  assert.equal(repairMarkers.length, 1);
  assert.match(messageText(repairMarkers[0]), /requested next action is missing/i);
  assert.equal(repairMessagesSeen.length, 1);
  assert.match(
    messageText(repairMessagesSeen[0]?.at(-1)),
    /requested next action is missing/i,
  );
  assert.equal(cleanupMessagesSeen.length, 1);
  assert.equal(messageText(cleanupMessagesSeen[0]?.at(-1)), "Calling a tool.");
});

test("CompletedCloseoutController deterministically repairs product briefs that drop rendered counters", async () => {
  const controller = createCompletedCloseoutController();
  const repairMarkers: LLMMessage[] = [];
  let repairCalls = 0;
  const taskPrompt = [
    "Prepare a product-ready brief about the next agent workbench release.",
    "Research source: http://127.0.0.1/product-orchestration",
    "Capability source: http://127.0.0.1/product-bridge",
    "Live signal dashboard: http://127.0.0.1/product-signals",
    "These are three independent evidence streams. Use specialist work where it helps, and use browser-visible evidence for the live signal dashboard.",
    "The final brief must explicitly include Mission Control, Stuck missions, Weak answer rate, and the signal-dashboard recommended next action when those values are present.",
  ].join("\n");
  const evidence = [
    "TURNKEYAI_PRODUCT_ORCHESTRATION_OK. Product orchestration verified Mission Control, multi-agent decomposition, and durable sub-session history.",
    "TURNKEYAI_PRODUCT_BRIDGE_OK. Product bridge verified browser controls, screenshots, artifacts, command-line setup, and provider configuration risk.",
    [
      "TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK.",
      "| Field | Value |",
      "| --- | --- |",
      "| Stuck Missions Count | 6 |",
      "| Weak Answer Rate | 24% |",
      '| Recommended Next Action | "make Mission Control the default entry and gate release on real LLM scenario quality" |',
      "This was rendered browser evidence, not raw HTML.",
    ].join("\n"),
  ];
  const messages: LLMMessage[] = evidence.map((finalContent, index) => ({
    role: "tool",
    toolCallId: `toolu-${index + 1}`,
    name: "sessions_spawn",
    content: JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      task_id: `task-${index + 1}`,
      session_key: `worker:browser:task-${index + 1}:toolu-${index + 1}`,
      agent_id: "browser",
      label:
        index === 0
          ? "product-orchestration"
          : index === 1
            ? "product-bridge"
            : "product-signals",
      status: "completed",
      tool_chain: ["browser"],
      result: finalContent,
      final_content: finalContent,
      payload: null,
    }),
  }));

  const result = await controller.runRepairLoop({
    taskPrompt,
    toolTrace: [],
    repairMessages: messages,
    repairMarkers,
    completedSessionFinalContents: evidence,
    completedEvidenceText: evidence.join("\n\n"),
    delegatedEvidenceText: evidence.join("\n\n"),
    initialResult: textResult(
      [
        "# Agent Workbench brief",
        "Mission Control should be the default entry.",
        "Stuck missions and Weak answer rate were rendered but not captured in delegated evidence text.",
      ].join("\n"),
    ),
    repairPolicy: createRepairPolicyRegistry(),
    synthesizeRepair: async () => {
      repairCalls += 1;
      return { result: textResult("model repair should not run") };
    },
    synthesizeToolCallArtifactCleanup: async () => {
      throw new Error("cleanup should not run");
    },
  });

  assert.equal(result.kind, "final");
  assert.equal(repairCalls, 0);
  assert.match(result.result.text, /Mission 状态：done/);
  assert.match(result.result.text, /Stuck missions: 6/);
  assert.match(result.result.text, /Weak answer rate: 24%/);
  assert.match(result.result.text, /rendered browser evidence, not raw HTML/);
  assert.equal(
    (result.result.raw as Record<string, unknown>)["localEvidenceKind"],
    "agent_workbench_product_brief",
  );
  assert.equal(repairMarkers.length, 1);
  assert.match(
    messageText(repairMarkers[0]),
    /final product brief dropped required source-backed workbench evidence/,
  );
});

test("CompletedCloseoutController appends missing completed source labels after synthesis", () => {
  const controller = createCompletedCloseoutController();
  const rawToolResults = [
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      status: "completed",
      agent_id: "explore",
      label: "Transform to decision note",
      final_content:
        "Decision note verified Vendor Alpha pricing, strength, and risk from prior evidence.",
    }),
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      status: "completed",
      agent_id: "explore",
      label: "Vendor Alpha - supplemental surface check",
      final_content:
        "Supplemental check found no new evidence beyond the root Vendor Alpha page.",
    }),
  ].join("\n\n");

  const result = controller.finalizeCompletedVisibility({
    packet: packet(
      [
        "Ask the same Vendor Alpha research thread to revisit its notes and turn the evidence into a decision note for a product lead.",
        "Keep the answer source-bounded and keep source labels visible in the answer.",
      ].join("\n"),
    ),
    result: textResult(
      [
        "## Vendor Alpha Decision Note",
        "",
        "Source: http://127.0.0.1/vendor-alpha.",
        "Pricing is $19/seat; browser automation and traceable screenshots are strengths; limited API catalog remains the main risk.",
      ].join("\n"),
    ),
    messages: [],
    toolTrace: [],
    completedSession: {
      finalContents: [
        "Decision note verified Vendor Alpha pricing, strength, and risk from prior evidence.",
        "Supplemental check found no new evidence beyond the root Vendor Alpha page.",
      ],
      browserRecoverySummaries: [],
    },
    completedSessionToolResultText: rawToolResults,
  });

  assert.match(result.text, /Evidence \/ Sources:/);
  assert.match(result.text, /Transform to decision note/);
  assert.match(result.text, /Vendor Alpha - supplemental surface check/);
});

test("CompletedCloseoutController appends browser continuation source labels", () => {
  const controller = createCompletedCloseoutController();
  const rawToolResults = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    status: "completed",
    agent_id: "browser",
    label: "Re-check dashboard state",
    final_content:
      "Rendered dashboard state confirmed queue depth 11, SLA breaches 3, and owner Incident Commander.",
  });

  const result = controller.finalizeCompletedVisibility({
    packet: packet(
      [
        "Continue the operations dashboard review from the browser context already used in this mission.",
        "Re-check the rendered dashboard state if needed, then explain whether the escalation owner and next action still look correct.",
      ].join("\n"),
    ),
    result: textResult(
      [
        "Queue depth is 11.",
        "SLA breaches are 3.",
        "Escalation owner is Incident Commander.",
      ].join("\n"),
    ),
    messages: [],
    toolTrace: [],
    completedSession: {
      finalContents: [
        "Rendered dashboard state confirmed queue depth 11, SLA breaches 3, and owner Incident Commander.",
      ],
      browserRecoverySummaries: [],
    },
    completedSessionToolResultText: rawToolResults,
  });

  assert.match(result.text, /Evidence \/ Sources:/);
  assert.match(result.text, /Re-check dashboard state/);
});

test("CompletedCloseoutController appends approval browser action source labels after synthesis", () => {
  const controller = createCompletedCloseoutController();
  const rawToolResults = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    status: "completed",
    agent_id: "browser",
    label: "Execute approved form submission",
    final_content:
      "Post-submit page state verified TURNKEYAI_APPROVAL_FIXTURE_OK and local dry-run submission after approval.",
  });

  const result = controller.finalizeCompletedVisibility({
    packet: packet(
      [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        "The dry-run action under review is the form submission, not just opening the page.",
        "Actually carry the safe local dry-run through the approval gate.",
      ].join("\n"),
    ),
    result: textResult(
      [
        "Approved action: browser.form.submit.",
        "Post-submit page state: TURNKEYAI_APPROVAL_FIXTURE_OK and local dry-run submission confirmed.",
      ].join("\n"),
    ),
    messages: [],
    toolTrace: [],
    completedSession: {
      finalContents: [
        "Post-submit page state verified TURNKEYAI_APPROVAL_FIXTURE_OK and local dry-run submission after approval.",
      ],
      browserRecoverySummaries: [],
    },
    completedSessionToolResultText: rawToolResults,
  });

  assert.match(result.text, /Evidence \/ Sources:/);
  assert.match(result.text, /Execute approved form submission/);
});

test("CompletedCloseoutController preserves approval gated action literal after synthesis", () => {
  const controller = createCompletedCloseoutController();
  const rawToolResults = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    status: "completed",
    agent_id: "browser",
    label: "approval-gated-browser-e2e",
    final_content:
      "sessions_spawn(browser) opened the local fixture, verified TURNKEYAI_APPROVAL_FIXTURE_OK, and confirmed no external mutation was performed.",
  });

  const result = controller.finalizeCompletedVisibility({
    packet: packet(
      [
        "Run the mission route approval-gated browser E2E.",
        "The browser task must include the exact action phrase browser.form.submit and the word submit so the runtime approval gate is exercised before browser work starts.",
        "Do not ask the browser sub-agent to click a real submit control; this is an approval-gate fixture, not a real external mutation.",
      ].join("\n"),
    ),
    result: textResult(
      [
        "## Evidence",
        "- Approval request: TURNKEYAI_MISSION_APPROVAL_OK; permission.query blocked the gated browser work before browser work started.",
        "- Approval decision/application: permission.result approved the request and permission.applied cached it for the runtime gate.",
        "- Browser fixture evidence: source approval-gated-browser-e2e; sessions_spawn(browser) verified TURNKEYAI_APPROVAL_FIXTURE_OK and no external mutation was performed.",
        "- Residual risk: this validates the approval gate and local fixture path, not a real external submit.",
      ].join("\n"),
    ),
    messages: [],
    toolTrace: [],
    completedSession: {
      finalContents: [
        "permission.query, permission.result, and permission.applied were observed for the approval-gated local fixture run.",
        "sessions_spawn(browser) verified TURNKEYAI_APPROVAL_FIXTURE_OK and no external mutation was performed.",
      ],
      browserRecoverySummaries: [],
    },
    completedSessionToolResultText: rawToolResults,
  });

  assert.match(result.text, /\bbrowser\.form\.submit\b/);
  assert.match(result.text, /Approved action:/);
});

test("CompletedCloseoutController preserves approval E2E target marker after synthesis", () => {
  const controller = createCompletedCloseoutController();
  const rawToolResults = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    status: "completed",
    agent_id: "browser",
    label: "E2E Browser Form Submit",
    result: "Approved browser.form.submit completed after permission.applied.",
    payload: {
      marker: "TURNKEYAI_APPROVAL_WORKER_OK",
      action: "browser.form.submit",
      content:
        "Browser evidence: browser.form.submit completed only after permission.query, permission.result, and permission.applied.",
    },
  });

  const result = controller.finalizeCompletedVisibility({
    packet: packet(
      [
        "Run the approval-gated browser side-effect E2E.",
        "Request approval for browser.form.submit, apply the approval, then ask the browser sub-agent to open https://example.test/account and perform the approved browser.form.submit submit action.",
        "Final answer must include TURNKEYAI_APPROVAL_E2E_OK, permission.query, permission.result, permission.applied, and browser.form.submit.",
      ].join("\n"),
    ),
    result: textResult(
      [
        "## Evidence",
        "- permission.query: Requested approval for browser.form.submit.",
        "- permission.result: Returned permission.applied status with approvalId ap-1.",
        "- permission.applied: Applied to runtime cache before browser worker execution.",
        "- browser.form.submit: Completed after permission.applied.",
        "- residual risk: deterministic local fixture only.",
      ].join("\n"),
    ),
    messages: [],
    toolTrace: [],
    completedSession: {
      finalContents: [
        "permission.query, permission.result, and permission.applied were observed before the browser worker.",
        "Approved browser.form.submit completed after permission.applied.",
      ],
      browserRecoverySummaries: [],
    },
    completedSessionToolResultText: rawToolResults,
  });

  assert.match(result.text, /TURNKEYAI_APPROVAL_E2E_OK/);
});

test("CompletedCloseoutController re-arms through registry before round>0 table repairs and returns pending reduction", async () => {
  const controller = createCompletedCloseoutController();
  const repairMarkers: LLMMessage[] = [];
  let repairCalls = 0;

  const result = await controller.runRepairLoop({
    taskPrompt:
      "Return table: provider, evidence URL. Inspect the browser-visible rendered page and also tell me the next action the operator should take.",
    toolTrace: [],
    tools: [{ name: "sessions_spawn" }],
    repairMessages: [],
    repairMarkers,
    completedSessionFinalContents: [
      "Provider A pricing was verified from https://a.example.",
    ],
    completedEvidenceText:
      "Provider A pricing was verified from https://a.example.",
    delegatedEvidenceText:
      "Provider A pricing was verified from https://a.example.",
    initialResult: textResult(
      ["| provider | evidence URL |", "| --- | --- |", "| A | https://a.example |"].join(
        "\n",
      ),
    ),
    repairPolicy: createRepairPolicyRegistry(),
    synthesizeRepair: async () => {
      repairCalls += 1;
      return {
        result: textResult(
          [
            "I could not verify the rendered page because browser session tools are unavailable.",
            "",
            "| provider |",
            "| --- |",
            "| A |",
          ].join("\n"),
        ),
        reduction: { level: "compact" },
        reductionSnapshot: { level: "compact", artifactIds: ["a1"] },
        memoryFlush: "repair-flush",
      };
    },
    synthesizeToolCallArtifactCleanup: async () => {
      throw new Error("cleanup should not run when the controller re-arms");
    },
  });

  assert.equal(result.kind, "rearm");
  assert.equal(repairCalls, 1);
  assert.deepEqual(result.memoryFlushes, ["repair-flush"]);
  assert.deepEqual(result.reduction, { level: "compact" });
  assert.deepEqual(result.reArm.reArm.forceToolChoice, { name: "sessions_spawn" });
  assert.match(
    messageText(result.reArm.reArm.messages.at(-1)),
    /browser-visible evidence is missing/i,
  );
  assert.equal(repairMarkers.length, 2);
});

test("CompletedCloseoutController terminal synthesis records initial flush and finalized repair", async () => {
  const controller = createCompletedCloseoutController();
  const repairMarkers: LLMMessage[] = [];
  const repairMessagesSeen: LLMMessage[][] = [];
  let cleanupCalls = 0;

  const result = await controller.synthesizeTerminalCloseout({
    packet: packet(
      "Review the delegated pricing finding and tell me the next action the operator should take.",
    ),
    toolTrace: [],
    messages: [],
    repairMarkers,
    completedSession: {
      finalContents: ["The delegated session verified the plan is $10 per month."],
      browserRecoverySummaries: [],
    },
    completedSessionToolResultText: "",
    initialSynthesis: {
      result: textResult("The plan is verified at $10 per month."),
      reduction: { level: "initial" },
      reductionSnapshot: { level: "initial", artifactIds: ["r1"] },
      memoryFlush: "initial-flush",
    },
    repairPolicy: createRepairPolicyRegistry(),
    synthesizeRepair: async ({ messages }) => {
      repairMessagesSeen.push(messages);
      return {
        result: textResult(
          "The plan is verified at $10 per month. Next action: monitor the pricing page for changes.",
        ),
        memoryFlush: "repair-flush",
      };
    },
    synthesizeToolCallArtifactCleanup: async () => {
      cleanupCalls += 1;
      return { result: textResult("cleanup should not run") };
    },
  });

  assert.equal(result.kind, "final");
  assert.match(result.result.text, /Next action/i);
  assert.deepEqual(result.memoryFlushes, ["initial-flush", "repair-flush"]);
  assert.deepEqual(result.reduction, { level: "initial" });
  assert.deepEqual(result.reductionSnapshot, {
    level: "initial",
    artifactIds: ["r1"],
  });
  assert.equal(cleanupCalls, 0);
  assert.equal(repairMessagesSeen.length, 1);
  assert.equal(repairMarkers.length, 1);
  assert.match(
    messageText(repairMessagesSeen[0]?.at(-1)),
    /requested next action is missing/i,
  );
});

test("CompletedCloseoutController finalizes completed browser visibility in order", () => {
  const controller = createCompletedCloseoutController();

  const result = controller.finalizeCompletedVisibility({
    packet: packet(
      "Continue the previous browser session after it timed out and recover the dashboard.",
    ),
    result: textResult("The dashboard shows the expected marker."),
    messages: [],
    toolTrace: [],
    completedSession: {
      finalContents: ["The dashboard reopened with the expected marker."],
      browserRecoverySummaries: [
        "Browser recovery metadata: Resume mode: warm.",
      ],
    },
    completedSessionToolResultText: "cdp_command_timeout",
  });

  assert.match(result.text, /Browser continuity: browser context was recovered/i);
  assert.match(result.text, /Browser limitation: cdp_command_timeout/i);
  assert.ok(
    result.text.indexOf("Browser continuity:") <
      result.text.indexOf("Browser limitation:"),
  );
});

test("CompletedCloseoutController carries dashboard on-call action from completed browser evidence", () => {
  const controller = createCompletedCloseoutController();

  const evidence = [
    "Browser observed Operations Dashboard Fixture.",
    "Visible text excerpt: Operations dashboard TURNKEYAI_DASHBOARD_TRIAGE_OK Queue depth: 11 SLA breaches: 3 Escalation threshold: queue depth above 5 or SLA breaches above 0 pages the on-call. Recommended owner: Incident Commander Residual risk: local dynamic dashboard fixture only.",
  ].join("\n");
  const result = controller.finalizeCompletedVisibility({
    packet: packet(
      [
        "An operator asks for help reading a live operations dashboard in the browser before paging anyone.",
        "Explain whether the escalation policy is triggered, who should own the next action, and what risk remains after your check.",
      ].join("\n"),
    ),
    result: textResult(
      [
        "Escalation policy triggered: yes, queue depth and SLA breaches are above threshold.",
        "Owner: Incident Commander.",
        "Residual risk: local fixture only.",
      ].join("\n"),
    ),
    messages: [],
    toolTrace: [],
    completedSession: {
      finalContents: [evidence],
      browserRecoverySummaries: [],
    },
    completedSessionToolResultText: evidence,
  });

  assert.match(result.text, /Recommended dashboard action:/);
  assert.match(result.text, /pages the on-call/);
  assert.match(result.text, /Incident Commander is the recommended owner/);
});

test("CompletedCloseoutController carries dashboard owner and next action values from cold recovery evidence", () => {
  const controller = createCompletedCloseoutController();

  const evidence = [
    "Browser recovery metadata: Resume mode: cold. Session ID: browser-session-new.",
    "Browser failure buckets: session_not_found=1.",
    "## Cold-Recovery Report: Operations Dashboard",
    "- **Operational state:** `TURNKEYAI_DASHBOARD_TRIAGE_OK` — observed directly in rendered DOM",
    "- **Escalation trigger — queue depth:** threshold above 5; current 11 — triggered",
    "- **Escalation trigger — SLA breaches:** threshold above 0; current 3 — triggered",
    "- **Owner:** Incident Commander — observed directly in rendered DOM",
    "- **Next action:** Pages the on-call — observed directly in rendered DOM",
  ].join("\n");
  const result = controller.finalizeCompletedVisibility({
    packet: packet(
      [
        "Continue the operations dashboard review from the same browser-backed work.",
        "The earlier browser session may no longer be available; recover by reopening the same read-only dashboard when needed.",
        "Re-check the rendered dashboard state and give the operator the current owner, next action, and residual uncertainty.",
      ].join("\n"),
    ),
    result: textResult(
      [
        "## Operations Dashboard — Operator Summary",
        "| Field | Value |",
        "| --- | --- |",
        "| **Owner** | Present in rendered dashboard card (client-side JS) |",
        "| **Next action** | Present in rendered dashboard card (client-side JS) |",
      ].join("\n"),
    ),
    messages: [],
    toolTrace: [],
    completedSession: {
      finalContents: [evidence],
      browserRecoverySummaries: [
        "Browser recovery metadata: Resume mode: cold. Session ID: browser-session-new.",
      ],
    },
    completedSessionToolResultText: evidence,
  });

  assert.match(result.text, /Incident Commander/);
  assert.match(result.text, /pages the on-call/i);
  assert.match(result.text, /Queue depth:\s*11/i);
  assert.match(result.text, /SLA breaches:\s*3/i);
  assert.match(result.text, /this run did not page anyone/i);
});

test("CompletedCloseoutController does not claim read-only dashboard review already paged anyone", () => {
  const controller = createCompletedCloseoutController();

  const evidence =
    "Visible text excerpt: Operations dashboard TURNKEYAI_DASHBOARD_TRIAGE_OK Queue depth: 11 SLA breaches: 3 Escalation threshold: queue depth above 5 or SLA breaches above 0 pages the on-call. Recommended owner: Incident Commander.";
  const result = controller.finalizeCompletedVisibility({
    packet: packet(
      "Review this operations dashboard in the browser before paging anyone, then explain the escalation policy and next owner.",
    ),
    result: textResult(
      "Escalation policy triggered. Next action owner: Incident Commander (on-call has been paged per escalation rule).",
    ),
    messages: [],
    toolTrace: [],
    completedSession: {
      finalContents: [evidence],
      browserRecoverySummaries: [],
    },
    completedSessionToolResultText: evidence,
  });

  assert.doesNotMatch(result.text, /has been paged/i);
  assert.match(result.text, /dashboard policy says to page the on-call/i);
  assert.match(result.text, /this run did not page anyone/i);
});

test("CompletedCloseoutController appends timeout closeout before final URL redaction", () => {
  const controller = createCompletedCloseoutController();

  const result = controller.finalizeCompletedVisibility({
    packet: packet(
      "Continue the same source check and say whether the earlier timeout still limits the conclusion.",
      "Do not include URLs.",
    ),
    result: textResult("Verified http://127.0.0.1:4173/status is healthy."),
    messages: [],
    toolTrace: sessionTrace({
      status: "timeout",
      result: "The previous source check timed out.",
    }),
    completedSession: {
      finalContents: [
        "Recovered after the earlier timeout with source-backed evidence.",
      ],
      browserRecoverySummaries: [],
    },
    completedSessionToolResultText: "",
  });

  assert.match(result.text, /Timeout closeout:/i);
  assert.doesNotMatch(result.text, /127\.0\.0\.1|localhost/);
  assert.match(result.text, /local fixture source/);
});
