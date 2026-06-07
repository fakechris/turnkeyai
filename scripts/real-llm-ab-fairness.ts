import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { RealLlmAbDimensionKey } from "@turnkeyai/qc-runtime/real-llm-ab-acceptance";

import type { RealLlmAbReportBuildSpec } from "./real-llm-ab-report-build";

interface RealLlmAbFairnessOptions {
  specPath: string;
  outPath: string;
  check: boolean;
}

interface NaturalReportShape {
  kind?: unknown;
  provider?: unknown;
  modelId?: unknown;
  model?: unknown;
  timeoutPolicy?: {
    scenarioTimeoutMs?: unknown;
  };
  scenarios?: unknown;
}

interface NaturalScenarioShape {
  scenario?: unknown;
  prompt?: unknown;
  provider?: unknown;
  modelId?: unknown;
  model?: unknown;
  metrics?: {
    tools?: { names?: unknown; timeouts?: unknown };
    sessions?: { continued?: unknown };
    approvals?: { requested?: unknown; decided?: unknown; applied?: unknown };
  };
  artifacts?: unknown;
}

interface ReferenceArtifactShape {
  prompt?: unknown;
  userPrompt?: unknown;
  input?: { prompt?: unknown };
  request?: { prompt?: unknown };
  provenance?: {
    provider?: unknown;
    modelId?: unknown;
    exactRequestPayload?: unknown;
    rawBrowserEvidence?: unknown;
    rawToolCalls?: unknown;
    rawToolResults?: unknown;
    timeout?: unknown;
  };
  rawBrowserEvidence?: unknown;
  rawToolCalls?: unknown;
  rawToolResults?: unknown;
  first?: { summary?: { toolCallCount?: unknown; toolResultCount?: unknown } };
  followup?: { summary?: { toolCallCount?: unknown; toolResultCount?: unknown } };
}

interface FairnessScenarioSpec {
  scenarioId: string;
  turnkeyaiScenarioId: string;
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
  referenceArtifactPath: string;
  referenceDimensionScores?: Partial<Record<RealLlmAbDimensionKey, unknown>>;
  modelComparison?: {
    turnkeyaiProvider?: unknown;
    turnkeyaiModelId?: unknown;
    referenceProvider?: unknown;
    referenceModelId?: unknown;
    differenceNote?: unknown;
  };
  timeoutComparison?: {
    turnkeyaiPolicy?: unknown;
    referencePolicy?: unknown;
    differenceNote?: unknown;
  };
  memoryComparison?: {
    seedId?: unknown;
    turnkeyaiSeed?: unknown;
    referenceSeed?: unknown;
    differenceNote?: unknown;
  };
}

interface FairnessReport {
  kind: "turnkeyai.real-llm-ab-fairness.report";
  status: "passed" | "failed";
  generatedAtMs: number;
  specPath: string;
  scenarioCount: number;
  passedScenarios: number;
  failedScenarios: number;
  scenarios: FairnessScenarioReport[];
}

interface FairnessScenarioReport {
  scenarioId: string;
  status: "passed" | "failed";
  checks: Record<string, "passed" | "failed" | "not_required">;
  findings: string[];
  comparableUrls: string[];
  modelComparison: {
    turnkeyaiProvider?: string;
    turnkeyaiModelId?: string;
    referenceProvider?: string;
    referenceModelId?: string;
    differenceRecorded: boolean;
  };
}

const DIMENSION_KEYS = new Set([
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

export function parseRealLlmAbFairnessArgs(args: string[]): RealLlmAbFairnessOptions | { help: true } {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    return { help: true };
  }
  let specPath: string | undefined;
  let outPath: string | undefined;
  let check = false;
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
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!specPath) throw new Error("missing required --spec <path>");
  if (!outPath) throw new Error("missing required --out <path>");
  return { specPath, outPath, check };
}

