# Agent Control Authority

Status: implemented production architecture decision. Product disposition A
was approved and the subtractive production migration completed on 2026-07-12.

## Objective

Keep TurnkeyAI stable across models by fixing who may create work, not by
predicting model-specific failures. The standard agent runtime should converge
on the same control shape that makes Claude Code robust:

```text
input/event -> planner -> native tool proposal -> kernel -> durable result
                         ^                         |
                         +------ transcript <-----+
```

The kernel protects execution. It does not decide what the product should do
next. Evaluators measure outcomes. They do not become hidden planners.

## Core Decision: One Planner Per Run

Every run has exactly one explicit planning authority:

- `model`: the model decides tool use, continuation, and completion;
- `explicit_workflow`: a caller-authored typed workflow decides steps and
  effects without pretending to be a model turn.

The planner is selected by the caller when the run is created and cannot be
changed by task text, model output, an evaluator, a timeout, or an observer.
Ordinary agent runs use `model`. An explicit workflow is a separate product
mode, not an automatic recovery layer inside the model loop.

## Authority Boundaries

### Planner

The active planner may:

- propose a new effect;
- continue after a durable result;
- declare its work complete;
- consume a typed external event.

In model mode, the planner communicates through native model responses and
declared proposal protocols. Native tool calls are the preferred effect
protocol. The current structured `@{roleId}` handoff syntax is also a model
proposal, not a kernel inference from business language. A valid tool-free
response completes the turn after every attached child resolves, detaches, or
causes the run to suspend.

### Kernel

The kernel may:

- validate schemas and permissions;
- admit, execute, reject, cancel, or deduplicate an effect;
- cap operation time, attempts, concurrency, context, and output;
- persist transcripts, effects, checkpoints, and receipts;
- suspend with a durable handle;
- retry the same operation within one typed retry allowance;
- perform protocol recovery that preserves the requested operation.

The kernel may not:

- infer missing business work from task or answer text;
- manufacture a different tool call;
- append a semantic repair prompt;
- turn a completed response into a new task;
- strengthen a deadline or retry budget from task wording.

Kernel decisions are monotonic: they can constrain, reject, suspend, or report;
they cannot add product work.

### Transcript And Events

User input, model output, tool receipts, permission outcomes, and background
task notifications enter one ordered transcript. A background result is a fact,
not a continuation decision. The active planner decides what to do after seeing
it.

Compaction is a projection of that transcript. It must preserve task identity,
tool-call/tool-result protocol units, durable handles, decisions, evidence, and
unresolved work. It may not introduce a new action.

### Observer

Observers and evaluators may compute metrics, diagnostics, warnings, and test
results. Their output must not reach any of these sinks:

- model input;
- tool admission or dispatch;
- `handleUserPost` or an equivalent synthetic user turn;
- workflow signaling;
- completion veto or run reactivation.

An evaluator failure is data for the caller. It is never a runtime transition.

## Current Production Audit

| Path | Current authority | Assessment | Target |
| --- | --- | --- | --- |
| Public user post | User | Correct | Planner input |
| Native model tool call | Model | Correct | Model-mode proposal |
| Typed `resume-existing` request | Caller, implemented with a forced first `sessions_send` choice | Correct explicit caller intent | Retain; never infer it from text |
| Effect ledger and run journal | Kernel | Correct | Retain |
| Attempt deadline and retry allowance | Kernel | Correct | Retain |
| Compaction/checkpoint/externalization | Kernel projection | Correct contract; real long-context evidence is still limited | Retain and measure |
| Worker-result inbox | External event delivered on a later user turn | Correct | Retain as transcript fact |
| Mission goal-slot evaluator | Observer writing mission/API quality projection only | Correct | Retain projection; never wake execution |
| Incomplete-final automatic follow-up | Removed | Correct | Evaluator reports blocked quality and one activity event only |
| Late worker completion fallback follow-up | Removed; durable inbox is the only production path | Correct | Retain typed inbox delivery |
| Role repair/continuation/permission product policies | Production factories return no-op; old actions are isolated characterization | Correct production boundary | Guard production composition from enabling characterization |
| Model tool definitions | Caller/capability-owned executor definitions are passed to the model unchanged | Correct | Kernel validates schema, permission, safety, and effects; task text cannot hide tools |
| Tool-call normalizer | Protocol aliases, handles, and schema normalization remain; product rewrites are retired | Correct | Retain syntax normalization; prohibit business rewrites |
| Handoff planner | Validates structured `@{roleId}` proposals emitted by the model and applies hop limits | Model-mode proposal adapter, despite the `planner` name | Retain as declared proposal protocol; do not infer delegation from unstructured text |
| Scheduled/cron dispatch | Caller creates a typed durable schedule; a due trigger dispatches the predeclared target | Explicit caller input, not a hidden planner | Retain |
| Kernel closeouts for deadline, round limit, cancellation, and model error | Kernel | Correct when they return typed outcomes rather than inventing work | Retain |
| `ExplicitWorkflowRuntime` | Instantiated but has no production consumer | Unproven optional subsystem | Do not connect to ordinary agent runs; keep only if a real caller explicitly selects workflow mode |

