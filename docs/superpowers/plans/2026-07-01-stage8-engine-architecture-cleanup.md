# Stage 8 Engine Architecture Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the green Stage 8 ReAct engine parity branch into a maintainable layered harness by extracting the current adapter-heavy `runViaReActEngine` hook bodies into explicit modules with narrow authority, stable contracts, golden-order tests, and no new behavior drift.

**Architecture:** Keep `@turnkeyai/agent-core` generic. Keep `LLMRoleResponseGenerator` as the role-runtime composition root. Move role-specific observability, normalization, continuation, execution-budget, closeout, repair, completed-closeout, finalization, and evidence/fact logic into `packages/role-runtime/src/react-engine/*`. The cleanup is compatibility-first: the engine must stay at 272/0/0-skip parity throughout, while the code becomes enforceably layered.

**Tech Stack:** TypeScript, the workspace-provided Node/npm runtime, `tsx --test`, existing `@turnkeyai/agent-core` ReAct hooks, existing role-runtime parity harness, existing inline-vs-engine fixture suite. Verify the runtime with `node -v` before implementation; do not introduce Node-version-specific APIs during this cleanup.

---

## Current State

The branch already reached behavioral parity behind the engine flag:

- `npm run parity:engine`: 272 pass, 0 fail, 0 skip, all chunks complete.
- `npm run parity:inline`: 272 pass.
- `npm run typecheck`: exit 0.
- `packages/agent-core` tests: green in the latest reported run.
- Default production path still uses inline unless the engine flag is enabled.

This plan assumes parity is real and treats every step below as a refactor. If any step intentionally changes behavior, stop and split that behavior change into its own reviewed PR before continuing the cleanup.

## Problem To Solve

The last parity work fixed the symptoms but also exposed why the system was hard to fix:

- Observability was split across `toolTrace`, native tool messages, runtime progress events, and `metadata.modelUse`.
- Tool-call normalization, permission-related rewrites, continuation injection, closeout decisions, and repair prompts were encoded as hook closure branches.
- Completed closeout behavior simulated an inline loop path without an explicit controller, which is why the final two parity bugs were subtle.
- Product facts are still often recovered from message text, tool result text, or stringified JSON instead of typed tool-result facts.
- The current code relies on "the order of if statements in a large function" as a policy registry.

The cleanup target is not "remove every regex in one shot." The target is "no policy spaghetti": every rule has an owner module, a phase, an order, an input contract, an output contract, and tests. Regex that remains must be isolated in detector/fact modules and cannot authorize side effects.

## Authority Separation

This cleanup enforces a product-owned separation of authority:

- Conversation/run controller owns mutable run state and resume/progress plumbing.
- Context construction is separate from ordinary history.
- Generic ReAct orchestration stays host-agnostic.
- Tool execution lifecycle is explicit and permission-aware before side effects.
- Memory/compaction/observability are services, not final-answer repair branches.
- Product policies are layered around the loop instead of hidden inside one loop body.

For TurnkeyAI, that means:

- `agent-core` stays generic.
- `llm-response-generator.ts` becomes wiring and result assembly.
- role-runtime policy modules own product behavior.
- typed facts gradually replace text inference.

## Non-Negotiable Cleanup Invariants

- Engine parity remains `272/0/0-skip` after each batch.
- Inline parity remains green after each batch.
- Typecheck is green after each batch.
- No `react-engine/*` module imports `../llm-response-generator`.
- `runViaReActEngine` does not gain new product-policy branches during cleanup.
- No new regex or text detector may authorize, retroactively validate, or execute a side-effect tool.
- Existing text-driven approval/side-effect compatibility behavior must be moved behind an explicit policy/detector owner and marked as typed-facts debt; this cleanup must not make it more implicit.
- Closeout and repair precedence must live in exported order arrays or registries, not hook closure order.
- Cross-module hook orchestration order must be documented and pinned by tests; registry order alone is not enough.
- Observer modules may record facts and events, but they may not decide continuation, repair, closeout, permission, or normalization policy.
- Normalizers may rewrite pending tool calls, but they may not execute tools, append messages, record progress, or synthesize final answers.
- Repair and closeout modules may ask for synthesis through an injected synthesizer, but they may not execute tools directly.

## Typed-Facts Target Invariants

These are required before deleting legacy detector debt or using the cleanup as proof that regex debt is gone. They are not fully satisfied by a behavior-preserving extraction alone.

- Regex never authorizes, retroactively validates, or executes side effects.
- Approval-gate decisions use typed permission/session/browser facts when producers expose them.
- Browser evidence dimensions use typed browser facts when producers expose them.
- Source evidence carry-forward uses structured source-label facts when producers expose them.
- Any remaining detector is classified with target typed field, producer, and feasibility class.

## Target File Layout

Create this directory:

```text
packages/role-runtime/src/react-engine/
  types.ts
  policy-trace.ts
  engine-run-state.ts
  engine-run-observer.ts
  permission-policy.ts
  tool-call-normalizer.ts
  finalization-pipeline.ts
  execution-budget-controller.ts
  continuation-controller.ts
  closeout-policy-registry.ts
  repair-policy-registry.ts
  completed-closeout-controller.ts
  evidence-ledger.ts
  task-facts.ts
  legacy-text-detectors.ts
  index.ts
```

Tests should live beside the modules:

```text
packages/role-runtime/src/react-engine/
  engine-run-state.test.ts
  engine-run-observer.test.ts
  permission-policy.test.ts
  tool-call-normalizer.test.ts
  finalization-pipeline.test.ts
  execution-budget-controller.test.ts
  continuation-controller.test.ts
  closeout-policy-registry.test.ts
  repair-policy-registry.test.ts
  completed-closeout-controller.test.ts
  evidence-ledger.test.ts
  task-facts.test.ts
```

Do not export these modules from `packages/role-runtime/package.json` unless another package needs them. They are role-runtime internals.

## Dependency Rules

Allowed dependencies for `react-engine/*`:

- `@turnkeyai/agent-core/*`
- sibling role-runtime modules such as `../session-tool-result-protocol`, `../native-tool-messages`, `../tool-capability-registry`
- neutral shared role-runtime helper modules that do **not** import `llm-response-generator.ts`
- pure helpers moved into `react-engine/*`
- `../react/predicates` while compatibility is needed

Forbidden dependencies for `react-engine/*`:

- `../llm-response-generator`
- any module that imports `llm-response-generator`
- test-only helpers from production code
- composition-root feature flag logic

If a helper currently lives inside `llm-response-generator.ts`, move it with the module that owns it unless the inline loop and extracted engine modules both need the exact same compatibility helper. Shared text/url/session/detector helpers must move first into a neutral role-runtime module outside `react-engine/` so both the inline reference path and `react-engine/*` import the same implementation. Do not solve this by exporting helpers from `llm-response-generator.ts` or by making the inline loop import from `react-engine/*`.

