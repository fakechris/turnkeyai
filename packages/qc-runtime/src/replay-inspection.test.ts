import assert from "node:assert/strict";
import test from "node:test";

import type { RecoveryRun } from "@turnkeyai/core-types/team";

import {
  buildRecoveryRunTimeline,
  buildRecoveryRunProgress,
  buildRecoveryRunId,
  buildRecoveryRuns,
  buildReplayConsoleReport,
  buildReplayIncidentBundle,
  buildReplayInspectionReport,
  buildReplayRecoveryPlans,
  findReplayRecoveryPlan,
  findReplayTaskSummary,
} from "./replay-inspection";

test("replay inspection groups records by task and flags incidents", () => {
  const report = buildReplayInspectionReport([
    {
      replayId: "task-1:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-1",
      flowId: "flow-1",
      summary: "scheduled dispatched",
    },
    {
      replayId: "task-1:worker",
      layer: "worker",
      status: "failed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-1",
      flowId: "flow-1",
      summary: "worker failed",
      failure: {
        category: "transport_failed",
        layer: "worker",
        retryable: true,
        message: "fetch failed",
        recommendedAction: "fallback",
      },
    },
    {
      replayId: "task-2:worker",
      layer: "worker",
      status: "completed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-2",
      flowId: "flow-2",
      summary: "worker completed",
    },
  ]);

  assert.equal(report.totalReplays, 3);
  assert.equal(report.totalGroups, 2);
  assert.equal(report.incidents.length, 1);
  assert.equal(report.failureCounts.transport_failed, 1);
  assert.equal(report.layerCounts.worker, 2);
  assert.equal(report.groups[0]?.groupId, "task-2");
  assert.equal(report.groups[1]?.groupId, "task-1");
  assert.equal(report.incidents[0]?.groupId, "task-1");
  assert.equal(report.incidents[0]?.recommendedAction, "fallback");
  assert.equal(report.incidents[0]?.rootFailureCategory, "transport_failed");
  assert.equal(report.incidents[0]?.failedLayer, "worker");
  assert.equal(report.incidents[0]?.lastHealthyLayer, "scheduled");
  assert.equal(report.incidents[0]?.recoveryHint.action, "fallback");
  assert.deepEqual(report.incidents[0]?.layersSeen, ["scheduled", "worker"]);
});

test("replay inspection can resolve one grouped replay summary", () => {
  const records = [
    {
      replayId: "task-9:worker",
      layer: "worker",
      status: "partial",
      recordedAt: 99,
      threadId: "thread-1",
      taskId: "task-9",
      summary: "partial worker output",
    },
  ] as const;

  const summary = findReplayTaskSummary(records as unknown as Parameters<typeof buildReplayInspectionReport>[0], "task-9");
  assert.ok(summary);
  assert.equal(summary?.groupId, "task-9");
  assert.equal(summary?.recoveryHint.action, "resume");
});

test("replay inspection derives actionable recovery plans", () => {
  const records = [
    {
      replayId: "task-3:role",
      layer: "role",
      status: "completed",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-3",
      summary: "role planned work",
    },
    {
      replayId: "task-3:worker:worker:explore:task:task-3",
      layer: "worker",
      status: "failed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-3",
      summary: "worker transport failed",
      failure: {
        category: "transport_failed",
        layer: "worker",
        retryable: true,
        message: "fetch failed",
        recommendedAction: "fallback",
      },
      workerType: "explore",
    },
  ];

  const plans = buildReplayRecoveryPlans(records as Parameters<typeof buildReplayInspectionReport>[0]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.groupId, "task-3");
  assert.equal(plans[0]?.nextAction, "fallback_transport");
  assert.equal(plans[0]?.targetLayer, "worker");
  assert.equal(plans[0]?.canAutoResume, true);
  assert.equal(plans[0]?.targetWorker, "explore");
  assert.equal(plans[0]?.autoDispatchReady, false);

  const single = findReplayRecoveryPlan(records as Parameters<typeof buildReplayInspectionReport>[0], "task-3");
  assert.equal(single?.recoveryHint.action, "fallback");
  assert.equal(single?.requiresManualIntervention, false);
});

test("replay inspection marks auto-dispatch-ready recovery when role and worker are known", () => {
  const records = [
    {
      replayId: "task-4:role:role:role-explore:thread:thread-1",
      layer: "role",
      status: "completed",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-4",
      roleId: "role-explore",
      summary: "role completed",
    },
    {
      replayId: "task-4:worker:worker:explore:task:task-4",
      layer: "worker",
      status: "partial",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-4",
      roleId: "role-explore",
      workerType: "explore",
      summary: "partial worker output",
    },
  ];

  const plan = findReplayRecoveryPlan(records as Parameters<typeof buildReplayInspectionReport>[0], "task-4");
  assert.ok(plan);
  assert.equal(plan?.nextAction, "auto_resume");
  assert.equal(plan?.targetWorker, "explore");
  assert.equal(plan?.autoDispatchReady, true);
});

