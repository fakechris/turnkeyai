# P0 Natural Runtime Parity Reset

Updated: 2026-06-05

This reset changes the priority order for the agent workbench goal. Browser
control, diagnostics, and UI polish remain important, but they are not allowed
to outrank the core question: can a real user give a natural complex prompt and
receive a stable, evidence-backed result?

## Evidence Rule

Progress must be classified before it is claimed.

| Class | Meaning | Can claim capability improvement? |
| --- | --- | --- |
| Structural | Code paths, schemas, docs, or deterministic tests exist. | No. |
| Visibility | Runtime truth is easier to inspect in UI, diagnostics, or reports. | No. |
| Capability | A natural real LLM E2E produced a useful terminal result with evidence. | Yes. |
| Unknown | Evidence is missing, indirect, stale, or only fixture-shaped. | No. |

Contract E2E remains valuable, but it proves protocol shape only. Natural E2E
must use user-like prompts and must not contain fixed markers, exact final
answer templates, or instructions that force a specific tool call.

Do not treat "one natural E2E failed, add a narrow case, run again" as a
methodology. First classify the failure as a runtime state, prompt harness,
tool protocol, continuation, timeout, browser reliability, approval, memory, or
UI replay problem. Implementation resumes only after the expected state
transition and acceptance evidence are clear.

## Current Core Status