Inline-reference refinement: relocating a pure shared helper to a neutral module is allowed when the call sites remain byte-for-byte behavior-equivalent and the parity gates prove it. This is not considered an inline behavior change. Changing the helper logic, changing normalizer/repair/closeout order, or making inline import policy controllers remains forbidden.

## Layer Permissions Table

| Layer | Module | May Read | May Write | May Call | Must Not Do |
| --- | --- | --- | --- | --- | --- |
| Adapter | `llm-response-generator.ts` | activation, packet, model selection, feature flags, module snapshots | final `GeneratedRoleReply`, high-level run object | controller factories, model gateway, `createReActAgent` | product predicates, regex checks, closeout order, repair order |
| Run State | `engine-run-state.ts` | controller decisions, reductions, memory flushes, completed/timeout signals, final message snapshots | typed mutable run ledgers and snapshots | no policy calls | evaluate policy, parse text, execute tools, synthesize answers |
| Observer | `engine-run-observer.ts` | ReAct events, model trace, tool start/result events, memory/reduction snapshots | tool trace, runtime progress, native tool messages, metadata snapshot | progress recorder helpers | decide policy, mutate model messages for policy, execute tools |
| Facts | `evidence-ledger.ts`, `task-facts.ts`, `legacy-text-detectors.ts` | tool results, messages, prompt packet, activation | typed facts, detector fallback facts | detector functions, structured decoders | execute tools, synthesize answers, authorize side effects |
| Permission | `permission-policy.ts` | pending calls, task facts, permission/session/browser facts, existing compatibility detectors | permission rewrite/suppress decisions only | detector/fact readers | execute tools, close out, repair answer quality, append final visibility |
| Normalizer | `tool-call-normalizer.ts` | pending tool calls, state snapshot, typed facts, compatibility text facts | normalized pending calls only | pure normalizer steps | append messages, record progress, execute tools, close out |
| Execution Budget | `execution-budget-controller.ts` | pending calls, round index, wall-clock state, active tool loop | skipped/synthetic results, abort/budget signals | injected `runOne` executor | repair answers, parse evidence, decide final visibility |
| Continuation | `continuation-controller.ts` | state, typed session facts, continuation directives, timeout facts | continuation action, forced-call request, continuation state | injected forced-round executor when needed | final synthesis, final appenders, source-evidence repair |
| Closeout | `closeout-policy-registry.ts` | pending calls, tool results, budget signals, evidence snapshot | closeout decision and reason lines | no model calls in registry | execute tools, mutate messages outside returned decision, repair candidate answers |
| Repair | `repair-policy-registry.ts` | candidate answer, evidence snapshots, repair ledger, round-gated context | repair decision and repair marker | injected final synthesizer through controller | execute tools directly, record progress, final appendix transforms |
| Completed Controller | `completed-closeout-controller.ts` | completed-session facts, closeout decision, repair registry, final synthesizer | repaired closeout result, re-entry synthesis decision | final synthesizer only | run arbitrary tool batches, own normalizer rules |
| Finalizer | `finalization-pipeline.ts` | selected final text, closeout result, evidence snapshot, packet | transformed final text and final metadata fields | pure append/redaction helpers | call model, execute tools, decide repair |

## Core Types

Add shared types in `packages/role-runtime/src/react-engine/types.ts`.

```ts
import type {
  LLMMessage,
  LLMToolCall,
  ReActState,
  ReActToolChoice,
  ToolResult,
} from "@turnkeyai/agent-core";

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
  | { kind: "continue"; messages: LLMMessage[]; forceToolChoice?: ReActToolChoice; reason: string }
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
```

The exact names can be adjusted to match existing project types, but the discriminated-union shape is required. Returning booleans from policy modules is not allowed because it hides authority and makes trace output weak.

## Hook Orchestration Contract

The per-module registries are not sufficient by themselves. The adapter's cross-module call order inside each `agent-core` hook is also behavior. The cleanup must pin this order with a characterization trace before extraction and a wiring test after extraction.

Every hook below has an owner, even if the current engine path does not install that hook.

| Agent-Core Hook | Current Status | Adapter Orchestration Order | State Application Owner | Required Test |
| --- | --- | --- | --- | --- |
| `filterTools` | not currently installed in engine path | `PermissionPolicy.filterAvailableTools` if future filtering is needed; otherwise return definitions unchanged | adapter only | no-op filter test when absent; filtering order test if added |
| `onRoundMessages` | not currently installed; final-round warning currently lives in the model wrapper | `ExecutionBudgetController.beforeModelCall` only if moved into this hook; no product predicates here | adapter applies returned messages | final-round warning fixture remains unchanged |
| `onToolCalls` | installed | `ToolCallNormalizer.normalize` -> `ExecutionBudgetController.truncateRecoveryBudgetCalls`; the normalizer internally delegates approval-gate steps 2 and 13 to `PermissionPolicy` at their golden pipeline positions | adapter passes normalized calls onward; no run-state mutation except trace | wiring spy asserts normalizer before budget; normalizer unit test asserts permission steps fire at positions 2 and 13 |
| `onSuppressToolCalls` | installed | `PermissionPolicy.suppressReadOnlyPermissionQuery` -> `RepairPolicyRegistry.suppressAwaitingContextSetup` | `EngineRunState.repairLedger` records awaiting-context marker; suppression consumes the round | read-only suppression consumes a round and executes no tool; awaiting-context marker persists |
| `onToolCallsClose` | installed | `PermissionPolicy.wouldSuppressReadOnlyPermissionQuery` guard -> `CloseoutPolicyRegistry.evaluateRecoveryToolBudget` -> `ContinuationController.previewEmptyRoundContinuation` -> `CloseoutPolicyRegistry.evaluateRemainingPendingCalls` | adapter stores selected pending closeout in `EngineRunState` | wiring spy plus cross-fire test where read-only suppression beats closeout; recovery budget is not evaluated twice |
| `onBeforeExecute` | installed | `ExecutionBudgetController.applyMaxToolCallsPerRound` | adapter passes executable and synthetic rejected results to agent-core | over-cap calls emit no `tool_started` |
| `runToolBatch` | installed | `ExecutionBudgetController.runToolBatch` | observer records events from emitted ReAct events, not from this controller directly | serial/concurrent ordering tests |
| `onAfterExecuteContinue` | installed | `EngineRunObserver.onProviderToolProtocolRound` -> `ContinuationController.continueApprovedBrowserTimeout` -> `ContinuationController.continueSiblingTimeout` -> branch: if no completed session, `ContinuationController.runGeneralSupplementalTimeoutProbe`; if completed session, run completed-session block in order: supplemental completed probe -> incomplete approved-browser continuation -> independent evidence streams -> `RepairPolicyRegistry.repairPostExecuteMissingApprovalGate` -> `ContinuationController.runForcedPermissionResultRound` | adapter applies returned messages/force choice; forced rounds append through observer and run state | wiring spy asserts this exact branching order; completed-session-wins and timeout-probe cross-fire tests |
| `onAfterExecute` | installed | `CloseoutPolicyRegistry.evaluatePostExecute` with completed session before timeout | adapter records `completedSession`, `completedSessionToolResults`, or `timeoutSignal` in `EngineRunState` | completed beats timeout in same round |
| `onRoundEmpty` | installed | `ContinuationController.injectEmptyRoundContinuation` -> terminate if none | adapter passes injected calls or terminate to agent-core | direct send beats lookup; lookup injects list |
| `onRepairRound` | installed | `RepairPolicyRegistry.evaluateNaturalFinish` in exported natural-finish order: recovery-budget repair -> browser evidence -> product signal -> missing approval gate -> approval-timeout family -> incomplete approved action -> table columns -> extraneous schema -> source evidence -> weak evidence | `EngineRunState.repairLedger` records markers; adapter applies closeout directive if returned | golden-order test plus closeout-from-repair directive test |
| `onTerminate` | installed | `EngineRunState.captureFinalMessages` -> deterministic local evidence closeout if selected -> `CloseoutPolicyRegistry.resolveReasonLinesAndMetadata` -> `CompletedCloseoutController.synthesize` for completed sessions -> `FinalizationPipeline.applyCloseoutVisibility` -> adapter persists closeout/reduction/memory metadata | `EngineRunState` owns persisted closeout result, reduction, memory flushes, final messages | completed closeout clean-synthesis artifact test; reason metadata test |
| `onModelCallError` | installed | abort rethrow -> `EngineRunState.captureFinalMessages` -> `ContinuationController.runForcedPermissionResultRound` -> `CloseoutPolicyRegistry.evaluateModelErrorFallback` -> rethrow | adapter stores local evidence closeout result when selected | forced permission result before fallback test |
| `onFinalize` | installed | `EngineRunState.captureFinalMessagesIfAbsent`; return text unchanged | `EngineRunState.finalMessages` | natural-finish finalization epilogue sees live messages |
| `terminationPredicates` | not installed | if adopted, must delegate only to `CloseoutPolicyRegistry.evaluateTerminationPredicates` | adapter stores selected closeout | no direct predicates in adapter |
| `onProgress` | not installed; event loop consumes `agent.run` events directly | if adopted, delegate only to `EngineRunObserver`; no policy here | observer | progress event duplication test |