test("replay inspection builds replay console and incident bundle views", () => {
  const records = [
    {
      replayId: "task-5:role:role:role-explore:thread:thread-1",
      layer: "role",
      status: "completed",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-5",
      flowId: "flow-1",
      roleId: "role-explore",
      summary: "role planned work",
    },
    {
      replayId: "task-5:worker:worker:browser:task:task-5",
      layer: "worker",
      status: "failed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-5",
      flowId: "flow-1",
      roleId: "role-explore",
      workerType: "browser",
      summary: "worker failed",
      failure: {
        category: "stale_session",
        layer: "worker",
        retryable: true,
        message: "detached browser target",
        recommendedAction: "resume",
      },
      metadata: {
        payload: {
          sessionId: "browser-session-5",
          targetId: "target-5",
          resumeMode: "warm",
          targetResolution: "reconnect",
        },
      },
    },
  ];

  const consoleReport = buildReplayConsoleReport(records as Parameters<typeof buildReplayInspectionReport>[0], 5);
  assert.equal(consoleReport.totalReplays, 2);
  assert.equal(consoleReport.openIncidents, 1);
  assert.equal(consoleReport.recoveredGroups, 0);
  assert.equal(consoleReport.attentionCount, 1);
  assert.equal(consoleReport.actionCounts.auto_resume, 1);
  assert.equal(consoleReport.workflowStatusCounts.not_started, 1);
  assert.equal(consoleReport.caseStateCounts.open, 1);
  assert.equal(consoleReport.browserContinuityCounts.attention, 1);
  assert.equal(consoleReport.latestBundles[0]?.groupId, "task-5");
  assert.equal(consoleReport.latestBundles[0]?.caseState, "open");
  assert.equal(consoleReport.latestBundles[0]?.workflowStatus, "not_started");
  assert.equal(consoleReport.latestBundles[0]?.browserContinuityState, "attention");
  assert.match(consoleReport.latestBundles[0]?.workflowSummary ?? "", /not been dispatched yet/i);
  assert.equal(consoleReport.latestIncidents[0]?.groupId, "task-5");
  assert.equal(consoleReport.latestGroups[0]?.browserContinuity?.state, "attention");

  const bundle = buildReplayIncidentBundle(records as Parameters<typeof buildReplayInspectionReport>[0], "task-5");
  assert.ok(bundle);
  assert.equal(bundle?.group.groupId, "task-5");
  assert.equal(bundle?.caseState, "open");
  assert.match(bundle?.caseHeadline ?? "", /task-5 open .*browser=attention reason=stale_session/);
  assert.equal(bundle?.timeline.length, 2);
  assert.equal(bundle?.timeline[1]?.layer, "worker");
  assert.equal(bundle?.recovery?.nextAction, "auto_resume");
  assert.equal(bundle?.recoveryDispatches.length, 0);
  assert.equal(bundle?.followUpGroups.length, 0);
  assert.equal(bundle?.browserContinuity?.state, "attention");
  assert.equal(bundle?.browserContinuity?.sessionId, "browser-session-5");
});

test("replay console surfaces recovery workflow states from actionable bundles", () => {
  const records = [
    {
      replayId: "task-8:worker:worker:browser:task:task-8",
      layer: "worker",
      status: "failed",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-8",
      roleId: "role-operator",
      workerType: "browser",
      summary: "browser failed",
      failure: {
        category: "invalid_resume",
        layer: "worker",
        retryable: false,
        message: "stale browser handle",
        recommendedAction: "inspect",
      },
      metadata: {
        payload: {
          sessionId: "browser-session-8",
          targetId: "target-8",
          resumeMode: "warm",
          targetResolution: "reconnect",
        },
      },
    },
    {
      replayId: "task-9:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-9",
      summary: "recovery dispatched",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-8",
          attemptId: "recovery:task-8:attempt:1",
          dispatchReplayId: "task-9:scheduled",
        },
      },
    },
    {
      replayId: "task-9:worker:worker:browser:task:task-9",
      layer: "worker",
      status: "failed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-9",
      roleId: "role-operator",
      workerType: "browser",
      summary: "follow-up still blocked",
      failure: {
        category: "permission_denied",
        layer: "worker",
        retryable: false,
        message: "manual approval required",
        recommendedAction: "request_approval",
      },
      metadata: {
        recoveryContext: {
          parentGroupId: "task-8",
          attemptId: "recovery:task-8:attempt:1",
          dispatchReplayId: "task-9:scheduled",
        },
      },
    },
  ] as Parameters<typeof buildReplayInspectionReport>[0];

  const consoleReport = buildReplayConsoleReport(records, 5);
  const rootBundle = consoleReport.latestBundles.find((bundle) => bundle.groupId === "task-8");
  assert.equal(consoleReport.workflowStatusCounts.manual_follow_up, 1);
  assert.equal(consoleReport.caseStateCounts.waiting_manual, 1);
  assert.equal(rootBundle?.workflowStatus, "manual_follow_up");
  assert.equal(rootBundle?.caseState, "waiting_manual");
  assert.match(rootBundle?.workflowSummary ?? "", /manual approval required/i);
});

test("replay inspection records recovered browser continuity from follow-up execution", () => {
  const records = [
    {
      replayId: "task-96:worker:worker:browser:task:task-96",
      layer: "worker",
      status: "failed",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-96",
      roleId: "role-operator",
      workerType: "browser",
      summary: "stale browser target",
      failure: {
        category: "stale_session",
        layer: "worker",
        retryable: true,
        message: "browser target detached",
        recommendedAction: "resume",
      },
    },
    {
      replayId: "task-97:worker:worker:browser:task:task-97",
      layer: "worker",
      status: "completed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-97",
      roleId: "role-operator",
      workerType: "browser",
      summary: "browser target reconnected",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-96",
          attemptId: "recovery:task-96:attempt:1",
        },
        payload: {
          sessionId: "browser-session-97",
          targetId: "target-97",
          resumeMode: "warm",
          targetResolution: "reconnect",
        },
      },
    },
  ] as Parameters<typeof buildReplayInspectionReport>[0];

  const initialBundle = buildReplayIncidentBundle(records.slice(0, 1) as Parameters<typeof buildReplayInspectionReport>[0], "task-96");
  assert.equal(initialBundle?.browserContinuity?.state, "attention");

  const existingRuns: RecoveryRun[] = [
    {
      recoveryRunId: buildRecoveryRunId("task-96"),
      threadId: "thread-1",
      sourceGroupId: "task-96",
      taskId: "task-96",
      roleId: "role-operator",
      targetLayer: "worker",
      targetWorker: "browser",
      latestStatus: "failed",
      status: "resumed",
      nextAction: "auto_resume",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "resuming browser session",
      currentAttemptId: "recovery:task-96:attempt:1",
      attempts: [
        {
          attemptId: "recovery:task-96:attempt:1",
          action: "resume",
          requestedAt: 11,
          updatedAt: 11,
          status: "resumed",
          nextAction: "auto_resume",
          summary: "resuming browser session",
          dispatchedTaskId: "task-97",
        },
      ],
      createdAt: 11,
      updatedAt: 11,
    },
  ];

  const run = buildRecoveryRuns(records, existingRuns, 100)[0];
  const bundle = buildReplayIncidentBundle(records, "task-96");
  assert.equal(bundle?.browserContinuity?.state, "recovered");
  assert.equal(bundle?.browserContinuity?.outcome, "detached_target_recovered");
  assert.equal(run?.attempts[0]?.browserOutcome, "detached_target_recovered");
  assert.match(run?.attempts[0]?.browserOutcomeSummary ?? "", /detached browser target/i);
});

