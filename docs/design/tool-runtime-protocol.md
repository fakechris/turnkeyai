# Tool Runtime Protocol

> Status: production protocol runbook
> Updated: 2026-05-30
> Scope: model-native tool calls, role loop messages, sub-agent sessions, approval gates, memory tools, mission replay, and acceptance gates

## Purpose

TurnkeyAI's task runtime is not prompt-only. A mission is allowed to finish only
when model-native tool calls, durable tool results, worker sessions, approvals,
memory, and final answer synthesis line up in the same replayable chain.

This document is the operator-facing protocol contract. Implementation details
live in `native-tool-use-runtime.md`; this runbook defines the shape that must
stay stable as the product evolves.

## Canonical Message Chain

The canonical successful chain is:

```text
user mission request
  -> assistant message with tool_calls and optional tool_progress
  -> role=tool result message for every tool_call_id
  -> assistant final answer
```

Rules:

- Tool calls are structured assistant message fields, not markdown commands.
- Tool progress stays attached to the assistant/tool turn and is replayed into
  Mission Detail.
- Tool results are real `role=tool` messages linked by `tool_call_id`.
- A final answer must come after the relevant tool result messages.
- Cancellation and timeout still produce durable tool-result state; they are not
  silent runtime exits.

## Tool Surface Layers

TurnkeyAI has two capability layers:

| Layer | Visible to | Purpose |
| --- | --- | --- |
| Lead role tools | lead role | Delegate work, continue sessions, read memory, create/update mission tasks, request governed actions. |
| Worker-private tools | sub-agent worker | Browser primitives, retrieval-specific actions, and future document/desktop tools that require specialist prompt and runtime guards. |

The lead role should normally see session-level tools, not browser primitives.
Browser control is an execution surface behind a browser sub-agent.

## Standard Lead Tools

| Tool | Required behavior |
| --- | --- |
| `sessions_spawn` | Starts an isolated sub-agent task with a durable session key and worker kind. |
| `sessions_send` | Continues an existing sub-agent transcript instead of respawning duplicated work. |
| `sessions_history` | Returns durable child transcript, including assistant/tool turns when requested. |
| `sessions_list` | Lists worker sessions with enough filtering to choose the right continuation target. |
| `memory_search` | Searches durable thread/session memory and admitted worker evidence. |
| `memory_get` | Fetches a specific memory hit returned by `memory_search`. |
| `tasks_list` / `tasks_create` / `tasks_update` | Makes mission work items visible as product state, not hidden prompt notes. |

The runtime must advertise only tools backed by executable handlers in the
current process. A missing worker handler must not appear as a callable
capability.

## Browser Sub-Agent Contract

The browser worker owns private browser tools:

- `browser_open`
- `browser_snapshot`
- `browser_act`
- `browser_scroll`
- `browser_console`
- `browser_screenshot`

Rules:

- The browser sub-agent reuses its session/target across private tool calls.
- Browser results include observed evidence, session id, target id, transport,
  trace status, and artifact references when available.
- Browser failures return structured error metadata: error code, retryability,
  user-safe message, session/target hints, and transport diagnostics.
- Browser prompt and runtime own retry behavior. The lead should synthesize from
  evidence, not micromanage CDP.
- Raw CDP and relay details remain Runtime/operator surfaces unless a mission
  explicitly requires advanced diagnostics.

## Approval Protocol

Side-effectful operations must pass through:

```text
permission.query
  -> operator decision
  -> permission.result
  -> permission.applied
  -> resumed tool call
```

Rules:

- Approval requests show mission, agent, action, affected context, policy hint,
  and exact approve/deny choices.
- Denial is a structured tool outcome. The role must continue from that state
  or produce a bounded final answer.
- Approval application is recorded so the same guarded action can resume without
  losing its original `tool_call_id`.

## Timeout And Cancellation

Timeout behavior is evidence-driven:

- A soft timeout should preserve partial worker evidence when available.
- The runtime may ask a worker to summarize from already completed tool results.
- Timed-out side effects are not blindly retried because the operation may have
  already executed.
- `/message/cancel-tools` must append cancelled tool-result messages for active
  tool calls and notify registered worker cancellation handlers.
- Mission replay derives cancellable work from tool-call events that have a
  `messageId` and `toolCallId` but no matching result event. It must not expose
  message-level cancellation for completed, skipped, or ambiguous-message
  process groups.

## Mission Replay Contract

Mission Detail must be able to reconstruct:

```text
user request
  -> work trace / tool process
  -> evidence and context
  -> final answer
```

Replay requirements:

- Tool calls, progress, approval events, tool results, recovery events, and final
  answer appear in chronological order.
- Long traces are collapsed by default but expand in place.
- Final answer renders markdown and appears after the process it depends on.
- Mission metrics expose wall-clock, tool requested/result/executed/skipped,
  timeout/cancel/failure counts, spawned/continued sessions, evidence count, and
  quality gate status.
- Weak final answers become `needs_attention` when quality checks identify low
  substance, missing evidence usage, unresolved placeholders, missing residual
  risk, or missing evidence.

## Acceptance Gates

Use the narrowest gate that covers the changed layer:

| Change area | Minimum gate |
| --- | --- |
| Tool protocol, provider adapter, role loop | `npm run tooluse:e2e` |
| Real provider schema or prompt harness | `npm run tooluse:e2e:real-matrix -- --model-catalog models.local.json` |
| Browser worker, browser prompt, direct-CDP, approval/browser boundary | `npm run tooluse:e2e:real-matrix -- --with-browser --model-catalog models.local.json --cdp-timeout-ms 45000` |
| Mission route, Control Center replay, final-answer quality | `npm run mission:e2e:matrix -- --model-catalog models.local.json --scenario-timeout-ms 240000` |
| Release candidate | `npm run acceptance:real -- --model-catalog models.local.json --scenario-timeout-ms 240000 --cdp-timeout-ms 45000` |

Normal PRs still run:

```bash
npm test -- --runInBand
npm run typecheck
npm run build
git diff --check
```

Real LLM/browser gates are not required for every UI-only text change, but they
are required before claiming runtime, browser, mission completion, or release
readiness changes are production-grade.
