import type { WorkerSessionHistoryEntry, WorkerSessionState } from "@turnkeyai/core-types/team";

export function readWorkerSessionTranscript(
  sessionKey: string,
  state: WorkerSessionState
): WorkerSessionHistoryEntry[] {
  if (state.history && state.history.length > 0) {
    return state.history;
  }
  return state.lastResult ? [createLegacyWorkerHistoryEntry(sessionKey, state)] : [];
}

export function countWorkerSessionTranscriptMessages(
  sessionKey: string,
  state: WorkerSessionState
): number {
  return readWorkerSessionTranscript(sessionKey, state).length;
}

export function summarizeWorkerSessionEvidence(state: WorkerSessionState | null): string | null {
  if (!state) {
    return null;
  }
  const transcript = readWorkerSessionTranscript(state.workerRunKey, state);
  const latestEvidence = [...transcript].reverse().find((entry) => isEvidenceEntry(entry));
  return latestEvidence?.content.trim() || state.continuationDigest?.summary || state.lastResult?.summary || null;
}

export function serializeWorkerHistoryEntry(
  entry: WorkerSessionHistoryEntry,
  includePayload: boolean
): Record<string, unknown> {
  return {
    id: entry.id,
    role: entry.role,
    content: entry.content,
    created_at: entry.createdAt,
    ...(entry.taskId ? { task_id: entry.taskId } : {}),
    ...(entry.toolCallId ? { tool_call_id: entry.toolCallId } : {}),
    ...(entry.toolName ? { name: entry.toolName } : {}),
    ...(entry.status ? { status: entry.status } : {}),
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
    ...(includePayload && "payload" in entry ? { payload: entry.payload } : {}),
  };
}

function createLegacyWorkerHistoryEntry(
  sessionKey: string,
  state: WorkerSessionState
): WorkerSessionHistoryEntry {
  return {
    id: `worker-history:${sessionKey}:legacy-result`,
    role: "tool",
    toolName: state.workerType,
    status: state.lastResult!.status,
    content: state.lastResult!.summary,
    payload: state.lastResult!.payload,
    createdAt: state.updatedAt,
    ...(state.currentTaskId ? { taskId: state.currentTaskId } : {}),
  };
}

function isEvidenceEntry(entry: WorkerSessionHistoryEntry): boolean {
  if (entry.role !== "assistant" && entry.role !== "tool") {
    return false;
  }
  if (entry.status === "failed" || entry.status === "cancelled" || entry.status === "interrupted") {
    return false;
  }
  return entry.content.trim().length > 0;
}
