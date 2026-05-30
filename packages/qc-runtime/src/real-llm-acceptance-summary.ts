import type { ValidationOpsRealAcceptanceDetails } from "@turnkeyai/core-types/team";

type MissionReportSummary = NonNullable<ValidationOpsRealAcceptanceDetails["missionReport"]>;

interface MissionScenarioReportShape {
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
    evidenceEvents?: unknown;
    recoveryEvents?: unknown;
  };
  final?: {
    qualityFailures?: unknown;
  };
}

interface MissionE2eReportShape {
  kind?: unknown;
  status?: unknown;
  scenarios?: unknown;
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
      approvalsRequested: 0,
      approvalsDecided: 0,
      approvalsApplied: 0,
      livenessActive: 0,
      livenessWaiting: 0,
      livenessStale: 0,
      evidenceEvents: 0,
      recoveryEvents: 0,
    };
  }

  return scenarios.reduce<MissionReportSummary>(
    (summary, scenario) => {
      const passing =
        scenario.status === "done" &&
        scenario.qualityGate === "passed" &&
        Array.isArray(scenario.final?.qualityFailures) &&
        scenario.final.qualityFailures.length === 0;
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
      summary.approvalsRequested += readNumber(scenario.metrics?.approvals?.requested);
      summary.approvalsDecided += readNumber(scenario.metrics?.approvals?.decided);
      summary.approvalsApplied += readNumber(scenario.metrics?.approvals?.applied);
      summary.livenessActive += readNumber(scenario.metrics?.liveness?.active);
      summary.livenessWaiting += readNumber(scenario.metrics?.liveness?.waiting);
      summary.livenessStale += readNumber(scenario.metrics?.liveness?.stale);
      summary.evidenceEvents += readNumber(scenario.metrics?.evidenceEvents);
      summary.recoveryEvents += readNumber(scenario.metrics?.recoveryEvents);
      return summary;
    },
    {
      status: report.status === "passed" ? "passed" : "failed",
      scenarioCount: scenarios.length,
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
      approvalsRequested: 0,
      approvalsDecided: 0,
      approvalsApplied: 0,
      livenessActive: 0,
      livenessWaiting: 0,
      livenessStale: 0,
      evidenceEvents: 0,
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

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
