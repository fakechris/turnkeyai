import assert from "node:assert/strict";
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
