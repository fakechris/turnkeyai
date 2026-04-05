import type {
  Clock,
  DispatchContinuationContext,
  FanOutMergeContext,
  FlowLedger,
  FlowLedgerStore,
  HandoffEnvelope,
  HandoffPlanner,
  IdGenerator,
  MergeSynthesisPacket,
  ParallelOrchestrationContext,
  RecoveryDecision,
  RecoveryDirector,
  RelayBriefBuilder,
  RoleId,
  RoleLoopRunner,
  RoleRunCoordinator,
  RoleRunState,
  ShardGroupRecord,
  ShardResultRecord,
  WorkerRuntime,
  RuntimeError,
  RuntimeLimits,
  ResearchShardPacket,
  ScheduledTaskRecord,
  SendTeamMessageInput,
  SummaryBuilder,
  TeamMessage,
  TeamMessageSummary,
  TeamMessageStore,
  TeamThread,
  TeamThreadStore,
  WorkerKind,
} from "@turnkeyai/core-types/team";
import {
  createRelayPayload,
  getContinuationContext,
  getDispatchPolicy,
  getMergeContext,
  normalizeRelayPayload,
  getParallelContext,
  getScheduledContinuity,
  getScheduledPreferredWorkerKinds,
  getScheduledSessionTarget,
  getScheduledTargetRoleId,
  getScheduledTargetWorker,
} from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { decodeBrowserSessionPayload } from "@turnkeyai/core-types/browser-session-payload";
import { detectConflictRoleIds, detectDuplicateRoleIds } from "@turnkeyai/core-types/shard-result-analysis";
import type { ContextStateMaintainer } from "./context-state-maintainer";

interface CoordinationEngineDeps {
  teamThreadStore: TeamThreadStore;
  teamMessageStore: TeamMessageStore;
  flowLedgerStore: FlowLedgerStore;
  roleRunCoordinator: RoleRunCoordinator;
  handoffPlanner: HandoffPlanner;
  recoveryDirector: RecoveryDirector;
  roleLoopRunner: RoleLoopRunner;
  summaryBuilder: SummaryBuilder;
  relayBriefBuilder: RelayBriefBuilder;
  idGenerator: Pick<IdGenerator, "flowId" | "messageId" | "taskId">;
  runtimeLimits: Pick<RuntimeLimits, "flowMaxHops">;
  clock: Clock;
  contextStateMaintainer?: ContextStateMaintainer;
  workerRuntime?: Pick<WorkerRuntime, "getState">;
  runtimeChainRecorder?: import("@turnkeyai/core-types/team").RuntimeChainRecorder;
}

export class CoordinationEngine {
  private readonly deps: CoordinationEngineDeps;
  private readonly flowMutex = new KeyedAsyncMutex<string>();

  constructor(deps: CoordinationEngineDeps) {
    this.deps = deps;
  }

  async handleUserPost(input: SendTeamMessageInput): Promise<void> {
    const thread = await this.deps.teamThreadStore.get(input.threadId);
    if (!thread) {
      throw new Error(`team thread not found: ${input.threadId}`);
    }

    const userMessage = this.buildUserMessage(thread, input.content);
    await this.deps.teamMessageStore.append(userMessage);
    await this.refreshThreadContext(thread.threadId);

    const flow = this.buildFlow(thread, userMessage.id);
    await this.deps.flowLedgerStore.put(flow);
    await this.recordRuntimeChainBestEffort("recordFlowCreated", flow, () =>
      this.deps.runtimeChainRecorder?.recordFlowCreated(flow)
    );

    await this.dispatchToLead(thread, flow, userMessage);
  }

  async dispatchToLead(thread: TeamThread, flow: FlowLedger, sourceMessage: TeamMessage): Promise<void> {
    await this.dispatchToRole({
      thread,
      flow,
      sourceMessage,
      toRoleId: thread.leadRoleId,
      activationType: "cascade",
    });
  }

  async handleScheduledTask(task: ScheduledTaskRecord): Promise<void> {
    const thread = await this.deps.teamThreadStore.get(task.threadId);
    if (!thread) {
      throw new Error(`team thread not found: ${task.threadId}`);
    }

    const scheduledMessage = this.buildScheduledMessage(thread, task);
    await this.deps.teamMessageStore.append(scheduledMessage);
    await this.refreshThreadContext(thread.threadId);

    const flow = this.buildFlow(thread, scheduledMessage.id);
    await this.deps.flowLedgerStore.put(flow);
    await this.recordRuntimeChainBestEffort("recordFlowCreated", flow, () =>
      this.deps.runtimeChainRecorder?.recordFlowCreated(flow)
    );
    let continuationContext: DispatchContinuationContext | undefined;
    try {
      continuationContext = await this.resolveScheduledContinuationContext(task);
    } catch (error) {
      console.error("scheduled continuation lookup failed", { taskId: task.taskId, error });
    }

    const scheduledContinuityMode = getScheduledContinuity(task)?.mode;
    await this.dispatchToRole({
      thread,
      flow,
      sourceMessage: scheduledMessage,
      toRoleId: getScheduledTargetRoleId(task),
      activationType: "cascade",
      instructions: buildScheduledInstructions(task, continuationContext),
      preferredWorkerKinds: getScheduledPreferredWorkerKinds(task),
      sessionTarget: getScheduledSessionTarget(task),
      ...(scheduledContinuityMode ? { continuityMode: scheduledContinuityMode } : {}),
      ...(continuationContext ? { continuationContext } : {}),
    });
  }

