import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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
        const resolved = resolveAssetPath(bundle.dir, "app.js");
        assert.equal(resolved, path.join(bundle.dir, "app.js"));
        const nested = resolveAssetPath(bundle.dir, "sub/nested.js");
        assert.equal(nested, path.join(bundle.dir, "sub", "nested.js"));
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
