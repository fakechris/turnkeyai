import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

import { DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS } from "@turnkeyai/qc-runtime/real-llm-acceptance-defaults";
import type { ThreadMemoryRecord } from "@turnkeyai/core-types/team";
import { FileThreadMemoryStore } from "@turnkeyai/team-store/context/file-thread-memory-store";

interface MissionToolUseE2eOptions {
  modelCatalogPath?: string;
  scenarioTimeoutMs: number;
  scenario: MissionE2eScenario;
  matrix: boolean;
  matrixScenarios?: MissionE2eScenario[];
  natural: boolean;
  naturalScenario: NaturalMissionE2eScenario;
  naturalMatrix: boolean;
  naturalMatrixScenarios?: NaturalMissionE2eScenario[];
  jsonPath?: string;
}

type DaemonChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export type MissionE2eScenario =
  | "basic"
  | "comparison"
  | "followup"
  | "cancel"
  | "approval"
  | "browser-dynamic"
  | "browser-dashboard"
  | "timeout-recovery"
  | "memory-recall"
  | "task-tracking"
  | "product-workbench-brief"
  | "realistic-brief"
  | "budget-limited-closeout"
  | "sub-agent-timeout-closeout";

const CLOSEOUT_ACCEPTANCE_MISSION_SCENARIOS = [
  "budget-limited-closeout",
  "sub-agent-timeout-closeout",
] as const satisfies readonly MissionE2eScenario[];

const FORCED_TOOL_LOOP_CLOSEOUT_REASONS = new Set([
  "pseudo_tool_call",
  "wall_clock_budget",
  "round_limit",
  "sub_agent_timeout",
  "repeated_tool_failure",
]);

const MISSION_E2E_SCENARIOS = [
  ...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS,
  ...CLOSEOUT_ACCEPTANCE_MISSION_SCENARIOS,
] as const satisfies readonly MissionE2eScenario[];

export type NaturalMissionE2eScenario =
  | "natural-comparison-research"
  | "natural-browser-dynamic-page"
  | "natural-browser-dashboard-task"
  | "natural-browser-followup-continuation"
  | "natural-browser-restart-continuation"
  | "natural-browser-cold-recreation-continuation"
  | "natural-browser-profile-lock-recovery"
  | "natural-followup-continuation"
  | "natural-memory-recall"
  | "natural-approval-dry-run-action"
  | "natural-approval-denied-safe-closeout"
  | "natural-approval-pending-state"
  | "natural-browser-unavailable-closeout"
  | "natural-browser-cdp-timeout-closeout"
  | "natural-browser-detached-target-closeout"
  | "natural-browser-attach-failed-closeout"
  | "natural-timeout-partial-closeout"
  | "natural-timeout-followup-continuation"
  | "natural-cancel-active-tool"
  | "natural-cancel-followup-continuation"
  | "natural-long-delegation";

export const NATURAL_MISSION_E2E_SCENARIOS = [
  "natural-comparison-research",
  "natural-browser-dynamic-page",
  "natural-browser-dashboard-task",
  "natural-browser-followup-continuation",
  "natural-browser-restart-continuation",
  "natural-browser-cold-recreation-continuation",
  "natural-browser-profile-lock-recovery",
  "natural-followup-continuation",
  "natural-memory-recall",
  "natural-approval-dry-run-action",
  "natural-approval-denied-safe-closeout",
  "natural-approval-pending-state",
  "natural-browser-unavailable-closeout",
  "natural-browser-cdp-timeout-closeout",
  "natural-browser-detached-target-closeout",
  "natural-browser-attach-failed-closeout",
  "natural-timeout-partial-closeout",
  "natural-timeout-followup-continuation",
  "natural-cancel-active-tool",
  "natural-cancel-followup-continuation",
  "natural-long-delegation",
] as const satisfies readonly NaturalMissionE2eScenario[];

const RENDERED_SLA_BREACHES_VALUE_PATTERN =
  /SLA breach(?:es|\s+count)?[\s\S]{0,100}\b3\b|\b3\b[\s\S]{0,100}SLA breach(?:es|\s+count)?/i;

interface Mission {
  id: string;
  status: string;
  threadId?: string;
  blockers?: number;
}

export interface ActivityEvent {
  id?: string;
  kind: string;
  text: string;
  tMs: number;
  emph?: string;
  runtime?: Record<string, unknown>;
  tags?: string[];
  approvalId?: string;
}

export interface MissionArtifact {
  id: string;
  kind: string;
  label: string;
  path: string;
  sizeBytes?: number;
  lifecycle?: {
    storageBackend?: string;
    refType?: string;
    retentionMs?: number;
    expiresAtMs?: number;
    maxArtifactBytes?: number;
    sessionBudgetBytes?: number;
    cleanupOnSessionClose?: boolean;
    orphanReconciliation?: string;
  };
}

interface MissionObservabilitySnapshot {
  status: string;
  tool: {
    requested: number;
    results: number;
    failed: number;
    cancelled: number;
    timeouts: number;
  };
  sessions: {
    spawned: number;
    continued: number;
  };
  browser?: {
    profileFallbacks?: number;
    latestProfileFallback?: {
      sessionId?: string;
      fallbackDir?: string;
    };
    failureBuckets?: Array<{
      bucket: string;
      count: number;
      latestAtMs: number;
    }>;
  };
  approvals: {
    requested: number;
    applied: number;
    decided: number;
  };
  recovery: {
    events: number;
  };
  liveness: {
    active: number;
    waiting: number;
    stale: number;
  };
  qualityGate: {
    status: string;
    evidenceEvents: number;
    checks?: Array<{
      name?: unknown;
      status?: unknown;
      detail?: unknown;
    }>;
  };
}

const FINAL_MARKER = "TURNKEYAI_MISSION_E2E_OK";
const FIXTURE_MARKER = "TURNKEYAI_MISSION_FIXTURE_OK";
const COMPARISON_FINAL_MARKER = "TURNKEYAI_MISSION_COMPARISON_OK";
const ALPHA_MARKER = "TURNKEYAI_VENDOR_ALPHA_OK";
const BETA_MARKER = "TURNKEYAI_VENDOR_BETA_OK";
const FOLLOWUP_PHASE_MARKER = "TURNKEYAI_MISSION_FOLLOWUP_PHASE_ONE";
const FOLLOWUP_FINAL_MARKER = "TURNKEYAI_MISSION_FOLLOWUP_OK";
const FOLLOWUP_SOURCE_LABEL = "Mission route fixture fetch";
const FOLLOWUP_CONTINUATION_SOURCE_LABEL = "Mission route follow-up continuation";
const CANCEL_FINAL_MARKER = "TURNKEYAI_MISSION_CANCEL_OK";
const APPROVAL_MARKER = "TURNKEYAI_APPROVAL_FIXTURE_OK";
const APPROVAL_FINAL_MARKER = "TURNKEYAI_MISSION_APPROVAL_OK";
const DYNAMIC_BROWSER_MARKER = "TURNKEYAI_DYNAMIC_BROWSER_OK";
const DYNAMIC_BROWSER_FINAL_MARKER = "TURNKEYAI_MISSION_DYNAMIC_BROWSER_OK";
const DASHBOARD_TRIAGE_MARKER = "TURNKEYAI_DASHBOARD_TRIAGE_OK";
const DASHBOARD_TRIAGE_FINAL_MARKER = "TURNKEYAI_MISSION_DASHBOARD_TRIAGE_OK";
const TIMEOUT_FINAL_MARKER = "TURNKEYAI_MISSION_TIMEOUT_OK";
const BUDGET_CLOSEOUT_FINAL_MARKER = "TURNKEYAI_MISSION_BUDGET_CLOSEOUT_OK";
const SUB_AGENT_TIMEOUT_CLOSEOUT_FINAL_MARKER = "TURNKEYAI_MISSION_SUB_AGENT_TIMEOUT_CLOSEOUT_OK";
const MEMORY_SETUP_MARKER = "TURNKEYAI_MISSION_MEMORY_SETUP_OK";
const MEMORY_SOURCE_MARKER = "TURNKEYAI_MEMORY_RECALL_SOURCE_OK";
const MEMORY_RECALL_FINAL_MARKER = "TURNKEYAI_MISSION_MEMORY_RECALL_OK";
const TASK_TRACKING_FINAL_MARKER = "TURNKEYAI_MISSION_TASK_TRACKING_OK";
const PRODUCT_WORKBENCH_FINAL_MARKER = "TURNKEYAI_MISSION_PRODUCT_WORKBENCH_OK";
const PRODUCT_ORCHESTRATION_MARKER = "TURNKEYAI_PRODUCT_ORCHESTRATION_OK";
const PRODUCT_BRIDGE_MARKER = "TURNKEYAI_PRODUCT_BRIDGE_OK";
const PRODUCT_WORKBENCH_SIGNAL_MARKER = "TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK";
const PRODUCT_ORCHESTRATION_SOURCE_LABEL = "Orchestration research";
const PRODUCT_BRIDGE_SOURCE_LABEL = "Bridge capability research";
const PRODUCT_SIGNALS_SOURCE_LABEL = "Product signals browser";
const REALISTIC_BRIEF_FINAL_MARKER = "TURNKEYAI_MISSION_REALISTIC_BRIEF_OK";

interface FixtureServer {
  server: Server;
  basicUrl: string;
  alphaUrl: string;
  betaUrl: string;
  slowUrl: string;
  cancelResumeUrl: string;
  cancelResumeStateUrl: string;
  approvalUrl: string;
  dynamicUrl: string;
  dashboardUrl: string;
  orchestrationUrl: string;
  bridgeUrl: string;
  productSignalsUrl: string;
}

export interface ScenarioSpec {
  scenario: MissionE2eScenario;
  title: string;
  desc: string;
  finalMarker: string;
  evidenceMarkers: string[];
  expectedSourceLabels?: string[];
  answerTerms: string[];
  answerPatterns?: Array<{ label: string; pattern: RegExp }>;
  evidenceLinePatterns?: Array<{ label: string; pattern: RegExp }>;
  forbiddenPatterns?: Array<{ label: string; pattern: RegExp }>;
  allowLabeledEvidenceWithoutBullets?: boolean;
  allowAtLeastBullets?: boolean;
  minBytes?: number;
  maxBytes?: number;
  expectedSpawnCalls: number;
  expectedSpawnCallsMax?: number;
  expectedSendCalls: number;
  expectedSendCallsMax?: number;
  expectedToolResults: number;
  expectedToolResultsMax?: number;
  expectedToolFailures?: number;
  expectedToolTimeouts?: number;
  expectedSpawnedSessions: number;
  expectedSpawnedSessionsMax?: number;
  expectedContinuedSessions: number;
  expectedContinuedSessionsMax?: number;
  minEvidenceEvents: number;
  expectedBullets: number;
  expectedQualityGateStatus?: string;
  expectedCloseoutReason?: string;
  expectedCloseoutEvidenceAvailable?: string;
}

export interface MissionScenarioResult {
  scenario: MissionE2eScenario;
  mission: Mission;
  timeline: ActivityEvent[];
  metrics: MissionObservabilitySnapshot;
  final: ActivityEvent;
  quality: ReturnType<typeof evaluateFinalQuality>;
}

export interface MissionE2eScenarioReport {
  scenario: MissionE2eScenario;
  missionId: string;
  status: string;
  threadId?: string;
  timelineEvents: number;
  toolEvents: number;
  qualityGate: string;
  metrics: {
    tools: {
      requested: number;
      results: number;
      failed: number;
      cancelled: number;
      timeouts: number;
    };
    sessions: {
      spawned: number;
      continued: number;
    };
    browser: {
      profileFallbacks: number;
      latestProfileFallback?: {
        sessionId?: string;
        fallbackDir?: string;
      };
      failureBuckets: Array<{
        bucket: string;
        count: number;
        latestAtMs: number;
      }>;
    };
    approvals: {
      requested: number;
      decided: number;
      applied: number;
    };
    liveness: {
      active: number;
      waiting: number;
      stale: number;
    };
    qualityChecks: Array<{
      name: string;
      status: string;
      detail: string;
    }>;
    evidenceEvents: number;
    recoveryEvents: number;
  };
  final: {
    bytes: number;
    bullets: number;
    qualityFailures: string[];
    closeout?: {
      reason: string;
      evidenceAvailable?: string;
    };
  };
}

export interface MissionE2eJsonReport {
  kind: "turnkeyai.mission-e2e.report";
  status: "passed" | "failed";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  scenarios: MissionE2eScenarioReport[];
}

export interface NaturalScenarioSpec {
  scenario: NaturalMissionE2eScenario;
  title: string;
  desc: string;
  minBytes: number;
  minToolResults: number;
  maxToolResults: number;
  minSpawnedSessions: number;
  maxSpawnedSessions: number;
  minContinuedSessions?: number;
  requiresBrowser: boolean;
  requiresApproval: boolean;
  approvalDecision?: "approved" | "denied" | "pending";
  expectedMissionStatus?: "done" | "needs_approval" | "blocked";
  requiresProfileFallback?: boolean;
  requiredBrowserFailureBuckets?: string[];
  requiresCancellation?: boolean;
  requiresTimeout?: boolean;
  allowRecoveredTimeout?: boolean;
  allowToolFailure: boolean;
  minEvidenceEvents: number;
  requiredAnswerTerms: string[];
  requiredAnswerPatterns?: Array<{ label: string; pattern: RegExp }>;
  requiredEvidencePatterns?: Array<{ label: string; pattern: RegExp }>;
  requiredToolNames?: string[];
  forbiddenPatterns?: Array<{ label: string; pattern: RegExp }>;
  allowedWeakAnswerSignals?: string[];
  requiresArtifactLifecycle?: boolean;
}

export interface NaturalMissionScenarioResult {
  scenario: NaturalMissionE2eScenario;
  mission: Mission;
  timeline: ActivityEvent[];
  metrics: MissionObservabilitySnapshot;
  artifacts?: MissionArtifact[];
  final: ActivityEvent;
  quality: NaturalMissionQuality;
}

export interface NaturalMissionQuality {
  status: "passed" | "failed";
  completed: boolean;
  stuckOrLoop: boolean;
  reasonableToolUse: boolean;
  browserUsed: boolean;
  profileFallbackFree: boolean;
  subAgentCompleted: boolean;
  approvalExercised: boolean;
  finalAnswerHasEvidence: boolean;
  finalAnswerUseful: boolean;
  sourceCoverage: NaturalSourceCoverage;
  weakAnswerSignals: string[];
  failures: string[];
}

export interface NaturalSourceCoverage {
  answerTerms: {
    covered: number;
    total: number;
    missing: string[];
  };
  answerPatterns: {
    covered: number;
    total: number;
    missing: string[];
  };
  evidencePatterns: {
    covered: number;
    total: number;
    missing: string[];
  };
  evidenceEvents: {
    observed: number;
    required: number;
  };
  residualRiskVisible: boolean;
  unsupportedClaims: string[];
}

export interface NaturalMissionScenarioReport {
  scenario: NaturalMissionE2eScenario;
  missionId: string;
  status: string;
  threadId?: string;
  timelineEvents: number;
  toolEvents: number;
  qualityGate: string;
  metrics: MissionE2eScenarioReport["metrics"];
  artifacts: {
    count: number;
    withLifecycle: number;
    kinds: string[];
  };
  natural: {
    status: "passed" | "failed";
    completed: boolean;
    stuckOrLoop: boolean;
    reasonableToolUse: boolean;
    browserUsed: boolean;
    profileFallbackFree: boolean;
    subAgentCompleted: boolean;
    approvalExercised: boolean;
    finalAnswerHasEvidence: boolean;
    finalAnswerUseful: boolean;
    sourceCoverage: NaturalSourceCoverage;
    weakAnswerSignals: string[];
    failures: string[];
  };
  final: {
    bytes: number;
    excerpt: string;
  };
}

export interface NaturalMissionE2eJsonReport {
  kind: "turnkeyai.natural-mission-e2e.report";
  evidenceMode: "natural-real-llm";
  progressClaim: "capability";
  promptPolicy: {
    forbidsContractGateLanguage: boolean;
    forbiddenPatterns: string[];
  };
  requiredQualitySignals: string[];
  status: "passed" | "failed";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  scenarios: NaturalMissionScenarioReport[];
}

class NaturalMissionScenarioQualityError extends Error {
  constructor(
    message: string,
    readonly result: NaturalMissionScenarioResult
  ) {
    super(message);
    this.name = "NaturalMissionScenarioQualityError";
  }
}

interface WorkerSessionRecord {
  workerRunKey: string;
  context?: {
    toolCallId?: string;
  };
  state: {
    status: string;
    workerType?: string;
    lastResult?: {
      status?: string;
      summary?: string;
    };
    lastError?: { message?: string };
    continuationDigest?: {
      summary?: string;
      reason?: string;
    };
  };
}

interface ApprovalRecord {
  id: string;
  missionId: string;
  action: string;
  decision?: unknown;
  requestedAtMs?: number;
}

function parseOptions(args: string[]): MissionToolUseE2eOptions {
  const options: MissionToolUseE2eOptions = {
    scenarioTimeoutMs: 180_000,
    scenario: "basic",
    matrix: false,
    natural: false,
    naturalScenario: "natural-comparison-research",
    naturalMatrix: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h" || arg === "help") {
      printHelp(0);
    }
    if (arg === "--list-scenarios") {
      console.log(MISSION_E2E_SCENARIOS.join("\n"));
      process.exit(0);
    }
    if (arg === "--list-natural-scenarios") {
      console.log(NATURAL_MISSION_E2E_SCENARIOS.join("\n"));
      process.exit(0);
    }
    if (arg === "--matrix") {
      options.matrix = true;
      continue;
    }
    if (arg === "--natural") {
      options.natural = true;
      continue;
    }
    if (arg === "--natural-matrix") {
      options.natural = true;
      options.naturalMatrix = true;
      continue;
    }
    if (arg === "--model-catalog") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --model-catalog");
      }
      options.modelCatalogPath = value;
      index += 1;
      continue;
    }
    if (arg === "--scenario") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --scenario");
      }
      options.scenario = parseScenarioName(value, "--scenario");
      index += 1;
      continue;
    }
    if (arg === "--natural-scenario") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --natural-scenario");
      }
      options.natural = true;
      options.naturalScenario = parseNaturalScenarioName(value, "--natural-scenario");
      index += 1;
      continue;
    }
    if (arg === "--matrix-scenarios") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --matrix-scenarios");
      }
      options.matrixScenarios = parseScenarioList(value);
      index += 1;
      continue;
    }
    if (arg === "--natural-matrix-scenarios") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --natural-matrix-scenarios");
      }
      options.natural = true;
      options.naturalMatrixScenarios = parseNaturalScenarioList(value);
      index += 1;
      continue;
    }
    if (arg === "--scenario-timeout-ms") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --scenario-timeout-ms");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        throw new Error("--scenario-timeout-ms must be a positive integer");
      }
      options.scenarioTimeoutMs = parsed;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --json");
      }
      options.jsonPath = value;
      index += 1;
      continue;
    }
  }
  return options;
}

function parseScenarioList(value: string): MissionE2eScenario[] {
  const scenarios = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (scenarios.length === 0) {
    throw new Error("--matrix-scenarios must include at least one scenario");
  }
  return scenarios.map((scenario) => parseScenarioName(scenario, "--matrix-scenarios"));
}

function parseNaturalScenarioList(value: string): NaturalMissionE2eScenario[] {
  const scenarios = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (scenarios.length === 0) {
    throw new Error("--natural-matrix-scenarios must include at least one scenario");
  }
  return scenarios.map((scenario) => parseNaturalScenarioName(scenario, "--natural-matrix-scenarios"));
}

function parseScenarioName(value: string, argName: string): MissionE2eScenario {
  for (const scenario of MISSION_E2E_SCENARIOS) {
    if (value === scenario) return scenario;
  }
  throw new Error(`${argName} must be one of: ${MISSION_E2E_SCENARIOS.join(", ")}`);
}

function parseNaturalScenarioName(value: string, argName: string): NaturalMissionE2eScenario {
  for (const scenario of NATURAL_MISSION_E2E_SCENARIOS) {
    if (value === scenario) return scenario;
  }
  throw new Error(`${argName} must be one of: ${NATURAL_MISSION_E2E_SCENARIOS.join(", ")}`);
}

function printHelp(exitCode: number): never {
  const lines = [
    "TurnkeyAI mission tool-use real LLM E2E",
    "",
    "Usage:",
    "  npm run mission:e2e -- [options]",
    "  npm run mission:e2e:matrix -- [options]",
    "  npm run mission:e2e:natural -- [options]",
    "",
    "Options:",
    "  --scenario <name>              Run one scenario. Default: basic",
    "  --matrix                       Run the default real-LLM mission acceptance matrix",
    "  --matrix-scenarios <a,b,...>   Run a comma-separated scenario matrix",
    "  --natural                      Run one natural mission scenario. Default: natural-comparison-research",
    "  --natural-matrix               Run the natural mission acceptance matrix",
    "  --natural-scenario <name>      Run one natural mission scenario",
    "  --natural-matrix-scenarios <a,b,...> Run a comma-separated natural scenario matrix",
    "  --scenario-timeout-ms <ms>     Per-scenario timeout. Default: 180000",
    "  --model-catalog <path>         Model catalog path. Also reads TURNKEYAI_MODEL_CATALOG, models.local.json, models.json",
    "  --json <path>                  Write a structured acceptance evidence report",
    "  --list-scenarios              Print scenario names and exit",
    "  --help, -h                    Show this help and exit",
    "",
    "Scenarios:",
    `  ${MISSION_E2E_SCENARIOS.join(", ")}`,
    "Natural scenarios:",
    `  ${NATURAL_MISSION_E2E_SCENARIOS.join(", ")}`,
    "",
    "Examples:",
    "  npm run mission:e2e -- --scenario comparison --model-catalog models.local.json --scenario-timeout-ms 240000",
    "  npm run mission:e2e:matrix -- --model-catalog models.local.json --scenario-timeout-ms 240000",
  ];
  const output = exitCode === 0 ? console.log : console.error;
  output(lines.join("\n"));
  process.exit(exitCode);
}

async function main(options: MissionToolUseE2eOptions): Promise<void> {
  const startedAt = Date.now();
  const modelCatalogPath = resolveModelCatalogPath(options.modelCatalogPath);
  const fixture = await startFixtureServer();
  await assertRenderedFixtureEvidenceHidden(fixture);
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-mission-e2e-"));
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = `mission-e2e-${Date.now()}`;
  const scenarios = options.matrixScenarios ?? (options.matrix ? [...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS] : [options.scenario]);
  assertSupportedScenarioMix(scenarios);
  const shouldUseBudgetLimitedDaemon = !options.natural && scenarios.includes("budget-limited-closeout");
  let daemonEnvOverrides: Record<string, string> = {};
  let daemon = startDaemon({
    runtimeRoot,
    port,
    token,
    modelCatalogPath,
    ...(shouldUseBudgetLimitedDaemon ? { agentToolMaxRounds: 1 } : {}),
  });
  const restartDaemon = async (envOverrides?: Record<string, string>) => {
    daemonEnvOverrides = envOverrides ?? daemonEnvOverrides;
    await stopDaemon(daemon.child);
    daemon = startDaemon({
      runtimeRoot,
      port,
      token,
      modelCatalogPath,
      extraEnv: daemonEnvOverrides,
      ...(shouldUseBudgetLimitedDaemon ? { agentToolMaxRounds: 1 } : {}),
    });
    await waitForDaemonHealth({ baseUrl, daemon, timeoutMs: 30_000 });
  };
  try {
    await waitForDaemonHealth({ baseUrl, daemon, timeoutMs: 20_000 });
    if (options.natural) {
      const naturalScenarios =
        options.naturalMatrixScenarios ??
        (options.naturalMatrix ? [...NATURAL_MISSION_E2E_SCENARIOS] : [options.naturalScenario]);
      const naturalResults: NaturalMissionScenarioResult[] = [];
      for (const [index, scenario] of naturalScenarios.entries()) {
        const scenarioStartedAt = Date.now();
        console.log(formatNaturalMissionScenarioStart({ scenario, index: index + 1, total: naturalScenarios.length }));
        try {
          const result = await runNaturalMissionScenario({
            baseUrl,
            token,
            fixture,
            runtimeRoot,
            scenario,
            timeoutMs: options.scenarioTimeoutMs,
            restartDaemon,
          });
          naturalResults.push(result);
          console.log(
            formatNaturalMissionScenarioPass({
              result,
              index: index + 1,
              total: naturalScenarios.length,
              durationMs: Date.now() - scenarioStartedAt,
            })
          );
          printNaturalScenarioResult(result);
        } catch (error) {
          if (error instanceof NaturalMissionScenarioQualityError) {
            naturalResults.push(error.result);
            if (options.jsonPath) {
              writeNaturalMissionE2eJsonReport(
                options.jsonPath,
                buildNaturalMissionE2eJsonReport({
                  startedAt,
                  completedAt: Date.now(),
                  results: naturalResults,
                })
              );
              console.log(`natural-mission-e2e-json: ${path.resolve(options.jsonPath)}`);
            }
          }
          throw new Error(
            `natural mission scenario ${scenario} failed: ${errorMessage(error)}\n\ndaemon output tail:\n${daemon.output()}`
          );
        }
      }
      if (options.jsonPath) {
        const completedAt = Date.now();
        const report = buildNaturalMissionE2eJsonReport({
          startedAt,
          completedAt,
          results: naturalResults,
        });
        writeNaturalMissionE2eJsonReport(options.jsonPath, report);
        console.log(`natural-mission-e2e-json: ${path.resolve(options.jsonPath)}`);
      }
      if (naturalScenarios.length > 1) {
        console.log(`natural mission real llm matrix passed: ${naturalScenarios.join(",")}`);
      }
      return;
    }
    const results: MissionScenarioResult[] = [];
    for (const [index, scenario] of scenarios.entries()) {
      const scenarioStartedAt = Date.now();
      console.log(formatMissionScenarioStart({ scenario, index: index + 1, total: scenarios.length }));
      try {
        const result = await runMissionScenario({
          baseUrl,
          token,
          fixture,
          runtimeRoot,
          scenario,
          timeoutMs: options.scenarioTimeoutMs,
        });
        results.push(result);
        console.log(
          formatMissionScenarioPass({
            result,
            index: index + 1,
            total: scenarios.length,
            durationMs: Date.now() - scenarioStartedAt,
          })
        );
        printScenarioResult(result);
      } catch (error) {
        throw new Error(
          `mission scenario ${scenario} failed: ${errorMessage(error)}\n\ndaemon output tail:\n${daemon.output()}`
        );
      }
    }
    if (options.jsonPath) {
      const completedAt = Date.now();
      const report = buildMissionE2eJsonReport({
        startedAt,
        completedAt,
        results,
      });
      writeMissionE2eJsonReport(options.jsonPath, report);
      console.log(`mission-e2e-json: ${path.resolve(options.jsonPath)}`);
    }
    if (scenarios.length > 1) {
      console.log(`mission tool-use real llm matrix passed: ${scenarios.join(",")}`);
    }
  } finally {
    await stopDaemon(daemon.child);
    await closeServer(fixture.server);
    if (process.env.TURNKEYAI_E2E_KEEP_RUNTIME_ROOT === "1") {
      console.log(`mission-e2e-runtime-root: ${runtimeRoot}`);
    } else {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }
}

function assertSupportedScenarioMix(scenarios: MissionE2eScenario[]): void {
  if (!scenarios.includes("budget-limited-closeout")) {
    return;
  }
  const allowedWithBudget = new Set<MissionE2eScenario>(CLOSEOUT_ACCEPTANCE_MISSION_SCENARIOS);
  const incompatible = scenarios.filter((scenario) => !allowedWithBudget.has(scenario));
  if (incompatible.length > 0) {
    throw new Error(
      [
        "budget-limited-closeout runs the daemon with a deliberately low tool-round budget.",
        `Run it separately from normal mission scenarios. Incompatible scenario(s): ${incompatible.join(", ")}`,
      ].join(" ")
    );
  }
}

async function runMissionScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: MissionE2eScenario;
  timeoutMs: number;
}): Promise<MissionScenarioResult> {
  if (input.scenario === "followup") {
    return runMissionFollowupScenario(input);
  }
  if (input.scenario === "cancel") {
    return runMissionCancelScenario(input);
  }
  if (input.scenario === "approval") {
    return runMissionApprovalScenario(input);
  }
  if (input.scenario === "timeout-recovery") {
    return runMissionTimeoutScenario(input);
  }
  if (input.scenario === "budget-limited-closeout") {
    return runMissionCloseoutScenario(input);
  }
  if (input.scenario === "sub-agent-timeout-closeout") {
    return runMissionCloseoutScenario(input);
  }
  if (input.scenario === "memory-recall") {
    return runMissionMemoryRecallScenario(input);
  }
  if (input.scenario === "task-tracking") {
    return runMissionTaskTrackingScenario(input);
  }
  const spec = buildScenarioSpec(input.scenario, input.fixture);
  const mission = await createMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "mission route must create a linked team thread");
  const result = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: spec.finalMarker,
    timeoutMs: input.timeoutMs,
    failFastDoneWithoutMarker: true,
  });
  assertMissionToolUseTimeline(result.timeline, spec);
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  assertMissionMetrics(metrics, spec);
  const final = findFinalEvent(result.timeline, spec.finalMarker);
  assert.ok(final, "mission timeline must include a final assistant answer");
  const quality = evaluateFinalQuality(final.text, spec);
  assert.deepEqual(
    quality.failures,
    [],
    `mission ${input.scenario} final answer quality failures: ${quality.failures.join("; ")}\n${final.text}`
  );
  return { scenario: input.scenario, mission: result.mission, timeline: result.timeline, metrics, final, quality };
}

async function runMissionFollowupScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  scenario: MissionE2eScenario;
  timeoutMs: number;
}): Promise<MissionScenarioResult> {
  const initialSpec = buildFollowupInitialSpec(input.fixture);
  const finalSpec = buildScenarioSpec("followup", input.fixture);
  const mission = await createMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec: initialSpec,
  });
  assert.ok(mission.threadId, "mission route must create a linked team thread");

  const initial = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: initialSpec.finalMarker,
    timeoutMs: input.timeoutMs,
    failFastDoneWithoutMarker: true,
  });
  assertMissionToolUseTimeline(initial.timeline, initialSpec);
  const sessionKey = extractFirstSessionKey(initial.timeline);
  assert.ok(sessionKey, "follow-up E2E requires a session_key from the phase-one sessions_spawn result");

  await requestJson<{ accepted: boolean; missionId: string }>({
    method: "POST",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/messages`,
    token: input.token,
    body: {
      content: [
        "Continue this mission from the existing explore child session.",
        "Use sessions_send with the session_key from the prior sessions_spawn tool result instead of spawning another child session.",
        `The sessions_send input must include label "${FOLLOWUP_CONTINUATION_SOURCE_LABEL}" so mission source coverage can be audited.`,
        "Do not call sessions_spawn, sessions_history, or sessions_list.",
        `The sessions_send message must ask the child to return its complete final report containing ${FIXTURE_MARKER}.`,
        `The final answer may include ${FOLLOWUP_FINAL_MARKER} only once, inside the first bullet of the exact shape below; it must also include ${FIXTURE_MARKER}, ${FOLLOWUP_SOURCE_LABEL}, ${FOLLOWUP_CONTINUATION_SOURCE_LABEL}, sessions_send, the phrase same session, the phrase no duplicate session, and the exact words residual risk.`,
        "Use this exact final answer shape after sessions_send returns:",
        "## Evidence",
        `- same-session follow-up: ${FOLLOWUP_FINAL_MARKER}; sessions_send reused the same session with no duplicate session; source ${FOLLOWUP_CONTINUATION_SOURCE_LABEL}.`,
        `- fixture evidence: ${FIXTURE_MARKER} confirmed from source ${FOLLOWUP_SOURCE_LABEL} by the continued child session.`,
        "- residual risk: this validates local fixture continuity only, not an external source.",
        "Do not create a separate bullet, heading, or paragraph for the final success marker.",
        "Do not include source URLs or raw session keys; name sessions_send, same-session reuse, both source labels, and the fixture marker instead.",
        "Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    },
  });

  const result = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: finalSpec.finalMarker,
    timeoutMs: input.timeoutMs,
  });
  assertMissionToolUseTimeline(result.timeline, finalSpec);
  assertFollowupReusedSession(result.timeline, sessionKey);
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  assertMissionMetrics(metrics, finalSpec);
  const final = findFinalEvent(result.timeline, finalSpec.finalMarker);
  assert.ok(final, "mission timeline must include a follow-up final assistant answer");
  const quality = evaluateFinalQuality(final.text, finalSpec);
  assert.deepEqual(
    quality.failures,
    [],
    `mission followup final answer quality failures: ${quality.failures.join("; ")}\n${final.text}`
  );
  return { scenario: "followup", mission: result.mission, timeline: result.timeline, metrics, final, quality };
}

async function runMissionCancelScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  scenario: MissionE2eScenario;
  timeoutMs: number;
}): Promise<MissionScenarioResult> {
  const spec = buildScenarioSpec("cancel", input.fixture);
  const mission = await createMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "mission route must create a linked team thread");

  const activeCall = await waitForToolCallEvent({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    toolName: "sessions_spawn",
    timeoutMs: Math.min(input.timeoutMs, 60_000),
  });
  await requestJson<{ cancelled: boolean }>({
    method: "POST",
    url: `${input.baseUrl}/message/cancel-tools`,
    token: input.token,
    body: {
      messageId: activeCall.messageId,
      threadId: mission.threadId,
      toolCallIds: [activeCall.toolCallId],
      reason: "operator cancelled mission e2e slow tool",
    },
  });

  const result = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: spec.finalMarker,
    timeoutMs: input.timeoutMs,
    failFastDoneWithoutMarker: true,
  });
  assertMissionCancelTimeline(result.timeline, spec);
  const cancelledSessionKey = extractFirstSessionKey(result.timeline);
  assert.ok(cancelledSessionKey, "cancel E2E requires a session_key from the cancelled sessions_spawn result");
  await assertWorkerSessionCancelled({
    baseUrl: input.baseUrl,
    token: input.token,
    threadId: mission.threadId,
    workerRunKey: cancelledSessionKey,
  });
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  assertMissionCancelMetrics(metrics, spec);
  const final = findFinalEvent(result.timeline, spec.finalMarker);
  assert.ok(final, "mission timeline must include a cancellation final assistant answer");
  const quality = evaluateFinalQuality(final.text, spec);
  assert.deepEqual(
    quality.failures,
    [],
    `mission cancel final answer quality failures: ${quality.failures.join("; ")}\n${final.text}`
  );
  return { scenario: "cancel", mission: result.mission, timeline: result.timeline, metrics, final, quality };
}

async function runMissionApprovalScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  scenario: MissionE2eScenario;
  timeoutMs: number;
}): Promise<MissionScenarioResult> {
  const spec = buildScenarioSpec("approval", input.fixture);
  const mission = await createMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "mission route must create a linked team thread");

  const approval = await waitForApprovalRequest({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    action: "browser.form.submit",
    timeoutMs: Math.min(input.timeoutMs, 90_000),
  });
  await requestJson<unknown>({
    method: "POST",
    url: `${input.baseUrl}/approvals/${encodeURIComponent(approval.id)}/decision`,
    token: input.token,
    body: {
      decision: "approved",
      decidedBy: "mission-e2e",
      reason: "approving isolated mission E2E approval-gate fixture",
    },
  });

  const result = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: spec.finalMarker,
    timeoutMs: input.timeoutMs,
  });
  assertMissionToolUseTimeline(result.timeline, spec);
  assertMissionApprovalTimeline(result.timeline, spec, approval.id);
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  assertMissionApprovalMetrics(metrics, spec);
  const final = findFinalEvent(result.timeline, spec.finalMarker);
  assert.ok(final, "mission timeline must include an approval final assistant answer");
  const quality = evaluateFinalQuality(final.text, spec);
  assert.deepEqual(
    quality.failures,
    [],
    `mission approval final answer quality failures: ${quality.failures.join("; ")}\n${final.text}`
  );
  return { scenario: "approval", mission: result.mission, timeline: result.timeline, metrics, final, quality };
}

async function runMissionTimeoutScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  scenario: MissionE2eScenario;
  timeoutMs: number;
}): Promise<MissionScenarioResult> {
  const spec = buildScenarioSpec("timeout-recovery", input.fixture);
  const mission = await createMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "mission route must create a linked team thread");

  const result = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: spec.finalMarker,
    timeoutMs: input.timeoutMs,
    failFastDoneWithoutMarker: true,
  });
  assertMissionTimeoutTimeline(result.timeline, spec);
  const timeoutSessionKey = extractFirstSessionKey(result.timeline);
  assert.ok(timeoutSessionKey, "timeout E2E requires a session_key from the timed-out sessions_spawn result");
  await assertWorkerSessionResumableAfterTimeout({
    baseUrl: input.baseUrl,
    token: input.token,
    threadId: mission.threadId,
    workerRunKey: timeoutSessionKey,
  });
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  assertMissionTimeoutMetrics(metrics, spec);
  const final = findFinalEvent(result.timeline, spec.finalMarker);
  assert.ok(final, "mission timeline must include a timeout final assistant answer");
  const quality = evaluateFinalQuality(final.text, spec);
  assert.deepEqual(
    quality.failures,
    [],
    `mission timeout final answer quality failures: ${quality.failures.join("; ")}\n${final.text}`
  );
  return { scenario: "timeout-recovery", mission: result.mission, timeline: result.timeline, metrics, final, quality };
}

async function runMissionCloseoutScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  scenario: MissionE2eScenario;
  timeoutMs: number;
}): Promise<MissionScenarioResult> {
  const spec = buildScenarioSpec(input.scenario, input.fixture);
  const mission = await createMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "mission route must create a linked team thread");

  const result = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: spec.finalMarker,
    timeoutMs: input.timeoutMs,
    failFastDoneWithoutMarker: true,
  });
  if (input.scenario === "sub-agent-timeout-closeout") {
    assertMissionTimeoutTimeline(result.timeline, spec);
    const timeoutSessionKey = extractFirstSessionKey(result.timeline);
    assert.ok(timeoutSessionKey, "sub-agent timeout closeout E2E requires a session_key from sessions_spawn");
    await assertWorkerSessionResumableAfterTimeout({
      baseUrl: input.baseUrl,
      token: input.token,
      threadId: mission.threadId,
      workerRunKey: timeoutSessionKey,
    });
  } else {
    assertMissionBudgetCloseoutTimeline(result.timeline, spec);
  }
  assertMissionCloseoutTimeline(result.timeline, spec);

  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  assertMissionMetrics(metrics, spec);
  const final = findFinalEvent(result.timeline, spec.finalMarker);
  assert.ok(final, "mission timeline must include a closeout final assistant answer");
  const quality = evaluateFinalQuality(final.text, spec);
  assert.deepEqual(
    quality.failures,
    [],
    `mission ${input.scenario} final answer quality failures: ${quality.failures.join("; ")}\n${final.text}`
  );
  return { scenario: input.scenario, mission: result.mission, timeline: result.timeline, metrics, final, quality };
}

async function runMissionMemoryRecallScenario(input: {
  baseUrl: string;
  token: string;
  runtimeRoot: string;
  fixture: FixtureServer;
  scenario: MissionE2eScenario;
  timeoutMs: number;
}): Promise<MissionScenarioResult> {
  const setupSpec = buildMemoryRecallSetupSpec();
  const finalSpec = buildScenarioSpec("memory-recall", input.fixture);
  const mission = await createMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec: setupSpec,
  });
  assert.ok(mission.threadId, "memory recall E2E requires a linked team thread");

  await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: setupSpec.finalMarker,
    timeoutMs: input.timeoutMs,
    failFastDoneWithoutMarker: true,
  });

  await seedMemoryRecallFixture({
    runtimeRoot: input.runtimeRoot,
    threadId: mission.threadId,
    markerMode: "natural",
  });

  await requestJson<{ accepted: boolean; missionId: string }>({
    method: "POST",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/messages`,
    token: input.token,
    body: {
      content: finalSpec.desc,
    },
  });

  const result = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: finalSpec.finalMarker,
    timeoutMs: input.timeoutMs,
  });
  assertMissionMemoryRecallTimeline(result.timeline, finalSpec);
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  assertMissionMetrics(metrics, finalSpec);
  const final = findFinalEvent(result.timeline, finalSpec.finalMarker);
  assert.ok(final, "mission timeline must include a memory recall final assistant answer");
  const quality = evaluateFinalQuality(final.text, finalSpec);
  assert.deepEqual(
    quality.failures,
    [],
    `mission memory recall final answer quality failures: ${quality.failures.join("; ")}\n${final.text}`
  );
  return { scenario: "memory-recall", mission: result.mission, timeline: result.timeline, metrics, final, quality };
}

