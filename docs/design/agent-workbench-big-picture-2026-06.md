# Agent Workbench Big Picture — 2026-06 Runtime Audit

Status: living document, written during the June 2026 code-level audit of the
chat → team → mission → harness → completion → replay chain. Findings here are
grounded in first-hand code reads (file:line refs are to this repo at the time
of writing). Where a claim needs real-LLM E2E to prove, it is marked
**[needs-real-E2E]** and must NOT be treated as demonstrated capability.

## 1. The core chain (how a user task becomes a mission result)

```
user message
  → app-gateway routes → CoordinationEngine.handleUserPost
      (packages/team-runtime/src/coordination-engine.ts:240)
  → FlowStartIntent → materializeFlowStartIntent → dispatchToLead → dispatchToRole
      (coordination-engine.ts:295 — single chokepoint for ALL dispatches:
       user posts, cascades, fan-out, merge, scheduled re-entry, recovery)
  → HandoffEnvelope { payload = RelayPayload }
      relayBrief        ← relayBriefBuilder (app-gateway/src/composition/foundations.ts:282)
      recentMessages    ← last 8 thread messages, FULL content in payload
      continuity/coordination/constraints
  → role loop (team-runtime/src/inline-role-loop-runner.ts)
  → DefaultRolePromptPolicy.buildPacket (role-runtime/src/prompt-policy.ts:116)
      systemPrompt = role/system prompt + tool harness (tool-capability-registry)
      taskPrompt   = DefaultPromptAssembler.assemble (role-runtime/src/prompt/prompt-assembler.ts)
                     [task-brief | recent-turns | thread-summary | session-memory |
                      role-scratchpad | retrieved-memory | worker-evidence]
  → LLMRoleResponseGenerator.generate (role-runtime/src/llm-response-generator.ts:147)
      messages = [system: packet.systemPrompt, user: packet.taskPrompt + output contract]
      tool loop: rounds of native tool calls → RoleToolExecutor → tool results
      closeouts: completed_sub_agent_final / sub_agent_timeout / round_limit /
                 wall_clock_budget / operator_cancelled / tool_evidence_fallback
  → reply message (+ native tool messages) persisted to thread
  → handoff planner parses @{role-id} mentions → next dispatch, or flow closes
  → MissionThreadBridge polls thread → ActivityEvents on mission timeline
      (app-gateway/src/mission-thread-bridge.ts)
  → evaluateMissionCompletion (app-gateway/src/mission-completion-evaluator.ts:53)
      → mission.status / progress / blockers patch
  → mission-observability.ts builds qualityGate snapshot for the UI
  → control-center renders timeline / result / evidence
```

Sub-agents: the lead model calls `sessions_spawn` / `sessions_send` /
`sessions_history` (role-runtime/src/sub-agent-worker-handler.ts). Worker
results come back as `turnkeyai.session_tool_result.v1` JSON
(role-runtime/src/session-tool-result-protocol.ts) with
`status: completed|partial|failed|timeout|cancelled`, `final_content`,
`evidence_summary`. `findCompletedSessionEvidence`
(llm-response-generator.ts:2951) only treats `status === "completed"` as
final-evidence — partial/timeout/failed get their own closeout paths.

Recovery: replay analysis → RecoveryRun → `buildRecoveryDispatchTask`
(app-gateway/src/recovery-action-service.ts:609) → scheduled task →
`handleScheduledTask` → `dispatchToRole` (so recovery dispatches share the
same prompt path as everything else).

## 2. Where the harness was structurally unsound (P0 root causes)

### 2.1 The model never sees the user's full task text (FIXED in this audit)

Before this audit, the user goal passed through THREE independent truncation
layers before reaching the model:

1. payload layer: dispatch `recentMessages` content capped at 320 chars per
   non-tool message (`MAX_RECENT_MESSAGE_CHARS`,
   team-runtime/src/coordination-engine.ts:1858), window = last 8 messages;
2. relay brief: each message line truncated to 220 chars, whole brief ≤ 2,400
   chars (`RELAY_BRIEF_LINE_MAX_CHARS`/`RELAY_BRIEF_MAX_CHARS`,
   app-gateway/src/composition/foundations.ts:513);
3. recent-turns render: 220 chars per turn
   (prompt-assembler.ts `buildRecentTurnsSection` maxChars = 220).

The only other channel was thread-summary `userGoal` — a compression product
that exists only after the context maintainer has run.

