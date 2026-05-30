# Agent Workbench Goal Ledger

This ledger tracks whether TurnkeyAI is converging toward a production-grade
agent workbench for stable complex-task delivery. It is intentionally not a PR
counter or test-count scoreboard.

G0 operating contract:

- Objective: track whether TurnkeyAI is actually converging toward a
  production-grade agent workbench for stable complex-task delivery.
- This ledger is the source of truth for goal progress while the workbench
  stabilization goal is active.
- Progress is judged by real acceptance, user-visible behavior, and reduction
  of repeated failure classes. PR count, LOC movement, and test count are
  supporting facts only; they are never sufficient evidence by themselves.

Update cadence:

- Add a checkpoint every 2-4 hours while actively working this goal.
- Add an extra checkpoint after any real LLM/browser E2E acceptance run.
- Every 24 hours, review the last day of checkpoints. If the same issue class
  keeps receiving local fixes without better real E2E outcomes, pause feature
  PRs and switch to methodology review.
- Do not mark a stage as converging unless the checkpoint can answer: "is
  stable complex-task delivery closer than it was at the previous checkpoint?"

Direction values:

- `converging`: user-visible behavior or real acceptance evidence moved closer
  to stable complex-task delivery.
- `oscillating`: local fixes are trading one failure mode for another, or
  apparent progress is not reflected in E2E behavior.
- `blocked`: forward progress is blocked by missing environment, missing
  credentials, external service outage, or an unresolved architecture decision.
- `unknown`: insufficient evidence; run acceptance or inspect production traces
  before claiming progress.

Evidence gates:

- Runtime, tool-use, session, browser, or mission-completion changes require at
  least one focused mission E2E or browser E2E before a checkpoint can be marked
  `converging`.
- Workbench UX changes require a user-visible smoke check or screenshot-backed
  manual observation that covers the changed path before the checkpoint can be
  marked `converging`.
- Docs-only or governance-only changes default to `unknown` unless they close a
  previously recorded methodology block.
- Unit tests, PR review, CI, LOC reduction, and test-count growth can support a
  checkpoint but cannot by themselves justify `converging`.
- If a checkpoint says "no real acceptance ran", it must also state which real
  scenario is the next required acceptance gate.

Checkpoint template:

```md
## YYYY-MM-DD HH:mm TZ - <short checkpoint name>

Direction: converging | oscillating | blocked | unknown

Execution Kernel:
- What changed in agent/tool/session execution semantics?
- Did this reduce loops, stuck runs, orphaned sessions, or ambiguous ownership?

Result Quality:
- Did final answers become more complete, evidence-backed, or actionable?
- Any regressions in substance, unsupported uncertainty, or weak synthesis?

Workbench UX:
- What did a user see that is clearer, faster, or more recoverable?
- Can the user tell whether work is running, stuck, blocked, done, or weak?

Browser Reliability:
- Did browser/session/transport behavior become more reliable or easier to
  diagnose?
- Any remaining profile, attach, reconnect, or bridge health issues?

Acceptance Evidence:
- Real E2E commands, mission IDs, validation IDs, screenshots, or manual test
  observations.
- If no real acceptance ran, say so explicitly and mark residual risk.

Regression Risk:
- What could this change break?
- Which tests or checks cover it, and which gaps remain?
```

Daily review template:

```md
## YYYY-MM-DD HH:mm TZ - 24-Hour Goal Review

Direction: converging | oscillating | blocked | unknown

Repeated Issue Classes:
- execution loops or stuck work:
- weak or unsupported final answers:
- browser/session/transport instability:
- UI state mismatch or missing recovery action:
- acceptance environment drift:

E2E Trend:
- Which real scenarios improved, regressed, or stayed unchanged?
- Are users closer to stable complex-task delivery, or are we only adding
  local patches?

Decision:
- Continue feature PRs | pause feature PRs and start methodology review

Methodology Review Trigger:
- Triggered? yes | no
- If yes, write the root cause hypothesis and the E2E scenario that must
  improve before feature work resumes.
```

## 2026-05-30 17:55 CST - Post-Acceptance Product Entry And Recovery Visibility

Direction: converging

Execution Kernel:
- No kernel semantics changed in this checkpoint. Recent kernel work already
  supports durable native tool calls, split tool results, session continuation,
  bounded browser continuity recovery, and mission completion classification.
- Current focus is making existing runtime truth visible and operable from the
  workbench rather than adding another execution path.

Result Quality:
- Latest real acceptance passed the mission matrix, including complex,
  follow-up, timeout-recovery, memory-recall, task-tracking,
  product-workbench-brief, and realistic-brief scenarios.
- Remaining quality risk is not solved by more page chrome: final answer
  substance still needs ongoing real-prompt validation when tool/browser work is
  long or partially degraded.

