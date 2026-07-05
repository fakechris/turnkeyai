// Stage 8 engine cleanup (Batch 0.5) — policy-trace characterization builder.
//
// This module deterministically derives the engine's current policy-trace
// CHARACTERIZATION: the per-hook phase spine, the coarse decision vocabulary the
// boundary wrapper can emit today, and the flat cross-module contract order the
// adapter must follow. It is the golden baseline the later batches must preserve —
// when Batches 1-4 re-emit the same decisions through extracted modules, this
// snapshot must not drift.
//
// It is built from the Hook Orchestration Contract + the behavior-neutral
// traceEngineHooks wrapper, NOT by running the 272 parity fixtures in-process
// (those live behind the parity harness). The 272 byte-identical behavior proof
// stays owned by the parity runner; this golden pins the DECISION SEQUENCE surface
// so a reordering or a dropped/renamed policy id is caught in a fast unit test.
//
// HARD INVARIANT: pure — no import of ../llm-response-generator.
import {
  ENGINE_HOOK_ORCHESTRATION,
  ENGINE_INSTALLED_HOOK_ORDER,
} from "./hook-orchestration-contract";
import { createEnginePolicyTrace } from "./policy-trace";
import { traceEngineHooks } from "./hook-policy-trace";
import type { EnginePolicyTraceEntry } from "./types";

const fakeState = { round: 0, messages: [], lastText: "" } as never;
const fakeCtx = { repairMarkers: [] } as never;

/**
 * The representative return values for each installed hook, chosen to enumerate
 * every distinct outcome discriminant the boundary wrapper can classify. Kept in
 * hook-firing order so the emitted trace is a deterministic decision sequence.
 * Each entry is one scenario the current engine can produce.
 */
interface HookScenario {
  hook: string;
  label: string;
  emit: (trace: ReturnType<typeof createEnginePolicyTrace>) => Promise<void> | void;
}

function buildScenarios(): HookScenario[] {
  return [
    {
      hook: "onToolCalls",
      label: "normalize pending calls",
      emit: (trace) => {
        const h = traceEngineHooks({ onToolCalls: (c) => c }, trace);
        h.onToolCalls!([{ id: "a", name: "t", input: {} }] as never, fakeState, fakeCtx);
      },
    },
    {
      hook: "onSuppressToolCalls",
      label: "no suppression",
      emit: (trace) => {
        const h = traceEngineHooks({ onSuppressToolCalls: () => null }, trace);
        h.onSuppressToolCalls!([], fakeState, fakeCtx);
      },
    },
    {
      hook: "onSuppressToolCalls",
      label: "suppression applied",
      emit: (trace) => {
        const h = traceEngineHooks(
          { onSuppressToolCalls: () => ({ messages: [] }) as never },
          trace,
        );
        h.onSuppressToolCalls!([], fakeState, fakeCtx);
      },
    },
    {
      hook: "onToolCallsClose",
      label: "no closeout",
      emit: (trace) => {
        const h = traceEngineHooks({ onToolCallsClose: () => null }, trace);
        h.onToolCallsClose!([], fakeState, fakeCtx);
      },
    },
    ...(
      [
        "recovery_tool_budget",
        "operator_cancelled",
        "pseudo_tool_call",
        "wall_clock_budget",
        "round_limit",
        "repeated_tool_failure",
        "repeated_session_inspection",
        "excessive_session_continuation",
      ] as const
    ).map((reason) => ({
      hook: "onToolCallsClose",
      label: `closeout ${reason}`,
      emit: (trace: ReturnType<typeof createEnginePolicyTrace>) => {
        const h = traceEngineHooks({ onToolCallsClose: () => reason }, trace);
        h.onToolCallsClose!([], fakeState, fakeCtx);
      },
    })),
    {
      hook: "onBeforeExecute",
      label: "within cap",
      emit: (trace) => {
        const h = traceEngineHooks(
          { onBeforeExecute: (c) => ({ executable: c, rejected: [] }) },
          trace,
        );
        h.onBeforeExecute!([], fakeCtx);
      },
    },
    {
      hook: "onBeforeExecute",
      label: "over cap",
      emit: (trace) => {
        const h = traceEngineHooks(
          {
            onBeforeExecute: () => ({
              executable: [],
              rejected: [{ toolCallId: "x", toolName: "t", isError: true, content: "" }] as never,
            }),
          },
          trace,
        );
        h.onBeforeExecute!([{ id: "1", name: "t", input: {} }] as never, fakeCtx);
      },
    },
    {
      hook: "runToolBatch",
      label: "execute batch",
      emit: async (trace) => {
        const h = traceEngineHooks({ runToolBatch: async () => [] }, trace);
        await h.runToolBatch!([], async () => ({}) as never, fakeCtx);
      },
    },
    {
      hook: "onAfterExecuteContinue",
      label: "no continuation",
      emit: async (trace) => {
        const h = traceEngineHooks({ onAfterExecuteContinue: async () => null }, trace);
        await h.onAfterExecuteContinue!([], fakeState, fakeCtx);
      },
    },
    {
      hook: "onAfterExecuteContinue",
      label: "continuation applied",
      emit: async (trace) => {
        const h = traceEngineHooks(
          { onAfterExecuteContinue: async () => ({ messages: [] }) },
          trace,
        );
        await h.onAfterExecuteContinue!([], fakeState, fakeCtx);
      },
    },
    {
      hook: "onAfterExecute",
      label: "no post-execute closeout",
      emit: (trace) => {
        const h = traceEngineHooks({ onAfterExecute: () => null }, trace);
        h.onAfterExecute!([], fakeState, fakeCtx);
      },
    },
    ...(["completed_sub_agent_final", "sub_agent_timeout"] as const).map((reason) => ({
      hook: "onAfterExecute",
      label: `post-execute ${reason}`,
      emit: (trace: ReturnType<typeof createEnginePolicyTrace>) => {
        const h = traceEngineHooks({ onAfterExecute: () => reason }, trace);
        h.onAfterExecute!([], fakeState, fakeCtx);
      },
    })),
    {
      hook: "onRoundEmpty",
      label: "terminate",
      emit: (trace) => {
        const h = traceEngineHooks({ onRoundEmpty: () => "terminate" as const }, trace);
        h.onRoundEmpty!(fakeState, fakeCtx);
      },
    },
    {
      hook: "onRoundEmpty",
      label: "inject calls",
      emit: (trace) => {
        const h = traceEngineHooks(
          { onRoundEmpty: () => ({ injectedCalls: [] }) as never },
          trace,
        );
        h.onRoundEmpty!(fakeState, fakeCtx);
      },
    },
    {
      hook: "onRepairRound",
      label: "no repair",
      emit: (trace) => {
        const h = traceEngineHooks({ onRepairRound: () => null }, trace);
        h.onRepairRound!(fakeState, fakeCtx);
      },
    },
    {
      hook: "onRepairRound",
      label: "resynthesize",
      emit: (trace) => {
        const h = traceEngineHooks(
          { onRepairRound: () => ({ messages: [] }) as never },
          trace,
        );
        h.onRepairRound!(fakeState, fakeCtx);
      },
    },
    {
      hook: "onRepairRound",
      label: "closeout tool_evidence_fallback",
      emit: (trace) => {
        const h = traceEngineHooks(
          { onRepairRound: () => ({ closeout: "tool_evidence_fallback" }) as never },
          trace,
        );
        h.onRepairRound!(fakeState, fakeCtx);
      },
    },
    {
      hook: "onTerminate",
      label: "terminate round_limit",
      emit: async (trace) => {
        const h = traceEngineHooks(
          { onTerminate: async () => ({ text: "" }) as never },
          trace,
        );
        await h.onTerminate!("round_limit", fakeState, fakeCtx);
      },
    },
    {
      hook: "onModelCallError",
      label: "rethrow",
      emit: async (trace) => {
        const h = traceEngineHooks(
          { onModelCallError: async () => "rethrow" as const },
          trace,
        );
        await h.onModelCallError!(new Error("x"), fakeState, fakeCtx);
      },
    },
    {
      hook: "onModelCallError",
      label: "forced continuation",
      emit: async (trace) => {
        const h = traceEngineHooks(
          { onModelCallError: async () => ({ messages: [] }) },
          trace,
        );
        await h.onModelCallError!(new Error("x"), fakeState, fakeCtx);
      },
    },
    {
      hook: "onModelCallError",
      label: "fallback synthesis",
      emit: async (trace) => {
        const h = traceEngineHooks(
          { onModelCallError: async () => ({ text: "" }) as never },
          trace,
        );
        await h.onModelCallError!(new Error("x"), fakeState, fakeCtx);
      },
    },
  ];
}

