import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REAL_LLM_AB_CORE_SUITE_REQUIREMENTS } from "@turnkeyai/qc-runtime/real-llm-ab-acceptance";
import {
  DEFAULT_REAL_ACCEPTANCE_NATURAL_BROWSER_AB_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_NATURAL_BROWSER_RELIABILITY_AB_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS,
} from "@turnkeyai/qc-runtime/real-llm-acceptance-defaults";

import type { RealLlmAbReportBuildSpec } from "./real-llm-ab-report-build";

export interface RealLlmAbSpecBuildOptions {
  naturalReportPath: string;
  referenceDir: string;
  outPath: string;
  requiredSuite: RealLlmAbSpecBuildSuite;
  missingManifestOutPath?: string;
}

export type RealLlmAbSpecBuildSuite = "core" | "browser-focused" | "browser-reliability" | "full-natural";

interface NaturalMissionReportShape {
  kind?: unknown;
  scenarios?: unknown;
}

interface NaturalMissionScenarioShape {
  scenario?: unknown;
  prompt?: unknown;
}

interface RealLlmAbReferenceCollectionManifest {
  kind: "turnkeyai.real-llm-ab-reference-collection.manifest";
  generatedAtMs: number;
  suite: RealLlmAbSpecBuildSuite;
  naturalReportPath: string;
  referenceDir: string;
  missingEvidence: RealLlmAbReferenceCollectionMissingEvidence[];
}

interface RealLlmAbReferenceCollectionMissingEvidence {
  reason: "missing_natural_scenario" | "missing_reference_artifact";
  requirementKey: string;
  acceptedScenarioIds: string[];
  scenarioId?: string;
  prompt?: string;
  expectedReferenceArtifactPath?: string;
}

interface RealLlmAbReferenceCollectionManifestData {
  generatedAtMs: number;
  suite: RealLlmAbSpecBuildSuite;
  naturalReportPath: string;
  referenceDir: string;
  missingEvidence: RealLlmAbReferenceCollectionMissingEvidence[];
}

export class RealLlmAbSpecIncompleteEvidenceError extends Error {
  readonly missingManifest: RealLlmAbReferenceCollectionManifestData;

  constructor(message: string, missingManifest: RealLlmAbReferenceCollectionManifestData) {
    super(message);
    this.name = "RealLlmAbSpecIncompleteEvidenceError";
    this.missingManifest = missingManifest;
  }
}

export function parseRealLlmAbSpecBuildArgs(args: string[]): RealLlmAbSpecBuildOptions | { help: true } {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    return { help: true };
  }
  let naturalReportPath: string | undefined;
  let referenceDir: string | undefined;
  let outPath: string | undefined;
  let requiredSuite: RealLlmAbSpecBuildSuite | undefined;
  let missingManifestOutPath: string | undefined;
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
    if (arg === "--missing-manifest-out") {
      missingManifestOutPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--suite") {
      const value = readValue(args, index, arg);
      if (!isRealLlmAbSpecBuildSuite(value)) {
        throw new Error("--suite must be one of: core, browser-focused, browser-reliability, full-natural");
      }
      requiredSuite = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!naturalReportPath) {
    throw new Error("missing required --natural-report <path>");
  }
  if (!referenceDir) {
    throw new Error("missing required --reference-dir <dir>");
  }
  if (!outPath) {
    throw new Error("missing required --out <path>");
  }
  if (!requiredSuite) {
    throw new Error("missing required --suite core");
  }
  return {
    naturalReportPath,
    referenceDir,
    outPath,
    requiredSuite,
    ...(missingManifestOutPath ? { missingManifestOutPath } : {}),
  };
}

