import type { RoleId, RunKey, TaskId, ThreadId, WorkerKind } from "./team-core";
import type { FailureSummary } from "./team-replay-types";

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
  | "hover"
  | "key"
  | "select"
  | "drag"
  | "scroll"
  | "console"
  | "probe"
  | "permission"
  | "wait"
  | "waitFor"
  | "dialog"
  | "popup"
  | "storage"
  | "cookie"
  | "eval"
  | "network"
  | "upload"
  | "download"
  | "screenshot"
  | "cdp";

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
export type BrowserProbeKind = "page-state" | "forms" | "links" | "downloads";
export type BrowserPermissionName =
  | "geolocation"
  | "notifications"
  | "camera"
  | "microphone"
  | "clipboard-read"
  | "clipboard-write";

export const MAX_BROWSER_CDP_ACTION_TIMEOUT_MS = 30_000;
export const MAX_BROWSER_CDP_ACTION_PARAMS_BYTES = 64 * 1024;
export const MAX_BROWSER_CDP_ACTION_EVENT_NAMES = 20;
export const MAX_BROWSER_CDP_ACTION_EVENTS = 20;
export const MAX_BROWSER_CDP_ACTION_EVENT_TIMEOUT_MS = 30_000;
export const MAX_BROWSER_CDP_EVENT_PARAMS_BYTES = 8 * 1024;
export const MAX_BROWSER_KEY_ACTION_KEY_LENGTH = 64;
export const DEFAULT_BROWSER_WAIT_FOR_TIMEOUT_MS = 5_000;
export const MAX_BROWSER_WAIT_FOR_TIMEOUT_MS = 60_000;
export const MAX_BROWSER_WAIT_FOR_PATTERN_LENGTH = 2_048;
export const DEFAULT_BROWSER_DIALOG_TIMEOUT_MS = 5_000;
export const MAX_BROWSER_DIALOG_TIMEOUT_MS = 60_000;
export const DEFAULT_BROWSER_POPUP_TIMEOUT_MS = 5_000;
export const MAX_BROWSER_POPUP_TIMEOUT_MS = 60_000;
export const MAX_BROWSER_STORAGE_KEY_LENGTH = 1_024;
export const MAX_BROWSER_STORAGE_VALUE_BYTES = 64 * 1024;
export const MAX_BROWSER_STORAGE_READ_VALUE_BYTES = 8 * 1024;
export const MAX_BROWSER_STORAGE_READ_ENTRIES = 100;
export const MAX_BROWSER_COOKIE_NAME_LENGTH = 512;
export const MAX_BROWSER_COOKIE_VALUE_BYTES = 4 * 1024;
export const MAX_BROWSER_COOKIE_READ_VALUE_BYTES = 2 * 1024;
export const MAX_BROWSER_COOKIE_READ_ENTRIES = 100;
export const MAX_BROWSER_EVAL_EXPRESSION_BYTES = 16 * 1024;
export const MAX_BROWSER_EVAL_RESULT_BYTES = 8 * 1024;
export const DEFAULT_BROWSER_EVAL_TIMEOUT_MS = 5_000;
export const MAX_BROWSER_EVAL_TIMEOUT_MS = 30_000;
export const MAX_BROWSER_NETWORK_URL_PATTERN_LENGTH = 2_048;
export const MAX_BROWSER_NETWORK_URL_PATTERNS = 20;
export const MAX_BROWSER_NETWORK_METHOD_LENGTH = 16;
export const DEFAULT_BROWSER_NETWORK_TIMEOUT_MS = 10_000;
export const MAX_BROWSER_NETWORK_TIMEOUT_MS = 60_000;
export const MAX_BROWSER_NETWORK_BODY_BYTES = 64 * 1024;
export const MAX_BROWSER_NETWORK_HEADER_ENTRIES = 100;
export const MAX_BROWSER_NETWORK_HEADER_NAME_LENGTH = 128;
export const MAX_BROWSER_NETWORK_HEADER_VALUE_BYTES = 2 * 1024;
export const MAX_BROWSER_NETWORK_LATENCY_MS = 120_000;
export const MAX_BROWSER_NETWORK_THROUGHPUT_BYTES_PER_SEC = 1024 * 1024 * 1024;
export const MAX_BROWSER_DOWNLOAD_URL_PATTERN_LENGTH = 2_048;
export const DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS = 10_000;
export const MAX_BROWSER_DOWNLOAD_TIMEOUT_MS = 120_000;
export const MAX_BROWSER_DOWNLOAD_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_BROWSER_UPLOAD_ARTIFACT_ID_LENGTH = 512;
export const MAX_BROWSER_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_BROWSER_UPLOAD_FILE_NAME_LENGTH = 255;
export const MAX_BROWSER_PROBE_ITEMS = 50;
export const MAX_BROWSER_PERMISSION_ORIGIN_LENGTH = 2_048;

