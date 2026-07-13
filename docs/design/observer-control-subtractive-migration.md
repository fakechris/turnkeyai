# Observer Control Subtractive Migration

Status: completed on 2026-07-12 for the accepted Agent Control Authority decision.
Product disposition A (observer and caller control) was approved on 2026-07-12.

## Landing Line

Mission semantic evaluators may report incomplete goal slots, blocked quality,
and diagnostics, but cannot create a user turn, model call, tool call, workflow
transition, or completion re-arm.

The standard model-mode runtime remains otherwise unchanged.

## Atomic Change

1. Add an architecture guard that bans observer-to-execution callback surfaces,
   synthetic `System recovery` turns, and their prefix detectors.
2. Keep incomplete-final classification, mission blocked status, and the
   `mission.incomplete_final_answer` activity event as observable data.
3. Remove incomplete-final follow-up generation, retry counting, callback
   options, and daemon `handleUserPost` wiring.
4. Remove the unreachable late-worker follow-up callback/generator. Keep the
   durable worker-result inbox and user-turn projection.
5. Remove obsolete automatic-recovery prefix detectors from completion and
   observability.
6. Replace tests that require synthetic recovery with tests that assert:
   diagnostics remain visible, mission state is blocked/needs attention, and no
   follow-up is submitted.

## Scope Boundaries

Do not:

- connect or modify `ExplicitWorkflowRuntime`;
- change goal-slot inference rules;
- change model prompts, tool schemas, retry, deadline, compaction, journal, or
  effect-ledger behavior;
- add a replacement detector or continuation path;
- relax unrelated mission quality assertions.

## Gates

- observer control architecture guard;
- app-gateway mission completion, bridge, observability, routes, and daemon
  tests;
- `npm run typecheck`;
- agent-core, llm-adapter, role-runtime, team-runtime, and app-gateway suites;
- `git diff --check`.

No real-model run is required because this change deletes hidden planner
authority and preserves evaluator output. Real-model cohorts remain measurement
only after landing.

## Outcome

- Incomplete-final evaluation now leaves the mission blocked and emits one
  `mission.incomplete_final_answer` event; it cannot submit another turn.
- Late worker results enter the durable inbox exactly once and do not reopen a
  mission or invoke model compute.
- Synthetic recovery builders, callback surfaces, retry counters, daemon
  execution wiring, and obsolete prefix detectors were deleted together.
- The architecture guard prevents observer modules from regaining execution
  dependencies or synthetic recovery control surfaces.

Final deterministic gates:

- typecheck: pass;
- agent-core: 64/64;
- llm-adapter: 60/60;
- role-runtime: 932/932;
- team-runtime: 103/103;
- app-gateway: 438/438;
- `git diff --check`: pass.
