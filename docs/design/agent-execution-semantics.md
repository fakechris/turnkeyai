# Agent Execution Semantics

Status: V2 design constitution. It defines migration acceptance criteria, not a
second implementation roadmap and not proof that the current runtime conforms.

## Purpose

TurnkeyAI needs an execution model that remains correct when models, tools,
latency distributions, context windows, and task domains change. Runtime
correctness must not be learned by adding scenario detectors after real-model
failures.

The target is a tool-capable model loop inside a durable service
envelope:

```text
model proposes typed effects
-> kernel admits and records effect intents
-> an executor performs admitted effects
-> receipts and transcript events are persisted
-> model proposes more effects or ends the attempt
```

Durability, background work, restart, metrics, and quality evaluation surround
that loop. They do not redefine it.

## Guarantees And Non-Guarantees

The runtime cannot guarantee that an arbitrary model understands a task,
chooses the best tool, or writes a good answer. Those are measured model
outcomes.

The runtime does guarantee that model behavior remains inside a bounded,
replayable protocol without contradictory terminal states, hidden work
creation, observer-driven behavior, or blind re-execution of an effect whose
outcome is unknown.

Exactly-once external side effects are not generally implementable without
cooperation from the external system. The enforceable contract is:

- stable effect identity;
- durable intent before execution;
- idempotency keys or provider reconciliation when available;
- at-most-once automatic dispatch after an ambiguous crash;
- an explicit `indeterminate` outcome when the external result cannot be
  proven.

## Minimal Model Loop

The normative loop for one active attempt is:

```ts
while (!attempt.signal.aborted) {
  const messages = compactIfNeeded(transcript.project());
  const response = await model.call(messages, availableTools, attempt.signal);
  transcript.append(response);

  if (response.toolCalls.length === 0) {
    return completeAttempt(response.text, response.stopReason);
  }

  const receipts = await effects.execute(response.toolCalls, attempt);
  transcript.append(receipts);
}
```

The loop may enforce protocol, permission, idempotency, cancellation, and
resource bounds. It must not infer product intent, inject recovery work, grade
answer quality, or wait for observers to settle.

## Durable Scopes And Ephemeral Attempts

A durable scope owns identity, parentage, result delivery, and calendar
lifetime. An attempt is one bounded period of active compute within that
scope. Separating them prevents approval waits, process downtime, and provider
calls from sharing one ambiguous timer.

```ts
interface DurableScope {
  scopeId: string;
  parentScopeId?: string;
  ownership: "attached" | "detached";
  expiresAt?: number;
  state: ScopeState;
}

type ScopeState =
  | { kind: "running"; attemptId: string }
  | {
      kind: "suspended";
      handle: string;
      waitKind: "external_input" | "detached_result" | "scheduled_resume";
    }
  | { kind: "succeeded"; resultRef: string }
  | { kind: "failed"; errorCode: string }
  | { kind: "cancelled"; reason: string };

interface Attempt {
  attemptId: string;
  scopeId: string;
  startedAt: number;
  deadlineAt?: number;
  state:
    | "running"
    | "yielded"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "indeterminate";
  budget: AttemptBudget;
}
```

Only `succeeded`, `failed`, and `cancelled` scope states are terminal.
`indeterminate` is an attempt/effect outcome that requires reconciliation or
operator input; it is not silently converted into success or failure.

### Ownership

- An attached child must finish, detach, or be cancelled before its parent
  succeeds.
- A detached child is owned by a durable task registry and cannot block its
  former parent.
- Detaching is a persisted state transition, not a timeout or failure.
- Detached completion is delivered to a durable inbox through a stable result
  handle.
- A process restart does not change attached/detached ownership.

### Suspension And Resume

Waiting for approval or other external input ends the current active attempt
with `yielded` and suspends the durable scope. No attempt clock runs while the
scope is suspended. The scope's explicit `expiresAt`, if configured, continues
to run as a calendar TTL.

Resume requires a new explicit input or declared workflow wake event and a new
attempt budget grant. It does not enlarge or rewrite the historical attempt.
A user saying "continue for another ten minutes" creates a new attempt grant;
it does not mutate the old deadline.

## Typed Effects And Commit Protocol

The model or an explicit workflow may propose typed effects:

```ts
type EffectProposal =
  | { kind: "call_tool"; effectId: string; tool: string; input: unknown }
  | { kind: "spawn_child"; effectId: string; task: string }
  | { kind: "send_to_child"; effectId: string; handle: string; message: string }
  | { kind: "detach_child"; effectId: string; handle: string }
  | { kind: "join_child"; effectId: string; handle: string };
```

