import assert from "node:assert/strict";
import test from "node:test";

import {
  buildValidationOpsRecordFromPhase1Baseline,
  buildValidationOpsRecordFromTransportSoak,
  buildValidationOpsRecordFromReleaseReadiness,
  buildValidationOpsRecordFromRealLlmAcceptance,
  buildValidationOpsRecordFromSoakSeries,
  buildValidationOpsRecordFromValidationProfile,
  buildValidationOpsReport,
} from "./validation-ops-inspection";
import {
  DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS,
} from "./real-llm-acceptance-defaults";

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
  assert.equal(report.readiness.missingGates, 2);
  assert.equal(report.readiness.gates.find((gate) => gate.gateId === "phase1-e2e-profile")?.status, "missing");
  assert.equal(report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance")?.status, "missing");
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

  const realLlmRecord = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-pass",
    startedAt: 150,
    completedAt: 190,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/real-llm-pass-tool-use-e2e.json",
    artifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/real-llm-pass-mission-e2e.json",
    naturalArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/real-llm-pass-natural-mission-e2e.json",
    tooluseReport: passingToolUseAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS]),
    missionReport: passingMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS]),
    naturalMissionReport: passingNaturalMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS]),
  });

  const report = buildValidationOpsReport([releaseRecord, profileRecord, soakRecord, transportRecord, realLlmRecord], 10);

  assert.equal(report.readiness.status, "passed");
  assert.equal(report.readiness.passedGates, 5);
  assert.equal(report.readiness.failedGates, 0);
  assert.equal(report.readiness.missingGates, 0);
  assert.equal(report.readiness.nextCommand, "validation-ops");
  assert.equal(report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance")?.latestRunId, "real-llm-pass");
  assert.equal(report.closedLoop.measuredRuns, 1);
  assert.equal(report.closedLoop.totalCases, 38);
});

test("validation ops inspection does not let focused real LLM acceptance satisfy the release gate", () => {
  const realLlmRecord = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-focused-pass",
    startedAt: 150,
    completedAt: 190,
    status: "passed",
    tooluseScenarios: ["basic", "approval", "followup"],
    missionScenarios: ["basic", "comparison", "browser-dynamic"],
    naturalMissionScenarios: ["natural-comparison-research"],
    browserTooluseEnabled: true,
  });

  const report = buildValidationOpsReport([realLlmRecord], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realLlmRecord.status, "passed");
  assert.equal(report.readiness.status, "missing");
  assert.equal(realGate?.status, "missing");
  assert.equal(realGate?.latestRunId, "real-llm-focused-pass");
  assert.match(realGate?.summary ?? "", /only focused coverage is recorded/);
  assert.match(realGate?.summary ?? "", /tool-use 3\/5 missing 2/);
  assert.match(realGate?.summary ?? "", /mission 3\/12 missing 9/);
  assert.match(realGate?.summary ?? "", /natural 1\/21 missing 20/);
});

test("validation ops inspection keeps the latest full real LLM acceptance as the release gate record", () => {
  const fullRecord = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-full-pass",
    startedAt: 100,
    completedAt: 150,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/real-llm-full-pass-tool-use-e2e.json",
    artifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/real-llm-full-pass-mission-e2e.json",
    naturalArtifactPath:
      ".turnkeyai/data/validation-artifacts/real-llm-acceptance/real-llm-full-pass-natural-mission-e2e.json",
    tooluseReport: passingToolUseAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS]),
    missionReport: passingMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS]),
    naturalMissionReport: passingNaturalMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS]),
  });
  const laterFocusedRecord = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-focused-debug-pass",
    startedAt: 200,
    completedAt: 240,
    status: "passed",
    tooluseScenarios: ["basic"],
    missionScenarios: ["comparison"],
    naturalMissionScenarios: ["natural-comparison-research"],
    browserTooluseEnabled: true,
  });

  const report = buildValidationOpsReport([fullRecord, laterFocusedRecord], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realGate?.status, "passed");
  assert.equal(realGate?.latestRunId, "real-llm-full-pass");
  assert.match(realGate?.summary ?? "", /full release coverage/);
});

test("validation ops inspection does not pass full coverage without real report evidence", () => {
  const fullCoverageOnlyRecord = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-full-without-report-proof",
    startedAt: 100,
    completedAt: 150,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
  });

  const report = buildValidationOpsReport([fullCoverageOnlyRecord], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realGate?.status, "missing");
  assert.equal(realGate?.latestRunId, "real-llm-full-without-report-proof");
  assert.match(realGate?.summary ?? "", /full release coverage is recorded, but acceptance report evidence is incomplete/);
});

