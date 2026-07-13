# Agent Workbench Goal Ledger

This ledger records the current product acceptance direction. Historical
hour-by-hour checkpoints remain available in Git history and are intentionally
excluded from the current documentation.

G0 operating contract:

- Track whether users are closer to receiving stable, useful Mission results.
- Product behavior and acceptance evidence matter more than PR or test counts.

Required checkpoint fields:

- Execution Kernel, Result Quality, Workbench UX, Browser Reliability,
  Acceptance Evidence, and Regression Risk.

Update cadence:

- Add a checkpoint when a material product acceptance boundary changes.

24-hour methodology brake:

- If repeated fixes do not improve a natural end-to-end Mission, pause feature
  work and revisit the underlying design or validation method.

Direction values:

- `converging`, `oscillating`, `blocked`, or `unknown`.

Evidence gates:

- Runtime changes require focused tests and a natural end-to-end Mission.
- User interface changes require a user-visible smoke check.

G0 acceptance rules:

- A Mission must finish with a useful result or an explicit actionable state.
- Silent and ambiguous failures are not accepted.

Convergence review rule:

- A checkpoint must explain the user-visible change and the evidence behind it.

## 2026-07-13 01:00 PDT - Product Acceptance Baseline

Direction: converging

Execution Kernel:

- Mission, Agent, tool, approval, continuation, and recovery states have typed
  runtime boundaries.

Result Quality:

- Natural Mission acceptance requires a useful terminal result with evidence,
  or an explicit blocked or failed outcome.

Workbench UX:

- Mission Control exposes Missions, Agents, Context, Approvals, activity, and
  runtime diagnostics through one local workbench.

Browser Reliability:

- Browser execution records session state and produces bounded, visible failure
  outcomes when recovery is not possible.

Acceptance Evidence:

- The maintained contract, natural Mission, browser reliability, replay, and
  release gates cover the current product surfaces.

Regression Risk:

- Long-running missions, browser recovery, context pressure, and approval
  boundaries remain the highest-risk areas and stay in release validation.