Every externally visible effect has a stable `effectId`. Its ledger state is:

```text
proposed -> admitted -> started -> committed
                       |          -> failed
                       -> indeterminate
```

The required protocol is:

1. Validate the proposal and append a durable `effect_admitted` intent.
2. Dispatch with the stable effect id as an idempotency key when supported.
3. Append a durable committed or failed receipt.
4. On restart, reconcile every `started` effect with the provider or tool.
5. If the outcome cannot be established, record `indeterminate` and do not
   dispatch it again automatically.

Crash windows have explicit meaning:

| Crash point | Recovery action |
| --- | --- |
| Before durable intent | No effect exists; a later proposal may create it |
| After intent, before dispatch | Safe to dispatch the admitted intent once |
| After dispatch, before receipt | Query provider by idempotency key; otherwise mark indeterminate |
| After receipt | Return the durable prior receipt |

This is stronger and more honest than claiming that deterministic reducer
replay alone proves exactly-once execution.

Policies may allow, deny, or constrain a proposal. They cannot create another
proposal. Timeout, malformed output, weak evidence, or quality scores cannot
manufacture a retry, fallback tool, child session, prompt, or closeout. The
model or an explicit workflow definition must propose new business work.

## Budget And Retry Algebra

Attempt resources compose monotonically:

```ts
interface AttemptBudget {
  activeMs?: number;
  maxTurns?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxCost?: number;
  maxConcurrency?: number;
}
```

Each finite child value is the minimum of its parent allowance, explicit
request, platform cap, and safety constraint:

```text
effective = parent AND explicit AND platform AND safety
```

Therefore a child attempt cannot receive more active resource than its parent
allows, and an explicit 25 second operation limit cannot become 120 seconds.
Model profiles may suggest defaults but cannot override an explicit or parent
bound.

Retries are not a scalar budget field and do not participate in this meet.
They are consumable capabilities owned by one layer per failure domain:

```ts
interface RetryAllowance {
  allowanceId: string;
  ownerScopeId: string;
  failureDomain: "model_transport" | "tool_transport" | "workflow_step";
  remainingAttempts: number;
}
```

- exactly one owner consumes an allowance for a failure domain;
- lower layers return typed errors and may not add hidden retries;
- provider SDK retry, owner retry, repair round, and E2E rerun cannot multiply
  the same allowance;
- a new user/workflow attempt may receive a new allowance explicitly.

## Time Semantics

`timeout` is not a state. Five distinct events are used:

| Event | Meaning | Required effect |
| --- | --- | --- |
| `wait_elapsed` | A caller stopped waiting | Return `not_ready`; owned work continues |
| `operation_expired` | One provider/tool attempt exceeded active budget | End that attempt |
| `scope_expired` | Durable scope calendar TTL elapsed | Cancel attached descendants and persist terminal result |
| `suspended` | Active attempt yielded for external input | Stop attempt clock; preserve durable handle |
| `idle_stalled` | No progress during a diagnostic window | Emit diagnostics only |

Foreground wait, active compute, and durable task lifetime never share one
timer. Liveness is an observation and cannot expire execution.

## Detached Results, Inbox, And Join

Detached completion produces a durable notification:

```ts
interface InboxNotification {
  notificationId: string;
  ownerScopeId: string;
  sourceScopeId: string;
  resultRef: string;
  state: "pending" | "consumed";
}
```

The inbox is owned by the durable mission/thread registry, not by the process
that launched the child. A terminal parent may still have pending inbox items.
The next user turn or an explicitly declared workflow wake may consume them.
Merely enqueuing a notification must not invoke a model.

Joining a detached child creates a durable join record and suspends the joining
scope. If the joining scope expires, only the join is abandoned; the detached
child remains registry-owned and its eventual result remains in the inbox. A
child completion satisfies the join but does not create a new compute attempt;
an explicit resume grant is still required.

## Minimal Explicit Workflow

An explicit workflow is data, not an ad hoc policy callback:

```ts
interface WorkflowStep {
  stepId: string;
  trigger: "user_input" | "effect_receipt" | "inbox_notification" | "schedule";
  allowedEffects: readonly string[];
  join: "attached" | "detached" | "none";
  attemptBudget: AttemptBudget;
  retryAllowanceIds: readonly string[];
  nextStepIds: readonly string[];
}
```

