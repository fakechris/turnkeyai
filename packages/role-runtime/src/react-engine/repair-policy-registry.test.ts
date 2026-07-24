import assert from "node:assert/strict";
import test from "node:test";

import {
  createRepairPolicyCharacterizationRegistry as createRepairPolicyRegistry,
  createRepairPolicyRegistry as createProductionRepairPolicyRegistry,
  ENGINE_COMPLETED_SYNTHESIS_REPAIR_POLICY_ORDER,
  ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER,
} from "./repair-policy-registry";
import type { NativeToolRoundTrace } from "../native-tool-messages";
import type {
  CompletedSynthesisRepairDecision,
  NaturalFinishRepairDecision,
} from "./repair-policy-registry";
import type { LLMMessage } from "./types";

const APPROVAL_WAIT_TIMEOUT_TASK_PROMPT =
  "If the approval decision does not arrive during this attempt, write a wait-timeout closeout.";

function makePermissionResultTrace(status: string): NativeToolRoundTrace[] {
  const content = JSON.stringify({ status });
  return [
    {
      round: 1,
      calls: [
        { id: "toolu-permission-result", name: "permission_result", input: {} },
      ],
      results: [
        {
          toolCallId: "toolu-permission-result",
          toolName: "permission_result",
          content,
          isError: false,
          contentBytes: content.length,
        },
      ],
    },
  ];
}

function readRepairPrompt(
  decision:
    | CompletedSynthesisRepairDecision
    | NaturalFinishRepairDecision
    | null,
): string {
  assert.ok(decision && "repairPrompt" in decision);
  return decision.repairPrompt;
}

test("ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER pins extracted repair precedence", () => {
  assert.deepEqual([...ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER], [
    "final_recovery_budget_closeout_repair",
    "missing_durable_memory_search",
    "missing_durable_memory_get",
    "missing_browser_evidence",
    "missing_product_signal_browser_evidence",
    "missing_approval_gate",
    "pending_approval_wait_timeout_check",
    "premature_pending_approval",
    "stale_pending_approval",
    "stale_denied_approval",
    "approval_wait_timeout_closeout",
    "approval_wait_timeout_local_closeout",
    "incomplete_approved_browser_action",
    "missing_requested_table_columns",
    "extraneous_provider_table_schema",
    "source_evidence_carry_forward",
    "weak_evidence_synthesis",
  ]);
});

test("ENGINE_COMPLETED_SYNTHESIS_REPAIR_POLICY_ORDER pins completed-closeout repair precedence", () => {
  assert.deepEqual([...ENGINE_COMPLETED_SYNTHESIS_REPAIR_POLICY_ORDER], [
    "timeout_followup_final_guidance",
    "missing_requested_next_action",
    "missing_required_final_deliverables",
    "missing_browser_evidence_dimensions",
    "false_evidence_blocked_synthesis",
  ]);
});

test("production RepairPolicyRegistry never manufactures work or rewrites a terminal answer", () => {
  const registry = createProductionRepairPolicyRegistry();
  const naturalInput = {
    finalRecoveryBudget: { maxToolCalls: 1, usedToolCalls: 1 },
    messages: [] as LLMMessage[],
    repairMarkers: [] as LLMMessage[],
    resultText: "No evidence was gathered.",
    taskPrompt: "Open a browser and request approval before submitting.",
  };

  assert.equal(registry.evaluateNaturalFinish(naturalInput), null);
  assert.equal(registry.applyNaturalFinishRepair(naturalInput), null);
  assert.equal(
    registry.evaluateCompletedSynthesis({
      completedEvidenceText: "",
      delegatedEvidenceText: "",
      completedSessionFinalContents: [],
      messages: [],
      repairMarkers: [],
      resultText: "No evidence was gathered.",
      taskPrompt: "Return every requested deliverable.",
    }),
    null,
  );
});

test("production RepairPolicyRegistry enforces an explicitly requested durable-memory evidence protocol", () => {
  const registry = createProductionRepairPolicyRegistry();
  const taskPrompt = [
    "Use durable memory lookup for Aurora-19.",
    "Inspect any candidate memory entry before relying on it.",
  ].join("\n");
  const baseInput = {
    finalRecoveryBudget: null,
    messages: [] as LLMMessage[],
    repairMarkers: [] as LLMMessage[],
    resultText: "Aurora-19 details are already visible.",
    taskPrompt,
    tools: [{ name: "memory_search" }, { name: "memory_get" }],
  };

  const searchDecision = registry.evaluateNaturalFinish({
    ...baseInput,
    toolTrace: [],
  });
  assert.equal(searchDecision?.policyId, "missing_durable_memory_search");
  assert.deepEqual(searchDecision?.forceToolChoice, {
    name: "memory_search",
  });
  assert.equal(searchDecision?.consumesRound, true);

  const searchContent = JSON.stringify({
    memories: [{ memory_id: "memory-aurora-19" }],
  });
  const getDecision = registry.evaluateNaturalFinish({
    ...baseInput,
    toolTrace: [
      {
        round: 1,
        calls: [
          {
            id: "search-1",
            name: "memory_search",
            input: { query: "Aurora-19" },
          },
        ],
        results: [
          {
            toolCallId: "search-1",
            toolName: "memory_search",
            isError: false,
            contentBytes: searchContent.length,
            content: searchContent,
          },
        ],
      },
    ],
  });
  assert.equal(getDecision?.policyId, "missing_durable_memory_get");
  assert.deepEqual(getDecision?.forceToolChoice, { name: "memory_get" });
  assert.equal(getDecision?.consumesRound, true);
});

