# Stage 8 Engine Cleanup — Campaign Progress Report

**Branch:** `feat/stage8-engine-cleanup`
**Code HEAD before this docs-only report:** `e84b1103674df1bbec3f20643c76f31777537f94`
**Date:** 2026-07-03

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
  shaping. The engine `onBeforeExecute` and `runToolBatch` hook entrypoints now
  delegate through that controller instead of wiring budget calls inline in the
  adapter. Budget closeout snapshots for final-recovery exhaustion, wall-clock
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
  the run-state target. The pending-call closeout hook flow now enters through
  `CloseoutPolicyRegistry.applyPendingCallsCloseoutHook()`: the registry owns
  active-loop gating, used-call/evidence snapshot calculation, read-only
  suppression pre-emption, recovery-budget-before-continuation ordering,
  empty-round continuation preview handoff, budget callback wiring, and the
  remaining pending-call closeout cascade, while the adapter supplies only live
  state and module-owned collaborators. The suppress-tool-calls hook now passes
  active state into `PermissionPolicy`, and the round-empty hook now enters
  through `ContinuationController.applyRoundEmptyHook()`. The post-execute
  closeout hook now also enters through
  `CloseoutPolicyRegistry.applyPostExecuteCloseoutHook()`, so current-round
  evidence lookup, completed-vs-timeout selection, and state writes are one
  registry-owned application boundary. The natural-finish repair hook now
  enters through `RepairPolicyRegistry.applyNaturalFinishRepairHook()`, so
  active-loop gating, repair-marker persistence, and final-recovery budget
  accounting are registry-owned.
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
  Terminal final synthesis provider-schema repair selection now also enters
  through `TerminalCloseoutController`, which delegates to the registry using a
  single-policy window before the adapter performs the gateway repair retry.
  Provider-schema repair request construction now also lives in that
  controller, and the tool-call artifact cleanup request/completion path now
  routes through the same controller boundary; the adapter keeps the gateway
  call/pruning side effects but no longer owns those final-synthesis repair
  decisions or message arrays. Initial final-synthesis source-message
  construction, gateway-history preparation, and pruning summary construction
  now also route through the controller; the adapter records the controller
  snapshot and invokes the gateway. The full final-after-tool-round-limit
  orchestration now also lives in the controller: initial synthesis,
  provider-schema retry selection, tool-call artifact cleanup retry,
  repair-over-initial merge precedence, and gateway-error local fallback now
  run through a single controller entrypoint with adapter-provided gateway and
  pruning callbacks. Tool-free gateway input construction for that final
  synthesis path now also happens inside the controller, so the adapter callback
  receives a ready `GenerateTextInput`.
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
  terminal/model-error/finalization paths, so those adapter paths no longer call
  the raw evidence helpers directly. Current-round tool-result content text is now
  also exposed through the ledger for the engine timeout-probe and completed
  terminal-synthesis handoffs, and current-round completed-session / sub-agent
  timeout signals are now read through the ledger in engine continuation and
  post-execute closeout hooks. Those current-round facts now travel as a single
  `EvidenceLedger.currentRound()` snapshot for continuation and post-execute
  closeout hook handoffs instead of adapter-local per-fact reads. The
  per-engine-run evidence snapshot binding now also lives in
  `EvidenceLedger.forRun()`, so pending closeout, terminate, model-error, and
  finalization epilogue paths share one ledger-owned run snapshotter instead of
  an adapter-local `snapshotEvidence` closure.
  Provider tool-protocol round recording for the normal post-execute engine hook
  now also routes through `EngineRunObserver.onProviderToolProtocolRound()`; the
  adapter injects the existing safe recorder instead of calling it directly from
  `onAfterExecuteContinue`. Forced runtime tool-round provider protocol
  recording now uses the same observer boundary on engine paths, while the
  legacy inline/no-observer path keeps the existing safe recorder fallback.
  Forced runtime tool rounds now also delegate their engine-path native
  trace/progress snapshot persistence, assistant/tool message append, and
  provider protocol handoff to
  `EngineRunObserver.observeRuntimeForcedToolRound()`; the adapter supplies the
  actual tool-execution callback.
  Request-envelope overflow retry orchestration now lives in neutral
  `gateway-envelope-retry.ts`; the adapter injects the gateway, clock, and
  pre-compaction memory flusher while the owner keeps overflow detection,
  memory-flush handoff, reduced retry sequencing, and model-call trace recording.
  Terminal final synthesis gateway/pruning/retry callback wiring now lives in
  neutral `terminal-final-synthesis.ts`; inline and engine closeout paths call
  that helper instead of the adapter keeping a private final-synthesis method.
  The repeated inline/engine dependency-injection callback shape now also lives
  in that owner as `createTerminalFinalSynthesisRunner()`.
  Engine model-client wrapper behavior now lives in
  `react-engine/engine-model-client.ts`: final-round warning application,
  tool-round gateway request construction, role-runtime pruning boundary wiring,
  envelope retry invocation, last model result capture, and reduction/memory
  state writes.
  Engine forced runtime tool-round runner wiring now lives in
  `react-engine/engine-forced-tool-round-runner.ts`: the owner now binds the
  role-runtime provider recorder selection, native persistence, clock, defer
  mode, observer, and signal once, and the continuation/model-error hooks pass
  only messages, tool calls, and assistant text into it.
  Engine final response assembly now lives in
  `react-engine/engine-final-response.ts`: finalization epilogue application,
  final content/mention extraction, model metadata selection, tool/model-use
  metadata, reduction/memory closeout metadata, request-envelope reduction
  boundary recording, mission report construction, and debug-only policy trace
  exposure are handled by the react-engine owner.
  Engine agent event consumption now lives in
  `react-engine/engine-agent-runner.ts`: the owner creates the ReAct agent,
  applies the boundary-round `maxRounds + 1` adjustment, consumes
  model/tool/final events, dispatches the engine observer callbacks, and returns
  the selected final text.
  Engine role toolkit wiring now lives in
  `react-engine/engine-role-toolkit.ts`: the owner exposes the filtered tool
  definitions, `has()` lookup, active tool-loop execution delegation, and
  no-active-loop unknown-tool fallback used by the ReAct agent.
  Role-engine run-state value typing now also lives in
  `react-engine/engine-run-state.ts`: the adapter calls
  `createRoleEngineRunState()` instead of declaring the role-runtime state value
  map locally inside `runViaReActEngine`.
  Engine run observer dependency wiring now also lives in
  `react-engine/engine-run-observer.ts`: the adapter calls
  `createRoleEngineRunObserver()` instead of declaring tool-progress,
  provider-protocol, and native-trace persistence callbacks inline inside
  `runViaReActEngine`.
  The full `onAfterExecuteContinue` hook flow now enters through
  `ContinuationController.applyAfterExecuteContinuationHook()`: the controller
  owns provider tool-protocol round recording before current-round evidence
  snapshotting and the post-execute continuation cascade. The adapter passes the
  observer, ledger, hook state, and forced-round executor.
  Engine tool-call normalization context construction now lives in
  `react-engine/tool-call-normalizer.ts`: continuation context/directives,
  continuation lookup directives, and browser/explore worker availability are
  built by the normalizer owner from task, message, trace, repair-marker, and
  capability inputs instead of being assembled in the adapter.
  Read-only permission-query suppression context construction now lives in
  `react-engine/permission-policy.ts`; the adapter passes calls/task/messages
  for the pending-closeout pre-emption guard. The full `onSuppressToolCalls`
  hook flow now also enters through
  `PermissionPolicy.applySuppressToolCallsHook()`, which owns read-only
  permission-query pre-emption before awaiting-context setup-only no-tool
  suppression; the adapter passes only calls, task, messages, last text, and the
  repair-marker ledger.
  Completed-closeout synthesis callback construction now lives in
  `TerminalCloseoutController.handleTerminalCloseoutHook()`: the controller
  builds the completed callback from the terminate hook input, carries current
  messages into `CompletedCloseoutController`, asks the evidence ledger for
  completed tool-result text, and preserves the adapter-injected gateway repair
  callbacks. The controller now also owns completed-closeout repair gateway
  message preparation and tool-free gateway input construction; the adapter
  passes the base gateway input and receives a ready `GenerateTextInput`.
  The completed-reason and missing-session guards now also live in that
  controller path, so the adapter passes the completed-closeout handoff data
  unconditionally instead of branching on reason/session.
  Remaining pending-call closeout session context construction now lives in
  `react-engine/closeout-policy-registry.ts`; the adapter passes task/messages
  instead of concatenating the closeout session context locally.
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
  active/usable-evidence gating, forced pending-approval `permission_result`,
  fallback/rethrow selection, and hook-result application live in the
  controller's lower-level `completeModelCallErrorFlow()` path. The full
  `onModelCallError` hook now enters through
  `TerminalCloseoutController.completeModelCallErrorHook()`: the controller owns
  abort classification, non-abort final-message capture, ledger evidence
  snapshotting, tool-call accounting, forced permission-result flow selection,
  and hook-result application. The adapter supplies only the forced-result
  builder callback and forced-round executor. Final-synthesis tool-call artifact
  fallback result
  construction after a failed cleanup repair now also lives in
  `TerminalCloseoutController`, including local evidence fallback, generic
  fallback text, and URL redaction. Final-synthesis repair effect merging now
  also lives there, preserving repair-over-initial precedence for result,
  reduction, reduction snapshot, and memory flush metadata. Final-synthesis
  model-error fallback after gateway failure now also routes through the
  controller for local evidence fallback and URL redaction. The model-call-error
  usable-evidence read now also routes through `EvidenceLedger.snapshot()`.
  Terminal terminate decision input assembly now enters through
  `CloseoutPolicyRegistry.evaluateTerminateHook()`: the registry owns
  pending/completed/timeout state reads, run-evidence snapshotting, native
  tool-call and round accounting, round-limit budget snapshot callback wiring,
  and the approval wait-timeout fallback payload while the adapter passes only
  live run state, evidence, and budget collaborators.
  Completed terminal handoff assembly now also lives in
  `TerminalCloseoutController.handleTerminalCloseoutHook()`: the controller
  reads completed session/tool-result state, initializes the repair-marker
  ledger, and normalizes the completed-closeout input before building the
  completed synthesis callback.
  Terminal synthesis callback wiring now also lives in that controller: it
  binds max-round and reason-line handoff for terminal final synthesis and
  builds the completed tool-call artifact cleanup callback, while the adapter
  supplies only the final-synthesis runner.
  Approval wait-timeout fallback hook input gating and deterministic fallback
  error construction now also live in that controller, so `onTerminate` no
  longer branches on `tool_evidence_fallback` or assembles that fallback payload
  inline.
  Terminal final synthesis provider-schema repair selection now also routes
  through the controller-owned repair-policy window, so the adapter no longer
  evaluates the registry directly for that final retry decision.
  The same controller now owns final-synthesis provider-schema repair request
  construction, tool-call artifact cleanup request construction, and
  post-repair tool-call fallback/merge completion; the adapter supplies the
  gateway callback inputs and records pruning only.
  It also now owns final-synthesis gateway request preparation for initial and
  repair synthesis: source messages, pruned gateway messages, and pruning
  summaries are returned as typed controller requests.
  The full final-after-tool-round-limit synthesis sequence now enters through
  `TerminalCloseoutController.synthesizeFinalAfterToolRoundLimit()`, leaving the
  adapter to supply only a gateway callback and pruning recorder. The controller
  now builds the tool-free gateway input before invoking that callback.
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
  carrying duplicate helper copies. Read-only permission-query suppression and
  awaiting-context setup-only no-tool suppression now compose inside
  `PermissionPolicy.applySuppressToolCallsHook()` for the engine suppress hook;
  the adapter supplies only hook state.
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
  controller; the after-execute hook entrypoint additionally owns provider
  protocol recording and current-round evidence snapshotting before the cascade,
  while the adapter supplies the observer, ledger, hook state, and forced-round
  executor.
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
  `tool-history-pruning.ts`, including the runtime boundary recorder that emits
  pruning metadata for inline, engine, and final-synthesis gateway calls.
  Provider tool protocol boundary recording now also lives there, so inline and
  engine use the same neutral `provider_tool_protocol_round` runtime progress
  metadata construction. The forced runtime tool-round no-observer fallback now
  also routes through a `tool-history-pruning.ts` owner wrapper instead of an
  adapter-private provider-protocol helper.
  Tool-definition filtering for permission tools, task-tracking tools, and
  focused durable-memory recall now lives in neutral `tool-definition-filter.ts`.
  Model-call boundary trace construction and model-use summary aggregation now
  live in neutral `model-call-trace.ts`.
  Gateway input construction, final synthesis format-contract lines, no-tool
  gateway transforms, mention extraction, and requested three-line label
  normalization now live in neutral `gateway-input-builder.ts`; request-envelope
  reduced prompt replacement now lives there too. Tool-free gateway input
  construction now also lives there, including tool stripping, message
  replacement, and tool-result envelope recomputation for inline and engine
  final/repair synthesis paths. Tool-round gateway request construction now also
  lives there: active/tool-free request shaping, gateway-history preparation,
  pruning snapshots, and envelope recomputation share one neutral builder for
  inline and engine model rounds. Request-envelope reduced retry gateway input
  construction now also lives there, so prompt-message replacement and retry
  envelope recomputation are no longer adapter-local. Final synthesis
  source-message construction, extraneous provider-schema repair-message
  construction, and tool-call artifact cleanup repair-message construction now
  also live there, so terminal final synthesis and cleanup repair share the
  neutral owner instead of adapter-local message arrays.
  Session trace canonicalization from structured session results, native
  tool-call counting, and native tool-message persistence safe/defer handling
  now live in `native-tool-messages.ts`.
  Shared JSON object parsing and the stable `AbortError` guard now live in
  neutral `tool-loop-shared.ts`.
  Request-envelope reduction boundary recording now lives in
  `request-envelope-reducer.ts`, so the adapter no longer owns
  `request_envelope_reduction` runtime progress metadata construction.
  Pre-compaction memory flush safe handling now lives in
  `pre-compaction-memory-flusher.ts`; the adapter passes the configured flusher,
  model selection, and overflow diagnostics instead of owning the wrapper.
  Prompt assembly compaction boundary recording now lives in `prompt-policy.ts`,
  so the adapter no longer owns `prompt_compaction` runtime progress metadata
  construction.
  Runtime tool-progress safe recording and observer emission now live in
  `tool-use.ts`; the adapter passes the selected recorder, defer mode, and
  observer callback instead of owning that wrapper. Role tool-call execution now
  also lives in `tool-use.ts`, including lifecycle progress emission,
  serial/concurrent chunking, wall-clock execution signals, non-abort tool error
  shaping, and over-cap skipped results. Forced runtime tool-round orchestration
  now also lives in `tool-use.ts`, including observer delegation, native trace
  updates, assistant/tool message append, and provider-protocol handoff through
  injected persistence/recorder callbacks.
  Runtime-derived mission terminal reports now live in
  `runtime-derived-mission-report.ts`, and the supplemental browser-probe
  capability check now lives in neutral `tool-loop-shared.ts`.
  Wall-clock closeout signal construction, including the `onToolCallsClose`
  selection between native pending calls and synthetic empty-round continuation
  calls, now lives in `react-engine/execution-budget-controller.ts`, leaving
  the adapter to pass hook state into the controller instead of carrying a
  local budget-signal closure.
  The engine policy-trace debug env gate now lives with the policy-trace owner
  in `react-engine/policy-trace.ts` instead of as an adapter-local helper.
  Tool-result evidence collectors for completed sessions, timeout signals,
  session history evidence, tool-result text, tool-trace text, resumable partial
  sessions, and usable-evidence detection now live in neutral
  `tool-result-evidence.ts`.

