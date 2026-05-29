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

## Mission Route Path

Run:

```bash
npm run mission:e2e -- --model-catalog models.local.json
```

Run the mission-level matrix:

```bash
npm run mission:e2e:matrix -- --model-catalog models.local.json
```

This starts an isolated local daemon, creates a mission through `POST /missions`,
polls `GET /missions/:id` plus `GET /missions/:id/timeline`, and reads
`GET /missions/:id/metrics` after completion. The mission prompt points the
explore sub-agent at a local fixture page, so the acceptance does not depend on
public search results. The isolated daemon enables loopback-only explore access
for these fixtures; production daemon defaults still reject loopback/private
hosts in the explore worker. It verifies:

- the product entry path creates a linked team-runtime thread
- the lead model emits `sessions_spawn` from the mission route
- `sessions_spawn` call, result, and final answer appear in timeline order
- `sessions_spawn` progress appears in the correct order when the tool emits user-visible progress
- the tool result contains fixture evidence
- the mission reaches `done` rather than staying `working` or `blocked`
- mission metrics count the tool call/result, spawned session, and evidence event
- mission metrics quality gate reaches `passed` with no active/waiting/stale runtime, recovery, timeout, or failed-tool signal
- the final answer includes the release marker, fixture marker, Markdown bullets, and residual risk

Mission scenarios:

- `basic`: one explore child session verifies a single local fixture source
- `comparison`: two independent explore child sessions verify two local fixture sources, and the final answer must preserve both source markers, source names, source coverage, a comparison conclusion, and residual risk

The script honors `--scenario-timeout-ms` with a default of `180000` ms. It
also sets `TURNKEYAI_MODEL_CATALOG` for the isolated daemon when
`--model-catalog` is supplied.

## When To Run

Run the mock path for every tool-runtime or provider-adapter PR. Run the real
LLM matrix before high-risk tool runtime changes. Run the real LLM + browser
matrix before merging changes that affect browser worker execution, permission
gating, direct-CDP transport, replay, cancellation, or release candidates. Run
the mission route path before shipping user-entry or Control Center changes
that rely on Mission Detail to show tool calls and completion status.

Latest local acceptance on 2026-05-29:

- `npm run tooluse:e2e`
- `npm run tooluse:e2e -- --real-llm --scenario approval --model-catalog models.local.json`
- `npm run tooluse:e2e:real-matrix -- --model-catalog models.local.json`
- `npm run mission:e2e:matrix -- --model-catalog models.local.json --scenario-timeout-ms 240000`
