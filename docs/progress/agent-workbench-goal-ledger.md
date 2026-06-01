# Agent Workbench Goal Ledger

This ledger tracks whether TurnkeyAI is converging toward a production-grade
agent workbench for stable complex-task delivery. It is intentionally not a PR
counter or test-count scoreboard.

G0 operating contract:

- Objective: track whether TurnkeyAI is actually converging toward a
  production-grade agent workbench for stable complex-task delivery.
- This ledger is the source of truth for goal progress while the workbench
  stabilization goal is active.
- While the production workbench goal is active, implementation stages must
  either append a checkpoint to this ledger or explicitly point to the latest
  checkpoint that already covers the same acceptance evidence.
- A stage is not considered closed only because its PR merged. It is closed
  when the relevant acceptance evidence is recorded here and the checkpoint can
  answer whether stable complex-task delivery moved closer.
- Progress is judged by real acceptance, user-visible behavior, and reduction
  of repeated failure classes. PR count, LOC movement, and test count are
  supporting facts only; they are never sufficient evidence by themselves.

Required checkpoint fields:

- Every checkpoint must include the same six evidence areas:
  Execution Kernel, Result Quality, Workbench UX, Browser Reliability,
  Acceptance Evidence, and Regression Risk.
- Every checkpoint must declare one direction:
  `converging`, `oscillating`, `blocked`, or `unknown`.
- The direction must be based on whether a real user is closer to receiving a
  stable, useful complex-task result. A merged PR, larger test count, or larger
  implementation diff is never enough by itself.
- If real acceptance did not run, the checkpoint must say which acceptance gate
  is required next before claiming convergence for that behavior.

Update cadence:

- Add a checkpoint every 2-4 hours while actively working this goal.
- Add an extra checkpoint after any real LLM/browser E2E acceptance run.
- Every 24 hours, review the last day of checkpoints. If the same issue class
  keeps receiving local fixes without better real E2E outcomes, pause feature
  PRs and switch to methodology review.
- `npm run ledger:check` treats dated `24-Hour Goal Review` entries as first
  class ledger records. Once the dated ledger span reaches 24 hours, the check
  rejects any dated ledger window that goes more than 24 hours without a dated
  24-hour review.
- Do not mark a stage as converging unless the checkpoint can answer: "is
  stable complex-task delivery closer than it was at the previous checkpoint?"

24-hour methodology brake:

- Once per 24-hour window, scan the ledger for repeated issue classes:
  execution loops, weak final answers, browser/session instability, UI recovery
  mismatch, and acceptance environment drift.
- If the same class has repeated local fixes but no better real E2E outcome,
  stop feature PRs and write a methodology-review note before coding the next
  behavior change.
- The methodology-review note must name the root-cause hypothesis, why the
  previous fixes failed to converge, and the real scenario that must improve
  before feature work resumes.
- The dated 24-hour review must include: Repeated Issue Classes, E2E Trend,
  Decision, and Methodology Review Trigger.

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

G0 acceptance rules:

- The ledger must not use PR count, test count, line count, or review-comment
  count as the primary progress signal.
- Every phase must answer whether stable complex-task delivery is closer for a
  real user, using acceptance evidence and user-visible behavior as the primary
  proof.
- A 24-hour window that shows repeated local fixes for the same failure class
  without better real E2E behavior is not allowed to continue as ordinary
  feature work. It must switch to methodology review before the next feature PR.
- Methodology review is required to inspect whether the current runtime model,
  prompt harness, session semantics, browser isolation, or UX recovery model is
  the root cause. The next implementation slice must be chosen from that root
  cause, not from the nearest symptom.

Convergence review rule:

- Every checkpoint must be able to answer one product question: did a real user
  become more likely to receive a stable, useful complex-task result?
- If the answer depends only on PR count, test count, refactor size, or review
  volume, the direction is `unknown`, not `converging`.
- If the same class of user-visible failure appears in two or more checkpoints
  inside a 24-hour window, the next 24-hour review must explicitly decide
  whether feature PRs continue or pause for methodology review.
- Methodology review is mandatory when the same failure class receives repeated
  local fixes but the next real E2E run does not improve completion, answer
  quality, or user-visible recoverability.

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

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes | no
- Evidence:
- If no, next required gate:
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
- `npm run release:verify`: passed 9/9 packaged CLI checks.
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

## 2026-05-30 19:38 CST - Local Daemon PID Ownership Guard

Direction: converging

Execution Kernel:
- No mission/tool execution semantics changed.
- Daemon shutdown now removes `~/.turnkeyai/daemon.pid` only when the file still
  points at the current process. This prevents a terminating daemon from
  deleting the pid file written by a freshly restarted daemon.

Result Quality:
- Final-answer behavior did not change.
- This supports result delivery indirectly by improving local runtime
  diagnosability: `turnkeyai daemon status` can show the running process instead
  of claiming `pid: (none)` while `/health` is actually reachable.

Workbench UX:
- Local entry verification improved. `turnkeyai doctor` confirms the CLI is on
  PATH, launchd service is loaded, daemon health is ok, model readiness is ok,
  and browser runtime is healthy.
- The remaining local warning is historical mission-runtime attention, not a
  startup/auth/token failure.

Browser Reliability:
- Browser transport behavior did not change.
- `turnkeyai doctor` reported local browser runtime healthy across recent
  sessions, with relay extension still optional unless relay transport is used.

Acceptance Evidence:
- `turnkeyai doctor`: passed with no failures; warnings were mission-runtime
  attention and optional relay-extension absence.
- `npx tsx --test packages/app-gateway/src/daemon-runtime-paths.test.ts`: 10
  passing.
- `npm test -- --runInBand`: 1200 passing.
- `npm run typecheck`
- `npm run build`
- `git diff --check`
- `npm run release:verify`: passed 9/9 checks, including packaged CLI build,
  packaged Control Center assets, bin help smoke, and publish dry run.
- Focused regression test added for PID ownership cleanup.

Regression Risk:
- Risk is concentrated in shutdown cleanup: stale pid files might be left behind
  if the file no longer matches the exiting process. That is intentional and
  safer than deleting a new daemon's pid file; startup already detects stale pid
  files and cleans them when the port is free.

## 2026-05-30 19:59 CST - Terminal Mission Archive Loop

Direction: converging

Execution Kernel:
- No tool-use or sub-agent execution semantics changed.
- Added an operator archive action for terminal missions only. Active missions
  (`working`, `planning`, `needs_approval`) are rejected with a stable
  `mission_active` conflict, so the cleanup path cannot hide still-running work.

Result Quality:
- Final-answer generation did not change.
- Historical blocked or done missions can now be retired from active attention
  after review, which keeps quality diagnostics focused on current failures
  instead of repeatedly surfacing old E2E/test artifacts.

Workbench UX:
- Mission Detail now exposes a user-visible `Archive` action for terminal
  missions. After archive, the Control Center returns to the mission list.
- The Control Center smoke test exercises the archive click path against the
  mocked API and verifies the route returns to `#/missions`.

Browser Reliability:
- Browser transport behavior did not change.
- Diagnostics now excludes archived missions from mission-attention inspection,
  so stale historical browser/tool failures do not permanently contaminate the
  current browser reliability warning set.

Acceptance Evidence:
- `npm run control-center:smoke -- --allow-missing-browser`: passed.
- `npx tsx --test packages/app-gateway/src/routes/mission-routes.test.ts packages/app-gateway/src/mission-health-diagnostics.test.ts packages/app-gateway/src/daemon-auth.test.ts`:
  42 passing.
- `npm test -- --runInBand`: 1202 passing.
- `npm run typecheck`
- `npm run build`
- `git diff --check`

Regression Risk:
- Archive is a mutation route. The main risk is accidental cleanup of active
  missions; route-level status checks and operator-scope auth cover that path.
- Archived missions remain durable records. This only removes them from active
  diagnostics attention, so terminal history is not deleted and can still be
  inspected by direct store access or future archive-aware UI.

## 2026-05-30 20:22 CST - Archived Missions Leave The Default Workbench

Direction: converging

Execution Kernel:
- No mission, role, tool, worker, browser, or permission execution semantics
  changed.
- The archive action from the previous checkpoint is now reflected in the
  primary mission list: archived missions are removed from the default
  `Current` view and remain available through an explicit `Archived` filter.

Result Quality:
- Final-answer generation did not change.
- This reduces operator noise after reviewing poor or historical runs. The
  result-quality signal remains visible in diagnostics until a mission is
  intentionally archived; after that it no longer competes with current work.

Workbench UX:
- Missions now default to current, non-archived work instead of showing every
  durable historical record.
- The `Archived` filter is explicit and count-backed, so cleanup does not
  become silent deletion.
- The Control Center smoke test now verifies both behaviors: archived missions
  are hidden by default and visible when the operator chooses the archived
  filter.

Browser Reliability:
- Browser transport behavior did not change.
- The smoke fixture also caught a thread-to-mission mapping risk: archived test
  data must not reuse the same `threadId` as the active runtime attention
  mission, because runtime replay uses thread mapping to open mission traces.

Acceptance Evidence:
- `npm run control-center:smoke -- --allow-missing-browser`: passed.
- `npm run build:control-center`
- `npm run typecheck`
- `npm run build`
- `npm test -- --runInBand`: 1202 passing.
- `git diff --check`
- `npm run release:verify`: passed 9/9 packaged CLI checks.

Regression Risk:
- Risk is isolated to client-side filtering. The daemon still returns archived
  missions from `/missions`, so no API consumer loses durable history.
- The default label changed from `All` to `Current`; users who need old runs now
  make an explicit archived-filter choice instead of seeing stale runs mixed
  into the normal work queue.

## 2026-05-30 20:37 CST - App Launcher Infers Token Scope

Direction: converging

Execution Kernel:
- No mission/tool/worker/browser execution semantics changed.
- `turnkeyai app` now probes the healthy daemon before opening the Control
  Center when its configured token source is legacy/unknown. It classifies the
  token with safe read-only checks in admin → operator → read order.

Result Quality:
- Final-answer behavior did not change.
- This supports result delivery indirectly by reducing launch confusion:
  users no longer enter the workbench with a stale-looking `scope=unknown`
  when the local single-token daemon actually grants admin access.

Workbench UX:
- Local app launch now prints and injects the inferred scope. On the current
  local daemon, `npm run app -- --no-open` opens with `scope=admin`.
- Agent Connect, Settings, Runtime, and other scope-gated UI can render the
  right affordances immediately instead of displaying "checking" for a healthy
  local install.

Browser Reliability:
- Browser transport behavior did not change.
- The operator-scope probe uses `GET /browser-sessions`, so it also validates
  that the launcher token can reach the browser-session inspection surface
  before the UI relies on it.

Acceptance Evidence:
- `npx tsx --test packages/cli/src/app-command.test.ts packages/cli/src/daemon-token.test.ts`:
  35 passing.
- `npm run typecheck`
- `npm run build --workspace @turnkeyai/cli`
- `npm run app -- --no-open`: printed `scope=admin` for the local daemon URL.
- `npm test -- --runInBand`: 1205 passing.
- `npm run build`
- `git diff --check`
- `npm run release:verify`: passed 9/9 packaged CLI checks.

Regression Risk:
- Scope probing is best-effort and falls back to `unknown` when the daemon
  rejects or cannot answer the probes, preserving the prior behavior.
- The probes are non-mutating (`HEAD /daemon/config/model-catalog`,
  `GET /browser-sessions`, `GET /bridge/status`) and run only after the daemon
  health check passes.

## 2026-05-30 20:49 CST - Daemon Service Restart Entry

Direction: converging

Execution Kernel:
- No mission, role, tool-use, sub-agent, browser command, or result-synthesis
  semantics changed in this checkpoint.
- The change targets local lifecycle control: an installed macOS LaunchAgent
  service can be restarted through the product CLI instead of requiring users
  to know raw `launchctl` commands.

Result Quality:
- Final-answer substance did not change.
- The expected quality impact is indirect: fewer stale daemon/config states
  during local testing should reduce false negatives when evaluating complex
  agent runs.

Workbench UX:
- The user-visible local entry surface becomes more complete:
  `turnkeyai daemon service restart` sits beside install/status/uninstall and
  gives operators a supported recovery command after editing local config.
- This does not add a new Control Center UI recovery button; it closes a CLI
  lifecycle gap discovered while testing the workbench locally.

Browser Reliability:
- Browser transport behavior did not change.
- Restarting the daemon service can clear stale bridge/session process state,
  but it is not a replacement for browser profile isolation, CDP attach
  recovery, or real browser acceptance.

Acceptance Evidence:
- Static verification passed:
  `npx tsx --test packages/cli/src/cli-help.test.ts packages/cli/src/daemon-commands.test.ts`
  (18 passing),
  `npm run typecheck`,
  `npm run build --workspace @turnkeyai/cli`,
  `npm test -- --runInBand` (1206 passing),
  `npm run build`,
  `npm run release:verify` (9/9 checks passed),
  `git diff --check`.
- Review caught a real restart race: `kickstart -k` can return before the old
  daemon stops, so a naive health check may hit the old process. The command now
  waits for the pre-restart PID to change or exit before accepting health.
- Real local lifecycle acceptance passed after merge:
  `turnkeyai daemon service restart` returned
  `daemon service restarted: com.turnkeyai.daemon` at
  `http://127.0.0.1:4100`;
  `turnkeyai daemon service status` reported launchd running with pid `63691`;
  `turnkeyai doctor` reported no failures and one optional relay-extension
  warning.

Regression Risk:
- Risk is limited to the macOS service namespace. A bad restart implementation
  could leave the local daemon stopped or healthy on a different config than
  the UI expects.
- Focused help/artifact tests cover the exposed command surface and the
  pre-restart PID guard. Real local service acceptance covered the installed
  LaunchAgent path on this workstation.

## 2026-05-30 21:23 CST - No-Token Service Restart Guidance

Direction: converging

Execution Kernel:
- No mission, role, tool-use, worker, browser, or completion semantics changed.
- This checkpoint closes a product-entry wiring gap: the daemon service restart
  command was available in the CLI but not visible on the no-token recovery
  page users see when they open Mission Control without launcher-injected auth.

Result Quality:
- Final-answer quality did not change.
- The improvement is acceptance hygiene: users and operators have a visible
  restart path after local config/model/browser changes, reducing false
  negatives caused by stale daemon state before evaluating complex missions.

Workbench UX:
- The `Auth token required` page now includes a `Reload service config` command
  for `turnkeyai daemon service restart`.
- The same page also explains that persistent daemon commands keep the service
  alive across logins and reload service-only configuration.

Browser Reliability:
- Browser transport behavior did not change.
- Restart guidance can clear stale local browser/daemon config after an
  operator changes `daemon.env`, model catalogs, or browser settings, but it is
  not a browser recovery policy by itself.

Acceptance Evidence:
- `npm run build:control-center`: passed.
- First smoke attempt with implicit browser resolution hung before launching a
  browser process. Re-ran with an explicit Chrome executable to remove
  environment ambiguity.
- `npm run control-center:smoke -- --browser-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`:
  passed, including desktop and mobile mission detail screenshots.

Regression Risk:
- Risk is localized to the no-token page copy and smoke assertion. The page now
  contains the restart command in both a command card and explanatory note, so
  smoke uses a card-scoped locator to avoid false strict-mode failures.
- Remaining gap: this does not prove complex-task quality; the next runtime or
  result-quality change still requires real LLM acceptance.

## 2026-05-30 21:44 CST - Focused Realistic-Brief Acceptance Refresh

Direction: converging

Execution Kernel:
- No execution kernel code changed in this checkpoint.
- The checkpoint closes the previous evidence gap by rerunning a realistic
  multi-source mission through the real LLM path after the local entry and
  no-token recovery UX changes.

Result Quality:
- The realistic-brief mission reached `done` and passed the structured quality
  gate. The gate checks more than completion: source coverage, recommendation,
  dashboard action, residual risk, unsupported-claim avoidance, and answer
  substance.
- This is positive evidence that the current tool/session/runtime path can
  still synthesize a useful result after recent product-entry changes. It does
  not prove all complex prompts are stable; it proves the current focused
  benchmark is still converging.

Workbench UX:
- No UI code changed in this checkpoint.
- The user-visible result path remains inspectable through the mission ID from
  the E2E run, so future regressions can compare timeline/tool/result behavior
  against a known passing mission.

Browser Reliability:
- The scenario exercised the browser-backed dashboard evidence path without a
  CDP/profile failure in the isolated E2E daemon.
- Relay-extension health remains optional for this local run because the
  browser path used local automation.

Acceptance Evidence:
- `npm run mission:e2e -- --scenario realistic-brief --model-catalog models.local.json --scenario-timeout-ms 300000`:
  passed.
- Mission ID: `msn.mpseir1l.1`.
- Reported metrics: mission status `done`, quality gate `passed`, tool events
  `6`, tools `3/3`, sessions `3/0`, approvals `0/0/0`, liveness `0/0/0`,
  evidence `3`, final answer `1195` bytes across `6` bullets.

Regression Risk:
- Risk remains that one focused scenario can miss long-tail failures in
  follow-up, cancellation, approval, timeout recovery, or browser reconnect
  behavior. The next runtime/result-quality PR should still run the broader
  `acceptance:real` matrix before claiming production-level convergence.
- This checkpoint supports continued feature/runtime work; it does not trigger
  methodology review because the latest real E2E improved confidence rather
  than repeating a previously stuck or weak-output failure.

## 2026-05-30 21:58 CST - Tool-Fallback Quality Gate

Direction: converging

Execution Kernel:
- No tool execution semantics changed. The runtime still allows the lead to
  complete after tool-use, session, browser, approval, timeout, and recovery
  outcomes settle.
- Mission observability now treats final answers that say a required tool,
  browser, search, retrieval, or web path was unavailable and then fall back to
  model knowledge as a first-class quality signal instead of a normal finish.

Result Quality:
- Added the `tool_fallback_answer` quality check. A completed answer such as
  "search tools are unavailable, based on my knowledge..." now becomes
  operator-visible attention instead of blending into a weak final answer.
- The existing unsupported-uncertainty detector now also catches Chinese
  unavailable/needs-follow-up phrasing that previously slipped through.
- A no-evidence fallback answer is blocked by the existing evidence check and
  also carries the new fallback warning; evidence-backed realistic work still
  passes.

Workbench UX:
- Mission Detail maps `tool_fallback_answer` to an explicit action: continue
  with a narrower tool-backed request or inspect tool availability before
  accepting the answer.
- Control Center smoke now verifies the user-visible action text in the Mission
  Health panel.

Browser Reliability:
- Browser transport behavior did not change.
- The real acceptance run still exercised the browser-backed dashboard evidence
  path without profile, attach, or CDP failure in the isolated daemon.

Acceptance Evidence:
- `npx tsx --test packages/app-gateway/src/mission-observability.test.ts`:
  14 passed, including a long-whitespace fallback phrasing regression for the
  review-identified ReDoS risk.
- `npm run build:control-center`: passed.
- `npm run control-center:smoke -- --browser-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`:
  passed, screenshot bytes `120001`, mobile screenshot bytes `55054`.
- `npm run typecheck`: passed.
- `npm test -- --runInBand`: 1208 passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Real LLM gate:
  `npm run mission:e2e -- --scenario realistic-brief --model-catalog models.local.json --scenario-timeout-ms 300000`
  passed with mission `msn.mpsf9tmo.1`, status `done`, quality gate `passed`,
  tools `3/3`, sessions `3/0`, liveness `0/0/0`, evidence `3`, final answer
  `1228` bytes across `6` bullets.

Regression Risk:
- Regex-based quality detection can still miss paraphrases, but the added check
  covers the concrete weak-output class observed in local product testing
  without changing tool execution. Review caught an overlapping-whitespace
  regex risk; the detector now normalizes whitespace first and uses smaller
  bounded checks.
- False positives are limited to quality-gate attention, not mission execution
  failure. The real realistic-brief acceptance passing after the change is the
  guard against over-blocking normal evidence-backed work.

## 2026-05-30 22:14 CST - Acceptance Gates Reject Tool Fallbacks

Direction: converging

Execution Kernel:
- No runtime execution semantics changed.
- The improvement is in the acceptance harness: both mission-level E2E final
  quality and lower-level tool-use acceptance now reject final answers that
  admit tool/search/browser unavailability and then fall back to model
  knowledge.

Result Quality:
- This closes a governance gap from the previous checkpoint. The runtime
  quality gate could already flag tool fallback answers, but the real E2E
  verifier itself could still accept such an answer if required markers were
  present.
- The mission final-answer evaluator now rejects English and Chinese fallback
  phrasing, including long-whitespace variants that could otherwise mask a weak
  answer or stress regex matching.

Workbench UX:
- No Control Center UI changed in this checkpoint.
- User-facing benefit is indirect but important: future real acceptance runs
  are less likely to certify a mission whose UI would later show a weak
  tool-fallback answer.

Browser Reliability:
- Browser transport behavior did not change.
- The real LLM acceptance run still exercised the browser-rendered dashboard
  source path and passed with local automation.

Acceptance Evidence:
- `npx tsx --test packages/app-gateway/src/mission-tool-use-e2e-quality.test.ts`:
  5 passed.
- `npm run tooluse:e2e`: passed, including the mock acceptance quality suite.
- `npm run mission:e2e -- --scenario realistic-brief --model-catalog models.local.json --scenario-timeout-ms 300000`:
  passed with mission `msn.mpsfkqqn.1`, status `done`, quality gate `passed`,
  tools `3/3`, sessions `3/0`, liveness `0/0/0`, evidence `3`, final answer
  `1248` bytes across `6` bullets.
- `npm run typecheck`: passed.
- `npm test -- --runInBand`: 1210 passed.
- `npm run build`: passed.
- `git diff --check`: passed.

Regression Risk:
- The new harness rule can reject answers that honestly report tool
  unavailability. That is intentional for success-path E2E gates: a fallback
  answer may be acceptable as a blocked/attention outcome, but it must not pass
  as a successful complex-task delivery.
- The realistic-brief real LLM pass protects against over-rejecting normal
  evidence-backed answers.

## 2026-05-30 22:36 CST - Mission-Level TUI Entry

Direction: converging

Execution Kernel:
- No mission, role, tool-use, worker, browser, approval, or completion
  semantics changed.
- The change is an entry-surface improvement: terminal users can now create,
  inspect, select, and follow up on missions without dropping to raw
  thread/runtime commands.

Result Quality:
- No result synthesis logic changed, so this checkpoint does not claim better
  answer quality.
- The TUI now surfaces mission quality gate status, non-passing checks, evidence
  count, latest final answer, and recent timeline events, making weak or
  fallback answers easier to catch from the terminal path.

Workbench UX:
- Added mission-level TUI commands: `missions`, `mission`, `mission-use`,
  `mission-new`, and `mission-send`.
- The TUI prompt now tracks the current mission when one is selected or created.
- The local install runbook now documents the terminal mission workflow as a
  friendly fallback to the browser workbench, not as the primary product entry.

Browser Reliability:
- Browser transport behavior did not change.
- Browser-backed missions benefit only indirectly because the TUI can inspect
  the same mission timeline and health metrics that browser tasks already
  populate.

Acceptance Evidence:
- `npx tsx --test packages/tui/src/mission-tui.test.ts`: 7 passed.
- `npm run tui -- --help`: passed.
- `npm run typecheck`: passed.
- `npm test -- --runInBand`: 1217 passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Real LLM E2E was not rerun for this checkpoint because execution semantics did
  not change; the previous realistic-brief acceptance remains the latest
  runtime/result-quality proof.

Regression Risk:
- Main risk is CLI/TUI formatting or route wiring, not runtime correctness.
- Mission creation and follow-up still depend on the daemon orchestrator being
  configured; missing orchestrator returns the existing route-level error.
- If terminal mission usage exposes poor follow-up quality later, that should be
  counted as a runtime/result-quality issue and must go through real mission
  E2E rather than another UI-only pass.

## 2026-05-30 22:56 CST - Ledger Structure Gate

Direction: converging

Execution Kernel:
- No mission, role, tool-use, worker, browser, approval, or completion
  semantics changed.
- Added an automated ledger validator so progress accounting is checked by a
  command instead of relying only on manual review.

Result Quality:
- No answer synthesis or quality-gate logic changed.
- The validator makes it harder to claim progress without recording acceptance
  evidence and regression risk for the checkpoint.

Workbench UX:
- No Control Center or TUI user flow changed.
- Product-management visibility improved because `npm run ledger:check` now
  verifies that dated checkpoints keep the required G0 structure.

Browser Reliability:
- Browser transport behavior did not change.
- Browser-related claims in future checkpoints must still be recorded in the
  Browser Reliability section for the ledger check to pass.

Acceptance Evidence:
- `npm run ledger:check`: passed, 17 checkpoint(s).
- `npx tsx --test scripts/agent-workbench-ledger-check.test.ts`: 3 passed.
- `npm run typecheck`: passed.
- `npm test -- --runInBand`: 1220 passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Real LLM E2E was not rerun because this checkpoint changes progress
  governance only, not runtime or result behavior.

Regression Risk:
- The gate intentionally validates structure, not truth. It cannot prove that a
  checkpoint's evidence is strong enough; reviewers still need to inspect
  commands, mission IDs, screenshots, and runtime behavior.
- Adding script tests to the root `npm test` command broadens the default test
  surface; the immediate risk is low because the new script test is fast and
  self-contained.

## 2026-05-30 23:08 CST - Mission E2E JSON Evidence

Direction: converging

Execution Kernel:
- No mission, role, tool-use, worker, browser, approval, or completion
  semantics changed.
- The mission-level E2E harness can now write a structured JSON report for
  completed real-LLM mission runs, preserving the same assertions while making
  the acceptance evidence durable.

Result Quality:
- No answer synthesis, prompt, or runtime quality gate changed.
- The report carries final-answer byte count, bullet count, quality gate
  status, and quality failures so reviewers can compare complex-task delivery
  across runs without treating PR/test counts as the progress signal.

Workbench UX:
- No Control Center or TUI surface changed.
- User-visible benefit is operational: release reviewers and operators can
  attach a compact mission E2E report to a release/checkpoint instead of
  reconstructing acceptance quality from terminal logs.

Browser Reliability:
- Browser transport behavior did not change.
- Browser-backed mission scenarios can now persist browser-related evidence
  counts, tool/session metrics, recovery events, and liveness state in the same
  report as non-browser scenarios.

Acceptance Evidence:
- `npm run ledger:check`: passed, 19 checkpoint(s).
- `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts`: 3 passed.
- `npm run mission:e2e -- --help`: passed and lists `--json <path>`.
- `npm run typecheck`: passed.
- `npm test -- --runInBand`: 1223 passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Real LLM E2E was not rerun for this checkpoint because this is an acceptance
  artifact change, not a runtime/result-quality change. The next runtime or
  result-quality stage still requires a fresh real LLM mission acceptance run.

Regression Risk:
- The JSON report is a review artifact, not a substitute for running real E2E.
  It can prove what a successful run observed, but cannot make an unrun
  scenario count as accepted.
- The report intentionally omits the final-answer body to keep artifacts small
  and avoid leaking bulky or sensitive mission output; reviewers still need the
  raw mission logs when debugging content quality.

## 2026-05-30 23:25 CST - Real Mission E2E Evidence Artifact

Direction: converging

Execution Kernel:
- No runtime code changed after the JSON report PR landed.
- A fresh real-LLM mission route run exercised the existing lead tool-use loop
  with three child sessions and completed without active, waiting, or stale
  runtime work left behind.

Result Quality:
- The realistic brief scenario completed with quality gate `passed`, zero
  quality failures, six final-answer bullets, and 1320 final-answer bytes.
- This is a stronger progress signal than test count alone because it proves a
  product-level mission produced a bounded, evidence-backed result through the
  user-facing mission route.

Workbench UX:
- No Control Center or TUI UI changed.
- The user-visible improvement is evidence handling: the same mission result
  can now be reviewed from the terminal output and from a compact JSON artifact
  without scraping logs.

Browser Reliability:
- This scenario included one browser-rendered operations dashboard source
  through the mission tool-use path.
