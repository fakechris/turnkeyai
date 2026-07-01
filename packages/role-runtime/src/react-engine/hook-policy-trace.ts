// Stage 8 engine cleanup — behavior-neutral hook-boundary policy trace.
//
// Batch 0.5 characterization: capture the current per-hook decision sequence of
// runViaReActEngine WITHOUT touching any hook body. `traceEngineHooks` wraps a
// ReActHooks object so each installed hook, when invoked by agent-core, records
// one EnginePolicyTraceEntry describing the phase it fired in and the outcome it
// produced (derived from its return value), then returns the hook's real result
// UNCHANGED. This adds observation only: no decision, message, or tool-call is
// altered, so it cannot move parity.
//
// This is the coarse Batch 0.5 baseline. Later batches (1-4) extract the real
// controllers/registries, which will record their own fine-grained policyIds via
// the same EnginePolicyTrace; this boundary wrapper stays as the per-hook phase
// spine that pins hook-firing order.
//
// HARD INVARIANT: this module must not import ../llm-response-generator or
// anything that imports it. It depends only on agent-core hook types + the trace
// contract in types.ts.
import type { ToolContext } from "@turnkeyai/agent-core/tool";
import type { ReActHooks } from "@turnkeyai/agent-core/react-loop";
import { engineHookContract } from "./hook-orchestration-contract";
import type { EnginePolicyPhase, EnginePolicyTrace } from "./types";

/** The trace outcome for one hook invocation, derived from its return value. */
interface HookOutcome {
  policyId: string;
  outcome: "skipped" | "matched" | "applied";
  reason: string;
}

/** Resolve a hook's contract phase; fall back to a neutral phase if unknown. */
function phaseFor(hook: string): EnginePolicyPhase {
  return engineHookContract(hook)?.phase ?? "finalize";
}

function record(
  trace: EnginePolicyTrace,
  hook: string,
  outcome: HookOutcome,
): void {
  trace.record({
    phase: phaseFor(hook),
    policyId: outcome.policyId,
    outcome: outcome.outcome,
    reason: outcome.reason,
  });
}

// --- Per-hook return-value classifiers ---------------------------------------
// Each returns the coarse policy outcome for the hook's result. They inspect only
// the shape/discriminant of the value, never mutating it.

function classifyToolCalls(result: unknown): HookOutcome {
  // onToolCalls always runs the normalizer; "applied" reflects that the pipeline
  // executed for this round (the returned call list may equal the input).
  return {
    policyId: "onToolCalls:normalize",
    outcome: "applied",
    reason: Array.isArray(result)
      ? `normalized ${result.length} pending call(s)`
      : "normalized pending calls",
  };
}

function classifyNullableDirective(
  policyId: string,
  result: unknown,
): HookOutcome {
  return result == null
    ? { policyId, outcome: "skipped", reason: "no directive" }
    : { policyId, outcome: "applied", reason: "directive applied" };
}

function classifyCloseReason(policyId: string, result: unknown): HookOutcome {
  return typeof result === "string" && result.length > 0
    ? { policyId: `${policyId}:${result}`, outcome: "matched", reason: result }
    : { policyId, outcome: "skipped", reason: "no closeout" };
}

function classifyRoundEmpty(result: unknown): HookOutcome {
  if (result === "terminate" || result == null) {
    return {
      policyId: "onRoundEmpty:terminate",
      outcome: "skipped",
      reason: "terminate",
    };
  }
  return {
    policyId: "onRoundEmpty:injectCalls",
    outcome: "applied",
    reason: "injected continuation calls",
  };
}

function classifyRepairRound(result: unknown): HookOutcome {
  if (result == null) {
    return {
      policyId: "onRepairRound:none",
      outcome: "skipped",
      reason: "no repair",
    };
  }
  if (typeof result === "object" && result !== null && "closeout" in result) {
    const reason = String((result as { closeout: unknown }).closeout);
    return {
      policyId: `onRepairRound:closeout:${reason}`,
      outcome: "matched",
      reason,
    };
  }
  return {
    policyId: "onRepairRound:resynthesize",
    outcome: "applied",
    reason: "repair directive",
  };
}

function classifyModelError(result: unknown): HookOutcome {
  if (result === "rethrow") {
    return {
      policyId: "onModelCallError:rethrow",
      outcome: "matched",
      reason: "rethrow",
    };
  }
  if (typeof result === "object" && result !== null && "messages" in result) {
    return {
      policyId: "onModelCallError:continue",
      outcome: "applied",
      reason: "forced continuation",
    };
  }
  return {
    policyId: "onModelCallError:fallback",
    outcome: "matched",
    reason: "model-error fallback synthesis",
  };
}

function classifyTerminate(reason: unknown): HookOutcome {
  return {
    policyId:
      typeof reason === "string" && reason.length > 0
        ? `onTerminate:${reason}`
        : "onTerminate",
    outcome: "applied",
    reason: typeof reason === "string" ? reason : "terminate",
  };
}

