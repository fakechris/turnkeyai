import type {
  AcceptanceCriterionState,
  AgentId,
  ContextSourceId,
  MissionId,
  MissionStatus,
  VerificationReceipt,
  WorkItemId,
} from "@turnkeyai/core-types/mission";

export interface TaskToolAcceptanceCriterionInput {
  id?: string;
  description: string;
  required?: boolean;
}

export interface TaskToolAcceptanceUpdateInput {
  criterionId: string;
  state: AcceptanceCriterionState;
}

export interface TaskToolVerificationReceiptInput {
  criterionId: string;
  kind: VerificationReceipt["kind"];
  ref: string;
  result: VerificationReceipt["result"];
  reason?: string;
}

export interface TaskToolListInput {
  threadId: string;
  roleId: string;
  missionId?: MissionId;
  status?: MissionStatus;
  agentId?: AgentId;
  limit?: number;
}

export interface TaskToolCreateInput {
  threadId: string;
  roleId: string;
  missionId?: MissionId;
  title: string;
  agentId?: AgentId;
  status?: MissionStatus;
  contextRefs?: ContextSourceId[];
  output?: string;
  objective?: string;
  inputRefs?: string[];
  outputRefs?: string[];
  constraints?: string[];
  blockedBy?: WorkItemId[];
  acceptanceCriteria?: TaskToolAcceptanceCriterionInput[];
}

export interface TaskToolUpdateInput {
  threadId: string;
  roleId: string;
  missionId?: MissionId;
  workItemId: WorkItemId;
  status?: MissionStatus;
  output?: string;
  blocker?: string | null;
  progress?: number;
  objective?: string;
  inputRefs?: string[];
  outputRefs?: string[];
  constraints?: string[];
  blockedBy?: WorkItemId[];
  acceptanceUpdates?: TaskToolAcceptanceUpdateInput[];
  verificationReceipts?: TaskToolVerificationReceiptInput[];
}

export interface TaskToolService {
  list(input: TaskToolListInput): Promise<unknown>;
  create(input: TaskToolCreateInput): Promise<unknown>;
  update(input: TaskToolUpdateInput): Promise<unknown>;
  snapshot?(input: TaskToolListInput): Promise<string[]>;
}

export type TaskPlanStateProvider = (input: {
  threadId: string;
  roleId: string;
}) => Promise<string[]>;
