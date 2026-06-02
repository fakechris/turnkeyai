import assert from "node:assert/strict";
import test from "node:test";

import type { ValidationOpsRunRecord } from "../api/types";
import {
  formatNaturalScenarioProofSummary,
  formatRealAcceptanceCoverageSummary,
  formatRealAcceptanceNaturalSummary,
  formatValidationRunArtifactPaths,
} from "./RuntimePage";

function runWithNaturalReport(
  naturalMissionReport: NonNullable<NonNullable<ValidationOpsRunRecord["realAcceptance"]>["naturalMissionReport"]>
): ValidationOpsRunRecord {
  return {
    runId: "run.real.1",
    runType: "real-llm-acceptance",
    title: "Real acceptance",
    status: "passed",
    completedAt: Date.now(),
    durationMs: 10_000,
    issueCount: 0,
    realAcceptance: {
      tooluseScenarios: ["basic"],
      missionScenarios: ["realistic-brief"],
      naturalMissionScenarios: ["natural-browser-dynamic-page"],
      browserTooluseEnabled: true,
      totalCases: 3,
      releaseCoverage: {
        status: "focused",
        tooluse: { status: "focused", requested: 1, expected: 5, missing: 4 },
        mission: { status: "focused", requested: 1, expected: 12, missing: 11 },
        naturalMission: { status: "focused", requested: 1, expected: 21, missing: 20 },
      },
      naturalMissionReport,
    },
  };
}

test("formatRealAcceptanceNaturalSummary surfaces source coverage counts", () => {
  const summary = formatRealAcceptanceNaturalSummary(
    runWithNaturalReport({
      status: "passed",
      progressClaim: "natural-evidence",
      capabilityClaim: "unproven-without-comparative-evidence",
      scenarioCount: 2,
      scenarioIds: ["natural-browser-dynamic-page", "natural-long-delegation"],
      passedScenarios: 2,
      failedScenarios: 0,
      completed: 2,
      stuckOrLoop: 0,
      reasonableToolUse: 2,
      browserUsed: 1,
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
      sessionsSpawned: 2,
      sessionsContinued: 1,
      browserProfileFallbacks: 0,
      browserFailureBuckets: 0,
      approvalsRequested: 1,
      approvalsDecided: 1,
      approvalsApplied: 1,
      livenessActive: 0,
      livenessWaiting: 0,
      livenessStale: 0,
      evidenceEvents: 3,
      sourceAnswerTermsCovered: 5,
      sourceAnswerTermsTotal: 6,
      sourceAnswerTermsMissing: 1,
      sourceAnswerPatternsCovered: 2,
      sourceAnswerPatternsTotal: 2,
      sourceAnswerPatternsMissing: 0,
      sourceEvidencePatternsCovered: 4,
      sourceEvidencePatternsTotal: 5,
      sourceEvidencePatternsMissing: 1,
      sourceEvidenceEventsObserved: 3,
      sourceEvidenceEventsRequired: 2,
      sourceResidualRiskVisible: 2,
      sourceUnsupportedClaims: 0,
      recoveryEvents: 0,
    })
  );

  assert.equal(
    summary,
    "claim natural-evidence · capability unproven-without-comparative-evidence · 2/2 natural scenarios · evidence 2/2 · useful 2/2 · source terms 5/6 · source patterns 2/2 · evidence patterns 4/5 · missing 2 · unsupported 0 · risk 2/2"
  );
});

test("formatRealAcceptanceNaturalSummary stays hidden for legacy runs", () => {
  assert.equal(
    formatRealAcceptanceNaturalSummary({
      runId: "run.legacy.1",
      runType: "real-llm-acceptance",
      title: "Legacy real acceptance",
      status: "passed",
      completedAt: Date.now(),
      durationMs: 10_000,
      issueCount: 0,
      realAcceptance: {
        tooluseScenarios: ["basic"],
        missionScenarios: ["realistic-brief"],
        browserTooluseEnabled: true,
        totalCases: 2,
      },
    }),
    null
  );
});

test("formatRealAcceptanceNaturalSummary defaults missing source coverage fields to zero", () => {
  const summary = formatRealAcceptanceNaturalSummary(
    runWithNaturalReport({
      status: "passed",
      scenarioCount: 1,
      passedScenarios: 1,
      finalAnswerHasEvidence: 1,
      finalAnswerUseful: 1,
    } as unknown as NonNullable<NonNullable<ValidationOpsRunRecord["realAcceptance"]>["naturalMissionReport"]>)
  );

  assert.equal(
    summary,
    "1/1 natural scenarios · evidence 1/1 · useful 1/1 · source terms 0/0 · source patterns 0/0 · evidence patterns 0/0 · missing 0 · unsupported 0 · risk 0/1"
  );
  assert.equal(summary?.includes("NaN"), false);
});

