# Stage 8B engine-parity status (engine mode)

Ran 250 test points: **222 pass / 28 fail**. 1 chunk(s) crashed; 0 test(s) incomplete.

Skipped 2 known engine crash/non-termination test(s):
- (Batch E) `does not abort active browser sessions at the parent wall-clock boundary` — engine does not abort/tear down the active browser session at the parent wall-clock boundary; its leaked timer crashes the run (#55)
- (Batch B) `does not treat resumable partial session output as completion evidence` — engine never terminates on this case even in isolation (churns to maxRounds past the 180s backstop) where inline converges — a continuation-plane convergence divergence; revisit once Batch B lands the continuation-completion recognition

## Fail clusters

### C5 memory / compaction / envelope — 5
- llm role response generator retries with a smaller request envelope after overflow
- llm role response generator flushes memory once before request-envelope reduction
- llm role response generator prunes older oversized tool results before later rounds
- llm role response generator compacts older tool history before message-count overflow
- llm role response generator stores evidence-first trace content for oversized session results

### T7 execution budget / wall-clock — 4
- llm role response generator synthesizes instead of falling back when tool round limit is reached
- llm role response generator carries final recovery tool budget across activations
- llm role response generator blocks delegation after final recovery budget is exhausted
- llm role response generator skips per-turn tool calls above the execution cap

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

