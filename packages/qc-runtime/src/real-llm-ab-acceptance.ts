export type RealLlmAbSystemId = "turnkeyai" | "reference";

export type RealLlmAbDimensionKey =
  | "taskCompletion"
  | "evidenceQuality"
  | "toolUseAppropriateness"
  | "browserAuthenticity"
  | "subAgentIndependence"
  | "continuationBehavior"
  | "permissionCorrectness"
  | "timeoutCloseoutQuality"
  | "finalAnswerUsefulness";

export type RealLlmAbDimensionScore = 0 | 1 | 2;

export type RealLlmAbRootCauseBucket =
  | "prompt_harness"
  | "tool_selection"
  | "sub_agent_runtime"
  | "browser_reliability"
  | "memory_context"
  | "timeout_cancel_continue"
  | "permission_flow"
  | "final_answer_quality"
  | "ui_replay_visibility"
  | "acceptance_harness";

export interface RealLlmAbScenarioRun {
  system: RealLlmAbSystemId;
  artifactPath?: string;
  missionId?: string;
  validationId?: string;
  transcriptPath?: string;
  wallClockMs?: number;
  toolCallCount?: number;
  toolResultCount?: number;
  toolSequence?: string[];
  subAgentCount?: number;
  completedSubAgentCount?: number;
  browserEvidence?: {
    required?: boolean;
    used?: boolean;
    rendered?: boolean;
    urls?: string[];
    screenshotCount?: number;
    snapshotCount?: number;
    logCount?: number;
  };
  approval?: {
    required?: boolean;
    requested?: boolean;
    decided?: boolean;
    applied?: boolean;
    sideEffectPreventedBeforeApproval?: boolean;
  };
  completed?: boolean;
  stuckOrLoop?: boolean;
  finalAnswerUseful?: boolean;
  finalAnswerHasEvidence?: boolean;
  weakAnswerSignals?: string[];
  residualRiskVisible?: boolean;
  unsupportedClaims?: string[];
  dimensionScores: Record<RealLlmAbDimensionKey, RealLlmAbDimensionScore>;
  rootCauseBuckets?: RealLlmAbRootCauseBucket[];
  notes?: string;
}

export interface RealLlmAbScenarioPair {
  scenarioId: string;
  prompt: string;
  promptPolicy?: {
    naturalPrompt?: boolean;
    noForcedToolCall?: boolean;
    noFixedMarkerGate?: boolean;
    noExactAnswerShape?: boolean;
  };
  requiresBrowser?: boolean;
  requiresApproval?: boolean;
  requiresContinuation?: boolean;
  requiresTimeoutCloseout?: boolean;
  turnkeyai: RealLlmAbScenarioRun;
  reference: RealLlmAbScenarioRun;
}

export interface RealLlmAbAcceptanceReport {
  kind: "turnkeyai.real-llm-ab-acceptance.report";
  status: "passed" | "failed";
  capabilityClaim: "capability proven" | "unproven";
  stabilityClaim: "stable" | "unstable" | "unproven";
  generatedAtMs?: number;
  scenarios: RealLlmAbScenarioPair[];
}

export interface RealLlmAbScenarioComparison {
  scenarioId: string;
  comparable: boolean;
  turnkeyaiScore: number;
  referenceScore: number;
  scoreDelta: number;
  turnkeyaiLossDimensions: RealLlmAbDimensionKey[];
  turnkeyaiCoreLossCount: number;
  rootCauseBuckets: RealLlmAbRootCauseBucket[];
  turnkeyaiArtifactPath?: string;
  referenceArtifactPath?: string;
  turnkeyaiMissionId?: string;
  referenceMissionId?: string;
  rootCauseRequired: boolean;
}

export interface RealLlmAbAcceptanceSummary {
  status: "passed" | "failed";
  capabilityClaim: "capability proven" | "unproven";
  stabilityClaim: "stable" | "unstable" | "unproven";
  scenarioCount: number;
  comparableScenarios: number;
  turnkeyaiWins: number;
  turnkeyaiTies: number;
  turnkeyaiLosses: number;
  rootCauseRequiredScenarios: number;
  rootCauseBuckets: RealLlmAbRootCauseBucket[];
  controlledPromptViolations: number;
  missingArtifactScenarios: number;
  turnkeyaiStuckOrLoopScenarios: number;
  turnkeyaiWeakAnswerScenarios: number;
  comparisons: RealLlmAbScenarioComparison[];
}

export interface RealLlmAbAcceptanceValidation {
  status: "passed" | "failed";
  failures: string[];
  summary: RealLlmAbAcceptanceSummary | null;
}

export type RealLlmAbRequiredSuite = "core";

