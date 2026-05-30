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
    health?: {
      transportMode: TransportMode;
      transportLabel: string;
      healthy: boolean;
      reason?: string;
      endpoint?: string;
      peerCount?: number;
      activePeerCount?: number;
      connected?: boolean;
      checkedAt: number;
    };
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
  missionHealth?: DiagnosticsMissionHealthSnapshot;
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

export interface DiagnosticsMissionHealthSnapshot {
  total: number;
  inspected: number;
  byStatus: Record<"draft" | "planning" | "working" | "needs_approval" | "blocked" | "done" | "archived", number>;
  active: number;
  terminal: number;
  needsApproval: number;
  withBlockers: number;
  snapshotErrorCount: number;
  latestMission?: {
    id: string;
    title: string;
    status: "draft" | "planning" | "working" | "needs_approval" | "blocked" | "done" | "archived";
    createdAtMs: number;
  };
  qualityGate: {
    running: number;
    passed: number;
    needsAttention: number;
    blocked: number;
  };
  tool: {
    requested: number;
    executed: number;
    failed: number;
    cancelled: number;
    timeouts: number;
  };
  sessions: {
    spawned: number;
    continued: number;
  };
  liveness: {
    active: number;
    waiting: number;
    stale: number;
  };
  recoveryEvents: number;
  attentionMissions: Array<{
    id: string;
    title: string;
    status: "draft" | "planning" | "working" | "needs_approval" | "blocked" | "done" | "archived";
    qualityGateStatus: "running" | "passed" | "needs_attention" | "blocked";
    pendingApprovals: number;
    blockers: number;
    toolFailures: number;
    toolTimeouts: number;
    recoveryEvents: number;
    staleRuntimeSubjects: number;
    lastProgressAtMs?: number;
  }>;
}

// --- /onboarding/state (packages/app-gateway/src/routes/onboarding-routes.ts) ---

export interface OnboardingState {
  completedAt: number | null;
  transportChosen: string | null;
  transportVerifiedAt: number | null;
  step: string | null;
  updatedAt: number | null;
}

// --- /models (packages/app-gateway/src/routes/inspection-routes.ts) ---

export interface ModelsReport {
  modelCatalogPath: string | null;
  adapterMode: "heuristic-only" | "llm+heuristic-fallback" | string;
  modelChains?: Array<{
    id: string;
    primary: string;
    fallbacks: string[];
  }>;
  defaultSelection?: {
    ok: boolean;
    chainId?: string;
    primaryModelId?: string;
    fallbackModelIds?: string[];
    error?: string;
  };
  models: Array<{
    id: string;
    label: string;
    providerId: string;
    protocol: "openai-compatible" | "anthropic-compatible" | string;
    model: string;
    apiKeyEnv: string;
    configured: boolean;
    enabled?: boolean;
    aliases?: string[];
    baseURL?: string;
    baseURLEnv?: string;
  }>;
}

export interface ModelCatalogConfigReport {
  currentModelCatalogPath: string | null;
  editableModelCatalogPath: string;
  exists: boolean;
  content: string;
  saved?: boolean;
  restartRequired: boolean;
  liveReloadAvailable: boolean;
  validation: {
    ok: boolean;
    errors: string[];
    warnings: string[];
    modelCount: number;
    chainCount: number;
    missingApiKeyEnvs: string[];
    missingBaseUrlEnvs: string[];
  };
}

// --- /capabilities (packages/app-gateway/src/routes/inspection-routes.ts) ---

export interface CapabilityInspectionReport {
  availableWorkers: string[];
  toolCapabilities?: Array<{
    name: string;
    executorKind: string;
    promptGroup: string;
  }>;
  connectorStates: Array<{
    provider: string;
    available: boolean;
    authorized: boolean;
    issues?: string[];
    suggestedActions?: string[];
  }>;
  apiStates: Array<{
    name: string;
    configured: boolean;
    ready: boolean;
    issues?: string[];
    suggestedActions?: string[];
  }>;
  skillStates: Array<{
    skillId: string;
    installed: boolean;
  }>;
  transportPreferences: Array<{
    capability: string;
    orderedTransports: string[];
  }>;
  unavailableCapabilities: string[];
  generatedAt: number;
}

