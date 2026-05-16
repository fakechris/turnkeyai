#!/usr/bin/env node
// Copies the Control Center static bundle (HTML/CSS/JS) into the CLI dist
// tree so the bundled daemon ships with `/app` ready to serve. The daemon's
// resolveControlCenterAssetDir() probes for this directory at startup.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoCli = path.resolve(here, "..");
const sourceDir = path.join(repoCli, "control-center");
const targetDir = path.join(repoCli, "dist", "control-center");

if (!existsSync(path.join(sourceDir, "index.html"))) {
  console.warn(
    `[copy-control-center] skipping: ${sourceDir} is missing index.html`
  );
  process.exit(0);
}

mkdirSync(path.dirname(targetDir), { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });
console.info(`[copy-control-center] copied ${sourceDir} -> ${targetDir}`);
