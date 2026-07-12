export type ExplicitWorkflowTriggerKind =
  | "user_input"
  | "effect_receipt"
  | "inbox_notification"
  | "schedule";

export interface ExplicitWorkflowAttemptBudget {
  activeMs?: number;
  maxTurns?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxCost?: number;
  maxConcurrency?: number;
}

export interface ExplicitWorkflowTrigger {
  kind: ExplicitWorkflowTriggerKind;
  key: string;
}

export interface ExplicitWorkflowStepDefinition {
  stepId: string;
  trigger: ExplicitWorkflowTrigger;
  allowedEffects: string[];
  join: "attached" | "detached" | "none";
  attemptBudget: ExplicitWorkflowAttemptBudget;
  retryAllowanceIds: string[];
  nextStepIds: string[];
}

export interface ExplicitWorkflowRetryAllowanceDefinition {
  allowanceId: string;
  maxRetries: number;
}

export interface ExplicitWorkflowDefinition {
  workflowId: string;
  ownerScopeId: string;
  steps: ExplicitWorkflowStepDefinition[];
  retryAllowances: ExplicitWorkflowRetryAllowanceDefinition[];
}

export interface ExplicitWorkflowTriggerEvent extends ExplicitWorkflowTrigger {
  eventId: string;
  occurredAt: number;
  payloadRef?: string;
}

export interface ExplicitWorkflowAttemptGrant {
  attemptId: string;
  attemptNumber: number;
  grantedAt: number;
  budget: ExplicitWorkflowAttemptBudget;
  deadlineAt?: number;
}

export interface ExplicitWorkflowEffectProposal {
  effectId: string;
  workflowId: string;
  stepId: string;
  attemptId: string;
  effectName: string;
  input: Record<string, unknown>;
  join: ExplicitWorkflowStepDefinition["join"];
  proposedAt: number;
}

export interface ExplicitWorkflowEffectReceipt {
  effectId: string;
  status: "committed" | "failed" | "indeterminate";
  recordedAt: number;
  resultRef?: string;
  errorCode?: string;
  sourceScopeId?: string;
}

export interface ExplicitWorkflowAttemptRecord {
  grant: ExplicitWorkflowAttemptGrant;
  proposal?: ExplicitWorkflowEffectProposal;
  receipt?: ExplicitWorkflowEffectReceipt;
}

export interface ExplicitWorkflowStepRecord {
  stepId: string;
  state:
    | "waiting"
    | "ready"
    | "effect_admitted"
    | "waiting_join"
    | "completed"
    | "failed";
  triggerEventId?: string;
  attempts: ExplicitWorkflowAttemptRecord[];
  joinId?: string;
  joinNotificationId?: string;
  errorCode?: string;
}

export interface ExplicitWorkflowRetryAllowanceRecord {
  allowanceId: string;
  ownerScopeId: string;
  failureDomain: "workflow_step";
  initialRetries: number;
  remainingRetries: number;
}

export interface ExplicitWorkflowRecord {
  workflowId: string;
  ownerScopeId: string;
  version: number;
  status: "suspended" | "running" | "completed" | "failed" | "cancelled";
  definition: ExplicitWorkflowDefinition;
  steps: ExplicitWorkflowStepRecord[];
  retryAllowances: ExplicitWorkflowRetryAllowanceRecord[];
  processedTriggerIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ExplicitWorkflowStore {
  get(workflowId: string): Promise<ExplicitWorkflowRecord | null>;
  put(
    record: ExplicitWorkflowRecord,
    options: { expectedVersion: number },
  ): Promise<ExplicitWorkflowRecord | null>;
  list(): Promise<ExplicitWorkflowRecord[]>;
}
