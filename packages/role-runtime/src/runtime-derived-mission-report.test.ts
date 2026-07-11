import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimeDerivedMissionReport,
  type ToolLoopCloseoutMetadata,
} from "./runtime-derived-mission-report";

test("buildRuntimeDerivedMissionReport returns undefined without closeout metadata", () => {
  assert.equal(buildRuntimeDerivedMissionReport(undefined), undefined);
});

test("buildRuntimeDerivedMissionReport maps completed session closeout to completed", () => {
  assert.deepEqual(
    buildRuntimeDerivedMissionReport({
      reason: "completed_sub_agent_final",
      toolCallCount: 1,
      roundCount: 1,
      evidenceAvailable: true,
    }),
    {
      status: "completed",
      reason: "completed_sub_agent_final",
      coverageVerified: true,
      source: "runtime_derived",
    },
  );
});

test("buildRuntimeDerivedMissionReport maps evidence-bearing exhaustion to partial", () => {
  const closeout: ToolLoopCloseoutMetadata = {
    reason: "round_limit",
    toolCallCount: 3,
    roundCount: 2,
    evidenceAvailable: true,
  };

  const report = buildRuntimeDerivedMissionReport(closeout);

  assert.deepEqual(report, {
    status: "partial",
    reason: "round_limit",
    source: "runtime_derived",
  });
  assert.equal("authorizedPartial" in (report ?? {}), false);
});

test("buildRuntimeDerivedMissionReport maps non-evidence and hard closeouts to blocked", () => {
  assert.deepEqual(
    buildRuntimeDerivedMissionReport({
      reason: "pseudo_tool_call",
      toolCallCount: 0,
      roundCount: 0,
      evidenceAvailable: false,
    }),
    {
      status: "blocked",
      reason: "pseudo_tool_call",
      source: "runtime_derived",
    },
  );
  assert.deepEqual(
    buildRuntimeDerivedMissionReport({
      reason: "recovery_tool_budget",
      toolCallCount: 4,
      roundCount: 3,
      evidenceAvailable: true,
    }),
    {
      status: "blocked",
      reason: "recovery_tool_budget",
      source: "runtime_derived",
    },
  );
});
