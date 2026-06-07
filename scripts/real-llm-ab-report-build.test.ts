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
      "full-natural",
    ]),
    {
      specPath: "/tmp/spec.json",
      outPath: "/tmp/report.json",
      check: true,
      requiredSuite: "full-natural",
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
  assert.match(buildRealLlmAbReportBuildHelpText(), /full-natural/);
  assert.match(buildRealLlmAbReportBuildHelpText(), /--markdown-out/);
  assert.throws(() => parseRealLlmAbReportBuildArgs(["--spec", "/tmp/spec.json"]), /missing required --out/);
  assert.throws(
    () => parseRealLlmAbReportBuildArgs(["--spec", "/tmp/spec.json", "--out", "/tmp/report.json", "--markdown-out"]),
    /missing value for --markdown-out/
  );
  assert.throws(
    () => parseRealLlmAbReportBuildArgs(["--spec", "/tmp/spec.json", "--out", "/tmp/report.json", "--suite", "focused"]),
    /--suite must be one of: core, browser-focused, browser-reliability, full-natural/
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
    assert.equal(report.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(report.scenarios[0]?.referenceAudit?.provenanceStatus, "passed");
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

test("real LLM A/B report builder tolerates pruning browser transport warnings only with proven evidence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir, { naturalWeakAnswerSignals: ["browser transport degraded"] });
    const naturalPath = path.join(dir, "turnkeyai-natural.json");
    const natural = JSON.parse(readFileSync(naturalPath, "utf8")) as { scenarios: Array<Record<string, unknown>> };
    natural.scenarios[0] = {
      ...(natural.scenarios[0] ?? {}),
      scenario: "natural-tool-result-pruning",
    };
    writeFileSync(naturalPath, JSON.stringify(natural));

    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "natural-tool-result-pruning",
            turnkeyaiScenarioId: "natural-tool-result-pruning",
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

    writeFixtureFiles(dir, { naturalWeakAnswerSignals: ["browser transport degraded"] });
    const nonPruningReport = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "natural-browser-dynamic-page",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(nonPruningReport.status, "failed");
    assert.deepEqual(nonPruningReport.scenarios[0]?.turnkeyai.weakAnswerSignals, ["browser transport degraded"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder downgrades weak reference answers instead of validating comparison", () => {
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

    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.comparisonClassification, "adapter_unproven");
    assert.equal(report.scenarios[0]?.referenceAudit?.adapterStatus, "failed");
    assert.equal(report.scenarios[0]?.reference.finalAnswerUseful, false);
    assert.ok(report.scenarios[0]?.referenceAudit?.findings.includes("reference final answer is not marked useful"));
    assert.equal(validateRealLlmAbAcceptanceReport(report).status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder downgrades reference environment failures", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir, {
      referenceNotes: "Browser worker failed for session failed-test. Error: page.evaluate: ReferenceError: __name is not defined",
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
    assert.equal(report.capabilityClaim, "unproven");
    assert.equal(report.scenarios[0]?.comparisonClassification, "reference_env_failed");
    assert.equal(report.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "failed");
    assert.match(validation.failures.join("\n"), /comparison is not validated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder downgrades reference artifacts without provenance", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir, { referenceProvenance: false });
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
    assert.equal(report.capabilityClaim, "unproven");
    assert.equal(report.scenarios[0]?.comparisonClassification, "adapter_unproven");
    assert.equal(report.scenarios[0]?.referenceAudit?.provenanceStatus, "failed");
    assert.match(validation.failures.join("\n"), /provenance gate failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder treats unknown model provenance as unproven", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      provenance?: { modelCatalog?: unknown; provider?: unknown; modelId?: unknown };
    };
    if (reference.provenance) {
      reference.provenance.modelCatalog = "unknown";
      reference.provenance.provider = "unknown";
      reference.provenance.modelId = "unknown";
    }
    writeFileSync(referencePath, JSON.stringify(reference));

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

    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.comparisonClassification, "adapter_unproven");
    assert.equal(report.scenarios[0]?.referenceAudit?.provenanceStatus, "failed");
    assert.deepEqual(report.scenarios[0]?.referenceAudit?.missingProvenance.sort(), [
      "modelCatalog",
      "modelId",
      "provider",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder requires reference native tool or worker evidence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      rawToolCalls?: unknown[];
      rawToolResults?: unknown[];
      first?: { summary?: { toolCallCount?: number; toolResultCount?: number } };
      provenance?: { rawToolCalls?: unknown[]; rawToolResults?: unknown[] };
    };
    reference.rawToolCalls = [];
    reference.rawToolResults = [];
    if (reference.provenance) {
      reference.provenance.rawToolCalls = [];
      reference.provenance.rawToolResults = [];
    }
    if (reference.first?.summary) {
      reference.first.summary.toolCallCount = 0;
      reference.first.summary.toolResultCount = 0;
    }
    writeFileSync(referencePath, JSON.stringify(reference));

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

    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.comparisonClassification, "reference_env_failed");
    assert.equal(report.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "failed");
    assert.equal(report.scenarios[0]?.referenceAudit?.adapterStatus, "failed");
    assert.ok(
      report.scenarios[0]?.referenceAudit?.findings.includes(
        "reference native tool/worker execution was not observed"
      )
    );
    assert.ok(
      report.scenarios[0]?.referenceAudit?.findings.includes("reference native tool/worker result was not observed")
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder downgrades reference browser artifacts without rendered evidence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      rawBrowserEvidence?: unknown;
      provenance?: { rawBrowserEvidence?: unknown };
    };
    const sessionOnlyEvidence = [{ sessions: [{ browserSessionId: "BSESS-reference-1", targetIds: ["target-1"] }] }];
    reference.rawBrowserEvidence = sessionOnlyEvidence;
    if (reference.provenance) reference.provenance.rawBrowserEvidence = sessionOnlyEvidence;
    writeFileSync(referencePath, JSON.stringify(reference));

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
    assert.equal(report.scenarios[0]?.comparisonClassification, "adapter_unproven");
    assert.equal(report.scenarios[0]?.referenceAudit?.adapterStatus, "failed");
    assert.ok(
      report.scenarios[0]?.referenceAudit?.findings.includes(
        "reference browser evidence does not include rendered page evidence"
      )
    );
    assert.match(validation.failures.join("\n"), /reference: adapter mapping gate failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder classifies failed reference browser history as runtime health failure", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      rawBrowserEvidence?: unknown;
      provenance?: { rawBrowserEvidence?: unknown };
    };
    const failedBrowserEvidence = [
      {
        sessionId: "BSESS-reference-1",
        history: [{ status: "failed", actionKinds: ["open", "snapshot", "screenshot"] }],
      },
    ];
    reference.rawBrowserEvidence = failedBrowserEvidence;
    if (reference.provenance) reference.provenance.rawBrowserEvidence = failedBrowserEvidence;
    writeFileSync(referencePath, JSON.stringify(reference));

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

    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.comparisonClassification, "reference_env_failed");
    assert.equal(report.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "failed");
    assert.ok(
      report.scenarios[0]?.referenceAudit?.findings.includes("reference browser evidence reports failed browser history")
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder validates mission-linked approval reference artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const prompt = "Open the local approval form and carry a safe dry-run through the approval gate.";
    const natural = JSON.parse(readFileSync(path.join(dir, "turnkeyai-natural.json"), "utf8")) as {
      scenarios: Array<Record<string, unknown>>;
    };
    natural.scenarios[0] = {
      ...(natural.scenarios[0] ?? {}),
      scenario: "natural-approval-dry-run-action",
      prompt,
      metrics: {
        tools: {
          requested: 4,
          results: 4,
          failed: 0,
          cancelled: 0,
          timeouts: 0,
          names: ["permission_query", "permission_result", "permission_applied", "sessions_spawn"],
        },
        sessions: { spawned: 1, continued: 0 },
        browser: { profileFallbacks: 0, failureBuckets: [] },
        approvals: { requested: 1, decided: 1, applied: 1 },
        liveness: { active: 0, waiting: 0, stale: 0 },
        evidenceEvents: 2,
      },
      natural: {
        status: "passed",
        completed: true,
        stuckOrLoop: false,
        reasonableToolUse: true,
        browserUsed: true,
        subAgentCompleted: true,
        approvalExercised: true,
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
    };
    writeFileSync(path.join(dir, "turnkeyai-natural.json"), JSON.stringify(natural));
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as Record<string, unknown> & {
      provenance: Record<string, unknown>;
      first: { summary: Record<string, unknown> };
      score: Record<string, unknown>;
    };
    const rawApprovalEvidence = [
      {
        source: "approval_driver",
        approvalId: "ap.reference.1",
        decision: { decision: { approvalId: "ap.reference.1", decision: "approved" } },
      },
    ];
    const rawBrowserEvidence = [{ source: "session_tool_result", rendered: true, status: "completed" }];
    reference.prompt = prompt;
    reference.missionId = "msn.reference.1";
    reference.threadId = "THREAD-reference-approval";
    reference.provenance = {
      ...buildReferenceProvenance(prompt),
      apiEndpoint: "/missions",
      missionId: "msn.reference.1",
      exactRequestPayload: { title: prompt, desc: "", mode: "browser" },
      rawApprovalEvidence,
      rawBrowserEvidence,
    };
    reference.rawApprovalEvidence = rawApprovalEvidence;
    reference.rawBrowserEvidence = rawBrowserEvidence;
    reference.rawToolCalls = [{ name: "permission_query" }, { name: "sessions_spawn" }];
    reference.rawToolResults = [{ name: "permission_query", status: "ok" }, { name: "sessions_spawn", status: "ok" }];
    reference.provenance.rawToolCalls = reference.rawToolCalls;
    reference.provenance.rawToolResults = reference.rawToolResults;
    reference.first.summary = {
      toolCallCount: 2,
      toolResultCount: 2,
      pendingToolCount: 0,
      finalText:
        "Approval was granted, permission already granted on the thread, and the dry-run form submitted successfully with rendered browser evidence.",
    };
    reference.score = { useful: true, weak: false };
    writeFileSync(referencePath, JSON.stringify(reference));

    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "natural-approval-dry-run-action",
            turnkeyaiScenarioId: "natural-approval-dry-run-action",
            prompt,
            requiresApproval: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.status, "passed");
    assert.equal(report.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(report.scenarios[0]?.referenceAudit?.adapterStatus, "passed");
    assert.equal(report.scenarios[0]?.reference.approval?.decided, true);
    assert.equal(report.scenarios[0]?.reference.approval?.applied, true);
    assert.equal(report.scenarios[0]?.reference.browserEvidence?.rendered, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder validates approval wait-timeout baseline loss artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const prompt =
      "Open the local approval form and start a safe dry-run browser form submission attempt for operator review. If the operator decision does not arrive during this attempt, stop without submitting the form.";
    const natural = JSON.parse(readFileSync(path.join(dir, "turnkeyai-natural.json"), "utf8")) as {
      scenarios: Array<Record<string, unknown>>;
    };
    natural.scenarios[0] = {
      ...(natural.scenarios[0] ?? {}),
      scenario: "natural-approval-wait-timeout-closeout",
      prompt,
      missionId: "msn.turnkey.wait-timeout",
      durationMs: 32_000,
      status: "done",
      metrics: {
        tools: {
          requested: 2,
          results: 2,
          failed: 1,
          cancelled: 0,
          timeouts: 1,
          names: ["permission_query", "sessions_spawn"],
        },
        sessions: { spawned: 0, continued: 0 },
        browser: { profileFallbacks: 0, failureBuckets: [] },
        approvals: { requested: 1, decided: 0, applied: 0 },
        liveness: { active: 0, waiting: 0, stale: 0 },
        evidenceEvents: 2,
      },
      natural: {
        status: "passed",
        completed: true,
        stuckOrLoop: false,
        reasonableToolUse: true,
        browserUsed: false,
        subAgentCompleted: true,
        approvalExercised: true,
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
    };
    writeFileSync(path.join(dir, "turnkeyai-natural.json"), JSON.stringify(natural));
    const referencePath = path.join(dir, "reference-browser.json");
    const rawApprovalEvidence = [
      {
        source: "approval_driver",
        status: "observed_pending",
        approvalId: "ap.reference.timeout",
        approval: {
          id: "ap.reference.timeout",
          action: "browser.form.submit",
          decision: null,
        },
      },
    ];
    const reference = {
      system: "reference",
      prompt,
      missionId: "msn.reference.timeout",
      threadId: "THREAD-reference-timeout",
      durationMs: 300_000,
      timedOut: true,
      provenance: {
        ...buildReferenceProvenance(prompt),
        apiEndpoint: "/missions",
        missionId: "msn.reference.timeout",
        exactRequestPayload: { title: prompt, desc: "", mode: "browser" },
        rawResponse: {
          id: "msn.reference.timeout",
          status: "needs_approval",
          threadId: "THREAD-reference-timeout",
        },
        rawTranscript: {
          messages: [
            { role: "user", content: prompt },
            { role: "assistant", content: "" },
          ],
        },
        rawToolCalls: [{ name: "permission_query" }],
        rawToolResults: [],
        rawBrowserEvidence: [],
        rawApprovalEvidence,
        referenceScenarioDriver: {
          approvalDecisionPolicy: "wait_timeout",
          envRequirements: { TURNKEYAI_TOOL_PERMISSION_WAIT_MS: "2000" },
        },
        exitStatus: "timeout",
        errorReason: "timeout waiting for assistant response",
      },
      rawResponse: {
        id: "msn.reference.timeout",
        status: "needs_approval",
        threadId: "THREAD-reference-timeout",
      },
      rawTranscript: {
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: "" },
        ],
      },
      rawToolCalls: [{ name: "permission_query" }],
      rawToolResults: [],
      rawBrowserEvidence: [],
      rawApprovalEvidence,
      artifactAdapterMappingSource: "scripts/real-llm-ab-reference-collect.ts",
      collectedAtMs: 1,
      exitStatus: "timeout",
      errorReason: "timeout waiting for assistant response",
      first: {
        summary: {
          toolCallCount: 1,
          toolResultCount: 0,
          pendingToolCount: 0,
          finalText: "",
        },
      },
      score: {
        useful: false,
        weak: false,
      },
    };
    writeFileSync(referencePath, JSON.stringify(reference));

    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "natural-approval-wait-timeout-closeout",
            turnkeyaiScenarioId: "natural-approval-wait-timeout-closeout",
            prompt,
            requiresApproval: true,
            requiresTimeoutCloseout: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );
    const validation = validateRealLlmAbAcceptanceReport(report);

    assert.equal(report.status, "passed", JSON.stringify({ validation, scenario: report.scenarios[0] }, null, 2));
    assert.equal(validation.status, "passed", JSON.stringify(validation, null, 2));
    assert.equal(report.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(report.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "passed");
    assert.equal(report.scenarios[0]?.referenceAudit?.adapterStatus, "passed");
    assert.equal(report.scenarios[0]?.reference.completed, false);
    assert.equal(report.scenarios[0]?.reference.timeout?.timedOut, true);
    assert.equal(report.scenarios[0]?.reference.timeout?.partialCloseout, false);
    assert.equal(report.scenarios[0]?.reference.approval?.requested, true);
    assert.equal(report.scenarios[0]?.reference.approval?.decided, false);
    assert.equal(report.scenarios[0]?.reference.approval?.applied, false);
    assert.equal(report.scenarios[0]?.reference.dimensionScores.timeoutCloseoutQuality, 0);
    assert.equal(report.scenarios[0]?.reference.dimensionScores.finalAnswerUsefulness, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder validates timeout-partial native-work baseline loss artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const prompt =
      "Evaluate this slow source for a release-risk note.\nSlow source: http://127.0.0.1:65170/slow-fixture\nUse a bounded attempt. If the source does not return in time, close out with the evidence that is available, clearly separating verified facts from unverified items and explaining how to continue.";
    const natural = JSON.parse(readFileSync(path.join(dir, "turnkeyai-natural.json"), "utf8")) as {
      scenarios: Array<Record<string, unknown>>;
    };
    natural.scenarios[0] = {
      ...(natural.scenarios[0] ?? {}),
      scenario: "natural-timeout-partial-closeout",
      prompt,
      missionId: "msn.turnkey.timeout-partial",
      durationMs: 46_000,
      status: "done",
      metrics: {
        tools: {
          requested: 1,
          results: 1,
          failed: 1,
          cancelled: 0,
          timeouts: 1,
          names: ["sessions_spawn"],
        },
        sessions: { spawned: 1, continued: 0 },
        browser: { profileFallbacks: 0, failureBuckets: [] },
        approvals: { requested: 0, decided: 0, applied: 0 },
        liveness: { active: 0, waiting: 0, stale: 0 },
        evidenceEvents: 1,
      },
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
      final: {
        excerpt:
          "Verified: the endpoint was targeted. Unverified: response body, status, and release-risk content; the slow source timed out before output. Continue by retrying with a longer bounded window.",
      },
    };
    writeFileSync(path.join(dir, "turnkeyai-natural.json"), JSON.stringify(natural));
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = {
      system: "reference",
      prompt,
      missionId: "msn.reference.timeout-partial",
      threadId: "THREAD-reference-timeout-partial",
      durationMs: 90_000,
      timedOut: true,
      provenance: {
        ...buildReferenceProvenance(prompt),
        apiEndpoint: "/missions",
        missionId: "msn.reference.timeout-partial",
        exactRequestPayload: { title: prompt, desc: "", mode: "research" },
        rawResponse: {
          id: "msn.reference.timeout-partial",
          status: "working",
          threadId: "THREAD-reference-timeout-partial",
        },
        rawTranscript: [
          { role: "user", content: prompt },
          {
            role: "assistant",
            content: "",
            metadata: {
              spawnedWorkers: [{ workerType: "explore", workerRunKey: "worker:explore:slow-source-timeout" }],
              workerState: { status: "running" },
            },
          },
        ],
        rawToolCalls: [{ name: "explore", workerRunKey: "worker:explore:slow-source-timeout" }],
        rawToolResults: [
          {
            role: "tool",
            name: "sessions_spawn",
            toolStatus: "failed",
            content:
              "explore sub-agent returned no executable result. The requested task did not match the worker's implemented capability.",
          },
        ],
        rawBrowserEvidence: [],
        referenceScenarioDriver: {
          kind: "timeout_partial",
          supported: true,
          missionThread: true,
          missionMode: "research",
        },
        exitStatus: "timeout",
        errorReason: "timeout waiting for assistant response",
      },
      rawResponse: {
        id: "msn.reference.timeout-partial",
        status: "working",
        threadId: "THREAD-reference-timeout-partial",
      },
      rawTranscript: [
        { role: "user", content: prompt },
        {
          role: "assistant",
          content: "",
          metadata: {
            spawnedWorkers: [{ workerType: "explore", workerRunKey: "worker:explore:slow-source-timeout" }],
            workerState: { status: "running" },
          },
        },
      ],
      rawToolCalls: [{ name: "explore", workerRunKey: "worker:explore:slow-source-timeout" }],
      rawToolResults: [
        {
          role: "tool",
          name: "sessions_spawn",
          toolStatus: "failed",
          content:
            "explore sub-agent returned no executable result. The requested task did not match the worker's implemented capability.",
        },
      ],
      rawBrowserEvidence: [],
      artifactAdapterMappingSource: "scripts/real-llm-ab-reference-collect.ts",
      collectedAtMs: 1,
      exitStatus: "timeout",
      errorReason: "timeout waiting for assistant response",
      first: {
        summary: {
          toolCallCount: 1,
          toolResultCount: 1,
          pendingToolCount: 0,
          finalText: "",
        },
      },
      score: {
        useful: false,
        weak: false,
      },
    };
    writeFileSync(referencePath, JSON.stringify(reference));

    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "natural-timeout-partial-closeout",
            turnkeyaiScenarioId: "natural-timeout-partial-closeout",
            prompt,
            requiresTimeoutCloseout: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );
    const validation = validateRealLlmAbAcceptanceReport(report);

    assert.equal(report.status, "passed", JSON.stringify({ validation, scenario: report.scenarios[0] }, null, 2));
    assert.equal(validation.status, "passed", JSON.stringify(validation, null, 2));
    assert.equal(report.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(report.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "passed");
    assert.equal(report.scenarios[0]?.referenceAudit?.adapterStatus, "passed");
    assert.equal(report.scenarios[0]?.turnkeyai.timeout?.partialCloseout, true);
    assert.equal(report.scenarios[0]?.reference.completed, false);
    assert.equal(report.scenarios[0]?.reference.timeout?.timedOut, true);
    assert.equal(report.scenarios[0]?.reference.timeout?.partialCloseout, false);
    assert.equal(report.scenarios[0]?.reference.timeout?.hardAborted, true);
    assert.equal(report.scenarios[0]?.reference.dimensionScores.timeoutCloseoutQuality, 0);
    assert.equal(report.scenarios[0]?.reference.dimensionScores.finalAnswerUsefulness, 0);

    natural.scenarios[0] = {
      ...(natural.scenarios[0] ?? {}),
      scenario: "natural-timeout-followup-continuation",
      metrics: {
        ...(natural.scenarios[0]?.metrics as Record<string, unknown>),
        sessions: { spawned: 1, continued: 1 },
      },
    };
    writeFileSync(path.join(dir, "turnkeyai-natural.json"), JSON.stringify(natural));
    reference.timedOut = false;
    reference.exitStatus = "success";
    reference.errorReason = "none";
    reference.provenance.referenceScenarioDriver.kind = "timeout_followup";
    reference.provenance.exitStatus = "success";
    reference.provenance.errorReason = "none";
    reference.first.summary.finalText =
      "Lead is operating as Lead Coordinator. Close the flow with a concise final message. Verified: explore sub-agent returned no executable result.";
    reference.followup = {
      summary: {
        toolCallCount: 1,
        toolResultCount: 1,
        pendingToolCount: 0,
        finalText:
          "Lead is operating as Lead Coordinator. Continuation: continue the same session rather than starting duplicate work.",
      },
    };
    reference.score = { useful: false, weak: true };
    writeFileSync(referencePath, JSON.stringify(reference));
    const followupReport = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "natural-timeout-followup-continuation",
            turnkeyaiScenarioId: "natural-timeout-followup-continuation",
            prompt,
            requiresContinuation: true,
            requiresTimeoutCloseout: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );
    const followupValidation = validateRealLlmAbAcceptanceReport(followupReport);
    assert.equal(
      followupReport.status,
      "passed",
      JSON.stringify({ validation: followupValidation, scenario: followupReport.scenarios[0] }, null, 2)
    );
    assert.equal(followupReport.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(followupReport.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "passed");
    assert.equal(followupReport.scenarios[0]?.referenceAudit?.adapterStatus, "passed");
    assert.equal(followupReport.scenarios[0]?.reference.continuation?.required, true);
    assert.equal(followupReport.scenarios[0]?.reference.timeout?.hardAborted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder rejects harness-text reference output with failed worker metadata", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      rawTranscript?: unknown;
      first?: { summary?: { finalText?: string } };
      rawResponse?: { finalText?: string };
      score?: { weak?: boolean; useful?: boolean };
      provenance?: { rawTranscript?: unknown; rawResponse?: unknown };
    };
    const rawTranscript = [
      { role: "user", content: NATURAL_BROWSER_PROMPT },
      {
        role: "assistant",
        content: "Lead is operating as Lead Coordinator. Close the flow with a concise final message.",
        metadata: {
          fallbackReason: `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
          workerState: {
            status: "failed",
            lastResult: {
              status: "failed",
              summary: "Browser worker failed for session failed-test.",
            },
          },
        },
      },
    ];
    reference.rawTranscript = rawTranscript;
    reference.rawResponse = { finalText: "Lead is operating as Lead Coordinator. Close the flow with a concise final message." };
    if (reference.first?.summary) {
      reference.first.summary.finalText = reference.rawResponse.finalText;
    }
    reference.score = { weak: true, useful: false };
    if (reference.provenance) {
      reference.provenance.rawTranscript = rawTranscript;
      reference.provenance.rawResponse = reference.rawResponse;
    }
    writeFileSync(referencePath, JSON.stringify(reference));

    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "comparison-research",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: NATURAL_BROWSER_PROMPT,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.comparisonClassification, "reference_env_failed");
    assert.equal(report.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "failed");
    assert.equal(report.scenarios[0]?.referenceAudit?.adapterStatus, "failed");
    assert.ok(
      report.scenarios[0]?.referenceAudit?.findings.includes(
        "reference final answer contains harness or weak-answer text"
      )
    );
    assert.ok(
      report.scenarios[0]?.referenceAudit?.findings.includes(
        "reference runtime health failure detected in raw transcript or worker metadata"
      )
    );
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

    writeFixtureFiles(dir, {
      referenceExactRequestPayloadPrompt: "请用另一个任务检查一个不同页面。",
    });
    const mismatchedPayloadReport = buildRealLlmAbAcceptanceReport(
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
    const mismatchedPayloadValidation = validateRealLlmAbAcceptanceReport(mismatchedPayloadReport);
    assert.equal(mismatchedPayloadReport.status, "failed");
    assert.equal(mismatchedPayloadReport.scenarios[0]?.comparisonClassification, "unfair_prompt_or_fixture");
    assert.equal(mismatchedPayloadReport.scenarios[0]?.referenceAudit?.fairnessStatus, "failed");
    assert.match(
      mismatchedPayloadValidation.failures.join("\n"),
      /comparison is not validated \(unfair_prompt_or_fixture\)/
    );
    assert.ok(
      mismatchedPayloadReport.scenarios[0]?.referenceAudit?.findings.includes(
        "exact request payload prompt does not match scenario prompt after loopback-port canonicalization"
      )
    );
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
    referenceNotes?: string;
    referenceProvenance?: boolean;
    referenceExactRequestPayloadPrompt?: string;
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
      ...(options.referenceNotes ? { notes: options.referenceNotes } : {}),
      ...(options.referenceProvenance === false
        ? {}
        : { provenance: buildReferenceProvenance(options.referenceExactRequestPayloadPrompt ?? referencePrompt ?? "") }),
      ...(options.referenceProvenance === false
        ? {}
        : {
            rawResponse: { finalText: "Reference rendered the page and returned evidence." },
            rawTranscript: { messages: [{ role: "user", content: referencePrompt ?? "" }] },
            rawToolCalls: referenceUseful ? [{ name: "browser_open" }] : [],
            rawToolResults: referenceUseful ? [{ name: "browser_open", status: "ok" }] : [],
            rawBrowserEvidence: referenceUseful ? [{ url: "http://127.0.0.1:1/dashboard", rendered: true }] : [],
            artifactAdapterMappingSource: "scripts/real-llm-ab-report-build.ts",
            collectedAtMs: 1,
            exitStatus: "success",
            errorReason: "none",
          }),
      first: {
        summary: {
          toolCallCount: referenceUseful ? 1 : 0,
          toolResultCount: referenceUseful ? 1 : 0,
          pendingToolCount: 0,
          finalText: "Reference rendered the page and returned evidence.",
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
        provenance: buildReferenceProvenance(scenario.prompt),
        rawResponse: { finalText: "Reference completed the scenario." },
        rawTranscript: { messages: [{ role: "user", content: scenario.prompt }] },
        rawToolCalls: [{ name: "browser_open" }],
        rawToolResults: [{ name: "browser_open", status: "ok" }],
        rawBrowserEvidence: [{ url: "http://127.0.0.1:1/dashboard", rendered: true }],
        artifactAdapterMappingSource: "scripts/real-llm-ab-report-build.ts",
        collectedAtMs: 1,
        exitStatus: "success",
        errorReason: "none",
        first: {
          summary: {
            toolCallCount: 1,
            toolResultCount: 1,
            pendingToolCount: 0,
            finalText: "Reference completed the scenario.",
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

function buildReferenceProvenance(prompt: string): Record<string, unknown> {
  return {
    referenceApp: "reference-workbench-fixture",
    referenceBinary: "/tmp/reference-workbench-fixture",
    referenceRepoPath: "/tmp/reference-workbench",
    referenceVersion: "test",
    referenceCommit: "0000000",
    daemonUrl: "http://127.0.0.1:1",
    apiEndpoint: "/messages",
    modelCatalog: "models.test.json",
    provider: "test-provider",
    modelId: "test-model",
    exactRequestPayload: { content: prompt },
    rawResponse: { finalText: "Reference completed the scenario." },
    rawTranscript: { messages: [{ role: "user", content: prompt }] },
    rawToolCalls: [{ name: "browser_open" }],
    rawToolResults: [{ name: "browser_open", status: "ok" }],
    rawBrowserEvidence: [{ url: "http://127.0.0.1:1/dashboard", rendered: true }],
    artifactAdapterMappingSource: "scripts/real-llm-ab-report-build.ts",
    collectedAtMs: 1,
    exitStatus: "success",
    errorReason: "none",
  };
}