The wiring test should use stub modules that append their policy ids into `EnginePolicyTrace`, then invoke each hook with a minimal state. It must fail if the adapter calls the right modules in the wrong order.

Normalizer ownership note:

- `ToolCallNormalizer` owns the full `ENGINE_TOOL_CALL_NORMALIZATION_ORDER`.
- `PermissionPolicy` owns the approval-gate semantics, but it is invoked by `ToolCallNormalizer` at the existing pipeline positions: `enforceMissingApprovalGateRepair` at position 2 and `approvalGatedBrowserSpawn` at position 13.
- Do not run a permission approval-gate rewrite before the whole normalizer. That would move approval-gated browser rewrites ahead of session alias and continuation-directive rewrites and would be a behavior change.

Closeout ownership note:

- `recovery_tool_budget` remains the first closeout policy in `ENGINE_CLOSEOUT_POLICY_ORDER`.
- `ExecutionBudgetController` supplies budget state and handles `onToolCalls` truncation, but it must not independently select the `recovery_tool_budget` closeout inside `onToolCallsClose`.
- The adapter may call `CloseoutPolicyRegistry.evaluateRecoveryToolBudget` before continuation preview and `CloseoutPolicyRegistry.evaluateRemainingPendingCalls` after continuation preview. Those are two views of one registry/order, not two competing owners. The recovery policy must not be evaluated twice for the same hook invocation.

## Mutable Run-State Ownership

Controllers and registries return decisions. They do not mutate hidden run closure state directly. The adapter applies decisions to a single `EngineRunState` object.

`EngineRunState` owns:

- pending closeout decision and reason lines
- selected closeout result
- completed session signal
- completing round's raw tool results
- timeout signal
- request-envelope reduction, last-wins
- reduction snapshot, last-wins
- pre-compaction memory flushes, append-only
- final message snapshot
- repair marker ledger

Mutation rules:

- `run.reduction` and `run.reductionSnapshot` are last-wins.
- `run.memoryFlushes` is append-only.
- `run.finalMessages` is first-closeout/error snapshot, and `onFinalize` fills it only when absent for natural finish.
- `repairMarkers` are owned by the repair ledger and passed to policies as a snapshot; policies return marker writes in decisions and the adapter applies them.
- Completed session metadata remains sticky only for `completed_sub_agent_final`; non-completed terminal reasons overwrite stale completed metadata.
- A controller that needs to persist state must return a typed decision, not mutate `ctx` or a captured `run` object.

## Module Specs

### 0. EngineRunState

File: `packages/role-runtime/src/react-engine/engine-run-state.ts`

Authority:

- Own mutable cross-hook state for one engine run.
- Apply decisions returned by controllers and registries.

It owns:

- repair marker ledger
- pending closeout metadata
- completed/timeout signals
- final message snapshots
- reduction and memory flush metadata
- selected closeout result

It does not own:

- policy evaluation
- regex/text detection
- model calls
- tool execution

Required public shape:

```ts
export interface EngineRunState {
  repairMarkers(): readonly string[];
  recordRepairMarker(marker: string): void;
  applyPendingCloseout(decision: CloseoutDecision): void;
  recordCompletedSession(input: CompletedSessionSignal): void;
  recordTimeoutSignal(input: TimeoutSignal): void;
  recordReduction(input: ReductionSignal): void;
  recordMemoryFlush(input: MemoryFlushSignal): void;
  captureFinalMessages(messages: readonly LLMMessage[]): void;
  captureFinalMessagesIfAbsent(messages: readonly LLMMessage[]): void;
  snapshot(): EngineRunStateSnapshot;
}
```

Implementation requirements:

- This module is mutable by design, but it is the only mutable cross-hook run-state owner.
- It must not import predicates or policy modules.
- It must expose snapshots to controllers rather than the mutable object itself.

Tests:

- Reduction is last-wins.
- Memory flushes accumulate.
- `captureFinalMessagesIfAbsent` does not overwrite closeout/error snapshots.
- Repair markers persist across natural-finish, post-execute, and completed-closeout paths.

### 0.5. PermissionPolicy

File: `packages/role-runtime/src/react-engine/permission-policy.ts`

Authority:

- Own permission-query suppression and approval-gate compatibility decisions.

It owns:

- read-only permission-query suppression
- approval-gated browser rewrite or forced permission-query decisions that currently depend on compatibility detectors
- future tool filtering if the engine starts using `filterTools`

It does not own:

- tool execution
- final-answer quality repairs unrelated to permission
- completed closeout synthesis

Required public shape:

```ts
export interface PermissionPolicy {
  filterAvailableTools(input: PermissionFilterInput): LLMToolDefinition[];
  normalizeMissingApprovalGateRepair(input: PermissionToolCallInput): LLMToolCall[];
  normalizeApprovalGatedBrowserSpawn(input: PermissionToolCallInput): LLMToolCall[];
  suppressReadOnlyPermissionQuery(input: PermissionSuppressInput): EngineSuppressDecision;
  wouldSuppressReadOnlyPermissionQuery(input: PermissionSuppressInput): boolean;
}
```

