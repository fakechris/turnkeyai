// Stage 8 engine cleanup — shared contracts for the react-engine module layer.
//
// These are the Core Types from the Stage 8 plan
// (docs/superpowers/plans/2026-07-01-stage8-engine-architecture-cleanup.md).
// Discriminated-union decision shapes are required: policy modules must return a
// typed decision, never a bare boolean, so that authority and policy trace stay
// explicit.
//
// Import specifiers follow existing role-runtime conventions: ReAct types come
// from @turnkeyai/agent-core; the LLM message/tool types come from
// @turnkeyai/llm-adapter (agent-core does not re-export them).
import type { ToolResult } from "@turnkeyai/agent-core/tool";
import type { ReActState, ReActToolChoice } from "@turnkeyai/agent-core/react-loop";
import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

export type EnginePolicyPhase =
  | "before_model"
  | "tool_calls"
  | "before_execute"
  | "after_execute_continue"
  | "after_execute"
  | "round_empty"
  | "repair_round"
  | "terminate"
  | "finalize";

export interface EnginePolicyTraceEntry {
  phase: EnginePolicyPhase;
  policyId: string;
  outcome: "skipped" | "matched" | "applied";
  reason: string;
}

export interface EnginePolicyTrace {
  record(entry: EnginePolicyTraceEntry): void;
  snapshot(): EnginePolicyTraceEntry[];
}

export interface EngineRunSnapshot {
  messages: LLMMessage[];
  state: ReActState;
  roundIndex: number;
}

export type EngineContinueAction =
  | { kind: "none" }
  | { kind: "inject_calls"; calls: LLMToolCall[]; reason: string }
  | {
      kind: "forced_tool_round";
      calls: LLMToolCall[];
      assistantText: string;
      reason: string;
    }
  | {
      kind: "continue";
      messages: LLMMessage[];
      forceToolChoice?: ReActToolChoice;
      repairMarker?: LLMMessage;
      reason: string;
    }
  | { kind: "closeout"; reason: EngineCloseoutReason; reasonLines: string[] };

export type EngineCloseoutReason =
  | "recovery_tool_budget"
  | "operator_cancelled"
  | "pseudo_tool_call"
  | "wall_clock_budget"
  | "round_limit"
  | "repeated_tool_failure"
  | "repeated_session_inspection"
  | "excessive_session_continuation"
  | "sub_agent_timeout"
  | "completed_sub_agent_final"
  | "partial_sub_agent_final"
  | "tool_evidence_fallback"
  | "model_error";

export interface CloseoutDeferDecision {
  kind: "defer";
  policyId: EngineCloseoutReason;
  deferTo: "repair_round";
  reason: string;
}

export type RepairEvidenceFormula =
  | "candidate_final"
  | "source_bounded"
  | "completed_round"
  | "completed_round_then_source_bounded";

export type EngineRepairDecision =
  | { kind: "none" }
  | {
      kind: "resynthesize";
      policyId: string;
      marker: string;
      messages: LLMMessage[];
      forceToolChoice?: ReActToolChoice;
      consumesRound?: false;
      evidenceFormula: RepairEvidenceFormula;
    }
  | {
      kind: "rearm_tool";
      policyId: string;
      marker: string;
      messages: LLMMessage[];
      forceToolChoice: ReActToolChoice;
      consumesRound: true;
      evidenceFormula: RepairEvidenceFormula;
    }
  | {
      kind: "closeout";
      policyId: string;
      reason: EngineCloseoutReason;
      reasonLines: string[];
    };

export type EngineSuppressDecision =
  | { kind: "none" }
  | {
      kind: "suppress";
      policyId: string;
      messages: LLMMessage[];
      forceToolChoice?: ReActToolChoice;
      consumesRound: true;
      reason: string;
    };

// ---------------------------------------------------------------------------
// Closeout decision shapes referenced by EngineRunState and the closeout
// registry. Kept intentionally minimal for the Batch 0 shell; later batches
// widen these as the closeout/repair registries are extracted.
// ---------------------------------------------------------------------------

export interface CloseoutDecision<TCloseout = unknown> {
  kind: "closeout";
  policyId: EngineCloseoutReason;
  reason: EngineCloseoutReason;
  reasonLines: string[];
  closeout?: TCloseout;
}

// Re-export the underlying LLM/ReAct types so sibling react-engine modules can
// depend on this file as their single type entry point without reaching for the
// composition root. This keeps the "no import of ../llm-response-generator"
// invariant easy to satisfy.
export type { LLMMessage, LLMToolCall, ReActState, ReActToolChoice, ToolResult };
