import { createHash } from "node:crypto";

import {
  hasContinuationActionSignal,
  hasContinuationBacklogSignal,
  hasMergeContinuationSignal,
} from "@turnkeyai/core-types/continuation-semantics";
import { getRelayBrief } from "@turnkeyai/core-types/team";
import type {
  FlowLedger,
  HandoffEnvelope,
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
      const recentTurns = selectRecentTurnsForPacking(input.recentTurns, this.maxRecentTurns);
      optionalSections.push({
        segment: "recent-turns",
        priority: 1,
        artifactIds: [],
        text: trimSectionText(buildRecentTurnsSection(recentTurns, input.recentTurns.length), input.budget.recentTurnsBudget),
        compactText: trimSectionText(
          buildRecentTurnsSection(recentTurns.slice(-Math.min(2, recentTurns.length)), input.recentTurns.length, 120),
          Math.max(Math.floor(input.budget.recentTurnsBudget * 0.55), 1)
        ),
      });
    }

    if (input.threadSummary) {
      const lines = ["Thread summary:", `Goal: ${input.threadSummary.userGoal}`];
      if (input.threadSummary.stableFacts.length > 0) {
        lines.push(`Stable facts: ${input.threadSummary.stableFacts.join(" | ")}`);
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
      const threadWorkerEvidence = input.workerEvidence.filter(
        (digest) => digest.threadId === input.thread.threadId && digest.admissionMode !== "blocked"
      );
      if (threadWorkerEvidence.length > 0) {
        const visibleWorkerEvidence = sortWorkerEvidence(threadWorkerEvidence).slice(0, this.maxWorkerEvidence);
        const compactWorkerEvidence = visibleWorkerEvidence.slice(0, Math.max(1, Math.floor(this.maxWorkerEvidence / 2)));
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
      const visibleMemory = input.retrievedMemory.slice(0, this.maxMemoryHits);
      const compactMemory = visibleMemory.slice(0, Math.max(1, Math.floor(this.maxMemoryHits / 2)));
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

function selectRecentTurnsForPacking(turns: TeamMessageSummary[], limit: number): TeamMessageSummary[] {
  if (limit <= 0) {
    return [];
  }
  if (turns.length <= limit) {
    return turns;
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
    return turns.slice(-limit);
  }

  const tailBudget = Math.max(0, limit - earlierSalient.length);
  const boundedTail = tail.slice(-tailBudget);

  return [...boundedTail, ...earlierSalient]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(0, limit);
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
  return score;
}

function trimSectionText(text: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return "";
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
    return text;
  }

  return [...kept, `[compacted] ${lines.length - kept.length} line(s) omitted for budget.`].join("\n");
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