test("replay console counts resolved groups even when browser continuity is not marked recovered", () => {
  const records = [
    {
      replayId: "task-closed:worker:worker:browser:task:task-closed",
      layer: "worker",
      status: "failed",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-closed",
      roleId: "role-operator",
      workerType: "browser",
      summary: "stale browser target",
      failure: {
        category: "stale_session",
        layer: "worker",
        retryable: true,
        message: "browser target detached",
        recommendedAction: "resume",
      },
    },
    {
      replayId: "task-closed-follow:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-closed-follow",
      roleId: "role-operator",
      summary: "follow-up recovery dispatch created",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-closed",
          action: "auto_resume",
          dispatchReplayId: "task-closed-follow:scheduled",
        },
      },
    },
    {
      replayId: "task-closed-follow:worker:worker:browser:task:task-closed-follow",
      layer: "worker",
      status: "completed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-closed-follow",
      roleId: "role-operator",
      workerType: "browser",
      summary: "browser recovered via follow-up",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-closed",
          action: "auto_resume",
          dispatchReplayId: "task-closed-follow:scheduled",
        },
      },
    },
  ];

  const consoleReport = buildReplayConsoleReport(records as Parameters<typeof buildReplayInspectionReport>[0], 10);
  const bundle = buildReplayIncidentBundle(records as Parameters<typeof buildReplayInspectionReport>[0], "task-closed");
  assert.equal(bundle?.caseState, "resolved");
  assert.equal(consoleReport.openIncidents, 0);
  assert.equal(consoleReport.recoveredGroups, 1);
});

test("recovery run timeline merges events and replay follow-up entries", () => {
  const records = [
    {
      replayId: "task-30:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-30",
      summary: "scheduled recovery dispatch",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-29",
        },
      },
    },
    {
      replayId: "task-30:worker:worker:browser:task:task-30",
      layer: "worker",
      status: "completed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-30",
      workerType: "browser",
      summary: "browser resumed",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-29",
        },
      },
    },
  ] as Parameters<typeof buildReplayInspectionReport>[0];

  const run: RecoveryRun = {
    recoveryRunId: "recovery:task-29",
    threadId: "thread-1",
    sourceGroupId: "task-29",
    latestStatus: "failed",
    status: "resumed",
    nextAction: "auto_resume",
    autoDispatchReady: true,
    requiresManualIntervention: false,
    latestSummary: "resume dispatched",
    attempts: [],
    createdAt: 5,
    updatedAt: 35,
  };

  const timeline = buildRecoveryRunTimeline(run, records, [
    {
      eventId: "event-1",
      recoveryRunId: run.recoveryRunId,
      threadId: "thread-1",
      sourceGroupId: "task-29",
      kind: "action_requested",
      status: "retrying",
      recordedAt: 10,
      summary: "retry requested",
      action: "retry",
    },
  ]);

  assert.equal(timeline.length, 3);
  assert.equal(timeline[0]?.source, "event");
  assert.equal(timeline[1]?.source, "replay");
  assert.equal(timeline[2]?.layer, "worker");
});

test("replay incident bundle includes recovery dispatches and follow-up groups", () => {
  const records = [
    {
      replayId: "task-6:worker:worker:explore:task:task-6",
      layer: "worker",
      status: "partial",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-6",
      flowId: "flow-6",
      roleId: "role-explore",
      workerType: "explore",
      summary: "partial worker output",
    },
    {
      replayId: "task-7:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-7",
      roleId: "role-explore",
      summary: "recovery dispatch",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-6",
          action: "auto_resume",
          dispatchReplayId: "task-7:scheduled",
        },
      },
    },
    {
      replayId: "task-7:role:role:role-explore:thread:thread-1",
      layer: "role",
      status: "completed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-7",
      roleId: "role-explore",
      summary: "recovered role output",
      parentReplayId: "task-7:scheduled",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-6",
          action: "auto_resume",
          dispatchReplayId: "task-7:scheduled",
        },
      },
    },
  ];

  const bundle = buildReplayIncidentBundle(records as Parameters<typeof buildReplayInspectionReport>[0], "task-6");
  assert.ok(bundle);
  assert.equal(bundle?.recoveryDispatches.length, 1);
  assert.equal(bundle?.recoveryDispatches[0]?.replayId, "task-7:scheduled");
  assert.equal(bundle?.followUpGroups.length, 1);
  assert.equal(bundle?.followUpGroups[0]?.groupId, "task-7");
  assert.equal(bundle?.followUpSummary?.totalGroups, 1);
  assert.equal(bundle?.followUpSummary?.openGroups, 0);
  assert.equal(bundle?.followUpSummary?.closedGroups, 1);
  assert.equal(bundle?.followUpSummary?.actionCounts.none, 1);
  assert.equal(bundle?.followUpTimeline.length, 2);
  assert.equal(bundle?.recoveryWorkflow?.status, "recovered");
  assert.equal(bundle?.recoveryWorkflow?.latestDispatchReplayId, "task-7:scheduled");
  assert.equal(bundle?.recoveryWorkflow?.latestFollowUpGroupId, "task-7");
  assert.match(bundle?.caseHeadline ?? "", /task-6 resolved/);
});

