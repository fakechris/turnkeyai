# Stage 8 ReAct Engine Architecture Spec

Status: design spec, not implementation.

This supersedes the old Stage 8 definition of "flip engine default and delete the inline loop". The latest full-suite probe showed that Stage 8 is not a cleanup step: the inline loop still contains product harness behavior that is not represented as explicit engine policies. Stage 8 is therefore a policy-layer re-architecture. The implementation strategy is parity-first: continuously close the engine behavior gap, then refactor the now-working policy surface into the layered architecture, then flip.

## Problem Statement

The current engine path has accumulated hooks that mirror slices of `LLMRoleResponseGenerator`, but the ownership boundary is still unclear. Several product behaviors remain implicit in the inline loop:

- tool-call normalization and repair prompts are interleaved with loop control
- permission and approval behavior is partly expressed as post-hoc rewrites
- browser/source evidence is often inferred from text instead of typed tool results
- session continuation is distributed across empty-round injection, post-execute continuation, timeout repair, and closeout synthesis
- final-answer repairs depend on subtle cascade order and round-specific evidence formulas

The architecture issue is not that deterministic rules exist. The issue is that TurnkeyAI has too many host-specific policies concentrated in one response-generator hot path, and too many facts are recovered with regex rather than carried as typed state.

Stage 8 must turn this into a layered harness without making the final parity run a big-bang discovery step.

## Operating Strategy

This spec defines the target architecture, but the migration order is deliberately conservative:

1. Make the full inline behavior suite runnable on the engine path with per-test timeout protection from day one.
2. Track engine parity as a continuous metric. The count of failing/hanging tests must move monotonically toward zero.
3. Port missing behavior into the current hook structure when that is the lowest-risk way to make the engine converge.
4. Refactor the working hook behavior into policy registries and ledgers layer by layer, using the green parity suite as the safety net.
5. Flip production only after parity is green and the non-negotiable safety invariants hold.

The layered T0-T11 design is the north star. The flip gate is not "all layers are perfectly extracted"; the flip gate is "engine parity is green, permission decisions happen before side-effect execution, and regex cannot authorize side effects." Layer extraction can continue after the flip if the rollback flag remains available during the soak window.

This is intentionally stricter than "clean while porting": when a missing normalizer or repair is blocking convergence, first make the engine behave correctly in the smallest reviewed slice, then move that behavior behind the proper policy boundary.

## Runtime Layering Requirements

TurnkeyAI's runtime requires an explicit separation of authority between conversation state, context assembly, model orchestration, tool execution, and memory maintenance.

### Layer C0: Conversation Controller

Authority:

- owns one conversation instance
- owns mutable conversation messages
- owns resume-sensitive transcript writes
- owns per-session runtime state such as read-file cache, discovered skills, loaded nested memory paths, permission denials, and total usage

Responsibilities:

- accept a user message
- build the prompt prefix for this turn
- persist the accepted user message before model execution
- stream SDK-visible events
- update mutable messages after assistant/tool/compact events
- truncate old state after compact boundaries

Explicit non-responsibilities:

- does not decide whether a tool call is semantically correct
- does not parse browser evidence
- does not implement final-answer repair predicates
- does not know individual tool business rules

Contract shape:

```ts
interface ConversationController {
  submitMessage(input: UserTurnInput): AsyncIterable<RuntimeEvent>;
  getMessages(): Message[];
  getReadFileState(): FileStateCache;
}
```

Design lesson for TurnkeyAI:

`LLMRoleResponseGenerator.generate()` should become a conversation/run controller. It may assemble dependencies, hold run state, record progress, and adapt the final result. It should not contain product policy logic inline.

### Layer C1: Context Prefix Builder

Authority:

- owns system prompt parts
- owns user context discovery
- owns system context capture
- owns memory prompt mechanics
- owns cache-prefix stability

Responsibilities:

- gather default system prompt, user context, and system context in parallel
- load rules and memory from managed, user, project, local, automatic, and team sources
- capture environment facts such as git status
- return prompt-prefix content that is not treated as ordinary chat history

Explicit non-responsibilities:

- does not mutate tool calls
- does not repair final answers
- does not execute tools
- does not decide permission outcomes

Contract shape:

```ts
interface ContextPrefixBuilder {
  build(input: ContextBuildInput): Promise<ContextPrefix>;
}

interface ContextPrefix {
  systemPrompt: string[];
  userContext: Record<string, string>;
  systemContext: Record<string, string>;
  cacheKeyFacts: Record<string, unknown>;
}
```

