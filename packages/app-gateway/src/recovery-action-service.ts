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
type TruthAligned<T> = T & {
  confirmed: boolean;
  inferred: boolean;
  stale: boolean;
  truthSource: string;
};
type TruthAlignedRecoverySummary = {
  totalRuns: number;
  runs: TruthAligned<RecoveryRun>[];
  confirmed: boolean;
  inferred: boolean;
  stale: boolean;
  truthSource: string;
};
type TruthAlignedRecoveryTimeline = {
  recoveryRun: TruthAligned<RecoveryRun>;
  progress: ReturnType<typeof buildRecoveryRunProgress>;
  totalEntries: number;
  timeline: ReturnType<typeof buildRecoveryRunTimeline>;
  confirmed: boolean;
  inferred: boolean;
  stale: boolean;
  truthSource: string;
};

export interface RecoveryActionService {
  loadRecoveryRuntime(threadId: string): Promise<RecoveryRuntimeSnapshot>;
  syncRecoveryRuntime(threadId: string): Promise<RecoveryRuntimeSnapshot>;
  buildRecoverySummary(threadId: string, limit: number): Promise<TruthAlignedRecoverySummary>;
  getReplayRecovery(threadId: string, groupId: string): Promise<TruthAligned<ReplayRecoveryPlan> | null>;
  listRecoveryRuns(threadId: string): Promise<Array<TruthAligned<RecoveryRun>>>;
  getRecoveryRun(threadId: string, recoveryRunId: string): Promise<TruthAligned<RecoveryRun> | null>;
  getRecoveryTimeline(threadId: string, recoveryRunId: string): Promise<TruthAlignedRecoveryTimeline | null>;
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
      const failed = await persistStaleRecoveryRunFailureWithRetry({
        initialRun: run,
        records,
        now,
      });
      if (!failed || failed.status !== "failed") {
        if (failed) {
          nextRuns[index] = failed;
        }
        continue;
      }
      nextRuns[index] = failed;
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

  function isQueryStaleRecoveryRun(run: RecoveryRun): boolean {
    return (
      ["running", "retrying", "fallback_running", "resumed", "superseded"].includes(run.status) &&
      clock.now() - run.updatedAt >= recoveryRunStaleAfterMs
    );
  }

  function truthAlignRecoveryRun(run: RecoveryRun, persistedRecoveryRunIds: Set<string>): TruthAligned<RecoveryRun> {
    const confirmed = persistedRecoveryRunIds.has(run.recoveryRunId);
    return {
      ...run,
      confirmed,
      inferred: true,
      stale: isQueryStaleRecoveryRun(run),
      truthSource: confirmed ? "recovery-runtime-query+store" : "recovery-runtime-query",
    };
  }

  function truthAlignReplayRecovery(plan: ReplayRecoveryPlan): TruthAligned<ReplayRecoveryPlan> {
    return {
      ...plan,
      confirmed: false,
      inferred: true,
      stale: plan.latestFailure?.category === "stale_session",
      truthSource: "replay-recovery-query",
    };
  }