export interface PolicyTraceCharacterization {
  /** Schema version so a golden format change is an explicit, reviewable diff. */
  version: 1;
  /** Ordered installed-hook firing order (the trace phase spine). */
  installedHookOrder: readonly string[];
  /** Flat cross-module contract order across all installed hooks. */
  contractModuleOpOrder: readonly string[];
  /**
   * The coarse decision vocabulary the boundary wrapper emits today, one row per
   * (hook, scenario). This is the current decision sequence surface later batches
   * must reproduce.
   */
  decisionVocabulary: ReadonlyArray<{
    hook: string;
    scenario: string;
    entry: EnginePolicyTraceEntry;
  }>;
}

/** Build the deterministic characterization snapshot. */
export async function buildPolicyTraceCharacterization(): Promise<PolicyTraceCharacterization> {
  const contractModuleOpOrder: string[] = [];
  for (const entry of ENGINE_HOOK_ORCHESTRATION) {
    if (!entry.installed) continue;
    contractModuleOpOrder.push(...entry.moduleOps);
  }

  const decisionVocabulary: Array<{
    hook: string;
    scenario: string;
    entry: EnginePolicyTraceEntry;
  }> = [];
  for (const scenario of buildScenarios()) {
    const trace = createEnginePolicyTrace();
    await scenario.emit(trace);
    // Each scenario emits exactly one boundary entry.
    for (const entry of trace.snapshot()) {
      decisionVocabulary.push({
        hook: scenario.hook,
        scenario: scenario.label,
        entry,
      });
    }
  }

  return {
    version: 1,
    installedHookOrder: ENGINE_INSTALLED_HOOK_ORDER,
    contractModuleOpOrder,
    decisionVocabulary,
  };
}

/** Stable JSON for the golden file (2-space indent, trailing newline on write). */
export function renderCharacterizationJson(
  characterization: PolicyTraceCharacterization,
): string {
  return JSON.stringify(characterization, null, 2);
}
