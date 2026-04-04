import assert from "node:assert/strict";
import test from "node:test";

import type { FlowLedger, PermissionCacheRecord, RecoveryRun, ReplayRecord, RuntimeProgressEvent, TeamEvent } from "@turnkeyai/core-types/team";

import {
  buildOperatorAttentionReport,
  buildFlowConsoleReport,
  buildGovernanceConsoleReport,
  buildOperatorSummaryReport,
  buildOperatorTriageReport,
  buildRecoveryConsoleReport,
} from "./operator-inspection";
import { buildRecoveryRunId } from "./replay-inspection";
import { buildDerivedRecoveryRuntimeChain, buildRuntimeSummaryReport } from "./runtime-chain-inspection";

test("operator inspection summarizes flow shard issues", () => {
  const flows: FlowLedger[] = [
    {
      flowId: "flow-1",
      threadId: "thread-1",
      rootMessageId: "msg-1",
      mode: "parallel",
      status: "running",
      currentStageIndex: 1,
      activeRoleIds: ["lead", "researcher-a"],
      completedRoleIds: [],
      failedRoleIds: [],
      nextExpectedRoleId: "researcher-b",
      hopCount: 2,
      maxHops: 6,
      edges: [],
      shardGroups: [
        {
          groupId: "group-1",
          parentTaskId: "task-1",
          sourceMessageId: "msg-1",
          mergeBackToRoleId: "lead",
          kind: "research",
          status: "waiting_retry",
          expectedRoleIds: ["researcher-a", "researcher-b", "researcher-c"],
          completedRoleIds: ["researcher-a", "researcher-b"],
          failedRoleIds: [],
          cancelledRoleIds: [],
          retryCounts: { "researcher-c": 1 },
          shardResults: [
            {
              roleId: "researcher-a",
              status: "completed",
              summary: "Revenue is $10M. Margin is 20%.",
              summaryDigest: "dup",
              updatedAt: 10,
            },
            {
              roleId: "researcher-b",
              status: "completed",
              summary: "Revenue is $10M. Margin is 20%.",
              summaryDigest: "dup",
              updatedAt: 11,
            },
            {
              roleId: "researcher-c",
              status: "failed",
              summary: "timeout",
              summaryDigest: "timeout",
              updatedAt: 12,
            },
          ],
          createdAt: 1,
          updatedAt: 12,
        },
        {
          groupId: "group-2",
          parentTaskId: "task-2",
          sourceMessageId: "msg-2",
          mergeBackToRoleId: "lead",
          kind: "research",
          status: "ready_to_merge",
          expectedRoleIds: ["researcher-d", "researcher-e"],
          completedRoleIds: ["researcher-d", "researcher-e"],
          failedRoleIds: [],
          cancelledRoleIds: [],
          retryCounts: {},
          shardResults: [
            {
              roleId: "researcher-d",
              status: "completed",
              summary: "Conflict: conversion rate is 12%.",
              summaryDigest: "d",
              updatedAt: 13,
            },
            {
              roleId: "researcher-e",
              status: "completed",
              summary: "Conflict: conversion rate is 15%.",
              summaryDigest: "e",
              updatedAt: 14,
            },
          ],
          createdAt: 2,
          updatedAt: 14,
        },
      ],
      createdAt: 1,
      updatedAt: 14,
    },
  ];

  const report = buildFlowConsoleReport(flows);
  assert.equal(report.totalFlows, 1);
  assert.equal(report.totalShardGroups, 2);
  assert.equal(report.attentionCount, 2);
  assert.equal(report.attentionStateCounts.recovering, 1);
  assert.equal(report.attentionStateCounts.blocked, 1);
  assert.equal(report.groupsWithMissingRoles, 1);
  assert.equal(report.groupsWithRetries, 1);
  assert.equal(report.groupsWithDuplicates, 1);
  assert.equal(report.groupsWithConflicts, 1);
  assert.equal(report.attentionGroups.length, 2);
  assert.equal(report.attentionGroups[0]?.groupId, "group-1");
  assert.equal(report.attentionGroups[0]?.caseState, "recovering");
  assert.deepEqual(report.attentionGroups[0]?.reasons, ["missing", "retry", "duplicate"]);
  assert.equal(report.attentionGroups[1]?.groupId, "group-2");
  assert.equal(report.attentionGroups[1]?.caseState, "blocked");
  assert.deepEqual(report.attentionGroups[1]?.reasons, ["conflict"]);
});

test("operator inspection summarizes governance transport and admission state", () => {
  const permissionRecords: PermissionCacheRecord[] = [
    {
      cacheKey: "perm-1",
      threadId: "thread-1",
      workerType: "explore",
      requirement: {
        level: "approval",
        scope: "publish",
        rationale: "publishing requires approval",
        cacheKey: "perm-1",
      },
      decision: "prompt_required",
      createdAt: 1,
      updatedAt: 2,
    },
    {
      cacheKey: "perm-2",
      threadId: "thread-1",
      workerType: "browser",
      requirement: {
        level: "confirm",
        scope: "navigate",
        rationale: "browser navigation should be confirmed",
        cacheKey: "perm-2",
      },
      decision: "granted",
      createdAt: 3,
      updatedAt: 4,
    },
  ];

  const events: TeamEvent[] = [
    {
      eventId: "evt-1",
      threadId: "thread-1",
      kind: "audit.logged",
      createdAt: 10,
      payload: {
        workerType: "explore",
        status: "partial",
        transport: "browser",
        trustLevel: "observational",
        admissionMode: "summary_only",
        permission: {
          recommendedAction: "fallback_browser",
        },
      },
    },
    {
      eventId: "evt-2",
      threadId: "thread-1",
      kind: "audit.logged",
      createdAt: 11,
      payload: {
        workerType: "browser",
        status: "completed",
        transport: "browser",
        trustLevel: "promotable",
        admissionMode: "full",
        permission: {
          recommendedAction: "proceed",
        },
      },
    },
  ];

  const report = buildGovernanceConsoleReport(permissionRecords, events);
  assert.equal(report.totalPermissionRecords, 2);
  assert.equal(report.attentionCount, 1);
  assert.equal(report.permissionDecisionCounts.prompt_required, 1);
  assert.equal(report.transportCounts.browser, 2);
  assert.equal(report.trustCounts.observational, 1);
  assert.equal(report.admissionCounts.summary_only, 1);
  assert.equal(report.recommendedActionCounts.fallback_browser, 1);
  assert.equal(report.latestAudits[0]?.eventId, "evt-2");
});