The Stage 8 cleanup has reached the current landing line: `runViaReActEngine` is now
acceptable as a composition/wiring layer for the installed ReAct hooks. It still
owns dependency construction, live state threading, feature flags, injected
gateway/forced-round execution callbacks, and final `GeneratedRoleReply`
assembly, but product-policy decisions for installed hooks now route through
the owning modules. The remaining work is typed-facts / legacy-detector debt,
not additional adapter line-count reduction.

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
| `3707df8` | Route current-round tool-result content, completed-session signal, and timeout signal through one `EvidenceLedger.currentRound()` snapshot for continuation and post-execute closeout hook handoffs. |
| `3c97ab8` | Route provider tool-protocol round recording for the normal post-execute engine hook through `EngineRunObserver`; adapter injects the existing safe recorder. |
| `4ed66d7` | Route forced runtime tool-round provider protocol recording through `EngineRunObserver` on engine paths; keep the legacy safe-recorder fallback for no-observer paths. |
| `6e0a4cc` | Move forced runtime tool-round native trace persistence, message append, and provider handoff into `EngineRunObserver`; adapter supplies only the executor callback on engine paths. |
| `027961f` | Move engine tool-call normalizer context construction into `ToolCallNormalizer`; adapter passes only task/message/trace/repair/capability inputs. |
| `929d5d9` | Move read-only permission suppression context construction into `PermissionPolicy`; adapter passes calls/task/messages. |
| `75ed47e` | Move remaining pending-call closeout session context construction into `CloseoutPolicyRegistry`; adapter passes task/messages. |
| `1e0743c` | Move pending-call wall-clock closeout signal selection into `ExecutionBudgetController`; adapter passes native pending calls plus optional empty-round continuation. |
| `ef56638` | Move the full pending-call closeout hook flow into `CloseoutPolicyRegistry.applyPendingCallsCloseout`; adapter supplies callbacks/state instead of stitching the closeout windows locally. |
| `38a7a56` | Move model-call-error forced pending-approval flow selection into `TerminalCloseoutController.completeModelCallErrorFlow`; route model-error usable-evidence through `EvidenceLedger.snapshot()`. |
| `d2afbb1` | Add `EvidenceLedger.forRun()` and route engine run evidence snapshots through the ledger-owned run snapshotter instead of an adapter-local closure. |
| `84b1ae9` | Move the full `onSuppressToolCalls` read-only / awaiting-context suppression flow into `PermissionPolicy.applySuppressToolCallsHook`; update the hook contract and policy-trace golden. |
| `58624f9` | Move the full `onAfterExecuteContinue` observer / current-round evidence / continuation cascade flow into `ContinuationController.applyAfterExecuteContinuationHook`; update the hook contract and policy-trace golden. |
| `ecc9aa3` | Move completed-closeout synthesis callback construction into `TerminalCloseoutController.handleTerminalCloseoutHook`; adapter supplies completed controller, ledger, and gateway callbacks. |
| `1b3f511` | Move completed-closeout reason/null-session guards into `TerminalCloseoutController`; adapter passes completed-closeout handoff data unconditionally. |
| `a0acc56` | Centralize tool-free gateway input construction in `gateway-input-builder`; adapter reuses it for inline/engine no-tool rounds and terminal final/repair synthesis. |
| `37abf6c` | Centralize final synthesis source-message and tool-call artifact cleanup repair-message construction in `gateway-input-builder`; adapter reuses the neutral builder for terminal final/repair synthesis. |
| `a1d8228` | Centralize extraneous provider-schema repair-message construction in `gateway-input-builder`; terminal final synthesis no longer builds that repair message array in the adapter. |
| `2e4c312` | Route terminal final synthesis provider-schema repair selection through `RepairPolicyRegistry`; add an architecture guard against direct predicate drift. |
| `047befd` | Move final-synthesis tool-call artifact fallback result construction into `TerminalCloseoutController`; adapter delegates the local/generic fallback shaping. |
| `4b6eb72` | Move final-synthesis repair effect merging into `TerminalCloseoutController`; adapter delegates repair-over-initial reduction and memory-flush precedence. |
| `59d1e19` | Move final-synthesis gateway-error local evidence fallback construction into `TerminalCloseoutController`; adapter rethrows only when no local fallback exists. |
| `460d460` | Move terminal final synthesis provider-schema repair selection into `TerminalCloseoutController`; adapter no longer evaluates the repair registry directly for that retry decision. |
| `516a007` | Move terminal final synthesis provider-schema and tool-call artifact repair request/completion ownership into `TerminalCloseoutController`; adapter keeps only gateway/pruning side effects. |
| `da72abf` | Move terminal final synthesis gateway message preparation and pruning snapshots into `TerminalCloseoutController`; adapter records the snapshot and calls the gateway. |
| `f5292d5` | Move final-after-tool-round-limit synthesis orchestration into `TerminalCloseoutController`; adapter supplies only gateway and pruning callbacks. |
| `d42e6c7` | Move final-after-tool-round-limit tool-free gateway input construction into `TerminalCloseoutController`; adapter receives a ready gateway input. |
| `bf7e3f1` | Move completed-closeout repair gateway-message preparation and tool-free gateway input construction into `TerminalCloseoutController`; adapter receives a ready gateway input. |
| `8ea3070` | Centralize tool-round gateway request construction in `gateway-input-builder`; inline and engine model rounds share neutral history preparation, pruning snapshots, tool-free shaping, and envelope recomputation. |
| `4b7772f` | Move tool-result pruning boundary recording into neutral `tool-history-pruning.ts`; adapter passes activation/selection/recorder instead of owning runtime progress metadata construction. |
| `f532943` | Centralize request-envelope reduced retry gateway input construction in `gateway-input-builder`; adapter no longer hand-builds reduced prompt replacement or retry envelope recomputation. |
| `4073d09` | Move request-envelope reduction boundary recording into `request-envelope-reducer.ts`; adapter passes activation/packet/selection/recorder instead of owning runtime progress metadata construction. |
| `1655a09` | Move prompt assembly compaction boundary recording into `prompt-policy.ts`; adapter passes activation/packet/selection/recorder instead of owning runtime progress metadata construction. |
| `7baee8b` | Move provider tool protocol boundary recording into `tool-history-pruning.ts`; inline and engine pass recorder/clock/defer inputs instead of owning runtime progress metadata construction in the adapter. |
| `f36fb67` | Move runtime tool-progress safe recording into `tool-use.ts`; adapter passes recorder/defer inputs instead of owning the safe recorder wrapper. |
| `6d06ac0` | Move native tool trace persistence into `native-tool-messages.ts`; adapter passes store/clock/defer inputs instead of owning the safe persister wrapper. |
| `ca2e7e8` | Move runtime tool-progress observer emission into `tool-use.ts`; adapter passes recorder/defer/observer inputs instead of owning the safe emitter wrapper. |
| `1732722` | Move forced runtime provider-protocol fallback recording into `tool-history-pruning.ts`; adapter passes recorder/clock/defer inputs instead of owning the private wrapper. |
| `5193d4f` | Move pre-compaction memory flush safety into `pre-compaction-memory-flusher.ts`; adapter passes flusher/selection/diagnostics instead of owning the safe wrapper. |
| `e44d4af` | Move role tool-call execution into `tool-use.ts`; adapter passes tool-loop/recorder/clock inputs instead of owning the private execution runner. |
| `d1bee4c` | Move forced runtime tool-round orchestration into `tool-use.ts`; adapter passes persistence/provider callbacks instead of owning the private forced-round runner. |
| `fdc8136` | Move request-envelope overflow retry orchestration into neutral `gateway-envelope-retry.ts`; adapter injects gateway/clock/flusher instead of owning the private retry method. |
| `73e36ca` | Move terminal final-synthesis gateway wrapper into neutral `terminal-final-synthesis.ts`; adapter call sites inject through local composition callbacks instead of a private method. |
| `014abe7` | Centralize terminal final-synthesis runner wiring in `terminal-final-synthesis.ts`; adapter creates shared runners instead of declaring duplicate inline/engine injection types. |
| `04be9f8` | Move the engine `ModelClient` wrapper into `react-engine/engine-model-client.ts`; adapter passes dependencies and consumes the owner model/last-result boundary. |
| `e12c9ba` | Centralize engine forced runtime tool-round runner wiring in `react-engine/engine-forced-tool-round-runner.ts`; adapter reuses one runner from continuation and model-error hooks. |
| `239395c` | Move engine final response assembly into `react-engine/engine-final-response.ts`; adapter passes final run-state snapshots into the owner builder. |
| `f918140` | Move engine ReAct event consumption into `react-engine/engine-agent-runner.ts`; adapter receives final text from the owner runner. |
| `cfb2fde` | Move engine role toolkit wiring into `react-engine/engine-role-toolkit.ts`; adapter passes tool definitions and active loop into the owner. |
| `5178973` | Move role-engine run-state value typing/factory into `react-engine/engine-run-state.ts`; adapter calls `createRoleEngineRunState()`. |
| `1de02ca` | Move engine run observer dependency wiring into `react-engine/engine-run-observer.ts`; adapter calls `createRoleEngineRunObserver()`. |
| `75e6e08` | Move engine model client dependency wiring into `react-engine/engine-model-client.ts`; adapter calls `createRoleEngineModelClient()`. |
| `e0c356e` | Move engine forced-round runner dependency wiring into `react-engine/engine-forced-tool-round-runner.ts`; adapter calls `createRoleEngineRuntimeForcedToolRoundRunner()`. |
| `3aaecb7` | Move engine ReAct agent creation and boundary-round adjustment into `react-engine/engine-agent-runner.ts`; adapter calls `createRoleEngineAgentRunner()`. |
| `acba8b6` | Move engine request-envelope reduction boundary wiring into `react-engine/engine-final-response.ts`; adapter calls `recordEngineReductionBoundary()`. |
| `e2d2907` | Move the engine `onToolCalls` hook flow into `react-engine/tool-call-normalizer.ts`; adapter delegates normalization context construction and recovery-budget truncation. |
| `14a7aa9` | Move the engine `onBeforeExecute` and `runToolBatch` hook wiring into `ExecutionBudgetController`; adapter delegates admission and role tool-batch execution entrypoints. |
| `aa6d0d8` | Move engine pending-call closeout hook wiring into `CloseoutPolicyRegistry`; adapter delegates used-call/evidence calculation and budget/continuation callback assembly. |
| `679dc2f` | Move lightweight suppress, post-execute, and round-empty hook entrypoints into their existing owners; update hook contract/golden names. |
| `d3c0ed6` | Move natural-finish repair hook wiring into `RepairPolicyRegistry`; adapter delegates active gating, marker ledger persistence, and recovery-budget accounting. |
| `e84b9c0` | Move model-call-error hook wiring into `TerminalCloseoutController`; adapter delegates abort classification, evidence snapshotting, tool-count accounting, forced-permission flow selection, and hook-result application. |
| `97e9ab5` | Move terminate closeout hook input assembly into `CloseoutPolicyRegistry`; adapter delegates state/evidence reads, tool-count accounting, round-limit budget callback wiring, and approval wait-timeout fallback payload construction. |
| `94797c7` | Move completed terminal handoff wiring into `TerminalCloseoutController`; adapter delegates completed-session/tool-result reads and repair-marker ledger initialization. |
| `0346647` | Move terminal synthesis callback wiring into `TerminalCloseoutController`; adapter delegates reason-line/max-round final-synthesis and completed cleanup callback adaptation. |
| `e84b110` | Move approval wait-timeout fallback hook input gating and deterministic fallback error construction into `TerminalCloseoutController`; adapter delegates the optional hook payload. |

