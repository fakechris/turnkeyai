import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

import { resolveDaemonCliToken } from "./daemon-token";

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

interface ProbeResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
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

async function probeAuthenticatedUrl(
  url: string,
  token: string | null
): Promise<ProbeResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetch(url, { headers, signal: controller.signal });
      return { ok: response.ok, statusCode: response.status };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "request failed";
}

function checkNodeVersion(): CheckResult {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "node version",
    status: major >= 24 ? "ok" : "fail",
    detail: `node ${process.versions.node} (need >= 24)`,
  };
}

function checkRuntimeDir(paths: ReturnType<typeof getRuntimePaths>): CheckResult {
  return {
    name: "runtime dir",
    status: existsSync(paths.rootDir) ? "ok" : "fail",
    detail: paths.rootDir,
  };
}

function checkConfig(paths: ReturnType<typeof getRuntimePaths>): CheckResult {
  const config = readConfig(paths.configFile);
  const token = resolveDaemonCliToken(process.env, config?.token, "read");
  if (!config) {
    if (token) {
      return {
        name: "config/auth",
        status: "warn",
        detail: `missing ${paths.configFile}; using ${token.scope} token from ${token.source}`,
      };
    }
    return {
      name: "config/auth",
      status: "fail",
      detail: `missing config and token (run 'turnkeyai daemon start' to generate ${paths.configFile})`,
    };
  }
  if (!token) {
    return {
      name: "config/auth",
      status: "fail",
      detail: `${paths.configFile} has no token and no TURNKEYAI_DAEMON_* token is set`,
    };
  }
  return {
    name: "config/auth",
    status: token.source === "config" ? "ok" : "warn",
    detail: token.source === "config"
      ? `${paths.configFile} (token present)`
      : `${paths.configFile} (using ${token.scope} token from ${token.source})`,
  };
}

function resolveTransportMode(paths: ReturnType<typeof getRuntimePaths>): string {
  const envTransport = process.env.TURNKEYAI_BROWSER_TRANSPORT?.trim();
  if (envTransport) return envTransport;
  const config = readConfig(paths.configFile);
  return typeof config?.transportMode === "string" && config.transportMode.trim()
    ? config.transportMode.trim()
    : "local";
}

function resolveDaemonBaseUrl(paths: ReturnType<typeof getRuntimePaths>): string {
  const config = readConfig(paths.configFile);
  const envPort = process.env.TURNKEYAI_DAEMON_PORT?.trim();
  const port = envPort ? Number(envPort) : typeof config?.port === "number" ? (config.port as number) : 4100;
  return process.env.TURNKEYAI_DAEMON_URL?.trim()?.replace(/\/$/, "") ?? `http://127.0.0.1:${port}`;
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
    return { name: `port ${port}`, status: "ok", detail: "available" };
  }
  if (daemonHealthy) {
    return { name: `port ${port}`, status: "ok", detail: "in use by healthy daemon" };
  }
  return {
    name: `port ${port}`,
    status: "fail",
    detail: "in use by another process (daemon /health is not responding)",
  };
}

async function checkDaemonHealth(paths: ReturnType<typeof getRuntimePaths>): Promise<CheckResult> {
  const baseUrl = resolveDaemonBaseUrl(paths);
  const healthy = await probeUrl(`${baseUrl}/health`);
  return {
    name: "daemon /health",
    status: healthy ? "ok" : "fail",
    detail: healthy ? baseUrl : `${baseUrl} unreachable`,
  };
}

