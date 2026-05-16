import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

interface AppRuntimePaths {
  rootDir: string;
  configFile: string;
}

interface AppRuntimeConfig {
  port?: number;
  token?: string | null;
}

const DEFAULT_PORT = 4100;

function getRuntimePaths(): AppRuntimePaths {
  const rootDir =
    process.env.TURNKEYAI_HOME?.trim() || path.join(homedir(), ".turnkeyai");
  return {
    rootDir,
    configFile: path.join(rootDir, "config.json"),
  };
}

function readConfig(paths: AppRuntimePaths): AppRuntimeConfig | null {
  if (!existsSync(paths.configFile)) return null;
  try {
    return JSON.parse(readFileSync(paths.configFile, "utf8")) as AppRuntimeConfig;
  } catch {
    return null;
  }
}

function resolveDaemonBaseUrl(paths: AppRuntimePaths): string {
  if (process.env.TURNKEYAI_DAEMON_URL?.trim()) {
    return process.env.TURNKEYAI_DAEMON_URL.trim().replace(/\/$/, "");
  }
  const config = readConfig(paths);
  const port = process.env.TURNKEYAI_DAEMON_PORT?.trim()
    ? Number(process.env.TURNKEYAI_DAEMON_PORT.trim())
    : config?.port ?? DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

function resolveDaemonToken(paths: AppRuntimePaths): string | null {
  if (process.env.TURNKEYAI_DAEMON_TOKEN?.trim()) {
    return process.env.TURNKEYAI_DAEMON_TOKEN.trim();
  }
  return readConfig(paths)?.token ?? null;
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

function openInBrowser(url: string): void {
  const opener =
    platform() === "darwin"
      ? { cmd: "open", args: [url] }
      : platform() === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", url] }
        : { cmd: "xdg-open", args: [url] };
  const child = spawn(opener.cmd, opener.args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", (error) => {
    console.error(`failed to open browser: ${error.message}`);
    console.error(`open this URL manually:\n  ${url}`);
  });
  child.unref();
}

function buildDashboardUrl(baseUrl: string, token: string | null, route: string): string {
  const fragments: string[] = [];
  if (token) fragments.push(`token=${encodeURIComponent(token)}`);
  fragments.push(`route=${encodeURIComponent(route)}`);
  return `${baseUrl}/app#${fragments.join("&")}`;
}

function parseRoute(args: string[]): string {
  const idx = args.findIndex((arg) => arg === "--route");
  const next = idx >= 0 ? args[idx + 1] : undefined;
  if (next) return next;
  for (const arg of args) {
    if (arg.startsWith("--route=")) return arg.slice("--route=".length);
  }
  return "setup";
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export async function runAppCommand(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h") || args[0] === "help") {
    runAppHelp(0);
  }

  const paths = getRuntimePaths();
  const baseUrl = resolveDaemonBaseUrl(paths);
  const noOpen = hasFlag(args, "--no-open");
  const route = parseRoute(args);

  const healthy = await pingHealth(baseUrl);
  if (!healthy) {
    // Intentionally don't auto-start here. runDaemonStart owns its own
    // process.exit calls and would terminate this command in the
    // "existing-pid-but-unhealthy" edge case. Pointing the user at the
    // standard daemon command keeps lifecycle in one place.
    console.error(`daemon not reachable at ${baseUrl}.`);
    console.error("start it with: turnkeyai daemon start");
    process.exit(1);
  }

  const token = resolveDaemonToken(paths);
  if (!token) {
    console.error(
      "daemon token not found. Set TURNKEYAI_DAEMON_TOKEN or check ~/.turnkeyai/config.json."
    );
    process.exit(1);
  }

  const dashboardUrl = buildDashboardUrl(baseUrl, token, route);
  console.log(`opening ${baseUrl}/app (route: ${route})`);
  if (noOpen) {
    console.log("--no-open passed; copy this URL into your browser:");
    console.log(`  ${dashboardUrl}`);
    process.exit(0);
  }
  openInBrowser(dashboardUrl);
}

export function runAppHelp(exitCode: number): never {
  const lines = [
    "TurnkeyAI Control Center",
    "",
    "Usage:",
    "  turnkeyai app [--route <name>] [--no-open]",
    "",
    "Starts the daemon if needed, then opens the local Control Center in your",
    "default browser with the daemon token preloaded.",
    "",
    "Options:",
    "  --route <name>     Open a specific page (setup | bridge | agent). Default: setup",
    "  --no-open          Print the URL instead of launching a browser",
    "",
    "Environment:",
    "  TURNKEYAI_DAEMON_URL    Override daemon base URL (default http://127.0.0.1:4100)",
    "  TURNKEYAI_DAEMON_TOKEN  Override the daemon auth token",
  ];
  (exitCode === 0 ? console.log : console.error)(lines.join("\n"));
  process.exit(exitCode);
}