Implementation requirements:

- Existing text-driven approval compatibility logic may move here during cleanup, but each detector must be marked as typed-facts debt.
- `normalizeMissingApprovalGateRepair` is called only by `ToolCallNormalizer` at the `enforceMissingApprovalGateRepair` pipeline step.
- `normalizeApprovalGatedBrowserSpawn` is called only by `ToolCallNormalizer` at the `approvalGatedBrowserSpawn` pipeline step.
- Do not expose or use a single pre-normalizer approval rewrite hook; approval-gate logic must keep its current interleaved pipeline positions.
- The policy must not execute side-effect tools.
- The policy must not synthesize final answers.
- The policy must not add new raw regexes outside `legacy-text-detectors.ts`.

Tests:

- Read-only permission-query suppression returns `consumesRound: true`.
- The closeout guard and suppression decision agree for the same input.
- Approval-gate compatibility detector is traceable to a target typed fact.
- Permission normalizer-step tests assert the policy methods are invoked from the normalizer at positions 2 and 13, not before the whole pipeline.

### 1. EngineRunObserver

File: `packages/role-runtime/src/react-engine/engine-run-observer.ts`

Authority:

- Own every observability sink used by the engine path.
- Provide one metadata snapshot at the end of the run.

It owns:

- `toolTrace`
- native tool messages
- runtime progress events
- provider tool protocol round boundary
- model-use summary
- pruning/reduction/memory flush metadata

It does not own:

- whether a tool call is allowed
- whether a continuation fires
- whether a repair fires
- final answer text transforms

Required public shape:

```ts
export interface EngineRunObserver {
  onModelCall(input: EngineObservedModelCall): void;
  onToolStarted(input: EngineObservedToolStart): void;
  onToolResult(input: EngineObservedToolResult): void;
  onProviderToolProtocolRound(input: EngineProviderToolProtocolRound): void;
  onPruningBoundary(input: EnginePruningBoundary): void;
  onReductionBoundary(input: EngineReductionBoundary): void;
  onMemoryFlush(input: EngineMemoryFlush): void;
  snapshot(): EngineRunObservationSnapshot;
}
```

Implementation requirements:

- The event-loop code in `runViaReActEngine` should call observer methods instead of writing directly to multiple sinks.
- The adapter keeps round sequencing and `currentRound` lifecycle. The observer records events for a round; it does not decide when a round opens or closes.
- Injected-round support remains an adapter responsibility: if a round opens from the first `tool_started` event rather than a model response with tool calls, the adapter must sequence that before calling observer record methods.
- `metadata.modelUse` must come from `observer.snapshot()`.
- Tool lifecycle progress must be emitted from the same `tool_started` and `tool_result` event handling that populates `toolTrace`.
- `provider_tool_protocol_round` must be recorded in the hook that has both the just-executed tool results and live appended messages.
- Observer methods must be idempotent where the current event stream can replay or double report. Use event ids, tool call ids, or round/call keys to avoid duplicates.

Tests:

- `engine-run-observer.test.ts` asserts a `tool_started` event updates both `toolTrace` and runtime progress.
- It asserts a `tool_result` event updates both `toolTrace` and runtime progress.
- It asserts provider protocol round includes assistant/tool messages after append.
- It asserts `snapshot().metadata.modelUse` is present and JSON-safe.

### 2. ToolCallNormalizer

File: `packages/role-runtime/src/react-engine/tool-call-normalizer.ts`

Authority:

- Own syntactic and routing normalization before execution.
- Preserve the current `ENGINE_TOOL_CALL_NORMALIZATION_ORDER`.

It owns these current behaviors:

- session tool alias normalization
- missing approval-gate repair normalization, delegated to `PermissionPolicy` at pipeline position 2
- explicit continuation history calls
- session tool call shape normalization
- continuation directive injection
- continuation lookup directive injection
- private/local URL web fetch routing
- bounded timeout source spawn routing
- duplicate source spawn suppression
- approval-gated browser spawn rewrite, delegated to `PermissionPolicy` at pipeline position 13
- independent evidence spawn limiting
- supplemental local timeout probe normalizer if it rewrites pending calls

It does not own:

- side-effect permission allow/deny
- final-answer repair
- closeout synthesis
- progress recording

Required public shape:

```ts
export interface ToolCallNormalizationContext {
  messages: LLMMessage[];
  taskPrompt: string;
  browserAvailable: boolean;
  exploreAvailable: boolean;
  toolTraceText: string;
  sourceBoundedEvidenceText: string;
  sessionContinuationDirective?: string;
  sessionContinuationLookupDirective?: string;
  repairMarkers: readonly string[];
}

export interface ToolCallNormalizationStep {
  id: string;
  normalize(calls: LLMToolCall[], ctx: ToolCallNormalizationContext): LLMToolCall[];
}

export const ENGINE_TOOL_CALL_NORMALIZATION_ORDER: readonly string[];

export function normalizeEngineToolCalls(
  calls: LLMToolCall[],
  ctx: ToolCallNormalizationContext,
  trace?: EnginePolicyTrace,
): LLMToolCall[];
```

Implementation requirements:

- Move the existing pipeline and step helpers out of `llm-response-generator.ts`.
- Keep the exported golden order string-for-string stable unless a test explains an intentional order change.
- The normalizer holds the order. Permission approval-gate logic is a dependency called from the two existing approval-gate steps; it is not a sibling pre-pass.
- Do not import from `llm-response-generator.ts`.
- If a helper needs legacy text matching, move that matching into `legacy-text-detectors.ts`.
- The only mutation allowed is returning a new call list.

Tests:

- Golden-order test for `ENGINE_TOOL_CALL_NORMALIZATION_ORDER`.
- Spy test asserting approval-gate policy methods fire at positions 2 and 13.
- Fixture tests for each existing normalizer that currently has a parity test.
- Cross-fire test where continuation lookup and direct `sessions_send` are both possible; direct send must win.
- Test that calling `normalizeEngineToolCalls` does not mutate the input calls array.

### 3. FinalizationPipeline

File: `packages/role-runtime/src/react-engine/finalization-pipeline.ts`

Authority:

- Own final text transforms after a final answer has been selected.

It owns:

- local/private URL redaction on final result
- timeout continuation visibility appendix
- required follow-up visibility appendix
- residual-risk visibility appendix
- browser failure bucket appendix
- any final metadata-only shaping that does not decide policy

It does not own:

- model calls
- tool execution
- answer repair prompts
- closeout precedence

Required public shape:

```ts
export interface FinalizationInput {
  text: string;
  closeout?: EngineCloseoutSnapshot;
  evidence: EvidenceSnapshot;
  task: TaskFacts;
}

export interface FinalizationOutput {
  text: string;
  appendedSections: readonly string[];
  metadata: Record<string, unknown>;
}

export function finalizeEngineAnswer(input: FinalizationInput): FinalizationOutput;
```

