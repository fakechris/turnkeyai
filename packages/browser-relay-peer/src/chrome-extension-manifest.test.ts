import assert from "node:assert/strict";
import test from "node:test";

import { buildChromeRelayExtensionManifest } from "./chrome-extension-manifest";

test("chrome relay extension manifest uses explicit matches and loopback daemon origins", () => {
  const manifest = buildChromeRelayExtensionManifest({
    matches: ["https://example.com/*", "https://docs.example.com/*"],
  });

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "service-worker.js");
  assert.equal(manifest.description, "Attach TurnkeyAI to your existing Chrome tabs through a local relay daemon.");
  assert.deepEqual(manifest.content_scripts[0]?.matches, ["https://example.com/*", "https://docs.example.com/*"]);
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:4100/*"));
  assert.ok(manifest.permissions.includes("tabs"));
  assert.ok(manifest.permissions.includes("debugger"));
});

test("chrome relay extension manifest rejects empty match lists", () => {
  assert.throws(
    () =>
      buildChromeRelayExtensionManifest({
        matches: [],
      }),
    /requires at least one page match pattern/
  );
});
