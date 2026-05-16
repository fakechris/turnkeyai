import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

import {
  handleControlCenterRoutes,
  matchControlCenterPath,
  resolveAssetPath,
} from "./control-center-routes";

function createRequest(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
}): http.IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: input.method,
    url: input.url,
    headers: input.headers ?? {},
  }) as unknown as http.IncomingMessage;
}

function createResponse(): {
  res: http.ServerResponse;
  headers: Map<string, string>;
  getBody: () => Buffer;
  getStatus: () => number;
} {
  let payload: Buffer | string = Buffer.alloc(0);
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk?: Buffer | string) {
      payload = chunk ?? Buffer.alloc(0);
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    headers,
    getStatus: () => res.statusCode,
    getBody: () =>
      typeof payload === "string" ? Buffer.from(payload) : (payload as Buffer),
  };
}

function makeBundle(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-cc-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>CC</title>");
  writeFileSync(path.join(dir, "app.css"), ":root{}");
  writeFileSync(path.join(dir, "app.js"), "console.log('cc')");
  mkdirSync(path.join(dir, "sub"));
  writeFileSync(path.join(dir, "sub", "nested.js"), "/* nested */");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("control-center-routes", () => {
  describe("matchControlCenterPath", () => {
    it("maps /app and /app/ to index.html", () => {
      assert.equal(matchControlCenterPath("/app"), "index.html");
      assert.equal(matchControlCenterPath("/app/"), "index.html");
    });

    it("strips the /app/ prefix from subpaths", () => {
      assert.equal(matchControlCenterPath("/app/app.js"), "app.js");
      assert.equal(matchControlCenterPath("/app/sub/x.js"), "sub/x.js");
    });

    it("ignores unrelated paths", () => {
      assert.equal(matchControlCenterPath("/bridge/status"), null);
      assert.equal(matchControlCenterPath("/app-extra"), null);
      assert.equal(matchControlCenterPath("/"), null);
    });
  });

  describe("resolveAssetPath", () => {
    it("rejects path traversal attempts", () => {
      const bundle = makeBundle();
      try {
        assert.equal(resolveAssetPath(bundle.dir, "../etc/passwd"), null);
        assert.equal(resolveAssetPath(bundle.dir, "..%2Fpasswd"), null);
        assert.equal(resolveAssetPath(bundle.dir, "sub/../../escape"), null);
      } finally {
        bundle.cleanup();
      }
    });

    it("rejects NUL bytes", () => {
      const bundle = makeBundle();
      try {
        assert.equal(resolveAssetPath(bundle.dir, "app.js%00"), null);
      } finally {
        bundle.cleanup();
      }
    });

    it("resolves normal relative paths", () => {
      const bundle = makeBundle();
      try {
        // Compare via realpath since macOS resolves /var/folders/... to
        // /private/var/folders/... (and Linux /tmp could be a symlink too).
        const expectedRoot = realpathSync(bundle.dir);
        const resolved = resolveAssetPath(bundle.dir, "app.js");
        assert.equal(resolved, path.join(expectedRoot, "app.js"));
        const nested = resolveAssetPath(bundle.dir, "sub/nested.js");
        assert.equal(nested, path.join(expectedRoot, "sub", "nested.js"));
      } finally {
        bundle.cleanup();
      }
    });

    it("rejects symlinks that escape the bundle directory (codex S1)", () => {
      // A lexical "../" check is not enough — if an attacker can write to the
      // bundle dir (or a developer accidentally checks in a stray symlink),
      // a symlink named e.g. "rogue.js" pointing at /etc/passwd would slip
      // through the path.relative guard but readFile would happily follow it.
      // Pin that resolveAssetPath canonicalizes via realpath and rejects.
      const bundle = makeBundle();
      const outside = mkdtempSync(path.join(tmpdir(), "tk-cc-outside-"));
      try {
        const secret = path.join(outside, "secret.txt");
        writeFileSync(secret, "top secret");
        const symlinkInBundle = path.join(bundle.dir, "rogue.js");
        symlinkSync(secret, symlinkInBundle);

        const resolved = resolveAssetPath(bundle.dir, "rogue.js");
        assert.equal(resolved, null, "symlink escape must be refused");
      } finally {
        rmSync(outside, { recursive: true, force: true });
        bundle.cleanup();
      }
    });

    it("allows symlinks that stay inside the bundle", () => {
      // Counter-test: a symlink pointing at another file IN the same bundle
      // (e.g. a "latest -> app.js" alias) should still resolve, so we know
      // we're not over-rejecting.
      const bundle = makeBundle();
      try {
        const alias = path.join(bundle.dir, "alias.js");
        symlinkSync(path.join(bundle.dir, "app.js"), alias);
        const resolved = resolveAssetPath(bundle.dir, "alias.js");
        assert.ok(resolved, "in-bundle symlink should resolve");
        assert.equal(path.basename(resolved!), "app.js");
      } finally {
        bundle.cleanup();
      }
    });
  });

  describe("handleControlCenterRoutes", () => {
    it("serves index.html for /app", async () => {
      const bundle = makeBundle();
      try {
        const { res, headers, getStatus, getBody } = createResponse();
        const handled = await handleControlCenterRoutes({
          req: createRequest({ method: "GET", url: "/app" }),
          res,
          url: new URL("http://127.0.0.1/app"),
          deps: { assetDir: bundle.dir },
        });
        assert.equal(handled, true);
        assert.equal(getStatus(), 200);
        assert.equal(headers.get("content-type"), "text/html; charset=utf-8");
        assert.equal(headers.get("x-content-type-options"), "nosniff");
        assert.match(getBody().toString("utf8"), /<!doctype html>/i);
      } finally {
        bundle.cleanup();
      }
    });

    it("serves css and js with the right content-type", async () => {
      const bundle = makeBundle();
      try {
        const css = createResponse();
        await handleControlCenterRoutes({
          req: createRequest({ method: "GET", url: "/app/app.css" }),
          res: css.res,
          url: new URL("http://127.0.0.1/app/app.css"),
          deps: { assetDir: bundle.dir },
        });
        assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");

        const js = createResponse();
        await handleControlCenterRoutes({
          req: createRequest({ method: "GET", url: "/app/app.js" }),
          res: js.res,
          url: new URL("http://127.0.0.1/app/app.js"),
          deps: { assetDir: bundle.dir },
        });
        assert.equal(
          js.headers.get("content-type"),
          "application/javascript; charset=utf-8"
        );
      } finally {
        bundle.cleanup();
      }
    });

    it("returns 404 with a friendly hint when the bundle dir is missing", async () => {
      const { res, getStatus, getBody } = createResponse();
      const handled = await handleControlCenterRoutes({
        req: createRequest({ method: "GET", url: "/app" }),
        res,
        url: new URL("http://127.0.0.1/app"),
        deps: { assetDir: null },
      });
      assert.equal(handled, true);
      assert.equal(getStatus(), 404);
      assert.match(getBody().toString("utf8"), /Control Center bundle/);
    });

    it("returns 404 for traversal attempts instead of leaking files", async () => {
      const bundle = makeBundle();
      try {
        const { res, getStatus } = createResponse();
        const handled = await handleControlCenterRoutes({
          req: createRequest({ method: "GET", url: "/app/../etc/passwd" }),
          res,
          url: new URL("http://127.0.0.1/app/../etc/passwd"),
          deps: { assetDir: bundle.dir },
        });
        // URL normalization in the Node URL parser collapses ../, so the
        // pathname here becomes "/etc/passwd" — outside the /app namespace —
        // and the handler must NOT claim it. Verify it returns false (not
        // handled) so the rest of the router gets a chance to respond 404.
        assert.equal(handled, false);
        assert.equal(getStatus(), 200); // unchanged: we never wrote a response
      } finally {
        bundle.cleanup();
      }
    });

    it("ignores non-GET methods", async () => {
      const bundle = makeBundle();
      try {
        const { res } = createResponse();
        const handled = await handleControlCenterRoutes({
          req: createRequest({ method: "POST", url: "/app" }),
          res,
          url: new URL("http://127.0.0.1/app"),
          deps: { assetDir: bundle.dir },
        });
        assert.equal(handled, false);
      } finally {
        bundle.cleanup();
      }
    });

    it("returns 404 for assets with extensions outside the allowlist (CR-1)", async () => {
      const bundle = makeBundle();
      try {
        // Drop a file with an unfamiliar extension into the bundle.
        writeFileSync(path.join(bundle.dir, "evil.exe"), "MZ\x00\x00");
        const { res, getStatus, getBody } = createResponse();
        const handled = await handleControlCenterRoutes({
          req: createRequest({ method: "GET", url: "/app/evil.exe" }),
          res,
          url: new URL("http://127.0.0.1/app/evil.exe"),
          deps: { assetDir: bundle.dir },
        });
        assert.equal(handled, true);
        assert.equal(getStatus(), 404);
        // Body should NOT leak the actual file contents.
        assert.equal(getBody().toString("utf8"), "not found");
      } finally {
        bundle.cleanup();
      }
    });

    it("returns 500 instead of 404 on permission read errors", async () => {
      // Skip on environments where chmod doesn't gate read (e.g. running as
      // root in CI). The point is to assert non-ENOENT errors surface as 500.
      if (process.getuid?.() === 0) return;
      const bundle = makeBundle();
      try {
        const target = path.join(bundle.dir, "locked.js");
        writeFileSync(target, "console.log('locked')");
        chmodSync(target, 0o000);
        const { res, getStatus } = createResponse();
        await handleControlCenterRoutes({
          req: createRequest({ method: "GET", url: "/app/locked.js" }),
          res,
          url: new URL("http://127.0.0.1/app/locked.js"),
          deps: { assetDir: bundle.dir },
        });
        assert.equal(getStatus(), 500);
        chmodSync(target, 0o600);
      } finally {
        bundle.cleanup();
      }
    });

    it("supports HEAD requests with content-length and no body", async () => {
      const bundle = makeBundle();
      try {
        const { res, headers, getStatus, getBody } = createResponse();
        const handled = await handleControlCenterRoutes({
          req: createRequest({ method: "HEAD", url: "/app" }),
          res,
          url: new URL("http://127.0.0.1/app"),
          deps: { assetDir: bundle.dir },
        });
        assert.equal(handled, true);
        assert.equal(getStatus(), 200);
        assert.ok(headers.get("content-length"));
        assert.equal(getBody().byteLength, 0);
      } finally {
        bundle.cleanup();
      }
    });
  });
});