test("operator inspection does not keep merge-ready retries in attention groups", () => {
  const flows: FlowLedger[] = [
    {
      flowId: "flow-ready",
      threadId: "thread-1",
      rootMessageId: "msg-1",
      mode: "parallel",
      status: "running",
      currentStageIndex: 1,
      activeRoleIds: ["lead"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 3,
      maxHops: 6,
      edges: [],
      shardGroups: [
        {
          groupId: "group-ready",
          parentTaskId: "task-ready",
          sourceMessageId: "msg-1",
          mergeBackToRoleId: "lead",
          kind: "research",
          status: "ready_to_merge",
          expectedRoleIds: ["role-a", "role-b"],
          completedRoleIds: ["role-a", "role-b"],
          failedRoleIds: [],
          cancelledRoleIds: [],
          retryCounts: { "role-b": 1 },
          shardResults: [
            {
              roleId: "role-a",
              status: "completed",
              summary: "Revenue is $10M.",
              summaryDigest: "a",
              updatedAt: 10,
            },
            {
              roleId: "role-b",
              status: "completed",
              summary: "Margin is 20%.",
              summaryDigest: "b",
              updatedAt: 11,
            },
          ],
          createdAt: 1,
          updatedAt: 11,
        },
      ],
      createdAt: 1,
      updatedAt: 11,
    },
  ];

  const report = buildFlowConsoleReport(flows);
  assert.equal(report.groupsWithRetries, 1);
  assert.equal(report.attentionCount, 0);
  assert.equal(report.attentionGroups.length, 0);
  assert.equal(report.attentionStateCounts.recovering ?? 0, 0);
});

test("operator inspection builds one operator summary from flow, replay, and governance reports", () => {
  const summary = buildOperatorSummaryReport({
    flows: [
      {
        flowId: "flow-op",
        threadId: "thread-1",
        rootMessageId: "msg-1",
        mode: "parallel",
        status: "running",
        currentStageIndex: 1,
        activeRoleIds: ["lead"],
        completedRoleIds: [],
        failedRoleIds: [],
        hopCount: 2,
        maxHops: 6,
        edges: [],
        shardGroups: [
          {
            groupId: "group-op",
            parentTaskId: "task-op",
            sourceMessageId: "msg-1",
            mergeBackToRoleId: "lead",
            kind: "research",
            status: "waiting_retry",
            expectedRoleIds: ["role-a", "role-b"],
            completedRoleIds: ["role-a"],
            failedRoleIds: [],
            cancelledRoleIds: [],
            retryCounts: { "role-b": 1 },
            shardResults: [
              {
                roleId: "role-a",
                status: "completed",
                summary: "Revenue is $10M.",
                summaryDigest: "a",
                updatedAt: 10,
              },
            ],
            createdAt: 1,
            updatedAt: 10,
          },
        ],
        createdAt: 1,
        updatedAt: 10,
      },
    ],
    permissionRecords: [
      {
        cacheKey: "perm-op",
        threadId: "thread-1",
        workerType: "explore",
        requirement: {
          level: "approval",
          scope: "publish",
          rationale: "publishing requires approval",
          cacheKey: "perm-op",
        },
        decision: "prompt_required",
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    events: [
      {
        eventId: "evt-op",
        threadId: "thread-1",
        kind: "audit.logged",
        createdAt: 10,
        payload: {
          workerType: "explore",
          status: "partial",
          transport: "browser",
          trustLevel: "observational",
          admissionMode: "summary_only",
          permission: {
            recommendedAction: "fallback_browser",
          },
        },
      },
    ],
    replays: [
      {
        replayId: "task-op:worker:worker:browser:task:task-op",
        layer: "worker",
        status: "failed",
        recordedAt: 10,
        threadId: "thread-1",
        taskId: "task-op",
        roleId: "lead",
        workerType: "browser",
      summary: "browser target detached",
      failure: {
        category: "stale_session",
        layer: "worker",
        retryable: true,
        message: "browser target detached",
        recommendedAction: "resume",
      },
      metadata: {
        payload: {
          sessionId: "browser-1",
          targetId: "target-1",
          transportMode: "relay",
          transportLabel: "chrome-relay",
          resumeMode: "warm",
          targetResolution: "reconnect",
        },
      },
    },
  ],
    recoveryRuns: [
      {
        recoveryRunId: buildRecoveryRunId("task-op"),
        threadId: "thread-1",
        sourceGroupId: "task-op",
        latestStatus: "failed",
        status: "waiting_approval",
        nextAction: "request_approval",
        autoDispatchReady: false,
        requiresManualIntervention: true,
        latestSummary: "Approval required before browser resume.",
        waitingReason: "Operator approval required.",
        latestFailure: {
          category: "permission_denied",
          message: "Approval required.",
          layer: "worker",
          retryable: false,
          recommendedAction: "request_approval",
        },
        currentAttemptId: "attempt-1",
        browserSession: {
          sessionId: "browser-1",
          targetId: "target-1",
          resumeMode: "warm",
        },
        attempts: [
          {
            attemptId: "attempt-1",
            action: "approve",
            requestedAt: 10,
            updatedAt: 11,
            status: "waiting_approval",
            nextAction: "request_approval",
            summary: "Approval pending.",
            browserOutcome: "warm_attach",
          },
        ],
        createdAt: 10,
        updatedAt: 11,
      },
    ],
    progressEvents: [
      buildPromptBoundary({
        progressId: "progress:prompt-op",
        recordedAt: 12,
        boundaryKind: "request_envelope_reduction",
        taskId: "task-op",
        summary: "Prompt request envelope reduced to reference-only.",
        reductionLevel: "reference-only",
      }),
    ],
  });

  assert.equal(summary.flow.attentionCount, 1);
  assert.equal(summary.replay.attentionCount, 1);
  assert.equal(summary.governance.attentionCount, 1);
  assert.equal(summary.recovery.attentionCount, 1);
  assert.equal(summary.prompt.totalBoundaries, 1);
  assert.equal(summary.promptAttentionCount, 1);
  assert.equal(summary.totalAttentionCount, 5);
  assert.equal(summary.replay.operatorCaseStateCounts.waiting_manual, 1);
  assert.equal(summary.attentionOverview?.uniqueCaseCount, 4);
  assert.equal(summary.attentionOverview?.caseStateCounts.open, 1);
  assert.equal(summary.attentionOverview?.caseStateCounts.recovering, 1);
  assert.equal(summary.attentionOverview?.caseStateCounts.blocked, 2);
  assert.equal(summary.attentionOverview?.caseStateCounts.waiting_manual, 1);
  assert.equal(summary.attentionOverview?.caseStateCounts.resolved, 0);
  assert.equal(summary.attentionOverview?.severityCounts.critical, 3);
  assert.equal(summary.attentionOverview?.severityCounts.warning, 2);
  assert.equal(summary.attentionOverview?.lifecycleCounts.open, 1);
  assert.equal(summary.attentionOverview?.lifecycleCounts.recovering, 1);
  assert.equal(summary.attentionOverview?.lifecycleCounts.blocked, 2);
  assert.equal(summary.attentionOverview?.lifecycleCounts.waiting_manual, 1);
  assert.equal(summary.attentionOverview?.activeCases?.length, 4);
  assert.deepEqual(
    (summary.attentionOverview?.activeCases ?? []).map((entry) => entry.caseKey),
    ["prompt:task-op", "governance:evt-op", "flow:flow-op:group-op", "incident:task-op"]
  );
  const activeCasesByKey = Object.fromEntries((summary.attentionOverview?.activeCases ?? []).map((entry) => [entry.caseKey, entry]));
  assert.match(activeCasesByKey["prompt:task-op"]?.headline ?? "", /prompt:task-op blocked via prompt/);
  assert.equal(activeCasesByKey["prompt:task-op"]?.gate, "request_envelope_reduction");
  assert.equal(activeCasesByKey["prompt:task-op"]?.action, "inspect_prompt_boundary");
  assert.equal(activeCasesByKey["prompt:task-op"]?.reasonPreview, "reference-only");
  assert.equal(activeCasesByKey["prompt:task-op"]?.nextStep, "inspect_prompt_boundary");
  assert.match(activeCasesByKey["prompt:task-op"]?.latestUpdate ?? "", /reference-only/);
  assert.match(activeCasesByKey["governance:evt-op"]?.headline ?? "", /governance:evt-op blocked via governance/);
  assert.match(activeCasesByKey["flow:flow-op:group-op"]?.headline ?? "", /flow:flow-op:group-op recovering via flow/);
  assert.equal(activeCasesByKey["governance:evt-op"]?.gate, "fallback_browser");
  assert.equal(activeCasesByKey["governance:evt-op"]?.action, "fallback_browser");
  assert.equal(activeCasesByKey["governance:evt-op"]?.reasonPreview, "browser");
  assert.equal(activeCasesByKey["governance:evt-op"]?.nextStep, "fallback_browser");
  assert.match(activeCasesByKey["governance:evt-op"]?.latestUpdate ?? "", /requires attention/);
  assert.equal(activeCasesByKey["incident:task-op"]?.gate, "waiting for approval");
  assert.equal(activeCasesByKey["incident:task-op"]?.action, "request_approval");
  assert.deepEqual(activeCasesByKey["incident:task-op"]?.allowedActions, ["approve", "reject"]);
  assert.match(activeCasesByKey["incident:task-op"]?.reasonPreview ?? "", /\S+/);
  assert.equal(activeCasesByKey["incident:task-op"]?.browserContinuityState, "recovered");
  assert.equal(activeCasesByKey["incident:task-op"]?.browserTransportLabel, "chrome-relay");
  assert.equal(summary.replay.latestBundles[0]?.operatorCaseState, "waiting_manual");
  assert.equal(summary.replay.latestBundles[0]?.operatorGate, "waiting for approval");
  assert.deepEqual(summary.replay.latestBundles[0]?.operatorAllowedActions, ["approve", "reject"]);
  assert.equal(summary.replay.latestBundles[0]?.browserTransportLabel, "chrome-relay");
  assert.equal(summary.attentionOverview?.topCases?.[0]?.caseKey, "prompt:task-op");
});

test("operator summary surfaces resolved case count from replay console", () => {
  const records: ReplayRecord[] = [
    {
      replayId: "task-resolved:worker:worker:browser:task:task-resolved",
      layer: "worker",
      status: "failed",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-resolved",
      roleId: "lead",
      workerType: "browser",
      summary: "browser detached",
      failure: {
        category: "stale_session",
        layer: "worker",
        retryable: true,
        message: "browser detached",
        recommendedAction: "resume",
      },
      metadata: {
        payload: {
          sessionId: "browser-1",
          targetId: "target-1",
          transportLabel: "chrome-relay",
          resumeMode: "warm",
          targetResolution: "reconnect",
        },
      },
    },
    {
      replayId: "task-resolved-follow:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-resolved-follow",
      roleId: "lead",
      summary: "recovery dispatch created",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-resolved",
          action: "auto_resume",
          dispatchReplayId: "task-resolved-follow:scheduled",
        },
      },
    },
    {
      replayId: "task-resolved-follow:worker:worker:browser:task:task-resolved-follow",
      layer: "worker",
      status: "completed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-resolved-follow",
      roleId: "lead",
      workerType: "browser",
      summary: "browser recovered",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-resolved",
          action: "auto_resume",
          dispatchReplayId: "task-resolved-follow:scheduled",
        },
        payload: {
          sessionId: "browser-1",
          targetId: "target-1",
          resumeMode: "cold",
          targetResolution: "reopen",
        },
      },
    },
    {
      replayId: "task-resolved-2:worker:worker:browser:task:task-resolved-2",
      layer: "worker",
      status: "failed",
      recordedAt: 40,
      threadId: "thread-1",
      taskId: "task-resolved-2",
      roleId: "lead",
      workerType: "browser",
      summary: "browser detached again",
      failure: {
        category: "stale_session",
        layer: "worker",
        retryable: true,
        message: "browser detached again",
        recommendedAction: "resume",
      },
      metadata: {
        payload: {
          sessionId: "browser-2",
          targetId: "target-2",
          transportLabel: "local-automation",
          resumeMode: "warm",
          targetResolution: "reconnect",
        },
      },
    },
    {
      replayId: "task-resolved-2-follow:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 50,
      threadId: "thread-1",
      taskId: "task-resolved-2-follow",
      roleId: "lead",
      summary: "second recovery dispatch created",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-resolved-2",
          action: "auto_resume",
          dispatchReplayId: "task-resolved-2-follow:scheduled",
        },
      },
    },
    {
      replayId: "task-resolved-2-follow:worker:worker:browser:task:task-resolved-2-follow",
      layer: "worker",
      status: "completed",
      recordedAt: 60,
      threadId: "thread-1",
      taskId: "task-resolved-2-follow",
      roleId: "lead",
      workerType: "browser",
      summary: "second browser recovered",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-resolved-2",
          action: "auto_resume",
          dispatchReplayId: "task-resolved-2-follow:scheduled",
        },
        payload: {
          sessionId: "browser-2",
          targetId: "target-2",
          resumeMode: "cold",
          targetResolution: "reopen",
        },
      },
    },
  ];

  const summary = buildOperatorSummaryReport({
    flows: [],
    permissionRecords: [],
    events: [],
    replays: records,
    recoveryRuns: [],
  });

  assert.equal(summary.totalAttentionCount, 0);
  assert.equal(summary.attentionOverview?.uniqueCaseCount, 0);
  assert.equal(summary.attentionOverview?.caseStateCounts.resolved, 2);
  assert.equal(summary.attentionOverview?.activeCases?.length, 0);
  assert.equal(summary.attentionOverview?.resolvedRecentCases?.length, 2);
  assert.match(summary.attentionOverview?.resolvedRecentCases?.[0]?.caseKey ?? "", /^incident:task-resolved-2/);
  assert.match(summary.attentionOverview?.resolvedRecentCases?.[1]?.caseKey ?? "", /^incident:task-resolved/);
  assert.equal(summary.attentionOverview?.resolvedRecentCases?.[0]?.source, "replay");
  assert.equal(summary.attentionOverview?.resolvedRecentCases?.[0]?.gate, "recovered");
  assert.equal(summary.attentionOverview?.resolvedRecentCases?.[0]?.browserContinuityState, "recovered");
  assert.equal(summary.attentionOverview?.resolvedRecentCases?.[0]?.browserTransportLabel, "local-automation");
});

