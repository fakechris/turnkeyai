# TurnkeyAI Mission Control Product Design

> Status: proposed product direction, PR K0
> Updated: 2026-06-08
> Scope: user story, use case, information architecture, and base UE design for the user-facing TurnkeyAI workbench

## 1. Product Decision

TurnkeyAI should not be positioned as a browser-control dashboard.

Browser control is an execution surface. It is not the reason a user chooses the product. The product-level promise is:

> TurnkeyAI coordinates multiple local agents to complete a mission. Agents can use browser, documents, desktop context, local files, APIs, and specialist workers when those tools are the right way to finish the task.

The current Control Center is a useful runtime view, but its mental model is still too low-level:

- Setup
- Bridge
- Tabs
- Setup
- Diagnostics

That layout explains the runtime. It does not explain the user's work.

The next product shape should be **Mission Control**: a local-first multi-agent workbench where the user creates a goal, sees how agents divide and execute the work, approves risky actions, inspects evidence, and receives a traceable artifact.

## 2. Product Narrative

The user should feel like they are managing a small local agent team, not operating a browser bridge.

Example mission:

> Research five competitors, verify claims through live websites, track source evidence, update the comparison document, flag uncertain facts, and produce a final report.

That mission naturally needs several capabilities:

- A coordinator that plans and assigns work.
- A research agent that uses search and browser sessions.
- A browser agent that opens pages, extracts snapshots, screenshots, and evidence.
- A document agent that watches and edits a report or workspace document.
- A reviewer agent that checks consistency, missing citations, and unresolved decisions.
- A policy layer that asks the user before sensitive browser, document, desktop, or file actions.

The browser bridge remains critical, but it is a tool inside a larger mission graph.

## 3. Personas

### P1. Task Owner

The primary user. They do not want to manage transports, tabs, CDP, or daemon lifecycle unless something is blocked.

They want to:

- Give TurnkeyAI a goal.
- See who is working on what.
- Approve or deny risky steps.
- Inspect evidence when they care.
- Receive a final artifact they can trust.

Success means the user can answer: "Is my task moving? What is blocked? What did the agents rely on? What changed?"

### P2. Power Operator

Runs longer or higher-risk missions and needs observability without dropping into source code.

They want to:

- See active agents, tool calls, browser targets, document watchers, and recovery state.
- Understand why a mission stalled.
- Revoke a session, reattach a browser target, or export diagnostics.
- Keep runtime details available but secondary to mission progress.

### P3. Agent Integrator

Connects external agent clients such as Codex, Claude Code, Kimi, or custom OpenAPI clients. Chromium-family
browsers such as Chrome, Comet, Edge, and Chromium are browser transport targets that host the relay extension.

They want to:

- Get endpoint and token configuration quickly.
- Understand the capability surface exposed to the agent.
- Test connection and scope.
- Avoid accidentally granting admin-level powers.

### P4. Runtime Developer

Still important, but not the default product lens. They use diagnostics, replay, and lower-level runtime pages.

### P5. First-Time User

They are not integrating anything yet. They need one clear answer: "Can I start a mission now?"

They should see:

- Start in this app as the recommended path.
- Add another AI app only as an optional branch.
- Add browser access only when a task needs logged-in pages, screenshots, or evidence.

## 4. Core Product Objects

The UI should be organized around these nouns.

| Object | Meaning | User-visible purpose |
| --- | --- | --- |
| Mission | A user goal with lifecycle, agents, work items, approvals, artifacts, and evidence. | The primary unit of work. |
| Agent | A participant with role, status, permissions, and current assignment. | Shows who is doing the work. |
| Work Item | A planned or active subtask assigned to an agent. | Makes decomposition visible. |
| Context Source | Browser, document, desktop, local folder, API, or external app context. | Shows what the agents can see or use. |
| Tool Surface | The callable capability behind a context source: browser bridge, document watcher/editor, desktop controller, file reader, API client. | Explains how work is executed. |
| Activity Event | Timeline item for agent thought boundary, tool call, approval, artifact, recovery, or user action. | Gives traceability. |
| Artifact | Report, screenshot, source snapshot, exported bundle, edited document, table, or structured result. | Shows output and supporting evidence. |
| Approval Request | A human decision required before a sensitive or non-idempotent action. | Keeps user in control. |
| Policy | Rules about which agents can use which tools and when approval is needed. | Converts trust into product behavior. |
| Recovery Case | A blocked or failed runtime condition with bucket, owner, and next action. | Makes failure actionable. |

