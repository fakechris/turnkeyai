import type { ValidationOpsRealAcceptanceDetails } from "@turnkeyai/core-types/team";

type MissionReportSummary = NonNullable<ValidationOpsRealAcceptanceDetails["missionReport"]>;
type NaturalMissionReportSummary = NonNullable<ValidationOpsRealAcceptanceDetails["naturalMissionReport"]>;
type ToolUseReportSummary = NonNullable<ValidationOpsRealAcceptanceDetails["tooluseReport"]>;

const FORCED_TOOL_LOOP_CLOSEOUT_REASONS = new Set([
  "pseudo_tool_call",
  "wall_clock_budget",
  "round_limit",
  "sub_agent_timeout",
  "repeated_tool_failure",
]);

interface MissionScenarioReportShape {
  scenario?: unknown;
  status?: unknown;
  qualityGate?: unknown;
  metrics?: {
    tools?: {
      requested?: unknown;
      results?: unknown;
      failed?: unknown;
      cancelled?: unknown;
      timeouts?: unknown;
    };
    sessions?: {
      spawned?: unknown;
      continued?: unknown;
    };
    browser?: {
      profileFallbacks?: unknown;
      failureBuckets?: unknown;
    };
    approvals?: {
      requested?: unknown;
      decided?: unknown;
      applied?: unknown;
    };
    liveness?: {
      active?: unknown;
      waiting?: unknown;
      stale?: unknown;
    };
    qualityChecks?: unknown;
    evidenceEvents?: unknown;
    recoveryEvents?: unknown;
  };
  final?: {
    qualityFailures?: unknown;
    closeout?: {
      reason?: unknown;
    };
  };
}

interface MissionE2eReportShape {
  kind?: unknown;
  status?: unknown;
  scenarios?: unknown;
}

interface NaturalScenarioReportShape {
  scenario?: unknown;
  natural?: {
    status?: unknown;
    completed?: unknown;
    stuckOrLoop?: unknown;
    reasonableToolUse?: unknown;
    browserUsed?: unknown;
    subAgentCompleted?: unknown;
    approvalExercised?: unknown;
    finalAnswerHasEvidence?: unknown;
    finalAnswerUseful?: unknown;
    sourceCoverage?: {
      answerTerms?: {
        covered?: unknown;
        total?: unknown;
        missing?: unknown;
      };
      answerPatterns?: {
        covered?: unknown;
        total?: unknown;
        missing?: unknown;
      };
      evidencePatterns?: {
        covered?: unknown;
        total?: unknown;
        missing?: unknown;
      };
      evidenceEvents?: {
        observed?: unknown;
        required?: unknown;
      };
      residualRiskVisible?: unknown;
      unsupportedClaims?: unknown;
    };
    weakAnswerSignals?: unknown;
  };
  metrics?: MissionScenarioReportShape["metrics"];
}

interface NaturalMissionE2eReportShape {
  kind?: unknown;
  status?: unknown;
  scenarios?: unknown;
}

interface ToolUseScenarioReportShape {
  scenario?: unknown;
  status?: unknown;
  finalBytes?: unknown;
  evidenceBullets?: unknown;
  qualityFailures?: unknown;
  toolCallNames?: unknown;
  spawnedSessionCount?: unknown;
  childTranscriptMessages?: unknown;
  permissionEvents?: unknown;
}

interface ToolUseE2eReportShape {
  kind?: unknown;
  status?: unknown;
  scenarios?: unknown;
}

