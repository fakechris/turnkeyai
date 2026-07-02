# Stage 8 Engine Cleanup — Campaign Progress Report

**Branch:** `feat/stage8-engine-cleanup`
**Code HEAD before this docs-only report:** `2c15c614fab6dffff5857abaf4992fba144d6ef4`
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
  Pending closeout and post-execute closeout state-effect application now also
  route through `CloseoutPolicyRegistry` application helpers; the adapter passes
  the run-state target. The pending-call closeout windows now also enter through
  registry-owned application helpers for recovery-budget and remaining pending
  calls; the adapter keeps only the cross-module ordering around empty-round
  continuation preview. The post-execute closeout hook now also enters through
  `CloseoutPolicyRegistry.applyPostExecuteCloseout()`, so completed-vs-timeout
  selection and state writes are one registry-owned application boundary.
  The first natural-finish repair policies,
  `final_recovery_budget_closeout_repair`, `missing_approval_gate`, and
  the approval-state repair sequence through
  `incomplete_approved_browser_action`, plus
  `missing_requested_table_columns` and
  `extraneous_provider_table_schema`, plus
  `source_evidence_carry_forward` and `weak_evidence_synthesis`, now return
  typed decisions from
  `react-engine/repair-policy-registry.ts`; the registry now also applies
  natural-finish repair decisions into ReAct hook results, including assistant
  candidate carry-forward, repair-marker recording, force-tool-choice,
  consumes-round, and local closeout shapes. The natural-finish repair cascade
  now also evaluates and applies through that registry in precedence order; the
  adapter passes the hook state and no longer steps through each policy window.
  The forced `sessions_spawn` natural-finish repairs for missing
  browser-visible evidence and product-signal dashboard evidence now return
  typed decisions from the same registry, preserving their precedence before
  the missing approval-gate repair.
  The first completed-closeout-only repair policies also now return typed
  decisions from that registry: `timeout_followup_final_guidance`,
  `missing_requested_next_action`, `missing_required_final_deliverables`,
  `missing_browser_evidence_dimensions`, and
  `false_evidence_blocked_synthesis`. The completed-session repair loop now
  routes through `react-engine/completed-closeout-controller.ts`; model calls
  are still injected by the adapter, but browser/product-signal re-arm
  decisions now run inside the controller through `RepairPolicyRegistry`.
  Completed-closeout source-evidence carry-forward and weak-evidence synthesis
  repair decisions also now route through that registry using controller-provided
  evidence formula text.
  The completed-closeout post-synthesis visibility chain now routes through that
  controller too, while shared browser recovery/failure-bucket and timeout
  continuation helpers remain neutral for inline + engine parity.
  Completed terminal synthesis orchestration now also enters that controller:
  it owns completed evidence-text assembly, initial/repair memory-flush ordering,
  completed repair-loop invocation, completed visibility finalization, and the
  re-arm/final result boundary. The adapter still injects the model gateway
  calls; terminal state-effect application now goes through
  `TerminalCloseoutController`.
  `react-engine/evidence-ledger.ts` now has a behavior-neutral snapshot facade
  over the existing source-bounded and completed-session evidence collectors,
  and the extracted completed-closeout controller / repair registry read that
  natural-finish evidence formula through the facade. The same snapshot now
  owns tool-trace result content and usable-evidence truth for the engine
  terminal/error/finalization paths, so those adapter paths no longer call the
  raw evidence helpers directly. Current-round tool-result content text is now
  also exposed through the ledger for the engine timeout-probe and completed
  terminal-synthesis handoffs, and current-round completed-session / sub-agent
  timeout signals are now read through the ledger in engine continuation and
  post-execute closeout hooks.
  `react-engine/terminal-closeout-controller.ts` now owns the engine's
  tool-evidence fallback closeout metadata/redaction assembly for hard approval
  wait-timeout fallback, plus model-call-error local evidence fallback gating,
  local answer construction, metadata, and redaction. It also owns pseudo
  tool-call terminal synthesis message selection and non-completed terminal
  synthesis effect application: memory-flush carry-forward, reduction
  carry-forward, and timeout closeout visibility decoration. It also owns
  terminal final response shaping, closeout metadata write-mode selection, and
  explicit terminal state-effect application through an injected recorder target.
  It now also owns terminal synthesis invocation boundaries: initial synthesis
  context construction/callback invocation for completed closeouts and the full
  non-completed synthesis invocation/effect application path. The adapter still
  supplies the gateway callback. The deterministic approval wait-timeout
  fallback and model-call-error local evidence fallback now also apply through
  controller-owned helper methods, so the adapter no longer builds then applies
  those fallback closeouts itself. Sticky completed terminal closeout
  pre-recording now also routes through the controller's recorder-target
  boundary instead of branching in the adapter. Completed terminal initial
  synthesis now also hands off to the completed-closeout controller through a
  `TerminalCloseoutController` boundary instead of adapter-local generated-result
  unpacking. Terminal synthesis path selection and final/re-arm application now
  also route through `TerminalCloseoutController`; the adapter supplies only the
  gateway/completed-closeout callbacks for that terminal path. The full
  terminal closeout entrypoint now also lives in that controller: the adapter
  passes the `CloseoutPolicyRegistry` decision and gateway callbacks, while the
  controller owns sticky pre-recording, reason-line handoff, completion path
  selection, and final/re-arm state-effect application. The model-call-error
  local-evidence fallback/rethrow boundary now also returns a typed controller
  result instead of adapter-local null handling. Model-call-error abort,
  forced pending-approval `permission_result`, and fallback selection now also
  route through `TerminalCloseoutController`; the adapter only executes the
  returned forced tool round or consumes the returned final/rethrow result. The
  controller now also applies that typed model-error recovery result into the
  react-loop hook shape (`"rethrow"`, `{ messages }`, or final response) through
  an injected forced-round executor, and trims raw forced-round execution
  results down to the hook continuation shape.
  Terminal closeout reasonLines and metadata construction now routes through
  `CloseoutPolicyRegistry.evaluateTerminate()` for pending closeout passthrough,
  `completed_sub_agent_final`, `sub_agent_timeout`, `round_limit`, and generic
  closeout fallback decisions. Terminal synthesis context construction,
  non-completed synthesis invocation, and terminal state-effect application now
  route through `TerminalCloseoutController`; the adapter supplies the gateway
  callback. The hard approval wait-timeout deterministic terminal fallback now
  enters through `TerminalCloseoutController.handleTerminalCloseoutHook()`,
  short-circuiting before synthesis while the adapter only passes the optional
  fallback evidence input.
  Requested table-column and provider-support-schema task facts now live in
  neutral `task-facts-shared.ts`; `react-engine/task-facts.ts` is now a
  compatibility wrapper for engine imports.
  Missing requested-column repair, extraneous provider-schema repair,
  awaiting-context setup-only suppression, and repair marker insertion now also
  live in that neutral TaskFacts owner, including awaiting-context suppression
  hook-result application. The adapter, `RepairPolicyRegistry`, and
  `CompletedCloseoutController` all call the same implementation instead of
  carrying duplicate helper copies. Read-only permission-query suppression
  hook-result application now lives in `PermissionPolicy`; the adapter supplies
  only hook state.
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
  approval `permission_result` continuation and its forced tool-round
  application boundary, plus post-execute missing approval-gate repair handoff,
  plus typed hook-result application for generic `continue` actions,
  repair-marker recording callbacks, and empty-round action hook-result
  application for injected calls versus terminate decisions. The full
  post-execute continuation cascade now also evaluates and applies through that
  controller; the adapter supplies evidence facts and the forced-round executor.
  Pending-call closeout application now also routes through
  `CloseoutPolicyRegistry.applyRecoveryToolBudgetCloseout()` before
  empty-round continuation preview and
  `CloseoutPolicyRegistry.applyRemainingPendingCallsCloseout()` after that
  preview, preserving the pinned hook orchestration order while removing the
  adapter-local evaluate/apply glue.
  The timeout predicates, session detectors,
  permission-applied detector, permission-result detector, evidence-stream
  detector, missing approval-gate repair detector/prompt, and continuation
  prompts/calls, plus completed product-signal dashboard carry-forward and URL
  extraction helpers, plus browser/product-signal missing evidence repair
  detectors and repair prompt builders, plus approval wait-timeout runtime
  evidence collection, approval wait-timeout deterministic local closeout
  answer construction, and generic local evidence / requested-table fallback
  answer construction, are shared by inline and engine through neutral
  role-runtime helper code.
  Tool-result pruning, tool-result envelope accounting, older tool-history
  compaction, and pruning trace snapshots now live in neutral
  `tool-history-pruning.ts`.
  Tool-definition filtering for permission tools, task-tracking tools, and
  focused durable-memory recall now lives in neutral `tool-definition-filter.ts`.
  Model-call boundary trace construction and model-use summary aggregation now
  live in neutral `model-call-trace.ts`.
  Gateway input construction, final synthesis format-contract lines, no-tool
  gateway transforms, mention extraction, and requested three-line label
  normalization now live in neutral `gateway-input-builder.ts`; request-envelope
  reduced prompt replacement now lives there too.
  Session trace canonicalization from structured session results and native
  tool-call counting now live in `native-tool-messages.ts`.
  Shared JSON object parsing and the stable `AbortError` guard now live in
  neutral `tool-loop-shared.ts`.
  Runtime-derived mission terminal reports now live in
  `runtime-derived-mission-report.ts`, and the supplemental browser-probe
  capability check now lives in neutral `tool-loop-shared.ts`.
  Wall-clock closeout signal construction now lives in
  `react-engine/execution-budget-controller.ts`, leaving the adapter to pass
  hook state into the controller instead of carrying a local budget-signal
  closure.
  The engine policy-trace debug env gate now lives with the policy-trace owner
  in `react-engine/policy-trace.ts` instead of as an adapter-local helper.
  Tool-result evidence collectors for completed sessions, timeout signals,
  session history evidence, tool-result text, tool-trace text, resumable partial
  sessions, and usable-evidence detection now live in neutral
  `tool-result-evidence.ts`.

