import { spawn } from "node:child_process";

export interface SystemEditorCommand {
  command: string;
  args: string[];
}

export function resolveSystemEditorCommand(
  filePath: string,
  platform: NodeJS.Platform = process.platform
): SystemEditorCommand {
  if (platform === "darwin") {
    return { command: "open", args: ["-t", filePath] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", filePath] };
  }
  return { command: "xdg-open", args: [filePath] };
}

export async function openFileInSystemEditor(filePath: string): Promise<void> {
  await runSystemEditorCommand(resolveSystemEditorCommand(filePath));
}

export async function runSystemEditorCommand(opener: SystemEditorCommand): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opener.command, opener.args, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        signal
          ? `${opener.command} exited after signal ${signal}`
          : `${opener.command} exited with code ${code ?? "unknown"}`
      ));
    });
  });
}
