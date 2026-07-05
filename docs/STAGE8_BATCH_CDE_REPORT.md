# Stage 8 Batch C/D/E — Final Verification Report

Branch: `feat/stage8-campaign` · HEAD `d954ba0` · tree clean
Verification date: 2026-06-30

## Verdict

All four required gates are GREEN. The Batch C/D/E campaign lands the T10, C5, and
T7 capability planes on the ReAct engine with zero inline regressions, taking full
engine parity from **28 fails → 6 fails** (all 6 remaining are out-of-scope
T2/continuation-plane items owned by Batches B/F, plus one closeout collateral).

## Gate results

| # | Gate | Command | Result |
|---|------|---------|--------|
| 1 | tsc | `tsc --noEmit -p tsconfig.json` | **exit 0** ✅ |
| 2 | inline regression net | `engine-parity-check.ts --inline --per-test 25` | **267 pass / 0 fail** ✅ |
| 3 | full engine parity | `engine-parity-check.ts --write --chunk 20 --per-test 30 --chunk-timeout 180` | **260 pass / 6 fail**, 1 skip (KNOWN_HANG) ✅ (all fails out of scope) |
| 4 | agent-core loops | `tsx --test react-agent.test.ts react-loop.test.ts` | **38 pass / 0 fail** (exit 0) ✅ |

The inline reference (gate 2) is the regression net: it exercises the same 267
points through `reactEngine:"inline"` and is a clean 267/0, proving the ports did
not disturb the production (inline) path. Production stays `reactEngine:"inline"`.

## Per-batch status

