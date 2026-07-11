import type {
  RuntimeProgressRecorder,
  WorkerSessionContextRecord,
  WorkerCancelInput,
  SpawnedWorker,
  WorkerExecutionResult,
  WorkerHandler,
  WorkerInterruptInput,
  WorkerInvocationInput,
  WorkerKind,
  WorkerMessageInput,
  WorkerResumeInput,
  WorkerRegistry,
  WorkerSessionRecord,
  WorkerSessionStore,
  WorkerStartupReconcileResult,
  WorkerRuntime,
  WorkerSessionState,
  WorkerSessionHistoryEntry,
} from "@turnkeyai/core-types/team";

interface InMemoryWorkerRuntimeOptions {
  workerRegistry: WorkerRegistry;
  now?: () => number;
  runtimeProgressRecorder?: RuntimeProgressRecorder;
  heartbeatIntervalMs?: number;
  sessionStore?: WorkerSessionStore;
}

const ACTIVE_RESPONSE_TIMEOUT_MS = 3 * 60 * 1000;
const WAITING_RESPONSE_TIMEOUT_MS = 15 * 60 * 1000;
const TRANSIENT_RECONNECT_WINDOW_MS = 60 * 1000;
const LONG_RUNNING_HEARTBEAT_MS = 15 * 1000;

type WorkerSessionEntry = {
  handler?: WorkerHandler;
  state: WorkerSessionState;
  executionToken: number;
  activeAbortController?: AbortController;
  preserveLateResultOnAbort?: boolean;
  context?: WorkerSessionContextRecord;
  pendingInvocation?: WorkerSessionRecord["pendingInvocation"];
};

class WorkerDeadlineExceededError extends Error {
  readonly code = "worker_deadline_exceeded" as const;

  constructor(readonly deadlineAt: number) {
    super(`background worker deadline exceeded at ${deadlineAt}`);
    this.name = "AbortError";
  }
}

export class InMemoryWorkerRuntime implements WorkerRuntime {
  private readonly workerRegistry: WorkerRegistry;
  private readonly now: () => number;
  private readonly runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  private readonly heartbeatIntervalMs: number;
  private readonly sessionStore: WorkerSessionStore | undefined;
  private readonly sessions = new Map<string, WorkerSessionEntry>();
  private hydratePromise: Promise<void> | null = null;
  private startupReconcileResult: WorkerStartupReconcileResult = {
    totalSessions: 0,
    downgradedRunningSessions: 0,
    unrecoverableSessions: 0,
    unrecoverableMissingContextSessions: 0,
    unrecoverableUnavailableHandlerSessions: 0,
  };
  private backgroundStartupReconciled = false;

  constructor(options: InMemoryWorkerRuntimeOptions) {
    this.workerRegistry = options.workerRegistry;
    this.now = options.now ?? (() => Date.now());
    this.runtimeProgressRecorder = options.runtimeProgressRecorder;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? LONG_RUNNING_HEARTBEAT_MS;
    this.sessionStore = options.sessionStore;
  }

  private async ensureHydrated(): Promise<void> {
    if (!this.sessionStore) {
      return;
    }
    if (!this.hydratePromise) {
      this.hydratePromise = this.hydrateSessions();
    }
    await this.hydratePromise;
  }

  private async hydrateSessions(): Promise<void> {
    if (!this.sessionStore) {
      return;
    }
    const records = await this.sessionStore.list();
    const now = this.now();
    let downgradedRunningSessions = 0;
    let unrecoverableMissingContextSessions = 0;
    let unrecoverableUnavailableHandlerSessions = 0;
    for (const record of records) {
      let nextRecord = record;
      const recoverableStatus = requiresRestartRecovery(record.state.status);
      const expiredBackground =
        recoverableStatus &&
        record.context?.background === true &&
        record.context.deadlineAt !== undefined &&
        record.context.deadlineAt <= now;
      const missingContext = recoverableStatus && !hasRecoverableContext(record.context);
      const handlerUnavailable =
        recoverableStatus && !missingContext && (await this.isHandlerUnavailableForRestart(record.state.workerType));

      if (expiredBackground) {
        nextRecord = buildExpiredBackgroundRecord(record, now);
      } else if (missingContext) {
        unrecoverableMissingContextSessions += 1;
        nextRecord = buildUnrecoverableHydratedRecord(record, now, {
          message: "Worker runtime restarted but the persisted session context was missing, so the session cannot resume.",
        });
      } else if (handlerUnavailable) {
        unrecoverableUnavailableHandlerSessions += 1;
        nextRecord = buildUnrecoverableHydratedRecord(record, now, {
          message: `Worker runtime restarted but no handler is available for ${record.state.workerType}, so the session cannot resume.`,
        });
      } else if (record.state.status === "running") {
        const summary = buildHydrationContinuationSummary(record.state);
        const nextState = {
          ...record.state,
          status: "resumable" as const,
          updatedAt: now,
          lastError: {
            code: "WORKER_TIMEOUT" as const,
            message: "Worker runtime restarted while execution was in progress.",
            retryable: true,
          },
          continuationDigest: {
            reason: "supervisor_retry" as const,
            summary,
            createdAt: now,
          },
        };
        nextRecord = {
          ...record,
          state: appendWorkerHistory(
            nextState,
            buildWorkerControlHistoryEntry(nextState, "interrupted", summary, now)
          ),
        };
        downgradedRunningSessions += 1;
      }
      this.sessions.set(nextRecord.workerRunKey, {
        state: nextRecord.state,
        executionToken: nextRecord.executionToken,
        ...(nextRecord.context ? { context: nextRecord.context } : {}),
        ...(nextRecord.pendingInvocation
          ? { pendingInvocation: nextRecord.pendingInvocation }
          : {}),
      });
      if (nextRecord !== record) {
        await this.sessionStore.put(nextRecord);
      }
    }
    this.startupReconcileResult = {
      totalSessions: records.length,
      downgradedRunningSessions,
      unrecoverableSessions: unrecoverableMissingContextSessions + unrecoverableUnavailableHandlerSessions,
      unrecoverableMissingContextSessions,
      unrecoverableUnavailableHandlerSessions,
    };
  }

