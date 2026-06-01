import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS,
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
  assert.deepEqual([...DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS], [
    "natural-comparison-research",
    "natural-browser-dynamic-page",
    "natural-browser-followup-continuation",
    "natural-browser-restart-continuation",
    "natural-browser-cold-recreation-continuation",
    "natural-browser-profile-lock-recovery",
    "natural-followup-continuation",
    "natural-memory-recall",
    "natural-approval-dry-run-action",
    "natural-approval-denied-safe-closeout",
    "natural-approval-pending-state",
    "natural-browser-unavailable-closeout",
    "natural-browser-cdp-timeout-closeout",
    "natural-timeout-partial-closeout",
    "natural-timeout-followup-continuation",
    "natural-cancel-active-tool",
    "natural-cancel-followup-continuation",
    "natural-long-delegation",
  ]);
  assert.equal(
    joinRealAcceptanceScenarios(DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS),
    "basic,comparison,followup,cancel,approval,browser-dynamic,browser-dashboard,timeout-recovery,memory-recall,task-tracking,product-workbench-brief,realistic-brief"
  );
  assert.equal(
    joinRealAcceptanceScenarios(DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS),
    "natural-comparison-research,natural-browser-dynamic-page,natural-browser-followup-continuation,natural-browser-restart-continuation,natural-browser-cold-recreation-continuation,natural-browser-profile-lock-recovery,natural-followup-continuation,natural-memory-recall,natural-approval-dry-run-action,natural-approval-denied-safe-closeout,natural-approval-pending-state,natural-browser-unavailable-closeout,natural-browser-cdp-timeout-closeout,natural-timeout-partial-closeout,natural-timeout-followup-continuation,natural-cancel-active-tool,natural-cancel-followup-continuation,natural-long-delegation"
  );
});
