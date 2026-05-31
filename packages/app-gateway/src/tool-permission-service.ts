import type {
  ActivityEventStore,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestStore,
  Mission,
  MissionStore,
} from "@turnkeyai/core-types/mission";
import type {
  Clock,
  PermissionCacheRecord,
  PermissionCacheStore,
  PermissionRequirementLevel,
  PermissionScope,
  WorkerKind,
} from "@turnkeyai/core-types/team";
import type {
  ToolPermissionAppliedInput,
  ToolPermissionAppliedResult,
  ToolPermissionDecisionResult,
  ToolPermissionRequestInput,
  ToolPermissionResultInput,
  ToolPermissionService,
} from "@turnkeyai/role-runtime/tool-permission-service";

interface MissionToolPermissionServiceOptions {
  missionStore: MissionStore & { putRaw(mission: Mission): Promise<void> };
  approvalStore: ApprovalRequestStore;
  activityStore: ActivityEventStore;
  permissionCacheStore: PermissionCacheStore;
  clock: Clock;
  newEventId(): string;
}

export function createMissionToolPermissionService(
  options: MissionToolPermissionServiceOptions
): ToolPermissionService {
  const service: ToolPermissionService = {
    async request(input: ToolPermissionRequestInput) {
      const now = options.clock.now();
      const workerType = input.requirement.workerType ?? "browser";
      const cacheKey =
        input.requirement.cacheKey ??
        derivePermissionCacheKey(input.threadId, workerType, input.requirement.scope, input.requirement.level);
      const cached = await options.permissionCacheStore.get(cacheKey);
      if (cached?.decision === "granted" && (!cached.expiresAt || cached.expiresAt > now)) {
        return {
          status: "already_granted",
          action: input.action,
          requirement: {
            level: cached.requirement.level,
            scope: cached.requirement.scope,
            cacheKey,
            rationale: cached.requirement.rationale,
            workerType: cached.workerType,
          },
          message: `Permission already granted for ${input.action}.`,
        };
      }

      const mission =
        (input.missionId ? await options.missionStore.get(input.missionId) : null) ??
        (options.missionStore.findByThreadId ? await options.missionStore.findByThreadId(input.threadId) : null);
      if (!mission) {
        throw new Error("permission_query requires a mission-linked thread or mission_id");
      }

      const existingPending = await findPendingApprovalByCacheKey({
        approvalStore: options.approvalStore,
        threadId: input.threadId,
        cacheKey,
      });
      if (existingPending) {
        await syncMissionApprovalState({
          missionStore: options.missionStore,
          approvalStore: options.approvalStore,
          missionId: mission.id,
        });
        return {
          status: "pending",
          approvalId: existingPending.id,
          missionId: existingPending.missionId,
          action: existingPending.action,
          requirement: {
            level: input.requirement.level,
            scope: input.requirement.scope,
            cacheKey,
            rationale: input.requirement.rationale,
            workerType,
          },
          message: `Permission request ${existingPending.id} is pending operator decision.`,
        };
      }

      const approvalId = buildApprovalId(input.threadId, input.toolCallId);
      const requirement = {
        level: input.requirement.level,
        scope: input.requirement.scope,
        rationale: input.requirement.rationale,
        cacheKey,
      };
      const approval: ApprovalRequest = {
        id: approvalId,
        severity: severityForRequirement(input.requirement.level, input.requirement.scope),
        missionId: mission.id,
        missionTitle: mission.title,
        agent: input.roleId,
        action: input.action,
        title: input.title,
        affects: input.affects ?? [],
        risk: input.risk,
        requestedAt: new Date(now).toISOString(),
        requestedAtMs: now,
        requestedAgo: "just now",
        policyHint: `${input.requirement.level}:${input.requirement.scope}`,
        payload: {
          ...(input.payload ? { actionPayload: input.payload } : {}),
          toolPermission: {
            threadId: input.threadId,
            roleId: input.roleId,
            roleName: input.roleName,
            toolCallId: input.toolCallId,
            workerType,
            requirement,
          },
        },
      };
      await options.approvalStore.put(approval);
      await syncMissionApprovalState({
        missionStore: options.missionStore,
        approvalStore: options.approvalStore,
        missionId: mission.id,
      });
      await options.activityStore.append({
        id: options.newEventId(),
        missionId: mission.id,
        tMs: now,
        kind: "approval",
        actor: input.roleId,
        text: `Requested approval · <b>${input.action}</b> · ${input.risk}`,
        emph: "warn",
        tags: ["needs_approval", input.requirement.scope],
        approvalId,
        runtime: {
          eventType: "permission.query",
          toolCallId: input.toolCallId,
          cacheKey,
        },
      });

      return {
        status: "pending",
        approvalId,
        missionId: mission.id,
        action: input.action,
        requirement: {
          level: input.requirement.level,
          scope: input.requirement.scope,
          cacheKey,
          rationale: input.requirement.rationale,
          workerType,
        },
        message: `Permission request ${approvalId} is pending operator decision.`,
      };
    },

    async result(input: ToolPermissionResultInput): Promise<ToolPermissionDecisionResult> {
      const approval = await findApproval(options.approvalStore, input.approvalId);
      if (!approval) {
        throw new Error(`approval not found: ${input.approvalId}`);
      }
      const toolPermission = readToolPermissionPayload(approval);
      if (toolPermission?.threadId && toolPermission.threadId !== input.threadId) {
        throw new Error("approval does not belong to this thread");
      }
      const decision = await options.approvalStore.getDecision(input.approvalId);
      if (!decision) {
        return {
          status: "pending",
          approvalId: input.approvalId,
          missionId: approval.missionId,
          action: approval.action,
          message: `Permission request ${input.approvalId} is still pending.`,
        };
      }
      return decisionToResult(approval, decision);
    },

    async waitForDecision(
      input: ToolPermissionResultInput & { timeoutMs: number; pollMs?: number }
    ): Promise<ToolPermissionDecisionResult> {
      const startedAt = options.clock.now();
      const pollMs = Math.max(50, input.pollMs ?? 1_000);
      for (;;) {
        const result = await service.result(input);
        if (result.status !== "pending") {
          return result;
        }
        if (options.clock.now() - startedAt >= input.timeoutMs) {
          return result;
        }
        await sleep(pollMs);
      }
    },

    async apply(input: ToolPermissionAppliedInput): Promise<ToolPermissionAppliedResult> {
      const approval = await findApproval(options.approvalStore, input.approvalId);
      if (!approval) {
        throw new Error(`approval not found: ${input.approvalId}`);
      }
      const toolPermission = readToolPermissionPayload(approval);
      if (!toolPermission) {
        throw new Error("approval is missing tool permission metadata");
      }
      if (toolPermission.threadId !== input.threadId) {
        throw new Error("approval does not belong to this thread");
      }
      const decision = await options.approvalStore.getDecision(input.approvalId);
      if (!decision) {
        return {
          status: "pending",
          approvalId: input.approvalId,
          message: `Permission request ${input.approvalId} is still pending.`,
        };
      }
      if (decision.decision === "denied") {
        return {
          status: "denied",
          approvalId: input.approvalId,
          message: decision.reason ?? `Permission request ${input.approvalId} was denied.`,
        };
      }

      const existing = await options.permissionCacheStore.get(toolPermission.requirement.cacheKey);
      if (
        existing?.decision === "granted" &&
        existing.threadId === toolPermission.threadId &&
        existing.workerType === toolPermission.workerType
      ) {
        return {
          status: "applied",
          approvalId: input.approvalId,
          cacheKey: toolPermission.requirement.cacheKey,
          message: `Permission request ${input.approvalId} already applied.`,
        };
      }

      const now = options.clock.now();
      const record: PermissionCacheRecord = {
        cacheKey: toolPermission.requirement.cacheKey,
        threadId: toolPermission.threadId,
        workerType: toolPermission.workerType,
        requirement: toolPermission.requirement,
        decision: "granted",
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 60 * 60 * 1000,
      };
      await options.permissionCacheStore.put(record);
      await options.activityStore.append({
        id: options.newEventId(),
        missionId: approval.missionId,
        tMs: now,
        kind: "approval",
        actor: approval.agent,
        text: `Applied approval · <b>${approval.action}</b> · runtime permission cache updated.`,
        emph: "success",
        tags: ["approved", "permission.applied"],
        approvalId: input.approvalId,
        runtime: {
          eventType: "permission.applied",
          toolCallId: toolPermission.toolCallId,
          cacheKey: toolPermission.requirement.cacheKey,
        },
      });
      return {
        status: "applied",
        approvalId: input.approvalId,
        cacheKey: toolPermission.requirement.cacheKey,
        message: `Permission request ${input.approvalId} applied.`,
      };
    },
  };
  return service;
}

