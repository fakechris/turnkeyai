import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CliCommand = "daemon" | "tui";

const [, , command, ...args] = process.argv;

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp(0);
}

if (!isCliCommand(command)) {
  console.error(`Unknown command: ${command}`);
  printHelp(1);
}

runCommand(command, args);

function isCliCommand(value: string): value is CliCommand {
  return value === "daemon" || value === "tui";
}

function runCommand(command: CliCommand, args: string[]): void {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const entryPath = path.join(currentDir, `${command}.js`);
  const child = spawn(process.execPath, [entryPath, ...args], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (error) => {
    console.error(`Failed to start ${command}:`, error);
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
    "  turnkeyai daemon",
    "  turnkeyai tui",
    "",
    "Environment:",
    "  TURNKEYAI_DAEMON_PORT   Override the daemon listen port",
    "  TURNKEYAI_DAEMON_URL    Override the daemon base URL used by the TUI",
    "  TURNKEYAI_DAEMON_TOKEN  Require bearer auth for daemon requests",
  ];

  const output = exitCode === 0 ? console.log : console.error;
  output(lines.join("\n"));
  process.exit(exitCode);
}