test("validation ops inspection requires scenario-specific tool-use proof for full release readiness", () => {
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-full-with-weak-tooluse-proof",
    startedAt: 100,
    completedAt: 150,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/tool-use.json",
    artifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/mission.json",
    naturalArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/natural.json",
    tooluseReport: {
      ...passingToolUseAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS]),
      scenarioProofs: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS].map((scenario) => ({
        scenario,
        passed: true,
        finalBytes: 220,
        evidenceBullets: 3,
        qualityFailures: 0,
        toolCallNames: ["sessions_spawn"],
        sessionsSpawned: 1,
        childTranscriptMessages: 0,
        permissionEvents: 0,
      })),
    },
    missionReport: passingMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS]),
    naturalMissionReport: passingNaturalMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS]),
  });

  const report = buildValidationOpsReport([record], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realGate?.status, "missing");
  assert.match(realGate?.summary ?? "", /acceptance report evidence is incomplete/);
});

test("validation ops inspection requires scenario-specific mission proof for full release readiness", () => {
  const missionReport = passingMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS]);
  assert.ok(missionReport);
  missionReport.scenarioProofs = (missionReport.scenarioProofs ?? []).map((proof) =>
    proof.scenario === "browser-dashboard" ? { ...proof, passed: false } : proof
  );
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-full-with-weak-mission-proof",
    startedAt: 100,
    completedAt: 150,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/tool-use.json",
    artifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/mission.json",
    naturalArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/natural.json",
    tooluseReport: passingToolUseAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS]),
    missionReport,
    naturalMissionReport: passingNaturalMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS]),
  });

  const report = buildValidationOpsReport([record], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realGate?.status, "missing");
  assert.match(realGate?.summary ?? "", /acceptance report evidence is incomplete/);
});

test("validation ops inspection requires mission proof scenario capability signals", () => {
  const missionReport = passingMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS]);
  assert.ok(missionReport);
  missionReport.scenarioProofs = (missionReport.scenarioProofs ?? []).map((proof) =>
    proof.scenario === "approval" ? { ...proof, approvalsApplied: 0 } : proof
  );
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-full-with-missing-mission-capability-signal",
    startedAt: 100,
    completedAt: 150,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/tool-use.json",
    artifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/mission.json",
    naturalArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/natural.json",
    tooluseReport: passingToolUseAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS]),
    missionReport,
    naturalMissionReport: passingNaturalMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS]),
  });

  const report = buildValidationOpsReport([record], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realGate?.status, "missing");
  assert.match(realGate?.summary ?? "", /acceptance report evidence is incomplete/);
});

test("validation ops inspection consumes duplicate mission scenario proofs by occurrence", () => {
  const duplicateScenario = "comparison";
  const missionScenarios = [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS, duplicateScenario];
  const missionReport = passingMissionAcceptanceReport(missionScenarios);
  assert.ok(missionReport);
  let duplicateCount = 0;
  missionReport.scenarioProofs = (missionReport.scenarioProofs ?? []).map((proof) => {
    if (proof.scenario !== duplicateScenario) return proof;
    duplicateCount += 1;
    return duplicateCount === 2 ? { ...proof, passed: false } : proof;
  });
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-duplicate-mission-proof",
    startedAt: 100,
    completedAt: 150,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios,
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/tool-use.json",
    artifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/mission.json",
    naturalArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/natural.json",
    tooluseReport: passingToolUseAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS]),
    missionReport,
    naturalMissionReport: passingNaturalMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS]),
  });

  const report = buildValidationOpsReport([record], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realGate?.status, "missing");
  assert.match(realGate?.summary ?? "", /acceptance report evidence is incomplete/);
});

test("validation ops inspection consumes duplicate tool-use scenario proofs by occurrence", () => {
  const duplicateScenario = "basic";
  const tooluseScenarios = [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS, duplicateScenario];
  const tooluseReport = passingToolUseAcceptanceReport(tooluseScenarios);
  let duplicateCount = 0;
  tooluseReport.scenarioProofs = (tooluseReport.scenarioProofs ?? []).map((proof) => {
    if (proof.scenario !== duplicateScenario) return proof;
    duplicateCount += 1;
    return duplicateCount === 2 ? { ...proof, passed: false } : proof;
  });
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-duplicate-tooluse-proof",
    startedAt: 100,
    completedAt: 150,
    status: "passed",
    tooluseScenarios,
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/tool-use.json",
    artifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/mission.json",
    naturalArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/natural.json",
    tooluseReport,
    missionReport: passingMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS]),
    naturalMissionReport: passingNaturalMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS]),
  });

  const report = buildValidationOpsReport([record], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realGate?.status, "missing");
  assert.match(realGate?.summary ?? "", /acceptance report evidence is incomplete/);
});

