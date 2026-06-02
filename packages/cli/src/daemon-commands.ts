import { spawn } from "node:child_process";
import { openSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDaemonCliToken } from "./daemon-token";

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

interface DaemonServicePaths {
  label: string;
  launchAgentFile: string;
  wrapperFile: string;
  envFile: string;
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

function getDaemonServicePaths(paths = getRuntimePaths()): DaemonServicePaths {
  const label = "com.turnkeyai.daemon";
  return {
    label,
    launchAgentFile: path.join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
    wrapperFile: path.join(paths.rootDir, "bin", "daemon-service.sh"),
    envFile: path.join(paths.rootDir, "daemon.env"),
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
  return resolveDaemonCliToken(process.env, readConfig(paths)?.token, "read")?.token ?? null;
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

/**
 * Attempts to bind 127.0.0.1:port. If we succeed, no one is listening — so
 * the daemon's port is free and any PID we read from the pid file points
 * at an unrelated recycled process (or a daemon that died but never cleaned
 * up). Used to distinguish "stale PID file" from "stuck daemon".
 */
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

function extractPortFromBaseUrl(baseUrl: string): number {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return DEFAULT_PORT;
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

export function hasRestartedDaemonProcess(
  previousPid: number | null,
  currentPid: number | null,
  previousPidAlive: boolean
): boolean {
  if (previousPid === null) return true;
  if (currentPid !== null && currentPid !== previousPid) return true;
  return !previousPidAlive;
}

async function waitForRestartedHealth(
  paths: DaemonRuntimePaths,
  baseUrl: string,
  previousPid: number | null,
  deadlineMs: number
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const currentPid = readPid(paths);
    const previousPidAlive = previousPid !== null && isAlive(previousPid);
    if (
      hasRestartedDaemonProcess(previousPid, currentPid, previousPidAlive) &&
      (await pingHealth(baseUrl, 1000))
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

interface FetchJsonResult {
  ok: boolean;
  statusCode?: number;
  json?: unknown;
  error?: string;
}

async function fetchJson(url: string, token: string | null, timeoutMs = 1500): Promise<FetchJsonResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return { ok: false, statusCode: response.status };
    return { ok: true, statusCode: response.status, json: await response.json() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "request failed";
}

interface DaemonLaunchCommand {
  executable: string;
  args: string[];
}

export function resolveDaemonLaunchCommand(currentDir = path.dirname(fileURLToPath(import.meta.url))): DaemonLaunchCommand {
  const packagedEntry = path.join(currentDir, "daemon.js");
  if (existsSync(packagedEntry)) {
    return { executable: process.execPath, args: [packagedEntry] };
  }

  const sourceEntry = path.resolve(currentDir, "../../app-gateway/src/daemon.ts");
  if (existsSync(sourceEntry)) {
    return { executable: process.execPath, args: ["--import", "tsx", sourceEntry] };
  }

  return { executable: process.execPath, args: [packagedEntry] };
}

export function resolveDaemonWorkingDirectory(launch: DaemonLaunchCommand, fallbackDir: string): string {
  const entry = launch.args.find((arg) => arg.endsWith("/daemon.ts") || arg.endsWith("\\daemon.ts") || arg.endsWith("/daemon.js") || arg.endsWith("\\daemon.js"));
  if (!entry) return fallbackDir;
  const normalized = entry.split(path.sep).join("/");
  const sourceMarker = "/packages/app-gateway/src/daemon.ts";
  if (normalized.endsWith(sourceMarker)) {
    return entry.slice(0, entry.length - sourceMarker.length);
  }
  return path.dirname(entry);
}

export interface MacLaunchAgentPlistInput {
  label: string;
  wrapperFile: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  environment?: Record<string, string | undefined>;
}

export function buildMacLaunchAgentPlist(input: MacLaunchAgentPlistInput): string {
  const environment = Object.entries(input.environment ?? {}).filter(([, value]) => typeof value === "string" && value.length > 0);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    "  <key>Label</key>",
    `  <string>${escapeXml(input.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${escapeXml(input.wrapperFile)}</string>`,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(input.workingDirectory)}</string>`,
    ...(environment.length > 0
      ? [
          "  <key>EnvironmentVariables</key>",
          "  <dict>",
          ...environment.flatMap(([key, value]) => [
            `    <key>${escapeXml(key)}</key>`,
            `    <string>${escapeXml(value ?? "")}</string>`,
          ]),
          "  </dict>",
        ]
      : []),
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(input.stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(input.stderrPath)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export interface DaemonServiceScriptInput {
  launch: DaemonLaunchCommand;
  envFile: string;
}

export function buildDaemonServiceScript(input: DaemonServiceScriptInput): string {
  const command = [input.launch.executable, ...input.launch.args].map(shellQuote).join(" ");
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    "",
    `ENV_FILE=${shellQuote(input.envFile)}`,
    'if [ -f "$ENV_FILE" ]; then',
    "  set -a",
    '  . "$ENV_FILE"',
    "  set +a",
    "fi",
    "",
    `exec ${command}`,
    "",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

/**
 * Outcome of an ensureDaemonRunning() call. Programmatic callers (e.g.
 * `turnkeyai app`) inspect this rather than relying on process.exit so the
 * caller can keep running — opening the browser, printing a tailored
 * message — after the daemon comes up.
 *
 * The "stuck-daemon" variant exists to defend against PID recycling: when
 * the pid file points at a live process AND the daemon's port is bound,
 * we treat it as a real (but unhealthy) daemon and refuse to act. When the
 * pid file points at a live process but the port is FREE, we infer the
 * pid is a recycled unrelated process; we silently clean the pid file
 * and fall through to start. (Killing the recycled pid would harm an
 * unrelated process — the original PR I message recommended that.)
 */
export type EnsureDaemonRunningResult =
  | { kind: "already-running"; pid: number; baseUrl: string; healthy: boolean }
  | { kind: "started"; pid: number; baseUrl: string; logFile: string; configFile: string }
  | { kind: "failed-to-start"; baseUrl: string; logFile: string }
  | { kind: "stuck-daemon"; pid: number; baseUrl: string; logFile: string };

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
  const port = extractPortFromBaseUrl(baseUrl);

  const existingPid = readPid(paths);
  if (existingPid && isAlive(existingPid)) {
    const healthy = await pingHealth(baseUrl);
    if (healthy) {
      return { kind: "already-running", pid: existingPid, baseUrl, healthy: true };
    }
    // PID is alive but /health didn't answer. Two possibilities:
    //   (a) Our daemon is genuinely stuck (port still bound).
    //   (b) The OS recycled `existingPid` to an unrelated process and our
    //       pid file is stale. In that case the daemon's port is FREE.
    // Distinguishing matters because the prior version suggested
    // `daemon restart` — which would SIGTERM `existingPid`. If (b), that
    // SIGTERMs an innocent process. So:
    if (await isPortFree(port)) {
      // Stale pid file — clean it up and fall through to start.
      try {
        unlinkSync(paths.pidFile);
      } catch {
        // best-effort; if we can't unlink the file the worst case is the
        // user sees a 'daemon failed to start' below.
      }
    } else {
      // Something is holding the port AND the pid is alive. Refuse, but
      // don't suggest a fix that could SIGKILL the unrelated pid.
      return { kind: "stuck-daemon", pid: existingPid, baseUrl, logFile: paths.logFile };
    }
  }

  const launch = resolveDaemonLaunchCommand();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(paths.logsDir, { recursive: true });
  const logFd = openSync(paths.logFile, "a", 0o600);
  const child = spawn(launch.executable, [...launch.args, ...args], {
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
    // eslint-disable-next-line no-fallthrough
    case "stuck-daemon":
      console.error(
        `pid ${result.pid} owns the daemon port at ${result.baseUrl} but /health is unresponsive.`
      );
      console.error(`check logs at ${result.logFile} and stop the process manually before retrying.`);
      process.exit(1);
  }
}

async function runDaemonForeground(args: string[]): Promise<void> {
  const launch = resolveDaemonLaunchCommand();
  const child = spawn(launch.executable, [...launch.args, ...args], {
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
    const [status, diagnostics, models] = await Promise.all([
      fetchJson(`${baseUrl}/bridge/status`, token),
      fetchJson(`${baseUrl}/diagnostics`, token),
      fetchJson(`${baseUrl}/models`, token),
    ]);
    if (status.ok && status.json && typeof status.json === "object") {
      console.log("api auth:   ok");
      const s = status.json as Record<string, unknown>;
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
    } else {
      const detail = status.statusCode
        ? formatApiAuthFailure(status.statusCode)
        : `/bridge/status unreachable: ${status.error ?? "request failed"}`;
      console.log(`api auth:   ${detail}`);
    }
    printDiagnosticsStatus(diagnostics);
    printModelsStatus(models);
  }

  process.exit(healthy ? 0 : 1);
}

function formatApiAuthFailure(statusCode: number): string {
  if (statusCode === 401 || statusCode === 403) {
    return [
      `/bridge/status returned HTTP ${statusCode}`,
      "(token rejected).",
      "Reopen Mission Control with `turnkeyai app`,",
      "or from a source checkout run `npm run app -- --no-open`.",
      "For CLI probes, check TURNKEYAI_DAEMON_READ_TOKEN or ~/.turnkeyai/config.json.",
    ].join(" ");
  }
  return `/bridge/status returned HTTP ${statusCode}`;
}

function printDiagnosticsStatus(result: FetchJsonResult): void {
  if (!result.ok || !result.json || typeof result.json !== "object") {
    const detail = result.statusCode
      ? `/diagnostics returned HTTP ${result.statusCode}`
      : `/diagnostics unreachable: ${result.error ?? "request failed"}`;
    console.log(`setup:      ${detail}`);
    return;
  }
  const snapshot = result.json as Record<string, unknown>;
  const readiness = snapshot.readiness as
    | { status?: string; checks?: Array<{ label?: string; status?: string; detail?: string; action?: string }> }
    | undefined;
  if (!readiness) {
    console.log("setup:      no readiness report");
    return;
  }
  console.log(`setup:      ${readiness.status ?? "unknown"}`);
  for (const check of readiness.checks ?? []) {
    const label = check.label ?? "check";
    const status = check.status ?? "unknown";
    const detail = check.detail ? ` - ${check.detail}` : "";
    console.log(`  check:    ${label} [${status}]${detail}`);
    if (check.action) {
      console.log(`            action: ${check.action}`);
    }
  }
}

function printModelsStatus(result: FetchJsonResult): void {
  if (!result.ok || !result.json || typeof result.json !== "object") {
    const detail = result.statusCode
      ? `/models returned HTTP ${result.statusCode}`
      : `/models unreachable: ${result.error ?? "request failed"}`;
    console.log(`models:     ${detail}`);
    return;
  }
  const report = result.json as {
    defaultSelection?: {
      ok?: boolean;
      chainId?: string;
      primaryModelId?: string;
      fallbackModelIds?: string[];
      error?: string;
    };
    models?: Array<{ id?: string; configured?: boolean; apiKeyEnv?: string }>;
  };
  const selection = report.defaultSelection;
  if (!selection?.ok || !selection.primaryModelId) {
    console.log(`models:     attention (${selection?.error ?? "no default selection"})`);
    return;
  }
  const fallbackIds = selection.fallbackModelIds ?? [];
  const route = selection.chainId
    ? `${selection.chainId}: ${selection.primaryModelId}${fallbackIds.length > 0 ? ` -> ${fallbackIds.join(" -> ")}` : ""}`
    : selection.primaryModelId;
  const primary = report.models?.find((model) => model.id === selection.primaryModelId);
  const missingFallbacks = fallbackIds.filter((id) => {
    const model = report.models?.find((candidate) => candidate.id === id);
    return model && !model.configured;
  });
  const modelStatus = primary?.configured
    ? missingFallbacks.length > 0
      ? `primary ok, ${missingFallbacks.length} fallback key(s) missing`
      : "ready"
    : `primary key missing (${primary?.apiKeyEnv ?? selection.primaryModelId})`;
  console.log(`models:     ${route}`);
  console.log(`model keys: ${modelStatus}`);
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

async function runLaunchctl(args: string[], options: { allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("launchctl", args, { stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(stderr.trim() || stdout.trim() || `launchctl ${args.join(" ")} failed with exit code ${exitCode}`));
        return;
      }
      resolve({ code: exitCode, stdout, stderr });
    });
  });
}

export function isTransientLaunchctlBootstrapError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Bootstrap failed: 5") || message.includes("Input/output error");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootstrapLaunchAgent(domain: string, launchAgentFile: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await runLaunchctl(["bootstrap", domain, launchAgentFile]);
      return;
    } catch (error) {
      if (!isTransientLaunchctlBootstrapError(error) || attempt === 5) {
        throw error;
      }
      await delay(Math.min(500 * 2 ** attempt, 4_000));
    }
  }
}

async function waitForLaunchAgentUnloaded(serviceName: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await runLaunchctl(["print", serviceName], { allowFailure: true });
    if (result.code !== 0) return;
    await delay(250);
  }
  throw new Error(`launchctl bootout did not unload ${serviceName} within 10s`);
}

function launchctlServiceName(label: string): string {
  return `gui/${process.getuid?.() ?? 501}/${label}`;
}

function currentServiceEnvironment(paths: DaemonRuntimePaths): Record<string, string | undefined> {
  return {
    TURNKEYAI_HOME: paths.rootDir,
    TURNKEYAI_MODEL_CATALOG: process.env.TURNKEYAI_MODEL_CATALOG,
    TURNKEYAI_DAEMON_PORT: process.env.TURNKEYAI_DAEMON_PORT,
    TURNKEYAI_DATA_DIR: process.env.TURNKEYAI_DATA_DIR,
    TURNKEYAI_BROWSER_TRANSPORT: process.env.TURNKEYAI_BROWSER_TRANSPORT,
    TURNKEYAI_BROWSER_CDP_ENDPOINT: process.env.TURNKEYAI_BROWSER_CDP_ENDPOINT,
    LLM_MODEL_NAME: process.env.LLM_MODEL_NAME,
  };
}

const DAEMON_ENV_CAPTURE_KEYS = [
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
] as const;

export function collectDaemonServiceCapturedEnv(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const key of DAEMON_ENV_CAPTURE_KEYS) {
    const value = env[key]?.trim();
    if (value) captured[key] = value;
  }
  return captured;
}

export function mergeDaemonEnvContent(
  existingContent: string,
  captured: Record<string, string>
): string {
  const entries = Object.entries(captured)
    .filter(([, value]) => value.trim())
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return existingContent;
  const keys = new Set(entries.map(([key]) => key));
  const lines = existingContent.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=/);
    return !match || !keys.has(match[1] ?? "");
  });
  while (filtered.length > 0 && filtered[filtered.length - 1] === "") {
    filtered.pop();
  }
  return [
    ...filtered,
    "",
    "# Captured by `turnkeyai daemon service install --capture-env`.",
    ...entries.map(([key, value]) => `${key}=${quoteShValue(value)}`),
    "",
  ].join("\n");
}

function quoteShValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildDaemonEnvTemplate(): string {
  return [
    "# TurnkeyAI daemon service environment.",
    "# This file is loaded by ~/.turnkeyai/bin/daemon-service.sh before the daemon starts.",
    "# Put local model/browser secrets here if they are not available to macOS LaunchAgents.",
    "# Keep this file mode 0600.",
    "",
    "# Example:",
    "# MINIMAX_API_KEY=...",
    "# OPENAI_API_KEY=sk-...",
    "# ANTHROPIC_API_KEY=sk-ant-...",
    "# TURNKEYAI_BROWSER_TRANSPORT=local",
    "# TURNKEYAI_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222",
    "",
  ].join("\n");
}

async function ensureDaemonEnvFile(paths: DaemonServicePaths, input: { captureEnv: boolean }): Promise<void> {
  const exists = existsSync(paths.envFile);
  const content = exists ? readFileSync(paths.envFile, "utf8") : buildDaemonEnvTemplate();
  const nextContent = input.captureEnv
    ? mergeDaemonEnvContent(content, collectDaemonServiceCapturedEnv())
    : content;
  if (!exists || nextContent !== content) {
    await writeFile(paths.envFile, nextContent, { mode: 0o600 });
  }
  await chmod(paths.envFile, 0o600);
}

export async function runDaemonServiceInstall(args: string[]): Promise<void> {
  if (platform() !== "darwin") {
    console.error("daemon service install currently supports macOS LaunchAgent only.");
    process.exit(1);
  }
  const noStart = args.includes("--no-start");
  const captureEnv = args.includes("--capture-env");
  const paths = getRuntimePaths();
  const service = getDaemonServicePaths(paths);
  const launch = resolveDaemonLaunchCommand();
  await mkdir(path.dirname(service.wrapperFile), { recursive: true });
  await mkdir(path.dirname(service.launchAgentFile), { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  await ensureDaemonEnvFile(service, { captureEnv });
  await writeFile(service.wrapperFile, buildDaemonServiceScript({ launch, envFile: service.envFile }), { mode: 0o700 });
  await chmod(service.wrapperFile, 0o700);
  await writeFile(
    service.launchAgentFile,
    buildMacLaunchAgentPlist({
      label: service.label,
      wrapperFile: service.wrapperFile,
      workingDirectory: resolveDaemonWorkingDirectory(launch, process.cwd()),
      stdoutPath: paths.logFile,
      stderrPath: paths.logFile,
      environment: currentServiceEnvironment(paths),
    }),
    { mode: 0o644 }
  );

  const serviceName = launchctlServiceName(service.label);
  if (!noStart) {
    const domain = `gui/${process.getuid?.() ?? 501}`;
    await runLaunchctl(["bootout", serviceName], { allowFailure: true });
    await waitForLaunchAgentUnloaded(serviceName);
    await bootstrapLaunchAgent(domain, service.launchAgentFile);
    await runLaunchctl(["enable", serviceName], { allowFailure: true });
    await runLaunchctl(["kickstart", "-k", serviceName], { allowFailure: true });
  }

  console.log(`daemon service installed: ${service.launchAgentFile}`);
  console.log(`wrapper: ${service.wrapperFile}`);
  console.log(`env:     ${service.envFile}`);
  if (captureEnv) {
    const captured = Object.keys(collectDaemonServiceCapturedEnv());
    console.log(
      captured.length > 0
        ? `captured env: ${captured.join(", ")}`
        : "captured env: none (no known provider keys were set in this shell)"
    );
  }
  if (noStart) {
    console.log("start:   launchctl bootstrap " + `gui/${process.getuid?.() ?? 501} ${service.launchAgentFile}`);
  } else {
    console.log(`status:  turnkeyai daemon service status`);
  }
}

export async function runDaemonServiceUninstall(_args: string[]): Promise<void> {
  if (platform() !== "darwin") {
    console.error("daemon service uninstall currently supports macOS LaunchAgent only.");
    process.exit(1);
  }
  const service = getDaemonServicePaths();
  await runLaunchctl(["bootout", launchctlServiceName(service.label)], { allowFailure: true });
  await rm(service.launchAgentFile, { force: true });
  console.log(`daemon service uninstalled: ${service.launchAgentFile}`);
  console.log(`kept env file: ${service.envFile}`);
}

export async function runDaemonServiceStatus(_args: string[]): Promise<void> {
  if (platform() !== "darwin") {
    console.error("daemon service status currently supports macOS LaunchAgent only.");
    process.exit(1);
  }
  const service = getDaemonServicePaths();
  console.log(`service: ${service.label}`);
  console.log(`plist:   ${existsSync(service.launchAgentFile) ? service.launchAgentFile : "(not installed)"}`);
  console.log(`wrapper: ${existsSync(service.wrapperFile) ? service.wrapperFile : "(missing)"}`);
  console.log(`env:     ${existsSync(service.envFile) ? service.envFile : "(missing)"}`);
  const result = await runLaunchctl(["print", launchctlServiceName(service.label)], { allowFailure: true });
  if (result.code === 0) {
    const state = result.stdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim();
    const pid = result.stdout.match(/\bpid = ([0-9]+)/)?.[1]?.trim();
    console.log(`launchd: ${state ?? "loaded"}${pid ? ` (pid ${pid})` : ""}`);
  } else {
    console.log("launchd: not loaded");
    process.exit(1);
  }
}

export async function runDaemonServiceRestart(_args: string[]): Promise<void> {
  if (platform() !== "darwin") {
    console.error("daemon service restart currently supports macOS LaunchAgent only.");
    process.exit(1);
  }
  const paths = getRuntimePaths();
  const service = getDaemonServicePaths(paths);
  if (!existsSync(service.launchAgentFile)) {
    console.error(`daemon service is not installed: ${service.launchAgentFile}`);
    console.error("install it with: turnkeyai daemon service install");
    process.exit(1);
  }

  const serviceName = launchctlServiceName(service.label);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const previousPid = readPid(paths);
  const loaded = await runLaunchctl(["print", serviceName], { allowFailure: true });
  if (loaded.code !== 0) {
    await bootstrapLaunchAgent(domain, service.launchAgentFile);
  }
  await runLaunchctl(["enable", serviceName], { allowFailure: true });
  await runLaunchctl(["kickstart", "-k", serviceName]);

  const baseUrl = resolveDaemonUrl(paths);
  const healthy = await waitForRestartedHealth(paths, baseUrl, previousPid, 15_000);
  if (!healthy) {
    console.error(`daemon service restarted but health check did not pass at ${baseUrl}`);
    process.exit(1);
  }
  console.log(`daemon service restarted: ${service.label}`);
  console.log(`url: ${baseUrl}`);
}

export function runDaemonServiceHelp(exitCode: number): never {
  const lines = [
    "TurnkeyAI daemon service",
    "",
    "Usage:",
    "  turnkeyai daemon service install [--no-start] [--capture-env]",
    "  turnkeyai daemon service restart",
    "  turnkeyai daemon service uninstall",
    "  turnkeyai daemon service status",
    "",
    "macOS files:",
    "  ~/Library/LaunchAgents/com.turnkeyai.daemon.plist",
    "  ~/.turnkeyai/bin/daemon-service.sh",
    "  ~/.turnkeyai/daemon.env",
    "",
    "Notes:",
    "  daemon.env is loaded before the daemon starts; put model/browser env vars there for persistent service runs.",
    "  --capture-env writes known provider API keys from the current shell into daemon.env (0600).",
  ];
  (exitCode === 0 ? console.log : console.error)(lines.join("\n"));
  process.exit(exitCode);
}

export async function runDaemonServiceNamespace(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    runDaemonServiceHelp(0);
  }
  switch (sub) {
    case "install":
      return runDaemonServiceInstall(rest);
    case "restart":
      return runDaemonServiceRestart(rest);
    case "uninstall":
      return runDaemonServiceUninstall(rest);
    case "status":
      return runDaemonServiceStatus(rest);
    default:
      console.error(`unknown daemon service subcommand: ${sub}`);
      runDaemonServiceHelp(1);
  }
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
    "  turnkeyai daemon service install|restart|uninstall|status",
    "  turnkeyai daemon                  (alias for start --foreground; legacy)",
    "",
    "Files:",
    "  ~/.turnkeyai/config.json          Token + port + transport",
    "  ~/.turnkeyai/data/                Daemon data dir (override with TURNKEYAI_DATA_DIR)",
    "  ~/.turnkeyai/logs/daemon.log      Detached daemon log",
    "  ~/.turnkeyai/daemon.pid           PID file",
    "  ~/.turnkeyai/daemon.env           Environment loaded by macOS service",
    "",
    "Environment:",
    "  TURNKEYAI_HOME                    Override ~/.turnkeyai root",
    "  TURNKEYAI_DAEMON_PORT             Override listen port (default 4100)",
    "  TURNKEYAI_DAEMON_URL              Override daemon base URL for CLI/TUI",
    "  TURNKEYAI_DAEMON_READ_TOKEN       Preferred token for status/diagnostics",
    "  TURNKEYAI_DAEMON_OPERATOR_TOKEN   Preferred token for local app + browser routes",
    "  TURNKEYAI_DAEMON_TOKEN            Legacy single-token override",
    "  TURNKEYAI_DAEMON_ADMIN_TOKEN      Admin-scoped token override",
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
    case "service":
      return runDaemonServiceNamespace(rest);
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
