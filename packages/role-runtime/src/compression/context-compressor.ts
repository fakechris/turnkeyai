import type {
  EvidenceSourceType,
  EvidenceTrustLevel,
  PromptAdmissionMode,
  RoleScratchpadRecord,
  TeamMessageSummary,
  ThreadSummaryRecord,
  WorkerEvidenceDigest,
} from "@turnkeyai/core-types/team";
import {
  hasContinuationBacklogSignal,
  hasMergeSignal,
  hasWaitingDependencySignal,
} from "@turnkeyai/core-types/continuation-semantics";

export interface ThreadCompressionInput {
  threadId: string;
  messages: TeamMessageSummary[];
  sourceMessageCount?: number;
  previousSummary?: ThreadSummaryRecord | null;
}

export interface RoleCompressionInput {
  threadId: string;
  roleId: string;
  messages: TeamMessageSummary[];
  sourceMessageCount?: number;
  previousScratchpad?: RoleScratchpadRecord | null;
}

export interface WorkerTraceCompressionInput {
  workerRunKey: string;
  threadId: string;
  workerType: string;
  status?: "completed" | "partial" | "failed";
  sourceType?: EvidenceSourceType;
  trustLevel?: EvidenceTrustLevel;
  admissionMode?: PromptAdmissionMode;
  admissionReason?: string;
  trace: Array<Record<string, unknown>>;
  artifactIds: string[];
}

export interface ContextCompressor {
  compressThread(input: ThreadCompressionInput): Promise<ThreadSummaryRecord>;
  compressRoleScratchpad(input: RoleCompressionInput): Promise<RoleScratchpadRecord>;
  compressWorkerTrace(input: WorkerTraceCompressionInput): Promise<WorkerEvidenceDigest>;
}

const MAX_WORKER_FINDINGS = 4;
const MAX_WORKER_FINDING_CHARS = 140;
const MAX_WORKER_FINDING_TOTAL_CHARS = 320;
const MAX_WORKER_ARTIFACT_REFS = 6;

export class DefaultContextCompressor implements ContextCompressor {
  async compressThread(input: ThreadCompressionInput): Promise<ThreadSummaryRecord> {
    const lastUserMessage = [...input.messages].reverse().find((message) => message.role === "user");
    const recentMessages = selectRecentMessages(input.messages, 14);
    const extractedFacts = extractStableFacts(recentMessages);
    const extractedDecisions = extractDecisions(recentMessages);
    const extractedQuestions = extractOpenQuestions(recentMessages);
    const extractedPending = extractPendingWork(recentMessages);

    return {
      threadId: input.threadId,
      summaryVersion: (input.previousSummary?.summaryVersion ?? 0) + 1,
      updatedAt: Date.now(),
      sourceMessageCount: input.sourceMessageCount ?? input.messages.length,
      userGoal: lastUserMessage?.content ?? input.previousSummary?.userGoal ?? "",
      stableFacts: keepRecentUniqueStrings([...(input.previousSummary?.stableFacts ?? []), ...extractedFacts], 8),
      decisions: keepRecentUniqueStrings([...(input.previousSummary?.decisions ?? []), ...extractedDecisions], 8),
      openQuestions: keepRecentUniqueStrings(
        [...(input.previousSummary?.openQuestions ?? []), ...extractedQuestions, ...extractedPending],
        8
      ),
    };
  }

  async compressRoleScratchpad(input: RoleCompressionInput): Promise<RoleScratchpadRecord> {
    const roleMessages = input.messages.filter((message) => message.roleId === input.roleId);
    const recentRoleMessages = roleMessages.slice(-6);
    const completedCandidates = extractCompletedWork(recentRoleMessages);
    const pendingCandidates = extractPendingWork(
      selectRecentMessages(input.messages, 12).filter(
        (message) => message.role === "user" || message.roleId === input.roleId
      )
    );
    const waitingOn = extractWaitingOn(input.messages) ?? input.previousScratchpad?.waitingOn;

    return {
      threadId: input.threadId,
      roleId: input.roleId,
      updatedAt: Date.now(),
      sourceMessageCount: input.sourceMessageCount ?? input.messages.length,
      completedWork: keepRecentUniqueStrings(
        [
          ...(input.previousScratchpad?.completedWork ?? []),
          ...completedCandidates,
          ...recentRoleMessages.slice(-2).map((message) => truncate(message.content)),
        ],
        8
      ),
      pendingWork: keepRecentUniqueStrings([...(input.previousScratchpad?.pendingWork ?? []), ...pendingCandidates], 8),
      ...(waitingOn ? { waitingOn } : {}),
      evidenceRefs: keepRecentUniqueStrings(input.previousScratchpad?.evidenceRefs ?? [], 8),
    };
  }

