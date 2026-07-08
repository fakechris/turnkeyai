# Stage 8 Typed Facts Inventory

**Branch:** `feat/stage8-engine-cleanup`
**Status:** Stage 8 closeout decomposition landed
**Rule:** New policy code may consume typed facts or registered legacy fallbacks only.

## Stage Checkpoints

| Stage | Status | Notes |
| --- | --- | --- |
| 1 | Complete | Inventory rows are locked with producer, consumer, migration class, target field, stage, and required tests. |
| 2 | Complete | `EvidenceLedger.currentRound()` now produces typed `completedSessions[]` and `timeoutSignals[]`; singular completed/timeout fields are compatibility values derived from those typed facts. `ContinuationController` and `CloseoutPolicyRegistry` consume the typed arrays in their installed hooks. |
| 3 | Complete | `EvidenceSnapshot.permission` now owns wait-timeout-compatible, pending, applied, and denied permission facts. These facts intentionally preserve text/runtime-progress compatibility until the permission producer is fully typed upstream. |
| 4 | Complete | `TaskFactsSnapshot` now owns requested table/provider-schema, browser-visible, product-signal dashboard, timeout-recovery, awaiting-context, and required independent-stream intent facts. The browser/stream/timeout fields remain text-derived compatibility facts until upstream producers expose stronger typed signals. |
| 5 | Complete | `legacy-text-detectors.ts` now has a metadata-backed detector registry with positive/negative fixtures and `legacyImporterOnly` metadata. `legacy-trace-importer.ts` is the importer boundary. `architecture-guard.test.ts` blocks new regex detector branches in policy owner modules. |
| 8 | Complete | Active inline/engine policy booleans no longer import `tool-loop-shared.ts`, `policy-text-facts.ts`, or renamed legacy shims. Both facade files are deleted. `runtime-policy/inline-policy-runner.ts` routes inline decisions through policy cores, and structural guards pin dependency direction, import allowlists, export budgets, and inline/core ordering compatibility. |

## Migration Classes

| Class | Meaning |
| --- | --- |
| `already_structured` | Producer already exposes structured JSON/object data; migration should preserve exact behavior while typing the read. |
| `present_only_as_text` | Fact is currently only recoverable from text; keep compatibility through `legacy-text-detectors.ts` until producer changes. |
| `missing_from_producer` | Current producer does not expose the fact; do not infer stronger behavior in this PR. |

## Inventory

