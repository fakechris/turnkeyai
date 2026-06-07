import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildRealLlmAbReferencePreflightHelpText,
  parseRealLlmAbReferencePreflightArgs,
  runRealLlmAbReferencePreflightCli,
  runReferencePreflight,
} from "./real-llm-ab-reference-preflight";

test("real LLM A/B reference preflight parses args and help", () => {
  assert.deepEqual(
    parseRealLlmAbReferencePreflightArgs([
      "--base-url",
      "http://127.0.0.1:4100",
      "--out",
      "/tmp/preflight.json",
      "--reference-token",
      "secret-reference-token",
      "--variant",
      "analyst",
      "--timeout-ms",
      "1000",
      "--poll-ms",
      "50",
      "--probe-prompt",
      "hello",
      "--check",
    ]),
    {
      baseUrl: "http://127.0.0.1:4100",
      outPath: "/tmp/preflight.json",
      referenceToken: "secret-reference-token",
      variant: "analyst",
      timeoutMs: 1000,
      pollMs: 50,
      probePrompt: "hello",
      check: true,
    }
  );
  assert.deepEqual(parseRealLlmAbReferencePreflightArgs(["--help"]), { help: true });
  assert.match(buildRealLlmAbReferencePreflightHelpText(), /reference daemon preflight/);
  assert.throws(() => parseRealLlmAbReferencePreflightArgs(["--base-url", "http://x"]), /missing required --out/);
});

test("real LLM A/B reference preflight sends daemon bearer token when configured", async () => {
  const server = createMockReferenceDaemon({ mode: "healthy", authToken: "secret-reference-token" });
  try {
    const baseUrl = await listen(server);
    const report = await runReferencePreflight({
      baseUrl,
      referenceToken: "secret-reference-token",
      timeoutMs: 1_000,
      pollMs: 10,
      probePrompt: "Can you answer this normal user message?",
      generatedAtMs: 1,
    });

    assert.equal(report.status, "passed");
    assert.equal(report.checks.messageAccepted, true);
    assert.equal(report.checks.browserSessionsRouteReachable, true);
  } finally {
    await close(server);
  }
});

test("real LLM A/B reference preflight passes a compatible daemon protocol", async () => {
  const server = createMockReferenceDaemon({ mode: "healthy" });
  try {
    const baseUrl = await listen(server);
    const report = await runReferencePreflight({
      baseUrl,
      timeoutMs: 1_000,
      pollMs: 10,
      probePrompt: "Can you answer this normal user message?",
      generatedAtMs: 1,
    });

    assert.equal(report.status, "passed");
    assert.equal(report.checks.modelConfigured, true);
    assert.equal(report.checks.threadIdCaptured, true);
    assert.equal(report.checks.messageAccepted, true);
    assert.equal(report.checks.promptObservedInTranscript, true);
    assert.equal(report.checks.assistantFinalCaptured, true);
    assert.equal(report.checks.browserSessionsRouteReachable, true);
    assert.deepEqual(report.rootCauseBuckets, []);
    assert.match(report.finalText ?? "", /runtime can answer/);
  } finally {
    await close(server);
  }
});

test("real LLM A/B reference preflight observes multiline natural prompts in transcript", async () => {
  const server = createMockReferenceDaemon({ mode: "healthy" });
  try {
    const baseUrl = await listen(server);
    const report = await runReferencePreflight({
      baseUrl,
      timeoutMs: 1_000,
      pollMs: 10,
      probePrompt:
        "Compare Vendor Alpha and Vendor Beta.\nReview http://127.0.0.1:51234/vendor-alpha and http://127.0.0.1:51234/vendor-beta.\nReturn the verified tradeoff.",
      generatedAtMs: 1,
    });

    assert.equal(report.status, "passed");
    assert.equal(report.checks.promptObservedInTranscript, true);
    assert.ok(!report.rootCauseBuckets.includes("prompt_mismatch"));
  } finally {
    await close(server);
  }
});

test("real LLM A/B reference preflight buckets prose-only role labels as non-dispatchable delegation", async () => {
  const server = createMockReferenceDaemon({ mode: "delegationRoleLabelOnly" });
  try {
    const baseUrl = await listen(server);
    const report = await runReferencePreflight({
      baseUrl,
      timeoutMs: 40,
      pollMs: 10,
      probePrompt: "Can you answer this normal user message?",
      generatedAtMs: 1,
    });

    assert.equal(report.status, "failed");
    assert.ok(report.rootCauseBuckets.includes("delegation_not_executed"));
    assert.ok(report.rootCauseBuckets.includes("delegation_text_not_dispatchable"));
    assert.ok(report.findings.includes("assistant final text names a role in prose rather than a dispatchable role mention"));
  } finally {
    await close(server);
  }
});

