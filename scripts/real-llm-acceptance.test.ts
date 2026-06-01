import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS } from "@turnkeyai/qc-runtime/real-llm-acceptance-defaults";

import {
  assertRealAcceptanceArtifactIntegrity,
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
  assert.deepEqual(plan.naturalMissionScenarios, [...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS]);
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

test("real acceptance requires artifacts for recorded validation-ops gates", () => {
  assert.throws(
    () => parseRealAcceptanceArgs(["--no-mission-json"]),
    /--no-mission-json cannot be combined with validation-ops recording/
  );
  assert.throws(
    () => parseRealAcceptanceArgs(["--no-natural-mission-json"]),
    /--no-natural-mission-json cannot be combined with validation-ops recording/
  );
  assert.equal(parseRealAcceptanceArgs(["--no-record-validation-ops", "--no-mission-json"]).writeMissionJson, false);
  assert.equal(
    parseRealAcceptanceArgs(["--skip-natural-mission", "--no-natural-mission-json"]).writeNaturalMissionJson,
    false
  );
});

test("real acceptance integrity rejects missing or non-passing report summaries before recording passed", () => {
  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        missionScenarios: ["comparison"],
        naturalMissionScenarios: [],
        missionJsonPresent: false,
        naturalMissionJsonPresent: false,
        missionReport: null,
        naturalMissionReport: null,
      }),
    /passed without a mission E2E report artifact/
  );

  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        missionScenarios: ["comparison"],
        naturalMissionScenarios: [],
        missionJsonPresent: true,
        naturalMissionJsonPresent: false,
        missionReport: {
          status: "passed",
          scenarioCount: 1,
          passedScenarios: 1,
          failedScenarios: 0,
          qualityFailures: 0,
          toolRequested: 1,
          toolResults: 1,
          toolFailed: 0,
          toolCancelled: 0,
          toolTimeouts: 0,
          sessionsSpawned: 1,
          sessionsContinued: 0,
          browserProfileFallbacks: 0,
          approvalsRequested: 0,
          approvalsDecided: 0,
          approvalsApplied: 0,
          livenessActive: 0,
          livenessWaiting: 1,
          livenessStale: 0,
          qualityCheckWarnings: 0,
          qualityCheckFailures: 0,
          sourceCoverageWarnings: 0,
          sourceCoverageFailures: 0,
          evidenceEvents: 1,
          recoveryEvents: 0,
        },
        naturalMissionReport: null,
      }),
    /mission E2E report does not prove/
  );
});

test("real acceptance integrity rejects incomplete artifacts and weak natural quality summaries", () => {
  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        missionScenarios: ["comparison", "realistic-brief"],
        naturalMissionScenarios: [],
        missionJsonPresent: true,
        naturalMissionJsonPresent: false,
        missionReport: passingMissionReport(),
        naturalMissionReport: null,
      }),
    /mission E2E report does not cover all requested scenarios/
  );

  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        missionScenarios: ["comparison"],
        naturalMissionScenarios: ["natural-comparison-research", "natural-long-delegation"],
        missionJsonPresent: true,
        naturalMissionJsonPresent: true,
        missionReport: passingMissionReport(),
        naturalMissionReport: passingNaturalMissionReport({ scenarioCount: 1 }),
      }),
    /natural mission report does not cover all requested scenarios/
  );

  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        missionScenarios: ["comparison"],
        naturalMissionScenarios: ["natural-comparison-research"],
        missionJsonPresent: true,
        naturalMissionJsonPresent: true,
        missionReport: passingMissionReport(),
        naturalMissionReport: passingNaturalMissionReport({
          finalAnswerUseful: 0,
          reasonableToolUse: 0,
          subAgentCompleted: 0,
        }),
      }),
    /natural mission report does not prove/
  );

  assert.doesNotThrow(() =>
    assertRealAcceptanceArtifactIntegrity({
      status: "passed",
      missionScenarios: ["comparison"],
      naturalMissionScenarios: ["natural-browser-unavailable-closeout"],
      missionJsonPresent: true,
      naturalMissionJsonPresent: true,
      missionReport: passingMissionReport(),
      naturalMissionReport: passingNaturalMissionReport({
        weakAnswerSignals: 1,
      }),
    })
  );
});

