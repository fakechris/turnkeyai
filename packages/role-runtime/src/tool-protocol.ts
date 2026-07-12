import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";
import type { ToolProgressEvent, ToolResult } from "@turnkeyai/agent-core/tool";
import { MAX_BROWSER_OPEN_TIMEOUT_MS } from "@turnkeyai/core-types/team";

import type {
  NativeToolProgressTrace,
  NativeToolResultTrace,
} from "./native-tool-messages";
import { parseSessionToolResult } from "./session-tool-result-protocol";

export const SESSION_TOOL_RESULT_PROTOCOL = "turnkeyai.session_tool_result.v1";

export function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

export function containsAnyToolCallForm(result: {
  text: string;
  toolCalls?: readonly LLMToolCall[];
}): boolean {
  if ((result.toolCalls?.length ?? 0) > 0) {
    return true;
  }
  return /<\s*(?:minimax:)?tool_call\b|<\s*invoke\b|<\/\s*(?:minimax:)?tool_call\s*>|\btool_calls?\s*[:=]/i.test(
    result.text,
  );
}

export function readSessionKeyFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const raw = (input as Record<string, unknown>)["session_key"];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function sliceUtf8(value: string, maxBytes: number): string {
  // gemini + coderabbit K3.6: keep the persisted slice strictly
  // <= maxBytes. The earlier version appended an "…[truncated]"
  // suffix AFTER slicing, blowing the byte budget by 14 bytes.
  // The trace already carries a `contentTruncated: true` flag so
  // the UI knows to label it — no need to encode "truncated" in
  // the bytes themselves.
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  // Step back if the last byte is a continuation byte (10xxxxxx)
  // until we land on a codepoint boundary.
  let end = maxBytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function readMessageContentText(content: LLMMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && "text" in block) return String(block.text);
        if (block.type === "tool_result" && "content" in block)
          return String(block.content);
      }
      return "";
    })
    .join("\n");
}

export function isControlPlaneToolResultName(
  toolName: string | undefined,
): boolean {
  return (
    toolName === "sessions_list" ||
    toolName === "sessions_history" ||
    toolName === "memory_search" ||
    toolName === "permission_query" ||
    toolName === "permission_result" ||
    toolName === "permission_applied"
  );
}

type ParsedSessionToolResult = NonNullable<
  ReturnType<typeof parseSessionToolResult>
>;

export function sessionToolResultHasUsableEvidence(
  result: ParsedSessionToolResult,
): boolean {
  if (result.status === "completed") {
    return Boolean(
      result.evidence_summary?.trim() ||
        result.final_content?.trim() ||
        result.result.trim(),
    );
  }
  if (result.status === "partial" || result.status === "timeout") {
    return Boolean(
      result.evidence_available === true ||
        result.evidence_summary?.trim() ||
        result.final_content?.trim(),
    );
  }
  return false;
}

export function nativeToolResultTraceHasUsableEvidence(
  result: NativeToolResultTrace,
): boolean {
  if (
    result.isError ||
    result.cancelled ||
    result.skipped
  ) {
    return false;
  }
  const content = result.content?.trim() ?? "";
  if (!content) {
    return false;
  }
  const parsedSession = parseSessionToolResult(content);
  if (parsedSession) {
    return sessionToolResultHasUsableEvidence(parsedSession);
  }
  return !isControlPlaneToolResultName(result.toolName);
}

export function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  const error = new Error("operation aborted");
  error.name = "AbortError";
  throw error;
}

export function llmMessageContentToText(content: LLMMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "tool_result") {
        return block.content;
      }
      if (block.type === "tool_use") {
        return JSON.stringify({ name: block.name, input: block.input });
      }
      return "";
    })
    .join("\n");
}

export function buildContinuationDirectiveContext(
  taskPrompt: string,
  messages: LLMMessage[],
): string {
  const toolEvidence = messages
    .filter((message) => message.role === "tool")
    .map((message) => llmMessageContentToText(message.content))
    .filter(
      (content) =>
        content.includes("session_key") || content.includes('"sessions"'),
    )
    .join("\n");
  return toolEvidence ? `${taskPrompt}\n${toolEvidence}` : taskPrompt;
}

export function readPolicyWorkerKindFromSessionKey(sessionKey: unknown): string | null {
  if (typeof sessionKey !== "string") {
    return null;
  }
  const match = sessionKey.match(/^worker:([A-Za-z0-9_-]+):task(?::|-)/);
  return match?.[1] ?? null;
}

