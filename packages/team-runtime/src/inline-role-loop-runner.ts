import type {
  FlowLedgerStore,
  HandoffEnvelope,
  RoleLoopRunner,
  RoleRunCoordinator,
  RoleRunState,
  RoleRunStore,
  RoleRuntime,
  RuntimeProgressRecorder,
  RuntimeError,
  TeamMessageStore,
  TeamThreadStore,
  RunKey,
} from "@turnkeyai/core-types/team";
import { normalizeRelayPayload } from "@turnkeyai/core-types/team";

interface InlineRoleLoopRunnerOptions {
  roleRunStore: RoleRunStore;
  flowLedgerStore: FlowLedgerStore;
  teamThreadStore: TeamThreadStore;
  teamMessageStore: TeamMessageStore;
  roleRunCoordinator: RoleRunCoordinator;
  roleRuntime: RoleRuntime;
  onHandoffAck: (input: { flowId: string; taskId: string }) => Promise<void>;
  onRoleReply: (input: {
    flow: NonNullable<Awaited<ReturnType<FlowLedgerStore["get"]>>>;
    thread: NonNullable<Awaited<ReturnType<TeamThreadStore["get"]>>>;
    runState: RoleRunState;
    handoff: HandoffEnvelope;
    message: Awaited<ReturnType<RoleRuntime["runActivation"]>> extends { message?: infer T } ? T : never;
    messages?: Awaited<ReturnType<RoleRuntime["runActivation"]>> extends { messages?: infer T } ? T : never;
  }) => Promise<void>;
  onRoleFailure: (input: {
    flow: NonNullable<Awaited<ReturnType<FlowLedgerStore["get"]>>>;
    thread: NonNullable<Awaited<ReturnType<TeamThreadStore["get"]>>>;
    runState: RoleRunState;
    handoff: HandoffEnvelope;
    error: RuntimeError;
  }) => Promise<void>;
  runtimeProgressRecorder?: RuntimeProgressRecorder;
  heartbeatIntervalMs?: number;
}

const ACTIVE_RESPONSE_TIMEOUT_MS = 3 * 60 * 1000;
const WAITING_RESPONSE_TIMEOUT_MS = 15 * 60 * 1000;
const LONG_RUNNING_HEARTBEAT_MS = 15 * 1000;

export class InlineRoleLoopRunner implements RoleLoopRunner {
  private readonly roleRunStore: RoleRunStore;
  private readonly flowLedgerStore: FlowLedgerStore;
  private readonly teamThreadStore: TeamThreadStore;
  private readonly roleRunCoordinator: RoleRunCoordinator;
  private readonly roleRuntime: RoleRuntime;
  private readonly onHandoffAck: InlineRoleLoopRunnerOptions["onHandoffAck"];
  private readonly onRoleReply: InlineRoleLoopRunnerOptions["onRoleReply"];
  private readonly onRoleFailure: InlineRoleLoopRunnerOptions["onRoleFailure"];
  private readonly runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  private readonly heartbeatIntervalMs: number;
  private readonly activeRuns = new Set<RunKey>();
  private readonly activeRunControllers = new Map<RunKey, AbortController>();
  private readonly activeRunContexts = new Map<RunKey, { runState: RoleRunState; flowId: string; taskId: string }>();

  constructor(options: InlineRoleLoopRunnerOptions) {
    this.roleRunStore = options.roleRunStore;
    this.flowLedgerStore = options.flowLedgerStore;
    this.teamThreadStore = options.teamThreadStore;
    this.roleRunCoordinator = options.roleRunCoordinator;
    this.roleRuntime = options.roleRuntime;
    this.onHandoffAck = options.onHandoffAck;
    this.onRoleReply = options.onRoleReply;
    this.onRoleFailure = options.onRoleFailure;
    this.runtimeProgressRecorder = options.runtimeProgressRecorder;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? LONG_RUNNING_HEARTBEAT_MS;
  }