  async dispatchToRole(input: {
    thread: TeamThread;
    flow: FlowLedger;
    sourceMessage: TeamMessage;
    fromRoleId?: RoleId;
    toRoleId: RoleId;
    activationType: HandoffEnvelope["activationType"];
    instructions?: string;
    preferredWorkerKinds?: WorkerKind[];
    sessionTarget?: "main" | "worker";
    continuityMode?: "fresh" | "prefer-existing" | "resume-existing";
    continuationContext?: DispatchContinuationContext;
    fanOutGroupId?: string;
    coverageTargetRoleIds?: RoleId[];
    mergeBackToRoleId?: RoleId;
    mergeContext?: FanOutMergeContext;
    parallelContext?: ParallelOrchestrationContext;
  }): Promise<void> {
    const flow = await this.requireFlow(input.flow.flowId);
    const recentMessages = sanitizeRecentMessagesForDispatch(
      await this.deps.summaryBuilder.getRecentMessages(input.thread.threadId, MAX_RECENT_MESSAGES_PER_DISPATCH)
    );
    const dispatchPolicy = {
      allowParallel: flow.mode !== "serial",
      allowReenter: true,
      ...(input.fanOutGroupId ? { fanOutGroupId: input.fanOutGroupId } : {}),
      ...(input.coverageTargetRoleIds?.length
        ? { coverageTargetRoleIds: input.coverageTargetRoleIds }
        : {}),
      ...(input.mergeBackToRoleId ? { mergeBackToRoleId: input.mergeBackToRoleId } : {}),
      sourceFlowMode: flow.mode,
    };

    const handoff: HandoffEnvelope = {
      taskId: this.deps.idGenerator.taskId(),
      flowId: flow.flowId,
      sourceMessageId: input.sourceMessage.id,
      targetRoleId: input.toRoleId,
      activationType: input.activationType,
      threadId: input.thread.threadId,
      payload: createRelayPayload({
        threadId: input.thread.threadId,
        relayBrief: "",
        recentMessages,
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(input.sessionTarget ? { sessionTarget: input.sessionTarget } : {}),
        ...(input.continuationContext || input.continuityMode
          ? {
              continuity: {
                ...(input.continuityMode ? { mode: input.continuityMode } : {}),
                ...(input.continuationContext ? { context: input.continuationContext } : {}),
              },
            }
          : {}),
        ...(input.mergeContext || input.parallelContext
          ? {
              coordination: {
                ...(input.mergeContext ? { merge: input.mergeContext } : {}),
                ...(input.parallelContext ? { parallel: input.parallelContext } : {}),
              },
            }
          : {}),
        ...(input.preferredWorkerKinds?.length ? { preferredWorkerKinds: input.preferredWorkerKinds } : {}),
        dispatchPolicy,
      }),
      createdAt: this.deps.clock.now(),
    };

    if (input.fromRoleId) {
      handoff.sourceRoleId = input.fromRoleId;
    }

    handoff.payload = normalizeRelayPayload({
      ...handoff.payload,
      intent: {
        ...handoff.payload.intent!,
        ...(input.instructions ? { instructions: input.instructions } : {}),
        relayBrief: this.deps.relayBriefBuilder.build({
          thread: input.thread,
          sourceMessage: input.sourceMessage,
          targetRoleId: input.toRoleId,
          recentMessages,
          flow,
          ...(input.instructions ? { instructions: input.instructions } : {}),
        }),
      },
      constraints: {
        ...handoff.payload.constraints!,
        dispatchPolicy: {
          ...getDispatchPolicy(handoff.payload),
          ...(flow.nextExpectedRoleId ? { expectedNextRoleIds: [flow.nextExpectedRoleId] } : {}),
        },
      },
    });

    const edgeId = await this.recordHandoff(flow.flowId, handoff);
    if (!edgeId) {
      return;
    }

    try {
      const runState = await this.deps.roleRunCoordinator.getOrCreate(input.thread.threadId, input.toRoleId);
      await this.deps.roleRunCoordinator.enqueue(runState.runKey, handoff);
      await this.markHandoffDelivered(flow.flowId, edgeId);
      await this.deps.roleLoopRunner.ensureRunning(runState.runKey);
    } catch (error) {
      await this.markHandoffCancelled(flow.flowId, edgeId);
      await this.removeActiveRole(flow.flowId, input.toRoleId);
      throw error;
    }
  }

  async onHandoffAck(input: { flowId: string; taskId: string }): Promise<void> {
    await this.updateEdge(input.flowId, `${input.taskId}:edge`, (edge) => ({
      ...edge,
      state:
        edge.state === "created" || edge.state === "delivered"
          ? "acked"
          : edge.state,
      ...(edge.respondedAt != null ? { respondedAt: edge.respondedAt } : {}),
      ...(edge.closedAt != null ? { closedAt: edge.closedAt } : {}),
    }));
  }

  async handleRoleReply(input: {
    flow: FlowLedger;
    thread: TeamThread;
    runState: RoleRunState;
    handoff: HandoffEnvelope;
    message: TeamMessage;
  }): Promise<void> {
    await this.markHandoffResponded(input.flow.flowId, input.handoff.taskId);
    await this.deps.teamMessageStore.append(input.message);
    await this.refreshRoleContext(input.thread.threadId, input.runState.roleId);
    await this.markRoleCompleted(input.flow.flowId, input.runState.roleId);
    await this.markHandoffClosed(input.flow.flowId, input.handoff.taskId);
    await this.recordShardReply(input.flow.flowId, input.handoff, input.runState.roleId, input.message);

    const decision = await this.deps.handoffPlanner.validateMentionTargets(input.thread, {
      flow: input.flow,
      sourceRoleId: input.runState.roleId,
      messageId: input.message.id,
      content: input.message.content,
    });

    if (!decision.allowed || decision.targetRoleIds.length === 0) {
      const fanOutHandled = await this.handleFanOutMerge(input.flow.flowId, input.thread, input.runState.roleId, input.message, input.handoff);
      if (fanOutHandled) {
        return;
      }

      const recovery = await this.deps.recoveryDirector.onRoleReply({
        thread: input.thread,
        flow: input.flow,
        message: input.message,
        mentions: [],
      });

      await this.applyRecoveryDecision(recovery, input.flow, input.thread, input.message);
      return;
    }

    const fanOutGroupId =
      decision.targetRoleIds.length > 1 ? `${input.message.id}:fanout` : undefined;

    for (const [index, targetRoleId] of decision.targetRoleIds.entries()) {
      await this.dispatchToRole({
        thread: input.thread,
        flow: input.flow,
        sourceMessage: input.message,
        fromRoleId: input.runState.roleId,
        toRoleId: targetRoleId,
        activationType: "mention",
        ...(fanOutGroupId
          ? {
              fanOutGroupId,
              coverageTargetRoleIds: decision.targetRoleIds,
              mergeBackToRoleId: input.thread.leadRoleId,
              parallelContext: buildResearchShardPacket({
                fanOutGroupId,
                shardRoleId: targetRoleId,
                shardIndex: index,
                shardCount: decision.targetRoleIds.length,
                expectedRoleIds: decision.targetRoleIds,
                mergeBackToRoleId: input.thread.leadRoleId,
                sourceMessage: input.message,
              }),
            }
          : {}),
      });
    }
  }