Workbench UX:
- First-run onboarding now surfaces bridge transport health from
  `/bridge/status`, so setup failure is visible before a user starts a
  browser-backed mission.
- Mission Detail is being extended to expose mission-scoped reconcile in place,
  because users should not have to leave a stuck mission and open Runtime just
  to force a thread/mission mirror pass.

Browser Reliability:
- Bridge status now carries transport health into both runtime surfaces and the
  first-run setup path.
- Browser continuity regression coverage verifies hot detach, lease movement,
  cold reopen, and single recovered-case behavior. Remaining risk is real
  environment variance: profile locks, unavailable CDP endpoints, and slow
  browser operations still require periodic real acceptance.

Acceptance Evidence:
- Latest full real acceptance command recorded in
  `docs/design/tool-runtime-completion-plan.md`:
  `npm run acceptance:real -- --model-catalog models.local.json --scenario-timeout-ms 300000 --cdp-timeout-ms 45000 --data-dir /tmp/turnkeyai-real-acceptance-20260530171334`
- Passed gates included tool-use real matrix, direct-CDP smoke, and full mission
  real matrix.
- Current Mission Detail reconcile slice has not yet passed UI smoke at this
  checkpoint; keep direction provisional until the PR verifies and merges.

Regression Risk:
- Product-entry health display is low risk and covered by typecheck, build,
  full test suite, Control Center smoke, and a focused route-failure unit test.
- Mission Detail reconcile risk is UI wiring only, but it touches a crowded
  workbench page. It needs Control Center smoke, typecheck, build, full tests,
  and PR review before merge.

## 2026-05-30 18:23 CST - Mission Reconcile Visibility Landed

Direction: converging

Execution Kernel:
- No new execution semantics changed in this slice. The kernel still depends on
  the existing native tool-use, sub-session, continuation, and mission
  reconciliation machinery.
- The relevant improvement is operational closure: a user-visible mission can
  now trigger the same mission-scoped reconcile action that previously required
  leaving the mission context.

Result Quality:
- Final answer quality was not directly improved by this doc/UI slice.
- Quality risk remains centered on long complex prompts: the runtime needs
  periodic real LLM acceptance that checks substance, evidence, and completion,
  not only that a mission reaches `done`.

Workbench UX:
- Mission Detail now exposes a mission-scoped Reconcile action in the health
  panel. This reduces the gap between "mission looks stuck or stale" and "user
  has a local recovery action available."
- Onboarding now surfaces bridge transport health before browser-backed work
  starts, making an unavailable bridge/CDP path visible earlier.

Browser Reliability:
- No browser transport behavior changed in this checkpoint.
- Browser health is more visible, but reliability still depends on the existing
  bridge health checks, CDP smoke, and real browser acceptance runs.

Acceptance Evidence:
- PR #249 merged into `main` as `410f4b7 Add mission reconcile visibility ledger`.
- Verified before merge:
  `npm run typecheck`,
  `npm run build`,
  `npm run control-center:smoke`,
  `npm test -- --runInBand`,
  `git diff --check`.
- CI was green before merge. No fresh real LLM acceptance was run for this
  checkpoint, so complex-task quality remains a residual risk until the next
  real acceptance pass.

Regression Risk:
- Risk is mostly UI wiring and route invocation: the mission page now calls an
  existing reconcile endpoint and refreshes mission/runtime state afterward.
- Covered by Control Center smoke plus the full test suite. Remaining gap: no
  real browser/LLM acceptance was rerun after this purely visibility-focused
  slice.

## 2026-05-30 18:38 CST - Final-Step Role Synthesis Guard

Direction: converging

Execution Kernel:
- Inline role loops now distinguish "step budget reached with queued work" from
  "step budget reached after all queued work was already completed." The former
  still pauses with a continuation message; the latter returns the role run to
  idle instead of incorrectly marking it failed.
- The final allowed activation receives a task-brief nudge to synthesize from
  gathered evidence, avoid unnecessary new worker/tool work, state residual
  risk, and leave a useful continuation path.

Result Quality:
- This reduces the chance that a complex run spends its final allowed step on
  more exploration and then pauses without a useful answer.
- It does not claim to solve weak synthesis by itself; answer quality still
  depends on the mission quality gate and real prompt acceptance.

Workbench UX:
- Users should see fewer false failed/blocked states after a role has already
  produced its final answer on the last permitted step.
- The user-visible continuation behavior remains intact when there is still
  queued work after the budget is exhausted.

Browser Reliability:
- No browser transport behavior changed.
- Browser-backed missions benefit indirectly because the lead role is nudged to
  synthesize existing browser/sub-agent evidence before budget exhaustion.

