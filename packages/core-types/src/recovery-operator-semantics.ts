import type { RecoveryRunAction, RecoveryRunStatus } from "./team";

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

export function isAllowedRecoveryRunAction(status: RecoveryRunStatus, action: RecoveryRunAction): boolean {
  return ALLOWED_RECOVERY_ACTIONS[status].includes(action);
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