  async compressWorkerTrace(input: WorkerTraceCompressionInput): Promise<WorkerEvidenceDigest> {
    const toolChain = input.trace
      .map((step) => {
        const kind = step["kind"];
        return typeof kind === "string" ? kind : null;
      })
      .filter((kind): kind is string => Boolean(kind));
    const prunedFindings = pruneWorkerFindings(input.trace);

    const traceDigest: NonNullable<WorkerEvidenceDigest["traceDigest"]> = {
      totalSteps: input.trace.length,
      toolChain,
      ...(prunedFindings.prunedStepCount > 0 ? { prunedStepCount: prunedFindings.prunedStepCount } : {}),
    };

    const lastStep = toolChain.at(-1);
    if (lastStep) {
      traceDigest.lastStep = lastStep;
    }

    const normalizedWorkerEvidence = normalizeWorkerEvidenceFindings(
      buildWorkerDigestFindings(input.status ?? "completed", toolChain, prunedFindings)
    );
    const artifactIds = input.artifactIds.slice(0, MAX_WORKER_ARTIFACT_REFS);

    return {
      workerRunKey: input.workerRunKey,
      threadId: input.threadId,
      workerType: input.workerType,
      status: input.status ?? "completed",
      updatedAt: Date.now(),
      findings: normalizedWorkerEvidence.findings,
      artifactIds,
      findingCharCount: normalizedWorkerEvidence.findingCharCount,
      artifactCount: input.artifactIds.length,
      ...(normalizedWorkerEvidence.truncated || input.artifactIds.length > artifactIds.length ? { truncated: true } : {}),
      ...(normalizedWorkerEvidence.referenceOnly ? { referenceOnly: true } : {}),
      ...(normalizedWorkerEvidence.microcompactSummary
        ? { microcompactSummary: normalizedWorkerEvidence.microcompactSummary }
        : {}),
      ...(input.sourceType ? { sourceType: input.sourceType } : {}),
      ...(input.trustLevel ? { trustLevel: input.trustLevel } : {}),
      ...(input.admissionMode ? { admissionMode: input.admissionMode } : {}),
      ...(input.admissionReason ? { admissionReason: input.admissionReason } : {}),
      traceDigest,
    };
  }
}

function buildWorkerDigestFindings(
  status: "completed" | "partial" | "failed",
  toolChain: string[],
  prunedFindings: { findings: string[]; prunedStepCount: number }
): string[] {
  const findings =
    prunedFindings.findings.length > 0
      ? [...prunedFindings.findings]
      : toolChain.length > 0
        ? [`Executed ${toolChain.length} worker steps.`]
        : ["No worker trace available."];

  if (status === "failed") {
    findings.unshift("Worker failed before completing the requested task.");
  }

  return keepRecentUniqueStrings(findings, 5);
}

function normalizeWorkerEvidenceFindings(findings: string[]): {
  findings: string[];
  findingCharCount: number;
  truncated: boolean;
  referenceOnly: boolean;
  microcompactSummary?: string;
} {
  const normalized = keepRecentUniqueStrings(findings, MAX_WORKER_FINDINGS).map((finding) =>
    truncate(finding, MAX_WORKER_FINDING_CHARS)
  );
  const kept: string[] = [];
  let totalChars = 0;

  for (const finding of normalized) {
    const projected = totalChars + finding.length;
    if (kept.length > 0 && projected > MAX_WORKER_FINDING_TOTAL_CHARS) {
      break;
    }
    kept.push(finding);
    totalChars = projected;
  }

  const truncated = kept.length < normalized.length;
  if (kept.length === 0) {
    const fallback = truncate("Worker evidence retained by reference only.", MAX_WORKER_FINDING_CHARS);
    return {
      findings: [fallback],
      findingCharCount: fallback.length,
      truncated: true,
      referenceOnly: true,
      microcompactSummary: "Worker evidence compacted to reference-only summary.",
    };
  }

  const referenceOnly = truncated || totalChars > 240;
  return {
    findings: kept,
    findingCharCount: totalChars,
    truncated,
    referenceOnly,
    ...(referenceOnly
      ? {
          microcompactSummary: buildMicrocompactSummary(kept, normalized.length, totalChars),
        }
      : {}),
  };
}

function buildMicrocompactSummary(findings: string[], originalCount: number, totalChars: number): string {
  const headline = truncate(findings[0] ?? "Worker evidence compacted.", 72);
  const suffix =
    originalCount > findings.length
      ? ` (${findings.length}/${originalCount} findings kept, ${totalChars} chars)`
      : ` (${totalChars} chars)`;
  return truncate(`${headline}${suffix}`, MAX_WORKER_FINDING_CHARS);
}

function keepRecentUniqueStrings(values: string[], limit: number): string[] {
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  const recentToOldest = [...normalized].reverse();
  const deduped: string[] = [];
  for (const value of recentToOldest) {
    if (!deduped.includes(value)) {
      deduped.push(value);
    }
    if (deduped.length >= limit) {
      break;
    }
  }
  return deduped.reverse();
}

