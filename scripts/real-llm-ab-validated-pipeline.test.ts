import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildRealLlmAbValidatedPipelineHelpText,
  parseRealLlmAbValidatedPipelineArgs,
  runRealLlmAbValidatedPipeline,
  runRealLlmAbValidatedPipelineCli,
} from "./real-llm-ab-validated-pipeline";

const SCENARIOS = ["natural-browser-external-page-review", "natural-browser-complex-page-review"] as const;
const FIXTURE_URL = "http://127.0.0.1:8765/dashboard?case=validated-pipeline";
const FIXTURE_CONTENT_HASH = "sha256-validated-pipeline-fixture";
const REFERENCE_APP = "reference-desktop-app-asar";
const REFERENCE_BINARY = "/Applications/ReferenceRuntime.app/Contents/Resources/app.asar";
const REFERENCE_RUNTIME_ROOT = "/Users/chris/workspace/turnkeyai/artifacts/reference-runtimes/reference-desktop-0.4.5";
const REFERENCE_VERSION = "0.4.5";
const REFERENCE_COMMIT = "app.asar:test-sha";
const MODEL_PROVIDER = "minimax";
const MODEL_ID = "MiniMax-M2.7-highspeed";

test("real LLM A/B validated pipeline parses args and help", () => {
  assert.deepEqual(
    parseRealLlmAbValidatedPipelineArgs([
      "--natural-report",
      "/tmp/natural.json",
      "--reference-dir",
      "/tmp/reference",
      "--suite",
      "browser-focused",
      "--work-dir",
      "/tmp/work",
      "--reference-base-url",
      "http://127.0.0.1:9000",
      "--reference-token",
      "secret-reference-token",
      "--reference-timeout-ms",
      "120000",
      "--reference-poll-ms",
      "1000",
      "--check",
    ]),
    {
      naturalReportPath: "/tmp/natural.json",
      referenceDir: "/tmp/reference",
      suite: "browser-focused",
      workDir: "/tmp/work",
      referenceBaseUrl: "http://127.0.0.1:9000",
      referenceToken: "secret-reference-token",
      referenceVariant: "operator",
      referenceTimeoutMs: 120000,
      referencePollMs: 1000,
      referenceApp: "reference-workbench",
      check: true,
    }
  );
  assert.deepEqual(parseRealLlmAbValidatedPipelineArgs(["--help"]), { help: true });
  assert.match(buildRealLlmAbValidatedPipelineHelpText(), /validated evidence pipeline/);
  assert.match(buildRealLlmAbValidatedPipelineHelpText(), /full-natural/);
  assert.match(buildRealLlmAbValidatedPipelineHelpText(), /--reference-ws/);
  assert.throws(
    () =>
      parseRealLlmAbValidatedPipelineArgs([
        "--natural-report",
        "/tmp/natural.json",
        "--reference-dir",
        "/tmp/reference",
        "--suite",
        "invalid",
        "--work-dir",
        "/tmp/work",
      ]),
    /--suite must be one of/
  );
});

