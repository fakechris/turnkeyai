import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  REAL_LLM_AB_CORE_SUITE_REQUIREMENTS,
  REAL_LLM_AB_DIMENSION_KEYS,
  validateRealLlmAbAcceptanceReport,
  type RealLlmAbRequiredSuite,
  type RealLlmAbAcceptanceReport,
  type RealLlmAbDimensionKey,
  type RealLlmAbDimensionScore,
  type RealLlmAbScenarioPair,
  type RealLlmAbScenarioRun,
} from "@turnkeyai/qc-runtime/real-llm-ab-acceptance";

export interface RealLlmAbReportBuildOptions {
  specPath: string;
  outPath: string;
  check: boolean;
  requiredSuite?: RealLlmAbRequiredSuite;
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
}

interface GenericReferenceSummaryShape {
  toolCallCount?: unknown;
  toolResultCount?: unknown;
  pendingToolCount?: unknown;
  finalText?: unknown;
}

export function parseRealLlmAbReportBuildArgs(args: string[]): RealLlmAbReportBuildOptions | { help: true } {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    return { help: true };
  }
  let specPath: string | undefined;
  let outPath: string | undefined;
  let check = false;
  let requiredSuite: RealLlmAbRequiredSuite | undefined;
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
    if (arg === "--suite") {
      const value = readValue(args, index, arg);
      if (value !== "core") {
        throw new Error("--suite must be core");
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
  return { specPath, outPath, check, ...(requiredSuite ? { requiredSuite } : {}) };
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
  mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  writeFileSync(options.outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`real LLM A/B report written: ${options.outPath}`);
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
    "  npm run acceptance:ab:build -- --spec <path> --out <path> [--check] [--suite core]",
    "",
    "The spec points at a TurnkeyAI natural mission report and same-scenario reference artifacts.",
    "--suite core requires the full core scenario set when --check is used.",
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
  return {
    system: "turnkeyai",
    prompt: readString(input.scenario.prompt) ?? "",
    artifactPath: input.artifactPath,
    ...(readString(input.scenario.missionId) ? { missionId: readString(input.scenario.missionId)! } : {}),
    ...(readString(input.scenario.threadId) ? { transcriptPath: `thread:${readString(input.scenario.threadId)!}` } : {}),
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
      timedOut: toolTimeouts > 0,
      partialCloseout:
        toolTimeouts > 0 &&
        input.scenario.natural?.completed === true &&
        input.scenario.natural?.finalAnswerHasEvidence === true &&
        input.scenario.natural?.finalAnswerUseful === true,
      hardAborted: input.scenario.natural?.stuckOrLoop === true,
    },
    browserEvidence: {
      required: input.requiresBrowser,
      used: input.scenario.natural?.browserUsed === true,
      rendered: input.scenario.natural?.browserUsed === true && readNumber(metrics.browser?.profileFallbacks) === 0,
      screenshotCount: countArtifacts(input.scenario.artifacts, "screenshot"),
      snapshotCount: countArtifacts(input.scenario.artifacts, "snapshot"),
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
    weakAnswerSignals: readStringArray(input.scenario.natural?.weakAnswerSignals),
    residualRiskVisible: input.scenario.natural?.sourceCoverage?.residualRiskVisible === true,
    unsupportedClaims: readStringArray(input.scenario.natural?.sourceCoverage?.unsupportedClaims),
    dimensionScores,
    rootCauseBuckets: readStringArray(input.scenario.natural?.failureBuckets) as RealLlmAbScenarioRun["rootCauseBuckets"],
  };
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
  const hasFollowup = Boolean(input.artifact.followup);
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
      partialCloseout: input.requiresTimeoutCloseout ? input.artifact.timedOut === true && useful : undefined,
      hardAborted: input.artifact.timedOut === true && !useful,
    },
    browserEvidence: {
      required: input.requiresBrowser,
      used: input.requiresBrowser && toolResultCount > 0,
      rendered: input.requiresBrowser && useful,
    },
    approval: {
      required: input.requiresApproval,
      requested: input.requiresApproval && toolCallCount > 0,
      decided: false,
      applied: false,
      sideEffectPreventedBeforeApproval: input.requiresApproval ? toolCallCount > 0 : undefined,
    },
    completed: useful,
    stuckOrLoop: input.artifact.timedOut === true || readNumber(first?.pendingToolCount) + readNumber(followup?.pendingToolCount) > 0,
    finalAnswerUseful: useful,
    finalAnswerHasEvidence: useful && toolResultCount > 0,
    weakAnswerSignals: weak ? ["weak-answer"] : [],
    residualRiskVisible: useful,
    dimensionScores: {
      ...inferReferenceDimensionScores({
        useful,
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

function readReferencePrompt(artifact: GenericReferenceArtifactShape): string | null {
  return (
    readString(artifact.prompt) ??
    readString(artifact.userPrompt) ??
    readString(artifact.input?.prompt) ??
    readString(artifact.request?.prompt)
  );
}

function readDimensionScore(value: unknown): RealLlmAbDimensionScore {
  return value === 0 || value === 1 || value === 2 ? value : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRealLlmAbReportBuildCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
