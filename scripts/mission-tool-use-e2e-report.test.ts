import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertNaturalPromptAllowed,
  assertFollowupReusedSession,
  assertNaturalFollowupReusedExistingSession,
  assertNaturalScenarioPromptsAllowed,
  buildNaturalScenarioSpec,
  buildNaturalMissionE2eJsonReport,
  buildMissionE2eJsonReport,
  evaluateNaturalMissionQuality,
  extractCancelledSessionKey,
  extractBrowserSessionIdForSpawnAgent,
  extractBrowserSessionIdForSendAfter,
  extractSessionKeyForSpawnAgent,
  extractTimedOutSessionKey,
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
    assert.equal(
      isStalePendingApprovalThought("Once approved, the browser worker completed the dry-run and verified the submitted page."),
      false
    );
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
        ].join(" "),
        tMs: 2000,
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
    assert.equal(quality.approvalExercised, true);

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
        text: "Requested approval · <b>browser.form.submit</b> · approval required before side effect; operator decision is pending before any form submission can run.",
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
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);
    assert.equal(quality.completed, true);
    assert.equal(quality.stuckOrLoop, false);
    assert.equal(quality.approvalExercised, true);

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
      weakAnswerSignals: [],
      failures: [],
    });
    assert.equal(summary.final.bytes > 0, true);
    assert.equal(summary.final.excerpt.includes("recommended next action"), true);
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
    const report = buildNaturalMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 5),
      results: [fakeNaturalResult()],
    });

    assert.equal(report.kind, "turnkeyai.natural-mission-e2e.report");
    assert.equal(report.evidenceMode, "natural-real-llm");
    assert.equal(report.progressClaim, "capability");
    assert.equal(report.promptPolicy.forbidsContractGateLanguage, true);
    assert.ok(report.promptPolicy.forbiddenPatterns.some((pattern) => pattern.includes("exactly once")));
    assert.ok(report.requiredQualitySignals.includes("source-backed-evidence"));
    assert.ok(report.requiredQualitySignals.includes("browser-profile-fallback-policy"));
    assert.ok(report.requiredQualitySignals.includes("browser-failure-bucket-policy"));
    assert.equal(report.status, "passed");
    assert.equal(report.durationMs, 5000);
    assert.equal(report.scenarios[0]?.scenario, "natural-browser-dynamic-page");
    assert.equal(report.scenarios[0]?.natural.profileFallbackFree, true);
    assert.equal(report.scenarios[0]?.metrics.browser.profileFallbacks, 0);
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
    assert.ok(quality.weakAnswerSignals.includes("tool unavailable fallback"));
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
      "Next action: reopen the dashboard in a stable browser session before making an operational decision.",
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
      scenario: "natural-browser-dynamic-page" as const,
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
    const spec = buildNaturalScenarioSpec("natural-browser-dynamic-page", {
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
        "Browser-rendered dashboard evidence: queue depth is now 11, SLA breaches are 3, and the recommended owner is Incident Commander.",
    };
    result.final.text = [
      "Queue depth is 11 and SLA breaches are 3, so the dashboard state needs operator attention now.",
      "Incident Commander should own the next action, review the queue, and coordinate the escalation.",
      "The recommendation is evidence-backed by browser-rendered dashboard facts, with residual risk limited to the local fixture and missing per-ticket detail.",
    ].join(" ");

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });

    assert.deepEqual(quality.failures, []);
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
        payload: { sessionId: "browser-session-recreated", resumeMode: "cold" },
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

    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.deepEqual(quality.failures, []);
  });

  it("requires cancelled tool-result evidence for natural cancellation", () => {
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

    result.metrics.tool.cancelled = 0;
    const missingCancellation = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics: result.metrics,
      final: result.final,
    });
    assert.ok(missingCancellation.failures.includes("cancellation scenario did not record a cancelled tool result"));
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
          "Unverified items remain whether the same risk exists outside this source and whether the operator cancellation skipped any intermediate evidence.",
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
      "natural mission scenario passed: natural-browser-dynamic-page (2/6, 4321ms) mission-id=msn.natural.1 natural=passed tools=2/2 sessions=1/0 browser=yes profileFallbacks=0 browserBuckets=none stuck=no"
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
      weakAnswerSignals: [],
      failures: [],
    },
  };
}