async function runMissionTaskTrackingScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  scenario: MissionE2eScenario;
  timeoutMs: number;
}): Promise<MissionScenarioResult> {
  const spec = buildScenarioSpec("task-tracking", input.fixture);
  const mission = await createMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "task tracking E2E requires a linked team thread");

  const result = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: spec.finalMarker,
    timeoutMs: input.timeoutMs,
    failFastDoneWithoutMarker: true,
  });
  assertMissionTaskTrackingTimeline(result.timeline, spec);
  const workItems = await requestJson<Array<{ id: string; title: string; status: string; progress?: number; output?: string }>>({
    method: "GET",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/work-items`,
    token: input.token,
  });
  const tracked = workItems.find((item) => item.title === "Verify Helios-47 rollout note");
  const matchingItems = workItems.filter((item) => item.title === "Verify Helios-47 rollout note");
  assert.ok(tracked, "task tracking E2E must create the expected work item");
  assert.equal(matchingItems.length, 1, "task tracking E2E must not persist duplicate work items with the same title");
  assert.equal(tracked.status, "done", "task tracking E2E must update the created work item to done");
  assert.equal(tracked.progress, 1, "task tracking E2E must update the created work item progress to 1");
  assert.match(tracked.output ?? "", /Task tracking acceptance complete/i);
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  assertMissionMetrics(metrics, spec);
  const final = findFinalEvent(result.timeline, spec.finalMarker);
  assert.ok(final, "mission timeline must include a task tracking final assistant answer");
  const quality = evaluateFinalQuality(final.text, spec);
  assert.deepEqual(
    quality.failures,
    [],
    `mission task tracking final answer quality failures: ${quality.failures.join("; ")}\n${final.text}`
  );
  return { scenario: "task-tracking", mission: result.mission, timeline: result.timeline, metrics, final, quality };
}

async function runNaturalMissionScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
  restartDaemon?: (envOverrides?: Record<string, string>) => Promise<void>;
}): Promise<NaturalMissionScenarioResult> {
  if (input.scenario === "natural-followup-continuation") {
    return runNaturalFollowupScenario(input);
  }
  if (input.scenario === "natural-browser-followup-continuation") {
    return runNaturalBrowserFollowupScenario(input);
  }
  if (input.scenario === "natural-browser-restart-continuation") {
    return runNaturalBrowserRestartContinuationScenario(input);
  }
  if (input.scenario === "natural-browser-cold-recreation-continuation") {
    return runNaturalBrowserColdRecreationScenario(input);
  }
  if (input.scenario === "natural-browser-profile-lock-recovery") {
    return runNaturalBrowserProfileLockRecoveryScenario(input);
  }
  if (input.scenario === "natural-memory-recall") {
    return runNaturalMemoryRecallScenario(input);
  }
  if (input.scenario === "natural-approval-dry-run-action") {
    return runNaturalApprovalScenario(input);
  }
  if (input.scenario === "natural-approval-denied-safe-closeout") {
    return runNaturalApprovalDeniedScenario(input);
  }
  if (input.scenario === "natural-approval-pending-state") {
    return runNaturalApprovalPendingScenario(input);
  }
  if (input.scenario === "natural-browser-unavailable-closeout") {
    return runNaturalBrowserUnavailableScenario(input);
  }
  if (input.scenario === "natural-browser-cdp-timeout-closeout") {
    return runNaturalBrowserCdpTimeoutScenario(input);
  }
  if (input.scenario === "natural-browser-detached-target-closeout") {
    return runNaturalBrowserDetachedTargetScenario(input);
  }
  if (input.scenario === "natural-browser-attach-failed-closeout") {
    return runNaturalBrowserAttachFailedScenario(input);
  }
  if (input.scenario === "natural-cancel-active-tool") {
    return runNaturalCancelScenario(input);
  }
  if (input.scenario === "natural-cancel-followup-continuation") {
    return runNaturalCancelFollowupScenario(input);
  }
  if (input.scenario === "natural-timeout-followup-continuation") {
    return runNaturalTimeoutFollowupScenario(input);
  }
  const spec = buildNaturalScenarioSpec(input.scenario, input.fixture);
  assertNaturalPromptAllowed(spec.desc);
  const mission = await createNaturalMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "natural mission route must create a linked team thread");
  const result = await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
    allowBlocked: spec.allowToolFailure,
  });
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  const artifacts = await waitForMissionArtifactsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: spec.requiresArtifactLifecycle ? 20_000 : 1_000,
    requireLifecycle: spec.requiresArtifactLifecycle === true,
  });
  const final = findLatestThoughtEvent(result.timeline);
  assert.ok(final, "natural mission timeline must include a final assistant answer");
  const quality = evaluateNaturalMissionQuality({
    spec,
    mission: result.mission,
    timeline: result.timeline,
    metrics,
    artifacts,
    final,
  });
  const scenarioResult = { scenario: input.scenario, mission: result.mission, timeline: result.timeline, metrics, artifacts, final, quality };
  assertNaturalMissionQualityPassed(scenarioResult, `natural mission ${input.scenario} quality failures`);
  return scenarioResult;
}

async function runNaturalBrowserUnavailableScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
  restartDaemon?: (envOverrides?: Record<string, string>) => Promise<void>;
}): Promise<NaturalMissionScenarioResult> {
  const { restartDaemon } = input;
  assert.ok(restartDaemon, "natural browser unavailable closeout requires a daemon restart hook");
  const unavailableCdpPort = await allocatePort();
  await restartDaemon({
    TURNKEYAI_BROWSER_TRANSPORT: "direct-cdp",
    TURNKEYAI_BROWSER_CDP_ENDPOINT: `http://127.0.0.1:${unavailableCdpPort}`,
  });
  try {
    const spec = buildNaturalScenarioSpec("natural-browser-unavailable-closeout", input.fixture);
    assertNaturalPromptAllowed(spec.desc);
    const mission = await createNaturalMission({
      baseUrl: input.baseUrl,
      token: input.token,
      spec,
    });
    assert.ok(mission.threadId, "natural browser unavailable mission requires a linked team thread");
    const result = await waitForNaturalMissionCompletion({
      baseUrl: input.baseUrl,
      token: input.token,
      missionId: mission.id,
      timeoutMs: input.timeoutMs,
      allowBlocked: true,
    });
    const metrics = await waitForMissionMetricsSettled({
      baseUrl: input.baseUrl,
      token: input.token,
      missionId: mission.id,
      timeoutMs: 20_000,
    });
    const final = findLatestThoughtEvent(result.timeline);
    assert.ok(final, "natural browser unavailable mission timeline must include a final assistant answer");
    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics,
      final,
    });
    const scenarioResult = { scenario: input.scenario, mission: result.mission, timeline: result.timeline, metrics, final, quality };
    assertNaturalMissionQualityPassed(scenarioResult, "natural mission natural-browser-unavailable-closeout quality failures");
    return scenarioResult;
  } finally {
    await restartDaemon({});
  }
}

async function runNaturalBrowserCdpTimeoutScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
  restartDaemon?: (envOverrides?: Record<string, string>) => Promise<void>;
}): Promise<NaturalMissionScenarioResult> {
  const { restartDaemon } = input;
  assert.ok(restartDaemon, "natural browser CDP timeout closeout requires a daemon restart hook");
  await restartDaemon({
    TURNKEYAI_E2E_BROWSER_FORCE_FAILURE_BUCKET: "cdp_command_timeout",
    TURNKEYAI_E2E_BROWSER_FORCE_FAILURE_ACTION: "snapshot",
    TURNKEYAI_E2E_BROWSER_FORCE_FAILURE_REPEAT: "1",
  });
  try {
    const spec = buildNaturalScenarioSpec("natural-browser-cdp-timeout-closeout", input.fixture);
    assertNaturalPromptAllowed(spec.desc);
    const mission = await createNaturalMission({
      baseUrl: input.baseUrl,
      token: input.token,
      spec,
    });
    assert.ok(mission.threadId, "natural browser CDP timeout mission requires a linked team thread");
    const result = await waitForNaturalMissionCompletion({
      baseUrl: input.baseUrl,
      token: input.token,
      missionId: mission.id,
      timeoutMs: input.timeoutMs,
      allowBlocked: true,
    });
    const metrics = await waitForMissionMetricsSettled({
      baseUrl: input.baseUrl,
      token: input.token,
      missionId: mission.id,
      timeoutMs: 20_000,
    });
    const final = findLatestThoughtEvent(result.timeline);
    assert.ok(final, "natural browser CDP timeout mission timeline must include a final assistant answer");
    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics,
      final,
    });
    const scenarioResult = { scenario: input.scenario, mission: result.mission, timeline: result.timeline, metrics, final, quality };
    assertNaturalMissionQualityPassed(scenarioResult, "natural mission natural-browser-cdp-timeout-closeout quality failures");
    return scenarioResult;
  } finally {
    await restartDaemon({});
  }
}

async function runNaturalBrowserDetachedTargetScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
  restartDaemon?: (envOverrides?: Record<string, string>) => Promise<void>;
}): Promise<NaturalMissionScenarioResult> {
  const { restartDaemon } = input;
  assert.ok(restartDaemon, "natural browser detached-target closeout requires a daemon restart hook");
  await restartDaemon({
    TURNKEYAI_E2E_BROWSER_FORCE_FAILURE_BUCKET: "detached_target",
    TURNKEYAI_E2E_BROWSER_FORCE_FAILURE_ACTION: "snapshot",
    TURNKEYAI_E2E_BROWSER_FORCE_FAILURE_REPEAT: "1",
  });
  try {
    const spec = buildNaturalScenarioSpec("natural-browser-detached-target-closeout", input.fixture);
    assertNaturalPromptAllowed(spec.desc);
    const mission = await createNaturalMission({
      baseUrl: input.baseUrl,
      token: input.token,
      spec,
    });
    assert.ok(mission.threadId, "natural browser detached-target mission requires a linked team thread");
    const result = await waitForNaturalMissionCompletion({
      baseUrl: input.baseUrl,
      token: input.token,
      missionId: mission.id,
      timeoutMs: input.timeoutMs,
      allowBlocked: true,
    });
    const metrics = await waitForMissionMetricsSettled({
      baseUrl: input.baseUrl,
      token: input.token,
      missionId: mission.id,
      timeoutMs: 20_000,
    });
    const final = findLatestThoughtEvent(result.timeline);
    assert.ok(final, "natural browser detached-target mission timeline must include a final assistant answer");
    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics,
      final,
    });
    const scenarioResult = { scenario: input.scenario, mission: result.mission, timeline: result.timeline, metrics, final, quality };
    assertNaturalMissionQualityPassed(scenarioResult, "natural mission natural-browser-detached-target-closeout quality failures");
    return scenarioResult;
  } finally {
    await restartDaemon({});
  }
}

async function runNaturalBrowserAttachFailedScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
  restartDaemon?: (envOverrides?: Record<string, string>) => Promise<void>;
}): Promise<NaturalMissionScenarioResult> {
  const { restartDaemon } = input;
  assert.ok(restartDaemon, "natural browser attach-failed closeout requires a daemon restart hook");
  await restartDaemon({
    TURNKEYAI_E2E_BROWSER_FORCE_FAILURE_BUCKET: "attach_failed",
    TURNKEYAI_E2E_BROWSER_FORCE_FAILURE_ACTION: "target_attach",
    TURNKEYAI_E2E_BROWSER_FORCE_FAILURE_REPEAT: "1",
  });
  try {
    const spec = buildNaturalScenarioSpec("natural-browser-attach-failed-closeout", input.fixture);
    assertNaturalPromptAllowed(spec.desc);
    const mission = await createNaturalMission({
      baseUrl: input.baseUrl,
      token: input.token,
      spec,
    });
    assert.ok(mission.threadId, "natural browser attach-failed mission requires a linked team thread");
    const result = await waitForNaturalMissionCompletion({
      baseUrl: input.baseUrl,
      token: input.token,
      missionId: mission.id,
      timeoutMs: input.timeoutMs,
      allowBlocked: true,
    });
    const metrics = await waitForMissionMetricsSettled({
      baseUrl: input.baseUrl,
      token: input.token,
      missionId: mission.id,
      timeoutMs: 20_000,
    });
    const final = findLatestThoughtEvent(result.timeline);
    assert.ok(final, "natural browser attach-failed mission timeline must include a final assistant answer");
    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics,
      final,
    });
    const scenarioResult = { scenario: input.scenario, mission: result.mission, timeline: result.timeline, metrics, final, quality };
    assertNaturalMissionQualityPassed(scenarioResult, "natural mission natural-browser-attach-failed-closeout quality failures");
    return scenarioResult;
  } finally {
    await restartDaemon({});
  }
}

async function runNaturalFollowupScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
}): Promise<NaturalMissionScenarioResult> {
  const spec = buildNaturalScenarioSpec("natural-followup-continuation", input.fixture);
  assertNaturalPromptAllowed(spec.desc);
  const mission = await createNaturalMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "natural follow-up mission requires a linked team thread");
  await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
  });
  const initialTimeline = await requestJson<ActivityEvent[]>({
    method: "GET",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/timeline?limit=300`,
    token: input.token,
  });
  const initialFinal = findLatestThoughtEvent(initialTimeline);
  assert.ok(initialFinal, "natural follow-up phase one must include an assistant answer");
  const initialSessionKey = extractFirstSessionKey(initialTimeline);
  assert.ok(initialSessionKey, "natural follow-up phase one must expose a reusable child session key");
  const followup = [
    "Continue from the previous work on this mission.",
    "Ask the same Vendor Alpha research thread to revisit its notes and turn the evidence into a decision note for a product lead.",
    "Keep continuity with that earlier research thread rather than starting the same Vendor Alpha work from scratch.",
    "Keep the answer source-bounded and call out any remaining uncertainty from the collected evidence.",
  ].join("\n");
  assertNaturalPromptAllowed(followup);
  await requestJson<{ accepted: boolean; missionId: string }>({
    method: "POST",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/messages`,
    token: input.token,
    body: { content: followup },
  });
  const result = await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
    afterThoughtMs: initialFinal.tMs,
    ...(initialFinal.id ? { afterThoughtId: initialFinal.id } : {}),
  });
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  const final = findLatestThoughtEvent(result.timeline);
  assert.ok(final, "natural follow-up mission must include a final assistant answer");
  const quality = evaluateNaturalMissionQuality({
    spec,
    mission: result.mission,
    timeline: result.timeline,
    metrics,
    final,
  });
  assertNaturalColdRecreationFollowup({
    timeline: result.timeline,
    phaseOneFinal: initialFinal,
    expectedSessionKey: initialSessionKey,
  });
  const scenarioResult = { scenario: "natural-followup-continuation" as const, mission: result.mission, timeline: result.timeline, metrics, final, quality };
  assertNaturalMissionQualityPassed(scenarioResult, "natural mission follow-up quality failures");
  return scenarioResult;
}

async function runNaturalBrowserFollowupScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
}): Promise<NaturalMissionScenarioResult> {
  const spec = buildNaturalScenarioSpec("natural-browser-followup-continuation", input.fixture);
  assertNaturalPromptAllowed(spec.desc);
  const mission = await createNaturalMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "natural browser follow-up mission requires a linked team thread");

  await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
  });
  const initialTimeline = await requestJson<ActivityEvent[]>({
    method: "GET",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/timeline?limit=300`,
    token: input.token,
  });
  const initialFinal = findLatestThoughtEvent(initialTimeline);
  assert.ok(initialFinal, "natural browser follow-up phase one must include an assistant answer");
  const initialSessionKey = extractSessionKeyForSpawnAgent(initialTimeline, "browser");
  assert.ok(initialSessionKey, "natural browser follow-up phase one must expose a reusable browser session key");

  const followup = [
    "Continue the operations dashboard review from the browser context already used in this mission.",
    "Re-check the rendered dashboard state if needed, then explain whether the escalation owner and next action still look correct.",
    "Keep the answer grounded in the dashboard evidence and call out any residual uncertainty from the page state.",
  ].join("\n");
  assertNaturalPromptAllowed(followup);
  await requestJson<{ accepted: boolean; missionId: string }>({
    method: "POST",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/messages`,
    token: input.token,
    body: { content: followup },
  });

  const result = await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
    afterThoughtMs: initialFinal.tMs,
    ...(initialFinal.id ? { afterThoughtId: initialFinal.id } : {}),
  });
  assertNaturalFollowupReusedExistingSession({
    timeline: result.timeline,
    phaseOneFinal: initialFinal,
    expectedSessionKey: initialSessionKey,
  });
  assertNaturalFollowupResultIncludes({
    timeline: result.timeline,
    phaseOneFinal: initialFinal,
    patterns: [
      { label: "continued rendered queue depth", pattern: /Queue depth[\s\S]{0,80}\b11\b|\b11\b[\s\S]{0,80}Queue depth/i },
      { label: "continued rendered SLA breaches", pattern: RENDERED_SLA_BREACHES_VALUE_PATTERN },
      { label: "continued rendered owner", pattern: /Incident Commander/i },
    ],
  });
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  const final = findLatestThoughtEvent(result.timeline);
  assert.ok(final, "natural browser follow-up mission must include a final assistant answer");
  const quality = evaluateNaturalMissionQuality({
    spec,
    mission: result.mission,
    timeline: result.timeline,
    metrics,
    final,
  });
  const scenarioResult = { scenario: "natural-browser-followup-continuation" as const, mission: result.mission, timeline: result.timeline, metrics, final, quality };
  assertNaturalMissionQualityPassed(scenarioResult, "natural mission browser follow-up quality failures");
  return scenarioResult;
}

async function runNaturalBrowserRestartContinuationScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
  restartDaemon?: () => Promise<void>;
}): Promise<NaturalMissionScenarioResult> {
  assert.ok(input.restartDaemon, "natural browser restart continuation requires a daemon restart hook");
  const spec = buildNaturalScenarioSpec("natural-browser-restart-continuation", input.fixture);
  assertNaturalPromptAllowed(spec.desc);
  const mission = await createNaturalMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "natural browser restart continuation mission requires a linked team thread");

  await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
  });
  const initialTimeline = await requestJson<ActivityEvent[]>({
    method: "GET",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/timeline?limit=300`,
    token: input.token,
  });
  const initialFinal = findLatestThoughtEvent(initialTimeline);
  assert.ok(initialFinal, "natural browser restart phase one must include an assistant answer");
  const initialSessionKey = extractSessionKeyForSpawnAgent(initialTimeline, "browser");
  assert.ok(initialSessionKey, "natural browser restart phase one must expose a reusable browser session key");

  await input.restartDaemon();

  const followup = [
    "Continue the operations dashboard review from before the daemon restart.",
    "Use the existing browser context if it is still recoverable; if the browser has to reconnect or reopen the page, keep that visible in the answer.",
    "Re-check the rendered dashboard state and give the operator the current owner, next action, and residual uncertainty.",
  ].join("\n");
  assertNaturalPromptAllowed(followup);
  await requestJson<{ accepted: boolean; missionId: string }>({
    method: "POST",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/messages`,
    token: input.token,
    body: { content: followup },
  });

  const result = await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
    afterThoughtMs: initialFinal.tMs,
    ...(initialFinal.id ? { afterThoughtId: initialFinal.id } : {}),
  });
  assertNaturalFollowupReusedExistingSession({
    timeline: result.timeline,
    phaseOneFinal: initialFinal,
    expectedSessionKey: initialSessionKey,
  });
  assertNaturalFollowupResultIncludes({
    timeline: result.timeline,
    phaseOneFinal: initialFinal,
    patterns: [
      { label: "restarted rendered queue depth", pattern: /Queue depth[\s\S]{0,80}\b11\b|\b11\b[\s\S]{0,80}Queue depth/i },
      { label: "restarted rendered SLA breaches", pattern: RENDERED_SLA_BREACHES_VALUE_PATTERN },
      { label: "restarted rendered owner", pattern: /Incident Commander/i },
    ],
  });
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  const final = findLatestThoughtEvent(result.timeline);
  assert.ok(final, "natural browser restart continuation mission must include a final assistant answer");
  const quality = evaluateNaturalMissionQuality({
    spec,
    mission: result.mission,
    timeline: result.timeline,
    metrics,
    final,
  });
  const scenarioResult = { scenario: "natural-browser-restart-continuation" as const, mission: result.mission, timeline: result.timeline, metrics, final, quality };
  assertNaturalMissionQualityPassed(scenarioResult, "natural mission browser restart continuation quality failures");
  return scenarioResult;
}

async function runNaturalBrowserColdRecreationScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
}): Promise<NaturalMissionScenarioResult> {
  const spec = buildNaturalScenarioSpec("natural-browser-cold-recreation-continuation", input.fixture);
  assertNaturalPromptAllowed(spec.desc);
  const mission = await createNaturalMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "natural browser cold recreation mission requires a linked team thread");

  await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
  });
  const initialTimeline = await requestJson<ActivityEvent[]>({
    method: "GET",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/timeline?limit=300`,
    token: input.token,
  });
  const initialFinal = findLatestThoughtEvent(initialTimeline);
  assert.ok(initialFinal, "natural browser cold recreation phase one must include an assistant answer");
  const initialSessionKey = extractSessionKeyForSpawnAgent(initialTimeline, "browser");
  assert.ok(initialSessionKey, "natural browser cold recreation phase one must expose a reusable browser session key");
  const initialBrowserSessionId = extractBrowserSessionIdForSpawnAgent(initialTimeline, "browser");
  assert.ok(initialBrowserSessionId, "natural browser cold recreation phase one must expose a browser session id");

  const revokeResult = await requestJson<{ browserSessionId: string; status: string; reason: string }>({
    method: "POST",
    url: `${input.baseUrl}/browser-sessions/${encodeURIComponent(initialBrowserSessionId)}/revoke`,
    token: input.token,
    body: {
      threadId: mission.threadId,
      missionId: mission.id,
      reason: "natural cold recreation gate",
    },
  });
  assert.equal(
    revokeResult.browserSessionId,
    initialBrowserSessionId,
    "natural browser cold recreation must revoke the phase-one browser session before follow-up"
  );
  assert.equal(
    revokeResult.status,
    "closed",
    "natural browser cold recreation must confirm browser session closure before follow-up"
  );

  const followup = [
    "Continue the operations dashboard review from the same browser-backed work.",
    "The earlier browser session may no longer be available; if that happens, recover by reopening the same read-only dashboard and make that recovery visible.",
    "Re-check the rendered dashboard state and give the operator the current owner, next action, and residual uncertainty.",
  ].join("\n");
  assertNaturalPromptAllowed(followup);
  await requestJson<{ accepted: boolean; missionId: string }>({
    method: "POST",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/messages`,
    token: input.token,
    body: { content: followup },
  });

  const result = await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
    afterThoughtMs: initialFinal.tMs,
    ...(initialFinal.id ? { afterThoughtId: initialFinal.id } : {}),
  });
  assertNaturalFollowupReusedExistingSession({
    timeline: result.timeline,
    phaseOneFinal: initialFinal,
    expectedSessionKey: initialSessionKey,
  });
  assertNaturalFollowupResultIncludes({
    timeline: result.timeline,
    phaseOneFinal: initialFinal,
    patterns: [
      {
        label: "browser recovery evidence",
        pattern:
          /Resume mode:\s*(?:warm|cold)|["']resumeMode["']\s*:\s*["'](?:warm|cold)["']|(?:warm|cold)[- ]recovery|(?:warm|cold)[- ]recreat(?:ion|ed)|re[- ]?open(?:ed)?|recovery confirmed|new browser session/i,
      },
      { label: "recovered rendered queue depth", pattern: /Queue depth[\s\S]{0,80}\b11\b|\b11\b[\s\S]{0,80}Queue depth/i },
      { label: "recovered rendered SLA breaches", pattern: RENDERED_SLA_BREACHES_VALUE_PATTERN },
      { label: "recovered rendered owner", pattern: /Incident Commander/i },
    ],
  });
  const resumedBrowserSessionId = extractBrowserSessionIdForSendAfter(result.timeline, initialFinal);
  assert.ok(resumedBrowserSessionId, "natural browser cold recreation follow-up must expose a browser session id");
  assert.notEqual(
    resumedBrowserSessionId,
    initialBrowserSessionId,
    "natural browser cold recreation must use a replacement browser session after the original was revoked"
  );
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  const final = findLatestThoughtEvent(result.timeline);
  assert.ok(final, "natural browser cold recreation mission must include a final assistant answer");
  const quality = evaluateNaturalMissionQuality({
    spec,
    mission: result.mission,
    timeline: result.timeline,
    metrics,
    final,
  });
  const scenarioResult = { scenario: "natural-browser-cold-recreation-continuation" as const, mission: result.mission, timeline: result.timeline, metrics, final, quality };
  assertNaturalMissionQualityPassed(scenarioResult, "natural mission browser cold recreation quality failures");
  return scenarioResult;
}

async function runNaturalBrowserProfileLockRecoveryScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
  restartDaemon?: (envOverrides?: Record<string, string>) => Promise<void>;
}): Promise<NaturalMissionScenarioResult> {
  const { restartDaemon } = input;
  assert.ok(restartDaemon, "natural browser profile-lock recovery requires a daemon restart hook");
  const profileLockSentinel = path.join(input.runtimeRoot, "browser-profile-lock-sentinel.json");
  await rm(profileLockSentinel, { force: true });
  await restartDaemon({
    TURNKEYAI_E2E_BROWSER_PROFILE_LOCK_SENTINEL: profileLockSentinel,
    TURNKEYAI_E2E_BROWSER_PROFILE_LOCK_ALWAYS: "1",
  });
  const spec = buildNaturalScenarioSpec("natural-browser-profile-lock-recovery", input.fixture);
  try {
    await armAnyBrowserProfileLockSentinel(profileLockSentinel);
    assertNaturalPromptAllowed(spec.desc);
    const mission = await createNaturalMission({
      baseUrl: input.baseUrl,
      token: input.token,
      spec,
    });
    assert.ok(mission.threadId, "natural browser profile-lock mission requires a linked team thread");

    const result = await waitForNaturalMissionCompletion({
      baseUrl: input.baseUrl,
      token: input.token,
      missionId: mission.id,
      timeoutMs: input.timeoutMs,
    });
    const metrics = await waitForMissionMetricsSettled({
      baseUrl: input.baseUrl,
      token: input.token,
      missionId: mission.id,
      timeoutMs: 20_000,
    });
    const final = findLatestThoughtEvent(result.timeline);
    assert.ok(final, "natural browser profile-lock mission must include a final assistant answer");
    const quality = evaluateNaturalMissionQuality({
      spec,
      mission: result.mission,
      timeline: result.timeline,
      metrics,
      final,
    });
    const scenarioResult = { scenario: "natural-browser-profile-lock-recovery" as const, mission: result.mission, timeline: result.timeline, metrics, final, quality };
    assertNaturalMissionQualityPassed(scenarioResult, "natural mission browser profile-lock recovery quality failures");
    return scenarioResult;
  } finally {
    await rm(profileLockSentinel, { force: true });
    await restartDaemon({});
  }
}

async function runNaturalMemoryRecallScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
}): Promise<NaturalMissionScenarioResult> {
  const spec = buildNaturalScenarioSpec("natural-memory-recall", input.fixture);
  assertNaturalPromptAllowed(spec.desc);
  const setupPrompt = [
    "Start a launch-planning thread for Helios-47.",
    "No research is needed yet; briefly acknowledge that the mission can continue when launch context is available.",
  ].join("\n");
  assertNaturalPromptAllowed(setupPrompt);
  const mission = await requestJson<Mission>({
    method: "POST",
    url: `${input.baseUrl}/missions`,
    token: input.token,
    body: {
      title: "Natural durable memory recall",
      mode: "research",
      desc: setupPrompt,
      owner: "natural-e2e",
      ownerLabel: "Natural E2E",
    },
  });
  assert.ok(mission.threadId, "natural memory recall mission requires a linked team thread");

  const setupResult = await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
  });
  const setupFinal = findLatestThoughtEvent(setupResult.timeline);
  assert.ok(setupFinal, "natural memory recall setup must include an assistant answer");
  await sleep(1_000);

  await seedMemoryRecallFixture({
    runtimeRoot: input.runtimeRoot,
    threadId: mission.threadId,
    markerMode: "natural",
  });

  await requestJson<{ accepted: boolean; missionId: string }>({
    method: "POST",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/messages`,
    token: input.token,
    body: { content: spec.desc },
  });

  const result = await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
    afterThoughtMs: setupFinal.tMs,
    ...(setupFinal.id ? { afterThoughtId: setupFinal.id } : {}),
  });
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  const final = findLatestThoughtEvent(result.timeline);
  assert.ok(final, "natural memory recall mission must include a final assistant answer");
  const quality = evaluateNaturalMissionQuality({
    spec,
    mission: result.mission,
    timeline: result.timeline,
    metrics,
    final,
  });
  const scenarioResult = { scenario: "natural-memory-recall" as const, mission: result.mission, timeline: result.timeline, metrics, final, quality };
  assertNaturalMissionQualityPassed(scenarioResult, "natural mission memory recall quality failures");
  return scenarioResult;
}

async function runNaturalApprovalScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
}): Promise<NaturalMissionScenarioResult> {
  const spec = buildNaturalScenarioSpec("natural-approval-dry-run-action", input.fixture);
  assertNaturalPromptAllowed(spec.desc);
  const mission = await createNaturalMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "natural approval mission requires a linked team thread");
  const result = await driveNaturalApprovalDecisionsUntilComplete({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
    decision: "approved",
  });
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  const final = findLatestThoughtEvent(result.timeline);
  assert.ok(final, "natural approval mission must include a final assistant answer");
  const quality = evaluateNaturalMissionQuality({
    spec,
    mission: result.mission,
    timeline: result.timeline,
    metrics,
    final,
  });
  const scenarioResult = { scenario: "natural-approval-dry-run-action" as const, mission: result.mission, timeline: result.timeline, metrics, final, quality };
  assertNaturalMissionQualityPassed(scenarioResult, "natural mission approval quality failures");
  return scenarioResult;
}

async function runNaturalApprovalDeniedScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
}): Promise<NaturalMissionScenarioResult> {
  const spec = buildNaturalScenarioSpec("natural-approval-denied-safe-closeout", input.fixture);
  assertNaturalPromptAllowed(spec.desc);
  const mission = await createNaturalMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "natural approval-denied mission requires a linked team thread");
  const result = await driveNaturalApprovalDecisionsUntilComplete({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
    decision: "denied",
  });
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  const final = findLatestThoughtEvent(result.timeline);
  assert.ok(final, "natural approval-denied mission must include a final assistant answer");
  const quality = evaluateNaturalMissionQuality({
    spec,
    mission: result.mission,
    timeline: result.timeline,
    metrics,
    final,
  });
  const scenarioResult = { scenario: "natural-approval-denied-safe-closeout" as const, mission: result.mission, timeline: result.timeline, metrics, final, quality };
  assertNaturalMissionQualityPassed(scenarioResult, "natural mission approval-denied quality failures");
  return scenarioResult;
}

async function runNaturalApprovalPendingScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
}): Promise<NaturalMissionScenarioResult> {
  const spec = buildNaturalScenarioSpec("natural-approval-pending-state", input.fixture);
  assertNaturalPromptAllowed(spec.desc);
  const mission = await createNaturalMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "natural approval-pending mission requires a linked team thread");
  const result = await waitForNaturalApprovalPendingState({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
  });
  const final = findLatestApprovalQueryEvent(result.timeline);
  assert.ok(final, "natural approval-pending mission must include a permission.query event");
  const quality = evaluateNaturalMissionQuality({
    spec,
    mission: result.mission,
    timeline: result.timeline,
    metrics: result.metrics,
    final,
  });
  const scenarioResult = { scenario: "natural-approval-pending-state" as const, mission: result.mission, timeline: result.timeline, metrics: result.metrics, final, quality };
  assertNaturalMissionQualityPassed(scenarioResult, "natural mission approval-pending quality failures");
  return scenarioResult;
}

async function runNaturalCancelScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
}): Promise<NaturalMissionScenarioResult> {
  const spec = buildNaturalScenarioSpec("natural-cancel-active-tool", input.fixture);
  assertNaturalPromptAllowed(spec.desc);
  const mission = await createNaturalMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "natural cancellation mission requires a linked team thread");

  const activeCall = await waitForToolCallEventOrNull({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    toolName: "sessions_spawn",
    timeoutMs: Math.min(input.timeoutMs, 60_000),
  });
  const activeSession = activeCall
    ? await waitForRunningWorkerSessionForToolCall({
        baseUrl: input.baseUrl,
        token: input.token,
        threadId: mission.threadId,
        toolCallId: activeCall.toolCallId,
        timeoutMs: Math.min(input.timeoutMs, 60_000),
      }).catch(() => null)
    : null;
  await requestJson<{ cancelled: boolean }>({
    method: "POST",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/cancel`,
    token: input.token,
    body: {
      reason: "natural e2e cancelled active source verification",
    },
  });

  const result = await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    allowBlocked: true,
    timeoutMs: input.timeoutMs,
  });
  assertNaturalCancellationTimeline(result.timeline);
  if (activeSession) {
    const cancelledSessionKey = extractFirstSessionKey(result.timeline);
    if (cancelledSessionKey) {
      assert.equal(cancelledSessionKey, activeSession.workerRunKey, "cancelled tool result must refer to the active worker session that was cancelled");
    }
    await assertWorkerSessionCancelled({
      baseUrl: input.baseUrl,
      token: input.token,
      threadId: mission.threadId,
      workerRunKey: cancelledSessionKey ?? activeSession.workerRunKey,
    });
  }
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
    expectedStatus: "blocked",
  });
  const final = findLatestCancellationEvent(result.timeline) ?? findLatestThoughtEvent(result.timeline);
  assert.ok(final, "natural cancellation mission must include a final cancellation or assistant answer");
  const quality = evaluateNaturalMissionQuality({
    spec,
    mission: result.mission,
    timeline: result.timeline,
    metrics,
    final,
  });
  const scenarioResult = { scenario: "natural-cancel-active-tool" as const, mission: result.mission, timeline: result.timeline, metrics, final, quality };
  assertNaturalMissionQualityPassed(scenarioResult, "natural mission cancellation quality failures");
  return scenarioResult;
}

async function runNaturalCancelFollowupScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
}): Promise<NaturalMissionScenarioResult> {
  const spec = buildNaturalScenarioSpec("natural-cancel-followup-continuation", input.fixture);
  assertNaturalPromptAllowed(spec.desc);
  const mission = await createNaturalMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "natural cancellation follow-up mission requires a linked team thread");

  const activeCall = await waitForToolCallEvent({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    toolName: "sessions_spawn",
    timeoutMs: Math.min(input.timeoutMs, 60_000),
  });
  const activeSession = await waitForRunningWorkerSessionForToolCall({
    baseUrl: input.baseUrl,
    token: input.token,
    threadId: mission.threadId,
    toolCallId: activeCall.toolCallId,
    timeoutMs: Math.min(input.timeoutMs, 60_000),
  });
  await waitForCancelResumeFixtureRequest({
    fixture: input.fixture,
    timeoutMs: Math.min(input.timeoutMs, 60_000),
  });
  await requestJson<{ cancelled: boolean }>({
    method: "POST",
    url: `${input.baseUrl}/message/cancel-tools`,
    token: input.token,
    body: {
      messageId: activeCall.messageId,
      threadId: mission.threadId,
      toolCallIds: [activeCall.toolCallId],
      reason: "natural e2e cancelled first source verification before follow-up",
    },
  });

  await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
  });
  const initialTimeline = await requestJson<ActivityEvent[]>({
    method: "GET",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/timeline?limit=300`,
    token: input.token,
  });
  assertNaturalCancellationTimeline(initialTimeline);
  const initialFinal = findLatestThoughtEvent(initialTimeline);
  assert.ok(initialFinal, "natural cancellation follow-up phase one must include an assistant answer");
  const cancelledSessionKey = extractCancelledSessionKey(initialTimeline);
  assert.ok(cancelledSessionKey, "natural cancellation follow-up requires a session_key from the cancelled sessions_spawn result");
  assert.equal(cancelledSessionKey, activeSession.workerRunKey, "cancelled tool result must refer to the active worker session that was cancelled");
  await assertWorkerSessionCancelled({
    baseUrl: input.baseUrl,
    token: input.token,
    threadId: mission.threadId,
    workerRunKey: cancelledSessionKey,
  });

  const followup = [
    "Continue from the cancelled source-check attempt in this mission.",
    "Resume the existing source-check context if possible, let the source finish now, and turn the outcome into a release-risk note.",
    "Separate verified facts from unverified items, describe residual risk, and explain how the earlier cancellation affects confidence.",
  ].join("\n");
  assertNaturalPromptAllowed(followup);
  await requestJson<{ accepted: boolean; missionId: string }>({
    method: "POST",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/messages`,
    token: input.token,
    body: { content: followup },
  });

  const result = await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
    afterThoughtMs: initialFinal.tMs,
    ...(initialFinal.id ? { afterThoughtId: initialFinal.id } : {}),
  });
  assertNaturalFollowupReusedExistingSession({
    timeline: result.timeline,
    phaseOneFinal: initialFinal,
    expectedSessionKey: cancelledSessionKey,
  });
  await assertWorkerSessionDoneAfterResume({
    baseUrl: input.baseUrl,
    token: input.token,
    threadId: mission.threadId,
    workerRunKey: cancelledSessionKey,
  });
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  const final = findLatestThoughtEvent(result.timeline);
  assert.ok(final, "natural cancellation follow-up mission must include a final assistant answer");
  const quality = evaluateNaturalMissionQuality({
    spec,
    mission: result.mission,
    timeline: result.timeline,
    metrics,
    final,
  });
  const scenarioResult = { scenario: "natural-cancel-followup-continuation" as const, mission: result.mission, timeline: result.timeline, metrics, final, quality };
  assertNaturalMissionQualityPassed(scenarioResult, "natural mission cancellation follow-up quality failures");
  return scenarioResult;
}

async function runNaturalTimeoutFollowupScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  runtimeRoot: string;
  scenario: NaturalMissionE2eScenario;
  timeoutMs: number;
}): Promise<NaturalMissionScenarioResult> {
  const spec = buildNaturalScenarioSpec("natural-timeout-followup-continuation", input.fixture);
  assertNaturalPromptAllowed(spec.desc);
  const mission = await createNaturalMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "natural timeout follow-up mission requires a linked team thread");

  await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
    allowBlocked: true,
  });
  const initialTimeline = await requestJson<ActivityEvent[]>({
    method: "GET",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/timeline?limit=300`,
    token: input.token,
  });
  const initialFinal = findLatestThoughtEvent(initialTimeline);
  assert.ok(initialFinal, "natural timeout follow-up phase one must include an assistant answer");
  const timeoutSessionKey = extractTimedOutSessionKey(initialTimeline);
  assert.ok(timeoutSessionKey, "natural timeout follow-up requires a session_key from the timed-out sessions_spawn result");
  await assertWorkerSessionResumableAfterTimeout({
    baseUrl: input.baseUrl,
    token: input.token,
    threadId: mission.threadId,
    workerRunKey: timeoutSessionKey,
  });

  const followup = [
    "Continue from the slow-source attempt in this mission.",
    "Resume the existing source-check context if possible, let it finish with the evidence it can collect, and turn the outcome into a release-risk note.",
    "Separate verified facts from unverified items, describe any residual risk, and explain whether the earlier timeout still limits the conclusion.",
  ].join("\n");
  assertNaturalPromptAllowed(followup);
  await requestJson<{ accepted: boolean; missionId: string }>({
    method: "POST",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/messages`,
    token: input.token,
    body: { content: followup },
  });

  const result = await waitForNaturalMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: input.timeoutMs,
    afterThoughtMs: initialFinal.tMs,
    ...(initialFinal.id ? { afterThoughtId: initialFinal.id } : {}),
  });
  assertNaturalFollowupReusedExistingSession({
    timeline: result.timeline,
    phaseOneFinal: initialFinal,
    expectedSessionKey: timeoutSessionKey,
  });
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  const final = findLatestThoughtEvent(result.timeline);
  assert.ok(final, "natural timeout follow-up mission must include a final assistant answer");
  const quality = evaluateNaturalMissionQuality({
    spec,
    mission: result.mission,
    timeline: result.timeline,
    metrics,
    final,
  });
  const scenarioResult = { scenario: "natural-timeout-followup-continuation" as const, mission: result.mission, timeline: result.timeline, metrics, final, quality };
  assertNaturalMissionQualityPassed(scenarioResult, "natural mission timeout follow-up quality failures");
  return scenarioResult;
}

async function createNaturalMission(input: {
  baseUrl: string;
  token: string;
  spec: NaturalScenarioSpec;
}): Promise<Mission> {
  return requestJson<Mission>({
    method: "POST",
    url: `${input.baseUrl}/missions`,
    token: input.token,
    body: {
      title: input.spec.title,
      mode: "research",
      desc: input.spec.desc,
      owner: "natural-e2e",
      ownerLabel: "Natural E2E",
    },
  });
}

async function waitForNaturalMissionCompletion(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  timeoutMs: number;
  allowBlocked?: boolean;
  afterThoughtMs?: number;
  afterThoughtId?: string;
}): Promise<{ mission: Mission; timeline: ActivityEvent[] }> {
  const startedAt = Date.now();
  let latestMission: Mission | null = null;
  let latestTimeline: ActivityEvent[] = [];
  while (Date.now() - startedAt < input.timeoutMs) {
    latestMission = await requestJson<Mission>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}`,
      token: input.token,
    });
    latestTimeline = await requestJson<ActivityEvent[]>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/timeline?limit=300`,
      token: input.token,
    });
    const latestThought = findLatestThoughtEvent(latestTimeline);
    const hasRequiredThought =
      latestThought &&
      (input.afterThoughtMs === undefined ||
        latestThought.tMs > input.afterThoughtMs ||
        (input.afterThoughtId !== undefined && latestThought.id !== input.afterThoughtId));
    if (latestMission.status === "done" && hasRequiredThought) {
      return { mission: latestMission, timeline: latestTimeline };
    }
    if (latestMission.status === "blocked") {
      if (input.allowBlocked) {
        return { mission: latestMission, timeline: latestTimeline };
      }
      throw new Error(`natural mission blocked before completion:\n${summarizeMissionState(latestMission, latestTimeline)}`);
    }
    await sleep(1_000);
  }
  throw new Error(
    `natural mission did not complete within ${input.timeoutMs}ms:\n${summarizeMissionState(latestMission, latestTimeline)}`
  );
}

function findLatestThoughtEvent(timeline: ActivityEvent[]): ActivityEvent | null {
  return [...timeline].reverse().find((event) => event.kind === "thought" && event.text.trim().length > 0) ?? null;
}

function findLatestCancellationEvent(timeline: ActivityEvent[]): ActivityEvent | null {
  return (
    [...timeline]
      .reverse()
      .find((event) => event.runtime?.["eventType"] === "mission.cancelled" || /\bcancel(?:led|ed)?\b/i.test(event.text)) ?? null
  );
}

export function buildNaturalScenarioSpec(
  scenario: NaturalMissionE2eScenario,
  fixture: Pick<FixtureServer, "alphaUrl" | "betaUrl" | "dashboardUrl" | "approvalUrl" | "slowUrl" | "cancelResumeUrl" | "orchestrationUrl" | "bridgeUrl" | "productSignalsUrl">
): NaturalScenarioSpec {
  if (scenario === "natural-comparison-research") {
    return {
      scenario,
      title: "Natural comparison research",
      desc: [
        "A product lead is deciding between Vendor Alpha and Vendor Beta for next week's workbench investment.",
        `Review these two source pages: ${fixture.alphaUrl} and ${fixture.betaUrl}.`,
        "Return a concise recommendation that compares pricing, strengths, risks, and the tradeoff that matters most for an agent workbench team.",
        "Close with a clear recommendation for the product lead, including when the other option would be preferable.",
        "Use only evidence you collected during this mission. If a source is unavailable, say what was verified and what was not.",
      ].join("\n"),
      minBytes: 360,
      minToolResults: 1,
      maxToolResults: 8,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 6,
      requiresBrowser: false,
      requiresApproval: false,
      allowToolFailure: false,
      minEvidenceEvents: 1,
      requiredAnswerTerms: ["Alpha", "Beta", "$19", "$29", "recommend", "risk"],
      requiredAnswerPatterns: [
        { label: "alpha price", pattern: /\$19\b/ },
        { label: "beta price", pattern: /\$29\b/ },
      ],
      forbiddenPatterns: unsupportedVendorComparisonPatterns(),
    };
  }
  if (scenario === "natural-browser-dynamic-page") {
    const dynamicUrl = process.env.TURNKEYAI_NATURAL_BROWSER_URL?.trim() || fixture.dashboardUrl;
    return {
      scenario,
      title: "Natural browser dynamic page review",
      desc: [
        "Review this operations dashboard as a user would see it in the browser.",
        `Dashboard: ${dynamicUrl}`,
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "Summarize the operational state, escalation trigger, owner, and recommended next action for an operator.",
        "Also state the residual risk or unverified scope that remains after the browser check.",
      ].join("\n"),
      minBytes: 320,
      minToolResults: 1,
      maxToolResults: 8,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 4,
      requiresBrowser: true,
      requiresArtifactLifecycle: true,
      requiresApproval: false,
      allowToolFailure: false,
      minEvidenceEvents: 1,
      requiredAnswerTerms: ["SLA", "Incident Commander"],
      requiredAnswerPatterns: [
        { label: "visible queue depth", pattern: /Queue depth[\s\S]{0,80}\b11\b|\bqueue(?: depth)?[\s\S]{0,40}\b11\b|\bdepth[\s\S]{0,40}\b11\b|\b11\b[\s\S]{0,40}(?:queue|backlog)/i },
      ],
      requiredEvidencePatterns: [
        { label: "rendered queue depth", pattern: /Queue depth[\s\S]{0,80}\b11\b|\b11\b[\s\S]{0,80}Queue depth/i },
        { label: "rendered SLA breaches", pattern: RENDERED_SLA_BREACHES_VALUE_PATTERN },
        { label: "rendered owner", pattern: /owner[\s\S]{0,80}Incident Commander|Incident Commander[\s\S]{0,80}owner/i },
      ],
    };
  }
  if (scenario === "natural-browser-dashboard-task") {
    const dashboardUrl = process.env.TURNKEYAI_NATURAL_BROWSER_URL?.trim() || fixture.dashboardUrl;
    return {
      scenario,
      title: "Natural browser dashboard operator task",
      desc: [
        "An operator asks for help reading a live operations dashboard in the browser before paging anyone.",
        `Dashboard: ${dashboardUrl}`,
        "The important state may appear only after client-side rendering finishes.",
        "Explain the current operational state, whether the escalation policy is triggered, who should own the next action, and what risk remains after your check.",
        "Use only evidence gathered during this mission, and separate verified dashboard facts from anything still unverified.",
      ].join("\n"),
      minBytes: 360,
      minToolResults: 1,
      maxToolResults: 8,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 4,
      requiresBrowser: true,
      requiresArtifactLifecycle: true,
      requiresApproval: false,
      allowToolFailure: false,
      minEvidenceEvents: 1,
      requiredAnswerTerms: ["SLA", "Incident Commander", "escalation", "residual risk"],
      requiredAnswerPatterns: [
        {
          label: "visible queue depth",
          pattern:
            /Queue depth[\s\S]{0,80}\b11\b|\bqueue(?: depth)?[\s\S]{0,40}\b11\b|\bdepth[\s\S]{0,40}\b11\b|\b11\b[\s\S]{0,40}(?:queue|backlog)/i,
        },
        {
          label: "visible SLA breaches",
          pattern: /SLA breach(?:es|\s+count)?[\s\S]{0,100}\b3\b|\b3\b[\s\S]{0,100}SLA breach(?:es|\s+count)?/i,
        },
        {
          label: "actionable escalation policy",
          pattern: /(?:page|notify|escalat)[\s\S]{0,120}(?:on-call|Incident Commander|owner)/i,
        },
      ],
      requiredEvidencePatterns: [
        { label: "rendered queue depth", pattern: /Queue depth[\s\S]{0,80}\b11\b|\b11\b[\s\S]{0,80}Queue depth/i },
        { label: "rendered SLA breaches", pattern: RENDERED_SLA_BREACHES_VALUE_PATTERN },
        { label: "rendered owner", pattern: /owner[\s\S]{0,80}Incident Commander|Incident Commander[\s\S]{0,80}owner/i },
        {
          label: "rendered escalation policy",
          pattern:
            /Escalation threshold[\s\S]{0,120}(?:queue depth above 5|SLA breaches above 0)|(?:queue depth above 5|SLA breaches above 0)[\s\S]{0,120}Escalation threshold/i,
        },
      ],
      forbiddenPatterns: [
        { label: "unsupported external incident claim", pattern: /\b(real outage|production outage|customer impact confirmed)\b/i },
        { label: "unresolved placeholder", pattern: /\b(TBD|to be confirmed|needs confirmation|待确认|估算)\b/i },
      ],
    };
  }
  if (scenario === "natural-browser-followup-continuation") {
    const dynamicUrl = process.env.TURNKEYAI_NATURAL_BROWSER_URL?.trim() || fixture.dashboardUrl;
    return {
      scenario,
      title: "Natural browser follow-up continuation",
      desc: [
        "Review this operations dashboard as a user would see it in the browser.",
        `Dashboard: ${dynamicUrl}`,
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "Summarize the operational state, escalation trigger, owner, and recommended next action for an operator.",
        "A follow-up may ask you to continue from the same browser context and re-check the rendered dashboard state.",
      ].join("\n"),
      minBytes: 380,
      minToolResults: 2,
      maxToolResults: 8,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 2,
      minContinuedSessions: 1,
      requiresBrowser: true,
      requiresApproval: false,
      allowToolFailure: false,
      minEvidenceEvents: 2,
      requiredAnswerTerms: ["SLA", "Incident Commander", "action"],
      requiredEvidencePatterns: [
        { label: "rendered queue depth", pattern: /Queue depth[\s\S]{0,80}\b11\b|\b11\b[\s\S]{0,80}Queue depth/i },
        { label: "rendered SLA breaches", pattern: RENDERED_SLA_BREACHES_VALUE_PATTERN },
        { label: "rendered owner", pattern: /owner[\s\S]{0,80}Incident Commander|Incident Commander[\s\S]{0,80}owner/i },
      ],
    };
  }
  if (scenario === "natural-browser-restart-continuation") {
    const dynamicUrl = process.env.TURNKEYAI_NATURAL_BROWSER_URL?.trim() || fixture.dashboardUrl;
    return {
      scenario,
      title: "Natural browser restart continuation",
      desc: [
        "Review this operations dashboard as a user would see it in the browser.",
        `Dashboard: ${dynamicUrl}`,
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "Summarize the operational state, escalation trigger, owner, and recommended next action for an operator.",
        "The mission may be continued after a daemon restart, so preserve enough browser context for a later follow-up.",
      ].join("\n"),
      minBytes: 420,
      minToolResults: 1,
      maxToolResults: 6,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 2,
      requiresBrowser: true,
      requiresApproval: false,
      allowToolFailure: false,
      minEvidenceEvents: 2,
      requiredAnswerTerms: ["SLA", "Incident Commander", "action"],
      requiredAnswerPatterns: [
        { label: "visible restart continuity", pattern: /\b(?:restart|reconnect(?:ed)?|fresh browser session|browser continuity|session .*expired|recovered via (?:warm|cold) resume|(?:warm|cold) resume|warm and preserved|session .*preserved)\b/i },
      ],
      requiredEvidencePatterns: [
        { label: "rendered queue depth", pattern: /Queue depth[\s\S]{0,80}\b11\b|\b11\b[\s\S]{0,80}Queue depth/i },
        { label: "rendered SLA breaches", pattern: RENDERED_SLA_BREACHES_VALUE_PATTERN },
        { label: "rendered owner", pattern: /owner[\s\S]{0,80}Incident Commander|Incident Commander[\s\S]{0,80}owner/i },
      ],
    };
  }
  if (scenario === "natural-browser-cold-recreation-continuation") {
    const dynamicUrl = process.env.TURNKEYAI_NATURAL_BROWSER_URL?.trim() || fixture.dashboardUrl;
    return {
      scenario,
      title: "Natural browser cold recreation continuation",
      desc: [
        "Review this operations dashboard as a user would see it in the browser.",
        `Dashboard: ${dynamicUrl}`,
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "Summarize the operational state, escalation trigger, owner, and recommended next action for an operator.",
        "A later follow-up may need to continue even if the previous browser session is unavailable; recover by reopening the same read-only dashboard when needed.",
      ].join("\n"),
      minBytes: 420,
      minToolResults: 2,
      maxToolResults: 9,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 2,
      minContinuedSessions: 1,
      requiresBrowser: true,
      requiresApproval: false,
      allowToolFailure: false,
      requiredBrowserFailureBuckets: ["session_not_found"],
      minEvidenceEvents: 2,
      requiredAnswerTerms: ["SLA", "Incident Commander", "action"],
      requiredAnswerPatterns: [
        { label: "visible browser recovery", pattern: /\b(reopen|reopened|recreate|recreated|recovered|new browser session|session was unavailable|warm|cold)\b/i },
      ],
      requiredEvidencePatterns: [
        {
          label: "browser recovery evidence",
          pattern:
            /Resume mode:\s*(?:warm|cold)|["']resumeMode["']\s*:\s*["'](?:warm|cold)["']|(?:warm|cold)[- ]recovery|(?:warm|cold)[- ]recreat(?:ion|ed)|re[- ]?open(?:ed)?|recovery confirmed|new browser session/i,
        },
        { label: "rendered queue depth", pattern: /Queue depth[\s\S]{0,80}\b11\b|\b11\b[\s\S]{0,80}Queue depth/i },
        { label: "rendered SLA breaches", pattern: RENDERED_SLA_BREACHES_VALUE_PATTERN },
        { label: "rendered owner", pattern: /owner[\s\S]{0,80}Incident Commander|Incident Commander[\s\S]{0,80}owner/i },
      ],
    };
  }
  if (scenario === "natural-browser-profile-lock-recovery") {
    const dynamicUrl = process.env.TURNKEYAI_NATURAL_BROWSER_URL?.trim() || fixture.dashboardUrl;
    return {
      scenario,
      title: "Natural browser profile-lock recovery",
      desc: [
        "Review this operations dashboard through a browser-visible pass, as an operator would see it.",
        `Dashboard: ${dynamicUrl}`,
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "Raw server HTML is not enough for this review.",
        "The persistent browser profile may be temporarily unavailable; recover with a safe isolated browser context if needed and keep that recovery visible.",
        "Summarize the operational state, escalation trigger, owner, and recommended next action for an operator.",
      ].join("\n"),
      minBytes: 420,
      minToolResults: 1,
      maxToolResults: 4,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 2,
      minContinuedSessions: 0,
      requiresBrowser: true,
      requiresApproval: false,
      requiresProfileFallback: true,
      allowToolFailure: false,
      minEvidenceEvents: 1,
      requiredAnswerTerms: ["SLA", "Incident Commander", "action"],
      requiredAnswerPatterns: [
        { label: "visible profile fallback recovery", pattern: /\b(?:profile|fallback|isolated browser|isolated runtime|recovered)\b/i },
      ],
      requiredEvidencePatterns: [
        { label: "profile fallback evidence", pattern: /Profile fallback:\s*profile_locked|profileFallback|profile_locked|isolated runtime profile/i },
        { label: "rendered queue depth", pattern: /Queue depth[\s\S]{0,80}\b11\b|\b11\b[\s\S]{0,80}Queue depth/i },
        { label: "rendered SLA breaches", pattern: RENDERED_SLA_BREACHES_VALUE_PATTERN },
        { label: "rendered owner", pattern: /owner[\s\S]{0,80}Incident Commander|Incident Commander[\s\S]{0,80}owner/i },
      ],
    };
  }
  if (scenario === "natural-followup-continuation") {
    return {
      scenario,
      title: "Natural follow-up continuation",
      desc: [
        "Start a source-backed review of Vendor Alpha for a product lead.",
        `Source: ${fixture.alphaUrl}`,
        "Keep the work useful for a likely follow-up comparison rather than writing a one-off trivia answer.",
        "Focus on pricing, strength, and risk, and keep source labels visible in the answer.",
      ].join("\n"),
      minBytes: 420,
      minToolResults: 2,
      maxToolResults: 10,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 6,
      minContinuedSessions: 1,
      requiresBrowser: false,
      requiresApproval: false,
      allowToolFailure: false,
      minEvidenceEvents: 2,
      requiredAnswerTerms: ["Alpha", "$19", "risk", "verified"],
      requiredAnswerPatterns: [
        { label: "alpha price", pattern: /\$19\b/ },
      ],
      forbiddenPatterns: unsupportedVendorComparisonPatterns(),
    };
  }
  if (scenario === "natural-memory-recall") {
    return {
      scenario,
      title: "Natural durable memory recall",
      desc: [
        "Continue from the launch-planning context in this mission.",
        "The team previously captured durable launch coordination notes for the Helios-47 codename.",
        "Please check durable memory for Helios-47 specifically, recover the launch window, owner, and residual risk if they are available, and inspect any candidate memory entry before relying on it.",
        "If the Helios-47 context cannot be verified from durable memory, say what is missing rather than guessing.",
        "Keep the answer concise, evidence-backed, and useful for the release lead.",
      ].join("\n"),
      minBytes: 260,
      minToolResults: 2,
      maxToolResults: 5,
      minSpawnedSessions: 0,
      maxSpawnedSessions: 1,
      requiresBrowser: false,
      requiresApproval: false,
      allowToolFailure: false,
      minEvidenceEvents: 2,
      requiredAnswerTerms: ["Helios-47", "Tuesday 09:30", "Release Captain", "residual risk"],
      requiredAnswerPatterns: [
        { label: "launch window", pattern: /Tuesday\s+09:30/i },
        { label: "release owner", pattern: /Release Captain/i },
      ],
      requiredToolNames: ["memory_search", "memory_get"],
      forbiddenPatterns: [
        { label: "session delegation", pattern: /\bsessions_(?:spawn|send|list|history)\b/i },
        { label: "unsupported launch window", pattern: /\b(?:Monday|Wednesday|Thursday|Friday)\s+\d{1,2}:\d{2}\b/i },
        { label: "unsupported owner", pattern: /\b(?:Product Lead|Incident Commander|Launch Manager)\b/i },
      ],
    };
  }
  if (scenario === "natural-approval-dry-run-action") {
    return {
      scenario,
      title: "Natural approval dry-run browser action",
      desc: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        `Form: ${fixture.approvalUrl}`,
        "The dry-run action under review is the form submission, not just opening the page.",
        "Actually carry the safe local dry-run through the approval gate; do not stop at a plan or a generic approval explanation.",
        "Treat the page as isolated local test data. Request approval before applying the browser action, then report what was approved and what evidence the page showed.",
      ].join("\n"),
      minBytes: 260,
      minToolResults: 1,
      maxToolResults: 8,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 4,
      requiresBrowser: true,
      requiresApproval: true,
      approvalDecision: "approved",
      allowToolFailure: false,
      minEvidenceEvents: 1,
      requiredAnswerTerms: ["approval", "dry-run", "browser"],
      requiredAnswerPatterns: [
        { label: "submitted result", pattern: /\bsubmit(?:ted|tal)?\b/i },
      ],
      forbiddenPatterns: [
        { label: "approval granted but action incomplete", pattern: /\b(?:form submission|submit(?:ted|tal)?|action)\s+(?:was\s+)?not completed\b/i },
        { label: "approved submit blocked", pattern: /\b(?:click|submit(?:ted|tal)?|form submission).{0,60}\bblock(?:ed|er|ing)\b/i },
        { label: "approval tooling unavailable fallback", pattern: /\b(?:approval|permission).{0,80}(?:tool|tooling).{0,80}(?:unavailable|not available|disabled|cannot be traversed)\b/i },
      ],
    };
  }
  if (scenario === "natural-approval-denied-safe-closeout") {
    return {
      scenario,
      title: "Natural approval denied safe closeout",
      desc: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        `Form: ${fixture.approvalUrl}`,
        "The dry-run action under review is the form submission, not just opening the page.",
        "Request approval before applying the browser action. If the operator denies the request, do not apply the browser action; close out with what was requested, why the side effect did not run, and the safest next action.",
        "Treat the page as isolated local test data, but keep the approval decision authoritative.",
      ].join("\n"),
      minBytes: 260,
      minToolResults: 1,
      maxToolResults: 6,
      minSpawnedSessions: 0,
      maxSpawnedSessions: 2,
      requiresBrowser: false,
      requiresApproval: true,
      approvalDecision: "denied",
      allowToolFailure: true,
      minEvidenceEvents: 1,
      requiredAnswerTerms: ["denied", "approval", "dry-run"],
      requiredAnswerPatterns: [
        {
          label: "denied side effect",
          pattern:
            /\b(?:did not|will not|was not|not|no)\s+(?:be\s+)?(?:submit(?:ted)?|apply|perform(?:ed)?|run|complete(?:d)?|execute(?:d)?|take|taken)|\bwas\s+not\s+executed\b|\baction not performed\b|\bno (?:form submission|browser action|mutation|side effects?|state) (?:was |were )?(?:(?:or will be )?performed|executed|taken|applied|changed)\b|\bno mutation was performed\b|\bremains untouched\b/i,
        },
        { label: "safe next action", pattern: /\b(?:next action|safest next step|safe fallback|ask the operator|revise|flow is complete|closes cleanly|closeout confirmed)\b/i },
      ],
      forbiddenPatterns: [
        {
          label: "denied submit claimed complete",
          pattern:
            /\b(?:successfully submitted|submission completed|form submission completed|action completed|form was submitted|submitted locally after approval|submitted to the page)\b/i,
        },
        { label: "permission applied after denial", pattern: /\bpermission\.applied\b/i },
      ],
    };
  }
  if (scenario === "natural-approval-pending-state") {
    return {
      scenario,
      title: "Natural approval pending state",
      desc: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        `Form: ${fixture.approvalUrl}`,
        "The dry-run action under review is the form submission, not just opening the page.",
        "Request approval before applying the browser action. Stop at the approval request and wait for the operator decision; do not imply the form was submitted before approval.",
        "Treat the page as isolated local test data, but keep the approval gate authoritative.",
      ].join("\n"),
      minBytes: 90,
      minToolResults: 0,
      maxToolResults: 1,
      minSpawnedSessions: 0,
      maxSpawnedSessions: 1,
      requiresBrowser: false,
      requiresApproval: true,
      approvalDecision: "pending",
      expectedMissionStatus: "needs_approval",
      allowToolFailure: false,
      minEvidenceEvents: 1,
      requiredAnswerTerms: ["Requested approval", "browser.form.submit"],
      requiredAnswerPatterns: [
        { label: "pending approval request", pattern: /Requested approval/i },
        { label: "blocked before side effect", pattern: /browser\.form\.submit/i },
      ],
      forbiddenPatterns: [
        {
          label: "pending submit claimed complete",
          pattern:
            /\b(?:successfully submitted|submission completed|form submission completed|action completed|form was submitted|submitted locally after approval|submitted to the page)\b/i,
        },
        { label: "approval decided while pending", pattern: /\bpermission\.(?:result|applied)\b/i },
      ],
    };
  }
  if (scenario === "natural-browser-unavailable-closeout") {
    const dynamicUrl = process.env.TURNKEYAI_NATURAL_BROWSER_URL?.trim() || fixture.dashboardUrl;
    return {
      scenario,
      title: "Natural browser unavailable closeout",
      desc: [
        "Review this operations dashboard as a user would see it in the browser.",
        `Dashboard: ${dynamicUrl}`,
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "If the browser cannot be reached, close out with what was verified, what remains unverified, and the next action an operator should take.",
      ].join("\n"),
      minBytes: 240,
      minToolResults: 1,
      maxToolResults: 5,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 3,
      requiresBrowser: true,
      requiresApproval: false,
      allowToolFailure: true,
      requiredBrowserFailureBuckets: ["browser_cdp_unavailable"],
      minEvidenceEvents: 1,
      requiredAnswerTerms: ["browser", "verified", "next action"],
      requiredAnswerPatterns: [
        { label: "unverified closeout section", pattern: /\b(?:unverified|not verified)\b/i },
      ],
      requiredEvidencePatterns: [
        { label: "browser unavailable bucket", pattern: /browser_cdp_unavailable|CDP endpoint unavailable|connection refused|ECONNREFUSED|fetch failed/i },
      ],
      forbiddenPatterns: [
        { label: "unsupported rendered queue depth", pattern: /Queue depth[\s\S]{0,80}\b11\b|\b11\b[\s\S]{0,80}Queue depth/i },
        { label: "unsupported rendered SLA breaches", pattern: RENDERED_SLA_BREACHES_VALUE_PATTERN },
        { label: "unsupported rendered owner", pattern: /Incident Commander/i },
      ],
      allowedWeakAnswerSignals: ["tool unavailable fallback"],
    };
  }
  if (scenario === "natural-browser-cdp-timeout-closeout") {
    const dynamicUrl = process.env.TURNKEYAI_NATURAL_BROWSER_URL?.trim() || fixture.dashboardUrl;
    return {
      scenario,
      title: "Natural browser CDP timeout closeout",
      desc: [
        "Review this operations dashboard as a user would see it in the browser.",
        `Dashboard: ${dynamicUrl}`,
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "If the browser times out while capturing the rendered page, close out with what was verified, what remains unverified, and the next action an operator should take.",
      ].join("\n"),
      minBytes: 260,
      minToolResults: 1,
      maxToolResults: 5,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 3,
      requiresBrowser: true,
      requiresApproval: false,
      allowToolFailure: true,
      requiredBrowserFailureBuckets: ["cdp_command_timeout"],
      minEvidenceEvents: 1,
      requiredAnswerTerms: ["browser", "verified", "next action"],
      requiredAnswerPatterns: [
        { label: "timeout closeout", pattern: /\b(?:timed out|timeout|did not complete)\b/i },
        {
          label: "bounded CDP limitation",
          pattern: /\b(?:CDP|snapshot|capture|browser)\b[\s\S]{0,120}\b(?:timeout|timed out|unverified|not complete|incomplete)\b/i,
        },
      ],
      requiredEvidencePatterns: [
        {
          label: "browser CDP timeout bucket",
          pattern: /cdp_command_timeout|CDP command timed out|browser snapshot CDP command timed out|CDP (?:snapshot|scroll|capture)[\s\S]{0,80}commands? timed out|browser_(?:snapshot|scroll)[\s\S]{0,80}timed out/i,
        },
      ],
      allowedWeakAnswerSignals: ["tool unavailable fallback"],
    };
  }
  if (scenario === "natural-browser-detached-target-closeout") {
    const dynamicUrl = process.env.TURNKEYAI_NATURAL_BROWSER_URL?.trim() || fixture.dashboardUrl;
    return {
      scenario,
      title: "Natural browser detached target closeout",
      desc: [
        "Review this operations dashboard as a user would see it in the browser.",
        `Dashboard: ${dynamicUrl}`,
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "If the browser target detaches while capturing the rendered page, close out with what was verified, what remains unverified, and the next action an operator should take.",
      ].join("\n"),
      minBytes: 260,
      minToolResults: 1,
      maxToolResults: 5,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 3,
      requiresBrowser: true,
      requiresApproval: false,
      allowToolFailure: true,
      requiredBrowserFailureBuckets: ["detached_target"],
      minEvidenceEvents: 1,
      requiredAnswerTerms: ["browser", "verified", "next action"],
      requiredAnswerPatterns: [
        { label: "detached target closeout", pattern: /\b(?:target|tab|page|browser)\b[\s\S]{0,80}\bdetached\b|\bdetached\b[\s\S]{0,80}\b(?:target|tab|page|browser)\b/i },
        {
          label: "bounded target limitation",
          pattern: /\b(?:target|tab|page|browser)\b[\s\S]{0,120}\b(?:detached|unverified|not complete|incomplete|unavailable)\b/i,
        },
      ],
      requiredEvidencePatterns: [
        { label: "browser detached target bucket", pattern: /detached_target|target detached|browser target detached|detached\s+\d+\s+times/i },
      ],
      allowedWeakAnswerSignals: ["tool unavailable fallback"],
    };
  }
  if (scenario === "natural-browser-attach-failed-closeout") {
    const dynamicUrl = process.env.TURNKEYAI_NATURAL_BROWSER_URL?.trim() || fixture.dashboardUrl;
    return {
      scenario,
      title: "Natural browser attach failure closeout",
      desc: [
        "Review this operations dashboard as a user would see it in the browser.",
        `Dashboard: ${dynamicUrl}`,
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "If the browser cannot attach to the target page, close out with what was verified, what remains unverified, and the next action an operator should take.",
      ].join("\n"),
      minBytes: 260,
      minToolResults: 1,
      maxToolResults: 5,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 3,
      requiresBrowser: true,
      requiresApproval: false,
      allowToolFailure: true,
      requiredBrowserFailureBuckets: ["attach_failed"],
      minEvidenceEvents: 1,
      requiredAnswerTerms: ["browser", "verified", "next action"],
      requiredAnswerPatterns: [
        {
          label: "attach failure closeout",
          pattern:
            /\b(?:attach|attached|target|page|browser)\b[\s\S]{0,120}\b(?:failed|failure|could not|unable)\b|\b(?:failed|failure|could not|unable)\b[\s\S]{0,120}\b(?:attach|attached|target|page|browser)\b/i,
        },
        {
          label: "bounded attach limitation",
          pattern: /\b(?:target|tab|page|browser)\b[\s\S]{0,120}\b(?:attach|unverified|not complete|incomplete|unavailable)\b/i,
        },
      ],
      requiredEvidencePatterns: [
        { label: "browser attach failure bucket", pattern: /attach_failed|target attach failed|browser target attach failed/i },
      ],
      allowedWeakAnswerSignals: ["tool unavailable fallback"],
    };
  }
  if (scenario === "natural-timeout-partial-closeout") {
    return {
      scenario,
      title: "Natural timeout partial evidence closeout",
      desc: [
        "Evaluate this slow source for a release-risk note.",
        `Slow source: ${fixture.slowUrl}`,
        "Use a bounded attempt. If the source does not return in time, close out with the evidence that is available, clearly separating verified facts from unverified items and explaining how to continue.",
      ].join("\n"),
      minBytes: 260,
      minToolResults: 1,
      maxToolResults: 5,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 3,
      requiresBrowser: false,
      requiresApproval: false,
      allowToolFailure: true,
      minEvidenceEvents: 1,
      requiredAnswerTerms: ["verified", "unverified", "continue"],
      requiredAnswerPatterns: [
        { label: "timeout closeout", pattern: /\b(?:timed out|timeout|did not respond|no response)\b/i },
      ],
      forbiddenPatterns: [
        { label: "pretends slow source was verified", pattern: /confirmed.*slow mission route tool-use fixture/i },
      ],
    };
  }
  if (scenario === "natural-timeout-followup-continuation") {
    return {
      scenario,
      title: "Natural timeout follow-up continuation",
      desc: [
        "Evaluate this slow source for a release-risk note.",
        `Slow source: ${fixture.slowUrl}`,
        "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available and explain how the mission can continue.",
        "A follow-up may ask you to resume that same source-check context after the initial closeout.",
      ].join("\n"),
      minBytes: 360,
      minToolResults: 2,
      maxToolResults: 7,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 2,
      minContinuedSessions: 1,
      requiresBrowser: false,
      requiresApproval: false,
      requiresTimeout: true,
      allowToolFailure: true,
      minEvidenceEvents: 2,
      requiredAnswerTerms: ["verified", "unverified", "risk"],
      requiredAnswerPatterns: [
        { label: "continuation guidance", pattern: /\b(?:continue|retry|resume|resumable|next step|longer timeout)\b/i },
      ],
      forbiddenPatterns: [
        { label: "pretends slow source was verified before continuation", pattern: /confirmed.*slow mission route tool-use fixture.*before.*continue/i },
      ],
    };
  }
  if (scenario === "natural-cancel-active-tool") {
    return {
      scenario,
      title: "Natural active tool cancellation",
      desc: [
        "Evaluate this slow source for a release-risk note.",
        `Slow source: ${fixture.slowUrl}`,
        "Make a source-backed attempt instead of guessing from memory.",
        "If an operator cancels the active source check, stop additional source work and close out from the cancellation evidence.",
        "Separate what was verified, what remains unverified, and how the user can continue the mission later.",
      ].join("\n"),
      minBytes: 120,
      minToolResults: 0,
      maxToolResults: 1,
      minSpawnedSessions: 0,
      maxSpawnedSessions: 1,
      requiresBrowser: false,
      requiresApproval: false,
      expectedMissionStatus: "blocked",
      requiresCancellation: true,
      allowToolFailure: false,
      minEvidenceEvents: 0,
      requiredAnswerTerms: ["cancel", "verified", "unverified", "continue"],
      requiredAnswerPatterns: [
        { label: "cancelled runtime evidence", pattern: /\bcancel(?:led|ed)?\b/i },
      ],
      forbiddenPatterns: [
        { label: "pretends slow source was verified", pattern: /confirmed.*slow mission route tool-use fixture/i },
      ],
    };
  }
  if (scenario === "natural-cancel-followup-continuation") {
    return {
      scenario,
      title: "Natural cancellation follow-up continuation",
      desc: [
        "Evaluate this static text source for a release-risk note.",
        `Static source: ${fixture.cancelResumeUrl}`,
        "Make a source-backed attempt instead of guessing from memory.",
        "This is a read-only source check; no browser form, click, navigation action, or approval-gated action is needed.",
        "If an operator cancels the active source check, close out from the cancellation evidence and explain how to continue later.",
        "A follow-up may ask you to resume the same source-check context after the initial cancellation.",
      ].join("\n"),
      minBytes: 360,
      minToolResults: 2,
      maxToolResults: 7,
      minSpawnedSessions: 1,
      maxSpawnedSessions: 2,
      minContinuedSessions: 1,
      requiresBrowser: false,
      requiresApproval: false,
      requiresCancellation: true,
      allowToolFailure: false,
      minEvidenceEvents: 2,
      requiredAnswerTerms: ["verified", "unverified", "risk"],
      requiredAnswerPatterns: [
        { label: "cancellation context", pattern: /\bcancel(?:led|ed)?\b/i },
        { label: "continuation source evidence", pattern: /Release Captain|rollback rehearsal|runbook gap/i },
      ],
      requiredEvidencePatterns: [
        { label: "cancelled tool result", pattern: /\bcancel(?:led|ed)?\b/i },
        { label: "resumed source evidence", pattern: /Release Captain|rollback rehearsal|runbook gap/i },
      ],
      forbiddenPatterns: [
        { label: "pretends cancelled source was verified before follow-up", pattern: /verified[\s\S]{0,80}Release Captain[\s\S]{0,80}before[\s\S]{0,80}cancel/i },
      ],
    };
  }
  return {
    scenario,
    title: "Natural long delegation brief",
    desc: [
      "Prepare a product-ready brief about the next agent workbench release.",
      `Research source: ${fixture.orchestrationUrl}`,
      `Capability source: ${fixture.bridgeUrl}`,
      `Live signal dashboard: ${fixture.productSignalsUrl}`,
      "These are three independent evidence streams. Use specialist work where it helps, and use browser-visible evidence for the live signal dashboard.",
      "The final brief should tell a product leader what to build next, why it matters, what not to over-emphasize, and what risk remains.",
    ].join("\n"),
    minBytes: 700,
    minToolResults: 2,
    maxToolResults: 12,
    minSpawnedSessions: 2,
    maxSpawnedSessions: 8,
    requiresBrowser: true,
    requiresApproval: false,
    allowRecoveredTimeout: true,
    allowToolFailure: false,
    minEvidenceEvents: 3,
    requiredAnswerTerms: ["browser", "Mission Control", "Stuck missions", "Weak answer rate", "risk"],
    requiredAnswerPatterns: [
      {
        label: "multi-agent coordination",
        pattern: /\bmulti[- ]agent\b|multiple agents|specialist agents|delegated agents|agent coordination/i,
      },
    ],
    requiredEvidencePatterns: [
      { label: "orchestration evidence stream", pattern: /multi-agent decomposition|durable sub-session history/i },
      {
        label: "bridge evidence stream",
        pattern:
          /(?:browser bridge|bridge capability|bridge controls)[\s\S]{0,240}(?:command-line|provider configuration|desktop|DOM|screenshots|artifacts)|browser work is a means|does not control (?:the )?desktop|command-line setup[\s\S]{0,120}provider configuration/i,
      },
      {
        label: "product signals stuck missions",
        pattern: /(?:Stuck missions|stuckMissions|stuck_missions)\s*:?\s*(?:6|six)|(?:6|six)\s+stuck\s+missions/i,
      },
      { label: "product signals weak answer rate", pattern: /Weak[- ]answer(?:\s+rate)?\s*:?\s*24%|24%[\s-]+weak[- ]answer(?:\s+rate)?/i },
    ],
  };
}

