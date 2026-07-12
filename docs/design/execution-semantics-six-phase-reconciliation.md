# Execution Semantics And Six-Phase Reconciliation

Status: single-plan reconciliation. This document prevents the V2 execution
constitution and the earlier six-phase production plan from becoming parallel
architecture programs.

## Decision

The six-phase plan remains the delivery history and coarse work breakdown. The
V2 execution semantics replace its conflicting runtime assumptions and become
the acceptance contract for any remaining work. There is one migration line,
not "finish bake, then start a second redesign."

Real-model bake is a fixed-version measurement activity. It is not a phase gate
that may trigger scenario-specific runtime patches.

## Phase Reconciliation

| Earlier phase | Current repository state | Disposition under V2 |
| --- | --- | --- |
| Phase 1: engine default and inline retirement | Landed on main | Keep. Do not restore inline as an oracle. Deterministic traces and typed event replay are the regression tools. |
| Phase 2: typed provider errors, retry, schema validation, streaming | Foundation landed | Keep typed normalization and streaming. Rewrite retry ownership around one `RetryAllowance` per failure domain; adapters report typed failure and do not multiply owner retries. |
| Phase 3: token budget, compaction, artifact externalization | Foundation landed | Keep. Validate compaction against real tool-call/tool-result units and keep model-generated summaries outside authoritative facts. Attempt budget uses active time; no task-text timeout floors. |
| Phase 4: run journal, checkpoint, resume, session hygiene | Foundation landed | Keep persistence. Replace "interrupted call becomes an error and ask the model to resend" with effect intent/start/receipt reconciliation. Resume must not blindly repeat ambiguous effects. |
| Phase 5: RunTrace and replay | Foundation landed | Keep as observability and deterministic projection. Do not claim replay proves side-effect exactly-once; add committed-frame, indeterminate-effect, inbox, and join semantics. |
| Phase 6: cost and cache optimization | Deferred | Remains independent optimization after semantic conformance. Cache keys and model profiles cannot change execution authority. |

## Conflicting Clauses Superseded

The following earlier-plan ideas are no longer valid acceptance criteria:

1. **One global wall-clock generation deadline.** Replaced by durable scope TTL,
   active attempt budget, operation timeout, and caller wait as separate clocks.
2. **Retry as a field inherited through every layer.** Replaced by consumable,
   single-owner allowances scoped to failure domains.
3. **Resume by turning interrupted tool calls into model-visible errors and
   inviting resend.** Replaced by effect reconciliation or `indeterminate`.
4. **Policy nudge as automatic continuation.** Replaced by model proposals or
   declared workflow transitions.
5. **E2E/soak green as semantic proof.** Replaced by deterministic invariant
   tests; E2E reports model quality and reliability distributions.
6. **Golden text/trace equality as the only post-inline oracle.** Retain traces
   for review, but assert typed state/effect invariants rather than incidental
   prompt wording.

## One Remaining Migration Sequence

The order is dependency-driven and consumes already-landed mechanisms rather
than rebuilding them:

1. **Audit landed foundation against V2.** Map existing journal, retry,
   compaction, checkpoint, RunTrace, and background-session code to durable
   scope, attempt, effect, inbox, and observer roles. Produce counterexamples,
   not fixes.
2. **Close effect crash windows.** Introduce durable intent/start/receipt states,
   provider reconciliation, and `indeterminate`. This is the highest safety
   priority because current resend-on-resume can duplicate side effects.
3. **Separate clocks and retry ownership.** Remove task-derived timeout floors
   and multi-layer retry multiplication. Add explicit suspend/resume grants.
4. **Finish durable background return.** Persist inbox consumption and define
   join/parent-expiry behavior.
5. **Validate transcript compaction.** Prove complete tool protocol units survive
   compaction and torn journal frames are ignored.
6. **Migrate current policies using the disposition table.** Move hard safety to
   the kernel, mechanical recovery to transcript/adapters, product continuation
   to explicit workflows, and answer quality to observers.
7. **Measure fixed versions.** Run deterministic gates, simulations, then real
   models without editing code inside a batch. Report distributions and failure
   buckets; create separate product or model-compatibility work when needed.

This sequence supersedes both a bake-first patch loop and a second independent
"authoritative state -> model conformance" rewrite.

## Phase Acceptance Matrix

| Mechanism | Required deterministic evidence | Real-model role |
| --- | --- | --- |
| Retry | One allowance owner; no multiplicative attempts under injected 429/5xx | Measure latency/success distribution |
| Streaming | Partial-frame parser fixtures; cancellation ends attempt once | Measure provider compatibility |
| Compaction | Tool-call/result unit preservation; authoritative facts unchanged | Measure answer quality before/after |
| Journal/resume | Crash at intent, dispatch, receipt, and commit-frame boundaries | Measure operational recovery rate |
| Background work | Detached result survives terminal parent; join expiry does not cancel child | Measure useful completion latency |
| RunTrace | Observer on/off produces identical authoritative state | Diagnose failures only |
| Policy migration | No policy creates effects; permission safety remains enforced | Measure model/workflow behavior |

## Scope Control

No production migration task may combine:

- a kernel invariant change and a prompt-quality change;
- a deterministic failure fix and an E2E threshold relaxation;
- a model-profile tuning and a new runtime authority;
- a fixed-version measurement batch and code edits between runs.

The design branch ends with documents and a reference simulator. Production
changes require a separately reviewed migration slice citing this matrix.
