# P0 — Completion Decision Rebuild (Design)

Goal: replace the prose-regex completion judge with a **typed completion
contract** driven by structured runtime state. Keep the centralized
completion-policy layer and replace only its implementation. Keep the genuine wins (closeout
semantics, budgets, in-loop approval, answer-aware gate) — drive them from
typed state instead of regex.

Principle (from all five systems): **state as data, not prose.** Every
"done / blocked / approved / failed" decision reads a typed field; transcript
text is at most an advisory tiebreaker.

---

## 1. Current seams (what we build on / replace)

- **Decision core**: `evaluateMissionCompletion(input) → MissionCompletionDecision`
  (`packages/app-gateway/src/mission-completion-evaluator.ts`). Pure function.
  Internally ~600 lines of `looksLikeComplete*` / `slotHasUnverifiedCoreClaim`
  regex + `mission-goal-slot-coverage.ts` regex slot inference.
- **Only caller**: `reconcileMissionLifecycle` in
  `mission-thread-bridge.ts:371` (polling tick). Writes `decision.patch` via
  `updateMissionLifecycle`; turns `decision.recovery` into an activity event +
  optional `postIncompleteFinalFollowUp`.
- **Recovery loop (the MSN-0113 hang)**: `buildIncompleteFinalFollowUp`
  (`mission-thread-bridge.ts:832`) — fixture-shaped prose (approvalRewriteOnly /
  slowSourceReleaseRisk / provider-column special cases) injected as a
  "System recovery: …" user message; `llm-response-generator.ts:7552` detects
  it and re-runs.
- **Typed signals that ALREADY exist but the evaluator bypasses**:
  - `TeamMessage.toolStatus: pending|completed|failed|cancelled` (`team-core.ts:33`)
  - `TeamMessage.metadata.toolLoopCloseout.reason` (round_limit / wall_clock_budget / repeated_tool_failure / tool_evidence_fallback / operator_cancelled / sub_agent_timeout / completed_sub_agent_final / …)
  - `RoleRunState.status: idle|running|waiting_input|waiting_external|resumable|done|failed|cancelled` (`team-worker-runtime.ts:59`)
  - `WorkerExecutionResult.status: completed|partial|failed` (`:37`) + session-tool-result protocol status enum
  - **Flow-close signal**: `coordination-engine.ts:600` — lead reply with no dispatchable `@{mention}` ⇒ flow closes.
- **Missing**: the lead's final answer is a plain assistant message with **no
  typed terminal self-report**; `evaluateMissionCompletion` re-derives "is this
  the final lead answer and is it complete?" from prose.

---

## 2. Target: the typed completion contract

A mission turn resolves through a **priority pipeline of typed signals**, regex
demoted to an advisory score that can never gate `done` on its own.

```
evaluateMissionCompletion(mission, messages, roleRuns, workerSessions, taskSpec?)
  1. ACTIVE?        typed: roleRun running/queued/waiting OR worker running
                    → none / active_execution. (unchanged)
  2. STRUCTURAL STOP typed: flow closed (no pending lead tool turn + lead reply
                    with no dispatchable mention). Not finished → existing
                    stalled/skipped/blocked branches (already typed on toolStatus).
  3. SELF-REPORT    typed: latest lead terminal report (metadata.missionReport)
                    = { status: completed|partial|blocked, reason?,
                        unverifiedSlots?, evidenceRefs? }.
                    FAIL CLOSED: only status==="completed" is a success candidate.
                    partial|blocked → tagged terminal (see §4), no recovery loop.
  4. VERIFICATION   gate the "completed" candidate by ground-truth tier:
        (a) deterministic verifier declared on taskSpec → run it; pass⇒done.
        (b) no verifier → structured EVIDENCE COVERAGE over required slots
            (typed evidence events: source URL / numeric / quote present),
            + optional GATED advisory judge (≤ small weight, only when
            structural+evidence already pass).
                    pass ⇒ done(progress 1). fail ⇒ incomplete (recovery, §5).
  5. ADVISORY       regex looksLikeComplete* only as a tiebreaker score when
                    self-report AND verifier are both absent (legacy threads).
  6. HONEST FAIL    budget exhausted / self-report partial|blocked / verifier
                    fail past cause-gated budget → typed terminal with closeout.
```

Step 3 + "fail closed" is the spine: **`done` requires a typed `completed`
self-report plus either a passing verifier or passing evidence coverage.**

---

## 3. Data model changes

All additive; back-compatible (every new field optional).

- `core-types/src/team-core.ts` — `TeamMessage.metadata.missionReport?: MissionTerminalReport`:
  ```ts
  interface MissionTerminalReport {
    status: "completed" | "partial" | "blocked";
    reason?: string;                 // typed short reason, not prose to scan
    unverifiedSlots?: string[];      // slot keys the lead could not verify
    evidenceRefs?: string[];         // artifact/event ids backing the answer
    authorizedPartial?: boolean;     // task explicitly permitted partial/blocked
  }
  ```
- `core-types/src/mission-core.ts` — extend the terminal vocabulary already
  started by `Mission.closeout`: add `Mission.terminalReason?: string` and let
  `closeout` carry `"partial"` in addition to today's `bounded_failure` /
  `approval_timeout`. (Status stays the existing enum; we are enriching the
  *why*, not adding states.)
- `mission-completion-evaluator.ts` — `MissionCompletionDecision` gains
  `decision.completion?: { source: "self_report"|"structural"|"verifier"|"evidence"|"advisory"; verified: boolean }`
  for observability/debugging (so we can see WHICH signal decided it).
