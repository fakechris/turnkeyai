# Stage 9 V2 Production Migration Closure

Date: 2026-07-12

Branch: `codex/v2-production-migration`

Measured commit: `c4a9577c`

Push status: not pushed

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
| react-engine | 393/393 |
| llm-response-generator + tool-use | 315/315 |
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

Command: one natural core matrix run with a 180-second per-scenario deadline,
one model (`MiniMax-M3`), no fallback, and structured JSON output. Code was not
edited during the run.

Result: the first three scenarios passed; the runner stopped on the first
failure in scenario 4, as required.

| Scenario | Result | Duration | Model calls | Input / output tokens |
| --- | --- | ---: | ---: | ---: |
| comparison research | pass | 60.8s | 3 | 21,761 / 1,377 |
| provider search pricing | pass | 66.6s | 3 | 24,368 / 1,388 |
| browser dynamic page | pass | 41.5s | 4 | 46,787 / 1,504 |
| follow-up continuation | fail | 61.7s | 4 | 40,238 / 2,948 |

Aggregate attempted work: 14 model calls, 133,154 input tokens, 61,730
uncached input tokens, 71,424 cache-read input tokens, and 7,217 output tokens.
About 53.6% of input tokens were cache reads.

Failure bucket: `model_tool_selection / continuation_contract_miss`.

The initial turn completed `sessions_spawn` and `artifacts_read`. On the
follow-up, MiniMax produced a source-bounded decision note directly from the
existing transcript and did not call `sessions_send`. The harness requires the
same worker session to be revisited, so it failed the scenario. The run itself
terminated normally within the deadline: 0 compactions, 0 resume events, 0
duplicate tool calls, and 0 closeout reasons. This is not a timeout, crash,
stuck loop, or exactly-once failure.

Structured report:
`/tmp/turnkeyai-v2-c4a9577c-natural-core.json`

Retained runtime root:
`/var/folders/s9/szs_2cwj41d2l0n_1r85nnnm0000gn/T/turnkeyai-mission-e2e-fsmluX`

## Release Interpretation

The runtime foundation is mergeable on deterministic and structural grounds.
The natural core matrix is not fully green, so a release that promises strict
same-worker follow-up execution should remain gated. A release whose contract
allows transcript-backed continuation can evaluate that product requirement
separately; this migration does not silently redefine it.
