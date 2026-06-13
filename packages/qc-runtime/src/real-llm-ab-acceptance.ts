import {
  DEFAULT_REAL_ACCEPTANCE_NATURAL_BROWSER_AB_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_NATURAL_BROWSER_RELIABILITY_AB_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_NATURAL_CORE_AB_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS,
} from "./real-llm-acceptance-defaults";

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

export type RealLlmAbComparisonClassification =
  | "validated_comparison"
  | "turnkeyai_only_gate"
  | "reference_env_failed"
  | "adapter_unproven"
  | "unfair_prompt_or_fixture";

export interface RealLlmAbReferenceAudit {
  provenanceStatus: "passed" | "failed";
  runtimeHealthStatus: "passed" | "failed";
  adapterStatus: "passed" | "failed";
  fairnessStatus: "passed" | "failed";
  missingProvenance: string[];
  findings: string[];
}

export interface RealLlmAbScenarioRun {
  system: RealLlmAbSystemId;
  prompt?: string;
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
  continuation?: {
    required?: boolean;
    sessionsContinued?: number;
    usedSessionsSend?: boolean;
    reusedPriorContext?: boolean;
  };
  timeout?: {
    required?: boolean;
    timedOut?: boolean;
    partialCloseout?: boolean;
    hardAborted?: boolean;
  };
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
  comparisonClassification?: RealLlmAbComparisonClassification;
  referenceAudit?: RealLlmAbReferenceAudit;
  turnkeyai: RealLlmAbScenarioRun;
  reference: RealLlmAbScenarioRun;
}

