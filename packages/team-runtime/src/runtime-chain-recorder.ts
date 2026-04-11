import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import type {
  Clock,
  FlowLedger,
  HandoffEdge,
  HandoffEnvelope,
  RuntimeChain,
  RuntimeChainEvent,
  RuntimeChainEventStore,
  RuntimeChainPhase,
  RuntimeChainRecorder,
  RuntimeChainSpan,
  RuntimeChainSpanStore,
  RuntimeChainStatus,
  RuntimeChainStatusStore,
  RuntimeChainStore,
  RuntimeStateRecorder,
  TaskId,
} from "@turnkeyai/core-types/team";

const ACTIVE_RESPONSE_TIMEOUT_MS = 3 * 60 * 1000;
const WAITING_RESPONSE_TIMEOUT_MS = 15 * 60 * 1000;

interface DefaultRuntimeChainRecorderOptions {
  chainStore: RuntimeChainStore;
  spanStore: RuntimeChainSpanStore;
  eventStore: RuntimeChainEventStore;
  statusStore: RuntimeChainStatusStore;
  clock: Clock;
  runtimeStateRecorder?: RuntimeStateRecorder;
}

export class DefaultRuntimeChainRecorder implements RuntimeChainRecorder {
  private readonly chainStore: RuntimeChainStore;
  private readonly spanStore: RuntimeChainSpanStore;
  private readonly eventStore: RuntimeChainEventStore;
  private readonly statusStore: RuntimeChainStatusStore;
  private readonly clock: Clock;
  private readonly runtimeStateRecorder: RuntimeStateRecorder | undefined;
  private readonly chainMutex = new KeyedAsyncMutex<string>();

  constructor(options: DefaultRuntimeChainRecorderOptions) {
    this.chainStore = options.chainStore;
    this.spanStore = options.spanStore;
    this.eventStore = options.eventStore;
    this.statusStore = options.statusStore;
    this.clock = options.clock;
    this.runtimeStateRecorder = options.runtimeStateRecorder;
  }

  async recordFlowCreated(flow: FlowLedger): Promise<void> {
    const chainId = buildFlowChainId(flow.flowId);
    await this.chainMutex.run(chainId, async () => {
      const chain = await this.ensureFlowChain(flow);
      const rootSpan = await this.ensureFlowRootSpan(flow, chain.chainId);
      const summary = `Flow ${flow.flowId} created`;
      await this.eventStore.append({
        eventId: buildRuntimeChainEventId(chain.chainId, "flow", flow.flowId, flow.createdAt),
        chainId: chain.chainId,
        spanId: rootSpan.spanId,
        threadId: flow.threadId,
        subjectKind: "flow",
        subjectId: flow.flowId,
        phase: "started",
        recordedAt: flow.createdAt,
        summary,
        ...(flow.rootMessageId ? { metadata: { rootMessageId: flow.rootMessageId } } : {}),
      });
      const status = {
        chainId: chain.chainId,
        threadId: flow.threadId,
        activeSpanId: rootSpan.spanId,
        activeSubjectKind: "flow",
        activeSubjectId: flow.flowId,
        phase: "started",
        latestSummary: summary,
        lastHeartbeatAt: flow.updatedAt,
        responseTimeoutAt: flow.updatedAt + ACTIVE_RESPONSE_TIMEOUT_MS,
        attention: false,
        updatedAt: flow.updatedAt,
      } satisfies RuntimeChainStatus;
      const previousStatus = await this.statusStore.get(chain.chainId);
      await this.statusStore.put(status, previousStatus ? { expectedVersion: previousStatus.version } : undefined);
      await this.runtimeStateRecorder?.record({
        chain,
        status: (await this.statusStore.get(chain.chainId)) ?? status,
      });
    });
  }

  async syncFlowStatus(flow: FlowLedger): Promise<void> {
    const chainId = buildFlowChainId(flow.flowId);
    await this.chainMutex.run(chainId, async () => {
      const chain = await this.ensureFlowChain(flow);
      const rootSpan = await this.ensureFlowRootSpan(flow, chain.chainId);
      const previous = await this.statusStore.get(chain.chainId);
      const next = buildRuntimeChainStatusFromFlow(flow, rootSpan.spanId);
      if (next.activeSubjectKind === "dispatch" && next.activeSubjectId) {
        await this.ensureDispatchSpanFromTaskId(chain.chainId, rootSpan.spanId, flow.threadId, flow.flowId, next.activeSubjectId);
      }
      await this.statusStore.put(next, previous ? { expectedVersion: previous.version } : undefined);
      const persisted = (await this.statusStore.get(chain.chainId)) ?? next;
      await this.runtimeStateRecorder?.record({ chain, status: persisted });
      if (!hasMeaningfulStatusChange(previous, persisted)) {
        return;
      }

      await this.eventStore.append({
        eventId: buildRuntimeChainEventId(
          chain.chainId,
          persisted.activeSubjectKind ?? "flow",
          persisted.activeSubjectId ?? flow.flowId,
          persisted.updatedAt
        ),
        chainId: chain.chainId,
        spanId: persisted.activeSpanId ?? rootSpan.spanId,
        threadId: flow.threadId,
        subjectKind: persisted.activeSubjectKind ?? "flow",
        subjectId: persisted.activeSubjectId ?? flow.flowId,
        phase: mapStatusPhaseToEventPhase(persisted.phase),
        recordedAt: persisted.updatedAt,
        summary: persisted.latestSummary,
        ...(persisted.waitingReason ? { statusReason: persisted.waitingReason } : {}),
        ...(persisted.activeSpanId && persisted.activeSpanId !== rootSpan.spanId
          ? { parentSpanId: rootSpan.spanId }
          : {}),
        ...(persisted.activeSubjectKind === "dispatch" && persisted.activeSubjectId
          ? { artifacts: { dispatchTaskId: persisted.activeSubjectId as TaskId } }
          : {}),
      } satisfies RuntimeChainEvent);
    });
  }

