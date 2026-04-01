import type { RolePromptPacket } from "./prompt-policy";

export type RequestEnvelopeReductionLevel = "compact" | "minimal" | "reference-only";

export interface RequestEnvelopeReductionResult {
  reducedTaskPrompt: string;
  reducedSystemPrompt: string;
  artifactIds: string[];
  envelopeHint: {
    toolResultCount?: number;
    toolResultBytes?: number;
    inlineAttachmentBytes?: number;
    inlineImageCount?: number;
    inlineImageBytes?: number;
    inlinePdfCount?: number;
    inlinePdfBytes?: number;
    multimodalPartCount?: number;
  };
  omittedSections: string[];
  level: RequestEnvelopeReductionLevel;
}

const SECTION_SPLIT_RE = /\n{2,}/g;
const MAX_COMPACT_SECTION_CHARS = 420;
const MAX_MINIMAL_SECTION_CHARS = 220;
const MAX_REFERENCE_ONLY_SECTION_CHARS = 140;

export function reducePromptPacketForRequestEnvelope(
  packet: RolePromptPacket,
  input: { level: RequestEnvelopeReductionLevel }
): RequestEnvelopeReductionResult {
  const sections = packet.taskPrompt
    .split(SECTION_SPLIT_RE)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => classifySection(text));

  const retainedKinds = new Set(
    input.level === "compact"
      ? ["task-brief", "continuity", "merge", "parallel", "scratchpad", "thread-summary", "capability", "other"]
      : input.level === "minimal"
        ? ["task-brief", "continuity", "merge", "parallel", "scratchpad", "session-memory", "capability"]
        : ["task-brief", "continuity", "merge", "session-memory", "capability"]
  );

  const retained = sections.filter((section) => retainedKinds.has(section.kind));
  const omittedSections = uniqueStrings(sections.filter((section) => !retainedKinds.has(section.kind)).map((section) => section.label));
  const compacted = retained.map((section) =>
    compactSection(
      section.text,
      input.level === "compact"
        ? MAX_COMPACT_SECTION_CHARS
        : input.level === "minimal"
          ? MAX_MINIMAL_SECTION_CHARS
          : MAX_REFERENCE_ONLY_SECTION_CHARS
    )
  );
  const reductionHeader =
    omittedSections.length > 0
      ? [
          "Request envelope reduction:",
          `Omitted sections: ${omittedSections.join(", ")}`,
          `Reduction level: ${input.level}`,
        ].join("\n")
      : `Request envelope reduction:\nReduction level: ${input.level}`;

  return {
    reducedSystemPrompt:
      input.level === "reference-only"
        ? compactSection(packet.systemPrompt, 600)
        : input.level === "minimal"
          ? compactSection(packet.systemPrompt, 900)
          : compactSection(packet.systemPrompt, 1_400),
    reducedTaskPrompt: [reductionHeader, ...compacted].join("\n\n"),
    artifactIds:
      input.level === "compact"
        ? (packet.promptAssembly?.usedArtifacts ?? []).slice(0, 8)
        : input.level === "minimal"
          ? (packet.promptAssembly?.usedArtifacts ?? []).slice(0, 3)
          : [],
    envelopeHint: buildReducedEnvelopeHint(packet, input.level),
    omittedSections,
    level: input.level,
  };
}

interface ClassifiedSection {
  kind:
    | "task-brief"
    | "recent-turns"
    | "thread-summary"
    | "session-memory"
    | "scratchpad"
    | "retrieved-memory"
    | "worker-evidence"
    | "continuity"
    | "merge"
    | "parallel"
    | "capability"
    | "other";
  label: string;
  text: string;
}

