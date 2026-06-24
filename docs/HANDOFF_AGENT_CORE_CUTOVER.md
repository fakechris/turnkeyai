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
| **Stage 5 fix** | **#490** | **rethrow aborts from the engine tool batch** (this session — codex P2) |

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

**Known related gap (deferred, NOT a bug introduced here):** the engine still lacks the
graceful round-top **`wall_clock_budget`** closeout (a future slice — a
`terminationPredicate`). #490 makes the engine **fail loud** (propagate) instead of
silently continuing; the graceful closeout that produces a final answer from gathered
evidence is still inline-only.

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

### Stage 5 PR2c ⏳ NEXT (the heaviest remaining slice)

`completed_sub_agent_final` + `sub_agent_timeout` via `onAfterExecute(results, state, ctx)`.
**This is the riskiest single slice** — a large state-dependent reasonLines block that must
match inline exactly, plus the discipline of not letting Stage-7 continuation branches leak
in. Full spec in `IMPLEMENTATION_PLAN.md` Appendix B (PR2c bullet). Key points:

- **Use the hook's `results`** (current round's `[...rejected, ...executed]`), **NOT
  `state.results`** (cumulative).
- `findSubAgentToolTimeout` (grep it; signal interface near agent-core `react-loop.ts`
  `ReActState`) scans `sessions_spawn|send` for parsed `status==="timeout"`;
  `findCompletedSessionEvidence` requires `status==="completed"` / history evidence +
  `finalContents.length > 0`.
- The `completed_sub_agent_final` reasonLines (inline, grep
  `buildCompletedBrowserEvidenceDimensionCarryForwardLines`) are ~20 lines with dynamic
  parts. **Store `completedSession`/`timeoutSignal` on `run` in `onAfterExecute`; build the
  reasonLines in `onTerminate`.**
- **Continuation-scope guard:** the inline post-execute block has many continuation/repair
  branches that `continue` (supplemental probe, incomplete-approved-browser,
  independent-evidence-streams, missing-approval-gate, forced-permission-result,
  weak-evidence) — **those are Stage 7.** `onAfterExecute` must fire ONLY the two terminal
  closeouts, and parity tests must use scenarios (the `simplePacket()` discipline) where no
  continuation triggers.

### Stage 5 PR2d ⏳

New agent-core hook `ReActHooks.onToolCallsClose?(calls, state, ctx): string | null`,
invoked in `react-agent.ts` right after `onToolCalls` and before execute; if non-null,
`yield* terminate(reason); return;`. Then the **7 pending-call closeouts in inline
precedence order**: recovery_tool_budget → operator_cancelled → pseudo_tool_call →
wall_clock_budget → repeated_tool_failure → repeated_session_inspection →
excessive_session_continuation. Full spec: Appendix B (PR2d + Hook map).

> PR2d is where the graceful `wall_clock_budget` closeout lands (closing the #490 gap).

### Then

- **Stage 6** — repair / recovery (peel 6). **Must first migrate repair idempotency state
  off `messages` into `ctx`** (today each `shouldRepair*` detects "already tried" by
  scanning conversation history). Highest drift risk — do each predicate as its own commit.
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
npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts   # all green (204)
# read IMPLEMENTATION_PLAN.md Appendix B (PR2c bullet) → start PR2c off a fresh branch
```

## Deferred / known scope gaps (intentional)

- **Graceful `wall_clock_budget` closeout** in the engine — lands in PR2d. (#490 made the
  engine fail loud meanwhile.)
- **Stage-7 approval pre-check** before `tool_evidence_fallback` (forced `permission_result`
  round) — engine model-error closeout is scoped to non-approval flows until Stage 7.
- **Redaction consolidation** (`maybeRedactForbiddenLocalUrls` at 5 sites) — **security-
  sensitive** (strips forbidden local URLs across heterogeneous sites; a 197-green run can't
  prove a removed site safe on uncovered paths → URL-leak risk). Deliberately deferred; do
  not "consolidate" it casually.
- **`maxToolCallsPerRound` cap + progress/result persistence** — deferred from PR1 (via
  `onBeforeExecute` + `onProgress`; replicate the synthetic `tool_call_limit_exceeded`
  result and `persistNativeToolTraceSafely`).
- **agent-core default `runOne` abort-swallow** — minor, see anchors above.
