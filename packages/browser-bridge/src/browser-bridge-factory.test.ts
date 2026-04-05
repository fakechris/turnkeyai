import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserBridge, resolveBrowserTransportMode } from "./browser-bridge-factory";
import { maybeGetRelayControlPlane } from "./transport/transport-adapter";

test("browser bridge factory defaults to local automation transport", () => {
  const bridge = createBrowserBridge({
    artifactRootDir: "/tmp/turnkeyai-browser-factory-local",
  });

  assert.equal(bridge.transportMode, "local");
  assert.equal(bridge.transportLabel, "local-automation");
});

test("browser bridge factory can build relay transport skeleton", () => {
  const bridge = createBrowserBridge({
    artifactRootDir: "/tmp/turnkeyai-browser-factory-relay",
    transportMode: "relay",
    relay: {
      endpoint: "ws://127.0.0.1:4101/relay",
    },
  });

  assert.equal(bridge.transportMode, "relay");
  assert.equal(bridge.transportLabel, "chrome-relay");
  assert.ok(maybeGetRelayControlPlane(bridge));
});

test("browser bridge factory can build direct-cdp transport", () => {
  const bridge = createBrowserBridge({
    artifactRootDir: "/tmp/turnkeyai-browser-factory-direct-cdp",
    transportMode: "direct-cdp",
    directCdp: {
      endpoint: "ws://127.0.0.1:9222/devtools/browser/browser-id",
    },
  });

  assert.equal(bridge.transportMode, "direct-cdp");
  assert.equal(bridge.transportLabel, "direct-cdp");
});

test("browser bridge factory rejects unknown transport mode", () => {
  assert.throws(
    () => resolveBrowserTransportMode("weird"),
    /unknown browser transport mode/
  );
});

test("relay transport surfaces a deterministic no-peer error before any peer registers", async () => {
  const bridge = createBrowserBridge({
    artifactRootDir: "/tmp/turnkeyai-browser-factory-relay-error",
    transportMode: "relay",
    relay: {
      endpoint: "ws://127.0.0.1:4101/relay",
    },
  });

  await assert.rejects(
    () =>
      bridge.inspectPublicPage("https://example.com"),
    /relay browser transport has no compatible registered peers/
  );
});

test("direct-cdp transport fails fast when no endpoint is configured", () => {
  assert.throws(
    () =>
      createBrowserBridge({
        artifactRootDir: "/tmp/turnkeyai-browser-factory-direct-cdp-missing",
        transportMode: "direct-cdp",
      }),
    /TURNKEYAI_BROWSER_CDP_ENDPOINT/
  );
});
