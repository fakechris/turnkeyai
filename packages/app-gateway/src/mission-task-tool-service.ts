import { createHash } from "node:crypto";

import type {
  ActivityEventStore,
  Mission,
  MissionStore,
  VerificationReceipt,
  WorkItem,
  WorkItemSpecification,
  WorkItemStore,
} from "@turnkeyai/core-types/mission";
import type { Clock, IdGenerator } from "@turnkeyai/core-types/team";
import type {
  TaskToolCreateInput,
  TaskToolListInput,
  TaskToolService,
  TaskToolUpdateInput,
} from "@turnkeyai/role-runtime/task-tool-service";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";

import { isOrphanedWorkItemBlocker } from "./mission-work-item-startup-reconcile";

interface MissionTaskToolServiceOptions {
  missionStore: MissionStore;
  workItemStore: WorkItemStore;
  activityStore: ActivityEventStore;
  clock: Clock;
  idGenerator: Pick<IdGenerator, "taskId" | "messageId">;
}

export function createMissionTaskToolService(options: MissionTaskToolServiceOptions): TaskToolService {
  const graphMutex = new KeyedAsyncMutex<string>();
  return {
    async list(input: TaskToolListInput) {
      const mission = await resolveMission(options.missionStore, input);
      const items = await options.workItemStore.listByMission(mission.id);
      const filtered = items
        .filter((item) => !input.status || item.status === input.status)
        .filter((item) => !input.agentId || item.agent === input.agentId)
        .slice(0, input.limit ?? 20);
      return {
        mission_id: mission.id,
        total: items.length,
        showing: filtered.length,
        tasks: filtered.map(serializeWorkItem),
      };
    },

    async create(input: TaskToolCreateInput) {
      const mission = await resolveMission(options.missionStore, input);
      return graphMutex.run(mission.id, async () => {
        const existing = await options.workItemStore.listByMission(mission.id);
        const duplicate = existing.find((item) => normalizeWorkItemTitle(item.title) === normalizeWorkItemTitle(input.title));
        if (duplicate) {
          const orphaned =
            duplicate.status === "blocked" &&
            isOrphanedWorkItemBlocker(duplicate.blocker);
          return {
            mission_id: mission.id,
            task: serializeWorkItem(duplicate),
            deduped: true,
            // A crash-orphaned work item was flipped to `blocked` by the
            // startup reconcile. Surface it as needing re-verification instead
            // of letting the dedup hand it back as if it were live in-flight
            // work (deferred-hardening-plan §4a).
            ...(orphaned
              ? { orphaned: true, note: "orphaned, needs re-verification" }
              : {}),
          };
        }
        const now = options.clock.now();
        const itemId = `wi.${options.idGenerator.taskId()}`;
        const item: WorkItem = {
          id: itemId,
          missionId: mission.id,
          n: nextWorkItemNumber(existing),
          title: input.title,
          agent: input.agentId ?? input.roleId,
          status: input.status ?? "planning",
          started: new Date(now).toISOString(),
          duration: "00:00:00",
          contextRefs: input.contextRefs ?? [],
          output: input.output ?? "",
          ...(hasCreateSpecificationInput(input)
            ? {
                specification: buildSpecification({
                  objective: input.objective?.trim() || input.title,
                  ...(input.inputRefs === undefined
                    ? {}
                    : { inputRefs: input.inputRefs }),
                  ...(input.outputRefs === undefined
                    ? {}
                    : { outputRefs: input.outputRefs }),
                  ...(input.constraints === undefined
                    ? {}
                    : { constraints: input.constraints }),
                  ...(input.blockedBy === undefined
                    ? {}
                    : { blockedBy: input.blockedBy }),
                  ...(input.acceptanceCriteria === undefined
                    ? {}
                    : { acceptanceCriteria: input.acceptanceCriteria }),
                }),
              }
            : {}),
        };
        const graph = appendDependencyEdges(existing, item);
        await persistGraphMutation(options.workItemStore, mission.id, graph, {
          requiresAtomicGraph: (item.specification?.blockedBy.length ?? 0) > 0,
          changedItem: item,
        });
        await appendTaskEvent(options, mission, input.roleId, `Created work item · <b>${item.title}</b>`, item);
        return {
          mission_id: mission.id,
          task: serializeWorkItem(item),
        };
      });
    },

    async update(input: TaskToolUpdateInput) {
      const mission = await resolveMission(options.missionStore, input);
      return graphMutex.run(mission.id, async () => {
        const items = await options.workItemStore.listByMission(mission.id);
        const current = items.find((item) => item.id === input.workItemId);
        if (!current) {
          throw new Error(`work item not found: ${input.workItemId}`);
        }
        if (current.agent && current.agent !== input.roleId) {
          throw new Error(
            `work item update is outside role scope: ${input.workItemId}`,
          );
        }
        const next: WorkItem = structuredClone({
          ...current,
          ...(input.status ? { status: input.status } : {}),
          ...(typeof input.output === "string" ? { output: input.output } : {}),
          ...(typeof input.progress === "number" ? { progress: input.progress } : {}),
        });
        if (input.blocker === null) {
          delete next.blocker;
        } else if (typeof input.blocker === "string") {
          next.blocker = input.blocker;
        }
        if (hasUpdateSpecificationInput(input)) {
          const specification = ensureSpecification(next);
          if (input.objective !== undefined) {
            specification.objective = input.objective.trim();
          }
          if (input.inputRefs !== undefined) {
            specification.inputRefs = uniqueStrings(input.inputRefs);
          }
          if (input.outputRefs !== undefined) {
            specification.outputRefs = uniqueStrings(input.outputRefs);
          }
          if (input.constraints !== undefined) {
            specification.constraints = uniqueStrings(input.constraints);
          }
          if (input.blockedBy !== undefined) {
            specification.blockedBy = uniqueStrings(input.blockedBy);
          }
          applyVerificationUpdates({
            specification,
            acceptanceUpdates: input.acceptanceUpdates ?? [],
            receiptInputs: input.verificationReceipts ?? [],
            actor: input.roleId,
            now: options.clock.now(),
          });
        }
        const graph = replaceDependencyEdges(items, current, next);
        await persistGraphMutation(options.workItemStore, mission.id, graph, {
          requiresAtomicGraph: input.blockedBy !== undefined,
          changedItem: next,
        });
        await appendTaskEvent(options, mission, input.roleId, describeTaskUpdate(current, next), next);
        return {
          mission_id: mission.id,
          task: serializeWorkItem(next),
        };
      });
    },

    async snapshot(input: TaskToolListInput) {
      const mission = await resolveMission(options.missionStore, input);
      const items = await options.workItemStore.listByMission(mission.id);
      return items
        .sort((left, right) => left.n - right.n)
        .slice(0, 50)
        .map((item) => JSON.stringify(serializeWorkItem(item)));
    },
  };
}

