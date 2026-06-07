import type {
  Phase1BaselineRunResult,
  ValidationOpsFailureBucket,
  ValidationOpsClosedLoopReport,
  ValidationOpsIssueRecord,
  ValidationOpsIssueSeverity,
  ValidationOpsRecommendedAction,
  ValidationOpsReport,
  ValidationOpsRealAcceptanceDetails,
  ValidationOpsRunRecord,
} from "@turnkeyai/core-types/team";

import type { ReleaseReadinessResult } from "./release-readiness";
import type { BrowserTransportSoakResult } from "./browser-transport-soak";
import type { ValidationProfileIssue, ValidationProfileRunResult } from "./validation-profile";
import type { ValidationSoakSeriesResult } from "./validation-soak-series";
import { buildClosedLoopMetric, mergeClosedLoopMetrics } from "./closed-loop-metrics";
import {
  DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_TOOLUSE_NON_BROWSER_SCENARIOS,
} from "./real-llm-acceptance-defaults";

const PHASE1_BASELINE_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

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
  const closedLoop = mergeClosedLoopMetrics(
    input.result.stages.map((stage) =>
      stage.stageId === "validation-run" || stage.stageId === "soak-series" ? stage.result.closedLoop : undefined
    ),
    `validation-profile-run ${input.result.profileId}`
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
    ...(closedLoop ? { closedLoop } : {}),
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
    ...(input.result.closedLoop ? { closedLoop: input.result.closedLoop } : {}),
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

export function buildValidationOpsRecordFromPhase1Baseline(input: {
  runId: string;
  startedAt: number;
  completedAt: number;
  result: Phase1BaselineRunResult;
}): ValidationOpsRunRecord {
  const commandHint = buildPhase1BaselineCommand(
    input.result.requiredRuns,
    input.result.transportCycles,
    input.result.soakCycles,
    input.result.releaseSkipBuild
  );
  const issues = input.result.status === "failed"
    ? [
        buildValidationOpsIssue({
          issueId: `${input.runId}:phase1-baseline`,
          kind: "baseline-run",
          scope: "phase1-baseline",
          summary: `Phase 1 baseline failed ${input.result.consecutivePassedRuns}/${input.result.requiredRuns} clean runs`,
          commandHint,
        }),
      ]
    : [];

  return {
    runId: input.runId,
    runType: "phase1-baseline",
    title: "Phase 1 baseline",
    status: input.result.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.completedAt - input.startedAt,
    issueCount: issues.length,
    issues,
    baseline: {
      requiredRuns: input.result.requiredRuns,
      consecutivePassedRuns: input.result.consecutivePassedRuns,
      transportCycles: input.result.transportCycles,
      soakCycles: input.result.soakCycles,
      releaseSkipBuild: input.result.releaseSkipBuild,
      nextCommand: input.result.nextCommand,
      finalReadinessStatus: input.result.validationOps.readiness.status,
      finalClosedLoopStatus: input.result.northStar.closedLoopStatus,
      finalClosedLoopRate: input.result.northStar.closedLoopRate,
      finalClosedLoopCases: input.result.northStar.closedLoopCases,
      finalTotalCases: input.result.northStar.totalCases,
      silentFailureCases: input.result.northStar.silentFailureCases,
      ambiguousFailureCases: input.result.northStar.ambiguousFailureCases,
      failureReasons: [...input.result.failureReasons],
    },
  };
}

export function buildValidationOpsRecordFromRealLlmAcceptance(input: {
  runId: string;
  startedAt: number;
  completedAt: number;
  status: "passed" | "failed";
  tooluseScenarios: string[];
  missionScenarios: string[];
  naturalMissionScenarios?: string[];
  browserTooluseEnabled: boolean;
  tooluseArtifactPath?: string;
  artifactPath?: string;
  naturalArtifactPath?: string;
  tooluseReport?: ValidationOpsRealAcceptanceDetails["tooluseReport"];
  missionReport?: ValidationOpsRealAcceptanceDetails["missionReport"];
  naturalMissionReport?: ValidationOpsRealAcceptanceDetails["naturalMissionReport"];
  error?: string;
}): ValidationOpsRunRecord {
  const naturalMissionScenarios = input.naturalMissionScenarios ?? [];
  const totalCases = input.tooluseScenarios.length + input.missionScenarios.length + naturalMissionScenarios.length;
  const commandHint = "npm run acceptance:real -- --model-catalog models.local.json";
  const releaseCoverage = buildRealAcceptanceReleaseCoverage({
    tooluseScenarios: input.tooluseScenarios,
    missionScenarios: input.missionScenarios,
    naturalMissionScenarios,
    browserTooluseEnabled: input.browserTooluseEnabled,
  });
  const issues = input.status === "failed"
    ? [
        buildValidationOpsIssue({
          issueId: `${input.runId}:real-llm-acceptance`,
          kind: "real-llm-gate",
          scope: "real-llm-acceptance",
          summary: input.error ? `Real LLM acceptance failed: ${input.error}` : "Real LLM acceptance failed.",
          commandHint,
        }),
      ]
    : [];

  return {
    runId: input.runId,
    runType: "real-llm-acceptance",
    title: "Real LLM acceptance",
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.completedAt - input.startedAt,
    issueCount: issues.length,
    ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
    realAcceptance: {
      tooluseScenarios: [...input.tooluseScenarios],
      missionScenarios: [...input.missionScenarios],
      ...(naturalMissionScenarios.length ? { naturalMissionScenarios: [...naturalMissionScenarios] } : {}),
      browserTooluseEnabled: input.browserTooluseEnabled,
      totalCases,
      releaseCoverage,
      ...(input.tooluseArtifactPath ? { tooluseArtifactPath: input.tooluseArtifactPath } : {}),
      ...(input.naturalArtifactPath ? { naturalArtifactPath: input.naturalArtifactPath } : {}),
      ...(input.tooluseReport ? { tooluseReport: input.tooluseReport } : {}),
      ...(input.missionReport ? { missionReport: input.missionReport } : {}),
      ...(input.naturalMissionReport ? { naturalMissionReport: input.naturalMissionReport } : {}),
    },
    selectors: [
      ...input.tooluseScenarios.map((scenario) => `tooluse:${scenario}`),
      ...input.missionScenarios.map((scenario) => `mission:${scenario}`),
      ...naturalMissionScenarios.map((scenario) => `natural-mission:${scenario}`),
      input.browserTooluseEnabled ? "browser-tooluse" : "browser-tooluse-skipped",
    ],
    closedLoop: buildClosedLoopMetric({
      closedLoopStatus: input.status === "passed" ? "completed" : "actionable",
      rerunCommand: commandHint,
      totalCases,
      ...(input.status === "passed"
        ? {}
        : {
            manualGateReason: input.error ?? "Real LLM acceptance failed; inspect the failing scenario output.",
            failureBucket: "llm",
          }),
    }),
    issues,
  };
}

function buildRealAcceptanceReleaseCoverage(input: {
  tooluseScenarios: string[];
  missionScenarios: string[];
  naturalMissionScenarios: string[];
  browserTooluseEnabled: boolean;
}): NonNullable<ValidationOpsRealAcceptanceDetails["releaseCoverage"]> {
  const tooluseExpected = input.browserTooluseEnabled
    ? DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS
    : DEFAULT_REAL_ACCEPTANCE_TOOLUSE_NON_BROWSER_SCENARIOS;
  const tooluse = buildScenarioCoverage(input.tooluseScenarios, tooluseExpected);
  const mission = buildScenarioCoverage(input.missionScenarios, DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS);
  const naturalMission = buildScenarioCoverage(
    input.naturalMissionScenarios,
    DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS
  );
  return {
    status: summarizeReleaseCoverageStatus([tooluse.status, mission.status, naturalMission.status]),
    tooluse,
    mission,
    naturalMission,
  };
}

function buildScenarioCoverage(
  requested: readonly string[],
  expected: readonly string[]
): NonNullable<ValidationOpsRealAcceptanceDetails["releaseCoverage"]>["tooluse"] {
  const requestedSet = new Set(requested);
  const missing = expected.filter((scenario) => !requestedSet.has(scenario)).length;
  const covered = expected.length - missing;
  return {
    status: requested.length === 0 ? "skipped" : missing === 0 ? "full" : "focused",
    requested: covered,
    expected: expected.length,
    missing,
  };
}

function summarizeReleaseCoverageStatus(
  statuses: Array<NonNullable<ValidationOpsRealAcceptanceDetails["releaseCoverage"]>["status"]>
): NonNullable<ValidationOpsRealAcceptanceDetails["releaseCoverage"]>["status"] {
  if (statuses.every((status) => status === "full")) return "full";
  if (statuses.every((status) => status === "skipped")) return "skipped";
  return "focused";
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

export function buildValidationOpsReport(records: ValidationOpsRunRecord[], limit = 10, now = Date.now()): ValidationOpsReport {
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
    closedLoop: buildValidationOpsClosedLoopReport(latestRuns),
    baseline: buildPhase1BaselineReport(records, now),
  };
}

function buildValidationOpsClosedLoopReport(records: ValidationOpsRunRecord[]): ValidationOpsClosedLoopReport {
  const measuredRecords = records.filter((record) => record.closedLoop);
  const latestMeasuredRecord = measuredRecords[0];
  const aggregate = mergeClosedLoopMetrics(
    measuredRecords.map((record) => record.closedLoop),
    "phase1-readiness 3 3"
  ) ?? buildClosedLoopMetric({ closedLoopStatus: "completed", rerunCommand: "phase1-readiness 3 3", totalCases: 0 });
  const highestPriorityRecord = [...measuredRecords]
    .sort((left, right) => compareClosedLoopStatus(left.closedLoop!.closedLoopStatus, right.closedLoop!.closedLoopStatus))
    .at(-1);
  const statusCounts: ValidationOpsClosedLoopReport["statusCounts"] = {};
  for (const record of measuredRecords) {
    const status = record.closedLoop!.closedLoopStatus;
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  return {
    ...aggregate,
    measuredRuns: measuredRecords.length,
    statusCounts,
    nextCommand: highestPriorityRecord?.closedLoop?.closedLoopStatus === "completed"
      ? "validation-ops"
      : highestPriorityRecord?.closedLoop?.rerunCommand ?? aggregate.rerunCommand,
    ...(latestMeasuredRecord ? { latestRunId: latestMeasuredRecord.runId } : {}),
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
    buildRealLlmAcceptanceReadinessGate(records),
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

function buildRealLlmAcceptanceReadinessGate(records: ValidationOpsRunRecord[]): ValidationOpsReport["readiness"]["gates"][number] {
  const commandHint = "npm run acceptance:real -- --model-catalog models.local.json";
  const latestRecord = findLatestRecord(records, (record) => record.runType === "real-llm-acceptance");

  if (!latestRecord) {
    return {
      gateId: "real-llm-acceptance",
      title: "Real LLM acceptance",
      status: "missing",
      summary: "No real LLM acceptance run has been recorded.",
      commandHint,
    };
  }
  if (latestRecord.status === "failed") {
    return buildReadinessGate({
      gateId: "real-llm-acceptance",
      title: "Real LLM acceptance",
      commandHint,
      record: latestRecord,
      missingSummary: "No real LLM acceptance run has been recorded.",
    });
  }

  const latestProvenFullRecord = findLatestRecord(
    records,
    (record) => record.runType === "real-llm-acceptance" && hasProvenFullRealAcceptance(record)
  );
  const record = latestProvenFullRecord ?? latestRecord;

  const coverage = record.realAcceptance?.releaseCoverage;
  if (hasProvenFullRealAcceptance(record)) {
    return {
      gateId: "real-llm-acceptance",
      title: "Real LLM acceptance",
      status: "passed",
      summary: `${record.title} passed with full release coverage (${formatReleaseCoverageSummary(coverage)}).`,
      commandHint,
      latestRunId: record.runId,
      recordedAt: record.completedAt,
    };
  }

  const evidenceGap = coverage?.status === "full" && hasCompleteReleaseCoverage(coverage)
    ? "full release coverage is recorded, but acceptance report evidence is incomplete"
    : coverage
      ? `only ${coverage.status} coverage is recorded`
      : "release coverage metadata is missing";
  return {
    gateId: "real-llm-acceptance",
    title: "Real LLM acceptance",
    status: "missing",
    summary: coverage
      ? `${record.title} passed, but ${evidenceGap} (${formatReleaseCoverageSummary(coverage)}).`
      : `${record.title} passed, but ${evidenceGap}.`,
    commandHint,
    latestRunId: record.runId,
    recordedAt: record.completedAt,
  };
}

function hasProvenFullRealAcceptance(record: ValidationOpsRunRecord): boolean {
  if (record.status !== "passed") return false;
  const details = record.realAcceptance;
  if (!details?.releaseCoverage || details.releaseCoverage.status !== "full") return false;
  if (!hasCompleteReleaseCoverage(details.releaseCoverage)) return false;
  if (!hasProvenToolUseAcceptanceReport(details)) return false;
  if (!hasProvenMissionAcceptanceReport(record, details)) return false;
  if (!hasProvenNaturalMissionAcceptanceReport(details)) return false;
  return true;
}

function hasProvenToolUseAcceptanceReport(details: ValidationOpsRealAcceptanceDetails): boolean {
  const scenarios = details.tooluseScenarios;
  if (scenarios.length === 0) return true;
  const report = details.tooluseReport;
  if (!details.tooluseArtifactPath || !report) return false;
  const aggregateProven =
    report.status === "passed" &&
    report.scenarioCount === scenarios.length &&
    report.passedScenarios === report.scenarioCount &&
    report.failedScenarios === 0 &&
    report.qualityFailures === 0 &&
    report.toolCalls >= report.scenarioCount &&
    sameStringMultiset(scenarios, report.scenarioIds ?? []);
  if (!aggregateProven) {
    return false;
  }
  const proofQueuesByScenario = buildToolUseProofQueues(report);
  return scenarios.every((scenario) => hasProvenToolUseScenario(scenario, proofQueuesByScenario.get(scenario)?.shift()));
}

function hasProvenToolUseScenario(
  scenario: string,
  proof: NonNullable<NonNullable<ValidationOpsRealAcceptanceDetails["tooluseReport"]>["scenarioProofs"]>[number] | undefined
): boolean {
  if (!proof?.passed || proof.qualityFailures > 0 || proof.finalBytes <= 0 || proof.evidenceBullets <= 0) {
    return false;
  }
  if (!proof.toolCallNames.includes("sessions_spawn")) {
    return false;
  }
  if (proof.sessionsSpawned < 1) {
    return false;
  }
  if (scenario === "approval") {
    return (
      proof.toolCallNames.includes("permission_query") &&
      proof.toolCallNames.includes("permission_result") &&
      proof.toolCallNames.includes("permission_applied") &&
      proof.permissionEvents >= 3
    );
  }
  if (scenario === "followup") {
    return proof.toolCallNames.includes("sessions_send") && proof.sessionsSpawned === 1 && proof.childTranscriptMessages >= 4;
  }
  if (scenario === "timeout") {
    return proof.sessionsSpawned === 1;
  }
  if (scenario === "complex") {
    return proof.sessionsSpawned >= 2 && proof.childTranscriptMessages >= 4;
  }
  return true;
}

function buildToolUseProofQueues(
  report: NonNullable<ValidationOpsRealAcceptanceDetails["tooluseReport"]>
): Map<
  string,
  Array<NonNullable<NonNullable<ValidationOpsRealAcceptanceDetails["tooluseReport"]>["scenarioProofs"]>[number]>
> {
  const queues = new Map<
    string,
    Array<NonNullable<NonNullable<ValidationOpsRealAcceptanceDetails["tooluseReport"]>["scenarioProofs"]>[number]>
  >();
  for (const proof of report.scenarioProofs ?? []) {
    const queue = queues.get(proof.scenario) ?? [];
    queue.push(proof);
    queues.set(proof.scenario, queue);
  }
  return queues;
}

function hasProvenMissionAcceptanceReport(
  record: ValidationOpsRunRecord,
  details: ValidationOpsRealAcceptanceDetails
): boolean {
  const scenarios = details.missionScenarios;
  if (scenarios.length === 0) return true;
  const report = details.missionReport;
  if (!record.artifactPath || !report) return false;
  const aggregateProven =
    report.status === "passed" &&
    report.scenarioCount === scenarios.length &&
    report.passedScenarios === report.scenarioCount &&
    report.failedScenarios === 0 &&
    report.qualityFailures === 0 &&
    report.qualityCheckFailures === 0 &&
    report.livenessActive === 0 &&
    report.livenessWaiting === 0 &&
    report.livenessStale === 0 &&
    report.evidenceEvents >= report.scenarioCount &&
    sameStringMultiset(scenarios, report.scenarioIds ?? []);
  if (!aggregateProven) {
    return false;
  }
  const proofQueuesByScenario = buildMissionProofQueues(report);
  return scenarios.every((scenario) => hasProvenMissionScenario(scenario, proofQueuesByScenario.get(scenario)?.shift()));
}

function hasProvenMissionScenario(
  scenario: string,
  proof: NonNullable<NonNullable<ValidationOpsRealAcceptanceDetails["missionReport"]>["scenarioProofs"]>[number] | undefined
): boolean {
  return Boolean(
    proof?.scenario === scenario &&
      proof.passed &&
      proof.qualityFailures === 0 &&
      proof.qualityCheckFailures === 0 &&
      proof.sourceCoverageFailures === 0 &&
      proof.browserProfileFallbacks === 0 &&
      proof.browserFailureBuckets === 0 &&
      proof.livenessActive === 0 &&
      proof.livenessWaiting === 0 &&
      proof.livenessStale === 0 &&
      proof.evidenceEvents >= 1 &&
      hasExpectedMissionScenarioSignals(scenario, proof)
  );
}

function hasExpectedMissionScenarioSignals(
  scenario: string,
  proof: NonNullable<NonNullable<ValidationOpsRealAcceptanceDetails["missionReport"]>["scenarioProofs"]>[number]
): boolean {
  if (scenario === "approval") {
    return (
      proof.sessionsSpawned >= 1 &&
      proof.approvalsRequested >= 1 &&
      proof.approvalsDecided >= 1 &&
      proof.approvalsApplied >= 1
    );
  }
  if (scenario === "followup") {
    return proof.sessionsContinued >= 1;
  }
  if (scenario === "cancel") {
    return proof.toolCancelled >= 1 && proof.toolTimeouts === 0;
  }
  if (scenario === "timeout-recovery") {
    return proof.sessionsSpawned >= 1 && proof.toolFailed >= 1 && proof.toolTimeouts >= 1 && proof.toolCancelled === 0;
  }
  if (scenario === "browser-dynamic" || scenario === "browser-dashboard") {
    return proof.sessionsSpawned >= 1 && proof.toolResults >= 1;
  }
  if (scenario === "memory-recall") {
    return proof.sessionsSpawned === 0 && proof.toolResults >= 2;
  }
  if (scenario === "task-tracking") {
    return proof.sessionsSpawned === 0 && proof.toolResults >= 3;
  }
  if (scenario === "realistic-brief" || scenario === "product-workbench-brief") {
    return proof.sessionsSpawned >= 3 && proof.toolResults >= 3;
  }
  return proof.toolResults >= 1;
}

function buildMissionProofQueues(
  report: NonNullable<ValidationOpsRealAcceptanceDetails["missionReport"]>
): Map<
  string,
  Array<NonNullable<NonNullable<ValidationOpsRealAcceptanceDetails["missionReport"]>["scenarioProofs"]>[number]>
> {
  const queues = new Map<
    string,
    Array<NonNullable<NonNullable<ValidationOpsRealAcceptanceDetails["missionReport"]>["scenarioProofs"]>[number]>
  >();
  for (const proof of report.scenarioProofs ?? []) {
    const queue = queues.get(proof.scenario) ?? [];
    queue.push(proof);
    queues.set(proof.scenario, queue);
  }
  return queues;
}

function hasProvenNaturalMissionAcceptanceReport(details: ValidationOpsRealAcceptanceDetails): boolean {
  const scenarios = details.naturalMissionScenarios ?? [];
  if (scenarios.length === 0) return true;
  const report = details.naturalMissionReport;
  if (!details.naturalArtifactPath || !report) return false;
  const aggregateProven =
    report.status === "passed" &&
    report.scenarioCount === scenarios.length &&
    report.passedScenarios === report.scenarioCount &&
    report.failedScenarios === 0 &&
    report.completed === report.scenarioCount &&
    report.reasonableToolUse === report.scenarioCount &&
    report.subAgentCompleted === report.scenarioCount &&
    report.finalAnswerHasEvidence === report.scenarioCount &&
    report.finalAnswerUseful === report.scenarioCount &&
    report.stuckOrLoop === 0 &&
    report.livenessActive === 0 &&
    report.livenessWaiting === 0 &&
    report.livenessStale === 0 &&
    report.evidenceEvents >= report.scenarioCount &&
    sameStringMultiset(scenarios, report.scenarioIds ?? []);
  if (!aggregateProven) {
    return false;
  }
  const proofQueuesByScenario = buildNaturalProofQueues(report);
  return scenarios.every((scenario) => hasProvenNaturalMissionScenario(scenario, proofQueuesByScenario.get(scenario)?.shift()));
}

function hasProvenNaturalMissionScenario(
  scenario: string,
  proof: NonNullable<NonNullable<ValidationOpsRealAcceptanceDetails["naturalMissionReport"]>["scenarioProofs"]>[number] | undefined
): boolean {
  if (
    !proof?.passed ||
    !proof.completed ||
    proof.stuckOrLoop ||
    !proof.reasonableToolUse ||
    !proof.subAgentCompleted ||
    !proof.finalAnswerHasEvidence ||
    !proof.finalAnswerUseful ||
    proof.livenessActive > 0 ||
    proof.livenessWaiting > 0 ||
    proof.livenessStale > 0 ||
    proof.evidenceEvents < 1 ||
    !proof.sourceResidualRiskVisible ||
    proof.sourceUnsupportedClaims > 0 ||
    proof.sourceAnswerTermsMissing > 0 ||
    proof.sourceAnswerPatternsMissing > 0 ||
    proof.sourceEvidencePatternsMissing > 0 ||
    (scenario !== "natural-browser-profile-lock-recovery" && proof.browserProfileFallbacks > 0)
  ) {
    return false;
  }
  if (isNaturalBrowserActiveScenario(scenario)) {
    if (!proof.browserUsed || proof.sessionsSpawned < 1) {
      return false;
    }
  }
  if (scenario === "natural-approval-dry-run-action") {
    return (
      proof.approvalExercised &&
      proof.approvalsRequested >= 1 &&
      proof.approvalsDecided >= 1 &&
      proof.approvalsApplied >= 1
    );
  }
  if (
    scenario === "natural-approval-denied-safe-closeout" ||
    scenario === "natural-approval-pending-state" ||
    scenario === "natural-approval-wait-timeout-closeout"
  ) {
    return proof.approvalExercised && proof.approvalsRequested >= 1;
  }
  if (scenario.includes("followup") || scenario.includes("continuation")) {
    if (proof.sessionsSpawned < 1 || proof.sessionsContinued < 1) {
      return false;
    }
  }
  if (scenario === "natural-long-delegation") {
    if (proof.sessionsSpawned < 2) {
      return false;
    }
  }
  if (scenario === "natural-browser-profile-lock-recovery" && proof.browserProfileFallbacks < 1) {
    return false;
  }
  if (scenario.includes("timeout")) {
    if (proof.toolFailed < 1 || proof.toolTimeouts < 1) {
      return false;
    }
  }
  if (scenario.includes("cancel")) {
    if (proof.toolCancelled < 1) {
      return false;
    }
  }
  if (isNaturalBrowserFailureCloseoutScenario(scenario)) {
    if (proof.browserFailureBuckets < 1 || proof.recoveryEvents < 1) {
      return false;
    }
  }
  return true;
}

function isNaturalBrowserActiveScenario(scenario: string): boolean {
  return scenario.startsWith("natural-browser-") && !isNaturalBrowserFailureCloseoutScenario(scenario);
}

function isNaturalBrowserFailureCloseoutScenario(scenario: string): boolean {
  return (
    scenario === "natural-browser-unavailable-closeout" ||
    scenario === "natural-browser-cdp-timeout-closeout" ||
    scenario === "natural-browser-detached-target-closeout" ||
    scenario === "natural-browser-attach-failed-closeout"
  );
}

function buildNaturalProofQueues(
  report: NonNullable<ValidationOpsRealAcceptanceDetails["naturalMissionReport"]>
): Map<
  string,
  Array<NonNullable<NonNullable<ValidationOpsRealAcceptanceDetails["naturalMissionReport"]>["scenarioProofs"]>[number]>
> {
  const queues = new Map<
    string,
    Array<NonNullable<NonNullable<ValidationOpsRealAcceptanceDetails["naturalMissionReport"]>["scenarioProofs"]>[number]>
  >();
  for (const proof of report.scenarioProofs ?? []) {
    const queue = queues.get(proof.scenario) ?? [];
    queue.push(proof);
    queues.set(proof.scenario, queue);
  }
  return queues;
}

function sameStringMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const value of left) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  for (const value of right) {
    const count = counts.get(value);
    if (!count) return false;
    if (count === 1) {
      counts.delete(value);
    } else {
      counts.set(value, count - 1);
    }
  }
  return counts.size === 0;
}

function hasCompleteReleaseCoverage(
  coverage: ValidationOpsRealAcceptanceDetails["releaseCoverage"] | undefined
): coverage is NonNullable<ValidationOpsRealAcceptanceDetails["releaseCoverage"]> {
  return Boolean(coverage?.tooluse && coverage.mission && coverage.naturalMission);
}

function formatReleaseCoverageSummary(
  coverage: NonNullable<ValidationOpsRealAcceptanceDetails["releaseCoverage"]> | undefined
): string {
  if (!coverage) return "no coverage";
  return [
    `tool-use ${formatScenarioCoverageSummary(coverage.tooluse)}`,
    `mission ${formatScenarioCoverageSummary(coverage.mission)}`,
    `natural ${formatScenarioCoverageSummary(coverage.naturalMission)}`,
  ].join("; ");
}

function formatScenarioCoverageSummary(
  coverage: NonNullable<ValidationOpsRealAcceptanceDetails["releaseCoverage"]>["tooluse"] | undefined
): string {
  if (!coverage) return "0/0";
  const requested = Number.isFinite(coverage.requested) ? coverage.requested : 0;
  const expected = Number.isFinite(coverage.expected) ? coverage.expected : 0;
  const missing = Number.isFinite(coverage.missing) ? coverage.missing : 0;
  return `${requested}/${expected}${missing > 0 ? ` missing ${missing}` : ""}`;
}

function buildPhase1BaselineReport(records: ValidationOpsRunRecord[], now: number): ValidationOpsReport["baseline"] {
  const latestBaselineRecord = findLatestRecord(
    records,
    (record) => record.runType === "phase1-baseline" && record.baseline !== undefined
  );
  if (!latestBaselineRecord?.baseline) {
    return {
      status: "missing",
      summary: "No Phase 1 baseline has been recorded.",
      nextCommand: buildPhase1BaselineCommand(3, 3, 3, false),
      staleAfterMs: PHASE1_BASELINE_STALE_AFTER_MS,
    };
  }

  const baseline = latestBaselineRecord.baseline;
  const ageMs = Math.max(0, now - latestBaselineRecord.completedAt);
  const rerunCommand = buildPhase1BaselineCommand(
    baseline.requiredRuns,
    baseline.transportCycles,
    baseline.soakCycles,
    baseline.releaseSkipBuild
  );
  const baseReport = {
    staleAfterMs: PHASE1_BASELINE_STALE_AFTER_MS,
    latestRunId: latestBaselineRecord.runId,
    recordedAt: latestBaselineRecord.completedAt,
    ageMs,
    requiredRuns: baseline.requiredRuns,
    consecutivePassedRuns: baseline.consecutivePassedRuns,
    transportCycles: baseline.transportCycles,
    soakCycles: baseline.soakCycles,
    releaseSkipBuild: baseline.releaseSkipBuild,
    finalReadinessStatus: baseline.finalReadinessStatus,
    finalClosedLoopStatus: baseline.finalClosedLoopStatus,
    finalClosedLoopRate: baseline.finalClosedLoopRate,
    finalClosedLoopCases: baseline.finalClosedLoopCases,
    finalTotalCases: baseline.finalTotalCases,
    silentFailureCases: baseline.silentFailureCases,
    ambiguousFailureCases: baseline.ambiguousFailureCases,
    failureReasons: [...baseline.failureReasons],
  };

  if (ageMs > PHASE1_BASELINE_STALE_AFTER_MS) {
    const underlyingStatusSummary = latestBaselineRecord.status === "failed"
      ? `previous run failed ${baseline.consecutivePassedRuns}/${baseline.requiredRuns} clean runs`
      : `previous run passed ${baseline.consecutivePassedRuns}/${baseline.requiredRuns} clean runs`;
    return {
      status: "stale",
      summary: `Latest Phase 1 baseline is stale (ageMs=${ageMs}; ${underlyingStatusSummary}).`,
      nextCommand: rerunCommand,
      ...baseReport,
    };
  }

  if (latestBaselineRecord.status === "failed") {
    return {
      status: "fresh-failing",
      summary: `Latest Phase 1 baseline failed ${baseline.consecutivePassedRuns}/${baseline.requiredRuns} clean runs.`,
      nextCommand: rerunCommand,
      ...baseReport,
    };
  }

  return {
    status: "fresh-passing",
    summary: `Latest Phase 1 baseline passed ${baseline.consecutivePassedRuns}/${baseline.requiredRuns} clean runs.`,
    nextCommand: "validation-ops",
    ...baseReport,
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
  kind: ValidationOpsIssueRecord["kind"];
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
  if (kind === "baseline-run") {
    return "baseline";
  }
  if (kind === "real-llm-gate") {
    return "llm";
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
  if (kind === "baseline-run") {
    return "critical";
  }
  if (kind === "real-llm-gate") {
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
    case "baseline-run":
      return "rerun-baseline";
    case "real-llm-gate":
      return "rerun-real-acceptance";
    case "validation-item":
    default:
      return "rerun-profile";
  }
}

function buildPhase1BaselineCommand(
  runs: number,
  transportCycles: number,
  soakCycles: number,
  releaseSkipBuild: boolean
): string {
  const command = `phase1-baseline ${runs} ${transportCycles} ${soakCycles}`;
  return releaseSkipBuild ? `${command} --release-skip-build` : command;
}

function compareValidationIssueSeverity(
  left: ValidationOpsIssueSeverity,
  right: ValidationOpsIssueSeverity
): number {
  const rank = (value: ValidationOpsIssueSeverity) => (value === "critical" ? 0 : 1);
  return rank(left) - rank(right);
}

function compareClosedLoopStatus(
  left: ValidationOpsClosedLoopReport["closedLoopStatus"],
  right: ValidationOpsClosedLoopReport["closedLoopStatus"]
): number {
  const rank: Record<ValidationOpsClosedLoopReport["closedLoopStatus"], number> = {
    completed: 0,
    actionable: 1,
    ambiguous_failure: 2,
    silent_failure: 3,
  };
  return rank[left] - rank[right];
}
