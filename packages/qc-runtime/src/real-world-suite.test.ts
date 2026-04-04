import assert from "node:assert/strict";
import test from "node:test";

import {
  listRealWorldScenarios,
  runRealWorldSuite,
} from "./real-world-suite";

test("real-world suite lists built-in runbook scenarios", () => {
  const scenarios = listRealWorldScenarios();

  assert.equal(scenarios.length, 12);
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "browser-research-recovery-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "browser-research-transport-reconnect-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "parallel-governed-synthesis-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "continuation-pressure-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "operator-escalation-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "operator-escalation-compound-incident-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "governed-publish-approval-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "governed-publish-approval-reject-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "governed-publish-readback-verification"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "parallel-follow-up-merge-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "runtime-observability-reentry-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "long-continuation-under-pressure-runbook"));
});

test("real-world suite passes all built-in runbook scenarios", () => {
  const result = runRealWorldSuite();

  assert.equal(result.failedScenarios, 0);
  assert.equal(result.passedScenarios, result.totalScenarios);
  assert.equal(result.totalScenarios, 12);
});

test("real-world suite can run one selected runbook scenario", () => {
  const result = runRealWorldSuite(["browser-research-recovery-runbook"]);

  assert.equal(result.totalScenarios, 1);
  assert.equal(result.scenarios[0]?.scenarioId, "browser-research-recovery-runbook");
  assert.equal(result.scenarios[0]?.status, "passed");
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
