import assert from "node:assert/strict";
import test from "node:test";

import {
  detectControlledPromptLanguage,
  REAL_LLM_AB_CORE_SUITE_REQUIREMENTS,
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

test("real LLM A/B acceptance keeps focused reports separate from core-suite evidence", () => {
  const focusedReport = buildReport();

  assert.equal(validateRealLlmAbAcceptanceReport(focusedReport).status, "passed");

  const coreValidation = validateRealLlmAbAcceptanceReport(focusedReport, { requiredSuite: "core" });

  assert.equal(coreValidation.status, "failed");
  assert.match(coreValidation.failures.join("\n"), /core suite missing required scenario: comparison-research/);
  assert.match(coreValidation.failures.join("\n"), /core suite missing required scenario: long-delegation/);
});

test("real LLM A/B acceptance validates the full core suite when requested", () => {
  const report = buildCoreSuiteReport();

  const validation = validateRealLlmAbAcceptanceReport(report, { requiredSuite: "core" });

  assert.equal(validation.status, "passed");
  assert.equal(validation.summary?.scenarioCount, REAL_LLM_AB_CORE_SUITE_REQUIREMENTS.length);
});

test("real LLM A/B acceptance requires concrete TurnkeyAI browser proof", () => {
  const report = buildReport({
    turnkeyaiBrowserEvidence: {
      required: true,
      used: true,
      rendered: false,
      screenshotCount: 0,
      snapshotCount: 0,
    },
  });

  const validation = validateRealLlmAbAcceptanceReport(report);

  assert.equal(validation.status, "failed");
  assert.match(validation.failures.join("\n"), /did not record rendered browser evidence/);
  assert.match(validation.failures.join("\n"), /has no browser artifact evidence/);
});

test("real LLM A/B acceptance requires concrete continuation, timeout, delegation, memory, and approval proof", () => {
  const report = buildCoreSuiteReport({
    weaken: {
      "followup-continuation": (run) => ({
        ...run,
        continuation: { required: true, sessionsContinued: 0, usedSessionsSend: false, reusedPriorContext: false },
        toolSequence: [],
      }),
      "timeout-closeout": (run) => ({
        ...run,
        timeout: { required: true, timedOut: false, partialCloseout: false, hardAborted: false },
      }),
      "long-delegation": (run) => ({
        ...run,
        subAgentCount: 1,
        completedSubAgentCount: 1,
      }),
      "memory-recall": (run) => ({
        ...run,
        toolSequence: ["memory_search"],
      }),
      "approval-dry-run-action": (run) => ({
        ...run,
        approval: { required: true, requested: true, decided: true, applied: true, sideEffectPreventedBeforeApproval: false },
      }),
    },
  });

  const validation = validateRealLlmAbAcceptanceReport(report, { requiredSuite: "core" });

  assert.equal(validation.status, "failed");
  assert.match(validation.failures.join("\n"), /followup-continuation: TurnkeyAI did not record continuation reuse evidence/);
  assert.match(validation.failures.join("\n"), /timeout-closeout: TurnkeyAI did not record timeout partial-closeout evidence/);
  assert.match(validation.failures.join("\n"), /long-delegation: TurnkeyAI did not record independent long-delegation/);
  assert.match(validation.failures.join("\n"), /memory-recall: TurnkeyAI did not record memory_search and memory_get evidence/);
  assert.match(validation.failures.join("\n"), /approval-dry-run-action: TurnkeyAI did not record approval pre-side-effect safety evidence/);
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

test("real LLM A/B acceptance requires each run to prove the same natural prompt", () => {
  const missingPromptReport = buildReport({
    weakenRun: {
      reference: (run) => {
        const { prompt: _prompt, ...withoutPrompt } = run;
        return withoutPrompt;
      },
    },
  });
  const missingPromptValidation = validateRealLlmAbAcceptanceReport(missingPromptReport);
  assert.equal(missingPromptValidation.status, "failed");
  assert.match(missingPromptValidation.failures.join("\n"), /browser-dynamic-page\/reference: missing run prompt evidence/);

  const mismatchedPromptReport = buildReport({
    weakenRun: {
      turnkeyai: (run) => ({ ...run, prompt: "请完成一个不同的任务。" }),
    },
  });
  const mismatchedPromptValidation = validateRealLlmAbAcceptanceReport(mismatchedPromptReport);
  assert.equal(mismatchedPromptValidation.status, "failed");
  assert.match(mismatchedPromptValidation.failures.join("\n"), /browser-dynamic-page\/turnkeyai: run prompt does not match/);
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
    turnkeyaiBrowserEvidence?: RealLlmAbScenarioRun["browserEvidence"];
    weakenRun?: {
      turnkeyai?: (run: RealLlmAbScenarioRun) => RealLlmAbScenarioRun;
      reference?: (run: RealLlmAbScenarioRun) => RealLlmAbScenarioRun;
    };
  } = {}
): RealLlmAbAcceptanceReport {
  const prompt =
    overrides.prompt ?? "请打开这个动态页面，理解当前状态，找出应该关注的异常和下一步动作，并给出依据。";
  const turnkeyaiRun = buildRun({
    system: "turnkeyai",
    artifactPath:
      "turnkeyaiArtifactPath" in overrides ? overrides.turnkeyaiArtifactPath : "artifacts/evals/run/turnkeyai/browser.json",
    missionId: "turnkeyaiMissionId" in overrides ? overrides.turnkeyaiMissionId : "msn.local.1",
    dimensionScores: { ...FULL_SCORES, ...overrides.turnkeyaiScores },
    browserEvidence: overrides.turnkeyaiBrowserEvidence,
    prompt,
  });
  const referenceRun = buildRun({
    system: "reference",
    artifactPath: "artifacts/evals/run/reference/browser.json",
    dimensionScores: { ...FULL_SCORES, ...overrides.referenceScores },
    prompt,
  });
  return {
    kind: "turnkeyai.real-llm-ab-acceptance.report",
    status: overrides.status ?? "passed",
    capabilityClaim: overrides.capabilityClaim ?? "capability proven",
    stabilityClaim: overrides.stabilityClaim ?? "stable",
    generatedAtMs: 1,
    scenarios: [
      {
        scenarioId: "browser-dynamic-page",
        prompt,
        promptPolicy: {
          naturalPrompt: true,
          noForcedToolCall: true,
          noFixedMarkerGate: true,
          noExactAnswerShape: true,
        },
        requiresBrowser: true,
        turnkeyai: overrides.weakenRun?.turnkeyai?.(turnkeyaiRun) ?? turnkeyaiRun,
        reference: overrides.weakenRun?.reference?.(referenceRun) ?? referenceRun,
      },
    ],
  };
}

function buildCoreSuiteReport(input: {
  weaken?: Partial<Record<string, (run: RealLlmAbScenarioRun) => RealLlmAbScenarioRun>>;
} = {}): RealLlmAbAcceptanceReport {
  return {
    kind: "turnkeyai.real-llm-ab-acceptance.report",
    status: "passed",
    capabilityClaim: "capability proven",
    stabilityClaim: "stable",
    generatedAtMs: 1,
    scenarios: REAL_LLM_AB_CORE_SUITE_REQUIREMENTS.map((requirement) => {
      const scenarioId = requirement.acceptedScenarioIds[0]!;
      const prompt = `请完成 ${scenarioId} 场景，给出结论、证据和风险。`;
      const requiresBrowser = scenarioId === "browser-dynamic-page";
      const requiresApproval = scenarioId === "approval-dry-run-action";
      const requiresContinuation = scenarioId === "followup-continuation";
      const requiresTimeoutCloseout = scenarioId === "timeout-closeout";
      const turnkeyai = buildRun({
        system: "turnkeyai",
        artifactPath: `artifacts/evals/run/turnkeyai/${scenarioId}.json`,
        missionId: `msn.${scenarioId}.1`,
        dimensionScores: FULL_SCORES,
        requiresBrowser,
        requiresApproval,
        requiresContinuation,
        requiresTimeoutCloseout,
        scenarioId,
        prompt,
      });
      return {
        scenarioId,
        prompt,
        promptPolicy: {
          naturalPrompt: true,
          noForcedToolCall: true,
          noFixedMarkerGate: true,
          noExactAnswerShape: true,
        },
        ...(requiresBrowser ? { requiresBrowser: true } : {}),
        ...(requiresApproval ? { requiresApproval: true } : {}),
        ...(requiresContinuation ? { requiresContinuation: true } : {}),
        ...(requiresTimeoutCloseout ? { requiresTimeoutCloseout: true } : {}),
        turnkeyai: input.weaken?.[scenarioId]?.(turnkeyai) ?? turnkeyai,
        reference: buildRun({
          system: "reference",
          artifactPath: `artifacts/evals/run/reference/${scenarioId}.json`,
          dimensionScores: FULL_SCORES,
          requiresBrowser,
          requiresApproval,
          requiresContinuation,
          requiresTimeoutCloseout,
          scenarioId,
          prompt,
        }),
      };
    }),
  };
}

function buildRun(input: {
  system: RealLlmAbScenarioRun["system"];
  artifactPath?: string | undefined;
  missionId?: string | undefined;
  dimensionScores: RealLlmAbScenarioRun["dimensionScores"];
  requiresBrowser?: boolean;
  requiresApproval?: boolean;
  requiresContinuation?: boolean;
  requiresTimeoutCloseout?: boolean;
  browserEvidence?: RealLlmAbScenarioRun["browserEvidence"];
  scenarioId?: string;
  prompt: string;
}): RealLlmAbScenarioRun {
  const scenarioId = input.scenarioId ?? "browser-dynamic-page";
  const subAgentCount = scenarioId === "long-delegation" ? 2 : 1;
  const completedSubAgentCount = subAgentCount;
  const toolSequence =
    scenarioId === "memory-recall"
      ? ["memory_search", "memory_get"]
      : input.requiresContinuation
        ? ["sessions_send"]
        : [];
  return {
    system: input.system,
    prompt: input.prompt,
    ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {}),
    wallClockMs: 42_000,
    toolCallCount: 2,
    toolResultCount: 2,
    toolSequence,
    subAgentCount,
    completedSubAgentCount,
    continuation: {
      required: input.requiresContinuation ?? false,
      sessionsContinued: input.requiresContinuation ? 1 : 0,
      usedSessionsSend: input.requiresContinuation ?? false,
      reusedPriorContext: input.requiresContinuation ?? false,
    },
    timeout: {
      required: input.requiresTimeoutCloseout ?? false,
      timedOut: input.requiresTimeoutCloseout ?? false,
      partialCloseout: input.requiresTimeoutCloseout ?? false,
      hardAborted: false,
    },
    browserEvidence: input.browserEvidence ?? {
      required: input.requiresBrowser ?? true,
      used: true,
      rendered: true,
      urls: ["http://127.0.0.1:4100/app#/mission/msn.local.1"],
      screenshotCount: 1,
      snapshotCount: 1,
    },
    approval: {
      required: input.requiresApproval ?? false,
      ...(input.requiresApproval ? { requested: true, decided: true, applied: true, sideEffectPreventedBeforeApproval: true } : {}),
    },
    completed: true,
    stuckOrLoop: false,
    finalAnswerUseful: true,
    finalAnswerHasEvidence: true,
    residualRiskVisible: true,
    dimensionScores: input.dimensionScores,
  };
}
