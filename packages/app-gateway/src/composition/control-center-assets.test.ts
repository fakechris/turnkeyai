import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { resolveControlCenterAssetDir } from "./control-center-assets";

function makeBundleDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-cc-assets-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Vite-style bundle: index.html at top level + hashed assets in /assets/.
// Bundle-completeness check (PR J1) requires the assets subdir to contain
// ≥1 regular file with non-trivial size (we can't probe the exact hash).
function writeViteBundle(dir: string): void {
  writeFileSync(
    path.join(dir, "index.html"),
    "<!doctype html><html><head><title>Test</title></head><body></body></html>"
  );
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(
    path.join(dir, "assets", "index-deadbeef.js"),
    "console.log('test bundle non-truncated content here');"
  );
  writeFileSync(
    path.join(dir, "assets", "index-deadbeef.css"),
    ":root{ --x: 0 } body { margin: 0; padding: 0 }"
  );
}

// Legacy vanilla bundle layout (PR F→I). Kept passing during transition
// so dev checkouts with stale build artifacts still serve.
function writeLegacyBundle(dir: string): void {
  writeFileSync(
    path.join(dir, "index.html"),
    "<!doctype html><html><head><title>Test</title></head><body></body></html>"
  );
  writeFileSync(path.join(dir, "app.css"), ":root{ --x: 0 } body { margin: 0; padding: 0 }");
  writeFileSync(path.join(dir, "app.js"), "console.log('test bundle non-truncated content here');");
}

describe("resolveControlCenterAssetDir", () => {
  it("returns the override when it's a complete Vite-style bundle", () => {
    const bundle = makeBundleDir();
    try {
      writeViteBundle(bundle.dir);
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, path.resolve(bundle.dir));
    } finally {
      bundle.cleanup();
    }
  });

  it("still accepts legacy vanilla bundles (app.js + app.css siblings)", () => {
    // Transitional support — dev checkouts that built the old layout
    // should keep working until they rebuild.
    const bundle = makeBundleDir();
    try {
      writeLegacyBundle(bundle.dir);
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, path.resolve(bundle.dir));
    } finally {
      bundle.cleanup();
    }
  });

  it("rejects a bundle with index.html but no assets dir or sibling assets", () => {
    const bundle = makeBundleDir();
    try {
      writeFileSync(
        path.join(bundle.dir, "index.html"),
        "<!doctype html><html><head><title>x</title></head><body></body></html>"
      );
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, null, "index.html without any assets should not be considered complete");
    } finally {
      bundle.cleanup();
    }
  });

  it("rejects a Vite bundle with an empty assets/ directory", () => {
    const bundle = makeBundleDir();
    try {
      writeFileSync(
        path.join(bundle.dir, "index.html"),
        "<!doctype html><html><head><title>x</title></head><body></body></html>"
      );
      mkdirSync(path.join(bundle.dir, "assets"));
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, null);
    } finally {
      bundle.cleanup();
    }
  });

  it("rejects a directory named index.html instead of a file", () => {
    const bundle = makeBundleDir();
    try {
      // index.html is a DIRECTORY, not a file. lstatSync().isFile() catches it.
      mkdirSync(path.join(bundle.dir, "index.html"));
      mkdirSync(path.join(bundle.dir, "assets"));
      writeFileSync(
        path.join(bundle.dir, "assets", "index-x.js"),
        "console.log('non-truncated bundle content here')"
      );
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, null, "directory-named index.html must not be accepted");
    } finally {
      bundle.cleanup();
    }
  });

  it("rejects a bundle where index.html is zero bytes", () => {
    const bundle = makeBundleDir();
    try {
      writeFileSync(path.join(bundle.dir, "index.html"), "");
      mkdirSync(path.join(bundle.dir, "assets"));
      writeFileSync(
        path.join(bundle.dir, "assets", "index-x.js"),
        "console.log('non-truncated bundle content here')"
      );
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, null);
    } finally {
      bundle.cleanup();
    }
  });

  it("rejects a bundle where index.html is truncated below the floor", () => {
    const bundle = makeBundleDir();
    try {
      writeFileSync(path.join(bundle.dir, "index.html"), "x"); // 1 byte
      mkdirSync(path.join(bundle.dir, "assets"));
      writeFileSync(
        path.join(bundle.dir, "assets", "index-x.js"),
        "console.log('non-truncated bundle content here')"
      );
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, null);
    } finally {
      bundle.cleanup();
    }
  });

  it("rejects a bundle where index.html is a symlink to an outside file", () => {
    const bundle = makeBundleDir();
    const outside = mkdtempSync(path.join(tmpdir(), "tk-cc-outside-bundle-"));
    try {
      const outsideTarget = path.join(outside, "hijack.html");
      writeFileSync(outsideTarget, "<!doctype html>this is outside the bundle");
      symlinkSync(outsideTarget, path.join(bundle.dir, "index.html"));
      mkdirSync(path.join(bundle.dir, "assets"));
      writeFileSync(
        path.join(bundle.dir, "assets", "index-x.js"),
        "console.log('non-truncated bundle content here')"
      );
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, null, "symlinked index.html must be rejected");
    } finally {
      rmSync(outside, { recursive: true, force: true });
      bundle.cleanup();
    }
  });

  it("returns null for a non-existent override path", () => {
    const resolved = resolveControlCenterAssetDir({
      override: "/nonexistent/path/that/should/not/exist",
    });
    assert.equal(resolved, null);
  });

  it("returns null when no override is supplied and no candidate dir exists", () => {
    // In this repo's source-checkout layout
    // (packages/control-center/dist/) it WILL find one if a build has
    // happened. Just verify the result is either null or a valid bundle.
    const resolved = resolveControlCenterAssetDir();
    if (resolved !== null) {
      assert.ok(statSync(path.join(resolved, "index.html")).isFile());
    }
  });
});
