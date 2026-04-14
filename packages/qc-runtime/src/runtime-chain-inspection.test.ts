import assert from "node:assert/strict";
import test from "node:test";

import type {
  FlowLedger,
  RecoveryRun,
  RecoveryRunEvent,
  ReplayRecord,
  RoleRunState,
  RuntimeChain,
  RuntimeChainEvent,
  RuntimeProgressEvent,
  RuntimeChainSpan,
  RuntimeChainStatus,
  WorkerSessionState,
} from "@turnkeyai/core-types/team";

import {
  buildAugmentedFlowRuntimeChainDetail,
  buildAugmentedFlowRuntimeChainEntry,
  buildDerivedRecoveryRuntimeChain,
  buildDerivedRecoveryRuntimeChainDetail,
  buildRuntimeSummaryReport,
  decorateRuntimeChainStatus,
  deriveRuntimeChainCanonicalState,
} from "./runtime-chain-inspection";

test("runtime chain inspection projects one recovery run into chain summary", () => {
  const run: RecoveryRun = {
    recoveryRunId: "recovery:group-1",
    threadId: "thread-1",
    sourceGroupId: "group-1",
    latestStatus: "failed",
    status: "waiting_approval",
    nextAction: "request_approval",
    autoDispatchReady: false,
    requiresManualIntervention: true,
    latestSummary: "Approval required before resume.",
    waitingReason: "approval required",
    attempts: [],
    createdAt: 10,
    updatedAt: 20,
  };

  const projected = buildDerivedRecoveryRuntimeChain(run);
  assert.equal(projected.chain.chainId, "recovery:group-1");
  assert.equal(projected.chain.rootKind, "recovery");
  assert.equal(projected.status.phase, "waiting");
  assert.equal(projected.status.activeSubjectKind, "recovery_run");
});

test("runtime chain inspection builds recovery detail with replay-group spans", () => {
  const run: RecoveryRun = {
    recoveryRunId: "recovery:group-1",
    threadId: "thread-1",
    sourceGroupId: "group-1",
    latestStatus: "failed",
    status: "retrying",
    nextAction: "fallback_transport",
    autoDispatchReady: true,
    requiresManualIntervention: false,
    latestSummary: "Retry in progress.",
    currentAttemptId: "attempt-1",
    attempts: [
      {
        attemptId: "attempt-1",
        action: "retry",
        requestedAt: 20,
        updatedAt: 30,
        status: "retrying",
        nextAction: "fallback_transport",
        summary: "Retry dispatched.",
        dispatchReplayId: "scheduled:dispatch-1",
        dispatchedTaskId: "follow-up-1",
      },
    ],
    createdAt: 10,
    updatedAt: 30,
  };
  const records: ReplayRecord[] = [
    {
      replayId: "scheduled:dispatch-1",
      layer: "scheduled",
      status: "completed",
      recordedAt: 21,
      threadId: "thread-1",
      taskId: "follow-up-1",
      summary: "Recovery dispatch accepted.",
      metadata: {
        recoveryContext: {
          parentGroupId: "group-1",
        },
      },
    },
    {
      replayId: "worker:follow-up-1",
      layer: "worker",
      status: "failed",
      recordedAt: 31,
      threadId: "thread-1",
      taskId: "follow-up-1",
      summary: "Retry failed again.",
      failure: {
        category: "transport_failed",
        layer: "worker",
        retryable: true,
        message: "retry failed",
        recommendedAction: "fallback",
      },
    },
  ];
  const events: RecoveryRunEvent[] = [
    {
      eventId: "event-1",
      recoveryRunId: "recovery:group-1",
      threadId: "thread-1",
      sourceGroupId: "group-1",
      kind: "action_requested",
      status: "retrying",
      recordedAt: 20,
      summary: "Retry requested.",
      action: "retry",
      attemptId: "attempt-1",
      transitionReason: "manual_retry",
    },
  ];

  const detail = buildDerivedRecoveryRuntimeChainDetail({ run, records, events });
  assert.equal(detail.chain.chainId, "recovery:group-1");
  assert.equal(detail.status.phase, "heartbeat");
  assert.ok(detail.spans.some((span) => span.subjectKind === "replay_group" && span.subjectId === "follow-up-1"));
  assert.ok(detail.events.some((event) => event.subjectKind === "recovery_run"));
  assert.ok(detail.events.some((event) => event.subjectKind === "replay_group"));
});

