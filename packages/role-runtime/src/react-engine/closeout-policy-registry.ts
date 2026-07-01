// Stage 8 engine cleanup — CloseoutPolicyRegistry (module shell).
//
// Authority: own terminal closeout decisions and their precedence. The
// precedence is declared by ENGINE_CLOSEOUT_POLICY_ORDER (defined here in
// Batch 3). recovery_tool_budget stays first in the order. It does NOT own model
// synthesis, repair prompt construction, or tool execution. Policy functions
// return a decision object, they do not write into run state directly.
//
// The exported order array below is the source of truth for closeout
// precedence; it is defined in Batch 0 so the contract is pinnable, and the
// evaluating registry methods are added in Batch 3.
export const ENGINE_CLOSEOUT_POLICY_ORDER = [
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
] as const;

export type EngineCloseoutPolicyId = (typeof ENGINE_CLOSEOUT_POLICY_ORDER)[number];