test("validation ops inspection requires scenario-specific natural mission proof for full release readiness", () => {
  const naturalMissionReport = passingNaturalMissionAcceptanceReport([
    ...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS,
  ]);
  assert.ok(naturalMissionReport);
  naturalMissionReport.scenarioProofs = (naturalMissionReport.scenarioProofs ?? []).map((proof) =>
    proof.scenario === "natural-browser-dynamic-page" ? { ...proof, browserUsed: false } : proof
  );
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-full-with-weak-natural-proof",
    startedAt: 100,
    completedAt: 150,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/tool-use.json",
    artifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/mission.json",
    naturalArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/natural.json",
    tooluseReport: passingToolUseAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS]),
    missionReport: passingMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS]),
    naturalMissionReport,
  });

  const report = buildValidationOpsReport([record], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realGate?.status, "missing");
  assert.match(realGate?.summary ?? "", /acceptance report evidence is incomplete/);
});

test("validation ops inspection requires spawned browser sessions for active natural browser proof", () => {
  const naturalMissionReport = passingNaturalMissionAcceptanceReport([
    ...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS,
  ]);
  assert.ok(naturalMissionReport);
  naturalMissionReport.scenarioProofs = (naturalMissionReport.scenarioProofs ?? []).map((proof) =>
    proof.scenario === "natural-browser-dashboard-task" ? { ...proof, browserUsed: true, sessionsSpawned: 0 } : proof
  );
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-full-with-browser-proof-without-session",
    startedAt: 100,
    completedAt: 150,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/tool-use.json",
    artifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/mission.json",
    naturalArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/natural.json",
    tooluseReport: passingToolUseAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS]),
    missionReport: passingMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS]),
    naturalMissionReport,
  });

  const report = buildValidationOpsReport([record], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realGate?.status, "missing");
  assert.match(realGate?.summary ?? "", /acceptance report evidence is incomplete/);
});

test("validation ops inspection consumes duplicate natural scenario proofs by occurrence", () => {
  const duplicateScenario = "natural-comparison-research";
  const naturalScenarios = [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS, duplicateScenario];
  const naturalMissionReport = passingNaturalMissionAcceptanceReport(naturalScenarios);
  assert.ok(naturalMissionReport);
  let duplicateCount = 0;
  naturalMissionReport.scenarioProofs = (naturalMissionReport.scenarioProofs ?? []).map((proof) => {
    if (proof.scenario !== duplicateScenario) return proof;
    duplicateCount += 1;
    return duplicateCount === 2 ? { ...proof, passed: false } : proof;
  });
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-duplicate-natural-proof",
    startedAt: 100,
    completedAt: 150,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: naturalScenarios,
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/tool-use.json",
    artifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/mission.json",
    naturalArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/natural.json",
    tooluseReport: passingToolUseAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS]),
    missionReport: passingMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS]),
    naturalMissionReport,
  });

  const report = buildValidationOpsReport([record], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realGate?.status, "missing");
});

test("validation ops inspection allows non-blocking natural weak signals when scenario proof passes", () => {
  const naturalMissionReport = passingNaturalMissionAcceptanceReport([
    ...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS,
  ]);
  assert.ok(naturalMissionReport);
  naturalMissionReport.weakAnswerSignals = 1;
  naturalMissionReport.scenarioProofs = (naturalMissionReport.scenarioProofs ?? []).map((proof) =>
    proof.scenario === "natural-browser-unavailable-closeout" ? { ...proof, weakAnswerSignals: 1 } : proof
  );
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-full-with-allowed-natural-weak-signal",
    startedAt: 100,
    completedAt: 150,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/tool-use.json",
    artifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/mission.json",
    naturalArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/natural.json",
    tooluseReport: passingToolUseAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS]),
    missionReport: passingMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS]),
    naturalMissionReport,
  });

  const report = buildValidationOpsReport([record], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realGate?.status, "passed");
});

test("validation ops inspection lets a newer failed real LLM acceptance invalidate an older proven full run", () => {
  const fullRecord = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-full-pass",
    startedAt: 100,
    completedAt: 150,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/real-llm-full-pass-tool-use-e2e.json",
    artifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/real-llm-full-pass-mission-e2e.json",
    naturalArtifactPath:
      ".turnkeyai/data/validation-artifacts/real-llm-acceptance/real-llm-full-pass-natural-mission-e2e.json",
    tooluseReport: passingToolUseAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS]),
    missionReport: passingMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS]),
    naturalMissionReport: passingNaturalMissionAcceptanceReport([...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS]),
  });
  const laterFailedRecord = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-failed-latest",
    startedAt: 200,
    completedAt: 240,
    status: "failed",
    tooluseScenarios: ["basic"],
    missionScenarios: ["comparison"],
    naturalMissionScenarios: ["natural-comparison-research"],
    browserTooluseEnabled: true,
    error: "natural comparison failed",
  });

  const report = buildValidationOpsReport([fullRecord, laterFailedRecord], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realGate?.status, "failed");
  assert.equal(realGate?.latestRunId, "real-llm-failed-latest");
});