  private async isHandlerUnavailableForRestart(workerType: WorkerSessionState["workerType"]): Promise<boolean> {
    if (!this.workerRegistry.getHandler) {
      return false;
    }
    return (await this.workerRegistry.getHandler(workerType)) == null;
  }

  private async persistSession(workerRunKey: string): Promise<void> {
    if (!this.sessionStore) {
      return;
    }
    const entry = this.sessions.get(workerRunKey);
    if (!entry) {
      return;
    }
    const record: WorkerSessionRecord = {
      workerRunKey,
      state: entry.state,
      executionToken: entry.executionToken,
      ...(entry.context ? { context: entry.context } : {}),
      ...(entry.pendingInvocation
        ? { pendingInvocation: entry.pendingInvocation }
        : {}),
    };
    await this.sessionStore.put(record);
  }

  private async resolveHandler(entry: WorkerSessionEntry, input: WorkerInvocationInput): Promise<WorkerHandler | null> {
    if (entry.handler) {
      return entry.handler;
    }
    const direct = this.workerRegistry.getHandler ? await this.workerRegistry.getHandler(entry.state.workerType) : null;
    if (direct) {
      entry.handler = direct;
      return direct;
    }
    const selected = await this.workerRegistry.selectHandler({
      activation: input.activation,
      packet: input.packet,
      sessionState: entry.state,
    });
    if (selected?.kind === entry.state.workerType) {
      entry.handler = selected;
      return selected;
    }
    return null;
  }

  async spawn(input: WorkerInvocationInput): Promise<SpawnedWorker | null> {
    await this.ensureHydrated();
    const handler = await this.workerRegistry.selectHandler(input);
    if (!handler) {
      return null;
    }

    const workerRunKey = `worker:${handler.kind}:task:${input.activation.handoff.taskId}`;
    const now = this.now();
    this.sessions.set(workerRunKey, {
      handler,
      state: {
        workerRunKey,
        workerType: handler.kind,
        status: "idle",
        createdAt: now,
        updatedAt: now,
      },
      executionToken: 0,
      context: {
        threadId: input.activation.thread.threadId,
        flowId: input.activation.flow.flowId,
        taskId: input.activation.handoff.taskId,
        roleId: input.activation.runState.roleId,
        parentSpanId: `role:${input.activation.runState.runKey}`,
        ...(input.packet.workerSession?.parentSessionKey
          ? { parentSessionKey: input.packet.workerSession.parentSessionKey }
          : {}),
        ...(input.packet.workerSession?.toolCallId ? { toolCallId: input.packet.workerSession.toolCallId } : {}),
        ...(input.packet.workerSession?.label ? { label: input.packet.workerSession.label } : {}),
        ...(input.packet.workerSession?.background === true
          ? { background: true }
          : {}),
        ...(input.packet.workerSession?.deadlineAt === undefined
          ? {}
          : { deadlineAt: input.packet.workerSession.deadlineAt }),
      },
    });
    await this.persistSession(workerRunKey);

    return {
      workerType: handler.kind,
      workerRunKey,
    };
  }