test("replay incident bundle reports failed recovery workflow state", () => {
  const records = [
    {
      replayId: "task-8:worker:worker:browser:task:task-8",
      layer: "worker",
      status: "failed",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-8",
      flowId: "flow-8",
      roleId: "role-operator",
      workerType: "browser",
      summary: "browser worker failed",
      failure: {
        category: "stale_session",
        layer: "worker",
        retryable: true,
        message: "idle eviction closed the browser session",
        recommendedAction: "resume",
      },
    },
    {
      replayId: "task-9:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-9",
      roleId: "role-operator",
      summary: "recovery dispatch",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-8",
          action: "auto_resume",
          dispatchReplayId: "task-9:scheduled",
        },
      },
    },
    {
      replayId: "task-9:worker:worker:browser:task:task-9",
      layer: "worker",
      status: "failed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-9",
      roleId: "role-operator",
      workerType: "browser",
      summary: "browser recovery failed",
      failure: {
        category: "invalid_resume",
        layer: "worker",
        retryable: true,
        message: "invalid resume: detached target cannot be reopened without a URL",
        recommendedAction: "retry",
      },
      metadata: {
        recoveryContext: {
          parentGroupId: "task-8",
          action: "auto_resume",
          dispatchReplayId: "task-9:scheduled",
        },
      },
    },
  ];

  const bundle = buildReplayIncidentBundle(records as Parameters<typeof buildReplayInspectionReport>[0], "task-8");
  assert.ok(bundle);
  assert.equal(bundle?.recoveryWorkflow?.status, "recovery_failed");
  assert.equal(bundle?.recoveryWorkflow?.latestFailure?.category, "invalid_resume");
  assert.equal(bundle?.recoveryWorkflow?.latestFollowUpGroupId, "task-9");
});

test("replay inspection materializes waiting approval recovery runs", () => {
  const records = [
    {
      replayId: "task-10:role:role:role-operator:thread:thread-1",
      layer: "role",
      status: "completed",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-10",
      roleId: "role-operator",
      summary: "role completed",
    },
    {
      replayId: "task-10:worker:worker:browser:task:task-10",
      layer: "worker",
      status: "failed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-10",
      roleId: "role-operator",
      workerType: "browser",
      summary: "approval required",
      failure: {
        category: "permission_denied",
        layer: "worker",
        retryable: false,
        message: "approval required before continuing",
        recommendedAction: "request_approval",
      },
    },
  ];

  const runs = buildRecoveryRuns(records as Parameters<typeof buildReplayInspectionReport>[0], [], 100);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.recoveryRunId, buildRecoveryRunId("task-10"));
  assert.equal(runs[0]?.status, "waiting_approval");
  assert.equal(runs[0]?.nextAction, "request_approval");
  assert.equal(runs[0]?.requiresManualIntervention, true);
});

test("replay inspection projects recovery attempts into recovered run state", () => {
  const existingRuns = [
    {
      recoveryRunId: buildRecoveryRunId("task-11"),
      threadId: "thread-1",
      sourceGroupId: "task-11",
      taskId: "task-11",
      roleId: "role-explore",
      targetLayer: "worker",
      targetWorker: "explore",
      latestStatus: "partial",
      status: "resumed",
      nextAction: "auto_resume",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "Recovery resume dispatched.",
      currentAttemptId: "recovery:task-11:attempt:1",
      attempts: [
        {
          attemptId: "recovery:task-11:attempt:1",
          action: "resume",
          requestedAt: 15,
          updatedAt: 15,
          status: "resumed",
          nextAction: "auto_resume",
          summary: "Recovery resume dispatched.",
          targetLayer: "worker",
          targetWorker: "explore",
          dispatchReplayId: "task-12:scheduled",
          dispatchedTaskId: "task-12",
        },
      ],
      createdAt: 15,
      updatedAt: 15,
    },
  ] as const;

  const records = [
    {
      replayId: "task-11:worker:worker:explore:task:task-11",
      layer: "worker",
      status: "partial",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-11",
      roleId: "role-explore",
      workerType: "explore",
      summary: "partial output",
    },
    {
      replayId: "task-12:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-12",
      roleId: "role-explore",
      summary: "recovery dispatch",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-11",
          action: "auto_resume",
          dispatchReplayId: "task-12:scheduled",
          recoveryRunId: buildRecoveryRunId("task-11"),
          attemptId: "recovery:task-11:attempt:1",
        },
      },
    },
    {
      replayId: "task-12:worker:worker:explore:task:task-12",
      layer: "worker",
      status: "completed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-12",
      roleId: "role-explore",
      workerType: "explore",
      summary: "recovered successfully",
      parentReplayId: "task-12:scheduled",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-11",
          action: "auto_resume",
          dispatchReplayId: "task-12:scheduled",
          recoveryRunId: buildRecoveryRunId("task-11"),
          attemptId: "recovery:task-11:attempt:1",
        },
      },
    },
  ];

  const runs = buildRecoveryRuns(
    records as Parameters<typeof buildReplayInspectionReport>[0],
    existingRuns as unknown as Parameters<typeof buildRecoveryRuns>[1],
    100
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "recovered");
  assert.equal(runs[0]?.currentAttemptId, "recovery:task-11:attempt:1");
  assert.equal(runs[0]?.attempts[0]?.status, "recovered");
  assert.equal(runs[0]?.attempts[0]?.resultingGroupId, "task-12");
});