function classifySection(text: string): ClassifiedSection {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const normalized = firstLine.toLowerCase();

  if (normalized.startsWith("task brief:")) {
    return { kind: "task-brief", label: "task-brief", text };
  }
  if (normalized.startsWith("recent turns:")) {
    return { kind: "recent-turns", label: "recent-turns", text };
  }
  if (normalized.startsWith("thread summary:")) {
    return { kind: "thread-summary", label: "thread-summary", text };
  }
  if (normalized.startsWith("session memory:")) {
    return { kind: "session-memory", label: "session-memory", text };
  }
  if (normalized.startsWith("role scratchpad:")) {
    return { kind: "scratchpad", label: "role-scratchpad", text };
  }
  if (normalized.startsWith("retrieved memory:")) {
    return { kind: "retrieved-memory", label: "retrieved-memory", text };
  }
  if (normalized.startsWith("worker evidence:")) {
    return { kind: "worker-evidence", label: "worker-evidence", text };
  }
  if (normalized.startsWith("execution continuity:") || normalized.startsWith("continuation context:")) {
    return { kind: "continuity", label: "execution-continuity", text };
  }
  if (normalized.startsWith("merge coverage:")) {
    return { kind: "merge", label: "merge-coverage", text };
  }
  if (normalized.startsWith("parallel shard assignment:") || normalized.startsWith("parallel merge packet:")) {
    return { kind: "parallel", label: "parallel-context", text };
  }
  if (normalized.startsWith("capability readiness:")) {
    return { kind: "capability", label: "capability-readiness", text };
  }
  return { kind: "other", label: truncateLabel(firstLine), text };
}

function compactSection(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = [...kept, line].join("\n");
    if (candidate.length > maxChars) {
      break;
    }
    kept.push(line);
  }

  if (kept.length === 0) {
    return truncate(text, maxChars);
  }

  return [...kept, "[compacted for request envelope]"].join("\n");
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, Math.max(maxChars - 1, 1))}…` : value;
}

function truncateLabel(firstLine: string): string {
  return truncate(firstLine || "other", 48).toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function scaleMetric(value: number | undefined, factor: number): number {
  if (!value || value <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(value * factor));
}

function buildReducedEnvelopeHint(
  packet: RolePromptPacket,
  level: RequestEnvelopeReductionLevel
): RequestEnvelopeReductionResult["envelopeHint"] {
  const source = packet.promptAssembly?.envelopeHint;
  if (!source) {
    return {};
  }
  if (level === "reference-only") {
    return {
      toolResultCount: 0,
      toolResultBytes: 0,
      inlineAttachmentBytes: 0,
      inlineImageCount: 0,
      inlineImageBytes: 0,
      inlinePdfCount: 0,
      inlinePdfBytes: 0,
      multimodalPartCount: 0,
    };
  }
  if (level === "minimal") {
    return {
      toolResultCount: Math.min(source.toolResultCount ?? 0, 2),
      toolResultBytes: scaleMetric(source.toolResultBytes, 0.35),
      inlineAttachmentBytes: scaleMetric(source.inlineAttachmentBytes, 0.25),
      inlineImageCount: Math.min(source.inlineImageCount ?? 0, 1),
      inlineImageBytes: scaleMetric(source.inlineImageBytes, 0.25),
      inlinePdfCount: Math.min(source.inlinePdfCount ?? 0, 1),
      inlinePdfBytes: scaleMetric(source.inlinePdfBytes, 0.25),
      multimodalPartCount: Math.min(source.multimodalPartCount ?? 0, 1),
    };
  }
  const hint: RequestEnvelopeReductionResult["envelopeHint"] = {
    toolResultBytes: scaleMetric(source.toolResultBytes, 0.65),
    inlineAttachmentBytes: scaleMetric(source.inlineAttachmentBytes, 0.75),
    inlineImageBytes: scaleMetric(source.inlineImageBytes, 0.75),
    inlinePdfBytes: scaleMetric(source.inlinePdfBytes, 0.75),
  };
  if (source.toolResultCount != null) {
    hint.toolResultCount = source.toolResultCount;
  }
  if (source.inlineImageCount != null) {
    hint.inlineImageCount = source.inlineImageCount;
  }
  if (source.inlinePdfCount != null) {
    hint.inlinePdfCount = source.inlinePdfCount;
  }
  if (source.multimodalPartCount != null) {
    hint.multimodalPartCount = source.multimodalPartCount;
  }
  return hint;
}
