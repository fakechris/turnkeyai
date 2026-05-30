import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

import {
  handleDiagnosticsRoutes,
  redactLogLine,
  sanitizeCdpEndpointForDiagnostics,
  tailFile,
  type DiagnosticsRouteDeps,
} from "./diagnostics-routes";

function createRequest(input: { method: string; url: string }): http.IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: input.method,
    url: input.url,
    headers: {},
  }) as unknown as http.IncomingMessage;
}

function createResponse(): {
  res: http.ServerResponse;
  headers: Map<string, string>;
  getJson: () => unknown;
  getBody: () => string;
  getStatus: () => number;
} {
  let payload = "";
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    headers,
    getStatus: () => res.statusCode,
    getJson: () => (payload ? JSON.parse(payload) : undefined),
    getBody: () => payload,
  };
}

function makeTempLog(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-diag-log-"));
  const file = path.join(dir, "daemon.log");
  writeFileSync(file, content);
  return { path: file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeDeps(overrides: Partial<DiagnosticsRouteDeps> = {}): DiagnosticsRouteDeps {
  return {
    daemonVersion: "0.1.1",
    port: 4100,
    dataDir: "/tmp/data",
    runtimeRoot: "/tmp/turnkeyai",
    logFile: "/tmp/turnkeyai/logs/daemon.log",
    configFile: "/tmp/turnkeyai/config.json",
    modelCatalogPath: null,
    processStartedAtMs: 1_700_000_000_000,
    transport: { mode: "local", label: "playwright-chromium" },
    authMode: "token",
    redactionTokens: [],
    snapshotCounters: async () => ({
      sessionCount: 0,
      relayPeerCount: 0,
      relayTargetCount: 0,
    }),
    ...overrides,
  };
}

describe("diagnostics-routes", () => {
  describe("GET /diagnostics", () => {
    it("returns a 200 with a structured snapshot", async () => {
      const { res, getStatus, getJson } = createResponse();
      const handled = await handleDiagnosticsRoutes({
        req: createRequest({ method: "GET", url: "/diagnostics" }),
        res,
        url: new URL("http://127.0.0.1/diagnostics"),
        deps: makeDeps({
          snapshotCounters: async () => ({
            sessionCount: 3,
            relayPeerCount: 1,
            relayTargetCount: 5,
          }),
        }),
      });
      assert.equal(handled, true);
      assert.equal(getStatus(), 200);
      const body = getJson() as Record<string, unknown>;
      assert.ok(body.daemon, "expected daemon section");
      assert.ok(body.paths);
      assert.ok(body.transport);
      assert.deepEqual(body.counters, {
        sessionCount: 3,
        relayPeerCount: 1,
        relayTargetCount: 5,
      });
      assert.ok((body.daemon as Record<string, unknown>).uptimeMs !== undefined);
    });

    it("does NOT leak the daemon token in the snapshot", async () => {
      // Defensive pinning — the token is in env / config but the snapshot
      // should never include it (only the config FILE PATH).
      process.env.TURNKEYAI_DAEMON_TOKEN = "secret-token-xyz";
      const { res, getBody } = createResponse();
      try {
        await handleDiagnosticsRoutes({
          req: createRequest({ method: "GET", url: "/diagnostics" }),
          res,
          url: new URL("http://127.0.0.1/diagnostics"),
          deps: makeDeps(),
        });
        assert.ok(!getBody().includes("secret-token-xyz"), "diagnostics must not leak the token");
      } finally {
        delete process.env.TURNKEYAI_DAEMON_TOKEN;
      }
    });

    it("survives a snapshotCounters() failure with zeroed counters", async () => {
      const { res, getJson } = createResponse();
      await handleDiagnosticsRoutes({
        req: createRequest({ method: "GET", url: "/diagnostics" }),
        res,
        url: new URL("http://127.0.0.1/diagnostics"),
        deps: makeDeps({
          snapshotCounters: async () => {
            throw new Error("upstream crashed");
          },
        }),
      });
      const body = getJson() as Record<string, unknown>;
      assert.deepEqual(body.counters, {
        sessionCount: 0,
        relayPeerCount: 0,
        relayTargetCount: 0,
      });
    });

    it("includes mission health and readiness when the mission snapshot is available", async () => {
      const { res, getJson } = createResponse();
      await handleDiagnosticsRoutes({
        req: createRequest({ method: "GET", url: "/diagnostics" }),
        res,
        url: new URL("http://127.0.0.1/diagnostics"),
        deps: makeDeps({
          missionHealthSnapshot: async () => ({
            total: 2,
            inspected: 2,
            byStatus: {
              draft: 0,
              planning: 0,
              working: 1,
              needs_approval: 1,
              blocked: 0,
              done: 0,
              archived: 0,
            },
            active: 2,
            terminal: 0,
            needsApproval: 1,
            withBlockers: 0,
            snapshotErrorCount: 0,
            duration: {
              longestActiveMs: 42_000,
              longestActiveMissionId: "msn.1",
              longestActiveMissionTitle: "Research dashboard",
              oldestActiveCreatedAtMs: 1_700_000_000_000,
            },
            latestMission: {
              id: "msn.1",
              title: "Research dashboard",
              status: "working",
              createdAtMs: 1_700_000_000_000,
            },
            qualityGate: {
              running: 2,
              passed: 0,
              needsAttention: 0,
              blocked: 0,
            },
            tool: {
              requested: 3,
              executed: 2,
              failed: 0,
              cancelled: 0,
              timeouts: 0,
            },
            sessions: {
              spawned: 1,
              continued: 0,
            },
            browser: {
              profileFallbacks: 0,
            },
            liveness: {
              active: 1,
              waiting: 1,
              stale: 0,
            },
            recoveryEvents: 0,
            attentionMissions: [
              {
                id: "msn.2",
                title: "Needs approval",
                status: "needs_approval",
                qualityGateStatus: "running",
                pendingApprovals: 1,
                blockers: 0,
                toolFailures: 0,
                toolTimeouts: 0,
                browserProfileFallbacks: 0,
                recoveryEvents: 0,
                staleRuntimeSubjects: 0,
                wallClockMs: 12_000,
              },
            ],
          }),
        }),
      });
      const body = getJson() as {
        missionHealth: { active: number; needsApproval: number; duration: { longestActiveMs: number } };
        readiness: { status: string; checks: Array<{ id: string; status: string; detail: string }> };
      };
      assert.equal(body.missionHealth.active, 2);
      assert.equal(body.missionHealth.needsApproval, 1);
      assert.equal(body.missionHealth.duration.longestActiveMs, 42_000);
      const missionRuntime = body.readiness.checks.find((check) => check.id === "mission_runtime");
      assert.equal(missionRuntime?.status, "warn");
      assert.match(missionRuntime?.detail ?? "", /waiting for operator approval/);
    });

    it("keeps diagnostics available when mission health cannot be loaded", async () => {
      const { res, getJson } = createResponse();
      await handleDiagnosticsRoutes({
        req: createRequest({ method: "GET", url: "/diagnostics" }),
        res,
        url: new URL("http://127.0.0.1/diagnostics"),
        deps: makeDeps({
          missionHealthSnapshot: async () => {
            throw new Error("mission store unavailable");
          },
        }),
      });
      const body = getJson() as {
        missionHealth?: unknown;
        readiness: { checks: Array<{ id: string; status: string; detail: string }> };
      };
      assert.equal(body.missionHealth, undefined);
      const missionRuntime = body.readiness.checks.find((check) => check.id === "mission_runtime");
      assert.equal(missionRuntime?.status, "warn");
      assert.match(missionRuntime?.detail ?? "", /mission store unavailable/);
    });

    it("reports model catalog readiness as warn when no catalog is configured", async () => {
      const { res, getJson } = createResponse();
      await handleDiagnosticsRoutes({
        req: createRequest({ method: "GET", url: "/diagnostics" }),
        res,
        url: new URL("http://127.0.0.1/diagnostics"),
        deps: makeDeps({ modelCatalogPath: null }),
      });
      const body = getJson() as {
        readiness: { status: string; checks: Array<{ id: string; status: string; action?: string }> };
      };
      const catalog = body.readiness.checks.find((check) => check.id === "model_catalog");
      assert.equal(body.readiness.status, "warn");
      assert.equal(catalog?.status, "warn");
      assert.match(catalog?.action ?? "", /Configure a model catalog/);
    });

    it("reports model catalog readiness as error when the configured file is missing", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "tk-diag-missing-models-"));
      const missingFile = path.join(dir, "models.json");
      try {
        const { res, getJson } = createResponse();
        await handleDiagnosticsRoutes({
          req: createRequest({ method: "GET", url: "/diagnostics" }),
          res,
          url: new URL("http://127.0.0.1/diagnostics"),
          deps: makeDeps({ modelCatalogPath: missingFile }),
        });
        const body = getJson() as {
          readiness: { status: string; checks: Array<{ id: string; status: string; detail: string }> };
        };
        const catalog = body.readiness.checks.find((check) => check.id === "model_catalog");
        assert.equal(body.readiness.status, "error");
        assert.equal(catalog?.status, "error");
        assert.match(catalog?.detail ?? "", /not readable/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports model catalog readiness as ok when the configured file exists", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "tk-diag-models-"));
      const file = path.join(dir, "models.json");
      writeFileSync(file, JSON.stringify({ models: [] }));
      try {
        const { res, getJson } = createResponse();
        await handleDiagnosticsRoutes({
          req: createRequest({ method: "GET", url: "/diagnostics" }),
          res,
          url: new URL("http://127.0.0.1/diagnostics"),
          deps: makeDeps({ modelCatalogPath: file, logFile: file }),
        });
        const body = getJson() as {
          readiness: { status: string; checks: Array<{ id: string; status: string }> };
        };
        const catalog = body.readiness.checks.find((check) => check.id === "model_catalog");
        assert.equal(body.readiness.status, "ok");
        assert.equal(catalog?.status, "ok");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("surfaces direct-CDP endpoint readiness hints without leaking tokens", async () => {
      const { res, getJson } = createResponse();
      await handleDiagnosticsRoutes({
        req: createRequest({ method: "GET", url: "/diagnostics" }),
        res,
        url: new URL("http://127.0.0.1/diagnostics"),
        deps: makeDeps({
          transport: { mode: "direct-cdp", label: "direct-cdp" },
          directCdpEndpoint: "http://127.0.0.1:9222",
        }),
      });
      const body = getJson() as {
        readiness: { checks: Array<{ id: string; status: string; detail: string }> };
      };
      const transport = body.readiness.checks.find((check) => check.id === "browser_transport");
      assert.equal(transport?.status, "ok");
      assert.match(transport?.detail ?? "", /127\.0\.0\.1:9222/);
    });

    it("redacts sensitive direct-CDP endpoint query and path tokens in readiness hints", async () => {
      const { res, getJson, getBody } = createResponse();
      await handleDiagnosticsRoutes({
        req: createRequest({ method: "GET", url: "/diagnostics" }),
        res,
        url: new URL("http://127.0.0.1/diagnostics"),
        deps: makeDeps({
          transport: { mode: "direct-cdp", label: "direct-cdp" },
          directCdpEndpoint:
            "wss://browser.example.com/devtools/browser/123e4567-e89b-12d3-a456-426614174000?token=secret-session-token",
        }),
      });
      const body = getJson() as {
        readiness: { checks: Array<{ id: string; status: string; detail: string }> };
      };
      const transport = body.readiness.checks.find((check) => check.id === "browser_transport");
      assert.equal(transport?.status, "ok");
      assert.match(transport?.detail ?? "", /wss:\/\/browser\.example\.com\/devtools\/browser\/redacted\?redacted/);
      assert.ok(!getBody().includes("secret-session-token"), "diagnostics must not expose CDP query tokens");
      assert.ok(!getBody().includes("123e4567-e89b-12d3-a456-426614174000"), "diagnostics must not expose CDP session ids");
    });

    it("surfaces recent browser profile fallback as setup health warning", async () => {
      const { res, getJson } = createResponse();
      await handleDiagnosticsRoutes({
        req: createRequest({ method: "GET", url: "/diagnostics" }),
        res,
        url: new URL("http://127.0.0.1/diagnostics"),
        deps: makeDeps({
          browserHealthSnapshot: async () => ({
            inspectedSessionCount: 2,
            recentHistoryCount: 3,
            recentFailureCount: 0,
            profileFallbackCount: 1,
            latestProfileFallback: {
              browserSessionId: "browser-session-locked",
              completedAt: 1_700_000_000_100,
              fallbackDir: "/tmp/fallback-profile",
            },
          }),
        }),
      });
      const body = getJson() as {
        readiness: { status: string; checks: Array<{ id: string; status: string; detail: string; action?: string }> };
      };
      const runtime = body.readiness.checks.find((check) => check.id === "browser_runtime");
      assert.equal(body.readiness.status, "warn");
      assert.equal(runtime?.status, "warn");
      assert.match(runtime?.detail ?? "", /isolated runtime profiles 1 time/);
      assert.match(runtime?.action ?? "", /persistent browser profile was locked/);
    });

    it("surfaces recent browser task failures as setup health warning", async () => {
      const { res, getJson } = createResponse();
      await handleDiagnosticsRoutes({
        req: createRequest({ method: "GET", url: "/diagnostics" }),
        res,
        url: new URL("http://127.0.0.1/diagnostics"),
        deps: makeDeps({
          browserHealthSnapshot: async () => ({
            inspectedSessionCount: 1,
            recentHistoryCount: 4,
            recentFailureCount: 2,
            profileFallbackCount: 0,
            latestFailureSummary:
              "Browser send failed for session browser-session-1.\n\u001b[2m  - navigating to \"https://example.invalid\", waiting until \"domcontentloaded\"\u001b[22m\nError: target closed.",
          }),
        }),
      });
      const body = getJson() as {
        readiness: { status: string; checks: Array<{ id: string; status: string; action?: string }> };
      };
      const runtime = body.readiness.checks.find((check) => check.id === "browser_runtime");
      assert.equal(body.readiness.status, "warn");
      assert.equal(runtime?.status, "warn");
      assert.match(runtime?.action ?? "", /target closed/);
      assert.match(runtime?.action ?? "", /navigating to "https:\/\/example\.invalid"/);
      assert.doesNotMatch(runtime?.action ?? "", /\u001b/);
      assert.doesNotMatch(runtime?.action ?? "", /\n/);
    });

    it("does not fail diagnostics when browser health history cannot be read", async () => {
      const { res, getStatus, getJson } = createResponse();
      await handleDiagnosticsRoutes({
        req: createRequest({ method: "GET", url: "/diagnostics" }),
        res,
        url: new URL("http://127.0.0.1/diagnostics"),
        deps: makeDeps({
          browserHealthSnapshot: async () => {
            throw new Error("history store unavailable");
          },
        }),
      });
      const body = getJson() as {
        readiness: { checks: Array<{ id: string; status: string; detail: string }> };
      };
      const runtime = body.readiness.checks.find((check) => check.id === "browser_runtime");
      assert.equal(getStatus(), 200);
      assert.equal(runtime?.status, "warn");
      assert.match(runtime?.detail ?? "", /history store unavailable/);
    });

    it("supports HEAD with no body", async () => {
      const { res, getStatus, getBody, headers } = createResponse();
      await handleDiagnosticsRoutes({
        req: createRequest({ method: "HEAD", url: "/diagnostics" }),
        res,
        url: new URL("http://127.0.0.1/diagnostics"),
        deps: makeDeps(),
      });
      assert.equal(getStatus(), 200);
      assert.equal(getBody(), "");
      assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
    });
  });

  describe("GET /diagnostics/logs", () => {
    it("returns the last N lines of the log file", async () => {
      const log = makeTempLog(
        Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n") + "\n"
      );
      try {
        const { res, getJson } = createResponse();
        await handleDiagnosticsRoutes({
          req: createRequest({ method: "GET", url: "/diagnostics/logs?limit=5" }),
          res,
          url: new URL("http://127.0.0.1/diagnostics/logs?limit=5"),
          deps: makeDeps({ logFile: log.path }),
        });
        const body = getJson() as { lines: string[]; lineCount: number; truncatedFromHead: boolean };
        assert.deepEqual(body.lines, ["line-16", "line-17", "line-18", "line-19", "line-20"]);
        assert.equal(body.lineCount, 5);
        assert.equal(body.truncatedFromHead, true);
      } finally {
        log.cleanup();
      }
    });

    it("returns all lines when the log is shorter than the limit", async () => {
      const log = makeTempLog("a\nb\nc\n");
      try {
        const { res, getJson } = createResponse();
        await handleDiagnosticsRoutes({
          req: createRequest({ method: "GET", url: "/diagnostics/logs?limit=200" }),
          res,
          url: new URL("http://127.0.0.1/diagnostics/logs?limit=200"),
          deps: makeDeps({ logFile: log.path }),
        });
        const body = getJson() as { lines: string[]; truncatedFromHead: boolean };
        assert.deepEqual(body.lines, ["a", "b", "c"]);
        assert.equal(body.truncatedFromHead, false);
      } finally {
        log.cleanup();
      }
    });

    it("returns 200 with an empty payload + note when log file does not exist", async () => {
      const { res, getStatus, getJson } = createResponse();
      await handleDiagnosticsRoutes({
        req: createRequest({ method: "GET", url: "/diagnostics/logs" }),
        res,
        url: new URL("http://127.0.0.1/diagnostics/logs"),
        deps: makeDeps({ logFile: "/nonexistent/path/to/daemon.log" }),
      });
      assert.equal(getStatus(), 200);
      const body = getJson() as { lines: string[]; note?: string };
      assert.deepEqual(body.lines, []);
      assert.ok(body.note, "expected an explanatory note when log missing");
    });

    it("clamps the limit parameter to MAX_LOG_LIMIT", async () => {
      const log = makeTempLog("only one line\n");
      try {
        const { res, getJson } = createResponse();
        await handleDiagnosticsRoutes({
          req: createRequest({ method: "GET", url: "/diagnostics/logs?limit=999999999" }),
          res,
          url: new URL("http://127.0.0.1/diagnostics/logs?limit=999999999"),
          deps: makeDeps({ logFile: log.path }),
        });
        const body = getJson() as { limit: number };
        assert.equal(body.limit, 2000, "limit must be clamped to 2000");
      } finally {
        log.cleanup();
      }
    });

    it("rejects non-numeric limit by falling back to the default", async () => {
      const log = makeTempLog("only one line\n");
      try {
        const { res, getJson } = createResponse();
        await handleDiagnosticsRoutes({
          req: createRequest({ method: "GET", url: "/diagnostics/logs?limit=abc" }),
          res,
          url: new URL("http://127.0.0.1/diagnostics/logs?limit=abc"),
          deps: makeDeps({ logFile: log.path }),
        });
        const body = getJson() as { limit: number };
        assert.equal(body.limit, 200, "non-numeric limit must fall back to default 200");
      } finally {
        log.cleanup();
      }
    });
  });

  describe("tailFile (helper)", () => {
    it("handles a log with no trailing newline", async () => {
      const log = makeTempLog("a\nb\nc");
      try {
        const result = await tailFile(log.path, 10);
        assert.deepEqual(result.lines, ["a", "b", "c"]);
        assert.equal(result.truncatedFromHead, false);
      } finally {
        log.cleanup();
      }
    });

    it("handles an empty log without throwing", async () => {
      const log = makeTempLog("");
      try {
        const result = await tailFile(log.path, 10);
        assert.deepEqual(result.lines, []);
        assert.equal(result.truncatedFromHead, false);
      } finally {
        log.cleanup();
      }
    });

    it("handles truncation between stat and read without returning zero-padded garbage (codex S1)", async () => {
      // Open the file, capture stat, truncate it on disk to a smaller size,
      // then let tailFile try to read against the captured stat. Before the
      // bytesRead fix, the second half of the buffer would be zero-filled
      // bytes and decode into NUL chars at the end of the last line. After
      // the fix, we slice to bytesRead and decode only the actual content.
      // Easiest way to simulate this without a contrived shim: write a real
      // file, run tailFile, and verify the decoded content has no embedded
      // NUL chars. (The stronger TOCTOU is hard to race in a test, but we
      // can at least pin that bytesRead is the source of truth for what
      // we decode.)
      const log = makeTempLog("line-a\nline-b\nline-c\n");
      try {
        const result = await tailFile(log.path, 10);
        // No embedded NULs (which would appear if we'd decoded the whole
        // pre-allocated buffer instead of slicing to bytesRead).
        for (const line of result.lines) {
          assert.ok(!line.includes("\0"), `line "${line}" must not contain NUL bytes`);
        }
        assert.deepEqual(result.lines, ["line-a", "line-b", "line-c"]);
      } finally {
        log.cleanup();
      }
    });
  });

  describe("log redaction (PR I)", () => {
    it("strips configured tokens from log lines", () => {
      const out = redactLogLine(
        "auth ok: token=secret-token-abcdef granted operator",
        ["secret-token-abcdef"]
      );
      assert.equal(out, "auth ok: token=[REDACTED] granted operator");
    });

    it("strips bearer-token patterns even when the daemon doesn't know the token", () => {
      const out = redactLogLine(
        "401 from agent — header was Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.xxxxxx",
        []
      );
      assert.equal(
        out,
        "401 from agent — header was Authorization: Bearer [REDACTED]"
      );
    });

    it("strips x-turnkeyai-token headers", () => {
      const out = redactLogLine("incoming x-turnkeyai-token: abc-def-ghi-jkl", []);
      assert.equal(out, "incoming x-turnkeyai-token: [REDACTED]");
    });

    it("redacts bare token=xxx patterns over 12 chars", () => {
      const out = redactLogLine("config snapshot: token=long-enough-token-value", []);
      assert.equal(out, "config snapshot: token=[REDACTED]");
    });

    it("leaves short tokens alone (avoid false positives on short hex words)", () => {
      // 11 chars — below the 12-char threshold on the bare-token regex,
      // and below the 8-char threshold on the configured-token check.
      const out = redactLogLine("token=abc1234567", []);
      assert.equal(out, "token=abc1234567");
    });

    it("strips x-api-key headers (codex PR I round-2)", () => {
      assert.equal(
        redactLogLine("upstream replied 401: x-api-key: sk_live_abcdefghijkl", []),
        "upstream replied 401: x-api-key: [REDACTED]"
      );
      assert.equal(
        redactLogLine("opts.headers = { x-api-key=plain-value }", []),
        "opts.headers = { x-api-key=[REDACTED] }"
      );
    });

    it("strips cookie + set-cookie headers", () => {
      assert.equal(
        redactLogLine("request had cookie: session=abcdef1234567890", []),
        "request had cookie: [REDACTED]"
      );
      // For Set-Cookie, we mask the value but leave the attributes (Path,
      // HttpOnly, etc.) intact since those don't carry secrets — it's
      // useful for diagnostics to see the cookie flags even when the
      // value is hidden.
      assert.equal(
        redactLogLine("Set-Cookie: sid=xyz123; Path=/; HttpOnly", []),
        "Set-Cookie: [REDACTED]; Path=/; HttpOnly"
      );
    });

    it("strips api_key / api-key parameter shapes", () => {
      assert.equal(
        redactLogLine("calling openai with api_key=sk-1234567890abcdef", []),
        "calling openai with api_key=[REDACTED]"
      );
      assert.equal(
        redactLogLine("config: {api-key: my-secret-key-value-1234}", []),
        "config: {api-key: [REDACTED]}"
      );
    });

    it("redacts longer tokens before shorter prefixes (gemini PR I round-2)", () => {
      // "short-prefix" is a prefix of "short-prefix-extended-secret".
      // Without descending-by-length sort, the shorter token would be
      // redacted first, leaving "-extended-secret" visible.
      const out = redactLogLine(
        "boot: token=short-prefix-extended-secret active",
        ["short-prefix", "short-prefix-extended-secret"]
      );
      assert.equal(out, "boot: token=[REDACTED] active");
    });

    it("redacts bare token= patterns case-insensitively (gemini PR I round-2)", () => {
      // Pre-fix only lowercase "token" matched; now all casings.
      assert.equal(
        redactLogLine("TOKEN=abcdef1234567890 active", []),
        "TOKEN=[REDACTED] active"
      );
      assert.equal(
        redactLogLine("Token: longvalue1234567890", []),
        "Token: [REDACTED]"
      );
    });

    it("strips sk-... / sk_live_... style API secrets", () => {
      assert.equal(
        redactLogLine("error payload included sk-abcdefghijklmnopqrstuvwxyz", []),
        "error payload included sk-[REDACTED]"
      );
      assert.equal(
        redactLogLine("stripe key sk_live_1234567890abcdefXYZ in payload", []),
        "stripe key sk_live_[REDACTED] in payload"
      );
    });

    it("end-to-end: /diagnostics/logs response redacts before returning", async () => {
      const log = makeTempLog(
        "starting daemon\n" +
          "config: token=super-secret-daemon-token-xyz123\n" +
          "incoming Authorization: Bearer eyJlongtokenstring\n"
      );
      try {
        const { res, getJson } = createResponse();
        await handleDiagnosticsRoutes({
          req: createRequest({ method: "GET", url: "/diagnostics/logs" }),
          res,
          url: new URL("http://127.0.0.1/diagnostics/logs"),
          deps: makeDeps({
            logFile: log.path,
            redactionTokens: ["super-secret-daemon-token-xyz123"],
          }),
        });
        const body = getJson() as { lines: string[]; redacted: boolean };
        assert.equal(body.redacted, true);
        assert.ok(!body.lines.some((line) => line.includes("super-secret-daemon-token-xyz123")));
        assert.ok(!body.lines.some((line) => line.includes("eyJlongtokenstring")));
      } finally {
        log.cleanup();
      }
    });
  });

  describe("sanitizeCdpEndpointForDiagnostics", () => {
    it("preserves plain host endpoints", () => {
      assert.equal(sanitizeCdpEndpointForDiagnostics("127.0.0.1:9222"), "127.0.0.1:9222/");
    });

    it("redacts userinfo, long path tokens, query strings, and fragments", () => {
      const sanitized = sanitizeCdpEndpointForDiagnostics(
        "https://user:pass@browser.example.com/session/abcdef1234567890abcdef1234567890?api_key=secret#frag"
      );
      assert.equal(sanitized, "https://redacted:redacted@browser.example.com/session/redacted?redacted");
    });

    it("does not echo malformed endpoint text", () => {
      assert.equal(sanitizeCdpEndpointForDiagnostics("http://[bad endpoint"), "[invalid endpoint redacted]");
    });
  });

  describe("routing", () => {
    it("ignores non-diagnostics paths", async () => {
      const { res } = createResponse();
      const handled = await handleDiagnosticsRoutes({
        req: createRequest({ method: "GET", url: "/bridge/status" }),
        res,
        url: new URL("http://127.0.0.1/bridge/status"),
        deps: makeDeps(),
      });
      assert.equal(handled, false);
    });

    it("ignores non-GET methods", async () => {
      const { res } = createResponse();
      const handled = await handleDiagnosticsRoutes({
        req: createRequest({ method: "POST", url: "/diagnostics" }),
        res,
        url: new URL("http://127.0.0.1/diagnostics"),
        deps: makeDeps(),
      });
      assert.equal(handled, false);
    });
  });
});