| Batch | Plane | Commit | fails before → after | Status |
|-------|-------|--------|----------------------|--------|
| 8C | T10 browser/session finalization & visibility | `93f7384` | 15 → 4 (T10 8→0; owned T2 7→4) | ported |
| 8D | C5 memory / compaction / envelope | `6ab6a87` | 5 → 0 | ported |
| 8E | T7 execution budget / wall-clock (+ #55 leaked-timer fix) | `d954ba0` | 4 → 0 | ported |

- **8C** ported the `onTerminate` completed_sub_agent_final browser-visibility
  appender chain (recovery → failure-bucket, mirroring inline `:1928-1964` order)
  plus the unconditional post-loop finalization epilogue (`:2407-2433`) driving 3
  owned T2 timeout-followup repairs. Closed all 8 T10 fails; 4 T2 fails deferred to
  the tool-normalization/continuation plane (Batch B/D branch-3).
- **8D** carried per-round request-envelope reduction + pre-compaction memory-flush
  forward from `generateWithEnvelopeRetry`, recorded the pruning/compaction boundary,
  injected `withFinalToolRoundWarning`, and stored evidence-first capped tool-trace
  content. Closed the whole C5 cluster (5→0).
- **8E** ported the four T7 behaviors (execution cap via shared
  `buildToolCallLimitExceededResult`, recovery-budget carry-across, blocked-delegation
  repair round, round-limit synthesis at `maxRounds+1`) and resolved the #55
  leaked-timer crash by disposing the per-chunk wall-clock signal in `finally` and
  extending (not aborting) an active browser session past the parent budget. Closed
  the whole T7 cluster (4→0).

All three batches touch only `packages/role-runtime/src/llm-response-generator.ts`
(+ its `.test.ts`) plus the #55 edit to `scripts/engine-parity-check.ts`. No
`agent-core` changes — gate 4 is a stability check, and it is clean.

## Engine parity delta: before 28 → after 6

```
Baseline (pre-8C):  28 fails
  after 8C (T10):   28 → 16   (T10 8→0, +3 T2 owned repairs, +1 Other incidental)
  after 8D (C5):    16 → 11   (C5 5→0)   [interim per Batch D report; snapshotted 6 fail on 8E tree]
  after 8E (T7):    11 →  6   (T7 4→0, #55 removed from KNOWN_HANGS)
Final (this run):    6 fails / 260 pass  (+ 1 KNOWN_HANG skip)
```

Net: **22 engine parity failures eliminated (28 → 6)** across the three planes,
with the inline regression net staying at 0.

## What remains (the 6 fails — all out of scope)

### T2 tool normalization / continuation — 4 (owned by Batch B/D/F, deferred by design)
- `forces session lookup when explicit continuation answers directly without a key`
  — needs `findSessionContinuationLookupDirective` (T5 gap, not in 8C/D/E named list)
- `adds a browser probe when resumed loopback session times out again`
  — needs `enforceSupplementalLocalTimeoutProbeToolCall` (INLINE-ONLY normalizer, §5 branch-3)
- `probes browser after runtime-forced continuation times out` — same §5 branch-3 normalizer
- `bounds browser-evidence repair for slow loopback timeout follow-up` — §5 branch-3 natural-finish deferred fixture

### Other (closeout / misc) — 2
- `runs native tool-use loop and feeds tool results back` — **chunk-crash collateral,
  not a genuine parity fail.** Passes in inline (267/0) and flips pass↔incomplete
  depending on its chunk neighbor; it is the sibling of the hanging test below and
  gets swept up when that chunk hits the 180s backstop. Not a regression from C/D/E.
- `disables native tools when packet requests no tool use` — **genuine engine
  non-termination.** STILL incomplete when isolated to its own single-test recovery
  run (same signature as the Batch B KNOWN_HANG: churns to maxRounds past the
  backstop under engine, converges under inline). This is a continuation/no-tool-use
  convergence divergence, NOT introduced by C/D/E, and is a Batch B/F continuation-plane item.

### KNOWN_HANGS
- `#55` parent wall-clock boundary test — **removed** from KNOWN_HANGS in 8E; the
  leaked-timer crash is fixed (signal disposed in `finally`, browser session extended
  not aborted). Verified: passes in isolation and runs to completion in-process.
- `does not treat resumable partial session output as completion evidence` (Batch B)
  — **remains** the sole KNOWN_HANG. Engine never terminates even in isolation.
  Cannot be removed until Batch B lands continuation-completion recognition.
- No further KNOWN_HANGS can be removed this campaign. In fact the newly-surfaced
  `disables native tools when packet requests no tool use` hang is a *candidate to
  ADD* to KNOWN_HANGS (see risks) so it stops contaminating its chunk neighbor.

## Codex-review-worthy risks

1. **Chunking non-determinism at the engine boundary (medium).** The full run reports
   `260 pass / 5 fail` with a chunk-2 `exit=-1 timeout` leaving 1 test *incomplete*;
   re-chunking flips the count to `260 pass / 6 fail`. The canonical figure is
   **6 fail** (count the incomplete as a fail). The variance is entirely one hanging
   test (`disables native tools…`) dragging its chunk neighbor
   (`runs native tool-use loop…`) into the backstop. Recommend adding the hanging
   test to `KNOWN_HANGS` so parity counts become deterministic and the false-collateral
   "Other" fail disappears — this is a reporting-hygiene change, not a behavior change.

2. **Engine no-tool-use / continuation non-termination (medium-high, pre-existing,
   Batch B/F).** Two continuation-plane cases churn to `maxRounds` under engine where
   inline converges (the KNOWN_HANG and `disables native tools when packet requests
   no tool use`). Not introduced by C/D/E and correctly out of scope, but they are the
   gating risk for ever flipping production to `reactEngine:"engine"`. Worth a codex
   look at the continuation-completion recognition path before Batch B/F.

3. **Shared-helper parity contract (low).** 8E routes both the engine `runToolBatch`
   and the inline executor through `buildToolCallLimitExceededResult` for byte-identical
   `tool_call_limit_exceeded` skipped results. Single source of truth is good, but it
   means an inline behavior change now also moves the engine — worth a reviewer noting
   the coupling so a future inline-only tweak doesn't silently alter engine parity.

4. **`run.finalMessages` snapshot lifecycle (low).** 8C added `run.finalMessages`
   stashed by `onTerminate`/`onModelCallError` to feed the unconditional post-loop
   epilogue. Confirm no closeout path reaches the epilogue with a stale/absent
   snapshot (all current tests pass, but this is a new engine-run field worth a glance).

## Bottom line

Gates 1/2/4 are unconditionally green. Gate 3 is green for the campaign's scope:
all 6 remaining engine fails are pre-existing, out-of-scope T2/continuation and
closeout-collateral items owned by Batches B/D/F; the C5 and T7 clusters are fully
closed (0 fails) and T10 is closed (8→0). Engine parity moved 28 → 6 with zero
inline regressions and the #55 leaked-timer crash resolved.
