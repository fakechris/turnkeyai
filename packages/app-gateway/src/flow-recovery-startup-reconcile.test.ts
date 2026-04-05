import assert from "node:assert/strict";
import test from "node:test";

import type { FlowLedger, RecoveryRun, TeamThread } from "@turnkeyai/core-types/team";

import { reconcileFlowRecoveryOnStartup } from "./flow-recovery-startup-reconcile";

test("flow/recovery startup reconcile fails orphaned and flow-mismatched recovery runs", async () => {
  const threads: TeamThread[] = [
    {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Demo",
      leadRoleId: "lead",
      roles: [],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const flows: FlowLedger[] = [
    {
      flowId: "flow-1",
      threadId: "thread-1",
      rootMessageId: "msg-1",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: [],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 0,
      maxHops: 4,
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    },
    {
      flowId: "flow-orphan",
      threadId: "thread-orphan",
      rootMessageId: "msg-2",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: [],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 0,
      maxHops: 4,
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const recoveryRuns: RecoveryRun[] = [
    {
      recoveryRunId: "recovery:ok",
      threadId: "thread-1",
      sourceGroupId: "group-1",
      flowId: "flow-1",
      latestStatus: "failed",
      status: "planned",
      nextAction: "retry_same_layer",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "ok",
      attempts: [],
      createdAt: 1,
      updatedAt: 1,
    },
    {
      recoveryRunId: "recovery:missing-flow",
      threadId: "thread-1",
      sourceGroupId: "group-2",
      flowId: "flow-missing",
      latestStatus: "failed",
      status: "planned",
      nextAction: "retry_same_layer",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "missing flow",
      attempts: [],
      createdAt: 1,
      updatedAt: 1,
    },
    {
      recoveryRunId: "recovery:cross-thread",
      threadId: "thread-1",
      sourceGroupId: "group-3",
      flowId: "flow-orphan",
      latestStatus: "failed",
      status: "planned",
      nextAction: "retry_same_layer",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "cross thread",
      attempts: [],
      createdAt: 1,
      updatedAt: 1,
    },
    {
      recoveryRunId: "recovery:orphan",
      threadId: "thread-orphan",
      sourceGroupId: "group-4",
      latestStatus: "failed",
      status: "running",
      nextAction: "fallback_transport",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "orphan",
      attempts: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const persistedFlows = new Map<string, FlowLedger>();
  const persisted = new Map<string, RecoveryRun>();

  const result = await reconcileFlowRecoveryOnStartup({
    clock: { now: () => 99 },
    teamThreadStore: {
      async list() {
        return threads;
      },
    } as any,
    flowLedgerStore: {
      async listAll() {
        return flows;
      },
      async listByThread() {
        return [];
      },
      async put(flow: FlowLedger) {
        persistedFlows.set(flow.flowId, flow);
      },
    } as any,
    recoveryRunStore: {
      async listAll() {
        return recoveryRuns;
      },
      async listByThread() {
        return [];
      },
      async put(run: RecoveryRun) {
        persisted.set(run.recoveryRunId, run);
      },
    } as any,
  });

  assert.deepEqual(result, {
    orphanedFlows: 1,
    abortedOrphanedFlows: 1,
    orphanedRecoveryRuns: 1,
    missingFlowRecoveryRuns: 1,
    crossThreadFlowRecoveryRuns: 1,
    failedRecoveryRuns: 3,
    affectedFlowIds: ["flow-orphan"],
    affectedRecoveryRunIds: ["recovery:missing-flow", "recovery:cross-thread", "recovery:orphan"],
  });
  assert.equal(persistedFlows.get("flow-orphan")?.status, "aborted");
  assert.deepEqual(persistedFlows.get("flow-orphan")?.activeRoleIds, []);
  assert.equal(persisted.get("recovery:missing-flow")?.status, "failed");
  assert.equal(persisted.get("recovery:missing-flow")?.nextAction, "stop");
  assert.equal(persisted.get("recovery:cross-thread")?.requiresManualIntervention, true);
  assert.equal(persisted.get("recovery:orphan")?.updatedAt, 99);
});
