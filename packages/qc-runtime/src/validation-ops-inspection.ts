import type {
  ValidationOpsFailureBucket,
  ValidationOpsIssueRecord,
  ValidationOpsIssueSeverity,
  ValidationOpsRecommendedAction,
  ValidationOpsReport,
  ValidationOpsRunRecord,
} from "@turnkeyai/core-types/team";

import type { ReleaseReadinessResult } from "./release-readiness";
import type { BrowserTransportSoakResult } from "./browser-transport-soak";
import type { ValidationProfileIssue, ValidationProfileRunResult } from "./validation-profile";
import type { ValidationSoakSeriesResult } from "./validation-soak-series";

export function buildValidationOpsRecordFromReleaseReadiness(input: {
  runId: string;
  startedAt: number;
  completedAt: number;
  result: ReleaseReadinessResult;
}): ValidationOpsRunRecord {
  const issues = input.result.checks
    .filter((check) => check.status === "failed")
    .map((check) => buildValidationOpsIssue({
      issueId: `${input.runId}:${check.checkId}`,
      kind: "release-check",
      scope: check.checkId,
      summary: `${check.title} failed`,
      commandHint: "release-verify",
    }));

  return {
    runId: input.runId,
    runType: "release-readiness",
    title: "Release readiness verification",
    status: input.result.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.completedAt - input.startedAt,
    issueCount: issues.length,
    issues,
  };
}

export function buildValidationOpsRecordFromValidationProfile(input: {
  runId: string;
  startedAt: number;
  completedAt: number;
  result: ValidationProfileRunResult;
}): ValidationOpsRunRecord {
  const issues = input.result.issues.map((issue) =>
    buildValidationOpsIssue({
      issueId: `${input.runId}:${issue.issueId}`,
      kind: issue.kind,
      scope: issue.scope,
      summary: issue.summary,
      commandHint: buildValidationProfileIssueCommandHint(input.result, issue),
    })
  );

  return {
    runId: input.runId,
    runType: "validation-profile",
    title: input.result.title,
    status: input.result.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.completedAt - input.startedAt,
    issueCount: issues.length,
    profileId: input.result.profileId,
    selectors: [...input.result.validationSelectors],
    ...(input.result.soakSeriesCycles ? { cycles: input.result.soakSeriesCycles } : {}),
    ...(input.result.transportSoakTargets ? { targets: [...input.result.transportSoakTargets] } : {}),
    issues,
  };
}

export function buildValidationOpsRecordFromSoakSeries(input: {
  runId: string;
  startedAt: number;
  completedAt: number;
  selectors: string[];
  result: ValidationSoakSeriesResult;
}): ValidationOpsRunRecord {
  const issues = input.result.suiteAggregates
    .filter((aggregate) => aggregate.failedCycles > 0)
    .map((aggregate) =>
      buildValidationOpsIssue({
        issueId: `${input.runId}:${aggregate.suiteId}`,
        kind: "soak-suite",
        scope: aggregate.suiteId,
        summary: `${aggregate.suiteId} failed ${aggregate.failedCycles}/${aggregate.cycles} soak cycles`,
        commandHint: `soak-series ${input.result.totalCycles} ${input.selectors.join(" ")}`.trim(),
      })
    );

  return {
    runId: input.runId,
    runType: "soak-series",
    title: "Validation soak series",
    status: input.result.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.completedAt - input.startedAt,
    issueCount: issues.length,
    selectors: [...input.selectors],
    cycles: input.result.totalCycles,
    issues,
  };
}

export function buildValidationOpsRecordFromTransportSoak(input: {
  runId: string;
  startedAt: number;
  completedAt: number;
  artifactPath?: string;
  result: BrowserTransportSoakResult;
}): ValidationOpsRunRecord {
  const issues = input.result.targetAggregates
    .filter((aggregate) => aggregate.failedCycles > 0)
    .map((aggregate) => {
      const topFailureBucket = aggregate.failureBuckets
        .filter((bucket) => bucket.bucket !== "none")
        .sort((left, right) => right.count - left.count || left.bucket.localeCompare(right.bucket))[0];
      const bucketSummary = topFailureBucket ? `${topFailureBucket.bucket} x${topFailureBucket.count}` : "unknown";
      const failedChecks = aggregate.acceptanceChecks
        .filter((check) => check.failed > 0)
        .sort((left, right) => right.failed - left.failed || left.checkId.localeCompare(right.checkId));
      const acceptanceSummary = failedChecks.length > 0
        ? `; failed checks: ${failedChecks.map((check) => `${check.checkId} x${check.failed}`).join(", ")}`
        : "";
      return buildValidationOpsIssue({
        issueId: `${input.runId}:${aggregate.target}`,
        kind: "transport-target",
        scope: aggregate.target,
        summary: `${aggregate.target} transport soak failed ${aggregate.failedCycles}/${aggregate.cycles} cycles (${bucketSummary}${acceptanceSummary})`,
        commandHint: `transport-soak ${input.result.totalCycles} ${aggregate.target}`.trim(),
      });
    });

  return {
    runId: input.runId,
    runType: "transport-soak",
    title: "Browser transport soak",
    status: input.result.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.completedAt - input.startedAt,
    issueCount: issues.length,
    targets: [...input.result.targets],
    cycles: input.result.totalCycles,
    ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
    issues,
  };
}

