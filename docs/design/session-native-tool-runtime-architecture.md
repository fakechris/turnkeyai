# Session-Native Tool Runtime Architecture

> Status: active migration target
> Updated: 2026-05-27
> Scope: native tool use, sub-agent sessions, durable child transcript, timeout summary, cancellation, permission, and mission replay

## 1. Product Requirement

The runtime must be reliable enough for user-facing mission work. Browser control,
public research, memory lookup, and task operations are implementation tools, not
the product itself. The product contract is:

```text
user mission
  -> lead plans/delegates
  -> specialist sub-sessions execute with bounded tools
  -> canonical role=tool result returns
  -> lead synthesizes only verified evidence
  -> UI replays process then final answer
```

If a task cannot finish, the system must preserve the partial transcript and
offer a clear continuation path instead of producing low-value filler.

## 2. Non-Negotiable Runtime Shape

The core execution chain is message-native and session-native:

```text
assistant(tool_calls + tool_progress)
  -> role=tool(sessions_spawn / sessions_send canonical result)
  -> assistant(final answer)
```

Rules:

- A sub-agent is a real session with a stable `session_key`, parent linkage,
  status, message count, transcript, and last result.
- `sessions_spawn` creates a child session and returns a canonical tool result.
- `sessions_send` appends a user follow-up to the existing child session and
  returns the same canonical result shape.
- `sessions_history` reads the child transcript, not a lossy operational
  summary.
- Tool progress is attached to the assistant tool-call turn and replayed above
  the final answer.
- Timeout is not a generic failure. It is a resumable state with either verified
  evidence or an explicit no-evidence result.
- The lead does not directly operate browser primitives. Browser primitives are
  private to the browser sub-agent.

## 3. Canonical Session Tool Result

All session tools must serialize through one contract:

```ts
type SessionToolResult = {
  protocol: "turnkeyai.session_tool_result.v1";
  task_id: string;
  session_key: string;
  agent_id: WorkerKind;
  status: "completed" | "partial" | "failed" | "timeout" | "cancelled";
  cached?: boolean;
  resumable?: boolean;
  timeout_seconds?: number;
  evidence_available?: boolean;
  evidence_summary?: string;
  tool_chain: WorkerKind[];
  result: string;
  final_content: string | null;
  payload: unknown;
};
```

`final_content` is the canonical source for lead synthesis when present. A short
verified answer is valid. Length must never be used as a correctness test.

`evidence_available=true` is allowed only when the child session has verified
continuation/result/history evidence. Transport errors, provider failures, and
other `lastError` diagnostics are not evidence.

## 4. Timeout Policy

Timeout behavior must preserve work instead of hiding it:

1. Soft timeout fires at the session tool timeout.
2. Runtime interrupts the worker and waits a hard-grace window for the current
   tool result or interruption summary.
3. If the worker finishes inside the grace window, return normal completed or
   partial result.
4. If it does not, return `status=timeout`, `resumable=true`, and evidence
   fields derived only from actual session evidence.
5. Lead final synthesis must not spawn fallback sessions after a timeout. It
   either summarizes available evidence or tells the user verification did not
   complete and can be continued.

This policy is different from reducing global tool rounds. Tool rounds guard
planner loops; timeout policy guards running work.

## 5. Delegation And Loop Control

Lead agent:

- delegates independent work to sub-sessions
- keeps delegated task prompts self-contained
- reads canonical tool results first
- uses `sessions_history` only when the canonical result is insufficient
- synthesizes from verified child evidence

Sub-agent:

- owns its delegated task
- uses only its private tool surface
- stops when evidence is sufficient
- returns uncertainty explicitly
- does not recursively spawn sub-sessions

Runtime limits:

- max nesting depth: 2
- per-parent concurrent child sessions: 5
- global active child sessions: 12
- worker-kind-specific timeout defaults
- repeated same browser operation retry cap: 3

These limits are product-level budget controls, not substitutes for evidence
quality.

## 6. UI Replay Contract

Mission Detail must render each turn in this order:

```text
user request
collapsed tool process / thought record
final answer
```

The process panel groups:

- assistant tool calls
- tool progress
- permission query/result/applied events
- role=tool results
- child session links and status

The final answer must never appear before the process that produced it.

## 7. Migration Sequence

### M1. Canonical Session Tool Result

- Create a typed session-tool-result serializer/parser.
- Make `sessions_spawn`, `sessions_send`, cached result, timeout, and cancelled
  paths use it.
- Make lead synthesis inspect the parsed contract instead of ad hoc JSON.
- Add tests for completed, short final, timeout/no-evidence, cancelled, and
  mixed completed+timeout rounds.

### M2. Transcript-First Sub-Session Store

- Split child transcript entries from worker lifecycle summaries.
- Keep lifecycle state for operations, but make `sessions_history` read the
  transcript path first.
- Ensure restart does not lose assistant/tool turns.

### M3. Soft Timeout Summary Discipline

- Add a no-tools evidence-only summary pass for sub-agents on soft timeout.
- Preserve current tool result if it returns during the grace window.
- Return resumable timeout only after hard grace expires.

### M4. Lead/Sub-Agent Harness Contract

- Generate prompt-visible tool rules from the same registry that generates tool
  schemas and UI capability display.
- Enforce no recursive spawn at executor level for child agents.
- Add deterministic acceptance prompts for delegation, browser, public research,
  timeout, and continuation.

### M5. Product Replay Completion

- Group process-before-answer per assistant turn.
- Add child session continuation/cancel controls to each process group.
- Require real LLM acceptance before release-candidate merges.

## 8. Acceptance Gates

Every runtime PR in this track must answer:

1. Does the change move a runtime behavior into a typed protocol or keep it as
   scattered string/JSON handling?
2. Can a completed child result be synthesized without calling extra tools?
3. Can a timeout return evidence only when actual evidence exists?
4. Can the UI reconstruct the chain from message-native fields?
5. Can a real LLM E2E prove the behavior, even if it is not run on every commit?

If the answer to 1 is "scattered handling", the PR is not architectural progress.