The adapter is thinner, but the campaign is **not complete**. `runViaReActEngine` is
still an adapter-heavy bridge and still owns remaining evidence behavior,
terminal closeout gateway callback wiring, and remaining adapter-side action
application outside the terminal completion path.

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
| `d298c29` | Extract approval wait-timeout closeout and failed-repair local closeout selections into `RepairPolicyRegistry`; share wait-timeout closeout predicates/prompt helpers. |
| `c66dea9` | Extract incomplete approved-browser-action repair selection into `RepairPolicyRegistry`; share its predicate and forced-spawn repair prompt. |
| `e09679c` | Extract requested table/provider schema facts into `TaskFacts`; route missing requested-column and extraneous provider-schema repair decisions through `RepairPolicyRegistry`. |
| `cda764e` | Extract source-evidence carry-forward and weak-evidence synthesis repair selections into `RepairPolicyRegistry`; move their evidence collectors, detectors, and prompts into neutral shared code. |
| `966082a` | Extract completed synthesis repair selections into `RepairPolicyRegistry`; move completed-only timeout guidance, next-action, deliverable, browser-dimension, and false-blocked predicates/prompts into neutral shared code. |
| `a92c668` | Extract the completed-session repair loop into `CompletedCloseoutController`; keep model calls and forced browser/product-signal re-arm predicates injected from the adapter. |
| `09a6dc2` | Extract completed-closeout post-synthesis visibility into `CompletedCloseoutController`; move browser recovery visibility and timeout continuation appender helpers into neutral shared code. |
| `7a11fa5` | Add the first behavior-neutral `EvidenceLedger` snapshot facade and route extracted natural-finish evidence formula users through it. |
| `85a3c44` | Extract terminal closeout reasonLines/metadata decisions into `CloseoutPolicyRegistry.evaluateTerminate`; move completed product-signal carry-forward helpers into neutral shared code. |
| `9451190` | Move product-signal dashboard URL extraction into neutral shared code and remove the adapter-local duplicate dashboard regex tail. |
| `c0011d3` | Move missing browser/product-signal evidence repair detectors and prompt builders into neutral shared code. |
| `200f9e6` | Route missing browser/product-signal evidence natural-finish repair decisions through `RepairPolicyRegistry`; add focused policy tests. |
| `acb9db9` | Move completed-closeout browser/product-signal re-arm ownership into `CompletedCloseoutController`; remove the adapter-injected predicate closure. |
| `d2be68d` | Route completed-closeout source-evidence and weak-evidence repair decisions through `RepairPolicyRegistry`; add controller-provided evidence-text coverage. |
| `00e1482` | Move completed terminal synthesis orchestration into `CompletedCloseoutController`; add direct terminal-entry coverage. |
| `09f67bb` | Move approval wait-timeout local closeout evidence collection and deterministic answer construction into neutral shared helpers; add focused shared-helper tests. |
| `cc24757` | Move generic local evidence fallback and requested-table fallback construction into neutral shared helpers; move TaskFacts implementation to `task-facts-shared.ts` with a react-engine wrapper. |
| `4e7c4e8` | Move tool-result pruning, tool-history compaction, and pruning trace snapshot helpers into neutral `tool-history-pruning.ts`; add focused pruning tests. |
| `d76df2a` | Move tool-definition filtering and its prompt/message context builders into neutral `tool-definition-filter.ts`; add focused filtering tests. |
| `3f33d7d` | Move model-call boundary trace construction and model-use summary aggregation into neutral `model-call-trace.ts`; add focused trace tests. |
| `4529706` | Move gateway input construction, final synthesis format-contract helpers, no-tool transforms, mention extraction, and requested three-line label normalization into neutral `gateway-input-builder.ts`; add focused builder tests. |
| `7721010` | Move tool-result evidence collectors, completed-session/timeout readers, session-history evidence extraction, resumable partial-session detection, and usable-evidence checks into neutral `tool-result-evidence.ts`; add focused evidence tests. |
| `d4eb8ca` | Move missing requested-table repair helpers, extraneous provider-schema repair helpers, awaiting-context no-tool suppression, and repair marker insertion into neutral TaskFacts shared code; remove duplicate adapter/registry/controller implementations. |
| `9224078` | Move adapter utility helpers for session trace canonicalization, native tool-call counting, reduced prompt replacement, JSON object parsing, and abort guarding into neutral owners with focused tests. |
| `36deaba` | Move runtime-derived mission report construction into a neutral module and move supplemental browser-probe availability checking into shared tool-loop helpers. |
| `da476f9` | Move wall-clock closeout signal construction into `ExecutionBudgetController`; `CloseoutPolicyRegistry` consumes the controller-owned signal type. |
| `e3c4e8e` | Move the policy-trace debug env gate into `react-engine/policy-trace.ts`; add focused env-gate coverage. |
| `7f63ebd` | Expand `EvidenceLedger` snapshots with tool-trace result content and usable-evidence facts; route engine terminal/error/finalization consumers through the snapshot. |
| `0101bda` | Route current-round tool-result evidence text through `EvidenceLedger`; engine timeout-probe and completed terminal-synthesis handoffs stop calling the raw collector. |
| `c35fd72` | Add approval wait-timeout runtime evidence to `EvidenceLedger` snapshots; engine hard fallback reads the snapshot fact. |
| `f19f12d` | Route current completed-session and sub-agent timeout result signals through `EvidenceLedger` in engine hooks. |
| `da7af31` | Extract `TerminalCloseoutController` for approval wait-timeout fallback assembly, pseudo tool-call terminal synthesis message selection, and sub-agent timeout result visibility decoration. |
| `b1e756a` | Centralize generic `tool_evidence_fallback` closeout metadata/redaction in `TerminalCloseoutController`; model-call-error fallback now uses the same builder as the hard approval wait-timeout fallback. |
| `6251ed3` | Move model-call-error local evidence fallback gating and answer construction into `TerminalCloseoutController`; adapter only records the returned fallback effects. |
| `decec6f` | Move non-completed terminal synthesis effect application into `TerminalCloseoutController`; adapter records returned memory flush, reduction, and final result effects. |
| `7cc62f8` | Move terminal final response shaping and closeout metadata write-mode selection into `TerminalCloseoutController`; adapter only records through the returned mode/response boundary. |
| `05c6d39` | Move terminal closeout state-effect application into `TerminalCloseoutController`; adapter passes the run-state recorder target instead of branching over memory flush, reduction, closeout metadata, and final result writes. |
| `3f6ea65` | Move terminal synthesis invocation boundaries into `TerminalCloseoutController`; adapter supplies the gateway callback while controller owns pseudo-tool-call context selection and non-completed synthesis invocation/effect application. |
| `8307b8b` | Move deterministic approval wait-timeout and model-call-error fallback application helpers into `TerminalCloseoutController`; adapter passes fallback inputs and the run-state recorder target. |
| `ee3a57d` | Move sticky completed terminal closeout pre-recording into `TerminalCloseoutController`; adapter passes sticky metadata and the run-state recorder target. |
| `8a22741` | Move completed terminal initial-synthesis handoff into `TerminalCloseoutController`; adapter supplies the completed-closeout callback instead of unpacking the initial generated result. |
| `3dae00b` | Move terminal synthesis path selection and final/re-arm application into `TerminalCloseoutController`; adapter supplies gateway/completed-closeout callbacks. |
| `920e16d` | Move the terminal closeout entrypoint into `TerminalCloseoutController`; adapter passes the terminate decision and gateway callbacks instead of stitching sticky/application steps locally. |
| `ac0a765` | Move the model-call-error fallback/rethrow boundary into `TerminalCloseoutController`; adapter consumes a typed final-or-rethrow result. |
| `87f5244` | Move model-call-error abort / forced pending-approval continuation / fallback selection into `TerminalCloseoutController`; adapter executes only the returned forced tool round. |
| `16c90e2` | Move model-call-error hook-result application into `TerminalCloseoutController`; adapter supplies only the forced-round executor callback. |
| `b17d155` | Move post-execute forced continuation application into `ContinuationController`; adapter supplies only the forced-round executor callback. |
| `c6e555b` | Move generic continuation action hook-result application into `ContinuationController`; adapter consumes typed hook results and supplies only marker recording callbacks. |
| `e610f14` | Move model-call-error forced-round result trimming into `TerminalCloseoutController`; adapter returns the raw forced-round execution result. |
| `fa0b83e` | Move natural-finish repair hook-result application into `RepairPolicyRegistry`; adapter keeps precedence selection but no longer assembles repair messages/markers. |
| `6c79d6f` | Move read-only permission-query and awaiting-context no-tool suppression hook-result application into `PermissionPolicy` / neutral TaskFacts owners. |
| `78cae84` | Move pending closeout and post-execute closeout state-effect application into `CloseoutPolicyRegistry`; adapter passes the run-state target. |
| `bdd5a13` | Move round-empty continuation hook-result application into `ContinuationController`; adapter consumes the controller-applied hook decision. |
| `3cfa87b` | Move natural-finish repair cascade evaluation/application into `RepairPolicyRegistry`; adapter passes one cascade input instead of stepping policy windows. |
| `f8a2997` | Move post-execute continuation cascade evaluation/application into `ContinuationController`; adapter supplies evidence facts and forced-round execution. |
| `a552f63` | Move pending-call closeout evaluate/apply windows into `CloseoutPolicyRegistry` application helpers; adapter keeps only the recovery-before-preview ordering. |
| `1660d44` | Move post-execute closeout evaluate/apply into `CloseoutPolicyRegistry.applyPostExecuteCloseout`; adapter passes hook input and run-state target. |
| `2c15c61` | Route the hard approval wait-timeout terminal fallback through `TerminalCloseoutController.handleTerminalCloseoutHook`; adapter supplies fallback evidence instead of owning the early deterministic branch. |