test("replay inspection preserves browser continuation hints on existing recovery runs", () => {
  const existingRuns = [
    {
      recoveryRunId: buildRecoveryRunId("task-13"),
      threadId: "thread-1",
      sourceGroupId: "task-13",
      taskId: "task-13",
      roleId: "role-operator",
      targetLayer: "worker",
      targetWorker: "browser",
      latestStatus: "partial",
      status: "resumed",
      nextAction: "auto_resume",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "Recovery resume dispatched.",
      currentAttemptId: "recovery:task-13:attempt:1",
      browserSession: {
        sessionId: "browser-session-1",
        targetId: "target-1",
        resumeMode: "warm",
        ownerType: "thread",
        ownerId: "thread-1",
      },
      attempts: [
        {
          attemptId: "recovery:task-13:attempt:1",
          action: "resume",
          requestedAt: 15,
          updatedAt: 15,
          status: "resumed",
          nextAction: "auto_resume",
          summary: "Recovery resume dispatched.",
          targetLayer: "worker",
          targetWorker: "browser",
          dispatchReplayId: "task-14:scheduled",
          dispatchedTaskId: "task-14",
          browserSession: {
            sessionId: "browser-session-1",
            targetId: "target-1",
            resumeMode: "warm",
            ownerType: "thread",
            ownerId: "thread-1",
          },
        },
      ],
      createdAt: 15,
      updatedAt: 15,
    },
  ] as const;

  const records = [
    {
      replayId: "task-13:worker:worker:browser:task:task-13",
      layer: "worker",
      status: "partial",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-13",
      roleId: "role-operator",
      workerType: "browser",
      summary: "browser paused",
    },
  ];

  const runs = buildRecoveryRuns(
    records as Parameters<typeof buildReplayInspectionReport>[0],
    existingRuns as unknown as Parameters<typeof buildRecoveryRuns>[1],
    100
  );
  assert.equal(runs[0]?.browserSession?.sessionId, "browser-session-1");
  assert.equal(runs[0]?.attempts[0]?.browserSession?.targetId, "target-1");
});

test("replay inspection settles attempts when follow-up requires approval", () => {
  const existingRuns: RecoveryRun[] = [
    {
      recoveryRunId: buildRecoveryRunId("task-40"),
      threadId: "thread-1",
      sourceGroupId: "task-40",
      latestStatus: "failed",
      status: "running",
      nextAction: "auto_resume",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "resume dispatched",
      currentAttemptId: "recovery:task-40:attempt:1",
      attempts: [
        {
          attemptId: "recovery:task-40:attempt:1",
          action: "resume",
          requestedAt: 10,
          updatedAt: 10,
          status: "resumed",
          nextAction: "auto_resume",
          summary: "resume dispatched",
          dispatchedTaskId: "task-41",
        },
      ],
      createdAt: 1,
      updatedAt: 10,
    },
  ];

  const records = [
    {
      replayId: "task-40:worker:worker:browser:task:task-40",
      layer: "worker",
      status: "failed",
      recordedAt: 5,
      threadId: "thread-1",
      taskId: "task-40",
      roleId: "role-operator",
      workerType: "browser",
      summary: "initial browser failure",
      failure: {
        category: "permission_denied",
        layer: "worker",
        retryable: false,
        message: "approval required",
        recommendedAction: "request_approval",
      },
    },
    {
      replayId: "task-41:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-41",
      roleId: "role-operator",
      summary: "recovery dispatch",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-40",
          action: "auto_resume",
          dispatchReplayId: "task-41:scheduled",
        },
      },
    },
    {
      replayId: "task-41:worker:worker:browser:task:task-41",
      layer: "worker",
      status: "failed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-41",
      roleId: "role-operator",
      workerType: "browser",
      summary: "needs approval",
      failure: {
        category: "permission_denied",
        layer: "worker",
        retryable: false,
        message: "approval required to continue",
        recommendedAction: "request_approval",
      },
      metadata: {
        recoveryContext: {
          parentGroupId: "task-40",
          action: "auto_resume",
          dispatchReplayId: "task-41:scheduled",
        },
      },
    },
  ] as Parameters<typeof buildReplayInspectionReport>[0];

  const runs = buildRecoveryRuns(records, existingRuns, 100);
  const run = runs.find((candidate) => candidate.sourceGroupId === "task-40");
  assert.equal(run?.status, "waiting_approval");
  assert.equal(run?.attempts[0]?.status, "waiting_approval");
  assert.equal(run?.attempts[0]?.completedAt, 30);
  assert.equal(run?.nextAction, "request_approval");
  assert.equal(run?.autoDispatchReady, false);
  assert.equal(run?.requiresManualIntervention, true);
});

