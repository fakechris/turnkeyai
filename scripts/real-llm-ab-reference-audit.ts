import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildRealLlmAbSpec, RealLlmAbSpecIncompleteEvidenceError, type RealLlmAbSpecBuildSuite } from "./real-llm-ab-spec-build";
import { buildRealLlmAbAcceptanceReport } from "./real-llm-ab-report-build";
import { buildRealLlmAbFairnessReportForSpec } from "./real-llm-ab-fairness";

export interface RealLlmAbReferenceAuditOptions {
  naturalReportPath: string;
  referenceDir: string;
  outPath: string;
  tasksOutPath?: string;
  suite: RealLlmAbSpecBuildSuite;
  modelDifferenceNote?: string;
  check: boolean;
}

export interface RealLlmAbReferenceCollectionTaskManifest {
  kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest";
  generatedAtMs: number;
  suite: RealLlmAbSpecBuildSuite;
  naturalReportPath: string;
  referenceDir: string;
  taskCount: number;
  tasks: RealLlmAbReferenceCollectionTask[];
}

export interface RealLlmAbReferenceAuditReport {
  kind: "turnkeyai.real-llm-ab-reference-audit.report";
  status: "passed" | "failed";
  generatedAtMs: number;
  suite: RealLlmAbSpecBuildSuite;
  naturalReportPath: string;
  referenceDir: string;
  validatedComparisons: number;
  unvalidatedComparisons: number;
  missingReferenceArtifacts: number;
  scenarios: RealLlmAbReferenceAuditScenario[];
  missingEvidence: unknown[];
  collectionTasks: RealLlmAbReferenceCollectionTask[];
}

export interface RealLlmAbReferenceAuditScenario {
  scenarioId: string;
  prompt?: string;
  referenceArtifactPath?: string;
  comparisonClassification: string;
  referenceAudit?: unknown;
  fairnessAudit?: unknown;
}

export interface RealLlmAbReferenceCollectionTask {
  scenarioId: string;
  prompt?: string;
  expectedReferenceArtifactPath?: string;
  action: "collect_reference_artifact" | "recollect_reference_artifact";
  comparisonClassification?: string;
  requiredProvenanceFields: string[];
  blockingReasons: string[];
}

export function parseRealLlmAbReferenceAuditArgs(
  args: string[]
): RealLlmAbReferenceAuditOptions | { help: true } {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    return { help: true };
  }
  let naturalReportPath: string | undefined;
  let referenceDir: string | undefined;
  let outPath: string | undefined;
  let tasksOutPath: string | undefined;
  let suite: RealLlmAbSpecBuildSuite | undefined;
  let modelDifferenceNote: string | undefined;
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--natural-report") {
      naturalReportPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-dir") {
      referenceDir = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      outPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--tasks-out") {
      tasksOutPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--suite") {
      const value = readValue(args, index, arg);
      if (!isRealLlmAbSpecBuildSuite(value)) {
        throw new Error("--suite must be one of: core, browser-focused, browser-reliability, full-natural, report-scenarios");
      }
      suite = value;
      index += 1;
      continue;
    }
    if (arg === "--model-difference-note") {
      modelDifferenceNote = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!naturalReportPath) throw new Error("missing required --natural-report <path>");
  if (!referenceDir) throw new Error("missing required --reference-dir <dir>");
  if (!outPath) throw new Error("missing required --out <path>");
  if (!suite) throw new Error("missing required --suite core");
  return {
    naturalReportPath,
    referenceDir,
    outPath,
    ...(tasksOutPath ? { tasksOutPath } : {}),
    suite,
    ...(modelDifferenceNote ? { modelDifferenceNote } : {}),
    check,
  };
}

export async function runRealLlmAbReferenceAuditCli(args: string[]): Promise<void> {
  const options = parseRealLlmAbReferenceAuditArgs(args);
  if ("help" in options) {
    console.log(buildRealLlmAbReferenceAuditHelpText());
    return;
  }
  const report = buildRealLlmAbReferenceAuditReport(options);
  const resolvedOutPath = path.resolve(options.outPath);
  mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
  writeFileSync(resolvedOutPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`real LLM A/B reference audit written: ${resolvedOutPath}`);
  if (options.tasksOutPath) {
    const resolvedTasksOutPath = path.resolve(options.tasksOutPath);
    const manifest = buildRealLlmAbReferenceCollectionTaskManifest(report);
    mkdirSync(path.dirname(resolvedTasksOutPath), { recursive: true });
    writeFileSync(resolvedTasksOutPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`real LLM A/B reference collection tasks written: ${resolvedTasksOutPath}`);
  }
  if (options.check && report.status !== "passed") {
    console.error("real LLM A/B reference audit failed");
    for (const task of report.collectionTasks) {
      console.error(`- ${task.scenarioId}: ${task.action} (${task.blockingReasons.join("; ")})`);
    }
    if (report.collectionTasks.length === 0) {
      for (const scenario of report.scenarios) {
        if (scenario.comparisonClassification !== "validated_comparison") {
          console.error(`- ${scenario.scenarioId}: ${scenario.comparisonClassification}`);
        }
      }
      for (const missing of report.missingEvidence) {
        console.error(`- missing evidence: ${JSON.stringify(missing)}`);
      }
    }
    process.exitCode = 1;
  }
}