  async onRoleFailure(input: {
    flow: FlowLedger;
    thread: TeamThread;
    runState: RoleRunState;
    handoff: HandoffEnvelope;
    error: RuntimeError;
  }): Promise<void> {
    await this.markHandoffResponded(input.flow.flowId, input.handoff.taskId);
    await this.markRoleFailed(input.flow.flowId, input.runState.roleId);
    await this.markHandoffClosed(input.flow.flowId, input.handoff.taskId);

    const parallelFailureHandled = await this.handleFanOutFailure(
      input.flow.flowId,
      input.thread,
      input.runState.roleId,
      input.handoff,
      input.error
    );
    if (parallelFailureHandled) {
      return;
    }

    const recovery = await this.deps.recoveryDirector.onRoleFailure({
      thread: input.thread,
      flow: input.flow,
      failedRoleId: input.runState.roleId,
      error: input.error,
    });

    await this.applyRecoveryDecision(
      recovery,
      input.flow,
      input.thread,
      this.buildFailureNotice(input.thread, input.runState.roleId, input.error)
    );
  }

  private buildUserMessage(thread: TeamThread, content: string): TeamMessage {
    const now = this.deps.clock.now();
    return {
      id: this.deps.idGenerator.messageId(),
      threadId: thread.threadId,
      role: "user",
      name: "user",
      content,
      createdAt: now,
      updatedAt: now,
      source: {
        type: "desktop",
        chatType: "group",
        route: "user",
        speakerType: "User",
        speakerName: "user",
      },
    };
  }