`buildGatewayInput` (llm-response-generator.ts:6331) sends exactly
`[system: packet.systemPrompt, user: packet.taskPrompt]` — there is no other
channel. Consequence: any user task longer than ~220 chars (i.e. nearly every
real task with table columns, evidence requirements, format contracts) was
silently chopped before the first model call, and stayed chopped through
continuation, recovery, and final synthesis. The final-synthesis format
contract even says "Review the original user/task request for any explicit
final answer shape" — reviewing text the model never received.

In long threads (> 8 messages) the original user message also drops out of
`recentMessages` entirely, so recovery dispatches (whose capsule instructions
carry only group-id/status/reason — recovery-action-service.ts:668) ran with
no goal text at all beyond the lossy thread summary. A follow-up post makes it
worse: every user post starts a NEW flow whose root is the follow-up, so even
"the flow's root message" is not the original task.

Fix shipped with this audit: every dispatch now carries the originating goal
verbatim (see §5).

### 2.2 Completion is message-shape + regex marker driven

`evaluateMissionCompletion` decides mission terminality from message shape and
English-marker regexes, not from goal-level evidence:

- any non-empty lead assistant message with no tool calls, no `@{mention}`,
  not "looking truncated" ⇒ `done, progress 1`
  (mission-completion-evaluator.ts:127);
- `looksLikeCompleteBoundedFailureCloseout` / `…PendingApprovalWaitTimeout…` /
  `…ApprovedApprovalCloseout` are long fixture-tuned regexes over the final
  message text (same file, :350-:478). A mission whose browser was never
  reachable closes as `done, progress: 1, blockers: 0` if the model's text
  matches the closeout grammar.

Mission status has no way to distinguish "done — goal achieved" from
"closed — bounded failure / approval timeout" (core-types/src/mission-core.ts
`MissionStatus`). The human-facing card says done/100% either way.
Fix shipped with this audit: closeout kind is now recorded on the mission and
the evaluator no longer fakes 100% progress for failure closeouts (see §5).
Marker-regex completion itself is a deeper issue: the durable fix is slot
level goal/evidence tracking, which is design work beyond this round
**[needs-real-E2E to calibrate]**.

### 2.3 Runtime is overfit to the fixture matrix

`LLMRoleResponseGenerator` (236 KB) embeds dozens of scenario-shaped
heuristics that regex-match `packet.taskPrompt` and rewrite model tool calls
or inject repair prompts (`normalizePrivateUrlResearchSpawnCalls`,
`normalizeBoundedTimeoutSourceSpawnAgents`,
`shouldRepairMissingProductSignalBrowserEvidence`, …). The deterministic
fixture (natural matrix) exercises exactly these regexes, so "natural" E2E
passes measure the harness's agreement with itself, not model capability.
This is the main reason fixture passes must not be cited as capability
evidence. Unwinding this layer is a multi-round refactor; this audit documents
it and avoids deepening it.

## 3. Tool schema & enforcement (what the model is told vs. what runs)

- Tool definitions + prompt harness text: role-runtime/src/tool-capability-registry.ts
  (`renderPromptHarness` is injected into every system prompt).
- Execution: role-runtime/src/tool-use.ts (round/wall-clock budgets,
  `DEFAULT_ROLE_TOOL_MAX_ROUNDS = 128`, session tool timeouts 3-18 min by
  worker kind), sub-agent lifecycle in sub-agent-worker-handler.ts.
- Sub-agent result protocol: session-tool-result-protocol.ts — statuses are
  explicit; timeout results are `resumable: true` with `evidence_available`
  flag; the tool loop converts timeouts into a bounded closeout prompt that
  forbids fabricating verification (llm-response-generator.ts:1389).
- Final fallback when the LLM call itself fails mid-loop:
  `buildLocalEvidenceCloseout` only fires when `hasUsableEvidence(toolTrace)`;
  otherwise the error propagates and the role run fails (good).
- Heuristic fallback adapter (role-runtime/src/model-adapter.ts) writes the
  "Final synthesis based on the latest tool result / Verified / Unverified /
  Residual risk" answer when the primary generator throws. It treated
  sub-agent `status: "partial"` evidence the same as `completed`
  (`hasCompletedOrPartialToolEvidence`) — adjusted in this audit (see §5).
