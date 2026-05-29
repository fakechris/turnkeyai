// API response types. Names + shapes deliberately match the daemon's
// route handlers under packages/app-gateway/src/routes/*. When adding a
// new endpoint to the dashboard, ALSO mirror the daemon's shape here
// rather than `unknown`-ing fields — typed end-to-end is the point.

// --- /bridge/status (packages/app-gateway/src/routes/bridge-routes.ts) ---

export type TransportMode = "local" | "relay" | "direct-cdp";

export interface BridgeStatus {
  ok: boolean;
  port: number;
  version: string;
  dataDir: string;
  logsPath: string;
  configFile: string;
  transport: {
    mode: TransportMode;
    label: string;
  };
  relay: {
    configured: boolean;
    peerCount: number;
    targetCount: number;
    lastHeartbeatAgeMs: number | null;
    actionRequestQueueDepth: number;
  };
  directCdp: {
    configured: boolean;
    endpoint: string | null;
  };
  expertLane: {
    available: boolean;
    reason?: string;
  };
  sessions: {
    count: number;
  };
}

// --- /threads (packages/app-gateway/src/composition/inspection-deps.ts) ---

export interface ThreadSummary {
  threadId: string;
  teamId: string;
  teamName: string;
  leadRoleId: string;
  roles: Array<{
    roleId: string;
    name: string;
    seat: "lead" | "member";
  }>;
  createdAt: number;
  updatedAt: number;
}

// --- /relay/targets ---

export interface RelayTarget {
  relayTargetId: string;
  url: string;
  title?: string;
  status?: "open" | "attached" | "detached" | "closed";
  peerId: string;
  lastSeenAt: number;
}

// --- /diagnostics (packages/app-gateway/src/routes/diagnostics-routes.ts) ---

export interface DiagnosticsSnapshot {
  daemon: {
    version: string;
    port: number;
    startedAt: number;
    uptimeMs: number;
    authMode: "disabled" | "token" | "token-layered";
  };
  paths: {
    runtimeRoot: string;
    dataDir: string;
    configFile: string;
    logFile: string;
    modelCatalogPath: string | null;
    logFileBytes: number | null;
    logFileModifiedAt: number | null;
  };
  transport: {
    mode: TransportMode;
    label: string;
  };
  counters: {
    sessionCount: number;
    relayPeerCount: number;
    relayTargetCount: number;
  };
  node: {
    version: string;
    platform: string;
    arch: string;
  };
  readiness?: {
    status: "ok" | "warn" | "error";
    checks: Array<{
      id: string;
      label: string;
      status: "ok" | "warn" | "error";
      detail: string;
      action?: string;
    }>;
  };
}

export interface DiagnosticsLogs {
  logFile: string;
  limit: number;
  lineCount: number;
  lines: string[];
  truncatedFromHead?: boolean;
  redacted?: boolean;
  note?: string;
}
