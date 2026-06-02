import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("daemon status", () => {
  it("exits successfully when the daemon is healthy but not tracked by a pid file", async () => {
    let bridgeAuthHeader: string | undefined;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/bridge/status") {
        bridgeAuthHeader = req.headers.authorization;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            transport: { mode: "local", label: "local-automation" },
            expertLane: { available: false },
            sessions: { count: 2 },
          })
        );
        return;
      }
      if (req.url === "/diagnostics") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            readiness: {
              status: "warn",
              checks: [
                {
                  label: "Model catalog",
                  status: "warn",
                  detail: "One configured model is missing its API key.",
                  action: "Set OPENAI_API_KEY.",
                },
              ],
            },
          })
        );
        return;
      }
      if (req.url === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            defaultSelection: {
              ok: true,
              chainId: "lead_reasoning",
              primaryModelId: "minimax-m2",
              fallbackModelIds: ["gpt-5"],
            },
            models: [
              { id: "minimax-m2", configured: true, apiKeyEnv: "MINIMAX_API_KEY" },
              { id: "gpt-5", configured: false, apiKeyEnv: "OPENAI_API_KEY" },
            ],
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const home = await mkdtemp(path.join(tmpdir(), "turnkeyai-cli-status-"));

    try {
      const result = await runCli(["daemon", "status"], {
        TURNKEYAI_HOME: home,
        TURNKEYAI_DAEMON_URL: `http://127.0.0.1:${address.port}`,
        TURNKEYAI_DAEMON_READ_TOKEN: "read-token",
      });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /pid:\s+\(none\)/);
      assert.match(result.stdout, /health:\s+ok/);
      assert.match(result.stdout, /api auth:\s+ok/);
      assert.match(result.stdout, /transport:\s+local \(local-automation\)/);
      assert.match(result.stdout, /sessions:\s+2/);
      assert.match(result.stdout, /setup:\s+warn/);
      assert.match(result.stdout, /check:\s+Model catalog \[warn\] - One configured model is missing its API key\./);
      assert.match(result.stdout, /action: Set OPENAI_API_KEY\./);
      assert.match(result.stdout, /models:\s+lead_reasoning: minimax-m2 -> gpt-5/);
      assert.match(result.stdout, /model keys:\s+primary ok, 1 fallback key\(s\) missing/);
      assert.equal(bridgeAuthHeader, "Bearer read-token");
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("shows bridge API auth failures instead of silently omitting status fields", async () => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/bridge/status") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized", requiredAccess: "read" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const home = await mkdtemp(path.join(tmpdir(), "turnkeyai-cli-status-auth-"));

    try {
      const result = await runCli(["daemon", "status"], {
        TURNKEYAI_HOME: home,
        TURNKEYAI_DAEMON_URL: `http://127.0.0.1:${address.port}`,
        TURNKEYAI_DAEMON_READ_TOKEN: "stale-token",
      });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /health:\s+ok/);
      assert.match(result.stdout, /api auth:\s+\/bridge\/status returned HTTP 401 \(token rejected\)/);
      assert.match(result.stdout, /turnkeyai app/);
      assert.match(result.stdout, /npm run app -- --no-open/);
      assert.match(result.stdout, /TURNKEYAI_DAEMON_READ_TOKEN/);
      assert.doesNotMatch(result.stdout, /transport:\s+/);
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("bounds authenticated status probes so a half-open API cannot hang diagnostics", async () => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/bridge/status") {
        // Leave this request open. `daemon status` should abort its probe
        // and still print the rest of the diagnostic surface.
        return;
      }
      if (req.url === "/diagnostics") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ readiness: { status: "ok", checks: [] } }));
        return;
      }
      if (req.url === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ defaultSelection: { ok: false, error: "no default selection" } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const home = await mkdtemp(path.join(tmpdir(), "turnkeyai-cli-status-half-open-"));

    try {
      const startedAt = Date.now();
      const result = await runCli(["daemon", "status"], {
        TURNKEYAI_HOME: home,
        TURNKEYAI_DAEMON_URL: `http://127.0.0.1:${address.port}`,
        TURNKEYAI_DAEMON_READ_TOKEN: "read-token",
      });

      assert.equal(result.code, 0);
      assert.ok(Date.now() - startedAt < 4500, "daemon status should not wait for the test harness timeout");
      assert.match(result.stdout, /health:\s+ok/);
      assert.match(result.stdout, /api auth:\s+\/bridge\/status unreachable:/);
      assert.match(result.stdout, /setup:\s+ok/);
      assert.match(result.stdout, /models:\s+attention \(no default selection\)/);
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "packages/cli/src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI command timed out: ${args.join(" ")}`));
    }, 5000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}
