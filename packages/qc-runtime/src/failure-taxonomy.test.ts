import assert from "node:assert/strict";
import test from "node:test";

import { classifyRuntimeError } from "./failure-taxonomy";

test("failure taxonomy prefers explicit runtime error codes over message regexes", () => {
  const failure = classifyRuntimeError({
    layer: "worker",
    error: {
      code: "WORKER_TIMEOUT",
      message: "permission denied while waiting",
      retryable: false,
    },
    fallbackMessage: "worker failed",
  });

  assert.equal(failure.category, "timeout");
  assert.equal(failure.recommendedAction, "resume");
  assert.equal(failure.retryable, true);
});

test("failure taxonomy recognizes detached target resume failures", () => {
  const failure = classifyRuntimeError({
    layer: "browser",
    error: "invalid resume: detached target cannot be reopened without a URL (target-1)",
    fallbackMessage: "browser failed",
  });

  assert.equal(failure.category, "invalid_resume");
  assert.equal(failure.recommendedAction, "retry");
});

test("failure taxonomy recognizes lease eviction as stale session", () => {
  const failure = classifyRuntimeError({
    layer: "browser",
    error: "idle eviction closed the browser session",
    fallbackMessage: "browser failed",
  });

  assert.equal(failure.category, "stale_session");
  assert.equal(failure.recommendedAction, "resume");
});