export const SESSION_SEND_ALIAS_NAMES = new Set([
  "session_continue",
  "session_resume",
  "session_update",
  "sessions_continue",
  "sessions_resume",
  "sessions_update",
]);

export function normalizeSessionToolAliasCalls(
  toolCalls: LLMToolCall[],
): LLMToolCall[] {
  return toolCalls.map((call) => {
    if (!SESSION_SEND_ALIAS_NAMES.has(call.name)) {
      return call;
    }
    const sessionKey =
      readStringInput(call.input, "session_key") ??
      readStringInput(call.input, "session") ??
      readStringInput(call.input, "session_id") ??
      readStringInput(call.input, "worker_session") ??
      readStringInput(call.input, "worker_session_key");
    const message =
      readStringInput(call.input, "message") ??
      readStringInput(call.input, "task") ??
      readStringInput(call.input, "instruction") ??
      readStringInput(call.input, "instructions") ??
      readStringInput(call.input, "update") ??
      readStringInput(call.input, "content") ??
      readStringInput(call.input, "query");
    return {
      ...call,
      name: "sessions_send",
      input: {
        ...call.input,
        ...(sessionKey ? { session_key: sessionKey } : {}),
        ...(message ? { message } : {}),
        mode: "continue",
      },
    };
  });
}

export function normalizeSessionToolCalls(
  toolCalls: LLMToolCall[],
  sessionContext = "",
  declaredContinuationWorkerRunKey?: string,
): LLMToolCall[] {
  const knownSessionKeys = extractKnownWorkerSessionKeys(sessionContext);
  return toolCalls.map((call) => {
    if (call.name !== "sessions_send" && call.name !== "sessions_history") {
      return call;
    }
    if (call.name === "sessions_send" && declaredContinuationWorkerRunKey) {
      return {
        ...call,
        input: {
          ...call.input,
          session_key: declaredContinuationWorkerRunKey,
          mode: "continue",
        },
      };
    }
    const sessionKey = readStringInput(call.input, "session_key");
    const extractedSessionKey = sessionKey
      ? extractWorkerSessionKey(sessionKey)
      : undefined;
    const normalizedSessionKey = extractedSessionKey
      ? resolveKnownWorkerSessionKey(extractedSessionKey, knownSessionKeys)
      : undefined;
    if (!normalizedSessionKey || normalizedSessionKey === sessionKey) {
      return call;
    }
    return {
      ...call,
      input: {
        ...call.input,
        session_key: normalizedSessionKey,
      },
    };
  });
}