function selectRecentMessages(messages: TeamMessageSummary[], limit: number): TeamMessageSummary[] {
  if (messages.length <= limit) {
    return messages;
  }

  const fallbackTail = messages.slice(-Math.max(4, limit - 1));
  const preservedEarlier = [...messages.slice(0, -fallbackTail.length)]
    .reverse()
    .filter((message) => isContinuationRelevant(message.content))
    .slice(0, 2);

  if (preservedEarlier.length === 0) {
    return messages.slice(-limit);
  }

  const tailSize = Math.max(limit - preservedEarlier.length, 1);
  const tail = messages.slice(-tailSize);
  const selected = [...preservedEarlier, ...tail]
    .filter(
      (message, index, all) =>
        all.findIndex((candidate) => candidate.messageId === message.messageId) === index
    )
    .sort((left, right) => left.createdAt - right.createdAt);
  return selected;
}

function extractStableFacts(messages: TeamMessageSummary[]): string[] {
  return messages
    .map((message) => message.content.trim())
    .filter((content) =>
      /\b(must|need|needs|constraint|budget|deadline|limit|required)\b/i.test(content)
    )
    .map((content) => truncate(content));
}

function extractDecisions(messages: TeamMessageSummary[]): string[] {
  return messages
    .map((message) => message.content.trim())
    .filter((content) =>
      /\b(decide|decided|choose|chosen|use|using|confirmed|plan to|will use)\b/i.test(content)
    )
    .map((content) => truncate(content));
}

function extractOpenQuestions(messages: TeamMessageSummary[]): string[] {
  return messages
    .map((message) => message.content.trim())
    .filter((content) => content.includes("?") || hasMergeSignal(content) || /\b(unresolved|approval)\b/i.test(content))
    .map((content) => truncate(content));
}

function extractPendingWork(messages: TeamMessageSummary[]): string[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => message.content.trim())
    .filter((content) =>
      /\b(please|need|should|track|check|compare|review|confirm|todo|to do|awaiting|unresolved)\b/i.test(content) ||
      hasContinuationBacklogSignal(content)
    )
    .map((content) => truncate(content));
}

function extractCompletedWork(messages: TeamMessageSummary[]): string[] {
  return messages
    .map((message) => message.content.trim())
    .filter((content) =>
      /\b(checked|documented|captured|completed|finished|resolved|verified|confirmed|summarized|implemented)\b/i.test(
        content
      )
    )
    .map((content) => truncate(content));
}

function pruneWorkerFindings(trace: Array<Record<string, unknown>>): { findings: string[]; prunedStepCount: number } {
  const findings: string[] = [];
  let prunedStepCount = 0;

  for (const step of trace) {
    const kind = typeof step["kind"] === "string" ? step["kind"] : null;
    const output = step["output"];
    if (!kind || !output || typeof output !== "object") {
      continue;
    }

    const record = output as Record<string, unknown>;
    if (kind === "open" && typeof record.finalUrl === "string") {
      findings.push(`Opened ${record.finalUrl}`);
      continue;
    }
    if (kind === "snapshot") {
      const title = typeof record.title === "string" ? record.title : null;
      const finalUrl = typeof record.finalUrl === "string" ? record.finalUrl : null;
      const interactiveCount = typeof record.interactiveCount === "number" ? record.interactiveCount : null;
      const parts = [
        title ? `Snapshot title=${title}` : null,
        finalUrl ? `url=${finalUrl}` : null,
        interactiveCount != null ? `interactive=${interactiveCount}` : null,
      ].filter((value): value is string => Boolean(value));
      if (parts.length > 0) {
        findings.push(parts.join(" "));
        continue;
      }
    }
    if (kind === "console" && record.result != null) {
      findings.push(`Console probe returned ${truncate(JSON.stringify(record.result), 120)}`);
      continue;
    }
    if (kind === "screenshot" && typeof record.path === "string") {
      findings.push(`Captured screenshot ${record.path.split("/").at(-1) ?? record.path}`);
      continue;
    }
    prunedStepCount += 1;
  }

  return {
    findings: keepRecentUniqueStrings(findings, MAX_WORKER_FINDINGS),
    prunedStepCount,
  };
}

function extractWaitingOn(messages: TeamMessageSummary[]): string | null {
  const candidate = [...messages]
    .reverse()
    .map((message) => message.content.trim())
    .find((content) => hasWaitingDependencySignal(content));

  return candidate ? truncate(candidate) : null;
}

function isContinuationRelevant(content: string): boolean {
  return hasContinuationBacklogSignal(content) || /\b(must|budget|deadline|need)\b/i.test(content);
}

function truncate(content: string, maxChars = 160): string {
  return content.length > maxChars ? `${content.slice(0, maxChars - 1)}…` : content;
}