export function buildRealLlmAbFairnessHelpText(): string {
  return [
    "TurnkeyAI real LLM A/B same-scenario fairness gate",
    "",
    "Usage:",
    "  npm run acceptance:ab:fairness -- --spec <ab-build-spec.json> --out <fairness-report.json> [--check]",
    "",
    "The gate verifies prompt, fixture, model, timeout, browser, approval, memory, continuation, and scoring comparability before capability comparison.",
  ].join("\n");
}

export async function runRealLlmAbFairnessCli(args: string[]): Promise<void> {
  const options = parseRealLlmAbFairnessArgs(args);
  if ("help" in options) {
    console.log(buildRealLlmAbFairnessHelpText());
    return;
  }
  const report = buildRealLlmAbFairnessReport({
    specPath: options.specPath,
  });
  const resolvedOutPath = path.resolve(options.outPath);
  mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
  writeFileSync(resolvedOutPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`real LLM A/B fairness report written: ${resolvedOutPath}`);
  if (options.check && report.status !== "passed") {
    console.error("real LLM A/B fairness failed");
    for (const scenario of report.scenarios) {
      if (scenario.status !== "passed") {
        console.error(`- ${scenario.scenarioId}: ${scenario.findings.join("; ")}`);
      }
    }
    process.exitCode = 1;
  }
}

export function buildRealLlmAbFairnessReport(input: {
  specPath: string;
  generatedAtMs?: number;
}): FairnessReport {
  const specPath = path.resolve(input.specPath);
  const specDir = path.dirname(specPath);
  const spec = readJsonFile<RealLlmAbReportBuildSpec>(specPath);
  return buildRealLlmAbFairnessReportForSpec(spec, {
    specPath,
    specDir,
    generatedAtMs: input.generatedAtMs,
  });
}

export function buildRealLlmAbFairnessReportForSpec(
  spec: RealLlmAbReportBuildSpec,
  input: {
    specPath: string;
    specDir: string;
    generatedAtMs?: number;
  }
): FairnessReport {
  const specPath = path.resolve(input.specPath);
  const specDir = path.resolve(input.specDir);
  if (!Array.isArray(spec.scenarios)) {
    throw new Error("--spec does not contain scenarios[]");
  }
  const naturalReportPath = resolveInputPath(spec.turnkeyaiNaturalReportPath, specDir);
  const naturalReport = readJsonFile<NaturalReportShape>(naturalReportPath);
  if (naturalReport.kind !== "turnkeyai.natural-mission-e2e.report" || !Array.isArray(naturalReport.scenarios)) {
    throw new Error("turnkeyaiNaturalReportPath does not point to a natural mission E2E report");
  }
  const scenarios = spec.scenarios.map((scenario) =>
    auditFairnessScenario({
      scenario: scenario as FairnessScenarioSpec,
      specDir,
      naturalReport,
      naturalReportPath,
    })
  );
  const passedScenarios = scenarios.filter((scenario) => scenario.status === "passed").length;
  return {
    kind: "turnkeyai.real-llm-ab-fairness.report",
    status: passedScenarios === scenarios.length ? "passed" : "failed",
    generatedAtMs: input.generatedAtMs ?? Date.now(),
    specPath,
    scenarioCount: scenarios.length,
    passedScenarios,
    failedScenarios: scenarios.length - passedScenarios,
    scenarios,
  };
}

