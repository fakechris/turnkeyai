import type {
  ApiDiagnosisReport,
  PermissionCacheRecord,
  PermissionEvaluation,
  PermissionGovernancePolicy,
  PermissionRequirement,
  PermissionScope,
  TransportExecutionAudit,
  WorkerKind,
} from "@turnkeyai/core-types/team";

export class DefaultPermissionGovernancePolicy implements PermissionGovernancePolicy {
  evaluate(input: {
    now?: number;
    threadId: string;
    workerType: WorkerKind;
    payload: Record<string, unknown>;
    apiDiagnosis: ApiDiagnosisReport[];
    transportAudit?: TransportExecutionAudit | null;
    cachedDecision?: PermissionCacheRecord | null;
  }): PermissionEvaluation {
    const requirement = buildPermissionRequirement(input.threadId, input.workerType, input.payload, input.transportAudit);
    const cachedDecision = useCachedDecision(input.cachedDecision, requirement.cacheKey, input.now ?? Date.now());
    if (cachedDecision) {
      return {
        requirement: cachedDecision.requirement,
        decision: cachedDecision.decision,
        source: "cache",
        ...(cachedDecision.denialReason ? { denialReason: cachedDecision.denialReason } : {}),
        ...deriveRecommendedAction(cachedDecision.decision, input.transportAudit, input.apiDiagnosis),
      };
    }

    const denialReason = findPermissionDenialReason(input.apiDiagnosis);
    if (denialReason) {
      return {
        requirement,
        decision: "denied",
        source: "policy",
        denialReason,
        ...deriveRecommendedAction("denied", input.transportAudit, input.apiDiagnosis),
      };
    }

    if (requirement.level === "none") {
      return {
        requirement,
        decision: "granted",
        source: "policy",
        recommendedAction: "proceed",
      };
    }

    return {
      requirement,
      decision: "prompt_required",
      source: "policy",
      ...deriveRecommendedAction("prompt_required", input.transportAudit, input.apiDiagnosis),
    };
  }
}

const MUTATING_OPERATION_VERBS = [
  "create",
  "update",
  "delete",
  "write",
  "submit",
  "upsert",
  "insert",
  "patch",
  "put",
  "remove",
] as const;

const PUBLISHING_OPERATION_VERBS = ["publish", "post", "checkout"] as const;
const READ_OPERATION_PREFIXES = new Set(["get", "read", "view", "fetch", "list", "load"]);

function buildPermissionRequirement(
  threadId: string,
  workerType: WorkerKind,
  payload: Record<string, unknown>,
  transportAudit?: TransportExecutionAudit | null
): PermissionRequirement {
  const apiOperations = collectApiOperations(payload);
  const browserSteps = collectTraceKinds(payload);
  const hasWriteOperation = apiOperations.some((operation) => matchesOperation(operation, MUTATING_OPERATION_VERBS));
  const hasPublishOperation = apiOperations.some((operation) => matchesOperation(operation, PUBLISHING_OPERATION_VERBS));
  const hasInteractiveBrowserStep = browserSteps.some((kind) => ["click", "type", "select", "drag"].includes(kind));

  if (hasPublishOperation) {
    return createRequirement(threadId, "approval", "publish", workerType, "publishing or externally visible side effect");
  }

  if (hasWriteOperation) {
    return createRequirement(threadId, "approval", "mutate", workerType, "mutating remote state");
  }

  if (hasInteractiveBrowserStep) {
    return createRequirement(threadId, "confirm", "navigate", workerType, "interactive browser action");
  }

  if (transportAudit?.finalTransport === "browser") {
    return createRequirement(threadId, "none", "read", workerType, "read-only browser inspection");
  }

  return createRequirement(threadId, "none", "read", workerType, "read-only worker execution");
}

function createRequirement(
  threadId: string,
  level: PermissionRequirement["level"],
  scope: PermissionScope,
  workerType: WorkerKind,
  rationale: string
): PermissionRequirement {
  return {
    level,
    scope,
    rationale,
    cacheKey: `${threadId}:${workerType}:${scope}:${level}`,
  };
}

