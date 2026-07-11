# Stage 9 Runtime Foundation Landing Report

Date: 2026-07-11

Branch: `codex/stage9-landing`

Base: `origin/main` at `e6732957` (`Stage 8 engine architecture closeout`)

## Landing Decision

This branch is a clean reconstruction of Stage 9 from `origin/main`. It is not
a squash of the 112-commit convergence branch.

The landing goal is intentionally limited: make the runtime control plane
materially stronger than main without treating stochastic real-model output as
a production-code patch trigger. It does not claim that every natural-language
acceptance scenario is solved.

## What Lands

- ReAct engine as the single role-runtime execution path; the inline escape
  path and parity script are retired.
- Typed transient retry and provider error handling.
- Anthropic-compatible and OpenAI-compatible streaming parsers, provider
  activity reporting, prompt-cache accounting, and token estimation.
- One absolute role-run deadline propagated through model and foreground tool
  work.
- Token-aware request budgets, tool-result externalization, deterministic
  microcompaction, typed checkpoint compaction, and a compaction failure
  circuit.
- Durable run journal, restart resume, RunTrace, and zero-provider replay.
- Explicit persisted background worker sessions, independent child deadlines,
  restart reconciliation, idempotent completion delivery, fan-in, and durable
  continuation across flows.
- Process-level crash tests and a 64-round context/replay stress gate.
- Deterministic follow-up fixes for replay inputs, timeout state, provider
  interruption state, lifecycle record identity, worker completion fan-in, and
  partially written worker-session indexes.

## What Was Excluded

- Twenty-six convergence-iteration reports and the old 3/3 completion rule.
- Stage 9 implementation plans under `docs/superpowers`.
- Real-LLM-driven mission evaluator, prompt, source-label, operation-label,
  role-mention, and terminal-fallback patches after the audited foundation.
- Mixed post-foundation commits that could only be applied together with new
  task-language detectors.
- Any new fixture literal, scenario-specific closeout, scorer relaxation, or
  harness relaxation.

The source convergence branch remains available for investigation, but its
acceptance campaign is not part of this landing line.

## Improvement Over Main

Main has the Stage 8 policy ownership split, but it does not have the complete
Stage 9 execution control plane. This branch adds bounded termination,
streaming activity, token-pressure handling, durable restart state,
background-child ownership, and deterministic crash replay while preserving
the Stage 8 dependency guards.

The improvement claim is deterministic and structural:

- interrupted work is observable and replayable;
- long loops have bounded context and wall-clock behavior;
- completed side effects are not repeated after a tested crash boundary;
- background work survives normal parent completion and is reconciled after
  restart;
- oversized tool history can leave the model context without losing evidence.

It is not a claim that MiniMax always selects the desired tool or produces a
perfect final answer.

## Verification

All commands used Node 24.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test -- --runInBand` | 2873 passed, 0 failed, 1 skipped |
| architecture guard | 61 passed, 0 failed |
| runtime chaos / 64-round stress | pass (included in full suite) |
| `npm run build` | pass |
| `npm run control-center:smoke` | pass, desktop and mobile screenshots produced |
| release readiness | 8/8 checks passed |
| `git diff --check origin/main...HEAD` | pass before this documentation-only commit |

No real LLM call was made while constructing this branch. No branch was
pushed.

## Remaining Backlog

- Measure model/tool-selection reliability on immutable commits and report
  rates rather than requiring consecutive passes.
- Consider a durable lifecycle outbox if strict write-ahead telemetry is
  required when the observability store hangs.
- Benchmark canonical worker-session index reconciliation at production scale.
- Measure compaction frequency and evidence retention in real long-context
  workloads.
- Promote repeated quality/evidence disagreements only after a generic typed
  invariant can be reproduced deterministically.

These items are independent reliability work, not Stage 9 landing blockers.
