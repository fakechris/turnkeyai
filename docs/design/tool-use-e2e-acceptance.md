# Tool-Use E2E Acceptance

## Purpose

This acceptance flow validates the native LLM tool-use path before high-risk releases. It is intentionally separate from the normal unit suite so it can be run at key milestones without making every local test require a browser.

## Mock Provider Path

Run:

```bash
npm run tooluse:e2e
```

The mock path uses a scripted provider-native tool call and verifies:

- tool schemas include session, permission, memory, and task tools
- the model emits `sessions_spawn`
- browser side-effect governance emits `permission.query`, waits for approval, applies it, and then continues the same tool call
- the worker receives the original `toolCallId`
- the second LLM round receives a real `role=tool` result message
- native assistant/tool messages and `toolProgress` are persisted

## Real LLM Path

Run:

```bash
npm run tooluse:e2e -- --real-llm --model-catalog models.local.json
```

The real LLM path runs the mock acceptance first, then calls the configured
model through the provider-native tool schema. It verifies:

- the model emits `sessions_spawn` instead of answering directly
- the lead receives a real `role=tool` result
- the final answer contains the release marker from tool evidence

The command needs a configured model catalog and the referenced provider key
environment variable. It is intentionally not part of the normal unit suite.

## Real LLM + Browser Path

Run:

```bash
npm run tooluse:e2e -- --real-llm --with-browser --model-catalog models.local.json --cdp-timeout-ms 45000
```

The browser path first runs the mock provider acceptance above, then asks the
real configured model to delegate to a browser sub-agent. It verifies:

- the lead model emits `sessions_spawn(browser)`
- the browser sub-agent uses its private browser tool surface
- child transcript entries are persisted
- the final answer includes the browser-observed release marker
- direct-CDP browser smoke passes in the same release gate

If the daemon requires auth, export `TURNKEYAI_DAEMON_TOKEN` or rely on the token in `~/.turnkeyai/config.json` as supported by `npm run cdp:smoke`.

## Real LLM Matrix

Run the full release acceptance gate:

```bash
npm run acceptance:real -- --model-catalog models.local.json
```

This is the preferred pre-release command. It runs the provider-native
tool-use matrix with browser/direct-CDP coverage, then runs the mission route
matrix through the user-facing mission creation path. The default mission
matrix includes the realistic operator brief scenario, so the release gate
covers multi-source evidence gathering, browser-rendered dashboard extraction,
and final-answer delivery quality in one product-level run. On completion it
records a `real-llm-acceptance` validation-ops run under the daemon data
directory and writes the mission E2E JSON report under
`<dataDir>/validation-artifacts/real-llm-acceptance/`, so Runtime → Release
acceptance can show whether the latest real LLM gate passed and where to find
the compact mission evidence artifact. Use the narrower commands below only
while investigating a specific failure.

Run the default non-browser matrix:

```bash
npm run tooluse:e2e:real-matrix -- --model-catalog models.local.json
```

By default this runs:

- `basic`: provider-native `sessions_spawn` instead of answering from memory
- `approval`: `permission_query` → `permission_result` → `permission_applied` → `sessions_spawn(browser)` with runtime approval-cache reuse
- `followup`: `sessions_spawn` partial result followed by `sessions_send` on the same child session
- `timeout`: bounded soft timeout with evidence-only synthesis and no automatic follow-up

Run the browser-inclusive matrix:

```bash
npm run tooluse:e2e:real-matrix -- --with-browser --model-catalog models.local.json --cdp-timeout-ms 45000
```

This adds `complex`, which requires independent explore and browser sub-agent evidence, then runs direct-CDP smoke once at the end. To run a smaller subset:

```bash
npm run tooluse:e2e:real-matrix -- --matrix-scenarios approval,followup --model-catalog models.local.json
```

Each real LLM scenario is wrapped in an outer hard timeout, defaulting to
`180000` ms. Override it when investigating a hang:

```bash
npm run tooluse:e2e:real-matrix -- --matrix-scenarios basic --model-catalog models.local.json --scenario-timeout-ms 60000
```

The combined release gate accepts the same timeout knobs:

