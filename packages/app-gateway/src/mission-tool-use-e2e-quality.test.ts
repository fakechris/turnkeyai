import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFinalQuality, type ScenarioSpec } from "../../../scripts/mission-tool-use-e2e";

function buildSpec(): ScenarioSpec {
  return {
    scenario: "product-workbench-brief",
    title: "quality gate fixture",
    desc: "fixture",
    finalMarker: "TURNKEYAI_FINAL_OK",
    evidenceMarkers: ["TURNKEYAI_EVIDENCE_OK"],
    answerTerms: ["residual risk"],
    minBytes: 1,
    expectedSpawnCalls: 0,
    expectedSendCalls: 0,
    expectedToolResults: 0,
    expectedSpawnedSessions: 0,
    expectedContinuedSessions: 0,
    minEvidenceEvents: 0,
    expectedBullets: 1,
  };
}

test("mission E2E quality gate rejects status preambles before an exact final shape", () => {
  const quality = evaluateFinalQuality(
    [
      "All three child sessions have returned with the required markers.",
      "evidence",
      "- evidence: TURNKEYAI_FINAL_OK; TURNKEYAI_EVIDENCE_OK with residual risk stated.",
    ].join("\n"),
    buildSpec()
  );

  assert.ok(quality.failures.includes("final answer must not start with a status preamble"));
});

test("mission E2E quality gate accepts plain section labels without a status preamble", () => {
  const quality = evaluateFinalQuality(
    ["evidence", "- evidence: TURNKEYAI_FINAL_OK; TURNKEYAI_EVIDENCE_OK with residual risk stated."].join("\n"),
    buildSpec()
  );

  assert.deepEqual(quality.failures, []);
});

test("mission E2E quality gate handles long first lines without regex backtracking", () => {
  const quality = evaluateFinalQuality(
    [
      `all ${"child ".repeat(500)}sessions returned`,
      "- evidence: TURNKEYAI_FINAL_OK; TURNKEYAI_EVIDENCE_OK with residual risk stated.",
    ].join("\n"),
    buildSpec()
  );

  assert.ok(quality.failures.includes("final answer must not start with a status preamble"));
});
