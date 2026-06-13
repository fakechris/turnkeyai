import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyNaturalFixtureUrlOverrides,
  assertNaturalPromptAllowed,
  assertFollowupReusedSession,
  assertNaturalFollowupReusedExistingSession,
  assertNaturalScenarioPromptsAllowed,
  buildNaturalFixtureReportManifest,
  buildNaturalScenarioSpec,
  buildNaturalMissionE2eJsonReport,
  buildNaturalMissionPartialFailureJsonReport,
  buildMissionE2eJsonReport,
  evaluateNaturalMissionQuality,
  evaluateNaturalSourceCoverage,
  extractCancelledSessionKey,
  extractBrowserSessionIdForSpawnAgent,
  extractBrowserSessionIdForSendAfter,
  extractSessionKeyForSpawnAgent,
  extractTimedOutSessionKey,
  findWeakAnswerSignals,
  findWeakEvidenceSignals,
  formatMissionScenarioPass,
  formatMissionScenarioStart,
  formatNaturalMissionScenarioPass,
  formatNaturalMissionScenarioStart,
  isStalePendingApprovalThought,
  summarizeNaturalMissionScenarioResult,
  summarizeMissionScenarioResult,
  type NaturalMissionScenarioResult,
  type MissionScenarioResult,
} from "./mission-tool-use-e2e";