test("runtime chain inspection augments flow chains with live role and worker spans", () => {
  const chain: RuntimeChain = {
    chainId: "flow:flow-1",
    threadId: "thread-1",
    rootKind: "flow",
    rootId: "flow-1",
    flowId: "flow-1",
    createdAt: 10,
    updatedAt: 30,
  };
  const status: RuntimeChainStatus = {
    chainId: chain.chainId,
    threadId: chain.threadId,
    activeSpanId: "dispatch:task-1",
    activeSubjectKind: "dispatch",
    activeSubjectId: "task-1",
    phase: "waiting",
    latestSummary: "Dispatch waiting on lead.",
    attention: false,
    updatedAt: 20,
  };
  const flow: FlowLedger = {
    flowId: "flow-1",
    threadId: "thread-1",
    rootMessageId: "msg-root",
    mode: "serial",
    status: "waiting_worker",
    currentStageIndex: 0,
    activeRoleIds: ["lead"],
    completedRoleIds: [],
    failedRoleIds: [],
    nextExpectedRoleId: "lead",
    hopCount: 1,
    maxHops: 6,
    edges: [],
    createdAt: 10,
    updatedAt: 30,
  };
  const spans: RuntimeChainSpan[] = [
    {
      spanId: "flow:flow-1",
      chainId: chain.chainId,
      subjectKind: "flow",
      subjectId: "flow-1",
      threadId: chain.threadId,
      flowId: "flow-1",
      createdAt: 10,
      updatedAt: 30,
    },
  ];
  const events: RuntimeChainEvent[] = [];
  const roleRuns: RoleRunState[] = [
    {
      runKey: "run:thread-1:lead",
      threadId: "thread-1",
      roleId: "lead",
      mode: "group",
      status: "waiting_worker",
      iterationCount: 2,
      maxIterations: 6,
      inbox: [],
      lastDequeuedTaskId: "task-1",
      lastActiveAt: 40,
      workerSessions: {
        browser: "worker:browser:task:task-1",
      },
    },
  ];
  const worker = {
    workerRunKey: "worker:browser:task:task-1",
    workerType: "browser",
    status: "waiting_external",
    createdAt: 35,
    updatedAt: 45,
    currentTaskId: "task-1",
    lastResult: {
      workerType: "browser",
      status: "partial",
      summary: "Captured partial browser state.",
      payload: {
        sessionId: "browser-session-1",
        targetId: "target-1",
        resumeMode: "warm",
      },
    },
    continuationDigest: {
      reason: "follow_up" as const,
      summary: "Waiting for browser continuation.",
      createdAt: 45,
    },
  } satisfies WorkerSessionState;

  const entry = buildAugmentedFlowRuntimeChainEntry({
    chain,
    status,
    flow,
    roleRuns,
    workerStatesByRunKey: new Map([[worker.workerRunKey, worker]]),
  });
  assert.equal(entry.status.activeSubjectKind, "worker_run");
  assert.equal(entry.status.activeSubjectId, worker.workerRunKey);
  assert.equal(entry.status.phase, "waiting");

  const detail = buildAugmentedFlowRuntimeChainDetail({
    chain,
    status,
    spans,
    events,
    flow,
    roleRuns,
    workerStatesByRunKey: new Map([[worker.workerRunKey, worker]]),
  });
  assert.ok(detail.spans.some((span) => span.subjectKind === "role_run" && span.subjectId === roleRuns[0]?.runKey));
  assert.ok(detail.spans.some((span) => span.subjectKind === "worker_run" && span.subjectId === worker.workerRunKey));
  assert.ok(detail.spans.some((span) => span.subjectKind === "browser_session" && span.subjectId === "browser-session-1"));
  const workerEvent = detail.events.find((event) => event.subjectKind === "worker_run");
  assert.ok(workerEvent);
  assert.equal(workerEvent?.artifacts?.browserSessionId, "browser-session-1");
  assert.equal(workerEvent?.artifacts?.browserTargetId, "target-1");
  const browserEvent = detail.events.find((event) => event.subjectKind === "browser_session");
  assert.equal(browserEvent?.artifacts?.browserSessionId, "browser-session-1");
});

