import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

// Serves the Control Center static bundle (HTML/CSS/JS + hashed assets)
// at /app and /app/*.
//
// PR J1+: the bundle is built by the @turnkeyai/control-center workspace
// (Vite + React + TS) into packages/control-center/dist, and the CLI's
// copy-control-center.mjs script copies that into packages/cli/dist/control-center.
// The daemon resolves the asset directory at startup; if the directory
// is missing (e.g. a developer running the daemon from source without
// having built the CLI), every /app request returns 404 instead of
// crashing — the rest of the API keeps working.

const ASSET_EXTENSIONS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export interface ControlCenterRouteDeps {
  /**
   * Absolute path to the directory containing index.html. Pass `null` when the
   * bundle is not available; the handler will respond with a friendly 404 so
   * the daemon stays usable.
   */
  assetDir: string | null;
}

export async function handleControlCenterRoutes(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  deps: ControlCenterRouteDeps;
}): Promise<boolean> {
  const { req, res, url, deps } = input;

  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }

  const matched = matchControlCenterPath(url.pathname);
  if (!matched) {
    return false;
  }

  if (!deps.assetDir) {
    sendPlainText(res, 404, [
      "Control Center bundle is not installed.",
      "Build the CLI package (npm -w @turnkeyai/cli run build) and restart the daemon.",
    ].join("\n"));
    return true;
  }

  const resolved = resolveAssetPath(deps.assetDir, matched);
  if (!resolved) {
    sendPlainText(res, 404, "not found");
    return true;
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = ASSET_EXTENSIONS[ext];
  if (!contentType) {
    // Enforce the allowlist. If a future asset extension lands without
    // updating ASSET_EXTENSIONS, we'd rather refuse to serve it than fall
    // back to application/octet-stream (which combined with nosniff is safe
    // but uselessly hides the misconfiguration from the operator).
    sendPlainText(res, 404, "not found");
    return true;
  }

  try {
    const body = await readFile(resolved);
    res.statusCode = 200;
    res.setHeader("content-type", contentType);
    // Tight cache for the HTML shell so users always get the latest router;
    // the assets reference fingerprint-free paths so the same applies. Keep
    // it private — this is a localhost dashboard, not a CDN-fronted page.
    res.setHeader("cache-control", "private, max-age=0, must-revalidate");
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method === "HEAD") {
      res.setHeader("content-length", String(body.byteLength));
      res.end();
    } else {
      res.end(body);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      sendPlainText(res, 404, "not found");
    } else {
      // Permission / IO failures shouldn't masquerade as 404 — surface them
      // so the operator can fix the underlying problem.
      sendPlainText(res, 500, "asset read failed");
    }
  }
  return true;
}

/**
 * Maps an incoming /app[...] pathname to a relative asset path beneath the
 * bundle directory. Returns null for paths outside the /app namespace.
 *
 * - `/app`        → `index.html`
 * - `/app/`       → `index.html`
 * - `/app/foo.js` → `foo.js`
 * - `/app/sub/x`  → `sub/x`
 *
 * Anything else returns null, which means the daemon's route table moves on
 * to other handlers.
 */
export function matchControlCenterPath(pathname: string): string | null {
  if (pathname === "/app" || pathname === "/app/") {
    return "index.html";
  }
  if (pathname.startsWith("/app/")) {
    const rest = pathname.slice("/app/".length);
    return rest.length > 0 ? rest : "index.html";
  }
  return null;
}

/**
 * Joins the requested relative path against the bundle root and verifies the
 * resolved file lives inside the bundle. Path-traversal attempts (e.g.
 * "../../etc/passwd") are rejected, AND symlink escapes are rejected by
 * canonicalizing both root and target via realpath before the containment
 * check (a lexical ".." check alone would happily follow a symlink that
 * points outside the bundle). Returns null on failure so the caller can
 * return a 404.
 *
 * Note: relative comes from url.pathname after stripping "/app/". URL.pathname
 * does NOT percent-decode (e.g. "/app/a%20b" → pathname "/app/a%20b"), so the
 * decodeURIComponent call here is required, not redundant. Without it,
 * filenames containing legitimately-encoded chars would never resolve.
 */
export function resolveAssetPath(assetDir: string, relative: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(relative);
    } catch {
      return null;
    }
  })();
  if (!decoded) return null;
  if (decoded.includes("\0")) return null;

  // Canonicalize the bundle root first. realpathSync follows symlinks and
  // returns the on-disk path; if the root itself is missing we bail out
  // (better to 404 than to silently serve from an unexpected location).
  const root = (() => {
    try {
      return realpathSync(path.resolve(assetDir));
    } catch {
      return null;
    }
  })();
  if (!root) return null;

  const joined = path.resolve(root, decoded);
  // Cheap lexical check first — catches "../" before we hit the filesystem.
  const lexicalRel = path.relative(root, joined);
  if (lexicalRel.startsWith("..") || path.isAbsolute(lexicalRel)) {
    return null;
  }

  // Now resolve symlinks. If the target file exists, realpathSync resolves
  // the entire chain; we verify the result still lives under root.
  try {
    const canonical = realpathSync(joined);
    const canonicalRel = path.relative(root, canonical);
    if (canonicalRel.startsWith("..") || path.isAbsolute(canonicalRel)) {
      return null;
    }
    return canonical;
  } catch {
    // Target doesn't exist (the common 404 path). DO NOT just return `joined`:
    // if a parent on the chain is a symlink that escapes the bundle, and the
    // missing file gets created after this check but before readFile (TOCTOU,
    // codex re-review #1), we'd serve outside-bundle content. Instead, walk
    // up to the deepest EXISTING ancestor, canonicalize that, and verify the
    // canonicalized ancestor is still inside root. Only then trust the
    // joined leaf — if an attacker can race a file into the missing leaf,
    // it'll appear under the canonicalized parent, which is still inside
    // the bundle by construction.
    let ancestor = path.dirname(joined);
    let realAncestor: string | null = null;
    while (ancestor.length > 0 && ancestor !== path.dirname(ancestor)) {
      try {
        realAncestor = realpathSync(ancestor);
        break;
      } catch {
        ancestor = path.dirname(ancestor);
      }
    }
    if (!realAncestor) return null;
    const ancestorRel = path.relative(root, realAncestor);
    if (ancestorRel !== "" && (ancestorRel.startsWith("..") || path.isAbsolute(ancestorRel))) {
      return null;
    }
    // Rebuild the path with the canonical ancestor + the missing-leaf suffix.
    const suffix = path.relative(ancestor, joined);
    return path.join(realAncestor, suffix);
  }
}

function sendPlainText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}
