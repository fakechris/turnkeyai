import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

import { ensureDaemonRunning } from "./daemon-commands";

interface AppRuntimePaths {
  rootDir: string;
  configFile: string;
}

interface AppRuntimeConfig {
  port?: number;
  token?: string | null;
}

/**
 * The auth scope the resolved token most-likely grants. The dashboard uses
 * this to decide whether to show actionable mutation snippets (Agent
 * Connect's POST /bridge/command curl) or a downgraded read-only hint.
 *
 * "unknown" covers the legacy single-token config — the daemon's token-mode
 * gives the same token admin powers, but we can't *prove* that just by
 * looking at process.env. The dashboard treats "unknown" as "probably
 * operator+" and shows the full snippet, since refusing to is a worse UX
 * than the rare false positive.
 */
export type AppTokenScope = "read" | "operator" | "admin" | "unknown";

export interface ResolvedAppToken {
  token: string;
  scope: AppTokenScope;
  /** Where this token came from — for diagnostics, not for trust decisions. */
  source: "env" | "config";
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

/**
 * Pure token resolver. Exposed for unit tests.
 *
 * Priority (codex PR I correction): the prior PR F implementation preferred
 * READ first to be "least privilege", but the dashboard's Agent Connect
 * page renders a `POST /bridge/command` curl snippet — which needs
 * operator scope. A read-only token in that snippet would 401 silently and
 * break the user's plug-an-agent workflow. So we prefer scopes the dashboard
 * can ACTUALLY use:
 *
 *   1. Legacy TURNKEYAI_DAEMON_TOKEN → scope: "unknown"
 *      (single-token setups grant admin; treat as "good enough" without
 *      claiming a specific level)
 *   2. TURNKEYAI_DAEMON_OPERATOR_TOKEN → scope: "operator"
 *      (the sweet spot — covers /bridge/command + browser routes, not
 *      validation/admin)
 *   3. TURNKEYAI_DAEMON_ADMIN_TOKEN → scope: "admin"
 *      (works for everything, but only chosen if no operator-token is set)
 *   4. TURNKEYAI_DAEMON_READ_TOKEN → scope: "read"
 *      (last resort; the dashboard pages still render, but Agent Connect
 *      shows a warning and hides the mutation snippet)
 *   5. config.token → scope: "unknown"
 *      (legacy single-token written to ~/.turnkeyai/config.json on first
 *      daemon start)
 */
export function resolveAppToken(env: NodeJS.ProcessEnv, configToken: string | null): ResolvedAppToken | null {
  const legacy = env.TURNKEYAI_DAEMON_TOKEN?.trim();
  if (legacy) return { token: legacy, scope: "unknown", source: "env" };
  const operator = env.TURNKEYAI_DAEMON_OPERATOR_TOKEN?.trim();
  if (operator) return { token: operator, scope: "operator", source: "env" };
  const admin = env.TURNKEYAI_DAEMON_ADMIN_TOKEN?.trim();
  if (admin) return { token: admin, scope: "admin", source: "env" };
  const read = env.TURNKEYAI_DAEMON_READ_TOKEN?.trim();
  if (read) return { token: read, scope: "read", source: "env" };
  if (configToken && configToken.length > 0) {
    return { token: configToken, scope: "unknown", source: "config" };
  }
  return null;
}

function resolveDaemonToken(paths: AppRuntimePaths): ResolvedAppToken | null {
  const cfg = readConfig(paths);
  return resolveAppToken(process.env, cfg?.token ?? null);
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
  // Windows: cmd.exe's `start` treats `&` as a command separator, so the
  // fragment "#token=...&route=..." would be chopped in half and break. Wrap
  // the URL in literal double quotes so `start` sees it as one argument. The
  // `""` second arg is the window title (start requires it when the first
  // quoted arg might be interpreted as the title).
  const opener =
    platform() === "darwin"
      ? { cmd: "open", args: [url] }
      : platform() === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", `"${url}"`] }
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

/**
 * Builds the dashboard URL with token + scope in the URL fragment. The
 * scope is included so the dashboard can branch its Agent Connect snippet
 * BEFORE its first API call — no flicker between "showing curl" and
 * "showing scope warning". Exposed for unit tests.
 */
export function buildDashboardUrl(
  baseUrl: string,
  token: string | null,
  scope: AppTokenScope | null,
  route: string
): string {
  const fragments: string[] = [];
  if (token) fragments.push(`token=${encodeURIComponent(token)}`);
  if (scope) fragments.push(`scope=${encodeURIComponent(scope)}`);
  fragments.push(`route=${encodeURIComponent(route)}`);
  return `${baseUrl}/app#${fragments.join("&")}`;
}

/** Exposed for unit tests. Validates against a closed set of routes. */
export function parseAppRoute(args: string[]): string {
  const VALID = new Set(["setup", "bridge", "tabs", "agent", "diagnostics"]);
  const idx = args.findIndex((arg) => arg === "--route");
  const next = idx >= 0 ? args[idx + 1] : undefined;
  if (next && VALID.has(next)) return next;
  for (const arg of args) {
    if (arg.startsWith("--route=")) {
      const value = arg.slice("--route=".length);
      if (VALID.has(value)) return value;
    }
  }
  return "setup";
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/**
 * `turnkeyai app` — the canonical product entry point.
 *
 * Flow (PR I):
 *  1. Resolve daemon URL.
 *  2. Health-check it. If unhealthy, auto-start via ensureDaemonRunning.
 *  3. Resolve token (operator-first; see resolveAppToken docs).
 *  4. Open the dashboard with token + scope + route in URL fragment.
 *
 * --no-start (PR I): keep the old "don't auto-start" behavior for users
 * who explicitly want to manage the daemon themselves.
 */
export async function runAppCommand(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h") || args[0] === "help") {
    runAppHelp(0);
  }

  const paths = getRuntimePaths();
  const baseUrl = resolveDaemonBaseUrl(paths);
  const noOpen = hasFlag(args, "--no-open");
  const noStart = hasFlag(args, "--no-start");
  const route = parseAppRoute(args);

  let healthy = await pingHealth(baseUrl);
  if (!healthy) {
    if (noStart) {
      console.error(`daemon not reachable at ${baseUrl} (--no-start passed).`);
      console.error("start it with: turnkeyai daemon start");
      process.exit(1);
    }
    console.log(`daemon not reachable at ${baseUrl} — starting…`);
    const result = await ensureDaemonRunning();
    if (result.kind === "failed-to-start") {
      console.error(`daemon failed to become healthy within 10s at ${result.baseUrl}`);
      console.error(`check logs at ${result.logFile}`);
      process.exit(1);
    }
    if (result.kind === "already-running" && !result.healthy) {
      // PID exists but /health is silent — likely a stuck process. Don't
      // try to kill it (user might be debugging); tell the user to
      // restart explicitly.
      console.error(
        `daemon pid ${result.pid} is running at ${result.baseUrl} but /health is unresponsive.`
      );
      console.error("try: turnkeyai daemon restart");
      process.exit(1);
    }
    if (result.kind === "started") {
      console.log(`daemon started (pid ${result.pid}) at ${result.baseUrl}`);
    }
    healthy = await pingHealth(baseUrl);
    if (!healthy) {
      console.error(`daemon still unreachable at ${baseUrl}; aborting`);
      process.exit(1);
    }
  }

  const resolved = resolveDaemonToken(paths);
  if (!resolved) {
    console.error(
      "daemon token not found. Set TURNKEYAI_DAEMON_TOKEN or check ~/.turnkeyai/config.json."
    );
    process.exit(1);
  }

  const dashboardUrl = buildDashboardUrl(baseUrl, resolved.token, resolved.scope, route);
  console.log(`opening ${baseUrl}/app (route: ${route}, scope: ${resolved.scope})`);
  if (resolved.scope === "read") {
    // PR I gap 2: read-only token in the dashboard means Agent Connect
    // can render a snippet that 401s. Warn at the CLI so the user knows
    // the dashboard will show a downgraded panel.
    console.log(
      "note: only a TURNKEYAI_DAEMON_READ_TOKEN is configured — Agent Connect will show a warning and hide the POST /bridge/command snippet."
    );
  }
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
    "  turnkeyai app [--route <name>] [--no-open] [--no-start]",
    "",
    "Auto-starts the daemon if it is not already running, then opens the local",
    "Control Center in your default browser with the daemon token preloaded.",
    "",
    "Options:",
    "  --route <name>     Open a specific page (setup | bridge | tabs | agent | diagnostics).",
    "                     Default: setup",
    "  --no-open          Print the URL instead of launching a browser",
    "  --no-start         Do not auto-start the daemon; require an existing one",
    "",
    "Environment:",
    "  TURNKEYAI_DAEMON_URL    Override daemon base URL (default http://127.0.0.1:4100)",
    "  TURNKEYAI_DAEMON_TOKEN  Legacy single-token override",
    "",
    "Token resolution (in order):",
    "  TURNKEYAI_DAEMON_TOKEN           (legacy; treated as full access)",
    "  TURNKEYAI_DAEMON_OPERATOR_TOKEN  (preferred — covers bridge + browser routes)",
    "  TURNKEYAI_DAEMON_ADMIN_TOKEN     (only chosen if no operator token is set)",
    "  TURNKEYAI_DAEMON_READ_TOKEN      (last resort; Agent Connect downgrades)",
    "  ~/.turnkeyai/config.json:token   (single-token fallback)",
  ];
  (exitCode === 0 ? console.log : console.error)(lines.join("\n"));
  process.exit(exitCode);
}
