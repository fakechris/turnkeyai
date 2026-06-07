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

export interface RealLlmAbReportBuildOptions {
  specPath: string;
  outPath: string;
  check: boolean;
  requiredSuite?: RealLlmAbRequiredSuite;
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
  let requiredSuite: RealLlmAbRequiredSuite | undefined;
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
      if (!isRealLlmAbRequiredSuite(value)) {
        throw new Error("--suite must be one of: core, browser-focused, browser-reliability, full-natural");
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
  if (resolvedMarkdownOutPath && resolvedMarkdownOutPath === resolvedOutPath) {
    throw new Error("--markdown-out must differ from --out");
  }
  mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
  writeFileSync(resolvedOutPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`real LLM A/B report written: ${resolvedOutPath}`);
  if (resolvedMarkdownOutPath) {
    const markdown = buildRealLlmAbMarkdownReport(report, { requiredSuite: options.requiredSuite });
    mkdirSync(path.dirname(resolvedMarkdownOutPath), { recursive: true });
    writeFileSync(resolvedMarkdownOutPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    console.log(`real LLM A/B markdown report written: ${resolvedMarkdownOutPath}`);
  }
  if (options.check) {
    const validation = validateRealLlmAbAcceptanceReport(report, { requiredSuite: options.requiredSuite });
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
    "  npm run acceptance:ab:build -- --spec <path> --out <path> [--check] [--suite <core|browser-focused|browser-reliability|full-natural>] [--markdown-out <path>]",
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
  const naturalReportPath = resolveInputPath(spec.turnkeyaiNaturalReportPath, specDir);
  const naturalReport = readJsonFile<NaturalMissionReportShape>(naturalReportPath);
  if (naturalReport.kind !== "turnkeyai.natural-mission-e2e.report" || !Array.isArray(naturalReport.scenarios)) {
    throw new Error("turnkeyaiNaturalReportPath does not point to a natural mission E2E report");
  }
  const scenarios = spec.scenarios.map((scenarioSpec) => {
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
        artifactPath: spec.turnkeyaiNaturalReportPath,
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

function isRealLlmAbRequiredSuite(value: string): value is RealLlmAbRequiredSuite {
  return value === "core" || value === "browser-focused" || value === "browser-reliability" || value === "full-natural";
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
  const dimensionScores = readTurnkeyAiDimensionScores(input.scenario);
  const toolSequence = readStringArray(metrics.tools?.names);
  const sessionsContinued = readNumber(metrics.sessions?.continued);
  const toolTimeouts = readNumber(metrics.tools?.timeouts);
  const approvalWaitTimeoutCloseout = hasTurnkeyAiApprovalWaitTimeoutCloseout(input.scenario);
  const browserEvidenceEvents = input.scenario.natural?.browserUsed === true ? readNumber(metrics.evidenceEvents) : 0;
  const browserFailureBuckets = readBrowserFailureBucketNames(metrics.browser?.failureBuckets);
  const weakAnswerSignals = readTurnkeyAiWeakAnswerSignals(input.scenario, browserFailureBuckets);
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
    finalAnswerUseful: input.scenario.natural?.finalAnswerUseful === true,
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
  const toolCallCount = readNumber(first?.toolCallCount) + readNumber(followup?.toolCallCount);
  const toolResultCount = readNumber(first?.toolResultCount) + readNumber(followup?.toolResultCount);
  const useful = input.artifact.score?.useful === true;
  const weak = input.artifact.score?.weak === true;
  const approvalWaitTimeoutBaselineLoss = isApprovalWaitTimeoutReferenceBaselineLoss(input.artifact);
  const timeoutPartialBaselineLoss = isTimeoutPartialReferenceBaselineLoss(input.artifact);
  const hasFollowup = Boolean(input.artifact.followup);
  const rawBrowserEvidence = input.artifact.provenance?.rawBrowserEvidence ?? input.artifact.rawBrowserEvidence;
  const rawApprovalEvidence = input.artifact.provenance?.rawApprovalEvidence ?? input.artifact.rawApprovalEvidence;
  const renderedBrowserEvidence = containsRenderedBrowserEvidence(rawBrowserEvidence);
  const browserEvidenceUsed = renderedBrowserEvidence || hasNonEmptyEvidence(rawBrowserEvidence);
  const approvalRequested =
    input.requiresApproval &&
    (hasNonEmptyEvidence(rawApprovalEvidence) ||
      containsReferenceTerm(
        [input.artifact.provenance?.rawTranscript, input.artifact.rawTranscript, input.artifact.rawToolCalls, input.artifact.rawToolResults],
        /\bpermission\.query\b|approval (?:id|request)|browser\.form\.submit/i
      ));
  const approvalDecided =
    input.requiresApproval &&
    !approvalWaitTimeoutBaselineLoss &&
    (containsReferenceApprovalDecision(rawApprovalEvidence) ||
      containsReferenceTerm(
        [input.artifact.provenance?.rawTranscript, input.artifact.rawTranscript, input.artifact.rawToolResults],
        /\bpermission\.result\b|operator approved|approval was granted|approved action/i
      ));
  const approvalApplied =
    input.requiresApproval &&
    !approvalWaitTimeoutBaselineLoss &&
    (containsReferenceTerm(
      [input.artifact.provenance?.rawTranscript, input.artifact.rawTranscript, input.artifact.rawToolResults, input.artifact.first],
      /\bpermission\.applied\b|permission already granted|permission cache|approved action|form submitted successfully/i
    ) ||
      (approvalDecided && renderedBrowserEvidence && /submitted|post-submit|dry-run submission complete/i.test(readString(first?.finalText) ?? "")));
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
    toolSequence: [],
    subAgentCount: toolCallCount,
    completedSubAgentCount: toolResultCount,
    continuation: {
      required: input.requiresContinuation,
      sessionsContinued: hasFollowup && toolResultCount > 0 ? 1 : 0,
      usedSessionsSend: false,
      reusedPriorContext: hasFollowup && useful,
    },
    timeout: {
      required: input.requiresTimeoutCloseout,
      timedOut: input.artifact.timedOut === true,
      partialCloseout: input.requiresTimeoutCloseout
        ? input.artifact.timedOut === true && useful && !approvalWaitTimeoutBaselineLoss && !timeoutPartialBaselineLoss
        : undefined,
      hardAborted: timeoutPartialBaselineLoss || (input.artifact.timedOut === true && !useful),
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
    completed: timeoutPartialBaselineLoss ? false : useful,
    stuckOrLoop: input.artifact.timedOut === true || readNumber(first?.pendingToolCount) + readNumber(followup?.pendingToolCount) > 0,
    finalAnswerUseful: timeoutPartialBaselineLoss ? false : useful,
    finalAnswerHasEvidence: timeoutPartialBaselineLoss ? false : useful && toolResultCount > 0,
    weakAnswerSignals: weak || timeoutPartialBaselineLoss ? ["weak-answer"] : [],
    residualRiskVisible: timeoutPartialBaselineLoss ? false : useful,
    dimensionScores: {
      ...inferReferenceDimensionScores({
        useful: approvalWaitTimeoutBaselineLoss || timeoutPartialBaselineLoss ? false : useful,
        toolCallCount,
        toolResultCount,
        requiresBrowser: input.requiresBrowser,
        requiresApproval: input.requiresApproval,
        requiresContinuation: input.requiresContinuation,
        requiresTimeoutCloseout: input.requiresTimeoutCloseout,
      }),
      ...(input.dimensionScores ?? {}),
    },
  };
}

function classifyComparison(audit: RealLlmAbReferenceAudit): RealLlmAbComparisonClassification {
  if (audit.fairnessStatus !== "passed") return "unfair_prompt_or_fixture";
  if (audit.runtimeHealthStatus !== "passed") return "reference_env_failed";
  if (audit.provenanceStatus !== "passed" || audit.adapterStatus !== "passed") return "adapter_unproven";
  return "validated_comparison";
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
  const timedOutWithoutResult =
    readString(provenance.exitStatus ?? artifact.exitStatus) === "timeout" &&
    artifact.timedOut === true &&
    toolResultCount === 0;
  const failedWorkerCloseout =
    toolResultCount > 0 &&
    containsReferenceTerm(
      [provenance.rawTranscript, artifact.rawTranscript, provenance.rawToolResults, artifact.rawToolResults, artifact.first],
      /\b(?:sub-agent returned no executable result|no executable results?|requested task did not match the worker|worker's implemented capability|without live network access|localhost is inaccessible)\b/i
    );
  if (!timedOutWithoutResult && !failedWorkerCloseout) return false;
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
  const missingProvenance = REQUIRED_REFERENCE_PROVENANCE_FIELDS.filter(
    (field) => !hasReferenceProvenanceValue(input.artifact, provenance, field)
  );
  const notes = readString(input.artifact.notes) ?? "";
  const transcript = readReferenceTranscript(input.artifact, input.artifactPath);
  const finalText =
    readString(input.artifact.first?.summary?.finalText) ?? readString(input.artifact.followup?.summary?.finalText);
  const exactRequestPayloadPrompt = readReferenceExactRequestPrompt(provenance.exactRequestPayload);
  const browserEvidenceFailed = hasFailedReferenceBrowserEvidence(input.artifact);
  const runtimeEvidenceFailed = hasFailedReferenceRuntimeEvidence(input.artifact);
  const weakFinalText = isWeakReferenceFinalText(finalText);
  const referenceUseful = input.artifact.score?.useful === true;
  const toolCallCount = readReferenceToolCallCount(input.artifact);
  const toolResultCount = readReferenceToolResultCount(input.artifact);
  const approvalWaitTimeoutBaselineLoss = isApprovalWaitTimeoutReferenceBaselineLoss(input.artifact);
  const timeoutPartialBaselineLoss = isTimeoutPartialReferenceBaselineLoss(input.artifact);
  const toolOrWorkerTriggered = toolCallCount > 0;
  const toolOrWorkerResult = approvalWaitTimeoutBaselineLoss || timeoutPartialBaselineLoss || toolResultCount > 0;

  if (!finalText && !approvalWaitTimeoutBaselineLoss && !timeoutPartialBaselineLoss) {
    findings.push("adapter did not capture raw final answer text");
  }
  if (weakFinalText) {
    findings.push("reference final answer contains harness or weak-answer text");
  }
  if (!referenceUseful && !approvalWaitTimeoutBaselineLoss && !timeoutPartialBaselineLoss) {
    findings.push("reference final answer is not marked useful");
  }
  if (!toolOrWorkerTriggered) {
    findings.push("reference native tool/worker execution was not observed");
  }
  if (!toolOrWorkerResult) {
    findings.push("reference native tool/worker result was not observed");
  }
  if (!transcript.ok) {
    findings.push(transcript.reason);
  }
  if (detectReferenceRuntimeHealthFailure(notes)) {
    findings.push("reference runtime health failure detected in notes");
  }
  if (runtimeEvidenceFailed) {
    findings.push("reference runtime health failure detected in raw transcript or worker metadata");
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

  const adapterStatus =
    (approvalWaitTimeoutBaselineLoss ||
      timeoutPartialBaselineLoss ||
      (finalText && !weakFinalText && referenceUseful && toolOrWorkerResult)) &&
    toolOrWorkerTriggered &&
    transcript.ok &&
    Boolean(exactRequestPayloadPrompt) &&
    hasReferenceProvenanceValue(input.artifact, provenance, "artifactAdapterMappingSource") &&
    (!input.requiresBrowser || hasRenderedReferenceBrowserEvidence(input.artifact))
      ? "passed"
      : "failed";
  const runtimeHealthStatus =
    !approvalWaitTimeoutBaselineLoss &&
    !timeoutPartialBaselineLoss &&
    (detectReferenceRuntimeHealthFailure(notes) ||
      runtimeEvidenceFailed ||
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
    provenanceStatus: missingProvenance.length === 0 ? "passed" : "failed",
    runtimeHealthStatus,
    adapterStatus,
    fairnessStatus,
    missingProvenance,
    findings,
  };
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
  artifactPath: string
): { ok: true } | { ok: false; reason: string } {
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
  return /blocked explore URL host|blocked host|page\.evaluate|ReferenceError|missing auth|wrong endpoint|Unexpected token '<'|browser worker failed|Explore worker failed|failed to fetch/i.test(
    notes
  );
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
  requiresTimeoutCloseout: boolean;
}): Record<RealLlmAbDimensionKey, RealLlmAbDimensionScore> {
  const usefulScore: RealLlmAbDimensionScore = input.useful ? 2 : 0;
  return {
    taskCompletion: usefulScore,
    evidenceQuality: input.useful && input.toolResultCount > 0 ? 2 : 0,
    toolUseAppropriateness: input.toolCallCount > 0 && input.toolResultCount > 0 ? 2 : 0,
    browserAuthenticity: input.requiresBrowser ? (input.useful && input.toolResultCount > 0 ? 2 : 0) : 2,
    subAgentIndependence: input.toolResultCount > 0 ? 2 : 0,
    continuationBehavior: input.requiresContinuation ? usefulScore : 2,
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
  for (const key of ["error", "failure", "fallbackReason", "lastResult", "metadata", "messages", "workerPayload", "workerState"]) {
    if (containsReferenceRuntimeHealthFailure(record[key])) return true;
  }
  return false;
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

function isWeakReferenceFinalText(text: string | null): boolean {
  return Boolean(
    text &&
      /暂时无法|无法返回|待确认|估算|没有足够|cannot access|unable to access|not enough information|no executable results?|could not process the task|without live network access|localhost is inaccessible|operating as|use the browser worker|close the flow with|please consolidate this update/i.test(
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
