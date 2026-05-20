# Native Tool-Use Runtime

> Status: implementation foundation
> Updated: 2026-05-18
> Scope: provider-neutral tool calling, role loop execution, sessions_* tools, and production parity targets

## 1. Why This Exists

TurnkeyAI already had worker runtime, browser bridge, mission timeline, and recovery visibility. The missing layer was **LLM-native tool use**:

- Models could not receive provider-native `tools` schemas.
- Anthropic `tool_use` blocks and OpenAI `tool_calls` were not parsed into runtime objects.
- Role execution was one-shot text generation, not a loop of `assistant(tool_call) -> tool_result -> assistant`.
- Browser bridge actions could be called over HTTP, but the lead role could not choose them through a tool protocol.

This document defines the runtime layer that closes that gap.

## 2. Reference Chain

TurnkeyAI's native tool-use chain is:

```text
assistant(tool_calls + tool_progress)
  -> tool(sessions_spawn / sessions_send summary)
  -> assistant(final answer)
```

Important properties to preserve or exceed:

- Tool calls are first-class message data, not plain text conventions.
- Tool progress is stored on the running assistant message.
- Tool results are linked by `tool_call_id`.
- Browser work is not a hidden RPC from the main agent; it runs as a browser sub-session.
- Sub-sessions support spawn, send/follow-up, history, and list.
- Browser relay/CDP is below the browser worker, not the main product abstraction.

## 3. TurnkeyAI Protocol

TurnkeyAI uses provider-neutral types at the LLM gateway boundary:

- `LLMToolDefinition`
- `LLMToolChoice`
- `LLMToolCall`
- `LLMContentBlock`
- `LLMToolUseBlock`
- `LLMToolResultBlock`

Provider mapping:

| Runtime concept | Anthropic-compatible | OpenAI-compatible |
| --- | --- | --- |
| Tool schema | `tools[].input_schema` | `tools[].function.parameters` |
| Tool choice | `tool_choice` object | `tool_choice` string/object |
| Assistant call | content block `{type:"tool_use"}` | assistant `tool_calls[]` |
| Tool result | user content block `{type:"tool_result"}` | `role:"tool"` message |
| Final answer | text blocks | assistant content |

The protocol intentionally does not expose provider-specific shapes above the adapter layer.

## 4. Role Tool Loop

The role generator now supports a bounded tool loop:

```text
messages = system + user
loop up to maxRounds:
  result = llm.generate(messages, tools)
  if no toolCalls: return final text
  append assistant tool-use message
  execute tool calls, in parallel
  append linked tool-result messages
```

Runtime safeguards:

- Default max rounds: 8.
- Tool schemas are included in request-envelope diagnostics.
- Tool result counts and bytes are included in envelope diagnostics.
- Tool progress is recorded as runtime progress events.
- Tool executor failures become tool result messages with `isError=true`; they do not crash the loop unless the loop itself is misconfigured.
- Request-envelope overflow reduction still works inside the tool loop.

## 5. Standard Session Tools

The first built-in tool set is the `sessions_*` surface:

| Tool | Purpose |
| --- | --- |
| `sessions_spawn` | Spawn a sub-agent session for an isolated task. |
| `sessions_send` | Send a follow-up to an existing sub-agent session. |
| `sessions_list` | List local sub-agent sessions. |
| `sessions_history` | Read compact session history/state. |

Supported worker kinds are runtime-derived, not hard-coded. The daemon must
only advertise worker kinds that are backed by executable handlers in the
current process. A lead role must not see `sessions_spawn(agent_id: "...")`
for a worker that the local `WorkerRegistry` cannot actually spawn.

Current production wiring usually exposes:

- `browser`
- `explore`
- `finance`

`coder` and `harness` remain valid `WorkerKind` values, but they are not
included in native tool schemas until an executable handler is installed.

## 6. Browser Policy

The main role should not call browser primitives directly by default.

Correct path:

```text
lead role
  -> sessions_spawn({agent_id:"browser", task})
  -> browser worker
  -> browser bridge / relay / direct-CDP
  -> worker result
  -> lead final answer
```

This preserves:

- sub-session isolation
- browser-specific prompt and recovery behavior
- session continuity
- mission timeline and context-source wiring
- future approval gating at the tool boundary

Direct browser tools can still exist later for specialist browser agents:

- `browser.open`
- `browser.snapshot`
- `browser.act`
- `browser.screenshot`
- `browser.console`

They should be exposed to the browser sub-agent, not the lead role by default.

When a browser sub-session receives a bounded search/research task without an
explicit URL, the browser task planner may open a configured search-engine URL
as the first browser action. The default template is intentionally replaceable
so deployments can use a region- or organization-approved search provider.

## 7. Parity Bar

TurnkeyAI's baseline bar is:

1. Provider-native tool call support for Anthropic-compatible and OpenAI-compatible clients.
2. Message-native tool calls/results/progress in role execution.
3. Standard `sessions_*` tools for sub-agent orchestration.
4. Browser work routed through browser sub-sessions.
5. Bounded loop, request-envelope accounting, and runtime progress recording.
6. Follow-up via `sessions_send`, not only fresh spawn.
7. Session list/history inspection from the same tool surface.

## 8. Next Required Work

This foundation is not the final product surface. The next implementation steps are:

- Persist tool call / tool result messages into the team message log, not only role metadata.
- Add UI rendering for tool progress in Mission Detail.
- Add approval gating before side-effectful tools execute.
- Add first-class browser-agent tool definitions for browser sub-sessions.
- Add durable per-sub-session message history, beyond the current worker-state summary.
- Add cancellation support for in-flight tool batches.

The key architectural decision is fixed: TurnkeyAI's core tool-use path is now model-native and session-native, not prompt-only and not browser-bridge-only.
