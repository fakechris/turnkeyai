// Mission Control data model (PR K2).
//
// These types are the on-the-wire shape the daemon serves and the
// dashboard consumes. They mirror the design's mock data structure (see
// docs/design/mission-control-product-design.md §4 — "Core Product
// Objects") so the K1 dashboard's MOCK_DATA imports become typed API
// calls without a UI rewrite.
//
// Naming convention: all IDs are opaque strings (no embedded structure
// the caller should rely on). Timestamps are milliseconds since epoch.

export type MissionId = string;
export type WorkItemId = string;
export type AgentId = string;
export type ContextSourceId = string;
export type ActivityEventId = string;
export type ArtifactId = string;
export type ApprovalRequestId = string;

// Lifecycle states — matches the design's status-dot CSS classes.
export type MissionStatus =
  | "draft"
  | "planning"
  | "working"
  | "needs_approval"
  | "blocked"
  | "done"
  | "archived";

export type MissionMode =
  | "research"
  | "monitor"
  | "browser"
  | "review"
  | "investigation"
  | "custom";

export type ContextKind = "browser" | "doc" | "folder" | "api" | "desktop";

// Severity for approvals — three buckets matching the design.
export type ApprovalSeverity = "low" | "med" | "high";

// Tags used by the dashboard's avatar/border colors. Stored alongside
// the agent so the UI doesn't have to guess from role.
export type AgentColorTag = "info" | "accent" | "success" | "warning" | "danger" | "muted";

// ── Mission ────────────────────────────────────────────────────────────

export interface Mission {
  id: MissionId;
  /** Human-readable short id like "MSN-1042". Stable for the mission's life. */
  shortId: string;
  title: string;
  /** Optional English title — useful in bilingual settings. */
  titleEn?: string;
  desc: string;
  status: MissionStatus;
  mode: MissionMode;
  modeLabel: string;
  /** Owner identifier (the user). For K2 this is informational only. */
  owner: string;
  ownerLabel: string;
  /** Display-or-canonical string. The daemon's FileMissionStore.create
   *  writes an ISO-8601 string here; clients (or future locale-aware
   *  bootstrap helpers) may overwrite with a localized form like
   *  "today 09:31". Either way, `createdAtMs` is the authoritative
   *  sortable timestamp. */
  createdAt: string;
  createdAtMs: number;
  /** Agent IDs participating in the mission. Ordered with coordinator
   *  first when present. */
  agents: AgentId[];
  /** 0..1 progress hint. Mission-author-defined; the daemon doesn't try
   *  to compute it. */
  progress: number;
  pendingApprovals: number;
  blockers: number;
  /** Short labels for the mission card footer (e.g. "3 browser", "1 doc"). */
  contextSummary: string[];
}

export interface CreateMissionInput {
  title: string;
  desc: string;
  mode: MissionMode;
  modeLabel: string;
  owner: string;
  ownerLabel: string;
  agents: AgentId[];
}

// ── Work item ─────────────────────────────────────────────────────────

export interface WorkItem {
  id: WorkItemId;
  missionId: MissionId;
  /** 1-based sequence number within the mission. Used by the dashboard
   *  to render the "01" / "02" gutter. */
  n: number;
  title: string;
  /** Optional secondary line in the work-item row (often Chinese gloss
   *  in the design mocks). */
  cn?: string;
  agent: AgentId;
  status: MissionStatus;
  started: string;
  duration: string;
  /** IDs of context sources this work item depends on. */
  contextRefs: ContextSourceId[];
  output: string;
  progress?: number;
  blocker?: string;
  approvalId?: ApprovalRequestId;
}

// ── Agent ─────────────────────────────────────────────────────────────

export interface Agent {
  id: AgentId;
  name: string;
  nameCn?: string;
  role: string;
  provider: string;
  providerNote: string;
  status: MissionStatus;
  /** Two-character monogram for the avatar. */
  ava: string;
  color: AgentColorTag;
  capabilities: string[];
  missions: number;
  tokensIn: string;
  tokensOut: string;
}

// ── Context source ────────────────────────────────────────────────────

export interface ContextSource {
  id: ContextSourceId;
  kind: ContextKind;
  title: string;
  cn?: string;
  url: string;
  state: string;
  /** Optional display hint (the K1 design fixtures use "Xm ago" style
   *  strings). The daemon does NOT format relative ages — server-emitted
   *  entries leave this empty and populate `lastUseAtMs` instead.
   *  Clients format relative-time on display. K2 fixtures still populate
   *  it for the recorded narrative. */
  lastUse: string;
  /** Monotonic timestamp of the last activity touching this source.
   *  Authoritative for "how long since X" calculations on the client. */
  lastUseAtMs?: number;
  transport?: string;
  session?: string;
  writer?: AgentId;
  counts?: { files: number; snapshots: number; screenshots: number };
}

// ── Activity event ────────────────────────────────────────────────────

export type ActivityEventKind =
  | "plan"
  | "tool"
  | "thought"
  | "browser"
  | "doc"
  | "recovery"
  | "approval"
  | "artifact";

