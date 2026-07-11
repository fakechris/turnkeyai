import type { WorkerKind } from "@turnkeyai/core-types/team";

export const BACKGROUND_WORKER_SESSION_PROTOCOL =
  "turnkeyai.background_worker_session.v1" as const;

export interface BackgroundWorkerSessionAcceptedV1 {
  protocol: typeof BACKGROUND_WORKER_SESSION_PROTOCOL;
  version: 1;
  task_id: string;
  session_key: string;
  agent_id: WorkerKind;
  status: "running";
  label: string;
  tool_call_id: string;
  accepted_at: number;
  deadline_at: number;
}

export function buildBackgroundWorkerSessionAccepted(input: {
  taskId: string;
  sessionKey: string;
  agentId: WorkerKind;
  label: string;
  toolCallId: string;
  acceptedAt: number;
  deadlineAt: number;
}): BackgroundWorkerSessionAcceptedV1 {
  return {
    protocol: BACKGROUND_WORKER_SESSION_PROTOCOL,
    version: 1,
    task_id: input.taskId,
    session_key: input.sessionKey,
    agent_id: input.agentId,
    status: "running",
    label: input.label,
    tool_call_id: input.toolCallId,
    accepted_at: input.acceptedAt,
    deadline_at: input.deadlineAt,
  };
}

export function serializeBackgroundWorkerSessionAccepted(
  value: BackgroundWorkerSessionAcceptedV1,
): string {
  return JSON.stringify(value, null, 2);
}

export function parseBackgroundWorkerSessionAccepted(
  value: string,
): BackgroundWorkerSessionAcceptedV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const taskId = readString(parsed["task_id"]);
  const sessionKey = readString(parsed["session_key"]);
  const agentId = readString(parsed["agent_id"]) as WorkerKind | null;
  const label = readString(parsed["label"]);
  const toolCallId = readString(parsed["tool_call_id"]);
  const acceptedAt = readFiniteNumber(parsed["accepted_at"]);
  const deadlineAt = readFiniteNumber(parsed["deadline_at"]);
  if (
    parsed["protocol"] !== BACKGROUND_WORKER_SESSION_PROTOCOL ||
    parsed["version"] !== 1 ||
    parsed["status"] !== "running" ||
    !taskId ||
    !sessionKey ||
    !agentId ||
    !label ||
    !toolCallId ||
    acceptedAt === null ||
    deadlineAt === null ||
    deadlineAt < acceptedAt
  ) {
    return null;
  }
  return {
    protocol: BACKGROUND_WORKER_SESSION_PROTOCOL,
    version: 1,
    task_id: taskId,
    session_key: sessionKey,
    agent_id: agentId,
    status: "running",
    label,
    tool_call_id: toolCallId,
    accepted_at: acceptedAt,
    deadline_at: deadlineAt,
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
