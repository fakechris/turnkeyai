# Stage 8 Engine Cleanup — Campaign Progress Report

**Branch:** `feat/stage8-engine-cleanup`
**Code HEAD before this docs-only report:** `78d92bc9d0ed2e97ff7eab8c7750cb78f0d744d5`
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
  the selected policy fires. The first closeout registry policies also landed:
  `recovery_tool_budget`, `operator_cancelled`, `pseudo_tool_call`,
  `wall_clock_budget`, `round_limit`, `repeated_tool_failure`,
  `repeated_session_inspection`, `excessive_session_continuation`,
  `completed_sub_agent_final`, and `sub_agent_timeout` now return typed
  decisions from `react-engine/closeout-policy-registry.ts`, including the
  recovery-budget repair-round defer handoff, the pseudo tool-call closeout's
  empty-call / pending-continuation gates, the wall-clock / round-limit
  precedence handoff to execution-budget snapshots, pending-call/session
  anti-loop closeout metadata, and post-execute completed-vs-timeout selection.
  The first natural-finish repair policies,
  `final_recovery_budget_closeout_repair`, `missing_approval_gate`, and
  the approval-state repair sequence through `stale_denied_approval`, now return
  typed decisions from `react-engine/repair-policy-registry.ts`; the adapter
  still applies the repair marker and appended messages at the original
  precedence points.
  The final allowed tool-round warning now routes through that controller while
  the warning text itself lives in neutral shared code used by inline and engine.
  Final-recovery budget parsing, prior-call counting, closeout reason lines, and
  repair prompt helpers also moved into
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
still an adapter-heavy bridge and still owns remaining repair,
completed-closeout, evidence/task-fact behavior, terminal closeout synthesis
application, and adapter-side application of controller actions.

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
| `fa80eb9` | Extract `recovery_tool_budget` closeout/defer policy into `CloseoutPolicyRegistry`; add golden-order and focused registry tests. |
| `8205e16` | Extract `operator_cancelled` closeout policy into `CloseoutPolicyRegistry`; share cancelled-session detector. |
| `d394ab6` | Extract `pseudo_tool_call` closeout policy into `CloseoutPolicyRegistry`; share pseudo tool-call markup detector. |
| `695082b` | Extract `wall_clock_budget` and `round_limit` closeout policy decisions into `CloseoutPolicyRegistry`; preserve budget snapshot ownership. |
| `93bdaf8` | Extract repeated pending-call closeout policies into `CloseoutPolicyRegistry`; share session inspection/continuation anti-loop detectors. |
| `df4012c` | Extract post-execute `completed_sub_agent_final` / `sub_agent_timeout` closeout selection into `CloseoutPolicyRegistry`. |
| `2cc758b` | Extract final-recovery budget natural-finish repair selection into `RepairPolicyRegistry`; add focused repair registry tests. |
| `581ba2e` | Extract missing approval-gate natural-finish repair selection into `RepairPolicyRegistry`; preserve browser-evidence precedence via explicit enabled-policy windows. |
| `8b8d2ca` | Extract pending approval wait-timeout check repair selection into `RepairPolicyRegistry`; move its predicate/prompt into neutral shared code. |
| `4d36481` | Extract premature pending-approval repair selection into `RepairPolicyRegistry`; share pending-approval detectors/prompt helpers. |
| `472a12a` | Extract stale pending-approval repair selection into `RepairPolicyRegistry`; share applied-approval continuation detector/prompt helpers. |
| `78d92bc` | Extract denied approval repair selection into `RepairPolicyRegistry`; share denied-approval predicate/prompt helpers. |

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
- `react-engine/closeout-policy-registry.ts` for `ENGINE_CLOSEOUT_POLICY_ORDER`
  and the first pending-call closeout policies, `recovery_tool_budget`,
  `operator_cancelled`, `pseudo_tool_call`, `wall_clock_budget`, and
  `round_limit`, plus `repeated_tool_failure`,
  `repeated_session_inspection`, `excessive_session_continuation`,
  `completed_sub_agent_final`, and `sub_agent_timeout`, including the
  recovery-budget repair-round defer decision, pseudo tool-call empty-round
  gates, wall-clock continuation exceptions, limit-round pending-call gate,
  repeated pending-call/session anti-loop metadata, and post-execute
  completed-over-timeout precedence.
