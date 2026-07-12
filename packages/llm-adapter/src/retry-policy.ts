import { RequestEnvelopeOverflowError } from "./request-envelope-guard";
import { ProviderRequestError } from "./types";

export interface ProviderRetryPolicy {
  transientMaxAttempts: number;
  timeoutMaxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  transientMaxAttempts: 3,
  timeoutMaxAttempts: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 20_000,
};

export type RetryFailureDomain =
  | "model_transport"
  | "tool_transport"
  | "workflow_step";

export interface RetryAllowanceSnapshot {
  allowanceId: string;
  ownerScopeId: string;
  failureDomain: RetryFailureDomain;
  initialAttempts: number;
  remainingAttempts: number;
}

export class RetryAllowance {
  private remaining: number;

  constructor(
    private readonly state: Omit<
      RetryAllowanceSnapshot,
      "initialAttempts" | "remainingAttempts"
    > & { maxAttempts: number },
  ) {
    if (!Number.isInteger(state.maxAttempts) || state.maxAttempts <= 0) {
      throw new RangeError("retry allowance maxAttempts must be a positive integer");
    }
    this.remaining = state.maxAttempts;
  }

  claimAttempt(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= 1;
    return true;
  }

  hasRemainingAttempts(): boolean {
    return this.remaining > 0;
  }

  snapshot(): RetryAllowanceSnapshot {
    return {
      allowanceId: this.state.allowanceId,
      ownerScopeId: this.state.ownerScopeId,
      failureDomain: this.state.failureDomain,
      initialAttempts: this.state.maxAttempts,
      remainingAttempts: this.remaining,
    };
  }
}

export function createRetryAllowance(input: {
  allowanceId: string;
  ownerScopeId: string;
  failureDomain: RetryFailureDomain;
  maxAttempts: number;
}): RetryAllowance {
  return new RetryAllowance(input);
}

export type ProviderRetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false; delayMs: 0 };

export function decideProviderRetry(input: {
  error: unknown;
  attempt: number;
  policy?: ProviderRetryPolicy;
  random?: () => number;
}): ProviderRetryDecision {
  if (input.error instanceof RequestEnvelopeOverflowError) {
    return { retry: false, delayMs: 0 };
  }
  if (!(input.error instanceof ProviderRequestError) || !input.error.retryable) {
    return { retry: false, delayMs: 0 };
  }
  const policy = input.policy ?? DEFAULT_PROVIDER_RETRY_POLICY;
  const maxAttempts =
    input.error.code === "timeout"
      ? policy.timeoutMaxAttempts
      : policy.transientMaxAttempts;
  if (input.attempt >= maxAttempts) {
    return { retry: false, delayMs: 0 };
  }
  if (input.error.retryAfterMs !== undefined) {
    return {
      retry: true,
      delayMs: Math.min(policy.maxDelayMs, Math.max(0, input.error.retryAfterMs)),
    };
  }
  const cap = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, input.attempt - 1),
  );
  const random = Math.min(1, Math.max(0, (input.random ?? Math.random)()));
  return { retry: true, delayMs: Math.floor(random * cap) };
}

export function providerErrorCode(error: unknown): string {
  if (error instanceof RequestEnvelopeOverflowError) {
    return error.code;
  }
  if (error instanceof ProviderRequestError) {
    return error.code;
  }
  return "unknown";
}

export function buildProviderRequestError(input: {
  status: number;
  message: string;
  retryAfter?: string | null;
}): ProviderRequestError {
  const retryAfterMs = parseRetryAfterMs(input.retryAfter);
  if (input.status === 401 || input.status === 403) {
    return new ProviderRequestError(input.message, {
      code: "authentication",
      status: input.status,
      retryable: false,
    });
  }
  if (input.status === 404) {
    return new ProviderRequestError(input.message, {
      code: "not_found",
      status: input.status,
      retryable: false,
    });
  }
  if (input.status === 429) {
    return new ProviderRequestError(input.message, {
      code: "rate_limit",
      status: input.status,
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (input.status === 408 || input.status === 504) {
    return new ProviderRequestError(input.message, {
      code: "timeout",
      status: input.status,
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (input.status >= 500) {
    return new ProviderRequestError(input.message, {
      code: "server_error",
      status: input.status,
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  return new ProviderRequestError(input.message, {
    code: "provider_error",
    status: input.status,
    retryable: false,
  });
}

export function normalizeProviderNetworkError(
  error: unknown,
  signal?: AbortSignal,
): unknown {
  if (signal?.aborted) {
    return signal.reason ?? error;
  }
  if (
    error instanceof ProviderRequestError ||
    error instanceof RequestEnvelopeOverflowError
  ) {
    return error;
  }
  return new ProviderRequestError(
    error instanceof Error ? error.message : String(error),
    { code: "network_error", retryable: true, cause: error },
  );
}

export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) {
    return undefined;
  }
  return Math.max(0, date - Date.now());
}