Implementation requirements:

- Extract pure final append/redaction helpers before extracting the repair/closeout controllers.
- The pipeline must not inspect mutable `run` state directly. Pass a snapshot.
- Each appendix must record an `appendedSections` id for testability.

Tests:

- Existing timeout and browser failure visibility tests still pass.
- Unit tests for "no appendix when evidence is absent."
- Unit tests for appendix order when multiple sections apply.

### 4. ExecutionBudgetController

File: `packages/role-runtime/src/react-engine/execution-budget-controller.ts`

Authority:

- Own execution budget and batching mechanics.

It owns:

- final-round warning before model call
- max tool calls per round cap
- wall-clock abort signal and budget checks
- batch grouping for serial vs concurrent execution
- recovery-budget truncation of pending calls when the current behavior requires it
- synthetic skipped results for over-cap calls

It does not own:

- whether an answer needs repair
- whether a completed session closeout should synthesize final text
- continuation state semantics beyond budget signal data

Required public shape:

```ts
export interface ExecutionBudgetController {
  beforeModelCall(input: BeforeModelCallInput): LLMMessage[];
  beforeExecute(input: BeforeExecuteInput): BeforeExecuteDecision;
  runToolBatch(input: RunToolBatchInput): Promise<RunToolBatchOutput>;
  snapshot(): ExecutionBudgetSnapshot;
}

export type BeforeExecuteDecision =
  | { kind: "execute"; calls: LLMToolCall[] }
  | { kind: "split"; executable: LLMToolCall[]; syntheticResults: ToolResult[]; reason: string };
```

Implementation requirements:

- Preserve current over-cap semantics: over-cap calls do not emit `tool_started`.
- Preserve current wall-clock abort-signal behavior for executing batches.
- Expose wall-clock and recovery-budget state snapshots for `CloseoutPolicyRegistry`; do not independently select `wall_clock_budget` or `recovery_tool_budget` closeouts here.
- Any synthetic result must have a stable reason id.
- `runViaReActEngine` should delegate `onBeforeExecute` and `runToolBatch` to this controller.

Tests:

- Over-cap call does not emit `tool_started`.
- Serial tools remain serial.
- Concurrency-safe chunks still run concurrently.
- Wall-clock execution signal behavior matches the current parity fixture.

### 5. ContinuationController

File: `packages/role-runtime/src/react-engine/continuation-controller.ts`

Authority:

- Own the session/browser continuation plane.

It owns:

- empty-round continuation injection
- session lookup injection
- direct `sessions_send` precedence over lookup
- timeout follow-up continuation
- supplemental browser probe after relevant timeouts
- incomplete approved-browser session continuation
- independent evidence stream continuation
- forced permission-result round before model-error/closeout when required

It does not own:

- final-answer repairs
- completed closeout synthesis
- normalizer order
- runtime progress recording

Required public shape:

```ts
export interface ContinuationController {
  onToolCalls(input: ContinuationToolCallsInput): EngineContinueAction;
  onRoundEmpty(input: ContinuationRoundEmptyInput): EngineContinueAction;
  onAfterExecuteContinue(input: ContinuationAfterExecuteInput): Promise<EngineContinueAction>;
  onModelCallError(input: ContinuationModelErrorInput): Promise<EngineContinueAction>;
  snapshot(): ContinuationSnapshot;
}
```

Implementation requirements:

- The controller returns actions; it does not directly mutate `state.messages`.
- If a forced host tool round is required, call an injected `executeForcedRound` dependency and return the resulting messages/action.
- Preserve the current completed-session-wins precedence.
- In `onAfterExecuteContinue`, the general supplemental timeout probe is allowed only when there is no completed session in the current round.
- The completed-session branch owns its internal order: completed supplemental probe, incomplete approved-browser continuation, independent evidence streams, post-execute missing approval gate repair, forced permission result.
- The completed-session branch must self-guard so independent streams, missing approval gate repair, and forced permission result do not run on a non-completed timeout-only round.
- Preserve the current direct `sessions_send` over lookup precedence.
- Every action must include a `reason` string used by policy trace.

Tests:

- Lookup directive injects `sessions_list`.
- Direct `sessions_send` prevents lookup injection.
- Non-browser timeout with content-poor resumed evidence escalates to browser `sessions_spawn`.
- Completed session prevents timeout probe.
- Forced permission-result path still records the forced result and continues.

### 6. CloseoutPolicyRegistry

File: `packages/role-runtime/src/react-engine/closeout-policy-registry.ts`

Authority:

- Own terminal closeout decisions and their precedence.

It owns:

- recovery tool budget closeout
- operator-cancelled closeout
- pseudo tool call closeout
- wall-clock closeout
- round-limit closeout
- repeated tool failure closeout
- repeated session inspection closeout
- excessive session continuation closeout
- sub-agent timeout closeout
- completed sub-agent final closeout
- tool evidence fallback closeout
- model-error fallback closeout

It does not own:

- model synthesis
- repair prompt construction
- tool execution

Required public shape:

```ts
export const ENGINE_CLOSEOUT_POLICY_ORDER = [
  "recovery_tool_budget",
  "operator_cancelled",
  "pseudo_tool_call",
  "wall_clock_budget",
  "round_limit",
  "repeated_tool_failure",
  "repeated_session_inspection",
  "excessive_session_continuation",
  "sub_agent_timeout",
  "completed_sub_agent_final",
  "tool_evidence_fallback",
  "model_error",
] as const;

export interface CloseoutPolicy {
  id: (typeof ENGINE_CLOSEOUT_POLICY_ORDER)[number];
  phase: "pending_calls" | "post_execute" | "model_error" | "round_limit" | "terminate";
  evaluate(input: CloseoutPolicyInput): CloseoutDecision | null;
}

export interface CloseoutPolicyRegistry {
  evaluateRecoveryToolBudget(input: CloseoutRegistryInput): CloseoutDecision | CloseoutDeferDecision | null;
  evaluateRemainingPendingCalls(input: CloseoutRegistryInput): CloseoutDecision | null;
  evaluatePostExecute(input: CloseoutRegistryInput): CloseoutDecision | null;
  evaluateModelErrorFallback(input: CloseoutRegistryInput): CloseoutDecision | null;
}
```

Implementation requirements:

- Move current pending-call and post-execute closeout predicates into named policies.
- Preserve current order exactly.
- `recovery_tool_budget` is evaluated only by `evaluateRecoveryToolBudget`; `evaluateRemainingPendingCalls` starts after that policy and must not re-check it.
- The recovery-budget repair deferral is represented as `CloseoutDeferDecision`, not as an execution-budget decision.
- Policy functions must return a decision object, not write into `run.toolLoopCloseout` directly.
- `runViaReActEngine` may still store the selected decision in the run object after registry evaluation.

Tests:

- Golden-order test for `ENGINE_CLOSEOUT_POLICY_ORDER`.
- Cross-fire test where two closeouts match; earlier order wins.
- Recovery-budget closeout/defer test proves it is evaluated once per `onToolCallsClose` invocation.
- No-match test returns `null`.
- Existing parity closeout fixtures still pass.

