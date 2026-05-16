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

function writeCompleteBundle(dir: string): void {
  // All files >32 bytes so they clear MIN_BUNDLE_FILE_BYTES.
  writeFileSync(
    path.join(dir, "index.html"),
    "<!doctype html><html><head><title>Test</title></head><body></body></html>"
  );
  writeFileSync(path.join(dir, "app.css"), ":root{ --x: 0 } body { margin: 0; padding: 0 }");
  writeFileSync(path.join(dir, "app.js"), "console.log('test bundle non-truncated content here');");
}

describe("resolveControlCenterAssetDir", () => {
  it("returns the override when it is a complete bundle", () => {
    const bundle = makeBundleDir();
    try {
      writeCompleteBundle(bundle.dir);
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, path.resolve(bundle.dir));
    } finally {
      bundle.cleanup();
    }
  });

  it("rejects an override that is missing app.css (incomplete)", () => {
    const bundle = makeBundleDir();
    try {
      writeFileSync(
        path.join(bundle.dir, "index.html"),
        "<!doctype html><html><head><title>x</title></head><body></body></html>"
      );
      writeFileSync(
        path.join(bundle.dir, "app.js"),
        "console.log('non-truncated bundle content here')"
      );
      // app.css intentionally missing
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, null);
    } finally {
      bundle.cleanup();
    }
  });

  it("rejects a directory named index.html instead of a file (codex re-review #3)", () => {
    const bundle = makeBundleDir();
    try {
      // index.html is a DIRECTORY, not a file. existsSync alone would call
      // this a complete bundle; the lstatSync check must catch it.
      mkdirSync(path.join(bundle.dir, "index.html"));
      writeFileSync(path.join(bundle.dir, "app.css"), ":root{ --x:0 } body { margin: 0 }");
      writeFileSync(
        path.join(bundle.dir, "app.js"),
        "console.log('non-truncated bundle content here')"
      );
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, null, "directory-named index.html must not be accepted");
    } finally {
      bundle.cleanup();
    }
  });

  it("rejects a bundle where one required file is zero bytes", () => {
    const bundle = makeBundleDir();
    try {
      writeFileSync(
        path.join(bundle.dir, "index.html"),
        "<!doctype html><html><head><title>x</title></head><body></body></html>"
      );
      writeFileSync(path.join(bundle.dir, "app.css"), ":root{ --x:0 } body { margin: 0 }");
      // app.js is zero bytes — corrupt placeholder. Don't ship it.
      writeFileSync(path.join(bundle.dir, "app.js"), "");
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, null);
    } finally {
      bundle.cleanup();
    }
  });

  it("rejects a bundle where a required file is truncated below the floor (codex 3rd-round)", () => {
    const bundle = makeBundleDir();
    try {
      // Single byte — definitely not a real asset, even though it's non-zero.
      // size > 0 alone would have accepted it.
      writeFileSync(path.join(bundle.dir, "index.html"), "x");
      writeFileSync(path.join(bundle.dir, "app.css"), ":root{}");
      writeFileSync(path.join(bundle.dir, "app.js"), "console.log('x')");
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, null);
    } finally {
      bundle.cleanup();
    }
  });

  it("rejects a bundle where a required file is a symlink to a non-zero outside file (codex 3rd-round)", () => {
    // statSync follows symlinks: a malicious or accidental symlink from
    // index.html → /etc/hosts would pass isFile()+size>0. lstatSync sees
    // the symlink itself (isFile() === false) and rejects.
    const bundle = makeBundleDir();
    const outside = mkdtempSync(path.join(tmpdir(), "tk-cc-outside-bundle-"));
    try {
      const outsideTarget = path.join(outside, "hijack.html");
      writeFileSync(outsideTarget, "<!doctype html>this is outside the bundle");
      // index.html is a symlink to the outside file.
      symlinkSync(outsideTarget, path.join(bundle.dir, "index.html"));
      writeFileSync(path.join(bundle.dir, "app.css"), ":root{ color: red }");
      writeFileSync(path.join(bundle.dir, "app.js"), "console.log('ok ok ok')");
      const resolved = resolveControlCenterAssetDir({ override: bundle.dir });
      assert.equal(resolved, null, "symlinked required bundle file must be rejected");
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
    // Without override + with no real bundle co-located with this test file,
    // the probe should fall through. Note this assumes the test isn't being
    // run from a tree where one of the candidate paths happens to have a
    // complete bundle. In this repo's source-checkout layout
    // (packages/cli/control-center/) it WILL find one — so we just verify
    // the result is either null or a directory containing the bundle.
    const resolved = resolveControlCenterAssetDir();
    if (resolved !== null) {
      // Must be a directory holding a real bundle.
      assert.ok(statSync(path.join(resolved, "index.html")).isFile());
      assert.ok(statSync(path.join(resolved, "app.css")).isFile());
      assert.ok(statSync(path.join(resolved, "app.js")).isFile());
    }
  });
});