describe("mission tool-use e2e report", () => {
  it("does not treat browser session recovery wording as a tool-unavailable fallback", () => {
    assert.deepEqual(
      findWeakAnswerSignals(
        "Prior browser session was unavailable (`session_not_found=1`); dashboard successfully reopened via cold recreation."
      ),
      []
    );
  });

  it("still flags explicit tool-unavailable fallback wording", () => {
    assert.deepEqual(
      findWeakAnswerSignals("The browser tool is unavailable, so I am using general knowledge instead."),
      ["tool unavailable fallback"]
    );
  });

  it("summarizes mission scenario evidence without final-answer text", () => {
    const summary = summarizeMissionScenarioResult(fakeResult());

    assert.deepEqual(summary, {
      scenario: "realistic-brief",
      missionId: "msn.report.1",
      status: "done",
      threadId: "thread.report.1",
      timelineEvents: 3,
      toolEvents: 2,
      qualityGate: "passed",
      metrics: {
        tools: {
          requested: 2,
          results: 2,
          failed: 0,
          cancelled: 0,
          timeouts: 0,
          names: [],
        },
        sessions: {
          spawned: 2,
          continued: 1,
        },
        browser: {
          profileFallbacks: 0,
          failureBuckets: [],
        },
        approvals: {
          requested: 1,
          decided: 1,
          applied: 1,
        },
        liveness: {
          active: 0,
          waiting: 0,
          stale: 0,
        },
        qualityChecks: [
          { name: "final_answer", status: "pass", detail: "Lead final answer is present." },
          { name: "source_coverage", status: "pass", detail: "Final answer covers both source labels." },
        ],
        evidenceEvents: 2,
        recoveryEvents: 0,
      },
      final: {
        bytes: 69,
        bullets: 2,
        qualityFailures: [],
      },
    });
  });

  it("builds a durable report envelope for acceptance evidence", () => {
    const report = buildMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 3),
      results: [fakeResult()],
    });

    assert.equal(report.kind, "turnkeyai.mission-e2e.report");
    assert.equal(report.status, "passed");
    assert.equal(report.startedAt, "2026-05-30T12:00:00.000Z");
    assert.equal(report.completedAt, "2026-05-30T12:00:03.000Z");
    assert.equal(report.durationMs, 3000);
    assert.equal(report.scenarios.length, 1);
    assert.equal(report.scenarios[0]?.missionId, "msn.report.1");
  });

  it("marks the report failed when a summarized scenario is not passing", () => {
    const result = fakeResult();
    result.mission.status = "blocked";

    const report = buildMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 3),
      results: [result],
    });

    assert.equal(report.status, "failed");
  });

  it("requires closeout scenarios to report the expected closeout reason", () => {
    const passing = buildMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 3),
      results: [fakeCloseoutResult("budget-limited-closeout", "needs_attention", "round_limit")],
    });
    assert.equal(passing.status, "passed");
    assert.deepEqual(passing.scenarios[0]?.final.closeout, {
      reason: "round_limit",
      evidenceAvailable: "true",
    });

    const wrongReason = buildMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 3),
      results: [fakeCloseoutResult("budget-limited-closeout", "needs_attention", "completed_sub_agent_final")],
    });
    assert.equal(wrongReason.status, "failed");

    const wrongGate = buildMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 3),
      results: [fakeCloseoutResult("sub-agent-timeout-closeout", "needs_attention", "sub_agent_timeout")],
    });
    assert.equal(wrongGate.status, "failed");
  });

  it("treats bounded timeout recovery as a passing negative-control scenario", () => {
    const timeout = fakeCloseoutResult("timeout-recovery", "blocked", "sub_agent_timeout");
    timeout.metrics.tool.failed = 1;
    timeout.metrics.tool.timeouts = 1;
    timeout.metrics.qualityGate.checks = [
      { name: "failure_free", status: "fail", detail: "Expected timeout attention." },
      { name: "tool_loop_closeout", status: "warn", detail: "Final answer was forced after a sub-agent timeout." },
    ];

    const report = buildMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 3),
      results: [timeout],
    });

    assert.equal(report.status, "passed");
    assert.equal(report.scenarios[0]?.qualityGate, "blocked");
    assert.deepEqual(report.scenarios[0]?.final.closeout, {
      reason: "sub_agent_timeout",
      evidenceAvailable: "true",
    });
  });

  it("rejects forced closeout reasons in normal long brief scenarios", () => {
    const forcedCloseout = buildMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 3),
      results: [fakeScenarioWithCloseout("product-workbench-brief", "passed", "round_limit")],
    });
    assert.equal(forcedCloseout.status, "failed");
    assert.deepEqual(forcedCloseout.scenarios[0]?.final.closeout, {
      reason: "round_limit",
      evidenceAvailable: "true",
    });

    const healthySubAgentCloseout = buildMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 3),
      results: [fakeScenarioWithCloseout("realistic-brief", "passed", "completed_sub_agent_final")],
    });
    assert.equal(healthySubAgentCloseout.status, "passed");

    const repeatedFailureCloseout = buildMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 3),
      results: [fakeScenarioWithCloseout("realistic-brief", "passed", "repeated_tool_failure")],
    });
    assert.equal(repeatedFailureCloseout.status, "failed");
  });

  it("recognizes stale pending approval thoughts without matching completed approval summaries", () => {
    assert.equal(isStalePendingApprovalThought("Permission request is pending operator decision (`ap-1`)."), true);
    assert.equal(isStalePendingApprovalThought("The approval request is **pending** operator decision."), true);
    assert.equal(isStalePendingApprovalThought("The approval request is pending. I will wait before proceeding."), true);
    assert.equal(isStalePendingApprovalThought("**Pending operator approval.** Awaiting decision before executing."), true);
    assert.equal(
      isStalePendingApprovalThought("Approval request submitted. Awaiting operator decision on the dry-run form submission."),
      true
    );
    assert.equal(isStalePendingApprovalThought("Awaiting your decision. Once you approve or deny, I will proceed."), true);
    assert.equal(
      isStalePendingApprovalThought("Once approved, the browser worker completed the dry-run and verified the submitted page."),
      false
    );
  });

  it("does not count an unexpected mission closeout as natural task completion", () => {
    const spec = buildNaturalScenarioSpec("natural-browser-dynamic-page", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      providerSearchPricingUrl: "http://127.0.0.1/deepseek-v4-flash",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      slowReleaseUrl: "http://127.0.0.1/slow-release-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      cancelResumeStateUrl: "http://127.0.0.1/__cancel-resume-state",
      cancelResumeReleaseUrl: "http://127.0.0.1/cancel-resume-release-fixture",
      dynamicUrl: "http://127.0.0.1/dynamic-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
      asiawalkRouteUrl: "http://127.0.0.1/asiawalk-route",
      asiawalkBudgetUrl: "http://127.0.0.1/asiawalk-budget",
      asiawalkLiveUrl: "http://127.0.0.1/asiawalk-live",
      complexBrowserUrl: "http://127.0.0.1/complex-browser",
      basicUrl: "http://127.0.0.1/basic",
      fixtureContentHashes: {},
      server: undefined as never,
    });
    const result = fakeNaturalResult();
    result.mission.closeout = "bounded_failure";

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.completed, false);
    assert.equal(quality.dimensionScores.taskCompletion, 1);
    assert.ok(quality.failures.some((failure) => /expected status/i.test(failure)));
  });

  it("accepts denied approval as a completed natural approval loop without permission application", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-approval-denied-safe-closeout", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.scenario = "natural-approval-denied-safe-closeout";
    result.metrics.tool.results = 1;
    result.metrics.tool.failed = 1;
    result.metrics.sessions.spawned = 0;
    result.metrics.approvals = { requested: 1, decided: 1, applied: 0 };
    result.metrics.qualityGate.evidenceEvents = 1;
    result.timeline = [
      {
        kind: "tool",
        text: "sessions_spawn call",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "browser", task: "submit local approval form" }),
        },
      },
      {
        kind: "approval",
        text: "Requested approval for browser.form.submit.",
        tMs: 1200,
        approvalId: "approval-1",
        runtime: { eventType: "permission.query", status: "pending", approvalId: "approval-1" },
      },
      {
        kind: "approval",
        text: "Denied approval for browser.form.submit.",
        tMs: 1500,
        approvalId: "approval-1",
        runtime: { eventType: "permission.result", status: "denied", approvalId: "approval-1" },
      },
      {
        kind: "tool",
        text: "sessions_spawn result",
        tMs: 1600,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: "Permission request approval-1 was denied; blocked_before_side_effect: true.",
        },
      },
      {
        kind: "thought",
        text: [
          "The approval for the dry-run browser form submission was denied.",
          "The runtime did not submit or apply the browser action, so no side effect ran.",
          "Recommended next action: revise the request for operator approval or keep the safe fallback without submitting the form.",
          "Residual risk remains that the form outcome is unverified until an operator approves a future dry run.",
        ].join(" "),
        tMs: 2000,
      },
    ];
    result.final = result.timeline.at(-1)!;
    result.runtimeEvidence = {
      providerToolProtocol: {
        rounds: 1,
        providerToolCallsReturned: 3,
        assistantToolUseBlockCount: 3,
        roleToolResultMessageCount: 3,
        toolResultBlockCount: 3,
        matchingToolCallIds: 3,
        assistantBeforeToolResults: true,
        allToolResultsMatchAssistantToolCalls: true,
        nextProviderRequestIncludesToolResults: true,
        toolNames: ["sessions_spawn"],
      },
    };

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);
    assert.equal(quality.approvalExercised, true);

    result.final.text = [
      "**Denied - safe closeout confirmed.**",
      "Approval ID: ap.THREAD-1.call_function_1.",
      "Action: browser.form.submit.",
      "Decision: Denied.",
      "Reason: Operator denied the isolated local dry-run form submission.",
      "No mutation was performed. The thread closes cleanly - the pending decision is on record and no side effects were applied.",
    ].join("\n");
    result.timeline[result.timeline.length - 1] = { ...result.final };
    const compactNaturalQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.deepEqual(compactNaturalQuality.failures, []);
    assert.equal(compactNaturalQuality.approvalExercised, true);

    result.final.text = [
      "**Approval denied - task closed safely.**",
      "Decision: DENIED.",
      "Safe fallback: No form submission was or will be performed.",
      "The dry-run submission is cancelled. The task is closed out at operator direction.",
      "No further browser work is queued. Flow FLOW-1 is complete.",
    ].join("\n");
    result.timeline[result.timeline.length - 1] = { ...result.final };
    const safeFallbackQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.deepEqual(safeFallbackQuality.failures, []);
    assert.equal(safeFallbackQuality.approvalExercised, true);

    result.final.text = [
      "**Approval denied - action aborted.**",
      "action: browser.form.submit",
      "decision: denied",
      "Safe fallback applied: The dry-run form submission will not be performed.",
      "No state was changed. Flow FLOW-1 is closed cleanly.",
      "The operator should request a new approval only if they want to retry the isolated local dry-run with a revised scope.",
      "Until then, the safe outcome is to leave the form untouched and keep the denied approval decision as the authoritative evidence.",
    ].join("\n");
    result.timeline[result.timeline.length - 1] = { ...result.final };
    const abortedActionQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.deepEqual(abortedActionQuality.failures, []);
    assert.equal(abortedActionQuality.approvalExercised, true);

    result.timeline.splice(3, 0, {
      kind: "approval",
      text: "Applied approval despite denial.",
      tMs: 1550,
      approvalId: "approval-1",
      runtime: { eventType: "permission.applied", status: "applied", approvalId: "approval-1" },
    });
    result.metrics.approvals.applied = 1;

    const invalidQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(
      invalidQuality.failures.includes("approval denied scenario did not complete query/result without permission.applied")
    );
  });

  it("accepts compact denied approval closeout when it proves no form submission executed", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-approval-denied-safe-closeout", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.scenario = "natural-approval-denied-safe-closeout";
    result.metrics.tool.results = 1;
    result.metrics.tool.failed = 1;
    result.metrics.sessions.spawned = 0;
    result.metrics.approvals = { requested: 1, decided: 1, applied: 0 };
    result.metrics.qualityGate.evidenceEvents = 1;
    result.timeline = [
      {
        kind: "approval",
        text: "Requested approval for browser.form.submit.",
        tMs: 1200,
        approvalId: "approval-1",
        runtime: { eventType: "permission.query", status: "pending", approvalId: "approval-1" },
      },
      {
        kind: "approval",
        text: "Denied approval for browser.form.submit.",
        tMs: 1500,
        approvalId: "approval-1",
        runtime: { eventType: "permission.result", status: "denied", approvalId: "approval-1" },
      },
      {
        kind: "tool",
        text: "sessions_spawn result",
        tMs: 1600,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: "Permission request approval-1 was denied; blocked_before_side_effect: true.",
        },
      },
      {
        kind: "thought",
        text: [
          "Safe closeout - action not performed.",
          "Requested action: browser.form.submit dry-run.",
          "Decision: Denied by natural-mission-e2e.",
          "The dry-run browser form submission was not executed due to the denial, no approval was applied, and no external state was affected.",
          "The approval decision is authoritative for this isolated local test data.",
          "The flow is complete; the safe next action is to request a new approval only if the operator wants to retry the dry-run submission.",
        ].join("\n"),
        tMs: 2000,
      },
    ];
    result.final = result.timeline.at(-1)!;

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.deepEqual(quality.failures, []);
    assert.equal(quality.approvalExercised, true);

    result.timeline[result.timeline.length - 1] = {
      kind: "thought",
      text: [
        "Approval denied. The operator denied the dry-run form submission. The action will not be performed.",
        "Safe fallback: No browser action taken. The form remains untouched.",
        "No side effects occurred because execution stopped at the approval gate before the browser action could run.",
        "To retry, request a new approval with adjusted scope.",
      ].join("\n"),
      tMs: 2100,
    };
    result.final = result.timeline.at(-1)!;
    const alternateQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(alternateQuality.failures, []);

    result.timeline[result.timeline.length - 1] = {
      kind: "thought",
      text: [
        "**Approval denied.** The browser form submission has been cancelled. No action was performed.",
        "**Safe fallback:** The approval workflow halts cleanly. The dry-run form at `http://127.0.0.1/approval-form` was never submitted.",
        "If the operator wants to proceed, the safe next action is to re-initiate with a revised action or a different scope for re-review.",
      ].join("\n"),
      tMs: 2200,
    };
    result.final = result.timeline.at(-1)!;
    const cancelledSubmissionQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(cancelledSubmissionQuality.failures, []);

    result.timeline[result.timeline.length - 1] = {
      kind: "thought",
      text: [
        "**Safe Closeout**",
        "**Requested action:** `browser.form.submit` - dry-run form submission to `http://127.0.0.1/approval-form`",
        "**What ran:** Nothing. Permission was denied; no browser action or side effect was applied.",
        "**Safe next action:** Await re-request from the operator if they wish to approve the action with different scope or context.",
        "Flow closed. No state mutated.",
      ].join("\n\n"),
      tMs: 2300,
    };
    result.final = result.timeline.at(-1)!;
    const noStateMutatedQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(noStateMutatedQuality.failures, []);

    result.timeline[result.timeline.length - 1] = {
      kind: "thought",
      text: [
        "**Final Safe Closeout**",
        "- **Requested action:** `browser.form.submit` targeting `http://127.0.0.1/approval-form`",
        "- **Decision:** Denied by operator.",
        "- **Execution status:** No browser submission ran; no side effect occurred.",
        "- **Safe fallback:** The operator may re-inspect the local form or issue a new approval request with revised scope.",
      ].join("\n"),
      tMs: 2350,
    };
    result.final = result.timeline.at(-1)!;
    const naturalNoSideEffectOccurredQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(naturalNoSideEffectOccurredQuality.failures, []);

    result.timeline[result.timeline.length - 1] = {
      kind: "thought",
      text: [
        "**Safe Closeout - Approval Denied**",
        "| Field | Value |",
        "|---|---|",
        "| **Requested action** | `browser.form.submit` |",
        "| **Decision** | **DENIED** |",
        "| **Side effect ran?** | **No** - no browser form submission was performed. |",
        "| **Result verified?** | **Unverified** - the dry-run was never executed. |",
        "",
        "A permission query for a dry-run browser form submission to `http://127.0.0.1/approval-form` was submitted to the operator and denied.",
        "No mutation, form post, or any side-effectful action occurred in any browser session.",
        "Concrete safe fallback: re-submit a new permission request with revised action scope for operator review.",
      ].join("\n"),
      tMs: 2360,
    };
    result.final = result.timeline.at(-1)!;
    const approvalFormUrlSubmittedToOperatorQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(approvalFormUrlSubmittedToOperatorQuality.failures, []);

    result.timeline[result.timeline.length - 1] = {
      kind: "thought",
      text: [
        "**Safe Closeout - Approval Denied**",
        "| Field | Value |",
        "|---|---|",
        "| **Requested action** | `browser.form.submit` to `http://127.0.0.1/approval-form` |",
        "| **Decision** | Denied |",
        "| **Side effects run** | None - no browser form was submitted |",
        "",
        "**Unexecuted result:** The dry-run form submission outcome remains unverified.",
        "**Concrete safe fallback:** The operator may re-initiate the approval with a revised scope when ready to proceed.",
      ].join("\n"),
      tMs: 2365,
    };
    result.final = result.timeline.at(-1)!;
    const noBrowserFormSubmittedQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(noBrowserFormSubmittedQuality.failures, []);

    result.timeline[result.timeline.length - 1] = {
      kind: "thought",
      text: [
        "**Safe closeout**",
        "| Item | Detail |",
        "|---|---|",
        "| **Requested action** | Dry-run browser form submission to `http://127.0.0.1/approval-form` |",
        "| **Result** | **Denied** - the operator declined the approval request |",
        "| **Side effect** | Did **not** execute; the form submission was never applied |",
        "| **Safest next action** | Await further operator guidance before re-requesting permission or modifying the target form |",
        "The approval workflow completed correctly: the permission was requested, the operator denied it, and no browser mutation occurred.",
      ].join("\n"),
      tMs: 2375,
    };
    result.final = result.timeline.at(-1)!;
    const markdownTableCloseoutQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(markdownTableCloseoutQuality.failures, []);

    result.timeline[result.timeline.length - 1] = {
      kind: "thought",
      text: [
        "**Final Safe Closeout - Approval Denied**",
        "| Field | Value |",
        "|---|---|",
        "| **Requested action** | `browser.form.submit` (dry-run form submission) |",
        "| **Decision** | **Denied** by `natural-mission-e2e` |",
        "**Effect:** No browser form submission was performed. No side effect ran.",
        "The unexecuted result is **unverified** because the action was blocked before execution.",
        "**Concrete safe fallback:** The operator may re-submit the approval request with an amended scope for a fresh review.",
      ].join("\n"),
      tMs: 2385,
    };
    result.final = result.timeline.at(-1)!;
    const browserFormSubmissionNotPerformedQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(browserFormSubmissionNotPerformedQuality.failures, []);

    result.timeline[result.timeline.length - 1] = {
      kind: "thought",
      text: [
        "**Approval denied - safe closeout confirmed.**",
        "| Field | Value |",
        "|---|---|",
        "| **Action** | `browser.form.submit` |",
        "| **Decision** | **Denied** by natural-mission-e2e |",
        "| **Form submission attempted?** | **No** - blocked at approval gate |",
        "**Safe fallback:**",
        "- No browser mutation was applied.",
        "- The approval form at `http://127.0.0.1/approval-form` was never touched.",
        "- The operator is free to inspect the page manually, resubmit with adjusted parameters, or dismiss the workflow entirely.",
        "**Flow closed.** No further action will be taken on this thread until a new request is issued.",
      ].join("\n"),
      tMs: 2400,
    };
    result.final = result.timeline.at(-1)!;
    const naturalTableCloseoutQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(naturalTableCloseoutQuality.failures, []);
  });

  it("accepts approved dry-run submission evidence without treating permission safety text as blocked browser evidence", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-approval-dry-run-action", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.scenario = "natural-approval-dry-run-action";
    result.metrics.tool.results = 4;
    result.metrics.sessions.spawned = 1;
    result.metrics.sessions.continued = 1;
    result.metrics.approvals = { requested: 1, decided: 1, applied: 1 };
    result.metrics.qualityGate.evidenceEvents = 4;
    result.timeline = [
      {
        kind: "tool",
        text: 'Calling sessions_spawn(agent_id="browser")',
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "browser", task: "open local approval form" }),
        },
      },
      {
        kind: "approval",
        text: "Requested approval for browser.form.submit.",
        tMs: 1200,
        approvalId: "approval-1",
        runtime: { eventType: "permission.query", status: "pending", approvalId: "approval-1" },
      },
      {
        kind: "approval",
        text: "Approved browser.form.submit.",
        tMs: 1500,
        approvalId: "approval-1",
        runtime: { eventType: "permission.result", status: "approved", approvalId: "approval-1" },
      },
      {
        kind: "approval",
        text: "Applied approval for browser.form.submit.",
        tMs: 1550,
        approvalId: "approval-1",
        runtime: { eventType: "permission.applied", status: "applied", approvalId: "approval-1" },
      },
      {
        kind: "tool",
        text: "Tool sessions_spawn returned approval-gate evidence.",
        tMs: 1800,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: [
            "Approval request: permission.query blocked browser.form.submit before browser work started.",
            "Approval decision/application: permission.result approved the request and permission.applied cached it.",
            'Browser fixture evidence: pre-submit state was "Dry-run has not been submitted" and post-submit state was "Dry-run submitted locally after approval; no external mutation was performed."',
          ].join("\n"),
        },
      },
      {
        kind: "thought",
        text: [
          "**Dry-run form submission - completed.**",
          "Approved action: browser.form.submit.",
          "Permission cache: Applied.",
          "Pre-submit state: Dry-run has not been submitted.",
          "Post-submit state: Dry-run submitted locally after approval; no external mutation was performed.",
          "Residual risk: Confirmed local-only; no external mutation performed.",
        ].join("\n"),
        tMs: 2000,
      },
    ];
    result.final = result.timeline.at(-1)!;

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.deepEqual(quality.failures, []);
    assert.equal(quality.approvalExercised, true);
    assert.equal(quality.weakAnswerSignals.includes("browser evidence blocked"), false);

    result.timeline[4]!.runtime = {
      ...result.timeline[4]!.runtime,
      resultContent: [
        "Approval gate blocked the browser form submit side-effect before operator approval.",
        "Approval decision/application: permission.result approved the request and permission.applied cached it.",
        'Browser fixture evidence: pre-submit state was "Dry-run has not been submitted" and post-submit state was "Dry-run submitted locally after approval; no external mutation was performed."',
      ].join("\n"),
    };
    result.final.text = [
      "Dry-run form submission - complete.",
      "Approval: browser.form.submit was operator approved and runtime cache applied.",
      'Verified post-submit evidence: status changed from "Dry-run has not been submitted" to "Dry-run submitted locally after approval; no external mutation was performed."',
      "Residual risk / no-external-side-effect boundary: no external network call or downstream system mutation was performed or verified. External-side-effect scope: not verified.",
    ].join("\n");
    const broadPermissionGateQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(broadPermissionGateQuality.failures, []);
    assert.equal(broadPermissionGateQuality.weakAnswerSignals.includes("browser evidence blocked"), false);

    result.timeline[4]!.runtime = {
      ...result.timeline[4]!.runtime,
      resultContent: [
        "Approval gate blocked browser.form.submit before approval.",
        "The browser sub-agent later reused the warm page after permission.applied.",
      ].join("\n"),
    };
    result.final.text = [
      "Approval ID: ap.thread.call",
      "Action approved: browser.form.submit",
      "Result: SUCCESS",
      "The dry-run form submission was executed on the warm browser session.",
      "Post-submit verified: Dry-run submitted locally after approval; no external mutation was performed.",
      "URL unchanged on the loopback approval-form page.",
      "Residual risk: Confirmed local-only - no external side effects.",
    ].join("\n");
    const successStyleQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(successStyleQuality.failures, []);
  });

  it("rejects stale pending approval finals after approval has been applied", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-approval-dry-run-action", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.scenario = "natural-approval-dry-run-action";
    result.metrics.approvals = { requested: 1, decided: 1, applied: 1 };
    result.timeline = [
      {
        kind: "approval",
        text: "Applied approval for browser.form.submit.",
        tMs: 1000,
        approvalId: "approval-1",
        runtime: { eventType: "permission.applied", status: "applied", approvalId: "approval-1" },
      },
      {
        kind: "thought",
        text: "Approval is pending. Once the operator responds, I will submit the dry-run form and report the evidence.",
        tMs: 2000,
      },
    ];
    result.final = result.timeline.at(-1)!;

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.ok(quality.failures.includes("approval was applied but final answer still claims approval is pending"));
  });

  it("accepts pending approval as a natural paused state without decision or permission application", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-approval-pending-state", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.scenario = "natural-approval-pending-state";
    result.mission.status = "needs_approval";
    result.metrics.status = "needs_approval";
    result.metrics.tool.requested = 1;
    result.metrics.tool.results = 0;
    result.metrics.sessions.spawned = 0;
    result.metrics.approvals = { requested: 1, decided: 0, applied: 0 };
    result.metrics.liveness.active = 1;
    result.metrics.qualityGate.evidenceEvents = 0;
    result.timeline = [
      {
        kind: "tool",
        text: "sessions_spawn call",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "browser", task: "submit local approval form" }),
        },
      },
      {
        kind: "approval",
        text: "Requested approval · <b>browser.form.submit</b> · approval required before side effect; operator decision is pending before any form submission can run. Residual risk remains until the operator decides.",
        tMs: 1200,
        approvalId: "approval-1",
        runtime: { eventType: "permission.query", status: "pending", approvalId: "approval-1" },
      },
    ];
    result.final = result.timeline.at(-1)!;

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);
    assert.equal(quality.completed, true);
    assert.equal(quality.stuckOrLoop, false);
    assert.equal(quality.approvalExercised, true);
    assert.equal(quality.dimensionScores.taskCompletion, 2);
    assert.equal(quality.dimensionScores.evidenceQuality, 2);
    assert.ok(!quality.failureBuckets.includes("runtime_lifecycle"));
    assert.ok(!quality.failureBuckets.includes("answer_quality"));

    result.timeline.push({
      kind: "approval",
      text: "Approved browser.form.submit.",
      tMs: 1500,
      approvalId: "approval-1",
      runtime: { eventType: "permission.result", status: "approved", approvalId: "approval-1" },
    });
    result.metrics.approvals.decided = 1;

    const invalidQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(
      invalidQuality.failures.includes("approval pending scenario did not stop at query without result/applied")
    );
  });

  it("formats per-scenario progress lines for long matrix runs", () => {
    const result = fakeResult();

    assert.equal(formatMissionScenarioStart({ scenario: "realistic-brief", index: 3, total: 12 }), "mission scenario starting: realistic-brief (3/12)");
    assert.equal(
      formatMissionScenarioPass({ result, index: 3, total: 12, durationMs: 1234 }),
      "mission scenario passed: realistic-brief (3/12, 1234ms) mission-id=msn.report.1 quality=passed tools=2/2 sessions=2/1 liveness=0/0/0"
    );
  });

  it("keeps natural scenario prompts separate from contract-gate language", () => {
    assertNaturalScenarioPromptsAllowed();

    assert.throws(
      () => assertNaturalPromptAllowed("Call sessions_spawn exactly once and include TURNKEYAI_TEST_OK."),
      /contract-gate language/
    );
  });

  it("applies natural fixture URL overrides before building scenario prompts", () => {
    const fixture = applyNaturalFixtureUrlOverrides(
      {
        server: {} as never,
        basicUrl: "http://127.0.0.1/local-fixture",
        alphaUrl: "http://127.0.0.1/local-alpha",
        betaUrl: "http://127.0.0.1/local-beta",
        slowUrl: "http://127.0.0.1/local-slow",
        slowReleaseUrl: "http://127.0.0.1/local-slow-release",
        cancelResumeUrl: "http://127.0.0.1/local-cancel-resume",
        cancelResumeStateUrl: "http://127.0.0.1/local-cancel-state",
        cancelResumeReleaseUrl: "http://127.0.0.1/local-cancel-release",
        approvalUrl: "http://127.0.0.1/local-approval",
        dynamicUrl: "http://127.0.0.1/local-dynamic",
        dashboardUrl: "http://127.0.0.1/local-dashboard",
        complexBrowserUrl: "http://127.0.0.1/local-complex-browser",
        orchestrationUrl: "http://127.0.0.1/local-orchestration",
        bridgeUrl: "http://127.0.0.1/local-bridge",
        productSignalsUrl: "http://127.0.0.1/local-signals",
        externalPageUrl: "https://local.example/external",
      },
      {
        TURNKEYAI_NATURAL_ALPHA_URL: "http://shared.test/vendor-alpha",
        TURNKEYAI_NATURAL_BETA_URL: "http://shared.test/vendor-beta",
        TURNKEYAI_NATURAL_PROVIDER_SEARCH_PRICING_URL: "http://shared.test/deepseek-provider-pricing",
        TURNKEYAI_NATURAL_DASHBOARD_URL: "http://shared.test/ops-dashboard",
        TURNKEYAI_NATURAL_APPROVAL_URL: "http://shared.test/approval-form",
        TURNKEYAI_NATURAL_SLOW_URL: "http://shared.test/slow-fixture",
        TURNKEYAI_NATURAL_CANCEL_RESUME_URL: "http://shared.test/cancel-resume",
        TURNKEYAI_NATURAL_DYNAMIC_URL: "http://shared.test/dynamic-dashboard",
        TURNKEYAI_NATURAL_COMPLEX_BROWSER_URL: "http://shared.test/complex-browser",
        TURNKEYAI_NATURAL_ORCHESTRATION_URL: "http://shared.test/product-orchestration",
        TURNKEYAI_NATURAL_BRIDGE_URL: "http://shared.test/product-bridge",
        TURNKEYAI_NATURAL_PRODUCT_SIGNALS_URL: "http://shared.test/product-signals",
        TURNKEYAI_NATURAL_EXTERNAL_BROWSER_URL: "https://news.ycombinator.com/",
      }
    );

    const comparison = buildNaturalScenarioSpec("natural-comparison-research", fixture);
    assert.match(comparison.desc, /http:\/\/shared\.test\/vendor-alpha/);
    assert.match(comparison.desc, /http:\/\/shared\.test\/vendor-beta/);

    const providerPricing = buildNaturalScenarioSpec("natural-provider-search-pricing", fixture);
    assert.match(providerPricing.desc, /http:\/\/shared\.test\/deepseek-provider-pricing/);
    assert.match(providerPricing.desc, /DeepSeek V4 Flash API provider note/);
    assert.ok(providerPricing.requiredAnswerTerms.includes("OpenRouter"));
    assert.ok(providerPricing.requiredAnswerTerms.includes("$0.28"));
    const providerCoverage = evaluateNaturalSourceCoverage({
      spec: providerPricing,
      finalText: [
        "DeepSeek V4 Flash provider note.",
        "OpenRouter: ✅ Yes (via web_search); costs $0.28 input and $0.42 output.",
        "Together: ❌ No search support; costs $0.20 input and $0.40 output.",
        "Fireworks: ❌ No search support; costs $0.25 input and $0.45 output.",
        "Recommendation: choose Together for lowest cost unless search support is required. Residual risk: local fixture evidence only.",
      ].join(" "),
      evidenceText:
        "DeepSeek V4 Flash provider source: OpenRouter has a web_search option; Together and Fireworks require search to be supplied externally. Pricing $0.28/$0.42, $0.20/$0.40, $0.25/$0.45.",
      evidenceEvents: 1,
    });
    assert.deepEqual(providerCoverage.answerPatterns.missing, []);

    const chineseProviderCoverage = evaluateNaturalSourceCoverage({
      spec: providerPricing,
      finalText: [
        "DeepSeek V4 Flash API Provider Note。",
        "Together: input $0.20, output $0.40。",
        "Fireworks: input $0.25, output $0.45。",
        "OpenRouter: input $0.28, output $0.42；唯一明确标注支持 web_search。",
        "风险：页面仅作为 local test evidence，生产决策仍需验证。",
      ].join(" "),
      evidenceText:
        "DeepSeek V4 Flash provider source: OpenRouter has a web_search option; Together and Fireworks require search to be supplied externally. Pricing $0.28/$0.42, $0.20/$0.40, $0.25/$0.45.",
      evidenceEvents: 1,
    });
    assert.deepEqual(chineseProviderCoverage.answerPatterns.missing, []);
    assert.equal(chineseProviderCoverage.residualRiskVisible, true);
    assert.deepEqual(chineseProviderCoverage.unsupportedClaims, []);

    const productionFreshnessProviderCoverage = evaluateNaturalSourceCoverage({
      spec: providerPricing,
      finalText: [
        "DeepSeek V4 Flash API Provider Note.",
        "OpenRouter: Yes via web_search; input $0.28 and output $0.42.",
        "Together: No search support; input $0.20 and output $0.40.",
        "Fireworks: No search support; input $0.25 and output $0.45.",
        "Source verbatim rows confirmed against page content.",
        "Residual risk: production decision should verify provider docs for freshness.",
      ].join(" "),
      evidenceText:
        "DeepSeek V4 Flash provider source: OpenRouter has a web_search option; Together and Fireworks require search to be supplied externally. Pricing $0.28/$0.42, $0.20/$0.40, $0.25/$0.45.",
      evidenceEvents: 1,
    });
    assert.deepEqual(productionFreshnessProviderCoverage.answerPatterns.missing, []);
    assert.deepEqual(productionFreshnessProviderCoverage.evidencePatterns.missing, []);
    assert.deepEqual(productionFreshnessProviderCoverage.unsupportedClaims, []);

    const unverifiedSearchProviderCoverage = evaluateNaturalSourceCoverage({
      spec: providerPricing,
      finalText: [
        "DeepSeek V4 Flash provider note.",
        "Together costs $0.20 input and $0.40 output.",
        "Fireworks costs $0.25 input and $0.45 output.",
        "OpenRouter costs $0.28 input and $0.42 output.",
        "Search support remains unverified.",
      ].join(" "),
      evidenceText:
        "DeepSeek V4 Flash provider source: OpenRouter has a web_search option; Together and Fireworks require search to be supplied externally. Pricing $0.28/$0.42, $0.20/$0.40, $0.25/$0.45.",
      evidenceEvents: 1,
    });
    assert.deepEqual(unverifiedSearchProviderCoverage.unsupportedClaims, [
      "unverified provider search pricing closeout",
    ]);

    const browser = buildNaturalScenarioSpec("natural-browser-dynamic-page", fixture);
    assert.match(browser.desc, /http:\/\/shared\.test\/ops-dashboard/);

    const approval = buildNaturalScenarioSpec("natural-approval-dry-run-action", fixture);
    assert.match(approval.desc, /http:\/\/shared\.test\/approval-form/);

    const delegation = buildNaturalScenarioSpec("natural-long-delegation", fixture);
    assert.match(delegation.desc, /http:\/\/shared\.test\/product-orchestration/);
    assert.match(delegation.desc, /http:\/\/shared\.test\/product-bridge/);
    assert.match(delegation.desc, /http:\/\/shared\.test\/product-signals/);

    const timeout = buildNaturalScenarioSpec("natural-timeout-followup-continuation", fixture);
    assert.match(timeout.desc, /http:\/\/shared\.test\/slow-fixture/);
    assert.equal(fixture.slowReleaseUrl, "http://shared.test/__slow-fixture-release");

    const cancelResume = buildNaturalScenarioSpec("natural-cancel-followup-continuation", fixture);
    assert.match(cancelResume.desc, /http:\/\/shared\.test\/cancel-resume/);
    assert.equal(fixture.cancelResumeStateUrl, "http://shared.test/__cancel-resume-state");
    assert.equal(fixture.cancelResumeReleaseUrl, "http://shared.test/__cancel-resume-release");

    const external = buildNaturalScenarioSpec("natural-browser-external-page-review", fixture);
    assert.match(external.desc, /https:\/\/news\.ycombinator\.com\//);
    assert.equal(external.requiresBrowser, true);
    assert.equal(external.requiresApproval, false);
    assert.ok(external.requiredAnswerTerms.includes("Hacker News"));
    assert.ok(
      (external.requiredEvidencePatterns ?? []).some((pattern) => pattern.label.toLowerCase().includes("hacker news")),
    );

    const overriddenExternal = buildNaturalScenarioSpec("natural-browser-external-page-review", {
      ...fixture,
      externalPageUrl: "https://example.com/status",
    });
    assert.match(overriddenExternal.desc, /https:\/\/example\.com\/status/);
    assert.equal(overriddenExternal.requiredAnswerTerms.includes("Hacker News"), false);
    assert.equal(
      (overriddenExternal.requiredEvidencePatterns ?? []).some((pattern) => pattern.label.toLowerCase().includes("hacker news")),
      false,
    );

    const complexBrowser = buildNaturalScenarioSpec("natural-browser-complex-page-review", fixture);
    assert.match(complexBrowser.desc, /http:\/\/shared\.test\/complex-browser/);
    assert.equal(complexBrowser.requiresBrowser, true);
    assert.equal(complexBrowser.requiresApproval, false);
    assert.ok(complexBrowser.requiredAnswerTerms.includes("Frame Captain"));
    assert.equal(complexBrowser.requiresArtifactLifecycle, true);
    assert.ok(
      (complexBrowser.requiredEvidencePatterns ?? []).some((pattern) => pattern.label.toLowerCase().includes("shadow")),
    );

    assert.equal(fixture.dynamicUrl, "http://shared.test/dynamic-dashboard");
  });

  it("keeps the legacy natural browser URL as a dashboard override alias", () => {
    const fixture = applyNaturalFixtureUrlOverrides(
      {
        server: {} as never,
        basicUrl: "http://127.0.0.1/local-fixture",
        alphaUrl: "http://127.0.0.1/local-alpha",
        betaUrl: "http://127.0.0.1/local-beta",
        slowUrl: "http://127.0.0.1/local-slow",
        cancelResumeUrl: "http://127.0.0.1/local-cancel-resume",
        cancelResumeStateUrl: "http://127.0.0.1/local-cancel-state",
        approvalUrl: "http://127.0.0.1/local-approval",
        dynamicUrl: "http://127.0.0.1/local-dynamic",
        dashboardUrl: "http://127.0.0.1/local-dashboard",
        complexBrowserUrl: "http://127.0.0.1/local-complex-browser",
        orchestrationUrl: "http://127.0.0.1/local-orchestration",
        bridgeUrl: "http://127.0.0.1/local-bridge",
        productSignalsUrl: "http://127.0.0.1/local-signals",
        externalPageUrl: "https://local.example/external",
      },
      {
        TURNKEYAI_NATURAL_BROWSER_URL: "http://shared.test/browser-dashboard",
      }
    );

    const browser = buildNaturalScenarioSpec("natural-browser-dynamic-page", fixture);
    assert.match(browser.desc, /http:\/\/shared\.test\/browser-dashboard/);
  });

  it("rejects credentialed or fragment-bearing natural fixture URL overrides", () => {
    const fixture = {
      server: {} as never,
      basicUrl: "http://127.0.0.1/local-fixture",
      alphaUrl: "http://127.0.0.1/local-alpha",
      betaUrl: "http://127.0.0.1/local-beta",
      slowUrl: "http://127.0.0.1/local-slow",
      cancelResumeUrl: "http://127.0.0.1/local-cancel-resume",
      cancelResumeStateUrl: "http://127.0.0.1/local-cancel-state",
      approvalUrl: "http://127.0.0.1/local-approval",
      dynamicUrl: "http://127.0.0.1/local-dynamic",
      dashboardUrl: "http://127.0.0.1/local-dashboard",
      complexBrowserUrl: "http://127.0.0.1/local-complex-browser",
      orchestrationUrl: "http://127.0.0.1/local-orchestration",
      bridgeUrl: "http://127.0.0.1/local-bridge",
      productSignalsUrl: "http://127.0.0.1/local-signals",
      externalPageUrl: "https://local.example/external",
    };

    assert.throws(
      () =>
        applyNaturalFixtureUrlOverrides(fixture, {
          TURNKEYAI_NATURAL_EXTERNAL_BROWSER_URL: "https://user:secret@example.com/",
        }),
      /must not include URL credentials/,
    );
    assert.throws(
      () =>
        applyNaturalFixtureUrlOverrides(fixture, {
          TURNKEYAI_NATURAL_EXTERNAL_BROWSER_URL: "https://example.com/#token",
        }),
      /must not include a URL fragment/,
    );
  });

  it("summarizes natural acceptance evidence without treating markers as the gate", () => {
    const result = fakeNaturalResult();
    const summary = summarizeNaturalMissionScenarioResult(result);

    assert.deepEqual(summary.natural, {
      status: "passed",
      completed: true,
      stuckOrLoop: false,
      reasonableToolUse: true,
      browserUsed: true,
      profileFallbackFree: true,
      subAgentCompleted: true,
      approvalExercised: false,
      finalAnswerHasEvidence: true,
      finalAnswerUseful: true,
      sourceCoverage: {
        answerTerms: { covered: 2, total: 2, missing: [] },
        answerPatterns: { covered: 0, total: 0, missing: [] },
        evidencePatterns: { covered: 1, total: 1, missing: [] },
        evidenceEvents: { observed: 1, required: 1 },
        residualRiskVisible: true,
        unsupportedClaims: [],
      },
      weakAnswerSignals: [],
      failures: [],
      dimensionScores: {
        taskCompletion: 2,
        evidenceQuality: 2,
        toolUseAppropriateness: 2,
        browserAuthenticity: 2,
        subAgentIndependence: 2,
        continuationBehavior: 2,
        permissionCorrectness: 2,
        timeoutCloseoutQuality: 2,
      },
      failureBuckets: [],
    });
    assert.equal(summary.final.bytes > 0, true);
    assert.equal(summary.final.text, result.final.text);
    assert.equal(summary.final.excerpt.includes("recommended next action"), true);
    assert.equal(summary.evidenceReplay?.schema, "turnkeyai.natural-mission-evidence-replay.v1");
    assert.equal(summary.evidenceReplay?.finalText, result.final.text);
    assert.equal(summary.evidenceReplay?.finalTextBytes, Buffer.byteLength(result.final.text, "utf8"));
    assert.equal(summary.evidenceReplay?.timeline.count, result.timeline.length);
    assert.equal(summary.evidenceReplay?.timeline.entries[1]?.runtime?.toolName, "sessions_spawn");
    assert.equal(summary.evidenceReplay?.timeline.entries[1]?.runtime?.resultContent, result.timeline[1]?.runtime?.resultContent);
  });

  it("summarizes failed and timed-out tool diagnostics in natural reports", () => {
    const result = fakeNaturalResult();
    result.metrics.tool = { requested: 4, results: 4, failed: 1, cancelled: 0, timeouts: 1 };
    result.timeline = [
      ...result.timeline,
      {
        kind: "tool",
        text: "Tool sessions_send failed: browser worker returned timeout before final screenshot.",
        emph: "danger",
        tMs: 3_500,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          resultContent: "browser worker timeout before final screenshot",
        },
      },
    ];

    const summary = summarizeNaturalMissionScenarioResult(result);

    assert.deepEqual(summary.toolDiagnostics, [
      {
        toolName: "sessions_send",
        phase: "result",
        status: "failed",
        text: "Tool sessions_send failed: browser worker returned timeout before final screenshot. browser worker timeout before final screenshot",
      },
    ]);
  });

  it("accepts a recovered failed tool result only when later same-tool evidence succeeds", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-followup-continuation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
    betaUrl: "http://127.0.0.1/vendor-beta",
    providerSearchPricingUrl: "http://127.0.0.1/deepseek-provider-pricing",
    dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.scenario = "natural-browser-followup-continuation";
    result.metrics.tool = { requested: 6, results: 6, failed: 1, cancelled: 0, timeouts: 0 };
    result.metrics.sessions = { spawned: 1, continued: 1 };
    result.metrics.qualityGate.evidenceEvents = 3;
    result.timeline = [
      {
        kind: "tool",
        text: "Calling sessions_spawn(agent_id=\"browser\")",
        tMs: 1_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "browser", task: "review dashboard" }),
        },
      },
      {
        kind: "tool",
        text: "Tool sessions_spawn returned browser context.",
        tMs: 2_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: JSON.stringify({
            status: "completed",
            final_content: "Queue depth: 11. SLA breach count: 3. Recommended owner: Incident Commander.",
          }),
        },
      },
      {
        kind: "tool",
        text: "Calling sessions_send(session_key=\"browser-session-1\")",
        tMs: 3_000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "call",
          callInput: JSON.stringify({ session_key: "browser-session-1", message: "re-check rendered dashboard" }),
        },
      },
      {
        kind: "tool",
        text: "Tool sessions_send failed: transient browser context was stale.",
        tMs: 4_000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          resultContent: "session not found: browser-session-1",
        },
      },
      {
        kind: "tool",
        text: "Calling sessions_send(session_key=\"browser-session-1\") after resolving the owning worker session.",
        tMs: 5_000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "call",
          callInput: JSON.stringify({ session_key: "worker:browser:task:TASK-1", message: "re-check rendered dashboard" }),
        },
      },
      {
        kind: "tool",
        text: "Tool sessions_send returned follow-up evidence.",
        tMs: 6_000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          resultContent: JSON.stringify({
            status: "completed",
            final_content:
              "Follow-up rendered evidence confirms Queue depth: 11, SLA breach count: 3, and owner: Incident Commander.",
          }),
        },
      },
      {
        kind: "thought",
        text: [
          "The browser follow-up recovered after a transient stale session result and then verified the rendered dashboard again.",
          "Operational state: Queue depth is 11 and SLA breach count is 3, so the escalation trigger is active.",
          "Owner: Incident Commander should take the operator handoff because the dashboard explicitly names that owner.",
          "Recommended next action: keep the incident queue in active escalation, route the next operator update to the Incident Commander, and monitor whether the SLA breach count drops after the handoff.",
          "Residual risk: this is a local rendered dashboard check, so production telemetry should still be watched before a customer-facing decision.",
        ].join(" "),
        tMs: 7_000,
      },
    ];
    result.final = result.timeline.at(-1)!;

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.deepEqual(quality.failures, []);

    result.timeline = result.timeline.filter(
      (event) => !(event.runtime?.["toolName"] === "sessions_send" && event.runtime?.["toolPhase"] === "result" && /completed/.test(String(event.runtime?.["resultContent"] ?? "")))
    );
    result.metrics.tool.results -= 1;
    result.metrics.qualityGate.evidenceEvents = 2;
    result.metrics.qualityGate.checks = [
      ...(result.metrics.qualityGate.checks ?? []).filter((check) => check.name !== "failure_free"),
      {
        name: "failure_free",
        status: "warn",
        detail:
          "2 recovery/failed tool event(s) were closed out by a bounded timeout recovery final answer; keep the replay visible for follow-up.",
      },
    ];
    const boundedCloseoutQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(boundedCloseoutQuality.failures, []);

    result.metrics.qualityGate.checks = [
      ...(result.metrics.qualityGate.checks ?? []).filter((check) => check.name !== "failure_free"),
      {
        name: "failure_free",
        status: "fail",
        detail:
          "2 recovery/failed tool event(s) require attention.",
      },
    ];
    const failureFreeOnlyAttentionQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.deepEqual(failureFreeOnlyAttentionQuality.failures, []);

    result.metrics.qualityGate.checks = (result.metrics.qualityGate.checks ?? []).filter(
      (check) => check.name !== "failure_free"
    );
    const unrecoveredQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });
    assert.ok(unrecoveredQuality.failures.includes("scenario had unrecovered failed tool results"));
  });

  it("requires natural follow-up to reuse the existing child session", () => {
    const phaseOneFinal = {
      id: "thought.phase-one",
      kind: "thought",
      text: "Vendor Alpha evidence collected.",
      tMs: 2000,
    };
    const timeline: Parameters<typeof extractTimedOutSessionKey>[0] = [
      {
        kind: "tool",
        text: "spawn result",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: JSON.stringify({ session_key: "worker:explore:alpha" }),
        },
      },
      phaseOneFinal,
      {
        kind: "tool",
        text: "send call",
        tMs: 3000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "call",
          callInput: JSON.stringify({ session_key: "worker:explore:alpha", message: "continue" }),
        },
      },
      {
        kind: "tool",
        text: "send result",
        tMs: 4000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          resultContent: "continued Vendor Alpha notes",
        },
      },
      {
        kind: "thought",
        text: "Follow-up decision note from the existing child context.",
        tMs: 5000,
      },
    ];

    assertNaturalFollowupReusedExistingSession({
      timeline,
      phaseOneFinal,
      expectedSessionKey: "worker:explore:alpha",
    });

    assertNaturalFollowupReusedExistingSession({
      timeline: [
        ...timeline.slice(0, 2),
        {
          kind: "tool",
          text: "send call with browser session id",
          tMs: 3000,
          runtime: {
            toolName: "sessions_send",
            toolPhase: "call",
            callInput: JSON.stringify({ session_key: "browser-session-abc123", message: "continue" }),
          },
        },
        {
          kind: "tool",
          text: "send result resolved to worker session",
          tMs: 4000,
          runtime: {
            toolName: "sessions_send",
            toolPhase: "result",
            resultContent: JSON.stringify({ session_key: "worker:explore:alpha", final_content: "continued" }),
          },
        },
        timeline.at(-1)!,
      ],
      phaseOneFinal,
      expectedSessionKey: "worker:explore:alpha",
    });

    assert.throws(
      () =>
        assertNaturalFollowupReusedExistingSession({
          timeline: [
            ...timeline.slice(0, 2),
            {
              kind: "tool",
              text: "duplicate spawn",
              tMs: 2500,
              runtime: {
                toolName: "sessions_spawn",
                toolPhase: "call",
                callInput: JSON.stringify({ agent_id: "explore" }),
              },
            },
            ...timeline.slice(2),
          ],
          phaseOneFinal,
          expectedSessionKey: "worker:explore:alpha",
        }),
      /must not spawn duplicate child sessions/
    );

    assert.throws(
      () =>
        assertNaturalFollowupReusedExistingSession({
          timeline,
          phaseOneFinal,
          expectedSessionKey: "worker:explore:beta",
        }),
      /reuse the phase-one session_key/
    );
  });

  it("allows bounded contract follow-up sends when they reuse the same child session", () => {
    const sessionKey = "worker:explore:task:TASK-1780270980576-6:call_function_tjy4fgvtsps9_1";
    const timeline: Parameters<typeof assertFollowupReusedSession>[0] = [
      {
        kind: "tool",
        text: "send call 1",
        tMs: 1000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "call",
          toolCallId: "call-send-1",
          callInput: JSON.stringify({ session_key: sessionKey, message: "continue" }),
        },
      },
      {
        kind: "tool",
        text: "send result 1",
        tMs: 1500,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          toolCallId: "call-send-1",
          resultContent: JSON.stringify({ session_key: sessionKey, final_content: "continued" }),
        },
      },
      {
        kind: "tool",
        text: "send call 2",
        tMs: 2000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "call",
          toolCallId: "call-send-2",
          callInput: JSON.stringify({ session_key: "worker:explore:task:TASK-1780270980576-6:call_function_tj", message: "complete final report" }),
        },
      },
      {
        kind: "tool",
        text: "send result 2",
        tMs: 2500,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          toolCallId: "call-send-2",
          resultContent: JSON.stringify({ session_key: sessionKey, final_content: "complete" }),
        },
      },
    ];

    assert.doesNotThrow(() => assertFollowupReusedSession(timeline, sessionKey));
  });

  it("rejects contract follow-up sends that switch child sessions", () => {
    const timeline: Parameters<typeof assertFollowupReusedSession>[0] = [
      {
        kind: "tool",
        text: "send call",
        tMs: 1000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "call",
          toolCallId: "call-send",
          callInput: JSON.stringify({ session_key: "worker:explore:other", message: "continue" }),
        },
      },
      {
        kind: "tool",
        text: "send result",
        tMs: 1500,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          toolCallId: "call-send",
          resultContent: JSON.stringify({ session_key: "worker:explore:other" }),
        },
      },
    ];

    assert.throws(
      () => assertFollowupReusedSession(timeline, "worker:explore:alpha"),
      /address the phase-one session_key/
    );
  });

  it("rejects contract follow-up sends without unique call/result correlation ids", () => {
    const sessionKey = "worker:explore:task:TASK-1780270980576-6:call_function_tjy4fgvtsps9_1";
    const timeline: Parameters<typeof assertFollowupReusedSession>[0] = [
      {
        kind: "tool",
        text: "send call 1",
        tMs: 1000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "call",
          toolCallId: "call-send",
          callInput: JSON.stringify({ session_key: sessionKey, message: "continue" }),
        },
      },
      {
        kind: "tool",
        text: "send call 2",
        tMs: 1100,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "call",
          toolCallId: "call-send",
          callInput: JSON.stringify({ session_key: sessionKey, message: "continue again" }),
        },
      },
      {
        kind: "tool",
        text: "send result",
        tMs: 1500,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          toolCallId: "call-send",
          resultContent: JSON.stringify({ session_key: sessionKey, final_content: "continued" }),
        },
      },
    ];

    assert.throws(() => assertFollowupReusedSession(timeline, sessionKey), /unique toolCallId/);
  });

  it("builds a distinct natural E2E report envelope", () => {
    const fixtureManifest = buildNaturalFixtureReportManifest({
      server: undefined as never,
      basicUrl: "http://127.0.0.1:51234/basic",
      alphaUrl: "http://127.0.0.1:51234/vendor-alpha",
      betaUrl: "http://127.0.0.1:51234/vendor-beta",
      providerSearchPricingUrl: "http://127.0.0.1:51234/deepseek-v4-flash",
      slowUrl: "http://127.0.0.1:51234/slow-fixture",
      slowReleaseUrl: "http://127.0.0.1:51234/slow-release-fixture",
      cancelResumeUrl: "http://127.0.0.1:51234/cancel-resume-fixture",
      cancelResumeStateUrl: "http://127.0.0.1:51234/__cancel-resume-state",
      cancelResumeReleaseUrl: "http://127.0.0.1:51234/cancel-resume-release-fixture",
      approvalUrl: "http://127.0.0.1:51234/approval-form",
      dynamicUrl: "http://127.0.0.1:51234/dynamic-fixture",
      dashboardUrl: "http://127.0.0.1:51234/ops-dashboard",
      complexBrowserUrl: "http://127.0.0.1:51234/complex-browser",
      orchestrationUrl: "http://127.0.0.1:51234/product-orchestration",
      bridgeUrl: "http://127.0.0.1:51234/product-bridge",
      productSignalsUrl: "http://127.0.0.1:51234/product-signals",
      asiawalkRouteUrl: "http://127.0.0.1:51234/asiawalk-route",
      asiawalkBudgetUrl: "http://127.0.0.1:51234/asiawalk-budget",
      asiawalkLiveUrl: "http://127.0.0.1:51234/asiawalk-live",
      fixtureContentHashes: {
        "http://<loopback-host>:<loopback-port>/ops-dashboard": "sha256:dashboard",
      },
    });
    const report = buildNaturalMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 5),
      results: [fakeNaturalResult()],
      modelProvenance: {
        modelCatalogPath: "/tmp/models.local.json",
        provider: "minimax",
        modelId: "MiniMax-Text-01",
        modelEntryId: "minimax-text",
      },
      scenarioTimeoutMs: 180_000,
      fixtureContentHashes: {
        "http://<loopback-host>:<loopback-port>/ops-dashboard": "sha256:dashboard",
      },
      fixtureManifest,
    });

    assert.equal(report.kind, "turnkeyai.natural-mission-e2e.report");
    assert.equal(report.evidenceMode, "natural-real-llm");
    assert.equal(report.progressClaim, "natural-evidence");
    assert.equal(report.capabilityClaim, "unproven-without-comparative-evidence");
    assert.equal(report.provider, "minimax");
    assert.equal(report.modelId, "MiniMax-Text-01");
    assert.equal(report.modelEntryId, "minimax-text");
    assert.equal(report.modelCatalogPath, "/tmp/models.local.json");
    assert.equal(report.timeoutPolicy?.scenarioTimeoutMs, 180_000);
    assert.equal(report.fixtureContentHashes?.["http://<loopback-host>:<loopback-port>/ops-dashboard"], "sha256:dashboard");
    assert.equal(report.fixtureManifest?.lifecycle.serverScope, "mission-e2e-process");
    assert.equal(
      report.fixtureManifest?.lifecycle.replayRequirement,
      "urls-must-be-reachable-before-reference-collection"
    );
    assert.equal(report.fixtureManifest?.urls.dashboardUrl, "http://127.0.0.1:51234/ops-dashboard");
    assert.equal(
      report.fixtureManifest?.comparableUrls.dashboardUrl,
      "http://<loopback-host>:<loopback-port>/ops-dashboard"
    );
    assert.equal(
      report.fixtureManifest?.fixtureContentHashes["http://<loopback-host>:<loopback-port>/ops-dashboard"],
      "sha256:dashboard"
    );
    assert.equal(report.promptPolicy.forbidsContractGateLanguage, true);
    assert.ok(report.promptPolicy.forbiddenPatterns.some((pattern) => pattern.includes("exactly once")));
    assert.ok(report.requiredQualitySignals.includes("source-backed-evidence"));
    assert.ok(report.requiredQualitySignals.includes("residual-risk-visible"));
    assert.ok(report.requiredQualitySignals.includes("no-unsupported-claims"));
    assert.ok(report.requiredQualitySignals.includes("browser-profile-fallback-policy"));
    assert.ok(report.requiredQualitySignals.includes("browser-failure-bucket-policy"));
    assert.ok(report.requiredQualitySignals.includes("root-cause-dimension-scores"));
    assert.ok(report.requiredQualitySignals.includes("failure-bucket-attribution"));
    assert.equal(report.status, "passed");
    assert.equal(report.failureCollectionMode, "fail-fast");
    assert.equal(report.scenarioCount, 1);
    assert.deepEqual(report.scenarioIds, ["natural-browser-dynamic-page"]);
    assert.equal(report.passedScenarios, 1);
    assert.equal(report.failedScenarios, 0);
    assert.equal(report.durationMs, 5000);
    assert.equal(report.scenarios[0]?.scenario, "natural-browser-dynamic-page");
    assert.equal(report.scenarios[0]?.durationMs, 3210);
    assert.equal(report.scenarios[0]?.prompt, "Review this operations dashboard as a user would see it in the browser.");
    assert.equal(report.scenarios[0]?.qualityGate, "passed");
    assert.equal(report.scenarios[0]?.missionQualityGate, "passed");
    assert.equal(report.scenarios[0]?.artifacts.count, 1);
    assert.equal(report.scenarios[0]?.artifacts.withLifecycle, 1);
    assert.equal(report.scenarios[0]?.natural.profileFallbackFree, true);
    assert.deepEqual(report.scenarios[0]?.natural.dimensionScores, {
      taskCompletion: 2,
      evidenceQuality: 2,
      toolUseAppropriateness: 2,
      browserAuthenticity: 2,
      subAgentIndependence: 2,
      continuationBehavior: 2,
      permissionCorrectness: 2,
      timeoutCloseoutQuality: 2,
    });
    assert.deepEqual(report.scenarios[0]?.natural.failureBuckets, []);
    assert.deepEqual(report.scenarios[0]?.natural.sourceCoverage, {
      answerTerms: { covered: 2, total: 2, missing: [] },
      answerPatterns: { covered: 0, total: 0, missing: [] },
      evidencePatterns: { covered: 1, total: 1, missing: [] },
      evidenceEvents: { observed: 1, required: 1 },
      residualRiskVisible: true,
      unsupportedClaims: [],
    });
    assert.equal(report.scenarios[0]?.metrics.browser.profileFallbacks, 0);
  });

  it("keeps complete natural matrix evidence when quality failures are collected", () => {
    const passing = fakeNaturalResult();
    const failed = fakeNaturalResult();
    failed.scenario = "natural-approval-dry-run-action";
    failed.mission.id = "msn.natural.failed.1";
    failed.quality.status = "failed";
    failed.quality.failures = ["weak answer signals: browser evidence blocked"];
    failed.quality.weakAnswerSignals = ["browser evidence blocked"];
    failed.quality.dimensionScores.evidenceQuality = 1;
    failed.quality.failureBuckets = ["answer_quality", "browser_reliability"];

    const report = buildNaturalMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 7),
      results: [passing, failed],
      failureCollectionMode: "quality-failures-collected",
    });

    assert.equal(report.status, "failed");
    assert.equal(report.failureCollectionMode, "quality-failures-collected");
    assert.equal(report.scenarioCount, 2);
    assert.equal(report.passedScenarios, 1);
    assert.equal(report.failedScenarios, 1);
    assert.deepEqual(report.scenarioIds, ["natural-browser-dynamic-page", "natural-approval-dry-run-action"]);
    assert.equal(report.scenarios[1]?.natural.status, "failed");
    assert.deepEqual(report.scenarios[1]?.natural.failures, ["weak answer signals: browser evidence blocked"]);
    assert.deepEqual(report.scenarios[1]?.natural.failureBuckets, ["answer_quality", "browser_reliability"]);
  });

  it("preserves partial natural matrix evidence when a later scenario throws", () => {
    const passing = fakeNaturalResult();

    const report = buildNaturalMissionPartialFailureJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 7),
      results: [passing],
      interruptedScenario: {
        scenario: "natural-approval-dry-run-action",
        error: "mission reached done before requesting approval",
      },
    });

    assert.equal(report.status, "failed");
    assert.equal(report.failureCollectionMode, "partial-failure-collected");
    assert.equal(report.scenarioCount, 1);
    assert.equal(report.passedScenarios, 1);
    assert.equal(report.failedScenarios, 0);
    assert.deepEqual(report.scenarioIds, ["natural-browser-dynamic-page"]);
    assert.deepEqual(report.interruptedScenario, {
      scenario: "natural-approval-dry-run-action",
      completedScenarioCount: 1,
      error: "mission reached done before requesting approval",
    });
    assert.deepEqual(report.interruptedScenarios, [
      {
        scenario: "natural-approval-dry-run-action",
        completedScenarioCount: 1,
        error: "mission reached done before requesting approval",
      },
    ]);
  });

  it("preserves multiple interrupted natural matrix scenarios for continue-on-failure collection", () => {
    const passing = fakeNaturalResult();

    const report = buildNaturalMissionPartialFailureJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 7),
      results: [passing],
      interruptedScenarios: [
        {
          scenario: "natural-memory-pressure-flush",
          error: "natural mission blocked before completion",
        },
        {
          scenario: "natural-cancel-active-tool",
          error: "mission did not complete within 240000ms",
        },
      ],
    });

    assert.equal(report.status, "failed");
    assert.equal(report.failureCollectionMode, "partial-failure-collected");
    assert.equal(report.scenarioCount, 1);
    assert.equal(report.passedScenarios, 1);
    assert.equal(report.failedScenarios, 0);
    assert.deepEqual(report.interruptedScenarios, [
      {
        scenario: "natural-memory-pressure-flush",
        completedScenarioCount: 1,
        error: "natural mission blocked before completion",
      },
      {
        scenario: "natural-cancel-active-tool",
        completedScenarioCount: 1,
        error: "mission did not complete within 240000ms",
      },
    ]);
  });

  it("fails natural quality on weak fallback answers and missing browser evidence", () => {
    const result = fakeNaturalResult();
    result.metrics.sessions.spawned = 0;
    result.metrics.tool.results = 0;
    result.timeline = [];
    result.final.text = "The search tool is unavailable, so based on my knowledge this is probably fine.";

    const quality = evaluateNaturalMissionQuality({
      spec: {
        scenario: "natural-browser-dynamic-page",
        title: "Browser page",
        desc: "Review a browser page.",
        minBytes: 120,
        minToolResults: 1,
        maxToolResults: 6,
        minSpawnedSessions: 1,
        maxSpawnedSessions: 3,
        requiresBrowser: true,
        requiresApproval: false,
        allowToolFailure: false,
        minEvidenceEvents: 1,
        requiredAnswerTerms: ["Queue depth"],
      },
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });

    assert.equal(quality.status, "failed");
    assert.ok(quality.failures.some((failure) => failure.includes("browser")));
    assert.ok(quality.weakAnswerSignals.includes("tool unavailable fallback"));
    assert.ok(quality.weakAnswerSignals.includes("model-knowledge fallback"));
    assert.equal(quality.dimensionScores.browserAuthenticity, 0);
    assert.equal(quality.dimensionScores.evidenceQuality, 0);
    assert.ok(quality.failureBuckets.includes("browser_reliability"));
    assert.ok(quality.failureBuckets.includes("answer_quality"));
  });

  it("reports structured natural source coverage gaps for missing evidence and unsupported claims", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-browser-dynamic-page", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
      }),
      requiredAnswerTerms: ["Active users", "Queue depth", "owner", "residual risk"],
      forbiddenPatterns: [
        { label: "unsupported rendered queue depth", pattern: /Queue depth[\s\S]{0,80}\b11\b/i },
      ],
    };
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: "Active users: 42. The page rendered only one dashboard metric.",
    };
    result.metrics.qualityGate.evidenceEvents = 1;
    result.final.text = [
      "Active users: 42 were verified in the browser.",
      "Queue depth: 11 looks fine, and there is no residual risk.",
      "This answer is long enough to isolate the source coverage failure from the usefulness failure.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.status, "failed");
    assert.deepEqual(quality.sourceCoverage.answerTerms, {
      covered: 3,
      total: 4,
      missing: ["owner"],
    });
    assert.equal(quality.sourceCoverage.evidencePatterns.total > 0, true);
    assert.ok(quality.sourceCoverage.evidencePatterns.missing.includes("rendered queue depth"));
    assert.ok(quality.sourceCoverage.unsupportedClaims.includes("unsupported rendered queue depth"));
    assert.equal(quality.sourceCoverage.residualRiskVisible, true);
    assert.ok(quality.failures.includes("missing evidence rendered queue depth"));
    assert.ok(quality.failures.includes("forbidden unsupported rendered queue depth"));
  });

  it("does not give full natural completion credit when mission source coverage warns", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-asiawalk-multi-agent", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
      asiawalkRouteUrl: "http://127.0.0.1/asiawalk-route",
      asiawalkBudgetUrl: "http://127.0.0.1/asiawalk-budget",
      asiawalkLiveUrl: "http://127.0.0.1/asiawalk-live",
    });
    result.scenario = "natural-asiawalk-multi-agent";
    result.metrics.tool = { requested: 3, results: 3, failed: 0, cancelled: 0, timeouts: 0 };
    result.metrics.sessions = { spawned: 3, continued: 0 };
    result.metrics.qualityGate.evidenceEvents = 3;
    result.metrics.qualityGate.checks = [
      { name: "final_answer", status: "pass", detail: "Lead final answer is present." },
      {
        name: "source_coverage",
        status: "warn",
        detail:
          "Final answer does not cover every visible source label: AsiaWalk Route Stream, AsiaWalk Budget Stream, AsiaWalk Live Readiness Stream.",
      },
    ];
    result.final.text = [
      "AsiaWalk pilot recommendation: proceed with a Seoul, Taipei, and Tokyo pilot.",
      "Verified route, budget, and live readiness facts are summarized from the source evidence.",
      "Residual risk: production availability and partner confirmations remain unverified.",
      "Next action: confirm operators and lock the final route before launch.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.status, "failed");
    assert.equal(quality.finalAnswerHasEvidence, false);
    assert.equal(quality.dimensionScores.taskCompletion, 1);
    assert.equal(quality.dimensionScores.evidenceQuality, 0);
    assert.ok(
      quality.failures.some((failure) =>
        failure.includes("mission quality gate source_coverage warn: Final answer does not cover every visible source label")
      )
    );
    assert.ok(quality.failureBuckets.includes("answer_quality"));
    assert.ok(quality.failureBuckets.includes("runtime_lifecycle"));
  });

  it("counts recommendation wording as the recommend answer term without weakening evidence checks", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-comparison-research", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
      }),
      requiredAnswerTerms: ["Alpha", "Beta", "$19", "$29", "recommend", "risk"],
    };
    result.metrics.tool = { requested: 2, results: 2, failed: 0, cancelled: 0, timeouts: 0 };
    result.metrics.sessions = { spawned: 2, continued: 0 };
    result.metrics.qualityGate.evidenceEvents = 2;
    result.timeline = [
      {
        kind: "tool",
        text: "Tool sessions_spawn returned Vendor Alpha evidence.",
        tMs: 1_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent:
            "Vendor Alpha costs $19 per seat. Strength: browser automation. Risk: limited API integration catalog.",
        },
      },
      {
        kind: "tool",
        text: "Tool sessions_spawn returned Vendor Beta evidence.",
        tMs: 2_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent:
            "Vendor Beta costs $29 per workspace. Strength: approval workflow. Risk: browser control needs a separate connector.",
        },
      },
    ];
    result.final.text = [
      "Vendor Alpha costs $19 per seat and has a risk around its limited API integration catalog.",
      "Vendor Beta costs $29 per workspace and its risk is that browser control needs a separate connector.",
      "The recommendation is to choose Alpha for a lower-cost browser automation trial, while choosing Beta when approval workflows matter more.",
      "Residual risk: user scale and broader integration depth remain not verified from the supplied sources.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.deepEqual(quality.sourceCoverage.answerTerms, {
      covered: 6,
      total: 6,
      missing: [],
    });
    assert.equal(quality.finalAnswerHasEvidence, true);
    assert.equal(quality.status, "passed");
  });

  it("treats provider option and limitation wording as decision-useful without weakening evidence checks", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-provider-search-pricing", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      providerSearchPricingUrl: "http://127.0.0.1/deepseek-provider-pricing",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.metrics.tool = { requested: 1, results: 1, failed: 0, cancelled: 0, timeouts: 0 };
    result.metrics.sessions = { spawned: 1, continued: 0 };
    result.metrics.qualityGate.evidenceEvents = 1;
    result.timeline = [
      {
        kind: "tool",
        text: "Tool sessions_spawn returned DeepSeek V4 Flash provider evidence.",
        tMs: 1_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent:
            "DeepSeek V4 Flash provider source: OpenRouter has a web_search option; Together and Fireworks require search to be supplied externally. Pricing $0.28/$0.42, $0.20/$0.40, $0.25/$0.45.",
        },
      },
    ];
    result.final.text = [
      "## DeepSeek V4 Flash API Provider Note",
      "Evidence source: http://127.0.0.1/deepseek-provider-pricing.",
      "OpenRouter lists DeepSeek V4 Flash, supports web_search, and costs $0.28 input / $0.42 output per 1M tokens.",
      "Together lists DeepSeek V4 Flash, has no provider-native search support, and costs $0.20 input / $0.40 output per 1M tokens.",
      "Fireworks lists DeepSeek V4 Flash, has no provider-native search support, and costs $0.25 input / $0.45 output per 1M tokens.",
      "Lowest-cost option: Together on both input and output tokens.",
      "Search-support option: OpenRouter, because the source names a web_search option.",
      "Main limitation for a production decision: this is local fixture evidence; verify provider docs for freshness before launch use.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.finalAnswerHasEvidence, true);
    assert.equal(quality.finalAnswerUseful, true);
    assert.ok(!quality.failures.includes("final answer is too thin or not decision-useful"));
  });

  it("counts go/no-go decisions as the recommend answer term without exact wording", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-comparison-research", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
      }),
      requiredAnswerTerms: ["Alpha", "Beta", "$19", "$29", "recommend", "risk"],
    };
    result.metrics.tool = { requested: 2, results: 2, failed: 0, cancelled: 0, timeouts: 0 };
    result.metrics.sessions = { spawned: 2, continued: 0 };
    result.metrics.qualityGate.evidenceEvents = 2;
    result.timeline = [
      {
        kind: "tool",
        text: "Tool sessions_spawn returned Vendor Alpha evidence.",
        tMs: 1_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent:
            "Vendor Alpha costs $19 per seat. Strength: browser automation. Risk: limited API integration catalog.",
        },
      },
      {
        kind: "tool",
        text: "Tool sessions_spawn returned Vendor Beta evidence.",
        tMs: 2_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent:
            "Vendor Beta costs $29 per workspace. Strength: approval workflow. Risk: browser control needs a separate connector.",
        },
      },
    ];
    result.final.text = [
      "Vendor Alpha costs $19 per seat and has a risk around its limited API integration catalog.",
      "Vendor Beta costs $29 per workspace and its risk is that browser control needs a separate connector.",
      "Go/No-Go: Conditional go for Alpha when the goal is a lower-cost browser automation trial; choose Beta when approval workflows matter more.",
      "Residual risk: user scale and broader integration depth remain not verified from the supplied sources.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.deepEqual(quality.sourceCoverage.answerTerms, {
      covered: 6,
      total: 6,
      missing: [],
    });
    assert.equal(quality.finalAnswerHasEvidence, true);
    assert.equal(quality.status, "passed");
  });

  it("does not treat concrete source-bounded estimates as placeholder uncertainty", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-comparison-research", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
      }),
      requiredAnswerTerms: ["Alpha", "Beta", "$19", "$29", "recommend", "risk"],
    };
    result.metrics.tool = { requested: 2, results: 2, failed: 0, cancelled: 0, timeouts: 0 };
    result.metrics.sessions = { spawned: 2, continued: 0 };
    result.metrics.qualityGate.evidenceEvents = 2;
    result.timeline = [
      {
        kind: "tool",
        text: "Tool sessions_spawn returned Vendor Alpha evidence.",
        tMs: 1_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent:
            "Vendor Alpha costs $19 per seat. Estimated trial budget: $1,280 total. Risk: limited API integration catalog.",
        },
      },
      {
        kind: "tool",
        text: "Tool sessions_spawn returned Vendor Beta evidence.",
        tMs: 2_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent:
            "Vendor Beta costs $29 per workspace. Strength: approval workflow. Risk: browser control needs a separate connector.",
        },
      },
    ];
    result.final.text = [
      "Vendor Alpha costs $19 per seat. Estimated trial budget: $1,280 total. Risk: limited API integration catalog.",
      "Vendor Beta costs $29 per workspace. Risk: browser control needs a separate connector.",
      "Recommendation: choose Alpha for the lower-cost browser automation trial.",
      "Residual risk: local fixture evidence only.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.weakAnswerSignals.includes("placeholder uncertainty"), false);
  });

  it("does not treat action-gated pending confirmation as placeholder uncertainty", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-asiawalk-multi-agent", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
      asiawalkRouteUrl: "http://127.0.0.1/asiawalk-route",
      asiawalkBudgetUrl: "http://127.0.0.1/asiawalk-budget",
      asiawalkLiveUrl: "http://127.0.0.1/asiawalk-live",
    });
    result.scenario = "natural-asiawalk-multi-agent";
    result.metrics.tool = { requested: 3, results: 3, failed: 0, cancelled: 0, timeouts: 0 };
    result.metrics.sessions = { spawned: 3, continued: 0 };
    result.metrics.qualityGate.evidenceEvents = 3;
    result.timeline = [
      {
        kind: "tool",
        text: "route source",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: "Route: Seoul orientation walk, Taipei loop, Tokyo finale. Risk: evening crowd control.",
        },
      },
      {
        kind: "tool",
        text: "budget source",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: "Budget: $1,280 total with $180 contingency. Risk: guide availability before deposits.",
        },
      },
      {
        kind: "tool",
        text: "live readiness source",
        tMs: 3000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: "Readiness: yellow. Live risks: rain risk in Taipei and metro maintenance in Tokyo.",
        },
      },
    ];
    result.final.text = [
      "AsiaWalk pilot recommendation: Conditional GO.",
      "Route shape: Seoul orientation walk, Taipei food-and-transit loop, and Tokyo neighborhood finale.",
      "Budget: $1,280 total with a $180 contingency buffer.",
      "Readiness risks: rain risk in Taipei, metro maintenance in Tokyo, and Tokyo evening crowd control.",
      "Launch is held pending confirmation of Taipei indoor alternates, Tokyo transfer buffer, and guide availability before deposits.",
      "Next action: confirm indoor alternates and lock guides before deposits.",
      "Residual risk: local readiness fixture only.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.weakAnswerSignals.includes("placeholder uncertainty"), false);
    assert.equal(quality.failures.some((failure) => failure.includes("placeholder uncertainty")), false);
  });

  it("counts Chinese source-backed wording as verified answer evidence", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-followup-continuation", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
      }),
      requiredAnswerTerms: ["Alpha", "$19", "risk", "verified"],
    };
    result.metrics.tool = { requested: 4, results: 4, failed: 0, cancelled: 0, timeouts: 0 };
    result.metrics.sessions = { spawned: 1, continued: 1 };
    result.metrics.qualityGate.evidenceEvents = 3;
    result.final.text = [
      "## Vendor Alpha — 决策备注",
      "**来源：** http://127.0.0.1/vendor-alpha",
      "**定价：** $19 per seat — 原文明确显示。",
      "**风险：** API 集成目录规模仍然有限，原文明确列为 risk。",
      "**建议：** 若用例以浏览器自动化为核心，则可继续评估 Alpha。",
      "**Residual risk:** 仅覆盖本地来源，外部生产可用性未验证。",
    ].join("\n");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.deepEqual(quality.sourceCoverage.answerTerms, {
      covered: 4,
      total: 4,
      missing: [],
    });
  });

  it("fails natural quality when completed browser evidence is degraded or unverified", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-browser-dynamic-page", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
      }),
      requiredEvidencePatterns: [],
      requiredAnswerPatterns: [],
    };
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: [
        "Tool sessions_spawn returned:",
        '{ "status": "completed", "final_content": "Verification Status: FAILED - could not access pricing data. Cloudflare Turnstile blocked the page. Anthropic content extraction incomplete due to session lease conflict and budget truncation. All pricing numbers are not verified." }',
      ].join("\n"),
    };
    result.metrics.qualityGate.evidenceEvents = 2;
    result.final.text = [
      "Queue depth is 11 with 3 SLA breaches.",
      "Incident Commander should own the escalation.",
      "The recommended next action is to prioritize browser-visible operator evidence and describe residual risk.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.status, "failed");
    assert.ok(quality.weakAnswerSignals.includes("browser evidence blocked"));
    assert.ok(quality.weakAnswerSignals.includes("browser extraction failed"));
    assert.ok(quality.weakAnswerSignals.includes("browser evidence not verified"));
    assert.ok(quality.weakAnswerSignals.includes("browser transport degraded"));
    assert.ok(
      quality.failures.some((failure) => failure.includes("weak answer signals")),
      "degraded evidence must be a blocking natural quality signal"
    );
  });

  it("accepts browser evidence that explicitly negates blockers", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-browser-external-page-review", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
        externalPageUrl: "https://news.ycombinator.com/",
      }),
      requiredEvidencePatterns: [],
      requiredAnswerPatterns: [],
      requiredAnswerTerms: [],
      minBytes: 80,
    };
    result.scenario = "natural-browser-external-page-review";
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: [
        "Hacker News visible listing evidence with navigation links, comments, and points.",
        "Rendering status: Loaded cleanly; no interstitial blocks, captchas, paywall, cookie banner, or redirect observed.",
        "No redirect, block, or captcha observed during this run.",
        "| Site blocked access | No - fully loaded |",
        "| Redirected to another domain | No - URL remained on the target site |",
      ].join("\n"),
    };
    result.metrics.qualityGate.evidenceEvents = 2;
    result.final.text = [
      "Hacker News is a live external page with visible story listings and navigation cues.",
      "Visible items include navigation links such as new, past, comments, ask, show, jobs, submit, and login.",
      "Visible page evidence also includes comment and point cues on story rows, so the page purpose is user-ranked discussion rather than a static article.",
      "No blocking, captchas, or forced auth; page fully rendered.",
      "Transport degradation checked: transport_failure not observed; lease conflict not observed; result truncation not observed; snapshot truncation not observed; browser transport degradation not observed.",
      "Verification status: Site blocked access | No - fully loaded; Redirected to another domain | No.",
      "Next action: treat this as a current browser-visible snapshot for triage or browsing context, not as durable research evidence.",
      "Residual risk: live external content can change; login behavior, vote actions, deeper scroll content, and interaction outcomes remain unverified.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.weakAnswerSignals.includes("browser evidence blocked"), false);
    assert.equal(quality.weakAnswerSignals.includes("browser transport degraded"), false);
    assert.deepEqual(quality.failures, []);
    assert.equal(quality.status, "passed");
  });

  it("counts concrete external-page items as visible answer evidence", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-external-page-review", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
      externalPageUrl: "https://news.ycombinator.com/",
    });
    result.scenario = "natural-browser-external-page-review";
    result.metrics.qualityGate.evidenceEvents = 1;
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent:
        "Hacker News browser evidence: top stories, points, comments, and navigation links were captured.",
    };
    result.final.text = [
      "Page purpose: Hacker News is a technology and startup news aggregator with ranked discussion links.",
      "Verified concrete items: top stories include Gemma 4 and Elixir v1.20 with points and comments, so this is a live listing surface rather than a static article.",
      "Navigation links: new, past, comments, ask, show, jobs, submit, and login were present in the captured page state.",
      "Decision-useful takeaway: treat the result as a current browser-visible snapshot for browsing context or source discovery, not as durable historical evidence.",
      "Residual risk: page content is live and changing, lower scroll depth was not verified, and login-only actions or voting behavior were not tested.",
    ].join("\n");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.deepEqual(quality.sourceCoverage.answerTerms, { covered: 3, total: 3, missing: [] });
    assert.deepEqual(quality.failures, []);
    assert.equal(quality.status, "passed");
  });

  it("accepts structured browser blocker fields when they carry falsey values", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-browser-external-page-review", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
        externalPageUrl: "https://news.ycombinator.com/",
      }),
      requiredEvidencePatterns: [],
      requiredAnswerPatterns: [],
      requiredAnswerTerms: [],
      minBytes: 80,
    };
    result.scenario = "natural-browser-external-page-review";
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: [
        "Hacker News loaded with visible story listings, points, comments, and navigation links.",
        "Blocked elements: none.",
        "Captcha: false.",
        "Redirect: 0.",
        '{"blocked": false, "captcha": false, "redirect": false, "block_detected": false, "captchaDetected": false}',
      ].join("\n"),
    };
    result.final.text = [
      "Hacker News loaded with visible story listings, comment cues, points, and navigation links.",
      "The browser status fields reported blocked elements: none, captcha: false, and redirect: 0.",
      "Residual risk: live external content can change and login-only actions remain unverified.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.weakAnswerSignals.includes("browser evidence blocked"), false);
    assert.deepEqual(quality.failures, []);
    assert.equal(quality.status, "passed");
  });

  it("accepts natural not-blocked browser status wording", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-browser-external-page-review", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
        externalPageUrl: "https://news.ycombinator.com/",
      }),
      requiredEvidencePatterns: [],
      requiredAnswerPatterns: [],
      requiredAnswerTerms: [],
      minBytes: 80,
    };
    result.scenario = "natural-browser-external-page-review";
    result.metrics.qualityGate.evidenceEvents = 1;
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: [
        "Hacker News loaded with visible story listings, points, comments, and navigation links.",
        "Site was not blocked and page was not redirected.",
        "blocked status: false; captcha observed: not present; challenge state: none.",
      ].join("\n"),
    };
    result.final.text = [
      "Hacker News loaded with visible story listings, comment cues, points, and navigation links.",
      "The browser result reports the site was not blocked, not redirected, and did not show a captcha challenge.",
      "Residual risk: live external content can change and login-only actions remain unverified.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.weakAnswerSignals.includes("browser evidence blocked"), false);
    assert.deepEqual(quality.failures, []);
    assert.equal(quality.status, "passed");
  });

  it("accepts browser evidence when metrics retain a recovered successful timeout", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-browser-external-page-review", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
        externalPageUrl: "https://news.ycombinator.com/",
      }),
      minBytes: 80,
    };
    result.scenario = "natural-browser-external-page-review";
    result.metrics.tool.requested = 1;
    result.metrics.tool.results = 1;
    result.metrics.tool.failed = 0;
    result.metrics.tool.timeouts = 1;
    result.metrics.recovery.events = 0;
    result.metrics.qualityGate.status = "passed";
    result.metrics.qualityGate.evidenceEvents = 1;
    result.metrics.qualityGate.checks = [
      { name: "tool_loop_closeout", status: "pass", detail: "Final answer synthesized from completed sub-agent final content." },
      { name: "failure_free", status: "pass", detail: "No recovery or failed tool-result event is present." },
    ];
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: [
        "Hacker News loaded in the browser with visible story listings.",
        "Visible items include 265 points and 76 comments on one story, plus navigation links for new, past, comments, ask, show, jobs, submit, and login.",
      ].join("\n"),
    };
    result.final.text = [
      "Hacker News is a live external page with visible story listings and navigation cues.",
      "Visible items include one story with 265 points and 76 comments, plus navigation links such as new, past, comments, ask, show, jobs, submit, and login.",
      "Next action: use this as a current browser-visible snapshot, not a durable source of historical facts.",
      "Residual risk: live external content can change and login-only actions remain unverified.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.status, "passed");
    assert.deepEqual(quality.failures, []);
    assert.equal(quality.dimensionScores.timeoutCloseoutQuality, 2);
  });

  it("rejects retained timeout metrics when successful browser evidence is not clean", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-browser-external-page-review", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
        externalPageUrl: "https://news.ycombinator.com/",
      }),
      minBytes: 80,
    };
    result.scenario = "natural-browser-external-page-review";
    result.metrics.tool.requested = 1;
    result.metrics.tool.results = 1;
    result.metrics.tool.failed = 0;
    result.metrics.tool.timeouts = 1;
    result.metrics.qualityGate.status = "blocked";
    result.metrics.qualityGate.evidenceEvents = 0;
    result.metrics.qualityGate.checks = [
      { name: "tool_loop_closeout", status: "warn", detail: "Timeout remains visible without recovered evidence." },
      { name: "failure_free", status: "fail", detail: "Timed-out tool result needs operator attention." },
    ];
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: "The browser timed out before collecting page evidence.",
    };
    result.final.text = "The browser timed out. Residual risk remains because Hacker News was not verified.";

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.status, "failed");
    assert.ok(quality.failures.includes("scenario had timed-out tool results"));
  });

  it("does not treat browser-block wording in tool call input as evidence", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-browser-external-page-review", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
        externalPageUrl: "https://news.ycombinator.com/",
      }),
      requiredEvidencePatterns: [],
      requiredAnswerPatterns: [],
      requiredAnswerTerms: [],
      minBytes: 80,
    };
    result.scenario = "natural-browser-external-page-review";
    result.timeline[0]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "call",
      callInput: JSON.stringify({
        agent_id: "browser",
        task: "If the site blocks the browser, report the blocker instead of guessing.",
      }),
    };
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: [
        "Hacker News visible listing evidence with navigation links, comments, and points.",
        "No redirects, captchas, paywalls, or blocks were observed.",
      ].join("\n"),
    };
    result.final.text = [
      "Hacker News loaded with visible story listings, comment cues, points, and navigation links.",
      "The browser result reports no redirects, captchas, paywalls, or blocks during this run.",
      "Residual risk: live external content can change and login-only actions remain unverified.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.weakAnswerSignals.includes("browser evidence blocked"), false);
    assert.deepEqual(quality.failures, []);
    assert.equal(quality.status, "passed");
  });

  it("does not treat skipped tool results as evidence", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-browser-external-page-review", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
        externalPageUrl: "https://news.ycombinator.com/",
      }),
      requiredEvidencePatterns: [],
      requiredAnswerPatterns: [],
      requiredAnswerTerms: [],
      minBytes: 80,
    };
    result.scenario = "natural-browser-external-page-review";
    result.timeline.unshift({
      kind: "tool",
      text: "skipped browser result",
      tMs: 500,
      runtime: {
        toolName: "sessions_spawn",
        toolPhase: "result",
        admission: "skipped",
        resultContent: "Skipped stale tool result said Cloudflare blocked the browser.",
      },
    });
    result.timeline[2]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: "Hacker News loaded normally. No redirects, captchas, paywalls, or blocks were observed.",
    };
    result.final.text = [
      "Hacker News loaded with visible story listings, comment cues, points, and navigation links.",
      "The current browser result reports no redirects, captchas, paywalls, or blocks during this run.",
      "Residual risk: live external content can change and login-only actions remain unverified.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.weakAnswerSignals.includes("browser evidence blocked"), false);
    assert.deepEqual(quality.failures, []);
    assert.equal(quality.status, "passed");
  });

  it("does not join browser evidence lines with unrelated blocked wording", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-browser-external-page-review", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
        externalPageUrl: "https://news.ycombinator.com/",
      }),
      requiredEvidencePatterns: [],
      requiredAnswerPatterns: [],
      requiredAnswerTerms: [],
      minBytes: 80,
    };
    result.scenario = "natural-browser-external-page-review";
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: [
        "Browser observed Hacker News page with story listings, points, comments, and navigation links.",
        "A separate safety note says a hypothetical submit action would be blocked before side effects.",
      ].join("\n"),
    };
    result.final.text = [
      "Hacker News loaded with visible story listings, comment cues, points, and navigation links.",
      "The current browser result did not report a page blocker, captcha, or redirect.",
      "Residual risk: live external content can change and login-only actions remain unverified.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.weakAnswerSignals.includes("browser evidence blocked"), false);
    assert.deepEqual(quality.failures, []);
    assert.equal(quality.status, "passed");
  });

  it("accepts recovered transport failure when final answer keeps the browser limitation visible", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-external-page-review", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
      externalPageUrl: "https://news.ycombinator.com/",
    });
    result.scenario = "natural-browser-external-page-review";
    result.metrics.browser = {
      ...result.metrics.browser,
      failureBuckets: [{ bucket: "transport_failure", count: 1, latestAtMs: 2_000 }],
    };
    result.metrics.qualityGate.evidenceEvents = 1;
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent:
        "Hacker News rendered with story listings, points, comments, and navigation links after a recoverable transport_failure.",
    };
    result.final.text = [
      "Page purpose: Hacker News is a ranked link aggregator and discussion board.",
      "Concrete visible items: navigation links new, past, comments, ask, show, jobs, submit, login; story rows include points and comment links.",
      "Residual risk: live external rankings can change and only partial scroll depth was inspected.",
      "Browser limitation: transport_failure occurred during browser work. Treat the final answer as bounded to the evidence that was recovered, and retry or continue the browser task if the missing evidence matters.",
    ].join("\n");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.weakAnswerSignals.includes("browser transport degraded"), true);
    assert.deepEqual(quality.failures, []);
    assert.equal(quality.status, "passed");
  });

  it("keeps positive blocker evidence when the same line also negates another blocker", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-browser-external-page-review", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
        externalPageUrl: "https://news.ycombinator.com/",
      }),
      requiredEvidencePatterns: [],
      requiredAnswerPatterns: [],
      requiredAnswerTerms: [],
      minBytes: 80,
    };
    result.scenario = "natural-browser-external-page-review";
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent:
        "No redirect was observed, but Cloudflare blocked the page with a Turnstile captcha before browser evidence loaded.",
    };
    result.metrics.qualityGate.evidenceEvents = 1;
    result.final.text = [
      "The browser run reached a blocker before useful page evidence loaded.",
      "Residual risk: the visible page purpose and navigation cues were not verified because Cloudflare blocked the page.",
      "Next action: retry with an operator browser session or choose another source.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.weakAnswerSignals.includes("browser evidence blocked"), true);
    assert.equal(quality.failures.some((failure) => failure.includes("browser evidence blocked")), true);
    assert.equal(quality.status, "failed");
  });

  it("accepts complex browser summaries that preserve evidence across page surfaces", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-browser-complex-page-review", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
        complexBrowserUrl: "http://127.0.0.1/complex-browser",
      }),
      minBytes: 120,
    };
    result.scenario = "natural-browser-complex-page-review";
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: [
        "Main page: complex browser workbench with a details popup workflow.",
        "Frame panel: backlog 7, owner Frame Captain.",
        "Shadow review: risk desk approval required.",
        "Popup drill opened: packet P-42 requires manager acknowledgement.",
        "Residual risk: local complex browser fixture only.",
      ].join("\n"),
    };
    result.final.text = [
      "Operational State: the page renders with an embedded source frame showing backlog data (7 items), a shadow DOM review component, and a popup workflow.",
      "Owner: Frame Captain.",
      "Approval Requirement: Risk desk approval is required for the shadow review component.",
      "Popup workflow: the popup opened and displayed packet P-42 requires manager acknowledgement.",
      "Residual risk: local complex browser fixture only; external production impact remains not verified.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.status, "passed");
    assert.deepEqual(quality.sourceCoverage.answerPatterns.missing, []);
    assert.deepEqual(quality.sourceCoverage.evidencePatterns.missing, []);
  });

  it("fails natural quality when the final answer hides residual risk", () => {
    const result = fakeNaturalResult();
    const spec = {
      ...buildNaturalScenarioSpec("natural-browser-dynamic-page", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
      }),
      requiredAnswerTerms: ["Queue depth", "SLA breaches", "Incident Commander"],
    };
    result.final.text = [
      "Queue depth is 11 with 3 SLA breaches.",
      "Incident Commander should own the escalation.",
      "The recommended next action is to prioritize browser-visible operator evidence and continue the incident follow-up with source-backed checks.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.status, "failed");
    assert.equal(quality.sourceCoverage.residualRiskVisible, false);
    assert.ok(quality.failures.includes("final answer does not make residual risk visible"));
  });

  it("accepts a plural risks section as visible residual-risk disclosure", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-comparison-research", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.timeline[0]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "call",
      callInput: JSON.stringify({ agent_id: "explore", task: "compare vendor sources" }),
    };
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: [
        "Vendor Alpha: $19 per seat; browser automation with traceable screenshots; limited API catalog.",
        "Vendor Beta: $29 per workspace; approval workflow; separate connector for browser control.",
      ].join("\n"),
    };
    result.final.text = [
      "Alpha is $19 per seat and Beta is $29 per workspace.",
      "Alpha has browser automation with traceable screenshots and Beta has approval workflow.",
      "Risks: Alpha's API integration catalog is limited; Beta requires a separate browser connector.",
      "| Source | Verified Facts | Not Verified |",
      "| Vendor Alpha | $19/seat; browser automation with traceable screenshots; limited API catalog | plan tiers and scale pricing |",
      "| Vendor Beta | $29/workspace; approval workflow; separate browser connector | connector pricing |",
    ].join("\n");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.sourceCoverage.residualRiskVisible, true);
    assert.equal(quality.weakAnswerSignals.includes("browser evidence not verified"), false);
    assert.equal(quality.failures.includes("final answer does not make residual risk visible"), false);
  });

  it("accepts not-verifiable sections as visible residual-risk disclosure", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-followup-continuation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.final.text = [
      "Queue depth remains 11 with 3 SLA breaches, so Incident Commander ownership still applies.",
      "What is not verifiable from the evidence: service names, affected SLA contract identifiers, breach durations, and historical trends are not present in the rendered page.",
    ].join("\n");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.sourceCoverage.residualRiskVisible, true);
    assert.equal(quality.failures.includes("final answer does not make residual risk visible"), false);
  });

  it("does not join a not-verified section heading with later browser screenshot facts", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-comparison-research", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.timeline[0]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "call",
      callInput: JSON.stringify({ agent_id: "explore", task: "compare vendor sources" }),
    };
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: [
        "Vendor Alpha: browser automation and traceable screenshots.",
        "Vendor Beta: approval workflow and team handoff history.",
      ].join("\n"),
    };
    result.final.text = [
      "### Recommendation",
      "Choose Vendor Alpha for lower cost and bundled browser automation.",
      "",
      "### Not Verified",
      "Agent workbench-specific integration depth was not disclosed by either vendor.",
      "",
      "Source Ledger:",
      "- Vendor Alpha: verified; browser automation and traceable screenshots.",
      "- Vendor Beta: verified; approval workflow and team handoff history.",
    ].join("\n");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.weakAnswerSignals.includes("browser evidence not verified"), false);
  });

  it("does not treat product residual-risk wording as failed browser execution evidence", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-long-delegation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.scenario = "natural-long-delegation";
    result.metrics.tool = { requested: 3, results: 3, failed: 0, cancelled: 0, timeouts: 0 };
    result.metrics.sessions = { spawned: 3, continued: 0 };
    result.metrics.qualityGate.evidenceEvents = 3;
    result.timeline = [
      {
        kind: "tool",
        text: "Calling sessions_spawn(agent_id=\"explore\")",
        tMs: 1_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "explore", task: "research orchestration" }),
        },
      },
      {
        kind: "tool",
        text: "Tool sessions_spawn returned orchestration evidence.",
        tMs: 2_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: "Strength: multi-agent decomposition with durable sub-session history and follow-up.",
        },
      },
      {
        kind: "tool",
        text: "Calling sessions_spawn(agent_id=\"browser\")",
        tMs: 3_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "browser", task: "inspect product signal dashboard" }),
        },
      },
      {
        kind: "tool",
        text: "Tool sessions_spawn returned browser evidence.",
        tMs: 4_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent:
            "Browser bridge capability surface: controls rendered DOM, forms after approval, screenshots, console output, and artifacts. Live signal dashboard shows Stuck missions: 6 and Weak answer rate: 24%.",
        },
      },
      {
        kind: "tool",
        text: "Calling sessions_spawn(agent_id=\"explore\")",
        tMs: 5_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "explore", task: "research product signals" }),
        },
      },
      {
        kind: "tool",
        text: "Tool sessions_spawn returned signal evidence.",
        tMs: 6_000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent:
            "Mission Control should be the default entry point. First-run adoption remains blocked by CLI setup. Production telemetry remains not verified outside the local dashboard fixture.",
        },
      },
    ];
    result.final.text = [
      "Build Mission Control as the default entry for the next agent workbench release.",
      "It matters because the live signal dashboard shows Stuck missions: 6 and Weak answer rate: 24%.",
      "Do not over-emphasize new browser bridge surface area; browser bridge capabilities are already represented by rendered DOM, approval forms, screenshots, console output, and artifacts.",
      "Risk: first-run adoption remains blocked by CLI setup and production telemetry remains not verified outside the local fixture, so release quality should be gated on real LLM scenario quality.",
    ].join("\n");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });

    assert.equal(quality.weakAnswerSignals.includes("browser evidence blocked"), false);
    assert.equal(quality.weakAnswerSignals.includes("browser extraction failed"), false);
    assert.equal(quality.weakAnswerSignals.includes("browser evidence not verified"), false);
    assert.equal(quality.dimensionScores.timeoutCloseoutQuality, 2);
    assert.equal(quality.failureBuckets.includes("timeout_closeout"), false);
  });

  it("requires explicit browser bucket closeout when long delegation prompt asks for it", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-long-delegation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.scenario = "natural-long-delegation";
    result.metrics.tool = { requested: 3, results: 3, failed: 0, cancelled: 0, timeouts: 0 };
    result.metrics.sessions = { spawned: 3, continued: 0 };
    result.metrics.qualityGate.evidenceEvents = 3;
    result.metrics.browser = {
      profileFallbacks: 0,
      failureBuckets: [{ bucket: "transport_failure", count: 1, latestAtMs: 4_000 }],
    };
    result.timeline = [
      {
        kind: "tool",
        text: "orchestration result",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: "The orchestration source verifies multi-agent decomposition and durable sub-session history.",
        },
      },
      {
        kind: "tool",
        text: "bridge result",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent:
            "The browser bridge controls cover DOM, screenshots, artifacts, command-line setup, provider configuration, and the desktop boundary.",
        },
      },
      {
        kind: "tool",
        text: "signals browser call",
        tMs: 2500,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "browser", task: "inspect product signals dashboard" }),
        },
      },
      {
        kind: "tool",
        text: "signals browser result",
        tMs: 3000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent:
            "Rendered signal dashboard evidence recovered after transport_failure. Stuck missions: 6. Weak answer rate: 24%. Recommended next action: make Mission Control the default entry.",
        },
      },
    ];
    result.final.text = [
      "Recommendation: make Mission Control the default entry point for the next agent workbench release.",
      "Why it matters: multi-agent decomposition and durable sub-session history let specialist agents produce decision-ready briefs.",
      "Mission Control should be emphasized because the live signal dashboard shows Stuck missions: 6 and Weak answer rate: 24%.",
      "Do not over-emphasize new browser features before evidence synthesis is reliable.",
      "Risk: production telemetry remains unverified outside this local source.",
    ].join(" ");

    const missingCloseoutQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });

    assert.equal(missingCloseoutQuality.status, "failed");
    assert.ok(
      missingCloseoutQuality.failures.some((failure) => failure.includes("unexpected browser failure bucket(s): transport_failure=1")),
      JSON.stringify(missingCloseoutQuality.failures, null, 2)
    );
    assert.ok(missingCloseoutQuality.weakAnswerSignals.includes("browser transport degraded"));

    result.final.text +=
      " Browser limitation: transport_failure occurred during browser work. Treat the final answer as bounded to the evidence that was recovered; nothing mission-critical remains unverified from the local dashboard, but retry or continue the browser task if production telemetry matters.";

    const explicitCloseoutQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });

    assert.deepEqual(explicitCloseoutQuality.failures, []);
    assert.equal(explicitCloseoutQuality.status, "passed");
  });

  it("does not treat source-bounded browser residual scope as failed browser evidence", () => {
    const signals = findWeakEvidenceSignals(
      [
        "Rendered dashboard evidence: Mission Control, Stuck missions: 6, Weak-answer rate: 24%.",
        "Residual risk: browser evidence for production telemetry outside the local fixture is not verified.",
        "Next action: continue with real LLM scenario quality before release.",
      ].join("\n"),
      { browserEvidenceExpected: true },
    );

    assert.equal(signals.includes("browser evidence not verified"), false);
  });

  it("does not treat planning blocked language as browser access blockage", () => {
    const signals = findWeakEvidenceSignals(
      [
        "AsiaWalk live readiness rendered dashboard: Overall readiness yellow; rain risk in Taipei; metro maintenance in Tokyo.",
        "Product decision: go/no-go remains blocked pending guide confirmation.",
      ].join("\n"),
      { browserEvidenceExpected: true },
    );

    assert.equal(signals.includes("browser evidence blocked"), false);
  });

  it("still flags real browser access blockers", () => {
    const signals = findWeakEvidenceSignals(
      "Browser evidence blocked: Cloudflare Turnstile captcha prevented rendered page capture.",
      { browserEvidenceExpected: true },
    );

    assert.equal(signals.includes("browser evidence blocked"), true);
  });

  it("accepts degraded fallback wording as visible residual-risk disclosure", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-profile-lock-recovery", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.final.text = [
      "Operational state: degraded / escalation active.",
      "Queue depth is 11 and SLA breaches are 3.",
      "Browser continuity: persistent browser profile was locked; recovered via warm isolated fallback session.",
    ].join("\n");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.sourceCoverage.residualRiskVisible, true);
    assert.equal(quality.failures.includes("final answer does not make residual risk visible"), false);
  });

  it("accepts approval dry-run safety-boundary wording as residual-risk disclosure", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-approval-dry-run-action", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.final.text = [
      "Dry-run form submission completed successfully.",
      "Permission chain evidence: permission_query and permission_applied ran before browser action.",
      "No external mutation occurred; the fixture confirms isolated local execution.",
    ].join("\n");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.sourceCoverage.residualRiskVisible, true);
    assert.equal(quality.failures.includes("final answer does not make residual risk visible"), false);
  });

  it("accepts approval denial safety-boundary wording as residual-risk disclosure", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-approval-denied-safe-closeout", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.final.text = [
      "The operator denied approval.",
      "The side effect did not run, and the browser action must not be applied without a new approval decision.",
      "Safest next action: request a new approval if the user still wants to proceed.",
    ].join("\n");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.sourceCoverage.residualRiskVisible, true);
    assert.equal(quality.failures.includes("final answer does not make residual risk visible"), false);
  });

  it("accepts pending approval safety-boundary wording as residual-risk disclosure", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-approval-pending-state", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.final.text = [
      "Requested approval for browser.form.submit.",
      "No persistent changes were made; the action remains pending operator decision and must not continue without approval.",
      "The dry-run request is scoped without side effects.",
    ].join("\n");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.sourceCoverage.residualRiskVisible, true);
    assert.equal(quality.failures.includes("final answer does not make residual risk visible"), false);
  });

  it("requires mission artifact lifecycle evidence for natural browser dynamic page", () => {
    const result = fakeNaturalResult();
    result.artifacts = [];
    const quality = evaluateNaturalMissionQuality({
      spec: buildNaturalScenarioSpec("natural-browser-dynamic-page", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
      }),
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.equal(quality.status, "failed");
    assert.ok(quality.failures.some((failure) => failure.includes("artifact lifecycle metadata")));
  });

  it("flags unsupported vendor integration claims without rejecting unverified integration questions", () => {
    const spec = buildNaturalScenarioSpec("natural-followup-continuation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    const result = fakeNaturalResult();
    result.mission.status = "done";
    result.metrics.status = "done";
    result.metrics.sessions.continued = 1;
    result.metrics.tool.results = 2;
    result.metrics.qualityGate.evidenceEvents = 2;
    result.final.text = [
      "Vendor Alpha is verified at $19 per seat, with browser automation and traceable screenshots as the main strength.",
      "The integration scope is a risk: Slack, Zoom, and Zapier are not present on the source page and remain unverified questions for follow-up.",
      "The recommendation is to keep Vendor Alpha in the shortlist only for low-cost browser automation trials, and to continue only after those integration questions are verified against source evidence.",
      "Residual risk remains around implementation fit, missing integration proof, and whether the limited API catalog blocks the product lead's expected workflow.",
    ].join(" ");

    const cautiousQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(cautiousQuality.failures, []);

    result.final.text = [
      "Vendor Alpha is verified at $19 per seat and supports Slack and Zapier integrations.",
      "The recommendation is to proceed, with residual risk limited to source freshness and rollout timing.",
      "This answer is intentionally long enough to isolate the unsupported-integration quality failure from length or usefulness failures.",
    ].join(" ");
    const unsupportedQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(unsupportedQuality.failures.includes("forbidden unsupported integration catalog details"));
  });

  it("accepts bounded browser-unavailable closeout without accepting model-knowledge fallback", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-unavailable-closeout", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.metrics.tool.failed = 1;
    result.metrics.browser = {
      ...result.metrics.browser,
      failureBuckets: [{ bucket: "browser_cdp_unavailable", count: 1, latestAtMs: 2_000 }],
    };
    result.timeline[1]!.text = "browser result failed";
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent:
        "browser_cdp_unavailable: Browser CDP endpoint unavailable while opening the rendered operations dashboard.",
    };
    result.final.text = [
      "The browser is unavailable, so the dashboard could not be visually verified.",
      "Verified: the requested source was the operations dashboard URL and the browser attempt failed with a browser transport error.",
      "Unverified: Queue depth, SLA breach count, owner, escalation trigger, and any rendered client-side state.",
      "Next action: restore browser/CDP connectivity, rerun the dashboard review, and avoid operational decisions until rendered evidence is captured.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.weakAnswerSignals, []);
    assert.deepEqual(quality.failures, []);

    result.final.text += " Based on my knowledge, the dashboard is probably fine.";
    const fallbackQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(fallbackQuality.failures.some((failure) => failure.includes("model-knowledge fallback")));
  });

  it("requires browser-unavailable natural closeout to carry the browser failure bucket", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-unavailable-closeout", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.metrics.tool.failed = 1;
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: "browser_cdp_unavailable: connection refused before rendered dashboard evidence was captured.",
    };
    result.final.text = [
      "The browser is unavailable, so the dashboard could not be visually verified.",
      "Verified: the browser attempt failed while opening the dashboard.",
      "Unverified: rendered queue depth, SLA breach count, and owner.",
      "Next action: restore browser/CDP connectivity and rerun the dashboard review.",
    ].join(" ");

    const missingBucketQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingBucketQuality.failures.includes("missing browser failure bucket browser_cdp_unavailable"));

    result.metrics.browser = {
      ...result.metrics.browser,
      failureBuckets: [{ bucket: "browser_cdp_unavailable", count: 1, latestAtMs: 2_000 }],
    };
    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);
  });

  it("requires browser CDP timeout natural closeout to carry the timeout bucket", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-cdp-timeout-closeout", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.metrics.tool.failed = 1;
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: "cdp_command_timeout: browser snapshot CDP command timed out while capturing rendered page evidence.",
    };
    result.final.text = [
      "The browser snapshot timed out, so the rendered dashboard could not be fully verified.",
      "Verified: the requested source was the operations dashboard URL and the browser attempt reached the snapshot stage.",
      "Unverified: rendered queue depth, SLA breach count, owner, escalation trigger, and any client-side dashboard state.",
      "Next action: retry the browser review after checking CDP health; do not make an operational decision from the incomplete rendered evidence.",
    ].join(" ");

    const missingBucketQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingBucketQuality.failures.includes("missing browser failure bucket cdp_command_timeout"));

    result.metrics.browser = {
      ...result.metrics.browser,
      failureBuckets: [{ bucket: "cdp_command_timeout", count: 1, latestAtMs: 2_000 }],
    };
    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);

    result.timeline[1]!.runtime = {
      ...result.timeline[1]!.runtime,
      resultContent:
        "The browser_console and browser_screenshot probes succeeded, but CDP snapshot and scroll commands timed out while extracting full DOM evidence.",
    };
    const naturalTimeoutWordingQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(naturalTimeoutWordingQuality.failures, []);

    result.final.text = [
      "Render status: Partially rendered; DOM snapshot commands timed out (CDP timeout count: 4).",
      "Verified Facts: Queue depth 11 and SLA breaches 3 were captured from available browser evidence.",
      "Not Verified: interactive controls, historical charts, live-update behavior, and real on-call trigger.",
      "Next Action: relaunch a fresh browser session to explore interactive elements if deeper inspection is required.",
    ].join("\n");
    const notVerifiedHeadingQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(notVerifiedHeadingQuality.failures, []);

    result.final.text = [
      "Browser continuity note: 3 cdp_command_timeout failures occurred during snapshot/screenshot attempts; the session recovered and produced two screenshots and a console probe using fallback capture paths.",
      "What was verified: page title Operations Dashboard Fixture, queue depth 11, SLA breaches 3, and Incident Commander ownership.",
      "What remains unverified: additional panels and interactive elements not captured in the text excerpt.",
      "Next action: confirm whether this dashboard reflects live production data before assigning incident ownership.",
    ].join("\n");
    const recoveredBucketTokenQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(recoveredBucketTokenQuality.failures, []);

    result.final.text = [
      "Dashboard Review - Timeout Closeout",
      "What was verified: Page rendered with title Operations Dashboard Fixture, triage status TURNKEYAI_DASHBOARD_TRIAGE_OK, queue depth 11, SLA breaches 3, escalation threshold, recommended owner Incident Commander, and a screenshot captured while CDP timeout bucket count was 4.",
      "What remains unverified: DOM structure beyond visible text excerpt, interactive controls, live data behavior, and below-the-fold content because snapshot and scroll commands timed out.",
      "Next action for operator: engage Incident Commander for the active queue/SLA stress, then retry with a longer CDP timeout if full DOM structure is needed.",
    ].join("\n");
    const renderedCdpEvidenceQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(renderedCdpEvidenceQuality.sourceCoverage.answerTerms, {
      covered: 3,
      total: 3,
      missing: [],
    });
    assert.deepEqual(renderedCdpEvidenceQuality.failures, []);

    result.final.text = [
      "Operations Dashboard Review - Closeout",
      "Source type: Browser-rendered page.",
      "Verified Facts: page title Operations Dashboard Fixture, queue depth 11, SLA breaches 3, escalation threshold, and Incident Commander ownership.",
      "Unverified / Not Captured: full DOM snapshot - 4 CDP command timeouts blocked traversal; interactive controls and charts were not confirmed.",
      "Residual Risk: local fixture data only.",
      "Next Action for Operator: confirm whether production traffic should use this dashboard before treating the values as live incident evidence.",
    ].join("\n");
    const blockedTraversalQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(blockedTraversalQuality.failures, []);

    result.final.text = [
      "Verified: Page loaded at the operations dashboard URL with title Operations Dashboard Fixture.",
      "Dashboard displayed triage status TURNKEYAI_DASHBOARD_TRIAGE_OK, queue depth 11, SLA breaches 3, and recommended owner Incident Commander.",
      "Not verified: interactive controls, additional below-fold sections, whether metrics are live or hardcoded test data.",
      "What happened: Five CDP command timeouts occurred during the session, but browser_screenshot and browser_console probes succeeded, so the visible page content is confirmed.",
      "Next action for operator: escalate to Incident Commander per dashboard recommendation, and rerun CDP capture with a longer timeout if interactive controls or below-fold evidence matter.",
    ].join("\n");
    const pluralTimeoutsRecoveredProbeQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(pluralTimeoutsRecoveredProbeQuality.failures, []);
  });

  it("requires browser detached-target natural closeout to carry the detached bucket", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-detached-target-closeout", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.metrics.tool.failed = 1;
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: "detached_target: browser target detached while capturing rendered page evidence.",
    };
    result.final.text = [
      "The browser target detached, so the rendered dashboard review could not complete.",
      "Verified: the requested source was the operations dashboard URL and the browser attempt reached the rendered-page capture stage.",
      "Unverified: rendered queue depth, SLA breach count, owner, escalation trigger, and any client-side dashboard state.",
      "Next operator action: reopen the dashboard in a stable browser session before making an operational decision.",
    ].join(" ");

    const missingBucketQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingBucketQuality.failures.includes("missing browser failure bucket detached_target"));

    result.metrics.browser = {
      ...result.metrics.browser,
      failureBuckets: [{ bucket: "detached_target", count: 1, latestAtMs: 2_000 }],
    };
    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);

    result.timeline[1]!.runtime = {
      ...result.timeline[1]!.runtime,
      resultContent: "The browser target detached 11 times during this session while capturing rendered evidence.",
    };
    const countedDetachQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(countedDetachQuality.failures, []);
  });

  it("requires browser attach-failed natural closeout to carry the attach bucket", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-attach-failed-closeout", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.metrics.tool.failed = 1;
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: "attach_failed: browser target attach failed while resolving the browser target.",
    };
    result.final.text = [
      "The browser could not attach to the target page, so the rendered dashboard review could not complete.",
      "Verified: the requested source was the operations dashboard URL and the browser attempt reached target setup.",
      "Unverified: rendered queue depth, SLA breach count, owner, escalation trigger, and any client-side dashboard state.",
      "Next action: restore a healthy browser target and rerun the rendered-page review before making an operational decision.",
    ].join(" ");

    const missingBucketQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingBucketQuality.failures.includes("missing browser failure bucket attach_failed"));

    result.metrics.browser = {
      ...result.metrics.browser,
      failureBuckets: [{ bucket: "attach_failed", count: 1, latestAtMs: 2_000 }],
    };
    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);
  });

  it("accepts attach-failed closeout when failure wording precedes attach-stage evidence", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-attach-failed-closeout", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.mission.status = "blocked";
    result.metrics.status = "blocked";
    result.metrics.tool.failed = 1;
    result.metrics.browser = {
      ...result.metrics.browser,
      failureBuckets: [{ bucket: "attach_failed", count: 1, latestAtMs: 2_000 }],
    };
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: "attach_failed: browser target attach failed while resolving the browser target.",
    };
    result.final.text = [
      "Target URL was attempted three times, all resulting in attach_failed.",
      "The failure occurs at the browser-target-attach stage, before any page load or rendering.",
      "What remains unverified: any content that would be rendered on that page.",
      "Next action: verify that the browser environment is available before re-attempting.",
    ].join("\n");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });

    assert.deepEqual(quality.failures, []);
  });

  it("rejects browser-unavailable closeout that claims unsupported rendered dashboard facts", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-unavailable-closeout", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.metrics.tool.failed = 1;
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: "browser_cdp_unavailable: connection refused before rendered dashboard evidence was captured.",
    };
    result.final.text = [
      "The browser is unavailable, but Queue depth is 11 and SLA breaches are 3.",
      "Verified facts are limited, and the next action is to restore browser access.",
      "Unverified items remain the rendered dashboard state.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(quality.failures.includes("forbidden unsupported rendered queue depth"));
    assert.ok(quality.failures.includes("forbidden unsupported rendered SLA breaches"));
  });

  it("requires rendered browser evidence for natural dashboard scenarios", () => {
    const result = fakeNaturalResult();
    const spec = {
      scenario: "natural-browser-dashboard-task" as const,
      title: "Browser dashboard task",
      desc: "Review a browser dashboard.",
      minBytes: 120,
      minToolResults: 1,
      maxToolResults: 6,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 3,
      requiresBrowser: true,
      requiresApproval: false,
      allowToolFailure: false,
      minEvidenceEvents: 1,
      requiredAnswerTerms: ["Queue depth", "SLA", "Incident Commander"],
      requiredEvidencePatterns: [
        { label: "rendered queue depth", pattern: /Queue depth:\s*11/i },
        { label: "rendered SLA breaches", pattern: /SLA breaches:\s*3/i },
      ],
    };
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: "Browser opened but only loading text was captured.",
    };
    result.final.text =
      "Queue depth: 11 and SLA breaches: 3 appear in this answer, but the tool evidence did not capture those rendered facts. Incident Commander remains the likely owner.";
    result.timeline.push({ kind: "thought", text: result.final.text, tMs: 3000 });

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(quality.failures.includes("missing evidence rendered queue depth"));
    assert.ok(quality.failures.includes("missing evidence rendered SLA breaches"));
  });

  it("accepts natural rendered evidence phrasing for browser dashboard facts", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-dashboard-task", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent:
        "Browser-rendered dashboard evidence: queue depth is now 11, SLA breaches are 3, Escalation threshold says queue depth above 5 or SLA breaches above 0, and the recommended owner is Incident Commander.",
    };
    result.final.text = [
      "Queue depth is 11 and SLA breaches are 3, so the escalation policy is triggered and the dashboard state needs operator attention now.",
      "Incident Commander should own the next action, page the on-call, review the queue, and coordinate the escalation.",
      "The recommendation is evidence-backed by browser-rendered dashboard facts, with residual risk limited to the local fixture and missing per-ticket detail.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.deepEqual(quality.failures, []);
  });

  it("accepts natural dashboard risk-remaining wording when rendered evidence is complete", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-dashboard-task", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.scenario = "natural-browser-dashboard-task";
    result.metrics.tool.requested = 1;
    result.metrics.tool.results = 1;
    result.metrics.qualityGate.evidenceEvents = 1;
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent: [
        "Browser-rendered dashboard evidence: Queue depth: 11.",
        "SLA breaches: 3.",
        "Escalation threshold: queue depth above 5 or SLA breaches above 0.",
        "Recommended owner: Incident Commander.",
      ].join("\n"),
    };
    result.final.text = [
      "Queue depth is 11 and SLA breaches are 3, so the escalation policy is triggered.",
      "The next action owner should be the Incident Commander, who should page the on-call and work down the queue.",
      "Recommended action: treat this as an active operator escalation, keep the queue triage visible, and avoid claiming ticket-level root cause until the dashboard exposes per-ticket detail.",
      "Risk remaining after this check: local fixture data, stale timestamps, per-ticket causality, and the downstream paging workflow are still unverified, so the browser-rendered dashboard should be treated as current triage evidence rather than a complete incident report.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      artifacts: result.artifacts,
      final: result.final,
    });

    assert.deepEqual(quality.failures, []);
    assert.equal(quality.status, "passed");
    assert.equal(quality.sourceCoverage.residualRiskVisible, true);
  });

  it("requires natural browser follow-up to continue the existing browser session", () => {
    const spec = buildNaturalScenarioSpec("natural-browser-followup-continuation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    assertNaturalPromptAllowed(spec.desc);
    const result = fakeNaturalResult();
    result.scenario = "natural-browser-followup-continuation";
    result.metrics.tool.requested = 2;
    result.metrics.tool.results = 2;
    result.metrics.sessions.spawned = 1;
    result.metrics.sessions.continued = 1;
    result.metrics.qualityGate.evidenceEvents = 2;
    const phaseOneFinal = {
      id: "thought.browser.phase-one",
      kind: "thought",
      text: "The dashboard shows Queue depth 11, SLA breaches 3, and Incident Commander as owner.",
      tMs: 3000,
    };
    result.timeline = [
      {
        kind: "tool",
        text: "browser call",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "browser", task: "review dashboard" }),
        },
      },
      {
        kind: "tool",
        text: "browser result",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: '{"status":"done","session_key":"worker:browser:ops","summary":"Queue depth: 11. SLA breaches: 3. Recommended owner: Incident Commander."}',
        },
      },
      phaseOneFinal,
      {
        kind: "tool",
        text: "browser follow-up call",
        tMs: 4000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "call",
          callInput: JSON.stringify({ session_key: "worker:browser:ops", message: "re-check dashboard" }),
        },
      },
      {
        kind: "tool",
        text: "browser follow-up result",
        tMs: 5000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          resultContent:
            "Rendered dashboard still shows Queue depth: 11, SLA breaches: 3, and Recommended owner: Incident Commander.",
        },
      },
      {
        kind: "thought",
        text: [
          "Queue depth remains 11 and SLA breaches remain 3, so the next action is to keep the escalation active.",
          "Incident Commander remains the owner because the browser follow-up re-checked the rendered dashboard evidence.",
          "The recommendation is to keep this as an operator-facing incident path, not a generic status summary, because both queue and SLA signals are already beyond the escalation trigger.",
          "Residual risk is limited to the local dashboard state, missing ticket-level context, and whether the same browser view remains current before external action.",
        ].join(" "),
        tMs: 6000,
      },
    ];
    result.final = result.timeline.at(-1)!;

    assertNaturalFollowupReusedExistingSession({
      timeline: result.timeline,
      phaseOneFinal,
      expectedSessionKey: "worker:browser:ops",
    });
    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);

    result.metrics.sessions.continued = 0;
    const missingContinuation = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingContinuation.failures.some((failure) => failure.includes("tool use was outside")));
  });

  it("requires natural browser restart continuation to keep browser evidence useful", () => {
    const spec = buildNaturalScenarioSpec("natural-browser-restart-continuation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    assertNaturalPromptAllowed(spec.desc);
    const result = fakeNaturalResult();
    result.scenario = "natural-browser-restart-continuation";
    result.metrics.tool.requested = 2;
    result.metrics.tool.results = 2;
    result.metrics.sessions.spawned = 1;
    result.metrics.sessions.continued = 1;
    result.metrics.qualityGate.evidenceEvents = 2;
    const phaseOneFinal = {
      id: "thought.browser.restart.phase-one",
      kind: "thought",
      text: "The dashboard shows Queue depth 11, SLA breaches 3, and Incident Commander as owner.",
      tMs: 3000,
    };
    result.timeline = [
      {
        kind: "tool",
        text: "browser call",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "browser", task: "review dashboard before restart" }),
        },
      },
      {
        kind: "tool",
        text: "browser result",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: '{"status":"done","session_key":"worker:browser:restart","summary":"Queue depth: 11. SLA breaches: 3. Recommended owner: Incident Commander."}',
        },
      },
      phaseOneFinal,
      {
        kind: "tool",
        text: "browser restart follow-up call",
        tMs: 4000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "call",
          callInput: JSON.stringify({ session_key: "worker:browser:restart", message: "continue after daemon restart" }),
        },
      },
      {
        kind: "tool",
        text: "browser restart follow-up result",
        tMs: 5000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          resultContent:
            "After restart, rendered dashboard evidence still shows Queue depth: 11, SLA breaches: 3, and Recommended owner: Incident Commander.",
        },
      },
      {
        kind: "thought",
        text: [
          "After the restart, Queue depth remains 11 and SLA breaches remain 3, so the next action is to keep the escalation active.",
          "Incident Commander remains the owner because the browser continuation re-checked the rendered dashboard evidence.",
          "The recommendation is to treat this as an operator-facing incident path and verify the same browser view again before external action.",
          "Residual risk remains around dashboard freshness after restart and missing ticket-level context.",
        ].join(" "),
        tMs: 6000,
      },
    ];
    result.final = result.timeline.at(-1)!;

    assertNaturalFollowupReusedExistingSession({
      timeline: result.timeline,
      phaseOneFinal,
      expectedSessionKey: "worker:browser:restart",
    });
    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);

    result.final.text = [
      "Browser session recovered via cold resume; the session is warm and preserved for the follow-up.",
      "Queue depth remains 11 and SLA breaches remain 3, so the next action is to keep the escalation active.",
      "Incident Commander remains the owner because the browser continuation re-checked the rendered dashboard evidence.",
      "The operator should keep the incident lane active, page the on-call owner, and avoid treating the green label as authoritative until the underlying queue and SLA counters clear.",
      "Residual risk remains around dashboard freshness after restart and missing ticket-level context.",
      "Verified evidence is limited to the rendered dashboard text captured by the browser worker after restart.",
    ].join(" ");
    const coldResumeQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(coldResumeQuality.failures, []);

    result.timeline[1]!.runtime = {
      ...result.timeline[1]!.runtime,
      resultContent: '{"status":"done","session_key":"worker:browser:restart","summary":"Browser opened before restart, but no rendered dashboard facts were captured."}',
    };
    result.timeline[4]!.runtime = {
      ...result.timeline[4]!.runtime,
      resultContent: "After restart the browser session continued, but no rendered dashboard facts were captured.",
    };
    const missingRestartEvidence = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingRestartEvidence.failures.includes("missing evidence rendered queue depth"));
  });

  it("fails natural browser quality when a profile fallback is present", () => {
    const result = fakeNaturalResult();
    result.metrics.browser.profileFallbacks = 1;
    result.metrics.browser.latestProfileFallback = {
      sessionId: "browser-session-profile-fallback",
      fallbackDir: ".daemon-data/browser/_runtime-fallback/browser-session-profile-fallback/123",
    };
    const quality = evaluateNaturalMissionQuality({
      spec: buildNaturalScenarioSpec("natural-browser-dynamic-page", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
      }),
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });

    assert.equal(quality.profileFallbackFree, false);
    assert.ok(quality.failures.includes("browser profile fallback occurred 1 time(s)"));
  });

  it("accepts profile fallback only for the natural profile-lock recovery gate", () => {
    const result = fakeNaturalResult();
    result.scenario = "natural-browser-profile-lock-recovery";
    result.metrics.tool.requested = 3;
    result.metrics.tool.results = 3;
    result.metrics.sessions.continued = 1;
    result.metrics.browser.profileFallbacks = 1;
    result.metrics.browser.latestProfileFallback = {
      sessionId: "browser-session-profile-fallback",
      fallbackDir: ".daemon-data/browser/_runtime-fallback/browser-session-profile-fallback/123",
    };
    result.metrics.qualityGate.evidenceEvents = 2;
    result.timeline = [
      {
        kind: "tool",
        text: "browser call",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "browser", task: "review dashboard" }),
        },
      },
      {
        kind: "tool",
        text: "browser result",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: "Queue depth: 11. SLA breaches: 3. Recommended owner: Incident Commander.",
        },
      },
      {
        kind: "tool",
        text: "browser continuation",
        tMs: 3000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          resultContent:
            "Profile fallback: profile_locked (.daemon-data/browser/_runtime-fallback/browser-session-profile-fallback/123). Rendered evidence shows Queue depth: 11, SLA breaches: 3, and owner Incident Commander.",
        },
      },
      {
        kind: "thought",
        text: [
          "The browser recovered through a profile fallback using an isolated browser context, then rechecked the rendered dashboard.",
          "Queue depth remains 11 with 3 SLA breaches, so Incident Commander should keep ownership.",
          "The next action is to keep the escalation active, clear the queue bottleneck, and note residual risk from the temporary profile recovery.",
          "This is still bounded evidence: the rendered dashboard was verified after fallback, while profile availability should be restored before relying on long-lived browser continuity.",
          "Recommendation: keep the incident owner assigned now, then retry with the persistent profile after the operator clears the lock.",
        ].join(" "),
        tMs: 4000,
      },
    ];
    result.final = result.timeline.at(-1)!;
    const quality = evaluateNaturalMissionQuality({
      spec: buildNaturalScenarioSpec("natural-browser-profile-lock-recovery", {
        alphaUrl: "http://127.0.0.1/vendor-alpha",
        betaUrl: "http://127.0.0.1/vendor-beta",
        dashboardUrl: "http://127.0.0.1/ops-dashboard",
        approvalUrl: "http://127.0.0.1/approval-form",
        slowUrl: "http://127.0.0.1/slow-fixture",
        cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
        orchestrationUrl: "http://127.0.0.1/product-orchestration",
        bridgeUrl: "http://127.0.0.1/product-bridge",
        productSignalsUrl: "http://127.0.0.1/product-signals",
      }),
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });

    assert.equal(quality.profileFallbackFree, false);
    assert.deepEqual(quality.failures, []);
  });


  it("requires natural browser cold recreation to stay useful and visible", () => {
    const spec = buildNaturalScenarioSpec("natural-browser-cold-recreation-continuation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    assertNaturalPromptAllowed(spec.desc);
    const result = fakeNaturalResult();
    result.scenario = "natural-browser-cold-recreation-continuation";
    result.metrics.tool.requested = 2;
    result.metrics.tool.results = 2;
    result.metrics.sessions.spawned = 1;
    result.metrics.sessions.continued = 1;
    result.metrics.browser = {
      ...result.metrics.browser,
      failureBuckets: [{ bucket: "session_not_found", count: 1, latestAtMs: 3500 }],
    };
    result.metrics.qualityGate.evidenceEvents = 2;
    const phaseOneFinal = {
      id: "thought.browser.cold.phase-one",
      kind: "thought",
      text: "The dashboard shows Queue depth 11, SLA breaches 3, and Incident Commander as owner.",
      tMs: 3000,
    };
    result.timeline = [
      {
        kind: "tool",
        text: "browser call",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          toolCallId: "call-browser",
          callInput: JSON.stringify({ agent_id: "browser", task: "review dashboard before cold recreation" }),
        },
      },
      {
        kind: "tool",
        text: "browser result",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          toolCallId: "call-browser",
          resultContent: JSON.stringify({
            status: "completed",
            session_key: "worker:browser:cold",
            payload: {
              sessionId: "browser-session-original",
            },
            result: "Queue depth: 11. SLA breaches: 3. Recommended owner: Incident Commander.",
          }),
        },
      },
      phaseOneFinal,
      {
        kind: "tool",
        text: "browser cold follow-up call",
        tMs: 4000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "call",
          callInput: JSON.stringify({ session_key: "worker:browser:cold", message: "continue after browser session loss" }),
        },
      },
      {
        kind: "tool",
        text: "browser cold follow-up result",
        tMs: 5000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          resultContent:
            'Cold recreation performed. Target resolution: new_target. Rendered dashboard evidence shows Queue depth: 11, SLA breaches: 3, and Recommended owner: Incident Commander. "payload":{"sessionId":"browser-session-recreated","resumeMode":"cold"}',
        },
      },
      {
        kind: "thought",
        text: [
          "I recovered by reopening the read-only dashboard in a new browser session after the previous session was unavailable.",
          "Queue depth remains 11 and SLA breaches remain 3, so the next action is to keep the escalation active.",
          "Incident Commander remains the owner because the browser continuation re-checked the rendered dashboard evidence.",
          "My recommendation is to keep the Incident Commander assigned, clear the queue bottleneck first, and ask the operator to validate the three SLA-breach tickets before closing the incident.",
          "This is useful but still bounded evidence: the dashboard was rendered again after recovery, while residual risk remains around data freshness and ticket-level root cause.",
        ].join(" "),
        tMs: 6000,
      },
    ];
    result.final = result.timeline.at(-1)!;

    assert.equal(extractBrowserSessionIdForSpawnAgent(result.timeline, "browser"), "browser-session-original");
    result.timeline[1]!.runtime = {
      ...result.timeline[1]!.runtime,
      resultContent: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-1",
        session_key: "worker:browser:cold",
        agent_id: "browser",
        status: "completed",
        tool_chain: ["browser"],
        result: "Browser worker completed session browser-session-summary-only.",
        final_content: null,
      }),
    };
    assert.equal(extractBrowserSessionIdForSpawnAgent(result.timeline, "browser"), "browser-session-summary-only");
    result.timeline[1]!.runtime = {
      ...result.timeline[1]!.runtime,
      resultContent: "Screenshot path: /tmp/browser-artifacts/browser-session-canonical-only/01-dashboard.png",
    };
    assert.equal(extractBrowserSessionIdForSpawnAgent(result.timeline, "browser"), "browser-session-canonical-only");
    result.timeline[1]!.runtime = {
      ...result.timeline[1]!.runtime,
      resultContent: JSON.stringify({
        status: "completed",
        payload: { sessionId: "browser-session-structured" },
        result: "Diagnostic path with stale prior id: /tmp/browser-artifacts/browser-session-stale/01-dashboard.png",
      }),
    };
    assert.equal(extractBrowserSessionIdForSpawnAgent(result.timeline, "browser"), "browser-session-structured");
    result.timeline[4]!.runtime = {
      ...result.timeline[4]!.runtime,
      resultContent: JSON.stringify({
        status: "completed",
        payload: {
          sessionId: "browser-session-original",
          browserRecovery: {
            sessionId: "browser-session-recreated",
            resumeMode: "cold",
          },
        },
        browser_session: {
          session_id: "browser-session-original",
          resume_mode: "cold",
        },
        result:
          "Cold recreation performed. Target resolution: new_target. Rendered dashboard evidence shows Queue depth: 11, SLA breaches: 3, and Recommended owner: Incident Commander. Stale prior path: /tmp/browser-artifacts/browser-session-original/02-dashboard.png",
      }),
    };
    assert.equal(extractBrowserSessionIdForSendAfter(result.timeline, phaseOneFinal), "browser-session-recreated");
    assertNaturalFollowupReusedExistingSession({
      timeline: result.timeline,
      phaseOneFinal,
      expectedSessionKey: "worker:browser:cold",
    });
    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);

    const observedBuckets = result.metrics.browser?.failureBuckets ?? [];
    result.metrics.browser = { ...result.metrics.browser, failureBuckets: [] };
    const missingBucket = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingBucket.failures.includes("missing browser failure bucket session_not_found"));
    result.metrics.browser = { ...result.metrics.browser, failureBuckets: observedBuckets };

    result.timeline[4]!.runtime = {
      ...result.timeline[4]!.runtime,
      resultContent: "Rendered dashboard evidence shows Queue depth: 11 and SLA breaches: 3, but no recovery mode was recorded.",
    };
    const missingColdEvidence = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingColdEvidence.failures.includes("missing evidence browser recovery evidence"));
  });


  it("checks natural long-delegation source coverage in evidence rather than final fixture labels", () => {
    const spec = buildNaturalScenarioSpec("natural-long-delegation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    assertNaturalPromptAllowed(spec.desc);
    const result = fakeNaturalResult();
    result.scenario = "natural-long-delegation";
    result.metrics.tool.results = 3;
    result.metrics.sessions.spawned = 3;
    result.metrics.qualityGate.evidenceEvents = 3;
    result.timeline = [
      {
        kind: "tool",
        text: "orchestration result",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          callInput: JSON.stringify({ agent_id: "explore", task: "review orchestration source" }),
          resultContent: "Strength: multi-agent decomposition with durable sub-session history and follow-up.",
        },
      },
      {
        kind: "tool",
        text: "bridge result",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          callInput: JSON.stringify({ agent_id: "explore", task: "review bridge source" }),
          resultContent:
            "Boundary: browser work is a means for mission completion; the bridge does not control the desktop outside the browser.",
        },
      },
      {
        kind: "tool",
        text: "browser signal result",
        tMs: 3000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          callInput: JSON.stringify({ agent_id: "browser", task: "review live signal dashboard" }),
          resultContent:
            "Rendered dashboard evidence: Stuck missions: 6. Weak answer rate: 24%. Recommended next action: make Mission Control the default entry.",
        },
      },
      {
        kind: "thought",
        text: longDelegationFinalWithoutFixtureLabels(),
        tMs: 4000,
      },
    ];
    result.final = result.timeline.at(-1)!;

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);
    assert.deepEqual(summarizeNaturalMissionScenarioResult(result).runtimeEvidence, result.runtimeEvidence);

    result.timeline[2]!.runtime = {
      ...result.timeline[2]!.runtime,
      resultContent: "Browser opened the dashboard but did not capture the rendered signal metrics.",
    };
    const missingSignalQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingSignalQuality.failures.includes("missing evidence product signals stuck missions"));
    assert.ok(missingSignalQuality.failures.includes("missing evidence product signals weak answer rate"));

    result.timeline[2]!.runtime = {
      ...result.timeline[2]!.runtime,
      resultContent:
        "Rendered dashboard evidence: Six stuck missions. Weak answer rate: 24%. Recommended next action: make Mission Control the default entry.",
    };
    const wordedSignalQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(wordedSignalQuality.failures, []);

    result.timeline[2]!.runtime = {
      ...result.timeline[2]!.runtime,
      resultContent:
        "Rendered dashboard evidence: Stuck missions: 6. Signal status: marginal ok with 24% weak-answer rate. Recommended next action: make Mission Control the default entry.",
    };
    const hyphenatedSignalQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(hyphenatedSignalQuality.failures, []);

    result.timeline[2]!.runtime = {
      ...result.timeline[2]!.runtime,
      resultContent:
        "Rendered dashboard evidence: Stuck missions: 6. Weak-answer 24%. Recommended next action: make Mission Control the default entry.",
    };
    const compactSignalQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(compactSignalQuality.failures, []);
  });

  it("passes natural memory recall only with memory tool evidence and recalled facts", () => {
    const spec = buildNaturalScenarioSpec("natural-memory-recall", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    assertNaturalPromptAllowed(spec.desc);
    const result = fakeNaturalResult();
    result.scenario = "natural-memory-recall";
    result.timeline = [
      { kind: "tool", text: "memory_search call", tMs: 1000, runtime: { toolName: "memory_search", toolPhase: "call" } },
      { kind: "tool", text: "memory_search result", tMs: 1200, runtime: { toolName: "memory_search", toolPhase: "result" } },
      { kind: "tool", text: "memory_get call", tMs: 1400, runtime: { toolName: "memory_get", toolPhase: "call" } },
      {
        kind: "tool",
        text: "memory_get result",
        tMs: 1600,
        runtime: {
          toolName: "memory_get",
          toolPhase: "result",
          resultContent: "Helios-47 launch window is Tuesday 09:30. Owner is Release Captain.",
        },
      },
      {
        kind: "thought",
        text: "Verified memory shows Helios-47 launches Tuesday 09:30 with Release Captain as owner. Residual risk: confirm the calendar lock before external release announcements. Next action: the release lead should use this remembered coordination note as the internal planning baseline, then verify the calendar hold before sending any external commitment.",
        tMs: 2000,
      },
    ];
    result.metrics.tool.results = 2;
    result.metrics.sessions.spawned = 0;
    result.metrics.qualityGate.evidenceEvents = 2;
    result.final = result.timeline.at(-1)!;
    result.runtimeEvidence = {
      pressureMode: "request-envelope-limit-override",
      requestEnvelopeReduction: {
        progressId: "progress:prompt-reduction:task-1:compact:1",
        reductionLevel: "compact",
        omittedSections: ["retrieved-memory", "recent-turns"],
        compactedSegments: ["retrieved-memory"],
      },
      flushedMemory: {
        source: "thread-memory",
        preferences: 0,
        constraints: 1,
        longTermNotes: 1,
        requiredFactsPresent: true,
      },
    };

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);
  });

  it("passes natural memory pressure flush only with memory tool evidence from the flushed handoff", () => {
    const spec = buildNaturalScenarioSpec("natural-memory-pressure-flush", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    assertNaturalPromptAllowed(spec.desc);
    const result = fakeNaturalResult();
    result.scenario = "natural-memory-pressure-flush";
    result.timeline = [
      { kind: "tool", text: "memory_search call", tMs: 1000, runtime: { toolName: "memory_search", toolPhase: "call" } },
      { kind: "tool", text: "memory_search result", tMs: 1200, runtime: { toolName: "memory_search", toolPhase: "result" } },
      { kind: "tool", text: "memory_get call", tMs: 1400, runtime: { toolName: "memory_get", toolPhase: "call" } },
      {
        kind: "tool",
        text: "memory_get result",
        tMs: 1600,
        runtime: {
          toolName: "memory_get",
          toolPhase: "result",
          resultContent:
            "Aurora-19 launch window is Friday 14:15. Owner is Field Ops Lead. Constraint: wait for Legal Review on the data-processing addendum. Residual risk: vendor dry-run unverified.",
        },
      },
      {
        kind: "thought",
        text: "Durable memory shows Aurora-19 launches Friday 14:15 with Field Ops Lead as owner. Legal Review must confirm the data-processing addendum before the external announcement is treated as cleared. Residual risk: the vendor dry-run remains unverified, so the next action is to keep external commitments conditional until that evidence lands. Recommendation: use this as the internal planning baseline, but do not treat it as externally verified launch clearance.",
        tMs: 2000,
      },
    ];
    result.metrics.tool.results = 2;
    result.metrics.sessions.spawned = 0;
    result.metrics.qualityGate.evidenceEvents = 2;
    result.final = result.timeline.at(-1)!;

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);
    assert.deepEqual(summarizeNaturalMissionScenarioResult(result).runtimeEvidence, result.runtimeEvidence);

    result.timeline[3]!.runtime = {
      ...result.timeline[3]!.runtime,
      resultContent: "Aurora-19 launch window is Friday 14:15. Owner is Field Ops Lead.",
    };
    const missingConstraintQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.match(missingConstraintQuality.failures.join("\n"), /missing evidence pressure-flushed constraint/);
  });

  it("passes natural memory correction pressure flush only with corrected memory evidence and no stale facts", () => {
    const spec = buildNaturalScenarioSpec("natural-memory-correction-pressure-flush", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    assertNaturalPromptAllowed(spec.desc);
    const result = fakeNaturalResult();
    result.scenario = "natural-memory-correction-pressure-flush";
    result.timeline = [
      { kind: "tool", text: "memory_search call", tMs: 1000, runtime: { toolName: "memory_search", toolPhase: "call" } },
      { kind: "tool", text: "memory_search result", tMs: 1200, runtime: { toolName: "memory_search", toolPhase: "result" } },
      { kind: "tool", text: "memory_get call", tMs: 1400, runtime: { toolName: "memory_get", toolPhase: "call" } },
      {
        kind: "tool",
        text: "memory_get result",
        tMs: 1600,
        runtime: {
          toolName: "memory_get",
          toolPhase: "result",
          resultContent:
            "Borealis-23 launch window is Thursday 16:45. Owner is Ops Captain. Constraint: wait for Legal Review on the data-processing addendum. Residual risk: payment processor signoff pending.",
        },
      },
      {
        kind: "thought",
        text: "Durable memory verifies the corrected Borealis-23 launch baseline. Launch window: Thursday 16:45. Owner: Ops Captain. Hard constraint: Legal Review still needs to confirm the data-processing addendum before external announcement clearance. Residual risk: payment processor signoff is pending. Recommendation: use this corrected handoff as the current launch-lead planning baseline, keep external communications conditional, and ask Payments for the signoff status before treating the launch as externally cleared.",
        tMs: 2000,
      },
    ];
    result.metrics.tool.results = 2;
    result.metrics.sessions.spawned = 0;
    result.metrics.qualityGate.evidenceEvents = 2;
    result.runtimeEvidence = {
      pressureMode: "request-envelope-limit-override",
      requestEnvelopeReduction: {
        progressId: "progress:prompt-reduction:task-1:compact:1",
        reductionLevel: "compact",
        omittedSections: ["recent-turns"],
        compactedSegments: ["task-prompt"],
      },
      flushedMemory: {
        source: "thread-memory",
        preferences: 0,
        constraints: 1,
        longTermNotes: 1,
        requiredFactsPresent: true,
      },
      invalidatedMemory: {
        source: "thread-memory",
        removedItems: 1,
        requiredFactsPresent: true,
        staleFactsAbsent: true,
      },
      providerToolProtocol: {
        rounds: 2,
        providerToolCallsReturned: 2,
        assistantToolUseBlockCount: 2,
        roleToolResultMessageCount: 2,
        toolResultBlockCount: 2,
        matchingToolCallIds: 2,
        assistantBeforeToolResults: true,
        allToolResultsMatchAssistantToolCalls: true,
        nextProviderRequestIncludesToolResults: true,
        toolNames: ["memory_get", "memory_search"],
      },
    };
    result.final = result.timeline.at(-1)!;

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);
    assert.deepEqual(summarizeNaturalMissionScenarioResult(result).runtimeEvidence, result.runtimeEvidence);

    result.final.text =
      "Durable memory says Borealis-23 still uses Monday 10:15 with Launch Manager. Residual risk is staging checklist pending.";
    const staleQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.match(staleQuality.failures.join("\n"), /forbidden stale launch window/);
  });

  it("passes natural memory invalidation only with corrected memory facts and no stale launch detail", () => {
    const spec = buildNaturalScenarioSpec("natural-memory-invalidation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    assertNaturalPromptAllowed(spec.desc);
    const result = fakeNaturalResult();
    result.scenario = "natural-memory-invalidation";
    result.timeline = [
      { kind: "tool", text: "memory_search call", tMs: 1000, runtime: { toolName: "memory_search", toolPhase: "call" } },
      { kind: "tool", text: "memory_search result", tMs: 1200, runtime: { toolName: "memory_search", toolPhase: "result" } },
      { kind: "tool", text: "memory_get call", tMs: 1400, runtime: { toolName: "memory_get", toolPhase: "call" } },
      {
        kind: "tool",
        text: "memory_get result",
        tMs: 1600,
        runtime: {
          toolName: "memory_get",
          toolPhase: "result",
          resultContent:
            "Borealis-23 current launch window is Thursday 16:45. Owner is Ops Captain. Residual risk: payment processor signoff pending.",
        },
      },
      {
        kind: "thought",
        text: "Durable memory verifies Borealis-23 is now scheduled for Thursday 16:45 with Ops Captain as owner. Residual risk: payment processor signoff is still pending, so the launch lead should continue with that as the current baseline and avoid using superseded details. Recommended next action: keep internal coordination on the corrected Thursday plan, ask Payments for the signoff status, and keep any superseded launch context out of the operator brief.",
        tMs: 2000,
      },
    ];
    result.metrics.tool.results = 2;
    result.metrics.sessions.spawned = 0;
    result.metrics.qualityGate.evidenceEvents = 2;
    result.runtimeEvidence = {
      invalidatedMemory: {
        source: "thread-memory",
        removedItems: 1,
        requiredFactsPresent: true,
        staleFactsAbsent: true,
      },
      providerToolProtocol: {
        rounds: 2,
        providerToolCallsReturned: 2,
        assistantToolUseBlockCount: 2,
        roleToolResultMessageCount: 2,
        toolResultBlockCount: 2,
        matchingToolCallIds: 2,
        assistantBeforeToolResults: true,
        allToolResultsMatchAssistantToolCalls: true,
        nextProviderRequestIncludesToolResults: true,
        toolNames: ["memory_get", "memory_search"],
      },
    };
    result.final = result.timeline.at(-1)!;

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);
    assert.deepEqual(summarizeNaturalMissionScenarioResult(result).runtimeEvidence, result.runtimeEvidence);

    result.final.text =
      "Durable memory says Borealis-23 uses the old Monday 10:15 launch plan with Launch Manager. Residual risk is staging checklist pending.";
    const staleQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.match(staleQuality.failures.join("\n"), /forbidden stale launch window/);
  });

  it("passes natural tool-result pruning when delegated source facts survive the pruned history", () => {
    const spec = buildNaturalScenarioSpec("natural-tool-result-pruning", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    assertNaturalPromptAllowed(spec.desc);
    const result = fakeNaturalResult();
    result.scenario = "natural-tool-result-pruning";
    result.timeline = [
      { kind: "tool", text: "sessions_spawn orchestration call", tMs: 1000, runtime: { toolName: "sessions_spawn", toolPhase: "call" } },
      {
        kind: "tool",
        text: "sessions_spawn orchestration result",
        tMs: 1200,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          workerType: "explore",
          resultContent: "Research source: multi-agent decomposition with durable sub-session history and follow-up.",
        },
      },
      { kind: "tool", text: "sessions_spawn bridge call", tMs: 1400, runtime: { toolName: "sessions_spawn", toolPhase: "call" } },
      {
        kind: "tool",
        text: "sessions_spawn bridge result",
        tMs: 1600,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          workerType: "explore",
          resultContent:
            "Bridge capability evidence: browser bridge controls inspect DOM, screenshots, artifacts; boundary is command-line setup and provider configuration.",
        },
      },
      {
        kind: "tool",
        text: "sessions_spawn product signals call",
        tMs: 1800,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "browser", task: "review product signals dashboard" }),
        },
      },
      {
        kind: "tool",
        text: "sessions_spawn product signals result",
        tMs: 2200,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          workerType: "browser",
          resultContent: "Browser evidence: Stuck missions: 6. Weak answer rate: 24%. Recommended next action: make Mission Control the default entry.",
        },
      },
      {
        kind: "thought",
        text: "Recommendation: build Mission Control as the default entry for the next agent workbench release. Why: the browser-visible dashboard shows Stuck missions at 6 and Weak answer rate at 24%, while the research stream shows multi-agent decomposition with durable sub-session history. The bridge stream supports this because browser work can inspect DOM, screenshots, and artifacts, but it is only a means to mission completion. What not to over-emphasize: do not sell the browser bridge itself as the product; focus on the mission-control workflow that turns specialist evidence into a decision. Next action: prioritize the Mission Control entry, keep browser evidence visible, and use the weak-answer signal as a quality gate. Residual risk: local fixture evidence, so verify against live production telemetry before launch.",
        tMs: 2600,
      },
    ];
    result.metrics.tool.requested = 3;
    result.metrics.tool.results = 3;
    result.metrics.sessions.spawned = 3;
    result.metrics.qualityGate.evidenceEvents = 3;
    result.final = result.timeline.at(-1)!;
    result.runtimeEvidence = {
      pressureMode: "tool-result-prune-limit-override",
      toolResultPruning: {
        progressId: "progress:tool-result-pruning:task-1:1",
        prunedToolResults: 2,
        pruningReasons: ["older_than_recent_window", "aggregate_tool_result_budget_recent_window"],
        compactedHistory: false,
        toolResultBytesBefore: 4800,
        toolResultBytesAfter: 1800,
        toolResultCountBefore: 3,
        toolResultCountAfter: 3,
      },
    };

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);
    assert.deepEqual(summarizeNaturalMissionScenarioResult(result).runtimeEvidence, result.runtimeEvidence);

    result.timeline[5]!.runtime = {
      ...result.timeline[5]!.runtime,
      resultContent: "Browser evidence: Stuck missions: 6.",
    };
    const missingPrunedFactQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.match(missingPrunedFactQuality.failures.join("\n"), /missing evidence product signals weak answer rate/);
  });

  it("requires cancellation evidence for natural cancellation", () => {
    const spec = buildNaturalScenarioSpec("natural-cancel-active-tool", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    assertNaturalPromptAllowed(spec.desc);
    const result = fakeNaturalResult();
    result.scenario = "natural-cancel-active-tool";
    result.mission.status = "blocked";
    result.metrics.status = "blocked";
    result.metrics.tool.requested = 1;
    result.metrics.tool.results = 1;
    result.metrics.tool.failed = 1;
    result.metrics.tool.cancelled = 1;
    result.metrics.sessions.spawned = 1;
    result.metrics.qualityGate.evidenceEvents = 1;
    result.timeline = [
      {
        kind: "tool",
        text: "slow source call",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "explore", task: "evaluate slow source" }),
        },
      },
      {
        kind: "tool",
        text: "sessions_spawn was cancelled by the operator",
        emph: "danger",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: "cancelled: active slow source verification was cancelled before page evidence returned.",
        },
      },
      {
        kind: "thought",
        text: [
          "The slow source verification was cancelled before source facts were verified.",
          "Verified: a source-backed attempt started and the cancellation result was recorded.",
          "Unverified: release-risk facts from the slow source remain unavailable.",
          "Continue by rerunning the source check or asking me to resume when the source can be allowed to finish.",
        ].join(" "),
        tMs: 3000,
      },
    ];
    result.final = result.timeline.at(-1)!;

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);

    result.timeline.push({
      kind: "recovery",
      text: [
        "Mission cancelled by the operator.",
        "Active work was stopped before completion; verified evidence may be incomplete, unverified source checks remain, and the user can continue later if they want to resume.",
      ].join(" "),
      tMs: 3500,
      runtime: { eventType: "mission.cancelled" },
    });
    result.final = result.timeline.at(-1)!;
    const missionCancelledCloseoutQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(missionCancelledCloseoutQuality.failures, []);

    result.metrics.tool.cancelled = 0;
    result.timeline = result.timeline.filter((event) => event.runtime?.["eventType"] !== "mission.cancelled");
    result.final = result.timeline.at(-1)!;
    const missingCancellation = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingCancellation.failures.includes("cancellation scenario did not record a cancelled tool result or mission cancellation event"));
  });

  it("requires cancellation evidence and continuation for natural cancellation follow-up", () => {
    const spec = buildNaturalScenarioSpec("natural-cancel-followup-continuation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    assertNaturalPromptAllowed(spec.desc);
    const result = fakeNaturalResult();
    result.scenario = "natural-cancel-followup-continuation";
    result.metrics.tool.requested = 2;
    result.metrics.tool.results = 2;
    result.metrics.tool.failed = 1;
    result.metrics.tool.cancelled = 1;
    result.metrics.sessions.spawned = 1;
    result.metrics.sessions.continued = 1;
    result.metrics.qualityGate.evidenceEvents = 2;
    result.timeline = [
      {
        kind: "tool",
        text: "source call",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "explore", task: "evaluate source" }),
        },
      },
      {
        kind: "tool",
        text: "sessions_spawn was cancelled by the operator",
        emph: "danger",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: '{"status":"cancelled","session_key":"wrk.cancel.1","result":"operator cancelled source verification"}',
        },
      },
      {
        kind: "tool",
        text: "sessions_send result",
        tMs: 3000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          resultContent:
            "Verified source evidence: Release Captain owns the release, a runbook gap remains, and rollback rehearsal is the mitigation.",
        },
      },
      {
        kind: "thought",
        text: [
          "Verified facts now include Release Captain ownership, the runbook gap, and rollback rehearsal as the mitigation.",
          "Not verified items remain whether the same risk exists outside this source and whether the operator cancellation skipped any intermediate evidence.",
          "Residual risk: the cancelled first attempt delayed verification, but the resumed source evidence is now available for the release-risk note.",
        ].join(" "),
        tMs: 4000,
      },
    ];
    result.final = result.timeline.at(-1)!;

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);

    result.metrics.sessions.continued = 0;
    const missingContinuation = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingContinuation.failures.some((failure) => failure.includes("tool use was outside")));
  });

  it("accepts retry guidance as continuation for natural timeout partial closeout", () => {
    const spec = buildNaturalScenarioSpec("natural-timeout-partial-closeout", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    const result = fakeNaturalResult();
    result.scenario = "natural-timeout-partial-closeout";
    result.metrics.tool.failed = 1;
    result.metrics.tool.timeouts = 1;
    result.metrics.sessions.spawned = 1;
    result.metrics.qualityGate.evidenceEvents = 1;
    result.timeline[1]!.runtime = {
      toolName: "sessions_spawn",
      toolPhase: "result",
      resultContent:
        "timeout: slow source did not respond within the bounded window; evidence summary records the source URL and timeout.",
    };
    result.final.text = [
      "Bounded Timeout Closeout - slow-fixture",
      "Verified facts: Source http://127.0.0.1/slow-fixture did not respond within the 15-second bounded window.",
      "Unverified items: actual content or response data from the endpoint, whether it is slow by design, down, or unreachable, and any release-risk-relevant details.",
      "Residual risk: cannot assess release-risk notes without endpoint content.",
      "Continuation guidance: retry with a longer timeout if the endpoint content is still needed for the release-risk evaluation.",
    ].join("\n");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });

    assert.deepEqual(quality.sourceCoverage.answerTerms, { covered: 3, total: 3, missing: [] });
    assert.deepEqual(quality.failures, []);
  });

  it("requires timeout evidence and continuation for natural timeout follow-up", () => {
    const spec = buildNaturalScenarioSpec("natural-timeout-followup-continuation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    assertNaturalPromptAllowed(spec.desc);
    const result = fakeNaturalResult();
    result.scenario = "natural-timeout-followup-continuation";
    result.metrics.tool.requested = 2;
    result.metrics.tool.results = 2;
    result.metrics.tool.failed = 1;
    result.metrics.tool.timeouts = 1;
    result.metrics.sessions.spawned = 1;
    result.metrics.sessions.continued = 1;
    result.metrics.qualityGate.evidenceEvents = 2;
    result.timeline = [
      {
        kind: "tool",
        text: "slow source call",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "explore", task: "evaluate slow source" }),
        },
      },
      {
        kind: "tool",
        text: "sessions_spawn timed out",
        emph: "danger",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: '{"status":"timeout","session_key":"wrk.timeout.1","summary":"WORKER_TIMEOUT"}',
        },
      },
      {
        kind: "tool",
        text: "sessions_send result",
        tMs: 3000,
        runtime: {
          toolName: "sessions_send",
          toolPhase: "result",
          resultContent:
            "Verified: the slow source eventually returned release-risk evidence. Unverified: production freshness remains unknown.",
        },
      },
      {
        kind: "thought",
        text: [
          "Verified facts now include the resumed slow-source evidence and the earlier timeout record.",
          "Unverified items remain production freshness and whether the risk appears outside this source.",
          "The release risk is that the initial timeout delayed source confirmation; continue with operator review if the same source becomes slow again.",
          "Next action: use the verified resumed evidence for the release note and keep residual risk visible.",
        ].join(" "),
        tMs: 4000,
      },
    ];
    result.final = result.timeline.at(-1)!;

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);

    result.final.text = [
      "**Release-risk note - http://127.0.0.1/slow-fixture**",
      "",
      "- **HTTP status:** 200",
      "- **Content:** Page title \"TurnkeyAI Slow Mission E2E Fixture\"; fixture marker present; verified owner: Release Captain; verified risk: runbook gap before launch approval; mitigation: complete rollback rehearsal before release gate.",
      "- **Release risk:** Moderate - the fixture records a runbook gap before launch approval and flags rollback rehearsal as required mitigation.",
      "",
      "**Residual risk / scope limits:** This is a fixture page, not a live production endpoint. No external-service health, latency, or availability data was verified against production infrastructure.",
      "",
      "**How the mission continued:** The initial explore session timed out at 15 s without evidence. The resume (`sessions_send`) re-fetched the same target and returned HTTP 200 with full fixture content, confirming the timeout was a transient delay rather than a connectivity failure.",
    ].join("\n");
    const naturalUnverifiedQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(naturalUnverifiedQuality.sourceCoverage.answerTerms, { covered: 3, total: 3, missing: [] });
    assert.deepEqual(naturalUnverifiedQuality.failures, []);

    result.final.text = [
      "## Release-Risk Note: http://127.0.0.1/slow-fixture",
      "### Verified Facts",
      "- Verified owner: Release Captain",
      "- Verified risk: runbook gap before launch approval",
      "- Initial attempt: timed out at 20 seconds; resumed successfully on follow-up with full 200 response",
      "### Residual Risk",
      "- The endpoint responds slowly; first-contact latency exceeds a 20-second bounded window.",
      "- No other risk dimensions were present in the fixture content.",
      "### How the Timeout Limits the Conclusion",
      "- No content, status, or risk data was missed; the resume recovered the same content the initial bounded window could not wait for.",
      "### Recommendation",
      "- Complete a rollback rehearsal before the release gate.",
    ].join("\n");
    const noMissingDataQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(noMissingDataQuality.sourceCoverage.answerTerms, { covered: 3, total: 3, missing: [] });
    assert.deepEqual(noMissingDataQuality.failures, []);

    result.final.text = [
      "## Release-Risk Note - http://127.0.0.1/slow-fixture",
      "### Verified Facts",
      "- Endpoint returned HTTP 200 after resumed attempt.",
      "- Owner: Release Captain.",
      "- Risk identified by source: runbook gap before launch approval.",
      "### Unverified Items",
      "- Whether the earlier timeout was transient or reflects persistent latency under load is not confirmed.",
      "### Residual Risk",
      "- The earlier timeout remains a partial constraint on the conclusion.",
      "### Recommendation",
      "- A subsequent health check should confirm the endpoint is reliably responsive before the release gate.",
    ].join("\n");
    const resumedGuidanceQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(resumedGuidanceQuality.sourceCoverage.answerPatterns, { covered: 1, total: 1, missing: [] });
    assert.deepEqual(resumedGuidanceQuality.failures, []);

    result.metrics.browser = {
      profileFallbacks: 0,
      failureBuckets: [{ bucket: "transport_failure", count: 1, latestAtMs: 1_700_000_004_000 }],
    };
    const recoveredTransportQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(recoveredTransportQuality.failures, []);

    result.metrics.browser.failureBuckets = [
      { bucket: "browser_cdp_unavailable", count: 1, latestAtMs: 1_700_000_004_000 },
    ];
    const unavailableBrowserQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(unavailableBrowserQuality.failures, [
      "unexpected browser failure bucket(s): browser_cdp_unavailable=1",
    ]);

    result.metrics.browser.failureBuckets = [];
    result.final.text = [
      "Verified facts: the slow-source attempt timed out and the resumed attempt also returned no source content.",
      "Unverified items: cannot determine whether the endpoint is permanently unavailable or temporarily slow.",
      "Residual risk: a release that depends on this source can still block; retry with a longer timeout or a restored endpoint before using it as a gate.",
      "Recommendation: do not use this endpoint as release evidence until availability is confirmed, and keep the timeout result visible in the release note so operators know the conclusion is bounded.",
    ].join(" ");
    const boundedUnavailableQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(boundedUnavailableQuality.failures, []);

    result.final.text = [
      "Verified facts: the resumed slow-source check reached HTTP 200 and returned the expected fixture acknowledgment.",
      "Unverified items: production freshness and non-fixture behavior remain outside this check.",
      "Residual risk: a shorter timeout can incorrectly classify the intentionally delayed source as unavailable.",
      "Recommendation: configure tool-call timeouts for this source at 180 seconds or keep it out of timeout-gated release checks when the delay is intentional.",
    ].join(" ");
    const configuredTimeoutGuidanceQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(configuredTimeoutGuidanceQuality.failures, []);

    result.metrics.tool.timeouts = 0;
    const missingTimeout = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingTimeout.failures.includes("timeout scenario did not record a timed-out tool result"));

    result.metrics.tool.timeouts = 1;
    result.metrics.sessions.continued = 0;
    const missingContinuation = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingContinuation.failures.some((failure) => failure.includes("tool use was outside")));
  });

  it("keeps natural capability and mission attention gates distinct for timeout continuation", () => {
    const result = fakeNaturalResult();
    result.scenario = "natural-timeout-followup-continuation";
    result.metrics.tool.failed = 1;
    result.metrics.tool.timeouts = 1;
    result.metrics.sessions.continued = 1;
    result.metrics.qualityGate.status = "blocked";
    result.metrics.qualityGate.checks = [
      { name: "failure_free", status: "fail", detail: "Timeout remains visible for operator attention." },
      { name: "tool_loop_closeout", status: "warn", detail: "Closeout used recovered evidence." },
    ];
    result.quality.status = "passed";
    result.quality.failures = [];

    const summary = summarizeNaturalMissionScenarioResult(result);

    assert.equal(summary.qualityGate, "passed");
    assert.equal(summary.missionQualityGate, "blocked");
    assert.equal(summary.metrics.tools.failed, 1);
    assert.equal(summary.metrics.tools.timeouts, 1);
    assert.deepEqual(summary.natural.failures, []);
    assert.deepEqual(
      summary.metrics.qualityChecks.map((check) => [check.name, check.status]),
      [
        ["failure_free", "fail"],
        ["tool_loop_closeout", "warn"],
      ]
    );
  });

  it("treats timeout evidence summaries as recovered only when long delegation closes out cleanly", () => {
    const spec = buildNaturalScenarioSpec("natural-long-delegation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      slowUrl: "http://127.0.0.1/slow-fixture",
      cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
      cancelResumeStateUrl: "http://127.0.0.1/__cancel-resume-state",
      approvalUrl: "http://127.0.0.1/approval-form",
      dynamicUrl: "http://127.0.0.1/dynamic-dashboard",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    const result = fakeNaturalResult();
    result.scenario = "natural-long-delegation";
    result.metrics.tool.requested = 3;
    result.metrics.tool.results = 3;
    result.metrics.tool.failed = 0;
    result.metrics.tool.timeouts = 1;
    result.metrics.sessions.spawned = 3;
    result.metrics.sessions.continued = 0;
    result.metrics.qualityGate.evidenceEvents = 3;
    result.metrics.browser = { profileFallbacks: 0, failureBuckets: [] };
    result.timeline = [
      {
        kind: "tool",
        text: "orchestration call",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "explore", task: "research product orchestration" }),
        },
      },
      {
        kind: "tool",
        text: "orchestration result",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: JSON.stringify({
            status: "completed",
            session_key: "wrk.orchestration.1",
            result: "The orchestration source verifies multi-agent decomposition and durable sub-session history.",
          }),
        },
      },
      {
        kind: "tool",
        text: "bridge call",
        tMs: 3000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "explore", task: "research browser bridge controls" }),
        },
      },
      {
        kind: "tool",
        text: "bridge result",
        tMs: 4000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: JSON.stringify({
            status: "completed",
            session_key: "wrk.bridge.1",
            result: "The browser bridge controls cover DOM, screenshots, artifacts, command-line setup, provider configuration, and the desktop boundary.",
          }),
        },
      },
      {
        kind: "tool",
        text: "signals browser call",
        tMs: 5000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "browser", task: "inspect product signals dashboard" }),
        },
      },
      {
        kind: "tool",
        text: "signals browser timeout with evidence",
        tMs: 6000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "timeout",
            session_key: "wrk.signals.1",
            agent_id: "browser",
            evidence_available: true,
            evidence_summary: "Browser-visible product signals verified Stuck missions: 6 and Weak answer rate: 24%.",
            result: "Sub-agent session timed out after collecting evidence.",
          }),
        },
      },
      {
        kind: "thought",
        text: [
          "Recommendation: make Mission Control the default entry point for the next agent workbench release.",
          "Why it matters: multi-agent coordination is the core workflow, browser bridge controls provide browser-visible evidence, and Stuck missions: 6 with Weak answer rate: 24% make quality gating urgent.",
          "Do not over-emphasize new browser features before the workbench can reliably synthesize evidence.",
          "The orchestration stream verifies multi-agent decomposition and durable sub-session history, so the release story should focus on specialists producing a decision-ready brief rather than a single chat response.",
          "The bridge stream verifies that browser work is a means to gather DOM, screenshots, artifacts, and operator-visible state; it also keeps the desktop boundary and command-line setup/provider configuration blocker visible.",
          "The browser-visible signals stream verifies the quality pressure: Stuck missions: 6 and Weak answer rate: 24%.",
          "Residual risk: the signals source came from a recovered timeout evidence summary, so production representativeness remains unverified and the next gate should rerun the same scenario before claiming capability proven.",
        ].join(" "),
        tMs: 7000,
      },
    ];
    result.final = result.timeline.at(-1)!;

    const recoveredQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(recoveredQuality.failures, []);
    assert.equal(recoveredQuality.dimensionScores.timeoutCloseoutQuality, 2);

    result.timeline[5]!.runtime!.resultContent = JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      status: "timeout",
      session_key: "wrk.signals.1",
      agent_id: "browser",
      evidence_available: false,
      result: "Sub-agent session timed out before collecting evidence.",
    });
    const unrecoveredQuality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(unrecoveredQuality.failures.includes("scenario had timed-out tool results"));
  });

  it("extracts the timed-out session key instead of the first spawned session", () => {
    const timeline = [
      {
        kind: "tool",
        text: "first child completed",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: '{"status":"done","session_key":"wrk.completed.1"}',
        },
      },
      {
        kind: "tool",
        text: "second child timed out",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: '{"status":"timeout","session_key":"wrk.timeout.2","summary":"WORKER_TIMEOUT"}',
        },
      },
    ];

    assert.equal(extractTimedOutSessionKey(timeline), "wrk.timeout.2");
  });

  it("extracts the timed-out session key from failed tool progress detail", () => {
    const timeline = [
      {
        kind: "tool",
        text: "Tool sessions_spawn progress: Sub-agent session timed out after 30s.",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "progress",
          progressPhase: "failed",
          progressDetail: JSON.stringify({
            session_key: "wrk.timeout.progress",
            status: "timeout",
            timeout_seconds: 30,
          }),
        },
      },
      {
        kind: "tool",
        text: "Tool sessions_spawn failed: sessions_spawn timed out after 30s.",
        tMs: 2500,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: "sessions_spawn timed out after 30s.",
        },
      },
    ];

    assert.equal(extractTimedOutSessionKey(timeline), "wrk.timeout.progress");
  });

  it("extracts a session key for the matching spawned agent", () => {
    const timeline = [
      {
        kind: "tool",
        text: "explore call",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          toolCallId: "call-explore",
          callInput: JSON.stringify({ agent_id: "explore", task: "fetch notes" }),
        },
      },
      {
        kind: "tool",
        text: "browser call",
        tMs: 1100,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          toolCallId: "call-browser",
          callInput: JSON.stringify({ agent_id: "browser", task: "inspect page" }),
        },
      },
      {
        kind: "tool",
        text: "explore result",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          toolCallId: "call-explore",
          resultContent: '{"status":"done","session_key":"worker:explore:wrong"}',
        },
      },
      {
        kind: "tool",
        text: "browser result",
        tMs: 3000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          toolCallId: "call-browser",
          resultContent: '{"status":"done","session_key":"worker:browser:right"}',
        },
      },
    ];

    assert.equal(extractSessionKeyForSpawnAgent(timeline, "finance"), null);
    assert.equal(extractSessionKeyForSpawnAgent(timeline, "browser"), "worker:browser:right");
  });

  it("extracts the cancelled session key instead of the first spawned session", () => {
    const timeline = [
      {
        kind: "tool",
        text: "first child completed",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: '{"status":"done","session_key":"wrk.completed.1"}',
        },
      },
      {
        kind: "tool",
        text: "second child cancelled",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: '{"status":"cancelled","session_key":"wrk.cancel.2"}',
        },
      },
    ];

    assert.equal(extractCancelledSessionKey(timeline), "wrk.cancel.2");
  });

  it("formats natural per-scenario progress lines", () => {
    const result = fakeNaturalResult();

    assert.equal(
      formatNaturalMissionScenarioStart({ scenario: "natural-browser-dynamic-page", index: 2, total: 6 }),
      "natural mission scenario starting: natural-browser-dynamic-page (2/6)"
    );
    assert.equal(
      formatNaturalMissionScenarioPass({ result, index: 2, total: 6, durationMs: 4321 }),
      "natural mission scenario passed: natural-browser-dynamic-page (2/6, 4321ms) mission-id=msn.natural.1 natural=passed tools=2/2 sessions=1/0 browser=yes artifacts=1 profileFallbacks=0 browserBuckets=none stuck=no"
    );
  });
});