function auditFairnessScenario(input: {
  scenario: FairnessScenarioSpec;
  specDir: string;
  naturalReport: NaturalReportShape;
  naturalReportPath: string;
}): FairnessScenarioReport {
  const findings: string[] = [];
  const naturalScenario = findNaturalScenario(input.naturalReport, input.scenario.turnkeyaiScenarioId);
  const referenceArtifactPath = resolveInputPath(input.scenario.referenceArtifactPath, input.specDir);
  const referenceArtifact = readJsonFile<ReferenceArtifactShape>(referenceArtifactPath);
  const specPrompt = input.scenario.prompt;
  const naturalPrompt = readString(naturalScenario.prompt) ?? "";
  const referencePrompt = readReferencePrompt(referenceArtifact) ?? "";
  const exactRequestPrompt = readReferenceExactRequestPrompt(referenceArtifact.provenance?.exactRequestPayload) ?? "";
  const specUrls = extractComparableUrls(specPrompt);
  const naturalUrls = extractComparableUrls(naturalPrompt);
  const referenceUrls = extractComparableUrls(referencePrompt);
  const exactRequestUrls = extractComparableUrls(exactRequestPrompt);
  const browserEvidenceUrls = extractComparableUrls(referenceArtifact.provenance?.rawBrowserEvidence ?? referenceArtifact.rawBrowserEvidence);
  const loopbackFixtureRequired = specUrls.some((url) => url.includes("://<loopback-host>:<loopback-port>/"));
  const fixtureHashes = {
    turnkeyai: readContentHashes([naturalScenario, input.naturalReport], specUrls),
    reference: readContentHashes(referenceArtifact, specUrls),
  };
  const modelComparison = readModelComparison({
    scenario: input.scenario,
    naturalReport: input.naturalReport,
    naturalScenario,
    referenceArtifact,
  });
  const checks: FairnessScenarioReport["checks"] = {
    naturalScenarioPresent: naturalScenario ? "passed" : "failed",
    promptComparable:
      normalizePrompt(specPrompt) === normalizePrompt(naturalPrompt) &&
      normalizePrompt(specPrompt) === normalizePrompt(referencePrompt) &&
      normalizePrompt(specPrompt) === normalizePrompt(exactRequestPrompt)
        ? "passed"
        : "failed",
    fixturePathComparable:
      sameUrlSet(specUrls, naturalUrls) &&
      sameUrlSet(specUrls, referenceUrls) &&
      sameUrlSet(specUrls, exactRequestUrls) &&
      browserEvidenceUrls.every((url) => specUrls.includes(url))
        ? "passed"
        : "failed",
    fixtureContentComparable:
      loopbackFixtureRequired
        ? sameNonEmptySet(fixtureHashes.turnkeyai, fixtureHashes.reference)
          ? "passed"
          : "failed"
        : "not_required",
    modelComparable: modelComparison.comparable ? "passed" : "failed",
    timeoutPolicyComparable: auditTimeoutPolicy(input.scenario, input.naturalReport, referenceArtifact),
    browserAccessComparable: auditBrowserAccess(input.scenario, naturalScenario, referenceArtifact),
    approvalHandlingComparable: auditApprovalHandling(input.scenario, naturalScenario, referenceArtifact),
    memorySeedComparable: auditMemorySeed(input.scenario, naturalScenario, referenceArtifact),
    continuationEntryComparable: auditContinuation(input.scenario, naturalScenario, referenceArtifact),
    scoringRulesComparable: auditScoringRules(input.scenario),
  };

  if (checks.promptComparable === "failed") {
    findings.push("same natural prompt was not proven across spec, natural run, reference artifact, and exact request payload");
  }
  if (checks.fixturePathComparable === "failed") {
    findings.push("fixture URL path semantics are not comparable across prompt and evidence");
  }
  if (checks.fixtureContentComparable === "failed") {
    findings.push("loopback fixture content hash was not proven comparable");
  }
  if (checks.modelComparable === "failed") {
    findings.push("model/provider comparability is not proven or model difference is not explicitly recorded");
  }
  if (checks.timeoutPolicyComparable === "failed") {
    findings.push("timeout policy comparability is not proven for a timeout-required scenario");
  }
  if (checks.browserAccessComparable === "failed") {
    findings.push("browser access comparability is not proven for a browser-required scenario");
  }
  if (checks.approvalHandlingComparable === "failed") {
    findings.push("approval handling comparability is not proven for an approval-required scenario");
  }
  if (checks.memorySeedComparable === "failed") {
    findings.push("memory seed comparability is not proven for a memory-required scenario");
  }
  if (checks.continuationEntryComparable === "failed") {
    findings.push("continuation entry comparability is not proven for a continuation-required scenario");
  }
  if (checks.scoringRulesComparable === "failed") {
    findings.push("same scoring rules are not proven by natural prompt policy and dimension score shape");
  }

  return {
    scenarioId: input.scenario.scenarioId,
    status: Object.values(checks).every((value) => value === "passed" || value === "not_required")
      ? "passed"
      : "failed",
    checks,
    findings,
    comparableUrls: specUrls,
    modelComparison: {
      ...(modelComparison.turnkeyaiProvider ? { turnkeyaiProvider: modelComparison.turnkeyaiProvider } : {}),
      ...(modelComparison.turnkeyaiModelId ? { turnkeyaiModelId: modelComparison.turnkeyaiModelId } : {}),
      ...(modelComparison.referenceProvider ? { referenceProvider: modelComparison.referenceProvider } : {}),
      ...(modelComparison.referenceModelId ? { referenceModelId: modelComparison.referenceModelId } : {}),
      differenceRecorded: modelComparison.differenceRecorded,
    },
  };
}