test("runtime chain summary reports continuity mix and preserves waiting continuity", () => {
  const report = buildRuntimeSummaryReport({
    entries: [
      {
        chain: {
          chainId: "flow:1",
          threadId: "thread-1",
          rootKind: "flow",
          rootId: "flow-1",
          flowId: "flow-1",
          createdAt: 10,
          updatedAt: 20,
        },
        status: {
          chainId: "flow:1",
          threadId: "thread-1",
          phase: "waiting",
          continuityState: "waiting",
          latestSummary: "waiting for worker",
          attention: false,
          updatedAt: 20,
        },
      },
      {
        chain: {
          chainId: "recovery:1",
          threadId: "thread-1",
          rootKind: "recovery",
          rootId: "recovery:1",
          createdAt: 30,
          updatedAt: 40,
        },
        status: {
          chainId: "recovery:1",
          threadId: "thread-1",
          phase: "resolved",
          continuityState: "resolved",
          latestSummary: "recovered",
          attention: false,
          updatedAt: 40,
        },
      },
    ],
    now: 25,
  });

  assert.equal(report.continuityCounts.waiting, 1);
  assert.equal(report.continuityCounts.resolved, 1);
  assert.equal(report.waitingChains[0]?.continuityState, "waiting");
});

test("decorate runtime chain status treats reconnect-window expiry as stale transient failure", () => {
  const chain: RuntimeChain = {
    chainId: "flow:flow-2",
    threadId: "thread-2",
    rootKind: "flow",
    rootId: "flow-2",
    flowId: "flow-2",
    createdAt: 10,
    updatedAt: 10,
  };
  const status: RuntimeChainStatus = {
    chainId: chain.chainId,
    threadId: chain.threadId,
    activeSpanId: "browser:session-1",
    activeSubjectKind: "browser_session",
    activeSubjectId: "session-1",
    phase: "heartbeat",
    continuityState: "reconnecting",
    reconnectWindowUntil: 100,
    latestSummary: "Browser session is attempting to reconnect.",
    attention: false,
    updatedAt: 10,
  };

  const decorated = decorateRuntimeChainStatus({
    chain,
    status,
    now: 101,
  });

  assert.equal(decorated.stale, true);
  assert.equal(decorated.continuityState, "transient_failure");
  assert.match(decorated.staleReason ?? "", /reconnect window expired/i);
});

test("decorate runtime chain status marks stale heartbeat chains as transient failures", () => {
  const chain: RuntimeChain = {
    chainId: "flow:flow-stale",
    threadId: "thread-1",
    rootKind: "flow",
    rootId: "flow-stale",
    flowId: "flow-stale",
    createdAt: 1,
    updatedAt: 1,
  };

  const status = decorateRuntimeChainStatus({
    chain,
    status: {
      chainId: chain.chainId,
      threadId: chain.threadId,
      activeSpanId: "role:run-1",
      activeSubjectKind: "role_run",
      activeSubjectId: "run-1",
      phase: "heartbeat",
      latestSummary: "Lead is still working.",
      lastHeartbeatAt: 1,
      attention: false,
      updatedAt: 1,
    },
    now: 1 + 4 * 60 * 1000,
  });

  assert.equal(status.stale, true);
  assert.equal(status.canonicalState, "degraded");
  assert.equal(status.continuityState, "transient_failure");
  assert.match(status.continuityReason ?? "", /heartbeat overdue/);
});

