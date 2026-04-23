import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScenarioClosedLoopMetric,
  listRealWorldScenarios,
  runRealWorldSuite,
} from "./real-world-suite";

test("real-world suite lists built-in runbook scenarios", () => {
  const scenarios = listRealWorldScenarios();

  assert.equal(scenarios.length, 17);
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "browser-research-recovery-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "browser-research-transport-reconnect-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "transport-soak-validation-ops-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "parallel-governed-synthesis-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "continuation-pressure-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "context-high-pressure-real-task-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "operator-escalation-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "operator-escalation-compound-incident-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "governed-publish-approval-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "governed-publish-approval-reject-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "governed-publish-readback-verification"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "parallel-follow-up-merge-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "runtime-observability-reentry-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "long-continuation-under-pressure-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "browser-recovery-closed-loop-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "browser-recovery-operator-handoff-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "phase1-production-closure-runbook"));
});

test("real-world suite passes all built-in runbook scenarios", () => {
  const result = runRealWorldSuite();

  assert.equal(result.failedScenarios, 0);
  assert.equal(result.passedScenarios, result.totalScenarios);
  assert.equal(result.totalScenarios, 17);
  assert.equal(result.closedLoopStatus, "completed");
  assert.equal(result.closedLoopScenarios, result.totalScenarios);
  assert.equal(result.closedLoopRate, 1);
  assert.equal(result.closedLoop.totalCases, result.totalScenarios);
});

test("real-world suite can run one selected runbook scenario", () => {
  const result = runRealWorldSuite(["browser-research-recovery-runbook"]);

  assert.equal(result.totalScenarios, 1);
  assert.equal(result.scenarios[0]?.scenarioId, "browser-research-recovery-runbook");
  assert.equal(result.scenarios[0]?.status, "passed");
  assert.equal(result.scenarios[0]?.closedLoopStatus, "completed");
  assert.equal(result.scenarios[0]?.rerunCommand, "realworld-run browser-research-recovery-runbook");
});

test("real-world suite rejects unknown scenario ids", () => {
  assert.throws(() => runRealWorldSuite(["not-a-real-scenario"]), /unknown real-world scenario ids/);
});

test("real-world suite preserves caller-provided scenario order", () => {
  const result = runRealWorldSuite([
    "runtime-observability-reentry-runbook",
    "browser-research-recovery-runbook",
  ]);

  assert.deepEqual(
    result.scenarios.map((scenario) => scenario.scenarioId),
    ["runtime-observability-reentry-runbook", "browser-research-recovery-runbook"]
  );
});

test("real-world closed-loop metric distinguishes ambiguous and silent failures", () => {
  const scenario = {
    scenarioId: "synthetic-runbook",
    area: "browser" as const,
    title: "Synthetic runbook",
    summary: "Synthetic closed-loop classification fixture.",
    caseIds: ["case-1"],
  };
  const passingCase = {
    caseId: "case-1",
    area: "browser" as const,
    title: "Case",
    summary: "case",
    status: "passed" as const,
    details: ["case passed"],
  };
  const ambiguous = buildScenarioClosedLoopMetric({
    scenario,
    durationMs: 7,
    suite: {
      totalCases: 1,
      passedCases: 0,
      failedCases: 1,
      results: [passingCase],
    },
  });
  assert.equal(ambiguous.closedLoopStatus, "ambiguous_failure");
  assert.match(ambiguous.manualGateReason ?? "", /status and case results disagree/);

  const silent = buildScenarioClosedLoopMetric({
    scenario,
    durationMs: 7,
    suite: {
      totalCases: 1,
      passedCases: 0,
      failedCases: 1,
      results: [{ ...passingCase, status: "failed", details: [] }],
    },
  });
  assert.equal(silent.closedLoopStatus, "silent_failure");
  assert.match(silent.manualGateReason ?? "", /produced no failed-case details/);
});
