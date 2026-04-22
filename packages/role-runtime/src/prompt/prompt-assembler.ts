import { createHash } from "node:crypto";

import {
  hasContinuationActionSignal,
  hasContinuationBacklogSignal,
  hasMergeContinuationSignal,
} from "@turnkeyai/core-types/continuation-semantics";
import { getContinuationContext, getRelayBrief } from "@turnkeyai/core-types/team";
import type {
  FlowLedger,
  HandoffEnvelope,
  PromptAssemblyContextDiagnostics,
  RoleSlot,
  TeamMessageSummary,
  TeamThread,
  ThreadSessionMemoryRecord,
  ThreadSummaryRecord,
  WorkerEvidenceDigest,
} from "@turnkeyai/core-types/team";

import type { PromptTokenBudget, PromptTokenEstimate } from "../context/context-budgeter";
import { EXPLICIT_RECALL_HITS } from "../context/role-memory-resolver";
import type { MemoryHit } from "../context/role-memory-resolver";

export type PromptSegmentName =
  | "task-brief"
  | "recent-turns"
  | "thread-summary"
  | "session-memory"
  | "role-scratchpad"
  | "retrieved-memory"
  | "worker-evidence";

export interface PromptAssemblyInput {
  thread: TeamThread;
  flow: FlowLedger;
  role: RoleSlot;
  handoff: HandoffEnvelope;
  recentTurns: TeamMessageSummary[];
  threadSummary?: ThreadSummaryRecord | null;
  threadSessionMemory?: ThreadSessionMemoryRecord | null;
  roleScratchpad?: {
    completedWork: string[];
    pendingWork: string[];
    waitingOn?: string;
    evidenceRefs: string[];
  } | null;
  retrievedMemory?: MemoryHit[];
  workerEvidence?: WorkerEvidenceDigest[];
  budget: PromptTokenBudget;
}

export interface OmittedPromptSegment {
  segment: Exclude<PromptSegmentName, "task-brief">;
  reason: "budget" | "empty" | "not-relevant";
}

export interface PromptAssemblyResult {
  systemPrompt: string;
  userPrompt: string;
  tokenEstimate: PromptTokenEstimate;
  omittedSegments: OmittedPromptSegment[];
  includedSegments: PromptSegmentName[];
  sectionOrder: PromptSegmentName[];
  compactedSegments: PromptSegmentName[];
  assemblyFingerprint: string;
  usedArtifacts: string[];
  contextDiagnostics: PromptAssemblyContextDiagnostics;
  envelopeHint?: {
    toolResultCount?: number;
    toolResultBytes?: number;
    inlineAttachmentBytes?: number;
    inlineImageCount?: number;
    inlineImageBytes?: number;
    inlinePdfCount?: number;
    inlinePdfBytes?: number;
    multimodalPartCount?: number;
  };
}

export interface PromptAssembler {
  assemble(input: PromptAssemblyInput): Promise<PromptAssemblyResult>;
}

interface DefaultPromptAssemblerOptions {
  estimateTokens: (
    input: { systemPrompt: string; userPrompt: string },
    reservedOutputTokens?: number,
    maxInputTokens?: number
  ) => Promise<PromptTokenEstimate>;
  maxRecentTurns?: number;
  maxWorkerEvidence?: number;
  maxMemoryHits?: number;
}

interface BudgetedListSectionResult {
  text: string;
  keptCount: number;
  compacted: boolean;
}

interface RecentTurnSelectionResult {
  turns: TeamMessageSummary[];
  salientEarlierCount: number;
}

interface TrimmedSectionResult {
  text: string;
  compacted: boolean;
}

const MAX_WORKER_EVIDENCE_PROMPT_ARTIFACTS = 8;
const MAX_WORKER_EVIDENCE_REFERENCE_ARTIFACTS = 3;
const MAX_TOTAL_PROMPT_ARTIFACTS = 12;
const MAX_ROLE_SCRATCHPAD_EVIDENCE_REFS = 6;

export class DefaultPromptAssembler implements PromptAssembler {
  private readonly estimateTokens: DefaultPromptAssemblerOptions["estimateTokens"];
  private readonly maxRecentTurns: number;
  private readonly maxWorkerEvidence: number;
  private readonly maxMemoryHits: number;

  constructor(options: DefaultPromptAssemblerOptions) {
    this.estimateTokens = options.estimateTokens;
    this.maxRecentTurns = options.maxRecentTurns ?? 6;
    this.maxWorkerEvidence = options.maxWorkerEvidence ?? 3;
    this.maxMemoryHits = options.maxMemoryHits ?? EXPLICIT_RECALL_HITS;
  }