const BROWSER_CDP_METHOD_PATTERN = /^[A-Z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;
const BLOCKED_BROWSER_CDP_METHOD_PREFIXES = ["Browser.", "Target."];

export function normalizeBrowserCdpMethod(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return BROWSER_CDP_METHOD_PATTERN.test(trimmed) ? trimmed : null;
}

export function isBlockedBrowserCdpMethod(method: string): boolean {
  return BLOCKED_BROWSER_CDP_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}

export interface BrowserCdpEventOptions {
  waitFor?: string;
  include?: string[];
  timeoutMs?: number;
  maxEvents?: number;
}

export type BrowserClickAction =
  | { kind: "click"; selectors: string[]; refId?: never; text?: never }
  | { kind: "click"; refId: string; selectors?: never; text?: never }
  | { kind: "click"; text: string; selectors?: never; refId?: never };

export type BrowserHoverAction =
  | { kind: "hover"; selectors: string[]; refId?: never; text?: never }
  | { kind: "hover"; refId: string; selectors?: never; text?: never }
  | { kind: "hover"; text: string; selectors?: never; refId?: never };

export type BrowserKeyModifier = "Alt" | "Control" | "Meta" | "Shift";

export type BrowserSelectOption =
  | { value: string; label?: never; index?: never }
  | { label: string; value?: never; index?: never }
  | { index: number; value?: never; label?: never };

export type BrowserSelectAction =
  | ({ kind: "select"; selectors: string[]; refId?: never } & BrowserSelectOption)
  | ({ kind: "select"; refId: string; selectors?: never } & BrowserSelectOption);

export type BrowserActionTarget =
  | { selectors: string[]; refId?: never; text?: never }
  | { refId: string; selectors?: never; text?: never }
  | { text: string; selectors?: never; refId?: never };

export type BrowserDragAction = {
  kind: "drag";
  source: BrowserActionTarget;
  target: BrowserActionTarget;
};

export type BrowserWaitForState = "visible" | "hidden" | "attached" | "detached";

export type BrowserWaitForAction =
  | ({ kind: "waitFor"; timeoutMs?: number; state?: BrowserWaitForState } & BrowserActionTarget)
  | { kind: "waitFor"; timeoutMs?: number; urlPattern: string }
  | { kind: "waitFor"; timeoutMs?: number; titlePattern: string }
  | { kind: "waitFor"; timeoutMs?: number; bodyTextPattern: string };

export type BrowserDialogAction = {
  kind: "dialog";
  action: "accept" | "dismiss";
  promptText?: string;
  timeoutMs?: number;
};

export type BrowserPopupAction = {
  kind: "popup";
  timeoutMs?: number;
};

export type BrowserStorageArea = "localStorage" | "sessionStorage";

export type BrowserStorageAction =
  | { kind: "storage"; area: BrowserStorageArea; action: "get"; key?: string }
  | { kind: "storage"; area: BrowserStorageArea; action: "set"; key: string; value: string }
  | { kind: "storage"; area: BrowserStorageArea; action: "remove"; key: string }
  | { kind: "storage"; area: BrowserStorageArea; action: "clear" };

export type BrowserCookieSameSite = "Strict" | "Lax" | "None";

export type BrowserCookieAction =
  | { kind: "cookie"; action: "get"; name?: string; url?: string }
  | {
      kind: "cookie";
      action: "set";
      name: string;
      value: string;
      url?: string;
      domain?: string;
      path?: string;
      secure?: boolean;
      httpOnly?: boolean;
      sameSite?: BrowserCookieSameSite;
      expires?: number;
    }
  | { kind: "cookie"; action: "remove"; name: string; url?: string; domain?: string; path?: string }
  | { kind: "cookie"; action: "clear"; url?: string; domain?: string; path?: string };

export type BrowserEvalAction = {
  kind: "eval";
  expression: string;
  awaitPromise?: boolean;
  timeoutMs?: number;
};

export type BrowserNetworkAction =
  | {
      kind: "network";
      action: "waitForRequest";
      urlPattern?: string;
      method?: string;
      timeoutMs?: number;
      includeHeaders?: boolean;
      maxBodyBytes?: number;
    }
  | {
      kind: "network";
      action: "waitForResponse";
      urlPattern?: string;
      method?: string;
      status?: number;
      timeoutMs?: number;
      includeHeaders?: boolean;
      maxBodyBytes?: number;
    }
  | {
      kind: "network";
      action: "blockUrls";
      urlPatterns: string[];
    }
  | {
      kind: "network";
      action: "clearBlockedUrls";
    }
  | {
      kind: "network";
      action: "setExtraHeaders";
      headers: Record<string, string>;
    }
  | {
      kind: "network";
      action: "clearExtraHeaders";
    }
  | {
      kind: "network";
      action: "mockResponse";
      urlPattern: string;
      method?: string;
      status?: number;
      headers?: Record<string, string>;
      body?: string;
      bodyBase64?: string;
      timeoutMs?: number;
    }
  | {
      kind: "network";
      action: "clearMockResponses";
    }
  | {
      kind: "network";
      action: "emulateConditions";
      offline?: boolean;
      latencyMs?: number;
      downloadThroughputBytesPerSec?: number;
      uploadThroughputBytesPerSec?: number;
    }
  | {
      kind: "network";
      action: "clearEmulation";
    };

export type BrowserDownloadAction = {
  kind: "download";
  urlPattern?: string;
  timeoutMs?: number;
};

export interface BrowserUploadFilePayload {
  name: string;
  mimeType?: string;
  dataBase64: string;
  sizeBytes: number;
}

export type BrowserUploadAction = {
  kind: "upload";
  artifactId: string;
  file?: BrowserUploadFilePayload;
} & BrowserActionTarget;

export type BrowserProbeAction = {
  kind: "probe";
  probe: BrowserProbeKind;
  maxItems?: number;
};

export type BrowserPermissionAction =
  | {
      kind: "permission";
      action: "grant" | "deny";
      permissions: BrowserPermissionName[];
      origin?: string;
    }
  | {
      kind: "permission";
      action: "reset";
      permissions?: never;
      origin?: never;
    };

export type BrowserTaskAction =
  | { kind: "open"; url: string }
  | { kind: "snapshot"; note?: string }
  | { kind: "type"; selectors?: string[]; refId?: string; text: string; submit?: boolean }
  | BrowserClickAction
  | BrowserHoverAction
  | { kind: "key"; key: string; modifiers?: BrowserKeyModifier[] }
  | BrowserSelectAction
  | BrowserDragAction
  | { kind: "scroll"; direction: "up" | "down"; amount?: number }
  | { kind: "console"; probe: BrowserConsoleProbe }
  | BrowserProbeAction
  | BrowserPermissionAction
  | { kind: "wait"; timeoutMs: number }
  | BrowserWaitForAction
  | BrowserDialogAction
  | BrowserPopupAction
  | BrowserStorageAction
  | BrowserCookieAction
  | BrowserEvalAction
  | BrowserNetworkAction
  | BrowserDownloadAction
  | BrowserUploadAction
  | { kind: "screenshot"; label?: string }
  | {
      kind: "cdp";
      method: string;
      params?: Record<string, unknown>;
      timeoutMs?: number;
      events?: BrowserCdpEventOptions;
    };

export const BROWSER_LONG_CHAIN_ACTION_KINDS = [
  "click",
  "type",
  "hover",
  "key",
  "select",
  "drag",
  "waitFor",
  "dialog",
  "probe",
  "storage",
  "cookie",
  "eval",
  "network",
  "download",
  "upload",
  "scroll",
  "console",
  "snapshot",
  "cdp",
] as const satisfies readonly BrowserTaskAction["kind"][];

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
  | "action_inflight"
  | "claim_reclaimed"
  | "content_script_unavailable"
  | "action_timeout"
  | "action_failed"
  | "endpoint_unreachable"
  | "target_not_found"
  | "attach_failed"
  | "expert_session_detached"
  | "cdp_command_timeout"
  | "browser_cdp_unavailable"
  | "protocol_mode_mismatch"
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
  type: "snapshot" | "screenshot" | "console-result" | "downloaded-file" | "upload-file" | "trace";
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
