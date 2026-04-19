import assert from "node:assert/strict";
import test from "node:test";

import type { ChromeExtensionPlatform } from "./chrome-extension-types";
import { ChromeRelayActionExecutor } from "./chrome-action-executor";

test("chrome relay action executor can open a tab and then execute content-script actions", async () => {
  const now = Date.now();
  const sentMessages: unknown[] = [];
  const platform = fakePlatform({
    activeTab: { id: 7, windowId: 3, url: "https://example.com", title: "Example", status: "complete" },
    onSendMessage(tabId, message) {
      sentMessages.push({ tabId, message });
      return {
        ok: true,
        page: {
          requestedUrl: "https://example.com/new",
          finalUrl: "https://example.com/new",
          title: "New",
          textExcerpt: "New page",
          statusCode: 200,
          interactives: [],
        },
        trace: [
          {
            stepId: "relay-step:1",
            kind: "snapshot",
            startedAt: 1,
            completedAt: 2,
            status: "ok",
            input: {},
          },
        ],
      };
    },
  });
  const executor = new ChromeRelayActionExecutor(platform);

  const result = await executor.execute({
    actionRequestId: "relay-action-1",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [
      { kind: "open", url: "https://example.com/new" },
      { kind: "select", selectors: ["select[name=plan]"], value: "team" },
      { kind: "waitFor", text: "Ready", timeoutMs: 1_000 },
      { kind: "snapshot", note: "after-open" },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.relayTargetId, "chrome-tab:7");
  assert.equal(result.page?.finalUrl, "https://example.com/new");
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(
    ((sentMessages[0] as { message: { actions: Array<{ kind: string }> } }).message.actions ?? []).map(
      (action) => action.kind
    ),
    ["select", "waitFor", "snapshot"]
  );
});

test("chrome relay action executor captures screenshot payloads through the extension platform", async () => {
  const now = Date.now();
  const activations: Array<{ tabId: number; active?: boolean }> = [];
  const executor = new ChromeRelayActionExecutor(
    fakePlatform({
      activeTab: { id: 7, windowId: 3, url: "https://example.com", title: "Example", status: "complete" },
      onSendMessage() {
        return {
          ok: true,
          page: {
            requestedUrl: "https://example.com",
            finalUrl: "https://example.com",
            title: "Example",
            textExcerpt: "Example page",
            statusCode: 200,
            interactives: [],
          },
          trace: [],
        };
      },
      onCaptureVisibleTab() {
        return "data:image/png;base64,c2NyZWVuc2hvdA==";
      },
      onUpdateTab(tabId, updateProperties) {
        activations.push({
          tabId,
          ...(updateProperties.active !== undefined ? { active: updateProperties.active } : {}),
        });
      },
    })
  );

  const result = await executor.execute({
    actionRequestId: "relay-action-1",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [{ kind: "screenshot", label: "final" }],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.screenshotPayloads.length, 1);
  assert.equal(result.screenshotPayloads[0]?.mimeType, "image/png");
  assert.equal(result.screenshotPayloads[0]?.dataBase64, "c2NyZWVuc2hvdA==");
  assert.equal(result.trace.some((entry) => entry.kind === "screenshot"), true);
  assert.deepEqual(activations, [{ tabId: 7, active: true }]);
});

test("chrome relay action executor surfaces content-script failures", async () => {
  const now = Date.now();
  const executor = new ChromeRelayActionExecutor(
    fakePlatform({
      activeTab: { id: 7, windowId: 3, url: "https://example.com", title: "Example", status: "complete" },
      onSendMessage() {
        return {
          ok: false,
          trace: [],
          errorMessage: "content script unavailable",
        };
      },
    })
  );

  const result = await executor.execute({
    actionRequestId: "relay-action-1",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [{ kind: "snapshot", note: "inspect" }],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "failed");
  assert.match(result.errorMessage ?? "", /content script unavailable/);
});

test("chrome relay action executor retries transient content-script startup errors", async () => {
  const now = Date.now();
  let attempts = 0;
  const executor = new ChromeRelayActionExecutor(
    fakePlatform({
      activeTab: { id: 7, windowId: 3, url: "https://example.com", title: "Example", status: "complete" },
      onSendMessage() {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        return {
          ok: true,
          page: {
            requestedUrl: "https://example.com",
            finalUrl: "https://example.com",
            title: "Example",
            textExcerpt: "Example page",
            statusCode: 200,
            interactives: [],
          },
          trace: [],
        };
      },
    })
  );

  const result = await executor.execute({
    actionRequestId: "relay-action-retry",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [{ kind: "snapshot", note: "inspect" }],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.equal(attempts, 3);
});

test("chrome relay action executor injects content script before retrying a missing receiver", async () => {
  const now = Date.now();
  let attempts = 0;
  const injectedTabs: number[] = [];
  const executor = new ChromeRelayActionExecutor(
    fakePlatform({
      activeTab: { id: 7, windowId: 3, url: "https://example.com", title: "Example", status: "complete" },
      onInjectContentScript(tabId) {
        injectedTabs.push(tabId);
      },
      onSendMessage() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        return {
          ok: true,
          page: {
            requestedUrl: "https://example.com",
            finalUrl: "https://example.com",
            title: "Example",
            textExcerpt: "Example page",
            statusCode: 200,
            interactives: [],
          },
          trace: [],
        };
      },
    })
  );

  const result = await executor.execute({
    actionRequestId: "relay-action-inject",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [{ kind: "snapshot", note: "inspect" }],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.equal(attempts, 2);
  assert.deepEqual(injectedTabs, [7]);
});

test("chrome relay action executor can run target-scoped cdp commands", async () => {
  const now = Date.now();
  const debuggerCommands: unknown[] = [];
  const sentMessages: unknown[] = [];
  const executor = new ChromeRelayActionExecutor(
    fakePlatform({
      activeTab: { id: 7, windowId: 3, url: "https://example.com", title: "Example", status: "complete" },
      onDebuggerCommand(tabId, method, params) {
        debuggerCommands.push({ tabId, method, params });
        return { result: { value: "Example" } };
      },
      onSendMessage(tabId, message) {
        sentMessages.push({ tabId, message });
        return {
          ok: true,
          page: {
            requestedUrl: "https://example.com",
            finalUrl: "https://example.com",
            title: "Example",
            textExcerpt: "Example page",
            statusCode: 200,
            interactives: [],
          },
          trace: [
            {
              stepId: "relay-step:1",
              kind: "snapshot",
              startedAt: 1,
              completedAt: 2,
              status: "ok",
              input: {},
            },
          ],
        };
      },
    })
  );

  const result = await executor.execute({
    actionRequestId: "relay-action-cdp",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [
      {
        kind: "cdp",
        method: "Runtime.evaluate",
        params: {
          expression: "document.title",
          returnByValue: true,
        },
      },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(debuggerCommands, [
    {
      tabId: 7,
      method: "Runtime.evaluate",
      params: {
        expression: "document.title",
        returnByValue: true,
      },
    },
  ]);
  assert.equal(result.trace[0]?.kind, "cdp");
  assert.equal(result.trace.at(-1)?.kind, "snapshot");
  assert.equal(sentMessages.length, 1);
});

test("chrome relay action executor can run typed hover and key actions through debugger input", async () => {
  const now = Date.now();
  const debuggerCommands: Array<{ tabId: number; method: string; params: Record<string, unknown> }> = [];
  const executor = new ChromeRelayActionExecutor(
    fakePlatform({
      activeTab: { id: 7, windowId: 3, url: "https://example.com", title: "Example", status: "complete" },
      onDebuggerCommand(tabId, method, params) {
        debuggerCommands.push({ tabId, method, params });
        if (method === "Runtime.evaluate") {
          return {
            result: {
              value: {
                ok: true,
                x: 25,
                y: 50,
                tagName: "BUTTON",
                label: "Open",
              },
            },
          };
        }
        return {};
      },
      onSendMessage() {
        return {
          ok: true,
          page: {
            requestedUrl: "https://example.com",
            finalUrl: "https://example.com",
            title: "Example",
            textExcerpt: "Example page",
            statusCode: 200,
            interactives: [],
          },
          trace: [],
        };
      },
    })
  );

  const result = await executor.execute({
    actionRequestId: "relay-action-input",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [
      { kind: "hover", text: "Open" },
      { kind: "key", key: "K", modifiers: ["Control", "Shift"] },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.trace[0]?.kind, "hover");
  assert.equal(result.trace[1]?.kind, "key");
  assert.deepEqual(
    debuggerCommands.map((command) => command.method),
    [
      "Runtime.evaluate",
      "Input.dispatchMouseEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ]
  );
  assert.deepEqual(debuggerCommands[1]?.params, {
    type: "mouseMoved",
    x: 25,
    y: 50,
    button: "none",
  });
  assert.equal(debuggerCommands[4]?.params.type, "keyDown");
  assert.equal(debuggerCommands[4]?.params.key, "K");
  assert.equal(debuggerCommands[4]?.params.code, "KeyK");
  assert.equal(debuggerCommands[4]?.params.windowsVirtualKeyCode, 75);
  assert.equal(debuggerCommands[4]?.params.modifiers, 10);
});

test("chrome relay action executor can run typed drag actions through debugger input", async () => {
  const now = Date.now();
  const debuggerCommands: Array<{ tabId: number; method: string; params: Record<string, unknown> }> = [];
  const executor = new ChromeRelayActionExecutor(
    fakePlatform({
      activeTab: { id: 7, windowId: 3, url: "https://example.com", title: "Example", status: "complete" },
      onDebuggerCommand(tabId, method, params) {
        debuggerCommands.push({ tabId, method, params });
        if (method === "Runtime.evaluate") {
          return {
            result: {
              value: {
                ok: true,
                source: { ok: true, x: 10, y: 20, tagName: "DIV", label: "Card" },
                target: { ok: true, x: 110, y: 120, tagName: "DIV", label: "Lane" },
              },
            },
          };
        }
        return {};
      },
      onSendMessage() {
        return {
          ok: true,
          page: {
            requestedUrl: "https://example.com",
            finalUrl: "https://example.com",
            title: "Example",
            textExcerpt: "Example page",
            statusCode: 200,
            interactives: [],
          },
          trace: [],
        };
      },
    })
  );

  const result = await executor.execute({
    actionRequestId: "relay-action-drag",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [{ kind: "drag", source: { text: "Card" }, target: { text: "Lane" } }],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.trace[0]?.kind, "drag");
  assert.equal(debuggerCommands[0]?.method, "Runtime.evaluate");
  assert.deepEqual(debuggerCommands[2]?.params, {
    type: "mousePressed",
    x: 10,
    y: 20,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  assert.deepEqual(debuggerCommands.at(-1)?.params, {
    type: "mouseReleased",
    x: 110,
    y: 120,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
});

test("chrome relay action executor can wait for and trace cdp events", async () => {
  const now = Date.now();
  const debuggerCommands: unknown[] = [];
  const waitedEvents: unknown[] = [];
  const drainedEvents: unknown[] = [];
  const detachedTabs: number[] = [];
  const platform = fakePlatform({
    activeTab: { id: 7, windowId: 3, url: "https://example.com", title: "Example", status: "complete" },
    onDebuggerCommand(tabId, method, params) {
      debuggerCommands.push({ tabId, method, params });
      return { result: { value: "ok" } };
    },
    onSendMessage() {
      return {
        ok: true,
        page: {
          requestedUrl: "https://example.com",
          finalUrl: "https://example.com",
          title: "Example",
          textExcerpt: "Example page",
          statusCode: 200,
          interactives: [],
        },
        trace: [],
      };
    },
  });
  platform.waitForDebuggerEvent = async (tabId, method, timeoutMs) => {
    waitedEvents.push({ tabId, method, timeoutMs });
    return {
      method,
      params: { type: "log" },
      timestamp: 123,
    };
  };
  platform.drainDebuggerEvents = async (tabId, input) => {
    drainedEvents.push({ tabId, input });
    return [
      {
        method: "Runtime.consoleAPICalled",
        params: { type: "log" },
        timestamp: 123,
      },
    ];
  };
  platform.detachDebugger = async (tabId) => {
    detachedTabs.push(tabId);
  };
  const executor = new ChromeRelayActionExecutor(platform);

  const result = await executor.execute({
    actionRequestId: "relay-action-cdp-events",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [
      {
        kind: "cdp",
        method: "Runtime.evaluate",
        params: {
          expression: "console.log('ok')",
        },
        events: {
          waitFor: "Runtime.consoleAPICalled",
          timeoutMs: 1_000,
          maxEvents: 1,
        },
      },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(waitedEvents, [{ tabId: 7, method: "Runtime.consoleAPICalled", timeoutMs: 1_000 }]);
  assert.deepEqual(drainedEvents, [
    {
      tabId: 7,
      input: {
        include: ["Runtime.consoleAPICalled"],
        maxEvents: 1,
      },
    },
  ]);
  assert.deepEqual(detachedTabs, [7]);
  assert.equal(result.trace[0]?.kind, "cdp");
  assert.deepEqual(result.trace[0]?.output?.events, [
    {
      method: "Runtime.consoleAPICalled",
      timestamp: 123,
      paramsBytes: 14,
      params: { type: "log" },
    },
  ]);
  assert.equal(debuggerCommands.length, 1);
});

test("chrome relay action executor rejects blocked cdp methods before debugger dispatch", async () => {
  const now = Date.now();
  let debuggerCommands = 0;
  const executor = new ChromeRelayActionExecutor(
    fakePlatform({
      activeTab: { id: 7, windowId: 3, url: "https://example.com", title: "Example", status: "complete" },
      onDebuggerCommand() {
        debuggerCommands += 1;
        return {};
      },
      onSendMessage() {
        return {
          ok: true,
          page: {
            requestedUrl: "https://example.com",
            finalUrl: "https://example.com",
            title: "Example",
            textExcerpt: "Example page",
            statusCode: 200,
            interactives: [],
          },
          trace: [],
        };
      },
    })
  );

  await assert.rejects(
    () =>
      executor.execute({
        actionRequestId: "relay-action-cdp-blocked",
        peerId: "peer-1",
        browserSessionId: "browser-session-1",
        taskId: "task-1",
        actions: [{ kind: "cdp", method: "Target.closeTarget", params: { targetId: "target-1" } }],
        createdAt: now,
        expiresAt: now + 5_000,
      }),
    /relay cdp action method is not allowed/
  );
  assert.equal(debuggerCommands, 0);
});

test("chrome relay action executor rejects wait actions that exceed the remaining request budget", async () => {
  const now = Date.now();
  let sentMessages = 0;
  const executor = new ChromeRelayActionExecutor(
    fakePlatform({
      activeTab: { id: 7, windowId: 3, url: "https://example.com", title: "Example", status: "complete" },
      onSendMessage() {
        sentMessages += 1;
        return {
          ok: true,
          page: {
            requestedUrl: "https://example.com",
            finalUrl: "https://example.com",
            title: "Example",
            textExcerpt: "Example page",
            statusCode: 200,
            interactives: [],
          },
          trace: [],
        };
      },
    })
  );

  await assert.rejects(
    () =>
      executor.execute({
        actionRequestId: "relay-action-wait-budget",
        peerId: "peer-1",
        browserSessionId: "browser-session-1",
        taskId: "task-1",
        actions: [{ kind: "wait", timeoutMs: 1_000 }],
        createdAt: now,
        expiresAt: now + 600,
      }),
    /relay wait action exceeds remaining request budget/
  );
  assert.equal(sentMessages, 0);
});

test("chrome relay action executor rejects screenshot capture that exceeds remaining request budget", async () => {
  const now = Date.now();
  const executor = new ChromeRelayActionExecutor(
    fakePlatform({
      activeTab: { id: 7, windowId: 3, url: "https://example.com", title: "Example", status: "complete" },
      onSendMessage() {
        return {
          ok: true,
          page: {
            requestedUrl: "https://example.com",
            finalUrl: "https://example.com",
            title: "Example",
            textExcerpt: "Example page",
            statusCode: 200,
            interactives: [],
          },
          trace: [],
        };
      },
      onCaptureVisibleTab() {
        return new Promise<string>(() => undefined);
      },
    })
  );

  await assert.rejects(
    () =>
      executor.execute({
        actionRequestId: "relay-action-screenshot-timeout",
        peerId: "peer-1",
        browserSessionId: "browser-session-1",
        taskId: "task-1",
        actions: [{ kind: "screenshot", label: "hung" }],
        createdAt: now,
        expiresAt: now + 550,
      }),
    /relay screenshot capture timed out/
  );
});

function fakePlatform(input: {
  activeTab: { id: number; windowId?: number; url: string; title: string; status: "complete" | "loading" };
  onSendMessage(tabId: number, message: unknown): unknown;
  onCaptureVisibleTab?(windowId?: number): string | Promise<string>;
  onUpdateTab?(tabId: number, updateProperties: { url?: string; active?: boolean }): void;
  onInjectContentScript?(tabId: number): void | Promise<void>;
  onDebuggerCommand?(tabId: number, method: string, params: Record<string, unknown>): unknown | Promise<unknown>;
}): ChromeExtensionPlatform {
  let currentTab: {
    id: number;
    windowId?: number;
    url: string;
    title: string;
    status: "complete" | "loading";
  } = { ...input.activeTab };
  return {
    runtime: {
      onMessage: {
        addListener() {},
      },
    },
    tabs: {},
    async queryTabs(query) {
      if (query.active && query.currentWindow) {
        return [currentTab];
      }
      return [currentTab];
    },
    async getTab(tabId) {
      return tabId === currentTab.id ? currentTab : null;
    },
    async updateTab(tabId, updateProperties) {
      if (tabId !== currentTab.id) {
        throw new Error(`unknown tab: ${tabId}`);
      }
      input.onUpdateTab?.(tabId, updateProperties);
      currentTab = {
        ...currentTab,
        ...(updateProperties.url ? { url: updateProperties.url } : {}),
      };
      return currentTab;
    },
    async createTab(createProperties) {
      currentTab = {
        id: currentTab.id + 1,
        ...(currentTab.windowId !== undefined ? { windowId: currentTab.windowId } : {}),
        url: createProperties.url,
        title: "Created",
        status: "complete",
      };
      return currentTab;
    },
    async sendTabMessage<T>(tabId: number, message: unknown) {
      return input.onSendMessage(tabId, message) as T;
    },
    ...(input.onInjectContentScript
      ? {
          async injectContentScript(tabId: number) {
            await input.onInjectContentScript?.(tabId);
          },
        }
      : {}),
    ...(input.onDebuggerCommand
      ? {
          async sendDebuggerCommand(tabId: number, method: string, params: Record<string, unknown> = {}) {
            return input.onDebuggerCommand?.(tabId, method, params);
          },
        }
      : {}),
    async captureVisibleTab(windowId) {
      return input.onCaptureVisibleTab?.(windowId) ?? "data:image/png;base64,";
    },
  };
}
