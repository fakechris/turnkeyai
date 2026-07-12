# Effect Ledger Migration Slice

Status: implemented on `codex/effect-ledger-migration`; deterministic validation
complete. No real-model measurement and no policy migration are part of this
slice.

## Scope

This slice implements the first production mechanism required by
[Agent Execution Semantics](./agent-execution-semantics.md): stable effect
identity and durable `admitted -> started -> committed/failed/indeterminate`
transitions around native tool execution.

It does not change prompts, policy order, timeouts, retry policy, acceptance
harnesses, or final-answer quality behavior.

## Execution Boundary

The generic ReAct loop emits `tool_admitted` after validation/admission and
before `tool_started`. The role-runtime runner consumes lifecycle events in this
order:

```text
persist admitted
-> persist started
-> notify observer
-> dispatch external tool
-> persist result receipt
-> notify observer
```

Both normal agent tool rounds and runtime-forced tool rounds use this boundary.
Normal batch scheduling invokes the receipt boundary per call as soon as its
executor returns; it does not wait for the rest of the batch to finish.
Ledger persistence is fail-closed: an admitted/started write failure prevents
external dispatch. Observability remains non-authoritative.

## Restart Outcomes

| Durable state at crash | Resume outcome |
| --- | --- |
| No admitted record | No effect exists |
| `admitted` | Typed `effect_not_dispatched`; a new explicit proposal is safe |
| `started` plus durable native receipt | Restore the receipt |
| `started` plus adapter reconciliation receipt | Restore the reconciled receipt |
| `started` with no provable result | Typed `effect_indeterminate`; never redispatch automatically |
| `committed` or `failed` receipt | Restore the prior receipt |

Legacy pending native calls without a ledger record are treated conservatively
as `indeterminate`; the prior instruction telling the model to reissue the call
has been removed.

## Storage Bounds

The journal temporarily retains a full result only between tool return and the
next durable transcript checkpoint. Once the transcript contains the result,
the ledger releases its payload and keeps only stable identity and terminal
status. This preserves crash safety without bypassing existing artifact
externalization or duplicating large tool results for the life of the run.

## Reconciliation Contract

`RoleToolExecutor.reconcile` is an optional read-only lookup by stable effect
id. It must not dispatch work. Executors without this capability return no
proof and therefore use the safe `indeterminate` outcome.

## Structural Enforcement

Architecture guards require:

- composition wiring through `runJournal.effectLedger`;
- authoritative lifecycle persistence before observer callbacks;
- observer modules to remain free of effect-ledger authority;
- normal and forced execution to persist admission/start before dispatch.

## Deterministic Validation

Validated with the repository-supported Node.js `v24.14.0` runtime:

- `npm run typecheck`: pass;
- agent-core: 63/63;
- llm-adapter: 58/58;
- react-engine, including architecture guards: 383/383;
- response-generator, tool-use, and RunTrace replay: 317/317;
- execution-semantics simulator: 16/16;
- runtime-policy inventory: 2/2;
- `git diff --check`: pass.

No real LLM, acceptance fixture, or E2E threshold participated in validation.

## Remaining Work

This slice closes the effect crash window only. Durable scope/attempt clocks,
retry-allowance ownership, inbox/join, workflow runtime, and policy disposition
remain separate migration slices under the locked V2 sequence.