Acceptance Evidence:
- `npm test -- --runInBand`: 1194 passing.
- `npm run typecheck`
- `npm run build`
- `git diff --check`
- Mission E2E:
  `npm run mission:e2e -- --scenario product-workbench-brief --scenario-timeout-ms 180000`
  passed with mission `msn.mps7uf76.1`, status `done`, quality gate `passed`,
  tools `3/3`, sessions `3/0`, liveness `0/0/0`, evidence events `3`, final
  answer `2229` bytes.

Regression Risk:
- Risk is concentrated in role-loop lifecycle semantics. Existing iteration
  limit behavior is preserved when a handoff is still queued; a new regression
  test pins the previously missing "final answer on last allowed activation"
  path.
- Real LLM/browser acceptance matrix was not rerun in full for this checkpoint;
  the focused mission E2E gives useful evidence but does not replace the next
  full acceptance pass.

## 2026-05-30 18:45 CST - Production Role Budget Aligned

Direction: converging

Execution Kernel:
- The daemon's production outer role activation budget is now `128` instead of
  `6`, aligned with the native tool loop budget and the final-step synthesis
  guard.
- The budget is exported as `DEFAULT_DAEMON_RUNTIME_LIMITS` and covered by a
  regression test, rather than living as an untested inline daemon literal.

Result Quality:
- Complex missions now have enough outer role activations to continue across
  sub-agent/tool work without prematurely hitting a 6-step ceiling.
- The risk is longer-running weak work; the existing controls are final-step
  synthesis, native tool wall-clock, worker timeouts, stale diagnostics, and
  mission quality gates.

Workbench UX:
- Users should see fewer missions pause early with a continuation notice before
  the agent has had enough turns to synthesize.
- No visible page changed in this slice.

Browser Reliability:
- Browser transport behavior did not change.
- Browser-backed tasks benefit indirectly because browser sub-agent evidence is
  less likely to be cut off by the parent role's old 6-step budget.

Acceptance Evidence:
- `npm test -- --runInBand`: 1195 passing.
- `npm run typecheck`
- `npm run build`
- `git diff --check`
- Mission E2E:
  `npm run mission:e2e -- --scenario product-workbench-brief --scenario-timeout-ms 180000`
  passed with mission `msn.mps84hbo.1`, status `done`, quality gate `passed`,
  tools `3/3`, sessions `3/0`, liveness `0/0/0`, evidence events `3`, final
  answer `2373` bytes.

Regression Risk:
- Wider outer role budget can expose loops if prompt/tool governance regresses.
  This is partially covered by the final-step synthesis guard, runtime liveness
  diagnostics, and focused mission E2E quality gate.
- A full real LLM/browser matrix was not rerun for this checkpoint; run it
  before claiming the whole workbench goal has converged.

## 2026-05-30 18:55 CST - Research Worker Timeout Budget Aligned

Direction: converging

Execution Kernel:
- Explore and finance sub-agent sessions now default to an 8-minute timeout
  budget, matching the tool instructions that tell the lead role these workers
  can take up to 480 seconds for focused research or data lookup.
- Browser remains at 18 minutes and general workers remain at 3 minutes; this
  slice only widens the worker kinds whose prompt contract already promised the
  longer research budget.
- The normal tool-use prompt harness now also carries the same final-answer
  shape discipline as the final-synthesis repair path: exact skeletons get no
  status preamble and requested bullets stay compact.

Result Quality:
- Research workers are less likely to be cut off at 3 minutes and forced into
  thin timeout summaries before they have gathered enough evidence.
- This does not remove the need for quality gates; it removes one runtime/prompt
  mismatch that could make otherwise reasonable work look weak.
- The first mission E2E run exposed a real quality miss: the answer had the
  right evidence but was too long (`2524 > 2400` bytes) because the model added
  a status preamble and verbose bullets. The fix tightened the harness instead
  of relaxing the acceptance gate.

Workbench UX:
- Users should see fewer premature timeout artifacts for explore/finance-backed
  missions.
- No visible page changed in this slice.

Browser Reliability:
- Browser timeout and transport behavior did not change.
- Browser work is unaffected except when the parent mission also uses explore or
  finance workers for supporting evidence.

Acceptance Evidence:
- `npm test -- --runInBand`: 1196 passing.
- `npm run typecheck`
- `npm run build`
- `git diff --check`
- `npx tsx --test packages/role-runtime/src/tool-use.test.ts`: 36 passing.
- `npx tsx --test packages/role-runtime/src/tool-capability-registry.test.ts packages/role-runtime/src/llm-response-generator.test.ts packages/role-runtime/src/tool-use.test.ts`: 67 passing.
- New regression coverage exercises the real `sessions_spawn` executor with fake
  timers and verifies absent `timeout_seconds` produces `480` seconds for both
  `explore` and `finance`.