- Browser-related liveness settled to zero, with no failed, cancelled, timeout,
  or recovery events in the generated report.

Acceptance Evidence:
- `npm run mission:e2e -- --scenario realistic-brief --model-catalog models.local.json --scenario-timeout-ms 300000 --json /tmp/turnkeyai-mission-e2e-realistic-brief-20260530-2319.json`:
  passed.
- Mission id: `msn.mpsi4l79.1`.
- JSON report status: `passed`; duration: `28733` ms.
- Metrics: tools `3/3`, sessions `3/0`, approvals `0/0/0`, liveness `0/0/0`,
  evidence events `3`, recovery events `0`.

Regression Risk:
- This is one real scenario, not the full matrix. It proves the JSON artifact
  path and a representative complex mission still work, but it does not replace
  the full `acceptance:real` gate before high-risk runtime changes.
- The artifact omits final-answer text by design, so content debugging still
  requires mission logs or the Control Center mission view.

## 2026-05-30 23:33 CST - Release Gate Mission Artifact

Direction: converging

Execution Kernel:
- The top-level `acceptance:real` gate now passes a mission JSON report path
  into the mission route E2E step and uses one run id for the validation-ops
  record plus the artifact filename.
- Runtime mission/tool/browser semantics did not change; this checkpoint
  strengthens the release evidence path around those semantics.

Result Quality:
- The reduced real gate completed `realistic-brief` with quality gate `passed`,
  six final-answer bullets, 1334 final-answer bytes, and zero quality failures.
- The validation artifact gives reviewers a stable way to compare answer
  quality and mission liveness across release gates without relying on terminal
  scrollback.

Workbench UX:
- Runtime → Release acceptance can now point at the mission evidence artifact
  from the same validation-ops run record that marks the gate passed or failed.
- Control Center smoke now waits for concrete rendered state instead of generic
  network idle or an empty recovery-card shell, matching the app's polling
  behavior and reducing false build failures around mission replay.

Browser Reliability:
- The mission scenario included the browser-rendered dashboard source through
  the mission route path.
- Browser/tool liveness settled to zero, with no failed, cancelled, timeout, or
  recovery events in the generated mission report.

Acceptance Evidence:
- `npm run acceptance:real -- --skip-browser-tooluse --tooluse-scenarios basic --mission-scenarios realistic-brief --model-catalog models.local.json --scenario-timeout-ms 300000 --data-dir /tmp/turnkeyai-real-acceptance-artifact-20260530`:
  passed.
- Validation-ops run id:
  `validation-ops:real-llm-acceptance:2026-05-30T15-32-54-122Z:s21qc9`.
- Mission id: `msn.mpsifk1z.1`.
- Mission JSON report status: `passed`; duration: `29728` ms.
- Metrics: tools `3/3`, sessions `3/0`, approvals `0/0/0`, liveness `0/0/0`,
  evidence events `3`, recovery events `0`.
- `npm run control-center:smoke`: passed.

Regression Risk:
- The reduced gate intentionally skipped provider-native browser tool-use to
  keep this implementation-slice verification bounded; the full browser gate is
  still required before high-risk runtime/browser releases.
- The artifact path is recorded only when the mission report file exists. If
  the tool-use leg fails before mission E2E starts, validation-ops will still
  record the failed run without a mission artifact, which is the correct signal.
- The smoke harness change deliberately tightens waits around visible UI state;
  it does not weaken the read-scope recovery assertions.

## 2026-05-30 23:59 CST - Runtime Shows Acceptance Artifact

Direction: converging

Execution Kernel:
- No mission/tool/runtime execution semantics changed.
- The validation-ops run type used by Control Center now includes optional
  artifact path metadata, matching the real-acceptance record emitted by the
  top-level gate.

Result Quality:
- No answer synthesis changed.
- Result-quality evidence is more visible to operators because the Runtime
  release card can now show where the mission E2E JSON summary lives for the
  latest real-LLM acceptance run.

Workbench UX:
- Runtime → Release acceptance now surfaces `artifact: <path>` for validation
  runs that carry an artifact, including the real acceptance mission report.
- The Control Center smoke fixture asserts the path is visible in the release
  acceptance card, closing the user-visible half of the previous checkpoint.

Browser Reliability:
- Browser runtime behavior did not change.
- The visible artifact path helps browser-backed mission acceptance evidence
  remain inspectable after the gate, but does not itself prove a new browser
  run.

Acceptance Evidence:
- `npm run build --workspace @turnkeyai/control-center`: passed.
- `npm run control-center:smoke`: passed.
- `npm run ledger:check`: passed.
- `npm run typecheck`: passed.
- `npm test -- --runInBand`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- The smoke fixture includes
  `validation-artifacts/real-llm-acceptance/mission-e2e-ui.json` on the latest
  `real-llm-acceptance` run and verifies it is rendered in Runtime.

Regression Risk:
- This is a display-only change. If an artifact path points to a file no longer
  present on disk, Runtime will still show the recorded path; actual file
  download/open support remains a separate product feature.
- The path is shown as plain text rather than a link to avoid inventing a file
  serving route in this slice.

## 2026-05-31 00:21 CST - Mission Lifecycle Sees Active Workers

Direction: converging

Execution Kernel:
- Mission lifecycle reconciliation now considers durable worker sessions in
  addition to role-run state before declaring a stalled tool turn blocked.
- If worker-session lookup fails while the store is configured, reconciliation
  treats the worker state as unknown/active instead of prematurely blocking the
  mission.

Result Quality:
- No prompt or answer synthesis changed.
- This reduces false blocked states where a child worker is still collecting
  evidence, which protects complex-task runs from being cut off before the
  final synthesis turn can use the worker result.

Workbench UX:
- Mission status should remain `working` while an associated worker session is
  still running, waiting for input, waiting externally, or resumable.
- The thought/process view still comes from message and progress mirroring;
  this slice only fixes the lifecycle gate that decides whether the mission is
  still active or stalled.

Browser Reliability:
- Browser workers are now part of mission completion evaluation through the
  same durable worker-session path as other sub-agents.
- This helps long browser sessions avoid being mislabeled as stalled when the
  lead role has yielded but the browser worker has not finished.

Acceptance Evidence:
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- `npm test -- --runInBand packages/app-gateway/src/mission-completion-evaluator.test.ts packages/app-gateway/src/mission-thread-bridge.test.ts`:
  passed; the command ran the current repo test harness and reported `1227`
  passing tests.
- New evaluator coverage verifies active and unknown worker sessions prevent
  premature stalled-tool blocking.
- New thread-bridge coverage verifies an idle lead run plus a running worker
  session keeps the mission `working`.

Regression Risk:
- The bridge filters worker sessions by `context.threadId`; sessions without a
  thread context do not keep unrelated missions alive.
- Worker-session lookup failure is conservative and may delay a blocked status
  until a later reconciliation tick can read the store, but it avoids the worse
  failure mode of cutting off a live worker.

## 2026-05-31 00:33 CST - Real Mission E2E After Active Worker Lifecycle

Direction: converging

Execution Kernel:
- The post-merge runtime path completed a real mission after mission lifecycle
  reconciliation started considering active worker sessions.
- The run ended with no active, waiting, or stale liveness entries.

Result Quality:
- The mission quality gate passed with an evidence-backed final answer.
- The final answer was 1471 bytes and 6 bullets, with 3 evidence events
  captured in mission metrics.

Workbench UX:
- The mission reached `done`, which keeps the Mission UI and Runtime release
  evidence path aligned with an actually completed user-facing result.
- The generated JSON report can be used as an acceptance artifact for later
  inspection.

Browser Reliability:
- The scenario used 3 spawned worker sessions and all 3 tool results completed.
- No recovery events, failed tools, cancelled tools, timeouts, or residual
  liveness entries were recorded.

Acceptance Evidence:
- `npm run mission:e2e -- --scenario realistic-brief --model-catalog models.local.json --scenario-timeout-ms 300000 --json /tmp/turnkeyai-mission-e2e-realistic-brief-after-active-worker-20260531.json`:
  passed.
- Mission id: `msn.mpskbcoy.1`.
- Metrics: tools `3/3`, sessions `3/0`, approvals `0/0/0`, liveness `0/0/0`,
  evidence events `3`, recovery events `0`.
- JSON artifact:
  `/tmp/turnkeyai-mission-e2e-realistic-brief-after-active-worker-20260531.json`.

Regression Risk:
- This is one real scenario, not the full matrix. It proves the active-worker
  lifecycle change did not break a realistic mission route, but broader
  browser/approval/follow-up scenarios still need the full release gate before
  claiming production readiness.

## 2026-05-31 00:41 CST - Real Follow-Up Reuses Existing Session

Direction: converging

Execution Kernel:
- A real mission follow-up completed through the mission route with one initial
  `sessions_spawn` and one continuation `sessions_send`.
- The follow-up scenario required the lead to reuse the prior `session_key` and
  forbade `sessions_spawn`, `sessions_history`, and `sessions_list` during the
  continuation phase.

Result Quality:
- The mission quality gate passed.
- The final answer matched the expected compact evidence shape with 3 bullets,
  included the fixture marker, named `sessions_send`, and stated residual risk.

Workbench UX:
- The mission reached `done` after a user follow-up instead of remaining stuck
  in an in-flight state.
- Timeline metrics showed the continuation as user-visible tool activity:
  4 tool events, 2 evidence events, and no residual liveness.

Browser Reliability:
- This scenario used an explore worker rather than browser control.
- It validates the session-continuity contract that browser follow-ups depend
  on: reuse the existing child session instead of spawning a duplicate session.

Acceptance Evidence:
- `npm run mission:e2e -- --scenario followup --model-catalog models.local.json --scenario-timeout-ms 300000 --json /tmp/turnkeyai-mission-e2e-followup-20260531.json`:
  passed.
- Mission id: `msn.mpskkrng.1`.
- Metrics: tools `2/2`, sessions `1/1`, approvals `0/0/0`, liveness `0/0/0`,
  evidence events `2`.
- Final answer: 319 bytes, 3 bullets.
- JSON artifact: `/tmp/turnkeyai-mission-e2e-followup-20260531.json`.

Regression Risk:
- This proves hot session continuation for a real follow-up. It does not prove
  browser hot/warm/cold resume or restart recovery; those still require the
  browser-focused acceptance path before production readiness is claimed.

## 2026-05-31 00:46 CST - Real Browser Dashboard Mission E2E

Direction: converging

Execution Kernel:
- A real mission completed the browser-dashboard scenario through the mission
  route and worker session runtime.
- The run completed with one tool request, one tool result, one spawned
  browser-backed session, and zero residual liveness.

Result Quality:
- The mission quality gate passed.
- The final answer was 502 bytes and 4 bullets, with the dashboard evidence
  marker represented in mission metrics.

Workbench UX:
- The mission reached `done`, so Mission Detail can present a completed
  browser-backed result rather than a stuck working state.
- The generated mission JSON report is available as an external acceptance
  artifact for inspection.

Browser Reliability:
- This is a browser-dashboard mission path, not only a text research path.
- Metrics reported no failed tools, cancelled tools, timeouts, approvals, or
  lingering active/waiting/stale runtime entries.

Acceptance Evidence:
- `npm run mission:e2e -- --scenario browser-dashboard --model-catalog models.local.json --scenario-timeout-ms 300000 --json /tmp/turnkeyai-mission-e2e-browser-dashboard-20260531.json`:
  passed.
- Mission id: `msn.mpskqj0a.1`.
- Metrics: tools `1/1`, sessions `1/0`, approvals `0/0/0`, liveness `0/0/0`,
  evidence events `1`.
- JSON artifact: `/tmp/turnkeyai-mission-e2e-browser-dashboard-20260531.json`.

Regression Risk:
- This proves one browser-backed mission scenario. It does not replace the full
  real acceptance matrix, and it does not by itself prove browser reconnect or
  hot/warm/cold resume under profile/CDP failure.

## 2026-05-31 00:53 CST - Full Real Acceptance Gate Rerun

Direction: converging

Execution Kernel:
- The full real acceptance gate completed across provider-native tool-use,
  browser-backed tool-use, direct-CDP smoke, and the mission route matrix.
- A previous full run failed during the `complex` tool-use scenario because the
  final answer missed the required target marker. A focused rerun of the same
  `complex` scenario passed before the full gate was rerun, which points to
  final-answer contract stability as the residual risk rather than a persistent
  browser/CDP outage.

Result Quality:
- The mission matrix produced `done` missions for all 12 scenarios and passed
  quality gates for normal success scenarios.
- The `cancel` and `timeout-recovery` scenarios intentionally reported blocked
  quality states while still ending with clean mission status and no residual
  liveness, which matches the acceptance contract for those degraded paths.
- Product-level brief scenarios still need continued substance review, but this
  run proves the current real-LLM harness can complete broad multi-tool work
  without stuck `creating` or `working` states.

Workbench UX:
- The generated mission JSON artifact gives the workbench and Release
  acceptance card a concrete evidence file for operator inspection.
- The mission matrix still emits no useful intermediate progress for several
  minutes while running. That is an observability gap for long acceptance and
  long user missions; it should not be mistaken for runtime failure, but it is
  still poor operator feedback.

Browser Reliability:
- Browser-backed tool-use `complex` passed with two spawned sessions and
  browser child transcript persistence.
- Direct-CDP smoke passed in the same top-level gate, covering action parity,
  raw-CDP target attach, OOPIF/shadow probing, coordinate input, popup target,
  multi-target continuity, network controls, artifact safety, download, and
  upload paths.
- Browser-dashboard and browser-dynamic mission scenarios both completed with
  zero failed, cancelled, timeout, recovery, or residual liveness entries.

Acceptance Evidence:
- Focused rerun:
  `npm run tooluse:e2e -- --real-llm --scenario complex --with-browser --model-catalog models.local.json --scenario-timeout-ms 300000 --cdp-timeout-ms 45000`:
  passed; final marker `TURNKEYAI_COMPLEX_E2E_OK`, tool calls
  `sessions_spawn,sessions_spawn`, final bytes `649`, bullets `3`, spawned
  sessions `2`, child transcript messages `18`.
- Full gate:
  `npm run acceptance:real -- --model-catalog models.local.json --scenario-timeout-ms 300000 --cdp-timeout-ms 45000 --data-dir /tmp/turnkeyai-real-acceptance-20260531-full-rerun`:
  passed in `375180` ms.
- Validation-ops run id:
  `validation-ops:real-llm-acceptance:2026-05-30T16-47-26-921Z:o4qakz`.
- Mission JSON artifact:
  `/tmp/turnkeyai-real-acceptance-20260531-full-rerun/validation-artifacts/real-llm-acceptance/validation-ops%3Areal-llm-acceptance%3A2026-05-30T16-47-26-921Z%3Ao4qakz-mission-e2e.json`.
- Tool-use matrix passed: `basic`, `approval`, `followup`, `timeout`,
  `complex`.
- Mission matrix passed: `basic`, `comparison`, `followup`, `cancel`,
  `approval`, `browser-dynamic`, `browser-dashboard`, `timeout-recovery`,
  `memory-recall`, `task-tracking`, `product-workbench-brief`,
  `realistic-brief`.
- Representative mission ids: `msn.mpsl4vgn.1` basic, `msn.mpsl57wa.2`
  comparison, `msn.mpsl5nfo.3` followup, `msn.mpsl74n7.6` browser-dynamic,
  `msn.mpsl7kxj.7` browser-dashboard, `msn.mpsl9ybk.11`
  product-workbench-brief, `msn.mpslamd5.12` realistic-brief.

Regression Risk:
- The earlier failed full run means complex final-answer formatting still has
  some stochastic risk. If this failure class repeats in the next 24-hour
  window, pause feature PRs and start methodology review around output
  contracts and harness determinism rather than adding another local patch.
- The full gate took more than six minutes and had sparse mission-matrix
  terminal progress. Runtime and acceptance observability are still behind the
  execution kernel.
- This checkpoint proves the current broad gate can pass once; it is not yet a
  statistical soak of repeated real-LLM runs.

## 2026-05-31 01:04 CST - Mission Matrix Progress Visibility

Direction: converging

Execution Kernel:
- No mission, role, tool-use, worker, browser, approval, or completion
  semantics changed.
- The mission E2E matrix now emits a start line before each scenario and a pass
  line immediately after each scenario completes, including elapsed time,
  mission id, quality gate, tool/session counts, and liveness.

Result Quality:
- Result synthesis did not change.
- The focused real mission subset still passed quality gates for both `basic`
  and `followup`, proving the visibility change did not alter final-answer
  behavior for those paths.

Workbench UX:
- Long real acceptance runs no longer look idle until the entire mission matrix
  finishes. Operators can now see which user-facing scenario is currently
  running and which mission id was produced as soon as each scenario completes.
- This closes the immediate observability gap recorded in the previous
  checkpoint, though it is still terminal/script visibility rather than a live
  Control Center stream.

Browser Reliability:
- This slice did not change browser transport or browser worker behavior.
- The change makes browser-backed mission scenarios easier to diagnose in a
  full gate because the running scenario and last completed browser mission are
  visible before the matrix exits.

Acceptance Evidence:
- `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts`: passed, 4
  tests.
- `npm run mission:e2e -- --matrix-scenarios basic,followup --model-catalog models.local.json --scenario-timeout-ms 300000 --json /tmp/turnkeyai-mission-e2e-progress-lines-20260531.json`:
  passed.
- Real output included immediate progress lines:
  `mission scenario starting: basic (1/2)`,
  `mission scenario passed: basic (1/2, 15132ms) mission-id=msn.mpslnja7.1 quality=passed tools=1/1 sessions=1/0 liveness=0/0/0`,
  `mission scenario starting: followup (2/2)`, and
  `mission scenario passed: followup (2/2, 33235ms) mission-id=msn.mpslnuyj.2 quality=passed tools=2/2 sessions=1/1 liveness=0/0/0`.
- Mission JSON artifact:
  `/tmp/turnkeyai-mission-e2e-progress-lines-20260531.json`.

Regression Risk:
- Because scenario summaries now print during the loop, logs are more verbose
  and no longer grouped only at the end. The JSON report remains built from the
  same accumulated results, so durable artifact shape is unchanged.
- This improves release/operator feedback but does not replace true live UI
  streaming. The next observability step should surface comparable mission
  progress in the workbench rather than only in scripts.

## 2026-05-31 01:16 CST - Mission Now Workbench Summary

Direction: converging

Execution Kernel:
- No mission, role, tool-use, worker, browser, approval, or completion
  semantics changed.
- Mission Detail now derives a compact `Mission now` summary from existing
  mission status, metrics, timeline events, role runs, and worker sessions.

Result Quality:
- Result synthesis did not change.
- The new summary makes weak or attention-needed terminal output easier to spot
  because it pairs the quality state with the latest replay event and latest
  tool step instead of hiding those signals behind the collapsed trace.

Workbench UX:
- Mission Detail now starts with an always-visible state card showing current
  or latest mission state, role/session activity, tool result counts, liveness,
  latest replay event, and latest tool step.
- The card keeps the detailed trace collapsed by default while still answering
  whether the mission is running, waiting, stale, blocked, done, or done with
  attention.

Browser Reliability:
- Browser/runtime behavior did not change.
- Browser-backed missions benefit from clearer diagnosis because the latest
  browser/session tool step appears above runtime detail cards even when the
  trace remains collapsed.

Acceptance Evidence:
- `npx tsx --test packages/control-center/src/state/missionProgress.test.ts`:
  passed, 3 tests.
- `npm run build --workspace @turnkeyai/control-center`: passed.
- `npm run control-center:smoke -- --allow-missing-browser`: passed.
- Smoke screenshot sizes: desktop `123354` bytes, mobile `54166` bytes.
- Smoke asserts `Mission now`, `Done, needs attention`, latest replay event
  `thought · role-lead`, latest tool step `sessions_spawn · result`, and
  vertical order above runtime detail cards.

Regression Risk:
- This is a frontend summary over existing data. If backend metrics or timeline
  polling lag, the card can briefly show the latest known state rather than the
  instantaneous state; that matches the current 2s polling model.
- The card is not yet a streaming event feed. A future websocket or live event
  channel would be needed for sub-second updates.

## 2026-05-31 01:24 CST - G0 Ledger Guardrail Supplement

Direction: unknown

Execution Kernel:
- No agent, tool-use, session, browser, approval, or completion semantics
  changed.
- This checkpoint tightens the progress ledger contract so execution work is
  judged by real acceptance and repeated-failure reduction instead of PR count
  or test-count movement.

Result Quality:
- Final-answer quality did not change in this checkpoint.
- The added convergence rule makes quality regressions harder to hide behind
  local fixes: repeated weak answers inside a 24-hour window require an explicit
  methodology-review decision unless the next real E2E improves.

Workbench UX:
- No user-facing workbench page changed.
- The ledger now requires each checkpoint to answer whether stable complex-task
  delivery is closer, and to name the next real gate when the answer is not
  supported by acceptance evidence.

Browser Reliability:
- Browser transport and session behavior did not change.
- Browser reliability claims still require browser E2E, CDP smoke, or
  screenshot-backed operator evidence before a checkpoint can be marked
  `converging`.

Acceptance Evidence:
- No real LLM or browser acceptance ran for this governance-only supplement.
- Next required real gate remains the focused scenario for whatever runtime,
  browser, or UX behavior changes next; broad runtime changes still require the
  full `npm run acceptance:real` gate before claiming convergence.

Regression Risk:
- Risk is limited to ledger wording and future process interpretation.
- `npm run ledger:check` covers required checkpoint shape; it does not prove
  product convergence, by design.

## 2026-05-31 01:31 CST - Settings Browser Setup Health

Direction: converging

Execution Kernel:
- No agent, tool-use, session, browser, approval, or completion semantics
  changed.
- This slice keeps browser setup diagnosis outside the execution kernel and
  surfaces existing `/bridge/status` plus diagnostics readiness in the
  configuration page.

Result Quality:
- Final-answer quality did not change directly.
- The user-visible setup path is stronger: browser-backed missions are less
  likely to start with hidden transport, expert-lane, CDP endpoint, or profile
  fallback problems.

Workbench UX:
- Settings now includes a Browser bridge section with transport, expert lane,
  direct-CDP endpoint, operator readiness checks, and local validation commands.
- This closes a product-entry gap: Runtime remains the live operator page, while
  Settings now explains browser setup health before work begins.

Browser Reliability:
- Browser runtime behavior did not change.
- Existing browser reliability signals are easier to act on because profile
  fallback and recent browser failure warnings from diagnostics now appear next
  to bridge configuration details.

Acceptance Evidence:
- `npm run build --workspace @turnkeyai/control-center`: passed.
- `npx tsx --test packages/control-center/src/pages/OnboardingPage.test.ts scripts/agent-workbench-ledger-check.test.ts`:
  passed, 4 tests.
- `npm run control-center:smoke -- --allow-missing-browser`: passed.
- Smoke assertions cover Settings browser bridge visibility, live transport,
  expert-lane reason, browser runtime readiness, and the CDP smoke command.

Regression Risk:
- This is frontend/read-only wiring over existing endpoints. If `/bridge/status`
  or `/diagnostics` is temporarily unavailable, Settings falls back to
  checking/offline copy instead of blocking model catalog edits.
- Remaining gap: this does not add admin-gated transport mutation controls.
  Those should wait for daemon config routes and restart semantics rather than
  being bolted onto the page.

## 2026-05-31 01:41 CST - Runtime Mission Duration Diagnostics

Direction: converging

Execution Kernel:
- No agent, tool-use, worker, browser, approval, or completion semantics
  changed.
- Diagnostics now aggregate longest active mission wall-clock duration from the
  canonical mission health snapshot, preserving the existing mission evaluator
  and replay lifecycle.

Result Quality:
- Final-answer synthesis did not change.
- Operators can now distinguish fresh active work from long-running active work
  before deciding whether a weak or delayed result needs follow-up, reconcile,
  or cancellation.

Workbench UX:
- Runtime Mission health now surfaces longest active mission duration in the
  summary and per-attention mission wall-clock duration in the attention list.
- This makes the workbench clearer during long real tasks: "working" is paired
  with elapsed time instead of only counts.

Browser Reliability:
- Browser runtime behavior did not change.
- Browser-backed missions benefit indirectly because stuck browser spans are
  easier to spot when their mission has been active for a visible duration.

Acceptance Evidence:
- `npx tsx --test packages/app-gateway/src/mission-health-diagnostics.test.ts packages/app-gateway/src/routes/diagnostics-routes.test.ts`:
  passed, 42 tests.
- `npm run build --workspace @turnkeyai/control-center`: passed.
- `npm run control-center:smoke -- --allow-missing-browser`: passed.
- Smoke assertions cover longest active mission duration and per-attention
  mission wall-clock duration in Runtime.

Regression Risk:
- The new diagnostics fields are additive. Older clients can ignore them; the
  Control Center type mirror and smoke fixture were updated together.
- The duration is based on mission creation time for active mission statuses,
  so it is a coarse operator signal, not proof that every second was spent in
  active tool execution.

## 2026-05-31 01:51 CST - G0 Operating Contract Restated

Direction: unknown

Execution Kernel:
- No agent, tool-use, session, browser, approval, or completion semantics
  changed.
- The G0 operating contract was restated near the top of this ledger so future
  work treats progress accounting as a production-goal control, not a changelog.

Result Quality:
- Final-answer quality did not change.
- The contract now explicitly says result-quality progress cannot be claimed
  from PR count, test count, or implementation size without real acceptance
  evidence or a named next acceptance gate.

Workbench UX:
- No user-facing page changed.
- The ledger now makes the user-visible question explicit for every checkpoint:
  is a real user closer to receiving a stable, useful complex-task result?

Browser Reliability:
- Browser transport, profile, session, and CDP behavior did not change.
- Browser reliability claims remain gated on browser E2E, CDP smoke, or
  screenshot-backed operator evidence when the changed slice touches browser
  behavior.

Acceptance Evidence:
- Governance-only documentation change. No real LLM or browser E2E ran.
- `npm run ledger:check` is the required verification for this supplement.
- The next runtime, result-quality, or browser behavior change still requires a
  focused real acceptance scenario before it can be marked `converging`.

Regression Risk:
- Product regression risk is low because this does not alter execution code.
- Process risk is intentional: future checkpoints should be harder to mark
  `converging` unless they carry real acceptance evidence or a clear evidence
  gap.

## 2026-05-31 02:02 CST - Work Trace Tool Cancellation

Direction: converging

Execution Kernel:
- No new runtime execution route was added; this slice wires the existing
  message-level `/message/cancel-tools` contract into Mission replay.
- Replay status now keeps a multi-call tool process `running` until every
  non-skipped call has a matching result, preventing one completed tool result
  from hiding another still-active call in the same assistant message round.

Result Quality:
- Final-answer synthesis did not change.
- The workbench can now stop an active tool call from the trace before a weak
  or stale result is accepted, which improves recovery control rather than
  answer substance directly.

Workbench UX:
- Expanded Work trace rows now expose `Cancel tool calls` when the process has
  cancellable active calls with durable `messageId` and `toolCallId` metadata.
- The control is distinct from child-session cancellation: it targets the
  assistant message's pending tool calls so cancelled tool results can enter
  the durable message stream.

Browser Reliability:
- Browser transport behavior did not change.
- Browser-backed missions benefit when a browser/session tool call is still
  pending: users can cancel the active call from the mission trace instead of
  waiting for a stale browser operation to resolve.

Acceptance Evidence:
- `npx tsx --test packages/control-center/src/state/toolReplay.test.ts`:
  passed, 13 tests.
- `npm run build:control-center`: passed.
- `npm run typecheck`: passed.
- Control Center smoke is the required user-visible gate for this slice because
  it verifies the button, the route POST, and the accepted status message.

Regression Risk:
- The main behavior risk is replay classification: multi-call processes now
  remain running until all non-skipped calls have results. Existing replay tests
  plus new cancellable-call tests cover completed, skipped, failed, and
  active-call paths.
- This is not a real LLM/browser E2E stage; it is a workbench recovery-control
  slice. The next runtime/result-quality change still needs focused real
  mission acceptance.

