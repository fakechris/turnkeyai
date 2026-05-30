import assert from "node:assert/strict";
import test from "node:test";

import { buildRealAcceptancePlan, parseRealAcceptanceArgs } from "./real-llm-acceptance";

test("real acceptance plan keeps full release gate by default", () => {
  const options = parseRealAcceptanceArgs([
    "--model-catalog",
    "models.local.json",
    "--data-dir",
    "/tmp/turnkeyai-acceptance-plan",
  ]);
  const plan = buildRealAcceptancePlan(options, {
    startedAt: Date.UTC(2026, 4, 31, 2, 50, 0),
    runId: "validation-ops:real-llm-acceptance:test",
  });

  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0]?.label, "tool-use real matrix");
  assert.equal(plan.steps[1]?.label, "mission real matrix");
  assert.deepEqual(plan.tooluseScenarios, ["basic", "approval", "followup", "timeout", "complex"]);
  assert.ok(plan.missionScenarios.includes("comparison"));
  assert.ok(plan.missionScenarios.includes("realistic-brief"));
  assert.equal(plan.browserTooluseEnabled, true);
  assert.match(plan.missionJsonPath ?? "", /real-llm-acceptance/);
});

test("real acceptance plan can run focused mission-only source coverage gate", () => {
  const options = parseRealAcceptanceArgs([
    "--skip-tooluse",
    "--mission-scenarios",
    "comparison, realistic-brief",
    "--scenario-timeout-ms",
    "300000",
    "--model-catalog",
    "models.local.json",
    "--data-dir",
    "/tmp/turnkeyai-acceptance-plan",
  ]);
  const plan = buildRealAcceptancePlan(options, {
    startedAt: Date.UTC(2026, 4, 31, 2, 51, 0),
    runId: "validation-ops:real-llm-acceptance:focused",
  });

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.label, "mission real matrix");
  assert.deepEqual(plan.tooluseScenarios, []);
  assert.deepEqual(plan.missionScenarios, ["comparison", "realistic-brief"]);
  assert.equal(plan.browserTooluseEnabled, false);
  assert.deepEqual(plan.steps[0]?.args, [
    "run",
    "mission:e2e",
    "--",
    "--matrix-scenarios",
    "comparison,realistic-brief",
    "--scenario-timeout-ms",
    "300000",
    "--model-catalog",
    "models.local.json",
    "--json",
    "/tmp/turnkeyai-acceptance-plan/validation-artifacts/real-llm-acceptance/validation-ops%3Areal-llm-acceptance%3Afocused-mission-e2e.json",
  ]);
});

test("real acceptance rejects tool-use scenarios when tool-use is skipped", () => {
  assert.throws(
    () => parseRealAcceptanceArgs(["--skip-tooluse", "--tooluse-scenarios", "basic"]),
    /--tooluse-scenarios cannot be combined with --skip-tooluse/
  );
});