## 5. Top-Level Information Architecture

The product should move from a daemon dashboard to a workbench.

### Final Navigation

| Route | Page | Purpose |
| --- | --- | --- |
| `#/missions` | Missions | Home screen. Create, resume, monitor, and search missions. |
| `#/missions/:id` | Mission Detail | Main workspace for one goal: agents, work items, timeline, context, artifacts, approvals. |
| `#/agents` | Agents | Agent roster, capabilities, active assignments, connection health. |
| `#/context` | Context Sources | Browser, docs, desktop, files, APIs, and connected apps. |
| `#/approvals` | Approvals | Pending user decisions across missions. |
| `#/agent-connect` | Setup | Start here, connect another AI app, or add browser access when needed. |
| `#/runtime` | Diagnostics | Bridge, transport, sessions, diagnostics, logs, replay links. |
| `#/settings` | Models | Model routes, policies, identity, and local data paths. |

The current pages fold in as follows:

| Current page | New home |
| --- | --- |
| Setup | First-run onboarding + Setup + Models |
| Bridge | Setup + Diagnostics + Context evidence |
| Tabs | Mission Detail / Browser context panel |
| External agent setup | Setup |
| Diagnostics | Diagnostics |

## 6. Primary User Stories

### US-1. Create A Mission

**Goal**: The user gives TurnkeyAI a real objective instead of opening a tool dashboard.

**Entry**: `#/missions` primary action: "New mission".

**Flow**:

1. User enters a goal in plain language.
2. User optionally attaches context: browser tab, document, folder, screenshot, or notes.
3. User chooses a mode:
   - "Research and summarize"
   - "Monitor and update"
   - "Operate browser"
   - "Review and verify"
   - "Custom"
4. TurnkeyAI creates a mission draft with proposed agents, work items, and required permissions.
5. User starts the mission or edits the plan.

**Acceptance**:

- A mission has an ID, title, status, owner, created time, participating agents, work items, timeline, and artifact list.
- The first screen after creation is Mission Detail, not a diagnostics page.
- If no external agent is connected, the mission can still run in this app. The UI routes to Setup only when the user chooses another AI app or browser access.

### US-2. Watch A Multi-Agent Mission Run

**Goal**: The user can tell whether the task is moving and who is doing what.

**Entry**: Mission Detail.

**Flow**:

1. Coordinator creates or updates the work plan.
2. Agents take assignments.
3. Tool calls appear as timeline events.
4. Artifacts and evidence attach to the relevant work item.
5. Mission status updates from `planning` to `working`, `needs_approval`, `blocked`, or `done`.

**Acceptance**:

- The mission timeline answers: "what happened, by whom, using which context source, with what result?"
- Agent status is visible without opening logs.
- Browser actions are shown as browser tool events, not as the primary page model.
- The user can filter timeline by agent, context source, approval, artifact, or failure.

### US-3. Approve Risky Actions

**Goal**: The user keeps control of sensitive actions while allowing agents to continue autonomously on safe work.

**Entry**: Approval banner on Mission Detail, global `#/approvals`.

**Approval examples**:

- Submit a web form.
- Download or upload a file.
- Modify a document.
- Send a message or email.
- Access a sensitive site.
- Run raw CDP expert command.
- Control desktop UI outside the browser.
- Retry a command that might have already executed.

**Acceptance**:

- Every approval shows mission, agent, requested action, affected context, risk reason, and exact options.
- Approve/deny decisions become timeline events.
- Denying an action returns control to the coordinator with a structured reason.
- Dangerous actions cannot be hidden behind generic "continue" buttons.

### US-4. Use Browser Only When Needed

**Goal**: Browser automation is available as a powerful tool, but not the product's main mental model.

