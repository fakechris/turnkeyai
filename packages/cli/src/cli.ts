import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAppCommand } from "./app-command";
import { runBridgeNamespace } from "./bridge";
import { runDaemonNamespace } from "./daemon-commands";
import { runDoctor } from "./doctor";

type CliCommand = "daemon" | "tui" | "doctor" | "bridge" | "app";

const [, , command, ...args] = process.argv;

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp(0);
}

if (!isCliCommand(command)) {
  console.error(`Unknown command: ${command}`);
  printHelp(1);
}

void runCommand(command, args).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function isCliCommand(value: string): value is CliCommand {
  return (
    value === "daemon" ||
    value === "tui" ||
    value === "doctor" ||
    value === "bridge" ||
    value === "app"
  );
}

async function runCommand(command: CliCommand, commandArgs: string[]): Promise<void> {
  switch (command) {
    case "daemon":
      return runDaemonNamespace(commandArgs);
    case "bridge":
      return runBridgeNamespace(commandArgs);
    case "doctor":
      return runDoctor(commandArgs);
    case "tui":
      return spawnLegacyEntry("tui", commandArgs);
    case "app":
      return runAppCommand(commandArgs);
  }
}

async function spawnLegacyEntry(entryName: string, entryArgs: string[]): Promise<void> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const entryPath = path.join(currentDir, `${entryName}.js`);
  const child = spawn(process.execPath, [entryPath, ...entryArgs], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (error) => {
    console.error(`Failed to start ${entryName}:`, error);
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

function printHelp(exitCode: number): never {
  const lines = [
    "TurnkeyAI CLI",
    "",
    "Usage:",
    "  turnkeyai daemon start [--foreground]",
    "  turnkeyai daemon stop | restart | status | logs [--follow]",
    "  turnkeyai daemon                  Run daemon in foreground (legacy)",
    "  turnkeyai bridge install-extension | status | install-skill",
    "  turnkeyai app [--route onboarding|missions|approvals|agents|context|agent-connect|runtime|settings] [--no-open]",
    "  turnkeyai app install-launcher [--path <file>]",
    "  npm run app -- --no-open     Source-tree launcher when turnkeyai is not on PATH",
    "  npm run daemon:status        Source-tree status check when turnkeyai is not on PATH",
    "  turnkeyai doctor",
    "  turnkeyai tui",
    "",
    "Files:",
    "  ~/.turnkeyai/config.json          Token + port + transport (0600)",
    "  ~/.turnkeyai/data/                Default data dir (override: TURNKEYAI_DATA_DIR)",
    "  ~/.turnkeyai/logs/daemon.log      Detached daemon log",
    "",
    "Environment:",
    "  TURNKEYAI_HOME                    Override ~/.turnkeyai root",
    "  TURNKEYAI_DAEMON_PORT             Override the daemon listen port",
    "  TURNKEYAI_DAEMON_URL              Override the daemon base URL for CLI/TUI",
    "  TURNKEYAI_DAEMON_OPERATOR_TOKEN   Preferred token for local app + browser routes",
    "  TURNKEYAI_DAEMON_TOKEN            Legacy single-token override",
    "  TURNKEYAI_DAEMON_ADMIN_TOKEN      Admin-scoped token override",
    "  TURNKEYAI_DAEMON_READ_TOKEN       Read-scoped token override",
  ];

  const output = exitCode === 0 ? console.log : console.error;
  output(lines.join("\n"));
  process.exit(exitCode);
}