Workflow transitions are explicit persisted inputs. They may propose declared
effects but may not derive new steps from task wording, final-answer quality,
or fixture-specific markers. Task intent extraction may help the model or
workflow author build a workflow; it is not kernel authority.

## Transcript And Compaction

The journal records model messages, tool-call intents, and tool receipts with
stable ids. A tool call and its result form one protocol unit. Compaction may
replace only complete units with a typed summary; it must preserve every open
tool call and may not retain a result after deleting its call.

Journal writes use committed frames or equivalent transactional storage.
Replay ignores torn, uncommitted frames. Deterministic reduction proves only
that the same committed event stream yields the same state; separate tests are
required for event production, crash windows, and external reconciliation.

## Completion

A query attempt completes on one authoritative event:

- model end-turn with zero proposed effects;
- explicit cancellation;
- exhausted hard attempt or scope budget;
- unrecoverable protocol or transport failure;
- suspension with a durable resumable handle.

Completion does not require detached tasks, telemetry, liveness projections,
quality checks, cleanup projections, a phrase, evidence count, or tool sequence
to settle. Terminal transitions are irreversible. Late events enter the audit
journal or inbox but cannot reopen a terminal scope without new explicit input.

## Durability And Reconciliation

Restart performs:

```text
load committed journal frames
-> reduce durable scopes, attempts, effects, joins, and inbox
-> reconcile started effects by stable id
-> mark unresolved outcomes indeterminate
-> resume only explicitly authorized non-terminal work
```

Reconciliation is level-triggered and idempotent. It computes the smallest
mechanical transition needed to honor persisted ownership. It does not infer
the user's next business action or synthesize recovery prompts.

## Observers And Model Profiles

Metrics, liveness, quality evaluation, E2E scoring, and diagnostics are
read-only journal consumers:

```text
execution(events, observers=on) == execution(events, observers=off)
```

Observers may page an operator or recommend a new explicit command. They may
not dispatch work, alter budgets, change scope state, or block terminal result
delivery.

Model profiles contain measured context, protocol, latency, cache, and error
distributions. They may select adapters, defaults, compaction thresholds, and
foreground wait preferences. They cannot modify state algebra, ownership,
effect reconciliation, completion, or budget laws.

## Proof Obligations

Every implementation must continuously test:

1. A committed effect receipt is returned for duplicate effect ids.
2. A started effect without a receipt is reconciled or becomes indeterminate,
   never blindly redispatched.
3. Terminal scopes execute no new model or tool work.
4. Attached children cannot become orphans.
5. Detached children cannot block parent completion.
6. Cancellation propagates to attached descendants only.
7. Attempt budgets are never enlarged by composition.
8. Suspension stops active-attempt time but not an explicit durable TTL.
9. One failure domain has one retry owner and consumable allowance.
10. Replay of one committed journal produces one state; torn frames are ignored.
11. Observer presence does not change execution.
12. Compaction preserves tool-call/tool-result protocol units.
13. Detached completion remains consumable after parent termination.
14. Parent join expiry does not cancel detached work.
15. Every stopped process leaves a terminal result, indeterminate receipt, or
    durable resumable handle.

Natural E2E tests measure model quality after these laws pass. They do not
define the laws.

## Architectural Enforcement

```text
model/tool adapters -> typed proposals -> execution kernel -> journal
workflow inputs     --------------------^                  |
safety constraints  --------------------^                  v
                                            read-only observers/evaluators
```

Required structural rules:

- the kernel cannot import model-specific policy, prompt, metrics, quality, or
  E2E modules;
- observers cannot import mutating stores or dispatch services;
- policies return constraints only and cannot invoke tools or models;
- adapters translate protocols but cannot decide business recovery;
- all terminal writes and effect transitions pass through the kernel;
- changes to the kernel require model-independent counterexamples and
  invariant tests.

## Evidence Standard

The reference simulator is executable design evidence, not a proof of
production correctness. A design claim is accepted only to the strength of the
state represented in the simulator.

In particular:

- reducer determinism does not prove external effect exactly-once;
- random traces do not cover omitted state dimensions;
- passing real LLM scenarios does not prove execution semantics;
- failing one real LLM scenario is not permission to add a runtime rule.

This V2 constitution is ready to constrain a single migration plan after
[Runtime Policy Disposition](./runtime-policy-disposition.md) and
[Execution Semantics And Six-Phase Reconciliation](./execution-semantics-six-phase-reconciliation.md)
are reviewed. Policy-action migration additionally requires the signed
[Runtime Policy Migration Product Decision](./runtime-policy-migration-product-decision.md).
It does not authorize a parallel migration line.
