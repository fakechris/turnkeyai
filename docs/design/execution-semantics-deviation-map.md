# Execution Semantics Deviation Map

Baseline: `origin/main` at `c37d52bb`.

This document is an audit input for a future migration plan. It does not
authorize implementation changes.

## Summary

The current runtime has useful mechanisms for native tools, persistence,
compaction, replay, permissions, and worker sessions. The primary architectural
deviation is that product policy and observer projections participate in the
execution and completion path.

## Deviations

### Explicit timeout can be enlarged

`resolveToolTimeoutMs` initially respects an explicit timeout, but
`applyLocalBrowserTaskTimeoutFloors` later applies `Math.max` based on task text.
A requested short bound can therefore become a longer scenario-derived bound.

Target law:

```text
effective budget <= explicit budget
```

Likely migration owner: tool adapter/budget composition.

### Runtime policy can manufacture business effects

`ContinuationController` derives task-language facts and can inject
`sessions_list` or `sessions_spawn` when the model emitted no call. This makes a
runtime detector, rather than the model or explicit workflow, the author of new
business work.

Target law:

```text
policies constrain proposals; policies do not create proposals
```

Likely migration owner: model loop and explicit workflow layer.

### Completion waits on an observer projection

The natural E2E completion waiter requires mission `done`, a final thought,
metrics `done`, liveness active/waiting/stale all zero, and 1.5 seconds of
projection stability. Liveness is derived from progress events and therefore
is not an authoritative terminal store.

Target law:

```text
durable terminal state delivers the result; observers cannot block it
```

Likely migration owner: E2E runner and mission result API.

### Quality evaluation is coupled to mission runtime status

`mission-observability.ts` builds text- and evidence-derived quality checks and
derives a quality status alongside runtime liveness. Production and natural E2E
also use different subsets of these checks as blockers.

Target law:

```text
runtime outcome and quality outcome are separate fields
```

Likely migration owner: read-only evaluation/reporting.

### Timeout, cancellation, waiting, and resumability overlap

Worker execution, parent tool-loop wall clock, hard-abort grace, task-specific
timeout floors, and E2E scenario deadlines can race. A single slow operation may
be reported as cancelled, timed out, resumable, waiting, or terminal depending
on which timer writes first.

Target law:

```text
wait_elapsed != operation_expired != execution_expired != cancellation
```

Likely migration owner: execution state algebra and ownership.

### Scenario fixtures influence runtime behavior

Task text detectors for slow loopback, timeout recovery, browser visibility,
approval, and continuation influence time budgets, available tools, and injected
calls. This makes model/task variation a correctness input.

Target law:

```text
scenario wording may influence model proposals, not kernel semantics
```

Likely migration owner: remove from runtime; retain only model-independent
transport classification such as loopback network safety.

### Retry and repair ownership is distributed

Provider retries, tool retries, repair rounds, continuation controllers,
closeout controllers, and E2E reruns can each respond to failure. Even when each
layer is bounded, the product of bounded layers can amplify work.

Target law:

```text
one owner-level retry budget; lower layers report typed failure
```

Likely migration owner: one explicit `RetryAllowance` owner per failure domain.

### Interrupted effects are replayed without an outcome ledger

Status: **closed on main by the effect-ledger migration slice**.

The current run journal can convert an interrupted native call into an error for
the resumed model. Asking the model to send the call again is unsafe when the
external side effect may have completed before the process crashed.

Target law:

```text
intent -> dispatch -> receipt; ambiguous dispatch becomes indeterminate
```

Implemented owner: execution-kernel effect ledger plus adapter-level
idempotency reconciliation. Keep this entry as a regression constraint; it is
not remaining migration work.

### Durable suspension and active attempt time are not separate authorities

Approval waits, provider attempts, caller waits, and run lifetime still rely on
overlapping timeout mechanisms. A long external wait either consumes active
budget or requires ad hoc timeout floors.

Target law:

```text
scope TTL != attempt budget != operation timeout != caller wait
```

Likely migration owner: durable scope and attempt state algebra.

### Detached completion lacks a complete inbox/join contract

Background sessions and persisted task handles exist, but the authoritative
owner, notification consumption, and parent-expiry behavior for joins are not a
single kernel contract.

Target law:

```text
detached result remains consumable; expired join never cancels detached work
```

Likely migration owner: durable mission/thread registry.

## Candidate Stage 10 Branch

The unmerged `codex/stage10-long-run` candidate adds useful checkpoint and
simulation scaffolding, but its report must not be treated as proof that the
production control path follows the new semantics:

- its stateless supervisor is not wired into daemon dispatch;
- its optional flow deadline is not configured by daemon runtime limits;
- its 500-step test validates a synthetic checkpoint-aware worker handler, not
  the current model/browser timeout composition;
- it retains the deviations above because it was built on the existing runtime.

The candidate should be evaluated commit-by-commit after the reference
semantics are accepted. Do not merge or discard it as one unit.

## Migration Ordering Constraint

A future migration must follow dependency order:

```text
audit landed foundation against V2
-> effect intent/dispatch/receipt reconciliation
-> scope/attempt clocks and retry ownership
-> durable inbox and join
-> transcript/journal protocol validation
-> policy disposition migration
-> fixed-version model conformance measurement
```

Starting with detector removal, E2E threshold changes, or another bake-driven
patch loop would repeat the prior acceptance cycle because authoritative effect
and lifetime semantics would still be ambiguous. The earlier six-phase plan is
reconciled in
[Execution Semantics And Six-Phase Reconciliation](./execution-semantics-six-phase-reconciliation.md).

## Exit Criteria for Design Review

Before a migration plan is written, reviewers should agree that:

- durable scope and ephemeral attempt states are complete and non-overlapping;
- active budgets compose monotonically and retries have one owner per failure
  domain;
- ambiguous external effects become reconciled or indeterminate;
- detached results and joins have durable delivery semantics;
- no required recovery depends on product-text detection;
- observer non-interference is enforceable by package boundaries;
- simulator claims are limited to represented crash, transcript, ownership,
  time, and persistence dimensions;
- every current repair/continuation policy has an approved disposition.