Design lesson for TurnkeyAI:

Prompt packet assembly, role memory, mission context, current date, selected tool definitions, and continuation hints should be produced by a dedicated context assembler. They should not be recomputed ad hoc inside every repair/normalizer.

### Layer C2: Generic ReAct Orchestrator

Authority:

- owns the model/tool turn loop
- owns compact-before-model sequencing
- owns message projection after compact boundaries
- owns loop-level cancellation and budget bookkeeping

Responsibilities:

- select messages after compact boundary
- apply tool-result budget, snip, microcompact, context collapse, autocompact
- call the model
- pass tool calls to execution layer
- append assistant/tool result messages
- decide when the generic loop is terminal

Explicit non-responsibilities:

- does not know browser evidence requirements
- does not know approval-gated browser semantics
- does not contain final-answer quality regexes
- does not parse tool output for product facts

Contract shape:

```ts
interface ReActOrchestrator<Ctx> {
  run(input: {
    messages: LLMMessage[];
    context: Ctx;
    tools: LLMToolDefinition[];
    hooks?: ReActHooks<Ctx>;
    signal?: AbortSignal;
  }): AsyncIterable<ReActEvent>;
}
```

Design lesson for TurnkeyAI:

`@turnkeyai/agent-core` should stay host-agnostic. It may expose lifecycle hooks, but it must not import role-runtime concepts. Host policy must live outside agent-core.

### Layer C3: Tool Capability Contract

Authority:

- tools declare their own schemas and execution semantics
- orchestration asks tools for facts instead of guessing from names/text

Responsibilities:

- input schema
- validation
- permission check
- concurrency safety
- read-only/destructive classification
- user interaction requirement
- result mapping
- result size behavior
- observable input backfill
- UI/transcript rendering
- classifier input

Explicit non-responsibilities:

- does not run global approval workflow by itself
- does not decide final answer quality
- does not know overall ReAct closeout order

Contract shape:

```ts
interface Tool<Input, Output, Ctx> {
  name: string;
  inputSchema: Schema<Input>;
  call(input: Input, ctx: Ctx): Promise<ToolResult<Output>>;
  validateInput?(input: Input, ctx: Ctx): Promise<ValidationResult>;
  checkPermissions(input: Input, ctx: Ctx): Promise<PermissionResult>;
  isConcurrencySafe(input: Input): boolean;
  isReadOnly(input: Input): boolean;
  isDestructive?(input: Input): boolean;
  requiresUserInteraction?(): boolean;
  mapToolResultToToolResultBlockParam(output: Output, id: string): ToolResultBlock;
}
```

Design lesson for TurnkeyAI:

TurnkeyAI's current `ToolResult.raw?: unknown` is too weak for Stage 8. Browser evidence, session state, approval state, source labels, timeout status, and side-effect status should be first-class typed fields, not information scraped from stringified JSON.

### Layer C4: Tool Execution Lifecycle

Authority:

- owns the execution lifecycle for one tool call or one executable batch

Responsibilities:

- resolve tool by name/alias
- validate schema
- run tool-specific validation
- run PreToolUse hooks
- resolve permission decision
- execute the tool
- run PostToolUse hooks
- run failure hooks
- map output to model-facing tool result
- preserve order for streamed/concurrent execution
- enforce concurrency safety from tool metadata
- emit telemetry

Permission pipeline:

1. schema validation
2. tool-specific `validateInput`
3. PreToolUse hooks
4. hook decision resolution
5. global permission rules/classifier/user prompt
6. tool execution
7. PostToolUse hooks
8. failure hooks if needed

Explicit non-responsibilities:

- does not repair final answers
- does not decide whether the model should continue after a timeout
- does not synthesize closeout answers

Design lesson for TurnkeyAI:

Approval and side-effect gating should be enforced before execution, as a permission decision. It should not depend on a later repair prompt after the model already asked for the wrong tool.

### Layer C5: Memory And Compaction Services

Authority:

- owns context pressure behavior and memory maintenance

Responsibilities:

- run session memory extraction as a post-sampling hook
- use isolated forked agents for memory maintenance
- enforce autocompact thresholds and recursion guards
- prefer session-memory compaction when available
- run cleanup after compaction
- preserve resume/cache semantics

Explicit non-responsibilities:

- does not run core tool calls for the main task
- does not encode product-specific final-answer quality rules

Design lesson for TurnkeyAI:

Memory/context maintenance should be background service behavior, not another branch in final-answer repair.

## Target TurnkeyAI Stage 8 Architecture

