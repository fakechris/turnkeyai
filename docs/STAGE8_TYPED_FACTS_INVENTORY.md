# Stage 8 Typed Facts Inventory

**Branch:** `feat/stage8-engine-cleanup`
**Status:** Stage 2 evidence producer checkpoint
**Rule:** New policy code may consume typed facts or registered legacy fallbacks only.

## Stage Checkpoints

| Stage | Status | Notes |
| --- | --- | --- |
| 1 | Complete | Inventory rows are locked with producer, consumer, migration class, target field, stage, and required tests. |
| 2 | Complete | `EvidenceLedger.currentRound()` now produces typed `completedSessions[]` and `timeoutSignals[]`; singular completed/timeout fields are compatibility values derived from those typed facts. `ContinuationController` and `CloseoutPolicyRegistry` consume the typed arrays in their installed hooks. |
| 3 | Pending | Permission facts still rely on text/runtime progress fallbacks until `PermissionFacts` owns wait-timeout, pending, applied, and denied state. |
| 4 | Pending | Task intent facts beyond requested table/provider-schema remain detector-backed until `TaskFacts` owns the browser-visible, stream, timeout-recovery, and context-setup facts. |
| 5 | Pending | Remaining text detectors still need registry metadata and no-new-regex guards in `legacy-text-detectors.ts`. |

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
| approval_wait_timeout | `collectApprovalWaitTimeoutRuntimeEvidence`, permission-result string readers | `permission_query`, `permission_result`, tool trace/progress text | `RepairPolicyRegistry`, `ContinuationController`, `TerminalCloseoutController` | `present_only_as_text` until permission result producer is typed | `PermissionFacts.waitTimeout`, `PermissionFacts.pendingApproval` | 3 | pending, applied, denied, timeout, no-result |
| approval_applied_denied | `isAppliedApprovalBrowserContinuation`, permission-result status readers | permission result output and runtime progress | stale pending/denied repair, incomplete approved-browser repair | `present_only_as_text` | `PermissionFacts.latestStatus`, `PermissionFacts.appliedBrowserAction` | 3 | applied progress event, denied result, stale pending not false-positive |
| requested_table_schema | `resolveRequestedTableColumns`, provider schema helpers | task prompt, activation, recent user messages | `RepairPolicyRegistry`, local evidence fallback | `already_structured` after current TaskFacts extraction | `TaskFacts.requestedTableColumns`, `TaskFacts.providerSupportSchemaRequested` | 4 | existing TaskFacts tests |
| browser_visible_requirement | `allowsSupplementalBrowserProbe`, browser evidence repair detectors | task prompt, activation, tool evidence | `RepairPolicyRegistry`, `ContinuationController`, closeout visibility | `present_only_as_text` | `TaskFacts.browserVisibleEvidenceRequired` | 4 | loopback rendered page, static fixture, public URL, private URL |
| independent_evidence_streams | `shouldContinueIndependentEvidenceStreams` and stream-count detectors | task prompt, completed sessions, tool trace | `ContinuationController` | `present_only_as_text` | `TaskFacts.requiredIndependentEvidenceStreams`, `EvidenceSnapshot.completedStreamLabels[]` | 4 | two-source comparison, AsiaWalk streams, continued session not new stream |
| timeout_recovery_intent | timeout continuation directive helpers | task prompt, messages, timeout result | `ContinuationController`, finalization visibility | `present_only_as_text` | `TaskFacts.timeoutRecoveryRequested`, `EvidenceSnapshot.resumableTimeouts[]` | 4 | explicit continue, no timeout JSON, listed session |
| awaiting_context_setup | `shouldSuppressToolsForAwaitingContextSetup` | task prompt | `PermissionPolicy` | `present_only_as_text` | `TaskFacts.awaitingContextSetupOnly` | 4 | setup-only no-tool suppression and memory recall negative |
| legacy_fallbacks | scattered regex/text helpers in `tool-loop-shared.ts` | mixed text messages/tool payloads | all policy owners | mixed | registered `LegacyTextDetector` rows | 5 | registry metadata plus positive/negative fixtures |
