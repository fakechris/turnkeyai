import { access, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

export async function prepareRelayExtensionRuntimeDir(input: {
  sourceDir: string;
  targetDir: string;
}): Promise<string> {
  await access(path.join(input.sourceDir, "manifest.json"));
  await rm(input.targetDir, { recursive: true, force: true });
  await mkdir(path.dirname(input.targetDir), { recursive: true });
  await cp(input.sourceDir, input.targetDir, {
    recursive: true,
    force: true,
  });
  await access(path.join(input.targetDir, "manifest.json"));
  return input.targetDir;
}