| Fact Family | Current Helper / Detector | Current Producer | Current Consumers | Migration Class | Target Typed Field | Stage | Required Tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| completed_session | `findCompletedSessionEvidence`, `readCompletedSessionEvidence` | `sessions_spawn`, `sessions_send`, `sessions_history` tool results | `CloseoutPolicyRegistry`, `ContinuationController`, `CompletedCloseoutController`, `TerminalCloseoutController` | `already_structured` | `EvidenceRoundSnapshot.completedSessions[]`; compatibility `completedSession` and `completedSessionFinalContents` derive from typed facts | 2 | completed session final content, browser recovery summary, sessions_history fallback |
| sub_agent_timeout | `findSubAgentToolTimeout` | `sessions_spawn`, `sessions_send` tool results | `CloseoutPolicyRegistry`, `ContinuationController`, `ExecutionBudgetController`, finalization visibility | `already_structured` | `EvidenceRoundSnapshot.timeoutSignals[]`; compatibility `timeoutSignal` derives from typed facts | 2 | timeout seconds, agent id, evidence available, null when completed |
| tool_result_content | `collectToolResultContentText`, `collectToolTraceResultContent` | native tool result content | terminal fallback, completed synthesis, final response builder | `already_structured` | `EvidenceRoundSnapshot.toolResultContentText`, `EvidenceSnapshot.toolTraceResultContent` | 2 | skipped/error exclusion rules remain unchanged |
| usable_evidence | `hasUsableEvidence` | native tool trace results | model-error fallback, terminal fallback | `already_structured` | `EvidenceSnapshot.usableEvidence` | 2 | skipped/error-only false, any non-skipped non-error true |
| approval_wait_timeout | `collectApprovalWaitTimeoutRuntimeEvidence`, permission-result string readers | `permission_query`, `permission_result`, tool trace/progress text | `RepairPolicyRegistry`, `ContinuationController`, `TerminalCloseoutController` | `present_only_as_text` until permission result producer is typed | `EvidenceSnapshot.permission.waitTimeout`, `pendingApproval`, `runtimeEvidenceText` | 3 | pending, applied, denied, timeout, no-result |
| approval_applied_denied | `isAppliedApprovalBrowserContinuation`, permission-result status readers | permission result output and runtime progress | stale pending/denied repair, incomplete approved-browser repair | `present_only_as_text` | `EvidenceSnapshot.permission.latestStatus`, `appliedApproval`, `deniedApproval` | 3 | applied progress event, denied result, stale pending not false-positive |
| requested_table_schema | `resolveRequestedTableColumns`, provider schema helpers | task prompt, activation, recent user messages | `RepairPolicyRegistry`, local evidence fallback | `already_structured` after current TaskFacts extraction | `TaskFactsSnapshot.requestedTableColumns`, `providerSupportSchemaRequested` | 4 complete | existing TaskFacts tests |
| browser_visible_requirement | `allowsSupplementalBrowserProbe`, browser evidence repair detectors | task prompt, activation, tool evidence | `RepairPolicyRegistry`, `ContinuationController`, closeout visibility | `present_only_as_text` | `TaskFactsSnapshot.browserVisibleEvidenceRequired`, `productSignalDashboardEvidenceRequested` | 4 complete | loopback rendered page, static fixture, public URL, private URL |
| independent_evidence_streams | `shouldContinueIndependentEvidenceStreams` and stream-count detectors | task prompt, completed sessions, tool trace | `ContinuationController`, `ToolCallNormalizer` | `present_only_as_text` for required count; completed-stream evidence still follows legacy session evidence | `TaskFactsSnapshot.requiredIndependentEvidenceStreams`; future `EvidenceSnapshot.completedStreamLabels[]` remains debt | 4 complete / evidence debt | two-source comparison, AsiaWalk streams, continued session not new stream |
| timeout_recovery_intent | timeout continuation directive helpers | task prompt, messages, timeout result | `ContinuationController`, finalization visibility | `present_only_as_text`; typed intent produced but not used to rewrite bounded-timeout routing in this stage | `TaskFactsSnapshot.timeoutRecoveryRequested`; future `EvidenceSnapshot.resumableTimeouts[]` remains debt | 4 complete / evidence debt | explicit continue, no timeout JSON, listed session |
| awaiting_context_setup | `shouldSuppressToolsForAwaitingContextSetup` | task prompt | `PermissionPolicy` | `present_only_as_text` | `TaskFactsSnapshot.awaitingContextSetupOnly` | 4 complete | setup-only no-tool suppression and memory recall negative |
| legacy_fallbacks | producer-owned compatibility functions in `runtime-facts/text-fallback-readers.ts`; repair idempotency markers in `runtime-facts/repair-marker-facts.ts`; render-only text effects in `runtime-policy/prompt-renderers.ts` and `runtime-policy/synthesis-visibility.ts` | mixed text messages/tool payloads | `runtime-facts/*`, `runtime-policy/inline-policy-runner.ts`, engine owner modules through typed facts/policy cores | mixed | `LEGACY_TEXT_DETECTORS` registry rows plus the fallback export budget; future narrower typed producers replace each fallback family and lower the budget | 5/8 complete; typed replacement debt remains | `legacy-text-detectors.test.ts`, `legacy-trace-importer.test.ts`, `text-fallback-readers.test.ts`, architecture guard no-new-policy-regex/no-tool-loop/no-policy-text-facts/no-readLegacy/no-inline-shim |

## Export Budget

The checked-in budget is the remaining typed-facts burn-down metric:

| Module | Budget | Meaning |
| --- | ---: | --- |
| `runtime-facts/text-fallback-readers.ts` | 169 | Legacy fallback reader/predicate exports still awaiting narrower typed producers. |
| `runtime-facts/repair-marker-facts.ts` | 9 | Prompt idempotency marker readers. |

The architecture guard allows these numbers to stay flat or shrink only. Any
typed replacement must lower the relevant budget in the same commit.

## Stage 9 Bake Fallback Additions

These entries were added during the Stage 9 engine-default bake. They remain in
the legacy fallback pool and must be burned down by narrower typed producers or
typed render payloads before lowering the export budget.

| Export | Current owner | Why it exists | Burn-down direction |
| --- | --- | --- | --- |
| `readPolicyCoordinatorRoleHandoffEcho` | `runtime-facts/text-fallback-readers.ts` | Detects coordinator handoff protocol echoes in final text so terminal synthesis can replace them with user-facing evidence. | Typed renderer/final-output guard should expose a coordinator-handoff artifact flag instead of scanning final text. |
| `VendorPriceEvidenceFact` | `runtime-facts/text-fallback-readers.ts` | Temporary shape for vendor-price facts parsed from evidence text. | Move vendor price facts into a structured provider/vendor evidence producer. |
| `extractPolicyVendorPriceEvidenceFacts` | `runtime-facts/text-fallback-readers.ts` | Extracts vendor price facts from text evidence during comparison repair. | Replace with producer-owned vendor pricing facts from tool result payloads. |
| `resultPreservesPolicyVendorPriceFact` | `runtime-facts/text-fallback-readers.ts` | Checks whether a final answer preserved source-backed vendor prices. | Replace with typed final-answer coverage over vendor pricing facts. |
| `sessionContinuationRequestForbidsSessionTools` | `runtime-facts/text-fallback-readers.ts` | Detects user follow-up wording that asks for final synthesis from existing evidence only. | Add a typed continuation intent field on `TaskIntentFacts`. |
| `normalizeLoopbackSpawnCallUrls` | `runtime-facts/text-fallback-readers.ts` | Normalizes loopback browser/explore spawn URLs for fixture-backed bake scenarios. | Move URL normalization into a neutral protocol/input normalizer outside text fallback readers. |