test("replay inspection refreshes failed recovery next action from latest follow-up failure", () => {
  const existingRuns: RecoveryRun[] = [
    {
      recoveryRunId: buildRecoveryRunId("task-50"),
      threadId: "thread-1",
      sourceGroupId: "task-50",
      taskId: "task-50",
      roleId: "role-explore",
      targetLayer: "worker",
      targetWorker: "explore",
      latestStatus: "failed",
      status: "retrying",
      nextAction: "retry_same_layer",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "retry dispatched",
      currentAttemptId: "recovery:task-50:attempt:1",
      attempts: [
        {
          attemptId: "recovery:task-50:attempt:1",
          action: "retry",
          requestedAt: 10,
          updatedAt: 10,
          status: "retrying",
          nextAction: "retry_same_layer",
          summary: "retry dispatched",
          targetLayer: "worker",
          targetWorker: "explore",
          dispatchedTaskId: "task-51",
        },
      ],
      createdAt: 1,
      updatedAt: 10,
    },
  ];

  const records = [
    {
      replayId: "task-50:worker:worker:explore:task:task-50",
      layer: "worker",
      status: "failed",
      recordedAt: 5,
      threadId: "thread-1",
      taskId: "task-50",
      roleId: "role-explore",
      workerType: "explore",
      summary: "transport failed",
      failure: {
        category: "transport_failed",
        layer: "worker",
        retryable: true,
        message: "primary transport failed",
        recommendedAction: "fallback",
      },
    },
    {
      replayId: "task-51:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-51",
      roleId: "role-explore",
      summary: "retry dispatch",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-50",
          action: "retry_same_layer",
          dispatchReplayId: "task-51:scheduled",
        },
      },
    },
    {
      replayId: "task-51:worker:worker:explore:task:task-51",
      layer: "worker",
      status: "failed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-51",
      roleId: "role-explore",
      workerType: "explore",
      summary: "retry failed again",
      failure: {
        category: "transport_failed",
        layer: "worker",
        retryable: true,
        message: "fallback recommended",
        recommendedAction: "fallback",
      },
      metadata: {
        recoveryContext: {
          parentGroupId: "task-50",
          action: "retry_same_layer",
          dispatchReplayId: "task-51:scheduled",
        },
      },
    },
  ] as Parameters<typeof buildReplayInspectionReport>[0];

  const runs = buildRecoveryRuns(records, existingRuns, 100);
  const run = runs.find((candidate) => candidate.sourceGroupId === "task-50");
  assert.equal(run?.status, "failed");
  assert.equal(run?.attempts[0]?.status, "failed");
  assert.equal(run?.nextAction, "fallback_transport");
  assert.equal(run?.autoDispatchReady, true);
  assert.equal(run?.requiresManualIntervention, false);
});

test("replay inspection preserves superseded attempts when newer recovery attempt exists", () => {
  const existingRuns: RecoveryRun[] = [
    {
      recoveryRunId: buildRecoveryRunId("task-60"),
      threadId: "thread-1",
      sourceGroupId: "task-60",
      latestStatus: "failed",
      status: "resumed",
      nextAction: "auto_resume",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "resume dispatched",
      currentAttemptId: "recovery:task-60:attempt:2",
      attempts: [
        {
          attemptId: "recovery:task-60:attempt:1",
          action: "resume",
          requestedAt: 10,
          updatedAt: 20,
          status: "superseded",
          nextAction: "auto_resume",
          summary: "Superseded by recovery retry.",
          supersededByAttemptId: "recovery:task-60:attempt:2",
          supersededAt: 20,
          completedAt: 20,
          dispatchedTaskId: "task-61",
        },
        {
          attemptId: "recovery:task-60:attempt:2",
          action: "retry",
          requestedAt: 20,
          updatedAt: 20,
          status: "retrying",
          nextAction: "retry_same_layer",
          summary: "retry dispatched",
          dispatchedTaskId: "task-62",
        },
      ],
      createdAt: 1,
      updatedAt: 20,
    },
  ];

  const records = [
    {
      replayId: "task-62:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-62",
      summary: "retry dispatch accepted",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-60",
          action: "retry_same_layer",
          dispatchReplayId: "task-62:scheduled",
        },
      },
    },
  ] as Parameters<typeof buildReplayInspectionReport>[0];

  const runs = buildRecoveryRuns(records, existingRuns, 100);
  const run = runs.find((candidate) => candidate.sourceGroupId === "task-60");
  assert.equal(run?.attempts[0]?.status, "superseded");
  assert.equal(run?.attempts[0]?.supersededByAttemptId, "recovery:task-60:attempt:2");
  assert.equal(run?.attempts[1]?.status, "retrying");
});

test("recovery run progress summarizes active, settled, and superseded attempts", () => {
  const progress = buildRecoveryRunProgress({
    recoveryRunId: "recovery:task-70",
    threadId: "thread-1",
    sourceGroupId: "task-70",
    latestStatus: "failed",
    status: "retrying",
    nextAction: "retry_same_layer",
    autoDispatchReady: true,
    requiresManualIntervention: false,
    latestSummary: "retry in flight",
    currentAttemptId: "recovery:task-70:attempt:3",
    attempts: [
      {
        attemptId: "recovery:task-70:attempt:1",
        action: "resume",
        requestedAt: 1,
        updatedAt: 2,
        status: "superseded",
        nextAction: "auto_resume",
        summary: "superseded",
        supersededByAttemptId: "recovery:task-70:attempt:2",
        supersededAt: 2,
        completedAt: 2,
      },
      {
        attemptId: "recovery:task-70:attempt:2",
        action: "fallback",
        requestedAt: 3,
        updatedAt: 4,
        status: "failed",
        nextAction: "fallback_transport",
        summary: "fallback failed",
        completedAt: 4,
      },
      {
        attemptId: "recovery:task-70:attempt:3",
        action: "retry",
        requestedAt: 5,
        updatedAt: 6,
        status: "retrying",
        nextAction: "retry_same_layer",
        summary: "retrying now",
      },
    ],
    createdAt: 1,
    updatedAt: 6,
  });

  assert.equal(progress.phase, "retrying_same_layer");
  assert.equal(progress.phaseSummary, "retrying now");
  assert.equal(progress.totalAttempts, 3);
  assert.equal(progress.settledAttempts, 2);
  assert.equal(progress.supersededAttempts, 1);
  assert.equal(progress.failedAttempts, 1);
  assert.equal(progress.activeAttemptId, "recovery:task-70:attempt:3");
  assert.equal(progress.activeStatus, "retrying");
  assert.equal(progress.lastSettledAttemptId, "recovery:task-70:attempt:2");
});