test("operator summary does not classify recovery-gated replay bundles as resolved recent cases", () => {
  const records: ReplayRecord[] = [
    {
      replayId: "task-manual-resolved:worker:worker:browser:task:task-manual-resolved",
      layer: "worker",
      status: "failed",
      recordedAt: 10,
      threadId: "thread-1",
      taskId: "task-manual-resolved",
      roleId: "lead",
      workerType: "browser",
      summary: "browser detached",
      failure: {
        category: "stale_session",
        layer: "worker",
        retryable: true,
        message: "browser detached",
        recommendedAction: "resume",
      },
    },
    {
      replayId: "task-manual-resolved-follow:scheduled",
      layer: "scheduled",
      status: "completed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-manual-resolved-follow",
      roleId: "lead",
      summary: "recovery dispatch created",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-manual-resolved",
          attemptId: "recovery:task-manual-resolved:attempt:1",
          dispatchReplayId: "task-manual-resolved-follow:scheduled",
        },
      },
    },
    {
      replayId: "task-manual-resolved-follow:worker:worker:browser:task:task-manual-resolved-follow",
      layer: "worker",
      status: "completed",
      recordedAt: 30,
      threadId: "thread-1",
      taskId: "task-manual-resolved-follow",
      roleId: "lead",
      workerType: "browser",
      summary: "browser continuity recovered; operator follow-up still pending",
      metadata: {
        recoveryContext: {
          parentGroupId: "task-manual-resolved",
          attemptId: "recovery:task-manual-resolved:attempt:1",
          dispatchReplayId: "task-manual-resolved-follow:scheduled",
        },
      },
    },
  ];

  const summary = buildOperatorSummaryReport({
    flows: [],
    permissionRecords: [],
    events: [],
    replays: records,
    recoveryRuns: [
      {
        recoveryRunId: buildRecoveryRunId("task-manual-resolved"),
        threadId: "thread-1",
        sourceGroupId: "task-manual-resolved",
        latestStatus: "partial",
        status: "waiting_external",
        nextAction: "inspect_then_resume",
        autoDispatchReady: false,
        requiresManualIntervention: true,
        latestSummary: "Recovered browser continuity; waiting on manual follow-up.",
        waitingReason: "manual follow-up pending",
        currentAttemptId: "attempt-1",
        attempts: [
          {
            attemptId: "attempt-1",
            action: "resume",
            requestedAt: 20,
            updatedAt: 30,
            status: "waiting_external",
            nextAction: "inspect_then_resume",
            summary: "Recovered browser continuity; waiting on manual follow-up.",
          },
        ],
        createdAt: 20,
        updatedAt: 30,
      },
    ],
  });

  assert.equal(summary.attentionOverview?.resolvedRecentCases?.length ?? 0, 0);
});

