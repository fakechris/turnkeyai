import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function getRuntimePaths() {
  const rootDir = process.env.TURNKEYAI_HOME?.trim() || path.join(homedir(), ".turnkeyai");
  return {
    rootDir,
    extensionsDir: path.join(rootDir, "extensions"),
    relayExtDir: path.join(rootDir, "extensions", "relay"),
    skillsDir: path.join(rootDir, "skills"),
    configFile: path.join(rootDir, "config.json"),
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

function resolveDaemonBaseUrl(paths: ReturnType<typeof getRuntimePaths>): string {
  if (process.env.TURNKEYAI_DAEMON_URL?.trim()) {
    return process.env.TURNKEYAI_DAEMON_URL.trim().replace(/\/$/, "");
  }
  const config = readConfig(paths.configFile);
  const envPort = process.env.TURNKEYAI_DAEMON_PORT?.trim();
  const port = envPort
    ? Number(envPort)
    : typeof config?.port === "number"
      ? (config.port as number)
      : 4100;
  return `http://127.0.0.1:${port}`;
}

function resolveDaemonToken(paths: ReturnType<typeof getRuntimePaths>): string | null {
  if (process.env.TURNKEYAI_DAEMON_TOKEN?.trim()) {
    return process.env.TURNKEYAI_DAEMON_TOKEN.trim();
  }
  return (readConfig(paths.configFile)?.token as string | undefined) ?? null;
}

function findRepoRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "packages"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function findPackagedExtensionDir(): string | null {
  // For globally-installed @turnkeyai/cli, the extension dist is bundled at
  // packages/cli/dist/extension (copied by scripts/copy-relay-extension.mjs
  // during the CLI build). bridge.js itself lives in that dist dir.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sibling = path.join(here, "extension");
    if (existsSync(path.join(sibling, "manifest.json"))) {
      return sibling;
    }
  } catch {
    // ignore — module URL may not be resolvable in unusual runners
  }
  return null;
}

function findRepoSourceExtensionDir(): string | null {
  const repoRoot = findRepoRoot();
  if (!repoRoot) return null;
  return path.join(repoRoot, "packages", "browser-relay-peer", "dist", "extension");
}

async function runNpmBuild(repoRoot: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "build:relay-extension"], {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export async function runBridgeInstallExtension(_args: string[]): Promise<void> {
  const paths = getRuntimePaths();

  // Prefer the dist bundled with the published CLI (works for `npm i -g`).
  let sourceDir = findPackagedExtensionDir();

  // Fall back to in-repo dist (developer flow). If missing, attempt to build.
  if (!sourceDir) {
    const repoSourceDir = findRepoSourceExtensionDir();
    const repoRoot = findRepoRoot();
    if (repoSourceDir && existsSync(repoSourceDir)) {
      sourceDir = repoSourceDir;
    } else if (repoRoot) {
      console.log("relay extension dist not found; building from source...");
      const code = await runNpmBuild(repoRoot);
      if (code !== 0) {
        console.error("relay extension build failed");
        process.exit(code);
      }
      if (repoSourceDir && existsSync(repoSourceDir)) {
        sourceDir = repoSourceDir;
      }
    }
  }

  if (!sourceDir) {
    console.error(
      "could not locate the relay extension dist. Expected one of:\n" +
        "  - <cli-install>/dist/extension (bundled with @turnkeyai/cli)\n" +
        "  - <repo>/packages/browser-relay-peer/dist/extension (from npm run build)\n" +
        "If you installed @turnkeyai/cli globally, reinstall — the extension should be bundled."
    );
    process.exit(1);
  }

  mkdirSync(paths.extensionsDir, { recursive: true });
  cpSync(sourceDir, paths.relayExtDir, { recursive: true });
  console.log(`relay extension installed to ${paths.relayExtDir}`);
  console.log("");
  console.log("next steps:");
  console.log("  1. open chrome://extensions in your browser");
  console.log("  2. enable Developer mode (top right)");
  console.log(`  3. Load unpacked -> ${paths.relayExtDir}`);
  console.log("");
  const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  spawn(opener, ["chrome://extensions"], { detached: true, stdio: "ignore" }).unref();
}

export async function runBridgeStatus(_args: string[]): Promise<void> {
  const paths = getRuntimePaths();
  const baseUrl = resolveDaemonBaseUrl(paths);
  const token = resolveDaemonToken(paths);
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await fetch(`${baseUrl}/bridge/status`, { headers });
    if (!response.ok) {
      console.error(`/bridge/status returned ${response.status}`);
      process.exit(1);
    }
    const status = await response.json();
    console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    console.error(`failed to reach ${baseUrl}/bridge/status: ${(error as Error).message}`);
    process.exit(1);
  }
}

export async function runBridgeInstallSkill(_args: string[]): Promise<void> {
  const paths = getRuntimePaths();
  mkdirSync(paths.skillsDir, { recursive: true });
  const baseUrl = resolveDaemonBaseUrl(paths);
  const skillPath = path.join(paths.skillsDir, "turnkeyai-browser-bridge.md");
  const openapiPath = path.join(paths.skillsDir, "turnkeyai-browser-bridge.openapi.json");
  writeFileSync(skillPath, buildSkillMarkdown(baseUrl));
  writeFileSync(openapiPath, JSON.stringify(buildOpenApiSchema(baseUrl), null, 2));
  console.log(`skill written to ${skillPath}`);
  console.log(`openapi written to ${openapiPath}`);
}

export function runBridgeHelp(exitCode: number): never {
  const lines = [
    "TurnkeyAI Bridge CLI",
    "",
    "Usage:",
    "  turnkeyai bridge install-extension   Build and install the relay extension",
    "  turnkeyai bridge status              Print /bridge/status as JSON",
    "  turnkeyai bridge install-skill       Write agent-skill descriptor + OpenAPI schema",
  ];
  (exitCode === 0 ? console.log : console.error)(lines.join("\n"));
  process.exit(exitCode);
}

export async function runBridgeNamespace(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    runBridgeHelp(0);
  }
  switch (sub) {
    case "install-extension":
      return runBridgeInstallExtension(rest);
    case "status":
      return runBridgeStatus(rest);
    case "install-skill":
      return runBridgeInstallSkill(rest);
    default:
      console.error(`unknown bridge subcommand: ${sub}`);
      runBridgeHelp(1);
  }
}

