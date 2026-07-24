import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildRealLlmAbReferenceCollectHelpText,
  collectReferenceRuntimeWorkspaceArtifacts,
  collectReferenceArtifacts,
  parseRealLlmAbReferenceCollectArgs,
  readReferenceCompletion,
  referenceScenarioDriverFor,
} from "./real-llm-ab-reference-collect";

test("real LLM A/B reference collector parses args and help", () => {
  assert.deepEqual(
    parseRealLlmAbReferenceCollectArgs([
      "--tasks",
      "/tmp/tasks.json",
      "--base-url",
      "http://127.0.0.1:4100",
      "--reference-token",
      "secret-reference-token",
      "--variant",
      "analyst",
      "--timeout-ms",
      "1000",
      "--poll-ms",
      "50",
      "--reference-app",
      "reference-workbench-fixture",
      "--reference-repo-path",
      "/tmp/reference",
      "--reference-runtime-root",
      "/tmp/reference-runtime",
      "--reference-version",
      "test",
      "--reference-commit",
      "0000000",
      "--check",
    ]),
    {
      tasksPath: "/tmp/tasks.json",
      baseUrl: "http://127.0.0.1:4100",
      referenceToken: "secret-reference-token",
      variant: "analyst",
      timeoutMs: 1000,
      pollMs: 50,
      referenceApp: "reference-workbench-fixture",
      referenceRepoPath: "/tmp/reference",
      referenceRuntimeRoot: "/tmp/reference-runtime",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    }
  );
  assert.deepEqual(parseRealLlmAbReferenceCollectArgs(["--help"]), { help: true });
  assert.match(buildRealLlmAbReferenceCollectHelpText(), /reference artifact collector/);
  assert.throws(
    () => parseRealLlmAbReferenceCollectArgs(["--tasks", "/tmp/tasks.json", "--base-url", "http://x", "--poll-ms", "0"]),
    /--poll-ms must be a positive integer/
  );
});

test("real LLM A/B reference collector parses reference desktop runtime websocket mode", () => {
  const parsed = parseRealLlmAbReferenceCollectArgs([
    "--tasks",
    "/tmp/tasks.json",
    "--base-url",
    "http://127.0.0.1:4097",
    "--reference-ws",
    "--reference-agent-id",
    "DID-F456DA-2B0D4C",
    "--reference-workspace-path",
    "/Users/chris/workspace/turnkeyai",
  ]);
  assert.deepEqual(
    {
      ...parsed,
      ...(typeof parsed === "object" && !("help" in parsed) ? { referenceCommit: undefined } : {}),
    },
    {
      tasksPath: "/tmp/tasks.json",
      baseUrl: "http://127.0.0.1:4097",
      variant: "operator",
      referenceRuntimeWs: true,
      referenceRuntimeAgentId: "DID-F456DA-2B0D4C",
      referenceRuntimeWorkspacePath: "/Users/chris/workspace/turnkeyai",
      timeoutMs: 180_000,
      pollMs: 2_000,
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
      "help" in parsed ? "" : (parsed.referenceCommit ?? ""),
      /^app\.asar:[a-f0-9]{64}$/
    );
  }
  assert.match(buildRealLlmAbReferenceCollectHelpText(), /--reference-ws/);
});

test("real LLM A/B reference collector treats ReferenceRuntime pending approval final as ready only for pending policy", () => {
  const finalText = [
    "**Approval Form Snapshot**",
    "Status: Dry-run has not been submitted.",
    "**Pending Action - Awaiting Your Decision**",
    "Before I proceed, I need explicit authorization for the dry-run form submission.",
    "Please confirm or deny. If approved, I will proceed. If denied, I will take no action.",
  ].join("\n");
  const messages = [
    {
      role: "tool",
      content:
        'task_id: browser-form-inspection status: completed tool_chain: browser <task_result>URL: http://127.0.0.1:53969/approval-form. Status: "Dry-run has not been submitted."</task_result>',
      name: "sessions_spawn",
      toolCallId: "call-browser-1",
      messageType: "tool_result",
    },
    {
      role: "assistant",
      content: finalText,
      messageType: "normal",
    },
  ];

  assert.deepEqual(readReferenceCompletion(messages), {
    finalText,
    ready: false,
  });
  assert.deepEqual(readReferenceCompletion(messages, { approvalDecisionPolicy: "pending" }), {
    finalText,
    ready: true,
  });
});

