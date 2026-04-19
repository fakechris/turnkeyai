import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { BrowserContext, Page } from "playwright-core";

import { ChromeSessionManager } from "./chrome-session-manager";

test("chrome session manager reuses and closes live persistent contexts by browser session id", async () => {
  let closeHandler: (() => void) | undefined;
  let closeCount = 0;
  let launchCount = 0;
  const closedSessions: Array<{ browserSessionId: string; reason: string }> = [];

  const fakeContext = {
    on(event: string, handler: () => void) {
      if (event === "close") {
        closeHandler = handler;
      }
      return this;
    },
    async close() {
      closeCount += 1;
      closeHandler?.();
    },
  } as unknown as BrowserContext;

  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    browserSessionManager: {
      async closeSession(browserSessionId: string, reason: string) {
        closedSessions.push({ browserSessionId, reason });
      },
    } as never,
    launchPersistentContext: async () => {
      launchCount += 1;
      return fakeContext;
    },
    createEphemeralContext: async () => fakeContext,
  });

  const internal = manager as unknown as {
    createContext(lease: {
      session: { browserSessionId: string };
      profile: { persistentDir: string };
    }): Promise<{ context: BrowserContext; keepAlive: boolean; liveReuse: boolean }>;
  };

  const first = await internal.createContext({
    session: { browserSessionId: "browser-session-1" },
    profile: { persistentDir: "/tmp/browser-session-1" },
  });
  const second = await internal.createContext({
    session: { browserSessionId: "browser-session-1" },
    profile: { persistentDir: "/tmp/browser-session-1" },
  });

  assert.equal(first.keepAlive, true);
  assert.equal(first.liveReuse, false);
  assert.equal(second.keepAlive, true);
  assert.equal(second.liveReuse, true);
  assert.equal(first.context, second.context);
  assert.equal(launchCount, 1);

  await manager.closeSession("browser-session-1", "test complete");
  assert.equal(closeCount, 1);
  assert.deepEqual(closedSessions, [{ browserSessionId: "browser-session-1", reason: "test complete" }]);

  const third = await internal.createContext({
    session: { browserSessionId: "browser-session-1" },
    profile: { persistentDir: "/tmp/browser-session-1" },
  });
  assert.equal(third.keepAlive, true);
  assert.equal(third.liveReuse, false);
  assert.equal(launchCount, 2);
});

test("chrome session manager reports hot resume when matching the active target in a live context", async () => {
  const matchingPage = {
    url() {
      return "https://example.com/pricing";
    },
    async title() {
      return "Pricing";
    },
  } as unknown as Page;
  const otherPage = {
    url() {
      return "https://example.com/";
    },
    async title() {
      return "Home";
    },
  } as unknown as Page;
  const fakeContext = {
    pages() {
      return [otherPage, matchingPage];
    },
    async newPage() {
      throw new Error("should not create a new page when a target-matching page exists");
    },
  } as unknown as BrowserContext;

  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    browserSessionManager: {
      async listTargets() {
        return [
          {
            targetId: "target-1",
            browserSessionId: "browser-session-2",
            ownerType: "thread",
            ownerId: "thread-1",
            url: "https://example.com/pricing",
            title: "Pricing",
            status: "attached",
            createdAt: 1,
            updatedAt: 2,
          },
        ];
      },
    } as never,
  });

  const internal = manager as unknown as {
    resolvePageForTask(input: {
      context: BrowserContext;
      sessionId: string;
      liveReuse: boolean;
      currentTargetId?: string;
      actions: Array<{ kind: string }>;
    }): Promise<{ page: Page; resumeMode: "hot" | "warm" | "cold"; targetResolution: "attach" | "reconnect" | "reopen" | "new_target" }>;
  };

  const result = await internal.resolvePageForTask({
    context: fakeContext,
    sessionId: "browser-session-2",
    liveReuse: true,
    currentTargetId: "target-1",
    actions: [],
  });

  assert.equal(result.page, matchingPage);
  assert.equal(result.resumeMode, "hot");
  assert.equal(result.targetResolution, "attach");
});

test("chrome session manager reports warm resume when metadata survives but live handles do not", async () => {
  const matchingPage = {
    url() {
      return "https://example.com/pricing";
    },
    async title() {
      return "Pricing";
    },
  } as unknown as Page;
  const fakeContext = {
    pages() {
      return [matchingPage];
    },
    async newPage() {
      throw new Error("should not create a new page when a URL-matching page exists");
    },
  } as unknown as BrowserContext;

  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    browserSessionManager: {
      async listTargets() {
        return [
          {
            targetId: "target-warm",
            browserSessionId: "browser-session-3",
            ownerType: "thread",
            ownerId: "thread-1",
            transportSessionId: "stale-page-handle",
            url: "https://example.com/pricing",
            title: "Pricing",
            status: "attached",
            createdAt: 1,
            updatedAt: 2,
          },
        ];
      },
    } as never,
  });

  const internal = manager as unknown as {
    resolvePageForTask(input: {
      context: BrowserContext;
      sessionId: string;
      liveReuse: boolean;
      currentTargetId?: string;
      actions: Array<{ kind: string }>;
    }): Promise<{ page: Page; resumeMode: "hot" | "warm" | "cold"; targetResolution: "attach" | "reconnect" | "reopen" | "new_target" }>;
  };

  const result = await internal.resolvePageForTask({
    context: fakeContext,
    sessionId: "browser-session-3",
    liveReuse: false,
    currentTargetId: "target-warm",
    actions: [],
  });

  assert.equal(result.page, matchingPage);
  assert.equal(result.resumeMode, "warm");
  assert.equal(result.targetResolution, "reconnect");
});

test("chrome session manager reconnects a detached target with cold resume by reopening its last URL", async () => {
  let gotoUrl = "";
  let settleTitle = "Pricing";
  const reconnectedPage = {
    url() {
      return gotoUrl || "about:blank";
    },
    async title() {
      return settleTitle;
    },
    async goto(url: string) {
      gotoUrl = url;
      return { status: () => 200 };
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      return undefined;
    },
  } as unknown as Page;
  const fakeContext = {
    pages() {
      return [];
    },
    async newPage() {
      return reconnectedPage;
    },
  } as unknown as BrowserContext;

  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    browserSessionManager: {
      async listTargets() {
        return [
          {
            targetId: "target-detached",
            browserSessionId: "browser-session-4",
            ownerType: "thread",
            ownerId: "thread-1",
            url: "https://example.com/pricing",
            title: "Pricing",
            status: "detached",
            createdAt: 1,
            updatedAt: 2,
          },
        ];
      },
    } as never,
  });

  const internal = manager as unknown as {
    resolvePageForTask(input: {
      context: BrowserContext;
      sessionId: string;
      liveReuse: boolean;
      currentTargetId?: string;
      actions: Array<{ kind: string }>;
    }): Promise<{ page: Page; resumeMode: "hot" | "warm" | "cold"; targetResolution: "attach" | "reconnect" | "reopen" | "new_target" }>;
  };

  const result = await internal.resolvePageForTask({
    context: fakeContext,
    sessionId: "browser-session-4",
    liveReuse: false,
    currentTargetId: "target-detached",
    actions: [{ kind: "snapshot" }],
  });

  assert.equal(result.page, reconnectedPage);
  assert.equal(result.resumeMode, "cold");
  assert.equal(result.targetResolution, "reopen");
  assert.equal(gotoUrl, "https://example.com/pricing");
});