export async function recordApprovalDecision(input: {
  approvalStore: ApprovalRequestStore & { putDecision(decision: ApprovalDecision): Promise<void> };
  missionStore?: MissionStore & { putRaw(mission: Mission): Promise<void> };
  activityStore: ActivityEventStore;
  clock: Clock;
  newEventId(): string;
  approvalId: string;
  decision: "approved" | "denied";
  decidedBy: string;
  reason?: string;
}): Promise<{ approval: ApprovalRequest; decision: ApprovalDecision }> {
  const approval = await findApproval(input.approvalStore, input.approvalId);
  if (!approval) {
    throw new Error("approval not found");
  }
  const existing = await input.approvalStore.getDecision(input.approvalId);
  if (existing) {
    throw new Error("approval already decided");
  }
  const now = input.clock.now();
  const decision: ApprovalDecision = {
    approvalId: input.approvalId,
    decision: input.decision,
    decidedBy: input.decidedBy,
    decidedAtMs: now,
    ...(input.reason ? { reason: input.reason } : {}),
  };
  await input.approvalStore.putDecision(decision);
  if (input.missionStore) {
    await syncMissionApprovalState({
      missionStore: input.missionStore,
      approvalStore: input.approvalStore,
      missionId: approval.missionId,
    });
  }
  await input.activityStore.append({
    id: input.newEventId(),
    missionId: approval.missionId,
    tMs: now,
    kind: "approval",
    actor: input.decidedBy,
    text: `${input.decision === "approved" ? "Approved" : "Denied"} · <b>${approval.action}</b>`,
    emph: input.decision === "approved" ? "success" : "danger",
    tags: [input.decision, "permission.result"],
    approvalId: input.approvalId,
    runtime: {
      eventType: "permission.result",
      decision: input.decision,
    },
  });
  return { approval, decision };
}

