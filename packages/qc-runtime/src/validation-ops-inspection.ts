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
      return buildValidationOpsIssue({
        issueId: `${input.runId}:${aggregate.target}`,
        kind: "transport-target",
        scope: aggregate.target,
        summary: `${aggregate.target} transport soak failed ${aggregate.failedCycles}/${aggregate.cycles} cycles (${bucketSummary})`,
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
  };
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
