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

const NATURAL_BROWSER_PROMPT = "请打开这个动态页面，理解当前状态，找出应该关注的异常和下一步动作，并给出依据。";

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
  assert.deepEqual(
    parseRealLlmAbReportBuildArgs([
      "--spec",
      "/tmp/spec.json",
      "--out",
      "/tmp/report.json",
      "--check",
      "--suite",
      "browser-focused",
    ]),
    {
      specPath: "/tmp/spec.json",
      outPath: "/tmp/report.json",
      check: true,
      requiredSuite: "browser-focused",
    }
  );
  assert.deepEqual(
    parseRealLlmAbReportBuildArgs([
      "--spec",
      "/tmp/spec.json",
      "--out",
      "/tmp/report.json",
      "--check",
      "--suite",
      "browser-reliability",
    ]),
    {
      specPath: "/tmp/spec.json",
      outPath: "/tmp/report.json",
      check: true,
      requiredSuite: "browser-reliability",
    }
  );
  assert.deepEqual(
    parseRealLlmAbReportBuildArgs([
      "--spec",
      "/tmp/spec.json",
      "--out",
      "/tmp/report.json",
      "--markdown-out",
      "/tmp/report.md",
    ]),
    {
      specPath: "/tmp/spec.json",
      outPath: "/tmp/report.json",
      check: false,
      markdownOutPath: "/tmp/report.md",
    }
  );
  assert.deepEqual(parseRealLlmAbReportBuildArgs(["--help"]), { help: true });
  assert.match(buildRealLlmAbReportBuildHelpText(), /real LLM A\/B report builder/);
  assert.match(buildRealLlmAbReportBuildHelpText(), /browser-focused/);
  assert.match(buildRealLlmAbReportBuildHelpText(), /browser-reliability/);
  assert.match(buildRealLlmAbReportBuildHelpText(), /--markdown-out/);
  assert.throws(() => parseRealLlmAbReportBuildArgs(["--spec", "/tmp/spec.json"]), /missing required --out/);
  assert.throws(
    () => parseRealLlmAbReportBuildArgs(["--spec", "/tmp/spec.json", "--out", "/tmp/report.json", "--markdown-out"]),
    /missing value for --markdown-out/
  );
  assert.throws(
    () => parseRealLlmAbReportBuildArgs(["--spec", "/tmp/spec.json", "--out", "/tmp/report.json", "--suite", "focused"]),
    /--suite must be one of: core, browser-focused, browser-reliability/
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
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.status, "passed");
    assert.equal(report.capabilityClaim, "focused capability proven");
    assert.equal(report.stabilityClaim, "focused stable");
    assert.equal(report.scenarios[0]?.turnkeyai.prompt, NATURAL_BROWSER_PROMPT);
    assert.equal(report.scenarios[0]?.reference.prompt, NATURAL_BROWSER_PROMPT);
    assert.equal(report.scenarios[0]?.turnkeyai.missionId, "msn.test.1");
    assert.equal(report.scenarios[0]?.turnkeyai.wallClockMs, 17_500);
    assert.equal(report.scenarios[0]?.turnkeyai.dimensionScores.finalAnswerUsefulness, 2);
    assert.equal(report.scenarios[0]?.reference.dimensionScores.browserAuthenticity, 2);
    assert.equal(validateRealLlmAbAcceptanceReport(report).status, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder accepts natural artifact summaries as browser evidence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const naturalPath = path.join(dir, "turnkeyai-natural.json");
    const natural = JSON.parse(readFileSync(naturalPath, "utf8")) as {
      scenarios: Array<{ artifacts: unknown }>;
    };
    natural.scenarios[0]!.artifacts = {
      count: 7,
      withLifecycle: 7,
      kinds: ["screenshot", "snapshot"],
    };
    writeFileSync(naturalPath, JSON.stringify(natural));

    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "browser-dynamic",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.status, "passed");
    assert.equal(report.scenarios[0]?.turnkeyai.browserEvidence.screenshotCount, 1);
    assert.equal(report.scenarios[0]?.turnkeyai.browserEvidence.snapshotCount, 1);
    assert.equal(validateRealLlmAbAcceptanceReport(report).status, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder accepts natural browser evidence events as audit evidence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const naturalPath = path.join(dir, "turnkeyai-natural.json");
    const natural = JSON.parse(readFileSync(naturalPath, "utf8")) as {
      scenarios: Array<{ artifacts: unknown; metrics: { qualityGate?: unknown; evidenceEvents?: number } }>;
    };
    natural.scenarios[0]!.artifacts = {
      count: 0,
      withLifecycle: 0,
      kinds: [],
    };
    natural.scenarios[0]!.metrics.evidenceEvents = 2;
    writeFileSync(naturalPath, JSON.stringify(natural));

    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "browser-dynamic",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.status, "passed");
    assert.equal(report.scenarios[0]?.turnkeyai.browserEvidence.screenshotCount, 0);
    assert.equal(report.scenarios[0]?.turnkeyai.browserEvidence.snapshotCount, 0);
    assert.equal(report.scenarios[0]?.turnkeyai.browserEvidence.logCount, 2);
    assert.equal(validateRealLlmAbAcceptanceReport(report).status, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder keeps verified profile fallback evidence rendered", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const naturalPath = path.join(dir, "turnkeyai-natural.json");
    const natural = JSON.parse(readFileSync(naturalPath, "utf8")) as {
      scenarios: Array<{ artifacts: unknown; metrics: { browser: { profileFallbacks: number; failureBuckets: unknown[] } } }>;
    };
    natural.scenarios[0]!.artifacts = {
      count: 0,
      withLifecycle: 0,
      kinds: [],
    };
    natural.scenarios[0]!.metrics.browser.profileFallbacks = 1;
    writeFileSync(naturalPath, JSON.stringify(natural));

    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "browser-profile-lock",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.status, "passed");
    assert.equal(report.scenarios[0]?.turnkeyai.browserEvidence.rendered, true);
    assert.equal(report.scenarios[0]?.turnkeyai.browserEvidence.logCount, 1);
    assert.equal(validateRealLlmAbAcceptanceReport(report).status, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder tolerates tool-unavailable wording only for bucketed browser closeout", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir, {
      naturalWeakAnswerSignals: ["tool unavailable fallback"],
      naturalBrowserFailureBuckets: [{ bucket: "browser_cdp_unavailable", count: 1, latestAtMs: 2_000 }],
    });
    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "browser-unavailable-closeout",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.status, "passed");
    assert.deepEqual(report.scenarios[0]?.turnkeyai.weakAnswerSignals, []);
    assert.equal(validateRealLlmAbAcceptanceReport(report).status, "passed");

    writeFixtureFiles(dir, {
      naturalWeakAnswerSignals: ["tool unavailable fallback"],
      naturalBrowserFailureBuckets: [],
    });
    const unbucketedReport = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "browser-unavailable-closeout",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );
    const unbucketedValidation = validateRealLlmAbAcceptanceReport(unbucketedReport);

    assert.equal(unbucketedReport.status, "failed");
    assert.deepEqual(unbucketedReport.scenarios[0]?.turnkeyai.weakAnswerSignals, ["tool unavailable fallback"]);
    assert.match(unbucketedValidation.failures.join("\n"), /root-cause review required/);
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
            prompt: NATURAL_BROWSER_PROMPT,
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

