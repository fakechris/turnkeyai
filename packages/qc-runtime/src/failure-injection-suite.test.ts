import assert from "node:assert/strict";
import test from "node:test";

import {
  listFailureInjectionScenarios,
  runFailureInjectionSuite,
} from "./failure-injection-suite";

test("failure injection suite lists built-in scenarios", () => {
  const scenarios = listFailureInjectionScenarios();
  assert.ok(scenarios.length >= 6);
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "browser-detach-reopen-recovery"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "recovery-retry-fallback-approval"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "parallel-shard-failure-and-recovery"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "governance-denial-fallback-and-approval"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "runtime-stale-waiting-and-manual-attention"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "context-budget-pressure-and-reentry"));
});

test("failure injection suite passes all built-in scenarios", () => {
  const result = runFailureInjectionSuite();
  assert.equal(result.failedScenarios, 0);
  assert.equal(result.failedCases, 0);
  assert.equal(result.passedScenarios, result.totalScenarios);
  assert.equal(result.passedCases, result.totalCases);
});

test("failure injection suite can run selected scenarios", () => {
  const result = runFailureInjectionSuite([
    "browser-detach-reopen-recovery",
    "runtime-stale-waiting-and-manual-attention",
  ]);
  assert.equal(result.totalScenarios, 2);
  assert.equal(result.failedScenarios, 0);
  assert.deepEqual(
    result.scenarios.map((scenario) => scenario.scenarioId),
    ["browser-detach-reopen-recovery", "runtime-stale-waiting-and-manual-attention"]
  );
  assert.ok(result.scenarios.every((scenario) => scenario.status === "passed"));
});
