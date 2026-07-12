# Execution Simulation Tutorial

This tutorial explains how to change the Agent runtime without using a real LLM
as a debugger and without adding scenario-specific production rules.

Read [Agent Execution Semantics](./agent-execution-semantics.md) first. The
simulator is a reference model for those semantics, not a replacement runtime.

## The Rule

Every runtime problem starts as a deterministic counterexample:

```text
model behavior + tool behavior + timing + ownership + crash point
```

Do not start with a prompt, provider, vendor name, fixture value, or expected
English phrase. Those belong to model-quality measurement.

## Run the Reference Simulator

```bash
npm run test:execution-semantics-sim
```

The simulator lives in:

- `scripts/execution-semantics-sim.ts`
- `scripts/execution-semantics-sim.test.ts`

It has no production-runtime imports and makes no network calls.

## Describe Behavior, Not a Scenario

Bad reproduction:

```text
MiniMax failed the slow-source release-risk prompt.
```

Useful reproduction:

```text
1. Model proposes one child operation with explicit timeout 25s.
2. The child has not completed when foreground wait expires.
3. Parent wants to end the turn and preserve a task handle.
4. Child completes after the parent result is delivered.
5. Process crashes before the completion notification is consumed.
```

This trace applies to any model, tool, task wording, and latency distribution.

## Map the Trace to the Reference Model

```ts
const runtime = new ReferenceRuntime({
  rootBudget: { deadlineAt: 300_000 },
});

runtime.proposeEffect({
  effectId: "source-check-1",
  signature: "browser_open:source",
  scopeId: "worker-1",
  explicitBudget: requestedTimeoutBudget(runtime.state.now, 25_000),
  platformBudget: { deadlineAt: 120_000 },
});

const wait = runtime.wait("worker-1", 5_000);
runtime.detach("worker-1");
runtime.completeQuery("answer-ref");

const restarted = runtime.replay();
restarted.succeed("worker-1", "artifact-ref");
```

Then assert laws, not prose:

```ts
assert.equal(wait.kind, "not_ready");
assert.equal(runtime.state.scopes["worker-1"].budget.deadlineAt, 25_000);
assert.equal(restarted.state.scopes.query.state.kind, "succeeded");
assert.equal(restarted.state.notifications.length, 1);
```

## Classify a Proposed Change

Before editing production code, put the change in exactly one category.

### Mechanism

Examples: effect idempotency, cancellation propagation, transcript replay,
attached/detached ownership, protocol validation.

A mechanism may change execution semantics. It requires a minimal simulator
counterexample and new invariant coverage.

### Adapter

Examples: Anthropic-compatible stream parsing, tool schema translation,
provider error normalization.

An adapter may translate external protocols into typed events. It cannot add
retries, recovery tasks, completion rules, or product policy.

### Model Profile

Examples: context window, cache support, latency distribution, malformed tool
call rate.

A profile may change defaults and scheduling preferences within the budget
envelope. It cannot change state transitions or enlarge explicit limits.

### Observer

Examples: metrics, liveness, quality score, E2E report, alert.

An observer reads the journal. It cannot import dispatch services, mutating
stores, model callers, or tool executors.

### Product Workflow

Examples: a user-approved retry sequence or an explicit multi-step release
workflow.

Product work is represented as explicit workflow input or model-proposed typed
effects. It does not belong in the runtime kernel.

## Add an Adversarial Trace

Useful trace dimensions include:

```text
Model:
  final text
  empty end turn
  malformed tool call
  duplicate effect id
  retryable transport failure
  permanent transport failure
  stream stalls after partial output

Tool:
  succeeds before foreground wait
  succeeds after foreground wait
  fails
  ignores cancellation temporarily
  produces a duplicate completion

Scheduler:
  attached
  detached
  cancellation before detach
  cancellation after detach
  notification before/after parent completion

Durability:
  crash before effect commit
  crash after effect commit
  crash after tool side effect but before receipt delivery
  crash after terminal result

Observers:
  disabled
  delayed
  stale
  incorrect projection
```

If a production bug cannot be expressed with these typed behaviors, first ask
whether it is actually a model-quality problem rather than a runtime problem.

## Property-Style Simulation

The reference suite uses a seeded generator so a failure is reproducible. It
currently checks:

- 10,000 random budget compositions;
- 5,000 crash/detach/cancel/replay traces;
- 3,000 runs across distinct model behavior profiles.

A new property test should state a law such as:

```text
for every event ordering,
if an effect receipt is durable,
replay cannot execute the effect again
```

It should not state:

```text
for this fixture, final text must contain "verified"
```

## Model Profiles and Monte Carlo Runs

Real models can be represented by measured distributions:

```ts
const profile = {
  duplicateToolCallRate: 0.03,
  malformedToolCallRate: 0.05,
  toolFailureRate: 0.08,
  foregroundDetachRate: 0.55,
  latencyP95Ms: 35_000,
};
```

Run thousands of seeded traces and report:

- duplicate committed effects;
- orphan attached tasks;
- replay divergence;
- terminal delivery rate;
- retry amplification;
- detached completion delivery;
- resource distribution.

Changing the profile should change latency, cost, and model success metrics. It
must not change the execution invariants.

## When Real LLM Runs Are Allowed

Run a real model only after:

1. the behavior has a typed simulation trace;
2. all invariant tests pass;
3. deterministic integration tests pass;
4. the code version is fixed for the measurement batch.

Real LLM output answers:

- Does this model understand the task?
- Does it select useful tools?
- Does it produce a useful final answer?
- What are its latency and cost distributions?

It must not be used to discover timeout composition, cancellation races,
duplicate effects, replay divergence, or observer interference.

## Review Checklist

Every runtime pull request must answer:

1. Which category does this change belong to?
2. What model-independent counterexample requires it?
3. Which invariant would fail without it?
4. Can the same result be achieved in an adapter or profile?
5. Does the change create hidden business work?
6. Can it enlarge authority or budget?
7. Can an observer now influence execution?
8. Does replay produce the same state?

If questions 5, 6, or 7 answer yes, the change does not belong in the runtime.