test("real LLM A/B reference preflight buckets adapter fallback and harness echo", async () => {
  const server = createMockReferenceDaemon({ mode: "fallback" });
  try {
    const baseUrl = await listen(server);
    const report = await runReferencePreflight({
      baseUrl,
      timeoutMs: 1_000,
      pollMs: 10,
      probePrompt: "Can you answer this normal user message?",
      generatedAtMs: 1,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.checks.noAdapterFallback, false);
    assert.equal(report.checks.noHarnessEcho, false);
    assert.ok(report.rootCauseBuckets.includes("model_adapter_fallback"));
    assert.ok(report.rootCauseBuckets.includes("reference_endpoint_or_auth"));
    assert.ok(report.rootCauseBuckets.includes("openai_compatible_base_path_risk"));
    assert.ok(report.rootCauseBuckets.includes("prompt_harness_echo"));
    assert.ok(report.findings.includes("model adapter fallback was observed"));
    assert.ok(
      report.findings.includes(
        "configured OpenAI-compatible model base URL has a path that may be dropped by absolute-path URL joining"
      )
    );
    assert.ok(report.findings.includes("assistant final text looks like harness/process echo"));
    assert.deepEqual(report.adapterDiagnostics, [
      {
        modelId: "fixture-model",
        providerId: "fixture-provider",
        protocol: "openai-compatible",
        configured: true,
        baseURL: "https://api.example.test/v1",
        baseUrlPath: "/v1",
        safeChatCompletionsUrl: "https://api.example.test/v1/chat/completions",
        absolutePathChatCompletionsUrl: "https://api.example.test/chat/completions",
        basePathDropRisk: true,
      },
    ]);
  } finally {
    await close(server);
  }
});

test("real LLM A/B reference preflight rejects delegation-only final text", async () => {
  const server = createMockReferenceDaemon({ mode: "delegationOnly" });
  try {
    const baseUrl = await listen(server);
    const report = await runReferencePreflight({
      baseUrl,
      timeoutMs: 40,
      pollMs: 10,
      probePrompt: "Can you answer this normal user message?",
      generatedAtMs: 1,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.checks.assistantFinalCaptured, true);
    assert.equal(report.checks.noDelegationOnlyFinal, false);
    assert.ok(report.rootCauseBuckets.includes("delegation_not_executed"));
    assert.ok(report.rootCauseBuckets.includes("delegation_text_not_dispatchable"));
    assert.ok(report.findings.includes("assistant final text is delegation-only and no delegated result was observed"));
    assert.ok(report.findings.includes("assistant final text names a role in prose rather than a dispatchable role mention"));
  } finally {
    await close(server);
  }
});

test("real LLM A/B reference preflight treats JSON content-type with HTML body as non-JSON", async () => {
  const server = createMockReferenceDaemon({ mode: "nonJsonModel" });
  try {
    const baseUrl = await listen(server);
    const report = await runReferencePreflight({
      baseUrl,
      timeoutMs: 1_000,
      pollMs: 10,
      generatedAtMs: 1,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.checks.modelCatalogJson, false);
    assert.ok(report.rootCauseBuckets.includes("reference_non_json_response"));
    assert.ok(report.rootCauseBuckets.includes("reference_endpoint_or_auth"));
    assert.ok(report.findings.includes("model catalog route did not return JSON"));
    assert.ok(report.findings.includes("GET /models returned non-JSON content"));
  } finally {
    await close(server);
  }
});

test("real LLM A/B reference preflight CLI writes a failed report with check", async () => {
  const server = createMockReferenceDaemon({ mode: "fallback" });
  const dir = mkdtempSync(path.join(tmpdir(), "turnkeyai-reference-preflight-"));
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const baseUrl = await listen(server);
    const outPath = path.join(dir, "preflight.json");
    await runRealLlmAbReferencePreflightCli([
      "--base-url",
      baseUrl,
      "--out",
      outPath,
      "--timeout-ms",
      "1000",
      "--poll-ms",
      "10",
      "--check",
    ]);
    const report = JSON.parse(readFileSync(outPath, "utf8")) as { status?: unknown; rootCauseBuckets?: unknown };

    assert.equal(report.status, "failed");
    assert.equal(process.exitCode, 1);
    assert.ok(Array.isArray(report.rootCauseBuckets));
  } finally {
    process.exitCode = previousExitCode;
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

function createMockReferenceDaemon(input: {
  mode: "healthy" | "fallback" | "nonJsonModel" | "delegationOnly" | "delegationRoleLabelOnly";
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
      if (input.mode === "nonJsonModel") {
        res.setHeader("content-type", "application/json");
        return res.end("<!DOCTYPE html><html>login</html>");
      }
      return writeJson(res, {
        models: [
          {
            id: "primary",
            providerId: "fixture-provider",
            protocol: "openai-compatible",
            model: "fixture-model",
            baseURL: input.mode === "fallback" ? "https://api.example.test/v1" : "https://api.example.test",
            configured: true,
          },
        ],
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
      const assistant =
        input.mode === "healthy"
          ? "This runtime can answer normal user messages with a concise useful response."
          : input.mode === "delegationRoleLabelOnly"
            ? "I will delegate this to the Explore role so it can inspect the provided pages and report back."
          : input.mode === "delegationOnly"
            ? "Let me delegate this to the Confirm role.\n\nDelegate to: role-confirm\nMessage: Please provide a concise confirmation."
          : "Lead is operating as Lead Coordinator. Close the flow with a concise final message.";
      return writeJson(res, [
        { role: "user", content: prompt },
        {
          role: "assistant",
          content: assistant,
          metadata:
            input.mode === "fallback"
              ? { adapterName: "heuristic", fallbackReason: 'Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON' }
              : {},
        },
      ]);
    }
    if (req.method === "GET" && url.pathname === "/browser-sessions") {
      return writeJson(res, []);
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
