export class AttemptDeadlineExceededError extends Error {
  readonly code = "attempt_deadline_exceeded" as const;
  readonly clockKind = "attempt_active" as const;
  readonly deadlineAt: number;

  constructor(deadlineAt: number) {
    super(`active attempt deadline exceeded at ${deadlineAt}`);
    this.name = "AbortError";
    this.deadlineAt = deadlineAt;
  }
}

export interface AttemptDeadline {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  remainingMs(): number;
  cap(localLimitMs: number): number;
  dispose(): void;
}

export function createAttemptDeadline<TTimer = ReturnType<typeof setTimeout>>(input: {
  maxWallClockMs: number;
  parentSignal?: AbortSignal;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => TTimer;
  clearTimeout?: (timer: TTimer) => void;
}): AttemptDeadline {
  if (!Number.isFinite(input.maxWallClockMs) || input.maxWallClockMs <= 0) {
    throw new RangeError("maxWallClockMs must be a positive finite number");
  }

  const now = input.now ?? Date.now;
  const schedule = input.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs) as TTimer);
  const cancel = input.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const deadlineAt = now() + input.maxWallClockMs;
  const controller = new AbortController();
  let timer: TTimer | undefined;
  let disposed = false;

  const cancelTimer = () => {
    if (timer === undefined) return;
    cancel(timer);
    timer = undefined;
  };
  const abortOnce = (reason: unknown) => {
    if (controller.signal.aborted || disposed) return;
    controller.abort(reason);
    cancelTimer();
  };
  const onParentAbort = () => {
    abortOnce(input.parentSignal?.reason ?? new Error("run cancelled"));
  };

  if (input.parentSignal?.aborted) {
    abortOnce(input.parentSignal.reason ?? new Error("run cancelled"));
  } else {
    input.parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    timer = schedule(() => {
      abortOnce(new AttemptDeadlineExceededError(deadlineAt));
    }, input.maxWallClockMs);
  }

  return {
    deadlineAt,
    signal: controller.signal,
    remainingMs() {
      return Math.max(0, deadlineAt - now());
    },
    cap(localLimitMs: number) {
      if (!Number.isFinite(localLimitMs) || localLimitMs <= 0) return 0;
      return Math.min(localLimitMs, Math.max(0, deadlineAt - now()));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTimer();
      input.parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

export function isAttemptDeadlineExceeded(error: unknown): error is AttemptDeadlineExceededError {
  return error instanceof AttemptDeadlineExceededError || (
    error instanceof Error &&
    "code" in error &&
    (error.code === "attempt_deadline_exceeded" ||
      error.code === "run_deadline_exceeded")
  );
}

/** Compatibility aliases for persisted callers during the V2 migration. */
export const RunDeadlineExceededError = AttemptDeadlineExceededError;
export type RunDeadline = AttemptDeadline;
export const createRunDeadline = createAttemptDeadline;
export const isRunDeadlineExceeded = isAttemptDeadlineExceeded;
