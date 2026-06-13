import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildRealLlmAbMarkdownReport,
  REAL_LLM_AB_CORE_SUITE_REQUIREMENTS,
  REAL_LLM_AB_DIMENSION_KEYS,
  validateRealLlmAbAcceptanceReport,
  type RealLlmAbRequiredSuite,
  type RealLlmAbAcceptanceReport,
  type RealLlmAbDimensionKey,
  type RealLlmAbDimensionScore,
  type RealLlmAbRootCauseBucket,
  type RealLlmAbScenarioPair,
  type RealLlmAbScenarioRun,
  type RealLlmAbComparisonClassification,
  type RealLlmAbReferenceAudit,
} from "@turnkeyai/qc-runtime/real-llm-ab-acceptance";

import {
  isExpectedPendingApprovalFinal,
  readReferenceCompletion,
} from "./real-llm-ab-reference-collect";

type RealLlmAbReportBuildSuite = RealLlmAbRequiredSuite | "report-scenarios";

export interface RealLlmAbReportBuildOptions {
  specPath: string;
  outPath: string;
  check: boolean;
  requiredSuite?: RealLlmAbReportBuildSuite;
  markdownOutPath?: string;
}

export interface RealLlmAbReportBuildSpec {
  kind?: "turnkeyai.real-llm-ab-acceptance.build-spec";
  generatedAtMs?: number;
  turnkeyaiNaturalReportPath: string;
  scenarios: RealLlmAbReportBuildScenarioSpec[];
}

export interface RealLlmAbReportBuildScenarioSpec {
  scenarioId: string;
  turnkeyaiScenarioId: string;
  turnkeyaiNaturalReportPath?: string;
  prompt: string;
  promptPolicy?: RealLlmAbScenarioPair["promptPolicy"];
  requiresBrowser?: boolean;
  requiresApproval?: boolean;
  requiresContinuation?: boolean;
  requiresTimeoutCloseout?: boolean;
  referenceArtifactPath: string;
  referenceDimensionScores?: Partial<Record<RealLlmAbDimensionKey, RealLlmAbDimensionScore>>;
  modelComparison?: {
    turnkeyaiProvider?: string;
    turnkeyaiModelId?: string;
    referenceProvider?: string;
    referenceModelId?: string;
    differenceNote?: string;
  };
}

interface NaturalMissionReportShape {
  kind?: unknown;
  status?: unknown;
  generatedAtMs?: unknown;
  completedAt?: unknown;
  scenarios?: unknown;
}

interface NaturalMissionScenarioShape {
  scenario?: unknown;
  prompt?: unknown;
  missionId?: unknown;
  durationMs?: unknown;
  threadId?: unknown;
  status?: unknown;
  metrics?: MissionMetricsShape;
  artifacts?: unknown;
  natural?: {
    status?: unknown;
    completed?: unknown;
    stuckOrLoop?: unknown;
    reasonableToolUse?: unknown;
    browserUsed?: unknown;
    subAgentCompleted?: unknown;
    approvalExercised?: unknown;
    finalAnswerHasEvidence?: unknown;
    finalAnswerUseful?: unknown;
    weakAnswerSignals?: unknown;
    sourceCoverage?: {
      residualRiskVisible?: unknown;
      unsupportedClaims?: unknown;
    };
    dimensionScores?: unknown;
    failureBuckets?: unknown;
  };
  final?: {
    qualityFailures?: unknown;
    excerpt?: unknown;
  };
}

interface MissionMetricsShape {
  tools?: {
    requested?: unknown;
    results?: unknown;
    failed?: unknown;
    cancelled?: unknown;
    timeouts?: unknown;
    names?: unknown;
  };
  sessions?: {
    spawned?: unknown;
    continued?: unknown;
  };
  browser?: {
    profileFallbacks?: unknown;
    failureBuckets?: unknown;
  };
  approvals?: {
    requested?: unknown;
    decided?: unknown;
    applied?: unknown;
  };
  liveness?: {
    active?: unknown;
    waiting?: unknown;
    stale?: unknown;
  };
  evidenceEvents?: unknown;
}

interface GenericReferenceArtifactShape {
  system?: unknown;
  prompt?: unknown;
  userPrompt?: unknown;
  input?: {
    prompt?: unknown;
  };
  request?: {
    prompt?: unknown;
  };
  durationMs?: unknown;
  timedOut?: unknown;
  missionId?: unknown;
  validationId?: unknown;
  threadId?: unknown;
  transcriptPath?: unknown;
  score?: {
    useful?: unknown;
    weak?: unknown;
    delegationOnly?: unknown;
    expectedHits?: unknown;
    expectedTotal?: unknown;
  };
  first?: {
    summary?: GenericReferenceSummaryShape;
  };
  followup?: {
    summary?: GenericReferenceSummaryShape;
  };
  provenance?: GenericReferenceProvenanceShape;
  rawResponse?: unknown;
  rawTranscript?: unknown;
  rawToolCalls?: unknown;
  rawToolResults?: unknown;
  rawBrowserEvidence?: unknown;
  rawFlowEvidence?: unknown;
  rawApprovalEvidence?: unknown;
  artifactAdapterMappingSource?: unknown;
  collectedAtMs?: unknown;
  exitStatus?: unknown;
  errorReason?: unknown;
  notes?: unknown;
}

interface GenericReferenceSummaryShape {
  toolCallCount?: unknown;
  toolResultCount?: unknown;
  pendingToolCount?: unknown;
  finalText?: unknown;
}

interface GenericReferenceProvenanceShape {
  referenceApp?: unknown;
  referenceBinary?: unknown;
  referenceRepoPath?: unknown;
  referenceRuntimeRoot?: unknown;
  referenceVersion?: unknown;
  referenceCommit?: unknown;
  daemonUrl?: unknown;
  apiEndpoint?: unknown;
  modelCatalog?: unknown;
  provider?: unknown;
  modelId?: unknown;
  exactRequestPayload?: unknown;
  rawResponse?: unknown;
  rawTranscript?: unknown;
  rawToolCalls?: unknown;
  rawToolResults?: unknown;
  rawBrowserEvidence?: unknown;
  rawFlowEvidence?: unknown;
  rawApprovalEvidence?: unknown;
  artifactAdapterMappingSource?: unknown;
  collectedAtMs?: unknown;
  exitStatus?: unknown;
  timeout?: unknown;
  errorReason?: unknown;
  referenceScenarioDriver?: unknown;
}

export function parseRealLlmAbReportBuildArgs(args: string[]): RealLlmAbReportBuildOptions | { help: true } {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    return { help: true };
  }
  let specPath: string | undefined;
  let outPath: string | undefined;
  let check = false;
  let requiredSuite: RealLlmAbReportBuildSuite | undefined;
  let markdownOutPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--spec") {
      specPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      outPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--markdown-out") {
      markdownOutPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--suite") {
      const value = readValue(args, index, arg);
      if (!isRealLlmAbReportBuildSuite(value)) {
        throw new Error("--suite must be one of: core, browser-focused, browser-reliability, full-natural, report-scenarios");
      }
      requiredSuite = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!specPath) {
    throw new Error("missing required --spec <path>");
  }
  if (!outPath) {
    throw new Error("missing required --out <path>");
  }
  return {
    specPath,
    outPath,
    check,
    ...(requiredSuite ? { requiredSuite } : {}),
    ...(markdownOutPath ? { markdownOutPath } : {}),
  };
}

