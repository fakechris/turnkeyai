import assert from "node:assert/strict";
import test from "node:test";

import {
  createRepairPolicyRegistry,
  ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER,
} from "./repair-policy-registry";

test("ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER pins extracted repair precedence", () => {
  assert.deepEqual([...ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER], [
    "final_recovery_budget_closeout_repair",
    "missing_approval_gate",
    "pending_approval_wait_timeout_check",
  ]);
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
      repairMarkers: [{ role: "user", content: first.repairPrompt }],
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
      repairMarkers: [{ role: "user", content: first.repairPrompt }],
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
      repairMarkers: [{ role: "user", content: first.repairPrompt }],
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
