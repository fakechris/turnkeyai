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
