import assert from "node:assert/strict";
import test from "node:test";

import {
  listSoakScenarios,
  runSoakSuite,
} from "./soak-suite";

test("soak suite lists built-in long-chain stability scenarios", () => {
  const scenarios = listSoakScenarios();

  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "browser-recovery-long-chain"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "browser-reentry-and-session-continuity"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "recovery-causality-and-operator-closure"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "context-pressure-and-runtime-reentry"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "operator-compound-incident-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "governance-approval-fallback-closure"));
});

test("soak suite passes all built-in long-chain stability scenarios", () => {
  const result = runSoakSuite();

  assert.equal(result.failedScenarios, 0);
  assert.equal(result.passedScenarios, result.totalScenarios);
  assert.equal(result.totalScenarios, 6);
});

test("soak suite can run one selected long-chain scenario", () => {
  const result = runSoakSuite(["browser-recovery-long-chain"]);

  assert.equal(result.totalScenarios, 1);
  assert.equal(result.scenarios[0]?.scenarioId, "browser-recovery-long-chain");
  assert.equal(result.scenarios[0]?.status, "passed");
});