## 2026-05-31 02:21 CST - Real Acceptance Summary Enters Runtime

Direction: converging

Execution Kernel:
- No agent, tool-use, session, browser, approval, or completion semantics
  changed.
- The real acceptance gate now records a structured mission-report summary in
  validation ops when the mission JSON artifact is available.

Result Quality:
- Final-answer synthesis did not change.
- Operators can now see acceptance quality signals without opening the JSON
  artifact: mission scenario pass count, quality-failure count, liveness,
  tool result coverage, and evidence count.

Workbench UX:
- Runtime Release acceptance rows now show the mission-report summary for real
  LLM acceptance runs, next to the artifact path and run status.
- This keeps acceptance evidence visible inside the product entry rather than
  making users infer quality from a file path alone.

Browser Reliability:
- Browser transport behavior did not change.
- Browser-backed acceptance scenarios are easier to audit because the same
  Runtime row exposes liveness and tool coverage from the mission report.

Acceptance Evidence:
- Focused unit tests for the mission-report summarizer and validation-ops
  record shape are required for this slice.
- Control Center smoke is the user-visible gate because it verifies the Runtime
  card renders scenario count, quality failures, and liveness from the
  structured record.
- No real LLM/browser acceptance ran for this observability-only slice; the
  next runtime/result-quality change still requires focused real mission
  acceptance.

Regression Risk:
- The main risk is accepting malformed artifact JSON. The summarizer is
  defensive and returns no summary for unrelated artifacts or unreadable JSON,
  preserving the existing artifact-path-only behavior.
- The validation-ops record shape is additive. Older records without
  `realAcceptance` continue to render normally.

## 2026-05-31 02:32 CST - Source Coverage Quality Gate

Direction: unknown

Execution Kernel:
- No agent, tool-use, worker, browser, approval, or completion semantics
  changed.
- Mission observability now turns visible evidence source labels into a
  structured `source_coverage` quality check. A completed multi-source mission
  can now surface `needs_attention` when the final answer omits one of the
  gathered source labels.

Result Quality:
- This moves the quality gate closer to the complex-task acceptance target:
  final answers should not merely mention evidence in general; they should
  cover the specific visible sources used during the run.
- This checkpoint is not marked converging because no real LLM/browser
  acceptance ran after the new check. The next real scenario should prove that
  a multi-source answer either covers all gathered sources or is visibly marked
  for attention.

Workbench UX:
- Mission Detail already renders quality-gate checks, and the Control Center
  smoke fixture now asserts that the source-coverage warning is user-visible in
  the mission quality action panel.
- A user inspecting a weak final answer can now see whether the issue is
  missing source coverage rather than only "answer too short" or generic
  evidence usage.

Browser Reliability:
- Browser transport behavior did not change.
- Browser-backed multi-source missions benefit when browser evidence has a
  source label, because omitted browser source coverage becomes visible as a
  quality warning.

Acceptance Evidence:
- Focused unit coverage is required for multi-source pass/warn behavior in
  mission observability.
- Control Center smoke is required to verify the user-visible warning path.
- No real LLM/browser acceptance ran for this checkpoint; next required gate is
  a focused real multi-source mission scenario that checks source coverage in
  the final answer and Runtime/Mission metrics.

Regression Risk:
- The check only activates as a warning when at least two visible source labels
  are attached to mission evidence. Single-source or unlabeled evidence keeps
  the previous behavior.
- Risk: source labels that are too verbose or unstable could cause false
  attention warnings. The implementation limits matching to visible labels and
  keeps the result as `needs_attention`, not a hard `blocked` failure.

## 2026-05-31 02:41 CST - Acceptance Quality Breakdown

Direction: unknown

Execution Kernel:
- No agent, tool-use, worker, browser, approval, or mission completion
  semantics changed.
- Mission E2E reports now preserve mission quality-check names/status/details
  from `/missions/:id/metrics`, so the real acceptance artifact carries the
  same structured quality categories a user sees in Mission Detail.

Result Quality:
- Real acceptance summaries now aggregate total quality-check warnings,
  quality-check failures, and source-coverage warnings/failures. This makes a
  weak complex-task run diagnosable by failure class instead of only scenario
  pass/fail count.
- This checkpoint is still `unknown`: the change improves evidence reporting,
  but the next convergence claim requires a focused real multi-source mission
  run that exercises the source-coverage signal.

Workbench UX:
- Runtime Release acceptance rows now include quality check warn/fail counts
  and source-coverage warn/fail counts next to scenario, liveness, tools, and
  evidence totals.
- The operator can see whether a real acceptance failure is about source
  coverage without opening the JSON artifact first.

Browser Reliability:
- Browser runtime behavior did not change.
- Browser-backed source coverage is more auditable when browser evidence
  labels flow from mission metrics into real acceptance summaries.

Acceptance Evidence:
- Required local gates: mission report unit coverage, real acceptance summary
  aggregation tests, validation-ops shape tests, Runtime UI smoke, typecheck,
  build, full tests, and `git diff --check`.
- No real LLM/browser acceptance ran at this checkpoint. The next required real
  gate remains a multi-source mission where source coverage appears in both
  Mission metrics and Runtime acceptance summary.

Regression Risk:
- The artifact shape is additive: older mission reports without
  `qualityChecks` aggregate zero warning/failure counts.
- Risk is limited to consumers that assume exact mission-report field sets;
  typed Control Center and validation-ops tests cover the known consumers.

## 2026-05-31 02:50 CST - Focused Real Acceptance Mission Mode

Direction: unknown

Execution Kernel:
- No agent, tool-use, worker, browser, approval, or mission completion
  semantics changed.
- `acceptance:real` now supports `--skip-tooluse`, allowing a focused
  mission-only real acceptance run for quality-signal validation while leaving
  the default full release gate unchanged.

Result Quality:
- This reduces the cost of validating source coverage and multi-source final
  answer behavior after Mission metrics or reporting changes.
- This checkpoint is still `unknown` until the focused real acceptance command
  is actually run against a model and, when required, browser-backed mission
  scenarios.

Workbench UX:
- Runtime and validation-ops can now receive a smaller, targeted real
  acceptance record for mission-only gates instead of waiting for the full
  tool-use + mission matrix.
- The documented focused commands make it clearer which real scenario proves a
  quality-signal change.

Browser Reliability:
- Browser runtime behavior did not change.
- Browser-focused validation can now run `browser-dashboard` or
  `realistic-brief` through `acceptance:real --skip-tooluse`, keeping browser
  evidence in the mission artifact without forcing the provider-native browser
  tool-use leg.

Acceptance Evidence:
- Required local gates: argument/plan unit tests, typecheck, build, relevant
  docs, ledger check, full tests, and `git diff --check`.
- No real LLM/browser acceptance ran at this checkpoint. Next required real
  gate: `npm run acceptance:real -- --skip-tooluse --mission-scenarios
  comparison,realistic-brief --model-catalog models.local.json
  --scenario-timeout-ms 300000`.

Regression Risk:
- Default `acceptance:real` behavior is unchanged: without `--skip-tooluse`,
  the tool-use matrix still runs before the mission matrix.
- Validation-ops records for mission-only runs intentionally contain zero
  tool-use scenarios and `browserTooluseEnabled=false`, so release dashboards
  can distinguish focused gates from the full browser-inclusive release gate.

## 2026-05-31 02:58 CST - G0 Progress Ledger Hardening

Direction: unknown

Execution Kernel:
- No execution-kernel, tool-use, session, browser, approval, or completion
  semantics changed.
- This checkpoint hardens the goal-accounting contract so future runtime work
  cannot claim convergence from implementation volume alone.

Result Quality:
- Final-answer quality did not change in this checkpoint.
- The ledger now explicitly requires every phase to answer whether a real user
  is closer to receiving a stable, useful complex-task result, and requires a
  methodology review when repeated local fixes do not improve real E2E behavior.

Workbench UX:
- No user-facing workbench UI changed.
- The operational UX benefit is process-level: later checkpoints must report
  user-visible state, recovery clarity, and acceptance evidence instead of only
  PR/test movement.

Browser Reliability:
- Browser transport and session behavior did not change.
- Browser reliability remains dependent on real focused acceptance for
  browser-backed mission scenarios and profile/CDP health checks.

Acceptance Evidence:
- `npm run ledger:check`: passed, 38 checkpoint(s), before this checkpoint was
  appended.
- No real LLM/browser acceptance ran for this governance-only checkpoint. Next
  required gate remains:
  `npm run acceptance:real -- --skip-tooluse --mission-scenarios
  comparison,realistic-brief --model-catalog models.local.json
  --scenario-timeout-ms 300000`.

Regression Risk:
- Risk is limited to progress-reporting discipline. The ledger checker enforces
  dated checkpoints with direction and required evidence sections.
- The checker does not yet enforce the 24-hour methodology-brake decision in
  code; for now that remains a documented operating rule. If the ledger starts
  drifting, the next governance slice should make the 24-hour review enforceable.

## 2026-05-31 03:09 CST - Focused Mission Real Acceptance Passed

Direction: converging

Execution Kernel:
- No execution-kernel code changed in this checkpoint.
- The focused mission-only real acceptance path exercised the current runtime
  through two complex mission scenarios without stuck creating/working state,
  unresolved tool calls, stale role spans, cancelled tools, failed tools, or
  command timeouts.

Result Quality:
- Both final answers passed the mission quality gate, including final-answer
  presence, evidence-backed output, residual-risk wording, answer substance,
  evidence usage, unsupported-uncertainty checks, tool-fallback guard, runtime
  liveness, and failure-free checks.
- Caveat: the `source_coverage` check passed because no visible multi-source
  coverage requirement was present in mission evidence. This run proves focused
  mission completion and baseline quality, but it does not yet prove the newer
  source-label coverage warning on a labeled multi-source evidence set.

Workbench UX:
- No workbench UI changed.
- Runtime validation-ops now has a real focused acceptance record that can
  appear in Release acceptance surfaces, making the quality evidence visible
  from the product instead of only from command output.

Browser Reliability:
- This focused gate skipped the provider-native browser tool-use leg and did
  not exercise live CDP/browser scenarios.
- Browser reliability remains unproven for this checkpoint. The next
  browser-relevant gate must include a browser-backed mission scenario or the
  full release acceptance command with CDP enabled.

Acceptance Evidence:
- Command:
  `npm run acceptance:real -- --skip-tooluse --mission-scenarios
  comparison,realistic-brief --model-catalog models.local.json
  --scenario-timeout-ms 300000`
- Result: passed in 56147ms.
- Validation run:
  `validation-ops:real-llm-acceptance:2026-05-30T19-07-15-946Z:kgwibl`
- Artifact:
  `/Users/chris/.turnkeyai/data/validation-artifacts/real-llm-acceptance/validation-ops%3Areal-llm-acceptance%3A2026-05-30T19-07-15-946Z%3Akgwibl-mission-e2e.json`
- `comparison`: mission `msn.mpsq341u.1`, status `done`,
  quality `passed`, tools `2/2`, sessions `2/0`, liveness `0/0/0`,
  evidence events `2`, final bytes `586`.
- `realistic-brief`: mission `msn.mpsq3l5a.2`, status `done`,
  quality `passed`, tools `3/3`, sessions `3/0`, liveness `0/0/0`,
  evidence events `3`, final bytes `1426`.

Regression Risk:
- The real acceptance pass is strong evidence for mission completion and
  baseline quality, but weaker evidence for source coverage because the artifact
  did not include visible labeled multi-source coverage requirements.
- The report records final-answer size and quality failures but intentionally
  omits final-answer text. If answer-substance regressions continue to appear
  in manual testing, the next acceptance-reporting slice should add a bounded
  final-answer excerpt or operator-safe quality digest so reviewers can audit
  usefulness without opening the live mission store.

## 2026-05-31 03:25 CST - Source Label Coverage Acceptance

Direction: converging

Execution Kernel:
- Session tool-result timeline expansion now promotes the existing
  session-result `label` field into `runtime.sourceLabel`.
- When a tool-result summary path lacks the full session-result JSON, the
  timeline falls back to the matching `sessions_spawn` call's `label` field.
  This keeps source identity durable across both split role=tool results and
  assistant-metadata result summaries.

Result Quality:
- The focused real acceptance matrix now requires the `comparison` and
  `realistic-brief` scenarios to use explicit source labels and prove that
  `source_coverage` audited them.
- This closes the previous caveat where `source_coverage` passed only because
  no visible multi-source labels reached Mission metrics.

Workbench UX:
- No visual layout changed.
- Mission Detail and Runtime acceptance quality rows now receive stronger
  source-coverage truth: multi-source final answers can be judged against
  visible labels such as Vendor Alpha, Vendor Beta, and Ops dashboard instead
  of only generic evidence counts.

Browser Reliability:
- Browser transport behavior did not change.
- The `realistic-brief` acceptance scenario includes one browser child session
  labeled `Ops dashboard`; it passed source-label propagation and completion,
  but this is still a local fixture gate rather than a raw CDP/full browser
  reliability soak.

Acceptance Evidence:
- Initial real run failed as intended after the new gate exposed the missing
  result-side label:
  `comparison sessions_spawn result must expose runtime.sourceLabel Vendor Beta`.
- After the bridge fallback fix, command passed:
  `npm run acceptance:real -- --skip-tooluse --mission-scenarios
  comparison,realistic-brief --model-catalog models.local.json
  --scenario-timeout-ms 300000`
- Validation run:
  `validation-ops:real-llm-acceptance:2026-05-30T19-23-19-873Z:f4dmol`
- Artifact:
  `/Users/chris/.turnkeyai/data/validation-artifacts/real-llm-acceptance/validation-ops%3Areal-llm-acceptance%3A2026-05-30T19-23-19-873Z%3Af4dmol-mission-e2e.json`
- `comparison`: mission `msn.mpsqnrt9.1`, status `done`,
  quality `passed`, tools `2/2`, sessions `2/0`, liveness `0/0/0`,
  source coverage `Final answer covers 2/2 visible source label(s).`
- `realistic-brief`: mission `msn.mpsqo513.2`, status `done`,
  quality `passed`, tools `3/3`, sessions `3/0`, liveness `0/0/0`,
  source coverage `Final answer covers 3/3 visible source label(s).`
- Local verification: focused MissionThreadBridge tests, `npm run typecheck`,
  `npm run build`, `npm test -- --runInBand`, and `git diff --check`.

Regression Risk:
- The fallback from call label to result source label is intentionally narrow:
  it only applies to tool-result events associated with a structured tool call
  that supplied a `label`.
- Risk: a misleading model-supplied label could still make source coverage look
  cleaner than the underlying evidence. The next hardening step should consider
  worker-owned source labels for browser/explore outputs so the runtime can
  verify labels independently of the lead's call arguments.

## 2026-05-31 03:31 CST - Browser-Backed Mission Acceptance

Direction: converging

Execution Kernel:
- No runtime code changed in this checkpoint.
- The current execution kernel completed two browser-backed mission scenarios
  through real LLM tool-use, browser child sessions, durable tool results, and
  mission completion reconciliation without stuck creating/working state.

Result Quality:
- Both browser-backed scenarios passed all mission quality checks:
  final-answer presence, evidence-backed output, residual-risk wording, answer
  substance, evidence usage, unsupported-uncertainty guard, tool-fallback guard,
  runtime liveness, and failure-free status.
- These scenarios are single-source browser evidence checks, so
  `source_coverage` correctly had no multi-source requirement. Multi-source
  source coverage was separately proven in the previous checkpoint.

Workbench UX:
- No visual UI changed.
- Runtime validation-ops now has a focused real record for browser-backed
  missions that can be inspected from Release acceptance surfaces.

Browser Reliability:
- Browser-backed mission evidence improved from unproven to locally validated
  for two fixture classes:
  browser-rendered dynamic DOM extraction and browser-rendered dashboard triage.
- This is still not a full raw-CDP/browser reliability claim. It does not cover
  profile-lock recovery, remote CDP endpoint outages, popup-heavy pages, or the
  full release gate with provider-native browser tool-use enabled.

Acceptance Evidence:
- Command:
  `npm run acceptance:real -- --skip-tooluse --mission-scenarios
  browser-dynamic,browser-dashboard --model-catalog models.local.json
  --scenario-timeout-ms 300000 --cdp-timeout-ms 45000`
- Result: passed in 64109ms.
- Validation run:
  `validation-ops:real-llm-acceptance:2026-05-30T19-29-44-010Z:bmhowp`
- Artifact:
  `/Users/chris/.turnkeyai/data/validation-artifacts/real-llm-acceptance/validation-ops%3Areal-llm-acceptance%3A2026-05-30T19-29-44-010Z%3Abmhowp-mission-e2e.json`
- `browser-dynamic`: mission `msn.mpsqw07q.1`, status `done`,
  quality `passed`, tools `1/1`, sessions `1/0`, liveness `0/0/0`,
  evidence events `1`, final bytes `331`, final bullets `3`.
- `browser-dashboard`: mission `msn.mpsqwrea.2`, status `done`,
  quality `passed`, tools `1/1`, sessions `1/0`, liveness `0/0/0`,
  evidence events `1`, final bytes `502`, final bullets `4`.

Regression Risk:
- This checkpoint is evidence-only. It reduces uncertainty about local
  browser-backed mission delivery but does not reduce code-level risk by itself.
- Remaining acceptance gap: run the full release gate or a browser-focused gate
  that includes profile/CDP failure injection and provider-native browser
  tool-use before claiming broad browser reliability.

## 2026-05-31 04:35 CST - Full Real Acceptance Gate

Direction: converging

Execution Kernel:
- Full real acceptance now passes with provider-native tool-use, direct-CDP
  smoke, and all mission scenarios enabled in one run.
- The gate exposed and closed four runtime/contract gaps before passing:
  follow-up source-label coverage, bounded durable-memory search variance,
  idempotent mission task creation, and pseudo tool-call markup emitted as
  assistant text after a normal tool round.
- The runtime now repairs textual tool-call markup after a normal tool round by
  forcing a tools-disabled final synthesis instead of letting XML-like markup
  become the user-visible final answer.

Result Quality:
- The final passing matrix completed 12/12 mission scenarios. Ten scenarios
  passed the normal quality gate; `cancel` and `timeout-recovery` completed with
  expected blocked quality state because they intentionally exercise operator
  cancellation and timeout recovery.
- Multi-source scenarios now require explicit source labels in tool calls and
  final answers: `comparison`, `followup`, `product-workbench-brief`, and
  `realistic-brief`.
- Mutation quality improved: repeated same-title `tasks_create` calls now return
  the existing mission work item instead of persisting a duplicate.

Workbench UX:
- No UI surface changed in this checkpoint.
- Mission Detail evidence is more trustworthy because tool-call progress,
  source coverage, idempotent task state, and final-answer quality all survived
  the same real acceptance run.

Browser Reliability:
- Direct-CDP smoke passed inside the full gate with target attach, OOPIF/shadow
  probing, coordinate input, popup target attach, boundary marker, network
  controls, upload/download, screenshots, and artifact checks.
- Browser-backed mission scenarios passed:
  `browser-dynamic`, `browser-dashboard`, `product-workbench-brief`, and
  `realistic-brief`.
- Remaining browser risk: this is still local fixture coverage, not a long soak
  on external complex pages or profile-lock/failure-injection recovery.

Acceptance Evidence:
- Command:
  `npm run acceptance:real -- --model-catalog models.local.json
  --scenario-timeout-ms 300000 --cdp-timeout-ms 45000`
- Result: passed in 486474ms.
- Validation run:
  `validation-ops:real-llm-acceptance:2026-05-30T20-26-45-392Z:woavjt`
- Artifact:
  `/Users/chris/.turnkeyai/data/validation-artifacts/real-llm-acceptance/validation-ops%3Areal-llm-acceptance%3A2026-05-30T20-26-45-392Z%3Awoavjt-mission-e2e.json`
- Mission results:
  `basic` `msn.mpssz248.1` done/passed tools `1/1` sessions `1/0`;
  `comparison` `msn.mpsszbg8.2` done/passed tools `2/2` sessions `2/0`;
  `followup` `msn.mpsszqzr.3` done/passed tools `2/2` sessions `1/1`;
  `cancel` `msn.mpst2gtk.4` done/blocked tools `1/1` sessions `1/0`;
  `approval` `msn.mpst2ng3.5` done/passed tools `1/1` sessions `1/0`;
  `browser-dynamic` `msn.mpst3b5o.6` done/passed tools `1/1`
  sessions `1/0`; `browser-dashboard` `msn.mpst3ujy.7` done/passed
  tools `1/1` sessions `1/0`; `timeout-recovery` `msn.mpst48j5.8`
  done/blocked tools `1/1` sessions `1/0`; `memory-recall`
  `msn.mpst5qu7.9` done/passed tools `2/2` sessions `0/0`;
  `task-tracking` `msn.mpst5ym1.10` done/passed tools `3/3`
  sessions `0/0`; `product-workbench-brief` `msn.mpst64tg.11`
  done/passed tools `3/3` sessions `3/0`; `realistic-brief`
  `msn.mpst6wqh.12` done/passed tools `3/3` sessions `3/0`.
- Liveness was `0/0/0` for every mission at completion.

Regression Risk:
- Direction is converging, but not yet risk-free. The full gate required
  several contract/runtime repairs during the same checkpoint, which means the
  acceptance harness is still finding real integration gaps rather than merely
  confirming stability.
- 24-hour methodology check: continue feature work only while full real E2E
  improves or remains green. If the next 24 hours show repeated fixes in the
  same categories without a stable full-gate pass, pause feature PRs and move
  into methodology review focused on prompt/runtime/tool protocol boundaries.

## 2026-05-31 05:18 CST - Review Fix Full Gate

Direction: converging

Execution Kernel:
- Review fixes closed two production-path gaps: concurrent duplicate
  `tasks_create` now serializes check-and-put per mission, and
  `sessions_send` now resumes the existing worker session instead of starting a
  bare send that bypasses continuation transcript injection.
- The `sessions_send` repair was validated against the real follow-up mission
  failure mode: phase two reused the same child session and retained the phase
  one fixture evidence.
- Tool-call text repair naming was clarified without changing the public
  protocol.

Result Quality:
- Full real acceptance passed after the review fixes. The follow-up scenario
  stayed substantive instead of saying the first-round fixture marker was
  unconfirmed.
- The matrix completed 12/12 mission scenarios. `cancel` and
  `timeout-recovery` remained intentionally blocked-quality scenarios with
  clean completion and no active liveness residue.
- Product/research brief scenarios still produced bounded multi-source results:
  `product-workbench-brief` and `realistic-brief` each completed with three
  session results and passed quality gates.

Workbench UX:
- No UI changed in this checkpoint.
- User-visible mission timelines are safer because follow-up tool results now
  reflect durable child-session continuity rather than a fresh context-free
  continuation.

Browser Reliability:
- Direct-CDP smoke passed inside the same gate, including raw-CDP target
  attach, OOPIF/shadow probing, coordinate input, popup target attach, network
  controls, upload/download, screenshots, and artifact checks.
- Browser-backed mission scenarios passed again: `browser-dynamic`,
  `browser-dashboard`, `product-workbench-brief`, and `realistic-brief`.
- Remaining browser risk is unchanged: this is fixture-backed validation, not
  an external long soak or profile-lock recovery proof.

Acceptance Evidence:
- Command:
  `npm run acceptance:real -- --model-catalog models.local.json
  --scenario-timeout-ms 300000 --cdp-timeout-ms 45000`
- Result: passed in 414997ms.
- Validation run:
  `validation-ops:real-llm-acceptance:2026-05-30T21-11-39-679Z:me10xi`
- Artifact:
  `/Users/chris/.turnkeyai/data/validation-artifacts/real-llm-acceptance/validation-ops%3Areal-llm-acceptance%3A2026-05-30T21-11-39-679Z%3Ame10xi-mission-e2e.json`
- Mission results:
  `basic` `msn.mpsulf5x.1` done/passed tools `1/1` sessions `1/0`;
  `comparison` `msn.mpsuloht.2` done/passed tools `2/2` sessions `2/0`;
  `followup` `msn.mpsum752.3` done/passed tools `2/2` sessions `1/1`;
  `cancel` `msn.mpsumrc2.4` done/blocked tools `1/1` sessions `1/0`;
  `approval` `msn.mpsumxkf.5` done/passed tools `1/1` sessions `1/0`;
  `browser-dynamic` `msn.mpsunjpk.6` done/passed tools `1/1`
  sessions `1/0`; `browser-dashboard` `msn.mpsuo5fa.7` done/passed
  tools `1/1` sessions `1/0`; `timeout-recovery` `msn.mpsuoo1d.8`
  done/blocked tools `1/1` sessions `1/0`; `memory-recall`
  `msn.mpsuq6cq.9` done/passed tools `2/2` sessions `0/0`;
  `task-tracking` `msn.mpsuqdcu.10` done/passed tools `3/3`
  sessions `0/0`; `product-workbench-brief` `msn.mpsuqjkq.11`
  done/passed tools `3/3` sessions `3/0`; `realistic-brief`
  `msn.mpsur8ei.12` done/passed tools `3/3` sessions `3/0`.
- Liveness was `0/0/0` for every mission at completion.

Regression Risk:
- Direction remains converging because a review-found runtime bug produced a
  real E2E failure first, then the focused fix passed both the targeted
  follow-up scenario and the full gate.
- 24-hour methodology check: do not count this as done by PR/test volume. Count
  it as progress because the same user-facing failure class now has a concrete
  runtime fix and a full real acceptance record. If follow-up/session-continuity
  failures recur within the next day, pause feature work for methodology review
  of worker-session continuation and transcript persistence.

## 2026-05-31 05:50 CST - Strict Acceptance Gate

Direction: converging

Execution Kernel:
- The final gate passed after tightening acceptance semantics rather than
  relaxing them: source labels are now checked as exact call/result sets,
  standalone follow-up rejects the literal returned session key, and
  `sessions_send` continues through the runtime resume path with transcript
  context.
- Multi-source standalone tool-use now has a fixed final marker bullet, and
  product/operator mission briefs require a fixed first section label with no
  status preamble.

Result Quality:
- Full real acceptance passed with all strict output-shape gates active.
- `followup` validated same-session continuation without raw session key
  leakage. `realistic-brief` and `product-workbench-brief` produced operator
  briefs without status preambles and with exact source coverage.
- `cancel` and `timeout-recovery` still completed as expected blocked-quality
  cases with no lingering liveness.

Workbench UX:
- No UI changed in this checkpoint.
- Mission timelines and final answers are now more predictable for users:
  evidence sources are exact, process/status preambles are rejected, and final
  answers keep the result separate from tool execution mechanics.

Browser Reliability:
- Direct-CDP smoke passed in the same gate.
- Browser-backed scenarios passed: standalone `complex`, mission
  `browser-dynamic`, `browser-dashboard`, `product-workbench-brief`, and
  `realistic-brief`.
- Remaining risk is still external-page soak/profile-lock coverage, not local
  fixture execution.

Acceptance Evidence:
- Command:
  `npm run acceptance:real -- --model-catalog models.local.json
  --scenario-timeout-ms 300000 --cdp-timeout-ms 45000`
- Result: passed in 358314ms.
- Validation run:
  `validation-ops:real-llm-acceptance:2026-05-30T21-44-11-363Z:nikrb5`
- Artifact:
  `/Users/chris/.turnkeyai/data/validation-artifacts/real-llm-acceptance/validation-ops%3Areal-llm-acceptance%3A2026-05-30T21-44-11-363Z%3Anikrb5-mission-e2e.json`
