import { BROWSER_LONG_CHAIN_ACTION_KINDS } from "@turnkeyai/core-types/team";

export type BrowserTransportSoakTarget = "relay" | "direct-cdp";

export type BrowserTransportFailureBucket =
  | "none"
  | "daemon-unreachable"
  | "browser-launch-failure"
  | "peer-timeout"
  | "target-missing"
  | "content-script-unavailable"
  | "action-timeout"
  | "cdp-unreachable"
  | "artifact-failure"
  | "reconnect-failure"
  | "workflow-log-failure"
  | "local-regression"
  | "unknown";

export type BrowserTransportAcceptanceCheckId =
  | "spawn-send-resume"
  | "final-url-continuity"
  | "transport-label"
  | "target-continuity"
  | "artifact-continuity"
  | "network-controls"
  | "rich-action-parity"
  | "cdp-control-plane"
  | "multi-target-continuity"
  | "download-artifact"
  | "upload-artifact"
  | "artifact-safety"
  | "reconnect"
  | "workflow-log"
  | "relay-target-discovery"
  | "relay-peer-multiplex";

export interface BrowserTransportAcceptanceCheck {
  checkId: BrowserTransportAcceptanceCheckId;
  status: "passed" | "failed" | "skipped";
  summary: string;
}

export interface BrowserTransportSoakRunnerInput {
  target: BrowserTransportSoakTarget;
  cycleNumber: number;
  timeoutMs: number;
  relayPeerCount: number;
  verifyReconnect: boolean;
  verifyWorkflowLog: boolean;
}

export interface BrowserTransportSoakRunnerResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
  durationMs?: number;
}

export interface BrowserTransportSoakCycleTargetResult {
  target: BrowserTransportSoakTarget;
  status: "passed" | "failed";
  durationMs: number;
  failureBucket: BrowserTransportFailureBucket;
  summary: string;
  output: string;
  acceptanceChecks?: BrowserTransportAcceptanceCheck[];
  passedAcceptanceChecks?: number;
  failedAcceptanceChecks?: number;
  skippedAcceptanceChecks?: number;
}

export interface BrowserTransportSoakCycleResult {
  cycleNumber: number;
  status: "passed" | "failed";
  durationMs: number;
  targets: BrowserTransportSoakCycleTargetResult[];
}

export interface BrowserTransportSoakBucketAggregate {
  bucket: BrowserTransportFailureBucket;
  count: number;
}

export interface BrowserTransportAcceptanceAggregate {
  checkId: BrowserTransportAcceptanceCheckId;
  passed: number;
  failed: number;
  skipped: number;
}

export interface BrowserTransportSoakTargetAggregate {
  target: BrowserTransportSoakTarget;
  cycles: number;
  passedCycles: number;
  failedCycles: number;
  failureBuckets: BrowserTransportSoakBucketAggregate[];
  acceptanceChecks: BrowserTransportAcceptanceAggregate[];
}

export interface BrowserTransportSoakResult {
  status: "passed" | "failed";
  totalCycles: number;
  passedCycles: number;
  failedCycles: number;
  totalTargetRuns: number;
  failedTargetRuns: number;
  durationMs: number;
  targets: BrowserTransportSoakTarget[];
  cycleResults: BrowserTransportSoakCycleResult[];
  targetAggregates: BrowserTransportSoakTargetAggregate[];
}

export interface BrowserTransportSoakOptions {
  cycles?: number;
  targets?: BrowserTransportSoakTarget[];
  timeoutMs?: number;
  relayPeerCount?: number;
  verifyReconnect?: boolean;
  verifyWorkflowLog?: boolean;
}

export interface BrowserTransportSoakDeps {
  runner: (input: BrowserTransportSoakRunnerInput) => Promise<BrowserTransportSoakRunnerResult>;
}

const DEFAULT_TARGETS: BrowserTransportSoakTarget[] = ["relay", "direct-cdp"];
const ACCEPTANCE_CHECK_IDS: BrowserTransportAcceptanceCheckId[] = [
  "spawn-send-resume",
  "final-url-continuity",
  "transport-label",
  "target-continuity",
  "artifact-continuity",
  "network-controls",
  "rich-action-parity",
  "cdp-control-plane",
  "multi-target-continuity",
  "download-artifact",
  "upload-artifact",
  "artifact-safety",
  "reconnect",
  "workflow-log",
  "relay-target-discovery",
  "relay-peer-multiplex",
];

