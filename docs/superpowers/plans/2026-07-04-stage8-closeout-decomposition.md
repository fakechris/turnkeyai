# Stage 8 Closeout: policy-text-facts Decomposition And Boundary Ratchet

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `runtime-facts/policy-text-facts.ts` (6753 lines, 250 exported functions, zero internal structure) from a relocated monolith into four responsibility-scoped modules, close the last completion-contract violation (task-language detectors called directly by inline), and install ratchet guards so the boundary can only tighten, never loosen.

**Architecture invariant this plan protects:** producers parse, policy cores decide, renderers render, adapters wire. Format changes land in producers; product-rule changes land in policy cores; prompt changes land in renderers. Nothing else moves when those change. That is what makes this architecture stable long-term.

**Tech Stack:** TypeScript, Node `tsx --test`, existing parity harness. No new runtime dependency. Every task is behavior-neutral and parity-gated.

---

## Current State (measured, 2026-07-04, HEAD 4e4c6c59)

`policy-text-facts.ts` export census (250 exported functions, no section comments, 15 regex literals):

| Bucket | Count | Examples | Correct home |
| --- | --- | --- | --- |
| Prompt builders (`build*Prompt`) | 23 | `buildMissingBrowserEvidenceRepairPrompt` | `runtime-policy/prompt-renderers.ts` |
| Other builders (forced calls, directive contexts) | 11 | `buildForcedPendingApprovalWaitTimeoutPermissionResultCall`, `buildContinuationDirectiveContext` | `runtime-policy/prompt-renderers.ts` |
| Visibility appenders (`maybeAppend*`, `shouldAppend*`) | 8 | `maybeAppendTimeoutContinuationVisibility` | `runtime-policy/synthesis-visibility.ts` |
| Task-language detectors (`taskPrompt*`, `taskLooksLike*`, `taskAllows*`, `requestsApproval*`, `expects*`, plus `is*Task` classifiers hiding in misc) | ~14 | `taskPromptSaysApprovalAlreadyApplied`, `isTwoSourceComparisonTask`, `isCoverageCriticalDelegationTask` | absorbed into `task-intent-producer.ts` |
| Other text detectors (`should*`, `mentions*`, `disclaims*`) | ~5 | `shouldRunSupplementalLocalTimeoutProbe`, `shouldPreserveRecoveredTimeoutCloseout` | `runtime-facts/text-fallback-readers.ts`, wrapped by policy cores |
| Readers (`read*`, `find*`, `collect*`, `has*Evidence`, `latest*`, `count*`, `infer*`, `extract*`, `summarize*`) | ~86 | `readPolicySourceBoundedEvidenceText`, `findIncompleteApprovedBrowserSession` | `runtime-facts/text-fallback-readers.ts` |
| Repair-marker idempotency checks (`has*RepairPrompt`, `has*ContinuationPrompt`) | ~20 (inside misc) | `hasMissingApprovalGateRepairPrompt` | `runtime-facts/repair-marker-facts.ts` |
| Protocol/format neutral utils (`to*`, `parse*`, `sliceUtf8`, `normalize*`, `redact*`, `throwIfAborted`, `escapeRegExp`, …) | ~31 | `toNativeToolResultTrace`, `parseJsonObject`, `sliceUtf8` | `packages/role-runtime/src/tool-protocol.ts` (NOT under runtime-facts) |
| Remaining misc | ~50 | `containsAnyToolCallForm`, `isControlPlaneToolResultName`, `limitIndependentEvidenceSpawnCalls` | triaged per-name in Task 4 census |

Known contract violation still open: `llm-response-generator.ts` imports ~106 names from `policy-text-facts.ts` directly, including task-language detectors (`taskPromptRequestsApprovalWaitTimeoutCloseout`, `taskPromptIsAppliedApprovalBrowserContinuation`, `taskPromptSaysApprovalAlreadyApplied`, `taskPromptLooksLikeSourceCheckContinuation`, `requestsApprovalGatedBrowserAction`, `expectsExactFinalAnswerShape`) and non-pattern decision predicates (`shouldCloseoutCancelledSessionWithoutContinuation`, `shouldRunSupplementalLocalTimeoutProbe`, `shouldPreserveRecoveredTimeoutCloseout`, `shouldAppend*`). The Stage 8 contract says task-language parsing belongs to `TaskIntentProducer` only.