test("recovery run progress exposes approval and resume phases", () => {
  const waiting = buildRecoveryRunProgress({
    recoveryRunId: "recovery:task-71",
    threadId: "thread-1",
    sourceGroupId: "task-71",
    latestStatus: "failed",
    status: "waiting_approval",
    nextAction: "request_approval",
    autoDispatchReady: false,
    requiresManualIntervention: true,
    latestSummary: "approval required",
    waitingReason: "approval required by external system",
    currentAttemptId: "recovery:task-71:attempt:1",
    attempts: [
      {
        attemptId: "recovery:task-71:attempt:1",
        action: "resume",
        requestedAt: 1,
        updatedAt: 2,
        status: "waiting_approval",
        nextAction: "request_approval",
        summary: "approval required",
        completedAt: 2,
      },
    ],
    createdAt: 1,
    updatedAt: 2,
  });
  assert.equal(waiting.phase, "awaiting_approval");
  assert.equal(waiting.phaseSummary, "approval required by external system");

  const resumed = buildRecoveryRunProgress({
    recoveryRunId: "recovery:task-72",
    threadId: "thread-1",
    sourceGroupId: "task-72",
    latestStatus: "partial",
    status: "resumed",
    nextAction: "auto_resume",
    autoDispatchReady: true,
    requiresManualIntervention: false,
    latestSummary: "approval granted; resuming",
    currentAttemptId: "recovery:task-72:attempt:2",
    attempts: [
      {
        attemptId: "recovery:task-72:attempt:1",
        action: "resume",
        requestedAt: 1,
        updatedAt: 2,
        status: "waiting_approval",
        nextAction: "request_approval",
        summary: "approval required",
        completedAt: 2,
      },
      {
        attemptId: "recovery:task-72:attempt:2",
        action: "approve",
        requestedAt: 3,
        updatedAt: 4,
        status: "resumed",
        nextAction: "auto_resume",
        summary: "approval granted; resuming",
      },
    ],
    createdAt: 1,
    updatedAt: 4,
  });
  assert.equal(resumed.phase, "resuming_session");
  assert.equal(resumed.activeAction, "approve");
});

test("recovery run preserves attempt causality and approval-resume chain", () => {
  const existingRuns: RecoveryRun[] = [
    {
      recoveryRunId: buildRecoveryRunId("task-80"),
      threadId: "thread-1",
      sourceGroupId: "task-80",
      taskId: "task-80",
      roleId: "role-operator",
      targetLayer: "worker",
      targetWorker: "browser",
      latestStatus: "failed",
      status: "waiting_approval",
      nextAction: "request_approval",
      autoDispatchReady: false,
      requiresManualIntervention: true,
      latestSummary: "approval required before continuing",
      waitingReason: "approval required before continuing",
      latestFailure: {
        category: "permission_denied",
        layer: "worker",
        retryable: false,
        message: "approval required before continuing",
        recommendedAction: "request_approval",
      },
      currentAttemptId: "recovery:task-80:attempt:2",
      attempts: [
        {
          attemptId: "recovery:task-80:attempt:1",
          action: "resume",
          requestedAt: 11,
          updatedAt: 20,
          status: "waiting_approval",
          nextAction: "auto_resume",
          summary: "approval required before continuing",
          completedAt: 20,
        },
        {
          attemptId: "recovery:task-80:attempt:2",
          action: "approve",
          requestedAt: 21,
          updatedAt: 21,
          status: "resumed",
          nextAction: "auto_resume",
          summary: "approval granted; resuming.",
          triggeredByAttemptId: "recovery:task-80:attempt:1",
          transitionReason: "manual_approval",
          dispatchedTaskId: "task-81",
        },
      ],
      createdAt: 10,
      updatedAt: 21,
    },
  ];

  const records = [
    {
      replayId: "task-80:worker:worker:browser:task:task-80",
      layer: "worker",
      status: "failed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-80",
      roleId: "role-operator",
      workerType: "browser",
      summary: "approval required before continuing",
      failure: {
        category: "permission_denied",
        layer: "worker",
        retryable: false,
        message: "approval required before continuing",
        recommendedAction: "request_approval",
      },
    },
    {
      replayId: "task-81:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 22,
      threadId: "thread-1",
      taskId: "task-81",
      roleId: "role-operator",
      summary: "approval dispatch resumed work",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-80",
          attemptId: "recovery:task-80:attempt:2",
        },
      },
    },
    {
      replayId: "task-81:worker:worker:browser:task:task-81",
      layer: "worker",
      status: "completed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-81",
      roleId: "role-operator",
      workerType: "browser",
      summary: "browser resumed successfully",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-80",
          attemptId: "recovery:task-80:attempt:2",
        },
        payload: {
          sessionId: "browser-session-1",
          targetId: "target-1",
          resumeMode: "hot",
          targetResolution: "attach",
        },
      },
    },
  ] as Parameters<typeof buildReplayInspectionReport>[0];

  const runs = buildRecoveryRuns(records, existingRuns, 100);
  assert.equal(runs[0]?.status, "recovered");
  assert.equal(runs[0]?.attempts[1]?.triggeredByAttemptId, "recovery:task-80:attempt:1");
  assert.equal(runs[0]?.attempts[1]?.transitionReason, "manual_approval");
});

