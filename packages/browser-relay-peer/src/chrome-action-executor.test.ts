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
      { kind: "snapshot", note: "after-open" },
    ],
    createdAt: now,
    expiresAt: now + 5_000,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.relayTargetId, "chrome-tab:7");
  assert.equal(result.page?.finalUrl, "https://example.com/new");
  assert.equal(sentMessages.length, 1);
});

test("chrome relay action executor captures screenshot payloads through the extension platform", async () => {
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
        return "data:image/png;base64,c2NyZWVuc2hvdA==";
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

function fakePlatform(input: {
  activeTab: { id: number; windowId?: number; url: string; title: string; status: "complete" | "loading" };
  onSendMessage(tabId: number, message: unknown): unknown;
  onCaptureVisibleTab?(windowId?: number): string;
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
    async captureVisibleTab(windowId) {
      return input.onCaptureVisibleTab?.(windowId) ?? "data:image/png;base64,";
    },
  };
}
