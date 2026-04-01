import {
  describeRecoveryRunGate,
  isAllowedRecoveryRunAction,
  listAllowedRecoveryRunActions,
} from "@turnkeyai/core-types/recovery-operator-semantics";
import type { RecoveryRun, RecoveryRunAction } from "@turnkeyai/core-types/team";

export interface RecoveryRunActionConflict {
  error: string;
  recoveryRun: RecoveryRun;
  currentGate: string;
  allowedActions: readonly RecoveryRunAction[];
}

export function validateRecoveryRunAction(run: RecoveryRun, action: RecoveryRunAction): string | null {
  if (run.status === "recovered" || run.status === "aborted") {
    return `recovery run is already ${run.status}`;
  }

  if (action === "approve" && run.status !== "waiting_approval") {
    return "recovery run is not waiting for approval";
  }

  if (
    (run.status === "running" || run.status === "retrying" || run.status === "fallback_running" || run.status === "resumed") &&
    action !== "reject"
  ) {
    return "recovery run already has an in-flight attempt";
  }

  if (!isAllowedRecoveryRunAction(run.status, action)) {
    if (run.status === "waiting_approval") {
      return "recovery run requires approval before it can continue";
    }
    return `recovery action ${action} is not allowed while run is ${run.status}`;
  }

  return null;
}

export function buildRecoveryRunActionConflict(
  run: RecoveryRun,
  action: RecoveryRunAction,
  errorOverride?: string
): RecoveryRunActionConflict | null {
  const error = errorOverride ?? validateRecoveryRunAction(run, action);
  if (!error) {
    return null;
  }

  return {
    error,
    recoveryRun: run,
    currentGate: describeRecoveryRunGate(run.status),
    allowedActions: listAllowedRecoveryRunActions(run.status).filter((candidate) => candidate !== "dispatch"),
  };
}
