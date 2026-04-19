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
      { kind: "probe", probe: "page-state" },
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
    ["select", "waitFor", "probe", "snapshot"]
  );
});

test("chrome relay action executor creates a new tab for new-target open requests", async () => {
  const now = Date.now();
  const createdTabs: Array<{ url: string; active?: boolean }> = [];
  const sentMessages: unknown[] = [];
  const executor = new ChromeRelayActionExecutor(
    fakePlatform({
      activeTab: { id: 7, windowId: 3, url: "https://example.com/start", title: "Start", status: "complete" },
      onCreateTab(createProperties) {
        createdTabs.push(createProperties);
      },
      onSendMessage(tabId, message) {
        sentMessages.push({ tabId, message });
        return {
          ok: true,
          page: {
            requestedUrl: "https://example.com/new-target",
            finalUrl: "https://example.com/new-target",
            title: "New Target",
            textExcerpt: "New target page",
            statusCode: 200,
            interactives: [],
          },
          trace: [],
        };
      },
    })
  );

  const result = await executor.execute({
    actionRequestId: "relay-action-new-target",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-new-target",
    targetBehavior: "new",
    actions: [
      { kind: "open", url: "https://example.com/new-target" },
      { kind: "snapshot", note: "new-target" },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.relayTargetId, "chrome-tab:8");
  assert.deepEqual(createdTabs, [{ url: "https://example.com/new-target", active: true }]);
  assert.equal((sentMessages[0] as { tabId: number }).tabId, 8);
});

test("chrome relay action executor arms and handles prompt dialogs around content actions", async () => {
  const now = Date.now();
  const debuggerCommands: Array<{ tabId: number; method: string; params: Record<string, unknown> }> = [];
  let resolveDialog: ((event: { method: string; params: Record<string, unknown>; timestamp: number }) => void) | null = null;
  const platform = fakePlatform({
    activeTab: { id: 7, windowId: 3, url: "https://example.com/form", title: "Form", status: "complete" },
    onDebuggerCommand(tabId, method, params) {
      debuggerCommands.push({ tabId, method, params });
      return {};
    },
    onSendMessage() {
      resolveDialog?.({
        method: "Page.javascriptDialogOpening",
        params: { type: "prompt", message: "Continue?" },
        timestamp: 123,
      });
      return {
        ok: true,
        page: {
          requestedUrl: "https://example.com/form",
          finalUrl: "https://example.com/form",
          title: "Form",
          textExcerpt: "Form page",
          statusCode: 200,
          interactives: [],
        },
        trace: [],
      };
    },
  });
  platform.waitForDebuggerEvent = async (tabId, method, timeoutMs) => {
    assert.equal(tabId, 7);
    assert.equal(method, "Page.javascriptDialogOpening");
    assert.equal(timeoutMs, 1_000);
    return await new Promise((resolve) => {
      resolveDialog = resolve;
    });
  };
  const executor = new ChromeRelayActionExecutor(platform);

  const result = await executor.execute({
    actionRequestId: "relay-action-dialog",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-dialog",
    actions: [
      { kind: "dialog", action: "accept", promptText: "yes", timeoutMs: 1_000 },
      { kind: "click", text: "Submit" },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.trace[0]?.kind, "dialog");
  assert.equal(result.trace[0]?.status, "ok");
  assert.deepEqual(debuggerCommands, [
    { tabId: 7, method: "Page.enable", params: {} },
    { tabId: 7, method: "Page.handleJavaScriptDialog", params: { accept: true, promptText: "yes" } },
  ]);
});

test("chrome relay action executor switches to a newly created popup tab", async () => {
  const now = Date.now();
  let platform: ChromeExtensionPlatform;
  const sentMessages: Array<{ tabId: number; message: unknown }> = [];
  platform = fakePlatform({
    activeTab: { id: 7, windowId: 3, url: "https://example.com/start", title: "Start", status: "complete" },
    async onSendMessage(tabId, message) {
      sentMessages.push({ tabId, message });
      if (tabId === 7) {
        await platform.createTab({ url: "https://example.com/popup", active: true });
      }
      return {
        ok: true,
        page: {
          requestedUrl: tabId === 7 ? "https://example.com/start" : "https://example.com/popup",
          finalUrl: tabId === 7 ? "https://example.com/start" : "https://example.com/popup",
          title: tabId === 7 ? "Start" : "Popup",
          textExcerpt: tabId === 7 ? "Start page" : "Popup page",
          statusCode: 200,
          interactives: [],
        },
        trace: [],
      };
    },
  });
  const executor = new ChromeRelayActionExecutor(platform);

  const result = await executor.execute({
    actionRequestId: "relay-action-popup",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-popup",
    actions: [
      { kind: "popup", timeoutMs: 1_000 },
      { kind: "click", text: "Open popup" },
      { kind: "snapshot", note: "popup" },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.relayTargetId, "chrome-tab:8");
  assert.equal(result.page?.finalUrl, "https://example.com/popup");
  assert.deepEqual(sentMessages.map((entry) => entry.tabId), [7, 8]);
  assert.equal(result.trace[0]?.kind, "popup");
  assert.equal(result.trace[0]?.output?.relayTargetId, "chrome-tab:8");
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

test("chrome relay action executor can run target-scoped cookie actions through debugger", async () => {
  const now = Date.now();
  const debuggerCommands: Array<{ tabId: number; method: string; params: Record<string, unknown> }> = [];
  const detachedTabs: number[] = [];
  const platform = fakePlatform({
    activeTab: { id: 7, windowId: 3, url: "https://example.com/app", title: "Example", status: "complete" },
    onDebuggerCommand(tabId, method, params) {
      debuggerCommands.push({ tabId, method, params });
      if (method === "Network.getCookies") {
        return {
          cookies: [
            {
              name: "sid",
              value: "abc",
              domain: "example.com",
              path: "/",
              secure: true,
              httpOnly: true,
              session: false,
              sameSite: "Lax",
              expires: 1_900_000_000,
            },
          ],
        };
      }
      return {};
    },
    onSendMessage() {
      return {
        ok: true,
        page: {
          requestedUrl: "https://example.com/app",
          finalUrl: "https://example.com/app",
          title: "Example",
          textExcerpt: "Example page",
          statusCode: 200,
          interactives: [],
        },
        trace: [],
      };
    },
  });
  platform.detachDebugger = async (tabId) => {
    detachedTabs.push(tabId);
  };
  const executor = new ChromeRelayActionExecutor(platform);

  const result = await executor.execute({
    actionRequestId: "relay-action-cookie",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-cookie",
    actions: [{ kind: "cookie", action: "get", name: "sid" }],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(debuggerCommands, [
    { tabId: 7, method: "Network.enable", params: {} },
    { tabId: 7, method: "Network.getCookies", params: { urls: ["https://example.com/app"] } },
  ]);
  assert.deepEqual(detachedTabs, [7]);
  assert.equal(result.trace[0]?.kind, "cookie");
  assert.equal(result.trace[0]?.output?.cookieCount, 1);
});

test("chrome relay action executor can run target-scoped eval actions through debugger", async () => {
  const now = Date.now();
  const debuggerCommands: Array<{ tabId: number; method: string; params: Record<string, unknown> }> = [];
  const detachedTabs: number[] = [];
  const platform = fakePlatform({
    activeTab: { id: 7, windowId: 3, url: "https://example.com/app", title: "Example", status: "complete" },
    onDebuggerCommand(tabId, method, params) {
      debuggerCommands.push({ tabId, method, params });
      return {
        result: {
          type: "string",
          value: "Example",
        },
      };
    },
    onSendMessage() {
      return {
        ok: true,
        page: {
          requestedUrl: "https://example.com/app",
          finalUrl: "https://example.com/app",
          title: "Example",
          textExcerpt: "Example page",
          statusCode: 200,
          interactives: [],
        },
        trace: [],
      };
    },
  });
  platform.detachDebugger = async (tabId) => {
    detachedTabs.push(tabId);
  };
  const executor = new ChromeRelayActionExecutor(platform);

  const result = await executor.execute({
    actionRequestId: "relay-action-eval",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-eval",
    actions: [{ kind: "eval", expression: "document.title", timeoutMs: 1_000 }],
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
        awaitPromise: true,
      },
    },
  ]);
  assert.deepEqual(detachedTabs, [7]);
  assert.equal(result.trace[0]?.kind, "eval");
  assert.deepEqual(result.trace[0]?.output, {
    exception: false,
    timeoutMs: 1_000,
    resultType: "string",
    resultBytes: 9,
    result: "Example",
  });
});

test("chrome relay action executor can control permission prompts through debugger", async () => {
  const now = Date.now();
  const debuggerCommands: Array<{ tabId: number; method: string; params: Record<string, unknown> }> = [];
  const detachedTabs: number[] = [];
  const platform = fakePlatform({
    activeTab: { id: 7, windowId: 3, url: "https://example.com/app", title: "Example", status: "complete" },
    onDebuggerCommand(tabId, method, params) {
      debuggerCommands.push({ tabId, method, params });
      return {};
    },
    onSendMessage() {
      return {
        ok: true,
        page: {
          requestedUrl: "https://example.com/app",
          finalUrl: "https://example.com/app",
          title: "Example",
          textExcerpt: "Example page",
          statusCode: 200,
          interactives: [],
        },
        trace: [],
      };
    },
  });
  platform.detachDebugger = async (tabId) => {
    detachedTabs.push(tabId);
  };
  const executor = new ChromeRelayActionExecutor(platform);

  const result = await executor.execute({
    actionRequestId: "relay-action-permission",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-permission",
    actions: [
      { kind: "permission", action: "grant", permissions: ["notifications"], origin: "https://app.example.com/page" },
      { kind: "permission", action: "deny", permissions: ["camera"] },
      { kind: "permission", action: "reset" },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(debuggerCommands, [
    {
      tabId: 7,
      method: "Browser.setPermission",
      params: {
        permission: { name: "notifications" },
        setting: "granted",
        origin: "https://app.example.com",
      },
    },
    {
      tabId: 7,
      method: "Browser.setPermission",
      params: {
        permission: { name: "camera" },
        setting: "denied",
        origin: "https://example.com",
      },
    },
    {
      tabId: 7,
      method: "Browser.resetPermissions",
      params: {},
    },
  ]);
  assert.deepEqual(detachedTabs, [7]);
  assert.deepEqual(
    result.trace.map((entry) => entry.kind),
    ["permission", "permission", "permission"]
  );
});

test("chrome relay action executor arms network wait around a trigger action", async () => {
  const now = Date.now();
  const debuggerCommands: Array<{ tabId: number; method: string; params: Record<string, unknown> }> = [];
  const detachedTabs: number[] = [];
  let resolveNetwork:
    | ((event: { method: string; params: Record<string, unknown>; timestamp: number }) => void)
    | null = null;
  const sentMessages: unknown[] = [];
  const platform = fakePlatform({
    activeTab: { id: 7, windowId: 3, url: "https://example.com/app", title: "Example", status: "complete" },
    onDebuggerCommand(tabId, method, params) {
      debuggerCommands.push({ tabId, method, params });
      if (method === "Network.getResponseBody") {
        return { body: '{"ok":true}', base64Encoded: false };
      }
      return {};
    },
    onSendMessage(tabId, message) {
      sentMessages.push({ tabId, message });
      resolveNetwork?.({
        method: "Network.responseReceived",
        params: {
          requestId: "request-1",
          type: "Fetch",
          response: {
            url: "https://example.com/api/items",
            status: 201,
            mimeType: "application/json",
            headers: {
              "content-type": "application/json",
            },
          },
        },
        timestamp: 123,
      });
      return {
        ok: true,
        page: {
          requestedUrl: "https://example.com/app",
          finalUrl: "https://example.com/app",
          title: "Example",
          textExcerpt: "Example page",
          statusCode: 200,
          interactives: [],
        },
        trace: [
          {
            stepId: "task-network:relay-click:2",
            kind: "click",
            startedAt: 1,
            completedAt: 2,
            status: "ok",
            input: { text: "Submit" },
          },
        ],
      };
    },
  });
  platform.waitForDebuggerEvent = async (tabId, method, timeoutMs) => {
    assert.equal(tabId, 7);
    assert.equal(method, "Network.responseReceived");
    assert.equal(timeoutMs <= 1_000, true);
    return await new Promise((resolve) => {
      resolveNetwork = resolve;
    });
  };
  platform.drainDebuggerEvents = async (tabId, input) => {
    assert.equal(tabId, 7);
    assert.deepEqual(input, {
      include: ["Network.requestWillBeSent"],
      maxEvents: 100,
    });
    return [
      {
        method: "Network.requestWillBeSent",
        params: {
          requestId: "request-1",
          request: {
            method: "POST",
            url: "https://example.com/api/items",
          },
        },
        timestamp: 122,
      },
    ];
  };
  platform.detachDebugger = async (tabId) => {
    detachedTabs.push(tabId);
  };
  const executor = new ChromeRelayActionExecutor(platform);

  const result = await executor.execute({
    actionRequestId: "relay-action-network",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-network",
    actions: [
      {
        kind: "network",
        action: "waitForResponse",
        urlPattern: "/api/items",
        method: "POST",
        status: 201,
        includeHeaders: true,
        maxBodyBytes: 64,
        timeoutMs: 1_000,
      },
      { kind: "click", text: "Submit" },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(debuggerCommands, [
    { tabId: 7, method: "Network.enable", params: {} },
    { tabId: 7, method: "Network.getResponseBody", params: { requestId: "request-1" } },
  ]);
  assert.deepEqual(detachedTabs, [7]);
  assert.equal(sentMessages.length, 1);
  assert.equal(result.trace[0]?.kind, "network");
  assert.equal(result.trace[0]?.status, "ok");
  assert.deepEqual(result.trace[0]?.output, {
    action: "waitForResponse",
    matched: true,
    timeoutMs: 1_000,
    requestId: "request-1",
    url: "https://example.com/api/items",
    status: 201,
    method: "POST",
    resourceType: "Fetch",
    mimeType: "application/json",
    headers: [
      {
        name: "content-type",
        value: "application/json",
        valueBytes: 16,
        valueTruncated: false,
      },
    ],
    headerCount: 1,
    headersTruncated: false,
    bodyBytes: 11,
    bodyPreview: '{"ok":true}',
    bodyTruncated: false,
  });
  assert.equal(result.trace[1]?.kind, "click");
});

test("chrome relay action executor captures bounded network request details", async () => {
  const now = Date.now();
  const debuggerCommands: Array<{ tabId: number; method: string; params: Record<string, unknown> }> = [];
  const detachedTabs: number[] = [];
  let resolveNetwork:
    | ((event: { method: string; params: Record<string, unknown>; timestamp: number }) => void)
    | null = null;
  const sentMessages: unknown[] = [];
  const platform = fakePlatform({
    activeTab: { id: 7, windowId: 3, url: "https://example.com/app", title: "Example", status: "complete" },
    onDebuggerCommand(tabId, method, params) {
      debuggerCommands.push({ tabId, method, params });
      return {};
    },
    onSendMessage(tabId, message) {
      sentMessages.push({ tabId, message });
      resolveNetwork?.({
        method: "Network.requestWillBeSent",
        params: {
          requestId: "request-1",
          type: "Fetch",
          request: {
            method: "POST",
            url: "https://example.com/api/items",
            headers: {
              "content-type": "application/json",
            },
            postData: '{"name":"Ada"}',
          },
        },
        timestamp: 123,
      });
      return {
        ok: true,
        page: {
          requestedUrl: "https://example.com/app",
          finalUrl: "https://example.com/app",
          title: "Example",
          textExcerpt: "Example page",
          statusCode: 200,
          interactives: [],
        },
        trace: [
          {
            stepId: "task-network-request:relay-click:2",
            kind: "click",
            startedAt: 1,
            completedAt: 2,
            status: "ok",
            input: { text: "Submit" },
          },
        ],
      };
    },
  });
  platform.waitForDebuggerEvent = async (tabId, method, timeoutMs) => {
    assert.equal(tabId, 7);
    assert.equal(method, "Network.requestWillBeSent");
    assert.equal(timeoutMs <= 1_000, true);
    return await new Promise((resolve) => {
      resolveNetwork = resolve;
    });
  };
  platform.detachDebugger = async (tabId) => {
    detachedTabs.push(tabId);
  };
  const executor = new ChromeRelayActionExecutor(platform);

  const result = await executor.execute({
    actionRequestId: "relay-action-network-request",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-network-request",
    actions: [
      {
        kind: "network",
        action: "waitForRequest",
        urlPattern: "/api/items",
        method: "POST",
        includeHeaders: true,
        maxBodyBytes: 64,
        timeoutMs: 1_000,
      },
      { kind: "click", text: "Submit" },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(debuggerCommands, [{ tabId: 7, method: "Network.enable", params: {} }]);
  assert.deepEqual(detachedTabs, [7]);
  assert.equal(sentMessages.length, 1);
  assert.equal(result.trace[0]?.kind, "network");
  assert.equal(result.trace[0]?.status, "ok");
  assert.deepEqual(result.trace[0]?.output, {
    action: "waitForRequest",
    matched: true,
    timeoutMs: 1_000,
    requestId: "request-1",
    url: "https://example.com/api/items",
    method: "POST",
    resourceType: "Fetch",
    headers: [
      {
        name: "content-type",
        value: "application/json",
        valueBytes: 16,
        valueTruncated: false,
      },
    ],
    headerCount: 1,
    headersTruncated: false,
    bodyBytes: 14,
    bodyPreview: '{"name":"Ada"}',
    bodyTruncated: false,
  });
  assert.equal(result.trace[1]?.kind, "click");
});

test("chrome relay action executor mocks one network response around a trigger action", async () => {
  const now = Date.now();
  const debuggerCommands: Array<{ tabId: number; method: string; params: Record<string, unknown> }> = [];
  const detachedTabs: number[] = [];
  const queuedFetchEvents: Array<{ method: string; params: Record<string, unknown>; timestamp: number }> = [];
  let resolveFetch:
    | ((event: { method: string; params: Record<string, unknown>; timestamp: number }) => void)
    | null = null;
  const sentMessages: unknown[] = [];
  const platform = fakePlatform({
    activeTab: { id: 7, windowId: 3, url: "https://example.com/app", title: "Example", status: "complete" },
    onDebuggerCommand(tabId, method, params) {
      debuggerCommands.push({ tabId, method, params });
      return {};
    },
    onSendMessage(tabId, message) {
      sentMessages.push({ tabId, message });
      queuedFetchEvents.push({
        method: "Fetch.requestPaused",
        params: {
          requestId: "fetch-2",
          request: {
            method: "GET",
            url: "https://example.com/api/mock",
          },
        },
        timestamp: 124,
      });
      resolveFetch?.({
        method: "Fetch.requestPaused",
        params: {
          requestId: "fetch-1",
          request: {
            method: "GET",
            url: "https://example.com/asset.js",
          },
        },
        timestamp: 123,
      });
      return {
        ok: true,
        page: {
          requestedUrl: "https://example.com/app",
          finalUrl: "https://example.com/app",
          title: "Example",
          textExcerpt: "Example page",
          statusCode: 200,
          interactives: [],
        },
        trace: [
          {
            stepId: "task-network-mock:relay-click:2",
            kind: "click",
            startedAt: 1,
            completedAt: 2,
            status: "ok",
            input: { text: "Submit" },
          },
        ],
      };
    },
  });
  platform.waitForDebuggerEvent = async (tabId, method, timeoutMs) => {
    assert.equal(tabId, 7);
    assert.equal(method, "Fetch.requestPaused");
    assert.equal(timeoutMs <= 1_000, true);
    const queued = queuedFetchEvents.shift();
    if (queued) {
      return queued;
    }
    return await new Promise((resolve) => {
      resolveFetch = resolve;
    });
  };
  platform.detachDebugger = async (tabId) => {
    detachedTabs.push(tabId);
  };
  const executor = new ChromeRelayActionExecutor(platform);

  const result = await executor.execute({
    actionRequestId: "relay-action-network-mock",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-network-mock",
    actions: [
      {
        kind: "network",
        action: "mockResponse",
        urlPattern: "/api/mock",
        method: "GET",
        status: 202,
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
        timeoutMs: 1_000,
      },
      { kind: "click", text: "Submit" },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(debuggerCommands, [
    {
      tabId: 7,
      method: "Fetch.enable",
      params: { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
    },
    { tabId: 7, method: "Fetch.continueRequest", params: { requestId: "fetch-1" } },
    {
      tabId: 7,
      method: "Fetch.fulfillRequest",
      params: {
        requestId: "fetch-2",
        responseCode: 202,
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        body: "eyJvayI6dHJ1ZX0=",
      },
    },
    { tabId: 7, method: "Fetch.disable", params: {} },
  ]);
  assert.deepEqual(detachedTabs, [7]);
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(result.trace[0]?.output, {
    action: "mockResponse",
    matched: true,
    timeoutMs: 1_000,
    requestId: "fetch-2",
    url: "https://example.com/api/mock",
    method: "GET",
    status: 202,
    headerCount: 1,
    bodyBytes: 11,
  });
  assert.equal(result.trace[1]?.kind, "click");
});

test("chrome relay action executor applies and clears network URL blocks", async () => {
  const now = Date.now();
  const debuggerCommands: Array<{ tabId: number; method: string; params: Record<string, unknown> }> = [];
  const sentMessages: unknown[] = [];
  const detachedTabs: number[] = [];
  const platform = fakePlatform({
    activeTab: { id: 7, windowId: 3, url: "https://example.com/app", title: "Example", status: "complete" },
    onDebuggerCommand(tabId, method, params) {
      debuggerCommands.push({ tabId, method, params });
      return {};
    },
    onSendMessage(tabId, message) {
      sentMessages.push({ tabId, message });
      return {
        ok: true,
        page: {
          requestedUrl: "https://example.com/app",
          finalUrl: "https://example.com/app",
          title: "Example",
          textExcerpt: "Example page",
          statusCode: 200,
          interactives: [],
        },
        trace: [
          {
            stepId: "task-network-control:relay-snapshot:3",
            kind: "snapshot",
            startedAt: 1,
            completedAt: 2,
            status: "ok",
            input: { note: "final-relay-state" },
          },
        ],
      };
    },
  });
  platform.detachDebugger = async (tabId) => {
    detachedTabs.push(tabId);
  };
  const executor = new ChromeRelayActionExecutor(platform);

  const result = await executor.execute({
    actionRequestId: "relay-action-network-control",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-network-control",
    actions: [
      { kind: "network", action: "blockUrls", urlPatterns: ["*://*/analytics/*"] },
      { kind: "network", action: "clearBlockedUrls" },
      { kind: "network", action: "setExtraHeaders", headers: { "x-test": "1" } },
      { kind: "network", action: "clearExtraHeaders" },
      { kind: "network", action: "clearMockResponses" },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(debuggerCommands, [
    { tabId: 7, method: "Network.enable", params: {} },
    { tabId: 7, method: "Network.setBlockedURLs", params: { urls: ["*://*/analytics/*"] } },
    { tabId: 7, method: "Network.enable", params: {} },
    { tabId: 7, method: "Network.setBlockedURLs", params: { urls: [] } },
    { tabId: 7, method: "Network.enable", params: {} },
    { tabId: 7, method: "Network.setExtraHTTPHeaders", params: { headers: { "x-test": "1" } } },
    { tabId: 7, method: "Network.enable", params: {} },
    { tabId: 7, method: "Network.setExtraHTTPHeaders", params: { headers: {} } },
    { tabId: 7, method: "Fetch.disable", params: {} },
  ]);
  assert.deepEqual(detachedTabs, [7]);
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(
    result.trace.map((entry) => entry.kind),
    ["network", "network", "network", "network", "network", "snapshot"]
  );
  assert.deepEqual(result.trace[0]?.output, {
    action: "blockUrls",
    urlPatternCount: 1,
    blocked: true,
  });
  assert.deepEqual(result.trace[1]?.output, {
    action: "clearBlockedUrls",
    cleared: true,
  });
  assert.deepEqual(result.trace[2]?.output, {
    action: "setExtraHeaders",
    headerCount: 1,
    set: true,
  });
  assert.deepEqual(result.trace[3]?.output, {
    action: "clearExtraHeaders",
    cleared: true,
  });
  assert.deepEqual(result.trace[4]?.output, {
    action: "clearMockResponses",
    cleared: true,
  });
});

test("chrome relay action executor proxies completed downloads as payloads without local paths", async () => {
  const now = Date.now();
  const debuggerCommands: Array<{ tabId: number; method: string; params: Record<string, unknown> }> = [];
  const detachedTabs: number[] = [];
  let resolveDownloadBegin:
    | ((event: { method: string; params: Record<string, unknown>; timestamp: number }) => void)
    | null = null;
  let resolveDownloadProgress:
    | ((event: { method: string; params: Record<string, unknown>; timestamp: number }) => void)
    | null = null;
  const platform = fakePlatform({
    activeTab: { id: 7, windowId: 3, url: "https://example.com/report", title: "Report", status: "complete" },
    onDebuggerCommand(tabId, method, params) {
      debuggerCommands.push({ tabId, method, params });
      return {};
    },
    onSendMessage() {
      resolveDownloadBegin?.({
        method: "Page.downloadWillBegin",
        params: {
          guid: "download-1",
          url: "https://example.com/export.csv",
          suggestedFilename: "export.csv",
        },
        timestamp: 123,
      });
      setTimeout(() => {
        resolveDownloadProgress?.({
          method: "Page.downloadProgress",
          params: {
            guid: "download-1",
            state: "completed",
            receivedBytes: 14,
            totalBytes: 14,
          },
          timestamp: 124,
        });
      }, 0);
      return {
        ok: true,
        page: {
          requestedUrl: "https://example.com/report",
          finalUrl: "https://example.com/report",
          title: "Report",
          textExcerpt: "Report page",
          statusCode: 200,
          interactives: [],
        },
        trace: [
          {
            stepId: "task-download:relay-click:2",
            kind: "click",
            startedAt: 1,
            completedAt: 2,
            status: "ok",
            input: { text: "Export" },
          },
        ],
      };
    },
  });
  platform.waitForDebuggerEvent = async (tabId, method, timeoutMs) => {
    assert.equal(tabId, 7);
    assert.equal(timeoutMs <= 1_000, true);
    if (method === "Page.downloadWillBegin") {
      return await new Promise((resolve) => {
        resolveDownloadBegin = resolve;
      });
    }
    assert.equal(method, "Page.downloadProgress");
    return await new Promise((resolve) => {
      resolveDownloadProgress = resolve;
    });
  };
  platform.fetchDownload = async (url, input) => {
    assert.equal(url, "https://example.com/export.csv");
    assert.equal(input.maxBytes > 14, true);
    return {
      mimeType: "text/csv",
      dataBase64: "aWQsbmFtZQoxLEFkYQo=",
      sizeBytes: 14,
    };
  };
  platform.detachDebugger = async (tabId) => {
    detachedTabs.push(tabId);
  };
  const executor = new ChromeRelayActionExecutor(platform);

  const result = await executor.execute({
    actionRequestId: "relay-action-download",
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-download",
    actions: [
      { kind: "download", urlPattern: "/export.csv", timeoutMs: 1_000 },
      { kind: "click", text: "Export" },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(debuggerCommands, [{ tabId: 7, method: "Page.enable", params: {} }]);
  assert.deepEqual(detachedTabs, [7]);
  assert.equal(result.trace[0]?.kind, "download");
  assert.equal(result.trace[0]?.output?.fileName, "export.csv");
  assert.equal(result.trace[0]?.output?.path, undefined);
  assert.deepEqual(result.downloadPayloads, [
    {
      url: "https://example.com/export.csv",
      fileName: "export.csv",
      mimeType: "text/csv",
      dataBase64: "aWQsbmFtZQoxLEFkYQo=",
      sizeBytes: 14,
    },
  ]);
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
  onCreateTab?(createProperties: { url: string; active?: boolean }): void;
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
  const allTabs = [currentTab];
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
      return [...allTabs];
    },
    async getTab(tabId) {
      return allTabs.find((tab) => tab.id === tabId) ?? null;
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
      const index = allTabs.findIndex((tab) => tab.id === tabId);
      if (index >= 0) {
        allTabs[index] = currentTab;
      }
      return currentTab;
    },
    async createTab(createProperties) {
      input.onCreateTab?.(createProperties);
      currentTab = {
        id: currentTab.id + 1,
        ...(currentTab.windowId !== undefined ? { windowId: currentTab.windowId } : {}),
        url: createProperties.url,
        title: "Created",
        status: "complete",
      };
      allTabs.push(currentTab);
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
