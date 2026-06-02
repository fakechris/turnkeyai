import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateRealLlmAbAcceptanceReport } from "@turnkeyai/qc-runtime/real-llm-ab-acceptance";

import {
  buildRealLlmAbAcceptanceReport,
  buildRealLlmAbReportBuildHelpText,
  parseRealLlmAbReportBuildArgs,
  runRealLlmAbReportBuildCli,
} from "./real-llm-ab-report-build";

test("real LLM A/B report builder parses args and help", () => {
  assert.deepEqual(parseRealLlmAbReportBuildArgs(["--spec", "/tmp/spec.json", "--out", "/tmp/report.json", "--check"]), {
    specPath: "/tmp/spec.json",
    outPath: "/tmp/report.json",
    check: true,
  });
  assert.deepEqual(
    parseRealLlmAbReportBuildArgs(["--spec", "/tmp/spec.json", "--out", "/tmp/report.json", "--check", "--suite", "core"]),
    {
      specPath: "/tmp/spec.json",
      outPath: "/tmp/report.json",
      check: true,
      requiredSuite: "core",
    }
  );
  assert.deepEqual(parseRealLlmAbReportBuildArgs(["--help"]), { help: true });
  assert.match(buildRealLlmAbReportBuildHelpText(), /real LLM A\/B report builder/);
  assert.match(buildRealLlmAbReportBuildHelpText(), /--suite core/);
  assert.throws(() => parseRealLlmAbReportBuildArgs(["--spec", "/tmp/spec.json"]), /missing required --out/);
  assert.throws(
    () => parseRealLlmAbReportBuildArgs(["--spec", "/tmp/spec.json", "--out", "/tmp/report.json", "--suite", "focused"]),
    /--suite must be core/
  );
});

test("real LLM A/B report builder emits a checkable report from natural and reference artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "browser-dynamic",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: "请打开这个动态页面，理解当前状态，找出应该关注的异常和下一步动作，并给出依据。",
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.status, "passed");
    assert.equal(report.capabilityClaim, "capability proven");
    assert.equal(report.scenarios[0]?.turnkeyai.missionId, "msn.test.1");
    assert.equal(report.scenarios[0]?.turnkeyai.dimensionScores.finalAnswerUsefulness, 2);
    assert.equal(report.scenarios[0]?.reference.dimensionScores.browserAuthenticity, 2);
    assert.equal(validateRealLlmAbAcceptanceReport(report).status, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder preserves reference weakness without treating it as a core loss", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir, { referenceUseful: false });
    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "browser-dynamic",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: "请打开这个动态页面，理解当前状态，找出应该关注的异常和下一步动作，并给出依据。",
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.status, "passed");
    assert.equal(report.scenarios[0]?.reference.finalAnswerUseful, false);
    assert.equal(validateRealLlmAbAcceptanceReport(report).status, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder CLI writes and checks output", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    writeFixtureFiles(dir);
    writeFileSync(
      path.join(dir, "spec.json"),
      JSON.stringify({
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "browser-dynamic",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: "请打开这个动态页面，理解当前状态，找出应该关注的异常和下一步动作，并给出依据。",
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      })
    );

    await runRealLlmAbReportBuildCli(["--spec", path.join(dir, "spec.json"), "--out", path.join(dir, "report.json"), "--check"]);

    const report = JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8")) as unknown;
    assert.equal(validateRealLlmAbAcceptanceReport(report).status, "passed");
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = previousExitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFixtureFiles(dir: string, options: { referenceUseful?: boolean } = {}): void {
  const referenceUseful = options.referenceUseful ?? true;
  writeFileSync(
    path.join(dir, "turnkeyai-natural.json"),
    JSON.stringify({
      kind: "turnkeyai.natural-mission-e2e.report",
      status: "passed",
      scenarios: [
        {
          scenario: "natural-browser-dynamic-page",
          missionId: "msn.test.1",
          threadId: "THREAD-test",
          status: "done",
          metrics: {
            tools: { requested: 1, results: 1, failed: 0, cancelled: 0, timeouts: 0 },
            sessions: { spawned: 1, continued: 0 },
            browser: { profileFallbacks: 0, failureBuckets: [] },
            approvals: { requested: 0, decided: 0, applied: 0 },
            liveness: { active: 0, waiting: 0, stale: 0 },
            evidenceEvents: 1,
          },
          artifacts: [
            { kind: "screenshot", id: "art.screenshot.1" },
            { kind: "snapshot", id: "art.snapshot.1" },
          ],
          natural: {
            status: "passed",
            completed: true,
            stuckOrLoop: false,
            reasonableToolUse: true,
            browserUsed: true,
            subAgentCompleted: true,
            approvalExercised: false,
            finalAnswerHasEvidence: true,
            finalAnswerUseful: true,
            weakAnswerSignals: [],
            sourceCoverage: { residualRiskVisible: true, unsupportedClaims: [] },
            dimensionScores: {
              taskCompletion: 2,
              evidenceQuality: 2,
              toolUseAppropriateness: 2,
              browserAuthenticity: 2,
              subAgentIndependence: 2,
              continuationBehavior: 2,
              permissionCorrectness: 2,
              timeoutCloseoutQuality: 2,
            },
            failureBuckets: [],
          },
        },
      ],
    })
  );
  writeFileSync(
    path.join(dir, "reference-browser.json"),
    JSON.stringify({
      system: "reference",
      threadId: "THREAD-reference",
      durationMs: 12000,
      timedOut: false,
      first: {
        summary: {
          toolCallCount: referenceUseful ? 1 : 0,
          toolResultCount: referenceUseful ? 1 : 0,
          pendingToolCount: 0,
        },
      },
      score: {
        useful: referenceUseful,
        weak: false,
      },
    })
  );
}