Stage 8 should produce these layers. The main success criterion is that each layer has a narrow authority boundary and a typed interface.

### T0: Role Run Controller

Target module:

- keep a thin shell in `packages/role-runtime/src/llm-response-generator.ts`
- move run assembly into `packages/role-runtime/src/react/role-run-controller.ts`

Authority:

- owns a single role run
- owns high-level result assembly
- owns interaction with gateway/model client
- owns runtime progress recorder integration
- owns feature flag/default selection during migration

Responsibilities:

- assemble context prefix
- assemble tool registry
- create `RolePolicyRuntimeContext`
- call `createReActAgent`
- drain/stream ReAct events into `GeneratedRoleReply`
- record run-level metadata
- apply final redaction guard

Forbidden:

- no regex-based product predicate
- no direct browser-evidence parsing
- no approval-specific rewrite
- no session-continuation branch
- no final-answer repair cascade

Contract:

```ts
export interface RoleRunController {
  generate(input: RoleRunInput): Promise<GeneratedRoleReply>;
}

export interface RoleRunInput {
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  selection: RoleModelSelection;
  signal?: AbortSignal;
}
```

### T1: Role Context Assembler

Target module:

- `packages/role-runtime/src/react/role-context-assembler.ts`

Authority:

- owns prompt/context construction for the role run

Responsibilities:

- produce initial messages
- produce system/user context equivalents
- attach mission/run/role facts
- load role memory
- compute task prompt facts once
- compute capability availability once
- expose cache-stable context facts

Forbidden:

- no tool-call normalization
- no final-answer repair
- no permission decision
- no closeout decision

Contract:

```ts
export interface RoleContextAssembler {
  build(input: RoleContextBuildInput): Promise<RoleContextEnvelope>;
}

export interface RoleContextEnvelope {
  messages: LLMMessage[];
  task: TaskFacts;
  capabilities: CapabilityFacts;
  memory: RoleMemoryFacts;
  continuationSeed: ContinuationSeed;
  cacheFacts: Record<string, unknown>;
}
```

### T2: Tool Capability Registry V2

Target modules:

- extend `packages/role-runtime/src/tool-capability-registry.ts`
- extend `packages/agent-core/src/tool.ts` only for generic fields if absolutely needed

Authority:

- owns typed tool semantics
- owns tool result decoding

Responsibilities:

- declare tool category
- declare read-only/destructive/side-effect class
- declare concurrency constraints
- declare approval requirement surface
- decode structured tool results into evidence/state facts
- expose result summary for model messages

Forbidden:

- no final answer repair
- no cross-round continuation decision
- no closeout synthesis

Contract:

```ts
export type ToolCategory =
  | "session"
  | "browser"
  | "permission"
  | "memory"
  | "web"
  | "task"
  | "utility";

export type SideEffectLevel = "none" | "read" | "write" | "external";

export interface RoleToolSemantics {
  category: ToolCategory;
  sideEffectLevel: SideEffectLevel;
  isConcurrencySafe(input: unknown): boolean;
  approvalSurface?: ApprovalSurface;
  evidenceEmitter?: EvidenceEmitterId;
  continuationEmitter?: ContinuationEmitterId;
}

export interface RoleToolDefinition extends Tool<RoleToolContext> {
  semantics: RoleToolSemantics;
  decodeResult?(result: ToolResult): RoleToolFact[];
}
```

Rule:

Any policy that needs to know "is this a browser side effect?", "does this result contain source labels?", or "did this session time out?" must first ask the typed tool facts. Regex fallback is allowed only when the producer does not yet emit the corresponding structured field, and the fallback must live in a detector module with fixtures and an explicit replacement field.

### T3: Evidence Ledger

Target module:

- `packages/role-runtime/src/react/evidence-ledger.ts`

Authority:

- owns structured evidence extracted from tool results

Responsibilities:

- record every tool result as typed facts
- expose source labels
- expose browser evidence dimensions
- expose completed session final text
- expose timeout/cancellation facts
- expose local/private URL evidence state
- expose evidence snapshots for repair/closeout policies

Forbidden:

- no tool execution
- no prompt mutation
- no final text generation

Contract:

```ts
export interface EvidenceLedger {
  recordRound(input: EvidenceRoundInput): EvidenceSnapshot;
  snapshot(): EvidenceSnapshot;
}

export interface EvidenceSnapshot {
  sourceLabels: SourceLabelFact[];
  browser: BrowserEvidenceFact[];
  sessions: SessionEvidenceFact[];
  permissions: PermissionEvidenceFact[];
  memory: MemoryEvidenceFact[];
  rawTextFallbacks: TextEvidenceFallback[];
}
```

