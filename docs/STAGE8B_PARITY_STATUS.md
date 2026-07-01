# Stage 8B engine-parity status (engine mode)

Ran 250 test points: **227 pass / 23 fail**. 1 chunk(s) crashed; 0 test(s) incomplete.

> Batch E (Stage 8B — T7 execution budget/wall-clock plane) closed the 4 T7 fails AND resolved the #55 leaked-timer crash: the engine now caps per-turn calls in `runToolBatch` (`maxToolCallsPerRound`, emitting byte-identical `tool_call_limit_exceeded` skipped results via `buildToolCallLimitExceededResult`), truncates + carries the final-recovery tool budget across activations in `onToolCalls`/`onToolCallsClose`, blocks delegation after budget exhaustion with a tool-free re-prompt (`shouldRepairFinalRecoveryBudgetCloseout`), injects the final-tool-round warning and synthesizes at the `maxRounds+1` boundary (`round_limit` closeout with pending calls), and disposes the per-chunk wall-clock signal in `finally` + extends (never aborts) an active browser session past the parent budget so no long-lived timer leaks out to crash a later chunk. The `#55` test now passes in isolation AND runs to completion in-process, so it is removed from `KNOWN_HANGS`.
>
> Batch D (Stage 8B — C5 memory/compaction/envelope plane) closed the 5 C5 fails: the engine model-call wrapper now injects the final-tool-round warning, records the tool-result pruning/compaction boundary, carries the request-envelope reduction + pre-compaction memory-flush metadata forward from every tool round (not just synthesis), and stores tool-result trace content via the evidence-first compaction helper (`toNativeToolResultTrace`). Remaining fails are Batch B/F (tool-normalization/continuation, native-loop wiring).

Skipped 1 known engine crash/non-termination test(s):
- (Batch B) `does not treat resumable partial session output as completion evidence` — engine never terminates on this case even in isolation (churns to maxRounds past the 180s backstop) where inline converges — a continuation-plane convergence divergence; revisit once Batch B lands the continuation-completion recognition

## Fail clusters

### C5 memory / compaction / envelope — 0 (closed by Batch D)

### T7 execution budget / wall-clock — 0 (closed by Batch E; #55 leaked-timer crash also resolved)

### T10 browser / session finalization & visibility — 8
- llm role response generator keeps browser recovery visible after completed sub-agent synthesis
- llm role response generator keeps cold recreation visible from child final content
- llm role response generator does not treat generic recovery wording as cold session visibility
- llm role response generator keeps browser timeout recovery visible after completed sub-agent synthesis
- llm role response generator appends bounded browser limitation when completed evidence carries a CDP timeout bucket
- llm role response generator surfaces browser bucket visibility from raw session payload metadata
- llm role response generator does not treat generic unverified browser wording as detached-target closeout
- llm role response generator does not mark recovered browser evidence unverified for wait timeouts

### T2 tool normalization / continuation — 7
- llm role response generator forces session lookup when explicit continuation answers directly without a key
- llm role response generator repairs recovered slow-source finals that omit timeout follow-up guidance
- llm role response generator deterministically appends timeout follow-up continuation guidance when repair is ignored
- llm role response generator prefers explicit timeout closeout session over stale listed sibling
- llm role response generator adds a browser probe when resumed loopback session times out again
- llm role response generator probes browser after runtime-forced continuation times out
- llm role response generator bounds browser-evidence repair for slow loopback timeout follow-up

### Other (closeout / misc) — 4
- llm role response generator runs native tool-use loop and feeds tool results back
- llm role response generator disables native tools when packet requests no tool use
- llm role response generator does not report closeout evidence for failed-only tool rounds
- llm role response generator does not append recovered timeout closeout without raw timeout evidence

