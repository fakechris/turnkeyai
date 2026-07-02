import type { MissionTerminalReport } from "@turnkeyai/core-types/team";

export type ToolLoopCloseoutReason =
  | "pseudo_tool_call"
  | "wall_clock_budget"
  | "round_limit"
  | "completed_sub_agent_final"
  | "sub_agent_timeout"
  | "operator_cancelled"
  | "repeated_tool_failure"
  | "repeated_session_inspection"
  | "excessive_session_continuation"
  | "tool_evidence_fallback"
  | "recovery_tool_budget";

export interface ToolLoopCloseoutMetadata {
  reason: ToolLoopCloseoutReason;
  toolCallCount: number;
  roundCount: number;
  maxRounds?: number;
  maxWallClockMs?: number;
  pendingToolCallCount?: number;
  toolName?: string;
  timeoutSeconds?: number;
  evidenceAvailable?: boolean;
  finalContentCount?: number;
}

export function buildRuntimeDerivedMissionReport(
  closeout: ToolLoopCloseoutMetadata | undefined,
): MissionTerminalReport | undefined {
  if (!closeout) return undefined;
  const status = missionTerminalStatusForCloseout(closeout);
  // NOTE: do NOT set authorizedPartial here. authorizedPartial means "the
  // TASK explicitly permitted a partial/blocked outcome" — a property of the
  // mission request, not of how this run ended. A runtime-derived report
  // reflects objective exhaustion (budget/timeout/etc.), which says nothing
  // about task authorization. Asserting authorizedPartial here would, once a
  // future phase consumes the field to decide whether a self-reported partial
  // may settle without recovery, let any exhausted run claim authorization —
  // a fail-closed hole (an agent could escape completion by reporting partial).
  // authorizedPartial is set only by an explicit model report (Stage B) or by
  // the evaluator's task-text authorization check.
  return {
    status,
    reason: closeout.reason,
    source: "runtime_derived",
  };
}

function missionTerminalStatusForCloseout(
  closeout: ToolLoopCloseoutMetadata,
): MissionTerminalReport["status"] {
  switch (closeout.reason) {
    case "completed_sub_agent_final":
      return "completed";
    case "wall_clock_budget":
    case "round_limit":
    case "sub_agent_timeout":
    case "repeated_session_inspection":
    case "excessive_session_continuation":
    case "tool_evidence_fallback":
    case "pseudo_tool_call":
      return closeout.evidenceAvailable ? "partial" : "blocked";
    case "operator_cancelled":
    case "repeated_tool_failure":
    case "recovery_tool_budget":
      return "blocked";
  }
}
