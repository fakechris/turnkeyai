# Stage 9 V2 Production Migration Closure

Date: 2026-07-12

Merged PR: `#531` (`codex/v2-production-migration`)

Measured runtime commit: `27ef59e6`

Merge commit: `df8e5d1bd6db9bcc7c7a71ee482e4485a3ba7675`

## Closure Decision

Stage 9 V2 production migration is structurally complete. The runtime now has:

- one absolute attempt clock and one retry allowance owner;
- write-ahead effect admission/start/receipt durability;
- durable worker-result inbox, join, detached completion return, and explicit
  resume grants;
- a minimal persisted explicit workflow state machine;
- protocol-safe compaction plus checkpoint/restart validation;
- all 50 policy inventory rows assigned to a signed owner, with production
  authority exactly matching retained rows.

This closes the runtime-foundation migration. It does not claim perfect model
tool selection. The fixed-version MiniMax result below is a release reliability
signal, not permission to restore task-text repair or continuation policies.

## Deterministic Evidence

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass |
| agent-core | 64/64 |
| llm-adapter | 60/60 |
| react-engine | 394/394 |
| llm-response-generator + tool-use | 316/316 |
| role-runtime support | 302/302 |
| core-types + team-runtime + team-store | 202/202 |
| app-gateway | 699 pass, 0 fail, 1 existing skip |
| policy inventory/authority guard | 4/4 |
| execution-semantics simulator | 17/17 |
| `git diff --check` | pass |

No acceptance fixture literal entered changed production code. The old policy
corpus remains test-only characterization and cannot be enabled from another
production composition point under the source guard.

## MiniMax-M3 Measurement

Command: one targeted `natural-followup-continuation` run with a 180-second
deadline, one model (`MiniMax-M3`), no fallback, and structured JSON output.
Code was not edited during the run.

Result: pass in 70.9 seconds. The initial turn spawned one browser worker; the
follow-up submitted an explicit typed `resume-existing` target and executed
`sessions_send` against the same durable `workerRunKey` before synthesis.

| Signal | Result |
| --- | --- |
| mission / natural quality | `done` / pass |
| model calls | 5 |
| input tokens | 51,935 total; 30,189 uncached; 21,746 cache-read |
| output tokens | 3,353 |
| tools / sessions | 3/3 results; 1 spawned; 1 continued |
| liveness | 0 active; 0 waiting; 0 stale |
| compaction / resume | 0 / 0 |
| duplicate tool calls / closeouts | 0 / 0 |
| browser failures / profile fallback | none / 0 |

Structured report: `/tmp/turnkeyai-v2-27ef59e6-followup.json`.

This one pass proves that the typed same-worker contract is executable through
the real MiniMax transport. It is not a claim of a 100% reliability rate or a
replacement for a fixed-version multi-run cohort.

## Release Interpretation

The runtime foundation is mergeable. Deterministic, structural, crash/replay,
and simulator gates are green, and the previously failing strict same-worker
follow-up contract passed through a typed public API on the measured runtime
commit. Remaining cross-model reliability work is measurement and evaluator
generalization, not a reason to restore task-text policy authority.