// --- /runtime-summary (packages/app-gateway/src/routes/inspection-routes.ts) ---

export interface RuntimeSummaryEntry {
  chainId: string;
  threadId: string;
  rootKind: string;
  rootId: string;
  phase: string;
  canonicalState: string;
  continuityState?: string;
  attention: boolean;
  updatedAt: number;
  stale?: boolean;
  staleReason?: string;
  activeSubjectKind?: string;
  activeSubjectId?: string;
  waitingReason?: string;
  currentWaitingPoint?: string;
  caseKey?: string;
  caseState?: string;
  headline?: string;
  nextStep?: string;
  truthState?: string;
  truthSource?: string;
  remediation?: string[];
}

export interface RuntimeSummaryReport {
  totalChains: number;
  activeCount: number;
  waitingCount: number;
  failedCount: number;
  resolvedCount: number;
  staleCount: number;
  attentionCount: number;
  stateCounts: Record<string, number>;
  continuityCounts: Record<string, number>;
  caseStateCounts: Record<string, number>;
  attentionChains: RuntimeSummaryEntry[];
  activeChains: RuntimeSummaryEntry[];
  waitingChains: RuntimeSummaryEntry[];
  staleChains: RuntimeSummaryEntry[];
  failedChains: RuntimeSummaryEntry[];
  recentlyResolved: RuntimeSummaryEntry[];
  workerSessionHealth?: {
    totalSessions: number;
    activeSessions: number;
    orphanedSessions: number;
    missingContextSessions: number;
  };
}

// --- /validation-ops (packages/app-gateway/src/routes/validation-routes.ts) ---

export type ValidationOpsStatus = "passed" | "failed" | "missing";
export type ValidationOpsClosedLoopStatus =
  | "completed"
  | "actionable"
  | "silent_failure"
  | "ambiguous_failure";
export type ValidationOpsBaselineStatus = "fresh-passing" | "fresh-failing" | "stale" | "missing";

export interface ValidationOpsReadinessGate {
  gateId: "phase1-e2e-profile" | "real-llm-acceptance" | "release-readiness" | "transport-soak" | "soak-series";
  title: string;
  status: ValidationOpsStatus;
  summary: string;
  commandHint: string;
  latestRunId?: string;
  recordedAt?: number;
}

export interface ValidationOpsRunRecord {
  runId: string;
  runType:
    | "release-readiness"
    | "validation-profile"
    | "soak-series"
    | "transport-soak"
    | "phase1-baseline"
    | "real-llm-acceptance";
  title: string;
  status: "passed" | "failed";
  completedAt: number;
  durationMs: number;
  issueCount: number;
  artifactPath?: string;
}

export interface ValidationOpsReport {
  totalRuns: number;
  failedRuns: number;
  passedRuns: number;
  attentionCount: number;
  latestRuns: ValidationOpsRunRecord[];
  activeIssues: Array<{
    issueId: string;
    kind: string;
    scope: string;
    summary: string;
    bucket: string;
    severity: "warning" | "critical";
    recommendedAction: string;
    commandHint: string;
    runId: string;
    runType: string;
    title: string;
    recordedAt: number;
  }>;
  readiness: {
    status: ValidationOpsStatus;
    summary: string;
    passedGates: number;
    failedGates: number;
    missingGates: number;
    nextCommand: string;
    gates: ValidationOpsReadinessGate[];
  };
  closedLoop: {
    closedLoopStatus: ValidationOpsClosedLoopStatus;
    totalCases: number;
    completedCases: number;
    actionableCases: number;
    silentFailureCases: number;
    ambiguousFailureCases: number;
    closedLoopCases: number;
    closedLoopRate: number;
    rerunCommand: string;
    measuredRuns: number;
    nextCommand: string;
    latestRunId?: string;
  };
  baseline: {
    status: ValidationOpsBaselineStatus;
    summary: string;
    nextCommand: string;
    staleAfterMs: number;
    latestRunId?: string;
    recordedAt?: number;
    ageMs?: number;
    consecutivePassedRuns?: number;
    requiredRuns?: number;
  };
}
