import assert from "node:assert/strict";
import test from "node:test";

import { listBoundedRegressionCases, runBoundedRegressionSuite } from "./bounded-regression-harness";

test("bounded regression harness lists built-in cases", () => {
  const cases = listBoundedRegressionCases();
  assert.ok(cases.length >= 36);
  assert.ok(cases.some((item) => item.caseId === "runtime-summary-aligns-manual-recovery-and-operator-attention"));
  assert.ok(cases.some((item) => item.caseId === "runtime-summary-keeps-browser-recovered-chain-active"));
  assert.ok(cases.some((item) => item.caseId === "runtime-summary-preserves-reconnect-window-before-stale"));
  assert.ok(cases.some((item) => item.caseId === "runtime-summary-aligns-browser-recovered-manual-follow-up"));
  assert.ok(cases.some((item) => item.caseId === "operator-triage-prioritizes-compound-incident"));
  assert.ok(cases.some((item) => item.caseId === "runtime-summary-surfaces-stale-waiting-point-and-child-span"));
  assert.ok(cases.some((item) => item.caseId === "runtime-summary-prioritizes-attention-chains"));
  assert.ok(cases.some((item) => item.caseId === "runtime-child-session-progress-visible"));
  assert.ok(cases.some((item) => item.caseId === "session-follow-up-reuses-existing-chain"));
  assert.ok(cases.some((item) => item.caseId === "session-scheduled-reentry-preserves-existing-continuity"));
  assert.ok(cases.some((item) => item.caseId === "runtime-chain-query-answers-root-active-and-waiting-point"));
  assert.ok(cases.some((item) => item.caseId === "runtime-prompt-console-summarizes-boundaries"));
  assert.ok(cases.some((item) => item.caseId === "context-runtime-pressure-keeps-carry-forward-and-waiting-visible"));
  assert.ok(cases.some((item) => item.caseId === "recovery-retry-escalation"));
  assert.ok(cases.some((item) => item.caseId === "recovery-browser-detached-target"));
  assert.ok(cases.some((item) => item.caseId === "browser-recovery-cold-reopen-outcome"));
  assert.ok(cases.some((item) => item.caseId === "browser-recovery-recovered-but-waiting-manual-stays-visible"));
  assert.ok(cases.some((item) => item.caseId === "replay-console-browser-continuity-counts"));
  assert.ok(cases.some((item) => item.caseId === "parallel-three-shard-success-ready-to-merge"));
  assert.ok(cases.some((item) => item.caseId === "parallel-flow-summary-highlights-shard-issues"));
  assert.ok(cases.some((item) => item.caseId === "parallel-flow-summary-clears-attention-after-retry"));
  assert.ok(cases.some((item) => item.caseId === "governance-official-api-success-high-trust"));
  assert.ok(cases.some((item) => item.caseId === "governance-summary-highlights-browser-fallback"));
  assert.ok(cases.some((item) => item.caseId === "governance-approval-required-side-effect-blocks"));
  assert.ok(cases.some((item) => item.caseId === "governance-publish-readback-verifies-closure"));
  assert.ok(cases.some((item) => item.caseId === "operator-summary-aligns-attention-across-surfaces"));
  assert.ok(cases.some((item) => item.caseId === "operator-summary-clears-recovery-attention-after-recovery"));
  assert.ok(cases.some((item) => item.caseId === "operator-attention-aligns-with-summary"));
  assert.ok(cases.some((item) => item.caseId === "operator-case-cards-preserve-order-and-metadata"));
  assert.ok(cases.some((item) => item.caseId === "operator-surfaces-track-recovery-lifecycle"));
  assert.ok(cases.some((item) => item.caseId === "replay-bundle-exposes-recovery-operator-gate"));
  assert.ok(cases.some((item) => item.caseId === "parallel-follow-up-summary-stays-open"));
  assert.ok(cases.some((item) => item.caseId === "recovery-approval-fallback-chain"));
  assert.ok(cases.some((item) => item.caseId === "recovery-reject-aborts-chain"));
  assert.ok(cases.some((item) => item.caseId === "replay-console-attention-stays-aligned"));
  assert.ok(cases.some((item) => item.caseId === "replay-console-surfaces-workflow-state"));
  assert.ok(cases.some((item) => item.caseId === "relay-recovery-workflow-log-surfaces-peer-diagnostics"));
  assert.ok(cases.some((item) => item.caseId === "direct-cdp-recovery-workflow-log-surfaces-reconnect-diagnostics"));
  assert.ok(cases.some((item) => item.caseId === "parallel-follow-up-summary-closes-after-recovery"));
  assert.ok(cases.some((item) => item.caseId === "recovery-bundle-closes-after-approved-fallback"));
  assert.ok(cases.some((item) => item.caseId === "browser-ownership-reclaim-keeps-single-recovered-case"));
  assert.ok(cases.some((item) => item.caseId === "context-evidence-heavy-keeps-pending-work"));
  assert.ok(cases.some((item) => item.caseId === "context-reentry-preserves-active-tasks-and-open-questions"));
  assert.ok(cases.some((item) => item.caseId === "context-continuity-keeps-decisions-and-constraints-under-budget"));
  assert.ok(cases.some((item) => item.caseId === "context-continuity-keeps-journal-notes-under-budget"));
});

