# Stage 8B engine-parity status (engine mode)

Ran 266 test points: **260 pass / 6 fail**. 1 chunk(s) crashed; 0 test(s) incomplete.

Skipped 1 known engine crash/non-termination test(s):
- (Batch B) `does not treat resumable partial session output as completion evidence` — engine never terminates on this case even in isolation (churns to maxRounds past the 180s backstop) where inline converges — a continuation-plane convergence divergence; revisit once Batch B lands the continuation-completion recognition

## Fail clusters

### T2 tool normalization / continuation — 4
- llm role response generator forces session lookup when explicit continuation answers directly without a key
- llm role response generator adds a browser probe when resumed loopback session times out again
- llm role response generator probes browser after runtime-forced continuation times out
- llm role response generator bounds browser-evidence repair for slow loopback timeout follow-up

### Other (closeout / misc) — 2
- llm role response generator runs native tool-use loop and feeds tool results back
- llm role response generator disables native tools when packet requests no tool use

