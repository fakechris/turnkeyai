import type {
  BrowserActionTrace,
  BrowserSnapshotResult,
  BrowserTaskAction,
} from "@turnkeyai/core-types/team";

export type RelayExecutableBrowserAction = Extract<
  BrowserTaskAction,
  { kind: "open" | "snapshot" | "click" | "type" | "hover" | "key" | "select" | "drag" | "scroll" | "console" | "probe" | "permission" | "wait" | "waitFor" | "dialog" | "popup" | "storage" | "cookie" | "eval" | "network" | "download" | "upload" | "screenshot" | "cdp" }
>;

export interface RelayScreenshotPayload {
  label?: string;
  mimeType: string;
  dataBase64: string;
}

export interface RelayDownloadPayload {
  url: string;
  fileName: string;
  mimeType?: string;
  dataBase64: string;
  sizeBytes: number;
}

export interface RelayPeerRegistration {
  peerId: string;
  label?: string;
  capabilities?: string[];
  transportLabel?: string;
}

export interface RelayPeerRecord {
  peerId: string;
  label?: string;
  capabilities: string[];
  transportLabel?: string;
  registeredAt: number;
  lastSeenAt: number;
  status: "online" | "stale";
}

export interface RelayTargetReport {
  relayTargetId: string;
  url: string;
  title?: string;
  status?: "open" | "attached" | "detached" | "closed";
}

export interface RelayTargetRecord extends RelayTargetReport {
  peerId: string;
  lastSeenAt: number;
}

export type RelayActionRequestState = "pending" | "inflight";

export interface RelayActionRequest {
  actionRequestId: string;
  peerId: string;
  browserSessionId: string;
  taskId: string;
  targetBehavior?: "new";
  relayTargetId?: string;
  targetId?: string;
  actions: RelayExecutableBrowserAction[];
  createdAt: number;
  expiresAt: number;
  claimToken?: string;
  claimedAt?: number;
  claimExpiresAt?: number;
  attemptCount?: number;
  reclaimCount?: number;
}

export interface RelayActionResult {
  actionRequestId: string;
  peerId: string;
  browserSessionId: string;
  taskId: string;
  relayTargetId: string;
  url: string;
  claimToken: string;
  title?: string;
  status: "completed" | "failed";
  page?: BrowserSnapshotResult;
  trace: BrowserActionTrace[];
  screenshotPaths: string[];
  screenshotPayloads: RelayScreenshotPayload[];
  downloadPayloads?: RelayDownloadPayload[];
  artifactIds: string[];
  errorMessage?: string;
}

export interface RelayActionRequestRecord {
  actionRequestId: string;
  browserSessionId: string;
  taskId: string;
  targetBehavior?: RelayActionRequest["targetBehavior"];
  relayTargetId?: string;
  targetId?: string;
  actionKinds: RelayExecutableBrowserAction["kind"][];
  createdAt: number;
  expiresAt: number;
  state: RelayActionRequestState;
  preferredPeerId?: string;
  lockedPeerId?: string;
  assignedPeerId?: string;
  claimToken?: string;
  claimedAt?: number;
  claimExpiresAt?: number;
  attemptCount: number;
  reclaimCount: number;
  lastClaimExpiredAt?: number;
}