async function checkDaemonApiAuth(
  paths: ReturnType<typeof getRuntimePaths>,
  daemonHealthy: boolean
): Promise<CheckResult> {
  const config = readConfig(paths.configFile);
  const token = resolveDaemonCliToken(process.env, config?.token, "read");
  const baseUrl = resolveDaemonBaseUrl(paths);
  if (!daemonHealthy) {
    return {
      name: "daemon api auth",
      status: "warn",
      detail: "skipped because daemon /health is unreachable",
    };
  }
  if (!token) {
    return {
      name: "daemon api auth",
      status: "fail",
      detail: "no read-capable daemon token available for /bridge/status",
    };
  }
  const result = await probeAuthenticatedUrl(`${baseUrl}/bridge/status`, token.token);
  if (result.ok) {
    return {
      name: "daemon api auth",
      status: "ok",
      detail: `/bridge/status accepted ${token.scope} token from ${token.source}`,
    };
  }
  if (result.statusCode === 401 || result.statusCode === 403) {
    return {
      name: "daemon api auth",
      status: "fail",
      detail: `/bridge/status rejected ${token.scope} token from ${token.source} (HTTP ${result.statusCode})`,
    };
  }
  return {
    name: "daemon api auth",
    status: "fail",
    detail: result.statusCode
      ? `/bridge/status returned HTTP ${result.statusCode}`
      : `/bridge/status unreachable: ${result.error ?? "request failed"}`,
  };
}

async function checkRelayExtension(
  paths: ReturnType<typeof getRuntimePaths>,
  transportMode: string
): Promise<CheckResult> {
  const manifestPath = path.join(paths.relayExtDir, "manifest.json");
  const relayRequired = transportMode === "relay";
  if (!existsSync(manifestPath)) {
    return {
      name: "relay extension",
      status: relayRequired ? "fail" : "warn",
      detail: relayRequired
        ? `required by relay transport but not installed (run 'turnkeyai bridge install-extension')`
        : `not installed; only required when TURNKEYAI_BROWSER_TRANSPORT=relay`,
    };
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string; name?: string };
    return {
      name: "relay extension",
      status: "ok",
      detail: `${manifest.name ?? "?"} v${manifest.version ?? "?"} at ${paths.relayExtDir}`,
    };
  } catch {
    return {
      name: "relay extension",
      status: relayRequired ? "fail" : "warn",
      detail: relayRequired
        ? `relay manifest unreadable at ${manifestPath}`
        : `relay manifest unreadable at ${manifestPath}; only required for relay transport`,
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
        status: "fail",
        detail: "TURNKEYAI_BROWSER_CDP_ENDPOINT is unset",
      };
    }
    const reachable = await probeUrl(`${endpoint}/json/version`);
    return {
      name: "direct-cdp endpoint",
      status: reachable ? "ok" : "fail",
      detail: reachable ? endpoint : `${endpoint} unreachable`,
    };
  }
  if (transport === "relay") {
    const endpoint = process.env.TURNKEYAI_BROWSER_RELAY_ENDPOINT?.trim();
    return {
      name: "relay endpoint",
      status: endpoint ? "ok" : "warn",
      detail: endpoint ? endpoint : "TURNKEYAI_BROWSER_RELAY_ENDPOINT is unset (defaults to local daemon)",
    };
  }
  return null;
}

export async function runDoctor(_args: string[]): Promise<void> {
  const paths = getRuntimePaths();
  const transportMode = resolveTransportMode(paths);
  const checks: CheckResult[] = [];
  checks.push(checkNodeVersion());
  checks.push(checkRuntimeDir(paths));
  checks.push(checkConfig(paths));
  const healthCheck = await checkDaemonHealth(paths);
  checks.push(await checkPort(paths, healthCheck.status === "ok"));
  checks.push(healthCheck);
  checks.push(await checkDaemonApiAuth(paths, healthCheck.status === "ok"));
  checks.push(await checkRelayExtension(paths, transportMode));
  const transport = await checkTransportSpecific();
  if (transport) checks.push(transport);

  let failed = 0;
  let warned = 0;
  for (const check of checks) {
    const mark = check.status === "ok" ? "ok  " : check.status;
    if (check.status === "fail") failed += 1;
    if (check.status === "warn") warned += 1;
    console.log(`[${mark}] ${check.name.padEnd(22)} ${check.detail}`);
  }
  console.log("");
  if (failed === 0) {
    if (warned === 0) {
      console.log("turnkeyai doctor: all checks passed");
    } else {
      console.log(`turnkeyai doctor: ${warned} warning(s), no failures`);
    }
    process.exit(0);
  }
  console.error(`turnkeyai doctor: ${failed} check(s) failed, ${warned} warning(s)`);
  process.exit(1);
}