test("decorate runtime chain status treats newer progress echo as liveliness", () => {
  const chain: RuntimeChain = {
    chainId: "flow:flow-live",
    threadId: "thread-1",
    rootKind: "flow",
    rootId: "flow-live",
    flowId: "flow-live",
    createdAt: 1,
    updatedAt: 1,
  };
  const status: RuntimeChainStatus = {
    chainId: chain.chainId,
    threadId: chain.threadId,
    activeSpanId: "worker:run-1",
    activeSubjectKind: "worker_run",
    activeSubjectId: "run-1",
    phase: "heartbeat",
    latestSummary: "Worker is still running.",
    lastHeartbeatAt: 1,
    attention: false,
    updatedAt: 1,
  };
  const progressEvents: RuntimeProgressEvent[] = [
    {
      progressId: "progress-1",
      threadId: chain.threadId,
      chainId: chain.chainId,
      spanId: "worker:run-1",
      subjectKind: "worker_run",
      subjectId: "run-1",
      phase: "heartbeat",
      progressKind: "heartbeat",
      heartbeatSource: "activity_echo",
      continuityState: "alive",
      responseTimeoutAt: 10_000,
      summary: "Worker sent a fresh activity echo.",
      recordedAt: 9_000,
    },
  ];

  const decorated = decorateRuntimeChainStatus({
    chain,
    status,
    progressEvents,
    now: 9_100,
  });

  assert.equal(decorated.stale, undefined);
  assert.equal(decorated.canonicalState, "heartbeat");
  assert.equal(decorated.latestSummary, "Worker sent a fresh activity echo.");
  assert.equal(decorated.lastHeartbeatAt, 9_000);
});

test("runtime chain status marks overdue heartbeat chains as degraded and stale", () => {
  const chain: RuntimeChain = {
    chainId: "flow:flow-stale",
    threadId: "thread-1",
    rootKind: "flow",
    rootId: "flow-stale",
    flowId: "flow-stale",
    createdAt: 10,
    updatedAt: 20,
  };
  const status: RuntimeChainStatus = {
    chainId: chain.chainId,
    threadId: chain.threadId,
    activeSpanId: "dispatch:task-1",
    activeSubjectKind: "dispatch",
    activeSubjectId: "task-1",
    phase: "heartbeat",
    latestSummary: "Dispatch still running.",
    lastHeartbeatAt: 100,
    attention: false,
    updatedAt: 100,
  };

  const decorated = decorateRuntimeChainStatus({ chain, status, now: 100 + 4 * 60 * 1000 });
  assert.equal(decorated.stale, true);
  assert.equal(decorated.staleReason, "heartbeat overdue");
  assert.equal(decorated.canonicalState, "degraded");
  assert.equal(deriveRuntimeChainCanonicalState(decorated, 100 + 4 * 60 * 1000), "degraded");
});

test("runtime chain status does not mark degraded chains stale without an overdue heartbeat", () => {
  const chain: RuntimeChain = {
    chainId: "flow:flow-degraded",
    threadId: "thread-1",
    rootKind: "flow",
    rootId: "flow-degraded",
    flowId: "flow-degraded",
    createdAt: 10,
    updatedAt: 20,
  };
  const status: RuntimeChainStatus = {
    chainId: chain.chainId,
    threadId: chain.threadId,
    phase: "degraded",
    latestSummary: "Runtime chain degraded.",
    attention: true,
    updatedAt: 100,
  };

  const decorated = decorateRuntimeChainStatus({ chain, status, now: 100 });
  assert.equal(decorated.stale, undefined);
  assert.equal(decorated.staleReason, undefined);
  assert.equal(decorated.canonicalState, "degraded");
});

test("runtime chain status correlates recovery chains to replay case metadata", () => {
  const run: RecoveryRun = {
    recoveryRunId: "recovery:task-1",
    threadId: "thread-1",
    sourceGroupId: "task-1",
    latestStatus: "failed",
    status: "waiting_approval",
    nextAction: "request_approval",
    autoDispatchReady: false,
    requiresManualIntervention: true,
    latestSummary: "Approval required before resuming browser work.",
    waitingReason: "approval required",
    browserSession: {
      sessionId: "browser-session-1",
      targetId: "target-1",
      resumeMode: "warm",
    },
    attempts: [],
    createdAt: 10,
    updatedAt: 20,
  };
  const base = buildDerivedRecoveryRuntimeChain(run);
  const records: ReplayRecord[] = [
    {
      replayId: "worker:task-1",
      layer: "worker",
      status: "failed",
      recordedAt: 20,
      threadId: "thread-1",
      taskId: "task-1",
      summary: "Browser task failed.",
      failure: {
        category: "stale_session",
        layer: "browser",
        retryable: true,
        message: "stale browser target",
        recommendedAction: "resume",
      },
    },
  ];

  const decorated = decorateRuntimeChainStatus({
    chain: base.chain,
    status: base.status,
    recoveryRun: run,
    records,
  });
  assert.equal(decorated.caseKey, "incident:task-1");
  assert.equal(decorated.caseState, "waiting_manual");
  assert.match(decorated.headline ?? "", /task-1 waiting_manual/);
  assert.equal(decorated.nextStep, "request_approval");
});

