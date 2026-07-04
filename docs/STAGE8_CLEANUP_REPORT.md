# Stage 8 Engine Cleanup Report

**Branch:** `feat/stage8-engine-cleanup`
**Date:** 2026-07-04

## What Landed

Stage 8 now has a typed runtime-facts layer and a runtime-policy layer that make
the ReAct engine adapter a composition/wiring boundary instead of a
product-policy body.

- `runtime-facts/*` now produces task intent, session evidence, permission
  evidence, browser evidence, usable evidence, envelopes, provenance, policy
  snapshots, round snapshots, and final-synthesis text views.
- `react-engine/evidence-ledger.ts` is now an engine-facing wrapper over
  `RuntimeFactBundle` / `RuntimeRoundFactBundle`; it does not import
  `tool-loop-shared.ts`.
- `runtime-policy/*-core.ts` owns the pure decision selection for repair,
  continuation, permission suppression, and closeout policy facts.
- Installed ReAct hooks now delegate product-policy decisions through owner
  modules: `RepairPolicyRegistry`, `ContinuationController`,
  `CloseoutPolicyRegistry`, `PermissionPolicy`, `CompletedCloseoutController`,
  and `TerminalCloseoutController`.
- `runViaReActEngine` keeps composition responsibilities: dependency
  injection, gateway/model callbacks, forced-round execution callbacks, feature
  flags, run-state wiring, observer wiring, and final `GeneratedRoleReply`
  assembly.
- Inline parity remains behavior-neutral. The active inline path no longer calls
  public `shouldRepair*`, `shouldContinue*`, `shouldSuppress*`,
  `taskRequests*`, `taskRequires*`, `mentions*`, `latestPermission*`,
  `hasPermission*`, or `collect*Evidence*` helper names directly; it routes
  through neutral runtime-facts/task-facts compatibility entrypoints.
- `tool-loop-shared.ts` and `task-facts-shared.ts` no longer export core Stage 8
  helper names matching the guarded pattern. The guard now checks both
  `export function` and exported value aliases, so const aliases cannot
  reintroduce the shadow API.

## Remaining Debt

The remaining debt is now explicit and guarded rather than spread through policy
modules:

- Several producer-local compatibility paths still call `readLegacy*` utilities
  for legacy text fallback and final-synthesis evidence text views. These are
  behavior-preserving wrappers around old detector semantics; they are no
  longer exported under core product-policy names, but they should be moved into
  first-class typed producers or deleted when the inline runtime is retired.
- Some policy facts are still text-derived compatibility facts rather than fully
  structured facts. The biggest examples are weak/source-evidence synthesis
  repairs, browser evidence dimension repairs, timeout-followup wording repairs,
  and final recovery budget closeout wording.
- `EvidenceLedger` is a typed bundle facade with provenance, but it is not yet a
  complete producer-owned evidence pipeline where every final-synthesis input is
  structured before rendering. Final text views are intentionally separated from
  policy snapshots and remain render/finalization inputs only.

This means the adapter cleanup landing line is complete, but full typed-facts
producerization is not. The next architectural stage should remove the
`readLegacy*` compatibility layer by either making inline consume the same typed
runner/policy path directly or retiring inline once the engine is the only
runtime.

## Why The Adapter Is Acceptable Now

The remaining adapter code composes owner modules and passes dependencies. It no
longer steps through installed-hook product-policy branches directly. Policy
decisions are selected from typed policy fact builders and runtime-policy cores;
rendering/final text is separated from policy snapshots; and architecture guards
make regressions visible in CI.

The acceptable boundary is:

- adapter: wires gateway/model/tool callbacks, run state, feature flags,
  observers, forced execution, and final response assembly;
- facts: produce typed evidence and final text views;
- policy cores/registries/controllers: select and apply product-policy
  decisions;
- final synthesis/rendering: may consume text views, but policy core inputs may
  not.

## Gate Results

- `npm run typecheck`: pass, 0 TypeScript errors.
- `npx tsx --test packages/role-runtime/src/react-engine/*.test.ts`: pass,
  295 / 295.
- `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts`:
  pass, 272 / 272.
- `npx tsx --test packages/agent-core/src/*.test.ts`: pass, 53 / 53.
- `npm run parity:inline`: pass, 272 / 272.
- `npm run parity:engine`: pass, 272 / 272 across all 14 chunks.
- `git diff --check`: pass.