test("chrome session manager does not attach a detached target to a different live page with the same URL", async () => {
  const livePricingPage = {
    url() {
      return "https://example.com/pricing";
    },
    async title() {
      return "Pricing";
    },
  } as unknown as Page;
  let gotoUrl = "";
  const reopenedPage = {
    url() {
      return gotoUrl || "about:blank";
    },
    async title() {
      return gotoUrl ? "Pricing" : "Blank";
    },
    async goto(url: string) {
      gotoUrl = url;
      return { status: () => 200 };
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      return undefined;
    },
  } as unknown as Page;
  const fakeContext = {
    pages() {
      return [livePricingPage];
    },
    async newPage() {
      return reopenedPage;
    },
  } as unknown as BrowserContext;

  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    browserSessionManager: {
      async listTargets() {
        return [
          {
            targetId: "target-detached-same-url",
            browserSessionId: "browser-session-detached-same-url",
            ownerType: "thread",
            ownerId: "thread-1",
            transportSessionId: "stale-detached-handle",
            url: "https://example.com/pricing",
            title: "Pricing",
            status: "detached",
            createdAt: 1,
            updatedAt: 2,
          },
        ];
      },
    } as never,
  });

  const internal = manager as unknown as {
    resolvePageForTask(input: {
      context: BrowserContext;
      sessionId: string;
      liveReuse: boolean;
      currentTargetId?: string;
      actions: Array<{ kind: string }>;
    }): Promise<{ page: Page; resumeMode: "hot" | "warm" | "cold"; targetResolution: "attach" | "reconnect" | "reopen" | "new_target" }>;
  };

  const result = await internal.resolvePageForTask({
    context: fakeContext,
    sessionId: "browser-session-detached-same-url",
    liveReuse: false,
    currentTargetId: "target-detached-same-url",
    actions: [{ kind: "snapshot" }],
  });

  assert.equal(result.page, reopenedPage);
  assert.equal(result.resumeMode, "cold");
  assert.equal(result.targetResolution, "reopen");
  assert.equal(gotoUrl, "https://example.com/pricing");
});

test("chrome session manager rejects invalid detached-target resume when no reopen URL is available", async () => {
  const fakeContext = {
    pages() {
      return [];
    },
    async newPage() {
      return {} as Page;
    },
  } as unknown as BrowserContext;

  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    browserSessionManager: {
      async listTargets() {
        return [
          {
            targetId: "target-detached",
            browserSessionId: "browser-session-6",
            ownerType: "thread",
            ownerId: "thread-1",
            url: "",
            title: "Detached",
            status: "detached",
            createdAt: 1,
            updatedAt: 2,
          },
        ];
      },
    } as never,
  });

  const internal = manager as unknown as {
    resolvePageForTask(input: {
      context: BrowserContext;
      sessionId: string;
      liveReuse: boolean;
      currentTargetId?: string;
      actions: Array<{ kind: string }>;
    }): Promise<{ page: Page; resumeMode: "hot" | "warm" | "cold"; targetResolution: "attach" | "reconnect" | "reopen" | "new_target" }>;
  };

  await assert.rejects(
    () =>
      internal.resolvePageForTask({
        context: fakeContext,
        sessionId: "browser-session-6",
        liveReuse: false,
        currentTargetId: "target-detached",
        actions: [{ kind: "snapshot" }],
      }),
    /invalid resume: detached target cannot be reopened without a URL/
  );
});

test("chrome session manager allows detached target resume when the first action opens a new URL", async () => {
  const page = {} as unknown as Page;
  const fakeContext = {
    pages() {
      return [];
    },
    async newPage() {
      return page;
    },
  } as unknown as BrowserContext;

  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    browserSessionManager: {
      async listTargets() {
        return [
          {
            targetId: "target-detached-open",
            browserSessionId: "browser-session-7",
            ownerType: "thread",
            ownerId: "thread-1",
            url: "",
            title: "Detached",
            status: "detached",
            createdAt: 1,
            updatedAt: 2,
          },
        ];
      },
    } as never,
  });

  const internal = manager as unknown as {
    resolvePageForTask(input: {
      context: BrowserContext;
      sessionId: string;
      liveReuse: boolean;
      currentTargetId?: string;
      actions: Array<{ kind: string; url?: string }>;
    }): Promise<{ page: Page; resumeMode: "hot" | "warm" | "cold"; targetResolution: "attach" | "reconnect" | "reopen" | "new_target" }>;
  };

  const result = await internal.resolvePageForTask({
    context: fakeContext,
    sessionId: "browser-session-7",
    liveReuse: false,
    currentTargetId: "target-detached-open",
    actions: [{ kind: "open", url: "https://example.com" }],
  });

  assert.equal(result.resumeMode, "cold");
  assert.equal(result.targetResolution, "new_target");
  assert.equal(result.page, page);
});

test("chrome session manager does not reuse a blank page after manager restart when the stored handle belongs to an older runtime", async () => {
  const stalePage = {
    url() {
      return "about:blank";
    },
    async title() {
      return "";
    },
  } as unknown as Page;
  let gotoUrl = "";
  const reopenedPage = {
    url() {
      return gotoUrl || "about:blank";
    },
    async title() {
      return gotoUrl ? "Pricing" : "";
    },
    async goto(url: string) {
      gotoUrl = url;
      return { status: () => 200 };
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      return undefined;
    },
  } as unknown as Page;
  const fakeContext = {
    pages() {
      return [stalePage];
    },
    async newPage() {
      return reopenedPage;
    },
  } as unknown as BrowserContext;

  const oldManager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    createId: (() => {
      let tick = 0;
      return (prefix: string) => `${prefix}-${++tick}`;
    })(),
  });
  const oldInternal = oldManager as unknown as {
    getOrCreatePageHandle(page: Page): string;
  };
  const persistedTransportSessionId = oldInternal.getOrCreatePageHandle(stalePage);

  const newManager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    createId: (() => {
      let tick = 100;
      return (prefix: string) => `${prefix}-${++tick}`;
    })(),
    browserSessionManager: {
      async listTargets() {
        return [
          {
            targetId: "target-restart-reopen",
            browserSessionId: "browser-session-restart",
            ownerType: "thread",
            ownerId: "thread-1",
            transportSessionId: persistedTransportSessionId,
            url: "https://example.com/pricing",
            title: "Pricing",
            status: "attached",
            createdAt: 1,
            updatedAt: 2,
          },
        ];
      },
    } as never,
  });

  const internal = newManager as unknown as {
    resolvePageForTask(input: {
      context: BrowserContext;
      sessionId: string;
      liveReuse: boolean;
      currentTargetId?: string;
      actions: Array<{ kind: string }>;
    }): Promise<{ page: Page; resumeMode: "hot" | "warm" | "cold"; targetResolution: "attach" | "reconnect" | "reopen" | "new_target" }>;
  };

  const result = await internal.resolvePageForTask({
    context: fakeContext,
    sessionId: "browser-session-restart",
    liveReuse: false,
    currentTargetId: "target-restart-reopen",
    actions: [{ kind: "snapshot" }],
  });

  assert.equal(result.page, reopenedPage);
  assert.equal(result.resumeMode, "cold");
  assert.equal(result.targetResolution, "reopen");
  assert.equal(gotoUrl, "https://example.com/pricing");
});