test("runtime chain status treats waiting_external recovery runs as waiting_manual cases", () => {
  const run: RecoveryRun = {
    recoveryRunId: "recovery:task-waiting",
    threadId: "thread-1",
    sourceGroupId: "task-waiting",
    latestStatus: "partial",
    status: "waiting_external",
    nextAction: "inspect_then_resume",
    autoDispatchReady: false,
    requiresManualIntervention: true,
    latestSummary: "Waiting for an external dependency.",
    waitingReason: "waiting on external system",
    attempts: [],
    createdAt: 10,
    updatedAt: 20,
  };

  const base = buildDerivedRecoveryRuntimeChain(run);
  const decorated = decorateRuntimeChainStatus({
    chain: base.chain,
    status: base.status,
    recoveryRun: run,
    records: [],
  });
  assert.equal(decorated.caseState, "waiting_manual");
  assert.equal(decorated.nextStep, "inspect_then_resume");
});

test("runtime chain inspection clears stale waiting state when a worker is running again", () => {
  const chain: RuntimeChain = {
    chainId: "flow:flow-running-worker",
    threadId: "thread-1",
    rootKind: "flow",
    rootId: "flow-running-worker",
    flowId: "flow-running-worker",
    createdAt: 1,
    updatedAt: 10,
  };
  const status: RuntimeChainStatus = {
    chainId: chain.chainId,
    threadId: chain.threadId,
    activeSpanId: "worker_run:worker-1",
    activeSubjectKind: "worker_run",
    activeSubjectId: "worker-1",
    phase: "waiting",
    waitingReason: "waiting for browser reconnect",
    currentWaitingSpanId: "worker_run:worker-1",
    currentWaitingPoint: "waiting for browser reconnect",
    responseTimeoutAt: 20,
    latestSummary: "Waiting for browser reconnect.",
    attention: false,
    updatedAt: 10,
  };
  const flow: FlowLedger = {
    flowId: "flow-running-worker",
    threadId: "thread-1",
    rootMessageId: "msg-root",
    mode: "serial",
    status: "running",
    currentStageIndex: 0,
    activeRoleIds: ["lead"],
    completedRoleIds: [],
    failedRoleIds: [],
    hopCount: 1,
    maxHops: 6,
    edges: [],
    createdAt: 1,
    updatedAt: 10,
  };
  const roleRuns: RoleRunState[] = [
    {
      runKey: "run:thread-1:lead",
      threadId: "thread-1",
      roleId: "lead",
      mode: "group",
      status: "running",
      iterationCount: 1,
      maxIterations: 6,
      inbox: [],
      lastDequeuedTaskId: "task-1",
      lastActiveAt: 25,
      workerSessions: {
        browser: "worker:browser:task:task-1",
      },
    },
  ];
  const worker: WorkerSessionState = {
    workerRunKey: "worker:browser:task:task-1",
    workerType: "browser",
    status: "running",
    createdAt: 15,
    updatedAt: 30,
    currentTaskId: "task-1",
    lastError: {
      code: "WORKER_TIMEOUT",
      message: "stale reconnect error",
      retryable: true,
    },
  };

  const entry = buildAugmentedFlowRuntimeChainEntry({
    chain,
    status,
    flow,
    roleRuns,
    workerStatesByRunKey: new Map([[worker.workerRunKey, worker]]),
    now: 31,
  });
  const detail = buildAugmentedFlowRuntimeChainDetail({
    chain,
    status,
    spans: [],
    events: [],
    flow,
    roleRuns,
    workerStatesByRunKey: new Map([[worker.workerRunKey, worker]]),
    now: 31,
  });

  assert.equal(entry.status.phase, "heartbeat");
  assert.equal(entry.status.waitingReason, undefined);
  assert.equal(entry.status.currentWaitingPoint, undefined);
  assert.equal(entry.status.currentWaitingSpanId, undefined);
  assert.equal(entry.status.continuityReason, undefined);
  assert.equal(detail.events.find((event) => event.subjectKind === "worker_run")?.statusReason, undefined);
});