  async ensureRunning(runKey: RunKey): Promise<void> {
    if (this.activeRuns.has(runKey)) {
      return;
    }

    this.activeRuns.add(runKey);

    try {
      const runState = await this.roleRunStore.get(runKey);
      if (!runState) {
        return;
      }

      if (runState.status !== "running") {
        await this.roleRunCoordinator.setStatus(runKey, "running");
      }

      while (true) {
        const current = await this.roleRunStore.get(runKey);
        if (!current) {
          return;
        }

        if (current.iterationCount >= current.maxIterations) {
          const handoff = await this.roleRunCoordinator.dequeue(runKey);
          if (!handoff) {
            await this.roleRunCoordinator.setStatus(runKey, "idle");
            return;
          }
          const error = buildRoleRunIterationLimitError(current);
          await this.roleRunCoordinator.fail(runKey, error);

          const flow = await this.flowLedgerStore.get(handoff.flowId);
          const thread = await this.teamThreadStore.get(handoff.threadId);
          if (!flow || !thread) {
            return;
          }

          await this.recordRoleProgress({
            runState: current,
            flowId: flow.flowId,
            taskId: handoff.taskId,
            phase: "failed",
            summary: `Role ${current.roleId} paused after reaching its step budget`,
            continuityState: "terminal",
            statusReason: error.message,
          });
          await this.onRoleFailure({
            flow,
            thread,
            runState: current,
            handoff,
            error,
          });
          return;
        }

        const handoff = await this.roleRunCoordinator.dequeue(runKey);
        if (!handoff) {
          await this.roleRunCoordinator.setStatus(runKey, "idle");
          return;
        }

        this.recordRoleBoundaryProgress({
          runState: current,
          flowId: handoff.flowId,
          taskId: handoff.taskId,
          summary: `Role ${current.roleId} dequeued task ${handoff.taskId}`,
          statusReason: "role_loop_dequeued",
        });
        await this.roleRunCoordinator.incrementIteration(runKey);
        this.recordRoleBoundaryProgress({
          runState: current,
          flowId: handoff.flowId,
          taskId: handoff.taskId,
          summary: `Role ${current.roleId} incremented iteration for task ${handoff.taskId}`,
          statusReason: "role_loop_iteration_incremented",
        });
        await this.roleRunCoordinator.ack(runKey, handoff.taskId);
        this.recordRoleBoundaryProgress({
          runState: current,
          flowId: handoff.flowId,
          taskId: handoff.taskId,
          summary: `Role ${current.roleId} acked run task ${handoff.taskId}`,
          statusReason: "role_loop_run_acked",
        });
        this.ackHandoffEdgeAfterRoleRunAck(current, handoff);

        const flow = await this.flowLedgerStore.get(handoff.flowId);
        const thread = await this.teamThreadStore.get(handoff.threadId);
        if (!flow || !thread) {
          continue;
        }

        const refreshedRun = await this.roleRunStore.get(runKey);
        if (!refreshedRun) {
          return;
        }
        this.recordRoleBoundaryProgress({
          runState: refreshedRun,
          flowId: flow.flowId,
          taskId: handoff.taskId,
          summary: `Role ${refreshedRun.roleId} hydrated task ${handoff.taskId}`,
          statusReason: "role_loop_hydrated",
        });

        await this.recordRoleProgress({
          runState: refreshedRun,
          flowId: flow.flowId,
          taskId: handoff.taskId,
          phase: "started",
          summary: `Role ${refreshedRun.roleId} started task ${handoff.taskId}`,
          continuityState: "alive",
        });

        const stopHeartbeat = this.startRoleHeartbeat(refreshedRun, flow.flowId, handoff.taskId);
        const controller = new AbortController();
        this.activeRunControllers.set(runKey, controller);
        this.activeRunContexts.set(runKey, {
          runState: refreshedRun,
          flowId: flow.flowId,
          taskId: handoff.taskId,
        });
        const activationHandoff = buildFinalIterationHandoff(refreshedRun, handoff);
        const result = await this.roleRuntime
          .runActivation({
            runState: refreshedRun,
            thread,
            flow,
            handoff: activationHandoff,
          }, {
            signal: controller.signal,
          })
          .finally(() => {
            stopHeartbeat();
            if (this.activeRunControllers.get(runKey) === controller) {
              this.activeRunControllers.delete(runKey);
            }
            this.activeRunContexts.delete(runKey);
          });
        const roleResult =
          controller.signal.aborted && result.status !== "failed"
            ? {
                status: "failed" as const,
                error: buildRoleRunCancelledError(controller.signal),
              }
            : result;

        if (roleResult.workerBindings?.length) {
          for (const binding of roleResult.workerBindings) {
            await this.roleRunCoordinator.bindWorkerSession(runKey, binding.workerType, binding.workerRunKey);
          }
        }

        if (roleResult.status === "ok" && roleResult.message) {
          await this.onRoleReply({
            flow,
            thread,
            runState: refreshedRun,
            handoff,
            message: roleResult.message,
            ...(roleResult.messages?.length ? { messages: roleResult.messages } : {}),
          });
          await this.recordRoleProgress({
            runState: refreshedRun,
            flowId: flow.flowId,
            taskId: handoff.taskId,
            phase: "completed",
            summary: `Role ${refreshedRun.roleId} completed task ${handoff.taskId}`,
            continuityState: "resolved",
          });
          continue;
        }

        if (roleResult.status === "delegated") {
          await this.roleRunCoordinator.setStatus(runKey, "waiting_worker");
          await this.recordRoleProgress({
            runState: refreshedRun,
            flowId: flow.flowId,
            taskId: handoff.taskId,
            phase: "waiting",
            summary: `Role ${refreshedRun.roleId} is waiting on worker work`,
            continuityState: "waiting",
            statusReason: "waiting_worker",
          });
          return;
        }

        const error = roleResult.error ?? {
          code: "WORKER_FAILED" as const,
          message: "unknown role failure",
          retryable: false,
        };
        await this.roleRunCoordinator.fail(runKey, error);
        await this.recordRoleProgress({
          runState: refreshedRun,
          flowId: flow.flowId,
          taskId: handoff.taskId,
          phase: "failed",
          summary: `Role ${refreshedRun.roleId} failed task ${handoff.taskId}`,
          continuityState: "terminal",
          statusReason: error.message,
        });
        await this.onRoleFailure({
          flow,
          thread,
          runState: refreshedRun,
          handoff,
          error,
        });
        return;
      }
    } finally {
      this.activeRunControllers.delete(runKey);
      this.activeRunContexts.delete(runKey);
      this.activeRuns.delete(runKey);
    }
  }