test("production durable-memory protocol does not force memory_get when search returned no candidate", () => {
  const registry = createProductionRepairPolicyRegistry();
  const searchContent = JSON.stringify({ memories: [] });

  assert.equal(
    registry.evaluateNaturalFinish({
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [],
      resultText: "No durable memory was found.",
      taskPrompt:
        "Use durable memory and inspect any candidate memory entry before relying on it.",
      tools: [{ name: "memory_search" }, { name: "memory_get" }],
      toolTrace: [
        {
          round: 1,
          calls: [
            {
              id: "search-empty",
              name: "memory_search",
              input: { query: "missing record" },
            },
          ],
          results: [
            {
              toolCallId: "search-empty",
              toolName: "memory_search",
              isError: false,
              contentBytes: searchContent.length,
              content: searchContent,
            },
          ],
        },
      ],
    }),
    null,
  );
});

test("RepairPolicyRegistry skips final-recovery repair before budget is exhausted", () => {
  const registry = createRepairPolicyRegistry();

  assert.equal(
    registry.evaluateNaturalFinish({
      finalRecoveryBudget: { maxToolCalls: 3, usedToolCalls: 2 },
      messages: [],
      repairMarkers: [],
      resultText: "@{role-explore} continue",
    }),
    null,
  );
});

test("RepairPolicyRegistry returns final-recovery budget repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    finalRecoveryBudget: { maxToolCalls: 2, usedToolCalls: 2 },
    messages: [],
    repairMarkers: [],
    resultText: "@{role-explore} continue",
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "final_recovery_budget_closeout_repair");
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.equal(decision?.forceToolChoice, "none");
  assert.equal(decision?.consumesRound, undefined);
  assert.match(
    decision?.repairPrompt ?? "",
    /final recovery tool budget is exhausted/i,
  );
  assert.match(decision?.repairPrompt ?? "", /2 tool calls/);
});

test("RepairPolicyRegistry does not repeat final-recovery repair after marker", () => {
  const registry = createRepairPolicyRegistry();

  const first = registry.evaluateNaturalFinish({
    finalRecoveryBudget: { maxToolCalls: 2, usedToolCalls: 2 },
    messages: [],
    repairMarkers: [],
    resultText: "@{role-explore} continue",
  });
  assert.ok(first);

  assert.equal(
    registry.evaluateNaturalFinish({
      finalRecoveryBudget: { maxToolCalls: 2, usedToolCalls: 2 },
      messages: [],
      repairMarkers: [{ role: "user", content: readRepairPrompt(first) }],
      resultText: "@{role-explore} continue",
    }),
    null,
  );
});

test("RepairPolicyRegistry skips final-recovery repair for already bounded closeout", () => {
  const registry = createRepairPolicyRegistry();

  assert.equal(
    registry.evaluateNaturalFinish({
      finalRecoveryBudget: { maxToolCalls: 2, usedToolCalls: 2 },
      messages: [],
      repairMarkers: [],
      resultText: "Blocked: remaining provider pricing is 未验证.",
    }),
    null,
  );
});

test("RepairPolicyRegistry keeps disabled natural-finish policies from firing", () => {
  const registry = createRepairPolicyRegistry();

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["final_recovery_budget_closeout_repair"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [],
      resultText: "The approved browser form submission is complete.",
      taskPrompt:
        "Approval required for browser.form.submit dry-run. Use the browser to submit the form only after native approval.",
      toolTrace: [],
      tools: [{ name: "permission_query" }],
    }),
    null,
  );
});

test("RepairPolicyRegistry applies natural-finish repair decisions to repair hook results", () => {
  const registry = createRepairPolicyRegistry();
  const messages: LLMMessage[] = [{ role: "user", content: "Do the task." }];
  const repairMarkers: LLMMessage[] = [];

  const resynthesis = registry.applyNaturalFinishRepairDecision(
    {
      kind: "resynthesize",
      policyId: "missing_requested_table_columns",
      evidenceFormula: "candidate_final",
      repairPrompt: "Runtime correction: include requested columns.",
      forceToolChoice: "none",
    },
    {
      messages,
      resultText: "Draft answer",
      repairMarkers,
    },
  );

  assert.deepEqual(resynthesis, {
    messages: [
      { role: "user", content: "Do the task." },
      { role: "assistant", content: "Draft answer" },
      {
        role: "user",
        content: "Runtime correction: include requested columns.",
      },
    ],
    forceToolChoice: "none",
  });
  assert.deepEqual(repairMarkers, [
    { role: "user", content: "Runtime correction: include requested columns." },
  ]);

  const toolRound = registry.applyNaturalFinishRepairDecision(
    {
      kind: "force_tool_round",
      policyId: "missing_browser_evidence",
      evidenceFormula: "candidate_final",
      repairPrompt: "Runtime correction: gather browser evidence.",
      forceToolChoice: { name: "sessions_spawn" },
      consumesRound: true,
    },
    {
      messages,
      resultText: "Browser evidence is unavailable.",
      repairMarkers,
    },
  );

  assert.deepEqual(toolRound, {
    messages: [
      { role: "user", content: "Do the task." },
      { role: "assistant", content: "Browser evidence is unavailable." },
      {
        role: "user",
        content: "Runtime correction: gather browser evidence.",
      },
    ],
    forceToolChoice: { name: "sessions_spawn" },
    consumesRound: true,
  });

  const closeout = registry.applyNaturalFinishRepairDecision(
    {
      kind: "closeout",
      policyId: "approval_wait_timeout_local_closeout",
      evidenceFormula: "candidate_final",
      closeoutReason: "tool_evidence_fallback",
    },
    {
      messages,
      resultText: "Still waiting.",
      repairMarkers,
    },
  );

  assert.deepEqual(closeout, { closeout: "tool_evidence_fallback" });
  assert.equal(
    registry.applyNaturalFinishRepairDecision(null, {
      messages,
      resultText: "Complete.",
      repairMarkers,
    }),
    null,
  );
});

