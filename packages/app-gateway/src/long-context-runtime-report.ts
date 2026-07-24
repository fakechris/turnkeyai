import type {
  ContextCheckpointRecord,
  ContextCheckpointScope,
  ContextCheckpointStore,
} from "@turnkeyai/core-types/context-checkpoint";
import type {
  DynamicContextBaseline,
  DynamicContextBaselineStore,
} from "@turnkeyai/core-types/dynamic-context-baseline";
import type {
  MemorySearchIndex,
  PermissionCacheRecord,
  RuntimeProgressEvent,
  TeamMessage,
  TeamThread,
  WorkerSessionRecord,
  WorkspaceMemoryStore,
} from "@turnkeyai/core-types/team";
import { buildPromptConsoleReport } from "@turnkeyai/qc-runtime/prompt-inspection";
import {
  DEFAULT_PROMPT_SECTION_REGISTRY,
  PROMPT_REGISTRY_PROTOCOL,
  auditDefaultPromptRegistry,
} from "@turnkeyai/role-runtime/prompt-registry";

export const LONG_CONTEXT_RUNTIME_REPORT_PROTOCOL =
  "turnkeyai.long_context_runtime_report.v1" as const;

const MAX_SESSION_NODES = 200;
const MAX_EFFECT_RECORDS = 200;

interface LongContextReportDeps {
  now(): number;
  teamThreadStore: {
    get(threadId: string): Promise<TeamThread | null>;
  };
  flowLedgerStore: {
    listByThread(threadId: string): Promise<Array<{ flowId: string }>>;
  };
  teamMessageStore: {
    list(threadId: string): Promise<TeamMessage[]>;
  };
  runtimeProgressStore: {
    listByThread(threadId: string): Promise<RuntimeProgressEvent[]>;
  };
  workerSessionStore: {
    listByThread(threadId: string): Promise<WorkerSessionRecord[]>;
  };
  permissionCacheStore: {
    listByThread(threadId: string): Promise<PermissionCacheRecord[]>;
  };
  contextCheckpointStore: ContextCheckpointStore;
  dynamicContextBaselineStore: DynamicContextBaselineStore;
  workspaceMemoryStore: WorkspaceMemoryStore;
  memorySearchIndex: MemorySearchIndex;
  activeToolPromptSectionIds: string[];
  taskSnapshotProvider?: (input: {
    threadId: string;
    roleId: string;
  }) => Promise<string[]>;
}

export interface LongContextRuntimeReport {
  protocol: typeof LONG_CONTEXT_RUNTIME_REPORT_PROTOCOL;
  threadId: string;
  generatedAt: number;
  promptRegistry: {
    protocol: typeof PROMPT_REGISTRY_PROTOCOL;
    audit: ReturnType<typeof auditDefaultPromptRegistry>;
    activeToolSectionIds: string[];
    definitions: ReturnType<
      typeof DEFAULT_PROMPT_SECTION_REGISTRY.definitions
    >;
  };
  promptRuntime: ReturnType<typeof buildPromptConsoleReport>;
  scopes: Array<{
    scope: ContextCheckpointScope;
    checkpoint: ReturnType<typeof projectCheckpoint> | null;
    dynamicContext: ReturnType<typeof projectBaseline> | null;
  }>;
  memory: {
    recordCount: number;
    planeCounts: Record<string, number>;
    cursor: {
      lastSequence: number;
      lastEventId?: string;
      updatedAt: number;
    };
    latestAudits: Array<{
      auditId: string;
      trigger: string;
      status: string;
      sourceEventCount: number;
      mutationCount: number;
      rejectedMutationCount: number;
      startedAt: number;
      completedAt: number;
      error?: string;
    }>;
    index: Awaited<ReturnType<NonNullable<MemorySearchIndex["diagnostics"]>>> | null;
  };
  sessions: {
    total: number;
    activeCount: number;
    truncated?: boolean;
    nodes: Array<{
      workerRunKey: string;
      workerType: string;
      status: string;
      updatedAt: number;
      executionToken: number;
      flowId?: string;
      taskId?: string;
      roleId?: string;
      parentSessionKey?: string;
      background?: boolean;
      deadlineAt?: number;
      lastResultStatus?: string;
    }>;
  };
  governance: {
    permissionCount: number;
    pendingApprovalCount: number;
    pendingApprovals: Array<{
      cacheKey: string;
      workerType: string;
      scope: string;
      level: string;
      updatedAt: number;
      expiresAt?: number;
      rationale: string;
    }>;
  };
  effects: {
    journalCount: number;
    statusCounts: Record<string, number>;
    indeterminateCount: number;
    truncated?: boolean;
    records: Array<{
      runKey: string;
      taskId: string;
      journalStatus: string;
      effectId: string;
      toolName: string;
      round: number;
      status: string;
      hasReceipt: boolean;
      updatedAt: number;
    }>;
  };
  tasks: {
    authority: "work-item-store" | "unavailable";
    itemCount: number;
    dependencyEdgeCount: number;
    criterionStateCounts: Record<string, number>;
    receiptCount: number;
    items: Record<string, unknown>[];
    error?: string;
  };
  attention: string[];
}

