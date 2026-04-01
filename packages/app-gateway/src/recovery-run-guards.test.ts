import assert from "node:assert/strict";
import test from "node:test";

import type { RecoveryRun } from "@turnkeyai/core-types/team";

import { buildRecoveryRunActionConflict, validateRecoveryRunAction } from "./recovery-run-guards";

function buildRun(status: RecoveryRun["status"]): RecoveryRun {
  return {
    recoveryRunId: "recovery:task-1",
    threadId: "thread-1",
    sourceGroupId: "task-1",
    latestStatus: "failed",
    status,
    nextAction: "retry_same_layer",
    autoDispatchReady: false,
    requiresManualIntervention: false,
    latestSummary: "needs follow-up",
    attempts: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

test("validateRecoveryRunAction blocks concurrent in-flight recovery actions", () => {
  assert.equal(
    validateRecoveryRunAction(buildRun("retrying"), "fallback"),
    "recovery run already has an in-flight attempt"
  );
  assert.equal(validateRecoveryRunAction(buildRun("resumed"), "resume"), "recovery run already has an in-flight attempt");
  assert.equal(validateRecoveryRunAction(buildRun("retrying"), "reject"), null);
  assert.equal(validateRecoveryRunAction(buildRun("resumed"), "reject"), null);
  assert.equal(validateRecoveryRunAction(buildRun("running"), "reject"), null);
  assert.equal(validateRecoveryRunAction(buildRun("fallback_running"), "reject"), null);
});

test("validateRecoveryRunAction requires approval before continued recovery", () => {
  assert.equal(
    validateRecoveryRunAction(buildRun("waiting_approval"), "resume"),
    "recovery run requires approval before it can continue"
  );
  assert.equal(validateRecoveryRunAction(buildRun("waiting_approval"), "approve"), null);
});

test("validateRecoveryRunAction blocks terminal recovery runs", () => {
  assert.equal(validateRecoveryRunAction(buildRun("recovered"), "retry"), "recovery run is already recovered");
  assert.equal(validateRecoveryRunAction(buildRun("aborted"), "resume"), "recovery run is already aborted");
  assert.equal(validateRecoveryRunAction(buildRun("recovered"), "reject"), "recovery run is already recovered");
});

test("buildRecoveryRunActionConflict exposes gate and allowed actions for operator feedback", () => {
  const conflict = buildRecoveryRunActionConflict(buildRun("waiting_approval"), "resume");
  assert.deepEqual(conflict, {
    error: "recovery run requires approval before it can continue",
    recoveryRun: buildRun("waiting_approval"),
    currentGate: "waiting for approval",
    allowedActions: ["approve", "reject"],
  });
});

test("buildRecoveryRunActionConflict returns null when the action is allowed", () => {
  assert.equal(buildRecoveryRunActionConflict(buildRun("failed"), "retry"), null);
});

test("buildRecoveryRunActionConflict filters internal dispatch from operator-facing actions", () => {
  const conflict = buildRecoveryRunActionConflict(buildRun("planned"), "approve", "approval is not available");
  assert.deepEqual(conflict?.allowedActions, ["retry", "fallback", "resume", "reject"]);
});