## Current Extracted Implementation

Real implementation now exists in:

- `react-engine/types.ts`
- `react-engine/engine-run-state.ts`
- `react-engine/policy-trace.ts` for trace recording, the no-op trace, and the
  engine policy-trace debug env gate.
- `react-engine/hook-policy-trace.ts`
- `react-engine/hook-orchestration-contract.ts`
- `react-engine/policy-trace-characterization.ts`
- `react-engine/tool-call-normalizer.ts`
- `react-engine/permission-policy.ts` for approval-gate normalization,
  read-only permission-query suppression selection, and read-only suppression
  hook-result application.
- `react-engine/finalization-pipeline.ts`
- `react-engine/engine-run-observer.ts`
- `react-engine/execution-budget-controller.ts` for final tool-round warning,
  final-recovery truncation, per-round tool-call admission, and engine tool-batch
  execution, plus budget closeout snapshot construction for recovery-budget,
  wall-clock, and round-limit terminal synthesis, plus wall-clock closeout
  signal construction for `onToolCallsClose`.
- `react-engine/closeout-policy-registry.ts` for `ENGINE_CLOSEOUT_POLICY_ORDER`
  and the first pending-call closeout policies, `recovery_tool_budget`,
  `operator_cancelled`, `pseudo_tool_call`, `wall_clock_budget`, and
  `round_limit`, plus `repeated_tool_failure`,
  `repeated_session_inspection`, `excessive_session_continuation`,
  `completed_sub_agent_final`, and `sub_agent_timeout`, including the
  recovery-budget repair-round defer decision, pseudo tool-call empty-round
  gates, wall-clock continuation exceptions, limit-round pending-call gate,
  repeated pending-call/session anti-loop metadata, and post-execute
  completed-over-timeout precedence, plus terminal `onTerminate` reasonLines and
  metadata decisions for pending closeout passthrough, completed session
  closeout, sub-agent timeout closeout, round-limit closeout, and generic
  closeout fallback, plus pending closeout and post-execute closeout
  state-effect application through injected targets, including the
  recovery-budget and remaining pending-call evaluate/apply entrypoints used by
  `onToolCallsClose`, plus the post-execute closeout application entrypoint used
  by `onAfterExecute`.
