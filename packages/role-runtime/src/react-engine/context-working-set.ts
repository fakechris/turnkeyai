import {
  emptyContextCheckpointWorkingSet,
  type ContextApprovalReceipt,
  type ContextCheckpointWorkingSet,
  type ContextFileReceipt,
  type ContextImageReceipt,
  type ContextSessionReceipt,
  type ContextSkillReceipt,
} from "@turnkeyai/core-types/context-checkpoint";
import type {
  LLMContentBlock,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";

export interface ContextWorkingSetLimits {
  maxFiles: number;
  maxSkills: number;
  maxArtifacts: number;
  maxSessions: number;
  maxApprovals: number;
  maxImages: number;
}

export const DEFAULT_CONTEXT_WORKING_SET_LIMITS: ContextWorkingSetLimits = {
  maxFiles: 5,
  maxSkills: 3,
  maxArtifacts: 20,
  maxSessions: 20,
  maxApprovals: 20,
  maxImages: 2,
};

export type ContextWorkingSetProvider = (
  messages: LLMMessage[],
) => Promise<ContextCheckpointWorkingSet> | ContextCheckpointWorkingSet;

/**
 * Extracts only typed references already present in the transcript. It does not
 * read files, query sessions, poll approvals, or perform any other effect.
 */
export function captureContextWorkingSetFromMessages(
  messages: LLMMessage[],
  overrides: Partial<ContextWorkingSetLimits> = {},
): ContextCheckpointWorkingSet {
  const limits = normalizeLimits({
    ...DEFAULT_CONTEXT_WORKING_SET_LIMITS,
    ...overrides,
  });
  const workingSet = emptyContextCheckpointWorkingSet();

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      captureAssistantBlocks(message.content, workingSet);
    }
    for (const value of structuredValues(message.content)) {
      captureStructuredValue(value, workingSet);
    }
    if (typeof message.content === "string") {
      for (const artifactId of artifactUris(message.content)) {
        workingSet.artifacts.push(artifactId);
      }
    }
  }

  return {
    files: takeTail(
      dedupeBy(workingSet.files, (item) =>
        `${item.path}:${item.startLine ?? ""}:${item.endLine ?? ""}`,
      ),
      limits.maxFiles,
    ),
    skills: takeTail(
      dedupeBy(workingSet.skills, (item) => item.skillId),
      limits.maxSkills,
    ),
    artifacts: takeTail(
      [...new Set(workingSet.artifacts)],
      limits.maxArtifacts,
    ),
    sessions: takeTail(
      dedupeBy(
        workingSet.sessions,
        (item) => item.sessionKey,
      ),
      limits.maxSessions,
    ),
    approvals: takeTail(
      dedupeBy(
        workingSet.approvals,
        (item) => item.approvalId,
      ),
      limits.maxApprovals,
    ),
    images: takeTail(
      dedupeBy(workingSet.images, (item) => item.artifactId),
      limits.maxImages,
    ),
  };
}

function captureAssistantBlocks(
  blocks: LLMContentBlock[],
  workingSet: ContextCheckpointWorkingSet,
): void {
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const name = block.name.toLowerCase();
    if (isFileReadTool(name)) {
      const path = readString(block.input, ["path", "file", "file_path"]);
      if (path) {
        const startLine = readInteger(block.input, [
          "start_line",
          "startLine",
        ]);
        const endLine = readInteger(block.input, ["end_line", "endLine"]);
        workingSet.files.push({
          path,
          ...(startLine === undefined ? {} : { startLine }),
          ...(endLine === undefined ? {} : { endLine }),
        });
      }
    }
    const skillId = readString(block.input, ["skill_id", "skillId"]);
    if (skillId) workingSet.skills.push({ skillId });
  }
}

function captureStructuredValue(
  value: unknown,
  workingSet: ContextCheckpointWorkingSet,
): void {
  if (Array.isArray(value)) {
    for (const item of value) captureStructuredValue(item, workingSet);
    return;
  }
  if (!isRecord(value)) return;

  captureSession(value, workingSet.sessions);
  captureApproval(value, workingSet.approvals);
  captureArtifacts(value, workingSet);
  captureFile(value, workingSet.files);
  captureSkill(value, workingSet.skills);

  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) {
      captureStructuredValue(child, workingSet);
    }
  }
}

function captureSession(
  value: Record<string, unknown>,
  sessions: ContextSessionReceipt[],
): void {
  const sessionKey = readString(value, ["session_key", "sessionKey"]);
  if (!sessionKey) return;
  const status = readString(value, ["status"]);
  const resumable = readBoolean(value, ["resumable"]);
  const evidenceAvailable = readBoolean(value, [
    "evidence_available",
    "evidenceAvailable",
  ]);
  sessions.push({
    sessionKey,
    ...(status ? { status } : {}),
    ...(resumable === undefined ? {} : { resumable }),
    ...(evidenceAvailable === undefined ? {} : { evidenceAvailable }),
  });
}