### 7. RepairPolicyRegistry

File: `packages/role-runtime/src/react-engine/repair-policy-registry.ts`

Authority:

- Own candidate-answer repair rules, order, evidence formulas, and markers.

It owns natural-finish policies in this order:

- missing requested table columns
- extraneous schema/table claims
- source evidence carry-forward
- weak evidence

It owns completed-closeout policies in this order:

- missing requested table columns
- extraneous schema/table claims
- source evidence carry-forward
- timeout follow-up recovery guidance
- missing requested next action
- missing required deliverables
- missing browser evidence dimensions
- false evidence blocked synthesis
- weak evidence

It also owns existing error/pre-closeout repair decisions that currently sit outside the natural-finish cascade:

- missing browser evidence before closeout
- missing product-signal browser evidence before closeout
- missing approval gate repair
- approval-wait-timeout repair family
- recovery-budget repair closeout

It does not own:

- final visibility appenders
- tool execution
- generic tool-call normalization

Required public shape:

```ts
export interface RepairPolicy {
  id: string;
  phase: "natural_finish" | "completed_closeout" | "pre_closeout" | "model_error";
  order: number;
  evidenceFormula: RepairEvidenceFormula;
  evaluate(input: RepairPolicyInput): EngineRepairDecision;
}

export interface RepairPolicyRegistry {
  evaluateNaturalFinish(input: RepairPolicyInput): EngineRepairDecision;
  evaluateCompletedCloseout(input: RepairPolicyInput): EngineRepairDecision;
  evaluatePreCloseout(input: RepairPolicyInput): EngineRepairDecision;
  evaluateModelError(input: RepairPolicyInput): EngineRepairDecision;
}
```

Implementation requirements:

- Every repair must declare `id`, `phase`, `order`, `evidenceFormula`, and marker.
- Round-0 vs round-N behavior must be explicit in policy config.
- Source evidence and weak evidence must use the current round-dependent evidence formula:
  - round 0 completed path uses completed-round evidence
  - round >0 completed path uses source-bounded evidence
- Markers must come from a repair ledger or a passed marker snapshot, not raw ad hoc message scans.
- `shouldRepair...` helpers can remain in `react/predicates.ts` temporarily, but the registry owns the call order and marker/evidence formula.

Tests:

- Golden-order tests for natural-finish and completed-closeout policy order.
- Source evidence formula test for completed round 0 vs round >0.
- Compound completed closeout test where round 0 repair creates a round 1 condition.
- Cross-fire test where source evidence and weak evidence both match; declared order wins.

### 8. CompletedCloseoutController

File: `packages/role-runtime/src/react-engine/completed-closeout-controller.ts`

Authority:

- Own completed-session final synthesis, completed repair loop, and final clean synthesis when a repair produces tool-call artifact text.
- Make the current terminal-hook simulation explicit and bounded.

It owns:

- completed session final closeout synthesis
- completed-round repair loop
- S10 browser/product re-arm when current behavior requires it
- final clean synthesis after completed repair loop if the last synthesis contains tool calls

It does not own:

- ordinary tool execution
- normalizer pipeline
- final appendix pipeline
- new simulated main-loop behavior beyond the current completed closeout repair and one clean synthesis ceiling

Required public shape:

```ts
export interface FinalSynthesizer {
  generate(input: FinalSynthesisInput): Promise<FinalSynthesisOutput>;
}

export interface CompletedCloseoutController {
  synthesize(input: CompletedCloseoutInput): Promise<CompletedCloseoutOutput>;
}
```

Implementation requirements:

- Use injected `FinalSynthesizer`; do not import model gateway directly.
- Reuse `RepairPolicyRegistry`.
- The final clean synthesis after a tool-call artifact must be a named step with a test.
- The controller returns both final text and a trace of applied repairs.
- This controller is still simulating one inline main-loop re-entry inside `onTerminate`. That is acceptable only as the current compatibility ceiling: completed repair loop plus one clean synthesis after a tool-call artifact. Do not add new arbitrary tool execution, new continuation branches, or unbounded re-entry simulation here. If more re-entry behavior is needed, that is a separate agent-core/8F design.

Tests:

- Completed-closeout path that needs no repair calls synthesizer once.
- Completed-closeout path with two repairs applies declared order.
- Tool-call artifact after repair triggers one clean synthesis.
- Clean synthesis is a no-op for the common tool-free case.

### 9. EvidenceLedger And TaskFacts

Files:

- `packages/role-runtime/src/react-engine/evidence-ledger.ts`
- `packages/role-runtime/src/react-engine/task-facts.ts`
- `packages/role-runtime/src/react-engine/legacy-text-detectors.ts`

Authority:

- Centralize structured facts and legacy text fallback facts.

It owns:

- source labels from tool results and model-visible traces
- browser evidence dimensions
- completed session facts
- timeout/cancellation facts
- permission result facts
- task prompt facts currently inferred repeatedly
- text detectors for facts that are not yet structured

It does not own:

- policy order
- tool execution
- final synthesis

Required public shape:

```ts
export interface EvidenceLedger {
  recordToolResults(input: EvidenceRoundInput): EvidenceSnapshot;
  snapshot(): EvidenceSnapshot;
}

export interface EvidenceSnapshot {
  sourceLabels: readonly SourceLabelFact[];
  browser: readonly BrowserEvidenceFact[];
  sessions: readonly SessionEvidenceFact[];
  permissions: readonly PermissionEvidenceFact[];
  textFallbacks: readonly TextFallbackFact[];
}

export interface TaskFacts {
  requestedTableColumns: readonly string[];
  requiresBrowserEvidence: boolean;
  requestedBrowserDimensions: readonly BrowserEvidenceDimension[];
  requestedNextActions: readonly string[];
  sourceEvidenceRequirements: readonly string[];
}
```

Implementation requirements:

- Start as a facade over existing helpers and raw text, not a producer rewrite.
- Every detector in `legacy-text-detectors.ts` must state the structured field that should replace it.
- Every detector must state its producer and feasibility class: `already_structured`, `present_only_as_text`, or `missing_from_producer`.
- Every detector must link back to the Stage 8 inventory/debt row it is replacing or centralizing.
- Detectors need positive and negative fixtures.
- Policies may call `EvidenceSnapshot` and `TaskFacts`; they may not invent new regexes inline.
- Do not block this cleanup on rewriting browser/session producers. Producer rewrites are separate work items once the detector inventory is explicit.

Tests:

- Structured session tool result produces session facts.
- Source labels can be read from the current tool trace representation.
- Browser dimensions detector has positive and negative fixtures.
- Permission result detector has positive and negative fixtures.
- Task prompt table-column detector has positive and negative fixtures.

## Implementation Batches

This cleanup should be one branch/campaign, not dozens of tiny isolated slices. Use sequential commits inside the campaign, with gates after each commit. The order below is chosen to reduce risk: first extract modules that only observe or transform pure data, then extract state machines, then extract repair/closeout synthesis.