| Area | Status | Reset finding | Required P0 proof |
| --- | --- | --- | --- |
| Native tool loop | done | Current-code natural comparison, browser-dynamic, and long-delegation reruns finished cleanly with completed tool loops, terminal synthesis, no stale liveness, and no weak-answer signals. Evidence: `msn.mq0aw0un.1`, `msn.mq0ax9ut.2`, `msn.mq0b1nl2.5`. | Full-natural same-scenario A/B now validates this path in `combined-live-full-natural-ab-report.json` and `combined-live-reference-audit.json`. |
| Assistant tool calls, progress, and tool result messages | done | Natural mission artifacts prove requested tool calls, tool results, evidence events, and final answers. Current-code provider-neutral protocol evidence records parsed provider tool calls, appended assistant `tool_use` blocks, matching `role=tool` result messages, and assistant-before-tool-result ordering in passing natural runs. Evidence: `msn.mq0gfchn.1` / `natural-memory-invalidation-provider-protocol.json` with 2 protocol rounds, 3 provider tool calls, 3 assistant tool-use blocks, 3 role-tool result messages, and 3 matching tool call ids. Long-delegation evidence: `msn.mq0gkwgb.1` / `natural-long-delegation-provider-protocol.json` with 17 protocol rounds, 20 provider tool calls, 20 assistant tool-use blocks, 20 role-tool result messages, 20 matching tool call ids, `sessions_spawn`, `explore_run`, and browser private tools in the protocol evidence. Natural replay evidence proves persisted tool processes render before the final answer in Mission Detail across long-delegation/browser, approval, and timeout/continuation missions: `msn.mq0gs7iz.1`, `msn.mq0h2xxm.1`, and `msn.mq0hg9yi.1`. | Keep provider protocol and replay coverage in future natural acceptance gates. |
| Durable sub-session transcript | done | Current-code follow-up, timeout follow-up, browser restart, and browser cold-recreation runs reused or recreated session state with terminal results and no duplicate-spawn loop. Evidence: `msn.mq0ay1tb.3`, `msn.mq0b3hjz.6`, `msn.mq0bof8a.1`, `msn.mq0bqn9x.2`, `msn.mq0bshqe.1`. | Full-natural same-scenario A/B validates follow-up, timeout follow-up, browser restart, and cold recreation rows with 27/27 comparable scenarios and 0 TurnkeyAI losses. |
| Session tools | done | Natural stability and browser reliability reruns exercised `sessions_spawn`, `sessions_send`, `sessions_list`, and `sessions_history` in follow-up, timeout, approval, long-delegation, and browser-continuation scenarios. Evidence: `msn.mq0ay1tb.3`, `msn.mq0azmhv.4`, `msn.mq0b1nl2.5`, `msn.mq0b3hjz.6`, `msn.mq0bof8a.1`. Post-roster timeout follow-up evidence `msn.mq0kmpbx.1` proves the inspection-guidance hardening reduced an over-inspection loop to bounded `sessions_list`, `sessions_spawn`, and `sessions_send` use. | Keep tool-use discipline covered in future natural acceptance gates. |
| Permission loop | done | Approval dry-run evidence proves query/result/applied state and no weak final answer in a natural run. Evidence: `msn.mq0azmhv.4`. Denial, pending-state, and wait-timeout evidence prove no permission application after denial/silence, paused approval state, terminal wait-timeout closeout, and no weak-answer signals. Evidence: `msn.mq0d3vdy.1`, `msn.mq0d47xu.2`, and `msn.mq0ec5cm.1`. | Keep approved, denied, pending, and wait-timeout approval paths covered in future natural acceptance gates. |
| Browser sub-agent private tools | done | Browser dynamic, complex-page review, and reliability reruns collected rendered browser evidence through sub-agent work with stable terminal answers. Evidence: `msn.mq0973ra.1`, `msn.mq0ax9ut.2`, and the browser reliability matrix. Browser-focused same-scenario A/B now passes for external and complex page review. | Keep browser-focused natural and A/B coverage in future release gates. |
| Prompt harness | done | Natural long delegation now has current-code mode/roster evidence showing an `investigation` mission persisted a lead plus explicit explore and browser workers, exposed only `browser` and `explore` as prompt-visible worker kinds, completed provider-neutral tool protocol ordering, and synthesized useful evidence from independent workers. Evidence: `msn.mq0jjcp7.1` / `natural-long-delegation-mode-roster.json`. Source-level harness snapshot coverage proves prompt-visible worker guidance is scoped to workers available for the current activation, so explore-only contexts no longer see browser routing rules or browser worker rows. | Full-natural same-scenario A/B validates the natural long-delegation row as a comparable scenario; keep snapshot and natural gates for future worker-roster changes. |
| Iteration, timeout, and continuation behavior | done | Timeout follow-up reached terminal state with timeout evidence preserved, reused session state, and left no active/waiting/stale subjects. Evidence: `msn.mq0b3hjz.6`. Post-roster rerun `msn.mq0kmpbx.1` passed with reasonable tool use after session inspection guidance was added to `sessions_list` and `sessions_history`. | Full-natural same-scenario A/B validates timeout partial closeout and timeout follow-up continuation, including explicit reference baseline-loss classification. |
| Memory search/get/flush | done | Current-code memory recall proves native `memory_search` and `memory_get` retrieval in a natural run. Evidence: `msn.mq0b65re.7`. Pressure flush proves pre-compaction durable memory preservation under prompt pressure. Evidence: `msn.mq0f08p3.1`. Durable memory invalidation after a corrected stored fact has natural current-code evidence: `msn.mq0g5bm8.1` removed one stale thread-memory item, kept required Borealis-23 facts, and left stale facts absent in the artifact. Pre-compaction correction pressure flush now has natural evidence: `msn.mq0iyhx8.1` triggered request-envelope reduction, preserved corrected Borealis-23 launch facts, left stale Monday/Launch Manager/staging-checklist facts absent, used `memory_search` and `memory_get` in 2/2 tool results, and produced a useful evidence-backed answer with no weak-answer signals. | Full-natural same-scenario A/B validates memory recall, pressure flush, and invalidation rows with live reference memory setup and recall evidence. |
| Tool-result pruning | done | Natural pruning-pressure evidence now proves prompt input pruning as a runtime primitive while preserving required source facts. Evidence: `msn.mq0f08p3.1` recorded `tool_result_pruning` with `older_than_recent_window`, reduced tool-result bytes from `6439` to `4101`, preserved 3/3 evidence streams, and left zero active/waiting/stale runtime subjects. | Full-natural same-scenario A/B validates the pruning row with same prompt, caps, and rendered product-source evidence. |
| Replay and thought process UI | done | Screenshot-backed Control Center smoke evidence proves the Mission Detail trace can expand before the final answer on desktop and mobile, with visible tool-process rows, final-answer link, no overlap, and no horizontal overflow. Natural persisted replay evidence now covers completed long-delegation/browser, approval, and timeout/continuation missions. Evidence: `natural-long-delegation-replay-ui-evidence.json` records 4 tool-process rows; `natural-approval-dry-run-action-replay-ui-evidence.json` records 8 tool-process rows plus approval evidence; `natural-timeout-followup-continuation-replay-ui-evidence.json` records 8 tool-process rows plus timeout evidence. All three record exactly 1 final-answer card, trace-before-final-answer order, no trace/final overlap, no page-level horizontal overflow on desktop and 390px mobile, and screenshot sets with trace boundary plus final-answer focused captures. | Keep Mission Detail replay screenshots in future natural acceptance gates for new mission states. |
| Cancellation by tool call id | done | Fresh current-code natural cancellation evidence proves active mission cancellation and toolCallId-targeted cancellation-follow-up. Evidence: `msn.mq0ctf22.1` and `msn.mq0ctjpv.2`; both left no active/waiting/stale runtime subjects, and the follow-up reused the cancelled session context. | Full-natural same-scenario A/B validates active cancellation and cancellation follow-up with two-phase reference evidence. |
| Browser profile/session reliability | done | The clean browser reliability matrix passed 8/8 across follow-up, restart continuation, cold recreation, profile-lock recovery, unavailable browser, CDP timeout, detached target, and attach-failed closeouts. Evidence: `msn.mq0bof8a.1`, `msn.mq0bqn9x.2`, `msn.mq0bshqe.1`, `msn.mq0buk0w.1`, `msn.mq0bvahz.1`, `msn.mq0bw3aw.1`, `msn.mq0bwzzf.1`, `msn.mq0bxwng.1`. Browser-reliability same-scenario A/B now passes for the full eight-row recovery/closeout suite. | Keep failure buckets and `needs_attention` quality visible; these are bounded closeouts, not proof that browser failures disappeared. |

