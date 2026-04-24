import assert from "node:assert/strict";
import test from "node:test";

import {
  buildValidationOpsRecordFromPhase1Baseline,
  buildValidationOpsRecordFromTransportSoak,
  buildValidationOpsRecordFromReleaseReadiness,
  buildValidationOpsRecordFromSoakSeries,
  buildValidationOpsRecordFromValidationProfile,
  buildValidationOpsReport,
} from "./validation-ops-inspection";

test("validation ops inspection derives operator-facing records and report counts", () => {
  const releaseRecord = buildValidationOpsRecordFromReleaseReadiness({
    runId: "release-1",
    startedAt: 10,
    completedAt: 30,
    result: {
      status: "failed",
      totalChecks: 2,
      passedChecks: 1,
      failedChecks: 1,
      artifact: null,
      checks: [
        { checkId: "build-cli", title: "Build CLI", status: "passed", details: [] },
        { checkId: "publish-dry-run", title: "Publish dry-run", status: "failed", details: ["failed"] },
      ],
    },
  });

  const profileRecord = buildValidationOpsRecordFromValidationProfile({
    runId: "profile-1",
    startedAt: 40,
    completedAt: 70,
    result: {
      profileId: "nightly",
      title: "Nightly Hardening",
      summary: "nightly",
      focusAreas: ["browser"],
      validationSelectors: ["failure", "acceptance", "realworld", "soak"],
      includeReleaseReadiness: true,
      soakSeriesCycles: 3,
      soakSeriesSelectors: ["soak", "realworld", "acceptance"],
      transportSoakCycles: 1,
      transportSoakTargets: ["relay", "direct-cdp"],
      status: "failed",
      durationMs: 30,
      totalStages: 4,
      passedStages: 1,
      failedStages: 3,
      issues: [
        {
          issueId: "validation-run:realworld:browser-research-recovery-runbook",
          kind: "validation-item",
          stageId: "validation-run",
          scope: "realworld:browser-research-recovery-runbook",
          summary: "[browser] browser research failed 1/5 cases",
        },
      ],
      stages: [],
    },
  });

  const soakRecord = buildValidationOpsRecordFromSoakSeries({
    runId: "soak-1",
    startedAt: 80,
    completedAt: 110,
    selectors: ["soak", "realworld", "acceptance"],
    result: {
      status: "failed",
      selectors: ["soak", "realworld", "acceptance"],
      totalCycles: 3,
      passedCycles: 2,
      failedCycles: 1,
      totalSuites: 9,
      failedSuites: 1,
      totalItems: 12,
      failedItems: 1,
      totalCases: 50,
      failedCases: 1,
      durationMs: 30,
      closedLoop: {
        closedLoopStatus: "actionable",
        totalCases: 2,
        completedCases: 1,
        actionableCases: 1,
        silentFailureCases: 0,
        ambiguousFailureCases: 0,
        closedLoopCases: 2,
        closedLoopRate: 1,
        rerunCommand: "realworld-run browser-research-recovery-runbook",
        timeToActionableMs: 30,
        manualGateReason: "inspect failed browser runbook case(s)",
        failureBucket: "browser",
      },
      cycles: [],
      suiteAggregates: [
        {
          suiteId: "realworld",
          cycles: 3,
          failedCycles: 1,
          totalItems: 6,
          failedItems: 1,
          totalCases: 20,
          failedCases: 1,
        },
      ],
    },
  });

  const transportRecord = buildValidationOpsRecordFromTransportSoak({
    runId: "transport-1",
    startedAt: 120,
    completedAt: 180,
    artifactPath: ".daemon-data/validation-artifacts/transport-soak/transport-1.json",
    result: {
      status: "failed",
      totalCycles: 3,
      passedCycles: 2,
      failedCycles: 1,
      totalTargetRuns: 6,
      failedTargetRuns: 1,
      durationMs: 60,
      targets: ["relay", "direct-cdp"],
      cycleResults: [],
      targetAggregates: [
        {
          target: "relay",
          cycles: 3,
          passedCycles: 2,
          failedCycles: 1,
          failureBuckets: [
            { bucket: "reconnect-failure", count: 1 },
            { bucket: "none", count: 2 },
          ],
          acceptanceChecks: [
            { checkId: "reconnect", passed: 2, failed: 1, skipped: 0 },
            { checkId: "network-controls", passed: 3, failed: 0, skipped: 0 },
          ],
        },
        {
          target: "direct-cdp",
          cycles: 3,
          passedCycles: 3,
          failedCycles: 0,
          failureBuckets: [{ bucket: "none", count: 3 }],
          acceptanceChecks: [
            { checkId: "reconnect", passed: 3, failed: 0, skipped: 0 },
            { checkId: "network-controls", passed: 3, failed: 0, skipped: 0 },
          ],
        },
      ],
    },
  });

  const report = buildValidationOpsReport([releaseRecord, profileRecord, soakRecord, transportRecord], 10);

  assert.equal(report.totalRuns, 4);
  assert.equal(report.failedRuns, 4);
  assert.equal(report.attentionCount, 4);
  assert.equal(report.runTypeCounts["release-readiness"], 1);
  assert.equal(report.runTypeCounts["validation-profile"], 1);
  assert.equal(report.runTypeCounts["soak-series"], 1);
  assert.equal(report.runTypeCounts["transport-soak"], 1);
  assert.equal(report.bucketCounts.release, 1);
  assert.equal(report.bucketCounts.browser, 1);
  assert.equal(report.bucketCounts.soak, 1);
  assert.equal(report.bucketCounts.transport, 1);
  assert.equal(report.severityCounts.critical, 3);
  assert.equal(report.recommendedActionCounts["rerun-release"], 1);
  assert.equal(report.recommendedActionCounts["rerun-transport-soak"], 1);
  assert.equal(report.closedLoop.measuredRuns, 1);
  assert.equal(report.closedLoop.closedLoopStatus, "actionable");
  assert.equal(report.closedLoop.closedLoopRate, 1);
  assert.equal(report.closedLoop.nextCommand, "realworld-run browser-research-recovery-runbook");
  assert.ok(report.activeIssues.some((issue) => issue.kind === "validation-item" && issue.commandHint === "validation-profile-run nightly"));
  assert.ok(report.activeIssues.some((issue) => issue.kind === "transport-target" && issue.commandHint === "transport-soak 3 relay"));
  assert.ok(report.activeIssues.some((issue) => issue.kind === "transport-target" && issue.summary.includes("failed checks: reconnect x1")));
  assert.equal(report.latestRuns[0]?.artifactPath, ".daemon-data/validation-artifacts/transport-soak/transport-1.json");
  assert.deepEqual(report.latestRuns.find((run) => run.runType === "validation-profile")?.targets, ["relay", "direct-cdp"]);
  assert.equal(report.readiness.status, "failed");
  assert.equal(report.readiness.failedGates, 3);
  assert.equal(report.readiness.missingGates, 1);
  assert.equal(report.readiness.gates.find((gate) => gate.gateId === "phase1-e2e-profile")?.status, "missing");
  assert.equal(report.readiness.gates.find((gate) => gate.gateId === "transport-soak")?.latestRunId, "transport-1");
  assert.equal(report.readiness.nextCommand, "release-verify");
  assert.equal(report.baseline.status, "missing");
});

