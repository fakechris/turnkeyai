import type {
  FailureCategory,
  FailureRecommendedAction,
  FailureSummary,
  ReplayLayer,
  RuntimeError,
} from "@turnkeyai/core-types/team";

export function classifyRuntimeError(input: {
  layer: ReplayLayer;
  error: unknown;
  fallbackMessage: string;
}): FailureSummary {
  const error = normalizeError(input.error, input.fallbackMessage);
  const message = error.message;
  const normalized = message.toLowerCase();
  const codeFailure = error.code ? classifyByCode(input.layer, error.code, message, error.retryable) : null;
  if (codeFailure) {
    return codeFailure;
  }

  if (/timeout|timed out/.test(normalized)) {
    return buildFailure("timeout", input.layer, true, message, "resume");
  }

  if (/permission denied|approval required|scope|credential|unauthorized|forbidden/.test(normalized)) {
    return buildFailure("permission_denied", input.layer, false, message, "request_approval");
  }

  if (
    /stale session|lease conflict|session owner mismatch|target is closed|session not found:|lease expired|idle eviction|evicted/.test(
      normalized
    )
  ) {
    return buildFailure("stale_session", input.layer, true, message, "resume");
  }

  if (/invalid resume|resume.*not allowed|resume.*failed|detached target cannot be reopened|no active target/.test(normalized)) {
    return buildFailure("invalid_resume", input.layer, true, message, "retry");
  }

  if (/blocked|browser fallback is not allowed/.test(normalized)) {
    return buildFailure("blocked", input.layer, false, message, "inspect");
  }

  if (/transport|network|fetch failed|http \d{3}|browser crashed|connection|certificate|dns|reconnect|reopen/.test(normalized)) {
    return buildFailure("transport_failed", input.layer, true, message, "fallback");
  }

  if (/merge|fan-?out|coverage/.test(normalized)) {
    return buildFailure("merge_failure", input.layer, true, message, "retry");
  }

  return buildFailure("unknown", input.layer, error.retryable ?? false, message, error.retryable ? "retry" : "inspect");
}

export function classifyFailureFromStatus(input: {
  layer: ReplayLayer;
  status: "completed" | "partial" | "failed";
  summary: string;
  payload?: Record<string, unknown>;
}): FailureSummary | undefined {
  if (input.status === "completed") {
    return undefined;
  }

  const payload = input.payload ?? {};
  const explicitError = typeof payload.error === "string" ? payload.error : input.summary;
  const derived = classifyRuntimeError({
    layer: input.layer,
    error: explicitError,
    fallbackMessage: input.summary,
  });

  if (input.status === "partial") {
    return {
      ...derived,
      retryable: true,
      recommendedAction: derived.recommendedAction === "request_approval" ? "request_approval" : "resume",
    };
  }

  return derived;
}

function normalizeError(
  error: unknown,
  fallbackMessage: string
): { message: string; retryable?: boolean; code?: RuntimeError["code"] } {
  if (error && typeof error === "object") {
    const record = error as Partial<RuntimeError> & { message?: unknown };
    if (typeof record.message === "string") {
      return {
        message: record.message,
        ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
        ...(typeof record.code === "string" ? { code: record.code } : {}),
      };
    }
  }

  if (error instanceof Error) {
    return { message: error.message };
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return { message: error };
  }

  return { message: fallbackMessage };
}

function buildFailure(
  category: FailureCategory,
  layer: ReplayLayer,
  retryable: boolean,
  message: string,
  recommendedAction: FailureRecommendedAction
): FailureSummary {
  return {
    category,
    layer,
    retryable,
    message,
    recommendedAction,
  };
}

function classifyByCode(
  layer: ReplayLayer,
  code: RuntimeError["code"],
  message: string,
  retryable: boolean | undefined
): FailureSummary | null {
  switch (code) {
    case "WORKER_TIMEOUT":
      return buildFailure("timeout", layer, true, message, "resume");
    case "TEAM_POLICY_VIOLATION":
      return buildFailure("permission_denied", layer, false, message, "request_approval");
    case "RUN_ITERATION_LIMIT":
    case "FLOW_HOP_LIMIT":
    case "HANDOFF_LOOP":
      return buildFailure("merge_failure", layer, true, message, "retry");
    case "ROLE_MISSING":
      return buildFailure("terminal", layer, false, message, "abort");
    case "INVALID_MENTION":
      return buildFailure("blocked", layer, false, message, "inspect");
    case "MODEL_OVERLOADED":
    case "MODEL_5XX":
      return buildFailure("transport_failed", layer, true, message, "retry");
    case "REQUEST_ENVELOPE_OVERFLOW":
      return buildFailure("blocked", layer, false, message, "inspect");
    case "WORKER_FAILED":
      return null;
    default:
      return buildFailure("unknown", layer, retryable ?? false, message, retryable ? "retry" : "inspect");
  }
}