**Entry**: Mission Detail right panel, Context Sources / Browser, Runtime.

**Flow**:

1. Agent decides browser is needed.
2. Browser context source opens or reuses a session.
3. Timeline shows navigation, snapshot, click, screenshot, popup, and extraction events.
4. Evidence is attached to work items.
5. Failures surface as mission recovery cases.

**Acceptance**:

- The user sees browser activity inside the mission timeline.
- The browser panel exposes selected tab, URL, screenshot/snapshot, active agent, and last action.
- Raw CDP remains advanced/runtime-only. Mission-level UI describes outcomes and approvals, not CDP internals.

### US-5. Watch Documents And Workspace State

**Goal**: TurnkeyAI can work around documents and local workspace state, not only web pages.

**Entry**: Context Sources / Documents or mission context attachment.

**Flow**:

1. User attaches a document, folder, or workspace target.
2. A document watcher tracks changes, comments, and generated artifacts.
3. A document agent proposes edits or writes into a draft.
4. Reviewer agent checks consistency and citations.

**Acceptance**:

- Document/source context appears next to browser context as a first-class source.
- Edits require approval unless policy says the agent can write.
- Final artifacts link back to source events and evidence.

### US-6. Recover A Blocked Mission

**Goal**: The user sees the blocked state as a product-level recovery path, not a transport stack trace.

**Entry**: Mission Detail status banner, `#/runtime` for deeper inspection.

**Flow**:

1. A tool or agent fails.
2. The failure becomes a Recovery Case attached to mission and work item.
3. UI shows bucket, affected agent, affected context, user-safe explanation, and next action.
4. Safe recovery may auto-run. Risky recovery asks for approval.

**Acceptance**:

- Recovery language is mission-level: "Browser session detached while Research Agent was extracting pricing evidence."
- Runtime bucket is still visible for operators.
- Timeout retries are user/caller-driven when action might have executed.
- The user can export a diagnostics bundle from the recovery case.

### US-7. Set Up A Use Path

**Goal**: The user can start work without learning daemon routes. External AI apps and browser access are optional.

**Entry**: Setup.

**Information architecture**:

- Recommended: Use this app. Primary action is starting a mission.
- Optional AI app branch: Codex CLI, Claude Code, Kimi, and custom OpenAPI clients. They call `/bridge/command`.
- Optional browser branch: Chrome, Comet, Edge, and Chromium. They host the relay extension and register tabs back to the daemon.
- Diagnostic contract: live workers, native tools, connectors, APIs, and transport order stay behind disclosure unless the user asks for status.

These dimensions are not peers. Browser targets must not be rendered as agent presets.

**Flow**:

1. User lands on "Use this app" and can start a mission immediately.
2. If they pick another AI app, UI shows endpoint and token only.
3. If they pick browser access, UI shows install/load/start steps only.
4. Advanced details are available but not part of the default explanation.

**Acceptance**:

- Read tokens cannot expose mutation snippets.
- Admin tokens warn the user to prefer operator scope for day-to-day agents.
- The first viewport never lists internal runtime nouns such as capability contract, transport order, or bridge topology.
- The configured agent can be assigned to a mission.

## 7. Mission Detail UE Design

Mission Detail is the core screen. It should be dense and operational, not a marketing dashboard.