export function summarizeToolUseE2eReportForValidationOps(report: unknown): ToolUseReportSummary | null {
  if (!isToolUseE2eReportShape(report) || report.kind !== "turnkeyai.tool-use-e2e.report") {
    return null;
  }
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios.filter(isToolUseScenarioReportShape) : [];
  return scenarios.reduce<ToolUseReportSummary>(
    (summary, scenario) => {
      const scenarioId = readString(scenario.scenario);
      const qualityFailures = readNumber(scenario.qualityFailures);
      const passing = scenario.status === "passed" && qualityFailures === 0;
      const toolCallNames = readStringArray(scenario.toolCallNames);
      if (scenarioId) (summary.scenarioIds ??= []).push(scenarioId);
      summary.passedScenarios += passing ? 1 : 0;
      summary.failedScenarios += passing ? 0 : 1;
      summary.qualityFailures += qualityFailures;
      summary.finalBytes += readNumber(scenario.finalBytes);
      summary.evidenceBullets += readNumber(scenario.evidenceBullets);
      summary.toolCalls += toolCallNames.length;
      summary.sessionsSpawned += readNumber(scenario.spawnedSessionCount);
      summary.childTranscriptMessages += readNumber(scenario.childTranscriptMessages);
      summary.permissionEvents += readArrayLength(scenario.permissionEvents);
      if (scenarioId) {
        (summary.scenarioProofs ??= []).push({
          scenario: scenarioId,
          passed: passing,
          finalBytes: readNumber(scenario.finalBytes),
          evidenceBullets: readNumber(scenario.evidenceBullets),
          qualityFailures,
          toolCallNames,
          sessionsSpawned: readNumber(scenario.spawnedSessionCount),
          childTranscriptMessages: readNumber(scenario.childTranscriptMessages),
          permissionEvents: readArrayLength(scenario.permissionEvents),
        });
      }
      return summary;
    },
    {
      status: report.status === "passed" ? "passed" : "failed",
      scenarioCount: scenarios.length,
      scenarioIds: [],
      passedScenarios: 0,
      failedScenarios: 0,
      qualityFailures: 0,
      finalBytes: 0,
      evidenceBullets: 0,
      toolCalls: 0,
      sessionsSpawned: 0,
      childTranscriptMessages: 0,
      permissionEvents: 0,
      scenarioProofs: [],
    }
  );
}

export function summarizeMissionE2eReportForValidationOps(report: unknown): MissionReportSummary | null {
  if (!isMissionE2eReportShape(report) || report.kind !== "turnkeyai.mission-e2e.report") {
    return null;
  }
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios.filter(isMissionScenarioReportShape) : [];
  if (scenarios.length === 0) {
    return {
      status: report.status === "passed" ? "passed" : "failed",
      scenarioCount: 0,
      scenarioIds: [],
      passedScenarios: 0,
      failedScenarios: 0,
      qualityFailures: 0,
      toolRequested: 0,
      toolResults: 0,
      toolFailed: 0,
      toolCancelled: 0,
      toolTimeouts: 0,
      sessionsSpawned: 0,
      sessionsContinued: 0,
      browserProfileFallbacks: 0,
      browserFailureBuckets: 0,
      approvalsRequested: 0,
      approvalsDecided: 0,
      approvalsApplied: 0,
      livenessActive: 0,
      livenessWaiting: 0,
      livenessStale: 0,
      qualityCheckWarnings: 0,
      qualityCheckFailures: 0,
      sourceCoverageWarnings: 0,
      sourceCoverageFailures: 0,
      evidenceEvents: 0,
      recoveryEvents: 0,
    };
  }

  return scenarios.reduce<MissionReportSummary>(
    (summary, scenario) => {
      const passing = isPassingMissionScenario(scenario);
      const scenarioId = readString(scenario.scenario);
      if (scenarioId) (summary.scenarioIds ??= []).push(scenarioId);
      summary.passedScenarios += passing ? 1 : 0;
      summary.failedScenarios += passing ? 0 : 1;
      summary.qualityFailures += Array.isArray(scenario.final?.qualityFailures)
        ? scenario.final.qualityFailures.length
        : 0;
      summary.toolRequested += readNumber(scenario.metrics?.tools?.requested);
      summary.toolResults += readNumber(scenario.metrics?.tools?.results);
      summary.toolFailed += readNumber(scenario.metrics?.tools?.failed);
      summary.toolCancelled += readNumber(scenario.metrics?.tools?.cancelled);
      summary.toolTimeouts += readNumber(scenario.metrics?.tools?.timeouts);
      summary.sessionsSpawned += readNumber(scenario.metrics?.sessions?.spawned);
      summary.sessionsContinued += readNumber(scenario.metrics?.sessions?.continued);
      summary.browserProfileFallbacks += readNumber(scenario.metrics?.browser?.profileFallbacks);
      summary.browserFailureBuckets += readBrowserFailureBucketCount(scenario.metrics?.browser?.failureBuckets);
      summary.approvalsRequested += readNumber(scenario.metrics?.approvals?.requested);
      summary.approvalsDecided += readNumber(scenario.metrics?.approvals?.decided);
      summary.approvalsApplied += readNumber(scenario.metrics?.approvals?.applied);
      summary.livenessActive += readNumber(scenario.metrics?.liveness?.active);
      summary.livenessWaiting += readNumber(scenario.metrics?.liveness?.waiting);
      summary.livenessStale += readNumber(scenario.metrics?.liveness?.stale);
      const qualityChecks = readQualityChecks(scenario.metrics?.qualityChecks);
      summary.qualityCheckWarnings += qualityChecks.filter((check) => check.status === "warn").length;
      summary.qualityCheckFailures += qualityChecks.filter((check) => isBlockingQualityCheckFailure(scenario, check)).length;
      summary.sourceCoverageWarnings += qualityChecks.filter(
        (check) => check.name === "source_coverage" && check.status === "warn"
      ).length;
      summary.sourceCoverageFailures += qualityChecks.filter(
        (check) => check.name === "source_coverage" && check.status === "fail"
      ).length;
      summary.evidenceEvents += readNumber(scenario.metrics?.evidenceEvents);
      summary.recoveryEvents += readNumber(scenario.metrics?.recoveryEvents);
      return summary;
    },
    {
      status: report.status === "passed" ? "passed" : "failed",
      scenarioCount: scenarios.length,
      scenarioIds: [],
      passedScenarios: 0,
      failedScenarios: 0,
      qualityFailures: 0,
      toolRequested: 0,
      toolResults: 0,
      toolFailed: 0,
      toolCancelled: 0,
      toolTimeouts: 0,
      sessionsSpawned: 0,
      sessionsContinued: 0,
      browserProfileFallbacks: 0,
      browserFailureBuckets: 0,
      approvalsRequested: 0,
      approvalsDecided: 0,
      approvalsApplied: 0,
      livenessActive: 0,
      livenessWaiting: 0,
      livenessStale: 0,
      qualityCheckWarnings: 0,
      qualityCheckFailures: 0,
      sourceCoverageWarnings: 0,
      sourceCoverageFailures: 0,
      evidenceEvents: 0,
      recoveryEvents: 0,
    }
  );
}