export async function buildLongContextRuntimeReport(
  deps: LongContextReportDeps,
  threadId: string,
): Promise<LongContextRuntimeReport | null> {
  const thread = await deps.teamThreadStore.get(threadId);
  if (!thread) return null;
  const [flows, memory, progressEvents, sessions, permissions, messages] =
    await Promise.all([
    deps.flowLedgerStore.listByThread(threadId),
    deps.workspaceMemoryStore.getSnapshot(threadId),
    deps.runtimeProgressStore.listByThread(threadId),
    deps.workerSessionStore.listByThread(threadId),
    deps.permissionCacheStore.listByThread(threadId),
    deps.teamMessageStore.list(threadId),
  ]);

  const scopes = flows
    .flatMap((flow) =>
      thread.roles.map((role) => ({
        threadId,
        roleId: role.roleId,
        flowId: flow.flowId,
      }))
    )
    .slice(-64);
  const scopeReports = await Promise.all(
    scopes.map(async (scope) => {
      const [checkpoint, baseline] = await Promise.all([
        deps.contextCheckpointStore.getActive(scope),
        deps.dynamicContextBaselineStore.get(scope),
      ]);
      return {
        scope,
        checkpoint: checkpoint ? projectCheckpoint(checkpoint) : null,
        dynamicContext: baseline ? projectBaseline(baseline) : null,
      };
    }),
  );

  const taskReport = await buildTaskReport(
    deps.taskSnapshotProvider,
    threadId,
    thread.leadRoleId,
  );
  const index = deps.memorySearchIndex.diagnostics
    ? await deps.memorySearchIndex.diagnostics({
        workspaceId: threadId,
        threadId,
      })
    : null;
  const planeCounts: Record<string, number> = {};
  for (const record of memory.records) {
    planeCounts[record.plane] = (planeCounts[record.plane] ?? 0) + 1;
  }
  const promptAudit = auditDefaultPromptRegistry();
  const promptRuntime = buildPromptConsoleReport(progressEvents, 20);
  const sessionReport = buildSessionReport(sessions);
  const governanceReport = buildGovernanceReport(permissions);
  const effectReport = buildEffectReport(messages);
  const latestAudits = memory.audits.slice(-20).reverse().map((audit) => ({
    auditId: audit.auditId,
    trigger: audit.trigger,
    status: audit.status,
    sourceEventCount: audit.sourceEventIds.length,
    mutationCount: audit.mutations.length,
    rejectedMutationCount: audit.rejectedMutations.length,
    startedAt: audit.startedAt,
    completedAt: audit.completedAt,
    ...(audit.error ? { error: audit.error } : {}),
  }));
  const attention: string[] = [];
  if (!promptAudit.valid) {
    attention.push("prompt_registry_invalid");
  }
  if (latestAudits.some((audit) => audit.status === "failed")) {
    attention.push("workspace_memory_writer_failed");
  }
  if (index && index.indexedRecords !== memory.records.length) {
    attention.push("memory_index_snapshot_drift");
  }
  if (taskReport.error) {
    attention.push("authoritative_task_snapshot_unavailable");
  }
  if (promptRuntime.latestBoundaries[0]?.tokenEstimate?.overBudget) {
    attention.push("prompt_context_over_budget");
  }
  if (governanceReport.pendingApprovalCount > 0) {
    attention.push("pending_approval");
  }
  if (effectReport.indeterminateCount > 0) {
    attention.push("indeterminate_effect");
  }
  if (
    sessionReport.nodes.some(
      (session) =>
        !session.flowId &&
        !["done", "failed", "cancelled"].includes(session.status),
    )
  ) {
    attention.push("active_session_missing_context");
  }
  for (const item of taskReport.items) {
    if (item["status"] === "blocked") {
      attention.push(`task_blocked:${String(item["id"] ?? "unknown")}`);
    }
  }
  for (const scope of scopeReports) {
    if (scope.checkpoint && !scope.dynamicContext) {
      attention.push(
        `dynamic_context_baseline_missing:${scope.scope.flowId}:${scope.scope.roleId}`,
      );
    }
  }

  return {
    protocol: LONG_CONTEXT_RUNTIME_REPORT_PROTOCOL,
    threadId,
    generatedAt: deps.now(),
    promptRegistry: {
      protocol: PROMPT_REGISTRY_PROTOCOL,
      audit: promptAudit,
      activeToolSectionIds: [...deps.activeToolPromptSectionIds].sort(),
      definitions: DEFAULT_PROMPT_SECTION_REGISTRY.definitions(),
    },
    promptRuntime,
    scopes: scopeReports,
    memory: {
      recordCount: memory.records.length,
      planeCounts,
      cursor: structuredClone(memory.cursor),
      latestAudits,
      index,
    },
    sessions: sessionReport,
    governance: governanceReport,
    effects: effectReport,
    tasks: taskReport,
    attention: [...new Set(attention)].sort(),
  };
}

