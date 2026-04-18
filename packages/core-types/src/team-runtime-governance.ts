import type { ThreadId, WorkerKind } from "./team-core";
import type {
  ApiDiagnosisReport,
  EvidenceTrustAssessment,
  PermissionCacheRecord,
  PermissionEvaluation,
  PromptAdmissionDecision,
  TransportExecutionAudit,
} from "./team-governance";
import type { WorkerExecutionResult } from "./team-worker-runtime";

export interface PermissionGovernancePolicy {
  evaluate(input: {
    now?: number;
    threadId: ThreadId;
    workerType: WorkerKind;
    payload: Record<string, unknown>;
    apiDiagnosis: ApiDiagnosisReport[];
    transportAudit?: TransportExecutionAudit | null;
    cachedDecision?: PermissionCacheRecord | null;
  }): PermissionEvaluation;
}

export interface EvidenceTrustPolicy {
  assess(input: {
    workerType: WorkerKind;
    workerStatus: WorkerExecutionResult["status"];
    payload: Record<string, unknown>;
    apiDiagnosis: ApiDiagnosisReport[];
    permission: PermissionEvaluation;
    transportAudit?: TransportExecutionAudit | null;
  }): EvidenceTrustAssessment;
}

export interface PromptAdmissionPolicy {
  decide(input: {
    workerType: WorkerKind;
    workerStatus: WorkerExecutionResult["status"];
    summary: string;
    payload: Record<string, unknown>;
    trust: EvidenceTrustAssessment;
    permission: PermissionEvaluation;
    apiDiagnosis: ApiDiagnosisReport[];
  }): PromptAdmissionDecision;
}
