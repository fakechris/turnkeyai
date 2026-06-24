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

### Stage 8 — Flip + delete inline loop
**Goal:** Make the engine the default and remove the old loop.
**Steps:** confirm full **197 parity with the flag on**; switch default to `"engine"` at the composition root; delete the inline loop body so `generate()` is a thin shell over `runViaReActEngine`; remove the flag (or keep `"inline"` removed) after a soak.
**Verify:** 197 green on the engine path; `tsc` 0; e2e via `npm run mission:e2e` / `scripts/tool-use-e2e.ts`. **Risk: Medium (cleanup).**

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
## Stage 5: Closeout plumbing
**Goal**: 12 closeouts via terminationPredicates/onTerminate; delete dead branch. **Status**: Not Started ← NEXT
## Stage 6: Repair/recovery (messages→ctx)
**Goal**: idempotency to ctx; shouldRepair* → hooks. **Status**: Not Started
## Stage 7: Approval + session-continuation
**Goal**: onRoundEmpty override + approval machine as hooks. **Status**: Not Started
## Stage 8: Flip + delete inline loop
**Goal**: engine default; remove inline loop; e2e. **Status**: Not Started