test("recovery run escalates repeated retry failures into fallback", () => {
  const existingRuns: RecoveryRun[] = [
    {
      recoveryRunId: buildRecoveryRunId("task-90"),
      threadId: "thread-1",
      sourceGroupId: "task-90",
      taskId: "task-90",
      roleId: "role-explore",
      targetLayer: "worker",
      targetWorker: "explore",
      latestStatus: "failed",
      status: "retrying",
      nextAction: "retry_same_layer",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "retry in progress",
      currentAttemptId: "recovery:task-90:attempt:2",
      attempts: [
        {
          attemptId: "recovery:task-90:attempt:1",
          action: "retry",
          requestedAt: 10,
          updatedAt: 20,
          status: "failed",
          nextAction: "retry_same_layer",
          summary: "first retry failed",
          completedAt: 20,
          failure: {
            category: "transport_failed",
            layer: "worker",
            retryable: true,
            message: "fetch timed out",
            recommendedAction: "retry",
          },
        },
        {
          attemptId: "recovery:task-90:attempt:2",
          action: "retry",
          requestedAt: 21,
          updatedAt: 30,
          status: "failed",
          nextAction: "retry_same_layer",
          summary: "second retry failed",
          completedAt: 30,
          failure: {
            category: "transport_failed",
            layer: "worker",
            retryable: true,
            message: "fetch timed out again",
            recommendedAction: "retry",
          },
        },
      ],
      createdAt: 10,
      updatedAt: 30,
    },
  ];

  const records = [
    {
      replayId: "task-90:worker:worker:explore:task:task-90",
      layer: "worker",
      status: "failed",
      recordedAt: 31,
      threadId: "thread-1",
      taskId: "task-90",
      roleId: "role-explore",
      workerType: "explore",
      summary: "retry still failing",
      failure: {
        category: "transport_failed",
        layer: "worker",
        retryable: true,
        message: "fetch timed out again",
        recommendedAction: "retry",
      },
    },
  ] as Parameters<typeof buildReplayInspectionReport>[0];

  const runs = buildRecoveryRuns(records, existingRuns, 100);
  assert.equal(runs[0]?.status, "failed");
  assert.equal(runs[0]?.nextAction, "fallback_transport");
  assert.equal(runs[0]?.requiresManualIntervention, false);
});

test("recovery run downgrades repeated fallback failures to inspect", () => {
  const existingRuns: RecoveryRun[] = [
    {
      recoveryRunId: buildRecoveryRunId("task-91"),
      threadId: "thread-1",
      sourceGroupId: "task-91",
      taskId: "task-91",
      roleId: "role-explore",
      targetLayer: "worker",
      targetWorker: "explore",
      latestStatus: "failed",
      status: "fallback_running",
      nextAction: "fallback_transport",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "fallback in progress",
      currentAttemptId: "recovery:task-91:attempt:2",
      attempts: [
        {
          attemptId: "recovery:task-91:attempt:1",
          action: "fallback",
          requestedAt: 10,
          updatedAt: 20,
          status: "failed",
          nextAction: "fallback_transport",
          summary: "first fallback failed",
          completedAt: 20,
          failure: {
            category: "transport_failed",
            layer: "worker",
            retryable: true,
            message: "tool fallback failed",
            recommendedAction: "fallback",
          },
        },
        {
          attemptId: "recovery:task-91:attempt:2",
          action: "fallback",
          requestedAt: 21,
          updatedAt: 30,
          status: "failed",
          nextAction: "fallback_transport",
          summary: "second fallback failed",
          completedAt: 30,
          failure: {
            category: "transport_failed",
            layer: "worker",
            retryable: true,
            message: "browser fallback failed",
            recommendedAction: "fallback",
          },
        },
      ],
      createdAt: 10,
      updatedAt: 30,
    },
  ];

  const records = [
    {
      replayId: "task-91:worker:worker:explore:task:task-91",
      layer: "worker",
      status: "failed",
      recordedAt: 31,
      threadId: "thread-1",
      taskId: "task-91",
      roleId: "role-explore",
      workerType: "explore",
      summary: "fallback still failing",
      failure: {
        category: "transport_failed",
        layer: "worker",
        retryable: true,
        message: "browser fallback failed again",
        recommendedAction: "fallback",
      },
    },
  ] as Parameters<typeof buildReplayInspectionReport>[0];

  const runs = buildRecoveryRuns(records, existingRuns, 100);
  assert.equal(runs[0]?.status, "failed");
  assert.equal(runs[0]?.nextAction, "inspect_then_resume");
  assert.equal(runs[0]?.requiresManualIntervention, true);
});

test("recovery run derives browser-specific recovery outcomes from follow-up replays", () => {
  const existingRuns: RecoveryRun[] = [
    {
      recoveryRunId: buildRecoveryRunId("task-92"),
      threadId: "thread-1",
      sourceGroupId: "task-92",
      taskId: "task-92",
      roleId: "role-operator",
      targetLayer: "worker",
      targetWorker: "browser",
      latestStatus: "failed",
      status: "resumed",
      nextAction: "auto_resume",
      autoDispatchReady: true,
      requiresManualIntervention: false,
      latestSummary: "resume dispatched",
      currentAttemptId: "recovery:task-92:attempt:1",
      attempts: [
        {
          attemptId: "recovery:task-92:attempt:1",
          action: "resume",
          requestedAt: 10,
          updatedAt: 11,
          status: "resumed",
          nextAction: "auto_resume",
          summary: "resume dispatched",
          dispatchedTaskId: "task-93",
          targetLayer: "worker",
          targetWorker: "browser",
        },
      ],
      createdAt: 10,
      updatedAt: 11,
    },
  ];

  const records = [
    {
      replayId: "task-92:worker:worker:browser:task:task-92",
      layer: "worker",
      status: "failed",
      recordedAt: 9,
      threadId: "thread-1",
      taskId: "task-92",
      roleId: "role-operator",
      workerType: "browser",
      summary: "detached target",
      failure: {
        category: "stale_session",
        layer: "worker",
        retryable: true,
        message: "target detached",
        recommendedAction: "resume",
      },
    },
    {
      replayId: "task-93:worker:worker:browser:task:task-93",
      layer: "worker",
      status: "completed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-93",
      roleId: "role-operator",
      workerType: "browser",
      summary: "detached target reconnected",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-92",
          attemptId: "recovery:task-92:attempt:1",
        },
        payload: {
          sessionId: "browser-session-2",
          targetId: "target-2",
          resumeMode: "warm",
          targetResolution: "reconnect",
        },
      },
    },
  ] as Parameters<typeof buildReplayInspectionReport>[0];

  const runs = buildRecoveryRuns(records, existingRuns, 100);
  assert.equal(runs[0]?.attempts[0]?.status, "recovered");
  assert.equal(runs[0]?.attempts[0]?.browserOutcome, "detached_target_recovered");
});