### Desktop Layout

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ TurnkeyAI Mission Control        Ready / Working / Needs Approval / Blocked │
├───────────────┬───────────────────────────────────────┬──────────────────────┤
│ Work Plan     │ Activity Timeline                     │ Context + Control    │
│               │                                       │                      │
│ ▸ Plan        │ 09:31 Coordinator planned 4 steps     │ Selected context     │
│ ▸ Research    │ 09:32 Research Agent opened browser   │ Browser              │
│ ▸ Verify      │ 09:33 Browser snapshot captured       │ example.com/pricing  │
│ ▸ Draft       │ 09:34 Doc Agent updated draft         │                      │
│ ▸ Review      │ 09:35 Approval requested              │ Actions              │
│               │                                       │ Snapshot             │
│ Agents        │ Evidence / artifact previews inline   │ Screenshot           │
│ Researcher    │                                       │ Revoke session       │
│ Browser Op    │                                       │                      │
│ Doc Watcher   │                                       │ Approvals            │
│ Reviewer      │                                       │ 1 pending            │
└───────────────┴───────────────────────────────────────┴──────────────────────┘
```

### Regions

**Left: Work Plan**

- Mission title and status.
- Work item tree.
- Agent roster for this mission.
- Blocked items surfaced at top.

**Center: Activity Timeline**

- The user's main truth surface.
- Every event has actor, action, target, result, timestamp, and optional artifact.
- Events collapse by default when noisy, but failures and approvals stay expanded.

**Right: Context + Control**

- Shows selected context source: browser tab, document, desktop, file, API.
- Exposes safe actions relevant to that source.
- Higher-risk actions route through approval.
- Runtime details are one click away, not always in the user's face.

### Mobile / Narrow Layout

Use tabs rather than squeezing three columns:

- Plan
- Activity
- Context
- Approvals

Approvals should be reachable from every tab through a sticky banner when pending.

## 8. Visual And Interaction Principles

### Visual Direction

TurnkeyAI is a local operations workbench. It should feel:

- Calm
- Dense
- Precise
- Trustworthy
- Built for repeated use

Avoid:

- Marketing hero pages inside the product.
- Decorative gradients as the primary identity.
- Browser-tab-first layouts.
- Cards inside cards.
- Oversized headings in compact runtime views.

### State Language

Use consistent mission-level states:

| State | Meaning | UI treatment |
| --- | --- | --- |
| `draft` | Mission created but not running. | Neutral. |
| `planning` | Coordinator is decomposing work. | Informational. |
| `working` | Agents are actively executing. | Active status. |
| `needs_approval` | User decision required. | Prominent amber banner. |
| `blocked` | Mission cannot proceed without recovery or user action. | Red status with next action. |
| `done` | Final artifact ready. | Success with artifact CTA. |
| `archived` | Mission no longer active. | Muted. |

Tool-level states remain visible only when helpful:

- browser session attached/detached
- direct CDP available/unavailable
- document watcher connected/disconnected
- desktop control available/unavailable

### Interaction Rules

- Every screen has one primary user action.
- Approval requests never hide risk behind vague copy.
- Destructive actions require confirmation and show affected mission/context.
- Tool failures show a next action, not just a log string.
- Read-only tokens should remove mutation controls rather than allowing avoidable 401s.
- A user should be able to understand mission progress without opening Runtime.

## 9. Basic Capability Requirements

### Already close to available

| Capability | Current basis |
| --- | --- |
| Daemon local app entry | `turnkeyai app` |
| External agent bridge | `/bridge/status`, `/bridge/command`, `/bridge/advanced`, `/bridge/expert`, `/bridge/batch` |
| Browser sessions | Browser runtime + relay/direct-CDP/local transports |
| Diagnostics bundle | Control Center Diagnostics |
| Runtime/operator cases | replay/recovery/operator surfaces |
| Token scopes | read/operator/relay-peer/admin |

### Needed for Mission Control

| Capability | Why it matters |
| --- | --- |
| Mission store | Product needs a durable goal-level object. |
| Work item store | Multi-agent decomposition must be visible and resumable. |
| Activity event stream | Timeline is the primary UX truth surface. |
| Artifact registry | Evidence and final outputs need stable references. |
| Approval queue | Human-in-the-loop needs first-class state. |
| Context source registry | Browser, docs, desktop, files, APIs need one product model. |
| Agent roster | Users need to see active agents and capabilities. |
| Policy config | Approval rules and tool permissions should not be hardcoded. |
| Event delivery | Polling can start; WebSocket/SSE becomes important once missions are live. |

### Capability boundaries

Do not expose raw tool power as the default UX:

- Raw CDP is an expert capability.
- Desktop control should be opt-in and heavily approval-gated.
- Document writes should require policy or explicit approval.
- Agent-generated plans should be editable before execution for high-risk missions.

## 10. Product Use Cases

### UC-1. Competitive Research Report

User asks TurnkeyAI to research competitors and produce a report.

Agents:

- Coordinator
- Research Agent
- Browser Agent
- Document Agent
- Reviewer

Context:

- Browser
- Source snapshots
- Draft document

Output:

- Report artifact with citations, screenshots, source URLs, and unresolved assumptions.

### UC-2. Monitor A Vendor Portal

User asks TurnkeyAI to watch a portal and update a local tracker when status changes.

Agents:

- Monitor Agent
- Browser Agent
- Reviewer

Context:

- Authenticated browser session
- Local table or document

Output:

- Timeline of observed changes.
- Updated tracker.
- Approval request before submitting forms or downloading files.

### UC-3. Document Review And Update

User attaches a project doc and asks TurnkeyAI to keep it aligned with current repo/runtime status.

Agents:

- Document Watcher
- Code/Repo Agent
- Reviewer

Context:

- Local repo
- Design docs
- Existing artifact history

Output:

- Proposed edits.
- Change summary.
- Evidence links to files and commits.

### UC-4. Browser-Heavy Workflow

User asks TurnkeyAI to operate a browser workflow that has iframes, popups, shadow DOM, or fragile controls.

Agents:

- Browser Operator
- Recovery Agent
- Reviewer

Context:

- Browser transport
- Raw-CDP expert lane when direct-CDP is available

Output:

- Completed browser task or actionable recovery case.
- Screenshots and snapshots tied to each risky step.

### UC-5. Multi-Agent Investigation

User asks a broad question that needs parallel exploration.

Agents:

- Coordinator
- Multiple Research Agents
- Browser Agent
- Synthesis Agent
- Reviewer

Context:

- Browser
- Web sources
- Local notes
- Final document

Output:

- Merged answer.
- Conflict list.
- Evidence table.
- Open questions.

## 11. Implementation Direction

### K1. Mission Shell

Goal: make the UI tell the right story before adding risky mutations.

- Rename product surface from Control Center to Mission Control.
- Add routes: Missions, Mission Detail, Agents, Context, Approvals, Setup, Diagnostics, Models.
- Move existing Bridge/Tabs/Diagnostics content under Diagnostics or Context.
- Use mocked mission data where backend objects do not exist yet.

### K2. Mission Data Model

Goal: introduce mission-native state.

- Add Mission, WorkItem, ActivityEvent, Artifact, ApprovalRequest types.
- Back them with local daemon storage.
- Expose read endpoints first.
- Keep old runtime endpoints stable.

### K3. Browser As Context Source

Goal: fold current bridge/browser UI into mission execution.

- Show browser sessions in Mission Detail context panel.
- Attach browser tool events to mission timeline.
- Convert raw browser failures into recovery cases attached to work items.

### K4. Approval Queue

Goal: make human-in-the-loop product behavior explicit.

- Add approval request store and routes.
- Route risky browser/document/desktop actions through approvals.
- Add global Approvals page.

### K5. Document And Desktop Context Design

Goal: broaden the product beyond browser.

- Define document watcher contract.
- Define desktop context/controller contract.
- Start read-only first, then approval-gated writes/actions.

### K6. Desktop Shell

Goal: move from local web app to a friendlier product entry.

- Keep daemon-served web as development base.
- Add Tauri or Electron shell when mission model is stable.
- Shell responsibilities: local daemon lifecycle, tray status, notifications, deep links, file/document permissions.

## 12. Non-Goals For The Next Arc

- Do not build a generic desktop remote-control app.
- Do not expose raw CDP as a normal user workflow.
- Do not make the UI only a prettier diagnostics dashboard.
- Do not block the Mission UI on full durable execution kernel work.
- Do not require every external agent integration to be perfect before the mission model exists.

## 13. Product Bar

The next user-visible milestone is not "can I see browser tabs?"

The bar is:

1. A user can create a mission.
2. Multiple agents can be represented as participants in that mission.
3. Browser/document/desktop/file context appears as tools used by agents, not top-level product identity.
4. The user can see progress, evidence, approvals, failures, and final artifacts in one mission workspace.
5. Diagnostics remain available for operators without dominating the main experience.

If the next UI arc does not move toward those five points, it is probably still too conservative.