test("chrome session manager releases a resumed session when openTarget fails", async () => {
  let released = 0;
  const fakeContext = {
    on() {
      return this;
    },
    async newPage() {
      throw new Error("new page failed");
    },
  } as unknown as BrowserContext;

  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    browserSessionManager: {
      async resumeSession(input: { browserSessionId: string }) {
        return {
          session: {
            browserSessionId: input.browserSessionId,
            ownerType: "thread",
            ownerId: "thread-1",
            profileId: "profile-1",
            status: "busy",
            targetIds: [],
            activeTargetId: undefined,
            lastActiveAt: 1,
            createdAt: 1,
            updatedAt: 1,
          },
          profile: {
            profileId: "profile-1",
            ownerType: "thread",
            ownerId: "thread-1",
            persistentDir: "/tmp/browser-profile-1",
            loginState: "unknown",
            createdAt: 1,
            updatedAt: 1,
          },
        };
      },
      async releaseSession() {
        released += 1;
      },
    } as never,
    launchPersistentContext: async () => fakeContext,
    createEphemeralContext: async () => fakeContext,
  });

  await assert.rejects(() => manager.openTarget("browser-session-5", "https://example.com"));
  assert.equal(released, 1);
});

test("chrome session manager executes hover key select drag and waitFor input actions", async () => {
  const hoverSelectors: string[] = [];
  let hoverCount = 0;
  const pressedShortcuts: string[] = [];
  const selectedOptions: unknown[] = [];
  const draggedTargets: unknown[] = [];
  const locatorWaits: unknown[] = [];
  const waits: Array<{ kind: "load" | "timeout"; value: string | number }> = [];
  const fakeLocator = {
    first() {
      return this;
    },
    async count() {
      return 1;
    },
    async hover() {
      hoverCount += 1;
    },
    async selectOption(option: unknown) {
      selectedOptions.push(option);
      return ["team"];
    },
    async dragTo(target: unknown) {
      draggedTargets.push(target);
    },
    async waitFor(input: unknown) {
      locatorWaits.push(input);
    },
  };
  const fakePage = {
    locator(selector: string) {
      hoverSelectors.push(selector);
      return fakeLocator;
    },
    keyboard: {
      async press(shortcut: string) {
        pressedShortcuts.push(shortcut);
      },
    },
    async waitForLoadState(state: string) {
      waits.push({ kind: "load", value: state });
    },
    async waitForTimeout(timeoutMs: number) {
      waits.push({ kind: "timeout", value: timeoutMs });
    },
    url() {
      return "https://example.com/menu";
    },
  } as unknown as Page;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
  });
  const internal = manager as unknown as {
    executeAction(input: {
      page: Page;
      action: {
        kind: string;
        selectors?: string[];
        key?: string;
        modifiers?: string[];
        value?: string;
        label?: string;
        index?: number;
        source?: { selectors?: string[]; refId?: string; text?: string };
        target?: { selectors?: string[]; refId?: string; text?: string };
        text?: string;
        state?: string;
        timeoutMs?: number;
      };
      stepIndex: number;
      sessionDir: string;
      requestedUrl: string;
      lastStatusCode: number;
      knownRefs: Map<string, unknown>;
      browserSessionId: string;
    }): Promise<{ traceOutput?: Record<string, unknown> }>;
  };

  const hoverOutput = await internal.executeAction({
    page: fakePage,
    action: { kind: "hover", selectors: ["button.menu"] },
    stepIndex: 1,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-input",
  });
  const keyOutput = await internal.executeAction({
    page: fakePage,
    action: { kind: "key", key: "K", modifiers: ["Control", "Shift"] },
    stepIndex: 2,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-input",
  });
  const selectOutput = await internal.executeAction({
    page: fakePage,
    action: { kind: "select", selectors: ["select[name=plan]"], value: "team" },
    stepIndex: 3,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-input",
  });
  const dragOutput = await internal.executeAction({
    page: fakePage,
    action: { kind: "drag", source: { selectors: ["#card"] }, target: { selectors: ["#lane"] } },
    stepIndex: 4,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-input",
  });
  const waitForOutput = await internal.executeAction({
    page: fakePage,
    action: { kind: "waitFor", selectors: ["#done"], state: "attached", timeoutMs: 1_000 },
    stepIndex: 5,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-input",
  });

  assert.deepEqual(hoverSelectors, ["button.menu", "select[name=plan]", "#card", "#lane", "#done"]);
  assert.equal(hoverCount, 1);
  assert.deepEqual(pressedShortcuts, ["Control+Shift+K"]);
  assert.deepEqual(selectedOptions, ["team"]);
  assert.equal(draggedTargets.length, 1);
  assert.deepEqual(locatorWaits, [{ state: "attached", timeout: 1_000 }]);
  assert.equal(hoverOutput.traceOutput?.finalUrl, "https://example.com/menu");
  assert.equal(keyOutput.traceOutput?.shortcut, "Control+Shift+K");
  assert.deepEqual(selectOutput.traceOutput?.selectedValues, ["team"]);
  const dragSource = dragOutput.traceOutput?.source as { selectors?: string[] } | undefined;
  assert.equal(dragSource?.selectors?.[0], "#card");
  assert.equal(waitForOutput.traceOutput?.timeoutMs, 1_000);
  assert.equal(waitForOutput.traceOutput?.state, "attached");
  assert.deepEqual(
    waits.map((wait) => wait.kind),
    ["load", "timeout", "load", "timeout", "load", "timeout", "load", "timeout"]
  );
});

