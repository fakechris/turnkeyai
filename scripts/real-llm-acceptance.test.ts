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
  assert.match(help, /--tooluse-json <path>\s+Write the tool-use E2E report/);
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
  assert.match(plan.tooluseJsonPath ?? "", /tool-use-e2e/);
  assert.match(plan.missionJsonPath ?? "", /real-llm-acceptance/);
  assert.match(plan.naturalMissionJsonPath ?? "", /natural-mission-e2e/);
  assert.ok(plan.steps[0]?.args.includes("--json"));
  assert.equal(
    plan.steps[0]?.args.at(-1),
    "/tmp/turnkeyai-acceptance-plan/validation-artifacts/real-llm-acceptance/validation-ops%3Areal-llm-acceptance%3Atest-tool-use-e2e.json"
  );
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
  assert.equal(plan.tooluseJsonPath, null);
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
  assert.throws(
    () => parseRealAcceptanceArgs(["--no-tooluse-json"]),
    /--no-tooluse-json cannot be combined with validation-ops recording/
  );
  assert.equal(parseRealAcceptanceArgs(["--no-record-validation-ops", "--no-tooluse-json"]).writeTooluseJson, false);
  assert.equal(parseRealAcceptanceArgs(["--no-record-validation-ops", "--no-mission-json"]).writeMissionJson, false);
  assert.equal(
    parseRealAcceptanceArgs(["--skip-natural-mission", "--no-natural-mission-json"]).writeNaturalMissionJson,
    false
  );
});