Browser evidence dimensions must become structured facts:

```ts
export interface BrowserEvidenceFact {
  sessionId?: string;
  url?: string;
  title?: string;
  visibleText?: string;
  viewport?: { width: number; height: number };
  iframeCount?: number;
  shadowRootCount?: number;
  productSignals?: string[];
  screenshots?: Array<{ id: string; label?: string }>;
  formSubmissions?: Array<{ status: "attempted" | "submitted" | "blocked"; summary: string }>;
}
```

This is the main way to reduce regex debt.

Producer feasibility gate:

Before treating typed evidence as a foundation phase, inventory the actual producer payloads:

- `session_tool_result.v1` for session status, timeout, cancellation, completed final contents, and source labels
- browser worker result payloads for URL/title/viewport/iframe/shadow-DOM/product-signal/form-submission facts
- explore/web worker result payloads for source labels and bounded evidence summaries
- permission tool result payloads for query/decision/applied status

For each desired fact, classify it as:

- `already_structured`: implement `decodeResult`
- `present_only_as_text`: add a fixture-tested detector as interim debt
- `missing_from_producer`: create a producer-side task and keep the detector or existing text policy isolated until the producer is fixed

Stage 8 must not block all parity work on a producer rewrite. The immediate target is to stop spreading ad hoc regex; typed producers can land incrementally.

### T4: Permission And Approval Policy

Target module:

- `packages/role-runtime/src/react/policies/permission-policy.ts`

Authority:

- owns allow/deny/ask/rewrite decisions before execution
- owns approval-gated browser side-effect enforcement

Responsibilities:

- filter available tools for the task
- rewrite illegal browser side-effect calls into permission queries when appropriate
- reject/skip calls that violate approval state
- produce synthetic denied/skipped results
- process permission query/decision/applied results into policy state
- enforce local/private URL policy before execution

Forbidden:

- no final-answer repair
- no source-evidence carry-forward
- no completed-session closeout synthesis

Contract:

```ts
export type PermissionDecision =
  | { kind: "allow"; calls: LLMToolCall[] }
  | { kind: "rewrite"; calls: LLMToolCall[]; reason: string }
  | { kind: "reject"; rejected: ToolResult[]; executable: LLMToolCall[]; reason: string }
  | { kind: "ask"; calls: LLMToolCall[]; prompt: LLMMessage };

export interface PermissionPolicy {
  filterTools(tools: LLMToolDefinition[], ctx: RolePolicyRuntimeContext): LLMToolDefinition[];
  evaluateBeforeExecute(calls: LLMToolCall[], ctx: RolePolicyRuntimeContext): PermissionDecision;
  observeResults(results: ToolResult[], ctx: RolePolicyRuntimeContext): void;
}
```

Permission ordering:

1. static tool availability filtering
2. tool-call normalization that does not change permission semantics
3. approval rewrites into permission tools
4. pre-execute allow/reject/synthetic result split
5. tool execution
6. observe permission result facts
7. post-execute continuation if approval state demands it

The invariant is simple: policy decisions must happen before side-effect execution.

### T5: Continuation Policy

Target module:

- `packages/role-runtime/src/react/policies/continuation-policy.ts`

Authority:

- owns session continuation state machine

Responsibilities:

- detect user continuation intent from task/context facts
- decide empty-round forced `sessions_send`
- decide timeout follow-up continuation
- decide session lookup/list continuation
- avoid duplicate continuation calls
- consume completed/cancelled/timeout session facts

Forbidden:

- no browser side-effect approval decision
- no final-answer quality repair
- no source evidence policy

Contract:

```ts
export type ContinuationAction =
  | { kind: "none" }
  | { kind: "injectCalls"; calls: LLMToolCall[] }
  | { kind: "rePrompt"; messages: LLMMessage[]; forceToolChoice?: ReActToolChoice }
  | { kind: "closeout"; reason: CloseoutReason };

export interface ContinuationPolicy {
  beforeModel(state: ReActState, ctx: RolePolicyRuntimeContext): ContinuationAction;
  onEmptyRound(state: ReActState, ctx: RolePolicyRuntimeContext): ContinuationAction;
  afterExecute(results: ToolResult[], state: ReActState, ctx: RolePolicyRuntimeContext): ContinuationAction;
}
```

State machine:

