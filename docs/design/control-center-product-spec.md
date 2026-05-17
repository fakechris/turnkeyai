# Control Center — Product Spec (PR J0)

> Status: **draft, awaiting sign-off**. PR J1–J3 implementation is gated on agreement here. Edits welcome.

## 0. Why this exists

PRs F→I shipped a daemon-served five-page dashboard. It is now a real product entry point: `turnkeyai app` auto-starts the daemon, opens the browser, hands the dashboard a least-privilege token. But everything user-visible is **read-only**.

The next arc — provisionally PR J1, J2, J3 — adds mutations: spawning sessions, navigating tabs, switching transports, regenerating tokens, configuring LLM providers. Before any of those land, we need a shared answer to four questions:

1. **What user flows are we committing to?** (so we don't ship a generic button menu)
2. **What permissions does each flow require?** (so the dashboard doesn't silently 401)
3. **What does the page map look like end-to-end?** (so the codebase doesn't fragment into ad-hoc routes)
4. **What state does each page own?** (so a "selected tab + selected session" model is consistent across pages)

This document is that answer. It is intentionally not a code change.

## 1. Scope & non-goals

**In scope (PR J series):**

- A coherent **Browser Workbench** model: selected tab, selected session, allowed actions, last result, recoverability state.
- Mutation affordances where the UX contract is clear (start session, navigate, snapshot, screenshot, revoke).
- A guided **Agent Connect** with token-scope-aware presets.
- A first-class **Settings** page covering LLM providers + browser onboarding (extension install, CDP endpoint).
- Migration of the dashboard out of `packages/cli/control-center/app.js` (vanilla 933+ lines) into a first-class `packages/control-center/` Vite-built app.

**Explicitly out of scope (PR J series):**

- Replay UI for failed flows (the daemon already exposes operator-triage; the UI shows summaries, not interactive replay rerun).
- Validation suite triggering from the dashboard (admin-only, lives in CLI / CI).
- Multi-daemon support (single-daemon-per-app assumption holds).
- Cloud sync / multi-device dashboard.
- Electron wrapper (a future PR K; current J series keeps the daemon-served pattern).

**Explicitly deferred to a later round:**

- Recovery run mutations (retry / approve / reject / fallback). The daemon supports them; the UX contract is not yet clean enough to expose without making it too easy to do the wrong thing.
- Browser session expert-lane direct-CDP affordances. Power users use `turnkeyai bridge` from a terminal.

## 2. Personas

The dashboard serves two distinct personas. Calling them out explicitly because they have **different default views** and **different banner tolerances**.

**P1 — Plugger (default).** Wants to plug an agent (Claude Code, Codex, Comet, Kimi, custom) into the daemon and get it controlling the browser. Cares about: connection works, the right token is in the agent config, current tabs are visible. Tolerates ZERO unexplained failures; tolerates small "what is this" inline education.

**P2 — Operator.** Has multiple sessions running. Watches what an agent is doing. Recovers when things go wrong. Cares about: per-session live state, recent action latency, failure classification, log tail. Tolerates dense layouts and JSON; does NOT tolerate hidden state that makes a wedged session unkillable.

The dashboard's default route is the Plugger view. Operator surfaces are reachable but not in the user's face.

## 3. Final user stories

The user proposed six. Spec'ing each as: **goal · entry point · happy path · failure paths · permission gate**.

### US-1 — First Run

> A new user opens TurnkeyAI for the first time and gets to "Ready for agents" without touching a terminal beyond `turnkeyai app`.

**Entry point**: `turnkeyai app` (CLI) opens the dashboard at the default `#/setup` route. The dashboard then calls `GET /onboarding/state` on mount; if `completedAt === null` it routes to `#/onboarding` and replaces the URL via `history.replaceState`. This makes the dashboard authoritative for routing — the CLI doesn't need to know whether onboarding is needed.

**Happy path:**

1. CLI launches daemon (PR I shipped this), opens dashboard with operator-token preloaded.
2. Dashboard fetches `GET /onboarding/state` on first load. If `completedAt === null`, route to `#/onboarding`.
3. Wizard renders as three steps; **the marker is updated after EACH step**, not just the last (so a user who exits the wizard halfway is not trapped on next launch):
   - **Step 1** — pick transport (Local / Relay / Direct-CDP), each with a one-sentence tradeoff. On select: `PUT /daemon/config/browser-transport` (admin-gated; if scope < admin the wizard surfaces a "rerun `turnkeyai app` as admin" instruction). On success: `PUT /onboarding/state` with `{step: "transport-chosen"}`.
   - **Step 2** — if Relay or Direct-CDP, guided extension/endpoint setup (see US-3). On success: `PUT /onboarding/state` with `{step: "transport-verified"}`.
   - **Step 3** — "Ready for agents" with a link to Agent Connect. On click: `PUT /onboarding/state` with `{completedAt: <now>}`.
4. **Daemon restart after transport change**: changing `browser-transport` requires a daemon restart to take effect. The dashboard shows a "Restarting daemon…" overlay, calls `POST /daemon/restart` (NEW — admin-gated, see §6), then polls `GET /health` until ready (max 15s). On failure: surface the error + manual `turnkeyai daemon restart` instruction. The user is NEVER left with a connection-failed error and no explanation.

**Failure paths:**

- Daemon failed to start → CLI surfaces (PR I shipped). Dashboard never loads.
- Extension install fails → Step 2 keeps the user there with a retry button + manual instructions (`chrome://extensions`).
- Direct-CDP endpoint unreachable → Step 2 shows the probe failure inline.
- Onboarding-state PUT 401 → wizard surfaces "this dashboard's token can't write onboarding state; run `turnkeyai app` with an operator-or-above token". (Should not happen in practice — `turnkeyai app` defaults to operator scope when one is available.)

**Permission gate**: dashboard runs on whatever token `turnkeyai app` resolved. `GET /onboarding/state` is `read`. `PUT /onboarding/state` (marker only) is `operator`. **Transport selection itself is `admin`** via `/daemon/config/browser-transport` — the wizard step renders an admin-required hint if scope < admin (gemini-HIGH catch: onboarding cannot be a back-door around admin-gated config changes).

**Marker location**: `<runtimeRoot>/onboarding.json` where `runtimeRoot` is resolved via `getRuntimePaths()` (already platform-aware: honors `TURNKEYAI_HOME` env var, defaults to `path.join(homedir(), ".turnkeyai")` cross-platform). Separate from `config.json` so auth config stays purely about auth + port.

### US-2 — Connect An Agent

> A user picks an agent (Claude / Codex / Comet / Kimi / custom OpenAPI), gets the right endpoint + the right-scope token, and understands what that token can do.

**Entry point**: `#/agent` (existing route, but redesigned).

**Happy path:**

1. User picks one of: Claude Code, Codex CLI, Codex IDE, Comet, Kimi, "Custom (OpenAPI)".
2. For each preset, the page shows:
   - **Endpoint** (always `http://127.0.0.1:<port>/bridge/command` for Tier-1 use; `/bridge/expert` for direct-CDP).
   - **Auth headers** (`Authorization: Bearer …` AND `x-turnkeyai-token: …`).
   - **Scope explanation**: "This token can drive the browser. It cannot run admin/validation routes." or the equivalent for the actual scope.
   - **Copy-ready config snippet** in the preset's native format (Claude skill markdown, Codex MCP config, Comet whatever, etc.).
3. A "Test connection" button does a `GET /bridge/status` and reports OK / 401 / unreachable inline.

**Failure paths:**

- Scope is `read` → mutation snippets HIDDEN; banner explains how to set `TURNKEYAI_DAEMON_OPERATOR_TOKEN` and restart. (PR I shipped this already.)
- Scope is `admin` → banner suggests narrower operator token. (PR I shipped this.)
- Daemon down → "Test connection" reports unreachable; no snippet shown.

**Permission gate**: `read` to render scope. "Test connection" needs `read`.

**Token regeneration**: there's a "Regenerate token" button. It calls `POST /daemon/auth/regenerate-token` (NEW endpoint, see §6) and then prompts the user to re-open the dashboard (`turnkeyai app` again) because the in-memory token they're holding is now invalid. This is `admin`-gated because anyone with the regenerate power could lock out other holders.

### US-3 — Control Browser Access

> The user sees current tabs, can mark them allowed/blocked, can attach a session to a tab, can start a new session, can close/revoke.

**Entry point**: `#/workbench` (replaces `#/tabs` from PR G).

**Happy path:**

1. Two-pane layout:
   - Left: list of browser sessions (relay peer + tab list, or local sessions if transport=local).
   - Right: per-session detail — selected session, current tab, allowed action list, last action result.
2. **Selected-session model** (canonical client state):
   ```
   workbench = {
     selectedSessionId: string | null
     selectedTabId: string | null      // within the selected session
     allowedActions: Set<ActionKind>   // derived from session capabilities + scope
     lastResult: { actionId, status, timestamp, payloadSummary } | null
     recoverability: "healthy" | "recoverable" | "wedged"
   }
   ```
3. Affordances (each requires `operator`):
   - **Start session** (button in left pane): opens `POST /browser-sessions/spawn` with the current thread context. Requires a thread to be selected from a dropdown (so we don't ship a "ghost session" with no owner).
   - **Attach to existing tab**: select a discovered relay tab, press "attach" → `POST /browser-sessions/:id/activate-target`.
   - **Navigate**: `POST /bridge/command` with `{tool: "navigate", args: {url}}`. Confirms when navigating away from a non-blank URL.
   - **Snapshot**: `POST /bridge/command` with `{tool: "snapshot"}`. Inline JSON viewer.
   - **Screenshot**: `POST /bridge/command` with `{tool: "screenshot"}`. Inline image preview.
   - **Revoke session**: `POST /browser-sessions/:id/revoke`. Confirmation dialog requires the user to type the literal string `REVOKE` (constant — auto-generated IDs in the dialog are too easy to mis-type). Dialog also shows the session ID + thread ID + how many actions the session has executed so the user has context for the decision.
4. **Visible-state guarantee** (with caveat): every active session has a row in the left pane within at most one poll tick. **The current 5s polling makes this an aspiration, not an enforcement** (gemini catch) — a fast-running agent can execute multiple actions before the next tick surfaces the session. WebSocket events (see §6, J4+) are the real fix. Until then: the dashboard is a fast-converging mirror of daemon state, not an instantaneous one. **The hard guarantee that DOES hold** (because the daemon enforces it server-side) is that no session can run without being persisted to the daemon's session store — so any dashboard reload AT WORST has a 5s lag before showing it. Sessions cannot be hidden from inspection, only delayed.

**Failure paths:**

- Action denied by scope (e.g. dashboard has read token, user tries to attach) → button disabled in advance + tooltip explains. We do not let the user click and surface a 401.
- Action 4xx from daemon → toast + last-result entry retains the error body.
- Session becomes "wedged" (no progress, no events for > 60s while active) → recoverability turns red + offers "Recover" (reconnect transport / re-attach / hard revoke).

**Permission gate**: viewing requires `read`; all mutations require `operator`.

**Allow/block list** (the user's "mark tabs as allowed / blocked"): deferred to a follow-up. Today we have no enforcement layer for "agent must not touch this tab" — adding one is a meaningful feature, not just UI. Tracking as an open question (§7).

### US-4 — Observe Agent Work

> The user sees current session, active tab, latest action, latest screenshot/snapshot, and which transport is in use.

**Entry point**: `#/workbench` (same as US-3, observer mode = no actions taken). Also reachable from `#/diagnostics` for "what's the daemon doing right now" view.

**Happy path:**

1. The workbench's right pane already shows current tab + last action (US-3). Adds:
   - **Action timeline** (last 20 actions for the selected session, polled 5s): kind, timestamp, status, latency.
   - **Latest screenshot/snapshot inline** (whichever was last requested).
   - **Transport pill** (top-right, persistent across pages): "Local" / "Relay (2 peers)" / "Direct-CDP". Color-coded.
   - **Expert lane indicator**: small badge when direct-CDP expert lane is active.

**Failure paths:**

- No selected session → empty state with a "pick a session" hint.
- Session has no recent actions → "Idle — last action 3m ago".

**Permission gate**: `read` everywhere.

### US-5 — Recover From Failure

> Failure is shown as a concrete bucket. The user sees the next action. Unsafe retries require confirmation.

**Entry point**: a "Recover" subroute under Workbench when recoverability state is `recoverable` or `wedged`. Also a global banner if the daemon has any recovery runs in `awaiting-attention` state.

**Happy path:**

1. Failure surfaces as a card with three fields:
   - **Bucket** (one of the daemon's failure taxonomy classifications — `transport_lost`, `tab_closed`, `cdp_unavailable`, `permission_denied`, `timeout`, `extension_disconnected`).
   - **What happened** (one-sentence explanation drawn from the daemon's classification).
   - **Suggested next action** (button — see below).
2. Concrete next-action buttons per bucket:
   - `transport_lost` → "Reconnect transport" (calls `POST /browser-sessions/:id/resume` or transport-specific reconnect).
   - `tab_closed` → "Re-attach to tab" (asks user to pick a new target).
   - `cdp_unavailable` → "Check CDP endpoint" (links to Settings → Browser).
   - `permission_denied` → no button; shows the permission scope that failed and the env var to set.
   - `timeout` → "Retry last action" (confirmation required since the action could be non-idempotent).
   - `extension_disconnected` → "Check extension" (links to Settings → Browser; explains how to reload).
3. **Unsafe retries** (anything in a `non-idempotent` bucket): require the user to type the action kind to confirm.

**Permission gate**: viewing is `read`; recovery actions are `operator`.

**Recovery-run mutations (approve / reject / retry / fallback)**: still deferred. The daemon's recovery layer is more nuanced than a simple "retry" — gating those behind a "Show advanced recovery" toggle later, not in J2.

### US-6 — Operator / Power User

> Diagnostics bundle exists. Logs are redacted. Replay/operator triage is visible. Admin capabilities are clearly separated.

**Entry point**: `#/diagnostics` (existing). Extended with a sibling `#/operator` for triage summaries.

**Happy path:**

1. Diagnostics page (PR H shipped this): runtime info + redacted log tail + "Copy bundle" button. PR I added the redaction.
2. **NEW Operator page** at `#/operator` (only shown in nav if scope is `operator` or higher):
   - **Active runtime chains** (from `GET /runtime-chains?status=active`).
   - **Stale chains** (`GET /runtime-chains/stale`).
   - **Recovery runs awaiting attention** (`GET /recovery-runs?status=awaiting-attention`).
   - Each row is read-only with a "View" expand. No retry/approve buttons yet (see US-5 deferral).
3. **Admin gating**: validation routes (`/validation-*`, `/release-readiness/run`, etc.) and relay-peer mutation routes do NOT appear in any UI. They remain CLI-only.

**Permission gate**: viewing requires `read` for Diagnostics, `operator` for the Operator page. Admin routes never surface.

## 4. Permission model

The daemon already has four token scopes (`read`, `operator`, `relay-peer`, `admin`). The dashboard maps them onto **UI affordance tiers**:

| Scope    | Dashboard tier      | What the user can do                                            |
| -------- | ------------------- | --------------------------------------------------------------- |
| `read`   | Observer            | All read pages (Setup, Bridge, Workbench-as-viewer, Diagnostics). NO mutation buttons rendered. Agent Connect: snippet hidden, banner explains. |
| `operator` | Default (Plugger) | Everything above + Workbench mutations (spawn/attach/navigate/snapshot/screenshot/revoke). Agent Connect: full snippet. Operator page accessible. |
| `admin`  | Operator + Settings | Everything above + Settings actions that mutate daemon config (regenerate token, edit LLM catalog). Subtle "consider operator" banner. |
| `relay-peer` | (CLI only)      | Not a dashboard surface. Relay peer registration is extension-mediated; dashboards don't run as peers. |

**Anti-pattern this matrix prevents**: a button that renders unconditionally and then 401s when clicked. Every mutation button is **gated client-side AT RENDER TIME** on `state.scope`, AND the daemon enforces server-side. The dashboard refusal is a usability layer, not a security boundary.

**Token resolution** (recap from PR I): `OPERATOR → legacy → ADMIN → READ → config.token`. The dashboard inherits whatever `turnkeyai app` resolved and surfaces it as the "Token scope" line on Agent Connect.

**Token regeneration UX**: the only mutation that breaks the dashboard's own auth (because the new token isn't pre-loaded). After regenerating, the dashboard prompts: "Token changed. Close this tab and run `turnkeyai app` again to reconnect with the new token." We do not try to live-swap the in-browser token — it's a foot-gun without a clear win.

## 5. Final page map

The current 5-page layout becomes a 6-page layout. Reasoning for each change is inline.

| Route             | Page name        | Replaces         | Why                                                                                                    |
| ----------------- | ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `#/onboarding`    | First Run        | (new)            | First-run wizard; only routed when no onboarding marker exists. Auto-redirects to `#/workbench` after. |
| `#/workbench`     | Browser Workbench | `#/tabs`         | Merged "list of tabs/threads" with per-session detail + mutations. The Tabs page was an MVP stepping-stone. |
| `#/agent`         | Agent Connect    | `#/agent`        | Redesigned with presets + scope-aware snippets (PR I-shaped, now with preset cards).                  |
| `#/operator`      | Operator         | (new, gated)     | Active chains / stale / recovery-attention. Only visible when scope ≥ `operator`.                      |
| `#/diagnostics`   | Diagnostics      | `#/diagnostics`  | Unchanged from PR H + I (env + redacted logs + copy bundle).                                            |
| `#/settings`      | Settings         | (new)            | LLM providers, browser onboarding (extension install button, CDP endpoint), advanced (regenerate token). |

Routes removed: `#/setup`, `#/bridge`, `#/tabs`. Their content folds in:

- `#/setup` → `#/onboarding` for first-run, the existing "static checklist" content becomes a section in `#/settings → Browser`.
- `#/bridge` → the metric grid moves into the persistent transport pill (top-right) for at-a-glance, with full detail folded into `#/diagnostics`.
- `#/tabs` → `#/workbench`.

**Navigation** stays as a top-bar with the visible pages (5 default, +Operator when scope ≥ operator). First-run wizard is full-screen with no nav.

## 6. Daemon endpoints — exists vs. need

Almost everything J2/J3 needs already exists. Two new endpoints required:

### Needed (NEW)

| Endpoint                              | Method | Purpose                                                                         | Auth   |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------- | ------ |
| `/daemon/auth/regenerate-token`       | POST   | Rotate the daemon's auth token; invalidates the current one. Used by Settings. | admin  |
| `/daemon/restart`                     | POST   | Trigger an in-place daemon restart so a config change (transport, etc.) takes effect. Returns immediately; dashboard polls `/health` to detect ready. | admin |
| `/daemon/config/llm-providers`        | GET    | Read current model catalog (file contents + which file).                       | read   |
| `/daemon/config/llm-providers`        | PUT    | Replace model catalog (validated against the catalog schema).                  | admin  |
| `/daemon/config/browser-transport`    | GET    | Current transport mode + endpoint (subset of /bridge/status formalised).       | read   |
| `/daemon/config/browser-transport`    | PUT    | Change transport mode; requires daemon restart to take effect.                 | admin  |
| `/onboarding/state`                   | GET    | Has the user completed first-run? Returns `{completedAt: number \| null, transportChosen: string \| null}`. | read   |
| `/onboarding/state`                   | PUT    | Update onboarding markers (which step the user reached, completedAt timestamp). Body: `{step?: string, completedAt?: number}`. **Does NOT change transport** — that goes through the admin-gated `/daemon/config/browser-transport` PUT. | operator |

### Already exists (no change needed)

`GET /bridge/status`, `GET /diagnostics`, `GET /diagnostics/logs`, `GET /threads`, `GET /relay/peers|targets`, `GET /browser-sessions`, `POST /browser-sessions/spawn`, `POST /browser-sessions/:id/revoke`, `POST /browser-sessions/:id/activate-target`, `POST /bridge/command`, `POST /bridge/advanced`, `POST /bridge/batch`.

### Probably-needed-later, deferred to J4+

- `GET /sessions/:id/timeline` — currently the dashboard would have to fold `runtime-chains` + `runtime-progress` + `replays`. Acceptable for J2; introduce a dedicated endpoint when the merge logic becomes a bottleneck.
- `WebSocket /events` — for live updates instead of 5s polling. Worth doing when polling becomes the perf bottleneck (it isn't today).

## 7. Open questions (need explicit decisions before J1 starts)

These block PR J1. I am NOT making the call unilaterally.

**Q1. Vite or Vanilla TS?** The user proposed `packages/control-center/` with Vite. Vite gives: real component structure, route-level state, dev HMR, easier UI testing. Cost: a build step (npm scripts), larger CLI tarball (bundled JS is bigger), an extra config surface. **Recommendation**: yes to Vite — vanilla JS is already 933+ lines and J2 doubles that. Alternative would be Lit/Svelte, but Vite-built vanilla TS is the lowest-risk move for a team that already writes vanilla JS.

**Q2. Allow/block list for tabs (US-3 deferred bit)** — should the dashboard enforce "agent may not touch tab X" at all? If so, the **daemon** needs an enforcement layer (the dashboard is purely UI). Recommend deferring to a real feature PR, not bolted into J2.

**Q3. Operator page surfacing** — should the Operator page exist as a top-nav entry, or only as a sub-page under Diagnostics? Current draft has it as top-nav-when-scope-≥-operator. Could also be a Diagnostics tab.

**Q4. Settings page LLM provider UX** — model catalog is a JSON file today. Settings UI could either be (a) a JSON-textarea with validation, or (b) a structured per-provider form. (a) ships in a day; (b) ships in a week. **Recommendation**: (a) for J3, (b) as a follow-up.

**Q5. Onboarding marker location** — `~/.turnkeyai/onboarding.json` or fold into `~/.turnkeyai/config.json`? The latter is simpler (no new file) but couples completion state to auth config. **Recommendation**: separate file (so `config.json` stays purely about auth + port).

**Q6. Token regeneration scope** — `admin` (matches "could lock out other holders") feels right, but it means a user with only `TURNKEYAI_DAEMON_OPERATOR_TOKEN` can never regenerate from the dashboard. Acceptable? **Recommendation**: yes — token rotation is a security operation and admin-gating it is appropriate.

**Q7. Recovery-run mutations** — confirmed deferred to a follow-up, but is "Show advanced recovery (read-only)" worth in J2 as a viewer, with no buttons? Or wait entirely?

**Q8. WebSocket events vs polling — bring forward?** The "visible-state guarantee" in US-3 is currently aspirational with 5s polling (gemini caught this). A fast agent can run several actions before the dashboard reflects the new session. WebSocket `/events` would close the gap. Cost: meaningful daemon work (new endpoint, event-bus plumbing, dashboard reconnect logic). **Recommendation**: keep deferred for J series — the daemon enforces the hard guarantee that no session can run unpersisted, so the 5s lag is a UX issue, not a security one. Promote WebSocket to J4 (post-Settings) if real users complain.

## 8. PR split

Assuming sign-off on this doc, the implementation breakdown is:

| PR  | Scope                                                                                                                       | Touches code in           | Touches user behavior |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------- |
| **J0** (this doc) | Product spec. Design alignment only.                                                                              | `docs/design/`            | None                  |
| **J1** | Move static app to `packages/control-center/` (Vite + TS). Daemon serves built assets. Visual behavior equivalent.       | `packages/control-center/`, daemon copy paths | None visible — same pages, same behavior |
| **J2** | Browser Workbench. Selected session/tab model. Spawn/attach/navigate/snapshot/screenshot/revoke. Failure → recovery cards. | `packages/control-center/`, +US-5 endpoints if any are missing | Mutations land |
| **J3** | Guided Agent Connect (preset cards), Settings (LLM providers, browser onboarding, regenerate token), First-Run wizard.      | `packages/control-center/`, new daemon endpoints from §6 | First-run flow visible; settings actions live |

J4+ (out of this arc):
- WebSocket events
- Allow/block enforcement layer
- Advanced recovery actions
- Electron wrapper

## 9. Exit criteria for J0

This doc is "done" when:

- [ ] The user (project owner) signs off on each of the 6 user stories
- [ ] Each open question in §7 has an explicit decision (✅ or ❌)
- [ ] The endpoint list in §6 is confirmed (or amended)
- [ ] The PR split in §8 is confirmed (or amended)

After sign-off, J1 starts. J0 stays in `docs/design/` as a living reference — when J2 ships, the deferred items become tasks; when a new feature lands, the spec gets a new section instead of a code surprise.
