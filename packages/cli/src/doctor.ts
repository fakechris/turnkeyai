import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function getRuntimePaths() {
  const rootDir = process.env.TURNKEYAI_HOME?.trim() || path.join(homedir(), ".turnkeyai");
  return {
    rootDir,
    dataDir: path.join(rootDir, "data"),
    logsDir: path.join(rootDir, "logs"),
    logFile: path.join(rootDir, "logs", "daemon.log"),
    pidFile: path.join(rootDir, "daemon.pid"),
    configFile: path.join(rootDir, "config.json"),
    extensionsDir: path.join(rootDir, "extensions"),
    relayExtDir: path.join(rootDir, "extensions", "relay"),
  };
}

function readConfig(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function probeUrl(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

function checkNodeVersion(): CheckResult {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "node version",
    ok: major >= 24,
    detail: `node ${process.versions.node} (need >= 24)`,
  };
}

function checkRuntimeDir(paths: ReturnType<typeof getRuntimePaths>): CheckResult {
  return {
    name: "runtime dir",
    ok: existsSync(paths.rootDir),
    detail: paths.rootDir,
  };
}

function checkConfig(paths: ReturnType<typeof getRuntimePaths>): CheckResult {
  const config = readConfig(paths.configFile);
  if (!config) {
    return {
      name: "config file",
      ok: false,
      detail: `missing (run 'turnkeyai daemon start' to generate ${paths.configFile})`,
    };
  }
  const hasToken = typeof config.token === "string" && (config.token as string).length > 0;
  return {
    name: "config file",
    ok: hasToken,
    detail: `${paths.configFile}${hasToken ? "" : " (no token field)"}`,
  };
}

async function checkPort(
  paths: ReturnType<typeof getRuntimePaths>,
  daemonHealthy: boolean
): Promise<CheckResult> {
  const config = readConfig(paths.configFile);
  const envPort = process.env.TURNKEYAI_DAEMON_PORT?.trim();
  const port = envPort ? Number(envPort) : typeof config?.port === "number" ? (config.port as number) : 4100;
  const free = await isPortFree(port);
  if (free) {
    return { name: `port ${port}`, ok: true, detail: "available" };
  }
  if (daemonHealthy) {
    return { name: `port ${port}`, ok: true, detail: "in use by healthy daemon" };
  }
  return {
    name: `port ${port}`,
    ok: false,
    detail: "in use by another process (daemon /health is not responding)",
  };
}

async function checkDaemonHealth(paths: ReturnType<typeof getRuntimePaths>): Promise<CheckResult> {
  const config = readConfig(paths.configFile);
  const envPort = process.env.TURNKEYAI_DAEMON_PORT?.trim();
  const port = envPort ? Number(envPort) : typeof config?.port === "number" ? (config.port as number) : 4100;
  const baseUrl = process.env.TURNKEYAI_DAEMON_URL?.trim()?.replace(/\/$/, "") ?? `http://127.0.0.1:${port}`;
  const healthy = await probeUrl(`${baseUrl}/health`);
  return {
    name: "daemon /health",
    ok: healthy,
    detail: healthy ? baseUrl : `${baseUrl} unreachable`,
  };
}

async function checkRelayExtension(paths: ReturnType<typeof getRuntimePaths>): Promise<CheckResult> {
  const manifestPath = path.join(paths.relayExtDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      name: "relay extension",
      ok: false,
      detail: `not installed (run 'turnkeyai bridge install-extension')`,
    };
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string; name?: string };
    return {
      name: "relay extension",
      ok: true,
      detail: `${manifest.name ?? "?"} v${manifest.version ?? "?"} at ${paths.relayExtDir}`,
    };
  } catch {
    return {
      name: "relay extension",
      ok: false,
      detail: `manifest unreadable at ${manifestPath}`,
    };
  }
}

async function checkTransportSpecific(): Promise<CheckResult | null> {
  const transport = process.env.TURNKEYAI_BROWSER_TRANSPORT?.trim();
  if (transport === "direct-cdp") {
    const endpoint = process.env.TURNKEYAI_BROWSER_CDP_ENDPOINT?.trim();
    if (!endpoint) {
      return {
        name: "direct-cdp endpoint",
        ok: false,
        detail: "TURNKEYAI_BROWSER_CDP_ENDPOINT is unset",
      };
    }
    const reachable = await probeUrl(`${endpoint}/json/version`);
    return {
      name: "direct-cdp endpoint",
      ok: reachable,
      detail: reachable ? endpoint : `${endpoint} unreachable`,
    };
  }
  if (transport === "relay") {
    const endpoint = process.env.TURNKEYAI_BROWSER_RELAY_ENDPOINT?.trim();
    return {
      name: "relay endpoint",
      ok: Boolean(endpoint),
      detail: endpoint ? endpoint : "TURNKEYAI_BROWSER_RELAY_ENDPOINT is unset (defaults to local daemon)",
    };
  }
  return null;
}

export async function runDoctor(_args: string[]): Promise<void> {
  const paths = getRuntimePaths();
  const checks: CheckResult[] = [];
  checks.push(checkNodeVersion());
  checks.push(checkRuntimeDir(paths));
  checks.push(checkConfig(paths));
  const healthCheck = await checkDaemonHealth(paths);
  checks.push(await checkPort(paths, healthCheck.ok));
  checks.push(healthCheck);
  checks.push(await checkRelayExtension(paths));
  const transport = await checkTransportSpecific();
  if (transport) checks.push(transport);

  let failed = 0;
  for (const check of checks) {
    const mark = check.ok ? "ok " : "fail";
    if (!check.ok) failed += 1;
    console.log(`[${mark}] ${check.name.padEnd(22)} ${check.detail}`);
  }
  console.log("");
  if (failed === 0) {
    console.log("turnkeyai doctor: all checks passed");
    process.exit(0);
  }
  console.error(`turnkeyai doctor: ${failed} check(s) failed`);
  process.exit(1);
}

