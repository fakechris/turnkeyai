# Stage 8 Typed Facts And Evidence Producer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the remaining Stage 8 architecture target by replacing policy-owned text inference with typed fact/evidence producer boundaries, while preserving inline/engine behavior parity.

**Architecture:** Keep `runViaReActEngine` as the composition root and keep existing policy owner modules in `packages/role-runtime/src/react-engine/*`. Upgrade `EvidenceLedger` and `TaskFacts` from facade/shared-helper boundaries into typed producer contracts. Quarantine any still-required regex/text fallbacks in `legacy-text-detectors.ts` with explicit metadata and architecture guards, instead of spreading new detectors through policy modules.

**Tech Stack:** TypeScript, Node `tsx --test`, existing role-runtime parity harness, existing `react-engine` owner modules, markdown docs for inventory. No new runtime dependencies.

---

## Current Baseline

The current PR branch is `feat/stage8-engine-cleanup`.

Baseline commits:

- `e84b1103` moves approval wait-timeout fallback hook input gating into `TerminalCloseoutController`.
- `2bff0490` documents the Stage 8 adapter landing line.

Baseline gates from the current report:

| Gate | Expected Baseline |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx tsx --test packages/role-runtime/src/react-engine/*.test.ts` | 275 / 275 |
| `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts` | 272 / 272 |
| `npx tsx --test packages/agent-core/src/*.test.ts` | 53 / 53 |
| `npm run parity:inline` | 272 / 272 |
| `npm run parity:engine` | 272 / 272, all 14 chunks |
| `git diff --check` | clean |

## Non-Negotiable Rules

- Do not reopen adapter thinning as a general line-count project.
- Do not add new product-policy branches to `runViaReActEngine`.
- Do not move inline behavior behind `react-engine/*`; shared helpers used by inline and engine must live in neutral role-runtime modules.
- Do not make regex/text detectors authorize or execute side-effect tools.
- Do not silently rewrite broad regex behavior while claiming behavior neutrality.
- Do not start the next stage until the current stage has a commit, updated report/inventory, and the stage-specific gates listed below.
- Full gates are required before any push.

## Stage Overview

| Stage | Name | Purpose | Stop Condition |
| --- | --- | --- | --- |
| 1 | Inventory Lock | Freeze fact/detector ownership before more code migration. | Inventory table covers all current policy consumers and every row has producer, consumer, migration class, and stage assignment. |
| 2 | Evidence Producer | Turn completed-session, timeout, session-history, tool-result content, and usable-evidence reads into typed `EvidenceLedger` producer fields. | Owner modules consume typed evidence fields instead of raw helper reads for this fact family. |
| 3 | Permission Facts | Turn approval/permission state into typed facts consumed by repair, continuation, closeout, and model-error flows. | Approval/wait-timeout/stale-pending/denied policies consume typed permission facts or registered legacy fallbacks only. |
| 4 | Task Intent Facts | Turn task/activation intent detectors into typed `TaskFacts` producer fields. | Browser-visible, independent stream, timeout recovery, awaiting-context, and requested-deliverable policies consume typed task facts. |
| 5 | Legacy Detector Quarantine | Centralize remaining text fallbacks and enforce no new ad hoc detectors. | `legacy-text-detectors.ts` has real metadata-backed detector registry and architecture guards block unregistered policy regex. |

## Files By Responsibility

Modify existing files:

- `packages/role-runtime/src/react-engine/evidence-ledger.ts`: typed evidence producer contract and snapshots.
- `packages/role-runtime/src/react-engine/evidence-ledger.test.ts`: producer fixtures and compatibility tests.
- `packages/role-runtime/src/tool-result-evidence.ts`: neutral structured extraction helpers used by inline and engine.
- `packages/role-runtime/src/react-engine/task-facts.ts`: react-engine wrapper around neutral task facts.
- `packages/role-runtime/src/task-facts-shared.ts`: typed task intent producers shared by inline and engine.
- `packages/role-runtime/src/react-engine/task-facts.test.ts`: task fact fixtures.
- `packages/role-runtime/src/react-engine/legacy-text-detectors.ts`: fallback registry and metadata.
- `packages/role-runtime/src/react-engine/architecture-guard.test.ts`: import/regex ownership guards.
- `packages/role-runtime/src/react-engine/repair-policy-registry.ts`: consume typed facts instead of direct detector calls.
- `packages/role-runtime/src/react-engine/continuation-controller.ts`: consume typed facts for continuation decisions.
- `packages/role-runtime/src/react-engine/closeout-policy-registry.ts`: consume typed evidence/permission facts for closeout decisions.
- `packages/role-runtime/src/react-engine/terminal-closeout-controller.ts`: consume typed evidence/permission facts for terminal fallback behavior.
- `docs/STAGE8_CLEANUP_REPORT.md`: checkpoint status after each stage.

Create docs:

- `docs/STAGE8_TYPED_FACTS_INVENTORY.md`: authoritative inventory and migration tracker.

Do not create:

- A second adapter wrapper for `runViaReActEngine`.
- New unowned regex helper modules.
- New cross-package public API exports unless another package requires them.

---

## Stage 1: Inventory Lock

**Goal:** Stop discovering ownership during implementation. Build the fact/detector map first.

**Files:**

- Create: `docs/STAGE8_TYPED_FACTS_INVENTORY.md`
- Modify: `docs/STAGE8_CLEANUP_REPORT.md`

### Task 1.1: Create Inventory Document

- [ ] **Step 1: Create the inventory with fixed columns**

Create `docs/STAGE8_TYPED_FACTS_INVENTORY.md` with this structure:

```markdown
# Stage 8 Typed Facts Inventory

**Branch:** `feat/stage8-engine-cleanup`
**Status:** Stage 1 inventory lock
**Rule:** New policy code may consume typed facts or registered legacy fallbacks only.

## Migration Classes

| Class | Meaning |
| --- | --- |
| `already_structured` | Producer already exposes structured JSON/object data; migration should preserve exact behavior while typing the read. |
| `present_only_as_text` | Fact is currently only recoverable from text; keep compatibility through `legacy-text-detectors.ts` until producer changes. |
| `missing_from_producer` | Current producer does not expose the fact; do not infer stronger behavior in this PR. |

## Inventory

| Fact Family | Current Helper / Detector | Current Producer | Current Consumers | Migration Class | Target Typed Field | Stage | Required Tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| completed_session | `findCompletedSessionEvidence`, `readCompletedSessionEvidence` | `sessions_spawn`, `sessions_send`, `sessions_history` tool results | `CloseoutPolicyRegistry`, `ContinuationController`, `CompletedCloseoutController`, `TerminalCloseoutController` | `already_structured` | `EvidenceRoundSnapshot.completedSession`, `EvidenceSnapshot.completedSessions[]` | 2 | completed session final content, browser recovery summary, sessions_history fallback |
| sub_agent_timeout | `findSubAgentToolTimeout` | `sessions_spawn`, `sessions_send` tool results | `CloseoutPolicyRegistry`, `ContinuationController`, `ExecutionBudgetController`, finalization visibility | `already_structured` | `EvidenceRoundSnapshot.timeoutSignal`, `EvidenceSnapshot.timeoutSignals[]` | 2 | timeout seconds, agent id, evidence available, null when completed |
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
```

- [ ] **Step 2: Verify inventory references compile against current names**

Run:

```bash
rg -n "findCompletedSessionEvidence|findSubAgentToolTimeout|collectApprovalWaitTimeoutRuntimeEvidence|resolveRequestedTableColumns|shouldContinueIndependentEvidenceStreams|shouldSuppressToolsForAwaitingContextSetup" packages/role-runtime/src
```

Expected: every helper in the inventory is found.

- [ ] **Step 3: Update cleanup report**

Add a short section to `docs/STAGE8_CLEANUP_REPORT.md`:

```markdown
## Typed Facts Follow-Up Plan

The remaining architecture work is now tracked in
`docs/STAGE8_TYPED_FACTS_INVENTORY.md` and
`docs/superpowers/plans/2026-07-03-stage8-typed-facts-evidence-producer.md`.
No further adapter thinning should proceed until Stage 1 inventory is complete.
```

- [ ] **Step 4: Run docs checks**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Commit Stage 1**

```bash
git add docs/STAGE8_TYPED_FACTS_INVENTORY.md docs/STAGE8_CLEANUP_REPORT.md
git commit -m "docs(stage8): lock typed facts inventory"
```

**Stage 1 Stop Condition:** inventory exists, all rows have migration class and stage assignment, and no implementation code changed.

---

## Stage 2: Evidence Producer

**Goal:** Upgrade evidence reads that already come from structured tool/session results into typed producer fields.

**Files:**

- Modify: `packages/role-runtime/src/react-engine/evidence-ledger.ts`
- Modify: `packages/role-runtime/src/react-engine/evidence-ledger.test.ts`
- Modify: `packages/role-runtime/src/tool-result-evidence.ts`
- Modify only as consumers need typed fields: `continuation-controller.ts`, `closeout-policy-registry.ts`, `terminal-closeout-controller.ts`, `completed-closeout-controller.ts`
- Modify docs: `docs/STAGE8_TYPED_FACTS_INVENTORY.md`, `docs/STAGE8_CLEANUP_REPORT.md`

### Task 2.1: Add Typed Evidence Interfaces

- [ ] **Step 1: Write failing evidence-ledger tests**

Add tests to `packages/role-runtime/src/react-engine/evidence-ledger.test.ts`:

```ts
test("EvidenceLedger produces typed completed-session facts", () => {
  const ledger = createEvidenceLedger();
  const results = [
    {
      toolName: "sessions_spawn",
      content: JSON.stringify({
        status: "completed",
        session_key: "session-a",
        agent_id: "browser",
        final_content: "Observed checkout total: $42",
        payload: {
          browserRecovery: {
            finalUrl: "http://127.0.0.1:5173/checkout",
            title: "Checkout",
            screenshotPaths: ["/tmp/checkout.png"],
          },
        },
      }),
    } as RoleToolExecutionResult,
  ];

  const snapshot = ledger.currentRound(results);

  assert.equal(snapshot.completedSessions.length, 1);
  assert.equal(snapshot.completedSessions[0]?.sessionKey, "session-a");
  assert.equal(snapshot.completedSessions[0]?.agentId, "browser");
  assert.deepEqual(snapshot.completedSessions[0]?.finalContents, [
    "Observed checkout total: $42",
  ]);
});

test("EvidenceLedger produces typed timeout facts", () => {
  const ledger = createEvidenceLedger();
  const results = [
    {
      toolName: "sessions_send",
      content: JSON.stringify({
        status: "timeout",
        session_key: "session-b",
        agent_id: "source",
        timeout_seconds: 30,
        evidence_available: true,
      }),
    } as RoleToolExecutionResult,
  ];

  const snapshot = ledger.currentRound(results);

  assert.equal(snapshot.timeoutSignals.length, 1);
  assert.equal(snapshot.timeoutSignals[0]?.sessionKey, "session-b");
  assert.equal(snapshot.timeoutSignals[0]?.timeoutSeconds, 30);
  assert.equal(snapshot.timeoutSignals[0]?.evidenceAvailable, true);
});
```

Expected before implementation: FAIL because `completedSessions` and `timeoutSignals` do not exist.

- [ ] **Step 2: Implement typed evidence fields**

Add these interfaces to `evidence-ledger.ts`:

```ts
export interface CompletedSessionEvidenceFact {
  toolName: string;
  sessionKey?: string;
  agentId?: string;
  finalContents: string[];
  browserRecoverySummaries: string[];
}

export interface TimeoutEvidenceFact {
  toolName: string;
  sessionKey?: string;
  agentId?: string;
  timeoutSeconds: number | null;
  evidenceAvailable: boolean;
}
```

Extend `EvidenceRoundSnapshot`:

```ts
export interface EvidenceRoundSnapshot {
  toolResultContentText: string;
  completedSession: ReturnType<typeof findCompletedSessionEvidence>;
  completedSessions: readonly CompletedSessionEvidenceFact[];
  completedSessionFinalContents: readonly string[] | null;
  timeoutSignal: ReturnType<typeof findSubAgentToolTimeout>;
  timeoutSignals: readonly TimeoutEvidenceFact[];
}
```

Build typed arrays from the same existing helpers first. Do not change helper behavior in this task.

- [ ] **Step 3: Run focused tests**

Run:

```bash
npx tsx --test packages/role-runtime/src/react-engine/evidence-ledger.test.ts
```

Expected: all evidence-ledger tests pass.

### Task 2.2: Move Consumers To Typed Fields

- [ ] **Step 1: Add architecture guard**

Add a guard in `architecture-guard.test.ts` that fails if `continuation-controller.ts`, `closeout-policy-registry.ts`, or `completed-closeout-controller.ts` directly imports `findCompletedSessionEvidence` or `findSubAgentToolTimeout`.

Use this check shape:

```ts
test("engine policy owners consume completed/timeout facts through EvidenceLedger", () => {
  const offenders: string[] = [];
  for (const name of [
    "continuation-controller.ts",
    "closeout-policy-registry.ts",
    "completed-closeout-controller.ts",
  ]) {
    const source = readFileSync(path.join(ENGINE_DIR, name), "utf8");
    if (
      source.includes("findCompletedSessionEvidence") ||
      source.includes("findSubAgentToolTimeout")
    ) {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, []);
});
```

- [ ] **Step 2: Replace consumer reads**

Where a controller currently consumes `EvidenceRoundSnapshot.completedSession` or `timeoutSignal`, keep those compatibility fields if needed but prefer `completedSessions[0]` and `timeoutSignals[0]` in new code paths. Do not change precedence or null behavior.

- [ ] **Step 3: Run Stage 2 gates**

Run:

```bash
npm run typecheck
npx tsx --test packages/role-runtime/src/react-engine/evidence-ledger.test.ts
npx tsx --test packages/role-runtime/src/react-engine/continuation-controller.test.ts
npx tsx --test packages/role-runtime/src/react-engine/closeout-policy-registry.test.ts
npx tsx --test packages/role-runtime/src/react-engine/completed-closeout-controller.test.ts
npx tsx --test packages/role-runtime/src/react-engine/architecture-guard.test.ts
git diff --check
```

Expected: all pass.

- [ ] **Step 4: Commit Stage 2**

```bash
git add packages/role-runtime/src/react-engine/evidence-ledger.ts packages/role-runtime/src/react-engine/evidence-ledger.test.ts packages/role-runtime/src/react-engine/architecture-guard.test.ts packages/role-runtime/src/react-engine/continuation-controller.ts packages/role-runtime/src/react-engine/closeout-policy-registry.ts packages/role-runtime/src/react-engine/completed-closeout-controller.ts docs/STAGE8_TYPED_FACTS_INVENTORY.md docs/STAGE8_CLEANUP_REPORT.md
git commit -m "stage8 facts: type completed and timeout evidence"
```

**Stage 2 Stop Condition:** completed-session and timeout consumers read typed evidence fields or compatibility fields owned by `EvidenceLedger`; no raw completed/timeout detector imports remain in policy owners.

---

## Stage 3: Permission Facts

**Goal:** Make approval and permission state explicit before policy modules use it.

**Files:**

- Modify: `packages/role-runtime/src/react-engine/evidence-ledger.ts`
- Modify: `packages/role-runtime/src/react-engine/evidence-ledger.test.ts`
- Modify: `packages/role-runtime/src/react-engine/repair-policy-registry.ts`
- Modify: `packages/role-runtime/src/react-engine/continuation-controller.ts`
- Modify: `packages/role-runtime/src/react-engine/terminal-closeout-controller.ts`
- Modify: `packages/role-runtime/src/react-engine/legacy-text-detectors.ts` only for compatibility fallbacks.

### Task 3.1: Define Permission Facts

- [ ] **Step 1: Add failing tests**

Add tests to `evidence-ledger.test.ts`:

```ts
test("EvidenceLedger produces permission facts for pending wait-timeout evidence", () => {
  const ledger = createEvidenceLedger();
  const toolTrace = [
    {
      round: 0,
      results: [
        {
          toolName: "permission_query",
          content: "requested approval for browser.form.submit",
        },
        {
          toolName: "permission_result",
          content: "approval_wait_timeout: approval is still pending",
        },
      ],
    } as NativeToolRoundTrace,
  ];

  const snapshot = ledger.snapshot({
    taskPrompt: "Submit the form after approval.",
    messages: [],
    toolTrace,
  });

  assert.equal(snapshot.permission.latestStatus, "wait_timeout");
  assert.equal(snapshot.permission.pendingApproval, true);
  assert.match(snapshot.permission.runtimeEvidenceText, /approval_wait_timeout/);
});
```

Expected before implementation: FAIL because `permission` does not exist.

- [ ] **Step 2: Implement permission fact shape**

Add to `evidence-ledger.ts`:

```ts
export type PermissionStatus =
  | "none"
  | "pending"
  | "applied"
  | "denied"
  | "wait_timeout";

export interface PermissionEvidenceFacts {
  latestStatus: PermissionStatus;
  pendingApproval: boolean;
  appliedApproval: boolean;
  deniedApproval: boolean;
  waitTimeout: boolean;
  runtimeEvidenceText: string;
}
```

Extend `EvidenceSnapshot`:

```ts
permission: PermissionEvidenceFacts;
```

Initial implementation may derive from existing shared helpers and text readers. Mark any text-derived field in inventory as `present_only_as_text`.

- [ ] **Step 3: Replace approval policy inputs**

Update `RepairPolicyRegistry`, `ContinuationController`, and `TerminalCloseoutController` inputs so permission-related policies can accept `permissionFacts` from `EvidenceSnapshot`.

Do not remove legacy helper calls until focused parity tests pass. The first target policies are:

- `pending_approval_wait_timeout_check`
- `premature_pending_approval`
- `stale_pending_approval`
- `stale_denied_approval`
- `approval_wait_timeout_closeout`
- `approval_wait_timeout_local_closeout`
- model-error forced pending approval permission result

- [ ] **Step 4: Run Stage 3 focused gates**

```bash
npm run typecheck
npx tsx --test packages/role-runtime/src/react-engine/evidence-ledger.test.ts
npx tsx --test packages/role-runtime/src/react-engine/repair-policy-registry.test.ts
npx tsx --test packages/role-runtime/src/react-engine/continuation-controller.test.ts
npx tsx --test packages/role-runtime/src/react-engine/terminal-closeout-controller.test.ts
npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts
git diff --check
```

Expected: all pass.

- [ ] **Step 5: Commit Stage 3**

```bash
git add packages/role-runtime/src/react-engine/evidence-ledger.ts packages/role-runtime/src/react-engine/evidence-ledger.test.ts packages/role-runtime/src/react-engine/repair-policy-registry.ts packages/role-runtime/src/react-engine/continuation-controller.ts packages/role-runtime/src/react-engine/terminal-closeout-controller.ts docs/STAGE8_TYPED_FACTS_INVENTORY.md docs/STAGE8_CLEANUP_REPORT.md
git commit -m "stage8 facts: type permission evidence"
```

**Stage 3 Stop Condition:** permission/approval policy modules consume `PermissionEvidenceFacts` or registered legacy detector fallbacks; no new unregistered permission regex is added.

---

## Stage 4: Task Intent Facts

**Goal:** Make task/activation intent explicit before policies use it.

**Files:**

- Modify: `packages/role-runtime/src/task-facts-shared.ts`
- Modify: `packages/role-runtime/src/react-engine/task-facts.ts`
- Modify: `packages/role-runtime/src/react-engine/task-facts.test.ts`
- Modify consumers: `repair-policy-registry.ts`, `continuation-controller.ts`, `permission-policy.ts`, `tool-call-normalizer.ts`

### Task 4.1: Define TaskFacts Snapshot

- [ ] **Step 1: Add failing TaskFacts tests**

Add tests to `task-facts.test.ts`:

```ts
test("TaskFacts produces typed browser-visible and timeout recovery intent", () => {
  const facts = buildTaskFacts({
    taskPrompt:
      "Inspect the rendered checkout page in the browser and continue the timed-out source session if evidence is incomplete.",
    activation: undefined,
    messages: [],
  });

  assert.equal(facts.browserVisibleEvidenceRequired, true);
  assert.equal(facts.timeoutRecoveryRequested, true);
});

test("TaskFacts produces typed independent evidence stream requirements", () => {
  const facts = buildTaskFacts({
    taskPrompt:
      "Compare two independent sources and do not finalize until both streams complete.",
    activation: undefined,
    messages: [],
  });

  assert.equal(facts.requiredIndependentEvidenceStreams, 2);
});
```

Expected before implementation: FAIL because `buildTaskFacts` and these fields do not exist.

- [ ] **Step 2: Implement TaskFacts snapshot**

Add to `task-facts-shared.ts`:

```ts
export interface TaskFactsInput {
  taskPrompt: string;
  activation?: RoleActivationInput;
  messages: LLMMessage[];
}

export interface TaskFactsSnapshot {
  requestedTableColumns: string[];
  providerSupportSchemaRequested: boolean;
  browserVisibleEvidenceRequired: boolean;
  timeoutRecoveryRequested: boolean;
  awaitingContextSetupOnly: boolean;
  requiredIndependentEvidenceStreams: number;
}

export function buildTaskFacts(input: TaskFactsInput): TaskFactsSnapshot {
  const taskAndContext = [
    input.taskPrompt,
    ...buildRequestedTableColumnActivationContext(input.activation),
    ...requestedTableColumnMessageContext(input.messages),
  ];
  const requestedTableColumns = resolveRequestedTableColumns(taskAndContext);
  return {
    requestedTableColumns,
    providerSupportSchemaRequested: taskAndContext.some(
      explicitlyRequestsProviderSupportSchema,
    ),
    browserVisibleEvidenceRequired: /browser|rendered|visible|screenshot|页面|浏览器/i.test(
      taskAndContext.join("\n"),
    ),
    timeoutRecoveryRequested: /\bcontinue|resume|继续|恢复\b/i.test(
      taskAndContext.join("\n"),
    ) && /\btimeout|timed out|超时\b/i.test(taskAndContext.join("\n")),
    awaitingContextSetupOnly: taskPromptRequestsAwaitingContextSetup(
      input.taskPrompt,
    ),
    requiredIndependentEvidenceStreams:
      /\btwo independent sources\b|两个独立|two-source|both streams/i.test(
        taskAndContext.join("\n"),
      )
        ? 2
        : 0,
  };
}
```

This initial implementation intentionally preserves text-derived behavior and records it as `present_only_as_text` in the inventory.

- [ ] **Step 3: Migrate highest-risk consumers**

Migrate these consumers to accept a `TaskFactsSnapshot`:

- `PermissionPolicy.applySuppressToolCallsHook()` for `awaitingContextSetupOnly`.
- `ContinuationController` independent stream continuation.
- `RepairPolicyRegistry` browser-visible and product-signal evidence repairs.
- `ToolCallNormalizer` continuation context only when a typed field already exists.

- [ ] **Step 4: Run Stage 4 gates**

```bash
npm run typecheck
npx tsx --test packages/role-runtime/src/react-engine/task-facts.test.ts
npx tsx --test packages/role-runtime/src/react-engine/permission-policy.test.ts
npx tsx --test packages/role-runtime/src/react-engine/continuation-controller.test.ts
npx tsx --test packages/role-runtime/src/react-engine/repair-policy-registry.test.ts
npx tsx --test packages/role-runtime/src/react-engine/tool-call-normalizer.test.ts
npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts
git diff --check
```

Expected: all pass.

- [ ] **Step 5: Commit Stage 4**

```bash
git add packages/role-runtime/src/task-facts-shared.ts packages/role-runtime/src/react-engine/task-facts.ts packages/role-runtime/src/react-engine/task-facts.test.ts packages/role-runtime/src/react-engine/permission-policy.ts packages/role-runtime/src/react-engine/continuation-controller.ts packages/role-runtime/src/react-engine/repair-policy-registry.ts packages/role-runtime/src/react-engine/tool-call-normalizer.ts docs/STAGE8_TYPED_FACTS_INVENTORY.md docs/STAGE8_CLEANUP_REPORT.md
git commit -m "stage8 facts: type task intent facts"
```

**Stage 4 Stop Condition:** task intent consumers use `TaskFactsSnapshot` for the listed fields; remaining text-derived behavior is recorded as typed-facts debt, not hidden in policy code.

---

## Stage 5: Legacy Detector Quarantine And Enforcement

**Goal:** Make remaining regex/text fallback debt explicit, searchable, tested, and guarded.

**Files:**

- Modify: `packages/role-runtime/src/react-engine/legacy-text-detectors.ts`
- Add or modify: `packages/role-runtime/src/react-engine/legacy-text-detectors.test.ts`
- Modify: `packages/role-runtime/src/react-engine/architecture-guard.test.ts`
- Modify docs: `docs/STAGE8_TYPED_FACTS_INVENTORY.md`, `docs/STAGE8_CLEANUP_REPORT.md`

### Task 5.1: Implement Legacy Detector Registry

- [ ] **Step 1: Add failing registry tests**

Create `legacy-text-detectors.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_TEXT_DETECTORS,
  runLegacyTextDetector,
} from "./legacy-text-detectors";

test("legacy text detectors carry required migration metadata", () => {
  assert.ok(LEGACY_TEXT_DETECTORS.length > 0);
  for (const detector of LEGACY_TEXT_DETECTORS) {
    assert.ok(detector.id);
    assert.ok(detector.targetTypedField);
    assert.ok(detector.producer);
    assert.match(detector.feasibilityClass, /^(already_structured|present_only_as_text|missing_from_producer)$/);
    assert.ok(detector.inventoryRow);
    assert.ok(detector.positiveFixture.trim());
    assert.ok(detector.negativeFixture.trim());
  }
});

test("legacy text detector runner returns facts only", () => {
  const result = runLegacyTextDetector(
    "approval_wait_timeout_text",
    "permission_result: approval_wait_timeout and still pending",
  );

  assert.deepEqual(result, {
    id: "approval_wait_timeout_text",
    matched: true,
    fact: "approval_wait_timeout",
  });
});
```

Expected before implementation: FAIL because registry does not exist.

- [ ] **Step 2: Implement registry shape**

Replace the shell in `legacy-text-detectors.ts` with:

```ts
export const LEGACY_TEXT_DETECTORS_MODULE = "legacy-text-detectors" as const;

export type LegacyDetectorFeasibilityClass =
  | "already_structured"
  | "present_only_as_text"
  | "missing_from_producer";

export interface LegacyTextDetectorDefinition {
  id: string;
  targetTypedField: string;
  producer: string;
  feasibilityClass: LegacyDetectorFeasibilityClass;
  inventoryRow: string;
  positiveFixture: string;
  negativeFixture: string;
  detect(text: string): null | string;
}

export interface LegacyTextDetectorResult {
  id: string;
  matched: boolean;
  fact: string | null;
}

export const LEGACY_TEXT_DETECTORS: readonly LegacyTextDetectorDefinition[] = [
  {
    id: "approval_wait_timeout_text",
    targetTypedField: "PermissionEvidenceFacts.waitTimeout",
    producer: "permission_result tool output",
    feasibilityClass: "present_only_as_text",
    inventoryRow: "approval_wait_timeout",
    positiveFixture: "permission_result: approval_wait_timeout and still pending",
    negativeFixture: "permission_result: approved and applied",
    detect: (text) =>
      /\bapproval_wait_timeout\b|\bwait[- ]timeout\b/i.test(text)
        ? "approval_wait_timeout"
        : null,
  },
];

export function runLegacyTextDetector(
  id: string,
  text: string,
): LegacyTextDetectorResult {
  const detector = LEGACY_TEXT_DETECTORS.find((item) => item.id === id);
  if (!detector) {
    return { id, matched: false, fact: null };
  }
  const fact = detector.detect(text);
  return { id, matched: fact !== null, fact };
}
```

- [ ] **Step 3: Add architecture guard**

Add guard to `architecture-guard.test.ts`:

```ts
test("policy modules do not add unregistered regex detector branches", () => {
  const policyFiles = [
    "permission-policy.ts",
    "tool-call-normalizer.ts",
    "continuation-controller.ts",
    "closeout-policy-registry.ts",
    "repair-policy-registry.ts",
    "completed-closeout-controller.ts",
    "terminal-closeout-controller.ts",
  ];
  const offenders: string[] = [];
  for (const name of policyFiles) {
    const source = readFileSync(path.join(ENGINE_DIR, name), "utf8");
    if (/\/[^/\n]+\/[gimsuy]*/.test(source)) {
      offenders.push(name);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "new policy regex must move to typed facts or legacy-text-detectors metadata",
  );
});
```

If this guard is too broad because a policy file already has unavoidable regex, first move that regex into `legacy-text-detectors.ts` with metadata and focused fixtures. Do not weaken the guard to ignore new regex silently.

- [ ] **Step 4: Run Stage 5 gates**

```bash
npm run typecheck
npx tsx --test packages/role-runtime/src/react-engine/legacy-text-detectors.test.ts
npx tsx --test packages/role-runtime/src/react-engine/architecture-guard.test.ts
npx tsx --test packages/role-runtime/src/react-engine/*.test.ts
npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts
npx tsx --test packages/agent-core/src/*.test.ts
npm run parity:inline
npm run parity:engine
git diff --check
```

Expected: all pass.

- [ ] **Step 5: Commit Stage 5**

```bash
git add packages/role-runtime/src/react-engine/legacy-text-detectors.ts packages/role-runtime/src/react-engine/legacy-text-detectors.test.ts packages/role-runtime/src/react-engine/architecture-guard.test.ts docs/STAGE8_TYPED_FACTS_INVENTORY.md docs/STAGE8_CLEANUP_REPORT.md
git commit -m "stage8 facts: quarantine legacy text detectors"
```

**Stage 5 Stop Condition:** remaining text fallback behavior is registered, tested, and blocked from spreading into policy modules.

---

## Final Verification Before Push

Run the full required gates:

```bash
npm run typecheck
npx tsx --test packages/role-runtime/src/react-engine/*.test.ts
npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts
npx tsx --test packages/agent-core/src/*.test.ts
npm run parity:inline
npm run parity:engine
git diff --check
```

Expected final results must be recorded in `docs/STAGE8_CLEANUP_REPORT.md`.

Before pushing:

```bash
git status --short --branch
git log --oneline -8
```

Expected:

- working tree clean
- all 5 stage commits present
- branch still tracks `origin/feat/stage8-engine-cleanup`

## Execution Mode

Execute this plan one stage at a time. Do not batch stages together. At the end of each stage:

1. Run the stage-specific focused gates.
2. Update `docs/STAGE8_TYPED_FACTS_INVENTORY.md`.
3. Update `docs/STAGE8_CLEANUP_REPORT.md`.
4. Commit.
5. Re-evaluate whether the next stage still has the same scope before starting it.

The correct next action after this plan is Stage 1 only: create and commit the inventory lock.
