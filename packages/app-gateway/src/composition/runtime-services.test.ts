import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_DAEMON_RUNTIME_LIMITS } from "./runtime-services";

test("default daemon runtime limits keep outer role loops aligned with the native tool loop budget", () => {
  assert.equal(DEFAULT_DAEMON_RUNTIME_LIMITS.memberMaxIterations, 128);
  assert.equal(DEFAULT_DAEMON_RUNTIME_LIMITS.flowMaxHops, 20);
  assert.equal(DEFAULT_DAEMON_RUNTIME_LIMITS.maxQueuedHandoffsPerRole, 4);
  assert.equal(DEFAULT_DAEMON_RUNTIME_LIMITS.maxPerRoleHopCount, 3);
});
