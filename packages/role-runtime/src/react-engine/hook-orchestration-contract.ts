// Stage 8 engine cleanup — the Hook Orchestration Contract as pinned data.
//
// The per-module registries (normalization order, closeout order, repair order)
// are not enough on their own: the ADAPTER's cross-module call order inside each
// agent-core hook is also behavior. This module is the single source of truth for
// that documented order, copied verbatim from the plan's "Hook Orchestration
// Contract" table
// (docs/superpowers/plans/2026-07-01-stage8-engine-architecture-cleanup.md).
//
// Batch 0.5 uses this as the characterization/wiring baseline BEFORE the later
// batches extract the real modules. The wiring guard test drives spy modules in
// this order and fails if the recorded order diverges — so a future batch that
// wires modules in the wrong order is caught even when every registry array is
// individually correct.
//
// HARD INVARIANT: this module is pure data. It must not import
// ../llm-response-generator or anything that imports it.
import type { EnginePolicyPhase } from "./types";

/**
 * One agent-core hook and the ordered list of react-engine module operations the
 * adapter must invoke inside it. `moduleOps` are `Module.method` identifiers from
 * the Layer Permissions Table / Module Specs. Hooks that the engine path does not
 * currently install are still listed with their owner so the contract is complete
 * (the plan requires "every hook has an owner even if not installed").
 */
export interface EngineHookContract {
  /** The agent-core hook name (matches ReActHooks keys, or a virtual boundary). */
  hook: string;
  /** The EnginePolicyPhase this hook records trace entries under. */
  phase: EnginePolicyPhase;
  /** Whether the engine path installs this hook today. */
  installed: boolean;
  /**
   * The ordered `Module.method` operations the adapter must call inside this hook.
   * Empty for hooks that are adapter-only or not installed.
   */
  moduleOps: readonly string[];
}

/**
 * The full, ordered Hook Orchestration Contract. Order within the array is the
 * agent-core loop's hook-firing order per round; order within each `moduleOps`
 * is the adapter's required cross-module call order inside that hook.
 *
 * Do not reorder without a wiring test update proving no behavior drift.
 */
export const ENGINE_HOOK_ORCHESTRATION: readonly EngineHookContract[] = [
  {
    hook: "filterTools",
    phase: "before_model",
    installed: false,
    moduleOps: [],
  },
  {
    hook: "onRoundMessages",
    phase: "before_model",
    installed: false,
    moduleOps: [],
  },
  {
    hook: "onToolCalls",
    phase: "tool_calls",
    installed: true,
    moduleOps: [
      "ToolCallNormalizer.normalize",
      "ExecutionBudgetController.truncateRecoveryBudgetCalls",
    ],
  },
  {
    hook: "onSuppressToolCalls",
    phase: "tool_calls",
    installed: true,
    moduleOps: ["PermissionPolicy.applySuppressToolCallsHook"],
  },
  {
    hook: "onToolCallsClose",
    phase: "tool_calls",
    installed: true,
    moduleOps: ["CloseoutPolicyRegistry.applyPendingCallsCloseout"],
  },
  {
    hook: "onBeforeExecute",
    phase: "before_execute",
    installed: true,
    moduleOps: ["ExecutionBudgetController.applyMaxToolCallsPerRound"],
  },
  {
    hook: "runToolBatch",
    phase: "before_execute",
    installed: true,
    moduleOps: ["ExecutionBudgetController.runToolBatch"],
  },
  {
    hook: "onAfterExecuteContinue",
    phase: "after_execute_continue",
    installed: true,
    moduleOps: [
      "EngineRunObserver.onProviderToolProtocolRound",
      "ContinuationController.continueApprovedBrowserTimeout",
      "ContinuationController.continueSiblingTimeout",
      // Branch: no completed session -> general supplemental timeout probe.
      "ContinuationController.runGeneralSupplementalTimeoutProbe",
      // Branch: completed session -> the completed-session block, in order.
      "ContinuationController.runSupplementalCompletedProbe",
      "ContinuationController.continueIncompleteApprovedBrowser",
      "ContinuationController.continueIndependentEvidenceStreams",
      "RepairPolicyRegistry.repairPostExecuteMissingApprovalGate",
      "ContinuationController.runForcedPermissionResultRound",
    ],
  },
  {
    hook: "onAfterExecute",
    phase: "after_execute",
    installed: true,
    moduleOps: ["CloseoutPolicyRegistry.applyPostExecuteCloseout"],
  },
  {
    hook: "onRoundEmpty",
    phase: "round_empty",
    installed: true,
    moduleOps: ["ContinuationController.injectEmptyRoundContinuation"],
  },
  {
    hook: "onRepairRound",
    phase: "repair_round",
    installed: true,
    moduleOps: ["RepairPolicyRegistry.evaluateNaturalFinish"],
  },
  {
    hook: "onTerminate",
    phase: "terminate",
    installed: true,
    moduleOps: [
      "EngineRunState.captureFinalMessages",
      "CloseoutPolicyRegistry.evaluateTerminate",
      "TerminalCloseoutController.handleTerminalCloseoutHook",
    ],
  },
  {
    hook: "onModelCallError",
    phase: "terminate",
    installed: true,
    moduleOps: [
      "EngineRunState.captureFinalMessages",
      "TerminalCloseoutController.completeModelCallErrorFlow",
    ],
  },
  {
    hook: "onFinalize",
    phase: "finalize",
    installed: true,
    moduleOps: ["EngineRunState.captureFinalMessagesIfAbsent"],
  },
  {
    hook: "terminationPredicates",
    phase: "terminate",
    installed: false,
    moduleOps: [],
  },
  {
    hook: "onProgress",
    phase: "finalize",
    installed: false,
    moduleOps: [],
  },
] as const;

/** The ordered list of installed-hook names — the trace phase sequence per round. */
export const ENGINE_INSTALLED_HOOK_ORDER: readonly string[] =
  ENGINE_HOOK_ORCHESTRATION.filter((entry) => entry.installed).map(
    (entry) => entry.hook,
  );

/** Look up one hook's contract by name. */
export function engineHookContract(hook: string): EngineHookContract | undefined {
  return ENGINE_HOOK_ORCHESTRATION.find((entry) => entry.hook === hook);
}