test("real LLM A/B validated pipeline parses reference desktop runtime app.asar reference mode", () => {
  assert.deepEqual(
    parseRealLlmAbValidatedPipelineArgs([
      "--natural-report",
      "/tmp/natural.json",
      "--reference-dir",
      "/tmp/reference",
      "--suite",
      "report-scenarios",
      "--work-dir",
      "/tmp/work",
    ]),
    {
      naturalReportPath: "/tmp/natural.json",
      referenceDir: "/tmp/reference",
      suite: "report-scenarios",
      workDir: "/tmp/work",
      referenceVariant: "operator",
      referenceTimeoutMs: 180000,
      referencePollMs: 2000,
      referenceApp: "reference-workbench",
      check: false,
    }
  );
  const referenceRuntimeDefaults = parseRealLlmAbValidatedPipelineArgs([
    "--natural-report",
    "/tmp/natural.json",
    "--reference-dir",
    "/tmp/reference",
    "--suite",
    "core",
    "--work-dir",
    "/tmp/work",
    "--reference-base-url",
    "http://127.0.0.1:4097",
    "--reference-ws",
    "--reference-workspace-path",
    "/Users/chris/workspace/turnkeyai",
  ]);
  assert.deepEqual(
    {
      ...referenceRuntimeDefaults,
      ...(typeof referenceRuntimeDefaults === "object" && !("help" in referenceRuntimeDefaults) ? { referenceCommit: undefined } : {}),
    },
    {
      naturalReportPath: "/tmp/natural.json",
      referenceDir: "/tmp/reference",
      suite: "core",
      workDir: "/tmp/work",
      referenceBaseUrl: "http://127.0.0.1:4097",
      referenceVariant: "operator",
      referenceRuntimeWs: true,
      referenceRuntimeWorkspacePath: "/Users/chris/workspace/turnkeyai",
      referenceTimeoutMs: 180000,
      referencePollMs: 2000,
      referenceApp: "reference-desktop-app-asar",
      referenceBinary: "/Applications/ReferenceRuntime.app/Contents/Resources/app.asar",
      referenceRuntimeRoot: path.resolve("artifacts/reference-runtimes/reference-desktop-0.4.5"),
      referenceVersion: "0.4.5",
      referenceCommit: undefined,
      check: false,
    }
  );
  if (existsSync("/Applications/ReferenceRuntime.app/Contents/Resources/app.asar")) {
    assert.match(
      "help" in referenceRuntimeDefaults ? "" : (referenceRuntimeDefaults.referenceCommit ?? ""),
      /^app\.asar:[a-f0-9]{64}$/
    );
  }
  assert.deepEqual(
    parseRealLlmAbValidatedPipelineArgs([
      "--natural-report",
      "/tmp/natural.json",
      "--reference-dir",
      "/tmp/reference",
      "--suite",
      "core",
      "--work-dir",
      "/tmp/work",
      "--reference-base-url",
      "http://127.0.0.1:4097",
      "--reference-ws",
      "--reference-agent-id",
      "DID-F456DA-2B0D4C",
      "--reference-workspace-path",
      "/Users/chris/workspace/turnkeyai",
      "--reference-app",
      "reference-desktop-app-asar",
      "--reference-binary",
      "/Applications/ReferenceRuntime.app/Contents/Resources/app.asar",
      "--reference-runtime-root",
      "/Users/chris/workspace/turnkeyai/artifacts/reference-runtimes/reference-desktop-0.4.5",
      "--reference-version",
      "0.4.5",
      "--reference-commit",
      "app.asar:eba7d3bad65cd35ac4c5ec37dafdfa70dc2e9a2d9a92cc163b32ace10828d1a9",
    ]),
    {
      naturalReportPath: "/tmp/natural.json",
      referenceDir: "/tmp/reference",
      suite: "core",
      workDir: "/tmp/work",
      referenceBaseUrl: "http://127.0.0.1:4097",
      referenceVariant: "operator",
      referenceRuntimeWs: true,
      referenceRuntimeAgentId: "DID-F456DA-2B0D4C",
      referenceRuntimeWorkspacePath: "/Users/chris/workspace/turnkeyai",
      referenceTimeoutMs: 180000,
      referencePollMs: 2000,
      referenceApp: "reference-desktop-app-asar",
      referenceBinary: "/Applications/ReferenceRuntime.app/Contents/Resources/app.asar",
      referenceRuntimeRoot: "/Users/chris/workspace/turnkeyai/artifacts/reference-runtimes/reference-desktop-0.4.5",
      referenceVersion: "0.4.5",
      referenceCommit: "app.asar:eba7d3bad65cd35ac4c5ec37dafdfa70dc2e9a2d9a92cc163b32ace10828d1a9",
      check: false,
    }
  );
});