  async assemble(input: PromptAssemblyInput): Promise<PromptAssemblyResult> {
    const omittedSegments: OmittedPromptSegment[] = [];
    const compactedSegments = new Set<PromptSegmentName>();

    const systemPrompt = [
      `You are ${input.role.name}.`,
      `Seat: ${input.role.seat}.`,
      `Flow: ${input.flow.flowId}.`,
      `Activation: ${input.handoff.activationType}.`,
    ].join("\n");

    const taskSection = trimSectionText(
      ["Task brief:", getRelayBrief(input.handoff.payload)].join("\n"),
      input.budget.taskLayerBudget
    );
    const recentTurnSelection =
      input.recentTurns.length > 0
        ? selectRecentTurnsForPacking(input.recentTurns, this.maxRecentTurns)
        : { turns: [], salientEarlierCount: 0 };
    const compactRecentTurns = selectCompactRecentTurns(recentTurnSelection.turns);
    const admittedWorkerEvidence = (input.workerEvidence ?? []).filter(
      (digest) => digest.threadId === input.thread.threadId && digest.admissionMode !== "blocked"
    );
    const visibleWorkerEvidence = sortWorkerEvidence(admittedWorkerEvidence).slice(0, this.maxWorkerEvidence);
    const compactWorkerEvidence = pickCompactWorkerEvidence(
      visibleWorkerEvidence,
      Math.max(1, Math.floor(this.maxWorkerEvidence / 2))
    );
    const visibleMemory = (input.retrievedMemory ?? []).slice(0, this.maxMemoryHits);
    const compactMemory = pickCompactMemoryHits(visibleMemory, Math.max(1, Math.floor(this.maxMemoryHits / 2)));
    const optionalSections: Array<{
      segment: Exclude<PromptSegmentName, "task-brief">;
      text: string;
      compactText?: string;
      priority: number;
      artifactIds: string[];
      compactArtifactIds?: string[];
      keptCount?: number;
      compactKeptCount?: number;
      compacted?: boolean;
      compactCompacted?: boolean;
    }> = [];

    if (input.recentTurns.length === 0) {
      omittedSegments.push({ segment: "recent-turns", reason: "empty" });
    } else {
      const recentTurnsSection = trimSection(
        buildRecentTurnsSection(recentTurnSelection.turns, input.recentTurns.length),
        input.budget.recentTurnsBudget
      );
      const compactRecentTurnsSection = trimSection(
        buildRecentTurnsSection(compactRecentTurns, input.recentTurns.length, 120),
        Math.max(Math.floor(input.budget.recentTurnsBudget * 0.55), 1)
      );
      optionalSections.push({
        segment: "recent-turns",
        priority: 1,
        artifactIds: [],
        keptCount: countRenderedRecentTurns(recentTurnsSection.text),
        compactKeptCount: countRenderedRecentTurns(compactRecentTurnsSection.text),
        text: recentTurnsSection.text,
        compactText: compactRecentTurnsSection.text,
        compacted: recentTurnsSection.compacted,
        compactCompacted: compactRecentTurnsSection.compacted,
      });
    }

    if (input.threadSummary) {
      const lines = ["Thread summary:", `Goal: ${input.threadSummary.userGoal}`];
      if (input.threadSummary.stableFacts.length > 0) {
        lines.push(`Stable facts: ${input.threadSummary.stableFacts.join(" | ")}`);
      }
      if (input.threadSummary.decisions.length > 0) {
        lines.push(`Decisions: ${input.threadSummary.decisions.slice(0, 3).join(" | ")}`);
      }
      if (input.threadSummary.openQuestions.length > 0) {
        lines.push(`Open questions: ${input.threadSummary.openQuestions.slice(0, 3).join(" | ")}`);
      }
      optionalSections.push({
        segment: "thread-summary",
        priority: 5,
        artifactIds: [],
        // Leave an implicit 10% buffer in compressed memory allocation for later continuity and evidence sections.
        text: trimSectionText(lines.join("\n"), Math.floor(input.budget.compressedMemoryBudget * 0.35)),
      });
    } else {
      omittedSegments.push({ segment: "thread-summary", reason: "empty" });
    }

    if (input.threadSessionMemory) {
      const lines = ["Session memory:"];
      if (input.threadSessionMemory.activeTasks.length > 0) {
        lines.push(`Active tasks: ${input.threadSessionMemory.activeTasks.slice(0, 3).join(" | ")}`);
      }
      if (input.threadSessionMemory.openQuestions.length > 0) {
        lines.push(`Open questions: ${input.threadSessionMemory.openQuestions.slice(0, 3).join(" | ")}`);
      }
      if (input.threadSessionMemory.recentDecisions.length > 0) {
        lines.push(`Recent decisions: ${input.threadSessionMemory.recentDecisions.slice(0, 2).join(" | ")}`);
      }
      if (input.threadSessionMemory.continuityNotes.length > 0) {
        lines.push(`Continuity notes: ${input.threadSessionMemory.continuityNotes.slice(0, 2).join(" | ")}`);
      }
      optionalSections.push({
        segment: "session-memory",
        priority: 4.5,
        artifactIds: [],
        text: trimSectionText(lines.join("\n"), Math.floor(input.budget.compressedMemoryBudget * 0.22)),
        compactText: trimSectionText(lines.join("\n"), Math.max(Math.floor(input.budget.compressedMemoryBudget * 0.12), 1)),
      });
    } else {
      omittedSegments.push({ segment: "session-memory", reason: "empty" });
    }

    if (input.roleScratchpad) {
      const lines = [
        "Role scratchpad:",
        `Completed: ${input.roleScratchpad.completedWork.join(" | ") || "(none)"}`,
        `Pending: ${input.roleScratchpad.pendingWork.join(" | ") || "(none)"}`,
      ];
      if (input.roleScratchpad.waitingOn) {
        lines.push(`Waiting on: ${input.roleScratchpad.waitingOn}`);
      }
      optionalSections.push({
        segment: "role-scratchpad",
        priority: 4,
        artifactIds: input.roleScratchpad.evidenceRefs.slice(0, MAX_ROLE_SCRATCHPAD_EVIDENCE_REFS),
        text: trimSectionText(lines.join("\n"), Math.floor(input.budget.compressedMemoryBudget * 0.3)),
      });
    } else {
      omittedSegments.push({ segment: "role-scratchpad", reason: "empty" });
    }

    if (input.workerEvidence && input.workerEvidence.length > 0) {
      if (admittedWorkerEvidence.length > 0) {
        const workerSection = buildBudgetedListSection({
          title: "Worker evidence:",
          items: visibleWorkerEvidence.map((digest) => formatWorkerEvidenceLine(digest)),
          maxTokens: input.budget.workerEvidenceBudget,
        });
        const compactWorkerSection = buildBudgetedListSection({
          title: "Worker evidence:",
          items: compactWorkerEvidence.map((digest) => formatCompactWorkerEvidenceLine(digest)),
          maxTokens: Math.max(Math.floor(input.budget.workerEvidenceBudget * 0.65), 1),
        });
        const keptWorkerEvidence = visibleWorkerEvidence.slice(0, workerSection.keptCount);
        const keptCompactWorkerEvidence = compactWorkerEvidence.slice(0, compactWorkerSection.keptCount);
        optionalSections.push({
          segment: "worker-evidence",
          priority: 2,
          artifactIds: collectWorkerEvidenceArtifactIds(keptWorkerEvidence, MAX_WORKER_EVIDENCE_PROMPT_ARTIFACTS),
          compactArtifactIds: collectWorkerEvidenceArtifactIds(
            keptCompactWorkerEvidence,
            MAX_WORKER_EVIDENCE_REFERENCE_ARTIFACTS
          ),
          keptCount: workerSection.keptCount,
          compactKeptCount: compactWorkerSection.keptCount,
          text: workerSection.text,
          compactText: compactWorkerSection.text,
          compacted: workerSection.compacted,
          compactCompacted: compactWorkerSection.compacted,
        });
      } else {
        omittedSegments.push({ segment: "worker-evidence", reason: "not-relevant" });
      }
    } else {
      omittedSegments.push({ segment: "worker-evidence", reason: "empty" });
    }

    if (input.retrievedMemory && input.retrievedMemory.length > 0) {
      const memorySection = buildBudgetedListSection({
        title: "Retrieved memory:",
        items: visibleMemory.map((hit) => (hit.rationale ? `${hit.content} [${hit.rationale}]` : hit.content)),
        maxTokens: Math.floor(input.budget.compressedMemoryBudget * 0.25),
      });
      const compactMemorySection = buildBudgetedListSection({
        title: "Retrieved memory:",
        items: compactMemory.map((hit) => hit.content),
        maxTokens: Math.max(Math.floor(input.budget.compressedMemoryBudget * 0.14), 1),
      });
      optionalSections.push({
        segment: "retrieved-memory",
        priority: 3,
        artifactIds: [],
        keptCount: memorySection.keptCount,
        compactKeptCount: compactMemorySection.keptCount,
        text: memorySection.text,
        compactText: compactMemorySection.text,
        compacted: memorySection.compacted,
        compactCompacted: compactMemorySection.compacted,
      });
    } else {
      omittedSegments.push({ segment: "retrieved-memory", reason: "empty" });
    }

    const keptSections = [...optionalSections].sort((left, right) => {
      const priorityDelta = right.priority - left.priority;
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return segmentOrderIndex(left.segment) - segmentOrderIndex(right.segment);
    });
    for (const section of keptSections) {
      if (section.compacted) {
        compactedSegments.add(section.segment);
      }
    }

    let userPrompt = buildUserPrompt(taskSection, keptSections);
    let tokenEstimate = await this.estimateTokens(
      {
        systemPrompt,
        userPrompt,
      },
      input.budget.reservedOutputTokens,
      input.budget.totalBudget
    );

    while (tokenEstimate.overBudget && keptSections.length > 0) {
      const compactableIndex = findCompactableSectionIndex(keptSections);
      if (compactableIndex >= 0) {
        const compactable = keptSections[compactableIndex];
        if (!compactable) {
          break;
        }
        compactedSegments.add(compactable.segment);
        keptSections[compactableIndex] = {
          segment: compactable.segment,
          priority: compactable.priority,
          text: compactable.compactText ?? compactable.text,
          artifactIds: compactable.compactArtifactIds ?? compactable.artifactIds,
          ...(compactable.compactKeptCount != null || compactable.keptCount != null
            ? { keptCount: compactable.compactKeptCount ?? compactable.keptCount }
            : {}),
          compacted: compactable.compactCompacted ?? compactable.compacted ?? false,
        };
      } else {
        const removed = keptSections.pop();
        if (!removed) {
          break;
        }
        omittedSegments.push({ segment: removed.segment, reason: "budget" });
      }
      userPrompt = buildUserPrompt(taskSection, keptSections);
      tokenEstimate = await this.estimateTokens(
        {
          systemPrompt,
          userPrompt,
        },
        input.budget.reservedOutputTokens,
        input.budget.totalBudget
      );
    }

    const usedArtifacts = [...new Set(keptSections.flatMap((section) => section.artifactIds))].slice(
      0,
      MAX_TOTAL_PROMPT_ARTIFACTS
    );
    const workerEvidenceSection = keptSections.find((section) => section.segment === "worker-evidence");
    const envelopeHint = workerEvidenceSection
      ? {
          toolResultCount: Number((workerEvidenceSection as { keptCount?: number }).keptCount ?? 0),
          toolResultBytes: Buffer.byteLength(workerEvidenceSection.text, "utf8"),
          inlineAttachmentBytes: 0,
          inlineImageCount: 0,
          inlineImageBytes: 0,
          inlinePdfCount: 0,
          inlinePdfBytes: 0,
          multimodalPartCount: 0,
        }
      : undefined;
    const sectionOrder: PromptSegmentName[] = ["task-brief", ...keptSections.map((section) => section.segment)];
    const includedSegments = [...sectionOrder];
    const contextDiagnostics = buildContextDiagnostics({
      handoff: input.handoff,
      threadSummary: input.threadSummary,
      threadSessionMemory: input.threadSessionMemory,
      roleScratchpad: input.roleScratchpad,
      totalRecentTurnCount: input.recentTurns.length,
      recentTurnSelection,
      retrievedMemory: input.retrievedMemory ?? [],
      totalWorkerEvidenceCount: (input.workerEvidence ?? []).filter((digest) => digest.threadId === input.thread.threadId).length,
      visibleMemory,
      admittedWorkerEvidence,
      visibleWorkerEvidence,
      keptSections,
      compactedSegments,
    });
    const assemblyFingerprint = buildAssemblyFingerprint({
      systemPrompt,
      userPrompt,
      sectionOrder,
      omittedSegments,
      usedArtifacts: [...usedArtifacts].sort(),
    });

    return {
      systemPrompt,
      userPrompt,
      tokenEstimate,
      omittedSegments,
      includedSegments,
      sectionOrder,
      compactedSegments: [...compactedSegments],
      assemblyFingerprint,
      usedArtifacts,
      contextDiagnostics,
      ...(envelopeHint ? { envelopeHint } : {}),
    };
  }
}