- `react-engine/repair-policy-registry.ts` for
  `ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER` and the first natural-finish
  repair policies: `final_recovery_budget_closeout_repair`,
  `missing_browser_evidence`,
  `missing_product_signal_browser_evidence`,
  `missing_approval_gate`, `pending_approval_wait_timeout_check`,
  `premature_pending_approval`, `stale_pending_approval`, and
  `stale_denied_approval`, plus `approval_wait_timeout_closeout` and
  `approval_wait_timeout_local_closeout`, and
  `incomplete_approved_browser_action`, `missing_requested_table_columns`, and
  `extraneous_provider_table_schema`, plus `source_evidence_carry_forward` and
  `weak_evidence_synthesis`, including exhausted final-recovery
  budget gating, bounded-closeout skip behavior, missing browser/product-signal
  evidence forced-spawn gating, approval-gate repair gating,
  approval wait-timeout permission-result repair gating, stale pending/denied
  approval repair gating, approval wait-timeout closeout repair gating,
  failed-repair deterministic local closeout gating, incomplete approved-browser
  action repair gating, requested table-column repair gating, extraneous
  provider-support-schema repair gating, source-evidence carry-forward repair
  gating, weak-evidence synthesis repair gating, controller-provided evidence
  formula text for completed-closeout source/weak repairs, natural-finish
  ReAct repair hook application for assistant candidate carry-forward,
  repair-marker recording, force-tool-choice, consumes-round, and local closeout
  shapes, plus natural-finish cascade evaluation/application through one
  registry entrypoint, plus
  `ENGINE_COMPLETED_SYNTHESIS_REPAIR_POLICY_ORDER` and the completed-only
  repair policies `timeout_followup_final_guidance`,
  `missing_requested_next_action`, `missing_required_final_deliverables`,
  `missing_browser_evidence_dimensions`, and
  `false_evidence_blocked_synthesis`, including repair marker idempotency,
  prompt construction, source-bounded/completed-session evidence formula
  collection, and typed tool-free/tool-round resynthesis or closeout decisions.
