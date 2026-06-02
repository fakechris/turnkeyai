import type { WorkerExecutionResult, WorkerKind } from "@turnkeyai/core-types/team";

export const SESSION_TOOL_RESULT_PROTOCOL = "turnkeyai.session_tool_result.v1" as const;

export type SessionToolResultStatus = "completed" | "partial" | "failed" | "timeout" | "cancelled";

export interface SessionToolResultV1 {
  protocol: typeof SESSION_TOOL_RESULT_PROTOCOL;
  task_id: string;
  session_key: string;
  agent_id: WorkerKind;
  label?: string;
  parent_session_key?: string;
  tool_call_id?: string;
  status: SessionToolResultStatus;
  cached?: boolean;
  resumable?: boolean;
  timeout_seconds?: number | null;
  evidence_available?: boolean;
  evidence_summary?: string;
  tool_chain: WorkerKind[];
  result: string;
  final_content: string | null;
  payload: unknown;
}

export function buildSessionToolResult(input: {
  taskId: string;
  sessionKey: string;
  agentId: WorkerKind;
  result: WorkerExecutionResult | null;
  missingResultMessage: string;
  cached?: boolean;
  label?: string | null;
  parentSessionKey?: string | null;
  toolCallId?: string | null;
}): SessionToolResultV1 {
  const evidenceSummary = extractWorkerEvidenceSummary(input.result);
  return {
    protocol: SESSION_TOOL_RESULT_PROTOCOL,
    task_id: input.taskId,
    session_key: input.sessionKey,
    agent_id: input.result?.workerType ?? input.agentId,
    ...(input.label ? { label: input.label } : {}),
    ...(input.parentSessionKey ? { parent_session_key: input.parentSessionKey } : {}),
    ...(input.toolCallId ? { tool_call_id: input.toolCallId } : {}),
    status: input.result?.status ?? "failed",
    ...(input.cached ? { cached: true } : {}),
    ...(evidenceSummary ? { evidence_summary: evidenceSummary } : {}),
    tool_chain: input.result ? [input.result.workerType] : [],
    result: input.result?.summary ?? input.missingResultMessage,
    final_content: extractWorkerFinalContent(input.result),
    payload: input.result?.payload ?? null,
  };
}

export function buildSessionToolTimeoutResult(input: {
  taskId: string;
  sessionKey: string;
  agentId: WorkerKind;
  result: string;
  timeoutSeconds: number | null;
  evidenceSummary?: string | null;
  label?: string | null;
  parentSessionKey?: string | null;
  toolCallId?: string | null;
}): SessionToolResultV1 {
  const evidenceSummary = sanitizeEvidenceSummary(input.evidenceSummary);
  return {
    protocol: SESSION_TOOL_RESULT_PROTOCOL,
    task_id: input.taskId,
    session_key: input.sessionKey,
    agent_id: input.agentId,
    ...(input.label ? { label: input.label } : {}),
    ...(input.parentSessionKey ? { parent_session_key: input.parentSessionKey } : {}),
    ...(input.toolCallId ? { tool_call_id: input.toolCallId } : {}),
    status: "timeout",
    timeout_seconds: input.timeoutSeconds,
    resumable: true,
    evidence_available: evidenceSummary != null,
    ...(evidenceSummary ? { evidence_summary: evidenceSummary } : {}),
    tool_chain: [],
    result: input.result,
    final_content: null,
    payload: null,
  };
}

export function buildSessionToolCancelledResult(input: {
  taskId: string;
  sessionKey: string;
  agentId: WorkerKind;
  result: string;
  label?: string | null;
  parentSessionKey?: string | null;
  toolCallId?: string | null;
}): SessionToolResultV1 {
  return {
    protocol: SESSION_TOOL_RESULT_PROTOCOL,
    task_id: input.taskId,
    session_key: input.sessionKey,
    agent_id: input.agentId,
    ...(input.label ? { label: input.label } : {}),
    ...(input.parentSessionKey ? { parent_session_key: input.parentSessionKey } : {}),
    ...(input.toolCallId ? { tool_call_id: input.toolCallId } : {}),
    status: "cancelled",
    resumable: true,
    tool_chain: [],
    result: input.result,
    final_content: null,
    payload: null,
  };
}

export function serializeSessionToolResult(result: SessionToolResultV1): string {
  return JSON.stringify(result, null, 2);
}

export function parseSessionToolResult(content: string): SessionToolResultV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  if (parsed.protocol === SESSION_TOOL_RESULT_PROTOCOL) {
    return normalizeSessionToolResult(parsed);
  }
  if ("protocol" in parsed) {
    return null;
  }
  return normalizeLegacySessionToolResult(parsed);
}