test("RepairPolicyRegistry applies the first natural-finish repair from the cascade", () => {
  const registry = createRepairPolicyRegistry();
  const messages: LLMMessage[] = [{ role: "user", content: "Do the task." }];
  const repairMarkers: LLMMessage[] = [];

  const repair = registry.applyNaturalFinishRepair({
    finalRecoveryBudget: { maxToolCalls: 2, usedToolCalls: 2 },
    messages,
    repairMarkers,
    resultText: "@{role-explore} continue",
  });

  assert.ok(repair && "messages" in repair);
  assert.equal(repair.forceToolChoice, "none");
  assert.deepEqual(repair.messages.slice(0, 2), [
    { role: "user", content: "Do the task." },
    { role: "assistant", content: "@{role-explore} continue" },
  ]);
  const promptContent = repair.messages.at(-1)?.content;
  if (typeof promptContent !== "string") {
    assert.fail("expected repair prompt content to be a string");
  }
  assert.match(promptContent, /final recovery tool budget is exhausted/i);
  assert.deepEqual(repairMarkers, [repair.messages.at(-1)]);
});

test("RepairPolicyRegistry owns natural-finish repair hook gating and budget accounting", () => {
  const registry = createRepairPolicyRegistry();
  const messages: LLMMessage[] = [{ role: "user", content: "Do the task." }];
  const inactiveContext: { repairMarkers?: LLMMessage[] } = {};

  assert.equal(
    registry.applyNaturalFinishRepairHook({
      active: false,
      hookContext: inactiveContext,
      recoveryToolBudget: { maxToolCalls: 2 },
      recoveryToolCallsBeforeActivation: 1,
      messages,
      resultText: "@{role-explore} continue",
      toolTrace: [
        {
          round: 1,
          calls: [{ id: "call-1", name: "sessions_spawn", input: {} }],
          results: [
            {
              toolCallId: "call-1",
              toolName: "sessions_spawn",
              isError: false,
              contentBytes: 12,
            },
          ],
        },
      ],
    }),
    null,
  );
  assert.deepEqual(inactiveContext, {});

  const hookContext: { repairMarkers?: LLMMessage[] } = {};
  const repair = registry.applyNaturalFinishRepairHook({
    active: true,
    hookContext,
    recoveryToolBudget: { maxToolCalls: 2 },
    recoveryToolCallsBeforeActivation: 1,
    messages,
    resultText: "@{role-explore} continue",
    toolTrace: [
      {
        round: 1,
        calls: [{ id: "call-1", name: "sessions_spawn", input: {} }],
        results: [
          {
            toolCallId: "call-1",
            toolName: "sessions_spawn",
            isError: false,
            contentBytes: 12,
          },
        ],
      },
    ],
  });

  assert.ok(repair && "messages" in repair);
  assert.equal(repair.forceToolChoice, "none");
  assert.ok(hookContext.repairMarkers);
  assert.deepEqual(hookContext.repairMarkers, [repair.messages.at(-1)]);
});

test("RepairPolicyRegistry returns missing browser evidence repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["missing_browser_evidence"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText:
      "I could not verify the rendered DOM because browser session tools are unavailable.",
    taskPrompt:
      "Inspect https://example.com in a browser-visible rendered page and report the visible DOM state.",
    toolTrace: [],
    tools: [{ name: "sessions_spawn" }],
  });

  assert.equal(decision?.kind, "force_tool_round");
  assert.equal(decision?.policyId, "missing_browser_evidence");
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.deepEqual(decision?.forceToolChoice, { name: "sessions_spawn" });
  assert.equal(decision?.consumesRound, true);
  assert.match(
    decision?.repairPrompt ?? "",
    /browser-visible evidence is missing/i,
  );
});

test("RepairPolicyRegistry returns missing product-signal browser evidence repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["missing_product_signal_browser_evidence"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText:
      "The server HTML shell is not confirmed with browser rendering, so dashboard metrics are not verified.",
    taskPrompt:
      "Review the product-signals live signal dashboard at https://example.com/signals using rendered browser evidence.",
    toolTrace: [],
    tools: [{ name: "sessions_spawn" }],
  });

  assert.equal(decision?.kind, "force_tool_round");
  assert.equal(
    decision?.policyId,
    "missing_product_signal_browser_evidence",
  );
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.deepEqual(decision?.forceToolChoice, { name: "sessions_spawn" });
  assert.equal(decision?.consumesRound, true);
  assert.match(
    decision?.repairPrompt ?? "",
    /live product signal dashboard evidence is still incomplete/i,
  );
});

test("RepairPolicyRegistry returns missing-approval-gate repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["missing_approval_gate"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "The approved browser form submission is complete.",
    taskPrompt:
      "Approval required for browser.form.submit dry-run. Use the browser to submit the form only after native approval.",
    toolTrace: [],
    tools: [{ name: "permission_query" }],
  });

  assert.equal(decision?.kind, "force_tool_round");
  assert.equal(decision?.policyId, "missing_approval_gate");
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.deepEqual(decision?.forceToolChoice, { name: "permission_query" });
  assert.equal(decision?.consumesRound, true);
  assert.match(
    decision?.repairPrompt ?? "",
    /approval-gated browser action/i,
  );
});

test("RepairPolicyRegistry does not repeat missing-approval-gate repair after marker", () => {
  const registry = createRepairPolicyRegistry();

  const first = registry.evaluateNaturalFinish({
    enabledPolicies: ["missing_approval_gate"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "The approved browser form submission is complete.",
    taskPrompt:
      "Approval required for browser.form.submit dry-run. Use the browser to submit the form only after native approval.",
    toolTrace: [],
    tools: [{ name: "permission_query" }],
  });
  assert.ok(first);

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["missing_approval_gate"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [{ role: "user", content: readRepairPrompt(first) }],
      resultText: "The approved browser form submission is complete.",
      taskPrompt:
        "Approval required for browser.form.submit dry-run. Use the browser to submit the form only after native approval.",
      toolTrace: [],
      tools: [{ name: "permission_query" }],
    }),
    null,
  );
});