test("validation ops inspection marks phase1 readiness passed when all exit gates pass", () => {
  const releaseRecord = buildValidationOpsRecordFromReleaseReadiness({
    runId: "release-pass",
    startedAt: 10,
    completedAt: 20,
    result: {
      status: "passed",
      totalChecks: 1,
      passedChecks: 1,
      failedChecks: 0,
      artifact: null,
      checks: [{ checkId: "build-cli", title: "Build CLI", status: "passed", details: [] }],
    },
  });

  const profileRecord = buildValidationOpsRecordFromValidationProfile({
    runId: "profile-pass",
    startedAt: 30,
    completedAt: 50,
    result: {
      profileId: "phase1-e2e",
      title: "Phase 1 End-to-End",
      summary: "phase1",
      focusAreas: ["browser", "recovery", "context", "operator"],
      validationSelectors: ["acceptance", "realworld", "failure", "soak"],
      includeReleaseReadiness: true,
      soakSeriesCycles: 3,
      soakSeriesSelectors: ["acceptance", "realworld", "soak"],
      transportSoakCycles: 3,
      transportSoakTargets: ["relay", "direct-cdp"],
      status: "passed",
      durationMs: 20,
      totalStages: 4,
      passedStages: 4,
      failedStages: 0,
      issues: [],
      stages: [],
    },
  });

  const soakRecord = buildValidationOpsRecordFromSoakSeries({
    runId: "soak-pass",
    startedAt: 60,
    completedAt: 90,
    selectors: ["acceptance", "realworld", "soak"],
    result: {
      status: "passed",
      selectors: ["acceptance", "realworld", "soak"],
      totalCycles: 3,
      passedCycles: 3,
      failedCycles: 0,
      totalSuites: 9,
      failedSuites: 0,
      totalItems: 12,
      failedItems: 0,
      totalCases: 50,
      failedCases: 0,
      durationMs: 30,
      cycles: [],
      suiteAggregates: [],
    },
  });

  const transportRecord = buildValidationOpsRecordFromTransportSoak({
    runId: "transport-pass",
    startedAt: 100,
    completedAt: 140,
    result: {
      status: "passed",
      totalCycles: 3,
      passedCycles: 3,
      failedCycles: 0,
      totalTargetRuns: 6,
      failedTargetRuns: 0,
      durationMs: 40,
      targets: ["relay", "direct-cdp"],
      cycleResults: [],
      targetAggregates: [
        {
          target: "relay",
          cycles: 3,
          passedCycles: 3,
          failedCycles: 0,
          failureBuckets: [{ bucket: "none", count: 3 }],
          acceptanceChecks: [],
        },
        {
          target: "direct-cdp",
          cycles: 3,
          passedCycles: 3,
          failedCycles: 0,
          failureBuckets: [{ bucket: "none", count: 3 }],
          acceptanceChecks: [],
        },
      ],
    },
  });

  const report = buildValidationOpsReport([releaseRecord, profileRecord, soakRecord, transportRecord], 10);

  assert.equal(report.readiness.status, "passed");
  assert.equal(report.readiness.passedGates, 4);
  assert.equal(report.readiness.failedGates, 0);
  assert.equal(report.readiness.missingGates, 0);
  assert.equal(report.readiness.nextCommand, "validation-ops");
});