function fakeResult(): MissionScenarioResult {
  return {
    scenario: "realistic-brief",
    mission: {
      id: "msn.report.1",
      status: "done",
      threadId: "thread.report.1",
    },
    timeline: [
      { kind: "tool", text: "call", tMs: 1000, runtime: { toolPhase: "call" } },
      { kind: "tool", text: "result", tMs: 2000, runtime: { toolPhase: "result" } },
      { kind: "thought", text: "- one\n- two", tMs: 3000 },
    ],
    metrics: {
      status: "done",
      tool: {
        requested: 2,
        results: 2,
        failed: 0,
        cancelled: 0,
        timeouts: 0,
      },
      sessions: {
        spawned: 2,
        continued: 1,
      },
      browser: {
        profileFallbacks: 0,
      },
      approvals: {
        requested: 1,
        applied: 1,
        decided: 1,
      },
      recovery: {
        events: 0,
      },
      liveness: {
        active: 0,
        waiting: 0,
        stale: 0,
      },
      qualityGate: {
        status: "passed",
        evidenceEvents: 2,
        checks: [
          { name: "final_answer", status: "pass", detail: "Lead final answer is present." },
          { name: "source_coverage", status: "pass", detail: "Final answer covers both source labels." },
        ],
      },
    },
    final: {
      kind: "thought",
      text: "- one evidence bullet\n- two evidence bullet with residual risk marker",
      tMs: 3000,
    },
    quality: {
      bullets: 2,
      failures: [],
    },
  };
}

