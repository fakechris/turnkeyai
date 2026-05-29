import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("doctor", () => {
  it("warns, but does not fail, when relay extension is absent for local transport", async () => {
    const server = await startHealthServer();
    const home = await mkdtemp(path.join(tmpdir(), "turnkeyai-doctor-local-"));
    try {
      await writeConfig(home, { token: "test-token", port: server.port, transportMode: "local" });
      const result = await runCli(["doctor"], {
        TURNKEYAI_HOME: home,
        TURNKEYAI_DAEMON_URL: `http://127.0.0.1:${server.port}`,
      });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /\[warn\] relay extension\s+not installed; only required when TURNKEYAI_BROWSER_TRANSPORT=relay/);
      assert.match(result.stdout, /turnkeyai doctor: 1 warning\(s\), no failures/);
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fails when relay transport is configured and the relay extension is absent", async () => {
    const server = await startHealthServer();
    const home = await mkdtemp(path.join(tmpdir(), "turnkeyai-doctor-relay-"));
    try {
      await writeConfig(home, { token: "test-token", port: server.port, transportMode: "relay" });
      const result = await runCli(["doctor"], {
        TURNKEYAI_HOME: home,
        TURNKEYAI_DAEMON_URL: `http://127.0.0.1:${server.port}`,
      });

      assert.equal(result.code, 1);
      assert.match(result.stdout, /\[fail\] relay extension\s+required by relay transport but not installed/);
      assert.match(result.stderr, /turnkeyai doctor: 1 check\(s\) failed/);
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function startHealthServer(): Promise<{ port: number; close: () => void }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    close: () => server.close(),
  };
}

async function writeConfig(home: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

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
