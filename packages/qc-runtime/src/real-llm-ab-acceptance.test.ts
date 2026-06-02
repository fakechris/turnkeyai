import assert from "node:assert/strict";
import test from "node:test";

import {
  detectControlledPromptLanguage,
  summarizeRealLlmAbAcceptanceReport,
  validateRealLlmAbAcceptanceReport,
  type RealLlmAbAcceptanceReport,
  type RealLlmAbDimensionScore,
  type RealLlmAbScenarioRun,
} from "./real-llm-ab-acceptance";

const FULL_SCORES: RealLlmAbScenarioRun["dimensionScores"] = {
  taskCompletion: 2,
  evidenceQuality: 2,
  toolUseAppropriateness: 2,
  browserAuthenticity: 2,
  subAgentIndependence: 2,
  continuationBehavior: 2,
  permissionCorrectness: 2,
  timeoutCloseoutQuality: 2,
  finalAnswerUsefulness: 2,
};

test("real LLM A/B acceptance validates comparable natural evidence", () => {
  const report = buildReport();

  const validation = validateRealLlmAbAcceptanceReport(report);

  assert.equal(validation.status, "passed");
  assert.deepEqual(validation.failures, []);
  assert.deepEqual(validation.summary, {
    status: "passed",
    capabilityClaim: "capability proven",
    stabilityClaim: "stable",
    scenarioCount: 1,
    comparableScenarios: 1,
    turnkeyaiWins: 0,
    turnkeyaiTies: 1,
    turnkeyaiLosses: 0,
    rootCauseRequiredScenarios: 0,
    rootCauseBuckets: [],
    controlledPromptViolations: 0,
    missingArtifactScenarios: 0,
    turnkeyaiStuckOrLoopScenarios: 0,
    turnkeyaiWeakAnswerScenarios: 0,
    comparisons: [
      {
        scenarioId: "browser-dynamic-page",
        comparable: true,
        turnkeyaiScore: 18,
        referenceScore: 18,
        scoreDelta: 0,
        turnkeyaiLossDimensions: [],
        turnkeyaiCoreLossCount: 0,
        rootCauseBuckets: [],
        turnkeyaiArtifactPath: "artifacts/evals/run/turnkeyai/browser.json",
        referenceArtifactPath: "artifacts/evals/run/reference/browser.json",
        turnkeyaiMissionId: "msn.local.1",
        rootCauseRequired: false,
      },
    ],
  });
});

test("real LLM A/B acceptance forces root-cause review when TurnkeyAI loses core dimensions", () => {
  const report = buildReport({
    status: "failed",
    capabilityClaim: "unproven",
    stabilityClaim: "unstable",
    turnkeyaiScores: {
      ...FULL_SCORES,
      toolUseAppropriateness: 0,
      subAgentIndependence: 0,
      finalAnswerUsefulness: 1,
    },
  });

  const validation = validateRealLlmAbAcceptanceReport(report);
  const comparison = validation.summary?.comparisons[0];

  assert.equal(validation.status, "failed");
  assert.match(validation.failures.join("\n"), /root-cause review required/);
  assert.equal(validation.summary?.turnkeyaiLosses, 1);
  assert.equal(validation.summary?.rootCauseRequiredScenarios, 1);
  assert.deepEqual(comparison?.turnkeyaiLossDimensions, [
    "toolUseAppropriateness",
    "subAgentIndependence",
    "finalAnswerUsefulness",
  ]);
  assert.deepEqual(comparison?.rootCauseBuckets, ["final_answer_quality", "prompt_harness", "sub_agent_runtime", "tool_selection"]);
});