  async recordDispatchEnqueued(input: { flow: FlowLedger; handoff: HandoffEnvelope }): Promise<void> {
    const chainId = buildFlowChainId(input.flow.flowId);
    await this.chainMutex.run(chainId, async () => {
      const chain = await this.ensureFlowChain(input.flow);
      const rootSpan = await this.ensureFlowRootSpan(input.flow, chain.chainId);
      const dispatchSpan = await this.ensureDispatchSpan(chain.chainId, rootSpan.spanId, input.handoff);
      const summary = `Dispatch enqueued for ${input.handoff.targetRoleId}`;
      await this.eventStore.append({
        eventId: buildRuntimeChainEventId(chain.chainId, "dispatch", input.handoff.taskId, input.handoff.createdAt),
        chainId: chain.chainId,
        spanId: dispatchSpan.spanId,
        parentSpanId: rootSpan.spanId,
        threadId: input.flow.threadId,
        subjectKind: "dispatch",
        subjectId: input.handoff.taskId,
        phase: "waiting",
        recordedAt: input.handoff.createdAt,
        summary,
        statusReason: `waiting for ${input.handoff.targetRoleId}`,
        artifacts: {
          dispatchTaskId: input.handoff.taskId,
        },
        metadata: {
          targetRoleId: input.handoff.targetRoleId,
          activationType: input.handoff.activationType,
        },
      });
      const status = {
        chainId: chain.chainId,
        threadId: input.flow.threadId,
        activeSpanId: dispatchSpan.spanId,
        activeSubjectKind: "dispatch",
        activeSubjectId: input.handoff.taskId,
        phase: "waiting",
        waitingReason: `waiting for ${input.handoff.targetRoleId}`,
        latestSummary: summary,
        lastHeartbeatAt: input.handoff.createdAt,
        responseTimeoutAt: input.handoff.createdAt + WAITING_RESPONSE_TIMEOUT_MS,
        attention: false,
        updatedAt: input.handoff.createdAt,
      } satisfies RuntimeChainStatus;
      const previousStatus = await this.statusStore.get(chain.chainId);
      await this.statusStore.put(status, previousStatus ? { expectedVersion: previousStatus.version } : undefined);
      await this.runtimeStateRecorder?.record({
        chain,
        status: (await this.statusStore.get(chain.chainId)) ?? status,
      });
    });
  }

  private async ensureFlowChain(flow: FlowLedger): Promise<RuntimeChain> {
    const chainId = buildFlowChainId(flow.flowId);
    const existing = await this.chainStore.get(chainId);
    const next: RuntimeChain = existing
      ? {
          ...existing,
          threadId: flow.threadId,
          flowId: flow.flowId,
          updatedAt: flow.updatedAt,
        }
      : {
          chainId,
          threadId: flow.threadId,
          rootKind: "flow",
          rootId: flow.flowId,
          flowId: flow.flowId,
          createdAt: flow.createdAt,
          updatedAt: flow.updatedAt,
        };
    await this.chainStore.put(next, existing ? { expectedVersion: existing.version } : undefined);
    return (await this.chainStore.get(chainId)) ?? next;
  }

  private async ensureFlowRootSpan(flow: FlowLedger, chainId: string): Promise<RuntimeChainSpan> {
    const spanId = buildFlowRootSpanId(flow.flowId);
    const existing = await this.spanStore.get(spanId);
    if (existing) {
      return existing;
    }

    const span: RuntimeChainSpan = {
      spanId,
      chainId,
      subjectKind: "flow",
      subjectId: flow.flowId,
      threadId: flow.threadId,
      flowId: flow.flowId,
      createdAt: flow.createdAt,
      updatedAt: flow.updatedAt,
    };
    await this.spanStore.put(span);
    return (await this.spanStore.get(spanId)) ?? span;
  }

  private async ensureDispatchSpan(chainId: string, parentSpanId: string, handoff: HandoffEnvelope): Promise<RuntimeChainSpan> {
    return this.ensureDispatchSpanFromTaskId(
      chainId,
      parentSpanId,
      handoff.threadId,
      handoff.flowId,
      handoff.taskId,
      handoff.targetRoleId,
      handoff.createdAt
    );
  }

