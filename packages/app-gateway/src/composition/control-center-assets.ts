import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolves the on-disk location of the Control Center static bundle
// (index.html / app.css / app.js). The bundle is authored at
// packages/cli/control-center/ and copied into the CLI's dist tree during
// build. The daemon runs from multiple possible locations:
//
//   - source checkouts via tsx: packages/app-gateway/src/daemon.ts
//   - tsup-bundled daemon shipped with @turnkeyai/cli: <prefix>/dist/daemon.js
//   - workspace package build:    packages/cli/dist/daemon.js
//
// Each of those needs to point at the correct asset directory. We probe a
// small ordered list of candidates and return the first that contains
// index.html. Returning null is acceptable — the daemon still boots and the
// /app routes simply respond 404 with a hint to rebuild the CLI bundle.

// Files the dashboard cannot run without. If any are missing from a
// candidate directory we skip it — better to fall through to a later
// candidate (or a friendly 404) than to load index.html that immediately
// fails to fetch app.js.
const REQUIRED_BUNDLE_FILES = ["index.html", "app.css", "app.js"] as const;

export function resolveControlCenterAssetDir(
  options: { override?: string | null } = {}
): string | null {
  const override = options.override?.trim();
  if (override) {
    return isCompleteBundle(override) ? path.resolve(override) : null;
  }
  for (const candidate of candidateDirs()) {
    if (isCompleteBundle(candidate)) {
      return path.resolve(candidate);
    }
  }
  return null;
}

function isCompleteBundle(dir: string): boolean {
  // existsSync alone accepts a directory named "index.html" or a zero-byte
  // placeholder as "present" (codex re-review #3). Demand a regular file
  // with non-zero size, so a half-copied or corrupt bundle falls through
  // to the next candidate.
  return REQUIRED_BUNDLE_FILES.every((name) => {
    try {
      const stats = statSync(path.join(dir, name));
      return stats.isFile() && stats.size > 0;
    } catch {
      return false;
    }
  });
}

function candidateDirs(): string[] {
  const dirs: string[] = [];

  // Tsup bundles daemon.ts into a single file, but copy-control-center.mjs
  // (run during CLI build) places the bundle as a sibling: dist/control-center/.
  // For ESM, import.meta.url points at the bundled daemon.js — its sibling
  // directory is what we want.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    dirs.push(path.join(here, "control-center"));
    // When the daemon is bundled into the CLI dist tree but launched via
    // a symlink (e.g. `npm i -g`), realpath resolves the actual location.
    try {
      const real = realpathSync(here);
      if (real !== here) {
        dirs.push(path.join(real, "control-center"));
      }
    } catch {}
  } catch {}

  // Source checkout: packages/app-gateway/src/daemon.ts → ../../cli/control-center
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    dirs.push(path.resolve(here, "..", "..", "cli", "control-center"));
    dirs.push(path.resolve(here, "..", "..", "..", "cli", "control-center"));
  } catch {}

  // Allow operators to drop a custom bundle under TURNKEYAI_HOME for ad-hoc
  // iteration (e.g. while developing a fork of the dashboard).
  const home = process.env.TURNKEYAI_HOME?.trim();
  if (home) {
    dirs.push(path.join(home, "control-center"));
  }

  return dedupe(dirs);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}
