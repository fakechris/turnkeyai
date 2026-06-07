import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildRealLlmAbFairnessHelpText,
  buildRealLlmAbFairnessReport,
  parseRealLlmAbFairnessArgs,
  runRealLlmAbFairnessCli,
} from "./real-llm-ab-fairness";

const PROMPT =
  "Review this browser fixture: http://127.0.0.1:55366/ops-dashboard. Summarize state, evidence, and next action.";

test("real LLM A/B fairness parses args and help", () => {
  assert.deepEqual(parseRealLlmAbFairnessArgs(["--spec", "/tmp/spec.json", "--out", "/tmp/fairness.json", "--check"]), {
    specPath: "/tmp/spec.json",
    outPath: "/tmp/fairness.json",
    check: true,
  });
  assert.deepEqual(parseRealLlmAbFairnessArgs(["--help"]), { help: true });
  assert.match(buildRealLlmAbFairnessHelpText(), /same-scenario fairness gate/);
  assert.throws(() => parseRealLlmAbFairnessArgs(["--spec", "/tmp/spec.json"]), /missing required --out/);
  assert.throws(() => parseRealLlmAbFairnessArgs(["--spec", "/tmp/spec.json", "--out"]), /missing value for --out/);
});

test("real LLM A/B fairness passes when prompt, fixture, model, browser, and scoring evidence match", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-fairness-"));
  try {
    writeFixture(dir);
    const report = buildRealLlmAbFairnessReport({ specPath: path.join(dir, "spec.json"), generatedAtMs: 1 });

    assert.equal(report.status, "passed");
    assert.equal(report.passedScenarios, 1);
    assert.equal(report.scenarios[0]?.checks.promptComparable, "passed");
    assert.equal(report.scenarios[0]?.checks.fixturePathComparable, "passed");
    assert.equal(report.scenarios[0]?.checks.fixtureContentComparable, "passed");
    assert.equal(report.scenarios[0]?.checks.modelComparable, "passed");
    assert.equal(report.scenarios[0]?.checks.browserAccessComparable, "passed");
    assert.equal(report.scenarios[0]?.checks.scoringRulesComparable, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B fairness fails when exact request payload used a different prompt", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-fairness-"));
  try {
    writeFixture(dir, {
      referencePatch: {
        provenance: {
          exactRequestPayload: {
            content: "Review this browser fixture: http://127.0.0.1:55366/other-page. Summarize state.",
          },
        },
      },
    });
    const report = buildRealLlmAbFairnessReport({ specPath: path.join(dir, "spec.json"), generatedAtMs: 1 });

    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.checks.promptComparable, "failed");
    assert.match(report.scenarios[0]?.findings.join("\n") ?? "", /same natural prompt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B fairness requires loopback fixture content provenance", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-fairness-"));
  try {
    writeFixture(dir, {
      naturalPatch: {
        scenarios: [
          {
            artifacts: {
              count: 1,
              kinds: ["snapshot"],
              fixtureContentHash: undefined,
            },
          },
        ],
      },
    });
    const report = buildRealLlmAbFairnessReport({ specPath: path.join(dir, "spec.json"), generatedAtMs: 1 });

    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.checks.fixtureContentComparable, "failed");
    assert.match(report.scenarios[0]?.findings.join("\n") ?? "", /content hash/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B fairness reads fixture hash maps and ignores escaped/truncated URL noise", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-fairness-"));
  try {
    writeFixture(dir, {
      naturalPatch: {
        fixtureContentHashes: {
          "http://<loopback-host>:<loopback-port>/ops-dashboard": "sha256:fixture",
        },
        scenarios: [
          {
            artifacts: {
              count: 1,
              kinds: ["snapshot"],
            },
          },
        ],
      },
      referencePatch: {
        provenance: {
          rawBrowserEvidence: [
            {
              history: [
                {
                  input: {
                    instructions:
                      "Review http://127.0.0.1:7788/ops-dashboard\\nThe rendered dashboard has loaded. " +
                      "A truncated excerpt also mentioned http://127.0.0.1:7788/ops-dash…",
                  },
                  rendered: true,
                  fixtureContentHashes: {
                    "http://<loopback-host>:<loopback-port>/ops-dashboard": "sha256:fixture",
                  },
                },
              ],
            },
          ],
        },
      },
    });
    const report = buildRealLlmAbFairnessReport({ specPath: path.join(dir, "spec.json"), generatedAtMs: 1 });

    assert.equal(report.status, "passed");
    assert.equal(report.scenarios[0]?.checks.fixturePathComparable, "passed");
    assert.equal(report.scenarios[0]?.checks.fixtureContentComparable, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B fairness ignores markdown punctuation after evidence URLs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-fairness-"));
  try {
    writeFixture(dir, {
      naturalPatch: {
        fixtureContentHashes: {
          "http://<loopback-host>:<loopback-port>/ops-dashboard": "sha256:fixture",
        },
        scenarios: [
          {
            artifacts: {
              count: 1,
              kinds: ["snapshot"],
            },
          },
        ],
      },
      referencePatch: {
        provenance: {
          rawBrowserEvidence: [
            {
              rendered: true,
              evidenceText: [
                "Source URL: `http://127.0.0.1:7788/ops-dashboard`",
                "Final URL: http://127.0.0.1:7788/ops-dashboard.",
              ],
              fixtureContentHashes: {
                "http://<loopback-host>:<loopback-port>/ops-dashboard": "sha256:fixture",
              },
            },
          ],
        },
      },
    });
    const report = buildRealLlmAbFairnessReport({ specPath: path.join(dir, "spec.json"), generatedAtMs: 1 });

    assert.equal(report.status, "passed");
    assert.equal(report.scenarios[0]?.checks.fixturePathComparable, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B fairness requires model comparability or explicit model difference", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-fairness-"));
  try {
    writeFixture(dir, {
      naturalPatch: {
        provider: undefined,
        modelId: undefined,
      },
      specPatch: {
        scenarios: [
          {
            modelComparison: {
              referenceProvider: "minimax",
              referenceModelId: "MiniMax-Text-01",
              differenceNote: "Reference run intentionally uses a different provider while TurnkeyAI provider metadata is unavailable.",
            },
          },
        ],
      },
    });
    const report = buildRealLlmAbFairnessReport({ specPath: path.join(dir, "spec.json"), generatedAtMs: 1 });

    assert.equal(report.status, "passed");
    assert.equal(report.scenarios[0]?.checks.modelComparable, "passed");
    assert.equal(report.scenarios[0]?.modelComparison.differenceRecorded, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B fairness fails timeout, approval, and continuation gates when required evidence is absent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-fairness-"));
  try {
    writeFixture(dir, {
      specPatch: {
        scenarios: [
          {
            requiresApproval: true,
            requiresContinuation: true,
            requiresTimeoutCloseout: true,
            timeoutComparison: undefined,
          },
        ],
      },
      naturalPatch: {
        scenarios: [
          {
            metrics: {
              tools: { names: ["sessions_spawn"], timeouts: 0 },
              sessions: { continued: 0 },
              approvals: { requested: 0, decided: 0, applied: 0 },
            },
          },
        ],
      },
      referencePatch: {
        first: { summary: { toolCallCount: 1, toolResultCount: 1 } },
        followup: undefined,
        provenance: {
          rawToolCalls: [{ name: "sessions_spawn" }],
          rawToolResults: [{ ok: true }],
          timeout: undefined,
        },
      },
    });
    const report = buildRealLlmAbFairnessReport({ specPath: path.join(dir, "spec.json"), generatedAtMs: 1 });

    assert.equal(report.status, "failed");
    assert.equal(report.scenarios[0]?.checks.timeoutPolicyComparable, "failed");
    assert.equal(report.scenarios[0]?.checks.approvalHandlingComparable, "failed");
    assert.equal(report.scenarios[0]?.checks.continuationEntryComparable, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B fairness CLI writes output and fails check", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-ab-fairness-"));
  try {
    writeFixture(dir, {
      referencePatch: {
        provenance: {
          exactRequestPayload: {
            content: "Different prompt",
          },
        },
      },
    });
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    await runRealLlmAbFairnessCli(["--spec", path.join(dir, "spec.json"), "--out", path.join(dir, "fairness.json"), "--check"]);
    assert.equal(process.exitCode, 1);
    const report = JSON.parse(readFileSync(path.join(dir, "fairness.json"), "utf8")) as { status?: unknown };
    assert.equal(report.status, "failed");
    process.exitCode = priorExitCode;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFixture(
  dir: string,
  options: {
    specPatch?: Record<string, unknown>;
    naturalPatch?: Record<string, unknown>;
    referencePatch?: Record<string, unknown>;
  } = {}
): void {
  const natural = deepMerge(
    {
      kind: "turnkeyai.natural-mission-e2e.report",
      provider: "minimax",
      modelId: "MiniMax-Text-01",
      scenarios: [
        {
          scenario: "natural-browser-dynamic-page",
          prompt: PROMPT,
          metrics: {
            tools: { names: ["sessions_spawn"], timeouts: 0 },
            sessions: { continued: 0 },
            approvals: { requested: 0, decided: 0, applied: 0 },
          },
          artifacts: {
            count: 1,
            kinds: ["snapshot"],
            fixtureContentHash: "sha256:fixture",
          },
        },
      ],
    },
    options.naturalPatch ?? {}
  );
  const reference = deepMerge(
    {
      prompt: PROMPT,
      provenance: {
        provider: "minimax",
        modelId: "MiniMax-Text-01",
        exactRequestPayload: { content: PROMPT },
        rawBrowserEvidence: [
          {
            url: "http://localhost:7788/ops-dashboard",
            rendered: true,
            fixtureContentHash: "sha256:fixture",
          },
        ],
        rawToolCalls: [{ name: "browser.open" }],
        rawToolResults: [{ ok: true, url: "http://localhost:7788/ops-dashboard" }],
      },
      first: { summary: { toolCallCount: 1, toolResultCount: 1 } },
    },
    options.referencePatch ?? {}
  );
  const spec = deepMerge(
    {
      kind: "turnkeyai.real-llm-ab-build.spec",
      turnkeyaiNaturalReportPath: "natural.json",
      scenarios: [
        {
          scenarioId: "natural-browser-dynamic-page",
          turnkeyaiScenarioId: "natural-browser-dynamic-page",
          prompt: PROMPT,
          promptPolicy: {
            naturalPrompt: true,
            noForcedToolCall: true,
            noFixedMarkerGate: true,
            noExactAnswerShape: true,
          },
          requiresBrowser: true,
          referenceArtifactPath: "reference.json",
        },
      ],
    },
    options.specPatch ?? {}
  );
  writeFileSync(path.join(dir, "natural.json"), `${JSON.stringify(natural, null, 2)}\n`);
  writeFileSync(path.join(dir, "reference.json"), `${JSON.stringify(reference, null, 2)}\n`);
  writeFileSync(path.join(dir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
}

function deepMerge<T>(base: T, patch: Record<string, unknown>): T {
  if (Array.isArray(base)) {
    if (!Array.isArray(patch)) return (patch as T) ?? base;
    return patch.map((value, index) => {
      const existing = base[index];
      if (
        typeof existing === "object" &&
        existing !== null &&
        !Array.isArray(existing) &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        return deepMerge(existing, value as Record<string, unknown>);
      }
      return value;
    }) as T;
  }
  if (typeof base !== "object" || base === null) return (patch as T) ?? base;
  const output: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete output[key];
      continue;
    }
    const existing = output[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      output[key] = deepMerge(existing, value as unknown as Record<string, unknown>);
    } else if (
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      output[key] = deepMerge(existing, value as Record<string, unknown>);
    } else {
      output[key] = value;
    }
  }
  return output as T;
}