test("validation ops inspection treats partial real LLM release coverage metadata as missing", () => {
  const partialCoverageRecord = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-partial-metadata",
    startedAt: 100,
    completedAt: 150,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
  });
  partialCoverageRecord.realAcceptance!.releaseCoverage = {
    status: "full",
    tooluse: { status: "full", requested: 5, expected: 5, missing: 0 },
  } as any;

  const report = buildValidationOpsReport([partialCoverageRecord], 10);
  const realGate = report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance");

  assert.equal(realGate?.status, "missing");
  assert.equal(realGate?.latestRunId, "real-llm-partial-metadata");
  assert.match(realGate?.summary ?? "", /tool-use 5\/5/);
  assert.match(realGate?.summary ?? "", /mission 0\/0/);
  assert.match(realGate?.summary ?? "", /natural 0\/0/);
});

test("validation ops inspection records failed real LLM acceptance as actionable", () => {
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-fail",
    startedAt: 10,
    completedAt: 30,
    status: "failed",
    tooluseScenarios: ["basic"],
    missionScenarios: ["comparison"],
    browserTooluseEnabled: false,
    error: "mission comparison failed with exit code 1",
  });

  const report = buildValidationOpsReport([record], 10);

  assert.equal(record.runType, "real-llm-acceptance");
  assert.equal(record.issueCount, 1);
  assert.equal(record.issues[0]?.kind, "real-llm-gate");
  assert.equal(record.issues[0]?.bucket, "llm");
  assert.equal(record.issues[0]?.severity, "critical");
  assert.equal(record.issues[0]?.recommendedAction, "rerun-real-acceptance");
  assert.equal(report.readiness.status, "failed");
  assert.equal(report.readiness.gates.find((gate) => gate.gateId === "real-llm-acceptance")?.status, "failed");
  assert.equal(report.closedLoop.closedLoopStatus, "actionable");
  assert.equal(report.closedLoop.totalCases, 2);
});

test("validation ops inspection preserves real LLM acceptance artifact path", () => {
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-pass",
    startedAt: 10,
    completedAt: 30,
    status: "passed",
    tooluseScenarios: ["basic"],
    missionScenarios: ["realistic-brief"],
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/tool-use.json",
    artifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/report.json",
  });

  assert.equal(record.artifactPath, ".turnkeyai/data/validation-artifacts/real-llm-acceptance/report.json");
  assert.equal(record.realAcceptance?.tooluseArtifactPath, ".turnkeyai/data/validation-artifacts/real-llm-acceptance/tool-use.json");
});

test("validation ops inspection preserves real LLM tool-use report summary", () => {
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-tooluse-pass",
    startedAt: 10,
    completedAt: 30,
    status: "passed",
    tooluseScenarios: ["basic", "approval"],
    missionScenarios: ["realistic-brief"],
    browserTooluseEnabled: true,
    tooluseArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/tool-use.json",
    tooluseReport: {
      status: "passed",
      scenarioCount: 2,
      scenarioIds: ["basic", "approval"],
      passedScenarios: 2,
      failedScenarios: 0,
      qualityFailures: 0,
      finalBytes: 500,
      evidenceBullets: 6,
      toolCalls: 4,
      sessionsSpawned: 2,
      childTranscriptMessages: 8,
      permissionEvents: 3,
    },
  });

  assert.equal(record.realAcceptance?.tooluseArtifactPath, ".turnkeyai/data/validation-artifacts/real-llm-acceptance/tool-use.json");
  assert.equal(record.realAcceptance?.tooluseReport?.scenarioCount, 2);
  assert.equal(record.realAcceptance?.tooluseReport?.toolCalls, 4);
  assert.equal(record.realAcceptance?.tooluseReport?.permissionEvents, 3);
});