test("RepairPolicyRegistry returns pending-approval wait-timeout check repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["pending_approval_wait_timeout_check"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "Approval is still pending.",
    taskPrompt:
      "If the approval decision does not arrive during this attempt, write a wait-timeout closeout.",
    toolTrace: [
      {
        round: 1,
        calls: [
          { id: "toolu-permission-query", name: "permission_query", input: {} },
        ],
        results: [],
      },
    ],
  });

  assert.equal(decision?.kind, "force_tool_round");
  assert.equal(decision?.policyId, "pending_approval_wait_timeout_check");
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.deepEqual(decision?.forceToolChoice, { name: "permission_result" });
  assert.equal(decision?.consumesRound, true);
  assert.match(
    decision?.repairPrompt ?? "",
    /approval decision has not arrived/i,
  );
});

test("RepairPolicyRegistry consumes typed pending permission facts", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["pending_approval_wait_timeout_check"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "Approval is still pending.",
    taskPrompt:
      "If the approval decision does not arrive during this attempt, write a wait-timeout closeout.",
    toolTrace: [],
    permissionFacts: {
      latestStatus: "pending",
      latestToolName: "permission_query",
      latestResultStatus: null,
      pendingApproval: true,
      appliedApproval: false,
      deniedApproval: false,
      waitTimeout: false,
      runtimeEvidenceText: "permission_query requested approval",
    },
  });

  assert.equal(decision?.kind, "force_tool_round");
  assert.equal(decision?.policyId, "pending_approval_wait_timeout_check");
  assert.deepEqual(decision?.forceToolChoice, { name: "permission_result" });
});

test("RepairPolicyRegistry does not repeat pending-approval wait-timeout check repair after marker", () => {
  const registry = createRepairPolicyRegistry();

  const first = registry.evaluateNaturalFinish({
    enabledPolicies: ["pending_approval_wait_timeout_check"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "Approval is still pending.",
    taskPrompt:
      "If the approval decision does not arrive during this attempt, write a wait-timeout closeout.",
    toolTrace: [
      {
        round: 1,
        calls: [
          { id: "toolu-permission-query", name: "permission_query", input: {} },
        ],
        results: [],
      },
    ],
  });
  assert.ok(first);

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["pending_approval_wait_timeout_check"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [{ role: "user", content: readRepairPrompt(first) }],
      resultText: "Approval is still pending.",
      taskPrompt:
        "If the approval decision does not arrive during this attempt, write a wait-timeout closeout.",
      toolTrace: [
        {
          round: 1,
          calls: [
            {
              id: "toolu-permission-query",
              name: "permission_query",
              input: {},
            },
          ],
          results: [],
        },
      ],
    }),
    null,
  );
});

test("RepairPolicyRegistry returns premature pending-approval repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["premature_pending_approval"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "Approval is still pending, so the browser worker cannot submit.",
    taskPrompt:
      "Approval required for browser.form.submit dry-run. Use the browser to submit the form only after native approval.",
    toolTrace: [
      {
        round: 1,
        calls: [
          { id: "toolu-permission-query", name: "permission_query", input: {} },
        ],
        results: [],
      },
    ],
  });

  assert.equal(decision?.kind, "force_tool_round");
  assert.equal(decision?.policyId, "premature_pending_approval");
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.deepEqual(decision?.forceToolChoice, { name: "permission_result" });
  assert.equal(decision?.consumesRound, true);
  assert.match(
    decision?.repairPrompt ?? "",
    /approval-gated browser action is still pending/i,
  );
});

test("RepairPolicyRegistry does not repeat premature pending-approval repair after marker", () => {
  const registry = createRepairPolicyRegistry();

  const first = registry.evaluateNaturalFinish({
    enabledPolicies: ["premature_pending_approval"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "Approval is still pending, so the browser worker cannot submit.",
    taskPrompt:
      "Approval required for browser.form.submit dry-run. Use the browser to submit the form only after native approval.",
    toolTrace: [
      {
        round: 1,
        calls: [
          { id: "toolu-permission-query", name: "permission_query", input: {} },
        ],
        results: [],
      },
    ],
  });
  assert.ok(first);

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["premature_pending_approval"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [{ role: "user", content: readRepairPrompt(first) }],
      resultText: "Approval is still pending, so the browser worker cannot submit.",
      taskPrompt:
        "Approval required for browser.form.submit dry-run. Use the browser to submit the form only after native approval.",
      toolTrace: [
        {
          round: 1,
          calls: [
            {
              id: "toolu-permission-query",
              name: "permission_query",
              input: {},
            },
          ],
          results: [],
        },
      ],
    }),
    null,
  );
});

test("RepairPolicyRegistry skips premature pending-approval repair when task allows stopping", () => {
  const registry = createRepairPolicyRegistry();

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["premature_pending_approval"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [],
      resultText: "Approval is still pending, so I am stopping here.",
      taskPrompt:
        "Approval required for browser.form.submit dry-run. Wait for the operator decision and do not submit until approved.",
      toolTrace: [
        {
          round: 1,
          calls: [
            {
              id: "toolu-permission-query",
              name: "permission_query",
              input: {},
            },
          ],
          results: [],
        },
      ],
    }),
    null,
  );
});