test("real LLM A/B reference collector records orphaned ReferenceRuntime workspace artifacts after prompt send", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-workspace-"));
  try {
    const stalePath = path.join(dir, "old-dashboard.png");
    const screenshotPath = path.join(dir, "ops-dashboard-1.png");
    const nestedDir = path.join(dir, "notes");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(stalePath, "old screenshot");
    const oldDate = new Date(Date.now() - 10_000);
    utimesSync(stalePath, oldDate, oldDate);
    const sinceMs = Date.now();
    writeFileSync(screenshotPath, "new screenshot bytes");
    writeFileSync(path.join(nestedDir, "summary.md"), "new rendered dashboard summary");

    const artifacts = collectReferenceRuntimeWorkspaceArtifacts({
      workspacePath: dir,
      sinceMs,
      maxFiles: 10,
    }) as Array<{
      source?: string;
      status?: string;
      kind?: string;
      relativePath?: string;
      sha256?: string;
    }>;

    assert.deepEqual(
      artifacts.map((artifact) => artifact.relativePath).sort(),
      ["notes/summary.md", "ops-dashboard-1.png"]
    );
    const screenshot = artifacts.find((artifact) => artifact.relativePath === "ops-dashboard-1.png");
    const note = artifacts.find((artifact) => artifact.relativePath === "notes/summary.md");
    assert.equal(screenshot?.source, "reference_ws_workspace_artifact_after_prompt");
    assert.equal(screenshot?.status, "orphaned_workspace_artifact");
    assert.equal(screenshot?.kind, "screenshot");
    assert.match(screenshot?.sha256 ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.equal(note?.kind, "text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector marks ReferenceRuntime websocket cancellation scenarios as unsupported", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  try {
    const tasksPath = path.join(dir, "tasks.json");
    const activeArtifactPath = path.join(dir, "reference", "natural-cancel-active-tool.json");
    const followupArtifactPath = path.join(dir, "reference", "natural-cancel-followup-continuation.json");
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "full-natural",
        taskCount: 2,
        tasks: [
          {
            scenarioId: "natural-cancel-active-tool",
            prompt: "Evaluate this slow source, then handle an operator cancellation while the source check is active.",
            expectedReferenceArtifactPath: activeArtifactPath,
            action: "collect_reference_artifact",
          },
          {
            scenarioId: "natural-cancel-followup-continuation",
            prompt: "Evaluate this source, handle cancellation, then resume the same context on follow-up.",
            expectedReferenceArtifactPath: followupArtifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl: "http://127.0.0.1:9",
      variant: "operator",
      timeoutMs: 1_000,
      pollMs: 10,
      referenceApp: "reference-desktop-app-asar",
      referenceBinary: "/Applications/ReferenceRuntime.app/Contents/Resources/app.asar",
      referenceRuntimeRoot: path.join(dir, "reference-desktop-0.4.5"),
      referenceVersion: "0.4.5",
      referenceCommit: "app.asar:test",
      referenceRuntimeWs: true,
      referenceRuntimeWorkspacePath: "/Users/chris/workspace/turnkeyai",
      check: true,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.failed, 2);
    const artifacts = [
      { path: activeArtifactPath, kind: "cancel_active" },
      { path: followupArtifactPath, kind: "cancel_followup" },
    ];
    for (const expected of artifacts) {
      const artifact = JSON.parse(readFileSync(expected.path, "utf8")) as {
        exitStatus?: string;
        errorReason?: string;
        provenance?: {
          apiEndpoint?: string;
          rawResponse?: unknown;
          referenceScenarioDriver?: { kind?: string; supported?: boolean; unsupportedReason?: string };
        };
        first?: { summary?: { toolCallCount?: number; toolResultCount?: number; finalText?: string } };
        score?: { useful?: boolean; weak?: boolean };
      };
      assert.equal(artifact.exitStatus, "error");
      assert.equal(
        artifact.errorReason,
        "unsupported_reference_scenario_driver:reference_ws_reference_does_not_expose_active_cancellation_driver"
      );
      assert.equal(artifact.provenance?.apiEndpoint, "not_run");
      assert.equal(artifact.provenance?.rawResponse, null);
      assert.equal(artifact.provenance?.referenceScenarioDriver?.kind, expected.kind);
      assert.equal(artifact.provenance?.referenceScenarioDriver?.supported, false);
      assert.equal(
        artifact.provenance?.referenceScenarioDriver?.unsupportedReason,
        "reference_ws_reference_does_not_expose_active_cancellation_driver"
      );
      assert.equal(artifact.first?.summary?.toolCallCount, 0);
      assert.equal(artifact.first?.summary?.toolResultCount, 0);
      assert.equal(artifact.first?.summary?.finalText, "");
      assert.equal(artifact.score?.useful, false);
      assert.equal(artifact.score?.weak, true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector fails fast when ReferenceRuntime websocket loopback fixtures are unreachable", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon();
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-long-delegation.json");
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "report-scenarios",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-long-delegation",
            prompt:
              "Prepare a product brief from http://127.0.0.1:1/product-orchestration and rendered browser evidence at http://127.0.0.1:1/product-signals.",
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 60_000,
      pollMs: 10,
      referenceApp: "reference-desktop-app-asar",
      referenceBinary: "/Applications/ReferenceRuntime.app/Contents/Resources/app.asar",
      referenceRuntimeRoot: path.join(dir, "reference-desktop-0.4.5"),
      referenceVersion: "0.4.5",
      referenceCommit: "app.asar:test",
      referenceRuntimeWs: true,
      referenceRuntimeAgentId: "DID-F456DA-2B0D4C",
      referenceRuntimeWorkspacePath: path.join(dir, "workspace"),
      check: true,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.failed, 1);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      exitStatus?: string;
      errorReason?: string;
      provenance?: {
        apiEndpoint?: string;
        exactRequestPayload?: {
          blockedBeforeSend?: boolean;
          loopbackFixtureProbe?: {
            checked?: string[];
            unreachable?: Array<{ url?: string; reason?: string }>;
          };
        };
        loopbackFixtureProbe?: {
          checked?: string[];
          unreachable?: Array<{ url?: string; reason?: string }>;
        };
      };
      first?: { summary?: { toolCallCount?: number; pendingToolCount?: number } };
    };
    assert.equal(artifact.exitStatus, "error");
    assert.match(artifact.errorReason ?? "", /^reference_fixture_unreachable:/);
    assert.equal(artifact.provenance?.apiEndpoint, "not_run");
    assert.equal(artifact.provenance?.exactRequestPayload?.blockedBeforeSend, true);
    assert.deepEqual(artifact.provenance?.loopbackFixtureProbe?.checked, [
      "http://127.0.0.1:1/product-orchestration",
      "http://127.0.0.1:1/product-signals",
    ]);
    assert.equal(artifact.provenance?.loopbackFixtureProbe?.unreachable?.length, 2);
    assert.equal(artifact.first?.summary?.toolCallCount, 0);
    assert.equal(artifact.first?.summary?.pendingToolCount, 0);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector allows intentional slow fixture timeout preflight", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const referenceRuntimeHome = path.join(dir, "referenceRuntime-home");
  const agentId = "DID-F456DA-2B0D4C";
  const accountId = "reference-account";
  const referenceServer = createMockReferenceRuntimeWsReferenceDaemon({
    referenceRuntimeHome,
    accountId,
    agentId,
  });
  const slowServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/slow-fixture") {
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  try {
    const baseUrl = await listen(referenceServer);
    const slowBaseUrl = await listen(slowServer);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-timeout-followup-continuation.json");
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "report-scenarios",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-timeout-followup-continuation",
            prompt: [
              "Evaluate this slow source for a release-risk note.",
              `Slow source: ${slowBaseUrl}/slow-fixture`,
              "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available and explain how the mission can continue.",
              "A follow-up may ask you to resume that same source-check context after the initial closeout.",
            ].join("\n"),
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-desktop-app-asar",
      referenceBinary: "/Applications/ReferenceRuntime.app/Contents/Resources/app.asar",
      referenceRuntimeRoot: path.join(dir, "reference-desktop-0.4.5"),
      referenceVersion: "0.4.5",
      referenceCommit: "app.asar:test",
      referenceRuntimeWs: true,
      referenceRuntimeAgentId: agentId,
      referenceRuntimeWorkspacePath: path.join(dir, "workspace"),
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      exitStatus?: string;
      errorReason?: string;
      provenance?: {
        apiEndpoint?: string;
        exactRequestPayload?: {
          blockedBeforeSend?: boolean;
          loopbackFixtureProbe?: {
            checked?: string[];
            reachable?: string[];
            unreachable?: Array<{ url?: string; reason?: string }>;
          };
        };
        loopbackFixtureProbe?: {
          checked?: string[];
          reachable?: string[];
          unreachable?: Array<{ url?: string; reason?: string }>;
        };
      };
    };

    assert.equal(report.status, "passed");
    assert.equal(artifact.exitStatus, "success");
    assert.equal(artifact.errorReason, "none");
    assert.equal(artifact.provenance?.apiEndpoint, "/websocket/connect");
    assert.equal(artifact.provenance?.exactRequestPayload?.blockedBeforeSend, undefined);
    assert.deepEqual(artifact.provenance?.loopbackFixtureProbe?.checked, [`${slowBaseUrl}/slow-fixture`]);
    assert.deepEqual(artifact.provenance?.loopbackFixtureProbe?.reachable, [`${slowBaseUrl}/slow-fixture`]);
    assert.deepEqual(artifact.provenance?.loopbackFixtureProbe?.unreachable, []);
  } finally {
    await close(referenceServer);
    await close(slowServer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference completion waits for pending ReferenceRuntime tool calls", () => {
  const messages: unknown[] = [
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "The direct fetch failed. Let me try via browser.",
        },
      ],
      toolCalls: [
        { id: "call-web-fetch", name: "web_fetch", arguments: { urls: ["http://127.0.0.1/source"] } },
        { id: "call-browser", name: "sessions_spawn", arguments: { agent_id: "browser" } },
      ],
    },
    {
      role: "tool",
      name: "web_fetch",
      toolCallId: "call-web-fetch",
      content: "Error: proxy requires auth token",
    },
  ];

  assert.deepEqual(readReferenceCompletion(messages), {
    finalText: "The direct fetch failed. Let me try via browser.",
    ready: false,
  });

  messages.push({
    role: "tool",
    name: "sessions_spawn",
    toolCallId: "call-browser",
    content: JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      status: "completed",
      agent_id: "browser",
      final_content: "Browser rendered the vendor page and extracted source evidence.",
    }),
  });

  assert.deepEqual(readReferenceCompletion(messages), {
    finalText: "The direct fetch failed. Let me try via browser.",
    ready: false,
  });

  messages.push({
    role: "assistant",
    content: "Recommendation: choose Vendor Alpha for stronger automation evidence; choose Vendor Beta only when budget is the overriding constraint.",
  });

  assert.deepEqual(readReferenceCompletion(messages), {
    finalText:
      "Recommendation: choose Vendor Alpha for stronger automation evidence; choose Vendor Beta only when budget is the overriding constraint.",
    ready: true,
  });
});

test("real LLM A/B ReferenceRuntime websocket collector keeps the desktop socket open after acceptance", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const referenceRuntimeHome = path.join(dir, "referenceRuntime-home");
  const agentId = "DID-F456DA-2B0D4C";
  const accountId = "reference-account";
  const server = createMockReferenceRuntimeWsReferenceDaemon({
    referenceRuntimeHome,
    accountId,
    agentId,
  });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-comparison-research.json");
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "core",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-comparison-research",
            prompt: "Compare the two provided source summaries and return an evidence-backed recommendation.",
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-desktop-app-asar",
      referenceBinary: "/Applications/ReferenceRuntime.app/Contents/Resources/app.asar",
      referenceRuntimeRoot: path.join(dir, "reference-desktop-0.4.5"),
      referenceVersion: "0.4.5",
      referenceCommit: "app.asar:test",
      referenceRuntimeWs: true,
      referenceRuntimeAgentId: agentId,
      referenceRuntimeWorkspacePath: path.join(dir, "workspace"),
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      exitStatus?: string;
      provenance?: {
        rawResponse?: {
          keptOpenAfterAccept?: boolean;
          messageCount?: number;
          messages?: Array<{ method?: string; payload?: { conversationId?: string } }>;
        };
      };
      first?: { summary?: { finalText?: string } };
    };

    assert.equal(report.status, "passed");
    assert.equal(artifact.exitStatus, "success");
    assert.equal(artifact.provenance?.rawResponse?.keptOpenAfterAccept, true);
    assert.ok((artifact.provenance?.rawResponse?.messageCount ?? 0) >= 2);
    assert.ok(
      artifact.provenance?.rawResponse?.messages?.some(
        (message) =>
          message.method === "permission.query" &&
          message.payload?.conversationId === artifact.provenance?.rawResponse?.messages?.[0]?.payload?.conversationId
      ),
      "expected the post-accept permission.query event to be preserved in rawResponse.messages"
    );
    assert.match(artifact.first?.summary?.finalText ?? "", /Reference final answer/);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference completion rejects no-evidence closeouts as weak", () => {
  const finalText =
    "Unable to Collect Evidence. What was verified: nothing was verified. I cannot make a recommendation based on evidence I did not collect.";

  assert.deepEqual(readReferenceCompletion([{ role: "assistant", content: finalText }]), {
    finalText,
    ready: false,
  });
});

test("real LLM A/B reference completion does not match later same-name tool calls by name when ids differ", () => {
  const messages: unknown[] = [
    {
      role: "assistant",
      content: "I will inspect the first source.",
      toolCalls: [
        {
          id: "call-browser-1",
          name: "sessions_spawn",
          arguments: { agent_id: "browser", task: "inspect first source" },
        },
      ],
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
      toolCalls: [
        {
          id: "call-browser-2",
          name: "sessions_spawn",
          arguments: { agent_id: "browser", task: "inspect second source" },
        },
      ],
    },
  ];

  assert.deepEqual(readReferenceCompletion(messages), {
    finalText: "The first source worked. I will inspect the second source now.",
    ready: false,
  });
});