export async function runBrowserTransportSoak(
  options: BrowserTransportSoakOptions,
  deps: BrowserTransportSoakDeps
): Promise<BrowserTransportSoakResult> {
  const cycles = normalizePositiveInteger(options.cycles, 3);
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 60_000);
  const relayPeerCount = normalizePositiveInteger(options.relayPeerCount, 2);
  const verifyReconnect = options.verifyReconnect ?? true;
  const verifyWorkflowLog = options.verifyWorkflowLog ?? true;
  const targets = normalizeTargets(options.targets);
  const startedAt = Date.now();
  const cycleResults: BrowserTransportSoakCycleResult[] = [];

  for (let cycleNumber = 1; cycleNumber <= cycles; cycleNumber += 1) {
    const cycleStartedAt = Date.now();
    const targetResults: BrowserTransportSoakCycleTargetResult[] = [];

    for (const target of targets) {
      const targetStartedAt = Date.now();
      const runnerResult = await deps.runner({
        target,
        cycleNumber,
        timeoutMs,
        relayPeerCount,
        verifyReconnect,
        verifyWorkflowLog,
      });
      const durationMs = runnerResult.durationMs ?? Date.now() - targetStartedAt;
      const output = [runnerResult.stdout, runnerResult.stderr ?? ""].filter(Boolean).join("\n").trim();
      const acceptanceChecks = evaluateBrowserTransportAcceptance({
        target,
        output,
        exitCode: runnerResult.exitCode,
        relayPeerCount,
        verifyReconnect,
        verifyWorkflowLog,
      });
      const failedAcceptanceChecks = acceptanceChecks.filter((check) => check.status === "failed").length;
      const passedAcceptanceChecks = acceptanceChecks.filter((check) => check.status === "passed").length;
      const skippedAcceptanceChecks = acceptanceChecks.filter((check) => check.status === "skipped").length;
      const failureBucket = runnerResult.exitCode === 0 && failedAcceptanceChecks > 0
        ? "local-regression"
        : classifyBrowserTransportFailure({
            target,
            exitCode: runnerResult.exitCode,
            output,
          });
      const status = runnerResult.exitCode === 0 && failedAcceptanceChecks === 0 ? "passed" : "failed";
      targetResults.push({
        target,
        status,
        durationMs,
        failureBucket,
        summary: summarizeBrowserTransportRun({
          target,
          exitCode: runnerResult.exitCode,
          output,
          failureBucket,
          acceptanceChecks,
        }),
        output,
        acceptanceChecks,
        passedAcceptanceChecks,
        failedAcceptanceChecks,
        skippedAcceptanceChecks,
      });
    }

    cycleResults.push({
      cycleNumber,
      status: targetResults.every((result) => result.status === "passed") ? "passed" : "failed",
      durationMs: Date.now() - cycleStartedAt,
      targets: targetResults,
    });
  }

  const targetAggregates = targets.map((target) => {
    const runs = cycleResults.flatMap((cycle) => cycle.targets.filter((result) => result.target === target));
    const bucketCounts = new Map<BrowserTransportFailureBucket, number>();
    const acceptanceCounts = new Map<
      BrowserTransportAcceptanceCheckId,
      { passed: number; failed: number; skipped: number }
    >();
    for (const result of runs) {
      bucketCounts.set(result.failureBucket, (bucketCounts.get(result.failureBucket) ?? 0) + 1);
      for (const check of result.acceptanceChecks ?? []) {
        const counts = acceptanceCounts.get(check.checkId) ?? { passed: 0, failed: 0, skipped: 0 };
        counts[check.status] += 1;
        acceptanceCounts.set(check.checkId, counts);
      }
    }
    return {
      target,
      cycles: runs.length,
      passedCycles: runs.filter((result) => result.status === "passed").length,
      failedCycles: runs.filter((result) => result.status === "failed").length,
      failureBuckets: [...bucketCounts.entries()].map(([bucket, count]) => ({ bucket, count })),
      acceptanceChecks: ACCEPTANCE_CHECK_IDS.map((checkId) => ({
        checkId,
        ...(acceptanceCounts.get(checkId) ?? { passed: 0, failed: 0, skipped: 0 }),
      })),
    };
  });

  const totalTargetRuns = cycleResults.reduce((sum, cycle) => sum + cycle.targets.length, 0);
  const failedTargetRuns = cycleResults.reduce(
    (sum, cycle) => sum + cycle.targets.filter((result) => result.status === "failed").length,
    0
  );

  return {
    status: cycleResults.every((cycle) => cycle.status === "passed") ? "passed" : "failed",
    totalCycles: cycleResults.length,
    passedCycles: cycleResults.filter((cycle) => cycle.status === "passed").length,
    failedCycles: cycleResults.filter((cycle) => cycle.status === "failed").length,
    totalTargetRuns,
    failedTargetRuns,
    durationMs: Date.now() - startedAt,
    targets,
    cycleResults,
    targetAggregates,
  };
}

