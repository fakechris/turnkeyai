# Runtime Policy Authority Migration Slice

Status: complete on `codex/v2-production-migration`.

## Landed

- Repair, continuation, and task-text permission production factories no longer
  manufacture tool calls, continuation rounds, or answer rewrites.
- Tool-call normalization now retains only `sessionToolAlias` and
  `sessionToolCalls`; task wording cannot silently replace a proposed effect.
- Closeout authority retains only `operator_cancelled`, `wall_clock_budget`,
  `round_limit`, and `model_error` as typed kernel outcomes. Product synthesis,
  repeated-call heuristics, child completion, and timeout policy closeouts are
  retired from the production registry.
- Approval decisions still durably record the decision and mechanically apply
  the permission cache. They no longer post a hidden follow-up prompt or launch
  an automatic browser continuation.
- The original 50 inventory rows remain explicit in
  `runtime-policy-inventory.json`. Every row names its final owner, migration
  status, and deterministic test evidence.

Legacy selectors and golden fixtures are retained as characterization, not as
production authority. The characterization entry points are explicit, and a
guard rejects their use from any other production module. This preserves the
historical failure corpus without preserving the old control plane.

## Deterministic Gates

- `npm run typecheck`: pass
- agent-core: 64/64
- llm-adapter: 60/60
- react-engine: 393/393
- llm-response-generator + tool-use: 315/315
- role-runtime support: 302/302
- core-types + team-runtime + team-store: 202/202
- app-gateway: 699 pass, 0 fail, 1 existing skip
- runtime-policy inventory/authority guard: 4/4
- execution-semantics simulator: 17/17
- `git diff --check`: pass

## Measurement

The fixed-version MiniMax-M3 measurement is recorded in
`docs/STAGE9_V2_CLOSURE_REPORT.md`. It stopped at the first model-selection
failure as required; no production policy was restored and no scenario patch
was made.
