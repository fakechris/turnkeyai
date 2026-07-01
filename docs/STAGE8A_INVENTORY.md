# Stage 8A Inventory — Inline Response Generator → Engine Cutover

Source of behavior rows: classified inline-response-generator audit (Stage 8A).
Source of empirical parity: `npm run parity:engine` (`scripts/engine-parity-check.ts`, chunked + recovery + force-exit runner, Batch A) → `docs/STAGE8B_PARITY_STATUS.md`. The original capped probes (`/tmp/stage8a-full.txt`, `/tmp/stage8a-probe.txt`) are superseded — they only reached subtest 54 before the engine wall-clock crash; the runner now runs the whole suite to completion.

> Closeout / repair **precedence** in this document is transcribed verbatim from the rows. It is the single most bug-prone surface in this codebase — do not reorder when extracting into 8C–8I.

---

## 1. Parity Dashboard (engine = `TURNKEYAI_REACT_ENGINE=engine`)

**Probe status: COMPLETE (Batch A).** The chunked runner (`npm run parity:engine`) now runs the whole suite to completion and writes `docs/STAGE8B_PARITY_STATUS.md`. The original probe was only partial (stalled at subtest 54 on the engine wall-clock crash); these are the first authoritative full-suite numbers.

| Metric | Value |
|---|---|
| Inline behavior tests (baseline, `npm run parity:inline`) | **272 pass / 0 fail** (grew from 252 as each batch added grouped parity + golden-order tests) |
| Engine tests run to completion | **272** (0 skipped) |
| Pass on engine | **185** (A) → **222** (B) → **260** (C/D/E) → **270** (final-parity) → **272** (structural fixes) |
| Fail on engine | **65** (A) → **28** (B) → **6** (C/D/E) → **2** → **0** ✅ |
| Incomplete after recovery | **0** |
| Skipped | **0** |

**Full engine parity reached: `npm run parity:engine` = 272 pass / 0 fail / 0 skip, all 14 chunks complete.** Production stays `reactEngine: "inline"` behind the flag; no default flip yet.

**Harness note.** Before the Batch E fix a single-process engine run died after ~54 tests because a leaked browser-session timer crashed whatever test was executing when it fired. The runner still executes the suite in small fresh-process chunks (so any future leak at most kills one chunk), force-exits each chunk, applies a per-test timeout, reaps the process group on an OS backstop, and re-runs any unreported test individually to recover blameless neighbours and isolate a crasher.

### The last two fails — closed by two small structural fixes (not architecture extraction)

| Fail | Root cause (instrumented) | Fix |
|---|---|---|
| `runs native tool-use loop and feeds tool results back` | Observability was split across three sinks (toolTrace, native tool messages, runtimeProgressRecorder) and the engine's event-consumer never emitted the tool lifecycle to `runtimeProgressRecorder` (`progressEvents=0`); metadata lacked `modelUse`. The "hang" was the empty `assert.ok` throwing while engine async was pending — NOT a modelUse serialization problem. | **Observability bridge**: `tool_started`/`tool_result` also call `recordToolProgressSafely`; `onAfterExecuteContinue` emits the provider-tool-protocol round (inline `:1704`); metadata gets `modelUse` (inline `:2478`). Unified event → all sinks. |
| `bounds browser-evidence repair for slow loopback timeout follow-up` | Gateway call-by-call trace: inline makes 6 model calls, engine made 5. A completed-cascade repair re-synthesis returned a TOOL CALL on the tc=none synthesis round; inline **re-enters its main loop** for one more clean synthesis, the engine's `onTerminate` simulation stopped and used the tool-call artifact text. | **Minimal completed-cascade re-entry**: after the repair loop, if the last synthesis carries tool calls, run one clean `generateFinalAfterToolRoundLimit` pass (inline's trailing synthesis). No policy registry, no loop restructure — just stop the terminal simulation from emitting a tool-call artifact. |

**DONE on the engine path — full parity.** Merged #515–#526 plus Batches A–E, the codex-boundary P2 fixes, the T2 continuation-plane batch, the no-tool-use routing fix, the resumable-partial convergence, and the two structural fixes above (observability bridge + completed-cascade re-entry). Engine parity: **65 → 0 fails, 0 skips, all chunks complete. Inline 272/272.**

---

## 2. Behavior Inventory Table (all rows, grouped by target layer)

> Rows that describe the same behavior across regions are merged. The most-merged case is `shouldRepairMissingApprovalGate` (post-execute `:1672` + natural-finish `:807` + completed-closeout `:804–828`) and `enforceMissingApprovalGateRepairToolCalls` (inline `:474` + engine `:2546`).

### T0-controller

| behaviorName | inlineLocation | trigger | action | precedence | engineStatus | regex? | typedFactsNeeded | relatedTests | notes |
|---|---|---|---|---|---|---|---|---|---|
| missionTerminalStatusForCloseout mapping | :111-130 | buildRuntimeDerivedMissionReport calls after loop exit | map closeout.reason → MissionTerminalReport.status (completed→completed; budget/limit/timeout/inspection/continuation/fallback/pseudo→evidenceAvailable?partial:blocked; cancelled/repeated_failure/recovery→blocked) | applied to all closeouts once determined | in_engine | no | none | — | exhaustive mapping; only completion = success |
| buildRuntimeDerivedMissionReport assembly | :89-109 | end of generate() when toolLoopCloseout set | build MissionTerminalReport {status, reason, source:runtime_derived}, omit authorizedPartial (fail-closed) | final step before return | in_engine | no | none | — | authorizedPartial explicitly NOT set (fail-closed :94-103) |

### T1-context

| behaviorName | inlineLocation | trigger | action | precedence | engineStatus | regex? | typedFactsNeeded | relatedTests | notes |
|---|---|---|---|---|---|---|---|---|---|
| buildContinuationDirectiveContext | ~9561 | onEveryRound after model text (inline :451; engine onRoundEmpty :2496, onAfterExecuteContinue :2909) | filter tool-result messages with `session_key`/`"sessions"`; concat taskPrompt + evidence text → merged context string | before findSessionContinuationDirective(context) | in_engine | yes | typed tool results (parseSessionToolResult avail); select by structured session-tool type, not text filter | context-includes/omits session results | synthetic context string works around lack of structured session state; called :451,469,622,909,1309,2496 |

### T2-normalizer (tool-call normalization pipeline, inline :473–538)

| behaviorName | inlineLocation | trigger | action | precedence | engineStatus | regex? | typedFactsNeeded | relatedTests | notes |
|---|---|---|---|---|---|---|---|---|---|
| enforceSupplementalLocalTimeoutProbeToolCall | :473-484 | latest msg includes 'Runtime correction: resumed timeout evidence is still content-poor' AND toolCalls>0 | rewrite all pending calls → single sessions_spawn (supplemental probe task + URL + bounded timeout_seconds) | 2nd in pipeline (after enforceMissingApprovalGate, before applySessionContinuationDirective :489) | gap | yes | structured 'resumed timeout evidence' status field (now text-detected) | test:24316 | keys on hardcoded repair-prompt string; engine path does not call this normalizer |
| enforceMissingApprovalGateRepairToolCalls | :474-481 (engine onToolCalls :2546) | repairMarkers has missing-approval-gate prompt AND approval-gated browser task AND no permission evidence AND no permission_query pending | rewrite pending → [buildPermissionQueryFromBrowserSpawn()] OR keep if guard fails | 1st in nested wrapping :474; engine :2546-2551 | in_engine | yes | approval-gate-repair-applied flag in RepairLedger; typed permission facts in toolTrace (now regex `permission_(?:query\|result\|applied)`) | test:24471 (comment) | prevents approval-gate bypass; runs both inline & engine |
| normalizeSessionToolAliasCalls | :475 | toolCall.name in SESSION_SEND_ALIAS_NAMES | map alias → sessions_send + extract session_key/message from variously-named fields | innermost initial wrapping :475 | gap | no | none (schema-only) | — | inline-only; pure schema rewrite |
| applySessionContinuationDirective | :489 and :507 (called twice) | sessionContinuationDirective!=null AND toolCalls>0 | merge directive.sessionKey into sessions_send (filter spawn/history/list) OR rewrite first spawn/history/list → sessions_send | 1st explicit step :489; AGAIN after normalizeApprovalGatedBrowserSpawnCalls :507 | gap | no | SessionContinuationDirective (already structured) | — | called twice to re-apply after other normalizers; inline-only |
| applySessionContinuationLookupDirective | :490 | sessionContinuationLookupDirective!=null AND toolCalls>0 | route to sessions_list (from send/spawn) OR filter spawn/send if list exists | 2nd step :490 | gap | no | SessionContinuationLookupDirective (already structured) | — | inline-only |
| normalizeExplicitContinuationHistoryCalls | :491 | taskPrompt explicit continuation (continue/resume/retry + existing/same/previous OR requestsTimeoutFollowupContinuation) AND not transcript request | sessions_history → sessions_send w/ merged or default 'Continue this existing sub-agent session' | 3rd step :491 | gap | yes | continuation-intent fact from TaskFacts (now regex on taskPrompt) | — | inline-only; regex follow-up intent |
| normalizeSessionToolCalls | :492 | sessions_send/sessions_history AND session_key matches known worker pattern AND resolvable | normalize session_key via extractWorkerSessionKey + resolveKnownWorkerSessionKey | 4th step :492 | gap | no | known-session-keys from SessionContinuationState (now string parse) | — | inline-only |
| normalizePrivateUrlResearchSpawnCalls | :493-497 | browserAvailable AND sessions_spawn AND agent_id='explore' AND private/loopback URL OR toolCallTargetsBrowserRequiredUrl | rewrite agent_id explore→browser OR skip if loopback read-only (allowsLoopbackExploreForE2E) | 5th step :493-497 | gap | yes | URL classification (private/loopback/public); browser-required-URL fact (now containsPrivateOrLoopbackHttpUrl + toolCallTargetsBrowserRequiredUrl) | — | inline-only; E2E loopback exception |
| normalizeLocalUrlWebFetchCalls | :498 | web_fetch AND private/loopback HTTP URL | web_fetch → sessions_spawn agent_id='browser' label='local-url-fetch' | 6th step :498 | gap | yes | URL classification (now containsPrivateOrLoopbackHttpUrl + extractHttpUrls) | — | inline-only |
| normalizeBoundedTimeoutSourceSpawnAgents | :499-503 | exploreAvailable AND looksBoundedTimeoutSourceCheck AND sessions_spawn agent_id='browser' AND HTTP URL AND browserRequired fails | rewrite browser→explore OR skip if browser-required | 7th step :499-503 | gap | yes | browser-required-URL fact (taskRequiresBrowserEvidence + toolCallTargetsBrowserRequiredUrl); timeout-source classification | — | inline-only; pattern 'bounded attempt\|slow-source\|timeout\|timed out' + URLs |
| normalizeBoundedTimeoutDuplicateSourceSpawns | :504-506 | looksBoundedTimeoutSourceCheck AND multiple sessions_spawn same normalized URL | keep 1 spawn/URL (highest score), drop duplicates | 8th step :504-506 | gap | yes | URL dedup (extractHttpUrls + normalizeUrlForComparison); browser-required scoring | — | inline-only |
| normalizeApprovalGatedBrowserSpawnCalls | :508-512 (engine onToolCalls :2542-2557, narrower) | sessions_spawn agent_id='browser' AND looksApprovalGatedBrowserSideEffect AND mutating AND not already-applied AND no permission evidence AND no permission_* pending | insert buildPreApprovalBrowserInspectionSpawn + buildPermissionQueryFromBrowserSpawn OR filter duplicate browser spawns | 9th step :508-512; engine onToolCalls only runs enforceMissing + limitIndependent | **partial** | yes | approval-gated-action + mutating-action classification; typed permission evidence from EvidenceLedger | test:24235 (comment, engine mirrors at :513) | **safety invariant: permission_query must inject pre-execute.** Full normalization is inline-only; engine subset only |
| limitIndependentEvidenceSpawnCalls | :513-516 (engine onToolCalls :2552-2555) | inferIndependentEvidenceStreamCount>=2 AND multiple sessions_spawn AND completed<required | keep first N=required-completed spawns; drop excess | 10th step :513-516; engine :2552 | in_engine | yes | evidence-stream-count fact; completed-session count from typed EvidenceLedger | test:24316 (comment) | runs both inline & engine |

