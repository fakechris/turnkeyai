import assert from "node:assert/strict";
import test from "node:test";

import {
  summarizeMissionE2eReportForValidationOps,
  summarizeNaturalMissionE2eReportForValidationOps,
  summarizeToolUseE2eReportForValidationOps,
} from "./real-llm-acceptance-summary";

test("summarizeToolUseE2eReportForValidationOps aggregates real tool-use matrix proof", () => {
  const summary = summarizeToolUseE2eReportForValidationOps({
    kind: "turnkeyai.tool-use-e2e.report",
    status: "passed",
    scenarios: [
      {
        status: "passed",
        scenario: "basic",
        finalBytes: 240,
        evidenceBullets: 3,
        qualityFailures: 0,
        toolCallNames: ["sessions_spawn"],
        spawnedSessionCount: 1,
        childTranscriptMessages: 4,
      },
      {
        status: "passed",
        scenario: "approval",
        finalBytes: 320,
        evidenceBullets: 4,
        qualityFailures: 0,
        toolCallNames: ["permission_query", "permission_result", "permission_applied", "sessions_spawn"],
        spawnedSessionCount: 1,
        childTranscriptMessages: 4,
        permissionEvents: ["query:browser.form.submit", "result:allow", "applied:browser.form.submit"],
      },
    ],
  });

  assert.deepEqual(summary, {
    status: "passed",
    scenarioCount: 2,
    scenarioIds: ["basic", "approval"],
    passedScenarios: 2,
    failedScenarios: 0,
    qualityFailures: 0,
    finalBytes: 560,
    evidenceBullets: 7,
    toolCalls: 5,
    sessionsSpawned: 2,
    childTranscriptMessages: 8,
    permissionEvents: 3,
    scenarioProofs: [
      {
        scenario: "basic",
        passed: true,
        finalBytes: 240,
        evidenceBullets: 3,
        qualityFailures: 0,
        toolCallNames: ["sessions_spawn"],
        sessionsSpawned: 1,
        childTranscriptMessages: 4,
        permissionEvents: 0,
      },
      {
        scenario: "approval",
        passed: true,
        finalBytes: 320,
        evidenceBullets: 4,
        qualityFailures: 0,
        toolCallNames: ["permission_query", "permission_result", "permission_applied", "sessions_spawn"],
        sessionsSpawned: 1,
        childTranscriptMessages: 4,
        permissionEvents: 3,
      },
    ],
  });
});

test("summarizeToolUseE2eReportForValidationOps rejects unrelated artifacts", () => {
  assert.equal(summarizeToolUseE2eReportForValidationOps({ kind: "other", scenarios: [] }), null);
  assert.equal(summarizeToolUseE2eReportForValidationOps(null), null);
});

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
          browser: { profileFallbacks: 1, failureBuckets: [{ bucket: "browser_cdp_unavailable", count: 2 }] },
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
    browserFailureBuckets: 2,
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

test("summarizeMissionE2eReportForValidationOps treats expected timeout attention as passing evidence", () => {
  const summary = summarizeMissionE2eReportForValidationOps({
    kind: "turnkeyai.mission-e2e.report",
    status: "passed",
    scenarios: [
      {
        scenario: "timeout-recovery",
        status: "done",
        qualityGate: "blocked",
        metrics: {
          tools: { requested: 1, results: 1, failed: 1, cancelled: 0, timeouts: 1 },
          sessions: { spawned: 1, continued: 0 },
          browser: { profileFallbacks: 0 },
          approvals: { requested: 0, decided: 0, applied: 0 },
          liveness: { active: 0, waiting: 0, stale: 0 },
          qualityChecks: [
            { name: "failure_free", status: "fail" },
            { name: "tool_loop_closeout", status: "warn" },
          ],
          evidenceEvents: 1,
          recoveryEvents: 0,
        },
        final: {
          qualityFailures: [],
          closeout: { reason: "sub_agent_timeout" },
        },
      },
    ],
  });

  assert.equal(summary?.passedScenarios, 1);
  assert.equal(summary?.failedScenarios, 0);
  assert.equal(summary?.qualityCheckFailures, 0);
  assert.equal(summary?.toolFailed, 1);
  assert.equal(summary?.toolTimeouts, 1);
});