Known transitional debt: inline decision ordering still lives in `llm-response-generator.ts` call structure (`inline-policy-runner` is called per-branch with `enabledPolicies: [one]`), while engine uses `RUNTIME_*_POLICY_ORDER` tables. Predicates are unified; orchestration is not.

## Completion Contract

This plan is complete only when all statements below are true:

- `runtime-facts/policy-text-facts.ts` no longer exists. Its 250 exports are distributed across exactly these homes: `runtime-facts/text-fallback-readers.ts`, `runtime-facts/repair-marker-facts.ts`, `runtime-policy/prompt-renderers.ts`, `runtime-policy/synthesis-visibility.ts`, `tool-protocol.ts`, `task-intent-producer.ts` (absorbed), or deleted as dead code.
- No active-runtime module outside `task-intent-producer.ts` exports or calls a task-language detector. The `taskPrompt*` / `is*Task` / `expects*` / `requestsApproval*` family is absorbed as `TaskIntentFacts` fields or producer-internal helpers.
- `llm-response-generator.ts` imports from the fact/render layers only through an explicit allowlist guard. Adding any import name to the allowlist fails CI unless the same commit shrinks another allowlist entry or the name is in the render/protocol category.
- Module dependency direction is guard-enforced: `tool-protocol` imports none of the other four; `text-fallback-readers` and `repair-marker-facts` may import `tool-protocol` only; `prompt-renderers` and `synthesis-visibility` may import facts modules and text views; policy cores import facts types only; nothing imports `policy-text-facts` (it is gone).
- A ratchet guard pins the export count of `text-fallback-readers.ts` and `repair-marker-facts.ts` to a checked-in budget file that may only decrease. Every typed-producer replacement that lands must shrink the budget in the same commit.
- An ordering-consistency tripwire test asserts that the sequence of policy checks in the inline path matches the relevant `RUNTIME_*_POLICY_ORDER` prefix, so inline/engine ordering divergence fails CI instead of waiting for parity to catch it.
- `tool-loop-shared.ts` facade is deleted after its 4 remaining importers (`tool-result-evidence.ts`, `tool-definition-filter.ts`, `tool-history-pruning.ts`, `tool-use.ts`) are re-pointed to the new modules.
- All gates pass: typecheck, focused tests, full role-runtime tests, `parity:inline`, `parity:engine`, architecture guards, `git diff --check`. No intentional behavior change anywhere in this plan.

Out of scope (Stage 9, documented in report, not silently dropped): inline ordering unification (single `select*` call with full policy order), inline path retirement after engine becomes default, typed render-request payloads replacing string-threading, decomposing `llm-response-generator.ts` itself.

## Non-Negotiable Rules

- Every move is `git mv`-style mechanical relocation plus import rewrites. Zero logic edits inside moved function bodies. If a function needs a logic change, stop and record it; do not bundle it into a move commit.
- Run `npm run parity:inline` and `npm run parity:engine` after every task that touches active runtime imports, not only at the end.
- Ratchet guards land BEFORE the decomposition starts (Task 1), so the split cannot regress mid-flight.
- Do not weaken any existing guard. Do not add allowlist entries without a same-commit written justification in the guard file.
- Do not push until all gates pass.

---

## Task 1: Ratchet Guards First

**Files:**

- Modify: `packages/role-runtime/src/react-engine/architecture-guard.test.ts`
- Create: `packages/role-runtime/src/react-engine/fact-export-budget.json`

- [ ] **Step 1.1: Snapshot the import allowlist for llm-response-generator**

Generate the current import list mechanically:

```bash
awk '/^import \{/{on=1} on{print} /policy-text-facts";$/{on=0}' packages/role-runtime/src/llm-response-generator.ts
```

Add to `architecture-guard.test.ts`:

