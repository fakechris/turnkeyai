import assert from "node:assert/strict";
import test from "node:test";

import type {
  CompletedSynthesisRepairPolicyFacts,
  NaturalFinishRepairPolicyFacts,
} from "../runtime-facts/repair-policy-facts";
import {
  selectCompletedSynthesisRepairPolicy,
  selectNaturalFinishRepairPolicy,
} from "./repair-policy-core";

function naturalFacts(
  overrides: Partial<NaturalFinishRepairPolicyFacts> = {},
): NaturalFinishRepairPolicyFacts {
  return {
    finalRecoveryBudgetCloseoutRepair: false,
    missingBrowserEvidence: false,
    missingProductSignalBrowserEvidence: false,
    missingApprovalGate: false,
    pendingApprovalWaitTimeoutCheck: false,
    prematurePendingApproval: false,
    stalePendingApproval: false,
    staleDeniedApproval: false,
    approvalWaitTimeoutCloseout: false,
    approvalWaitTimeoutLocalCloseout: false,
    incompleteApprovedBrowserAction: false,
    missingRequestedTableColumns: false,
    extraneousProviderTableSchema: false,
    sourceEvidenceCarryForward: false,
    weakEvidenceSynthesis: false,
    sourceEvidenceText: "",
    ...overrides,
  };
}

function completedFacts(
  overrides: Partial<CompletedSynthesisRepairPolicyFacts> = {},
): CompletedSynthesisRepairPolicyFacts {
  return {
    timeoutFollowupFinalGuidance: false,
    missingRequestedNextAction: false,
    missingRequiredFinalDeliverables: false,
    missingBrowserEvidenceDimensions: false,
    falseEvidenceBlockedSynthesis: false,
    missingRequiredDeliverables: [],
    ...overrides,
  };
}

test("repair core selects the first active natural-finish policy in runtime order", () => {
  const decision = selectNaturalFinishRepairPolicy({
    facts: naturalFacts({
      missingApprovalGate: true,
      weakEvidenceSynthesis: true,
    }),
  });

  assert.equal(decision?.policyId, "missing_approval_gate");
  assert.equal(decision?.kind, "force_tool_round");
  assert.deepEqual(decision?.forceToolChoice, { name: "permission_query" });
});

test("repair core honors enabled natural-finish policy filtering", () => {
  const decision = selectNaturalFinishRepairPolicy({
    facts: naturalFacts({
      missingBrowserEvidence: true,
      weakEvidenceSynthesis: true,
    }),
    enabledPolicies: ["weak_evidence_synthesis"],
  });

  assert.equal(decision?.policyId, "weak_evidence_synthesis");
  assert.equal(decision?.evidenceFormula, "source_bounded_evidence");
});

test("repair core selects completed-synthesis policy without text views", () => {
  const decision = selectCompletedSynthesisRepairPolicy({
    facts: completedFacts({
      missingRequestedNextAction: true,
      falseEvidenceBlockedSynthesis: true,
    }),
  });

  assert.equal(decision?.policyId, "missing_requested_next_action");
  assert.equal(decision?.forceToolChoice, "none");
  assert.doesNotMatch(JSON.stringify(decision), /completedSessionEvidenceText/);
});