test("decorate runtime chain status clears stale waiting state after a completion progress event", () => {
  const chain: RuntimeChain = {
    chainId: "flow:flow-progress-complete",
    threadId: "thread-1",
    rootKind: "flow",
    rootId: "flow-progress-complete",
    flowId: "flow-progress-complete",
    createdAt: 1,
    updatedAt: 1,
  };
  const status: RuntimeChainStatus = {
    chainId: chain.chainId,
    threadId: chain.threadId,
    activeSpanId: "worker:run-1",
    activeSubjectKind: "worker_run",
    activeSubjectId: "run-1",
    phase: "waiting",
    waitingReason: "approval pending",
    currentWaitingSpanId: "worker:run-1",
    currentWaitingPoint: "approval pending",
    responseTimeoutAt: 50,
    latestSummary: "Approval pending.",
    attention: false,
    updatedAt: 10,
  };
  const progressEvents: RuntimeProgressEvent[] = [
    {
      progressId: "progress-complete",
      threadId: chain.threadId,
      chainId: chain.chainId,
      spanId: "worker:run-1",
      subjectKind: "worker_run",
      subjectId: "run-1",
      phase: "completed",
      progressKind: "transition",
      summary: "Worker completed cleanly.",
      recordedAt: 20,
    },
  ];

  const decorated = decorateRuntimeChainStatus({
    chain,
    status,
    progressEvents,
    now: 25,
  });

  assert.equal(decorated.phase, "completed");
  assert.equal(decorated.waitingReason, undefined);
  assert.equal(decorated.currentWaitingPoint, undefined);
  assert.equal(decorated.responseTimeoutAt, undefined);
  assert.equal(decorated.stale, undefined);
});

test("runtime chain inspection derives terminal flow status when no live role or worker remains", () => {
  const chain: RuntimeChain = {
    chainId: "flow:flow-completed",
    threadId: "thread-1",
    rootKind: "flow",
    rootId: "flow-completed",
    flowId: "flow-completed",
    createdAt: 1,
    updatedAt: 5,
  };
  const status: RuntimeChainStatus = {
    chainId: chain.chainId,
    threadId: chain.threadId,
    phase: "started",
    latestSummary: "Runtime chain created.",
    attention: false,
    updatedAt: 5,
  };
  const flow: FlowLedger = {
    flowId: "flow-completed",
    threadId: "thread-1",
    rootMessageId: "msg-root",
    mode: "serial",
    status: "completed",
    currentStageIndex: 1,
    activeRoleIds: [],
    completedRoleIds: ["lead"],
    failedRoleIds: [],
    hopCount: 1,
    maxHops: 6,
    edges: [],
    createdAt: 1,
    updatedAt: 20,
  };

  const entry = buildAugmentedFlowRuntimeChainEntry({
    chain,
    status,
    flow,
    roleRuns: [],
    workerStatesByRunKey: new Map(),
  });

  assert.equal(entry.status.phase, "completed");
  assert.equal(entry.status.latestSummary, "Flow completed.");
  assert.equal(entry.status.lastCompletedSpanId, "flow:flow-completed");
});