function unsupportedVendorComparisonPatterns(): Array<{ label: string; pattern: RegExp }> {
  return [
    { label: "unsupported alternate Alpha pricing", pattern: /\$(?:89|199)\b/i },
    { label: "unsupported SLA claim", pattern: /\b(?:99\.9|99\.99|uptime guaranteed|published SLA|SLA guarantee)\b/i },
    {
      label: "unsupported integration catalog details",
      pattern:
        /\b(?:supports?|integrates?|connects?|works)\s+(?:with\s+)?(?:[^.\n;:]{0,80}\s+)?(?:Shopify|HubSpot|Salesforce|Stripe|Slack|Zoom|Zapier|GA4)\b|\b(?:native|available|supported)\s+(?:integration|connector)s?\s+(?:include|include[s]?|with|for)\s+(?:[^.\n;:]{0,80}\s+)?(?:Shopify|HubSpot|Salesforce|Stripe|Slack|Zoom|Zapier|GA4)\b/i,
    },
    { label: "unsupported support tier", pattern: /\b(?:dedicated CSM|24\/7 dedicated support)\b/i },
  ];
}

const NATURAL_PROMPT_FORBIDDEN_PATTERNS = [
  /\bexactly once\b/i,
  /\buse this exact\b/i,
  /\bmust call\b/i,
  /\bfinal answer must include\b/i,
  /\bTURNKEYAI_[A-Z0-9_]+\b/,
  /\bfixed marker\b/i,
] as const;

export function assertNaturalPromptAllowed(prompt: string): void {
  for (const pattern of NATURAL_PROMPT_FORBIDDEN_PATTERNS) {
    assert.equal(pattern.test(prompt), false, `natural E2E prompt contains contract-gate language: ${pattern}`);
  }
}

export function assertNaturalScenarioPromptsAllowed(): void {
  const fixture = {
    alphaUrl: "http://127.0.0.1/vendor-alpha",
    betaUrl: "http://127.0.0.1/vendor-beta",
    dashboardUrl: "http://127.0.0.1/ops-dashboard",
    approvalUrl: "http://127.0.0.1/approval-form",
    slowUrl: "http://127.0.0.1/slow-fixture",
    cancelResumeUrl: "http://127.0.0.1/cancel-resume-fixture",
    cancelResumeStateUrl: "http://127.0.0.1/__cancel-resume-state",
    orchestrationUrl: "http://127.0.0.1/product-orchestration",
    bridgeUrl: "http://127.0.0.1/product-bridge",
    productSignalsUrl: "http://127.0.0.1/product-signals",
  };
  for (const scenario of NATURAL_MISSION_E2E_SCENARIOS) {
    assertNaturalPromptAllowed(buildNaturalScenarioSpec(scenario, fixture).desc);
  }
}

export function evaluateNaturalMissionQuality(input: {
  spec: NaturalScenarioSpec;
  mission: Mission;
  timeline: ActivityEvent[];
  metrics: MissionObservabilitySnapshot;
  artifacts?: MissionArtifact[];
  final: ActivityEvent;
}): NaturalMissionQuality {
  const failures: string[] = [];
  const expectedMissionStatus = input.spec.expectedMissionStatus ?? "done";
  const completed = input.mission.status === expectedMissionStatus && input.metrics.status === expectedMissionStatus;
  const toolNames = collectToolNames(input.timeline);
  const evidenceText = collectTimelineEvidenceText(input.timeline);
  const weakAnswerSignals = [
    ...findWeakAnswerSignals(input.final.text),
    ...(input.spec.allowToolFailure ? [] : findWeakEvidenceSignals(evidenceText)),
  ];
  const blockingWeakAnswerSignals = weakAnswerSignals.filter(
    (signal) => !(input.spec.allowedWeakAnswerSignals ?? []).includes(signal)
  );
  const effectiveEvidenceEvents =
    expectedMissionStatus === "needs_approval" && hasRuntimeEvent(input.timeline, "permission.query")
      ? Math.max(input.metrics.qualityGate.evidenceEvents, 1)
      : input.metrics.qualityGate.evidenceEvents;
  const browserUsed = toolNames.has("sessions_spawn") && timelineUsesWorker(input.timeline, "browser");
  const artifactLifecycleVisible = (input.artifacts ?? []).some(hasArtifactLifecycleEvidence);
  const profileFallbackCount = input.metrics.browser?.profileFallbacks ?? 0;
  const browserFailureBuckets = input.metrics.browser?.failureBuckets ?? [];
  const missionCancelled = hasRuntimeEvent(input.timeline, "mission.cancelled");
  const sourceCoverage = evaluateNaturalSourceCoverage({
    spec: input.spec,
    finalText: input.final.text,
    evidenceText,
    evidenceEvents: effectiveEvidenceEvents,
  });
  const profileFallbackFree = profileFallbackCount === 0;
  const profileFallbackPolicySatisfied = input.spec.requiresProfileFallback
    ? profileFallbackCount > 0
    : profileFallbackFree;
  const subAgentCompleted =
    expectedMissionStatus === "needs_approval"
      ? input.metrics.sessions.spawned >= input.spec.minSpawnedSessions
      : input.metrics.sessions.spawned >= input.spec.minSpawnedSessions &&
        input.metrics.liveness.active === 0 &&
        input.metrics.liveness.waiting === 0;
  const approvalExercised =
    input.spec.approvalDecision === "pending"
      ? input.metrics.approvals.requested > 0 &&
        input.metrics.approvals.decided === 0 &&
        input.metrics.approvals.applied === 0 &&
        hasRuntimeEvent(input.timeline, "permission.query") &&
        !hasRuntimeEvent(input.timeline, "permission.result") &&
        !hasRuntimeEvent(input.timeline, "permission.applied")
      : input.spec.approvalDecision === "denied"
      ? input.metrics.approvals.requested > 0 &&
        input.metrics.approvals.decided > 0 &&
        input.metrics.approvals.applied === 0 &&
        hasRuntimeEvent(input.timeline, "permission.query") &&
        hasRuntimeEvent(input.timeline, "permission.result") &&
        !hasRuntimeEvent(input.timeline, "permission.applied")
      : input.metrics.approvals.requested > 0 &&
        input.metrics.approvals.decided > 0 &&
        input.metrics.approvals.applied > 0 &&
        hasRuntimeEvent(input.timeline, "permission.query") &&
        hasRuntimeEvent(input.timeline, "permission.result") &&
        hasRuntimeEvent(input.timeline, "permission.applied");
  const reasonableToolUse =
    input.metrics.tool.results >= input.spec.minToolResults &&
    input.metrics.tool.results <= input.spec.maxToolResults &&
    input.metrics.sessions.spawned >= input.spec.minSpawnedSessions &&
    input.metrics.sessions.spawned <= input.spec.maxSpawnedSessions &&
    input.metrics.sessions.continued >= (input.spec.minContinuedSessions ?? 0);
  const finalAnswerHasEvidence =
    effectiveEvidenceEvents >= input.spec.minEvidenceEvents &&
    sourceCoverage.answerTerms.missing.length === 0 &&
    sourceCoverage.answerPatterns.missing.length === 0;
  const finalAnswerUseful =
    Buffer.byteLength(input.final.text, "utf8") >= input.spec.minBytes &&
    /\b(recommend|next action|risk|owner|tradeoff|continue|verified|approval|approved|submitted|confirmed|complete)\b/i.test(
      input.final.text
    );
  const stuckOrLoop =
    (expectedMissionStatus !== "needs_approval" &&
      (input.metrics.liveness.active > 0 || input.metrics.liveness.waiting > 0)) ||
    input.metrics.liveness.stale > 0 ||
    hasRepeatedToolLoop(input.timeline);
  const nonCancelledFailures = Math.max(0, input.metrics.tool.failed - input.metrics.tool.cancelled);
  const recoveredToolFailures = countRecoveredToolFailures(input.timeline);
  const recoveredToolTimeouts = countRecoveredToolTimeouts(input.timeline);
  const recoveredFailurePolicySatisfied =
    nonCancelledFailures === 0 ||
    (recoveredToolFailures >= nonCancelledFailures &&
      input.metrics.tool.timeouts === 0 &&
      input.metrics.liveness.active === 0 &&
      input.metrics.liveness.waiting === 0 &&
      input.metrics.liveness.stale === 0 &&
      browserFailureBuckets.length === 0 &&
      sourceCoverage.evidencePatterns.missing.length === 0 &&
      sourceCoverage.answerPatterns.missing.length === 0 &&
      sourceCoverage.unsupportedClaims.length === 0 &&
      finalAnswerHasEvidence &&
      finalAnswerUseful);
  const recoveredTimeoutPolicySatisfied =
    input.spec.allowRecoveredTimeout === true &&
    input.metrics.tool.timeouts > 0 &&
    recoveredToolTimeouts >= input.metrics.tool.timeouts &&
    input.metrics.liveness.active === 0 &&
    input.metrics.liveness.waiting === 0 &&
    input.metrics.liveness.stale === 0 &&
    browserFailureBuckets.length === 0 &&
    sourceCoverage.evidencePatterns.missing.length === 0 &&
    sourceCoverage.answerPatterns.missing.length === 0 &&
    sourceCoverage.unsupportedClaims.length === 0 &&
    finalAnswerHasEvidence &&
    finalAnswerUseful;

  if (!completed) failures.push(`mission did not reach expected status ${expectedMissionStatus}`);
  if (stuckOrLoop) failures.push("mission appears stuck, looping, or retains live runtime subjects");
  if (!reasonableToolUse) {
    failures.push(
      [
        "tool use was outside the natural scenario range",
        `toolResults=${input.metrics.tool.results}/${input.spec.minToolResults}-${input.spec.maxToolResults}`,
        `spawned=${input.metrics.sessions.spawned}/${input.spec.minSpawnedSessions}-${input.spec.maxSpawnedSessions}`,
        `continued=${input.metrics.sessions.continued}/${input.spec.minContinuedSessions ?? 0}+`,
      ].join(" ")
    );
  }
  if (input.spec.requiresBrowser && !browserUsed) failures.push("browser scenario did not show browser worker use");
  if (input.spec.requiresArtifactLifecycle && !artifactLifecycleVisible) {
    failures.push("browser scenario did not register artifact lifecycle metadata on the mission artifact route");
  }
  if (!profileFallbackPolicySatisfied) {
    failures.push(
      input.spec.requiresProfileFallback
        ? "expected browser profile fallback recovery was not observed"
        : `browser profile fallback occurred ${profileFallbackCount} time(s)`
    );
  }
  if (!input.spec.requiresProfileFallback && (input.spec.requiredBrowserFailureBuckets ?? []).length === 0 && browserFailureBuckets.length > 0) {
    failures.push(`unexpected browser failure bucket(s): ${formatBrowserFailureBuckets(browserFailureBuckets)}`);
  }
  for (const bucket of input.spec.requiredBrowserFailureBuckets ?? []) {
    if (!browserFailureBuckets.some((item) => item.bucket === bucket && item.count > 0)) {
      failures.push(`missing browser failure bucket ${bucket}`);
    }
  }
  if (input.spec.requiresApproval && !approvalExercised) {
    failures.push(
      input.spec.approvalDecision === "denied"
        ? "approval denied scenario did not complete query/result without permission.applied"
        : input.spec.approvalDecision === "pending"
        ? "approval pending scenario did not stop at query without result/applied"
        : "approval scenario did not complete query/result/applied loop"
    );
  }
  if (input.spec.requiresCancellation && input.metrics.tool.cancelled < 1 && !missionCancelled) {
    failures.push("cancellation scenario did not record a cancelled tool result or mission cancellation event");
  }
  if (input.spec.requiresTimeout && input.metrics.tool.timeouts < 1) {
    failures.push("timeout scenario did not record a timed-out tool result");
  }
  if (!input.spec.allowToolFailure && nonCancelledFailures > 0 && !recoveredFailurePolicySatisfied && !recoveredTimeoutPolicySatisfied) {
    failures.push("scenario had unrecovered failed tool results");
  }
  if (!input.spec.allowToolFailure && input.metrics.tool.timeouts > 0 && !recoveredTimeoutPolicySatisfied) {
    failures.push("scenario had timed-out tool results");
  }
  if (!subAgentCompleted) failures.push("sub-agent work did not complete cleanly");
  if (!finalAnswerHasEvidence) failures.push("final answer lacks required source-backed evidence");
  if (!finalAnswerUseful) failures.push("final answer is too thin or not decision-useful");
  if (!sourceCoverage.residualRiskVisible) failures.push("final answer does not make residual risk visible");
  if (blockingWeakAnswerSignals.length > 0) failures.push(`weak answer signals: ${blockingWeakAnswerSignals.join(", ")}`);
  for (const toolName of input.spec.requiredToolNames ?? []) {
    if (!toolNames.has(toolName)) failures.push(`missing required tool family evidence: ${toolName}`);
  }
  for (const label of sourceCoverage.evidencePatterns.missing) {
    failures.push(`missing evidence ${label}`);
  }
  for (const label of sourceCoverage.unsupportedClaims) {
    failures.push(`forbidden ${label}`);
  }
  for (const label of sourceCoverage.answerPatterns.missing) {
    failures.push(`missing ${label}`);
  }

  return {
    status: failures.length === 0 ? "passed" : "failed",
    completed,
    stuckOrLoop,
    reasonableToolUse,
    browserUsed,
    profileFallbackFree,
    subAgentCompleted,
    approvalExercised,
    finalAnswerHasEvidence,
    finalAnswerUseful,
    sourceCoverage,
    weakAnswerSignals,
    failures,
  };
}

export function evaluateNaturalSourceCoverage(input: {
  spec: NaturalScenarioSpec;
  finalText: string;
  evidenceText: string;
  evidenceEvents: number;
}): NaturalSourceCoverage {
  const answerTerms = input.spec.requiredAnswerTerms;
  const normalizedFinalText = normalizeNaturalAnswerTermText(input.finalText);
  const missingAnswerTerms = answerTerms.filter((term) => !normalizedFinalText.includes(normalizeNaturalAnswerTermText(term)));
  const answerPatterns = input.spec.requiredAnswerPatterns ?? [];
  const missingAnswerPatterns = answerPatterns
    .filter((item) => !item.pattern.test(input.finalText))
    .map((item) => item.label);
  const evidencePatterns = input.spec.requiredEvidencePatterns ?? [];
  const missingEvidencePatterns = evidencePatterns
    .filter((item) => !item.pattern.test(input.evidenceText))
    .map((item) => item.label);
  const unsupportedClaims = (input.spec.forbiddenPatterns ?? [])
    .filter((item) => item.pattern.test(input.finalText))
    .map((item) => item.label);

  return {
    answerTerms: {
      covered: answerTerms.length - missingAnswerTerms.length,
      total: answerTerms.length,
      missing: missingAnswerTerms,
    },
    answerPatterns: {
      covered: answerPatterns.length - missingAnswerPatterns.length,
      total: answerPatterns.length,
      missing: missingAnswerPatterns,
    },
    evidencePatterns: {
      covered: evidencePatterns.length - missingEvidencePatterns.length,
      total: evidencePatterns.length,
      missing: missingEvidencePatterns,
    },
    evidenceEvents: {
      observed: input.evidenceEvents,
      required: input.spec.minEvidenceEvents,
    },
    residualRiskVisible: /\bresidual\s+risk\b|\brisks?\b|uncertain|uncertainty|unverified|not verified|\bdegraded\b|\bfallback\b|\blocked\b|no external mutation|no mutation was performed|isolated local execution|approval (?:is )?denied|operator denied(?: approval)?|denied by|side effect did not run|must not be applied|requested approval|no persistent changes|without side effects|no side effects (?:occurred|were applied)|execution stopped at the approval gate|action not performed|no form submission was executed/i.test(
      input.finalText
    ),
    unsupportedClaims,
  };
}

function normalizeNaturalAnswerTermText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‐‑‒–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectToolNames(timeline: ActivityEvent[]): Set<string> {
  return new Set(
    timeline
      .map((event) => event.runtime?.["toolName"])
      .filter((toolName): toolName is string => typeof toolName === "string" && toolName.length > 0)
  );
}

function collectTimelineEvidenceText(timeline: ActivityEvent[]): string {
  return timeline
    .filter(isEvidenceTimelineEvent)
    .map((event) =>
      [
        event.text,
        typeof event.runtime?.["resultContent"] === "string" ? event.runtime["resultContent"] : "",
        typeof event.runtime?.["summary"] === "string" ? event.runtime["summary"] : "",
      ].join("\n")
    )
    .join("\n");
}

function isEvidenceTimelineEvent(event: ActivityEvent): boolean {
  return event.kind === "tool" || event.kind === "browser" || event.kind === "doc" || event.kind === "artifact";
}

function timelineUsesWorker(timeline: ActivityEvent[], workerType: string): boolean {
  return timeline.some((event) => {
    const callInput = event.runtime?.["callInput"];
    if (typeof callInput !== "string") return false;
    try {
      const parsed = JSON.parse(callInput) as { agent_id?: unknown };
      return parsed.agent_id === workerType;
    } catch {
      return false;
    }
  });
}

function hasRuntimeEvent(timeline: ActivityEvent[], eventType: string): boolean {
  return timeline.some((event) => event.runtime?.["eventType"] === eventType);
}

function hasRepeatedToolLoop(timeline: ActivityEvent[]): boolean {
  const keys = new Map<string, number>();
  for (const event of timeline) {
    if (event.runtime?.["toolPhase"] !== "call" || typeof event.runtime?.["toolName"] !== "string") continue;
    const key = `${event.runtime["toolName"]}:${String(event.runtime["callInput"] ?? "").slice(0, 300)}`;
    const count = (keys.get(key) ?? 0) + 1;
    keys.set(key, count);
    if (count > 3) return true;
  }
  return false;
}

function countRecoveredToolFailures(timeline: ActivityEvent[]): number {
  return timeline
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => isFailedToolResultEvent(event))
    .filter(({ event, index }) => hasLaterSuccessfulToolResult(timeline, index, String(event.runtime?.["toolName"] ?? "")))
    .length;
}

function countRecoveredToolTimeouts(timeline: ActivityEvent[]): number {
  return timeline
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => isTimedOutToolResultEvent(event))
    .filter(({ event, index }) => {
      const sessionKey = readToolResultSessionKey(event);
      if (!sessionKey) return false;
      return hasLaterSuccessfulSessionResult(timeline, index, sessionKey);
    })
    .length;
}

function hasLaterSuccessfulToolResult(timeline: ActivityEvent[], failedIndex: number, toolName: string): boolean {
  if (!toolName) return false;
  return timeline
    .slice(Math.max(0, failedIndex + 1))
    .some((event) => event.runtime?.["toolName"] === toolName && isSuccessfulToolResultEvent(event));
}

function hasLaterSuccessfulSessionResult(timeline: ActivityEvent[], failedIndex: number, sessionKey: string): boolean {
  return timeline
    .slice(Math.max(0, failedIndex + 1))
    .some((event) => isSuccessfulToolResultEvent(event) && readToolResultSessionKey(event) === sessionKey);
}

function isFailedToolResultEvent(event: ActivityEvent): boolean {
  if (!isToolResultEvent(event)) return false;
  const status = toolResultStatus(event);
  return status === "failed";
}

function isTimedOutToolResultEvent(event: ActivityEvent): boolean {
  if (!isToolResultEvent(event)) return false;
  const status = toolResultStatus(event);
  return status === "timeout";
}

function isSuccessfulToolResultEvent(event: ActivityEvent): boolean {
  if (!isToolResultEvent(event)) return false;
  const status = toolResultStatus(event);
  return status === "completed";
}

function isToolResultEvent(event: ActivityEvent): boolean {
  return event.runtime?.["toolPhase"] === "result" && typeof event.runtime?.["toolName"] === "string";
}

function toolResultStatus(event: ActivityEvent): "completed" | "failed" | "cancelled" | "timeout" | "unknown" {
  const text = [event.text, String(event.runtime?.["resultContent"] ?? "")].join("\n");
  const parsedStatus = parseToolResultStatus(event.runtime?.["resultContent"]);
  if (parsedStatus === "completed" || parsedStatus === "failed" || parsedStatus === "cancelled" || parsedStatus === "timeout") {
    return parsedStatus;
  }
  if (/"status"\s*:\s*"cancelled"|\bcancel(?:led|ed)\b/i.test(text)) return "cancelled";
  if (/"status"\s*:\s*"timeout"|\b(?:timeout|timed out)\b/i.test(text)) return "timeout";
  if (/"status"\s*:\s*"failed"|\bTool\s+\S+\s+failed\b|\b(?:session not found|No worker handler available|browser_cdp_unavailable|attach_failed|target_not_found|expert_session_detached|cdp_command_timeout)\b/i.test(text)) {
    return "failed";
  }
  if (/"status"\s*:\s*"completed"|\bTool\s+\S+\s+returned\b|\bfinal_content\b/i.test(text)) return "completed";
  return "unknown";
}

function parseToolResultStatus(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : null;
  } catch {
    return null;
  }
}

function readToolResultSessionKey(event: ActivityEvent): string | null {
  const value = event.runtime?.["resultContent"];
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as { session_key?: unknown };
    return typeof parsed.session_key === "string" && parsed.session_key.trim() ? parsed.session_key.trim() : null;
  } catch {
    const match = value.match(/"session_key"\s*:\s*"([^"]+)"/);
    return match?.[1] ?? null;
  }
}