## Evidence From Current Code

- Production repair policy is no-op:
  `createRepairPolicyRegistry()` returns `NO_ACTION_REPAIR_POLICY_REGISTRY`.
- Production continuation is no-op:
  `createContinuationController()` disables automatic actions.
- Production permission policy is no-op:
  `createPermissionPolicy()` returns `NO_ACTION_PERMISSION_POLICY`.
- Product closeouts are disabled except typed kernel outcomes:
  `createCloseoutPolicyRegistry()` disables automatic product closeouts.
- Model mode passes the caller-approved executor tool definitions through
  unchanged. Task or transcript text cannot add, remove, or narrow tools.
- app-gateway mission completion may update `Mission.status`, blockers, and
  activity events as a product read-model projection. It cannot submit a user
  turn, call a model/tool, signal a workflow, or mutate role/flow/effect state.
- Both app-gateway `System recovery` generators, callback surfaces, daemon
  wiring, retry counters, and prefix detectors were deleted.
- team-runtime no longer parses retired recovery prose to suppress a structured
  model handoff proposal.
- role-runtime no longer derives continuation or tool budgets from retired
  synthetic recovery prose.
- Late worker results enter the durable inbox exactly once. They do not reopen a
  mission or invoke model compute.
- The explicit workflow runtime is constructed in composition foundations, but
  no non-test production code calls its transition methods.

## Product Disposition

Removing incomplete-final `System recovery` changes visible behavior: a mission
will no longer silently create another model turn when an evaluator considers
the answer incomplete. The value must have an explicit destination before a
migration is approved.

Decision options considered:

- **A. Observer and caller control (approved):** expose unmet goal slots and quality status
  in mission APIs/UI. The caller or user decides whether to submit a follow-up.
  This disposition preserves standard model-mode
  authority and adds no new runtime mechanism.
- **B. Explicit workflow control:** only missions created in
  `explicit_workflow` mode may predeclare a bounded quality-remediation step.
  Standard model-mode missions never enter it. This option is not approved merely
  because `ExplicitWorkflowRuntime` exists; it requires a real product owner and
  workflow contract.

Product signature: **A approved, 2026-07-12**.

Consequently, semantic evaluator output is observational in every standard
model-mode mission. It may be displayed, queried, alerted on, or exported, but
it may not create a follow-up turn. `ExplicitWorkflowRuntime` is not the
destination for this deleted behavior.

The associated acceptance contract changes with either choice. Existing E2E
tests must no longer require an automatic recovery turn in model mode. Under A,
they verify that diagnostics are surfaced and no new turn is created. Under B,
automatic remediation is tested only for an explicitly declared workflow.

## Claude Code Reference Shape

The local Claude Code reverse-engineering snapshot is not a small codebase and
is not a template to copy line for line. Its useful property is authority
placement:

- its main loop continues on native tool use and normally completes on a valid
  tool-free response;
- generic protocol recovery handles prompt overflow and output truncation;
- stop hooks are explicit extensions, not built-in business-slot evaluators;
- background agents transition to terminal state before optional classification
  or notification work;
