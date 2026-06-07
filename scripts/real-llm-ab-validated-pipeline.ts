import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildRealLlmAbMarkdownReport,
  validateRealLlmAbAcceptanceReport,
  type RealLlmAbRequiredSuite,
} from "@turnkeyai/qc-runtime/real-llm-ab-acceptance";

import {
  buildRealLlmAbReferenceAuditReport,
  buildRealLlmAbReferenceCollectionTaskManifest,
} from "./real-llm-ab-reference-audit";
import { collectReferenceArtifacts } from "./real-llm-ab-reference-collect";
import { runReferencePreflight } from "./real-llm-ab-reference-preflight";
import { buildRealLlmAbReferenceHealthReport } from "./real-llm-ab-reference-health";
import { buildRealLlmAbSpec, type RealLlmAbSpecBuildSuite } from "./real-llm-ab-spec-build";
import { buildRealLlmAbFairnessReportForSpec } from "./real-llm-ab-fairness";
import { buildRealLlmAbAcceptanceReport } from "./real-llm-ab-report-build";

interface ValidatedPipelineOptions {
  naturalReportPath: string;
  referenceDir: string;
  workDir: string;
  suite: RealLlmAbSpecBuildSuite;
  referenceBaseUrl?: string;
  referenceToken?: string;
  referenceVariant: string;
  referenceTimeoutMs: number;
  referencePollMs: number;
  referenceApp: string;
  referenceBinary?: string;
  referenceRepoPath?: string;
  referenceVersion?: string;
  referenceCommit?: string;
  modelDifferenceNote?: string;
  check: boolean;
}

interface ValidatedPipelineReport {
  kind: "turnkeyai.real-llm-ab-validated-pipeline.report";
  status: "passed" | "failed";
  generatedAtMs: number;
  suite: RealLlmAbSpecBuildSuite;
  naturalReportPath: string;
  referenceDir: string;
  workDir: string;
  collectionRequired: boolean;
  collectionAttempted: boolean;
  artifacts: {
    initialAuditPath: string;
    referencePreflightPath?: string;
    collectionTasksPath: string;
    collectionReportPath?: string;
    finalAuditPath?: string;
    referenceHealthTasksPath?: string;
    referenceHealthReportPath?: string;
    specPath?: string;
    fairnessReportPath?: string;
    abReportPath?: string;
    abMarkdownPath?: string;
  };
  gates: {
    initialAudit: "passed" | "failed";
    referencePreflight: "passed" | "failed" | "not_run";
    collection: "passed" | "failed" | "not_required" | "not_run";
    finalAudit: "passed" | "failed" | "not_run";
    referenceHealth: "passed" | "failed" | "not_run";
    fairness: "passed" | "failed" | "not_run";
    abAcceptance: "passed" | "failed" | "not_run";
  };
  failures: string[];
}

interface FullReferenceHealthTaskManifest {
  kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest";
  generatedAtMs: number;
  suite: RealLlmAbSpecBuildSuite;
  naturalReportPath: string;
  referenceDir: string;
  taskCount: number;
  tasks: Array<{
    scenarioId: string;
    prompt?: string;
    expectedReferenceArtifactPath: string;
    action: "recollect_reference_artifact";
    requiredProvenanceFields: string[];
    blockingReasons: string[];
  }>;
}

