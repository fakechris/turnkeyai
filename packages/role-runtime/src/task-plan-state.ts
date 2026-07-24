import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import { readToolResultContentText } from "./tool-history-pruning";

const TASK_TOOL_NAMES = new Set([
  "tasks_list",
  "tasks_create",
  "tasks_update",
]);

interface TaskPlanItem {
  id: string;
  n?: number;
  title?: string;
  status?: string;
  agent_id?: string;
  progress?: number;
  blocker?: string;
  output?: string;
  specification?: Record<string, unknown>;
}

export function readTaskPlanState(
  messages: LLMMessage[],
  previousPlanState: string[] = [],
): string[] {
  let items = new Map<string, TaskPlanItem>();
  for (const serialized of previousPlanState) {
    const item = parseTaskPlanItem(serialized);
    if (item) items.set(item.id, item);
  }

  for (const message of messages) {
    if (message.role !== "tool" || !TASK_TOOL_NAMES.has(message.name ?? "")) {
      continue;
    }
    const payload = parseJsonRecord(readToolResultContentText(message.content));
    if (!payload) continue;
    const listed = Array.isArray(payload["tasks"])
      ? payload["tasks"].map(normalizeTaskPlanItem).filter(isTaskPlanItem)
      : [];
    if (listed.length > 0) {
      if (
        typeof payload["total"] === "number" &&
        payload["total"] === payload["showing"]
      ) {
        items = new Map();
      }
      for (const item of listed) items.set(item.id, item);
    }
    const updated = normalizeTaskPlanItem(payload["task"]);
    if (updated) {
      items.set(updated.id, {
        ...(items.get(updated.id) ?? {}),
        ...updated,
      });
    }
  }

  return [...items.values()]
    .sort((left, right) => {
      const leftNumber = left.n ?? Number.MAX_SAFE_INTEGER;
      const rightNumber = right.n ?? Number.MAX_SAFE_INTEGER;
      return leftNumber === rightNumber
        ? left.id.localeCompare(right.id)
        : leftNumber - rightNumber;
    })
    .slice(0, 50)
    .map((item) => JSON.stringify(item));
}

function parseTaskPlanItem(value: string): TaskPlanItem | null {
  const parsed = parseJsonRecord(value);
  return normalizeTaskPlanItem(parsed);
}

function normalizeTaskPlanItem(value: unknown): TaskPlanItem | null {
  if (!isRecord(value) || typeof value["id"] !== "string") return null;
  return {
    id: value["id"],
    ...(typeof value["n"] === "number" ? { n: value["n"] } : {}),
    ...(typeof value["title"] === "string" ? { title: value["title"] } : {}),
    ...(typeof value["status"] === "string" ? { status: value["status"] } : {}),
    ...(typeof value["agent_id"] === "string"
      ? { agent_id: value["agent_id"] }
      : {}),
    ...(typeof value["progress"] === "number"
      ? { progress: value["progress"] }
      : {}),
    ...(typeof value["blocker"] === "string"
      ? { blocker: value["blocker"] }
      : {}),
    ...(typeof value["output"] === "string" && value["output"].length > 0
      ? { output: value["output"] }
      : {}),
    ...(isRecord(value["specification"])
      ? { specification: structuredClone(value["specification"]) }
      : {}),
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isTaskPlanItem(value: TaskPlanItem | null): value is TaskPlanItem {
  return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