function findWeakAnswerSignals(text: string): string[] {
  const patterns = [
    { label: "tool unavailable fallback", pattern: /搜索工具.{0,12}(?:无法|不可用|没有返回)|(?:search|browser|tool).{0,24}(?:unavailable|not available|failed|not working|unable)/i },
    { label: "model-knowledge fallback", pattern: /(?:based on|using) (?:my )?(?:knowledge|training data)|(?:基于|根据)我的(?:知识库|知识|训练数据)/i },
    { label: "placeholder uncertainty", pattern: /\b(?:TBD|to be confirmed|needs confirmation|pending confirmation|estimate|estimated|probably|maybe)\b|待确认|估算/i },
    {
      label: "empty summary",
      pattern: /^\s*(?:I don't have enough information|I am unable to provide|I cannot determine|无法提供|不能确定)\b/i,
    },
  ];
  return patterns.flatMap((item) => (item.pattern.test(text) ? [item.label] : []));
}

function findWeakEvidenceSignals(text: string): string[] {
  const patterns = [
    {
      label: "browser evidence blocked",
      pattern:
        /\b(?:Cloudflare|Turnstile|anti-bot|captcha|blocked|access denied|forbidden|just a moment|please wait|请稍候)\b/i,
    },
    {
      label: "browser extraction failed",
      pattern:
        /\bverification status:\s*failed\b|\b(?:could not|unable to|failed to)\s+(?:access|extract|capture|read|verify|load)\b|\bcontent extraction\b[\s\S]{0,80}\b(?:failed|incomplete|truncated)\b/i,
    },
    {
      label: "browser evidence not verified",
      pattern:
        /\bnot verified\b|\bunverified\b|\bunable to verify\b|\bverification status:\s*(?:failed|incomplete)\b/i,
    },
    {
      label: "browser transport degraded",
      pattern:
        /\b(?:transport_failure|session lease conflict|lease conflict|budget truncation|result truncation|snapshot truncation)\b/i,
    },
  ];
  const signals: string[] = [];
  for (const item of patterns) {
    if (item.pattern.test(text) && !signals.includes(item.label)) {
      signals.push(item.label);
    }
  }
  return signals;
}

export function formatMissionScenarioStart(input: {
  scenario: MissionE2eScenario;
  index: number;
  total: number;
}): string {
  return `mission scenario starting: ${input.scenario} (${input.index}/${input.total})`;
}

export function formatMissionScenarioPass(input: {
  result: MissionScenarioResult;
  index: number;
  total: number;
  durationMs: number;
}): string {
  return [
    `mission scenario passed: ${input.result.scenario} (${input.index}/${input.total}, ${input.durationMs}ms)`,
    `mission-id=${input.result.mission.id}`,
    `quality=${input.result.metrics.qualityGate.status}`,
    `tools=${input.result.metrics.tool.requested}/${input.result.metrics.tool.results}`,
    `sessions=${input.result.metrics.sessions.spawned}/${input.result.metrics.sessions.continued}`,
    `liveness=${input.result.metrics.liveness.active}/${input.result.metrics.liveness.waiting}/${input.result.metrics.liveness.stale}`,
  ].join(" ");
}

export function formatNaturalMissionScenarioStart(input: {
  scenario: NaturalMissionE2eScenario;
  index: number;
  total: number;
}): string {
  return `natural mission scenario starting: ${input.scenario} (${input.index}/${input.total})`;
}

export function formatNaturalMissionScenarioPass(input: {
  result: NaturalMissionScenarioResult;
  index: number;
  total: number;
  durationMs: number;
}): string {
  return [
    `natural mission scenario passed: ${input.result.scenario} (${input.index}/${input.total}, ${input.durationMs}ms)`,
    `mission-id=${input.result.mission.id}`,
    `natural=${input.result.quality.status}`,
    `tools=${input.result.metrics.tool.requested}/${input.result.metrics.tool.results}`,
    `sessions=${input.result.metrics.sessions.spawned}/${input.result.metrics.sessions.continued}`,
    `browser=${input.result.quality.browserUsed ? "yes" : "no"}`,
    `artifacts=${input.result.artifacts?.length ?? 0}`,
    `profileFallbacks=${input.result.metrics.browser?.profileFallbacks ?? 0}`,
    `browserBuckets=${formatBrowserFailureBuckets(input.result.metrics.browser?.failureBuckets ?? [])}`,
    `stuck=${input.result.quality.stuckOrLoop ? "yes" : "no"}`,
  ].join(" ");
}

function printScenarioResult(result: MissionScenarioResult): void {
  console.log("mission tool-use real llm e2e passed");
  console.log(`mission-scenario: ${result.scenario}`);
  console.log(`mission-id: ${result.mission.id}`);
  console.log(`mission-status: ${result.mission.status}`);
  console.log(`mission-thread-id: ${result.mission.threadId ?? ""}`);
  console.log(`mission-tool-events: ${result.timeline.filter((event) => event.kind === "tool").length}`);
  console.log(`mission-quality-gate: ${result.metrics.qualityGate.status}`);
  console.log(`mission-metrics-tools: ${result.metrics.tool.requested}/${result.metrics.tool.results}`);
  console.log(`mission-metrics-sessions: ${result.metrics.sessions.spawned}/${result.metrics.sessions.continued}`);
  console.log(
    `mission-metrics-approvals: ${result.metrics.approvals.requested}/${result.metrics.approvals.decided}/${result.metrics.approvals.applied}`
  );
  console.log(
    `mission-metrics-liveness: ${result.metrics.liveness.active}/${result.metrics.liveness.waiting}/${result.metrics.liveness.stale}`
  );
  console.log(`mission-metrics-evidence: ${result.metrics.qualityGate.evidenceEvents}`);
  const closeoutReason = result.final.runtime?.["toolLoopCloseoutReason"];
  if (typeof closeoutReason === "string") {
    console.log(`mission-tool-loop-closeout: ${closeoutReason}`);
  }
  console.log(`mission-final-bytes: ${Buffer.byteLength(result.final.text, "utf8")}`);
  console.log(`mission-final-bullets: ${result.quality.bullets}`);
}

function printNaturalScenarioResult(result: NaturalMissionScenarioResult): void {
  console.log("natural mission real llm e2e passed");
  console.log(`natural-scenario: ${result.scenario}`);
  console.log(`mission-id: ${result.mission.id}`);
  console.log(`mission-status: ${result.mission.status}`);
  console.log(`mission-thread-id: ${result.mission.threadId ?? ""}`);
  console.log(`natural-status: ${result.quality.status}`);
  console.log(`natural-stuck-or-loop: ${result.quality.stuckOrLoop}`);
  console.log(`natural-reasonable-tool-use: ${result.quality.reasonableToolUse}`);
  console.log(`natural-browser-used: ${result.quality.browserUsed}`);
  console.log(`natural-profile-fallback-free: ${result.quality.profileFallbackFree}`);
  console.log(`natural-sub-agent-completed: ${result.quality.subAgentCompleted}`);
  console.log(`natural-approval-exercised: ${result.quality.approvalExercised}`);
  console.log(`natural-final-evidence: ${result.quality.finalAnswerHasEvidence}`);
  console.log(`natural-final-useful: ${result.quality.finalAnswerUseful}`);
  console.log(`natural-weak-answer-signals: ${result.quality.weakAnswerSignals.join(",") || "none"}`);
  console.log(`mission-artifacts: ${result.artifacts?.length ?? 0}`);
  console.log(`mission-artifacts-with-lifecycle: ${(result.artifacts ?? []).filter(hasArtifactLifecycleEvidence).length}`);
  console.log(`mission-metrics-tools: ${result.metrics.tool.requested}/${result.metrics.tool.results}`);
  console.log(`mission-metrics-sessions: ${result.metrics.sessions.spawned}/${result.metrics.sessions.continued}`);
  console.log(`mission-metrics-browser-profile-fallbacks: ${result.metrics.browser?.profileFallbacks ?? 0}`);
  console.log(
    `mission-metrics-browser-buckets: ${formatBrowserFailureBuckets(result.metrics.browser?.failureBuckets ?? [])}`
  );
  console.log(
    `mission-metrics-liveness: ${result.metrics.liveness.active}/${result.metrics.liveness.waiting}/${result.metrics.liveness.stale}`
  );
  console.log(`mission-final-bytes: ${Buffer.byteLength(result.final.text, "utf8")}`);
}

export function buildMissionE2eJsonReport(input: {
  startedAt: number;
  completedAt: number;
  results: MissionScenarioResult[];
}): MissionE2eJsonReport {
  const scenarios = input.results.map(summarizeMissionScenarioResult);
  return {
    kind: "turnkeyai.mission-e2e.report",
    status: scenarios.every(isPassingMissionScenarioReport) ? "passed" : "failed",
    startedAt: new Date(input.startedAt).toISOString(),
    completedAt: new Date(input.completedAt).toISOString(),
    durationMs: Math.max(0, input.completedAt - input.startedAt),
    scenarios,
  };
}

export function buildNaturalMissionE2eJsonReport(input: {
  startedAt: number;
  completedAt: number;
  results: NaturalMissionScenarioResult[];
}): NaturalMissionE2eJsonReport {
  const scenarios = input.results.map(summarizeNaturalMissionScenarioResult);
  return {
    kind: "turnkeyai.natural-mission-e2e.report",
    evidenceMode: "natural-real-llm",
    progressClaim: "capability",
    promptPolicy: {
      forbidsContractGateLanguage: true,
      forbiddenPatterns: NATURAL_PROMPT_FORBIDDEN_PATTERNS.map((pattern) => pattern.source),
    },
    requiredQualitySignals: [
      "completed",
      "not-stuck-or-looping",
      "reasonable-tool-use",
      "clean-sub-agent-liveness",
      "source-backed-evidence",
      "residual-risk-visible",
      "no-unsupported-claims",
      "decision-useful-final-answer",
      "no-weak-answer-signals",
      "browser-profile-fallback-policy",
      "browser-failure-bucket-policy",
    ],
    status: scenarios.every((scenario) => scenario.natural.status === "passed") ? "passed" : "failed",
    startedAt: new Date(input.startedAt).toISOString(),
    completedAt: new Date(input.completedAt).toISOString(),
    durationMs: Math.max(0, input.completedAt - input.startedAt),
    scenarios,
  };
}

function assertNaturalMissionQualityPassed(result: NaturalMissionScenarioResult, label: string): void {
  if (result.quality.failures.length === 0) {
    return;
  }
  throw new NaturalMissionScenarioQualityError(
    `${label}: ${result.quality.failures.join("; ")}\n${result.final.text}`,
    result
  );
}

export function summarizeMissionScenarioResult(result: MissionScenarioResult): MissionE2eScenarioReport {
  return {
    scenario: result.scenario,
    missionId: result.mission.id,
    status: result.mission.status,
    ...(result.mission.threadId ? { threadId: result.mission.threadId } : {}),
    timelineEvents: result.timeline.length,
    toolEvents: result.timeline.filter((event) => event.kind === "tool").length,
    qualityGate: result.metrics.qualityGate.status,
    metrics: {
      tools: {
        requested: result.metrics.tool.requested,
        results: result.metrics.tool.results,
        failed: result.metrics.tool.failed,
        cancelled: result.metrics.tool.cancelled,
        timeouts: result.metrics.tool.timeouts,
      },
      sessions: {
        spawned: result.metrics.sessions.spawned,
        continued: result.metrics.sessions.continued,
      },
      browser: {
        profileFallbacks: result.metrics.browser?.profileFallbacks ?? 0,
        failureBuckets: summarizeBrowserFailureBuckets(result.metrics.browser?.failureBuckets),
        ...(result.metrics.browser?.latestProfileFallback
          ? { latestProfileFallback: result.metrics.browser.latestProfileFallback }
          : {}),
      },
      approvals: {
        requested: result.metrics.approvals.requested,
        decided: result.metrics.approvals.decided,
        applied: result.metrics.approvals.applied,
      },
      liveness: {
        active: result.metrics.liveness.active,
        waiting: result.metrics.liveness.waiting,
        stale: result.metrics.liveness.stale,
      },
      qualityChecks: summarizeQualityChecks(result.metrics.qualityGate.checks),
      evidenceEvents: result.metrics.qualityGate.evidenceEvents,
      recoveryEvents: result.metrics.recovery.events,
    },
    final: {
      bytes: Buffer.byteLength(result.final.text, "utf8"),
      bullets: result.quality.bullets,
      qualityFailures: [...result.quality.failures],
      ...summarizeCloseout(result.final),
    },
  };
}

export function summarizeNaturalMissionScenarioResult(result: NaturalMissionScenarioResult): NaturalMissionScenarioReport {
  return {
    scenario: result.scenario,
    missionId: result.mission.id,
    status: result.mission.status,
    ...(result.mission.threadId ? { threadId: result.mission.threadId } : {}),
    timelineEvents: result.timeline.length,
    toolEvents: result.timeline.filter((event) => event.kind === "tool").length,
    qualityGate: result.metrics.qualityGate.status,
    metrics: {
      tools: {
        requested: result.metrics.tool.requested,
        results: result.metrics.tool.results,
        failed: result.metrics.tool.failed,
        cancelled: result.metrics.tool.cancelled,
        timeouts: result.metrics.tool.timeouts,
      },
      sessions: {
        spawned: result.metrics.sessions.spawned,
        continued: result.metrics.sessions.continued,
      },
      browser: {
        profileFallbacks: result.metrics.browser?.profileFallbacks ?? 0,
        failureBuckets: summarizeBrowserFailureBuckets(result.metrics.browser?.failureBuckets),
        ...(result.metrics.browser?.latestProfileFallback
          ? { latestProfileFallback: result.metrics.browser.latestProfileFallback }
          : {}),
      },
      approvals: {
        requested: result.metrics.approvals.requested,
        decided: result.metrics.approvals.decided,
        applied: result.metrics.approvals.applied,
      },
      liveness: {
        active: result.metrics.liveness.active,
        waiting: result.metrics.liveness.waiting,
        stale: result.metrics.liveness.stale,
      },
      qualityChecks: summarizeQualityChecks(result.metrics.qualityGate.checks),
      evidenceEvents: result.metrics.qualityGate.evidenceEvents,
      recoveryEvents: result.metrics.recovery.events,
    },
    artifacts: summarizeMissionArtifacts(result.artifacts),
    natural: {
      status: result.quality.status,
      completed: result.quality.completed,
      stuckOrLoop: result.quality.stuckOrLoop,
      reasonableToolUse: result.quality.reasonableToolUse,
      browserUsed: result.quality.browserUsed,
      profileFallbackFree: result.quality.profileFallbackFree,
      subAgentCompleted: result.quality.subAgentCompleted,
      approvalExercised: result.quality.approvalExercised,
      finalAnswerHasEvidence: result.quality.finalAnswerHasEvidence,
      finalAnswerUseful: result.quality.finalAnswerUseful,
      sourceCoverage: result.quality.sourceCoverage,
      weakAnswerSignals: [...result.quality.weakAnswerSignals],
      failures: [...result.quality.failures],
    },
    final: {
      bytes: Buffer.byteLength(result.final.text, "utf8"),
      excerpt: compactExcerpt(result.final.text, 500),
    },
  };
}

function summarizeMissionArtifacts(
  artifacts: MissionArtifact[] | undefined
): NaturalMissionScenarioReport["artifacts"] {
  const items = artifacts ?? [];
  return {
    count: items.length,
    withLifecycle: items.filter(hasArtifactLifecycleEvidence).length,
    kinds: [...new Set(items.map((artifact) => artifact.kind).filter((kind) => kind.length > 0))].sort(),
  };
}

function compactExcerpt(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeCloseout(final: ActivityEvent): Pick<MissionE2eScenarioReport["final"], "closeout"> {
  const reason = final.runtime?.["toolLoopCloseoutReason"];
  if (typeof reason !== "string") {
    return {};
  }
  const evidenceAvailable = final.runtime?.["toolLoopCloseout.evidenceAvailable"];
  return {
    closeout: {
      reason,
      ...(typeof evidenceAvailable === "string" ? { evidenceAvailable } : {}),
    },
  };
}

function isPassingMissionScenarioReport(report: MissionE2eScenarioReport): boolean {
  const expectedQualityGate =
    report.scenario === "budget-limited-closeout"
      ? "needs_attention"
      : report.scenario === "sub-agent-timeout-closeout"
        ? "blocked"
        : report.scenario === "timeout-recovery" || report.scenario === "cancel"
          ? "blocked"
        : "passed";
  const expectedCloseoutReason =
    report.scenario === "budget-limited-closeout"
      ? "round_limit"
      : report.scenario === "sub-agent-timeout-closeout"
        ? "sub_agent_timeout"
        : report.scenario === "timeout-recovery"
          ? "sub_agent_timeout"
        : null;
  const hasExpectedAttentionEvidence =
    report.scenario === "timeout-recovery"
      ? report.metrics.tools.failed >= 1 && report.metrics.tools.timeouts >= 1 && report.metrics.tools.cancelled === 0
      : report.scenario === "cancel"
        ? report.metrics.tools.cancelled >= 1 && report.metrics.tools.timeouts === 0
        : true;
  const hasUnexpectedForcedCloseout =
    expectedCloseoutReason === null &&
    typeof report.final.closeout?.reason === "string" &&
    FORCED_TOOL_LOOP_CLOSEOUT_REASONS.has(report.final.closeout.reason);
  return (
    report.status === "done" &&
    report.qualityGate === expectedQualityGate &&
    (expectedCloseoutReason === null || report.final.closeout?.reason === expectedCloseoutReason) &&
    hasExpectedAttentionEvidence &&
    !hasUnexpectedForcedCloseout &&
    report.final.qualityFailures.length === 0
  );
}

function summarizeQualityChecks(
  checks: MissionObservabilitySnapshot["qualityGate"]["checks"] | undefined
): MissionE2eScenarioReport["metrics"]["qualityChecks"] {
  if (!Array.isArray(checks)) {
    return [];
  }
  return checks.flatMap((check) => {
    if (typeof check.name !== "string" || typeof check.status !== "string") {
      return [];
    }
    return [
      {
        name: check.name,
        status: check.status,
        detail: typeof check.detail === "string" ? check.detail : "",
      },
    ];
  });
}

function summarizeBrowserFailureBuckets(
  buckets: NonNullable<MissionObservabilitySnapshot["browser"]>["failureBuckets"] | undefined
): MissionE2eScenarioReport["metrics"]["browser"]["failureBuckets"] {
  if (!Array.isArray(buckets)) return [];
  return buckets.flatMap((item) => {
    if (typeof item.bucket !== "string" || typeof item.count !== "number" || typeof item.latestAtMs !== "number") {
      return [];
    }
    return [{ bucket: item.bucket, count: item.count, latestAtMs: item.latestAtMs }];
  });
}

function formatBrowserFailureBuckets(buckets: Array<{ bucket: string; count: number }> | undefined): string {
  if (!buckets?.length) return "none";
  return buckets.map((item) => `${item.bucket}=${item.count}`).join(",");
}

function writeMissionE2eJsonReport(jsonPath: string, report: MissionE2eJsonReport): void {
  const resolvedPath = path.resolve(jsonPath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function writeNaturalMissionE2eJsonReport(jsonPath: string, report: NaturalMissionE2eJsonReport): void {
  const resolvedPath = path.resolve(jsonPath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function resolveModelCatalogPath(explicitPath?: string): string {
  if (explicitPath?.trim()) {
    const candidate = path.resolve(explicitPath.trim());
    readFileSync(candidate, "utf8");
    return candidate;
  }
  const candidates = [
    process.env.TURNKEYAI_MODEL_CATALOG,
    path.resolve(process.cwd(), "models.local.json"),
    path.resolve(process.cwd(), "models.json"),
  ].filter((item): item is string => Boolean(item?.trim()));
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, "utf8");
      return path.resolve(candidate);
    } catch {}
  }
  throw new Error("mission E2E requires --model-catalog, TURNKEYAI_MODEL_CATALOG, models.local.json, or models.json");
}

function writeCancelResumeFixture(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html>
  <head><title>TurnkeyAI Cancel Resume E2E Fixture</title></head>
  <body>
    <main>
      <h1>Cancel resume release source</h1>
      <p>Verified owner: Release Captain.</p>
      <p>Verified risk: runbook gap before launch approval.</p>
      <p>Mitigation: complete rollback rehearsal before release gate.</p>
    </main>
  </body>
</html>`);
}

async function startFixtureServer(): Promise<FixtureServer> {
  let cancelResumeRequestCount = 0;
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/fixture") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head><title>TurnkeyAI Mission E2E Fixture</title></head>
  <body>
    <main>
      <h1>Mission route tool-use fixture</h1>
      <p id="marker">${FIXTURE_MARKER}</p>
      <p>Evidence source: local fixture served only for the mission route acceptance test.</p>
    </main>
  </body>
</html>`);
      return;
    }
    if (pathname === "/slow-fixture") {
      const timer = setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <head><title>TurnkeyAI Slow Mission E2E Fixture</title></head>
  <body>
    <main>
      <h1>Slow mission route tool-use fixture</h1>
      <p id="marker">${FIXTURE_MARKER}</p>
      <p>This response is intentionally delayed so the cancellation path can stop the active tool call.</p>
    </main>
  </body>
</html>`);
      }, 180_000);
      req.on("close", () => clearTimeout(timer));
      return;
    }
    if (pathname === "/cancel-resume-fixture") {
      cancelResumeRequestCount += 1;
      if (cancelResumeRequestCount === 1) {
        const timer = setTimeout(() => {
          if (res.destroyed) return;
          writeCancelResumeFixture(res);
        }, 180_000);
        req.on("close", () => clearTimeout(timer));
        return;
      }
      writeCancelResumeFixture(res);
      return;
    }
    if (pathname === "/__cancel-resume-state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ cancelResumeRequestCount }));
      return;
    }
    if (pathname === "/vendor-alpha") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head><title>Vendor Alpha Evidence</title></head>
  <body>
    <main>
      <h1>Vendor Alpha</h1>
      <p id="marker">${ALPHA_MARKER}</p>
      <p>Pricing: $19 per seat.</p>
      <p>Strength: browser automation and traceable screenshots.</p>
      <p>Risk: API integration catalog is still limited.</p>
    </main>
  </body>
</html>`);
      return;
    }
    if (pathname === "/vendor-beta") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head><title>Vendor Beta Evidence</title></head>
  <body>
    <main>
      <h1>Vendor Beta</h1>
      <p id="marker">${BETA_MARKER}</p>
      <p>Pricing: $29 per workspace.</p>
      <p>Strength: approval workflow and team handoff history.</p>
      <p>Risk: browser control requires a separate connector.</p>
    </main>
  </body>
</html>`);
      return;
    }
    if (pathname === "/approval-form") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head><title>Approval Gate Fixture</title></head>
	  <body>
	    <main>
	      <h1>Approval gate fixture</h1>
	      <p id="marker">${APPROVAL_MARKER}</p>
	      <p>This local page is safe evidence for browser.form.submit approval gating; no external mutation is performed.</p>
	      <form id="dry-run-form">
	        <label>
	          Review note
	          <input name="note" value="local approval dry-run" />
	        </label>
	        <button type="submit">Submit dry-run</button>
	      </form>
	      <p id="dry-run-result" aria-live="polite">Dry-run has not been submitted.</p>
	    </main>
	    <script>
	      document.getElementById("dry-run-form").addEventListener("submit", (event) => {
	        event.preventDefault();
	        window.__turnkeyApprovalDryRun = { submitted: true, marker: "${APPROVAL_MARKER}" };
	        document.getElementById("dry-run-result").textContent =
	          "Dry-run submitted locally after approval; no external mutation was performed. ${APPROVAL_MARKER}";
	      });
	    </script>
	  </body>
	</html>`);
      return;
    }
    if (pathname === "/dynamic-dashboard") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head>
    <title>Dynamic Browser Fixture</title>
    <script>
      window.__turnkeyDynamicState = { status: "booting" };
      const joinDynamicEvidence = (...parts) => parts.join("");
      const renderTurnkeyDynamicFixture = () => {
        const root = document.getElementById("dynamic-root");
        if (!root) {
          window.__turnkeyDynamicState = { status: "missing-root" };
          return;
        }
        const marker = joinDynamicEvidence("TURNKEYAI_DYNAMIC", "_BROWSER", "_OK");
        const activeUsers = 40 + 2;
        const queueDepth = 3 + 4;
        window.__turnkeyDynamicState = {
          status: "ready",
          marker,
          activeUsers,
          queueDepth,
          source: "client-rendered local fixture"
        };
        root.innerHTML = [
          "<h1>Dynamic operations dashboard</h1>",
          "<p id='marker'>" + marker + "</p>",
          "<p id='active-users'>Active users: " + activeUsers + "</p>",
          "<p id='queue-depth'>Queue depth: " + queueDepth + "</p>",
          "<p id='risk'>Residual risk: local dynamic fixture only.</p>"
        ].join("");
      };
      if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", renderTurnkeyDynamicFixture, { once: true });
      } else {
        renderTurnkeyDynamicFixture();
      }
    </script>
  </head>
  <body>
    <main id="dynamic-root">
      <h1>Loading dynamic dashboard</h1>
      <p>Server HTML does not contain the evidence marker; browser JavaScript must render it.</p>
    </main>
  </body>
</html>`);
      return;
    }
    if (pathname === "/ops-dashboard") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head>
    <title>Operations Dashboard Fixture</title>
    <script>
      window.__turnkeyDashboardState = { status: "booting" };
      const joinDashboardEvidence = (...parts) => parts.join("");
      const renderTurnkeyDashboardFixture = () => {
        const root = document.getElementById("dashboard-root");
        if (!root) {
          window.__turnkeyDashboardState = { status: "missing-root" };
          return;
        }
        const marker = joinDashboardEvidence("TURNKEYAI_DASHBOARD", "_TRIAGE", "_OK");
        const queueDepth = 8 + 3;
        const slaBreaches = 1 + 2;
        const escalationThreshold = joinDashboardEvidence("queue depth above ", "5", " or SLA breaches above ", "0");
        const recommendedOwner = joinDashboardEvidence("Incident", " Commander");
        window.__turnkeyDashboardState = {
          status: "ready",
          marker,
          queueDepth,
          slaBreaches,
          escalationThreshold,
          recommendedOwner,
          source: "client-rendered local dashboard fixture"
        };
        root.innerHTML = [
          "<h1>Operations dashboard</h1>",
          "<p id='marker'>" + marker + "</p>",
          "<p id='queue-depth'>Queue depth: " + queueDepth + "</p>",
          "<p id='sla-breaches'>SLA breaches: " + slaBreaches + "</p>",
          "<p id='escalation-threshold'>Escalation threshold: " + escalationThreshold + " pages the on-call.</p>",
          "<p id='recommended-owner'>Recommended owner: " + recommendedOwner + "</p>",
          "<p id='scope'>Residual risk: local dynamic dashboard fixture only.</p>"
        ].join("");
      };
      if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", renderTurnkeyDashboardFixture, { once: true });
      } else {
        renderTurnkeyDashboardFixture();
      }
    </script>
  </head>
  <body>
    <main id="dashboard-root">
      <h1>Loading operations dashboard</h1>
      <p>Server HTML does not contain triage evidence; browser JavaScript must render it.</p>
    </main>
  </body>
</html>`);
      return;
    }
    if (pathname === "/product-orchestration") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head><title>Product Orchestration Evidence</title></head>
  <body>
    <main>
      <h1>Agent workbench orchestration</h1>
      <p id="marker">${PRODUCT_ORCHESTRATION_MARKER}</p>
      <p>Primary user story: a product lead starts one mission, then specialist agents watch documents, browser state, and work items until a decision-ready brief is produced.</p>
      <p>Strength: multi-agent decomposition with durable sub-session history and follow-up.</p>
      <p>Gap: users need clearer entry points than a developer command line.</p>
    </main>
  </body>
</html>`);
      return;
    }
    if (pathname === "/product-bridge") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head><title>Bridge Capability Evidence</title></head>
  <body>
    <main>
      <h1>Browser bridge capability surface</h1>
      <p id="marker">${PRODUCT_BRIDGE_MARKER}</p>
      <p>Controls: open pages, inspect rendered DOM, act on coordinates and forms after approval, collect screenshots, console output, and artifacts.</p>
      <p>Boundary: browser work is a means for mission completion; the bridge does not control the desktop outside the browser.</p>
      <p>Risk: command-line setup and provider configuration still block first-run adoption.</p>
    </main>
  </body>
</html>`);
      return;
    }
    if (pathname === "/product-signals") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head>
    <title>Workbench Product Signals</title>
    <script>
      window.__turnkeyProductSignals = { status: "booting" };
      const joinProductSignal = (...parts) => parts.join("");
      const renderTurnkeyProductSignals = () => {
        const root = document.getElementById("product-signal-root");
        if (!root) {
          window.__turnkeyProductSignals = { status: "missing-root" };
          return;
        }
        const marker = joinProductSignal("TURNKEYAI_PRODUCT", "_WORKBENCH_SIGNAL", "_OK");
        const stuckMissions = 4 + 2;
        const weakAnswerRate = 18 + 6;
        const nextAction = joinProductSignal(
          "make Mission ",
          "Control the default ",
          "entry and gate ",
          "release on real ",
          "LLM scenario quality"
        );
        window.__turnkeyProductSignals = {
          status: "ready",
          marker,
          stuckMissions,
          weakAnswerRate,
          nextAction,
          source: "client-rendered product signal fixture"
        };
        root.innerHTML = [
          "<h1>Workbench product signals</h1>",
          "<p id='marker'>" + marker + "</p>",
          "<p id='stuck-missions'>Stuck missions: " + stuckMissions + "</p>",
          "<p id='weak-answer-rate'>Weak answer rate: " + weakAnswerRate + "%</p>",
          "<p id='next-action'>Recommended next action: " + nextAction + "</p>",
          "<p id='scope'>Residual risk: local product signal fixture only.</p>"
        ].join("");
      };
      if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", renderTurnkeyProductSignals, { once: true });
      } else {
        renderTurnkeyProductSignals();
      }
    </script>
  </head>
  <body>
    <main id="product-signal-root">
      <h1>Loading product signals</h1>
      <p>Server HTML does not contain the product signal marker; browser JavaScript must render it.</p>
    </main>
  </body>
</html>`);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  });
  const port = await listenOnRandomPort(server);
  return {
    server,
    basicUrl: `http://127.0.0.1:${port}/fixture`,
    alphaUrl: `http://127.0.0.1:${port}/vendor-alpha`,
    betaUrl: `http://127.0.0.1:${port}/vendor-beta`,
    slowUrl: `http://127.0.0.1:${port}/slow-fixture`,
    cancelResumeUrl: `http://127.0.0.1:${port}/cancel-resume-fixture`,
    cancelResumeStateUrl: `http://127.0.0.1:${port}/__cancel-resume-state`,
    approvalUrl: `http://127.0.0.1:${port}/approval-form`,
    dynamicUrl: `http://127.0.0.1:${port}/dynamic-dashboard`,
    dashboardUrl: `http://127.0.0.1:${port}/ops-dashboard`,
    orchestrationUrl: `http://127.0.0.1:${port}/product-orchestration`,
    bridgeUrl: `http://127.0.0.1:${port}/product-bridge`,
    productSignalsUrl: `http://127.0.0.1:${port}/product-signals`,
  };
}

async function assertRenderedFixtureEvidenceHidden(fixture: FixtureServer): Promise<void> {
  await assertRawFixtureOmits({
    label: "dynamic browser fixture",
    url: fixture.dynamicUrl,
    forbidden: [DYNAMIC_BROWSER_MARKER, "Active users: 42", "Queue depth: 7"],
  });
  await assertRawFixtureOmits({
    label: "browser dashboard fixture",
    url: fixture.dashboardUrl,
    forbidden: [
      DASHBOARD_TRIAGE_MARKER,
      "Queue depth: 11",
      "SLA breaches: 3",
      "queue depth above 5 or SLA breaches above 0",
      "Incident Commander",
    ],
  });
  await assertRawFixtureOmits({
    label: "product workbench signal fixture",
    url: fixture.productSignalsUrl,
    forbidden: [
      PRODUCT_WORKBENCH_SIGNAL_MARKER,
      "Stuck missions: 6",
      "Weak answer rate: 24%",
      "make Mission Control the default entry",
    ],
  });
}

