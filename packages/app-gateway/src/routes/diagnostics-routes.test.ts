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