function auditTimeoutPolicy(
  scenario: FairnessScenarioSpec,
  naturalReport: NaturalReportShape,
  referenceArtifact: ReferenceArtifactShape
): "passed" | "failed" | "not_required" {
  if (scenario.requiresTimeoutCloseout !== true) return "not_required";
  const comparison = scenario.timeoutComparison;
  if (hasKnownString(comparison?.turnkeyaiPolicy) && hasKnownString(comparison?.referencePolicy)) return "passed";
  if (
    readNumber(naturalReport.timeoutPolicy?.scenarioTimeoutMs) > 0 &&
    (hasKnownString(referenceArtifact.provenance?.timeout) ||
      (typeof referenceArtifact.provenance?.timeout === "object" && referenceArtifact.provenance.timeout !== null))
  ) {
    return "passed";
  }
  if (hasKnownString(comparison?.differenceNote) && hasKnownString(referenceArtifact.provenance?.timeout)) return "passed";
  return "failed";
}

function auditBrowserAccess(
  scenario: FairnessScenarioSpec,
  naturalScenario: NaturalScenarioShape,
  referenceArtifact: ReferenceArtifactShape
): "passed" | "failed" | "not_required" {
  if (scenario.requiresBrowser !== true) return "not_required";
  const naturalBrowserAttempted =
    readNumber(naturalScenario.metrics?.tools?.names) > 0 ||
    readNumber(naturalScenario.metrics?.sessions?.continued) > 0 ||
    readContentHashes(naturalScenario.artifacts).length > 0 ||
    JSON.stringify(naturalScenario).includes("browser");
  const referenceBrowserAttempted = Boolean(referenceArtifact.provenance?.rawBrowserEvidence ?? referenceArtifact.rawBrowserEvidence);
  return naturalBrowserAttempted && referenceBrowserAttempted ? "passed" : "failed";
}

function auditApprovalHandling(
  scenario: FairnessScenarioSpec,
  naturalScenario: NaturalScenarioShape,
  referenceArtifact: ReferenceArtifactShape
): "passed" | "failed" | "not_required" {
  if (scenario.requiresApproval !== true) return "not_required";
  const naturalApprovalConfigured =
    readNumber(naturalScenario.metrics?.approvals?.requested) > 0 ||
    readNumber(naturalScenario.metrics?.approvals?.decided) > 0 ||
    readNumber(naturalScenario.metrics?.approvals?.applied) > 0;
  const referenceApprovalConfigured = containsTerm(
    [referenceArtifact.provenance?.rawToolCalls, referenceArtifact.provenance?.rawToolResults, referenceArtifact.rawToolCalls, referenceArtifact.rawToolResults],
    /\bpermission\.(query|result|applied)\b|approval/i
  );
  return naturalApprovalConfigured && referenceApprovalConfigured ? "passed" : "failed";
}