export function normalizeUrlForComparison(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

export function readStringInput(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function extractHttpUrls(text: string): string[] {
  return Array.from(text.matchAll(/\bhttps?:\/\/[^\s"'`<>]+/gi))
    .map((match) => trimHttpUrlCandidate(match[0] ?? ""))
    .filter(Boolean);
}

export function trimHttpUrlCandidate(candidate: string): string {
  let value = candidate.trim();
  while (value) {
    try {
      new URL(value);
      return value;
    } catch {
      const next = value.replace(/[)\],;.!?。，“”‘’！？：:]$/g, "");
      if (next === value) {
        return value;
      }
      value = next;
    }
  }
  return value;
}

export function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHostname(hostname) || normalized.endsWith(".local")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isPrivateOrLoopbackHostname(normalized.slice("::ffff:".length));
  }
  if (
    /^(?:fc|fd)[0-9a-f]{2}:/i.test(normalized) ||
    /^fe[89ab][0-9a-f]:/i.test(normalized)
  ) {
    return true;
  }
  const parts = normalized.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
    return false;
  }
  const numbers = parts.map((part) => Number(part));
  if (
    numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const a = numbers[0]!;
  const b = numbers[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackHostname(normalized.slice("::ffff:".length));
  }
  const parts = normalized.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
    return false;
  }
  const numbers = parts.map((part) => Number(part));
  return (
    numbers.every(
      (part) => Number.isInteger(part) && part >= 0 && part <= 255,
    ) && numbers[0] === 127
  );
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

// PR K3.6: byte cap for the per-result content slice we persist in tool traces.
// Generous enough to capture a full HTML snapshot of a typical page, small
// enough that a chain of long-running browser sessions doesn't bloat metadata.
// The full content still flows through the LLM tool loop in memory.
export const ROLE_TOOL_RESULT_TRACE_CAP_BYTES = 8 * 1024;

export function toNativeToolResultTrace(
  toolResult: ToolResult,
): NativeToolResultTrace {
  const bytes = Buffer.byteLength(toolResult.content, "utf8");
  const traceContent = compactToolResultTraceContent(toolResult.content);
  const traceBytes = Buffer.byteLength(traceContent.content, "utf8");
  const truncated = traceBytes > ROLE_TOOL_RESULT_TRACE_CAP_BYTES;
  return {
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    isError: toolResult.isError === true,
    contentBytes: bytes,
    content: truncated
      ? sliceUtf8(traceContent.content, ROLE_TOOL_RESULT_TRACE_CAP_BYTES)
      : traceContent.content,
    ...(truncated || traceContent.compacted ? { contentTruncated: true } : {}),
    ...(toolResult.cancelled ? { cancelled: true } : {}),
    ...(toolResult.skipped ? { skipped: true } : {}),
  };
}

export function compactToolResultTraceContent(content: string): {
  content: string;
  compacted: boolean;
} {
  const parsed = parseSessionToolResult(content);
  if (!parsed) {
    return { content, compacted: false };
  }
  const compacted = {
    protocol: parsed.protocol,
    status: parsed.status,
    agent_id: parsed.agent_id,
    ...(parsed.label ? { label: parsed.label } : {}),
    session_key: parsed.session_key,
    task_id: parsed.task_id,
    ...(parsed.parent_session_key
      ? { parent_session_key: parsed.parent_session_key }
      : {}),
    ...(parsed.tool_call_id ? { tool_call_id: parsed.tool_call_id } : {}),
    ...(parsed.resumable ? { resumable: parsed.resumable } : {}),
    ...(parsed.timeout_seconds == null
      ? {}
      : { timeout_seconds: parsed.timeout_seconds }),
    ...(parsed.evidence_available == null
      ? {}
      : { evidence_available: parsed.evidence_available }),
    tool_chain: parsed.tool_chain,
    ...compactSessionPayloadReferences(parsed.payload),
    ...compactSessionPayloadEvidenceExcerpt(parsed.payload),
    ...(typeof parsed.evidence_summary === "string"
      ? { evidence_summary: sliceUtf8(parsed.evidence_summary, 1024) }
      : {}),
    final_content:
      typeof parsed.final_content === "string"
        ? sliceUtf8(parsed.final_content, 3 * 1024)
        : null,
    result:
      typeof parsed.result === "string" ? sliceUtf8(parsed.result, 1024) : "",
  };
  const compactContent = fitCompactToolResultTraceContent(compacted);
  return {
    content: compactContent,
    compacted: compactContent !== content,
  };
}

export function fitCompactToolResultTraceContent(
  input: Record<string, unknown>,
): string {
  const compacted = { ...input };
  const serialize = () => JSON.stringify(compacted, null, 2);
  const fits = (value: string) =>
    Buffer.byteLength(value, "utf8") <= ROLE_TOOL_RESULT_TRACE_CAP_BYTES;
  const trySerialize = () => {
    const value = serialize();
    return fits(value) ? value : null;
  };

  const initial = trySerialize();
  if (initial) return initial;

  const shrinkStringField = (field: string, maxBytes: number) => {
    const value = compacted[field];
    if (typeof value === "string") {
      compacted[field] = maxBytes > 0 ? sliceUtf8(value, maxBytes) : "";
    }
  };
  const deleteField = (field: string) => {
    delete compacted[field];
  };
  const prunePayload = (
    field: "screenshotPaths" | "artifactIds",
    limit: number,
  ) => {
    const payload = compacted.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }
    const record = payload as Record<string, unknown>;
    const values = readStringArray(record[field]);
    if (values.length > limit) {
      record[field] = values.slice(0, limit);
      record[`${field}Truncated`] = true;
      record[`${field}Count`] = values.length;
    }
  };

  const steps: Array<() => void> = [
    () => shrinkStringField("final_content", 2048),
    () => shrinkStringField("result", 768),
    () => shrinkStringField("evidence_summary", 512),
    () => shrinkStringField("evidence_excerpt", 512),
    () => shrinkStringField("final_content", 1024),
    () => shrinkStringField("result", 384),
    () => deleteField("evidence_summary"),
    () => deleteField("evidence_excerpt"),
    () => shrinkStringField("final_content", 512),
    () => shrinkStringField("result", 0),
    () => {
      compacted.final_content = null;
    },
    () => prunePayload("screenshotPaths", 4),
    () => prunePayload("artifactIds", 16),
  ];

  for (const step of steps) {
    step();
    const value = trySerialize();
    if (value) return value;
  }

  const minimal = {
    protocol: compacted.protocol,
    status: compacted.status,
    agent_id: compacted.agent_id,
    session_key: compacted.session_key,
    task_id: compacted.task_id,
    tool_chain: compacted.tool_chain,
    payload: compacted.payload,
    result: "session tool result compacted",
    final_content: null,
  };
  const minimalContent = JSON.stringify(minimal, null, 2);
  if (fits(minimalContent)) return minimalContent;
  return JSON.stringify({
    protocol: compacted.protocol,
    status: compacted.status,
    result: "session tool result compacted",
  });
}

