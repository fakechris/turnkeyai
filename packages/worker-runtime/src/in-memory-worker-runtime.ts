import type {
  RuntimeProgressRecorder,
  WorkerSessionContextRecord,
  WorkerCancelInput,
  SpawnedWorker,
  WorkerExecutionResult,
  WorkerHandler,
  WorkerInterruptInput,
  WorkerInvocationInput,
  WorkerMessageInput,
  WorkerResumeInput,
  WorkerRegistry,
  WorkerSessionRecord,
  WorkerSessionStore,
  WorkerStartupReconcileResult,
  WorkerRuntime,
  WorkerSessionState,
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
  context?: WorkerSessionContextRecord;
};

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
  };

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
    for (const record of records) {
      const nextRecord =
        record.state.status === "running"
          ? {
              ...record,
              state: {
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
                  summary: buildHydrationContinuationSummary(record.state),
                  createdAt: now,
                },
              },
            }
          : record;
      if (nextRecord !== record) {
        downgradedRunningSessions += 1;
      }
      this.sessions.set(nextRecord.workerRunKey, {
        state: nextRecord.state,
        executionToken: nextRecord.executionToken,
        ...(nextRecord.context ? { context: nextRecord.context } : {}),
      });
      if (nextRecord !== record) {
        await this.sessionStore.put(nextRecord);
      }
    }
    this.startupReconcileResult = {
      totalSessions: records.length,
      downgradedRunningSessions,
    };
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
      session.state = {
        ...session.state,
        status: "failed",
        updatedAt: this.now(),
        currentTaskId: input.activation.handoff.taskId,
        lastError: {
          code: "WORKER_FAILED",
          message: `worker handler unavailable for ${session.state.workerType}`,
          retryable: false,
        },
      };
      await this.persistSession(input.workerRunKey);
      return null;
    }
    const executionToken = session.executionToken + 1;
    session.executionToken = executionToken;
    const preExecutionState = session.state;
    session.context = {
      threadId: input.activation.thread.threadId,
      flowId: input.activation.flow.flowId,
      taskId: input.activation.handoff.taskId,
      roleId: input.activation.runState.roleId,
      parentSpanId: `role:${input.activation.runState.runKey}`,
    };

    session.state = {
      ...session.state,
      status: "running",
      updatedAt: this.now(),
      currentTaskId: input.activation.handoff.taskId,
    };
    await this.persistSession(input.workerRunKey);
    await this.recordProgress(input.workerRunKey, session, {
      phase: "started",
      summary: `Worker ${session.state.workerType} started task ${input.activation.handoff.taskId}`,
      continuityState: "alive",
    });

    const stopHeartbeat = this.startWorkerHeartbeat(input.workerRunKey, session, executionToken);
    try {
      const result = await handler.run({
        activation: input.activation,
        packet: input.packet,
        sessionState: preExecutionState,
      });

      if (!this.shouldCommitCompletion(input.workerRunKey, executionToken)) {
        return result;
      }

      session.state = {
        ...session.state,
        status: resolveStatus(result),
        updatedAt: this.now(),
        currentTaskId: input.activation.handoff.taskId,
        ...(result ? { lastResult: result } : {}),
        ...(result?.status === "partial"
          ? {
              continuationDigest: {
                reason: "follow_up" as const,
                summary: result.summary,
                createdAt: this.now(),
              },
            }
          : {}),
      };
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
        throw error;
      }

      session.state = {
        ...session.state,
        status: "failed",
        updatedAt: this.now(),
        currentTaskId: input.activation.handoff.taskId,
        lastError: {
          code: "WORKER_FAILED",
          message: error instanceof Error ? error.message : "worker execution failed",
          retryable: true,
        },
      };
      await this.persistSession(input.workerRunKey);
      await this.recordProgress(input.workerRunKey, session, {
        phase: "failed",
        summary: session.state.lastError?.message ?? "worker execution failed",
        continuityState: "terminal",
        ...(session.state.lastError?.message ? { statusReason: session.state.lastError.message } : {}),
      });
      throw error;
    } finally {
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
      (session.state.status === "done" && input.packet.continuityMode === "resume-existing")
    ) {
      return this.send({
        workerRunKey: input.workerRunKey,
        activation: input.activation,
        packet: buildResumePacket(input.packet, session.state),
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
    session.executionToken += 1;

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

    session.state = {
      ...session.state,
      status: "cancelled",
      updatedAt: this.now(),
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
      }))
      .sort((left, right) => right.state.updatedAt - left.state.updatedAt);
  }

  private shouldCommitCompletion(workerRunKey: string, executionToken: number): boolean {
    const current = this.sessions.get(workerRunKey);
    return Boolean(current && current.executionToken === executionToken);
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

function resolveStatus(result: WorkerExecutionResult | null): WorkerSessionState["status"] {
  if (!result) {
    return "done";
  }

  if (result.status === "partial") {
    return "resumable";
  }

  if (result.status === "failed") {
    return "failed";
  }

  return "done";
}

function mapWorkerResultPhase(
  result: WorkerExecutionResult | null
): "completed" | "waiting" | "failed" {
  if (!result) {
    return "completed";
  }
  if (result.status === "partial") {
    return "waiting";
  }
  if (result.status === "failed") {
    return "failed";
  }
  return "completed";
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
  const continuationLines = [
    "Continuation context:",
    `Previous worker status: ${sessionState.status}`,
    sessionState.continuationDigest ? `Continuation summary: ${sessionState.continuationDigest.summary}` : null,
    sessionState.lastResult ? `Last result: ${sessionState.lastResult.summary}` : null,
    sessionState.lastError ? `Last interruption: ${sessionState.lastError.message}` : null,
    sessionState.currentTaskId ? `Current task: ${sessionState.currentTaskId}` : null,
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