### T4-permission

| behaviorName | inlineLocation | trigger | action | precedence | engineStatus | regex? | typedFactsNeeded | relatedTests | notes |
|---|---|---|---|---|---|---|---|---|---|
| shouldSuppressReadOnlyPermissionQueryToolCalls | :520-523 | activeToolLoop AND permission_query pending AND (isSourceBackedReadOnlyTask OR isClearlyUnrequestedReadOnlyPermissionQuery OR disclaimsIntendedBrowserMutation) | append assistant text + buildReadOnlyPermissionQuerySuppressionPrompt; nextToolChoice='none'; force tool-free round | 11th check :520-523 (not a normalizer) | gap | yes | read-only-vs-mutation TaskFacts; mutation-intent classification (now isSourceBackedReadOnlyTask + disclaimsIntendedBrowserMutation + isClearlyUnrequestedReadOnlyPermissionQuery) | — | inline-only; needs T4 + T9 to port. **Drives fails 13/14/15** |
| latestPermissionToolName | ~8615 | permission state detection | scan toolTrace backward for name startsWith 'permission_'; return name or null | approval repair checks :1115,1140,8639; guards :1599 | in_engine | no | structured tool name (direct lookup) | latest permission tool detected | hasPermissionAppliedEvidence/latestPermissionResultStatus built on this |

### T2/T4 combined routing (also normalizer pipeline)

*(`normalizePrivateUrlResearchSpawnCalls`, `normalizeLocalUrlWebFetchCalls`, `normalizeApprovalGatedBrowserSpawnCalls` are listed under T2 above; they carry secondary T4 local/private-URL & approval gating.)*

### T3-evidence

| behaviorName | inlineLocation | trigger | action | precedence | engineStatus | regex? | typedFactsNeeded | relatedTests | notes |
|---|---|---|---|---|---|---|---|---|---|
| parseSessionToolResult | session-tool-result-protocol.ts:131 | every sessions_spawn/send/history result | JSON.parse → validate protocol → SessionToolResultV1 typed struct or null | foundational parser for all evidence extraction | in_engine | no | already fully typed SessionToolResultV1 (target-state, no regex debt) | protocol validation; legacy normalization; field extraction | exports normalizeSessionToolResult / normalizeLegacySessionToolResult |
| findSubAgentToolTimeout | ~6069 | post-execute after spawn/send | parse result → status==='timeout'; return {toolName,sessionKey,agentId,timeoutSeconds,evidenceAvailable} | onAfterExecute :3185, onAfterExecuteContinue :2979 | in_engine | no | parseSessionToolResult typed (.status/.timeout_seconds/.evidence_available); no regex debt | timeout signal extracted; evidenceAvailable set; timeout before completion | evidence_available = parsed flag OR evidence_summary string fallback |
| findCompletedSessionEvidence | ~6099 | post-execute after spawn/send/history | parse → status==='completed'; collect finalContents[], browserRecoverySummaries[] | post-execute completed_sub_agent_final :1560; gates :1603-1712 cascade | in_engine | yes | final_content/final_contents typed; **browserRecoverySummaries via readInlineBrowserRecoverySummary regex on evidence text** — needs structured payload field | completed evidence collected; recovery summary extracted; empty→null | readBrowserRecoverySummary (structured) vs readInlineBrowserRecoverySummary (regex debt) |
| canonicalizeSessionToolTraceCalls | ~5801 (inline :1540) | post-result recording | compare trace calls vs parsed result.session_key; rewrite call.input to match | after execution, before compact/finalization | **partial** | no | parseSessionToolResult typed; direct field compare; inline-only, not wired into engine | session_key normalized; unmodified when match | inline-only trace normalization not ported to engine |
| hasCompletedBrowserSessionEvidence | ~11244 | browser-evidence repair predicates :1153,:3232 | scan toolTrace for completed browser sessions w/ readCompletedSessionEvidence truthy | gates shouldRepairMissingBrowserEvidence :1153, dimensions :1190 | in_engine | no | typed agent_id/status/final_content; readCompletedSessionEvidence should use final_content exclusively (has text fallback) | detection true/false | hasAttemptedBrowserSessionEvidence :11268; contextHasBrowserSessionAttempt :11293 (text fallback) |
| collectSourceBoundedEvidenceText | ~7024 | natural-finish repair :1202 + completed-closeout | concat collectNativeToolTraceEvidenceText + extractSourceBoundedEvidenceSnippets + msg evidence; filter looksLikeSourceBoundedEvidenceLine | shouldRepairWeakEvidence :1202,:1231 | gap | yes | typed source-evidence flags / EvidenceLedger marker; extractSourceBoundedEvidenceSnippets :7044 + looksLikeSourceBoundedEvidenceLine :7062 are regex | bounded evidence extracted; deduped | evidence formula for weak/source repairs |
| extractSessionToolResultRecords | ~10259 | continuation directives needing session enumeration | regex-extract JSON objects w/ session_key+status from context text → records[] | helper for directives :9360,9610,9635,9640 | gap | yes | parseSessionToolResult on each result instead of JSON.parse; structured toolTrace as primary source | records extracted; invalid JSON skipped | regex-debt fn; replace with structured evidence ledger in 8C |
| looksLikeSourceBoundedEvidenceLine | ~7062 | line-by-line during source evidence collection | regex match scope-disclaimer OR evidence-line OR Chinese scope markers | filters source evidence :7052 | gap | yes | structured producer scopeRestrictions field; replace 50+ alternation regex | scope-limited lines / evidence lines detected | primary regex-debt target for 8C |
| completed_product_brief_evidence_text_round_0_formula | :1933-1938 (engine :3693-3705) | round 0 completed-cascade evidence selection | assemble finalContents.join() + collectToolResultContentText(completedSessionToolResults) — completing-round results only | evidence prep; affects source/timeout/weak (round 0) | in_engine | no | structuredToolResultContentText per-round from EvidenceLedger | parity round-0 formula | byte-for-byte parity; round-0 vs round-gt0 asymmetry is the 'evidence formula residual' |
| source_bounded_evidence_text_round_gt0_formula | :1192 (engine :3829-3838) | round>0 repair, natural-finish formula | recompute sourceBoundedEvidenceText via collectSourceBoundedEvidenceText (full toolTrace) | evidence prep round>0; affects source/weak | in_engine | no | EvidenceLedger.sourceLabels per round | parity round-gt0; evidence-formula-residual-closed | closes residual: label only in full toolTrace visible on re-synthesis |

### T5-continuation

| behaviorName | inlineLocation | trigger | action | precedence | engineStatus | regex? | typedFactsNeeded | relatedTests | notes |
|---|---|---|---|---|---|---|---|---|---|
| shouldSuppressToolsForAwaitingContextSetup | :1013-1034 (hook onSuppressToolCalls :2639-2664) | activeToolLoop AND taskPromptRequestsAwaitingContextSetup (acknowledge + continue/resume, no research) | suppress execution; append text + buildAwaitingContextSetupNoToolRepairPrompt; nextToolChoice='none' | T5 setup, before execution; idempotent via repairMarkers | in_engine | yes | TaskPhase enum AWAITING_CONTEXT_SETUP / TaskFacts.isSetupOnly | engine setup-only suppresses tools; awaiting-context idempotency | predicate :7870-7898 (regex :7881-7897) |
| shouldContinueTimedOutApprovedBrowserSession | ~1564 (engine :2982) | findSubAgentToolTimeout signal AND agentId='browser' AND !hasApprovedBrowserTimeoutContinuationPrompt AND isAppliedApprovalBrowserContinuation | append_prompt + force_tool_choice(sessions_send) | 1st post-execute continuation | in_engine | yes | timeout_signal.agentId, approval_status structured; isAppliedApprovalBrowserContinuation `\bapproval\b`/`\bbrowser\b` regex | — | engine mirrors inline :2982 |
| shouldContinueTimedOutSiblingSession | ~1585 (engine :3004) | findSubAgentToolTimeout AND sessionKey AND !hasExecutedSessionsSend AND !hasCoverageTimeoutContinuationPrompt AND isCoverageCriticalDelegationTask | append_prompt + force_tool_choice(sessions_send) | 2nd post-execute continuation | in_engine | yes | isCoverageCriticalDelegationTask regex (`do not finalize until`, `all (three\|3\|N) (child session\|sources\|evidence streams)`) → structured task fields | — | engine mirrors :3004. **(Stage 7 branch-2 deferred fixture — see §5)** |
| shouldRunSupplementalLocalTimeoutProbe | ~1605 (engine :3030) | completedSession AND !hasSupplementalLocalTimeoutProbePrompt AND hasSessionTimeoutEvidence AND mentionsTimeout AND looksBoundedTimeoutSourceCheck AND isContentPoorTimeoutEvidence AND !explicitlyDisallowsBrowserEvidence AND loopback URL | append_prompt + force_tool_choice(sessions_spawn) | 3rd post-execute continuation | in_engine | yes | timeout/recovery/content-poor markers → structured completed-session evidence fields | — | heavy regex debt; allowsSupplementalBrowserProbe checks capability regex. **(Stage 7 branch-3 deferred fixture — see §5)** |
| findIncompleteApprovedBrowserSession | ~1627 (engine :3053) | completedSession AND !hasIncompleteApprovedBrowserSessionContinuationPrompt AND requestsApprovalGatedBrowserAction AND permission applied AND status completed AND agent browser AND INCOMPLETE_APPROVED_BROWSER_ACTION_PATTERNS | append_prompt + force_tool_choice(sessions_send) | 4th post-execute continuation | in_engine | yes | INCOMPLETE_APPROVED_BROWSER_ACTION_PATTERNS → structured incomplete_action field on result | — | parseSessionToolResult then regex fallback on evidence text |
| shouldContinueIndependentEvidenceStreams | ~1648 (engine :3080) | completedSession AND !hasIndependentEvidenceStreamContinuationPrompt AND inferIndependentEvidenceStreamCount>=2 AND completed<required | append_prompt + force_tool_choice(sessions_spawn) | 5th post-execute continuation | in_engine | yes | inferIndependentEvidenceStreamCount regex (`(three\|3) independent evidence streams`) + isTwoSourceComparisonTask → structured task field | — | limitIndependentEvidenceSpawnCalls caps spawns to remaining |
| findSessionContinuationDirective | ~9342 (engine onRoundEmpty :2501) | activeToolLoop AND taskPrompt continuation markers OR forced slow-source recovery | extract session_key from extractSessionToolResultRecords; rank by sessionToolResultContinuationPriority; return {sessionKey,messageHint} | first directive check :262,:457; before empty-round injection :567 | in_engine | yes | session_tool_result.v1 fields present; **priority ranking regex on taskPrompt + 'System recovery:' markers** → typed continuation-intent in RolePromptPacket | continuation directive selection; session key resolution; truncated-timeout rejection | depends on extractSessionToolResultRecords + extractLatestUserContinuationText |
| findSessionContinuationLookupDirective | ~9512 | activeToolLoop AND !directive AND !probePending AND continuation-looking taskPrompt; guarded by contextHasSessionListResult | inject sessions_list lookup; return {messageHint} or null | fallback to directive :468; feeds applySessionContinuationLookupDirective :490 | gap | yes | continuation-intent field; structured session list result; needs onRoundEmpty/onRoundMessages extension | lookup when list exists; lookup suppression when direct avail | lookup injection :588-605 not ported to engine |
| hasExecutedSessionsSend | ~11526 | pre-execution when empty-round continuation pending | scan toolTrace for prior sessions_send to same sessionKey → boolean | guards empty-round injection :571, continuation comp :509 | in_engine | no | structured toolTrace (direct field access, no regex) | no duplicate send; injection allowed when not yet sent | uses readStringInput :11599 |
| hasLatestSupplementalLocalTimeoutProbePrompt | ~6649 (engine :2493) | per-round before computing directives | latest msg role='user' && includes('Runtime correction: resumed timeout evidence is still content-poor.') | gates directive recompute :450; suppresses directives :456,464 | in_engine | yes | structured probeIsPending field; current = literal string match | probe prompt detection; continuation blocked when pending | hardcoded literal; enforceSupplementalLocalTimeoutProbeToolCall :6667 rewrites when pending |
| shouldForceSlowSourceRecoveryContinuation | ~9548 | user did not ask to continue but recovery context detected | regex `System recovery: ... required goal slots` AND taskPromptLooksLikeSourceCheckContinuation AND contextHasTimeoutSessionResult | fallback for findSessionContinuationDirective | in_engine | yes | structured run reason 'recovery_mode' / 'required_goal_slots_unsatisfied'; explicit continuation-intent field | forced continuation in recovery; no force when not recovery | text-pattern inference |
| isExplicitSessionContinuationRequest | :9346,9353,9517,etc | before extracting directives | regex continue/resume/retry/recheck etc AND NOT ending/done/stop | gate for all directive extraction | in_engine | yes | user-continuation-intent field (continue/resume/none) in task/packet | explicit continuation detected; no false positive from 'done' | overly permissive regex; belongs in T1 task-parsing |