export function extractWorkerFinalContent(result: WorkerExecutionResult | null): string | null {
  if (!result || !result.payload || typeof result.payload !== "object" || Array.isArray(result.payload)) {
    return null;
  }
  const content = (result.payload as Record<string, unknown>).content;
  return typeof content === "string" && content.trim().length > 0 ? content : null;
}

export function extractWorkerEvidenceSummary(result: WorkerExecutionResult | null): string | null {
  if (!result || !result.payload || typeof result.payload !== "object" || Array.isArray(result.payload)) {
    return null;
  }
  const payload = result.payload as Record<string, unknown>;
  const browserProfileFallback = extractBrowserProfileFallbackSummary(payload);
  const browserFailureBuckets = extractBrowserFailureBucketSummary(payload);
  const nestedToolEvidence = extractNestedToolUseEvidenceSummary(payload);
  const page = payload["page"];
  if (page && typeof page === "object" && !Array.isArray(page)) {
    const pageRecord = page as Record<string, unknown>;
    const lines = [
      browserProfileFallback,
      browserFailureBuckets,
      nestedToolEvidence,
      readString(pageRecord["finalUrl"]) ? `Final URL: ${readString(pageRecord["finalUrl"])}` : null,
      readString(pageRecord["title"]) ? `Page title: ${readString(pageRecord["title"])}` : null,
      readString(pageRecord["textExcerpt"]) ? `Excerpt: ${readString(pageRecord["textExcerpt"])}` : null,
    ].filter((line): line is string => Boolean(line));
    const summary = sanitizeEvidenceSummary(lines.join("\n"));
    if (summary) {
      return summary;
    }
  }
  return sanitizeEvidenceSummary(
    [browserProfileFallback, browserFailureBuckets, nestedToolEvidence, readString(payload["content"])]
      .filter(Boolean)
      .join("\n")
  );
}

export function sanitizeEvidenceSummary(value: string | null | undefined): string | null {
  if (!value || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  const buffer = Buffer.from(trimmed, "utf8");
  if (buffer.length <= 1600) {
    return trimmed;
  }
  let end = 1600;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, Math.max(0, end)).toString("utf8");
}

function normalizeSessionToolResult(value: Record<string, unknown>): SessionToolResultV1 | null {
  const taskId = readString(value.task_id);
  const sessionKey = readString(value.session_key);
  const agentId = readString(value.agent_id) as WorkerKind | null;
  const status = readStatus(value.status);
  const result = readString(value.result);
  if (!taskId || !sessionKey || !agentId || !status || !result) {
    return null;
  }
  const toolChain = Array.isArray(value.tool_chain)
    ? value.tool_chain.filter((item): item is WorkerKind => typeof item === "string")
    : [];
  const timeoutSeconds = typeof value.timeout_seconds === "number" ? value.timeout_seconds : null;
  const finalContent = typeof value.final_content === "string" && value.final_content.trim() ? value.final_content : null;
  const evidenceSummary = sanitizeEvidenceSummary(readString(value.evidence_summary));
  const label = readString(value.label);
  const parentSessionKey = readString(value.parent_session_key);
  const toolCallId = readString(value.tool_call_id);
  return {
    protocol: SESSION_TOOL_RESULT_PROTOCOL,
    task_id: taskId,
    session_key: sessionKey,
    agent_id: agentId,
    ...(label ? { label } : {}),
    ...(parentSessionKey ? { parent_session_key: parentSessionKey } : {}),
    ...(toolCallId ? { tool_call_id: toolCallId } : {}),
    status,
    ...(value.cached === true ? { cached: true } : {}),
    ...(value.resumable === true ? { resumable: true } : {}),
    ...(status === "timeout" ? { timeout_seconds: timeoutSeconds } : {}),
    ...(typeof value.evidence_available === "boolean" ? { evidence_available: value.evidence_available } : {}),
    ...(evidenceSummary ? { evidence_summary: evidenceSummary } : {}),
    tool_chain: toolChain,
    result,
    final_content: finalContent,
    payload: "payload" in value ? value.payload : null,
  };
}

function normalizeLegacySessionToolResult(value: Record<string, unknown>): SessionToolResultV1 | null {
  const taskId = readString(value.task_id);
  const sessionKey = readString(value.session_key);
  const agentId = readString(value.agent_id) as WorkerKind | null;
  const status = readStatus(value.status);
  const result = readString(value.result);
  if (!taskId || !sessionKey || !agentId || !status || !result) {
    return null;
  }
  return normalizeSessionToolResult({
    ...value,
    protocol: SESSION_TOOL_RESULT_PROTOCOL,
  });
}

