import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_REAL_ACCEPTANCE_NATURAL_CORE_AB_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS,
} from "@turnkeyai/qc-runtime/real-llm-acceptance-defaults";

import {
  buildRealLlmAbCoreSpec,
  buildRealLlmAbSpec,
  buildRealLlmAbSpecBuildHelpText,
  parseRealLlmAbSpecBuildArgs,
  runRealLlmAbSpecBuildCli,
} from "./real-llm-ab-spec-build";

const CORE_NATURAL_SCENARIOS = DEFAULT_REAL_ACCEPTANCE_NATURAL_CORE_AB_SCENARIOS;

const BROWSER_FOCUSED_NATURAL_SCENARIOS = [
  "natural-browser-external-page-review",
  "natural-browser-complex-page-review",
] as const;

const BROWSER_RELIABILITY_NATURAL_SCENARIOS = [
  "natural-browser-followup-continuation",
  "natural-browser-restart-continuation",
  "natural-browser-cold-recreation-continuation",
  "natural-browser-profile-lock-recovery",
  "natural-browser-unavailable-closeout",
  "natural-browser-cdp-timeout-closeout",
  "natural-browser-detached-target-closeout",
  "natural-browser-attach-failed-closeout",
] as const;

const FULL_NATURAL_SCENARIOS = DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS;

test("real LLM A/B spec builder parses args and help", () => {
  assert.deepEqual(
    parseRealLlmAbSpecBuildArgs([
      "--natural-report",
      "/tmp/natural.json",
      "--natural-report",
      "/tmp/natural-extra.json",
      "--reference-dir",
      "/tmp/reference",
      "--suite",
      "report-scenarios",
      "--out",
      "/tmp/spec.json",
    ]),
    {
      naturalReportPath: "/tmp/natural.json",
      naturalReportPaths: ["/tmp/natural.json", "/tmp/natural-extra.json"],
      referenceDir: "/tmp/reference",
      requiredSuite: "report-scenarios",
      outPath: "/tmp/spec.json",
    }
  );
  assert.deepEqual(
    parseRealLlmAbSpecBuildArgs([
      "--natural-report",
      "/tmp/natural.json",
      "--reference-dir",
      "/tmp/reference",
      "--suite",
      "core",
      "--out",
      "/tmp/spec.json",
    ]),
    {
      naturalReportPath: "/tmp/natural.json",
      referenceDir: "/tmp/reference",
      requiredSuite: "core",
      outPath: "/tmp/spec.json",
    }
  );
  assert.deepEqual(parseRealLlmAbSpecBuildArgs(["--help"]), { help: true });
  assert.match(buildRealLlmAbSpecBuildHelpText(), /A\/B build-spec generator/);
  assert.match(buildRealLlmAbSpecBuildHelpText(), /browser-focused/);
  assert.match(buildRealLlmAbSpecBuildHelpText(), /browser-reliability/);
  assert.match(buildRealLlmAbSpecBuildHelpText(), /full-natural/);
  assert.match(buildRealLlmAbSpecBuildHelpText(), /--missing-manifest-out/);
  assert.deepEqual(
    parseRealLlmAbSpecBuildArgs([
      "--natural-report",
      "/tmp/natural.json",
      "--reference-dir",
      "/tmp/reference",
      "--suite",
      "full-natural",
      "--out",
      "/tmp/spec.json",
    ]),
    {
      naturalReportPath: "/tmp/natural.json",
      referenceDir: "/tmp/reference",
      requiredSuite: "full-natural",
      outPath: "/tmp/spec.json",
    }
  );
  assert.deepEqual(
    parseRealLlmAbSpecBuildArgs([
      "--natural-report",
      "/tmp/natural.json",
      "--reference-dir",
      "/tmp/reference",
      "--suite",
      "report-scenarios",
      "--out",
      "/tmp/spec.json",
    ]),
    {
      naturalReportPath: "/tmp/natural.json",
      referenceDir: "/tmp/reference",
      requiredSuite: "report-scenarios",
      outPath: "/tmp/spec.json",
    }
  );
  assert.deepEqual(
    parseRealLlmAbSpecBuildArgs([
      "--natural-report",
      "/tmp/natural.json",
      "--reference-dir",
      "/tmp/reference",
      "--suite",
      "browser-focused",
      "--out",
      "/tmp/spec.json",
    ]),
    {
      naturalReportPath: "/tmp/natural.json",
      referenceDir: "/tmp/reference",
      requiredSuite: "browser-focused",
      outPath: "/tmp/spec.json",
    }
  );
  assert.deepEqual(
    parseRealLlmAbSpecBuildArgs([
      "--natural-report",
      "/tmp/natural.json",
      "--reference-dir",
      "/tmp/reference",
      "--suite",
      "browser-reliability",
      "--out",
      "/tmp/spec.json",
      "--missing-manifest-out",
      "/tmp/missing.json",
    ]),
    {
      naturalReportPath: "/tmp/natural.json",
      referenceDir: "/tmp/reference",
      requiredSuite: "browser-reliability",
      outPath: "/tmp/spec.json",
      missingManifestOutPath: "/tmp/missing.json",
    }
  );
  assert.throws(() => parseRealLlmAbSpecBuildArgs(["--natural-report", "/tmp/natural.json"]), /missing required --reference-dir/);
  assert.throws(
    () =>
      parseRealLlmAbSpecBuildArgs([
        "--natural-report",
        "/tmp/natural.json",
        "--reference-dir",
        "/tmp/reference",
        "--suite",
        "focused",
        "--out",
        "/tmp/spec.json",
      ]),
    /--suite must be one of: core, browser-focused, browser-reliability, full-natural, report-scenarios/
  );
});

