import type {
  RoleId,
  RoleScratchpadRecord,
  RoleScratchpadStore,
  ThreadJournalStore,
  ThreadSessionMemoryRecord,
  ThreadMemoryStore,
  ThreadSessionMemoryStore,
  ThreadId,
  ThreadSummaryRecord,
  ThreadSummaryStore,
  WorkerEvidenceDigest,
  WorkerEvidenceDigestStore,
} from "@turnkeyai/core-types/team";
import {
  hasApprovalSignal,
  hasContinuationBacklogSignal,
  hasContinuationSignal,
  hasMergeSignal,
} from "@turnkeyai/core-types/continuation-semantics";

export interface MemoryHit {
  memoryId: string;
  source: "user-preference" | "thread-memory" | "session-memory" | "knowledge-note" | "journal-note";
  score: number;
  content: string;
  rationale?: string;
}

interface MemoryQueryAnalysis {
  queryTerms: Set<string>;
  normalizedQuery: string;
  semanticTags: Set<string>;
  explicitRecall: boolean;
  evidenceSeeking: boolean;
  continuationSeeking: boolean;
  preferenceSeeking: boolean;
  constraintSeeking: boolean;
  decisionSeeking: boolean;
}

export const DEFAULT_RECALL_HITS = 4;
export const EXPLICIT_RECALL_HITS = 6;

export interface RoleMemoryResolver {
  loadThreadSummary(threadId: ThreadId): Promise<ThreadSummaryRecord | null>;
  loadThreadSessionMemory(threadId: ThreadId): Promise<ThreadSessionMemoryRecord | null>;
  loadRoleScratchpad(threadId: ThreadId, roleId: RoleId): Promise<RoleScratchpadRecord | null>;
  loadWorkerEvidence(threadId: ThreadId): Promise<WorkerEvidenceDigest[]>;
  retrieveMemory(input: { threadId: ThreadId; roleId: RoleId; queryText: string }): Promise<MemoryHit[]>;
}

interface DefaultRoleMemoryResolverOptions {
  threadSummaryStore: ThreadSummaryStore;
  roleScratchpadStore: RoleScratchpadStore;
  workerEvidenceDigestStore: WorkerEvidenceDigestStore;
  threadMemoryStore?: ThreadMemoryStore;
  threadSessionMemoryStore?: ThreadSessionMemoryStore;
  threadJournalStore?: ThreadJournalStore;
}

export class DefaultRoleMemoryResolver implements RoleMemoryResolver {
  private readonly threadSummaryStore: ThreadSummaryStore;
  private readonly roleScratchpadStore: RoleScratchpadStore;
  private readonly workerEvidenceDigestStore: WorkerEvidenceDigestStore;
  private readonly threadMemoryStore: ThreadMemoryStore | undefined;
  private readonly threadSessionMemoryStore: ThreadSessionMemoryStore | undefined;
  private readonly threadJournalStore: ThreadJournalStore | undefined;

  constructor(options: DefaultRoleMemoryResolverOptions) {
    this.threadSummaryStore = options.threadSummaryStore;
    this.roleScratchpadStore = options.roleScratchpadStore;
    this.workerEvidenceDigestStore = options.workerEvidenceDigestStore;
    this.threadMemoryStore = options.threadMemoryStore;
    this.threadSessionMemoryStore = options.threadSessionMemoryStore;
    this.threadJournalStore = options.threadJournalStore;
  }

  async loadThreadSummary(threadId: ThreadId): Promise<ThreadSummaryRecord | null> {
    return this.threadSummaryStore.get(threadId);
  }

  async loadRoleScratchpad(threadId: ThreadId, roleId: RoleId): Promise<RoleScratchpadRecord | null> {
    return this.roleScratchpadStore.get(threadId, roleId);
  }

  async loadThreadSessionMemory(threadId: ThreadId): Promise<ThreadSessionMemoryRecord | null> {
    return this.threadSessionMemoryStore?.get(threadId) ?? null;
  }

  async loadWorkerEvidence(threadId: ThreadId): Promise<WorkerEvidenceDigest[]> {
    return this.workerEvidenceDigestStore.listByThread(threadId);
  }

