import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(desktopDir, "dist", "release");
await rm(releaseDir, { recursive: true, force: true });
console.info(`[desktop] cleaned ${releaseDir}`);
