import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface LegacyEntryInvocation {
  command: string;
  args: string[];
  mode: "bundled" | "source" | "missing";
}

export interface LegacyEntryResolutionOptions {
  currentDir: string;
  execPath?: string;
}

export function resolveLegacyEntryInvocation(
  entryName: string,
  entryArgs: string[],
  options: LegacyEntryResolutionOptions
): LegacyEntryInvocation {
  const execPath = options.execPath ?? process.execPath;
  const bundledEntryPath = path.join(options.currentDir, `${entryName}.js`);
  if (existsSync(bundledEntryPath)) {
    return {
      command: execPath,
      args: [bundledEntryPath, ...entryArgs],
      mode: "bundled",
    };
  }

  const sourceEntryPath = path.resolve(
    options.currentDir,
    "..",
    "..",
    entryName,
    "src",
    `${entryName}.ts`
  );
  if (existsSync(sourceEntryPath)) {
    return {
      command: execPath,
      args: ["--import", "tsx", sourceEntryPath, ...entryArgs],
      mode: "source",
    };
  }

  return {
    command: execPath,
    args: [bundledEntryPath, ...entryArgs],
    mode: "missing",
  };
}

export async function spawnLegacyEntry(
  entryName: string,
  entryArgs: string[],
  currentDir: string
): Promise<void> {
  const invocation = resolveLegacyEntryInvocation(entryName, entryArgs, { currentDir });
  const child = spawn(invocation.command, invocation.args, {
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
