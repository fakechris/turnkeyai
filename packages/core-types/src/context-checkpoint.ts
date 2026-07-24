export const CONTEXT_CHECKPOINT_PROTOCOL =
  "turnkeyai.context_checkpoint.v2" as const;

export type ContextCheckpointState =
  | "prepared"
  | "summarized"
  | "persisted"
  | "activated";

export interface ContextCheckpointScope {
  threadId: string;
  roleId: string;
  flowId: string;
}

export interface ContextCheckpointSource {
  transcriptDigest: string;
  sourceMessageCount: number;
  sourceBytes: number;
  sourceTokensEstimate: number;
  previousCheckpointId?: string;
  guard?: {
    protocolSafe: boolean;
    compacted: boolean;
    guardedMessageCount: number;
    guardedBytes: number;
    guardedTokens: number;
    digestedMessageCount: number;
    digestedProtocolUnitCount: number;
    retainedProtocolUnitCount: number;
    digestGroupCount: number;
  };
}

export interface ContextFileReceipt {
  path: string;
  digest?: string;
  startLine?: number;
  endLine?: number;
  capturedAt?: number;
}

export interface ContextSkillReceipt {
  skillId: string;
  version?: string;
  digest?: string;
}

export interface ContextSessionReceipt {
  sessionKey: string;
  status?: string;
  resumable?: boolean;
  evidenceAvailable?: boolean;
}

export interface ContextApprovalReceipt {
  approvalId: string;
  state: "pending" | "approved" | "denied" | "expired" | "unknown";
}

export interface ContextImageReceipt {
  artifactId: string;
  digest?: string;
}

export interface ContextCheckpointWorkingSet {
  files: ContextFileReceipt[];
  skills: ContextSkillReceipt[];
  artifacts: string[];
  sessions: ContextSessionReceipt[];
  approvals: ContextApprovalReceipt[];
  images: ContextImageReceipt[];
}

export interface ContextCheckpointTaskState {
  rootGoal: string;
  planState: string[];
  openQuestions: string[];
  nextActions: string[];
}

export interface ContextCheckpointSummary {
  narrative: string;
  decisions: string[];
  evidence: string[];
  errorsAndFixes: string[];
}

export interface ContextCheckpointDynamicContext {
  baselineId: string;
  sectionDigests: Record<string, string>;
}

export interface ContextCheckpointExecutionLink {
  runJournalId: string;
  effectLedgerDigest: string;
}

export interface ContextCheckpointRecord {
  protocol: typeof CONTEXT_CHECKPOINT_PROTOCOL;
  checkpointId: string;
  version: number;
  state: ContextCheckpointState;
  scope: ContextCheckpointScope;
  compactedAtRound: number;
  source: ContextCheckpointSource;
  task: ContextCheckpointTaskState;
  summary: ContextCheckpointSummary;
  workingSet: ContextCheckpointWorkingSet;
  dynamicContext?: ContextCheckpointDynamicContext;
  execution?: ContextCheckpointExecutionLink;
  createdAt: number;
  updatedAt: number;
}

export interface ContextCheckpointActivePointer {
  protocol: typeof CONTEXT_CHECKPOINT_PROTOCOL;
  scope: ContextCheckpointScope;
  checkpointId: string;
  version: number;
  activatedAt: number;
}

export interface ContextCheckpointStore {
  get(checkpointId: string): Promise<ContextCheckpointRecord | null>;
  put(record: ContextCheckpointRecord): Promise<void>;
  getActive(
    scope: ContextCheckpointScope,
  ): Promise<ContextCheckpointRecord | null>;
  activate(input: {
    scope: ContextCheckpointScope;
    checkpointId: string;
    expectedActiveCheckpointId?: string | null;
    activatedAt: number;
  }): Promise<ContextCheckpointRecord>;
  listByScope(
    scope: ContextCheckpointScope,
    limit?: number,
  ): Promise<ContextCheckpointRecord[]>;
}

export function emptyContextCheckpointWorkingSet(): ContextCheckpointWorkingSet {
  return {
    files: [],
    skills: [],
    artifacts: [],
    sessions: [],
    approvals: [],
    images: [],
  };
}