export interface EvidenceRef {
  kind: "snapshot" | "screenshot" | "extract" | "diff" | "json";
  id: string;
  label: string;
}

export interface ActivityEvent {
  id: ActivityEventId;
  missionId: MissionId;
  /** Optional display hint (the K1 design fixtures use "HH:MM:SS"). The
   *  daemon does NOT format this — server-emitted events leave it
   *  unset; clients derive display from `tMs`. K2 demo fixtures still
   *  populate it for the recorded narrative. */
  t?: string;
  /** Monotonic timestamp — used for ordering. */
  tMs: number;
  /** Day header. Only set when this event opens a new day in the timeline. */
  day?: string;
  kind: ActivityEventKind;
  actor: AgentId;
  target?: ContextSourceId;
  /** Free-form text. May contain limited HTML in K2 (the design uses <b>,
   *  <code> for emphasis) — sanitized on the dashboard side. K3 will
   *  replace with structured nodes. */
  text: string;
  evidence?: EvidenceRef[];
  tags?: string[];
  /** Visual emphasis — drives banner color on the dashboard timeline. */
  emph?: "warn" | "danger" | "success";
  /** Bag of runtime hints (transport, session id, byte counts). The
   *  dashboard only renders when the user toggles "show runtime". */
  runtime?: Record<string, string>;
  approvalId?: ApprovalRequestId;
}

// ── Approval request ──────────────────────────────────────────────────

export interface ApprovalRequest {
  id: ApprovalRequestId;
  severity: ApprovalSeverity;
  missionId: MissionId;
  missionTitle: string;
  agent: AgentId;
  /** Capability path the agent wants to invoke, e.g. "browser.form.submit". */
  action: string;
  title: string;
  cn?: string;
  affects: ContextSourceId[];
  risk: string;
  /** Display string for when the request was filed. */
  requestedAt: string;
  requestedAtMs: number;
  requestedAgo: string;
  policyHint: string;
  payload?: Record<string, unknown>;
}

export type ApprovalDecisionKind = "approved" | "denied";

export interface ApprovalDecision {
  approvalId: ApprovalRequestId;
  decision: ApprovalDecisionKind;
  /** Who decided. For K2 this is the local operator name (free-form). */
  decidedBy: string;
  decidedAtMs: number;
  /** Optional structured reason for denials. */
  reason?: string;
}

// ── Artifact ──────────────────────────────────────────────────────────

export interface Artifact {
  id: ArtifactId;
  missionId: MissionId;
  /** Inline label shown in the timeline ("evidence/notion_pricing.json"). */
  label: string;
  kind: "report" | "screenshot" | "snapshot" | "extract" | "diff" | "json" | "zip" | "other";
  /** Logical path or URL the artifact lives at. */
  path: string;
  sizeBytes?: number;
  sha?: string;
  createdAtMs: number;
}

// ── Combined cluster the dashboard fetches per-mission ────────────────

export interface MissionTimeline {
  missionId: MissionId;
  events: ActivityEvent[];
}

export interface MissionWorkItems {
  missionId: MissionId;
  items: WorkItem[];
}

export interface MissionArtifacts {
  missionId: MissionId;
  artifacts: Artifact[];
}

// ── Store contracts ───────────────────────────────────────────────────
// File-backed stores implement these in @turnkeyai/mission-store. The
// daemon composes them via composition/mission-deps.ts and the route
// handler in routes/mission-routes.ts consumes them.

export interface MissionStore {
  get(id: MissionId): Promise<Mission | null>;
  list(): Promise<Mission[]>;
  create(input: CreateMissionInput, ids: { missionIdGen: () => MissionId; shortIdGen: () => string; clock: { now(): number } }): Promise<Mission>;
}

export interface WorkItemStore {
  listByMission(missionId: MissionId): Promise<WorkItem[]>;
  put(item: WorkItem): Promise<void>;
}

export interface ActivityEventStore {
  listByMission(missionId: MissionId, options?: { limit?: number }): Promise<ActivityEvent[]>;
  append(event: ActivityEvent): Promise<void>;
}

export interface ApprovalRequestStore {
  list(): Promise<ApprovalRequest[]>;
  listByMission(missionId: MissionId): Promise<ApprovalRequest[]>;
  put(approval: ApprovalRequest): Promise<void>;
  /** Look up a decision if one has been recorded. K2 only reads;
   *  decisions are recorded by K4. */
  getDecision(id: ApprovalRequestId): Promise<ApprovalDecision | null>;
  /** Bulk-load every recorded decision in a single pass. Used by the
   *  /approvals route to avoid N+1 reads when joining. */
  listDecisions(): Promise<ApprovalDecision[]>;
}

export interface ArtifactStore {
  listByMission(missionId: MissionId): Promise<Artifact[]>;
  put(artifact: Artifact): Promise<void>;
}

export interface AgentRegistry {
  list(): Promise<Agent[]>;
}

export interface ContextSourceRegistry {
  list(): Promise<ContextSource[]>;
}