async function syncMissionApprovalState(input: {
  missionStore: MissionStore & { putRaw(mission: Mission): Promise<void> };
  approvalStore: ApprovalRequestStore;
  missionId: string;
}): Promise<void> {
  const { missionStore, approvalStore, missionId } = input;
  const mission = await missionStore.get(missionId);
  if (!mission || mission.status === "archived" || mission.status === "draft") return;
  const [approvals, decisions] = await Promise.all([
    approvalStore.listByMission(missionId),
    approvalStore.listDecisions(),
  ]);
  const decidedIds = new Set(decisions.map((decision) => decision.approvalId));
  const pendingApprovals = approvals.filter(
    (approval) => !decidedIds.has(approval.id)
  ).length;
  if (mission.status === "done" && pendingApprovals === 0) {
    return;
  }
  await missionStore.putRaw({
    ...mission,
    pendingApprovals,
    status:
      pendingApprovals > 0
        ? "needs_approval"
        : mission.blockers > 0
        ? "blocked"
        : "working",
  });
}

function decisionToResult(approval: ApprovalRequest, decision: ApprovalDecision): ToolPermissionDecisionResult {
  return {
    status: decision.decision === "approved" ? "approved" : "denied",
    approvalId: approval.id,
    missionId: approval.missionId,
    action: approval.action,
    decidedBy: decision.decidedBy,
    decidedAtMs: decision.decidedAtMs,
    ...(decision.reason ? { reason: decision.reason } : {}),
    message:
      decision.decision === "approved"
        ? `Permission request ${approval.id} was approved.`
        : decision.reason ?? `Permission request ${approval.id} was denied.`,
  };
}