- task completion returns as a generic notification in the message stream;
- resume rebuilds from the persisted transcript and tool-result state;
- compaction changes the context projection, not the task planner.

TurnkeyAI should copy these boundaries, not Claude Code's file layout or every
feature gate.

## Target Standard Agent Loop

1. Accept an explicit user/caller input and persist it.
2. Project a protocol-safe context, including pending typed notifications.
3. Ask the model.
4. If the response contains native tool calls, let the kernel validate,
   persist, execute, and append receipts.
5. Repeat from step 2.
6. If the response is valid and tool-free, resolve the attached-child invariant:
   finish, explicitly detach, cancel, or suspend with a durable handle. Then
   complete the turn.
7. On cancellation, deadline, exhausted retry, or unrecoverable protocol error,
   return a typed terminal or suspended outcome.

No semantic evaluator runs between steps 6 and completion.

## Explicit Workflow Boundary

Explicit workflow mode is allowed only when the caller provides a typed workflow
definition before execution. It may react to typed receipts and external events.
It must not be synthesized from a task prompt or a failed answer.

A workflow may invoke an agent as one explicit step. An agent may return a typed
result to a workflow. Neither runtime may silently take over planning authority
from the other.

Until a real production caller requires this mode, `ExplicitWorkflowRuntime`
must not become a dependency of the standard agent loop merely to justify its
existence.

## Architecture Invariants

1. Exactly one planner is selected for a run.
2. Observer output cannot cause a model call, tool call, user message, workflow
   transition, or completion veto.
3. Kernel code cannot derive a new effect from free-form task or answer text.
4. In model mode, a valid tool-free response is terminal after attached children
   finish, detach, cancel, or cause a typed suspension.
5. A retry repeats the same operation and consumes one owner-level allowance.
6. A background result is delivered once as a typed transcript event.
7. Resume reconstructs the same planner, transcript identity, durable handles,
   and committed effect receipts.
8. Compaction preserves protocol units and does not create actions.
9. Model changes require no new detector, timeout floor, or closeout rule.

## Verification And Closure Evidence

The architecture is accepted by model-independent checks, not a natural-language
fixture pass:

- static dependency checks prove observer modules cannot import work-submission
  or tool-dispatch APIs;
- transition tests inject compliant, early-finishing, verbose, malformed,
  duplicate-call, and non-deterministic model traces;
- incomplete-final observer tests prove the message transcript is unchanged
  while mission quality projection and diagnostics remain visible;
- legacy recovery-prose tests prove a structured model handoff is still
  dispatched rather than suppressed;
- crash injection covers admission, dispatch, receipt, notification, compaction,
  and resume boundaries;
- fixed-version real-model cohorts measure behavior without changing code
  between samples.

Real-model success rates are release evidence. They do not define control-flow
semantics and do not authorize scenario-specific patches.

## Completed Subtractive Migration

The production migration reduced control surfaces as follows:

1. observer-to-execution dependencies are statically forbidden;
2. both semantic automatic follow-up units and their acceptance contracts were
   removed atomically;
3. production ReAct policy factories are no-op and cannot re-arm completion or
   manufacture product work;
4. explicit workflow remains outside standard agent composition;
5. retired synthetic recovery text cannot continue, budget, suppress, or admit
   production work;
6. historical policy characterization remains available only through explicitly
   test-only wiring, with a guard preventing production composition from enabling
   it;
7. task-text tool filtering is removed, so model mode receives the
   caller-approved capability set without semantic narrowing. Physically
   archiving retired test fixtures is maintenance, not an open
   production control-authority gap.

The migration must not add detectors, prompt repairs, scenario closeouts, new
workflow machinery, or pass-rate-specific gates.

## Non-Goals

- making every current E2E scenario pass;
- predicting every model's failure behavior;
- replacing model planning with a deterministic business rules engine;
- connecting `ExplicitWorkflowRuntime` as a proof of use;
- rewriting persistence, effect durability, retry, or compaction foundations
  that already satisfy kernel responsibilities.