test("runtime summary report groups active, failed, and resolved chains", () => {
  const report = buildRuntimeSummaryReport({
    entries: [
      {
        chain: {
          chainId: "flow:flow-1",
          threadId: "thread-1",
          rootKind: "flow",
          rootId: "flow-1",
          flowId: "flow-1",
          createdAt: 1,
          updatedAt: 10,
        },
        status: {
          chainId: "flow:flow-1",
          threadId: "thread-1",
          phase: "waiting",
          canonicalState: "waiting",
          waitingReason: "waiting for worker",
          currentWaitingPoint: "waiting on browser follow-up",
          latestChildSpanId: "worker:browser:task-1",
          latestSummary: "Waiting for worker.",
          attention: false,
          updatedAt: 10,
        },
      },
      {
        chain: {
          chainId: "recovery:task-2",
          threadId: "thread-1",
          rootKind: "recovery",
          rootId: "recovery:task-2",
          createdAt: 1,
          updatedAt: 11,
        },
        status: {
          chainId: "recovery:task-2",
          threadId: "thread-1",
          phase: "failed",
          canonicalState: "failed",
          latestSummary: "Recovery failed.",
          attention: true,
          updatedAt: 11,
          lastFailedSpanId: "recovery:task-2:failed",
          caseKey: "incident:task-2",
          caseState: "blocked",
          headline: "task-2 blocked",
          nextStep: "inspect the failed recovery run",
        },
      },
      {
        chain: {
          chainId: "recovery:task-3",
          threadId: "thread-1",
          rootKind: "recovery",
          rootId: "recovery:task-3",
          createdAt: 1,
          updatedAt: 12,
        },
        status: {
          chainId: "recovery:task-3",
          threadId: "thread-1",
          phase: "resolved",
          canonicalState: "resolved",
          latestSummary: "Recovery resolved.",
          attention: false,
          updatedAt: 12,
          lastCompletedSpanId: "recovery:task-3:resolved",
          caseKey: "incident:task-3",
          caseState: "resolved",
          headline: "task-3 resolved",
          nextStep: "no action required",
        },
      },
    ],
    limit: 5,
    now: 12,
  });

  assert.equal(report.totalChains, 3);
  assert.equal(report.waitingCount, 1);
  assert.equal(report.failedCount, 1);
  assert.equal(report.resolvedCount, 1);
  assert.equal(report.caseStateCounts.blocked, 1);
  assert.equal(report.caseStateCounts.resolved, 1);
  assert.equal(report.activeChains[0]?.chainId, "flow:flow-1");
  assert.equal(report.attentionChains[0]?.chainId, "recovery:task-2");
  assert.equal(report.waitingChains[0]?.currentWaitingPoint, "waiting on browser follow-up");
  assert.equal(report.activeChains[0]?.latestChildSpanId, "worker:browser:task-1");
  assert.equal(report.staleChains.length, 0);
  assert.equal(report.failedChains[0]?.chainId, "recovery:task-2");
  assert.equal(report.failedChains[0]?.lastFailedSpanId, "recovery:task-2:failed");
  assert.equal(report.recentlyResolved[0]?.chainId, "recovery:task-3");
  assert.equal(report.recentlyResolved[0]?.lastCompletedSpanId, "recovery:task-3:resolved");
});

test("runtime summary report surfaces stale chains with waiting points", () => {
  const report = buildRuntimeSummaryReport({
    entries: [
      {
        chain: {
          chainId: "flow:flow-stale",
          threadId: "thread-1",
          rootKind: "flow",
          rootId: "flow-stale",
          flowId: "flow-stale",
          createdAt: 1,
          updatedAt: 20,
        },
        status: {
          chainId: "flow:flow-stale",
          threadId: "thread-1",
          phase: "waiting",
          latestSummary: "Waiting on a browser reconnect.",
          waitingReason: "waiting for browser reconnect",
          currentWaitingPoint: "browser target detached and reconnect window expired",
          latestChildSpanId: "browser:flow-stale:pricing",
          lastHeartbeatAt: 10,
          responseTimeoutAt: 15,
          attention: true,
          updatedAt: 20,
        },
      },
    ],
    limit: 5,
    now: 30,
  });

  assert.equal(report.staleCount, 1);
  assert.equal(report.stateCounts.degraded, 1);
  assert.equal(report.attentionChains[0]?.chainId, "flow:flow-stale");
  assert.equal(report.staleChains[0]?.chainId, "flow:flow-stale");
  assert.match(report.staleChains[0]?.staleReason ?? "", /response timeout/i);
  assert.equal(
    report.staleChains[0]?.currentWaitingPoint,
    "browser target detached and reconnect window expired"
  );
  assert.equal(report.staleChains[0]?.latestChildSpanId, "browser:flow-stale:pricing");
});