test("real LLM A/B reference collector sends daemon bearer token when configured", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon({ authToken: "secret-reference-token" });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-comparison-research.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "core",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-comparison-research",
            prompt:
              "Compare Vendor Alpha at http://127.0.0.1:55366/vendor-alpha and Vendor Beta at http://127.0.0.1:55366/vendor-beta from the provided sources.",
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      referenceToken: "secret-reference-token",
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      exitStatus?: string;
      provenance?: { rawBrowserEvidence?: unknown[] };
    };

    assert.equal(report.status, "passed");
    assert.equal(report.collected, 1);
    assert.equal(artifact.exitStatus, "success");
    assert.equal(artifact.provenance?.rawBrowserEvidence?.length, 2);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector uses mission-linked submission for approval scenarios", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon();
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-approval-dry-run-action.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "core",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-approval-dry-run-action",
            prompt: "Open the local approval form and carry a safe dry-run through the approval gate.",
            expectedReferenceArtifactPath: artifactPath,
            action: "recollect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      prompt?: string;
      threadId?: string;
      missionId?: string;
      provenance?: {
        apiEndpoint?: string;
        missionId?: string;
        rawApprovalEvidence?: Array<{ source?: string; approvalId?: string }>;
        exactRequestPayload?: { title?: string; mode?: string; owner?: string };
      };
      rawApprovalEvidence?: Array<{ source?: string; approvalId?: string }>;
      first?: { summary?: { finalText?: string } };
    };

    assert.equal(report.status, "passed");
    assert.equal(artifact.threadId, "THREAD-reference-mission-1");
    assert.equal(artifact.missionId, "msn.reference.1");
    assert.equal(artifact.provenance?.apiEndpoint, "/missions");
    assert.equal(artifact.provenance?.missionId, "msn.reference.1");
    assert.equal(artifact.provenance?.exactRequestPayload?.title, artifact.prompt);
    assert.equal(artifact.provenance?.exactRequestPayload?.mode, "browser");
    assert.equal(artifact.provenance?.exactRequestPayload?.owner, "reference-collector");
    assert.deepEqual(artifact.rawApprovalEvidence?.map((item) => item.approvalId), ["ap.reference.1"]);
    assert.equal(artifact.provenance?.rawApprovalEvidence?.[0]?.source, "approval_driver");
    assert.match(artifact.first?.summary?.finalText ?? "", /Approval was granted/);
    assert.doesNotMatch(artifact.first?.summary?.finalText ?? "", /waiting for the operator decision/i);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector applies scenario-specific approval decision policies", async () => {
  assert.equal(referenceScenarioDriverFor("natural-approval-dry-run-action").approvalDecisionPolicy, "approved");
  assert.equal(referenceScenarioDriverFor("natural-approval-denied-safe-closeout").approvalDecisionPolicy, "denied");
  assert.equal(referenceScenarioDriverFor("natural-approval-pending-state").approvalDecisionPolicy, "pending");
  assert.equal(referenceScenarioDriverFor("natural-approval-wait-timeout-closeout").approvalDecisionPolicy, "wait_timeout");
  assert.deepEqual(referenceScenarioDriverFor("natural-approval-wait-timeout-closeout").envRequirements, {
    TURNKEYAI_TOOL_PERMISSION_WAIT_MS: "2000",
  });
  assert.equal(referenceScenarioDriverFor("natural-tool-result-pruning").kind, "tool_result_pruning");
  assert.equal(referenceScenarioDriverFor("natural-tool-result-pruning").supported, true);
  assert.deepEqual(referenceScenarioDriverFor("natural-tool-result-pruning").envRequirements, {
    TURNKEYAI_TOOL_RESULT_RECENT_FULL_COUNT: "1",
    TURNKEYAI_TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES: "5000",
    TURNKEYAI_TOOL_RESULT_SOFT_PRUNE_MAX_BYTES: "1800",
    TURNKEYAI_TOOL_RESULT_HARD_PRUNE_MAX_BYTES: "12000",
  });
  assert.equal(referenceScenarioDriverFor("natural-followup-continuation").kind, "followup_thread");
  assert.equal(referenceScenarioDriverFor("natural-followup-continuation").supported, true);
  for (const scenarioId of [
    "natural-browser-followup-continuation",
    "natural-browser-restart-continuation",
    "natural-browser-cold-recreation-continuation",
  ]) {
    const driver = referenceScenarioDriverFor(scenarioId);
    assert.equal(driver.kind, "followup_thread");
    assert.equal(driver.supported, true);
    assert.equal(driver.missionMode, "browser");
  }
  assert.equal(referenceScenarioDriverFor("natural-timeout-followup-continuation").kind, "timeout_followup");
  assert.equal(referenceScenarioDriverFor("natural-timeout-followup-continuation").supported, true);
  assert.equal(referenceScenarioDriverFor("natural-cancel-active-tool").kind, "cancel_active");
  assert.equal(referenceScenarioDriverFor("natural-cancel-active-tool").supported, true);
});

