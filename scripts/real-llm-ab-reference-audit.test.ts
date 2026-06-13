import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildRealLlmAbReferenceCollectionTaskManifest,
  buildRealLlmAbReferenceAuditHelpText,
  buildRealLlmAbReferenceAuditReport,
  parseRealLlmAbReferenceAuditArgs,
  runRealLlmAbReferenceAuditCli,
} from "./real-llm-ab-reference-audit";

const SCENARIOS = ["natural-browser-external-page-review", "natural-browser-complex-page-review"] as const;
const FIXTURE_URL = "http://127.0.0.1:8765/dashboard?case=reference-audit";
const FIXTURE_CONTENT_HASH = "sha256-reference-audit-fixture";

test("real LLM A/B reference audit parses args and help", () => {
  assert.deepEqual(
    parseRealLlmAbReferenceAuditArgs([
      "--natural-report",
      "/tmp/natural.json",
      "--reference-dir",
      "/tmp/reference",
      "--suite",
      "report-scenarios",
      "--out",
      "/tmp/audit.json",
    ]),
    {
      naturalReportPath: "/tmp/natural.json",
      referenceDir: "/tmp/reference",
      suite: "report-scenarios",
      outPath: "/tmp/audit.json",
      check: false,
    }
  );
  assert.deepEqual(
    parseRealLlmAbReferenceAuditArgs([
      "--natural-report",
      "/tmp/natural.json",
      "--reference-dir",
      "/tmp/reference",
      "--suite",
      "browser-focused",
      "--out",
      "/tmp/audit.json",
      "--tasks-out",
      "/tmp/tasks.json",
      "--check",
    ]),
    {
      naturalReportPath: "/tmp/natural.json",
      referenceDir: "/tmp/reference",
      suite: "browser-focused",
      outPath: "/tmp/audit.json",
      tasksOutPath: "/tmp/tasks.json",
      check: true,
    }
  );
  assert.deepEqual(parseRealLlmAbReferenceAuditArgs(["--help"]), { help: true });
  assert.match(buildRealLlmAbReferenceAuditHelpText(), /reference artifact audit/);
  assert.match(buildRealLlmAbReferenceAuditHelpText(), /full-natural/);
  assert.throws(
    () =>
      parseRealLlmAbReferenceAuditArgs([
        "--natural-report",
        "/tmp/natural.json",
        "--reference-dir",
        "/tmp/reference",
        "--suite",
        "invalid",
        "--out",
        "/tmp/audit.json",
      ]),
    /--suite must be one of/
  );
});

