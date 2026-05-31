import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRealAcceptanceHelpResult,
  buildRealAcceptanceHelpText,
  buildRealAcceptancePlan,
  parseRealAcceptanceArgs,
} from "./real-llm-acceptance";

test("real acceptance help documents full and focused gates", () => {
  const help = buildRealAcceptanceHelpText();

  assert.match(help, /TurnkeyAI real LLM acceptance gate/);
  assert.match(help, /--skip-tooluse\s+Omit the standalone tool-use matrix/);
  assert.match(help, /--skip-browser-tooluse\s+Keep tool-use matrix/);
  assert.match(help, /--skip-natural-mission\s+Omit natural mission E2E scenarios/);
  assert.match(help, /Focused mission-quality gate:/);
  assert.match(help, /--mission-scenarios comparison,realistic-brief/);
  assert.match(help, /Full release gate:/);
  assert.match(help, /--cdp-timeout-ms 45000/);
});

test("real acceptance CLI treats help as an early exit", () => {
  assert.deepEqual(buildRealAcceptanceHelpResult(["--help"]), {
    shouldExit: true,
    text: buildRealAcceptanceHelpText(),
  });
  assert.equal(buildRealAcceptanceHelpResult(["--skip-tooluse"]).shouldExit, false);
});

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

  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[0]?.label, "tool-use real matrix");
  assert.equal(plan.steps[1]?.label, "mission real matrix");
  assert.equal(plan.steps[2]?.label, "natural mission real matrix");
  assert.deepEqual(plan.tooluseScenarios, ["basic", "approval", "followup", "timeout", "complex"]);
  assert.ok(plan.missionScenarios.includes("comparison"));
  assert.ok(plan.missionScenarios.includes("realistic-brief"));
  assert.ok(plan.naturalMissionScenarios.includes("natural-comparison-research"));
  assert.ok(plan.naturalMissionScenarios.includes("natural-long-delegation"));
  assert.equal(plan.browserTooluseEnabled, true);
  assert.match(plan.missionJsonPath ?? "", /real-llm-acceptance/);
  assert.match(plan.naturalMissionJsonPath ?? "", /natural-mission-e2e/);
});

test("real acceptance plan can run focused mission-only source coverage gate", () => {
  const options = parseRealAcceptanceArgs([
    "--skip-tooluse",
    "--skip-natural-mission",
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
  assert.deepEqual(plan.naturalMissionScenarios, []);
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

test("real acceptance plan can run focused natural mission gate", () => {
  const options = parseRealAcceptanceArgs([
    "--skip-tooluse",
    "--mission-scenarios",
    "comparison",
    "--natural-mission-scenarios",
    "natural-comparison-research,natural-browser-dynamic-page",
    "--scenario-timeout-ms",
    "300000",
    "--model-catalog",
    "models.local.json",
    "--data-dir",
    "/tmp/turnkeyai-acceptance-plan",
  ]);
  const plan = buildRealAcceptancePlan(options, {
    startedAt: Date.UTC(2026, 4, 31, 2, 52, 0),
    runId: "validation-ops:real-llm-acceptance:natural",
  });

  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0]?.label, "mission real matrix");
  assert.equal(plan.steps[1]?.label, "natural mission real matrix");
  assert.deepEqual(plan.naturalMissionScenarios, ["natural-comparison-research", "natural-browser-dynamic-page"]);
  assert.deepEqual(plan.steps[1]?.args, [
    "run",
    "mission:e2e:natural",
    "--",
    "--natural-matrix-scenarios",
    "natural-comparison-research,natural-browser-dynamic-page",
    "--scenario-timeout-ms",
    "300000",
    "--model-catalog",
    "models.local.json",
    "--json",
    "/tmp/turnkeyai-acceptance-plan/validation-artifacts/real-llm-acceptance/validation-ops%3Areal-llm-acceptance%3Anatural-natural-mission-e2e.json",
  ]);
});

test("real acceptance rejects tool-use scenarios when tool-use is skipped", () => {
  assert.throws(
    () => parseRealAcceptanceArgs(["--skip-tooluse", "--tooluse-scenarios", "basic"]),
    /--tooluse-scenarios cannot be combined with --skip-tooluse/
  );
  assert.throws(
    () => parseRealAcceptanceArgs(["--skip-natural-mission", "--natural-mission-scenarios", "natural-comparison-research"]),
    /--natural-mission-scenarios cannot be combined with --skip-natural-mission/
  );
});
