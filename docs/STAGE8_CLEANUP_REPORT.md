# Stage 8 Engine Cleanup — Campaign Progress Report

**Branch:** `feat/stage8-engine-cleanup`
**Code HEAD before this docs-only report:** `d2253a59da5e440f7d7e97d347b2c931de1baad8`
**Date:** 2026-07-02

## Summary

The original cleanup campaign previously stopped after Batch 0/0.5 because Batch 1
could not move the normalizer without making the inline parity reference import from
`react-engine/*`. This run added and landed the missing prerequisite:

- **Batch 0.75:** extracted the shared text/url/session/browser/permission/finalization
  helper closure into neutral role-runtime shared code.
- **Batch 1 partial:** moved engine tool-call normalization order/pipeline into
  `react-engine/tool-call-normalizer.ts`, moved engine permission wrapper behavior into
  `react-engine/permission-policy.ts`, moved the engine finalization epilogue order
  into `react-engine/finalization-pipeline.ts`, and moved the engine tool-observability
  lifecycle into `react-engine/engine-run-observer.ts`. The mutable cross-hook run
  state now lives in `react-engine/engine-run-state.ts` instead of an adapter-local
  `run` object. A narrow execution-budget admission slice now lives in
  `react-engine/execution-budget-controller.ts`, and the engine tool-batch runner
  now owns its wall-clock signal, serial/concurrent chunking, and per-tool error
  shaping. The final allowed tool-round warning now routes through that controller
  while the warning text itself lives in neutral shared code used by inline and
  engine. Final-recovery budget parsing, prior-call counting, closeout reason
  lines, and repair prompt helpers also moved into neutral shared code.

The adapter is thinner, but the campaign is **not complete**. `runViaReActEngine` is
still an adapter-heavy bridge and still owns continuation, closeout, repair,
completed-closeout, and evidence/task-fact behavior.

## Commits Added After The Blocked Report

| Commit | Scope |
| --- | --- |
| `1600077` | Extract shared role-engine helper closure into `tool-loop-shared.ts`; amend the plan/spec with Batch 0.75 and the Rule 3 refinement. |
| `5181294` | Extract `ToolCallNormalizer` order/pipeline and `PermissionPolicy` wrapper; add focused module tests. |
| `8a27da3` | Extract `FinalizationPipeline` engine epilogue order; move shared finalization append/redaction helpers; add focused module tests. |
| `7b4e225` | Extract `EngineRunObserver` lifecycle; move native tool trace conversion helpers into neutral shared code; add focused observer tests. |
| `60ab50d` | Migrate mutable cross-hook run state into `EngineRunState`; add state mutation-rule tests. |
| `10829de` | Extract `ExecutionBudgetController` admission/truncation slice; move skipped tool-call result helper to neutral shared code; add focused controller tests. |
| `bd1566a` | Extract `ExecutionBudgetController.runToolBatch`; move wall-clock execution helpers into neutral shared code; add focused batch-runner tests. |
| `a3d2961` | Move final tool-round warning ownership into `ExecutionBudgetController`; share the warning transform with inline. |
| `d2253a5` | Move final-recovery budget parsing/counting/repair helpers into neutral shared code. |

## Current Extracted Implementation

Real implementation now exists in:

- `react-engine/types.ts`
- `react-engine/engine-run-state.ts`
- `react-engine/policy-trace.ts`
- `react-engine/hook-policy-trace.ts`
- `react-engine/hook-orchestration-contract.ts`
- `react-engine/policy-trace-characterization.ts`
- `react-engine/tool-call-normalizer.ts`
- `react-engine/permission-policy.ts`
- `react-engine/finalization-pipeline.ts`
- `react-engine/engine-run-observer.ts`
- `react-engine/execution-budget-controller.ts` for final tool-round warning,
  final-recovery truncation, per-round tool-call admission, and engine tool-batch
  execution.
- `tool-loop-shared.ts` as the neutral shared helper module for inline + engine,
  including final-recovery budget parsing/counting and repair text helpers.

Still shell/deferred:

- `continuation-controller.ts`
- `closeout-policy-registry.ts`
- `repair-policy-registry.ts`
- `completed-closeout-controller.ts`
- `evidence-ledger.ts`
- `task-facts.ts`
- `legacy-text-detectors.ts`

## Latest Gates

All gates below passed on the current code before the report update:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx tsx --test packages/role-runtime/src/react-engine/*.test.ts` | 36 / 36 |
| `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts` | 272 / 272 |
| `npx tsx --test packages/agent-core/src/*.test.ts` | 53 / 53 |
| `npm run parity:inline` | 233 / 233, 0 fail |
| `npm run parity:engine` | 233 / 233, 0 fail, 0 incomplete after individual recovery |
| `git diff --check` | clean |

Note: the parity runner's discovered count varies by mode/run because the default
runner uses chunk recovery and discovery filters; the invariant preserved here is
zero failures and zero incomplete tests after recovery.

## Is The Adapter Thin?

No. `runViaReActEngine` still begins at
`packages/role-runtime/src/llm-response-generator.ts:2441` and remains the composition
root plus several policy-heavy hook bodies. The main improvement is that nine
Stage 8 boundaries/slices are now real:

- `onToolCalls` delegates normalization to `normalizeEngineToolCalls`.
- approval-gate normalizer steps and read-only suppression route through
  `PermissionPolicy` in the engine path.
- the unconditional engine finalization epilogue routes through
  `finalizeEngineAnswer`.
- model/tool lifecycle observability routes through `EngineRunObserver`, including
  `toolTrace`, runtime progress recorder events, and native tool-message persistence.
- mutable cross-hook state routes through `EngineRunState`, including closeout
  result/metadata, completed/timeout signals, reductions, memory flushes, and final
  message snapshots.
- execution-budget admission routes through `ExecutionBudgetController` for
  final-recovery pending-call truncation and per-round over-cap skipped results.
- engine tool-batch execution routes through `ExecutionBudgetController.runToolBatch`
  for order-sensitive serialization, concurrency chunks, wall-clock signal setup,
  and non-abort tool-error shaping.
- final allowed tool-round warning injection routes through
  `ExecutionBudgetController.applyFinalToolRoundWarning` while sharing the inline
  message transform.
- final-recovery budget parsing/counting and repair prompt text now live in
  neutral shared code instead of adapter-local helper functions.

## Remaining Work

Continue with the remaining high-risk pieces:

- finish execution-budget closeout decision/snapshot extraction, then extract
  continuation, closeout, repair, completed-closeout, evidence ledger, task facts,
  and final adapter thinning.

The branch is **not pushed**.
