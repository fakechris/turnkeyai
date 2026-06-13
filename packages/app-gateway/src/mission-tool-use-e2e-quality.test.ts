import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFinalQuality,
  findWeakAnswerSignals,
  findWeakEvidenceSignals,
  type ScenarioSpec,
} from "../../../scripts/mission-tool-use-e2e";

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

test("mission E2E quality gate rejects tool-unavailable fallback answers", () => {
  const quality = evaluateFinalQuality(
    [
      "evidence",
      "- evidence: TURNKEYAI_FINAL_OK; TURNKEYAI_EVIDENCE_OK with residual risk stated.",
      "- caveat: 搜索工具暂时无法返回结果，基于我的知识库给出结论。",
    ].join("\n"),
    { ...buildSpec(), expectedBullets: 2 }
  );

  assert.ok(
    quality.failures.includes("final answer falls back to model knowledge after tool/search/browser unavailable")
  );
});

test("mission E2E quality gate handles long fallback phrasing without regex backtracking", () => {
  const quality = evaluateFinalQuality(
    [
      "evidence",
      "- evidence: TURNKEYAI_FINAL_OK; TURNKEYAI_EVIDENCE_OK with residual risk stated.",
      `- caveat: Search${" ".repeat(20_000)}tool${" ".repeat(20_000)}is${" ".repeat(20_000)}unavailable; using my knowledge instead.`,
    ].join("\n"),
    { ...buildSpec(), expectedBullets: 2 }
  );

  assert.ok(
    quality.failures.includes("final answer falls back to model knowledge after tool/search/browser unavailable")
  );
});

test("natural mission weak answer gate rejects delegation-only closeouts", () => {
  const samples = [
    ["**Delegate to: explore**", "Fetch both vendor pages and return full content."].join("\n"),
    "Delegated to role-browser for follow-up verification.",
    ["## Handoff", "[TO: role-browser]"].join("\n"),
  ];

  for (const sample of samples) {
    const signals = findWeakAnswerSignals(sample);
    assert.ok(signals.includes("delegation-only closeout"), sample);
  }
});

test("natural mission weak answer gate allows synthesized answers that mention delegation as evidence", () => {
  const signals = findWeakAnswerSignals(
    [
      "Recommendation: choose Vendor Alpha for the browser-heavy workflow.",
      "Evidence: the delegated browser specialist verified queue depth 11 and the analyst verified $19 pricing.",
      "Residual risk: this is source-bounded to the checked pages.",
    ].join("\n")
  );

  assert.ok(!signals.includes("delegation-only closeout"));
});

test("natural mission weak answer gate allows synthesized browser failure closeouts with delegated evidence excerpts", () => {
  const signals = findWeakAnswerSignals(
    [
      "**Closeout: Natural browser unavailable**",
      "**What was verified**",
      "- The browser sub-agent runtime is non-functional: CDP endpoint returns ECONNREFUSED across 5 attempts.",
      "- Dashboard content at `http://127.0.0.1:65104/ops-dashboard` is not verified.",
      "**What remains unverified**",
      "- All rendered dashboard elements, metrics, tables, and JavaScript-rendered content.",
      "**Next action for operator**",
      "Restart or repair the browser sub-agent runtime, then retry the dashboard review.",
      "Browser failure buckets: browser_cdp_unavailable=5.",
      "## Task Failure - Browser Runtime Unavailable",
      "**Delegated task:** Navigate to the dashboard and capture a full screenshot.",
    ].join("\n")
  );

  assert.ok(!signals.includes("delegation-only closeout"));
});

test("natural mission weak answer gate allows source-bounded inability to estimate", () => {
  const signals = findWeakAnswerSignals(
    [
      "Verified facts: Vendor Alpha lists $19 per seat and browser automation with traceable screenshots.",
      "Unknowns: minimum seats and billing cycle are absent from the checked source, so we can't estimate entry cost.",
      "Residual risk: treat missing SLA and support details as unverified rather than absent.",
    ].join("\n")
  );

  assert.ok(!signals.includes("placeholder uncertainty"));
});

test("natural mission weak answer gate still rejects unsupported estimate language", () => {
  const signals = findWeakAnswerSignals(
    "Vendor Alpha pricing is a lower-bound estimate at $19/seat. It probably fits teams that value browser automation."
  );

  assert.ok(signals.includes("placeholder uncertainty"));
});

test("natural mission weak evidence gate ignores business-scope unverified fields near screenshot terms", () => {
  const signals = findWeakEvidenceSignals(
    [
      "Verified facts: browser automation capability; traceable screenshots; limited API catalog.",
      "Unverified / Not Confirmed: target market, security certifications, support SLA, and company background.",
    ].join("\n"),
    { browserEvidenceExpected: true }
  );

  assert.deepEqual(signals, []);
});

test("natural mission weak evidence gate still catches explicit screenshot evidence verification failures", () => {
  const signals = findWeakEvidenceSignals("Screenshot evidence verification is incomplete after the page capture.", {
    browserEvidenceExpected: true,
  });

  assert.ok(signals.includes("browser evidence not verified"));
});
