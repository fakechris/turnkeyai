# Stage 8 Engine Cleanup Report

**Branch:** `feat/stage8-engine-cleanup`
**Date:** 2026-07-04

## What Landed

Stage 8 now has a producer-owned compatibility boundary instead of an active
`tool-loop-shared.ts` shadow policy body.

- `tool-loop-shared.ts` is now facade-only: one re-export line to the
  producer-side implementation. It no longer owns or exports `readLegacy*`
  detector bodies.
- `runtime-facts/policy-text-facts.ts` owns the behavior-preserving legacy text
  fallback implementation while typed producers continue to replace those
  fallbacks family by family.
- `runtime-policy/inline-policy-runner.ts` routes the inline runtime's repair,
  continuation, closeout, and permission-suppression booleans through the same
  fact builders and `runtime-policy/*-core.ts` selectors used by the engine
  path.
- `runtime-policy/renderers.ts` centralizes typed render-request construction,
  keeping policy cores on policy selection data instead of prompt/text-view
  assembly.
- `inline-policy-compat.ts` was deleted. Active inline/engine policy code no
  longer imports `tool-loop-shared.ts` or `readLegacy*` shims.
- `legacy-trace-importer.ts` and `legacyImporterOnly` detector metadata make the
  legacy detector registry an importer boundary, not a policy module API.
- `architecture-guard.test.ts` now enforces the real structure: no active
  runtime policy/fact boundary imports `tool-loop-shared.ts`, no active boundary
  uses `readLegacy*` or the deleted inline shim, inline policy booleans must
  route through `runtime-policy/inline-policy-runner.ts`, and
  `tool-loop-shared.ts` must remain facade-only.

## Remaining Debt

The remaining debt is typed-producer replacement work, not adapter thinning:

- `runtime-facts/policy-text-facts.ts` is still a large legacy compatibility
  producer. It preserves the old text fallback behavior in one owner module; it
  should be narrowed into smaller typed producers as upstream tool/session/
  permission payloads expose stronger structured fields.
- Some facts remain text-derived compatibility facts: weak/source-evidence
  synthesis, browser evidence dimensions, timeout follow-up wording, approval
  wait-timeout evidence text, and some task-intent phrasing.
- Final-synthesis text views still exist for rendering/finalization. They are
  separated from policy snapshots and guarded out of policy core inputs, but the
  evidence ledger is not yet a fully producer-owned typed evidence pipeline.

## Why The Adapter Is Acceptable Now

The unacceptable state was "renamed helpers still owned by
`tool-loop-shared.ts`, with inline calling an alias shim." That is no longer the
state.

`runViaReActEngine` remains a composition/wiring layer: it wires gateway/model
callbacks, feature flags, observer/run-state targets, forced-round execution,
and final `GeneratedRoleReply` assembly. Product-policy decisions for installed
hooks live behind owner controllers/registries and runtime-policy selectors.
The inline reference path still keeps its loop shape for parity, but its active
policy booleans now route through `runtime-policy/inline-policy-runner.ts`
instead of directly calling detector helpers.

## Gate Results

- `npm run typecheck`: pass, 0 TypeScript errors.
- `npx tsx --test packages/role-runtime/src/react-engine/*.test.ts`: pass,
  301 / 301.
- `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts`:
  pass, 272 / 272.
- `npx tsx --test packages/agent-core/src/*.test.ts`: pass, 53 / 53.
- `npm run parity:inline`: pass, 272 / 272.
- `npm run parity:engine`: pass, 272 / 272 across all 14 chunks.
- `git diff --check`: pass.