function longDelegationFinalWithoutFixtureLabels(): string {
  return [
    "Recommendation: make Mission Control the default entry for the next release, then gate broader expansion on real LLM scenario quality.",
    "The strongest product story is multi-agent coordination around a user mission, with durable follow-up and specialist work feeding one decision-ready brief.",
    "Browser capability should stay framed as an execution surface, not the product itself: use it for rendered evidence, forms after approval, screenshots, and artifacts when a mission needs page context.",
    "Current signals make this urgent. Stuck missions: 6 and Weak answer rate: 24% mean the release should prioritize reliable completion, evidence quality, and first-run setup over adding more surfaces.",
    "Do not over-emphasize desktop automation or broad feature count. The bridge boundary and setup risk show that browser work needs to remain scoped and understandable.",
    "Residual risk: these signals are still local fixture evidence, so production telemetry and continued natural E2E runs should verify the trend before a broad launch.",
  ].join(" ");
}

function fakeCloseoutResult(
  scenario: "budget-limited-closeout" | "sub-agent-timeout-closeout" | "timeout-recovery",
  qualityGate: string,
  reason: string
): MissionScenarioResult {
  const result = fakeResult();
  result.scenario = scenario;
  result.metrics.qualityGate.status = qualityGate;
  result.final.runtime = {
    toolLoopCloseoutReason: reason,
    "toolLoopCloseout.evidenceAvailable": "true",
  };
  return result;
}

