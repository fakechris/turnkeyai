import type {
  ActivityEventStore,
  Mission,
  MissionStore,
  WorkItem,
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

interface MissionTaskToolServiceOptions {
  missionStore: MissionStore;
  workItemStore: WorkItemStore;
  activityStore: ActivityEventStore;
  clock: Clock;
  idGenerator: Pick<IdGenerator, "taskId" | "messageId">;
}

export function createMissionTaskToolService(options: MissionTaskToolServiceOptions): TaskToolService {
  const createMutex = new KeyedAsyncMutex<string>();
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
      return createMutex.run(mission.id, async () => {
        const existing = await options.workItemStore.listByMission(mission.id);
        const duplicate = existing.find((item) => normalizeWorkItemTitle(item.title) === normalizeWorkItemTitle(input.title));
        if (duplicate) {
          return {
            mission_id: mission.id,
            task: serializeWorkItem(duplicate),
            deduped: true,
          };
        }
        const now = options.clock.now();
        const item: WorkItem = {
          id: `wi.${options.idGenerator.taskId()}`,
          missionId: mission.id,
          n: nextWorkItemNumber(existing),
          title: input.title,
          agent: input.agentId ?? input.roleId,
          status: input.status ?? "planning",
          started: new Date(now).toISOString(),
          duration: "00:00:00",
          contextRefs: input.contextRefs ?? [],
          output: input.output ?? "",
        };
        await options.workItemStore.put(item);
        await appendTaskEvent(options, mission, input.roleId, `Created work item · <b>${item.title}</b>`, item);
        return {
          mission_id: mission.id,
          task: serializeWorkItem(item),
        };
      });
    },

    async update(input: TaskToolUpdateInput) {
      const mission = await resolveMission(options.missionStore, input);
      const items = await options.workItemStore.listByMission(mission.id);
      const current = items.find((item) => item.id === input.workItemId);
      if (!current) {
        throw new Error(`work item not found: ${input.workItemId}`);
      }
      const next: WorkItem = {
        ...current,
        ...(input.status ? { status: input.status } : {}),
        ...(typeof input.output === "string" ? { output: input.output } : {}),
        ...(typeof input.progress === "number" ? { progress: input.progress } : {}),
      };
      if (input.blocker === null) {
        delete next.blocker;
      } else if (typeof input.blocker === "string") {
        next.blocker = input.blocker;
      }
      await options.workItemStore.put(next);
      await appendTaskEvent(options, mission, input.roleId, describeTaskUpdate(current, next), next);
      return {
        mission_id: mission.id,
        task: serializeWorkItem(next),
      };
    },
  };
}

async function resolveMission(
  missionStore: MissionStore,
  input: { threadId: string; missionId?: string }
): Promise<Mission> {
  const mission =
    (input.missionId ? await missionStore.get(input.missionId) : null) ??
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

async function appendTaskEvent(
  options: MissionTaskToolServiceOptions,
  mission: Mission,
  actor: string,
  text: string,
  item: WorkItem
): Promise<void> {
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
  };
}