test("real acceptance integrity requires passing tool-use report summaries when tool-use is enabled", () => {
  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        tooluseScenarios: ["basic"],
        missionScenarios: [],
        naturalMissionScenarios: [],
        tooluseJsonPresent: false,
        missionJsonPresent: false,
        naturalMissionJsonPresent: false,
        tooluseReport: null,
        missionReport: null,
        naturalMissionReport: null,
      }),
    /passed without a tool-use E2E report artifact/
  );

  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        tooluseScenarios: ["basic"],
        missionScenarios: [],
        naturalMissionScenarios: [],
        tooluseJsonPresent: true,
        missionJsonPresent: false,
        naturalMissionJsonPresent: false,
        tooluseReport: passingTooluseReport({ qualityFailures: 1 }),
        missionReport: null,
        naturalMissionReport: null,
      }),
    /tool-use E2E report does not prove/
  );

  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        tooluseScenarios: ["approval"],
        missionScenarios: [],
        naturalMissionScenarios: [],
        tooluseJsonPresent: true,
        missionJsonPresent: false,
        naturalMissionJsonPresent: false,
        tooluseReport: passingTooluseReport({
          scenarioIds: ["approval"],
          scenarioProofs: [
            {
              scenario: "approval",
              passed: true,
              finalBytes: 220,
              evidenceBullets: 3,
              qualityFailures: 0,
              toolCallNames: ["sessions_spawn"],
              sessionsSpawned: 1,
              childTranscriptMessages: 4,
              permissionEvents: 0,
            },
          ],
        }),
        missionReport: null,
        naturalMissionReport: null,
      }),
    /tool-use E2E report does not prove/
  );

  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        tooluseScenarios: ["basic", "basic"],
        missionScenarios: [],
        naturalMissionScenarios: [],
        tooluseJsonPresent: true,
        missionJsonPresent: false,
        naturalMissionJsonPresent: false,
        tooluseReport: passingTooluseReport({
          scenarioIds: ["basic", "basic"],
          scenarioProofs: [
            passingTooluseScenarioProof("basic"),
            { ...passingTooluseScenarioProof("basic"), passed: false },
          ],
        }),
        missionReport: null,
        naturalMissionReport: null,
      }),
    /tool-use E2E report does not prove/
  );

  assert.doesNotThrow(() =>
    assertRealAcceptanceArtifactIntegrity({
      status: "passed",
      tooluseScenarios: ["basic"],
      missionScenarios: [],
      naturalMissionScenarios: [],
      tooluseJsonPresent: true,
      missionJsonPresent: false,
      naturalMissionJsonPresent: false,
      tooluseReport: passingTooluseReport(),
      missionReport: null,
      naturalMissionReport: null,
    })
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
          scenarioIds: ["comparison"],
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

  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        missionScenarios: ["comparison"],
        naturalMissionScenarios: [],
        missionJsonPresent: true,
        naturalMissionJsonPresent: false,
        missionReport: passingMissionReport({ scenarioProofs: [] }),
        naturalMissionReport: null,
      }),
    /mission E2E report does not prove/
  );

  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        missionScenarios: ["comparison", "comparison"],
        naturalMissionScenarios: [],
        missionJsonPresent: true,
        naturalMissionJsonPresent: false,
        missionReport: passingMissionReport({
          scenarioCount: 2,
          scenarioIds: ["comparison", "comparison"],
          passedScenarios: 2,
          evidenceEvents: 2,
          scenarioProofs: [
            passingMissionScenarioProof("comparison"),
            { ...passingMissionScenarioProof("comparison"), passed: false },
          ],
        }),
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

  const missionReportWithoutScenarioIds = passingMissionReport({ scenarioIds: undefined });
  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        missionScenarios: ["comparison"],
        naturalMissionScenarios: [],
        missionJsonPresent: true,
        naturalMissionJsonPresent: false,
        missionReport: missionReportWithoutScenarioIds,
        naturalMissionReport: null,
      }),
    /mission E2E report does not cover all requested scenarios/
  );

  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        missionScenarios: ["comparison"],
        naturalMissionScenarios: [],
        missionJsonPresent: true,
        naturalMissionJsonPresent: false,
        missionReport: passingMissionReport({
          scenarioIds: ["realistic-brief"],
        }),
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

  const naturalReportWithoutScenarioIds = passingNaturalMissionReport({ scenarioIds: undefined });
  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        missionScenarios: ["comparison"],
        naturalMissionScenarios: ["natural-comparison-research"],
        missionJsonPresent: true,
        naturalMissionJsonPresent: true,
        missionReport: passingMissionReport(),
        naturalMissionReport: naturalReportWithoutScenarioIds,
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

  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        missionScenarios: ["comparison"],
        naturalMissionScenarios: ["natural-browser-dynamic-page"],
        missionJsonPresent: true,
        naturalMissionJsonPresent: true,
        missionReport: passingMissionReport(),
        naturalMissionReport: passingNaturalMissionReport({
          scenarioIds: ["natural-browser-dynamic-page"],
          browserUsed: 1,
          scenarioProofs: [
            {
              ...passingNaturalMissionScenarioProof("natural-browser-dynamic-page"),
              browserUsed: false,
            },
          ],
        }),
      }),
    /natural mission report does not prove/
  );

  assert.throws(
    () =>
      assertRealAcceptanceArtifactIntegrity({
        status: "passed",
        missionScenarios: ["comparison"],
        naturalMissionScenarios: ["natural-comparison-research", "natural-comparison-research"],
        missionJsonPresent: true,
        naturalMissionJsonPresent: true,
        missionReport: passingMissionReport(),
        naturalMissionReport: passingNaturalMissionReport({
          scenarioIds: ["natural-comparison-research", "natural-comparison-research"],
          scenarioProofs: [
            passingNaturalMissionScenarioProof("natural-comparison-research"),
            {
              ...passingNaturalMissionScenarioProof("natural-comparison-research"),
              passed: false,
            },
          ],
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
        scenarioIds: ["natural-browser-unavailable-closeout"],
        weakAnswerSignals: 1,
        scenarioProofs: [
          {
            ...passingNaturalMissionScenarioProof("natural-browser-unavailable-closeout"),
            weakAnswerSignals: 1,
          },
        ],
      }),
    })
  );

  assert.doesNotThrow(() =>
    assertRealAcceptanceArtifactIntegrity({
      status: "passed",
      missionScenarios: ["comparison"],
      naturalMissionScenarios: ["natural-browser-profile-lock-recovery"],
      missionJsonPresent: true,
      naturalMissionJsonPresent: true,
      missionReport: passingMissionReport(),
      naturalMissionReport: passingNaturalMissionReport({
        scenarioIds: ["natural-browser-profile-lock-recovery"],
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
        scenarioIds: ["comparison"],
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
        browserFailureBuckets: 0,
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
        scenarioProofs: [passingMissionScenarioProof("comparison")],
      },
      naturalMissionReport: {
        ...passingNaturalMissionReport(),
      },
    })
  );
});

function passingMissionReport(
  overrides: Partial<NonNullable<Parameters<typeof assertRealAcceptanceArtifactIntegrity>[0]["missionReport"]>> = {}
): NonNullable<Parameters<typeof assertRealAcceptanceArtifactIntegrity>[0]["missionReport"]> {
  const scenarioIds = overrides.scenarioIds ?? ["comparison"];
  const scenarioProofs = overrides.scenarioProofs ?? scenarioIds.map((scenario) => passingMissionScenarioProof(scenario));
  return {
    status: "passed",
    scenarioCount: scenarioIds.length,
    scenarioIds,
    passedScenarios: scenarioIds.length,
    failedScenarios: 0,
    qualityFailures: 0,
    toolRequested: scenarioIds.length,
    toolResults: scenarioIds.length,
    toolFailed: 0,
    toolCancelled: 0,
    toolTimeouts: 0,
    sessionsSpawned: scenarioIds.length,
    sessionsContinued: 0,
    browserProfileFallbacks: 0,
    browserFailureBuckets: 0,
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
    evidenceEvents: scenarioIds.length,
    recoveryEvents: 0,
    scenarioProofs,
    ...overrides,
  };
}

