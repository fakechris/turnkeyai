import { access, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

const args = process.argv.slice(2);
let daemonUrl = process.env.TURNKEYAI_DAEMON_URL ?? "";
let startUrl = "https://example.com";
let chromePath: string | null = null;
let profileDir: string | null = null;
let timeoutMs = 20_000;
let skipBuild = false;
let keepOpen = false;
let requireTarget = true;
let daemonPort: number | null = null;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--daemon-url") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --daemon-url");
    }
    daemonUrl = value;
    index += 1;
    continue;
  }
  if (arg === "--url") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --url");
    }
    startUrl = value;
    index += 1;
    continue;
  }
  if (arg === "--daemon-port") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --daemon-port");
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("--daemon-port must be a positive integer");
    }
    daemonPort = parsed;
    index += 1;
    continue;
  }
  if (arg === "--chrome-path") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --chrome-path");
    }
    chromePath = value;
    index += 1;
    continue;
  }
  if (arg === "--profile-dir") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --profile-dir");
    }
    profileDir = path.resolve(process.cwd(), value);
    index += 1;
    continue;
  }
  if (arg === "--timeout-ms") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --timeout-ms");
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("--timeout-ms must be a positive number");
    }
    timeoutMs = Math.trunc(parsed);
    index += 1;
    continue;
  }
  if (arg === "--skip-build") {
    skipBuild = true;
    continue;
  }
  if (arg === "--keep-open") {
    keepOpen = true;
    continue;
  }
  if (arg === "--no-require-target") {
    requireTarget = false;
  }
}

await main();

async function main(): Promise<void> {
  const extensionDir = path.resolve(process.cwd(), "packages/browser-relay-peer/dist/extension");
  const resolvedProfileDir = profileDir ?? path.join(os.tmpdir(), `turnkeyai-relay-smoke-${Date.now()}`);
  const resolvedDaemonUrl = daemonUrl.trim()
    ? daemonUrl.trim().replace(/\/+$/, "")
    : `http://127.0.0.1:${daemonPort ?? (await resolveFreePort())}`;
  const resolvedDaemonPort = Number(new URL(resolvedDaemonUrl).port || 80);

  let daemonChild: ChildProcess | null = null;
  let chromeChild: ChildProcess | null = null;

  try {
    if (!skipBuild) {
      await runCommand("npm", ["run", "build:relay-extension"], {
        TURNKEYAI_RELAY_DAEMON_URL: resolvedDaemonUrl,
      });
    } else {
      await access(path.join(extensionDir, "manifest.json"));
    }

    await mkdir(resolvedProfileDir, { recursive: true });

    daemonChild = spawn("npm", ["run", "daemon"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TURNKEYAI_BROWSER_TRANSPORT: "relay",
        TURNKEYAI_DAEMON_PORT: String(resolvedDaemonPort),
      },
      stdio: "ignore",
    });

    const resolvedChromePath = await resolveChromePath(chromePath ?? process.env.TURNKEYAI_BROWSER_PATH);
    chromeChild = spawn(
      resolvedChromePath,
      [
        `--user-data-dir=${resolvedProfileDir}`,
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        startUrl,
      ],
      {
        stdio: "ignore",
      }
    );

    await waitForHealth(resolvedDaemonUrl, timeoutMs);
    const peerState = await waitForRelayPeer({
      daemonUrl: resolvedDaemonUrl,
      timeoutMs,
      requireTarget,
    });

    console.log("relay smoke passed");
    console.log(`daemon: ${resolvedDaemonUrl}`);
    console.log(`peer: ${peerState.peerId}`);
    if (peerState.targets !== null) {
      console.log(`targets: ${peerState.targets}`);
    }
    console.log(`profile: ${resolvedProfileDir}`);
    console.log(`url: ${startUrl}`);

    if (keepOpen) {
      console.log("processes left running due to --keep-open");
      daemonChild = null;
      chromeChild = null;
    }
  } finally {
    if (chromeChild) {
      chromeChild.kill("SIGTERM");
    }
    if (daemonChild) {
      daemonChild.kill("SIGTERM");
    }
    if (!keepOpen) {
      await rm(resolvedProfileDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function runCommand(command: string, argv: string[], extraEnv: Record<string, string> = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${argv.join(" ")} exited with code ${code ?? "unknown"}`));
    });
    child.on("error", reject);
  });
}

async function resolveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve free daemon port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function resolveChromePath(explicitPath?: string): Promise<string> {
  const candidates = [
    explicitPath,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  throw new Error("no local Chrome executable found; pass --chrome-path or set TURNKEYAI_BROWSER_PATH");
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    try {
      await getJson(`${baseUrl}/health`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }

  throw new Error(`timed out waiting for daemon health | last error: ${lastError ?? "unknown"}`);
}

async function waitForRelayPeer(input: {
  daemonUrl: string;
  timeoutMs: number;
  requireTarget: boolean;
}): Promise<{ peerId: string; targets: number | null }> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    try {
      const peers = (await getJson(`${input.daemonUrl}/relay/peers`)) as Array<{
        peerId: string;
        status: "online" | "stale";
      }>;
      const matchedPeer = peers.find((item) => item.status === "online");
      if (matchedPeer) {
        if (!input.requireTarget) {
          return { peerId: matchedPeer.peerId, targets: null };
        }
        const targets = (await getJson(
          `${input.daemonUrl}/relay/targets?peerId=${encodeURIComponent(matchedPeer.peerId)}`
        )) as Array<{ relayTargetId: string }>;
        if (targets.length > 0) {
          return { peerId: matchedPeer.peerId, targets: targets.length };
        }
      }
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }

  throw new Error(`timed out waiting for relay peer | last error: ${lastError ?? "unknown"}`);
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error((json as { error?: string }).error ?? `${response.status} ${response.statusText}`);
  }
  return json;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
