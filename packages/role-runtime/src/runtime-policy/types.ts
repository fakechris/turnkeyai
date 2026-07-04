export type RuntimePolicyRenderKind =
  | "none"
  | "browser_repair_prompt"
  | "permission_repair_prompt"
  | "timeout_recovery_prompt"
  | "independent_evidence_prompt"
  | "terminal_closeout_prompt"
  | "repair_prompt";

export interface RuntimePolicyRenderRequest<
  TKind extends RuntimePolicyRenderKind = RuntimePolicyRenderKind,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  kind: TKind;
  payload: TPayload;
}

export interface RuntimePolicyDecisionBase {
  policyId: string;
  reasonCode: string;
  render: RuntimePolicyRenderRequest | null;
}

export type RuntimeForceToolChoice =
  | "none"
  | {
      name: string;
    };

export interface RuntimeRepairDecision extends RuntimePolicyDecisionBase {
  kind: "resynthesize" | "force_tool_round" | "closeout";
  policyId: string;
  evidenceFormula: string;
  forceToolChoice?: RuntimeForceToolChoice;
  closeoutReason?: string;
  consumesRound?: true;
}

export interface RuntimeContinuationDecision extends RuntimePolicyDecisionBase {
  kind: "continue" | "forced_tool_round" | "inject_calls" | "none";
}

export interface RuntimeCloseoutDecision extends RuntimePolicyDecisionBase {
  kind: "closeout" | "defer" | "none";
  reason?: string;
}

export interface RuntimePermissionDecision extends RuntimePolicyDecisionBase {
  kind: "suppress" | "none";
  consumesRound?: true;
  forceToolChoice?: RuntimeForceToolChoice;
}