export function compactSessionPayloadEvidenceExcerpt(
  payload: unknown,
): { evidence_excerpt: string } | Record<string, never> {
  const evidence = readPayloadEvidenceExcerpt(payload);
  return evidence ? { evidence_excerpt: sliceUtf8(evidence, 2 * 1024) } : {};
}

export function compactSessionPayloadArtifactRefs(
  payload: unknown,
):
  | { payload: { artifactIds?: string[]; screenshotPaths?: string[] } }
  | Record<string, never> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  const artifactIds = readStringArray(record.artifactIds);
  const screenshotPaths = readStringArray(record.screenshotPaths);
  if (artifactIds.length === 0 && screenshotPaths.length === 0) {
    return {};
  }
  return {
    payload: {
      ...(artifactIds.length ? { artifactIds } : {}),
      ...(screenshotPaths.length ? { screenshotPaths } : {}),
    },
  };
}

function compactSessionPayloadReferences(
  payload: unknown,
):
  | {
      payload: {
        artifactIds?: string[];
        screenshotPaths?: string[];
        sourceResults?: Array<Record<string, unknown>>;
        sourceResultsCount?: number;
        sourceResultsTruncated?: boolean;
        pages?: Array<Record<string, unknown>>;
        pagesCount?: number;
        pagesTruncated?: boolean;
      };
    }
  | Record<string, never> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  const compacted: {
    artifactIds?: string[];
    screenshotPaths?: string[];
    sourceResults?: Array<Record<string, unknown>>;
    sourceResultsCount?: number;
    sourceResultsTruncated?: boolean;
    pages?: Array<Record<string, unknown>>;
    pagesCount?: number;
    pagesTruncated?: boolean;
  } = {};
  const artifactIds = readStringArray(record.artifactIds);
  const screenshotPaths = readStringArray(record.screenshotPaths);
  if (artifactIds.length > 0) compacted.artifactIds = artifactIds;
  if (screenshotPaths.length > 0) compacted.screenshotPaths = screenshotPaths;

  const sourceResults = compactPayloadSourceResults(record.sourceResults);
  if (sourceResults.values.length > 0) {
    compacted.sourceResults = sourceResults.values;
    if (sourceResults.total > sourceResults.values.length) {
      compacted.sourceResultsCount = sourceResults.total;
      compacted.sourceResultsTruncated = true;
    }
  } else {
    const pages = readPayloadEvidencePages(record)
      .map(compactPayloadEvidencePage)
      .filter((page): page is Record<string, unknown> => page !== null);
    if (pages.length > 0) {
      compacted.pages = pages.slice(0, 8);
      if (pages.length > compacted.pages.length) {
        compacted.pagesCount = pages.length;
        compacted.pagesTruncated = true;
      }
    }
  }
  return Object.keys(compacted).length > 0 ? { payload: compacted } : {};
}

function compactPayloadSourceResults(value: unknown): {
  values: Array<Record<string, unknown>>;
  total: number;
} {
  if (!Array.isArray(value)) {
    return { values: [], total: 0 };
  }
  const values = value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const url = readStringField(record.url);
      const label = readStringField(record.label);
      const status = readStringField(record.status);
      const page = compactPayloadEvidencePage(record.page);
      if (!url && !label && !status && !page) {
        return null;
      }
      return {
        ...(url ? { url: sliceUtf8(url, 512) } : {}),
        ...(label ? { label: sliceUtf8(label, 256) } : {}),
        ...(status ? { status: sliceUtf8(status, 64) } : {}),
        ...(page ? { page } : {}),
      };
    })
    .filter((item): item is Record<string, unknown> => item !== null);
  return { values: values.slice(0, 8), total: values.length };
}