  async send(input: WorkerMessageInput): Promise<WorkerExecutionResult | null> {
    await this.ensureHydrated();
    const session = this.sessions.get(input.workerRunKey);
    if (!session) {
      return null;
    }
    const handler = await this.resolveHandler(session, {
      activation: input.activation,
      packet: input.packet,
    });
    if (!handler) {
      const now = this.now();
      const errorMessage = `worker handler unavailable for ${session.state.workerType}`;
      session.state = {
        ...session.state,
        status: "failed",
        updatedAt: now,
        currentTaskId: input.activation.handoff.taskId,
        lastError: {
          code: "WORKER_FAILED",
          message: errorMessage,
          retryable: false,
        },
      };
      session.state = appendWorkerHistory(
        session.state,
        buildWorkerFailureHistoryEntry(session.state, input.activation.handoff.taskId, errorMessage, now, input.toolCallId)
      );
      await this.persistSession(input.workerRunKey);
      return null;
    }
    const executionToken = session.executionToken + 1;
    session.executionToken = executionToken;
    const abortController = new AbortController();
    session.activeAbortController = abortController;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let onExternalAbort: (() => void) | undefined;
    const preExecutionState = session.state;
    session.context = {
      ...(session.context ?? {}),
      threadId: input.activation.thread.threadId,
      flowId: input.activation.flow.flowId,
      taskId: input.activation.handoff.taskId,
      roleId: input.activation.runState.roleId,
      parentSpanId: `role:${input.activation.runState.runKey}`,
    };
    if (session.context.background === true) {
      session.pendingInvocation = {
        activation: input.activation,
        packet: input.packet,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      };
    }

    const startedAt = this.now();
    if (input.signal?.aborted) {
      abortController.abort(input.signal.reason ?? new Error("worker execution cancelled"));
    } else if (input.signal) {
      onExternalAbort = () => {
        abortController.abort(input.signal?.reason ?? new Error("worker execution cancelled"));
      };
      input.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const deadlineAt = session.context?.deadlineAt;
    if (deadlineAt !== undefined) {
      const remainingMs = Math.max(0, deadlineAt - startedAt);
      deadlineTimer = setTimeout(() => {
        abortController.abort(new WorkerDeadlineExceededError(deadlineAt));
      }, remainingMs);
    }
    session.state = appendWorkerHistory(
      {
        ...session.state,
        status: "running",
        updatedAt: startedAt,
        currentTaskId: input.activation.handoff.taskId,
      },
      buildWorkerUserHistoryEntry(input, startedAt)
    );
    await this.persistSession(input.workerRunKey);
    await this.recordProgress(input.workerRunKey, session, {
      phase: "started",
      summary: `Worker ${session.state.workerType} started task ${input.activation.handoff.taskId}`,
      continuityState: "alive",
    });

    const stopHeartbeat = this.startWorkerHeartbeat(input.workerRunKey, session, executionToken);
    try {
      const result = await raceWorkerExecutionWithAbort(
        handler.run({
          activation: input.activation,
          packet: input.packet,
          sessionState: preExecutionState,
          signal: abortController.signal,
        }),
        abortController.signal,
        () => session.preserveLateResultOnAbort === true,
      );

      if (!this.shouldCommitCompletion(input.workerRunKey, executionToken)) {
        return session.state.lastResult ?? null;
      }

      const completedAt = this.now();
      const nextStatus = resolveStatusAfterResult(result, session.state);
      session.state = {
        ...session.state,
        status: nextStatus,
        updatedAt: completedAt,
        currentTaskId: input.activation.handoff.taskId,
        ...(result ? { lastResult: result } : {}),
        ...(result?.status === "timeout"
          ? {
              lastError: {
                code: "WORKER_TIMEOUT" as const,
                message: result.summary,
                retryable: true,
              },
            }
          : {}),
        ...(result?.status === "partial" || result?.status === "timeout"
          ? {
              continuationDigest: {
                reason:
                  result.status === "timeout"
                    ? ("timeout_summary" as const)
                    : ("follow_up" as const),
                summary: result.summary,
                createdAt: completedAt,
              },
            }
          : {}),
      };
      for (const entry of result?.sessionHistoryEntries ?? []) {
        session.state = appendWorkerHistory(session.state, entry);
      }
      session.state = appendWorkerHistory(
        session.state,
        buildWorkerResultHistoryEntry(session.state, input.activation.handoff.taskId, result, completedAt, input.toolCallId)
      );
      delete session.pendingInvocation;
      await this.persistSession(input.workerRunKey);
      await this.recordProgress(input.workerRunKey, session, {
        phase: mapWorkerResultPhase(result),
        summary: result?.summary ?? `Worker ${session.state.workerType} completed`,
        continuityState: mapWorkerStatusToContinuity(session.state.status, session.state.lastError?.retryable),
        ...(
          (session.state.status === "waiting_external" || session.state.status === "waiting_input") &&
          session.state.lastError?.message
            ? { statusReason: session.state.lastError.message }
            : {}
        ),
      });

      return result;
    } catch (error) {
      if (!this.shouldCommitCompletion(input.workerRunKey, executionToken)) {
        return session.state.lastResult ?? null;
      }

      const errorMessage = error instanceof Error ? error.message : "worker execution failed";
      if (isPreservedTimeoutAbort(session.state, errorMessage)) {
        return session.state.lastResult ?? null;
      }
      if (abortController.signal.aborted) {
        const cancelledAt = this.now();
        const deadlineExpired = isWorkerDeadlineReason(abortController.signal.reason);
        if (deadlineExpired) {
          const timeoutResult = buildWorkerDeadlineTimeoutResult(
            session.state.workerType,
            errorMessage,
            abortController.signal.reason,
          );
          session.state = appendWorkerHistory(
            {
              ...session.state,
              status: "resumable",
              updatedAt: cancelledAt,
              currentTaskId: input.activation.handoff.taskId,
              lastResult: timeoutResult,
              lastError: {
                code: "WORKER_TIMEOUT",
                message: errorMessage,
                retryable: true,
              },
              continuationDigest: {
                reason: "timeout_summary",
                summary: timeoutResult.summary,
                createdAt: cancelledAt,
              },
            },
            buildWorkerResultHistoryEntry(
              session.state,
              input.activation.handoff.taskId,
              timeoutResult,
              cancelledAt,
              input.toolCallId,
            ),
          );
          delete session.pendingInvocation;
          await this.persistSession(input.workerRunKey);
          await this.recordProgress(input.workerRunKey, session, {
            phase: "waiting",
            summary: timeoutResult.summary,
            continuityState: "waiting",
            statusReason: errorMessage,
            closeKind: "timeout",
          });
          return timeoutResult;
        }
        session.state = appendWorkerHistory(
          {
            ...session.state,
            status: "cancelled",
            updatedAt: cancelledAt,
            currentTaskId: input.activation.handoff.taskId,
            lastError: {
              code: deadlineExpired ? "WORKER_TIMEOUT" : "WORKER_FAILED",
              message: errorMessage,
              retryable: false,
            },
          },
          buildWorkerControlHistoryEntry(
            session.state,
            "cancelled",
            errorMessage,
            cancelledAt,
          ),
        );
        delete session.pendingInvocation;
        await this.persistSession(input.workerRunKey);
        await this.recordProgress(input.workerRunKey, session, {
          phase: "cancelled",
          summary: errorMessage,
          continuityState: "terminal",
          statusReason: errorMessage,
          closeKind: deadlineExpired ? "timeout" : "cancelled",
        });
        return null;
      }
      const failedAt = this.now();
      session.state = {
        ...session.state,
        status: "failed",
        updatedAt: failedAt,
        currentTaskId: input.activation.handoff.taskId,
        lastError: {
          code: "WORKER_FAILED",
          message: errorMessage,
          retryable: true,
        },
      };
      session.state = appendWorkerHistory(
        session.state,
        buildWorkerFailureHistoryEntry(
          session.state,
          input.activation.handoff.taskId,
          errorMessage,
          failedAt,
          input.toolCallId
        )
      );
      delete session.pendingInvocation;
      await this.persistSession(input.workerRunKey);
      await this.recordProgress(input.workerRunKey, session, {
        phase: "failed",
        summary: session.state.lastError?.message ?? "worker execution failed",
        continuityState: "terminal",
        ...(session.state.lastError?.message ? { statusReason: session.state.lastError.message } : {}),
      });
      throw error;
    } finally {
      if (session.activeAbortController === abortController) {
        delete session.activeAbortController;
      }
      delete session.preserveLateResultOnAbort;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (onExternalAbort && input.signal) {
        input.signal.removeEventListener("abort", onExternalAbort);
      }
      stopHeartbeat();
    }
  }

  async resume(input: WorkerResumeInput): Promise<WorkerExecutionResult | null> {
    await this.ensureHydrated();
    const session = this.sessions.get(input.workerRunKey);
    if (!session) {
      return null;
    }

    if (
      ["idle", "waiting_input", "waiting_external", "resumable"].includes(session.state.status) ||
      ((session.state.status === "done" || session.state.status === "cancelled") &&
        input.packet.continuityMode === "resume-existing") ||
      (session.state.status === "failed" &&
        input.packet.continuityMode === "resume-existing" &&
        session.state.lastError?.retryable !== false)
    ) {
      return this.send({
        workerRunKey: input.workerRunKey,
        activation: input.activation,
        packet: buildResumePacket(input.packet, session.state),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }

    return session.state.lastResult ?? null;
  }

  async interrupt(input: WorkerInterruptInput): Promise<WorkerSessionState | null> {
    await this.ensureHydrated();
    const session = this.sessions.get(input.workerRunKey);
    if (!session) {
      return null;
    }

    if (session.state.status !== "running" && session.state.status !== "resumable") {
      return session.state;
    }
    if (!input.preserveLateResult) {
      session.executionToken += 1;
    } else {
      session.preserveLateResultOnAbort = true;
    }
    session.activeAbortController?.abort(input.reason ?? "Worker interrupted.");
    delete session.activeAbortController;

    const now = this.now();
    const nextContinuationDigest = input.reason
      ? {
          reason: "timeout_summary" as const,
          summary: buildContinuationSummary(session.state, input.reason),
          createdAt: now,
        }
      : session.state.lastResult
        ? {
            reason: "user_resume" as const,
            summary: buildContinuationSummary(session.state),
            createdAt: now,
          }
        : session.state.continuationDigest;

    session.state = {
      ...session.state,
      status: input.reason ? "resumable" : "waiting_input",
      updatedAt: now,
      ...(input.reason
        ? {
            lastError: {
              code: "WORKER_TIMEOUT",
              message: input.reason,
              retryable: true,
            },
          }
        : {}),
      ...(nextContinuationDigest ? { continuationDigest: nextContinuationDigest } : {}),
    };
    session.state = appendWorkerHistory(
      session.state,
      buildWorkerControlHistoryEntry(session.state, "interrupted", input.reason ?? "Worker is waiting for input.", now)
    );
    await this.persistSession(input.workerRunKey);
    await this.recordProgress(input.workerRunKey, session, {
      phase: input.reason ? "degraded" : "waiting",
      summary: input.reason
        ? `Worker ${session.state.workerType} interrupted and marked resumable`
        : `Worker ${session.state.workerType} is waiting for input`,
      continuityState: input.reason ? "transient_failure" : "waiting",
      heartbeatSource: "control_path",
      ...(input.reason ? { statusReason: input.reason } : {}),
    });

    return session.state;
  }

  async cancel(input: WorkerCancelInput): Promise<WorkerSessionState | null> {
    await this.ensureHydrated();
    const session = this.sessions.get(input.workerRunKey);
    if (!session) {
      return null;
    }
    session.executionToken += 1;
    session.activeAbortController?.abort(input.reason ?? "Worker cancelled.");
    delete session.activeAbortController;

    const now = this.now();
    session.state = {
      ...session.state,
      status: "cancelled",
      updatedAt: now,
      ...(input.reason
        ? {
            lastError: {
              code: "WORKER_FAILED",
              message: input.reason,
              retryable: false,
            },
          }
        : {}),
    };
    session.state = appendWorkerHistory(
      session.state,
      buildWorkerControlHistoryEntry(session.state, "cancelled", input.reason ?? "Worker cancelled.", now)
    );
    delete session.pendingInvocation;
    await this.persistSession(input.workerRunKey);
    await this.recordProgress(input.workerRunKey, session, {
      phase: "cancelled",
      summary: `Worker ${session.state.workerType} cancelled`,
      continuityState: "terminal",
      heartbeatSource: "control_path",
      ...(input.reason ? { statusReason: input.reason } : {}),
    });

    return session.state;
  }

  async getState(workerRunKey: string): Promise<WorkerSessionState | null> {
    await this.ensureHydrated();
    return this.sessions.get(workerRunKey)?.state ?? null;
  }

  async maybeRunForRole(input: WorkerInvocationInput): Promise<WorkerExecutionResult | null> {
    const spawned = await this.spawn(input);
    if (!spawned) {
      return null;
    }

    return this.send({
      workerRunKey: spawned.workerRunKey,
      activation: input.activation,
      packet: input.packet,
    });
  }

  async reconcileStartup(): Promise<WorkerStartupReconcileResult> {
    await this.ensureHydrated();
    if (!this.backgroundStartupReconciled) {
      this.backgroundStartupReconciled = true;
      this.restartBackgroundInvocations();
    }
    return this.startupReconcileResult;
  }

  async listSessions(): Promise<WorkerSessionRecord[]> {
    await this.ensureHydrated();
    return [...this.sessions.entries()]
      .map(([workerRunKey, entry]) => ({
        workerRunKey,
        state: entry.state,
        executionToken: entry.executionToken,
        ...(entry.context ? { context: entry.context } : {}),
        ...(entry.pendingInvocation
          ? { pendingInvocation: entry.pendingInvocation }
          : {}),
      }))
      .sort((left, right) => right.state.updatedAt - left.state.updatedAt);
  }

  private shouldCommitCompletion(workerRunKey: string, executionToken: number): boolean {
    const current = this.sessions.get(workerRunKey);
    return Boolean(current && current.executionToken === executionToken);
  }

  private restartBackgroundInvocations(): void {
    for (const [workerRunKey, entry] of this.sessions) {
      if (
        entry.context?.background !== true ||
        entry.state.status !== "resumable" ||
        !entry.pendingInvocation ||
        (entry.context.deadlineAt !== undefined &&
          entry.context.deadlineAt <= this.now())
      ) {
        continue;
      }
      const pending = entry.pendingInvocation;
      void this.send({
        workerRunKey,
        activation: pending.activation,
        packet: pending.packet,
        ...(pending.toolCallId ? { toolCallId: pending.toolCallId } : {}),
      }).catch((error) => {
        console.error("background worker restart failed", {
          workerRunKey,
          error,
        });
      });
    }
  }

  private async recordProgress(
    workerRunKey: string,
    session: {
      state: WorkerSessionState;
      context?: { threadId: string; flowId: string; taskId: string; roleId: string; parentSpanId: string };
    },
    input: {
      phase: "started" | "heartbeat" | "waiting" | "completed" | "failed" | "degraded" | "cancelled";
      continuityState: "alive" | "waiting" | "resolved" | "terminal" | "transient_failure";
      summary: string;
      statusReason?: string;
      heartbeatSource?: "phase_transition" | "activity_echo" | "control_path" | "reconnect_window" | "long_running_tick";
      responseTimeoutAt?: number;
      reconnectWindowUntil?: number;
      closeKind?: "completed" | "cancelled" | "timeout" | "worker_failed" | "transport_failure" | "unknown";
    }
  ): Promise<void> {
    if (!this.runtimeProgressRecorder || !session.context) {
      return;
    }
    await this.runtimeProgressRecorder.record({
      progressId: `progress:worker:${workerRunKey}:${input.phase}:${this.now()}`,
      threadId: session.context.threadId,
      chainId: `flow:${session.context.flowId}`,
      spanId: `worker:${workerRunKey}`,
      parentSpanId: session.context.parentSpanId,
      subjectKind: "worker_run",
      subjectId: workerRunKey,
      phase: input.phase,
      progressKind:
        input.phase === "started" || input.phase === "heartbeat" || input.phase === "degraded"
          ? "heartbeat"
          : "transition",
      heartbeatSource: input.heartbeatSource ?? (input.phase === "degraded" ? "reconnect_window" : "phase_transition"),
      continuityState: input.continuityState,
      ...(input.responseTimeoutAt
        ? { responseTimeoutAt: input.responseTimeoutAt }
        : input.phase === "started" || input.phase === "heartbeat"
          ? { responseTimeoutAt: this.now() + ACTIVE_RESPONSE_TIMEOUT_MS }
          : input.phase === "waiting"
            ? { responseTimeoutAt: this.now() + WAITING_RESPONSE_TIMEOUT_MS }
            : {}),
      ...(input.reconnectWindowUntil
        ? { reconnectWindowUntil: input.reconnectWindowUntil }
        : input.phase === "degraded"
          ? { reconnectWindowUntil: this.now() + TRANSIENT_RECONNECT_WINDOW_MS }
          : {}),
      ...(input.closeKind
        ? { closeKind: input.closeKind }
        : input.phase === "failed"
          ? {
              closeKind: session.state.lastError?.retryable ? ("transport_failure" as const) : ("worker_failed" as const),
            }
          : input.phase === "cancelled"
            ? { closeKind: "cancelled" as const }
            : input.phase === "degraded"
              ? { closeKind: "timeout" as const }
              : {}),
      summary: input.summary,
      recordedAt: this.now(),
      flowId: session.context.flowId,
      taskId: session.context.taskId,
      roleId: session.context.roleId,
      workerType: session.state.workerType,
      ...(input.statusReason ? { statusReason: input.statusReason } : {}),
    });
  }

  private startWorkerHeartbeat(
    workerRunKey: string,
    session: {
      state: WorkerSessionState;
      context?: { threadId: string; flowId: string; taskId: string; roleId: string; parentSpanId: string };
    },
    executionToken: number
  ): () => void {
    if (!this.runtimeProgressRecorder || !session.context || this.heartbeatIntervalMs <= 0) {
      return () => {};
    }
    const timer = setInterval(() => {
      const current = this.sessions.get(workerRunKey);
      if (!current || current.executionToken !== executionToken) {
        clearInterval(timer);
        return;
      }
      void this.recordProgress(workerRunKey, session, {
        phase: "heartbeat",
        summary: `Worker ${session.state.workerType} is still running task ${session.context?.taskId}.`,
        continuityState: "alive",
        heartbeatSource: "long_running_tick",
      }).catch((error) => {
        console.error("worker heartbeat progress recording failed", {
          workerRunKey,
          taskId: session.context?.taskId,
          error,
        });
      });
    }, this.heartbeatIntervalMs);
    return () => clearInterval(timer);
  }
}

function appendWorkerHistory(
  state: WorkerSessionState,
  entry: WorkerSessionHistoryEntry
): WorkerSessionState {
  const history = state.history ?? [];
  const existingIds = new Set(history.map((item) => item.id));
  let nextEntry = entry;
  let suffix = history.length;
  while (existingIds.has(nextEntry.id)) {
    nextEntry = {
      ...entry,
      id: `${entry.id}:${suffix}`,
    };
    suffix += 1;
  }
  return {
    ...state,
    history: [...history, nextEntry],
  };
}

function buildWorkerUserHistoryEntry(input: WorkerMessageInput, createdAt: number): WorkerSessionHistoryEntry {
  return {
    id: `worker-history:${input.workerRunKey}:${input.activation.handoff.taskId}:user:${createdAt}`,
    role: "user",
    content: input.packet.taskPrompt,
    createdAt,
    taskId: input.activation.handoff.taskId,
    ...(input.toolCallId ? { toolCallId: input.toolCallId, metadata: { parentToolCallId: input.toolCallId } } : {}),
  };
}

function buildWorkerResultHistoryEntry(
  state: WorkerSessionState,
  taskId: string,
  result: WorkerExecutionResult | null,
  createdAt: number,
  toolCallId?: string
): WorkerSessionHistoryEntry {
  const base = {
    id: `worker-history:${state.workerRunKey}:${taskId}:tool:${createdAt}`,
    role: "tool" as const,
    createdAt,
    taskId,
    toolName: state.workerType,
    ...(toolCallId ? { toolCallId, metadata: { parentToolCallId: toolCallId } } : {}),
  };
  if (!result) {
    return {
      ...base,
      status: "completed",
      content: `Worker ${state.workerType} completed without a result.`,
      payload: null,
    };
  }
  return {
    ...base,
    status: result.status,
    content: result.summary,
    payload: result.payload,
  };
}

function buildWorkerFailureHistoryEntry(
  state: WorkerSessionState,
  taskId: string,
  message: string,
  createdAt: number,
  toolCallId?: string
): WorkerSessionHistoryEntry {
  return {
    id: `worker-history:${state.workerRunKey}:${taskId}:tool-failed:${createdAt}`,
    role: "tool",
    content: message,
    createdAt,
    taskId,
    ...(toolCallId ? { toolCallId, metadata: { parentToolCallId: toolCallId } } : {}),
    toolName: state.workerType,
    status: "failed",
  };
}

function buildWorkerControlHistoryEntry(
  state: WorkerSessionState,
  status: "cancelled" | "interrupted" | "failed",
  content: string,
  createdAt: number
): WorkerSessionHistoryEntry {
  return {
    id: `worker-history:${state.workerRunKey}:${state.currentTaskId ?? "control"}:${status}:${createdAt}`,
    role: "system",
    content,
    createdAt,
    ...(state.currentTaskId ? { taskId: state.currentTaskId } : {}),
    toolName: state.workerType,
    status,
  };
}

function resolveStatus(result: WorkerExecutionResult | null): WorkerSessionState["status"] {
  if (!result) {
    return "done";
  }

  if (result.status === "partial" || result.status === "timeout") {
    return "resumable";
  }

  if (result.status === "failed") {
    return "failed";
  }

  return "done";
}

function resolveStatusAfterResult(
  result: WorkerExecutionResult | null,
  currentState: WorkerSessionState
): WorkerSessionState["status"] {
  if (
    currentState.status === "resumable" &&
    currentState.lastError?.code === "WORKER_TIMEOUT" &&
    result?.status !== "partial" &&
    result?.status !== "timeout"
  ) {
    return "resumable";
  }
  return resolveStatus(result);
}

function isPreservedTimeoutAbort(state: WorkerSessionState, errorMessage: string): boolean {
  if (state.status !== "resumable" || state.lastError?.code !== "WORKER_TIMEOUT") {
    return false;
  }
  const timeoutMessage = state.lastError.message.trim();
  return timeoutMessage.length > 0 && (errorMessage === timeoutMessage || errorMessage.includes(timeoutMessage));
}

async function raceWorkerExecutionWithAbort<T>(
  execution: Promise<T>,
  signal: AbortSignal,
  preserveLateResult: () => boolean,
): Promise<T> {
  if (signal.aborted) throw normalizeAbortReason(signal.reason);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      if (!preserveLateResult()) reject(normalizeAbortReason(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([execution, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function normalizeAbortReason(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "worker execution cancelled");
  error.name = "AbortError";
  return error;
}

function isWorkerDeadlineReason(reason: unknown): boolean {
  return reason instanceof WorkerDeadlineExceededError || (
    typeof reason === "object" &&
    reason !== null &&
    "code" in reason &&
    (reason.code === "worker_deadline_exceeded" ||
      reason.code === "run_deadline_exceeded")
  );
}

function mapWorkerResultPhase(
  result: WorkerExecutionResult | null
): "completed" | "waiting" | "failed" {
  if (!result) {
    return "completed";
  }
  if (result.status === "partial" || result.status === "timeout") {
    return "waiting";
  }
  if (result.status === "failed") {
    return "failed";
  }
  return "completed";
}

function buildWorkerDeadlineTimeoutResult(
  workerType: WorkerKind,
  message: string,
  reason: unknown,
): WorkerExecutionResult {
  const deadlineAt =
    reason instanceof Error &&
    "deadlineAt" in reason &&
    typeof reason.deadlineAt === "number" &&
    Number.isFinite(reason.deadlineAt)
      ? reason.deadlineAt
      : null;
  return {
    workerType,
    status: "timeout",
    summary: `Worker timed out: ${message}`,
    payload: {
      mode: "worker_runtime",
      workerType,
      resumableReason: "worker_deadline_exceeded",
      ...(deadlineAt === null ? {} : { deadlineAt }),
    },
  };
}

function mapWorkerStatusToContinuity(
  status: WorkerSessionState["status"],
  retryable?: boolean
): "alive" | "waiting" | "resolved" | "terminal" | "transient_failure" {
  switch (status) {
    case "running":
      return "alive";
    case "waiting_input":
    case "waiting_external":
    case "resumable":
      return "waiting";
    case "failed":
      return retryable ? "transient_failure" : "terminal";
    case "cancelled":
      return "terminal";
    case "done":
    case "idle":
    default:
      return "resolved";
  }
}

function buildResumePacket(
  packet: WorkerMessageInput["packet"],
  sessionState: WorkerSessionState
): WorkerMessageInput["packet"] {
  const transcriptLines = (sessionState.history ?? [])
    .slice(-12)
    .map((entry) => {
      const status = entry.status ? ` status=${entry.status}` : "";
      const tool = entry.toolName ? ` tool=${entry.toolName}` : "";
      return `- ${entry.role}${tool}${status}: ${entry.content}`;
    });
  const continuationLines = [
    "Continuation context:",
    `Previous worker status: ${sessionState.status}`,
    sessionState.continuationDigest ? `Continuation summary: ${sessionState.continuationDigest.summary}` : null,
    sessionState.lastResult ? `Last result: ${sessionState.lastResult.summary}` : null,
    sessionState.lastError ? `Last interruption: ${sessionState.lastError.message}` : null,
    sessionState.currentTaskId ? `Current task: ${sessionState.currentTaskId}` : null,
    transcriptLines.length ? "Recent sub-session transcript:" : null,
    ...transcriptLines,
  ].filter((line): line is string => Boolean(line));

  if (continuationLines.length <= 2 && !sessionState.currentTaskId) {
    return packet;
  }

  return {
    ...packet,
    continuityMode: "resume-existing",
    taskPrompt: `${packet.taskPrompt}\n\n${continuationLines.join("\n")}`,
  };
}

function buildContinuationSummary(sessionState: WorkerSessionState, reason?: string): string {
  if (sessionState.lastResult?.summary) {
    return reason ? `${sessionState.lastResult.summary} Timeout reason: ${reason}` : sessionState.lastResult.summary;
  }

  if (reason) {
    return `Execution paused before completion. Reason: ${reason}`;
  }

  if (sessionState.currentTaskId) {
    return `Resume pending work for task ${sessionState.currentTaskId}.`;
  }

  return "Resume the existing worker session from its previous state.";
}

function buildHydrationContinuationSummary(sessionState: WorkerSessionState): string {
  if (sessionState.lastResult?.summary) {
    return `${sessionState.lastResult.summary} Runtime restarted before the worker finished. Resume from the latest safe checkpoint.`;
  }
  if (sessionState.currentTaskId) {
    return `Worker runtime restarted while task ${sessionState.currentTaskId} was still active. Resume from the latest safe checkpoint.`;
  }
  return "Worker runtime restarted while execution was in progress. Resume from the latest safe checkpoint.";
}

function requiresRestartRecovery(status: WorkerSessionState["status"]): boolean {
  return ["running", "waiting_input", "waiting_external", "resumable"].includes(status);
}

function hasRecoverableContext(
  context: WorkerSessionRecord["context"]
): context is NonNullable<WorkerSessionRecord["context"]> {
  return Boolean(
    context?.threadId &&
      context.flowId &&
      context.taskId &&
      context.roleId &&
      context.parentSpanId
  );
}

function buildUnrecoverableHydratedRecord(
  record: WorkerSessionRecord,
  now: number,
  input: { message: string }
): WorkerSessionRecord {
  const nextState = {
    ...record.state,
    status: "failed" as const,
    updatedAt: now,
    lastError: {
      code: "WORKER_FAILED" as const,
      message: input.message,
      retryable: false,
    },
  };
  return {
    ...record,
    state: appendWorkerHistory(
      nextState,
      buildWorkerControlHistoryEntry(nextState, "failed", input.message, now)
    ),
  };
}

function buildExpiredBackgroundRecord(
  record: WorkerSessionRecord,
  now: number,
): WorkerSessionRecord {
  const { pendingInvocation: _pendingInvocation, ...rest } = record;
  const message = "Background worker deadline expired before runtime recovery.";
  const nextState = {
    ...record.state,
    status: "cancelled" as const,
    updatedAt: now,
    lastError: {
      code: "WORKER_TIMEOUT" as const,
      message,
      retryable: false,
    },
  };
  return {
    ...rest,
    executionToken: record.executionToken + 1,
    state: appendWorkerHistory(
      nextState,
      buildWorkerControlHistoryEntry(nextState, "cancelled", message, now),
    ),
  };
}
