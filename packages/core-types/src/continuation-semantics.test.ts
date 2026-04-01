import assert from "node:assert/strict";
import test from "node:test";

import {
  hasApprovalSignal,
  hasContinuationActionSignal,
  hasContinuationBacklogSignal,
  hasContinuationDirectiveSignal,
  hasContinuationSignal,
  hasMergeContinuationSignal,
  hasMergeSignal,
  hasWaitingDependencySignal,
} from "./continuation-semantics";

test("continuation semantics recognize blocker-only backlog phrasing", () => {
  const content = "Browser blocker remains until the login checkpoint is restored.";
  assert.equal(hasContinuationSignal(content), true);
  assert.equal(hasContinuationBacklogSignal(content), true);
  assert.equal(hasMergeSignal(content), true);
});

test("continuation semantics distinguish directive and action phrasing", () => {
  assert.equal(hasContinuationDirectiveSignal("Please continue with the same browser session."), true);
  assert.equal(hasContinuationActionSignal("Retry the browser step after the fallback."), true);
  assert.equal(hasContinuationDirectiveSignal("Approval is still pending."), false);
});

test("continuation semantics recognize merge and waiting dependency wording", () => {
  assert.equal(
    hasMergeContinuationSignal("Merge follow-up: finance output is still missing and approval is pending."),
    true
  );
  assert.equal(hasWaitingDependencySignal("Still waiting on operator approval before retry."), true);
  assert.equal(hasApprovalSignal("Manual approval is still required."), true);
});