test("validation ops inspection preserves real LLM mission report summary", () => {
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-pass",
    startedAt: 10,
    completedAt: 30,
    status: "passed",
    tooluseScenarios: ["basic", "complex"],
    missionScenarios: ["realistic-brief", "browser-dashboard"],
    browserTooluseEnabled: true,
    missionReport: {
      status: "passed",
      scenarioCount: 2,
      scenarioIds: ["realistic-brief", "browser-dashboard"],
      passedScenarios: 2,
      failedScenarios: 0,
      qualityFailures: 0,
      toolRequested: 4,
      toolResults: 4,
      toolFailed: 0,
      toolCancelled: 0,
      toolTimeouts: 0,
      sessionsSpawned: 3,
      sessionsContinued: 1,
      browserProfileFallbacks: 0,
      browserFailureBuckets: 0,
      approvalsRequested: 0,
      approvalsDecided: 0,
      approvalsApplied: 0,
      livenessActive: 0,
      livenessWaiting: 0,
      livenessStale: 0,
      qualityCheckWarnings: 1,
      qualityCheckFailures: 0,
      sourceCoverageWarnings: 1,
      sourceCoverageFailures: 0,
      evidenceEvents: 5,
      recoveryEvents: 0,
    },
  });

  assert.deepEqual(record.realAcceptance, {
    tooluseScenarios: ["basic", "complex"],
    missionScenarios: ["realistic-brief", "browser-dashboard"],
    browserTooluseEnabled: true,
    totalCases: 4,
    releaseCoverage: {
      status: "focused",
      tooluse: { status: "focused", requested: 2, expected: 5, missing: 3 },
      mission: { status: "focused", requested: 2, expected: 12, missing: 10 },
      naturalMission: { status: "skipped", requested: 0, expected: 21, missing: 21 },
    },
    missionReport: {
      status: "passed",
      scenarioCount: 2,
      scenarioIds: ["realistic-brief", "browser-dashboard"],
      passedScenarios: 2,
      failedScenarios: 0,
      qualityFailures: 0,
      toolRequested: 4,
      toolResults: 4,
      toolFailed: 0,
      toolCancelled: 0,
      toolTimeouts: 0,
      sessionsSpawned: 3,
      sessionsContinued: 1,
      browserProfileFallbacks: 0,
      browserFailureBuckets: 0,
      approvalsRequested: 0,
      approvalsDecided: 0,
      approvalsApplied: 0,
      livenessActive: 0,
      livenessWaiting: 0,
      livenessStale: 0,
      qualityCheckWarnings: 1,
      qualityCheckFailures: 0,
      sourceCoverageWarnings: 1,
      sourceCoverageFailures: 0,
      evidenceEvents: 5,
      recoveryEvents: 0,
    },
  });
});

test("validation ops inspection preserves natural mission acceptance summary", () => {
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-natural-pass",
    startedAt: 10,
    completedAt: 30,
    status: "passed",
    tooluseScenarios: ["basic"],
    missionScenarios: ["realistic-brief"],
    naturalMissionScenarios: ["natural-browser-dynamic-page", "natural-long-delegation"],
    browserTooluseEnabled: true,
    naturalArtifactPath: ".turnkeyai/data/validation-artifacts/real-llm-acceptance/natural.json",
    naturalMissionReport: {
      status: "passed",
      scenarioCount: 2,
      scenarioIds: ["natural-browser-dynamic-page", "natural-long-delegation"],
      passedScenarios: 2,
      failedScenarios: 0,
      completed: 2,
      stuckOrLoop: 0,
      reasonableToolUse: 2,
      browserUsed: 2,
      subAgentCompleted: 2,
      approvalExercised: 1,
      finalAnswerHasEvidence: 2,
      finalAnswerUseful: 2,
      weakAnswerSignals: 0,
      toolRequested: 4,
      toolResults: 4,
      toolFailed: 0,
      toolCancelled: 0,
      toolTimeouts: 0,
      sessionsSpawned: 3,
      sessionsContinued: 1,
      browserProfileFallbacks: 0,
      browserFailureBuckets: 0,
      approvalsRequested: 1,
      approvalsDecided: 1,
      approvalsApplied: 1,
      livenessActive: 0,
      livenessWaiting: 0,
      livenessStale: 0,
      evidenceEvents: 5,
      sourceAnswerTermsCovered: 7,
      sourceAnswerTermsTotal: 8,
      sourceAnswerTermsMissing: 1,
      sourceAnswerPatternsCovered: 3,
      sourceAnswerPatternsTotal: 3,
      sourceAnswerPatternsMissing: 0,
      sourceEvidencePatternsCovered: 6,
      sourceEvidencePatternsTotal: 7,
      sourceEvidencePatternsMissing: 1,
      sourceEvidenceEventsObserved: 5,
      sourceEvidenceEventsRequired: 2,
      sourceResidualRiskVisible: 2,
      sourceUnsupportedClaims: 0,
      recoveryEvents: 0,
    },
  });

  assert.deepEqual(record.realAcceptance?.naturalMissionScenarios, [
    "natural-browser-dynamic-page",
    "natural-long-delegation",
  ]);
  assert.equal(record.realAcceptance?.totalCases, 4);
  assert.equal(record.realAcceptance?.naturalArtifactPath, ".turnkeyai/data/validation-artifacts/real-llm-acceptance/natural.json");
  assert.deepEqual(record.realAcceptance?.releaseCoverage, {
    status: "focused",
    tooluse: { status: "focused", requested: 1, expected: 5, missing: 4 },
    mission: { status: "focused", requested: 1, expected: 12, missing: 11 },
    naturalMission: { status: "focused", requested: 2, expected: 21, missing: 19 },
  });
  assert.equal(record.realAcceptance?.naturalMissionReport?.finalAnswerUseful, 2);
  assert.equal(record.realAcceptance?.naturalMissionReport?.sourceEvidencePatternsCovered, 6);
  assert.ok(record.selectors?.includes("natural-mission:natural-browser-dynamic-page"));
});