- `react-engine/completed-closeout-controller.ts` for the bounded
  completed-session terminal synthesis handoff and repair loop, completed
  evidence-text assembly, completed-only round-0 gating, round>0
  browser/product-signal re-arm precedence through `RepairPolicyRegistry`,
  repair marker insertion, initial/repair memory flush ordering,
  memory flush/reduction carry-forward, and one clean tool-free cleanup
  synthesis when a completed repair produces tool-call artifact text,
  source-evidence/weak-evidence repair dispatch through `RepairPolicyRegistry`,
  plus the completed closeout post-synthesis visibility chain for browser recovery visibility,
  browser failure-bucket visibility, recovered-timeout/continuation visibility,
  and final forbidden local URL redaction.
- `react-engine/terminal-closeout-controller.ts` for deterministic approval
  wait-timeout terminal fallback assembly, generic `tool_evidence_fallback`
  metadata/redaction assembly, model-call-error local evidence fallback gating
  and answer construction, pseudo tool-call terminal synthesis message selection,
  and non-completed terminal synthesis effect application including timeout
  closeout visibility, memory-flush carry-forward, and reduction carry-forward,
  plus terminal closeout write-mode selection, final response shaping, and
  explicit terminal state-effect application through a recorder target, plus
  terminal synthesis invocation boundaries through an injected gateway callback,
  plus deterministic approval wait-timeout and model-call-error fallback
  application helpers, sticky completed terminal closeout pre-recording, and
  completed terminal initial-synthesis handoff into the completed-closeout
  controller callback, plus terminal synthesis path selection and final/re-arm
  application through an injected recorder target, plus the full terminal
  closeout entrypoint from terminate decision to completion, plus the terminal
  hook entrypoint that short-circuits deterministic approval wait-timeout
  fallback before synthesis, plus the model-call-error local-evidence
  fallback/rethrow boundary and model-call-error
  abort / forced pending-approval continuation / fallback flow selection and
  hook-result application through an injected forced-round executor, including
  raw forced-round execution result trimming.
- `react-engine/evidence-ledger.ts` for the first behavior-neutral
  `EvidenceSnapshot` facade over source-bounded evidence, completed-session
  evidence, current tool-result content, current completed-session and timeout
  result signals, tool-trace result content, approval wait-timeout runtime
  evidence, usable-evidence truth, and the natural-finish evidence formula
  consumed by extracted repair policies/controllers and engine continuation,
  terminal, error, and finalization paths.
- `react-engine/continuation-controller.ts` for empty-round `sessions_send` /
  `sessions_list` continuation injection and preview, plus approved-browser and
  coverage/sibling timeout continuation decisions and supplemental local timeout
  probe continuation decisions, and incomplete approved-browser session
  continuation, independent evidence-stream continuation, and forced pending
  approval `permission_result` continuation, plus forced tool-round application
  into hook `{ messages }` continuations through an injected executor, plus
  post-execute missing approval-gate repair continuation, plus typed
  `continue` action hook-result application with repair-marker recording
  callback support, and empty-round action hook-result application for
  injected-call and terminate decisions, plus post-execute continuation cascade
  precedence/application through one controller entrypoint.
- `task-facts-shared.ts` for requested table-column inference, markdown table
  header matching, provider search/pricing evidence-column inference,
  provider-support-schema request/result detection, missing requested-column
  repair helpers, extraneous provider-schema repair helpers, awaiting-context
  setup-only no-tool suppression and hook-result application, and repair marker
  insertion used by the adapter, repair registry, and completed-closeout
  controller.
- `react-engine/task-facts.ts` as a compatibility wrapper around the neutral
  TaskFacts implementation for engine import sites.
- `tool-history-pruning.ts` for request-envelope tool-result pruning, older
  tool-history compaction, tool-result envelope accounting, pruning trace
  snapshots, and assistant/tool block indexing helpers.
- `tool-definition-filter.ts` for permission-tool suppression, source-check
  task-tracking suppression, focused durable-memory recall narrowing, and
  tool-definition filter prompt/message context construction.
- `model-call-trace.ts` for model-call boundary trace construction, tool-choice
  trace formatting, request-envelope reduction metadata capture, and model-use
  token summary aggregation.
