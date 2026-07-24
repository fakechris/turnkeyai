// Zombie work item reconcile (deferred-hardening-plan §4a).
//
// Startup recovery restores role runs, flows, worker sessions, and runtime
// chains, but not Mission Control work items. If the daemon crashes while a
// work item is `working` and its owning flow/role run is not recoverable, the
// item stays `working` forever: the report attention pass only surfaces
// `blocked` items, and `tasks_create`'s title dedup hands the zombie back to
// new runs as if it were live work.
//
// This module mirrors sweepOrphanWorkerSessions: scan every mission, and for
// any mission whose linked thread has no active flow or role run left, flip its
// `working` items to `blocked` and attach a synthetic blocker breadcrumb so
// operators and re-dispatching runs know the item needs re-verification.

import type {
  FlowStatus,
  FlowLedgerStore,
  OrphanedWorkItemReconcileResult,
  RoleRunStatus,
  RoleRunStore,
} from "@turnkeyai/core-types/team";
import type {
  MissionStore,
  WorkItem,
  WorkItemStore,
} from "@turnkeyai/core-types/mission";

/**
 * Marker recorded in the synthetic blocker text when a `working` work item is
 * reconciled to `blocked` after a daemon restart left its owning flow/role run
 * unrecoverable. The report attention pass and `tasks_create` dedup both match
 * on this marker to signal "orphaned, needs re-verification".
 */
export const ORPHANED_WORK_ITEM_BLOCKER_MARKER =
  "runtime_orphaned_after_restart" as const;

const TERMINAL_FLOW_STATUSES = new Set<FlowStatus>([
  "completed",
  "failed",
  "aborted",
]);
const TERMINAL_ROLE_RUN_STATUSES = new Set<RoleRunStatus>(["done", "failed"]);

export function isOrphanedWorkItemBlocker(blocker: string | undefined): boolean {
  return (
    typeof blocker === "string" &&
    blocker.includes(ORPHANED_WORK_ITEM_BLOCKER_MARKER)
  );
}

export function buildOrphanedWorkItemBlocker(flowIds: string[]): string {
  const flows = flowIds.length > 0 ? flowIds.join(", ") : "unknown";
  return `${ORPHANED_WORK_ITEM_BLOCKER_MARKER}: owning flow (${flows}) did not survive daemon restart; re-verify before continuing`;
}

export async function reconcileOrphanedWorkItemsOnStartup(input: {
  clock: { now(): number };
  missionStore: MissionStore;
  workItemStore: WorkItemStore;
  flowLedgerStore: FlowLedgerStore;
  roleRunStore: RoleRunStore;
  onError?: (error: unknown, missionId: string) => void;
}): Promise<OrphanedWorkItemReconcileResult> {
  const missions = await input.missionStore.list();
  let scannedWorkItems = 0;
  let orphanedWorkItems = 0;
  const affectedWorkItemIds: string[] = [];
  const affectedMissionIds: string[] = [];

  for (const mission of missions) {
    let items: WorkItem[];
    try {
      items = await input.workItemStore.listByMission(mission.id);
    } catch (error) {
      input.onError?.(error, mission.id);
      continue;
    }
    const workingItems = items.filter((item) => item.status === "working");
    scannedWorkItems += workingItems.length;
    if (workingItems.length === 0) {
      continue;
    }

    // A mission without a linked thread has no runtime that could still own the
    // work. With a thread, only reconcile when neither a non-terminal flow nor
    // a non-terminal role run remains — anything live may still make progress,
    // so we never block active work.
    let breadcrumbFlowIds: string[] = [];
    if (mission.threadId) {
      const threadId = mission.threadId;
      let flows: Awaited<ReturnType<FlowLedgerStore["listByThread"]>>;
      let runs: Awaited<ReturnType<RoleRunStore["listByThread"]>>;
      try {
        [flows, runs] = await Promise.all([
          input.flowLedgerStore.listByThread(threadId),
          input.roleRunStore.listByThread(threadId),
        ]);
      } catch (error) {
        input.onError?.(error, mission.id);
        continue;
      }
      const hasActiveFlow = flows.some(
        (flow) => !TERMINAL_FLOW_STATUSES.has(flow.status),
      );
      const hasActiveRun = runs.some(
        (run) => !TERMINAL_ROLE_RUN_STATUSES.has(run.status),
      );
      if (hasActiveFlow || hasActiveRun) {
        continue;
      }
      // Keep every flow id (terminal included) as a breadcrumb so operators can
      // trace the dead owning flow.
      breadcrumbFlowIds = flows.map((flow) => flow.flowId);
    }

    const blocker = buildOrphanedWorkItemBlocker(breadcrumbFlowIds);
    const changedIds: string[] = [];
    const nextItems = items.map((item) => {
      if (
        item.status !== "working" ||
        isOrphanedWorkItemBlocker(item.blocker)
      ) {
        return item;
      }
      changedIds.push(item.id);
      return {
        ...structuredClone(item),
        status: "blocked" as const,
        blocker,
      };
    });
    if (changedIds.length === 0) {
      continue;
    }

    try {
      await persistReconciledItems(input.workItemStore, mission.id, items, nextItems);
    } catch (error) {
      input.onError?.(error, mission.id);
      continue;
    }
    orphanedWorkItems += changedIds.length;
    affectedWorkItemIds.push(...changedIds);
    affectedMissionIds.push(mission.id);
  }

  return {
    scannedMissions: missions.length,
    scannedWorkItems,
    orphanedWorkItems,
    affectedWorkItemIds,
    affectedMissionIds,
  };
}

async function persistReconciledItems(
  store: WorkItemStore,
  missionId: string,
  previous: WorkItem[],
  next: WorkItem[],
): Promise<void> {
  if (store.putGraph) {
    await store.putGraph(missionId, next);
    return;
  }
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== previous[index]) {
      await store.put(next[index]!);
    }
  }
}