## Current Extracted Implementation

Real implementation now exists in:

- `react-engine/types.ts`
- `react-engine/engine-run-state.ts` for generic engine run state plus the
  role-runtime-specific run-state value map and `createRoleEngineRunState()`
  factory used by `runViaReActEngine`.
- `react-engine/policy-trace.ts` for trace recording, the no-op trace, and the
  engine policy-trace debug env gate.
- `react-engine/hook-policy-trace.ts`
- `react-engine/hook-orchestration-contract.ts`
- `react-engine/policy-trace-characterization.ts`
- `react-engine/tool-call-normalizer.ts` for engine tool-call normalization
  order/pipeline and live normalization context construction, including session
  continuation context/directive resolution, continuation lookup directive
  resolution, browser/explore worker availability derivation, and the full
  `onToolCalls` hook flow that normalizes before applying final-recovery
  budget truncation.
- `react-engine/permission-policy.ts` for approval-gate normalization,
  read-only permission-query suppression selection, and read-only suppression
  context construction / hook-result application, plus the
  `onSuppressToolCalls` hook entrypoint that applies read-only permission-query
  pre-emption before awaiting-context setup-only no-tool suppression, including
  active-loop and empty-call gating.
- `react-engine/finalization-pipeline.ts`
- `react-engine/engine-run-observer.ts` for model/tool lifecycle observation,
  runtime progress/native trace persistence, and normal post-execute plus
  forced runtime tool-round provider tool-protocol round recording through an
  injected recorder, plus engine-path forced runtime tool-round native
  trace/progress snapshot persistence and assistant/tool message append through
  an injected executor callback; it now also owns role-engine observer
  dependency wiring through `createRoleEngineRunObserver()`, including recorder
  selection, native tool-message store persistence, clock, defer mode, and
  activation binding.