  async function syncRecoveryRuntime(threadId: string): Promise<RecoveryRuntimeSnapshot> {
    const { records, report, runs } = await loadRecoveryRuntime(threadId);
    const persistedChanges: Array<{ previous: RecoveryRun | null; next: RecoveryRun }> = [];
    for (const run of runs) {
      persistedChanges.push(
        await persistDerivedRecoveryRunWithRetry({
          desiredRun: run,
          records,
          now: clock.now(),
        })
      );
    }
    await Promise.all(
      persistedChanges.map((change) =>
        appendDerivedRecoveryRunEvents({
          previous: change.previous,
          next: change.next,
        })
      )
    );
    const persistedRuns = await recoveryRunStore.listByThread(threadId);
    return {
      records,
      report,
      runs: buildRecoveryRuns(records, persistedRuns, clock.now()),
    };
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

  function getRequiredScheduledDispatch(task: ScheduledTaskRecord): NonNullable<ScheduledTaskRecord["dispatch"]> {
    const normalized = task.dispatch ? task : normalizeScheduledTaskRecord(task);
    if (!normalized.dispatch) {
      throw new Error(`scheduled task is missing canonical dispatch payload: ${task.taskId}`);
    }
    return normalized.dispatch;
  }

  function getScheduledRecoveryContext(task: ScheduledTaskRecord) {
    return getRequiredScheduledDispatch(task).continuity?.context?.recovery;
  }

  function buildIdempotentRecoveryActionResponse(
    run: RecoveryRun,
    action: RecoveryRunAction
  ): { statusCode: number; body: unknown } | null {
    const currentAttempt = run.currentAttemptId
      ? run.attempts.find((attempt) => attempt.attemptId === run.currentAttemptId) ?? null
      : null;
    if (!currentAttempt || currentAttempt.action !== action) {
      return null;
    }

    if (action === "reject" && run.status === "aborted") {
      return {
        statusCode: 200,
        body: {
          accepted: true,
          idempotent: true,
          recoveryRun: run,
        },
      };
    }

    if (["running", "retrying", "fallback_running", "resumed"].includes(run.status)) {
      return {
        statusCode: 202,
        body: {
          accepted: true,
          idempotent: true,
          ...(currentAttempt.dispatchedTaskId ? { dispatchedTaskId: currentAttempt.dispatchedTaskId } : {}),
          ...(currentAttempt.dispatchReplayId ? { dispatchReplayId: currentAttempt.dispatchReplayId } : {}),
          recoveryRun: run,
        },
      };
    }

    return null;
  }

  function isVersionConflictError(error: unknown): boolean {
    return error instanceof Error && error.message.includes("version conflict");
  }

  async function persistStaleRecoveryRunFailureWithRetry(input: {
    initialRun: RecoveryRun;
    records: Awaited<ReturnType<FileReplayRecorder["list"]>>;
    now: number;
  }): Promise<RecoveryRun | null> {
    let currentRun: RecoveryRun | null = input.initialRun;
    while (currentRun) {
      if (!isStaleInFlightRecoveryRun(currentRun, input.records, input.now)) {
        return currentRun;
      }

      const failedRun = buildStaleRecoveryRunFailure(currentRun, input.now);
      try {
        await recoveryRunStore.put(failedRun, { expectedVersion: currentRun.version });
        return failedRun;
      } catch (error) {
        if (!isVersionConflictError(error)) {
          throw error;
        }
        currentRun = await recoveryRunStore.get(currentRun.recoveryRunId);
      }
    }

    return null;
  }

  async function persistDerivedRecoveryRunWithRetry(input: {
    desiredRun: RecoveryRun;
    records: Awaited<ReturnType<FileReplayRecorder["list"]>>;
    now: number;
  }): Promise<{ previous: RecoveryRun | null; next: RecoveryRun }> {
    let previous = await recoveryRunStore.get(input.desiredRun.recoveryRunId);
    let next = input.desiredRun;

    while (true) {
      if (JSON.stringify(previous) === JSON.stringify(next)) {
        return {
          previous,
          next,
        };
      }

      try {
        await recoveryRunStore.put(next, { expectedVersion: previous?.version });
        return {
          previous,
          next,
        };
      } catch (error) {
        if (!isVersionConflictError(error)) {
          throw error;
        }
        previous = await recoveryRunStore.get(input.desiredRun.recoveryRunId);
        if (!previous) {
          next = input.desiredRun;
          continue;
        }
        next = findRecoveryRun(input.records, input.desiredRun.recoveryRunId, [previous], input.now) ?? previous;
      }
    }
  }

  async function ensureRecoveryRunExistsWithRetry(input: {
    recovery: ReplayRecoveryPlan;
    existingRun: RecoveryRun | null;
    now: number;
  }): Promise<RecoveryRun> {
    if (input.existingRun) {
      return input.existingRun;
    }

    const skeleton = createRecoveryRunSkeleton(input.recovery, input.now);
    while (true) {
      const existing = await recoveryRunStore.get(skeleton.recoveryRunId);
      if (existing) {
        return existing;
      }
      try {
        await recoveryRunStore.put(skeleton, { expectedVersion: skeleton.version });
        return skeleton;
      } catch (error) {
        if (!isVersionConflictError(error)) {
          throw error;
        }
      }
    }
  }

  async function persistRejectedRecoveryRunWithRetry(input: {
    initialRun: RecoveryRun;
    now: number;
  }): Promise<
    | { kind: "ok"; run: RecoveryRun; attemptId: string; triggeredByAttemptId?: string }
    | { kind: "conflict"; statusCode: number; body: unknown }
  > {
    let currentRun: RecoveryRun | null = input.initialRun;
    while (currentRun) {
      const actionGuardConflict = buildRecoveryRunActionConflict(currentRun, "reject");
      if (actionGuardConflict) {
        return {
          kind: "conflict",
          statusCode: 409,
          body: actionGuardConflict,
        };
      }

      const attemptId = `${currentRun.recoveryRunId}:attempt:${currentRun.attempts.length + 1}`;
      const triggeredByAttemptId = currentRun.currentAttemptId;
      const rejectedRun: RecoveryRun = {
        ...currentRun,
        status: "aborted",
        nextAction: "stop",
        latestSummary: "Recovery was rejected and aborted.",
        currentAttemptId: attemptId,
        updatedAt: input.now,
        attempts: [
          ...currentRun.attempts,
          {
            attemptId,
            action: "reject",
            requestedAt: input.now,
            updatedAt: input.now,
            status: "aborted",
            nextAction: "stop",
            summary: "Recovery was rejected and aborted.",
            ...(triggeredByAttemptId ? { triggeredByAttemptId } : {}),
            transitionReason: "manual_reject",
            completedAt: input.now,
          },
        ],
      };

      try {
        await recoveryRunStore.put(rejectedRun, { expectedVersion: currentRun.version });
        return {
          kind: "ok",
          run: rejectedRun,
          attemptId,
          ...(triggeredByAttemptId ? { triggeredByAttemptId } : {}),
        };
      } catch (error) {
        if (!isVersionConflictError(error)) {
          throw error;
        }
        currentRun = await recoveryRunStore.get(currentRun.recoveryRunId);
      }
    }

    return {
      kind: "conflict",
      statusCode: 404,
      body: { error: "recovery run not found" },
    };
  }

  async function persistDispatchRecoveryRunWithRetry(input: {
    initialRun: RecoveryRun;
    action: RecoveryRunAction;
    recoveryPlan: ReplayRecoveryPlan | null;
    records: Awaited<ReturnType<FileReplayRecorder["list"]>>;
    now: number;
  }): Promise<
    | {
        kind: "ok";
        run: RecoveryRun;
        persistedVersion: number;
        attemptId: string;
        taskId: string;
        dispatchReplayId: string;
        transitionReason: ReturnType<typeof transitionReasonForAction>;
        supersededAttemptId?: string;
        browserSession?: BrowserContinuationHint;
        scheduledTask: ScheduledTaskRecord;
      }
    | { kind: "conflict"; statusCode: number; body: unknown }
  > {
    let currentRun: RecoveryRun | null = input.initialRun;
    while (currentRun) {
      const actionGuardConflict = buildRecoveryRunActionConflict(currentRun, input.action);
      if (actionGuardConflict) {
        return {
          kind: "conflict",
          statusCode: 409,
          body: actionGuardConflict,
        };
      }

      const dispatchNextAction = mapRecoveryRunActionToNextAction(input.action, input.recoveryPlan, currentRun);
      if (!dispatchNextAction) {
        return {
          kind: "conflict",
          statusCode: 409,
          body: buildRecoveryRunActionConflict(currentRun, input.action, "recovery action is not dispatchable")!,
        };
      }

      if (!currentRun.roleId) {
        return {
          kind: "conflict",
          statusCode: 409,
          body: buildRecoveryRunActionConflict(currentRun, input.action, "recovery run is missing target role")!,
        };
      }

      if (
        (dispatchNextAction === "retry_same_layer" ||
          dispatchNextAction === "fallback_transport" ||
          dispatchNextAction === "auto_resume") &&
        currentRun.targetLayer === "worker" &&
        !currentRun.targetWorker
      ) {
        return {
          kind: "conflict",
          statusCode: 409,
          body: buildRecoveryRunActionConflict(currentRun, input.action, "recovery run is missing target worker")!,
        };
      }

      const browserSession = deriveRecoveryBrowserSessionHint(input.records, currentRun);
      const attemptId = `${currentRun.recoveryRunId}:attempt:${currentRun.attempts.length + 1}`;
      const taskId = idGenerator.taskId();
      const dispatchReplayId = `${taskId}:scheduled`;
      const supersededAttemptId = currentRun.currentAttemptId;
      const transitionReason = transitionReasonForAction(input.action);
      const scheduledTask = buildRecoveryDispatchTask({
        run: currentRun,
        ...(browserSession ? { browserSession } : {}),
        nextAction: dispatchNextAction,
        now: input.now,
        taskId,
        attemptId,
        dispatchReplayId,
      });
      const supersededAttempts: RecoveryRun["attempts"] = currentRun.attempts.map((attempt) =>
        attempt.attemptId === supersededAttemptId &&
        attempt.status !== "recovered" &&
        attempt.status !== "aborted" &&
        attempt.status !== "superseded"
          ? {
              ...attempt,
              status: "superseded",
              summary: `Superseded by recovery ${input.action}.`,
              updatedAt: input.now,
              completedAt: attempt.completedAt ?? input.now,
              supersededAt: input.now,
              supersededByAttemptId: attemptId,
            }
          : attempt
      );
      const inFlightRun: RecoveryRun = {
        ...currentRun,
        status: statusForRecoveryRunAction(input.action),
        nextAction: dispatchNextAction,
        latestSummary: `Recovery ${input.action} dispatched.`,
        currentAttemptId: attemptId,
        updatedAt: input.now,
        ...(browserSession ? { browserSession } : {}),
        attempts: [
          ...supersededAttempts,
          {
            attemptId,
            action: input.action,
            requestedAt: input.now,
            updatedAt: input.now,
            status: statusForRecoveryRunAction(input.action),
            nextAction: dispatchNextAction,
            summary: `Recovery ${input.action} dispatched.`,
            ...(currentRun.targetLayer ? { targetLayer: currentRun.targetLayer } : {}),
            ...(currentRun.targetWorker ? { targetWorker: currentRun.targetWorker } : {}),
            dispatchReplayId,
            dispatchedTaskId: taskId,
            ...(supersededAttemptId ? { triggeredByAttemptId: supersededAttemptId } : {}),
            transitionReason,
            ...(browserSession ? { browserSession } : {}),
          },
        ],
      };

      try {
        await recoveryRunStore.put(inFlightRun, { expectedVersion: currentRun.version });
        return {
          kind: "ok",
          run: inFlightRun,
          persistedVersion: (currentRun.version ?? 0) + 1,
          attemptId,
          taskId,
          dispatchReplayId,
          transitionReason,
          ...(supersededAttemptId ? { supersededAttemptId } : {}),
          ...(browserSession ? { browserSession } : {}),
          scheduledTask,
        };
      } catch (error) {
        if (!isVersionConflictError(error)) {
          throw error;
        }
        currentRun = await recoveryRunStore.get(currentRun.recoveryRunId);
      }
    }

    return {
      kind: "conflict",
      statusCode: 404,
      body: { error: "recovery run not found" },
    };
  }

  async function persistFailedDispatchedRecoveryRunWithRetry(input: {
    initialRun: RecoveryRun;
    attemptId: string;
    failure: ReturnType<typeof classifyRuntimeError>;
    now: number;
  }): Promise<
    | {
        kind: "ok";
        run: RecoveryRun;
        persistedVersion: number;
      }
    | { kind: "conflict"; statusCode: number; body: unknown }
  > {
    let currentRun: RecoveryRun | null = input.initialRun;
    while (currentRun) {
      const currentAttempt = currentRun.attempts.find((attempt) => attempt.attemptId === input.attemptId) ?? null;
      if (!currentAttempt || currentRun.currentAttemptId !== input.attemptId) {
        return {
          kind: "conflict",
          statusCode: 409,
          body: {
            error: "recovery run changed while dispatch failure was being recorded",
            recoveryRun: currentRun,
          },
        };
      }

      const failedRun: RecoveryRun = {
        ...currentRun,
        status: "failed",
        latestSummary: input.failure.message,
        latestFailure: input.failure,
        updatedAt: input.now,
        attempts: currentRun.attempts.map((attempt) =>
          attempt.attemptId === input.attemptId
            ? {
                ...attempt,
                status: "failed",
                summary: input.failure.message,
                failure: input.failure,
                updatedAt: input.now,
                completedAt: input.now,
              }
            : attempt
        ),
      };

      try {
        await recoveryRunStore.put(failedRun, { expectedVersion: currentRun.version });
        return {
          kind: "ok",
          run: failedRun,
          persistedVersion: (currentRun.version ?? 0) + 1,
        };
      } catch (error) {
        if (!isVersionConflictError(error)) {
          throw error;
        }
        currentRun = await recoveryRunStore.get(currentRun.recoveryRunId);
      }
    }

    return {
      kind: "conflict",
      statusCode: 404,
      body: { error: "recovery run not found" },
    };
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
        return buildIdempotentRecoveryActionResponse(syncedRun, actionInput.action) ?? {
          statusCode: 409,
          body: actionGuardConflict,
        };
      }

      if (actionInput.action === "reject") {
        const rejected = await persistRejectedRecoveryRunWithRetry({
          initialRun: syncedRun,
          now,
        });
        if (rejected.kind === "conflict") {
          return {
            statusCode: rejected.statusCode,
            body: rejected.body,
          };
        }
        const rejectedRun = rejected.run;
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
          attemptId: rejected.attemptId,
          ...(rejected.triggeredByAttemptId ? { triggeredByAttemptId: rejected.triggeredByAttemptId } : {}),
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

      const dispatched = await persistDispatchRecoveryRunWithRetry({
        initialRun: syncedRun,
        action: actionInput.action,
        recoveryPlan,
        records: synced.records,
        now,
      });
      if (dispatched.kind === "conflict") {
        return {
          statusCode: dispatched.statusCode,
          body: dispatched.body,
        };
      }
      const inFlightRun = dispatched.run;
      const persistedInFlightVersion = dispatched.persistedVersion;
      const persistedInFlightRun: RecoveryRun = {
        ...inFlightRun,
        version: persistedInFlightVersion,
      };
      await recoveryRunEventStore.append({
        eventId: idGenerator.messageId(),
        recoveryRunId: inFlightRun.recoveryRunId,
        threadId: inFlightRun.threadId,
        sourceGroupId: inFlightRun.sourceGroupId,
        kind: "action_requested",
        status: statusForRecoveryRunAction(actionInput.action),
        recordedAt: now,
        summary: `Recovery ${actionInput.action} requested.`,
        action: actionInput.action,
        attemptId: dispatched.attemptId,
        taskId: dispatched.taskId,
        ...(dispatched.supersededAttemptId ? { triggeredByAttemptId: dispatched.supersededAttemptId } : {}),
        transitionReason: dispatched.transitionReason,
        ...(dispatched.browserSession ? { browserSession: dispatched.browserSession } : {}),
      });
      await publishRecoveryRuntimeState(persistedInFlightRun);
      if (dispatched.supersededAttemptId) {
        await recoveryRunEventStore.append({
          eventId: idGenerator.messageId(),
          recoveryRunId: inFlightRun.recoveryRunId,
          threadId: inFlightRun.threadId,
          sourceGroupId: inFlightRun.sourceGroupId,
          kind: "action_superseded",
          status: "superseded",
          recordedAt: now,
          summary: `Recovery attempt ${dispatched.supersededAttemptId} was superseded by ${dispatched.attemptId}.`,
          action: actionInput.action,
          attemptId: dispatched.supersededAttemptId,
          triggeredByAttemptId: dispatched.attemptId,
          transitionReason: dispatched.transitionReason,
          taskId: dispatched.taskId,
          ...(dispatched.browserSession ? { browserSession: dispatched.browserSession } : {}),
        });
      }
      await recordRecoveryProgress(persistedInFlightRun, {
        phase: buildDerivedRecoveryRuntimeChain(persistedInFlightRun).status.phase,
        summary: `Recovery ${actionInput.action} dispatched for ${inFlightRun.sourceGroupId}.`,
        statusReason: dispatched.transitionReason,
        heartbeatSource: "control_path",
      });

      const stopRecoveryHeartbeat = startRecoveryHeartbeat(persistedInFlightRun, actionInput.action);
      try {
        await coordinationEngine.handleScheduledTask(dispatched.scheduledTask);
      } catch (error) {
        stopRecoveryHeartbeat();
        const failure = classifyRuntimeError({
          layer: "scheduled",
          error,
          fallbackMessage: "recovery dispatch failed",
        });
        const scheduledDispatch = getRequiredScheduledDispatch(dispatched.scheduledTask);
        const targetWorker = scheduledDispatch.targetWorker;
        await replayRecorder.record({
          replayId: dispatched.dispatchReplayId,
          layer: "scheduled",
          status: "failed",
          recordedAt: now,
          threadId: dispatched.scheduledTask.threadId,
          taskId: dispatched.scheduledTask.taskId,
          roleId: scheduledDispatch.targetRoleId,
          ...(targetWorker ? { workerType: targetWorker } : {}),
          summary: failure.message,
          failure,
          metadata: {
            sessionTarget: scheduledDispatch.sessionTarget,
            schedule: dispatched.scheduledTask.schedule,
            capsule: dispatched.scheduledTask.capsule,
            recoveryContext: getScheduledRecoveryContext(dispatched.scheduledTask),
          },
        });
        const failed = await persistFailedDispatchedRecoveryRunWithRetry({
          initialRun: persistedInFlightRun,
          attemptId: dispatched.attemptId,
          failure,
          now,
        });
        if (failed.kind === "conflict") {
          return {
            statusCode: failed.statusCode,
            body: failed.body,
          };
        }
        const failedRun = failed.run;
        const persistedFailedRun: RecoveryRun = {
          ...failedRun,
          version: failed.persistedVersion,
        };
        await publishRecoveryRuntimeState(persistedFailedRun);
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
          attemptId: dispatched.attemptId,
          ...(dispatched.supersededAttemptId ? { triggeredByAttemptId: dispatched.supersededAttemptId } : {}),
          transitionReason: dispatched.transitionReason,
          dispatchReplayId: dispatched.dispatchReplayId,
          taskId: dispatched.taskId,
          ...(dispatched.browserSession ? { browserSession: dispatched.browserSession } : {}),
          failure,
        });
        await recordRecoveryProgress(persistedFailedRun, {
          phase: "failed",
          summary: failure.message,
          statusReason: failure.message,
          heartbeatSource: "control_path",
        });
        return {
          statusCode: 500,
          body: {
            error: failure.message,
            dispatchedTaskId: dispatched.taskId,
            dispatchReplayId: dispatched.dispatchReplayId,
            failure,
            recoveryRun: failedRun,
          },
        };
      }
      stopRecoveryHeartbeat();