test("chrome session manager executes waitFor page conditions", async () => {
  const waitedUrls: string[] = [];
  const waitedFunctions: string[] = [];
  const fakePage = {
    async waitForURL(predicate: (url: URL) => boolean, options: { timeout?: number }) {
      assert.equal(predicate(new URL("https://example.com/done")), true);
      waitedUrls.push(`timeout:${options.timeout}`);
    },
    async waitForFunction(expression: string, _arg: unknown, options: { timeout?: number }) {
      assert.doesNotThrow(() => new Function(`return ${expression};`));
      waitedFunctions.push(`${expression.includes("document.title") ? "title" : "body"}:${options.timeout}`);
    },
    url() {
      return "https://example.com/done";
    },
  } as unknown as Page;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
  });
  const internal = manager as unknown as {
    executeAction(input: {
      page: Page;
      action:
        | { kind: "waitFor"; urlPattern: string; timeoutMs?: number }
        | { kind: "waitFor"; titlePattern: string; timeoutMs?: number }
        | { kind: "waitFor"; bodyTextPattern: string; timeoutMs?: number };
      stepIndex: number;
      sessionDir: string;
      requestedUrl: string;
      lastStatusCode: number;
      knownRefs: Map<string, unknown>;
      browserSessionId: string;
    }): Promise<{ traceOutput?: Record<string, unknown> }>;
  };
  const base = {
    page: fakePage,
    stepIndex: 1,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map<string, unknown>(),
    browserSessionId: "browser-session-wait",
  };

  const urlOutput = await internal.executeAction({
    ...base,
    action: { kind: "waitFor", urlPattern: "/done", timeoutMs: 1_000 },
  });
  const titleOutput = await internal.executeAction({
    ...base,
    action: { kind: "waitFor", titlePattern: "Done", timeoutMs: 2_000 },
  });
  const bodyOutput = await internal.executeAction({
    ...base,
    action: { kind: "waitFor", bodyTextPattern: "Submitted", timeoutMs: 3_000 },
  });

  assert.deepEqual(waitedUrls, ["timeout:1000"]);
  assert.deepEqual(waitedFunctions, ["title:2000", "body:3000"]);
  assert.equal(urlOutput.traceOutput?.urlPattern, "/done");
  assert.equal(titleOutput.traceOutput?.titlePattern, "Done");
  assert.equal(bodyOutput.traceOutput?.bodyTextPattern, "Submitted");
});

test("chrome session manager executes probe actions without exposing field values", async () => {
  let evaluateScript = "";
  const fakePage = {
    async evaluate(script: string) {
      evaluateScript = script;
      return [{ tagName: "input", name: "email", valueLength: 17 }];
    },
  } as unknown as Page;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
  });
  const internal = manager as unknown as {
    executeAction(input: {
      page: Page;
      action: { kind: "probe"; probe: "forms"; maxItems?: number };
      stepIndex: number;
      sessionDir: string;
      requestedUrl: string;
      lastStatusCode: number;
      knownRefs: Map<string, unknown>;
      browserSessionId: string;
    }): Promise<{ traceOutput?: Record<string, unknown> }>;
  };

  const output = await internal.executeAction({
    page: fakePage,
    action: { kind: "probe", probe: "forms", maxItems: 3 },
    stepIndex: 1,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-probe",
  });

  assert.match(evaluateScript, /const probe = "forms"/);
  assert.match(evaluateScript, /Math\.min\(3, 50\)/);
  assert.doesNotThrow(() => new Function(`return ${evaluateScript};`));
  assert.equal(output.traceOutput?.probe, "forms");
  assert.deepEqual(output.traceOutput?.result, [{ tagName: "input", name: "email", valueLength: 17 }]);
});

test("chrome session manager executes permission grant deny and reset actions", async () => {
  const granted: unknown[] = [];
  const cdpCommands: Array<{ method: string; params: unknown }> = [];
  let cleared = 0;
  const context = {
    async grantPermissions(permissions: string[], options: unknown) {
      granted.push({ permissions, options });
    },
    async clearPermissions() {
      cleared += 1;
    },
    async newCDPSession() {
      return {
        async send(method: string, params: unknown) {
          cdpCommands.push({ method, params });
        },
        async detach() {
          return undefined;
        },
      };
    },
  };
  const fakePage = {
    context() {
      return context;
    },
    url() {
      return "https://example.com/request";
    },
  } as unknown as Page;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
  });
  const internal = manager as unknown as {
    executeAction(input: {
      page: Page;
      action:
        | { kind: "permission"; action: "grant"; permissions: ["notifications"]; origin?: string }
        | { kind: "permission"; action: "deny"; permissions: ["camera"] }
        | { kind: "permission"; action: "reset" };
      stepIndex: number;
      sessionDir: string;
      requestedUrl: string;
      lastStatusCode: number;
      knownRefs: Map<string, unknown>;
      browserSessionId: string;
    }): Promise<{ traceOutput?: Record<string, unknown> }>;
  };

  const base = {
    page: fakePage,
    stepIndex: 1,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map<string, unknown>(),
    browserSessionId: "browser-session-permission",
  };
  const grantOutput = await internal.executeAction({
    ...base,
    action: { kind: "permission", action: "grant", permissions: ["notifications"], origin: "https://app.example.com/page" },
  });
  const denyOutput = await internal.executeAction({
    ...base,
    action: { kind: "permission", action: "deny", permissions: ["camera"] },
  });
  const resetOutput = await internal.executeAction({
    ...base,
    action: { kind: "permission", action: "reset" },
  });

  assert.deepEqual(granted, [
    {
      permissions: ["notifications"],
      options: { origin: "https://app.example.com" },
    },
  ]);
  assert.deepEqual(cdpCommands, [
    {
      method: "Browser.setPermission",
      params: {
        permission: { name: "camera" },
        setting: "denied",
        origin: "https://example.com",
      },
    },
  ]);
  assert.equal(cleared, 1);
  assert.equal(grantOutput.traceOutput?.origin, "https://app.example.com");
  assert.equal(denyOutput.traceOutput?.action, "deny");
  assert.equal(resetOutput.traceOutput?.resetAll, true);
});

test("chrome session manager arms and handles prompt dialogs around page actions", async () => {
  let dialogHandler: ((dialog: unknown) => void | Promise<void>) | null = null;
  let acceptedPrompt: string | undefined;
  let clickCount = 0;
  const fakeLocator = {
    first() {
      return this;
    },
    async count() {
      return 1;
    },
    async click() {
      clickCount += 1;
      await dialogHandler?.({
        type: () => "prompt",
        message: () => "Continue?",
        accept: async (value?: string) => {
          acceptedPrompt = value;
        },
        dismiss: async () => undefined,
      });
    },
  };
  const fakePage = {
    once(eventName: string, handler: (dialog: unknown) => void) {
      assert.equal(eventName, "dialog");
      dialogHandler = handler;
    },
    off(eventName: string) {
      assert.equal(eventName, "dialog");
      dialogHandler = null;
    },
    locator() {
      return fakeLocator;
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      return undefined;
    },
    url() {
      return "https://example.com/form";
    },
  } as unknown as Page;
  const fakeContext = {
    pages() {
      return [fakePage];
    },
    async newPage() {
      return fakePage;
    },
    async close() {
      return undefined;
    },
  } as unknown as BrowserContext;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    createEphemeralContext: async () => fakeContext,
    captureSnapshot: async () => ({
      requestedUrl: "https://example.com/form",
      finalUrl: "https://example.com/form",
      title: "Form",
      textExcerpt: "Form page",
      statusCode: 200,
      interactives: [],
    }),
  });

  const result = await manager.spawnSession({
    taskId: "task-dialog",
    threadId: "thread-dialog",
    instructions: "Submit a prompted form",
    actions: [
      { kind: "dialog", action: "accept", promptText: "yes", timeoutMs: 1_000 },
      { kind: "click", selectors: ["button.submit"] },
    ],
  });

  assert.equal(clickCount, 1);
  assert.equal(acceptedPrompt, "yes");
  assert.equal(result.trace[0]?.kind, "dialog");
  assert.equal(result.trace[0]?.status, "ok");
  assert.equal(result.trace[0]?.output?.type, "prompt");
  assert.equal(result.trace[1]?.kind, "click");
});