test("real LLM A/B reference audit passes only validated reference artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-audit-"));
  try {
    const fixture = writeFixture(dir);
    const report = buildRealLlmAbReferenceAuditReport({
      naturalReportPath: fixture.naturalReportPath,
      referenceDir: fixture.referenceDir,
      suite: "browser-focused",
      outPath: path.join(dir, "audit.json"),
      generatedAtMs: 1,
    });

    assert.equal(report.status, "passed");
    assert.equal(report.validatedComparisons, 2);
    assert.equal(report.unvalidatedComparisons, 0);
    assert.deepEqual(report.collectionTasks, []);
    assert.deepEqual(
      report.scenarios.map((scenario) => scenario.comparisonClassification),
      ["validated_comparison", "validated_comparison"]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference audit supports report-scenarios without fixed suite coverage", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-audit-"));
  try {
    const fixture = writeFixture(dir);
    const report = buildRealLlmAbReferenceAuditReport({
      naturalReportPath: fixture.naturalReportPath,
      referenceDir: fixture.referenceDir,
      suite: "report-scenarios",
      outPath: path.join(dir, "audit.json"),
      generatedAtMs: 1,
    });

    assert.equal(report.status, "passed");
    assert.equal(report.suite, "report-scenarios");
    assert.equal(report.validatedComparisons, SCENARIOS.length);
    assert.deepEqual(
      report.scenarios.map((scenario) => scenario.scenarioId),
      [...SCENARIOS]
    );
    assert.deepEqual(report.collectionTasks, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference audit downgrades unhealthy reference runtime artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-audit-"));
  try {
    const fixture = writeFixture(dir, {
      referenceNotes: "Browser worker failed. Error: page.evaluate: ReferenceError: __name is not defined",
    });
    const report = buildRealLlmAbReferenceAuditReport({
      naturalReportPath: fixture.naturalReportPath,
      referenceDir: fixture.referenceDir,
      suite: "browser-focused",
      outPath: path.join(dir, "audit.json"),
      generatedAtMs: 1,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.validatedComparisons, 0);
    assert.equal(report.unvalidatedComparisons, 2);
    assert.equal(report.collectionTasks.length, 2);
    assert.equal(report.collectionTasks[0]?.action, "recollect_reference_artifact");
    assert.equal(report.collectionTasks[0]?.prompt, promptForScenario("natural-browser-external-page-review"));
    assert.equal(path.isAbsolute(report.collectionTasks[0]?.expectedReferenceArtifactPath ?? ""), true);
    assert.ok(report.collectionTasks[0]?.blockingReasons.includes("reference runtime health failed"));
    const manifest = buildRealLlmAbReferenceCollectionTaskManifest(report);
    assert.equal(manifest.kind, "turnkeyai.real-llm-ab-reference-collection-tasks.manifest");
    assert.equal(manifest.taskCount, 2);
    assert.equal(manifest.tasks[1]?.prompt, promptForScenario("natural-browser-complex-page-review"));
    assert.deepEqual(
      manifest.tasks.map((task) => task.scenarioId),
      ["natural-browser-external-page-review", "natural-browser-complex-page-review"]
    );
    assert.deepEqual(
      report.scenarios.map((scenario) => scenario.comparisonClassification),
      ["reference_env_failed", "reference_env_failed"]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference audit emits recollection tasks when same-scenario fairness fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-audit-"));
  try {
    const fixture = writeFixture(dir, { referencePromptSuffix: "\nReference-only extra instruction." });
    const report = buildRealLlmAbReferenceAuditReport({
      naturalReportPath: fixture.naturalReportPath,
      referenceDir: fixture.referenceDir,
      suite: "browser-focused",
      outPath: path.join(dir, "audit.json"),
      generatedAtMs: 1,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.validatedComparisons, 0);
    assert.equal(report.unvalidatedComparisons, 2);
    assert.deepEqual(
      report.scenarios.map((scenario) => scenario.comparisonClassification),
      ["unfair_prompt_or_fixture", "unfair_prompt_or_fixture"]
    );
    assert.equal(report.collectionTasks.length, 2);
    assert.ok(report.collectionTasks[0]?.blockingReasons.includes("same-scenario fairness failed"));
    assert.ok(
      report.collectionTasks[0]?.blockingReasons.some((reason) =>
        reason.includes("same natural prompt was not proven")
      )
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference audit reports missing reference artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-audit-"));
  try {
    const fixture = writeFixture(dir, { omitLastReference: true });
    const report = buildRealLlmAbReferenceAuditReport({
      naturalReportPath: fixture.naturalReportPath,
      referenceDir: fixture.referenceDir,
      suite: "browser-focused",
      outPath: path.join(dir, "audit.json"),
      generatedAtMs: 1,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.missingReferenceArtifacts, 1);
    assert.equal(report.scenarios.length, 0);
    assert.equal(report.missingEvidence.length, 1);
    assert.deepEqual(report.collectionTasks, [
      {
        scenarioId: "natural-browser-complex-page-review",
        prompt: promptForScenario("natural-browser-complex-page-review"),
        expectedReferenceArtifactPath: path.join(fixture.referenceDir, "natural-browser-complex-page-review.json"),
        action: "collect_reference_artifact",
        requiredProvenanceFields: [
          "referenceApp",
          "referenceBinary",
          "referenceRepoPath",
          "referenceVersion",
          "referenceCommit",
          "daemonUrl",
          "apiEndpoint",
          "modelCatalog",
          "provider",
          "modelId",
          "exactRequestPayload",
          "rawResponse",
          "rawTranscript",
          "rawToolCalls",
          "rawToolResults",
          "rawBrowserEvidence",
          "artifactAdapterMappingSource",
          "collectedAtMs",
          "exitStatus",
          "errorReason",
        ],
        blockingReasons: ["missing reference artifact"],
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference audit CLI writes output and sets exit code on failed check", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-audit-"));
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const fixture = writeFixture(dir, { referenceProvenance: false });
    const outPath = path.join(dir, "audit.json");
    const tasksOutPath = path.join(dir, "tasks.json");
    await runRealLlmAbReferenceAuditCli([
      "--natural-report",
      fixture.naturalReportPath,
      "--reference-dir",
      fixture.referenceDir,
      "--suite",
      "browser-focused",
      "--out",
      outPath,
      "--tasks-out",
      tasksOutPath,
      "--check",
    ]);

    const report = JSON.parse(readFileSync(outPath, "utf8")) as { status?: string; unvalidatedComparisons?: number };
    const tasks = JSON.parse(readFileSync(tasksOutPath, "utf8")) as {
      kind?: string;
      taskCount?: number;
      tasks?: Array<{ action?: string; blockingReasons?: string[] }>;
    };
    assert.equal(report.status, "failed");
    assert.equal(report.unvalidatedComparisons, 2);
    assert.equal(tasks.kind, "turnkeyai.real-llm-ab-reference-collection-tasks.manifest");
    assert.equal(tasks.taskCount, 2);
    assert.equal(tasks.tasks?.[0]?.action, "recollect_reference_artifact");
    assert.equal(tasks.tasks?.[0]?.prompt, promptForScenario("natural-browser-external-page-review"));
    assert.ok(tasks.tasks?.[0]?.blockingReasons?.some((reason) => reason.startsWith("missing provenance:")));
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFixture(
  dir: string,
  options: {
    referenceNotes?: string;
    referenceProvenance?: boolean;
    omitLastReference?: boolean;
    naturalModel?: boolean;
    referencePromptSuffix?: string;
  } = {}
): { naturalReportPath: string; referenceDir: string } {
  const referenceDir = path.join(dir, "reference");
  const naturalReportPath = path.join(dir, "natural.json");
  mkdirSync(referenceDir, { recursive: true });
  writeFileSync(
    naturalReportPath,
    JSON.stringify({
      kind: "turnkeyai.natural-mission-e2e.report",
      status: "passed",
      ...(options.naturalModel === false
        ? {}
        : {
            provider: "test-provider",
            modelId: "test-model",
            modelEntryId: "test-model-entry",
          }),
      scenarios: SCENARIOS.map((scenario, index) => ({
        scenario,
        prompt: promptForScenario(scenario),
        missionId: `msn.reference.${index + 1}`,
        durationMs: 20_000,
        threadId: `THREAD-reference-${index + 1}`,
        status: "done",
        metrics: {
          tools: { requested: 1, results: 1, failed: 0, cancelled: 0, timeouts: 0, names: ["sessions_spawn"] },
          sessions: { spawned: 1, continued: 0 },
          browser: { profileFallbacks: 0, failureBuckets: [] },
          approvals: { requested: 0, decided: 0, applied: 0 },
          liveness: { active: 0, waiting: 0, stale: 0 },
          evidenceEvents: 1,
        },
        artifacts: [{ kind: "snapshot", id: `art.snapshot.${index + 1}`, url: FIXTURE_URL, fixtureContentHash: FIXTURE_CONTENT_HASH }],
        fixtureContentHashes: { [FIXTURE_URL]: FIXTURE_CONTENT_HASH },
        natural: {
          status: "passed",
          completed: true,
          stuckOrLoop: false,
          reasonableToolUse: true,
          browserUsed: true,
          subAgentCompleted: true,
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
      })),
    })
  );
  for (const [index, scenario] of SCENARIOS.entries()) {
    if (options.omitLastReference && index === SCENARIOS.length - 1) continue;
    const referencePrompt = `${promptForScenario(scenario)}${options.referencePromptSuffix ?? ""}`;
    writeFileSync(
      path.join(referenceDir, `${scenario}.json`),
      JSON.stringify({
        system: "reference",
        prompt: referencePrompt,
        threadId: `THREAD-reference-${scenario}`,
        durationMs: 12_000,
        timedOut: false,
        ...(options.referenceNotes ? { notes: options.referenceNotes } : {}),
        ...(options.referenceProvenance === false ? {} : buildReferenceProvenance(referencePrompt)),
        first: {
          summary: {
            toolCallCount: 1,
            toolResultCount: 1,
            pendingToolCount: 0,
            finalText: "Reference completed the browser task with rendered evidence.",
          },
        },
        score: {
          useful: true,
          weak: false,
        },
      })
    );
  }
  return { naturalReportPath, referenceDir };
}

function promptForScenario(scenario: string): string {
  return `Review ${scenario} at ${FIXTURE_URL} and summarize evidence.`;
}

function buildReferenceProvenance(prompt: string): Record<string, unknown> {
  return {
    provenance: {
      referenceApp: "accio-work-app-asar",
      referenceBinary: "/Applications/Accio.app/Contents/Resources/app.asar",
      referenceRepoPath: "/Users/chris/workspace/turnkeyai/artifacts/reference-runtimes/accio-work-0.4.5",
      referenceRuntimeRoot: "/Users/chris/workspace/turnkeyai/artifacts/reference-runtimes/accio-work-0.4.5",
      referenceVersion: "0.4.5",
      referenceCommit: "app.asar:test-sha",
      daemonUrl: "http://127.0.0.1:1",
      apiEndpoint: "/websocket/connect",
      modelCatalog: {
        data: [{ provider: "minimax", modelList: [{ modelName: "MiniMax-M2.7-highspeed", isDefault: true }] }],
      },
      provider: "minimax",
      modelId: "MiniMax-M2.7-highspeed",
      exactRequestPayload: { transport: "accio-work-websocket-sendQuery", prompt },
      rawResponse: { finalText: "Reference completed the browser task with rendered evidence." },
      rawTranscript: { messages: [{ role: "user", content: prompt }] },
      rawToolCalls: [{ name: "browser_open" }],
      rawToolResults: [{ name: "browser_open", status: "ok" }],
      rawBrowserEvidence: [{ url: FIXTURE_URL, rendered: true, fixtureContentHash: FIXTURE_CONTENT_HASH }],
      fixtureContentHashes: { [FIXTURE_URL]: FIXTURE_CONTENT_HASH },
      artifactAdapterMappingSource: "scripts/real-llm-ab-reference-audit.ts",
      collectedAtMs: 1,
      exitStatus: "success",
      errorReason: "none",
    },
    rawResponse: { finalText: "Reference completed the browser task with rendered evidence." },
    rawTranscript: { messages: [{ role: "user", content: prompt }] },
    rawToolCalls: [{ name: "browser_open" }],
    rawToolResults: [{ name: "browser_open", status: "ok" }],
    rawBrowserEvidence: [{ url: FIXTURE_URL, rendered: true, fixtureContentHash: FIXTURE_CONTENT_HASH }],
    fixtureContentHashes: { [FIXTURE_URL]: FIXTURE_CONTENT_HASH },
    artifactAdapterMappingSource: "scripts/real-llm-ab-reference-audit.ts",
    collectedAtMs: 1,
    exitStatus: "success",
    errorReason: "none",
  };
}