function buildSessionReport(
  sessions: WorkerSessionRecord[],
): LongContextRuntimeReport["sessions"] {
  const nodes = sessions
    .map((session) => ({
      workerRunKey: session.workerRunKey,
      workerType: session.state.workerType,
      status: session.state.status,
      updatedAt: session.state.updatedAt,
      executionToken: session.executionToken,
      ...(session.context?.flowId ? { flowId: session.context.flowId } : {}),
      ...(session.context?.taskId ? { taskId: session.context.taskId } : {}),
      ...(session.context?.roleId ? { roleId: session.context.roleId } : {}),
      ...(session.context?.parentSessionKey
        ? { parentSessionKey: session.context.parentSessionKey }
        : {}),
      ...(session.context?.background !== undefined
        ? { background: session.context.background }
        : {}),
      ...(session.context?.deadlineAt !== undefined
        ? { deadlineAt: session.context.deadlineAt }
        : {}),
      ...(session.state.lastResult?.status
        ? { lastResultStatus: session.state.lastResult.status }
        : {}),
    }))
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        left.workerRunKey.localeCompare(right.workerRunKey),
    );
  return {
    total: nodes.length,
    activeCount: nodes.filter(
      (session) =>
        !["done", "failed", "cancelled"].includes(session.status),
    ).length,
    ...(nodes.length > MAX_SESSION_NODES ? { truncated: true } : {}),
    nodes: nodes.slice(0, MAX_SESSION_NODES),
  };
}

function buildGovernanceReport(
  permissions: PermissionCacheRecord[],
): LongContextRuntimeReport["governance"] {
  const pendingApprovals = permissions
    .filter((permission) => permission.decision === "prompt_required")
    .map((permission) => ({
      cacheKey: permission.cacheKey,
      workerType: permission.workerType,
      scope: permission.requirement.scope,
      level: permission.requirement.level,
      updatedAt: permission.updatedAt,
      ...(permission.expiresAt !== undefined
        ? { expiresAt: permission.expiresAt }
        : {}),
      rationale: permission.requirement.rationale,
    }))
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        left.cacheKey.localeCompare(right.cacheKey),
    );
  return {
    permissionCount: permissions.length,
    pendingApprovalCount: pendingApprovals.length,
    pendingApprovals,
  };
}

function buildEffectReport(
  messages: TeamMessage[],
): LongContextRuntimeReport["effects"] {
  const records: LongContextRuntimeReport["effects"]["records"] = [];
  let journalCount = 0;
  for (const message of messages) {
    const journal = isRecord(message.metadata?.["runJournal"])
      ? message.metadata["runJournal"]
      : null;
    if (
      message.metadata?.["runtimeRunJournal"] !== true ||
      !journal ||
      typeof journal["runKey"] !== "string" ||
      typeof journal["taskId"] !== "string"
    ) {
      continue;
    }
    journalCount += 1;
    const ledger = isRecord(journal["effectLedger"])
      ? journal["effectLedger"]
      : null;
    for (const effect of Array.isArray(ledger?.["records"])
      ? ledger["records"]
      : []) {
      if (
        !isRecord(effect) ||
        typeof effect["effectId"] !== "string" ||
        typeof effect["round"] !== "number" ||
        typeof effect["status"] !== "string" ||
        !isRecord(effect["call"]) ||
        typeof effect["call"]["name"] !== "string"
      ) {
        continue;
      }
      records.push({
        runKey: journal["runKey"],
        taskId: journal["taskId"],
        journalStatus:
          typeof journal["status"] === "string"
            ? journal["status"]
            : "unknown",
        effectId: effect["effectId"],
        toolName: effect["call"]["name"],
        round: effect["round"],
        status: effect["status"],
        hasReceipt: effect["result"] !== undefined,
        updatedAt:
          typeof journal["updatedAt"] === "number"
            ? journal["updatedAt"]
            : message.updatedAt,
      });
    }
  }
  records.sort(
    (left, right) =>
      right.updatedAt - left.updatedAt ||
      left.effectId.localeCompare(right.effectId),
  );
  const statusCounts: Record<string, number> = {};
  for (const effect of records) {
    statusCounts[effect.status] = (statusCounts[effect.status] ?? 0) + 1;
  }
  return {
    journalCount,
    statusCounts,
    indeterminateCount: statusCounts["indeterminate"] ?? 0,
    ...(records.length > MAX_EFFECT_RECORDS ? { truncated: true } : {}),
    records: records.slice(0, MAX_EFFECT_RECORDS),
  };
}