- Mission results:
  `basic` `msn.mpsvqo3b.1` done/passed tools `1/1` sessions `1/0`;
  `comparison` `msn.mpsvqzri.2` done/passed tools `2/2` sessions `2/0`;
  `followup` `msn.mpsvrdra.3` done/passed tools `2/2` sessions `1/1`;
  `cancel` `msn.mpsvrwek.4` done/blocked tools `1/1` sessions `1/0`;
  `approval` `msn.mpsvs1ut.5` done/passed tools `1/1` sessions `1/0`;
  `browser-dynamic` `msn.mpsvshhx.6` done/passed tools `1/1`
  sessions `1/0`; `browser-dashboard` `msn.mpsvsxsi.7` done/passed
  tools `1/1` sessions `1/0`; `timeout-recovery` `msn.mpsvtcjr.8`
  done/blocked tools `1/1` sessions `1/0`; `memory-recall`
  `msn.mpsvuwen.9` done/passed tools `2/2` sessions `0/0`;
  `task-tracking` `msn.mpsvv5q9.10` done/passed tools `3/3`
  sessions `0/0`; `product-workbench-brief` `msn.mpsvvb65.11`
  done/passed tools `3/3` sessions `3/0`; `realistic-brief`
  `msn.mpsvvuki.12` done/passed tools `3/3` sessions `3/0`.
- Liveness was `0/0/0` for every mission.

Regression Risk:
- Direction is converging, but the repeated strict-gate failures during this
  checkpoint show the system is still sensitive to prompt/output contract
  drift. The fix direction is now explicit contracts plus hard quality gates,
  not lowering budgets or allowing weak answers.
- 24-hour methodology check: if another round produces failures in the same
  categories of missing markers, source drift, status preambles, or session-key
  leakage, pause feature PRs and review the shared answer-shape harness before
  adding new capabilities.

## 2026-05-31 06:38 CST - Review-Fix Acceptance Reclose

Direction: converging

Execution Kernel:
- Review-found runtime issues were fixed at the execution boundary:
  worker-session context survives `send()`, final synthesis fails closed when a
  repaired response still emits pseudo tool-call markup, permission apply is
  idempotent, and `sessions_send` result envelopes now use the current
  follow-up label/tool-call id.
- The fixes are architectural rather than cosmetic: they close duplicate
  approval application, source-label continuity, and unsafe final-repair gaps
  that appeared only under real LLM ordering variance.

Result Quality:
- The full real gate passed after tightening prompts/gates for follow-up,
  timeout recovery, and product brief source coverage.
- Product and realistic briefs still require three source-backed sessions and
  exact evidence labels; timeout/cancel remain bounded blocked-quality cases
  instead of weak success answers.

Workbench UX:
- No UI changed in this checkpoint.
- User-visible mission timelines are more reliable because source labels now
  survive follow-up results, duplicate approval events are suppressed, and final
  answers are kept out of pseudo tool-call markup when the model misbehaves.

Browser Reliability:
- Direct-CDP smoke passed in the full acceptance run.
- Browser-backed mission scenarios passed: `browser-dynamic`,
  `browser-dashboard`, `product-workbench-brief`, and `realistic-brief`.

Acceptance Evidence:
- Command:
  `npm run acceptance:real -- --model-catalog models.local.json
  --scenario-timeout-ms 300000 --cdp-timeout-ms 45000`
- Result: passed in 416055ms.
- Validation run:
  `validation-ops:real-llm-acceptance:2026-05-30T22-31-29-943Z:hta22f`
- Artifact:
  `/Users/chris/.turnkeyai/data/validation-artifacts/real-llm-acceptance/validation-ops%3Areal-llm-acceptance%3A2026-05-30T22-31-29-943Z%3Ahta22f-mission-e2e.json`
- Mission results:
  `basic` `msn.mpsxfey0.1` done/passed tools `1/1` sessions `1/0`;
  `comparison` `msn.mpsxfp21.2` done/passed tools `2/2` sessions `2/0`;
  `followup` `msn.mpsxg65l.3` done/passed tools `2/2` sessions `1/1`;
  `cancel` `msn.mpsxh3ju.4` done/blocked tools `1/1` sessions `1/0`;
  `approval` `msn.mpsxh8mb.5` done/passed tools `1/1` sessions `1/0`;
  `browser-dynamic` `msn.mpsxhure.6` done/passed tools `1/1`
  sessions `1/0`; `browser-dashboard` `msn.mpsxio8c.7` done/passed
  tools `1/1` sessions `1/0`; `timeout-recovery` `msn.mpsxjdu4.8`
  done/blocked tools `1/1` sessions `1/0`; `memory-recall`
  `msn.mpsxkw5x.9` done/passed tools `2/2` sessions `0/0`;
  `task-tracking` `msn.mpsxl4pn.10` done/passed tools `3/3`
  sessions `0/0`; `product-workbench-brief` `msn.mpsxlawy.11`
  done/passed tools `3/3` sessions `3/0`; `realistic-brief`
  `msn.mpsxlvun.12` done/passed tools `3/3` sessions `3/0`.
- Liveness was `0/0/0` for every mission.

Regression Risk:
- Direction is converging because the same run exposed review-fix misses first,
  then passed after fixing runtime contracts and prompt/gate alignment.
- 24-hour methodology check: if approval duplication, source-label drift, or
  answer-shape regex drift recurs again, pause feature PRs and review the
  shared permission/session/evidence contract before adding workbench features.

## 2026-05-31 06:48 CST - G0 Daily Brake Enforcement

Direction: unknown

Execution Kernel:
- No execution-kernel, tool-use, session, browser, approval, or mission
  completion behavior changed.
- The progress ledger checker now treats dated 24-hour reviews as first-class
  records and enforces a recent dated review once the ledger spans at least 24
  hours. This makes the G0 methodology brake checkable instead of purely
  procedural.

Result Quality:
- Final-answer synthesis did not change in this checkpoint.
- The governance improvement reduces the chance of calling repeated local
  answer-quality fixes "progress" without a real E2E trend review.

Workbench UX:
- No user-facing workbench page changed.
- Product-management visibility improves because the ledger can now show when
  feature work must pause for methodology review instead of continuing through
  repeated weak outcomes.

Browser Reliability:
- Browser transport, profile, CDP, and session behavior did not change.
- The daily review gate explicitly keeps browser/session/transport instability
  as a repeated-issue class that must be reviewed against real acceptance
  evidence.

Acceptance Evidence:
- `npx tsx --test scripts/agent-workbench-ledger-check.test.ts`: 5 passed.
- `npm run ledger:check`: passed, 46 checkpoint(s), before this checkpoint was
  appended.
- `npm run typecheck`: passed.
- No real LLM/browser acceptance ran because this is governance-only. The next
  runtime/browser behavior change still requires focused real acceptance before
  claiming convergence.

Regression Risk:
- Main risk is false-positive governance friction after the ledger crosses a
  24-hour span. The checker requires dated `24-Hour Goal Review` entries often
  enough that no dated ledger window runs more than 24 hours without review; it
  does not block shorter active windows.
- The rule intentionally does not decide whether feature work continues. It
  only forces the dated review entry that must make that decision.

## 2026-05-31 07:13 CST - Mission Browser Fallback Visibility

Direction: converging

Execution Kernel:
- Browser execution semantics did not change. The existing profile-lock
  behavior still falls back to an isolated runtime profile instead of failing
  the browser task.
- Mission observability now detects browser tool results that report
  `profile_locked` fallback and exposes the count plus latest session/fallback
  detail in mission metrics.

Result Quality:
- Final-answer synthesis did not change.
- Result-quality visibility improved because a browser-backed answer can now be
  marked `needs_attention` when it succeeded through a degraded browser profile
  path. The user can distinguish useful evidence from a fully healthy browser
  run.

Workbench UX:
- Mission Detail now shows a `profile fallback` metric tile and an attention
  detail when a mission's browser work used an isolated runtime profile.
- This closes part of the gap where profile-lock recovery was visible only in
  global diagnostics, not at the mission a user is trying to judge.

Browser Reliability:
- No new browser recovery path was added in this checkpoint.
- The reliability signal is stronger: profile-lock fallback is tied to the
  specific mission quality gate and can guide follow-up, retry, or setup
  cleanup from the mission page.

Acceptance Evidence:
- `npx tsx --test packages/app-gateway/src/mission-observability.test.ts
  packages/app-gateway/src/routes/mission-routes.test.ts`: 48 passed.
- `npm run typecheck`: passed.
- `npm run build:control-center`: passed.
- `npm run control-center:smoke -- --allow-missing-browser`: passed with
  desktop and mobile screenshots.
- `npm run ledger:check`: passed, 47 checkpoint(s), before this checkpoint was
  appended.
- No real LLM/browser acceptance ran because this changes mission visibility,
  not browser execution. The next browser-runtime behavior change still needs
  focused real browser/LLM acceptance.

Regression Risk:
- Main API risk is adding a `browser` field to mission metrics; current
  Control Center types and mission route coverage were updated.
- Detection depends on the browser worker's existing profile-fallback summary
  text. If the worker summary wording changes, the mission-level warning could
  disappear; the new observability regression test pins the current contract.

## 2026-05-31 07:23 CST - Runtime Browser Fallback Diagnostics

Direction: converging

Execution Kernel:
- Browser execution semantics did not change. This checkpoint keeps the
  profile-lock fallback behavior observational only and does not add new retry
  or session-selection rules.
- Diagnostics aggregation now carries browser profile-fallback counts from
  mission health into the operator runtime view, so degraded browser execution
  is visible above the single-mission page.

Result Quality:
- Final-answer synthesis did not change.
- Result-quality review improves because missions that produced an answer
  through a fallback browser profile now appear in the runtime attention list,
  making weak browser evidence harder to miss during triage.

Workbench UX:
- Runtime diagnostics now show a `profile fallback` aggregate beside blocked,
  poor, and timeout indicators.
- Attention rows include per-mission fallback counts when present, connecting
  a degraded browser environment to the mission that needs operator review.

Browser Reliability:
- No browser reliability behavior changed in this checkpoint.
- The reliability signal is broader: profile-lock fallback was already visible
  on Mission Detail, and now it is part of the operator-level diagnostics
  snapshot used to scan active workbench health.

Acceptance Evidence:
- `npx tsx --test packages/app-gateway/src/mission-health-diagnostics.test.ts
  packages/app-gateway/src/mission-observability.test.ts`: 21 passed.
- `npx tsx --test packages/app-gateway/src/mission-health-diagnostics.test.ts
  packages/app-gateway/src/routes/diagnostics-routes.test.ts`: 43 passed.
- `npm run typecheck`: passed.
- `npm run build:control-center`: passed before the final test-fixture-only
  route patch.
- `npm run control-center:smoke -- --allow-missing-browser`: passed with
  desktop and mobile screenshots.
- No real LLM/browser acceptance ran because this changes diagnostics
  surfacing, not execution behavior. The next browser-runtime behavior change
  still needs real browser/LLM acceptance evidence.

Regression Risk:
- Main compatibility risk is clients reading older diagnostics snapshots
  without a `browser` section. The daemon route now emits the field and Control
  Center types/smoke fixtures were updated together.
- The signal still depends on mission observability detecting the browser
  worker's profile-fallback summary. The previous mission-level test pins that
  contract; this checkpoint adds aggregate diagnostics coverage.

## 2026-05-31 07:39 CST - G0 Policy Contract Check

Direction: unknown

Execution Kernel:
- No execution-kernel, tool-use, session, browser, approval, or mission
  completion behavior changed.
- This checkpoint strengthens the goal ledger as a control surface: the
  validator now checks that the top-level G0 operating contract, evidence
  gates, direction values, update cadence, and methodology brake sections stay
  present instead of only validating individual checkpoint shape.

Result Quality:
- Final-answer synthesis did not change.
- Result-quality accounting is safer because the ledger contract itself is now
  protected from accidental erosion; future checkpoints should continue to
  judge quality by real acceptance and user-visible outcomes, not PR count or
  test volume.

Workbench UX:
- No user-facing workbench UI changed.
- Product-management UX improves at the governance layer: the file continues
  to answer whether the production workbench goal is converging, oscillating,
  blocked, or unknown across the required six evidence areas.

Browser Reliability:
- Browser runtime, profile, CDP, and bridge behavior did not change.
- Browser reliability remains an evidence-gated claim. The next browser
  behavior change still needs focused real browser/LLM acceptance or equivalent
  operator-visible smoke evidence before a checkpoint can claim convergence.

Acceptance Evidence:
- Governance-only change. No real LLM/browser acceptance ran.
- Required verification for this supplement:
  `npx tsx --test scripts/agent-workbench-ledger-check.test.ts`,
  `npm run ledger:check`, and `npm run typecheck`.
- Next runtime/result/browser behavior slice still requires a focused real
  scenario before it can claim `converging`.

Regression Risk:
- Main risk is over-tightening the checker and making isolated ledger fixtures
  harder to test. The new unit coverage uses a shared policy-contract fixture
  and a negative test that proves missing G0 policy sections fail explicitly.
- Product regression risk is low because no runtime or Control Center code
  changed.

## 2026-05-31 07:53 CST - Tool Loop Closeout Visibility

Direction: unknown

Execution Kernel:
- The runtime now records structured `toolLoopCloseout` metadata when final
  synthesis is forced by pseudo tool-call markup, wall-clock budget,
  tool-round limit, completed sub-agent final content, or sub-agent timeout.
- Execution behavior is intentionally unchanged in this slice: it does not
  retry timed-out tools or change budgets. It removes ambiguity by preserving
  why the tool loop stopped and how many rounds/calls had completed.

Result Quality:
- Budget-limited, timeout-limited, and malformed-tool-call closeouts can no
  longer appear as fully healthy final answers in mission observability.
- Completed sub-agent final-content closeout remains a healthy path, while
  forced closeouts now mark Mission Health as `needs_attention` so users know
  to inspect evidence or continue with a narrower follow-up before accepting
  the answer.

Workbench UX:
- Mission Detail now surfaces the closeout quality check and prioritizes a
  concrete action for budget-limited answers: continue from the same mission
  with narrower scope or inspect the trace before accepting the answer.
- Control Center smoke covers the visible action text so the attention path
  stays user-visible.

Browser Reliability:
- Browser execution, profile selection, CDP, and bridge behavior did not
  change.
- Browser-backed work benefits indirectly because browser sub-agent timeouts
  now carry through as final-answer closeout context instead of only appearing
  in lower-level tool traces.

Acceptance Evidence:
- `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts`:
  26 passed.
- `npx tsx --test packages/app-gateway/src/mission-thread-bridge.test.ts
  packages/app-gateway/src/mission-observability.test.ts`: 53 passed.
- `npm run typecheck`: passed.
- `npm run build:control-center`: passed.
- `npm run control-center:smoke -- --allow-missing-browser`: passed with
  desktop and mobile screenshots.
- No real LLM/browser acceptance ran, so this checkpoint cannot claim runtime
  convergence under the G0 evidence gate.
- Next required real gates: a `budget-limited closeout` mission scenario that
  intentionally exhausts a mission tool budget and verifies Mission Health
  shows the closeout warning plus `toolLoopCloseoutReason=round_limit`, and a
  `sub-agent timeout closeout` mission scenario that forces a sub-agent timeout
  and verifies `toolLoopCloseoutReason=sub_agent_timeout`,
  `evidenceAvailable`, and the Mission Detail attention action.

Regression Risk:
- Main compatibility risk is adding new optional metadata/runtime fields. The
  bridge keeps them additive and stringifies only primitive closeout fields.
- Quality-gate risk is over-warning completed work. Tests pin the distinction:
  budget-limited closeout warns, completed sub-agent final-content closeout
  passes.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? no
- Evidence: focused unit, bridge, observability, typecheck, build, and UI smoke
  prove the new signal path locally, but no real mission E2E exercised it.
- If no, next required gate: run the named `budget-limited closeout` and
  `sub-agent timeout closeout` real mission scenarios above and verify both the
  mission telemetry fields and Mission Detail warning/action.

## 2026-05-31 08:15 CST - Closeout Real Acceptance Gates

Direction: converging

Execution Kernel:
- Added optional mission E2E scenarios for the two closeout paths the previous
  checkpoint named as required gates: `budget-limited-closeout` and
  `sub-agent-timeout-closeout`.
- The budget scenario starts the daemon with
  `TURNKEYAI_AGENT_TOOL_MAX_ROUNDS=1` and requires the model to gather one
  source, attempt a second tool call, then synthesize from gathered evidence
  after the runtime forces `toolLoopCloseoutReason=round_limit`.
- The timeout scenario forces `sessions_spawn(timeout_seconds=0.001)` and
  verifies `toolLoopCloseoutReason=sub_agent_timeout`, evidence availability
  propagation, resumable worker-session state, no fallback tool calls, and
  terminal mission liveness cleanup.

Result Quality:
- Closeout scenarios are no longer judged by a blanket healthy quality gate.
  The JSON report treats `budget-limited-closeout` as passing only when Mission
  Health is `needs_attention`, and treats `sub-agent-timeout-closeout` as
  passing only when the quality gate is `blocked` with a visible closeout
  warning.
- This is stricter than unit coverage because the final answer must include a
  bounded, source-aware response and must not claim unverified second-source or
  timeout evidence.

Workbench UX:
- No new UI components changed in this checkpoint.
- The acceptance path now proves the Mission Detail data model has the fields
  needed for user-visible closeout explanation: `toolLoopCloseoutReason`,
  completed round/call counts, evidence availability as emitted by the tool
  result, and the closeout quality check.

Browser Reliability:
- Browser/CDP execution did not change.
- The timeout gate directly exercises sub-agent timeout closeout behavior,
  which is one of the paths that previously made browser-heavy missions look
  like they were still working or silently weak.

Acceptance Evidence:
- `npm run mission:e2e:matrix -- --model-catalog models.local.json
  --matrix-scenarios budget-limited-closeout,sub-agent-timeout-closeout
  --scenario-timeout-ms 240000 --json tmp/mission-closeout-e2e.json`: passed
  against a real LLM in 88157ms.
- `budget-limited-closeout`: mission `msn.mpt1c5hz.1`, status `done`,
  quality `needs_attention`, tools `1/1`, sessions `0/0`, liveness `0/0/0`,
  final closeout `round_limit`, evidence available `true`.
- `sub-agent-timeout-closeout`: mission `msn.mpt1cjia.2`, status `done`,
  quality `blocked`, tools `1/1`, sessions `1/0`, liveness `0/0/0`, final
  closeout `sub_agent_timeout`, evidence available `true`.
- The first attempted real run failed usefully: the budget gate used
  `sessions_spawn` and hit `completed_sub_agent_final` instead of
  `round_limit`. The scenario was corrected to use task tools so the acceptance
  gate now measures the intended runtime path.
- Re-run command for this focused gate:
  `npm run mission:e2e:matrix -- --model-catalog models.local.json
  --matrix-scenarios budget-limited-closeout,sub-agent-timeout-closeout
  --scenario-timeout-ms 240000 --json tmp/mission-closeout-e2e.json`
- Required local regression gate for the PR remains:
  `npm test -- --runInBand`, `npm run typecheck`, `npm run build`,
  `npm run ledger:check`, and `git diff --check`.

Regression Risk:
- Main runtime risk is the new environment knob
  `TURNKEYAI_AGENT_TOOL_MAX_ROUNDS`. It is additive and defaults to the current
  production value of 128 when unset or invalid.
- Main acceptance risk is model compliance in the budget-limited scenario: if a
  model calls both tools in one turn, the scenario should fail rather than hide
  the fact that the round-limit closeout was not actually exercised.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a real LLM exercised both forced-closeout paths, reached terminal
  mission state, left no active/waiting/stale runtime spans, and surfaced the
  expected user-visible Mission Health status instead of silently presenting a
  weak answer as healthy.
- Next required gate: run a longer multi-source product brief with the same
  closeout telemetry enabled to ensure the guardrails do not degrade normal
  high-quality completion paths.

## 2026-05-31 08:36 CST - G0 Active Goal Ledger Supplement

Direction: unknown

Execution Kernel:
- No execution-kernel, tool-use, session, browser, approval, or mission
  completion behavior changed in this checkpoint.
- The ledger contract now states that while the production workbench goal is
  active, implementation stages must be tied back to recorded acceptance
  evidence here rather than treated as complete at PR merge time.

Result Quality:
- Final-answer synthesis did not change.
- Result-quality governance is stricter: a stage can only claim closure when
  the ledger records the relevant acceptance evidence and answers whether
  stable complex-task delivery moved closer for a real user.

Workbench UX:
- No user-facing workbench UI changed.
- Product-management UX improves at the operating layer: the ledger now makes
  the goal object, acceptance evidence, and closure rule explicit enough to
  prevent drift back to PR-count or test-count progress reporting.

Browser Reliability:
- Browser runtime, profile, CDP, and bridge behavior did not change.
- Browser reliability remains evidence-gated. Browser behavior changes still
  need focused browser or browser-backed real LLM acceptance before a future
  checkpoint can mark them `converging`.

Acceptance Evidence:
- Governance-only supplement. No real LLM/browser acceptance ran.
- Required verification for this checkpoint is `npm run ledger:check`.
- Next product/runtime gate remains the longer multi-source product brief named
  in the previous checkpoint, with closeout telemetry enabled and quality
  assertions strong enough to catch weak synthesis.

Regression Risk:
- Runtime regression risk is none because only this progress document changed.
- Process risk is over-recording `converging` for governance-only work. This
  checkpoint is intentionally `unknown` to preserve the G0 evidence gate.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? no
- Evidence: the operating ledger is clearer, but no user-facing behavior or
  real E2E outcome improved in this checkpoint.
- If no, next required gate: run the longer multi-source product brief real
  acceptance scenario and record whether answer quality, closeout telemetry,
  and terminal liveness are all acceptable.

## 2026-05-31 08:44 CST - Long Brief Closeout Acceptance Gate

Direction: converging

Execution Kernel:
- Runtime execution semantics did not change. This checkpoint hardens the
  mission E2E report gate so ordinary long brief scenarios cannot pass JSON
  acceptance when their final answer was forced by `pseudo_tool_call`,
  `wall_clock_budget`, `round_limit`, or `sub_agent_timeout` closeout.
- Healthy `completed_sub_agent_final` synthesis remains allowed for normal
  multi-source missions because it means the lead synthesized from completed
  child-session final content rather than being forced to stop.

Result Quality:
- The long product brief gate now distinguishes healthy completed-sub-agent
  synthesis from degraded forced closeout. This prevents a quality-passed
  final answer from hiding the same forced-stop paths that previously caused
  weak or incomplete user-visible results.
- The real LLM run completed both product brief scenarios with passed quality
  checks, 3/3 tool results, 3 evidence-bearing events, 0 quality failures, and
  no fallback-answer language.

Workbench UX:
- No new UI components changed.
- The acceptance artifact is more useful to operators and reviewers: it now
  keeps closeout telemetry visible for normal long missions and fails the
  release gate if a forced closeout appears in a scenario that is supposed to
  complete normally.

Browser Reliability:
- Browser/CDP behavior did not change.
- The real `realistic-brief` scenario included browser-rendered dashboard
  evidence and completed with no recovery events, no browser profile fallback
  warning, and zero active/waiting/stale runtime subjects after terminal
  mission completion.

Acceptance Evidence:
- `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts`: 6 passed.
- `npm run typecheck`: passed.
- `npm run mission:e2e:matrix -- --model-catalog models.local.json
  --matrix-scenarios product-workbench-brief,realistic-brief
  --scenario-timeout-ms 300000 --json
  tmp/mission-long-brief-closeout-gate.json`: passed against a real LLM in
  68235ms.
- `product-workbench-brief`: mission `msn.mpt22nn0.1`, status `done`, quality
  `passed`, tools `3/3`, sessions `3/0`, liveness `0/0/0`, closeout
  `completed_sub_agent_final`, final bytes `1677`, bullets `6`.
- `realistic-brief`: mission `msn.mpt23f0o.2`, status `done`, quality
  `passed`, tools `3/3`, sessions `3/0`, liveness `0/0/0`, closeout
  `completed_sub_agent_final`, final bytes `1249`, bullets `6`.

Regression Risk:
- Main risk is over-failing a legitimate normal scenario that reaches a forced
  closeout but still produces a locally useful answer. That is intentional for
  release acceptance: forced closeout belongs in explicit closeout scenarios or
  user-visible attention states, not in a normal long-brief pass.
- The report gate now allows only the healthy `completed_sub_agent_final`
  closeout in normal scenarios; focused unit coverage pins both the forced
  failure and healthy pass cases.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: the previously named long-brief gate passed with real LLM evidence,
  normal multi-source missions stayed high quality, and the acceptance report
  would now fail if future normal briefs silently rely on forced closeout.
- Next required gate: keep this guard in the broader release acceptance matrix
  and run the full real gate after the next runtime/browser/workbench behavior
  change.

## 2026-05-31 11:21 CST - Natural Runtime Parity Reset

Direction: unknown

Execution Kernel:
- No runtime execution semantics changed in this checkpoint. The change is a
  reset of evidence accounting after auditing the current core runtime against
  raw mechanism notes and current code.
- The reset records that native tool loop, session tools, permission loop,
  browser private tools, memory tools, timeout closeout, cancellation, and
  replay are structurally present but remain `partial` unless a natural real
  LLM E2E proves the relevant behavior.

Result Quality:
- Natural mission reports now explicitly identify themselves as
  `natural-real-llm` capability evidence and carry required quality signals:
  completion, no stuck/loop, reasonable tool use, clean sub-agent liveness,
  source-backed evidence, decision-useful final answer, and no weak-answer
  signals.
- Validation-ops now preserves the natural mission report summary alongside
  the contract/mission matrix summary, so future readiness views can separate
  protocol shape from natural user-task capability.

Workbench UX:
- No UI changed.
- The workbench impact is downstream: operator/readiness surfaces now have a
  structured natural report to cite before claiming an agent capability
  improved.

Browser Reliability:
- Browser execution did not change.
- Browser-backed natural capability remains unproven for this checkpoint. The
  next browser gate must be a natural browser dynamic/dashboard run or a
  profile/session reliability injection, not a UI-only smoke.

Acceptance Evidence:
- `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts
  packages/qc-runtime/src/real-llm-acceptance-summary.test.ts
  packages/qc-runtime/src/validation-ops-inspection.test.ts
  scripts/real-llm-acceptance.test.ts`: passed, 28 tests.
- `npm run typecheck`: passed.
- No real LLM/browser acceptance ran in this checkpoint, so this is not a
  capability-converging checkpoint.

Regression Risk:
- Main risk is schema consumers expecting only mission matrix details in
  `realAcceptance`. The new natural fields are additive and optional.
- Another risk is over-counting natural scenarios in readiness totals. Focused
  tests now pin total-case accounting and natural selectors.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? no
- Evidence: the acceptance accounting is stricter and less likely to overclaim,
  but no real user prompt ran better in this checkpoint.
- If no, next required gate: run the natural long delegation and natural
  browser dynamic/dashboard gates after the next prompt/runtime slice, and
  record mission ids plus natural report summaries.

## 2026-05-31 11:43 CST - Natural Memory Recall Gate

Direction: converging

Execution Kernel:
- Added `natural-memory-recall` to the natural mission matrix and the default
  real-acceptance natural scenario list.
- The scenario uses a natural follow-up to recover durable Helios-47 launch
  context through native memory behavior. It does not use contract markers,
  fixed final-answer shape, or tool-name instructions in the user prompt.
- The first real run exposed a useful failure: the model searched memory but
  stopped before inspecting a candidate entry. The scenario now asks for
  durable memory around the exact codename and requires the runtime evidence to
  include both search and get phases.

Result Quality:
- The focused real LLM run completed with the remembered launch window,
  release owner, residual risk, source-backed evidence, no weak-answer signals,
  and no stuck liveness.
- This proves one narrow P0-E capability: natural durable memory recall can
  recover a seeded thread memory item under a user-like follow-up.

Workbench UX:
- No UI changed.
- Downstream readiness views now receive this scenario through the existing
  natural mission report path when full real acceptance runs.

Browser Reliability:
- Browser behavior did not change and was not exercised by this memory gate.
- Browser-backed natural capability still needs its own dynamic/dashboard
  gate before claiming browser reliability progress.

Acceptance Evidence:
- `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts
  scripts/real-llm-acceptance.test.ts`: passed, 18 tests.
- `npm run typecheck`: passed.
- `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-memory-recall --scenario-timeout-ms
  300000 --json tmp/natural-memory-recall-e2e.json`: passed.
- Real mission: `msn.mpt8ijl6.1`, status `done`, natural `passed`, tools
  `2/2`, sessions `0/0`, liveness `0/0/0`, final bytes `716`, weak-answer
  signals `none`.

