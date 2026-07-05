import type {
  IndependentEvidenceStreamsPolicyFacts,
  MissingApprovalGateContinuationFacts,
  TimeoutContinuationPolicyFacts,
} from "../runtime-facts/continuation-policy-facts";
import { buildPolicyIdRenderRequest } from "./prompt-renderers";
import type { RuntimeContinuationDecision } from "./types";

export type RuntimeContinuationPolicyId =
  | "approved_browser_timeout_continuation"
  | "coverage_timeout_continuation"
  | "independent_evidence_stream_continuation"
  | "missing_approval_gate_repair_continuation";

export function selectTimeoutContinuationPolicy(input: {
  facts: TimeoutContinuationPolicyFacts;
}): RuntimeContinuationDecision {
  if (input.facts.timedOutApprovedBrowserSession) {
    return buildContinueDecision("approved_browser_timeout_continuation");
  }
  if (input.facts.timedOutSiblingSession) {
    return buildContinueDecision("coverage_timeout_continuation");
  }
  return noneDecision("timeout_continuation_not_required");
}

export function selectIndependentEvidenceStreamsPolicy(input: {
  facts: IndependentEvidenceStreamsPolicyFacts;
}): RuntimeContinuationDecision {
  return input.facts.independentEvidenceStreams
    ? buildContinueDecision("independent_evidence_stream_continuation")
    : noneDecision("independent_evidence_streams_not_required");
}

export function selectMissingApprovalGateContinuationPolicy(input: {
  facts: MissingApprovalGateContinuationFacts;
}): RuntimeContinuationDecision {
  return input.facts.missingApprovalGate
    ? buildContinueDecision("missing_approval_gate_repair_continuation")
    : noneDecision("missing_approval_gate_not_required");
}

function buildContinueDecision(
  policyId: RuntimeContinuationPolicyId,
): RuntimeContinuationDecision {
  return {
    kind: "continue",
    policyId,
    reasonCode: policyId,
    render: buildPolicyIdRenderRequest(
        policyId === "independent_evidence_stream_continuation"
          ? "independent_evidence_prompt"
          : "timeout_recovery_prompt",
      policyId,
    ),
  };
}

function noneDecision(reasonCode: string): RuntimeContinuationDecision {
  return {
    kind: "none",
    policyId: "none",
    reasonCode,
    render: null,
  };
}