async function assertRawFixtureOmits(input: {
  label: string;
  url: string;
  forbidden: string[];
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(input.url, { signal: controller.signal });
  } catch (error) {
    throw new Error(`${input.label} raw fixture fetch failed before mission E2E starts: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(response.ok, true, `${input.label} raw fixture should be readable before mission E2E starts`);
  const html = await response.text();
  for (const term of input.forbidden) {
    assert.equal(
      html.includes(term),
      false,
      `${input.label} leaked browser-only evidence in raw server HTML: ${term}`
    );
  }
}

async function createMission(input: {
  baseUrl: string;
  token: string;
  spec: ScenarioSpec;
}): Promise<Mission> {
  return requestJson<Mission>({
    method: "POST",
    url: `${input.baseUrl}/missions`,
    token: input.token,
    body: {
      title: input.spec.title,
      mode: "research",
      desc: input.spec.desc,
      owner: "e2e",
      ownerLabel: "E2E",
    },
  });
}

function buildMemoryRecallSetupSpec(): ScenarioSpec {
  return {
    scenario: "memory-recall",
    title: "Mission route durable memory recall setup",
    finalMarker: MEMORY_SETUP_MARKER,
    evidenceMarkers: [],
    answerTerms: ["setup"],
    expectedSpawnCalls: 0,
    expectedSendCalls: 0,
    expectedToolResults: 0,
    expectedSpawnedSessions: 0,
    expectedContinuedSessions: 0,
    minEvidenceEvents: 0,
    expectedBullets: 1,
    minBytes: 40,
    desc: [
      "Prepare a follow-up-only durable memory recall acceptance test.",
      `Do not use tools. Reply with one Markdown bullet containing ${MEMORY_SETUP_MARKER} and the word setup.`,
      "Do not use tables, links, code fences, or bold/italic markup.",
    ].join("\n"),
  };
}

async function seedMemoryRecallFixture(input: {
  runtimeRoot: string;
  threadId: string;
  markerMode?: "contract" | "natural";
}): Promise<void> {
  const store = new FileThreadMemoryStore({
    rootDir: path.join(input.runtimeRoot, "data", "context", "thread-memory"),
  });
  const launchNote =
    input.markerMode === "natural"
      ? "Helios-47 launch window is Tuesday 09:30. Owner is Release Captain. Residual risk: calendar lock is remembered locally and should be verified before external release announcements."
      : `Memory recall fixture: ${MEMORY_SOURCE_MARKER}. Helios-47 launch window is Tuesday 09:30. Owner is Release Captain.`;
  const existing = await store.get(input.threadId);
  const record: ThreadMemoryRecord = {
    threadId: input.threadId,
    updatedAt: Date.now(),
    preferences: appendUnique(
      existing?.preferences ?? [],
      "For memory recall acceptance, prefer source-backed launch briefs over unstated assumptions."
    ),
    constraints: appendUnique(
      existing?.constraints ?? [],
      "When asked about Helios-47, use the durable memory launch window exactly as written."
    ),
    longTermNotes: appendUnique(existing?.longTermNotes ?? [], launchNote),
  };
  await store.put(record);
  const saved = await store.get(input.threadId);
  assert.ok(
    saved?.longTermNotes.some((note) => note.includes("Helios-47") && note.includes("Tuesday 09:30")),
    "memory recall fixture must persist the Helios-47 launch note before follow-up"
  );
}

function appendUnique(values: string[], next: string): string[] {
  return values.includes(next) ? values : [...values, next];
}

function buildScenarioSpec(scenario: MissionE2eScenario, fixture: FixtureServer): ScenarioSpec {
  if (scenario === "memory-recall") {
    return {
      scenario,
      title: "Mission route durable memory recall E2E",
      finalMarker: MEMORY_RECALL_FINAL_MARKER,
      evidenceMarkers: [MEMORY_SOURCE_MARKER],
      answerTerms: ["memory_search", "memory_get", "Helios-47", "Tuesday 09:30", "Release Captain", "residual risk"],
      answerPatterns: [
        { label: "memory-search tool reference", pattern: /memory_search/i },
        { label: "memory-get tool reference", pattern: /memory_get/i },
      ],
      evidenceLinePatterns: [
        {
          label: "recalled memory line",
          pattern: /^\s*[-*+]\s+recalled memory\s*:.*TURNKEYAI_MISSION_MEMORY_RECALL_OK.*TURNKEYAI_MEMORY_RECALL_SOURCE_OK.*memory_get/im,
        },
        {
          label: "launch plan line",
          pattern: /^\s*[-*+]\s+launch plan\s*:.*Helios-47.*Tuesday 09:30.*Release Captain/im,
        },
        { label: "residual risk line", pattern: /^\s*[-*+]\s+residual risk\s*:/im },
      ],
      forbiddenPatterns: [
        { label: "session delegation", pattern: /\bsessions_(?:spawn|send|list|history)\b/i },
        { label: "internal source URL", pattern: /https?:\/\//i },
      ],
      expectedSpawnCalls: 0,
      expectedSendCalls: 0,
      expectedToolResults: 2,
      expectedToolResultsMax: 3,
      expectedSpawnedSessions: 0,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 2,
      expectedBullets: 3,
      minBytes: 220,
      maxBytes: 1_000,
      desc: [
        "Continue this mission by proving durable memory recall through native memory tools.",
        "Call memory_search with a query for the Helios-47 launch window, owner, and recall marker.",
        "Target one memory_search call; a single clarifying memory_search is allowed only if the first result is ambiguous. Do not exceed two memory_search calls.",
        "Then call memory_get exactly once using the best memory_id returned by memory_search before writing the final answer.",
        "Do not call sessions_spawn, sessions_send, sessions_history, sessions_list, browser tools, permission tools, or task tools.",
        `Final answer may include ${MEMORY_RECALL_FINAL_MARKER} exactly once, only inside the first bullet. It must also include ${MEMORY_SOURCE_MARKER}, Helios-47, Tuesday 09:30, Release Captain, memory_search, memory_get, and the exact words residual risk.`,
        "Use this exact final answer shape after memory_get returns:",
        "## Memory evidence",
        `- recalled memory: ${MEMORY_RECALL_FINAL_MARKER}; ${MEMORY_SOURCE_MARKER} was retrieved through memory_search followed by memory_get.`,
        "- launch plan: Helios-47 launch window is Tuesday 09:30; owner is Release Captain.",
        "- residual risk: this validates local durable thread memory only, not an external source.",
        "Do not create a separate bullet, heading, or paragraph for the final success marker.",
        "Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    };
  }
  if (scenario === "task-tracking") {
    return {
      scenario,
      title: "Mission route task tracking E2E",
      finalMarker: TASK_TRACKING_FINAL_MARKER,
      evidenceMarkers: [],
      answerTerms: [
        "tasks_list",
        "tasks_create",
        "tasks_update",
        "Verify Helios-47 rollout note",
        "done",
        "residual risk",
      ],
      answerPatterns: [
        { label: "task-list reference", pattern: /tasks_list/i },
        { label: "task-create reference", pattern: /tasks_create/i },
        { label: "task-update reference", pattern: /tasks_update/i },
      ],
      evidenceLinePatterns: [
        {
          label: "task lifecycle line",
          pattern: /^\s*[-*+]\s+task lifecycle\s*:.*TURNKEYAI_MISSION_TASK_TRACKING_OK.*tasks_list.*tasks_create.*tasks_update/im,
        },
        {
          label: "tracked item line",
          pattern: /^\s*[-*+]\s+tracked item\s*:.*Verify Helios-47 rollout note.*done.*progress 1/im,
        },
        { label: "residual risk line", pattern: /^\s*[-*+]\s+residual risk\s*:/im },
      ],
      forbiddenPatterns: [
        { label: "session delegation", pattern: /\bsessions_(?:spawn|send|list|history)\b/i },
        { label: "internal source URL", pattern: /https?:\/\//i },
      ],
      expectedSpawnCalls: 0,
      expectedSendCalls: 0,
      expectedToolResults: 3,
      expectedToolResultsMax: 4,
      expectedSpawnedSessions: 0,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 3,
      expectedBullets: 3,
      minBytes: 240,
      maxBytes: 1_100,
      desc: [
        "Run the mission route task tracking E2E.",
        "Use mission task tools to prove the agent can keep product-visible work state current.",
        "Call tasks_list exactly once first with limit 10.",
        "Then call tasks_create with title \"Verify Helios-47 rollout note\", status \"working\", and output \"Task tracking acceptance started\".",
        "Target one tasks_create call. If a duplicate tasks_create call occurs with the same title, the tool service must return the existing work item instead of creating a second persisted item.",
        "Then call tasks_update exactly once using the work_item_id returned by tasks_create. Set status \"done\", progress 1, and output \"Task tracking acceptance complete\".",
        "Do not call sessions_spawn, sessions_send, sessions_history, sessions_list, browser tools, permission tools, or memory tools.",
        `Final answer may include ${TASK_TRACKING_FINAL_MARKER} exactly once, only inside the first bullet. It must also include tasks_list, tasks_create, tasks_update, Verify Helios-47 rollout note, done, progress 1, and the exact words residual risk.`,
        "Use this exact final answer shape after tasks_update returns:",
        "## Task tracking",
        `- task lifecycle: ${TASK_TRACKING_FINAL_MARKER}; tool result evidence shows tasks_list checked existing work, tasks_create created the item, and tasks_update completed it.`,
        "- tracked item: Verify Helios-47 rollout note is done with progress 1.",
        "- residual risk: this validates local mission task state only, not external project delivery.",
        "Do not create a separate bullet, heading, or paragraph for the final success marker.",
        "Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    };
  }
  if (scenario === "product-workbench-brief") {
    return {
      scenario,
      title: "Mission route product workbench brief E2E",
      finalMarker: PRODUCT_WORKBENCH_FINAL_MARKER,
      evidenceMarkers: [PRODUCT_ORCHESTRATION_MARKER, PRODUCT_BRIDGE_MARKER, PRODUCT_WORKBENCH_SIGNAL_MARKER],
      answerTerms: [
        "multi-agent",
        "durable sub-session history",
        "browser bridge",
        "Mission Control",
        "Stuck missions: 6",
        "Weak answer rate: 24%",
        "default entry",
        "real LLM scenario quality",
        "residual risk",
      ],
      answerPatterns: [
        { label: "decision-grade recommendation", pattern: /recommend|prioritiz|default entry|ship/i },
        { label: "browser-rendered product signal evidence", pattern: /browser|JavaScript|client-rendered|rendered DOM/i },
        { label: "agent orchestration framing", pattern: /multi-agent|specialist agents|sub-session/i },
      ],
      evidenceLinePatterns: [
        {
          label: "orchestration evidence line",
          pattern: /^\s*[-*+]\s+orchestration evidence\s*:.*TURNKEYAI_PRODUCT_ORCHESTRATION_OK.*multi-agent.*durable sub-session history/im,
        },
        {
          label: "bridge evidence line",
          pattern:
            /^\s*[-*+]\s+bridge evidence\s*:.*(?:Bridge capability research|browser bridge).*TURNKEYAI_PRODUCT_BRIDGE_OK.*(?:browser bridge|controls).*(?:desktop (?:control )?outside the browser|browser-only (?:scope|work scoped|boundary|mission completion)|browser-only.*desktop control)/im,
        },
        {
          label: "browser signal evidence line",
          pattern: /^\s*[-*+]\s+browser signal evidence\s*:.*TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK.*Stuck missions: 6.*Weak answer rate: 24%/im,
        },
        {
          label: "recommendation line",
          pattern: /^\s*[-*+]\s+recommendation\s*:.*TURNKEYAI_MISSION_PRODUCT_WORKBENCH_OK.*Mission Control.*default entry.*real LLM scenario quality/im,
        },
        { label: "next actions line", pattern: /^\s*[-*+]\s+next actions\s*:/im },
        { label: "residual risk line", pattern: /^\s*[-*+]\s+residual risk\s*:/im },
      ],
      forbiddenPatterns: [
        { label: "unsupported external adoption claim", pattern: /\b(millions of users|market share|widely adopted|customers)\b/i },
        { label: "unsupported native shell claim", pattern: /\b(Electron is shipped|Tauri is shipped|native app is complete)\b/i },
        { label: "unresolved placeholder", pattern: /\b(TBD|to be confirmed|needs confirmation|待确认|估算)\b/i },
        { label: "internal source URL", pattern: /https?:\/\//i },
      ],
      minBytes: 900,
      maxBytes: 2_600,
      expectedSpawnCalls: 3,
      expectedSpawnCallsMax: 4,
      expectedSendCalls: 0,
      expectedToolResults: 3,
      expectedToolResultsMax: 4,
      expectedSpawnedSessions: 3,
      expectedSpawnedSessionsMax: 4,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 3,
      expectedSourceLabels: [PRODUCT_ORCHESTRATION_SOURCE_LABEL, PRODUCT_BRIDGE_SOURCE_LABEL, PRODUCT_SIGNALS_SOURCE_LABEL],
      expectedBullets: 6,
      allowAtLeastBullets: true,
      desc: [
        "Prepare a decision-grade product brief for the next agent workbench release.",
        "Use the available session tools. Do not answer from memory.",
        "Gather evidence from three independent child sessions before finalizing:",
        `- Orchestration: use an explore session with label "${PRODUCT_ORCHESTRATION_SOURCE_LABEL}" to fetch ${fixture.orchestrationUrl} and extract marker ${PRODUCT_ORCHESTRATION_MARKER}, primary user story, strength, and gap.`,
        `- Bridge capability: use an explore session with label "${PRODUCT_BRIDGE_SOURCE_LABEL}" to fetch ${fixture.bridgeUrl} and extract marker ${PRODUCT_BRIDGE_MARKER}, controls, boundary, and risk.`,
        `- Product signals: use a browser session with label "${PRODUCT_SIGNALS_SOURCE_LABEL}", not direct fetch, to open ${fixture.productSignalsUrl}; inspect the JavaScript-rendered dashboard and extract marker ${PRODUCT_WORKBENCH_SIGNAL_MARKER}, Stuck missions: 6, Weak answer rate: 24%, and the recommended next action.`,
        "Each sessions_spawn input must include the exact label named above for that source.",
        "Do not finalize until all three child session tool results have returned and all three markers are present in tool evidence.",
        "The final answer must be useful to a product lead. It must state what to build next, why, what not to over-emphasize, and what risk remains.",
        "Do not frame browser control as the product itself; frame it as one capability inside a larger multi-agent workbench.",
        "Do not claim a native Electron/Tauri shell is already shipped.",
        "Do not infer market adoption, external outages, customer counts, or external pricing beyond the local fixture text.",
        "Never write assume, assumed, estimate, probably, maybe, to be confirmed, or pending confirmation in the final answer.",
        "The bridge evidence bullet must keep the phrase browser bridge controls unless doing so would duplicate the source label awkwardly.",
        `The recommendation bullet must start with "- recommendation: ${PRODUCT_WORKBENCH_FINAL_MARKER}" and state the release decision.`,
        "Keep the final answer concise, under 230 words.",
        "Use exactly this section skeleton for the final answer, with no preamble before it and no closing note after it:",
        "The first non-empty line of the final answer must be exactly: evidence",
        "Do not write any completion/status sentence before the first section label.",
        "evidence",
        `- orchestration evidence: ${PRODUCT_ORCHESTRATION_SOURCE_LABEL}; ${PRODUCT_ORCHESTRATION_MARKER}; include primary user story, multi-agent decomposition, durable sub-session history, and gap.`,
        `- bridge evidence: ${PRODUCT_BRIDGE_SOURCE_LABEL}; ${PRODUCT_BRIDGE_MARKER}; browser bridge controls; include browser-only boundary and first-run setup risk.`,
        `- browser signal evidence: ${PRODUCT_SIGNALS_SOURCE_LABEL}; ${PRODUCT_WORKBENCH_SIGNAL_MARKER}; include Stuck missions: 6, Weak answer rate: 24%, and that the evidence came from browser-rendered JavaScript or client-rendered DOM.`,
        "decision",
        `- recommendation: ${PRODUCT_WORKBENCH_FINAL_MARKER} - make Mission Control the default entry and gate release on real LLM scenario quality before expanding native shell work.`,
        "- next actions: list exactly three concrete build actions for onboarding, mission completion quality, and bridge/runtime diagnostics.",
        "- residual risk: state what remains source-bounded to local fixtures and what still needs real-world validation.",
        "Do not include source URLs in the final answer; cite source names and markers instead.",
        "Use plain section labels or plain Markdown headings only; do not wrap section labels in ** or __.",
        "Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    };
  }
  if (scenario === "realistic-brief") {
    return {
      scenario,
      title: "Mission route realistic operator brief E2E",
      finalMarker: REALISTIC_BRIEF_FINAL_MARKER,
      evidenceMarkers: [ALPHA_MARKER, BETA_MARKER, DASHBOARD_TRIAGE_MARKER],
      answerTerms: [
        "Alpha",
        "Beta",
        "$19 per seat",
        "$29 per workspace",
        "Queue depth",
        "SLA breaches",
        "Incident Commander",
        "recommend",
        "residual risk",
      ],
      answerPatterns: [
        { label: "actionable recommendation", pattern: /recommend|choose|prefer|better fit|suits|fits|prioritiz/i },
        { label: "browser-rendered dashboard evidence", pattern: /browser|JavaScript|client-rendered|rendered DOM|dynamic dashboard/i },
        { label: "source-bounded evidence", pattern: /local fixture|source-bounded|verified sources|source coverage|local sources/i },
        { label: "queue depth value", pattern: /queue depth(?:\s*:|\s+of)?\s*11/i },
        { label: "SLA breach value", pattern: RENDERED_SLA_BREACHES_VALUE_PATTERN },
      ],
      forbiddenPatterns: [
        { label: "unsupported adoption claim", pattern: /\b(millions of users|large community|market share|widely adopted|customers)\b/i },
        { label: "unsupported external incident claim", pattern: /\b(real outage|production outage|customer impact confirmed)\b/i },
        { label: "unsupported pricing claim", pattern: /\bfree plan|enterprise pricing|starts at \$\d+\b/i },
        { label: "unresolved placeholder", pattern: /\b(TBD|to be confirmed|needs confirmation|待确认|估算)\b/i },
      ],
      minBytes: 700,
      maxBytes: 2_200,
      expectedSpawnCalls: 3,
      expectedSendCalls: 0,
      expectedToolResults: 3,
      expectedSpawnedSessions: 3,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 3,
      expectedSourceLabels: ["Vendor Alpha", "Vendor Beta", "Ops dashboard"],
      expectedBullets: 5,
      allowAtLeastBullets: true,
      desc: [
        "Prepare an operator-ready brief for a product lead deciding how to allocate next week's agent workbench effort.",
        "Use the available session tools. Do not answer from memory.",
        "Gather evidence from three independent child sessions before finalizing:",
        `- Vendor Alpha: use an explore session with label "Vendor Alpha" to fetch ${fixture.alphaUrl} and extract marker ${ALPHA_MARKER}, price, strength, and risk.`,
        `- Vendor Beta: use an explore session with label "Vendor Beta" to fetch ${fixture.betaUrl} and extract marker ${BETA_MARKER}, price, strength, and risk.`,
        `- Ops dashboard: use a browser session with label "Ops dashboard", not direct fetch, to open ${fixture.dashboardUrl}; inspect the JavaScript-rendered dashboard and extract marker ${DASHBOARD_TRIAGE_MARKER}, Queue depth: 11, SLA breaches: 3, escalation threshold, and Recommended owner.`,
        "Each sessions_spawn input must include the exact label named above for that source.",
        "Do not finalize until all three child session tool results have returned and all three markers are present in tool evidence.",
        "Write a concise final brief for a busy operator. It should include source coverage, a recommendation, the current dashboard action, and residual risk.",
        "Every source coverage, recommendation, dashboard action, and residual-risk item in the final answer must be a Markdown bullet.",
        "The Vendor Alpha source coverage bullet must include the exact price $19 per seat.",
        "The Vendor Beta source coverage bullet must include the exact price $29 per workspace.",
        "Do not infer currency, billing cadence, adoption, outages, or availability beyond the local fixture text.",
        "Never write assume, assumed, estimate, probably, maybe, to be confirmed, or pending confirmation in the final answer.",
        `The recommendation bullet must start with "- recommendation: ${REALISTIC_BRIEF_FINAL_MARKER}" and state the decision.`,
        "Use exactly this section skeleton for the final answer, with no preamble before it and no closing note after it:",
        "The first non-empty line of the final answer must be exactly: source coverage",
        "Do not write any completion/status sentence before the first section label.",
        "source coverage",
        `- Vendor Alpha (${ALPHA_MARKER}): include price $19 per seat, strength, and risk.`,
        `- Vendor Beta (${BETA_MARKER}): include price $29 per workspace, strength, and risk.`,
        `- Ops dashboard (${DASHBOARD_TRIAGE_MARKER}): include Queue depth: 11, SLA breaches: 3, escalation threshold, and Recommended owner: Incident Commander.`,
        "recommendation",
        `- recommendation: ${REALISTIC_BRIEF_FINAL_MARKER} - state the decision and why.`,
        "current dashboard action",
        "- action: state what the operator should do now based on queue depth and SLA breaches.",
        "residual risk",
        "- residual risk: state what remains source-bounded to the local fixtures, including pricing recurrence and external availability.",
        "Do not include source URLs in the final answer; cite source names and markers instead.",
        "Use plain section labels or plain Markdown headings only; do not wrap section labels in ** or __.",
        "Do not use tables, links, code fences, or bold/italic markup.",
        "Do not claim market adoption, real outages, or external pricing beyond the local fixture evidence.",
      ].join("\n"),
    };
  }
  if (scenario === "timeout-recovery") {
    return {
      scenario,
      title: "Mission route timeout recovery E2E",
      finalMarker: TIMEOUT_FINAL_MARKER,
      evidenceMarkers: [],
      answerTerms: ["timed out", "verification did not complete", "continue", "residual risk"],
      expectedSpawnCalls: 1,
      expectedSendCalls: 0,
      expectedToolResults: 1,
      expectedSpawnedSessions: 1,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 1,
      expectedBullets: 3,
      evidenceLinePatterns: [
        {
          label: "timeout boundary line",
          pattern: /^\s*[-*+]\s+timeout boundary\s*:.*TURNKEYAI_MISSION_TIMEOUT_OK.*timed out/im,
        },
        {
          label: "attempted verification line",
          pattern: /^\s*[-*+]\s+attempted verification\s*:.*verification did not complete/im,
        },
        {
          label: "residual risk line",
          pattern: /^\s*[-*+]\s+residual risk\s*:/im,
        },
      ],
      forbiddenPatterns: [
        {
          label: "timeout marker outside timeout boundary",
          pattern: /^\s*[-*+]\s+(?!timeout boundary\s*:).*TURNKEYAI_MISSION_TIMEOUT_OK/im,
        },
      ],
      minBytes: 120,
      desc: [
        "Run the mission route timeout recovery E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=explore exactly once.",
        "The sessions_spawn input must include timeout_seconds as the JSON number 0.001.",
        `The explore sub-agent task must fetch ${fixture.slowUrl} and report the page title plus marker ${FIXTURE_MARKER}.`,
        "The local fixture is intentionally too slow; do not call sessions_send, sessions_history, sessions_list, or any fallback session after the timeout result.",
        `Final answer must include ${TIMEOUT_FINAL_MARKER} exactly once, and only inside the first bullet. It must also include timed out, verification did not complete, continue, and the exact words residual risk.`,
        `Use plain Markdown with the exact heading "Timeout result" with no #, **, or __ markup, followed by exactly three bullets: timeout boundary, attempted verification, residual risk. The first bullet must start with "- timeout boundary: ${TIMEOUT_FINAL_MARKER} - timed out".`,
        `The attempted verification and residual risk bullets must not include ${TIMEOUT_FINAL_MARKER}.`,
        "The attempted verification bullet must include the exact phrase verification did not complete.",
        "Include continuation guidance in the residual risk bullet or immediately after the bounded closeout, without repeating the final success marker.",
        "In the attempted verification bullet, name the slow fixture but do not include the fixture URL.",
        "Do not add any paragraph, summary, or note after the three bullets.",
        "Do not claim the fixture marker was verified unless it appears in the tool result.",
        "Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    };
  }
  if (scenario === "budget-limited-closeout") {
    return {
      scenario,
      title: "Mission route budget-limited closeout E2E",
      finalMarker: BUDGET_CLOSEOUT_FINAL_MARKER,
      evidenceMarkers: [],
      answerTerms: ["tool-round limit", "tasks_list", "residual risk", "continue"],
      answerPatterns: [
        { label: "round-limit disclosure", pattern: /tool-round limit|round limit|budget/i },
        { label: "evidence-bounded answer", pattern: /already gathered|available evidence|task/i },
      ],
      evidenceLinePatterns: [
        {
          label: "budget boundary line",
          pattern:
            /^\s*[-*+]\s+budget boundary\s*:.*TURNKEYAI_MISSION_BUDGET_CLOSEOUT_OK.*(?:tool-round limit|round limit|budget)/im,
        },
        {
          label: "available evidence line",
          pattern: /^\s*[-*+]\s+available evidence\s*:.*tasks_list.*tool result/im,
        },
        { label: "residual risk line", pattern: /^\s*[-*+]\s+residual risk\s*:.*continue/im },
      ],
      forbiddenPatterns: [
        { label: "unsupported task creation", pattern: /Verify budget closeout second step.*(?:created|done|completed)/i },
        { label: "internal source URL", pattern: /https?:\/\//i },
      ],
      expectedSpawnCalls: 0,
      expectedSendCalls: 0,
      expectedToolResults: 1,
      expectedSpawnedSessions: 0,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 1,
      expectedBullets: 3,
      minBytes: 180,
      maxBytes: 900,
      expectedQualityGateStatus: "needs_attention",
      expectedCloseoutReason: "round_limit",
      expectedCloseoutEvidenceAvailable: "true",
      desc: [
        "Run the mission route budget-limited closeout E2E.",
        "Use native task tools instead of answering from memory.",
        "In the first assistant tool turn, call tasks_list exactly once with limit 10. Do not call multiple tools in the same assistant turn.",
        "After the tasks_list result returns, attempt one more tool call: tasks_create with title \"Verify budget closeout second step\" and status \"working\". Do not write the final answer before attempting this second tool call.",
        "The daemon intentionally runs this scenario with a one-round tool budget, so the second tool call should not execute. When the runtime tells you to stop using tools, synthesize only from already gathered evidence.",
        `Final answer must include ${BUDGET_CLOSEOUT_FINAL_MARKER} exactly once, and only inside the first bullet. It must also include tasks_list, tool result, tool-round limit, continue, and the exact words residual risk.`,
        `Use plain Markdown with the exact heading "Budget closeout" with no #, **, or __ markup, followed by exactly three bullets: budget boundary, available evidence, residual risk. The first bullet must start with "- budget boundary: ${BUDGET_CLOSEOUT_FINAL_MARKER} - tool-round limit".`,
        `The available evidence and residual risk bullets must not include ${BUDGET_CLOSEOUT_FINAL_MARKER}.`,
        "The available evidence bullet must mention that only the tasks_list tool result is verified.",
        "The residual risk bullet must include the literal word continue and state that the tasks_create second step was not verified.",
        "Do not claim the second task was created, done, or completed.",
        "Do not use sessions_spawn, sessions_send, browser tools, source URLs, raw session keys, tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    };
  }
  if (scenario === "sub-agent-timeout-closeout") {
    return {
      scenario,
      title: "Mission route sub-agent timeout closeout E2E",
      finalMarker: SUB_AGENT_TIMEOUT_CLOSEOUT_FINAL_MARKER,
      evidenceMarkers: [],
      answerTerms: ["timed out", "verification did not complete", "continue", "residual risk"],
      expectedSpawnCalls: 1,
      expectedSendCalls: 0,
      expectedToolResults: 1,
      expectedToolFailures: 1,
      expectedToolTimeouts: 1,
      expectedSpawnedSessions: 1,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 1,
      expectedBullets: 3,
      expectedQualityGateStatus: "blocked",
      expectedCloseoutReason: "sub_agent_timeout",
      expectedCloseoutEvidenceAvailable: "true",
      evidenceLinePatterns: [
        {
          label: "timeout boundary line",
          pattern: /^\s*[-*+]\s+timeout boundary\s*:.*TURNKEYAI_MISSION_SUB_AGENT_TIMEOUT_CLOSEOUT_OK.*timed out/im,
        },
        {
          label: "attempted verification line",
          pattern: /^\s*[-*+]\s+attempted verification\s*:.*verification did not complete/im,
        },
        {
          label: "residual risk line",
          pattern: /^\s*[-*+]\s+residual risk\s*:/im,
        },
      ],
      forbiddenPatterns: [
        {
          label: "timeout marker outside timeout boundary",
          pattern: /^\s*[-*+]\s+(?!timeout boundary\s*:).*TURNKEYAI_MISSION_SUB_AGENT_TIMEOUT_CLOSEOUT_OK/im,
        },
      ],
      minBytes: 140,
      maxBytes: 900,
      desc: [
        "Run the mission route sub-agent timeout closeout E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=explore exactly once.",
        "The sessions_spawn input must include timeout_seconds as the JSON number 0.001.",
        `The explore sub-agent task must fetch ${fixture.slowUrl} and report the page title plus marker ${FIXTURE_MARKER}.`,
        "The local fixture is intentionally too slow; do not call sessions_send, sessions_history, sessions_list, or any fallback session after the timeout result.",
        `Final answer must include ${SUB_AGENT_TIMEOUT_CLOSEOUT_FINAL_MARKER} exactly once, and only inside the first bullet. It must also include timed out, verification did not complete, continue, and the exact words residual risk.`,
        `Use plain Markdown with the exact heading "Timeout closeout" with no #, **, or __ markup, followed by exactly three bullets: timeout boundary, attempted verification, residual risk. The first bullet must start with "- timeout boundary: ${SUB_AGENT_TIMEOUT_CLOSEOUT_FINAL_MARKER} - timed out".`,
        `The attempted verification and residual risk bullets must not include ${SUB_AGENT_TIMEOUT_CLOSEOUT_FINAL_MARKER}.`,
        "The attempted verification bullet must include the exact phrase verification did not complete.",
        "Include continuation guidance in the residual risk bullet or immediately after the bounded closeout, without repeating the final success marker.",
        "In the attempted verification bullet, name the slow fixture but do not include the fixture URL.",
        "Do not add any paragraph, summary, or note after the three bullets.",
        "Do not claim the fixture marker was verified unless it appears in the tool result.",
        "Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    };
  }
  if (scenario === "browser-dynamic") {
    return {
      scenario,
      title: "Mission route dynamic browser extraction E2E",
      finalMarker: DYNAMIC_BROWSER_FINAL_MARKER,
      evidenceMarkers: [DYNAMIC_BROWSER_MARKER],
      answerTerms: ["browser", "Active users: 42", "Queue depth: 7", "residual risk"],
      answerPatterns: [
        { label: "rendered DOM source", pattern: /(?:JavaScript|client-rendered|rendered DOM|dynamic DOM)/i },
        { label: "browser-only evidence", pattern: /browser/i },
      ],
      evidenceLinePatterns: [
        {
          label: "dynamic DOM evidence line",
          pattern: /^\s*[-*+]\s+dynamic DOM evidence\s*:.*TURNKEYAI_MISSION_DYNAMIC_BROWSER_OK.*TURNKEYAI_DYNAMIC_BROWSER_OK.*(?:JavaScript|client-rendered|rendered DOM|dynamic DOM)/im,
        },
        {
          label: "dashboard facts line",
          pattern: /^\s*[-*+]\s+extracted dashboard facts\s*:.*Active users: 42.*Queue depth: 7/im,
        },
        { label: "residual risk evidence line", pattern: /^\s*[-*+]\s+residual risk\s*:/im },
      ],
      forbiddenPatterns: [
        { label: "non-local adoption claim", pattern: /\b(millions of users|market share|customers|widely adopted)\b/i },
        { label: "non-local pricing claim", pattern: /\bfree plan|enterprise pricing|starts at \$\d+\b/i },
        { label: "unresolved placeholder", pattern: /\b(TBD|to be confirmed|needs confirmation|待确认|估算)\b/i },
      ],
      minBytes: 260,
      maxBytes: 1_100,
      expectedSpawnCalls: 1,
      expectedSendCalls: 0,
      expectedToolResults: 1,
      expectedSpawnedSessions: 1,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 1,
      expectedBullets: 3,
      desc: [
        "Run the mission route dynamic browser extraction E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=browser exactly once.",
        `The browser sub-agent task must open ${fixture.dynamicUrl}, inspect the JavaScript-rendered DOM, and report marker ${DYNAMIC_BROWSER_MARKER}.`,
        "The task must also report the exact dynamic facts Active users: 42 and Queue depth: 7.",
        "Do not use an explore/fetch session for this task; the marker is intentionally rendered by browser JavaScript.",
        `Final answer must include ${DYNAMIC_BROWSER_FINAL_MARKER}, ${DYNAMIC_BROWSER_MARKER}, Active users: 42, Queue depth: 7, and the exact words residual risk.`,
        "Use this exact final answer shape after the browser worker result returns:",
        "## Browser evidence",
        `- dynamic DOM evidence: ${DYNAMIC_BROWSER_FINAL_MARKER}; ${DYNAMIC_BROWSER_MARKER} found in browser-rendered JavaScript or client-rendered DOM evidence.`,
        "- extracted dashboard facts: Active users: 42; Queue depth: 7.",
        "- residual risk: this validates the local dynamic fixture only, not a wider deployment.",
        "Do not create a separate bullet or paragraph for the final success marker.",
        "Keep the final answer under 140 words. Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    };
  }
  if (scenario === "browser-dashboard") {
    return {
      scenario,
      title: "Mission route browser dashboard triage E2E",
      finalMarker: DASHBOARD_TRIAGE_FINAL_MARKER,
      evidenceMarkers: [DASHBOARD_TRIAGE_MARKER],
      answerTerms: [
        "browser",
        "Queue depth: 11",
        "SLA breaches: 3",
        "page on-call",
        "Incident Commander",
        "residual risk",
      ],
      answerPatterns: [
        { label: "rendered dashboard source", pattern: /(?:JavaScript|client-rendered|rendered DOM|dynamic dashboard)/i },
        { label: "policy-backed action", pattern: /queue depth above 5|SLA breach(?:es)? above 0|threshold/i },
      ],
      evidenceLinePatterns: [
        {
          label: "rendered source evidence line",
          pattern: /^\s*[-*+]\s+rendered source evidence\s*:.*TURNKEYAI_MISSION_DASHBOARD_TRIAGE_OK.*TURNKEYAI_DASHBOARD_TRIAGE_OK.*(?:JavaScript|client-rendered|rendered DOM|dynamic dashboard)/im,
        },
        {
          label: "current state evidence line",
          pattern: /^\s*[-*+]\s+current state\s*:.*Queue depth: 11.*SLA breaches: 3/im,
        },
        {
          label: "recommended action line",
          pattern: /^\s*[-*+]\s+recommended action\s*:.*page on-call.*Incident Commander/im,
        },
        { label: "residual risk evidence line", pattern: /^\s*[-*+]\s+residual risk\s*:/im },
      ],
      forbiddenPatterns: [
        { label: "unsupported external incident claim", pattern: /\b(real outage|production outage|customer impact confirmed)\b/i },
        { label: "unresolved placeholder", pattern: /\b(TBD|to be confirmed|needs confirmation|待确认|估算)\b/i },
      ],
      minBytes: 320,
      maxBytes: 1_300,
      expectedSpawnCalls: 1,
      expectedSendCalls: 0,
      expectedToolResults: 1,
      expectedSpawnedSessions: 1,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 1,
      expectedBullets: 4,
      desc: [
        "Run the mission route browser dashboard triage E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=browser exactly once.",
        `The browser sub-agent task must open ${fixture.dashboardUrl}, inspect the JavaScript-rendered dashboard, and report marker ${DASHBOARD_TRIAGE_MARKER}.`,
        "The task must return the exact facts Queue depth: 11, SLA breaches: 3, Escalation threshold: queue depth above 5 or SLA breaches above 0, and Recommended owner: Incident Commander.",
        "Do not use an explore/fetch session for this task; the evidence is intentionally rendered by browser JavaScript.",
        `Final answer must include ${DASHBOARD_TRIAGE_FINAL_MARKER}, ${DASHBOARD_TRIAGE_MARKER}, Queue depth: 11, SLA breaches: 3, page on-call, Incident Commander, and the exact words residual risk.`,
        "Use this exact final answer shape after the browser worker result returns:",
        "## Dashboard triage",
        `- rendered source evidence: ${DASHBOARD_TRIAGE_FINAL_MARKER}; ${DASHBOARD_TRIAGE_MARKER} found in browser-rendered JavaScript or client-rendered dynamic dashboard evidence.`,
        "- current state: Queue depth: 11; SLA breaches: 3; threshold says queue depth above 5 or SLA breaches above 0 pages the on-call.",
        "- recommended action: page on-call and assign Incident Commander as owner.",
        "- residual risk: this validates the local dashboard fixture only, not a real production incident.",
        "Do not create a separate bullet or paragraph for the final success marker.",
        "Do not claim a real production outage or confirmed customer impact. This is a local fixture.",
        "Keep the final answer under 160 words. Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    };
  }
  if (scenario === "approval") {
    return {
      scenario,
      title: "Mission route approval-gated browser E2E",
      finalMarker: APPROVAL_FINAL_MARKER,
      evidenceMarkers: [APPROVAL_MARKER],
      answerTerms: ["permission.query", "permission.result", "permission.applied", "browser.form.submit", "residual risk"],
      evidenceLinePatterns: [
        { label: "approval request evidence", pattern: /^\s*(?:[-*+]\s+)?approval request\s*:/im },
        { label: "approval decision/application evidence", pattern: /^\s*(?:[-*+]\s+)?approval decision\/application\s*:/im },
        { label: "browser fixture evidence", pattern: /^\s*(?:[-*+]\s+)?browser fixture evidence\s*:/im },
        { label: "residual risk evidence", pattern: /^\s*(?:[-*+]\s+)?residual risk\s*:/im },
      ],
      allowLabeledEvidenceWithoutBullets: true,
      expectedSpawnCalls: 1,
      expectedSendCalls: 0,
      expectedToolResults: 1,
      expectedSpawnedSessions: 1,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 1,
      expectedBullets: 4,
      desc: [
        "Run the mission route approval-gated browser E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=browser exactly once.",
        "Do not call permission_query, permission_result, or permission_applied directly; the runtime gate must emit those while handling sessions_spawn.",
        "The browser task must include the exact action phrase browser.form.submit and the word submit so the runtime approval gate is exercised before browser work starts.",
        `After the runtime approval gate is cleared, the browser task must open ${fixture.approvalUrl}, verify marker ${APPROVAL_MARKER}, and report that this fixture performs no external mutation.`,
        "Do not ask the browser sub-agent to click a real submit control; this is an approval-gate fixture, not a real external mutation.",
        "Use this exact final answer shape after the browser worker result returns:",
        "## Evidence",
        `- Approval request: ${APPROVAL_FINAL_MARKER}; permission.query blocked browser.form.submit before browser work started.`,
        "- Approval decision/application: permission.result approved the request and permission.applied cached it for the runtime gate.",
        `- Browser fixture evidence: sessions_spawn(browser) verified ${APPROVAL_MARKER} on the local fixture and no external mutation was performed.`,
        "- Residual risk: this validates the approval gate and local fixture path, not a real external submit.",
        "Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    };
  }
  if (scenario === "cancel") {
    return {
      scenario,
      title: "Mission route real cancellation E2E",
      finalMarker: CANCEL_FINAL_MARKER,
      evidenceMarkers: [],
      answerTerms: ["cancelled", "sessions_spawn", "residual risk"],
      evidenceLinePatterns: [
        { label: "cancelled tool call evidence", pattern: /^\s*(?:[-*+]\s+)?cancelled tool call\s*:/im },
        { label: "control-path evidence", pattern: /^\s*(?:[-*+]\s+)?control-path evidence\s*:/im },
        { label: "residual risk evidence", pattern: /^\s*(?:[-*+]\s+)?residual risk\s*:/im },
      ],
      allowLabeledEvidenceWithoutBullets: true,
      expectedSpawnCalls: 1,
      expectedSendCalls: 0,
      expectedToolResults: 1,
      expectedSpawnedSessions: 1,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 1,
      expectedBullets: 3,
      desc: [
        "Run the mission route cancellation E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=explore exactly once.",
        `The explore sub-agent task must fetch ${fixture.slowUrl} and report the page title plus marker ${FIXTURE_MARKER}.`,
        "Wait for the sessions_spawn tool result before writing the final answer.",
        "If the tool result is cancelled by the operator, stop using tools and write the final answer from the cancellation evidence.",
        "Use this exact final answer shape after cancellation:",
        "## Evidence",
        `- cancelled tool call: ${CANCEL_FINAL_MARKER}; sessions_spawn was cancelled by the operator.`,
        "- control-path evidence: the cancellation came from the tool result and no extra session tools were used.",
        "- residual risk: the slow page may not have returned evidence before cancellation.",
        "Do not use tables, links, code fences, or bold/italic markup.",
        "Do not call sessions_send, sessions_history, or sessions_list.",
      ].join("\n"),
    };
  }
  if (scenario === "followup") {
    return {
      scenario,
      title: "Mission route real follow-up E2E",
      finalMarker: FOLLOWUP_FINAL_MARKER,
      evidenceMarkers: [FIXTURE_MARKER],
      expectedSourceLabels: [FOLLOWUP_SOURCE_LABEL, FOLLOWUP_CONTINUATION_SOURCE_LABEL],
      answerTerms: ["sessions_send", "no duplicate session", "residual risk"],
      answerPatterns: [{ label: "same-session continuity", pattern: /same[- ]session|reused session|existing session/i }],
      forbiddenPatterns: [
        { label: "internal fixture URL", pattern: /https?:\/\//i },
        { label: "raw session key", pattern: /\bworker:(?:explore|browser|finance|general):[^\s`'",)]+|\bTASK-\d+[^`'",\s]*call_/i },
      ],
      expectedSpawnCalls: 1,
      expectedSendCalls: 1,
      expectedSendCallsMax: 2,
      expectedToolResults: 2,
      expectedToolResultsMax: 3,
      expectedSpawnedSessions: 1,
      expectedContinuedSessions: 1,
      expectedContinuedSessionsMax: 2,
      minEvidenceEvents: 2,
      expectedBullets: 3,
      desc: [
        "Run phase 1 of the mission route follow-up E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=explore exactly once.",
        `The sessions_spawn input must include label "${FOLLOWUP_SOURCE_LABEL}" so mission source coverage can be audited.`,
        `The explore sub-agent task must fetch ${fixture.basicUrl}, report the page title, marker ${FIXTURE_MARKER}, and return a reusable session summary.`,
        `Phase 1 final answer must include ${FOLLOWUP_PHASE_MARKER}, ${FIXTURE_MARKER}, same-session availability, and the exact words residual risk.`,
        "Use this exact phase 1 final answer shape after sessions_spawn returns:",
        "## Evidence",
        `- session tool call: ${FOLLOWUP_PHASE_MARKER}; sessions_spawn returned a reusable same-session handle.`,
        `- fixture marker: ${FIXTURE_MARKER} confirmed in source ${FOLLOWUP_SOURCE_LABEL}.`,
        "- residual risk: this validates local fixture continuity only, not an external source.",
        "Do not include source URLs or raw session keys; name the session tool and fixture marker instead.",
        "Do not use tables, links, code fences, or bold/italic markup.",
        "Do not call sessions_send during phase 1.",
      ].join("\n"),
    };
  }
  if (scenario === "comparison") {
    return {
      scenario,
      title: "Mission route real comparison E2E",
      finalMarker: COMPARISON_FINAL_MARKER,
      evidenceMarkers: [ALPHA_MARKER, BETA_MARKER],
      expectedSourceLabels: ["Vendor Alpha", "Vendor Beta"],
      answerTerms: [
        "Alpha",
        "Beta",
        "$19 per seat",
        "$29 per workspace",
        "browser automation",
        "approval workflow",
        "API integration catalog",
        "separate connector",
        "Source coverage",
        "residual risk",
      ],
      answerPatterns: [
        { label: "explicit source-bounded comparison", pattern: /local fixture|local endpoint|source-bounded|single endpoint/i },
        { label: "actionable comparison conclusion", pattern: /recommend|choose|prefer|better fit|suits|fits|prioritiz/i },
      ],
      evidenceLinePatterns: [
        {
          label: "Alpha evidence line",
          pattern: /^\s*[-*+]\s+Alpha evidence\s*:.*TURNKEYAI_VENDOR_ALPHA_OK.*\$19 per seat.*browser automation.*API integration catalog/im,
        },
        {
          label: "Beta evidence line",
          pattern: /^\s*[-*+]\s+Beta evidence\s*:.*TURNKEYAI_VENDOR_BETA_OK.*\$29 per workspace.*approval workflow.*separate connector/im,
        },
        {
          label: "comparison conclusion line",
          pattern: /^\s*[-*+]\s+comparison conclusion\s*:.*TURNKEYAI_MISSION_COMPARISON_OK.*(?:recommend|choose|prefer|better fit|suits|fits|prioritiz)/im,
        },
        { label: "residual risk evidence line", pattern: /^\s*[-*+]\s+residual risk\s*:/im },
      ],
      forbiddenPatterns: [
        { label: "unsupported adoption claim", pattern: /\b(millions of users|large community|market share|widely adopted|customers)\b/i },
        { label: "unsupported pricing claim", pattern: /\bfree plan|enterprise pricing|starts at \$\d+\b/i },
        { label: "unresolved placeholder", pattern: /\b(TBD|to be confirmed|needs confirmation|待确认|估算)\b/i },
      ],
      minBytes: 520,
      maxBytes: 1_400,
      expectedSpawnCalls: 2,
      expectedSendCalls: 0,
      expectedToolResults: 2,
      expectedSpawnedSessions: 2,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 2,
      expectedBullets: 4,
      desc: [
        "Run the mission route complex comparison E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=explore exactly twice: one child session for Vendor Alpha with label \"Vendor Alpha\" and one child session for Vendor Beta with label \"Vendor Beta\".",
        `Vendor Alpha task: fetch ${fixture.alphaUrl}; report title, marker ${ALPHA_MARKER}, pricing, strength, and risk.`,
        `Vendor Beta task: fetch ${fixture.betaUrl}; report title, marker ${BETA_MARKER}, pricing, strength, and risk.`,
        "Each sessions_spawn input must include the exact label for its source so mission source coverage can be audited.",
        "Do not finalize until both child session tool results have returned and both markers are present in tool evidence.",
        `Final answer must include ${COMPARISON_FINAL_MARKER}, ${ALPHA_MARKER}, and ${BETA_MARKER}.`,
        "Use this exact final answer shape after both child session tool results return:",
        "## Source coverage",
        `- Alpha evidence: ${ALPHA_MARKER}; $19 per seat; browser automation and traceable screenshots; risk is limited API integration catalog.`,
        `- Beta evidence: ${BETA_MARKER}; $29 per workspace; approval workflow and team handoff history; risk is separate connector for browser control.`,
        `- comparison conclusion: ${COMPARISON_FINAL_MARKER}; Alpha fits browser-centric lower-cost work, while Beta fits approval-heavy team handoff work.`,
        "- residual risk: source-bounded to two local fixture sources; pricing and feature depth are not verified elsewhere.",
        "Do not create separate bullets or paragraphs for markers.",
        "Keep the final answer under 160 words. Do not use tables, links, code fences, or bold/italic markup.",
        "Do not make unsupported claims beyond the two local fixture sources.",
      ].join("\n"),
    };
  }
  return {
    scenario,
    title: "Mission route real tool-use E2E",
    finalMarker: FINAL_MARKER,
    evidenceMarkers: [FIXTURE_MARKER],
    answerTerms: ["sessions_spawn", "residual risk"],
    forbiddenPatterns: [{ label: "internal fixture URL", pattern: /https?:\/\//i }],
    expectedSpawnCalls: 1,
    expectedSendCalls: 0,
    expectedToolResults: 1,
    expectedSpawnedSessions: 1,
    expectedContinuedSessions: 0,
    minEvidenceEvents: 1,
    expectedBullets: 3,
    desc: [
      "Run the mission route release-gate E2E.",
      "Use the available session tool instead of answering from memory.",
      "Call sessions_spawn with agent_id=explore exactly once.",
      `The explore sub-agent task must fetch ${fixture.basicUrl} and report the page title plus marker ${FIXTURE_MARKER}.`,
      `Final answer must include ${FINAL_MARKER} and ${FIXTURE_MARKER}.`,
      "Use this exact final answer shape after the session tool result returns:",
      "## Evidence",
      `- session tool call: ${FINAL_MARKER}; sessions_spawn(explore) returned fixture evidence.`,
      `- fixture marker: ${FIXTURE_MARKER} confirmed in the local fixture result.`,
      "- residual risk: this validates the local fixture path only, not an external source.",
      "Do not create a separate bullet or paragraph for the final success marker.",
      "Keep the final answer under 120 words. Do not use tables, links, code fences, or bold/italic markup.",
      "Do not include source URLs; name the session tool and fixture marker instead.",
      "Do not include the final success marker unless the session tool result contains the fixture marker.",
    ].join("\n"),
  };
}

function buildFollowupInitialSpec(fixture: FixtureServer): ScenarioSpec {
  return {
    scenario: "followup",
      title: "Mission route real follow-up E2E",
      finalMarker: FOLLOWUP_PHASE_MARKER,
    evidenceMarkers: [FIXTURE_MARKER],
    answerTerms: ["sessions_spawn", "same-session", "residual risk"],
    forbiddenPatterns: [
      { label: "internal fixture URL", pattern: /https?:\/\//i },
      { label: "raw session key", pattern: /\bworker:(?:explore|browser|finance|general):[^\s`'",)]+|\bTASK-\d+[^`'",\s]*call_/i },
    ],
    expectedSpawnCalls: 1,
    expectedSendCalls: 0,
    expectedToolResults: 1,
    expectedSpawnedSessions: 1,
    expectedContinuedSessions: 0,
    minEvidenceEvents: 1,
    expectedBullets: 3,
      desc: [
        "Run phase 1 of the mission route follow-up E2E.",
        "Use the available session tool instead of answering from memory.",
      "Call sessions_spawn with agent_id=explore exactly once.",
      `The sessions_spawn input must include label "${FOLLOWUP_SOURCE_LABEL}" so a later follow-up can audit source coverage.`,
      `The explore sub-agent task must fetch ${fixture.basicUrl}, report the page title, marker ${FIXTURE_MARKER}, and return a reusable session summary.`,
      `Phase 1 final answer must include ${FOLLOWUP_PHASE_MARKER}, ${FIXTURE_MARKER}, same-session availability, and the exact words residual risk.`,
      "Use this exact phase 1 final answer shape after sessions_spawn returns:",
      "## Evidence",
      `- session tool call: ${FOLLOWUP_PHASE_MARKER}; sessions_spawn returned a reusable same-session handle.`,
      `- fixture marker: ${FIXTURE_MARKER} confirmed in source ${FOLLOWUP_SOURCE_LABEL}.`,
      "- residual risk: this validates local fixture continuity only, not an external source.",
      "Do not include source URLs or raw session keys; name the session tool and fixture marker instead.",
      "Do not use tables, links, code fences, or bold/italic markup.",
      "Do not call sessions_send during phase 1.",
    ].join("\n"),
  };
}

async function waitForMissionCompletion(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  finalMarker: string;
  timeoutMs: number;
  failFastDoneWithoutMarker?: boolean;
}): Promise<{ mission: Mission; timeline: ActivityEvent[] }> {
  const startedAt = Date.now();
  let latestMission: Mission | null = null;
  let latestTimeline: ActivityEvent[] = [];
  while (Date.now() - startedAt < input.timeoutMs) {
    latestMission = await requestJson<Mission>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}`,
      token: input.token,
    });
    latestTimeline = await requestJson<ActivityEvent[]>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/timeline?limit=200`,
      token: input.token,
    });
    if (latestMission.status === "blocked") {
      throw new Error(`mission blocked before completion:\n${summarizeMissionState(latestMission, latestTimeline)}`);
    }
    if (latestMission.status === "done" && findFinalEvent(latestTimeline, input.finalMarker)) {
      return { mission: latestMission, timeline: latestTimeline };
    }
    if (input.failFastDoneWithoutMarker && latestMission.status === "done") {
      await sleep(1_000);
      latestMission = await requestJson<Mission>({
        method: "GET",
        url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}`,
        token: input.token,
      });
      latestTimeline = await requestJson<ActivityEvent[]>({
        method: "GET",
        url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/timeline?limit=200`,
        token: input.token,
      });
      if (latestMission.status === "done" && findFinalEvent(latestTimeline, input.finalMarker)) {
        return { mission: latestMission, timeline: latestTimeline };
      }
      if (latestMission.status === "done") {
        throw new Error(
          `mission completed without final marker ${input.finalMarker}:\n${summarizeMissionState(latestMission, latestTimeline)}`
        );
      }
    }
    await sleep(1_000);
  }
  throw new Error(
    `mission did not complete within ${input.timeoutMs}ms:\n${summarizeMissionState(latestMission, latestTimeline)}`
  );
}

function assertMissionToolUseTimeline(timeline: ActivityEvent[], spec: ScenarioSpec): void {
  assert.ok(timeline.length > 0, "mission timeline must not be empty");
  const planIndex = timeline.findIndex((event) => event.kind === "plan");
  const spawnCallIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "call");
  const sendCallIndexes = findToolPhaseIndexes(timeline, "sessions_send", "call");
  const callIndexes = [...spawnCallIndexes, ...sendCallIndexes].sort((a, b) => a - b);
  const progressIndexes = [
    ...findToolPhaseIndexes(timeline, "sessions_spawn", "progress"),
    ...findToolPhaseIndexes(timeline, "sessions_send", "progress"),
  ].sort((a, b) => a - b);
  const spawnResultIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "result");
  const sendResultIndexes = findToolPhaseIndexes(timeline, "sessions_send", "result");
  const resultIndexes = [...spawnResultIndexes, ...sendResultIndexes].sort((a, b) => a - b);
  const callIndex = callIndexes[0] ?? -1;
  const resultIndex = resultIndexes.at(-1) ?? -1;
  const finalIndex = timeline.findIndex((event) => event.kind === "thought" && event.text.includes(spec.finalMarker));
  assert.ok(planIndex >= 0, "mission timeline must include the user plan event");
  assert.ok(callIndex > planIndex, "session tool call must appear after the user plan");
  assertCountInRange(
    spawnCallIndexes.length,
    spec.expectedSpawnCalls,
    spec.expectedSpawnCallsMax,
    `${spec.scenario} sessions_spawn calls`
  );
  assertCountInRange(
    sendCallIndexes.length,
    spec.expectedSendCalls,
    spec.expectedSendCallsMax,
    `${spec.scenario} sessions_send calls`
  );
  assertCountInRange(callIndexes.length, spec.expectedToolResults, spec.expectedToolResultsMax, `${spec.scenario} session tool calls`);
  assertCountInRange(
    resultIndexes.length,
    spec.expectedToolResults,
    spec.expectedToolResultsMax,
    `${spec.scenario} session tool results`
  );
  for (const progressIndex of progressIndexes) {
    assert.ok(progressIndex > callIndex, "sessions_spawn progress must appear after the first tool call");
  }
  assert.ok(resultIndex > callIndex, "session tool result must appear after the tool call");
  assert.ok(finalIndex > resultIndex, "final answer must appear after the session tool result");
  const resultEvidence = resultIndexes
    .map((index) => timeline[index]!)
    .map((event) => String(event.runtime?.["resultContent"] ?? event.text))
    .join("\n");
  for (const marker of spec.evidenceMarkers) {
    assert.match(resultEvidence, new RegExp(marker), `sessions_spawn results must include fixture evidence ${marker}`);
  }
  assertMissionSourceLabels(timeline, spec);
  const danger = timeline.find((event) => event.emph === "danger" || event.kind === "recovery");
  assert.equal(danger, undefined, `mission E2E timeline contains recovery/danger event: ${danger?.text ?? ""}`);
}

function assertMissionSourceLabels(timeline: ActivityEvent[], spec: ScenarioSpec): void {
  if (!spec.expectedSourceLabels?.length) return;
  const expectedLabels = new Set(spec.expectedSourceLabels);
  const callLabels = [
    ...findToolPhaseIndexes(timeline, "sessions_spawn", "call"),
    ...findToolPhaseIndexes(timeline, "sessions_send", "call"),
  ]
    .map((index) => readToolCallLabel(timeline[index]))
    .filter((label): label is string => Boolean(label));
  const callLabelSet = new Set(callLabels);
  const resultLabels = [
    ...findToolPhaseIndexes(timeline, "sessions_spawn", "result"),
    ...findToolPhaseIndexes(timeline, "sessions_send", "result"),
  ]
    .map((index) => timeline[index]?.runtime?.["sourceLabel"])
    .filter((label): label is string => typeof label === "string" && label.trim().length > 0);
  const resultLabelSet = new Set(resultLabels);
  assertLabelSetEqual(spec.scenario, "session tool call", callLabelSet, expectedLabels);
  assertLabelSetEqual(spec.scenario, "session tool result", resultLabelSet, expectedLabels);
}

function assertLabelSetEqual(
  scenario: string,
  surface: string,
  actual: Set<string>,
  expected: Set<string>
): void {
  const missing = [...expected].filter((label) => !actual.has(label));
  const unexpected = [...actual].filter((label) => !expected.has(label));
  assert.deepEqual(missing, [], `${scenario} ${surface} missing source labels: ${missing.join(", ")}`);
  assert.deepEqual(unexpected, [], `${scenario} ${surface} has unexpected source labels: ${unexpected.join(", ")}`);
}

function assertCountInRange(value: number, min: number, max: number | undefined, label: string): void {
  if (max === undefined) {
    assert.equal(value, min, `${label} expected exactly ${min}`);
    return;
  }
  assert.ok(value >= min && value <= max, `${label} expected between ${min} and ${max}, got ${value}`);
}

function readToolCallLabel(event: ActivityEvent | undefined): string | null {
  const callInput = event?.runtime?.["callInput"];
  if (typeof callInput !== "string") return null;
  try {
    const parsed = JSON.parse(callInput) as { label?: unknown };
    return typeof parsed.label === "string" && parsed.label.trim() ? parsed.label.trim() : null;
  } catch {
    return null;
  }
}

function extractFirstSessionKey(timeline: ActivityEvent[]): string | null {
  for (const event of timeline) {
    if (event.runtime?.["toolName"] !== "sessions_spawn" || event.runtime?.["toolPhase"] !== "result") {
      continue;
    }
    const content = String(event.runtime?.["resultContent"] ?? event.text);
    const match = content.match(/"session_key"\s*:\s*"([^"]+)"/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function extractSessionKeyForSpawnAgent(timeline: ActivityEvent[], agentId: string): string | null {
  const matchingCallIds = new Set<string>();
  for (const event of timeline) {
    if (event.runtime?.["toolName"] !== "sessions_spawn" || event.runtime?.["toolPhase"] !== "call") {
      continue;
    }
    const toolCallId = readRuntimeString(event, "toolCallId");
    if (!toolCallId) {
      continue;
    }
    const callInput = event.runtime?.["callInput"];
    if (typeof callInput !== "string") {
      continue;
    }
    try {
      const parsed = JSON.parse(callInput) as { agent_id?: unknown };
      if (parsed.agent_id === agentId) {
        matchingCallIds.add(toolCallId);
      }
    } catch {
      continue;
    }
  }
  for (const event of timeline) {
    if (event.runtime?.["toolName"] !== "sessions_spawn" || event.runtime?.["toolPhase"] !== "result") {
      continue;
    }
    const toolCallId = readRuntimeString(event, "toolCallId");
    if (!toolCallId || !matchingCallIds.has(toolCallId)) {
      continue;
    }
    const content = String(event.runtime?.["resultContent"] ?? event.text);
    const match = content.match(/"session_key"\s*:\s*"([^"]+)"/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function extractBrowserSessionIdForSpawnAgent(timeline: ActivityEvent[], agentId: string): string | null {
  const matchingCallIds = new Set<string>();
  for (const event of timeline) {
    if (event.runtime?.["toolName"] !== "sessions_spawn" || event.runtime?.["toolPhase"] !== "call") {
      continue;
    }
    const toolCallId = readRuntimeString(event, "toolCallId");
    if (!toolCallId) {
      continue;
    }
    const callInput = event.runtime?.["callInput"];
    if (typeof callInput !== "string") {
      continue;
    }
    try {
      const parsed = JSON.parse(callInput) as { agent_id?: unknown };
      if (parsed.agent_id === agentId) {
        matchingCallIds.add(toolCallId);
      }
    } catch {
      continue;
    }
  }
  for (const event of timeline) {
    if (event.runtime?.["toolName"] !== "sessions_spawn" || event.runtime?.["toolPhase"] !== "result") {
      continue;
    }
    const toolCallId = readRuntimeString(event, "toolCallId");
    if (!toolCallId || !matchingCallIds.has(toolCallId)) {
      continue;
    }
    const browserSessionId = extractBrowserSessionIdFromSessionToolResult(
      String(event.runtime?.["resultContent"] ?? event.text),
      { preferPayloadSessionId: true }
    );
    if (browserSessionId) {
      return browserSessionId;
    }
  }
  return null;
}

export function extractBrowserSessionIdForSendAfter(timeline: ActivityEvent[], phaseOneFinal: ActivityEvent): string | null {
  const tail = sliceTimelineAfterEvent(timeline, phaseOneFinal);
  for (const event of tail) {
    if (event.runtime?.["toolName"] !== "sessions_send" || event.runtime?.["toolPhase"] !== "result") {
      continue;
    }
    const browserSessionId = extractBrowserSessionIdFromSessionToolResult(
      String(event.runtime?.["resultContent"] ?? event.text),
      { preferPayloadSessionId: true }
    );
    if (browserSessionId) {
      return browserSessionId;
    }
  }
  return null;
}

function extractBrowserSessionIdFromSessionToolResult(
  content: string,
  options: { preferPayloadSessionId?: boolean } = {}
): string | null {
  try {
    const parsed = JSON.parse(content) as { payload?: { sessionId?: unknown }; result?: unknown };
    const sessionId = parsed.payload?.sessionId;
    if (options.preferPayloadSessionId && typeof sessionId === "string" && sessionId.trim()) {
      return sessionId.trim();
    }
    const contentSessionId = extractBrowserSessionIdFromText(content);
    if (contentSessionId) return contentSessionId;
    const resultSessionId = extractBrowserSessionIdFromText(typeof parsed.result === "string" ? parsed.result : "");
    if (resultSessionId) {
      return resultSessionId;
    }
    if (typeof sessionId === "string" && sessionId.trim()) {
      return sessionId.trim();
    }
  } catch {
    // Fall through to text extraction. Tool-result traces may be truncated
    // before the payload object while still preserving the summary line.
  }
  return extractBrowserSessionIdFromText(content);
}

function extractBrowserSessionIdFromText(content: string): string | null {
  const canonicalBrowserMatches = [...content.matchAll(/\bbrowser-session-[A-Za-z0-9_.:-]+/gi)];
  const canonicalBrowserMatch = canonicalBrowserMatches.at(-1)?.[0];
  if (canonicalBrowserMatch?.trim()) {
    return canonicalBrowserMatch.trim().replace(/[.,;]+$/, "");
  }
  const jsonMatch = content.match(/"sessionId"\s*:\s*"([^"]+)"/);
  if (jsonMatch?.[1]?.trim()) {
    return jsonMatch[1].trim();
  }
  const markdownSessionMatch = content.match(/Session ID:\*\*?\s*`?([A-Za-z0-9_.:-]+)`?/i);
  if (markdownSessionMatch?.[1]?.trim()) {
    return markdownSessionMatch[1].trim().replace(/[.,;]+$/, "");
  }
  const summaryMatch = content.match(/Browser worker completed session\s+([A-Za-z0-9_.:-]+)/i);
  return summaryMatch?.[1]?.trim().replace(/[.,;]+$/, "") ?? null;
}

function readRuntimeString(event: ActivityEvent, key: string): string | null {
  const value = event.runtime?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function extractTimedOutSessionKey(timeline: ActivityEvent[]): string | null {
  for (const event of timeline) {
    if (event.runtime?.["toolName"] !== "sessions_spawn" || event.runtime?.["toolPhase"] !== "result") {
      continue;
    }
    const content = String(event.runtime?.["resultContent"] ?? event.text);
    if (!/\btimeout\b|\btimed out\b|WORKER_TIMEOUT/i.test(content)) continue;
    const match = content.match(/"session_key"\s*:\s*"([^"]+)"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function extractCancelledSessionKey(timeline: ActivityEvent[]): string | null {
  for (const event of timeline) {
    if (event.runtime?.["toolName"] !== "sessions_spawn" || event.runtime?.["toolPhase"] !== "result") {
      continue;
    }
    const content = String(event.runtime?.["resultContent"] ?? event.text);
    if (!/\bcancel(?:led|ed)?\b/i.test(content)) continue;
    const match = content.match(/"session_key"\s*:\s*"([^"]+)"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function assertFollowupReusedSession(timeline: ActivityEvent[], expectedSessionKey: string): void {
  const sendCalls = timeline.filter(
    (event) => event.runtime?.["toolName"] === "sessions_send" && event.runtime?.["toolPhase"] === "call"
  );
  assertCountInRange(sendCalls.length, 1, 2, "follow-up E2E sessions_send calls");
  const sendCallIds = sendCalls.map((event) => readRuntimeString(event, "toolCallId"));
  assert.ok(sendCallIds.every(Boolean), "sessions_send call must include toolCallId for call/result correlation");
  assert.equal(
    new Set(sendCallIds).size,
    sendCallIds.length,
    "sessions_send follow-up calls must have unique toolCallId values"
  );
  for (const [index, sendCall] of sendCalls.entries()) {
    const callInput = sendCall.runtime?.["callInput"];
    assert.equal(typeof callInput, "string", "sessions_send call must persist structured callInput");
    const parsed = JSON.parse(callInput as string) as { session_key?: string };
    assert.equal(
      isCompatibleSessionKeyReference(parsed.session_key, expectedSessionKey),
      true,
      "sessions_send must address the phase-one session_key or a unique prefix of it"
    );
    const toolCallId = sendCallIds[index] ?? "";
    const matchingResults = timeline.filter(
      (event) =>
        event.runtime?.["toolName"] === "sessions_send" &&
        event.runtime?.["toolPhase"] === "result" &&
        readRuntimeString(event, "toolCallId") === toolCallId
    );
    assert.equal(matchingResults.length, 1, "sessions_send must record exactly one result for each follow-up call");
    const result = matchingResults[0]!;
    assert.equal(
      readSessionKeyFromResultContent(result),
      expectedSessionKey,
      "sessions_send result must persist the resolved phase-one session_key"
    );
  }
}

function isCompatibleSessionKeyReference(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || !actual.trim()) return false;
  const actualSignature = relaxedSessionKeySignature(actual.trim());
  const expectedSignature = relaxedSessionKeySignature(expected);
  if (actualSignature === expectedSignature || (actualSignature.length >= 40 && expectedSignature.startsWith(actualSignature))) {
    return true;
  }
  const actualTaskPrefix = readWorkerTaskSessionPrefix(actualSignature);
  return Boolean(actualTaskPrefix && actualTaskPrefix === readWorkerTaskSessionPrefix(expectedSignature));
}

function relaxedSessionKeySignature(sessionKey: string): string {
  return sessionKey.replace(/call_function_/g, "call_").replace(/call_func_/g, "call_");
}

function readWorkerTaskSessionPrefix(sessionKey: string): string | null {
  const match = sessionKey.match(/^(worker:[A-Za-z0-9_-]+:task[:|-][A-Za-z0-9_-]+)(?::|$)/);
  return match?.[1] ?? null;
}

function readSessionKeyFromResultContent(event: ActivityEvent): string | null {
  const content = String(event.runtime?.["resultContent"] ?? event.text);
  const match = content.match(/"session_key"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

export function assertNaturalFollowupReusedExistingSession(input: {
  timeline: ActivityEvent[];
  phaseOneFinal: ActivityEvent;
  expectedSessionKey: string;
}): void {
  const tail = sliceTimelineAfterEvent(input.timeline, input.phaseOneFinal);
  const duplicateSpawnCalls = tail.filter(
    (event) => event.runtime?.["toolName"] === "sessions_spawn" && event.runtime?.["toolPhase"] === "call"
  );
  assert.equal(
    duplicateSpawnCalls.length,
    0,
    "natural follow-up must not spawn duplicate child sessions after the phase-one answer"
  );
  const sendCalls = tail.filter(
    (event) => event.runtime?.["toolName"] === "sessions_send" && event.runtime?.["toolPhase"] === "call"
  );
  assert.ok(sendCalls.length >= 1, "natural follow-up must continue an existing child session with sessions_send");
  const callInput = sendCalls[0]?.runtime?.["callInput"];
  assert.equal(typeof callInput, "string", "natural sessions_send call must persist structured callInput");
  const parsed = JSON.parse(callInput as string) as { session_key?: unknown };
  const sendCallIndex = input.timeline.indexOf(sendCalls[0]!);
  const sendResultIndex = input.timeline.findIndex(
    (event, index) =>
      index > sendCallIndex &&
      event.runtime?.["toolName"] === "sessions_send" &&
      event.runtime?.["toolPhase"] === "result"
  );
  assert.ok(sendResultIndex > sendCallIndex, "natural sessions_send must produce a result after the continuation call");
  assert.equal(
    isCompatibleSessionKeyReference(parsed.session_key, input.expectedSessionKey) ||
      isBrowserSessionReferenceResolvedByResult(parsed.session_key, input.timeline[sendResultIndex]!, input.expectedSessionKey),
    true,
    `natural sessions_send must reuse the phase-one session_key, a unique prefix of it, or a browser session id that resolves to it (actual=${String(parsed.session_key)} expected=${input.expectedSessionKey})`
  );
  const latestThoughtIndex = findLatestThoughtIndex(input.timeline);
  assert.ok(latestThoughtIndex > sendResultIndex, "natural follow-up final answer must follow the continuation result");
}

function isBrowserSessionReferenceResolvedByResult(actual: unknown, result: ActivityEvent, expectedSessionKey: string): boolean {
  if (typeof actual !== "string" || !/^browser-session-[A-Za-z0-9_-]+$/.test(actual.trim())) return false;
  const resolvedSessionKey = readSessionKeyFromResultContent(result);
  return Boolean(resolvedSessionKey && isCompatibleSessionKeyReference(resolvedSessionKey, expectedSessionKey));
}

function assertNaturalColdRecreationFollowup(input: {
  timeline: ActivityEvent[];
  phaseOneFinal: ActivityEvent;
  expectedSessionKey: string;
}): void {
  const tail = sliceTimelineAfterEvent(input.timeline, input.phaseOneFinal);
  const duplicateSpawnCalls = tail.filter(
    (event) => event.runtime?.["toolName"] === "sessions_spawn" && event.runtime?.["toolPhase"] === "call"
  );
  assert.equal(
    duplicateSpawnCalls.length,
    0,
    "natural cold recreation follow-up must continue through the existing browser worker rather than parent-spawning a duplicate"
  );
  const sendCalls = tail.filter(
    (event) => event.runtime?.["toolName"] === "sessions_send" && event.runtime?.["toolPhase"] === "call"
  );
  assert.ok(sendCalls.length >= 1, "natural cold recreation follow-up must use sessions_send");
  const sendInputs = sendCalls.map((event) => {
    const callInput = event.runtime?.["callInput"];
    assert.equal(typeof callInput, "string", "natural cold recreation sessions_send call must persist structured callInput");
    return JSON.parse(callInput as string) as { session_key?: unknown };
  });
  if (sendInputs.some((parsed) => isCompatibleSessionKeyReference(parsed.session_key, input.expectedSessionKey))) {
    return;
  }
  const sendResultEvidence = tail
    .filter((event) => event.runtime?.["toolName"] === "sessions_send" && event.runtime?.["toolPhase"] === "result")
    .map((event) => [event.text, String(event.runtime?.["resultContent"] ?? "")].join("\n"))
    .join("\n");
  assert.match(
    sendResultEvidence,
    /session_not_found|session not found|session was unavailable|previous session was unavailable|unavailable session/i,
    `natural cold recreation may use a replacement session only when the original session loss is visible (actual send keys=${sendInputs
      .map((parsed) => String(parsed.session_key))
      .join(", ")} expected=${input.expectedSessionKey})`
  );
}

function assertNaturalFollowupResultIncludes(input: {
  timeline: ActivityEvent[];
  phaseOneFinal: ActivityEvent;
  patterns: Array<{ label: string; pattern: RegExp }>;
}): void {
  const tail = sliceTimelineAfterEvent(input.timeline, input.phaseOneFinal);
  const sendResultText = tail
    .filter((event) => event.runtime?.["toolName"] === "sessions_send" && event.runtime?.["toolPhase"] === "result")
    .map((event) => [event.text, String(event.runtime?.["resultContent"] ?? "")].join("\n"))
    .join("\n");
  assert.ok(sendResultText.trim().length > 0, "natural follow-up must record sessions_send result evidence");
  for (const item of input.patterns) {
    assert.match(
      sendResultText,
      item.pattern,
      `natural follow-up result missing ${item.label}\n--- sessions_send result evidence ---\n${sendResultText.slice(0, 4000)}`
    );
  }
}

function sliceTimelineAfterEvent(timeline: ActivityEvent[], event: ActivityEvent): ActivityEvent[] {
  const index = timeline.findIndex((candidate) => {
    if (event.id && candidate.id === event.id) return true;
    return candidate.kind === event.kind && candidate.tMs === event.tMs && candidate.text === event.text;
  });
  if (index >= 0) return timeline.slice(index + 1);
  return timeline.filter((candidate) => candidate.tMs > event.tMs);
}

function findLatestThoughtIndex(timeline: ActivityEvent[]): number {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "thought" && timeline[index]?.text.trim().length) return index;
  }
  return -1;
}

function assertMissionMemoryRecallTimeline(timeline: ActivityEvent[], spec: ScenarioSpec): void {
  assert.ok(timeline.length > 0, "memory recall timeline must not be empty");
  const finalIndex = timeline.findIndex((event) => event.kind === "thought" && event.text.includes(spec.finalMarker));
  const searchCallIndexes = findToolPhaseIndexes(timeline, "memory_search", "call");
  const searchResultIndexes = findToolPhaseIndexes(timeline, "memory_search", "result");
  const getCallIndexes = findToolPhaseIndexes(timeline, "memory_get", "call");
  const getResultIndexes = findToolPhaseIndexes(timeline, "memory_get", "result");
  assert.ok(searchCallIndexes.length >= 1, "memory recall E2E must call memory_search");
  assert.ok(searchCallIndexes.length <= 2, "memory recall E2E must not exceed two memory_search calls");
  assert.equal(searchResultIndexes.length, searchCallIndexes.length, "memory recall E2E must receive one memory_search result per call");
  assert.equal(getCallIndexes.length, 1, "memory recall E2E must call memory_get exactly once");
  assert.equal(getResultIndexes.length, 1, "memory recall E2E must receive one memory_get result");
  assert.equal(findToolPhaseIndexes(timeline, "sessions_spawn", "call").length, 0, "memory recall must not spawn sessions");
  assert.equal(findToolPhaseIndexes(timeline, "sessions_send", "call").length, 0, "memory recall must not continue sessions");
  assert.ok(searchResultIndexes[0]! > searchCallIndexes[0]!, "memory_search result must follow the call");
  assert.ok(getCallIndexes[0]! > searchResultIndexes.at(-1)!, "memory_get call must follow memory_search result");
  assert.ok(getResultIndexes[0]! > getCallIndexes[0]!, "memory_get result must follow the call");
  assert.ok(finalIndex > getResultIndexes[0]!, "final answer must follow memory_get result");
  const memoryGetResult = String(timeline[getResultIndexes[0]!]!.runtime?.["resultContent"] ?? timeline[getResultIndexes[0]!]!.text);
  assert.match(memoryGetResult, new RegExp(MEMORY_SOURCE_MARKER), "memory_get result must include the seeded memory source marker");
  assert.match(memoryGetResult, /Helios-47/, "memory_get result must include the seeded project codename");
}

function assertMissionTaskTrackingTimeline(timeline: ActivityEvent[], spec: ScenarioSpec): void {
  assert.ok(timeline.length > 0, "task tracking timeline must not be empty");
  const finalIndex = timeline.findIndex((event) => event.kind === "thought" && event.text.includes(spec.finalMarker));
  const listCallIndexes = findToolPhaseIndexes(timeline, "tasks_list", "call");
  const listResultIndexes = findToolPhaseIndexes(timeline, "tasks_list", "result");
  const createCallIndexes = findToolPhaseIndexes(timeline, "tasks_create", "call");
  const createResultIndexes = findToolPhaseIndexes(timeline, "tasks_create", "result");
  const updateCallIndexes = findToolPhaseIndexes(timeline, "tasks_update", "call");
  const updateResultIndexes = findToolPhaseIndexes(timeline, "tasks_update", "result");
  assert.equal(listCallIndexes.length, 1, "task tracking E2E must call tasks_list exactly once");
  assert.equal(listResultIndexes.length, 1, "task tracking E2E must receive one tasks_list result");
  assert.ok(createCallIndexes.length >= 1, "task tracking E2E must call tasks_create");
  assert.ok(createCallIndexes.length <= 2, "task tracking E2E must not exceed two tasks_create calls");
  assert.equal(createResultIndexes.length, createCallIndexes.length, "task tracking E2E must receive one tasks_create result per call");
  assert.equal(updateCallIndexes.length, 1, "task tracking E2E must call tasks_update exactly once");
  assert.equal(updateResultIndexes.length, 1, "task tracking E2E must receive one tasks_update result");
  assert.equal(findToolPhaseIndexes(timeline, "sessions_spawn", "call").length, 0, "task tracking must not spawn sessions");
  assert.equal(findToolPhaseIndexes(timeline, "sessions_send", "call").length, 0, "task tracking must not continue sessions");
  assert.ok(listResultIndexes[0]! > listCallIndexes[0]!, "tasks_list result must follow the call");
  assert.ok(createCallIndexes[0]! > listResultIndexes[0]!, "tasks_create call must follow tasks_list result");
  assert.ok(createResultIndexes[0]! > createCallIndexes[0]!, "tasks_create result must follow the call");
  assert.ok(updateCallIndexes[0]! > createResultIndexes.at(-1)!, "tasks_update call must follow tasks_create result");
  assert.ok(updateResultIndexes[0]! > updateCallIndexes[0]!, "tasks_update result must follow the call");
  assert.ok(finalIndex > updateResultIndexes[0]!, "final answer must follow tasks_update result");

  const createResults = createResultIndexes.map((index) =>
    String(timeline[index]!.runtime?.["resultContent"] ?? timeline[index]!.text)
  );
  const updateCallInput = String(timeline[updateCallIndexes[0]!]!.runtime?.["callInput"] ?? "");
  const updateResult = String(timeline[updateResultIndexes[0]!]!.runtime?.["resultContent"] ?? timeline[updateResultIndexes[0]!]!.text);
  const createBodies = createResults.map((result) => JSON.parse(result) as { task?: { id?: string; title?: string }; deduped?: boolean });
  const updateInput = JSON.parse(updateCallInput) as { work_item_id?: string; status?: string; progress?: number };
  const createdIds = new Set(createBodies.map((body) => body.task?.id).filter((id): id is string => Boolean(id)));
  assert.equal(createdIds.size, 1, "duplicate tasks_create calls must resolve to one persisted task id");
  assert.ok(createBodies.every((body) => body.task?.title === "Verify Helios-47 rollout note"), "tasks_create results must expose the tracked item title");
  if (createBodies.length > 1) {
    assert.ok(createBodies.slice(1).every((body) => body.deduped === true), "duplicate tasks_create results must be marked deduped");
  }
  const [createdId] = [...createdIds];
  assert.equal(updateInput.work_item_id, createdId, "tasks_update must use the id returned by tasks_create");
  assert.equal(updateInput.status, "done", "tasks_update call must set status done");
  assert.equal(updateInput.progress, 1, "tasks_update call must set progress 1");
  assert.match(updateResult, /Verify Helios-47 rollout note/, "tasks_update result must include the tracked item title");
  assert.match(updateResult, /"status": "done"/, "tasks_update result must include done status");
}

async function waitForToolCallEvent(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  toolName: "sessions_spawn" | "sessions_send";
  timeoutMs: number;
}): Promise<{ messageId: string; toolCallId: string; timeline: ActivityEvent[] }> {
  const startedAt = Date.now();
  let latestTimeline: ActivityEvent[] = [];
  while (Date.now() - startedAt < input.timeoutMs) {
    latestTimeline = await requestJson<ActivityEvent[]>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/timeline?limit=200`,
      token: input.token,
    });
    const event = latestTimeline.find(
      (item) => item.runtime?.["toolName"] === input.toolName && item.runtime?.["toolPhase"] === "call"
    );
    const messageId = event?.runtime?.["messageId"];
    const toolCallId = event?.runtime?.["toolCallId"];
    if (typeof messageId === "string" && messageId.length > 0 && typeof toolCallId === "string" && toolCallId.length > 0) {
      return { messageId, toolCallId, timeline: latestTimeline };
    }
    await sleep(500);
  }
  throw new Error(`mission did not emit ${input.toolName} call before cancellation:\n${summarizeMissionState(null, latestTimeline)}`);
}

async function waitForToolCallEventOrNull(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  toolName: "sessions_spawn" | "sessions_send";
  timeoutMs: number;
}): Promise<{ messageId: string; toolCallId: string; timeline: ActivityEvent[] } | null> {
  try {
    return await waitForToolCallEvent(input);
  } catch (error) {
    if (error instanceof Error && /did not emit .* call before cancellation/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

async function waitForRunningWorkerSessionForToolCall(input: {
  baseUrl: string;
  token: string;
  threadId: string;
  toolCallId: string;
  timeoutMs: number;
}): Promise<WorkerSessionRecord> {
  const startedAt = Date.now();
  let latestSessions: WorkerSessionRecord[] = [];
  while (Date.now() - startedAt < input.timeoutMs) {
    latestSessions = await requestJson<WorkerSessionRecord[]>({
      method: "GET",
      url: `${input.baseUrl}/runtime-worker-sessions?threadId=${encodeURIComponent(input.threadId)}&limit=50`,
      token: input.token,
    });
    const session = latestSessions.find((item) => item.context?.toolCallId === input.toolCallId);
    if (session?.state.status === "running") {
      return session;
    }
    if (session && ["done", "failed", "cancelled"].includes(session.state.status)) {
      throw new Error(
        `worker session for tool call ${input.toolCallId} reached ${session.state.status} before cancellation: ${JSON.stringify(
          {
            workerRunKey: session.workerRunKey,
            status: session.state.status,
            workerType: session.state.workerType,
            lastResultStatus: session.state.lastResult?.status,
            lastResultSummary: session.state.lastResult?.summary,
            lastError: session.state.lastError,
          },
          null,
          2
        )}`
      );
    }
    await sleep(500);
  }
  throw new Error(
    `worker session for tool call ${input.toolCallId} did not enter running before cancellation: ${JSON.stringify(
      latestSessions.map((session) => ({
        workerRunKey: session.workerRunKey,
        toolCallId: session.context?.toolCallId,
        status: session.state.status,
        workerType: session.state.workerType,
      })),
      null,
      2
    )}`
  );
}

async function waitForCancelResumeFixtureRequest(input: {
  fixture: FixtureServer;
  timeoutMs: number;
}): Promise<void> {
  const startedAt = Date.now();
  let latestCount = 0;
  while (Date.now() - startedAt < input.timeoutMs) {
    const remainingMs = input.timeoutMs - (Date.now() - startedAt);
    const perPollTimeoutMs = Math.max(1, Math.min(remainingMs, 1000));
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(input.fixture.cancelResumeStateUrl, {
        signal: AbortSignal.timeout(perPollTimeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        await sleep(250);
        continue;
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(`cancel-resume fixture state returned HTTP ${response.status}`);
    }
    const state = (await response.json()) as { cancelResumeRequestCount?: unknown };
    latestCount =
      typeof state.cancelResumeRequestCount === "number" && Number.isFinite(state.cancelResumeRequestCount)
        ? state.cancelResumeRequestCount
        : 0;
    if (latestCount > 0) {
      return;
    }
    await sleep(250);
  }
  throw new Error(
    `cancel-resume fixture did not observe the first source request before cancellation; latest request count ${latestCount}`
  );
}

async function waitForApprovalRequest(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  action: string;
  timeoutMs: number;
}): Promise<ApprovalRecord> {
  const startedAt = Date.now();
  let latestApprovals: ApprovalRecord[] = [];
  let latestMission: Mission | null = null;
  while (Date.now() - startedAt < input.timeoutMs) {
    latestApprovals = await requestJson<ApprovalRecord[]>({
      method: "GET",
      url: `${input.baseUrl}/approvals`,
      token: input.token,
    });
    const approval = latestApprovals.find(
      (item) => item.missionId === input.missionId && item.action === input.action && item.decision == null
    );
    latestMission = await requestJson<Mission>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}`,
      token: input.token,
    });
    if (approval) {
      assert.equal(latestMission.status, "needs_approval", "mission must expose needs_approval while approval is pending");
      return approval;
    }
    if (latestMission.status === "blocked" || latestMission.status === "done") {
      const timeline = await requestJson<ActivityEvent[]>({
        method: "GET",
        url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/timeline?limit=200`,
        token: input.token,
      });
      throw new Error(
        `mission reached ${latestMission.status} before approval ${input.action} was requested:\n${summarizeMissionState(latestMission, timeline)}`
      );
    }
    await sleep(500);
  }
  throw new Error(
    `mission did not request approval ${input.action} within ${input.timeoutMs}ms: ${JSON.stringify({
      mission: latestMission,
      approvals: latestApprovals,
    })}`
  );
}

async function driveNaturalApprovalDecisionsUntilComplete(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  timeoutMs: number;
  decision: "approved" | "denied";
}): Promise<{ mission: Mission; timeline: ActivityEvent[] }> {
  const startedAt = Date.now();
  const decidedIds = new Set<string>();
  let latestApprovals: ApprovalRecord[] = [];
  let latestMission: Mission | null = null;
  let latestTimeline: ActivityEvent[] = [];
  let afterDecisionThoughtMs: number | undefined;
  let afterDecisionThoughtId: string | undefined;
  while (Date.now() - startedAt < input.timeoutMs) {
    latestApprovals = await requestJson<ApprovalRecord[]>({
      method: "GET",
      url: `${input.baseUrl}/approvals`,
      token: input.token,
    });
    const pending = latestApprovals
      .filter((item) => item.missionId === input.missionId && item.decision == null && !decidedIds.has(item.id))
      .sort((a, b) => (a.requestedAtMs ?? 0) - (b.requestedAtMs ?? 0));
    latestMission = await requestJson<Mission>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}`,
      token: input.token,
    });
    latestTimeline = await requestJson<ActivityEvent[]>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/timeline?limit=300`,
      token: input.token,
    });
    if (pending.length > 0) {
      assert.equal(latestMission.status, "needs_approval", "mission must expose needs_approval while approval is pending");
      const approval = pending[0]!;
      const latestThought = findLatestThoughtEvent(latestTimeline);
      afterDecisionThoughtMs = latestThought?.tMs;
      afterDecisionThoughtId = latestThought?.id;
      await requestJson<unknown>({
        method: "POST",
        url: `${input.baseUrl}/approvals/${encodeURIComponent(approval.id)}/decision`,
        token: input.token,
        body: {
          decision: input.decision,
          decidedBy: "natural-mission-e2e",
          reason:
            input.decision === "approved"
              ? `approving isolated local dry-run action ${approval.action} for natural acceptance`
              : `denying isolated local dry-run action ${approval.action} for natural acceptance`,
        },
      });
      decidedIds.add(approval.id);
      await sleep(500);
      continue;
    }
    const latestThoughtIndex = findLatestThoughtIndex(latestTimeline);
    const latestThought = latestThoughtIndex >= 0 ? latestTimeline[latestThoughtIndex] : null;
    const decisionIndex =
      input.decision === "approved"
        ? findLatestApprovalAppliedIndex(latestTimeline, decidedIds)
        : findLatestApprovalResultIndex(latestTimeline, decidedIds);
    const hasPostDecisionThought =
      latestThought &&
      decisionIndex >= 0 &&
      latestThoughtIndex > decisionIndex &&
      !isStalePendingApprovalThought(latestThought.text) &&
      (afterDecisionThoughtMs === undefined ||
        latestThought.tMs > afterDecisionThoughtMs ||
        (afterDecisionThoughtId !== undefined && latestThought.id !== afterDecisionThoughtId));
    if (latestMission.status === "done" && hasPostDecisionThought) {
      assert.ok(
        decidedIds.size > 0,
        `natural approval mission must request at least one approval:\n${summarizeMissionState(latestMission, latestTimeline)}`
      );
      return { mission: latestMission, timeline: latestTimeline };
    }
    if (latestMission.status === "blocked") {
      throw new Error(`mission blocked while driving natural approval: ${summarizeMissionState(latestMission, latestTimeline)}`);
    }
    await sleep(500);
  }
  throw new Error(
    `mission did not complete after natural approval decisions within ${input.timeoutMs}ms: ${JSON.stringify({
      decidedIds: [...decidedIds],
      decision: input.decision,
      mission: latestMission,
      approvals: latestApprovals,
    })}`
  );
}

async function waitForNaturalApprovalPendingState(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  timeoutMs: number;
}): Promise<{ mission: Mission; timeline: ActivityEvent[]; metrics: MissionObservabilitySnapshot }> {
  const startedAt = Date.now();
  let latestMission: Mission | null = null;
  let latestTimeline: ActivityEvent[] = [];
  let latestMetrics: MissionObservabilitySnapshot | null = null;
  let latestApprovals: ApprovalRecord[] = [];
  while (Date.now() - startedAt < input.timeoutMs) {
    latestMission = await requestJson<Mission>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}`,
      token: input.token,
    });
    latestTimeline = await requestJson<ActivityEvent[]>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/timeline?limit=300`,
      token: input.token,
    });
    latestMetrics = await requestJson<MissionObservabilitySnapshot>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/metrics`,
      token: input.token,
    });
    latestApprovals = await requestJson<ApprovalRecord[]>({
      method: "GET",
      url: `${input.baseUrl}/approvals`,
      token: input.token,
    });
    const pending = latestApprovals.filter((item) => item.missionId === input.missionId && item.decision == null);
    const hasPendingQuery =
      pending.length > 0 &&
      latestMission.status === "needs_approval" &&
      latestMetrics.status === "needs_approval" &&
      latestMetrics.approvals.requested > 0 &&
      latestMetrics.approvals.decided === 0 &&
      latestMetrics.approvals.applied === 0 &&
      hasRuntimeEvent(latestTimeline, "permission.query") &&
      !hasRuntimeEvent(latestTimeline, "permission.result") &&
      !hasRuntimeEvent(latestTimeline, "permission.applied");
    if (hasPendingQuery) {
      return { mission: latestMission, timeline: latestTimeline, metrics: latestMetrics };
    }
    if (latestMission.status === "blocked" || latestMission.status === "done") {
      throw new Error(
        `mission reached ${latestMission.status} before staying pending approval:\n${summarizeMissionState(
          latestMission,
          latestTimeline
        )}`
      );
    }
    await sleep(500);
  }
  throw new Error(
    `mission did not expose pending approval state within ${input.timeoutMs}ms: ${JSON.stringify({
      mission: latestMission,
      metrics: latestMetrics,
      approvals: latestApprovals,
    })}`
  );
}

function findLatestApprovalResultIndex(timeline: ActivityEvent[], decidedIds: Set<string>): number {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index]!;
    if (event.runtime?.["eventType"] !== "permission.result") {
      continue;
    }
    const approvalId = event.approvalId ?? String(event.runtime?.["approvalId"] ?? "");
    if (decidedIds.size === 0 || (approvalId && decidedIds.has(approvalId))) {
      return index;
    }
  }
  return -1;
}

function findLatestApprovalQueryEvent(timeline: ActivityEvent[]): ActivityEvent | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index]!;
    if (event.runtime?.["eventType"] === "permission.query") {
      return event;
    }
  }
  return null;
}

function findLatestApprovalAppliedIndex(timeline: ActivityEvent[], approvedIds: Set<string>): number {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index]!;
    if (event.runtime?.["eventType"] !== "permission.applied") {
      continue;
    }
    const approvalId = event.approvalId ?? String(event.runtime?.["approvalId"] ?? "");
    if (approvedIds.size === 0 || (approvalId && approvedIds.has(approvalId))) {
      return index;
    }
  }
  return -1;
}