function auditMemorySeed(
  scenario: FairnessScenarioSpec,
  naturalScenario: NaturalScenarioShape,
  referenceArtifact: ReferenceArtifactShape
): "passed" | "failed" | "not_required" {
  const memoryRequired = /memory|recall/i.test(scenario.scenarioId) || /memory|recall/i.test(scenario.prompt);
  if (!memoryRequired) return "not_required";
  if (hasKnownString(scenario.memoryComparison?.seedId)) return "passed";
  const naturalMemoryEvidence = containsTerm([naturalScenario], /\bmemory_(search|get|flush|invalidate)\b|memory/i);
  const referenceMemoryEvidence = containsTerm([referenceArtifact], /\bmemory_(search|get|flush|invalidate)\b|memory/i);
  return naturalMemoryEvidence && referenceMemoryEvidence ? "passed" : "failed";
}

function auditContinuation(
  scenario: FairnessScenarioSpec,
  naturalScenario: NaturalScenarioShape,
  referenceArtifact: ReferenceArtifactShape
): "passed" | "failed" | "not_required" {
  if (scenario.requiresContinuation !== true) return "not_required";
  const naturalContinuation =
    readNumber(naturalScenario.metrics?.sessions?.continued) > 0 ||
    containsTerm([naturalScenario], /\bsessions_send\b|follow-up|followup|continue|continuation/i);
  const referenceContinuation =
    Boolean(referenceArtifact.followup) ||
    containsTerm([referenceArtifact], /\bsessions_send\b|follow-up|followup|continue|continuation/i);
  return naturalContinuation && referenceContinuation ? "passed" : "failed";
}

function auditScoringRules(scenario: FairnessScenarioSpec): "passed" | "failed" {
  const policy = scenario.promptPolicy;
  if (
    policy?.naturalPrompt !== true ||
    policy.noForcedToolCall !== true ||
    policy.noFixedMarkerGate !== true ||
    policy.noExactAnswerShape !== true
  ) {
    return "failed";
  }
  const scoreKeys = Object.keys(scenario.referenceDimensionScores ?? {});
  return scoreKeys.every((key) => DIMENSION_KEYS.has(key)) ? "passed" : "failed";
}

function readModelComparison(input: {
  scenario: FairnessScenarioSpec;
  naturalReport: NaturalReportShape;
  naturalScenario: NaturalScenarioShape;
  referenceArtifact: ReferenceArtifactShape;
}): {
  comparable: boolean;
  turnkeyaiProvider?: string;
  turnkeyaiModelId?: string;
  referenceProvider?: string;
  referenceModelId?: string;
  differenceRecorded: boolean;
} {
  const turnkeyaiProvider =
    readString(input.scenario.modelComparison?.turnkeyaiProvider) ??
    readString(input.naturalScenario.provider) ??
    readString(input.naturalReport.provider);
  const turnkeyaiModelId =
    readString(input.scenario.modelComparison?.turnkeyaiModelId) ??
    readString(input.naturalScenario.modelId) ??
    readString(input.naturalScenario.model) ??
    readString(input.naturalReport.modelId) ??
    readString(input.naturalReport.model);
  const referenceProvider =
    readString(input.scenario.modelComparison?.referenceProvider) ??
    readString(input.referenceArtifact.provenance?.provider);
  const referenceModelId =
    readString(input.scenario.modelComparison?.referenceModelId) ??
    readString(input.referenceArtifact.provenance?.modelId);
  const differenceRecorded = hasKnownString(input.scenario.modelComparison?.differenceNote);
  const sameModel =
    Boolean(turnkeyaiProvider && turnkeyaiModelId && referenceProvider && referenceModelId) &&
    normalizeComparableToken(turnkeyaiProvider) === normalizeComparableToken(referenceProvider) &&
    normalizeComparableToken(turnkeyaiModelId) === normalizeComparableToken(referenceModelId);
  return {
    comparable: sameModel || (Boolean(referenceProvider && referenceModelId) && differenceRecorded),
    ...(turnkeyaiProvider ? { turnkeyaiProvider } : {}),
    ...(turnkeyaiModelId ? { turnkeyaiModelId } : {}),
    ...(referenceProvider ? { referenceProvider } : {}),
    ...(referenceModelId ? { referenceModelId } : {}),
    differenceRecorded,
  };
}

