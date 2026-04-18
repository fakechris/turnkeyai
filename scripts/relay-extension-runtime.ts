import { access, cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function prepareRelayExtensionRuntimeDir(input: {
  sourceDir: string;
  targetDir: string;
}): Promise<string> {
  const sourceManifestPath = path.join(input.sourceDir, "manifest.json");
  const stagingDir = `${input.targetDir}.staging-${process.pid}-${Date.now()}`;
  const stagingManifestPath = path.join(stagingDir, "manifest.json");
  await ensureManifestExists(sourceManifestPath, "relay extension source missing manifest");
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(path.dirname(input.targetDir), { recursive: true });
  try {
    await cp(input.sourceDir, stagingDir, {
      recursive: true,
      force: true,
    });
    await ensureManifestExists(stagingManifestPath, "relay extension runtime copy missing manifest");
    await rm(input.targetDir, { recursive: true, force: true });
    await rename(stagingDir, input.targetDir);
    return input.targetDir;
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

async function ensureManifestExists(manifestPath: string, label: string): Promise<void> {
  try {
    await access(manifestPath);
  } catch (error) {
    throw new Error(`${label} at ${manifestPath}`, { cause: error });
  }
}
