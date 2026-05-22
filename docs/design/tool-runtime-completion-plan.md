# Tool Runtime Completion Plan

> Status: active implementation plan
> Updated: 2026-05-22

This plan closes the remaining gap between TurnkeyAI's native tool-use runtime and a production-grade user task runtime. The end state is not "tools exist"; it is that a user can ask a mission-level question, the lead can delegate to specialist sub-agents, browser work can execute safely through a controlled tool surface, the UI can replay the work in order, and release gates can prove the whole chain works.

## Current Baseline

Already complete on `main`:

- Provider-native tool schemas and tool-call parsing for supported LLM adapters.
- Role tool loop with durable assistant tool-call messages, `role=tool` results, and tool progress.
- Standard session, memory, permission, and task tools.
- `/message/cancel-tools` wired to active worker cancellation when a tool has registered work.
- Permission query/result/applied loop integrated with Mission approvals and activity events.
- Mission timeline expansion for tool calls, progress, tool results, and final answers.
- LLM sub-agent wrapper for browser and explore workers.
- Tool-use E2E mock path plus optional direct-CDP browser smoke path.

Remaining work is about production usefulness, continuity, and user comprehension.

## Completion Requirements

### 1. Browser Sub-Agent Tool Surface

The browser sub-agent must own a constrained browser toolset instead of one generic "run browser work" command.

Required private tools:

- `browser_open`
- `browser_snapshot`
- `browser_act`
- `browser_screenshot`
- `browser_console`
- `browser_scroll`

Runtime requirements:

- Tools compile to explicit `BrowserTaskAction[]`.
- The browser sub-agent reuses its live browser session across private tool calls.
- Browser results return session id, target id, transport, page summary, screenshot/artifact ids, and trace status.
- Browser prompt names capabilities, retry limits, artifact expectations, and failure reporting rules.
- The lead still sees only session-level delegation by default; browser primitives are private to the browser sub-agent.

Acceptance:

- A browser sub-agent can open a URL, snapshot, scroll, run a console probe, take a screenshot, and summarize the observed evidence in one private tool loop.
- Repeated browser private tool calls reuse the prior session/target unless the bridge reports a closed or missing session.

### 2. Durable Sub-Session Transcript

`sessions_history` must become a durable child transcript, not only a compact worker lifecycle summary.

Required:

- Per-session transcript records for user task, assistant tool-call turns, tool results, progress, and final result.
- Durable meta/index fields: agent id, parent session key, status, label, workspace/context refs, created time, last active time, message count.
- `sessions_send` appends a child user message and continues from the transcript.
- Restart does not erase child transcript continuity.

Acceptance:

- After daemon restart, `sessions_history(include_tools=true)` returns the child assistant/tool turns.
- A follow-up through `sessions_send` sees the prior child transcript, not only the compact last result.

### 3. Real LLM + Browser E2E Acceptance

Mock E2E proves protocol shape; release gating also needs a real-model flow.

Required:

- A scripted acceptance command that can run:
  - mock provider only
  - real configured LLM without browser
  - real configured LLM plus direct-CDP browser
- The browser path must verify: model emits `sessions_spawn(browser)`, browser sub-agent uses private browser tools, final answer cites observed browser evidence, Mission timeline/replay contains the chain.
- The command must be optional for normal local test runs and mandatory for release candidates.

Acceptance:

- A real LLM prompt can complete a browser-backed research task without manual UI probing.
- Failure output points to the broken layer: provider, tool schema, worker routing, browser transport, permission, replay, or final synthesis.

### 4. Browser Profile And Session Stability

Browser runtime failures must not be amplified into LLM retry loops.

Required:

- Detect Chrome profile lock conflicts and classify them as a stable browser runtime failure bucket.
- Prevent two managed browser launches from sharing an unsafe profile unless explicitly configured.
- Prefer attaching to the existing profile/session when appropriate; otherwise use isolated managed profiles.
- Expose profile/session conflict state in diagnostics and browser worker results.

Acceptance:

- Starting two browser-backed missions does not produce uncontrolled profile lock loops.
- A profile conflict returns a clear recoverable/unrecoverable status and suggested operator action.

### 5. Product Replay, Approval, And Session UX

The UI must make tool-heavy work readable.

Required:

- Mission Detail order: process/thought record first, final answer after the process for that turn.
- Long thought process is collapsed by default with one-click expand.
- Tool calls, progress, permission query/result/applied, tool results, and final answer are grouped per assistant turn.
- Sub-agent sessions are inspectable, continue-able, and cancellable from UI.
- Markdown rendering and layout must not overlap or invert answer/process order.

Acceptance:

- A completed browser-backed mission reads as: task -> tool process -> evidence -> final answer.
- A failed/cancelled/approval-denied flow is understandable without reading raw JSON.

## Checkpoint Order

1. Browser sub-agent tool surface and prompt/runtime contract.
2. Durable sub-session transcript and `sessions_history`/`sessions_send` continuation.
3. Real LLM + browser E2E acceptance command.
4. Browser profile/session stability hardening.
5. Mission replay/approval/session UX completion.

Each checkpoint should go through: focused implementation, tests, commit, PR, bot review, fixes, merge, then local deploy/acceptance before the next checkpoint.