test("validation ops inspection marks full real acceptance release coverage", () => {
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-full-pass",
    startedAt: 10,
    completedAt: 30,
    status: "passed",
    tooluseScenarios: [...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS],
    missionScenarios: [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS],
    naturalMissionScenarios: [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS],
    browserTooluseEnabled: true,
  });

  assert.deepEqual(record.realAcceptance?.releaseCoverage, {
    status: "full",
    tooluse: { status: "full", requested: 5, expected: 5, missing: 0 },
    mission: { status: "full", requested: 12, expected: 12, missing: 0 },
    naturalMission: { status: "full", requested: 21, expected: 21, missing: 0 },
  });
});

test("validation ops inspection counts only expected scenarios in release coverage", () => {
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: "real-llm-custom-pass",
    startedAt: 10,
    completedAt: 30,
    status: "passed",
    tooluseScenarios: ["basic", "basic", "custom-tooluse"],
    missionScenarios: ["realistic-brief", "custom-mission"],
    naturalMissionScenarios: ["natural-long-delegation", "custom-natural"],
    browserTooluseEnabled: true,
  });

  assert.deepEqual(record.realAcceptance?.releaseCoverage, {
    status: "focused",
    tooluse: { status: "focused", requested: 1, expected: 5, missing: 4 },
    mission: { status: "focused", requested: 1, expected: 12, missing: 11 },
    naturalMission: { status: "focused", requested: 1, expected: 21, missing: 20 },
  });
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

function passingMissionAcceptanceReport(
  scenarioIds: string[]
): NonNullable<ReturnType<typeof buildValidationOpsRecordFromRealLlmAcceptance>["realAcceptance"]>["missionReport"] {
  const scenarioProofs = scenarioIds.map((scenario) => passingMissionScenarioProof(scenario));
  return {
    status: "passed",
    scenarioCount: scenarioIds.length,
    scenarioIds,
    passedScenarios: scenarioIds.length,
    failedScenarios: 0,
    qualityFailures: 0,
    toolRequested: scenarioIds.length,
    toolResults: scenarioIds.length,
    toolFailed: 0,
    toolCancelled: 0,
    toolTimeouts: 0,
    sessionsSpawned: scenarioIds.length,
    sessionsContinued: 0,
    browserProfileFallbacks: 0,
    browserFailureBuckets: 0,
    approvalsRequested: 0,
    approvalsDecided: 0,
    approvalsApplied: 0,
    livenessActive: 0,
    livenessWaiting: 0,
    livenessStale: 0,
    qualityCheckWarnings: 0,
    qualityCheckFailures: 0,
    sourceCoverageWarnings: 0,
    sourceCoverageFailures: 0,
    evidenceEvents: scenarioIds.length,
    recoveryEvents: 0,
    scenarioProofs,
  };
}

function passingMissionScenarioProof(
  scenario: string
): NonNullable<
  NonNullable<
    NonNullable<ReturnType<typeof buildValidationOpsRecordFromRealLlmAcceptance>["realAcceptance"]>["missionReport"]
  >["scenarioProofs"]
>[number] {
  const base = {
    scenario,
    passed: true,
    qualityFailures: 0,
    toolRequested: 1,
    toolResults: 1,
    toolFailed: 0,
    toolCancelled: 0,
    toolTimeouts: 0,
    sessionsSpawned: 1,
    sessionsContinued: 0,
    browserProfileFallbacks: 0,
    browserFailureBuckets: 0,
    approvalsRequested: 0,
    approvalsDecided: 0,
    approvalsApplied: 0,
    livenessActive: 0,
    livenessWaiting: 0,
    livenessStale: 0,
    qualityCheckFailures: 0,
    sourceCoverageFailures: 0,
    evidenceEvents: 1,
    recoveryEvents: 0,
  };
  if (scenario === "approval") {
    return {
      ...base,
      approvalsRequested: 1,
      approvalsDecided: 1,
      approvalsApplied: 1,
    };
  }
  if (scenario === "followup") {
    return {
      ...base,
      sessionsContinued: 1,
    };
  }
  if (scenario === "cancel") {
    return {
      ...base,
      toolFailed: 1,
      toolCancelled: 1,
    };
  }
  if (scenario === "timeout-recovery") {
    return {
      ...base,
      toolFailed: 1,
      toolTimeouts: 1,
    };
  }
  if (scenario === "memory-recall") {
    return {
      ...base,
      toolRequested: 2,
      toolResults: 2,
      sessionsSpawned: 0,
    };
  }
  if (scenario === "task-tracking") {
    return {
      ...base,
      toolRequested: 3,
      toolResults: 3,
      sessionsSpawned: 0,
    };
  }
  if (scenario === "realistic-brief" || scenario === "product-workbench-brief") {
    return {
      ...base,
      toolRequested: 3,
      toolResults: 3,
      sessionsSpawned: 3,
    };
  }
  return base;
}