test("chrome session manager switches to an armed popup page after the trigger action", async () => {
  let resolvePopup: ((page: Page) => void) | null = null;
  const popupPage = {
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      return undefined;
    },
    url() {
      return "https://example.com/popup";
    },
    async title() {
      return "Popup";
    },
  } as unknown as Page;
  const fakeLocator = {
    first() {
      return this;
    },
    async count() {
      return 1;
    },
    async click() {
      resolvePopup?.(popupPage);
    },
  };
  const openerPage = {
    waitForEvent(eventName: string) {
      assert.equal(eventName, "popup");
      return new Promise<Page>((resolve) => {
        resolvePopup = resolve;
      });
    },
    locator() {
      return fakeLocator;
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      return undefined;
    },
    url() {
      return "https://example.com/start";
    },
    async title() {
      return "Start";
    },
  } as unknown as Page;
  const fakeContext = {
    pages() {
      return [openerPage];
    },
    async newPage() {
      return openerPage;
    },
    async close() {
      return undefined;
    },
  } as unknown as BrowserContext;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    createEphemeralContext: async () => fakeContext,
    captureSnapshot: async ({ page }) => ({
      requestedUrl: page.url(),
      finalUrl: page.url(),
      title: page === popupPage ? "Popup" : "Start",
      textExcerpt: page === popupPage ? "Popup page" : "Start page",
      statusCode: 200,
      interactives: [],
    }),
  });

  const result = await manager.spawnSession({
    taskId: "task-popup",
    threadId: "thread-popup",
    instructions: "Open popup",
    actions: [
      { kind: "popup", timeoutMs: 1_000 },
      { kind: "click", selectors: ["a.popup"] },
    ],
  });

  assert.equal(result.page.finalUrl, "https://example.com/popup");
  assert.equal(result.trace[0]?.kind, "popup");
  assert.equal(result.trace[0]?.output?.finalUrl, "https://example.com/popup");
  assert.equal(result.trace[1]?.kind, "click");
});

test("chrome session manager arms network wait around a trigger action", async () => {
  let responsePredicate: ((response: unknown) => boolean) | null = null;
  let resolveNetwork: ((response: unknown) => void) | null = null;
  const response = {
    url() {
      return "https://example.com/api/items";
    },
    status() {
      return 201;
    },
    request() {
      return {
        method() {
          return "POST";
        },
      };
    },
  };
  const fakeLocator = {
    first() {
      return this;
    },
    async count() {
      return 1;
    },
    async click() {
      if (responsePredicate?.(response)) {
        resolveNetwork?.(response);
      }
    },
  };
  const page = {
    waitForResponse(predicate: (response: unknown) => boolean) {
      responsePredicate = predicate;
      return new Promise((resolve) => {
        resolveNetwork = resolve;
      });
    },
    locator() {
      return fakeLocator;
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      return undefined;
    },
    url() {
      return "https://example.com/start";
    },
    async title() {
      return "Start";
    },
  } as unknown as Page;
  const fakeContext = {
    pages() {
      return [page];
    },
    async newPage() {
      return page;
    },
    async close() {
      return undefined;
    },
  } as unknown as BrowserContext;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    createEphemeralContext: async () => fakeContext,
    captureSnapshot: async () => ({
      requestedUrl: "https://example.com/start",
      finalUrl: "https://example.com/start",
      title: "Start",
      textExcerpt: "Start page",
      statusCode: 200,
      interactives: [],
    }),
  });

  const result = await manager.spawnSession({
    taskId: "task-network",
    threadId: "thread-network",
    instructions: "Wait for API",
    actions: [
      { kind: "network", action: "waitForResponse", urlPattern: "/api/items", method: "POST", status: 201, timeoutMs: 1_000 },
      { kind: "click", selectors: ["button.submit"] },
    ],
  });

  assert.equal(result.trace[0]?.kind, "network");
  assert.equal(result.trace[0]?.status, "ok");
  assert.deepEqual(result.trace[0]?.output, {
    action: "waitForResponse",
    matched: true,
    timeoutMs: 1_000,
    url: "https://example.com/api/items",
    status: 201,
    method: "POST",
  });
  assert.equal(result.trace[1]?.kind, "click");
});

test("chrome session manager captures bounded network request details", async () => {
  let requestPredicate: ((request: unknown) => boolean) | null = null;
  let resolveNetwork: ((request: unknown) => void) | null = null;
  const request = {
    url() {
      return "https://example.com/api/items";
    },
    method() {
      return "POST";
    },
    headers() {
      return { "content-type": "application/json" };
    },
    postDataBuffer() {
      return Buffer.from('{"name":"Ada"}', "utf8");
    },
  };
  const fakeLocator = {
    first() {
      return this;
    },
    async count() {
      return 1;
    },
    async click() {
      if (requestPredicate?.(request)) {
        resolveNetwork?.(request);
      }
    },
  };
  const page = {
    waitForRequest(predicate: (request: unknown) => boolean) {
      requestPredicate = predicate;
      return new Promise((resolve) => {
        resolveNetwork = resolve;
      });
    },
    locator() {
      return fakeLocator;
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      return undefined;
    },
    url() {
      return "https://example.com/start";
    },
    async title() {
      return "Start";
    },
  } as unknown as Page;
  const fakeContext = {
    pages() {
      return [page];
    },
    async newPage() {
      return page;
    },
    async close() {
      return undefined;
    },
  } as unknown as BrowserContext;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    createEphemeralContext: async () => fakeContext,
    captureSnapshot: async () => ({
      requestedUrl: "https://example.com/start",
      finalUrl: "https://example.com/start",
      title: "Start",
      textExcerpt: "Start page",
      statusCode: 200,
      interactives: [],
    }),
  });

  const result = await manager.spawnSession({
    taskId: "task-network-request",
    threadId: "thread-network-request",
    instructions: "Wait for API request",
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
      { kind: "click", selectors: ["button.submit"] },
    ],
  });

  assert.equal(result.trace[0]?.kind, "network");
  assert.equal(result.trace[0]?.status, "ok");
  assert.deepEqual(result.trace[0]?.output, {
    action: "waitForRequest",
    matched: true,
    timeoutMs: 1_000,
    url: "https://example.com/api/items",
    method: "POST",
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
    bodyPreviewBase64: "eyJuYW1lIjoiQWRhIn0=",
    bodyTruncated: false,
  });
  assert.equal(result.trace[1]?.kind, "click");
});