function compactPayloadEvidencePage(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const requestedUrl = readStringField(record.requestedUrl);
  const finalUrl = readStringField(record.finalUrl);
  const title = readStringField(record.title);
  const statusCode =
    typeof record.statusCode === "number" && Number.isFinite(record.statusCode)
      ? record.statusCode
      : null;
  if (!requestedUrl && !finalUrl && !title && statusCode === null) {
    return null;
  }
  return {
    ...(requestedUrl ? { requestedUrl: sliceUtf8(requestedUrl, 512) } : {}),
    ...(finalUrl ? { finalUrl: sliceUtf8(finalUrl, 512) } : {}),
    ...(title ? { title: sliceUtf8(title, 256) } : {}),
    ...(statusCode === null ? {} : { statusCode }),
  };
}

export function readPayloadEvidenceExcerpt(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const pages = readPayloadEvidencePages(record);
  const pageParts = pages.flatMap((page) => [
    readStringField(page.finalUrl),
    readStringField(page.title),
    readStringField(page.textExcerpt),
  ]);
  const parts = [
    ...pageParts,
    readStringField(record.content),
  ]
    .filter((part): part is string => Boolean(part))
    .map((part) => part.trim());
  const joined = dedupeStrings(parts).join("\n");
  return joined || null;
}

export function readPayloadEvidencePages(
  record: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const pages: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const addPage = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const page = value as Record<string, unknown>;
    const key =
      readStringField(page.finalUrl) ??
      readStringField(page.requestedUrl) ??
      JSON.stringify(page).slice(0, 120);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    pages.push(page);
  };
  if (Array.isArray(record.pages)) {
    for (const page of record.pages) {
      addPage(page);
    }
  }
  if (Array.isArray(record.sourceResults)) {
    for (const sourceResult of record.sourceResults) {
      if (
        !sourceResult ||
        typeof sourceResult !== "object" ||
        Array.isArray(sourceResult)
      ) {
        continue;
      }
      addPage((sourceResult as Record<string, unknown>).page);
    }
  }
  addPage(record.page);
  return pages;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
    .map((item) => item.trim());
}

export function toNativeToolProgressTrace(
  call: LLMToolCall,
  progress: ToolProgressEvent,
  ts: number,
): NativeToolProgressTrace {
  return {
    toolCallId: call.id,
    toolName: progress.toolName || call.name,
    phase: progress.phase,
    summary: progress.summary,
    ...(progress.detail ? { detail: progress.detail } : {}),
    ts,
  };
}

/**
 * The per-turn tool-call-cap "skipped" result.
 * Shared by the inline executor and engine budget admission so both paths emit a
 * byte-identical `tool_call_limit_exceeded` result + progress detail for an
 * over-cap call.
 */
export function buildToolCallLimitExceededResult(
  call: LLMToolCall,
  maxToolCallsPerRound: number,
  requestedToolCalls: number,
): ToolResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    content: `tool_call_limit_exceeded: skipped ${call.name}; at most ${maxToolCallsPerRound} tool calls may be executed in one assistant turn.`,
    isError: true,
    skipped: true,
    progress: [
      {
        phase: "failed",
        toolName: call.name,
        summary: `Skipped ${call.name}: per-turn tool call limit exceeded.`,
        detail: {
          admission: "skipped",
          reason: "max_tool_calls_per_round",
          max_tool_calls_per_round: maxToolCallsPerRound,
          requested_tool_calls: requestedToolCalls,
        },
      },
    ],
  };
}

export function withFinalToolRoundWarning(
  messages: LLMMessage[],
  input: { active: boolean; round: number; maxRounds: number },
): LLMMessage[] {
  if (!input.active) {
    return messages;
  }
  if (!Number.isFinite(input.maxRounds) || input.maxRounds <= 0) {
    return messages;
  }
  const finalAllowedRound = Math.max(0, Math.floor(input.maxRounds) - 1);
  if (input.round !== finalAllowedRound) {
    return messages;
  }
  return [
    ...messages,
    {
      role: "user",
      content: [
        `Runtime notice: this is the final allowed tool-use round (${Math.floor(input.maxRounds)}).`,
        "If you already have enough evidence, answer now without calling tools.",
        "If you call tools now, use only the highest-value calls needed to finish.",
        "After these tool results return, produce the final answer from the gathered evidence instead of asking for more tools.",
        "If the evidence is still incomplete, mark missing items as not verified and give the next user/operator action.",
      ].join("\n"),
    },
  ];
}