- `react-engine/repair-policy-registry.ts` for
  `ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER` and the first natural-finish
  repair policies: `final_recovery_budget_closeout_repair`,
  `missing_approval_gate`, `pending_approval_wait_timeout_check`,
  `premature_pending_approval`, `stale_pending_approval`, and
  `stale_denied_approval`, including exhausted final-recovery budget gating,
  bounded-closeout skip behavior, approval-gate repair gating, approval
  wait-timeout permission-result repair gating, stale pending/denied approval
  repair gating, repair marker idempotency, prompt construction, and typed
  tool-free/tool-round resynthesis decisions.
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
  and prompt construction, pending approval wait-timeout check repair predicate
  and prompt construction, premature/stale pending-approval repair predicates
  and prompt construction, denied approval repair predicate and prompt
  construction, cancelled-session closeout detection, pseudo tool-call markup
  detection, repeated session inspection/continuation detectors, and completed
  browser-session evidence checks.

Still shell/deferred or partial:

- `repair-policy-registry.ts` policies after `stale_denied_approval`
- `completed-closeout-controller.ts`
- `evidence-ledger.ts`
- `task-facts.ts`
- `legacy-text-detectors.ts`

## Latest Gates

All gates below passed on the current code before the report update:

| Gate | Result |
| --- | --- |
| `npx tsx --test packages/role-runtime/src/react-engine/repair-policy-registry.test.ts` | 19 / 19 |
| `npm run typecheck` | exit 0 |
| `npx tsx --test packages/role-runtime/src/react-engine/*.test.ts` | 98 / 98 |
| `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts` | 272 / 272 |
| `npx tsx --test packages/agent-core/src/*.test.ts` | 53 / 53 |
| `git diff --check` | clean |
| `npm run parity:inline` | 239 / 239, 0 fail |
| `npm run parity:engine` | 265 / 265, 0 fail, 0 incomplete after individual recovery; 11 chunks recovered individually |

Note: the parity runner's discovered count varies by mode/run because the default
runner uses chunk recovery and discovery filters; the invariant preserved here is
zero failures and zero incomplete tests after recovery.

## Is The Adapter Thin?

No. `runViaReActEngine` still begins at
`packages/role-runtime/src/llm-response-generator.ts:2514` and remains the composition
root plus several policy-heavy hook bodies. The main improvement is that twenty-nine
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
  routes through `ExecutionBudgetController`.
- `recovery_tool_budget` pending-call closeout/defer selection routes through
  `CloseoutPolicyRegistry`, including the repair-round defer handoff before
  terminal closeout.
- `operator_cancelled` pending-call closeout selection routes through
  `CloseoutPolicyRegistry`, using shared cancelled-session detection.
- `pseudo_tool_call` pending-call closeout selection routes through
  `CloseoutPolicyRegistry`, using shared pseudo tool-call markup detection while
  preserving the empty-call and pending-continuation gates.
- `wall_clock_budget` and `round_limit` pending-call closeout selection route
  through `CloseoutPolicyRegistry`, while `ExecutionBudgetController` still owns
  the closeout snapshot construction.
- `repeated_tool_failure`, `repeated_session_inspection`, and
  `excessive_session_continuation` pending-call closeout selection route through
  `CloseoutPolicyRegistry`, using shared session anti-loop detectors where
  needed.
- post-execute `completed_sub_agent_final` / `sub_agent_timeout` closeout
  selection routes through `CloseoutPolicyRegistry`; terminal reasonLines and
  synthesis metadata still live in the adapter's `onTerminate`.
- final-recovery budget natural-finish repair selection routes through
  `RepairPolicyRegistry`, while the adapter still appends the prior assistant
  candidate and records the repair marker.
- missing approval-gate natural-finish repair selection routes through
  `RepairPolicyRegistry`, with a transitional enabled-policy window preserving
  the still-adapter-owned browser-evidence precedence.
- pending approval wait-timeout check repair selection routes through
  `RepairPolicyRegistry`, using neutral shared predicate and prompt helpers while
  the adapter still appends the repair marker.
- premature pending-approval repair selection routes through
  `RepairPolicyRegistry`, with pending-approval text/session-evidence detectors
  now shared by inline and engine.
- stale pending-approval repair selection routes through `RepairPolicyRegistry`,
  with the applied-approval continuation detector now shared by inline and
  engine.
- stale denied-approval repair selection routes through `RepairPolicyRegistry`,
  using shared denied permission-result predicate and prompt helpers.
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

- continue extracting remaining repair decisions after
  `stale_denied_approval`, then completed-closeout, evidence
  ledger, task facts, terminal closeout synthesis/application, and final adapter
  thinning.

The branch is **not pushed**.