test("RepairPolicyRegistry returns stale pending-approval repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["stale_pending_approval"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "Approval is still pending, so the browser worker cannot submit.",
    taskPrompt:
      "Runtime permission cache already applied. Continue from the approved scoped action browser.form.submit dry-run by calling sessions_spawn with agent_id=browser.",
    toolTrace: [],
  });

  assert.equal(decision?.kind, "force_tool_round");
  assert.equal(decision?.policyId, "stale_pending_approval");
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.deepEqual(decision?.forceToolChoice, { name: "sessions_spawn" });
  assert.equal(decision?.consumesRound, true);
  assert.match(decision?.repairPrompt ?? "", /approval already applied/i);
});

test("RepairPolicyRegistry does not repeat stale pending-approval repair after marker", () => {
  const registry = createRepairPolicyRegistry();

  const first = registry.evaluateNaturalFinish({
    enabledPolicies: ["stale_pending_approval"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "Approval is still pending, so the browser worker cannot submit.",
    taskPrompt:
      "Runtime permission cache already applied. Continue from the approved scoped action browser.form.submit dry-run by calling sessions_spawn with agent_id=browser.",
    toolTrace: [],
  });
  assert.ok(first);

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["stale_pending_approval"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [{ role: "user", content: readRepairPrompt(first) }],
      resultText: "Approval is still pending, so the browser worker cannot submit.",
      taskPrompt:
        "Runtime permission cache already applied. Continue from the approved scoped action browser.form.submit dry-run by calling sessions_spawn with agent_id=browser.",
      toolTrace: [],
    }),
    null,
  );
});

test("RepairPolicyRegistry skips stale pending-approval repair without applied evidence", () => {
  const registry = createRepairPolicyRegistry();

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["stale_pending_approval"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [],
      resultText: "Approval is still pending.",
      taskPrompt:
        "Approval required for browser.form.submit dry-run. Use the browser after native approval.",
      toolTrace: [],
    }),
    null,
  );
});

test("RepairPolicyRegistry returns stale denied-approval repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["stale_denied_approval"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "Approval is still pending, so the browser worker cannot submit.",
    taskPrompt:
      "Approval required for browser.form.submit dry-run. Use the browser to submit the form only after native approval.",
    toolTrace: [
      {
        round: 1,
        calls: [
          {
            id: "toolu-permission-result",
            name: "permission_result",
            input: {},
          },
        ],
        results: [
          {
            toolCallId: "toolu-permission-result",
            toolName: "permission_result",
            content: JSON.stringify({ status: "denied" }),
            isError: false,
            contentBytes: JSON.stringify({ status: "denied" }).length,
          },
        ],
      },
    ],
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "stale_denied_approval");
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.equal(decision?.forceToolChoice, "none");
  assert.equal(decision?.consumesRound, undefined);
  assert.match(decision?.repairPrompt ?? "", /approval was denied/i);
});

test("RepairPolicyRegistry does not repeat stale denied-approval repair after marker", () => {
  const registry = createRepairPolicyRegistry();

  const first = registry.evaluateNaturalFinish({
    enabledPolicies: ["stale_denied_approval"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "Approval is still pending, so the browser worker cannot submit.",
    taskPrompt:
      "Approval required for browser.form.submit dry-run. Use the browser to submit the form only after native approval.",
    toolTrace: [
      {
        round: 1,
        calls: [
          {
            id: "toolu-permission-result",
            name: "permission_result",
            input: {},
          },
        ],
        results: [
          {
            toolCallId: "toolu-permission-result",
            toolName: "permission_result",
            content: JSON.stringify({ status: "denied" }),
            isError: false,
            contentBytes: JSON.stringify({ status: "denied" }).length,
          },
        ],
      },
    ],
  });
  assert.ok(first);

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["stale_denied_approval"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [{ role: "user", content: readRepairPrompt(first) }],
      resultText: "Approval is still pending, so the browser worker cannot submit.",
      taskPrompt:
        "Approval required for browser.form.submit dry-run. Use the browser to submit the form only after native approval.",
      toolTrace: [
        {
          round: 1,
          calls: [
            {
              id: "toolu-permission-result",
              name: "permission_result",
              input: {},
            },
          ],
          results: [
            {
              toolCallId: "toolu-permission-result",
              toolName: "permission_result",
              content: JSON.stringify({ status: "denied" }),
              isError: false,
              contentBytes: JSON.stringify({ status: "denied" }).length,
            },
          ],
        },
      ],
    }),
    null,
  );
});

test("RepairPolicyRegistry skips stale denied-approval repair without denied result", () => {
  const registry = createRepairPolicyRegistry();

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["stale_denied_approval"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [],
      resultText: "Approval is still pending.",
      taskPrompt:
        "Approval required for browser.form.submit dry-run. Use the browser after native approval.",
      toolTrace: [],
    }),
    null,
  );
});

test("RepairPolicyRegistry returns approval wait-timeout closeout repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["approval_wait_timeout_closeout"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "The thread remains open while approval is pending.",
    taskPrompt: APPROVAL_WAIT_TIMEOUT_TASK_PROMPT,
    toolTrace: makePermissionResultTrace("pending"),
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "approval_wait_timeout_closeout");
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.equal(decision?.forceToolChoice, "none");
  assert.equal(decision?.consumesRound, undefined);
  assert.match(
    decision?.repairPrompt ?? "",
    /approval wait-timeout evidence is available/i,
  );
});

