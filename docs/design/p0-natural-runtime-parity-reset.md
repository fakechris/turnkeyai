# P0 Natural Runtime Parity Reset

Updated: 2026-05-31

This reset changes the priority order for the agent workbench goal. Browser
control, diagnostics, and UI polish remain important, but they are not allowed
to outrank the core question: can a real user give a natural complex prompt and
receive a stable, evidence-backed result?

## Evidence Rule

Progress must be classified before it is claimed.

| Class | Meaning | Can claim capability improvement? |
| --- | --- | --- |
| Structural | Code paths, schemas, docs, or deterministic tests exist. | No. |
| Visibility | Runtime truth is easier to inspect in UI, diagnostics, or reports. | No. |
| Capability | A natural real LLM E2E produced a useful terminal result with evidence. | Yes. |
| Unknown | Evidence is missing, indirect, stale, or only fixture-shaped. | No. |

Contract E2E remains valuable, but it proves protocol shape only. Natural E2E
must use user-like prompts and must not contain fixed markers, exact final
answer templates, or instructions that force a specific tool call.

Do not treat "one natural E2E failed, add a narrow case, run again" as a
methodology. First classify the failure as a runtime state, prompt harness,
tool protocol, continuation, timeout, browser reliability, approval, memory, or
UI replay problem. Implementation resumes only after the expected state
transition and acceptance evidence are clear.

## Current Core Status

| Area | Status | Reset finding | Required P0 proof |
| --- | --- | --- | --- |
| Native tool loop | Partial | Provider-native tools, 128 default rounds, wall-clock closeout, and final synthesis exist. This is structural unless a natural run finishes cleanly. | Natural long delegation and comparison runs finish with no stuck liveness and no forced degraded closeout. |
| Assistant tool calls, progress, and tool result messages | Partial | Tool messages and progress are persisted, but this must be treated as a live protocol only when a long-running run shows ordered progress before completion and replay preserves it. | Natural browser or long delegation run records call, progress, result, and final answer in order. |
| Durable sub-session transcript | Partial | Child transcript entries exist for session history and continuation. Restart/resume and natural follow-up still need direct proof. | Natural follow-up reuses an existing session after restart or cold continuation and avoids duplicate spawn. |
| Session tools | Partial | `sessions_spawn`, `sessions_send`, `sessions_list`, and `sessions_history` exist with useful filters and ownership checks. | Natural follow-up and long delegation use them reasonably without lead doing child work directly. |
| Permission loop | Partial | Browser side-effect gating can emit query/result/applied and wait for a decision. Denial, wait timeout, and continuation behavior need stronger proof. | Natural approval dry-run proves no side effect before approval and a denied action produces a useful final result. |
| Browser sub-agent private tools | Partial | Browser primitives are private to the browser sub-agent and reuse session/target state. Complex real pages and profile conflicts remain unproven. | Natural browser dynamic page and dashboard runs collect rendered evidence without profile-lock loops. |
| Prompt harness | Partial | Tool, session, memory, permission, and task guidance is registry-driven, but the harness still needs product-level proof that the model delegates instead of doing child work itself. | Natural long delegation shows independent sub-agent work and a parent synthesis with source coverage. |
| Iteration, timeout, and continuation behavior | Partial | High iteration budget, sub-agent timeouts, soft summary, and hard grace exist. User-facing pause/continue semantics are not fully proven. | Timeout closeout produces evidence-only output and follow-up can continue the same session. |
| Memory search/get/flush | Partial | Native memory lookup and pre-compaction flush exist. Tool-write invalidation and pressure-test recall are not complete. | Natural memory recall after context pressure retrieves the correct item and avoids stale unsupported claims. |
| Tool-result pruning | Partial | Request-envelope reduction and trace caps exist. There is no explicit age/size pruning policy for tool results as a runtime primitive. | Long natural run keeps prompt input bounded without losing required evidence. |
| Replay and thought process UI | Partial | Mission Detail has trace and markdown rendering smoke coverage. Prior user-visible ordering and overlap issues mean this remains unproven until screenshot-backed checks cover real mission shapes. | Playwright screenshots for completed, approval, timeout, and browser missions show process first and final answer last. |
| Cancellation by tool call id | Partial | Active worker cancellation registry exists. Real cancellation and terminal mission cleanup need natural acceptance. | Natural cancellation run stops active work, writes cancelled tool result, and leaves no active worker. |
| Browser profile/session reliability | Partial | Profile fallback and diagnostics exist. Real profile-lock behavior must not be left to LLM retry behavior. | Browser reliability gate proves conflict classification and bounded recovery. |

## Continuation Matrix Summary

Every live-runtime continuation fix must map to one of these rows before code
changes are considered capability work.

