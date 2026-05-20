import type {
  PermissionRequirementLevel,
  PermissionScope,
  WorkerKind,
} from "@turnkeyai/core-types/team";

export type ToolPermissionStatus = "pending" | "approved" | "denied" | "applied" | "already_granted";

export interface ToolPermissionRequirementInput {
  level: PermissionRequirementLevel;
  scope: PermissionScope;
  rationale: string;
  cacheKey?: string;
  workerType?: WorkerKind;
}

export interface ToolPermissionRequestInput {
  threadId: string;
  roleId: string;
  roleName: string;
  toolCallId: string;
  action: string;
  title: string;
  risk: string;
  requirement: ToolPermissionRequirementInput;
  missionId?: string;
  affects?: string[];
  payload?: Record<string, unknown>;
}

export interface ToolPermissionQueryResult {
  status: Extract<ToolPermissionStatus, "pending" | "already_granted">;
  approvalId?: string;
  missionId?: string;
  action: string;
  requirement: {
    level: PermissionRequirementLevel;
    scope: PermissionScope;
    cacheKey: string;
    rationale: string;
    workerType: WorkerKind;
  };
  message: string;
}

export interface ToolPermissionResultInput {
  threadId: string;
  approvalId: string;
}

export interface ToolPermissionDecisionResult {
  status: Extract<ToolPermissionStatus, "pending" | "approved" | "denied">;
  approvalId: string;
  missionId?: string;
  action?: string;
  decidedBy?: string;
  decidedAtMs?: number;
  reason?: string;
  message: string;
}

export interface ToolPermissionAppliedInput {
  threadId: string;
  approvalId: string;
}

export interface ToolPermissionAppliedResult {
  status: Extract<ToolPermissionStatus, "applied" | "pending" | "denied">;
  approvalId: string;
  cacheKey?: string;
  message: string;
}

export interface ToolPermissionService {
  request(input: ToolPermissionRequestInput): Promise<ToolPermissionQueryResult>;
  result(input: ToolPermissionResultInput): Promise<ToolPermissionDecisionResult>;
  apply(input: ToolPermissionAppliedInput): Promise<ToolPermissionAppliedResult>;
}