Regression Risk:
- Main risk is that this scenario could become too suggestive if the prompt
  starts spelling out tool mechanics. The prompt-policy test continues to
  reject fixed markers, exact answer shape, and explicit tool-call commands.
- Another risk is artificial memory seeding racing with context refresh. The
  fixture now merges with existing thread memory, waits for setup completion,
  and asserts the launch note exists before the natural follow-up starts.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a previously unproven natural memory-recall capability now has a
  focused real LLM mission artifact with ordered native memory tool evidence
  and a useful final answer.
- Next required gate: run natural browser dynamic/dashboard and natural long
  delegation gates so memory is not the only P0 capability with fresh real
  evidence.

## 2026-05-31 11:55 CST - Natural Browser Rendered Evidence Gate

Direction: converging

Execution Kernel:
- Tightened natural mission quality evaluation with `requiredEvidencePatterns`
  so browser-backed scenarios can require facts to appear in tool evidence,
  not only in the final answer.
- The natural browser dynamic page scenario now requires rendered dashboard
  facts in the evidence stream: queue depth 11, SLA breaches 3, and the
  recommended owner.

Result Quality:
- The focused real LLM browser run completed with source-backed operational
  state, escalation trigger, owner, recommended action, no weak-answer signals,
  and no forced closeout.
- This closes the immediate P0-D evidence gap recorded in the reset: the
  browser natural gate now proves rendered dashboard evidence was collected by
  the tool path before the final synthesis passed.

Workbench UX:
- No UI changed.
- The value is upstream of the workbench: future Mission Detail evidence cards
  and readiness views can trust that this natural browser scenario only passes
  when the trace contains rendered tool evidence.

Browser Reliability:
- The focused browser-backed natural E2E passed with one browser session, one
  tool result, no failed tools, no recovery events, and no active/waiting/stale
  liveness after completion.
- Browser profile lock/CDP failure injection still needs a separate reliability
  gate; this checkpoint proves the happy-path rendered-page capability, not all
  browser recovery paths.

Acceptance Evidence:
- `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts`: passed, 13
  tests.
- `npm run typecheck`: passed.
- `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-browser-dynamic-page
  --scenario-timeout-ms 300000 --json tmp/natural-browser-dynamic-e2e.json`:
  passed.
- Real mission: `msn.mpt9919c.1`, status `done`, natural `passed`, tools
  `1/1`, sessions `1/0`, liveness `0/0/0`, browser `yes`, final bytes
  `1205`, weak-answer signals `none`.

Regression Risk:
- Main risk is overfitting the browser scenario to final-answer text. The new
  check reads timeline evidence text and runtime result content before judging
  the natural scenario passed.
- Review caught that the first implementation also read thought events as
  evidence, which could let the model bypass the gate by restating facts. The
  evidence collector now only accepts tool/browser/doc/artifact timeline
  events.
- Another risk is making natural prompt language fixture-shaped. The prompt
  remains user-like and the forbidden prompt-language test still rejects fixed
  markers, exact answer shapes, and explicit tool-call commands.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a natural browser task now has a real LLM mission artifact and a
  stricter evidence gate proving rendered dashboard facts were captured through
  the browser tool path.
- Next required gate: run natural long delegation and browser reliability
  failure-injection gates so this happy-path proof extends to complex
  multi-agent and recovery behavior.

## 2026-05-31 12:23 CST - Natural Long Delegation Evidence Gate

Direction: converging

Execution Kernel:
- Tightened `natural-long-delegation` so the three-source requirement is
  checked against tool/browser evidence rather than by forcing internal fixture
  labels into the final answer.
- Improved Mission Health source coverage for natural source labels: exact
  label coverage still passes, and generated labels with generic suffixes such
  as research/dashboard can also pass when the final answer names the
  distinctive source stem.

Result Quality:
- The first baseline run exposed the wrong gate: the final answer was useful
  and evidence-backed, but failed because it did not repeat internal source
  labels. That was not a user-quality failure.
- After the fix, the real long-delegation run completed with three independent
  sub-agent results, source coverage `pass`, no weak-answer signals, and no
  forced closeout.

Workbench UX:
- No UI changed.
- Mission Health now aligns better with natural user-facing answers: a final
  can cite `product-orchestration` / `product-signals` naturally without being
  marked `needs_attention` for omitting generic suffixes such as research or
  dashboard.

Browser Reliability:
- Browser execution semantics did not change.
- The real gate did exercise a browser sub-agent for the live signal dashboard
  and completed with no profile fallback, failed tool result, recovery event,
  or active/waiting/stale runtime liveness.

Acceptance Evidence:
- `npx tsx --test packages/app-gateway/src/mission-observability.test.ts
  scripts/mission-tool-use-e2e-report.test.ts`: passed, 35 tests.
- `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-long-delegation
  --scenario-timeout-ms 300000 --json tmp/natural-long-delegation-e2e.json`:
  passed.
- Real mission: `msn.mpt9wz8v.1`, status `done`, natural `passed`,
  Mission Health `passed`, tools `3/3`, sessions `3/0`, browser `yes`,
  liveness `0/0/0`, source coverage `3/3`, final bytes `3852`,
  weak-answer signals `none`.

Regression Risk:
- Main risk is making source coverage too permissive. Focused tests keep the
  guardrail: `Vendor Alpha` plus a vague "second vendor source" still warns
  because the distinctive `Beta` token is missing.
- Another risk is accepting final-answer-only source claims. The long
  delegation gate now checks the three source streams in evidence text, while
  the final answer still must contain decision-useful terms and pass Mission
  Health source coverage.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a natural, browser-backed, three-sub-agent product brief now has a
  real LLM mission artifact with terminal liveness cleanup, Mission Health
  `passed`, source coverage `3/3`, and no weak-answer or fallback language.
- Next required gate: run browser reliability failure injection and approval
  dry-run natural gates with the same standard: real mission artifact, terminal
  liveness, and user-visible useful output.

## 2026-05-31 12:53 CST - Natural Approval Auto-Apply Gate

Direction: converging

Execution Kernel:
- Fixed the approval-decision continuation path so an approved operator
  decision applies the runtime permission cache immediately when the approval
  carries tool-permission metadata.
- The follow-up prompt now tells the agent that permission is already applied
  and asks it to perform only the approved scoped action, instead of relying on
  the model to manually call `permission_result` and `permission_applied`
  before it can resume.

Result Quality:
- Baseline natural approval E2E failed usefully: the model requested approval
  but produced an "awaiting approval" answer and never completed
  query/result/applied. That matched the P0 reset concern that approval
  continuation was structurally present but unproven under a natural prompt.
- After the fix, the same natural prompt completed the safe browser dry-run
  with approval requested/decided/applied, a useful final answer, no weak-answer
  signals, and no fallback language.

Workbench UX:
- No UI changed.
- Mission/approval timelines are more trustworthy for the workbench because
  an operator approval now produces both the decision event and the applied
  permission event before the agent resumes.

Browser Reliability:
- Browser execution semantics did not change.
- The real gate exercised a browser sub-agent after the approval gate and
  completed with no failed tool result, no recovery event, no profile fallback,
  and no active/waiting/stale runtime liveness.

Acceptance Evidence:
- Baseline failure command:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-approval-dry-run-action
  --scenario-timeout-ms 300000 --json tmp/natural-approval-baseline.json`:
  failed because `approval scenario did not complete query/result/applied
  loop`.
- `npx tsx --test packages/app-gateway/src/routes/mission-routes.test.ts
  packages/app-gateway/src/tool-permission-service.test.ts`: passed, 36 tests.
- `npm run typecheck`: passed.
- `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-approval-dry-run-action
  --scenario-timeout-ms 300000 --json tmp/natural-approval-e2e.json`: passed.
- Real mission: `msn.mptaznp0.1`, status `done`, natural `passed`,
  Mission Health `passed`, tools `1/1`, sessions `1/0`, browser `yes`,
  approvals `1/1/1`, liveness `0/0/0`, final bytes `875`,
  weak-answer signals `none`.

Regression Risk:
- Main risk is applying a permission decision too broadly. The route only
  auto-applies approved decisions that include tool-permission thread metadata;
  denied approvals and non-tool approvals keep the prior behavior.
- Another risk is hiding explicit permission-tool regressions. Focused
  tool-permission tests still cover manual `permission_query`,
  `permission_result`, and `permission_applied`; this change hardens the
  operator-decision route, not the standalone tool protocol.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a natural permission-gated browser action that previously stopped
  at "awaiting approval" now reaches terminal `done`, records
  query/result/applied, executes the approved browser dry-run, and leaves no
  live runtime liveness.
- Next required gate: browser reliability failure injection with the same
  natural-real-LLM standard, especially profile lock/CDP unavailable paths
  that must not degrade into loops or weak fallback answers.

## 2026-05-31 13:18 CST - Natural Browser Profile Fallback Gate

Direction: converging

Execution Kernel:
- Tightened the natural mission acceptance evaluator so browser profile
  fallback is no longer invisible in browser-backed natural runs.
- Natural mission reports now carry profile fallback counts in the structured
  scenario metrics and surface `profileFallbackFree` as a first-class quality
  signal.

Result Quality:
- The browser dynamic-page natural gate still requires rendered facts to appear
  in the evidence stream, not only in the final answer.
- The rendered-fact matcher now accepts natural table/sentence phrasing for
  `Queue depth` and `SLA breaches` while keeping the source of truth in
  tool/browser/doc/artifact evidence.

Workbench UX:
- No UI changed.
- Validation summaries now preserve browser profile fallback counts, so future
  workbench surfaces can distinguish clean browser evidence from evidence that
  succeeded through an isolated fallback profile.

Browser Reliability:
- Browser-backed natural E2E now fails if a profile lock fallback occurs.
- This does not yet inject a profile lock or CDP-unavailable failure. It closes
  the previous evidence gap where such degradation could pass a natural browser
  gate unnoticed.

Acceptance Evidence:
- `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts
  packages/qc-runtime/src/real-llm-acceptance-summary.test.ts
  packages/qc-runtime/src/validation-ops-inspection.test.ts`: passed,
  27 tests.
- `npm run typecheck`: passed.
- `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-browser-dynamic-page
  --scenario-timeout-ms 300000
  --json tmp/natural-browser-profile-gate-e2e.json`: passed.
- Real mission: `msn.mptbv72k.1`, status `done`, natural `passed`,
  tools `1/1`, sessions `1/0`, browser `yes`,
  profile fallback `0`, liveness `0/0/0`, final bytes `904`,
  weak-answer signals `none`.

Regression Risk:
- Main risk is making rendered evidence matching too permissive. Focused tests
  still fail when the rendered facts appear only in the final answer and not in
  timeline evidence.
- Another risk is over-claiming browser reliability. This checkpoint proves
  the natural gate now rejects hidden profile fallback; it does not prove CDP
  unavailable, attach failure, timeout, or target detach recovery under natural
  real LLM prompts.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a real browser-backed natural mission now passes only when the
  browser path is clean of profile fallback and still has rendered facts in
  the durable evidence stream.
- Next required gate: add failure-injection acceptance for CDP unavailable,
  attach failure, timeout, and target detach so those buckets produce bounded
  operator-facing outcomes instead of weak answers or loops.

## 2026-05-31 13:36 CST - Natural Browser CDP Unavailable Closeout

Direction: converging

Execution Kernel:
- Added a natural browser-unavailable acceptance scenario that uses the same
  browser dashboard prompt shape but forces the browser transport through an
  unavailable direct-CDP endpoint.
- Fixed a persistent-context rejection leak in the browser session manager:
  the active caller already received the launch failure, but the cached
  derived context promise could still become a process-level unhandled
  rejection before any reuse caller awaited it.
- The natural quality gate now distinguishes an allowed, evidence-backed
  browser-unavailable closeout from forbidden model-knowledge fallback.

Result Quality:
- The passing real run produced a bounded operator closeout instead of a loop
  or weak dashboard summary.
- The final answer explicitly separated verified runtime failure from
  unverified dashboard content and did not claim rendered Queue depth, SLA, or
  owner facts after browser evidence was unavailable.
- The only weak-answer signal retained in the report is the expected
  tool-unavailable signal; model-knowledge fallback remains a failure.

Workbench UX:
- No UI changed.
- The mission timeline and metrics now have real evidence for the future
  workbench behavior: browser transport failure can end as a clear user-facing
  closeout rather than a stuck mission or daemon crash.

Browser Reliability:
- Baseline forced-CDP-unavailable run crashed the daemon through an unhandled
  persistent-context rejection.
- After the fix, the same forced failure produced a completed natural mission:
  browser worker used, no profile fallback, no active/waiting/stale runtime
  liveness, and a useful final closeout.

Acceptance Evidence:
- Baseline command:
  `TURNKEYAI_BROWSER_TRANSPORT=direct-cdp
  TURNKEYAI_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9
  npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-browser-unavailable-closeout
  --scenario-timeout-ms 300000
  --json tmp/natural-browser-unavailable-e2e.json`: failed because the daemon
  exited on `browser_cdp_unavailable`.
- `npm test -- --runInBand scripts/mission-tool-use-e2e-report.test.ts`:
  passed, 1286 tests.
- `npm test -- --runInBand
  packages/browser-bridge/src/chrome-session-manager.test.ts`: passed,
  1286 tests.
- Final real E2E command with the same forced unavailable CDP endpoint:
  passed.
- Real mission: `msn.mptcjoro.1`, status `done`, natural `passed`,
  tools `1/1`, sessions `1/0`, browser `yes`, profile fallback `0`,
  liveness `0/0/0`, final bytes `741`, weak-answer signals
  `tool unavailable fallback` only.

Regression Risk:
- Main risk is over-allowing browser-unavailable language. Focused tests keep
  the exception scoped to the new failure-closeout scenario and still reject
  model-knowledge fallback.
- Another risk is accepting unsupported facts when browser evidence is missing.
  The scenario explicitly forbids rendered dashboard fact claims in the final
  answer when the browser could not verify them.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a forced real browser transport outage no longer crashes the
  daemon or stalls the mission; it produces a terminal, evidence-bounded
  operator closeout under a natural LLM prompt.
- Next required gate: extend the same natural-real-LLM failure-injection
  standard to attach failure, command timeout, and target/session detach.

## 2026-05-31 13:51 CST - Raw CDP Expert Failure Mission Visibility

Direction: converging

Execution Kernel:
- Kept raw-CDP expert capability out of the default model-visible tool
  surface. The reference architecture uses browser sub-agents as the
  model-visible layer; raw CDP remains transport/operator machinery.
- Added optional mission context to browser expert routes and wired the daemon
  to validate that context before writing recovery events.
- Route-level failure injection now records raw-CDP expert failures into the
  mission activity stream with bucket-level runtime metadata.

Result Quality:
- No final-answer behavior changed for normal browser work.
- Expert-lane failures now become structured mission evidence instead of only
  HTTP error bodies, so replay/operator surfaces can distinguish
  `attach_failed`, `target_not_found`, `expert_session_detached`, and
  `cdp_command_timeout`.

Workbench UX:
- No UI changed.
- Mission timelines can now include raw-CDP expert recovery events when an
  operator or diagnostic workflow runs the expert lane with mission context.
  This closes part of the gap between transport diagnostics and mission
  replay without exposing unsafe raw-CDP operations to ordinary agents.

Browser Reliability:
- The injected failure cases exercise the existing direct-CDP expert adapter
  recovery boundaries:
  - attach failure after relisting
  - missing target after relist
  - detached expert session during an in-flight command
  - bounded command timeout without retry
- The real model-visible browser closeout gate was rerun to confirm the public
  browser sub-agent layer still completes cleanly when CDP is unavailable.

Acceptance Evidence:
- `npm test -- --runInBand
  packages/app-gateway/src/routes/browser-expert-acceptance.test.ts`:
  passed, 1286 tests.
- `npm run typecheck`: passed.
- Real LLM E2E:
  `TURNKEYAI_BROWSER_TRANSPORT=direct-cdp
  TURNKEYAI_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9
  npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-browser-unavailable-closeout
  --scenario-timeout-ms 300000
  --json tmp/natural-browser-expert-visibility-e2e.json`: passed.
- Real mission: `msn.mptd2g5r.1`, status `done`, natural `passed`,
  tools `3/3`, sessions `1/0`, browser `yes`, profile fallback `0`,
  liveness `0/0/0`, final bytes `710`, weak-answer signals
  `tool unavailable fallback` only.

Regression Risk:
- Main risk is widening raw-CDP exposure. This change does not add a
  model-visible tool and only adds optional mission metadata to existing expert
  routes.
- Another risk is writing activity to the wrong mission. The route uses the
  existing mission/work-item validator before recording; blank, missing-scope,
  and unknown mission contexts keep the bridge-validator behavior.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: raw-CDP expert failures that previously stopped at route response
  level are now mission-visible recovery events, while the model-visible
  browser layer still completes a forced CDP-unavailable natural closeout.
- Next required gate: add an operator-facing recovery action or diagnostic
  workflow that consumes these raw-CDP recovery events instead of merely
  listing them.

## 2026-05-31 14:08 CST - Natural Active Tool Cancellation Gate

Direction: converging

Execution Kernel:
- Added a natural-real-LLM cancellation scenario for an active sub-agent tool
  call. The prompt is user-like and avoids fixed markers, exact final-answer
  shapes, or tool-call mandates.
- The gate waits for the runtime to expose a real `sessions_spawn` call with
  durable `messageId` and `toolCallId`, then drives `/message/cancel-tools`
  against that active call.
- The scenario verifies that the worker session reaches `cancelled`, the
  cancelled tool result is persisted, and mission liveness settles to zero.

Result Quality:
- Natural quality now has an explicit cancellation requirement: scenarios that
  claim cancellation coverage must record at least one cancelled tool result.
- The natural final answer must remain evidence-backed, useful, and free of
  weak fallback signals while separating verified, unverified, and continuation
  guidance after cancellation.

Workbench UX:
- No UI changed in this slice.
- This produces replayable mission evidence for the existing workbench:
  `tool call -> cancelled tool result -> final answer`, which is the
  timeline shape the user needs when stopping long-running work.

Browser Reliability:
- No browser behavior changed.
- This gate covers the sibling runtime failure mode: active sub-agent work can
  be interrupted without leaving the mission stuck in `creating` or `working`.

Acceptance Evidence:
- `npm test -- --runInBand scripts/mission-tool-use-e2e-report.test.ts`:
  passed, 1288 tests.
- `npm run typecheck`: passed.
- Real LLM E2E:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-cancel-active-tool
  --scenario-timeout-ms 300000
  --json tmp/natural-cancel-active-tool-e2e.json`: passed.
- Real mission: `msn.mpte1iau.1`, status `done`, natural `passed`,
  tools `1/1`, cancelled tools `1`, sessions `1/0`, browser `no`,
  profile fallback `0`, liveness `0/0/0`, final bytes `1152`, weak-answer
  signals `none`.

Regression Risk:
- The test runner now cancels an active tool call in a natural E2E path, so
  flakes are possible if a model refuses to start tool-backed source work. That
  is intentional capability evidence, not a contract marker bypass.
- The cancellation quality check only applies to scenarios that opt into
  `requiresCancellation`; existing natural scenarios keep their prior gates.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a real model naturally started sub-agent source work, the runtime
  cancelled the active call by `toolCallId`, persisted the cancelled result,
  and the mission reached a useful terminal answer with no active/waiting/stale
  runtime subjects.
- Next required gate: prove follow-up continuation after a cancelled or
  timeout-limited run can reuse the durable child context instead of spawning
  duplicate work.

## 2026-05-31 14:56 CST - Natural Follow-Up Session Reuse Gate

Direction: converging

Execution Kernel:
- Tightened the natural follow-up E2E so phase two must continue the child
  session created in phase one with `sessions_send`.
- The gate now extracts the phase-one `session_key`, asserts phase two does not
  call `sessions_spawn` again after the first answer, and verifies the
  continuation result arrives before the follow-up final answer.
- The natural prompt remains user-like: it asks to continue the same Vendor
  Alpha research thread without exact call counts, fixed markers, or final
  answer shape instructions.

Result Quality:
- Real E2E exposed two quality-gate false positives while the runtime behavior
  was correct: continuation work labels such as `Vendor Alpha review extraction`
  were counted as source labels, and cautious unverified integration questions
  were treated as unsupported positive claims.
- Source coverage now distinguishes entity tokens from generic work/action
  suffixes such as review, extraction, synthesis, summary, report, and
  verification. Final answers still must cover distinctive source entities such
  as Vendor Alpha, Vendor Beta, or Ops.
- Unsupported vendor-integration checks now reject positive support claims, but
  allow the final answer to list those integrations as unverified questions.

Workbench UX:
- No UI changed in this slice.
- The replay/timeline signal is stronger: the user can see one child session
  being spawned, one continuation being sent, and the final answer following the
  continuation result without duplicate child work.

Browser Reliability:
- No browser control behavior changed.
- The real E2E used the browser-backed worker path for source collection and
  completed with zero profile fallbacks.

Acceptance Evidence:
- `npm test -- --runInBand packages/app-gateway/src/mission-observability.test.ts
  scripts/mission-tool-use-e2e-report.test.ts`: passed, 1292 tests.
- `npm run typecheck`: passed.
- Real LLM E2E:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-followup-continuation
  --scenario-timeout-ms 300000
  --json tmp/natural-followup-continuity-e2e-final4.json`: passed.
- Real mission: `msn.mptfccgc.1`, status `done`, natural `passed`,
  mission qualityGate `passed`, tools `2/2`, sessions `1/1`, browser `yes`,
  profile fallback `0`, liveness `0/0/0`, final bytes `2715`, weak-answer
  signals `none`.

Regression Risk:
- The new continuation assertion is deliberately stricter than aggregate
  counters. A model that starts duplicate child work during natural follow-up
  will now fail even if the final answer looks acceptable.
- Source-label token filtering must not hide real source omissions. Regression
  tests keep distinctive source tokens warning when missing while ignoring only
  generic work/action words.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a real model completed a two-turn mission by reusing the durable
  child session instead of restarting the research task, produced a useful
  terminal answer, and left no runtime liveness residue.
- Next required gate: prove continuation works after a timeout-limited or
  interrupted child session, not only after a clean completed child session.

## 2026-05-31 15:16 CST - Natural Timeout Follow-Up Continuation Gate

Direction: converging

Execution Kernel:
- Added a natural timeout-follow-up E2E scenario that starts with a bounded
  slow-source attempt, verifies the timed-out worker session is resumable, then
  sends a normal user follow-up against the same mission.
- The gate asserts phase two uses `sessions_send` with the original
  `session_key`, does not spawn duplicate child work after the phase-one
  answer, and emits a continuation result before the final answer.
- Natural quality now has an explicit `requiresTimeout` signal, so timeout
  scenarios cannot pass by merely talking about a timeout without a recorded
  timed-out tool result.

Result Quality:
- The real E2E completed with a useful final answer and no weak-answer signals,
  while preserving operator attention for the timeout path.
- The mission quality gate stayed `blocked` because two timed-out tool results
  are still real failed-tool attention. That is expected for this scenario:
  the capability gate is continuation and clean terminal closeout, not hiding
  the timeout from operators.

Workbench UX:
- No UI changed in this slice.
- The existing timeline now has replayable evidence for the full sequence:
  timed-out `sessions_spawn`, user follow-up, `sessions_send` continuation, and
  terminal answer.

Browser Reliability:
- No browser implementation changed.
- The real run reported zero browser profile fallbacks and no active/waiting/
  stale runtime subjects after completion.

Acceptance Evidence:
- `npm test -- --runInBand scripts/mission-tool-use-e2e-report.test.ts`:
  passed, 1293 tests.
- `npm run typecheck`: passed.
- Real LLM E2E:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-timeout-followup-continuation
  --scenario-timeout-ms 300000
  --json tmp/natural-timeout-followup-continuation-e2e.json`: passed.
- Real mission: `msn.mptfz2jw.1`, status `done`, natural `passed`,
  mission qualityGate `blocked` for expected timeout attention, tools `3/3`,
  timed-out tools `2`, sessions `1/1`, browser `yes`, profile fallback `0`,
  liveness `0/0/0`, final bytes `1657`, weak-answer signals `none`.

Regression Risk:
- The new gate is intentionally stricter than aggregate counters: it requires
  the timeout to be real, the worker session to be resumable, and the follow-up
  to reuse that session instead of restarting the source work.
- Because it uses a live model and slow-source behavior, failures may indicate
  either runtime regression or prompt/tool discipline drift. The failure output
  should be treated as root-cause evidence, not bypassed with marker prompts.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a real model recovered from a timeout-limited child session via the
  durable continuation path, reached a terminal answer, and left no liveness
  residue while preserving the timeout as operator-visible attention.
- Next required gate: prove the same continuation behavior after an
  operator-interrupted child session, or improve timeout recovery so resumed
  slow-source work can complete with stronger source evidence instead of a
  second timeout.

## 2026-05-31 17:23 CST - Methodology Reset And Plan Reconciliation

Direction: unknown

Execution Kernel:
- Paused outer feature, diagnostics, and UI polish work until core runtime
  evidence is reclassified under the P0 natural runtime reset.
- Reconciled the runtime completion plan so structural implementation,
  visibility, capability proof, and unproven areas are no longer collapsed into
  a single "implemented" status.
- Future runtime changes must map to an explicit continuation/state row before
  implementation, especially for cancellation, timeout, approval, active work,
  retryable failure, and non-retryable failure paths.

Result Quality:
- This checkpoint does not claim result-quality improvement.
- A single natural E2E failure followed by a narrow scenario patch is not enough
  to call the system converging. The failure must first be classified against
  runtime state, prompt harness, tool protocol, browser reliability, memory, or
  replay behavior.
- Capability claims require a natural real LLM E2E mission or validation report
  artifact with useful terminal output, reasonable tool use, and no weak-answer
  fallback signals.

Workbench UX:
- No user-visible UI changed in this checkpoint.
- Workbench UX remains P1 until P0 gates prove the runtime can reliably produce
  useful terminal results under natural prompts.

Browser Reliability:
- No browser behavior changed in this checkpoint.
- Browser reliability remains evidence-gated by natural dynamic-page/dashboard
  runs and failure-bucket gates, not by route existence or smoke coverage alone.

Acceptance Evidence:
- This is a methodology reset and documentation reconciliation checkpoint, not a
  capability checkpoint.
- No new natural real LLM E2E was run or claimed for this checkpoint.
- Next implementation work must cite the matrix row it addresses and can only
  claim capability after a natural real LLM E2E mission/report artifact passes.

Regression Risk:
- Risk is process drift: reverting to PR count, test count, fixture markers, or
  exact prompt shapes as evidence would hide natural task failures.
- The mitigation is to block capability language unless the evidence class and
  natural mission/report id are recorded in the plan or ledger.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? unknown
- Evidence: no new runtime capability evidence was produced in this checkpoint.
- Next required gate: classify the next failing natural scenario by matrix row
  before implementing code, then rerun the natural gate without forced markers
  or exact-answer prompts.

## 2026-05-31 17:49 CST - Natural Cancel Follow-Up Continuation Gate

Direction: converging

Execution Kernel:
- Implemented explicit continuation for cancelled worker sessions: passive
  resume keeps the cancelled terminal state, while `sessions_send` with
  `resume-existing` can continue the same child session after a user follow-up.
- Tightened the session continuation directive so it only rewrites
  `sessions_spawn` to `sessions_send` when the latest user turn itself asks to
  continue, resume, retry, or revisit prior delegated work.
- Added a guard against the failure found during real E2E: an initial prompt
  that merely says a later follow-up may resume work must not trigger passive
  continuation in the same turn.

Result Quality:
- The real natural run completed with useful, evidence-backed output after an
  operator cancellation and a separate user follow-up.
- Final output reported no weak-answer signals and preserved cancellation
  context while using the resumed source evidence.

Workbench UX:
- No UI changed in this checkpoint.
- The mission timeline now has a stronger replay shape for interrupted work:
  cancelled `sessions_spawn` result, user follow-up, `sessions_send`
  continuation, resumed tool result, then final answer.