test("chrome session manager mocks one network response around a trigger action", async () => {
  let routeHandler: ((route: ReturnType<typeof createRoute>) => void | Promise<void>) | null = null;
  let fallbackRoute: ReturnType<typeof createRoute> | null = null;
  let fulfilledRoute: ReturnType<typeof createRoute> | null = null;
  const calls: string[] = [];
  const fakeLocator = {
    first() {
      return this;
    },
    async count() {
      return 1;
    },
    async click() {
      fallbackRoute = createRoute("https://example.com/asset.js", { method: "GET" });
      await routeHandler?.(fallbackRoute);
      const route = createRoute("https://example.com/api/mock", { method: "GET" });
      fulfilledRoute = route;
      await routeHandler?.(route);
    },
  };
  const page = {
    async route(pattern: string, handler: (route: ReturnType<typeof createRoute>) => void | Promise<void>) {
      calls.push(`route:${pattern}`);
      routeHandler = handler;
    },
    async unroute(pattern: string, handler?: unknown) {
      calls.push(handler ? `unroute:${pattern}:handler` : `unroute:${pattern}`);
    },
    locator() {
      return fakeLocator;
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      return undefined;
    },
    url() {
      return "https://example.com/start";
    },
    async title() {
      return "Start";
    },
  } as unknown as Page;
  const fakeContext = {
    pages() {
      return [page];
    },
    async newPage() {
      return page;
    },
    async close() {
      return undefined;
    },
  } as unknown as BrowserContext;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
    createEphemeralContext: async () => fakeContext,
    captureSnapshot: async () => ({
      requestedUrl: "https://example.com/start",
      finalUrl: "https://example.com/start",
      title: "Start",
      textExcerpt: "Start page",
      statusCode: 200,
      interactives: [],
    }),
  });

  const result = await manager.spawnSession({
    taskId: "task-network-mock",
    threadId: "thread-network-mock",
    instructions: "Mock API response",
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
      { kind: "click", selectors: ["button.submit"] },
    ],
  });

  assert.deepEqual(calls, ["route:**/*", "unroute:**/*:handler"]);
  const unmatchedRoute = fallbackRoute as ReturnType<typeof createRoute> | null;
  if (!unmatchedRoute) {
    throw new Error("expected unmatched mock route to fall back");
  }
  assert.deepEqual(unmatchedRoute.events, ["fallback"]);
  const route = fulfilledRoute as ReturnType<typeof createRoute> | null;
  if (!route) {
    throw new Error("expected mock route to be fulfilled");
  }
  assert.deepEqual(route.events, ["fulfill"]);
  assert.deepEqual(route.fulfilled, {
    status: 202,
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
  });
  assert.deepEqual(result.trace[0]?.output, {
    action: "mockResponse",
    matched: true,
    timeoutMs: 1_000,
    url: "https://example.com/api/mock",
    method: "GET",
    status: 202,
    headerCount: 1,
    bodyBytes: 11,
  });
  assert.equal(result.trace[1]?.kind, "click");
});

test("chrome session manager applies and clears network URL blocks", async () => {
  let routeHandler: unknown = null;
  const calls: string[] = [];
  const page = {
    async unroute(pattern: string) {
      calls.push(`unroute:${pattern}`);
    },
    async route(pattern: string, handler: (route: unknown) => void) {
      calls.push(`route:${pattern}`);
      routeHandler = handler;
    },
    async setExtraHTTPHeaders(headers: Record<string, string>) {
      calls.push(`headers:${JSON.stringify(headers)}`);
    },
  } as unknown as Page;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
  });
  const internal = manager as unknown as {
    executeAction(input: {
      page: Page;
      action:
        | { kind: "network"; action: "blockUrls"; urlPatterns: string[] }
        | { kind: "network"; action: "clearBlockedUrls" }
        | { kind: "network"; action: "setExtraHeaders"; headers: Record<string, string> }
        | { kind: "network"; action: "clearExtraHeaders" }
        | { kind: "network"; action: "clearMockResponses" };
      stepIndex: number;
      sessionDir: string;
      requestedUrl: string;
      lastStatusCode: number;
      knownRefs: Map<string, unknown>;
      browserSessionId: string;
    }): Promise<{ traceOutput?: Record<string, unknown> }>;
  };

  const blockOutput = await internal.executeAction({
    page,
    action: { kind: "network", action: "blockUrls", urlPatterns: ["*://*/analytics/*"] },
    stepIndex: 1,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-network",
  });

  assert.deepEqual(blockOutput.traceOutput, {
    action: "blockUrls",
    urlPatternCount: 1,
    blocked: true,
  });
  assert.deepEqual(calls, ["route:**/*"]);
  assert.notEqual(routeHandler, null);
  const handleRoute = routeHandler as (route: unknown) => void;

  const blockedRoute = createRoute("https://example.com/analytics/pixel");
  handleRoute(blockedRoute);
  assert.deepEqual(blockedRoute.events, ["abort"]);
  const allowedRoute = createRoute("https://example.com/app");
  handleRoute(allowedRoute);
  assert.deepEqual(allowedRoute.events, ["continue"]);

  const clearOutput = await internal.executeAction({
    page,
    action: { kind: "network", action: "clearBlockedUrls" },
    stepIndex: 2,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-network",
  });

  assert.deepEqual(clearOutput.traceOutput, {
    action: "clearBlockedUrls",
    cleared: true,
  });
  assert.deepEqual(calls, ["route:**/*", "unroute:**/*"]);

  const setHeadersOutput = await internal.executeAction({
    page,
    action: { kind: "network", action: "setExtraHeaders", headers: { "x-test": "1" } },
    stepIndex: 3,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-network",
  });
  assert.deepEqual(setHeadersOutput.traceOutput, {
    action: "setExtraHeaders",
    headerCount: 1,
    set: true,
  });

  const clearHeadersOutput = await internal.executeAction({
    page,
    action: { kind: "network", action: "clearExtraHeaders" },
    stepIndex: 4,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-network",
  });
  assert.deepEqual(clearHeadersOutput.traceOutput, {
    action: "clearExtraHeaders",
    cleared: true,
  });
  const clearMocksOutput = await internal.executeAction({
    page,
    action: { kind: "network", action: "clearMockResponses" },
    stepIndex: 5,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-network",
  });
  assert.deepEqual(clearMocksOutput.traceOutput, {
    action: "clearMockResponses",
    cleared: true,
  });
  assert.deepEqual(calls, [
    "route:**/*",
    "unroute:**/*",
    'headers:{"x-test":"1"}',
    "headers:{}",
  ]);
});