test("real LLM A/B report builder maps natural failure buckets and blocks zero-dimension capability claims", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir, {
      naturalFailureBuckets: ["timeout_closeout"],
      naturalDimensionScores: { timeoutCloseoutQuality: 0 },
    });
    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "browser-dynamic",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );
    const validation = validateRealLlmAbAcceptanceReport(report);

    assert.equal(report.status, "failed");
    assert.deepEqual(report.scenarios[0]?.turnkeyai.rootCauseBuckets, ["timeout_cancel_continue"]);
    assert.match(validation.failures.join("\n"), /TurnkeyAI scored 0 for timeoutCloseoutQuality/);
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
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      })
    );

    await runRealLlmAbReportBuildCli([
      "--spec",
      path.join(dir, "spec.json"),
      "--out",
      path.join(dir, "report.json"),
      "--markdown-out",
      path.join(dir, "report.md"),
      "--check",
    ]);

    const report = JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8")) as unknown;
    const markdown = readFileSync(path.join(dir, "report.md"), "utf8");
    assert.equal(validateRealLlmAbAcceptanceReport(report).status, "passed");
    assert.match(markdown, /# Real LLM A\/B Acceptance Report/);
    assert.match(markdown, /Capability: focused capability proven/);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = previousExitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder CLI checks the browser-focused suite", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    writeBrowserFocusedFixtureFiles(dir);
    writeFileSync(
      path.join(dir, "spec.json"),
      JSON.stringify({
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "natural-browser-external-page-review",
            turnkeyaiScenarioId: "natural-browser-external-page-review",
            prompt: "请查看外部页面，判断当前主要风险、证据和建议动作。",
            requiresBrowser: true,
            referenceArtifactPath: "natural-browser-external-page-review.json",
          },
          {
            scenarioId: "natural-browser-complex-page-review",
            turnkeyaiScenarioId: "natural-browser-complex-page-review",
            prompt: "请查看复杂交互页面，找出页面状态、异常信号和下一步动作。",
            requiresBrowser: true,
            referenceArtifactPath: "natural-browser-complex-page-review.json",
          },
        ],
      })
    );

    await runRealLlmAbReportBuildCli([
      "--spec",
      path.join(dir, "spec.json"),
      "--out",
      path.join(dir, "report.json"),
      "--markdown-out",
      path.join(dir, "report.md"),
      "--suite",
      "browser-focused",
      "--check",
    ]);

    const report = JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8")) as unknown;
    const markdown = readFileSync(path.join(dir, "report.md"), "utf8");
    assert.equal(validateRealLlmAbAcceptanceReport(report, { requiredSuite: "browser-focused" }).status, "passed");
    assert.match(markdown, /Capability: focused capability proven/);
    assert.match(markdown, /Status: passed/);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = previousExitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder CLI checks the browser-reliability suite", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  const previousExitCode = process.exitCode;
  const scenarios = [
    "natural-browser-followup-continuation",
    "natural-browser-restart-continuation",
    "natural-browser-cold-recreation-continuation",
    "natural-browser-profile-lock-recovery",
    "natural-browser-unavailable-closeout",
    "natural-browser-cdp-timeout-closeout",
    "natural-browser-detached-target-closeout",
    "natural-browser-attach-failed-closeout",
  ].map((scenario) => ({
    scenario,
    prompt: `请运行 ${scenario} 的自然浏览器可靠性验收，保留证据、风险和下一步动作。`,
  }));
  try {
    process.exitCode = undefined;
    writeBrowserFocusedFixtureFiles(dir, { scenarios });
    writeFileSync(
      path.join(dir, "spec.json"),
      JSON.stringify({
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: scenarios.map((scenario) => ({
          scenarioId: scenario.scenario,
          turnkeyaiScenarioId: scenario.scenario,
          prompt: scenario.prompt,
          requiresBrowser: true,
          referenceArtifactPath: `${scenario.scenario}.json`,
        })),
      })
    );

    await runRealLlmAbReportBuildCli([
      "--spec",
      path.join(dir, "spec.json"),
      "--out",
      path.join(dir, "report.json"),
      "--markdown-out",
      path.join(dir, "report.md"),
      "--suite",
      "browser-reliability",
      "--check",
    ]);

    const report = JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8")) as unknown;
    const markdown = readFileSync(path.join(dir, "report.md"), "utf8");
    assert.equal(validateRealLlmAbAcceptanceReport(report, { requiredSuite: "browser-reliability" }).status, "passed");
    assert.match(markdown, /Capability: focused capability proven/);
    assert.match(markdown, /Status: passed/);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = previousExitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder rejects JSON and Markdown output path collisions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const specPath = path.join(dir, "spec.json");
    const outPath = path.join(dir, "report.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "browser-dynamic",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      })
    );

    await assert.rejects(
      runRealLlmAbReportBuildCli(["--spec", specPath, "--out", outPath, "--markdown-out", outPath]),
      /--markdown-out must differ from --out/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder leaves missing or mismatched run prompts unproven", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir, { referencePrompt: undefined });
    const missingPromptReport = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "browser-dynamic",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );
    const missingPromptValidation = validateRealLlmAbAcceptanceReport(missingPromptReport);
    assert.equal(missingPromptReport.status, "failed");
    assert.match(missingPromptValidation.failures.join("\n"), /reference: missing run prompt evidence/);

    writeFixtureFiles(dir, { referencePrompt: "请用另一个任务检查一个不同页面。" });
    const mismatchedPromptReport = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "browser-dynamic",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );
    const mismatchedPromptValidation = validateRealLlmAbAcceptanceReport(mismatchedPromptReport);
    assert.equal(mismatchedPromptReport.status, "failed");
    assert.match(mismatchedPromptValidation.failures.join("\n"), /reference: run prompt does not match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFixtureFiles(
  dir: string,
  options: {
    referenceUseful?: boolean;
    referencePrompt?: string | undefined;
    naturalFailureBuckets?: string[];
    naturalDimensionScores?: Partial<Record<string, 0 | 1 | 2>>;
    naturalWeakAnswerSignals?: string[];
    naturalBrowserFailureBuckets?: Array<{ bucket: string; count: number; latestAtMs: number }>;
  } = {}
): void {
  const referenceUseful = options.referenceUseful ?? true;
  const referencePrompt = "referencePrompt" in options ? options.referencePrompt : NATURAL_BROWSER_PROMPT;
  writeFileSync(
    path.join(dir, "turnkeyai-natural.json"),
    JSON.stringify({
      kind: "turnkeyai.natural-mission-e2e.report",
      status: "passed",
      scenarios: [
        {
          scenario: "natural-browser-dynamic-page",
          prompt: NATURAL_BROWSER_PROMPT,
          missionId: "msn.test.1",
          durationMs: 17_500,
          threadId: "THREAD-test",
          status: "done",
          metrics: {
            tools: { requested: 1, results: 1, failed: 0, cancelled: 0, timeouts: 0 },
            sessions: { spawned: 1, continued: 0 },
            browser: { profileFallbacks: 0, failureBuckets: options.naturalBrowserFailureBuckets ?? [] },
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
            weakAnswerSignals: options.naturalWeakAnswerSignals ?? [],
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
              ...(options.naturalDimensionScores ?? {}),
            },
            failureBuckets: options.naturalFailureBuckets ?? [],
          },
        },
      ],
    })
  );
  writeFileSync(
    path.join(dir, "reference-browser.json"),
    JSON.stringify({
      system: "reference",
      ...(referencePrompt ? { prompt: referencePrompt } : {}),
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

function writeBrowserFocusedFixtureFiles(
  dir: string,
  options: {
    scenarios?: Array<{ scenario: string; prompt: string }>;
  } = {}
): void {
  const scenarios = options.scenarios ?? [
    {
      scenario: "natural-browser-external-page-review",
      prompt: "请查看外部页面，判断当前主要风险、证据和建议动作。",
    },
    {
      scenario: "natural-browser-complex-page-review",
      prompt: "请查看复杂交互页面，找出页面状态、异常信号和下一步动作。",
    },
  ];
  writeFileSync(
    path.join(dir, "turnkeyai-natural.json"),
    JSON.stringify({
      kind: "turnkeyai.natural-mission-e2e.report",
      status: "passed",
      scenarios: scenarios.map((scenario, index) => ({
        scenario: scenario.scenario,
        prompt: scenario.prompt,
        missionId: `msn.browser.${index + 1}`,
        durationMs: 20_000 + index,
        threadId: `THREAD-browser-${index + 1}`,
        status: "done",
        metrics: {
          tools: { requested: 2, results: 2, failed: 0, cancelled: 0, timeouts: 0 },
          sessions: { spawned: 1, continued: 0 },
          browser: { profileFallbacks: 0, failureBuckets: [] },
          approvals: { requested: 0, decided: 0, applied: 0 },
          liveness: { active: 0, waiting: 0, stale: 0 },
          evidenceEvents: 2,
        },
        artifacts: [
          { kind: "screenshot", id: `art.screenshot.${index + 1}` },
          { kind: "snapshot", id: `art.snapshot.${index + 1}` },
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
            finalAnswerUsefulness: 2,
          },
          failureBuckets: [],
        },
      })),
    })
  );
  for (const scenario of scenarios) {
    writeFileSync(
      path.join(dir, `${scenario.scenario}.json`),
      JSON.stringify({
        system: "reference",
        prompt: scenario.prompt,
        threadId: `THREAD-reference-${scenario.scenario}`,
        durationMs: 12_000,
        timedOut: false,
        first: {
          summary: {
            toolCallCount: 1,
            toolResultCount: 1,
            pendingToolCount: 0,
          },
        },
        score: {
          useful: true,
          weak: false,
        },
      })
    );
  }
}