  private buildFlow(thread: TeamThread, rootMessageId: string): FlowLedger {
    const now = this.deps.clock.now();
    return {
      flowId: this.deps.idGenerator.flowId(),
      threadId: thread.threadId,
      rootMessageId,
      mode: "serial",
      status: "created",
      currentStageIndex: 0,
      activeRoleIds: [],
      completedRoleIds: [],
      failedRoleIds: [],
      nextExpectedRoleId: thread.leadRoleId,
      hopCount: 0,
      maxHops: this.deps.runtimeLimits.flowMaxHops,
      edges: [],
      shardGroups: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async recordHandoff(flowId: string, handoff: HandoffEnvelope): Promise<string | null> {
    return this.withFlowLock(flowId, async () => {
      const flow = await this.requireFlow(flowId);
      if (flow.hopCount >= flow.maxHops) {
        if (flow.activeRoleIds.length > 0) {
          return null;
        }
        await this.putFlow({
          ...flow,
          status: "aborted",
          activeRoleIds: [],
          updatedAt: this.deps.clock.now(),
        });
        return null;
      }

      if (this.hasDuplicateHandoff(flow, handoff.sourceMessageId, handoff.targetRoleId)) {
        return null;
      }

      const edge = buildHandoffEdge(flowId, handoff);
      const nextShardGroups = ensureShardGroups(flow, handoff, this.deps.clock.now());
      const next: FlowLedger = {
        ...flow,
        status: "waiting_role",
        activeRoleIds: unique([...flow.activeRoleIds, handoff.targetRoleId]),
        edges: [...flow.edges, edge],
        shardGroups: nextShardGroups,
        hopCount: flow.hopCount + 1,
        updatedAt: this.deps.clock.now(),
      };

      await this.putFlow(next);
      await this.recordRuntimeChainBestEffort("recordDispatchEnqueued", next, () =>
        this.deps.runtimeChainRecorder?.recordDispatchEnqueued({
          flow: next,
          handoff,
        })
      );
      return edge.edgeId;
    });
  }

  private async markRoleCompleted(flowId: string, roleId: RoleId): Promise<void> {
    await this.withFlowLock(flowId, async () => {
      const flow = await this.requireFlow(flowId);
      const next: FlowLedger = {
        ...flow,
        completedRoleIds: unique([...flow.completedRoleIds, roleId]),
        activeRoleIds: flow.activeRoleIds.filter((item) => item !== roleId),
        updatedAt: this.deps.clock.now(),
      };

      await this.putFlow(next);
    });
  }

  private async markRoleFailed(flowId: string, roleId: RoleId): Promise<void> {
    await this.withFlowLock(flowId, async () => {
      const flow = await this.requireFlow(flowId);
      const next: FlowLedger = {
        ...flow,
        failedRoleIds: unique([...flow.failedRoleIds, roleId]),
        activeRoleIds: flow.activeRoleIds.filter((item) => item !== roleId),
        status: "failed",
        updatedAt: this.deps.clock.now(),
      };

      await this.putFlow(next);
    });
  }

  private async removeActiveRole(flowId: string, roleId: RoleId): Promise<void> {
    await this.withFlowLock(flowId, async () => {
      const flow = await this.requireFlow(flowId);
      if (!flow.activeRoleIds.includes(roleId)) {
        return;
      }

      await this.putFlow({
        ...flow,
        activeRoleIds: flow.activeRoleIds.filter((item) => item !== roleId),
        updatedAt: this.deps.clock.now(),
      });
    });
  }

  private async recordShardReply(
    flowId: string,
    handoff: HandoffEnvelope,
    roleId: RoleId,
    message: TeamMessage
  ): Promise<void> {
    const fanOutGroupId = getDispatchPolicy(handoff.payload).fanOutGroupId;
    if (!fanOutGroupId) {
      return;
    }

    await this.withFlowLock(flowId, async () => {
      const flow = await this.requireFlow(flowId);
      const group = flow.shardGroups?.find((item) => item.groupId === fanOutGroupId);
      if (!group) {
        return;
      }

      const summary = summarizeShardContent(message.content);
      const shardResult: ShardResultRecord = {
        roleId,
        status: "completed",
        summary,
        summaryDigest: hashShardSummary(summary),
        messageId: message.id,
        updatedAt: this.deps.clock.now(),
      };
      const nextGroup = refreshShardGroup(group, flow, shardResult);

      await this.putFlow({
        ...flow,
        shardGroups: replaceShardGroup(flow.shardGroups ?? [], nextGroup),
        updatedAt: this.deps.clock.now(),
      });
    });
  }

  private async handleFanOutMerge(
    flowId: string,
    thread: TeamThread,
    sourceRoleId: RoleId,
    sourceMessage: TeamMessage,
    handoff: HandoffEnvelope
  ): Promise<boolean> {
    const fanOutGroupId = getDispatchPolicy(handoff.payload).fanOutGroupId;
    if (!fanOutGroupId) {
      return false;
    }

    const action = await this.planFanOutAction(flowId, fanOutGroupId, thread.leadRoleId, sourceRoleId);
    if (!action || action.kind === "wait") {
      return Boolean(action);
    }

    if (action.kind === "merge") {
      await this.dispatchToRole({
        thread,
        flow: action.flow,
        sourceMessage,
        fromRoleId: sourceRoleId,
        toRoleId: action.mergeBackToRoleId,
        activationType: "cascade",
        instructions: buildFanOutMergeInstructions(action.mergeContext, action.parallelContext),
        mergeContext: action.mergeContext,
        parallelContext: action.parallelContext,
      });
      return true;
    }

    return false;
  }

  private async handleFanOutFailure(
    flowId: string,
    thread: TeamThread,
    roleId: RoleId,
    handoff: HandoffEnvelope,
    error: RuntimeError
  ): Promise<boolean> {
    const fanOutGroupId = getDispatchPolicy(handoff.payload).fanOutGroupId;
    if (!fanOutGroupId) {
      return false;
    }

    const action = await this.planFanOutFailureAction(flowId, handoff, roleId, error);
    if (!action) {
      return false;
    }

    if (action.kind === "wait") {
      return true;
    }

    if (action.kind === "retry") {
      await this.dispatchToRole({
        thread,
        flow: action.flow,
        sourceMessage: this.buildFailureNotice(thread, roleId, error),
        fromRoleId: roleId,
        toRoleId: roleId,
        activationType: "retry",
        instructions: action.instructions,
        fanOutGroupId,
        coverageTargetRoleIds: action.group.expectedRoleIds,
        mergeBackToRoleId: action.group.mergeBackToRoleId,
        parallelContext: buildResearchShardPacket({
          fanOutGroupId,
          shardRoleId: roleId,
          shardIndex: action.group.expectedRoleIds.indexOf(roleId),
          shardCount: action.group.expectedRoleIds.length,
          expectedRoleIds: action.group.expectedRoleIds,
          mergeBackToRoleId: action.group.mergeBackToRoleId,
          sourceMessage: this.buildFailureNotice(thread, roleId, error),
        }),
      });
      return true;
    }

    await this.dispatchToRole({
      thread,
      flow: action.flow,
      sourceMessage: this.buildFailureNotice(thread, roleId, error),
      fromRoleId: roleId,
      toRoleId: action.group.mergeBackToRoleId,
      activationType: "cascade",
      instructions: buildFanOutMergeInstructions(action.mergeContext, action.parallelContext),
      mergeContext: action.mergeContext,
      parallelContext: action.parallelContext,
    });
    return true;
  }

  private async planFanOutAction(
    flowId: string,
    fanOutGroupId: string,
    defaultMergeBackToRoleId: RoleId,
    sourceRoleId: RoleId
  ): Promise<
    | { kind: "wait" }
    | {
        kind: "merge";
        flow: FlowLedger;
        mergeBackToRoleId: RoleId;
        mergeContext: FanOutMergeContext;
        parallelContext: MergeSynthesisPacket;
      }
    | null
  > {
    return this.withFlowLock(flowId, async () => {
      const flow = await this.requireFlow(flowId);
      const group = flow.shardGroups?.find((item) => item.groupId === fanOutGroupId);
      if (!group) {
        return null;
      }

      const hasOpenSibling = flow.edges.some(
        (edge) => edge.fanOutGroupId === fanOutGroupId && !["closed", "cancelled"].includes(edge.state)
      );
      if (hasOpenSibling || group.status === "merged") {
        return { kind: "wait" as const };
      }

      const mergeBackToRoleId = group.mergeBackToRoleId ?? defaultMergeBackToRoleId;
      if (mergeBackToRoleId === sourceRoleId) {
        return null;
      }

      const nextGroup: ShardGroupRecord = {
        ...group,
        status: "merged",
        updatedAt: this.deps.clock.now(),
      };
      const nextFlow: FlowLedger = {
        ...flow,
        shardGroups: replaceShardGroup(flow.shardGroups ?? [], nextGroup),
        updatedAt: this.deps.clock.now(),
      };
      await this.putFlow(nextFlow);

      const mergeContext = buildFanOutMergeContext(nextGroup);
      return {
        kind: "merge" as const,
        flow: nextFlow,
        mergeBackToRoleId,
        mergeContext,
        parallelContext: buildMergeSynthesisPacket(nextGroup),
      };
    });
  }

  private async planFanOutFailureAction(
    flowId: string,
    handoff: HandoffEnvelope,
    roleId: RoleId,
    error: RuntimeError
  ): Promise<
    | { kind: "wait" }
    | { kind: "retry"; flow: FlowLedger; group: ShardGroupRecord; instructions: string }
    | {
        kind: "merge";
        flow: FlowLedger;
        group: ShardGroupRecord;
        mergeContext: FanOutMergeContext;
        parallelContext: MergeSynthesisPacket;
      }
    | null
  > {
    const fanOutGroupId = getDispatchPolicy(handoff.payload).fanOutGroupId;
    if (!fanOutGroupId) {
      return null;
    }

    return this.withFlowLock(flowId, async () => {
      const flow = await this.requireFlow(flowId);
      const group = flow.shardGroups?.find((item) => item.groupId === fanOutGroupId);
      if (!group) {
        return null;
      }

      const retryCount = group.retryCounts[roleId] ?? 0;
      const shardResult: ShardResultRecord = {
        roleId,
        status: "failed",
        summary: error.message,
        summaryDigest: hashShardSummary(error.message),
        updatedAt: this.deps.clock.now(),
      };
      let nextGroup = refreshShardGroup(group, flow, shardResult);

      if (retryCount < 1) {
        nextGroup = {
          ...nextGroup,
          status: "waiting_retry",
          retryCounts: {
            ...nextGroup.retryCounts,
            [roleId]: retryCount + 1,
          },
          updatedAt: this.deps.clock.now(),
        };
        const nextFlow: FlowLedger = {
          ...flow,
          shardGroups: replaceShardGroup(flow.shardGroups ?? [], nextGroup),
          updatedAt: this.deps.clock.now(),
        };
        await this.putFlow(nextFlow);
        return {
          kind: "retry" as const,
          flow: nextFlow,
          group: nextGroup,
          instructions: `Retry shard ${roleId} for fan-out group ${fanOutGroupId}. Recover the missing slice and return only your shard result.`,
        };
      }

      const hasOpenSibling = flow.edges.some(
        (edge) => edge.fanOutGroupId === fanOutGroupId && !["closed", "cancelled"].includes(edge.state)
      );
      nextGroup = {
        ...nextGroup,
        status: hasOpenSibling ? "running" : "merged",
        updatedAt: this.deps.clock.now(),
      };
      const nextFlow: FlowLedger = {
        ...flow,
        shardGroups: replaceShardGroup(flow.shardGroups ?? [], nextGroup),
        updatedAt: this.deps.clock.now(),
      };
      await this.putFlow(nextFlow);

      if (hasOpenSibling) {
        return { kind: "wait" as const };
      }

      return {
        kind: "merge" as const,
        flow: nextFlow,
        group: nextGroup,
        mergeContext: buildFanOutMergeContext(nextGroup),
        parallelContext: buildMergeSynthesisPacket(nextGroup),
      };
    });
  }


  private async applyRecoveryDecision(
    decision: RecoveryDecision,
    flow: FlowLedger,
    thread: TeamThread,
    sourceMessage: TeamMessage
  ): Promise<void> {
    const latestFlow = await this.requireFlow(flow.flowId);

    if (decision.action === "dispatch") {
      for (const roleId of decision.targetRoleIds) {
        await this.dispatchToRole({
          thread,
          flow: latestFlow,
          sourceMessage,
          toRoleId: roleId,
          activationType: "cascade",
        });
      }
      return;
    }

    if (decision.action === "retry") {
      await this.dispatchToRole({
        thread,
        flow: latestFlow,
        sourceMessage,
        toRoleId: decision.targetRoleId,
        activationType: "retry",
      });
      return;
    }

    if (decision.action === "fallback_to_lead") {
      await this.dispatchToRole({
        thread,
        flow: latestFlow,
        sourceMessage,
        toRoleId: decision.leadRoleId,
        activationType: "fallback",
      });
      return;
    }

    await this.withFlowLock(latestFlow.flowId, async () => {
      const current = await this.requireFlow(latestFlow.flowId);
      await this.putFlow({
        ...current,
        status: decision.action === "complete" ? "completed" : "aborted",
        activeRoleIds: [],
        updatedAt: this.deps.clock.now(),
      });
    });
  }

  private buildFailureNotice(thread: TeamThread, roleId: RoleId, error: RuntimeError): TeamMessage {
    const now = this.deps.clock.now();
    return {
      id: this.deps.idGenerator.messageId(),
      threadId: thread.threadId,
      role: "system",
      roleId,
      name: "system",
      content: `Role ${roleId} failed: ${error.message}`,
      createdAt: now,
      updatedAt: now,
      source: {
        type: "worker",
        chatType: "group",
        route: "worker",
        speakerType: "Tool",
        speakerName: "system",
      },
      metadata: {
        code: error.code,
        retryable: error.retryable,
      },
    };
  }

  private buildScheduledMessage(thread: TeamThread, task: ScheduledTaskRecord): TeamMessage {
    const now = this.deps.clock.now();
    return {
      id: this.deps.idGenerator.messageId(),
      threadId: thread.threadId,
      role: "system",
      name: "scheduler",
      content: buildScheduledContent(task),
      createdAt: now,
      updatedAt: now,
      source: {
        type: "worker",
        chatType: "group",
        route: "worker",
        speakerType: "Tool",
        speakerName: "scheduler",
      },
      metadata: {
        scheduledTaskId: task.taskId,
        schedule: task.schedule,
        targetRoleId: getScheduledTargetRoleId(task),
        ...(getScheduledTargetWorker(task) ? { targetWorker: getScheduledTargetWorker(task) } : {}),
      },
    };
  }

  private async requireFlow(flowId: string): Promise<FlowLedger> {
    const flow = await this.deps.flowLedgerStore.get(flowId);
    if (!flow) {
      throw new Error(`flow not found: ${flowId}`);
    }
    return flow;
  }

  private async resolveScheduledContinuationContext(
    task: ScheduledTaskRecord
  ): Promise<DispatchContinuationContext | undefined> {
    const scheduledContinuity = getScheduledContinuity(task);
    const targetWorker = getScheduledTargetWorker(task);
    const baseRecoveryContext: DispatchContinuationContext | undefined = scheduledContinuity?.context?.recovery
      ? {
          source: "recovery_dispatch" as const,
          ...(targetWorker ? { workerType: targetWorker } : {}),
          recovery: scheduledContinuity.context.recovery,
        }
      : undefined;

    if (getScheduledSessionTarget(task) !== "worker" || !targetWorker || !this.deps.workerRuntime) {
      return scheduledContinuity?.context ?? baseRecoveryContext;
    }

    try {
      const runState = await this.deps.roleRunCoordinator.getOrCreate(task.threadId, getScheduledTargetRoleId(task));
      const workerRunKey = runState.workerSessions?.[targetWorker];
      if (!workerRunKey) {
        return scheduledContinuity?.context ?? baseRecoveryContext;
      }

      const workerState = await this.deps.workerRuntime.getState(workerRunKey);
      if (!workerState || workerState.status === "failed" || workerState.status === "cancelled") {
        return {
          ...(scheduledContinuity?.context ?? baseRecoveryContext ?? {
            source: "scheduled_reentry" as const,
            workerType: targetWorker,
          }),
          workerRunKey,
          ...(workerState?.lastError?.message ? { summary: workerState.lastError.message } : {}),
        };
      }

      const summary =
        workerState.continuationDigest?.summary ??
        workerState.lastResult?.summary ??
        workerState.lastError?.message;
      const browserSession =
        targetWorker === "browser"
          ? decodeBrowserSessionPayload(workerState.lastResult?.payload)
          : null;

      return {
        source: scheduledContinuity?.context?.recovery ? "recovery_dispatch" : "scheduled_reentry",
        workerType: targetWorker,
        workerRunKey,
        ...(summary ? { summary } : {}),
        ...(scheduledContinuity?.context?.recovery ? { recovery: scheduledContinuity.context.recovery } : {}),
        ...(targetWorker === "browser" && browserSession
          ? {
              browserSession: {
                sessionId: browserSession.sessionId,
                ...(browserSession.targetId ? { targetId: browserSession.targetId } : {}),
                ...(browserSession.resumeMode ? { resumeMode: browserSession.resumeMode } : {}),
                ownerType: "thread" as const,
                ownerId: task.threadId,
                leaseHolderRunKey: workerRunKey,
              },
            }
          : {}),
      };
    } catch (error) {
      console.error("scheduled continuation context lookup failed", {
        taskId: task.taskId,
        targetRoleId: getScheduledTargetRoleId(task),
        targetWorker,
        error,
      });
      return scheduledContinuity?.context ?? baseRecoveryContext;
    }
  }

  private hasDuplicateHandoff(flow: FlowLedger, sourceMessageId: string, targetRoleId: RoleId): boolean {
    return flow.edges.some(
      (edge) =>
        edge.sourceMessageId === sourceMessageId &&
        edge.toRoleId === targetRoleId &&
        edge.state !== "cancelled"
    );
  }

  private async markHandoffDelivered(flowId: string, edgeId: string): Promise<void> {
    await this.updateEdge(flowId, edgeId, (edge) => ({
      ...edge,
      state:
        edge.state === "created"
          ? "delivered"
          : edge.state,
    }));
  }

  private async markHandoffCancelled(flowId: string, edgeId: string): Promise<void> {
    await this.updateEdge(flowId, edgeId, (edge, now) => ({
      ...edge,
      state: "cancelled",
      closedAt: edge.closedAt ?? now,
    }));
  }

  private async markHandoffResponded(flowId: string, taskId: string): Promise<void> {
    await this.updateEdge(flowId, `${taskId}:edge`, (edge, now) => ({
      ...edge,
      state: "responded",
      respondedAt: edge.respondedAt ?? now,
    }));
  }

  private async markHandoffClosed(flowId: string, taskId: string): Promise<void> {
    await this.updateEdge(flowId, `${taskId}:edge`, (edge, now) => ({
      ...edge,
      state: "closed",
      respondedAt: edge.respondedAt ?? now,
      closedAt: edge.closedAt ?? now,
    }));
  }

  private async updateEdge(
    flowId: string,
    edgeId: string,
    mutate: (edge: FlowLedger["edges"][number], now: number) => FlowLedger["edges"][number]
  ): Promise<void> {
    await this.withFlowLock(flowId, async () => {
      const flow = await this.requireFlow(flowId);
      const now = this.deps.clock.now();
      const index = flow.edges.findIndex((edge) => edge.edgeId === edgeId);
      if (index === -1) {
        throw new Error(`handoff edge not found: ${edgeId}`);
      }
      const edges = [...flow.edges];
      const currentEdge = edges[index];
      if (!currentEdge) {
        throw new Error(`handoff edge not found: ${edgeId}`);
      }
      edges[index] = mutate(currentEdge, now);
      await this.putFlow({
        ...flow,
        edges,
        updatedAt: now,
      });
    });
  }

  private async putFlow(flow: FlowLedger): Promise<void> {
    await this.deps.flowLedgerStore.put(flow, flow.version != null ? { expectedVersion: flow.version } : undefined);
    await this.recordRuntimeChainBestEffort("syncFlowStatus", flow, () => this.deps.runtimeChainRecorder?.syncFlowStatus(flow));
  }

  private async recordRuntimeChainBestEffort(
    method: "recordFlowCreated" | "recordDispatchEnqueued" | "syncFlowStatus",
    flow: Pick<FlowLedger, "flowId" | "threadId">,
    work: () => Promise<void> | undefined
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      console.error("runtime chain recorder failed", {
        method,
        flowId: flow.flowId,
        threadId: flow.threadId,
        error,
      });
    }
  }

  private async withFlowLock<T>(flowId: string, work: () => Promise<T>): Promise<T> {
    return this.flowMutex.run(flowId, work);
  }

  private async refreshThreadContext(threadId: string): Promise<void> {
    if (!this.deps.contextStateMaintainer) {
      return;
    }

    try {
      await this.deps.contextStateMaintainer.onUserMessage(threadId);
    } catch (error) {
      console.error("context state refresh failed for user message", { threadId, error });
    }
  }

  private async refreshRoleContext(threadId: string, roleId: RoleId): Promise<void> {
    if (!this.deps.contextStateMaintainer) {
      return;
    }

    try {
      await this.deps.contextStateMaintainer.onRoleReply(threadId, roleId);
    } catch (error) {
      console.error("context state refresh failed for role reply", { threadId, roleId, error });
    }
  }
}

const MAX_RECENT_MESSAGES_PER_DISPATCH = 8;
const MAX_RECENT_MESSAGE_CHARS = 320;

function sanitizeRecentMessagesForDispatch(messages: TeamMessageSummary[]): TeamMessageSummary[] {
  return messages.slice(-MAX_RECENT_MESSAGES_PER_DISPATCH).map((message) => ({
    ...message,
    content:
      message.content.length > MAX_RECENT_MESSAGE_CHARS
        ? `${message.content.slice(0, MAX_RECENT_MESSAGE_CHARS - 1)}…`
        : message.content,
  }));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function buildHandoffEdge(flowId: string, handoff: HandoffEnvelope): FlowLedger["edges"][number] {
  const dispatchPolicy = getDispatchPolicy(handoff.payload);
  const edge: FlowLedger["edges"][number] = {
    edgeId: `${handoff.taskId}:edge`,
    flowId,
    toRoleId: handoff.targetRoleId,
    sourceMessageId: handoff.sourceMessageId,
    ...(dispatchPolicy.fanOutGroupId
      ? { fanOutGroupId: dispatchPolicy.fanOutGroupId }
      : {}),
    state: "created",
    createdAt: handoff.createdAt,
  };

  if (handoff.sourceRoleId) {
    edge.fromRoleId = handoff.sourceRoleId;
  }

  return edge;
}

function buildFanOutMergeContext(group: ShardGroupRecord): FanOutMergeContext {
  const duplicates = detectDuplicateRoleIds(group.shardResults);
  const conflicts = detectConflictRoleIds(group.shardResults);

  return {
    fanOutGroupId: group.groupId,
    expectedRoleIds: group.expectedRoleIds,
    completedRoleIds: group.completedRoleIds,
    failedRoleIds: group.failedRoleIds,
    cancelledRoleIds: group.cancelledRoleIds,
    missingRoleIds: group.expectedRoleIds.filter(
      (roleId) =>
        !group.completedRoleIds.includes(roleId) &&
        !group.failedRoleIds.includes(roleId) &&
        !group.cancelledRoleIds.includes(roleId)
    ),
    followUpRequired:
      group.failedRoleIds.length > 0 ||
      group.cancelledRoleIds.length > 0 ||
      group.expectedRoleIds.some(
        (roleId) =>
          !group.completedRoleIds.includes(roleId) &&
          !group.failedRoleIds.includes(roleId) &&
          !group.cancelledRoleIds.includes(roleId)
      ) ||
      conflicts.length > 0,
    duplicateRoleIds: duplicates,
    conflictRoleIds: conflicts,
    shardSummaries: group.shardResults.map((item) => ({
      roleId: item.roleId,
      status: item.status,
      summary: item.summary,
    })),
  };
}

function buildMergeSynthesisPacket(group: ShardGroupRecord): MergeSynthesisPacket {
  const mergeContext = buildFanOutMergeContext(group);
  return {
    kind: "merge_synthesis",
    fanOutGroupId: group.groupId,
    expectedRoleIds: group.expectedRoleIds,
    completedRoleIds: mergeContext.completedRoleIds,
    failedRoleIds: mergeContext.failedRoleIds,
    cancelledRoleIds: mergeContext.cancelledRoleIds,
    missingRoleIds: mergeContext.missingRoleIds,
    duplicateRoleIds: mergeContext.duplicateRoleIds ?? [],
    conflictRoleIds: mergeContext.conflictRoleIds ?? [],
    followUpRequired: mergeContext.followUpRequired,
    shardSummaries: mergeContext.shardSummaries ?? [],
  };
}

function buildFanOutMergeInstructions(input: FanOutMergeContext, packet: MergeSynthesisPacket): string {
  return [
    `Fan-out group completed: ${input.fanOutGroupId}`,
    `Covered roles: ${input.expectedRoleIds.join(", ")}`,
    input.completedRoleIds.length > 0 ? `Completed: ${input.completedRoleIds.join(", ")}` : null,
    input.failedRoleIds.length > 0 ? `Failed: ${input.failedRoleIds.join(", ")}` : null,
    input.cancelledRoleIds.length > 0 ? `Cancelled: ${input.cancelledRoleIds.join(", ")}` : null,
    input.missingRoleIds.length > 0 ? `Missing: ${input.missingRoleIds.join(", ")}` : null,
    (packet.duplicateRoleIds?.length ?? 0) > 0 ? `Duplicates: ${packet.duplicateRoleIds.join(", ")}` : null,
    (packet.conflictRoleIds?.length ?? 0) > 0 ? `Conflicts: ${packet.conflictRoleIds.join(", ")}` : null,
    input.followUpRequired
      ? "Before finalizing, decide whether follow-up work is required for failed, cancelled, or missing shards."
      : "Merge the completed parallel results, check for gaps or conflicts, and return a single synthesis.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function ensureShardGroups(flow: FlowLedger, handoff: HandoffEnvelope, now: number): ShardGroupRecord[] {
  const packet = getParallelContext(handoff.payload);
  if (!packet || packet.kind !== "research_shard") {
    return flow.shardGroups ?? [];
  }

  const groups = flow.shardGroups ?? [];
  const existing = groups.find((group) => group.groupId === packet.fanOutGroupId);
  if (existing) {
    return replaceShardGroup(groups, {
      ...existing,
      status: existing.status === "waiting_retry" ? "running" : existing.status,
      updatedAt: now,
    });
  }

  return [
    ...groups,
    {
      groupId: packet.fanOutGroupId,
      parentTaskId: handoff.taskId,
      sourceMessageId: handoff.sourceMessageId,
      ...(handoff.sourceRoleId ? { sourceRoleId: handoff.sourceRoleId } : {}),
      mergeBackToRoleId: packet.mergeBackToRoleId,
      kind: "research",
      status: "running",
      expectedRoleIds: packet.expectedRoleIds,
      completedRoleIds: [],
      failedRoleIds: [],
      cancelledRoleIds: [],
      retryCounts: {},
      shardResults: [],
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function replaceShardGroup(groups: ShardGroupRecord[], nextGroup: ShardGroupRecord): ShardGroupRecord[] {
  const index = groups.findIndex((group) => group.groupId === nextGroup.groupId);
  if (index === -1) {
    return [...groups, nextGroup];
  }

  const next = [...groups];
  next[index] = nextGroup;
  return next;
}

function refreshShardGroup(group: ShardGroupRecord, flow: FlowLedger, result: ShardResultRecord): ShardGroupRecord {
  const existingResults = group.shardResults.filter((item) => item.roleId !== result.roleId);
  const nextResults = [...existingResults, result];
  const completedRoleIds = unique(
    nextResults.filter((item) => item.status === "completed").map((item) => item.roleId)
  );
  const failedRoleIds = unique([
    ...group.failedRoleIds.filter((roleId) => roleId !== result.roleId),
    ...nextResults.filter((item) => item.status === "failed").map((item) => item.roleId),
    ...flow.failedRoleIds.filter((roleId) => group.expectedRoleIds.includes(roleId)),
  ]);
  const cancelledRoleIds = unique([
    ...group.cancelledRoleIds.filter((roleId) => roleId !== result.roleId),
    ...nextResults.filter((item) => item.status === "cancelled").map((item) => item.roleId),
    ...flow.edges
      .filter((edge) => edge.fanOutGroupId === group.groupId && edge.state === "cancelled")
      .map((edge) => edge.toRoleId),
  ]);

  return {
    ...group,
    completedRoleIds,
    failedRoleIds,
    cancelledRoleIds,
    shardResults: nextResults,
    updatedAt: result.updatedAt,
  };
}

function buildResearchShardPacket(input: {
  fanOutGroupId: string;
  shardRoleId: RoleId;
  shardIndex: number;
  shardCount: number;
  expectedRoleIds: RoleId[];
  mergeBackToRoleId: RoleId;
  sourceMessage: TeamMessage;
}): ResearchShardPacket {
  return {
    kind: "research_shard",
    fanOutGroupId: input.fanOutGroupId,
    shardRoleId: input.shardRoleId,
    shardIndex: input.shardIndex,
    shardCount: input.shardCount,
    expectedRoleIds: input.expectedRoleIds,
    mergeBackToRoleId: input.mergeBackToRoleId,
    shardGoal: summarizeShardGoal(input.sourceMessage.content, input.shardRoleId),
  };
}

function summarizeShardGoal(content: string, roleId: RoleId): string {
  return content.replace(/@\{[^}]+\}/g, "").replace(/\s+/g, " ").trim() || `Investigate the assigned shard for ${roleId}.`;
}

function summarizeShardContent(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 320);
}

function hashShardSummary(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}


function buildScheduledContent(task: ScheduledTaskRecord): string {
  return [
    `[scheduled:${task.capsule.title}]`,
    task.capsule.instructions,
    task.capsule.expectedOutput ? `Expected output: ${task.capsule.expectedOutput}` : null,
    task.capsule.artifactRefs && task.capsule.artifactRefs.length > 0
      ? `Artifact refs: ${task.capsule.artifactRefs.join(", ")}`
      : null,
    task.capsule.dependencyRefs && task.capsule.dependencyRefs.length > 0
      ? `Dependencies: ${task.capsule.dependencyRefs.join(", ")}`
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildScheduledInstructions(
  task: ScheduledTaskRecord,
  continuationContext?: DispatchContinuationContext
): string {
  const targetWorker = getScheduledTargetWorker(task);
  const sessionTarget = getScheduledSessionTarget(task);
  return [
    `Scheduled task: ${task.capsule.title}`,
    `Schedule: ${task.schedule.expr} (${task.schedule.tz})`,
    `Session target: ${sessionTarget}`,
    task.capsule.instructions,
    task.capsule.expectedOutput ? `Expected output: ${task.capsule.expectedOutput}` : null,
    targetWorker ? `Preferred worker: ${targetWorker}` : null,
    sessionTarget === "worker" ? "Resume the existing worker session when available." : null,
    continuationContext?.summary ? `Continuation summary: ${continuationContext.summary}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