export async function runRealLlmAbSpecBuildCli(args: string[]): Promise<void> {
  const options = parseRealLlmAbSpecBuildArgs(args);
  if ("help" in options) {
    console.log(buildRealLlmAbSpecBuildHelpText());
    return;
  }
  let spec: RealLlmAbReportBuildSpec;
  try {
    spec = buildRealLlmAbSpec({
      naturalReportPath: options.naturalReportPath,
      referenceDir: options.referenceDir,
      outPath: options.outPath,
      suite: options.requiredSuite,
    });
  } catch (error) {
    if (error instanceof RealLlmAbSpecIncompleteEvidenceError && options.missingManifestOutPath) {
      writeMissingEvidenceManifest({
        manifestOutPath: options.missingManifestOutPath,
        ...error.missingManifest,
      });
    }
    throw error;
  }
  const resolvedOutPath = path.resolve(options.outPath);
  mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
  writeFileSync(resolvedOutPath, `${JSON.stringify(spec, null, 2)}\n`);
  if (options.missingManifestOutPath) {
    writeMissingEvidenceManifest({
      manifestOutPath: options.missingManifestOutPath,
      generatedAtMs: spec.generatedAtMs ?? Date.now(),
      suite: options.requiredSuite,
      naturalReportPath: path.resolve(options.naturalReportPath),
      referenceDir: path.resolve(options.referenceDir),
      missingEvidence: [],
    });
  }
  console.log(`real LLM A/B build spec written: ${resolvedOutPath}`);
}

export function buildRealLlmAbSpecBuildHelpText(): string {
  return [
    "TurnkeyAI real LLM A/B build-spec generator",
    "",
    "Usage:",
    "  npm run acceptance:ab:spec -- --natural-report <path> --reference-dir <dir> --suite <core|browser-focused|browser-reliability|full-natural> --out <path> [--missing-manifest-out <path>]",
    "",
    "The generator selects natural same-scenario runs for the requested A/B suite.",
    "core covers the full P0 natural runtime gate; browser-focused covers external and complex browser gates.",
    "browser-reliability covers browser failure/recovery gates such as profile fallback, target/session recovery, and CDP failure closeout.",
    "full-natural covers the complete default natural mission matrix, including cancellation, approval variants, memory pressure/invalidation, and pruning.",
    "Reference artifacts must be named <natural-scenario-id>.json in --reference-dir.",
    "--missing-manifest-out writes a reference collection manifest when required evidence is incomplete, then the command still fails.",
  ].join("\n");
}

export function buildRealLlmAbSpec(input: {
  naturalReportPath: string;
  referenceDir: string;
  outPath: string;
  suite: RealLlmAbSpecBuildSuite;
  generatedAtMs?: number;
}): RealLlmAbReportBuildSpec {
  return buildRealLlmAbSpecForRequirements({
    ...input,
    requirements: suiteRequirements(input.suite),
  });
}

export function buildRealLlmAbCoreSpec(input: {
  naturalReportPath: string;
  referenceDir: string;
  outPath: string;
  generatedAtMs?: number;
}): RealLlmAbReportBuildSpec {
  return buildRealLlmAbSpec({ ...input, suite: "core" });
}