- `react-engine/execution-budget-controller.ts` for final tool-round warning,
  final-recovery truncation, per-round tool-call admission, and engine tool-batch
  execution, plus budget closeout snapshot construction for recovery-budget,
  wall-clock, and round-limit terminal synthesis, plus wall-clock closeout
  signal construction for `onToolCallsClose`, including native pending-call vs
  synthetic empty-round continuation selection, plus the engine
  `onBeforeExecute` and `runToolBatch` hook entrypoints used by
  `runViaReActEngine`.
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
  state-effect application through injected targets, including the single
  `onToolCallsClose` pending-call flow entrypoint that owns read-only
  suppression pre-emption, recovery-budget-before-continuation ordering,
  empty-round continuation preview handoff, wall-clock signal handoff,
  used-call/evidence snapshot calculation, budget callback wiring, remaining
  pending-call closeout evaluation/application, and remaining pending-call
  closeout session context construction, plus the post-execute closeout
  hook entrypoint that owns current-round evidence lookup before applying the
  completed/timeout closeout decision, plus the terminal `onTerminate` decision
  hook entrypoint that owns pending/completed/timeout state reads, run-evidence
  snapshotting, native tool-call/round accounting, round-limit budget snapshot
  callback wiring, and approval wait-timeout fallback payload construction.
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
  registry entrypoint, plus the `onRepairRound` hook entrypoint that owns
  active-loop gating, repair-marker persistence, and final-recovery budget
  accounting, plus
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
  fallback before synthesis and builds completed-closeout synthesis callbacks
  from completed session / ledger inputs, including completed reason and
  null-session guards and completed-closeout repair tool-free gateway input
  construction, plus completed terminal hook handoff assembly for completed
  session/tool-result state reads and repair-marker initialization, plus
  terminal synthesis callback builders for reason-line/max-round final-synthesis
  and completed tool-call artifact cleanup handoffs, plus the model-call-error
  local-evidence
  fallback/rethrow boundary and `completeModelCallErrorHook()` ownership of
  model-call-error abort classification, final-message capture, ledger
  snapshotting, tool-call accounting, active/usable-evidence gating, forced
  pending-approval continuation selection, fallback flow selection, and
  hook-result application through injected forced-result builder /
  forced-round executor callbacks, including raw forced-round execution result
  trimming through the lower-level `completeModelCallErrorFlow()` path, plus
  terminal final synthesis provider-schema repair selection
  through a controller-owned `RepairPolicyRegistry` single-policy window, plus
  terminal final synthesis provider-schema repair request construction,
  tool-call artifact cleanup request construction, and post-repair tool-call
  fallback/merge completion, plus typed initial/repair gateway request
  preparation with source messages, pruned gateway messages, and pruning
  snapshots, plus the full final-after-tool-round-limit synthesis orchestration
  through `synthesizeFinalAfterToolRoundLimit()` with injected gateway/pruning
  callbacks, including controller-owned tool-free gateway input construction for
  the injected gateway callback.