## 2026-06-05 Current Evidence Snapshot

Current-code natural evidence is materially stronger than the 2026-05-31 reset
baseline:

- `artifacts/evals/20260605-p0-natural-stability-rerun/natural-core-rerun.json`
  passed 7/7 with `capabilityClaim=unproven-without-comparative-evidence`.
  It covers comparison research, browser dynamic page review, follow-up
  continuation, approval dry-run, long delegation, timeout follow-up, and memory
  recall.
- `artifacts/evals/20260605-p0-browser-reliability-current/natural-browser-reliability-after-detached-term-fix.json`
  passed 8/8 with stable browser follow-up, restart continuation, cold
  recreation, profile-lock fallback, unavailable browser, CDP timeout,
  detached-target, and attach-failed closeouts.
- `artifacts/evals/20260605-p0-browser-current/natural-browser-complex-page-review.json`
  passed 1/1 for complex browser page review with rendered evidence.
- `artifacts/evals/20260605-p0-browser-focused-current/natural-browser-focused-live-fixture.json`
  passed 2/2 for external page review and complex browser page review against
  the pinned live fixture server. Evidence missions: `msn.mq0pn5u8.1` and
  `msn.mq0pob05.2`; both used browser evidence, had no weak-answer signals,
  and completed with zero active/waiting/stale runtime subjects.
- `artifacts/evals/20260605-p0-cancel-current/natural-cancel-active-followup.json`
  passed 2/2 for active cancellation and cancellation follow-up continuation.
  It covers active mission cancellation, toolCallId-targeted cancellation,
  cancelled worker-session evidence, same-session follow-up continuation, and
  zero active/waiting/stale runtime subjects.
- `artifacts/evals/20260605-p0-approval-current/natural-approval-denied-pending-rerun.json`
  passed 2/2 for approval denial and pending approval state. It covers denied
  post-decision closeout without `permission_applied`, pending approval pause,
  and zero active/waiting/stale runtime subjects.