function buildRealLlmAbSpecForRequirements(input: {
  naturalReportPath: string;
  referenceDir: string;
  outPath: string;
  suite: RealLlmAbSpecBuildSuite;
  requirements: readonly RealLlmAbSpecRequirement[];
  generatedAtMs?: number;
}): RealLlmAbReportBuildSpec {
  const naturalReportPath = path.resolve(input.naturalReportPath);
  const referenceDir = path.resolve(input.referenceDir);
  const outDir = path.dirname(path.resolve(input.outPath));
  const naturalReport = readJsonFile<NaturalMissionReportShape>(naturalReportPath);
  if (naturalReport.kind !== "turnkeyai.natural-mission-e2e.report" || !Array.isArray(naturalReport.scenarios)) {
    throw new Error("--natural-report does not point to a natural mission E2E report");
  }
  const naturalScenarios = new Map<string, NaturalMissionScenarioShape>();
  for (const scenario of naturalReport.scenarios) {
    if (isNaturalScenario(scenario)) {
      naturalScenarios.set(readString(scenario.scenario)!, scenario);
    }
  }
  const missingEvidence: string[] = [];
  const manifestMissingEvidence: RealLlmAbReferenceCollectionMissingEvidence[] = [];
  const scenarioInputs: Array<{
    scenario: NaturalMissionScenarioShape;
    scenarioId: string;
    referenceArtifactPath: string;
  }> = [];
  for (const requirement of input.requirements) {
    const naturalScenario = findRequirementScenario(naturalScenarios, requirement.acceptedScenarioIds);
    if (!naturalScenario) {
      missingEvidence.push(`natural report is missing ${input.suite} A/B scenario: ${requirement.key}`);
      manifestMissingEvidence.push({
        reason: "missing_natural_scenario",
        requirementKey: requirement.key,
        acceptedScenarioIds: [...requirement.acceptedScenarioIds],
      });
      continue;
    }
    const scenarioId = readString(naturalScenario.scenario)!;
    const prompt = readString(naturalScenario.prompt)!;
    const referenceArtifactPath = path.join(referenceDir, `${scenarioId}.json`);
    if (!existsSync(referenceArtifactPath)) {
      missingEvidence.push(`missing reference artifact for ${scenarioId}: ${referenceArtifactPath}`);
      manifestMissingEvidence.push({
        reason: "missing_reference_artifact",
        requirementKey: requirement.key,
        acceptedScenarioIds: [...requirement.acceptedScenarioIds],
        scenarioId,
        prompt,
        expectedReferenceArtifactPath: referenceArtifactPath,
      });
      continue;
    }
    scenarioInputs.push({ scenario: naturalScenario, scenarioId, referenceArtifactPath });
  }
  if (missingEvidence.length > 0) {
    throw new RealLlmAbSpecIncompleteEvidenceError(
      `A/B suite evidence is incomplete:\n${missingEvidence.map((item) => `- ${item}`).join("\n")}`,
      {
        generatedAtMs: input.generatedAtMs ?? Date.now(),
        suite: input.suite,
        naturalReportPath,
        referenceDir,
        missingEvidence: manifestMissingEvidence,
      }
    );
  }
  const scenarios = scenarioInputs.map(({ scenario, scenarioId, referenceArtifactPath }) => {
    return {
      scenarioId,
      turnkeyaiScenarioId: scenarioId,
      prompt: readString(scenario.prompt)!,
      promptPolicy: {
        naturalPrompt: true,
        noForcedToolCall: true,
        noFixedMarkerGate: true,
        noExactAnswerShape: true,
      },
      ...scenarioRequirementFlags(scenarioId),
      referenceArtifactPath: toRelativePath(outDir, referenceArtifactPath),
      modelComparison: readReferenceModelComparison(referenceArtifactPath),
    };
  });
  return {
    kind: "turnkeyai.real-llm-ab-acceptance.build-spec",
    generatedAtMs: input.generatedAtMs ?? Date.now(),
    turnkeyaiNaturalReportPath: toRelativePath(outDir, naturalReportPath),
    scenarios,
  };
}

function readReferenceModelComparison(referenceArtifactPath: string): {
  referenceProvider?: string;
  referenceModelId?: string;
  differenceNote: string;
} {
  const artifact = readJsonFile<{ provenance?: { provider?: unknown; modelId?: unknown } }>(referenceArtifactPath);
  const referenceProvider = readString(artifact.provenance?.provider);
  const referenceModelId = readString(artifact.provenance?.modelId);
  return {
    ...(referenceProvider ? { referenceProvider } : {}),
    ...(referenceModelId ? { referenceModelId } : {}),
    differenceNote:
      "Reference model provenance is recorded explicitly; TurnkeyAI natural report model provenance may be absent in historical artifacts, so same-scenario claims rely on prompt, fixture, runtime, and artifact provenance rather than assuming hidden model equivalence.",
  };
}

interface RealLlmAbSpecRequirement {
  key: string;
  acceptedScenarioIds: readonly string[];
}

function suiteRequirements(suite: RealLlmAbSpecBuildSuite): readonly RealLlmAbSpecRequirement[] {
  if (suite === "core") return REAL_LLM_AB_CORE_SUITE_REQUIREMENTS;
  if (suite === "full-natural") {
    return DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS.map((scenarioId) => ({
      key: scenarioId.replace(/^natural-/, ""),
      acceptedScenarioIds: [scenarioId],
    }));
  }
  if (suite === "browser-reliability") {
    return DEFAULT_REAL_ACCEPTANCE_NATURAL_BROWSER_RELIABILITY_AB_SCENARIOS.map((scenarioId) => ({
      key: scenarioId.replace(/^natural-/, ""),
      acceptedScenarioIds: [scenarioId],
    }));
  }
  return DEFAULT_REAL_ACCEPTANCE_NATURAL_BROWSER_AB_SCENARIOS.map((scenarioId) => ({
    key: scenarioId.replace(/^natural-/, ""),
    acceptedScenarioIds: [scenarioId],
  }));
}

