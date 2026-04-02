import assert from "node:assert/strict";
import test from "node:test";

import {
  listValidationSuites,
  runValidationSuites,
} from "./validation-suite";

test("validation suite lists regression, soak, failure, acceptance, and real-world catalogs", () => {
  const suites = listValidationSuites();

  assert.deepEqual(
    suites.map((suite) => suite.suiteId),
    ["regression", "soak", "failure", "acceptance", "realworld"]
  );
  assert.ok(suites.find((suite) => suite.suiteId === "regression")?.items.some((item) => item.itemId === "browser-recovery-cold-reopen-outcome"));
  assert.ok(suites.find((suite) => suite.suiteId === "soak")?.items.some((item) => item.itemId === "browser-recovery-long-chain"));
  assert.ok(suites.find((suite) => suite.suiteId === "soak")?.items.some((item) => item.itemId === "governance-approval-fallback-closure"));
  assert.ok(suites.find((suite) => suite.suiteId === "failure")?.items.some((item) => item.itemId === "browser-detach-reopen-recovery"));
  assert.ok(suites.find((suite) => suite.suiteId === "acceptance")?.items.some((item) => item.itemId === "browser-spawn-send-resume"));
  assert.ok(suites.find((suite) => suite.suiteId === "acceptance")?.items.some((item) => item.itemId === "real-world-governed-publish-runbook"));
  assert.ok(suites.find((suite) => suite.suiteId === "realworld")?.items.some((item) => item.itemId === "browser-research-recovery-runbook"));
  assert.ok(suites.find((suite) => suite.suiteId === "realworld")?.items.some((item) => item.itemId === "governed-publish-approval-runbook"));
});

test("validation suite runs all validation catalogs", () => {
  const result = runValidationSuites();

  assert.equal(result.failedSuites, 0);
  assert.equal(result.totalSuites, 5);
  assert.equal(result.totalItems > 0, true);
  assert.equal(result.totalCases > 0, true);
  assert.deepEqual(
    result.suites.map((suite) => suite.suiteId),
    ["regression", "soak", "failure", "acceptance", "realworld"]
  );
});

test("validation suite can run one selected item from multiple suites", () => {
  const result = runValidationSuites([
    "regression:browser-recovery-cold-reopen-outcome",
    "soak:browser-recovery-long-chain",
    "failure:browser-detach-reopen-recovery",
    "acceptance:browser-spawn-send-resume",
    "realworld:browser-research-recovery-runbook",
  ]);

  assert.equal(result.totalSuites, 5);
  assert.equal(result.totalItems, 5);
  assert.deepEqual(
    result.suites.flatMap((suite) => suite.items.map((item) => `${suite.suiteId}:${item.itemId}`)),
    [
      "regression:browser-recovery-cold-reopen-outcome",
      "soak:browser-recovery-long-chain",
      "failure:browser-detach-reopen-recovery",
      "acceptance:browser-spawn-send-resume",
      "realworld:browser-research-recovery-runbook",
    ]
  );
});

test("validation suite can run an entire selected suite", () => {
  const result = runValidationSuites(["failure"]);

  assert.equal(result.totalSuites, 1);
  assert.equal(result.suites[0]?.suiteId, "failure");
  assert.equal((result.suites[0]?.totalItems ?? 0) > 0, true);
  assert.equal(result.suites[0]?.totalItems, result.suites[0]?.items.length);
});

test("validation suite rejects unknown suite selectors", () => {
  assert.throws(() => runValidationSuites(["unknown:item"]), /unknown validation suite/);
});

test("validation suite rejects unknown item selectors inside a known suite", () => {
  assert.throws(
    () => runValidationSuites(["soak:not-a-real-scenario"]),
    /unknown soak validation items/
  );
});