test("real LLM A/B reference collector denies approval when the scenario requires denial", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon();
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-approval-denied-safe-closeout.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "full-natural",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-approval-denied-safe-closeout",
            prompt: "Open the local approval form and deny the safe dry-run request at the approval gate.",
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      rawApprovalEvidence?: Array<{ decisionPayload?: { decision?: string } }>;
      provenance?: { referenceScenarioDriver?: { approvalDecisionPolicy?: string } };
      first?: { summary?: { finalText?: string } };
    };

    assert.equal(report.status, "passed");
    assert.equal(artifact.provenance?.referenceScenarioDriver?.approvalDecisionPolicy, "denied");
    assert.equal(artifact.rawApprovalEvidence?.[0]?.decisionPayload?.decision, "denied");
    assert.match(artifact.first?.summary?.finalText ?? "", /Approval was denied/);
    assert.doesNotMatch(artifact.first?.summary?.finalText ?? "", /Approval was granted/);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector observes pending approval without posting a decision", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon({ pendingWithoutAssistantFinal: true });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-approval-pending-state.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "full-natural",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-approval-pending-state",
            prompt: "Open the local approval form and leave the approval request pending.",
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      exitStatus?: string;
      rawApprovalEvidence?: Array<{ status?: string; decisionPayload?: unknown }>;
      provenance?: { referenceScenarioDriver?: { approvalDecisionPolicy?: string } };
      first?: { summary?: { finalText?: string } };
      score?: { useful?: boolean; weak?: boolean };
    };

    assert.equal(report.status, "passed");
    assert.equal(artifact.exitStatus, "success");
    assert.equal(artifact.provenance?.referenceScenarioDriver?.approvalDecisionPolicy, "pending");
    assert.equal(artifact.rawApprovalEvidence?.[0]?.status, "observed_pending");
    assert.equal(artifact.rawApprovalEvidence?.[0]?.decisionPayload, undefined);
    assert.match(artifact.first?.summary?.finalText ?? "", /Requested approval for browser\.form\.submit/);
    assert.match(artifact.first?.summary?.finalText ?? "", /no permission_result, permission_applied, browser form submission/);
    assert.equal(artifact.score?.useful, true);
    assert.equal(artifact.score?.weak, false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector waits for approval wait-timeout closeout without posting a decision", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon({ approvalWaitTimeoutFinal: true });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-approval-wait-timeout-closeout.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "full-natural",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-approval-wait-timeout-closeout",
            prompt:
              "Open the local approval form and start a safe dry-run browser form submission attempt for operator review. If the operator decision does not arrive during this attempt, stop without submitting the form.",
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      exitStatus?: string;
      rawApprovalEvidence?: Array<{ status?: string; decisionPayload?: unknown }>;
      provenance?: { referenceScenarioDriver?: { approvalDecisionPolicy?: string; envRequirements?: Record<string, string> } };
      first?: { summary?: { finalText?: string } };
      score?: { useful?: boolean; weak?: boolean };
    };

    assert.equal(report.status, "passed");
    assert.equal(artifact.exitStatus, "success");
    assert.equal(artifact.provenance?.referenceScenarioDriver?.approvalDecisionPolicy, "wait_timeout");
    assert.equal(artifact.provenance?.referenceScenarioDriver?.envRequirements?.TURNKEYAI_TOOL_PERMISSION_WAIT_MS, "2000");
    assert.equal(artifact.rawApprovalEvidence?.[0]?.status, "observed_pending");
    assert.equal(artifact.rawApprovalEvidence?.[0]?.decisionPayload, undefined);
    assert.match(artifact.first?.summary?.finalText ?? "", /approval_wait_timeout/i);
    assert.match(artifact.first?.summary?.finalText ?? "", /no permission_result, permission_applied, browser form submission, or mutation/i);
    assert.equal(artifact.score?.useful, true);
    assert.equal(artifact.score?.weak, false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector drives memory recall setup and recall artifacts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const runtimeRoot = path.join(dir, "runtime");
  const server = createMockReferenceDaemon({ memoryRecallTranscript: true });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-memory-recall.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "full-natural",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-memory-recall",
            prompt: "Recover the Helios-47 launch context from durable memory.",
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceRuntimeRoot: runtimeRoot,
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      exitStatus?: string;
      timedOut?: boolean;
      rawToolCalls?: unknown[];
      rawToolResults?: unknown[];
      rawMemoryEvidence?: Array<{ phase?: string; memory?: { longTermNotes?: string[] } }>;
      provenance?: {
        apiEndpoint?: string;
        exactRequestPayload?: { prompt?: string; followup?: { content?: string } };
        referenceScenarioDriver?: {
          kind?: string;
          supported?: boolean;
        };
        rawMemoryEvidence?: Array<{ phase?: string; memory?: { longTermNotes?: string[] } }>;
      };
      first?: { summary?: { finalText?: string; toolCallCount?: number; toolResultCount?: number } };
      score?: { useful?: boolean; weak?: boolean };
    };

    assert.equal(report.status, "passed");
    assert.equal(artifact.exitStatus, "success");
    assert.equal(artifact.timedOut, false);
    assert.equal(artifact.provenance?.referenceScenarioDriver?.kind, "memory_thread");
    assert.equal(artifact.provenance?.referenceScenarioDriver?.supported, true);
    assert.match(artifact.provenance?.exactRequestPayload?.prompt ?? "", /Helios-47/);
    assert.equal(artifact.first?.summary?.toolCallCount, 2);
    assert.equal(artifact.first?.summary?.toolResultCount, 2);
    assert.match(artifact.first?.summary?.finalText ?? "", /Tuesday 09:30/);
    assert.match(artifact.first?.summary?.finalText ?? "", /Release Captain/);
    assert.equal(artifact.rawToolCalls?.length, 2);
    assert.equal(artifact.rawToolResults?.length, 2);
    assert.equal(
      artifact.rawMemoryEvidence?.some((item) =>
        item.memory?.longTermNotes?.some((note) => /Helios-47/.test(note) && /Tuesday 09:30/.test(note))
      ),
      true
    );
    assert.equal(artifact.score?.useful, true);
    assert.equal(artifact.score?.weak, false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector drives memory invalidation setup and recall artifacts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const runtimeRoot = path.join(dir, "runtime");
  const server = createMockReferenceDaemon({ memoryInvalidationTranscript: true });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-memory-invalidation.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "full-natural",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-memory-invalidation",
            prompt:
              "Continue from the corrected Borealis-23 launch context in this mission. Please use durable memory lookup for Borealis-23 and inspect any candidate memory entry before relying on it.",
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 1_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceRuntimeRoot: runtimeRoot,
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      exitStatus?: string;
      timedOut?: boolean;
      rawToolCalls?: unknown[];
      rawToolResults?: unknown[];
      rawMemoryEvidence?: Array<{ phase?: string; memory?: { constraints?: string[] } }>;
      provenance?: {
        exactRequestPayload?: { prompt?: string; correction?: { content?: string }; followup?: { content?: string } };
        rawMemoryEvidence?: Array<{ phase?: string; memory?: { constraints?: string[] } }>;
        referenceScenarioDriver?: { kind?: string };
      };
      first?: { summary?: { finalText?: string; toolCallCount?: number; toolResultCount?: number } };
      score?: { useful?: boolean; weak?: boolean };
    };

    assert.equal(report.status, "passed");
    assert.equal(artifact.exitStatus, "success");
    assert.equal(artifact.timedOut, false);
    assert.equal(artifact.provenance?.referenceScenarioDriver?.kind, "memory_invalidation");
    assert.match(artifact.provenance?.exactRequestPayload?.prompt ?? "", /Borealis-23/);
    assert.match(artifact.provenance?.exactRequestPayload?.correction?.content ?? "", /Thursday 16:45/);
    assert.match(artifact.provenance?.exactRequestPayload?.followup?.content ?? "", /Borealis-23/);
    assert.equal(artifact.first?.summary?.toolCallCount, 2);
    assert.equal(artifact.first?.summary?.toolResultCount, 2);
    assert.match(artifact.first?.summary?.finalText ?? "", /Thursday 16:45/);
    assert.match(artifact.first?.summary?.finalText ?? "", /Ops Captain/);
    assert.equal(artifact.rawToolCalls?.length, 2);
    assert.equal(artifact.rawToolResults?.length, 2);
    assert.equal(artifact.rawMemoryEvidence?.some((item) => item.phase === "stale_seed"), true);
    assert.equal(
      artifact.provenance?.rawMemoryEvidence?.some((item) =>
        item.memory?.constraints?.some((constraint) => /Monday 10:15/.test(constraint))
      ),
      true
    );
    assert.equal(artifact.score?.useful, true);
    assert.equal(artifact.score?.weak, false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector drives active mission cancellation artifacts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon({ activeCancellationTimeline: true });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-cancel-active-tool.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "full-natural",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-cancel-active-tool",
            prompt: "Evaluate this slow source. If the operator cancels the active source check, close out from cancellation evidence.",
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 500,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      exitStatus?: string;
      timedOut?: boolean;
      rawToolCalls?: unknown[];
      rawToolResults?: unknown[];
      rawCancellationEvidence?: Array<{ status?: string }>;
      provenance?: { rawCancellationEvidence?: Array<{ status?: string }>; referenceScenarioDriver?: { kind?: string } };
      first?: { summary?: { finalText?: string; toolCallCount?: number; toolResultCount?: number } };
      score?: { useful?: boolean; weak?: boolean };
    };

    assert.equal(report.status, "passed");
    assert.equal(artifact.exitStatus, "success");
    assert.equal(artifact.timedOut, false);
    assert.equal(artifact.provenance?.referenceScenarioDriver?.kind, "cancel_active");
    assert.equal(artifact.rawToolCalls?.length, 1);
    assert.equal(artifact.rawToolResults?.length, 1);
    assert.equal(artifact.first?.summary?.toolCallCount, 1);
    assert.equal(artifact.first?.summary?.toolResultCount, 1);
    assert.match(artifact.first?.summary?.finalText ?? "", /Mission cancelled by the operator/);
    assert.match(artifact.first?.summary?.finalText ?? "", /No source facts should be treated as verified/);
    assert.equal(artifact.provenance?.rawCancellationEvidence?.some((item) => item.status === "mission_cancelled"), true);
    assert.equal(artifact.score?.useful, true);
    assert.equal(artifact.score?.weak, false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector drives cancellation follow-up continuation artifacts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon({ activeCancellationTimeline: true, cancelFollowupTranscript: true });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-cancel-followup-continuation.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "full-natural",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-cancel-followup-continuation",
            prompt:
              "Evaluate this static text source. If the operator cancels the active source check, close out from cancellation evidence and allow a follow-up to resume.",
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 1_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      exitStatus?: string;
      timedOut?: boolean;
      rawToolCalls?: unknown[];
      rawToolResults?: unknown[];
      provenance?: {
        exactRequestPayload?: { followup?: { content?: string } };
        rawCancellationEvidence?: Array<{ status?: string }>;
        referenceScenarioDriver?: { kind?: string };
      };
      first?: { summary?: { finalText?: string; toolCallCount?: number; toolResultCount?: number } };
      followup?: { summary?: { finalText?: string; toolCallCount?: number; toolResultCount?: number } };
      score?: { useful?: boolean; weak?: boolean };
    };

    assert.equal(report.status, "passed");
    assert.equal(artifact.exitStatus, "success");
    assert.equal(artifact.timedOut, false);
    assert.equal(artifact.provenance?.referenceScenarioDriver?.kind, "cancel_followup");
    assert.equal(artifact.first?.summary?.toolCallCount, 1);
    assert.equal(artifact.first?.summary?.toolResultCount, 1);
    assert.match(artifact.first?.summary?.finalText ?? "", /Mission cancelled by the operator/);
    assert.equal(artifact.followup?.summary?.toolCallCount, 1);
    assert.equal(artifact.followup?.summary?.toolResultCount, 1);
    assert.match(artifact.followup?.summary?.finalText ?? "", /Release Captain/);
    assert.match(artifact.followup?.summary?.finalText ?? "", /rollback rehearsal/);
    assert.match(artifact.provenance?.exactRequestPayload?.followup?.content ?? "", /Continue from the cancelled source-check/);
    assert.equal(artifact.rawToolCalls?.length, 2);
    assert.equal(artifact.rawToolResults?.length, 2);
    assert.equal(artifact.provenance?.rawCancellationEvidence?.some((item) => item.status === "mission_cancelled"), true);
    assert.equal(artifact.score?.useful, true);
    assert.equal(artifact.score?.weak, false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector drives timeout follow-up continuation artifacts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon({ timeoutFollowupTranscript: true });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-timeout-followup-continuation.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "full-natural",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-timeout-followup-continuation",
            prompt:
              "Evaluate this slow source for a release-risk note.\nSlow source: http://127.0.0.1:65170/slow-fixture\nUse a bounded attempt first. If the source does not return in time, close out with the evidence that is available and explain how the mission can continue.\nA follow-up may ask you to resume that same source-check context after the initial closeout.",
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      exitStatus?: string;
      rawToolCalls?: unknown[];
      rawToolResults?: unknown[];
      provenance?: { exactRequestPayload?: { followup?: { content?: string } }; referenceScenarioDriver?: { kind?: string } };
      first?: { summary?: { finalText?: string; toolCallCount?: number; toolResultCount?: number } };
      followup?: { summary?: { finalText?: string; toolCallCount?: number; toolResultCount?: number } };
      score?: { useful?: boolean; weak?: boolean };
    };

    assert.equal(report.status, "passed");
    assert.equal(artifact.exitStatus, "success");
    assert.equal(artifact.provenance?.referenceScenarioDriver?.kind, "timeout_followup");
    assert.match(artifact.provenance?.exactRequestPayload?.followup?.content ?? "", /bounded timeout closeout/);
    assert.match(artifact.first?.summary?.finalText ?? "", /Bounded attempt evidence/);
    assert.equal(artifact.first?.summary?.toolCallCount, 1);
    assert.equal(artifact.first?.summary?.toolResultCount, 1);
    assert.match(artifact.followup?.summary?.finalText ?? "", /resumed source-check context/i);
    assert.equal(artifact.followup?.summary?.toolCallCount, 1);
    assert.equal(artifact.followup?.summary?.toolResultCount, 1);
    assert.equal(artifact.rawToolCalls?.length, 2);
    assert.equal(artifact.rawToolResults?.length, 2);
    assert.equal(artifact.score?.useful, true);
    assert.equal(artifact.score?.weak, false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector writes provenance-complete artifacts from a compatible daemon", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon();
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const naturalReportPath = path.join(dir, "natural.json");
    const artifactPath = path.join(dir, "reference", "natural-comparison-research.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      naturalReportPath,
      JSON.stringify({
        kind: "turnkeyai.natural-mission-e2e.report",
        fixtureContentHashes: {
          "http://<loopback-host>:<loopback-port>/vendor-alpha": "sha256:alpha",
          "http://<loopback-host>:<loopback-port>/vendor-beta": "sha256:beta",
        },
      })
    );
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "core",
        naturalReportPath,
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-comparison-research",
            prompt:
              "Compare Vendor Alpha at http://127.0.0.1:55366/vendor-alpha and Vendor Beta at http://127.0.0.1:55366/vendor-beta from the provided sources.",
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      prompt?: string;
      exitStatus?: string;
      provenance?: {
        exactRequestPayload?: { content?: string; threadId?: string };
        modelCatalog?: { models?: Array<{ providerId?: string; model?: string }> };
        provider?: string;
        modelId?: string;
        rawTranscript?: unknown;
        rawToolCalls?: unknown[];
        rawToolResults?: unknown[];
        rawBrowserEvidence?: unknown[];
        rawFlowEvidence?: unknown[];
        fixtureContentHashes?: Record<string, string>;
        timeout?: { timeoutMs?: number; pollMs?: number };
      };
      rawBrowserEvidence?: unknown[];
      rawFlowEvidence?: unknown[];
      first?: { summary?: { finalText?: string; toolCallCount?: number; toolResultCount?: number } };
      score?: { useful?: boolean; weak?: boolean };
    };

    assert.equal(report.status, "passed");
    assert.equal(report.collected, 1);
    assert.equal(artifact.exitStatus, "success");
    assert.equal(
      artifact.prompt,
      "Compare Vendor Alpha at http://127.0.0.1:55366/vendor-alpha and Vendor Beta at http://127.0.0.1:55366/vendor-beta from the provided sources."
    );
    assert.equal(artifact.provenance?.exactRequestPayload?.content, artifact.prompt);
    assert.equal(artifact.provenance?.exactRequestPayload?.threadId, "THREAD-reference-1");
    assert.equal(artifact.provenance?.provider, "fixture-provider");
    assert.equal(artifact.provenance?.modelId, "fixture-model");
    assert.equal(artifact.provenance?.modelCatalog?.models?.[0]?.providerId, "fixture-provider");
    assert.ok(artifact.provenance?.rawTranscript);
    assert.equal(artifact.provenance?.rawToolCalls?.length, 1);
    assert.equal(artifact.provenance?.rawToolResults?.length, 1);
    assert.equal(artifact.provenance?.rawFlowEvidence?.length, 3);
    assert.equal(
      artifact.provenance?.fixtureContentHashes?.["http://<loopback-host>:<loopback-port>/vendor-alpha"],
      "sha256:alpha"
    );
    assert.equal(
      artifact.provenance?.fixtureContentHashes?.["http://<loopback-host>:<loopback-port>/vendor-beta"],
      "sha256:beta"
    );
    assert.deepEqual(artifact.provenance?.timeout, { timeoutMs: 2_000, pollMs: 10 });
    assert.equal(artifact.rawBrowserEvidence?.length, 2);
    assert.equal(artifact.rawFlowEvidence?.length, 3);
    assert.match(artifact.first?.summary?.finalText ?? "", /Vendor Alpha/);
    assert.equal(artifact.first?.summary?.toolCallCount, 1);
    assert.equal(artifact.first?.summary?.toolResultCount, 1);
    assert.equal(artifact.score?.useful, true);
    assert.equal(artifact.score?.weak, false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector waits past delegation-only assistant text", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon({ delegationFirst: true });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-browser-dynamic-page.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "core",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-browser-dynamic-page",
            prompt: "Review the rendered dashboard at http://127.0.0.1:55366/ops-dashboard.",
            expectedReferenceArtifactPath: artifactPath,
            action: "recollect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      provenance?: { rawTranscript?: unknown[]; rawToolCalls?: unknown[]; rawToolResults?: unknown[] };
      first?: { summary?: { finalText?: string; toolCallCount?: number; toolResultCount?: number } };
      score?: { useful?: boolean; weak?: boolean };
    };

    assert.equal(report.status, "passed");
    assert.equal(artifact.provenance?.rawTranscript?.length, 3);
    assert.equal(artifact.provenance?.rawToolCalls?.length, 1);
    assert.equal(artifact.provenance?.rawToolResults?.length, 1);
    assert.match(artifact.first?.summary?.finalText ?? "", /Rendered dashboard shows active operations/i);
    assert.equal(artifact.first?.summary?.toolCallCount, 1);
    assert.equal(artifact.first?.summary?.toolResultCount, 1);
    assert.equal(artifact.score?.useful, true);
    assert.equal(artifact.score?.weak, false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector maps rendered browser evidence from session tool result transcript", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon({ emptyBrowserSessions: true, browserToolResultTranscript: true });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-browser-dynamic-page.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "core",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-browser-dynamic-page",
            prompt: "Review the rendered dashboard at http://127.0.0.1:55366/ops-dashboard.",
            expectedReferenceArtifactPath: artifactPath,
            action: "recollect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      rawBrowserEvidence?: Array<{ source?: string; rendered?: boolean; screenshotPaths?: string[]; evidenceText?: string[] }>;
    };

    assert.equal(report.status, "passed");
    assert.deepEqual(artifact.rawBrowserEvidence?.map((evidence) => evidence.source), [
      undefined,
      "session_tool_result",
    ]);
    assert.equal(artifact.rawBrowserEvidence?.[1]?.rendered, true);
    assert.deepEqual(artifact.rawBrowserEvidence?.[1]?.screenshotPaths, ["/tmp/reference-dashboard.png"]);
    assert.match(artifact.rawBrowserEvidence?.[1]?.evidenceText?.join("\n") ?? "", /Page title: Operations Dashboard Fixture/);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector maps ReferenceRuntime text browser session tool results as rendered evidence", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon({
    emptyBrowserSessions: true,
    referenceRuntimeTextBrowserToolResultTranscript: true,
  });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-approval-dry-run-action.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "core",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-approval-dry-run-action",
            prompt: "Use the local approval form at http://127.0.0.1:56174/approval-form.",
            expectedReferenceArtifactPath: artifactPath,
            action: "recollect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      rawBrowserEvidence?: Array<{ source?: string; rendered?: boolean; urls?: string[]; screenshotPaths?: string[]; evidenceText?: string[] }>;
    };
    const transcriptEvidence = artifact.rawBrowserEvidence?.find((evidence) => evidence.source === "session_tool_result");

    assert.equal(report.status, "passed");
    assert.equal(transcriptEvidence?.rendered, true);
    assert.deepEqual(transcriptEvidence?.screenshotPaths, ["https://sc02.alicdn.com/kf/reference-approval.png"]);
    assert.ok(transcriptEvidence?.urls?.includes("http://127.0.0.1:56174/approval-form"));
    assert.match(transcriptEvidence?.evidenceText?.join("\n") ?? "", /Page Title.+Approval gate fixture/);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector does not mark failed browser session tool results as rendered", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon({
    emptyBrowserSessions: true,
    failedBrowserToolResultTranscript: true,
  });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-browser-dynamic-page.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "core",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-browser-dynamic-page",
            prompt: "Review the rendered dashboard at http://127.0.0.1:55366/ops-dashboard.",
            expectedReferenceArtifactPath: artifactPath,
            action: "recollect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      rawBrowserEvidence?: Array<{ source?: string; rendered?: boolean; status?: string; evidenceText?: string[] }>;
    };
    const transcriptEvidence = artifact.rawBrowserEvidence?.find((evidence) => evidence.source === "session_tool_result");

    assert.equal(report.status, "passed");
    assert.equal(transcriptEvidence?.status, "failed");
    assert.equal(transcriptEvidence?.rendered, false);
    assert.match(transcriptEvidence?.evidenceText?.join("\n") ?? "", /browser sub-agent returned no executable result/);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector polls thread after message POST transport failure", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon({ failMessagePostAfterAccept: true });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-comparison-research.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "core",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-comparison-research",
            prompt: "Evaluate this slow source for a release-risk note.",
            expectedReferenceArtifactPath: artifactPath,
            action: "recollect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 2_000,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      exitStatus?: string;
      rawResponse?: { status?: string };
      first?: { summary?: { finalText?: string; toolCallCount?: number; toolResultCount?: number } };
    };

    assert.equal(report.status, "passed");
    assert.equal(artifact.exitStatus, "success");
    assert.equal(artifact.rawResponse?.status, "post_failed_polling_thread");
    assert.match(artifact.first?.summary?.finalText ?? "", /Vendor Alpha/);
    assert.equal(artifact.first?.summary?.toolCallCount, 1);
    assert.equal(artifact.first?.summary?.toolResultCount, 1);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector records timeout-partial native-work baseline loss artifacts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon({ timeoutPartialHangsAfterWorkerStart: true });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-timeout-partial-closeout.json");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    const prompt =
      "Evaluate this slow source for a release-risk note.\nSlow source: http://127.0.0.1:65170/slow-fixture\nUse a bounded attempt. If the source does not return in time, close out with available evidence.";
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "full-natural",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-timeout-partial-closeout",
            prompt,
            expectedReferenceArtifactPath: artifactPath,
            action: "recollect_reference_artifact",
          },
        ],
      })
    );

    const report = await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 80,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: false,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      timedOut?: boolean;
      exitStatus?: string;
      first?: { summary?: { finalText?: string; toolCallCount?: number; toolResultCount?: number } };
      provenance?: { apiEndpoint?: string; referenceScenarioDriver?: { kind?: string; supported?: boolean } };
      score?: { useful?: boolean; weak?: boolean };
    };

    assert.equal(report.status, "failed");
    assert.equal(artifact.exitStatus, "timeout");
    assert.equal(artifact.timedOut, true);
    assert.equal(artifact.provenance?.apiEndpoint, "/missions");
    assert.equal(artifact.provenance?.referenceScenarioDriver?.kind, "timeout_partial");
    assert.equal(artifact.provenance?.referenceScenarioDriver?.supported, true);
    assert.equal(artifact.first?.summary?.toolCallCount, 1);
    assert.equal(artifact.first?.summary?.toolResultCount, 0);
    assert.equal(artifact.first?.summary?.finalText, "");
    assert.equal(artifact.score?.useful, false);
    assert.equal(artifact.score?.weak, false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real LLM A/B reference collector records pending tool calls in artifact summaries", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-collect-"));
  const server = createMockReferenceDaemon({ pendingToolCallTranscript: true });
  try {
    const baseUrl = await listen(server);
    const tasksPath = path.join(dir, "tasks.json");
    const artifactPath = path.join(dir, "reference", "natural-pending-tool.json");
    writeFileSync(
      tasksPath,
      JSON.stringify({
        kind: "turnkeyai.real-llm-ab-reference-collection-tasks.manifest",
        suite: "report-scenarios",
        taskCount: 1,
        tasks: [
          {
            scenarioId: "natural-pending-tool",
            prompt: "Collect a source and do not finish until tools resolve.",
            expectedReferenceArtifactPath: artifactPath,
            action: "collect_reference_artifact",
          },
        ],
      })
    );

    await collectReferenceArtifacts({
      tasksPath,
      baseUrl,
      variant: "operator",
      timeoutMs: 50,
      pollMs: 10,
      referenceApp: "reference-workbench-fixture",
      referenceBinary: "/tmp/reference-daemon",
      referenceRepoPath: "/tmp/reference-workbench",
      referenceVersion: "test",
      referenceCommit: "0000000",
      check: true,
    });
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      first?: { summary?: { toolCallCount?: number; toolResultCount?: number; pendingToolCount?: number } };
    };

    assert.equal(artifact.first?.summary?.toolCallCount, 2);
    assert.equal(artifact.first?.summary?.toolResultCount, 1);
    assert.equal(artifact.first?.summary?.pendingToolCount, 1);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

