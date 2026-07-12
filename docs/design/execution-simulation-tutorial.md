# Execution Simulation Tutorial

This tutorial explains how to investigate Agent runtime failures without using
a real LLM as a debugger or adding scenario-specific production rules.

Read [Agent Execution Semantics](./agent-execution-semantics.md) first. The
simulator is executable design evidence for represented state, not a production
runtime and not a formal proof.

## Start With A Typed Counterexample

Every runtime problem starts as:

```text
model events + tool events + time events + ownership + persistence boundary
```

Do not begin with a provider name, vendor name, fixture value, expected English
phrase, or quality score. Those describe model outcomes, not runtime semantics.

Bad reproduction:

```text
MiniMax failed the slow-source release-risk prompt.
```

Useful reproduction:

```text
1. An effect intent is durable.
2. Dispatch reaches an external tool.
3. The process crashes before the receipt is durable.
4. The provider cannot query the stable idempotency key.
5. Restart must not dispatch the effect again.
```

## Run The Reference Simulator

```bash
npm run test:execution-semantics-sim
```

The simulator has no production-runtime imports and makes no network calls:

- `scripts/execution-semantics-sim.ts`
- `scripts/execution-semantics-sim.test.ts`

## Example: Ambiguous Effect Crash

```ts
const runtime = new ReferenceRuntime();

runtime.admitEffect({
  effectId: "publish-release-42",
  signature: "publish_release:{releaseId:42}",
  scopeId: "publish-operation",
});
runtime.startEffect("publish-release-42");

// The process crashes after dispatch and before a durable receipt.
const restarted = runtime.replay();
restarted.reconcileStartedEffect("publish-release-42");
```

Assert the invariant, not output prose:

```ts
assert.equal(
  restarted.state.effects["publish-release-42"].status,
  "indeterminate",
);
assert.throws(
  () => restarted.startEffect("publish-release-42"),
  /only a durable admitted effect/,
);
```

If the provider can reconcile the stable idempotency key, pass the recovered
receipt instead:

```ts
restarted.reconcileStartedEffect(
  "publish-release-42",
  "provider-receipt:abc",
);
```

## Example: Approval Wait And Resume

Approval wait is durable suspension, not active compute:

```ts
const runtime = new ReferenceRuntime({
  rootExpiresAt: 3_600_000,
  rootAttemptBudget: { activeMs: 30_000 },
});

runtime.advance(10_000);
runtime.suspend("query", "external_input", "approval:42");
runtime.advance(600_000);

assert.equal(runtime.state.scopes.query.state.kind, "suspended");
assert.equal(runtime.state.attempts["query:attempt:1"].state, "yielded");

runtime.resume("query", "query:attempt:2", { activeMs: 20_000 });
```

The old attempt remains immutable. The explicit durable scope TTL continues
while suspended, while no active-attempt clock runs.

## Example: Detached Result Return

```ts
runtime.admitEffect({
  effectId: "source-check-1",
  signature: "browser_open:source",
  scopeId: "worker-1",
});
runtime.startEffect("source-check-1");
runtime.detach("worker-1");
runtime.completeQuery("answer-ref");
runtime.commitEffect("source-check-1", "artifact-ref");

const restarted = runtime.replay();
restarted.consumeNotification("notification:worker-1");
```

The result remains in a durable inbox after the parent is terminal. Consuming
the notification does not automatically invoke a model.

## Classify A Proposed Change

Put every change in exactly one category before editing production code.

### Kernel Mechanism

Effect identity, scope/attempt state, cancellation, transcript protocol,
durable inbox, journal commit, and reconciliation. A mechanism change requires
a minimal counterexample and invariant test.

### Adapter

Provider stream parsing, tool schema translation, idempotency-key placement,
and typed error normalization. An adapter cannot invent retries, recovery work,
or completion policy.

### Model Profile

Measured context window, cache support, latency, and protocol-error rates. A
profile may select defaults within authority; it cannot change state algebra or
enlarge limits.

### Observer

Metrics, liveness, quality evaluation, E2E report, and alerting. An observer
reads committed events and cannot dispatch, mutate scopes, or block delivery.

### Explicit Workflow

A persisted, declared graph of triggers, allowed effects, joins, budgets, and
retry allowances. It may propose listed work on an explicit trigger. It cannot
derive new work from task wording or final-answer quality.

### Model Guidance

Prompts, tool descriptions, and context projection. Guidance may improve model
choices; it cannot become kernel authority.

## Adversarial Dimensions

Model execution:

```text
end turn
malformed tool call
duplicate effect id
transport failure before response
stream stalls after partial response
```

Effect persistence:

```text
crash before intent
crash after intent before dispatch
crash after dispatch before receipt
crash after receipt
provider reconciliation available/unavailable
torn journal frame
```

Ownership and time:

```text
wait expiry before/after completion
operation expiry
scope TTL during suspension
attached cancellation
detached completion after parent terminal
join satisfied before/after parent expiry
```

Transcript:

```text
single and parallel tool calls
complete call/result unit
open call at compaction boundary
mismatched result ids
crash before checkpoint commit
```

Observers:

```text
disabled
delayed
stale
incorrect projection
```

## What The Current Suite Establishes

The seeded suite currently exercises:

- monotone attempt-budget composition over 10,000 generated inputs;
- 5,000 generated effect crash-window traces;
- explicit suspension/TTL, inbox, join, retry-owner, torn-frame, and transcript
  protocol counterexamples.

These counts establish reproducibility for those represented dimensions only.
They do not establish completeness, production wiring, provider behavior, or
formal correctness. A missing state dimension invalidates any claim about that
dimension regardless of trace count.

## When Real LLM Runs Are Useful

Run a real model only after:

1. the suspected runtime behavior has a typed counterexample;
2. invariant and deterministic integration tests pass;
3. the code version is fixed for the measurement batch;
4. no code changes occur between samples.

Real-model output answers:

- Does this model understand the task?
- Does it select useful tools?
- Does it produce a useful final answer?
- What are latency, token, cost, and success distributions?

It must not define timeout composition, cancellation, effect reconciliation,
replay, compaction protocol, or observer authority.

## Pull Request Checklist

Every runtime change must answer:

1. Which category owns the change?
2. What model-independent counterexample requires it?
3. Which invariant fails without it?
4. What is the effect crash behavior before and after durable receipt?
5. Does it create hidden business work?
6. Can it enlarge authority or multiply retries?
7. Can an observer influence execution?
8. Does it preserve complete transcript protocol units?
9. Is a real-model result being used as measurement or as a rule generator?

If the change creates hidden work, enlarges authority, or gives observers
control, it does not belong in the kernel.
