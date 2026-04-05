import type {
  BrowserContinuationHint,
  Clock,
  IdGenerator,
  RecoveryRun,
  RecoveryRunAction,
  RecoveryRunEvent,
  ReplayRecoveryPlan,
  ScheduledTaskRecord,
  RuntimeChainStatus,
} from "@turnkeyai/core-types/team";
import {
  getScheduledContinuity,
  getScheduledSessionTarget,
  getScheduledTargetRoleId,
  getScheduledTargetWorker,
  normalizeScheduledTaskRecord,
} from "@turnkeyai/core-types/team";
import { decodeBrowserSessionPayload } from "@turnkeyai/core-types/browser-session-payload";
import type { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { classifyRuntimeError } from "@turnkeyai/qc-runtime/failure-taxonomy";
import type { FileReplayRecorder } from "@turnkeyai/qc-runtime/file-replay-recorder";
import {
  buildReplayInspectionReport,
  buildRecoveryRunId,
  buildRecoveryRunProgress,
  buildRecoveryRuns,
  buildRecoveryRunTimeline,
  findReplayRecoveryPlan,
  findRecoveryRun,
} from "@turnkeyai/qc-runtime/replay-inspection";
import { buildDerivedRecoveryRuntimeChain } from "@turnkeyai/qc-runtime/runtime-chain-inspection";
import type { CoordinationEngine } from "@turnkeyai/team-runtime/coordination-engine";
import type { DefaultRuntimeProgressRecorder } from "@turnkeyai/team-runtime/runtime-progress-recorder";
import type { DefaultRuntimeStateRecorder } from "@turnkeyai/team-runtime/runtime-state-recorder";
import type { FileRecoveryRunEventStore } from "@turnkeyai/team-store/recovery/file-recovery-run-event-store";
import type { FileRecoveryRunStore } from "@turnkeyai/team-store/recovery/file-recovery-run-store";

import { buildRecoveryRunActionConflict } from "./recovery-run-guards";

type RecoveryRuntimeSnapshot = {
  records: Awaited<ReturnType<FileReplayRecorder["list"]>>;
  report: ReturnType<typeof buildReplayInspectionReport>;
  runs: RecoveryRun[];
};

export interface RecoveryActionService {
  loadRecoveryRuntime(threadId: string): Promise<RecoveryRuntimeSnapshot>;
  syncRecoveryRuntime(threadId: string): Promise<RecoveryRuntimeSnapshot>;
  buildRecoverySummary(threadId: string, limit: number): Promise<{ totalRuns: number; runs: RecoveryRun[] }>;
  getReplayRecovery(threadId: string, groupId: string): Promise<ReplayRecoveryPlan | null>;
  listRecoveryRuns(threadId: string): Promise<RecoveryRun[]>;
  getRecoveryRun(threadId: string, recoveryRunId: string): Promise<RecoveryRun | null>;
  getRecoveryTimeline(
    threadId: string,
    recoveryRunId: string
  ): Promise<{
    recoveryRun: RecoveryRun;
    progress: ReturnType<typeof buildRecoveryRunProgress>;
    totalEntries: number;
    timeline: ReturnType<typeof buildRecoveryRunTimeline>;
  } | null>;
  executeRecoveryRunActionById(input: {
    threadId: string;
    recoveryRunId: string;
    action: Exclude<RecoveryRunAction, "dispatch"> | "dispatch";
  }): Promise<{ statusCode: number; body: unknown }>;
  dispatchReplayRecovery(input: { threadId: string; groupId: string }): Promise<{ statusCode: number; body: unknown }>;
}

export function createRecoveryActionService(input: {
  clock: Clock;
  idGenerator: IdGenerator;
  recoveryRunActionMutex: KeyedAsyncMutex<string>;
  recoveryRunStaleAfterMs: number;
  coordinationEngine: CoordinationEngine;
  runtimeStateRecorder: DefaultRuntimeStateRecorder;
  runtimeProgressRecorder: DefaultRuntimeProgressRecorder;
  replayRecorder: FileReplayRecorder;
  recoveryRunStore: FileRecoveryRunStore;
  recoveryRunEventStore: FileRecoveryRunEventStore;
}): RecoveryActionService {
  const {
    clock,
    idGenerator,
    recoveryRunActionMutex,
    recoveryRunStaleAfterMs,
    coordinationEngine,
    runtimeStateRecorder,
    runtimeProgressRecorder,
    replayRecorder,
    recoveryRunStore,
    recoveryRunEventStore,
  } = input;

  async function publishRecoveryRuntimeState(run: RecoveryRun): Promise<void> {
    const derived = buildDerivedRecoveryRuntimeChain(run);
    await runtimeStateRecorder.record(derived);
  }

  async function recordRecoveryProgress(
    run: RecoveryRun,
    progress: {
      phase: RuntimeChainStatus["phase"];
      summary: string;
      statusReason?: string;
      heartbeatSource?: "phase_transition" | "activity_echo" | "control_path" | "reconnect_window" | "long_running_tick";
    }
  ): Promise<void> {
    const derived = buildDerivedRecoveryRuntimeChain(run);
    await runtimeProgressRecorder.record({
      progressId: `progress:recovery:${run.recoveryRunId}:${progress.phase}:${clock.now()}`,
      threadId: run.threadId,
      chainId: derived.chain.chainId,
      spanId: `recovery:${run.recoveryRunId}`,
      subjectKind: "recovery_run",
      subjectId: run.recoveryRunId,
      phase: progress.phase === "resolved" ? "completed" : progress.phase,
      progressKind:
        progress.phase === "waiting" || progress.phase === "heartbeat" || run.status === "resumed"
          ? "heartbeat"
          : "transition",
      heartbeatSource: progress.heartbeatSource ?? (run.status === "resumed" ? "reconnect_window" : "phase_transition"),
      ...(derived.status.continuityState ? { continuityState: derived.status.continuityState } : {}),
      ...(derived.status.responseTimeoutAt ? { responseTimeoutAt: derived.status.responseTimeoutAt } : {}),
      ...(derived.status.reconnectWindowUntil ? { reconnectWindowUntil: derived.status.reconnectWindowUntil } : {}),
      ...(derived.status.closeKind ? { closeKind: derived.status.closeKind } : {}),
      ...(progress.statusReason ? { statusReason: progress.statusReason } : {}),
      summary: progress.summary,
      recordedAt: clock.now(),
      ...(run.flowId ? { flowId: run.flowId } : {}),
      ...(run.taskId ? { taskId: run.taskId } : {}),
      ...(run.roleId ? { roleId: run.roleId } : {}),
      artifacts: {
        recoveryRunId: run.recoveryRunId,
        ...(run.browserSession?.sessionId ? { browserSessionId: run.browserSession.sessionId } : {}),
        ...(run.browserSession?.targetId ? { browserTargetId: run.browserSession.targetId } : {}),
      },
      metadata: {
        sourceGroupId: run.sourceGroupId,
        status: run.status,
        nextAction: run.nextAction,
      },
    });
  }

  function startRecoveryHeartbeat(run: RecoveryRun, action: RecoveryRunAction): () => void {
    const intervalMs = 15_000;
    let stopped = false;
    const timer = setInterval(() => {
      void recordRecoveryProgress(run, {
        phase: "heartbeat",
        summary: `Recovery ${action} is still running for ${run.sourceGroupId}.`,
        heartbeatSource: "long_running_tick",
      }).catch(() => {});
    }, intervalMs);
    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
    };
  }

  function extractRecoveryParentGroupIdFromReplay(record: Awaited<ReturnType<FileReplayRecorder["list"]>>[number]): string | undefined {
    const metadata =
      record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : null;
    const recoveryContext =
      metadata?.recoveryContext && typeof metadata.recoveryContext === "object"
        ? (metadata.recoveryContext as Record<string, unknown>)
        : null;
    return typeof recoveryContext?.parentGroupId === "string" ? recoveryContext.parentGroupId : undefined;
  }

  function isStaleInFlightRecoveryRun(run: RecoveryRun, records: Awaited<ReturnType<FileReplayRecorder["list"]>>, now: number): boolean {
    if (!["running", "retrying", "fallback_running", "resumed", "superseded"].includes(run.status)) {
      return false;
    }
    if (now - run.updatedAt < recoveryRunStaleAfterMs) {
      return false;
    }
    return !records.some((record) => {
      const groupId = record.taskId ?? record.replayId;
      const parentGroupId = extractRecoveryParentGroupIdFromReplay(record);
      return (groupId === run.sourceGroupId || parentGroupId === run.sourceGroupId) && record.recordedAt > run.updatedAt;
    });
  }

  function buildStaleRecoveryRunFailure(run: RecoveryRun, now: number): RecoveryRun {
    const failure = {
      category: "timeout" as const,
      layer: "scheduled" as const,
      retryable: false,
      message: "Recovery dispatch timed out before follow-up completed.",
      recommendedAction: "inspect" as const,
    };
    const { waitingReason: _waitingReason, ...rest } = run;
    return {
      ...rest,
      status: "failed",
      nextAction: "inspect_then_resume",
      autoDispatchReady: false,
      requiresManualIntervention: true,
      latestSummary: failure.message,
      latestFailure: failure,
      updatedAt: now,
      attempts: run.attempts.map((attempt) =>
        attempt.attemptId === run.currentAttemptId && attempt.completedAt == null
          ? {
              ...attempt,
              status: "failed",
              summary: failure.message,
              failure,
              updatedAt: now,
              completedAt: now,
            }
          : attempt
      ),
    };
  }

  async function appendDerivedRecoveryRunEvents(update: {
    previous: RecoveryRun | null;
    next: RecoveryRun;
  }): Promise<void> {
    const previous = update.previous;
    const next = update.next;
    const currentAttempt =
      next.currentAttemptId ? next.attempts.find((attempt) => attempt.attemptId === next.currentAttemptId) ?? null : null;

    if (previous && previous.status === next.status && previous.updatedAt === next.updatedAt) {
      return;
    }

    if (previous?.currentAttemptId && previous.currentAttemptId !== next.currentAttemptId) {
      await recoveryRunEventStore.append({
        eventId: idGenerator.messageId(),
        recoveryRunId: next.recoveryRunId,
        threadId: next.threadId,
        sourceGroupId: next.sourceGroupId,
        kind: "follow_up_observed",
        status: next.status,
        recordedAt: next.updatedAt,
        summary: `Recovery follow-up observed for ${next.sourceGroupId}.`,
        ...(next.currentAttemptId ? { attemptId: next.currentAttemptId } : {}),
        ...(currentAttempt?.triggeredByAttemptId ? { triggeredByAttemptId: currentAttempt.triggeredByAttemptId } : {}),
        ...(currentAttempt?.transitionReason ? { transitionReason: currentAttempt.transitionReason } : {}),
        ...(next.browserSession ? { browserSession: next.browserSession } : {}),
        ...(currentAttempt?.browserOutcome ? { browserOutcome: currentAttempt.browserOutcome } : {}),
        ...(next.latestFailure ? { failure: next.latestFailure } : {}),
      });
      return;
    }

    if (previous?.status === next.status) {
      return;
    }

    const derivedKind = mapRecoveryStatusToEventKind(next.status);
    if (!derivedKind) {
      return;
    }

    await recoveryRunEventStore.append({
      eventId: idGenerator.messageId(),
      recoveryRunId: next.recoveryRunId,
      threadId: next.threadId,
      sourceGroupId: next.sourceGroupId,
      kind: derivedKind,
      status: next.status,
      recordedAt: next.updatedAt,
      summary: next.latestSummary,
      ...(next.currentAttemptId ? { attemptId: next.currentAttemptId } : {}),
      ...(currentAttempt?.triggeredByAttemptId ? { triggeredByAttemptId: currentAttempt.triggeredByAttemptId } : {}),
      ...(currentAttempt?.transitionReason ? { transitionReason: currentAttempt.transitionReason } : {}),
      ...(next.browserSession ? { browserSession: next.browserSession } : {}),
      ...(currentAttempt?.browserOutcome ? { browserOutcome: currentAttempt.browserOutcome } : {}),
      ...(next.latestFailure ? { failure: next.latestFailure } : {}),
    });
  }

  function mapRecoveryStatusToEventKind(status: RecoveryRun["status"]): RecoveryRunEvent["kind"] | null {
    switch (status) {
      case "waiting_approval":
        return "waiting_approval";
      case "waiting_external":
        return "waiting_external";
      case "recovered":
        return "recovered";
      case "aborted":
        return "aborted";
      default:
        return null;
    }
  }

  async function reapStaleRecoveryRuns(
    records: Awaited<ReturnType<FileReplayRecorder["list"]>>,
    existingRuns: RecoveryRun[],
    now: number
  ): Promise<RecoveryRun[]> {
    const nextRuns = [...existingRuns];
    for (let index = 0; index < nextRuns.length; index += 1) {
      const run = nextRuns[index]!;
      if (!isStaleInFlightRecoveryRun(run, records, now)) {
        continue;
      }
      const failed = buildStaleRecoveryRunFailure(run, now);
      nextRuns[index] = failed;
      await recoveryRunStore.put(failed);
      await recoveryRunEventStore.append({
        eventId: idGenerator.messageId(),
        recoveryRunId: failed.recoveryRunId,
        threadId: failed.threadId,
        sourceGroupId: failed.sourceGroupId,
        kind: "action_failed",
        status: "failed",
        recordedAt: now,
        summary: failed.latestSummary,
        ...(failed.currentAttemptId ? { attemptId: failed.currentAttemptId } : {}),
        ...(failed.latestFailure ? { failure: failed.latestFailure } : {}),
        transitionReason: "manual_dispatch",
      });
    }
    return nextRuns;
  }

  async function loadRecoveryRuntime(threadId: string): Promise<RecoveryRuntimeSnapshot> {
    const records = await replayRecorder.list({ threadId });
    const existingRuns = await recoveryRunStore.listByThread(threadId);
    const stabilizedRuns = await reapStaleRecoveryRuns(records, existingRuns, clock.now());
    const report = buildReplayInspectionReport(records);
    const runs = buildRecoveryRuns(records, stabilizedRuns, clock.now());
    return { records, report, runs };
  }

  async function syncRecoveryRuntime(threadId: string): Promise<RecoveryRuntimeSnapshot> {
    const { records, report, runs } = await loadRecoveryRuntime(threadId);
    const existingRuns = await recoveryRunStore.listByThread(threadId);
    const existingByRunId = new Map(existingRuns.map((run) => [run.recoveryRunId, JSON.stringify(run)]));
    const previousByRunId = new Map(existingRuns.map((run) => [run.recoveryRunId, run]));
    const changedRuns = runs.filter((run) => existingByRunId.get(run.recoveryRunId) !== JSON.stringify(run));
    await Promise.all(changedRuns.map((run) => recoveryRunStore.put(run)));
    await Promise.all(
      changedRuns.map((run) =>
        appendDerivedRecoveryRunEvents({
          previous: previousByRunId.get(run.recoveryRunId) ?? null,
          next: run,
        })
      )
    );
    return { records, report, runs };
  }

  function createRecoveryRunSkeleton(recovery: ReplayRecoveryPlan, now: number): RecoveryRun {
    return {
      recoveryRunId: buildRecoveryRunId(recovery.groupId),
      threadId: recovery.threadId,
      sourceGroupId: recovery.groupId,
      ...(recovery.taskId ? { taskId: recovery.taskId } : {}),
      ...(recovery.flowId ? { flowId: recovery.flowId } : {}),
      ...(recovery.roleId ? { roleId: recovery.roleId } : {}),
      ...(recovery.targetLayer ? { targetLayer: recovery.targetLayer } : {}),
      ...(recovery.targetWorker ? { targetWorker: recovery.targetWorker } : {}),
      latestStatus: recovery.latestStatus,
      status: recovery.requiresManualIntervention
        ? recovery.nextAction === "request_approval"
          ? "waiting_approval"
          : "waiting_external"
        : "planned",
      nextAction: recovery.nextAction,
      autoDispatchReady: recovery.autoDispatchReady,
      requiresManualIntervention: recovery.requiresManualIntervention,
      latestSummary: recovery.recoveryHint.reason,
      ...(recovery.requiresManualIntervention ? { waitingReason: recovery.recoveryHint.reason } : {}),
      ...(recovery.latestFailure ? { latestFailure: recovery.latestFailure } : {}),
      attempts: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  function buildRecoveryDispatchTask(task: {
    run: RecoveryRun;
    browserSession?: BrowserContinuationHint;
    nextAction: ReplayRecoveryPlan["nextAction"];
    now: number;
    taskId: string;
    attemptId: string;
    dispatchReplayId: string;
  }): ScheduledTaskRecord {
    if (!task.run.roleId) {
      throw new Error(`recovery run is missing target role: ${task.run.recoveryRunId}`);
    }

    const rawTz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    const tz = rawTz.trim() ? rawTz : "UTC";

    return normalizeScheduledTaskRecord({
      taskId: task.taskId,
      threadId: task.run.threadId,
      dispatch: {
        targetRoleId: task.run.roleId,
        ...(task.run.targetLayer === "worker" && task.run.targetWorker ? { targetWorker: task.run.targetWorker } : {}),
        sessionTarget: task.run.targetLayer === "worker" ? "worker" : "main",
        continuity: {
          mode: task.run.targetLayer === "worker" ? "resume-existing" : "prefer-existing",
          context: {
            source: "recovery_dispatch",
            ...(task.run.targetWorker ? { workerType: task.run.targetWorker } : {}),
            recovery: {
              parentGroupId: task.run.sourceGroupId,
              action: task.nextAction,
              dispatchReplayId: task.dispatchReplayId,
              recoveryRunId: task.run.recoveryRunId,
              attemptId: task.attemptId,
            },
            ...(task.run.targetWorker === "browser" && task.browserSession ? { browserSession: task.browserSession } : {}),
          },
        },
        ...(task.run.targetLayer === "worker" && task.run.targetWorker
          ? { constraints: { preferredWorkerKinds: [task.run.targetWorker] } }
          : {}),
      },
      capsule: {
        title: `Recovery dispatch for ${task.run.sourceGroupId}`,
        instructions: buildRecoveryInstructions(task.run, task.nextAction),
        expectedOutput:
          "Continue from the latest safe checkpoint. If recovery is not possible, return a concise explanation and the next safest action.",
      },
      schedule: {
        kind: "cron",
        expr: "manual-recovery",
        tz,
        nextRunAt: task.now,
      },
      createdAt: task.now,
      updatedAt: task.now,
    });
  }

  function buildRecoveryInstructions(run: RecoveryRun, nextAction: ReplayRecoveryPlan["nextAction"]): string {
    const header = `Recovery plan for ${run.sourceGroupId}. Latest status: ${run.latestStatus}.`;
    const reason = `Reason: ${run.latestFailure?.message ?? run.waitingReason ?? run.latestSummary}`;
    const target =
      run.targetLayer === "worker"
        ? `Resume target: worker${run.targetWorker ? ` (${run.targetWorker})` : ""}.`
        : run.targetLayer
          ? `Resume target: ${run.targetLayer}.`
          : "Resume target: main role context.";

    switch (nextAction) {
      case "auto_resume":
        return `${header} ${reason} ${target} Continue from the latest live continuation context and finish the interrupted work.`;
      case "retry_same_layer":
        return `${header} ${reason} ${target} Retry the previous execution on the same layer without resetting unrelated context.`;
      case "fallback_transport":
        return `${header} ${reason} ${target} Retry using the safest fallback transport or tool path that preserves task intent.`;
      case "request_approval":
        return `${header} ${reason} ${target} Wait for approval before resuming any side-effectful action.`;
      default:
        return `${header} ${reason} ${target} Inspect the latest failure and continue only if the context is still valid.`;
    }
  }

  function mapRecoveryRunActionToNextAction(
    action: RecoveryRunAction,
    recovery: ReplayRecoveryPlan | null,
    run: RecoveryRun
  ): ReplayRecoveryPlan["nextAction"] | null {
    const currentAttempt = run.currentAttemptId
      ? run.attempts.find((attempt) => attempt.attemptId === run.currentAttemptId) ?? null
      : null;

    switch (action) {
      case "dispatch":
        return recovery?.nextAction ?? (run.nextAction === "none" ? null : run.nextAction);
      case "retry":
        return "retry_same_layer";
      case "fallback":
        return "fallback_transport";
      case "resume":
        return "auto_resume";
      case "approve":
        return isDispatchableRecoveryNextAction(currentAttempt?.nextAction)
          ? currentAttempt.nextAction
          : run.targetLayer === "worker"
            ? "retry_same_layer"
            : "auto_resume";
      case "reject":
        return null;
      default:
        return null;
    }
  }

  function isDispatchableRecoveryNextAction(
    nextAction: RecoveryRun["nextAction"] | ReplayRecoveryPlan["nextAction"] | undefined
  ): nextAction is "auto_resume" | "retry_same_layer" | "fallback_transport" {
    return nextAction === "auto_resume" || nextAction === "retry_same_layer" || nextAction === "fallback_transport";
  }

  function transitionReasonForAction(action: RecoveryRunAction) {
    switch (action) {
      case "retry":
        return "manual_retry" as const;
      case "fallback":
        return "manual_fallback" as const;
      case "resume":
        return "manual_resume" as const;
      case "approve":
        return "manual_approval" as const;
      case "reject":
        return "manual_reject" as const;
      case "dispatch":
      default:
        return "manual_dispatch" as const;
    }
  }

  function statusForRecoveryRunAction(action: RecoveryRunAction): RecoveryRun["status"] {
    switch (action) {
      case "retry":
        return "retrying";
      case "fallback":
        return "fallback_running";
      case "resume":
      case "approve":
        return "resumed";
      case "reject":
        return "aborted";
      case "dispatch":
      default:
        return "running";
    }
  }

  function normalizeBrowserOwnerType(value: unknown): BrowserContinuationHint["ownerType"] | undefined {
    return value === "user" || value === "thread" || value === "role" || value === "worker" ? value : undefined;
  }

  function extractBrowserSessionHintFromReplay(
    record: Awaited<ReturnType<FileReplayRecorder["list"]>>[number]
  ): BrowserContinuationHint | undefined {
    const metadata =
      record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : null;
    if (!metadata) {
      return undefined;
    }

    if (record.layer === "browser") {
      const request =
        metadata.request && typeof metadata.request === "object" ? (metadata.request as Record<string, unknown>) : null;
      const result = metadata.result && typeof metadata.result === "object" ? metadata.result : null;
      const decoded = decodeBrowserSessionPayload(result);
      if (!decoded) {
        return undefined;
      }
      const ownerType = normalizeBrowserOwnerType(request?.ownerType);
      const ownerId = typeof request?.ownerId === "string" ? request.ownerId : record.threadId;
      return {
        sessionId: decoded.sessionId,
        ...(decoded.targetId ? { targetId: decoded.targetId } : {}),
        ...(decoded.resumeMode ? { resumeMode: decoded.resumeMode } : {}),
        ...(ownerType ? { ownerType } : {}),
        ...(ownerId ? { ownerId } : {}),
      };
    }

    if (record.layer === "worker") {
      const payload = metadata.payload;
      const decoded = decodeBrowserSessionPayload(payload);
      if (!decoded) {
        return undefined;
      }
      return {
        sessionId: decoded.sessionId,
        ...(decoded.targetId ? { targetId: decoded.targetId } : {}),
        ...(decoded.resumeMode ? { resumeMode: decoded.resumeMode } : {}),
        ownerType: "thread",
        ownerId: record.threadId,
        ...(record.workerRunKey ? { leaseHolderRunKey: record.workerRunKey } : {}),
      };
    }

    return undefined;
  }

  function deriveRecoveryBrowserSessionHint(
    records: Awaited<ReturnType<FileReplayRecorder["list"]>>,
    run: RecoveryRun
  ): BrowserContinuationHint | undefined {
    const candidateTaskIds = new Set<string>([
      run.sourceGroupId,
      ...run.attempts
        .flatMap((attempt) => [attempt.dispatchedTaskId, attempt.resultingGroupId])
        .filter((value): value is string => Boolean(value)),
    ]);
    const relatedRecords = records
      .filter((record) => {
        const groupId = record.taskId ?? record.replayId;
        return candidateTaskIds.has(groupId);
      })
      .sort((left, right) => right.recordedAt - left.recordedAt);

    for (const record of relatedRecords) {
      const hint = extractBrowserSessionHintFromReplay(record);
      if (hint) {
        return hint;
      }
    }

    const latestAttemptHint = [...run.attempts].reverse().find((attempt) => attempt.browserSession)?.browserSession;
    return latestAttemptHint ?? run.browserSession;
  }

  async function executeRecoveryRunActionInner(actionInput: {
    run: RecoveryRun;
    action: RecoveryRunAction;
    records: Awaited<ReturnType<FileReplayRecorder["list"]>>;
    report: ReturnType<typeof buildReplayInspectionReport>;
  }): Promise<{ statusCode: number; body: unknown }> {
    return recoveryRunActionMutex.run(actionInput.run.threadId, async () => {
      const now = clock.now();
      const synced = await syncRecoveryRuntime(actionInput.run.threadId);
      const run = synced.runs.find((item) => item.recoveryRunId === actionInput.run.recoveryRunId) ?? actionInput.run;
      const recoveryPlan = findReplayRecoveryPlan(synced.records, run.sourceGroupId, synced.report);
      const syncedRun = findRecoveryRun(synced.records, run.recoveryRunId, [run], now) ?? run;

      const actionGuardConflict = buildRecoveryRunActionConflict(syncedRun, actionInput.action);
      if (actionGuardConflict) {
        return {
          statusCode: 409,
          body: actionGuardConflict,
        };
      }

      if (actionInput.action === "reject") {
        const attemptId = `${run.recoveryRunId}:attempt:${run.attempts.length + 1}`;
        const triggeredByAttemptId = syncedRun.currentAttemptId;
        const rejectedRun: RecoveryRun = {
          ...syncedRun,
          status: "aborted",
          nextAction: "stop",
          latestSummary: "Recovery was rejected and aborted.",
          currentAttemptId: attemptId,
          updatedAt: now,
          attempts: [
            ...syncedRun.attempts,
            {
              attemptId,
              action: "reject",
              requestedAt: now,
              updatedAt: now,
              status: "aborted",
              nextAction: "stop",
              summary: "Recovery was rejected and aborted.",
              ...(triggeredByAttemptId ? { triggeredByAttemptId } : {}),
              transitionReason: "manual_reject",
              completedAt: now,
            },
          ],
        };
        await recoveryRunStore.put(rejectedRun);
        await publishRecoveryRuntimeState(rejectedRun);
        await recoveryRunEventStore.append({
          eventId: idGenerator.messageId(),
          recoveryRunId: rejectedRun.recoveryRunId,
          threadId: rejectedRun.threadId,
          sourceGroupId: rejectedRun.sourceGroupId,
          kind: "aborted",
          status: "aborted",
          recordedAt: now,
          summary: "Recovery was rejected and aborted.",
          action: "reject",
          attemptId,
          ...(triggeredByAttemptId ? { triggeredByAttemptId } : {}),
          transitionReason: "manual_reject",
        });
        await recordRecoveryProgress(rejectedRun, {
          phase: "cancelled",
          summary: "Recovery was rejected and aborted.",
          statusReason: "manual_reject",
          heartbeatSource: "control_path",
        });
        return {
          statusCode: 200,
          body: {
            accepted: true,
            recoveryRun: rejectedRun,
          },
        };
      }

      if (
        !recoveryPlan &&
        (actionInput.action === "dispatch" ||
          actionInput.action === "retry" ||
          actionInput.action === "fallback" ||
          actionInput.action === "resume")
      ) {
        return {
          statusCode: 409,
          body: buildRecoveryRunActionConflict(
            syncedRun,
            actionInput.action,
            "recovery can no longer be resumed automatically"
          )!,
        };
      }

      if (!syncedRun.roleId) {
        return {
          statusCode: 409,
          body: buildRecoveryRunActionConflict(syncedRun, actionInput.action, "recovery run is missing target role")!,
        };
      }

      const dispatchNextAction = mapRecoveryRunActionToNextAction(actionInput.action, recoveryPlan, syncedRun);
      if (!dispatchNextAction) {
        return {
          statusCode: 409,
          body: buildRecoveryRunActionConflict(syncedRun, actionInput.action, "recovery action is not dispatchable")!,
        };
      }

      if (
        (dispatchNextAction === "retry_same_layer" ||
          dispatchNextAction === "fallback_transport" ||
          dispatchNextAction === "auto_resume") &&
        syncedRun.targetLayer === "worker" &&
        !syncedRun.targetWorker
      ) {
        return {
          statusCode: 409,
          body: buildRecoveryRunActionConflict(syncedRun, actionInput.action, "recovery run is missing target worker")!,
        };
      }

      const browserSession = deriveRecoveryBrowserSessionHint(synced.records, syncedRun);
      const attemptId = `${syncedRun.recoveryRunId}:attempt:${syncedRun.attempts.length + 1}`;
      const taskId = idGenerator.taskId();
      const dispatchReplayId = `${taskId}:scheduled`;
      const supersededAttemptId = syncedRun.currentAttemptId;
      const transitionReason = transitionReasonForAction(actionInput.action);
      await recoveryRunEventStore.append({
        eventId: idGenerator.messageId(),
        recoveryRunId: syncedRun.recoveryRunId,
        threadId: syncedRun.threadId,
        sourceGroupId: syncedRun.sourceGroupId,
        kind: "action_requested",
        status: statusForRecoveryRunAction(actionInput.action),
        recordedAt: now,
        summary: `Recovery ${actionInput.action} requested.`,
        action: actionInput.action,
        attemptId,
        taskId,
        ...(supersededAttemptId ? { triggeredByAttemptId: supersededAttemptId } : {}),
        transitionReason,
        ...(browserSession ? { browserSession } : {}),
      });
      const scheduledTask = buildRecoveryDispatchTask({
        run: syncedRun,
        ...(browserSession ? { browserSession } : {}),
        nextAction: dispatchNextAction,
        now,
        taskId,
        attemptId,
        dispatchReplayId,
      });
      const supersededAttempts: RecoveryRun["attempts"] = syncedRun.attempts.map((attempt) =>
        attempt.attemptId === supersededAttemptId &&
        attempt.status !== "recovered" &&
        attempt.status !== "aborted" &&
        attempt.status !== "superseded"
          ? {
              ...attempt,
              status: "superseded",
              summary: `Superseded by recovery ${actionInput.action}.`,
              updatedAt: now,
              completedAt: attempt.completedAt ?? now,
              supersededAt: now,
              supersededByAttemptId: attemptId,
            }
          : attempt
      );
      const inFlightRun: RecoveryRun = {
        ...syncedRun,
        status: statusForRecoveryRunAction(actionInput.action),
        nextAction: dispatchNextAction,
        latestSummary: `Recovery ${actionInput.action} dispatched.`,
        currentAttemptId: attemptId,
        updatedAt: now,
        ...(browserSession ? { browserSession } : {}),
        attempts: [
          ...supersededAttempts,
          {
            attemptId,
            action: actionInput.action,
            requestedAt: now,
            updatedAt: now,
            status: statusForRecoveryRunAction(actionInput.action),
            nextAction: dispatchNextAction,
            summary: `Recovery ${actionInput.action} dispatched.`,
            ...(syncedRun.targetLayer ? { targetLayer: syncedRun.targetLayer } : {}),
            ...(syncedRun.targetWorker ? { targetWorker: syncedRun.targetWorker } : {}),
            dispatchReplayId,
            dispatchedTaskId: taskId,
            ...(supersededAttemptId ? { triggeredByAttemptId: supersededAttemptId } : {}),
            transitionReason,
            ...(browserSession ? { browserSession } : {}),
          },
        ],
      };
      await recoveryRunStore.put(inFlightRun);
      await publishRecoveryRuntimeState(inFlightRun);
      if (supersededAttemptId) {
        await recoveryRunEventStore.append({
          eventId: idGenerator.messageId(),
          recoveryRunId: inFlightRun.recoveryRunId,
          threadId: inFlightRun.threadId,
          sourceGroupId: inFlightRun.sourceGroupId,
          kind: "action_superseded",
          status: "superseded",
          recordedAt: now,
          summary: `Recovery attempt ${supersededAttemptId} was superseded by ${attemptId}.`,
          action: actionInput.action,
          attemptId: supersededAttemptId,
          triggeredByAttemptId: attemptId,
          transitionReason,
          taskId,
          ...(browserSession ? { browserSession } : {}),
        });
      }
      await recordRecoveryProgress(inFlightRun, {
        phase: buildDerivedRecoveryRuntimeChain(inFlightRun).status.phase,
        summary: `Recovery ${actionInput.action} dispatched for ${inFlightRun.sourceGroupId}.`,
        statusReason: transitionReason,
        heartbeatSource: "control_path",
      });

      const stopRecoveryHeartbeat = startRecoveryHeartbeat(inFlightRun, actionInput.action);
      try {
        await coordinationEngine.handleScheduledTask(scheduledTask);
      } catch (error) {
        stopRecoveryHeartbeat();
        const failure = classifyRuntimeError({
          layer: "scheduled",
          error,
          fallbackMessage: "recovery dispatch failed",
        });
        const targetWorker = getScheduledTargetWorker(scheduledTask);
        await replayRecorder.record({
          replayId: dispatchReplayId,
          layer: "scheduled",
          status: "failed",
          recordedAt: now,
          threadId: scheduledTask.threadId,
          taskId: scheduledTask.taskId,
          roleId: getScheduledTargetRoleId(scheduledTask),
          ...(targetWorker ? { workerType: targetWorker } : {}),
          summary: failure.message,
          failure,
          metadata: {
            sessionTarget: getScheduledSessionTarget(scheduledTask),
            schedule: scheduledTask.schedule,
            capsule: scheduledTask.capsule,
            recoveryContext: getScheduledContinuity(scheduledTask)?.context?.recovery,
          },
        });
        const failedRun: RecoveryRun = {
          ...inFlightRun,
          status: "failed",
          latestSummary: failure.message,
          latestFailure: failure,
          updatedAt: now,
          attempts: inFlightRun.attempts.map((attempt) =>
            attempt.attemptId === attemptId
              ? {
                  ...attempt,
                  status: "failed",
                  summary: failure.message,
                  failure,
                  updatedAt: now,
                  completedAt: now,
                }
              : attempt
          ),
        };
        await recoveryRunStore.put(failedRun);
        await publishRecoveryRuntimeState(failedRun);
        await recoveryRunEventStore.append({
          eventId: idGenerator.messageId(),
          recoveryRunId: failedRun.recoveryRunId,
          threadId: failedRun.threadId,
          sourceGroupId: failedRun.sourceGroupId,
          kind: "action_failed",
          status: "failed",
          recordedAt: now,
          summary: failure.message,
          action: actionInput.action,
          attemptId,
          ...(supersededAttemptId ? { triggeredByAttemptId: supersededAttemptId } : {}),
          transitionReason,
          dispatchReplayId,
          taskId,
          ...(browserSession ? { browserSession } : {}),
          failure,
        });
        await recordRecoveryProgress(failedRun, {
          phase: "failed",
          summary: failure.message,
          statusReason: failure.message,
          heartbeatSource: "control_path",
        });
        return {
          statusCode: 500,
          body: {
            error: failure.message,
            dispatchedTaskId: taskId,
            dispatchReplayId,
            failure,
            recoveryRun: failedRun,
          },
        };
      }
      stopRecoveryHeartbeat();

      const targetWorker = getScheduledTargetWorker(scheduledTask);
      await replayRecorder.record({
        replayId: dispatchReplayId,
        layer: "scheduled",
        status: "completed",
        recordedAt: now,
        threadId: scheduledTask.threadId,
        taskId: scheduledTask.taskId,
        roleId: getScheduledTargetRoleId(scheduledTask),
        ...(targetWorker ? { workerType: targetWorker } : {}),
        summary: `Recovery ${actionInput.action} dispatched for ${syncedRun.sourceGroupId}.`,
        metadata: {
          sessionTarget: getScheduledSessionTarget(scheduledTask),
          schedule: scheduledTask.schedule,
          capsule: scheduledTask.capsule,
          recoveryContext: getScheduledContinuity(scheduledTask)?.context?.recovery,
        },
      });
      await recoveryRunEventStore.append({
        eventId: idGenerator.messageId(),
        recoveryRunId: inFlightRun.recoveryRunId,
        threadId: inFlightRun.threadId,
        sourceGroupId: inFlightRun.sourceGroupId,
        kind: "action_dispatched",
        status: inFlightRun.status,
        recordedAt: now,
        summary: `Recovery ${actionInput.action} dispatched for ${inFlightRun.sourceGroupId}.`,
        action: actionInput.action,
        attemptId,
        ...(supersededAttemptId ? { triggeredByAttemptId: supersededAttemptId } : {}),
        transitionReason,
        dispatchReplayId,
        taskId,
        ...(browserSession ? { browserSession } : {}),
      });

      const refreshed = await syncRecoveryRuntime(syncedRun.threadId);
      const latestRun = refreshed.runs.find((item) => item.recoveryRunId === syncedRun.recoveryRunId) ?? inFlightRun;
      await publishRecoveryRuntimeState(latestRun);
      return {
        statusCode: 202,
        body: {
          accepted: true,
          dispatchedTaskId: taskId,
          dispatchReplayId,
          recoveryRun: latestRun,
        },
      };
    });
  }

  return {
    loadRecoveryRuntime,
    syncRecoveryRuntime,
    async buildRecoverySummary(threadId: string, limit: number): Promise<{ totalRuns: number; runs: RecoveryRun[] }> {
      const synced = await loadRecoveryRuntime(threadId);
      return {
        totalRuns: synced.runs.length,
        runs: synced.runs.slice(0, limit),
      };
    },
    async getReplayRecovery(threadId: string, groupId: string): Promise<ReplayRecoveryPlan | null> {
      const synced = await loadRecoveryRuntime(threadId);
      return findReplayRecoveryPlan(synced.records, groupId, synced.report);
    },
    async listRecoveryRuns(threadId: string): Promise<RecoveryRun[]> {
      return (await loadRecoveryRuntime(threadId)).runs;
    },
    async getRecoveryRun(threadId: string, recoveryRunId: string): Promise<RecoveryRun | null> {
      const synced = await loadRecoveryRuntime(threadId);
      return synced.runs.find((item) => item.recoveryRunId === recoveryRunId) ?? null;
    },
    async getRecoveryTimeline(threadId: string, recoveryRunId: string) {
      const synced = await loadRecoveryRuntime(threadId);
      const run = synced.runs.find((item) => item.recoveryRunId === recoveryRunId) ?? null;
      if (!run) {
        return null;
      }
      const events = await recoveryRunEventStore.listByRecoveryRun(run.recoveryRunId);
      const timeline = buildRecoveryRunTimeline(run, synced.records, events);
      return {
        recoveryRun: run,
        progress: buildRecoveryRunProgress(run),
        totalEntries: timeline.length,
        timeline,
      };
    },
    async executeRecoveryRunActionById(actionByIdInput) {
      const synced = await syncRecoveryRuntime(actionByIdInput.threadId);
      const run = synced.runs.find((item) => item.recoveryRunId === actionByIdInput.recoveryRunId) ?? null;
      if (!run) {
        return { statusCode: 404, body: { error: "recovery run not found" } };
      }
      return executeRecoveryRunActionInner({
        run,
        action: actionByIdInput.action,
        report: synced.report,
        records: synced.records,
      });
    },
    async dispatchReplayRecovery(dispatchInput) {
      const synced = await syncRecoveryRuntime(dispatchInput.threadId);
      const recovery = findReplayRecoveryPlan(synced.records, dispatchInput.groupId, synced.report);
      if (!recovery) {
        return { statusCode: 404, body: { error: "replay recovery not found" } };
      }
      if (!recovery.autoDispatchReady) {
        return {
          statusCode: 409,
          body: {
            error: "recovery requires manual intervention",
            recovery,
          },
        };
      }
      const run = synced.runs.find((item) => item.sourceGroupId === recovery.groupId) ?? createRecoveryRunSkeleton(recovery, clock.now());
      if (!(await recoveryRunStore.get(run.recoveryRunId))) {
        await recoveryRunStore.put(run);
      }
      return executeRecoveryRunActionInner({
        run,
        action: "dispatch",
        report: synced.report,
        records: synced.records,
      });
    },
  };
}