export async function runRealLlmAbReportBuildCli(args: string[]): Promise<void> {
  const options = parseRealLlmAbReportBuildArgs(args);
  if ("help" in options) {
    console.log(buildRealLlmAbReportBuildHelpText());
    return;
  }
  const spec = readJsonFile<RealLlmAbReportBuildSpec>(options.specPath);
  const report = buildRealLlmAbAcceptanceReport(spec, {
    specDir: path.dirname(path.resolve(options.specPath)),
  });
  const resolvedOutPath = path.resolve(options.outPath);
  const resolvedMarkdownOutPath = options.markdownOutPath ? path.resolve(options.markdownOutPath) : undefined;
  const acceptanceRequiredSuite = readAcceptanceRequiredSuite(options.requiredSuite);
  if (resolvedMarkdownOutPath && resolvedMarkdownOutPath === resolvedOutPath) {
    throw new Error("--markdown-out must differ from --out");
  }
  mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
  writeFileSync(resolvedOutPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`real LLM A/B report written: ${resolvedOutPath}`);
  if (resolvedMarkdownOutPath) {
    const markdown = buildRealLlmAbMarkdownReport(report, { requiredSuite: acceptanceRequiredSuite });
    mkdirSync(path.dirname(resolvedMarkdownOutPath), { recursive: true });
    writeFileSync(resolvedMarkdownOutPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    console.log(`real LLM A/B markdown report written: ${resolvedMarkdownOutPath}`);
  }
  if (options.check) {
    const validation = validateRealLlmAbAcceptanceReport(report, { requiredSuite: acceptanceRequiredSuite });
    if (validation.status !== "passed") {
      console.error("real LLM A/B acceptance failed");
      for (const failure of validation.failures) {
        console.error(`- ${failure}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log("real LLM A/B acceptance passed");
    if (options.requiredSuite) {
      console.log(`suite=${options.requiredSuite}`);
    }
  }
}

export function buildRealLlmAbReportBuildHelpText(): string {
  return [
    "TurnkeyAI real LLM A/B report builder",
    "",
    "Usage:",
    "  npm run acceptance:ab:build -- --spec <path> --out <path> [--check] [--suite <core|browser-focused|browser-reliability|full-natural|report-scenarios>] [--markdown-out <path>]",
    "",
    "The spec points at a TurnkeyAI natural mission report and same-scenario reference artifacts.",
    "--suite selects the required scenario set when --check is used.",
    "--markdown-out writes the same conclusion-first Markdown report as acceptance:ab:check.",
    "The generated report can be validated with npm run acceptance:ab:check.",
  ].join("\n");
}

export function buildRealLlmAbAcceptanceReport(
  spec: RealLlmAbReportBuildSpec,
  options: { specDir?: string } = {}
): RealLlmAbAcceptanceReport {
  const specDir = options.specDir ? path.resolve(options.specDir) : process.cwd();
  const naturalReportCache = new Map<string, NaturalMissionReportShape>();
  const scenarios = spec.scenarios.map((scenarioSpec) => {
    const turnkeyaiNaturalReportPath = scenarioSpec.turnkeyaiNaturalReportPath ?? spec.turnkeyaiNaturalReportPath;
    const naturalReportPath = resolveInputPath(turnkeyaiNaturalReportPath, specDir);
    const naturalReport = readNaturalMissionReport(naturalReportPath, naturalReportCache);
    const naturalScenario = findNaturalScenario(naturalReport, scenarioSpec.turnkeyaiScenarioId);
    const referenceArtifactPath = resolveInputPath(scenarioSpec.referenceArtifactPath, specDir);
    const referenceArtifact = readJsonFile<GenericReferenceArtifactShape>(referenceArtifactPath);
    const referencePrompt = readReferencePrompt(referenceArtifact) ?? "";
    const referenceAudit = auditReferenceArtifact({
      artifact: referenceArtifact,
      artifactPath: referenceArtifactPath,
      scenarioPrompt: scenarioSpec.prompt,
      referencePrompt,
      requiresBrowser: scenarioSpec.requiresBrowser === true,
    });
    return {
      scenarioId: scenarioSpec.scenarioId,
      prompt: scenarioSpec.prompt,
      promptPolicy: {
        naturalPrompt: true,
        noForcedToolCall: true,
        noFixedMarkerGate: true,
        noExactAnswerShape: true,
        ...(scenarioSpec.promptPolicy ?? {}),
      },
      ...(scenarioSpec.requiresBrowser !== undefined ? { requiresBrowser: scenarioSpec.requiresBrowser } : {}),
      ...(scenarioSpec.requiresApproval !== undefined ? { requiresApproval: scenarioSpec.requiresApproval } : {}),
      ...(scenarioSpec.requiresContinuation !== undefined ? { requiresContinuation: scenarioSpec.requiresContinuation } : {}),
      ...(scenarioSpec.requiresTimeoutCloseout !== undefined
        ? { requiresTimeoutCloseout: scenarioSpec.requiresTimeoutCloseout }
        : {}),
      comparisonClassification: classifyComparison(referenceAudit),
      referenceAudit,
      turnkeyai: buildTurnkeyAiRun({
        artifactPath: turnkeyaiNaturalReportPath,
        scenario: naturalScenario,
        requiresBrowser: scenarioSpec.requiresBrowser === true,
        requiresApproval: scenarioSpec.requiresApproval === true,
        requiresContinuation: scenarioSpec.requiresContinuation === true,
        requiresTimeoutCloseout: scenarioSpec.requiresTimeoutCloseout === true,
      }),
      reference: buildReferenceRun({
        artifactPath: scenarioSpec.referenceArtifactPath,
        artifact: referenceArtifact,
        dimensionScores: scenarioSpec.referenceDimensionScores,
        requiresBrowser: scenarioSpec.requiresBrowser === true,
        requiresApproval: scenarioSpec.requiresApproval === true,
        requiresContinuation: scenarioSpec.requiresContinuation === true,
        requiresTimeoutCloseout: scenarioSpec.requiresTimeoutCloseout === true,
      }),
    };
  });
  const coreSuiteCovered = coversCoreSuiteScenarioIds(scenarios.map((scenario) => scenario.scenarioId));
  const draft: RealLlmAbAcceptanceReport = {
    kind: "turnkeyai.real-llm-ab-acceptance.report",
    status: "failed",
    capabilityClaim: "unproven",
    stabilityClaim: "unproven",
    generatedAtMs: readNumber(spec.generatedAtMs) || Date.now(),
    scenarios,
  };
  const validation = validateRealLlmAbAcceptanceReport({
    ...draft,
    status: "passed",
    capabilityClaim: coreSuiteCovered ? "capability proven" : "focused capability proven",
    stabilityClaim: coreSuiteCovered ? "stable" : "focused stable",
  });
  return validation.status === "passed"
    ? {
        ...draft,
        status: "passed",
        capabilityClaim: coreSuiteCovered ? "capability proven" : "focused capability proven",
        stabilityClaim: coreSuiteCovered ? "stable" : "focused stable",
      }
    : draft;
}

function coversCoreSuiteScenarioIds(scenarioIds: readonly string[]): boolean {
  return REAL_LLM_AB_CORE_SUITE_REQUIREMENTS.every((requirement) => {
    const acceptedScenarioIds: readonly string[] = requirement.acceptedScenarioIds;
    return scenarioIds.some((scenarioId) => acceptedScenarioIds.includes(scenarioId));
  });
}

function isRealLlmAbReportBuildSuite(value: string): value is RealLlmAbReportBuildSuite {
  return (
    value === "core" ||
    value === "browser-focused" ||
    value === "browser-reliability" ||
    value === "full-natural" ||
    value === "report-scenarios"
  );
}

function readAcceptanceRequiredSuite(suite: RealLlmAbReportBuildSuite | undefined): RealLlmAbRequiredSuite | undefined {
  return suite === "report-scenarios" ? undefined : suite;
}

function buildTurnkeyAiRun(input: {
  artifactPath: string;
  scenario: NaturalMissionScenarioShape;
  requiresBrowser: boolean;
  requiresApproval: boolean;
  requiresContinuation: boolean;
  requiresTimeoutCloseout: boolean;
}): RealLlmAbScenarioRun {
  const metrics = input.scenario.metrics ?? {};
  const evidenceValueMismatches = findEvidenceValueMismatches({
    finalText: readTurnkeyAiFinalText(input.scenario),
    evidenceText: collectTurnkeyAiEvidenceText(input.scenario),
  });
  const dimensionScores = downgradeTurnkeyAiDimensionScoresForEvidenceMismatches(
    readTurnkeyAiDimensionScores(input.scenario),
    evidenceValueMismatches
  );
  const toolSequence = readStringArray(metrics.tools?.names);
  const sessionsContinued = readNumber(metrics.sessions?.continued);
  const toolTimeouts = readNumber(metrics.tools?.timeouts);
  const approvalWaitTimeoutCloseout = hasTurnkeyAiApprovalWaitTimeoutCloseout(input.scenario);
  const browserEvidenceEvents = input.scenario.natural?.browserUsed === true ? readNumber(metrics.evidenceEvents) : 0;
  const browserFailureBuckets = readBrowserFailureBucketNames(metrics.browser?.failureBuckets);
  const weakAnswerSignals = [
    ...readTurnkeyAiWeakAnswerSignals(input.scenario, browserFailureBuckets),
    ...evidenceValueMismatches.map(formatEvidenceValueMismatchSignal),
  ];
  return {
    system: "turnkeyai",
    prompt: readString(input.scenario.prompt) ?? "",
    artifactPath: input.artifactPath,
    ...(readString(input.scenario.missionId) ? { missionId: readString(input.scenario.missionId)! } : {}),
    ...(readString(input.scenario.threadId) ? { transcriptPath: `thread:${readString(input.scenario.threadId)!}` } : {}),
    wallClockMs: readNumber(input.scenario.durationMs),
    toolCallCount: readNumber(metrics.tools?.requested),
    toolResultCount: readNumber(metrics.tools?.results),
    toolSequence,
    subAgentCount: readNumber(metrics.sessions?.spawned),
    completedSubAgentCount: input.scenario.natural?.subAgentCompleted === true ? readNumber(metrics.sessions?.spawned) : 0,
    continuation: {
      required: input.requiresContinuation,
      sessionsContinued,
      usedSessionsSend: toolSequence.includes("sessions_send"),
      reusedPriorContext: sessionsContinued > 0,
    },
    timeout: {
      required: input.requiresTimeoutCloseout,
      timedOut: toolTimeouts > 0 || approvalWaitTimeoutCloseout,
      partialCloseout:
        (toolTimeouts > 0 || approvalWaitTimeoutCloseout) &&
        input.scenario.natural?.completed === true &&
        input.scenario.natural?.finalAnswerHasEvidence === true &&
        input.scenario.natural?.finalAnswerUseful === true,
      hardAborted: input.scenario.natural?.stuckOrLoop === true,
    },
    browserEvidence: {
      required: input.requiresBrowser,
      used: input.scenario.natural?.browserUsed === true,
      rendered: input.scenario.natural?.browserUsed === true && dimensionScores.browserAuthenticity > 0,
      screenshotCount: countArtifacts(input.scenario.artifacts, "screenshot"),
      snapshotCount: countArtifacts(input.scenario.artifacts, "snapshot"),
      logCount: browserEvidenceEvents,
    },
    approval: {
      required: input.requiresApproval || readNumber(metrics.approvals?.requested) > 0,
      requested: readNumber(metrics.approvals?.requested) > 0,
      decided: readNumber(metrics.approvals?.decided) > 0,
      applied: readNumber(metrics.approvals?.applied) > 0,
      sideEffectPreventedBeforeApproval:
        input.requiresApproval === true && input.scenario.natural?.approvalExercised === true
          ? true
          : undefined,
    },
    completed: input.scenario.natural?.completed === true,
    stuckOrLoop: input.scenario.natural?.stuckOrLoop === true,
    finalAnswerUseful: input.scenario.natural?.finalAnswerUseful === true && evidenceValueMismatches.length === 0,
    finalAnswerHasEvidence: input.scenario.natural?.finalAnswerHasEvidence === true,
    weakAnswerSignals,
    residualRiskVisible: input.scenario.natural?.sourceCoverage?.residualRiskVisible === true,
    unsupportedClaims: readStringArray(input.scenario.natural?.sourceCoverage?.unsupportedClaims),
    dimensionScores,
    rootCauseBuckets: mapNaturalFailureBuckets(input.scenario.natural?.failureBuckets),
  };
}

function hasTurnkeyAiApprovalWaitTimeoutCloseout(scenario: NaturalMissionScenarioShape): boolean {
  const text = [
    readString(scenario.final?.excerpt),
    stringifyForEvidence(scenario.metrics?.qualityChecks),
    stringifyForEvidence(scenario.natural?.sourceCoverage),
  ].join("\n");
  const toolNames = new Set(readStringArray(scenario.metrics?.tools?.names));
  return (
    toolNames.has("permission_query") &&
    toolNames.has("permission_result") &&
    readNumber(scenario.metrics?.approvals?.requested) > 0 &&
    readNumber(scenario.metrics?.approvals?.applied) === 0 &&
    /\bapproval wait[- ]timeout\b|\bapproval_wait_timeout\b|\bstill pending\b/i.test(text) &&
    /\b(?:did not|not|no)\b[\s\S]{0,80}\b(?:run|submit|submitted|side effects?|permission_applied|permission\.applied)\b/i.test(text)
  );
}

function buildReferenceRun(input: {
  artifactPath: string;
  artifact: GenericReferenceArtifactShape;
  dimensionScores?: Partial<Record<RealLlmAbDimensionKey, RealLlmAbDimensionScore>>;
  requiresBrowser: boolean;
  requiresApproval: boolean;
  requiresContinuation: boolean;
  requiresTimeoutCloseout: boolean;
}): RealLlmAbScenarioRun {
  const first = input.artifact.first?.summary;
  const followup = input.artifact.followup?.summary;
  const effectiveMessages = readEffectiveReferenceArtifactMessages(input.artifact, input.artifactPath);
  const effectiveToolCalls = effectiveMessages ? dedupeReferenceToolCalls(extractToolCalls(effectiveMessages)) : [];
  const effectiveToolResults = effectiveMessages ? extractToolResults(effectiveMessages) : [];
  const approvalPolicy = readReferenceApprovalDecisionPolicy(input.artifact);
  const effectiveCompletion = effectiveMessages
    ? readReferenceCompletion(effectiveMessages, { approvalDecisionPolicy: approvalPolicy })
    : null;
  const toolCallCount = Math.max(
    readNumber(first?.toolCallCount) + readNumber(followup?.toolCallCount),
    effectiveToolCalls.length
  );
  const toolResultCount = Math.max(
    readNumber(first?.toolResultCount) + readNumber(followup?.toolResultCount),
    effectiveToolResults.length
  );
  const useful = input.artifact.score?.useful === true;
  const effectiveFinalText = readLatestAssistantText(effectiveMessages ?? []) ?? readString(first?.finalText);
  const expectedPendingApprovalFinal =
    approvalPolicy === "pending" && isExpectedPendingApprovalFinal(effectiveFinalText ?? "");
  const weak =
    input.artifact.score?.weak === true ||
    (isWeakReferenceFinalText(effectiveFinalText) && !expectedPendingApprovalFinal);
  const approvalWaitTimeoutBaselineLoss = isApprovalWaitTimeoutReferenceBaselineLoss(input.artifact);
  const approvalWaitTimeoutContractViolation = isApprovalWaitTimeoutReferenceContractViolation(input.artifact);
  const timeoutPartialBaselineLoss = isTimeoutPartialReferenceBaselineLoss(input.artifact);
  const expectedDirectTimeoutCloseout = hasExpectedReferenceDirectTimeoutCloseout(input.artifact, effectiveMessages);
  const hasFollowup = Boolean(input.artifact.followup);
  const rawBrowserEvidence = [
    ...readArray(input.artifact.provenance?.rawBrowserEvidence ?? input.artifact.rawBrowserEvidence),
    ...(effectiveMessages ? extractBrowserEvidenceFromTranscript(effectiveMessages) : []),
  ];
  const evidenceValueMismatches = findEvidenceValueMismatches({
    finalText: effectiveFinalText ?? "",
    evidenceText: collectReferenceEvidenceText(input.artifact, {
      effectiveMessages,
      effectiveToolResults,
      rawBrowserEvidence,
    }),
  });
  const effectiveUseful = useful && !weak && !approvalWaitTimeoutContractViolation && evidenceValueMismatches.length === 0;
  const rawApprovalEvidence = input.artifact.provenance?.rawApprovalEvidence ?? input.artifact.rawApprovalEvidence;
  const renderedBrowserEvidence = containsRenderedBrowserEvidence(rawBrowserEvidence);
  const browserEvidenceUsed = renderedBrowserEvidence || hasNonEmptyEvidence(rawBrowserEvidence);
  const approvalRequested =
    input.requiresApproval &&
    (hasNonEmptyEvidence(rawApprovalEvidence) ||
      containsReferenceTerm(
        [
          input.artifact.provenance?.rawTranscript,
          input.artifact.rawTranscript,
          effectiveMessages,
          input.artifact.rawToolCalls,
          input.artifact.rawToolResults,
        ],
        /\bpermission\.query\b|approval (?:id|request)|browser\.form\.submit/i
      ));
  const approvalDecided =
    input.requiresApproval &&
    !approvalWaitTimeoutBaselineLoss &&
    (containsReferenceApprovalDecision(rawApprovalEvidence) ||
      containsReferenceTerm(
        [input.artifact.provenance?.rawTranscript, input.artifact.rawTranscript, effectiveMessages, input.artifact.rawToolResults],
        /\bpermission\.result\b|operator approved|approval was granted|approved action/i
      ));
  const approvalApplied =
    input.requiresApproval &&
    !approvalWaitTimeoutBaselineLoss &&
    (containsReferenceTerm(
      [
        input.artifact.provenance?.rawTranscript,
        input.artifact.rawTranscript,
        effectiveMessages,
        input.artifact.rawToolResults,
        input.artifact.first,
      ],
      /\bpermission\.applied\b|permission already granted|permission cache|approved action|form submitted successfully/i
    ) ||
      (approvalDecided && renderedBrowserEvidence && /submitted|post-submit|dry-run submission complete/i.test(readString(first?.finalText) ?? "")));
  const permissionCorrectnessScore = scoreReferencePermissionCorrectness({
    requiresApproval: input.requiresApproval,
    policy: approvalPolicy,
    approvalRequested,
    approvalDecided,
    approvalApplied,
    approvalWaitTimeoutContractViolation,
  });
  const continuationSatisfied = hasReferenceContinuationEvidence(input.artifact, {
    requiresContinuation: input.requiresContinuation,
    useful: effectiveUseful,
  });
  return {
    system: "reference",
    prompt: readReferencePrompt(input.artifact) ?? "",
    artifactPath: input.artifactPath,
    ...(readString(input.artifact.missionId) ? { missionId: readString(input.artifact.missionId)! } : {}),
    ...(readString(input.artifact.validationId) ? { validationId: readString(input.artifact.validationId)! } : {}),
    ...(readString(input.artifact.transcriptPath)
      ? { transcriptPath: readString(input.artifact.transcriptPath)! }
      : readString(input.artifact.threadId)
        ? { transcriptPath: `thread:${readString(input.artifact.threadId)!}` }
        : {}),
    wallClockMs: readNumber(input.artifact.durationMs),
    toolCallCount,
    toolResultCount,
    toolSequence: effectiveToolCalls.flatMap((call) => readReferenceToolName(call) ? [readReferenceToolName(call)!] : []),
    subAgentCount: toolCallCount,
    completedSubAgentCount: toolResultCount,
    continuation: {
      required: input.requiresContinuation,
      sessionsContinued: input.requiresContinuation
        ? continuationSatisfied
          ? 1
          : 0
        : hasFollowup && toolResultCount > 0
          ? 1
          : 0,
      usedSessionsSend: false,
      reusedPriorContext: input.requiresContinuation ? continuationSatisfied : hasFollowup && useful,
    },
    timeout: {
      required: input.requiresTimeoutCloseout,
      timedOut: input.artifact.timedOut === true || expectedDirectTimeoutCloseout,
      partialCloseout: input.requiresTimeoutCloseout
        ? (input.artifact.timedOut === true || expectedDirectTimeoutCloseout) &&
          useful &&
          !approvalWaitTimeoutBaselineLoss &&
          !timeoutPartialBaselineLoss
        : undefined,
      hardAborted: timeoutPartialBaselineLoss || (input.artifact.timedOut === true && !useful && !expectedDirectTimeoutCloseout),
    },
    browserEvidence: {
      required: input.requiresBrowser,
      used: browserEvidenceUsed,
      rendered: renderedBrowserEvidence,
    },
    approval: {
      required: input.requiresApproval,
      requested: approvalRequested,
      decided: approvalDecided,
      applied: approvalApplied,
      sideEffectPreventedBeforeApproval: input.requiresApproval ? approvalRequested : undefined,
    },
    completed: timeoutPartialBaselineLoss || approvalWaitTimeoutContractViolation ? false : effectiveUseful,
    stuckOrLoop:
      (input.artifact.timedOut === true && effectiveCompletion?.ready !== true) ||
      readNumber(first?.pendingToolCount) + readNumber(followup?.pendingToolCount) > 0,
    finalAnswerUseful: timeoutPartialBaselineLoss || approvalWaitTimeoutContractViolation ? false : effectiveUseful,
    finalAnswerHasEvidence: timeoutPartialBaselineLoss || approvalWaitTimeoutContractViolation ? false : effectiveUseful && toolResultCount > 0,
    weakAnswerSignals: [
      ...(weak || timeoutPartialBaselineLoss || approvalWaitTimeoutContractViolation ? ["weak-answer"] : []),
      ...evidenceValueMismatches.map(formatEvidenceValueMismatchSignal),
    ],
    residualRiskVisible: timeoutPartialBaselineLoss || approvalWaitTimeoutContractViolation ? false : effectiveUseful,
    dimensionScores: {
      ...inferReferenceDimensionScores({
        useful:
          approvalWaitTimeoutBaselineLoss ||
          timeoutPartialBaselineLoss ||
          approvalWaitTimeoutContractViolation ||
          evidenceValueMismatches.length > 0
            ? false
            : useful,
        toolCallCount,
        toolResultCount,
        requiresBrowser: input.requiresBrowser,
        requiresApproval: input.requiresApproval,
        requiresContinuation: input.requiresContinuation,
        continuationSatisfied,
        requiresTimeoutCloseout: input.requiresTimeoutCloseout,
      }),
      ...(input.dimensionScores ?? {}),
      ...(!effectiveUseful
        ? {
            taskCompletion: 0 as const,
            evidenceQuality: 0 as const,
            browserAuthenticity: input.requiresBrowser ? (0 as const) : (2 as const),
            finalAnswerUsefulness: 0 as const,
          }
        : {}),
      ...(input.requiresApproval ? { permissionCorrectness: permissionCorrectnessScore } : {}),
    },
  };
}

function readReferenceApprovalDecisionPolicy(
  artifact: GenericReferenceArtifactShape
): "approved" | "denied" | "pending" | "wait_timeout" | undefined {
  const driver =
    typeof artifact.provenance?.referenceScenarioDriver === "object" &&
    artifact.provenance.referenceScenarioDriver !== null
      ? (artifact.provenance.referenceScenarioDriver as Record<string, unknown>)
      : {};
  const policy = readString(driver.approvalDecisionPolicy);
  return policy === "approved" || policy === "denied" || policy === "pending" || policy === "wait_timeout"
    ? policy
    : undefined;
}

function scoreReferencePermissionCorrectness(input: {
  requiresApproval: boolean;
  policy?: "approved" | "denied" | "pending" | "wait_timeout";
  approvalRequested: boolean;
  approvalDecided: boolean;
  approvalApplied: boolean;
  approvalWaitTimeoutContractViolation: boolean;
}): RealLlmAbDimensionScore {
  if (!input.requiresApproval) return 2;
  if (!input.approvalRequested || input.approvalWaitTimeoutContractViolation) return 0;
  if (input.policy === "approved") {
    return input.approvalDecided && input.approvalApplied ? 2 : 1;
  }
  if (input.policy === "denied") {
    return input.approvalDecided && !input.approvalApplied ? 2 : 1;
  }
  if (input.policy === "pending" || input.policy === "wait_timeout") {
    return !input.approvalDecided && !input.approvalApplied ? 2 : 1;
  }
  return input.approvalDecided && input.approvalApplied ? 2 : 1;
}

function classifyComparison(audit: RealLlmAbReferenceAudit): RealLlmAbComparisonClassification {
  if (audit.fairnessStatus !== "passed") return "unfair_prompt_or_fixture";
  if (hasUnsupportedReferenceScenarioDriverFinding(audit.findings)) return "adapter_unproven";
  if (audit.runtimeHealthStatus !== "passed") return "reference_env_failed";
  if (audit.provenanceStatus !== "passed" || audit.adapterStatus !== "passed") return "adapter_unproven";
  return "validated_comparison";
}

function hasUnsupportedReferenceScenarioDriverFinding(findings: string[]): boolean {
  return findings.some((finding) => /^reference scenario driver unsupported:/i.test(finding));
}

function isTimeoutPartialReferenceBaselineLoss(artifact: GenericReferenceArtifactShape): boolean {
  const provenance = artifact.provenance ?? {};
  const driver =
    typeof provenance.referenceScenarioDriver === "object" && provenance.referenceScenarioDriver !== null
      ? provenance.referenceScenarioDriver as Record<string, unknown>
      : {};
  if (!["timeout_partial", "timeout_followup"].includes(readString(driver.kind) ?? "")) return false;
  if (readReferenceToolCallCount(artifact) === 0) return false;
  const finalText =
    readString(artifact.first?.summary?.finalText) ?? readString(artifact.followup?.summary?.finalText) ?? "";
  if (finalText && artifact.score?.useful === true && !isWeakReferenceFinalText(finalText)) return false;
  const toolResultCount = readReferenceToolResultCount(artifact);
  const timedOutWithoutUsefulCloseout =
    readString(provenance.exitStatus ?? artifact.exitStatus) === "timeout" &&
    artifact.timedOut === true &&
    (!finalText || artifact.score?.useful !== true || isWeakReferenceFinalText(finalText));
  const failedWorkerCloseout =
    toolResultCount > 0 &&
    containsReferenceTerm(
      [provenance.rawTranscript, artifact.rawTranscript, provenance.rawToolResults, artifact.rawToolResults, artifact.first],
      /\b(?:sub-agent returned no executable result|no executable results?|requested task did not match the worker|worker's implemented capability|without live network access|localhost is inaccessible)\b/i
    );
  if (!timedOutWithoutUsefulCloseout && !failedWorkerCloseout) return false;
  if (
    containsReferenceTerm(
      [provenance.rawToolResults, artifact.rawToolResults, artifact.first],
      /\b(?:verified|confirmed)\b[\s\S]{0,120}\b(?:response body|release-risk evidence|HTTP status|headers?)\b|\bslow source\b[\s\S]{0,120}\b(?:returned|responded)\b/i
    )
  ) {
    return false;
  }
  return true;
}

function hasReferenceContinuationEvidence(
  artifact: GenericReferenceArtifactShape,
  input: { requiresContinuation: boolean; useful: boolean }
): boolean {
  if (!input.requiresContinuation) return true;
  if (!input.useful) return false;
  const followup = artifact.followup?.summary;
  if (!followup) return false;
  const toolCallCount = readNumber(followup.toolCallCount);
  const toolResultCount = readNumber(followup.toolResultCount);
  if (toolCallCount > 0) return toolResultCount > 0;
  return Boolean(readString(followup.finalText));
}

function isApprovalWaitTimeoutReferenceBaselineLoss(artifact: GenericReferenceArtifactShape): boolean {
  const provenance = artifact.provenance ?? {};
  const driver =
    typeof provenance.referenceScenarioDriver === "object" && provenance.referenceScenarioDriver !== null
      ? provenance.referenceScenarioDriver as Record<string, unknown>
      : {};
  if (readString(driver.approvalDecisionPolicy) !== "wait_timeout") return false;
  if (readString(provenance.exitStatus ?? artifact.exitStatus) !== "timeout") return false;
  if (artifact.timedOut !== true) return false;
  const rawApprovalEvidence = provenance.rawApprovalEvidence ?? artifact.rawApprovalEvidence;
  const rawToolCalls = provenance.rawToolCalls ?? artifact.rawToolCalls;
  const rawToolResults = provenance.rawToolResults ?? artifact.rawToolResults;
  if (!hasObservedPendingApprovalEvidence(rawApprovalEvidence)) return false;
  if (containsReferenceApprovalDecision(rawApprovalEvidence)) return false;
  if (readReferenceToolCallCount(artifact) === 0) return false;
  if (readReferenceToolResultCount(artifact) > 0) return false;
  if (
    containsReferenceTerm(
      [provenance.rawTranscript, artifact.rawTranscript, rawToolCalls, rawToolResults, artifact.first, rawApprovalEvidence],
      /\bpermission\.applied\b|\bpermission_applied\b|\bform submitted successfully\b|\bsubmitted to the page\b|\bsubmission completed\b/i
    )
  ) {
    return false;
  }
  return true;
}

function isApprovalWaitTimeoutReferenceContractViolation(artifact: GenericReferenceArtifactShape): boolean {
  const provenance = artifact.provenance ?? {};
  const driver =
    typeof provenance.referenceScenarioDriver === "object" && provenance.referenceScenarioDriver !== null
      ? provenance.referenceScenarioDriver as Record<string, unknown>
      : {};
  if (readString(driver.approvalDecisionPolicy) !== "wait_timeout") return false;
  if (isApprovalWaitTimeoutReferenceBaselineLoss(artifact)) return false;
  return containsReferenceTerm(
    [
      provenance.rawTranscript,
      artifact.rawTranscript,
      provenance.rawToolResults,
      artifact.rawToolResults,
      artifact.first,
      artifact.score,
    ],
    /\b(?:approved|approval was granted|operator approval received|clicked ["“]?submit|submitted locally after approval|submitted successfully|form submitted successfully|submission completed|dry-run submission (?:completed|complete)|post-submission status)\b/i
  );
}

function hasObservedPendingApprovalEvidence(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasObservedPendingApprovalEvidence(item));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (readString(record.status) === "observed_pending" && hasKnownString(record.approvalId)) return true;
  return Object.values(record).some((item) => hasObservedPendingApprovalEvidence(item));
}

function containsReferenceApprovalDecision(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsReferenceApprovalDecision(item));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.decisionPayload != null) return true;
  const decision = record.decision;
  if (typeof decision === "object" && decision !== null) {
    const decisionRecord = decision as Record<string, unknown>;
    if (hasKnownString(decisionRecord.decision)) return true;
    if (
      typeof decisionRecord.decision === "object" &&
      decisionRecord.decision !== null &&
      hasKnownString((decisionRecord.decision as Record<string, unknown>).decision)
    ) {
      return true;
    }
  }
  return false;
}

function hasKnownString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && !/^(unknown|n\/a|null|undefined)$/i.test(value.trim());
}

function auditReferenceArtifact(input: {
  artifact: GenericReferenceArtifactShape;
  artifactPath: string;
  scenarioPrompt: string;
  referencePrompt: string;
  requiresBrowser: boolean;
}): RealLlmAbReferenceAudit {
  const provenance = input.artifact.provenance ?? {};
  const findings: string[] = [];
  const fixtureUnavailable = isReferenceFixtureUnavailable(input.artifact);
  const requiredProvenanceFields = fixtureUnavailable
    ? REQUIRED_REFERENCE_PROVENANCE_FIELDS.filter((field) => field !== "rawResponse" && field !== "rawTranscript")
    : REQUIRED_REFERENCE_PROVENANCE_FIELDS;
  const missingProvenance = requiredProvenanceFields.filter(
    (field) => !hasReferenceProvenanceValue(input.artifact, provenance, field)
  );
  const notes = readString(input.artifact.notes) ?? "";
  const effectiveMessages = readEffectiveReferenceArtifactMessages(input.artifact, input.artifactPath);
  const transcript = readReferenceTranscript(input.artifact, input.artifactPath, effectiveMessages);
  const approvalDecisionPolicy = readReferenceApprovalDecisionPolicy(input.artifact);
  const transcriptCompletion = effectiveMessages
    ? readReferenceCompletion(effectiveMessages, { approvalDecisionPolicy })
    : readReferenceArtifactCompletion(input.artifact);
  const finalText =
    readLatestAssistantText(effectiveMessages ?? []) ??
    readString(input.artifact.first?.summary?.finalText) ??
    readString(input.artifact.followup?.summary?.finalText);
  const exactRequestPayloadPrompt = readReferenceExactRequestPrompt(provenance.exactRequestPayload);
  const browserEvidenceFailed = hasFailedReferenceBrowserEvidence(input.artifact);
  const rawRuntimeEvidenceFailed =
    hasFailedReferenceRuntimeEvidence(input.artifact) || containsReferenceRuntimeHealthFailure(effectiveMessages);
  const expectedPendingApprovalFinal =
    approvalDecisionPolicy === "pending" && isExpectedPendingApprovalFinal(finalText ?? "");
  const weakFinalText = isWeakReferenceFinalText(finalText) && !expectedPendingApprovalFinal;
  const referenceUseful = input.artifact.score?.useful === true;
  const effectiveToolCalls = effectiveMessages ? dedupeReferenceToolCalls(extractToolCalls(effectiveMessages)) : [];
  const effectiveToolResults = effectiveMessages ? extractToolResults(effectiveMessages) : [];
  const effectiveBrowserEvidence = [
    ...readArray(input.artifact.provenance?.rawBrowserEvidence ?? input.artifact.rawBrowserEvidence),
    ...(effectiveMessages ? extractBrowserEvidenceFromTranscript(effectiveMessages) : []),
  ];
  const evidenceValueMismatches = findEvidenceValueMismatches({
    finalText: finalText ?? "",
    evidenceText: collectReferenceEvidenceText(input.artifact, {
      effectiveMessages,
      effectiveToolResults,
      rawBrowserEvidence: effectiveBrowserEvidence,
    }),
  });
  const toolCallCount = Math.max(readReferenceToolCallCount(input.artifact), effectiveToolCalls.length);
  const toolResultCount = Math.max(readReferenceToolResultCount(input.artifact), effectiveToolResults.length);
  const approvalWaitTimeoutBaselineLoss = isApprovalWaitTimeoutReferenceBaselineLoss(input.artifact);
  const timeoutPartialBaselineLoss = isTimeoutPartialReferenceBaselineLoss(input.artifact);
  const expectedDirectTimeoutCloseout = hasExpectedReferenceDirectTimeoutCloseout(input.artifact, effectiveMessages);
  const toolOrWorkerTriggered = toolCallCount > 0;
  const toolOrWorkerResult = approvalWaitTimeoutBaselineLoss || timeoutPartialBaselineLoss || toolResultCount > 0;
  const sourcePolicyFindings = auditAccioWorkReferenceSourcePolicy(provenance, {
    allowNotRunEndpoint: fixtureUnavailable,
  });
  const unsupportedDriverReason = readUnsupportedReferenceScenarioDriverReason(input.artifact);
  const transcriptCompletionReady =
    approvalWaitTimeoutBaselineLoss ||
    timeoutPartialBaselineLoss ||
    !transcriptCompletion?.finalText ||
    transcriptCompletion.ready;
  const recoveredReferenceRuntime = hasRecoveredReferenceRuntimeEvidence({
    finalText,
    weakFinalText,
    referenceUseful,
    toolOrWorkerResult,
    effectiveBrowserEvidence,
  });
  const runtimeEvidenceFailed =
    rawRuntimeEvidenceFailed &&
    !expectedDirectTimeoutCloseout &&
    !recoveredReferenceRuntime;
  const localhostSourceAccessFailure =
    !expectedDirectTimeoutCloseout &&
    hasUnrecoveredReferenceLocalhostSourceAccessFailure({
      artifact: input.artifact,
      effectiveMessages,
      effectiveBrowserEvidence,
    });
  const pendingToolFinding = describePendingReferenceToolCalls({
    artifact: input.artifact,
    effectiveToolCalls,
    effectiveToolResults,
  });
  const orphanedWorkspaceArtifactFinding = describeOrphanedAccioWorkspaceArtifacts(input.artifact);
  const accioRuntimeFindings = describeAccioWsRuntimeFindings({
    artifact: input.artifact,
    artifactPath: input.artifactPath,
    effectiveMessages,
    expectedDirectTimeoutCloseout,
  });
  const localhostSourceAccessFailureFinding = describeReferenceLocalhostSourceAccessFailure({
    artifact: input.artifact,
    effectiveMessages,
    effectiveBrowserEvidence,
  });

  if (unsupportedDriverReason) {
    findings.push(`reference scenario driver unsupported: ${unsupportedDriverReason}`);
  }
  if (fixtureUnavailable) {
    findings.push(describeReferenceFixtureUnavailable(input.artifact));
  }
  if (!finalText && !approvalWaitTimeoutBaselineLoss && !timeoutPartialBaselineLoss) {
    findings.push("adapter did not capture raw final answer text");
  }
  if (weakFinalText) {
    findings.push("reference final answer contains harness or weak-answer text");
  }
  for (const mismatch of evidenceValueMismatches) {
    findings.push(`reference ${formatEvidenceValueMismatchSignal(mismatch)}`);
  }
  if (!referenceUseful && !approvalWaitTimeoutBaselineLoss && !timeoutPartialBaselineLoss) {
    findings.push("reference final answer is not marked useful");
  }
  if (!toolOrWorkerTriggered) {
    findings.push("reference native tool/worker execution was not observed");
  }
  if (!toolOrWorkerResult) {
    findings.push("reference native tool/worker result was not observed");
    if (pendingToolFinding) {
      findings.push(pendingToolFinding);
    }
  }
  if (orphanedWorkspaceArtifactFinding) {
    findings.push(orphanedWorkspaceArtifactFinding);
  }
  findings.push(...accioRuntimeFindings);
  if (!transcript.ok) {
    findings.push(transcript.reason);
  }
  if (
    transcriptCompletion &&
    transcriptCompletion.finalText &&
    !transcriptCompletion.ready &&
    !approvalWaitTimeoutBaselineLoss &&
    !timeoutPartialBaselineLoss
  ) {
    findings.push("reference transcript still has pending tool calls or intermediate assistant text");
    if (pendingToolFinding) {
      findings.push(pendingToolFinding);
    }
  }
  if (detectReferenceRuntimeHealthFailure(notes)) {
    findings.push("reference runtime health failure detected in notes");
  }
  if (runtimeEvidenceFailed) {
    findings.push("reference runtime health failure detected in raw transcript or worker metadata");
  }
  if (localhostSourceAccessFailure) {
    findings.push("reference localhost source access failed through web_fetch/web_search and no browser fallback evidence was captured");
    if (localhostSourceAccessFailureFinding) {
      findings.push(localhostSourceAccessFailureFinding);
    }
  }
  if (browserEvidenceFailed) {
    findings.push("reference browser evidence reports failed browser history");
  }
  if (normalizePromptForAudit(input.referencePrompt) !== normalizePromptForAudit(input.scenarioPrompt)) {
    findings.push("reference prompt does not match scenario prompt after loopback-port canonicalization");
  }
  if (!exactRequestPayloadPrompt) {
    findings.push("exact request payload does not expose prompt evidence");
  } else if (normalizePromptForAudit(exactRequestPayloadPrompt) !== normalizePromptForAudit(input.scenarioPrompt)) {
    findings.push("exact request payload prompt does not match scenario prompt after loopback-port canonicalization");
  }
  if (input.requiresBrowser && !hasRenderedReferenceBrowserEvidence(input.artifact)) {
    findings.push("reference browser evidence does not include rendered page evidence");
  }
  findings.push(...sourcePolicyFindings);

  const adapterStatus =
    (approvalWaitTimeoutBaselineLoss ||
      timeoutPartialBaselineLoss ||
      (finalText && !weakFinalText && evidenceValueMismatches.length === 0 && referenceUseful && toolOrWorkerResult)) &&
    toolOrWorkerTriggered &&
    transcriptCompletionReady &&
    transcript.ok &&
    sourcePolicyFindings.length === 0 &&
    Boolean(exactRequestPayloadPrompt) &&
    hasReferenceProvenanceValue(input.artifact, provenance, "artifactAdapterMappingSource") &&
    (!input.requiresBrowser || containsRenderedBrowserEvidence(effectiveBrowserEvidence))
      ? "passed"
      : "failed";
  const runtimeHealthStatus =
    !approvalWaitTimeoutBaselineLoss &&
    !timeoutPartialBaselineLoss &&
    (detectReferenceRuntimeHealthFailure(notes) ||
      runtimeEvidenceFailed ||
      (accioRuntimeFindings.length > 0 && !recoveredReferenceRuntime) ||
      fixtureUnavailable ||
      localhostSourceAccessFailure ||
      browserEvidenceFailed ||
      !toolOrWorkerTriggered ||
      !toolOrWorkerResult)
      ? "failed"
      : "passed";
  const fairnessStatus =
    normalizePromptForAudit(input.referencePrompt) === normalizePromptForAudit(input.scenarioPrompt) &&
    (!exactRequestPayloadPrompt ||
      normalizePromptForAudit(exactRequestPayloadPrompt) === normalizePromptForAudit(input.scenarioPrompt))
      ? "passed"
      : "failed";
  return {
    provenanceStatus: missingProvenance.length === 0 && sourcePolicyFindings.length === 0 ? "passed" : "failed",
    runtimeHealthStatus,
    adapterStatus,
    fairnessStatus,
    missingProvenance,
    findings,
  };
}

function isReferenceFixtureUnavailable(artifact: GenericReferenceArtifactShape): boolean {
  const provenance = artifact.provenance ?? {};
  const errorReason = readString(provenance.errorReason ?? artifact.errorReason);
  return Boolean(
    errorReason?.startsWith("reference_fixture_unreachable:") &&
      typeof provenance.exactRequestPayload === "object" &&
      provenance.exactRequestPayload !== null &&
      (provenance.exactRequestPayload as { blockedBeforeSend?: unknown }).blockedBeforeSend === true
  );
}

function describeReferenceFixtureUnavailable(artifact: GenericReferenceArtifactShape): string {
  const provenance = artifact.provenance ?? {};
  const errorReason = readString(provenance.errorReason ?? artifact.errorReason) ?? "reference_fixture_unreachable";
  const probe =
    typeof provenance.loopbackFixtureProbe === "object" && provenance.loopbackFixtureProbe !== null
      ? (provenance.loopbackFixtureProbe as { unreachable?: unknown })
      : null;
  const unreachable = Array.isArray(probe?.unreachable)
    ? probe.unreachable.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const url = readString((item as { url?: unknown }).url);
        const reason = readString((item as { reason?: unknown }).reason);
        return url ? [`${url}${reason ? ` (${reason})` : ""}`] : [];
      })
    : [];
  return unreachable.length > 0
    ? `reference fixture unreachable before Accio request: ${unreachable.join("; ")}`
    : `reference fixture unreachable before Accio request: ${errorReason}`;
}

function readUnsupportedReferenceScenarioDriverReason(artifact: GenericReferenceArtifactShape): string | null {
  const provenance = artifact.provenance ?? {};
  const errorReason = readString(provenance.errorReason ?? artifact.errorReason);
  if (errorReason?.startsWith("unsupported_reference_scenario_driver:")) {
    return errorReason.slice("unsupported_reference_scenario_driver:".length) || "unknown";
  }
  const driver =
    typeof provenance.referenceScenarioDriver === "object" && provenance.referenceScenarioDriver !== null
      ? (provenance.referenceScenarioDriver as Record<string, unknown>)
      : {};
  if (driver.supported === false) {
    return readString(driver.unsupportedReason) ?? readString(driver.kind) ?? "unknown";
  }
  return null;
}

function readReferenceArtifactCompletion(
  artifact: GenericReferenceArtifactShape
): { finalText: string; ready: boolean } | null {
  const messages = readReferenceArtifactMessages(artifact);
  return messages ? readReferenceCompletion(messages) : null;
}

function readEffectiveReferenceArtifactMessages(
  artifact: GenericReferenceArtifactShape,
  artifactPath: string
): unknown[] | null {
  const artifactMessages = readReferenceArtifactMessages(artifact) ?? [];
  const lateMessages = readReferenceSessionMessagesFromFlowEvidence(
    artifact.provenance?.rawFlowEvidence ?? artifact.rawFlowEvidence,
    artifactPath
  );
  const messages = lateMessages.length > artifactMessages.length ? lateMessages : artifactMessages;
  return messages.length > 0 ? messages : null;
}

function readReferenceSessionMessagesFromFlowEvidence(rawFlowEvidence: unknown, artifactPath: string): unknown[] {
  for (const sessionPath of readSessionPaths(rawFlowEvidence)) {
    const resolvedPath = path.isAbsolute(sessionPath) ? sessionPath : path.resolve(path.dirname(artifactPath), sessionPath);
    const messages = readJsonlMessages(resolvedPath);
    if (messages.length > 0) return messages;
  }
  return [];
}

function readSessionPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => readSessionPaths(item));
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const sessionPath = readString(record.sessionPath);
  return [
    ...(sessionPath ? [sessionPath] : []),
    ...Object.entries(record)
      .filter(([key]) => key !== "sessionPath")
      .flatMap(([, item]) => readSessionPaths(item)),
  ];
}

function readJsonlMessages(filePath: string): unknown[] {
  try {
    return readFileSync(filePath, "utf8")
      .split(/\r?\n/g)
      .flatMap((line) => {
        const trimmed = line.trim();
        if (!trimmed) return [];
        try {
          return [JSON.parse(trimmed) as unknown];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function readLatestAssistantText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const record = message as { role?: unknown; content?: unknown };
    if (readString(record.role) !== "assistant") continue;
    const text = readStringFromMessageContent(record.content);
    if (text) return text;
  }
  return null;
}

function extractToolCalls(messages: unknown[]): unknown[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const record = message as { toolCalls?: unknown; tool_calls?: unknown; metadata?: { toolCalls?: unknown } };
    return [...readArray(record.toolCalls), ...readArray(record.tool_calls), ...readArray(record.metadata?.toolCalls)];
  });
}

function extractToolResults(messages: unknown[]): unknown[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const record = message as { role?: unknown; toolResults?: unknown; metadata?: { toolResults?: unknown } };
    return [
      ...(readString(record.role) === "tool" ? [message] : []),
      ...readArray(record.toolResults),
      ...readArray(record.metadata?.toolResults),
    ];
  });
}

function dedupeReferenceToolCalls(toolCalls: unknown[]): unknown[] {
  const seen = new Set<string>();
  const deduped: unknown[] = [];
  for (const call of toolCalls) {
    const key = readReferenceToolCallIdentity(call);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    deduped.push(call);
  }
  return deduped;
}

function dedupeReferenceToolResults(toolResults: unknown[]): unknown[] {
  const seen = new Set<string>();
  const deduped: unknown[] = [];
  for (const result of toolResults) {
    const key = readReferenceToolResultIdentity(result) ?? stringifyForEvidence(result);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

function readReferenceToolCallIdentity(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = readString(record.id) ?? readString(record.toolCallId);
  const name = readReferenceToolName(value);
  if (!id) return name ? `name:${name}` : null;
  return `${id}:${name ?? "unknown"}`;
}

function readReferenceToolName(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return readString(record.name) ?? readString(record.toolName);
}

function extractBrowserEvidenceFromTranscript(messages: unknown[]): unknown[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const record = message as { role?: unknown; name?: unknown; content?: unknown; metadata?: { toolName?: unknown } };
    const toolName = readString(record.name) ?? readString(record.metadata?.toolName);
    if (readString(record.role) !== "tool" || toolName !== "sessions_spawn") return [];
    const content = readString(record.content);
    if (!content || (!/^tool_chain:\s*.*\bbrowser\b/im.test(content) && !/^task_id:\s*.*:sub:browser:/im.test(content))) return [];
    const status = readAccioTextHeader(content, "status") ?? "completed";
    return [
      {
        source: "session_tool_result",
        rendered: /^completed$/i.test(status) && /(screenshot|snapshot|rendered|page title|visible page)/i.test(content),
        status,
        evidenceText: content.slice(0, 4000),
      },
    ];
  });
}

function readAccioTextHeader(content: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
  return readString(match?.[1]);
}

function readReferenceArtifactMessages(artifact: GenericReferenceArtifactShape): unknown[] | null {
  const rawTranscript = artifact.provenance?.rawTranscript ?? artifact.rawTranscript;
  if (Array.isArray(rawTranscript)) return rawTranscript;
  if (typeof rawTranscript === "object" && rawTranscript !== null) {
    const messages = (rawTranscript as { messages?: unknown }).messages;
    if (Array.isArray(messages)) return messages;
  }
  return null;
}

const ACCIO_WORK_REFERENCE_APP = "accio-work-app-asar";
const ACCIO_WORK_APP_ASAR_PATH = "/Applications/Accio.app/Contents/Resources/app.asar";
const ACCIO_WORK_REFERENCE_RUNTIME_FRAGMENT = "artifacts/reference-runtimes/accio-work-0.4.5";
const ACCIO_WORK_REFERENCE_WS_ENDPOINT = "/websocket/connect";
const ACCIO_WORK_REFERENCE_TRANSPORT = "accio-work-websocket-sendQuery";
const ACCIO_WORK_REFERENCE_PROVIDER = "minimax";
const ACCIO_WORK_REFERENCE_MODEL = "MiniMax-M2.7-highspeed";

function auditAccioWorkReferenceSourcePolicy(
  provenance: GenericReferenceProvenanceShape,
  options: { allowNotRunEndpoint?: boolean } = {}
): string[] {
  const findings: string[] = [];
  const referenceApp = readString(provenance.referenceApp);
  const referenceBinary = readString(provenance.referenceBinary);
  const referenceRuntimeRoot = readString(provenance.referenceRuntimeRoot);
  const referenceRepoPath = readString(provenance.referenceRepoPath);
  const referenceRuntimeEvidencePath = referenceRuntimeRoot ?? referenceRepoPath;
  const sourcePaths = [referenceRuntimeRoot, referenceRepoPath].filter((value): value is string => Boolean(value));
  const apiEndpoint = readString(provenance.apiEndpoint);
  const referenceCommit = readString(provenance.referenceCommit);
  const provider = readString(provenance.provider);
  const modelId = readString(provenance.modelId);
  const transport = readExactRequestTransport(provenance.exactRequestPayload);

  if (referenceApp !== ACCIO_WORK_REFERENCE_APP) {
    findings.push(`reference source must be ${ACCIO_WORK_REFERENCE_APP}, got ${referenceApp ?? "missing"}`);
  }
  if (referenceBinary !== ACCIO_WORK_APP_ASAR_PATH) {
    findings.push(`reference binary must be ${ACCIO_WORK_APP_ASAR_PATH}, got ${referenceBinary ?? "missing"}`);
  }
  if (!referenceRuntimeEvidencePath || !isAccioWorkReferenceRuntimePath(referenceRuntimeEvidencePath)) {
    findings.push(
      `reference runtime path must be the persistent Accio runtime under ${ACCIO_WORK_REFERENCE_RUNTIME_FRAGMENT}, got ${referenceRuntimeEvidencePath ?? "missing"}`
    );
  }
  if (sourcePaths.some((sourcePath) => /(?:^|\/)tmp(?:\/|$)/.test(sourcePath))) {
    findings.push("reference runtime path must not be under /tmp");
  }
  if (sourcePaths.some((sourcePath) => /\/Users\/chris\/workspace\/accio(?:\/|$)/.test(sourcePath))) {
    findings.push("reference runtime path must not use deprecated /Users/chris/workspace/accio source");
  }
  if (apiEndpoint !== ACCIO_WORK_REFERENCE_WS_ENDPOINT && !(options.allowNotRunEndpoint && apiEndpoint === "not_run")) {
    findings.push(`reference api endpoint must be ${ACCIO_WORK_REFERENCE_WS_ENDPOINT}, got ${apiEndpoint ?? "missing"}`);
  }
  if (transport !== ACCIO_WORK_REFERENCE_TRANSPORT) {
    findings.push(`reference request transport must be ${ACCIO_WORK_REFERENCE_TRANSPORT}, got ${transport ?? "missing"}`);
  }
  if (provider !== ACCIO_WORK_REFERENCE_PROVIDER) {
    findings.push(`reference provider must be ${ACCIO_WORK_REFERENCE_PROVIDER}, got ${provider ?? "missing"}`);
  }
  if (modelId !== ACCIO_WORK_REFERENCE_MODEL) {
    findings.push(`reference model must be ${ACCIO_WORK_REFERENCE_MODEL}, got ${modelId ?? "missing"}`);
  }
  if (!referenceCommit || !referenceCommit.startsWith("app.asar:")) {
    findings.push(`reference commit must record app.asar sha as app.asar:<sha>, got ${referenceCommit ?? "missing"}`);
  }
  return findings;
}

function isAccioWorkReferenceRuntimePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === ACCIO_WORK_REFERENCE_RUNTIME_FRAGMENT || normalized.endsWith(`/${ACCIO_WORK_REFERENCE_RUNTIME_FRAGMENT}`);
}

function readExactRequestTransport(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  return readString((payload as { transport?: unknown }).transport);
}

const REQUIRED_REFERENCE_PROVENANCE_FIELDS = [
  "referenceApp",
  "referenceBinary",
  "referenceRepoPath",
  "referenceVersion",
  "referenceCommit",
  "daemonUrl",
  "apiEndpoint",
  "modelCatalog",
  "provider",
  "modelId",
  "exactRequestPayload",
  "rawResponse",
  "rawTranscript",
  "rawToolCalls",
  "rawToolResults",
  "rawBrowserEvidence",
  "artifactAdapterMappingSource",
  "collectedAtMs",
  "exitStatus",
  "errorReason",
] as const;

type ReferenceProvenanceField = (typeof REQUIRED_REFERENCE_PROVENANCE_FIELDS)[number];

function hasReferenceProvenanceValue(
  artifact: GenericReferenceArtifactShape,
  provenance: GenericReferenceProvenanceShape,
  field: ReferenceProvenanceField
): boolean {
  const value = readReferenceProvenanceValue(artifact, provenance, field);
  if (Array.isArray(value)) return true;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 && (field === "errorReason" || !isUnknownReferenceProvenanceValue(trimmed));
  }
  return value !== undefined && value !== null;
}

function isUnknownReferenceProvenanceValue(value: string): boolean {
  return /^(unknown|n\/a|null|undefined)$/i.test(value);
}

function readReferenceProvenanceValue(
  artifact: GenericReferenceArtifactShape,
  provenance: GenericReferenceProvenanceShape,
  field: ReferenceProvenanceField
): unknown {
  switch (field) {
    case "rawResponse":
      return provenance.rawResponse ?? artifact.rawResponse;
    case "rawTranscript":
      return provenance.rawTranscript ?? artifact.rawTranscript ?? artifact.transcriptPath;
    case "rawToolCalls":
      return provenance.rawToolCalls ?? artifact.rawToolCalls;
    case "rawToolResults":
      return provenance.rawToolResults ?? artifact.rawToolResults;
    case "rawBrowserEvidence":
      return provenance.rawBrowserEvidence ?? artifact.rawBrowserEvidence;
    case "artifactAdapterMappingSource":
      return provenance.artifactAdapterMappingSource ?? artifact.artifactAdapterMappingSource;
    case "collectedAtMs":
      return provenance.collectedAtMs ?? artifact.collectedAtMs;
    case "exitStatus":
      return provenance.exitStatus ?? artifact.exitStatus;
    case "errorReason":
      return provenance.errorReason ?? artifact.errorReason;
    default:
      return provenance[field];
  }
}

function readReferenceToolCallCount(artifact: GenericReferenceArtifactShape): number {
  const first = artifact.first?.summary;
  const followup = artifact.followup?.summary;
  return (
    countArrayLike(artifact.provenance?.rawToolCalls ?? artifact.rawToolCalls) +
    readNumber(first?.toolCallCount) +
    readNumber(followup?.toolCallCount)
  );
}

function readReferenceToolResultCount(artifact: GenericReferenceArtifactShape): number {
  const first = artifact.first?.summary;
  const followup = artifact.followup?.summary;
  return (
    countArrayLike(artifact.provenance?.rawToolResults ?? artifact.rawToolResults) +
    readNumber(first?.toolResultCount) +
    readNumber(followup?.toolResultCount)
  );
}

function countArrayLike(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function readReferenceTranscript(
  artifact: GenericReferenceArtifactShape,
  artifactPath: string,
  effectiveMessages?: unknown[] | null
): { ok: true } | { ok: false; reason: string } {
  if (effectiveMessages && effectiveMessages.length > 0) {
    return { ok: true };
  }
  if (artifact.provenance?.rawTranscript || artifact.rawTranscript) {
    return { ok: true };
  }
  const transcriptPath = readString(artifact.transcriptPath);
  if (!transcriptPath) {
    return { ok: false, reason: "reference artifact does not include raw transcript evidence" };
  }
  try {
    const resolvedTranscriptPath = path.isAbsolute(transcriptPath)
      ? transcriptPath
      : path.resolve(path.dirname(artifactPath), transcriptPath);
    const transcript = JSON.parse(readFileSync(resolvedTranscriptPath, "utf8")) as unknown;
    if (typeof transcript !== "object" || transcript === null || !Array.isArray((transcript as { messages?: unknown }).messages)) {
      return { ok: false, reason: "reference transcript does not contain messages" };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `reference transcript could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function detectReferenceRuntimeHealthFailure(notes: string): boolean {
  return /blocked explore URL host|blocked host|page\.evaluate|ReferenceError|missing auth|wrong endpoint|Unexpected token '<'|browser worker failed|Explore worker failed|failed to fetch|network_error|can't reach (?:those )?URLs?|localhost addresses? .*only accessible|external infrastructure/i.test(notes);
}

function normalizePromptForAudit(prompt: unknown): string {
  if (typeof prompt !== "string") return "";
  return prompt
    .replace(/\b(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])):\d+/gi, "$1:<loopback-port>")
    .replace(/\s+/g, " ")
    .trim();
}

function inferReferenceDimensionScores(input: {
  useful: boolean;
  toolCallCount: number;
  toolResultCount: number;
  requiresBrowser: boolean;
  requiresApproval: boolean;
  requiresContinuation: boolean;
  continuationSatisfied: boolean;
  requiresTimeoutCloseout: boolean;
}): Record<RealLlmAbDimensionKey, RealLlmAbDimensionScore> {
  const usefulScore: RealLlmAbDimensionScore = input.useful ? 2 : 0;
  return {
    taskCompletion: usefulScore,
    evidenceQuality: input.useful && input.toolResultCount > 0 ? 2 : 0,
    toolUseAppropriateness: input.toolCallCount > 0 && input.toolResultCount > 0 ? 2 : 0,
    browserAuthenticity: input.requiresBrowser ? (input.useful && input.toolResultCount > 0 ? 2 : 0) : 2,
    subAgentIndependence: input.toolResultCount > 0 ? 2 : 0,
    continuationBehavior: input.requiresContinuation ? (input.continuationSatisfied ? 2 : 0) : 2,
    permissionCorrectness: input.requiresApproval ? usefulScore : 2,
    timeoutCloseoutQuality: input.requiresTimeoutCloseout ? usefulScore : 2,
    finalAnswerUsefulness: usefulScore,
  };
}

function readTurnkeyAiDimensionScores(
  scenario: NaturalMissionScenarioShape
): Record<RealLlmAbDimensionKey, RealLlmAbDimensionScore> {
  const source =
    typeof scenario.natural?.dimensionScores === "object" && scenario.natural.dimensionScores !== null
      ? (scenario.natural.dimensionScores as Record<string, unknown>)
      : {};
  const scores = Object.fromEntries(
    REAL_LLM_AB_DIMENSION_KEYS.map((key) => {
      if (key === "finalAnswerUsefulness") {
        return [key, scenario.natural?.finalAnswerUseful === true ? 2 : 0];
      }
      return [key, readDimensionScore(source[key])];
    })
  ) as Record<RealLlmAbDimensionKey, RealLlmAbDimensionScore>;
  return scores;
}

interface EvidenceValueMismatch {
  label: string;
  evidenceValues: string[];
  finalValues: string[];
}

const TRACKED_EVIDENCE_VALUE_LABELS: Array<{ label: string; pattern: RegExp; allowPercent?: boolean }> = [
  { label: "Stuck missions", pattern: /\bStuck missions?\b/i },
  { label: "Weak answer rate", pattern: /\bWeak answer rate\b/i, allowPercent: true },
  { label: "Queue depth", pattern: /\bQueue depth\b/i },
  { label: "SLA breaches", pattern: /\bSLA breaches?\b/i },
];

function downgradeTurnkeyAiDimensionScoresForEvidenceMismatches(
  scores: Record<RealLlmAbDimensionKey, RealLlmAbDimensionScore>,
  mismatches: readonly EvidenceValueMismatch[]
): Record<RealLlmAbDimensionKey, RealLlmAbDimensionScore> {
  if (mismatches.length === 0) return scores;
  return {
    ...scores,
    taskCompletion: 0,
    evidenceQuality: 0,
    finalAnswerUsefulness: 0,
  };
}

function findEvidenceValueMismatches(input: { finalText: string; evidenceText: string }): EvidenceValueMismatch[] {
  if (!input.finalText || !input.evidenceText) return [];
  return TRACKED_EVIDENCE_VALUE_LABELS.flatMap(({ label, pattern, allowPercent }) => {
    const evidenceValues = collectLabelValues(input.evidenceText, pattern, { allowPercent: allowPercent === true });
    const finalValues = collectLabelValues(input.finalText, pattern, { allowPercent: allowPercent === true });
    if (evidenceValues.length === 0 || finalValues.length === 0) return [];
    const overlap = finalValues.some((value) => evidenceValues.includes(value));
    return overlap ? [] : [{ label, evidenceValues, finalValues }];
  });
}

function formatEvidenceValueMismatchSignal(mismatch: EvidenceValueMismatch): string {
  return `evidence value mismatch: ${mismatch.label} final=${mismatch.finalValues.join("/")} evidence=${mismatch.evidenceValues.join("/")}`;
}

function collectLabelValues(text: string, labelPattern: RegExp, options: { allowPercent: boolean }): string[] {
  const values = new Set<string>();
  const afterLabel = new RegExp(`${labelPattern.source}[^\\n\\r]{0,48}?(-?\\d+(?:\\.\\d+)?\\s*%?)`, "gi");
  const beforeLabel = new RegExp(`(-?\\d+(?:\\.\\d+)?\\s*?%?)[^\\n\\r]{0,48}?${labelPattern.source}`, "gi");
  for (const pattern of [afterLabel, beforeLabel]) {
    for (const match of text.matchAll(pattern)) {
      const value = normalizeTrackedNumber(match[1]);
      if (value?.endsWith("%") && !options.allowPercent) continue;
      if (value) values.add(value);
    }
  }
  return [...values].sort();
}

function normalizeTrackedNumber(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\s+/g, "").trim();
  if (!/^-?\d+(?:\.\d+)?%?$/.test(trimmed)) return null;
  return trimmed;
}

function readTurnkeyAiFinalText(scenario: NaturalMissionScenarioShape): string {
  return [
    readString(scenario.final?.text),
    readString(scenario.final?.excerpt),
    readString(readRecordValue(readRecordValue(scenario, "evidenceReplay"), "finalText")),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function collectTurnkeyAiEvidenceText(scenario: NaturalMissionScenarioShape): string {
  const record = scenario as unknown as Record<string, unknown>;
  const evidenceReplay = readRecord(record.evidenceReplay);
  const evidenceReplayTimeline = readRecord(evidenceReplay?.timeline)?.entries;
  return [
    stringifyForEvidence(record.runtimeEvidence),
    stringifyForEvidence(record.toolEvents),
    stringifyForEvidence(record.timelineEvents),
    stringifyForEvidence(record.missionQualityGate),
    stringifyForEvidence(record.qualityGate),
    stringifyForEvidence(scenario.metrics?.qualityChecks),
    stringifyForEvidence(filterEvidenceReplayTimelineEntries(evidenceReplayTimeline)),
  ].join("\n");
}

function collectReferenceEvidenceText(
  artifact: GenericReferenceArtifactShape,
  input: {
    effectiveMessages: unknown[] | null;
    effectiveToolResults: unknown[];
    rawBrowserEvidence: unknown[];
  }
): string {
  return [
    stringifyForEvidence(artifact.provenance?.rawToolResults ?? artifact.rawToolResults),
    stringifyForEvidence(artifact.provenance?.rawBrowserEvidence ?? artifact.rawBrowserEvidence),
    stringifyForEvidence(artifact.provenance?.rawApprovalEvidence ?? artifact.rawApprovalEvidence),
    stringifyForEvidence(artifact.provenance?.rawFlowEvidence ?? artifact.rawFlowEvidence),
    stringifyForEvidence(input.effectiveToolResults),
    stringifyForEvidence(input.rawBrowserEvidence),
    stringifyForEvidence(extractToolResultMessages(input.effectiveMessages ?? [])),
  ].join("\n");
}

function extractToolResultMessages(messages: unknown[]): unknown[] {
  return messages.filter((message) => {
    const record = readRecord(message);
    if (!record) return false;
    return readString(record.role) === "tool" || readString(record.messageType) === "tool_result";
  });
}

function filterEvidenceReplayTimelineEntries(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => {
    const record = readRecord(entry);
    if (!record) return false;
    const kind = readString(record.kind);
    const tags = readStringArray(record.tags);
    if (kind === "browser" || kind === "tool" || kind === "approval" || kind === "recovery") return true;
    if (tags.some((tag) => /^(browser|tool|tool-call|tool-result|approval|recovery)$/i.test(tag))) return true;
    return false;
  });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readRecordValue(value: unknown, key: string): unknown {
  return readRecord(value)?.[key];
}

function readTurnkeyAiWeakAnswerSignals(
  scenario: NaturalMissionScenarioShape,
  browserFailureBuckets: readonly string[]
): string[] {
  let signals = readStringArray(scenario.natural?.weakAnswerSignals);
  if (
    browserFailureBuckets.length > 0 &&
    scenario.natural?.finalAnswerUseful === true &&
    scenario.natural?.finalAnswerHasEvidence === true &&
    scenario.natural?.sourceCoverage?.residualRiskVisible === true
  ) {
    signals = signals.filter((signal) => signal !== "tool unavailable fallback");
  }
  if (
    browserFailureBuckets.length > 0 &&
    scenario.natural?.finalAnswerUseful === true &&
    scenario.natural?.finalAnswerHasEvidence === true &&
    scenario.natural?.sourceCoverage?.residualRiskVisible === true &&
    readDimensionScore((scenario.natural?.dimensionScores as Record<string, unknown> | undefined)?.browserAuthenticity) === 2 &&
    readNumber(scenario.metrics?.evidenceEvents) > 0 &&
    readStringArray(scenario.natural?.failureBuckets).length === 0
  ) {
    signals = signals.filter((signal) => signal !== "browser transport degraded");
  }
  if (
    readString(scenario.scenario) === "natural-tool-result-pruning" &&
    scenario.natural?.browserUsed === true &&
    scenario.natural?.finalAnswerUseful === true &&
    scenario.natural?.finalAnswerHasEvidence === true &&
    scenario.natural?.sourceCoverage?.residualRiskVisible === true &&
    readDimensionScore((scenario.natural?.dimensionScores as Record<string, unknown> | undefined)?.browserAuthenticity) === 2 &&
    readNumber(scenario.metrics?.evidenceEvents) > 0
  ) {
    signals = signals.filter((signal) => signal !== "browser transport degraded");
  }
  return signals;
}

function readBrowserFailureBucketNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const bucket = readString((item as { bucket?: unknown }).bucket);
    return bucket ? [bucket] : [];
  });
}

function findNaturalScenario(report: NaturalMissionReportShape, scenarioId: string): NaturalMissionScenarioShape {
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios : [];
  const match = scenarios.find(
    (scenario): scenario is NaturalMissionScenarioShape =>
      typeof scenario === "object" &&
      scenario !== null &&
      readString((scenario as NaturalMissionScenarioShape).scenario) === scenarioId
  );
  if (!match) {
    throw new Error(`natural report is missing scenario ${scenarioId}`);
  }
  return match;
}

function countArtifacts(value: unknown, kind: string): number {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const summary = value as { count?: unknown; kinds?: unknown };
    const kinds = readStringArray(summary.kinds);
    if (kinds.includes(kind)) {
      return readNumber(summary.count) > 0 ? 1 : 0;
    }
    return 0;
  }
  if (!Array.isArray(value)) return 0;
  return value.filter((item) => typeof item === "object" && item !== null && readString((item as { kind?: unknown }).kind) === kind)
    .length;
}

function readNaturalMissionReport(filePath: string, cache: Map<string, NaturalMissionReportShape>): NaturalMissionReportShape {
  const cached = cache.get(filePath);
  if (cached) return cached;
  const report = readJsonFile<NaturalMissionReportShape>(filePath);
  if (report.kind !== "turnkeyai.natural-mission-e2e.report" || !Array.isArray(report.scenarios)) {
    throw new Error(`turnkeyaiNaturalReportPath does not point to a natural mission E2E report: ${filePath}`);
  }
  cache.set(filePath, report);
  return report;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function resolveInputPath(filePath: string, baseDir: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
}

function readValue(args: string[], index: number, arg: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${arg}`);
  }
  return value;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : [])) : [];
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringifyForEvidence(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

function readReferencePrompt(artifact: GenericReferenceArtifactShape): string | null {
  return (
    readString(artifact.prompt) ??
    readString(artifact.userPrompt) ??
    readString(artifact.input?.prompt) ??
    readString(artifact.request?.prompt)
  );
}

function readReferenceExactRequestPrompt(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as {
    prompt?: unknown;
    content?: unknown;
    title?: unknown;
    userPrompt?: unknown;
    input?: { prompt?: unknown };
    request?: { prompt?: unknown };
    messages?: unknown;
  };
  const directPrompt =
    readString(record.prompt) ??
    readString(record.content) ??
    readString(record.title) ??
    readString(record.userPrompt) ??
    readString(record.input?.prompt) ??
    readString(record.request?.prompt);
  if (directPrompt) return directPrompt;
  if (!Array.isArray(record.messages)) return null;
  const userMessages = record.messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const candidate = message as { role?: unknown; content?: unknown };
    if (readString(candidate.role) !== "user") return [];
    return readStringFromMessageContent(candidate.content) ?? [];
  });
  return userMessages.length > 0 ? userMessages.join("\n") : null;
}

function hasRenderedReferenceBrowserEvidence(artifact: GenericReferenceArtifactShape): boolean {
  const evidence = artifact.provenance?.rawBrowserEvidence ?? artifact.rawBrowserEvidence;
  return containsRenderedBrowserEvidence(evidence);
}

function hasFailedReferenceBrowserEvidence(artifact: GenericReferenceArtifactShape): boolean {
  const evidence = artifact.provenance?.rawBrowserEvidence ?? artifact.rawBrowserEvidence;
  return containsFailedBrowserEvidence(evidence);
}

function hasFailedReferenceRuntimeEvidence(artifact: GenericReferenceArtifactShape): boolean {
  return containsReferenceRuntimeHealthFailure([
    artifact.provenance?.rawTranscript,
    artifact.rawTranscript,
    artifact.rawResponse,
    artifact.rawToolCalls,
    artifact.rawToolResults,
  ]);
}

function hasRecoveredReferenceRuntimeEvidence(input: {
  finalText: string;
  weakFinalText: boolean;
  referenceUseful: boolean;
  toolOrWorkerResult: boolean;
  effectiveBrowserEvidence: unknown[];
}): boolean {
  return (
    Boolean(input.finalText) &&
    !input.weakFinalText &&
    input.referenceUseful &&
    input.toolOrWorkerResult &&
    containsCompletedBrowserEvidence(input.effectiveBrowserEvidence)
  );
}

function hasUnrecoveredReferenceLocalhostSourceAccessFailure(input: {
  artifact: GenericReferenceArtifactShape;
  effectiveMessages?: unknown[] | null;
  effectiveBrowserEvidence: unknown[];
}): boolean {
  if (containsCompletedBrowserEvidence(input.effectiveBrowserEvidence)) return false;
  return containsReferenceLocalhostSourceAccessFailure([
    input.artifact.provenance?.rawTranscript,
    input.artifact.rawTranscript,
    input.artifact.rawToolCalls,
    input.artifact.rawToolResults,
    input.effectiveMessages,
  ]);
}

function describePendingReferenceToolCalls(input: {
  artifact: GenericReferenceArtifactShape;
  effectiveToolCalls: unknown[];
  effectiveToolResults: unknown[];
}): string | null {
  const allCalls = dedupeReferenceToolCalls([
    ...input.effectiveToolCalls,
    ...readArray(input.artifact.provenance?.rawToolCalls ?? input.artifact.rawToolCalls),
  ]);
  const allResults = dedupeReferenceToolResults([
    ...input.effectiveToolResults,
    ...readArray(input.artifact.provenance?.rawToolResults ?? input.artifact.rawToolResults),
  ]);
  const pendingSummaryCount =
    readNumber(input.artifact.first?.summary?.pendingToolCount) +
    readNumber(input.artifact.followup?.summary?.pendingToolCount);
  const pendingCalls = findPendingReferenceToolCalls(allCalls, allResults);
  const pendingCount = Math.max(pendingSummaryCount, pendingCalls.length);
  if (pendingCount === 0) return null;

  const callLabels = pendingCalls
    .slice(0, 4)
    .map(formatReferenceToolCallLabel)
    .filter(Boolean);
  const label = callLabels.length > 0 ? `: ${callLabels.join(", ")}` : "";
  return `reference pending tool detail: pending=${pendingCount}, calls=${allCalls.length}, results=${allResults.length}${label}`;
}

function describeOrphanedAccioWorkspaceArtifacts(artifact: GenericReferenceArtifactShape): string | null {
  const artifacts = collectOrphanedAccioWorkspaceArtifacts(artifact);
  if (artifacts.length === 0) return null;
  const labels = artifacts
    .slice(0, 4)
    .map((item) => {
      const relativePath = readString(item.relativePath) ?? readString(item.path) ?? "unknown";
      const kind = readString(item.kind) ?? "artifact";
      const sizeBytes = readNumber(item.sizeBytes);
      return `${kind}:${relativePath}${sizeBytes > 0 ? `:${sizeBytes}b` : ""}`;
    })
    .join(", ");
  return `reference Accio workspace artifact orphaned from transcript: count=${artifacts.length}${labels ? ` ${labels}` : ""}`;
}

function collectOrphanedAccioWorkspaceArtifacts(artifact: GenericReferenceArtifactShape): Array<Record<string, unknown>> {
  return readArray(artifact.provenance?.rawFlowEvidence ?? artifact.rawFlowEvidence).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (readString(record.source) !== "accio_ws_workspace_artifact_after_prompt") return [];
    if (readString(record.status) !== "orphaned_workspace_artifact") return [];
    return [record];
  });
}

function describeAccioWsRuntimeFindings(input: {
  artifact: GenericReferenceArtifactShape;
  artifactPath: string;
  effectiveMessages?: unknown[] | null;
  expectedDirectTimeoutCloseout?: boolean;
}): string[] {
  const successfulDirectFetchFallback = hasSuccessfulReferenceWebFetchResult(input.artifact);
  const text = [
    stringifyForEvidence(input.effectiveMessages),
    ...readAccioSdkLogLinesFromFlowEvidence(
      input.artifact.provenance?.rawFlowEvidence ?? input.artifact.rawFlowEvidence,
      input.artifactPath
    ),
  ].join("\n");
  const findings: string[] = [];
  const timeoutMatch =
    text.match(/\bSubAgent timed out after\s+(\d+)s\b/i) ??
    text.match(/\bSubAgent\s+\w+\s+soft timeout after\s+(\d+)s\b/i);
  if (timeoutMatch) {
    const seconds = timeoutMatch[1] ?? "unknown";
    findings.push(`reference Accio browser sub-agent exceeded native timeout before usable closeout: ${seconds}s`);
  }
  if (/\bUnknown browser action:\s*wait\b/i.test(text)) {
    findings.push("reference Accio browser worker attempted unsupported browser action: wait");
  }
  if (/\bscriptPath read failed\b/i.test(text)) {
    findings.push("reference Accio browser worker attempted console script before writing a readable scriptPath");
  }
  if (/\bCDN upload failed\b/i.test(text)) {
    findings.push("reference Accio image handoff failed because screenshot CDN upload failed");
  }
  if (
    !input.expectedDirectTimeoutCloseout &&
    !successfulDirectFetchFallback &&
    /\bWebSearch proxy requires auth token\b|\bYOU\.COM API\b/i.test(text)
  ) {
    findings.push("reference Accio web_fetch fallback for loopback URL went through external search proxy and failed auth");
  }
  if (/Accessing ['"]\/tmp\//i.test(text) || /\bfile_path["']?\s*:\s*["']\/tmp\//i.test(text) || /\bdelivery_path:\s*\/tmp\b/i.test(text)) {
    findings.push("reference Accio browser worker attempted /tmp delivery outside the configured persistent workspace");
  }
  if (/\bpermission\.query\b/i.test(text) && /\bBroadcast channel\.permission\.query to 0 desktop clients\b/i.test(text)) {
    findings.push("reference Accio permission query had no desktop client to answer, leaving worker progress unobservable");
  }
  if (/Channel adapter not found:\s*reference-collector/i.test(text)) {
    findings.push("reference Accio channel adapter was missing for reference-collector permission routing");
  }
  return [...new Set(findings)];
}

function readAccioSdkLogLinesFromFlowEvidence(rawFlowEvidence: unknown, artifactPath: string): string[] {
  return collectAccioSdkLogRefs(rawFlowEvidence).flatMap((ref) => {
    const resolvedPath = path.isAbsolute(ref.sdkLogPath)
      ? ref.sdkLogPath
      : path.resolve(path.dirname(artifactPath), ref.sdkLogPath);
    return readAccioSdkLogLines(resolvedPath, ref.conversationId);
  });
}

function collectAccioSdkLogRefs(value: unknown): Array<{ sdkLogPath: string; conversationId: string | null }> {
  if (Array.isArray(value)) return value.flatMap((item) => collectAccioSdkLogRefs(item));
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const source = readString(record.source);
  const sdkLogPath = readString(record.sdkLogPath);
  const conversationId = readString(record.conversationId);
  const accioHome = readString(record.accioHome);
  const current =
    source === "accio_ws_sdk_log" && sdkLogPath
      ? [{ sdkLogPath, conversationId }]
      : source === "accio_ws_session_file" && accioHome
        ? [{ sdkLogPath: path.join(accioHome, "logs", "sdk.log"), conversationId }]
      : [];
  return [
    ...current,
    ...Object.entries(record)
      .filter(([key]) => key !== "sdkLogPath")
      .flatMap(([, item]) => collectAccioSdkLogRefs(item)),
  ];
}

function readAccioSdkLogLines(filePath: string, conversationId: string | null): string[] {
  try {
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/g);
    return lines
      .filter((line) => line.trim())
      .filter((line) => !conversationId || line.includes(conversationId))
      .slice(-240);
  } catch {
    return [];
  }
}

function findPendingReferenceToolCalls(toolCalls: unknown[], toolResults: unknown[]): unknown[] {
  const resultKeys = new Set<string>();
  const unkeyedResultNames = new Map<string, number>();
  for (const result of toolResults) {
    const key = readReferenceToolResultIdentity(result);
    if (key) resultKeys.add(key);
    const name = readReferenceToolName(result);
    if (!hasReferenceToolResultId(result) && name) {
      unkeyedResultNames.set(name, (unkeyedResultNames.get(name) ?? 0) + 1);
    }
  }

  const pending: unknown[] = [];
  for (const call of toolCalls) {
    const key = readReferenceToolCallIdentity(call);
    if (key && resultKeys.has(key)) continue;
    const name = readReferenceToolName(call);
    if (name) {
      const remaining = unkeyedResultNames.get(name) ?? 0;
      if (remaining > 0) {
        unkeyedResultNames.set(name, remaining - 1);
        continue;
      }
    }
    pending.push(call);
  }
  return pending;
}

function hasReferenceToolResultId(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Boolean(readString(record.toolCallId) ?? readString(record.tool_call_id) ?? readString(record.id));
}

function readReferenceToolResultIdentity(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = readString(record.toolCallId) ?? readString(record.tool_call_id) ?? readString(record.id);
  const name = readReferenceToolName(value);
  if (!id) return name ? `name:${name}` : null;
  return `${id}:${name ?? "unknown"}`;
}

function formatReferenceToolCallLabel(value: unknown): string {
  const name = readReferenceToolName(value) ?? "unknown";
  const agentId = readReferenceToolCallAgentId(value);
  return agentId ? `${name}(${agentId})` : name;
}

function readReferenceToolCallAgentId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const args =
    typeof record.arguments === "object" && record.arguments !== null
      ? (record.arguments as Record<string, unknown>)
      : typeof record.args === "object" && record.args !== null
        ? (record.args as Record<string, unknown>)
        : null;
  return readString(args?.agent_id) ?? readString(args?.agentId) ?? readString(record.agent_id) ?? readString(record.agentId);
}

function describeReferenceLocalhostSourceAccessFailure(input: {
  artifact: GenericReferenceArtifactShape;
  effectiveMessages?: unknown[] | null;
  effectiveBrowserEvidence: unknown[];
}): string | null {
  if (containsRenderedBrowserEvidence(input.effectiveBrowserEvidence)) return null;
  const detail = collectReferenceLocalhostSourceAccessFailureDetails([
    input.artifact.provenance?.rawTranscript,
    input.artifact.rawTranscript,
    input.artifact.rawToolCalls,
    input.artifact.rawToolResults,
    input.effectiveMessages,
  ]);
  if (detail.toolNames.size === 0 && detail.failureHints.size === 0) return null;
  const tools = [...detail.toolNames].sort().join("/");
  const hints = [...detail.failureHints].sort().join(", ");
  const urls = [...detail.loopbackUrls].sort().slice(0, 3).join(", ");
  return [
    "reference localhost failure detail:",
    tools ? `tools=${tools}` : null,
    hints ? `failure=${hints}` : null,
    urls ? `urls=${urls}` : null,
    "rendered_browser_recovery=missing",
  ]
    .filter(Boolean)
    .join(" ");
}

function collectReferenceLocalhostSourceAccessFailureDetails(
  value: unknown,
  detail: { toolNames: Set<string>; failureHints: Set<string>; loopbackUrls: Set<string> } = {
    toolNames: new Set<string>(),
    failureHints: new Set<string>(),
    loopbackUrls: new Set<string>(),
  }
): { toolNames: Set<string>; failureHints: Set<string>; loopbackUrls: Set<string> } {
  if (typeof value === "string") {
    if (containsReferenceLocalhostSourceAccessFailure(value)) {
      collectLoopbackUrls(value, detail.loopbackUrls);
      collectLocalhostFailureHints(value, detail.failureHints);
    }
    return detail;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferenceLocalhostSourceAccessFailureDetails(item, detail);
    return detail;
  }
  if (typeof value !== "object" || value === null) return detail;
  const record = value as Record<string, unknown>;
  const text = stringifyForEvidence(record);
  if (containsReferenceLocalhostSourceAccessFailure(record)) {
    const name = readReferenceToolName(record);
    if (name) detail.toolNames.add(name);
    collectLoopbackUrls(text, detail.loopbackUrls);
    collectLocalhostFailureHints(text, detail.failureHints);
  }
  for (const key of ["content", "error", "failure", "fallbackReason", "lastResult", "metadata", "messages", "arguments", "args"]) {
    collectReferenceLocalhostSourceAccessFailureDetails(record[key], detail);
  }
  return detail;
}

function collectLoopbackUrls(text: string, out: Set<string>): void {
  for (const match of text.matchAll(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s`"'\\)\]}]*/gi)) {
    out.add(match[0]);
  }
}

function collectLocalhostFailureHints(text: string, out: Set<string>): void {
  if (/\bYOU\.COM API|WebSearch proxy\b/i.test(text)) out.add("you.com_proxy");
  if (/\brequires auth(?: token)?|auth token\b/i.test(text)) out.add("auth_token_required");
  if (/\bnetwork_error\b/i.test(text)) out.add("network_error");
  if (/\bfailed to fetch\b/i.test(text)) out.add("failed_to_fetch");
}

function hasNonEmptyEvidence(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return Boolean(readString(value));
}

function containsReferenceTerm(value: unknown, pattern: RegExp): boolean {
  return pattern.test(stringifyForEvidence(value));
}

function containsReferenceRuntimeHealthFailure(value: unknown): boolean {
  if (typeof value === "string") return detectReferenceRuntimeHealthFailure(value);
  if (Array.isArray(value)) return value.some((item) => containsReferenceRuntimeHealthFailure(item));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const status = readString(record.status);
  if (status === "failed" || status === "error") return true;
  for (const key of ["content", "error", "failure", "fallbackReason", "lastResult", "metadata", "messages", "workerPayload", "workerState"]) {
    if (containsReferenceRuntimeHealthFailure(record[key])) return true;
  }
  return false;
}

function containsReferenceLocalhostSourceAccessFailure(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      /\b(?:network_error|WebSearch proxy|proxy requires auth|requires auth token|failed to fetch)\b/i.test(
        value
      ) && /\b(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?|localhost|127\.0\.0\.1)\b/i.test(value)
    );
  }
  if (Array.isArray(value)) return value.some((item) => containsReferenceLocalhostSourceAccessFailure(item));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const name = readString(record.name ?? record.toolName ?? record.tool_name);
  const status = readString(record.status);
  if (name && /^(web_fetch|web_search)$/i.test(name) && isSuccessfulReferenceToolResultRecord(record)) {
    return false;
  }
  const text = stringifyForEvidence(record);
  if (
    name &&
    /^(web_fetch|web_search)$/i.test(name) &&
    (status === "failed" || /\b(?:network_error|WebSearch proxy|proxy requires auth|requires auth token|failed to fetch)\b/i.test(text)) &&
    /\b(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?|localhost|127\.0\.0\.1)\b/i.test(text)
  ) {
    return true;
  }
  for (const key of ["content", "error", "failure", "fallbackReason", "lastResult", "metadata", "messages", "arguments", "args"]) {
    if (containsReferenceLocalhostSourceAccessFailure(record[key])) return true;
  }
  return false;
}