async function findApproval(store: ApprovalRequestStore, approvalId: string): Promise<ApprovalRequest | null> {
  const approvals = await store.list();
  return approvals.find((approval) => approval.id === approvalId) ?? null;
}

async function findPendingApprovalByCacheKey(input: {
  approvalStore: ApprovalRequestStore;
  threadId: string;
  cacheKey: string;
}): Promise<ApprovalRequest | null> {
  const approvals = await input.approvalStore.list();
  for (const approval of approvals) {
    const toolPermission = readToolPermissionPayload(approval);
    if (toolPermission?.threadId !== input.threadId || toolPermission.requirement.cacheKey !== input.cacheKey) {
      continue;
    }
    const decision = await input.approvalStore.getDecision(approval.id);
    if (!decision) {
      return approval;
    }
  }
  return null;
}

function readToolPermissionPayload(approval: ApprovalRequest):
  | {
      threadId: string;
      roleId: string;
      roleName: string;
      toolCallId: string;
      workerType: WorkerKind;
      requirement: {
        level: PermissionRequirementLevel;
        scope: PermissionScope;
        rationale: string;
        cacheKey: string;
      };
    }
  | null {
  const toolPermission = approval.payload?.toolPermission;
  if (!isRecord(toolPermission) || !isRecord(toolPermission.requirement)) return null;
  const requirement = toolPermission.requirement;
  if (
    typeof toolPermission.threadId !== "string" ||
    typeof toolPermission.roleId !== "string" ||
    typeof toolPermission.roleName !== "string" ||
    typeof toolPermission.toolCallId !== "string" ||
    typeof toolPermission.workerType !== "string" ||
    !isPermissionLevel(requirement.level) ||
    !isPermissionScope(requirement.scope) ||
    typeof requirement.rationale !== "string" ||
    typeof requirement.cacheKey !== "string"
  ) {
    return null;
  }
  return {
    threadId: toolPermission.threadId,
    roleId: toolPermission.roleId,
    roleName: toolPermission.roleName,
    toolCallId: toolPermission.toolCallId,
    workerType: toolPermission.workerType as WorkerKind,
    requirement: {
      level: requirement.level,
      scope: requirement.scope,
      rationale: requirement.rationale,
      cacheKey: requirement.cacheKey,
    },
  };
}

function buildApprovalId(threadId: string, toolCallId: string): string {
  return `ap.${sanitizeIdPart(threadId)}.${sanitizeIdPart(toolCallId)}`;
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80);
}

function derivePermissionCacheKey(
  threadId: string,
  workerType: WorkerKind,
  scope: PermissionScope,
  level: PermissionRequirementLevel
): string {
  return `${threadId}:${workerType}:${scope}:${level}`;
}

function severityForRequirement(level: PermissionRequirementLevel, scope: PermissionScope): "low" | "med" | "high" {
  if (scope === "credential" || scope === "publish") return "high";
  if (level === "approval" || scope === "mutate") return "med";
  return "low";
}

function isPermissionLevel(value: unknown): value is PermissionRequirementLevel {
  return value === "none" || value === "confirm" || value === "approval";
}

function isPermissionScope(value: unknown): value is PermissionScope {
  return value === "read" || value === "navigate" || value === "mutate" || value === "publish" || value === "credential";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
