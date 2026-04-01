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
          await this.roleRunCoordinator.fail(runKey, {
            code: "RUN_ITERATION_LIMIT",
            message: "member run iteration limit reached",
            retryable: false,
          });
          return;
        }

        const handoff = await this.roleRunCoordinator.dequeue(runKey);
        if (!handoff) {
          await this.roleRunCoordinator.setStatus(runKey, "idle");
          return;
        }

        await this.roleRunCoordinator.incrementIteration(runKey);
        await this.roleRunCoordinator.ack(runKey, handoff.taskId);
        await this.onHandoffAck({
          flowId: handoff.flowId,
          taskId: handoff.taskId,
        });

        const flow = await this.flowLedgerStore.get(handoff.flowId);
        const thread = await this.teamThreadStore.get(handoff.threadId);
        if (!flow || !thread) {
          continue;
        }

        const refreshedRun = await this.roleRunStore.get(runKey);
        if (!refreshedRun) {
          return;
        }

        await this.recordRoleProgress({
          runState: refreshedRun,
          flowId: flow.flowId,
          taskId: handoff.taskId,
          phase: "started",
          summary: `Role ${refreshedRun.roleId} started task ${handoff.taskId}`,
          continuityState: "alive",
        });

        const stopHeartbeat = this.startRoleHeartbeat(refreshedRun, flow.flowId, handoff.taskId);
        const result = await this.roleRuntime
          .runActivation({
            runState: refreshedRun,
            thread,
            flow,
            handoff,
          })
          .finally(() => {
            stopHeartbeat();
          });

        if (result.workerBindings?.length) {
          for (const binding of result.workerBindings) {
            await this.roleRunCoordinator.bindWorkerSession(runKey, binding.workerType, binding.workerRunKey);
          }
        }

        if (result.status === "ok" && result.message) {
          await this.recordRoleProgress({
            runState: refreshedRun,
            flowId: flow.flowId,
            taskId: handoff.taskId,
            phase: "completed",
            summary: `Role ${refreshedRun.roleId} completed task ${handoff.taskId}`,
            continuityState: "resolved",
          });
          await this.onRoleReply({
            flow,
            thread,
            runState: refreshedRun,
            handoff,
            message: result.message,
          });
          continue;
        }

        if (result.status === "delegated") {
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

        await this.recordRoleProgress({
          runState: refreshedRun,
          flowId: flow.flowId,
          taskId: handoff.taskId,
          phase: "failed",
          summary: `Role ${refreshedRun.roleId} failed task ${handoff.taskId}`,
          continuityState: "terminal",
          ...(result.error?.message ? { statusReason: result.error.message } : {}),
        });
        await this.onRoleFailure({
          flow,
          thread,
          runState: refreshedRun,
          handoff,
          error: result.error ?? {
            code: "WORKER_FAILED",
            message: "unknown role failure",
            retryable: false,
          },
        });
        return;
      }
    } finally {
      this.activeRuns.delete(runKey);
    }
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
