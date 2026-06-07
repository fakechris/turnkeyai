import type {
  BrowserPageResult,
  BrowserSession,
  BrowserSessionHistoryEntry,
  BrowserSessionOwnerType,
  BrowserSessionResumeInput,
  BrowserSessionSendInput,
  BrowserSessionSpawnInput,
  BrowserSessionStatus,
  BrowserTarget,
  BrowserTaskRequest,
  BrowserTaskResult,
  BrowserTransportMode,
} from "./browser";
import type { RunKey } from "./team-core";

export interface BrowserSessionRuntime {
  spawnSession(input: BrowserSessionSpawnInput): Promise<BrowserTaskResult>;
  sendSession(input: BrowserSessionSendInput): Promise<BrowserTaskResult>;
  resumeSession(input: BrowserSessionResumeInput): Promise<BrowserTaskResult>;
  getSessionHistory(input: { browserSessionId: string; limit?: number }): Promise<BrowserSessionHistoryEntry[]>;
}

export interface BrowserBridge extends BrowserSessionRuntime {
  inspectPublicPage(url: string): Promise<BrowserPageResult>;
  runTask(input: BrowserTaskRequest): Promise<BrowserTaskResult>;
  listSessions(input?: { ownerType?: BrowserSessionOwnerType; ownerId?: string }): Promise<BrowserSession[]>;
  listTargets(browserSessionId: string): Promise<BrowserTarget[]>;
  openTarget(
    browserSessionId: string,
    url: string,
    owner?: { ownerType?: BrowserSessionOwnerType; ownerId?: string; timeoutMs?: number }
  ): Promise<BrowserTarget>;
  activateTarget(
    browserSessionId: string,
    targetId: string,
    owner?: { ownerType?: BrowserSessionOwnerType; ownerId?: string }
  ): Promise<BrowserTarget>;
  closeTarget(
    browserSessionId: string,
    targetId: string,
    owner?: { ownerType?: BrowserSessionOwnerType; ownerId?: string }
  ): Promise<BrowserTarget>;
  evictIdleSessions(input: { idleBefore: number; reason?: string }): Promise<BrowserSession[]>;
  closeSession(browserSessionId: string, reason?: string): Promise<void>;
}

export interface BrowserExpertTargetInfo {
  targetId: string;
  type: string;
  title?: string;
  url?: string;
  attached: boolean;
  openerId?: string;
  openerFrameId?: string;
  browserContextId?: string;
  subtype?: string;
  matchingBrowserTargetIds?: string[];
}

export interface BrowserExpertAttachedSession {
  expertSessionId: string;
  browserSessionId: string;
  targetId: string;
  attachedAt: number;
}

export interface BrowserExpertEvent {
  expertSessionId?: string;
  method: string;
  params?: Record<string, unknown>;
  receivedAt: number;
}

export interface BrowserExpertCommandResult {
  method: string;
  scope: "root" | "attached";
  expertSessionId?: string;
  targetId?: string;
  result: unknown;
}

export type BrowserSessionOwnershipFailureReason =
  | "missing_session"
  | "wrong_owner"
  | "closed"
  | "wrong_lease_holder";

export interface BrowserSessionOwnershipRequest {
  browserSessionId: string;
  ownerType?: BrowserSessionOwnerType;
  ownerId?: string;
  leaseHolderRunKey?: RunKey;
}

export interface BrowserSessionOwnershipLeaseSnapshot {
  leaseHolderRunKey?: RunKey;
  leaseExpiresAt?: number;
  leaseActive: boolean;
}

export interface BrowserSessionOwnershipResult {
  browserSessionId: string;
  ok: boolean;
  reason?: BrowserSessionOwnershipFailureReason;
  owner?: { ownerType: BrowserSessionOwnerType; ownerId: string };
  lease?: BrowserSessionOwnershipLeaseSnapshot;
  status?: BrowserSessionStatus;
  checkedAt: number;
}

export interface BrowserTransportHealth {
  transportMode: BrowserTransportMode;
  transportLabel: string;
  healthy: boolean;
  reason?: string;
  endpoint?: string;
  peerCount?: number;
  activePeerCount?: number;
  connected?: boolean;
  checkedAt: number;
}

export interface BrowserTransportReconnectRequest {
  browserSessionId?: string;
  reason?: string;
}

export interface BrowserTransportReconnectResult {
  transportMode: BrowserTransportMode;
  ok: boolean;
  reason?: string;
  invalidatedConnection?: boolean;
  peerCount?: number;
  reconnectedAt: number;
}

export interface BrowserRawCdpExpertLane {
  listExpertTargets(browserSessionId: string): Promise<BrowserExpertTargetInfo[]>;
  attachExpertTarget(input: {
    browserSessionId: string;
    targetId: string;
  }): Promise<BrowserExpertAttachedSession>;
  detachExpertSession(input: {
    browserSessionId: string;
    expertSessionId: string;
  }): Promise<{
    browserSessionId: string;
    expertSessionId: string;
    targetId: string;
    detached: boolean;
  }>;
  sendExpertCommand(input: {
    browserSessionId: string;
    method: string;
    params?: Record<string, unknown>;
    expertSessionId?: string;
    targetId?: string;
    timeoutMs?: number;
  }): Promise<BrowserExpertCommandResult>;
  drainExpertEvents(input: {
    browserSessionId: string;
    expertSessionId?: string;
    limit?: number;
  }): Promise<BrowserExpertEvent[]>;
}