  async retrieveMemory(input: { threadId: ThreadId; roleId: RoleId; queryText: string }): Promise<MemoryHit[]> {
    const [threadSummary, roleScratchpad, workerEvidence] = await Promise.all([
      this.loadThreadSummary(input.threadId),
      this.loadRoleScratchpad(input.threadId, input.roleId),
      this.loadWorkerEvidence(input.threadId),
    ]);
    const [threadMemory, threadSessionMemory, journalRecords] = await Promise.all([
      this.threadMemoryStore?.get(input.threadId) ?? null,
      this.loadThreadSessionMemory(input.threadId),
      this.threadJournalStore?.listByThread(input.threadId, 3) ?? [],
    ]);
    const query = analyzeQuery(input.queryText);
    const hits: MemoryHit[] = [];

    if (threadMemory) {
      const records: Array<{ memoryId: string; source: MemoryHit["source"]; content: string }> = [
        ...threadMemory.preferences.map((value, index) => ({
          memoryId: `${input.threadId}:preference:${index + 1}`,
          source: "user-preference" as const,
          content: `Preference: ${value}`,
        })),
        ...threadMemory.constraints.map((value, index) => ({
          memoryId: `${input.threadId}:constraint:${index + 1}`,
          source: "thread-memory" as const,
          content: `Constraint: ${value}`,
        })),
        ...threadMemory.longTermNotes.map((value, index) => ({
          memoryId: `${input.threadId}:note:${index + 1}`,
          source: "thread-memory" as const,
          content: `Long-term note: ${value}`,
        })),
      ];

      hits.push(...records.map((record) => buildMemoryHit(record, query, 1.35, "thread preference/constraint memory")));
    }

    if (threadSummary) {
      const records: Array<{ memoryId: string; source: MemoryHit["source"]; content: string }> = [
        {
          memoryId: `${input.threadId}:goal`,
          source: "thread-memory",
          content: `Goal: ${threadSummary.userGoal}`,
        },
        ...threadSummary.stableFacts.map((value, index) => ({
          memoryId: `${input.threadId}:fact:${index + 1}`,
          source: "thread-memory" as const,
          content: `Fact: ${value}`,
        })),
        ...threadSummary.decisions.map((value, index) => ({
          memoryId: `${input.threadId}:decision:${index + 1}`,
          source: "thread-memory" as const,
          content: `Decision: ${value}`,
        })),
        ...threadSummary.openQuestions.map((value, index) => ({
          memoryId: `${input.threadId}:question:${index + 1}`,
          source: "thread-memory" as const,
          content: `Open question: ${value}`,
        })),
      ];

      hits.push(...records.map((record) => buildMemoryHit(record, query, 1.15, "thread summary memory")));
    }

    if (threadSessionMemory) {
      const records: Array<{ memoryId: string; source: MemoryHit["source"]; content: string }> = [
        ...threadSessionMemory.activeTasks.map((value, index) => ({
          memoryId: `${input.threadId}:session:active:${index + 1}`,
          source: "session-memory" as const,
          content: `Active task: ${value}`,
        })),
        ...threadSessionMemory.openQuestions.map((value, index) => ({
          memoryId: `${input.threadId}:session:question:${index + 1}`,
          source: "session-memory" as const,
          content: `Open question: ${value}`,
        })),
        ...threadSessionMemory.recentDecisions.map((value, index) => ({
          memoryId: `${input.threadId}:session:decision:${index + 1}`,
          source: "session-memory" as const,
          content: `Recent decision: ${value}`,
        })),
        ...threadSessionMemory.constraints.map((value, index) => ({
          memoryId: `${input.threadId}:session:constraint:${index + 1}`,
          source: "session-memory" as const,
          content: `Constraint: ${value}`,
        })),
        ...threadSessionMemory.continuityNotes.map((value, index) => ({
          memoryId: `${input.threadId}:session:continuity:${index + 1}`,
          source: "session-memory" as const,
          content: `Continuity: ${value}`,
        })),
        ...threadSessionMemory.latestJournalEntries.map((value, index) => ({
          memoryId: `${input.threadId}:session:journal:${index + 1}`,
          source: "session-memory" as const,
          content: `Recent journal: ${value}`,
        })),
      ];
      hits.push(...records.map((record) => buildMemoryHit(record, query, 1.25, "session continuity memory")));
    }

    if (roleScratchpad) {
      const records: Array<{ memoryId: string; source: MemoryHit["source"]; content: string }> = [
        ...roleScratchpad.completedWork.map((value, index) => ({
          memoryId: `${input.threadId}:${input.roleId}:done:${index + 1}`,
          source: "thread-memory" as const,
          content: `Completed: ${value}`,
        })),
        ...roleScratchpad.pendingWork.map((value, index) => ({
          memoryId: `${input.threadId}:${input.roleId}:pending:${index + 1}`,
          source: "thread-memory" as const,
          content: `Pending: ${value}`,
        })),
      ];

      if (roleScratchpad.waitingOn) {
        records.push({
          memoryId: `${input.threadId}:${input.roleId}:waiting`,
          source: "thread-memory",
          content: `Waiting on: ${roleScratchpad.waitingOn}`,
        });
      }

      hits.push(...records.map((record) => buildMemoryHit(record, query, 1.2, "role scratchpad memory")));
    }

    hits.push(
      ...workerEvidence.flatMap((digest, digestIndex) =>
        !shouldIncludeEvidenceDigest(digest, query)
          ? []
          : digest.findings.map((finding, findingIndex) =>
              buildMemoryHit(
                {
                  memoryId: `${digest.workerRunKey}:${digestIndex + 1}:${findingIndex + 1}`,
                  source: "knowledge-note",
                  content: buildEvidenceContent(digest, finding),
                },
                query,
                digest.trustLevel === "promotable" ? 1.25 : 0.75,
                digest.trustLevel === "promotable" ? "verified worker evidence" : "observational worker evidence"
              )
            )
      )
    );

    hits.push(
      ...journalRecords.flatMap((record, recordIndex) =>
        record.entries.map((entry, entryIndex) =>
          buildMemoryHit(
            {
              memoryId: `${record.threadId}:${record.dateKey}:${recordIndex + 1}:${entryIndex + 1}`,
              source: "journal-note",
              content: `Journal ${record.dateKey}: ${entry}`,
            },
            query,
            0.95 + Math.max(0, journalRecords.length - recordIndex) * 0.05,
            "recent thread journal"
          )
        )
      )
    );

    return hits
      .filter((hit) => hit.score >= minimumMemoryScore(query, hit.source))
      .sort((left, right) => right.score - left.score)
      .slice(0, query.explicitRecall ? EXPLICIT_RECALL_HITS : DEFAULT_RECALL_HITS);
  }
}

