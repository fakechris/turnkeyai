import { fileURLToPath } from "node:url";
import path from "node:path";

import { ensureDaemonRunning, type EnsureDaemonRunningResult } from "./daemon-commands";
import { spawnLegacyEntry } from "./legacy-entry";

export interface RunTuiCommandDeps {
  currentDir?: string;
  ensureRunning?: typeof ensureDaemonRunning;
  spawnEntry?: typeof spawnLegacyEntry;
  stdout?: Pick<typeof console, "log">;
  stderr?: Pick<typeof console, "error">;
  exit?: (code: number) => never;
}

export async function runTuiCommand(args: string[], deps: RunTuiCommandDeps = {}): Promise<void> {
  const noStart = args.includes("--no-start");
  const passthroughArgs = args.filter((arg) => arg !== "--no-start");
  const wantsHelp = passthroughArgs.some((arg) => arg === "--help" || arg === "-h" || arg === "help");
  const currentDir = deps.currentDir ?? path.dirname(fileURLToPath(import.meta.url));
  const spawnEntry = deps.spawnEntry ?? spawnLegacyEntry;

  if (wantsHelp) {
    printTuiCommandHelp(deps);
    return;
  }

  if (!wantsHelp && !noStart) {
    const ensureRunning = deps.ensureRunning ?? ensureDaemonRunning;
    const result = await ensureRunning();
    if (!handleEnsureDaemonResult(result, deps)) {
      return;
    }
  }

  return spawnEntry("tui", passthroughArgs, currentDir);
}

export function printTuiCommandHelp(deps: Pick<RunTuiCommandDeps, "stdout"> = {}): void {
  const stdout = deps.stdout ?? console;
  stdout.log(
    [
      "TurnkeyAI TUI",
      "",
      "Usage:",
      "  turnkeyai tui [--no-start]",
      "  turnkeyai tui --help",
      "",
      "Starts the local daemon when needed, then opens the interactive mission workbench TUI.",
      "",
      "Options:",
      "  --no-start    Do not auto-start the daemon; show startup diagnostics from the TUI only.",
      "",
      "Source checkout:",
      "  npm run tui",
    ].join("\n")
  );
}

function handleEnsureDaemonResult(result: EnsureDaemonRunningResult, deps: RunTuiCommandDeps): boolean {
  const stdout = deps.stdout ?? console;
  const stderr = deps.stderr ?? console;
  const exit = deps.exit ?? process.exit;
  switch (result.kind) {
    case "already-running":
      return true;
    case "started":
      stdout.log(`daemon started (pid ${result.pid}) at ${result.baseUrl}`);
      return true;
    case "failed-to-start":
      stderr.error(`daemon failed to become healthy within 10s at ${result.baseUrl}`);
      stderr.error(`check logs at ${result.logFile}`);
      exit(1);
      return false;
    case "stuck-daemon":
      stderr.error(`pid ${result.pid} owns the daemon port at ${result.baseUrl} but /health is unresponsive.`);
      stderr.error(`check logs at ${result.logFile} and investigate the process before retrying.`);
      stderr.error("if you confirm pid is your daemon: `turnkeyai daemon stop` (or kill it manually) and re-run.");
      exit(1);
      return false;
  }
}
