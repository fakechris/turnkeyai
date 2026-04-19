import assert from "node:assert/strict";
import test from "node:test";

import { getChromeExtensionPlatform, getChromeRuntime } from "./chrome-extension-types";

test("getChromeRuntime works in content-script style runtimes without tabs APIs", async () => {
  const previousChrome = (globalThis as Record<string, unknown>).chrome;
  const sentMessages: unknown[] = [];
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      id: "ext-123",
      onMessage: {
        addListener() {},
      },
      sendMessage(message: unknown, callback: (response: unknown) => void) {
        sentMessages.push(message);
        callback({ ok: true });
      },
    },
  };

  try {
    const runtime = getChromeRuntime();
    assert.equal(runtime.id, "ext-123");
    const response = await runtime.sendMessage?.({ type: "ping" });
    assert.deepEqual(response, { ok: true });
    assert.deepEqual(sentMessages, [{ type: "ping" }]);
  } finally {
    (globalThis as Record<string, unknown>).chrome = previousChrome;
  }
});

test("getChromeExtensionPlatform exposes content script injection when scripting API is available", async () => {
  const previousChrome = (globalThis as Record<string, unknown>).chrome;
  const injections: unknown[] = [];
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      onMessage: {
        addListener() {},
      },
    },
    tabs: {
      query(_query: unknown, callback: (tabs: unknown[]) => void) {
        callback([]);
      },
      get(_tabId: number, callback: (tab?: unknown) => void) {
        callback(undefined);
      },
      update(_tabId: number, _properties: unknown, callback: (tab?: unknown) => void) {
        callback(undefined);
      },
      create(_properties: unknown, callback: (tab?: unknown) => void) {
        callback(undefined);
      },
      sendMessage(_tabId: number, _message: unknown, callback: (response: unknown) => void) {
        callback({ ok: true });
      },
      captureVisibleTab(_windowId: number | undefined, _options: unknown, callback: (dataUrl?: string) => void) {
        callback("data:image/png;base64,");
      },
    },
    scripting: {
      executeScript(injection: unknown, callback: () => void) {
        injections.push(injection);
        callback();
      },
    },
  };

  try {
    const platform = getChromeExtensionPlatform();
    await platform.injectContentScript?.(42);
    assert.deepEqual(injections, [
      {
        target: {
          tabId: 42,
          allFrames: true,
        },
        files: ["content-script.js"],
      },
    ]);
  } finally {
    (globalThis as Record<string, unknown>).chrome = previousChrome;
  }
});
