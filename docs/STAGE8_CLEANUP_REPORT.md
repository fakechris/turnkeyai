# Stage 8 Engine Cleanup Report

**Branch:** `feat/stage8-engine-cleanup`
**Date:** 2026-07-04

## What Landed

Stage 8 now has concrete fact/render/protocol ownership instead of relocated
monolith facades.

- `runtime-facts/policy-text-facts.ts` was deleted. Its behavior-preserving
  exports were distributed to `runtime-facts/text-fallback-readers.ts`,
  `runtime-facts/repair-marker-facts.ts`, `runtime-policy/prompt-renderers.ts`,
  `runtime-policy/synthesis-visibility.ts`, and package-root
  `tool-protocol.ts`.
- `tool-loop-shared.ts` was deleted. The remaining importers
  (`tool-result-evidence.ts`, `tool-definition-filter.ts`,
  `tool-history-pruning.ts`, `tool-use.ts`) now import concrete owner modules.
- Task-language detectors were absorbed into `TaskIntentProducer`, and active
  policy/adapter code is guarded from calling the old `taskPrompt*` /
  `requestsApproval*` / exact-shape detector family.
- Inline and engine policy booleans route through shared
  `runtime-policy/*-core.ts` selectors and `runtime-policy/inline-policy-runner.ts`.
  Inline still keeps its loop orchestration shape for parity; the policy
  predicates and policy order are pinned by guards.
- `architecture-guard.test.ts` now enforces non-bypassable structure: retired
  facades stay deleted, facts/protocol cannot depend upward on runtime-policy,
  policy cores may only type-import fact shapes, inline fact imports are
  allowlisted, the fallback export budget cannot grow, and inline repair order
  must stay compatible with policy-core order.

## Decomposition Landing

The current split is:

- `tool-protocol.ts`: neutral wire/protocol utilities and shared context helpers.
- `runtime-facts/text-fallback-readers.ts`: registered legacy text fallback
  readers and compatibility predicates that still need typed producer burn-down.
- `runtime-facts/repair-marker-facts.ts`: idempotency marker readers for repair
  and continuation prompts.
- `runtime-policy/prompt-renderers.ts`: prompt, forced-call, and local closeout
  rendering.
- `runtime-policy/synthesis-visibility.ts`: final-synthesis visibility and
  redaction effects.

There is no active `policy-text-facts.ts` or `tool-loop-shared.ts` owner left.

## Export Budget Baseline

The remaining fallback budget is checked in at
`packages/role-runtime/src/react-engine/fact-export-budget.json`:

- `runtime-facts/text-fallback-readers.ts`: 169 exports.
- `runtime-facts/repair-marker-facts.ts`: 9 exports.

Future typed-producer replacements must reduce this budget in the same commit.
Raising it is intentionally a guard failure.

## Remaining Debt

The remaining debt is producerization, not adapter thinning:

- `text-fallback-readers.ts` still contains the text-derived compatibility
  fallback pool. These are now contained and budgeted, but not all converted to
  structured producers.
- `EvidenceLedger` is a typed read boundary, not a full producer-owned typed
  evidence pipeline. Several evidence families still derive from text views or
  compatibility readers.
- Final-synthesis text views are isolated from policy core inputs, but render
  payloads still carry strings in places where Stage 9 should introduce typed
  render-request payloads.
- Inline ordering is guarded against diverging from policy-core order, but
  inline has not been rewritten into one full-order selector call. That remains
  Stage 9 work or disappears when inline is retired.

## Why The Adapter Is Acceptable Now

The old failure mode was "policy logic still lives in a renamed shared body and
guards pass because names changed." That is no longer the state: the old shared
bodies are gone, importers point at concrete owner modules, and CI guards the
module direction rather than helper names alone.

`runViaReActEngine` remains responsible for composition, dependency injection,
gateway/model callbacks, feature flags, observer/run-state targets,
forced-round execution wiring, and final `GeneratedRoleReply` assembly. Product
policy decisions for installed hooks live behind owner controllers/registries,
typed fact builders, and `runtime-policy/*-core.ts` selectors.

## Stage 9 Entry Criteria

Stage 9 should start only when it targets one of these explicit debts:

- Convert fallback families from `text-fallback-readers.ts` into structured
  producers and lower the export budget.
- Turn `EvidenceLedger` into a producer-owned typed evidence pipeline with
  provenance carried through the ledger.
- Replace string-threaded render requests with typed render payloads.
- Unify inline orchestration behind full policy-order selectors, or retire the
  inline path after engine becomes the only runtime.

## Gate Results

- `npm run typecheck`: pass, 0 TypeScript errors.
- `npx tsx --test packages/role-runtime/src/react-engine/*.test.ts`: pass,
  307 / 307.
- `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts`:
  pass, 272 / 272.
- `npx tsx --test packages/agent-core/src/*.test.ts`: pass, 53 / 53.
- `npm run parity:inline`: pass, 272 / 272.
- `npm run parity:engine`: pass, 271 / 271 across all 14 chunks.
- `git diff --check`: pass.
