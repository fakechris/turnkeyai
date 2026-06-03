import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildRealLlmAbCoreSpec,
  buildRealLlmAbSpec,
  buildRealLlmAbSpecBuildHelpText,
  parseRealLlmAbSpecBuildArgs,
  runRealLlmAbSpecBuildCli,
} from "./real-llm-ab-spec-build";

const CORE_NATURAL_SCENARIOS = [
  "natural-comparison-research",
  "natural-browser-dynamic-page",
  "natural-followup-continuation",
  "natural-approval-dry-run-action",
  "natural-long-delegation",
  "natural-timeout-followup-continuation",
  "natural-memory-recall",
] as const;

const BROWSER_FOCUSED_NATURAL_SCENARIOS = [
  "natural-browser-external-page-review",
  "natural-browser-complex-page-review",
] as const;

test("real LLM A/B spec builder parses args and help", () => {
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
    /--suite must be one of: core, browser-focused/
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
    assert.equal(spec.scenarios.length, 7);
    assert.deepEqual(
      spec.scenarios.map((scenario) => scenario.scenarioId),
      [...CORE_NATURAL_SCENARIOS]
    );
    assert.ok(spec.turnkeyaiNaturalReportPath.endsWith("natural.json"));
    assert.ok(spec.scenarios.every((scenario) => scenario.referenceArtifactPath.endsWith(`${scenario.scenarioId}.json`)));
    assert.ok(spec.scenarios.every((scenario) => scenario.promptPolicy?.naturalPrompt === true));
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-browser-dynamic-page")?.requiresBrowser, true);
    assert.equal(spec.scenarios.find((scenario) => scenario.scenarioId === "natural-long-delegation")?.requiresBrowser, true);
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

test("real LLM A/B spec builder CLI writes a core build spec", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-spec-"));
  try {
    const { naturalReportPath, referenceDir, outPath } = writeCoreFixture(dir);
    await runRealLlmAbSpecBuildCli([
      "--natural-report",
      naturalReportPath,
      "--reference-dir",
      referenceDir,
      "--suite",
      "core",
      "--out",
      outPath,
    ]);
    const spec = JSON.parse(readFileSync(outPath, "utf8")) as { scenarios: unknown[] };
    assert.equal(spec.scenarios.length, 7);
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
  mkdirSync(path.dirname(naturalReportPath), { recursive: true });
  mkdirSync(referenceDir, { recursive: true });
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
  return { naturalReportPath, referenceDir, outPath };
}
