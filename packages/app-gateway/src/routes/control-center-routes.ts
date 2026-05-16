import { readFile } from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

// Serves the Control Center static bundle (HTML/CSS/JS) at /app and /app/*.
//
// The bundle ships inside the @turnkeyai/cli package at
// packages/cli/control-center/ and is copied into dist/control-center during
// the CLI build. The daemon resolves the asset directory at startup; if the
// directory is missing (e.g. a developer running the daemon from source
// without having built the CLI), every /app request returns 404 instead of
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

  try {
    const body = await readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.statusCode = 200;
    res.setHeader("content-type", ASSET_EXTENSIONS[ext] ?? "application/octet-stream");
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
  } catch {
    sendPlainText(res, 404, "not found");
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
 * "../../etc/passwd") are rejected. Returns null on failure so the caller
 * can return a 404.
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
  const normalizedDir = path.resolve(assetDir);
  const joined = path.resolve(normalizedDir, decoded);
  const rel = path.relative(normalizedDir, joined);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return joined;
}

function sendPlainText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}
