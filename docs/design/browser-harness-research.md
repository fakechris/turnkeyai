# Browser Harness Research Notes

Date: 2026-04-19

Source inspected: `browser-use/browser-harness`

Commit inspected: `1973fc78be60efe0342972e43893c43946860936`

## Relevant Findings

The harness is intentionally thin: a small Python daemon attaches to Chrome through the DevTools Protocol and exposes a raw `cdp("Domain.method", **params)` helper. Most higher-level browser operations are thin wrappers around CDP methods such as `Runtime.evaluate`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Page.captureScreenshot`, `DOM.setFileInputFiles`, and `Page.handleJavaScriptDialog`.

Useful patterns for TurnkeyAI:

- Keep a raw CDP escape hatch for browser capabilities that do not deserve first-class typed actions yet.
- Preserve target/session context. Browser-level `Target.*` calls and target-scoped page commands have different routing semantics.
- Treat compositor input, dialogs, downloads/uploads, tabs, frames, shadow DOM, cookies, network inspection, and screenshots as domain skills layered over raw CDP, not as separate transports.
- Keep operator visibility by tracing method name, parameter size, timeout, and bounded result summaries.
- Prefer a relay-mediated path over an open remote-debugging port so peer identity, claim tokens, route contracts, and audit/replay stay in one control plane.

## Runtime Helper Editing Pattern

The harness explicitly supports an "agent running directly edits `helpers.py`" mode. The idea is that when a helper is missing during a live task, the agent patches the local helper file and immediately reuses the new function in the same run.

Research value:

- Good for discovering missing browser primitives quickly.
- Good for turning one-off site knowledge into reusable local helper code.
- Good for exposing which raw CDP calls are actually needed in real tasks.

Product risk if copied directly:

- Runtime-mutated helpers blur the line between task execution and code deployment.
- There is no typed route contract, versioning, review, or rollout boundary.
- A bad helper edit can change behavior for the current run and future runs without audit-grade intent.
- It is hard to bind helper changes to peer identity, lease ownership, replay records, and operator-visible incidents.

TurnkeyAI mapping:

- Do not make runtime helper mutation the production browser model.
- Capture learned helpers as reviewed docs, tests, skills, or typed actions.
- Use the relay CDP proxy as the controlled escape hatch: typed `cdp` action, route validation, relay capability matching, debugger permission on the extension side, bounded timeouts, and trace summaries.
- Promote repeated CDP recipes into first-class browser actions only after they have contract tests and replay/operator semantics.

## Implementation Direction

For local Playwright-backed browser sessions, execute target-scoped CDP through `page.context().newCDPSession(page)`.

For browser relay peers, execute target-scoped CDP through the Chrome extension `chrome.debugger` API. This avoids exposing a remote-debugging port and keeps agent calls inside the existing relay authorization, target ownership, and result submission flow.

Initial guardrails:

- Accept only `Domain.method` shaped CDP method names.
- Block browser/target lifecycle methods from browser task routes for now.
- Require object-shaped params and cap serialized params size.
- Cap action timeout.
- Route `cdp` actions only to peers that advertise `cdp` capability.
- Trace method, params byte size, timeout, and bounded result summaries instead of logging unbounded CDP payloads.
