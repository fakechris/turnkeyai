import type {
  ApiDiagnosisReport,
  PromptAdmissionDecision,
  PromptAdmissionPolicy,
  WorkerExecutionResult,
  WorkerKind,
} from "@turnkeyai/core-types/team";
import type { EvidenceTrustAssessment, PermissionEvaluation } from "@turnkeyai/core-types/team";
import { inspectBrowserExcerptSafety } from "./browser-excerpt-safety";

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

    const excerptSafety = inspectBrowserPayloadExcerpt(input.workerType, input.payload);
    if (excerptSafety?.suspicious) {
      return {
        mode: "summary_only",
        trustLevel: "observational",
        reason: excerptSafety.issues[0] ?? "browser excerpt contained prompt-like instructions and was downgraded",
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

function inspectBrowserPayloadExcerpt(workerType: WorkerKind, payload: Record<string, unknown>) {
  if (workerType !== "browser") {
    return null;
  }

  const page = payload.page;
  if (!page || typeof page !== "object") {
    return null;
  }

  const excerpt = typeof (page as Record<string, unknown>).textExcerpt === "string"
    ? ((page as Record<string, unknown>).textExcerpt as string)
    : "";
  return inspectBrowserExcerptSafety(excerpt);
}