- `artifacts/evals/20260605-p0-approval-current/natural-approval-wait-timeout-pass.json`
  passed 1/1 for approval wait-timeout closeout. It covers pending
  `permission_result`, no `permission_applied`, no browser side effect,
  terminal closeout, and zero active/waiting/stale runtime subjects.
- `artifacts/evals/20260605-p0-pruning-current/natural-tool-result-pruning-pass.json`
  passed 1/1 for tool-result pruning under explicit pruning-pressure caps. It
  covers three independent delegated evidence streams, browser-visible product
  signals, parent prompt-input pruning (`older_than_recent_window`, `6439` to
  `4101` tool-result bytes), full source coverage after pruning, and zero
  active/waiting/stale runtime subjects.
- `artifacts/evals/20260605-p0-memory-current/natural-memory-correction-pressure-flush-rerun.json`
  passed 1/1 for pre-compaction correction pressure flush as
  `msn.mq0iyhx8.1`. It covers request-envelope reduction during a corrected
  Borealis-23 handoff, corrected durable memory preservation, stale
  Monday/Launch Manager/staging-checklist facts absent from thread memory,
  `memory_search` plus `memory_get` recall in 2/2 tool results, provider tool
  protocol ordering, no stuck/loop state, no weak-answer signals, and a useful
  final answer with payment-processor residual risk.
- `artifacts/evals/20260605-p0-prompt-harness-current/natural-long-delegation-mode-roster.json`
  passed 1/1 for natural long delegation as `msn.mq0jjcp7.1`. It records
  runtime roster evidence for an `investigation` mission with `role-lead`,
  `role-explore`, and `role-browser`, prompt-visible worker kinds limited to
  `browser` and `explore`, 11 provider tool protocol rounds, 16 matching
  provider/tool-result call ids, `sessions_spawn`, `explore_run`, and browser
  private tools, plus 3/3 tool results, 3 completed sessions, browser evidence,
  no liveness residue, no stuck/loop state, and no weak-answer signals.
- `artifacts/evals/20260605-p0-retryable-failure-current/natural-timeout-partial-closeout.json`
  passed 1/1 for generic retryable timeout closeout as `msn.mq0jwh2h.1`. It
  records a bounded slow-source attempt with 1/1 tool result, 1 timed-out failed
  tool result, 1 spawned session, no active/waiting/stale runtime subjects,
  prompt-visible worker kinds limited to `browser` and `explore`, no weak-answer
  signals, and a useful final answer that separates verified endpoint targeting
  from unverified source content and gives a concrete continue/retry path.
- `artifacts/evals/20260605-p0-post-roster-natural-core/natural-timeout-followup-post-inspection-guidance.json`
  passed 1/1 for timeout follow-up continuation as `msn.mq0kmpbx.1` after
  session inspection guidance was added to `sessions_list` and
  `sessions_history`. The prior post-roster core run had failed this scenario
  on excessive inspection (`toolResults=9/2-7`); the rerun passed with 3/3 tool
  results, `sessions_spawn`, `sessions_send`, and `sessions_list`, `sessions`
  `1/1`, liveness `0/0/0`, no weak-answer signals, and useful verified versus
  unresolved timeout evidence.
- `artifacts/evals/20260605-p0-post-roster-natural-core/natural-memory-recall-post-roster.json`
  passed 1/1 for the post-roster memory recall row as `msn.mq0kpxc0.1`, with
  2/2 memory tool results, no stale liveness, no weak-answer signals, and
  recovered Helios-47 launch-planning context.
- `artifacts/evals/20260605-p0-replay-ui-current/control-center-ui-smoke-summary.json`
  passed the Control Center screenshot smoke for Mission Detail replay on
  desktop and mobile. It shows expanded trace, two tool-process rows, a
  final-answer-below trace link, trace before final answer, no trace/final
  overlap, and no horizontal overflow. Follow-on natural replay artifacts for
  long delegation, approval, and timeout continuation now provide the required
  persisted-mission screenshot proof.
- `artifacts/evals/20260605-p0-replay-natural-current/natural-long-delegation.json`
  passed a fresh natural long-delegation/browser mission as `msn.mq0gs7iz.1`
  and preserved the runtime root for UI replay capture.
