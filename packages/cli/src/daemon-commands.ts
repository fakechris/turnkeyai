import { spawn } from "node:child_process";
import { openSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 4100;

interface DaemonRuntimePaths {
  rootDir: string;
  dataDir: string;
  logsDir: string;
  logFile: string;
  pidFile: string;
  configFile: string;
  extensionsDir: string;
  skillsDir: string;
}

interface DaemonRuntimeConfig {
  port?: number;
  token?: string | null;
  transportMode?: string | null;
  dataDir?: string | null;
}

function getRuntimePaths(): DaemonRuntimePaths {
  const rootDir =
    process.env.TURNKEYAI_HOME?.trim() || path.join(homedir(), ".turnkeyai");
  return {
    rootDir,
    dataDir: path.join(rootDir, "data"),
    logsDir: path.join(rootDir, "logs"),
    logFile: path.join(rootDir, "logs", "daemon.log"),
    pidFile: path.join(rootDir, "daemon.pid"),
    configFile: path.join(rootDir, "config.json"),
    extensionsDir: path.join(rootDir, "extensions"),
    skillsDir: path.join(rootDir, "skills"),
  };
}

function readConfig(paths: DaemonRuntimePaths): DaemonRuntimeConfig | null {
  if (!existsSync(paths.configFile)) return null;
  try {
    return JSON.parse(readFileSync(paths.configFile, "utf8")) as DaemonRuntimeConfig;
  } catch {
    return null;
  }
}

function resolveDaemonUrl(paths: DaemonRuntimePaths): string {
  if (process.env.TURNKEYAI_DAEMON_URL?.trim()) {
    return process.env.TURNKEYAI_DAEMON_URL.trim().replace(/\/$/, "");
  }
  const config = readConfig(paths);
  const port = process.env.TURNKEYAI_DAEMON_PORT?.trim()
    ? Number(process.env.TURNKEYAI_DAEMON_PORT.trim())
    : config?.port ?? DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

function resolveDaemonToken(paths: DaemonRuntimePaths): string | null {
  if (process.env.TURNKEYAI_DAEMON_TOKEN?.trim()) {
    return process.env.TURNKEYAI_DAEMON_TOKEN.trim();
  }
  return readConfig(paths)?.token ?? null;
}

function readPid(paths: DaemonRuntimePaths): number | null {
  if (!existsSync(paths.pidFile)) return null;
  try {
    const pid = Number(readFileSync(paths.pidFile, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function pingHealth(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(baseUrl: string, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await pingHealth(baseUrl, 1000)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function fetchJson(url: string, token: string | null): Promise<unknown | null> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function findDaemonEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "daemon.js");
}

/**
 * Outcome of an ensureDaemonRunning() call. Programmatic callers (e.g.
 * `turnkeyai app`) inspect this rather than relying on process.exit so the
 * caller can keep running — opening the browser, printing a tailored
 * message — after the daemon comes up.
 */
export type EnsureDaemonRunningResult =
  | { kind: "already-running"; pid: number; baseUrl: string; healthy: boolean }
  | { kind: "started"; pid: number; baseUrl: string; logFile: string; configFile: string }
  | { kind: "failed-to-start"; baseUrl: string; logFile: string };

export interface EnsureDaemonRunningOptions {
  /** Args forwarded to the spawned daemon (kept empty in the common case). */
  args?: string[];
  /** How long to wait for /health to respond before giving up. */
  healthDeadlineMs?: number;
}

/**
 * Programmatic equivalent of `turnkeyai daemon start` that never calls
 * process.exit. Used by `turnkeyai app` so the CLI can keep running after
 * the daemon is up (open the browser, etc.).
 */
export async function ensureDaemonRunning(
  options: EnsureDaemonRunningOptions = {}
): Promise<EnsureDaemonRunningResult> {
  const args = options.args ?? [];
  const healthDeadlineMs = options.healthDeadlineMs ?? 10_000;
  const paths = getRuntimePaths();
  const baseUrl = resolveDaemonUrl(paths);

  const existingPid = readPid(paths);
  if (existingPid && isAlive(existingPid)) {
    const healthy = await pingHealth(baseUrl);
    return { kind: "already-running", pid: existingPid, baseUrl, healthy };
  }

  const entry = findDaemonEntry();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(paths.logsDir, { recursive: true });
  const logFd = openSync(paths.logFile, "a", 0o600);
  const child = spawn(process.execPath, [entry, ...args], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();

  const healthy = await waitForHealth(baseUrl, healthDeadlineMs);
  if (!healthy) {
    return { kind: "failed-to-start", baseUrl, logFile: paths.logFile };
  }
  return {
    kind: "started",
    pid: child.pid ?? -1,
    baseUrl,
    logFile: paths.logFile,
    configFile: paths.configFile,
  };
}

export async function runDaemonStart(args: string[]): Promise<void> {
  if (args.includes("--foreground") || args.includes("-f")) {
    return runDaemonForeground(args.filter((arg) => arg !== "--foreground" && arg !== "-f"));
  }
  const result = await ensureDaemonRunning({ args });
  switch (result.kind) {
    case "already-running":
      console.log(
        `daemon already running (pid ${result.pid})${result.healthy ? "" : " — health probe failed"}`
      );
      process.exit(0);
    // eslint-disable-next-line no-fallthrough
    case "started":
      console.log(`daemon started (pid ${result.pid}) at ${result.baseUrl}`);
      console.log(`logs: ${result.logFile}`);
      if (existsSync(result.configFile)) {
        console.log(`config: ${result.configFile}`);
      }
      return;
    case "failed-to-start":
      console.error(`daemon failed to become healthy within 10s at ${result.baseUrl}`);
      console.error(`check logs at ${result.logFile}`);
      process.exit(1);
  }
}

async function runDaemonForeground(args: string[]): Promise<void> {
  const entry = findDaemonEntry();
  const child = spawn(process.execPath, [entry, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("error", (error) => {
    console.error(`failed to start daemon: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

interface StopOutcome {
  alreadyStopped: boolean;
  stopped: boolean;
  pid: number | null;
  message: string;
}

async function stopDaemonInner(): Promise<StopOutcome> {
  const paths = getRuntimePaths();
  const pid = readPid(paths);
  if (!pid || !isAlive(pid)) {
    return {
      alreadyStopped: true,
      stopped: true,
      pid: null,
      message: "daemon not running",
    };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    return {
      alreadyStopped: false,
      stopped: false,
      pid,
      message: `failed to signal pid ${pid}: ${(error as Error).message}`,
    };
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return {
        alreadyStopped: false,
        stopped: true,
        pid,
        message: `daemon stopped (pid ${pid})`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    process.kill(pid, "SIGKILL");
    return {
      alreadyStopped: false,
      stopped: true,
      pid,
      message: `daemon force-killed (pid ${pid})`,
    };
  } catch (error) {
    return {
      alreadyStopped: false,
      stopped: false,
      pid,
      message: `failed to force-kill pid ${pid}: ${(error as Error).message}`,
    };
  }
}

export async function runDaemonStop(_args: string[]): Promise<void> {
  const result = await stopDaemonInner();
  if (result.stopped) {
    console.log(result.message);
    process.exit(0);
  }
  console.error(result.message);
  process.exit(1);
}

export async function runDaemonRestart(args: string[]): Promise<void> {
  const result = await stopDaemonInner();
  console.log(result.message);
  if (!result.stopped) {
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  await runDaemonStart(args);
}

export async function runDaemonStatus(_args: string[]): Promise<void> {
  const paths = getRuntimePaths();
  const pid = readPid(paths);
  const baseUrl = resolveDaemonUrl(paths);
  const token = resolveDaemonToken(paths);
  const healthy = await pingHealth(baseUrl);
  const alive = pid !== null && isAlive(pid);

  console.log(`pid:        ${pid ?? "(none)"}${alive ? " (alive)" : ""}`);
  console.log(`url:        ${baseUrl}`);
  console.log(`health:     ${healthy ? "ok" : "unreachable"}`);
  console.log(`config:     ${existsSync(paths.configFile) ? paths.configFile : "(none)"}`);
  console.log(`data dir:   ${paths.dataDir}`);
  console.log(`logs:       ${paths.logFile}`);

  if (healthy) {
    const status = await fetchJson(`${baseUrl}/bridge/status`, token);
    if (status && typeof status === "object") {
      const s = status as Record<string, unknown>;
      const transport = s.transport as { mode?: string; label?: string } | undefined;
      const relay = s.relay as { configured?: boolean; peerCount?: number; targetCount?: number } | undefined;
      const expert = s.expertLane as { available?: boolean } | undefined;
      const sessions = s.sessions as { count?: number } | undefined;
      console.log(`transport:  ${transport?.mode ?? "?"} (${transport?.label ?? "?"})`);
      if (relay?.configured) {
        console.log(`relay:      ${relay.peerCount ?? 0} peer(s), ${relay.targetCount ?? 0} target(s)`);
      }
      console.log(`expert:     ${expert?.available ? "available" : "unavailable"}`);
      console.log(`sessions:   ${sessions?.count ?? 0}`);
    }
  }

  process.exit(alive && healthy ? 0 : 1);
}

export async function runDaemonLogs(args: string[]): Promise<void> {
  const paths = getRuntimePaths();
  if (!existsSync(paths.logFile)) {
    console.error(`log file not found: ${paths.logFile}`);
    process.exit(1);
  }
  const follow = args.includes("--follow") || args.includes("-f");
  const tailArgs = follow ? ["-F", paths.logFile] : [paths.logFile];
  const child = spawn("tail", tailArgs, { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`tail failed: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

export function runDaemonHelp(exitCode: number): never {
  const lines = [
    "TurnkeyAI Daemon",
    "",
    "Usage:",
    "  turnkeyai daemon start [--foreground]",
    "  turnkeyai daemon stop",
    "  turnkeyai daemon restart",
    "  turnkeyai daemon status",
    "  turnkeyai daemon logs [--follow]",
    "  turnkeyai daemon                  (alias for start --foreground; legacy)",
    "",
    "Files:",
    "  ~/.turnkeyai/config.json          Token + port + transport",
    "  ~/.turnkeyai/data/                Daemon data dir (override with TURNKEYAI_DATA_DIR)",
    "  ~/.turnkeyai/logs/daemon.log      Detached daemon log",
    "  ~/.turnkeyai/daemon.pid           PID file",
    "",
    "Environment:",
    "  TURNKEYAI_HOME                    Override ~/.turnkeyai root",
    "  TURNKEYAI_DAEMON_PORT             Override listen port (default 4100)",
    "  TURNKEYAI_DAEMON_URL              Override daemon base URL for CLI/TUI",
    "  TURNKEYAI_DAEMON_TOKEN            Override the auth token",
    "  TURNKEYAI_DATA_DIR                Override the data directory",
    "  TURNKEYAI_BROWSER_TRANSPORT       local | relay | direct-cdp",
  ];
  (exitCode === 0 ? console.log : console.error)(lines.join("\n"));
  process.exit(exitCode);
}

export async function runDaemonNamespace(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    runDaemonHelp(0);
  }
  switch (sub) {
    case "start":
      return runDaemonStart(rest);
    case "stop":
      return runDaemonStop(rest);
    case "restart":
      return runDaemonRestart(rest);
    case "status":
      return runDaemonStatus(rest);
    case "logs":
      return runDaemonLogs(rest);
    default: {
      const looksLikeFlag = sub.startsWith("-");
      if (looksLikeFlag) {
        return runDaemonForeground(args);
      }
      console.error(`unknown daemon subcommand: ${sub}`);
      runDaemonHelp(1);
    }
  }
}
