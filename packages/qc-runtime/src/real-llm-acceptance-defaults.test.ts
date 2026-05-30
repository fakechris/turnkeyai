import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_TOOLUSE_NON_BROWSER_SCENARIOS,
  joinRealAcceptanceScenarios,
} from "./real-llm-acceptance-defaults";

test("real LLM acceptance defaults include the product-level mission matrix", () => {
  assert.deepEqual([...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_NON_BROWSER_SCENARIOS], [
    "basic",
    "approval",
    "followup",
    "timeout",
  ]);
  assert.deepEqual([...DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS], [
    "basic",
    "approval",
    "followup",
    "timeout",
    "complex",
  ]);
  assert.deepEqual([...DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS], [
    "basic",
    "comparison",
    "followup",
    "cancel",
    "approval",
    "browser-dynamic",
    "browser-dashboard",
    "timeout-recovery",
    "memory-recall",
    "task-tracking",
    "product-workbench-brief",
    "realistic-brief",
  ]);
  assert.equal(
    joinRealAcceptanceScenarios(DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS),
    "basic,comparison,followup,cancel,approval,browser-dynamic,browser-dashboard,timeout-recovery,memory-recall,task-tracking,product-workbench-brief,realistic-brief"
  );
});