export function buildRealLlmAbReferenceAuditHelpText(): string {
  return [
    "TurnkeyAI real LLM A/B reference artifact audit",
    "",
    "Usage:",
    "  npm run acceptance:ab:reference-audit -- --natural-report <path> --reference-dir <dir> --suite <core|browser-focused|browser-reliability|full-natural|report-scenarios> --out <path> [--tasks-out <path>] [--model-difference-note <text>] [--check]",
    "",
    "The audit verifies reference provenance, runtime health, adapter mapping, and same-scenario fairness before A/B reports may claim capability.",
  ].join("\n");
}

export function buildRealLlmAbReferenceCollectionTaskManifest(
  report: RealLlmAbReferenceAuditReport
): RealLlmAbReferenceCollectionTaskManifest {
  return {
    kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
    generatedAtMs: report.generatedAtMs,
    suite: report.suite,
    naturalReportPath: report.naturalReportPath,
    referenceDir: report.referenceDir,
    taskCount: report.collectionTasks.length,
    tasks: report.collectionTasks,
  };
}

export function buildRealLlmAbReferenceAuditReport(input: {
  naturalReportPath: string;
  referenceDir: string;
  outPath: string;
  suite: RealLlmAbSpecBuildSuite;
  modelDifferenceNote?: string;
  generatedAtMs?: number;
}): RealLlmAbReferenceAuditReport {
  const outPath = path.resolve(input.outPath);
  const specInput = {
    naturalReportPath: input.naturalReportPath,
    referenceDir: input.referenceDir,
    outPath: path.join(path.dirname(outPath), "reference-audit-build-spec.json"),
    suite: input.suite,
    generatedAtMs: input.generatedAtMs,
  };
  try {
    const spec = applyAuditComparisonNotes(buildRealLlmAbSpec(specInput), input);
    const report = buildRealLlmAbAcceptanceReport(spec, { specDir: path.dirname(specInput.outPath) });
    const fairnessReport = buildRealLlmAbFairnessReportForSpec(spec, {
      specPath: specInput.outPath,
      specDir: path.dirname(specInput.outPath),
      generatedAtMs: input.generatedAtMs,
    });
    const fairnessByScenarioId = new Map(fairnessReport.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
    const scenarios = report.scenarios.map((scenario): RealLlmAbReferenceAuditScenario => ({
      ...buildAuditScenario({
        scenario,
        fairnessAudit: fairnessByScenarioId.get(scenario.scenarioId),
        specDir: path.dirname(specInput.outPath),
      }),
    }));
    const unvalidatedComparisons = scenarios.filter(
      (scenario) => scenario.comparisonClassification !== "validated_comparison"
    ).length;
    return {
      kind: "turnkeyai.real-llm-ab-reference-audit.report",
      status: unvalidatedComparisons === 0 ? "passed" : "failed",
      generatedAtMs: input.generatedAtMs ?? Date.now(),
      suite: input.suite,
      naturalReportPath: path.resolve(input.naturalReportPath),
      referenceDir: path.resolve(input.referenceDir),
      validatedComparisons: scenarios.length - unvalidatedComparisons,
      unvalidatedComparisons,
      missingReferenceArtifacts: 0,
      scenarios,
      missingEvidence: [],
      collectionTasks: buildCollectionTasksFromScenarios(scenarios),
    };
  } catch (error) {
    if (error instanceof RealLlmAbSpecIncompleteEvidenceError) {
      const missingEvidence = Array.isArray(error.missingManifest.missingEvidence)
        ? error.missingManifest.missingEvidence
        : [];
      return {
        kind: "turnkeyai.real-llm-ab-reference-audit.report",
        status: "failed",
        generatedAtMs: input.generatedAtMs ?? Date.now(),
        suite: input.suite,
        naturalReportPath: path.resolve(input.naturalReportPath),
        referenceDir: path.resolve(input.referenceDir),
        validatedComparisons: 0,
        unvalidatedComparisons: 0,
        missingReferenceArtifacts: missingEvidence.filter(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as { reason?: unknown }).reason === "missing_reference_artifact"
        ).length,
        scenarios: [],
        missingEvidence,
        collectionTasks: buildCollectionTasksFromMissingEvidence(missingEvidence),
      };
    }
    throw error;
  }
}

