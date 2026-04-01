import type { RecoveryRun, RecoveryRunAction, RecoveryRunStatus } from "@turnkeyai/core-types/team";

const ALLOWED_RECOVERY_ACTIONS: Record<RecoveryRunStatus, ReadonlySet<RecoveryRunAction>> = {
  planned: new Set(["dispatch", "retry", "fallback", "resume", "reject"]),
  running: new Set(["reject"]),
  waiting_approval: new Set(["approve", "reject"]),
  waiting_external: new Set(["retry", "fallback", "resume", "reject"]),
  retrying: new Set(["reject"]),
  fallback_running: new Set(["reject"]),
  resumed: new Set(["reject"]),
  superseded: new Set(["retry", "fallback", "resume", "reject"]),
  recovered: new Set(),
  failed: new Set(["retry", "fallback", "resume", "reject"]),
  aborted: new Set(),
};

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

  const allowedActions = ALLOWED_RECOVERY_ACTIONS[run.status];
  if (!allowedActions.has(action)) {
    if (run.status === "waiting_approval") {
      return "recovery run requires approval before it can continue";
    }
    return `recovery action ${action} is not allowed while run is ${run.status}`;
  }

  return null;
}
