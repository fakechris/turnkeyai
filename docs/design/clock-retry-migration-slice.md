# Clock And Retry Migration Slice

Status: implementation contract for V2 migration step 3. Baseline:
`origin/main@c37d52bb`.

## Objective

Separate active-attempt, operation, caller-wait, and durable-scope clocks, and
make retries consumable capabilities with one owner per failure domain. This
slice removes task wording from time authority. It does not introduce durable
inbox, workflow, policy migration, prompt changes, or E2E tuning.

## Current Deviations

- `tool-use.ts` raises explicit browser timeouts for slow-loopback, approval,
  and supplemental-probe task text.
- `ExecutionBudgetController` can allow a task-derived continuation past the
  configured tool-loop wall-clock budget.
- `LLMGateway` owns transport retries through per-model attempt counters; a
  model fallback can reset those counters instead of consuming one allowance.
- request-envelope compaction attempts are named retries even though they are
  deterministic protocol recovery, which obscures retry ownership.
- `RunDeadline` is an ephemeral active-attempt deadline but its name and events
  do not distinguish it from durable-scope TTL or caller wait.

## Authority Map

| Concern | Owner after this slice | Rule |
| --- | --- | --- |
| Durable scope calendar TTL | durable mission/thread registry | Not implemented in this slice; no active timer may impersonate it |
| Active attempt budget | role-runtime composition root | Monotonic cap; task text cannot enlarge it |
| Model operation timeout | LLM gateway | Bounded by remaining active attempt budget |
| Tool operation timeout | role tool executor | Explicit/platform/parent minimum; task text cannot enlarge it |
| Caller wait | caller/E2E client | Returning `not_ready` cannot abort owned work |
| `model_transport` retry | LLM gateway | One allowance across the whole model chain |
| `tool_transport` retry | concrete tool adapter | Mechanical same-effect retry only; no business fallback |
| `workflow_step` retry | explicit workflow runtime | Deferred until the workflow slice |
| Envelope compaction ladder | role-runtime protocol recovery | Not a transport retry and cannot reset transport allowance |

## Implementation Sequence

1. Add model-independent tests that demonstrate explicit time bounds cannot be
   enlarged by task wording and configured attempt bounds cannot be bypassed by
   continuation policy.
2. Remove task-derived timeout floors and the continuation-past-wall-clock
   exception. Preserve neutral loopback transport classification only.
3. Rename/contract the current run deadline as an active-attempt deadline and
   emit typed attempt/operation expiry reasons. Do not add a durable TTL timer.
4. Introduce a consumable `RetryAllowance` for `model_transport`; allocate one
   per gateway generation and consume it across primary/fallback models.
5. Classify existing lower-level retry sites. Keep only mechanical,
   same-effect adapter retry with an explicit owner; observers, policies, and
   E2E runners cannot consume or mint allowances.
6. Add architecture tests for one retry owner and no task-text import into time
   composition. Run the deterministic gates before opening the next slice.

## Required Counterexamples

- An explicit 5-second browser operation remains at most 5 seconds for every
  task string, including timeout, loopback, approval, and continuation text.
- A 25-second child operation under a 10-second active attempt receives at most
  10 seconds.
- Primary and fallback model failures consume one shared retry allowance; the
  fallback does not reset it.
- A 429 with `Retry-After` cannot consume an exhausted allowance or outlive the
  remaining attempt budget.
- Envelope overflow compaction does not consume or mint model-transport retry
  allowance.
- Observer callbacks do not change retry count, deadline, or terminal result.

## Scope Control

Forbidden in this slice:

- new task detectors, prompt rules, forced tools, closeouts, or final-answer
  rewrites;
- durable inbox, join, workflow-step execution, or policy-row migration;
- E2E fixture changes, threshold relaxation, or real-model-driven patches;
- replacing explicit bounds with model-profile or scenario-derived floors.

## Exit Criteria

- all required counterexamples pass deterministically;
- task text cannot increase attempt or operation time;
- one model-transport allowance spans the full model chain;
- every retained retry site has an explicit failure-domain owner;
- typecheck, agent-core, llm-adapter, react-engine, response-generator,
  tool-use, simulator, policy inventory, and `git diff --check` are green;
- the implementation and exact gate results are recorded before the inbox/join
  slice begins.

## Implemented Result

- active attempt deadlines are typed as `attempt_active`; the old run-deadline
  exports remain compatibility aliases only;
- session, continuation, private-browser, browser-bridge, and tool-loop bounds
  no longer increase from task text, loopback URLs, worker status, or tool kind;
- model transport uses one consumable allowance across the complete primary and
  fallback model chain;
- `boundedSourceTimeoutBudget` and `supplementalLocalTimeoutProbe` are retired
  from the active normalizer/continuation path;
- request-envelope compaction remains protocol recovery and does not create a
  model-transport retry allowance;
- architecture guards reject restoration of the removed floors and bypasses.

Retained retry ownership:

| Site | Failure domain | Owner | Constraint |
| --- | --- | --- | --- |
| `LLMGateway` | `model_transport` | gateway generation | one allowance across all selected models |
| direct CDP detach retry | `tool_transport` | direct CDP adapter | same command/effect, one mechanical reconnect |
| browser relay content-script retry | `tool_transport` | relay action executor | bounded same action; no business fallback |
| request-envelope reduction | protocol recovery | role-runtime envelope reducer | deterministic input reduction, not transport retry |

Final deterministic results on Node.js `v24.14.0`:

- `npm run typecheck`: pass;
- agent-core: 64/64;
- llm-adapter: 60/60;
- react-engine, including architecture guards: 386/386;
- response-generator and tool-use: 315/315;
- operation timeout, attempt deadline, session protocol, sub-agent runtime, and
  browser timeout support suites: 98/98;
- execution-semantics simulator: 17/17, including 10,000 generated budget
  compositions and 5,000 generated effect crash windows;
- runtime-policy inventory/disposition: 2/2;
- `git diff --check`: pass.

No real model, E2E fixture, prompt acceptance rule, or threshold relaxation
participated in this slice.
