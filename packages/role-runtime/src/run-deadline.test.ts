import assert from "node:assert/strict";
import test from "node:test";

import {
  AttemptDeadlineExceededError,
  createAttemptDeadline,
} from "./run-deadline";

function createControlledTimer(startAt = 1_000) {
  let now = startAt;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  return {
    now: () => now,
    setTimeout(callback: () => void, delayMs: number) {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    advanceTo(nextNow: number) {
      now = nextNow;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    },
    pending: () => timers.size,
  };
}

test("attempt deadline exposes one active budget and caps local operations", () => {
  const timer = createControlledTimer();
  const deadline = createAttemptDeadline({
    maxWallClockMs: 500,
    now: timer.now,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
  });

  assert.equal(deadline.deadlineAt, 1_500);
  assert.equal(deadline.remainingMs(), 500);
  assert.equal(deadline.cap(900), 500);
  assert.equal(deadline.cap(200), 200);

  timer.advanceTo(1_350);
  assert.equal(deadline.remainingMs(), 150);
  assert.equal(deadline.cap(200), 150);

  deadline.dispose();
});

test("attempt deadline preserves the first parent abort reason", () => {
  const timer = createControlledTimer();
  const parent = new AbortController();
  const parentReason = new Error("operator cancelled run");
  const deadline = createAttemptDeadline({
    maxWallClockMs: 500,
    parentSignal: parent.signal,
    now: timer.now,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
  });

  parent.abort(parentReason);
  timer.advanceTo(1_500);

  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.signal.reason, parentReason);
  assert.equal(timer.pending(), 0);

  deadline.dispose();
});

test("attempt deadline aborts with a typed deadline reason", () => {
  const timer = createControlledTimer();
  const deadline = createAttemptDeadline({
    maxWallClockMs: 500,
    now: timer.now,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
  });

  timer.advanceTo(1_500);

  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.signal.reason instanceof AttemptDeadlineExceededError, true);
  assert.equal(deadline.signal.reason.clockKind, "attempt_active");
  assert.equal(deadline.signal.reason.code, "attempt_deadline_exceeded");
  assert.equal(deadline.remainingMs(), 0);
  assert.equal(deadline.cap(100), 0);

  deadline.dispose();
});

test("attempt deadline adopts an already-aborted parent without scheduling", () => {
  const timer = createControlledTimer();
  const parent = new AbortController();
  const reason = new Error("already cancelled");
  parent.abort(reason);

  const deadline = createAttemptDeadline({
    maxWallClockMs: 500,
    parentSignal: parent.signal,
    now: timer.now,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
  });

  assert.equal(deadline.signal.reason, reason);
  assert.equal(timer.pending(), 0);
  deadline.dispose();
});

test("attempt deadline disposal is idempotent and detaches parent cancellation", () => {
  const timer = createControlledTimer();
  const parent = new AbortController();
  const deadline = createAttemptDeadline({
    maxWallClockMs: 500,
    parentSignal: parent.signal,
    now: timer.now,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
  });

  deadline.dispose();
  deadline.dispose();
  parent.abort(new Error("late cancellation"));
  timer.advanceTo(1_500);

  assert.equal(deadline.signal.aborted, false);
  assert.equal(timer.pending(), 0);
});