- `artifacts/evals/20260605-p0-replay-natural-current/natural-long-delegation-replay-ui-evidence.json`
  proves the real persisted Mission Detail page for that mission renders an
  expanded trace with 4 tool-process rows, the final-answer-below trace link,
  exactly 1 final answer card, trace before final answer, no trace/final
  overlap, and no page-level horizontal overflow on desktop and 390px mobile.
  Screenshots are stored next to the JSON artifact, including focused final
  boundary captures. Natural approval and timeout replay proof is now covered
  by the follow-on artifacts below.
- `artifacts/evals/20260605-p0-replay-natural-current/natural-approval-dry-run-action.json`
  passed a fresh natural approval dry-run mission as `msn.mq0h2xxm.1`.
  Its replay artifact,
  `artifacts/evals/20260605-p0-replay-natural-current/natural-approval-dry-run-action-replay-ui-evidence.json`,
  proves the persisted Mission Detail page renders 8 tool-process rows,
  approval text/evidence, exactly 1 final-answer card, trace before final
  answer, no trace/final overlap, and no page-level horizontal overflow on
  desktop and 390px mobile. Screenshots include trace boundary and final-answer
  focused captures.
- `artifacts/evals/20260605-p0-replay-natural-current/natural-timeout-followup-continuation-pass.json`
  passed a fresh natural timeout follow-up mission as `msn.mq0hg9yi.1` after a
  continuation-targeting fix for stale session-list context. Its replay
  artifact,
  `artifacts/evals/20260605-p0-replay-natural-current/natural-timeout-followup-continuation-replay-ui-evidence.json`,
  proves the persisted Mission Detail page renders 8 tool-process rows,
  timeout text/evidence, exactly 1 final-answer card, trace before final
  answer, no trace/final overlap, and no page-level horizontal overflow on
  desktop and 390px mobile. Screenshots include trace boundary and final-answer
  focused captures.
- `artifacts/evals/20260605-p0-ab-live-fixtures/natural-core-live-fixtures.json`
  passed 7/7 against a stable live fixture server for comparison research,
  browser dynamic page review, follow-up continuation, approval dry-run, long
  delegation, timeout follow-up, and memory recall. Evidence missions:
  `msn.mq0lob57.1`, `msn.mq0lpind.2`, `msn.mq0lqbda.3`, `msn.mq0lrw1h.4`,
  `msn.mq0lsusj.5`, `msn.mq0lunyw.6`, and `msn.mq0lxam5.7`.
- Core same-scenario A/B now has a passing live-reference checkpoint for the
  seven natural core rows. The authenticated sibling reference collection
  artifacts in
  `artifacts/evals/20260605-p0-ab-live-fixtures/core-reference-approval-post-decision/`
  pass reference health 7/7, same-scenario fairness 7/7, and adapter audit 7/7.
- `artifacts/evals/20260605-p0-ab-live-fixtures/core-validated-pipeline-final-audit-only/pipeline-report.json`
  records the current passing core A/B gate over those collected artifacts:
  `initialAudit=passed`, `collection=not_required`,
  `referenceHealth=passed`, `fairness=passed`, and `abAcceptance=passed`.
  `reference-audit.initial.json` records 7 validated comparisons and 0
  unvalidated comparisons across comparison research, browser dynamic page,
  follow-up continuation, approval dry-run, long delegation, timeout follow-up,
  and memory recall.
- This closes the core same-scenario A/B blocker for the current seven-row
  natural core suite.
- Browser-reliability same-scenario A/B now has a passing live-reference
  checkpoint for all eight recovery/closeout rows:
  `artifacts/evals/20260605-p0-browser-reliability-current/validated-live/pipeline-report.json`.
  It records `referencePreflight=passed`, `collection=passed`,
  `finalAudit=passed`, `referenceHealth=passed`, `fairness=passed`, and
  `abAcceptance=passed`. The final audit records 8 validated comparisons,
  reference health records 8/8 healthy artifacts, and fairness records 8/8
  fair scenarios.
