import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VALIDATION_SOAK_SELECTORS,
  runValidationSoakSeries,
} from "./validation-soak-series";

test("validation soak series uses stable default selectors", () => {
  assert.deepEqual(DEFAULT_VALIDATION_SOAK_SELECTORS, ["soak", "realworld", "acceptance"]);
});

test("validation soak series runs multiple cycles with selected suites", () => {
  const result = runValidationSoakSeries({
    cycles: 2,
    selectors: ["soak:browser-recovery-long-chain", "realworld:browser-research-recovery-runbook"],
  });

  assert.equal(result.status, "passed");
  assert.equal(result.totalCycles, 2);
  assert.equal(result.failedCycles, 0);
  assert.deepEqual(result.selectors, ["soak:browser-recovery-long-chain", "realworld:browser-research-recovery-runbook"]);
  assert.ok(result.cycles.every((cycle) => cycle.status === "passed"));
  assert.equal(result.closedLoop?.closedLoopStatus, "completed");
  assert.equal(result.closedLoop?.totalCases, 2);
  assert.ok(result.suiteAggregates.some((suite) => suite.suiteId === "soak"));
  assert.ok(result.suiteAggregates.some((suite) => suite.suiteId === "realworld" && suite.closedLoop?.closedLoopRate === 1));
});

test("validation soak series falls back to defaults when selectors only contain whitespace", () => {
  const result = runValidationSoakSeries({
    cycles: 1,
    selectors: ["  ", "\n"],
  });

  assert.deepEqual(result.selectors, ["soak", "realworld", "acceptance"]);
});
