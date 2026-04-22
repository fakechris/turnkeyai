import assert from "node:assert/strict";
import test from "node:test";

import {
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
