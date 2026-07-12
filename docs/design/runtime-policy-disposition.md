# Runtime Policy Disposition

Status: production authority migration complete. This table prevents the execution-semantics
migration from silently deleting hard-won behavior or preserving business
recovery inside the kernel.

The inventory preserves the policy families inherited from `origin/main` and
the clock/retry slice: 20 repair ids, 4 continuation ids, 12 closeout ids, 1
permission suppression id, and 13 remaining tool-call normalization steps. The machine-readable
source is [runtime-policy-inventory.json](./runtime-policy-inventory.json), and
`npm run test:runtime-policy-disposition` verifies original-row parity, the
exact production authority set, a target owner, and executable deterministic
evidence for every entry.

Production now retains only syntactic/session-handle normalization and typed
kernel terminal outcomes. Retired automatic actions remain available solely as
test characterization; a source guard forbids enabling that mode from any
other production composition point.

## Disposition Rules

Each policy has exactly one target:

- **kernel safety**: deterministic permission, protocol, ownership, or budget
  enforcement;
- **adapter normalization**: translate provider/tool protocol into typed facts;
- **transcript mechanism**: preserve protocol or evidence across compaction;
- **model guidance**: prompts and tool descriptions that help a model choose;
- **explicit workflow**: user-authored or product-declared recovery steps;
- **quality evaluator**: read-only scoring and diagnostics;
- **delete automatic action**: retain measurement if useful, but stop injecting
  work or rewriting a terminal answer.

Facts may remain useful after their policy action is removed. `TaskIntentFacts`
is a proposal-layer input for guidance or workflow construction; it is not
kernel authority.

## Natural-Finish Repair Policies

| Current policy | Current automatic action | Target owner | Required migration |
| --- | --- | --- | --- |
| `final_recovery_budget_closeout_repair` | Rewrite after recovery budget exhaustion | kernel safety + model guidance | Kernel emits typed `budget_exhausted`; model may answer from it. Delete automatic repair round. |
| `missing_browser_evidence` | Force `sessions_spawn` | quality evaluator + model guidance | Keep missing-evidence measurement and improve tool guidance. Delete automatic spawn. |
| `missing_product_signal_browser_evidence` | Force `sessions_spawn` | quality evaluator + model guidance | Same as missing browser evidence; no task-text authority in kernel. |
| `missing_approval_gate` | Force `permission_query` | kernel safety | Reject or suspend unauthorized effect with typed permission state. The model may explicitly query; kernel does not manufacture the query. |
| `pending_approval_wait_timeout_check` | Force `permission_result` | explicit workflow | Approval workflow may subscribe to a durable permission notification. Delete model-loop polling injection. |
| `premature_pending_approval` | Force `permission_result` | kernel safety + explicit workflow | Kernel preserves pending state; workflow decides whether and when to poll or wake. |
| `stale_pending_approval` | Force browser/session round | adapter normalization + explicit workflow | Permission service produces typed stale state. Workflow may request refresh; no text-derived forced action. |
| `stale_denied_approval` | Resynthesize answer | model guidance | Deliver typed denied state to the model. Delete automatic answer rewrite. |
| `approval_wait_timeout_closeout` | Resynthesize timeout closeout | model guidance | Expose typed wait outcome and durable handle; let the model close the attempt. |
| `approval_wait_timeout_local_closeout` | Local closeout | kernel completion | Suspension returns `not_ready` plus handle. Delete product-text local answer synthesis. |
| `incomplete_approved_browser_action` | Force `sessions_spawn` | explicit workflow + quality evaluator | A declared approved-action workflow may own a required step. Otherwise measure incomplete work; do not infer and spawn. |
| `missing_requested_table_columns` | Resynthesize answer | quality evaluator + model guidance | Keep typed requested-output schema and evaluator. Delete automatic rewrite. |
| `extraneous_provider_table_schema` | Resynthesize answer | adapter normalization + quality evaluator | Normalize provider metadata before the model where mechanical; evaluate answer shape separately. |
| `source_evidence_carry_forward` | Resynthesize with prior evidence | transcript mechanism | Preserve typed evidence in checkpoint/transcript projection. Delete repair prompt used to recover lost context. |
| `weak_evidence_synthesis` | Resynthesize answer | quality evaluator + model guidance | Keep a read-only quality signal. Delete automatic resynthesis. |

## Completed-Synthesis Repair Policies

| Current policy | Current automatic action | Target owner | Required migration |
| --- | --- | --- | --- |
| `timeout_followup_final_guidance` | Resynthesize final answer | model guidance | Include typed timeout/result handles in normal model input. Delete post-terminal rewrite. |
| `missing_requested_next_action` | Resynthesize final answer | quality evaluator | Measure contract adherence; do not reopen a completed attempt. |
| `missing_required_final_deliverables` | Resynthesize final answer | quality evaluator + explicit workflow | A workflow may declare required artifacts before completion. Otherwise evaluate only. |
| `missing_browser_evidence_dimensions` | Resynthesize final answer | quality evaluator | Measure evidence coverage; do not create runtime work. |
| `false_evidence_blocked_synthesis` | Resynthesize final answer | quality evaluator + model guidance | Provide typed evidence availability before generation; retain post-hoc detection only as evaluation. |

## Continuation Policies