test("real acceptance integrity accepts passing mission and natural summaries", () => {
  assert.doesNotThrow(() =>
    assertRealAcceptanceArtifactIntegrity({
      status: "passed",
      missionScenarios: ["comparison"],
      naturalMissionScenarios: ["natural-comparison-research"],
      missionJsonPresent: true,
      naturalMissionJsonPresent: true,
      missionReport: {
        status: "passed",
        scenarioCount: 1,
        passedScenarios: 1,
        failedScenarios: 0,
        qualityFailures: 0,
        toolRequested: 1,
        toolResults: 1,
        toolFailed: 0,
        toolCancelled: 0,
        toolTimeouts: 0,
        sessionsSpawned: 1,
        sessionsContinued: 0,
        browserProfileFallbacks: 0,
        approvalsRequested: 0,
        approvalsDecided: 0,
        approvalsApplied: 0,
        livenessActive: 0,
        livenessWaiting: 0,
        livenessStale: 0,
        qualityCheckWarnings: 0,
        qualityCheckFailures: 0,
        sourceCoverageWarnings: 0,
        sourceCoverageFailures: 0,
        evidenceEvents: 1,
        recoveryEvents: 0,
      },
      naturalMissionReport: {
        status: "passed",
        scenarioCount: 1,
        passedScenarios: 1,
        failedScenarios: 0,
        completed: 1,
        stuckOrLoop: 0,
        reasonableToolUse: 1,
        browserUsed: 0,
        subAgentCompleted: 1,
        approvalExercised: 0,
        finalAnswerHasEvidence: 1,
        finalAnswerUseful: 1,
        weakAnswerSignals: 0,
        toolRequested: 1,
        toolResults: 1,
        toolFailed: 0,
        toolCancelled: 0,
        toolTimeouts: 0,
        sessionsSpawned: 1,
        sessionsContinued: 0,
        browserProfileFallbacks: 0,
        approvalsRequested: 0,
        approvalsDecided: 0,
        approvalsApplied: 0,
        livenessActive: 0,
        livenessWaiting: 0,
        livenessStale: 0,
        evidenceEvents: 1,
        recoveryEvents: 0,
      },
    })
  );
});

function passingMissionReport(
  overrides: Partial<NonNullable<Parameters<typeof assertRealAcceptanceArtifactIntegrity>[0]["missionReport"]>> = {}
): NonNullable<Parameters<typeof assertRealAcceptanceArtifactIntegrity>[0]["missionReport"]> {
  return {
    status: "passed",
    scenarioCount: 1,
    passedScenarios: 1,
    failedScenarios: 0,
    qualityFailures: 0,
    toolRequested: 1,
    toolResults: 1,
    toolFailed: 0,
    toolCancelled: 0,
    toolTimeouts: 0,
    sessionsSpawned: 1,
    sessionsContinued: 0,
    browserProfileFallbacks: 0,
    approvalsRequested: 0,
    approvalsDecided: 0,
    approvalsApplied: 0,
    livenessActive: 0,
    livenessWaiting: 0,
    livenessStale: 0,
    qualityCheckWarnings: 0,
    qualityCheckFailures: 0,
    sourceCoverageWarnings: 0,
    sourceCoverageFailures: 0,
    evidenceEvents: 1,
    recoveryEvents: 0,
    ...overrides,
  };
}

function passingNaturalMissionReport(
  overrides: Partial<NonNullable<Parameters<typeof assertRealAcceptanceArtifactIntegrity>[0]["naturalMissionReport"]>> = {}
): NonNullable<Parameters<typeof assertRealAcceptanceArtifactIntegrity>[0]["naturalMissionReport"]> {
  return {
    status: "passed",
    scenarioCount: 1,
    passedScenarios: 1,
    failedScenarios: 0,
    completed: 1,
    stuckOrLoop: 0,
    reasonableToolUse: 1,
    browserUsed: 0,
    subAgentCompleted: 1,
    approvalExercised: 0,
    finalAnswerHasEvidence: 1,
    finalAnswerUseful: 1,
    weakAnswerSignals: 0,
    toolRequested: 1,
    toolResults: 1,
    toolFailed: 0,
    toolCancelled: 0,
    toolTimeouts: 0,
    sessionsSpawned: 1,
    sessionsContinued: 0,
    browserProfileFallbacks: 0,
    approvalsRequested: 0,
    approvalsDecided: 0,
    approvalsApplied: 0,
    livenessActive: 0,
    livenessWaiting: 0,
    livenessStale: 0,
    evidenceEvents: 1,
    recoveryEvents: 0,
    ...overrides,
  };
}