### Batch 0: Safety Baseline And Module Shell

- [ ] Create `packages/role-runtime/src/react-engine/`.
- [ ] Add `types.ts`, `policy-trace.ts`, `engine-run-state.ts`, and `index.ts`.
- [ ] Add empty but compiling module files for the planned modules.
- [ ] Add a short comment in `llm-response-generator.ts` saying new role-engine policy logic must be added in `react-engine/*`, not directly in `runViaReActEngine`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run parity:inline`.
- [ ] Run `npm run parity:engine`.

Expected output:

- Typecheck exit 0.
- Inline parity remains 272/272.
- Engine parity remains 272/0/0-skip.

### Batch 0.5: Characterization Trace And Wiring Guards

- [ ] Add non-optional `EnginePolicyTrace` plumbing for engine mode.
- [ ] Surface the trace into debug metadata behind the engine flag so production-behind-flag failures can answer "which policy fired or skipped."
- [ ] Add a characterization runner that records the policy trace for the 272 parity fixtures.
- [ ] Store the characterization snapshot in a reviewable golden format.
- [ ] Add a wiring test that invokes each installed hook with spy modules and asserts the cross-module order from the Hook Orchestration Contract.
- [ ] Add an architecture guard test that fails if any `packages/role-runtime/src/react-engine/*` file imports `llm-response-generator.ts`.
- [ ] Run:

```bash
npm run typecheck
npm run parity:inline
npm run parity:engine
```

Expected output:

- Parity remains green.
- The trace snapshot establishes current behavior before extraction.
- Wiring test fails if modules are called in the wrong order even when registry arrays are correct.

### Batch 0.75: Shared Helper Extraction Prerequisite

- [ ] Add a neutral shared role-runtime helper module outside `react-engine/` for pure text, URL, session-continuation, browser-evidence, approval-gate detector, and shared compatibility normalizer helpers needed by both inline and engine extraction work.
- [ ] Move the shared helper dependency closure out of `llm-response-generator.ts` without changing logic, strings, regexes, order, or exported runtime behavior.
- [ ] Update `llm-response-generator.ts` to import those helpers from the neutral module; `react-engine/*` must import the same helpers later rather than importing from `llm-response-generator.ts` or duplicating them.
- [ ] Keep `ENGINE_TOOL_CALL_NORMALIZATION_ORDER` and the engine pipeline ownership in place until Batch 1; Batch 0.75 only removes the shared-helper ownership blocker.
- [ ] Run:

```bash
npm run typecheck
npx tsx --test packages/role-runtime/src/react-engine/*.test.ts
npm run parity:inline
npm run parity:engine
git diff --check
```

Expected output:

- The inline loop and engine path both remain behavior-equivalent to the pre-extraction code.
- Shared helper movement is parity-proven, so Batch 1 can move the normalizer pipeline without making inline import from `react-engine/*`.
- No `react-engine/*` module imports `llm-response-generator.ts`.

### Batch 1: Extract Observability, Normalization, And Finalization

- [ ] Move mutable cross-hook run state into `engine-run-state.ts`.
- [ ] Move observability writes from `runViaReActEngine` into `engine-run-observer.ts`, while keeping `currentRound` sequencing in the adapter.
- [ ] Move read-only permission-query suppression and approval-gate compatibility decisions into `permission-policy.ts` where they are currently part of hook orchestration.
- [ ] Move `ENGINE_TOOL_CALL_NORMALIZATION_ORDER`, the normalization pipeline, and owned helper functions into `tool-call-normalizer.ts`.
- [ ] Move pure final append/redaction logic into `finalization-pipeline.ts`.
- [ ] Add unit tests for run state, permission, observer, normalizer order, and finalization order.
- [ ] Update `runViaReActEngine` to instantiate these modules and delegate to them.
- [ ] Run targeted tests:

```bash
npx tsx --test packages/role-runtime/src/react-engine/engine-run-state.test.ts \
  packages/role-runtime/src/react-engine/permission-policy.test.ts \
  packages/role-runtime/src/react-engine/engine-run-observer.test.ts \
  packages/role-runtime/src/react-engine/tool-call-normalizer.test.ts \
  packages/role-runtime/src/react-engine/finalization-pipeline.test.ts
```

- [ ] Run full gates:

```bash
npm run typecheck
npm run parity:inline
npm run parity:engine
```

Expected output:

- Targeted tests pass.
- Full parity remains green.
- `llm-response-generator.ts` no longer directly writes all observability sinks or owns the normalizer pipeline.

### Batch 2: Extract Execution Budget And Continuation

- [ ] Move final-round warning, max-calls cap, synthetic skipped results, wall-clock budget handling, and batch execution planning into `execution-budget-controller.ts`.
- [ ] Move empty-round, post-execute, lookup, timeout probe, approved-browser continuation, independent-stream continuation, and forced permission-result continuation into `continuation-controller.ts`.
- [ ] Add policy trace records for every continuation action and every budget split/closeout.
- [ ] Add unit tests for execution cap, no `tool_started` on over-cap calls, wall-clock execution signal snapshots, recovery-budget closeout/defer handoff, lookup injection, direct-send precedence, supplemental browser probe, and completed-session-wins precedence.
- [ ] Update ReAct hooks in `runViaReActEngine` to delegate `onBeforeExecute`, `runToolBatch`, `onRoundEmpty`, `onAfterExecuteContinue`, and related model-error continuation handling.
- [ ] Run targeted tests:

```bash
npx tsx --test packages/role-runtime/src/react-engine/execution-budget-controller.test.ts \
  packages/role-runtime/src/react-engine/continuation-controller.test.ts
```

- [ ] Run full gates:

```bash
npm run typecheck
npm run parity:inline
npm run parity:engine
```

Expected output:

- Targeted tests pass.
- Full parity remains green.
- Continuation decisions are inspectable through policy trace.

### Batch 3: Extract Closeout Registry And Repair Registry

- [ ] Move pending-call and post-execute closeout decisions into `closeout-policy-registry.ts`.
- [ ] Add `ENGINE_CLOSEOUT_POLICY_ORDER` and golden-order tests.
- [ ] Move natural-finish repair order and completed-closeout repair order into `repair-policy-registry.ts`.
- [ ] Add repair order arrays and golden-order tests.
- [ ] Make every repair return `EngineRepairDecision`, including marker and evidence formula.
- [ ] Keep existing `shouldRepair...` predicate helpers where needed, but call them only through registry policies.
- [ ] Update `runViaReActEngine` hooks `onToolCallsClose`, `onAfterExecute`, `onRepairRound`, and `onModelCallError` to delegate.
- [ ] Run targeted tests:

```bash
npx tsx --test packages/role-runtime/src/react-engine/closeout-policy-registry.test.ts \
  packages/role-runtime/src/react-engine/repair-policy-registry.test.ts
```

- [ ] Run full gates:

```bash
npm run typecheck
npm run parity:inline
npm run parity:engine
```

Expected output:

- Closeout precedence is exported and pinned by tests.
- Repair precedence is exported and pinned by tests.
- Full parity remains green.

### Batch 4: Extract Completed Closeout Controller

- [ ] Move completed-session synthesis and completed repair loop into `completed-closeout-controller.ts`.
- [ ] Add `FinalSynthesizer` adapter that wraps the existing `generateFinalAfterToolRoundLimit` call.
- [ ] Preserve the current final clean synthesis after tool-call artifact re-entry.
- [ ] Preserve current S10 re-arm behavior.
- [ ] Return a trace of applied completed-closeout repairs.
- [ ] Update `onTerminate` in `runViaReActEngine` to call the controller.
- [ ] Run targeted tests:

```bash
npx tsx --test packages/role-runtime/src/react-engine/completed-closeout-controller.test.ts
```

- [ ] Run full gates:

```bash
npm run typecheck
npm run parity:inline
npm run parity:engine
```

Expected output:

- Completed closeout behavior remains parity-green.
- The completed repair loop no longer lives directly in `runViaReActEngine`.

### Batch 5: Add EvidenceLedger And TaskFacts Facade

- [ ] Add `evidence-ledger.ts`, `task-facts.ts`, and `legacy-text-detectors.ts`.
- [ ] Move existing repeated task/evidence text extraction into the facade without changing behavior.
- [ ] Add structured fact adapters for facts that are already available in current tool result objects.
- [ ] Add detector records for facts that are present only as text.
- [ ] For each detector, include target typed field, producer, feasibility class, and inventory/debt cross-link.
- [ ] Add detector fixtures for every new detector.
- [ ] Update normalizer, continuation, closeout, repair, and finalization modules to read facts through `EvidenceSnapshot` and `TaskFacts` where available.
- [ ] Keep compatibility fallback calls only in `legacy-text-detectors.ts`.
- [ ] Run targeted tests:

```bash
npx tsx --test packages/role-runtime/src/react-engine/evidence-ledger.test.ts \
  packages/role-runtime/src/react-engine/task-facts.test.ts
```

- [ ] Run full gates:

```bash
npm run typecheck
npm run parity:inline
npm run parity:engine
```

Expected output:

- Existing behavior remains parity-green.
- New text/regex fallback debt is visible in one module.
- No new inline regex is added to policy controllers.

### Batch 6: Thin The Adapter

- [ ] Review `runViaReActEngine` and remove any remaining direct product-policy branches that now belong to a module.
- [ ] Leave only composition responsibilities:
  - build prompt/model/tool dependencies
  - instantiate observer/controllers/registries
  - build the ReAct hooks object
  - drain agent-core events
  - assemble `GeneratedRoleReply`
- [ ] Add a lightweight architecture test or lint-style test that fails if `packages/role-runtime/src/react-engine/*` imports `llm-response-generator.ts`.
- [ ] Add a source grep check in test or script form that flags new regex literals in `runViaReActEngine` if practical without false positives.
- [ ] Run all gates:

```bash
npm run typecheck
npx tsx --test packages/role-runtime/src/react-engine/*.test.ts
npx tsx --test packages/agent-core/src/*.test.ts
npm run parity:inline
npm run parity:engine
git diff --check
```

Expected output:

- Typecheck exit 0.
- React-engine unit tests pass.
- Agent-core tests pass.
- Inline parity 272/272.
- Engine parity 272/0/0-skip.
- `git diff --check` has no output.

## Acceptance Criteria For The Cleanup Campaign

The campaign is complete when all are true:

- `runViaReActEngine` is an adapter/composition function, not a policy implementation body.
- `EngineRunState` is the only mutable cross-hook run-state owner.
- Hook orchestration order is documented and pinned by a wiring test.
- `EnginePolicyTrace` is non-optional in engine mode and available in debug metadata behind the flag.
- Observability writes go through `EngineRunObserver`.
- Permission compatibility decisions go through `PermissionPolicy`.
- Tool-call normalization goes through `ToolCallNormalizer`.
- Final append/redaction logic goes through `FinalizationPipeline`.
- Execution cap, wall-clock, and batching behavior goes through `ExecutionBudgetController`.
- Continuation behavior goes through `ContinuationController`.
- Closeout precedence is declared by `ENGINE_CLOSEOUT_POLICY_ORDER`.
- Repair precedence is declared by repair registry order arrays.
- Completed closeout synthesis and completed repair loop go through `CompletedCloseoutController`.
- Facts and legacy text detectors are centralized in `EvidenceLedger`, `TaskFacts`, and `legacy-text-detectors.ts`.
- No `react-engine/*` module imports `llm-response-generator.ts`.
- No new regex or string-search policy is added directly to `runViaReActEngine`.
- No legacy text detector lacks target typed field, producer, feasibility class, and inventory/debt link.
- Engine parity remains 272/0/0-skip.
- Inline parity remains green.
- Typecheck remains green.

## Review Checklist

Use this checklist during code review:

- Does this module have one authority boundary, or is it mixing policy, execution, and observation?
- Does the module return a typed decision instead of mutating hidden closure state?
- Does the adapter apply mutable state only through `EngineRunState`?
- Is precedence declared in an exported order array or registry?
- Is cross-module hook order still identical to the Hook Orchestration Contract?
- Is every policy decision traceable by policy id and phase?
- Does any new code authorize a side effect from text/regex? If yes, reject it. Existing compatibility logic must be isolated and marked as typed-facts debt.
- Does any `react-engine/*` file import `llm-response-generator.ts`? If yes, reject it.
- Does `runViaReActEngine` get shorter and thinner after the batch?
- Do the parity gates prove behavior was preserved?
- Are typed facts used when present, with detector fallback isolated when not present?
- Are completed-closeout repairs and natural-finish repairs still distinguishable?

## Implementation Notes

- Work on one branch and use multiple sequential commits.
- Run full parity after each batch, not only at the end.
- Prefer moving existing code over rewriting predicates.
- Do not rename policy ids or marker strings unless tests are updated to prove no behavior drift.
- Do not start by deleting the inline path or flipping the default.
- Do not add another broad hook branch in `runViaReActEngine` to make extraction easier.
- If extraction reveals a behavior bug, pause the extraction, fix the bug in a separate commit with a parity test, then resume extraction.

## Suggested Commit Sequence

1. `stage8 cleanup: add react-engine module shell and contracts`
2. `stage8 cleanup: add policy trace characterization and wiring guards`
3. `stage8 cleanup: extract shared role-engine helper closure`
4. `stage8 cleanup: extract run state observer permission normalizer finalizer`
5. `stage8 cleanup: extract execution budget and continuation controllers`
6. `stage8 cleanup: extract closeout and repair registries`
7. `stage8 cleanup: extract completed closeout controller`
8. `stage8 cleanup: add evidence ledger and task facts facade`
9. `stage8 cleanup: thin engine adapter and add architecture guard`

Each commit should leave the repository typecheck-green. Commits 2 through 8 should leave both parity jobs green.