test("chrome session manager persists downloaded files as bounded artifacts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "chrome-session-manager-download-"));

  try {
    const artifactRecords: Array<Record<string, unknown>> = [];
    let downloadPredicate: ((download: unknown) => boolean) | null = null;
    let resolveDownload: ((download: unknown) => void) | null = null;
    let savedPath = "";
    const fakeDownload = {
      url() {
        return "https://example.com/export.csv";
      },
      suggestedFilename() {
        return "export.csv";
      },
      async saveAs(filePath: string) {
        savedPath = filePath;
        await writeFile(filePath, "id,name\n1,Ada\n", "utf8");
      },
      async failure() {
        return null;
      },
    };
    const fakeLocator = {
      first() {
        return this;
      },
      async count() {
        return 1;
      },
      async click() {
        if (downloadPredicate?.(fakeDownload)) {
          resolveDownload?.(fakeDownload);
        }
      },
    };
    const page = {
      waitForEvent(eventName: string, options: { predicate?: (download: unknown) => boolean }) {
        assert.equal(eventName, "download");
        downloadPredicate = options.predicate ?? (() => true);
        return new Promise((resolve) => {
          resolveDownload = resolve;
        });
      },
      locator() {
        return fakeLocator;
      },
      async waitForLoadState() {
        return undefined;
      },
      async waitForTimeout() {
        return undefined;
      },
      url() {
        return "https://example.com/report";
      },
      async title() {
        return "Report";
      },
    } as unknown as Page;
    const fakeContext = {
      pages() {
        return [page];
      },
      async newPage() {
        return page;
      },
      async close() {
        return undefined;
      },
    } as unknown as BrowserContext;
    const manager = new ChromeSessionManager({
      artifactRootDir: path.join(tempDir, "artifacts"),
      createEphemeralContext: async () => fakeContext,
      browserArtifactStore: {
        async put(record: Record<string, unknown>) {
          artifactRecords.push(record);
        },
      } as never,
      captureSnapshot: async () => ({
        requestedUrl: "https://example.com/report",
        finalUrl: "https://example.com/report",
        title: "Report",
        textExcerpt: "Report page",
        statusCode: 200,
        interactives: [],
      }),
    });

    const result = await manager.spawnSession({
      taskId: "task-download",
      threadId: "thread-download",
      instructions: "Download report",
      actions: [
        { kind: "download", urlPattern: "/export.csv", timeoutMs: 1_000 },
        { kind: "click", selectors: ["a.download"] },
      ],
    });

    assert.equal(result.trace[0]?.kind, "download");
    assert.equal(result.trace[0]?.status, "ok");
    assert.equal(result.trace[0]?.output?.fileName, "export.csv");
    assert.equal(result.trace[0]?.output?.sizeBytes, 14);
    assert.equal(result.trace[0]?.output?.path, undefined);
    assert.equal(result.artifactIds.length, 1);
    assert.equal(artifactRecords[0]?.type, "downloaded-file");
    assert.equal(artifactRecords[0]?.path, savedPath);
    assert.match(savedPath, /downloads\/task-download-browser-step-1-export\.csv$/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("chrome session manager executes bounded storage actions", async () => {
  const evaluateInputs: unknown[] = [];
  const fakePage = {
    async evaluate(_fn: unknown, input: unknown) {
      evaluateInputs.push(input);
      return {
        area: "localStorage",
        action: "get",
        key: "token",
        found: true,
        value: "abc",
        valueBytes: 3,
        valueTruncated: false,
        entryCount: 1,
      };
    },
  } as unknown as Page;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
  });
  const internal = manager as unknown as {
    executeAction(input: {
      page: Page;
      action: { kind: "storage"; area: "localStorage"; action: "get"; key: string };
      stepIndex: number;
      sessionDir: string;
      requestedUrl: string;
      lastStatusCode: number;
      knownRefs: Map<string, unknown>;
      browserSessionId: string;
    }): Promise<{ traceOutput?: Record<string, unknown> }>;
  };

  const output = await internal.executeAction({
    page: fakePage,
    action: { kind: "storage", area: "localStorage", action: "get", key: "token" },
    stepIndex: 1,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-storage",
  });

  assert.deepEqual(evaluateInputs, [
    {
      area: "localStorage",
      action: "get",
      key: "token",
      value: undefined,
      maxEntries: 100,
      maxValueBytes: 8192,
    },
  ]);
  assert.equal(output.traceOutput?.value, "abc");
});

test("chrome session manager uploads files only from matching browser artifacts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "chrome-session-manager-upload-"));

  try {
    const artifactRootDir = path.join(tempDir, "artifacts");
    const uploadPath = path.join(artifactRootDir, "browser-session-upload", "upload.txt");
    await mkdir(path.dirname(uploadPath), { recursive: true });
    await writeFile(uploadPath, "hello upload", "utf8");

    let uploadedPath = "";
    const fakeLocator = {
      first() {
        return this;
      },
      async count() {
        return 1;
      },
      async setInputFiles(filePath: string) {
        uploadedPath = filePath;
      },
    };
    const fakePage = {
      locator(selector: string) {
        assert.equal(selector, "input[type=file]");
        return fakeLocator;
      },
      async waitForLoadState() {
        return undefined;
      },
      async waitForTimeout() {
        return undefined;
      },
      url() {
        return "https://example.com/form";
      },
    } as unknown as Page;
    const manager = new ChromeSessionManager({
      artifactRootDir,
      browserArtifactStore: {
        async get(artifactId: string) {
          assert.equal(artifactId, "artifact-upload");
          return {
            artifactId,
            browserSessionId: "browser-session-upload",
            type: "upload-file",
            path: uploadPath,
            createdAt: 1,
            metadata: {
              fileName: "upload.txt",
              mimeType: "text/plain",
            },
          };
        },
      } as never,
    });
    const internal = manager as unknown as {
      executeAction(input: {
        page: Page;
        action: { kind: "upload"; selectors: string[]; artifactId: string };
        stepIndex: number;
        sessionDir: string;
        requestedUrl: string;
        lastStatusCode: number;
        knownRefs: Map<string, unknown>;
        browserSessionId: string;
      }): Promise<{ traceOutput?: Record<string, unknown> }>;
    };

    const output = await internal.executeAction({
      page: fakePage,
      action: { kind: "upload", selectors: ["input[type=file]"], artifactId: "artifact-upload" },
      stepIndex: 1,
      sessionDir: artifactRootDir,
      requestedUrl: "https://example.com/form",
      lastStatusCode: 200,
      knownRefs: new Map(),
      browserSessionId: "browser-session-upload",
    });

    assert.equal(uploadedPath, uploadPath);
    assert.deepEqual(output.traceOutput, {
      selectors: ["input[type=file]"],
      refId: null,
      text: null,
      artifactId: "artifact-upload",
      fileName: "upload.txt",
      sizeBytes: 12,
      finalUrl: "https://example.com/form",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("chrome session manager executes bounded cookie actions through target CDP", async () => {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let detached = 0;
  const cdpSession = {
    async send(method: string, params?: Record<string, unknown>) {
      commands.push({
        method,
        ...(params !== undefined ? { params } : {}),
      });
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
    async detach() {
      detached += 1;
    },
  };
  const fakePage = {
    url() {
      return "https://example.com/app";
    },
    context() {
      return {
        async newCDPSession(page: Page) {
          assert.equal(page, fakePage);
          return cdpSession;
        },
      };
    },
  } as unknown as Page;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
  });
  const internal = manager as unknown as {
    executeAction(input: {
      page: Page;
      action: { kind: "cookie"; action: "get"; name: string };
      stepIndex: number;
      sessionDir: string;
      requestedUrl: string;
      lastStatusCode: number;
      knownRefs: Map<string, unknown>;
      browserSessionId: string;
    }): Promise<{ traceOutput?: Record<string, unknown> }>;
  };

  const output = await internal.executeAction({
    page: fakePage,
    action: { kind: "cookie", action: "get", name: "sid" },
    stepIndex: 1,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-cookie",
  });

  assert.deepEqual(commands, [
    { method: "Network.enable", params: {} },
    { method: "Network.getCookies", params: { urls: ["https://example.com/app"] } },
  ]);
  assert.equal(detached, 1);
  assert.equal(output.traceOutput?.cookieCount, 1);
  assert.deepEqual((output.traceOutput?.cookies as Array<Record<string, unknown>>)[0], {
    name: "sid",
    domain: "example.com",
    path: "/",
    secure: true,
    httpOnly: true,
    session: false,
    sameSite: "Lax",
    expires: 1_900_000_000,
    value: "abc",
    valueBytes: 3,
    valueTruncated: false,
  });
});

test("chrome session manager executes bounded eval actions through target CDP", async () => {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let detached = 0;
  const cdpSession = {
    async send(method: string, params?: Record<string, unknown>) {
      commands.push({
        method,
        ...(params !== undefined ? { params } : {}),
      });
      return {
        result: {
          type: "string",
          value: "Example",
        },
      };
    },
    async detach() {
      detached += 1;
    },
  };
  const fakePage = {
    context() {
      return {
        async newCDPSession(page: Page) {
          assert.equal(page, fakePage);
          return cdpSession;
        },
      };
    },
  } as unknown as Page;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
  });
  const internal = manager as unknown as {
    executeAction(input: {
      page: Page;
      action: { kind: "eval"; expression: string; awaitPromise?: boolean; timeoutMs?: number };
      stepIndex: number;
      sessionDir: string;
      requestedUrl: string;
      lastStatusCode: number;
      knownRefs: Map<string, unknown>;
      browserSessionId: string;
    }): Promise<{ traceOutput?: Record<string, unknown> }>;
  };

  const output = await internal.executeAction({
    page: fakePage,
    action: { kind: "eval", expression: "document.title", timeoutMs: 1_000 },
    stepIndex: 1,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-eval",
  });

  assert.deepEqual(commands, [
    {
      method: "Runtime.evaluate",
      params: {
        expression: "document.title",
        returnByValue: true,
        awaitPromise: true,
      },
    },
  ]);
  assert.equal(detached, 1);
  assert.deepEqual(output.traceOutput, {
    exception: false,
    timeoutMs: 1_000,
    resultType: "string",
    resultBytes: 9,
    result: "Example",
  });
});

test("chrome session manager executes target-scoped cdp actions through a page CDP session", async () => {
  const commands: unknown[] = [];
  let detached = 0;
  const cdpSession = {
    async send(method: string, params: Record<string, unknown>) {
      commands.push({ method, params });
      return { result: { value: "Example" } };
    },
    async detach() {
      detached += 1;
    },
  };
  const fakePage = {
    context() {
      return {
        async newCDPSession(page: Page) {
          assert.equal(page, fakePage);
          return cdpSession;
        },
      };
    },
  } as unknown as Page;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
  });
  const internal = manager as unknown as {
    executeAction(input: {
      page: Page;
      action: { kind: "cdp"; method: string; params?: Record<string, unknown> };
      stepIndex: number;
      sessionDir: string;
      requestedUrl: string;
      lastStatusCode: number;
      knownRefs: Map<string, unknown>;
      browserSessionId: string;
    }): Promise<{ traceOutput?: Record<string, unknown> }>;
  };

  const output = await internal.executeAction({
    page: fakePage,
    action: {
      kind: "cdp",
      method: "Runtime.evaluate",
      params: {
        expression: "document.title",
        returnByValue: true,
      },
    },
    stepIndex: 1,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-cdp",
  });

  assert.deepEqual(commands, [
    {
      method: "Runtime.evaluate",
      params: {
        expression: "document.title",
        returnByValue: true,
      },
    },
  ]);
  assert.equal(detached, 1);
  assert.equal(output.traceOutput?.method, "Runtime.evaluate");
  assert.deepEqual(output.traceOutput?.result, { result: { value: "Example" } });
});