- Browser-focused same-scenario A/B now has a passing live-reference checkpoint
  for external page review and complex browser page review:
  `artifacts/evals/20260605-p0-browser-focused-current/validated-live/pipeline-report.json`.
  It records `referencePreflight=passed`, `collection=passed`,
  `finalAudit=passed`, `referenceHealth=passed`, `fairness=passed`, and
  `abAcceptance=passed`. The final audit records 2 validated comparisons,
  reference health records 2/2 healthy artifacts, and fairness records 2/2
  fair scenarios.
- The stricter `full-natural` A/B suite now passes for the complete default
  natural matrix. Current natural evidence is assembled into
  `artifacts/evals/20260605-p0-full-natural-current/natural-full-current-composite.json`,
  which records 27/27 passed scenarios from current reports. The combined live
  reference set in
  `artifacts/evals/20260605-p0-full-natural-current/reference-combined-live/`
  now covers all 27 rows with scenario-aware artifacts, and the full-natural
  reference audit records 27 validated comparisons, 0 unvalidated comparisons,
  and 0 recollection tasks.
- The reference collector records scenario driver policy in collected artifact
  provenance. Approval reference collection distinguishes approved, denied, and
  pending policies, so denied rows post a denied decision and pending rows
  observe the approval query without posting a decision. The final collector
  path now includes scenario-aware drivers for memory setup/invalidation,
  memory pressure flush, tool-result pruning, timeout partial/follow-up
  closeout, and cancellation rows instead of misleading one-shot prompt replay
  artifacts.
- An earlier policy-live reference collection checkpoint for this collector
  path is stored under
  `artifacts/evals/20260605-p0-full-natural-current/reference-policy-live/`.
  Reference health marks `natural-browser-dashboard-task` and
  `natural-approval-denied-safe-closeout` healthy. The pending approval row now
  adapts the real pending approval query into a paused-state summary, matching
  the natural harness contract where the approval query is the terminal
  evidence event. The policy-live manifest now also includes
  `natural-approval-wait-timeout-closeout`; the four-row health report is 3/4
  because the sibling reference runtime stayed `needs_approval` and never
  produced approval wait-timeout closeout evidence under
  `TURNKEYAI_TOOL_PERMISSION_WAIT_MS=2000`. This isolates wait-timeout as a
  reference-baseline behavior gap rather than a pending-approval collector gap.
- The A/B harness now treats that concrete wait-timeout baseline loss as
  validated comparison evidence when the artifact proves same prompt/model
  provenance, a pending approval query, no decision payload, no tool result, no
  `permission_applied`, and no form submission. The policy-live health gate now
  passes 4/4, and
  `artifacts/evals/20260605-p0-full-natural-current/policy-live-ab-report.json`
  passes as a focused A/B report over dashboard, approval denied, approval
  pending, and approval wait-timeout. The combined full-natural reference audit
  then proved timeout partial closeout as a focused live A/B baseline loss:
  TurnkeyAI records `timedOut=true`, `partialCloseout=true`, and
  `hardAborted=false`; the reference artifact proves same-prompt native worker
  attempts that returned failed `sessions_spawn` results and then timed out
  without useful closeout. Tool-result pruning now also has focused live A/B
  proof under the same pruning-pressure caps: both TurnkeyAI and reference ran
  three native `sessions_spawn` calls/results over the three product evidence
  streams, produced useful evidence-backed briefs, and validated rendered
  browser evidence for the product signals source. Active cancellation now has
  focused live A/B proof: the reference collector observed an active tool call,
  cancelled the mission through the daemon, recorded cancellation timeline
  evidence, and produced a useful terminal cancellation closeout. Cancellation
  follow-up continuation now also has focused live A/B proof with a two-phase
  reference artifact: phase one records cancellation evidence, and phase two
  records resumed source-check continuation evidence. Memory pressure flush and
  memory invalidation now have live reference artifacts that perform natural
  setup/correction in a mission thread, preserve raw memory snapshots, and prove
  `memory_search` / `memory_get` recall. Timeout follow-up was recollected as a
  two-phase reference artifact; the reference runtime still produced a
  harness-like baseline-loss closeout, which is classified explicitly as
  reference baseline loss rather than hidden as a capability success.