```ts
export type SessionContinuationState =
  | { status: "idle" }
  | { status: "awaiting_context"; sessionId?: string }
  | { status: "needs_lookup"; labels: string[] }
  | { status: "continuing"; sessionId: string; reason: string }
  | { status: "timed_out"; sessionId: string; recoverable: boolean }
  | { status: "cancelled"; sessionId: string; userAskedToContinue: boolean }
  | { status: "completed"; sessionId: string; evidenceId: string };
```

Required transition-table deliverable:

```ts
export interface ContinuationTransition {
  from: SessionContinuationState["status"];
  event:
    | "user_asked_continue"
    | "empty_round"
    | "lookup_result"
    | "sessions_send_result"
    | "sessions_spawn_result"
    | "timeout_detected"
    | "cancelled_detected"
    | "completed_detected"
    | "approval_pending"
    | "approval_applied";
  guard?: string;
  to: SessionContinuationState["status"];
  action: "none" | "inject_call" | "append_prompt" | "closeout" | "repair";
}
```

The continuation policy is not accepted with only a state enum. It must include a transition table and fixture tests for every transition, including no-op transitions. This is where most continuation regressions occur.

### T6: Tool-Call Normalization Policies

Target module:

- `packages/role-runtime/src/react/policies/tool-call-normalizers.ts`

Authority:

- owns syntactic and routing normalization before permission/execution

Responsibilities:

- tool alias normalization
- explicit continuation history calls
- session tool call shape normalization
- private/local URL routing
- bounded timeout source spawn routing
- duplicate source spawn suppression
- independent evidence spawn limiting

Forbidden:

- no permission decision
- no final-answer repair
- no closeout synthesis
- no execution

Contract:

```ts
export interface ToolCallNormalizer {
  id: string;
  order: number;
  normalize(input: {
    calls: LLMToolCall[];
    state: ReActState;
    ctx: RolePolicyRuntimeContext;
  }): LLMToolCall[];
}
```

Rule:

Normalizers may rewrite pending calls, but they may not append messages or record repair prompts. If a rewrite requires a user-visible explanation or repair marker, it belongs in PermissionPolicy, ContinuationPolicy, or RepairPolicy.

### T7: Execution Planner

Target module:

- `packages/role-runtime/src/react/execution-planner.ts`

Authority:

- owns how executable calls are grouped and timed

Responsibilities:

- max parallel calls
- serialization for order-dependent tools
- max tool calls per round
- wall-clock budget signals
- abort propagation
- result ordering

Forbidden:

- no policy rewrite based on natural language
- no final-answer repair
- no evidence interpretation beyond tool semantics needed for execution

Contract:

```ts
export interface ExecutionPlanner {
  plan(calls: LLMToolCall[], ctx: RolePolicyRuntimeContext): ExecutionPlan;
}

export interface ExecutionPlan {
  chunks: Array<{
    calls: LLMToolCall[];
    maxWallClockMs?: number;
    serial: boolean;
  }>;
  rejected?: ToolResult[];
}
```

### T8: Closeout Policy Registry

Target module:

- `packages/role-runtime/src/react/policies/closeout-policies.ts`

Authority:

- owns terminal closeout reasons and their precedence

Responsibilities:

- pending-call closeouts
- post-execute closeouts
- round-limit closeout
- model-error fallback closeout
- completed-session closeout
- timeout closeout
- recovery-budget closeout

Forbidden:

- no low-level tool execution
- no permission ask/allow/deny
- no normalizer rewrite

Contract:

```ts
export type CloseoutPhase =
  | "pre_model"
  | "pending_calls"
  | "post_execute"
  | "model_error"
  | "round_limit";

export interface CloseoutPolicy {
  id: CloseoutReason;
  phase: CloseoutPhase;
  order: number;
  evaluate(input: CloseoutInput, ctx: RolePolicyRuntimeContext): CloseoutDecision | null;
}

export interface CloseoutDecision {
  reason: CloseoutReason;
  reasonLines: string[];
  evidenceAvailable: boolean;
  metadata: Record<string, unknown>;
}
```

Precedence must live in one registry, not in hook closure order:

```ts
export const CLOSEOUT_POLICY_ORDER = [
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
] as const;
```

### T9: Candidate Answer Repair Policy Registry

Target module:

- `packages/role-runtime/src/react/policies/answer-repair-policies.ts`

Authority:

- owns repairs for candidate final answers before finalization

Responsibilities:

- missing requested table columns
- extraneous schema/table claims
- source evidence carry-forward
- weak evidence synthesis
- false evidence blocked synthesis
- missing requested next action
- missing required final deliverables
- missing browser evidence dimensions
- timeout follow-up recovery guidance when it is a synthesis quality issue