function useCachedDecision(
  cachedDecision: PermissionCacheRecord | null | undefined,
  expectedCacheKey: string,
  now: number
): PermissionCacheRecord | null {
  if (!cachedDecision || cachedDecision.cacheKey !== expectedCacheKey) {
    return null;
  }

  if (cachedDecision.expiresAt && cachedDecision.expiresAt <= now) {
    return null;
  }

  return cachedDecision;
}

function findPermissionDenialReason(apiDiagnosis: ApiDiagnosisReport[]): string | null {
  const denied = apiDiagnosis.find((entry) => entry.category === "credential" || entry.category === "scope");
  if (!denied) {
    return null;
  }

  return denied.issues[0] ?? denied.suggestedActions[0] ?? "permission denied";
}

function deriveRecommendedAction(
  decision: PermissionEvaluation["decision"],
  transportAudit?: TransportExecutionAudit | null,
  apiDiagnosis: ApiDiagnosisReport[] = []
): Pick<PermissionEvaluation, "recommendedAction" | "fallbackTransport"> {
  const hasRetryable = apiDiagnosis.some((entry) => entry.retryable);
  const canFallbackToBrowser =
    transportAudit?.finalTransport !== "browser" &&
    transportAudit?.preferredOrder.includes("browser") &&
    !transportAudit?.attemptedTransports.includes("browser");

  if (decision === "denied") {
    if (canFallbackToBrowser) {
      return {
        recommendedAction: "fallback_browser",
        fallbackTransport: "browser",
      };
    }

    if (hasRetryable) {
      return {
        recommendedAction: "retry_same_transport",
      };
    }

    return {
      recommendedAction: "abort",
    };
  }

  if (decision === "prompt_required") {
    return {
      recommendedAction: "request_approval",
    };
  }

  return {
    recommendedAction: "proceed",
  };
}

function collectApiOperations(payload: Record<string, unknown>): string[] {
  const operations: string[] = [];
  const singleAttempt = payload.apiAttempt;
  if (singleAttempt && typeof singleAttempt === "object" && typeof (singleAttempt as Record<string, unknown>).operation === "string") {
    operations.push((singleAttempt as Record<string, unknown>).operation as string);
  }

  const multipleAttempts = payload.apiAttempts;
  if (Array.isArray(multipleAttempts)) {
    for (const item of multipleAttempts) {
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>).operation === "string") {
        operations.push((item as Record<string, unknown>).operation as string);
      }
    }
  }

  return operations;
}

function collectTraceKinds(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.trace)) {
    return [];
  }

  return payload.trace
    .map((step) => (step && typeof step === "object" ? (step as Record<string, unknown>).kind : null))
    .filter((kind): kind is string => typeof kind === "string");
}

function matchesOperation(operation: string, verbs: readonly string[]): boolean {
  const normalized = operation.toLowerCase();
  return verbs.some(
    (verb) =>
      normalized === verb ||
      matchesDelimitedOperation(normalized, verb) ||
      matchesCamelCaseSuffix(operation, normalized, verb)
      ||
      matchesCamelCasePrefix(operation, normalized, verb)
  );
}

function matchesDelimitedOperation(normalized: string, verb: string): boolean {
  const tokens = normalized.split(/[_-]+/).filter((token) => token.length > 0);
  if (tokens.length <= 1) {
    return false;
  }
  const hasReadPrefix = READ_OPERATION_PREFIXES.has(tokens[0] ?? "");
  return tokens.some((token, index) => token === verb && (index === 0 || !hasReadPrefix));
}

function matchesCamelCaseSuffix(operation: string, normalized: string, verb: string): boolean {
  if (!normalized.endsWith(verb)) {
    return false;
  }

  if (normalized.length === verb.length) {
    return true;
  }

  const suffixStart = operation.length - verb.length;
  const firstSuffixChar = operation[suffixStart];
  if (!firstSuffixChar || !/[A-Z]/.test(firstSuffixChar)) {
    return false;
  }

  const prefix = normalized.slice(0, normalized.length - verb.length);
  if (READ_OPERATION_PREFIXES.has(prefix)) {
    return false;
  }

  return true;
}

function matchesCamelCasePrefix(operation: string, normalized: string, verb: string): boolean {
  if (!normalized.startsWith(verb)) {
    return false;
  }

  if (normalized.length === verb.length) {
    return true;
  }

  const boundaryChar = operation.charAt(verb.length);
  return boundaryChar.length > 0 && /[A-Z]/.test(boundaryChar);
}
