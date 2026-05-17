#!/usr/bin/env node
// Copies the Control Center static bundle into the CLI dist tree so the
// bundled daemon ships with `/app` ready to serve. The bundle is built by
// @turnkeyai/control-center (Vite + React + TS) into
// packages/control-center/dist; this script copies that into
// packages/cli/dist/control-center, which is what resolveControlCenterAssetDir()
// probes at startup.

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoCli = path.resolve(here, "..");
const sourceDir = path.resolve(repoCli, "..", "control-center", "dist");
const targetDir = path.join(repoCli, "dist", "control-center");

const indexPath = path.join(sourceDir, "index.html");
if (!existsSync(indexPath)) {
  // Hard fail. The CLI build implicitly promises the daemon will be able to
  // serve /app — shipping a CLI bundle without the dashboard would mean the
  // daemon logs "(bundle not found)" at startup and users get an empty 404
  // when they run `turnkeyai app`. CI should refuse to publish that.
  console.error(
    `[copy-control-center] error: ${indexPath} is missing.\n` +
      `  Run 'npm run build --workspace @turnkeyai/control-center' first.`
  );
  process.exit(1);
}

// Reject suspiciously-tiny bundles. resolveControlCenterAssetDir() also
// applies a 32-byte floor; rejecting here too gives a clearer error than
// "daemon couldn't find the bundle at startup".
const indexSize = statSync(indexPath).size;
if (indexSize < 32) {
  console.error(
    `[copy-control-center] error: ${indexPath} is suspiciously small (${indexSize} bytes).`
  );
  process.exit(1);
}

// Wipe target before copying so deleted/renamed source assets don't linger
// in dist (CodeRabbit caught this on PR F).
mkdirSync(path.dirname(targetDir), { recursive: true });
rmSync(targetDir, { recursive: true, force: true });
cpSync(sourceDir, targetDir, { recursive: true });
console.info(`[copy-control-center] copied ${sourceDir} -> ${targetDir}`);
