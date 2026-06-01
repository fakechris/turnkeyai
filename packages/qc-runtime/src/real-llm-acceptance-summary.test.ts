import assert from "node:assert/strict";
import test from "node:test";

import {
  summarizeMissionE2eReportForValidationOps,
  summarizeNaturalMissionE2eReportForValidationOps,
} from "./real-llm-acceptance-summary";

test("summarizeMissionE2eReportForValidationOps aggregates scenario quality and liveness", () => {
  const summary = summarizeMissionE2eReportForValidationOps({
    kind: "turnkeyai.mission-e2e.report",
    status: "failed",
    scenarios: [
      {
        scenario: "comparison",
        status: "done",
        qualityGate: "passed",
        metrics: {
          tools: { requested: 2, results: 2, failed: 0, cancelled: 0, timeouts: 0 },
          sessions: { spawned: 2, continued: 1 },
          browser: { profileFallbacks: 0 },
          approvals: { requested: 1, decided: 1, applied: 1 },
          liveness: { active: 0, waiting: 0, stale: 0 },
          qualityChecks: [
            { name: "final_answer", status: "pass" },
            { name: "source_coverage", status: "pass" },
          ],
          evidenceEvents: 3,
          recoveryEvents: 0,
        },
        final: { qualityFailures: [] },
      },
      {
        scenario: "realistic-brief",
        status: "blocked",
        qualityGate: "blocked",
        metrics: {
          tools: { requested: 1, results: 1, failed: 1, cancelled: 0, timeouts: 1 },
          sessions: { spawned: 1, continued: 0 },
          browser: { profileFallbacks: 1 },
          approvals: { requested: 0, decided: 0, applied: 0 },
          liveness: { active: 0, waiting: 1, stale: 1 },
          qualityChecks: [
            { name: "source_coverage", status: "warn" },
            { name: "runtime_liveness", status: "fail" },
          ],
          evidenceEvents: 1,
          recoveryEvents: 2,
        },
        final: { qualityFailures: ["missing residual risk"] },
      },
    ],
  });

  assert.deepEqual(summary, {
    status: "failed",
    scenarioCount: 2,
    scenarioIds: ["comparison", "realistic-brief"],
    passedScenarios: 1,
    failedScenarios: 1,
    qualityFailures: 1,
    toolRequested: 3,
    toolResults: 3,
    toolFailed: 1,
    toolCancelled: 0,
    toolTimeouts: 1,
    sessionsSpawned: 3,
    sessionsContinued: 1,
    browserProfileFallbacks: 1,
    approvalsRequested: 1,
    approvalsDecided: 1,
    approvalsApplied: 1,
    livenessActive: 0,
    livenessWaiting: 1,
    livenessStale: 1,
    qualityCheckWarnings: 1,
    qualityCheckFailures: 1,
    sourceCoverageWarnings: 1,
    sourceCoverageFailures: 0,
    evidenceEvents: 4,
    recoveryEvents: 2,
  });
});

test("summarizeMissionE2eReportForValidationOps rejects unrelated artifacts", () => {
  assert.equal(summarizeMissionE2eReportForValidationOps({ kind: "other", scenarios: [] }), null);
  assert.equal(summarizeMissionE2eReportForValidationOps(null), null);
});

test("summarizeNaturalMissionE2eReportForValidationOps aggregates natural capability signals", () => {
  const summary = summarizeNaturalMissionE2eReportForValidationOps({
    kind: "turnkeyai.natural-mission-e2e.report",
    status: "failed",
    scenarios: [
      {
        scenario: "natural-browser-dynamic-page",
        natural: {
          status: "passed",
          completed: true,
          stuckOrLoop: false,
          reasonableToolUse: true,
          browserUsed: true,
          subAgentCompleted: true,
          approvalExercised: false,
          finalAnswerHasEvidence: true,
          finalAnswerUseful: true,
          weakAnswerSignals: [],
        },
        metrics: {
          tools: { requested: 2, results: 2, failed: 0, cancelled: 0, timeouts: 0 },
          sessions: { spawned: 1, continued: 0 },
          browser: { profileFallbacks: 0 },
          approvals: { requested: 0, decided: 0, applied: 0 },
          liveness: { active: 0, waiting: 0, stale: 0 },
          evidenceEvents: 2,
          recoveryEvents: 0,
        },
      },
      {
        scenario: "natural-long-delegation",
        natural: {
          status: "failed",
          completed: false,
          stuckOrLoop: true,
          reasonableToolUse: false,
          browserUsed: false,
          subAgentCompleted: false,
          approvalExercised: true,
          finalAnswerHasEvidence: false,
          finalAnswerUseful: false,
          weakAnswerSignals: ["tool unavailable fallback", "model-knowledge fallback"],
        },
        metrics: {
          tools: { requested: 3, results: 1, failed: 1, cancelled: 1, timeouts: 1 },
          sessions: { spawned: 2, continued: 1 },
          browser: { profileFallbacks: 2 },
          approvals: { requested: 1, decided: 1, applied: 1 },
          liveness: { active: 1, waiting: 1, stale: 0 },
          evidenceEvents: 0,
          recoveryEvents: 1,
        },
      },
    ],
  });

  assert.deepEqual(summary, {
    status: "failed",
    scenarioCount: 2,
    scenarioIds: ["natural-browser-dynamic-page", "natural-long-delegation"],
    passedScenarios: 1,
    failedScenarios: 1,
    completed: 1,
    stuckOrLoop: 1,
    reasonableToolUse: 1,
    browserUsed: 1,
    subAgentCompleted: 1,
    approvalExercised: 1,
    finalAnswerHasEvidence: 1,
    finalAnswerUseful: 1,
    weakAnswerSignals: 2,
    toolRequested: 5,
    toolResults: 3,
    toolFailed: 1,
    toolCancelled: 1,
    toolTimeouts: 1,
    sessionsSpawned: 3,
    sessionsContinued: 1,
    browserProfileFallbacks: 2,
    approvalsRequested: 1,
    approvalsDecided: 1,
    approvalsApplied: 1,
    livenessActive: 1,
    livenessWaiting: 1,
    livenessStale: 0,
    evidenceEvents: 2,
    recoveryEvents: 1,
  });
});

test("summarizeNaturalMissionE2eReportForValidationOps rejects unrelated artifacts", () => {
  assert.equal(summarizeNaturalMissionE2eReportForValidationOps({ kind: "other", scenarios: [] }), null);
  assert.equal(summarizeNaturalMissionE2eReportForValidationOps(null), null);
});
