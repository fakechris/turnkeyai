# Browser Sub-Agent Safety Runbook

## Purpose

Browser control is a tool for completing a mission, not the user-facing product
itself. This runbook defines how browser work is delegated, constrained,
observed, recovered, and accepted in production-style local runs.

## Execution Boundary

The lead role should delegate browser work through:

```text
sessions_spawn({ agent_id: "browser", ... })
```

Browser primitives remain private to the browser sub-agent. The lead can ask
for a browser task and receive evidence, but it should not directly drive
low-level navigation, clicks, DOM probes, or raw CDP commands.

The intended runtime split is:

| Layer | Responsibility |
| --- | --- |
| Lead | Plan the mission, delegate independent work, merge evidence, produce the final answer. |
| Browser sub-agent | Operate browser tools, collect page evidence, handle page-specific retries, summarize evidence. |
| Bridge/transport | Enforce session ownership, route commands, surface transport failures, and protect raw-CDP access. |
| Operator UI | Show trace, approvals, liveness, recovery state, final answer, and validation readiness. |

## Allowed Browser Work

Browser sub-agents may use the browser tool surface to:

- navigate to an approved URL
- inspect rendered DOM and dynamic page state
- capture snapshots or screenshots
- interact with form controls after approval when the action is side-effectful
- collect source-bounded evidence for the final mission answer

Browser sub-agents must not use browser tools to silently perform irreversible
external side effects. Those actions require the approval loop described below.

## Approval Loop

Risky browser actions must emit:

1. `permission.query`
2. operator decision through `/approvals/:id/decision`
3. `permission.result`
4. `permission.applied`
5. the resumed tool result

The same original tool call continues after approval. Do not model approval as
a separate, unrelated tool call; that breaks replay and makes the operator
timeline misleading.

## Timeout And Retry Policy

Use product-level budgets rather than tiny tool-round caps.

| Case | Policy |
| --- | --- |
| Browser sub-agent soft timeout | Let the worker summarize only already-collected evidence; do not invent missing facts. |
| Browser sub-agent hard timeout | Mark the sub-session resumable or failed, then surface an actionable recovery event. |
| Same browser operation retry | Bound to a small count and keep retry evidence in the trace. |
| CDP command timeout | Do not auto-retry; the command may already have executed. |
| Expert session detached mid-command | Reattach once when target metadata is still valid, then retry that in-flight command once. |
| Browser/CDP unavailable | Clear transport/session state and surface `browser_cdp_unavailable` to replay/operator surfaces. |

Long-running missions should remain observable through mission metrics:
wall-clock duration, requested/results/executed/skipped tools, spawned and
continued sessions, failures, timeouts, cancellations, and quality-gate state.
Diagnostics should also aggregate the longest active mission duration so
operators can tell whether "working" is fresh progress or a long-running span
that needs inspection.

## Browser Environment Hygiene

Chrome profile ownership issues can make browser tasks appear flaky even when
the tool runtime is healthy. Before diagnosing the agent policy, check:

- whether another Chrome process owns the same profile
- whether relay or direct-CDP is selected intentionally
- whether the CDP endpoint is reachable
- whether the relay extension is loaded in the intended browser profile
- whether the daemon data directory is isolated for acceptance runs

Useful commands:

```bash
turnkeyai bridge status
turnkeyai daemon status
turnkeyai daemon logs --follow
npm run cdp:smoke -- --timeout-ms 45000
```

## Evidence Requirements

A browser-backed final answer should identify what was actually observed. It
should not present fixture text, model memory, or page assumptions as browser
evidence.

For dashboard-style pages, require concrete evidence such as:

- page title or route
- status/severity labels
- incident or row identifiers
- rendered metric values
- relevant timestamps or update labels
- residual risk when the page does not contain enough information

Mission acceptance should reject answers that only say the page was visited or
that provide generic operational advice without source-bounded evidence.

## Replay And UI Expectations

Mission Detail should show the process above the final answer:

- lead planning and delegation events
- tool calls and progress
- browser sub-session evidence
- approval events when present
- recovery and timeout events when present
- final answer last

Verbose trace content may be collapsed by default, but ordering must remain
chronological. Final answer rendering should support Markdown lists, headings,
tables, and code fences without overlapping process content.

## Release Acceptance

Run the relevant acceptance gates before merging browser-runtime changes:

```bash
npm run tooluse:e2e
npm run tooluse:e2e:real-matrix -- --with-browser --model-catalog models.local.json --cdp-timeout-ms 45000 --scenario-timeout-ms 240000
npm run mission:e2e:matrix -- --model-catalog models.local.json --scenario-timeout-ms 240000
npm run acceptance:real -- --model-catalog models.local.json --scenario-timeout-ms 240000 --cdp-timeout-ms 45000
```

For a focused browser/context quality gate after Mission metrics or acceptance
reporting changes, use a mission-only real acceptance run:

```bash
npm run acceptance:real -- --skip-tooluse --mission-scenarios browser-dashboard,realistic-brief --model-catalog models.local.json --scenario-timeout-ms 300000
```

The `browser-dynamic` and `browser-dashboard` mission scenarios are the key
user-facing gates for browser-as-context-source behavior. Direct-CDP smoke is
the transport gate for expert-lane reliability.