- `artifacts/evals/20260605-p0-full-natural-current/combined-live-full-natural-ab-report.json`
  and
  `artifacts/evals/20260605-p0-full-natural-current/combined-live-full-natural-ab-report-check.md`
  now pass with `scenarios=27`, `comparable=27`, `turnkeyaiWins=3`, and
  `turnkeyaiLosses=0`. The report records `capabilityClaim=capability proven`
  and `stabilityClaim=stable` for the full-natural same-scenario A/B suite.

## Continuation Matrix Summary

Every live-runtime continuation fix must map to one of these rows before code
changes are considered capability work.

| Runtime state | Expected user-facing behavior | Required proof |
| --- | --- | --- |
| `done` | Follow-up can reuse the completed child session when the user asks to continue the same thread. | done: `msn.mq0ay1tb.3` and `msn.mq0bof8a.1` used continuation tools and produced useful terminal answers. |
| `resumable timeout` | The timed-out child session remains inspectable and can be continued without hiding the timeout from operators. | done: `msn.mq0b3hjz.6` records timeout evidence, reuses the session, reaches terminal state, and leaves no active/waiting/stale subjects. Post-roster rerun `msn.mq0kmpbx.1` proves the same path now avoids repeated session-history inspection and finishes with bounded tool use. |
| `cancelled` | User cancellation writes a cancelled tool result, stops active worker execution, and a later follow-up can either continue the same context or clearly start new work. | done: `msn.mq0ctf22.1` proves active cancellation closeout, and `msn.mq0ctjpv.2` proves toolCallId cancellation followed by same-session continuation. |
| `failed retryable` | The runtime exposes a retryable failure with bounded retry or continuation guidance instead of forcing the lead to improvise. | done: browser reliability closeouts prove bounded buckets for browser recovery states, and `msn.mq0jwh2h.1` proves a generic slow-source timeout reaches a useful bounded closeout with timeout evidence, verified/unverified separation, concrete continuation guidance, and no live runtime residue. |
| `failed non-retryable` | The runtime stops tool use, explains the unrecoverable state, and asks for user/operator action when needed. | done for browser failure classes: `msn.mq0bvahz.1`, `msn.mq0bw3aw.1`, `msn.mq0bwzzf.1`, and `msn.mq0bxwng.1` reached terminal evidence-aware closeouts without looped re-spawn. |
| `active/running` | The workbench can show ordered progress, and cancellation targets the active tool call or worker. | done: replay UI artifacts prove ordered progress rows before final answers, and `msn.mq0ctf22.1` / `msn.mq0ctjpv.2` prove active and toolCallId-targeted cancellation without runtime residue. |
| `needs approval` | Side-effect work pauses before execution, records query/result/applied state, and resumes or closes out based on the decision. | done: `msn.mq0azmhv.4` proves natural approval dry-run query/result/applied; `msn.mq0d3vdy.1` proves denied post-decision closeout with no permission applied; `msn.mq0d47xu.2` proves the pending state remains paused; `msn.mq0ec5cm.1` proves wait-timeout closeout with no side effect. |

`natural-cancel-followup-continuation` is a P0-C / D5 / D6 capability gate for
cancelled continuation and per-agent timeout/continuation policy. It is not a
temporary scenario patch. Internally this maps to the cancelled-continuation and
per-agent-timeout rows in the working implementation matrix; the durable product
contract is the matrix above.

## P0 Roadmap

### P0-A Natural Acceptance Gate

Why core:
Natural complex prompts are the only evidence that the runtime is useful to a
real user. Contract-shaped prompts can hide weak planning, brittle tool use, and
final-answer failures.

Required:

- Keep contract E2E and natural E2E separately named in commands, reports, and
  validation-ops records.
- Natural report artifacts must say they are `natural-real-llm` capability
  evidence and list the quality signals they require.