export function summarizeNaturalMissionE2eReportForValidationOps(report: unknown): NaturalMissionReportSummary | null {
  if (!isNaturalMissionE2eReportShape(report) || report.kind !== "turnkeyai.natural-mission-e2e.report") {
    return null;
  }
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios.filter(isNaturalScenarioReportShape) : [];
  if (scenarios.length === 0) {
    return {
      status: report.status === "passed" ? "passed" : "failed",
      scenarioCount: 0,
      scenarioIds: [],
      passedScenarios: 0,
      failedScenarios: 0,
      completed: 0,
      stuckOrLoop: 0,
      reasonableToolUse: 0,
      browserUsed: 0,
      subAgentCompleted: 0,
      approvalExercised: 0,
      finalAnswerHasEvidence: 0,
      finalAnswerUseful: 0,
      weakAnswerSignals: 0,
      toolRequested: 0,
      toolResults: 0,
      toolFailed: 0,
      toolCancelled: 0,
      toolTimeouts: 0,
      sessionsSpawned: 0,
      sessionsContinued: 0,
      browserProfileFallbacks: 0,
      browserFailureBuckets: 0,
      approvalsRequested: 0,
      approvalsDecided: 0,
      approvalsApplied: 0,
      livenessActive: 0,
      livenessWaiting: 0,
      livenessStale: 0,
      evidenceEvents: 0,
      sourceAnswerTermsCovered: 0,
      sourceAnswerTermsTotal: 0,
      sourceAnswerTermsMissing: 0,
      sourceAnswerPatternsCovered: 0,
      sourceAnswerPatternsTotal: 0,
      sourceAnswerPatternsMissing: 0,
      sourceEvidencePatternsCovered: 0,
      sourceEvidencePatternsTotal: 0,
      sourceEvidencePatternsMissing: 0,
      sourceEvidenceEventsObserved: 0,
      sourceEvidenceEventsRequired: 0,
      sourceResidualRiskVisible: 0,
      sourceUnsupportedClaims: 0,
      recoveryEvents: 0,
    };
  }

  return scenarios.reduce<NaturalMissionReportSummary>(
    (summary, scenario) => {
      const passing = scenario.natural?.status === "passed";
      const scenarioId = readString(scenario.scenario);
      if (scenarioId) (summary.scenarioIds ??= []).push(scenarioId);
      summary.passedScenarios += passing ? 1 : 0;
      summary.failedScenarios += passing ? 0 : 1;
      summary.completed += scenario.natural?.completed === true ? 1 : 0;
      summary.stuckOrLoop += scenario.natural?.stuckOrLoop === true ? 1 : 0;
      summary.reasonableToolUse += scenario.natural?.reasonableToolUse === true ? 1 : 0;
      summary.browserUsed += scenario.natural?.browserUsed === true ? 1 : 0;
      summary.subAgentCompleted += scenario.natural?.subAgentCompleted === true ? 1 : 0;
      summary.approvalExercised += scenario.natural?.approvalExercised === true ? 1 : 0;
      summary.finalAnswerHasEvidence += scenario.natural?.finalAnswerHasEvidence === true ? 1 : 0;
      summary.finalAnswerUseful += scenario.natural?.finalAnswerUseful === true ? 1 : 0;
      summary.weakAnswerSignals += Array.isArray(scenario.natural?.weakAnswerSignals)
        ? scenario.natural.weakAnswerSignals.length
        : 0;
      summary.toolRequested += readNumber(scenario.metrics?.tools?.requested);
      summary.toolResults += readNumber(scenario.metrics?.tools?.results);
      summary.toolFailed += readNumber(scenario.metrics?.tools?.failed);
      summary.toolCancelled += readNumber(scenario.metrics?.tools?.cancelled);
      summary.toolTimeouts += readNumber(scenario.metrics?.tools?.timeouts);
      summary.sessionsSpawned += readNumber(scenario.metrics?.sessions?.spawned);
      summary.sessionsContinued += readNumber(scenario.metrics?.sessions?.continued);
      summary.browserProfileFallbacks += readNumber(scenario.metrics?.browser?.profileFallbacks);
      summary.browserFailureBuckets += readBrowserFailureBucketCount(scenario.metrics?.browser?.failureBuckets);
      summary.approvalsRequested += readNumber(scenario.metrics?.approvals?.requested);
      summary.approvalsDecided += readNumber(scenario.metrics?.approvals?.decided);
      summary.approvalsApplied += readNumber(scenario.metrics?.approvals?.applied);
      summary.livenessActive += readNumber(scenario.metrics?.liveness?.active);
      summary.livenessWaiting += readNumber(scenario.metrics?.liveness?.waiting);
      summary.livenessStale += readNumber(scenario.metrics?.liveness?.stale);
      summary.evidenceEvents += readNumber(scenario.metrics?.evidenceEvents);
      summary.sourceAnswerTermsCovered += readNumber(scenario.natural?.sourceCoverage?.answerTerms?.covered);
      summary.sourceAnswerTermsTotal += readNumber(scenario.natural?.sourceCoverage?.answerTerms?.total);
      summary.sourceAnswerTermsMissing += readArrayLength(scenario.natural?.sourceCoverage?.answerTerms?.missing);
      summary.sourceAnswerPatternsCovered += readNumber(scenario.natural?.sourceCoverage?.answerPatterns?.covered);
      summary.sourceAnswerPatternsTotal += readNumber(scenario.natural?.sourceCoverage?.answerPatterns?.total);
      summary.sourceAnswerPatternsMissing += readArrayLength(scenario.natural?.sourceCoverage?.answerPatterns?.missing);
      summary.sourceEvidencePatternsCovered += readNumber(scenario.natural?.sourceCoverage?.evidencePatterns?.covered);
      summary.sourceEvidencePatternsTotal += readNumber(scenario.natural?.sourceCoverage?.evidencePatterns?.total);
      summary.sourceEvidencePatternsMissing += readArrayLength(scenario.natural?.sourceCoverage?.evidencePatterns?.missing);
      summary.sourceEvidenceEventsObserved += readNumber(scenario.natural?.sourceCoverage?.evidenceEvents?.observed);
      summary.sourceEvidenceEventsRequired += readNumber(scenario.natural?.sourceCoverage?.evidenceEvents?.required);
      summary.sourceResidualRiskVisible += scenario.natural?.sourceCoverage?.residualRiskVisible === true ? 1 : 0;
      summary.sourceUnsupportedClaims += readArrayLength(scenario.natural?.sourceCoverage?.unsupportedClaims);
      summary.recoveryEvents += readNumber(scenario.metrics?.recoveryEvents);
      return summary;
    },
    {
      status: report.status === "passed" ? "passed" : "failed",
      scenarioCount: scenarios.length,
      scenarioIds: [],
      passedScenarios: 0,
      failedScenarios: 0,
      completed: 0,
      stuckOrLoop: 0,
      reasonableToolUse: 0,
      browserUsed: 0,
      subAgentCompleted: 0,
      approvalExercised: 0,
      finalAnswerHasEvidence: 0,
      finalAnswerUseful: 0,
      weakAnswerSignals: 0,
      toolRequested: 0,
      toolResults: 0,
      toolFailed: 0,
      toolCancelled: 0,
      toolTimeouts: 0,
      sessionsSpawned: 0,
      sessionsContinued: 0,
      browserProfileFallbacks: 0,
      browserFailureBuckets: 0,
      approvalsRequested: 0,
      approvalsDecided: 0,
      approvalsApplied: 0,
      livenessActive: 0,
      livenessWaiting: 0,
      livenessStale: 0,
      evidenceEvents: 0,
      sourceAnswerTermsCovered: 0,
      sourceAnswerTermsTotal: 0,
      sourceAnswerTermsMissing: 0,
      sourceAnswerPatternsCovered: 0,
      sourceAnswerPatternsTotal: 0,
      sourceAnswerPatternsMissing: 0,
      sourceEvidencePatternsCovered: 0,
      sourceEvidencePatternsTotal: 0,
      sourceEvidencePatternsMissing: 0,
      sourceEvidenceEventsObserved: 0,
      sourceEvidenceEventsRequired: 0,
      sourceResidualRiskVisible: 0,
      sourceUnsupportedClaims: 0,
      recoveryEvents: 0,
    }
  );
}