Forbidden:

- no execution of side-effect tools
- no permission decision
- no tool-call normalizing

Contract:

```ts
export interface AnswerRepairPolicy {
  id: RepairId;
  phase: "natural_finish" | "completed_closeout" | "error_closeout";
  order: number;
  evaluate(input: CandidateAnswerInput, ctx: RolePolicyRuntimeContext): RepairDecision | null;
}

export interface RepairDecision {
  id: RepairId;
  marker: RepairMarker;
  messages: LLMMessage[];
  forceToolChoice?: ReActToolChoice;
  consumesRound?: boolean;
  evidenceFormula: "candidate_final" | "source_bounded" | "completed_round";
}
```

Rules:

- every repair policy must declare its evidence formula
- every repair must emit a stable repair marker
- marker state must live in `RepairLedger`, not by scanning raw messages
- completed-closeout repairs must be round-gated explicitly
- policies that need browser dimensions must use `EvidenceSnapshot.browser`

### T10: Finalization Policy

Target module:

- `packages/role-runtime/src/react/policies/finalization-policy.ts`

Authority:

- owns final text transforms after the answer is selected

Responsibilities:

- forbidden local URL redaction
- timeout continuation visibility appendix
- required follow-up visibility appendix
- residual-risk visibility appendix
- failure-bucket visibility appendix
- metadata shaping that does not change model-visible reasoning

Forbidden:

- no repair re-prompt
- no tool execution
- no new evidence parsing

Contract:

```ts
export interface FinalizationPolicy {
  finalize(input: {
    text: string;
    closeout?: CloseoutDecision;
    evidence: EvidenceSnapshot;
    ctx: RolePolicyRuntimeContext;
  }): FinalizedAnswer;
}
```

### T11: Policy Runtime Context

Target module:

- `packages/role-runtime/src/react/role-policy-context.ts`

Authority:

- owns typed state shared across policy hooks

Responsibilities:

- expose read-only run facts
- expose mutable ledgers with narrow methods
- prevent arbitrary hook closures from inventing side state

Contract:

```ts
export interface RolePolicyRuntimeContext extends RoleToolContext {
  run: {
    runId: string;
    startedAtMs: number;
    maxRounds: number;
    activeToolLoop?: RoleToolLoopOptions;
  };
  task: TaskFacts;
  capabilities: CapabilityFacts;
  evidence: EvidenceLedger;
  continuation: ContinuationStateStore;
  approvals: ApprovalStateStore;
  repairs: RepairLedger;
  closeouts: CloseoutStore;
  execution: ExecutionBudgetState;
  trace: ToolTraceLedger;
}
```

Mutation rule:

Only stores/ledgers expose mutation methods. Policy functions must not push arbitrary fields onto `ctx`. This prevents the current "captured mutable run object" pattern from growing into another hidden spaghetti layer.

## Hook Assembly Contract

Target module:

- `packages/role-runtime/src/react/role-react-policy.ts`

The hook assembly layer is an adapter. It translates agent-core lifecycle events into policy registry calls. It must not contain product predicates inline.

Allowed in hook assembly:

- call policy registries in declared order
- map policy decisions to `ReActHooks`
- update ledgers through typed methods
- bridge tool results into evidence ledger
- adapt closeout decisions to `generateFinalAfterToolRoundLimit`

Forbidden in hook assembly:

- regex checks
- direct `taskPrompt.includes(...)` policy
- hand-built closeout reason lines except by delegating to a policy
- direct browser/source evidence parsing
- new mutable fields outside `RolePolicyRuntimeContext`

Contract sketch:

```ts
export function buildRoleReActHooks(deps: RolePolicyDeps): ReActHooks<RolePolicyRuntimeContext> {
  const policies = buildRolePolicyRegistry(deps);
  return {
    filterTools: (tools, ctx) => policies.permissions.filterTools(tools, ctx),
    onRoundMessages: (messages, round, ctx) => policies.beforeModel({ messages, round }, ctx),
    onToolCalls: (calls, round, ctx) => policies.normalizers.normalize({ calls, round }, ctx),
    onSuppressToolCalls: (calls, state, ctx) => policies.suppressors.evaluate({ calls, state }, ctx),
    onToolCallsClose: (calls, state, ctx) => policies.closeouts.evaluate("pending_calls", { calls, state }, ctx)?.reason ?? null,
    onRoundEmpty: (state, ctx) => policies.continuation.onEmptyRound(state, ctx),
    onBeforeExecute: (calls, ctx) => policies.permissions.evaluateBeforeExecute(calls, ctx),
    runToolBatch: (calls, runOne, ctx) => policies.execution.runBatch(calls, runOne, ctx),
    onAfterExecuteContinue: (results, state, ctx) => policies.continuation.afterExecute(results, state, ctx),
    onAfterExecute: (results, state, ctx) => policies.closeouts.evaluate("post_execute", { results, state }, ctx)?.reason ?? null,
    onRepairRound: (state, ctx) => policies.repairs.evaluateCandidate(state, ctx),
    onTerminate: (reason, state, ctx) => policies.closeoutSynthesis.synthesize(reason, state, ctx),
    onModelCallError: (error, state, ctx) => policies.modelError.evaluate(error, state, ctx),
    onFinalize: (text, state, ctx) => policies.finalization.finalize({ text, state, ctx }).text,
  };
}
```

## Regex Governance

Regex is allowed only in detector modules. It is not allowed in hook assembly or controller code.

Required detector contract:

```ts
export interface TextDetector<TFact> {
  id: string;
  source: "user_prompt" | "model_text" | "legacy_tool_result_text";
  detects: string;
  preferStructuredField?: string;
  detect(text: string): TFact[];
}
```

Rules:

- Every detector must state what structured field would replace it.
- Every detector must have positive and negative fixtures.
- A policy may use a detector only when the corresponding structured fact is absent.
- New browser/source/session detectors must include a producer-status classification: `already_structured`, `present_only_as_text`, or `missing_from_producer`.
- Regex must never be used to decide whether an already executed side effect is authorized.

## Stage 8 Work Plan

Stage 8 becomes a sequence, not a single PR.

### Stage 8A: Inventory, Policy Map, And Continuous Parity Harness

Deliverables:

- enumerate every remaining inline behavior in `LLMRoleResponseGenerator`
- classify each as context, normalizer, permission, continuation, execution, evidence, closeout, repair, finalization, observability, or deletion candidate
- record current inline precedence
- identify typed facts needed to remove regex fallback
- run the full inline behavior suite on the engine path with per-test timeouts so hangs become categorized failures
- publish a parity dashboard/table: pass, fail, hang, timeout, skipped, and target layer

Gate:

- no code movement yet except docs/tests helpers
- inventory reviewed before extraction
- full-suite engine parity job exists, even if initially red/non-blocking
- every hang has a timeout-capped reproduction and target-layer classification

### Stage 8B: Parity Patchline In Current Hook Structure

Deliverables:

- port the missing normalizers, repairs, envelope/memory/compaction behavior, and deferred-fixture rows needed for engine convergence
- prefer existing hook seams over new abstraction until the full suite is green
- keep every port as a small PR with a parity test and mutation/cross-fire check where applicable
- do not move broad policy structure yet unless the move is necessary to make the behavior testable
- classify each fixed parity gap against the target T0-T11 layer for later extraction

Gate:

- full-suite engine failures/hangs monotonically decrease
- no new unbounded/hanging engine scenarios
- no new side-effect authorization via regex
- inline suite remains green

### Stage 8C: Typed Facts Feasibility And Evidence Ledger

Deliverables:

- inventory actual producer payloads for session/browser/permission/web evidence
- classify every desired evidence fact as `already_structured`, `present_only_as_text`, or `missing_from_producer`
- add `RoleToolSemantics` where it can be populated without producer changes
- add `decodeResult` for already-structured session/browser/permission/memory/web facts
- introduce `EvidenceLedger`
- isolate interim text detectors for facts that are not yet structured

Gate:

- existing tests green
- new evidence-ledger unit tests
- detector fixtures cover every `present_only_as_text` fallback
- producer-side missing fields have tracked follow-up tasks
- no behavior change in inline path

### Stage 8C.1: Neutral Shared Helper Extraction

Deliverables:

- extract pure text, URL, session-continuation, browser-evidence, approval-gate detector, and compatibility normalizer helpers shared by inline and engine code into a neutral role-runtime module outside `react-engine/`
- make both the inline reference path and later `react-engine/*` modules import the same neutral helpers
- preserve helper logic, strings, regexes, and call order exactly; this stage relocates shared code only
- keep `react-engine/*` forbidden from importing `llm-response-generator.ts`
- keep the inline path forbidden from importing engine policy/controller modules

Gate:

- typecheck green
- inline parity green
- engine parity 272/0/0-skip
- no behavior change in inline path beyond parity-proven import-site relocation
- no helper is exported from `llm-response-generator.ts` to satisfy engine imports