/**
 * Wrap a ReActHooks object so each installed hook records one policy-trace entry
 * at its boundary. The returned hooks are behavior-identical to the input: every
 * wrapped hook calls the original and returns its exact result (awaiting async
 * hooks only to read the resolved value for the trace).
 */
export function traceEngineHooks<Ctx extends ToolContext>(
  hooks: ReActHooks<Ctx>,
  trace: EnginePolicyTrace,
): ReActHooks<Ctx> {
  const wrapped: ReActHooks<Ctx> = { ...hooks };

  const { onToolCalls } = hooks;
  if (onToolCalls) {
    wrapped.onToolCalls = (calls, state, ctx) => {
      const result = onToolCalls(calls, state, ctx);
      record(trace, "onToolCalls", classifyToolCalls(result));
      return result;
    };
  }

  const { onSuppressToolCalls } = hooks;
  if (onSuppressToolCalls) {
    wrapped.onSuppressToolCalls = (calls, state, ctx) => {
      const result = onSuppressToolCalls(calls, state, ctx);
      record(
        trace,
        "onSuppressToolCalls",
        classifyNullableDirective("onSuppressToolCalls", result),
      );
      return result;
    };
  }

  const { onToolCallsClose } = hooks;
  if (onToolCallsClose) {
    wrapped.onToolCallsClose = (calls, state, ctx) => {
      const result = onToolCallsClose(calls, state, ctx);
      record(
        trace,
        "onToolCallsClose",
        classifyCloseReason("onToolCallsClose", result),
      );
      return result;
    };
  }

  const { onBeforeExecute } = hooks;
  if (onBeforeExecute) {
    wrapped.onBeforeExecute = (calls, ctx) => {
      const result = onBeforeExecute(calls, ctx);
      const rejected = result.rejected?.length ?? 0;
      record(trace, "onBeforeExecute", {
        policyId: "onBeforeExecute:maxToolCallsPerRound",
        outcome: rejected > 0 ? "applied" : "skipped",
        reason:
          rejected > 0
            ? `capped ${rejected} over-budget call(s)`
            : "within per-round cap",
      });
      return result;
    };
  }

  const { onAfterExecuteContinue } = hooks;
  if (onAfterExecuteContinue) {
    wrapped.onAfterExecuteContinue = async (results, state, ctx) => {
      const result = await onAfterExecuteContinue(results, state, ctx);
      record(
        trace,
        "onAfterExecuteContinue",
        classifyNullableDirective("onAfterExecuteContinue", result),
      );
      return result;
    };
  }

  const { onAfterExecute } = hooks;
  if (onAfterExecute) {
    wrapped.onAfterExecute = (results, state, ctx) => {
      const result = onAfterExecute(results, state, ctx);
      record(
        trace,
        "onAfterExecute",
        classifyCloseReason("onAfterExecute", result),
      );
      return result;
    };
  }

  const { onRoundEmpty } = hooks;
  if (onRoundEmpty) {
    wrapped.onRoundEmpty = (state, ctx) => {
      const result = onRoundEmpty(state, ctx);
      record(trace, "onRoundEmpty", classifyRoundEmpty(result));
      return result;
    };
  }

  const { onRepairRound } = hooks;
  if (onRepairRound) {
    wrapped.onRepairRound = (state, ctx) => {
      const result = onRepairRound(state, ctx);
      record(trace, "onRepairRound", classifyRepairRound(result));
      return result;
    };
  }

  const { onTerminate } = hooks;
  if (onTerminate) {
    wrapped.onTerminate = async (reason, state, ctx) => {
      // Record BEFORE awaiting: the terminate reason is the policy identity, and
      // recording it up front keeps the trace ordered even when the synthesis
      // await interleaves with nothing else (single-threaded loop).
      record(trace, "onTerminate", classifyTerminate(reason));
      return onTerminate(reason, state, ctx);
    };
  }

  const { onModelCallError } = hooks;
  if (onModelCallError) {
    wrapped.onModelCallError = async (error, state, ctx) => {
      const result = await onModelCallError(error, state, ctx);
      record(trace, "onModelCallError", classifyModelError(result));
      return result;
    };
  }

  const { runToolBatch } = hooks;
  if (runToolBatch) {
    wrapped.runToolBatch = async (calls, runOne, ctx) => {
      const result = await runToolBatch(calls, runOne, ctx);
      record(trace, "runToolBatch", {
        policyId: "runToolBatch:execute",
        outcome: "applied",
        reason: `executed ${result.length} tool result(s)`,
      });
      return result;
    };
  }

  // onFinalize is a pure text passthrough in the engine path; recording it would
  // add noise per round without policy value, so it is intentionally not traced.

  return wrapped;
}