export function isStalePendingApprovalThought(text: string): boolean {
  return /\b(?:approval pending|approval is pending|approval request is pending|approval request submitted|permission request is pending|pending operator decision|pending\W+operator\s+decision|awaiting (?:your decision|operator approval|operator decision|operator)|waiting for (?:your|operator) decision|waiting for operator|once (?:you )?approve|still pending)\b/i.test(
    text
  );
}

function assertMissionCancelTimeline(timeline: ActivityEvent[], spec: ScenarioSpec): void {
  assert.ok(timeline.length > 0, "mission cancellation timeline must not be empty");
  const planIndex = timeline.findIndex((event) => event.kind === "plan");
  const callIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "call");
  const resultIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "result");
  const finalIndex = timeline.findIndex((event) => event.kind === "thought" && event.text.includes(spec.finalMarker));
  assert.ok(planIndex >= 0, "mission cancellation timeline must include the user plan event");
  assert.equal(callIndexes.length, 1, "cancel E2E expected exactly one sessions_spawn call");
  assert.equal(resultIndexes.length, 1, "cancel E2E expected exactly one sessions_spawn result");
  assert.ok(callIndexes[0]! > planIndex, "sessions_spawn call must appear after the user plan");
  assert.ok(resultIndexes[0]! > callIndexes[0]!, "cancelled sessions_spawn result must appear after the call");
  assert.ok(finalIndex > resultIndexes[0]!, "final answer must appear after the cancelled sessions_spawn result");
  const result = timeline[resultIndexes[0]!];
  const resultBlob = [result?.text ?? "", String(result?.runtime?.["resultContent"] ?? "")].join("\n");
  assert.match(resultBlob, /\bcancel(?:led|ed)?\b/i, "cancelled sessions_spawn result must name cancellation");
  assert.equal(result?.emph, "danger", "cancelled sessions_spawn result should be marked as an attention event");
}