test("summarizeMissionE2eReportForValidationOps rejects unexpected forced closeout on cancel", () => {
  const summary = summarizeMissionE2eReportForValidationOps({
    kind: "turnkeyai.mission-e2e.report",
    status: "failed",
    scenarios: [
      {
        scenario: "cancel",
        status: "done",
        qualityGate: "blocked",
        metrics: {
          tools: { requested: 1, results: 1, failed: 1, cancelled: 1, timeouts: 0 },
          sessions: { spawned: 1, continued: 0 },
          browser: { profileFallbacks: 0 },
          approvals: { requested: 0, decided: 0, applied: 0 },
          liveness: { active: 0, waiting: 0, stale: 0 },
          qualityChecks: [{ name: "failure_free", status: "fail" }],
          evidenceEvents: 1,
          recoveryEvents: 0,
        },
        final: {
          qualityFailures: [],
          closeout: { reason: "sub_agent_timeout" },
        },
      },
    ],
  });

  assert.equal(summary?.passedScenarios, 0);
  assert.equal(summary?.failedScenarios, 1);
  assert.equal(summary?.qualityCheckFailures, 0);
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
          sourceCoverage: {
            answerTerms: { covered: 2, total: 2, missing: [] },
            answerPatterns: { covered: 1, total: 1, missing: [] },
            evidencePatterns: { covered: 3, total: 3, missing: [] },
            evidenceEvents: { observed: 2, required: 1 },
            residualRiskVisible: true,
            unsupportedClaims: [],
          },
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
          sourceCoverage: {
            answerTerms: { covered: 1, total: 3, missing: ["owner", "residual risk"] },
            answerPatterns: { covered: 0, total: 1, missing: ["recommendation"] },
            evidencePatterns: { covered: 1, total: 4, missing: ["source A", "source B", "source C"] },
            evidenceEvents: { observed: 0, required: 1 },
            residualRiskVisible: false,
            unsupportedClaims: ["unsupported pricing"],
          },
          weakAnswerSignals: ["tool unavailable fallback", "model-knowledge fallback"],
        },
        metrics: {
          tools: { requested: 3, results: 1, failed: 1, cancelled: 1, timeouts: 1 },
          sessions: { spawned: 2, continued: 1 },
          browser: { profileFallbacks: 2, failureBuckets: [{ bucket: "browser_cdp_unavailable", count: 3 }] },
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
    browserFailureBuckets: 3,
    approvalsRequested: 1,
    approvalsDecided: 1,
    approvalsApplied: 1,
    livenessActive: 1,
    livenessWaiting: 1,
    livenessStale: 0,
    evidenceEvents: 2,
    sourceAnswerTermsCovered: 3,
    sourceAnswerTermsTotal: 5,
    sourceAnswerTermsMissing: 2,
    sourceAnswerPatternsCovered: 1,
    sourceAnswerPatternsTotal: 2,
    sourceAnswerPatternsMissing: 1,
    sourceEvidencePatternsCovered: 4,
    sourceEvidencePatternsTotal: 7,
    sourceEvidencePatternsMissing: 3,
    sourceEvidenceEventsObserved: 2,
    sourceEvidenceEventsRequired: 2,
    sourceResidualRiskVisible: 1,
    sourceUnsupportedClaims: 1,
    recoveryEvents: 1,
    scenarioProofs: [
      {
        scenario: "natural-browser-dynamic-page",
        passed: true,
        completed: true,
        stuckOrLoop: false,
        reasonableToolUse: true,
        browserUsed: true,
        subAgentCompleted: true,
        approvalExercised: false,
        finalAnswerHasEvidence: true,
        finalAnswerUseful: true,
        weakAnswerSignals: 0,
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
        evidenceEvents: 2,
        recoveryEvents: 0,
        sourceResidualRiskVisible: true,
        sourceUnsupportedClaims: 0,
        sourceAnswerTermsMissing: 0,
        sourceAnswerPatternsMissing: 0,
        sourceEvidencePatternsMissing: 0,
      },
      {
        scenario: "natural-long-delegation",
        passed: false,
        completed: false,
        stuckOrLoop: true,
        reasonableToolUse: false,
        browserUsed: false,
        subAgentCompleted: false,
        approvalExercised: true,
        finalAnswerHasEvidence: false,
        finalAnswerUseful: false,
        weakAnswerSignals: 2,
        toolFailed: 1,
        toolCancelled: 1,
        toolTimeouts: 1,
        sessionsSpawned: 2,
        sessionsContinued: 1,
        browserProfileFallbacks: 2,
        browserFailureBuckets: 3,
        approvalsRequested: 1,
        approvalsDecided: 1,
        approvalsApplied: 1,
        livenessActive: 1,
        livenessWaiting: 1,
        livenessStale: 0,
        evidenceEvents: 0,
        recoveryEvents: 1,
        sourceResidualRiskVisible: false,
        sourceUnsupportedClaims: 1,
        sourceAnswerTermsMissing: 2,
        sourceAnswerPatternsMissing: 1,
        sourceEvidencePatternsMissing: 3,
      },
    ],
  });
});

test("summarizeNaturalMissionE2eReportForValidationOps rejects unrelated artifacts", () => {
  assert.equal(summarizeNaturalMissionE2eReportForValidationOps({ kind: "other", scenarios: [] }), null);
  assert.equal(summarizeNaturalMissionE2eReportForValidationOps(null), null);
});
