import assert from "node:assert/strict";
import test from "node:test";

import { enginePolicyTraceDebugEnabled } from "./policy-trace";

test("enginePolicyTraceDebugEnabled is opt-in through the env gate", () => {
  const previous = process.env.TURNKEYAI_ENGINE_POLICY_TRACE;
  try {
    delete process.env.TURNKEYAI_ENGINE_POLICY_TRACE;
    assert.equal(enginePolicyTraceDebugEnabled(), false);

    process.env.TURNKEYAI_ENGINE_POLICY_TRACE = "0";
    assert.equal(enginePolicyTraceDebugEnabled(), false);

    process.env.TURNKEYAI_ENGINE_POLICY_TRACE = "1";
    assert.equal(enginePolicyTraceDebugEnabled(), true);
  } finally {
    if (previous === undefined) {
      delete process.env.TURNKEYAI_ENGINE_POLICY_TRACE;
    } else {
      process.env.TURNKEYAI_ENGINE_POLICY_TRACE = previous;
    }
  }
});
