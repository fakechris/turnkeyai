import assert from "node:assert/strict";
import test from "node:test";

import type { ValidationOpsRunRecord } from "../api/types";
import { formatRealAcceptanceNaturalSummary } from "./RuntimePage";

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
      naturalMissionReport,
    },
  };
}

test("formatRealAcceptanceNaturalSummary surfaces source coverage counts", () => {
  const summary = formatRealAcceptanceNaturalSummary(
    runWithNaturalReport({
      status: "passed",
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
    "2/2 natural scenarios · evidence 2/2 · useful 2/2 · source terms 5/6 · source patterns 2/2 · evidence patterns 4/5 · missing 2 · unsupported 0 · risk 2/2"
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
