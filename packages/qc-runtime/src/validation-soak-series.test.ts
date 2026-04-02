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
  assert.ok(result.suiteAggregates.some((suite) => suite.suiteId === "soak"));
  assert.ok(result.suiteAggregates.some((suite) => suite.suiteId === "realworld"));
});

