import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      "--check",
      "--suite",
      "report-scenarios",
    ]),
    {
      specPath: "/tmp/spec.json",
      outPath: "/tmp/report.json",
      check: true,
      requiredSuite: "report-scenarios",
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
  assert.match(buildRealLlmAbReportBuildHelpText(), /report-scenarios/);
  assert.match(buildRealLlmAbReportBuildHelpText(), /--markdown-out/);
  assert.throws(() => parseRealLlmAbReportBuildArgs(["--spec", "/tmp/spec.json"]), /missing required --out/);
  assert.throws(
    () => parseRealLlmAbReportBuildArgs(["--spec", "/tmp/spec.json", "--out", "/tmp/report.json", "--markdown-out"]),
    /missing value for --markdown-out/
  );
  assert.throws(
    () => parseRealLlmAbReportBuildArgs(["--spec", "/tmp/spec.json", "--out", "/tmp/report.json", "--suite", "focused"]),
    /--suite must be one of: core, browser-focused, browser-reliability, full-natural, report-scenarios/
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

test("real LLM A/B report builder can assemble scenarios from separate TurnkeyAI natural reports", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const natural = JSON.parse(readFileSync(path.join(dir, "turnkeyai-natural.json"), "utf8")) as {
      scenarios: Array<Record<string, unknown>>;
    };
    const altScenario = {
      ...natural.scenarios[0]!,
      scenario: "natural-browser-dynamic-page-alt",
      missionId: "msn.alt.1",
      threadId: "THREAD-alt",
    };
    writeFileSync(
      path.join(dir, "turnkeyai-natural-alt.json"),
      JSON.stringify({
        ...natural,
        scenarios: [altScenario],
      })
    );

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
          {
            scenarioId: "browser-dynamic-alt",
            turnkeyaiScenarioId: "natural-browser-dynamic-page-alt",
            turnkeyaiNaturalReportPath: "turnkeyai-natural-alt.json",
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.status, "passed");
    assert.equal(report.scenarios[0]?.turnkeyai.missionId, "msn.test.1");
    assert.equal(report.scenarios[0]?.turnkeyai.artifactPath, "turnkeyai-natural.json");
    assert.equal(report.scenarios[1]?.turnkeyai.missionId, "msn.alt.1");
    assert.equal(report.scenarios[1]?.turnkeyai.artifactPath, "turnkeyai-natural-alt.json");
    assert.equal(validateRealLlmAbAcceptanceReport(report).status, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder downgrades TurnkeyAI finals that contradict source numeric evidence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const naturalPath = path.join(dir, "turnkeyai-natural.json");
    const natural = JSON.parse(readFileSync(naturalPath, "utf8")) as {
      scenarios: Array<Record<string, unknown>>;
    };
    natural.scenarios[0]!.final = {
      text: "The rendered dashboard confirms Stuck missions: 24 and Weak answer rate: 24%.",
      excerpt: "The rendered dashboard confirms Stuck missions: 24 and Weak answer rate: 24%.",
    };
    natural.scenarios[0]!.evidenceReplay = {
      finalText: "The rendered dashboard confirms Stuck missions: 24 and Weak answer rate: 24%.",
      timeline: {
        entries: [
          {
            kind: "browser",
            tags: ["runtime-progress", "browser", "browser_snapshot", "completed"],
            text: "Browser observed Workbench Product Signals. Visible text excerpt: Stuck missions: 6 Weak answer rate: 24%.",
          },
          {
            kind: "thought",
            tags: ["thread", "assistant"],
            text: "The rendered dashboard confirms Stuck missions: 24 and Weak answer rate: 24%.",
          },
        ],
      },
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

    const validation = validateRealLlmAbAcceptanceReport(report);
    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(report.scenarios[0]?.turnkeyai.finalAnswerUseful, false);
    assert.equal(report.scenarios[0]?.turnkeyai.dimensionScores.taskCompletion, 0);
    assert.equal(report.scenarios[0]?.turnkeyai.dimensionScores.evidenceQuality, 0);
    assert.equal(report.scenarios[0]?.turnkeyai.dimensionScores.finalAnswerUsefulness, 0);
    assert.ok(
      report.scenarios[0]?.turnkeyai.weakAnswerSignals?.includes(
        "evidence value mismatch: Stuck missions final=24 evidence=6"
      )
    );
    assert.match(validation.failures.join("\n"), /TurnkeyAI scored 0 for finalAnswerUsefulness/);
    assert.match(validation.failures.join("\n"), /root-cause review required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder rejects reference finals that contradict source numeric evidence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      rawResponse?: unknown;
      rawTranscript?: unknown;
      rawToolResults?: unknown[];
      rawBrowserEvidence?: unknown[];
      first?: { summary?: { finalText?: string; toolCallCount?: number; toolResultCount?: number } };
      score?: { useful?: boolean; weak?: boolean };
      provenance?: {
        rawResponse?: unknown;
        rawTranscript?: unknown;
        rawToolResults?: unknown[];
        rawBrowserEvidence?: unknown[];
      };
    };
    const finalText = "Reference rendered the dashboard and found Stuck missions: 24 with Weak answer rate: 24%.";
    const evidenceText = "Browser observed Workbench Product Signals. Visible text excerpt: Stuck missions: 6 Weak answer rate: 24%.";
    reference.rawResponse = { finalText };
    reference.rawTranscript = {
      messages: [
        { role: "user", content: NATURAL_BROWSER_PROMPT },
        { role: "tool", name: "browser_open", content: evidenceText },
        { role: "assistant", content: finalText },
      ],
    };
    reference.rawToolResults = [{ name: "browser_open", status: "ok", content: evidenceText }];
    reference.rawBrowserEvidence = [{ url: "http://127.0.0.1:1/dashboard", rendered: true, text: evidenceText }];
    reference.first = {
      ...(reference.first ?? {}),
      summary: {
        ...(reference.first?.summary ?? {}),
        toolCallCount: 1,
        toolResultCount: 1,
        finalText,
      },
    };
    reference.score = { useful: true, weak: false };
    if (reference.provenance) {
      reference.provenance.rawResponse = reference.rawResponse;
      reference.provenance.rawTranscript = reference.rawTranscript;
      reference.provenance.rawToolResults = reference.rawToolResults;
      reference.provenance.rawBrowserEvidence = reference.rawBrowserEvidence;
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

    const validation = validateRealLlmAbAcceptanceReport(report);
    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.comparisonClassification, "adapter_unproven");
    assert.equal(report.scenarios[0]?.reference.finalAnswerUseful, false);
    assert.equal(report.scenarios[0]?.reference.dimensionScores.finalAnswerUsefulness, 0);
    assert.ok(
      report.scenarios[0]?.reference.weakAnswerSignals.includes(
        "evidence value mismatch: Stuck missions final=24 evidence=6"
      )
    );
    assert.ok(
      report.scenarios[0]?.referenceAudit?.findings.includes(
        "reference evidence value mismatch: Stuck missions final=24 evidence=6"
      )
    );
    assert.match(validation.failures.join("\n"), /comparison is not validated \(adapter_unproven\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder does not credit reference continuation without follow-up evidence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const baseSpec = {
      turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
      generatedAtMs: 1,
      scenarios: [
        {
          scenarioId: "natural-followup-continuation",
          turnkeyaiScenarioId: "natural-browser-dynamic-page",
          prompt: NATURAL_BROWSER_PROMPT,
          requiresContinuation: true,
          referenceArtifactPath: "reference-browser.json",
        },
      ],
    };
    const singlePromptReport = buildRealLlmAbAcceptanceReport(baseSpec, { specDir: dir });

    assert.equal(singlePromptReport.scenarios[0]?.reference.continuation?.required, true);
    assert.equal(singlePromptReport.scenarios[0]?.reference.continuation?.sessionsContinued, 0);
    assert.equal(singlePromptReport.scenarios[0]?.reference.continuation?.reusedPriorContext, false);
    assert.equal(singlePromptReport.scenarios[0]?.reference.dimensionScores.continuationBehavior, 0);

    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      followup?: {
        summary?: {
          toolCallCount?: number;
          toolResultCount?: number;
          pendingToolCount?: number;
          finalText?: string;
        };
      };
    };
    reference.followup = {
      summary: {
        toolCallCount: 1,
        toolResultCount: 0,
        pendingToolCount: 1,
        finalText: "Continued the same browser review and verified the rendered page state again.",
      },
    };
    writeFileSync(referencePath, JSON.stringify(reference));

    const pendingFollowupReport = buildRealLlmAbAcceptanceReport(baseSpec, { specDir: dir });
    assert.equal(pendingFollowupReport.scenarios[0]?.reference.continuation?.sessionsContinued, 0);
    assert.equal(pendingFollowupReport.scenarios[0]?.reference.dimensionScores.continuationBehavior, 0);

    reference.followup.summary.toolResultCount = 1;
    writeFileSync(referencePath, JSON.stringify(reference));

    const followupReport = buildRealLlmAbAcceptanceReport(baseSpec, { specDir: dir });
    assert.equal(followupReport.scenarios[0]?.reference.continuation?.sessionsContinued, 1);
    assert.equal(followupReport.scenarios[0]?.reference.continuation?.reusedPriorContext, true);
    assert.equal(followupReport.scenarios[0]?.reference.dimensionScores.continuationBehavior, 2);
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

test("real LLM A/B report builder accepts recovered browser fallback after localhost fetch failure", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as Record<string, unknown> & {
      provenance?: Record<string, unknown>;
      score?: { useful?: boolean; weak?: boolean };
    };
    const prompt = NATURAL_BROWSER_PROMPT;
    const recoveredTranscript = {
      messages: [
        { role: "user", content: prompt },
        {
          role: "assistant",
          messageType: "tool_call",
          toolCalls: [{ id: "call-fetch", name: "web_fetch", arguments: { urls: ["http://127.0.0.1:1/dashboard"] } }],
        },
        {
          role: "tool",
          name: "web_fetch",
          toolCallId: "call-fetch",
          content: "Error: [network_error] Network error while contacting YOU.COM API: WebSearch proxy requires auth token",
        },
        {
          role: "assistant",
          messageType: "tool_call",
          toolCalls: [{ id: "call-browser", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
        },
        {
          role: "tool",
          name: "sessions_spawn",
          toolCallId: "call-browser",
          content:
            "task_id: agent:sub:browser:1\nstatus: completed\ntool_chain: web_fetch -> browser\ntool_errors:\n  - web_fetch: Error: [network_error] proxy requires auth token\n\n<task_result>Rendered dashboard evidence recovered in browser.</task_result>",
        },
        { role: "assistant", content: "Reference rendered the dashboard in the browser and returned evidence." },
      ],
    };
    const browserEvidence = [{ url: "http://127.0.0.1:1/dashboard", rendered: true, status: "completed" }];
    reference.rawTranscript = recoveredTranscript;
    reference.rawToolCalls = [
      { id: "call-fetch", name: "web_fetch" },
      { id: "call-browser", name: "sessions_spawn" },
    ];
    reference.rawToolResults = [
      { role: "tool", name: "web_fetch", toolCallId: "call-fetch", content: "Error: [network_error] proxy requires auth token" },
      {
        role: "tool",
        name: "sessions_spawn",
        toolCallId: "call-browser",
        content: "<task_result>Rendered dashboard evidence recovered in browser.</task_result>",
      },
    ];
    reference.rawBrowserEvidence = browserEvidence;
    reference.score = { useful: true, weak: false };
    if (reference.provenance) {
      reference.provenance.rawTranscript = recoveredTranscript;
      reference.provenance.rawToolCalls = reference.rawToolCalls;
      reference.provenance.rawToolResults = reference.rawToolResults;
      reference.provenance.rawBrowserEvidence = browserEvidence;
    }
    writeFileSync(referencePath, JSON.stringify(reference));

    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "natural-browser-dynamic-page",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(report.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "passed");
    assert.ok(
      !report.scenarios[0]?.referenceAudit?.findings.includes(
        "reference runtime health failure detected in raw transcript or worker metadata"
      )
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder accepts completed Accio browser session fallback without rendered markers", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as Record<string, unknown> & {
      first?: { summary?: Record<string, unknown> };
      provenance?: Record<string, unknown>;
      score?: { useful?: boolean; weak?: boolean };
    };
    const prompt = NATURAL_BROWSER_PROMPT;
    const finalText = "Reference used the browser worker after fetch failed and returned pricing evidence.";
    const recoveredTranscript = {
      messages: [
        { role: "user", content: prompt },
        {
          role: "assistant",
          messageType: "tool_call",
          toolCalls: [{ id: "call-fetch", name: "web_fetch", arguments: { urls: ["http://127.0.0.1:49671/pricing"] } }],
        },
        {
          role: "tool",
          name: "web_fetch",
          toolCallId: "call-fetch",
          content:
            "Error: [network_error] Network error while contacting YOU.COM API: WebSearch proxy requires auth token for http://127.0.0.1:49671/pricing",
        },
        {
          role: "assistant",
          messageType: "tool_call",
          toolCalls: [{ id: "call-browser", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
        },
        {
          role: "tool",
          name: "sessions_spawn",
          toolCallId: "call-browser",
          content:
            "task_id: agent:sub:browser:1\nstatus: completed\ntool_chain: browser\n\n<task_result>Provider A supports search and costs $0.28/$0.42. Provider B does not support search and costs $0.20/$0.40.</task_result>",
        },
        { role: "assistant", content: finalText },
      ],
    };
    reference.rawResponse = { finalText };
    reference.rawTranscript = recoveredTranscript;
    reference.rawToolCalls = [
      { id: "call-fetch", name: "web_fetch" },
      { id: "call-browser", name: "sessions_spawn", arguments: { agent_id: "browser" } },
    ];
    reference.rawToolResults = [
      {
        role: "tool",
        name: "web_fetch",
        toolCallId: "call-fetch",
        content: "Error: [network_error] proxy requires auth token for http://127.0.0.1:49671/pricing",
      },
      {
        role: "tool",
        name: "sessions_spawn",
        toolCallId: "call-browser",
        content:
          "task_id: agent:sub:browser:1\nstatus: completed\ntool_chain: browser\n\n<task_result>Provider pricing evidence recovered.</task_result>",
      },
    ];
    reference.rawBrowserEvidence = [];
    reference.first = {
      ...(reference.first ?? {}),
      summary: {
        ...(reference.first?.summary ?? {}),
        toolCallCount: 2,
        toolResultCount: 2,
        finalText,
      },
    };
    reference.score = { useful: true, weak: false };
    if (reference.provenance) {
      reference.provenance.rawResponse = { finalText };
      reference.provenance.rawTranscript = recoveredTranscript;
      reference.provenance.rawToolCalls = reference.rawToolCalls;
      reference.provenance.rawToolResults = reference.rawToolResults;
      reference.provenance.rawBrowserEvidence = [];
    }
    writeFileSync(referencePath, JSON.stringify(reference));

    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "provider-pricing",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(report.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "passed");
    assert.equal(report.scenarios[0]?.reference.browserEvidence?.used, true);
    assert.equal(report.scenarios[0]?.reference.browserEvidence?.rendered, false);
    const findings = report.scenarios[0]?.referenceAudit?.findings ?? [];
    assert.ok(!findings.some((finding) => finding.includes("reference localhost source access failed")));
    assert.ok(!findings.some((finding) => finding.includes("YOU.COM")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder explains unrecovered Accio localhost source failures", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as Record<string, unknown> & {
      first?: { summary?: Record<string, unknown> };
      rawResponse?: Record<string, unknown>;
      provenance?: Record<string, unknown>;
      score?: { useful?: boolean; weak?: boolean };
    };
    const prompt = NATURAL_BROWSER_PROMPT;
    const finalText = "Neither source page could be accessed, so I cannot produce the requested comparison.";
    const failedTranscript = {
      messages: [
        { role: "user", content: prompt },
        {
          role: "assistant",
          messageType: "tool_call",
          toolCalls: [{ id: "call-fetch", name: "web_fetch", arguments: { urls: ["http://127.0.0.1:49671/vendor-alpha"] } }],
        },
        {
          role: "tool",
          name: "web_fetch",
          toolCallId: "call-fetch",
          content:
            "Error: [network_error] Network error while contacting YOU.COM API: WebSearch proxy requires auth token for http://127.0.0.1:49671/vendor-alpha",
        },
        {
          role: "assistant",
          messageType: "tool_call",
          toolCalls: [{ id: "call-search", name: "web_search", arguments: { query: "127.0.0.1:49671 vendor beta" } }],
        },
        {
          role: "tool",
          name: "web_search",
          toolCallId: "call-search",
          content:
            "Error: [network_error] Network error while contacting YOU.COM API: WebSearch proxy requires auth token for localhost source pages",
        },
        { role: "assistant", content: finalText },
      ],
    };
    reference.rawResponse = { finalText };
    reference.rawTranscript = failedTranscript;
    reference.rawToolCalls = [
      { id: "call-fetch", name: "web_fetch", arguments: { urls: ["http://127.0.0.1:49671/vendor-alpha"] } },
      { id: "call-search", name: "web_search", arguments: { query: "127.0.0.1:49671 vendor beta" } },
    ];
    reference.rawToolResults = [
      { name: "web_fetch", status: "failed", content: "network_error for http://127.0.0.1:49671/vendor-alpha" },
      { name: "web_search", status: "failed", content: "network_error for localhost source pages" },
    ];
    reference.rawBrowserEvidence = [];
    reference.first = {
      ...(reference.first ?? {}),
      summary: {
        ...(reference.first?.summary ?? {}),
        toolCallCount: 2,
        toolResultCount: 2,
        finalText,
      },
    };
    reference.score = { useful: true, weak: false };
    if (reference.provenance) {
      reference.provenance.rawResponse = { finalText };
      reference.provenance.rawTranscript = failedTranscript;
      reference.provenance.rawToolCalls = reference.rawToolCalls;
      reference.provenance.rawToolResults = reference.rawToolResults;
      reference.provenance.rawBrowserEvidence = [];
    }
    writeFileSync(referencePath, JSON.stringify(reference));

    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "natural-browser-dynamic-page",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.scenarios[0]?.comparisonClassification, "reference_env_failed");
    assert.equal(report.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "failed");
    const findings = report.scenarios[0]?.referenceAudit?.findings ?? [];
    assert.ok(
      findings.includes(
        "reference localhost source access failed through web_fetch/web_search and no browser fallback evidence was captured"
      )
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.startsWith("reference localhost failure detail:") &&
          finding.includes("tools=web_fetch/web_search") &&
          finding.includes("you.com_proxy") &&
          finding.includes("auth_token_required") &&
          finding.includes("http://127.0.0.1:49671/vendor-alpha") &&
          finding.includes("rendered_browser_recovery=missing")
      ),
      JSON.stringify(findings, null, 2)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder accepts successful Accio direct web_fetch fallback for loopback sources", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as Record<string, unknown> & {
      first?: { summary?: Record<string, unknown> };
      provenance?: Record<string, unknown>;
      score?: { useful?: boolean; weak?: boolean };
    };
    const prompt = NATURAL_BROWSER_PROMPT;
    const finalText = [
      "## Source note",
      "",
      "| Provider | Search Support | Input Price | Output Price |",
      "|---|---|---:|---:|",
      "| OpenRouter | Supported through web_search option | $0.28 / 1M tokens | $0.42 / 1M tokens |",
      "",
      "Risk: Use this source as local test evidence only; production provider pages may change.",
    ].join("\n");
    const toolCall = {
      id: "call-fetch",
      name: "web_fetch",
      arguments: { urls: ["http://127.0.0.1:49672/deepseek-provider-pricing"] },
    };
    const toolResult = {
      name: "web_fetch",
      status: "finished",
      content: [
        "TURNKEYAI_PROVIDER_SEARCH_PRICING_OK",
        "OpenRouter deepseek-v4-flash Supported through the web_search option $0.28 per 1M tokens $0.42 per 1M tokens",
        "[Direct fetch fallback] Some sites block automated access or return minimal text.",
      ].join("\n"),
      metadata: { isError: false, is_error: false },
    };
    const transcript = [
      { role: "user", content: prompt },
      { role: "assistant", messageType: "tool_call", toolCalls: [toolCall] },
      { role: "tool", ...toolResult },
      { role: "assistant", content: finalText },
    ];

    reference.rawResponse = { finalText };
    reference.rawTranscript = transcript;
    reference.rawToolCalls = [toolCall];
    reference.rawToolResults = [toolResult];
    reference.rawBrowserEvidence = [];
    reference.first = {
      ...(reference.first ?? {}),
      summary: {
        ...(reference.first?.summary ?? {}),
        toolCallCount: 1,
        toolResultCount: 1,
        finalText,
      },
    };
    reference.score = { useful: true, weak: false };
    reference.provenance = {
      ...buildReferenceProvenance(prompt),
      rawResponse: { finalText },
      rawTranscript: transcript,
      rawToolCalls: [toolCall],
      rawToolResults: [toolResult],
      rawBrowserEvidence: [],
      exactRequestPayload: { transport: "accio-work-websocket-sendQuery", content: prompt },
    };
    writeFileSync(referencePath, JSON.stringify(reference));

    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "natural-provider-search-pricing",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt,
            requiresBrowser: false,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(report.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "passed");
    assert.equal(report.scenarios[0]?.reference?.toolSequence.includes("web_fetch"), true);
    assert.equal(
      report.scenarios[0]?.referenceAudit?.findings.some((finding) =>
        finding.includes("reference localhost source access failed")
      ),
      false
    );
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

    writeFixtureFiles(dir, {
      naturalWeakAnswerSignals: ["browser transport degraded"],
      naturalBrowserFailureBuckets: [{ bucket: "transport_failure", count: 1, latestAtMs: 2_000 }],
    });
    const recoveredNaturalPath = path.join(dir, "turnkeyai-natural.json");
    const recoveredNatural = JSON.parse(readFileSync(recoveredNaturalPath, "utf8")) as { scenarios: Array<Record<string, unknown>> };
    const recoveredScenario = recoveredNatural.scenarios[0] as {
      metrics?: { sessions?: { spawned?: number; continued?: number }; tools?: { requested?: number; results?: number } };
    };
    recoveredScenario.metrics = {
      ...(recoveredScenario.metrics ?? {}),
      sessions: { ...(recoveredScenario.metrics?.sessions ?? {}), spawned: 2 },
      tools: { ...(recoveredScenario.metrics?.tools ?? {}), requested: 2, results: 2 },
    };
    writeFileSync(recoveredNaturalPath, JSON.stringify(recoveredNatural));
    const recoveredLongDelegationReport = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "natural-long-delegation",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: NATURAL_BROWSER_PROMPT,
            requiresBrowser: true,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(recoveredLongDelegationReport.status, "passed");
    assert.deepEqual(recoveredLongDelegationReport.scenarios[0]?.turnkeyai.weakAnswerSignals, []);
    assert.equal(validateRealLlmAbAcceptanceReport(recoveredLongDelegationReport).status, "passed");

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

test("real LLM A/B report builder downgrades source-unavailable reference finals even when legacy score says useful", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as Record<string, unknown> & {
      first?: { summary?: Record<string, unknown> };
      rawResponse?: Record<string, unknown>;
      provenance?: Record<string, unknown>;
      score?: { useful?: boolean; weak?: boolean };
    };
    const unavailableFinal =
      "Neither source page could be accessed. Without the source content, I cannot produce a comparison.";
    reference.rawResponse = { finalText: unavailableFinal };
    reference.first = {
      ...(reference.first ?? {}),
      summary: {
        ...(reference.first?.summary ?? {}),
        finalText: unavailableFinal,
      },
    };
    reference.score = { useful: true, weak: false };
    if (reference.provenance) {
      reference.provenance.rawResponse = { finalText: unavailableFinal };
    }
    writeFileSync(referencePath, JSON.stringify(reference));

    const report = buildRealLlmAbAcceptanceReport(
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

    assert.equal(report.scenarios[0]?.reference.finalAnswerUseful, false);
    assert.equal(report.scenarios[0]?.reference.dimensionScores.finalAnswerUsefulness, 0);
    assert.ok(report.scenarios[0]?.reference.weakAnswerSignals.includes("weak-answer"));
    assert.equal(report.scenarios[0]?.comparisonClassification, "adapter_unproven");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder classifies unsupported reference scenario drivers as adapter-unproven", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      durationMs?: number;
      rawResponse?: unknown;
      rawTranscript?: unknown;
      rawToolCalls?: unknown[];
      rawToolResults?: unknown[];
      rawBrowserEvidence?: unknown[];
      artifactAdapterMappingSource?: unknown;
      exitStatus?: string;
      errorReason?: string;
      first?: { summary?: { toolCallCount?: number; toolResultCount?: number; finalText?: string } };
      score?: { useful?: boolean; weak?: boolean };
      provenance?: {
        apiEndpoint?: string;
        rawResponse?: unknown;
        rawTranscript?: unknown;
        rawToolCalls?: unknown[];
        rawToolResults?: unknown[];
        rawBrowserEvidence?: unknown[];
        artifactAdapterMappingSource?: unknown;
        exitStatus?: string;
        errorReason?: string;
        referenceScenarioDriver?: Record<string, unknown>;
      };
    };
    reference.durationMs = 0;
    reference.rawResponse = null;
    reference.rawTranscript = null;
    reference.rawToolCalls = [];
    reference.rawToolResults = [];
    reference.rawBrowserEvidence = [];
    reference.artifactAdapterMappingSource = "scripts/real-llm-ab-reference-collect.ts";
    reference.exitStatus = "error";
    reference.errorReason =
      "unsupported_reference_scenario_driver:accio_ws_reference_does_not_expose_active_cancellation_driver";
    if (reference.first?.summary) {
      reference.first.summary.toolCallCount = 0;
      reference.first.summary.toolResultCount = 0;
      reference.first.summary.finalText = "";
    }
    reference.score = { useful: false, weak: true };
    if (reference.provenance) {
      reference.provenance.apiEndpoint = "not_run";
      reference.provenance.rawResponse = null;
      reference.provenance.rawTranscript = null;
      reference.provenance.rawToolCalls = [];
      reference.provenance.rawToolResults = [];
      reference.provenance.rawBrowserEvidence = [];
      reference.provenance.artifactAdapterMappingSource = "scripts/real-llm-ab-reference-collect.ts";
      reference.provenance.exitStatus = "error";
      reference.provenance.errorReason = reference.errorReason;
      reference.provenance.referenceScenarioDriver = {
        kind: "cancel_active",
        supported: false,
        missionThread: false,
        missionMode: "custom",
        unsupportedReason: "accio_ws_reference_does_not_expose_active_cancellation_driver",
      };
    }
    writeFileSync(referencePath, JSON.stringify(reference));

    const report = buildRealLlmAbAcceptanceReport(
      {
        turnkeyaiNaturalReportPath: "turnkeyai-natural.json",
        generatedAtMs: 1,
        scenarios: [
          {
            scenarioId: "natural-cancel-active-tool",
            turnkeyaiScenarioId: "natural-browser-dynamic-page",
            prompt: NATURAL_BROWSER_PROMPT,
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.comparisonClassification, "adapter_unproven");
    assert.equal(report.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "failed");
    assert.equal(report.scenarios[0]?.referenceAudit?.adapterStatus, "failed");
    assert.ok(
      report.scenarios[0]?.referenceAudit?.findings.includes(
        "reference scenario driver unsupported: accio_ws_reference_does_not_expose_active_cancellation_driver"
      )
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder reads late Accio session-file tool results", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const sessionPath = path.join(dir, "accio-session.messages.jsonl");
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      timedOut?: boolean;
      rawTranscript?: unknown;
      rawToolCalls?: unknown[];
      rawToolResults?: unknown[];
      rawBrowserEvidence?: unknown[];
      first?: { summary?: { toolCallCount?: number; toolResultCount?: number; finalText?: string } };
      score?: { useful?: boolean; weak?: boolean };
      provenance?: {
        rawTranscript?: unknown;
        rawToolCalls?: unknown[];
        rawToolResults?: unknown[];
        rawBrowserEvidence?: unknown[];
        rawFlowEvidence?: unknown[];
        exitStatus?: string;
        errorReason?: string;
      };
    };
    const staleMessages = [
      { role: "user", content: NATURAL_BROWSER_PROMPT },
      {
        role: "assistant",
        content: "I'll inspect the localhost dashboard with a browser worker.",
        toolCalls: [{ id: "call-browser", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
      },
    ];
    const lateMessages = [
      ...staleMessages,
      {
        role: "tool",
        toolCallId: "call-browser",
        name: "sessions_spawn",
        content:
          "task_id: agent:sub:browser:late\nstatus: timeout\ntool_chain: web_fetch -> browser\ntool_errors:\n  - web_fetch: Error: Fetched 0/1 URLs successfully\n<task_result>Browser worker timed out after network_error contacting localhost.</task_result>",
      },
      {
        role: "assistant",
        content:
          "Can't reach those URLs. The localhost addresses are only accessible from your own machine, and my tools route through external infrastructure.",
      },
    ];
    writeFileSync(sessionPath, lateMessages.map((message) => JSON.stringify(message)).join("\n"));
    reference.timedOut = true;
    reference.rawTranscript = staleMessages;
    reference.rawToolCalls = [{ id: "call-browser", name: "sessions_spawn" }];
    reference.rawToolResults = [];
    reference.rawBrowserEvidence = [];
    if (reference.first?.summary) {
      reference.first.summary.toolCallCount = 1;
      reference.first.summary.toolResultCount = 0;
      reference.first.summary.finalText = "I'll inspect the localhost dashboard with a browser worker.";
    }
    reference.score = { useful: false, weak: false };
    if (reference.provenance) {
      reference.provenance.rawTranscript = staleMessages;
      reference.provenance.rawToolCalls = reference.rawToolCalls;
      reference.provenance.rawToolResults = [];
      reference.provenance.rawBrowserEvidence = [];
      reference.provenance.rawFlowEvidence = [{ source: "accio_ws_session_file", sessionPath }];
      reference.provenance.exitStatus = "timeout";
      reference.provenance.errorReason = "timeout waiting for assistant response";
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
    assert.equal(report.scenarios[0]?.reference.toolResultCount, 1);
    assert.equal(report.scenarios[0]?.reference.stuckOrLoop, false);
    assert.equal(report.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "failed");
    assert.ok(
      !report.scenarios[0]?.referenceAudit?.findings.includes(
        "reference native tool/worker result was not observed"
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

test("real LLM A/B report builder rejects non-Accio app.asar reference sources", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      provenance?: {
        referenceApp?: unknown;
        referenceBinary?: unknown;
        referenceRepoPath?: unknown;
        referenceRuntimeRoot?: unknown;
        apiEndpoint?: unknown;
        exactRequestPayload?: { transport?: unknown };
      };
    };
    if (reference.provenance) {
      reference.provenance.referenceApp = "reference-workbench";
      reference.provenance.referenceBinary = "/tmp/reference-daemon";
      reference.provenance.referenceRepoPath = "/Users/chris/workspace/accio";
      reference.provenance.referenceRuntimeRoot = "/tmp/accio-reference";
      reference.provenance.apiEndpoint = "/messages";
      reference.provenance.exactRequestPayload = { transport: "http-json" };
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

    const findings = report.scenarios[0]?.referenceAudit?.findings ?? [];
    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.comparisonClassification, "adapter_unproven");
    assert.equal(report.scenarios[0]?.referenceAudit?.provenanceStatus, "failed");
    assert.equal(report.scenarios[0]?.referenceAudit?.adapterStatus, "failed");
    assert.ok(findings.some((finding) => finding.includes("reference source must be accio-work-app-asar")));
    assert.ok(findings.some((finding) => finding.includes("reference binary must be /Applications/Accio.app/Contents/Resources/app.asar")));
    assert.ok(findings.some((finding) => finding.includes("reference runtime path must be the persistent Accio runtime")));
    assert.ok(findings.some((finding) => finding.includes("reference runtime path must not be under /tmp")));
    assert.ok(findings.some((finding) => finding.includes("deprecated /Users/chris/workspace/accio source")));
    assert.ok(findings.some((finding) => finding.includes("reference api endpoint must be /websocket/connect")));
    assert.ok(findings.some((finding) => finding.includes("reference request transport must be accio-work-websocket-sendQuery")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder accepts relative persistent Accio runtime paths", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      provenance?: {
        referenceRepoPath?: unknown;
        referenceRuntimeRoot?: unknown;
      };
    };
    if (reference.provenance) {
      reference.provenance.referenceRepoPath = "artifacts/reference-runtimes/accio-work-0.4.5";
      reference.provenance.referenceRuntimeRoot = "artifacts/reference-runtimes/accio-work-0.4.5";
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

    assert.equal(report.status, "passed");
    assert.equal(report.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(report.scenarios[0]?.referenceAudit?.provenanceStatus, "passed");
    assert.ok(
      !(report.scenarios[0]?.referenceAudit?.findings ?? []).some((finding) =>
        finding.includes("reference runtime path must be the persistent Accio runtime")
      )
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder rejects reference artifacts with pending tool calls in raw transcript", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      provenance?: {
        rawTranscript?: unknown;
        rawToolCalls?: unknown;
        rawToolResults?: unknown;
      };
      rawTranscript?: unknown;
      rawToolCalls?: unknown;
      rawToolResults?: unknown;
      first?: { summary?: { toolCallCount?: unknown; toolResultCount?: unknown; finalText?: unknown } };
      score?: { useful?: unknown; weak?: unknown };
    };
    const transcript = [
      {
        role: "assistant",
        content: "I will inspect the first source.",
        toolCalls: [{ id: "call-browser-1", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
      },
      {
        role: "tool",
        name: "sessions_spawn",
        toolCallId: "call-browser-1",
        content: "task_id: first\nstatus: completed\n\n<task_result>first source rendered</task_result>",
      },
      {
        role: "assistant",
        content: "The first source worked. I will inspect the second source now.",
        toolCalls: [{ id: "call-browser-2", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
      },
    ];
    const rawToolCalls = [
      { id: "call-browser-1", name: "sessions_spawn" },
      { id: "call-browser-2", name: "sessions_spawn" },
    ];
    const rawToolResults = [{ toolCallId: "call-browser-1", name: "sessions_spawn" }];
    reference.rawTranscript = transcript;
    reference.rawToolCalls = rawToolCalls;
    reference.rawToolResults = rawToolResults;
    reference.provenance = {
      ...reference.provenance,
      rawTranscript: transcript,
      rawToolCalls,
      rawToolResults,
    };
    reference.first = {
      summary: {
        toolCallCount: 2,
        toolResultCount: 1,
        finalText: "The first source worked. I will inspect the second source now.",
      },
    };
    reference.score = { useful: true, weak: false };
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

    const findings = report.scenarios[0]?.referenceAudit?.findings ?? [];
    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.comparisonClassification, "adapter_unproven");
    assert.equal(report.scenarios[0]?.referenceAudit?.adapterStatus, "failed");
    assert.ok(findings.includes("reference transcript still has pending tool calls or intermediate assistant text"));
    assert.ok(
      findings.some(
        (finding) =>
          finding === "reference pending tool detail: pending=1, calls=2, results=1: sessions_spawn(browser)"
      ),
      JSON.stringify(findings, null, 2)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder reports orphaned Accio workspace artifacts without crediting browser success", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      timedOut?: boolean;
      provenance?: {
        rawTranscript?: unknown;
        rawToolCalls?: unknown;
        rawToolResults?: unknown;
        rawBrowserEvidence?: unknown;
        rawFlowEvidence?: unknown[];
        exitStatus?: unknown;
        errorReason?: unknown;
      };
      rawTranscript?: unknown;
      rawToolCalls?: unknown;
      rawToolResults?: unknown;
      rawBrowserEvidence?: unknown;
      rawFlowEvidence?: unknown[];
      first?: { summary?: { toolCallCount?: unknown; toolResultCount?: unknown; pendingToolCount?: unknown; finalText?: unknown } };
      score?: { useful?: unknown; weak?: unknown };
      exitStatus?: unknown;
      errorReason?: unknown;
    };
    const transcript = [
      { role: "user", content: NATURAL_BROWSER_PROMPT },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-browser", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
      },
    ];
    const rawToolCalls = [{ id: "call-browser", name: "sessions_spawn", arguments: { agent_id: "browser" } }];
    const rawFlowEvidence = [
      {
        source: "accio_ws_workspace_artifact_after_prompt",
        status: "orphaned_workspace_artifact",
        kind: "screenshot",
        relativePath: "ops-dashboard-1.png",
        sizeBytes: 36_801,
        sha256: "sha256:test",
      },
    ];
    reference.timedOut = true;
    reference.rawTranscript = transcript;
    reference.rawToolCalls = rawToolCalls;
    reference.rawToolResults = [];
    reference.rawBrowserEvidence = [];
    reference.rawFlowEvidence = rawFlowEvidence;
    reference.provenance = {
      ...reference.provenance,
      rawTranscript: transcript,
      rawToolCalls,
      rawToolResults: [],
      rawBrowserEvidence: [],
      rawFlowEvidence,
      exitStatus: "timeout",
      errorReason: "timeout waiting for assistant response",
    };
    reference.first = {
      summary: {
        toolCallCount: 1,
        toolResultCount: 0,
        pendingToolCount: 1,
        finalText: "",
      },
    };
    reference.score = { useful: false, weak: true };
    reference.exitStatus = "timeout";
    reference.errorReason = "timeout waiting for assistant response";
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

    const scenario = report.scenarios[0];
    const findings = scenario?.referenceAudit?.findings ?? [];
    assert.equal(report.status, "failed");
    assert.equal(scenario?.comparisonClassification, "reference_env_failed");
    assert.equal(scenario?.reference.browserEvidence?.rendered, false);
    assert.equal(scenario?.reference.toolResultCount, 0);
    assert.equal(scenario?.referenceAudit?.runtimeHealthStatus, "failed");
    assert.ok(
      findings.some((finding) =>
        finding.includes("reference Accio workspace artifact orphaned from transcript: count=1 screenshot:ops-dashboard-1.png:36801b")
      ),
      JSON.stringify(findings, null, 2)
    );
    assert.ok(findings.includes("reference native tool/worker result was not observed"));
    assert.ok(findings.includes("reference pending tool detail: pending=1, calls=1, results=0: sessions_spawn(browser)"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder explains Accio websocket browser worker runtime failures from sdk logs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const logPath = path.join(dir, "sdk.log");
    const conversationId = "CID-natural-browser-dynamic-page-log-test";
    writeFileSync(
      logPath,
      [
        JSON.stringify({ conversationId, message: "Tool call failed: browser Error: Unknown browser action: wait" }),
        JSON.stringify({ conversationId, message: "Error: scriptPath read failed (after retry): ENOENT: no such file or directory" }),
        JSON.stringify({ conversationId, message: "Failed to process /tmp/ops_dashboard.png: CDN upload failed after retries" }),
        JSON.stringify({ conversationId, message: "WebSearch proxy requires auth token while fetching http://127.0.0.1:56345/ops-dashboard" }),
        JSON.stringify({ conversationId, message: "Accessing '/tmp/ops_text.txt' requires approval — the path is outside the workspace." }),
        JSON.stringify({ conversationId, message: "[PERM:ws-send-fn] wsState=3, wsOpen=false, method=permission.query" }),
        JSON.stringify({ conversationId, message: "[Gateway Event] Broadcast channel.permission.query to 0 desktop clients" }),
        JSON.stringify({ conversationId, message: "Channel adapter not found: reference-collector" }),
      ].join("\n")
    );
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      timedOut?: boolean;
      provenance?: {
        rawTranscript?: unknown;
        rawToolCalls?: unknown;
        rawToolResults?: unknown;
        rawBrowserEvidence?: unknown;
        rawFlowEvidence?: unknown[];
        exitStatus?: unknown;
        errorReason?: unknown;
      };
      rawTranscript?: unknown;
      rawToolCalls?: unknown;
      rawToolResults?: unknown;
      rawBrowserEvidence?: unknown;
      rawFlowEvidence?: unknown[];
      first?: { summary?: { toolCallCount?: unknown; toolResultCount?: unknown; pendingToolCount?: unknown; finalText?: unknown } };
      score?: { useful?: unknown; weak?: unknown };
      exitStatus?: unknown;
      errorReason?: unknown;
    };
    const transcript = [
      { role: "user", content: NATURAL_BROWSER_PROMPT },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-browser", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
      },
      {
        role: "tool",
        name: "sessions_spawn",
        toolCallId: "call-browser",
        content:
          "task_id: sub:browser\nstatus: timeout\n<task_result>[SubAgent timed out after 1080s before producing a final summary]</task_result>",
      },
    ];
    reference.timedOut = true;
    reference.rawTranscript = transcript;
    reference.rawToolCalls = [{ id: "call-browser", name: "sessions_spawn", arguments: { agent_id: "browser" } }];
    reference.rawToolResults = [];
    reference.rawBrowserEvidence = [];
    reference.rawFlowEvidence = [{ source: "accio_ws_sdk_log", conversationId, sdkLogPath: logPath }];
    reference.provenance = {
      ...reference.provenance,
      rawTranscript: transcript,
      rawToolCalls: reference.rawToolCalls,
      rawToolResults: [],
      rawBrowserEvidence: [],
      rawFlowEvidence: reference.rawFlowEvidence,
      exitStatus: "timeout",
      errorReason: "timeout waiting for assistant response",
    };
    reference.first = {
      summary: {
        toolCallCount: 1,
        toolResultCount: 0,
        pendingToolCount: 0,
        finalText: "",
      },
    };
    reference.score = { useful: false, weak: true };
    reference.exitStatus = "timeout";
    reference.errorReason = "timeout waiting for assistant response";
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

    const findings = report.scenarios[0]?.referenceAudit?.findings ?? [];
    assert.equal(report.scenarios[0]?.comparisonClassification, "reference_env_failed");
    assert.ok(findings.includes("reference Accio browser sub-agent exceeded native timeout before usable closeout: 1080s"));
    assert.ok(findings.includes("reference Accio browser worker attempted unsupported browser action: wait"));
    assert.ok(findings.includes("reference Accio browser worker attempted console script before writing a readable scriptPath"));
    assert.ok(findings.includes("reference Accio image handoff failed because screenshot CDN upload failed"));
    assert.ok(findings.includes("reference Accio web_fetch fallback for loopback URL went through external search proxy and failed auth"));
    assert.ok(findings.includes("reference Accio browser worker attempted /tmp delivery outside the configured persistent workspace"));
    assert.ok(findings.includes("reference Accio permission query had no desktop client to answer, leaving worker progress unobservable"));
    assert.ok(findings.includes("reference Accio channel adapter was missing for reference-collector permission routing"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder derives Accio sdk logs from websocket session evidence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const referencePath = path.join(dir, "reference-browser.json");
    const accioHome = path.join(dir, "home", ".accio");
    const logDir = path.join(accioHome, "logs");
    mkdirSync(logDir, { recursive: true });
    const conversationId = "CID-natural-browser-dynamic-page-derived-log";
    writeFileSync(
      path.join(logDir, "sdk.log"),
      JSON.stringify({
        conversationId,
        message: "SubAgent browser soft timeout after 1080s — waiting for current tool result then summarising",
      }) + "\n"
    );
    const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
      timedOut?: boolean;
      provenance?: {
        rawTranscript?: unknown;
        rawToolCalls?: unknown;
        rawToolResults?: unknown;
        rawBrowserEvidence?: unknown;
        rawFlowEvidence?: unknown[];
        exitStatus?: unknown;
        errorReason?: unknown;
      };
      rawTranscript?: unknown;
      rawToolCalls?: unknown;
      rawToolResults?: unknown;
      rawBrowserEvidence?: unknown;
      rawFlowEvidence?: unknown[];
      first?: { summary?: { toolCallCount?: unknown; toolResultCount?: unknown; pendingToolCount?: unknown; finalText?: unknown } };
      score?: { useful?: unknown; weak?: unknown };
      exitStatus?: unknown;
      errorReason?: unknown;
    };
    const transcript = [
      { role: "user", content: NATURAL_BROWSER_PROMPT },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-browser", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
      },
    ];
    reference.timedOut = true;
    reference.rawTranscript = transcript;
    reference.rawToolCalls = [{ id: "call-browser", name: "sessions_spawn", arguments: { agent_id: "browser" } }];
    reference.rawToolResults = [];
    reference.rawBrowserEvidence = [];
    reference.rawFlowEvidence = [{ source: "accio_ws_session_file", accioHome, conversationId }];
    reference.provenance = {
      ...reference.provenance,
      rawTranscript: transcript,
      rawToolCalls: reference.rawToolCalls,
      rawToolResults: [],
      rawBrowserEvidence: [],
      rawFlowEvidence: reference.rawFlowEvidence,
      exitStatus: "timeout",
      errorReason: "timeout waiting for assistant response",
    };
    reference.first = {
      summary: {
        toolCallCount: 1,
        toolResultCount: 0,
        pendingToolCount: 1,
        finalText: "",
      },
    };
    reference.score = { useful: false, weak: true };
    reference.exitStatus = "timeout";
    reference.errorReason = "timeout waiting for assistant response";
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

    const findings = report.scenarios[0]?.referenceAudit?.findings ?? [];
    assert.equal(report.scenarios[0]?.comparisonClassification, "reference_env_failed");
    assert.ok(findings.includes("reference Accio browser sub-agent exceeded native timeout before usable closeout: 1080s"));
    assert.ok(findings.includes("reference pending tool detail: pending=1, calls=1, results=0: sessions_spawn(browser)"));
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
      missionId: "msn.reference.1",
      exactRequestPayload: { transport: "accio-work-websocket-sendQuery", title: prompt, desc: "", mode: "browser" },
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

test("real LLM A/B report builder penalizes approval reference artifacts without approval runtime evidence", () => {
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
    const rawBrowserEvidence = [{ source: "session_tool_result", rendered: true, status: "completed" }];
    reference.prompt = prompt;
    reference.missionId = "msn.reference.no-approval";
    reference.threadId = "THREAD-reference-no-approval";
    reference.provenance = {
      ...buildReferenceProvenance(prompt),
      missionId: "msn.reference.no-approval",
      exactRequestPayload: { transport: "accio-work-websocket-sendQuery", title: prompt, desc: "", mode: "browser" },
      rawBrowserEvidence,
      rawApprovalEvidence: [],
      referenceScenarioDriver: { approvalDecisionPolicy: "approved" },
    };
    reference.rawBrowserEvidence = rawBrowserEvidence;
    reference.rawApprovalEvidence = [];
    reference.rawToolCalls = [{ name: "sessions_spawn" }];
    reference.rawToolResults = [{ name: "sessions_spawn", status: "ok", content: "Clicked Submit dry-run and completed." }];
    reference.provenance.rawToolCalls = reference.rawToolCalls;
    reference.provenance.rawToolResults = reference.rawToolResults;
    reference.first.summary = {
      toolCallCount: 1,
      toolResultCount: 1,
      pendingToolCount: 0,
      finalText: "Clicked Submit dry-run and completed with rendered browser evidence.",
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

    assert.equal(report.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(report.scenarios[0]?.reference.approval?.requested, false);
    assert.equal(report.scenarios[0]?.reference.dimensionScores.permissionCorrectness, 0);
    assert.equal(report.scenarios[0]?.turnkeyai.dimensionScores.permissionCorrectness, 2);
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
        missionId: "msn.reference.timeout",
        exactRequestPayload: { transport: "accio-work-websocket-sendQuery", title: prompt, desc: "", mode: "browser" },
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

test("real LLM A/B report builder penalizes approval wait-timeout reference submissions", () => {
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
      durationMs: 15_000,
      status: "done",
      metrics: {
        tools: {
          requested: 2,
          results: 2,
          failed: 0,
          cancelled: 0,
          timeouts: 0,
          names: ["permission_query", "permission_result"],
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
    const reference = {
      system: "reference",
      prompt,
      missionId: "msn.reference.wait-timeout",
      threadId: "THREAD-reference-wait-timeout",
      durationMs: 48_000,
      timedOut: false,
      provenance: {
        ...buildReferenceProvenance(prompt),
        missionId: "msn.reference.wait-timeout",
        exactRequestPayload: { transport: "accio-work-websocket-sendQuery", title: prompt, desc: "", mode: "browser" },
        rawResponse: { id: "msn.reference.wait-timeout", status: "done", threadId: "THREAD-reference-wait-timeout" },
        rawTranscript: {
          messages: [
            { role: "user", content: prompt },
            { role: "assistant", content: "Outcome: Approved. Clicked Submit dry-run and submission completed." },
          ],
        },
        rawToolCalls: [{ name: "sessions_spawn" }],
        rawToolResults: [
          {
            name: "sessions_spawn",
            content:
              "Operator Approval Received. Clicked Submit dry-run. Dry-run submission completed successfully. submitted locally after approval.",
          },
        ],
        rawBrowserEvidence: [],
        rawApprovalEvidence: [],
        referenceScenarioDriver: {
          approvalDecisionPolicy: "wait_timeout",
          envRequirements: { TURNKEYAI_TOOL_PERMISSION_WAIT_MS: "2000" },
        },
        exitStatus: "success",
        errorReason: "none",
      },
      rawResponse: { id: "msn.reference.wait-timeout", status: "done", threadId: "THREAD-reference-wait-timeout" },
      rawTranscript: {
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: "Outcome: Approved. Clicked Submit dry-run and submission completed." },
        ],
      },
      rawToolCalls: [{ name: "sessions_spawn" }],
      rawToolResults: [
        {
          name: "sessions_spawn",
          content:
            "Operator Approval Received. Clicked Submit dry-run. Dry-run submission completed successfully. submitted locally after approval.",
        },
      ],
      rawBrowserEvidence: [],
      rawApprovalEvidence: [],
      artifactAdapterMappingSource: "scripts/real-llm-ab-reference-collect.ts",
      collectedAtMs: 1,
      exitStatus: "success",
      errorReason: "none",
      first: {
        summary: {
          toolCallCount: 1,
          toolResultCount: 1,
          pendingToolCount: 0,
          finalText: "Outcome: Approved. Clicked Submit dry-run and submission completed.",
        },
      },
      score: {
        useful: true,
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
            referenceArtifactPath: "reference-browser.json",
          },
        ],
      },
      { specDir: dir }
    );
    const validation = validateRealLlmAbAcceptanceReport(report);

    assert.equal(report.status, "passed", JSON.stringify({ validation, scenario: report.scenarios[0] }, null, 2));
    assert.equal(report.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(report.scenarios[0]?.reference.completed, false);
    assert.equal(report.scenarios[0]?.reference.finalAnswerUseful, false);
    assert.equal(report.scenarios[0]?.reference.dimensionScores.taskCompletion, 0);
    assert.equal(report.scenarios[0]?.reference.dimensionScores.permissionCorrectness, 0);
    assert.equal(report.scenarios[0]?.turnkeyai.dimensionScores.permissionCorrectness, 2);
    assert.equal(validation.summary?.comparisons[0]?.scoreDelta! > 0, true);
    assert.equal(validation.summary?.turnkeyaiWins, 1);
    assert.equal(validation.summary?.turnkeyaiTies, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B report builder accepts Accio direct timeout evidence for slow loopback sources", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-build-"));
  try {
    writeFixtureFiles(dir);
    const prompt = [
      "Evaluate this slow source for a release-risk note.",
      "Slow source: http://127.0.0.1:65170/slow-fixture",
      "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available and explain how the mission can continue.",
      "A follow-up may ask you to resume that same source-check context after the initial closeout.",
    ].join("\n");
    const natural = JSON.parse(readFileSync(path.join(dir, "turnkeyai-natural.json"), "utf8")) as {
      scenarios: Array<Record<string, unknown>>;
    };
    natural.scenarios[0] = {
      ...(natural.scenarios[0] ?? {}),
      scenario: "natural-timeout-followup-continuation",
      prompt,
      missionId: "msn.turnkey.timeout-followup",
      durationMs: 70_000,
      status: "done",
      metrics: {
        tools: {
          requested: 3,
          results: 3,
          failed: 1,
          cancelled: 0,
          timeouts: 1,
          names: ["sessions_list", "sessions_send", "sessions_spawn"],
        },
        sessions: { spawned: 1, continued: 1 },
        browser: { profileFallbacks: 0, failureBuckets: [] },
        approvals: { requested: 0, decided: 0, applied: 0 },
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
          "Verified timeout evidence: the slow source did not return content during bounded attempts. Continue by retrying the same source when it is expected to respond.",
      },
    };
    writeFileSync(path.join(dir, "turnkeyai-natural.json"), JSON.stringify(natural));

    const finalText =
      "Release-risk note: verified timeout evidence from two bounded attempts. Content, headers, and status remain unverified; continue by resuming the same source-check context.";
    const toolCall = {
      id: "call-fetch",
      name: "web_fetch",
      arguments: { timeout_seconds: 10, urls: ["http://127.0.0.1:65170/slow-fixture"] },
    };
    const toolResult = {
      role: "tool",
      name: "web_fetch",
      toolCallId: "call-fetch",
      content:
        "Error: Failed: http://127.0.0.1:65170/slow-fixture\n\nError: [network_error] Direct fetch failed: The operation was aborted due to timeout",
      metadata: { isError: true },
    };
    const secondToolCall = { ...toolCall, id: "call-fetch-2" };
    const secondToolResult = { ...toolResult, toolCallId: "call-fetch-2" };
    const transcript = [
      { role: "user", content: prompt },
      { role: "assistant", messageType: "tool_call", toolCalls: [toolCall] },
      toolResult,
      { role: "assistant", content: "Source check closeout: timeout evidence observed; this can be resumed." },
      { role: "user", content: "Continue from the bounded timeout closeout in this mission." },
      { role: "assistant", messageType: "tool_call", toolCalls: [secondToolCall] },
      secondToolResult,
      { role: "assistant", content: finalText },
    ];
    const referencePath = path.join(dir, "reference-timeout.json");
    const reference = {
      system: "reference",
      prompt,
      threadId: "CID-reference-timeout-followup",
      durationMs: 49_000,
      timedOut: false,
      provenance: {
        ...buildReferenceProvenance(prompt),
        referenceScenarioDriver: {
          kind: "timeout_followup",
          supported: true,
          missionThread: true,
          missionMode: "research",
        },
        exactRequestPayload: { transport: "accio-work-websocket-sendQuery", prompt },
        rawResponse: { finalText },
        rawTranscript: transcript,
        rawToolCalls: [toolCall, secondToolCall],
        rawToolResults: [toolResult, secondToolResult],
        rawBrowserEvidence: [],
      },
      rawResponse: { finalText },
      rawTranscript: transcript,
      rawToolCalls: [toolCall, secondToolCall],
      rawToolResults: [toolResult, secondToolResult],
      rawBrowserEvidence: [],
      first: {
        summary: {
          toolCallCount: 1,
          toolResultCount: 1,
          pendingToolCount: 0,
          finalText: "Source check closeout: timeout evidence observed; this can be resumed.",
        },
      },
      followup: { summary: { toolCallCount: 1, toolResultCount: 1, pendingToolCount: 0, finalText } },
      score: { useful: true, weak: false },
    };
    writeFileSync(referencePath, JSON.stringify(reference));

    const report = buildRealLlmAbAcceptanceReport(
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
            referenceArtifactPath: "reference-timeout.json",
          },
        ],
      },
      { specDir: dir }
    );

    assert.equal(report.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(report.scenarios[0]?.referenceAudit?.runtimeHealthStatus, "passed");
    assert.equal(report.scenarios[0]?.reference.timeout.timedOut, true);
    assert.equal(report.scenarios[0]?.reference.timeout.partialCloseout, true);
    assert.equal(
      report.scenarios[0]?.referenceAudit?.findings.some((finding) =>
        finding.includes("reference localhost source access failed")
      ),
      false
    );
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
        missionId: "msn.reference.timeout-partial",
        exactRequestPayload: { transport: "accio-work-websocket-sendQuery", title: prompt, desc: "", mode: "research" },
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

    reference.rawTranscript = [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-web-fetch", name: "web_fetch", arguments: { urls: ["http://127.0.0.1:65170/slow-fixture"] } },
          { id: "call-bash", name: "bash", arguments: { command: "curl --max-time 8 http://127.0.0.1:65170/slow-fixture" } },
        ],
      },
      {
        role: "tool",
        name: "web_fetch",
        toolCallId: "call-web-fetch",
        content:
          "Error: [network_error] Network error while contacting YOU.COM API: WebSearch proxy requires auth token",
      },
    ];
    reference.provenance.rawTranscript = reference.rawTranscript;
    reference.rawToolCalls = [
      { id: "call-web-fetch", name: "web_fetch" },
      { id: "call-bash", name: "bash" },
    ];
    reference.provenance.rawToolCalls = reference.rawToolCalls;
    reference.rawToolResults = [
      {
        role: "tool",
        name: "web_fetch",
        toolCallId: "call-web-fetch",
        content:
          "Error: [network_error] Network error while contacting YOU.COM API: WebSearch proxy requires auth token",
      },
    ];
    reference.provenance.rawToolResults = reference.rawToolResults;
    reference.first.summary.toolCallCount = 2;
    reference.first.summary.toolResultCount = 1;
    reference.first.summary.pendingToolCount = 1;
    writeFileSync(referencePath, JSON.stringify(reference));

    const pendingToolTimeoutReport = buildRealLlmAbAcceptanceReport(
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
    assert.equal(pendingToolTimeoutReport.status, "passed", JSON.stringify(pendingToolTimeoutReport.scenarios[0], null, 2));
    assert.equal(pendingToolTimeoutReport.scenarios[0]?.comparisonClassification, "validated_comparison");
    assert.equal(pendingToolTimeoutReport.scenarios[0]?.reference.timeout?.hardAborted, true);
    assert.equal(pendingToolTimeoutReport.scenarios[0]?.referenceAudit?.adapterStatus, "passed");

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
    exactRequestPayload: { transport: "accio-work-websocket-sendQuery", content: prompt },
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