- Mission E2E:
  `npm run mission:e2e -- --scenario product-workbench-brief --scenario-timeout-ms 180000`
  passed with mission `msn.mps8n64b.1`, status `done`, quality gate `passed`,
  tools `3/3`, sessions `3/0`, liveness `0/0/0`, evidence events `3`, final
  answer `2007` bytes and `6` bullets.

Regression Risk:
- Longer default research workers can occupy concurrency slots longer. Existing
  guardrails still cap per-parent and global active sessions, allow explicit
  `timeout_seconds`, and retain hard timeout recovery.
- The prompt harness change is broad for exact-skeleton final answers, so the
  main risk is over-compression. The product brief E2E and existing prompt
  tests cover the intended behavior; broader real-scenario matrix coverage is
  still needed before claiming the overall workbench goal complete.

## 2026-05-30 19:07 CST - Final-Shape Quality Gate Tightened

Direction: converging

Execution Kernel:
- No runtime execution behavior changed in this slice.
- The mission E2E final-answer evaluator now treats status preambles such as
  "all child sessions returned" or "producing the final answer" as quality
  failures when they appear before the requested answer shape.

Result Quality:
- This pins the failure mode observed in the previous checkpoint: the agent can
  gather the right evidence but still degrade product quality by adding process
  narration above the requested answer.
- Plain section labels such as `evidence` remain valid; the gate only rejects
  status narration that belongs in the thought process, not in the final answer.

Workbench UX:
- Users should see cleaner final answers in the Mission Detail view, with
  process traces staying in the timeline instead of leaking into the answer.

Browser Reliability:
- No browser behavior changed.

Acceptance Evidence:
- `npm test -- --runInBand`: 1199 passing.
- `npm run typecheck`
- `npm run build`
- `git diff --check`
- `npx tsx --test packages/app-gateway/src/mission-tool-use-e2e-quality.test.ts`:
  3 passing.
- `npx tsx --test packages/app-gateway/src/routes/mission-routes.test.ts packages/app-gateway/src/mission-tool-use-e2e-quality.test.ts`:
  32 passing.
- Mission E2E:
  `npm run mission:e2e -- --scenario product-workbench-brief --scenario-timeout-ms 180000`
  passed with mission `msn.mps8y6yq.1`, status `done`, quality gate `passed`,
  tools `3/3`, sessions `3/0`, liveness `0/0/0`, evidence events `3`, final
  answer `1949` bytes and `6` bullets.

Regression Risk:
- The check is intentionally narrow and only examines the first non-empty line.
  The main risk is rejecting a user-requested heading that looks like a status
  preamble; existing scenario prompts do not request such headings.
- Exporting the quality evaluator made the E2E script part of typecheck and
  exposed two stale script types; both were tightened. A flaky mission-route
  test assumption was also corrected to wait for the asynchronous failure event
  after blocked status.
- Review caught a ReDoS risk in the first implementation of the status-preamble
  matcher; the regex was replaced with normalized string checks and simple
  anchored patterns, with a long-line regression test.

## 24-Hour Review Rule

At least once per day while this goal is active:

1. Group the last 24 hours of issues by category:
   - execution loops or stuck work
   - weak or unsupported final answers
   - browser/session/transport instability
   - UI state mismatch or missing recovery action
   - acceptance environment drift
2. If the same category appears repeatedly and real E2E acceptance is not
   improving, stop feature PRs.
3. Write a methodology-review note before coding more fixes:
   - root cause hypothesis
   - why previous fixes did not converge
   - what architecture or harness change will prevent another local patch loop
   - which real E2E scenario must improve before resuming feature work

## 2026-05-30 19:30 CST - G0 Ledger Guardrails Tightened

Direction: unknown

Execution Kernel:
- No agent, tool, session, browser, or mission execution semantics changed in
  this checkpoint.
- The ledger now makes runtime-facing evidence gates explicit so future kernel
  work cannot be called converging on unit tests or PR count alone.

Result Quality:
- No final-answer behavior changed.
- The ledger now requires result-quality claims to be backed by focused mission
  E2E evidence or explicitly marked as residual risk.

Workbench UX:
- No user-facing page changed.
- The ledger now requires workbench UX changes to carry a user-visible smoke
  check or screenshot-backed manual observation before they are called
  converging.

Browser Reliability:
- No browser transport, profile, bridge, or CDP behavior changed.
- Browser reliability claims now require browser E2E or focused smoke evidence
  when the changed slice touches browser/session behavior.

Acceptance Evidence:
- Documentation-only checkpoint. No real LLM/browser E2E was run.
- Next required acceptance gate for runtime/result-quality work remains a
  focused mission E2E for the changed scenario, followed by the broader real
  acceptance matrix before claiming the workbench goal is complete.

Regression Risk:
- Low product risk because this is governance documentation only.
- Process risk is stricter: future checkpoints may be marked `unknown` more
  often when real acceptance is missing, which is intentional for this goal.