async function resolveMission(
  missionStore: MissionStore,
  input: { threadId: string; missionId?: string }
): Promise<Mission> {
  const requested = input.missionId ? await missionStore.get(input.missionId) : null;
  if (requested && requested.threadId !== input.threadId) {
    throw new Error(`mission not found for thread: ${input.missionId}`);
  }
  const mission =
    requested ??
    (missionStore.findByThreadId ? await missionStore.findByThreadId(input.threadId) : null);
  if (!mission) {
    throw new Error("task tools require a mission-linked thread or mission_id");
  }
  return mission;
}

function nextWorkItemNumber(items: WorkItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.n), 0) + 1;
}

function normalizeWorkItemTitle(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hasCreateSpecificationInput(input: TaskToolCreateInput): boolean {
  return input.objective !== undefined ||
    input.inputRefs !== undefined ||
    input.outputRefs !== undefined ||
    input.constraints !== undefined ||
    input.blockedBy !== undefined ||
    input.acceptanceCriteria !== undefined;
}

function hasUpdateSpecificationInput(input: TaskToolUpdateInput): boolean {
  return input.objective !== undefined ||
    input.inputRefs !== undefined ||
    input.outputRefs !== undefined ||
    input.constraints !== undefined ||
    input.blockedBy !== undefined ||
    input.acceptanceUpdates !== undefined ||
    input.verificationReceipts !== undefined;
}

function buildSpecification(input: {
  objective: string;
  inputRefs?: string[];
  outputRefs?: string[];
  constraints?: string[];
  blockedBy?: string[];
  acceptanceCriteria?: TaskToolCreateInput["acceptanceCriteria"];
}): WorkItemSpecification {
  return {
    objective: input.objective,
    inputRefs: uniqueStrings(input.inputRefs ?? []),
    outputRefs: uniqueStrings(input.outputRefs ?? []),
    constraints: uniqueStrings(input.constraints ?? []),
    blockedBy: uniqueStrings(input.blockedBy ?? []),
    blocks: [],
    acceptanceCriteria: (input.acceptanceCriteria ?? []).map(
      (criterion, index) => ({
        id: criterion.id?.trim() || `criterion-${index + 1}`,
        description: criterion.description.trim(),
        required: criterion.required !== false,
        state: "unverified",
      }),
    ),
    verificationReceipts: [],
  };
}

function ensureSpecification(item: WorkItem): WorkItemSpecification {
  item.specification ??= buildSpecification({
    objective: item.title,
    inputRefs: item.contextRefs,
    outputRefs: item.output ? [item.output] : [],
  });
  return item.specification;
}

function appendDependencyEdges(
  items: WorkItem[],
  item: WorkItem,
): WorkItem[] {
  const graph = items.map((candidate) => structuredClone(candidate));
  for (const dependencyId of item.specification?.blockedBy ?? []) {
    const dependency = graph.find((candidate) => candidate.id === dependencyId);
    if (!dependency) {
      throw new Error(`work item dependency not found: ${dependencyId}`);
    }
    const specification = ensureSpecification(dependency);
    specification.blocks = uniqueStrings([...specification.blocks, item.id]);
  }
  return [...graph, item];
}

function replaceDependencyEdges(
  items: WorkItem[],
  current: WorkItem,
  next: WorkItem,
): WorkItem[] {
  const graph = items
    .filter((candidate) => candidate.id !== current.id)
    .map((candidate) => structuredClone(candidate));
  const previousDependencies = current.specification?.blockedBy ?? [];
  const nextDependencies = next.specification?.blockedBy ?? [];
  for (const dependencyId of previousDependencies) {
    const dependency = graph.find((candidate) => candidate.id === dependencyId);
    if (!dependency?.specification) continue;
    dependency.specification.blocks =
      dependency.specification.blocks.filter((id) => id !== current.id);
  }
  for (const dependencyId of nextDependencies) {
    const dependency = graph.find((candidate) => candidate.id === dependencyId);
    if (!dependency) {
      throw new Error(`work item dependency not found: ${dependencyId}`);
    }
    const specification = ensureSpecification(dependency);
    specification.blocks = uniqueStrings([...specification.blocks, next.id]);
  }
  return [...graph, next];
}

function applyVerificationUpdates(input: {
  specification: WorkItemSpecification;
  acceptanceUpdates: NonNullable<TaskToolUpdateInput["acceptanceUpdates"]>;
  receiptInputs: NonNullable<TaskToolUpdateInput["verificationReceipts"]>;
  actor: string;
  now: number;
}): void {
  for (const receiptInput of input.receiptInputs) {
    const receipt: VerificationReceipt = {
      receiptId: deterministicReceiptId(receiptInput),
      criterionId: receiptInput.criterionId,
      kind: receiptInput.kind,
      ref: receiptInput.ref,
      verifier: input.actor,
      result: receiptInput.result,
      verifiedAt: input.now,
      ...(receiptInput.reason ? { reason: receiptInput.reason } : {}),
    };
    const alreadyRecorded = input.specification.verificationReceipts.some(
      (existing) => existing.receiptId === receipt.receiptId,
    );
    if (!alreadyRecorded) {
      input.specification.verificationReceipts.push(receipt);
    }
    const criterion = input.specification.acceptanceCriteria.find(
      (candidate) => candidate.id === receipt.criterionId,
    );
    if (!criterion) {
      throw new Error(
        `verification receipt criterion not found: ${receipt.criterionId}`,
      );
    }
    criterion.state = receipt.result;
  }
  for (const update of input.acceptanceUpdates) {
    const criterion = input.specification.acceptanceCriteria.find(
      (candidate) => candidate.id === update.criterionId,
    );
    if (!criterion) {
      throw new Error(
        `acceptance criterion not found: ${update.criterionId}`,
      );
    }
    criterion.state = update.state;
  }
}

function deterministicReceiptId(input: {
  criterionId: string;
  kind: VerificationReceipt["kind"];
  ref: string;
  result: VerificationReceipt["result"];
}): string {
  const digest = createHash("sha256")
    .update([input.criterionId, input.kind, input.ref, input.result].join("\u0000"))
    .digest("hex");
  return `receipt.${digest.slice(0, 16)}`;
}

async function persistGraphMutation(
  store: WorkItemStore,
  missionId: Mission["id"],
  graph: WorkItem[],
  input: {
    requiresAtomicGraph: boolean;
    changedItem: WorkItem;
  },
): Promise<void> {
  if (store.putGraph) {
    await store.putGraph(missionId, graph);
    return;
  }
  if (input.requiresAtomicGraph) {
    throw new Error(
      "work item store does not support atomic dependency graph updates",
    );
  }
  await store.put(input.changedItem);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function appendTaskEvent(
  options: MissionTaskToolServiceOptions,
  mission: Mission,
  actor: string,
  text: string,
  item: WorkItem
): Promise<void> {
  try {
    await options.activityStore.append({
      id: options.idGenerator.messageId(),
      missionId: mission.id,
      tMs: options.clock.now(),
      kind: "plan",
      actor,
      text,
      tags: ["task", item.status],
      runtime: {
        eventType: "task.update",
        workItemId: item.id,
        status: item.status,
      },
    });
  } catch (error) {
    // The work item mutation is already persisted; failing here would make
    // the tool report an error for a committed change and trigger a
    // duplicating retry. Log and keep the activity append non-fatal.
    console.error("mission task activity append failed", {
      missionId: mission.id,
      workItemId: item.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function describeTaskUpdate(previous: WorkItem, next: WorkItem): string {
  const parts: string[] = [];
  if (previous.status !== next.status) {
    parts.push(`status ${previous.status} → ${next.status}`);
  }
  if (previous.output !== next.output && next.output) {
    parts.push("output updated");
  }
  if (previous.blocker !== next.blocker) {
    parts.push(next.blocker ? "blocker added" : "blocker cleared");
  }
  if (previous.progress !== next.progress && typeof next.progress === "number") {
    parts.push(`progress ${Math.round(next.progress * 100)}%`);
  }
  const suffix = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
  return `Updated work item · <b>${next.title}</b>${suffix}`;
}

function serializeWorkItem(item: WorkItem): Record<string, unknown> {
  return {
    id: item.id,
    n: item.n,
    title: item.title,
    agent_id: item.agent,
    status: item.status,
    output: item.output,
    context_refs: item.contextRefs,
    ...(typeof item.progress === "number" ? { progress: item.progress } : {}),
    ...(item.blocker ? { blocker: item.blocker } : {}),
    ...(item.approvalId ? { approval_id: item.approvalId } : {}),
    ...(item.specification
      ? {
          specification: {
            objective: item.specification.objective,
            input_refs: item.specification.inputRefs,
            output_refs: item.specification.outputRefs,
            constraints: item.specification.constraints,
            blocked_by: item.specification.blockedBy,
            blocks: item.specification.blocks,
            acceptance_criteria: item.specification.acceptanceCriteria.map(
              (criterion) => ({
                id: criterion.id,
                description: criterion.description,
                required: criterion.required,
                state: criterion.state,
              }),
            ),
            verification_receipts: item.specification.verificationReceipts.map(
              (receipt) => ({
                receipt_id: receipt.receiptId,
                criterion_id: receipt.criterionId,
                kind: receipt.kind,
                ref: receipt.ref,
                verifier: receipt.verifier,
                result: receipt.result,
                verified_at: receipt.verifiedAt,
                ...(receipt.reason ? { reason: receipt.reason } : {}),
              }),
            ),
          },
        }
      : {}),
  };
}
