import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
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

// What "a valid bundle directory" looks like.
//
// Vite output (PR J1+):
//   <dir>/index.html
//   <dir>/assets/index-<hash>.js
//   <dir>/assets/index-<hash>.css
//
// We can't probe a specific hashed filename — Vite changes the hash on
// every content change. Instead we require:
//   1. index.html exists, is a regular file, and is non-trivial in size
//   2. The bundle has at least one served asset (either:
//      a. an "assets/" directory with ≥1 file inside — Vite-style, or
//      b. ≥1 sibling .js file — vanilla legacy layout)
// Approach (b) is kept transitional so a dev with stale legacy assets
// still gets them served until they rebuild.
const REQUIRED_INDEX_FILE = "index.html";

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

// Real asset sizes today are 4.3K (CSS), 5.4K (HTML), 14.6K (JS). A
// generous floor of 32 bytes catches obvious truncation (cp died mid-copy,
// disk full, etc.) without false-positive rejecting some future minified
// build. The leaf-level read in control-center-routes.ts is what actually
// serves bytes; this check just biases candidate selection toward a
// bundle that's plausibly intact.
const MIN_BUNDLE_FILE_BYTES = 32;

function isCompleteBundle(dir: string): boolean {
  // index.html must exist as a real file (not a symlink, not a directory).
  // lstatSync — don't follow symlinks. A required bundle file should be
  // a regular file shipped inside the bundle dir; a symlink pointing to
  // /etc/hosts could otherwise satisfy isFile()+size>0 and win candidate
  // selection (codex 3rd-round #3).
  const indexPath = path.join(dir, REQUIRED_INDEX_FILE);
  try {
    const stats = lstatSync(indexPath);
    if (!stats.isFile()) return false;
    if (stats.size < MIN_BUNDLE_FILE_BYTES) return false;
  } catch {
    return false;
  }

  // At least one asset must be available to serve alongside index.html.
  // Vite emits hashed assets under `assets/` (we can't probe the exact
  // hashed filename); the legacy vanilla layout had sibling app.js/app.css.
  // Either is acceptable so a checked-out dev with a stale legacy bundle
  // still gets serving — until they rebuild.
  return hasViteAssetsDir(dir) || hasLegacyTopLevelAssets(dir);
}

function hasViteAssetsDir(dir: string): boolean {
  const assetsDir = path.join(dir, "assets");
  try {
    const stats = lstatSync(assetsDir);
    if (!stats.isDirectory()) return false;
    // At least one regular file inside.
    return readdirSync(assetsDir).some((name) => {
      try {
        const entry = lstatSync(path.join(assetsDir, name));
        return entry.isFile() && entry.size >= MIN_BUNDLE_FILE_BYTES;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function hasLegacyTopLevelAssets(dir: string): boolean {
  // Legacy vanilla layout had app.js + app.css siblings to index.html.
  // Require BOTH to be present (codex J1 review): index.html links both
  // files, so missing either yields a broken bundle (no JS bootstrap or
  // no styles). A partial bundle with only one of the two should fall
  // through to the next candidate, not be served as complete.
  for (const name of ["app.js", "app.css"] as const) {
    try {
      const stats = lstatSync(path.join(dir, name));
      if (!stats.isFile() || stats.size < MIN_BUNDLE_FILE_BYTES) return false;
    } catch {
      return false;
    }
  }
  return true;
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

  // Source checkout (PR J1+): packages/control-center is the canonical
  // home for the dashboard, built by Vite into packages/control-center/dist.
  // packages/app-gateway/src/daemon.ts → ../../control-center/dist
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    dirs.push(path.resolve(here, "..", "..", "..", "control-center", "dist"));
    dirs.push(path.resolve(here, "..", "..", "..", "..", "control-center", "dist"));
  } catch {}

  // Legacy source-checkout locations (PR F→I vanilla bundle). Kept so a
  // developer who built the OLD bundle still gets it served — but the new
  // Vite-built location is probed first.
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
