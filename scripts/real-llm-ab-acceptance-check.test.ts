import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildRealLlmAbAcceptanceCheckHelpText,
  parseRealLlmAbAcceptanceCheckArgs,
  runRealLlmAbAcceptanceCheckCli,
} from "./real-llm-ab-acceptance-check";

test("real LLM A/B acceptance check parses the JSON path", () => {
  assert.deepEqual(parseRealLlmAbAcceptanceCheckArgs(["--json", "/tmp/ab-report.json"]), {
    jsonPath: "/tmp/ab-report.json",
  });
  assert.deepEqual(parseRealLlmAbAcceptanceCheckArgs(["--json", "/tmp/ab-report.json", "--suite", "core"]), {
    jsonPath: "/tmp/ab-report.json",
    requiredSuite: "core",
  });
  assert.deepEqual(parseRealLlmAbAcceptanceCheckArgs(["--json", "/tmp/ab-report.json", "--markdown-out", "/tmp/report.md"]), {
    jsonPath: "/tmp/ab-report.json",
    markdownOutPath: "/tmp/report.md",
  });
});

test("real LLM A/B acceptance check exposes help", () => {
  assert.deepEqual(parseRealLlmAbAcceptanceCheckArgs(["--help"]), { help: true });
  assert.match(buildRealLlmAbAcceptanceCheckHelpText(), /real LLM A\/B acceptance report check/);
  assert.match(buildRealLlmAbAcceptanceCheckHelpText(), /natural same-scenario/);
  assert.match(buildRealLlmAbAcceptanceCheckHelpText(), /--suite core/);
  assert.match(buildRealLlmAbAcceptanceCheckHelpText(), /--markdown-out/);
});

test("real LLM A/B acceptance check rejects missing or unknown args", () => {
  assert.throws(() => parseRealLlmAbAcceptanceCheckArgs([]), /missing required --json/);
  assert.throws(() => parseRealLlmAbAcceptanceCheckArgs(["--json"]), /missing value for --json/);
  assert.throws(() => parseRealLlmAbAcceptanceCheckArgs(["--json", "/tmp/ab-report.json", "--suite", "focused"]), /--suite must be core/);
  assert.throws(() => parseRealLlmAbAcceptanceCheckArgs(["--json", "/tmp/ab-report.json", "--markdown-out"]), /missing value for --markdown-out/);
  assert.throws(() => parseRealLlmAbAcceptanceCheckArgs(["--unknown"]), /unknown argument/);
});

test("real LLM A/B acceptance check writes conclusion-first markdown reports", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-check-"));
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const jsonPath = path.join(dir, "ab.json");
    const markdownPath = path.join(dir, "report.md");
    writeFileSync(jsonPath, JSON.stringify(buildFailingReport(), null, 2));

    await runRealLlmAbAcceptanceCheckCli(["--json", jsonPath, "--markdown-out", markdownPath]);

    const markdown = readFileSync(markdownPath, "utf8");
    assert.equal(process.exitCode, 1);
    assert.match(markdown, /^# Real LLM A\/B Acceptance Report/m);
    assert.match(markdown, /## Conclusion/);
    assert.match(markdown, /Capability: unproven/);
    assert.match(markdown, /Root-cause review required: 1/);
    assert.match(markdown, /browser-dynamic-page: delta -2/);
    assert.match(markdown, /\| browser-dynamic-page \| 16 \| 18 \| -2 \| yes \|/);
    assert.match(markdown, /Root-Cause Buckets/);
    assert.match(markdown, /browser_reliability/);
    assert.match(markdown, /Next Root-Cause PRs/);
  } finally {
    process.exitCode = previousExitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});

function buildFailingReport(): unknown {
  const prompt = "请打开这个动态页面，理解当前状态，找出应该关注的异常和下一步动作，并给出依据。";
  return {
    kind: "turnkeyai.real-llm-ab-acceptance.report",
    status: "failed",
    capabilityClaim: "unproven",
    stabilityClaim: "unstable",
    scenarios: [
      {
        scenarioId: "browser-dynamic-page",
        prompt,
        promptPolicy: {
          naturalPrompt: true,
          noForcedToolCall: true,
          noFixedMarkerGate: true,
          noExactAnswerShape: true,
        },
        requiresBrowser: true,
        turnkeyai: {
          system: "turnkeyai",
          prompt,
          artifactPath: "artifacts/evals/run/turnkeyai/browser.json",
          missionId: "msn.local.1",
          completed: true,
          stuckOrLoop: false,
          finalAnswerUseful: true,
          finalAnswerHasEvidence: true,
          browserEvidence: { required: true, used: false, rendered: false, screenshotCount: 0, snapshotCount: 0 },
          dimensionScores: {
            taskCompletion: 2,
            evidenceQuality: 2,
            toolUseAppropriateness: 2,
            browserAuthenticity: 0,
            subAgentIndependence: 2,
            continuationBehavior: 2,
            permissionCorrectness: 2,
            timeoutCloseoutQuality: 2,
            finalAnswerUsefulness: 2,
          },
        },
        reference: {
          system: "reference",
          prompt,
          artifactPath: "artifacts/evals/run/reference/browser.json",
          completed: true,
          stuckOrLoop: false,
          finalAnswerUseful: true,
          finalAnswerHasEvidence: true,
          browserEvidence: { required: true, used: true, rendered: true, screenshotCount: 1, snapshotCount: 1 },
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
        },
      },
    ],
  };
}