```ts
const INLINE_ADAPTER_FACT_IMPORT_ALLOWLIST = new Set<string>([
  // snapshot of the ~106 current names, one per line, grouped by
  // category comment: renderer / protocol / reader / DETECTOR(temporary)
]);

test("inline adapter fact imports stay inside the allowlist", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const imported = importedNamesFrom(source, [
    "./runtime-facts/policy-text-facts",
    "./runtime-facts/text-fallback-readers",
    "./runtime-facts/repair-marker-facts",
    "./runtime-policy/prompt-renderers",
    "./runtime-policy/synthesis-visibility",
    "./tool-protocol",
  ]);
  const offenders = imported.filter(
    (name) => !INLINE_ADAPTER_FACT_IMPORT_ALLOWLIST.has(name),
  );
  assert.deepEqual(offenders, [], `new fact-layer imports need explicit review: ${offenders.join(", ")}`);
});
```

`importedNamesFrom` parses `import { a, b } from "<path>"` blocks for the listed module paths (both old and future names so the guard survives Task 3's renames). Names in the allowlist tagged `DETECTOR(temporary)` must be removed by Task 2; the guard file comment must say so.

- [ ] **Step 1.2: Add the export budget ratchet**

Create `fact-export-budget.json`:

```json
{
  "runtime-facts/policy-text-facts.ts": 250,
  "runtime-facts/text-fallback-readers.ts": 0,
  "runtime-facts/repair-marker-facts.ts": 0
}
```

Add to `architecture-guard.test.ts`:

```ts
test("text fallback export budget only shrinks", () => {
  const budget = JSON.parse(
    readFileSync(path.join(ENGINE_DIR, "fact-export-budget.json"), "utf8"),
  ) as Record<string, number>;
  for (const [rel, max] of Object.entries(budget)) {
    const file = path.join(ROLE_RUNTIME_DIR, rel);
    if (!existsSync(file)) continue; // deleted file = budget row retired next commit
    const count = exportedRuntimeNames(readFileSync(file, "utf8")).length;
    assert.ok(
      count <= max,
      `${rel} exports ${count} > budget ${max}; typed replacements must shrink, never grow`,
    );
  }
});
```

Rule recorded in the guard file: lowering a budget number is the ONLY allowed edit direction; raising requires deleting this test (which review will reject).

- [ ] **Step 1.3: Add the ordering-consistency tripwire**

Add a test that extracts the sequence of `read*Repair(` call names from `llm-response-generator.ts` (source order) and asserts it is a subsequence-compatible mapping of `RUNTIME_NATURAL_FINISH_REPAIR_POLICY_ORDER` / `RUNTIME_COMPLETED_SYNTHESIS_REPAIR_POLICY_ORDER` from `repair-policy-core.ts` (map each `readXRepair` to its policyId via the same table `inline-policy-runner.ts` uses). If inline checks policies in a different relative order than the core's table, fail with both sequences printed.

- [ ] **Step 1.4: Run guards, confirm green, commit**

```bash
npx tsx --test packages/role-runtime/src/react-engine/architecture-guard.test.ts
git add packages/role-runtime/src/react-engine/architecture-guard.test.ts packages/role-runtime/src/react-engine/fact-export-budget.json
git commit -m "guard(stage8): ratchet fact-layer boundary before decomposition"
```

These guards must be green against the CURRENT tree (they snapshot reality). If any is red, the snapshot is wrong; fix the snapshot, not the code.

---

## Task 2: Close The Task-Language Contract Violation

**Files:**

- Modify: `packages/role-runtime/src/runtime-facts/task-intent-producer.ts`
- Modify: `packages/role-runtime/src/runtime-facts/task-intent-producer.test.ts`
- Modify: `packages/role-runtime/src/runtime-facts/types.ts`
- Modify: `packages/role-runtime/src/runtime-policy/inline-policy-runner.ts`
- Modify: `packages/role-runtime/src/llm-response-generator.ts`
- Modify: `packages/role-runtime/src/react-engine/architecture-guard.test.ts`

- [ ] **Step 2.1: Census the task-language family**

```bash
rg -n "export function (taskPrompt|taskLooksLike|taskAllows|requestsApproval|expects|is[A-Z][A-Za-z]*Task)" packages/role-runtime/src/runtime-facts/policy-text-facts.ts
```

Expected ~14 functions. For each, record its call sites (`rg -n "<name>\(" packages/role-runtime/src --glob '!*.test.ts'`).

- [ ] **Step 2.2: Absorb into TaskIntentFacts**

For each detector, add a typed field to `TaskIntentFacts` (e.g. `approvalWaitTimeoutCloseoutRequested: boolean`, `appliedApprovalBrowserContinuation: boolean`, `sourceCheckContinuation: boolean`, `exactFinalAnswerShapeExpected: boolean`, `twoSourceComparison: boolean`, `coverageCriticalDelegation: boolean`, `permissionToolsAllowed: boolean`). Move the regex bodies into `task-intent-producer.ts` as private functions. Producer tests: one positive and one negative fixture per new field, reusing each detector's current fixture language.

- [ ] **Step 2.3: Cut call sites to facts**

Inline call sites read the new fields from the task-intent envelope already available in scope (or via one `produceTaskIntentEnvelope` call at the top of the loop, mirroring what `inline-policy-runner` does). Engine call sites (if any — check `rg` from 2.1) read the same fields from their existing `TaskIntentFacts` input. Delete the detector exports from `policy-text-facts.ts`, lower the budget number in the same commit, and remove the `DETECTOR(temporary)` entries from the Task 1 allowlist.

- [ ] **Step 2.4: Add the permanent guard**

Extend the helper-reference guard pattern with the task-language prefixes so the family cannot re-appear outside the producer:

```ts
/\b(taskPrompt[A-Za-z0-9_]*|taskLooksLike[A-Za-z0-9_]*|taskAllows[A-Za-z0-9_]*|requestsApproval[A-Za-z0-9_]*|expectsExact[A-Za-z0-9_]*)\s*\(/g
```

scanned over `llm-response-generator.ts`, all `react-engine/*.ts` policy files, and `runtime-policy/*.ts` except type-only usage inside `task-intent-producer.ts`.

- [ ] **Step 2.5: Gates and commit**

```bash
npm run typecheck
npx tsx --test packages/role-runtime/src/runtime-facts/*.test.ts packages/role-runtime/src/react-engine/*.test.ts packages/role-runtime/src/llm-response-generator.test.ts
npm run parity:inline
npm run parity:engine
git add -A && git commit -m "fix(stage8): absorb task-language detectors into TaskIntentProducer"
```

---

## Task 3: Split policy-text-facts Into Responsibility Modules

Mechanical relocation only. One commit per destination module, parity after each. Order chosen so each step only needs already-moved dependencies.

**Files created:**

- `packages/role-runtime/src/tool-protocol.ts`
- `packages/role-runtime/src/runtime-facts/text-fallback-readers.ts`
- `packages/role-runtime/src/runtime-facts/repair-marker-facts.ts`
- `packages/role-runtime/src/runtime-policy/prompt-renderers.ts`
- `packages/role-runtime/src/runtime-policy/synthesis-visibility.ts`

- [ ] **Step 3.1: Extract `tool-protocol.ts` (~31 fns)**

Move the neutral utils (`to*`, `parse*`, `sliceUtf8`, `normalize*`, `redact*`, `trim*`, `throwIfAborted`, `escapeRegExp`, `uniqueHttpUrlCount`, `containsAnyToolCallForm`, `isControlPlaneToolResultName`, …). Rule for membership: the function reads tool wire formats or strings generically and mentions NO Stage 8 fact family concept (approval, browser, timeout, evidence, session, schema). `policy-text-facts.ts` re-exports them temporarily so this commit only moves code. Commit: `refactor(stage8): extract neutral tool-protocol utils`. Gates: typecheck + role-runtime tests + parity both.

- [ ] **Step 3.2: Extract `runtime-policy/prompt-renderers.ts` (23 + 11 fns) and `synthesis-visibility.ts` (8 fns)**

Move all `build*Prompt`, forced-call builders, directive-context builders into `prompt-renderers.ts`; move `maybeAppend*`/`shouldAppend*` into `synthesis-visibility.ts`. Update the engine owners and inline adapter imports to the new paths (allowed: these are render-side). Merge the existing 13-line `renderers.ts` into `prompt-renderers.ts` and delete it. Commit + gates as above.

- [ ] **Step 3.3: Extract `repair-marker-facts.ts` (~20 fns) and `text-fallback-readers.ts` (rest)**

`has*RepairPrompt`/`has*ContinuationPrompt` marker checks go to `repair-marker-facts.ts`. Every remaining reader/detector goes to `text-fallback-readers.ts`. Set their budget rows in `fact-export-budget.json` to the actual counts; delete the `policy-text-facts.ts` budget row.

- [ ] **Step 3.4: Delete `policy-text-facts.ts` and re-point the facade**

After 3.1–3.3, `policy-text-facts.ts` should be pure re-exports. Re-point every importer to the concrete module (mechanical, per-file). Change `tool-loop-shared.ts` facade to re-export the five new modules. Delete `policy-text-facts.ts`. Update the Task 1 guard module-path list. Commit + full gates.

- [ ] **Step 3.5: Add inter-module dependency guards**

```ts
// tool-protocol imports nothing from runtime-facts / runtime-policy
// text-fallback-readers + repair-marker-facts import tool-protocol only
// prompt-renderers + synthesis-visibility may import runtime-facts modules
// runtime-policy/*-core.ts import runtime-facts TYPES only (no readers)
```

Implement as import-path scans in `architecture-guard.test.ts`, same style as the existing tool-loop-shared direction guard.

---

## Task 4: Retire The Facade And Close Out

**Files:**

- Modify: `packages/role-runtime/src/tool-result-evidence.ts`, `tool-definition-filter.ts`, `tool-history-pruning.ts`, `tool-use.ts`
- Delete: `packages/role-runtime/src/tool-loop-shared.ts`, `tool-loop-shared.test.ts` (coverage must already live in the new modules' tests)
- Modify: `docs/STAGE8_CLEANUP_REPORT.md`, `docs/STAGE8_TYPED_FACTS_INVENTORY.md`

- [ ] **Step 4.1: Re-point the 4 facade importers to concrete modules, delete the facade and its guard exemptions.**
- [ ] **Step 4.2: Update the inventory**: every row's producer column must name one of the five concrete modules or a typed producer; the `text-fallback-readers` budget number is recorded as the remaining-debt metric.
- [ ] **Step 4.3: Update the report** with sections `## Decomposition Landing`, `## Export Budget Baseline`, `## Stage 9 Entry Criteria` (inline ordering unification; inline retirement; typed render payloads; each with its tripwire/budget owner).
- [ ] **Step 4.4: Full gates, then push**

```bash
npm run typecheck
npx tsx --test packages/role-runtime/src/runtime-facts/*.test.ts packages/role-runtime/src/runtime-policy/*.test.ts packages/role-runtime/src/react-engine/*.test.ts packages/role-runtime/src/llm-response-generator.test.ts
npx tsx --test packages/agent-core/src/*.test.ts
npm run parity:inline
npm run parity:engine
git diff --check
git push
```

---

## How Future Change Lands After This Plan (the stability argument)

- A model/tool output format changes → touch one producer in `runtime-facts/`, budget unaffected, policies untouched.
- A product rule changes (when to repair/continue/close) → touch one `runtime-policy/*-core.ts` table or predicate, facts untouched, prompts untouched.
- A prompt wording changes → touch `prompt-renderers.ts` only.
- A legacy text fallback gets a typed replacement → producer gains a structured path, one export deleted from `text-fallback-readers.ts`, budget number decreases. The budget file is the burn-down chart.
- Someone tries to shortcut any of the above → an import-direction guard, the allowlist guard, the budget ratchet, or the ordering tripwire goes red in CI.

## Review Questions Before Implementation

- Is `tool-protocol.ts` at package root (not under `runtime-facts/`) accepted as the home for neutral utils?
- Is the per-name allowlist for `llm-response-generator.ts` imports acceptable maintenance cost (it shrinks over time)?
- Is deferring inline ordering unification to Stage 9 acceptable given the tripwire test lands now?

## Stop Condition

Stop when the completion contract holds and gates pass. Do not start typed-producer replacement of individual fallback readers inside this plan (that is the ongoing burn-down the budget file tracks). Do not begin Stage 9 items. If any move requires a logic edit to keep tests green, stop and report — that is a behavior dependency the plan must know about, not something to patch silently.
