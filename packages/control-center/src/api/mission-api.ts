// Typed Mission Control API client (PR K2 swap).
//
// Re-exports the daemon's mission types so the dashboard imports them
// from one place. The types here are the truth — they match
// packages/core-types/src/mission-core.ts on the daemon side. (We
// don't import the core-types module directly because the control-center
// workspace is a separate TS project; copying the type definitions is
// the standard pattern for our dashboard, same as api/types.ts does for
// BridgeStatus/Diagnostics.)

import type { ApiError } from "./client";

// ── Lifecycle / enums ─────────────────────────────────────────────────

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

export type ApprovalSeverity = "low" | "med" | "high";

export type AgentColorTag =
  | "info"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "muted";

// ── Mission ───────────────────────────────────────────────────────────

export interface Mission {
  id: string;
  shortId: string;
  title: string;
  titleEn?: string;
  desc: string;
  status: MissionStatus;
  mode: MissionMode;
  modeLabel: string;
  owner: string;
  ownerLabel: string;
  createdAt: string;
  createdAtMs: number;
  agents: string[];
  progress: number;
  pendingApprovals: number;
  blockers: number;
  contextSummary: string[];
}

export interface WorkItem {
  id: string;
  missionId: string;
  n: number;
  title: string;
  cn?: string;
  agent: string;
  status: MissionStatus;
  started: string;
  duration: string;
  contextRefs: string[];
  output: string;
  progress?: number;
  blocker?: string;
  approvalId?: string;
}

export interface Agent {
  id: string;
  name: string;
  nameCn?: string;
  role: string;
  provider: string;
  providerNote: string;
  status: MissionStatus;
  ava: string;
  color: AgentColorTag;
  capabilities: string[];
  missions: number;
  tokensIn: string;
  tokensOut: string;
}

export interface ContextSource {
  id: string;
  kind: ContextKind;
  title: string;
  cn?: string;
  url: string;
  state: string;
  lastUse: string;
  transport?: string;
  session?: string;
  writer?: string;
  counts?: { files: number; snapshots: number; screenshots: number };
}

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
  id: string;
  missionId: string;
  t: string;
  tMs: number;
  day?: string;
  kind: ActivityEventKind;
  actor: string;
  target?: string;
  text: string;
  evidence?: EvidenceRef[];
  tags?: string[];
  emph?: "warn" | "danger" | "success";
  runtime?: Record<string, string>;
  approvalId?: string;
}

export interface ApprovalRequest {
  id: string;
  severity: ApprovalSeverity;
  missionId: string;
  missionTitle: string;
  agent: string;
  action: string;
  title: string;
  cn?: string;
  affects: string[];
  risk: string;
  requestedAt: string;
  requestedAtMs: number;
  requestedAgo: string;
  policyHint: string;
}

export interface ApprovalDecision {
  approvalId: string;
  decision: "approved" | "denied";
  decidedBy: string;
  decidedAtMs: number;
}

/** /approvals attaches the decision (or null) per row. */
export interface ApprovalRow extends ApprovalRequest {
  decision: ApprovalDecision | null;
}

// ── Artifact ──────────────────────────────────────────────────────────

export interface Artifact {
  id: string;
  missionId: string;
  label: string;
  kind:
    | "report"
    | "screenshot"
    | "snapshot"
    | "extract"
    | "diff"
    | "json"
    | "zip"
    | "other";
  path: string;
  sizeBytes?: number;
  sha?: string;
  createdAtMs: number;
}

// ── Bootstrap helper ──────────────────────────────────────────────────

export interface BootstrapDemoResult {
  ok: true;
  missions: number;
  workItems: number;
  approvals: number;
  timeline: number;
  agents: number;
  contextSources: number;
}

// Re-export the ApiError type so callers don't need a separate import.
export type { ApiError };