function buildValidationProfileIssueCommandHint(
  result: ValidationProfileRunResult,
  issue: ValidationProfileIssue
): string {
  if (issue.kind === "release-check") {
    return "release-verify";
  }
  if (issue.kind === "soak-suite") {
    const selectors = result.soakSeriesSelectors ?? [];
    return `soak-series ${result.soakSeriesCycles ?? 1} ${selectors.join(" ")}`.trim();
  }
  if (issue.kind === "transport-target") {
    return `transport-soak ${result.transportSoakCycles ?? 1} ${issue.scope}`.trim();
  }
  return `validation-profile-run ${result.profileId}`;
}

export function buildValidationOpsReport(records: ValidationOpsRunRecord[], limit = 10): ValidationOpsReport {
  const latestRuns = [...records]
    .sort((left, right) => right.completedAt - left.completedAt)
    .slice(0, Math.max(1, limit));
  const runTypeCounts: ValidationOpsReport["runTypeCounts"] = {};
  const bucketCounts: ValidationOpsReport["bucketCounts"] = {};
  const severityCounts: ValidationOpsReport["severityCounts"] = {};
  const recommendedActionCounts: ValidationOpsReport["recommendedActionCounts"] = {};

  const activeIssues = latestRuns
    .flatMap((record) =>
      record.issues.map((issue) => ({
        ...issue,
        runId: record.runId,
        runType: record.runType,
        title: record.title,
        recordedAt: record.completedAt,
      }))
    )
    .sort((left, right) => compareValidationIssueSeverity(left.severity, right.severity) || right.recordedAt - left.recordedAt);

  for (const record of latestRuns) {
    runTypeCounts[record.runType] = (runTypeCounts[record.runType] ?? 0) + 1;
    for (const issue of record.issues) {
      bucketCounts[issue.bucket] = (bucketCounts[issue.bucket] ?? 0) + 1;
      severityCounts[issue.severity] = (severityCounts[issue.severity] ?? 0) + 1;
      recommendedActionCounts[issue.recommendedAction] = (recommendedActionCounts[issue.recommendedAction] ?? 0) + 1;
    }
  }

  return {
    totalRuns: latestRuns.length,
    failedRuns: latestRuns.filter((record) => record.status === "failed").length,
    passedRuns: latestRuns.filter((record) => record.status === "passed").length,
    attentionCount: activeIssues.length,
    runTypeCounts,
    bucketCounts,
    severityCounts,
    recommendedActionCounts,
    latestRuns,
    activeIssues: activeIssues.slice(0, Math.max(1, limit)),
    readiness: buildPhase1ReadinessReport(records),
  };
}

function buildPhase1ReadinessReport(records: ValidationOpsRunRecord[]): ValidationOpsReport["readiness"] {
  const gates: ValidationOpsReport["readiness"]["gates"] = [
    buildReadinessGate({
      gateId: "phase1-e2e-profile",
      title: "Phase 1 E2E validation profile",
      commandHint: "validation-profile-run phase1-e2e",
      record: findLatestRecord(records, (record) =>
        record.runType === "validation-profile" && record.profileId === "phase1-e2e"
      ),
      missingSummary: "No phase1-e2e validation profile run has been recorded.",
    }),
    buildReadinessGate({
      gateId: "release-readiness",
      title: "Release readiness",
      commandHint: "release-verify",
      record: findLatestRecord(records, (record) => record.runType === "release-readiness"),
      missingSummary: "No release-readiness run has been recorded.",
    }),
    buildReadinessGate({
      gateId: "transport-soak",
      title: "Browser transport soak",
      commandHint: "transport-soak 3 relay direct-cdp",
      record: findLatestRecord(records, (record) =>
        record.runType === "transport-soak" &&
        Boolean(record.targets?.includes("relay")) &&
        Boolean(record.targets?.includes("direct-cdp"))
      ),
      missingSummary: "No relay + direct-cdp transport soak run has been recorded.",
    }),
    buildReadinessGate({
      gateId: "soak-series",
      title: "Acceptance/realworld/soak series",
      commandHint:
        "soak-series 3 acceptance:phase1-production-closure realworld:phase1-production-closure-runbook soak:phase1-production-closure-long-chain",
      record: findLatestRecord(records, (record) =>
        record.runType === "soak-series" &&
        Boolean(record.selectors?.some((selector) => selector.startsWith("acceptance"))) &&
        Boolean(record.selectors?.some((selector) => selector.startsWith("realworld"))) &&
        Boolean(record.selectors?.some((selector) => selector.startsWith("soak")))
      ),
      missingSummary: "No acceptance + realworld + soak series run has been recorded.",
    }),
  ];

  const failedGates = gates.filter((gate) => gate.status === "failed").length;
  const missingGates = gates.filter((gate) => gate.status === "missing").length;
  const passedGates = gates.filter((gate) => gate.status === "passed").length;
  const status: ValidationOpsReport["readiness"]["status"] =
    failedGates > 0 ? "failed" : missingGates > 0 ? "missing" : "passed";
  const nextGate = gates.find((gate) => gate.status === "failed") ?? gates.find((gate) => gate.status === "missing");

  return {
    status,
    passedGates,
    failedGates,
    missingGates,
    nextCommand: nextGate?.commandHint ?? "validation-ops",
    summary:
      status === "passed"
        ? "Phase 1 exit gates have passing recorded validation runs."
        : `Phase 1 exit gates need attention: failed=${failedGates} missing=${missingGates}.`,
    gates,
  };
}