test("real LLM A/B spec builder emits the full core suite from a natural report", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-spec-"));
  try {
    const { naturalReportPath, referenceDir, outPath } = writeCoreFixture(dir);
    const spec = buildRealLlmAbCoreSpec({
      naturalReportPath,
      referenceDir,
      outPath,
      generatedAtMs: 1,
    });

    assert.equal(spec.kind, "turnkeyai.real-llm-ab-acceptance.build-spec");
    assert.equal(spec.generatedAtMs, 1);
    assert.equal(spec.scenarios.length, CORE_NATURAL_SCENARIOS.length);
    assert.deepEqual(
      spec.scenarios.map((scenario) => scenario.scenarioId),
      [...CORE_NATURAL_SCENARIOS]
    );
    assert.ok(spec.turnkeyaiNaturalReportPath.endsWith("natural.json"));
    assert.ok(spec.scenarios.every((scenario) => scenario.referenceArtifactPath.endsWith(`${scenario.scenarioId}.json`)));
    assert.ok(spec.scenarios.every((scenario) => scenario.promptPolicy?.naturalPrompt === true));
    assert.ok(spec.scenarios.every((scenario) => /Reference model provenance/.test(scenario.modelComparison?.differenceNote ?? "")));
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-browser-dynamic-page")?.requiresBrowser, true);
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-long-delegation")?.requiresBrowser, true);
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-asiawalk-multi-agent")?.requiresBrowser, true);
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-followup-continuation")?.requiresContinuation, true);
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-approval-dry-run-action")?.requiresApproval, true);
    assert.equal(
      spec.scenarios.find((scenario) => scenario.scenarioId === "natural-timeout-followup-continuation")
        ?.requiresTimeoutCloseout,
      true
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B spec builder emits the browser-focused suite from a natural report", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-spec-"));
  try {
    const { naturalReportPath, referenceDir, outPath } = writeCoreFixture(dir, {
      scenarios: BROWSER_FOCUSED_NATURAL_SCENARIOS,
    });
    const spec = buildRealLlmAbSpec({
      naturalReportPath,
      referenceDir,
      outPath,
      suite: "browser-focused",
      generatedAtMs: 1,
    });

    assert.equal(spec.kind, "turnkeyai.real-llm-ab-acceptance.build-spec");
    assert.equal(spec.generatedAtMs, 1);
    assert.deepEqual(
      spec.scenarios.map((scenario) => scenario.scenarioId),
      [...BROWSER_FOCUSED_NATURAL_SCENARIOS]
    );
    assert.ok(spec.scenarios.every((scenario) => scenario.requiresBrowser === true));
    assert.ok(spec.scenarios.every((scenario) => scenario.promptPolicy?.naturalPrompt === true));
    assert.ok(spec.scenarios.every((scenario) => scenario.referenceArtifactPath.endsWith(`${scenario.scenarioId}.json`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B spec builder emits only scenarios present in report-scenarios mode", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-spec-"));
  try {
    const scenarios = [
      "natural-comparison-research",
      "natural-asiawalk-multi-agent",
      "natural-timeout-followup-continuation",
    ] as const;
    const { naturalReportPath, referenceDir, outPath } = writeCoreFixture(dir, { scenarios });
    const spec = buildRealLlmAbSpec({
      naturalReportPath,
      referenceDir,
      outPath,
      suite: "report-scenarios",
      generatedAtMs: 1,
    });

    assert.equal(spec.generatedAtMs, 1);
    assert.deepEqual(
      spec.scenarios.map((scenario) => scenario.scenarioId),
      [...scenarios]
    );
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-asiawalk-multi-agent")?.requiresBrowser, true);
    assert.equal(
      spec.scenarios.find((scenario) => scenario.scenarioId === "natural-timeout-followup-continuation")
        ?.requiresTimeoutCloseout,
      true
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B spec builder can assemble a suite from multiple natural reports", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-spec-"));
  try {
    const firstNaturalReportPath = path.join(dir, "turnkeyai", "natural-a.json");
    const secondNaturalReportPath = path.join(dir, "turnkeyai", "natural-b.json");
    const referenceDir = path.join(dir, "reference");
    const outPath = path.join(dir, "out", "ab-build-spec.json");
    const firstScenario = CORE_NATURAL_SCENARIOS[0]!;
    const secondScenarios = CORE_NATURAL_SCENARIOS.slice(1);
    mkdirSync(referenceDir, { recursive: true });
    writeNaturalReport(firstNaturalReportPath, [firstScenario]);
    writeNaturalReport(secondNaturalReportPath, secondScenarios);
    writeReferenceArtifacts(referenceDir, CORE_NATURAL_SCENARIOS);

    const spec = buildRealLlmAbCoreSpec({
      naturalReportPath: firstNaturalReportPath,
      naturalReportPaths: [firstNaturalReportPath, secondNaturalReportPath],
      referenceDir,
      outPath,
      generatedAtMs: 1,
    });

    assert.deepEqual(
      spec.scenarios.map((scenario) => scenario.scenarioId),
      [...CORE_NATURAL_SCENARIOS]
    );
    assert.equal(spec.scenarios[0]?.turnkeyaiNaturalReportPath, undefined);
    assert.match(spec.scenarios[1]?.turnkeyaiNaturalReportPath ?? "", /natural-b\.json$/);
    assert.ok(spec.turnkeyaiNaturalReportPath.endsWith("natural-a.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B spec builder emits the browser-reliability suite from a natural report", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-spec-"));
  try {
    const { naturalReportPath, referenceDir, outPath } = writeCoreFixture(dir, {
      scenarios: BROWSER_RELIABILITY_NATURAL_SCENARIOS,
    });
    const spec = buildRealLlmAbSpec({
      naturalReportPath,
      referenceDir,
      outPath,
      suite: "browser-reliability",
      generatedAtMs: 1,
    });

    assert.equal(spec.kind, "turnkeyai.real-llm-ab-acceptance.build-spec");
    assert.equal(spec.generatedAtMs, 1);
    assert.deepEqual(
      spec.scenarios.map((scenario) => scenario.scenarioId),
      [...BROWSER_RELIABILITY_NATURAL_SCENARIOS]
    );
    assert.ok(spec.scenarios.every((scenario) => scenario.requiresBrowser === true));
    assert.equal(
      spec.scenarios.find((scenario) => scenario.scenarioId === "natural-browser-cdp-timeout-closeout")
        ?.requiresTimeoutCloseout,
      true
    );
    assert.ok(spec.scenarios.every((scenario) => scenario.promptPolicy?.naturalPrompt === true));
    assert.ok(spec.scenarios.every((scenario) => scenario.referenceArtifactPath.endsWith(`${scenario.scenarioId}.json`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B spec builder emits the full natural suite from a natural report", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-spec-"));
  try {
    const { naturalReportPath, referenceDir, outPath } = writeCoreFixture(dir, {
      scenarios: FULL_NATURAL_SCENARIOS,
    });
    const spec = buildRealLlmAbSpec({
      naturalReportPath,
      referenceDir,
      outPath,
      suite: "full-natural",
      generatedAtMs: 1,
    });

    assert.equal(spec.kind, "turnkeyai.real-llm-ab-acceptance.build-spec");
    assert.equal(spec.generatedAtMs, 1);
    assert.deepEqual(
      spec.scenarios.map((scenario) => scenario.scenarioId),
      [...FULL_NATURAL_SCENARIOS]
    );
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-memory-recall")?.requiresBrowser, undefined);
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-memory-invalidation")?.requiresBrowser, undefined);
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-tool-result-pruning")?.requiresBrowser, undefined);
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-approval-denied-safe-closeout")?.requiresApproval, true);
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-cancel-followup-continuation")?.requiresContinuation, true);
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-timeout-partial-closeout")?.requiresTimeoutCloseout, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B spec builder CLI writes a core build spec", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-spec-"));
  try {
    const { naturalReportPath, referenceDir, outPath } = writeCoreFixture(dir);
    const missingManifestPath = path.join(dir, "missing.json");
    await runRealLlmAbSpecBuildCli([
      "--natural-report",
      naturalReportPath,
      "--reference-dir",
      referenceDir,
      "--suite",
      "core",
      "--out",
      outPath,
      "--missing-manifest-out",
      missingManifestPath,
    ]);
    const spec = JSON.parse(readFileSync(outPath, "utf8")) as { scenarios: unknown[] };
    const missingManifest = JSON.parse(readFileSync(missingManifestPath, "utf8")) as { missingEvidence?: unknown[] };
    assert.equal(spec.scenarios.length, CORE_NATURAL_SCENARIOS.length);
    assert.deepEqual(missingManifest.missingEvidence, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B spec builder CLI writes a browser-focused build spec", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-spec-"));
  try {
    const { naturalReportPath, referenceDir, outPath } = writeCoreFixture(dir, {
      scenarios: BROWSER_FOCUSED_NATURAL_SCENARIOS,
    });
    await runRealLlmAbSpecBuildCli([
      "--natural-report",
      naturalReportPath,
      "--reference-dir",
      referenceDir,
      "--suite",
      "browser-focused",
      "--out",
      outPath,
    ]);
    const spec = JSON.parse(readFileSync(outPath, "utf8")) as { scenarios: unknown[] };
    assert.equal(spec.scenarios.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B spec builder CLI writes a browser-reliability build spec", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-spec-"));
  try {
    const { naturalReportPath, referenceDir, outPath } = writeCoreFixture(dir, {
      scenarios: BROWSER_RELIABILITY_NATURAL_SCENARIOS,
    });
    await runRealLlmAbSpecBuildCli([
      "--natural-report",
      naturalReportPath,
      "--reference-dir",
      referenceDir,
      "--suite",
      "browser-reliability",
      "--out",
      outPath,
    ]);
    const spec = JSON.parse(readFileSync(outPath, "utf8")) as { scenarios: unknown[] };
    assert.equal(spec.scenarios.length, BROWSER_RELIABILITY_NATURAL_SCENARIOS.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B spec builder CLI writes a full natural build spec", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-spec-"));
  try {
    const { naturalReportPath, referenceDir, outPath } = writeCoreFixture(dir, {
      scenarios: FULL_NATURAL_SCENARIOS,
    });
    await runRealLlmAbSpecBuildCli([
      "--natural-report",
      naturalReportPath,
      "--reference-dir",
      referenceDir,
      "--suite",
      "full-natural",
      "--out",
      outPath,
    ]);
    const spec = JSON.parse(readFileSync(outPath, "utf8")) as { scenarios: unknown[] };
    assert.equal(spec.scenarios.length, FULL_NATURAL_SCENARIOS.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B spec builder rejects incomplete natural or reference evidence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-spec-"));
  try {
    const { naturalReportPath, referenceDir, outPath } = writeCoreFixture(dir, {
      scenarios: CORE_NATURAL_SCENARIOS.filter((scenario) => scenario !== "natural-memory-recall"),
    });
    assert.throws(
      () => buildRealLlmAbCoreSpec({ naturalReportPath, referenceDir, outPath }),
      /missing core A\/B scenario: memory-recall/
    );

    const complete = writeCoreFixture(dir);
    rmSync(path.join(complete.referenceDir, "natural-memory-recall.json"), { force: true });
    assert.throws(
      () => buildRealLlmAbCoreSpec({ naturalReportPath: complete.naturalReportPath, referenceDir: complete.referenceDir, outPath }),
      /missing reference artifact for natural-memory-recall/
    );

    const focused = writeCoreFixture(dir, { scenarios: BROWSER_FOCUSED_NATURAL_SCENARIOS });
    rmSync(path.join(focused.referenceDir, "natural-browser-complex-page-review.json"), { force: true });
    assert.throws(
      () =>
        buildRealLlmAbSpec({
          naturalReportPath: focused.naturalReportPath,
          referenceDir: focused.referenceDir,
          outPath,
          suite: "browser-focused",
        }),
      /missing reference artifact for natural-browser-complex-page-review/
    );

    const reliability = writeCoreFixture(dir, { scenarios: BROWSER_RELIABILITY_NATURAL_SCENARIOS });
    rmSync(path.join(reliability.referenceDir, "natural-browser-cdp-timeout-closeout.json"), { force: true });
    assert.throws(
      () =>
        buildRealLlmAbSpec({
          naturalReportPath: reliability.naturalReportPath,
          referenceDir: reliability.referenceDir,
          outPath,
          suite: "browser-reliability",
        }),
      /missing reference artifact for natural-browser-cdp-timeout-closeout/
    );

    const fullNatural = writeCoreFixture(dir, {
      scenarios: FULL_NATURAL_SCENARIOS.filter((scenario) => scenario !== "natural-cancel-active-tool"),
    });
    assert.throws(
      () =>
        buildRealLlmAbSpec({
          naturalReportPath: fullNatural.naturalReportPath,
          referenceDir: fullNatural.referenceDir,
          outPath,
          suite: "full-natural",
        }),
      /natural report is missing full-natural A\/B scenario: cancel-active-tool/
    );

    const partialReliability = writeCoreFixture(dir, {
      scenarios: BROWSER_RELIABILITY_NATURAL_SCENARIOS.filter(
        (scenario) => scenario !== "natural-browser-detached-target-closeout"
      ),
    });
    rmSync(path.join(partialReliability.referenceDir, "natural-browser-cdp-timeout-closeout.json"), { force: true });
    assert.throws(
      () =>
        buildRealLlmAbSpec({
          naturalReportPath: partialReliability.naturalReportPath,
          referenceDir: partialReliability.referenceDir,
          outPath,
          suite: "browser-reliability",
        }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /A\/B suite evidence is incomplete/);
        assert.match(error.message, /missing reference artifact for natural-browser-cdp-timeout-closeout/);
        assert.match(error.message, /natural report is missing browser-reliability A\/B scenario: browser-detached-target-closeout/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B spec builder CLI writes a missing evidence manifest for reference collection", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-spec-"));
  try {
    const { naturalReportPath, referenceDir, outPath } = writeCoreFixture(dir, {
      scenarios: BROWSER_RELIABILITY_NATURAL_SCENARIOS.filter(
        (scenario) => scenario !== "natural-browser-detached-target-closeout"
      ),
    });
    rmSync(path.join(referenceDir, "natural-browser-cdp-timeout-closeout.json"), { force: true });
    const manifestPath = path.join(dir, "missing-reference", "manifest.json");

    await assert.rejects(
      () =>
        runRealLlmAbSpecBuildCli([
          "--natural-report",
          naturalReportPath,
          "--reference-dir",
          referenceDir,
          "--suite",
          "browser-reliability",
          "--out",
          outPath,
          "--missing-manifest-out",
          manifestPath,
        ]),
      /A\/B suite evidence is incomplete/
    );

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      kind?: string;
      generatedAtMs?: number;
      suite?: string;
      naturalReportPath?: string;
      referenceDir?: string;
      missingEvidence?: Array<{
        reason?: string;
        requirementKey?: string;
        scenarioId?: string;
        prompt?: string;
        expectedReferenceArtifactPath?: string;
      }>;
    };
    assert.equal(manifest.kind, "turnkeyai.real-llm-ab-reference-collection.manifest");
    assert.equal(typeof manifest.generatedAtMs, "number");
    assert.equal(manifest.suite, "browser-reliability");
    assert.match(manifest.naturalReportPath ?? "", /natural\.json$/);
    assert.match(manifest.referenceDir ?? "", /reference$/);
    assert.equal(manifest.missingEvidence?.length, 2);
    assert.deepEqual(
      manifest.missingEvidence?.map((item) => item.reason),
      ["missing_reference_artifact", "missing_natural_scenario"]
    );
    const missingReference = manifest.missingEvidence?.[0];
    assert.equal(missingReference?.scenarioId, "natural-browser-cdp-timeout-closeout");
    assert.equal(
      missingReference?.prompt,
      "Natural prompt for natural-browser-cdp-timeout-closeout"
    );
    assert.match(
      missingReference?.expectedReferenceArtifactPath ?? "",
      /natural-browser-cdp-timeout-closeout\.json$/
    );
    assert.equal(manifest.missingEvidence?.[1]?.requirementKey, "browser-detached-target-closeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeCoreFixture(
  dir: string,
  options: { scenarios?: readonly string[] } = {}
): { naturalReportPath: string; referenceDir: string; outPath: string } {
  const scenarios = options.scenarios ?? CORE_NATURAL_SCENARIOS;
  const naturalReportPath = path.join(dir, "turnkeyai", "natural.json");
  const referenceDir = path.join(dir, "reference");
  const outPath = path.join(dir, "ab-build-spec.json");
  mkdirSync(referenceDir, { recursive: true });
  writeNaturalReport(naturalReportPath, scenarios);
  writeReferenceArtifacts(referenceDir, scenarios);
  return { naturalReportPath, referenceDir, outPath };
}

function writeNaturalReport(naturalReportPath: string, scenarios: readonly string[]): void {
  mkdirSync(path.dirname(naturalReportPath), { recursive: true });
  writeFileSync(
    naturalReportPath,
    JSON.stringify({
      kind: "turnkeyai.natural-mission-e2e.report",
      scenarios: scenarios.map((scenario) => ({
        scenario,
        prompt: `Natural prompt for ${scenario}`,
      })),
    })
  );
}

function writeReferenceArtifacts(referenceDir: string, scenarios: readonly string[]): void {
  mkdirSync(referenceDir, { recursive: true });
  for (const scenario of scenarios) {
    writeFileSync(
      path.join(referenceDir, `${scenario}.json`),
      JSON.stringify({
        system: "reference",
        prompt: `Natural prompt for ${scenario}`,
        threadId: `thread-${scenario}`,
        durationMs: 1000,
        first: { summary: { toolCallCount: 1, toolResultCount: 1 } },
        score: { useful: true, weak: false },
      })
    );
  }
}
