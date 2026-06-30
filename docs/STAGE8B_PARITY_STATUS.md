# Stage 8B engine-parity status (engine mode)

Ran 250 test points: **185 pass / 65 fail**. 1 chunk(s) crashed; 0 test(s) incomplete.

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

### T10 browser / session finalization & visibility — 11
- llm role response generator does not continue explore sessions for rendered-browser recovery
- llm role response generator keeps browser recovery visible after completed sub-agent synthesis
- llm role response generator keeps cold recreation visible from child final content
- llm role response generator does not treat generic recovery wording as cold session visibility
- llm role response generator keeps browser timeout recovery visible after completed sub-agent synthesis
- llm role response generator appends bounded browser limitation when completed evidence carries a CDP timeout bucket
- llm role response generator surfaces browser bucket visibility from raw session payload metadata
- llm role response generator does not treat generic unverified browser wording as detached-target closeout
- llm role response generator does not mark recovered browser evidence unverified for wait timeouts
- llm role response generator keeps browser duplicate for bounded browser-visible timeout source
- llm role response generator keeps browser-visible loopback tasks on the browser path in fixture mode

### T2 tool normalization / continuation — 40
- llm role response generator routes continuation follow-up to timed-out session
- llm role response generator prefers resumable timeout session over later completed session on follow-up
- llm role response generator prefers timeout source session over later resumable browser sibling
- llm role response generator forces session lookup when explicit continuation answers directly without a key
- llm role response generator rewrites history lookup to sessions_send for resumable continuation
- llm role response generator recognizes verbatim latest user direction as session continuation
- llm role response generator prefers latest verbatim direction over original future follow-up text
- llm role response generator rewrites explicit continuation history reads to sessions_send
- llm role response generator repairs recovered slow-source finals that omit timeout follow-up guidance
- llm role response generator deterministically appends timeout follow-up continuation guidance when repair is ignored
- llm role response generator routes continuation follow-up to cancelled session
- llm role response generator routes explicit follow-up to completed session
- llm role response generator lists sessions before spawning on explicit follow-up without a session key
- llm role response generator continues failed source-check sessions found by session list
- llm role response generator drops same-round duplicate spawn when sending continuation
- llm role response generator allows a new spawn after an empty continuation session lookup
- llm role response generator drops same-round duplicate spawn when listing continuation sessions
- llm role response generator routes follow-up through sessions_list result before duplicate spawn
- llm role response generator routes listed follow-up local fetch through sessions_send
- llm role response generator normalizes session update aliases into sessions_send
- llm role response generator prefers the subject-matched completed session for continuation
- llm role response generator prefers earliest completed session for previous-thread continuation ties
- llm role response generator lists sessions before trusting model-provided continuation keys without a directive
- llm role response generator does not continue completed sibling when timeout-like follow-up lacks timeout result JSON
- llm role response generator prefers explicit timeout closeout session over stale listed sibling
- llm role response generator adds a browser probe when resumed loopback session times out again
- llm role response generator probes browser after runtime-forced continuation times out
- llm role response generator refreshes stale session list when timeout follow-up only has truncated source key
- llm role response generator forces continuation after list resolves a truncated timeout key
- llm role response generator routes follow-up when completed session result is wrapped in tool trace content
- llm role response generator normalizes noisy session_key inputs before execution
- llm role response generator canonicalizes abbreviated continuation session keys from context
- llm role response generator canonicalizes ellipsized continuation session keys from context
- llm role response generator reroutes private URL research spawns to browser
- llm role response generator reroutes loopback web_fetch calls to browser sessions
- llm role response generator reroutes non-browser bounded timeout source spawns to explore
- llm role response generator reroutes browser-visible public URL spawns to browser
- llm role response generator keeps private non-loopback URLs on the browser path in E2E fixture mode
- llm role response generator reroutes link-local and wildcard URL research spawns to browser
- llm role response generator rewrites slow-source recovery spawn to existing timeout session send

### Other (closeout / misc) — 5
- llm role response generator runs native tool-use loop and feeds tool results back
- llm role response generator disables native tools when packet requests no tool use
- llm role response generator does not report closeout evidence for failed-only tool rounds
- llm role response generator does not append recovered timeout closeout without raw timeout evidence
- llm role response generator ignores nested completed status when session result failed

