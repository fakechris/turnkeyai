# Agent Execution Semantics

Status: design reference, not a production migration plan.

## Purpose

TurnkeyAI needs an execution model that remains correct when models, tools,
latency distributions, context windows, and task domains change. The runtime
must not learn correctness by adding scenario detectors after real-model
failures.

The target is a Claude Code-shaped model loop with a durable service envelope:

```text
model proposes typed effects
-> runtime validates and commits effects
-> tools produce typed results
-> transcript records both
-> model either proposes more effects or ends the turn
```

Durability, background work, restart, metrics, and quality evaluation surround
that loop. They do not redefine it.

## What This Model Does Not Guarantee

The runtime cannot guarantee that an arbitrary model understands a task,
chooses the best tool, or writes a good answer. Those are measured model
outcomes.

The runtime does guarantee that any model behavior remains inside a bounded,
replayable execution protocol without duplicate durable effects, contradictory
terminal states, hidden work creation, or observer-driven behavior.

## Minimal Runtime

The normative model loop is:

```ts
while (!query.signal.aborted) {
  const messages = compactIfNeeded(transcript.project());
  const response = await model.call(messages, availableTools, query.signal);
  transcript.append(response);

  if (response.toolCalls.length === 0) {
    return complete(response.text, response.stopReason);
  }

  const results = await effects.execute(response.toolCalls, query.scope);
  transcript.append(results);
}
```

The loop may enforce protocol, permission, idempotency, cancellation, and
resource bounds. It must not infer product intent, inject recovery work, grade
answer quality, or wait for observers to settle.

## Execution Scopes

Every running unit is an execution scope:

```ts
interface ExecutionScope {
  scopeId: string;
  parentScopeId?: string;
  ownership: "attached" | "detached";
  state: ExecutionState;
  budget: BudgetEnvelope;
}

type ExecutionState =
  | { kind: "pending" }
  | { kind: "running" }
  | { kind: "waiting"; handle: string; reason: string }
  | { kind: "succeeded"; resultRef: string }
  | { kind: "failed"; errorCode: string }
  | { kind: "cancelled"; reason: string };
```

Only `succeeded`, `failed`, and `cancelled` are terminal.

Ownership is explicit:

- An attached child must finish or be cancelled before its parent succeeds.
- A detached child is owned by the durable task registry and cannot block its
  former parent.
- Detaching is a durable state transition, not a timeout or failure.
- A detached child returns a handle; completion returns through a durable
  notification event.

No projection such as liveness, metrics, or quality may reinterpret these
states.

## Typed Effects

The model may propose only typed effects:

```ts
type EffectProposal =
  | { kind: "call_tool"; effectId: string; tool: string; input: unknown }
  | { kind: "spawn_child"; effectId: string; task: string }
  | { kind: "send_to_child"; effectId: string; handle: string; message: string }
  | { kind: "detach_child"; effectId: string; handle: string }
  | { kind: "join_child"; effectId: string; handle: string };
```

Every externally visible effect has a stable `effectId`. Committing the same id
again returns the prior receipt rather than executing it again.

Policies may allow, deny, or constrain a proposal. They cannot create another
proposal. In particular, timeout, malformed output, weak evidence, or quality
scores cannot manufacture a retry, fallback tool, child session, prompt, or
closeout. The model or an explicit workflow definition must propose new
business work.

## Budget Algebra

All resource limits use one envelope:

```ts
interface BudgetEnvelope {
  deadlineAt?: number;
  maxTurns?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxRetries?: number;
  maxTokens?: number;
  maxCost?: number;
  maxConcurrency?: number;
}
```

Composition is a meet operation: each finite child value is the minimum of its
parent value, explicit request, platform cap, and policy constraint.

```text
effective = parent AND explicit AND platform AND policy
```

Therefore:

- a child cannot receive more resource than its parent;
- an explicit 25 second limit cannot become 120 seconds;
- elapsed time is deducted when a deadline crosses a boundary;
- adding a policy can only preserve or reduce authority;
- retries consume one owner-level retry budget and are not multiplied across
  layers.

Model profiles may suggest defaults. They cannot override an explicit or parent
bound.

## Time Semantics

`timeout` is not a state. Four distinct events are used:

| Event | Meaning | Required effect |
| --- | --- | --- |
| `wait_elapsed` | A caller stopped waiting | Return `not_ready`; task continues |
| `operation_expired` | One provider/tool attempt exceeded its bound | End that attempt |
| `execution_expired` | The owning scope exceeded its lifetime | Cancel attached descendants |
| `idle_stalled` | No observable progress during a diagnostic window | Emit diagnostics only |

Foreground wait and task execution must never share one ambiguous timer.
Liveness is an observation and cannot expire execution.

## Completion

A query turn is complete when one of these authoritative events is committed:

- model end-turn with zero proposed effects;
- explicit cancellation;
- exhausted hard budget;
- unrecoverable protocol or transport failure.

Completion does not require:

- detached tasks to finish;
- metrics or telemetry to flush;
- liveness counters to reach zero;
- quality checks to pass;
- cleanup projections to stabilize;
- a particular phrase, evidence count, or tool sequence.

An attached child prevents success only because ownership requires it. The
parent may explicitly detach or cancel it before completing.

Terminal transitions are irreversible. Late events are recorded for audit but
cannot reopen a terminal scope without a new explicit user/workflow input.

## Durability and Reconciliation

The durable transcript and task registry are authoritative. Restart performs:

```text
load journal
-> reduce events into scope state
-> reconcile desired and observed state once
-> resume only non-terminal owned work
```

Reconciliation is level-triggered and idempotent. It computes the smallest
mechanical transition needed to honor persisted ownership. It does not infer
the user's next business action and does not synthesize recovery prompts.

Resume reconstructs protocol state from the journal. It does not serialize a
process stack or ask a quality evaluator what to do next.

## Observers

Metrics, liveness, quality evaluation, E2E scoring, and diagnostics are
read-only journal consumers.

Observer non-interference is a hard law:

```text
execution(events, observers=on) == execution(events, observers=off)
```

Observers may page an operator or recommend a new explicit command. They may
not dispatch work, alter budgets, change scope state, or block terminal result
delivery.

## Model Profiles

A model profile contains measured capabilities and distributions:

```ts
interface ModelProfile {
  contextWindow: number;
  supportsParallelTools: boolean;
  supportsPromptCaching: boolean;
  latency: { p50Ms: number; p95Ms: number; p99Ms: number };
  streamIdle: { p95Ms: number; p99Ms: number };
  malformedToolCallRate: number;
  duplicateToolCallRate: number;
}
```

Profiles may select adapters, defaults, compaction thresholds, batching, and
foreground wait preferences. Profiles cannot modify the state algebra,
ownership, effect idempotency, completion, or budget laws.

Adding a model must require conformance measurements, not production runtime
detectors for that model's wording.

## Proof Obligations

Every implementation must continuously prove:

1. Effect ids commit at most once.
2. Terminal scopes never execute new model or tool work.
3. Attached children cannot become orphans.
4. Detached children cannot block parent completion.
5. Cancellation propagates to attached descendants only.
6. Explicit and inherited budgets are never enlarged.
7. Wait expiry does not cancel execution.
8. Retry attempts consume one bounded owner budget.
9. Replay of one journal produces one state.
10. Observer presence does not change execution.
11. Compaction preserves tool-call/tool-result protocol units.
12. Every stopped process leaves a terminal result or durable resumable handle.

These laws are model- and scenario-independent. Natural E2E tests measure model
quality after the laws pass; they do not define the laws.

## Architectural Enforcement

The production architecture must eventually enforce this dependency direction:

```text
model/tool adapters -> typed proposals -> execution kernel -> journal
policy constraints  --------------------^                   |
                                                            v
                                             read-only observers/evaluators
```

Required structural rules:

- the kernel cannot import model-specific policy, prompt, metrics, quality, or
  E2E modules;
- observers cannot import mutating stores or dispatch services;
- policies return constraints only and cannot invoke tools or models;
- adapters translate protocols but cannot decide business recovery;
- all terminal writes and effect commits pass through the kernel;
- changes to the kernel require simulator counterexamples and invariant tests.

## Acceptance of This Design

This design is ready for production mapping only after an independent simulator
demonstrates the proof obligations under deterministic adversarial traces,
crash/replay, event reordering, observer lag, and multiple model profiles.

Passing one real LLM scenario is not design acceptance. Failing one real LLM
scenario is not permission to add a runtime rule.