export interface RealLlmAbAcceptanceValidationOptions {
  requiredSuite?: RealLlmAbRequiredSuite;
}

export const REAL_LLM_AB_DIMENSION_KEYS = [
  "taskCompletion",
  "evidenceQuality",
  "toolUseAppropriateness",
  "browserAuthenticity",
  "subAgentIndependence",
  "continuationBehavior",
  "permissionCorrectness",
  "timeoutCloseoutQuality",
  "finalAnswerUsefulness",
] as const satisfies readonly RealLlmAbDimensionKey[];

export const REAL_LLM_AB_CORE_SUITE_REQUIREMENTS = [
  {
    key: "comparison-research",
    acceptedScenarioIds: ["comparison-research", "natural-comparison-research"],
  },
  {
    key: "browser-dynamic-page",
    acceptedScenarioIds: ["browser-dynamic-page", "natural-browser-dynamic-page"],
  },
  {
    key: "followup-continuation",
    acceptedScenarioIds: [
      "followup-continuation",
      "natural-followup-continuation",
      "natural-browser-followup-continuation",
    ],
  },
  {
    key: "approval-dry-run-action",
    acceptedScenarioIds: ["approval-dry-run-action", "natural-approval-dry-run-action"],
  },
  {
    key: "long-delegation",
    acceptedScenarioIds: ["long-delegation", "natural-long-delegation"],
  },
  {
    key: "timeout-closeout",
    acceptedScenarioIds: [
      "timeout-closeout",
      "timeout-partial-closeout",
      "natural-timeout-partial-closeout",
      "natural-timeout-followup-continuation",
    ],
  },
  {
    key: "memory-recall",
    acceptedScenarioIds: ["memory-recall", "natural-memory-recall"],
  },
] as const;

const CORE_LOSS_DIMENSIONS = new Set<RealLlmAbDimensionKey>([
  "taskCompletion",
  "evidenceQuality",
  "toolUseAppropriateness",
  "browserAuthenticity",
  "subAgentIndependence",
  "continuationBehavior",
  "permissionCorrectness",
  "timeoutCloseoutQuality",
  "finalAnswerUsefulness",
]);

export function summarizeRealLlmAbAcceptanceReport(report: unknown): RealLlmAbAcceptanceSummary | null {
  if (!isRealLlmAbAcceptanceReport(report)) {
    return null;
  }
  const comparisons = report.scenarios.map(compareScenarioPair);
  return {
    status: report.status,
    capabilityClaim: report.capabilityClaim,
    stabilityClaim: report.stabilityClaim,
    scenarioCount: report.scenarios.length,
    comparableScenarios: comparisons.filter((comparison) => comparison.comparable).length,
    turnkeyaiWins: comparisons.filter((comparison) => comparison.comparable && comparison.scoreDelta > 0).length,
    turnkeyaiTies: comparisons.filter((comparison) => comparison.comparable && comparison.scoreDelta === 0).length,
    turnkeyaiLosses: comparisons.filter((comparison) => comparison.comparable && comparison.scoreDelta < 0).length,
    rootCauseRequiredScenarios: comparisons.filter((comparison) => comparison.rootCauseRequired).length,
    rootCauseBuckets: mergeStringSet(comparisons.flatMap((comparison) => comparison.rootCauseBuckets)),
    controlledPromptViolations: report.scenarios.filter((scenario) => detectControlledPromptLanguage(scenario.prompt).length > 0)
      .length,
    missingArtifactScenarios: comparisons.filter((comparison) => !comparison.comparable).length,
    turnkeyaiStuckOrLoopScenarios: report.scenarios.filter((scenario) => scenario.turnkeyai.stuckOrLoop === true).length,
    turnkeyaiWeakAnswerScenarios: report.scenarios.filter((scenario) => hasWeakTurnkeyAiAnswer(scenario.turnkeyai)).length,
    comparisons,
  };
}