function hasSuccessfulReferenceWebFetchResult(artifact: GenericReferenceArtifactShape): boolean {
  return [
    ...readArray(artifact.provenance?.rawToolResults),
    ...readArray(artifact.rawToolResults),
    ...readArray(artifact.rawTranscript),
  ].some((item) => {
    if (typeof item !== "object" || item === null) return false;
    const record = item as Record<string, unknown>;
    const name = readString(record.name ?? record.toolName ?? record.tool_name);
    if (!name || !/^web_fetch$/i.test(name)) return false;
    return isSuccessfulReferenceToolResultRecord(record);
  });
}

function hasExpectedReferenceDirectTimeoutCloseout(
  artifact: GenericReferenceArtifactShape,
  effectiveMessages?: unknown[] | null
): boolean {
  const provenance = artifact.provenance ?? {};
  const driver =
    typeof provenance.referenceScenarioDriver === "object" && provenance.referenceScenarioDriver !== null
      ? (provenance.referenceScenarioDriver as Record<string, unknown>)
      : {};
  const driverKind = readString(driver.kind);
  const prompt = [readReferencePrompt(artifact), readString(provenance.referencePrompt)]
    .filter(Boolean)
    .join("\n");
  if (
    driverKind !== "timeout_followup" &&
    driverKind !== "timeout_partial" &&
    !(
      /\bslow source\b/i.test(prompt) &&
      /\bbounded attempt\b/i.test(prompt) &&
      /\b(?:timeout|does not return in time|does not respond|no response)\b/i.test(prompt)
    )
  ) {
    return false;
  }
  const evidenceText = stringifyForEvidence([
    artifact.provenance?.rawToolResults,
    artifact.rawToolResults,
    artifact.provenance?.rawTranscript,
    artifact.rawTranscript,
    effectiveMessages,
    artifact.first,
    artifact.followup,
  ]);
  return (
    /\bDirect fetch failed\b/i.test(evidenceText) &&
    /\b(?:operation was aborted due to timeout|aborted due to timeout|timed out|timeout)\b/i.test(evidenceText) &&
    /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/slow-fixture\b/i.test(evidenceText)
  );
}

