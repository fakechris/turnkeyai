# Stage 8 Engine Cleanup — Campaign Progress Report

**Branch:** `feat/stage8-engine-cleanup`
**Code HEAD before this docs-only report:** `8a27da3321bddc3bdac7c07c306552497ca40286`
**Date:** 2026-07-02

## Summary

The original cleanup campaign previously stopped after Batch 0/0.5 because Batch 1
could not move the normalizer without making the inline parity reference import from
`react-engine/*`. This run added and landed the missing prerequisite:

- **Batch 0.75:** extracted the shared text/url/session/browser/permission/finalization
  helper closure into neutral role-runtime shared code.
- **Batch 1 partial:** moved engine tool-call normalization order/pipeline into
  `react-engine/tool-call-normalizer.ts`, moved engine permission wrapper behavior into
  `react-engine/permission-policy.ts`, and moved the engine finalization epilogue order
  into `react-engine/finalization-pipeline.ts`.

The adapter is thinner, but the campaign is **not complete**. `runViaReActEngine` is
still an adapter-heavy bridge and still owns observability, execution budget,
continuation, closeout, repair, completed-closeout, and evidence/task-fact behavior.

## Commits Added After The Blocked Report

| Commit | Scope |
| --- | --- |
| `1600077` | Extract shared role-engine helper closure into `tool-loop-shared.ts`; amend the plan/spec with Batch 0.75 and the Rule 3 refinement. |
| `5181294` | Extract `ToolCallNormalizer` order/pipeline and `PermissionPolicy` wrapper; add focused module tests. |
| `8a27da3` | Extract `FinalizationPipeline` engine epilogue order; move shared finalization append/redaction helpers; add focused module tests. |

## Current Extracted Implementation

Real implementation now exists in:

- `react-engine/types.ts`
- `react-engine/engine-run-state.ts`
- `react-engine/policy-trace.ts`
- `react-engine/hook-policy-trace.ts`
- `react-engine/hook-orchestration-contract.ts`
- `react-engine/policy-trace-characterization.ts`
- `react-engine/tool-call-normalizer.ts`
- `react-engine/permission-policy.ts`
- `react-engine/finalization-pipeline.ts`
- `tool-loop-shared.ts` as the neutral shared helper module for inline + engine.

Still shell/deferred:

- `engine-run-observer.ts`
- `execution-budget-controller.ts`
- `continuation-controller.ts`
- `closeout-policy-registry.ts`
- `repair-policy-registry.ts`
- `completed-closeout-controller.ts`
- `evidence-ledger.ts`
- `task-facts.ts`
- `legacy-text-detectors.ts`

## Latest Gates

All gates below passed on the current code before the report update:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx tsx --test packages/role-runtime/src/react-engine/*.test.ts` | 19 / 19 |
| `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts` | 272 / 272 |
| `npx tsx --test packages/agent-core/src/react-agent.test.ts packages/agent-core/src/react-loop.test.ts` | 38 / 38 |
| `npm run parity:inline` | 270 / 270, 0 fail |
| `npm run parity:engine` | 231 / 231, 0 fail, 0 incomplete after individual recovery |
| `git diff --check` | clean |

Note: the parity runner's discovered count varies by mode/run because the default
runner uses chunk recovery and discovery filters; the invariant preserved here is
zero failures and zero incomplete tests after recovery.

## Is The Adapter Thin?

No. `runViaReActEngine` still begins at
`packages/role-runtime/src/llm-response-generator.ts:2441` and remains the composition
root plus several policy-heavy hook bodies. The main improvement is that three
Batch 1 boundaries are now real:

- `onToolCalls` delegates normalization to `normalizeEngineToolCalls`.
- approval-gate normalizer steps and read-only suppression route through
  `PermissionPolicy` in the engine path.
- the unconditional engine finalization epilogue routes through
  `finalizeEngineAnswer`.

## Remaining Work

Continue Batch 1 with the high-risk pieces:

- extract `EngineRunObserver` without changing `toolTrace`, runtime progress, native
  message persistence, and model-use metadata semantics;
- migrate the remaining mutable cross-hook `run` object to `EngineRunState`;
- then proceed to Batch 2+ for execution budget, continuation, closeout, repair,
  completed-closeout, evidence ledger, task facts, and final adapter thinning.

The branch is **not pushed**.
