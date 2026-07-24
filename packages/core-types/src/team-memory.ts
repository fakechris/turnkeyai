import type { EvidenceSourceType, EvidenceTrustLevel, PromptAdmissionMode } from "./team-governance";

export interface ThreadSummaryRecord {
  threadId: string;
  summaryVersion: number;
  updatedAt: number;
  sourceMessageCount: number;
  userGoal: string;
  stableFacts: string[];
  decisions: string[];
  openQuestions: string[];
}

export interface RoleScratchpadRecord {
  threadId: string;
  roleId: string;
  updatedAt: number;
  sourceMessageCount: number;
  completedWork: string[];
  pendingWork: string[];
  waitingOn?: string;
  evidenceRefs: string[];
}

export interface WorkerEvidenceDigest {
  workerRunKey: string;
  threadId: string;
  workerType: string;
  status: "completed" | "partial" | "failed" | "timeout";
  updatedAt: number;
  findings: string[];
  artifactIds: string[];
  findingCharCount?: number;
  artifactCount?: number;
  truncated?: boolean;
  referenceOnly?: boolean;
  microcompactSummary?: string;
  sourceType?: EvidenceSourceType;
  trustLevel?: EvidenceTrustLevel;
  admissionMode?: PromptAdmissionMode;
  admissionReason?: string;
  traceDigest?: {
    totalSteps: number;
    toolChain: string[];
    lastStep?: string;
    prunedStepCount?: number;
  };
}

export interface ThreadMemoryRecord {
  threadId: string;
  updatedAt: number;
  preferences: string[];
  constraints: string[];
  longTermNotes: string[];
}

export interface ThreadSessionMemoryRecord {
  threadId: string;
  memoryVersion?: number;
  sourceMessageCount?: number;
  sectionFingerprint?: string;
  updatedAt: number;
  activeTasks: string[];
  openQuestions: string[];
  recentDecisions: string[];
  constraints: string[];
  continuityNotes: string[];
  latestJournalEntries: string[];
}

export interface SessionMemoryRefreshJobRecord {
  threadId: string;
  enqueuedAt: number;
  notBeforeAt: number;
  attemptCount: number;
  roleScratchpad?: {
    completedWork: string[];
    pendingWork: string[];
    waitingOn?: string;
  } | null;
  lastError?: string;
}

export interface ThreadJournalRecord {
  threadId: string;
  dateKey: string;
  updatedAt: number;
  entries: string[];
}

export interface ThreadSummaryStore {
  get(threadId: string): Promise<ThreadSummaryRecord | null>;
  put(record: ThreadSummaryRecord): Promise<void>;
}

export interface RoleScratchpadStore {
  get(threadId: string, roleId: string): Promise<RoleScratchpadRecord | null>;
  put(record: RoleScratchpadRecord): Promise<void>;
}

export interface WorkerEvidenceDigestStore {
  get(workerRunKey: string): Promise<WorkerEvidenceDigest | null>;
  put(record: WorkerEvidenceDigest): Promise<void>;
  listByThread(threadId: string): Promise<WorkerEvidenceDigest[]>;
}

export interface ThreadMemoryStore {
  get(threadId: string): Promise<ThreadMemoryRecord | null>;
  put(record: ThreadMemoryRecord): Promise<void>;
}

export interface ThreadSessionMemoryStore {
  get(threadId: string): Promise<ThreadSessionMemoryRecord | null>;
  put(record: ThreadSessionMemoryRecord): Promise<void>;
}

export interface SessionMemoryRefreshJobStore {
  get(threadId: string): Promise<SessionMemoryRefreshJobRecord | null>;
  put(record: SessionMemoryRefreshJobRecord): Promise<void>;
  delete(threadId: string): Promise<void>;
  list(limit?: number): Promise<SessionMemoryRefreshJobRecord[]>;
}

export interface ThreadJournalStore {
  get(threadId: string, dateKey: string): Promise<ThreadJournalRecord | null>;
  put(record: ThreadJournalRecord): Promise<void>;
  listByThread(threadId: string, limit?: number): Promise<ThreadJournalRecord[]>;
}

export type MemoryPlane =
  | "profile"
  | "workspace"
  | "session"
  | "evidence"
  | "transcript-index";