function buildUserPrompt(
  taskSection: string,
  sections: Array<{ text: string }>
): string {
  return [taskSection, ...sections.map((section) => section.text)].join("\n\n");
}

function buildRecentTurnsSection(turns: TeamMessageSummary[], totalTurns: number, maxChars = 220): string {
  const omitted = Math.max(0, totalTurns - turns.length);
  return [
    "Recent turns:",
    omitted > 0 ? `[compacted] ${omitted} earlier turn(s) omitted.` : null,
    ...turns.map((message) => `[${message.name}] ${truncate(message.content, maxChars)}`),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function selectRecentTurnsForPacking(turns: TeamMessageSummary[], limit: number): RecentTurnSelectionResult {
  if (limit <= 0) {
    return {
      turns: [],
      salientEarlierCount: 0,
    };
  }
  if (turns.length <= limit) {
    return {
      turns,
      salientEarlierCount: 0,
    };
  }

  const tail = turns.slice(-Math.max(4, limit - 1));
  const earlierCandidates = turns
    .slice(0, -tail.length)
    .map((message) => ({ message, score: recentTurnSalienceScore(message) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return right.message.createdAt - left.message.createdAt;
    });
  const earlierSalient = pickSalientEarlierTurns(
    earlierCandidates,
    Math.min(2, Math.max(1, limit - 3))
  );

  if (earlierSalient.length === 0) {
    return {
      turns: turns.slice(-limit),
      salientEarlierCount: 0,
    };
  }

  const tailBudget = Math.max(0, limit - earlierSalient.length);
  const boundedTail = tail.slice(-tailBudget);

  return {
    turns: [...boundedTail, ...earlierSalient]
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, limit),
    salientEarlierCount: earlierSalient.length,
  };
}

function selectCompactRecentTurns(turns: TeamMessageSummary[]): TeamMessageSummary[] {
  if (turns.length <= 2) {
    return turns;
  }

  const tail = turns.slice(-2);
  const earlierCandidates = turns
    .slice(0, -2)
    .map((message) => ({ message, score: recentTurnSalienceScore(message) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return right.message.createdAt - left.message.createdAt;
    });
  const salientEarlier = earlierCandidates[0]?.message;
  if (!salientEarlier) {
    return tail;
  }

  return [salientEarlier, ...tail].sort((left, right) => left.createdAt - right.createdAt);
}

function pickSalientEarlierTurns(
  candidates: Array<{ message: TeamMessageSummary; score: number }>,
  limit: number
): TeamMessageSummary[] {
  if (limit <= 0 || candidates.length === 0) {
    return [];
  }

  const selected: TeamMessageSummary[] = [];
  const userCandidate = candidates.find((item) => item.message.role === "user" && item.score >= 2);
  if (userCandidate) {
    selected.push(userCandidate.message);
  }
  const assistantCandidate = candidates.find(
    (item) => item.message.role === "assistant" && !selected.some((message) => message.messageId === item.message.messageId)
  );
  if (assistantCandidate) {
    selected.push(assistantCandidate.message);
  }

  for (const candidate of candidates) {
    if (selected.length >= limit) {
      break;
    }
    if (selected.some((message) => message.messageId === candidate.message.messageId)) {
      continue;
    }
    selected.push(candidate.message);
  }

  return selected.slice(0, limit);
}

function recentTurnSalienceScore(message: TeamMessageSummary): number {
  let score = 0;
  if (hasContinuationBacklogSignal(message.content)) {
    score += 3;
  }
  if (hasMergeContinuationSignal(message.content)) {
    score += 2;
  }
  if (hasContinuationActionSignal(message.content)) {
    score += 2;
  }
  if (/\b(question|open question|why|what remains|what's next)\b/i.test(message.content)) {
    score += 1;
  }
  if (/\b(budget|deadline|must|need|cannot|can't|required)\b/i.test(message.content)) {
    score += 1;
  }
  if (message.role === "user") {
    score += 0.5;
  }
  return score;
}

function segmentOrderIndex(segment: Exclude<PromptSegmentName, "task-brief">): number {
  switch (segment) {
    case "recent-turns":
      return 1;
    case "worker-evidence":
      return 2;
    case "retrieved-memory":
      return 3;
    case "role-scratchpad":
      return 4;
    case "session-memory":
      return 5;
    case "thread-summary":
      return 6;
    default:
      return 99;
  }
}

function buildAssemblyFingerprint(input: {
  systemPrompt: string;
  userPrompt: string;
  sectionOrder: PromptSegmentName[];
  omittedSegments: OmittedPromptSegment[];
  usedArtifacts: string[];
}): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        sectionOrder: input.sectionOrder,
        omittedSegments: input.omittedSegments,
        usedArtifacts: input.usedArtifacts,
      })
    )
    .digest("hex");
}

function formatWorkerEvidenceLine(digest: WorkerEvidenceDigest): string {
  const tags = [
    digest.sourceType,
    digest.trustLevel,
    digest.admissionMode,
  ].filter(Boolean) as string[];
  const tagText = tags.length > 0 ? ` [${tags.join(" / ")}]` : "";
  const reasonText = digest.admissionReason ? ` (${digest.admissionReason})` : "";
  const findings = digest.findings.slice(0, digest.referenceOnly ? 1 : 2).join(" | ");
  const traceSummary = digest.traceDigest
    ? ` {steps=${digest.traceDigest.totalSteps}, kept=${digest.traceDigest.toolChain.length}${
        digest.traceDigest.prunedStepCount ? `, pruned=${digest.traceDigest.prunedStepCount}` : ""
      }}`
    : "";
  const refSummary =
    digest.referenceOnly || digest.truncated
      ? ` [refs=${digest.artifactCount ?? digest.artifactIds.length}${digest.truncated ? ", compacted" : ""}]`
      : "";
  return `${digest.workerType}${tagText}: ${findings}${traceSummary}${refSummary}${reasonText}`;
}

function formatCompactWorkerEvidenceLine(digest: WorkerEvidenceDigest): string {
  const tags = [
    digest.sourceType ? `source=${digest.sourceType}` : null,
    digest.trustLevel ? `trust=${digest.trustLevel}` : null,
    digest.admissionMode ? `admission=${digest.admissionMode}` : null,
  ].filter((value): value is string => Boolean(value));
  const findings = digest.microcompactSummary ?? digest.findings[0] ?? "No worker finding.";
  const tagText = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
  const refText =
    digest.referenceOnly || digest.truncated
      ? ` [refs=${digest.artifactCount ?? digest.artifactIds.length}${digest.referenceOnly ? ", reference-only" : ""}]`
      : "";
  return `${digest.workerType}: ${findings}${tagText}${refText}`;
}

function collectWorkerEvidenceArtifactIds(values: WorkerEvidenceDigest[], limit: number): string[] {
  return [...new Set(values.flatMap((digest) => digest.artifactIds))].slice(0, limit);
}

function pickCompactWorkerEvidence(values: WorkerEvidenceDigest[], limit: number): WorkerEvidenceDigest[] {
  if (limit <= 0 || values.length === 0) {
    return [];
  }
  return [...values]
    .sort((left, right) => workerEvidenceCompactionScore(right) - workerEvidenceCompactionScore(left))
    .slice(0, limit)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function sortWorkerEvidence(values: WorkerEvidenceDigest[]): WorkerEvidenceDigest[] {
  return [...values].sort((left, right) => {
    const leftScore = workerEvidenceScore(left);
    const rightScore = workerEvidenceScore(right);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return right.updatedAt - left.updatedAt;
  });
}

function workerEvidenceScore(value: WorkerEvidenceDigest): number {
  let score = value.updatedAt / 1_000_000_000_000;
  if (value.trustLevel === "promotable") {
    score += 20;
  }
  if (value.admissionMode === "full") {
    score += 10;
  } else if (value.admissionMode === "summary_only") {
    score += 4;
  }
  if (value.sourceType === "api") {
    score += 3;
  } else if (value.sourceType === "tool") {
    score += 2;
  }
  if (isContinuationRelevantWorkerEvidence(value)) {
    score += 6;
  }
  if (/\b(blocker|blocked|waiting on|pending|follow-?up|approval|resume|retry)\b/i.test(workerEvidenceText(value))) {
    score += 4;
  }
  if (value.referenceOnly) {
    score -= 1.5;
  }
  return score;
}

function workerEvidenceCompactionScore(value: WorkerEvidenceDigest): number {
  let score = workerEvidenceScore(value);
  if (isContinuationRelevantWorkerEvidence(value)) {
    score += 8;
  }
  if (value.admissionMode === "full") {
    score += 3;
  }
  return score;
}

function pickCompactMemoryHits(values: MemoryHit[], limit: number): MemoryHit[] {
  if (limit <= 0 || values.length === 0) {
    return [];
  }

  return [...values]
    .sort((left, right) => memoryCompactionScore(right) - memoryCompactionScore(left))
    .slice(0, limit)
    .sort((left, right) => right.score - left.score);
}

function memoryCompactionScore(value: MemoryHit): number {
  let score = value.score;
  if (value.source === "session-memory") {
    score += 1.1;
  } else if (value.source === "thread-memory") {
    score += 0.45;
  } else if (value.source === "user-preference") {
    score += 0.25;
  }
  if (/\b(pending|waiting on|open question|question|constraint|budget|decision|decided|approved|approval|blocker|resume|continue)\b/i.test(value.content)) {
    score += 0.9;
  }
  if (/\b(journal)\b/i.test(value.content)) {
    score -= 0.25;
  }
  return score;
}

function isContinuationRelevantWorkerEvidence(value: WorkerEvidenceDigest): boolean {
  return hasContinuationBacklogSignal(workerEvidenceText(value));
}

function workerEvidenceText(value: WorkerEvidenceDigest): string {
  return [value.microcompactSummary ?? "", ...value.findings].join(" ");
}

function buildContextDiagnostics(input: {
  handoff: HandoffEnvelope;
  threadSummary?: ThreadSummaryRecord | null | undefined;
  threadSessionMemory?: ThreadSessionMemoryRecord | null | undefined;
  roleScratchpad?: PromptAssemblyInput["roleScratchpad"] | undefined;
  totalRecentTurnCount: number;
  recentTurnSelection: RecentTurnSelectionResult;
  retrievedMemory: MemoryHit[];
  totalWorkerEvidenceCount: number;
  visibleMemory: MemoryHit[];
  admittedWorkerEvidence: WorkerEvidenceDigest[];
  visibleWorkerEvidence: WorkerEvidenceDigest[];
  keptSections: Array<{ segment: Exclude<PromptSegmentName, "task-brief">; keptCount?: number }>;
  compactedSegments: Set<PromptSegmentName>;
}): PromptAssemblyContextDiagnostics {
  const keptBySegment = new Map(input.keptSections.map((section) => [section.segment, section]));
  const recentTurnsSection = keptBySegment.get("recent-turns");
  const retrievedMemorySection = keptBySegment.get("retrieved-memory");
  const workerEvidenceSection = keptBySegment.get("worker-evidence");
  const hasKeptSection = (segment: Exclude<PromptSegmentName, "task-brief">): boolean => keptBySegment.has(segment);
  const sourceHasContinuationContext = Boolean(getContinuationContext(input.handoff.payload));
  const sourceHasRolePendingWork = (input.roleScratchpad?.pendingWork.length ?? 0) > 0;
  const sourceHasSessionPendingWork = (input.threadSessionMemory?.activeTasks.length ?? 0) > 0;
  const sourceHasRoleWaitingOn = Boolean(input.roleScratchpad?.waitingOn);
  const sourceHasSessionWaitingOn = (input.threadSessionMemory?.continuityNotes.length ?? 0) > 0;
  const sourceHasThreadOpenQuestions = (input.threadSummary?.openQuestions.length ?? 0) > 0;
  const sourceHasSessionOpenQuestions = (input.threadSessionMemory?.openQuestions.length ?? 0) > 0;
  const sourceHasThreadDecision = (input.threadSummary?.decisions.length ?? 0) > 0;
  const sourceHasSessionDecisionOrConstraint =
    (input.threadSessionMemory?.recentDecisions.length ?? 0) > 0 ||
    (input.threadSessionMemory?.constraints.length ?? 0) > 0;
  const sourceHasPendingWork = sourceHasRolePendingWork || sourceHasSessionPendingWork;
  const sourceHasWaitingOn = sourceHasRoleWaitingOn || sourceHasSessionWaitingOn;
  const sourceHasOpenQuestions = sourceHasThreadOpenQuestions || sourceHasSessionOpenQuestions;
  const sourceHasDecisionOrConstraint = sourceHasThreadDecision || sourceHasSessionDecisionOrConstraint;

  return {
    continuity: {
      hasThreadSummary: Boolean(input.threadSummary),
      hasSessionMemory: Boolean(input.threadSessionMemory),
      hasRoleScratchpad: Boolean(input.roleScratchpad),
      hasContinuationContext: sourceHasContinuationContext,
      carriesPendingWork: Boolean(
        (sourceHasRolePendingWork && hasKeptSection("role-scratchpad")) ||
          (sourceHasSessionPendingWork && hasKeptSection("session-memory"))
      ),
      carriesWaitingOn: Boolean(
        (sourceHasRoleWaitingOn && hasKeptSection("role-scratchpad")) ||
          (sourceHasSessionWaitingOn && hasKeptSection("session-memory"))
      ),
      carriesOpenQuestions: Boolean(
        (sourceHasThreadOpenQuestions && hasKeptSection("thread-summary")) ||
          (sourceHasSessionOpenQuestions && hasKeptSection("session-memory"))
      ),
      carriesDecisionOrConstraint: Boolean(
        (sourceHasThreadDecision && hasKeptSection("thread-summary")) ||
          (sourceHasSessionDecisionOrConstraint && hasKeptSection("session-memory"))
      ),
      sourceHasContinuationContext,
      sourceHasPendingWork,
      sourceHasWaitingOn,
      sourceHasOpenQuestions,
      sourceHasDecisionOrConstraint,
    },
    recentTurns: {
      availableCount: input.totalRecentTurnCount,
      selectedCount: input.recentTurnSelection.turns.length,
      packedCount: Number(recentTurnsSection?.keptCount ?? 0),
      salientEarlierCount: input.recentTurnSelection.salientEarlierCount,
      compacted: input.compactedSegments.has("recent-turns"),
    },
    retrievedMemory: {
      availableCount: input.retrievedMemory.length,
      selectedCount: input.visibleMemory.length,
      packedCount: Number(retrievedMemorySection?.keptCount ?? 0),
      compacted: input.compactedSegments.has("retrieved-memory"),
      userPreferenceCount: input.retrievedMemory.filter((hit) => hit.source === "user-preference").length,
      threadMemoryCount: input.retrievedMemory.filter((hit) => hit.source === "thread-memory").length,
      sessionMemoryCount: input.retrievedMemory.filter((hit) => hit.source === "session-memory").length,
      knowledgeNoteCount: input.retrievedMemory.filter((hit) => hit.source === "knowledge-note").length,
      journalNoteCount: input.retrievedMemory.filter((hit) => hit.source === "journal-note").length,
    },
    workerEvidence: {
      totalCount: input.totalWorkerEvidenceCount,
      admittedCount: input.admittedWorkerEvidence.length,
      selectedCount: input.visibleWorkerEvidence.length,
      packedCount: Number(workerEvidenceSection?.keptCount ?? 0),
      compacted: input.compactedSegments.has("worker-evidence"),
      promotableCount: input.admittedWorkerEvidence.filter((digest) => digest.trustLevel === "promotable").length,
      observationalCount: input.admittedWorkerEvidence.filter((digest) => digest.trustLevel === "observational").length,
      fullCount: input.admittedWorkerEvidence.filter((digest) => digest.admissionMode === "full").length,
      summaryOnlyCount: input.admittedWorkerEvidence.filter((digest) => digest.admissionMode === "summary_only").length,
      continuationRelevantCount: input.admittedWorkerEvidence.filter(isContinuationRelevantWorkerEvidence).length,
    },
  };
}

function trimSectionText(text: string, maxTokens: number): string {
  return trimSection(text, maxTokens).text;
}

function trimSection(text: string, maxTokens: number): TrimmedSectionResult {
  if (maxTokens <= 0) {
    return {
      text: "",
      compacted: text.length > 0,
    };
  }

  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = [...kept, line].join("\n");
    if (roughTokenEstimate(candidate) > maxTokens) {
      break;
    }
    kept.push(line);
  }

  if (kept.length === lines.length) {
    return {
      text,
      compacted: false,
    };
  }

  if (
    ((kept.length <= 1) ||
      (kept.length === 2 && isCompactionNoticeLine(kept[1] ?? ""))) &&
    lines.length > kept.length
  ) {
    const replaceCompactionNotice = kept.length === 2 && isCompactionNoticeLine(kept[1] ?? "");
    const prefix = replaceCompactionNotice ? kept.slice(0, 1) : kept;
    const preferredLineIndex = findPreferredCompactedLineIndex(lines, prefix.length);
    const forcedLine = forceCompactLineIntoBudget({
      prefix,
      line: lines[preferredLineIndex] ?? "",
      maxTokens,
    });
    if (forcedLine) {
      kept.splice(prefix.length, kept.length - prefix.length, forcedLine);
    }
  }

  return {
    text: [...kept, `[compacted] ${lines.length - kept.length} line(s) omitted for budget.`].join("\n"),
    compacted: true,
  };
}

function buildBudgetedListSection(input: {
  title: string;
  items: string[];
  maxTokens: number;
}): BudgetedListSectionResult {
  if (input.maxTokens <= 0) {
    return {
      text: input.title,
      keptCount: 0,
      compacted: input.items.length > 0,
    };
  }

  const kept: string[] = [];
  let usedCompaction = false;
  for (const item of input.items) {
    const compactItem = compactListItem(item);
    const candidate = [input.title, ...kept, item].join("\n");
    if (roughTokenEstimate(candidate) > input.maxTokens) {
      const compactCandidate = [input.title, ...kept, compactItem].join("\n");
      if (compactItem !== item && roughTokenEstimate(compactCandidate) <= input.maxTokens) {
        kept.push(compactItem);
        usedCompaction = true;
        continue;
      }
      break;
    }
    kept.push(item);
  }

  if (kept.length === input.items.length) {
    return {
      text: [input.title, ...kept].join("\n"),
      keptCount: kept.length,
      compacted: usedCompaction,
    };
  }

  if (kept.length === 0 && input.items.length > 0) {
    const forcedItem = forceCompactLineIntoBudget({
      prefix: [input.title],
      line: input.items[0] ?? "",
      maxTokens: input.maxTokens,
    });
    if (forcedItem) {
      return {
        text: [
          input.title,
          forcedItem,
          `[compacted] ${Math.max(input.items.length - 1, 0)} item(s) omitted for budget.`,
        ].join("\n"),
        keptCount: 1,
        compacted: true,
      };
    }
  }

  const omittedCount = input.items.length - kept.length;
  return {
    text: [input.title, ...kept, `[compacted] ${omittedCount} item(s) omitted for budget.`].join("\n"),
    keptCount: kept.length,
    compacted: true,
  };
}

function compactListItem(item: string): string {
  if (item.length <= 160) {
    return item;
  }
  const bracketIndex = item.indexOf(" [");
  if (bracketIndex > 0) {
    return `${truncate(item.slice(0, bracketIndex), 120)}${item.slice(bracketIndex)}`;
  }
  return truncate(item, 140);
}

function forceCompactLineIntoBudget(input: {
  prefix: string[];
  line: string;
  maxTokens: number;
}): string | null {
  const base = input.prefix.join("\n");
  const remainingTokens = input.maxTokens - roughTokenEstimate(base);
  if (remainingTokens <= 1) {
    return null;
  }

  const maxChars = Math.max(24, remainingTokens * 4 - 4);
  const compacted = compactListItem(input.line);
  const forcedLine = truncate(compacted, maxChars);
  const candidate = [base, forcedLine].filter(Boolean).join("\n");
  return roughTokenEstimate(candidate) <= input.maxTokens ? forcedLine : null;
}

function findPreferredCompactedLineIndex(lines: string[], startIndex: number): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !isCompactionNoticeLine(line)) {
      return index;
    }
  }
  return startIndex;
}

function isCompactionNoticeLine(line: string): boolean {
  return /^\[compacted\]\s+\d+\s+(earlier turn\(s\)|line\(s\)|item\(s\)) omitted/i.test(line);
}

function countRenderedRecentTurns(text: string): number {
  return text
    .split("\n")
    .filter((line) => line.startsWith("[") && !isCompactionNoticeLine(line))
    .length;
}

function findCompactableSectionIndex(
  sections: Array<{ text: string; compactText?: string }>
): number {
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    if (section && section.compactText && section.compactText !== section.text) {
      return index;
    }
  }
  return -1;
}

function roughTokenEstimate(content: string): number {
  return Math.ceil(content.length / 4);
}

function truncate(content: string, maxChars: number): string {
  return content.length > maxChars ? `${content.slice(0, maxChars - 1)}…` : content;
}