export interface RealLlmAbAcceptanceReport {
  kind: "turnkeyai.real-llm-ab-acceptance.report";
  status: "passed" | "failed";
  capabilityClaim: "capability proven" | "focused capability proven" | "unproven";
  stabilityClaim: "stable" | "focused stable" | "unstable" | "unproven";
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
  capabilityClaim: "capability proven" | "focused capability proven" | "unproven";
  stabilityClaim: "stable" | "focused stable" | "unstable" | "unproven";
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

export type RealLlmAbRequiredSuite = "core" | "browser-focused" | "browser-reliability" | "full-natural";

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

export const REAL_LLM_AB_ROOT_CAUSE_BUCKETS = [
  "prompt_harness",
  "tool_selection",
  "sub_agent_runtime",
  "browser_reliability",
  "memory_context",
  "timeout_cancel_continue",
  "permission_flow",
  "final_answer_quality",
  "ui_replay_visibility",
  "acceptance_harness",
] as const satisfies readonly RealLlmAbRootCauseBucket[];

export const REAL_LLM_AB_CORE_SUITE_REQUIREMENTS = [
  {
    key: "comparison-research",
    acceptedScenarioIds: ["comparison-research", "natural-comparison-research"],
  },
  {
    key: "provider-search-pricing",
    acceptedScenarioIds: ["natural-provider-search-pricing"],
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
    key: "asiawalk-multi-agent",
    acceptedScenarioIds: ["natural-asiawalk-multi-agent"],
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
] as const satisfies readonly {
  key: string;
  acceptedScenarioIds: readonly (
    | (typeof DEFAULT_REAL_ACCEPTANCE_NATURAL_CORE_AB_SCENARIOS)[number]
    | string
  )[];
}[];

export const REAL_LLM_AB_BROWSER_FOCUSED_SUITE_REQUIREMENTS =
  DEFAULT_REAL_ACCEPTANCE_NATURAL_BROWSER_AB_SCENARIOS.map((scenarioId) => ({
    key: scenarioId.replace(/^natural-/, ""),
    acceptedScenarioIds: [scenarioId],
  })) as readonly {
    key: string;
    acceptedScenarioIds: readonly string[];
  }[];

export const REAL_LLM_AB_BROWSER_RELIABILITY_SUITE_REQUIREMENTS =
  DEFAULT_REAL_ACCEPTANCE_NATURAL_BROWSER_RELIABILITY_AB_SCENARIOS.map((scenarioId) => ({
    key: scenarioId.replace(/^natural-/, ""),
    acceptedScenarioIds: [scenarioId],
  })) as readonly {
    key: string;
    acceptedScenarioIds: readonly string[];
  }[];

export const REAL_LLM_AB_FULL_NATURAL_SUITE_REQUIREMENTS = DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS.map(
  (scenarioId) => ({
    key: scenarioId.replace(/^natural-/, ""),
    acceptedScenarioIds: [scenarioId],
  })
) as readonly {
  key: string;
  acceptedScenarioIds: readonly string[];
}[];

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

const FORCED_TOOL_CALL_PATTERN = new RegExp(
  [
    "\\b(?:(?:must|必须)\\s+)?(?:call|use)\\s+(?:the\\s+)?(?:browser|explore)\\s+tool\\b",
    "\\b(?:(?:must|必须)\\s+)?(?:call|use)\\s+(?:the\\s+)?sessions_[a-z_]+\\b",
    "(?:调用|使用)\\s*(?:browser|explore)\\s*(?:tool|工具)",
    "(?:调用|使用)\\s*sessions_[a-z_]+",
  ].join("|"),
  "i"
);

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
  const coreSuiteCovered = coversCoreSuite(report);
  if (report.capabilityClaim === "capability proven") {
    if (!coreSuiteCovered) {
      failures.push("capability proven requires the full core suite");
    }
  } else if (report.capabilityClaim === "focused capability proven") {
    if (options.requiredSuite === "core") {
      failures.push("focused capability evidence is not core capability evidence");
    }
  } else {
    failures.push("capability claim is not proven");
  }
  if (report.stabilityClaim === "stable") {
    if (!coreSuiteCovered) {
      failures.push("stable claim requires the full core suite");
    }
  } else if (report.stabilityClaim === "focused stable") {
    if (options.requiredSuite === "core") {
      failures.push("focused stability evidence is not core stability evidence");
    }
  } else {
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
      const runPrompt = normalizePrompt(system.prompt);
      const scenarioPrompt = normalizePrompt(scenario.prompt);
      if (!runPrompt) {
        failures.push(`${scenario.scenarioId}/${system.system}: missing run prompt evidence`);
      } else if (runPrompt !== scenarioPrompt) {
        failures.push(`${scenario.scenarioId}/${system.system}: run prompt does not match the scenario prompt`);
      }
      if (readCount(system.wallClockMs) <= 0) {
        failures.push(`${scenario.scenarioId}/${system.system}: missing positive wall-clock runtime evidence`);
      }
      const runPromptViolations = detectControlledPromptLanguage(system.prompt ?? "");
      if (runPromptViolations.length > 0) {
        failures.push(
          `${scenario.scenarioId}/${system.system}: run prompt contains controlled-gate language (${runPromptViolations.join(", ")})`
        );
      }
      for (const key of REAL_LLM_AB_DIMENSION_KEYS) {
        if (!isDimensionScore(system.dimensionScores[key])) {
          failures.push(`${scenario.scenarioId}/${system.system}: missing dimension score ${key}`);
        } else if (system.system === "turnkeyai" && system.dimensionScores[key] === 0) {
          failures.push(`${scenario.scenarioId}: TurnkeyAI scored 0 for ${key}; root-cause review required before claiming capability`);
        }
      }
      for (const bucket of system.rootCauseBuckets ?? []) {
        if (!isRootCauseBucket(bucket)) {
          failures.push(`${scenario.scenarioId}/${system.system}: unknown root-cause bucket ${bucket}`);
        }
      }
      if (!system.artifactPath && !system.missionId && !system.validationId && !system.transcriptPath) {
        failures.push(`${scenario.scenarioId}/${system.system}: missing run artifact, mission id, validation id, or transcript`);
      }
    }
    if (scenario.comparisonClassification !== "validated_comparison") {
      failures.push(
        `${scenario.scenarioId}: comparison is not validated (${scenario.comparisonClassification ?? "missing classification"})`
      );
    }
    if (scenario.referenceAudit) {
      if (scenario.referenceAudit.provenanceStatus !== "passed") {
        failures.push(
          `${scenario.scenarioId}/reference: provenance gate failed (${scenario.referenceAudit.missingProvenance.join(", ")})`
        );
      }
      if (scenario.referenceAudit.runtimeHealthStatus !== "passed") {
        failures.push(`${scenario.scenarioId}/reference: runtime health gate failed`);
      }
      if (scenario.referenceAudit.adapterStatus !== "passed") {
        failures.push(`${scenario.scenarioId}/reference: adapter mapping gate failed`);
      }
      if (scenario.referenceAudit.fairnessStatus !== "passed") {
        failures.push(`${scenario.scenarioId}/reference: same-scenario fairness gate failed`);
      }
    }
    if (scenario.requiresBrowser && !scenario.turnkeyai.browserEvidence?.used) {
      failures.push(`${scenario.scenarioId}: TurnkeyAI did not record browser evidence for a browser-required scenario`);
    }
    if (scenario.requiresBrowser && scenario.turnkeyai.browserEvidence?.rendered !== true) {
      failures.push(`${scenario.scenarioId}: TurnkeyAI did not record rendered browser evidence for a browser-required scenario`);
    }
    if (
      scenario.requiresBrowser &&
      readCount(scenario.turnkeyai.browserEvidence?.screenshotCount) +
        readCount(scenario.turnkeyai.browserEvidence?.snapshotCount) +
        readCount(scenario.turnkeyai.browserEvidence?.logCount) ===
        0
    ) {
      failures.push(`${scenario.scenarioId}: TurnkeyAI browser-required scenario has no browser artifact evidence`);
    }
    if (scenario.requiresApproval && !scenario.turnkeyai.approval?.requested) {
      failures.push(`${scenario.scenarioId}: TurnkeyAI did not record approval evidence for an approval-required scenario`);
    }
    if (scenario.requiresApproval && scenario.turnkeyai.approval?.sideEffectPreventedBeforeApproval !== true) {
      failures.push(`${scenario.scenarioId}: TurnkeyAI did not record approval pre-side-effect safety evidence`);
    }
    if (scenario.requiresContinuation && !hasTurnkeyAiContinuationEvidence(scenario.turnkeyai)) {
      failures.push(`${scenario.scenarioId}: TurnkeyAI did not record continuation reuse evidence`);
    }
    if (scenario.requiresTimeoutCloseout && !hasTurnkeyAiTimeoutCloseoutEvidence(scenario.turnkeyai)) {
      failures.push(`${scenario.scenarioId}: TurnkeyAI did not record timeout partial-closeout evidence`);
    }
    if (isLongDelegationScenario(scenario.scenarioId) && !hasTurnkeyAiLongDelegationEvidence(scenario.turnkeyai)) {
      failures.push(`${scenario.scenarioId}: TurnkeyAI did not record independent long-delegation sub-agent evidence`);
    }
    if (isMemoryRecallScenario(scenario.scenarioId) && !hasToolSequence(scenario.turnkeyai, ["memory_search", "memory_get"])) {
      failures.push(`${scenario.scenarioId}: TurnkeyAI did not record memory_search and memory_get evidence`);
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
  if (options.requiredSuite) {
    for (const requirement of requiredSuiteRequirements(options.requiredSuite)) {
      const acceptedScenarioIds: readonly string[] = requirement.acceptedScenarioIds;
      const match = report.scenarios.find((scenario) => acceptedScenarioIds.includes(scenario.scenarioId));
      if (!match) {
        failures.push(`${options.requiredSuite} suite missing required scenario: ${requirement.key}`);
      }
    }
  }
  return {
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    summary,
  };
}

export function buildRealLlmAbMarkdownReport(
  report: unknown,
  options: RealLlmAbAcceptanceValidationOptions = {}
): string {
  const validation = validateRealLlmAbAcceptanceReport(report, options);
  const summary = validation.summary;
  if (!summary || !isRealLlmAbAcceptanceReport(report)) {
    return [
      "# Real LLM A/B Acceptance Report",
      "",
      "## Conclusion",
      "",
      "- Capability: unproven",
      "- Stability: unproven",
      "- Status: failed",
      "",
      "## Failures",
      "",
      ...validation.failures.map((failure) => `- ${failure}`),
      "",
    ].join("\n");
  }

  const comparisons = summary.comparisons;
  const losingComparisons = comparisons.filter((comparison) => comparison.scoreDelta < 0 || comparison.rootCauseRequired);
  const rootCauseBuckets = summary.rootCauseBuckets;
  const referenceAuditFindingLines = formatReferenceAuditFindingLines(report);
  const effectiveCapabilityClaim = validation.status === "passed" ? summary.capabilityClaim : "unproven";
  const effectiveStabilityClaim = validation.status === "passed" ? summary.stabilityClaim : "unstable";
  const reportedClaimLines =
    effectiveCapabilityClaim === summary.capabilityClaim && effectiveStabilityClaim === summary.stabilityClaim
      ? []
      : [
          `- Reported capability: ${summary.capabilityClaim}`,
          `- Reported stability: ${summary.stabilityClaim}`,
        ];
  return [
    "# Real LLM A/B Acceptance Report",
    "",
    "## Conclusion",
    "",
    `- Capability: ${effectiveCapabilityClaim}`,
    `- Stability: ${effectiveStabilityClaim}`,
    `- Status: ${validation.status}`,
    ...reportedClaimLines,
    `- Scenarios: ${summary.scenarioCount}`,
    `- Comparable scenarios: ${summary.comparableScenarios}`,
    `- TurnkeyAI wins/ties/losses: ${summary.turnkeyaiWins}/${summary.turnkeyaiTies}/${summary.turnkeyaiLosses}`,
    `- Root-cause review required: ${summary.rootCauseRequiredScenarios}`,
    "",
    "## Comparison Classification",
    "",
    ...comparisons.map((comparison) => {
      const scenario = report.scenarios.find((item) => item.scenarioId === comparison.scenarioId);
      return `- ${comparison.scenarioId}: ${scenario?.comparisonClassification ?? "missing classification"}`;
    }),
    "",
    "## Reference Audit Findings",
    "",
    ...(referenceAuditFindingLines.length === 0 ? ["- None."] : referenceAuditFindingLines),
    "",
    "## Where TurnkeyAI Lost Or Needs Review",
    "",
    ...(losingComparisons.length === 0
      ? ["- None."]
      : losingComparisons.map((comparison) => formatComparisonLossLine(comparison))),
    "",
    "## Root-Cause Buckets",
    "",
    ...(rootCauseBuckets.length === 0 ? ["- None."] : rootCauseBuckets.map((bucket) => `- ${bucket}`)),
    "",
    "## Next Root-Cause PRs",
    "",
    ...formatNextRootCausePrs(rootCauseBuckets),
    "",
    "## Scenario Scores",
    "",
    "| Scenario | TurnkeyAI | Reference | Delta | Root Cause Required |",
    "| --- | ---: | ---: | ---: | --- |",
    ...comparisons.map(
      (comparison) =>
        `| ${comparison.scenarioId} | ${comparison.turnkeyaiScore} | ${comparison.referenceScore} | ${formatDelta(
          comparison.scoreDelta
        )} | ${comparison.rootCauseRequired ? "yes" : "no"} |`
    ),
    "",
    "## Validation Failures",
    "",
    ...(validation.failures.length === 0 ? ["- None."] : validation.failures.map((failure) => `- ${failure}`)),
    "",
  ].join("\n");
}

function formatReferenceAuditFindingLines(report: RealLlmAbAcceptanceReport): string[] {
  const lines: string[] = [];
  for (const scenario of report.scenarios) {
    const findings = scenario.referenceAudit?.findings ?? [];
    if (findings.length === 0) continue;
    lines.push(`- ${scenario.scenarioId}: ${scenario.comparisonClassification}`);
    for (const finding of findings.slice(0, 6)) {
      lines.push(`  - ${formatMarkdownSingleLine(finding)}`);
    }
    if (findings.length > 6) {
      lines.push(`  - ... ${findings.length - 6} more finding(s) in JSON report`);
    }
  }
  return lines;
}

function formatMarkdownSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function detectControlledPromptLanguage(prompt: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ["exactly-once", /\bexactly\s+once\b/i],
    ["exact-final-shape", /\b(?:use|follow)\s+(?:this\s+)?exact\s+(?:final\s+)?(?:answer\s+)?shape\b/i],
    ["forced-tool-call", forcedToolCallPattern()],
    ["fixed-marker", /\b(?:fixed\s+marker|release\s+marker|marker\s+as\s+(?:the\s+)?pass|TURNKEYAI_[A-Z0-9_]+)\b/i],
  ];
  return checks.flatMap(([name, pattern]) => (pattern.test(prompt) ? [name] : []));
}

function forcedToolCallPattern(): RegExp {
  return FORCED_TOOL_CALL_PATTERN;
}

function compareScenarioPair(scenario: RealLlmAbScenarioPair): RealLlmAbScenarioComparison {
  const turnkeyaiScore = scoreRun(scenario.turnkeyai);
  const referenceScore = scoreRun(scenario.reference);
  const lossDimensions = REAL_LLM_AB_DIMENSION_KEYS.filter(
    (key) => scenario.turnkeyai.dimensionScores[key] < scenario.reference.dimensionScores[key]
  );
  const zeroDimensions = REAL_LLM_AB_DIMENSION_KEYS.filter((key) => scenario.turnkeyai.dimensionScores[key] === 0);
  const rootCauseBuckets = mergeStringSet([
    ...deriveRootCauseBuckets(scenario, mergeStringSet([...lossDimensions, ...zeroDimensions]) as RealLlmAbDimensionKey[]),
    ...(scenario.turnkeyai.rootCauseBuckets ?? []),
  ]);
  const comparable =
    hasRunEvidence(scenario.turnkeyai) &&
    hasRunEvidence(scenario.reference) &&
    scenario.comparisonClassification === "validated_comparison";
  const rootCauseRequired =
    !comparable ||
    scenario.turnkeyai.stuckOrLoop === true ||
    hasWeakTurnkeyAiAnswer(scenario.turnkeyai) ||
    zeroDimensions.length > 0 ||
    hasRequiredTurnkeyAiProofGap(scenario) ||
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
  if (
    scenario.requiresApproval &&
    (scenario.turnkeyai.approval?.requested !== true ||
      scenario.turnkeyai.approval?.sideEffectPreventedBeforeApproval !== true)
  ) {
    buckets.push("permission_flow");
  }
  if (scenario.requiresContinuation && !hasTurnkeyAiContinuationEvidence(scenario.turnkeyai)) {
    buckets.push("timeout_cancel_continue");
  }
  if (scenario.requiresTimeoutCloseout && !hasTurnkeyAiTimeoutCloseoutEvidence(scenario.turnkeyai)) {
    buckets.push("timeout_cancel_continue");
  }
  return buckets;
}

function formatComparisonLossLine(comparison: RealLlmAbScenarioComparison): string {
  const dimensions =
    comparison.turnkeyaiLossDimensions.length > 0 ? comparison.turnkeyaiLossDimensions.join(", ") : "none";
  const buckets = comparison.rootCauseBuckets.length > 0 ? comparison.rootCauseBuckets.join(", ") : "none";
  return `- ${comparison.scenarioId}: delta ${formatDelta(comparison.scoreDelta)}; loss dimensions: ${dimensions}; root-cause buckets: ${buckets}.`;
}

function formatNextRootCausePrs(buckets: readonly RealLlmAbRootCauseBucket[]): string[] {
  if (buckets.length === 0) {
    return ["- No root-cause PR is required by this report."];
  }
  const unique = mergeStringSet([...buckets]);
  return unique.map((bucket) => `- ${bucket}: ${ROOT_CAUSE_PR_GUIDANCE[bucket]}`);
}

const ROOT_CAUSE_PR_GUIDANCE: Record<RealLlmAbRootCauseBucket, string> = {
  prompt_harness: "tighten task, delegation, evidence, and closeout prompt guidance before changing UI surfaces.",
  tool_selection: "fix tool schema visibility, tool routing, or disabled-tool admission so the model selects the right capability.",
  sub_agent_runtime: "prove specialist sub-agents complete independent work instead of forcing the lead to compensate.",
  browser_reliability: "repair browser session/profile/transport recovery so browser failures do not become weak answers or loops.",
  memory_context: "repair memory recall, freshness, invalidation, or context pressure behavior before claiming continuity.",
  timeout_cancel_continue: "repair timeout, cancellation, continuation, or resumable-session semantics with natural follow-up evidence.",
  permission_flow: "repair approval query/result/applied behavior and prove side effects stay gated until approval.",
  final_answer_quality: "repair evidence policy, source coverage, unsupported-claim filtering, or final synthesis quality.",
  ui_replay_visibility: "repair replay ordering, grouping, or visibility only after the runtime evidence chain is present.",
  acceptance_harness: "repair the acceptance harness when it cannot distinguish real capability from fixture-shaped evidence.",
};

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
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

function hasRequiredTurnkeyAiProofGap(scenario: RealLlmAbScenarioPair): boolean {
  if (
    scenario.requiresBrowser &&
    (scenario.turnkeyai.browserEvidence?.used !== true ||
      scenario.turnkeyai.browserEvidence?.rendered !== true ||
      readCount(scenario.turnkeyai.browserEvidence?.screenshotCount) +
        readCount(scenario.turnkeyai.browserEvidence?.snapshotCount) +
        readCount(scenario.turnkeyai.browserEvidence?.logCount) ===
        0)
  ) {
    return true;
  }
  if (
    scenario.requiresApproval &&
    (scenario.turnkeyai.approval?.requested !== true ||
      scenario.turnkeyai.approval?.sideEffectPreventedBeforeApproval !== true)
  ) {
    return true;
  }
  if (scenario.requiresContinuation && !hasTurnkeyAiContinuationEvidence(scenario.turnkeyai)) {
    return true;
  }
  if (scenario.requiresTimeoutCloseout && !hasTurnkeyAiTimeoutCloseoutEvidence(scenario.turnkeyai)) {
    return true;
  }
  if (isLongDelegationScenario(scenario.scenarioId) && !hasTurnkeyAiLongDelegationEvidence(scenario.turnkeyai)) {
    return true;
  }
  if (isMemoryRecallScenario(scenario.scenarioId) && !hasToolSequence(scenario.turnkeyai, ["memory_search", "memory_get"])) {
    return true;
  }
  return false;
}

function hasTurnkeyAiContinuationEvidence(run: RealLlmAbScenarioRun): boolean {
  return (
    readCount(run.continuation?.sessionsContinued) > 0 ||
    run.continuation?.usedSessionsSend === true ||
    run.continuation?.reusedPriorContext === true ||
    hasToolSequence(run, ["sessions_send"])
  );
}

function hasTurnkeyAiTimeoutCloseoutEvidence(run: RealLlmAbScenarioRun): boolean {
  return run.timeout?.timedOut === true && run.timeout?.partialCloseout === true && run.timeout?.hardAborted !== true;
}

function hasTurnkeyAiLongDelegationEvidence(run: RealLlmAbScenarioRun): boolean {
  return readCount(run.subAgentCount) >= 2 && readCount(run.completedSubAgentCount) >= 2;
}

function hasToolSequence(run: RealLlmAbScenarioRun, requiredTools: readonly string[]): boolean {
  const observed = new Set((run.toolSequence ?? []).map((tool) => tool.trim()).filter((tool) => tool.length > 0));
  return requiredTools.every((tool) => observed.has(tool));
}

function isLongDelegationScenario(scenarioId: string): boolean {
  return /\blong-delegation\b|natural-long-delegation/.test(scenarioId);
}

function isMemoryRecallScenario(scenarioId: string): boolean {
  return /\bmemory-recall\b|natural-memory-recall/.test(scenarioId);
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizePrompt(prompt: unknown): string {
  if (typeof prompt !== "string") return "";
  return normalizeLoopbackFixturePorts(prompt).replace(/\s+/g, " ").trim();
}

function normalizeLoopbackFixturePorts(prompt: string): string {
  return prompt.replace(
    /\b(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])):\d+/gi,
    "$1:<loopback-port>"
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
    (report.capabilityClaim === "capability proven" ||
      report.capabilityClaim === "focused capability proven" ||
      report.capabilityClaim === "unproven") &&
    (report.stabilityClaim === "stable" ||
      report.stabilityClaim === "focused stable" ||
      report.stabilityClaim === "unstable" ||
      report.stabilityClaim === "unproven") &&
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

function coversCoreSuite(report: RealLlmAbAcceptanceReport): boolean {
  return REAL_LLM_AB_CORE_SUITE_REQUIREMENTS.every((requirement) => {
    const acceptedScenarioIds: readonly string[] = requirement.acceptedScenarioIds;
    return report.scenarios.some((scenario) => acceptedScenarioIds.includes(scenario.scenarioId));
  });
}

function requiredSuiteRequirements(suite: RealLlmAbRequiredSuite): readonly {
  key: string;
  acceptedScenarioIds: readonly string[];
}[] {
  switch (suite) {
    case "core":
      return REAL_LLM_AB_CORE_SUITE_REQUIREMENTS;
    case "browser-focused":
      return REAL_LLM_AB_BROWSER_FOCUSED_SUITE_REQUIREMENTS;
    case "browser-reliability":
      return REAL_LLM_AB_BROWSER_RELIABILITY_SUITE_REQUIREMENTS;
    case "full-natural":
      return REAL_LLM_AB_FULL_NATURAL_SUITE_REQUIREMENTS;
    default: {
      const exhaustive: never = suite;
      return exhaustive;
    }
  }
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

function isRootCauseBucket(value: unknown): value is RealLlmAbRootCauseBucket {
  return typeof value === "string" && (REAL_LLM_AB_ROOT_CAUSE_BUCKETS as readonly string[]).includes(value);
}

function mergeStringSet<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort();
}
