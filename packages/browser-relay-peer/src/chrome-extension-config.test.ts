import assert from "node:assert/strict";
import test from "node:test";

import { loadChromeRelayExtensionRuntimeConfig } from "./chrome-extension-config";

test("chrome relay extension config falls back to default loopback daemon settings", async () => {
  const previousChrome = (globalThis as Record<string, unknown>).chrome;
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { id: "ext-123" },
  };

  try {
    const config = await loadChromeRelayExtensionRuntimeConfig();
    assert.equal(config.daemonBaseUrl.startsWith("http://127.0.0.1:"), true);
    assert.equal(config.peerId, "turnkeyai-relay-peer:ext-123");
    assert.deepEqual(config.capabilities, ["open", "snapshot", "click", "type", "scroll", "console", "screenshot"]);
  } finally {
    (globalThis as Record<string, unknown>).chrome = previousChrome;
  }
});

test("chrome relay extension config merges stored overrides", async () => {
  const previousChrome = (globalThis as Record<string, unknown>).chrome;
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { id: "ext-123" },
    storage: {
      local: {
        get(_keys: unknown, callback: (items: Record<string, unknown>) => void) {
          callback({
            turnkeyaiRelayConfig: {
              daemonBaseUrl: "http://localhost:4200/",
              daemonToken: "secret",
              peerId: "custom-peer",
              peerLabel: "Relay Peer",
              capabilities: ["snapshot", "click", "click", ""],
              transportLabel: "custom-relay",
              activeDelayMs: 10,
              idleDelayMs: 800,
              errorDelayMs: 1200,
            },
          });
        },
      },
    },
  };

  try {
    const config = await loadChromeRelayExtensionRuntimeConfig();
    assert.equal(config.daemonBaseUrl, "http://localhost:4200");
    assert.equal(config.daemonToken, "secret");
    assert.equal(config.peerId, "custom-peer");
    assert.equal(config.peerLabel, "Relay Peer");
    assert.deepEqual(config.capabilities, ["snapshot", "click"]);
    assert.equal(config.transportLabel, "custom-relay");
    assert.equal(config.activeDelayMs, 10);
    assert.equal(config.idleDelayMs, 800);
    assert.equal(config.errorDelayMs, 1200);
  } finally {
    (globalThis as Record<string, unknown>).chrome = previousChrome;
  }
});