      const scheduledDispatch = getRequiredScheduledDispatch(dispatched.scheduledTask);
      const targetWorker = scheduledDispatch.targetWorker;
      await replayRecorder.record({
        replayId: dispatched.dispatchReplayId,
        layer: "scheduled",
        status: "completed",
        recordedAt: now,
        threadId: dispatched.scheduledTask.threadId,
        taskId: dispatched.scheduledTask.taskId,
        roleId: scheduledDispatch.targetRoleId,
        ...(targetWorker ? { workerType: targetWorker } : {}),
        summary: `Recovery ${actionInput.action} dispatched for ${syncedRun.sourceGroupId}.`,
        metadata: {
          sessionTarget: scheduledDispatch.sessionTarget,
          schedule: dispatched.scheduledTask.schedule,
          capsule: dispatched.scheduledTask.capsule,
          recoveryContext: getScheduledRecoveryContext(dispatched.scheduledTask),
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
        attemptId: dispatched.attemptId,
        ...(dispatched.supersededAttemptId ? { triggeredByAttemptId: dispatched.supersededAttemptId } : {}),
        transitionReason: dispatched.transitionReason,
        dispatchReplayId: dispatched.dispatchReplayId,
        taskId: dispatched.taskId,
        ...(dispatched.browserSession ? { browserSession: dispatched.browserSession } : {}),
      });

      const refreshed = await syncRecoveryRuntime(syncedRun.threadId);
      const latestRun = refreshed.runs.find((item) => item.recoveryRunId === syncedRun.recoveryRunId) ?? inFlightRun;
      await publishRecoveryRuntimeState(latestRun);
      return {
        statusCode: 202,
        body: {
          accepted: true,
          dispatchedTaskId: dispatched.taskId,
          dispatchReplayId: dispatched.dispatchReplayId,
          recoveryRun: latestRun,
        },
      };
    });
  }

  return {
    loadRecoveryRuntime,
    syncRecoveryRuntime,
    async buildRecoverySummary(threadId: string, limit: number): Promise<TruthAlignedRecoverySummary> {
      const synced = await loadRecoveryRuntime(threadId);
      const persistedRecoveryRunIds = new Set((await recoveryRunStore.listByThread(threadId)).map((run) => run.recoveryRunId));
      return {
        totalRuns: synced.runs.length,
        runs: synced.runs.slice(0, limit).map((run) => truthAlignRecoveryRun(run, persistedRecoveryRunIds)),
        confirmed: false,
        inferred: true,
        stale: synced.runs.some((run) => isQueryStaleRecoveryRun(run)),
        truthSource: "recovery-summary-query",
      };
    },
    async getReplayRecovery(threadId: string, groupId: string): Promise<TruthAligned<ReplayRecoveryPlan> | null> {
      const synced = await loadRecoveryRuntime(threadId);
      const plan = findReplayRecoveryPlan(synced.records, groupId, synced.report);
      return plan ? truthAlignReplayRecovery(plan) : null;
    },
    async listRecoveryRuns(threadId: string): Promise<Array<TruthAligned<RecoveryRun>>> {
      const synced = await loadRecoveryRuntime(threadId);
      const persistedRecoveryRunIds = new Set((await recoveryRunStore.listByThread(threadId)).map((run) => run.recoveryRunId));
      return synced.runs.map((run) => truthAlignRecoveryRun(run, persistedRecoveryRunIds));
    },
    async getRecoveryRun(threadId: string, recoveryRunId: string): Promise<TruthAligned<RecoveryRun> | null> {
      const synced = await loadRecoveryRuntime(threadId);
      const persistedRecoveryRunIds = new Set((await recoveryRunStore.listByThread(threadId)).map((run) => run.recoveryRunId));
      const run = synced.runs.find((item) => item.recoveryRunId === recoveryRunId) ?? null;
      return run ? truthAlignRecoveryRun(run, persistedRecoveryRunIds) : null;
    },
    async getRecoveryTimeline(threadId: string, recoveryRunId: string) {
      const synced = await loadRecoveryRuntime(threadId);
      const run = synced.runs.find((item) => item.recoveryRunId === recoveryRunId) ?? null;
      if (!run) {
        return null;
      }
      const persistedRecoveryRunIds = new Set((await recoveryRunStore.listByThread(threadId)).map((item) => item.recoveryRunId));
      const truthAlignedRun = truthAlignRecoveryRun(run, persistedRecoveryRunIds);
      const events = await recoveryRunEventStore.listByRecoveryRun(run.recoveryRunId);
      const timeline = buildRecoveryRunTimeline(run, synced.records, events);
      return {
        recoveryRun: truthAlignedRun,
        progress: buildRecoveryRunProgress(run),
        totalEntries: timeline.length,
        timeline,
        confirmed: truthAlignedRun.confirmed,
        inferred: true,
        stale: truthAlignedRun.stale,
        truthSource: "recovery-timeline-query",
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
      const run = await ensureRecoveryRunExistsWithRetry({
        recovery,
        existingRun: synced.runs.find((item) => item.sourceGroupId === recovery.groupId) ?? null,
        now: clock.now(),
      });
      return executeRecoveryRunActionInner({
        run,
        action: "dispatch",
        report: synced.report,
        records: synced.records,
      });
    },
  };
}