test("operator inspection summarizes recovery run phases and browser outcomes", () => {
  const report = buildRecoveryConsoleReport([
    {
      recoveryRunId: buildRecoveryRunId("group-1"),
      threadId: "thread-1",
      sourceGroupId: "group-1",
      latestStatus: "failed",
      status: "waiting_approval",
      nextAction: "request_approval",
      autoDispatchReady: false,
      requiresManualIntervention: true,
      latestSummary: "Approval pending.",
      waitingReason: "Approval pending.",
      currentAttemptId: "attempt-1",
      browserSession: {
        sessionId: "browser-1",
        targetId: "target-1",
        resumeMode: "warm",
      },
      attempts: [
        {
          attemptId: "attempt-1",
          action: "approve",
          requestedAt: 10,
          updatedAt: 11,
          status: "waiting_approval",
          nextAction: "request_approval",
          summary: "Approval pending.",
          browserOutcome: "warm_attach",
        },
      ],
      createdAt: 10,
      updatedAt: 11,
    },
    {
      recoveryRunId: buildRecoveryRunId("group-2"),
      threadId: "thread-1",
      sourceGroupId: "group-2",
      latestStatus: "completed",
      status: "recovered",
      nextAction: "none",
      autoDispatchReady: false,
      requiresManualIntervention: false,
      latestSummary: "Recovered.",
      attempts: [
        {
          attemptId: "attempt-2",
          action: "resume",
          requestedAt: 20,
          updatedAt: 21,
          status: "recovered",
          nextAction: "none",
          summary: "Recovered.",
          browserOutcome: "hot_reuse",
          completedAt: 21,
        },
      ],
      createdAt: 20,
      updatedAt: 21,
    },
  ]);

  assert.equal(report.totalRuns, 2);
  assert.equal(report.attentionCount, 1);
  assert.equal(report.statusCounts.waiting_approval, 1);
  assert.equal(report.statusCounts.recovered, 1);
  assert.equal(report.phaseCounts.awaiting_approval, 1);
  assert.equal(report.phaseCounts.recovered, 1);
  assert.equal(report.gateCounts["waiting for approval"], 1);
  assert.equal(report.gateCounts.recovered, 1);
  assert.equal(report.nextActionCounts.request_approval, 1);
  assert.equal(report.nextActionCounts.none, 1);
  assert.equal(report.browserResumeCounts.warm, 1);
  assert.equal(report.browserOutcomeCounts.warm_attach, 1);
  assert.equal(report.browserOutcomeCounts.hot_reuse, 1);
});