function passingMissionScenarioProof(
  scenario: string
): NonNullable<
  NonNullable<Parameters<typeof assertRealAcceptanceArtifactIntegrity>[0]["missionReport"]>["scenarioProofs"]
>[number] {
  return {
    scenario,
    passed: true,
    qualityFailures: 0,
    toolRequested: 1,
    toolResults: 1,
    toolFailed: 0,
    toolCancelled: 0,
    toolTimeouts: 0,
    sessionsSpawned: 1,
    sessionsContinued: 0,
    browserProfileFallbacks: 0,
    browserFailureBuckets: 0,
    approvalsRequested: 0,
    approvalsDecided: 0,
    approvalsApplied: 0,
    livenessActive: 0,
    livenessWaiting: 0,
    livenessStale: 0,
    qualityCheckFailures: 0,
    sourceCoverageFailures: 0,
    evidenceEvents: 1,
    recoveryEvents: 0,
  };
}

function passingTooluseReport(
  overrides: Partial<NonNullable<Parameters<typeof assertRealAcceptanceArtifactIntegrity>[0]["tooluseReport"]>> = {}
): NonNullable<Parameters<typeof assertRealAcceptanceArtifactIntegrity>[0]["tooluseReport"]> {
  const scenarioIds = overrides.scenarioIds ?? ["basic"];
  const scenarioProofs = overrides.scenarioProofs ?? scenarioIds.map((scenario) => passingTooluseScenarioProof(scenario));
  return {
    status: "passed",
    scenarioCount: scenarioIds.length,
    scenarioIds,
    passedScenarios: scenarioIds.length,
    failedScenarios: 0,
    qualityFailures: 0,
    finalBytes: scenarioIds.length * 220,
    evidenceBullets: scenarioIds.length * 3,
    toolCalls: scenarioIds.length,
    sessionsSpawned: scenarioIds.length,
    childTranscriptMessages: scenarioIds.length * 4,
    permissionEvents: 0,
    scenarioProofs,
    ...overrides,
  };
}

function passingTooluseScenarioProof(
  scenario: string
): NonNullable<
  NonNullable<Parameters<typeof assertRealAcceptanceArtifactIntegrity>[0]["tooluseReport"]>["scenarioProofs"]
>[number] {
  return {
    scenario,
    passed: true,
    finalBytes: 220,
    evidenceBullets: 3,
    qualityFailures: 0,
    toolCallNames: ["sessions_spawn"],
    sessionsSpawned: 1,
    childTranscriptMessages: 4,
    permissionEvents: 0,
  };
}