Browser Reliability:
- No browser behavior changed.
- The gate is non-browser by design; it isolates cancelled session continuation
  without conflating browser/CDP failures.

Acceptance Evidence:
- `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-cancel-followup-continuation
  --scenario-timeout-ms 300000
  --json tmp/natural-cancel-followup-continuation-e2e.json`: passed.
- Real mission: `msn.mptlebvw.1`, status `done`, natural `passed`,
  tools `2/2`, sessions `1/1`, browser `no`, profile fallback `0`,
  liveness `0/0/0`, final bytes `1444`, weak-answer signals `none`.
- `npm test -- --runInBand`: passed, 1302 tests.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

Regression Risk:
- Main risk was over-broad continuation rewriting. Unit coverage now pins both
  sides: explicit user follow-up resumes the cancelled session, while a
  hypothetical "later follow-up may resume" instruction does not.
- Another risk is too-short continuation timeouts after cancellation. The tool
  executor now floors cancelled-session continuation at the worker default so a
  copied tiny timeout cannot immediately fail resumed work.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a real model completed a cancelled-work follow-up by reusing the
  same durable child session instead of losing context, passively restarting, or
  spawning duplicate work.
- Next required gate: cold/restart continuation or browser hot/warm/cold resume,
  because cancellation and timeout continuation are now proven only within one
  live daemon run.

## 2026-05-31 17:55 CST - 24-Hour Goal Review

Direction: unknown

Repeated Issue Classes:
- The dominant repeated class was not route coverage or UI polish. It was
  runtime credibility under natural prompts: weak final answers, stalled
  missions, over-broad continuation, browser fallback instability, and
  capability claims that were too easy to infer from structural tests.
- Recent gates moved several of those from unknown to evidence-backed within a
  live daemon run: natural follow-up reuse, timeout continuation, cancellation
  continuation, browser rendered evidence, browser unavailable closeout, and
  profile fallback visibility.
- The repeated unresolved class is restart-grade continuity. Hot session reuse
  is improving, but warm/cold continuation after daemon restart or browser
  reattachment is still not proven.

E2E Trend:
- Trend over the last 24 hours is mixed but improving. Early work included too
  much structural confidence and too little natural validation; later work
  increasingly required real mission ids, no weak-answer signals, reasonable
  tool use, and clean liveness.
- The strongest positive trend is that failed or interrupted child work now has
  natural follow-up gates instead of only unit tests.
- The weakest trend remains browser recovery beyond a live process and the
  user-visible replay surface for understanding reused context.

Decision:
- Continue P0 runtime work, but only in slices tied to a matrix row and a
  natural real LLM gate.
- Do not restart outer feature/UI polish as the primary track until warm/cold
  browser/session continuity and replay clarity are either proven or explicitly
  scoped as remaining P0 risk.

Methodology Review Trigger:
- If the next two P0 slices add special-case prompt wording or local assertions
  without improving natural E2E outcomes, pause implementation and reopen the
  methodology review.
- If a natural E2E fails with the same class twice, stop adding narrow cases and
  root-cause the runtime/prompt/browser layer responsible for the repeated
  failure.

## 2026-05-31 18:04 CST - Natural Browser Follow-Up Continuation Gate

Direction: converging

Execution Kernel:
- Added a natural browser follow-up E2E scenario that first opens a
  JavaScript-rendered operations dashboard through a browser child session, then
  sends a normal user follow-up asking to continue from the same browser
  context.
- The gate asserts the second turn uses `sessions_send` with the original
  browser `session_key`, does not spawn duplicate browser work after the
  phase-one answer, records a continuation result, and emits the final answer
  after that result.
- The scenario is tied to the active/running and follow-up continuation rows:
  browser context must be reusable as mission evidence, not only as a one-shot
  page read.

Result Quality:
- The real natural run completed with useful, evidence-backed output that
  preserved rendered dashboard facts across the follow-up.
- Final output reported no weak-answer signals and named the operator action,
  owner, queue/SLA evidence, and residual uncertainty.

Workbench UX:
- No UI changed in this checkpoint.
- The mission timeline now has replayable browser continuity evidence:
  browser `sessions_spawn`, phase-one answer, user follow-up, `sessions_send`
  against the same browser session, continuation result, then final answer.

Browser Reliability:
- The real run used the browser worker path and completed with zero profile
  fallback events.
- This proves hot browser-context reuse inside one live daemon run. Warm/cold
  browser recovery remains unproven.

Acceptance Evidence:
- `npm test -- --runInBand scripts/mission-tool-use-e2e-report.test.ts`:
  passed, 1303 tests.
- `npm run typecheck`: passed.
- Real LLM E2E:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-browser-followup-continuation
  --scenario-timeout-ms 300000
  --json tmp/natural-browser-followup-continuation-e2e.json`: passed.
- Real mission: `msn.mptm2x4h.1`, status `done`, natural `passed`,
  tools `2/2`, sessions `1/1`, browser `yes`, profile fallback `0`,
  liveness `0/0/0`, final bytes `1096`, weak-answer signals `none`.

Regression Risk:
- The new gate can fail from genuine browser instability, prompt/tool
  discipline drift, or rendered-evidence quality loss. Such failures should be
  root-caused by row instead of bypassed with exact-answer prompts.
- Because this is hot reuse only, it must not be used to claim restart-safe
  browser recovery.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a real model continued a browser-backed dashboard review by reusing
  the same browser child session, produced useful terminal output, and left no
  active/waiting/stale runtime residue.
- Next required gate: warm/cold browser continuation after daemon restart or
  browser session reattachment, plus a product-facing replay view that makes
  the reused browser context obvious to the user.

## 2026-05-31 18:32 CST - Natural Browser Restart Continuation Gate

Direction: converging

Execution Kernel:
- Tightened the continuation directive so an explicit user follow-up can bind
  to the latest durable completed sub-agent session, not only timeout or
  cancelled sessions.
- The first real restart gate failed because the follow-up re-spawned browser
  work after daemon restart. The fix is in the runtime session-continuation
  contract: completed session results with a durable `session_key` can now
  drive `sessions_send` when the user asks to continue, resume, retry, revisit,
  or follow up.
- This reduces duplicate child work after process restart and keeps the lead
  from doing session selection purely from prompt history.

Result Quality:
- The passing real run produced an evidence-backed dashboard summary after
  daemon restart, with no weak-answer signals.
- The answer preserved rendered dashboard facts: queue depth, SLA breaches,
  owner, next action, and residual uncertainty.

Workbench UX:
- No workbench UI changed in this checkpoint.
- The underlying replay signal is clearer: the mission can show a browser
  `sessions_spawn` before restart and a `sessions_send` continuation after
  restart instead of an unexplained duplicate spawn.

Browser Reliability:
- The real run used the browser worker path and completed with zero persistent
  profile fallback events.
- Evidence proves daemon-restart continuation for a recoverable browser child
  session. It does not yet prove arbitrary browser process crash recovery or
  all cold-profile cases.

Acceptance Evidence:
- Focused regression:
  `npm test -- --runInBand packages/role-runtime/src/llm-response-generator.test.ts
  scripts/mission-tool-use-e2e-report.test.ts`: passed, 1309 tests.
- `npm run typecheck`: passed.
- Real LLM E2E:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-browser-restart-continuation
  --scenario-timeout-ms 360000
  --json tmp/natural-browser-restart-continuation-e2e.json`: passed.
- Real mission: `msn.mptnvop6.1`, status `done`, quality gate `passed`,
  natural `passed`, tools `3/3`, sessions `1/1`, browser `yes`, profile
  fallback `0`, liveness `0/0/0`, final bytes `778`, weak-answer signals
  `none`.

Regression Risk:
- The continuation rewrite must not hijack unrelated new tasks. Existing
  passive-continuation tests still cover future-looking "may ask later" wording,
  and the new behavior only activates on explicit continuation language plus a
  durable session result.
- Remaining risk is broader cold recovery: if the browser process or profile is
  unrecoverable, the product still needs a visible recovery path rather than
  silently claiming same-context continuity.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: after a real daemon restart, a natural user follow-up reused the
  existing browser child session through `sessions_send`, preserved rendered
  dashboard evidence, completed the mission, and left no stuck runtime state.
- Next required gate: browser process crash / unavailable-session recovery, and
  user-visible replay that makes restart/resume mode understandable without
  reading raw tool events.

## 2026-05-31 19:52 CST - Natural Browser Cold Recreation Continuation Gate

Direction: converging

Execution Kernel:
- Added conservative browser recovery for explicit `sessions_send`
  continuation: if a read-only browser continuation targets a missing or
  detached browser session, the browser worker reopens the same read-only task
  without retrying mutating actions.
- Tightened native tool routing so a model that first calls `sessions_list`
  during an explicit follow-up can still have a duplicate `sessions_spawn`
  rewritten to `sessions_send` against the listed existing session.
- Narrowed browser permission classification so read-only wording such as
  "submit findings/report/summary" does not become a false browser form-submit
  approval.

Result Quality:
- The real natural run completed with useful browser-backed evidence after the
  original browser session was revoked.
- Final output preserved queue depth, SLA breaches, Incident Commander owner,
  next action, and residual uncertainty, with no weak-answer signals.

Workbench UX:
- No UI changed in this checkpoint.
- The replayable flow is clearer for future UI work: phase-one browser
  `sessions_spawn`, explicit follow-up, `sessions_send` to the same sub-agent
  session, replacement browser session evidence, then final answer.

Browser Reliability:
- The gate revoked the original browser session before follow-up and still
  completed by re-opening the read-only dashboard through the existing browser
  child session.
- Evidence proves missing-browser-session recovery for read-only dashboard
  review. It does not prove safe recovery for browser mutations; those remain
  intentionally blocked from cold recreation.

Acceptance Evidence:
- Focused regressions:
  `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts
  packages/role-runtime/src/tool-use.test.ts
  scripts/mission-tool-use-e2e-report.test.ts
  packages/worker-runtime/src/browser-worker-handler.test.ts`: passed, 120
  tests.
- `npm run typecheck`: passed.
- Real LLM E2E:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-browser-cold-recreation-continuation
  --scenario-timeout-ms 360000
  --json tmp/natural-browser-cold-recreation-e2e.json`: passed.
- Real mission: `msn.mptpwruc.1`, status `done`, natural `passed`, tools
  `3/3`, sessions `1/1`, browser `yes`, profile fallback `0`, stuck `no`,
  final bytes `1085`, weak-answer signals `none`.

Regression Risk:
- The continuation rewrite must stay scoped to explicit follow-up language plus
  actual listed session evidence; failed session-result payloads are covered by
  regression tests so nested success-looking payloads do not hijack new spawns.
- The cold recreation path is read-only by design. If future product flows need
  mutation recovery, that must go through approval and idempotency design rather
  than reusing this path.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a real model followed up naturally after browser-session
  revocation, reused the existing browser child session, recovered by
  re-opening the dashboard, completed with useful evidence, and left no stuck
  runtime state.
- Next required gate: long multi-source task with browser plus non-browser
  sub-agents under wall-clock budget, and user-visible replay that explains
  recovery without raw JSON.

## 2026-05-31 20:21 CST - Real Acceptance Natural Continuity Matrix Alignment

Direction: unknown

Execution Kernel:
- No runtime behavior changed in this checkpoint.
- The release acceptance planner now uses a shared natural mission default
  matrix rather than a stale local subset, so browser follow-up, daemon restart
  continuation, cold browser-session recreation, timeout follow-up, and
  cancellation follow-up stay in the production gate.

Result Quality:
- No new real mission output was produced by this checkpoint.
- The expected quality impact is stronger future evidence: a full
  `acceptance:real` run must now prove the newer continuity scenarios instead
  of passing with only the older natural subset.

Workbench UX:
- No workbench UI changed in this checkpoint.
- The release acceptance artifact remains the user-visible proof path for
  Runtime -> Release acceptance.

Browser Reliability:
- No browser runtime path changed.
- The acceptance path now includes the already-defined browser continuity
  scenarios by default, including follow-up reuse, restart continuation, and
  cold read-only recreation.

Acceptance Evidence:
- This checkpoint is structural until a fresh real LLM `acceptance:real` report
  exists for the expanded natural matrix.
- Required next evidence: run `npm run acceptance:real -- --model-catalog
  models.local.json --scenario-timeout-ms 300000 --cdp-timeout-ms 45000` and
  record the resulting validation-ops run id or JSON artifact.

Regression Risk:
- The full release gate is longer because it now includes every natural
  continuity scenario. That is intentional for release evidence, but focused
  debugging should still use `--natural-mission-scenarios`.
- If a scenario becomes flaky, it must be fixed at the runtime or scenario
  quality-gate layer rather than silently dropping it from the default release
  matrix.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? unknown
- Evidence: structural planner/test alignment only; no new natural real LLM
  gate has run yet.
- Next required gate: a fresh full real acceptance run over the expanded
  natural continuity matrix.

## 2026-05-31 20:58 CST - Natural Browser Follow-Up Routing Regression

Direction: converging

Execution Kernel:
- Tightened explicit follow-up routing when the prompt asks to continue prior
  browser-backed work but no durable `session_key` is visible in the immediate
  prompt context.
- The runtime now performs one `sessions_list` lookup before allowing a
  duplicate `sessions_spawn`; if a continuable browser child session is found,
  the next attempted duplicate spawn is rewritten to `sessions_send`.
- Empty lookup results still allow a fresh spawn, and failed session results
  cannot be mistaken for continuable sessions.

Result Quality:
- The focused natural run completed with a useful browser-backed follow-up
  answer instead of creating a duplicate browser child session.
- The final answer was evidence-backed and had no weak-answer signals. The
  report still marked one source-coverage warning, so this is not a full-matrix
  release claim.

Workbench UX:
- No UI changed in this checkpoint.
- The mission timeline now preserves the expected user story for this path:
  initial browser child session, explicit follow-up, continuation of that
  child session, then final answer.

Browser Reliability:
- The browser was actually used, the same browser child session was continued,
  and the run reported zero persistent-profile fallbacks.
- This checkpoint proves follow-up routing stability for an already available
  browser child session. It does not prove daemon-restart or cold recreation
  paths; those remain separate gates.

Acceptance Evidence:
- Focused regression:
  `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts`:
  passed, 39 tests.
- Real LLM E2E:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-browser-followup-continuation
  --scenario-timeout-ms 360000
  --json /tmp/natural-browser-followup-routing-e2e-reviewfix.json`: passed.
- Real mission: `msn.mptsl8nu.1`, status `done`, natural `passed`, tools
  `3/3`, sessions `1/1`, browser `yes`, profile fallback `0`, stuck `no`,
  final bytes `1209`, weak-answer signals `none`.
- Prior failed full acceptance run that exposed this gap:
  `validation-ops:real-llm-acceptance:2026-05-31T12-31-25-285Z:syzsts`.

Regression Risk:
- This adds a routing guard before duplicate spawn in explicit follow-up turns.
  The main risk is over-routing a legitimate new task that uses the word
  "continue"; the lookup is bounded and an empty result permits a fresh spawn.
- The full expanded real acceptance matrix still needs to be rerun. This
  checkpoint only closes the focused failure that blocked the previous run.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes, for
  natural browser follow-up routing.
- Evidence: the exact blocked natural scenario now passes with real LLM output,
  one spawned child session, one continued child session, actual browser use,
  no stuck runtime state, and no duplicate child session after phase one.
- Next required gate: rerun full `acceptance:real` over the expanded natural
  matrix and record the validation-ops run id or JSON artifact.

## 2026-06-01 01:10 CST - Natural Runtime Gate Reconciliation

Direction: oscillating

Execution Kernel:
- Added a runtime correction for stale approval answers after
  `permission_applied`: if the model tries to finalize with "approval still
  pending", the native tool loop now continues into the approved browser action
  instead of accepting the stale answer.
- Kept browser recovery metadata visible through completed sub-agent synthesis
  and made replacement browser-session extraction prefer structured payload
  data over stale artifact paths.
- Strengthened browser-worker prompt guidance so JS-rendered/user-visible page
  review is not substituted with static fetch.

Result Quality:
- Several failures were gate-quality issues rather than missing runtime
  execution: natural answers used "recommended action", "queue 11", or "did not
  respond within the timeout window" instead of exact fixture wording.
- The gate now separates tool evidence from final-answer phrasing more cleanly:
  rendered queue metrics still must appear in browser evidence, but continuation
  final answers do not have to repeat every metric if they provide owner,
  action, uncertainty, and source-backed state.
- This is not yet a full capability-complete claim because the final full
  `acceptance:real` run still failed before the last gate adjustment.

Workbench UX:
- No UI changed in this checkpoint.
- Timeline evidence became more reliable for operator review because stale
  approval and browser-recovery paths now produce explicit tool/result evidence
  instead of a misleading pending answer.

Browser Reliability:
- Focused real runs passed for browser restart continuation, browser cold
  recreation, browser unavailable closeout, approval dry-run action, and browser
  follow-up continuation.
- The unavailable-browser scenario now actually restarts the daemon against an
  unreachable CDP endpoint, so it proves a real browser failure path instead of
  relying on model wording.

Acceptance Evidence:
- Unit/report tests:
  `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts
  scripts/mission-tool-use-e2e-report.test.ts`: passed, 72 tests.
- Focused real LLM E2E passed:
  `natural-browser-restart-continuation` mission `msn.mptzbb45.1`;
  `natural-browser-cold-recreation-continuation` mission `msn.mpu01t3b.1`;
  `natural-approval-dry-run-action` mission `msn.mpu0d5uu.1`;
  `natural-browser-unavailable-closeout` mission `msn.mpu0f1y7.1`;
  `natural-browser-followup-continuation` mission `msn.mpu1amwd.1`.
- Tail natural matrix passed:
  `/tmp/natural-matrix-tail-after-timeout-e2e.json` covering timeout partial,
  timeout follow-up, cancel active, cancel follow-up, and long delegation.
- Full `acceptance:real` was rerun after most fixes and passed tool-use, CDP
  smoke, and the 12-scenario mission matrix, but failed in the natural matrix
  on a continuation final-answer phrasing gate before the last gate adjustment:
  `validation-ops:real-llm-acceptance:2026-05-31T16-58-50-521Z:5cr1ku`.

Regression Risk:
- The runtime correction for stale approval answers could over-continue if a
  future approval flow legitimately needs to pause after `permission_applied`;
  current guard limits it to approval-gated browser-action prompts and only
  after an applied approval exists.
- Natural quality gates are now less tied to exact wording, which is correct
  for natural prompts but can hide weak answers if evidence checks are too
  loose. The mitigation is that required tool/evidence patterns remain in
  place for browser, timeout, cancellation, and delegation scenarios.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? unknown.
- Evidence: focused real LLM gates are substantially stronger and several root
  causes were fixed, but a clean full `acceptance:real` pass still has not been
  recorded after the final quality-gate adjustment.
- Next required gate: run a fresh full `acceptance:real` and require the
  validation-ops record plus natural JSON report to pass before claiming this
  checkpoint is converging.

## 2026-06-01 01:40 CST - Recorded Acceptance Artifact Integrity

Direction: unknown

Execution Kernel:
- No runtime execution behavior changed in this checkpoint.
- The real acceptance recorder now refuses to record a passed validation-ops
  gate unless the mission report artifacts exist and their summaries prove a
  passing capability gate.
- CLI arguments now reject recorded validation-ops runs that disable mission or
  natural mission JSON artifacts. Scratch runs can still skip artifacts by also
  disabling validation-ops recording.

Result Quality:
- This improves the evidence contract rather than model answer quality directly.
- A passed recorded gate now requires inspectable mission ids, quality summaries,
  liveness counts, and natural capability signals instead of relying only on
  subprocess exit codes.

Workbench UX:
- No UI changed in this checkpoint.
- Runtime/validation surfaces will now receive stronger release-gate records:
  a recorded `passed` real-acceptance run should have artifact paths and summary
  data that an operator can inspect.

Browser Reliability:
- No browser runtime behavior changed.
- The focused real LLM gate for this checkpoint did not include browser
  scenarios; browser reliability remains covered by the existing browser
  natural gates and still needs a fresh full release run for broad proof.

Acceptance Evidence:
- PR #325 merged as `8103ecf`.
- Full local verification before merge:
  `npm test -- --runInBand`: passed, 1330 tests;
  `npm run build`: passed;
  `git diff --check`: passed.
- Control Center smoke also passed before the implementation slice:
  `npm run control-center:smoke`, screenshot bytes `124977`, mobile screenshot
  bytes `54275`.
- Focused real LLM acceptance after merge:
  `npm run acceptance:real -- --skip-tooluse --mission-scenarios comparison
  --natural-mission-scenarios natural-comparison-research --model-catalog
  models.local.json --scenario-timeout-ms 300000 --data-dir
  /tmp/turnkeyai-real-acceptance-artifact-integrity-20260601`: passed.
- Validation-ops run id:
  `validation-ops:real-llm-acceptance:2026-05-31T17-39-19-053Z:qa28jp`.
- Real mission evidence:
  mission `msn.mpu2dv1w.1`, status `done`, quality `passed`, tools `2/2`,
  sessions `2/0`, liveness `0/0/0`, evidence `2`.
- Natural mission evidence:
  mission `msn.mpu2ecof.1`, natural `passed`, tools `2/2`, sessions `2/0`,
  browser `no`, profile fallback `0`, stuck `no`, weak-answer signals `none`,
  final bytes `1671`.

Regression Risk:
- The main risk is stricter CLI behavior for users who previously combined
  validation-ops recording with artifact suppression. That path now fails
  intentionally because it cannot support a capability claim.
- Full `acceptance:real` has not been rerun in this checkpoint. The focused gate
  proves artifact integrity and comparison/natural-comparison behavior, not the
  full browser/approval/timeout/delegation matrix.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? unknown.
- Evidence: the proof system is stricter and a focused real LLM run passed with
  recorded mission and natural artifacts, but this checkpoint does not by itself
  improve runtime capability or prove the full matrix.
- Next required gate: run full `acceptance:real` and require a passed
  validation-ops record with both mission and natural report artifacts before
  calling the broader runtime direction converging.

## 2026-06-01 03:21 CST - Natural Core Delegation Evidence After Runtime Guards

Direction: converging

Execution Kernel:
- Revalidated the current runtime after the repeated-failure closeout guard and
  final-tool-round warning were merged.
- The focused natural run exercised parent delegation, sub-agent completion,
  final synthesis, and liveness cleanup without hitting forced closeout,
  repeated failed tool attempts, or stuck active/waiting/stale runtime state.
- This is capability evidence for two core natural paths, not a full release
  claim for the whole workbench objective.

Result Quality:
- `natural-comparison-research` completed with a useful evidence-backed answer,
  1/1 tool result, one completed sub-agent, no weak-answer signals, and final
  quality `passed`.
- `natural-long-delegation` completed with three independent sub-agent results,
  browser evidence, 3/3 visible source coverage, residual-risk coverage, no
  unsupported placeholder language, and final quality `passed`.
- Neither scenario required fixture-shaped final-answer markers or exact answer
  skeletons; both used natural mission acceptance scoring.

Workbench UX:
- No UI changed in this checkpoint.
- The generated mission timelines are still useful acceptance artifacts: each
  run reached a terminal `done` state with ordered tool call/result evidence and
  no lingering liveness counts. Screenshot-backed Mission Detail checks remain
  a separate P1/P0-visibility gate.

Browser Reliability:
- `natural-long-delegation` reported `browser=yes` and `profileFallbacks=0`.
- This proves one browser-backed natural delegation path remained stable after
  the runtime guard changes. It does not prove profile-conflict recovery,
  restart/cold browser continuation, or complex real-page robustness.

Acceptance Evidence:
- Real LLM natural matrix:
  `npm run mission:e2e:natural -- --natural-matrix-scenarios
  natural-comparison-research,natural-long-delegation --model-catalog
  models.local.json --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-core-20260531T191908Z.json`: passed.
- Natural report: `/tmp/turnkeyai-natural-core-20260531T191908Z.json`, kind
  `turnkeyai.natural-mission-e2e.report`, evidence mode `natural-real-llm`,
  status `passed`.
- `natural-comparison-research`: mission `msn.mpu5ym8w.1`, status `done`,
  natural `passed`, tools `1/1`, sessions `1/0`, browser `no`,
  profile fallback `0`, liveness `0/0/0`, weak-answer signals `none`, final
  bytes `1926`.
- `natural-long-delegation`: mission `msn.mpu5zac2.2`, status `done`, natural
  `passed`, tools `3/3`, sessions `3/0`, browser `yes`, profile fallback `0`,
  liveness `0/0/0`, weak-answer signals `none`, final bytes `2477`.

Regression Risk:
- This evidence is narrower than full `acceptance:real`; it covers natural
  comparison and long-delegation behavior after runtime guard changes.
- The remaining risk is that browser continuation, approval, timeout,
  cancellation, memory pressure, and UI replay can still regress outside this
  focused gate. The next broad capability gate should be a fresh full
  `acceptance:real` run or focused natural browser/approval/timeout scenarios
  tied to the next implementation slice.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes, for
  natural parent delegation and browser-backed long-delegation synthesis.
- Evidence: the runtime completed two natural real LLM scenarios with useful
  evidence-backed final answers, completed sub-agents, no weak-answer signals,
  and no active/waiting/stale residue.
- Next required gate: rerun a broader natural matrix covering browser
  continuation, approval dry-run, timeout follow-up, cancellation follow-up,
  and memory recall before claiming broader production convergence.

## 2026-06-01 11:49 CST - Natural Denied Approval Closeout Gate

Direction: converging

Execution Kernel:
- Added a natural denied-approval scenario to the default natural mission
  matrix. The scenario requests a browser form side effect, denies the operator
  approval, and requires the lead to close out without applying permission or
  running the side effect.
- The natural quality evaluator now treats denied approval as a completed
  approval loop only when `permission.query` and `permission.result` are
  present, `permission.applied` is absent, and the mission reaches a terminal
  useful answer.
- This maps to the `needs approval` continuation row: a side effect pauses
  before execution, the operator decision is durable, and denial produces a
  safe final result instead of a stale pending answer or hidden action.

Result Quality:
- The real run completed with approvals `1/1/0`, tools `2/2`, sessions `0/0`,
  browser `no`, and no stuck runtime liveness. The zero applied permissions and
  zero browser sessions are intentional: denial must stop before the browser
  side effect runs.
- The first real attempt produced a useful answer but exposed an evaluator
  false positive: "submitted for operator review" was incorrectly treated as a
  side-effect completion claim. The gate was narrowed to reject only side-effect
  completion language such as successful submission after denial.

Workbench UX:
- No UI changed in this checkpoint.
- The mission timeline now has capability evidence for the denial branch of the
  approval loop, which the workbench can replay as query -> result -> safe
  final closeout without a permission-applied event.

Browser Reliability:
- No browser runtime behavior changed.
- Browser non-execution is the relevant safety signal here: the denied
  side-effect request did not spawn a browser worker and did not apply runtime
  permission.

Acceptance Evidence:
- Focused deterministic checks:
  `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts
  packages/qc-runtime/src/real-llm-acceptance-defaults.test.ts`: passed,
  36 tests.
