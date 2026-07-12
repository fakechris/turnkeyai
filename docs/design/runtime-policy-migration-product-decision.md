# Runtime Policy Migration Product Decision

Status: **PENDING PRODUCT-OWNER SIGNATURE**.

This is not an engineering inference. Migrating the current automatic repair,
continuation, and synthesis actions changes the product's quality contract,
especially for models that do not reliably recover or self-correct without
runtime intervention.

No policy-action row in
[Runtime Policy Disposition](./runtime-policy-disposition.md) may migrate while
this decision is pending. Kernel safety, effect-ledger, clock, persistence, and
workflow-runtime work may proceed independently.

## Decision Being Made

Approximately fourteen current policies force tools, continuations, closeouts,
or answer rewrites in response to inferred quality failures. V2 moves product
quality out of kernel authority. The product owner must choose how migration
quality regressions are governed.

### Option A: Accept The Authority Shift

Accept that runtime semantic safety is the hard release contract and natural
task quality becomes a measured product/model outcome.

- Automatic business-effect injection and post-terminal answer rewriting do
  not return as rollback mechanisms.
- A quality regression can hold a release and create model-guidance, workflow,
  evaluator, or model-selection work.
- Fixed-version E2E reports distributions and failure buckets; it does not
  authorize scenario-specific kernel patches.
- Permission, protocol, idempotency, budget, and declared-workflow guarantees
  remain hard deterministic gates.

### Option B: Require Per-Row Migration Budgets

Before each policy row migrates, define its scenario cohort, baseline model and
configuration, sample size, pass-rate/quality regression budget, and rollback
threshold.

- Exceeding the threshold rolls back that row's migration commit, not the V2
  constitution and not unrelated rows.
- The row remains on the old path until model guidance or an explicit workflow
  meets its budget.
- Measurement runs use one unchanged commit; no code edits occur between
  samples.
- A budget must not be satisfied by relaxing the harness or adding fixture
  literals.

## Signature

```text
Selected option: PENDING (A or B)
Product owner: PENDING
Decision date: PENDING
Notes: PENDING
```

The signed decision becomes part of the migration acceptance contract. Until
then, policy migration remains frozen by design.
