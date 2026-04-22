import type {
  ValidationOpsClosedLoopMetric,
  ValidationOpsClosedLoopStatus,
  ValidationOpsFailureBucket,
} from "@turnkeyai/core-types/team";

const CLOSED_LOOP_STATUS_RANK: Record<ValidationOpsClosedLoopStatus, number> = {
  completed: 0,
  actionable: 1,
  ambiguous_failure: 2,
  silent_failure: 3,
};

export function buildClosedLoopMetric(input: {
  closedLoopStatus: ValidationOpsClosedLoopStatus;
  rerunCommand: string;
  totalCases?: number;
  timeToActionableMs?: number;
  manualGateReason?: string;
  failureBucket?: ValidationOpsFailureBucket;
}): ValidationOpsClosedLoopMetric {
  const totalCases = Math.max(0, Math.floor(input.totalCases ?? 1));
  const completedCases = input.closedLoopStatus === "completed" ? totalCases : 0;
  const actionableCases = input.closedLoopStatus === "actionable" ? totalCases : 0;
  const silentFailureCases = input.closedLoopStatus === "silent_failure" ? totalCases : 0;
  const ambiguousFailureCases = input.closedLoopStatus === "ambiguous_failure" ? totalCases : 0;
  const closedLoopCases = completedCases + actionableCases;
  return {
    closedLoopStatus: input.closedLoopStatus,
    totalCases,
    completedCases,
    actionableCases,
    silentFailureCases,
    ambiguousFailureCases,
    closedLoopCases,
    closedLoopRate: totalCases > 0 ? closedLoopCases / totalCases : 0,
    rerunCommand: input.rerunCommand,
    ...(input.timeToActionableMs !== undefined ? { timeToActionableMs: input.timeToActionableMs } : {}),
    ...(input.manualGateReason ? { manualGateReason: input.manualGateReason } : {}),
    ...(input.failureBucket ? { failureBucket: input.failureBucket } : {}),
  };
}

export function mergeClosedLoopMetrics(
  metrics: Array<ValidationOpsClosedLoopMetric | undefined>,
  rerunCommand: string
): ValidationOpsClosedLoopMetric | undefined {
  const measured = metrics.filter((metric): metric is ValidationOpsClosedLoopMetric => metric !== undefined);
  if (measured.length === 0) {
    return undefined;
  }

  const totalCases = measured.reduce((sum, metric) => sum + metric.totalCases, 0);
  const completedCases = measured.reduce((sum, metric) => sum + metric.completedCases, 0);
  const actionableCases = measured.reduce((sum, metric) => sum + metric.actionableCases, 0);
  const silentFailureCases = measured.reduce((sum, metric) => sum + metric.silentFailureCases, 0);
  const ambiguousFailureCases = measured.reduce((sum, metric) => sum + metric.ambiguousFailureCases, 0);
  const closedLoopCases = completedCases + actionableCases;
  const highestPriorityMetric = [...measured].sort(compareClosedLoopPriority).at(-1);
  const timeToActionableMs = measured
    .map((metric) => metric.timeToActionableMs)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => right - left)[0];

  return {
    closedLoopStatus: deriveClosedLoopStatus({
      actionableCases,
      silentFailureCases,
      ambiguousFailureCases,
    }),
    totalCases,
    completedCases,
    actionableCases,
    silentFailureCases,
    ambiguousFailureCases,
    closedLoopCases,
    closedLoopRate: totalCases > 0 ? closedLoopCases / totalCases : 0,
    rerunCommand: highestPriorityMetric?.closedLoopStatus === "completed"
      ? rerunCommand
      : highestPriorityMetric?.rerunCommand ?? rerunCommand,
    ...(timeToActionableMs !== undefined ? { timeToActionableMs } : {}),
    ...(highestPriorityMetric?.manualGateReason ? { manualGateReason: highestPriorityMetric.manualGateReason } : {}),
    ...(highestPriorityMetric?.failureBucket ? { failureBucket: highestPriorityMetric.failureBucket } : {}),
  };
}

function deriveClosedLoopStatus(input: {
  actionableCases: number;
  silentFailureCases: number;
  ambiguousFailureCases: number;
}): ValidationOpsClosedLoopStatus {
  if (input.silentFailureCases > 0) {
    return "silent_failure";
  }
  if (input.ambiguousFailureCases > 0) {
    return "ambiguous_failure";
  }
  if (input.actionableCases > 0) {
    return "actionable";
  }
  return "completed";
}

function compareClosedLoopPriority(
  left: ValidationOpsClosedLoopMetric,
  right: ValidationOpsClosedLoopMetric
): number {
  return CLOSED_LOOP_STATUS_RANK[left.closedLoopStatus] - CLOSED_LOOP_STATUS_RANK[right.closedLoopStatus];
}
