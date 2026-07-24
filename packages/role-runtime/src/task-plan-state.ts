import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import { readToolResultContentText } from "./tool-history-pruning";

const TASK_TOOL_NAMES = new Set([
  "tasks_list",
  "tasks_create",
  "tasks_update",
]);
export const MAX_SERIALIZED_TASK_SPECIFICATION_CHARS = 8_192;
const MAX_TASK_SPECIFICATION_FIELD_CHARS = 1_500;
const MAX_TASK_SPECIFICATION_CONTAINER_ITEMS = 50;
const MAX_TASK_SPECIFICATION_DEPTH = 6;

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
      ? { specification: boundTaskSpecification(value["specification"]) }
      : {}),
  };
}

function boundTaskSpecification(
  specification: Record<string, unknown>,
): Record<string, unknown> {
  const entries = Object.entries(specification)
    .slice(0, MAX_TASK_SPECIFICATION_CONTAINER_ITEMS)
    .sort((left, right) =>
      specificationFieldPriority(left[0]) -
        specificationFieldPriority(right[0])
    );
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const keyJson = JSON.stringify(key);
    const currentLength = JSON.stringify(bounded).length;
    const commaLength = Object.keys(bounded).length > 0 ? 1 : 0;
    const remaining =
      MAX_SERIALIZED_TASK_SPECIFICATION_CHARS -
      currentLength -
      commaLength -
      keyJson.length -
      1;
    if (remaining < 4) continue;
    const candidate = boundJsonValue(
      value,
      Math.min(remaining, MAX_TASK_SPECIFICATION_FIELD_CHARS),
      1,
    );
    const next = { ...bounded, [key]: candidate };
    if (
      JSON.stringify(next).length <=
        MAX_SERIALIZED_TASK_SPECIFICATION_CHARS
    ) {
      bounded[key] = candidate;
    }
  }
  return bounded;
}

function boundJsonValue(
  value: unknown,
  budget: number,
  depth: number,
): unknown {
  if (depth >= MAX_TASK_SPECIFICATION_DEPTH) {
    return Array.isArray(value) ? [] : isRecord(value) ? {} : null;
  }
  if (typeof value === "string") {
    if (JSON.stringify(value).length <= budget) return value;
    let low = 0;
    let high = Math.min(value.length, MAX_TASK_SPECIFICATION_FIELD_CHARS);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = `${value.slice(0, middle)}…`;
      if (JSON.stringify(candidate).length <= budget) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low > 0 ? `${value.slice(0, low)}…` : "";
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    const serialized = JSON.stringify(value);
    return serialized.length <= budget ? value : null;
  }
  if (Array.isArray(value)) {
    const bounded: unknown[] = [];
    for (
      const item of value.slice(0, MAX_TASK_SPECIFICATION_CONTAINER_ITEMS)
    ) {
      const currentLength = JSON.stringify(bounded).length;
      const commaLength = bounded.length > 0 ? 1 : 0;
      const remaining = budget - currentLength - commaLength;
      if (remaining < 4) break;
      const candidate = boundJsonValue(item, remaining, depth + 1);
      const next = [...bounded, candidate];
      if (JSON.stringify(next).length > budget) break;
      bounded.push(candidate);
    }
    return bounded;
  }
  if (isRecord(value)) {
    const bounded: Record<string, unknown> = {};
    for (
      const [key, item] of Object.entries(value)
        .slice(0, MAX_TASK_SPECIFICATION_CONTAINER_ITEMS)
    ) {
      const keyJson = JSON.stringify(key);
      const currentLength = JSON.stringify(bounded).length;
      const commaLength = Object.keys(bounded).length > 0 ? 1 : 0;
      const remaining =
        budget - currentLength - commaLength - keyJson.length - 1;
      if (remaining < 4) continue;
      const candidate = boundJsonValue(item, remaining, depth + 1);
      const next = { ...bounded, [key]: candidate };
      if (JSON.stringify(next).length <= budget) {
        bounded[key] = candidate;
      }
    }
    return bounded;
  }
  return null;
}

function specificationFieldPriority(key: string): number {
  switch (key) {
    case "objective":
      return 0;
    case "acceptance_criteria":
    case "acceptanceCriteria":
      return 1;
    case "verification_receipts":
    case "verificationReceipts":
      return 2;
    case "constraints":
      return 3;
    case "blocked_by":
    case "blockedBy":
    case "blocks":
      return 4;
    case "input_refs":
    case "inputRefs":
    case "output_refs":
    case "outputRefs":
      return 5;
    default:
      return 6;
  }
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