- `react-engine/evidence-ledger.ts` for the first behavior-neutral
  `EvidenceSnapshot` facade over source-bounded evidence, completed-session
  evidence, current tool-result content, current completed-session and timeout
  result signals, tool-trace result content, approval wait-timeout runtime
  evidence, usable-evidence truth, and the natural-finish evidence formula
  consumed by extracted repair policies/controllers and engine continuation,
  terminal, model-error, and finalization paths, plus a current-round evidence
  snapshot used by continuation and post-execute closeout hook handoffs, plus
  `forRun()` snapshot binding for per-engine-run evidence reads.
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
  precedence/application through one controller entrypoint, plus the round-empty
  hook entrypoint that owns action selection and hook-decision application, plus
  the full
  `onAfterExecuteContinue` hook entrypoint that records provider protocol
  rounds, reads the current-round evidence snapshot, and then applies the
  cascade.
- `task-facts-shared.ts` for the neutral `TaskFactsSnapshot` producer:
  requested table-column inference, provider-support-schema request detection,
  browser-visible evidence intent, product-signal dashboard evidence intent,
  timeout-recovery intent, awaiting-context setup-only intent, and required
  independent evidence-stream count. It also owns markdown table header
  matching, provider search/pricing evidence-column inference,
  provider-support-schema result detection, missing requested-column repair
  helpers, extraneous provider-schema repair helpers, awaiting-context
  setup-only no-tool suppression and hook-result application, and repair marker
  insertion used by the adapter, repair registry, and completed-closeout
  controller.
- `react-engine/task-facts.ts` as a compatibility wrapper around the neutral
  TaskFacts implementation for engine import sites.
- `tool-history-pruning.ts` for request-envelope tool-result pruning, older
  tool-history compaction, tool-result envelope accounting, pruning trace
  snapshots, assistant/tool block indexing helpers, and runtime pruning boundary
  progress recording, plus provider tool protocol boundary progress recording
  and the forced runtime tool-round provider-protocol fallback wrapper.
- `tool-definition-filter.ts` for permission-tool suppression, source-check
  task-tracking suppression, focused durable-memory recall narrowing, and
  tool-definition filter prompt/message context construction.
- `model-call-trace.ts` for model-call boundary trace construction, tool-choice
  trace formatting, request-envelope reduction metadata capture, and model-use
  token summary aggregation.
- `request-envelope-reducer.ts` for prompt packet reduction levels/results,
  reduction snapshot typing, and request-envelope reduction runtime boundary
  progress recording.
- `pre-compaction-memory-flusher.ts` for durable memory flush execution and
  safe pre-compaction flush handling around request-envelope overflow.
- `prompt-policy.ts` for prompt packet construction and prompt assembly
  compaction runtime boundary progress recording.
- `gateway-input-builder.ts` for gateway input construction, runtime session
  continuation directive prompt injection, final synthesis format-contract
  lines, no-tool gateway transforms, mention extraction, tool-definition lookup,
  requested three-line label normalization, and request-envelope prompt-message
  replacement, plus tool-free gateway input construction with tool stripping,
  message replacement, and tool-result envelope recomputation, plus tool-round
  gateway request construction with history preparation, pruning snapshots,
  active/tool-free shaping, and envelope recomputation, plus request-envelope
  reduced retry gateway input construction with prompt-message replacement and
  retry envelope recomputation, plus final
  synthesis source-message construction, extraneous provider-schema
  repair-message construction, and tool-call artifact cleanup repair-message
  construction for terminal final/repair synthesis.
- `gateway-envelope-retry.ts` for request-envelope overflow retry orchestration:
  successful/reduced model-call boundary recording, safe pre-compaction memory
  flush handoff, compact/minimal/reference-only retry sequencing, and reduced
  retry gateway input delegation.
- `terminal-final-synthesis.ts` for terminal final-synthesis gateway wrapper
  wiring: controller entrypoint invocation, pruning boundary recording,
  tool-free final synthesis through request-envelope retry, and shared
  gateway/clock/flusher injection for inline and engine closeout call sites,
  including `createTerminalFinalSynthesisRunner()` for the repeated adapter
  dependency-injection shape.
- `react-engine/engine-model-client.ts` for the engine model port wrapper:
  final-round warning delegation, ReAct tool-choice mapping, tool-round gateway
  request construction, role-runtime pruning boundary recorder binding, envelope
  retry, last-result capture, and reduction/memory flush writes into
  `EngineRunState`.
- `react-engine/engine-forced-tool-round-runner.ts` for the engine forced
  runtime tool-round executor wiring: tool-loop execution dependencies,
  native trace persistence callback, role-runtime provider protocol recorder
  selection, clock, defer mode, observer, and signal are bound once per engine
  run, while forced continuation and model-error hooks pass only the round
  messages, calls, and assistant text.
- `react-engine/engine-final-response.ts` for engine final generated-reply
  assembly: finalization epilogue invocation, requested three-line label
  enforcement, mention extraction, closeout-vs-last-model metadata selection,
  tool-use/model-use/reduction/memory metadata construction, engine
  request-envelope reduction boundary recording through the neutral reducer
  recorder, runtime-derived mission report construction, and debug-only policy
  trace metadata exposure.
- `react-engine/engine-agent-runner.ts` for engine ReAct event consumption:
  creates the `ReActLoop`, applies the boundary-round `maxRounds + 1`
  adjustment, dispatches model/tool lifecycle events to `EngineRunObserver`, and
  returns the final text.
- `react-engine/engine-role-toolkit.ts` for engine ReAct toolkit wiring:
  exposes the gateway-filtered tool definitions, name lookup, active role
  tool-loop execution delegation, and no-active-loop unknown-tool fallback.
- `native-tool-messages.ts` for native tool-message construction and persistence
  safe/defer handling, session trace canonicalization from structured session
  results, and native tool-call counting.
- `runtime-derived-mission-report.ts` for runtime-derived mission terminal
  status mapping and report construction shared by the engine adapter.
- `tool-result-evidence.ts` for completed-session evidence summaries,
  sub-agent timeout signal extraction, session-history evidence extraction,
  required-timeout continuation allowance, resumable partial-session detection,
  tool-result/tool-trace text collection, and usable-evidence checks.
- `tool-use.ts` for worker session tool execution and runtime tool-progress event
  recording and observer emission, including the safe recorder/emitter wrappers
  used by inline and engine paths, plus role tool-call execution for
  serial/concurrent chunks, wall-clock signals, progress/result forwarding,
  tool-error shaping, and over-cap skipped results, plus forced runtime
  tool-round orchestration for observer delegation, native trace updates,
  assistant/tool message append, and provider-protocol handoff.
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

- `evidence-ledger.ts` producer rewrite beyond the current facade.
- Producer-owned typed evidence for completed stream labels and resumable
  timeout sessions. Stage 4 produces task intent facts, but the completed-stream
  and timeout-session evidence side still uses the existing session/evidence
  helpers for behavior-neutral compatibility.