test("operator inspection flattens cross-surface attention items", () => {
  const report = buildOperatorAttentionReport({
    flows: [
      {
        flowId: "flow-1",
        threadId: "thread-1",
        rootMessageId: "msg-1",
        mode: "parallel",
        status: "running",
        currentStageIndex: 1,
        activeRoleIds: ["lead"],
        completedRoleIds: [],
        failedRoleIds: [],
        hopCount: 1,
        maxHops: 6,
        edges: [],
        shardGroups: [
          {
            groupId: "group-1",
            parentTaskId: "task-1",
            sourceMessageId: "msg-1",
            mergeBackToRoleId: "lead",
            kind: "research",
            status: "waiting_retry",
            expectedRoleIds: ["role-a", "role-b"],
            completedRoleIds: ["role-a"],
            failedRoleIds: [],
            cancelledRoleIds: [],
            retryCounts: { "role-b": 1 },
            shardResults: [
              {
                roleId: "role-a",
                status: "completed",
                summary: "Revenue is $10M.",
                summaryDigest: "a",
                updatedAt: 10,
              },
            ],
            createdAt: 1,
            updatedAt: 10,
          },
        ],
        createdAt: 1,
        updatedAt: 10,
      },
    ],
    permissionRecords: [
      {
        cacheKey: "perm-1",
        threadId: "thread-1",
        workerType: "explore",
        requirement: {
          level: "approval",
          scope: "publish",
          rationale: "approval required",
          cacheKey: "perm-1",
        },
        decision: "prompt_required",
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    events: [
      {
        eventId: "evt-1",
        threadId: "thread-1",
        kind: "audit.logged",
        createdAt: 20,
        payload: {
          workerType: "explore",
          status: "partial",
          transport: "browser",
          permission: {
            recommendedAction: "fallback_browser",
          },
        },
      },
    ],
    replays: [
      {
        replayId: "task-1:worker:worker:browser:task:task-1",
        layer: "worker",
        status: "failed",
        recordedAt: 30,
        threadId: "thread-1",
        taskId: "task-1",
        summary: "browser target detached",
        failure: {
          category: "stale_session",
          layer: "worker",
          retryable: true,
          message: "browser target detached",
          recommendedAction: "resume",
        },
        metadata: {
          payload: {
            sessionId: "browser-session-1",
            targetId: "target-1",
            transportLabel: "chrome-relay",
            transportPeerId: "peer-1",
            transportTargetId: "chrome-tab:1",
            resumeMode: "warm",
            targetResolution: "reconnect",
          },
        },
      },
    ],
    recoveryRuns: [
      {
        recoveryRunId: buildRecoveryRunId("task-1"),
        threadId: "thread-1",
        sourceGroupId: "task-1",
        latestStatus: "failed",
        status: "waiting_approval",
        nextAction: "request_approval",
        autoDispatchReady: false,
        requiresManualIntervention: true,
        latestSummary: "Approval required.",
        waitingReason: "Approval required.",
        currentAttemptId: "attempt-1",
        attempts: [
          {
            attemptId: "attempt-1",
            action: "approve",
            requestedAt: 21,
            updatedAt: 22,
            status: "waiting_approval",
            nextAction: "request_approval",
            summary: "Approval pending.",
          },
        ],
        createdAt: 21,
        updatedAt: 22,
      },
    ],
    progressEvents: [
      buildPromptBoundary({
        progressId: "progress:prompt-task-1",
        recordedAt: 40,
        boundaryKind: "request_envelope_reduction",
        taskId: "task-1",
        summary: "Prompt request envelope reduced to reference-only.",
        reductionLevel: "reference-only",
      }),
    ],
    relayDiagnostics: {
      peers: [
        {
          peerId: "peer-1",
          transportLabel: "chrome-relay",
          lastSeenAt: 50,
          status: "stale",
        },
      ],
      targets: [],
    },
    limit: 10,
  });

  assert.equal(report.totalItems, 5);
  assert.equal(report.returnedItems, 5);
  assert.equal(report.uniqueCaseCount, 4);
  assert.equal(report.returnedCases, 4);
  assert.equal(report.sourceCounts.flow, 1);
  assert.equal(report.sourceCounts.replay, 1);
  assert.equal(report.sourceCounts.governance, 1);
  assert.equal(report.sourceCounts.recovery, 1);
  assert.equal(report.sourceCounts.prompt, 1);
  assert.equal(report.caseStateCounts.open, 1);
  assert.equal(report.caseStateCounts.recovering, 1);
  assert.equal(report.caseStateCounts.blocked, 2);
  assert.equal(report.caseStateCounts.waiting_manual, 1);
  assert.equal(report.severityCounts.critical, 3);
  assert.equal(report.severityCounts.warning, 2);
  assert.equal(report.lifecycleCounts.waiting_manual, 1);
  assert.equal(report.lifecycleCounts.blocked, 2);
  assert.equal(report.lifecycleCounts.recovering, 1);
  assert.equal(report.lifecycleCounts.open, 1);
  const casesByKey = Object.fromEntries(report.cases.map((entry) => [entry.caseKey, entry]));
  assert.equal(casesByKey["prompt:task-1"]?.caseState, "blocked");
  assert.equal(casesByKey["prompt:task-1"]?.itemCount, 1);
  assert.deepEqual(casesByKey["prompt:task-1"]?.sources, ["prompt"]);
  assert.equal(casesByKey["prompt:task-1"]?.nextStep, "inspect_prompt_boundary");
  assert.equal(casesByKey["flow:flow-1:group-1"]?.caseState, "recovering");
  assert.equal(casesByKey["flow:flow-1:group-1"]?.itemCount, 1);
  assert.deepEqual(casesByKey["flow:flow-1:group-1"]?.sources, ["flow"]);
  assert.equal(casesByKey["flow:flow-1:group-1"]?.nextStep, "inspect_shard_group");
  assert.equal(casesByKey["incident:task-1"]?.caseState, "waiting_manual");
  assert.equal(casesByKey["incident:task-1"]?.itemCount, 2);
  assert.deepEqual(casesByKey["incident:task-1"]?.sources, ["recovery", "replay"]);
  assert.equal(casesByKey["incident:task-1"]?.browserTransportLabel, "chrome-relay");
  assert.equal(casesByKey["incident:task-1"]?.relayDiagnosticBucket, "peer_stale");
  assert.match(casesByKey["incident:task-1"]?.headline ?? "", /incident:task-1 open via replay\+recovery .*transport=chrome-relay .*relay=peer_stale/);
  assert.equal(casesByKey["incident:task-1"]?.nextStep, "request_approval");
  assert.deepEqual(casesByKey["incident:task-1"]?.allowedActions, ["approve", "reject"]);
  assert.match(casesByKey["incident:task-1"]?.latestUpdate ?? "", /Approval required/);
  const bySource = Object.fromEntries(report.items.map((item) => [item.source, item]));
  assert.equal(bySource.governance?.severity, "critical");
  assert.equal(bySource.governance?.lifecycle, "blocked");
  assert.equal(bySource.governance?.gate, "fallback_browser");
  assert.equal(bySource.flow?.severity, "critical");
  assert.equal(bySource.flow?.lifecycle, "recovering");
  assert.equal(bySource.flow?.gate, "recovering");
  assert.deepEqual(bySource.flow?.reasons, ["missing", "retry"]);
  assert.match(bySource.flow?.headline ?? "", /flow:flow-1:group-1 recovering via flow/);
  assert.equal(bySource.replay?.severity, "warning");
  assert.equal(bySource.replay?.lifecycle, "open");
  assert.equal(bySource.replay?.gate, "follow_up_required");
  assert.equal(bySource.replay?.browserContinuityState, "attention");
  assert.equal(bySource.replay?.browserTransportLabel, "chrome-relay");
  assert.equal(bySource.replay?.relayDiagnosticBucket, "peer_stale");
  assert.match(bySource.replay?.headline ?? "", /incident:task-1 open via replay\+recovery .*transport=chrome-relay .*relay=peer_stale/);
  assert.equal(bySource.recovery?.severity, "warning");
  assert.equal(bySource.recovery?.lifecycle, "waiting_manual");
  assert.equal(bySource.recovery?.caseKey, bySource.replay?.caseKey);
  assert.equal(bySource.recovery?.headline, bySource.replay?.headline);
  assert.equal(bySource.recovery?.gate, "waiting for approval");
  assert.deepEqual(bySource.recovery?.reasons, ["waiting_approval", "Approval required."]);
  assert.deepEqual(bySource.recovery?.allowedActions, ["approve", "reject"]);
  assert.equal(bySource.prompt?.severity, "critical");
  assert.equal(bySource.prompt?.lifecycle, "blocked");
  assert.equal(bySource.prompt?.gate, "request_envelope_reduction");
  assert.equal(bySource.prompt?.action, "inspect_prompt_boundary");
  assert.equal(bySource.prompt?.caseKey, "prompt:task-1");
  assert.match(bySource.prompt?.headline ?? "", /prompt:task-1 blocked via prompt/);
  assert.deepEqual(bySource.prompt?.reasons, ["reference-only", "recent-turns", "pending", "waiting"]);
});

test("operator inspection keeps attention overview stable when item list is limited", () => {
  const report = buildOperatorAttentionReport({
    flows: [
      {
        flowId: "flow-limit",
        threadId: "thread-1",
        rootMessageId: "msg-1",
        mode: "parallel",
        status: "running",
        currentStageIndex: 1,
        activeRoleIds: ["lead"],
        completedRoleIds: [],
        failedRoleIds: [],
        hopCount: 2,
        maxHops: 6,
        edges: [],
        shardGroups: [
          {
            groupId: "group-limit",
            parentTaskId: "task-limit",
            sourceMessageId: "msg-1",
            mergeBackToRoleId: "lead",
            kind: "research",
            status: "waiting_retry",
            expectedRoleIds: ["role-a", "role-b"],
            completedRoleIds: ["role-a"],
            failedRoleIds: [],
            cancelledRoleIds: [],
            retryCounts: { "role-b": 1 },
            shardResults: [],
            createdAt: 1,
            updatedAt: 10,
          },
        ],
        createdAt: 1,
        updatedAt: 10,
      },
    ],
    permissionRecords: [],
    events: [
      {
        eventId: "evt-limit",
        threadId: "thread-1",
        kind: "audit.logged",
        createdAt: 11,
        payload: {
          workerType: "explore",
          status: "partial",
          transport: "browser",
          trustLevel: "observational",
          admissionMode: "summary_only",
          permission: {
            recommendedAction: "fallback_browser",
          },
        },
      },
    ],
    replays: [],
    recoveryRuns: [],
    limit: 1,
  });

  assert.equal(report.totalItems, 2);
  assert.equal(report.returnedItems, 1);
  assert.equal(report.uniqueCaseCount, 2);
  assert.equal(report.returnedCases, 1);
  assert.equal(report.caseStateCounts.blocked, 1);
  assert.equal(report.caseStateCounts.recovering, 1);
  assert.equal(report.severityCounts.critical, 2);
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0]?.caseKey, "governance:evt-limit");
});

