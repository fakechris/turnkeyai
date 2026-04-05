import type { RoleId, RunKey, TaskId, ThreadId, WorkerKind } from "./team-core";
import type { FailureSummary } from "./team-replay-recovery";

export interface BrowserPageResult {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  textExcerpt: string;
  statusCode: number;
}

export type BrowserActionKind =
  | "open"
  | "snapshot"
  | "type"
  | "click"
  | "scroll"
  | "console"
  | "wait"
  | "screenshot";

export interface BrowserActionTrace {
  stepId: string;
  kind: BrowserActionKind;
  startedAt: number;
  completedAt: number;
  status: "ok" | "failed";
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorMessage?: string;
}

export interface BrowserInteractiveElement {
  refId: string;
  tagName: string;
  role: string;
  label: string;
  selectors?: string[];
  textAnchors?: string[];
}

export interface BrowserSnapshotResult extends BrowserPageResult {
  interactives: BrowserInteractiveElement[];
}

export type BrowserConsoleProbe = "page-metadata" | "interactive-summary";

export type BrowserClickAction =
  | { kind: "click"; selectors: string[]; refId?: never; text?: never }
  | { kind: "click"; refId: string; selectors?: never; text?: never }
  | { kind: "click"; text: string; selectors?: never; refId?: never };

export type BrowserTaskAction =
  | { kind: "open"; url: string }
  | { kind: "snapshot"; note?: string }
  | { kind: "type"; selectors?: string[]; refId?: string; text: string; submit?: boolean }
  | BrowserClickAction
  | { kind: "scroll"; direction: "up" | "down"; amount?: number }
  | { kind: "console"; probe: BrowserConsoleProbe }
  | { kind: "wait"; timeoutMs: number }
  | { kind: "screenshot"; label?: string };

export interface BrowserTaskRequest {
  taskId: string;
  threadId: string;
  instructions: string;
  actions: BrowserTaskAction[];
  browserSessionId?: string;
  targetId?: string;
  ownerType?: BrowserOwnerType;
  ownerId?: string;
  profileOwnerType?: BrowserOwnerType;
  profileOwnerId?: string;
  leaseHolderRunKey?: RunKey;
  leaseTtlMs?: number;
}

export type BrowserSessionDispatchMode = "spawn" | "send" | "resume";

export interface BrowserSessionSpawnInput extends Omit<BrowserTaskRequest, "browserSessionId"> {}

export interface BrowserSessionSendInput extends BrowserTaskRequest {
  browserSessionId: string;
}

export interface BrowserSessionResumeInput extends BrowserTaskRequest {
  browserSessionId: string;
}

export interface BrowserTaskResult {
  sessionId: string;
  targetId?: string;
  transportMode?: BrowserTransportMode;
  transportLabel?: string;
  transportPeerId?: string;
  transportTargetId?: string;
  historyEntryId?: string;
  dispatchMode?: BrowserSessionDispatchMode;
  resumeMode?: BrowserResumeMode;
  targetResolution?: "attach" | "reconnect" | "reopen" | "new_target";
  page: BrowserSnapshotResult;
  screenshotPaths: string[];
  trace: BrowserActionTrace[];
  artifactIds: string[];
}

export type BrowserOwnerType = "user" | "thread" | "role" | "worker";
export type BrowserSessionOwnerType = BrowserOwnerType;
export type BrowserProfileOwnerType = BrowserOwnerType;
export type BrowserTransportMode = "relay" | "direct-cdp" | "local";

export type BrowserTransportDiagnosticBucket =
  | "peer_missing"
  | "peer_stale"
  | "target_missing"
  | "target_detached"
  | "target_closed"
  | "content_script_unavailable"
  | "action_timeout"
  | "action_failed"
  | "endpoint_unreachable"
  | "reconnect_required";
export type BrowserSessionStatus = "starting" | "ready" | "busy" | "disconnected" | "closed";
export type BrowserTargetStatus = "open" | "attached" | "detached" | "closed";
export type BrowserResumeMode = "hot" | "warm" | "cold";

export interface BrowserSession {
  browserSessionId: string;
  ownerType: BrowserSessionOwnerType;
  ownerId: string;
  profileId: string;
  transportMode: BrowserTransportMode;
  status: BrowserSessionStatus;
  leaseHolderRunKey?: RunKey;
  leaseExpiresAt?: number;
  lastResumeMode?: BrowserResumeMode;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
  activeTargetId?: string;
  targetIds: string[];
  closeReason?: string;
}

