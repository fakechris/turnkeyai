import type { PermissionSuppressionFacts } from "../runtime-facts/permission-policy-facts";
import { buildPolicyIdRenderRequest } from "./prompt-renderers";
import type { RuntimePermissionDecision } from "./types";

export interface SelectPermissionSuppressionInput {
  facts: PermissionSuppressionFacts;
}

export function selectPermissionSuppressionPolicy(
  input: SelectPermissionSuppressionInput,
): RuntimePermissionDecision {
  if (!input.facts.readOnlyPermissionQuery) {
    return {
      kind: "none",
      policyId: "none",
      reasonCode: "permission_query_allowed",
      render: null,
    };
  }
  return {
    kind: "suppress",
    policyId: "read_only_permission_query",
    reasonCode: "read_only_permission_query",
    forceToolChoice: "none",
    consumesRound: true,
    render: buildPolicyIdRenderRequest(
      "permission_repair_prompt",
      "read_only_permission_query",
    ),
  };
}
