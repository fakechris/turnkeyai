# Compaction And Checkpoint Invariant Slice

Status: implementation contract for V2 migration step 6. Baseline:
`d96410a4`.

## Objective

Align every active production compaction/checkpoint path with the simulator's
protocol-unit and committed-frame laws. This slice changes no threshold,
summary prompt, token estimate, model profile, or acceptance behavior.

## Audited Gaps

1. `CompactionController` already refuses an incomplete assistant/tool unit,
   but the older gateway history compactor can summarize an unsafe unit when
   message or byte caps are exceeded.
2. Forced checkpoint output is cached for the next round by source message
   count only. A same-length but changed source prefix can receive a stale
   checkpoint.
3. `RunJournal` persists an atomic whole-record checkpoint, which is equivalent
   to a committed frame, but it does not reject a state containing an incomplete
   provider tool protocol unit on write or restore.

## Required Changes

- all compaction paths fail open on size but fail closed on protocol: an unsafe
  tool unit remains raw and may cause a bounded envelope error, but is never
  deleted or summarized;
- pending forced compaction carries a deterministic source-prefix digest and is
  applied only to that exact prefix;
- journal checkpoint/complete reject protocol-unsafe messages before writing;
- journal restore ignores a protocol-unsafe stored snapshot;
- typed checkpoint summaries remain model-facing projections, not authoritative
  facts. Existing typed plan-state replacement remains unchanged.

## Required Counterexamples

- one assistant call with no matching result survives gateway history caps;
- a result with no matching call is never retained after its call is removed;
- a forced compaction cannot attach to a changed same-length transcript;
- an exact forced-compaction source prefix still applies once;
- an unsafe journal state is neither persisted nor restored;
- valid atomic file-backed checkpoints still restore after restart;
- compaction never changes effect-ledger receipts, TaskFacts, or plan state.

## Scope Control

Forbidden in this slice: policy migration, prompt changes, model-generated fact
promotion, threshold tuning, E2E changes, and real-model-driven patches.

## Exit Criteria

- production and simulator protocol laws are represented by equivalent
  counterexamples;
- compaction, tool-history, run-journal, deterministic package, simulator, and
  policy inventory suites are green;
- exact results are recorded before policy-row migration starts.

## Implemented Result

- `compactOlderToolHistoryForGateway` now preserves the complete source
  transcript whenever any tool protocol unit is incomplete or orphaned;
- forced checkpoint adoption is bound to a SHA-256 digest of the exact source
  prefix, so a same-length mutation cannot receive stale compacted state;
- `RunJournal` validates complete tool protocol units before checkpoint and
  completion writes, and ignores an unsafe stored snapshot during restore;
- valid file-backed checkpoints still use the existing atomic whole-record
  projection as their committed-frame boundary;
- typed plan-state replacement, model-facing checkpoint summaries, thresholds,
  prompts, and token estimation are unchanged.

Final deterministic results on Node.js `v24.14.0`:

- `npm run typecheck`: pass;
- agent-core: 64/64;
- llm-adapter: 60/60;
- react-engine, including the new journal/compaction counterexamples: 389/389;
- response-generator and tool-use: 315/315;
- operation timeout, attempt deadline, session protocol, sub-agent runtime, and
  browser timeout support suites: 98/98;
- complete team-runtime suite: 103/103;
- complete team-store suite: 75/75;
- mission bridge, mission route, and durable inbox architecture suites: 109/109;
- focused compaction, gateway history, microcompaction, and journal suites:
  46/46;
- execution-semantics simulator: 17/17, including 10,000 generated budget
  compositions and 5,000 generated effect crash windows;
- runtime-policy inventory/disposition: 2/2;
- `git diff --check`: pass.

All final gates were run serially to avoid event-loop contention in existing
wall-clock tests. No real model, fixture, prompt, threshold, or acceptance code
participated in this slice.
