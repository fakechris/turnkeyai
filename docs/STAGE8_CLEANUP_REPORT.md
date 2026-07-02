# Stage 8 Engine Cleanup — Final Acceptance Report

**Branch:** `feat/stage8-engine-cleanup`
**HEAD:** `15b16f919d3c7a2ae22cd1a502b7a3716181e640`
**Date:** 2026-07-01

## Summary

The Stage 8 cleanup campaign landed its **safety scaffolding** (Batch 0 + Batch 0.5)
but **did not land any of the actual policy-extraction batches (1–5)**. Batch 1 was
blocked on a hard-rule conflict in the tool-call-normalizer extraction, and per the
sequential-campaign rule Batches 2–6 were skipped as a consequence. All six acceptance
gates pass on the current HEAD, but that HEAD only contains the module *shells* and the
behavior-neutral policy-trace plumbing — `runViaReActEngine` remains a fat
policy-carrying method, not a thin adapter.

## Batches: committed vs blocked

| Batch | Status | Commit |
|-------|--------|--------|
| 0 — Safety Baseline And Module Shell | **committed** | `5bb5b8fd77a1a27aad5469952751ba824a523835` |
| 0.5 — Characterization Trace And Wiring Guards | **committed** | `15b16f919d3c7a2ae22cd1a502b7a3716181e640` |
| 1 — Observability / Normalization / Finalization extraction | **blocked** | — |
| 2 — (skipped: prior batch blocked) | blocked | — |
| 3 — (skipped: prior batch blocked) | blocked | — |
| 4 — (skipped: prior batch blocked) | blocked | — |
| 5 — Evidence / TaskFacts / legacy-text-detectors | blocked | — |
| 6 — (skipped: prior batch blocked) | blocked | — |

### Why Batch 1 blocked (root cause of the whole campaign halting)

The normalizer extraction cannot be made behavior-preserving without violating a HARD
RULE. The `ENGINE_TOOL_CALL_NORMALIZATION` pipeline's transitive closure is **69
top-level symbols** in `llm-response-generator.ts`, dominated by helpers **jointly owned
by the inline parity reference loop** and dozens of other class methods
(`readStringInput` @55 refs, `readMessageContentText` @30, `extractHttpUrls` @19,
`buildContinuationDirectiveContext` @13, `taskRequiresBrowserEvidence` @12, plus the
browser/permission/session detector cluster). Moving them into `react-engine/*` would
force the inline loop to import them back **from** react-engine — altering the parity
reference (rule 3 violation). The alternatives are forbidden re-exports from
`llm-response-generator` (rule 2) or wholesale duplication of ~69 helpers (behavior
drift on the golden order). No path satisfies all three rules at once, so the batch was
correctly not attempted blind.

The recommended unblock is a new prerequisite **"Batch 0.75: extract shared
text/url/detector helpers"** into a neutral role-runtime module that BOTH the inline
loop and `react-engine/*` import, making the inline relocation a sanctioned move rather
than an alteration of the parity reference. Only then can the 13 normalizer steps +
`ENGINE_TOOL_CALL_NORMALIZATION_ORDER` relocate.

## Extracted modules

Only the **trace / contract infrastructure** carries real implementation. The
policy-owning modules are still **11–16 line shells** exporting a module-name marker
const; their bodies are deferred to the unlanded Batches 1–5.

**Real implementation (Batch 0 / 0.5):**
- `react-engine/types.ts` (138 LOC) — discriminated-union contracts
- `react-engine/engine-run-state.ts` (130 LOC) — behavior-neutral run-state impl
- `react-engine/policy-trace.ts` (45) — `InMemoryEnginePolicyTrace` + NOOP
- `react-engine/hook-policy-trace.ts` (296) — `traceEngineHooks()` boundary wrapper
- `react-engine/hook-orchestration-contract.ts` (188) — pinned cross-module call order as data
- `react-engine/policy-trace-characterization.ts` (320) + `__golden__/engine-policy-trace.golden.json`
- `react-engine/index.ts` (27) — barrel

**Shells only (bodies deferred to Batches 1–5):**
`engine-run-observer`, `permission-policy`, `tool-call-normalizer`,
`finalization-pipeline`, `execution-budget-controller`, `continuation-controller`,
`closeout-policy-registry`, `repair-policy-registry`, `completed-closeout-controller`,
`evidence-ledger`, `task-facts`, `legacy-text-detectors`.

The composition root imports **only** `createEnginePolicyTrace` and `traceEngineHooks`
from `./react-engine` (llm-response-generator.ts:60–63). None of the policy shells are
consumed yet.