function passingToolUseAcceptanceReport(
  scenarioIds: string[]
): NonNullable<
  NonNullable<ReturnType<typeof buildValidationOpsRecordFromRealLlmAcceptance>["realAcceptance"]>["tooluseReport"]
> {
  const scenarioProofs = scenarioIds.map((scenario) => passingToolUseScenarioProof(scenario));
  return {
    status: "passed",
    scenarioCount: scenarioIds.length,
    scenarioIds,
    passedScenarios: scenarioIds.length,
    failedScenarios: 0,
    qualityFailures: 0,
    finalBytes: scenarioIds.length * 220,
    evidenceBullets: scenarioIds.length * 3,
    toolCalls: scenarioIds.length,
    sessionsSpawned: scenarioIds.length,
    childTranscriptMessages: scenarioIds.length * 4,
    permissionEvents: scenarioProofs.reduce((sum, proof) => sum + proof.permissionEvents, 0),
    scenarioProofs,
  };
}

function passingToolUseScenarioProof(
  scenario: string
): NonNullable<
  NonNullable<
    NonNullable<ReturnType<typeof buildValidationOpsRecordFromRealLlmAcceptance>["realAcceptance"]>["tooluseReport"]
  >["scenarioProofs"]
>[number] {
  const base = {
    scenario,
    passed: true,
    finalBytes: 220,
    evidenceBullets: 3,
    qualityFailures: 0,
    toolCallNames: ["sessions_spawn"],
    sessionsSpawned: 1,
    childTranscriptMessages: 4,
    permissionEvents: 0,
  };
  if (scenario === "approval") {
    return {
      ...base,
      toolCallNames: ["permission_query", "permission_result", "permission_applied", "sessions_spawn"],
      permissionEvents: 3,
    };
  }
  if (scenario === "followup") {
    return {
      ...base,
      toolCallNames: ["sessions_spawn", "sessions_send"],
    };
  }
  if (scenario === "complex") {
    return {
      ...base,
      sessionsSpawned: 2,
      childTranscriptMessages: 4,
    };
  }
  return base;
}

function passingNaturalMissionAcceptanceReport(
  scenarioIds: string[]
): NonNullable<ReturnType<typeof buildValidationOpsRecordFromRealLlmAcceptance>["realAcceptance"]>["naturalMissionReport"] {
  const scenarioProofs = scenarioIds.map(passingNaturalMissionScenarioProof);
  return {
    status: "passed",
    scenarioCount: scenarioIds.length,
    scenarioIds,
    passedScenarios: scenarioIds.length,
    failedScenarios: 0,
    completed: scenarioIds.length,
    stuckOrLoop: 0,
    reasonableToolUse: scenarioIds.length,
    browserUsed: scenarioProofs.filter((proof) => proof.browserUsed).length,
    subAgentCompleted: scenarioIds.length,
    approvalExercised: scenarioProofs.filter((proof) => proof.approvalExercised).length,
    finalAnswerHasEvidence: scenarioIds.length,
    finalAnswerUseful: scenarioIds.length,
    weakAnswerSignals: 0,
    toolRequested: scenarioIds.length,
    toolResults: scenarioIds.length,
    toolFailed: scenarioProofs.reduce((sum, proof) => sum + proof.toolFailed, 0),
    toolCancelled: scenarioProofs.reduce((sum, proof) => sum + proof.toolCancelled, 0),
    toolTimeouts: scenarioProofs.reduce((sum, proof) => sum + proof.toolTimeouts, 0),
    sessionsSpawned: scenarioProofs.reduce((sum, proof) => sum + proof.sessionsSpawned, 0),
    sessionsContinued: scenarioProofs.reduce((sum, proof) => sum + proof.sessionsContinued, 0),
    browserProfileFallbacks: scenarioProofs.reduce((sum, proof) => sum + proof.browserProfileFallbacks, 0),
    browserFailureBuckets: scenarioProofs.reduce((sum, proof) => sum + proof.browserFailureBuckets, 0),
    approvalsRequested: scenarioProofs.reduce((sum, proof) => sum + proof.approvalsRequested, 0),
    approvalsDecided: scenarioProofs.reduce((sum, proof) => sum + proof.approvalsDecided, 0),
    approvalsApplied: scenarioProofs.reduce((sum, proof) => sum + proof.approvalsApplied, 0),
    livenessActive: 0,
    livenessWaiting: 0,
    livenessStale: 0,
    evidenceEvents: scenarioIds.length,
    sourceAnswerTermsCovered: scenarioIds.length,
    sourceAnswerTermsTotal: scenarioIds.length,
    sourceAnswerTermsMissing: 0,
    sourceAnswerPatternsCovered: scenarioIds.length,
    sourceAnswerPatternsTotal: scenarioIds.length,
    sourceAnswerPatternsMissing: 0,
    sourceEvidencePatternsCovered: scenarioIds.length,
    sourceEvidencePatternsTotal: scenarioIds.length,
    sourceEvidencePatternsMissing: 0,
    sourceEvidenceEventsObserved: scenarioIds.length,
    sourceEvidenceEventsRequired: scenarioIds.length,
    sourceResidualRiskVisible: scenarioIds.length,
    sourceUnsupportedClaims: 0,
    recoveryEvents: scenarioProofs.reduce((sum, proof) => sum + proof.recoveryEvents, 0),
    scenarioProofs,
  };
}