test("RepairPolicyRegistry returns approval wait-timeout local closeout after failed repair", () => {
  const registry = createRepairPolicyRegistry();

  const first = registry.evaluateNaturalFinish({
    enabledPolicies: ["approval_wait_timeout_closeout"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "The thread remains open while approval is pending.",
    taskPrompt: APPROVAL_WAIT_TIMEOUT_TASK_PROMPT,
    toolTrace: makePermissionResultTrace("pending"),
  });
  assert.ok(first && "repairPrompt" in first);

  const localCloseout = registry.evaluateNaturalFinish({
    enabledPolicies: ["approval_wait_timeout_local_closeout"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [{ role: "user", content: first.repairPrompt }],
    resultText: "The thread remains open while approval is pending.",
    taskPrompt: APPROVAL_WAIT_TIMEOUT_TASK_PROMPT,
    toolTrace: makePermissionResultTrace("pending"),
  });

  assert.equal(localCloseout?.kind, "closeout");
  assert.equal(
    localCloseout?.policyId,
    "approval_wait_timeout_local_closeout",
  );
  assert.equal(localCloseout?.evidenceFormula, "candidate_final");
  assert.equal(localCloseout?.closeoutReason, "tool_evidence_fallback");
});

test("RepairPolicyRegistry skips approval wait-timeout closeout repair when candidate is complete", () => {
  const registry = createRepairPolicyRegistry();

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["approval_wait_timeout_closeout"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [],
      resultText:
        "Approval is still pending. No browser form submission was performed. The unexecuted result is unverified. Next action: ask the operator to approve a new request.",
      taskPrompt: APPROVAL_WAIT_TIMEOUT_TASK_PROMPT,
      toolTrace: makePermissionResultTrace("pending"),
    }),
    null,
  );
});

test("RepairPolicyRegistry returns incomplete approved-browser-action repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["incomplete_approved_browser_action"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText:
      "The approved browser action was not completed because browser tools were unavailable.",
    taskPrompt:
      "Runtime permission cache already applied. Continue from the approved scoped action browser.form.submit dry-run by calling sessions_spawn with agent_id=browser.",
    toolTrace: [],
  });

  assert.equal(decision?.kind, "force_tool_round");
  assert.equal(decision?.policyId, "incomplete_approved_browser_action");
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.deepEqual(decision?.forceToolChoice, { name: "sessions_spawn" });
  assert.equal(decision?.consumesRound, true);
  assert.match(
    decision?.repairPrompt ?? "",
    /approved browser action has not executed/i,
  );
});

test("RepairPolicyRegistry does not repeat incomplete approved-browser-action repair after marker", () => {
  const registry = createRepairPolicyRegistry();

  const first = registry.evaluateNaturalFinish({
    enabledPolicies: ["incomplete_approved_browser_action"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText:
      "The approved browser action was not completed because browser tools were unavailable.",
    taskPrompt:
      "Runtime permission cache already applied. Continue from the approved scoped action browser.form.submit dry-run by calling sessions_spawn with agent_id=browser.",
    toolTrace: [],
  });
  assert.ok(first);

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["incomplete_approved_browser_action"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [{ role: "user", content: readRepairPrompt(first) }],
      resultText:
        "The approved browser action was not completed because browser tools were unavailable.",
      taskPrompt:
        "Runtime permission cache already applied. Continue from the approved scoped action browser.form.submit dry-run by calling sessions_spawn with agent_id=browser.",
      toolTrace: [],
    }),
    null,
  );
});

test("RepairPolicyRegistry skips incomplete approved-browser-action repair before approval is applied", () => {
  const registry = createRepairPolicyRegistry();

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["incomplete_approved_browser_action"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [],
      resultText:
        "The approved browser action was not completed because browser tools were unavailable.",
      taskPrompt:
        "Approval required for browser.form.submit dry-run. Use the browser after native approval.",
      toolTrace: [],
    }),
    null,
  );
});

test("RepairPolicyRegistry returns missing requested table columns repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["missing_requested_table_columns"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: ["| provider |", "| --- |", "| A |"].join("\n"),
    taskPrompt: "table: provider, evidence URL",
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "missing_requested_table_columns");
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.equal(decision?.forceToolChoice, "none");
  assert.equal(decision?.consumesRound, undefined);
  assert.match(
    decision?.repairPrompt ?? "",
    /did not preserve the table columns explicitly requested/i,
  );
  assert.match(decision?.repairPrompt ?? "", /provider \| evidence URL/);
});

test("RepairPolicyRegistry does not repeat missing requested table columns repair after marker", () => {
  const registry = createRepairPolicyRegistry();

  const first = registry.evaluateNaturalFinish({
    enabledPolicies: ["missing_requested_table_columns"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: ["| provider |", "| --- |", "| A |"].join("\n"),
    taskPrompt: "table: provider, evidence URL",
  });
  assert.ok(first);

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["missing_requested_table_columns"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [{ role: "user", content: readRepairPrompt(first) }],
      resultText: ["| provider |", "| --- |", "| A |"].join("\n"),
      taskPrompt: "table: provider, evidence URL",
    }),
    null,
  );
});

test("RepairPolicyRegistry skips missing requested table columns repair when table preserves headers", () => {
  const registry = createRepairPolicyRegistry();

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["missing_requested_table_columns"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [],
      resultText: [
        "| provider | evidence URL |",
        "| --- | --- |",
        "| A | https://example.com |",
      ].join("\n"),
      taskPrompt: "table: provider, evidence URL",
    }),
    null,
  );
});

test("RepairPolicyRegistry returns extraneous provider table schema repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["extraneous_provider_table_schema"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: [
      "| provider | 是否明确支持 search/web_search | 输入价格 | 输出价格 |",
      "| --- | --- | --- | --- |",
      "| A | 未验证 | 未验证 | 未验证 |",
    ].join("\n"),
    taskPrompt:
      "Compare pricing, strengths, risks, tradeoff, and a clear recommendation for the product lead.",
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "extraneous_provider_table_schema");
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.equal(decision?.forceToolChoice, "none");
  assert.equal(decision?.consumesRound, undefined);
  assert.match(
    decision?.repairPrompt ?? "",
    /introduced provider\/search\/model-support columns/i,
  );
});