## Gate results (all pass on HEAD `15b16f9`)

| # | Gate | Result |
|---|------|--------|
| 1 | `tsc --noEmit -p tsconfig.json` | **exit 0**, 0 errors |
| 2 | `tsx --test packages/role-runtime/src/react-engine/*.test.ts` | **12 pass / 0 fail** (3 test files) |
| 3 | `tsx --test react-agent.test.ts react-loop.test.ts` | **38 pass / 0 fail** |
| 4 | `engine-parity-check --inline --per-test 25` | **272 pass / 0 fail** |
| 5 | `engine-parity-check --write --chunk 20 --per-test 30 --chunk-timeout 180` | **272 pass / 0 fail / 0 skip**, all 14 chunks completed |
| 6 | `git diff --check` | **clean** |

Note on Gate 6: the `--write` parity run (Gate 5) regenerated the tracked artifact
`docs/STAGE8B_PARITY_STATUS.md`, appending a single trailing blank line (flagged by
`git diff --check` as "new blank line at EOF"). This is the same incidental runner edit
noted in the Batch 0/0.5 records; it was reverted (`git checkout --`) so the working
tree is clean and the diff stays scoped. No source change was involved.

## Is the adapter thin? — **No.**

`runViaReActEngine` (llm-response-generator.ts:2528–5219) is **~2,692 lines** and still
contains the full product-policy surface inline: tool-call normalization, session
continuation directives (`findSessionContinuationDirective` /
`findSessionContinuationLookupDirective`), permission/approval gating
(`permission_query` rewrites, `isAppliedApprovalBrowserContinuation`), browser-evidence
requirements (`taskRequiresBrowserEvidence`), execution-budget handling, completed-session
and sub-agent-timeout closeouts (`findCompletedSessionEvidence`, `findSubAgentToolTimeout`),
reason-line reconstruction, and finalization appenders — **101 occurrences** of those
product-policy symbols remain in the file. The method's own JSDoc concedes it "is
intentionally still an adapter-heavy bridge" and that the extraction to named
controller/observer modules is "the next cleanup."

The only structural improvement landed is the behavior-neutral policy-trace wrapper
(`traceEngineHooks`) around the hooks object and the `EnginePolicyTrace` threaded through
the run — pure observation, gated behind `TURNKEYAI_ENGINE_POLICY_TRACE=1` for the debug
metadata surface. `reactEngine` still defaults to `inline`; the inline loop is untouched.

**Verdict:** adapter/composition-only status was the *goal* of Batches 1–5, none of which
landed. The adapter is **not yet thin**; it remains policy-carrying.

## Deferred typed-facts debt

- **`legacy-text-detectors.ts`** — shell only; implementation deferred to Batch 5. Its
  authority contract is documented (each detector must state the structured field that
  should replace it, its producer, its feasibility class — `already_structured`,
  `present_only_as_text`, or `missing_from_producer` — and the debt row it centralizes,
  with positive+negative fixtures; hard invariant: detectors return facts only, never
  authorize/validate/execute a side-effect tool). None of that inventory has been
  populated. The text-fallback detectors currently used by the inline/engine policy
  (browser-evidence, session-continuation, permission/approval detection) remain scattered
  as free functions in `llm-response-generator.ts`.
- **`task-facts.ts`** — shell only; deferred to Batch 5. Intended to centralize repeatedly
  inferred task-prompt facts (requested table columns, requires-browser-evidence, requested
  browser dimensions, requested next actions, source-evidence requirements) as a facade over
  existing helpers. Today those facts are still re-derived ad hoc inside the adapter.
- **`evidence-ledger.ts`** — shell only; deferred. Evidence reconstruction still lives inline
  in the closeout hooks (`completedSession` / `completedSessionToolResults` stashing).
- **Policy trace granularity** — the Batch 0.5 trace is COARSE (one entry per installed hook,
  outcome derived from the return value). Fine-grained per-policy ids and the wiring-guard
  upgrade (drive real adapter hooks with spy module impls rather than the contract-order
  pin) are deferred to the per-module extraction batches, each of which must re-`write` the
  characterization golden and prove no behavior drift.

## Recommendation

Do not treat this branch as "Stage 8 complete." Gates are green only because the branch
is behavior-neutral scaffolding. Re-scope the campaign to insert the **Batch 0.75 shared
helper extraction** prerequisite before Batch 1, then land Batches 1–5 to actually thin
the adapter and discharge the typed-facts debt.

**Not pushed** (per instructions).