function isSuccessfulReferenceToolResultRecord(record: Record<string, unknown>): boolean {
  const status = readString(record.status);
  const metadata = typeof record.metadata === "object" && record.metadata !== null ? (record.metadata as Record<string, unknown>) : {};
  const isError =
    record.isError === true ||
    record.is_error === true ||
    metadata.isError === true ||
    metadata.is_error === true ||
    status === "failed" ||
    status === "error";
  if (isError) return false;
  const content = readString(record.content);
  return Boolean(content && content.trim());
}

function containsFailedBrowserEvidence(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsFailedBrowserEvidence(item));
  }
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (readString(record.status) === "failed") return true;
  for (const key of ["history", "entries", "actions", "sessions"]) {
    if (containsFailedBrowserEvidence(record[key])) return true;
  }
  return false;
}

function containsRenderedBrowserEvidence(value: unknown): boolean {
  if (typeof value === "string") {
    return /(rendered|screenshot|snapshot|page title|visible page|browser page)/i.test(value) && value.trim().length > 20;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsRenderedBrowserEvidence(item));
  }
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.rendered === true) return true;
  for (const key of ["pageSnapshot", "snapshot", "screenshot", "title", "text", "html", "history"]) {
    if (containsRenderedBrowserEvidence(record[key])) return true;
  }
  return false;
}