export function validateRealLlmAbAcceptanceReport(
  report: unknown,
  options: RealLlmAbAcceptanceValidationOptions = {}
): RealLlmAbAcceptanceValidation {
  const summary = summarizeRealLlmAbAcceptanceReport(report);
  if (!summary || !isRealLlmAbAcceptanceReport(report)) {
    return { status: "failed", failures: ["not a real LLM A/B acceptance report"], summary: null };
  }
  const failures: string[] = [];
  if (report.status !== "passed") {
    failures.push("report status is not passed");
  }
  if (report.capabilityClaim !== "capability proven") {
    failures.push("capability claim is not proven");
  }
  if (report.stabilityClaim !== "stable") {
    failures.push("stability claim is not stable");
  }
  if (report.scenarios.length === 0) {
    failures.push("report has no scenarios");
  }
  report.scenarios.forEach((scenario) => {
    const promptViolations = detectControlledPromptLanguage(scenario.prompt);
    if (promptViolations.length > 0) {
      failures.push(`${scenario.scenarioId}: prompt contains controlled-gate language (${promptViolations.join(", ")})`);
    }
    if (scenario.promptPolicy?.naturalPrompt !== true) {
      failures.push(`${scenario.scenarioId}: natural prompt policy is not affirmed`);
    }
    if (scenario.promptPolicy?.noForcedToolCall !== true) {
      failures.push(`${scenario.scenarioId}: no-forced-tool-call policy is not affirmed`);
    }
    if (scenario.promptPolicy?.noFixedMarkerGate !== true) {
      failures.push(`${scenario.scenarioId}: no-fixed-marker policy is not affirmed`);
    }
    if (scenario.promptPolicy?.noExactAnswerShape !== true) {
      failures.push(`${scenario.scenarioId}: no-exact-answer-shape policy is not affirmed`);
    }
    for (const system of [scenario.turnkeyai, scenario.reference]) {
      for (const key of REAL_LLM_AB_DIMENSION_KEYS) {
        if (!isDimensionScore(system.dimensionScores[key])) {
          failures.push(`${scenario.scenarioId}/${system.system}: missing dimension score ${key}`);
        }
      }
      if (!system.artifactPath && !system.missionId && !system.validationId && !system.transcriptPath) {
        failures.push(`${scenario.scenarioId}/${system.system}: missing run artifact, mission id, validation id, or transcript`);
      }
    }
    if (scenario.requiresBrowser && !scenario.turnkeyai.browserEvidence?.used) {
      failures.push(`${scenario.scenarioId}: TurnkeyAI did not record browser evidence for a browser-required scenario`);
    }
    if (scenario.requiresApproval && !scenario.turnkeyai.approval?.requested) {
      failures.push(`${scenario.scenarioId}: TurnkeyAI did not record approval evidence for an approval-required scenario`);
    }
  });
  for (const comparison of summary.comparisons) {
    if (!comparison.comparable) {
      failures.push(`${comparison.scenarioId}: missing comparable artifacts`);
    }
    if (comparison.rootCauseRequired) {
      failures.push(`${comparison.scenarioId}: root-cause review required before claiming capability`);
    }
  }
  if (options.requiredSuite === "core") {
    for (const requirement of REAL_LLM_AB_CORE_SUITE_REQUIREMENTS) {
      const acceptedScenarioIds: readonly string[] = requirement.acceptedScenarioIds;
      const match = report.scenarios.find((scenario) => acceptedScenarioIds.includes(scenario.scenarioId));
      if (!match) {
        failures.push(`core suite missing required scenario: ${requirement.key}`);
      }
    }
  }
  return {
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    summary,
  };
}

export function detectControlledPromptLanguage(prompt: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ["exactly-once", /\bexactly\s+once\b/i],
    ["exact-final-shape", /\b(?:use|follow)\s+(?:this\s+)?exact\s+(?:final\s+)?(?:answer\s+)?shape\b/i],
    [
      "forced-tool-call",
      /\b(?:(?:must|必须)\s+)?(?:call|use|调用|使用)\s+(?:the\s+)?(?:(?:browser|explore|sessions_[a-z_]+)\s+)?(?:tool|工具|sessions_[a-z_]+|browser|explore)\b/i,
    ],
    ["fixed-marker", /\b(?:fixed\s+marker|release\s+marker|marker\s+as\s+(?:the\s+)?pass|TURNKEYAI_[A-Z0-9_]+)\b/i],
  ];
  return checks.flatMap(([name, pattern]) => (pattern.test(prompt) ? [name] : []));
}

function compareScenarioPair(scenario: RealLlmAbScenarioPair): RealLlmAbScenarioComparison {
  const turnkeyaiScore = scoreRun(scenario.turnkeyai);
  const referenceScore = scoreRun(scenario.reference);
  const lossDimensions = REAL_LLM_AB_DIMENSION_KEYS.filter(
    (key) => scenario.turnkeyai.dimensionScores[key] < scenario.reference.dimensionScores[key]
  );
  const rootCauseBuckets = mergeStringSet([
    ...deriveRootCauseBuckets(scenario, lossDimensions),
    ...(scenario.turnkeyai.rootCauseBuckets ?? []),
  ]);
  const comparable = hasRunEvidence(scenario.turnkeyai) && hasRunEvidence(scenario.reference);
  const rootCauseRequired =
    !comparable ||
    scenario.turnkeyai.stuckOrLoop === true ||
    hasWeakTurnkeyAiAnswer(scenario.turnkeyai) ||
    lossDimensions.filter((key) => CORE_LOSS_DIMENSIONS.has(key)).length >= 2;
  return {
    scenarioId: scenario.scenarioId,
    comparable,
    turnkeyaiScore,
    referenceScore,
    scoreDelta: turnkeyaiScore - referenceScore,
    turnkeyaiLossDimensions: lossDimensions,
    turnkeyaiCoreLossCount: lossDimensions.filter((key) => CORE_LOSS_DIMENSIONS.has(key)).length,
    rootCauseBuckets,
    ...(scenario.turnkeyai.artifactPath ? { turnkeyaiArtifactPath: scenario.turnkeyai.artifactPath } : {}),
    ...(scenario.reference.artifactPath ? { referenceArtifactPath: scenario.reference.artifactPath } : {}),
    ...(scenario.turnkeyai.missionId ? { turnkeyaiMissionId: scenario.turnkeyai.missionId } : {}),
    ...(scenario.reference.missionId ? { referenceMissionId: scenario.reference.missionId } : {}),
    rootCauseRequired,
  };
}

