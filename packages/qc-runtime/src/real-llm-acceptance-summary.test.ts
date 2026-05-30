import assert from "node:assert/strict";
import test from "node:test";

import { summarizeMissionE2eReportForValidationOps } from "./real-llm-acceptance-summary";

test("summarizeMissionE2eReportForValidationOps aggregates scenario quality and liveness", () => {
  const summary = summarizeMissionE2eReportForValidationOps({
    kind: "turnkeyai.mission-e2e.report",
    status: "failed",
    scenarios: [
      {
        status: "done",
        qualityGate: "passed",
        metrics: {
          tools: { requested: 2, results: 2, failed: 0, cancelled: 0, timeouts: 0 },
          sessions: { spawned: 2, continued: 1 },
          approvals: { requested: 1, decided: 1, applied: 1 },
          liveness: { active: 0, waiting: 0, stale: 0 },
          evidenceEvents: 3,
          recoveryEvents: 0,
        },
        final: { qualityFailures: [] },
      },
      {
        status: "blocked",
        qualityGate: "blocked",
        metrics: {
          tools: { requested: 1, results: 1, failed: 1, cancelled: 0, timeouts: 1 },
          sessions: { spawned: 1, continued: 0 },
          approvals: { requested: 0, decided: 0, applied: 0 },
          liveness: { active: 0, waiting: 1, stale: 1 },
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
    approvalsRequested: 1,
    approvalsDecided: 1,
    approvalsApplied: 1,
    livenessActive: 0,
    livenessWaiting: 1,
    livenessStale: 1,
    evidenceEvents: 4,
    recoveryEvents: 2,
  });
});

test("summarizeMissionE2eReportForValidationOps rejects unrelated artifacts", () => {
  assert.equal(summarizeMissionE2eReportForValidationOps({ kind: "other", scenarios: [] }), null);
  assert.equal(summarizeMissionE2eReportForValidationOps(null), null);
});