test("validation ops inspection surfaces fresh and stale baseline status", () => {
  const baselineRecord = buildValidationOpsRecordFromPhase1Baseline({
    runId: "baseline-1",
    startedAt: 100,
    completedAt: 200,
    result: {
      status: "passed",
      startedAt: 100,
      completedAt: 200,
      durationMs: 100,
      requiredRuns: 3,
      consecutivePassedRuns: 3,
      transportCycles: 3,
      soakCycles: 3,
      releaseSkipBuild: false,
      nextCommand: "validation-ops",
      runs: [],
      failureReasons: [],
      validationOps: {
        totalRuns: 4,
        failedRuns: 0,
        passedRuns: 4,
        attentionCount: 0,
        runTypeCounts: {},
        bucketCounts: {},
        severityCounts: {},
        recommendedActionCounts: {},
        latestRuns: [],
        activeIssues: [],
        readiness: {
          status: "passed",
          summary: "ok",
          passedGates: 4,
          failedGates: 0,
          missingGates: 0,
          nextCommand: "validation-ops",
          gates: [],
        },
        closedLoop: {
          closedLoopStatus: "completed",
          totalCases: 21,
          completedCases: 21,
          actionableCases: 0,
          silentFailureCases: 0,
          ambiguousFailureCases: 0,
          closedLoopCases: 21,
          closedLoopRate: 1,
          rerunCommand: "phase1-readiness 3 3",
          measuredRuns: 6,
          statusCounts: { completed: 6 },
          nextCommand: "validation-ops",
        },
        baseline: {
          status: "missing",
          summary: "missing",
          nextCommand: "phase1-baseline 3 3 3",
          staleAfterMs: 36 * 60 * 60 * 1000,
        },
      },
      northStar: {
        closedLoopStatus: "completed",
        totalCases: 21,
        completedCases: 21,
        actionableCases: 0,
        silentFailureCases: 0,
        ambiguousFailureCases: 0,
        closedLoopCases: 21,
        closedLoopRate: 1,
        rerunCommand: "phase1-readiness 3 3",
        measuredRuns: 6,
        statusCounts: { completed: 6 },
        nextCommand: "validation-ops",
      },
      baseline: {
        status: "missing",
        summary: "missing",
        nextCommand: "phase1-baseline 3 3 3",
        staleAfterMs: 36 * 60 * 60 * 1000,
      },
    },
  });

  const freshReport = buildValidationOpsReport([baselineRecord], 10, 1_000);
  assert.equal(freshReport.baseline.status, "fresh-passing");
  assert.equal(freshReport.baseline.consecutivePassedRuns, 3);
  assert.equal(freshReport.baseline.nextCommand, "validation-ops");
  assert.equal(freshReport.runTypeCounts["phase1-baseline"], 1);

  const staleReport = buildValidationOpsReport([baselineRecord], 10, 200 + 36 * 60 * 60 * 1000 + 1);
  assert.equal(staleReport.baseline.status, "stale");
  assert.equal(staleReport.baseline.nextCommand, "phase1-baseline 3 3 3");

  const freshFailingRecord = buildValidationOpsRecordFromPhase1Baseline({
    runId: "baseline-failed-1",
    startedAt: 300,
    completedAt: 400,
    result: {
      status: "failed",
      startedAt: 300,
      completedAt: 400,
      durationMs: 100,
      requiredRuns: 3,
      consecutivePassedRuns: 2,
      transportCycles: 3,
      soakCycles: 3,
      releaseSkipBuild: true,
      nextCommand: "phase1-baseline 3 3 3 --release-skip-build",
      runs: [],
      failureReasons: ["run 1: readiness status is failed"],
      validationOps: {
        totalRuns: 5,
        failedRuns: 1,
        passedRuns: 4,
        attentionCount: 1,
        runTypeCounts: {},
        bucketCounts: {},
        severityCounts: {},
        recommendedActionCounts: {},
        latestRuns: [],
        activeIssues: [],
        readiness: {
          status: "failed",
          summary: "failed",
          passedGates: 3,
          failedGates: 1,
          missingGates: 0,
          nextCommand: "release-verify",
          gates: [],
        },
        closedLoop: {
          closedLoopStatus: "completed",
          totalCases: 21,
          completedCases: 21,
          actionableCases: 0,
          silentFailureCases: 0,
          ambiguousFailureCases: 0,
          closedLoopCases: 21,
          closedLoopRate: 1,
          rerunCommand: "phase1-readiness 3 3",
          measuredRuns: 6,
          statusCounts: { completed: 6 },
          nextCommand: "validation-ops",
        },
        baseline: {
          status: "missing",
          summary: "missing",
          nextCommand: "phase1-baseline 3 3 3 --release-skip-build",
          staleAfterMs: 36 * 60 * 60 * 1000,
        },
      },
      northStar: {
        closedLoopStatus: "completed",
        totalCases: 21,
        completedCases: 21,
        actionableCases: 0,
        silentFailureCases: 0,
        ambiguousFailureCases: 0,
        closedLoopCases: 21,
        closedLoopRate: 1,
        rerunCommand: "phase1-readiness 3 3",
        measuredRuns: 6,
        statusCounts: { completed: 6 },
        nextCommand: "validation-ops",
      },
      baseline: {
        status: "missing",
        summary: "missing",
        nextCommand: "phase1-baseline 3 3 3 --release-skip-build",
        staleAfterMs: 36 * 60 * 60 * 1000,
      },
    },
  });

  const freshFailingReport = buildValidationOpsReport([freshFailingRecord], 10, 1_000);
  assert.equal(freshFailingReport.baseline.status, "fresh-failing");
  assert.equal(freshFailingReport.baseline.nextCommand, "phase1-baseline 3 3 3 --release-skip-build");
  assert.equal(freshFailingReport.baseline.failureReasons?.[0], "run 1: readiness status is failed");

  const staleFailingReport = buildValidationOpsReport(
    [freshFailingRecord],
    10,
    400 + 36 * 60 * 60 * 1000 + 1
  );
  assert.equal(staleFailingReport.baseline.status, "stale");
  assert.match(staleFailingReport.baseline.summary, /previous run failed 2\/3 clean runs/);
});
