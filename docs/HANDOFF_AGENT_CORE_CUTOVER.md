# Handoff — `agent-core` extraction + response-generator cutover

> **Read this first, then `IMPLEMENTATION_PLAN.md` (esp. Appendix B).** This doc is the
> resume point for a fresh session. Verified against `main` at commit `edca487`
> (PR #490 merged). Line numbers drift as PRs land — **grep the symbol, don't trust the
> number.**

## TL;DR — where we are

We extracted a zero-dependency reusable agent runtime (`@turnkeyai/agent-core`) and are
**converging the production `LLMRoleResponseGenerator`'s inline ~1900-line tool loop onto
it**, one bounded, behavior-preserving slice at a time, **behind a flag**:

- `reactEngine: "inline" | "engine"` constructor option on `LLMRoleResponseGenerator`
  (default **`"inline"`**, env override `TURNKEYAI_REACT_ENGINE=engine`).
- **Production runs `"inline"` and stays inline until the final flip (Stage 8).** The
  engine path is exercised only by parity tests until then.
- Every slice is gated by the **204-test oracle** (`llm-response-generator.test.ts` =
  197 inline behavior tests + the cutover parity tests) — must stay green with **zero
  assertion edits to the 197**.

The engine path (`runViaReActEngine`) is real and **parity-proven** for: no-tool reply,
single tool round, order-dependent serialization, throwing-tool isolation, **`round_limit`**
closeout, **`tool_evidence_fallback`** closeout, and **abort propagation** (PR #490). The
rest of the 13 closeouts are specced and ready (Appendix B).

## What's merged (the cutover so far)

Foundation (agent-core + agent-core-mcp): Tool/Toolkit, MCP adapter, ReActLoop/ReActAgent,
MemoryProvider — all zero-dep, depend only on `@turnkeyai/llm-adapter/types`.

Cutover (production generator onto the engine), all flag-gated, production still inline:

| Slice | PR | What |
|---|---|---|
| Stage 4 | #483 | `reactEngine` flag + scaffolding + simplest-path parity (no-tool / single-tool) |
| Stage 5 PR1 | #485 | `runToolBatch` hook + execution limits (serialize / concurrency / per-chunk wall-clock), per-call error isolation |
| Stage 5 PR3 | #486 | delete dead `partial_sub_agent_final` branch |
| Stage 5 PR2a | #487 | closeout infra (per-run `run` state, `onTerminate`, metadata) + `round_limit` |
| Stage 5 PR2b | #488 | `tool_evidence_fallback` via `onModelCallError` |
| Stage 5 docs | #489 | progress doc |
| Stage 5 fix | #490 | rethrow aborts from the engine tool batch (codex P2) |
| Stage 5 PR2c | #492 | `completed_sub_agent_final` + `sub_agent_timeout` via `onAfterExecute` |
| Stage 5 PR2d | #493 | `onToolCallsClose` agent-core hook + the 7 pending-call closeouts (graceful `wall_clock_budget` closes the #490 gap) |
| Stage 6 prereq | #495 | migrate every `shouldRepair*` idempotency guard off message-scanning onto the `repairMarkers` ledger (the Turnkey-agnostic boundary) |
| Stage 6 move 1 | #498 | `onRepairRound` agent-core hook + cut over `missing-table-columns` repair (natural-finish path); test-gate hygiene #497 |
| **Stage 6 move 2** | **#500** | **cut over `extraneous-schema` + `weak-evidence` repairs via `onRepairRound` — completes the natural-finish repair phase** |

## What #490 fixed (context for the next session)

PR1's per-call error isolation in `runToolBatch` wrapped each executor call in
`try/catch → isError`, which swallowed **`AbortError`** too. That let the engine loop
continue past operator cancellation and per-chunk wall-clock timeouts. Inline
`executeToolCalls` rethrows aborts; the engine now mirrors it:

```ts
} catch (error) {
  if (isAbortError(error)) throw error;   // operator cancel / per-chunk wall-clock → propagate
  // non-abort tool failure → observable isError result (isolation preserved)
  return { toolCallId: call.id, toolName: call.name, isError: true, content: ... };
}
```

A rethrown abort propagates: react-agent's loop catch rethrows when `signal?.aborted`
(parent cancel); a per-tool wall-clock abort (run signal not aborted) falls to
`onModelCallError`, which returns `"rethrow"` for `isAbortError`. Both reject the run.

**Update (PR2d #493): the #490 gap is now closed.** The graceful round-top
**`wall_clock_budget`** closeout landed in PR2d's `onToolCallsClose` hook — when the
cumulative budget is exhausted at the top of a round, the engine produces a final answer
from gathered evidence (instead of only failing loud on a mid-execution abort). #490's
fail-loud rethrow remains for true mid-execution aborts (operator cancel / per-chunk
wall-clock timeout); the two are complementary.

## The discipline (hold this for every slice)

1. **One PR per slice off clean `main`.** `git checkout main && git pull && git checkout -b ...`
2. **Behavior-preserving + parity-gated.** Add a parity test that runs the same scenario
   through `reactEngine: "inline"` and `"engine"` and deep-equals the result
   (`content` + `mentions` + `toolLoopCloseout.reason` + `missionReport.status`).
3. **Full review loop every PR:** `codex review --base main`, read the bots
   (gemini-code-assist + CodeRabbit), fix, repeat until clean.
4. **Gates:** `npx tsc --noEmit -p tsconfig.json` (clean) +
   `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts` (all green).
5. **Merge:** `gh pr merge <N> --merge --admin` (the `main` ruleset requires 3 status
   checks: build/test/typecheck — admin merge after they pass).

### Hard-won process facts

- **The `main` ruleset blocks retargeted PRs** ("3 of 3 required status checks expected").
  Retargeting does NOT trigger CI. **Create PRs fresh against `main`** (creation triggers CI).
- **Stacked-PR hazard:** `gh pr merge --delete-branch` on a base another open PR points at
  **CLOSES the dependent PR** (GitHub doesn't auto-retarget). Don't delete a base mid-stack.
- **LSP diagnostics are stale** ("Cannot find module @turnkeyai/agent-core/*",
  "implicitly any", spurious unused-var). **Trust `npx tsc --noEmit`, not the LSP block.**
- `exactOptionalPropertyTypes: true` — assign `| undefined` explicitly, don't use `?` for
  fields you set to possibly-undefined.
- `ls` is wrapped (emoji summary) — use `find`. zsh eats unquoted globs — quote `'*.ts'`.

## What's next — exact order

### Stage 5 PR2c ✅ MERGED (#492)

`completed_sub_agent_final` + `sub_agent_timeout` via `onAfterExecute(results, state, ctx)`.
Signals stashed on `run` in `onAfterExecute`; reasonLines + metadata built in `onTerminate`
(completed → `maybeRedactForbiddenLocalUrls`; timeout → `maybeAppendTimeoutContinuation
Visibility`). Deferred (codex P2): the completed-branch browser-recovery / recovered-timeout
visibility appenders (see deferred gaps below).

### Stage 5 PR2d ✅ MERGED (#493)

New agent-core hook `ReActHooks.onToolCallsClose?(calls, state, ctx): string | null`,
invoked in `react-agent.ts` right after `onToolCalls` and **before the `model_response`
emit** (so a terminating round leaves no trace); if non-null, `yield* terminate(reason);
return;`. The **7 pending-call closeouts** fire in inline precedence order:
recovery_tool_budget → operator_cancelled → pseudo_tool_call → wall_clock_budget →
repeated_tool_failure → repeated_session_inspection → excessive_session_continuation.
`round_limit` is omitted (the engine's `maxRounds` loop fires it post-loop at exactly
`round === maxRounds`, where inline's `for(;;)` hits `roundLimitReached`; the hook runs only
on rounds `0..maxRounds-1`, so precedence is preserved). **The graceful `wall_clock_budget`
closeout landed here, closing the #490 gap.** Deferred (codex P2): the post-synthesis repair
passes (`shouldRepairMissingRequestedTableColumns` / `shouldRepairMissingBrowserEvidence
Dimensions`) and a wall_clock/round_limit final-boundary timing edge (see deferred gaps).

### Stage 6 prereq ✅ MERGED (#495)

Idempotency migrated off message-scanning onto a `repairMarkers: LLMMessage[]` ledger (the
repair prompts we inject). Every `shouldRepair*` guard now reads `input.repairMarkers`; the
`hasX*RepairPrompt` helpers are byte-unchanged (still scan an `LLMMessage[]` — fed the
ledger). Injections go through `recordRepairPrompt(repairMarkers, …)`. Inline owns a
loop-local ledger; the engine will pass `ctx.repairMarkers` when the per-predicate moves land.
Residual (documented in code, behavior-preserving): `generateFinalAfterToolRoundLimit`'s own
internal synthesis-retry keeps message-based idempotency (`repairMarkers: finalMessages`) — a
shared, already-cutover-safe path with its own message scope.

### Stage 6 natural-finish onRepairRound phase ✅ COMPLETE (#498, #500)

agent-core `ReActHooks.onRepairRound?(state, ctx): ReActRepairDecision | null` — fires on a
tool-free candidate final answer (the natural-finish path, where the empty round would
otherwise terminate); a non-null `{ messages, forceToolChoice? }` runs one more (default
tool-free) round instead of finalizing. Repair rounds do NOT consume the tool-round budget
(`round--`); host idempotency (`ctx.repairMarkers`, seeded + persisted via `??=`) converges
it, `MAX_REPAIR_ROUNDS` (32) is the hard backstop. **Cut over (each with a neutral-scenario
inline-vs-engine parity test):** `shouldRepairMissingRequestedTableColumns` (#498),
`shouldRepairExtraneousProviderTableSchema` + `shouldRepairWeakEvidenceSynthesis` (#500). This
phase used a fan-out workflow (draft-in-parallel → assemble → verify).

That is **every repair the natural-finish onRepairRound mechanism can cover.** The rest were
categorized (by the fan-out) into the next phases below — they need NEW mechanisms, not more
onRepairRound blocks:

### Stage 6 completed-closeout repair pass ✅ MECHANISM BUILT (#502) — predicate additions remain

The inline **completed_sub_agent_final** closeout runs a post-synthesis repair cascade
(`~:1827-2182`) the engine's `onTerminate` did not (it synthesized once and returned terminally).
Mechanism chosen + built: an **`onTerminate` internal repair loop** (NO new agent-core hook —
`onTerminate` now takes `ctx`). After the closeout synthesis, while a completed-repair predicate
fires on the result against `run.completedSession.finalContents`, it re-synthesizes via a forced
tool-free `generateWithEnvelopeRetry` call with the repair prompt — the SAME plain model call the
inline completed block uses (NOT the format-contract `generateFinalAfterToolRoundLimit`).
Idempotent via `ctx.repairMarkers`; 16-round cap; each pre-compaction memory flush appended (codex
P2 fix). **Cut over so far (in inline cascade order):** `shouldRepairSourceEvidenceCarryForward`
(#505), `shouldRepairTimeoutFollowupFinalGuidance` (#505), `shouldRepairMissingRequestedNextAction`
(#503), `findMissingRequiredFinalDeliverables` (#504), `shouldRepairFalseEvidenceBlockedSynthesis`
(#502). Each placed in inline precedence order; single-fire scenarios are parity-exact.

**Plumbing landed in #505:** `onAfterExecute` now also stashes `run.completedSessionToolResults`
(the completing round's results — the same array inline passes to `collectToolResultContentText` at
:1933), and `onTerminate` rebuilds `completedProductBriefEvidenceText` = finalContents + raw
tool-result text byte-for-byte like inline :1933-1938. source-evidence is truthy-gated on it (inline
:1940); timeout-followup is NOT (inline :1967). deliverables/false-evidence keep the bare
finalContents `evidenceText`. The missing-next-action block gained a `!repairPrompt` guard (it was
first; now third).

**Compound semantics closed out (#506):** inline runs the completed cascade exactly once (the round
the session completes), then every repaired answer flows through the narrower tool-free natural-
finish cascade (`:1110-1272` = table-columns, extraneous, source-evidence, weak-evidence). The loop
now mirrors that — the completed-ONLY predicates (timeout-followup/missing-next-action/deliverables/
false-evidence) are gated to `repairRound === 0`; source-evidence (the one cross-cascade member)
runs every round. A compound parity test (source-evidence round 0 → would-be missing-next-action
round 1) pins it: mutation-verified it fails without the gating. This was the prerequisite for
moving the natural-finish predicates safely — **do NOT batch table-columns/extraneous/weak-evidence;
move them one at a time**, each into BOTH `repairRound === 0` and the every-round branch, each with
its own parity test.

**Remaining deferred gaps (off the default path, un-exercised, documented in-code):**
- **maxToolCallsPerRound over-cap completed round** — the engine `runToolBatch` does not yet honor
  the cap, so it feeds real tool content where inline feeds `tool_call_limit_exceeded` sentinels into
  the evidence; tracked with the tool-cap cutover.
- **Residual under-repair** — the every-round natural-finish branch only has source-evidence; table-
  columns/extraneous/weak-evidence aren't there yet (the one-at-a-time moves below), and post-round-0
  source-evidence uses `completedProductBriefEvidenceText` rather than inline's natural-finish
  `sourceBoundedEvidenceText` (masked by idempotency once source-evidence fires in round 0).
- **Timeout/browser visibility appenders** (codex #506 P2) — the engine completed path doesn't run
  inline's `maybeAppendBrowserRecoveryVisibility` / recovered-timeout / timeout-continuation appenders
  (inline `:1782-1814` completed, `:1253-1270` natural-finish). Gating the timeout-followup *repair*
  to round 0 is parity-faithful (inline's natural-finish has no such repair), but it exposes this
  pre-existing appender gap: a `sessions_send` resumed-timeout completion whose round-0 repair was
  source-evidence can omit the round-1 timeout visibility inline appends. Closes with the
  appender/continuation cutover (the same stage that handles the pre-synthesis continuation branches).

**Remaining (follow-on moves on this same loop, ONE AT A TIME):** completed-path table-columns
(:1826), extraneous (:1854), weak-evidence (:2153) — each into round 0 + the every-round branch; then
`shouldRepairMissingBrowserEvidenceDimensions` (:2100). Then Stage 7 (forced-spawn + pre-execute).

### Stage 6 / 7 boundary — forced-spawn + pre-execute repairs ⏳ (Stage-7 continuation territory)

- `shouldRepairMissingBrowserEvidence` / `…MissingProductSignalBrowserEvidence` — re-arm a real
  `sessions_spawn` **tool** round (not a tool-free re-synthesis), which collides with
  `onRepairRound`'s `round--` budget model. Need a forced-evidence-spawn mechanism (a tool round
  that consumes budget). These are continuation/recovery branches → Stage 7.
- `shouldSuppressToolsForAwaitingContextSetup` — **pre-execute** (fires when `toolCalls.length > 0`):
  suppress tools + inject guidance + continue. Needs a suppress-and-continue hook (`onToolCalls`
  /`onRoundMessages` family), not `onRepairRound`. → Stage 7.
- `buildLocalEvidenceCloseout` — already done (`onModelCallError` / `tool_evidence_fallback`, PR2b).

- **Stage 7** — approval + session-continuation (peel 7, most entangled, done together).
  This is where the deferred bits land: the forced `permission_result` pre-check (PR2b scope
  note), `executeRuntimeForcedToolRound`, the `onRoundEmpty` forced-continuation override.
- **Stage 8** — flip `reactEngine` default to `"engine"`, delete the inline loop, e2e.

## Key anchors (grep these; line numbers drift)

Production generator — `packages/role-runtime/src/llm-response-generator.ts`:
- `runViaReActEngine` — the engine-path branch (the cutover target).
- `runToolBatch` hook (execution limits + the #490 abort rethrow).
- `onTerminate` (closeout reasonLines → `generateFinalAfterToolRoundLimit`),
  `onModelCallError` (`tool_evidence_fallback`).
- Inline reference: `executeToolCalls` (per-tool catch `if (isAbortError(error)) throw error`),
  its call site, `generateFinalAfterToolRoundLimit`, `missionTerminalStatusForCloseout`,
  `buildRuntimeDerivedMissionReport`, `hasUsableEvidence`, the fail-closed invariant
  (`authorizedPartial` deliberately unset).
- Helpers: `isAbortError`, `throwIfAborted`.

agent-core — `packages/agent-core/src/`:
- `react-loop.ts` — `ModelClient`, `ReActEvent`, `ReActState`, the full **`ReActHooks`**
  surface (`runToolBatch`, `onAfterExecute`, `onTerminate`, `terminationPredicates`, …).
- `react-agent.ts` — `createReActAgent`. Loop catch rethrows on `signal?.aborted`; the
  default `runOne` (used only without a `runToolBatch` hook) still converts throws to
  isError — a parent-cancel abort there is caught at the next round's top-of-loop
  `throwIfAborted(signal)`, so it's a minor inconsistency, not a runaway. **Optional future
  cleanup:** add `if (signal?.aborted) throw error;` to the default `runOne` for symmetry.

Parity test harness — end of `packages/role-runtime/src/llm-response-generator.test.ts`
(search `Cutover Stage 4: engine-path parity`): `simplePacket()`, `fixedAnswerGateway()`,
fake gateway via `Object.create(LLMGateway.prototype)`, and the existing parity tests to
copy as templates.

## Resume checklist

```bash
git checkout main && git pull --ff-only origin main
npx tsc --noEmit -p tsconfig.json                                   # clean
npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts   # all green (222)
# Stage 6 prereq (#495) done → start the Stage 6 per-predicate moves off a fresh branch
# (confirm the engine repair mechanism first — see "Stage 6 per-predicate moves" above)
# NOTE: RTK wrapper mangles `npx`; run gates via `rtk proxy npx tsc …` / `rtk proxy npx tsx …`
```

## Deferred / known scope gaps (intentional)

- **Post-synthesis repair passes** (PR2d, codex P2) — the engine pending-call closeouts
  (recovery/cancelled/pseudo/wall-clock) do not re-loop after synthesis to repair missing
  requested table columns / browser-evidence dimensions (`shouldRepairMissingRequested
  TableColumns` / `shouldRepairMissingBrowserEvidenceDimensions`). Deferred with Stage 6/7;
  no-ops for the in-scope scenarios.
- **wall_clock vs round_limit final-boundary timing edge** (PR2d) — inline checks wall_clock
  on the extra `round === maxRounds` iteration its `for(;;)` loop runs; the engine exits to
  round_limit one round earlier. A budget first crossed exactly on that boundary closes as
  round_limit (engine) vs wall_clock (inline). Common case (budget crossed earlier) is
  handled; parity tests pin the clock to avoid it.
- **Stage-7 approval pre-check** before `tool_evidence_fallback` (forced `permission_result`
  round) — engine model-error closeout is scoped to non-approval flows until Stage 7.
- **Completed-closeout visibility appenders** (PR2c, codex P2) — the engine
  `completed_sub_agent_final` `onTerminate` applies `maybeRedactForbiddenLocalUrls` only.
  The inline completed branch (`~:1747-1783`) also runs `maybeAppendBrowserRecoveryVisibility`
  / `maybeAppendBrowserFailureBucketVisibility` / recovered-timeout + continuation appenders
  before redaction. Those fire only for browser-recovery / timed-out-then-completed sessions,
  which **also** trip the inline pre-synthesis continuation branches PR2c defers — so they
  can't be parity-tested until the browser/recovery + Stage-7 continuation stages land. No-ops
  for the clean (explore-agent) sessions in scope.
- **Redaction consolidation** (`maybeRedactForbiddenLocalUrls` at 5 sites) — **security-
  sensitive** (strips forbidden local URLs across heterogeneous sites; a 197-green run can't
  prove a removed site safe on uncovered paths → URL-leak risk). Deliberately deferred; do
  not "consolidate" it casually.
- **`maxToolCallsPerRound` cap + progress/result persistence** — deferred from PR1 (via
  `onBeforeExecute` + `onProgress`; replicate the synthetic `tool_call_limit_exceeded`
  result and `persistNativeToolTraceSafely`).
- **agent-core default `runOne` abort-swallow** — minor, see anchors above.