function isMissionE2eReportShape(value: unknown): value is MissionE2eReportShape {
  return typeof value === "object" && value !== null;
}

function isMissionScenarioReportShape(value: unknown): value is MissionScenarioReportShape {
  return typeof value === "object" && value !== null;
}

function isPassingMissionScenario(scenario: MissionScenarioReportShape): boolean {
  if (
    scenario.status !== "done" ||
    !Array.isArray(scenario.final?.qualityFailures) ||
    scenario.final.qualityFailures.length > 0
  ) {
    return false;
  }
  const scenarioId = readString(scenario.scenario);
  if (scenarioId === "budget-limited-closeout") {
    return scenario.qualityGate === "needs_attention" && readString(scenario.final?.closeout?.reason) === "round_limit";
  }
  if (scenarioId === "sub-agent-timeout-closeout" || scenarioId === "timeout-recovery") {
    return (
      scenario.qualityGate === "blocked" &&
      readString(scenario.final?.closeout?.reason) === "sub_agent_timeout" &&
      readNumber(scenario.metrics?.tools?.failed) >= 1 &&
      readNumber(scenario.metrics?.tools?.timeouts) >= 1 &&
      readNumber(scenario.metrics?.tools?.cancelled) === 0
    );
  }
  if (scenarioId === "cancel") {
    return (
      scenario.qualityGate === "blocked" &&
      readNumber(scenario.metrics?.tools?.cancelled) >= 1 &&
      readNumber(scenario.metrics?.tools?.timeouts) === 0 &&
      !hasUnexpectedForcedCloseout(scenario)
    );
  }
  return scenario.qualityGate === "passed" && !hasUnexpectedForcedCloseout(scenario);
}

