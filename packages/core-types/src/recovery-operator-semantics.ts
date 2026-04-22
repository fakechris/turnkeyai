import type { RecoveryRun, RecoveryRunAction, RecoveryRunStatus } from "./team-recovery-types";
import type { OperatorCaseState } from "./team-replay-types";

const ALLOWED_RECOVERY_ACTIONS: Record<RecoveryRunStatus, readonly RecoveryRunAction[]> = {
  planned: ["dispatch", "retry", "fallback", "resume", "reject"],
  running: ["reject"],
  waiting_approval: ["approve", "reject"],
  waiting_external: ["retry", "fallback", "resume", "reject"],
  retrying: ["reject"],
  fallback_running: ["reject"],
  resumed: ["reject"],
  superseded: ["retry", "fallback", "resume", "reject"],
  recovered: [],
  failed: ["retry", "fallback", "resume", "reject"],
  aborted: [],
};

export function listAllowedRecoveryRunActions(status: RecoveryRunStatus): readonly RecoveryRunAction[] {
  return ALLOWED_RECOVERY_ACTIONS[status];
}

export function listOperatorRecoveryRunActions(status: RecoveryRunStatus): RecoveryRunAction[] {
  return listAllowedRecoveryRunActions(status).filter((action) => action !== "dispatch");
}

export function isAllowedRecoveryRunAction(status: RecoveryRunStatus, action: RecoveryRunAction): boolean {
  return ALLOWED_RECOVERY_ACTIONS[status].includes(action);
}

export function deriveRecoveryRunOperatorCaseState(statusOrRun: RecoveryRunStatus | Pick<RecoveryRun, "status">): OperatorCaseState {
  const status = typeof statusOrRun === "string" ? statusOrRun : statusOrRun.status;
  switch (status) {
    case "waiting_approval":
    case "waiting_external":
      return "waiting_manual";
    case "running":
    case "retrying":
    case "fallback_running":
    case "resumed":
    case "superseded":
      return "recovering";
    case "recovered":
      return "resolved";
    case "failed":
    case "aborted":
      return "blocked";
    case "planned":
    default:
      return "open";
  }
}

export function describeRecoveryRunGate(status: RecoveryRunStatus): string {
  switch (status) {
    case "waiting_approval":
      return "waiting for approval";
    case "waiting_external":
      return "waiting for external/manual follow-up";
    case "retrying":
      return "retrying same layer";
    case "fallback_running":
      return "running fallback transport";
    case "resumed":
      return "resuming existing session";
    case "running":
      return "dispatch in progress";
    case "recovered":
      return "recovered";
    case "failed":
      return "failed and awaiting next recovery action";
    case "aborted":
      return "aborted";
    case "superseded":
      return "superseded by a newer recovery attempt";
    case "planned":
    default:
      return "planned";
  }
}
