import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertNaturalPromptAllowed,
  assertNaturalScenarioPromptsAllowed,
  buildNaturalScenarioSpec,
  buildNaturalMissionE2eJsonReport,
  buildMissionE2eJsonReport,
  evaluateNaturalMissionQuality,
  formatMissionScenarioPass,
  formatMissionScenarioStart,
  formatNaturalMissionScenarioPass,
  formatNaturalMissionScenarioStart,
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
    assert.ok(report.requiredQualitySignals.includes("no-browser-profile-fallback"));
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

  it("accepts bounded browser-unavailable closeout without accepting model-knowledge fallback", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-unavailable-closeout", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    result.metrics.tool.failed = 1;
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

  it("rejects browser-unavailable closeout that claims unsupported rendered dashboard facts", () => {
    const result = fakeNaturalResult();
    const spec = buildNaturalScenarioSpec("natural-browser-unavailable-closeout", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
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


  it("checks natural long-delegation source coverage in evidence rather than final fixture labels", () => {
    const spec = buildNaturalScenarioSpec("natural-long-delegation", {
      alphaUrl: "http://127.0.0.1/vendor-alpha",
      betaUrl: "http://127.0.0.1/vendor-beta",
      dashboardUrl: "http://127.0.0.1/ops-dashboard",
      approvalUrl: "http://127.0.0.1/approval-form",
      slowUrl: "http://127.0.0.1/slow-fixture",
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
      orchestrationUrl: "http://127.0.0.1/product-orchestration",
      bridgeUrl: "http://127.0.0.1/product-bridge",
      productSignalsUrl: "http://127.0.0.1/product-signals",
    });
    assertNaturalPromptAllowed(spec.desc);
    const result = fakeNaturalResult();
    result.scenario = "natural-cancel-active-tool";
    result.metrics.tool.requested = 1;
    result.metrics.tool.results = 1;
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

  it("formats natural per-scenario progress lines", () => {
    const result = fakeNaturalResult();

    assert.equal(
      formatNaturalMissionScenarioStart({ scenario: "natural-browser-dynamic-page", index: 2, total: 6 }),
      "natural mission scenario starting: natural-browser-dynamic-page (2/6)"
    );
    assert.equal(
      formatNaturalMissionScenarioPass({ result, index: 2, total: 6, durationMs: 4321 }),
      "natural mission scenario passed: natural-browser-dynamic-page (2/6, 4321ms) mission-id=msn.natural.1 natural=passed tools=2/2 sessions=1/0 browser=yes profileFallbacks=0 stuck=no"
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
  scenario: "budget-limited-closeout" | "sub-agent-timeout-closeout",
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