export interface MemoryScope {
  workspaceId: string;
  threadId?: string;
  roleId?: string;
}

export type DurableMemoryConfidence =
  | "authoritative"
  | "confirmed"
  | "inferred";

export interface DurableMemoryRecord {
  memoryId: string;
  plane: MemoryPlane;
  scope: MemoryScope;
  content: string;
  sourceRefs: string[];
  createdBy: "user" | "runtime" | "memory-writer";
  confidence: DurableMemoryConfidence;
  createdAt: number;
  lastConfirmedAt: number;
  supersedes: string[];
  invalidationKeys: string[];
  expiresAt?: number;
}

export interface WorkspaceMemorySourceEvent {
  eventId: string;
  workspaceId: string;
  threadId: string;
  sequence: number;
  kind: "user-message" | "runtime-message" | "task-change" | "evidence";
  content: string;
  sourceRefs: string[];
  occurredAt: number;
  authoritative: boolean;
}

export type WorkspaceMemoryMutation =
  | {
      kind: "add";
      record: DurableMemoryRecord;
    }
  | {
      kind: "supersede";
      record: DurableMemoryRecord;
      supersedes: string[];
    }
  | {
      kind: "delete";
      memoryId: string;
      reason: string;
      sourceRefs: string[];
    };

export interface WorkspaceMemoryWriterCursor {
  workspaceId: string;
  lastSequence: number;
  lastEventId?: string;
  updatedAt: number;
}

export interface WorkspaceMemoryAuditRecord {
  auditId: string;
  workspaceId: string;
  trigger:
    | "turn-interval"
    | "high-value-event"
    | "idle"
    | "pre-compaction"
    | "mission-close"
    | "manual";
  sourceEventIds: string[];
  mutations: WorkspaceMemoryMutation[];
  rejectedMutations: Array<{
    mutation: WorkspaceMemoryMutation;
    reason: string;
  }>;
  beforeDigest: string;
  afterDigest: string;
  startedAt: number;
  completedAt: number;
  status: "written" | "noop" | "failed";
  error?: string;
}

export interface WorkspaceMemorySnapshot {
  workspaceId: string;
  records: DurableMemoryRecord[];
  cursor: WorkspaceMemoryWriterCursor;
  audits: WorkspaceMemoryAuditRecord[];
}

export interface WorkspaceMemoryStore {
  getSnapshot(workspaceId: string): Promise<WorkspaceMemorySnapshot>;
  get(memoryId: string): Promise<DurableMemoryRecord | null>;
  list(scope: MemoryScope, plane?: MemoryPlane): Promise<DurableMemoryRecord[]>;
  commit(input: {
    workspaceId: string;
    expectedLastSequence: number;
    cursor: WorkspaceMemoryWriterCursor;
    audit: WorkspaceMemoryAuditRecord;
    mutations: WorkspaceMemoryMutation[];
  }): Promise<WorkspaceMemorySnapshot>;
}

export interface MemoryIndexCandidate {
  memoryId: string;
  channel: "fts" | "vector";
  rawScore: number;
  rank: number;
}

export interface HybridMemoryRecallHit {
  record: DurableMemoryRecord;
  score: number;
  rationale: string;
  channels: {
    fts?: { rank: number; rawScore: number };
    vector?: { rank: number; rawScore: number };
  };
}

export interface MemoryEmbeddingAdapter {
  embed(text: string): Promise<number[]>;
}

export interface MemorySearchIndex {
  replaceWorkspace(
    workspaceId: string,
    records: DurableMemoryRecord[],
  ): Promise<void>;
  get(memoryId: string): Promise<DurableMemoryRecord | null>;
  recall(input: {
    scope: MemoryScope;
    query: string;
    ftsCandidates?: number;
    vectorCandidates?: number;
    limit?: number;
  }): Promise<HybridMemoryRecallHit[]>;
  rebuild(records: DurableMemoryRecord[]): Promise<void>;
  diagnostics?(scope?: MemoryScope): Promise<{
    backend: string;
    indexedRecords: number;
    vectorRecords: number;
    channels: Array<"fts" | "vector">;
    defaults: {
      ftsCandidates: number;
      vectorCandidates: number;
      hits: number;
      rrfK: number;
      ftsWeight: number;
      vectorWeight: number;
    };
  }>;
}
