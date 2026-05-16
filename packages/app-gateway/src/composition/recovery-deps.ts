// PR C — composition aftercare, sibling to inspection-deps.
//
// `handleRecoveryRoutes` needs a deps record that fans out across the replay
// recorder, the recovery action service, and a relay-diagnostics snapshot for
// the operator-bundle path. Previously the entire deps object was built
// inline at the daemon's HTTP dispatch site (~80 lines). This module owns
// that wiring so daemon.ts stays a thin orchestrator.
//
// Recovery deps share the same `getRelayDiagnosticsSnapshot` helper as the
// inspection deps. The helper is exported from inspection-deps.ts (its
// canonical home) and reused here.

import {
  attachRecoveryRunToReplayIncidentBundle,
  buildReplayIncidentBundle,
  buildReplayInspectionReport,
  buildReplayRecoveryPlans,
  findReplayTaskSummary,
} from "@turnkeyai/qc-runtime/replay-inspection";

import type { RecoveryRouteDeps } from "../routes/recovery-routes";
import type { RouteIdempotencyStore } from "../idempotency-store";
import type { DaemonFoundations } from "./foundations";
import { getRelayDiagnosticsSnapshot } from "./inspection-deps";
import type { DaemonRuntimeServices } from "./runtime-services";

export interface RecoveryDepsInputs {
  foundations: DaemonFoundations;
  runtimeServices: DaemonRuntimeServices;
  idempotencyStore: RouteIdempotencyStore;
}

export function createRecoveryRouteDeps(inputs: RecoveryDepsInputs): RecoveryRouteDeps {
  const {
    foundations: { replayRecorder, recoveryRunEventStore, relayGateway },
    runtimeServices: { recoveryActionService },
    idempotencyStore,
  } = inputs;

  return {
    buildReplayIncidents: async ({ threadId, limit, action, category }) => {
      const report = buildReplayInspectionReport(
        await replayRecorder.list({
          ...(threadId ? { threadId } : {}),
          limit,
        })
      );
      return {
        totalReplays: report.totalReplays,
        totalGroups: report.totalGroups,
        incidents: report.incidents.filter(
          (incident) =>
            (action ? incident.recoveryHint.action === action : true) &&
            (category ? incident.rootFailureCategory === category : true)
        ),
      };
    },
    buildReplayRecoveries: async ({ threadId, limit, action }) => {
      const plans = buildReplayRecoveryPlans(
        await replayRecorder.list({
          ...(threadId ? { threadId } : {}),
          limit,
        })
      );
      return {
        totalRecoveries: plans.length,
        recoveries: plans.filter((plan) =>
          action ? plan.recoveryHint.action === action || plan.nextAction === action : true
        ),
      };
    },
    getReplayGroup: async (threadId, groupId) => {
      const records = await replayRecorder.list({ threadId });
      const report = buildReplayInspectionReport(records);
      const group = findReplayTaskSummary(records, groupId, report);
      if (!group) {
        return null;
      }
      const replays = records
        .filter((record) => (record.taskId ?? record.replayId) === group.groupId)
        .sort((left, right) => left.recordedAt - right.recordedAt);
      return { group, replays };
    },
    getReplayBundle: async (threadId, groupId) => {
      const synced = await recoveryActionService.loadRecoveryRuntime(threadId);
      const bundle = buildReplayIncidentBundle(
        synced.records,
        groupId,
        getRelayDiagnosticsSnapshot(relayGateway)
      );
      if (!bundle) {
        return null;
      }
      const recoveryRun = synced.runs.find((run) => run.sourceGroupId === bundle.group.groupId);
      if (recoveryRun) {
        attachRecoveryRunToReplayIncidentBundle({
          bundle,
          run: recoveryRun,
          records: synced.records,
          events: await recoveryRunEventStore.listByRecoveryRun(recoveryRun.recoveryRunId),
        });
      }
      return bundle;
    },
    getReplayRecovery: (threadId, groupId) => recoveryActionService.getReplayRecovery(threadId, groupId),
    listRecoveryRuns: (threadId) => recoveryActionService.listRecoveryRuns(threadId),
    getRecoveryRun: (threadId, recoveryRunId) => recoveryActionService.getRecoveryRun(threadId, recoveryRunId),
    getRecoveryTimeline: (threadId, recoveryRunId) =>
      recoveryActionService.getRecoveryTimeline(threadId, recoveryRunId),
    executeRecoveryRunAction: ({ threadId, recoveryRunId, action }) =>
      recoveryActionService.executeRecoveryRunActionById({ threadId, recoveryRunId, action }),
    dispatchReplayRecovery: ({ threadId, groupId }) =>
      recoveryActionService.dispatchReplayRecovery({ threadId, groupId }),
    getReplay: (replayId) => replayRecorder.get(replayId),
    idempotencyStore,
  };
}