function findNaturalScenario(report: NaturalReportShape, scenarioId: string): NaturalScenarioShape {
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios : [];
  const match = scenarios.find(
    (scenario): scenario is NaturalScenarioShape =>
      typeof scenario === "object" &&
      scenario !== null &&
      readString((scenario as NaturalScenarioShape).scenario) === scenarioId
  );
  if (!match) throw new Error(`natural report is missing scenario ${scenarioId}`);
  return match;
}

function extractComparableUrls(value: unknown): string[] {
  const text = normalizeUrlEvidenceText(typeof value === "string" ? value : JSON.stringify(value ?? ""));
  const matches = text.match(/https?:\/\/[^\s"'<>),]+/gi) ?? [];
  return [
    ...new Set(
      matches
        .filter((url) => !url.includes("…") && !/%E2%80%A6/i.test(url))
        .map((url) => canonicalizeComparableUrl(url))
        .filter(Boolean)
    ),
  ].sort();
}

function normalizeUrlEvidenceText(text: string): string {
  return text
    .replace(/\\+[nrt]/g, " ")
    .replace(/\\u2026/gi, "…");
}

function canonicalizeComparableUrl(rawUrl: string): string {
  const cleaned = rawUrl.replace(/[`)\].;:,]+$/g, "");
  if (cleaned.includes("://<loopback-host>:<loopback-port>/")) {
    return cleaned.replace(/\/+(\?|$)/, "$1");
  }
  try {
    const url = new URL(cleaned);
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/g, "") : url.pathname;
      return `${url.protocol}//<loopback-host>:<loopback-port>${pathname}${url.search}`;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function sameUrlSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameNonEmptySet(left: readonly string[], right: readonly string[]): boolean {
  return left.length > 0 && sameUrlSet([...left].sort(), [...right].sort());
}

function readContentHashes(value: unknown, comparableUrls: readonly string[] = []): string[] {
  const hashes = new Set<string>();
  const comparableUrlSet = new Set(comparableUrls);
  visitJson(value, (record) => {
    if (typeof record.fixtureContentHashes === "object" && record.fixtureContentHashes !== null) {
      for (const [rawUrl, hash] of Object.entries(record.fixtureContentHashes as Record<string, unknown>)) {
        if (comparableUrlSet.size > 0 && !comparableUrlSet.has(canonicalizeComparableUrl(rawUrl))) continue;
        const value = readString(hash);
        if (value) hashes.add(value);
      }
    }
    for (const key of ["fixtureContentHash", "contentHash", "htmlHash", "sourceHash"]) {
      const value = readString(record[key]);
      if (value) hashes.add(value);
    }
  });
  return [...hashes].sort();
}

function visitJson(value: unknown, visit: (record: Record<string, unknown>) => void, seen = new Set<unknown>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, visit, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  for (const item of Object.values(record)) visitJson(item, visit, seen);
}

function containsTerm(values: readonly unknown[], pattern: RegExp): boolean {
  return values.some((value) => pattern.test(typeof value === "string" ? value : JSON.stringify(value ?? "")));
}

function readReferencePrompt(artifact: ReferenceArtifactShape): string | null {
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
    const content = candidate.content;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
      if (typeof block === "object" && block !== null && readString((block as { text?: unknown }).text)) {
        return [readString((block as { text?: unknown }).text)!];
      }
      return [];
    });
  });
  return userMessages.length > 0 ? userMessages.join("\n") : null;
}

function normalizePrompt(prompt: unknown): string {
  if (typeof prompt !== "string") return "";
  return prompt
    .replace(/\b(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])):\d+/gi, "$1:<loopback-port>")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparableToken(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function resolveInputPath(filePath: string, baseDir: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
}

function readValue(args: string[], index: number, arg: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
  return value;
}

function readNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasKnownString(value: unknown): boolean {
  const text = readString(value);
  return Boolean(text && !/^(unknown|n\/a|null|undefined)$/i.test(text));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRealLlmAbFairnessCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