test("RepairPolicyRegistry skips extraneous provider table schema when requested", () => {
  const registry = createRepairPolicyRegistry();

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["extraneous_provider_table_schema"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [],
      resultText: [
        "| provider | 是否明确支持 search/web_search | 输入价格 | 输出价格 |",
        "| --- | --- | --- | --- |",
        "| A | 未验证 | 未验证 | 未验证 |",
      ].join("\n"),
      taskPrompt:
        "Compare provider options for DeepSeek R1 search/web_search support, input price, and output price.",
    }),
    null,
  );
});

test("RepairPolicyRegistry returns source evidence carry-forward repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const evidence =
    "Specialist agents produced a decision-ready brief with multi-agent decomposition.";
  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["source_evidence_carry_forward"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "The release brief is ready.",
    taskPrompt:
      "Agent Workbench product-ready brief for the next release using independent evidence streams.",
    toolTrace: [
      {
        round: 1,
        calls: [{ id: "toolu-source", name: "web_fetch", input: {} }],
        results: [
          {
            toolCallId: "toolu-source",
            toolName: "web_fetch",
            content: evidence,
            isError: false,
            contentBytes: evidence.length,
          },
        ],
      },
    ],
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "source_evidence_carry_forward");
  assert.equal(decision?.evidenceFormula, "source_bounded_evidence");
  assert.equal(decision?.forceToolChoice, "none");
  assert.match(
    decision?.repairPrompt ?? "",
    /dropped required source-backed workbench evidence/i,
  );
  assert.match(decision?.repairPrompt ?? "", /multi-agent decomposition/i);
});

test("RepairPolicyRegistry uses provided evidence text for source evidence carry-forward", () => {
  const registry = createRepairPolicyRegistry();

  const evidence =
    "Specialist agents produced a decision-ready brief with multi-agent decomposition.";
  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["source_evidence_carry_forward"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "The release brief is ready.",
    taskPrompt:
      "Agent Workbench product-ready brief for the next release using independent evidence streams.",
    evidenceText: evidence,
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "source_evidence_carry_forward");
  assert.match(decision?.repairPrompt ?? "", /multi-agent decomposition/i);
});

test("RepairPolicyRegistry skips source evidence carry-forward after marker", () => {
  const registry = createRepairPolicyRegistry();

  const evidence =
    "Specialist agents produced a decision-ready brief with multi-agent decomposition.";
  const first = registry.evaluateNaturalFinish({
    enabledPolicies: ["source_evidence_carry_forward"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "The release brief is ready.",
    taskPrompt:
      "Agent Workbench product-ready brief for the next release using independent evidence streams.",
    toolTrace: [
      {
        round: 1,
        calls: [{ id: "toolu-source", name: "web_fetch", input: {} }],
        results: [
          {
            toolCallId: "toolu-source",
            toolName: "web_fetch",
            content: evidence,
            isError: false,
            contentBytes: evidence.length,
          },
        ],
      },
    ],
  });
  assert.ok(first);

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["source_evidence_carry_forward"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [{ role: "user", content: readRepairPrompt(first) }],
      resultText: "The release brief is ready.",
      taskPrompt:
        "Agent Workbench product-ready brief for the next release using independent evidence streams.",
      toolTrace: [
        {
          round: 1,
          calls: [{ id: "toolu-source", name: "web_fetch", input: {} }],
          results: [
            {
              toolCallId: "toolu-source",
              toolName: "web_fetch",
              content: evidence,
              isError: false,
              contentBytes: evidence.length,
            },
          ],
        },
      ],
    }),
    null,
  );
});

test("RepairPolicyRegistry returns weak evidence synthesis repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    enabledPolicies: ["weak_evidence_synthesis"],
    finalRecoveryBudget: null,
    messages: [],
    repairMarkers: [],
    resultText: "The source probably verifies the owner.",
    taskPrompt: "Summarize the verified source facts.",
    toolTrace: [],
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "weak_evidence_synthesis");
  assert.equal(decision?.evidenceFormula, "source_bounded_evidence");
  assert.equal(decision?.forceToolChoice, "none");
  assert.match(
    decision?.repairPrompt ?? "",
    /weakens verified evidence/i,
  );
});

test("RepairPolicyRegistry skips weak evidence synthesis for exact final shapes", () => {
  const registry = createRepairPolicyRegistry();

  assert.equal(
    registry.evaluateNaturalFinish({
      enabledPolicies: ["weak_evidence_synthesis"],
      finalRecoveryBudget: null,
      messages: [],
      repairMarkers: [],
      resultText: JSON.stringify({ status: "probably ready" }),
      taskPrompt: "Output only a valid JSON object.",
      toolTrace: [],
    }),
    null,
  );
});

test("RepairPolicyRegistry returns timeout follow-up final guidance repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateCompletedSynthesis({
    completedEvidenceText:
      "The slow source recovered after an earlier timeout and returned owner Release Captain.",
    delegatedEvidenceText:
      "The slow source recovered after an earlier timeout and returned owner Release Captain.",
    completedSessionFinalContents: [],
    enabledPolicies: ["timeout_followup_final_guidance"],
    messages: [],
    repairMarkers: [],
    resultText: "Owner: Release Captain. Risk: delayed source response.",
    taskPrompt: [
      "Evaluate this slow source for a release-risk note.",
      "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available.",
      "A follow-up may ask you to resume that same source-check context after the earlier timeout; explain how the source-check can continue or retry.",
    ].join("\n"),
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "timeout_followup_final_guidance");
  assert.equal(decision?.evidenceFormula, "completed_product_brief_evidence");
  assert.equal(decision?.forceToolChoice, "none");
  assert.match(
    decision?.repairPrompt ?? "",
    /timeout follow-up final omitted recovery guidance/i,
  );
  assert.match(decision?.repairPrompt ?? "", /Release Captain/);
});

