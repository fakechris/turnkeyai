# Minimal Explicit Workflow Runtime Slice

Status: implementation contract for V2 migration step 5. Baseline:
`361c71ae`.

## Objective

Provide the smallest durable runtime that can replace hidden policy-created
business work. A workflow is declared data: persisted steps subscribe to typed
triggers, receive bounded attempt grants, and may propose only named effects
from their allowlist. The runtime does not execute tools, call a model, parse
task text, evaluate answer quality, or invent steps.

## Record Model

Each workflow record owns:

- an immutable definition with exact trigger keys, allowed effects, join mode,
  attempt budgets, retry allowance ids, and next-step ids;
- persisted per-step state and every attempt/proposal/receipt;
- persistent `workflow_step` retry allowances;
- processed trigger ids for idempotent crash replay;
- one monotonic version used for compare-and-swap transitions.

Supported trigger kinds are exactly `user_input`, `effect_receipt`,
`inbox_notification`, and `schedule`.

## Authority Boundary

1. A matching trigger may grant an attempt to a declared waiting step.
2. The runtime persists an allowed effect proposal before returning it.
3. The host must dispatch that stable proposal through the authoritative effect
   ledger. The workflow runtime is not a second effect executor.
4. A committed receipt completes the step or creates its declared join.
5. A failed receipt may create one new attempt only by consuming a named,
   persisted `workflow_step` allowance owned by that step.
6. An indeterminate receipt is never automatically retried.
7. Join satisfaction completes the joining step but grants no compute. A
   separate declared `inbox_notification` trigger is the resume grant.
8. Join abandonment fails only the step. Detached work and its inbox result
   remain registry-owned.

Attempt budgets are carried to the host. The workflow runtime directly enforces
active-time expiry and the per-attempt tool-call limit at proposal admission;
model, token, cost, and concurrency limits remain downstream kernel inputs.

## Deliberate Non-Goals

- no task-language conditions, expression language, dynamic step generation,
  branching predicates, prompt templates, or visual workflow editor;
- no direct model/tool dispatch and no duplicate effect ledger;
- no policy-row migration in this slice;
- no real-model or E2E acceptance tuning;
- no automatic notification consumption or terminal-scope reopen.

## Required Counterexamples

- a trigger with the wrong kind/key cannot wake a step;
- duplicate trigger ids, proposals, receipts, and restart replay are idempotent;
- an undeclared effect is rejected before dispatch;
- an expired attempt cannot admit an effect;
- a failed effect cannot retry without an owned remaining allowance;
- an indeterminate effect cannot retry;
- a satisfied join does not grant an attempt until the declared inbox signal;
- an abandoned join does not cancel or remove the detached result;
- observer or storage restart does not change the authoritative workflow state.

## Approval Workflow Proof

The deterministic integration proof uses a declared approval workflow:

```text
external approval receipt
-> permission-applied proposal
-> committed receipt
-> approved detached action proposal
-> durable join
-> detached inbox notification
-> explicit inbox wake
-> complete
```

The proof restarts the file store after suspension and after proposal admission.
It verifies stable ids, allowlist rejection, write-before-dispatch state, join
non-interference, and explicit resume. It uses no LLM.

## Exit Criteria

- core contracts, atomic file store, runtime, composition wiring, and the
  approval crash/replay proof are present;
- architecture tests reject model, prompt, policy, detector, and dispatch
  dependencies from the workflow runtime and store;
- existing deterministic package suites, simulator, policy inventory,
  typecheck, and `git diff --check` remain green;
- exact results are recorded before compaction alignment begins.

## Implemented Result

- `FileExplicitWorkflowStore` persists immutable definitions and versioned
  state transitions with compare-and-swap conflict rejection;
- `ExplicitWorkflowRuntime` persists trigger ids, attempt grants, proposals,
  receipts, retry consumption, and join state without importing any model,
  prompt, policy, detector, or dispatch owner;
- external trigger occurrence time is not reused as an active deadline after a
  delayed restart; every actual wake creates a fresh grant at resume time;
- repeated active proposals return the same stable proposal, while repeated
  terminal proposals return a typed prior receipt and cannot be mistaken for
  new dispatch work;
- attached receipts complete directly; detached receipts create one stable
  durable join; join satisfaction alone leaves the workflow suspended until a
  declared inbox signal arrives;
- retry allowances record their owner scope and `workflow_step` failure domain,
  are consumed only by named owning steps, and never retry an indeterminate
  effect;
- daemon foundations compose the file store and runtime over the durable worker
  inbox for later row-by-row policy migration.

Final deterministic results on Node.js `v24.14.0`:

- `npm run typecheck`: pass;
- agent-core: 64/64;
- llm-adapter: 60/60;
- react-engine, including architecture guards: 386/386;
- response-generator and tool-use: 315/315;
- operation timeout, attempt deadline, session protocol, sub-agent runtime, and
  browser timeout support suites: 98/98;
- complete team-runtime suite, including seven workflow/runtime architecture
  proofs: 103/103;
- complete team-store suite: 75/75;
- mission bridge, mission route, and durable inbox architecture suites: 109/109;
- execution-semantics simulator: 17/17, including 10,000 generated budget
  compositions and 5,000 generated effect crash windows;
- runtime-policy inventory/disposition: 2/2;
- `git diff --check`: pass.

A deliberately over-parallel local run first caused existing event-loop timing
tests to miss their narrow wall-clock assertions. The same unmodified suites
passed in serial; no gate, timeout, or assertion was changed.

No real model, E2E fixture, prompt rule, policy detector, acceptance closeout,
or threshold change participated in this slice.