  async cancel(runKey: RunKey, reason = "role run cancelled"): Promise<boolean> {
    const controller = this.activeRunControllers.get(runKey);
    if (!controller) {
      return false;
    }
    controller.abort(new Error(reason));
    await this.recordCancellationProgress(runKey, reason);
    return true;
  }

  private async recordRoleProgress(input: {
    runState: RoleRunState;
    flowId: string;
    taskId: string;
    phase: "started" | "heartbeat" | "waiting" | "completed" | "failed";
    continuityState: "alive" | "waiting" | "resolved" | "terminal";
    summary: string;
    statusReason?: string;
    heartbeatSource?: "phase_transition" | "activity_echo" | "control_path" | "reconnect_window" | "long_running_tick";
  }): Promise<void> {
    if (!this.runtimeProgressRecorder) {
      return;
    }
    const chainId = `flow:${input.flowId}`;
    const spanId = `role:${input.runState.runKey}`;
    await this.runtimeProgressRecorder.record({
      progressId: `progress:role:${input.runState.runKey}:${input.phase}:${Date.now()}`,
      threadId: input.runState.threadId,
      chainId,
      spanId,
      ...(input.runState.lastDequeuedTaskId ? { parentSpanId: `dispatch:${input.runState.lastDequeuedTaskId}` } : {}),
      subjectKind: "role_run",
      subjectId: input.runState.runKey,
      phase: input.phase,
      progressKind: input.phase === "started" || input.phase === "heartbeat" ? "heartbeat" : "transition",
      heartbeatSource: input.heartbeatSource ?? "phase_transition",
      continuityState: input.continuityState,
      ...(input.phase === "started" || input.phase === "heartbeat"
        ? { responseTimeoutAt: Date.now() + ACTIVE_RESPONSE_TIMEOUT_MS }
        : input.phase === "waiting"
          ? { responseTimeoutAt: Date.now() + WAITING_RESPONSE_TIMEOUT_MS }
          : {}),
      ...(input.phase === "failed" ? { closeKind: "worker_failed" as const } : {}),
      summary: input.summary,
      recordedAt: Date.now(),
      flowId: input.flowId,
      taskId: input.taskId,
      roleId: input.runState.roleId,
      ...(input.statusReason ? { statusReason: input.statusReason } : {}),
    });
  }

  private recordRoleBoundaryProgress(input: {
    runState: RoleRunState;
    flowId: string;
    taskId: string;
    summary: string;
    statusReason: string;
  }): void {
    if (!this.runtimeProgressRecorder) {
      return;
    }
    const recordedAt = Date.now();
    const chainId = `flow:${input.flowId}`;
    void this.runtimeProgressRecorder.record({
      progressId: `progress:role:${input.runState.runKey}:boundary:${input.statusReason}:${recordedAt}`,
      threadId: input.runState.threadId,
      chainId,
      spanId: `role:${input.runState.runKey}`,
      parentSpanId: `dispatch:${input.taskId}`,
      subjectKind: "role_run",
      subjectId: input.runState.runKey,
      phase: "heartbeat",
      progressKind: "boundary",
      heartbeatSource: "control_path",
      continuityState: "alive",
      responseTimeoutAt: recordedAt + ACTIVE_RESPONSE_TIMEOUT_MS,
      summary: input.summary,
      recordedAt,
      flowId: input.flowId,
      taskId: input.taskId,
      roleId: input.runState.roleId,
      statusReason: input.statusReason,
    }).catch((error) => {
      console.error("role boundary progress recording failed", {
        runKey: input.runState.runKey,
        flowId: input.flowId,
        taskId: input.taskId,
        statusReason: input.statusReason,
        error,
      });
    });
  }

