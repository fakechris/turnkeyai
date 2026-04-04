import assert from "node:assert/strict";
import test from "node:test";

import {
  listScenarioParityAcceptanceScenarios,
  runScenarioParityAcceptanceSuite,
} from "./scenario-parity-acceptance";

test("scenario parity acceptance suite lists scenario families", () => {
  const scenarios = listScenarioParityAcceptanceScenarios();
  assert.ok(scenarios.length >= 10);
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "dispatch-follow-up-existing-session"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "dispatch-scheduled-reentry-existing-session"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "parallel-three-shard-success"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "browser-spawn-send-resume"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "browser-ownership-reclaim-isolation"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "recovery-fallback-and-approval"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "context-evidence-heavy-and-reentry"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "governance-success-fallback-approval"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "operator-cross-surface-consistency"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "operator-triage-compound-incident"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "real-world-browser-research-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "real-world-governed-publish-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "real-world-parallel-follow-up-runbook"));
  assert.ok(scenarios.some((scenario) => scenario.scenarioId === "observability-live-chain-visibility"));
  assert.ok(
    scenarios
      .find((scenario) => scenario.scenarioId === "context-evidence-heavy-and-reentry")
      ?.caseIds.includes("context-runtime-pressure-keeps-carry-forward-and-waiting-visible")
  );
  assert.ok(
    scenarios
      .find((scenario) => scenario.scenarioId === "browser-spawn-send-resume")
      ?.caseIds.includes("browser-recovery-multi-attempt-chain-stays-aligned")
  );
  assert.ok(
    scenarios
      .find((scenario) => scenario.scenarioId === "browser-ownership-reclaim-isolation")
      ?.caseIds.includes("browser-ownership-reclaim-keeps-single-recovered-case")
  );
});

test("scenario parity acceptance suite passes all scenario families", () => {
  const result = runScenarioParityAcceptanceSuite();
  assert.equal(result.failedScenarios, 0);
  assert.equal(result.failedCases, 0);
  assert.equal(result.passedScenarios, result.totalScenarios);
  assert.equal(result.passedCases, result.totalCases);
});

test("scenario parity acceptance suite can run selected scenarios", () => {
  const result = runScenarioParityAcceptanceSuite([
    "dispatch-follow-up-existing-session",
    "observability-live-chain-visibility",
  ]);
  assert.equal(result.totalScenarios, 2);
  assert.equal(result.failedScenarios, 0);
  assert.deepEqual(
    result.scenarios.map((scenario) => scenario.scenarioId),
    ["dispatch-follow-up-existing-session", "observability-live-chain-visibility"]
  );
  assert.ok(result.scenarios.every((scenario) => scenario.status === "passed"));
});
