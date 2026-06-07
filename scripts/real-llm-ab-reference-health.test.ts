import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRealLlmAbReferenceHealthHelpText,
  buildRealLlmAbReferenceHealthReport,
  parseRealLlmAbReferenceHealthArgs,
  runRealLlmAbReferenceHealthCli,
} from "./real-llm-ab-reference-health";

test("real LLM A/B reference health parses args and help", () => {
  assert.deepEqual(
    parseRealLlmAbReferenceHealthArgs(["--tasks", "/tmp/tasks.json", "--out", "/tmp/health.json", "--check"]),
    {
      tasksPath: "/tmp/tasks.json",
      outPath: "/tmp/health.json",
      check: true,
    }
  );
  assert.deepEqual(parseRealLlmAbReferenceHealthArgs(["--help"]), { help: true });
  assert.match(buildRealLlmAbReferenceHealthHelpText(), /reference runtime health gate/);
  assert.throws(() => parseRealLlmAbReferenceHealthArgs(["--tasks", "/tmp/tasks.json"]), /missing required --out/);
});

test("real LLM A/B reference health passes provenance-complete healthy artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-health-"));
  try {
    const fixture = writeHealthFixture(dir);
    const report = buildRealLlmAbReferenceHealthReport({ tasksPath: fixture.tasksPath, generatedAtMs: 1 });

    assert.equal(report.status, "passed");
    assert.equal(report.taskCount, 2);
    assert.equal(report.healthyCount, 2);
    assert.equal(report.unhealthyCount, 0);
    assert.deepEqual(
      report.scenarios.map((scenario) => scenario.status),
      ["healthy", "healthy"]
    );
    assert.equal(report.scenarios[1]?.checks.browserRenderedEvidence, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference health accepts approval wait-timeout baseline loss artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-health-"));
  try {
    const referenceDir = path.join(dir, "reference");
    mkdirSync(referenceDir, { recursive: true });
    const prompt =
      "Open the local approval form and start a safe dry-run browser form submission attempt. If the operator decision does not arrive, stop without submitting the form.";
    const artifactPath = path.join(referenceDir, "natural-approval-wait-timeout-closeout.json");
    const tasksPath = path.join(dir, "tasks.json");
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-approval-wait-timeout-closeout",
            prompt,
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );
    const artifact = buildReferenceArtifact(prompt, "natural-approval-wait-timeout-closeout") as ReferenceArtifactFixture & {
      rawApprovalEvidence?: unknown[];
    };
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
    artifact.timedOut = true;
    artifact.provenance.exitStatus = "timeout";
    artifact.provenance.errorReason = "timeout waiting for assistant response";
    artifact.provenance.rawToolCalls = [{ name: "permission_query" }];
    artifact.provenance.rawToolResults = [];
    artifact.provenance.rawApprovalEvidence = rawApprovalEvidence;
    artifact.provenance.referenceScenarioDriver = { approvalDecisionPolicy: "wait_timeout" };
    artifact.rawToolCalls = artifact.provenance.rawToolCalls;
    artifact.rawToolResults = [];
    artifact.rawApprovalEvidence = rawApprovalEvidence;
    artifact.first.summary = {
      finalText: "",
      toolCallCount: 1,
      toolResultCount: 0,
    };
    artifact.score = { useful: false, weak: false };
    writeFileSync(artifactPath, JSON.stringify(artifact));

    const report = buildRealLlmAbReferenceHealthReport({ tasksPath, generatedAtMs: 1 });

    assert.equal(report.status, "passed");
    assert.equal(report.healthyCount, 1);
    assert.equal(report.scenarios[0]?.status, "healthy");
    assert.equal(report.scenarios[0]?.checks.finalAnswerCaptured, true);
    assert.equal(report.scenarios[0]?.checks.finalAnswerUseful, true);
    assert.equal(report.scenarios[0]?.checks.toolOrWorkerResult, true);
    assert.equal(report.scenarios[0]?.checks.runtimeHealthy, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference health accepts timeout-partial native-work baseline loss artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-health-"));
  try {
    const referenceDir = path.join(dir, "reference");
    mkdirSync(referenceDir, { recursive: true });
    const prompt =
      "Evaluate this slow source for a release-risk note.\nSlow source: http://127.0.0.1:65170/slow-fixture\nUse a bounded attempt. If the source does not return in time, close out with available evidence.";
    const artifactPath = path.join(referenceDir, "natural-timeout-partial-closeout.json");
    const tasksPath = path.join(dir, "tasks.json");
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-timeout-partial-closeout",
            prompt,
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );
    const artifact = buildReferenceArtifact(prompt, "natural-timeout-partial-closeout");
    artifact.timedOut = true;
    artifact.provenance.exitStatus = "timeout";
    artifact.provenance.errorReason = "timeout waiting for assistant response";
    artifact.provenance.rawToolCalls = [{ name: "explore", workerRunKey: "worker:explore:slow-source-timeout" }];
    artifact.provenance.rawToolResults = [];
    artifact.provenance.rawTranscript = [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: "",
        metadata: {
          spawnedWorkers: [{ workerType: "explore", workerRunKey: "worker:explore:slow-source-timeout" }],
          workerState: { status: "running" },
        },
      },
    ];
    artifact.provenance.referenceScenarioDriver = { kind: "timeout_partial", supported: true };
    artifact.rawToolCalls = artifact.provenance.rawToolCalls;
    artifact.rawToolResults = [];
    artifact.rawTranscript = artifact.provenance.rawTranscript;
    artifact.first.summary = {
      finalText: "",
      toolCallCount: 1,
      toolResultCount: 0,
    };
    artifact.score = { useful: false, weak: false };
    writeFileSync(artifactPath, JSON.stringify(artifact));

    const report = buildRealLlmAbReferenceHealthReport({ tasksPath, generatedAtMs: 1 });

    assert.equal(report.status, "passed");
    assert.equal(report.healthyCount, 1);
    assert.equal(report.scenarios[0]?.status, "healthy");
    assert.equal(report.scenarios[0]?.checks.finalAnswerCaptured, true);
    assert.equal(report.scenarios[0]?.checks.finalAnswerUseful, true);
    assert.equal(report.scenarios[0]?.checks.toolOrWorkerResult, true);
    assert.equal(report.scenarios[0]?.checks.runtimeHealthy, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference health rejects unknown model provenance", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-health-"));
  try {
    const fixture = writeHealthFixture(dir, {
      mutateArtifact: (artifact) => {
        artifact.provenance.modelCatalog = "unknown";
        artifact.provenance.provider = "unknown";
        artifact.provenance.modelId = "unknown";
      },
    });
    const report = buildRealLlmAbReferenceHealthReport({ tasksPath: fixture.tasksPath, generatedAtMs: 1 });

    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.status, "unhealthy");
    assert.equal(report.scenarios[0]?.checks.modelConfigured, false);
    assert.ok(report.scenarios[0]?.findings.includes("reference model configuration was not proven"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference health rejects harness text and failed worker metadata", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-health-"));
  try {
    const fixture = writeHealthFixture(dir, {
      mutateArtifact: (artifact) => {
        artifact.first.summary.finalText = "Lead is operating as Lead Coordinator. Close the flow with a concise final message.";
        artifact.score = { useful: false, weak: true };
        artifact.rawTranscript = [
          { role: "user", content: artifact.prompt },
          {
            role: "assistant",
            content: artifact.first.summary.finalText,
            metadata: {
              fallbackReason: `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
              workerState: { status: "failed", lastResult: { status: "failed" } },
            },
          },
        ];
        artifact.provenance.rawTranscript = artifact.rawTranscript;
      },
    });
    const report = buildRealLlmAbReferenceHealthReport({ tasksPath: fixture.tasksPath, generatedAtMs: 1 });

    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.checks.finalAnswerUseful, false);
    assert.equal(report.scenarios[0]?.checks.runtimeHealthy, false);
    assert.ok(report.scenarios[0]?.rootCauseBuckets.includes("model_adapter_fallback"));
    assert.ok(report.scenarios[0]?.rootCauseBuckets.includes("runtime_failure"));
    assert.ok(report.scenarios[0]?.rootCauseBuckets.includes("prompt_harness_echo"));
    assert.ok(report.scenarios[0]?.rootCauseBuckets.includes("weak_final_answer"));
    assert.ok(report.scenarios[0]?.findings.includes("reference final answer is weak, harness-like, or too short"));
    assert.ok(report.scenarios[0]?.findings.includes("reference runtime health failed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference health requires rendered evidence for browser scenarios", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-health-"));
  try {
    const fixture = writeHealthFixture(dir, {
      mutateArtifact: (artifact, scenarioId) => {
        if (scenarioId === "natural-browser-followup-continuation") {
          artifact.rawBrowserEvidence = [{ sessions: [{ browserSessionId: "BSESS-reference" }] }];
          artifact.provenance.rawBrowserEvidence = artifact.rawBrowserEvidence;
        }
      },
    });
    const report = buildRealLlmAbReferenceHealthReport({ tasksPath: fixture.tasksPath, generatedAtMs: 1 });

    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.status, "healthy");
    assert.equal(report.scenarios[1]?.status, "unhealthy");
    assert.equal(report.scenarios[1]?.checks.browserRenderedEvidence, false);
    assert.ok(report.scenarios[1]?.rootCauseBuckets.includes("browser_render_missing"));
    assert.ok(report.scenarios[1]?.findings.includes("reference browser-rendered evidence was not observed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference health buckets prose delegation that never executed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-health-"));
  try {
    const fixture = writeHealthFixture(dir, {
      mutateArtifact: (artifact) => {
        artifact.first.summary.finalText =
          "I will delegate this browser review to the specialist.\n\nNext Role: role-explore\nTask: open the dashboard and report back.";
        artifact.rawTranscript = [
          { role: "user", content: artifact.prompt },
          {
            role: "assistant",
            content: artifact.first.summary.finalText,
          },
        ];
        artifact.provenance.rawTranscript = artifact.rawTranscript;
        artifact.rawToolCalls = [];
        artifact.provenance.rawToolCalls = [];
        artifact.rawToolResults = [];
        artifact.provenance.rawToolResults = [];
        artifact.first.summary.toolCallCount = 0;
        artifact.first.summary.toolResultCount = 0;
        artifact.score = { useful: false, weak: true };
      },
    });
    const report = buildRealLlmAbReferenceHealthReport({ tasksPath: fixture.tasksPath, generatedAtMs: 1 });

    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.status, "unhealthy");
    assert.equal(report.scenarios[0]?.checks.toolOrWorkerTriggered, false);
    assert.ok(report.scenarios[0]?.rootCauseBuckets.includes("delegation_not_executed"));
    assert.ok(report.scenarios[0]?.rootCauseBuckets.includes("delegation_text_not_dispatchable"));
    assert.ok(report.scenarios[0]?.rootCauseBuckets.includes("missing_tool_call"));
    assert.ok(report.scenarios[0]?.findings.includes("reference native tool/worker execution was not observed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference health CLI writes output and fails check", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-health-"));
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const fixture = writeHealthFixture(dir, {
      mutateArtifact: (artifact) => {
        artifact.rawToolCalls = [];
        artifact.provenance.rawToolCalls = [];
        artifact.first.summary.toolCallCount = 0;
      },
    });
    const outPath = path.join(dir, "health.json");
    await runRealLlmAbReferenceHealthCli(["--tasks", fixture.tasksPath, "--out", outPath, "--check"]);
    const report = JSON.parse(readFileSync(outPath, "utf8")) as { status?: string; unhealthyCount?: number };

    assert.equal(report.status, "failed");
    assert.equal(report.unhealthyCount, 2);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference health extracts concrete browser failure buckets", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-health-"));
  try {
    const fixture = writeHealthFixture(dir, {
      mutateArtifact: (artifact, scenarioId) => {
        const error = scenarioId.includes("browser")
          ? "page.evaluate: ReferenceError: __name is not defined"
          : 'page.goto: Timeout 20000ms exceeded while waiting until "domcontentloaded"';
        artifact.rawBrowserEvidence = [
          {
            history: [
              {
                status: "failed",
                summary: `Browser worker failed for session failed-test. Error: ${error}`,
                failure: { message: error },
              },
            ],
          },
        ];
        artifact.provenance.rawBrowserEvidence = artifact.rawBrowserEvidence;
        artifact.rawTranscript = {
          messages: [
            {
              role: "assistant",
              metadata: { fallbackReason: 'Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON' },
            },
          ],
        };
        artifact.provenance.rawTranscript = artifact.rawTranscript;
      },
    });
    const report = buildRealLlmAbReferenceHealthReport({ tasksPath: fixture.tasksPath, generatedAtMs: 1 });

    assert.equal(report.status, "failed");
    assert.ok(report.scenarios[0]?.rootCauseBuckets.includes("browser_navigation_timeout"));
    assert.ok(report.scenarios[0]?.rootCauseBuckets.includes("browser_worker_failed"));
    assert.ok(report.scenarios[0]?.rootCauseBuckets.includes("reference_endpoint_or_auth"));
    assert.ok(report.scenarios[1]?.rootCauseBuckets.includes("browser_evaluate_error"));
    assert.ok(report.scenarios[1]?.rootCauseBuckets.includes("browser_worker_failed"));
    assert.ok(report.scenarios[1]?.rootCauseBuckets.includes("reference_endpoint_or_auth"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeHealthFixture(
  dir: string,
  options: {
    mutateArtifact?: (artifact: ReferenceArtifactFixture, scenarioId: string) => void;
  } = {}
): { tasksPath: string; referenceDir: string } {
  const referenceDir = path.join(dir, "reference");
  const tasksPath = path.join(dir, "tasks.json");
  mkdirSync(referenceDir, { recursive: true });
  const tasks = [
    {
      scenarioId: "natural-comparison-research",
      prompt: "Compare Vendor Alpha and Vendor Beta from the provided source pages.",
      expectedReferenceArtifactPath: path.join(referenceDir, "natural-comparison-research.json"),
      action: "recollect_reference_artifact",
    },
    {
      scenarioId: "natural-browser-followup-continuation",
      prompt: "Review the rendered operations dashboard and preserve context for a follow-up.",
      expectedReferenceArtifactPath: path.join(referenceDir, "natural-browser-followup-continuation.json"),
      action: "recollect_reference_artifact",
    },
  ];
  writeFileSync(
    tasksPath,
    JSON.stringify({
      kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
      generatedAtMs: 1,
      suite: "manual",
      taskCount: tasks.length,
      tasks,
    })
  );
  for (const task of tasks) {
    const artifact = buildReferenceArtifact(task.prompt, task.scenarioId);
    options.mutateArtifact?.(artifact, task.scenarioId);
    writeFileSync(task.expectedReferenceArtifactPath, JSON.stringify(artifact));
  }
  return { tasksPath, referenceDir };
}

interface ReferenceArtifactFixture {
  prompt: string;
  durationMs: number;
  timedOut: boolean;
  provenance: {
    modelCatalog: unknown;
    provider: unknown;
    modelId: unknown;
    exactRequestPayload: unknown;
    rawResponse: unknown;
    rawTranscript: unknown;
    rawToolCalls: unknown[];
    rawToolResults: unknown[];
    rawBrowserEvidence: unknown[];
    rawApprovalEvidence?: unknown[];
    referenceScenarioDriver?: unknown;
    exitStatus: unknown;
    errorReason: unknown;
  };
  rawTranscript: unknown;
  rawToolCalls: unknown[];
  rawToolResults: unknown[];
  rawBrowserEvidence: unknown[];
  rawApprovalEvidence?: unknown[];
  first: { summary: { finalText: string; toolCallCount: number; toolResultCount: number } };
  score: { useful: boolean; weak: boolean };
}

function buildReferenceArtifact(prompt: string, scenarioId: string): ReferenceArtifactFixture {
  const finalText =
    "Reference completed the natural task with source-backed evidence, a clear recommendation, and visible residual risk. " +
    "The answer cites collected evidence rather than relying on prior knowledge.";
  const rawToolCalls = [{ source: "metadata.worker", name: scenarioId.includes("browser") ? "browser" : "explore" }];
  const rawToolResults = [{ status: "ok", summary: "Collected source evidence for the task." }];
  const rawBrowserEvidence = scenarioId.includes("browser")
    ? [{ sessionId: "BSESS-reference", history: [{ status: "completed", rendered: true, title: "Operations dashboard" }] }]
    : [];
  return {
    prompt,
    durationMs: 12_000,
    timedOut: false,
    provenance: {
      modelCatalog: {
        models: [{ id: "primary", providerId: "fixture-provider", model: "fixture-model", configured: true }],
      },
      provider: "fixture-provider",
      modelId: "fixture-model",
      exactRequestPayload: { content: prompt },
      rawResponse: { finalText },
      rawTranscript: { messages: [{ role: "user", content: prompt }] },
      rawToolCalls,
      rawToolResults,
      rawBrowserEvidence,
      exitStatus: "success",
      errorReason: "none",
    },
    rawTranscript: { messages: [{ role: "user", content: prompt }] },
    rawToolCalls,
    rawToolResults,
    rawBrowserEvidence,
    first: {
      summary: {
        finalText,
        toolCallCount: rawToolCalls.length,
        toolResultCount: rawToolResults.length,
      },
    },
    score: { useful: true, weak: false },
  };
}