export function resolveEffectiveToolLoopWallClockMs(input: {
  maxWallClockMs?: number;
}): number | undefined {
  const maxWallClockMs = input.maxWallClockMs;
  const configured =
    typeof maxWallClockMs === "number" &&
    Number.isFinite(maxWallClockMs) &&
    maxWallClockMs > 0
      ? Math.floor(maxWallClockMs)
      : undefined;
  return configured;
}

export function createToolExecutionSignal(input: {
  parentSignal?: AbortSignal;
  maxWallClockMs?: number;
  elapsedMs: number;
}): { signal?: AbortSignal; dispose(): void } {
  const maxWallClockMs = input.maxWallClockMs;
  const hasWallClockBudget =
    typeof maxWallClockMs === "number" &&
    Number.isFinite(maxWallClockMs) &&
    maxWallClockMs > 0;
  if (!hasWallClockBudget) {
    return {
      ...(input.parentSignal ? { signal: input.parentSignal } : {}),
      dispose() {},
    };
  }

  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let parentAbortHandler: (() => void) | null = null;
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  if (input.parentSignal?.aborted) {
    abort(input.parentSignal.reason ?? "operation aborted");
  } else if (input.parentSignal) {
    parentAbortHandler = () =>
      abort(input.parentSignal?.reason ?? "operation aborted");
    input.parentSignal.addEventListener("abort", parentAbortHandler, {
      once: true,
    });
  }

  const remainingMs = Math.max(0, Math.ceil(maxWallClockMs - input.elapsedMs));
  timeoutHandle = setTimeout(
    () =>
      abort(
        `Tool-use wall-clock budget reached (${formatDurationMs(maxWallClockMs)}).`,
      ),
    remainingMs,
  );

  return {
    signal: controller.signal,
    dispose() {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (parentAbortHandler && input.parentSignal) {
        input.parentSignal.removeEventListener("abort", parentAbortHandler);
      }
    },
  };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function formatDurationMs(ms: number): string {
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return `${Number(seconds.toFixed(3))}s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${Number(minutes.toFixed(2))}m`;
  }
  const hours = minutes / 60;
  return `${Number(hours.toFixed(2))}h`;
}

export function readStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function extractWorkerSessionKey(value: string): string | undefined {
  return value.match(/\bworker:[A-Za-z0-9_-]+:task(?::|-)[^\s"'`,|}\]]+/)?.[0];
}

export function extractKnownWorkerSessionKeys(context: string): string[] {
  const matches =
    context.match(/\bworker:[A-Za-z0-9_-]+:task(?::|-)[^\s"'`,|}\]]+/g) ?? [];
  return [...new Set(matches)];
}

export function resolveKnownWorkerSessionKey(
  sessionKey: string,
  knownSessionKeys: string[],
): string {
  if (knownSessionKeys.includes(sessionKey)) {
    return sessionKey;
  }
  const sessionSignature = relaxedSessionKeySignature(sessionKey);
  const matches = knownSessionKeys.filter(
    (candidate) => relaxedSessionKeySignature(candidate) === sessionSignature,
  );
  if (matches.length === 1) {
    return matches[0]!;
  }
  const truncatedPrefix = readTruncatedSessionKeyPrefix(sessionSignature);
  if (truncatedPrefix) {
    const prefixMatches = knownSessionKeys.filter((candidate) =>
      relaxedSessionKeySignature(candidate).startsWith(truncatedPrefix),
    );
    if (prefixMatches.length === 1) {
      return prefixMatches[0]!;
    }
  }
  return sessionKey;
}

export function relaxedSessionKeySignature(sessionKey: string): string {
  return sessionKey
    .replace(/call_function_/g, "call_")
    .replace(/call_func_/g, "call_")
    .replace(/call_funct(?:ion)?(?=…|\.{3})/g, "call_")
    .replace(/call_func(?=…|\.{3})/g, "call_");
}

export function readTruncatedSessionKeyPrefix(sessionKey: string): string | null {
  const ellipsisIndex = sessionKey.search(/…|\.\.\./);
  if (ellipsisIndex < 0) {
    return null;
  }
  const prefix = sessionKey.slice(0, ellipsisIndex);
  return prefix.length >= 24 ? prefix : null;
}