function projectCheckpoint(record: ContextCheckpointRecord) {
  return {
    checkpointId: record.checkpointId,
    version: record.version,
    state: record.state,
    compactedAtRound: record.compactedAtRound,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    source: structuredClone(record.source),
    task: {
      rootGoal: record.task.rootGoal,
      planItemCount: record.task.planState.length,
      openQuestions: record.task.openQuestions,
      nextActions: record.task.nextActions,
    },
    workingSet: structuredClone(record.workingSet),
    ...(record.dynamicContext
      ? { dynamicContext: structuredClone(record.dynamicContext) }
      : {}),
    ...(record.execution
      ? { execution: structuredClone(record.execution) }
      : {}),
  };
}

function projectBaseline(baseline: DynamicContextBaseline) {
  return {
    baselineId: baseline.baselineId,
    promptPackVersion: baseline.promptPackVersion,
    modelFingerprint: baseline.modelFingerprint,
    toolFingerprint: baseline.toolFingerprint,
    activatedAt: baseline.activatedAt,
    sections: baseline.sections.map((section) => ({
      name: section.name,
      version: section.version,
      digest: section.digest,
      sourceRefs: section.sourceRefs,
      packedTokens: section.packedTokens,
      omitted: section.omitted,
      updatedAt: section.updatedAt,
    })),
  };
}

async function buildTaskReport(
  provider: LongContextReportDeps["taskSnapshotProvider"],
  threadId: string,
  roleId: string,
): Promise<LongContextRuntimeReport["tasks"]> {
  if (!provider) {
    return {
      authority: "unavailable",
      itemCount: 0,
      dependencyEdgeCount: 0,
      criterionStateCounts: {},
      receiptCount: 0,
      items: [],
      error: "task snapshot provider is not configured",
    };
  }
  try {
    const serialized = await provider({ threadId, roleId });
    const items = serialized
      .map(parseRecord)
      .filter((item): item is Record<string, unknown> => item !== null);
    const criterionStateCounts: Record<string, number> = {};
    let dependencyEdgeCount = 0;
    let receiptCount = 0;
    for (const item of items) {
      const specification = isRecord(item["specification"])
        ? item["specification"]
        : null;
      if (!specification) continue;
      dependencyEdgeCount += readArray(
        specification,
        "blocked_by",
        "blockedBy",
      ).length;
      for (const criterion of readArray(
        specification,
        "acceptance_criteria",
        "acceptanceCriteria",
      )) {
        if (!isRecord(criterion) || typeof criterion["state"] !== "string") {
          continue;
        }
        criterionStateCounts[criterion["state"]] =
          (criterionStateCounts[criterion["state"]] ?? 0) + 1;
      }
      receiptCount += readArray(
        specification,
        "verification_receipts",
        "verificationReceipts",
      ).length;
    }
    return {
      authority: "work-item-store",
      itemCount: items.length,
      dependencyEdgeCount,
      criterionStateCounts,
      receiptCount,
      items,
    };
  } catch (error) {
    return {
      authority: "unavailable",
      itemCount: 0,
      dependencyEdgeCount: 0,
      criterionStateCounts: {},
      receiptCount: 0,
      items: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readArray(
  record: Record<string, unknown>,
  primaryKey: string,
  compatibilityKey: string,
): unknown[] {
  const primary = record[primaryKey];
  if (Array.isArray(primary)) return primary;
  const compatibility = record[compatibilityKey];
  return Array.isArray(compatibility) ? compatibility : [];
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
}