function readStatus(value: unknown): SessionToolResultStatus | null {
  switch (value) {
    case "completed":
    case "partial":
    case "failed":
    case "timeout":
    case "cancelled":
      return value;
    default:
      return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractBrowserProfileFallbackSummary(payload: Record<string, unknown>): string | null {
  const browserRecovery = payload["browserRecovery"];
  if (!isRecord(browserRecovery)) {
    return null;
  }
  const profileFallback = browserRecovery["profileFallback"];
  if (!isRecord(profileFallback)) {
    return null;
  }
  const reason = readString(profileFallback["reason"]);
  const fallbackDir = readString(profileFallback["fallbackDir"]);
  if (reason !== "profile_locked" || !fallbackDir) {
    return null;
  }
  return `Profile fallback: ${reason}; persistent profile was unavailable, used ${fallbackDir}.`;
}

function extractBrowserFailureBucketSummary(payload: Record<string, unknown>): string | null {
  const buckets = [
    ...readFailureBucketRecords(payload["failureBuckets"]),
    ...(isRecord(payload["browserRecovery"]) ? readFailureBucketRecords(payload["browserRecovery"]["failureBuckets"]) : []),
  ];
  if (buckets.length === 0) {
    return null;
  }
  const merged = new Map<string, number>();
  for (const bucket of buckets) {
    merged.set(bucket.bucket, (merged.get(bucket.bucket) ?? 0) + bucket.count);
  }
  const summary = [...merged.entries()]
    .map(([bucket, count]) => `${bucket}=${count}`)
    .sort()
    .join(", ");
  return summary ? `Browser failure buckets: ${summary}.` : null;
}

function readFailureBucketRecords(value: unknown): Array<{ bucket: string; count: number }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) =>
      isRecord(entry) && typeof entry["bucket"] === "string"
        ? {
            bucket: entry["bucket"],
            count: typeof entry["count"] === "number" && Number.isFinite(entry["count"]) ? entry["count"] : 1,
          }
        : null
    )
    .filter((entry): entry is { bucket: string; count: number } => Boolean(entry));
}

function extractNestedToolUseEvidenceSummary(payload: Record<string, unknown>): string | null {
  const metadata = payload["metadata"];
  if (!isRecord(metadata)) {
    return null;
  }
  const toolUse = metadata["toolUse"];
  if (!isRecord(toolUse) || !Array.isArray(toolUse["rounds"])) {
    return null;
  }
  const parts: string[] = [];
  for (const round of toolUse["rounds"]) {
    if (!isRecord(round) || !Array.isArray(round["results"])) {
      continue;
    }
    for (const result of round["results"]) {
      if (!isRecord(result)) {
        continue;
      }
      const toolName = readString(result["toolName"]);
      const content = readString(result["content"]);
      if (!toolName || !content || !isEvidenceBearingNestedTool(toolName)) {
        continue;
      }
      const evidence = extractNestedToolResultEvidence(content);
      if (evidence) {
        parts.push(`${toolName}: ${evidence}`);
      }
    }
  }
  return dedupeStrings(parts).join("\n") || null;
}

function isEvidenceBearingNestedTool(toolName: string): boolean {
  return /^(?:browser_(?:open|snapshot|scroll|console|screenshot)|explore_|finance_)/.test(toolName);
}

function extractNestedToolResultEvidence(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const payload = parsed["payload"];
  const payloadRecord = isRecord(payload) ? payload : null;
  const page = isRecord(payloadRecord?.["page"]) ? payloadRecord["page"] : null;
  const summary = readString(parsed["summary"]);
  const contentText = readString(payloadRecord?.["content"]);
  const pageFinalUrl = page ? readString(page["finalUrl"]) : null;
  const pageTitle = page ? readString(page["title"]) : null;
  const pageExcerpt = page ? readString(page["textExcerpt"]) : null;
  const lines = [
    summary,
    contentText,
    pageFinalUrl ? `Final URL: ${pageFinalUrl}` : null,
    pageTitle ? `Page title: ${pageTitle}` : null,
    pageExcerpt ? `Excerpt: ${pageExcerpt}` : null,
  ].filter((line): line is string => Boolean(line));
  return sanitizeEvidenceSummary(dedupeStrings(lines).join("\n"));
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