test("formatRealAcceptanceCoverageSummary distinguishes focused gates from release coverage", () => {
  assert.equal(
    formatRealAcceptanceCoverageSummary(runWithNaturalReport({
      status: "passed",
      scenarioCount: 1,
      passedScenarios: 1,
      finalAnswerHasEvidence: 1,
      finalAnswerUseful: 1,
    } as unknown as NonNullable<NonNullable<ValidationOpsRunRecord["realAcceptance"]>["naturalMissionReport"]>)),
    "focused gate · tool-use 1/5 (missing 4) · mission 1/12 (missing 11) · natural 1/21 (missing 20)"
  );
});

test("formatNaturalScenarioProofSummary surfaces per-scenario proof signals", () => {
  const summary = formatNaturalScenarioProofSummary({
    scenario: "natural-browser-dashboard-task",
    passed: true,
    completed: true,
    stuckOrLoop: false,
    reasonableToolUse: true,
    browserUsed: true,
    subAgentCompleted: true,
    approvalExercised: true,
    finalAnswerHasEvidence: true,
    finalAnswerUseful: true,
    weakAnswerSignals: 0,
    toolFailed: 1,
    toolCancelled: 0,
    toolTimeouts: 1,
    sessionsSpawned: 1,
    sessionsContinued: 0,
    browserProfileFallbacks: 1,
    browserFailureBuckets: 1,
    approvalsRequested: 1,
    approvalsDecided: 1,
    approvalsApplied: 0,
    livenessActive: 0,
    livenessWaiting: 0,
    livenessStale: 0,
    evidenceEvents: 2,
    recoveryEvents: 1,
    sourceResidualRiskVisible: true,
    sourceUnsupportedClaims: 0,
    sourceAnswerTermsMissing: 1,
    sourceAnswerPatternsMissing: 0,
    sourceEvidencePatternsMissing: 2,
  });

  assert.equal(
    summary,
    "status passed · browser yes · sessions 1/0 · evidence 2 · useful yes · risk yes · missing 3 · approval 1/1/0 · tool f/t/c 1/1/0 · browser recovery 1/1"
  );
});

test("formatRealAcceptanceCoverageSummary stays hidden for legacy records", () => {
  assert.equal(
    formatRealAcceptanceCoverageSummary({
      runId: "run.legacy.1",
      runType: "real-llm-acceptance",
      title: "Legacy real acceptance",
      status: "passed",
      completedAt: Date.now(),
      durationMs: 10_000,
      issueCount: 0,
      realAcceptance: {
        tooluseScenarios: ["basic"],
        missionScenarios: ["realistic-brief"],
        browserTooluseEnabled: true,
        totalCases: 2,
      },
    }),
    null
  );
});

test("formatValidationRunArtifactPaths surfaces every real acceptance proof artifact", () => {
  assert.deepEqual(
    formatValidationRunArtifactPaths({
      runId: "run.real.1",
      runType: "real-llm-acceptance",
      title: "Real acceptance",
      status: "passed",
      completedAt: Date.now(),
      durationMs: 10_000,
      issueCount: 0,
      artifactPath: "validation-artifacts/real-llm-acceptance/mission.json",
      realAcceptance: {
        tooluseScenarios: ["basic"],
        missionScenarios: ["realistic-brief"],
        naturalMissionScenarios: ["natural-browser-dashboard-task"],
        browserTooluseEnabled: true,
        totalCases: 3,
        tooluseArtifactPath: "validation-artifacts/real-llm-acceptance/tool-use.json",
        naturalArtifactPath: "validation-artifacts/real-llm-acceptance/natural.json",
      },
    }),
    [
      { label: "tool-use artifact", path: "validation-artifacts/real-llm-acceptance/tool-use.json" },
      { label: "mission artifact", path: "validation-artifacts/real-llm-acceptance/mission.json" },
      { label: "natural artifact", path: "validation-artifacts/real-llm-acceptance/natural.json" },
    ]
  );
});

test("formatValidationRunArtifactPaths keeps legacy artifact labels stable", () => {
  assert.deepEqual(
    formatValidationRunArtifactPaths({
      runId: "run.legacy.1",
      runType: "release-readiness",
      title: "Release readiness",
      status: "passed",
      completedAt: Date.now(),
      durationMs: 10_000,
      issueCount: 0,
      artifactPath: "validation-artifacts/release-readiness.json",
    }),
    [{ label: "artifact", path: "validation-artifacts/release-readiness.json" }]
  );
});