test("chrome session manager waits for target-scoped cdp events", async () => {
  const listeners = new Map<string, Set<(params?: Record<string, unknown>) => void>>();
  let detached = 0;
  const cdpSession = {
    on(method: string, listener: (params?: Record<string, unknown>) => void) {
      const set = listeners.get(method) ?? new Set();
      set.add(listener);
      listeners.set(method, set);
    },
    off(method: string, listener: (params?: Record<string, unknown>) => void) {
      listeners.get(method)?.delete(listener);
    },
    async send() {
      for (const listener of listeners.get("Runtime.consoleAPICalled") ?? []) {
        listener({ type: "log" });
      }
      return { result: { value: "ok" } };
    },
    async detach() {
      detached += 1;
    },
  };
  const fakePage = {
    context() {
      return {
        async newCDPSession(page: Page) {
          assert.equal(page, fakePage);
          return cdpSession;
        },
      };
    },
  } as unknown as Page;
  const manager = new ChromeSessionManager({
    artifactRootDir: ".daemon-data/test-browser-artifacts",
  });
  const internal = manager as unknown as {
    executeAction(input: {
      page: Page;
      action: {
        kind: "cdp";
        method: string;
        params?: Record<string, unknown>;
        events?: {
          waitFor?: string;
          timeoutMs?: number;
          maxEvents?: number;
        };
      };
      stepIndex: number;
      sessionDir: string;
      requestedUrl: string;
      lastStatusCode: number;
      knownRefs: Map<string, unknown>;
      browserSessionId: string;
    }): Promise<{ traceOutput?: Record<string, unknown> }>;
  };

  const output = await internal.executeAction({
    page: fakePage,
    action: {
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
    stepIndex: 1,
    sessionDir: ".daemon-data/test-browser-artifacts",
    requestedUrl: "https://example.com",
    lastStatusCode: 200,
    knownRefs: new Map(),
    browserSessionId: "browser-session-cdp",
  });

  assert.equal(detached, 1);
  const events = output.traceOutput?.events as Array<Record<string, unknown>>;
  assert.deepEqual(events, [
    {
      method: "Runtime.consoleAPICalled",
      timestamp: events[0]?.timestamp,
      paramsBytes: 14,
      params: { type: "log" },
    },
  ]);
});

function createRoute(url: string, input?: { method?: string }): {
  events: string[];
  fulfilled?: Record<string, unknown>;
  request(): { url(): string; method(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
  fallback(): Promise<void>;
  fulfill(options: Record<string, unknown>): Promise<void>;
} {
  const events: string[] = [];
  const route: {
    events: string[];
    fulfilled?: Record<string, unknown>;
    request(): { url(): string; method(): string };
    abort(): Promise<void>;
    continue(): Promise<void>;
    fallback(): Promise<void>;
    fulfill(options: Record<string, unknown>): Promise<void>;
  } = {
    events,
    request() {
      return {
        url() {
          return url;
        },
        method() {
          return input?.method ?? "GET";
        },
      };
    },
    async abort() {
      events.push("abort");
    },
    async continue() {
      events.push("continue");
    },
    async fallback() {
      events.push("fallback");
    },
    async fulfill(options: Record<string, unknown>) {
      events.push("fulfill");
      route.fulfilled = options;
    },
  };
  return route;
}