```bash
npm run acceptance:real -- --model-catalog models.local.json --scenario-timeout-ms 240000 --cdp-timeout-ms 45000
```

The default natural mission leg is the production continuity matrix, covering
multi-source comparison, browser-rendered evidence, browser follow-up, daemon
restart continuation, cold browser-session recreation, non-browser follow-up,
memory recall, approval-gated dry-run action, browser-unavailable closeout,
denied approval safe closeout, pending approval state, timeout closeout,
timeout follow-up, active cancellation, cancellation follow-up, and long delegation. Use
`--natural-mission-scenarios` only for focused investigation; do not treat a
focused subset as release evidence for the full continuity matrix.

By default the run is written to `<dataDir>/validation-ops-runs`, where
`dataDir` is resolved from `--data-dir`, `TURNKEYAI_DATA_DIR`, config
`dataDir`, or `~/.turnkeyai/data`. Use `--no-record-validation-ops` for an
isolated experiment that should not affect the operator release gate.
Use `--mission-json <path>` to override the mission report path, or
`--no-mission-json` for a scratch run that should not write the artifact.
When validation-ops recording is enabled, the gate requires mission and natural
mission JSON artifacts so a passed run always has inspectable mission ids,
quality summaries, and capability evidence. Scratch runs that intentionally
skip artifacts must also pass `--no-record-validation-ops`.

For environments without Chrome/CDP, the combined gate can skip only the
provider-native browser/direct-CDP leg while still running the mission route
browser-dynamic scenario:

```bash
npm run acceptance:real -- --model-catalog models.local.json --skip-browser-tooluse
```

For focused quality-signal validation after a reporting or Mission metrics
change, skip the tool-use leg and run only the mission scenarios that exercise
the signal. This still records validation-ops and the mission JSON artifact:

```bash
npm run acceptance:real -- --skip-tooluse --mission-scenarios comparison,realistic-brief --model-catalog models.local.json --scenario-timeout-ms 300000
```

## Mission Route Path

Run:

```bash
npm run mission:e2e -- --model-catalog models.local.json
```

Run the mission-level matrix:

```bash
npm run mission:e2e:matrix -- --model-catalog models.local.json
```

Write a structured acceptance evidence report:

```bash
npm run mission:e2e:matrix -- --model-catalog models.local.json --json /tmp/turnkeyai-mission-e2e-report.json
```

This starts an isolated local daemon, creates a mission through `POST /missions`,
polls `GET /missions/:id` plus `GET /missions/:id/timeline`, and reads
`GET /missions/:id/metrics` after completion. The mission prompt points the
explore sub-agent at a local fixture page, so the acceptance does not depend on
public search results. The isolated daemon enables loopback-only explore access
for these fixtures; production daemon defaults still reject loopback/private
hosts in the explore worker. In matrix mode the script prints a per-scenario
start line before each real mission and a per-scenario pass line with mission
id, quality gate, tool/session counts, liveness, and elapsed time immediately
after that scenario completes, so a long release gate does not appear idle until
the whole matrix finishes. It verifies:

- the product entry path creates a linked team-runtime thread
- the lead model emits `sessions_spawn` from the mission route
- session tool calls, results, and final answer appear in timeline order
- `sessions_spawn` progress appears in the correct order when the tool emits user-visible progress
- the tool result contains fixture evidence
- the mission reaches `done` rather than staying `working` or `blocked`
- mission metrics count tool calls/results, spawned/continued sessions, and evidence events
- mission metrics include wall-clock duration, requested/result/executed/skipped tool counts, spawned/continued sessions, timeout/cancellation/failure counts, and evidence events
- mission metrics quality gate reaches `passed` with no active/waiting/stale runtime, recovery, timeout, or failed-tool signal
- the final answer includes the release marker, fixture marker, Markdown bullets, and residual risk
- final-answer quality gates reject tool/search/browser-unavailable fallback
  answers that rely on model knowledge instead of captured evidence

Mission scenarios:

- `basic`: one explore child session verifies a single local fixture source
- `comparison`: two independent explore child sessions verify two local fixture sources, and the final answer must preserve both source markers, source names, source coverage, a comparison conclusion, and residual risk
- `followup`: a user follow-up reopens a completed mission, calls `sessions_send` exactly once on the existing child session, avoids duplicate `sessions_spawn`, and completes with the same mission metrics quality gate
- `cancel`: a slow explore child session is cancelled through `/message/cancel-tools`, the worker session reaches `cancelled`, mission liveness settles to zero, and the final answer reports the controlled cancellation instead of leaving the mission `working`
- `approval`: a browser child session request triggers the runtime `browser.form.submit` approval gate, the script approves the real `/approvals/:id/decision` request, the same tool call continues through `permission.query`, `permission.result`, and `permission.applied`, and the final answer cites the approved local fixture without performing an external mutation
- `browser-dynamic`: one browser child session opens a JavaScript-rendered local dashboard fixture, extracts dynamic DOM evidence that is not present in raw server HTML, and completes with browser-specific evidence plus residual risk
- `browser-dashboard`: one browser child session investigates a dynamic incident dashboard fixture, extracts status/severity/incident evidence from the rendered page, and produces a concise operational summary with source-bounded evidence
- `timeout-recovery`: one explore child session is intentionally bounded with `timeout_seconds=0.001`, the worker session is interrupted into `resumable`, mission liveness settles to zero, and the lead produces a bounded final answer without spawning fallback tools
- `memory-recall`: a follow-up seeds durable thread memory, then the lead must call `memory_search` at least once and at most twice, call `memory_get` exactly once before producing a source-bounded final answer, and avoid delegating to session tools
- `task-tracking`: the lead must call `tasks_list`, call `tasks_create` at least once and at most twice, call `tasks_update` exactly once, use the created work-item id for the update, and leave exactly one product-visible mission task in `done` state even if the model repeats the same create call
- `product-workbench-brief`: three independent child sessions gather orchestration, bridge capability, and browser-rendered product-signal evidence, then the lead must produce a decision-grade product brief with concrete next actions, source-bounded claims, and no hedged placeholders
- `realistic-brief`: three independent child sessions gather two vendor fixture sources plus one browser-rendered operations dashboard, then the lead must produce an operator-ready brief with source coverage, recommendation, dashboard action, and residual risk without a fully templated final answer

The script honors `--scenario-timeout-ms` with a default of `180000` ms. It
also sets `TURNKEYAI_MODEL_CATALOG` for the isolated daemon when
`--model-catalog` is supplied.

The optional JSON report records the scenario, mission id, status, thread id,
timeline/tool event counts, tool/session/approval/liveness metrics, evidence
and recovery event counts, final-answer byte and bullet counts, and quality
failures. It intentionally omits the final-answer body so the artifact stays
small and safe to attach to release notes or review comments.

## When To Run

Run the mock path for every tool-runtime or provider-adapter PR. Run the real
LLM matrix before high-risk tool runtime changes. Run the real LLM + browser
matrix before merging changes that affect browser worker execution, permission
gating, direct-CDP transport, replay, cancellation, or release candidates. Run
the mission route path before shipping user-entry or Control Center changes
that rely on Mission Detail to show tool calls and completion status.

Latest local acceptance on 2026-05-30:

- `npm run tooluse:e2e`
- `npm run tooluse:e2e -- --real-llm --scenario approval --model-catalog models.local.json`
- `npm run tooluse:e2e:real-matrix -- --model-catalog models.local.json`
- `npm run tooluse:e2e:real-matrix -- --with-browser --model-catalog models.local.json --cdp-timeout-ms 45000 --scenario-timeout-ms 240000`
- `npm run mission:e2e:matrix -- --model-catalog models.local.json --scenario-timeout-ms 240000`
- `npm run mission:e2e:matrix -- --model-catalog models.local.json --scenario-timeout-ms 240000 --json /tmp/turnkeyai-mission-e2e-report.json`
- `npm run acceptance:real -- --model-catalog models.local.json --scenario-timeout-ms 300000 --cdp-timeout-ms 45000 --data-dir /tmp/turnkeyai-real-acceptance-20260530162834`

The latest full gate recorded validation-ops run
`validation-ops:real-llm-acceptance:2026-05-30T08-28-34-523Z:tg62k7` with
status `passed`.