export function classifyBrowserTransportFailure(input: {
  target: BrowserTransportSoakTarget;
  exitCode: number;
  output: string;
}): BrowserTransportFailureBucket {
  if (input.exitCode === 0) {
    return "none";
  }

  const normalized = input.output.toLowerCase();

  if (includesAny(normalized, [
    "no supported chromium executable found",
    "enoent",
    "cannot find chrome",
  ])) {
    return "browser-launch-failure";
  }
  if (includesAny(normalized, [
    "timed out waiting for health",
    "econnrefused",
    "fetch failed",
    "failed to fetch",
  ])) {
    return "daemon-unreachable";
  }
  if (includesAny(normalized, [
    "content_script_unavailable",
    "content script unavailable",
    "no tab responded",
  ])) {
    return "content-script-unavailable";
  }
  if (includesAny(normalized, ["action_timeout", "action timeout"])) {
    return "action-timeout";
  }
  if (includesAny(normalized, [
    "timed out waiting for cdp endpoint",
    "no inspectable pages",
    "browser endpoint unavailable",
    "websocket endpoint",
  ])) {
    return "cdp-unreachable";
  }
  if (includesAny(normalized, [
    "download smoke",
    "browser download",
    "relay download",
    "downloaded-file browser artifact",
    "download action",
    "upload smoke",
    "browser upload",
    "content script upload",
    "upload action",
  ])) {
    return "artifact-failure";
  }
  if (includesAny(normalized, ["workflow-log", "workflow log"])) {
    return "workflow-log-failure";
  }
  if (includesAny(normalized, [
    "to become stale",
    "to become online",
    "reconnect",
    "resume-final-url",
    "resume",
  ])) {
    return "reconnect-failure";
  }
  if (includesAny(normalized, [
    "timed out waiting for relay peer",
    "timed out waiting for any online relay peer",
  ])) {
    return "peer-timeout";
  }
  if (includesAny(normalized, [
    "target_missing",
    "missing target",
    "no relay target",
    "require-target",
  ])) {
    return "target-missing";
  }
  if (includesAny(normalized, [
    "assertionerror",
    "expected ",
    "local regression",
  ])) {
    return "local-regression";
  }
  return "unknown";
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function summarizeBrowserTransportRun(input: {
  target: BrowserTransportSoakTarget;
  exitCode: number;
  output: string;
  failureBucket: BrowserTransportFailureBucket;
  acceptanceChecks?: BrowserTransportAcceptanceCheck[];
}): string {
  if (input.exitCode === 0) {
    const lines = input.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const finalUrl = lines.find((line) => line.startsWith("reconnect-final-url:"))
      ?? lines.find((line) => line.startsWith("browser-resume-final-url:"))
      ?? lines.find((line) => line.startsWith("browser-final-url:"));
    const peerCount = lines.find((line) => line.startsWith("peer-count:"));
    const browserTargets = lines.find((line) => line.startsWith("browser-targets:"));
    const downloadArtifacts = lines.find((line) => line.startsWith("browser-download-artifacts:"));
    const uploadActions = lines.find((line) => line.startsWith("browser-upload-actions:"));
    const actionParity = lines.find((line) => line.startsWith("browser-action-parity:"));
    const artifactSafety = lines.find((line) => line.startsWith("browser-artifact-safety:"));
    const failedChecks = input.acceptanceChecks?.filter((check) => check.status === "failed") ?? [];
    const acceptanceSummary = failedChecks.length > 0
      ? `failed=${failedChecks.map((check) => check.checkId).join(",")}`
      : input.acceptanceChecks
        ? `acceptance=${input.acceptanceChecks.filter((check) => check.status === "passed").length}/${
            input.acceptanceChecks.filter((check) => check.status !== "skipped").length
          }`
        : null;
    return [input.target, finalUrl, peerCount, browserTargets, downloadArtifacts, uploadActions, actionParity, artifactSafety, acceptanceSummary]
      .filter(Boolean)
      .join(" | ");
  }
  return `${input.target} failed (${input.failureBucket})`;
}

export function evaluateBrowserTransportAcceptance(input: {
  target: BrowserTransportSoakTarget;
  exitCode: number;
  output: string;
  relayPeerCount: number;
  verifyReconnect: boolean;
  verifyWorkflowLog: boolean;
}): BrowserTransportAcceptanceCheck[] {
  const expectedTransportLabel = input.target === "relay" ? "chrome-relay" : "direct-cdp";
  const expectedTargetContinuity = input.target === "relay" ? "chrome-tab" : "direct-cdp";
  const browserHistory = parsePositiveLineValue(input.output, "browser-history");
  const reconnectHistory = parsePositiveLineValue(input.output, "reconnect-history");
  const screenshotCount = parsePositiveLineValue(input.output, "browser-screenshots");
  const artifactCount = parsePositiveLineValue(input.output, "browser-artifacts");
  const browserTargetCount = parsePositiveLineValue(input.output, "browser-targets");
  const downloadArtifactCount = parsePositiveLineValue(input.output, "browser-download-artifacts");
  const uploadActionCount = parsePositiveLineValue(input.output, "browser-upload-actions");
  const browserFinalUrl = findLineValue(input.output, "browser-final-url");
  const browserResumeFinalUrl = findLineValue(input.output, "browser-resume-final-url");
  const transportLabel = findLineValue(input.output, "browser-transport");
  const targetContinuity = findLineValue(input.output, "browser-target-continuity");
  const networkControls = findLineValue(input.output, "browser-network-controls");
  const actionParity = findLineValue(input.output, "browser-action-parity");
  const actionKinds = parseLineList(input.output, "browser-action-kinds");
  const cdpControls = findLineValue(input.output, "browser-cdp-controls");
  const artifactSafety = findLineValue(input.output, "browser-artifact-safety");
  const multiTarget = findLineValue(input.output, "browser-multi-target");
  const reconnectFinalUrl = findLineValue(input.output, "reconnect-final-url");
  const workflowStatus = findLineValue(input.output, "workflow-log-status");
  const targetCount = parsePositiveLineValue(input.output, "targets");
  const peerCount = parsePositiveLineValue(input.output, "peer-count");

  return [
    requiredCheck(
      "spawn-send-resume",
      browserHistory !== null && browserHistory >= 3,
      browserHistory === null
        ? "missing browser history marker"
        : `browser history contains ${browserHistory} dispatches`
    ),
    requiredCheck(
      "final-url-continuity",
      Boolean(browserFinalUrl?.includes("#submitted")) && Boolean(browserResumeFinalUrl?.includes("#submitted")),
      `final=${browserFinalUrl ?? "missing"} resume=${browserResumeFinalUrl ?? "missing"}`
    ),
    requiredCheck(
      "transport-label",
      transportLabel === expectedTransportLabel,
      `transport label ${transportLabel ?? "missing"} expected ${expectedTransportLabel}`
    ),
    requiredCheck(
      "target-continuity",
      targetContinuity === expectedTargetContinuity,
      `target continuity ${targetContinuity ?? "missing"} expected ${expectedTargetContinuity}`
    ),
    requiredCheck(
      "artifact-continuity",
      artifactCount !== null && artifactCount >= 1,
      `screenshots=${screenshotCount ?? "missing"} artifacts=${artifactCount ?? "missing"}`
    ),
    requiredCheck(
      "network-controls",
      networkControls === "passed",
      `network-controls=${networkControls ?? "missing"}`
    ),
    requiredCheck(
      "rich-action-parity",
      actionParity === "passed" && hasAllActionKinds(actionKinds),
      `action-parity=${actionParity ?? "missing"} action-kinds=${actionKinds.length ? actionKinds.join(",") : "missing"}`
    ),
    requiredCheck(
      "cdp-control-plane",
      cdpControls === "passed",
      `cdp-controls=${cdpControls ?? "missing"}`
    ),
    requiredCheck(
      "multi-target-continuity",
      multiTarget === "passed" && browserTargetCount !== null && browserTargetCount >= 2,
      `multi-target=${multiTarget ?? "missing"} browser-targets=${browserTargetCount ?? "missing"} expected>=2`
    ),
    requiredCheck(
      "download-artifact",
      downloadArtifactCount !== null && downloadArtifactCount >= 1,
      `download-artifacts=${downloadArtifactCount ?? "missing"} expected>=1`
    ),
    requiredCheck(
      "upload-artifact",
      uploadActionCount !== null && uploadActionCount >= 1,
      `upload-actions=${uploadActionCount ?? "missing"} expected>=1`
    ),
    requiredCheck(
      "artifact-safety",
      artifactSafety === "passed" && downloadArtifactCount !== null && uploadActionCount !== null,
      `artifact-safety=${artifactSafety ?? "missing"} download-artifacts=${downloadArtifactCount ?? "missing"} upload-actions=${uploadActionCount ?? "missing"}`
    ),
    optionalCheck(
      "reconnect",
      input.verifyReconnect,
      reconnectHistory !== null && reconnectHistory >= 4 && Boolean(reconnectFinalUrl?.includes("#submitted")),
      reconnectHistory === null
        ? "missing reconnect history marker"
        : `reconnect history=${reconnectHistory} final=${reconnectFinalUrl ?? "missing"}`
    ),
    optionalCheck(
      "workflow-log",
      input.verifyWorkflowLog,
      workflowStatus === "passed",
      `workflow-log status=${workflowStatus ?? "missing"}`
    ),
    optionalCheck(
      "relay-target-discovery",
      input.target === "relay",
      targetCount !== null && targetCount >= 1,
      `targets=${targetCount ?? "missing"} expected>=1`
    ),
    optionalCheck(
      "relay-peer-multiplex",
      input.target === "relay" && input.relayPeerCount > 1,
      peerCount !== null && peerCount >= input.relayPeerCount,
      `peer-count=${peerCount ?? "missing"} expected>=${input.relayPeerCount}`
    ),
  ];
}

function requiredCheck(
  checkId: BrowserTransportAcceptanceCheckId,
  passed: boolean,
  summary: string
): BrowserTransportAcceptanceCheck {
  return {
    checkId,
    status: passed ? "passed" : "failed",
    summary,
  };
}

function optionalCheck(
  checkId: BrowserTransportAcceptanceCheckId,
  required: boolean,
  passed: boolean,
  summary: string
): BrowserTransportAcceptanceCheck {
  if (!required) {
    return {
      checkId,
      status: "skipped",
      summary: "not requested for this run",
    };
  }
  return requiredCheck(checkId, passed, summary);
}

function findLineValue(output: string, key: string): string | null {
  const prefix = `${key}:`;
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function parsePositiveLineValue(output: string, key: string): number | null {
  const value = findLineValue(output, key);
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseLineList(output: string, key: string): string[] {
  const value = findLineValue(output, key);
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasAllActionKinds(actionKinds: string[]): boolean {
  const observed = new Set(actionKinds);
  return BROWSER_LONG_CHAIN_ACTION_KINDS.every((kind) => observed.has(kind));
}

function normalizeTargets(value?: BrowserTransportSoakTarget[]): BrowserTransportSoakTarget[] {
  const source = value?.length ? value : DEFAULT_TARGETS;
  const seen = new Set<BrowserTransportSoakTarget>();
  const next: BrowserTransportSoakTarget[] = [];
  for (const target of source) {
    if ((target === "relay" || target === "direct-cdp") && !seen.has(target)) {
      seen.add(target);
      next.push(target);
    }
  }
  return next.length > 0 ? next : [...DEFAULT_TARGETS];
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}