- `gateway-input-builder.ts` for gateway input construction, runtime session
  continuation directive prompt injection, final synthesis format-contract
  lines, no-tool gateway transforms, mention extraction, tool-definition lookup,
  requested three-line label normalization, and request-envelope prompt-message
  replacement.
- `native-tool-messages.ts` for native tool-message construction, session trace
  canonicalization from structured session results, and native tool-call
  counting.
- `runtime-derived-mission-report.ts` for runtime-derived mission terminal
  status mapping and report construction shared by the engine adapter.
- `tool-result-evidence.ts` for completed-session evidence summaries,
  sub-agent timeout signal extraction, session-history evidence extraction,
  required-timeout continuation allowance, resumable partial-session detection,
  tool-result/tool-trace text collection, and usable-evidence checks.
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
  construction, approval wait-timeout closeout repair predicates and prompt
  construction, approval wait-timeout runtime evidence collection and
  deterministic local closeout answer construction, generic local evidence
  fallback construction, requested-table local fallback answer construction,
  incomplete approved-browser-action repair predicate and prompt construction,
  source-bounded evidence collection, completed-session evidence
  collection, source-evidence carry-forward predicates/prompts, weak-evidence
  synthesis predicates/prompts, completed-only timeout follow-up guidance,
  requested next-action, required final deliverable, browser-dimension, and
  false blocked-evidence synthesis predicates/prompts, cancelled-session closeout detection, pseudo
  tool-call markup detection, repeated session inspection/continuation
  detectors, completed browser-session evidence checks, browser recovery
  summary collection/visibility helpers, completed product-signal dashboard
  carry-forward and URL extraction helpers, browser/product-signal missing
  evidence repair detectors and prompt builders, and the timeout continuation
  visibility appender, plus shared JSON object parsing and the stable abort
  guard used by adapter/controller code, plus supplemental browser-probe
  availability checking.

Still shell/deferred or partial:

- `evidence-ledger.ts` producer rewrite beyond the current facade
- typed task facts beyond the current requested table/provider schema extraction
- `legacy-text-detectors.ts`

## Latest Gates

All gates below passed on the current code before the report update:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| terminal-closeout focused test plus hook/golden focused tests | 29 / 29 |
| `npx tsx --test packages/role-runtime/src/react-engine/*.test.ts` | 180 / 180 |
| `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts` | 272 / 272 |
| `npx tsx --test packages/agent-core/src/*.test.ts` | 53 / 53 |
| `git diff --check` | clean |
| `npm run parity:inline` | 272 / 272, 0 fail |
| `npm run parity:engine` | 272 / 272, 0 fail; all 14 chunks completed |

Note: this latest parity run discovered all 272 tests in both modes and completed
the engine chunks without individual recovery.

## Is The Adapter Thin?

No. `runViaReActEngine` still begins at
`packages/role-runtime/src/llm-response-generator.ts:2478` and remains the composition
root plus several policy-heavy hook bodies. The main improvement is that more than sixty
Stage 8 boundaries/slices are now real:

- `onToolCalls` delegates normalization to `normalizeEngineToolCalls`.
- engine policy-trace debug gating routes through `policy-trace.ts`; the adapter
  imports the owner-owned helper instead of carrying the env check locally.
- approval-gate normalizer steps and read-only suppression selection/application
  route through `PermissionPolicy` in the engine path.
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
- wall-clock closeout signal construction for `onToolCallsClose` routes through
  `ExecutionBudgetController`, while `CloseoutPolicyRegistry` consumes the
  controller-owned signal type.
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
- pending-call closeout application for recovery-budget and remaining pending
  calls routes through `CloseoutPolicyRegistry`; the adapter keeps only the
  cross-module ordering around empty-round continuation preview.
- post-execute `completed_sub_agent_final` / `sub_agent_timeout` closeout
  selection and state-effect application route through `CloseoutPolicyRegistry`;
  the adapter passes the hook input and run-state target through a single
  registry application entrypoint.
- terminal closeout reasonLines and metadata construction routes through
  `CloseoutPolicyRegistry.evaluateTerminate`, covering pending closeout
  passthrough, completed session closeout, sub-agent timeout closeout,
  round-limit closeout, and generic closeout fallback; terminal synthesis
  context construction, non-completed synthesis invocation, and terminal
  state-effect application route through `TerminalCloseoutController`, while the
  adapter supplies the gateway callback.
- deterministic approval wait-timeout fallback assembly, generic
  `tool_evidence_fallback` metadata/redaction, model-call-error local evidence
  fallback gating/answer construction, pseudo tool-call terminal synthesis
  message selection, and non-completed terminal synthesis effect application
  route through `TerminalCloseoutController`, including sub-agent timeout
  closeout visibility, memory-flush carry-forward, reduction carry-forward,
  terminal closeout write-mode selection, final response shaping, and terminal
  state-effect application through an injected recorder target, plus terminal
  synthesis invocation through an injected gateway callback. The deterministic
  approval wait-timeout fallback and model-call-error local evidence fallback
  now apply through controller helpers instead of adapter-local build/apply
  branches; sticky completed terminal closeout pre-recording also now routes
  through the controller target boundary, and completed terminal initial
  synthesis now hands off through a controller-owned callback boundary. Terminal
  synthesis path selection, final response application, and completed
  re-arm/effect application now also route through the controller-owned
  completion boundary. The adapter now enters terminal closeout through a single
  controller-owned entrypoint that consumes the terminate decision and applies
  sticky pre-recording plus final/re-arm effects. Model-call-error local
  evidence fallback now returns a controller-owned typed final/rethrow result.
  The hard approval wait-timeout deterministic fallback now also enters through
  `TerminalCloseoutController.handleTerminalCloseoutHook`, so `onTerminate`
  no longer carries a separate adapter-local early return before terminal
  synthesis.