  private async ensureDispatchSpanFromTaskId(
    chainId: string,
    parentSpanId: string,
    threadId: string,
    flowId: string,
    taskId: string,
    roleId?: string,
    createdAt?: number
  ): Promise<RuntimeChainSpan> {
    const spanId = buildDispatchSpanId(taskId);
    const existing = await this.spanStore.get(spanId);
    if (existing) {
      return existing;
    }

    const now = createdAt ?? this.clock.now();
    const span: RuntimeChainSpan = {
      spanId,
      chainId,
      parentSpanId,
      subjectKind: "dispatch",
      subjectId: taskId,
      threadId,
      flowId,
      taskId,
      ...(roleId ? { roleId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.spanStore.put(span);
    return (await this.spanStore.get(spanId)) ?? span;
  }
}

export function buildFlowChainId(flowId: string): string {
  return `flow:${flowId}`;
}

export function buildFlowRootSpanId(flowId: string): string {
  return `flow:${flowId}`;
}

export function buildDispatchSpanId(taskId: string): string {
  return `dispatch:${taskId}`;
}

function buildRuntimeChainEventId(
  chainId: string,
  subjectKind: string,
  subjectId: string,
  recordedAt: number
): string {
  return `${chainId}:${subjectKind}:${subjectId}:${recordedAt}`;
}

function buildRuntimeChainStatusFromFlow(
  flow: FlowLedger,
  rootSpanId: string
): RuntimeChainStatus {
  const activeEdge = findActiveDispatchEdge(flow);
  const latestClosedEdge = findLatestClosedDispatchEdge(flow);
  const waitingReason =
    flow.status === "waiting_role"
      ? flow.nextExpectedRoleId
        ? `waiting for ${flow.nextExpectedRoleId}`
        : flow.activeRoleIds.length > 0
          ? `waiting for ${flow.activeRoleIds[0]}`
          : "waiting for role"
      : flow.status === "waiting_worker"
        ? "waiting for worker"
        : undefined;

  const summary =
    flow.status === "completed"
      ? `Flow ${flow.flowId} completed`
      : flow.status === "failed"
        ? `Flow ${flow.flowId} failed`
        : flow.status === "aborted"
          ? `Flow ${flow.flowId} aborted`
          : flow.status === "waiting_role"
            ? waitingReason ?? `Flow ${flow.flowId} waiting`
            : flow.status === "waiting_worker"
              ? "Flow waiting for worker"
              : flow.hopCount > 0
                ? `Flow ${flow.flowId} running`
                : `Flow ${flow.flowId} created`;

  return {
    chainId: buildFlowChainId(flow.flowId),
    threadId: flow.threadId,
    activeSpanId: activeEdge ? buildDispatchSpanId(extractTaskId(activeEdge.edgeId)) : rootSpanId,
    activeSubjectKind: activeEdge ? "dispatch" : "flow",
    activeSubjectId: activeEdge ? extractTaskId(activeEdge.edgeId) : flow.flowId,
    phase:
      flow.status === "completed"
        ? "resolved"
        : flow.status === "failed"
          ? "failed"
          : flow.status === "aborted"
            ? "cancelled"
            : flow.status === "created"
              ? "started"
              : flow.status === "running"
                ? "heartbeat"
                : "waiting",
    ...(waitingReason ? { waitingReason } : {}),
    latestSummary: summary,
    lastHeartbeatAt: flow.updatedAt,
    ...(flow.status === "running"
      ? { responseTimeoutAt: flow.updatedAt + ACTIVE_RESPONSE_TIMEOUT_MS }
      : flow.status === "waiting_role" || flow.status === "waiting_worker"
        ? { responseTimeoutAt: flow.updatedAt + WAITING_RESPONSE_TIMEOUT_MS }
        : {}),
    ...(latestClosedEdge ? { lastCompletedSpanId: buildDispatchSpanId(extractTaskId(latestClosedEdge.edgeId)) } : {}),
    attention: flow.status === "failed" || flow.status === "aborted",
    updatedAt: flow.updatedAt,
  };
}

function hasMeaningfulStatusChange(
  previous: RuntimeChainStatus | null,
  next: RuntimeChainStatus
): boolean {
  if (!previous) {
    return true;
  }
  return (
    previous.phase !== next.phase ||
    previous.activeSpanId !== next.activeSpanId ||
    previous.latestSummary !== next.latestSummary ||
    previous.waitingReason !== next.waitingReason ||
    previous.attention !== next.attention
  );
}

function mapStatusPhaseToEventPhase(
  phase: RuntimeChainStatus["phase"]
): RuntimeChainPhase {
  if (phase === "resolved") {
    return "completed";
  }
  return phase;
}

function findActiveDispatchEdge(flow: FlowLedger): HandoffEdge | undefined {
  return [...flow.edges]
    .reverse()
    .find((edge) => ["created", "delivered", "acked"].includes(edge.state));
}

function findLatestClosedDispatchEdge(flow: FlowLedger): HandoffEdge | undefined {
  return [...flow.edges]
    .reverse()
    .find((edge) => ["responded", "closed"].includes(edge.state));
}

function extractTaskId(edgeId: string): string {
  return edgeId.endsWith(":edge") ? edgeId.slice(0, -":edge".length) : edgeId;
}