test("real LLM A/B acceptance rejects controlled prompt gates and missing artifacts", () => {
  const report = buildReport({
    prompt:
      "Use this exact final answer shape and call the browser tool exactly once. Include TURNKEYAI_RELEASE_OK as the pass marker.",
    turnkeyaiArtifactPath: undefined,
    turnkeyaiMissionId: undefined,
  });

  const validation = validateRealLlmAbAcceptanceReport(report);

  assert.equal(validation.status, "failed");
  assert.equal(validation.summary?.controlledPromptViolations, 1);
  assert.equal(validation.summary?.missingArtifactScenarios, 1);
  assert.match(validation.failures.join("\n"), /controlled-gate language/);
  assert.match(validation.failures.join("\n"), /missing run artifact/);
  assert.deepEqual(detectControlledPromptLanguage(report.scenarios[0]!.prompt), [
    "exactly-once",
    "exact-final-shape",
    "forced-tool-call",
    "fixed-marker",
  ]);
});

test("real LLM A/B acceptance summary rejects unrelated artifacts", () => {
  assert.equal(summarizeRealLlmAbAcceptanceReport({ kind: "other", scenarios: [] }), null);
  assert.equal(validateRealLlmAbAcceptanceReport(null).status, "failed");
});

function buildReport(
  overrides: {
    status?: RealLlmAbAcceptanceReport["status"];
    capabilityClaim?: RealLlmAbAcceptanceReport["capabilityClaim"];
    stabilityClaim?: RealLlmAbAcceptanceReport["stabilityClaim"];
    prompt?: string;
    turnkeyaiScores?: Partial<Record<keyof typeof FULL_SCORES, RealLlmAbDimensionScore>>;
    referenceScores?: Partial<Record<keyof typeof FULL_SCORES, RealLlmAbDimensionScore>>;
    turnkeyaiArtifactPath?: string | undefined;
    turnkeyaiMissionId?: string | undefined;
  } = {}
): RealLlmAbAcceptanceReport {
  return {
    kind: "turnkeyai.real-llm-ab-acceptance.report",
    status: overrides.status ?? "passed",
    capabilityClaim: overrides.capabilityClaim ?? "capability proven",
    stabilityClaim: overrides.stabilityClaim ?? "stable",
    generatedAtMs: 1,
    scenarios: [
      {
        scenarioId: "browser-dynamic-page",
        prompt:
          overrides.prompt ??
          "请打开这个动态页面，理解当前状态，找出应该关注的异常和下一步动作，并给出依据。",
        promptPolicy: {
          naturalPrompt: true,
          noForcedToolCall: true,
          noFixedMarkerGate: true,
          noExactAnswerShape: true,
        },
        requiresBrowser: true,
        turnkeyai: buildRun({
          system: "turnkeyai",
          artifactPath:
            "turnkeyaiArtifactPath" in overrides
              ? overrides.turnkeyaiArtifactPath
              : "artifacts/evals/run/turnkeyai/browser.json",
          missionId: "turnkeyaiMissionId" in overrides ? overrides.turnkeyaiMissionId : "msn.local.1",
          dimensionScores: { ...FULL_SCORES, ...overrides.turnkeyaiScores },
        }),
        reference: buildRun({
          system: "reference",
          artifactPath: "artifacts/evals/run/reference/browser.json",
          dimensionScores: { ...FULL_SCORES, ...overrides.referenceScores },
        }),
      },
    ],
  };
}

function buildRun(input: {
  system: RealLlmAbScenarioRun["system"];
  artifactPath?: string | undefined;
  missionId?: string | undefined;
  dimensionScores: RealLlmAbScenarioRun["dimensionScores"];
}): RealLlmAbScenarioRun {
  return {
    system: input.system,
    ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {}),
    wallClockMs: 42_000,
    toolCallCount: 2,
    toolResultCount: 2,
    subAgentCount: 1,
    completedSubAgentCount: 1,
    browserEvidence: {
      required: true,
      used: true,
      rendered: true,
      urls: ["http://127.0.0.1:4100/app#/mission/msn.local.1"],
      screenshotCount: 1,
      snapshotCount: 1,
    },
    approval: { required: false },
    completed: true,
    stuckOrLoop: false,
    finalAnswerUseful: true,
    finalAnswerHasEvidence: true,
    residualRiskVisible: true,
    dimensionScores: input.dimensionScores,
  };
}