function fakeScenarioWithCloseout(
  scenario: "product-workbench-brief" | "realistic-brief",
  qualityGate: string,
  reason: string
): MissionScenarioResult {
  const result = fakeResult();
  result.scenario = scenario;
  result.metrics.qualityGate.status = qualityGate;
  result.final.runtime = {
    toolLoopCloseoutReason: reason,
    "toolLoopCloseout.evidenceAvailable": "true",
  };
  return result;
}

function fakeNaturalResult(): NaturalMissionScenarioResult {
  return {
    scenario: "natural-browser-dynamic-page",
    prompt: "Review this operations dashboard as a user would see it in the browser.",
    durationMs: 3210,
    mission: {
      id: "msn.natural.1",
      status: "done",
      threadId: "thread.natural.1",
    },
    timeline: [
      {
        kind: "tool",
        text: "browser call",
        tMs: 1000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "call",
          callInput: JSON.stringify({ agent_id: "browser", task: "review dashboard" }),
        },
      },
      {
        kind: "tool",
        text: "browser result",
        tMs: 2000,
        runtime: {
          toolName: "sessions_spawn",
          toolPhase: "result",
          resultContent: "Queue depth: 11. SLA breaches: 3. Recommended owner: Incident Commander.",
        },
      },
      {
        kind: "thought",
        text: "Queue depth is 11 with 3 SLA breaches. Incident Commander should own the escalation. The recommended next action is to prioritize browser-visible operator evidence and call out residual risk.",
        tMs: 3000,
      },
    ],
    metrics: {
      status: "done",
      tool: {
        requested: 2,
        results: 2,
        failed: 0,
        cancelled: 0,
        timeouts: 0,
      },
      sessions: {
        spawned: 1,
        continued: 0,
      },
      browser: {
        profileFallbacks: 0,
      },
      approvals: {
        requested: 0,
        applied: 0,
        decided: 0,
      },
      recovery: {
        events: 0,
      },
      liveness: {
        active: 0,
        waiting: 0,
        stale: 0,
      },
      qualityGate: {
        status: "passed",
        evidenceEvents: 1,
        checks: [],
      },
    },
    artifacts: [
      {
        id: "artifact-browser-screenshot",
        kind: "screenshot",
        label: "final.png",
        path: "/tmp/browser-artifacts/browser-session-1/final.png",
        sizeBytes: 12_345,
        lifecycle: {
          storageBackend: "file",
          refType: "local-path",
          retentionMs: 604_800_000,
          expiresAtMs: 1_700_604_800_123,
          maxArtifactBytes: 25 * 1024 * 1024,
          sessionBudgetBytes: 100 * 1024 * 1024,
          cleanupOnSessionClose: false,
          orphanReconciliation: "delete_expired",
        },
      },
    ],
    final: {
      kind: "thought",
      text: "Queue depth is 11 with 3 SLA breaches. Incident Commander should own the escalation. The recommended next action is to prioritize browser-visible operator evidence and call out residual risk.",
      tMs: 3000,
    },
    quality: {
      status: "passed",
      completed: true,
      stuckOrLoop: false,
      reasonableToolUse: true,
      browserUsed: true,
      profileFallbackFree: true,
      subAgentCompleted: true,
      approvalExercised: false,
      finalAnswerHasEvidence: true,
      finalAnswerUseful: true,
      sourceCoverage: {
        answerTerms: { covered: 2, total: 2, missing: [] },
        answerPatterns: { covered: 0, total: 0, missing: [] },
        evidencePatterns: { covered: 1, total: 1, missing: [] },
        evidenceEvents: { observed: 1, required: 1 },
        residualRiskVisible: true,
        unsupportedClaims: [],
      },
      weakAnswerSignals: [],
      failures: [],
      dimensionScores: {
        taskCompletion: 2,
        evidenceQuality: 2,
        toolUseAppropriateness: 2,
        browserAuthenticity: 2,
        subAgentIndependence: 2,
        continuationBehavior: 2,
        permissionCorrectness: 2,
        timeoutCloseoutQuality: 2,
      },
      failureBuckets: [],
    },
  };
}