  private ackHandoffEdgeAfterRoleRunAck(runState: RoleRunState, handoff: HandoffEnvelope): void {
    // The role-run ack is the execution gate. The flow edge ack is an
    // observability/state convergence write and can be slow when runtime-chain
    // status recording or polling reconciliation is busy. Do not block prompt
    // hydration or the first tool call on that write; role replies can still
    // advance the edge to responded/closed, and this ack is idempotent if it
    // arrives first.
    void this.onHandoffAck({
      flowId: handoff.flowId,
      taskId: handoff.taskId,
    }).then(() => {
      this.recordRoleBoundaryProgress({
        runState,
        flowId: handoff.flowId,
        taskId: handoff.taskId,
        summary: `Role ${runState.roleId} acked flow edge for task ${handoff.taskId}`,
        statusReason: "role_loop_edge_acked",
      });
    }).catch((error) => {
      console.error("handoff edge ack failed after role-run ack", {
        runKey: runState.runKey,
        flowId: handoff.flowId,
        taskId: handoff.taskId,
        error,
      });
    });
  }

  private async recordCancellationProgress(runKey: RunKey, reason: string): Promise<void> {
    if (!this.runtimeProgressRecorder) {
      return;
    }
    const context = this.activeRunContexts.get(runKey);
    if (!context) {
      return;
    }
    await this.recordRoleProgress({
      runState: context.runState,
      flowId: context.flowId,
      taskId: context.taskId,
      phase: "failed",
      summary: reason,
      continuityState: "terminal",
      statusReason: reason,
    });
  }

  private startRoleHeartbeat(runState: RoleRunState, flowId: string, taskId: string): () => void {
    if (!this.runtimeProgressRecorder || this.heartbeatIntervalMs <= 0) {
      return () => {};
    }
    const timer = setInterval(() => {
      void this.recordRoleProgress({
        runState,
        flowId,
        taskId,
        phase: "heartbeat",
        summary: `Role ${runState.roleId} is still working on task ${taskId}.`,
        continuityState: "alive",
        heartbeatSource: "long_running_tick",
      }).catch((error) => {
        console.error("role heartbeat progress recording failed", {
          runKey: runState.runKey,
          flowId,
          taskId,
          error,
        });
      });
    }, this.heartbeatIntervalMs);
    return () => clearInterval(timer);
  }
}

function buildRoleRunCancelledError(signal: AbortSignal): RuntimeError {
  const reason = signal.reason;
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.trim().length > 0
        ? reason
        : "role run cancelled";
  return {
    code: "ROLE_RUN_CANCELLED",
    message,
    retryable: false,
  };
}

function buildRoleRunIterationLimitError(runState: RoleRunState): RuntimeError {
  return {
    code: "RUN_ITERATION_LIMIT",
    message: `Role ${runState.roleId} paused after reaching its ${runState.maxIterations}-step budget. Send a follow-up such as "continue" to resume from the latest state.`,
    retryable: false,
  };
}

function buildFinalIterationHandoff(runState: RoleRunState, handoff: HandoffEnvelope): HandoffEnvelope {
  if (runState.iterationCount < runState.maxIterations) {
    return handoff;
  }
  const currentBrief = handoff.payload.intent?.relayBrief ?? "";
  const finalizationNudge = [
    "Step budget notice:",
    "This is the final allowed activation before the role pauses.",
    "Synthesize a useful answer from evidence already gathered.",
    "Only start new tool or worker work if it is strictly required to avoid an unsafe or misleading answer.",
    "If coverage is incomplete, state the residual risk and what a follow-up should continue.",
  ].join("\n");
  return {
    ...handoff,
    payload: normalizeRelayPayload({
      ...handoff.payload,
      intent: {
        relayBrief: [currentBrief, finalizationNudge].filter((part) => part.trim().length > 0).join("\n\n"),
        recentMessages: handoff.payload.intent?.recentMessages ?? [],
        ...(handoff.payload.intent?.instructions ? { instructions: handoff.payload.intent.instructions } : {}),
      },
    }),
  };
}