function captureApproval(
  value: Record<string, unknown>,
  approvals: ContextApprovalReceipt[],
): void {
  const approvalId = readString(value, ["approval_id", "approvalId"]);
  if (!approvalId) return;
  const rawState =
    readString(value, [
      "approval_state",
      "approvalState",
      "decision",
      "status",
    ]) ?? "unknown";
  approvals.push({
    approvalId,
    state: normalizeApprovalState(rawState),
  });
}

function captureArtifacts(
  value: Record<string, unknown>,
  workingSet: ContextCheckpointWorkingSet,
): void {
  for (const key of ["artifact_id", "artifactId"] as const) {
    const artifactId = value[key];
    if (typeof artifactId === "string" && artifactId.trim()) {
      workingSet.artifacts.push(artifactId);
      if (isImageRecord(value)) {
        workingSet.images.push({ artifactId });
      }
    }
  }
  for (const key of ["artifact_ids", "artifactIds"] as const) {
    const artifactIds = value[key];
    if (!Array.isArray(artifactIds)) continue;
    for (const artifactId of artifactIds) {
      if (typeof artifactId === "string" && artifactId.trim()) {
        workingSet.artifacts.push(artifactId);
      }
    }
  }
}

function captureFile(
  value: Record<string, unknown>,
  files: ContextFileReceipt[],
): void {
  const path = readString(value, ["file_path", "filePath"]);
  if (!path) return;
  const digest = readString(value, ["sha256", "digest"]);
  const startLine = readInteger(value, ["start_line", "startLine"]);
  const endLine = readInteger(value, ["end_line", "endLine"]);
  files.push({
    path,
    ...(digest ? { digest } : {}),
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  });
}

function captureSkill(
  value: Record<string, unknown>,
  skills: ContextSkillReceipt[],
): void {
  const skillId = readString(value, ["skill_id", "skillId"]);
  if (!skillId) return;
  const version = readString(value, [
    "skill_version",
    "skillVersion",
    "version",
  ]);
  const digest = readString(value, ["skill_digest", "skillDigest"]);
  skills.push({
    skillId,
    ...(version ? { version } : {}),
    ...(digest ? { digest } : {}),
  });
}

function structuredValues(
  content: LLMMessage["content"],
): unknown[] {
  if (Array.isArray(content)) {
    return content.flatMap((block) =>
      block.type === "text"
        ? parseJsonCandidates(block.text)
        : block.type === "tool_result"
          ? [...parseJsonCandidates(block.content), block]
          : [block],
    );
  }
  return parseJsonCandidates(content);
}

function parseJsonCandidates(content: string): unknown[] {
  const trimmed = content.trim();
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
    extractJsonObject(trimmed),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const parsed: unknown[] = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      parsed.push(JSON.parse(candidate));
    } catch {
      // Non-JSON tool text remains available through artifact URI extraction.
    }
  }
  return parsed;
}

function extractJsonObject(content: string): string | undefined {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  return start >= 0 && end > start
    ? content.slice(start, end + 1)
    : undefined;
}

function artifactUris(content: string): string[] {
  return [...content.matchAll(/\bartifact:\/\/[^\s"'<>]+/g)].map(
    (match) => match[0],
  );
}

function normalizeApprovalState(
  value: string,
): ContextApprovalReceipt["state"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "pending" || normalized === "needs_approval") {
    return "pending";
  }
  if (normalized === "approved" || normalized === "approve") {
    return "approved";
  }
  if (normalized === "denied" || normalized === "deny") {
    return "denied";
  }
  if (normalized === "expired" || normalized === "timeout") {
    return "expired";
  }
  return "unknown";
}

function isImageRecord(value: Record<string, unknown>): boolean {
  const mime = readString(value, ["mime_type", "mimeType", "content_type"]);
  const kind = readString(value, ["kind", "type"]);
  return Boolean(
    mime?.toLowerCase().startsWith("image/") ||
      kind?.toLowerCase().includes("image") ||
      kind?.toLowerCase().includes("screenshot"),
  );
}

function isFileReadTool(name: string): boolean {
  return name === "read" ||
    name === "read_file" ||
    name === "file_read" ||
    name.endsWith(".read_file");
}

function readString(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return undefined;
}

function readBoolean(
  value: Record<string, unknown>,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "boolean") return candidate;
  }
  return undefined;
}

function readInteger(
  value: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function dedupeBy<T>(values: T[], key: (value: T) => string): T[] {
  const deduped = new Map<string, T>();
  for (const value of values) deduped.set(key(value), value);
  return [...deduped.values()];
}

function takeTail<T>(values: T[], limit: number): T[] {
  return limit === 0 ? [] : values.slice(-limit);
}

function normalizeLimits(
  limits: ContextWorkingSetLimits,
): ContextWorkingSetLimits {
  return {
    maxFiles: nonNegativeInteger(limits.maxFiles),
    maxSkills: nonNegativeInteger(limits.maxSkills),
    maxArtifacts: nonNegativeInteger(limits.maxArtifacts),
    maxSessions: nonNegativeInteger(limits.maxSessions),
    maxApprovals: nonNegativeInteger(limits.maxApprovals),
    maxImages: nonNegativeInteger(limits.maxImages),
  };
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