test("RepairPolicyRegistry does not repeat timeout follow-up final guidance repair after marker", () => {
  const registry = createRepairPolicyRegistry();
  const input = {
    completedEvidenceText:
      "The slow source recovered after an earlier timeout and returned owner Release Captain.",
    delegatedEvidenceText:
      "The slow source recovered after an earlier timeout and returned owner Release Captain.",
    completedSessionFinalContents: [],
    enabledPolicies: ["timeout_followup_final_guidance"] as const,
    messages: [],
    repairMarkers: [],
    resultText: "Owner: Release Captain. Risk: delayed source response.",
    taskPrompt: [
      "Evaluate this slow source for a release-risk note.",
      "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available.",
      "A follow-up may ask you to resume that same source-check context after the earlier timeout; explain how the source-check can continue or retry.",
    ].join("\n"),
  };

  const first = registry.evaluateCompletedSynthesis(input);
  assert.ok(first);

  assert.equal(
    registry.evaluateCompletedSynthesis({
      ...input,
      repairMarkers: [{ role: "user", content: readRepairPrompt(first) }],
    }),
    null,
  );
});

test("RepairPolicyRegistry returns missing requested next action completed repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateCompletedSynthesis({
    completedEvidenceText: "The delegated session verified the plan price.",
    delegatedEvidenceText:
      "The delegated session verified the plan price.",
    completedSessionFinalContents: [],
    enabledPolicies: ["missing_requested_next_action"],
    messages: [],
    repairMarkers: [],
    resultText: "The plan is verified at $10 per month.",
    taskPrompt:
      "Review the delegated session's pricing finding and tell me the next action the operator should take.",
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "missing_requested_next_action");
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.equal(decision?.forceToolChoice, "none");
  assert.match(
    decision?.repairPrompt ?? "",
    /requested next action is missing/i,
  );
});

test("RepairPolicyRegistry returns missing required final deliverables completed repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateCompletedSynthesis({
    completedEvidenceText: "Vendor A is cheaper; Vendor B has stronger risk controls.",
    delegatedEvidenceText:
      "Vendor A is cheaper; Vendor B has stronger risk controls.",
    completedSessionFinalContents: [],
    enabledPolicies: ["missing_required_final_deliverables"],
    messages: [],
    repairMarkers: [],
    resultText:
      "Vendor A is cheaper, while Vendor B has stronger risk controls.",
    taskPrompt:
      "Compare Vendor A and Vendor B, then include a final one-sentence conclusion.",
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "missing_required_final_deliverables");
  assert.equal(decision?.evidenceFormula, "completed_session_evidence");
  assert.equal(decision?.forceToolChoice, "none");
  assert.match(
    decision?.repairPrompt ?? "",
    /final answer omitted required deliverables/i,
  );
  assert.match(decision?.repairPrompt ?? "", /final one-sentence conclusion/i);
});

test("RepairPolicyRegistry returns missing browser evidence dimensions completed repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateCompletedSynthesis({
    completedEvidenceText:
      "Embedded source frame: Frame panel shows backlog count: 11 and owner: Release Lead. Shadow review component says approval required from risk desk. Details popup opened for record R-17 with manager acknowledgement.",
    delegatedEvidenceText:
      "Embedded source frame: Frame panel shows backlog count: 11 and owner: Release Lead. Shadow review component says approval required from risk desk. Details popup opened for record R-17 with manager acknowledgement.",
    completedSessionFinalContents: [
      "Embedded source frame: Frame panel shows backlog count: 11 and owner: Release Lead. Shadow review component says approval required from risk desk. Details popup opened for record R-17 with manager acknowledgement.",
    ],
    enabledPolicies: ["missing_browser_evidence_dimensions"],
    messages: [],
    repairMarkers: [],
    resultText:
      "The browser-visible page was checked, but the frame, shadow component, and popup details are not verified.",
    taskPrompt:
      "Inspect the page iframe, shadow review component, and popup state before writing the final answer.",
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "missing_browser_evidence_dimensions");
  assert.equal(decision?.evidenceFormula, "completed_session_evidence");
  assert.equal(decision?.forceToolChoice, "none");
  assert.match(
    decision?.repairPrompt ?? "",
    /final answer omitted requested browser evidence dimensions/i,
  );
  assert.match(decision?.repairPrompt ?? "", /embedded frame source state/i);
  assert.match(decision?.repairPrompt ?? "", /shadow review state/i);
  assert.match(decision?.repairPrompt ?? "", /details popup state/i);
});

test("RepairPolicyRegistry returns false evidence blocked completed repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateCompletedSynthesis({
    completedEvidenceText:
      "Completed source evidence: owner Release Captain and plan price $10 were observed.",
    delegatedEvidenceText:
      "Completed source evidence: owner Release Captain and plan price $10 were observed.",
    completedSessionFinalContents: [
      "Completed source evidence: owner Release Captain and plan price $10 were observed.",
    ],
    enabledPolicies: ["false_evidence_blocked_synthesis"],
    messages: [],
    repairMarkers: [],
    resultText:
      "The source content was unavailable, so extraction failed and the evidence is incomplete.",
    taskPrompt: "Summarize the completed delegated evidence.",
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "false_evidence_blocked_synthesis");
  assert.equal(decision?.evidenceFormula, "completed_session_evidence");
  assert.equal(decision?.forceToolChoice, "none");
  assert.match(
    decision?.repairPrompt ?? "",
    /falsely marks completed evidence/i,
  );
  assert.match(decision?.repairPrompt ?? "", /Release Captain/);
});
