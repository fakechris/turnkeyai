#!/usr/bin/env node
// Ensures the control-center workspace is built before the CLI build
// tries to copy its dist tree.
//
// Why this script instead of putting `npm run build -w @turnkeyai/control-center`
// directly in the CLI's build script:
//   1. npm/yarn workspaces are tricky to invoke from inside a workspace
//      build — running `npm run build -w X` from inside workspace Y can
//      behave differently depending on which directory the build was
//      invoked from. Spawning explicitly from this script with cwd=repo
//      root works the same in every entry point.
//   2. We can skip the rebuild when the dist tree is already fresh,
//      avoiding redundant work when the root `npm run build` already
//      built control-center before reaching the CLI step.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const controlCenterDir = path.join(repoRoot, "packages", "control-center");
const controlCenterDist = path.join(controlCenterDir, "dist");
const indexHtml = path.join(controlCenterDist, "index.html");

if (!existsSync(controlCenterDir)) {
  console.error(`[build-control-center-dep] error: ${controlCenterDir} not found`);
  process.exit(1);
}

// If the dist is already present and the index.html is non-trivial, assume
// the bundle is fresh enough. (The root `npm run build` builds
// control-center before cli, so usually we land here as a no-op.)
if (existsSync(indexHtml) && statSync(indexHtml).size >= 32) {
  console.info(`[build-control-center-dep] using existing ${controlCenterDist}`);
  process.exit(0);
}

console.info(`[build-control-center-dep] building @turnkeyai/control-center…`);
const result = spawnSync("npm", ["run", "build", "-w", "@turnkeyai/control-center"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

if (result.status !== 0) {
  console.error(`[build-control-center-dep] control-center build failed (exit ${result.status})`);
  process.exit(result.status ?? 1);
}