- Sub-agent run-level status: `LLMSubAgentWorkerHandler` stamped every
  non-throwing run "completed" regardless of how the inner loop ended —
  adjusted in this audit to derive partial/resumable status from the loop
  closeout (see §5). Structured `status: "failed"` worker results also now
  set `isError` on the tool result (see §5).

## 4. UI replay & acceptance accounting

- mission-observability.ts builds tool/session/approval/liveness counters and
  a `qualityGate` (final answer present, ≥1 evidence event, ≥2 source labels…)
  — all shape-level, consumed by control-center.
- The "result" a human sees is the latest lead final-answer ActivityEvent
  (mirrored from the thread by mission-thread-bridge expandMessage).
- A/B + acceptance summaries (qc-runtime/src/real-llm-acceptance-summary.ts,
  real-llm-ab-acceptance.ts) aggregate the natural gate's per-scenario
  booleans (`completed`, `finalAnswerHasEvidence`, `finalAnswerUseful`…)
  defined in scripts/mission-tool-use-e2e.ts:5358. The gate is
  multi-dimensional but ultimately marker/threshold based
  (`finalAnswerUseful` = byte length + keyword regex).

## 5. Fixes shipped in this audit round

1. **Verbatim goal carriage (P0(b) root cause).**
   New `DispatchIntent.goal` (core-types/src/team-dispatch.ts):
   `resolveDispatchGoal` anchors on the thread's EARLIEST user message
   (mission threads post the goal as the first user message) and carries the
   LATEST user message as `latestDirection` when it differs. Populated at the
   `dispatchToRole` chokepoint (coordination-engine.ts) from a widened
   un-truncated message window (200 messages, full content — explicitly
   bypassing the 320-char dispatch sanitizer), so it reaches initial,
   cascade, fan-out, merge, scheduled and recovery dispatches alike.
   Rendered by the prompt assembler as a verbatim "Original user goal" block
   with first claim on the task-layer budget, ahead of the relay-brief
   digest, never silently truncated (cap = 6,000 chars with an explicit
   `[truncated]` marker), plus a binding-requirements instruction
   (output format / table columns / evidence demands / blocked-partial
   reporting).
2. **Honest failure closeouts (P0(a)).**
   `evaluateMissionCompletion` now tags bounded-failure and approval-timeout
   closeouts with `closeout: "bounded_failure" | "approval_timeout"` on the
   mission patch and stops forcing `progress: 1` for them; `Mission.closeout`
   is carried through the store, bridge, and control-center so the UI renders
   "Closed · blocked" / "Closed · no approval" instead of a green "Done"
   (atoms.tsx StatusTag, MissionDetailPage describeMissionStatus).
3. **Sub-agent exhaustion no longer reads as completion (P0(c)).**
   `LLMSubAgentWorkerHandler` used to stamp every non-throwing run
   `status: "completed"`. It now derives the run status from the inner tool
   loop's closeout: `round_limit`, `wall_clock_budget`,
   `repeated_tool_failure`, `tool_evidence_fallback`, `operator_cancelled`,
   `sub_agent_timeout` ⇒ `status: "partial"` with `resumableReason`, so the
   parent's `findCompletedSessionEvidence` (which keys on
   `status === "completed"`) cannot treat budget-cut output as authoritative
   completion evidence.
4. **Failed sub-agent runs are error results (P0(c)/P1(a)).**
   `sessions_spawn`/`sessions_send` set `isError: true` for structured
   `status: "failed"` worker results (previously only for null results), so
   the repeated-failure breaker (`findRepeatedFailedToolCall`) counts them
   and the persisted tool turn reads as failed in replay and in the
   completion evaluator's stalled-turn detection.
5. **Partial sub-agent evidence labeled as partial in the fallback final
   (P1(b)).** The heuristic fallback synthesis (model-adapter.ts) no longer
   presents `status: "partial"` output under "Verified:"; it is labeled
   "Partially verified (… PARTIAL, resumable …)" with an explicit
   continue-the-same-session pointer.
6. **sessions_list schema/output field mismatch (P1(a)).**
   The tool returns snake_case fields (`parent_session_key`) but only
   accepted camelCase filters (with `additionalProperties: false` rejecting
   the snake_case spelling models copy back). Both spellings are now accepted
   and advertised.

(See git history of this branch for the precise diffs; each fix landed with
regression tests: team-dispatch-goal.test.ts, coordination-engine.test.ts,
prompt-policy.test.ts, mission-completion-evaluator.test.ts,
sub-agent-worker-handler.test.ts, tool-use.test.ts, model-adapter.test.ts.)