function assertNaturalCancellationTimeline(timeline: ActivityEvent[]): void {
  assert.ok(timeline.length > 0, "natural cancellation timeline must not be empty");
  const planIndex = timeline.findIndex((event) => event.kind === "plan");
  const callIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "call");
  const resultIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "result");
  const missionCancelIndex = timeline.findIndex((event) => event.runtime?.["eventType"] === "mission.cancelled");
  let finalIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index]!;
    if ((event.kind === "thought" || event.runtime?.["eventType"] === "mission.cancelled") && event.text.trim().length > 0) {
      finalIndex = index;
      break;
    }
  }
  assert.ok(planIndex >= 0, "natural cancellation timeline must include the user plan event");
  if (resultIndexes.length > 0) {
    assert.equal(callIndexes.length, 1, "natural cancellation expected exactly one sessions_spawn call when tool cancellation occurs");
    assert.equal(resultIndexes.length, 1, "natural cancellation expected exactly one sessions_spawn result when tool cancellation occurs");
    assert.ok(callIndexes[0]! > planIndex, "sessions_spawn call must appear after the user plan");
    assert.ok(resultIndexes[0]! > callIndexes[0]!, "cancelled sessions_spawn result must appear after the call");
    assert.ok(finalIndex > resultIndexes[0]!, "final cancellation answer/event must appear after the cancelled sessions_spawn result");
    const result = timeline[resultIndexes[0]!];
    const resultBlob = [result?.text ?? "", String(result?.runtime?.["resultContent"] ?? "")].join("\n");
    assert.match(resultBlob, /\bcancel(?:led|ed)?\b/i, "cancelled sessions_spawn result must name cancellation");
    assert.equal(result?.emph, "danger", "cancelled sessions_spawn result should be marked as an attention event");
    return;
  }
  assert.ok(missionCancelIndex > planIndex, "mission-level cancellation event must appear after the user plan");
  assert.ok(finalIndex >= missionCancelIndex, "final cancellation event must be visible");
}

function assertMissionApprovalTimeline(timeline: ActivityEvent[], spec: ScenarioSpec, approvalId: string): void {
  const approvalEvents = timeline.filter((event) => event.kind === "approval" || event.approvalId === approvalId);
  assert.ok(approvalEvents.length >= 2, "approval E2E must record request and decision/application events");
  const eventTypes = timeline.map((event) => String(event.runtime?.["eventType"] ?? "")).filter(Boolean);
  assert.ok(eventTypes.includes("permission.query"), "approval E2E timeline must include permission.query");
  assert.ok(eventTypes.includes("permission.result"), "approval E2E timeline must include permission.result");
  assert.ok(eventTypes.includes("permission.applied"), "approval E2E timeline must include permission.applied");

  const callIndex = findToolPhaseIndexes(timeline, "sessions_spawn", "call")[0] ?? -1;
  const resultIndex = findToolPhaseIndexes(timeline, "sessions_spawn", "result")[0] ?? -1;
  const queryIndex = timeline.findIndex((event) => event.runtime?.["eventType"] === "permission.query");
  const decisionIndex = timeline.findIndex((event) => event.runtime?.["eventType"] === "permission.result");
  const appliedIndex = timeline.findIndex((event) => event.runtime?.["eventType"] === "permission.applied");
  const finalIndex = timeline.findIndex((event) => event.kind === "thought" && event.text.includes(spec.finalMarker));
  assert.ok(queryIndex > callIndex, "permission.query must occur after the sessions_spawn call");
  assert.ok(decisionIndex > queryIndex, "permission.result must occur after permission.query");
  assert.ok(appliedIndex > decisionIndex, "permission.applied must occur after permission.result");
  assert.ok(appliedIndex > queryIndex, "permission.applied must occur after permission.query");
  assert.ok(resultIndex > appliedIndex, "browser worker result must occur after permission.applied");
  assert.ok(finalIndex > resultIndex, "final answer must appear after the approved browser result");
}

function assertMissionTimeoutTimeline(timeline: ActivityEvent[], spec: ScenarioSpec): void {
  assert.ok(timeline.length > 0, "mission timeout timeline must not be empty");
  const planIndex = timeline.findIndex((event) => event.kind === "plan");
  const spawnCallIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "call");
  const sendCallIndexes = findToolPhaseIndexes(timeline, "sessions_send", "call");
  const resultIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "result");
  const finalIndex = timeline.findIndex((event) => event.kind === "thought" && event.text.includes(spec.finalMarker));
  assert.ok(planIndex >= 0, "mission timeout timeline must include the user plan event");
  assert.equal(spawnCallIndexes.length, 1, "timeout E2E expected exactly one sessions_spawn call");
  assert.equal(sendCallIndexes.length, 0, "timeout E2E must not call sessions_send after timeout");
  assert.equal(resultIndexes.length, 1, "timeout E2E expected exactly one sessions_spawn result");
  assert.ok(spawnCallIndexes[0]! > planIndex, "sessions_spawn call must appear after the user plan");
  assert.ok(resultIndexes[0]! > spawnCallIndexes[0]!, "timeout sessions_spawn result must appear after the call");
  assert.ok(finalIndex > resultIndexes[0]!, "final answer must appear after the timeout result");

  const callInput = timeline[spawnCallIndexes[0]!]!.runtime?.["callInput"];
  assert.equal(typeof callInput, "string", "timeout sessions_spawn call must persist structured callInput");
  const parsedCall = JSON.parse(callInput as string) as { timeout_seconds?: number; agent_id?: string };
  assert.equal(parsedCall.agent_id, "explore", "timeout E2E must use the explore child session");
  assert.equal(parsedCall.timeout_seconds, 0.001, "timeout E2E must request the bounded timeout_seconds value");

  const result = timeline[resultIndexes[0]!];
  const resultBlob = [result?.text ?? "", String(result?.runtime?.["resultContent"] ?? "")].join("\n");
  assert.match(resultBlob, /\btimeout|timed out\b/i, "timeout sessions_spawn result must name the timeout");
  assert.match(resultBlob, /"status"\s*:\s*"timeout"/, "timeout sessions_spawn result must use session status=timeout");
  assert.equal(result?.emph, "danger", "timeout sessions_spawn result should be marked as an attention event");
}

function assertMissionCloseoutTimeline(timeline: ActivityEvent[], spec: ScenarioSpec): void {
  assert.ok(spec.expectedCloseoutReason, "closeout timeline assertion requires expectedCloseoutReason");
  const final = findFinalEvent(timeline, spec.finalMarker);
  assert.ok(final, "closeout E2E must include the final assistant answer");
  assert.equal(
    final.runtime?.["toolLoopCloseoutReason"],
    spec.expectedCloseoutReason,
    "closeout E2E final answer must expose the expected toolLoopCloseoutReason"
  );
  assert.equal(
    final.runtime?.["toolLoopCloseout"],
    "true",
    "closeout E2E final answer must mark toolLoopCloseout=true"
  );
  if (spec.expectedCloseoutEvidenceAvailable !== undefined) {
    assert.equal(
      final.runtime?.["toolLoopCloseout.evidenceAvailable"],
      spec.expectedCloseoutEvidenceAvailable,
      "closeout E2E final answer must expose expected evidence availability"
    );
  }
  assert.match(
    String(final.runtime?.["toolLoopCloseout.roundCount"] ?? ""),
    /^\d+$/,
    "closeout E2E final answer must expose completed round count"
  );
  assert.match(
    String(final.runtime?.["toolLoopCloseout.toolCallCount"] ?? ""),
    /^\d+$/,
    "closeout E2E final answer must expose executed tool-call count"
  );
}

function assertMissionBudgetCloseoutTimeline(timeline: ActivityEvent[], spec: ScenarioSpec): void {
  assert.ok(timeline.length > 0, "budget closeout timeline must not be empty");
  const planIndex = timeline.findIndex((event) => event.kind === "plan");
  const listCallIndexes = findToolPhaseIndexes(timeline, "tasks_list", "call");
  const listResultIndexes = findToolPhaseIndexes(timeline, "tasks_list", "result");
  const createCallIndexes = findToolPhaseIndexes(timeline, "tasks_create", "call");
  const createResultIndexes = findToolPhaseIndexes(timeline, "tasks_create", "result");
  const sessionCallIndexes = [
    ...findToolPhaseIndexes(timeline, "sessions_spawn", "call"),
    ...findToolPhaseIndexes(timeline, "sessions_send", "call"),
  ];
  const finalIndex = timeline.findIndex((event) => event.kind === "thought" && event.text.includes(spec.finalMarker));

  assert.ok(planIndex >= 0, "budget closeout timeline must include the user plan event");
  assert.equal(sessionCallIndexes.length, 0, "budget closeout E2E must not use sub-agent session tools");
  assert.equal(listCallIndexes.length, 1, "budget closeout E2E expected exactly one tasks_list call");
  assert.equal(listResultIndexes.length, 1, "budget closeout E2E expected exactly one tasks_list result");
  assert.equal(createCallIndexes.length, 0, "budget-limited pending tasks_create must not be persisted as an executed tool call");
  assert.equal(createResultIndexes.length, 0, "budget-limited pending tasks_create must not execute");
  assert.ok(listCallIndexes[0]! > planIndex, "tasks_list call must appear after the user plan");
  assert.ok(listResultIndexes[0]! > listCallIndexes[0]!, "tasks_list result must appear after the call");
  assert.ok(finalIndex > listResultIndexes[0]!, "final answer must appear after the first tool result");

  const callInput = timeline[listCallIndexes[0]!]!.runtime?.["callInput"];
  assert.equal(typeof callInput, "string", "budget closeout tasks_list call must persist structured callInput");
  const parsedCall = JSON.parse(callInput as string) as { limit?: number };
  assert.equal(parsedCall.limit, 10, "budget closeout E2E must request tasks_list limit 10");
}

async function assertWorkerSessionCancelled(input: {
  baseUrl: string;
  token: string;
  threadId: string;
  workerRunKey: string;
}): Promise<void> {
  const sessions = await requestJson<WorkerSessionRecord[]>({
    method: "GET",
    url: `${input.baseUrl}/runtime-worker-sessions?threadId=${encodeURIComponent(input.threadId)}&limit=20`,
    token: input.token,
  });
  const session = sessions.find((item) => item.workerRunKey === input.workerRunKey);
  assert.ok(session, `cancel E2E must expose worker session ${input.workerRunKey}`);
  assert.equal(session.state.status, "cancelled", "cancel E2E worker session must end as cancelled");
}

async function assertWorkerSessionDoneAfterResume(input: {
  baseUrl: string;
  token: string;
  threadId: string;
  workerRunKey: string;
}): Promise<void> {
  const sessions = await requestJson<WorkerSessionRecord[]>({
    method: "GET",
    url: `${input.baseUrl}/runtime-worker-sessions?threadId=${encodeURIComponent(input.threadId)}&limit=20`,
    token: input.token,
  });
  const session = sessions.find((item) => item.workerRunKey === input.workerRunKey);
  assert.ok(session, `follow-up E2E must expose worker session ${input.workerRunKey}`);
  assert.equal(
    session.state.status,
    "done",
    `follow-up E2E worker session must finish after resume: ${JSON.stringify(
      {
        status: session.state.status,
        workerType: session.state.workerType,
        lastResultStatus: session.state.lastResult?.status,
        lastResultSummary: session.state.lastResult?.summary,
        lastError: session.state.lastError,
        continuationDigest: session.state.continuationDigest,
      },
      null,
      2
    )}`
  );
}

async function assertWorkerSessionResumableAfterTimeout(input: {
  baseUrl: string;
  token: string;
  threadId: string;
  workerRunKey: string;
}): Promise<void> {
  const sessions = await requestJson<WorkerSessionRecord[]>({
    method: "GET",
    url: `${input.baseUrl}/runtime-worker-sessions?threadId=${encodeURIComponent(input.threadId)}&limit=20`,
    token: input.token,
  });
  const session = sessions.find((item) => item.workerRunKey === input.workerRunKey);
  assert.ok(session, `timeout E2E must expose worker session ${input.workerRunKey}`);
  assert.equal(session.state.status, "resumable", "timeout E2E worker session must remain resumable");
}

async function waitForMissionMetricsSettled(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  timeoutMs: number;
  expectedStatus?: Mission["status"];
}): Promise<MissionObservabilitySnapshot> {
  const startedAt = Date.now();
  let latest: MissionObservabilitySnapshot | null = null;
  const expectedStatus = input.expectedStatus ?? "done";
  while (Date.now() - startedAt < input.timeoutMs) {
    latest = await requestJson<MissionObservabilitySnapshot>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/metrics`,
      token: input.token,
    });
    if (
      latest.status === expectedStatus &&
      latest.liveness.active === 0 &&
      latest.liveness.waiting === 0 &&
      latest.liveness.stale === 0
    ) {
      return latest;
    }
    await sleep(500);
  }
  throw new Error(`mission metrics did not settle after terminal completion: ${JSON.stringify(latest)}`);
}

async function waitForMissionArtifactsSettled(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  timeoutMs: number;
  requireLifecycle: boolean;
}): Promise<MissionArtifact[]> {
  const startedAt = Date.now();
  let latest: MissionArtifact[] = [];
  while (Date.now() - startedAt < input.timeoutMs) {
    latest = await requestJson<MissionArtifact[]>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/artifacts`,
      token: input.token,
    });
    if (!input.requireLifecycle || latest.some(hasArtifactLifecycleEvidence)) {
      return latest;
    }
    await sleep(500);
  }
  return latest;
}

function hasArtifactLifecycleEvidence(artifact: MissionArtifact): boolean {
  return Boolean(
    artifact.lifecycle &&
      artifact.lifecycle.storageBackend &&
      artifact.lifecycle.refType &&
      typeof artifact.lifecycle.retentionMs === "number" &&
      typeof artifact.lifecycle.expiresAtMs === "number" &&
      typeof artifact.lifecycle.maxArtifactBytes === "number" &&
      typeof artifact.lifecycle.sessionBudgetBytes === "number" &&
      artifact.lifecycle.orphanReconciliation
  );
}

function findToolPhaseIndexes(
  timeline: ActivityEvent[],
  toolName: string,
  phase: "call" | "progress" | "result"
): number[] {
  return timeline.flatMap((event, index) =>
    event.runtime?.["toolName"] === toolName && event.runtime?.["toolPhase"] === phase ? [index] : []
  );
}

function assertMissionMetrics(metrics: MissionObservabilitySnapshot, spec: ScenarioSpec): void {
  assert.equal(metrics.status, "done", "mission metrics must reflect the completed mission status");
  if (spec.expectedToolResultsMax === undefined) {
    assert.equal(metrics.tool.requested, spec.expectedToolResults, "mission metrics must match requested tool calls");
    assert.equal(metrics.tool.results, spec.expectedToolResults, "mission metrics must match tool results");
  } else {
    assert.ok(
      metrics.tool.requested >= spec.expectedToolResults && metrics.tool.requested <= spec.expectedToolResultsMax,
      `mission metrics requested tool calls must be between ${spec.expectedToolResults} and ${spec.expectedToolResultsMax}`
    );
    assert.ok(
      metrics.tool.results >= spec.expectedToolResults && metrics.tool.results <= spec.expectedToolResultsMax,
      `mission metrics tool results must be between ${spec.expectedToolResults} and ${spec.expectedToolResultsMax}`
    );
  }
  assert.equal(
    metrics.tool.failed,
    spec.expectedToolFailures ?? 0,
    "mission metrics must match failed tool results"
  );
  assert.equal(
    metrics.tool.timeouts,
    spec.expectedToolTimeouts ?? 0,
    "mission metrics must match timed-out tools"
  );
  assertCountInRange(
    metrics.sessions.spawned,
    spec.expectedSpawnedSessions,
    spec.expectedSpawnedSessionsMax,
    "mission metrics spawned sub-agent sessions"
  );
  assertCountInRange(
    metrics.sessions.continued,
    spec.expectedContinuedSessions,
    spec.expectedContinuedSessionsMax,
    "mission metrics continued sub-agent sessions"
  );
  assert.equal(metrics.recovery.events, 0, "mission metrics must not report recovery events");
  assert.equal(metrics.liveness.active, 0, "completed mission must not retain active runtime subjects");
  assert.equal(metrics.liveness.waiting, 0, "completed mission must not retain waiting runtime subjects");
  assert.equal(metrics.liveness.stale, 0, "mission metrics must not report stale runtime subjects");
  assert.equal(
    metrics.qualityGate.status,
    spec.expectedQualityGateStatus ?? "passed",
    `mission metrics quality gate must match expected status: ${JSON.stringify(metrics.qualityGate.checks)}`
  );
  if (spec.expectedCloseoutReason) {
    const closeoutCheck = metrics.qualityGate.checks?.find((check) => check.name === "tool_loop_closeout");
    assert.equal(closeoutCheck?.status, "warn", "forced closeout must surface a tool_loop_closeout warning");
    assert.match(
      String(closeoutCheck?.detail ?? ""),
      new RegExp(spec.expectedCloseoutReason === "round_limit" ? "tool-round limit" : "sub-agent timeout", "i"),
      "tool_loop_closeout detail must name the closeout reason"
    );
  }
  assert.ok(metrics.qualityGate.evidenceEvents >= spec.minEvidenceEvents, "mission metrics must count evidence-bearing events");
  if (spec.expectedSourceLabels?.length) {
    const sourceCoverage = metrics.qualityGate.checks?.find((check) => check.name === "source_coverage");
    assert.equal(sourceCoverage?.status, "pass", "mission source coverage check must pass");
    assert.match(
      String(sourceCoverage?.detail ?? ""),
      new RegExp(`Final answer covers ${spec.expectedSourceLabels.length}/${spec.expectedSourceLabels.length} visible source label`),
      "mission source coverage must prove visible source labels were audited"
    );
  }
}

function assertMissionCancelMetrics(metrics: MissionObservabilitySnapshot, spec: ScenarioSpec): void {
  assert.equal(metrics.status, "done", "cancel E2E mission should still complete with a final answer");
  assert.equal(metrics.tool.requested, spec.expectedToolResults, "cancel E2E must count the requested tool call");
  assert.equal(metrics.tool.results, spec.expectedToolResults, "cancel E2E must count the cancelled tool result");
  assert.equal(metrics.tool.cancelled, 1, "cancel E2E must report one cancelled tool");
  assert.equal(metrics.tool.timeouts, 0, "cancel E2E cancellation must not be reported as a timeout");
  assert.equal(metrics.sessions.spawned, spec.expectedSpawnedSessions, "cancel E2E must count the spawned sub-agent session");
  assert.equal(metrics.sessions.continued, 0, "cancel E2E must not continue a sub-agent session");
  assert.equal(metrics.liveness.active, 0, "cancel E2E must not retain active runtime subjects");
  assert.equal(metrics.liveness.waiting, 0, "cancel E2E must not retain waiting runtime subjects");
  assert.equal(metrics.liveness.stale, 0, "cancel E2E must not report stale runtime subjects");
  assert.equal(metrics.qualityGate.status, "blocked", "cancel E2E should keep failed-tool attention visible");
  assert.ok(metrics.qualityGate.evidenceEvents >= spec.minEvidenceEvents, "cancel E2E must count the cancelled tool result as evidence");
}

function assertMissionTimeoutMetrics(metrics: MissionObservabilitySnapshot, spec: ScenarioSpec): void {
  assert.equal(metrics.status, "done", "timeout E2E mission should complete with a bounded final answer");
  assert.equal(metrics.tool.requested, spec.expectedToolResults, "timeout E2E must count the requested tool call");
  assert.equal(metrics.tool.results, spec.expectedToolResults, "timeout E2E must count the timeout tool result");
  assert.equal(metrics.tool.failed, 1, "timeout E2E must report the timed-out tool as failed attention");
  assert.equal(metrics.tool.cancelled, 0, "timeout E2E timeout must not be reported as cancellation");
  assert.equal(metrics.tool.timeouts, 1, "timeout E2E must report one timed-out tool");
  assert.equal(metrics.sessions.spawned, spec.expectedSpawnedSessions, "timeout E2E must count the spawned sub-agent session");
  assert.equal(metrics.sessions.continued, 0, "timeout E2E must not continue a sub-agent session");
  assert.equal(metrics.liveness.active, 0, "timeout E2E must not retain active runtime subjects");
  assert.equal(metrics.liveness.waiting, 0, "timeout E2E must not retain waiting runtime subjects");
  assert.equal(metrics.liveness.stale, 0, "timeout E2E must not report stale runtime subjects");
  assert.equal(metrics.qualityGate.status, "blocked", "timeout E2E should keep failed-tool attention visible");
  assert.ok(metrics.qualityGate.evidenceEvents >= spec.minEvidenceEvents, "timeout E2E must count the timeout tool result as evidence");
}

function assertMissionApprovalMetrics(metrics: MissionObservabilitySnapshot, spec: ScenarioSpec): void {
  assertMissionMetrics(metrics, spec);
  assert.equal(metrics.approvals.requested, 1, "approval E2E must count one requested approval");
  assert.equal(metrics.approvals.decided, 1, "approval E2E must count one approval decision");
  assert.equal(metrics.approvals.applied, 1, "approval E2E must count one applied approval");
}

function findFinalEvent(timeline: ActivityEvent[], finalMarker: string): ActivityEvent | null {
  return timeline.find((event) => event.kind === "thought" && event.text.includes(finalMarker)) ?? null;
}

export function evaluateFinalQuality(content: string, spec: ScenarioSpec): { bullets: number; failures: string[] } {
  const failures: string[] = [];
  const bytes = Buffer.byteLength(content, "utf8");
  const bullets = (content.match(/^\s*[-*+]\s+\S/gm) ?? []).length;
  const requiredEvidenceLineCount = spec.evidenceLinePatterns?.length ?? 0;
  const hasLabeledEvidenceShape =
    spec.allowLabeledEvidenceWithoutBullets === true &&
    requiredEvidenceLineCount === spec.expectedBullets &&
    spec.evidenceLinePatterns?.every((item) => item.pattern.test(content)) === true;
  if (bytes < (spec.minBytes ?? 180)) failures.push("final answer is too short");
  if (spec.maxBytes !== undefined && bytes > spec.maxBytes) {
    failures.push(`final answer is too long: ${bytes} > ${spec.maxBytes} bytes`);
  }
  const hasExpectedBulletCount = spec.allowAtLeastBullets === true ? bullets >= spec.expectedBullets : bullets === spec.expectedBullets;
  if (!hasExpectedBulletCount && !(bullets === 0 && hasLabeledEvidenceShape)) {
    const qualifier = spec.allowAtLeastBullets === true ? "at least" : "exactly";
    failures.push(`final answer must include ${qualifier} ${spec.expectedBullets} Markdown bullets`);
  }
  if (!content.includes(spec.finalMarker)) failures.push(`missing ${spec.finalMarker}`);
  for (const marker of spec.evidenceMarkers) {
    if (!content.includes(marker)) failures.push(`missing ${marker}`);
  }
  for (const term of spec.answerTerms) {
    if (!content.toLowerCase().includes(term.toLowerCase())) failures.push(`missing ${term}`);
  }
  for (const item of spec.answerPatterns ?? []) {
    if (!item.pattern.test(content)) failures.push(`missing ${item.label}`);
  }
  for (const item of spec.evidenceLinePatterns ?? []) {
    if (!item.pattern.test(content)) failures.push(`missing ${item.label}`);
  }
  for (const item of spec.forbiddenPatterns ?? []) {
    if (item.pattern.test(content)) failures.push(`forbidden ${item.label}`);
  }
  if (/```/.test(content)) failures.push("final answer must not use code fences");
  if (/^\s*\|.*\|\s*$/m.test(content)) failures.push("final answer must not use Markdown tables");
  if (/\*\*|__/.test(content)) failures.push("final answer must not use bold markup");
  if (/\[[^\]]+\]\([^)]+\)|https?:\/\//i.test(content)) failures.push("final answer must not include links");
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] ?? "";
  if (isStatusPreambleLine(firstLine)) {
    failures.push("final answer must not start with a status preamble");
  }
  const finalMarkerLines = lines.filter((line) => line.includes(spec.finalMarker));
  if (finalMarkerLines.length !== 1 || !/^\s*[-*+]\s+/.test(finalMarkerLines[0] ?? "")) {
    failures.push("final success marker must appear exactly once inside an evidence bullet");
  }
  if (/\b(assume|assumes|assuming|assumed|estimate|estimated|estimates|estimating|guess|guessed|guesses|guessing|probably|probable|maybe|perhaps|approximately|approximate)\b/i.test(content)) {
    failures.push("final answer contains unsupported/hedged claim language");
  }
  if (mentionsToolFallbackAnswer(content)) {
    failures.push("final answer falls back to model knowledge after tool/search/browser unavailable");
  }
  return { bullets, failures };
}

function mentionsToolFallbackAnswer(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  const toolUnavailable =
    /\b(?:search|browser|tool|retrieval|web)(?: (?:tool|path|access|result|results))?(?: (?:is|was|are|were))? (?:unavailable|not available|failed|not working|unable)\b/.test(
      normalized
    );
  if (toolUnavailable) return true;
  if (/\b(?:based on|using) (?:my )?(?:knowledge|training data)\b/.test(normalized)) return true;
  if (/\bwithout (?:live|current|fresh) (?:search|browser|web|tool)\b/.test(normalized)) return true;
  return /搜索工具.{0,12}(?:无法|不可用|没有返回)|(?:基于|根据)我的(?:知识库|知识|训练数据)|工具.{0,12}(?:不可用|无法返回|没有返回)/i.test(
    text
  );
}

function isStatusPreambleLine(line: string): boolean {
  const normalized = line.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized || /^(?:[-*+]\s+|#{1,6}\s+)/.test(normalized)) {
    return false;
  }
  if (normalized.startsWith("final answer:")) {
    return true;
  }
  if (
    normalized.startsWith("all ") &&
    /\b(?:child\s+)?sessions?\b/.test(normalized) &&
    /\b(?:returned|complete|completed|confirmed)\b/.test(normalized)
  ) {
    return true;
  }
  if (/^all tool calls?\b/.test(normalized) && /\b(?:returned|complete|completed)\b/.test(normalized)) {
    return true;
  }
  return /^(?:i am |i'm |i )?(?:now )?(?:producing|preparing|writing) the final answer\b/.test(normalized);
}

async function armAnyBrowserProfileLockSentinel(sentinelPath: string): Promise<void> {
  await writeFile(
    sentinelPath,
    JSON.stringify(
      {
        enabled: true,
        anyPrimaryProfile: true,
      },
      null,
      2
    ),
    "utf8"
  );
}

function startDaemon(input: {
  runtimeRoot: string;
  port: number;
  token: string;
  modelCatalogPath: string;
  agentToolMaxRounds?: number;
  extraEnv?: Record<string, string>;
}): { child: DaemonChildProcess; output: () => string } {
  let output = "";
  const child = spawn("npm", ["run", "daemon"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TURNKEYAI_HOME: input.runtimeRoot,
      TURNKEYAI_DATA_DIR: path.join(input.runtimeRoot, "data"),
      TURNKEYAI_DAEMON_PORT: String(input.port),
      TURNKEYAI_DAEMON_TOKEN: input.token,
      TURNKEYAI_MODEL_CATALOG: input.modelCatalogPath,
      TURNKEYAI_BROWSER_TRANSPORT: process.env.TURNKEYAI_BROWSER_TRANSPORT?.trim() || "local",
      TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE: "1",
      ...(input.agentToolMaxRounds === undefined
        ? {}
        : { TURNKEYAI_AGENT_TOOL_MAX_ROUNDS: String(input.agentToolMaxRounds) }),
      ...(input.extraEnv ?? {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.length > 16_000) {
      output = output.slice(-16_000);
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return { child, output: () => output };
}

async function waitForDaemonHealth(input: {
  baseUrl: string;
  daemon: { child: DaemonChildProcess; output: () => string };
  timeoutMs: number;
}): Promise<void> {
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  input.daemon.child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
    if (exited) {
      throw new Error(`daemon exited before health check: ${JSON.stringify(exited)}\n${input.daemon.output()}`);
    }
    try {
      const response = await fetch(`${input.baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`daemon did not become healthy within ${input.timeoutMs}ms\n${input.daemon.output()}`);
}

async function requestJson<T>(input: {
  method: "GET" | "POST";
  url: string;
  token: string;
  body?: unknown;
}): Promise<T> {
  const response = await fetch(input.url, {
    method: input.method,
    headers: {
      authorization: `Bearer ${input.token}`,
      ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`${input.method} ${input.url} returned ${response.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function allocatePort(): Promise<number> {
  const server = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address?.port) {
        resolve(address.port);
        return;
      }
      reject(new Error("failed to allocate a local port"));
    });
  });
  await closeServer(server);
  return port;
}

async function listenOnRandomPort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || !address?.port) {
    throw new Error("fixture server did not report a port");
  }
  return address.port;
}

async function closeServer(server: Server | net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function stopDaemon(child: DaemonChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    sleep(5_000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function summarizeMissionState(mission: Mission | null, timeline: ActivityEvent[]): string {
  const events = timeline
    .slice(-12)
    .map((event) => {
      const phase = event.runtime?.["toolPhase"] ? ` ${event.runtime["toolPhase"]}` : "";
      const tool = event.runtime?.["toolName"] ? ` ${event.runtime["toolName"]}` : "";
      return `- ${event.kind}${tool}${phase}: ${event.text.slice(0, 220).replace(/\s+/g, " ")}`;
    })
    .join("\n");
  return [
    `mission=${mission ? JSON.stringify(mission) : "null"}`,
    `timeline-events=${timeline.length}`,
    events,
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(parseOptions(process.argv.slice(2)));
}