### T8-closeout

> See §6 for the canonical precedence registries. Table below covers metadata/synthesis behaviors.

| behaviorName | inlineLocation | trigger | action | precedence | engineStatus | regex? | typedFactsNeeded | relatedTests | notes |
|---|---|---|---|---|---|---|---|---|---|
| recovery_tool_budget (closeout #1) | :539,:611-618,:1390 (engine :2706-2727) | activeToolLoop AND recoveryToolBudget AND toolCalls+countToolCalls>=maxToolCalls | set run.pendingCloseout; return 'recovery_tool_budget'; onTerminate synthesizes | **1st in cascade** (before empty-round injection); inline :539 before :567 | in_engine | no | none (numeric) | recovery_tool_budget identical inline/engine (21846+) | sticky ??=; gates continuation; fires regardless of pending-call count |
| operator_cancelled (closeout #2) | :678-689,:685-691,:1400-1410 (engine :2738-2762) | activeToolLoop AND calls>0 AND contextHasCancelledSessionResult AND !isExplicitSessionContinuationRequest | set run.pendingCloseout; return 'operator_cancelled'; synthesize from evidence | **2nd**; after recovery, skips empty-round (calls>0 guard) | in_engine | yes | SessionEvidenceFact.status='cancelled' (now extractSessionToolResultRecords regex :9635) | operator_cancelled identical (21891+); passive closeout evidence | guard shouldCloseoutCancelledSessionWithoutContinuation :9618-9632; hardcoded 4 reason lines |
| pseudo_tool_call (closeout #3) | :1035-1109,:1042-1048 (engine :2763-2787) | activeToolLoop AND calls===0 AND !pendingContinuation AND containsAnyToolCallForm(lastText) | set run.pendingCloseout; return 'pseudo_tool_call'; synthesize without tool loops | **3rd**; empty-round-gated; skipped if continuation injects | in_engine | yes | LLMMessage.toolCallAttemptForm / ToolUseBlockMetadata (now containsAnyToolCallForm regex :7479-7481) | pseudo_tool_call identical (21943+) | matches `<tool_call>`,`<invoke>`,`tool_calls[:=]`; engine defers post-synthesis repairs |
| wall_clock_budget (closeout #4) | :1285-1320,:1291-1299 (engine :2788-2829 + :2830-2878 empty-round pre-check) | activeToolLoop AND calls>0 AND toolTrace>0 AND !shouldAllowRequiredTimeoutContinuationPastWallClock AND now-start>=maxWallClockMs | set run.pendingCloseout + maxWallClockMs; return 'wall_clock_budget'; no execute | **4th** (after pseudo, before round_limit); pre-checks empty round | in_engine | no | none (numeric timing) | wall_clock_budget identical (22002+); round-limit identical | #490 gap fix; two branches; resolveEffectiveToolLoopWallClockMs |
| round_limit (closeout) | :1355-1363,:1373-1377 | activeToolLoop AND roundLimitReached(round,maxRounds) | metadata reason='round_limit'; generateFinalAfterToolRoundLimit hardcoded reasonLines | after wall_clock in inline :1355; engine exits loop (onToolCallsClose skips, :2880) | in_engine | no | none | round-limit identical inline/engine | reason lines use formatDurationMs |
| repeated_tool_failure (closeout #5) | :1390-1420,:1390-1400 (engine :2881-2902) | activeToolLoop AND findRepeatedFailedToolCall(maxFailures=2)!=null | set pendingCloseout naming tool+failureCount; return 'repeated_tool_failure' | **5th** (after wall_clock & round_limit) | in_engine | no | none (structural via toolCallSignature) | repeated_tool_failure identical (22046+) | findRepeatedFailedToolCall react/predicates.ts:66-103; isError=true,!cancelled |
| repeated_session_inspection (closeout #6) | :1435-1475,:1427-1442 (engine :2903-2929) | activeToolLoop AND findRepeatedSessionInspectionCall!=null | set pendingCloseout naming tool+sessionKey; return 'repeated_session_inspection' | **6th** (after repeated_tool_failure) | in_engine | yes | SessionToolResult.sessionKey (now readSessionKeyFromToolInput + contextAlreadyContainsSessionHistory regex :9520) | repeated_session_inspection identical (22100+) | guard taskRequestsSessionTranscript :5577-5580 ⇒ no closeout |
| excessive_session_continuation (closeout #7) | :1475-1515,:1469-1482 (engine :2930-2954) | activeToolLoop AND findExcessiveSessionContinuationCall(maxContinuations=2)!=null | set pendingCloseout naming tool+sessionKey+count; return 'excessive_session_continuation' | **7th/final pending-call** (after repeated_session_inspection) | in_engine | yes | SessionToolResult.sessionKey + continuation status (now countSuccessfulSessionContinuations :5548-5567) | excessive_session_continuation identical (22141+) | readSessionKeyFromToolInput; counts isError=false,!cancelled,!skipped |
| tool_evidence_fallback (closeout) | :420-431 | activeToolLoop AND generate throws RequestEnvelopeOverflowError AND buildLocalEvidenceCloseoutResult succeeds | metadata reason='tool_evidence_fallback', evidenceAvailable=true; break (no model call) | pre-empts loop on envelope overflow | **gap** | no | none | tool_evidence_fallback identical inline/engine | engine does NOT handle envelope overflow ⇒ deferred to budget/reduction stage. **Linked to fail 48** |
| completed_sub_agent_final (closeout) | :1720-1728 (engine :3508) | activeToolLoop AND post-execute AND findCompletedSessionEvidence!=null | sticky toolLoopCloseout ??=; reason='completed_sub_agent_final'; complex reasonLines + buildCompletedBrowserEvidenceDimensionCarryForwardLines | post-execute (pre repeated-* checks) | in_engine | yes | CompletedSessionEvidence typed (now regex) | completed_sub_agent_final identical | sticky ??= captures completing round; cascade re-synthesizes in onTerminate ~3646+ |
| sub_agent_timeout (closeout) | :2209-2219,:2229-2237 | activeToolLoop AND post-execute AND findSubAgentToolTimeout!=null | reason='sub_agent_timeout'; timeoutSignal-aware reasonLines | post-execute (after completed check) | in_engine | yes | SubAgentTimeoutSignal typed (now regex findSubAgentToolTimeout :2185) | — | reason lines conditional on evidenceAvailable |
| ToolLoopCloseoutMetadata type | :76-87 | every closeout assignment | populate reason/toolCallCount/roundCount/maxRounds/maxWallClockMs?/pendingToolCallCount?/toolName?/timeoutSeconds?/evidenceAvailable?/finalContentCount? | structural (all 11 reasons) | in_engine | no | none | closeout metadata tests :5120+ | evidenceAvailable via hasUsableEvidence (regex on tool result) |
| Closeout precedence ordering (canonical) | :606-1355 inline; :2706-2954 engine onToolCallsClose; :3175-3190 onAfterExecute | explicit order-of-checks | enforce 1→7 + post-execute + round_limit before all repairs | **master precedence registry** | in_engine | no | none | parity compound scenarios | **no CLOSEOUT_POLICY_REGISTRY struct exists — target for 8G** (see §6) |
| reasonLines construction (all reasons) | hardcoded :701-706,:1064-1068,:1309-1313,:1373-1377; engine :2747-2752,:2773-2777,:2812-2816; :1410-1414,:1452-1456,:1492-1496,:1739-1775,:2229-2237 | each reason prepares justification before synthesis | build string[] 3-11 lines; passed to generateFinalAfterToolRoundLimit | per reason; order matches precedence | in_engine | yes | extract to registry methods (buildOperatorCancelledReasonLines etc.) for 8G | — | only buildFinalRecoveryBudgetCloseoutReasonLines :12828 is extracted |
| generateFinalAfterToolRoundLimit synthesis | :620,693,1050,1301,1365,1402,1444,1484,1731,3556 | every closeout reason | LLM synthesis with reasonLines + evidence; return text + reduction/memoryFlush metadata | per reason in sequence | in_engine | no | none | — | inline calls ≤10×; engine once per reason + completed cascade |
| sticky toolLoopCloseout assignment | :1729 (engine :3508) | first completed session pre-repair | toolLoopCloseout ??= completedSessionCloseout (only on first) | completed_sub_agent_final only | in_engine | no | none | completed_sub_agent_final parity | roundCount reflects completing round, not repair round |
| completed_session_timeloop_closeout_metadata_sticky | :1729 (engine :3507) | completed evidence; reason completed | ??= for completed; = (overwrite) for other reasons | closeout metadata assignment | in_engine | no | none | completed-closeout-metadata-sticky | Codex #520 P2 load-bearing |
| completed_closeout_result_overwrite_per_round | :1784-1804 (engine :3969-3999) | each onTerminate synthesis | run.closeoutResult = (overwrite) per reason | result text assembly, always overwrite | in_engine (T8+T10) | no | none | completed-closeout-result-overwrite | metadata sticky (??=), text overwrite (=) |

### T9-repair — tool-free natural-finish cascade (onRepairRound + inline)

| behaviorName | inlineLocation | trigger | action | precedence | engineStatus | regex? | typedFactsNeeded | relatedTests | notes |
|---|---|---|---|---|---|---|---|---|---|
| shouldRepairMissingBrowserEvidence | :751-774 (engine onRepairRound :3242-3264) | browser evidence requested, no completed session evidence, MISSING_BROWSER_EVIDENCE_FINAL_PATTERNS, no prior marker | force sessions_spawn, append prompt, forceToolChoice=sessions_spawn, consumesRound:true | **S2/S3 forced-spawn, FIRST in natural-finish cascade** (inline :748, engine :3242) | in_engine | yes | BrowserEvidenceFact.completed/.attempted; replace MISSING_BROWSER_EVIDENCE_FINAL_PATTERNS | repairs approval-gated answers that skipped; missing-table-columns parity | re-arms REAL tool round (round charged); shares idempotency marker w/ product-signal |
| shouldRepairMissingProductSignalBrowserEvidence | :776-802 (engine :3265-3287) | product-signal dashboard requested, no dashboard metrics, MISSING_BROWSER_EVIDENCE/product-signal regex, no prior marker | force sessions_spawn, append prompt, forceToolChoice=sessions_spawn, consumesRound:true | S2/S3 forced-spawn, after browser-evidence before table-columns (inline :776) | in_engine | yes | BrowserEvidenceFact.productSignals; taskRequestsProductSignalDashboardEvidence regex; PRODUCT_SIGNAL_DASHBOARD_RENDERED_RESULT_PATTERN | product signal repair parity | shares marker w/ shouldRepairMissingBrowserEvidence (mutually exclusive per round); regex :7861-7867 |
| shouldRepairMissingApprovalGate | :804-828 (forced-tool, engine :3295-3317) + :1672 (post-execute, engine :3112) + :807 (natural-finish) | approval-gated browser action, permission_query available, no permission-gate evidence, not already-applied, candidate never gated, no prior marker | force permission_query, append prompt, forceToolChoice=permission_query, consumesRound:true | **S9 natural-finish**, after S2/S3 (inline :804) before table-columns (:1139); also post-execute 6th continuation; also natural-finish repair :807 | in_engine | yes | PermissionEvidenceFact.hasPermissionGateCall; requestsApprovalGatedBrowserAction regex :8966-8996 (4 checks); hasPermissionGateEvidence scans toolTrace | repairs approval-gated answers that skipped; repairs approval-applied delegation-only browser | **bridge: marker read by onToolCalls enforce-gate normalizer.** Multi-region merged row |
| shouldRepairPendingApprovalWaitTimeoutCheck | :833-853 (NOT in onRepairRound) | approval-wait-timeout closeout requested, latest permission is permission_query (no result after), candidate has no tool calls | force permission_result (re-check), nextToolChoice=permission_result, continue | inline-only S9 sub-slice :833 | **gap** | yes | PermissionEvidenceFact.lastQueryPending; taskPromptRequestsApprovalWaitTimeoutCloseout regex :8940-8950 | repairs pending answer from applied approval | **CRITICAL GAP: approval-wait-timeout family entirely missing from engine onRepairRound. Drives fails 21,25.** |
| shouldRepairPrematurePendingApprovalFinal | :855-878 (NOT in onRepairRound) | task requires carrying approval through, result mentions pending, permission_query exists but still pending, no session evidence, no marker | force permission_result re-check, nextToolChoice=permission_result, continue | inline-only S9 :855, before stale (:883) | **gap** | yes | PermissionEvidenceFact.lastResultStatus; hasPrematurePendingApprovalRepairPrompt fixed string 'approval-gated browser action is still pending' | repairs stale pending answers after daemon-supervised approval | GAP; family :855-984 missing from engine. **Drives fails 23,28** |
| shouldRepairStalePendingApproval | :880-903 (NOT in onRepairRound) | result mentions pending, approval IS applied, approval-gated/continuation task, no marker | force sessions_spawn (execute approved action), nextToolChoice=sessions_spawn, continue | inline-only :880 after premature | **gap** | yes | PermissionEvidenceFact.isApplied; mentionsPendingApproval regex :8928-8931; taskPromptIsAppliedApprovalBrowserContinuation :8786-8792 | repairs stale pending answers after approval | GAP; re-arms real sessions_spawn. **Drives fails 22,24,26,30** |
| shouldRepairApprovalWaitTimeoutCloseout | :930-953 (NOT in onRepairRound) | approval-wait-timeout closeout requested, wait-timeout evidence exists, closeout incomplete (!looksLikeCompleteApprovalWaitTimeoutCloseout), no marker | force tool-free synthesis (nextToolChoice='none'), append closeout prompt, continue | inline-only :930 before forced-local-closeout (:955) | **gap** | yes | PermissionEvidenceFact.waitTimeoutStatus; hasApprovalWaitTimeoutEvidence scans toolTrace; looksLikeCompleteApprovalWaitTimeoutCloseout regex :7713 | — | GAP; tool-free approval-specific synthesis repair |
| shouldForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair | :955-983 (NOT in onRepairRound) | approval-wait-timeout closeout requested, evidence exists, repair prompt sent but still incomplete | break loop, toolLoopCloseout={reason:'tool_evidence_fallback'}, buildApprovalWaitTimeoutLocalEvidenceCloseout | inline-only fallback :955-983, last in approval-timeout family | **gap** | no | PermissionEvidenceFact.waitTimeoutStatus; collectApprovalWaitTimeoutRuntimeEvidence :7735-7756 | — | GAP; **hard closeout (breaks loop), no onTerminate branch covers it** |
| shouldRepairMissingRequestedTableColumns | :1138-1164 (engine :3318-3343) | requested table columns declared, result missing columns (markdownTableHasExactRequestedColumns), no marker | tool-free synthesis (forceToolChoice='none'), append prompt, continue | **first tool-free repair**, after S2/S3/S9 (inline :1138, engine :3318), before extraneous | in_engine | yes | ActivationInput.requestedTableColumns; resolveRequestedTableColumns regex :7931-7935 | missing-table-columns identical inline/engine | engine parity confirmed |
| shouldRepairExtraneousProviderTableSchema | :1166-1191 (engine :3344-3367) | result introduces provider/search/model-support schema not requested, no marker | tool-free synthesis (forceToolChoice='none'), append prompt, continue | **second tool-free** (inline :1167, engine :3344), after missing-columns before source-evidence | in_engine | yes | ActivationInput.originalRequestedColumns; resultIntroducesProviderSupportSchema regex :8018-8024; explicitlyRequestsProviderSupportSchema :8027-8033 | extraneous-provider-table-schema identical | engine parity confirmed |
| shouldRepairSourceEvidenceCarryForward | :1202-1229 (engine :3387-3412) | sourceBoundedEvidenceText non-empty AND (productBrief OR completedSessionLabel carry-forward), no marker | tool-free synthesis (forceToolChoice='none'), append prompt, continue | **third tool-free** (inline :1202, engine :3387), after extraneous before weak; truthy-gated | **partial** | yes | EvidenceLedger.sourceLabels; extractCompletedSessionEvidenceLabels regex :8333-8347; PRODUCT_BRIEF_MULTI_AGENT_EVIDENCE_PATTERN + PRODUCT_SIGNAL_DASHBOARD_METRICS | source-evidence-carry-forward identical | evidence formula differs inline :1192 vs engine :3370-3379 |
| shouldRepairWeakEvidenceSynthesis | :1230-1252 (engine :3413-3430) | sourceBoundedEvidenceText AND (unsupported extrapolation OR weak uncertainty/estimate OR missing risk dimension), no marker | tool-free synthesis (forceToolChoice='none'), append prompt, continue | **fourth/last tool-free** (inline :1231, engine :3413) | in_engine | yes | confidence level; hasUnsupportedSourceBoundedExtrapolation :8387-8421; WEAK_UNCERTAINTY :8564-8567; WEAK_ESTIMATE :8569-8572; shouldRepairMissingRequestedRiskDimension :8518-8532 | weak-evidence-synthesis identical | 3 major regex blocks (DNS/IP, ops restrictions, risk); TBD/maybe/待确认 |
| shouldRepairMissingBrowserEvidenceDimensions | :720-745 (pseudo-tool-call closeout), :1080-1107 (wall-clock/round-limit closeout), NOT in onRepairRound | completedEvidenceText non-empty AND findMissingBrowserEvidenceDimensions non-empty (frame/shadow/popup/dashboard), no marker | tool-free synthesis (nextToolChoice='none'), append prompt, continue | only in pseudo & wall-clock/round-limit closeout branches (:720,:1082), NOT natural-finish | **partial** | yes | BrowserEvidenceFact iframe/shadow/popup/dashboard; findMissingBrowserEvidenceDimensions :8464-8516 (4 dims, each requested/evidence/result/negated regex) | missing-browser-dimensions parity | completed-closeout-phase repair; multi-dim regex artifact |
| shouldRepairFalseEvidenceBlockedSynthesis | completed_sub_agent_final onTerminate (engine onTerminate) | result FALSE_EVIDENCE_BLOCKED_SYNTHESIS_PATTERNS but evidence !ACTUAL_EVIDENCE_BLOCKED_PATTERNS, no marker | tool-free re-prompt in onTerminate completed-closeout, re-enter loop | completed-closeout repair, not natural-finish | in_engine | yes | typed evidence presence/absence; FALSE :8574-8578, ACTUAL :8580-8585 | false-evidence-blocked identical | two regex arrays |
| shouldRepairMissingRequestedNextAction | completed_sub_agent_final onTerminate | task requests next-action, result lacks next action/step/recommendation/should/fallback, no marker | tool-free re-prompt in onTerminate, re-enter loop | completed-closeout repair | in_engine | yes | TaskFacts.requestsNextAction; :7900-7918 regex (:7910-7912 / :7916-7918) | missing-requested-next-action identical | completed-closeout only |
| findMissingRequiredFinalDeliverables | completed_sub_agent_final onTerminate | inferRequiredFinalSynthesisDeliverables (final_conclusion, two_row_table) partly missing | trigger per-missing repair, re-enter loop if count>0 | completed-closeout series | in_engine | yes | TaskFacts.requiredDeliverables; finalDeliverableIsPresent :12080-12082/:12085 | missing-required-deliverables parity | returns RequiredFinalDeliverable[]; multilingual headers (结论/总结/Conclusion/Summary) |
| shouldRepairTimeoutFollowupFinalGuidance | completed_sub_agent_final onTerminate (~9152) | completed timeout evidence present, final text lacks timeout follow-up guidance | tool-free re-prompt in onTerminate, re-enter | completed-closeout timeout-recovery | in_engine | yes | SessionEvidenceFact.timeoutStatus; regex on result | timeout-followup-final-guidance parity | timeout-recovery + approval sub-family |
| recordRepairPrompt (marker ledger) | inline :557,656,734,767,795,823,848,873,898,923,948,1003,1128,1154,1182,1218,1246; engine :3256,3279,3309,3331,3357,3401,3426 | every repair decision after building prompt | append repair prompt to ctx.repairMarkers (idempotency ledger) | FIRST in every repair block; marker added after predicate, before continue | in_engine (C5-memory) | no | RepairLedger typed store should replace ctx.repairMarkers array; has*RepairPrompt scan messages via includes | repair idempotency verified | **Stage 8 spec :1154: 'no repair predicate reads raw LLMMessage[]'.** inline persists via ??= |

### T9-repair — completed-session closeout cascade (inline ~:1720-1932 + engine onTerminate ~:3436-4000)

| behaviorName | inlineLocation | trigger | action | precedence | engineStatus | regex? | typedFactsNeeded | relatedTests | notes |
|---|---|---|---|---|---|---|---|---|---|
| missing_requested_table_columns_completed_repair | ~:1826 / build ~:1861 | synthesis missing requested column names; marker guard | inject prompt to re-synthesize w/ columns; every-round (completed + natural-finish) | **FIRST in cascade** (after extraneous on round>0); first-match-wins continue | in_engine | yes | ActivationInput.handoff.payload.intent.relayBrief; resolveRequestedTableColumns regex | parity-missing-table-columns; compound-completed-does-not-over-repair | round 0 uses completedProductBriefEvidenceText, round>0 sourceBoundedEvidenceText |
| extraneous_provider_table_schema_completed_repair | ~:1854 / build ~:1869 | synthesis adds provider/search/model schema not requested; marker | inject prompt to remove columns; every-round both cascades | **SECOND**; !repairPrompt-guarded so table-columns wins same round | in_engine | yes | schema inference from headers; provider+search+model+price regex | parity-extraneous-provider-schema | generateFinalAfterToolRoundLimit pre-repairs in first synthesis |
| missing_browser_evidence_completed_rearm_s10 | ~:1880 / build ~:9047 | result lacks browser-visible evidence when required; hasToolDefinition(sessions_spawn); marker | **RE-ARM REAL sessions_spawn** (S10, not tool-free); ReActReArm{forceToolChoice:sessions_spawn} | S10: completed-block AFTER extraneous; round>0 BEFORE table-columns. inline :1880-1904, engine :3643-3659 (round 0) | in_engine | yes | typed browserEvidence.rendered/screenshots/visibleText; MISSING_BROWSER_EVIDENCE_FINAL_PATTERNS | parity-missing-browser-evidence-s10 | persists synthesisReduction before reArm. **Stage 7 S10 deferred** |
| missing_product_signal_browser_evidence_completed_rearm_s10 | ~:1907 / build ~:9099 | result lacks product-signal dashboard evidence; SPA/shell regex; hasToolDefinition + marker gates | **RE-ARM REAL sessions_spawn** for product-signal; ReActReArm{forceToolChoice:sessions_spawn} | S10: completed-block AFTER extraneous; round>0 first. inline :1907-1931, engine :3715-3736 (round 0) | in_engine | yes | productSignals{rendered,metrics,url,title}; PRODUCT_SIGNAL_DASHBOARD_COUNTERS_PATTERN + MISSING_BROWSER_EVIDENCE_FINAL_PATTERNS | parity-missing-product-signal-browser-evidence-s10 | round 0 passes completedProductBriefEvidenceText; round>0 undefined. **Stage 7 S10 deferred** |
| source_evidence_carry_forward_completed_repair | ~:1941 / build ~:8267 | synthesis drops completed session labels OR multi-agent/product-brief evidence; truthy-gated; marker | inject tool-free prompt to add labels/orchestration evidence; every-round both cascades | middle of cascade; !repairPrompt-guarded. inline :1941-1965 / :1204-1228, engine :3825-3851 | in_engine | yes | sourceLabels[]; multiAgentDecomposition/specialistAgents[]; extractCompletedSessionEvidenceLabels regex `/'label'\s*:\s*'...'/` | parity-source-evidence-carry-forward-completed; parity-completed-session-label-carry-forward | round-dependent evidence formula; two checks (productBrief + label) |
| timeout_followup_final_guidance_completed_repair | ~:1968 / build ~:9156 | task requests timeout-followup guidance; evidenceText has timeout/recovered; synthesis missing markers; marker | inject tool-free prompt for recovered/resumed/continuation guidance; **completed-ONLY (round 0)** | completed-ONLY block; after source-evidence before missing-next-action. inline :1968-1992, engine :3871-3886 (round===0) | in_engine | yes | status:'timeout'\|'recovered', timeoutMs, recoveryContext; taskPromptRequestsTimeoutFollowupContinuation regex; :2190 `/timeout\|timed out/i` | parity-timeout-followup-final-guidance-completed (round 0 only) | **deferred-appender scope gap** :3565-3602: inline maybeAppendBrowserRecovery/FailureBucket/timeout appenders (:1782-1814) — engine :3969-3991 now mirrors |
| missing_requested_next_action_completed_repair | ~:1995 / build ~:9143 | task `/next action\|next step\|operator should\|safe fallback/` but synthesis lacks; marker | inject tool-free prompt; **completed-ONLY (round 0)** | completed-ONLY; after timeout-followup before deliverables. inline :1995-2014, engine :3889-3901 (round===0) | in_engine | yes | next-action recommendation (model-gen, regex detection) | parity-missing-requested-next-action-completed (round 0) | regex-light includes check |
| missing_required_final_deliverables_completed_repair | ~:2016 / build ~:9147 | task infers required deliverables (final_conclusion section, two_row_table rows>=2); synthesis missing; marker | inject tool-free prompt; **completed-ONLY (round 0)** | completed-ONLY; after next-action before browser-dimensions. inline :2016-2043, engine :3903-3921 (round===0) | in_engine | yes | required-deliverable indicators; inferRequiredFinalSynthesisDeliverables; finalDeliverableIsPresent /结论\|Conclusion\|Summary/; markdownTableDataRowCount | parity-missing-required-deliverables-completed (round 0) | evidence = bare finalContents join (~:3915) |
| missing_browser_evidence_dimensions_completed_repair | ~:2100 / build ~:9191 | finalContents>0 AND task requests dimension (iframe/shadow/popup/product-signal) AND evidence has it AND synthesis missing/negates; marker | inject tool-free prompt; **completed-ONLY (round 0)** | completed-ONLY; after deliverables before false-evidence. inline :2100-2127, engine :3923-3938 (round===0) | in_engine | yes | browserEvidence.frames/shadowComponents/popups/productSignals; findMissingBrowserEvidenceDimensions regex (each requested/evidence/result/negated) | parity-missing-browser-evidence-dimensions-completed (round 0) | 4 dims; negation-aware to distinguish present-but-negated vs absent |
| false_evidence_blocked_synthesis_completed_repair | ~:2129 / build ~:9165 | synthesis FALSE_EVIDENCE_BLOCKED_SYNTHESIS_PATTERNS but evidence !ACTUAL_EVIDENCE_BLOCKED_PATTERNS; marker | inject tool-free prompt to remove false blocker claims; **completed-ONLY (round 0)** | completed-ONLY; after browser-dimensions before weak. inline :2128-2151, engine :3940-3953 (round===0) | in_engine | yes | evidenceAccessible:bool, accessErrors[]; FALSE (6) vs ACTUAL (4) regex sets | parity-false-evidence-blocked-synthesis-completed (round 0) | evidence = bare finalContents join |
| weak_evidence_synthesis_completed_repair | ~:2153 / build ~:9169 | synthesis weakens via WEAK_UNCERTAINTY OR hasUnsupportedSourceBoundedExtrapolation OR WEAK_ESTIMATE (when task doesn't request estimate); marker; expectsExactFinalAnswerShape guard | inject tool-free prompt verified/not-verified language; every-round both cascades | **LAST in cascade**; !repairPrompt-guarded. inline :2153-2179, engine :3970-3982 (every round) | in_engine | yes | confidence: verified/partial/inferred/unsupported; hasUnsupportedSourceBoundedExtrapolation regex (DNS/prod-ban/abuse); WEAK_UNCERTAINTY [TBD/probably/maybe/待确认]; WEAK_ESTIMATE [estimate/估算] | parity-weak-evidence-synthesis-completed/natural-finish (every round) | round-dependent evidence formula |
| completed_repair_round_gating_completed_only_predicates | inline completed (~:1720-2181) once; natural-finish (~:1110-1272) every iter; engine :3875-3970 | engine onTerminate must gate completed-ONLY repairs to round 0 | completed-ONLY (timeout-followup/next-action/deliverables/false-evidence) evaluated only round===0; others every round | loop-control gate | in_engine (T5+T9) | no | none | parity-compound-completed-input-does-not-over-repair | **prevents compound over-repair**; engine :3645-3660 documents inline asymmetry |
| completed_repair_idempotency_via_repair_markers | inline :336-341,:1826-2179; engine :3691 (ctx.repairMarkers??=[]) | every shouldRepair* checks marker before firing | maintain repairMarkers ledger; each predicate calls hasX*RepairPrompt guard | idempotency guard | in_engine (T9+T11) | no | RepairLedger typed store vs LLMMessage[] text scan ('Runtime correction: ...') | parity-repair-idempotency; parity-repair-markers-ledger | Stage 6 prereq :337-340; deferred explicit RepairLedger per T11 |

### T10-finalization

| behaviorName | inlineLocation | trigger | action | precedence | engineStatus | regex? | typedFactsNeeded | relatedTests | notes |
|---|---|---|---|---|---|---|---|---|---|
| maybeRedactForbiddenLocalUrls | :7445-7464 | forbidsFinalUrls(taskPrompt+outputContract) | replace local/localhost URLs → 'local fixture source' via `/\bhttps?:\/\/(?:127\.0\.0\.1\|localhost).../gi` | **final step** both paths (inline :432,973,1815; engine :4065), after all appenders | in_engine | yes | RolePromptPacket.forbidUris / RoleToolFact (forbidsFinalUrls regex :7466) | — | no structured URI-blocking policy yet |
| maybeAppendRecoveredTimeoutCloseoutVisibility | :7243-7253 | shouldAppendRecoveredTimeoutCloseoutVisibility (timeout evidence + sessions_send + closeout-guidance gaps) | append 'Timeout closeout: ... Continue or retry ... bounded timeout ...' | **BEFORE** maybeAppendTimeoutContinuationVisibility (elif :1262-1269,:3042-3060) | in_engine | yes | SessionEvidenceFact.completedAfterTimeout/.recoveryMarker (taskRequests*/mentionsUnverifiedScope :7340-7357 regex) | — | only one of two timeout appenders fires |
| maybeAppendTimeoutContinuationVisibility | :7207-7217 | shouldAppendTimeoutContinuationVisibility (explicit continuation + sessions_send + timeout result) | append 'Continuation: this source check is resumable; ...' | **AFTER** recovered (elif :1262-1269,:3052-3060); inline natural-finish + engine completed/timeout | in_engine | yes | ContinuationSeed + SessionEvidenceFact.status='timeout' (isExplicitSessionContinuationRequest regex; contextHasTimeoutSessionResult :9640-9643) | — | idempotent via hasTimeoutCloseoutGuidance; appendCompletedTimeoutVisibility :4030-4062 |
| maybeAppendBrowserRecoveryVisibility | :6884-6916 | browserRecoverySummaries>0 AND recovery/timeout keywords AND !isBrowserRecoveryVisible AND !expectsExactFinalAnswerShape | append 'Browser continuity: ... (resume mode: warm/cold)' | inline completed :1782-1786 BEFORE failure-bucket & redaction. **NOT PORTED** (gap :3572-3582) | **gap** | yes | BrowserEvidenceFact.recoveryMetadata; isBrowserRecoveryVisible :6918-6932 regex; CapabilityFacts.browserTaskHints (taskPrompt regex :6893) | — | **DEFERRED GAP**; collectBrowserRecoverySummariesFromToolTrace :6934-6968 |
| maybeAppendBrowserFailureBucketVisibility | :6970-6993 | collectBrowserFailureBucketNames finds bucket (target_not_found/attach_failed/...) AND !expectsExactFinalAnswerShape AND buckets not visible | append limitation/scope line via buildBrowserFailureBucketVisibilityLine | inline completed :2283 AFTER recovery, before redaction. **NOT PORTED** (gap :3572-3582) | **gap** | yes | BrowserEvidenceFact.failureBucket (enum); collectBrowserFailureBucketNames :7077-7085 regex; browserFailureBucketVisible :7087-7109 | — | **DEFERRED GAP**; buildBrowserFailureBucketVisibilityLine :7111-7138; hasRecoveredRenderedBrowserEvidence :7140-7159 |
| maybeAppendRequiredTimeoutFollowupVisibility | :7255-7300 | taskRequestsTimeoutFollowupContinuation AND timeout evidence AND sessions_send AND missing guidance/scope/timeout phrases | append 'Continuation guidance: ...' + 'Unverified scope: ...' + 'Timeout recovery: ...' (only missing) | inline :2271 AFTER wall-clock IN NATURAL-FINISH loop. **NOT PORTED** | **gap** | yes | SessionEvidenceFact.status, TaskFacts.requiresTimeoutFollowup; hasTimeoutContinuationGuidance :7385-7400, mentionsUnverifiedScope :7354-7357, mentionsTimeout :7402-7404 | — | **DEFERRED GAP** :3584-3593 'the single residual'; natural-finish only |
| maybeAppendBrowserRecoveryResidualRiskVisibility | :7302-7337 | !requestsStatusVisibleTextEvidenceUrlLines AND taskRequiresBrowserEvidence AND !residual-risk in result AND context has residual-risk AND (timeout result OR browser-recovery regex) | append 'Residual risk: this browser review is source-bounded ...' | inline :2277-2282 AFTER required-timeout-followup, BEFORE failure-bucket. Natural-finish only. **NOT PORTED** | **gap** | yes | BrowserEvidenceFact.isBounded/.recoveryStatus, TaskFacts.requiresBrowserEvidence; taskRequiresBrowserEvidence ~8535, requestsStatusVisibleTextEvidenceUrlLines ~8232 | — | **DEFERRED GAP** :3572-3582 |
| shouldAppendRecoveredTimeoutCloseoutVisibility (predicate) | :7219-7241 | (timeout evidence OR taskRequestsTimeoutContinuationCloseout) AND sessions_send AND (unverified-closeout gap OR no closeout guidance) | returns bool selecting recovered- over continuation-appender | checked inline :1254, engine :3043 | in_engine | yes | SessionEvidenceFact.status='timeout' + .completedAfterTimeout (regex :7339-7382) | — | guard for appender selection |
| taskRequestsTimeoutContinuationCloseout (predicate) | :7339-7343 | taskPrompt matches complex timeout-limits-on-conclusion regex | returns bool | called by taskRequestsUnverifiedTimeoutCloseout :7345, shouldAppendRecovered :7225 | in_engine | yes | TaskFacts.explicitTimeoutCloseoutRequest | — | helper predicate |
| shouldAppendTimeoutContinuationVisibility (predicate) | :9646-9677 | isExplicitSessionContinuationRequest AND sessions_send AND (toolTraceHasTimeoutResult OR contextHasTimeoutSessionResult) | returns bool | inline :1263,:4053; engine :3053,:4053 | in_engine | yes | ContinuationSeed.isExplicitUserRequest + SessionEvidenceFact.status='timeout' | test :21804+ sub_agent_timeout continuation | toolTraceHasTimeoutResult partially structured via parseSessionToolResult |
| forbidsFinalUrls (predicate) | :7466-7470 | text matches no-links/forbidden-links regex | returns bool | start of maybeRedactForbiddenLocalUrls :7450 | in_engine | yes | OutputContract.forbiddenUriPatterns / RolePromptPacket.uriRedactionPolicy | — | should be precomputed in T1, not per-finalization |

### C5-memory-compaction

| behaviorName | inlineLocation | trigger | action | precedence | engineStatus | regex? | typedFactsNeeded | relatedTests | notes |
|---|---|---|---|---|---|---|---|---|---|
| generateWithEnvelopeRetry | :4269-4402 | RequestEnvelopeOverflowError on gateway.generate() | retry 3 levels (compact→minimal→reference-only); record reduction; persist memoryFlush | per-round synchronously after model call | in_engine | no | none | preserves tool history when envelope retry reduces (:3973) | wraps inline rounds + engine synthesis; calls flushPreCompactionMemorySafely on first overflow. **Linked to fail 1** |
| flushPreCompactionMemorySafely | :4404-4438 | overflow on first gateway.generate() | preCompactionMemoryFlusher.flush('request_envelope_overflow'); suppress errors | once per overflow, before retries | in_engine | no | none | triggers pre-compaction flusher on overflow (:162-221) | optional (nil check). **Linked to fail 2** |
| reductionSnapshot accumulation/carry-forward | :248-252 + :375/443/636/712/1074/1319/1383/1420/1462/1502/1821 | each generateWithEnvelopeRetry returning reduction | capture into local reductionSnapshot, persist across rounds | after each retry | **gap** | no | none | preserves tool history when retry reduces (:3973) | **INLINE-ONLY**; engine captures only at synthesis :3594-3601; per-round reduction facts lost. **Linked to fail 1** |
| prepareToolHistoryForGateway | :12313-12319 | before each gateway.generate() | pruneToolResultMessagesForGateway then compactOlderToolHistoryForGateway | universal pre-gateway pipeline | in_engine | no | none | prunes older oversized tool results (:4050+) | called :351 (inline),:2387 (engine),:3995/4479/4532/4592 |
| pruneToolResultMessagesForGateway | :12389-12434 | from prepareToolHistoryForGateway | prune >64KB OR (not-recent-2 AND >16KB) → summary JSON | first pass before compaction | in_engine | no | none | prunes older oversized (:4050+) | calls pruneToolResultsToTotalBudget. **Linked to fail 39** |
| pruneToolResultsToTotalBudget | :12590-12695 | totalBytes >32KB after soft/hard | 3-phase: older non-recent → recent-not-newest → newest if pathological | second pass | in_engine | no | none | prunes older oversized (:4050+) | preserves newest when possible |
| compactOlderToolHistoryForGateway | :12436-12472 | messages.length >16 | compact older rounds → single summary, keep recent N | third stage after pruning | in_engine | no | none | implicit in prepareToolHistoryForGateway | greedy backward; 6KB cap. **Linked to fail 47** |
| summarizeToolResultPruning | :12321-12358 | after prepareToolHistoryForGateway (:355) | detect pruned + compaction → ToolResultPruningSnapshot | post-prep observability | **gap** | yes | structured pruning facts (now regex 'Earlier tool history compacted to fit') | preserves tool history when retry reduces (:3973) | **INLINE-ONLY**; engine doesn't invoke. **Linked to fails 39,47** |
| withFinalToolRoundWarning | :12360-12387 | round===maxRounds-1 AND finite maxRounds | append user message warning final tool round | before prepareToolHistoryForGateway (:346) | **gap** | no | none | implicit end-of-round | **INLINE-ONLY**; engine doesn't inject |
| deriveToolResultEnvelope | :372/2395/12338/12595 | before each generate() + after pruning | scan messages, count results/bytes, extract envelope facts | post-prep | in_engine | no | none | preserves tool history when retry reduces (:3973) | inline (372), engine (2395), validation (12338,12595) |
| memoryFlushes accumulation | :254,:445-447 (engine synthesis :3601) | generateWithEnvelopeRetry returns memoryFlush | push into memoryFlushes[] | after each retry | **gap** | no | none | triggers pre-compaction flusher (:162) | **INLINE-ONLY** for per-round; engine tool-use (:2398-2407) doesn't capture |
| recordToolResultPruningBoundarySafely | :352-356 | after prepareToolHistoryForGateway in tool rounds | record ToolResultPruningSnapshot to runtimeProgressRecorder | post-prep observability | **gap** | yes | structured compaction facts (now text regex) | preserves tool history when retry reduces (:3973) | **INLINE-ONLY**; engine doesn't record. Observability gap |
| reduction metadata carry-forward in final response | :2306-2332 (engine :4226-4227,:4260-4261) | end of generate(); reductionSnapshot set | include requestEnvelopeReduction + preCompactionMemoryFlushes in metadata | terminal | **partial** | no | none | preserves tool history when retry reduces (:3973) | inline collects every round; engine only synthesis; per-round lost |
| recordReductionBoundarySafely | :4226-4227 (engine only) | engine: end of generate() if run.reductionSnapshot set | record reduction boundary to runtimeProgressRecorder | terminal | **gap** | no | none | preserves tool history when retry reduces (:3973) | **ENGINE-ONLY**; inline has no equivalent — asymmetric observability |

---

## 3. Gap Worklist for Stage 8B (parity-first, prioritized backlog)

Only `engineStatus=gap` and `partial` rows. Ordered by empirical failure impact: rows whose `relatedTests` (or behavior cluster) appear in the 21 probe failures come first. Each tagged with target layer for 8C–8I extraction.

### Tier 1 — directly drives observed engine failures (port first)

| # | behavior | layer | status | drives fails | inlineLocation |
|---|---|---|---|---|---|
| 1 | shouldRepairStalePendingApproval | T9-repair + T7 | gap | 22, 24, 26, 30 | :880-903 |
| 2 | shouldRepairPendingApprovalWaitTimeoutCheck | T9-repair + T5 | gap | 21, 25 | :833-853 |
| 3 | shouldRepairPrematurePendingApprovalFinal | T9-repair | gap | 23, 28 | :855-878 |
| 4 | shouldRepairApprovalWaitTimeoutCloseout | T9-repair | gap | 21/27 cluster | :930-953 |
| 5 | shouldForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair | T8-closeout | gap | 21/27 cluster (hard closeout) | :955-983 |
| 6 | shouldSuppressReadOnlyPermissionQueryToolCalls | T4-permission + T9 | gap | 13, 14, 15 | :520-523 |
| 7 | normalizeApprovalGatedBrowserSpawnCalls (full inline scope) | T4-permission (pre-execute) | partial | 10 | :508-512 |
| 8 | reductionSnapshot accumulation/carry-forward | C5-memory | gap | 1 | :248-252,:375+ |
| 9 | memoryFlushes accumulation | C5-memory | gap | 2 | :254,:445-447 |
| 10 | summarizeToolResultPruning | C5-memory | gap | 39, 47 | :12321-12358 |
| 11 | recordToolResultPruningBoundarySafely | C5-memory + obs | gap | 39, 37 | :352-356 |
| 12 | tool_evidence_fallback closeout (engine envelope-overflow path) | T8-closeout | gap | 48 | :420-431 |
| 13 | withFinalToolRoundWarning | C5-memory + T5 | gap | 7 (loop wiring), 37 | :12360-12387 |
| 14 | reduction metadata carry-forward (engine per-round) | C5-memory | partial | 1, 39 | :2306-2332 |

### Tier 2 — no direct probe fail yet, but parity-load-bearing normalizer/continuation gaps

| # | behavior | layer | status | inlineLocation |
|---|---|---|---|---|
| 15 | enforceSupplementalLocalTimeoutProbeToolCall | T2-normalizer | gap | :473-484 |
| 16 | normalizeSessionToolAliasCalls | T2-normalizer | gap | :475 |
| 17 | applySessionContinuationDirective | T2-normalizer + T5 | gap | :489/:507 |
| 18 | applySessionContinuationLookupDirective | T2-normalizer + T5 | gap | :490 |
| 19 | normalizeExplicitContinuationHistoryCalls | T2-normalizer + T5 | gap | :491 |
| 20 | normalizeSessionToolCalls | T2-normalizer | gap | :492 |
| 21 | normalizePrivateUrlResearchSpawnCalls | T2-normalizer + T4 | gap | :493-497 |
| 22 | normalizeLocalUrlWebFetchCalls | T2-normalizer + T4 | gap | :498 |
| 23 | normalizeBoundedTimeoutSourceSpawnAgents | T2-normalizer | gap | :499-503 |
| 24 | normalizeBoundedTimeoutDuplicateSourceSpawns | T2-normalizer | gap | :504-506 |
| 25 | findSessionContinuationLookupDirective | T5-continuation | gap | :9512 (:588-605) |
| 26 | canonicalizeSessionToolTraceCalls | T3-evidence | partial | :5801 (:1540) |
| 27 | shouldRepairSourceEvidenceCarryForward (evidence-formula divergence) | T9-repair | partial | :1202-1229 |
| 28 | shouldRepairMissingBrowserEvidenceDimensions | T9-repair | partial | :720-745,:1080-1107 |

### Tier 3 — T10 finalization visibility appenders (deferred to browser/recovery cutover, but parity-visible)

| # | behavior | layer | status | inlineLocation |
|---|---|---|---|---|
| 29 | maybeAppendBrowserRecoveryVisibility | T10-finalization | gap | :6884-6916 |
| 30 | maybeAppendBrowserFailureBucketVisibility | T10-finalization | gap | :6970-6993 |
| 31 | maybeAppendRequiredTimeoutFollowupVisibility | T10-finalization | gap | :7255-7300 |
| 32 | maybeAppendBrowserRecoveryResidualRiskVisibility | T10-finalization | gap | :7302-7337 |

### Tier 4 — T3 evidence-ledger regex-debt functions (replace during 8C, not strictly parity blockers yet)

| # | behavior | layer | status | inlineLocation |
|---|---|---|---|---|
| 33 | collectSourceBoundedEvidenceText | T3-evidence | gap | :7024 |
| 34 | extractSessionToolResultRecords | T3-evidence | gap | :10259 |
| 35 | looksLikeSourceBoundedEvidenceLine | T3-evidence | gap | :7062 |
| 36 | recordReductionBoundarySafely (engine-only, inline parity) | C5-memory + obs | gap | :4226-4227 |

---

## 4. Regex-debt / Typed-facts Feasibility Seed for 8C

Every `usesRegexOverText=true` row, grouped by the structured field it needs. For each group the 8C producer-feasibility audit must classify the source field as `already_structured` / `present_only_as_text` / `missing_from_producer`.

### Group A — Session / timeout evidence facts (target: SessionToolResultV1 / SessionEvidenceFact)
*Producer = session-tool-result-protocol.ts; `parseSessionToolResult` already typed — many of these are `present_only_as_text` derivations on top of a structured base.*
- findCompletedSessionEvidence — browserRecoverySummaries (readInlineBrowserRecoverySummary regex) → structured recovery payload field
- operator_cancelled / shouldCloseoutCancelledSessionWithoutContinuation — SessionEvidenceFact.status='cancelled' (extractSessionToolResultRecords :9635)
- repeated_session_inspection — sessionKey + contextAlreadyContainsSessionHistory regex :9520
- excessive_session_continuation — countSuccessfulSessionContinuations :5548-5567
- shouldRunSupplementalLocalTimeoutProbe — mentionsTimeout / isContentPoorTimeoutEvidence / explicitlyDisallowsBrowserEvidence
- shouldContinueTimedOutApprovedBrowserSession — timeout_signal.agentId, approval_status
- shouldContinueTimedOutSiblingSession — isCoverageCriticalDelegationTask regex
- findIncompleteApprovedBrowserSession — INCOMPLETE_APPROVED_BROWSER_ACTION_PATTERNS
- findSessionContinuationDirective — sessionToolResultContinuationPriority regex on 'System recovery:' / taskPrompt
- hasLatestSupplementalLocalTimeoutProbePrompt — probeIsPending (literal string match)
- shouldForceSlowSourceRecoveryContinuation — run reason 'recovery_mode' / 'required_goal_slots_unsatisfied'
- sub_agent_timeout / completed_sub_agent_final closeout — SubAgentTimeoutSignal / CompletedSessionEvidence
- shouldRepairTimeoutFollowupFinalGuidance, timeout_followup_final_guidance_completed_repair — status:'timeout'|'recovered', timeoutMs, recoveryContext
- T10: shouldAppendRecoveredTimeoutCloseoutVisibility, shouldAppendTimeoutContinuationVisibility, taskRequestsTimeoutContinuationCloseout, maybeAppendRecoveredTimeoutCloseoutVisibility, maybeAppendTimeoutContinuationVisibility, maybeAppendRequiredTimeoutFollowupVisibility — SessionEvidenceFact.completedAfterTimeout / .recoveryMarker / status='timeout'

### Group B — Approval / permission facts (target: PermissionEvidenceFact / approval_status)
*Producer = permission_* tool results + permission.* progress events.*
- enforceMissingApprovalGateRepairToolCalls — approval-gate-repair-applied flag (RepairLedger) + permission facts (`permission_(?:query|result|applied)` regex)
- normalizeApprovalGatedBrowserSpawnCalls — approval-gated + mutating-action classification + permission evidence
- shouldSuppressReadOnlyPermissionQueryToolCalls — read-only-vs-mutation TaskFacts + mutation-intent
- shouldRepairMissingApprovalGate — PermissionEvidenceFact.hasPermissionGateCall; requestsApprovalGatedBrowserAction :8966-8996
- shouldRepairPendingApprovalWaitTimeoutCheck — PermissionEvidenceFact.lastQueryPending
- shouldRepairPrematurePendingApprovalFinal — PermissionEvidenceFact.lastResultStatus (pending/approved/denied)
- shouldRepairStalePendingApproval — PermissionEvidenceFact.isApplied
- shouldRepairApprovalWaitTimeoutCloseout — PermissionEvidenceFact.waitTimeoutStatus; looksLikeCompleteApprovalWaitTimeoutCloseout :7713
- buildForcedPendingApprovalWaitTimeoutPermissionResultCall — latestPermissionQueryApprovalId / latestPermissionResultStatus
- onTerminate hook — CompletedSessionEvidence + SubAgentTimeoutSignal

### Group C — Browser-evidence dimension facts (target: BrowserEvidenceFact.{frames,shadowComponents,popups,productSignals,failureBucket,recoveryMetadata})
- shouldRepairMissingBrowserEvidence / _completed_rearm_s10 — BrowserEvidenceFact.completed/.attempted; browserEvidence.rendered/screenshots/visibleText
- shouldRepairMissingProductSignalBrowserEvidence / _completed_rearm_s10 — productSignals{rendered,metrics,url,title}
- shouldRepairMissingBrowserEvidenceDimensions / _completed_repair — frames/shadowComponents/popups/productSignals (4-dim negation-aware regex)
- maybeAppendBrowserRecoveryVisibility — recoveryMetadata (resume mode/reason)
- maybeAppendBrowserFailureBucketVisibility — failureBucket enum (collectBrowserFailureBucketNames :7077-7085)
- maybeAppendBrowserRecoveryResidualRiskVisibility — isBounded/.recoveryStatus

### Group D — Task-intent / TaskFacts classification (target: TaskFacts produced in T1)
- normalizeExplicitContinuationHistoryCalls — continuation-intent fact
- normalizeBoundedTimeoutSourceSpawnAgents / DuplicateSourceSpawns — browser-required-URL + timeout-source classification
- shouldSuppressToolsForAwaitingContextSetup — TaskPhase enum AWAITING_CONTEXT_SETUP / TaskFacts.isSetupOnly
- shouldContinueIndependentEvidenceStreams / limitIndependentEvidenceSpawnCalls — evidence-stream-count fact
- isExplicitSessionContinuationRequest — user-continuation-intent field (continue/resume/none)
- shouldRepairMissingRequestedNextAction / _completed_repair — TaskFacts.requestsNextAction
- findMissingRequiredFinalDeliverables / _completed_repair — TaskFacts.requiredDeliverables
- taskRequestsTimeoutContinuationCloseout — TaskFacts.explicitTimeoutCloseoutRequest

### Group E — URL classification facts (target: parsed-URL classifier producer)
- normalizePrivateUrlResearchSpawnCalls — private/loopback/public + browser-required-URL (containsPrivateOrLoopbackHttpUrl + toolCallTargetsBrowserRequiredUrl)
- normalizeLocalUrlWebFetchCalls — same (extractHttpUrls)
- normalizeBoundedTimeoutDuplicateSourceSpawns — URL dedup (normalizeUrlForComparison)

### Group F — Table-schema / column facts (target: ActivationInput.requestedTableColumns / intent.relayBrief)
- shouldRepairMissingRequestedTableColumns / _completed_repair — ActivationInput.requestedTableColumns; resolveRequestedTableColumns :7931-7935
- shouldRepairExtraneousProviderTableSchema / _completed_repair — ActivationInput.originalRequestedColumns; provider/search/model regex :8018-8033

### Group G — Source-bounded evidence & weak-synthesis facts (target: EvidenceLedger.sourceLabels + confidence level)
- shouldRepairSourceEvidenceCarryForward / source_evidence_carry_forward_completed_repair — EvidenceLedger.sourceLabels; multiAgentDecomposition/specialistAgents; extractCompletedSessionEvidenceLabels :8333-8347
- shouldRepairWeakEvidenceSynthesis / weak_evidence_synthesis_completed_repair — confidence: verified/partial/inferred/unsupported; hasUnsupportedSourceBoundedExtrapolation :8387-8421; WEAK_UNCERTAINTY/WEAK_ESTIMATE arrays
- shouldRepairFalseEvidenceBlockedSynthesis / _completed_repair — evidenceAccessible:bool, accessErrors[]; FALSE/ACTUAL pattern arrays
- collectSourceBoundedEvidenceText — typed source-evidence flags / EvidenceLedger marker
- extractSessionToolResultRecords — call parseSessionToolResult per record (structured toolTrace primary)
- looksLikeSourceBoundedEvidenceLine — producer scopeRestrictions[] (50+ alternation regex)

### Group H — Output-contract / finalization facts (target: OutputContract / RolePromptPacket)
- maybeRedactForbiddenLocalUrls / forbidsFinalUrls — OutputContract.forbiddenUriPatterns / RolePromptPacket.uriRedactionPolicy
- buildContinuationDirectiveContext — select session results by structured type vs `session_key`/`"sessions"` text filter

### Group I — Pseudo-tool-call form & pruning observability (target: LLMMessage metadata / CompactionSnapshot)
- pseudo_tool_call closeout — LLMMessage.toolCallAttemptForm / ToolUseBlockMetadata (containsAnyToolCallForm :7479-7481)
- summarizeToolResultPruning / recordToolResultPruningBoundarySafely — structured CompactionSnapshot return ('Earlier tool history compacted to fit' regex)

---

## 5. Deferred-fixture rows (for 8B/8F retirement)

Known deferred parity fixtures and the normalizer/appender each is blocked on. Retire as the listed blocker lands.

| Deferred fixture | Stage origin | Blocked on (normalizer / appender) | Layer | Notes |
|---|---|---|---|---|
| **branch-2 timed-out-sibling-coverage** | Stage 7 branch-2 | `shouldContinueTimedOutSiblingSession` (~:1585 / engine :3004) — needs `isCoverageCriticalDelegationTask` typed task-classification (Group D) to deterministically fire the sibling continuation | T5-continuation | engine mirrors inline but coverage-critical regex is fragile; fixture deferred until structured `coverageCritical` task field exists |
| **branch-3 supplemental-local-timeout-probe** | Stage 7 branch-3 | `enforceSupplementalLocalTimeoutProbeToolCall` (:473-484, gap) + `shouldRunSupplementalLocalTimeoutProbe` (~:1605, engine :3030) + `hasLatestSupplementalLocalTimeoutProbePrompt` literal string (~:6649) | T2-normalizer + T5-continuation | normalizer is INLINE-ONLY (engine does not call); blocked on `probeIsPending` structured field + content-poor timeout evidence facts (Group A) |
| **S9 post-execute missing-approval-gate** | Stage 7 S9 | `shouldRepairMissingApprovalGate` post-execute branch (~:1672 / engine :3112) + the missing approval-wait-timeout family `shouldRepairPendingApprovalWaitTimeoutCheck`/`PrematurePendingApprovalFinal`/`StalePendingApproval`/`ApprovalWaitTimeoutCloseout`/`ForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair` (:833-984, all gap, NOT in onRepairRound) | T4-permission + T9-repair | **this is the §1 Tier-1 fail cluster**; retire fixture only after the whole approval-wait-timeout family is ported and `PermissionEvidenceFact` (Group B) lands |
| **S10 product-signal** | Stage 7 S10 | `missing_product_signal_browser_evidence_completed_rearm_s10` (~:1907 / engine :3715-3736, round-0) + `shouldRepairMissingProductSignalBrowserEvidence` (:776-802 / engine :3265-3287) | T9-repair + S10 re-arm | engine handles round-0 only; round>0 passes undefined evidenceText. Blocked on structured `productSignals{rendered,metrics,url,title}` (Group C) |

Additional appender-deferred residual to track in 8F (T10): `maybeAppendBrowserRecoveryVisibility`, `maybeAppendBrowserFailureBucketVisibility`, `maybeAppendRequiredTimeoutFollowupVisibility`, `maybeAppendBrowserRecoveryResidualRiskVisibility` — all NOT ported to engine onTerminate (documented gap inline :3572-3593). The `timeout_followup_final_guidance_completed_repair` row notes engine :3969-3991 now mirrors *some* completed/timeout appenders, leaving the natural-finish appenders as the single residual.

---

## 6. Closeout & Repair Precedence Registries (ordered — these become 8G registries)

> **Do not reorder.** Transcribed exactly from the rows. There is no `CLOSEOUT_POLICY_REGISTRY` struct in current code — these ordered lists are the extraction target for Stage 8G.

### 6.1 CloseoutPolicyRegistry order (canonical inline-loop sequence)

Master precedence row: `Closeout precedence ordering` (inline :606-1355; engine onToolCallsClose :2706-2954; onAfterExecute :3175-3190).

Pre-execute / pending-call cascade (in `onToolCallsClose`, fires before any repair cascade):

1. **recovery_tool_budget** — inline :539,:611-618,:1390; engine :2706-2727. *Fires before empty-round continuation injection; re-checked post-injection (truncates pending calls).*
2. *(empty-round continuation injection happens here)*
3. **operator_cancelled** — inline :678-689,:685-691; engine :2738-2762. *calls.length>0 guard skips empty-round injection.*
4. **pseudo_tool_call** — inline :1035-1109,:1042-1048; engine :2763-2787. *empty-round-gated (calls.length===0 AND !pendingContinuation); skipped if continuation injects.*
5. **wall_clock_budget** — inline :1285-1320,:1291-1299; engine :2788-2829 (pending) + :2830-2878 (empty-round pre-check). *Pre-checks empty rounds to prevent past-budget injection.*
6. **repeated_tool_failure** — inline :1390-1420; engine :2881-2902. *(checked after wall_clock and round_limit checks per row precedence text.)*
7. **repeated_session_inspection** — inline :1435-1475; engine :2903-2929.
8. **excessive_session_continuation** — inline :1475-1515; engine :2930-2954. *Final pending-call check.*

Then **execute tool calls**, then post-execute closeouts:

9. **completed_sub_agent_final** (post-execute) — inline :1720-1728; engine :3508. *sticky toolLoopCloseout ??=.*
10. **sub_agent_timeout** (post-execute) — inline :2209-2219. *After completed check.*

End-of-loop:

11. **round_limit** — inline :1355-1363. *Checked AFTER wall_clock in inline (:1355); engine exits loop at round===maxRounds so onToolCallsClose skips it (:2880).*

Out-of-band (pre-empts loop):

- **tool_evidence_fallback** — inline :420-431. *The hard-closeout target of `shouldForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair` (:955-983) is **DONE on engine** (slice 1c, merged #524): `onRepairRound` returns `{closeout: "tool_evidence_fallback"}` and `onTerminate` builds the deterministic local-evidence closeout. The remaining gap is the **RequestEnvelopeOverflowError** trigger path (envelope overflow → fallback), which is Batch D (memory/compaction/envelope).*

All 11 reasons map through `missionTerminalStatusForCloseout` (:111-130): `completed_sub_agent_final`→completed; `wall_clock_budget`/`round_limit`/`sub_agent_timeout`/`repeated_session_inspection`/`excessive_session_continuation`/`tool_evidence_fallback`/`pseudo_tool_call`→(evidenceAvailable?partial:blocked); `operator_cancelled`/`repeated_tool_failure`/`recovery_tool_budget`→blocked.

### 6.2 Natural-finish repair cascade order (tool-free, onRepairRound + inline :1110-1252)

First-match-wins; each `!repairPrompt`-guarded so an earlier hit on the same round wins; each gated by its `recordRepairPrompt` idempotency marker.

1. **shouldRepairMissingBrowserEvidence** — S2/S3 forced-spawn (re-arms REAL sessions_spawn, consumesRound). inline :751-774 / :748; engine :3242-3264.
2. **shouldRepairMissingProductSignalBrowserEvidence** — S2/S3 forced-spawn; shares #1's idempotency marker (mutually exclusive per round). inline :776-802; engine :3265-3287.
3. **shouldRepairMissingApprovalGate** — S9 forced permission_query (consumesRound). inline :804-828; engine :3295-3317. *Marker also read by onToolCalls enforce-gate normalizer (repair↔normalizer bridge).*
4. *(inline-only approval-wait-timeout family, NOT in onRepairRound — all `gap`):*
   - **shouldRepairPendingApprovalWaitTimeoutCheck** — :833-853 (force permission_result)
   - **shouldRepairPrematurePendingApprovalFinal** — :855-878 (force permission_result)
   - **shouldRepairStalePendingApproval** — :880-903 (force sessions_spawn)
   - **shouldRepairApprovalWaitTimeoutCloseout** — :930-953 (tool-free synthesis)
   - **shouldForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair** — :955-983 (HARD closeout, breaks loop → tool_evidence_fallback)
5. **shouldRepairMissingRequestedTableColumns** — first tool-free synthesis repair. inline :1138-1164 / :1139; engine :3318-3343.
6. **shouldRepairExtraneousProviderTableSchema** — inline :1166-1191 / :1167; engine :3344-3367.
7. **shouldRepairSourceEvidenceCarryForward** — truthy-gated on sourceBoundedEvidenceText. inline :1202-1229; engine :3387-3412. *(partial — evidence formula diverges.)*
8. **shouldRepairWeakEvidenceSynthesis** — LAST tool-free repair. inline :1230-1252; engine :3413-3430.

*(Closeout-branch-only, NOT in natural-finish: `shouldRepairMissingBrowserEvidenceDimensions` — inline :720-745 (pseudo-tool-call closeout) + :1080-1107 (wall-clock/round-limit closeout), partial.)*

### 6.3 Completed-closeout repair cascade order (inline ~:1720-2181 runs ONCE; engine onTerminate ~:3436-4000, completed-only predicates gated to repairRound===0)

Cross-cascade members (run **every** round; also appear in 6.2):

- **missing_requested_table_columns_completed_repair** — FIRST. ~:1826 / build ~:1861. *round 0: completedProductBriefEvidenceText; round>0: sourceBoundedEvidenceText.*
- **extraneous_provider_table_schema_completed_repair** — SECOND. ~:1854 / build ~:1869.

S10 re-arm members (after extraneous in completed-block; round>0 BEFORE table-columns):

- **missing_browser_evidence_completed_rearm_s10** — ~:1880 / build ~:9047; engine :3643-3659 (round 0). RE-ARM sessions_spawn.
- **missing_product_signal_browser_evidence_completed_rearm_s10** — ~:1907 / build ~:9099; engine :3715-3736 (round 0). RE-ARM sessions_spawn.

Cross-cascade middle member (every round):

- **source_evidence_carry_forward_completed_repair** — ~:1941 / build ~:8267; engine :3825-3851.

Completed-ONLY members (repairRound===0 gated — prevents compound over-repair, per `completed_repair_round_gating_completed_only_predicates`):

- **timeout_followup_final_guidance_completed_repair** — ~:1968; engine :3871-3886. (after source-evidence, before next-action)
- **missing_requested_next_action_completed_repair** — ~:1995; engine :3889-3901. (after timeout-followup, before deliverables)
- **missing_required_final_deliverables_completed_repair** — ~:2016; engine :3903-3921. (after next-action, before browser-dimensions)
- **missing_browser_evidence_dimensions_completed_repair** — ~:2100; engine :3923-3938. (after deliverables, before false-evidence)
- **false_evidence_blocked_synthesis_completed_repair** — ~:2128; engine :3940-3953. (after browser-dimensions, before weak-evidence)

Cross-cascade last member (every round):

- **weak_evidence_synthesis_completed_repair** — LAST. ~:2153; engine :3970-3982.

Evidence-formula control rows that gate the above:
- **completed_product_brief_evidence_text_round_0_formula** (:1933-1938 / engine :3693-3705) — round-0 evidence = finalContents + completing-round results only.
- **source_bounded_evidence_text_round_gt0_formula** (:1192 / engine :3829-3838) — round>0 evidence = full toolTrace (closes the evidence-formula residual).
- **completed_repair_round_gating_completed_only_predicates** (engine :3875-3970) — gates completed-only predicates to repairRound===0.
- **completed_session_timeloop_closeout_metadata_sticky** (:1729 / engine :3507) — `toolLoopCloseout ??=` (completed) vs `=` (other); metadata sticks to first completion.
- **completed_closeout_result_overwrite_per_round** (:1784-1804 / engine :3969-3999) — `run.closeoutResult =` (overwrite) each onTerminate; text from last synthesis, metadata from first.

Final step both cascades: **maybeRedactForbiddenLocalUrls** (:7445-7464; inline :432/973/1815, engine :4065) — runs after all visibility appenders.
