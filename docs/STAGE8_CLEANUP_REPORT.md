# Stage 8 Engine Cleanup — Campaign Progress Report

**Branch:** `feat/stage8-engine-cleanup`
**Code HEAD before this docs-only report:** `477245b887dc769d3f04ca1133b2b9ccfd42e823`
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
  shaping. Budget closeout snapshots for final-recovery exhaustion, wall-clock
  exhaustion, and round-limit synthesis now route through that controller after
  the adapter-selected policy fires. The final allowed tool-round warning now
  routes through that controller while the warning text itself lives in neutral
  shared code used by inline and engine. Final-recovery budget parsing, prior-call
  counting, closeout reason lines, and repair prompt helpers also moved into
  neutral shared code. The first
  continuation slices now live in `react-engine/continuation-controller.ts`:
  empty-round direct `sessions_send` and lookup `sessions_list` injection, plus
  approved-browser timeout, coverage/sibling timeout, and supplemental local
  timeout probe continuation decisions, and incomplete approved-browser session
  continuation, independent evidence-stream continuation, and forced pending
  approval `permission_result` continuation, plus post-execute missing
  approval-gate repair handoff. The timeout predicates, session detectors,
  permission-applied detector, permission-result detector, evidence-stream
  detector, missing approval-gate repair detector/prompt, and continuation
  prompts/calls are shared by inline and engine through neutral role-runtime
  helper code.

The adapter is thinner, but the campaign is **not complete**. `runViaReActEngine` is
still an adapter-heavy bridge and still owns closeout, repair, completed-closeout,
evidence/task-fact behavior, and adapter-side application of controller actions.

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
| `73733db` | Extract empty-round continuation injection into `ContinuationController`; add focused direct-send/lookup tests. |
| `b188490` | Extract approved-browser and coverage timeout continuation decisions into `ContinuationController`; share timeout continuation helpers. |
| `859f15f` | Extract supplemental local timeout probe decisions into `ContinuationController`; share probe predicates/prompts. |
| `27f0e96` | Extract incomplete approved-browser session continuation into `ContinuationController`; share detector/prompt helpers. |
| `326cdd3` | Extract independent evidence-stream continuation into `ContinuationController`; share detector/prompt helpers. |
| `6b55996` | Extract forced pending approval `permission_result` continuation into `ContinuationController`; share permission trace readers/call builder. |
| `2122b9e` | Extract post-execute missing approval-gate repair continuation into `ContinuationController`; share repair predicate/prompt helpers. |
| `477245b` | Extract execution-budget closeout snapshot builders for recovery-budget, wall-clock, and round-limit closeouts. |

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
  execution, plus budget closeout snapshot construction for recovery-budget,
  wall-clock, and round-limit terminal synthesis.
- `react-engine/continuation-controller.ts` for empty-round `sessions_send` /
  `sessions_list` continuation injection and preview, plus approved-browser and
  coverage/sibling timeout continuation decisions and supplemental local timeout
  probe continuation decisions, and incomplete approved-browser session
  continuation, independent evidence-stream continuation, and forced pending
  approval `permission_result` continuation, plus post-execute missing
  approval-gate repair continuation.
- `tool-loop-shared.ts` as the neutral shared helper module for inline + engine,
  including final-recovery budget parsing/counting, repair text helpers, timeout
  continuation predicates, timeout continuation prompts, supplemental local
  timeout probe predicates/prompts, incomplete approved-browser session
  detector/prompt helpers, independent evidence-stream detector/prompt helpers,
  permission-applied evidence checks, permission-result status readers, forced
  permission-result call construction, missing approval-gate repair predicate
  and prompt construction, and completed browser-session evidence checks.

Still shell/deferred:

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
| `npx tsx --test packages/role-runtime/src/react-engine/*.test.ts` | 58 / 58 |
| `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts` | 272 / 272 |
| `npx tsx --test packages/agent-core/src/*.test.ts` | 53 / 53 |
| `npm run parity:inline` | 226 / 226, 0 fail |
| `npm run parity:engine` | 267 / 267, 0 fail, 0 incomplete after individual recovery |
| `git diff --check` | clean |

Note: the parity runner's discovered count varies by mode/run because the default
runner uses chunk recovery and discovery filters; the invariant preserved here is
zero failures and zero incomplete tests after recovery.

## Is The Adapter Thin?

No. `runViaReActEngine` still begins at
`packages/role-runtime/src/llm-response-generator.ts:2498` and remains the composition
root plus several policy-heavy hook bodies. The main improvement is that seventeen
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
- recovery-budget, wall-clock, and round-limit closeout snapshot construction
  routes through `ExecutionBudgetController`; the adapter still owns when those
  policies fire until `CloseoutPolicyRegistry` lands.
- final allowed tool-round warning injection routes through
  `ExecutionBudgetController.applyFinalToolRoundWarning` while sharing the inline
  message transform.
- final-recovery budget parsing/counting and repair prompt text now live in
  neutral shared code instead of adapter-local helper functions.
- empty-round continuation preview and injection route through
  `ContinuationController`, covering direct `sessions_send` and lookup
  `sessions_list` precedence.
- post-execute timeout continuation routes through `ContinuationController`,
  covering `approved_browser_timeout_continuation` precedence over
  `coverage_timeout_continuation`.
- supplemental local timeout probe continuation routes through
  `ContinuationController`, covering both no-completed-session timeout probes and
  completed-session content-poor evidence probes.
- incomplete approved-browser session continuation routes through
  `ContinuationController`, covering same-session `sessions_send` continuation
  after approval-applied browser evidence reports an incomplete approved action.
- independent evidence-stream continuation routes through
  `ContinuationController`, covering the post-completed-session
  `sessions_spawn` continuation when fewer than the required delegated streams
  have completed.
- forced pending approval `permission_result` continuation routes through
  `ContinuationController`, covering both post-execute completed-session
  continuation and model-call-error continuation before evidence fallback.
- post-execute missing approval-gate repair continuation routes through
  `ContinuationController`, returning the repair marker as typed action data while
  the adapter applies it to the idempotency ledger.

## Remaining Work

Continue with the remaining high-risk pieces:

- extract closeout policy registry decisions/precedence, then repair,
  completed-closeout, evidence ledger, task facts, and final adapter thinning.

The branch is **not pushed**.
