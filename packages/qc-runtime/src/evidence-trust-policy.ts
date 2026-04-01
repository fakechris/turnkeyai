import type {
  ApiDiagnosisReport,
  EvidenceSourceType,
  EvidenceTrustAssessment,
  EvidenceTrustPolicy,
  PermissionEvaluation,
  TransportExecutionAudit,
  WorkerExecutionResult,
  WorkerKind,
} from "@turnkeyai/core-types/team";

export class DefaultEvidenceTrustPolicy implements EvidenceTrustPolicy {
  assess(input: {
    workerType: WorkerKind;
    workerStatus: WorkerExecutionResult["status"];
    payload: Record<string, unknown>;
    apiDiagnosis: ApiDiagnosisReport[];
    permission: PermissionEvaluation;
    transportAudit?: TransportExecutionAudit | null;
  }): EvidenceTrustAssessment {
    const sourceType = inferSourceType(input.workerType, input.transportAudit);
    const rationale: string[] = [];
    let verified = false;
    let trustLevel: EvidenceTrustAssessment["trustLevel"] = "observational";
    let downgraded = false;

    if (input.permission.decision !== "granted") {
      rationale.push(`permission decision is ${input.permission.decision}`);
      downgraded = true;
      return {
        sourceType,
        trustLevel,
        rationale,
        verified,
        downgraded,
      };
    }

    if (input.workerStatus !== "completed") {
      rationale.push(`worker status is ${input.workerStatus}`);
      downgraded = true;
      return {
        sourceType,
        trustLevel,
        rationale,
        verified,
        downgraded,
      };
    }

    if (input.apiDiagnosis.some((entry) => !entry.ok)) {
      rationale.push("api diagnosis contains non-ok result");
      downgraded = true;
      return {
        sourceType,
        trustLevel,
        rationale,
        verified,
        downgraded,
      };
    }

    switch (sourceType) {
      case "api":
        verified = true;
        trustLevel = "promotable";
        rationale.push("successful API execution with no diagnosis errors");
        break;
      case "tool":
        verified = true;
        trustLevel = "promotable";
        rationale.push("successful business tool execution");
        break;
      case "browser": {
        const browserQuality = extractBrowserQuality(input.payload);
        const readOnly = hasOnlyReadOnlyBrowserSteps(input.payload);
        if (browserQuality.ok && readOnly) {
          verified = true;
          trustLevel = "promotable";
          rationale.push("browser result is verified and trace is read-only");
        } else {
          downgraded = true;
          rationale.push(browserQuality.reason ?? "browser evidence is not fully verifiable");
        }
        break;
      }
    }

    return {
      sourceType,
      trustLevel,
      rationale,
      verified,
      downgraded,
    };
  }
}

function inferSourceType(workerType: WorkerKind, transportAudit?: TransportExecutionAudit | null): EvidenceSourceType {
  if (workerType === "browser" || transportAudit?.finalTransport === "browser") {
    return "browser";
  }

  if (transportAudit?.finalTransport === "official_api") {
    return "api";
  }

  return "tool";
}

function extractBrowserQuality(payload: Record<string, unknown>): { ok: boolean; reason?: string } {
  const quality = payload.quality;
  if (!quality || typeof quality !== "object") {
    return { ok: false, reason: "browser quality metadata is missing" };
  }

  const stepReport = (quality as Record<string, unknown>).stepReport;
  const resultReport = (quality as Record<string, unknown>).resultReport;
  const errors = (quality as Record<string, unknown>).errors;

  const stepOk = stepReport && typeof stepReport === "object" ? Boolean((stepReport as Record<string, unknown>).ok) : false;
  const resultOk =
    resultReport && typeof resultReport === "object" ? Boolean((resultReport as Record<string, unknown>).ok) : false;
  const errorCount = Array.isArray(errors) ? errors.length : 0;

  if (stepOk && resultOk && errorCount === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: errorCount > 0 ? "browser verification reported errors" : "browser verification did not fully pass",
  };
}

function hasOnlyReadOnlyBrowserSteps(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.trace)) {
    return false;
  }

  const allowed = new Set(["open", "snapshot", "scroll", "console", "screenshot"]);
  const kinds = payload.trace
    .map((step) => (step && typeof step === "object" ? (step as Record<string, unknown>).kind : null))
    .filter((kind): kind is string => typeof kind === "string");

  return kinds.length > 0 && kinds.every((kind) => allowed.has(kind));
}