test("real LLM A/B validated pipeline runs token-authenticated collection without accepting generic provenance", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-validated-"));
  const server = createMockReferenceDaemon({ mode: "healthy", authToken: "secret-reference-token" });
  try {
    const baseUrl = await listen(server);
    const fixture = writeFixture(dir, { omitLastReference: true });
    const report = await runRealLlmAbValidatedPipeline({
      naturalReportPath: fixture.naturalReportPath,
      referenceDir: fixture.referenceDir,
      workDir: fixture.workDir,
      suite: "browser-focused",
      referenceBaseUrl: baseUrl,
      referenceToken: "secret-reference-token",
      referenceVariant: "operator",
      referenceTimeoutMs: 2_000,
      referencePollMs: 10,
      referenceApp: REFERENCE_APP,
      referenceBinary: REFERENCE_BINARY,
      referenceRepoPath: REFERENCE_RUNTIME_ROOT,
      referenceRuntimeRoot: REFERENCE_RUNTIME_ROOT,
      referenceVersion: "test",
      referenceCommit: REFERENCE_COMMIT,
      modelDifferenceNote: "authenticated reference daemon fixture uses a different configured model id",
      check: false,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.collectionRequired, true);
    assert.equal(report.collectionAttempted, true);
    assert.equal(report.gates.referencePreflight, "passed");
    assert.equal(report.gates.collection, "failed");
    assert.equal(report.gates.finalAudit, "failed");
    assert.equal(report.gates.referenceHealth, "not_run");
    assert.ok(report.failures.includes("reference collection did not complete successfully"));
    assert.ok(report.failures.includes("reference audit did not validate the comparison evidence"));
    const collection = JSON.parse(readFileSync(report.artifacts.collectionReportPath!, "utf8")) as {
      collected?: unknown;
      failed?: unknown;
      taskCount?: unknown;
    };
    assert.equal(collection.taskCount, 1);
    assert.equal(collection.collected, 0);
    assert.equal(collection.failed, 1);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B validated pipeline passes only when every gate passes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-validated-"));
  try {
    const fixture = writeFixture(dir);
    const report = await runRealLlmAbValidatedPipeline({
      naturalReportPath: fixture.naturalReportPath,
      referenceDir: fixture.referenceDir,
      workDir: fixture.workDir,
      suite: "browser-focused",
      referenceVariant: "operator",
      referenceTimeoutMs: 180_000,
      referencePollMs: 2_000,
      referenceApp: "reference-workbench",
      check: false,
    });

    assert.equal(report.status, "passed");
    assert.equal(report.collectionRequired, false);
    assert.deepEqual(report.gates, {
      initialAudit: "passed",
      referencePreflight: "not_run",
      collection: "not_required",
      finalAudit: "passed",
      referenceHealth: "passed",
      fairness: "passed",
      abAcceptance: "passed",
    });
    assert.deepEqual(report.failures, []);
    for (const artifactPath of [
      report.artifacts.initialAuditPath,
      report.artifacts.collectionTasksPath,
      report.artifacts.finalAuditPath,
      report.artifacts.referenceHealthTasksPath,
      report.artifacts.referenceHealthReportPath,
      report.artifacts.specPath,
      report.artifacts.fairnessReportPath,
      report.artifacts.abReportPath,
      report.artifacts.abMarkdownPath,
    ]) {
      assert.equal(typeof artifactPath, "string");
      assert.equal(existsSync(artifactPath!), true);
    }
    const pipelineJson = JSON.parse(readFileSync(path.join(fixture.workDir, "pipeline-report.json"), "utf8")) as {
      status?: unknown;
    };
    assert.equal(pipelineJson.status, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B validated pipeline validates report-scenarios without fixed suite coverage", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-validated-"));
  try {
    const fixture = writeFixture(dir);
    const report = await runRealLlmAbValidatedPipeline({
      naturalReportPath: fixture.naturalReportPath,
      referenceDir: fixture.referenceDir,
      workDir: fixture.workDir,
      suite: "report-scenarios",
      referenceVariant: "operator",
      referenceTimeoutMs: 180_000,
      referencePollMs: 2_000,
      referenceApp: "reference-workbench",
      check: false,
    });

    assert.equal(report.status, "passed");
    assert.equal(report.suite, "report-scenarios");
    assert.equal(report.gates.abAcceptance, "passed");
    const spec = JSON.parse(readFileSync(report.artifacts.specPath!, "utf8")) as {
      scenarios?: Array<{ scenarioId?: unknown }>;
    };
    assert.deepEqual(
      spec.scenarios?.map((scenario) => scenario.scenarioId),
      [...SCENARIOS]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B validated pipeline records explicit model differences in the generated spec", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-validated-"));
  try {
    const fixture = writeFixture(dir);
    const report = await runRealLlmAbValidatedPipeline({
      naturalReportPath: fixture.naturalReportPath,
      referenceDir: fixture.referenceDir,
      workDir: fixture.workDir,
      suite: "browser-focused",
      referenceVariant: "operator",
      referenceTimeoutMs: 180_000,
      referencePollMs: 2_000,
      referenceApp: REFERENCE_APP,
      modelDifferenceNote: "same provider and model; explicit note retained for methodology traceability",
      check: false,
    });

    assert.equal(report.status, "passed");
    const spec = JSON.parse(readFileSync(report.artifacts.specPath!, "utf8")) as {
      scenarios?: Array<{ modelComparison?: { differenceNote?: unknown } }>;
    };
    assert.equal(
      spec.scenarios?.[0]?.modelComparison?.differenceNote,
      "same provider and model; explicit note retained for methodology traceability"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("real LLM A/B validated pipeline stops capability comparison when collection is required", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-validated-"));
  try {
    const fixture = writeFixture(dir, { omitLastReference: true });
    const report = await runRealLlmAbValidatedPipeline({
      naturalReportPath: fixture.naturalReportPath,
      referenceDir: fixture.referenceDir,
      workDir: fixture.workDir,
      suite: "browser-focused",
      referenceVariant: "operator",
      referenceTimeoutMs: 180_000,
      referencePollMs: 2_000,
      referenceApp: "reference-workbench",
      check: false,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.collectionRequired, true);
    assert.equal(report.collectionAttempted, false);
    assert.equal(report.gates.collection, "not_run");
    assert.equal(report.gates.referencePreflight, "not_run");
    assert.equal(report.gates.finalAudit, "failed");
    assert.equal(report.gates.referenceHealth, "not_run");
    assert.equal(report.gates.fairness, "not_run");
    assert.equal(report.gates.abAcceptance, "not_run");
    assert.ok(report.failures.includes("reference collection is required but --reference-base-url was not provided"));
    assert.ok(report.failures.includes("reference audit did not validate the comparison evidence"));
    const tasks = JSON.parse(readFileSync(report.artifacts.collectionTasksPath, "utf8")) as { taskCount?: unknown };
    assert.equal(tasks.taskCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B validated pipeline records reference preflight failures before comparison claims", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-validated-"));
  const server = createMockReferenceDaemon({ mode: "fallback" });
  try {
    const baseUrl = await listen(server);
    const fixture = writeFixture(dir);
    const report = await runRealLlmAbValidatedPipeline({
      naturalReportPath: fixture.naturalReportPath,
      referenceDir: fixture.referenceDir,
      workDir: fixture.workDir,
      suite: "browser-focused",
      referenceBaseUrl: baseUrl,
      referenceVariant: "operator",
      referenceTimeoutMs: 1_000,
      referencePollMs: 10,
      referenceApp: "reference-workbench",
      check: false,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.gates.referencePreflight, "failed");
    assert.equal(typeof report.artifacts.referencePreflightPath, "string");
    const preflight = JSON.parse(readFileSync(report.artifacts.referencePreflightPath!, "utf8")) as {
      status?: unknown;
      rootCauseBuckets?: unknown[];
    };
    assert.equal(preflight.status, "failed");
    assert.ok(preflight.rootCauseBuckets?.includes("model_adapter_fallback"));
    assert.ok(report.failures.some((failure) => failure.includes("reference preflight did not pass")));
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B validated pipeline skips collection when preflight fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-validated-"));
  const server = createMockReferenceDaemon({ mode: "fallback" });
  try {
    const baseUrl = await listen(server);
    const fixture = writeFixture(dir, { omitLastReference: true });
    const report = await runRealLlmAbValidatedPipeline({
      naturalReportPath: fixture.naturalReportPath,
      referenceDir: fixture.referenceDir,
      workDir: fixture.workDir,
      suite: "browser-focused",
      referenceBaseUrl: baseUrl,
      referenceVariant: "operator",
      referenceTimeoutMs: 1_000,
      referencePollMs: 10,
      referenceApp: "reference-workbench",
      check: false,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.collectionRequired, true);
    assert.equal(report.collectionAttempted, false);
    assert.equal(report.gates.referencePreflight, "failed");
    assert.equal(report.gates.collection, "not_run");
    assert.equal(report.artifacts.collectionReportPath, undefined);
    assert.ok(report.failures.some((failure) => failure.includes("reference preflight did not pass")));
    assert.ok(report.failures.includes("reference collection skipped because reference preflight failed"));
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B validated pipeline uses a neutral preflight probe instead of the first collection prompt", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-validated-"));
  const server = createMockReferenceDaemon({ mode: "scenarioDelegation" });
  try {
    const baseUrl = await listen(server);
    const fixture = writeFixture(dir, { omitLastReference: true });
    const report = await runRealLlmAbValidatedPipeline({
      naturalReportPath: fixture.naturalReportPath,
      referenceDir: fixture.referenceDir,
      workDir: fixture.workDir,
      suite: "browser-focused",
      referenceBaseUrl: baseUrl,
      referenceVariant: "operator",
      referenceTimeoutMs: 80,
      referencePollMs: 10,
      referenceApp: "reference-workbench",
      check: false,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.collectionRequired, true);
    assert.equal(report.collectionAttempted, true);
    assert.equal(report.gates.referencePreflight, "passed");
    assert.equal(report.gates.collection, "failed");
    assert.ok(!report.failures.includes("reference collection skipped because reference preflight failed"));
    assert.ok(report.failures.includes("reference collection did not complete successfully"));
    const preflight = JSON.parse(readFileSync(report.artifacts.referencePreflightPath!, "utf8")) as {
      status?: unknown;
      finalText?: unknown;
      rootCauseBuckets?: unknown[];
    };
    assert.equal(preflight.status, "passed");
    assert.doesNotMatch(String(preflight.finalText ?? ""), /Delegate to: role-explore/);
    assert.ok(!preflight.rootCauseBuckets?.includes("delegation_not_executed"));
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B validated pipeline CLI writes a failed report with check", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-validated-"));
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const fixture = writeFixture(dir, { omitLastReference: true });
    await runRealLlmAbValidatedPipelineCli([
      "--natural-report",
      fixture.naturalReportPath,
      "--reference-dir",
      fixture.referenceDir,
      "--suite",
      "browser-focused",
      "--work-dir",
      fixture.workDir,
      "--check",
    ]);
    const report = JSON.parse(readFileSync(path.join(fixture.workDir, "pipeline-report.json"), "utf8")) as {
      status?: unknown;
    };
    assert.equal(report.status, "failed");
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFixture(
  dir: string,
  options: { omitLastReference?: boolean; referenceModelId?: string } = {}
): { naturalReportPath: string; referenceDir: string; workDir: string } {
  const referenceDir = path.join(dir, "reference");
  const workDir = path.join(dir, "work");
  const naturalReportPath = path.join(dir, "natural.json");
  mkdirSync(referenceDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    naturalReportPath,
    JSON.stringify({
      kind: "turnkeyai.natural-mission-e2e.report",
      status: "passed",
      provider: MODEL_PROVIDER,
      modelId: MODEL_ID,
      modelEntryId: "test-model-entry",
      timeoutPolicy: { scenarioTimeoutMs: 360_000 },
      fixtureContentHashes: { [FIXTURE_URL]: FIXTURE_CONTENT_HASH },
      scenarios: SCENARIOS.map((scenario, index) => ({
        scenario,
        prompt: promptForScenario(scenario),
        missionId: `msn.pipeline.${index + 1}`,
        durationMs: 20_000,
        threadId: `THREAD-pipeline-${index + 1}`,
        status: "done",
        metrics: {
          tools: { requested: 1, results: 1, failed: 0, cancelled: 0, timeouts: 0, names: ["sessions_spawn"] },
          sessions: { spawned: 1, continued: 0 },
          browser: { profileFallbacks: 0, failureBuckets: [] },
          approvals: { requested: 0, decided: 0, applied: 0 },
          liveness: { active: 0, waiting: 0, stale: 0 },
          evidenceEvents: 1,
        },
        artifacts: [
          { kind: "snapshot", id: `art.snapshot.${index + 1}`, url: FIXTURE_URL, fixtureContentHash: FIXTURE_CONTENT_HASH },
        ],
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
    const prompt = promptForScenario(scenario);
    const referenceModelId = options.referenceModelId ?? MODEL_ID;
    writeFileSync(
      path.join(referenceDir, `${scenario}.json`),
      JSON.stringify({
        system: "reference",
        prompt,
        threadId: `THREAD-reference-${scenario}`,
        durationMs: 12_000,
        timedOut: false,
        provenance: {
          referenceApp: REFERENCE_APP,
          referenceBinary: REFERENCE_BINARY,
          referenceRepoPath: REFERENCE_RUNTIME_ROOT,
          referenceRuntimeRoot: REFERENCE_RUNTIME_ROOT,
          referenceVersion: REFERENCE_VERSION,
          referenceCommit: REFERENCE_COMMIT,
          daemonUrl: "http://127.0.0.1:1",
          apiEndpoint: "/websocket/connect",
          modelCatalog: {
            data: [{ provider: MODEL_PROVIDER, modelList: [{ modelName: referenceModelId, isDefault: true }] }],
          },
          provider: MODEL_PROVIDER,
          modelId: referenceModelId,
          exactRequestPayload: { transport: "reference-desktop-websocket-sendQuery", prompt },
          timeout: { timeoutMs: 180_000, pollMs: 2_000 },
          rawResponse: { finalText: referenceFinalText(scenario) },
          rawTranscript: { messages: [{ role: "user", content: prompt }, { role: "assistant", content: referenceFinalText(scenario) }] },
          rawToolCalls: [{ name: "browser_open" }],
          rawToolResults: [{ name: "browser_open", status: "ok" }],
          rawBrowserEvidence: [{ url: FIXTURE_URL, rendered: true, fixtureContentHash: FIXTURE_CONTENT_HASH }],
          fixtureContentHashes: { [FIXTURE_URL]: FIXTURE_CONTENT_HASH },
          artifactAdapterMappingSource: "scripts/real-llm-ab-validated-pipeline.test.ts",
          collectedAtMs: 1,
          exitStatus: "success",
          errorReason: "none",
        },
        rawResponse: { finalText: referenceFinalText(scenario) },
        rawTranscript: { messages: [{ role: "user", content: prompt }, { role: "assistant", content: referenceFinalText(scenario) }] },
        rawToolCalls: [{ name: "browser_open" }],
        rawToolResults: [{ name: "browser_open", status: "ok" }],
        rawBrowserEvidence: [{ url: FIXTURE_URL, rendered: true, fixtureContentHash: FIXTURE_CONTENT_HASH }],
        artifactAdapterMappingSource: "scripts/real-llm-ab-validated-pipeline.test.ts",
        collectedAtMs: 1,
        exitStatus: "success",
        errorReason: "none",
        first: {
          summary: {
            toolCallCount: 1,
            toolResultCount: 1,
            pendingToolCount: 0,
            finalText: referenceFinalText(scenario),
          },
        },
        score: { useful: true, weak: false },
      })
    );
  }
  return { naturalReportPath, referenceDir, workDir };
}

function promptForScenario(scenario: string): string {
  return `Review ${scenario} at ${FIXTURE_URL} and summarize evidence.`;
}

function referenceFinalText(scenario: string): string {
  return [
    `The ${scenario} task completed with rendered browser evidence from the shared fixture dashboard.`,
    "The tool transcript includes a browser open call, a successful tool result, and a visible page evidence record.",
    "The summary is evidence-backed and keeps the result scoped to the inspected fixture.",
  ].join(" ");
}

function createMockReferenceDaemon(input: {
  mode: "healthy" | "fallback" | "scenarioDelegation";
  authToken?: string;
}) {
  let prompt = "";
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (input.authToken && req.headers.authorization !== `Bearer ${input.authToken}`) {
      res.statusCode = 401;
      return writeJson(res, { error: "unauthorized" });
    }
    if (req.method === "GET" && url.pathname === "/models") {
      return writeJson(res, {
        models: [{ id: "primary", providerId: "fixture-provider", model: "fixture-model", configured: true }],
      });
    }
    if (req.method === "POST" && url.pathname === "/threads/bootstrap-demo") {
      return writeJson(res, { thread: { threadId: "THREAD-preflight" } });
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const body = (await readJsonBody(req)) as { content?: string };
      prompt = body.content ?? "";
      return writeJson(res, { accepted: true, threadId: "THREAD-preflight" });
    }
    if (req.method === "GET" && url.pathname === "/messages") {
      const content =
        input.mode === "scenarioDelegation" && /Review natural-browser/i.test(prompt)
          ? "I will delegate the rendered browser review to Explore.\n\nDelegate to: role-explore\nMessage: inspect the fixture and return browser evidence."
          : input.mode === "healthy" || input.mode === "scenarioDelegation"
            ? referenceFinalText("natural-browser-complex-page-review")
            : "Lead is operating as Lead Coordinator. Close the flow with a concise final message.";
      return writeJson(res, [
        { role: "user", content: prompt },
        {
          role: "assistant",
          content,
          metadata:
            input.mode === "fallback"
              ? { adapterName: "heuristic", fallbackReason: 'Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON' }
              : {
                  workerUsed: true,
                  workerType: "browser",
                  workerState: {
                    workerRunKey: "worker:browser:reference",
                    workerType: "browser",
                    status: "completed",
                    lastResult: {
                      status: "ok",
                      summary: "Rendered browser evidence from the shared fixture dashboard.",
                    },
                  },
                },
        },
      ]);
    }
    if (req.method === "GET" && url.pathname === "/browser-sessions") {
      return writeJson(res, [{ browserSessionId: "BSESS-reference-1", url: FIXTURE_URL, fixtureContentHash: FIXTURE_CONTENT_HASH }]);
    }
    if (req.method === "GET" && url.pathname === "/browser-sessions/BSESS-reference-1/history") {
      return writeJson(res, [{ action: "snapshot", url: FIXTURE_URL, rendered: true, fixtureContentHash: FIXTURE_CONTENT_HASH }]);
    }
    if (req.method === "GET" && url.pathname === "/flows") {
      return writeJson(res, [{ flowId: "FLOW-reference-1", status: "completed", completedRoleIds: ["role-lead"] }]);
    }
    if (req.method === "GET" && url.pathname === "/flows-summary") {
      return writeJson(res, { totalFlows: 1, statusCounts: { completed: 1 } });
    }
    if (req.method === "GET" && url.pathname === "/runtime-chains") {
      return writeJson(res, { activeChains: [], staleChains: [], completedChains: [{ chainId: "flow:FLOW-reference-1" }] });
    }
    res.statusCode = 404;
    return writeJson(res, { error: "not found" });
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(res: ServerResponse, body: unknown): void {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        resolve(`http://127.0.0.1:${address.port}`);
      }
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