function isBlockingQualityCheckFailure(
  scenario: MissionScenarioReportShape,
  check: { name: string; status: string }
): boolean {
  if (check.status !== "fail") {
    return false;
  }
  const scenarioId = readString(scenario.scenario);
  if (
    check.name === "failure_free" &&
    (scenarioId === "cancel" || scenarioId === "timeout-recovery" || scenarioId === "sub-agent-timeout-closeout")
  ) {
    return false;
  }
  return true;
}

function hasUnexpectedForcedCloseout(scenario: MissionScenarioReportShape): boolean {
  const reason = readString(scenario.final?.closeout?.reason);
  return reason !== null && FORCED_TOOL_LOOP_CLOSEOUT_REASONS.has(reason);
}

function isNaturalMissionE2eReportShape(value: unknown): value is NaturalMissionE2eReportShape {
  return typeof value === "object" && value !== null;
}

function isNaturalScenarioReportShape(value: unknown): value is NaturalScenarioReportShape {
  return typeof value === "object" && value !== null;
}

function isToolUseE2eReportShape(value: unknown): value is ToolUseE2eReportShape {
  return typeof value === "object" && value !== null;
}

function isToolUseScenarioReportShape(value: unknown): value is ToolUseScenarioReportShape {
  return typeof value === "object" && value !== null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function readArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBrowserFailureBucketCount(value: unknown): number {
  if (!Array.isArray(value)) {
    return 0;
  }
  return value.reduce((total, item) => {
    if (typeof item !== "object" || item === null) {
      return total;
    }
    return total + readNumber((item as { count?: unknown }).count);
  }, 0);
}

function readQualityChecks(value: unknown): Array<{ name: string; status: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const candidate = item as { name?: unknown; status?: unknown };
    if (typeof candidate.name !== "string" || typeof candidate.status !== "string") {
      return [];
    }
    return [{ name: candidate.name, status: candidate.status }];
  });
}