function buildSkillMarkdown(baseUrl: string): string {
  return [
    "# TurnkeyAI Browser Bridge",
    "",
    "Local browser automation through the TurnkeyAI daemon.",
    "",
    `Endpoint: ${baseUrl}/bridge/command`,
    `Auth: \`Authorization: Bearer <token>\` (see ~/.turnkeyai/config.json)`,
    "",
    "## Tier 1 tools (POST /bridge/command)",
    "",
    "Body shape: `{ tool: <name>, args?: <object>, sessionId?: <string> }`",
    "",
    "- `navigate` — open a URL in the ambient browser session. args: `{ url }`",
    "- `snapshot` — return an interactive-element snapshot with refIds for click/fill",
    "- `click` — click by refId, selector, text, or `{x,y}` coordinates",
    "- `fill` — type text into an input by refId/selector",
    "- `key` — dispatch a keyboard key (`Enter`, `Tab`, `Escape`, etc.)",
    "- `select` — choose an option in a `<select>` element",
    "- `screenshot` — full-viewport screenshot, or clip to `clipRefId`",
    "- `eval` — evaluate a JavaScript expression",
    "- `wait_for` — wait for a selector/url/text to appear",
    "- `upload` — upload a file to a native file input",
    "- `list_tabs` — enumerate open targets",
    "- `switch_tab` / `close_tab` — activate or close a target by id",
    "",
    "## Tier 2 (POST /bridge/advanced)",
    "",
    "`hover`, `drag`, `scroll`, `dialog`, `popup`, `download`, `storage`, `cookie`, `permission`, `probe`, `console`, `pdf`, `find_tab`, `network.*`",
    "",
    "## Expert lane (POST /bridge/expert; requires direct-cdp transport)",
    "",
    "`expert.list_targets`, `expert.attach`, `expert.send`, `expert.events`, `expert.detach`",
    "",
    "## Batch (POST /bridge/batch)",
    "",
    "Body: `{ actions: [{ tool, args }, ...], sessionId? }` — single round-trip for ordered actions.",
    "",
  ].join("\n");
}

function buildOpenApiSchema(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "TurnkeyAI Browser Bridge",
      version: "0.1.0",
      description: "Local browser automation facade",
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/bridge/status": {
        get: {
          summary: "Aggregate daemon + bridge status",
          responses: { "200": { description: "Status object" } },
        },
      },
      "/bridge/command": {
        post: {
          summary: "Single Tier-1 browser tool call (ambient session)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["tool"],
                  properties: {
                    tool: {
                      type: "string",
                      enum: [
                        "navigate",
                        "snapshot",
                        "click",
                        "fill",
                        "key",
                        "select",
                        "screenshot",
                        "eval",
                        "wait_for",
                        "upload",
                        "list_tabs",
                        "switch_tab",
                        "close_tab",
                      ],
                    },
                    args: { type: "object" },
                    sessionId: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Tool result" } },
        },
      },
    },
  };
}

