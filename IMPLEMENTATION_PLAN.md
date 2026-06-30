# IMPLEMENTATION_PLAN — Cutover: route `LLMRoleResponseGenerator` through `createReActAgent`

> Status legend: **Not Started | In Progress | Complete | Skipped**
> Foundation (agent-core Tool/Toolkit, MCP, MemoryProvider, ReActLoop primitive, hooked engine + gateway bridge) is merged to `main`.

## Current baseline (as of the last checkpoint)

This plan is the production-generator cutover. The first four cutover steps are already **merged to `main`** — resume from **Stage 5**, not Stage 1:

- **Stage 1 — termination/execution predicates** → `react/predicates.ts` — ✅ merged (#481)
- **Stage 2 — flatten normalization pipeline** — ✅ merged (#482)
- **Stage 3 — finalization + redaction** — ⏭️ **Skipped.** Redaction consolidation is security-sensitive (`maybeRedactForbiddenLocalUrls` strips forbidden local URLs across 5 heterogeneous control-flow sites; 197-green can't prove a removed site safe on uncovered paths → leak risk), and the finalization-shaping extraction hits a circular-dependency wall (transforms are coupled to generator-local helpers). The visibility appenders are already a flat sequence. Revisit only via the engine-path `onFinalize`, not in-place.
- **Stage 4 — engine-path beachhead** — ✅ merged (#483). The `reactEngine: "inline" | "engine"` flag, `runViaReActEngine()`, and the both-paths parity harness **already exist**. Do NOT re-create them. Known scope gap (carry into the execution/budget convergence): the engine path runs tools per-call, not through `executeToolCalls`, so multi-call rounds don't yet honor `maxParallelToolCalls`/serialization/wall-clock/progress — it is scoped to single-tool-per-round simple scenarios.

**Next: Stage 5.** Each remaining stage = one PR off clean `main`, full CI + `codex:review` + bot review + fix, production staying `"inline"` until Stage 8.

## Context

`agent-core` now ships a complete, reusable, zero-dependency agent runtime on `main`: `Tool`/`Toolkit`, MCP adapter, `MemoryProvider`, the streaming `createBasicReActAgent`, and the full hooked engine `createReActAgent` with `ReActHooks<Ctx>` (`filterTools`, `onRoundMessages`, `onModelCallError`, `onToolCalls`, `onRoundEmpty`, `onBeforeExecute`, `onAfterExecute`, `terminationPredicates`, `onTerminate`, `onFinalize`, `onProgress`). `role-runtime` has `gatewayModelClient(LLMGateway) → ModelClient`.

The production reasoning loop still lives inline in `packages/role-runtime/src/llm-response-generator.ts` (`generate()`, ~lines 200–2288), a ~1900-line loop wrapping ~135 TurnkeyAI policy mechanisms (full inventory + mechanism→hook map in the prior plan's Appendix A). This plan moves that loop onto `createReActAgent` so the production generator becomes a thin shell that assembles `ReActHooks<RoleToolContext>` — making the policy enumerable, individually testable, and the loop reusable.

## Prime directives (hold for every step)

1. **Behavior-preserving until the final flip.** Production output (`GeneratedRoleReply`) must not change until Step 8. The existing `llm-response-generator.test.ts` (**197 tests**) is the oracle; it must stay green at every step.
2. **Two phases.** Phase 1 extracts mechanisms into pure functions the *existing* loop calls (continuous 197-green, no flag). Phase 2 swaps the loop behind a feature flag (default off), validated by full-197 parity with the flag on before the flip.
3. **One PR per step**, branched off clean `main`, full CI (build/test/typecheck ruleset) + `codex:review` + bot review (gemini/CodeRabbit) + fix loop, then merge. Never `--delete-branch` a base that another open PR points at; create PRs fresh against `main` (retarget does not trigger the required-checks ruleset).
4. **Mid-step validation = targeted tests.** Full-197 parity is only achievable once all hooks exist (Step 7); intermediate steps prove each extracted mechanism with its own unit tests + the unchanged 197.

## New layout

```
packages/role-runtime/src/react/
  role-react-context.ts   # RoleToolContext policy-state extensions + repair-marker state
  predicates.ts           # Phase 1: termination predicates (pure)
  normalizers.ts          # Phase 1: tool-call transform pipeline (pure)
  finalizers.ts           # Phase 1: onFinalize chain + URL redaction (pure, consolidated)
  role-react-policy.ts    # Phase 2: assembles ReActHooks<RoleToolContext> from the above
  *.test.ts
```

`react-model-client.ts` (exists) provides the model port. `createReActAgent`/hook types come from `@turnkeyai/agent-core`.

---

## The feature flag (DONE — Stage 4, #483)

Already landed — reuse, do not rebuild:
- `LLMRoleResponseGenerator`'s constructor has `reactEngine?: "inline" | "engine"` (default `"inline"`), overridable by env `TURNKEYAI_REACT_ENGINE=engine` (guarded `typeof process` check).
- `generate()` branches before the inline loop: `"inline"` → the original loop (untouched); `"engine"` → `runViaReActEngine(...)`.
- Composition root (`packages/app-gateway/src/composition/runtime-services.ts`) still constructs the generator without the flag → production stays `"inline"` until Stage 8.
- Tests construct the generator with `reactEngine: "engine"` and assert parity on the slice each stage supports (see the parity tests at the end of `llm-response-generator.test.ts`).

---

## Phase 1 — Extract mechanisms (no flag, 197 continuously green)

### Stage 1 — Termination predicates + execution/budget (peel 1–2)
**Goal:** Extract the generic closeout/budget checks into pure predicates the existing loop calls.
**Moves:** `findRepeatedFailedToolCall` (3507-3544, already pure), `round_limit` (`DEFAULT_ROLE_TOOL_MAX_ROUNDS`), `wall_clock` (1245-1252) → `react/predicates.ts` as `RoleTerminationPredicate = (state, ctx) => string | null`. Keep the `taskPrompt`-reading wall-clock override (`shouldAllowRequiredTimeoutContinuationPastWallClock`, 1238) as a host predicate. Extract `toolCallSignature`/serialization (`shouldSerializeToolBatch`, `ORDER_DEPENDENT_TOOL_NAMES`, 3489-3505) into a `resolveExecutionPlan` helper.
**Edits:** rewire `llm-response-generator.ts` inline checks to call the extracted helpers (logic identical).
**Verify:** 197 green; new unit tests for each predicate. **Success:** zero assertion edits to the 197; predicate units pass. **Risk: Low.**

### Stage 2 — Normalization pipeline (peel 3)
**Goal:** Collapse the 10-deep nested transform (444-492) into an ordered list of pure transforms.
**Moves:** `normalizeSessionToolAliasCalls` (8680), `normalizePrivateUrlResearchSpawnCalls` (8828), `normalizeLocalUrlWebFetchCalls` (8792), `normalizeBoundedTimeoutSourceSpawnAgents` (8889), `...DuplicateSourceSpawns` (8940), `normalizeApprovalGatedBrowserSpawnCalls` (9013), `limitIndependentEvidenceSpawnCalls` (4485), `applySessionContinuationDirective`/`...Lookup` → `react/normalizers.ts` as `RoleToolCallTransform[]`; loop calls `transforms.reduce(...)`.
**Verify:** 197 green; per-transform unit tests (input pattern → rewritten calls). **Risk: Low** (biggest readability payoff).

### Stage 3 — Finalization chain + redaction consolidation (peel 4)
**Goal:** Extract post-loop shaping (2207-2247) into an `onFinalize` chain and fix a latent bug.
**Moves:** visibility appenders (recovered-timeout 2216, required-followup 2226, residual-risk 2232, failure-bucket 2238), 3-line label enforcement (2244), `extractMentions` (2252), metadata assembly → `react/finalizers.ts`. **Consolidate** the 5 scattered `maybeRedactForbiddenLocalUrls` sites (392/941/1782/2634/2681) into one finalizer.
**Verify:** 197 green; finalizer units incl. a redaction-equivalence test across the old 5 call sites. **Risk: Low–Medium** (redaction consolidation needs an equivalence check).

---

## Phase 2 — Swap the loop (flag-gated, parity-validated)

### Stage 4 — Scaffolding + simplest-path parity
**Goal:** Stand up the engine path behind the flag; prove parity on the no-policy slice.
**Build:**
- `react/role-react-context.ts`: extend `RoleToolContext` with policy state (`taskPrompt`, `packet`, continuation directives, `recoveryToolBudget`, and a `repairMarkers` set — the seat for Step 6's `messages→ctx` migration).
- `react/role-react-policy.ts`: `buildRoleReActHooks(ctx-deps)` returning `ReActHooks<RoleToolContext>`, wired so far only with Stage 1–3 extractions (predicates, normalizers as `onToolCalls`, finalizers as `onFinalize`).
- `runViaReActEngine()` in the generator: `createReActAgent({ model: gatewayModelClient(...), toolkit, hooks })`, mapping the `ReActEvent` stream + closeout back into a `GeneratedRoleReply` (toolUse trace, mission report, metadata). Express `generateWithEnvelopeRetry` via `retryPolicy`/`onModelCallError`.
- The `reactEngine` flag (default `"inline"`).
**Verify:** flag off → 197 unchanged. New parity tests run the SAME scenarios through both paths for the simple tool-loop slice (no repair/approval/continuation) and assert identical `GeneratedRoleReply`. **Risk: Medium.**

### Stage 5 — Closeout plumbing (peel 5)
**Goal:** Route the ~12 `toolLoopCloseout` reasons through `terminationPredicates → onTerminate`.
**Moves:** `operator_cancelled` (653), `pseudo_tool_call` (1001), `repeated_session_inspection` (1388), `excessive_session_continuation` (1430), `sub_agent_timeout` (2139), `completed_sub_agent_final` (1564), `recovery_tool_budget` (585), `tool_evidence_fallback` (344). Keep reason↔finalizer↔`missionTerminalStatusForCloseout` (99-120) coherent; preserve the fail-closed invariant (82-91, `authorizedPartial` unset). **Delete dead code:** `partial_sub_agent_final` branch (finder 4193-4253 only matches `completed`).
**Verify:** parity slice expands to closeout scenarios; engine-path tests for each reason. **Risk: Medium.**

### Stage 6 — Repair / recovery (peel 6 — highest drift risk)
**Goal:** Move repair onto `onRoundMessages`/`onModelCallError`, after migrating idempotency state.
**Prereq (own commit):** migrate the "already tried" guard for every `shouldRepair*` from message-history scanning to `ctx.repairMarkers`. This is the true "Turnkey-agnostic" boundary — budget it explicitly.
**Moves (one predicate per commit + tests):** `shouldRepairMissingBrowserEvidence` (725), `...RequestedTableColumns` (620/1102), `...WeakEvidenceSynthesis` (1191), `...FalseEvidenceBlockedSynthesis` (2060/2085), `...SourceEvidenceCarryForward` (1164), `...MissingRequestedNextAction` (1955), `findMissingRequiredFinalDeliverables` (1976), `shouldSuppressToolsForAwaitingContextSetup` (977, inverse polarity — fires when calls > 0), `buildLocalEvidenceCloseout` fallback (344/2669) → `onModelCallError`.
**Verify:** parity slice expands per predicate. **Risk: High** (behavior can drift; per-predicate commits behind the suite).

### Stage 7 — Approval + session-continuation (peel 7 — most entangled, done together)
**Goal:** The forced-continuation override + the approval state machine as hooks.
**Moves:** `onRoundEmpty` forced send/list injection (546-584); `filterTools` permission-def stripping (`filterToolDefinitionsForTask` 3366); `onBeforeExecute` browser side-effect gating; the 8 sequential approval gates (804-976); forced `permission_result` rounds (348/1651 via `executeRuntimeForcedToolRound` 2864); approval-wait-timeout closeouts (924/11118); continuation/lookup directives (7392/7562), spawn→send rewrites (8507), timeout detection (`findSubAgentToolTimeout` 4163) + auto-continue (1523/1544/1565), `canonicalizeSessionToolTraceCalls` (1501/3895). Approval (§D) and continuation (§E) share `permission_*`/`session_tool_result.v1` trace machinery and the `onRoundEmpty` override, so extract them in one milestone.
**Verify:** parity slice expands to approval/continuation/timeout scenarios. **Risk: Highest.**

### Stage 8 — Policy architecture extraction + full engine flip
**Goal:** Replace the old one-step "flip + delete inline loop" cleanup with parity-first policy re-architecture. The engine path must continuously close the remaining inline behavior gap, then move the now-covered behavior into typed context, tool semantics, evidence ledger, permission/approval policy, continuation state machine, closeout registry, repair registry, and finalization policy.
**Spec:** `docs/STAGE8_REACT_ENGINE_ARCHITECTURE_SPEC.md` is the source of truth. Start with Stage 8A inventory + timeout-capped full-suite engine parity job; do not leave full parity as a final big-bang gate. Production flips only after parity is green and the two non-negotiable invariants hold: permission decisions before side-effect execution, and regex never authorizes or retroactively validates side effects.
**Verify:** full inline suite green in inline mode and engine mode; `tsc` 0; e2e via `npm run mission:e2e` / `scripts/tool-use-e2e.ts`; no unresolved flip-blocking Stage 8 inventory rows; no new policy regex outside detector modules. **Risk: High (architecture boundary + parity).**

---

## Per-step PR loop (every stage)

1. Branch off clean `main` (`feat/cutover-stepN-...`).
2. Implement; keep the 197 green (Phase 1) or expand the parity slice (Phase 2).
3. `npx tsx --test` (197 + targeted) green; `npx tsc --noEmit` 0 errors.
4. Commit, push, **create PR fresh against `main`** (not retarget); wait for the 3 required checks.
5. `codex review --base main`; read gemini/CodeRabbit; fix every real finding; re-verify; push.
6. Merge (`gh pr merge --merge --admin` once checks green); do NOT delete a base another PR needs.

## Verification & rollback

- **Oracle:** `llm-response-generator.test.ts` (197) unchanged throughout; Phase 1 keeps it green directly, Phase 2 keeps it green on the inline path and grows the engine-path parity set until it equals the full 197 at Stage 8.
- **Parity harness:** a test helper that runs a scenario through both `reactEngine: "inline"` and `"engine"` and deep-equals the `GeneratedRoleReply` (content, mentions, metadata, toolUse trace, mission report).
- **Rollback:** any regression → flip the flag/default back to `"inline"` (Phase 2) or revert the extraction commit (Phase 1). Production is never on the engine path before Stage 8.

## Workflow parallelization (within a step)

The PR sequence is strictly serial (each builds on merged `main`), but the drafting *inside* a step fans out cleanly: e.g. Stage 2's transforms and Stage 6's `shouldRepair*` predicates can each be drafted + unit-tested by parallel agents, then assembled and run against the 197 as one PR. Use a workflow per step to draft-in-parallel → assemble → verify; keep the review/merge gate human-driven.

## Stages

## Stage 1: Termination predicates + execution/budget
**Goal**: pure predicates extracted, loop rewired, 197 green. **Status**: Complete (#481)
## Stage 2: Normalization pipeline
**Goal**: 10-deep transform → ordered pure list. **Status**: Complete (#482) — flattened in place; module move deferred
## Stage 3: Finalization chain + redaction consolidation
**Goal**: onFinalize chain; 5 redaction sites → 1. **Status**: Skipped — security-sensitive redaction + circular-dep wall; revisit via engine-path onFinalize
## Stage 4: Scaffolding + simplest-path parity (flag)
**Goal**: engine path behind flag; no-policy parity. **Status**: Complete (#483) — flag + runViaReActEngine + parity tests landed
## Stage 5: Closeout plumbing + execution-limit gap
**Goal**: honor execution limits + replicate the 13 closeouts via hooks; delete dead branch. **Status**: In Progress — PR1 #485, PR3 #486, PR2a #487 (round_limit), PR2b #488 (tool_evidence_fallback), abort-rethrow fix #490 merged; PR2c (completed/timeout) + PR2d (onToolCallsClose + 7 pending) remain (Appendix B) ← NEXT. **Resume: `docs/HANDOFF_AGENT_CORE_CUTOVER.md`.**
## Stage 6: Repair/recovery (messages→ctx)
**Goal**: idempotency to ctx; shouldRepair* → hooks. **Status**: In Progress — prereq #495; `onRepairRound` hook + natural-finish repairs (table-columns #498, extraneous-schema + weak-evidence #500) DONE — that completes every repair the natural-finish `onRepairRound` mechanism can cover. Remaining = the completed-closeout repair pass (new post-`onTerminate` mechanism, covers source-evidence/false-evidence/next-action/deliverables/timeout-followup/browser-dimensions + completed-path versions), plus forced-spawn + pre-execute repairs (Stage-7 continuation territory). See handoff doc.
## Stage 7: Approval + session-continuation
**Goal**: onRoundEmpty override + approval machine as hooks. **Status**: Not Started
## Stage 8: Policy architecture extraction + full engine flip
**Goal**: close engine parity continuously, enforce pre-execute permission + regex governance, extract covered behavior into layered policy modules, then default to engine and remove inline after soak. **Status**: Not Started — see `docs/STAGE8_REACT_ENGINE_ARCHITECTURE_SPEC.md`

---

# Appendix B — Stage 5 detailed spec (from analysis workflow)

Verified against current `main`. All line refs are `llm-response-generator.ts` unless noted. Ship as 3 PRs.

## PR1 — execution-limit gap ✅ MERGED (#485)
Added `ReActHooks.runToolBatch?(calls, runOne, ctx)` to agent-core (default unbounded `Promise.all`). `runViaReActEngine` supplies a `runToolBatch` reusing the inline helpers `shouldSerializeToolBatch` / `resolveEffectiveToolLoopWallClockMs` / `createToolExecutionSignal` (order-dependent → step 1; else chunk by `maxParallelToolCalls`; per-chunk wall-clock signal). Each call wrapped in try/catch → `isError` result (error isolation, per codex/gemini). Inline `executeToolCalls` untouched. **Deferred to PR2:** `maxToolCallsPerRound` cap (via `onBeforeExecute`, replicate the synthetic `tool_call_limit_exceeded` result at `:3011-3030`) + progress/result persistence (via `onProgress` → `roundTrace` + `persistNativeToolTraceSafely` + `runtimeProgressRecorder`). **Hardened by #490:** the per-call try/catch swallowed `AbortError` too, letting the engine continue past operator cancel / per-chunk wall-clock; now rethrows aborts (`isAbortError(error) → throw`) exactly like inline `:3153-3156` (non-abort throws still → isError). Graceful round-top `wall_clock_budget` closeout is still PR2d.

## PR3 — delete dead `partial_sub_agent_final` (independent, do anytime)
`findCompletedSessionEvidence` (`:4296-4356`) declares `let partial = false` and never reassigns it (the loop `continue`s on any `parsed.status !== "completed"`), so `completedSession.partial` is always false and the `partial_sub_agent_final` branch is unreachable (two tests at `:13281`, `:13368` already assert the reason is never produced — they use `assert.notEqual`, which does NOT type-constrain, so removing the union member is safe). Delete: the union member (`:68`), the `missionTerminalStatusForCloseout` case (`:118`), the ternary → just `"completed_sub_agent_final"` (`:1693`), the partial-specific reasonLines branch (`~:1745`), and the finder's `partial` field (type `:4368`, decl `:4373`, return `:4422`).

## PR2 — closeout hooks (the bulk; depends on PR1) — split into slices
Turn `runViaReActEngine` from no-hooks into a closeout-parity path. Shipped as slices, each parity-gated:
- **PR2a ✅ MERGED (#487)** — closeout infrastructure + `round_limit`: the per-run `run` state, `onTerminate` dispatch → `generateFinalAfterToolRoundLimit`, metadata emits `toolLoopCloseout` + `missionReport` + reduction + memoryFlushes; `recordReductionBoundarySafely` after the loop (codex fix).
- **PR2b ✅ MERGED (#488)** — `tool_evidence_fallback` via `onModelCallError` (build local evidence closeout on a thrown tool-round model call; host reason `tool_evidence_fallback`, engine transport reason `model_call_error`; uses `state.messages`). Stage-7 scope note: the inline forced `permission_result` pre-check is approval machinery, deferred → engine model-error closeout scoped to non-approval flows.
- **PR2c ⏳ NEXT** — `completed_sub_agent_final` + `sub_agent_timeout` via `onAfterExecute(results, …)`. **Use the hook's `results` (current round's `[...rejected, ...executed]`), NOT `state.results` (cumulative).** `findSubAgentToolTimeout` (`:4400`, signal `:167`) scans `sessions_spawn|send` with parsed `status==="timeout"`; `findCompletedSessionEvidence` (`:4430`) requires `status==="completed"`/history evidence + `finalContents.length>0`. The `completed_sub_agent_final` reasonLines (inline `1700-1745`) are a ~20-line block with dynamic parts (`browserRecoverySummaries`, `buildCompletedBrowserEvidenceDimensionCarryForwardLines`, `preserveRecoveredTimeoutCloseout`) — store `completedSession`/`timeoutSignal` on `run` in `onAfterExecute`, build the reasonLines in `onTerminate`. **Continuation-scope guard:** the inline post-execute block (`1530-2220`) has many continuation/repair branches that `continue` (supplemental probe, incomplete-approved-browser, independent-evidence-streams, missing-approval-gate, forced-permission-result, weak-evidence) — those are Stage 7; `onAfterExecute` must only fire the two terminal closeouts, and parity tests must use scenarios where no continuation triggers.
- **PR2d ⏳** — the new `onToolCallsClose` agent-core hook + the 7 pending-call closeouts in inline precedence order (below).

**Needs a NEW agent-core hook** (adversarial finding): 7 of the 13 closeouts gate on the round's **pending** tool calls (post-normalize, pre-execute) — `recovery_tool_budget`, `operator_cancelled`, `pseudo_tool_call`, `wall_clock_budget`, `repeated_tool_failure`, `repeated_session_inspection`, `excessive_session_continuation`. No current hook can terminate there (`terminationPredicate` is pre-model; `onToolCalls` can only rewrite). Add `ReActHooks.onToolCallsClose?(calls, state, ctx): string | null`, invoked in `react-agent.ts` right after `onToolCalls` (`~:126`) and before execute (`:141`); if non-null, `yield* terminate(reason); return;`. Preserve the inline precedence order inside it: recovery-budget → operator-cancelled → pseudo → wall-clock → round-limit → repeated-failure → repeated-inspection → excessive-continuation.

**Per-run closeout state** (the hooks fire across callbacks): a mutable `run = { toolLoopCloseout, closeoutResult, reduction, reductionSnapshot, memoryFlushes }` captured by the hook closures. `onTerminate` writes it; `onFinalize` + the metadata assembly (`:2447-2467`) read it (mirror inline `:2275-2297`: emit `toolLoopCloseout`, `missionReport`, `requestEnvelopeReduction`, `preCompactionMemoryFlushes`).

**Hook map** (reuse the in-scope generator helpers verbatim):
- `round_limit` → already handled by `maxRounds`; just an `onTerminate` branch.
- `onToolCallsClose` → the 7 pending-call closeouts (reuse `findRepeatedFailedToolCall`, `findRepeatedSessionInspectionCall`, `findExcessiveSessionContinuationCall`, `containsAnyToolCallForm`, `shouldCloseoutCancelledSessionWithoutContinuation`, recovery-budget check, wall-clock check). Verify `containsAnyToolCallForm` reads only `.text`/`.toolCalls`.
- `onModelCallError` → `tool_evidence_fallback` model-error site (`:407-431`): `buildLocalEvidenceCloseout` + `maybeRedactForbiddenLocalUrls`, set `run.toolLoopCloseout` reason `tool_evidence_fallback`, return `{ text }`.
- `onAfterExecute` → `completed_sub_agent_final` (`findCompletedSessionEvidence`) + `sub_agent_timeout` (`findSubAgentToolTimeout`). **Scope guard:** only the two terminal closeouts — the huge inline post-execute block (`:1533-2216`) also has continuation/repair branches that `continue` (those are Stage 7); parity tests must use scenarios where none fire (the `simplePacket()` discipline).
- `onTerminate(reason, state, ctx)` → dispatch to `this.generateFinalAfterToolRoundLimit({ activation, packet, selection, baseGatewayInput: initialGatewayInput, messages: state.messages, maxRounds, modelCallTrace, reasonLines: <per-reason> })`; write `run.closeoutResult` (+ reduction/snapshot/memoryFlush); return `{ text }`. `generateFinalAfterToolRoundLimit` is at `:2642-2868`.
- `onFinalize` → apply the trailing visibility appenders (`:2228-2254`) for all paths; `maybeAppendTimeoutContinuationVisibility` for `sub_agent_timeout` only.

**fail-closed invariant** (`:82-91`): the partial/blocked split is enforced by deliberately NOT setting `authorizedPartial` — replicate by leaving it unset (`evidenceAvailable ? "partial" : "blocked"` reads `hasUsableEvidence(toolTrace)`).

**Parity tests:** one per closeout reason (round-limit, repeated-failure, repeated-session-inspection, pseudo-tool, wall-clock, completed-sub-agent, sub-agent-timeout, model-error fallback), asserting content + `missionReport` + `toolLoopCloseout` parity between `reactEngine: "inline"` and `"engine"`. Gate every step on the inline 197 + the parity set.