function applyAuditComparisonNotes<T extends { scenarios: Array<Record<string, unknown>> }>(
  spec: T,
  input: { modelDifferenceNote?: string }
): T {
  if (!input.modelDifferenceNote) return spec;
  return {
    ...spec,
    scenarios: spec.scenarios.map((scenario) => ({
      ...scenario,
      modelComparison: {
        ...((typeof scenario.modelComparison === "object" && scenario.modelComparison !== null
          ? scenario.modelComparison
          : {}) as Record<string, unknown>),
        differenceNote: input.modelDifferenceNote,
      },
    })),
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

function buildCollectionTasksFromScenarios(
  scenarios: readonly RealLlmAbReferenceAuditScenario[]
): RealLlmAbReferenceCollectionTask[] {
  return scenarios.flatMap((scenario) => {
    if (scenario.comparisonClassification === "validated_comparison") {
      return [];
    }
    const audit = readReferenceAuditObject(scenario.referenceAudit);
    const fairnessAudit = readFairnessAuditObject(scenario.fairnessAudit);
    const missingProvenance = readStringArray(audit?.missingProvenance);
    const findings = [...readStringArray(audit?.findings), ...readStringArray(fairnessAudit?.findings)];
    return [
      {
        scenarioId: scenario.scenarioId,
        ...(scenario.prompt ? { prompt: scenario.prompt } : {}),
        ...(scenario.referenceArtifactPath ? { expectedReferenceArtifactPath: scenario.referenceArtifactPath } : {}),
        action: "recollect_reference_artifact" as const,
        comparisonClassification: scenario.comparisonClassification,
        requiredProvenanceFields:
          missingProvenance.length > 0 ? missingProvenance : [...REQUIRED_REFERENCE_PROVENANCE_FIELDS],
        blockingReasons: buildBlockingReasons({
          classification: scenario.comparisonClassification,
          missingProvenance,
          findings,
        }),
      },
    ];
  });
}

function buildAuditScenario(input: {
  scenario: ReturnType<typeof buildRealLlmAbAcceptanceReport>["scenarios"][number];
  fairnessAudit: unknown;
  specDir: string;
}): RealLlmAbReferenceAuditScenario {
  const fairnessStatus =
    typeof input.fairnessAudit === "object" &&
    input.fairnessAudit !== null &&
    (input.fairnessAudit as { status?: unknown }).status === "passed"
      ? "passed"
      : "failed";
  const reportBuilderClassification = input.scenario.comparisonClassification ?? "adapter_unproven";
  return {
    scenarioId: input.scenario.scenarioId,
    prompt: input.scenario.prompt,
    ...(input.scenario.reference.artifactPath
      ? { referenceArtifactPath: resolveInputPath(input.scenario.reference.artifactPath, input.specDir) }
      : {}),
    comparisonClassification:
      fairnessStatus === "passed" ? reportBuilderClassification : "unfair_prompt_or_fixture",
    ...(input.scenario.referenceAudit ? { referenceAudit: input.scenario.referenceAudit } : {}),
    ...(input.fairnessAudit ? { fairnessAudit: input.fairnessAudit } : {}),
  };
}

function buildCollectionTasksFromMissingEvidence(missingEvidence: readonly unknown[]): RealLlmAbReferenceCollectionTask[] {
  return missingEvidence.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as {
      reason?: unknown;
      scenarioId?: unknown;
      prompt?: unknown;
      expectedReferenceArtifactPath?: unknown;
    };
    if (record.reason !== "missing_reference_artifact") return [];
    const scenarioId = readString(record.scenarioId);
    if (!scenarioId) return [];
    return [
      {
        scenarioId,
        ...(readString(record.prompt) ? { prompt: readString(record.prompt)! } : {}),
        ...(readString(record.expectedReferenceArtifactPath)
          ? { expectedReferenceArtifactPath: readString(record.expectedReferenceArtifactPath)! }
          : {}),
        action: "collect_reference_artifact" as const,
        requiredProvenanceFields: [...REQUIRED_REFERENCE_PROVENANCE_FIELDS],
        blockingReasons: ["missing reference artifact"],
      },
    ];
  });
}

function buildBlockingReasons(input: {
  classification: string;
  missingProvenance: readonly string[];
  findings: readonly string[];
}): string[] {
  const reasons: string[] = [];
  if (input.classification === "reference_env_failed") {
    reasons.push("reference runtime health failed");
  }
  if (input.classification === "adapter_unproven") {
    reasons.push("reference adapter mapping unproven");
  }
  if (input.classification === "unfair_prompt_or_fixture") {
    reasons.push("same-scenario fairness failed");
  }
  if (input.missingProvenance.length > 0) {
    reasons.push(`missing provenance: ${input.missingProvenance.join(", ")}`);
  }
  reasons.push(...input.findings);
  return reasons.length > 0 ? reasons : [`comparison classification ${input.classification}`];
}

function readReferenceAuditObject(value: unknown): { missingProvenance?: unknown; findings?: unknown } | null {
  return typeof value === "object" && value !== null ? (value as { missingProvenance?: unknown; findings?: unknown }) : null;
}

function readFairnessAuditObject(value: unknown): { findings?: unknown } | null {
  return typeof value === "object" && value !== null ? (value as { findings?: unknown }) : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : [])) : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveInputPath(filePath: string, baseDir: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
}

function isRealLlmAbSpecBuildSuite(value: string): value is RealLlmAbSpecBuildSuite {
  return (
    value === "core" ||
    value === "browser-focused" ||
    value === "browser-reliability" ||
    value === "full-natural" ||
    value === "report-scenarios"
  );
}

function readValue(args: string[], index: number, arg: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${arg}`);
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRealLlmAbReferenceAuditCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
