import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.resolve(desktopDir, "..", "control-center", "dist");
const targetDir = path.join(desktopDir, "dist", "runtime", "control-center");
const playwrightSourceDir = path.resolve(desktopDir, "..", "..", "node_modules", "playwright-core");
const playwrightTargetDir = path.join(
  desktopDir,
  "dist",
  "runtime",
  "node_modules",
  "playwright-core"
);
const indexFile = path.join(sourceDir, "index.html");

const indexStats = await stat(indexFile).catch(() => null);
if (!indexStats?.isFile() || indexStats.size < 64) {
  throw new Error(`Control Center build is missing or incomplete: ${indexFile}`);
}

await rm(targetDir, { recursive: true, force: true });
await mkdir(path.dirname(targetDir), { recursive: true });
await cp(sourceDir, targetDir, { recursive: true });
console.info(`[desktop] copied Control Center into ${targetDir}`);

const playwrightPackage = await stat(path.join(playwrightSourceDir, "package.json")).catch(() => null);
if (!playwrightPackage?.isFile()) {
  throw new Error(`playwright-core is missing: ${playwrightSourceDir}`);
}
await rm(playwrightTargetDir, { recursive: true, force: true });
await mkdir(path.dirname(playwrightTargetDir), { recursive: true });
await cp(playwrightSourceDir, playwrightTargetDir, { recursive: true });
console.info(`[desktop] copied playwright-core into ${playwrightTargetDir}`);
