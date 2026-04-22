import assert from "node:assert/strict";
import test from "node:test";

import {
  describeRecoveryRunGate,
  deriveRecoveryRunOperatorCaseState,
  isAllowedRecoveryRunAction,
  listAllowedRecoveryRunActions,
  listOperatorRecoveryRunActions,
} from "./recovery-operator-semantics";

test("recovery operator semantics expose allowed actions by run status", () => {
  assert.deepEqual(listAllowedRecoveryRunActions("planned"), ["dispatch", "retry", "fallback", "resume", "reject"]);
  assert.deepEqual(listAllowedRecoveryRunActions("waiting_approval"), ["approve", "reject"]);
  assert.deepEqual(listAllowedRecoveryRunActions("recovered"), []);
  assert.equal(isAllowedRecoveryRunAction("failed", "retry"), true);
  assert.equal(isAllowedRecoveryRunAction("running", "retry"), false);
  assert.deepEqual(listOperatorRecoveryRunActions("planned"), ["retry", "fallback", "resume", "reject"]);
});

test("recovery operator semantics describe stable gate wording", () => {
  assert.equal(describeRecoveryRunGate("waiting_approval"), "waiting for approval");
  assert.equal(describeRecoveryRunGate("waiting_external"), "waiting for external/manual follow-up");
  assert.equal(describeRecoveryRunGate("running"), "dispatch in progress");
  assert.equal(describeRecoveryRunGate("failed"), "failed and awaiting next recovery action");
  assert.equal(describeRecoveryRunGate("recovered"), "recovered");
});

test("recovery operator semantics derive stable case states from run status", () => {
  assert.equal(deriveRecoveryRunOperatorCaseState("planned"), "open");
  assert.equal(deriveRecoveryRunOperatorCaseState("running"), "recovering");
  assert.equal(deriveRecoveryRunOperatorCaseState("retrying"), "recovering");
  assert.equal(deriveRecoveryRunOperatorCaseState("fallback_running"), "recovering");
  assert.equal(deriveRecoveryRunOperatorCaseState("resumed"), "recovering");
  assert.equal(deriveRecoveryRunOperatorCaseState("superseded"), "recovering");
  assert.equal(deriveRecoveryRunOperatorCaseState("waiting_approval"), "waiting_manual");
  assert.equal(deriveRecoveryRunOperatorCaseState("waiting_external"), "waiting_manual");
  assert.equal(deriveRecoveryRunOperatorCaseState("failed"), "blocked");
  assert.equal(deriveRecoveryRunOperatorCaseState("aborted"), "blocked");
  assert.equal(deriveRecoveryRunOperatorCaseState("recovered"), "resolved");
  assert.equal(deriveRecoveryRunOperatorCaseState({ status: "waiting_external" }), "waiting_manual");
});