- Validation ops must include the natural mission report summary, not only the
  contract/mission matrix summary.

Acceptance:

- `npm run acceptance:real` writes both mission and natural mission artifacts
  when natural acceptance is enabled.
- Validation-ops records contain natural scenario count, pass/fail count,
  liveness, tool use, browser use, approval use, weak-answer signal count, and
  evidence count.

Risk if not done:
The project can continue to look green while natural user prompts still loop,
stall, or produce thin answers.

### P0-B Prompt Harness And Delegation Discipline

Why core:
The lead should plan and synthesize; specialist sub-agents should perform
browser/research/tool-heavy work. If the lead keeps compensating for weak child
behavior, complex tasks will remain unstable.

Required:

- Strengthen registry-rendered harness sections for delegation, tool-use
  discipline, session continuation, browser work, memory use, task tracking,
  timeout closeout, and delivery.
- Ensure disabled/unavailable tools disappear from schemas and prompt-visible
  guidance.
- Keep browser primitives private to browser workers.

Acceptance:

- Snapshot tests verify harness content for lead and sub-agent contexts.
- Natural long delegation E2E shows independent sub-agent evidence and a parent
  synthesis, not repeated fallback spawning.

Risk if not done:
The model will keep oscillating between underusing tools and overusing tools,
and budget changes will only mask the issue.

### P0-C Live Runtime Protocol Proof

Why core:
A production workbench needs ordered, resumable execution truth, not post-hoc
debug traces.

Required:

- Prove assistant tool calls, progress, tool results, permission events, and
  final answers persist in order during active work.
- Prove `sessions_send` continues child transcript state.
- Prove `/message/cancel-tools` interrupts active worker execution when a
  cancellable tool call is registered.

Acceptance:

- Natural browser or long delegation run can be inspected while running and
  after completion with the same ordered chain.
- Cancellation scenario reaches terminal mission state with a cancelled tool
  result and no active/waiting/stale subjects.

Risk if not done:
Users see "working" without trustworthy process state, and failed/cancelled
work cannot be resumed or explained reliably.

### P0-D Browser Reliability Gate

Why core:
Browser failures currently amplify into bad agent behavior. The browser worker
must report reliable, bounded outcomes so the lead can synthesize or ask for
continuation.

Required:

- Real dynamic page and dashboard scenarios must verify rendered evidence, not
  server fixture text.
- Profile lock, CDP unavailable, attach failure, timeout, and target detach
  must produce stable buckets and bounded recovery.

Acceptance:

- Browser-backed natural E2E completes with browser evidence and no profile
  fallback loop.
- Failure-injection gate verifies the operator-facing bucket and next action.

Risk if not done:
Complex web tasks will keep failing as weak model answers or endless retries.

### P0-E Memory And Context Pressure Gate

Why core:
Complex tasks depend on prior decisions and accumulated evidence. Memory must
be reliable under context pressure, not just available as a tool.

Required:

- Natural memory recall after a long context path.
- Pre-compaction flush evidence in acceptance artifacts.
- Tool-result pruning policy that preserves evidence while bounding prompt
  growth.
- Memory invalidation through the current durable write paths. Durable
  thread-memory correction invalidation is now current-code proven by
  `natural-memory-invalidation` / `msn.mq0g5bm8.1`; pre-compaction flush
  correction invalidation is now current-code proven by
  `natural-memory-correction-pressure-flush` / `msn.mq0iyhx8.1`.

Acceptance:

- Natural memory recall retrieves the expected durable item through native
  memory tools and avoids stale unsupported claims.
- Long natural run stays within prompt budget without losing required source
  coverage.

Risk if not done:
The agent will either forget important constraints or carry stale tool noise
into final synthesis.

## P1 And P2 Demotion

P1: Workbench UX only after P0 gates can prove useful terminal results. UX work
should then focus on Mission overview, chronological thought/process replay,
approvals, artifacts, sessions, continuation, cancellation, and screenshots.

P2: Diagnostics, ledger, docs, and governance. These are required for operating
the product, but they do not prove agent capability unless tied to real natural
E2E artifacts.
