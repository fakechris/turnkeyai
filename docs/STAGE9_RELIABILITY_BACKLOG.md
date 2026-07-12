# Stage 9 Reliability Backlog

These items are independent from the closed runtime-foundation migration. They
must be measured on immutable commits and must not trigger scenario-specific
kernel policy patches.

## P0: Define Follow-Up Continuity Product Semantics

Decide whether a request to "ask the same research thread" requires an actual
`sessions_send`, or whether a source-bounded answer from durable prior evidence
can satisfy the product contract. Keep the decision outside the runtime kernel.
Then measure a varied cohort across models, entities, languages, and phrasing.

## P1: Improve Model Proposal Reliability

If actual worker re-entry is required, improve generic tool descriptions,
typed handle projection, and model selection. Do not reintroduce hidden
continuation effects. Evaluate pass-rate distributions rather than consecutive
3/3 gates.

## P1: Complete Fixed-Version Cohorts

Run the five unattempted natural core scenarios in a future measurement batch
on an unchanged commit. Preserve the first-failure report and do not patch
between samples.

## P1: Exercise Long-Context Mechanisms

The attempted real scenarios produced no compaction or crash resume event.
Add fixed-version workload cohorts that intentionally cross compaction and
checkpoint thresholds, then verify evidence retention and replay identity from
RunTrace. This is measurement, not a prompt acceptance campaign.

## P2: Tighten E2E Aggregation Diagnostics

The interrupted report recorded four model calls but zero model-attempt
lifecycle counters. Reconcile the multi-flow E2E aggregation so the report
distinguishes provider attempts for the initial turn and follow-up turn without
changing runtime behavior.

## P2: Report Interrupted Scenario Counts Clearly

The structured report stores three completed scenarios plus one interrupted
scenario, while `scenarioCount` is three. Expose attempted, completed, passed,
failed, and interrupted counts explicitly to avoid ambiguous dashboards.