function passingNaturalMissionReport(
  overrides: Partial<NonNullable<Parameters<typeof assertRealAcceptanceArtifactIntegrity>[0]["naturalMissionReport"]>> = {}
): NonNullable<Parameters<typeof assertRealAcceptanceArtifactIntegrity>[0]["naturalMissionReport"]> {
  const scenarioIds = overrides.scenarioIds ?? ["natural-comparison-research"];
  const scenarioProofs = overrides.scenarioProofs ?? scenarioIds.map(passingNaturalMissionScenarioProof);
  return {
    status: "passed",
    scenarioCount: scenarioIds.length,
    scenarioIds,
    passedScenarios: scenarioIds.length,
    failedScenarios: 0,
    completed: scenarioIds.length,
    stuckOrLoop: 0,
    reasonableToolUse: scenarioIds.length,
    browserUsed: scenarioProofs.filter((proof) => proof.browserUsed).length,
    subAgentCompleted: scenarioIds.length,
    approvalExercised: scenarioProofs.filter((proof) => proof.approvalExercised).length,
    finalAnswerHasEvidence: scenarioIds.length,
    finalAnswerUseful: scenarioIds.length,
    weakAnswerSignals: 0,
    toolRequested: scenarioIds.length,
    toolResults: scenarioIds.length,
    toolFailed: scenarioProofs.reduce((sum, proof) => sum + proof.toolFailed, 0),
    toolCancelled: scenarioProofs.reduce((sum, proof) => sum + proof.toolCancelled, 0),
    toolTimeouts: scenarioProofs.reduce((sum, proof) => sum + proof.toolTimeouts, 0),
    sessionsSpawned: scenarioProofs.reduce((sum, proof) => sum + proof.sessionsSpawned, 0),
    sessionsContinued: scenarioProofs.reduce((sum, proof) => sum + proof.sessionsContinued, 0),
    browserProfileFallbacks: scenarioProofs.reduce((sum, proof) => sum + proof.browserProfileFallbacks, 0),
    browserFailureBuckets: scenarioProofs.reduce((sum, proof) => sum + proof.browserFailureBuckets, 0),
    approvalsRequested: scenarioProofs.reduce((sum, proof) => sum + proof.approvalsRequested, 0),
    approvalsDecided: scenarioProofs.reduce((sum, proof) => sum + proof.approvalsDecided, 0),
    approvalsApplied: scenarioProofs.reduce((sum, proof) => sum + proof.approvalsApplied, 0),
    livenessActive: 0,
    livenessWaiting: 0,
    livenessStale: 0,
    evidenceEvents: scenarioIds.length,
    sourceAnswerTermsCovered: scenarioIds.length,
    sourceAnswerTermsTotal: scenarioIds.length,
    sourceAnswerTermsMissing: 0,
    sourceAnswerPatternsCovered: scenarioIds.length,
    sourceAnswerPatternsTotal: scenarioIds.length,
    sourceAnswerPatternsMissing: 0,
    sourceEvidencePatternsCovered: scenarioIds.length,
    sourceEvidencePatternsTotal: scenarioIds.length,
    sourceEvidencePatternsMissing: 0,
    sourceEvidenceEventsObserved: scenarioIds.length,
    sourceEvidenceEventsRequired: scenarioIds.length,
    sourceResidualRiskVisible: scenarioIds.length,
    sourceUnsupportedClaims: 0,
    recoveryEvents: scenarioProofs.reduce((sum, proof) => sum + proof.recoveryEvents, 0),
    scenarioProofs,
    ...overrides,
  };
}

function passingNaturalMissionScenarioProof(
  scenario: string
): NonNullable<
  NonNullable<Parameters<typeof assertRealAcceptanceArtifactIntegrity>[0]["naturalMissionReport"]>["scenarioProofs"]
>[number] {
  const isBrowserFailureCloseout =
    scenario === "natural-browser-unavailable-closeout" ||
    scenario === "natural-browser-cdp-timeout-closeout" ||
    scenario === "natural-browser-detached-target-closeout" ||
    scenario === "natural-browser-attach-failed-closeout";
  const base = {
    scenario,
    passed: true,
    completed: true,
    stuckOrLoop: false,
    reasonableToolUse: true,
    browserUsed: scenario.startsWith("natural-browser-") && !isBrowserFailureCloseout,
    subAgentCompleted: true,
    approvalExercised: false,
    finalAnswerHasEvidence: true,
    finalAnswerUseful: true,
    weakAnswerSignals: 0,
    toolFailed: 0,
    toolCancelled: 0,
    toolTimeouts: 0,
    sessionsSpawned: scenario === "natural-long-delegation" ? 2 : 1,
    sessionsContinued: scenario.includes("followup") || scenario.includes("continuation") ? 1 : 0,
    browserProfileFallbacks: scenario === "natural-browser-profile-lock-recovery" ? 1 : 0,
    browserFailureBuckets: isBrowserFailureCloseout ? 1 : 0,
    approvalsRequested: 0,
    approvalsDecided: 0,
    approvalsApplied: 0,
    livenessActive: 0,
    livenessWaiting: 0,
    livenessStale: 0,
    evidenceEvents: 1,
    recoveryEvents: isBrowserFailureCloseout ? 1 : 0,
    sourceResidualRiskVisible: true,
    sourceUnsupportedClaims: 0,
    sourceAnswerTermsMissing: 0,
    sourceAnswerPatternsMissing: 0,
    sourceEvidencePatternsMissing: 0,
  };
  if (scenario === "natural-approval-dry-run-action") {
    return {
      ...base,
      approvalExercised: true,
      approvalsRequested: 1,
      approvalsDecided: 1,
      approvalsApplied: 1,
    };
  }
  if (scenario === "natural-approval-denied-safe-closeout" || scenario === "natural-approval-pending-state") {
    return {
      ...base,
      approvalExercised: true,
      approvalsRequested: 1,
      approvalsDecided: scenario === "natural-approval-denied-safe-closeout" ? 1 : 0,
    };
  }
  if (scenario.includes("timeout")) {
    return {
      ...base,
      toolFailed: 1,
      toolTimeouts: 1,
    };
  }
  if (scenario.includes("cancel")) {
    return {
      ...base,
      toolCancelled: 1,
    };
  }
  return base;
}
