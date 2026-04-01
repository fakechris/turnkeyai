import type {
  PromptBoundaryEntry,
  PromptBoundaryKind,
  PromptBoundaryReductionLevel,
  PromptConsoleReport,
  RuntimeProgressEvent,
} from "@turnkeyai/core-types/team";

const PROMPT_BOUNDARY_KINDS = new Set<PromptBoundaryKind>(["prompt_compaction", "request_envelope_reduction"]);

export function buildPromptConsoleReport(events: RuntimeProgressEvent[], limit = 10): PromptConsoleReport {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 10;
  const boundaryKindCounts: PromptConsoleReport["boundaryKindCounts"] = {};
  const reductionLevelCounts: PromptConsoleReport["reductionLevelCounts"] = {};
  const modelCounts: PromptConsoleReport["modelCounts"] = {};
  const modelChainCounts: PromptConsoleReport["modelChainCounts"] = {};
  const roleCounts: PromptConsoleReport["roleCounts"] = {};
  const compactedSegmentCounts: PromptConsoleReport["compactedSegmentCounts"] = {};
  const fingerprints = new Set<string>();
  let compactionCount = 0;
  let reductionCount = 0;

  const promptBoundaries = events
    .filter(isPromptBoundaryEvent)
    .map(mapPromptBoundaryEntry)
    .sort((left, right) => right.recordedAt - left.recordedAt);

  for (const boundary of promptBoundaries) {
    boundaryKindCounts[boundary.boundaryKind] = (boundaryKindCounts[boundary.boundaryKind] ?? 0) + 1;
    if (boundary.boundaryKind === "prompt_compaction") {
      compactionCount += 1;
    }
    if (boundary.boundaryKind === "request_envelope_reduction") {
      reductionCount += 1;
    }
    if (boundary.reductionLevel) {
      reductionLevelCounts[boundary.reductionLevel] = (reductionLevelCounts[boundary.reductionLevel] ?? 0) + 1;
    }
    if (boundary.modelId) {
      modelCounts[boundary.modelId] = (modelCounts[boundary.modelId] ?? 0) + 1;
    }
    if (boundary.modelChainId) {
      modelChainCounts[boundary.modelChainId] = (modelChainCounts[boundary.modelChainId] ?? 0) + 1;
    }
    if (boundary.roleId) {
      roleCounts[boundary.roleId] = (roleCounts[boundary.roleId] ?? 0) + 1;
    }
    if (boundary.assemblyFingerprint) {
      fingerprints.add(boundary.assemblyFingerprint);
    }
    for (const segment of boundary.compactedSegments ?? []) {
      compactedSegmentCounts[segment] = (compactedSegmentCounts[segment] ?? 0) + 1;
    }
  }

  return {
    totalBoundaries: promptBoundaries.length,
    compactionCount,
    reductionCount,
    boundaryKindCounts,
    reductionLevelCounts,
    modelCounts,
    modelChainCounts,
    roleCounts,
    compactedSegmentCounts,
    uniqueAssemblyFingerprintCount: fingerprints.size,
    latestBoundaries: promptBoundaries.slice(0, normalizedLimit),
  };
}

function isPromptBoundaryEvent(event: RuntimeProgressEvent): boolean {
  if (event.progressKind !== "boundary") {
    return false;
  }

  const boundaryKind = typeof event.metadata?.boundaryKind === "string" ? event.metadata.boundaryKind : null;
  return Boolean(boundaryKind && PROMPT_BOUNDARY_KINDS.has(boundaryKind as PromptBoundaryKind));
}

function mapPromptBoundaryEntry(event: RuntimeProgressEvent): PromptBoundaryEntry {
  const metadata = event.metadata ?? {};
  return {
    progressId: event.progressId,
    recordedAt: event.recordedAt,
    summary: event.summary,
    threadId: event.threadId,
    ...(event.roleId ? { roleId: event.roleId } : {}),
    ...(event.flowId ? { flowId: event.flowId } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.chainId ? { chainId: event.chainId } : {}),
    ...(event.spanId ? { spanId: event.spanId } : {}),
    boundaryKind: metadata.boundaryKind as PromptBoundaryKind,
    ...(typeof metadata.modelId === "string" ? { modelId: metadata.modelId } : {}),
    ...(typeof metadata.modelChainId === "string" ? { modelChainId: metadata.modelChainId } : {}),
    ...(typeof metadata.assemblyFingerprint === "string" ? { assemblyFingerprint: metadata.assemblyFingerprint } : {}),
    ...(typeof metadata.reductionLevel === "string"
      ? { reductionLevel: metadata.reductionLevel as PromptBoundaryReductionLevel }
      : {}),
    ...(Array.isArray(metadata.sectionOrder) ? { sectionOrder: metadata.sectionOrder.filter(isString) } : {}),
    ...(Array.isArray(metadata.compactedSegments) ? { compactedSegments: metadata.compactedSegments.filter(isString) } : {}),
    ...(Array.isArray(metadata.omittedSections) ? { omittedSections: metadata.omittedSections.filter(isString) } : {}),
    ...(Array.isArray(metadata.usedArtifacts) ? { usedArtifacts: metadata.usedArtifacts.filter(isString) } : {}),
    ...(isTokenEstimate(metadata.tokenEstimate) ? { tokenEstimate: metadata.tokenEstimate } : {}),
    ...(isEnvelopeHint(metadata.envelopeHint) ? { envelopeHint: metadata.envelopeHint } : {}),
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isTokenEstimate(
  value: unknown
): value is NonNullable<PromptBoundaryEntry["tokenEstimate"]> {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { inputTokens?: unknown }).inputTokens === "number" &&
      typeof (value as { outputTokensReserved?: unknown }).outputTokensReserved === "number" &&
      typeof (value as { totalProjectedTokens?: unknown }).totalProjectedTokens === "number" &&
      typeof (value as { overBudget?: unknown }).overBudget === "boolean"
  );
}

function isEnvelopeHint(
  value: unknown
): value is NonNullable<PromptBoundaryEntry["envelopeHint"]> {
  if (!value || typeof value !== "object") {
    return false;
  }

  return [
    "toolResultCount",
    "toolResultBytes",
    "inlineAttachmentBytes",
    "inlineImageCount",
    "inlineImageBytes",
    "inlinePdfCount",
    "inlinePdfBytes",
    "multimodalPartCount",
  ].every((key) => {
    const candidate = (value as Record<string, unknown>)[key];
    return candidate == null || typeof candidate === "number";
  });
}