function createMockReferenceDaemon(
  options: {
    delegationFirst?: boolean;
    authToken?: string;
    emptyBrowserSessions?: boolean;
    browserToolResultTranscript?: boolean;
    referenceRuntimeTextBrowserToolResultTranscript?: boolean;
    failedBrowserToolResultTranscript?: boolean;
    failMessagePostAfterAccept?: boolean;
    pendingWithoutAssistantFinal?: boolean;
    approvalWaitTimeoutFinal?: boolean;
    timeoutPartialHangsAfterWorkerStart?: boolean;
    pendingToolCallTranscript?: boolean;
    activeCancellationTimeline?: boolean;
    cancelFollowupTranscript?: boolean;
    timeoutFollowupTranscript?: boolean;
    memoryRecallTranscript?: boolean;
    memoryInvalidationTranscript?: boolean;
  } = {}
) {
  let messagePayload: { threadId?: string; content?: string } | null = null;
  let missionFollowupPayload: { content?: string } | null = null;
  let messagePollCount = 0;
  let missionApproval = false;
  let approvalDecisionPosted: string | null = null;
  let missionCancelled = false;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (options.authToken && req.headers.authorization !== `Bearer ${options.authToken}`) {
      res.statusCode = 401;
      return writeJson(res, { error: "unauthorized" });
    }
    if (req.method === "POST" && url.pathname === "/threads/bootstrap-demo") {
      return writeJson(res, { thread: { threadId: "THREAD-reference-1" } });
    }
    if (req.method === "POST" && url.pathname === "/missions") {
      const missionPayload = (await readJsonBody(req)) as { title?: string; mode?: string };
      messagePayload = { threadId: "THREAD-reference-mission-1", content: missionPayload.title ?? "" };
      messagePollCount = 0;
      missionApproval = /approval/i.test(missionPayload.title ?? "");
      approvalDecisionPosted = null;
      missionCancelled = false;
      missionFollowupPayload = null;
      return writeJson(res, {
        id: "msn.reference.1",
        title: missionPayload.title,
        mode: missionPayload.mode,
        status: "working",
        threadId: messagePayload.threadId,
      });
    }
    if (req.method === "POST" && url.pathname === "/missions/msn.reference.1/cancel") {
      missionCancelled = true;
      return writeJson(res, {
        cancelled: true,
        missionId: "msn.reference.1",
        threadId: "THREAD-reference-mission-1",
        roleRuns: { requested: 1, cancelled: 1 },
        toolCalls: { messages: 1, requested: 1, cancelled: 1 },
        workerSessions: { requested: 1, cancelled: 1 },
      });
    }
    if (req.method === "GET" && url.pathname === "/missions/msn.reference.1/timeline") {
      const toolCall = {
        id: "evt-call-reference-cancel",
        kind: "tool",
        text: "sessions_spawn call",
        tMs: 1,
        runtime: {
          messageId: "assistant-reference-cancel",
          toolCallId: "call-reference-cancel",
          toolName: "sessions_spawn",
          toolPhase: "call",
        },
      };
      const cancelled = {
        id: "mission-cancelled-msn.reference.1",
        kind: "recovery",
        text:
          "Mission cancelled by the operator. Active work was stopped before completion; verified evidence may be incomplete, unverified source checks remain, and the user can continue later if they want to resume.",
        tMs: 2,
        tags: ["mission_cancelled"],
        runtime: {
          eventType: "mission.cancelled",
          threadId: "THREAD-reference-mission-1",
          reason: "reference collector cancelled active source verification for same-scenario A/B",
        },
      };
      return writeJson(res, options.activeCancellationTimeline && missionCancelled ? [toolCall, cancelled] : [toolCall]);
    }
    if (req.method === "POST" && url.pathname === "/missions/msn.reference.1/messages") {
      missionFollowupPayload = (await readJsonBody(req)) as { content?: string };
      return writeJson(res, { accepted: true, missionId: "msn.reference.1" });
    }
    if (req.method === "GET" && url.pathname === "/approvals") {
      if (!missionApproval || approvalDecisionPosted) return writeJson(res, []);
      return writeJson(res, [
        {
          id: "ap.reference.1",
          missionId: "msn.reference.1",
          action: "browser.form.submit",
          decision: null,
          requestedAtMs: 1,
        },
      ]);
    }
    if (req.method === "POST" && /^\/approvals\/[^/]+\/decision$/.test(url.pathname)) {
      const decisionPayload = (await readJsonBody(req)) as { decision?: string; decidedBy?: string };
      approvalDecisionPosted = decisionPayload.decision ?? "unknown";
      return writeJson(res, {
        decision: {
          approvalId: "ap.reference.1",
          decision: approvalDecisionPosted,
          decidedBy: decisionPayload.decidedBy ?? "reference-collector",
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/models") {
      return writeJson(res, {
        models: [
          {
            id: "fixture-primary",
            providerId: "fixture-provider",
            model: "fixture-model",
            configured: true,
          },
        ],
      });
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      messagePayload = (await readJsonBody(req)) as { threadId?: string; content?: string };
      messagePollCount = 0;
      if (options.failMessagePostAfterAccept) {
        return res.destroy(new Error("simulated transport close after accept"));
      }
      return writeJson(res, { accepted: true, threadId: messagePayload.threadId });
    }
    if (req.method === "GET" && url.pathname === "/messages") {
      messagePollCount += 1;
      if (options.pendingToolCallTranscript) {
        return writeJson(res, [
          { role: "user", content: messagePayload?.content ?? "" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-resolved", name: "web_fetch" }],
          },
          { role: "tool", name: "web_fetch", toolCallId: "call-resolved", content: "source evidence" },
          {
            role: "assistant",
            content: "The resolved source returned, but another tool is still pending.",
            toolCalls: [{ id: "call-pending", name: "bash" }],
          },
        ]);
      }
      if (options.timeoutFollowupTranscript) {
        const firstUser = messagePayload?.content ?? "";
        const firstToolCall = {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-reference-timeout-first", name: "sessions_spawn" }],
        };
        const firstToolResult = {
          role: "tool",
          name: "sessions_spawn",
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "completed",
            session_key: "worker:explore:slow-source-timeout",
            result:
              "Bounded source check exceeded the configured wait window before content, headers, or status were returned.",
          }),
        };
        const firstCloseout = {
          role: "assistant",
          content:
            "Bounded attempt evidence: the slow source did not return within the configured wait window. Verified so far: the source-check was started and no content, headers, or status were received before timeout. Residual release risk remains unverified; the mission can continue by resuming the same source-check context.",
        };
        if (/Continue from the bounded timeout closeout/i.test(missionFollowupPayload?.content ?? "")) {
          return writeJson(res, [
            { role: "user", content: firstUser },
            firstToolCall,
            firstToolResult,
            firstCloseout,
            { role: "user", content: missionFollowupPayload?.content ?? "" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-reference-timeout-followup", name: "sessions_send" }],
            },
            {
              role: "tool",
              name: "sessions_send",
              content: JSON.stringify({
                protocol: "turnkeyai.session_tool_result.v1",
                status: "completed",
                session_key: "worker:explore:slow-source-timeout",
                result:
                  "Resume completed from the same source-check context. The source still did not return content before the follow-up wait window, so no response body, status code, or headers are verified.",
              }),
            },
            {
              role: "assistant",
              content:
                "Follow-up resumed source-check context: the original bounded timeout evidence still stands, and the resumed attempt also produced no source content before the wait window closed. Release-risk note: source content, HTTP status, headers, and latency remain unverified; treat the source as an open evidence gap and continue by rerunning the same source check when the endpoint is expected to respond or by providing a reachable mirror.",
            },
          ]);
        }
        return writeJson(res, [{ role: "user", content: firstUser }, firstToolCall, firstToolResult, firstCloseout]);
      }
      if (options.memoryRecallTranscript) {
        if (/Helios-47/i.test(missionFollowupPayload?.content ?? "")) {
          return writeJson(res, [
            { role: "user", content: messagePayload?.content ?? "" },
            { role: "assistant", content: "Ready to continue when Helios-47 launch context is available." },
            { role: "user", content: missionFollowupPayload?.content ?? "" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-memory-search", name: "memory_search" }],
            },
            {
              role: "tool",
              name: "memory_search",
              content: JSON.stringify({
                results: [
                  {
                    memory_id: "mem.helios.current",
                    text:
                      "Helios-47 launch window Tuesday 09:30; owner Release Captain; residual risk calendar lock needs local verification.",
                  },
                ],
              }),
            },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-memory-get", name: "memory_get" }],
            },
            {
              role: "tool",
              name: "memory_get",
              content: JSON.stringify({
                memory_id: "mem.helios.current",
                text:
                  "Helios-47 launch window Tuesday 09:30. Owner is Release Captain. Residual risk: calendar lock is remembered locally and should be verified before external release announcements.",
              }),
            },
            {
              role: "assistant",
              content:
                "Helios-47 durable memory recovered: launch window Tuesday 09:30, owner Release Captain, residual risk calendar lock is remembered locally and should be verified before external release announcements.",
            },
          ]);
        }
        return writeJson(res, [
          { role: "user", content: messagePayload?.content ?? "" },
          { role: "assistant", content: "Ready to continue when Helios-47 launch context is available." },
        ]);
      }
      if (options.memoryInvalidationTranscript) {
        if (/Continue from the corrected Borealis-23/i.test(missionFollowupPayload?.content ?? "")) {
          return writeJson(res, [
            { role: "user", content: messagePayload?.content ?? "" },
            { role: "assistant", content: "Ready to continue when Borealis-23 launch context is available." },
            { role: "user", content: "Update the Borealis-23 launch context." },
            {
              role: "assistant",
              content:
                "Corrected Borealis-23 context acknowledged: Thursday 16:45, Ops Captain, payment processor signoff pending.",
            },
            { role: "user", content: missionFollowupPayload?.content ?? "" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-memory-search", name: "memory_search" }],
            },
            {
              role: "tool",
              name: "memory_search",
              content: JSON.stringify({
                results: [
                  {
                    memory_id: "mem.borealis.current",
                    text:
                      "Borealis-23 launch window Thursday 16:45; owner Ops Captain; residual risk payment processor signoff pending.",
                  },
                ],
              }),
            },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-memory-get", name: "memory_get" }],
            },
            {
              role: "tool",
              name: "memory_get",
              content: JSON.stringify({
                memory_id: "mem.borealis.current",
                text:
                  "Borealis-23 launch window Thursday 16:45; owner Ops Captain; residual risk payment processor signoff pending.",
              }),
            },
            {
              role: "assistant",
              content:
                "Borealis-23 current launch context from durable memory: launch window Thursday 16:45, owner Ops Captain, residual risk payment processor signoff pending. I treated older conflicting details as stale and did not use them.",
            },
          ]);
        }
        if (/Update the Borealis-23 launch context/i.test(missionFollowupPayload?.content ?? "")) {
          return writeJson(res, [
            { role: "user", content: messagePayload?.content ?? "" },
            { role: "assistant", content: "Ready to continue when Borealis-23 launch context is available." },
            { role: "user", content: missionFollowupPayload?.content ?? "" },
            {
              role: "assistant",
              content:
                "Corrected Borealis-23 context acknowledged: Thursday 16:45, Ops Captain, payment processor signoff pending.",
            },
          ]);
        }
        return writeJson(res, [
          { role: "user", content: messagePayload?.content ?? "" },
          { role: "assistant", content: "Ready to continue when Borealis-23 launch context is available." },
        ]);
      }
      if (options.activeCancellationTimeline && options.cancelFollowupTranscript && missionFollowupPayload) {
        return writeJson(res, [
          { role: "user", content: messagePayload?.content ?? "" },
          {
            id: "assistant-reference-cancel",
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-reference-cancel", name: "sessions_spawn" }],
          },
          {
            role: "tool",
            name: "sessions_spawn",
            content: JSON.stringify({
              protocol: "turnkeyai.session_tool_result.v1",
              status: "cancelled",
              session_key: "worker:explore:cancelled-reference",
              result: "source check cancelled by operator before verification completed",
            }),
          },
          {
            role: "assistant",
            content:
              "Mission cancelled by the operator. Active work stopped before source verification completed, so the release-risk source remains unverified until a follow-up resumes it.",
          },
          { role: "user", content: missionFollowupPayload.content ?? "" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-reference-followup", name: "sessions_send" }],
          },
          {
            role: "tool",
            name: "sessions_send",
            content: JSON.stringify({
              protocol: "turnkeyai.session_tool_result.v1",
              status: "completed",
              session_key: "worker:explore:cancelled-reference",
              final_content:
                "Verified static source after resume: Release Captain owns the release-risk note, rollback rehearsal remains incomplete, and a runbook gap remains unresolved.",
            }),
          },
          {
            role: "assistant",
            content:
              "Verified after the follow-up resume: the static source says the Release Captain owns the release-risk note, rollback rehearsal remains incomplete, and a runbook gap remains unresolved. Unverified: the first cancelled attempt did not finish source verification before cancellation. Residual risk is medium until rollback rehearsal and the runbook gap are resolved; the earlier cancellation lowers confidence only for phase-one evidence, not for the resumed source check.",
          },
        ]);
      }
      if (options.activeCancellationTimeline) {
        return writeJson(res, [
          { role: "user", content: messagePayload?.content ?? "" },
          {
            id: "assistant-reference-cancel",
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-reference-cancel", name: "sessions_spawn" }],
          },
        ]);
      }
      if (options.timeoutPartialHangsAfterWorkerStart) {
        return writeJson(res, [
          { role: "user", content: messagePayload?.content ?? "" },
          {
            role: "assistant",
            content: "",
            metadata: {
              spawnedWorkers: [{ workerType: "explore", workerRunKey: "worker:explore:slow-source-timeout" }],
              workerUsed: true,
              workerType: "explore",
              workerState: {
                workerRunKey: "worker:explore:slow-source-timeout",
                workerType: "explore",
                status: "running",
              },
            },
          },
        ]);
      }
      if (missionApproval && !approvalDecisionPosted) {
        if (options.approvalWaitTimeoutFinal && messagePollCount >= 2) {
          return writeJson(res, [
            { role: "user", content: messagePayload?.content ?? "" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-reference-timeout", name: "permission_query" }],
            },
            {
              role: "tool",
              name: "permission_query",
              content: JSON.stringify({
                approvalId: "ap.reference.1",
                action: "browser.form.submit",
                status: "approval_wait_timeout",
                message:
                  "approval_wait_timeout: operator decision did not arrive and is still pending; no permission_result, permission_applied, browser form submission, or mutation was performed.",
              }),
            },
            {
              role: "assistant",
              content:
                "The approval_wait_timeout was reached while the operator decision was still pending. No permission_result, permission_applied, browser form submission, or mutation was performed. Safest next action: ask the operator to decide or rerun the dry-run submission request when an approver is present.",
              metadata: {
                spawnedWorkers: [{ workerType: "browser", workerRunKey: "worker:browser:approval-timeout" }],
                workerUsed: true,
                workerType: "browser",
                workerState: {
                  workerRunKey: "worker:browser:approval-timeout",
                  workerType: "browser",
                  status: "failed",
                  lastResult: {
                    status: "approval_wait_timeout",
                    summary:
                      "Operator decision did not arrive; no permission_result, permission_applied, browser form submission, or mutation was performed.",
                  },
                },
              },
            },
          ]);
        }
        if (options.pendingWithoutAssistantFinal) {
          return writeJson(res, [
            { role: "user", content: messagePayload?.content ?? "" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-reference-pending", name: "permission_query" }],
            },
            {
              role: "tool",
              name: "permission_query",
              content: JSON.stringify({
                approvalId: "ap.reference.1",
                action: "browser.form.submit",
                status: "pending",
              }),
            },
          ]);
        }
        return writeJson(res, [
          { role: "user", content: messagePayload?.content ?? "" },
          {
            role: "assistant",
            content: "Requested approval for browser.form.submit and waiting for the operator decision.",
            metadata: {
              spawnedWorkers: [{ workerType: "browser", workerRunKey: "worker:browser:approval-pending" }],
              workerUsed: true,
              workerType: "browser",
              workerState: {
                workerRunKey: "worker:browser:approval-pending",
                workerType: "browser",
                status: "completed",
                lastResult: { status: "ok", summary: "Permission request is pending operator decision." },
              },
            },
          },
        ]);
      }
      if (options.delegationFirst && messagePollCount === 1) {
        return writeJson(res, [
          { role: "user", content: messagePayload?.content ?? "" },
          {
            role: "assistant",
            content:
              "I will use the browser worker to inspect the rendered dashboard, then consolidate the evidence for the operator.",
          },
        ]);
      }
      const finalAssistant = {
          role: "assistant",
          content: missionApproval
            ? approvalDecisionPosted === "denied"
              ? "Approval was denied and the browser dry-run action was not submitted. The local approval form remained unchanged, and the safe closeout records the denied operator decision as the intended result."
              : "Approval was granted and the browser dry-run evidence was collected. The local approval form showed isolated test data and no external mutation risk."
            : options.delegationFirst
            ? "Rendered dashboard shows active operations, owner Ops Lead, escalation threshold at seven waiting packets, and a manager-review next action. Residual risk is limited to the local fixture evidence."
            : "Vendor Alpha has stronger automation coverage and clearer operator evidence. Vendor Beta has lower entry cost but weaker browser-backed verification. Recommendation: choose Vendor Alpha unless budget is the overriding constraint.",
          metadata: {
            spawnedWorkers: [{ workerType: "browser", workerRunKey: "worker:browser:1" }],
            workerUsed: true,
            workerType: "browser",
            workerState: {
              workerRunKey: "worker:browser:1",
              workerType: "browser",
              status: "completed",
              lastResult: { status: "ok", summary: "Rendered source pages and extracted evidence." },
            },
          },
        };
      return writeJson(res, [
        { role: "user", content: messagePayload?.content ?? "" },
        ...(options.delegationFirst
          ? [
              {
                role: "assistant",
                content:
                  "I will use the browser worker to inspect the rendered dashboard, then consolidate the evidence for the operator.",
              },
            ]
          : []),
        ...(options.browserToolResultTranscript
          ? [
              {
                role: "tool",
                name: "sessions_spawn",
                content: JSON.stringify({
                  protocol: "turnkeyai.session_tool_result.v1",
                  status: "completed",
                  agent_id: "browser",
                  session_key: "worker:browser:reference",
                  tool_chain: ["browser"],
                  payload: {
                    artifactIds: ["artifact.reference.dashboard"],
                    screenshotPaths: ["/tmp/reference-dashboard.png"],
                  },
                  evidence_summary:
                    "Browser observed Operations Dashboard Fixture. Page title: Operations Dashboard Fixture. Visible page text rendered queue depth and owner.",
                  final_content:
                    "Page title: Operations Dashboard Fixture. Rendered browser page showed queue depth, owner, and residual risk.",
                }),
              },
            ]
          : []),
        ...(options.referenceRuntimeTextBrowserToolResultTranscript
          ? [
              {
                role: "tool",
                name: "sessions_spawn",
                content:
                  "task_id: agent:agent:DID-F456DA-2B0D4C:reference-collector:direct:reference-collector-chat:cid:CID-natural-approval-dry-run-action:sub:browser:19ff0253\n" +
                  "status: completed\n" +
                  "tool_chain: browser\n\n" +
                  "<task_result>\n" +
                  "## Dry-Run Form Submission Report\n\n" +
                  "### Page Details\n" +
                  "- **URL:** `http://127.0.0.1:56174/approval-form`\n" +
                  "- **Page Title:** Approval gate fixture\n\n" +
                  "### Dry-Run Result\n" +
                  "> Dry-run submitted locally after approval; no external mutation was performed. TURNKEYAI_APPROVAL_FIXTURE_OK\n\n" +
                  "### Screenshot (post-submission state)\n" +
                  "![Approval Form - Dry-Run Result](https://sc02.alicdn.com/kf/reference-approval.png)\n" +
                  "</task_result>",
              },
            ]
          : []),
        ...(options.failedBrowserToolResultTranscript
          ? [
              {
                role: "tool",
                name: "sessions_spawn",
                content: JSON.stringify({
                  protocol: "turnkeyai.session_tool_result.v1",
                  status: "failed",
                  agent_id: "browser",
                  session_key: "worker:browser:failed-reference",
                  tool_chain: ["browser"],
                  result:
                    "browser sub-agent returned no executable result. The requested task did not match the worker's implemented capability.",
                }),
              },
            ]
          : []),
        finalAssistant,
      ]);
    }
    if (req.method === "GET" && url.pathname === "/browser-sessions") {
      if (options.emptyBrowserSessions) {
        return writeJson(res, []);
      }
      return writeJson(res, [{ browserSessionId: "BSESS-reference-1", url: "http://127.0.0.1/source" }]);
    }
    if (req.method === "GET" && url.pathname === "/browser-sessions/BSESS-reference-1/history") {
      return writeJson(res, [{ action: "snapshot", title: "Vendor comparison", rendered: true }]);
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

function createMockReferenceRuntimeWsReferenceDaemon(input: {
  referenceRuntimeHome: string;
  accountId: string;
  agentId: string;
}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/models") {
      return writeJson(res, {
        models: [
          {
            id: "fixture-primary",
            providerId: "minimax",
            model: "MiniMax-M2.7-highspeed",
            configured: true,
          },
        ],
      });
    }
    if (req.method === "GET" && url.pathname === "/reference/health") {
      return writeJson(res, {
        ok: true,
        source: "reference-desktop-app-asar",
        provider: "minimax",
        model: "MiniMax-M2.7-highspeed",
        referenceRuntimeHome: input.referenceRuntimeHome,
        electronUserDataDir: path.join(path.dirname(input.referenceRuntimeHome), "electron-user-data"),
      });
    }
    if (req.method === "GET" && url.pathname === "/agents") {
      return writeJson(res, [{ id: input.agentId, accountId: input.accountId }]);
    }
    res.statusCode = 404;
    return writeJson(res, { error: "not found" });
  });
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/websocket/connect") {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n")
    );
    socket.on("data", (chunk) => {
      if ((chunk[0]! & 0x0f) === 0x8) {
        socket.end();
        return;
      }
      const text = readWsTextFrame(chunk);
      if (!text) return;
      const payload = JSON.parse(text) as { params?: { conversationId?: string; question?: { query?: string } } };
      const conversationId = payload.params?.conversationId ?? "CID-missing";
      const prompt = payload.params?.question?.query ?? "";
      sendWsTextFrame(socket, {
        type: "ack",
        payload: {
          success: true,
          conversationId,
        },
      });
      setTimeout(() => {
        sendWsTextFrame(socket, {
          type: "event",
          method: "permission.query",
          payload: {
            conversationId,
            requestId: "perm.reference.1",
            action: "browser.form.submit",
          },
        });
      }, 20);
      setTimeout(() => {
        writeReferenceRuntimeWsSessionMessages({
          referenceRuntimeHome: input.referenceRuntimeHome,
          accountId: input.accountId,
          agentId: input.agentId,
          conversationId,
          messages: [
            { role: "user", content: prompt },
            {
              role: "assistant",
              content:
                "Reference final answer: source A has stronger evidence than source B, so choose source A for this comparison.",
            },
          ],
        });
      }, 60);
    });
  });
  return server;
}

