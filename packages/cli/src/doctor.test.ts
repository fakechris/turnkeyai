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
      assert.match(result.stdout, /\[warn\] installed cli\s+turnkeyai command not on PATH/);
      assert.match(result.stdout, /turnkeyai doctor: 2 warning\(s\), no failures/);
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

  it("warns instead of failing when config is absent but an env token is configured", async () => {
    const server = await startHealthServer();
    const home = await mkdtemp(path.join(tmpdir(), "turnkeyai-doctor-env-token-"));
    try {
      const result = await runCli(["doctor"], {
        TURNKEYAI_HOME: home,
        TURNKEYAI_DAEMON_URL: `http://127.0.0.1:${server.port}`,
        TURNKEYAI_DAEMON_READ_TOKEN: "read-token",
      });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /\[warn\] config\/auth\s+missing .*config\.json; using read token from env/);
      assert.match(result.stdout, /turnkeyai doctor: 3 warning\(s\), no failures/);
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fails when the resolved token cannot read daemon APIs", async () => {
    const server = await startHealthServer({ acceptedBridgeToken: "actual-token" });
    const home = await mkdtemp(path.join(tmpdir(), "turnkeyai-doctor-bad-token-"));
    try {
      await writeConfig(home, { token: "stale-token", port: server.port, transportMode: "local" });
      const result = await runCli(["doctor"], {
        TURNKEYAI_HOME: home,
        TURNKEYAI_DAEMON_URL: `http://127.0.0.1:${server.port}`,
      });

      assert.equal(result.code, 1);
      assert.match(result.stdout, /\[fail\] daemon api auth\s+\/bridge\/status rejected unknown token from config \(HTTP 401\)/);
      assert.match(result.stderr, /turnkeyai doctor: 1 check\(s\) failed/);
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("prints daemon readiness warnings and failures from /diagnostics", async () => {
    const server = await startHealthServer({
      readiness: {
        checks: [
          {
            label: "Model catalog",
            status: "warn",
            detail: "No model catalog is configured.",
            action: "Configure a model catalog before production task runs.",
          },
          {
            label: "Browser transport",
            status: "error",
            detail: "Direct CDP endpoint is unreachable.",
          },
        ],
      },
    });
    const home = await mkdtemp(path.join(tmpdir(), "turnkeyai-doctor-readiness-"));
    try {
      await writeConfig(home, { token: "test-token", port: server.port, transportMode: "local" });
      const result = await runCli(["doctor"], {
        TURNKEYAI_HOME: home,
        TURNKEYAI_DAEMON_URL: `http://127.0.0.1:${server.port}`,
      });

      assert.equal(result.code, 1);
      assert.match(result.stdout, /\[warn\] readiness: Model catalog\s+No model catalog is configured\. next=Configure a model catalog/);
      assert.match(result.stdout, /\[fail\] readiness: Browser transport\s+Direct CDP endpoint is unreachable\./);
      assert.match(result.stderr, /turnkeyai doctor: 1 check\(s\) failed, 3 warning\(s\)/);
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fails when the primary model provider key is missing", async () => {
    const server = await startHealthServer({
      models: {
        defaultSelection: {
          ok: true,
          chainId: "lead_reasoning",
          primaryModelId: "minimax-m2",
          fallbackModelIds: ["gpt-5"],
        },
        models: [
          { id: "minimax-m2", configured: false, apiKeyEnv: "MINIMAX_API_KEY" },
          { id: "gpt-5", configured: true, apiKeyEnv: "OPENAI_API_KEY" },
        ],
      },
    });
    const home = await mkdtemp(path.join(tmpdir(), "turnkeyai-doctor-model-primary-"));
    try {
      await writeConfig(home, { token: "test-token", port: server.port, transportMode: "local" });
      const result = await runCli(["doctor"], {
        TURNKEYAI_HOME: home,
        TURNKEYAI_DAEMON_URL: `http://127.0.0.1:${server.port}`,
      });

      assert.equal(result.code, 1);
      assert.match(result.stdout, /\[fail\] model readiness\s+primary minimax-m2 missing key MINIMAX_API_KEY/);
      assert.match(result.stderr, /turnkeyai doctor: 1 check\(s\) failed, 2 warning\(s\)/);
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("warns when only fallback model provider keys are missing", async () => {
    const server = await startHealthServer({
      models: {
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
      },
    });
    const home = await mkdtemp(path.join(tmpdir(), "turnkeyai-doctor-model-fallback-"));
    try {
      await writeConfig(home, { token: "test-token", port: server.port, transportMode: "local" });
      const result = await runCli(["doctor"], {
        TURNKEYAI_HOME: home,
        TURNKEYAI_DAEMON_URL: `http://127.0.0.1:${server.port}`,
      });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /\[warn\] model readiness\s+lead_reasoning: minimax-m2 ready, 1 fallback key\(s\) missing/);
      assert.match(result.stdout, /turnkeyai doctor: 3 warning\(s\), no failures/);
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function startHealthServer(input: {
  acceptedBridgeToken?: string;
  models?: {
    defaultSelection: {
      ok?: boolean;
      chainId?: string;
      primaryModelId?: string;
      fallbackModelIds?: string[];
      error?: string;
    };
    models?: Array<{ id: string; configured: boolean; apiKeyEnv: string }>;
  };
  readiness?: {
    checks: Array<{
      label: string;
      status: string;
      detail: string;
      action?: string;
    }>;
  };
} = {}): Promise<{ port: number; close: () => void }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/bridge/status") {
      if (
        input.acceptedBridgeToken &&
        req.headers.authorization !== `Bearer ${input.acceptedBridgeToken}`
      ) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/diagnostics") {
      if (
        input.acceptedBridgeToken &&
        req.headers.authorization !== `Bearer ${input.acceptedBridgeToken}`
      ) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        readiness: input.readiness ?? {
          checks: [{ label: "Daemon", status: "ok", detail: "Listening." }],
        },
      }));
      return;
    }
    if (req.url === "/models") {
      if (
        input.acceptedBridgeToken &&
        req.headers.authorization !== `Bearer ${input.acceptedBridgeToken}`
      ) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(
        input.models ?? {
          defaultSelection: {
            ok: true,
            chainId: "lead_reasoning",
            primaryModelId: "minimax-m2",
            fallbackModelIds: [],
          },
          models: [{ id: "minimax-m2", configured: true, apiKeyEnv: "MINIMAX_API_KEY" }],
        }
      ));
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
      env: {
        ...process.env,
        PATH: path.dirname(process.execPath),
        TURNKEYAI_DOCTOR_CLI_COMMAND: "turnkeyai-doctor-test-missing",
        ...env,
      },
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