function buildMemoryHit(
  input: { memoryId: string; source: MemoryHit["source"]; content: string },
  query: MemoryQueryAnalysis,
  scoreMultiplier = 1,
  rationale?: string
): MemoryHit {
  let score = scoreContent(input.content, query) * scoreMultiplier * intentWeight(input.content, query);
  if (query.evidenceSeeking && input.source === "knowledge-note") {
    score = Math.max(score, 0.5);
  }
  return {
    memoryId: input.memoryId,
    source: input.source,
    score,
    content: input.content,
    ...(rationale ? { rationale } : {}),
  };
}

function buildEvidenceContent(digest: WorkerEvidenceDigest, finding: string): string {
  const tags = [
    digest.sourceType ? `source=${digest.sourceType}` : null,
    digest.trustLevel ? `trust=${digest.trustLevel}` : null,
    digest.admissionMode ? `admission=${digest.admissionMode}` : null,
  ].filter((value): value is string => Boolean(value));

  if (tags.length === 0) {
    return `${digest.workerType} evidence: ${finding}`;
  }

  return `${digest.workerType} evidence [${tags.join(", ")}]: ${finding}`;
}

function scoreContent(content: string, query: MemoryQueryAnalysis): number {
  if (query.queryTerms.size === 0) {
    return 0;
  }

  const terms = extractTerms(content);
  let overlap = 0;
  for (const term of query.queryTerms) {
    if (terms.has(term)) {
      overlap += 1;
    }
  }

  const normalizedContent = normalizeContent(content);
  const contentTags = extractSemanticTags(content);
  let semanticOverlap = 0;
  for (const tag of query.semanticTags) {
    if (contentTags.has(tag)) {
      semanticOverlap += 1;
    }
  }
  const phraseMatchBonus =
    query.normalizedQuery.length > 0 && normalizedContent.includes(query.normalizedQuery) ? 0.25 : 0;
  const densityBonus =
    query.queryTerms.size > 0 ? Math.min(0.2, overlap / Math.max(terms.size, 1)) : 0;
  const semanticBonus =
    query.semanticTags.size > 0 ? Math.min(0.25, semanticOverlap / query.semanticTags.size) : 0;
  const recallBonus = query.explicitRecall ? 0.05 : 0;

  return overlap / query.queryTerms.size + phraseMatchBonus + densityBonus + semanticBonus + recallBonus;
}

function extractTerms(content: string): Set<string> {
  const normalized = normalizeContent(content);
  return new Set(
    normalized
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, " ")
    .trim();
}

