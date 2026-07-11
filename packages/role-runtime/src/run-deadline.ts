export class RunDeadlineExceededError extends Error {
  readonly code = "run_deadline_exceeded" as const;
  readonly deadlineAt: number;

  constructor(deadlineAt: number) {
    super(`run deadline exceeded at ${deadlineAt}`);
    this.name = "AbortError";
    this.deadlineAt = deadlineAt;
  }
}

export interface RunDeadline {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  remainingMs(): number;
  cap(localLimitMs: number): number;
  dispose(): void;
}

export function createRunDeadline<TTimer = ReturnType<typeof setTimeout>>(input: {
  maxWallClockMs: number;
  parentSignal?: AbortSignal;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => TTimer;
  clearTimeout?: (timer: TTimer) => void;
}): RunDeadline {
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
      abortOnce(new RunDeadlineExceededError(deadlineAt));
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

export function isRunDeadlineExceeded(error: unknown): error is RunDeadlineExceededError {
  return error instanceof RunDeadlineExceededError || (
    error instanceof Error &&
    "code" in error &&
    error.code === "run_deadline_exceeded"
  );
}