| Runtime state | Expected user-facing behavior | Required proof |
| --- | --- | --- |
| `done` | Follow-up can reuse the completed child session when the user asks to continue the same thread. | Natural follow-up uses `sessions_send`, avoids duplicate spawn, and produces a useful terminal answer. |
| `resumable timeout` | The timed-out child session remains inspectable and can be continued without hiding the timeout from operators. | Natural timeout follow-up records the timeout, reuses the same session, reaches terminal state, and leaves no active/waiting/stale subjects. |
| `cancelled` | User cancellation writes a cancelled tool result, stops active worker execution, and a later follow-up can either continue the same context or clearly start new work. | Natural cancel-follow-up continuation proves terminal cancellation, no active worker residue, and correct follow-up routing. |
| `failed retryable` | The runtime exposes a retryable failure with bounded retry or continuation guidance instead of forcing the lead to improvise. | Natural failure scenario records the bucket, retryability, and either a bounded retry result or a useful evidence-only closeout. |
| `failed non-retryable` | The runtime stops tool use, explains the unrecoverable state, and asks for user/operator action when needed. | Natural failure scenario reaches terminal state without looped re-spawn or weak unsupported final claims. |
| `active/running` | The workbench can show ordered progress, and cancellation targets the active tool call or worker. | Natural long-running scenario shows live progress, cancellation by tool call id, and ordered replay after termination. |
| `needs approval` | Side-effect work pauses before execution, records query/result/applied state, and resumes or closes out based on the decision. | Natural approval dry-run proves no side effect before approval, denial produces useful output, and approval resumes the planned action. |

`natural-cancel-followup-continuation` is a P0-C / D5 / D6 capability gate for
cancelled continuation and per-agent timeout/continuation policy. It is not a
temporary scenario patch. Internally this maps to the cancelled-continuation and
per-agent-timeout rows in the working implementation matrix; the durable product
contract is the matrix above.

## P0 Roadmap

### P0-A Natural Acceptance Gate

Why core:
Natural complex prompts are the only evidence that the runtime is useful to a
real user. Contract-shaped prompts can hide weak planning, brittle tool use, and
final-answer failures.

Required:

- Keep contract E2E and natural E2E separately named in commands, reports, and
  validation-ops records.
- Natural report artifacts must say they are `natural-real-llm` capability
  evidence and list the quality signals they require.
- Validation ops must include the natural mission report summary, not only the
  contract/mission matrix summary.

Acceptance:

- `npm run acceptance:real` writes both mission and natural mission artifacts
  when natural acceptance is enabled.
- Validation-ops records contain natural scenario count, pass/fail count,
  liveness, tool use, browser use, approval use, weak-answer signal count, and
  evidence count.

Risk if not done:
The project can continue to look green while natural user prompts still loop,
stall, or produce thin answers.

### P0-B Prompt Harness And Delegation Discipline

Why core:
The lead should plan and synthesize; specialist sub-agents should perform
browser/research/tool-heavy work. If the lead keeps compensating for weak child
behavior, complex tasks will remain unstable.

Required:

- Strengthen registry-rendered harness sections for delegation, tool-use
  discipline, session continuation, browser work, memory use, task tracking,
  timeout closeout, and delivery.
- Ensure disabled/unavailable tools disappear from schemas and prompt-visible
  guidance.
- Keep browser primitives private to browser workers.

Acceptance:

- Snapshot tests verify harness content for lead and sub-agent contexts.
- Natural long delegation E2E shows independent sub-agent evidence and a parent
  synthesis, not repeated fallback spawning.

Risk if not done:
The model will keep oscillating between underusing tools and overusing tools,
and budget changes will only mask the issue.

### P0-C Live Runtime Protocol Proof

Why core:
A production workbench needs ordered, resumable execution truth, not post-hoc
debug traces.

Required:

- Prove assistant tool calls, progress, tool results, permission events, and
  final answers persist in order during active work.
- Prove `sessions_send` continues child transcript state.
- Prove `/message/cancel-tools` interrupts active worker execution when a
  cancellable tool call is registered.

Acceptance:

- Natural browser or long delegation run can be inspected while running and
  after completion with the same ordered chain.
- Cancellation scenario reaches terminal mission state with a cancelled tool
  result and no active/waiting/stale subjects.

Risk if not done:
Users see "working" without trustworthy process state, and failed/cancelled
work cannot be resumed or explained reliably.

### P0-D Browser Reliability Gate

Why core:
Browser failures currently amplify into bad agent behavior. The browser worker
must report reliable, bounded outcomes so the lead can synthesize or ask for
continuation.

Required:

- Real dynamic page and dashboard scenarios must verify rendered evidence, not
  server fixture text.
- Profile lock, CDP unavailable, attach failure, timeout, and target detach
  must produce stable buckets and bounded recovery.

Acceptance:

- Browser-backed natural E2E completes with browser evidence and no profile
  fallback loop.
- Failure-injection gate verifies the operator-facing bucket and next action.

Risk if not done:
Complex web tasks will keep failing as weak model answers or endless retries.

### P0-E Memory And Context Pressure Gate

Why core:
Complex tasks depend on prior decisions and accumulated evidence. Memory must
be reliable under context pressure, not just available as a tool.

Required:

- Natural memory recall after a long context path.
- Pre-compaction flush evidence in acceptance artifacts.
- Tool-result pruning policy that preserves evidence while bounding prompt
  growth.
- Memory invalidation after future write/edit tools.

Acceptance:

- Natural memory recall retrieves the expected durable item through native
  memory tools and avoids stale unsupported claims.
- Long natural run stays within prompt budget without losing required source
  coverage.

Risk if not done:
The agent will either forget important constraints or carry stale tool noise
into final synthesis.

## P1 And P2 Demotion

P1: Workbench UX only after P0 gates can prove useful terminal results. UX work
should then focus on Mission overview, chronological thought/process replay,
approvals, artifacts, sessions, continuation, cancellation, and screenshots.

P2: Diagnostics, ledger, docs, and governance. These are required for operating
the product, but they do not prove agent capability unless tied to real natural
E2E artifacts.
