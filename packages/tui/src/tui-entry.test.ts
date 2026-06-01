import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("tui entry", () => {
  it("prints startup readiness and exits cleanly with piped input", async () => {
    const server = await startHealthServer();
    const home = await mkdtemp(path.join(tmpdir(), "turnkeyai-tui-entry-"));
    try {
      const result = await runTui(["exit\n"], {
        TURNKEYAI_HOME: home,
        TURNKEYAI_DAEMON_URL: `http://127.0.0.1:${server.port}`,
      });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /TurnkeyAI Mission Workbench TUI/);
      assert.match(result.stdout, /\[ok\s+\] daemon \/health/);
      assert.match(result.stdout, /web workbench: npm run app -- --no-open/);
      assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

function runTui(
  inputLines: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "packages/tui/src/tui.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("tui entry test timed out"));
    }, 10_000);
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
    for (const line of inputLines) {
      child.stdin.write(line);
    }
    child.stdin.end();
  });
}

function startHealthServer(): Promise<{ port: number; close: () => void }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("missing server port"));
        return;
      }
      resolve({
        port: address.port,
        close: () => server.close(),
      });
    });
  });
}