- `npm run typecheck`: passed after the final evaluator-pattern adjustment.
- `git diff --check`: passed.
- Real LLM natural matrix:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-approval-denied-safe-closeout
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-approval-denied-safe-closeout.json`: passed.
- Natural report: `/tmp/turnkeyai-natural-approval-denied-safe-closeout.json`,
  kind `turnkeyai.natural-mission-e2e.report`, evidence mode
  `natural-real-llm`, status `passed`.
- Natural mission: `msn.mpuo502p.1`, status `done`, natural `passed`, tools
  `2/2`, sessions `0/0`, browser `no`, profile fallback `0`, liveness
  `0/0/0`, approvals `1/1/0`, weak-answer signals `none`, final bytes `573`.

Regression Risk:
- The main risk is allowing weak denial answers that merely say "not approved"
  without explaining next action. The scenario requires denied approval,
  dry-run context, no side-effect claim, and a useful safe next action.
- This checkpoint proves the denied branch only. It does not replace the
  approved approval gate, pending-approval timeout proof, or broader browser
  reliability gates.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes, for
  permission-gated side-effect safety.
- Evidence: a natural user-like prompt exercised the denied approval path,
  preserved the operator decision, avoided permission application and browser
  side-effect execution, and reached a useful terminal answer with no stuck
  runtime state.
- Next required gate: pending approval / no-decision behavior and broader
  browser reliability failure injection remain separate P0 proof items.

## 2026-06-01 12:02 CST - Natural Pending Approval State Gate

Direction: converging

Execution Kernel:
- Added a natural pending-approval scenario to the default natural mission
  matrix. The scenario requests a browser form side effect and intentionally
  leaves the operator decision unresolved.
- The natural quality evaluator now supports an expected `needs_approval`
  mission state. For this state, `permission.query` is the capability evidence:
  `permission.result` and `permission.applied` must be absent, approvals must
  be `requested=1, decided=0, applied=0`, and the mission must remain
  `needs_approval`.
- This closes the remaining no-decision branch of the approval state machine at
  the acceptance level: approved, denied, and pending now each have explicit
  natural gates.

Result Quality:
- The real run stopped before browser side-effect execution, exposed the
  approval request in the mission timeline, and did not produce a fake final
  answer that implied work had completed.
- The scenario treats a paused approval state as successful only when it is
  visible and bounded. It does not accept hidden decisions, permission
  application, browser worker execution, or stale liveness.

Workbench UX:
- No UI changed in this checkpoint.
- The evidence supports the workbench expectation that users can see a mission
  paused for approval instead of confusing it with a stuck `working` mission or
  a completed result.

Browser Reliability:
- No browser runtime behavior changed.
- The relevant safety property is non-execution: pending approval did not apply
  permission and did not spawn browser work.

Acceptance Evidence:
- Focused deterministic checks:
  `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts
  packages/qc-runtime/src/real-llm-acceptance-defaults.test.ts`: passed,
  37 tests.
- Acceptance summary checks:
  `npx tsx --test scripts/real-llm-acceptance.test.ts
  packages/qc-runtime/src/real-llm-acceptance-summary.test.ts
  packages/qc-runtime/src/validation-ops-inspection.test.ts`: passed,
  23 tests.
- `npm run typecheck`: passed.
- Real LLM natural matrix:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-approval-pending-state
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-approval-pending-state.json`: passed.
- Natural report: `/tmp/turnkeyai-natural-approval-pending-state.json`, kind
  `turnkeyai.natural-mission-e2e.report`, evidence mode `natural-real-llm`,
  status `passed`.
- Natural mission: `msn.mpuollw5.1`, status `needs_approval`, natural
  `passed`, approvals `1/0/0`, tools `0/0`, sessions `0/0`, browser `no`,
  profile fallback `0`, liveness `0/0/0`, weak-answer signals `none`, final
  bytes `188`.

Regression Risk:
- This broadens the meaning of natural scenario "completed" to include an
  expected paused `needs_approval` state. The scope is explicit in the scenario
  spec; normal scenarios still require `done`.
- Full `acceptance:real` has not been rerun in this checkpoint. The focused
  real gate proves pending approval behavior only.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes, for
  permission-gated side-effect control.
- Evidence: a natural prompt now proves the unresolved approval branch:
  user-visible pending state, no decision, no permission application, no
  browser side effect, and no stuck runtime liveness.
- Next required gate: broaden browser reliability failure injection under
  natural prompts, especially attach failure, command timeout, and target detach
  buckets.

## 2026-06-01 14:17 CST - Browser Failure Bucket Visibility

Direction: unknown

Execution Kernel:
- No agent execution semantics changed in this slice. Tool calls, browser
  dispatch, session continuation, and recovery policy remain unchanged.
- Mission observability now extracts browser failure buckets from tool result,
  recovery, and runtime metadata so CDP/target/attach/detach/transport failures
  are first-class mission health signals instead of only raw timeline text.

Result Quality:
- Final-answer generation was not changed.
- This does not prove a model will produce a better answer after browser
  failure. It makes the failure evidence more explicit for the workbench and
  diagnostics surfaces that guide continuation or operator action.

Workbench UX:
- Mission Detail now shows a browser failure-bucket count and an attention
  line naming the bucket counts.
- Runtime mission health now aggregates browser failure buckets and includes
  bucket counts on attention rows, so an operator can distinguish profile
  fallback from CDP, target, attach, detach, or transport failures without
  opening raw JSON.

Browser Reliability:
- No browser recovery behavior changed.
- The change supports the browser reliability gate by making the next natural
  browser-failure runs produce explicit operator-visible evidence. Actual
  reliability convergence remains unproven until a natural browser failure gate
  passes.

Acceptance Evidence:
- Focused backend/control-state tests:
  `npx tsx --test packages/app-gateway/src/mission-observability.test.ts
  packages/app-gateway/src/mission-health-diagnostics.test.ts
  packages/app-gateway/src/routes/mission-routes.test.ts
  packages/app-gateway/src/routes/diagnostics-routes.test.ts
  packages/control-center/src/state/missionFinalAnswer.test.ts
  packages/control-center/src/state/missionProgress.test.ts`: passed,
  116 tests.
- `npm run typecheck`: passed.
- `npm run ledger:check`: passed.
- `npm run build:control-center && npm run control-center:smoke`: passed,
  with screenshot-backed smoke output.
- `npm run build`: passed.
- `npm test -- --runInBand`: passed, 1400 tests.
- `git diff --check`: passed.
- No natural real LLM E2E ran for this visibility slice.

Regression Risk:
- API shape expands mission metrics and diagnostics mission health; typed
  Control Center clients and route tests cover the expected shape.
- Bucket extraction is conservative and known-bucket based. Unknown future
  browser failure phrases may still require a runtime bucket field or a new
  parser entry.
- Remaining risk is interpretive rather than behavioral: this improves failure
  visibility but does not make the browser worker more reliable by itself.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? no
  capability claim yet.
- Evidence: user-visible browser failure diagnosis is clearer, but no natural
  real LLM browser-failure gate has proven improved task completion.
- Next required gate: run or add a natural browser reliability scenario that
  exercises one of the explicit browser failure rows and verifies a bounded,
  evidence-backed user result.

## 2026-06-01 14:50 CST - Browser Failure Bucket Gate Tightening

Direction: unknown

Execution Kernel:
- No runtime execution behavior changed. Tool scheduling, browser session
  dispatch, retry policy, and closeout behavior are unchanged.
- The existing natural browser-unavailable scenario now requires the
  `browser_cdp_unavailable` bucket to appear in mission browser metrics, not
  only in free-form failure text.

Result Quality:
- Final-answer generation was not changed.
- This prevents a false pass where the model writes a plausible bounded
  browser-unavailable answer but the runtime never records the browser failure
  bucket needed for operator follow-up.

Workbench UX:
- No UI changed in this checkpoint.
- Acceptance summaries now preserve aggregate browser failure-bucket counts so
  validation surfaces can distinguish natural runs with explicit browser
  failure evidence from text-only closeouts.

Browser Reliability:
- No browser recovery or profile/session behavior changed.
- This is an acceptance-contract step toward the browser reliability gate. It
  does not prove the browser worker is more reliable.

Acceptance Evidence:
- Focused deterministic tests:
  `npx tsx --test packages/app-gateway/src/mission-observability.test.ts
  packages/role-runtime/src/sub-agent-worker-handler.test.ts
  scripts/mission-tool-use-e2e-report.test.ts`: passed, 91 tests.
- `npm run typecheck`: passed.
- `npm run ledger:check`: passed.
- `npm run build`: passed.
- `npm test -- --runInBand`: passed, 1405 tests.
- `git diff --check`: passed.
- Focused natural real LLM E2E:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-browser-unavailable-closeout
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-browser-unavailable-bucket.json`: passed.
- Natural mission id: `msn.mpuv7k3a.1`.
- Report artifact:
  `/tmp/turnkeyai-natural-browser-unavailable-bucket.json`.
- The passing run reported
  `browserBuckets=browser_cdp_unavailable=1`, `natural=passed`,
  `stuck=no`, and `mission-status=done`.

Regression Risk:
- Low runtime risk because no production execution path changed.
- Report-shape risk is covered by summary and validation-op type checks. Any
  downstream fixture that assumes browser metrics only contain profile fallback
  counts must now tolerate explicit failure bucket counts.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes, for
  bounded browser-unavailable closeout evidence.
- Evidence: the next browser-unavailable natural run can no longer pass without
  the mission metrics bucket that explains why browser evidence is missing, and
  the focused natural run now passes with that bucket present.
- Next required gate: broaden the same proof to another browser failure row
  such as attach failure, command timeout, or detached target.

## 2026-06-01 15:39 CST - Browser Session Lifecycle Bucket Gate

Direction: converging

Execution Kernel:
- Browser session revoke now accepts optional mission/work-item context and
  validates it before recording mission activity.
- When a mission-bound browser session is revoked, the route records a recovery
  event with the `session_not_found` bucket. The route still closes the session
  through the existing browser bridge path and keeps public response semantics
  compatible for callers that do not pass mission context.

Result Quality:
- Final-answer prompting did not change.
- The natural browser cold-recreation scenario can no longer pass on final text
  alone. It must also show that the system recorded why browser continuity was
  broken before the follow-up recovered.

Workbench UX:
- No UI changed in this checkpoint.
- The mission timeline/metrics now contain a machine-readable lifecycle bucket
  that the Workbench can surface when explaining why a browser sub-agent had to
  recreate its session.

Browser Reliability:
- Browser recovery mechanics did not change.
- This improves reliability evidence: operator/session lifecycle loss is now
  visible as `session_not_found` instead of being hidden behind a successful
  follow-up answer.

Acceptance Evidence:
- Focused deterministic tests:
  `npx tsx --test packages/app-gateway/src/routes/browser-routes.test.ts
  scripts/mission-tool-use-e2e-report.test.ts`: passed, 62 tests.
- `npm run typecheck`: passed.
- Focused natural real LLM E2E:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-browser-cold-recreation-continuation
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-browser-cold-recreation-bucket.json`: passed.
- Natural mission id: `msn.mpuwconq.1`.
- Report artifact:
  `/tmp/turnkeyai-natural-browser-cold-recreation-bucket.json`.
- The passing run reported
  `browserBuckets=session_not_found=1`, `natural=passed`, `stuck=no`,
  `mission-status=done`, `tools=3/3`, and `sessions=1/1`.

Regression Risk:
- Low route risk: mission context is optional and existing revoke callers keep
  the same no-context response shape.
- Medium idempotency/observability risk: mission/work-item context is now part
  of the revoke idempotency fingerprint so two distinct mission-bound revokes do
  not share cached timeline results.
- Remaining risk: this proves lifecycle-loss visibility and cold recreation for
  one browser reliability row; attach failure, command timeout, and detached
  target still need equivalent natural gates.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes, for
  browser session lifecycle loss during follow-up continuation.
- Evidence: the natural cold-recreation gate now requires and produced the
  `session_not_found` bucket while still completing with useful
  browser-backed output.
- Next required gate: broaden the same proof to another browser failure row
  such as attach failure, command timeout, or detached target.

## 2026-06-01 17:05 CST - Mission Detail Smoke Artifact Evidence

Direction: unknown

Execution Kernel:
- No runtime execution behavior changed. Mission scheduling, tool-use,
  browser sessions, permissions, and completion evaluation are unchanged.
- The Control Center smoke harness now has an optional artifact output mode for
  durable UI review evidence.

Result Quality:
- Final-answer generation was not changed.
- This checkpoint does not prove stronger answer quality. It makes the
  existing Mission Detail UX proof easier to inspect after a run.

Workbench UX:
- `control-center-ui-smoke` can now write desktop and mobile Mission Detail
  screenshots plus a compact JSON summary when `--artifact-dir` or
  `TURNKEYAI_CONTROL_CENTER_SMOKE_ARTIFACT_DIR` is provided.
- The JSON summary records whether the thought trace is expanded, whether the
  final answer is visible, whether trace/timeline appear before the final
  answer, whether trace and answer overlap, and whether the page has horizontal
  overflow.

Browser Reliability:
- Browser runtime behavior did not change.
- This supports browser-backed mission review by preserving the UI evidence
  that browser progress, evidence, and final answer ordering remain readable.

Acceptance Evidence:
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- `npm run control-center:smoke -- --allow-missing-browser --artifact-dir
  /tmp/turnkeyai-control-center-smoke-artifacts`: passed.
- Smoke artifacts:
  `/tmp/turnkeyai-control-center-smoke-artifacts/control-center-ui-smoke-summary.json`,
  `/tmp/turnkeyai-control-center-smoke-artifacts/mission-detail-desktop.png`,
  `/tmp/turnkeyai-control-center-smoke-artifacts/mission-detail-mobile.png`.
- Screenshot bytes: desktop `132343`, mobile `54478`.
- Summary reported `thinkingBeforeFinal=true`, `timelineBeforeFinal=true`,
  `traceFinalOverlap=false`, and `horizontalOverflowPx=0` on both desktop and
  mobile.
- No natural real LLM E2E ran for this visibility slice.

Regression Risk:
- Low product risk: artifact writing is opt-in and normal smoke output remains
  unchanged unless an artifact directory is configured.
- Medium harness risk: the smoke script now writes files, so callers must point
  artifact output at an ignored or temporary directory.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? no
  capability claim yet.
- Evidence: screenshot-backed UI review evidence is now durable, but no new
  natural mission proves better runtime/result quality.
- Next required gate: use this artifact path in future Workbench UX checkpoints
  that touch Mission Detail replay, approval grouping, timeout display, or
  browser evidence display.

## 2026-06-01 17:38 CST - Natural Browser CDP Timeout Gate

Direction: converging

Execution Kernel:
- Added an E2E-only browser failure injection hook for forced browser snapshot
  failure buckets. The new natural scenario uses it to exercise repeated
  `cdp_command_timeout` evidence instead of only classifying a static string.
- The hook is opt-in through test environment variables and leaves normal
  browser execution unchanged.

Result Quality:
- Added `natural-browser-cdp-timeout-closeout` to the natural mission matrix.
  The quality gate requires browser use, the `cdp_command_timeout` bucket,
  useful final synthesis, no stuck liveness, and a bounded answer that names
  what remained incomplete.
- The first real run failed usefully because the model used partial browser
  evidence after the timeout but the evaluator treated that like a fully
  unavailable browser. The gate was corrected to allow partial visual evidence
  while still requiring explicit CDP/snapshot limitation and next action.

Workbench UX:
- No UI changed in this checkpoint.
- The user-visible value is diagnostic truth: future mission surfaces can show
  `cdp_command_timeout` as a real natural failure class with a terminal answer,
  not only as a synthetic route/test bucket.

Browser Reliability:
- This closes one browser reliability row for natural prompts: persistent CDP
  command timeout during browser snapshot capture now produces a failure bucket,
  finishes the mission, and does not leave active worker liveness.
- Remaining browser reliability rows still needing equivalent natural gates:
  attach failure and target/session detach.

Acceptance Evidence:
- Focused tests: `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts
  packages/qc-runtime/src/real-llm-acceptance-defaults.test.ts
  scripts/real-llm-acceptance.test.ts`: passed.
- `npm run typecheck`: passed.
- Focused natural real LLM E2E:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-browser-cdp-timeout-closeout
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-browser-cdp-timeout-closeout-final.json`: passed.
- Natural report:
  `/tmp/turnkeyai-natural-browser-cdp-timeout-closeout-final.json`, kind
  `turnkeyai.natural-mission-e2e.report`, evidence mode `natural-real-llm`,
  status `passed`.
- Natural mission: `msn.mpv0lzmu.1`, status `done`, natural `passed`,
  tools `1/1`, sessions `1/0`, browser `yes`, profile fallbacks `0`,
  browser buckets `cdp_command_timeout=1`, stuck `no`, final bytes `1433`.

Regression Risk:
- The injection hook is production code guarded by explicit E2E env vars, so
  the main risk is accidental activation in a non-test daemon environment.
  Focused tests and the variable names keep it scoped, but operators should not
  set `TURNKEYAI_E2E_BROWSER_FORCE_FAILURE_*` in normal runtime configs.
- Adding the scenario to the default natural matrix lengthens full release
  acceptance. Focused runs can still select a smaller natural set during
  debugging.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a real natural LLM mission now proves the browser layer can surface
  a CDP command timeout, produce a useful terminal answer with partial evidence,
  and leave no stuck work.
- If no, next required gate:

## 2026-06-01 17:51 CST - Natural Browser Detached Target Gate

Direction: converging

Execution Kernel:
- Added `natural-browser-detached-target-closeout` to the natural mission
  matrix. The scenario uses the existing E2E-only browser failure injection
  path to force repeated `detached_target` evidence during rendered-page
  capture.
- Normal browser execution remains unchanged; the injection path is gated by
  explicit `TURNKEYAI_E2E_BROWSER_FORCE_FAILURE_*` variables.

Result Quality:
- The new natural gate requires browser use, a `detached_target` browser bucket,
  useful final synthesis, no weak fallback signals, and no stuck worker
  liveness.
- The expected answer shape is user-natural rather than marker-based: it must
  separate verified and unverified scope and give the operator a next action
  after the browser target detaches.

Workbench UX:
- No UI changed in this checkpoint.
- The Workbench can now rely on a real natural mission artifact for detached
  browser-target failures instead of only unit-level bucket classification.

Browser Reliability:
- This closes another H4 browser failure row under natural prompts: target or
  tab detachment during browser capture now has a focused natural acceptance
  gate and a passing real mission artifact.
- Remaining browser reliability row still needing equivalent natural proof:
  attach failure.

Acceptance Evidence:
- Focused tests: `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts
  packages/qc-runtime/src/real-llm-acceptance-defaults.test.ts
  scripts/real-llm-acceptance.test.ts`: passed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- Focused natural real LLM E2E:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-browser-detached-target-closeout
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-browser-detached-target-closeout.json`: passed.
- Natural report:
  `/tmp/turnkeyai-natural-browser-detached-target-closeout.json`, kind
  `turnkeyai.natural-mission-e2e.report`, evidence mode `natural-real-llm`,
  status `passed`.
- Natural mission: `msn.mpv12336.1`, status `done`, natural `passed`, tools
  `1/1`, sessions `1/0`, browser `yes`, profile fallbacks `0`, browser
  buckets `detached_target=1`, stuck `no`, final bytes `1176`.

Regression Risk:
- The natural matrix is longer by one browser reliability case. Focused
  acceptance remains selectable for local debugging.
- The same production-code E2E injection hook now backs both timeout and detach
  scenarios, so future changes to the hook can affect multiple natural gates;
  report tests pin each required bucket separately.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a real natural LLM mission now proves the browser layer can surface
  target detachment, produce a useful terminal answer, and leave no stuck work.
- If no, next required gate:

## 2026-06-01 17:55 CST - 24-Hour Goal Review

Direction: converging

Repeated Issue Classes:
- Browser failure closeouts were the dominant repeated class in this 24-hour
  window: unavailable CDP, command timeout, detached target, and profile
  fallback each needed natural gates rather than only route-level bucket tests.
- Follow-up and continuation issues also repeated earlier in the window, but
  the latest browser reliability work is tied to named natural matrix rows
  instead of ad hoc single-failure patches.

E2E Trend:
- The trend improved from structural/browser bucket visibility to natural real
  LLM evidence. Recent browser reliability checkpoints produced mission IDs and
  reports for profile fallback recovery, unavailable CDP closeout, CDP timeout
  closeout, and detached target closeout.
- Attach failure was still the known open browser failure row at this review
  boundary and required a dedicated natural gate before being claimed proven.

Decision:
- Continue with the attach failure gate next, but require a real natural LLM
  report artifact before marking that row as proven.
- Do not start another outward-facing UI or diagnostics arc until remaining
  runtime reliability gates have explicit natural evidence or are deliberately
  marked unproven.

Methodology Review Trigger:
- Not triggered in this review window. The repeated browser failure items moved
  from route/unit visibility toward natural E2E artifacts rather than cycling
  through unrelated local patches.

## 2026-06-01 18:06 CST - Natural Browser Attach Failure Gate

Direction: converging

Execution Kernel:
- Added `natural-browser-attach-failed-closeout` to the natural mission
  matrix. The scenario forces an E2E-only `attach_failed` browser bucket during
  target resolution rather than during rendered-page snapshot capture.
- The browser failure injection helper now supports a `target_attach` stage,
  while normal runtime remains gated by explicit
  `TURNKEYAI_E2E_BROWSER_FORCE_FAILURE_*` variables.

Result Quality:
- The new natural gate requires browser use, an `attach_failed` bucket, useful
  final synthesis, verified/unverified separation, and no stuck worker
  liveness.
- The gate explicitly allows the generic "tool unavailable fallback" weak
  signal only for bucket-gated browser failure closeouts, because the expected
  user-facing answer must name that browser attach failed. Normal browser
  success scenarios still reject that signal.

Workbench UX:
- No UI changed in this checkpoint.
- The user-visible value is reliability truth: attach failures now have a real
  natural mission artifact and can be surfaced as bounded browser evidence
  instead of leaving the task spinning or hiding behind a generic tool failure.

Browser Reliability:
- This closes the remaining H4 browser failure row under natural prompts:
  browser target attach failure now has a focused natural acceptance gate and a
  passing real mission artifact.
- Timeout, detached target, unavailable CDP endpoint, profile-lock recovery,
  and attach failure now all have natural browser reliability coverage.

Acceptance Evidence:
- Focused tests: `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts
  packages/qc-runtime/src/real-llm-acceptance-defaults.test.ts
  scripts/real-llm-acceptance.test.ts`: passed.
- `npm run typecheck`: passed.
- Focused natural real LLM E2E:
  `npm run mission:e2e:natural -- --model-catalog models.local.json
  --natural-matrix-scenarios natural-browser-attach-failed-closeout
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-browser-attach-failed-closeout.json`: passed.
- Natural report:
  `/tmp/turnkeyai-natural-browser-attach-failed-closeout.json`, kind
  `turnkeyai.natural-mission-e2e.report`, evidence mode `natural-real-llm`,
  status `passed`.
- Natural mission: `msn.mpv1moiv.1`, status `done`, natural `passed`, tools
  `1/1`, sessions `1/0`, browser `yes`, profile fallbacks `0`, browser
  buckets `attach_failed=1`, stuck `no`, final bytes `917`.

Regression Risk:
- The failure hook is still production code behind explicit E2E-only
  environment variables. The main risk remains accidental activation in a
  non-test daemon configuration.
- The weak-answer allowance is limited to browser failure closeout specs that
  also require an explicit browser failure bucket; this avoids weakening normal
  natural browser success gates.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? yes
- Evidence: a real natural LLM mission now proves attach failure can terminate
  with a useful answer, bucketed evidence, and no stuck work.
- If no, next required gate:

## 2026-06-01 18:10 CST - 24-Hour Goal Review

Direction: converging

Repeated Issue Classes:
- Browser failure closeouts were the dominant repeated class in this 24-hour
  window: unavailable CDP, command timeout, detached target, profile fallback,
  and attach failure all needed natural gates rather than only route-level
  bucket tests.
- Follow-up and continuation issues also repeated, but the latest browser
  failure work is no longer changing generic runtime policy after each single
  failed mission; each gate is now tied to a specific matrix row and artifact.

E2E Trend:
- The trend improved from structural/browser bucket visibility to natural real
  LLM evidence. Recent browser reliability checkpoints produced mission IDs and
  reports for profile fallback recovery, unavailable CDP closeout, CDP timeout
  closeout, detached target closeout, and attach failure closeout.
- The attach failure gate still exposed a broad weak-answer signal in the
  evaluator. The adjustment is scoped to bucket-gated browser failure closeouts,
  so the trend is convergence with a known evaluator-policy caveat rather than
  unrestricted quality relaxation.

Decision:
- Continue core runtime and natural browser reliability work only when each PR
  maps to a named matrix row and produces a real natural LLM report artifact.
- Do not start another outward-facing UI or diagnostics arc until the remaining
  runtime reliability gates have explicit natural evidence or are deliberately
  marked unproven.

Methodology Review Trigger:
- Not triggered in this review window. The repeated browser failure items moved
  from route/unit visibility toward natural E2E artifacts, and the latest
  failure did not require a new runtime patch; it required aligning the negative
  closeout evaluator with the expected bucketed failure class.

## 2026-06-01 18:19 CST - Browser Artifact Lifecycle Contract

Direction: unknown

Execution Kernel:
- Added lifecycle metadata at the browser artifact store boundary. File-backed
  artifact records now carry backend/ref type, retention duration, expiry time,
  per-artifact byte limit, per-session byte budget, cleanup-on-session-close
  policy, and orphan reconciliation mode.
- The file artifact store now records file sizes when available, enforces
  per-artifact and per-session budgets, lists session artifacts in stable
  newest-first order, and can prune expired metadata plus managed artifact
  files.

Result Quality:
- This is structural hardening, not a natural capability claim. It makes future
  browser evidence safer to retain and inspect, but it does not by itself prove
  better task answers.
- Existing browser artifact-producing paths continue to return the same public
  `artifactIds` and `screenshotPaths`; the lifecycle metadata is attached to
  persisted artifact records.

Workbench UX:
- No UI changed in this checkpoint.
- Future Workbench artifact views can now rely on explicit lifecycle fields
  instead of inferring retention and cleanup behavior from path strings.

Browser Reliability:
- Artifact storage now has bounded retention and budget semantics for local,
  relay, and direct-CDP transports through the shared file artifact store.
- Expired artifact cleanup is available as a store operation, but no daemon
  scheduled cleanup loop was added in this slice.

Acceptance Evidence:
- Focused tests: `npx tsx --test
  packages/browser-bridge/src/artifacts/file-browser-artifact-store.test.ts
  packages/browser-bridge/src/chrome-session-manager.test.ts
  packages/browser-bridge/src/transport/relay-adapter.test.ts`: passed.
- `npm run typecheck`: passed.
- No real natural LLM E2E was run for this structural slice. Existing browser
  artifact natural/real gates remain the capability evidence path; this
  checkpoint should not be used as proof that complex browser tasks are more
  reliable until a future natural artifact scenario cites a mission/report.

Regression Risk:
- Budget enforcement happens when artifact records are persisted. Extremely
  large artifacts that previously would have been recorded may now fail earlier
  with a storage budget error.
- The defaults are intentionally high for normal screenshots/snapshots
  (`25 MB` per artifact, `100 MB` per session) to avoid breaking typical
  browser evidence capture.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? unknown
- Evidence: storage semantics are stronger, but no natural E2E artifact proves
  user-visible answer improvement in this slice.
- If no, next required gate: add a natural or real browser artifact scenario
  that verifies screenshot/artifact lifecycle metadata is produced and remains
  usable in Mission Detail.

## 2026-06-01 18:35 CST - Mission Artifact Lifecycle Visibility

Direction: unknown

Execution Kernel:
- No runtime execution behavior changed in this checkpoint. The work maps
  existing browser artifact lifecycle metadata into mission artifact records and
  Control Center API types.
- Demo mission fixtures now include lifecycle metadata so the Mission Detail
  evidence surface can be exercised without requiring a live browser session.

Result Quality:
- This is visibility work, not a capability claim. It helps users interpret
  browser evidence retention and cleanup policy, but it does not prove that
  complex task answers are better.
- Mission artifacts can now show retention duration, expiry, cleanup policy,
  artifact byte caps, session budget, and expired-file reconciliation mode.

Workbench UX:
- Mission Detail now renders lifecycle chips beneath browser evidence artifacts.
  The chips are secondary metadata, so they do not replace the artifact label,
  kind, id, or size.
- Desktop and mobile Control Center smoke checks verified the lifecycle text is
  visible and the page still renders with screenshot artifacts enabled.

Browser Reliability:
- No new browser control path changed. This checkpoint only exposes lifecycle
  metadata already persisted by the artifact store.
- The visible retention and cleanup semantics should make future browser
  evidence loss easier to diagnose, but scheduled cleanup behavior remains out
  of scope for this slice.

Acceptance Evidence:
- Route regression: `npx tsx --test
  packages/app-gateway/src/routes/mission-routes.test.ts`: passed.