test("operator inspection surfaces direct-cdp reconnect diagnostics in replay attention", () => {
  const report = buildOperatorAttentionReport({
    flows: [],
    permissionRecords: [],
    events: [],
    replays: [
      {
        replayId: "task-direct-cdp:worker:worker:browser:task:task-direct-cdp",
        layer: "worker",
        status: "failed",
        recordedAt: 30,
        threadId: "thread-1",
        taskId: "task-direct-cdp",
        summary: "direct-cdp browser reconnected but target needs confirmation before resume",
        failure: {
          category: "stale_session",
          layer: "worker",
          retryable: true,
          message: "direct-cdp browser reconnected but target needs confirmation before resume",
          recommendedAction: "inspect",
        },
        metadata: {
          payload: {
            sessionId: "browser-session-direct-cdp",
            targetId: "target-direct-cdp",
            transportMode: "direct-cdp",
            transportLabel: "direct-cdp",
            transportTargetId: "page:manager-1:1",
            resumeMode: "warm",
            targetResolution: "reconnect",
          },
        },
      },
    ],
    recoveryRuns: [
      {
        recoveryRunId: buildRecoveryRunId("task-direct-cdp"),
        threadId: "thread-1",
        sourceGroupId: "task-direct-cdp",
        latestStatus: "partial",
        status: "waiting_external",
        nextAction: "inspect_then_resume",
        autoDispatchReady: false,
        requiresManualIntervention: true,
        latestSummary: "Direct CDP browser reconnected, but manual confirmation is required before resuming.",
        waitingReason: "Direct CDP browser reconnected, but manual confirmation is required before resuming.",
        currentAttemptId: "attempt-direct-cdp",
        attempts: [
          {
            attemptId: "attempt-direct-cdp",
            action: "resume",
            requestedAt: 21,
            updatedAt: 22,
            status: "waiting_external",
            nextAction: "inspect_then_resume",
            summary: "Direct CDP target must be manually confirmed before resume.",
          },
        ],
        createdAt: 21,
        updatedAt: 22,
      },
    ],
    progressEvents: [],
    limit: 10,
  });

  const casesByKey = Object.fromEntries(report.cases.map((entry) => [entry.caseKey, entry]));
  assert.equal(casesByKey["incident:task-direct-cdp"]?.browserTransportLabel, "direct-cdp");
  assert.equal(casesByKey["incident:task-direct-cdp"]?.browserDiagnosticBucket, "reconnect_required");
  assert.match(
    casesByKey["incident:task-direct-cdp"]?.headline ?? "",
    /incident:task-direct-cdp .*transport=direct-cdp .*diag=reconnect_required/
  );

  const bySource = Object.fromEntries(report.items.map((item) => [item.source, item]));
  assert.equal(bySource.replay?.browserTransportLabel, "direct-cdp");
  assert.equal(bySource.replay?.browserDiagnosticBucket, "reconnect_required");
  assert.ok(bySource.replay?.reasons?.includes("reconnect_required"));
});

