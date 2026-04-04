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
  | "reconnect-failure"
  | "workflow-log-failure"
  | "local-regression"
  | "unknown";

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

export interface BrowserTransportSoakTargetAggregate {
  target: BrowserTransportSoakTarget;
  cycles: number;
  passedCycles: number;
  failedCycles: number;
  failureBuckets: BrowserTransportSoakBucketAggregate[];
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
      const failureBucket = classifyBrowserTransportFailure({
        target,
        exitCode: runnerResult.exitCode,
        output,
      });
      targetResults.push({
        target,
        status: runnerResult.exitCode === 0 ? "passed" : "failed",
        durationMs,
        failureBucket,
        summary: summarizeBrowserTransportRun({
          target,
          exitCode: runnerResult.exitCode,
          output,
          failureBucket,
        }),
        output,
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
    for (const result of runs) {
      bucketCounts.set(result.failureBucket, (bucketCounts.get(result.failureBucket) ?? 0) + 1);
    }
    return {
      target,
      cycles: runs.length,
      passedCycles: runs.filter((result) => result.status === "passed").length,
      failedCycles: runs.filter((result) => result.status === "failed").length,
      failureBuckets: [...bucketCounts.entries()].map(([bucket, count]) => ({ bucket, count })),
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

  if (
    normalized.includes("no supported chromium executable found")
    || normalized.includes("enoent")
    || normalized.includes("cannot find chrome")
  ) {
    return "browser-launch-failure";
  }
  if (
    normalized.includes("timed out waiting for health")
    || normalized.includes("econnrefused")
    || normalized.includes("fetch failed")
    || normalized.includes("failed to fetch")
  ) {
    return "daemon-unreachable";
  }
  if (
    normalized.includes("content_script_unavailable")
    || normalized.includes("content script unavailable")
    || normalized.includes("no tab responded")
  ) {
    return "content-script-unavailable";
  }
  if (normalized.includes("action_timeout") || normalized.includes("action timeout")) {
    return "action-timeout";
  }
  if (
    normalized.includes("timed out waiting for cdp endpoint")
    || normalized.includes("no inspectable pages")
    || normalized.includes("browser endpoint unavailable")
    || normalized.includes("websocket endpoint")
  ) {
    return "cdp-unreachable";
  }
  if (
    normalized.includes("workflow-log")
    || normalized.includes("workflow log")
  ) {
    return "workflow-log-failure";
  }
  if (
    normalized.includes("to become stale")
    || normalized.includes("to become online")
    || normalized.includes("reconnect")
    || normalized.includes("resume-final-url")
    || normalized.includes("resume")
  ) {
    return "reconnect-failure";
  }
  if (
    normalized.includes("timed out waiting for relay peer")
    || normalized.includes("timed out waiting for any online relay peer")
  ) {
    return "peer-timeout";
  }
  if (
    normalized.includes("target_missing")
    || normalized.includes("missing target")
    || normalized.includes("no relay target")
    || normalized.includes("require-target")
  ) {
    return "target-missing";
  }
  if (
    normalized.includes("assertionerror")
    || normalized.includes("expected ")
    || normalized.includes("local regression")
  ) {
    return "local-regression";
  }
  return "unknown";
}

function summarizeBrowserTransportRun(input: {
  target: BrowserTransportSoakTarget;
  exitCode: number;
  output: string;
  failureBucket: BrowserTransportFailureBucket;
}): string {
  if (input.exitCode === 0) {
    const lines = input.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const finalUrl = lines.find((line) => line.startsWith("reconnect-final-url:"))
      ?? lines.find((line) => line.startsWith("browser-resume-final-url:"))
      ?? lines.find((line) => line.startsWith("browser-final-url:"));
    const peerCount = lines.find((line) => line.startsWith("peer-count:"));
    return [input.target, finalUrl, peerCount].filter(Boolean).join(" | ");
  }
  return `${input.target} failed (${input.failureBucket})`;
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