### Stage 8D: Policy Runtime Context

Deliverables:

- introduce `RolePolicyRuntimeContext`
- move ad hoc hook closure state into typed stores
- replace `repairMarkers?: LLMMessage[]` with `RepairLedger`
- create `CloseoutStore`, `ApprovalStateStore`, `ContinuationStateStore`
- add policy decision tracing so a failed test can explain which policy fired or did not fire

Gate:

- no hook contains new untyped mutable blobs
- existing engine parity tests green
- representative debug drill: "why did this repair/closeout not fire?" is answerable from policy trace without stepping through a 12-layer call chain

### Stage 8E: Permission And Approval Policy Extraction

Deliverables:

- move approval-gated browser behavior into `PermissionPolicy`
- move local/private URL gating into permission/routing policies
- make approval rewrites pre-execute decisions
- preserve existing Stage 7 parity tests

Gate:

- mutation tests for approval bypass
- side-effect tools cannot execute without allow decision
- regex is not used to authorize or retroactively validate a side effect

### Stage 8F: Continuation State Machine Extraction

Deliverables:

- move empty-round continuation injection into `ContinuationPolicy`
- move timeout follow-up and lookup continuation into the same state machine
- centralize duplicate continuation suppression
- add the required transition table
- retire deferred continuation fixture debt from Stage 7 b2/b3, S9 post-execute, and S10 product-signal once the corresponding normalizers are ported

Gate:

- continuation tests cover completed, timeout, cancelled, lookup, approval, and no-op states
- transition-table fixture tests pass
- parity suite remains green or the failure count decreases in the same PR

### Stage 8G: Closeout And Repair Registries

Deliverables:

- move closeout precedence into `CloseoutPolicyRegistry`
- move natural-finish and completed-closeout repair cascades into `AnswerRepairPolicyRegistry`
- require every repair to declare evidence formula and marker
- move browser-evidence-dimensions into typed evidence-backed policy or an explicitly classified detector fallback

Gate:

- per-policy unit tests
- parity tests for compound/cross-fire scenarios
- no repair predicate reads raw `LLMMessage[]` unless through a named `MessageWindow`
- no closeout precedence exists only in hook closure order

### Stage 8H: Hook Assembly Thinning

Deliverables:

- rewrite `buildRoleReActHooks` or current inline hook object to only call registries
- delete inline policy logic from `runViaReActEngine`
- keep `llm-response-generator.ts` as controller/adapter only

Gate:

- `role-react-policy.ts` contains no regex
- hook assembly contains no product predicate body longer than adapter glue

### Stage 8I: Engine Flip And Soak

Deliverables:

- confirm the full inline behavior suite is green under `TURNKEYAI_REACT_ENGINE=engine`
- switch composition root default to engine
- retain rollback flag for one soak window
- delete inline loop only after the soak window and after the remaining mandatory policy inventory rows are closed

Gate:

- full suite green in inline mode
- full suite green in engine mode
- typecheck green
- e2e smoke green
- no unresolved flip-blocking inventory rows
- permission-before-execution invariant holds
- regex-never-authorizes-side-effects invariant holds

## Acceptance Criteria

Stage 8 is complete only when all of these are true:

- `LLMRoleResponseGenerator` no longer owns policy decisions
- `agent-core` remains host-agnostic
- every product rule has a policy id, phase, order, input facts, output decision, and tests
- browser/source/session evidence policies read typed facts when present; any text fallback is isolated in a detector with fixtures and producer-status classification
- regex detectors are isolated and fixture-tested
- permission decisions happen before execution
- regex never authorizes or retroactively validates side effects
- closeout precedence is declared in one registry
- repair idempotency uses `RepairLedger`
- full inline suite passes on engine path
- production default flips only after parity is proven
- a representative policy-debug drill is documented: for a missed repair/closeout, the trace identifies the evaluated policies, skipped guards, and selected decision

## Implementation Instructions For The Next Agent

Do not start by flipping the default.

Start with Stage 8A inventory. The output should be a table with columns:

- inline location
- behavior name
- current trigger
- current action
- current precedence
- target layer
- required typed facts
- existing tests
- missing tests
- migration PR

Then close the parity gap in small PRs. Use the current hook structure when that is the lowest-risk path to make the engine converge. Once a behavior is ported and covered by parity tests, move it behind the proper policy registry/ledger. If a policy extraction requires adding another `if` chain to `llm-response-generator.ts`, stop and move the decision into a policy registry instead.