test("operator inspection counts cases from the full dataset before limiting returned items", () => {
  const report = buildOperatorAttentionReport({
    flows: [],
    permissionRecords: [],
    events: Array.from({ length: 25 }, (_, index) => ({
      eventId: `evt-${index}`,
      threadId: "thread-1",
      kind: "audit.logged" as const,
      createdAt: 100 + index,
      payload: {
        workerType: "explore",
        status: "partial",
        transport: "browser",
        trustLevel: "observational",
        admissionMode: "summary_only",
        permission: {
          recommendedAction: index % 2 === 0 ? "fallback_browser" : "request_approval",
        },
      },
    })),
    replays: [],
    recoveryRuns: [],
    limit: 1,
  });

  assert.equal(report.totalItems, 25);
  assert.equal(report.returnedItems, 1);
  assert.equal(report.uniqueCaseCount, 25);
  assert.equal(report.caseStateCounts.blocked, 13);
  assert.equal(report.caseStateCounts.waiting_manual, 12);
  assert.equal(report.severityCounts.critical, 13);
  assert.equal(report.severityCounts.warning, 12);
});

test("operator inspection counts replay cases from the full dataset before limiting returned items", () => {
  const report = buildOperatorAttentionReport({
    flows: [],
    permissionRecords: [],
    events: [],
    replays: Array.from({ length: 25 }, (_, index) => ({
      replayId: `task-replay-${index}:worker`,
      layer: "worker" as const,
      status: "failed" as const,
      recordedAt: 100 + index,
      threadId: "thread-1",
      taskId: `task-replay-${index}`,
      summary: `worker failed ${index}`,
      failure: {
        category: "transport_failed" as const,
        layer: "worker" as const,
        retryable: true,
        message: `worker failed ${index}`,
        recommendedAction: "fallback" as const,
      },
    })),
    recoveryRuns: [],
    limit: 1,
  });

  assert.equal(report.totalItems, 25);
  assert.equal(report.returnedItems, 1);
  assert.equal(report.uniqueCaseCount, 25);
  assert.equal(report.caseStateCounts.open, 25);
  assert.equal(report.severityCounts.warning, 25);
});