export function parseRealLlmAbValidatedPipelineArgs(
  args: string[]
): ValidatedPipelineOptions | { help: true } {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    return { help: true };
  }
  let naturalReportPath: string | undefined;
  let referenceDir: string | undefined;
  let workDir: string | undefined;
  let suite: RealLlmAbSpecBuildSuite | undefined;
  let referenceBaseUrl: string | undefined;
  let referenceToken: string | undefined;
  let referenceVariant = "operator";
  let referenceTimeoutMs = 180_000;
  let referencePollMs = 2_000;
  let referenceApp = "reference-workbench";
  let referenceBinary: string | undefined;
  let referenceRepoPath: string | undefined;
  let referenceVersion: string | undefined;
  let referenceCommit: string | undefined;
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
    if (arg === "--work-dir") {
      workDir = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--suite") {
      const value = readValue(args, index, arg);
      if (!isRealLlmAbSpecBuildSuite(value)) {
        throw new Error("--suite must be one of: core, browser-focused, browser-reliability, full-natural");
      }
      suite = value;
      index += 1;
      continue;
    }
    if (arg === "--reference-base-url") {
      referenceBaseUrl = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-token") {
      referenceToken = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-variant") {
      referenceVariant = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-timeout-ms") {
      referenceTimeoutMs = readPositiveInteger(readValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-poll-ms") {
      referencePollMs = readPositiveInteger(readValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-app") {
      referenceApp = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-binary") {
      referenceBinary = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-repo-path") {
      referenceRepoPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-version") {
      referenceVersion = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-commit") {
      referenceCommit = readValue(args, index, arg);
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
  if (!workDir) throw new Error("missing required --work-dir <dir>");
  if (!suite) throw new Error("missing required --suite core");
  return {
    naturalReportPath,
    referenceDir,
    workDir,
    suite,
    ...(referenceBaseUrl ? { referenceBaseUrl } : {}),
    ...(referenceToken ? { referenceToken } : {}),
    referenceVariant,
    referenceTimeoutMs,
    referencePollMs,
    referenceApp,
    ...(referenceBinary ? { referenceBinary } : {}),
    ...(referenceRepoPath ? { referenceRepoPath } : {}),
    ...(referenceVersion ? { referenceVersion } : {}),
    ...(referenceCommit ? { referenceCommit } : {}),
    ...(modelDifferenceNote ? { modelDifferenceNote } : {}),
    check,
  };
}

export function buildRealLlmAbValidatedPipelineHelpText(): string {
  return [
    "TurnkeyAI real LLM A/B validated evidence pipeline",
    "",
    "Usage:",
    "  npm run acceptance:ab:validated -- --natural-report <path> --reference-dir <dir> --suite <core|browser-focused|browser-reliability|full-natural> --work-dir <dir> [--reference-base-url <url>] [--reference-token <token>] [--model-difference-note <text>] [--check]",
    "",
    "The pipeline runs reference audit, optional reference collection, reference runtime health, same-scenario fairness, and A/B report validation in order.",
    "It writes local evidence artifacts into --work-dir. A failed result means capability comparison remains unproven.",
  ].join("\n");
}

export async function runRealLlmAbValidatedPipelineCli(args: string[]): Promise<void> {
  const options = parseRealLlmAbValidatedPipelineArgs(args);
  if ("help" in options) {
    console.log(buildRealLlmAbValidatedPipelineHelpText());
    return;
  }
  const report = await runRealLlmAbValidatedPipeline(options);
  console.log(`real LLM A/B validated pipeline written: ${path.join(path.resolve(options.workDir), "pipeline-report.json")}`);
  console.log(`status=${report.status}`);
  for (const failure of report.failures) {
    console.error(`- ${failure}`);
  }
  if (options.check && report.status !== "passed") {
    process.exitCode = 1;
  }
}

export async function runRealLlmAbValidatedPipeline(
  options: ValidatedPipelineOptions
): Promise<ValidatedPipelineReport> {
  const workDir = path.resolve(options.workDir);
  mkdirSync(workDir, { recursive: true });
  const initialAuditPath = path.join(workDir, "reference-audit.initial.json");
  const referencePreflightPath = path.join(workDir, "reference-preflight.json");
  const collectionTasksPath = path.join(workDir, "reference-collection-tasks.json");
  const finalAuditPath = path.join(workDir, "reference-audit.final.json");
  const referenceHealthTasksPath = path.join(workDir, "reference-health-tasks.json");
  const referenceHealthReportPath = path.join(workDir, "reference-health.json");
  const specPath = path.join(workDir, "ab-build-spec.json");
  const fairnessReportPath = path.join(workDir, "ab-fairness.json");
  const abReportPath = path.join(workDir, "ab-report.json");
  const abMarkdownPath = path.join(workDir, "ab-report.md");
  const collectionReportPath = path.join(workDir, "reference-collect.json");
  const failures: string[] = [];

  const initialAudit = buildRealLlmAbReferenceAuditReport({
    naturalReportPath: options.naturalReportPath,
    referenceDir: options.referenceDir,
    suite: options.suite,
    outPath: initialAuditPath,
    ...(options.modelDifferenceNote ? { modelDifferenceNote: options.modelDifferenceNote } : {}),
  });
  writeJson(initialAuditPath, initialAudit);
  const collectionTasks = buildRealLlmAbReferenceCollectionTaskManifest(initialAudit);
  writeJson(collectionTasksPath, collectionTasks);

  let referencePreflightGate: ValidatedPipelineReport["gates"]["referencePreflight"] = "not_run";
  if (options.referenceBaseUrl) {
    const probePrompt = collectionTasks.tasks.find((task) => typeof task.prompt === "string" && task.prompt.trim())?.prompt;
    const preflight = await runReferencePreflight({
      baseUrl: options.referenceBaseUrl,
      ...(options.referenceToken ? { referenceToken: options.referenceToken } : {}),
      variant: options.referenceVariant,
      timeoutMs: Math.min(options.referenceTimeoutMs, 60_000),
      pollMs: options.referencePollMs,
      ...(probePrompt ? { probePrompt } : {}),
    });
    writeJson(referencePreflightPath, preflight);
    referencePreflightGate = preflight.status;
    if (preflight.status !== "passed") {
      failures.push(`reference preflight did not pass: ${preflight.findings.join("; ")}`);
    }
  }

  let collectionGate: ValidatedPipelineReport["gates"]["collection"] =
    collectionTasks.taskCount > 0 ? "not_run" : "not_required";
  let collectionAttempted = false;
  if (collectionTasks.taskCount > 0) {
    if (!options.referenceBaseUrl) {
      failures.push("reference collection is required but --reference-base-url was not provided");
    } else if (referencePreflightGate === "failed") {
      failures.push("reference collection skipped because reference preflight failed");
    } else {
      collectionAttempted = true;
      const collectionReport = await collectReferenceArtifacts({
        tasksPath: collectionTasksPath,
        baseUrl: options.referenceBaseUrl,
        ...(options.referenceToken ? { referenceToken: options.referenceToken } : {}),
        variant: options.referenceVariant,
        timeoutMs: options.referenceTimeoutMs,
        pollMs: options.referencePollMs,
        referenceApp: options.referenceApp,
        ...(options.referenceBinary ? { referenceBinary: options.referenceBinary } : {}),
        ...(options.referenceRepoPath ? { referenceRepoPath: options.referenceRepoPath } : {}),
        ...(options.referenceVersion ? { referenceVersion: options.referenceVersion } : {}),
        ...(options.referenceCommit ? { referenceCommit: options.referenceCommit } : {}),
        check: false,
      });
      writeJson(collectionReportPath, collectionReport);
      collectionGate = collectionReport.status;
      if (collectionReport.status !== "passed") {
        failures.push("reference collection did not complete successfully");
      }
    }
  }

  let finalAuditGate: ValidatedPipelineReport["gates"]["finalAudit"] = "not_run";
  let referenceHealthGate: ValidatedPipelineReport["gates"]["referenceHealth"] = "not_run";
  let fairnessGate: ValidatedPipelineReport["gates"]["fairness"] = "not_run";
  let abAcceptanceGate: ValidatedPipelineReport["gates"]["abAcceptance"] = "not_run";
  const artifacts: ValidatedPipelineReport["artifacts"] = {
    initialAuditPath,
    ...(options.referenceBaseUrl ? { referencePreflightPath } : {}),
    collectionTasksPath,
    ...(collectionAttempted ? { collectionReportPath } : {}),
  };

  const finalAudit = buildRealLlmAbReferenceAuditReport({
    naturalReportPath: options.naturalReportPath,
    referenceDir: options.referenceDir,
    suite: options.suite,
    outPath: finalAuditPath,
    ...(options.modelDifferenceNote ? { modelDifferenceNote: options.modelDifferenceNote } : {}),
  });
  writeJson(finalAuditPath, finalAudit);
  artifacts.finalAuditPath = finalAuditPath;
  finalAuditGate = finalAudit.status;
  if (finalAudit.status !== "passed") {
    failures.push("reference audit did not validate the comparison evidence");
  }

  const collectionDidNotPass =
    collectionTasks.taskCount > 0 && collectionGate !== "passed";
  if (collectionDidNotPass) {
    failures.push("capability comparison skipped because required reference collection did not pass");
  }

  if (!collectionDidNotPass && finalAudit.scenarios.length > 0) {
    const healthTasks = buildFullReferenceHealthTasks({
      finalAudit,
      naturalReportPath: options.naturalReportPath,
      referenceDir: options.referenceDir,
      suite: options.suite,
    });
    writeJson(referenceHealthTasksPath, healthTasks);
    artifacts.referenceHealthTasksPath = referenceHealthTasksPath;
    const healthReport = buildRealLlmAbReferenceHealthReport({ tasksPath: referenceHealthTasksPath });
    writeJson(referenceHealthReportPath, healthReport);
    artifacts.referenceHealthReportPath = referenceHealthReportPath;
    referenceHealthGate = healthReport.status;
    if (healthReport.status !== "passed") {
      failures.push("reference runtime health did not pass for every compared artifact");
    }
  }

  if (!collectionDidNotPass) {
    try {
      const spec = applyPipelineComparisonNotes(buildRealLlmAbSpec({
        naturalReportPath: options.naturalReportPath,
        referenceDir: options.referenceDir,
        outPath: specPath,
        suite: options.suite,
      }), options);
      writeJson(specPath, spec);
      artifacts.specPath = specPath;
      const fairnessReport = buildRealLlmAbFairnessReportForSpec(spec, {
        specPath,
        specDir: path.dirname(specPath),
      });
      writeJson(fairnessReportPath, fairnessReport);
      artifacts.fairnessReportPath = fairnessReportPath;
      fairnessGate = fairnessReport.status;
      if (fairnessReport.status !== "passed") {
        failures.push("same-scenario fairness did not pass");
      }
      const abReport = buildRealLlmAbAcceptanceReport(spec, { specDir: path.dirname(specPath) });
      writeJson(abReportPath, abReport);
      artifacts.abReportPath = abReportPath;
      const markdown = buildRealLlmAbMarkdownReport(abReport, { requiredSuite: options.suite as RealLlmAbRequiredSuite });
      writeText(abMarkdownPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
      artifacts.abMarkdownPath = abMarkdownPath;
      const validation = validateRealLlmAbAcceptanceReport(abReport, {
        requiredSuite: options.suite as RealLlmAbRequiredSuite,
      });
      abAcceptanceGate = validation.status;
      if (validation.status !== "passed") {
        failures.push(...validation.failures.map((failure) => `A/B acceptance: ${failure}`));
      }
    } catch (error) {
      failures.push(`A/B report build could not run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const gates = {
    initialAudit: initialAudit.status,
    referencePreflight: referencePreflightGate,
    collection: collectionGate,
    finalAudit: finalAuditGate,
    referenceHealth: referenceHealthGate,
    fairness: fairnessGate,
    abAcceptance: abAcceptanceGate,
  };
  const status =
    gates.finalAudit === "passed" &&
    (gates.referencePreflight === "passed" || gates.referencePreflight === "not_run") &&
    gates.referenceHealth === "passed" &&
    gates.fairness === "passed" &&
    gates.abAcceptance === "passed" &&
    (gates.collection === "passed" || gates.collection === "not_required")
      ? "passed"
      : "failed";
  const report: ValidatedPipelineReport = {
    kind: "turnkeyai.real-llm-ab-validated-pipeline.report",
    status,
    generatedAtMs: Date.now(),
    suite: options.suite,
    naturalReportPath: path.resolve(options.naturalReportPath),
    referenceDir: path.resolve(options.referenceDir),
    workDir,
    collectionRequired: collectionTasks.taskCount > 0,
    collectionAttempted,
    artifacts,
    gates,
    failures: status === "passed" ? [] : failures,
  };
  writeJson(path.join(workDir, "pipeline-report.json"), report);
  return report;
}

function applyPipelineComparisonNotes<T extends { scenarios: Array<Record<string, unknown>> }>(
  spec: T,
  options: ValidatedPipelineOptions
): T {
  if (!options.modelDifferenceNote) return spec;
  return {
    ...spec,
    scenarios: spec.scenarios.map((scenario) => ({
      ...scenario,
      modelComparison: {
        ...((typeof scenario.modelComparison === "object" && scenario.modelComparison !== null
          ? scenario.modelComparison
          : {}) as Record<string, unknown>),
        differenceNote: options.modelDifferenceNote,
      },
    })),
  };
}

function buildFullReferenceHealthTasks(input: {
  finalAudit: ReturnType<typeof buildRealLlmAbReferenceAuditReport>;
  naturalReportPath: string;
  referenceDir: string;
  suite: RealLlmAbSpecBuildSuite;
}): FullReferenceHealthTaskManifest {
  const referenceDir = path.resolve(input.referenceDir);
  return {
    kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
    generatedAtMs: Date.now(),
    suite: input.suite,
    naturalReportPath: path.resolve(input.naturalReportPath),
    referenceDir,
    taskCount: input.finalAudit.scenarios.length,
    tasks: input.finalAudit.scenarios.flatMap((scenario) => {
      if (!scenario.referenceArtifactPath) return [];
      return [
        {
          scenarioId: scenario.scenarioId,
          ...(scenario.prompt ? { prompt: scenario.prompt } : {}),
          expectedReferenceArtifactPath: path.resolve(scenario.referenceArtifactPath),
          action: "recollect_reference_artifact" as const,
          requiredProvenanceFields: [],
          blockingReasons: ["full reference runtime health check"],
        },
      ];
    }),
  };
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

function readValue(args: string[], index: number, arg: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${arg}`);
  }
  return value;
}

function readPositiveInteger(value: string, arg: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${arg} must be a positive integer`);
  }
  return parsed;
}

function isRealLlmAbSpecBuildSuite(value: string): value is RealLlmAbSpecBuildSuite {
  return value === "core" || value === "browser-focused" || value === "browser-reliability" || value === "full-natural";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRealLlmAbValidatedPipelineCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