function deriveRootCauseBuckets(
  scenario: RealLlmAbScenarioPair,
  lossDimensions: RealLlmAbDimensionKey[]
): RealLlmAbRootCauseBucket[] {
  const buckets: RealLlmAbRootCauseBucket[] = [];
  if (lossDimensions.includes("toolUseAppropriateness")) buckets.push("tool_selection", "prompt_harness");
  if (lossDimensions.includes("subAgentIndependence")) buckets.push("sub_agent_runtime", "prompt_harness");
  if (
    lossDimensions.includes("browserAuthenticity") ||
    (scenario.turnkeyai.browserEvidence?.required === true && scenario.turnkeyai.browserEvidence?.used !== true)
  ) {
    buckets.push("browser_reliability");
  }
  if (lossDimensions.includes("continuationBehavior")) buckets.push("timeout_cancel_continue");
  if (lossDimensions.includes("permissionCorrectness")) buckets.push("permission_flow");
  if (lossDimensions.includes("timeoutCloseoutQuality")) buckets.push("timeout_cancel_continue");
  if (lossDimensions.includes("evidenceQuality") || lossDimensions.includes("finalAnswerUsefulness")) {
    buckets.push("final_answer_quality");
  }
  if (scenario.requiresContinuation) buckets.push("timeout_cancel_continue");
  if (scenario.requiresApproval) buckets.push("permission_flow");
  return buckets;
}

function scoreRun(run: RealLlmAbScenarioRun): number {
  return REAL_LLM_AB_DIMENSION_KEYS.reduce((sum, key) => sum + run.dimensionScores[key], 0);
}

function hasRunEvidence(run: RealLlmAbScenarioRun): boolean {
  return Boolean(run.artifactPath || run.missionId || run.validationId || run.transcriptPath);
}

function hasWeakTurnkeyAiAnswer(run: RealLlmAbScenarioRun): boolean {
  return (
    run.finalAnswerUseful === false ||
    run.finalAnswerHasEvidence === false ||
    (run.weakAnswerSignals?.length ?? 0) > 0 ||
    (run.unsupportedClaims?.length ?? 0) > 0
  );
}

function isRealLlmAbAcceptanceReport(value: unknown): value is RealLlmAbAcceptanceReport {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const report = value as Partial<RealLlmAbAcceptanceReport>;
  return (
    report.kind === "turnkeyai.real-llm-ab-acceptance.report" &&
    (report.status === "passed" || report.status === "failed") &&
    (report.capabilityClaim === "capability proven" || report.capabilityClaim === "unproven") &&
    (report.stabilityClaim === "stable" || report.stabilityClaim === "unstable" || report.stabilityClaim === "unproven") &&
    Array.isArray(report.scenarios) &&
    report.scenarios.every(isScenarioPair)
  );
}

function isScenarioPair(value: unknown): value is RealLlmAbScenarioPair {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const scenario = value as Partial<RealLlmAbScenarioPair>;
  return (
    typeof scenario.scenarioId === "string" &&
    scenario.scenarioId.trim().length > 0 &&
    typeof scenario.prompt === "string" &&
    scenario.prompt.trim().length > 0 &&
    isScenarioRun(scenario.turnkeyai, "turnkeyai") &&
    isScenarioRun(scenario.reference, "reference")
  );
}

function isScenarioRun(value: unknown, system: RealLlmAbSystemId): value is RealLlmAbScenarioRun {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const run = value as Partial<RealLlmAbScenarioRun>;
  return run.system === system && typeof run.dimensionScores === "object" && run.dimensionScores !== null;
}

function isDimensionScore(value: unknown): value is RealLlmAbDimensionScore {
  return value === 0 || value === 1 || value === 2;
}

function mergeStringSet<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort();
}