test("operator triage prioritizes compound incidents and surfaces runtime and prompt entry points", () => {
  const now = 50;
  const recoveryRun: RecoveryRun = {
    recoveryRunId: buildRecoveryRunId("task-operator-triage"),
    threadId: "thread-1",
    sourceGroupId: "task-operator-triage",
    latestStatus: "partial",
    status: "waiting_external",
    nextAction: "inspect_then_resume",
    autoDispatchReady: false,
    requiresManualIntervention: true,
    latestSummary: "Browser continuity recovered; waiting on operator verification.",
    waitingReason: "waiting on operator verification",
    browserSession: {
      sessionId: "browser-triage",
      targetId: "target-triage",
      resumeMode: "warm",
    },
    attempts: [
      {
        attemptId: "attempt-triage",
        action: "resume",
        requestedAt: now - 10,
        updatedAt: now,
        status: "waiting_external",
        nextAction: "inspect_then_resume",
        summary: "Detached target recovered; waiting on manual verification.",
        browserOutcome: "detached_target_recovered",
      },
    ],
    createdAt: now - 20,
    updatedAt: now,
  };
  const progressEvents = [
    buildPromptBoundary({
      progressId: "progress-triage-reduction",
      recordedAt: now,
      boundaryKind: "request_envelope_reduction",
      reductionLevel: "minimal",
      taskId: "task-operator-triage",
      summary: "Envelope reduction kept the browser verification blocker visible.",
    }),
  ];
  const summary = buildOperatorSummaryReport({
    flows: [],
    permissionRecords: [],
    events: [],
    replays: [],
    recoveryRuns: [recoveryRun],
    progressEvents,
    limit: 10,
  });
  const attention = buildOperatorAttentionReport({
    flows: [],
    permissionRecords: [],
    events: [],
    replays: [],
    recoveryRuns: [recoveryRun],
    progressEvents,
    limit: 10,
  });
  const runtime = buildRuntimeSummaryReport({
    entries: [buildDerivedRecoveryRuntimeChain(recoveryRun)],
    limit: 10,
    now,
  });

  const report = buildOperatorTriageReport({
    summary,
    attention,
    runtime,
    limit: 5,
  });

  assert.equal(report.waitingManualCaseCount, 1);
  assert.equal(report.runtimeWaitingCount, 1);
  assert.equal(report.promptReductionCount, 1);
  assert.equal(report.recommendedEntryPoint, "replay-bundle task-operator-triage");
  assert.equal(report.focusAreas[0]?.area, "case");
  assert.equal(report.focusAreas[0]?.commandHint, "replay-bundle task-operator-triage");
  assert.ok(report.focusAreas.some((area) => area.area === "runtime"));
  assert.ok(report.focusAreas.some((area) => area.commandHint === "prompt-console 10"));
});

test("operator triage uses a safe stale runtime fallback when chain details are missing", () => {
  const summary = buildOperatorSummaryReport({
    flows: [],
    permissionRecords: [],
    events: [],
    replays: [],
    recoveryRuns: [],
    limit: 10,
  });
  const attention = buildOperatorAttentionReport({
    flows: [],
    permissionRecords: [],
    events: [],
    replays: [],
    recoveryRuns: [],
    limit: 10,
  });
  const report = buildOperatorTriageReport({
    summary,
    attention,
    runtime: {
      totalChains: 0,
      activeCount: 0,
      waitingCount: 0,
      failedCount: 0,
      resolvedCount: 0,
      staleCount: 1,
      attentionCount: 0,
      stateCounts: {},
      continuityCounts: {},
      caseStateCounts: {},
      attentionChains: [],
      activeChains: [],
      waitingChains: [],
      staleChains: [],
      failedChains: [],
      recentlyResolved: [],
    },
    limit: 5,
  });

  const staleFocus = report.focusAreas.find((area) => area.label === "runtime-stale");
  assert.equal(staleFocus?.reason, "Runtime reports stale chains but no chain details are available.");
  assert.equal(staleFocus?.caseKey, undefined);
  assert.equal(staleFocus?.state, undefined);
});

function buildPromptBoundary(input: {
  progressId: string;
  recordedAt: number;
  boundaryKind: "prompt_compaction" | "request_envelope_reduction";
  taskId: string;
  summary: string;
  reductionLevel?: "compact" | "minimal" | "reference-only";
}): RuntimeProgressEvent {
  return {
    progressId: input.progressId,
    threadId: "thread-1",
    subjectKind: "role_run",
    subjectId: "role:lead",
    phase: "degraded",
    progressKind: "boundary",
    summary: input.summary,
    recordedAt: input.recordedAt,
    flowId: "flow-op",
    taskId: input.taskId,
    roleId: "lead",
    metadata: {
      boundaryKind: input.boundaryKind,
      modelId: "gpt-5",
      modelChainId: "reasoning_primary",
      assemblyFingerprint: `${input.taskId}:${input.progressId}`,
      compactedSegments: ["recent-turns"],
      ...(input.reductionLevel ? { reductionLevel: input.reductionLevel } : {}),
      contextDiagnostics: {
        continuity: {
          hasThreadSummary: true,
          hasSessionMemory: true,
          hasRoleScratchpad: true,
          hasContinuationContext: true,
          carriesPendingWork: true,
          carriesWaitingOn: true,
          carriesOpenQuestions: false,
          carriesDecisionOrConstraint: true,
        },
        recentTurns: {
          availableCount: 8,
          selectedCount: 5,
          packedCount: 2,
          salientEarlierCount: 1,
          compacted: true,
        },
        retrievedMemory: {
          availableCount: 4,
          selectedCount: 2,
          packedCount: 1,
          compacted: true,
          userPreferenceCount: 1,
          threadMemoryCount: 1,
          sessionMemoryCount: 1,
          knowledgeNoteCount: 1,
          journalNoteCount: 0,
        },
        workerEvidence: {
          totalCount: 3,
          admittedCount: 2,
          selectedCount: 2,
          packedCount: 1,
          compacted: true,
          promotableCount: 1,
          observationalCount: 1,
          fullCount: 1,
          summaryOnlyCount: 1,
          continuationRelevantCount: 1,
        },
      },
    },
  };
}
