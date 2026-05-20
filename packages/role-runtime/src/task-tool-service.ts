import type {
  AgentId,
  ContextSourceId,
  MissionId,
  MissionStatus,
  WorkItemId,
} from "@turnkeyai/core-types/mission";

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
}

export interface TaskToolService {
  list(input: TaskToolListInput): Promise<unknown>;
  create(input: TaskToolCreateInput): Promise<unknown>;
  update(input: TaskToolUpdateInput): Promise<unknown>;
}