test("bounded regression harness runs all built-in cases", () => {
  const result = runBoundedRegressionSuite();
  assert.equal(result.failedCases, 0);
  assert.equal(result.passedCases, result.totalCases);
});

test("bounded regression harness can filter cases", () => {
  const result = runBoundedRegressionSuite(["recovery-fallback-downgrade"]);
  assert.equal(result.totalCases, 1);
  assert.equal(result.results[0]?.caseId, "recovery-fallback-downgrade");
  assert.equal(result.results[0]?.status, "passed");
});

test("bounded regression harness can run the browser continuity case directly", () => {
  const result = runBoundedRegressionSuite(["browser-recovery-cold-reopen-outcome"]);
  assert.equal(result.totalCases, 1);
  assert.equal(result.results[0]?.status, "passed");
});

test("bounded regression harness can run replay console browser continuity counts", () => {
  const result = runBoundedRegressionSuite(["replay-console-browser-continuity-counts"]);
  assert.equal(result.totalCases, 1);
  assert.equal(result.results[0]?.status, "passed");
});

test("bounded regression harness can run replay console workflow surface case", () => {
  const result = runBoundedRegressionSuite(["replay-console-surfaces-workflow-state"]);
  assert.equal(result.totalCases, 1);
  assert.equal(result.results[0]?.status, "passed");
});

test("bounded regression harness can run relay workflow-log surface case", () => {
  const result = runBoundedRegressionSuite(["relay-recovery-workflow-log-surfaces-peer-diagnostics"]);
  assert.equal(result.totalCases, 1);
  assert.equal(result.results[0]?.status, "passed");
});

test("bounded regression harness can run direct-cdp workflow-log surface case", () => {
  const result = runBoundedRegressionSuite(["direct-cdp-recovery-workflow-log-surfaces-reconnect-diagnostics"]);
  assert.equal(result.totalCases, 1);
  assert.equal(result.results[0]?.status, "passed");
});

test("bounded regression harness can run governance and parallel operator cases", () => {
  const result = runBoundedRegressionSuite([
    "parallel-flow-summary-highlights-shard-issues",
    "parallel-flow-summary-clears-attention-after-retry",
    "governance-summary-highlights-browser-fallback",
    "governance-publish-readback-verifies-closure",
    "operator-summary-aligns-attention-across-surfaces",
    "operator-summary-clears-recovery-attention-after-recovery",
    "operator-attention-aligns-with-summary",
    "operator-case-cards-preserve-order-and-metadata",
    "operator-surfaces-track-recovery-lifecycle",
  ]);
  assert.equal(result.totalCases, 9);
  assert.equal(result.failedCases, 0);
});

test("bounded regression harness can run extended parallel and recovery chain cases", () => {
  const result = runBoundedRegressionSuite([
    "replay-bundle-exposes-recovery-operator-gate",
    "parallel-follow-up-summary-stays-open",
    "parallel-follow-up-summary-closes-after-recovery",
    "recovery-approval-fallback-chain",
    "recovery-reject-aborts-chain",
    "recovery-bundle-closes-after-approved-fallback",
    "replay-console-attention-stays-aligned",
    "replay-console-surfaces-workflow-state",
    "relay-recovery-workflow-log-surfaces-peer-diagnostics",
    "direct-cdp-recovery-workflow-log-surfaces-reconnect-diagnostics",
  ]);
  assert.equal(result.totalCases, 10);
  assert.equal(result.failedCases, 0);
});

test("bounded regression harness can run runtime validation cases", () => {
  const result = runBoundedRegressionSuite([
    "runtime-summary-aligns-manual-recovery-and-operator-attention",
    "runtime-summary-keeps-browser-recovered-chain-active",
    "runtime-summary-preserves-reconnect-window-before-stale",
    "runtime-summary-aligns-browser-recovered-manual-follow-up",
    "operator-triage-prioritizes-compound-incident",
    "runtime-summary-surfaces-stale-waiting-point-and-child-span",
    "runtime-summary-prioritizes-attention-chains",
    "runtime-child-session-progress-visible",
    "session-follow-up-reuses-existing-chain",
    "session-scheduled-reentry-preserves-existing-continuity",
    "runtime-chain-query-answers-root-active-and-waiting-point",
    "runtime-prompt-console-summarizes-boundaries",
    "context-runtime-pressure-keeps-carry-forward-and-waiting-visible",
    "context-continuity-keeps-decisions-and-constraints-under-budget",
    "context-continuity-keeps-journal-notes-under-budget",
    "context-evidence-heavy-keeps-pending-work",
    "context-reentry-preserves-active-tasks-and-open-questions",
  ]);
  assert.equal(result.totalCases, 17);
  assert.equal(result.failedCases, 0);
});

test("bounded regression harness can run scenario-parity governance and parallel cases", () => {
  const result = runBoundedRegressionSuite([
    "parallel-three-shard-success-ready-to-merge",
    "parallel-flow-summary-clears-attention-after-retry",
    "parallel-flow-summary-highlights-shard-issues",
    "governance-official-api-success-high-trust",
    "governance-summary-highlights-browser-fallback",
    "governance-approval-required-side-effect-blocks",
    "governance-publish-readback-verifies-closure",
    "browser-ownership-reclaim-keeps-single-recovered-case",
  ]);
  assert.equal(result.totalCases, 8);
  assert.equal(result.failedCases, 0);
});
