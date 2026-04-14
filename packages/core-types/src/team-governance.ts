import type { RoleId, TaskId, ThreadId, WorkerKind } from "./team-core";

export type TransportKind = "official_api" | "business_tool" | "browser";
export type EvidenceTrustLevel = "promotable" | "observational";
export type EvidenceSourceType = "browser" | "api" | "tool";
export type PromptAdmissionMode = "full" | "summary_only" | "blocked";
export type PermissionRequirementLevel = "none" | "confirm" | "approval";
export type PermissionScope = "read" | "navigate" | "mutate" | "publish" | "credential";
export type PermissionDecision = "granted" | "denied" | "prompt_required";

export interface PermissionRequirement {
  level: PermissionRequirementLevel;
  scope: PermissionScope;
  rationale: string;
  cacheKey: string;
}

export interface PermissionEvaluation {
  requirement: PermissionRequirement;
  decision: PermissionDecision;
  source: "policy" | "cache";
  denialReason?: string;
  recommendedAction?: "proceed" | "retry_same_transport" | "fallback_browser" | "request_approval" | "abort";
  fallbackTransport?: TransportKind;
}

export interface EvidenceTrustAssessment {
  sourceType: EvidenceSourceType;
  trustLevel: EvidenceTrustLevel;
  rationale: string[];
  verified: boolean;
  downgraded: boolean;
}

export interface PromptAdmissionDecision {
  mode: PromptAdmissionMode;
  trustLevel: EvidenceTrustLevel;
  reason: string;
}

export interface TransportExecutionAudit {
  capability: string;
  preferredOrder: TransportKind[];
  attemptedTransports: TransportKind[];
  finalTransport?: TransportKind;
  downgraded: boolean;
  fallbackReason?: string;
  trustLevel: EvidenceTrustLevel;
}

export interface PermissionCacheRecord {
  cacheKey: string;
  threadId: ThreadId;
  workerType: WorkerKind;
  requirement: PermissionRequirement;
  decision: PermissionDecision;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  denialReason?: string;
}

export interface PermissionCacheStore {
  get(cacheKey: string): Promise<PermissionCacheRecord | null>;
  put(record: PermissionCacheRecord): Promise<void>;
  listByThread(threadId: ThreadId): Promise<PermissionCacheRecord[]>;
}

export interface CapabilityInspectionInput {
  threadId: ThreadId;
  roleId: RoleId;
  requestedCapabilities: string[];
  preferredWorkerKinds?: WorkerKind[];
}

export interface ConnectorCapabilityState {
  provider: string;
  available: boolean;
  authorized: boolean;
  issues?: string[];
  suggestedActions?: string[];
}

export interface ApiCapabilityState {
  name: string;
  configured: boolean;
  ready: boolean;
  issues?: string[];
  suggestedActions?: string[];
}

export interface SkillCapabilityState {
  skillId: string;
  installed: boolean;
}

export interface TransportPreference {
  capability: string;
  orderedTransports: TransportKind[];
}

export interface CapabilityInspectionResult {
  availableWorkers: WorkerKind[];
  connectorStates: ConnectorCapabilityState[];
  apiStates: ApiCapabilityState[];
  skillStates: SkillCapabilityState[];
  transportPreferences: TransportPreference[];
  unavailableCapabilities: string[];
  generatedAt: number;
}

export interface CapabilityDiscoveryService {
  inspect(input: CapabilityInspectionInput): Promise<CapabilityInspectionResult>;
}

export interface ApiExecutionAttempt {
  apiName: string;
  operation: string;
  transport: Exclude<TransportKind, "browser">;
  statusCode?: number;
  errorMessage?: string;
  responseBody?: unknown;
  credentialState?: "missing" | "present" | "invalid";
  requiredScopes?: string[];
  grantedScopes?: string[];
  schemaErrors?: string[];
  businessErrors?: string[];
}

export type ApiDiagnosisCategory =
  | "ok"
  | "credential"
  | "scope"
  | "schema"
  | "business"
  | "network"
  | "unknown";

export interface ApiDiagnosisReport {
  ok: boolean;
  category: ApiDiagnosisCategory;
  retryable: boolean;
  issues: string[];
  suggestedActions: string[];
}

export interface AuthAndScopeDiagnosisPolicy {
  diagnose(input: ApiExecutionAttempt): ApiDiagnosisReport | null;
}

export interface ApiExecutionVerifier {
  verify(input: ApiExecutionAttempt): ApiDiagnosisReport;
}

export interface GovernanceValidationTask {
  taskId: TaskId;
  label: string;
}