- final-recovery budget natural-finish repair selection and ReAct hook-result
  application route through `RepairPolicyRegistry`; the adapter keeps only the
  precedence checkpoint.
- missing approval-gate natural-finish repair selection routes through
  `RepairPolicyRegistry`, with a transitional enabled-policy window preserving
  the still-adapter-owned browser-evidence precedence.
- pending approval wait-timeout check repair selection and hook-result
  application route through `RepairPolicyRegistry`, using neutral shared
  predicate and prompt helpers.
- premature pending-approval repair selection routes through
  `RepairPolicyRegistry`, with pending-approval text/session-evidence detectors
  now shared by inline and engine.
- stale pending-approval repair selection routes through `RepairPolicyRegistry`,
  with the applied-approval continuation detector now shared by inline and
  engine.
- stale denied-approval repair selection routes through `RepairPolicyRegistry`,
  using shared denied permission-result predicate and prompt helpers.
- approval wait-timeout closeout repair selection routes through
  `RepairPolicyRegistry`, using shared wait-timeout evidence/completeness
  predicates and repair prompt construction.
- failed approval wait-timeout repair local closeout selection routes through
  `RepairPolicyRegistry`, returning a typed `tool_evidence_fallback` closeout
  directive while the deterministic local-evidence text now lives in neutral
  shared helper code.
- approval wait-timeout local closeout runtime evidence collection and
  deterministic answer construction are shared by inline and engine through
  `tool-loop-shared.ts`, with focused unit coverage.
- generic local evidence fallback and requested-table local fallback answer
  construction are shared by inline and engine through `tool-loop-shared.ts`,
  with focused unit coverage; the adapter now calls the shared helper instead
  of owning the fallback closure.
- request-envelope tool-result pruning, older tool-history compaction,
  tool-result envelope accounting, pruning trace snapshots, and assistant/tool
  block indexing now live in neutral `tool-history-pruning.ts`; the adapter
  calls the module instead of owning that pruning closure.
- tool-definition filtering for permission tools, task-tracking tools, and
  focused durable-memory recall now lives in neutral
  `tool-definition-filter.ts`; the adapter calls the module instead of owning
  that filter closure.
- model-call boundary trace construction and model-use summary aggregation now
  live in neutral `model-call-trace.ts`; the adapter supplies gateway/result
  inputs but no longer owns trace formatting.
- gateway input construction, runtime session continuation directive prompt
  injection, final synthesis format-contract lines, no-tool gateway transforms,
  mention extraction, tool-definition lookup, and requested three-line label
  normalization now live in neutral `gateway-input-builder.ts`; the adapter
  calls the module instead of owning those context-construction helpers.
- request-envelope reduced prompt replacement now lives in
  `gateway-input-builder.ts`; the adapter calls the module instead of owning the
  prompt/history splice helper.
- session tool-trace canonicalization and native tool-call counting now live in
  `native-tool-messages.ts`; the adapter calls the module instead of owning
  trace mutation/counting helpers.
- shared JSON object parsing and the stable abort guard now live in
  `tool-loop-shared.ts`; the adapter imports them instead of keeping local
  copies.
- runtime-derived mission terminal report construction now lives in
  `runtime-derived-mission-report.ts`; the adapter imports the typed closeout
  metadata/report mapper instead of keeping the local status switch.
- supplemental browser-probe availability checking now lives in
  `tool-loop-shared.ts`; the adapter and shared tests use the neutral helper
  instead of an adapter-local capability predicate.
- tool-result evidence collectors, completed-session evidence summaries,
  sub-agent timeout signal extraction, session-history evidence extraction,
  required-timeout continuation allowance, resumable partial-session detection,
  tool-result/tool-trace text collection, and usable-evidence checks now live in
  neutral `tool-result-evidence.ts`; the adapter calls the module instead of
  owning that evidence helper closure.
- incomplete approved-browser-action repair selection routes through
  `RepairPolicyRegistry`, using shared approval-applied evidence/prompt
  predicates and returning a typed forced `sessions_spawn` repair round.
- requested table-column and provider-support-schema facts route through
  neutral `TaskFacts`, including prompt/message/activation context extraction
  and markdown table header matching.
- missing requested-column repair helpers, extraneous provider-schema repair
  helpers, awaiting-context setup-only no-tool suppression selection/application,
  and repair marker insertion route through neutral `TaskFacts`; the adapter,
  repair registry, and completed-closeout controller no longer carry duplicate
  helper implementations.
- missing requested table-column repair selection and hook-result application
  route through `RepairPolicyRegistry`.
- extraneous provider-support-schema repair selection routes through
  `RepairPolicyRegistry`, preserving the original-task requested-schema skip.
- source-bounded and completed-session evidence collection now live in neutral
  shared code and feed the natural-finish source/weak repair evidence formula.
- source-evidence carry-forward repair selection and hook-result application
  route through `RepairPolicyRegistry`.
- weak-evidence synthesis repair selection routes through
  `RepairPolicyRegistry`, preserving exact final-shape and estimate-request
  skips.
- natural-finish repair application for extracted repair decisions now routes
  through `RepairPolicyRegistry`, including repair marker recording, assistant
  candidate carry-forward, `forceToolChoice`, `consumesRound`, and
  `tool_evidence_fallback` closeout hook shapes.
- natural-finish repair cascade precedence and application now route through a
  single `RepairPolicyRegistry` entrypoint; the adapter passes the hook inputs
  instead of selecting and applying each repair policy window.