function containsCompletedBrowserEvidence(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsCompletedBrowserEvidence(item));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.rendered === true) return true;
  const source = readString(record.source);
  const status = readString(record.status);
  if (source === "session_tool_result" && /^completed$/i.test(status ?? "")) {
    return true;
  }
  for (const key of ["pageSnapshot", "snapshot", "screenshot", "title", "text", "html", "history"]) {
    if (containsCompletedBrowserEvidence(record[key])) return true;
  }
  return false;
}

function isWeakReferenceFinalText(text: string | null): boolean {
  return Boolean(
    text &&
      /暂时无法|无法返回|待确认|估算|没有足够|cannot access|unable to access|neither source page could be accessed|source pages? could not be accessed|without the source content|cannot produce (?:a|the) comparison|not enough information|no executable results?|could not process the task|without live network access|localhost is inaccessible|localhost addresses? .*only accessible|external infrastructure|can't reach (?:those )?URLs?|operating as|use the browser worker|close the flow with|please consolidate this update/i.test(
        text
      )
  );
}

function readStringFromMessageContent(content: unknown): string | null {
  if (typeof content === "string") return readString(content);
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const record = part as { type?: unknown; text?: unknown };
    const type = readString(record.type);
    if (type && type !== "text") return [];
    const text = readString(record.text);
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

function readDimensionScore(value: unknown): RealLlmAbDimensionScore {
  return value === 0 || value === 1 || value === 2 ? value : 0;
}

function mapNaturalFailureBuckets(value: unknown): RealLlmAbRootCauseBucket[] {
  const mapped = readStringArray(value).flatMap((bucket): RealLlmAbRootCauseBucket[] => {
    switch (bucket) {
      case "runtime_lifecycle":
      case "sub_agent_runtime":
        return ["sub_agent_runtime"];
      case "tool_selection":
        return ["tool_selection"];
      case "browser_reliability":
        return ["browser_reliability"];
      case "continuation":
      case "timeout_closeout":
        return ["timeout_cancel_continue"];
      case "permission":
        return ["permission_flow"];
      case "answer_quality":
        return ["final_answer_quality"];
      default:
        return ["acceptance_harness"];
    }
  });
  return [...new Set(mapped)].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRealLlmAbReportBuildCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
