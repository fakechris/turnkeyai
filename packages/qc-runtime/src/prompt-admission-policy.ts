import type {
  ApiDiagnosisReport,
  PromptAdmissionDecision,
  PromptAdmissionPolicy,
  WorkerExecutionResult,
  WorkerKind,
} from "@turnkeyai/core-types/team";
import type { EvidenceTrustAssessment, PermissionEvaluation } from "@turnkeyai/core-types/team";

export class DefaultPromptAdmissionPolicy implements PromptAdmissionPolicy {
  decide(input: {
    workerType: WorkerKind;
    workerStatus: WorkerExecutionResult["status"];
    summary: string;
    payload: Record<string, unknown>;
    trust: EvidenceTrustAssessment;
    permission: PermissionEvaluation;
    apiDiagnosis: ApiDiagnosisReport[];
  }): PromptAdmissionDecision {
    if (input.permission.decision === "denied") {
      return {
        mode: "blocked",
        trustLevel: "observational",
        reason: input.permission.denialReason ?? "permission denied",
      };
    }

    if (input.permission.decision === "prompt_required") {
      return {
        mode: "summary_only",
        trustLevel: input.trust.trustLevel,
        reason: "approval required before treating the result as final",
      };
    }

    if (input.workerStatus === "failed") {
      return {
        mode: "blocked",
        trustLevel: "observational",
        reason: "failed worker result is not admitted into prompt context",
      };
    }

    if (input.apiDiagnosis.some((entry) => !entry.ok && !entry.retryable)) {
      return {
        mode: "summary_only",
        trustLevel: "observational",
        reason: "result contains unresolved API diagnosis and is downgraded",
      };
    }

    if (input.trust.trustLevel === "observational") {
      return {
        mode: "summary_only",
        trustLevel: "observational",
        reason: input.trust.rationale.join("; ") || "evidence is observational only",
      };
    }

    return {
      mode: input.workerStatus === "completed" ? "full" : "summary_only",
      trustLevel: input.trust.trustLevel,
      reason: input.workerStatus === "completed" ? "verified result can be promoted" : "partial result admitted as summary only",
    };
  }
}