- Browser-visible, product-signal, independent-stream, and timeout-recovery task
  facts remain text-derived compatibility facts until upstream task/evidence
  producers expose stronger typed signals.
- Legacy detector consolidation: `legacy-text-detectors.ts` and the remaining
  regex-heavy detector helpers are intentionally documented debt, not silently
  rewritten in this landing slice.

## Stage 4 Task Intent Facts Checkpoint

What landed:

- `TaskFactsSnapshot` now carries task intent facts for requested table columns,
  provider-schema requests, browser-visible evidence, product-signal dashboard
  evidence, timeout recovery, awaiting-context setup-only turns, and required
  independent evidence-stream count.
- `runViaReActEngine` builds one task-facts snapshot at the composition boundary
  and injects it into the installed hook owners. It does not branch on individual
  task-fact fields.
- `PermissionPolicy` consumes `awaitingContextSetupOnly` before running the
  setup-only no-tool suppression path.
- `ContinuationController` and `ToolCallNormalizer` consume
  `requiredIndependentEvidenceStreams` for independent-stream continuation and
  over-spawn capping.
- `RepairPolicyRegistry` consumes `browserVisibleEvidenceRequired` and
  `productSignalDashboardEvidenceRequested` before forcing browser/product-signal
  evidence repair rounds.
- `architecture-guard.test.ts` now locks this boundary: the adapter may build and
  pass task facts, while owner modules consume the product-policy fields.

What remains:

- `timeoutRecoveryRequested` is produced, but bounded-timeout routing still uses
  the existing behavior-neutral timeout/session helpers. This avoids changing
  recovery behavior in Stage 4.
- `EvidenceSnapshot.completedStreamLabels[]` and
  `EvidenceSnapshot.resumableTimeouts[]` are still future typed-evidence work.
- Browser-visible/product-signal and independent-stream facts are still
  text-derived compatibility facts, not producer-owned browser/evidence events.
- `legacy-text-detectors.ts` is still the Stage 5 quarantine target.

Why the adapter remains acceptable: this stage keeps `runViaReActEngine` as a
composition layer. It builds the typed task-facts snapshot once, injects it into
policy owners, and leaves field-level product-policy decisions in
`PermissionPolicy`, `ContinuationController`, `RepairPolicyRegistry`, and
`ToolCallNormalizer`.

## Latest Gates

