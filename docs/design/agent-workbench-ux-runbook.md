# Agent Workbench UX Runbook

> Status: current product UX runbook
> Updated: 2026-06-08
> Scope: Control Center pages, mission replay order, quality-gate handling, approvals, context sources, runtime diagnostics, and local entry

## Purpose

TurnkeyAI should feel like a mission workbench, not a browser dashboard. The
Workbench exists so a user can start a goal, watch agent work, approve risky
steps, inspect evidence, and understand why a task is done or needs attention.

## Product Mental Model

The UI follows a product-first information hierarchy: users should see work,
teams, permissions, context, and replay first; prompt harnesses, tool schemas, browser relay, and daemon
diagnostics are supporting runtime layers. The Control Center must not expose
implementation modules as if they were peer user choices.

The core object model is:

| Object | User meaning | UI home |
| --- | --- | --- |
| Mission | A goal with trace, evidence, approvals, final answer, and follow-up. | Missions / Mission Detail |
| Agent / worker | Internal role or worker participating in a mission. | Agents |
| Context source | Evidence or source material a mission can use. | Context |
| Setup path | How the user wants to use TurnkeyAI: in this app, from another AI app, or with browser access. | Setup |
| Browser access | Chrome, Comet, Edge, or Chromium helper used only when missions need logged-in pages or browser evidence. | Setup |
| Diagnostics | Daemon health, transport state, logs, replay, acceptance gates, and recovery. | Diagnostics |
| Models | Model catalog, policy defaults, identity, auth hints, and local paths. | Models |

The default setup path is always "start a mission in this app." External AI
apps and browser access are optional branches. Browser targets and agent
clients are opposite ends of the daemon flow; they must never be rendered as one
preset list.

## Entry Points

Preferred local entry:

```bash
npx @turnkeyai/cli app
```

Source checkout entry:

```text
launchers/TurnkeyAI Mission Control.command
```

Installed local launcher:

```bash
turnkeyai app install-launcher
```

All product entries must open Control Center with the daemon token in the URL
fragment. A bare `/app` URL is expected to show the `Auth token required` page.

## Page Responsibilities

| Page | Route | Responsibility |
| --- | --- | --- |
| First Run | `#/onboarding` | One-time readiness checks before real missions. |
| Missions | `#/missions` | Create, find, and resume mission-level work. |
| Mission Detail | `#/mission/:id` | Primary workbench: trace, evidence, final answer, approvals, sessions, context, quality, and follow-up. |
| Approvals | `#/approvals` | Cross-mission operator decisions for governed actions. |
| Agents | `#/agents` | Agent roster, capability summaries, and assignment visibility. |
| Context | `#/context` | Browser, document, file, and manual context source management. |
| Setup | `#/agent-connect` | Human-facing setup path: start here, connect another AI app, or add browser access. |
| Diagnostics | `#/runtime` | Daemon health, mission health, browser/runtime diagnostics, logs, and release acceptance state. |
| Models | `#/settings` | Model catalog, policy defaults, identity, data paths, auth hints, and local config surfaces. |

## Mission Detail Order

Mission Detail must preserve this order:

```text
mission now / context / recovery / sessions
  -> work trace and tool process
  -> evidence
  -> final answer
  -> follow-up controls
  -> mission health
```

Rules:

- A `Mission now` summary appears above runtime detail cards and shows the
  current or latest state, latest replay event, latest tool step, role/session
  activity, tool counts, and liveness.
- Tool process appears before the final answer.
- The trace is collapsed by default for completed work.
- The collapsed trace still tells the user that the final answer appears below.
- A running tool process with an assistant `messageId` and one or more tool
  calls that have no result exposes `Cancel tool calls`. This must invoke the
  message-level cancellation route, not only cancel a child session, so the
  durable message stream receives cancelled tool results.
- Markdown final answers render headings, lists, tables, and code without
  overlap on desktop or mobile.
- Mobile tables scroll inside their wrapper instead of widening the page.

## Quality-Gate UX