| Current policy | Current automatic action | Target owner | Required migration |
| --- | --- | --- | --- |
| `approved_browser_timeout_continuation` | Continue timed-out browser session | explicit workflow | Return durable session handle. Continue only on model/user proposal or declared approved-action workflow step. |
| `coverage_timeout_continuation` | Continue sibling session | model guidance + explicit workflow | Surface incomplete coverage and handles; no automatic continuation. |
| `independent_evidence_stream_continuation` | Continue evidence stream | model guidance | The model chooses whether evidence value justifies another effect within budget. |
| `missing_approval_gate_repair_continuation` | Continue through permission flow | kernel safety + explicit workflow | Permission workflow owns state transitions; kernel blocks unauthorized effects but does not synthesize continuation. |

## Closeout Registry Triage

The closeout registry contains a mix of kernel outcomes and product synthesis.
It must be split rather than deleted as one unit.

| Current closeout | Target |
| --- | --- |
| `operator_cancelled`, `wall_clock_budget`, `round_limit`, `model_error` | Typed kernel terminal outcomes |
| `recovery_tool_budget` | Typed attempt budget exhaustion; remove recovery-specific second budget |
| `pseudo_tool_call` | Adapter/protocol normalization error |
| `repeated_tool_failure`, `repeated_session_inspection`, `excessive_session_continuation` | Retry/effect ledger diagnostics; block exact duplicate effects by id, otherwise model guidance/evaluation |
| `sub_agent_timeout` | Suspended or failed child result with durable handle |
| `completed_sub_agent_final`, `tool_evidence_fallback` | Normal transcript projection; no special terminal policy |

## Permission Suppression

| Current policy | Current automatic action | Target owner | Required migration |
| --- | --- | --- | --- |
| `read_only_permission_query` | Suppress a model-proposed `permission_query` for text-derived read-only work | permission service + model guidance | Permission service returns typed `not_required` when mechanically true. Do not suppress a proposal based on task wording or spend a repair round. |

## Tool-Call Normalization Pipeline

"Normalizer" is not one authority. Pure protocol translation may remain in an
adapter; safety must deny or constrain proposals; business-effect rewrites must
move to model guidance or an explicit workflow.

| Current step | Classification | Target disposition |
| --- | --- | --- |
| `sessionToolAlias` | Syntactic alias | Keep in adapter only if effect identity and semantics are unchanged. |
| `enforceMissingApprovalGateRepair` | Business-effect rewrite | Replace with kernel admission denial/suspension. Do not manufacture `permission_query`. |
| `sessionContinuationDirective` | Business-effect rewrite | Move declared continuation to workflow input; otherwise the model proposes it. |
| `sessionContinuationLookupDirective` | Business-effect rewrite | Move lookup to explicit workflow; no hidden lookup injection. |
| `explicitContinuationHistory` | Task-text routing | Replace with typed handle projection and model/workflow proposal. |
| `sessionToolCalls` | Protocol/handle normalization | Keep only stable handle and schema translation that preserves requested effect semantics. |
| `privateUrlResearchSpawn` | Network safety plus routing rewrite | Kernel denies unsafe network authority. A semantically different safe tool requires a new model/workflow proposal. |
| `localUrlWebFetch` | Network safety plus routing rewrite | Same rule: deny/constrain mechanically; do not silently substitute business work. |
| `boundedTimeoutSourceSpawn` | Task-text business rewrite | Delete automatic spawn rewrite; expose available tools and limits through guidance. |
| `boundedSourceTimeoutBudget` | Budget mutation | Replace task-derived floors with monotone attempt/operation budget composition. |
| `supplementalLocalTimeoutProbe` | Hidden effect injection | Move to explicit workflow or model proposal; delete forced probe. |
| `boundedTimeoutDuplicateSourceSpawn` | Duplicate-work suppression | Kernel blocks only stable-id duplicates; broader semantic duplication remains guidance/evaluation. |
| `sessionContinuationDirectiveRepeat` | Repeated business-effect rewrite | Retire with `sessionContinuationDirective`; workflow transition is applied once by id. |
| `approvalGatedBrowserSpawn` | Safety rewrite from browser spawn to `permission_query` | Kernel suspends or rejects the unauthorized spawn with typed permission state; it must not replace the proposal. |
| `limitIndependentEvidenceSpawn` | Product policy mixed with resource safety | Generic concurrency/tool-call caps remain kernel constraints; requested evidence topology belongs to workflow/model guidance. |

Migration update: `boundedSourceTimeoutBudget` and
`supplementalLocalTimeoutProbe` left the active normalizer/continuation path in
the clock/retry slice. Numeric attempt and operation bounds now compose
monotonically; the runtime no longer injects a supplemental probe. Their helper
implementations may remain temporarily in the fallback pool but have no active
execution authority.

## Migration Safety

The table deliberately distinguishes behavior from automatic authority:

- permission and protocol safety is preserved or strengthened;
- evidence and output-shape knowledge remains available to guidance and
  evaluation;
- transcript loss is fixed mechanically;
- automatic business-effect injection and post-terminal rewriting are removed.

Each production migration must cite one row, add a deterministic mechanism
test, and keep the old evaluator signal until fixed-version model measurements
show the impact. No row authorizes fixture-specific replacements.

Product Option A is signed in
[Runtime Policy Migration Product Decision](./runtime-policy-migration-product-decision.md).
Policy-action migration still requires one reviewed row per slice and its
replacement mechanism. Golden trace coverage is retired row by row only after
that row's replacement and measurement are accepted; it is not removed in bulk.