function findRequirementScenario(
  scenarios: ReadonlyMap<string, NaturalMissionScenarioShape>,
  acceptedScenarioIds: readonly string[]
): NaturalMissionScenarioShape | null {
  for (const scenarioId of acceptedScenarioIds) {
    const match = scenarios.get(scenarioId);
    if (match) {
      return match;
    }
  }
  return null;
}

function scenarioRequirementFlags(scenarioId: string): {
  requiresBrowser?: boolean;
  requiresApproval?: boolean;
  requiresContinuation?: boolean;
  requiresTimeoutCloseout?: boolean;
} {
  return {
    ...(requiresBrowser(scenarioId) ? { requiresBrowser: true } : {}),
    ...(scenarioId.includes("approval") ? { requiresApproval: true } : {}),
    ...(scenarioId.includes("followup") || scenarioId.includes("continuation") ? { requiresContinuation: true } : {}),
    ...(scenarioId.includes("timeout") && scenarioId !== "natural-approval-wait-timeout-closeout"
      ? { requiresTimeoutCloseout: true }
      : {}),
  };
}

function requiresBrowser(scenarioId: string): boolean {
  return (
    scenarioId === "natural-browser-dynamic-page" ||
    scenarioId === "natural-browser-dashboard-task" ||
    scenarioId === "natural-browser-external-page-review" ||
    scenarioId === "natural-browser-complex-page-review" ||
    scenarioId === "natural-browser-followup-continuation" ||
    scenarioId === "natural-browser-restart-continuation" ||
    scenarioId === "natural-browser-cold-recreation-continuation" ||
    scenarioId === "natural-browser-profile-lock-recovery" ||
    scenarioId === "natural-browser-unavailable-closeout" ||
    scenarioId === "natural-browser-cdp-timeout-closeout" ||
    scenarioId === "natural-browser-detached-target-closeout" ||
    scenarioId === "natural-browser-attach-failed-closeout" ||
    scenarioId === "natural-long-delegation"
  );
}

function isRealLlmAbSpecBuildSuite(value: string): value is RealLlmAbSpecBuildSuite {
  return value === "core" || value === "browser-focused" || value === "browser-reliability" || value === "full-natural";
}

function isNaturalScenario(value: unknown): value is NaturalMissionScenarioShape {
  return (
    typeof value === "object" &&
    value !== null &&
    Boolean(readString((value as NaturalMissionScenarioShape).scenario)) &&
    Boolean(readString((value as NaturalMissionScenarioShape).prompt))
  );
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function writeMissingEvidenceManifest(input: {
  manifestOutPath: string;
  generatedAtMs: number;
  suite: RealLlmAbSpecBuildSuite;
  naturalReportPath: string;
  referenceDir: string;
  missingEvidence: RealLlmAbReferenceCollectionMissingEvidence[];
}): void {
  const resolvedManifestOutPath = path.resolve(input.manifestOutPath);
  const manifestDir = path.dirname(resolvedManifestOutPath);
  const manifest: RealLlmAbReferenceCollectionManifest = {
    kind: "turnkeyai.real-llm-ab-reference-collection.manifest",
    generatedAtMs: input.generatedAtMs,
    suite: input.suite,
    naturalReportPath: toRelativePath(manifestDir, input.naturalReportPath),
    referenceDir: toRelativePath(manifestDir, input.referenceDir),
    missingEvidence: input.missingEvidence.map((item) => {
      if (item.expectedReferenceArtifactPath) {
        return {
          ...item,
          expectedReferenceArtifactPath: toRelativePath(manifestDir, item.expectedReferenceArtifactPath),
        };
      }
      return item;
    }),
  };
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(resolvedManifestOutPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`real LLM A/B missing evidence manifest written: ${resolvedManifestOutPath}`);
}

function readValue(args: string[], index: number, arg: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${arg}`);
  }
  return value;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toRelativePath(fromDir: string, targetPath: string): string {
  const relative = path.relative(fromDir, targetPath);
  const posixRelative = relative.split(path.win32.sep).join("/");
  return posixRelative.startsWith(".") ? posixRelative : `./${posixRelative}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRealLlmAbSpecBuildCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