Fresh gates run for this task-intent facts landing slice:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx tsx --test packages/role-runtime/src/react-engine/architecture-guard.test.ts` | 44 / 44 |
| `npx tsx --test packages/role-runtime/src/react-engine/*.test.ts` | 285 / 285 |
| `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts` | 272 / 272 |
| `npx tsx --test packages/agent-core/src/*.test.ts` | 53 / 53 |
| `git diff --check` | clean |
| `npm run parity:inline` | 272 / 272, 0 fail |
| `npm run parity:engine` | 272 / 272, 0 fail; all 14 chunks completed |

Note: this latest parity run reported 272 inline test points and discovered 272
engine test points. Engine chunks completed without individual recovery.

## Why The Adapter Is Now Acceptable

For this landing line, yes. `runViaReActEngine` still begins at
`packages/role-runtime/src/llm-response-generator.ts:2478` and remains the
composition root, but the remaining installed-hook bodies are owner calls plus
dependency injection. The adapter still owns appropriate composition work:
module construction, dependency wiring, live state threading, feature flags,
gateway execution callbacks, forced tool-round execution callbacks, and final
reply assembly. It no longer keeps product-policy decision bodies for installed
hooks that reasonably belong to the existing owner modules. The concrete owner
boundaries now include:

- `onToolCalls` delegates to `applyEngineToolCallsHook`; `ToolCallNormalizer`
  now owns live continuation context/directive lookup, browser/explore
  availability construction, normalization order, and final-recovery budget
  truncation after normalization.
- engine policy-trace debug gating routes through `policy-trace.ts`; the adapter
  imports the owner-owned helper instead of carrying the env check locally.
- approval-gate normalizer steps and read-only suppression selection/application
  route through `PermissionPolicy` in the engine path; the full
  `onSuppressToolCalls` hook now enters
  `PermissionPolicy.applySuppressToolCallsHook()` for read-only suppression
  pre-emption before awaiting-context setup-only suppression, including active
  state and empty-call gating, and read-only suppression context construction
  for closeout pre-emption now lives there as well.
- the unconditional engine finalization epilogue routes through
  `finalizeEngineAnswer`.
- model/tool lifecycle observability routes through `EngineRunObserver`, including
  `toolTrace`, runtime progress recorder events, native tool-message persistence,
  and provider tool-protocol round recording; normal post-execute protocol
  recording is now invoked from
  `ContinuationController.applyAfterExecuteContinuationHook()` through the
  injected observer, while forced runtime tool rounds route provider protocol
  recording, native trace/progress snapshot persistence, and assistant/tool
  message append through `EngineRunObserver.observeRuntimeForcedToolRound()`.
- mutable cross-hook state routes through `EngineRunState`, including closeout
  result/metadata, completed/timeout signals, reductions, memory flushes, and final
  message snapshots.
- execution-budget admission routes through `ExecutionBudgetController` for
  final-recovery pending-call truncation and per-round over-cap skipped results;
  the engine `onBeforeExecute` hook now delegates through
  `applyEngineBeforeExecuteHook`.
- engine `runToolBatch` hook wiring routes through
  `ExecutionBudgetController.runEngineToolBatchHook`, which delegates to
  `runToolBatch` for order-sensitive serialization, concurrency chunks,
  wall-clock signal setup, active role-loop execution, and non-abort tool-error
  shaping.
- recovery-budget, wall-clock, and round-limit closeout snapshot construction
  routes through `ExecutionBudgetController`.
- wall-clock closeout signal construction for `onToolCallsClose` routes through
  `ExecutionBudgetController`, including selection between native pending calls
  and the synthetic empty-round continuation; `CloseoutPolicyRegistry` consumes
  the controller-owned signal type.
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
- pending-call closeout application now enters through
  `CloseoutPolicyRegistry.applyPendingCallsCloseoutHook`; the registry owns
  active-loop gating, used-call/evidence calculation, read-only suppression
  pre-emption, recovery-budget-before-continuation ordering, empty-round
  continuation preview handoff, budget callback wiring, and remaining
  pending-call closeout evaluation/application. Remaining pending-call closeout
  session context construction also lives in the registry owner.
- post-execute `completed_sub_agent_final` / `sub_agent_timeout` closeout
  selection and state-effect application route through `CloseoutPolicyRegistry`;
  the adapter passes tool results, evidence ledger, and run-state target through
  a single registry hook entrypoint, while the registry reads the round's
  completed/timeout signals from `EvidenceLedger.currentRound()`.
- natural-finish repair hook application now enters through
  `RepairPolicyRegistry.applyNaturalFinishRepairHook`; the registry owns
  active-loop gating, repair-marker ledger persistence, final-recovery budget
  accounting, and natural-finish repair cascade application.
- terminal `onTerminate` now routes through
  `CloseoutPolicyRegistry.evaluateTerminateHook`, which delegates closeout
  reasonLines and metadata construction to `evaluateTerminate` for pending
  closeout passthrough, completed session closeout, sub-agent timeout closeout,
  round-limit closeout, and generic closeout fallback; the hook entrypoint also
  assembles the terminate decision inputs by reading run state, evidence,
  tool/round counts, and round-limit budget snapshots. Terminal synthesis
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
  The full model-call-error hook now enters through
  `TerminalCloseoutController.completeModelCallErrorHook()`, so abort
  classification, final-message capture, ledger evidence snapshotting, tool-call
  accounting, forced-permission flow selection, and hook-result application live
  with the terminal closeout owner.
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
  calls the module instead of owning that pruning closure. Tool-result pruning
  runtime boundary recording now also lives there, so the adapter no longer owns
  the `tool_result_pruning` progress metadata shape.
- provider tool protocol boundary recording now also routes through
  `tool-history-pruning.ts`; the adapter passes activation, recorder, clock, defer
  mode, messages, calls, and results instead of owning the
  `provider_tool_protocol_round` progress metadata shape. The forced runtime
  tool-round no-observer fallback now also calls a `tool-history-pruning.ts`
  owner wrapper instead of an adapter-private helper.
- runtime tool-progress safe recording and observer emission now route through
  `tool-use.ts`; the adapter passes recorder/defer/observer inputs instead of
  keeping adapter-private safe recorder/emitter wrappers. Role tool-call
  execution now also routes through `tool-use.ts`; the adapter supplies the
  active tool loop, recorder, defer mode, clock, and callbacks. Forced runtime
  tool-round orchestration now also routes through `tool-use.ts`; the adapter
  supplies native trace persistence and provider-protocol recorder callbacks.
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
- tool-free gateway input construction now also routes through
  `gateway-input-builder.ts`; inline/engine no-tool rounds and terminal
  final/repair synthesis paths reuse the same helper for tool stripping,
  message replacement, and tool-result envelope recomputation.
- tool-round gateway request construction now also routes through
  `gateway-input-builder.ts`; inline and engine model rounds share gateway-history
  preparation, pruning snapshot construction, active/tool-free request shaping,
  and tool-result envelope recomputation instead of duplicating that branch in
  the adapter.
- engine model-client wrapper construction now routes through
  `react-engine/engine-model-client.ts`; `runViaReActEngine` passes gateway,
  clock, execution-budget, run-state, and runtime progress recorder dependencies
  instead of owning the model wrapper body, pruning callback wiring, trace round
  counter, last-result slot, and reduction/memory state writes inline.
- engine forced runtime tool-round runner wiring now routes through
  `react-engine/engine-forced-tool-round-runner.ts`; `runViaReActEngine` passes
  the tool-loop, recorder, native persistence, observer, clock, defer, and
  signal dependencies to `createRoleEngineRuntimeForcedToolRoundRunner()`, then
  continuation and model-error hooks pass only each forced round's messages,
  calls, and assistant text.
- engine final generated-reply assembly now routes through
  `react-engine/engine-final-response.ts`; `runViaReActEngine` passes final text,
  run-state snapshots, tool trace, model-call trace, and last model result into
  the owner instead of assembling finalization output and metadata inline. Engine
  request-envelope reduction boundary recording now also goes through that owner
  via `recordEngineReductionBoundary()`.
- engine ReAct event consumption now routes through
  `react-engine/engine-agent-runner.ts`; `runViaReActEngine` passes model,
  toolkit, maxRounds, and hooks to `createRoleEngineAgentRunner()` instead of
  importing/constructing the agent-core ReAct agent or owning the boundary-round
  adjustment inline.
- engine role toolkit wiring now routes through
  `react-engine/engine-role-toolkit.ts`; `runViaReActEngine` passes filtered tool
  definitions and the active tool loop instead of declaring the toolkit methods
  inline.
- role-engine run-state value typing now routes through
  `react-engine/engine-run-state.ts`; `runViaReActEngine` calls
  `createRoleEngineRunState()` instead of declaring the state value map locally.
- engine run observer dependency wiring now routes through
  `react-engine/engine-run-observer.ts`; `runViaReActEngine` passes the
  observer inputs to `createRoleEngineRunObserver()` instead of declaring
  tool-progress, provider-protocol, and native-trace persistence callbacks
  inline.
- request-envelope overflow retry orchestration now routes through neutral
  `gateway-envelope-retry.ts`; the adapter injects gateway, clock, and
  pre-compaction memory flusher instead of owning `generateWithEnvelopeRetry`.
  Prompt-message replacement and retry envelope recomputation still live in the
  neutral `gateway-input-builder.ts`.
- request-envelope reduction boundary recording now routes through
  `request-envelope-reducer.ts`; the adapter no longer owns the
  `request_envelope_reduction` runtime progress metadata shape.
- pre-compaction memory flush safety now routes through
  `pre-compaction-memory-flusher.ts`; the retry owner passes the configured
  flusher, model selection, and overflow diagnostics instead of the adapter
  owning the safe wrapper.
- prompt assembly compaction boundary recording now routes through
  `prompt-policy.ts`; the adapter no longer owns the `prompt_compaction`
  runtime progress metadata shape.
- final synthesis source-message construction, gateway-history preparation, and
  pruning summary construction now enter through `TerminalCloseoutController`;
  the controller uses neutral gateway-input/tool-history helpers internally and
  returns typed source/gateway/pruning request data while the adapter records
  the pruning snapshot and executes the gateway call.
- final-after-tool-round-limit terminal synthesis orchestration now enters
  through `TerminalCloseoutController.synthesizeFinalAfterToolRoundLimit()`;
  provider-schema retry, tool-call cleanup retry, repair merge, and
  gateway-error local fallback are controller-owned while
  `terminal-final-synthesis.ts` supplies gateway, pruning, and request-envelope
  retry callbacks. The adapter now creates neutral final-synthesis runners
  instead of owning a private final-synthesis method or duplicate inline/engine
  injection input types. The controller now also builds the tool-free
  `GenerateTextInput` for each initial/repair synthesis callback.
- extraneous provider-schema repair-message construction for terminal final
  synthesis now routes through `TerminalCloseoutController`; the adapter no
  longer assembles that repair prompt message array locally.
- request-envelope reduced prompt replacement now lives in
  `gateway-input-builder.ts`; the adapter calls the module instead of owning the
  prompt/history splice helper.
- session tool-trace canonicalization and native tool-call counting now live in
  `native-tool-messages.ts`; the adapter calls the module instead of owning
  trace mutation/counting helpers.
- native tool-message persistence now also routes through
  `native-tool-messages.ts`; the adapter passes the store, clock, defer mode, and
  optional force-blocking flag instead of keeping an adapter-private safe
  persister wrapper.
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
- terminal final synthesis provider-schema repair selection now routes through
  `TerminalCloseoutController`, which delegates to a `RepairPolicyRegistry`
  single-policy window; an architecture guard fails if the adapter regresses to
  direct registry or predicate selection.
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
- final-synthesis tool-call artifact fallback result construction now lives in
  `TerminalCloseoutController`; the controller also owns the post-repair
  tool-call artifact check and fallback/merge completion.
- final-synthesis repair effect merging now lives in
  `TerminalCloseoutController`; the adapter passes initial and repair synthesis
  results instead of coalescing reduction, reduction snapshot, and memory flush
  metadata itself.
- final-synthesis gateway-error local evidence fallback construction now lives
  in `TerminalCloseoutController`; the adapter delegates fallback creation and
  only rethrows when the controller returns no local fallback.
- completed-closeout post-synthesis visibility routes through
  `CompletedCloseoutController`, preserving the original browser recovery,
  browser failure-bucket, recovered-timeout/continuation, and forbidden local
  URL redaction order.
- natural-finish evidence formula construction for extracted repair
  policies/controllers routes through `EvidenceLedger` snapshots.
- engine terminal/model-error/finalization paths now read tool-trace result
  content and usable-evidence truth from `EvidenceLedger` snapshots instead of
  calling the raw evidence helpers directly.
- pending closeout, terminate, model-error, and finalization epilogue evidence
  reads now share `EvidenceLedger.forRun()` instead of an adapter-local
  `snapshotEvidence` closure.
- engine timeout-probe and completed terminal-synthesis handoffs now read
  current-round tool-result content through `EvidenceLedger` instead of calling
  the raw result-content collector directly.
- engine continuation and post-execute closeout hooks now consume a single
  `EvidenceLedger.currentRound()` snapshot for current tool-result content,
  completed-session signal, completed final contents, and sub-agent timeout
  signal instead of collecting those facts separately in the adapter.
- engine hard approval wait-timeout fallback now reads approval runtime
  evidence through `EvidenceLedger` and assembles its deterministic fallback
  result through `TerminalCloseoutController`; model-call-error local evidence
  fallback gating, local evidence answer construction, and
  `tool_evidence_fallback` metadata/redaction now run through that same
  controller.
- engine continuation and post-execute closeout hooks now read current
  completed-session and sub-agent timeout result signals through
  `EvidenceLedger`.
- model-call-error abort classification, non-abort final-message capture,
  active/usable-evidence gating, ledger snapshotting, tool-call accounting,
  forced pending-approval `permission_result` continuation selection, local
  evidence fallback/rethrow selection, hook-result application, and raw
  forced-round result trimming enter through
  `TerminalCloseoutController.completeModelCallErrorHook`; the adapter supplies
  only the forced-result builder callback and forced tool-round executor, and
  the usable-evidence input comes from `EvidenceLedger.snapshot()`.
- completed-closeout synthesis callback construction for terminal closeouts now
  routes through `TerminalCloseoutController.handleTerminalCloseoutHook`; the
  adapter passes the completed controller, run state, ledger, hook context,
  tools, and gateway callbacks instead of constructing the completed callback,
  reading completed session/tool-result state, initializing repair markers, or
  constructing completed tool-result text itself. Completed-closeout repair
  gateway message preparation and tool-free gateway input construction also live
  in the controller; the adapter receives a ready gateway input for the repair
  model call. The controller also owns the completed-reason and null-session
  guards, so the adapter passes that handoff data unconditionally.
- terminal final-synthesis callback wiring now routes through
  `TerminalCloseoutController`; the adapter passes the final-synthesis runner,
  and the controller binds max-round/reason-line terminal synthesis inputs plus
  the completed tool-call artifact cleanup callback.
- terminal `onTerminate` decision input assembly now routes through
  `CloseoutPolicyRegistry.evaluateTerminateHook`; the adapter passes run state,
  run evidence, tool trace, and execution budget while the registry owns
  state/evidence reads, native tool-call and round accounting, round-limit
  snapshot callback wiring, and the approval wait-timeout fallback payload.
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
  `ContinuationController.applyAfterExecuteContinuationHook`; the controller now
  owns provider protocol recording, current-round evidence snapshotting, and the
  continuation cascade, while the adapter supplies the observer, ledger,
  repair-marker storage, and the forced-round executor.
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

This PR should not chase more adapter thinning for its own sake. The remaining
items are longer-term typed-facts / detector ownership work:

- Expand `EvidenceLedger` beyond the current facade if future work needs
  producer-owned structured evidence, instead of adding new adapter-local
  evidence reads.
- Continue typed task-facts extraction beyond the current requested
  table/provider-schema facts only when a concrete policy needs it.
- Consolidate `legacy-text-detectors.ts` and the remaining regex-heavy shared
  detector helpers behind typed fact producers. This landing intentionally
  documents that debt instead of doing broad regex rewrites.
- Keep gateway execution callbacks, forced-round executor callbacks, feature
  flags, dependency injection, and final reply assembly in `runViaReActEngine`
  unless a future change identifies a concrete owner-bound policy decision.

## Typed Facts Follow-Up Plan

The remaining architecture work is now tracked in
`docs/STAGE8_TYPED_FACTS_INVENTORY.md` and
`docs/superpowers/plans/2026-07-03-stage8-typed-facts-evidence-producer.md`.
Stage 1 inventory lock is complete; subsequent work should follow that staged
plan instead of resuming open-ended adapter thinning.

### Stage 2 Evidence Producer Checkpoint

Landed:

- `tool-result-evidence.ts` now exposes typed completed-session and timeout
  fact producers for structured session tool results.
- `EvidenceLedger.currentRound()` now produces `completedSessions[]` and
  `timeoutSignals[]`; its legacy singular fields are compatibility values
  derived from those typed facts.
- `ContinuationController.applyAfterExecuteContinuationHook` and
  `CloseoutPolicyRegistry.applyPostExecuteCloseoutHook` consume the typed
  EvidenceLedger arrays rather than raw completed/timeout finder helpers.
- `architecture-guard.test.ts` now blocks engine policy owners from reintroducing
  `findCompletedSessionEvidence` or `findSubAgentToolTimeout`, and pins the
  installed hooks to typed completed/timeout evidence fields.

Still remaining for later stages:

- Permission facts remain text/runtime-progress backed until Stage 3 moves
  approval wait-timeout, pending, applied, and denied state into `PermissionFacts`.
- Task intent facts remain detector-backed except the already extracted
  requested table/provider-schema path; Stage 4 owns that migration.
- `legacy-text-detectors.ts` is still a shell until Stage 5 adds the registry
  metadata and no-new-regex guard.

Stage 2 gates:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npx tsx --test packages/role-runtime/src/react-engine/*.test.ts` | 278 / 278 |
| `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts` | 272 / 272 |
| `npx tsx --test packages/agent-core/src/*.test.ts` | 53 / 53 |
| `npm run parity:inline` | 272 / 272 |
| `npm run parity:engine` | 272 / 272, all 14 chunks |
| `git diff --check` | clean |

The Stage 2 checkpoint was pushed to `origin/feat/stage8-engine-cleanup`.

### Stage 3 Permission Facts Checkpoint

Landed:

- `EvidenceLedger.snapshot()` now produces `permission` facts with
  `latestStatus`, `latestToolName`, `latestResultStatus`, `pendingApproval`,
  `appliedApproval`, `deniedApproval`, `waitTimeout`, and
  `runtimeEvidenceText`.
- `RepairPolicyRegistry` natural-finish hooks now receive
  `permissionFacts: evidence.permission`; the installed approval policies consume
  typed permission facts for pending wait-timeout checks, premature pending
  approval, stale pending approval, stale denied approval, approval wait-timeout
  closeout repair, and approval wait-timeout local closeout.
- `CloseoutPolicyRegistry.evaluateTerminateHook()` reads approval wait-timeout
  fallback text through `terminateEvidence.permission.runtimeEvidenceText`
  instead of reaching directly for the raw approval runtime evidence field.
- The permission fact producer preserves legacy behavior for both structured
  `permission_result` statuses and compatibility text that contains the
  `approval_wait_timeout` token. It also keeps legacy `pending` permission
  results compatible with wait-timeout closeout repairs.
- `architecture-guard.test.ts` now pins the installed permission policy path to
  `EvidenceLedger` permission facts.

Still remaining for later stages:

- Permission facts are still partly derived from text/runtime-progress
  compatibility readers. The permission tool producer is not yet a complete
  typed upstream status pipeline.
- `ContinuationController` and `TerminalCloseoutController` still use existing
  registered shared helper boundaries for forced `permission_result` selection;
  this stage did not broaden that into a full permission-producer rewrite.
- Task intent facts remain Stage 4 work, and `legacy-text-detectors.ts` remains
  a Stage 5 quarantine/metadata task.

Why this keeps the adapter acceptable as a composition layer:

- The adapter does not gain new product-policy branches. Permission policy
  interpretation now sits behind `EvidenceLedger` plus existing owner modules,
  while `runViaReActEngine` continues to supply composition, live state, injected
  callbacks, and final reply assembly.
- Remaining permission text compatibility is localized in the typed evidence
  producer and existing shared helpers; installed hooks consume owner-module
  inputs instead of performing adapter-local permission decisions.

Stage 3 gates:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npx tsx --test packages/role-runtime/src/react-engine/*.test.ts` | 282 / 282 |
| `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts` | 272 / 272 |
| `npx tsx --test packages/agent-core/src/*.test.ts` | 53 / 53 |
| `npm run parity:inline` | 272 / 272 |
| `npm run parity:engine` | 272 / 272, all 14 chunks |
| `git diff --check` | clean |