function writeReferenceRuntimeWsSessionMessages(input: {
  referenceRuntimeHome: string;
  accountId: string;
  agentId: string;
  conversationId: string;
  messages: unknown[];
}): void {
  const sessionDir = path.join(input.referenceRuntimeHome, "accounts", input.accountId, "agents", input.agentId, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, `${input.agentId}_${input.conversationId}.messages.jsonl`);
  writeFileSync(sessionPath, `${input.messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
}

function readWsTextFrame(frame: Buffer): string | null {
  if (frame.length < 6) return null;
  const opcode = frame[0]! & 0x0f;
  if (opcode !== 0x1) return null;
  const masked = (frame[1]! & 0x80) !== 0;
  let length = frame[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (frame.length < 8) return null;
    length = frame.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    return null;
  }
  if (!masked || frame.length < offset + 4 + length) return null;
  const mask = frame.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    payload[index] = frame[offset + index]! ^ mask[index % 4]!;
  }
  return payload.toString("utf8");
}

function sendWsTextFrame(socket: NodeJS.WritableStream & { destroyed?: boolean }, payload: unknown): void {
  if (socket.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const header =
    bytes.length < 126
      ? Buffer.from([0x81, bytes.length])
      : Buffer.from([0x81, 126, (bytes.length >> 8) & 0xff, bytes.length & 0xff]);
  socket.write(Buffer.concat([header, bytes]));
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