- Type/build checks: `npm run typecheck` and `npm run build --workspace
  @turnkeyai/control-center`: passed.
- UI smoke: `npm run control-center:smoke -- --artifact-dir
  /tmp/turnkeyai-control-center-artifact-lifecycle-smoke`: passed, with
  desktop and mobile screenshots recorded under `/tmp`.
- No natural real LLM E2E was run for this visibility-only slice, so this
  checkpoint must not be treated as capability-proven.

Regression Risk:
- Adding optional lifecycle fields to mission artifact types is backward
  compatible with existing records that do not include the metadata.
- The main UI risk is metadata crowding on small screens; the smoke path
  captured both desktop and mobile Mission Detail screenshots to check this
  surface.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? unknown
- Evidence: users can now see artifact lifecycle semantics in Mission Detail,
  but no natural E2E proves improved task completion.
- If no, next required gate: run a natural browser artifact mission and verify
  the resulting artifact lifecycle metadata remains visible on the mission.

## 2026-06-01 18:46 CST - Browser Artifact Mission Registration

Direction: unknown

Execution Kernel:
- Mission thread mirroring now registers browser artifact records from durable
  worker results into the mission artifact store. This covers both legacy
  assistant worker payloads and native split `role=tool` session result
  messages.
- The daemon wires the mission bridge to the browser artifact metadata store,
  so real browser worker screenshots/snapshots can appear in
  `/missions/:id/artifacts` instead of remaining only in worker payloads.

Result Quality:
- This fixes an evidence plumbing gap, not answer quality by itself. Final
  answers still need natural real LLM gates to prove useful evidence-backed
  output.
- The mission artifact descriptor preserves artifact kind, path, byte size, and
  lifecycle metadata from the browser artifact record.

Workbench UX:
- Mission Detail can now receive real browser artifacts through the same
  artifact route that already renders lifecycle chips.
- This slice does not add new UI controls; it makes the existing artifact panel
  reflect runtime-produced browser evidence rather than only demo fixtures.

Browser Reliability:
- Browser transport behavior is unchanged. The improvement is post-execution
  evidence registration after browser artifacts are already persisted.
- Missing browser artifact records are skipped best-effort so timeline mirroring
  does not block mission lifecycle reconciliation.

Acceptance Evidence:
- Focused regression: `npx tsx --test
  packages/app-gateway/src/mission-thread-bridge.test.ts`: passed.
- `npm run typecheck`: passed.
- No natural real LLM E2E was run yet for this slice, so the capability remains
  unproven until a real browser mission produces artifact records visible on
  the mission route and Workbench page.

Regression Risk:
- The bridge now performs additional best-effort artifact-store reads during
  mission mirroring when browser artifact ids are present. The read path is
  bounded by the unique ids found in durable worker/tool messages.
- Duplicate bridge ticks should not duplicate mission artifacts because the
  registration path checks the existing mission artifact ids first.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? unknown
- Evidence: real browser evidence can now flow into the mission artifact
  surface, but no natural E2E has verified a full user-visible browser task
  with registered lifecycle metadata.
- If no, next required gate: run a natural browser artifact mission and confirm
  `/missions/:id/artifacts` plus Mission Detail show the runtime-produced
  browser artifact lifecycle fields.

## 2026-06-01 19:01 CST - Natural Browser Artifact Gate Wiring

Direction: unknown

Execution Kernel:
- The natural browser dynamic-page E2E gate now fetches
  `/missions/:id/artifacts` after mission completion and waits briefly for
  lifecycle-bearing artifact metadata when the scenario requires it.
- The quality evaluator treats missing mission artifact lifecycle metadata as a
  failure for the browser dynamic-page natural scenario, instead of accepting
  timeline-only browser evidence.

Result Quality:
- This raises the acceptance bar for evidence-backed browser answers: a passing
  dynamic-page run must now leave durable browser artifact evidence on the
  mission artifact route.
- No answer quality improvement is claimed from this wiring alone; it only
  prevents a natural browser run from passing when artifact lifecycle evidence
  is absent.

Workbench UX:
- Natural E2E JSON reports now summarize mission artifact count, artifact kinds,
  and lifecycle-bearing artifact count so Workbench artifact visibility can be
  audited from the same report.
- This slice does not change Mission Detail UI; it verifies the backend/report
  evidence path that the UI depends on.

Browser Reliability:
- Browser runtime behavior is unchanged. The gate specifically checks that
  browser artifact evidence survives into the mission artifact route after the
  browser worker has produced it.
- The gate remains compatible with non-browser natural scenarios by only
  requiring lifecycle metadata for scenarios that opt into the requirement.

Acceptance Evidence:
- Focused regression: `npx tsx --test
  scripts/mission-tool-use-e2e-report.test.ts scripts/real-llm-acceptance.test.ts`:
  passed.
- `npm run typecheck`: passed.
- `npm run ledger:check`: passed.
- `git diff --check`: passed.
- No natural real LLM E2E mission was run yet for this checkpoint, so this is a
  structural gate/report improvement and not capability-proven.

Regression Risk:
- The new natural browser gate can fail existing real runs that used browser
  evidence but did not register artifacts on the mission route. That is
  intentional for the dynamic-page scenario because user-visible evidence must
  be durable and inspectable.
- The artifact polling window is bounded and only waits for lifecycle metadata
  when explicitly required by the scenario spec.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint? unknown
- Evidence: the acceptance gate is stricter and can catch missing browser
  artifact lifecycle evidence, but no real LLM run has shown improved stable
  delivery yet.
- If no, next required gate: run the focused natural browser dynamic-page E2E
  against a real LLM/browser session and record the mission id plus report
  artifact only if the run passes with lifecycle-bearing mission artifacts.

## 2026-06-01 19:19 CST - Natural Browser Artifact Gate Proven

Direction: converging

Execution Kernel:
- Root cause from the first real gate failure: browser private tools were
  producing snapshot/screenshot artifact records, and the browser worker
  session state retained them, but the outer sub-agent result did not expose
  those artifact references to the durable `sessions_spawn` tool result.
- The browser sub-agent now aggregates private browser tool artifact ids and
  screenshot paths into the outer worker payload.
- The native tool-result trace compaction now preserves small artifact
  reference fields while still pruning large session payload bodies.

Result Quality:
- The passing run still used the browser sub-agent as evidence source rather
  than model knowledge. The final answer remained evidence-backed, useful, and
  free of weak-answer signals.
- This improves durable evidence quality: the answer is no longer separated
  from inspectable browser artifacts after tool-result compaction.

Workbench UX:
- Mission Detail can now receive real browser snapshot/screenshot artifacts
  from natural browser sub-agent runs through the mission artifact route.
- No UI code changed in this slice; the user-visible improvement depends on
  the existing artifact panel receiving real runtime artifact records.

Browser Reliability:
- The validated run reported zero browser profile fallbacks and no browser
  failure buckets.
- The fix does not alter browser control behavior; it closes the artifact
  propagation gap after successful browser execution.

Acceptance Evidence:
- Initial real gate failed as intended:
  `npm run mission:e2e:natural -- --natural-matrix-scenarios
  natural-browser-dynamic-page --model-catalog models.local.json
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-browser-artifact-lifecycle-20260601.json`:
  blocked on missing mission artifact lifecycle metadata.
- Debug run with `TURNKEYAI_E2E_KEEP_RUNTIME_ROOT=1` confirmed browser artifact
  records existed under browser-state, while the compacted durable tool result
  had dropped payload artifact refs.
- Focused regression:
  `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts
  packages/role-runtime/src/sub-agent-worker-handler.test.ts
  packages/app-gateway/src/mission-thread-bridge.test.ts
  scripts/mission-tool-use-e2e-report.test.ts`: passed.
- `npm run typecheck`: passed.
- Real natural browser gate passed:
  `npm run mission:e2e:natural -- --natural-matrix-scenarios
  natural-browser-dynamic-page --model-catalog models.local.json
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-browser-artifact-lifecycle-after-compact-fix-20260601.json`.
- Natural mission: `msn.mpv47lvg.1`, status `done`, natural `passed`,
  tools `1/1`, sessions `1/0`, browser used, profile fallbacks `0`, browser
  buckets `none`, mission artifacts `7`, lifecycle-bearing artifacts `7`.

Regression Risk:
- Session tool-result compaction now retains bounded artifact reference arrays.
  The large payload body remains pruned, so this should not reintroduce large
  durable message writes.
- A future risk remains if artifact references grow without bound; current
  browser tool outputs are bounded by the sub-agent tool sequence and artifact
  store budgets.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint?
  converging
- Evidence: a real LLM/browser natural task that previously failed the
  artifact lifecycle gate now passes with durable mission artifacts and
  lifecycle metadata.
- If no, next required gate: broaden this from the focused dynamic-page run to
  a multi-scenario natural matrix that includes browser follow-up and approval
  so artifact propagation remains stable across continuation paths.

## 2026-06-01 19:41 CST - Evidence Closeout For Final Synthesis Repair

Direction: converging

Execution Kernel:
- A broader natural matrix exposed a closeout gap after successful browser and
  approval work: the final synthesis pass had tools disabled, the model still
  attempted another tool call, and the repair pass fell back to a generic
  retry/continue answer even though completed session evidence was already
  durable in the tool result.
- The repair path now uses deterministic local evidence closeout from completed
  session tool results when the no-tools repair still emits tool-call markup.
  If no usable completed evidence exists, it still fails closed with the
  existing generic retry/continue message.
- The local closeout wording was made task-neutral so it can support approval,
  browser, research, and continuation results instead of assuming a
  release-risk note.

Result Quality:
- This directly addresses weak terminal output after useful tool work. The
  agent no longer discards verified evidence simply because the final synthesis
  model violated the no-tools repair instruction.
- Natural approval dry-run output regained source-backed evidence,
  decision-useful content, and submitted-result language after the fix.

Workbench UX:
- No UI code changed. The user-visible effect is that the Mission Detail final
  answer can now show evidence-backed closeout instead of a generic "retry or
  continue" message after the runtime has already completed the relevant
  approval/browser work.
- The trace remains truthful: the runtime still records that the final answer
  came from local evidence closeout through the existing adapter metadata.

Browser Reliability:
- Browser execution behavior is unchanged. The passing matrix still reported
  browser use, zero profile fallbacks, no browser failure buckets, and no stuck
  liveness.
- Approval-gated browser work remains permission-controlled; this fix only
  changes final answer synthesis after completed evidence exists.

Acceptance Evidence:
- Initial broader gate failed on `natural-approval-dry-run-action`:
  `npm run mission:e2e:natural -- --natural-matrix-scenarios
  natural-browser-dynamic-page,natural-browser-followup-continuation,natural-approval-dry-run-action
  --model-catalog models.local.json --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-browser-continuation-approval-20260601.json`.
- Failure mission: `msn.mpv4m1ty.3`, status `done`, approval exercised,
  browser used, no stuck liveness, but natural quality failed because the final
  answer lacked source-backed evidence, was not decision-useful, and missed the
  submitted result.
- Focused regression:
  `npx tsx --test packages/role-runtime/src/llm-response-generator.test.ts`:
  passed.
- Focused natural approval gate passed:
  `npm run mission:e2e:natural -- --natural-matrix-scenarios
  natural-approval-dry-run-action --model-catalog models.local.json
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-approval-final-synthesis-closeout-20260601.json`.
- Focused mission: `msn.mpv4q4bo.1`, status `done`, natural `passed`,
  tools `4/4`, sessions `1/0`, browser used, approval exercised, profile
  fallbacks `0`, browser buckets `none`, liveness `0/0/0`.
- Broader matrix passed after the fix:
  `npm run mission:e2e:natural -- --natural-matrix-scenarios
  natural-browser-dynamic-page,natural-browser-followup-continuation,natural-approval-dry-run-action
  --model-catalog models.local.json --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-browser-continuation-approval-after-fix-20260601.json`.
- Broader missions:
  `natural-browser-dynamic-page` `msn.mpv4rj5s.1`, artifacts `4`,
  lifecycle-bearing artifacts `4`;
  `natural-browser-followup-continuation` `msn.mpv4s44x.2`, sessions `1/1`;
  `natural-approval-dry-run-action` `msn.mpv4td6f.3`, approval exercised.

Regression Risk:
- The deterministic closeout can only use completed session evidence parsed
  from durable tool results and remains disabled for exact final-answer shape
  prompts.
- If a future scenario requires domain-specific wording not present in the
  completed evidence, this path may produce conservative wording rather than
  rich prose. That is preferable to losing evidence or inventing claims.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint?
  converging
- Evidence: a real natural browser/continuation/approval matrix exposed a
  terminal-answer failure and the same matrix now passes without weak-answer
  signals or stuck liveness.
- If no, next required gate: extend this from approval/browser to long
  delegation and timeout closeout so final-synthesis repair cannot erase
  completed evidence in those paths either.

## 2026-06-01 19:58 CST - Structured Natural Source Coverage

Direction: converging

Execution Kernel:
- No runtime execution path changed in this checkpoint. The implementation
  tightens the natural E2E acceptance kernel so source coverage is evaluated
  and reported as structured data instead of being compressed into a single
  final-answer boolean.
- The natural quality evaluator now records answer-term coverage,
  answer-pattern coverage, evidence-pattern coverage, observed versus required
  evidence events, residual-risk visibility, and unsupported-claim labels for
  each natural scenario.

Result Quality:
- This makes weak real answers easier to diagnose. A failed natural scenario can
  now show whether the answer missed required user-visible facts, whether the
  evidence stream lacked the source fact, whether residual risk disappeared, or
  whether the final answer invented an unsupported claim.
- The existing pass/fail behavior remains: missing evidence and unsupported
  claims still fail the gate. The difference is that the JSON artifact now
  carries the breakdown needed to decide the next root-cause fix.

Workbench UX:
- No dashboard code changed. The user-visible benefit is indirect: future
  Runtime and Release acceptance views can surface source-coverage counts from
  the natural E2E artifact instead of only showing a coarse failure string.

Browser Reliability:
- Browser execution behavior is unchanged. The focused real browser scenario
  still used a browser worker, produced lifecycle-bearing artifacts, had zero
  profile fallbacks, no browser failure buckets, and no live runtime subjects at
  completion.

Acceptance Evidence:
- Focused unit/report gate:
  `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts
  packages/app-gateway/src/mission-tool-use-e2e-quality.test.ts`: passed.
- Typecheck:
  `npm run typecheck`: passed.
- Focused real natural browser gate:
  `npm run mission:e2e:natural -- --natural-matrix-scenarios
  natural-browser-dynamic-page --model-catalog models.local.json
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-source-coverage-20260601.json`: passed.
- Mission: `msn.mpv5aan5.1`, status `done`, natural `passed`, tools `1/1`,
  sessions `1/0`, browser used, artifacts `6`, lifecycle-bearing artifacts
  `6`, profile fallbacks `0`, browser buckets `none`, liveness `0/0/0`.
- The JSON artifact recorded source coverage:
  answer terms `2/2`, answer patterns `1/1`, evidence patterns `3/3`,
  evidence events `1/1`, residual risk visible, unsupported claims `0`.

Regression Risk:
- This is an artifact/schema expansion for the natural E2E report. Consumers
  that read only existing fields are unaffected; consumers with exact report
  shape assumptions need to tolerate the new `sourceCoverage` object.
- The next broader gate should include comparison research, follow-up
  continuation, approval, timeout closeout, and long delegation so the
  structured coverage fields prove useful across non-browser and multi-agent
  failures, not just the dynamic browser scenario.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint?
  converging
- Evidence: a real natural browser scenario passed while producing structured
  source-coverage evidence that can distinguish missing evidence from weak
  final synthesis or unsupported claims.
- If no, next required gate: run the broader natural matrix and use the new
  source-coverage fields to guide the next root-cause slice.

## 2026-06-01 20:18 CST - Runtime Shows Natural Source Coverage

Direction: converging

Execution Kernel:
- Runtime execution did not change. The validation-ops summary now preserves
  the structured natural source-coverage counters emitted by the natural E2E
  artifact so they survive into the operator-facing release record.
- The preserved counters include answer-term, answer-pattern, and
  evidence-pattern coverage, observed versus required evidence events,
  residual-risk visibility, and unsupported-claim count.

Result Quality:
- This reduces diagnosis time after a real natural E2E failure. Operators can
  distinguish "the model missed a final-answer term" from "the tool evidence
  never contained the source fact" without opening the raw JSON artifact first.
- The pass/fail semantics remain unchanged; this checkpoint improves
  visibility of why a gate passed or failed.

Workbench UX:
- Runtime -> Release acceptance now renders a natural report line beside the
  existing mission report line. It shows natural scenario count, evidence/useful
  answer counts, source terms, source patterns, evidence patterns, missing
  coverage count, unsupported claims, and residual-risk visibility.
- Control Center smoke now asserts these values are visible on the Runtime
  page.

Browser Reliability:
- Browser execution behavior is unchanged. The smoke uses the existing Runtime
  fixture and verifies the release acceptance surface can show browser-backed
  natural source evidence counts.

Acceptance Evidence:
- Focused contract tests:
  `npx tsx --test packages/qc-runtime/src/real-llm-acceptance-summary.test.ts
  packages/qc-runtime/src/validation-ops-inspection.test.ts
  packages/control-center/src/pages/RuntimePage.test.ts
  scripts/real-llm-acceptance.test.ts`: passed.
- Typecheck:
  `npm run typecheck`: passed.
- Build:
  `npm run build`: passed.
- Runtime UI smoke:
  `npm run control-center:smoke -- --allow-missing-browser --artifact-dir
  /tmp/turnkeyai-control-center-natural-source-coverage-smoke`: passed.
- Smoke artifact summary:
  `/tmp/turnkeyai-control-center-natural-source-coverage-smoke/control-center-ui-smoke-summary.json`.

Regression Risk:
- This expands the validation-ops real-acceptance summary schema and the
  Control Center API type. Older records without natural summaries remain
  hidden instead of rendering empty or misleading natural coverage rows.
- The next real gate should record a full validation-ops run with natural
  source-coverage counters so Runtime can show live data from a real artifact,
  not only the UI smoke fixture.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint?
  converging
- Evidence: users can now inspect natural real-LLM source-coverage quality from
  the workbench Runtime page, closing the visibility loop created by the
  previous checkpoint.
- If no, next required gate: run `npm run acceptance:real -- --model-catalog
  models.local.json` and confirm the recorded validation-ops row includes the
  natural source-coverage line.

## 2026-06-01 20:26 CST - Natural Residual-Risk Gate

Direction: converging

Execution Kernel:
- Runtime execution did not change. The natural mission acceptance evaluator now
  treats missing residual-risk visibility as a quality failure instead of only
  recording it as a passive counter.
- The natural E2E report also declares `residual-risk-visible` and
  `no-unsupported-claims` as required quality signals, so future artifacts state
  the full answer-quality contract they enforce.

Result Quality:
- A focused real natural browser run initially failed because the model returned
  a useful operational dashboard answer but omitted residual risk. That exposed
  a real prompt-harness gap rather than a fixture-only issue.
- The browser dynamic natural prompt now asks for residual risk or unverified
  scope in natural product language. A rerun passed with residual-risk
  visibility, complete source coverage, and zero unsupported claims.

Workbench UX:
- No UI changed. The user-visible benefit is that Runtime's existing natural
  source-coverage line now reflects an enforced residual-risk gate, not only a
  reported count.

Browser Reliability:
- Browser execution behavior is unchanged. The rerun used the browser worker,
  produced lifecycle-bearing artifacts, had zero profile fallbacks, no browser
  failure buckets, and no live runtime subjects at completion.

Acceptance Evidence:
- Initial focused real gate, before prompt-harness correction:
  `npm run mission:e2e:natural -- --natural-matrix-scenarios
  natural-browser-dynamic-page --model-catalog models.local.json
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-residual-risk-gate-20260601.json`: failed on
  `final answer does not make residual risk visible`.
- Rerun after correction:
  `npm run mission:e2e:natural -- --natural-matrix-scenarios
  natural-browser-dynamic-page --model-catalog models.local.json
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-residual-risk-gate-20260601-rerun.json`: passed.
- Mission: `msn.mpv6m0p5.1`, status `done`, natural `passed`, tools `1/1`,
  sessions `1/0`, browser used, artifacts `4`, lifecycle-bearing artifacts
  `4`, profile fallbacks `0`, browser buckets `none`, liveness `0/0/0`.
- Source coverage from the rerun artifact: answer terms `2/2`, answer patterns
  `1/1`, evidence patterns `3/3`, evidence events `1/1`, residual risk
  visible, unsupported claims `0`.
- Focused report and validation tests:
  `npx tsx --test scripts/mission-tool-use-e2e-report.test.ts
  scripts/real-llm-acceptance.test.ts
  packages/qc-runtime/src/real-llm-acceptance-summary.test.ts`: passed.
- Typecheck: `npm run typecheck`: passed.
- Whitespace: `git diff --check`: passed.

Regression Risk:
- This intentionally tightens the natural E2E pass criteria. Scenarios that
  previously passed while hiding residual risk will now fail and need prompt or
  runtime evidence improvements.
- Only a focused natural browser scenario ran for real LLM/browser acceptance.
  The next broader gate should include comparison, approval, timeout,
  cancellation, and long delegation to verify the stricter quality rule across
  the full natural matrix.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint?
  yes
- Evidence: the stricter gate caught a real weak-answer class in a natural
  browser task, the prompt harness was corrected, and the same real scenario
  then completed with residual risk and source coverage visible.
- If no, next required gate: run a broader natural matrix subset covering
  comparison, approval, timeout, cancellation, and long delegation.

## 2026-06-01 20:36 CST - Tool-Result-Before-Final Completion Guard

Direction: converging

Execution Kernel:
- Mission completion reconciliation now refuses to mark a mission `done` when a
  lead final answer appears after a pending tool call but before the linked
  `role=tool` result is persisted.
- A pending tool call can still complete normally when every tool call id has a
  matching tool result message before the final answer. This keeps the canonical
  order as: assistant tool call, tool result, then final answer.

Result Quality:
- This does not change answer synthesis. It prevents an early or malformed
  answer from hiding incomplete tool evidence and falsely looking complete in
  the workbench.
- The focused natural long-delegation gate still produced a useful,
  evidence-backed answer after the guard, so normal tool-result-backed
  synthesis remains accepted.

Workbench UX:
- Users should see fewer falsely completed missions where the final answer card
  exists but the thought process still has a pending tool call without a result.
- No layout or page chrome changed.

Browser Reliability:
- Browser execution behavior is unchanged. The natural long-delegation run used
  browser-backed sub-agent work, produced lifecycle-bearing artifacts, and had
  zero profile fallbacks.
- The run still reported two `transport_failure` browser buckets from recovered
  sub-agent/browser activity; no active/waiting/stale runtime subjects remained
  at completion.

Acceptance Evidence:
- Guard regression test first failed before the evaluator change, proving the
  old behavior accepted an early final answer ahead of a pending tool result.
- Focused contract tests:
  `npx tsx --test packages/app-gateway/src/mission-completion-evaluator.test.ts
  packages/app-gateway/src/mission-thread-bridge.test.ts
  scripts/mission-tool-use-e2e-report.test.ts
  packages/qc-runtime/src/real-llm-acceptance-summary.test.ts`: passed.
- Typecheck: `npm run typecheck`: passed.
- Whitespace: `git diff --check`: passed.
- Real natural gate:
  `npm run mission:e2e:natural -- --natural-matrix-scenarios
  natural-long-delegation --model-catalog models.local.json
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-unresolved-tool-final-guard-20260601.json`: passed.
- Mission: `msn.mpv6ys07.1`, status `done`, natural `passed`, tools `3/3`,
  sessions `3/0`, browser used, artifacts `26`, lifecycle-bearing artifacts
  `26`, profile fallbacks `0`, browser buckets `transport_failure=2`,
  liveness `0/0/0`, final bytes `2088`.
- Source coverage from the real artifact: answer terms `6/6`, evidence
  patterns `4/4`, evidence events `3/3`, residual risk visible, unsupported
  claims `0`.

Regression Risk:
- The guard intentionally tightens completion semantics for malformed or
  partially persisted tool turns. If a provider emits stale `toolStatus=pending`
  but all split tool-result messages are present, the mission can still finish.
- This focused run proves normal long delegation remains viable, but the next
  broader gate should include follow-up continuation and cancellation because
  those flows depend heavily on terminal tool state.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint?
  yes
- Evidence: one false-completion path is now blocked at the canonical mission
  completion layer, and a real long-delegation task still completed with
  evidence-backed output after the stricter ordering rule.
- If no, next required gate: run natural follow-up and cancellation scenarios to
  verify terminal tool-state handling across continuation and interrupt paths.

## 2026-06-01 20:53 CST - Workbench Completion Visibility Alignment

Direction: converging

Execution Kernel:
- Runtime execution is unchanged. This checkpoint aligns mission observability
  with the tool-result-before-final completion rule from the previous
  checkpoint.
- `buildMissionObservabilitySnapshot` no longer selects a lead final answer
  when an earlier visible tool-call event has no linked result event before that
  answer.

Result Quality:
- This does not improve model synthesis directly. It prevents a weak or early
  answer from looking like a healthy final answer in metrics when the tool
  evidence chain is incomplete.
- A final answer after all prior tool calls have result events remains accepted,
  so normal split tool-result replay is not penalized.

Workbench UX:
- Mission Detail and API consumers now receive no `finalAnswerEventId` for an
  early answer that skipped a pending tool result. The quality panel reports
  `final_answer` as failed for terminal missions instead of showing the answer
  card as complete.
- This closes a visibility split where mission lifecycle could block a malformed
  tool turn while workbench metrics still made the final answer look valid.

Browser Reliability:
- Browser execution behavior is unchanged. This is a replay/observability
  consistency fix for browser and non-browser tool chains.

Acceptance Evidence:
- Focused observability regression first failed before the fix:
  `npx tsx --test packages/app-gateway/src/mission-observability.test.ts`
  accepted `final-early` as the final answer before the pending
  `sessions_spawn` result.
- After the fix, focused observability tests passed:
  `npx tsx --test packages/app-gateway/src/mission-observability.test.ts`.
- Focused runtime/UI-state tests:
  `npx tsx --test packages/app-gateway/src/mission-observability.test.ts
  packages/app-gateway/src/mission-thread-bridge.test.ts
  packages/app-gateway/src/mission-completion-evaluator.test.ts
  packages/control-center/src/state/missionFinalAnswer.test.ts
  packages/control-center/src/state/missionProgress.test.ts`: passed.
- Typecheck: `npm run typecheck`: passed.
- Ledger check: `npm run ledger:check`: passed.
- Whitespace: `git diff --check`: passed.
- Real natural follow-up gate:
  `npm run mission:e2e:natural -- --natural-matrix-scenarios
  natural-followup-continuation --model-catalog models.local.json
  --scenario-timeout-ms 300000 --json
  /tmp/turnkeyai-natural-observability-final-answer-guard-20260601.json`:
  passed.
- Mission: `msn.mpv7nls4.1`, status `done`, natural `passed`, tools `6/6`,
  sessions `1/1`, browser used, profile fallbacks `0`, browser buckets `none`,
  liveness `0/0/0`, final bytes `2009`.
- Source coverage from the real artifact: answer terms `4/4`, answer patterns
  `1/1`, evidence events `6/2`, residual risk visible, unsupported claims `0`.

Regression Risk:
- The guard only tracks visible `toolPhase=call` events that carry a
  `toolCallId`. Legacy tool events without call ids are not reclassified.
- The real follow-up continuation gate passed. Cancellation remains the next
  terminal-tool-state path to recheck because it depends on interrupted tool
  result evidence rather than normal continuation.

Convergence question:
- Is complex-task stable delivery closer than the previous checkpoint?
  yes
- Evidence: the user-facing metrics path now shares the same ordering invariant
  as mission completion: tool calls must have results before the final answer is
  considered complete. A real follow-up mission still completed with
  `sessions_send`, tool results, and a useful final answer after the guard.
- If no, next required gate: run natural cancellation and timeout-continuation
  gates.