## 6. Risk map (what remains, prioritized)

| Risk | Class | Where | Status |
| --- | --- | --- | --- |
| Marker-regex mission completion (no goal slots) | P0(a) | mission-completion-evaluator.ts | Open — needs slot-level goal/evidence model **[needs-real-E2E]** |
| Fixture-overfit tool-call rewriting layer | P0/P2 | llm-response-generator.ts | Open — multi-round refactor; do not extend |
| `sessions_send` cached-summary shortcut: a summary-phrased follow-up that implies NEW analysis (e.g. "对比/compare" — verbs missing from the fresh-work list) silently replays the cached `lastResult` instead of continuing the session | P1 | tool-use.ts isCachedSummaryRequest (~:1761) | Open — verified; durable fix is to stop regex-second-guessing continuations |
| Session tool results serialize the sub-agent's full nested tool trace (`payload.metadata.toolUse`) into model-facing/timeline content; gateway pruning bounds the LLM envelope but replay/timeline can surface raw trace JSON | P1(a) | sub-agent-worker-handler.ts payload, session-tool-result-protocol serialize | Open — split model-facing result from replay payload |
| Silent browser→explore spawn reroute can contradict the prompt-harness routing rules for browser-visible/private URLs | P1(c) | llm-response-generator normalize*SpawnCalls | Open — reported by audit mapper, needs verification |
| `finalAnswerUseful` = bytes + keyword regex | P2 | scripts/mission-tool-use-e2e.ts:5464 | Open — replace with rubric scoring in real-LLM A/B |
| Quality gate not consulted by lifecycle | P1 | mission-observability vs. thread-bridge | Open — `done` should require gate pass |
| Thread-summary `userGoal` lossy + late | P1 | context-state-maintainer.ts | Mitigated by fix §5.1 |
| Browser-vs-fetch routing encoded as prompt regexes | P1(c) | llm-response-generator normalize* | Open |
| Accio parity docs vs. reference | P2 | docs/design/runtime-hard-points-parity-plan.md 等 | See §7 |

(Environment note: `packages/app-gateway/src/routes/browser-expert-live-e2e.test.ts`
fails on machines whose HTTP proxy intercepts localhost CDP requests (HTTP
407); it is gated on a locally-resolvable Chrome and is unrelated to runtime
changes.)

## 7. Accio Work reference parity (structural)

Reference: extracted runtime at
`/Users/chris/workspace/turnkeyai/artifacts/reference-runtimes/accio-work-0.4.5`
(`app/out/{main,preload,renderer}`, minified Electron bundles, ~20 MB; the
asar source is `/Applications/Accio.app/Contents/Resources/app.asar`. Do NOT
use `/Users/chris/workspace/accio` — deprecated repo).

Honest status: this round's deep parity read did NOT complete (the audit
sub-agents hit session limits), so this section deliberately avoids claiming
per-mechanism findings that were not verified. What this round establishes:

- the comparison must be STRUCTURAL (prompt harness, tool schema, enforcement,
  replay), not JS-diffing of minified bundles;
- TurnkeyAI's own goal-anchoring gap (§2.1) was the largest structural
  divergence from any production agent runtime: the original task text must
  be an immutable anchor re-presented at every synthesis boundary — that is
  now implemented (§5.1);
- existing parity docs (runtime-hard-points-parity-plan.md,
  runtime-mechanisms-gap-analysis.md, p0-natural-runtime-parity-reset.md)
  should be re-validated against the extracted reference before being cited
  in any A/B claim — treat their per-mechanism claims as unverified until
  then.

Next concrete step: grep the reference bundles for long English prompt
strings, tool schema literals (session/sub-agent/browser/fetch tools), and
status enums; map each to the TurnkeyAI equivalent listed in §1; record
deltas here with file paths on both sides.

## 8. How to verify capability for real (not in this round)

- Same-goal A/B against Accio Work on missions whose specs exceed 220 chars
  and demand explicit table columns + per-row evidence — this directly
  exercises fix §5.1.
- A bounded-failure browser mission (CDP down) must end visibly as
  closed-incomplete in the UI, not "done 100%".
- A sub-agent timeout with partial evidence must produce a final answer whose
  verified/unverified split matches the evidence trail.
