#!/usr/bin/env node
// Copies the built relay extension into the CLI dist tree so that
// `turnkeyai bridge install-extension` works for users who installed
// @turnkeyai/cli globally (i.e. outside a source checkout).

import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoCli = path.resolve(here, "..");
const relayDist = path.resolve(
  repoCli,
  "..",
  "browser-relay-peer",
  "dist",
  "extension"
);
const cliDistTarget = path.resolve(repoCli, "dist", "extension");

if (!existsSync(relayDist)) {
  console.warn(
    `[copy-relay-extension] skipping: ${relayDist} does not exist yet (run build:relay-extension first)`
  );
  process.exit(0);
}

mkdirSync(path.dirname(cliDistTarget), { recursive: true });
cpSync(relayDist, cliDistTarget, { recursive: true });
console.info(`[copy-relay-extension] copied ${relayDist} -> ${cliDistTarget}`);