function passingNaturalMissionScenarioProof(
  scenario: string
): NonNullable<
  NonNullable<
    NonNullable<ReturnType<typeof buildValidationOpsRecordFromRealLlmAcceptance>["realAcceptance"]>["naturalMissionReport"]
  >["scenarioProofs"]
>[number] {
  const isBrowserFailureCloseout =
    scenario === "natural-browser-unavailable-closeout" ||
    scenario === "natural-browser-cdp-timeout-closeout" ||
    scenario === "natural-browser-detached-target-closeout" ||
    scenario === "natural-browser-attach-failed-closeout";
  const base = {
    scenario,
    passed: true,
    completed: true,
    stuckOrLoop: false,
    reasonableToolUse: true,
    browserUsed: scenario.startsWith("natural-browser-") && !isBrowserFailureCloseout,
    subAgentCompleted: true,
    approvalExercised: false,
    finalAnswerHasEvidence: true,
    finalAnswerUseful: true,
    weakAnswerSignals: 0,
    toolFailed: 0,
    toolCancelled: 0,
    toolTimeouts: 0,
    sessionsSpawned: scenario === "natural-long-delegation" ? 2 : 1,
    sessionsContinued: scenario.includes("followup") || scenario.includes("continuation") ? 1 : 0,
    browserProfileFallbacks: scenario === "natural-browser-profile-lock-recovery" ? 1 : 0,
    browserFailureBuckets: isBrowserFailureCloseout ? 1 : 0,
    approvalsRequested: 0,
    approvalsDecided: 0,
    approvalsApplied: 0,
    livenessActive: 0,
    livenessWaiting: 0,
    livenessStale: 0,
    evidenceEvents: 1,
    recoveryEvents: isBrowserFailureCloseout ? 1 : 0,
    sourceResidualRiskVisible: true,
    sourceUnsupportedClaims: 0,
    sourceAnswerTermsMissing: 0,
    sourceAnswerPatternsMissing: 0,
    sourceEvidencePatternsMissing: 0,
    dimensionScores: passingNaturalDimensionScores(),
    failureBuckets: [],
  };
  if (scenario === "natural-approval-dry-run-action") {
    return {
      ...base,
      approvalExercised: true,
      approvalsRequested: 1,
      approvalsDecided: 1,
      approvalsApplied: 1,
    };
  }
  if (scenario === "natural-approval-denied-safe-closeout" || scenario === "natural-approval-pending-state") {
    return {
      ...base,
      approvalExercised: true,
      approvalsRequested: 1,
      approvalsDecided: scenario === "natural-approval-denied-safe-closeout" ? 1 : 0,
    };
  }
  if (scenario.includes("timeout")) {
    return {
      ...base,
      toolFailed: 1,
      toolTimeouts: 1,
    };
  }
  if (scenario.includes("cancel")) {
    return {
      ...base,
      toolCancelled: 1,
    };
  }
  return base;
}

function passingNaturalDimensionScores() {
  return {
    taskCompletion: 2,
    evidenceQuality: 2,
    toolUseAppropriateness: 2,
    browserAuthenticity: 2,
    subAgentIndependence: 2,
    continuationBehavior: 2,
    permissionCorrectness: 2,
    timeoutCloseoutQuality: 2,
  };
}
