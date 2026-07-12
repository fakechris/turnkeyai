import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveContinuationToolTimeoutMs,
  resolveToolTimeoutMs,
} from "./operation-timeout-budget";

test("operation timeout composition never enlarges an explicit bound", () => {
  for (const workerKind of ["browser", "explore", "finance", "coder", "harness"] as const) {
    assert.equal(resolveToolTimeoutMs(5, workerKind), 5_000);
    assert.equal(resolveToolTimeoutMs(25, workerKind, 10_000), 10_000);
  }
});

test("continuation timeout preserves an explicit bound for cancelled sessions", () => {
  assert.equal(
    resolveContinuationToolTimeoutMs(0.001, "explore", "cancelled"),
    1,
  );
  assert.equal(
    resolveContinuationToolTimeoutMs(90, "browser", "resumable"),
    45_000,
  );
});