function buildReadinessGate(input: {
  gateId: ValidationOpsReport["readiness"]["gates"][number]["gateId"];
  title: string;
  commandHint: string;
  record: ValidationOpsRunRecord | undefined;
  missingSummary: string;
}): ValidationOpsReport["readiness"]["gates"][number] {
  if (!input.record) {
    return {
      gateId: input.gateId,
      title: input.title,
      status: "missing",
      summary: input.missingSummary,
      commandHint: input.commandHint,
    };
  }

  return {
    gateId: input.gateId,
    title: input.title,
    status: input.record.status,
    summary: `${input.record.title} ${input.record.status} with ${input.record.issueCount} issue(s).`,
    commandHint: input.commandHint,
    latestRunId: input.record.runId,
    recordedAt: input.record.completedAt,
  };
}

function findLatestRecord(
  records: ValidationOpsRunRecord[],
  predicate: (record: ValidationOpsRunRecord) => boolean
): ValidationOpsRunRecord | undefined {
  let latest: ValidationOpsRunRecord | undefined;
  for (const record of records) {
    if (!predicate(record)) {
      continue;
    }
    if (!latest || record.completedAt > latest.completedAt) {
      latest = record;
    }
  }
  return latest;
}

function buildValidationOpsIssue(input: {
  issueId: string;
  kind: ValidationProfileIssue["kind"] | "release-check" | "soak-suite" | "transport-target";
  scope: string;
  summary: string;
  commandHint: string;
}): ValidationOpsIssueRecord {
  const bucket = deriveValidationOpsBucket(input.kind, input.scope);
  const severity = deriveValidationIssueSeverity(input.kind, bucket);
  const recommendedAction = deriveValidationRecommendedAction(input.kind);

  return {
    issueId: input.issueId,
    kind: input.kind,
    scope: input.scope,
    summary: input.summary,
    bucket,
    severity,
    recommendedAction,
    commandHint: input.commandHint,
  };
}

function deriveValidationOpsBucket(
  kind: ValidationOpsIssueRecord["kind"],
  scope: string
): ValidationOpsFailureBucket {
  if (kind === "release-check") {
    return "release";
  }
  if (kind === "soak-suite") {
    return "soak";
  }
  if (kind === "transport-target") {
    return "transport";
  }

  const suiteId = scope.split(":")[0];
  switch (suiteId) {
    case "regression":
    case "soak":
    case "failure":
      return "validation";
    case "acceptance":
      return "operator";
    case "realworld":
      return "browser";
    default:
      return "validation";
  }
}

function deriveValidationIssueSeverity(
  kind: ValidationOpsIssueRecord["kind"],
  bucket: ValidationOpsFailureBucket
): ValidationOpsIssueSeverity {
  if (kind === "release-check") {
    return "critical";
  }
  if (kind === "soak-suite") {
    return bucket === "soak" ? "warning" : "critical";
  }
  if (kind === "transport-target") {
    return "critical";
  }
  return bucket === "operator" || bucket === "browser" ? "critical" : "warning";
}

function deriveValidationRecommendedAction(kind: ValidationOpsIssueRecord["kind"]): ValidationOpsRecommendedAction {
  switch (kind) {
    case "release-check":
      return "rerun-release";
    case "soak-suite":
      return "rerun-soak";
    case "transport-target":
      return "rerun-transport-soak";
    case "validation-item":
    default:
      return "rerun-profile";
  }
}

function compareValidationIssueSeverity(
  left: ValidationOpsIssueSeverity,
  right: ValidationOpsIssueSeverity
): number {
  const rank = (value: ValidationOpsIssueSeverity) => (value === "critical" ? 0 : 1);
  return rank(left) - rank(right);
}