- completed synthesis repair precedence is pinned in
  `ENGINE_COMPLETED_SYNTHESIS_REPAIR_POLICY_ORDER`.
- completed-closeout timeout follow-up final-guidance repair selection routes
  through `RepairPolicyRegistry`, using the completed product-brief evidence
  formula.
- completed-closeout missing requested next-action repair selection routes
  through `RepairPolicyRegistry`.
- completed-closeout missing required final deliverable repair selection routes
  through `RepairPolicyRegistry`, using completed-session evidence.
- completed-closeout missing browser evidence-dimension repair selection routes
  through `RepairPolicyRegistry`, preserving the final-content gate.
- completed-closeout false evidence-blocked repair selection routes through
  `RepairPolicyRegistry`, preserving completed final-content prompt evidence.
- completed-session repair loop orchestration routes through
  `CompletedCloseoutController`, including bounded repair rounds, repair marker
  insertion, forced real-tool re-arm message construction, and clean synthesis
  cleanup when a repair returns tool-call artifact text.
- completed terminal synthesis orchestration routes through
  `CompletedCloseoutController.synthesizeTerminalCloseout`, including completed
  evidence-text assembly, initial/repair memory-flush ordering, completed repair
  loop invocation, completed visibility finalization, and the re-arm/final
  result boundary while the adapter injects model calls. Terminal run-state
  effects for final/re-arm completion now apply through
  `TerminalCloseoutController`.
- completed-closeout post-synthesis visibility routes through
  `CompletedCloseoutController`, preserving the original browser recovery,
  browser failure-bucket, recovered-timeout/continuation, and forbidden local
  URL redaction order.
- natural-finish evidence formula construction for extracted repair
  policies/controllers routes through `EvidenceLedger` snapshots.
- engine terminal/error/finalization paths now read tool-trace result content
  and usable-evidence truth from `EvidenceLedger` snapshots instead of calling
  the raw evidence helpers directly.
- engine timeout-probe and completed terminal-synthesis handoffs now read
  current-round tool-result content through `EvidenceLedger` instead of calling
  the raw result-content collector directly.
- engine hard approval wait-timeout fallback now reads approval runtime
  evidence through `EvidenceLedger` and assembles its deterministic fallback
  result through `TerminalCloseoutController`; model-call-error local evidence
  fallback gating, local evidence answer construction, and
  `tool_evidence_fallback` metadata/redaction now run through that same
  controller.
- engine continuation and post-execute closeout hooks now read current
  completed-session and sub-agent timeout result signals through
  `EvidenceLedger`.
- model-call-error abort handling, forced pending-approval `permission_result`
  continuation selection, and local evidence fallback selection route through
  `TerminalCloseoutController`; hook-result application and raw forced-round
  result trimming now also route through the controller, while the adapter
  supplies only the forced tool-round executor callback.
- final allowed tool-round warning injection routes through
  `ExecutionBudgetController.applyFinalToolRoundWarning` while sharing the inline
  message transform.
- final-recovery budget parsing/counting and repair prompt text now live in
  neutral shared code instead of adapter-local helper functions.
- empty-round continuation preview, injection, and hook-result application route through
  `ContinuationController`, covering direct `sessions_send` and lookup
  `sessions_list` precedence, plus injected-call versus terminate ReAct
  decisions.
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
  continuation and model-call-error continuation before evidence fallback; the
  post-execute forced-round hook application now also routes through that
  controller with only an adapter-supplied executor callback.
- post-execute missing approval-gate repair continuation routes through
  `ContinuationController`, returning the repair marker as typed action data while
  the adapter applies it to the idempotency ledger.
- post-execute `continue` action hook-result application now routes through
  `ContinuationController`, covering timeout continuations/probes, incomplete
  approved-browser continuation, independent evidence-stream continuation, and
  missing approval-gate repair marker recording through an adapter callback.
- post-execute continuation cascade precedence and application now route through
  a single `ContinuationController` entrypoint; the adapter supplies only
  evidence facts, repair-marker storage, and the forced-round executor.
- completed product-signal dashboard URL extraction now lives in neutral shared
  code, removing the adapter-local duplicate dashboard regex tail.
- browser/product-signal missing evidence repair detectors and repair prompt
  builders now live in neutral shared code; their natural-finish hook-result
  application now routes through `RepairPolicyRegistry` at the original
  precedence points.
- missing browser/product-signal evidence natural-finish repair decisions now
  route through `RepairPolicyRegistry`; the registry applies the returned prompt,
  `sessions_spawn` force choice, and consumed-round flag.
- completed-closeout browser/product-signal re-arm decisions now run inside
  `CompletedCloseoutController` through `RepairPolicyRegistry`; the adapter
  passes tools/evidence and no longer injects a predicate closure.
- completed-closeout source-evidence carry-forward and weak-evidence synthesis
  repair decisions now route through `RepairPolicyRegistry` using the
  controller's selected evidence formula text.

## Remaining Work

Continue with the remaining high-risk pieces:

- continue expanding the evidence ledger beyond the current source/completed
  evidence, current-result-content, current result signals,
  approval-timeout-runtime evidence, tool-trace-result-content, and
  usable-evidence snapshot facts; continue thinning terminal closeout gateway
  callback wiring beyond the current deterministic/generic/model-error fallback
  application, synthesis-context selection, synthesis invocation,
  synthesis-effect application, final response shaping, closeout write-mode
  selection, explicit state-effect application, sticky completed closeout
  pre-recording, completed initial-synthesis handoff, terminal path selection,
  final/re-arm application, terminal entrypoint, terminal hook fallback entry,
  and model-error fallback / flow-selection / hook-application /
  forced-round-result boundary slices; keep thinning the adapter.

The branch is **not pushed**.
