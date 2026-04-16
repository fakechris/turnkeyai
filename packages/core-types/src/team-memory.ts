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
  status: "completed" | "partial" | "failed";
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