Mission metrics expose a quality status:

- `running`: work is still active or waiting.
- `passed`: final answer, evidence, liveness, failure, residual-risk, and answer
  quality checks are clean.
- `needs_attention`: mission completed but one or more quality checks warn.
- `blocked`: mission or runtime has a failed quality/liveness check.

The quality panel must show both:

- the failing or warning check detail
- a concrete follow-up action

Current guidance:

| Check | User-facing action |
| --- | --- |
| `final_answer` | Continue the mission so the lead can synthesize a final answer. |
| `evidence_backed` | Ask a follow-up that gathers source evidence before synthesis. |
| `evidence_usage` | Ask a follow-up to tie each claim to captured evidence. |
| `answer_substance` | Ask a follow-up for concrete findings and next steps. |
| `unsupported_uncertainty` | Ask a follow-up to replace placeholders with verified facts or explicit residual risk. |
| `tool_fallback_answer` | Continue with a narrower tool-backed request or inspect tool availability before accepting the answer. |
| `residual_risk` | Ask a follow-up to name residual risk or unverified scope. |
| `failure_free` / timeouts | Open the trace, use the tool result or recovery event, then continue with bounded scope. |
| stale runtime | Inspect stale runs, then cancel or continue from the stored session. |

## Approvals

Approval UI must show:

- mission and agent
- requested action
- affected context
- policy hint and risk
- approve and deny choices
- existing decision state

Read-scoped tokens may view approval state but must not submit decisions.

## Context And Evidence

Evidence is product state, not a hidden log line.

Mission Detail should show:

- context sources attached to the mission
- artifacts and browser evidence
- approval decisions
- source coverage in the final answer
- residual risk when evidence is incomplete or time-bounded

Browser activity appears as mission evidence and trace events. Browser/CDP
transport details stay secondary unless the user opens Diagnostics.

## Diagnostics Page

Diagnostics is the operator page. It should answer:

- Is the daemon healthy?
- Is auth configured?
- Are model keys ready?
- Is browser transport healthy?
- Are missions stuck, stale, blocked, or weakly completed?
- Which active mission has been running the longest?
- Are release/acceptance gates fresh and passing?
- For real acceptance gates, what did the mission report prove: scenario pass
  count, quality failures, liveness, tool result coverage, and evidence count?
- Where are logs?

The Reconcile action is safe operator tooling for forcing mission/thread mirror
passes when historical data or background runs need cleanup.

## Setup Page

Setup is not a runtime map. It should answer one user question first:

- How do I start using TurnkeyAI?

Required IA:

- First visible path: "Use this app" with a primary action to start a mission.
- Optional branch: "Use another AI app" with endpoint and token fields.
- Optional branch: "Use a browser" with helper install/load steps.
- Advanced status stays behind disclosure, not in the default viewport.
- Comet appears only as a browser choice, never as an AI app.
- Capability display is diagnostic detail: if a tool cannot execute, the UI and
  prompt-visible surface should not advertise it, but this contract should not
  dominate the human setup flow.

## Models Page

Models is the configuration-oriented companion to Diagnostics. It should answer:

- Which model chain will production missions use?
- Which policy defaults and auth mode are in effect?
- Which local validation commands should an operator run before trusting
  production missions?
- Where are local data, config, logs, and model catalog files?

Models should not teach browser setup. That belongs to Setup.
Models should not become a diagnostics dashboard. That belongs to Diagnostics.

## Smoke Coverage

`npm run control-center:smoke -- --allow-missing-browser` verifies:

- no-token page gives launcher and token recovery paths
- read/operator/admin scope behavior
- Mission Detail ordering: trace before evidence before final answer
- collapsed process with final-answer pointer
- markdown rendering
- desktop and mobile non-overlap
- quality-gate status, detail, and follow-up guidance
- approvals, context attach, model readiness, diagnostics health, and
  reconcile action

Run this before merging Control Center UX changes. Add assertions when a new
Workbench behavior becomes part of the product contract.
