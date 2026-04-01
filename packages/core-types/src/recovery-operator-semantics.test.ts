import assert from "node:assert/strict";
import test from "node:test";

import {
  describeRecoveryRunGate,
  isAllowedRecoveryRunAction,
  listAllowedRecoveryRunActions,
} from "./recovery-operator-semantics";

test("recovery operator semantics expose allowed actions by run status", () => {
  assert.deepEqual(listAllowedRecoveryRunActions("planned"), ["dispatch", "retry", "fallback", "resume", "reject"]);
  assert.deepEqual(listAllowedRecoveryRunActions("waiting_approval"), ["approve", "reject"]);
  assert.deepEqual(listAllowedRecoveryRunActions("recovered"), []);
  assert.equal(isAllowedRecoveryRunAction("failed", "retry"), true);
  assert.equal(isAllowedRecoveryRunAction("running", "retry"), false);
});

test("recovery operator semantics describe stable gate wording", () => {
  assert.equal(describeRecoveryRunGate("waiting_approval"), "waiting for approval");
  assert.equal(describeRecoveryRunGate("waiting_external"), "waiting for external/manual follow-up");
  assert.equal(describeRecoveryRunGate("running"), "dispatch in progress");
  assert.equal(describeRecoveryRunGate("failed"), "failed and awaiting next recovery action");
  assert.equal(describeRecoveryRunGate("recovered"), "recovered");
});