export interface BrowserTarget {
  targetId: string;
  browserSessionId: string;
  ownerType: BrowserOwnerType;
  ownerId: string;
  transportSessionId?: string;
  url: string;
  title?: string;
  status: BrowserTargetStatus;
  leaseHolderRunKey?: RunKey;
  leaseExpiresAt?: number;
  lastResumeMode?: BrowserResumeMode;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserProfile {
  profileId: string;
  ownerType: BrowserProfileOwnerType;
  ownerId: string;
  persistentDir: string;
  loginState: "unknown" | "authenticated" | "anonymous";
  createdAt: number;
  updatedAt: number;
}

export interface SnapshotRefEntry {
  refId: string;
  role: string;
  label: string;
  tagName?: string;
  selectors?: string[];
  textAnchors?: string[];
  ordinal?: number;
}

export interface BrowserSnapshotArtifact {
  artifactId: string;
  snapshotId: string;
  browserSessionId: string;
  targetId: string;
  createdAt: number;
  finalUrl: string;
  title: string;
  refEntries: SnapshotRefEntry[];
}

export interface ResolvedRef {
  refId: string;
  strategy: "live-ref" | "snapshot-cache" | "selector-fallback" | "semantic-fallback";
  selectors?: string[];
  label?: string;
}

export interface BrowserArtifactRecord {
  artifactId: string;
  browserSessionId: string;
  targetId?: string;
  type: "snapshot" | "screenshot" | "console-result" | "downloaded-file" | "trace";
  path: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface BrowserSessionHistoryEntry {
  entryId: string;
  browserSessionId: string;
  dispatchMode: BrowserSessionDispatchMode;
  threadId: ThreadId;
  taskId: TaskId;
  ownerType: BrowserOwnerType;
  ownerId: string;
  targetId?: string;
  transportMode?: BrowserTransportMode;
  transportLabel?: string;
  transportPeerId?: string;
  transportTargetId?: string;
  historyCursor: number;
  startedAt: number;
  completedAt: number;
  status: "completed" | "failed";
  actionKinds: BrowserTaskAction["kind"][];
  instructions: string;
  resumeMode?: BrowserResumeMode;
  targetResolution?: BrowserTaskResult["targetResolution"];
  summary: string;
  finalUrl?: string;
  title?: string;
  traceStepCount?: number;
  screenshotCount?: number;
  artifactCount?: number;
  failure?: FailureSummary;
}

export interface BrowserSessionStore {
  get(browserSessionId: string): Promise<BrowserSession | null>;
  put(session: BrowserSession): Promise<void>;
  list(): Promise<BrowserSession[]>;
  listByOwner(ownerType: BrowserSessionOwnerType, ownerId: string): Promise<BrowserSession[]>;
  listActiveByProfile(profileId: string): Promise<BrowserSession[]>;
}

export interface BrowserSessionHistoryStore {
  append(entry: BrowserSessionHistoryEntry): Promise<void>;
  listBySession(browserSessionId: string, limit?: number): Promise<BrowserSessionHistoryEntry[]>;
}

export interface BrowserTargetStore {
  get(targetId: string): Promise<BrowserTarget | null>;
  put(target: BrowserTarget): Promise<void>;
  listBySession(browserSessionId: string): Promise<BrowserTarget[]>;
}

export interface BrowserProfileStore {
  get(profileId: string): Promise<BrowserProfile | null>;
  put(profile: BrowserProfile): Promise<void>;
  findByOwner(ownerType: BrowserProfileOwnerType, ownerId: string): Promise<BrowserProfile | null>;
}

export interface SnapshotRefStore {
  save(snapshot: BrowserSnapshotArtifact): Promise<void>;
  resolve(input: { browserSessionId: string; targetId: string; refId: string }): Promise<ResolvedRef | null>;
  expire(snapshotId: string): Promise<void>;
}

export interface BrowserArtifactStore {
  put(record: BrowserArtifactRecord): Promise<void>;
  get(artifactId: string): Promise<BrowserArtifactRecord | null>;
  listBySession(browserSessionId: string): Promise<BrowserArtifactRecord[]>;
}