function analyzeQuery(content: string): MemoryQueryAnalysis {
  const normalizedQuery = normalizeContent(content);
  const continuationSeeking = hasContinuationSignal(content);
  const preferenceSeeking = /\b(preference|style|tone|format|remember|recall)\b/i.test(content);
  const constraintSeeking = /\b(constraint|budget|deadline|limit|required|must|cannot|can't)\b/i.test(content);
  const decisionSeeking =
    /\b(decision|decide|chosen|confirmed|previously|earlier|history|open question|question|what remains|merge|missing|conflict|duplicate)\b/i.test(
      content
    );
  return {
    queryTerms: extractTerms(content),
    normalizedQuery,
    semanticTags: extractSemanticTags(content),
    explicitRecall: continuationSeeking || preferenceSeeking || constraintSeeking || decisionSeeking,
    evidenceSeeking:
      /\b(evidence|source|sources|verified|trace|artifact|citation|citations|prove|proof|show (me )?(the )?(evidence|source))\b/i.test(
        content
      ),
    continuationSeeking,
    preferenceSeeking,
    constraintSeeking,
    decisionSeeking,
  };
}

function extractSemanticTags(content: string): Set<string> {
  const tags = new Set<string>();
  if (hasContinuationSignal(content)) {
    tags.add("continuation");
  }
  if (hasApprovalSignal(content)) {
    tags.add("approval");
  }
  if (hasMergeSignal(content)) {
    tags.add("merge");
  }
  if (/\b(evidence|source|citation|trace|artifact|proof|prove|verified)\b/i.test(content)) {
    tags.add("evidence");
  }
  if (/\b(preference|style|tone|format|remember|recall)\b/i.test(content)) {
    tags.add("preference");
  }
  if (/\b(constraint|budget|deadline|limit|required|must|cannot|can't)\b/i.test(content)) {
    tags.add("constraint");
  }
  if (/\b(decision|decide|chosen|confirmed|open question|question|history)\b/i.test(content)) {
    tags.add("decision");
  }
  return tags;
}

function shouldIncludeEvidenceDigest(digest: WorkerEvidenceDigest, query: MemoryQueryAnalysis): boolean {
  if (digest.admissionMode === "blocked") {
    return false;
  }

  if (query.continuationSeeking && !query.evidenceSeeking && !isContinuationRelevantEvidenceDigest(digest)) {
    return false;
  }

  if (digest.admissionMode === "full") {
    return true;
  }

  if (digest.trustLevel === "promotable") {
    return true;
  }

  return query.evidenceSeeking;
}

function isContinuationRelevantEvidenceDigest(digest: WorkerEvidenceDigest): boolean {
  const content = [digest.microcompactSummary ?? "", ...digest.findings].join(" ");
  return hasContinuationSignal(content);
}

function minimumMemoryScore(query: MemoryQueryAnalysis, source: MemoryHit["source"]): number {
  if (source === "session-memory") {
    if (query.continuationSeeking || query.decisionSeeking) {
      return 0.16;
    }
    return query.explicitRecall ? 0.18 : 0.28;
  }

  if (source === "user-preference") {
    return query.explicitRecall ? 0.15 : 0.2;
  }

  if (query.continuationSeeking && source === "journal-note") {
    return 0.28;
  }

  if ((query.continuationSeeking || query.decisionSeeking) && source === "thread-memory") {
    return 0.18;
  }

  if (query.explicitRecall) {
    return source === "journal-note" ? 0.35 : 0.2;
  }

  if (source === "journal-note") {
    return 0.7;
  }
  if (source === "knowledge-note") {
    return query.evidenceSeeking ? 0.45 : 0.85;
  }
  return 0.35;
}

function intentWeight(content: string, query: MemoryQueryAnalysis): number {
  let weight = 1;
  if (query.continuationSeeking && hasContinuationBacklogSignal(content)) {
    weight += 0.4;
  }
  if (query.preferenceSeeking && /\b(preference|prefer|style|format|tone)\b/i.test(content)) {
    weight += 0.25;
  }
  if (query.constraintSeeking && /\b(constraint|budget|deadline|limit|required|must|cannot|can't)\b/i.test(content)) {
    weight += 0.25;
  }
  if (
    query.decisionSeeking &&
    /\b(decision|decided|chosen|confirmed|previous|earlier|history|open question|question|outstanding|merge|missing|conflict|duplicate)\b/i.test(
      content
    )
  ) {
    weight += 0.2;
  }
  if (query.semanticTags.has("approval") && /\b(approval|approve|manual|permission|required)\b/i.test(content)) {
    weight += 0.25;
  }
  if (query.semanticTags.has("merge") && hasMergeSignal(content)) {
    weight += 0.25;
  }
  if (query.evidenceSeeking && /\b(source=|trust=|admission=|evidence)\b/i.test(content)) {
    weight += 0.15;
  }
  if (query.continuationSeeking && /\b(today|journal|recent|latest)\b/i.test(content)) {
    weight += 0.05;
  }
  return weight;
}