- **Evidence coverage** (`mission-goal-slot-coverage.ts`) — keep the slot
  *inference* from goal text (that part is acceptable), but change
  `slotIsCovered` to consume **typed evidence** (timeline evidence events with
  a source URL / numeric / quote field) instead of regex over the answer prose.
  `taskSpec.requiredEvidence?` optionally declares slots explicitly so we stop
  inferring where the caller already knows.

---

## 4. How partial/blocked settles (kills the MSN-0113 loop structurally)

Replaces the §469 patch with the general mechanism:

- Lead self-reports `status: "partial"|"blocked"` (typed). Evaluator settles
  immediately to a tagged non-success terminal: `{ status: done,
  closeout: "partial"|"bounded_failure", terminalReason, progress<1 }`. **No
  recovery injection.** Honest completion, converged in one tick.
- `authorizedPartial` (task permitted it) is now a typed field on the report,
  not re-derived bilingually from goal text. The §469 `missionAuthorizesPartial
  Closeout` regex stays only as the *fallback* that sets `authorizedPartial`
  when a legacy lead didn't emit a typed report.
- A self-reported `completed` that fails the verification gate (§2.4) →
  recovery, but cause-gated and bounded (§5), not an infinite prose loop.

---

## 5. Recovery: de-fixtured + cause-gated

- Delete the scenario special-cases in `buildIncompleteFinalFollowUp`
  (approvalRewriteOnly / slowSourceReleaseRisk / provider-column). The recovery
  prompt is generated from the **typed gap**: which `unverifiedSlots` lack a
  covering evidence event, and which tool families could supply them. No
  fixture prose.
- **Cause-gated retry**: only recover when the
  gap is plausibly closable (missing evidence + tools available + budget left).
  A deterministic agent-side failure (verifier failed for a real reason) is
  surfaced, not replayed.
- **Bounded**: keep an attempt cap, but exhaustion → typed `blocked` closeout
  (honest fail), never a re-loop. Output-fingerprint stuck-detection is an
  optional follow-up to abort earlier when answers repeat.

---

## 6. Agent self-report channel (how missionReport gets produced)

Two stages, so we don't block on model-prompt changes:

- **Stage A (runtime-derived, no model change)**: role-runtime's final
  synthesis already computes a `toolLoopCloseout` and knows whether it emitted a
  partial/exhausted answer. Map that + the structural flow-close into a
  `missionReport` written to the final message metadata. This gives typed
  self-report for free on day one (covers the common cases incl. MSN-0113).
- **Stage B (model-facing, later)**: expose a `mission_report` tool so
  the lead *explicitly* declares terminal status + unverified slots + evidence
  refs, with prompts that forbid early or approximate completion. Strongest
  signal; opt-in per team.

Evaluator prefers B > A > structural > evidence > advisory.

---

## 7. Migration / back-compat

- Signature of `evaluateMissionCompletion` unchanged except an **optional**
  `taskSpec` arg → single caller (`mission-thread-bridge.ts:371`) updated; all
  existing tests keep compiling.
- Legacy threads with no `missionReport`: pipeline falls through to structural
  + evidence + advisory-regex — i.e. **current behavior is the fallback**, so
  nothing regresses while typed signals roll in.
- Regex stays in the tree as the advisory tier during migration; removed only
  after typed signals are proven to cover the matrix + real missions.

---

## 8. Phased delivery (each phase independently testable, mergeable, revertible)

- **Phase 1 — typed-signal-first evaluator + Stage-A self-report.**
  Rewrite `evaluateMissionCompletion` as the §2 pipeline; consume flow-close +
  toolStatus + closeout reason + Stage-A `missionReport`; demote regex to
  advisory. Settle partial/blocked via typed report (§4). *Net: MSN-0113 class
  converges from structure, not the §469 special-case.* Guarded by the existing
  200+ evaluator/observability tests + new typed-signal tests.
- **Phase 2 — evidence-coverage verification gate.**
  `mission-goal-slot-coverage` consumes typed evidence events; add the gated
  advisory-judge interface (judge stubbed/advisory first). Replace prose-slot
  coverage.
- **Phase 3 — de-fixtured cause-gated recovery.**
  Strip scenario special-cases from `buildIncompleteFinalFollowUp`; generate
  recovery from typed gaps; cause-gate retries; exhaustion → typed blocked.
- **Phase 4 — `mission_report` model tool (Stage B)** + optional
  output-fingerprint stuck-detection.

Phases 1–3 remove the defect; Phase 4 adds explicit model self-report. We can
stop after any phase with a coherent system.

---

## 9. Test plan

- Port the real MSN-0113 transcript into a fixture: assert Phase 1 settles it to
  `done + closeout:partial` in one tick with **zero** recovery injections.
- Typed-signal unit tests: each of {flow-open active, flow-closed completed,
  self-report partial, self-report blocked, completed-but-evidence-missing,
  legacy-no-report-fallback} → expected decision + `decision.completion.source`.
- Anti-regression: the existing evaluator/observability suites must stay green
  (current behavior = the advisory fallback).
- Anti-gaming: a fabricated "done" prose with no typed completed report and no
  evidence coverage must NOT reach `done` (fail-closed proof).
- i18n: a Chinese completed/partial/blocked answer resolves identically to its
  English twin (kills the English-bias defect).

---

## 10. Out of scope (tracked, later)

Verification *system* rebuild (clawbench-shaped trace/reliability/config
scoring), credential hard-deny guard, memory tool, workspace-diff replay,
adapter/registry control plane — all in the diagnosis doc's P1/P2. This design
is only the completion *decision* rebuild (P0).
