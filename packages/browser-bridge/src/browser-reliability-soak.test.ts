import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { BrowserContext, Page } from "playwright-core";

import { ChromeSessionManager } from "./chrome-session-manager";
import { BrowserSessionManager } from "./session/browser-session-manager";
import { FileBrowserProfileStore } from "./session/file-browser-profile-store";
import { FileBrowserSessionHistoryStore } from "./session/file-browser-session-history-store";
import { FileBrowserSessionStore } from "./session/file-browser-session-store";
import { FileBrowserTargetStore } from "./session/file-browser-target-store";

test("browser reliability soak preserves target continuity across detach, reopen, and eviction", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-reliability-soak-"));

  try {
    let nowTick = 1_000;
    let idTick = 0;
    const livePages: Array<Page & { __url: string; __title: string; __closed: boolean }> = [];

    const createPage = (initialUrl = "about:blank", initialTitle = "Blank") => {
      const page = {
        __url: initialUrl,
        __title: initialTitle,
        __closed: false,
        url() {
          return page.__url;
        },
        async title() {
          return page.__title;
        },
        async goto(url: string) {
          page.__url = url;
          page.__title = url.includes("pricing") ? "Pricing" : "Example";
          return { status: () => 200 };
        },
        async waitForLoadState() {
          return undefined;
        },
        async waitForTimeout() {
          return undefined;
        },
        async screenshot() {
          return undefined;
        },
        async close() {
          page.__closed = true;
        },
      } as unknown as Page & { __url: string; __title: string; __closed: boolean };
      livePages.push(page);
      return page;
    };

    const fakeContext = {
      on() {
        return this;
      },
      pages() {
        return livePages.filter((item) => !item.__closed);
      },
      async newPage() {
        return createPage();
      },
      async close() {
        for (const page of livePages) {
          page.__closed = true;
        }
      },
    } as unknown as BrowserContext;

    const browserSessionManager = new BrowserSessionManager({
      browserProfileStore: new FileBrowserProfileStore({
        rootDir: path.join(tempDir, "profiles"),
      }),
      browserSessionStore: new FileBrowserSessionStore({
        rootDir: path.join(tempDir, "sessions"),
      }),
      browserTargetStore: new FileBrowserTargetStore({
        rootDir: path.join(tempDir, "targets"),
      }),
      profileRootDir: path.join(tempDir, "profiles"),
      now: () => nowTick,
      createId: (prefix) => `${prefix}-${++idTick}`,
    });
    const historyStore = new FileBrowserSessionHistoryStore({
      rootDir: path.join(tempDir, "history"),
    });
    const manager = new ChromeSessionManager({
      artifactRootDir: path.join(tempDir, "artifacts"),
      browserSessionManager,
      browserSessionHistoryStore: historyStore,
      createId: (prefix) => `${prefix}-${++idTick}`,
      launchPersistentContext: async () => fakeContext,
      createEphemeralContext: async () => fakeContext,
      captureSnapshot: async ({ page, requestedUrl }) => ({
        requestedUrl,
        finalUrl: page.url() || requestedUrl,
        title: (await page.title()) || "",
        textExcerpt: (await page.title()) || "",
        statusCode: 200,
        interactives: [],
      }),
    });

    const spawned = await manager.spawnSession({
      taskId: "task-soak-1",
      threadId: "thread-soak",
      instructions: "Open the example home page",
      actions: [
        { kind: "open", url: "https://example.com/" },
        { kind: "snapshot", note: "home" },
      ],
      ownerType: "thread",
      ownerId: "thread-soak",
      profileOwnerType: "thread",
      profileOwnerId: "thread-soak",
      leaseHolderRunKey: "worker:browser:soak-a",
      leaseTtlMs: 10,
    });
    assert.equal(spawned.dispatchMode, "spawn");
    assert.ok(spawned.targetId);

    const secondTarget = await manager.openTarget(spawned.sessionId, "https://example.com/pricing", {
      ownerType: "thread",
      ownerId: "thread-soak",
    });
    await manager.activateTarget(spawned.sessionId, secondTarget.targetId, {
      ownerType: "thread",
      ownerId: "thread-soak",
    });

    const sent = await manager.sendSession({
      taskId: "task-soak-2",
      threadId: "thread-soak",
      instructions: "Snapshot the pricing target",
      actions: [{ kind: "snapshot", note: "pricing" }],
      browserSessionId: spawned.sessionId,
      targetId: secondTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-soak",
      leaseHolderRunKey: "worker:browser:soak-a",
      leaseTtlMs: 10,
    });
    assert.equal(sent.dispatchMode, "send");
    assert.equal(sent.targetId, secondTarget.targetId);

    const detachedPage = fakeContext
      .pages()
      .find((page) => page.url() === "https://example.com/pricing") as (Page & {
      __closed?: boolean;
    }) | undefined;
    if (detachedPage) {
      detachedPage.__closed = true;
    }
    await browserSessionManager.markTargetDetached(spawned.sessionId, secondTarget.targetId);

    nowTick += 20;

    const resumed = await manager.resumeSession({
      taskId: "task-soak-3",
      threadId: "thread-soak",
      instructions: "Resume the detached pricing target",
      actions: [{ kind: "snapshot", note: "resume" }],
      browserSessionId: spawned.sessionId,
      targetId: secondTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-soak",
      leaseHolderRunKey: "worker:browser:soak-b",
    });
    assert.equal(resumed.dispatchMode, "resume");
    assert.equal(resumed.resumeMode, "cold");
    assert.equal(resumed.targetResolution, "reopen");
    assert.equal(resumed.targetId, secondTarget.targetId);
    assert.equal(resumed.page.finalUrl, "https://example.com/pricing");

    const attachedAfterReopen = await manager.sendSession({
      taskId: "task-soak-3b",
      threadId: "thread-soak",
      instructions: "Re-attach after reopen and snapshot again",
      actions: [{ kind: "snapshot", note: "post-reopen-attach" }],
      browserSessionId: spawned.sessionId,
      targetId: secondTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-soak",
      leaseHolderRunKey: "worker:browser:soak-b",
      leaseTtlMs: 10,
    });
    assert.equal(attachedAfterReopen.dispatchMode, "send");
    assert.equal(attachedAfterReopen.resumeMode, "hot");
    assert.equal(attachedAfterReopen.targetResolution, "attach");

    const history = await manager.getSessionHistory({ browserSessionId: spawned.sessionId });
    assert.deepEqual(
      history.map((entry) => entry.dispatchMode),
      ["spawn", "send", "resume", "send"]
    );

    const evicted = await manager.evictIdleSessions({
      idleBefore: nowTick + 100,
      reason: "soak complete",
    });
    assert.equal(evicted.length, 1);
    assert.equal(evicted[0]?.browserSessionId, spawned.sessionId);

    await assert.rejects(
      () =>
        manager.resumeSession({
          taskId: "task-soak-4",
          threadId: "thread-soak",
          instructions: "Resume after eviction",
          actions: [{ kind: "snapshot", note: "after-eviction" }],
          browserSessionId: spawned.sessionId,
          ownerType: "thread",
          ownerId: "thread-soak",
          leaseHolderRunKey: "worker:browser:soak-c",
        }),
      /browser session not found/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser reliability soak marks the session disconnected when every target is detached and reopens cold on resume", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-reliability-detached-all-soak-"));

  try {
    let nowTick = 2_000;
    let idTick = 0;
    const livePages: Array<Page & { __url: string; __title: string; __closed: boolean }> = [];

    const createPage = (initialUrl = "about:blank", initialTitle = "Blank") => {
      const page = {
        __url: initialUrl,
        __title: initialTitle,
        __closed: false,
        url() {
          return page.__url;
        },
        async title() {
          return page.__title;
        },
        async goto(url: string) {
          page.__url = url;
          page.__title = url.includes("pricing") ? "Pricing" : "Example";
          return { status: () => 200 };
        },
        async waitForLoadState() {
          return undefined;
        },
        async waitForTimeout() {
          return undefined;
        },
        async screenshot() {
          return undefined;
        },
        async close() {
          page.__closed = true;
        },
      } as unknown as Page & { __url: string; __title: string; __closed: boolean };
      livePages.push(page);
      return page;
    };

    const fakeContext = {
      on() {
        return this;
      },
      pages() {
        return livePages.filter((item) => !item.__closed);
      },
      async newPage() {
        return createPage();
      },
      async close() {
        for (const page of livePages) {
          page.__closed = true;
        }
      },
    } as unknown as BrowserContext;

    const sessionStore = new FileBrowserSessionStore({
      rootDir: path.join(tempDir, "sessions"),
    });
    const browserSessionManager = new BrowserSessionManager({
      browserProfileStore: new FileBrowserProfileStore({
        rootDir: path.join(tempDir, "profiles"),
      }),
      browserSessionStore: sessionStore,
      browserTargetStore: new FileBrowserTargetStore({
        rootDir: path.join(tempDir, "targets"),
      }),
      profileRootDir: path.join(tempDir, "profiles"),
      now: () => ++nowTick,
      createId: (prefix) => `${prefix}-${++idTick}`,
    });
    const historyStore = new FileBrowserSessionHistoryStore({
      rootDir: path.join(tempDir, "history"),
    });
    const manager = new ChromeSessionManager({
      artifactRootDir: path.join(tempDir, "artifacts"),
      browserSessionManager,
      browserSessionHistoryStore: historyStore,
      createId: (prefix) => `${prefix}-${++idTick}`,
      launchPersistentContext: async () => fakeContext,
      createEphemeralContext: async () => fakeContext,
      captureSnapshot: async ({ page, requestedUrl }) => ({
        requestedUrl,
        finalUrl: page.url() || requestedUrl,
        title: (await page.title()) || "",
        textExcerpt: (await page.title()) || "",
        statusCode: 200,
        interactives: [],
      }),
    });

    const spawned = await manager.spawnSession({
      taskId: "task-detached-all-1",
      threadId: "thread-detached-all",
      instructions: "Open the home page",
      actions: [
        { kind: "open", url: "https://example.com/" },
        { kind: "snapshot", note: "home" },
      ],
      ownerType: "thread",
      ownerId: "thread-detached-all",
      profileOwnerType: "thread",
      profileOwnerId: "thread-detached-all",
      leaseHolderRunKey: "worker:browser:detached-all-a",
      leaseTtlMs: 10,
    });
    assert.ok(spawned.targetId);

    const spawnedPage = fakeContext.pages()[0] as (Page & {
      __closed?: boolean;
    }) | undefined;
    if (spawnedPage) {
      spawnedPage.__closed = true;
    }
    await browserSessionManager.markTargetDetached(spawned.sessionId, spawned.targetId!);

    const disconnectedSession = await sessionStore.get(spawned.sessionId);
    assert.equal(disconnectedSession?.status, "disconnected");
    assert.equal(disconnectedSession?.activeTargetId, undefined);

    const resumed = await manager.resumeSession({
      taskId: "task-detached-all-2",
      threadId: "thread-detached-all",
      instructions: "Reopen the detached target",
      actions: [{ kind: "snapshot", note: "resume" }],
      browserSessionId: spawned.sessionId,
      targetId: spawned.targetId,
      ownerType: "thread",
      ownerId: "thread-detached-all",
      leaseHolderRunKey: "worker:browser:detached-all-a",
      leaseTtlMs: 10,
    });
    assert.equal(resumed.resumeMode, "cold");
    assert.equal(resumed.targetResolution, "reopen");
    assert.equal(resumed.targetId, spawned.targetId);
    assert.equal(resumed.page.finalUrl, "https://example.com/");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser reliability soak handles lease reclaim, wrong-owner denial, and hot target attach", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-reliability-lease-soak-"));

  try {
    let nowTick = 5_000;
    let idTick = 0;
    const livePages: Array<Page & { __url: string; __title: string; __closed: boolean }> = [];

    const createPage = (initialUrl = "about:blank", initialTitle = "Blank") => {
      const page = {
        __url: initialUrl,
        __title: initialTitle,
        __closed: false,
        url() {
          return page.__url;
        },
        async title() {
          return page.__title;
        },
        async goto(url: string) {
          page.__url = url;
          page.__title = url.includes("pricing") ? "Pricing" : "Example";
          return { status: () => 200 };
        },
        async waitForLoadState() {
          return undefined;
        },
        async waitForTimeout() {
          return undefined;
        },
        async screenshot() {
          return undefined;
        },
        async close() {
          page.__closed = true;
        },
      } as unknown as Page & { __url: string; __title: string; __closed: boolean };
      livePages.push(page);
      return page;
    };

    const fakeContext = {
      on() {
        return this;
      },
      pages() {
        return livePages.filter((item) => !item.__closed);
      },
      async newPage() {
        return createPage();
      },
      async close() {
        for (const page of livePages) {
          page.__closed = true;
        }
      },
    } as unknown as BrowserContext;

    const browserSessionManager = new BrowserSessionManager({
      browserProfileStore: new FileBrowserProfileStore({
        rootDir: path.join(tempDir, "profiles"),
      }),
      browserSessionStore: new FileBrowserSessionStore({
        rootDir: path.join(tempDir, "sessions"),
      }),
      browserTargetStore: new FileBrowserTargetStore({
        rootDir: path.join(tempDir, "targets"),
      }),
      profileRootDir: path.join(tempDir, "profiles"),
      now: () => ++nowTick,
      createId: (prefix) => `${prefix}-${++idTick}`,
    });
    const historyStore = new FileBrowserSessionHistoryStore({
      rootDir: path.join(tempDir, "history"),
    });
    const manager = new ChromeSessionManager({
      artifactRootDir: path.join(tempDir, "artifacts"),
      browserSessionManager,
      browserSessionHistoryStore: historyStore,
      createId: (prefix) => `${prefix}-${++idTick}`,
      launchPersistentContext: async () => fakeContext,
      createEphemeralContext: async () => fakeContext,
      captureSnapshot: async ({ page, requestedUrl }) => ({
        requestedUrl,
        finalUrl: page.url() || requestedUrl,
        title: (await page.title()) || "",
        textExcerpt: (await page.title()) || "",
        statusCode: 200,
        interactives: [],
      }),
    });

    const spawned = await manager.spawnSession({
      taskId: "task-matrix-1",
      threadId: "thread-matrix",
      instructions: "Open the home page",
      actions: [
        { kind: "open", url: "https://example.com/" },
        { kind: "snapshot", note: "home" },
      ],
      ownerType: "thread",
      ownerId: "thread-matrix",
      profileOwnerType: "thread",
      profileOwnerId: "thread-matrix",
      leaseHolderRunKey: "worker:browser:matrix-a",
      leaseTtlMs: 5,
    });
    const pricingTarget = await manager.openTarget(spawned.sessionId, "https://example.com/pricing", {
      ownerType: "thread",
      ownerId: "thread-matrix",
    });
    await manager.activateTarget(spawned.sessionId, pricingTarget.targetId, {
      ownerType: "thread",
      ownerId: "thread-matrix",
    });

    nowTick += 20;
    const reclaimed = await manager.resumeSession({
      taskId: "task-matrix-2",
      threadId: "thread-matrix",
      instructions: "Reclaim the pricing target",
      actions: [{ kind: "snapshot", note: "reclaimed" }],
      browserSessionId: spawned.sessionId,
      targetId: pricingTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-matrix",
      leaseHolderRunKey: "worker:browser:matrix-b",
    });
    assert.equal(reclaimed.resumeMode, "hot");
    assert.equal(reclaimed.targetResolution, "attach");

    await assert.rejects(
      () =>
        manager.resumeSession({
          taskId: "task-matrix-3",
          threadId: "thread-matrix",
          instructions: "Wrong owner should fail",
          actions: [{ kind: "snapshot", note: "wrong-owner" }],
          browserSessionId: spawned.sessionId,
          targetId: pricingTarget.targetId,
          ownerType: "worker",
          ownerId: "other-owner",
          leaseHolderRunKey: "worker:browser:matrix-c",
        }),
      /browser session owner mismatch/
    );

    const pricingPage = fakeContext
      .pages()
      .find((page) => page.url() === "https://example.com/pricing") as (Page & {
      __closed?: boolean;
    }) | undefined;
    if (pricingPage) {
      pricingPage.__closed = true;
    }
    await browserSessionManager.markTargetDetached(spawned.sessionId, pricingTarget.targetId);

    const reopened = await manager.resumeSession({
      taskId: "task-matrix-4",
      threadId: "thread-matrix",
      instructions: "Reopen the detached target",
      actions: [{ kind: "open", url: "https://example.com/pricing" }],
      browserSessionId: spawned.sessionId,
      targetId: pricingTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-matrix",
      leaseHolderRunKey: "worker:browser:matrix-b",
    });
    assert.equal(reopened.targetResolution, "new_target");
    assert.equal(reopened.page.finalUrl, "https://example.com/pricing");
    assert.ok(reopened.targetId);

    const hotAttach = await manager.sendSession({
      taskId: "task-matrix-5",
      threadId: "thread-matrix",
      instructions: "Hot attach to the reopened pricing target",
      actions: [{ kind: "snapshot", note: "hot-attach" }],
      browserSessionId: spawned.sessionId,
      targetId: reopened.targetId,
      ownerType: "thread",
      ownerId: "thread-matrix",
      leaseHolderRunKey: "worker:browser:matrix-b",
    });
    assert.equal(hotAttach.resumeMode, "hot");
    assert.equal(hotAttach.targetResolution, "attach");

    const history = await manager.getSessionHistory({ browserSessionId: spawned.sessionId });
    assert.deepEqual(
      history.map((entry) => `${entry.dispatchMode}:${entry.targetResolution ?? "none"}`),
      ["spawn:new_target", "resume:attach", "resume:new_target", "send:attach"]
    );
    assert.deepEqual(
      history.map((entry) => entry.resumeMode ?? "none"),
      ["cold", "hot", "cold", "hot"]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser reliability soak preserves multi-target continuity after one target is reopened", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-reliability-multi-target-soak-"));

  try {
    let nowTick = 8_000;
    let idTick = 0;
    const livePages: Array<Page & { __url: string; __title: string; __closed: boolean }> = [];

    const createPage = (initialUrl = "about:blank", initialTitle = "Blank") => {
      const page = {
        __url: initialUrl,
        __title: initialTitle,
        __closed: false,
        url() {
          return page.__url;
        },
        async title() {
          return page.__title;
        },
        async goto(url: string) {
          page.__url = url;
          page.__title = url.includes("pricing") ? "Pricing" : url.includes("faq") ? "FAQ" : "Example";
          return { status: () => 200 };
        },
        async waitForLoadState() {
          return undefined;
        },
        async waitForTimeout() {
          return undefined;
        },
        async screenshot() {
          return undefined;
        },
        async close() {
          page.__closed = true;
        },
      } as unknown as Page & { __url: string; __title: string; __closed: boolean };
      livePages.push(page);
      return page;
    };

    const fakeContext = {
      on() {
        return this;
      },
      pages() {
        return livePages.filter((item) => !item.__closed);
      },
      async newPage() {
        return createPage();
      },
      async close() {
        for (const page of livePages) {
          page.__closed = true;
        }
      },
    } as unknown as BrowserContext;

    const browserSessionManager = new BrowserSessionManager({
      browserProfileStore: new FileBrowserProfileStore({
        rootDir: path.join(tempDir, "profiles"),
      }),
      browserSessionStore: new FileBrowserSessionStore({
        rootDir: path.join(tempDir, "sessions"),
      }),
      browserTargetStore: new FileBrowserTargetStore({
        rootDir: path.join(tempDir, "targets"),
      }),
      profileRootDir: path.join(tempDir, "profiles"),
      now: () => ++nowTick,
      createId: (prefix) => `${prefix}-${++idTick}`,
    });
    const historyStore = new FileBrowserSessionHistoryStore({
      rootDir: path.join(tempDir, "history"),
    });
    const manager = new ChromeSessionManager({
      artifactRootDir: path.join(tempDir, "artifacts"),
      browserSessionManager,
      browserSessionHistoryStore: historyStore,
      createId: (prefix) => `${prefix}-${++idTick}`,
      launchPersistentContext: async () => fakeContext,
      createEphemeralContext: async () => fakeContext,
      captureSnapshot: async ({ page, requestedUrl }) => ({
        requestedUrl,
        finalUrl: page.url() || requestedUrl,
        title: (await page.title()) || "",
        textExcerpt: (await page.title()) || "",
        statusCode: 200,
        interactives: [],
      }),
    });

    const spawned = await manager.spawnSession({
      taskId: "task-multi-1",
      threadId: "thread-multi",
      instructions: "Open the home page",
      actions: [
        { kind: "open", url: "https://example.com/" },
        { kind: "snapshot", note: "home" },
      ],
      ownerType: "thread",
      ownerId: "thread-multi",
      profileOwnerType: "thread",
      profileOwnerId: "thread-multi",
      leaseHolderRunKey: "worker:browser:multi-a",
      leaseTtlMs: 5,
    });
    const pricingTarget = await manager.openTarget(spawned.sessionId, "https://example.com/pricing", {
      ownerType: "thread",
      ownerId: "thread-multi",
    });
    const faqTarget = await manager.openTarget(spawned.sessionId, "https://example.com/faq", {
      ownerType: "thread",
      ownerId: "thread-multi",
    });

    const pricingSnapshot = await manager.sendSession({
      taskId: "task-multi-2",
      threadId: "thread-multi",
      instructions: "Snapshot the pricing target",
      actions: [{ kind: "snapshot", note: "pricing" }],
      browserSessionId: spawned.sessionId,
      targetId: pricingTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-multi",
      leaseHolderRunKey: "worker:browser:multi-a",
    });
    assert.equal(pricingSnapshot.targetId, pricingTarget.targetId);

    const faqPage = fakeContext
      .pages()
      .find((page) => page.url() === "https://example.com/faq") as (Page & {
      __closed?: boolean;
    }) | undefined;
    if (faqPage) {
      faqPage.__closed = true;
    }
    await browserSessionManager.markTargetDetached(spawned.sessionId, faqTarget.targetId);

    const reopenedFaq = await manager.resumeSession({
      taskId: "task-multi-3",
      threadId: "thread-multi",
      instructions: "Reopen the detached FAQ target",
      actions: [{ kind: "open", url: "https://example.com/faq" }],
      browserSessionId: spawned.sessionId,
      targetId: faqTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-multi",
      leaseHolderRunKey: "worker:browser:multi-b",
    });
    assert.equal(reopenedFaq.page.finalUrl, "https://example.com/faq");
    assert.ok(reopenedFaq.targetId);

    await manager.activateTarget(spawned.sessionId, pricingTarget.targetId, {
      ownerType: "thread",
      ownerId: "thread-multi",
    });

    const pricingResume = await manager.sendSession({
      taskId: "task-multi-4",
      threadId: "thread-multi",
      instructions: "Return to the original pricing target",
      actions: [{ kind: "snapshot", note: "pricing-return" }],
      browserSessionId: spawned.sessionId,
      targetId: pricingTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-multi",
      leaseHolderRunKey: "worker:browser:multi-b",
    });
    assert.equal(pricingResume.dispatchMode, "send");
    assert.equal(pricingResume.resumeMode, "hot");
    assert.equal(pricingResume.targetResolution, "attach");
    assert.equal(pricingResume.targetId, pricingTarget.targetId);

    const history = await manager.getSessionHistory({ browserSessionId: spawned.sessionId });
    assert.deepEqual(
      history.map((entry) => `${entry.dispatchMode}:${entry.targetId ?? "-"}`),
      [
        `spawn:${spawned.targetId ?? "-"}`,
        `send:${pricingTarget.targetId}`,
        `resume:${faqTarget.targetId}`,
        `send:${pricingTarget.targetId}`,
      ]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser reliability soak reclaims a detached target after lease expiry while preserving another hot target", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-reliability-reclaim-soak-"));

  try {
    let nowTick = 12_000;
    let idTick = 0;
    const livePages: Array<Page & { __url: string; __title: string; __closed: boolean }> = [];

    const createPage = (initialUrl = "about:blank", initialTitle = "Blank") => {
      const page = {
        __url: initialUrl,
        __title: initialTitle,
        __closed: false,
        url() {
          return page.__url;
        },
        async title() {
          return page.__title;
        },
        async goto(url: string) {
          page.__url = url;
          page.__title = url.includes("pricing") ? "Pricing" : url.includes("faq") ? "FAQ" : "Example";
          return { status: () => 200 };
        },
        async waitForLoadState() {
          return undefined;
        },
        async waitForTimeout() {
          return undefined;
        },
        async screenshot() {
          return undefined;
        },
        async close() {
          page.__closed = true;
        },
      } as unknown as Page & { __url: string; __title: string; __closed: boolean };
      livePages.push(page);
      return page;
    };

    const fakeContext = {
      on() {
        return this;
      },
      pages() {
        return livePages.filter((item) => !item.__closed);
      },
      async newPage() {
        return createPage();
      },
      async close() {
        for (const page of livePages) {
          page.__closed = true;
        }
      },
    } as unknown as BrowserContext;

    const browserSessionManager = new BrowserSessionManager({
      browserProfileStore: new FileBrowserProfileStore({
        rootDir: path.join(tempDir, "profiles"),
      }),
      browserSessionStore: new FileBrowserSessionStore({
        rootDir: path.join(tempDir, "sessions"),
      }),
      browserTargetStore: new FileBrowserTargetStore({
        rootDir: path.join(tempDir, "targets"),
      }),
      profileRootDir: path.join(tempDir, "profiles"),
      now: () => ++nowTick,
      createId: (prefix) => `${prefix}-${++idTick}`,
    });
    const historyStore = new FileBrowserSessionHistoryStore({
      rootDir: path.join(tempDir, "history"),
    });
    const manager = new ChromeSessionManager({
      artifactRootDir: path.join(tempDir, "artifacts"),
      browserSessionManager,
      browserSessionHistoryStore: historyStore,
      createId: (prefix) => `${prefix}-${++idTick}`,
      launchPersistentContext: async () => fakeContext,
      createEphemeralContext: async () => fakeContext,
      captureSnapshot: async ({ page, requestedUrl }) => ({
        requestedUrl,
        finalUrl: page.url() || requestedUrl,
        title: (await page.title()) || "",
        textExcerpt: (await page.title()) || "",
        statusCode: 200,
        interactives: [],
      }),
    });

    const spawned = await manager.spawnSession({
      taskId: "task-reclaim-1",
      threadId: "thread-reclaim",
      instructions: "Open the home page",
      actions: [
        { kind: "open", url: "https://example.com/" },
        { kind: "snapshot", note: "home" },
      ],
      ownerType: "thread",
      ownerId: "thread-reclaim",
      profileOwnerType: "thread",
      profileOwnerId: "thread-reclaim",
      leaseHolderRunKey: "worker:browser:reclaim-a",
      leaseTtlMs: 5,
    });

    const pricingTarget = await manager.openTarget(spawned.sessionId, "https://example.com/pricing", {
      ownerType: "thread",
      ownerId: "thread-reclaim",
    });
    const faqTarget = await manager.openTarget(spawned.sessionId, "https://example.com/faq", {
      ownerType: "thread",
      ownerId: "thread-reclaim",
    });

    await manager.sendSession({
      taskId: "task-reclaim-2",
      threadId: "thread-reclaim",
      instructions: "Snapshot the pricing target",
      actions: [{ kind: "snapshot", note: "pricing" }],
      browserSessionId: spawned.sessionId,
      targetId: pricingTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-reclaim",
      leaseHolderRunKey: "worker:browser:reclaim-a",
      leaseTtlMs: 5,
    });

    const pricingPage = fakeContext
      .pages()
      .find((page) => page.url() === "https://example.com/pricing") as (Page & {
      __closed?: boolean;
    }) | undefined;
    if (pricingPage) {
      pricingPage.__closed = true;
    }
    await browserSessionManager.markTargetDetached(spawned.sessionId, pricingTarget.targetId);

    nowTick += 20;

    const reclaimedPricing = await manager.resumeSession({
      taskId: "task-reclaim-3",
      threadId: "thread-reclaim",
      instructions: "Reclaim and reopen the detached pricing target",
      actions: [{ kind: "snapshot", note: "pricing-reopen" }],
      browserSessionId: spawned.sessionId,
      targetId: pricingTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-reclaim",
      leaseHolderRunKey: "worker:browser:reclaim-b",
    });
    assert.equal(reclaimedPricing.dispatchMode, "resume");
    assert.equal(reclaimedPricing.resumeMode, "cold");
    assert.equal(reclaimedPricing.targetResolution, "reopen");
    assert.equal(reclaimedPricing.targetId, pricingTarget.targetId);

    await manager.activateTarget(spawned.sessionId, faqTarget.targetId, {
      ownerType: "thread",
      ownerId: "thread-reclaim",
    });

    const faqAttach = await manager.sendSession({
      taskId: "task-reclaim-4",
      threadId: "thread-reclaim",
      instructions: "Hot attach back to the faq target",
      actions: [{ kind: "snapshot", note: "faq-hot" }],
      browserSessionId: spawned.sessionId,
      targetId: faqTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-reclaim",
      leaseHolderRunKey: "worker:browser:reclaim-b",
      leaseTtlMs: 5,
    });
    assert.equal(faqAttach.dispatchMode, "send");
    assert.equal(faqAttach.resumeMode, "hot");
    assert.equal(faqAttach.targetResolution, "attach");
    assert.equal(faqAttach.targetId, faqTarget.targetId);

    const history = await manager.getSessionHistory({ browserSessionId: spawned.sessionId });
    assert.deepEqual(
      history.map((entry) => `${entry.dispatchMode}:${entry.targetId ?? "-"}:${entry.resumeMode ?? "none"}`),
      [
        `spawn:${spawned.targetId ?? "-"}:cold`,
        `send:${pricingTarget.targetId}:hot`,
        `resume:${pricingTarget.targetId}:cold`,
        `send:${faqTarget.targetId}:hot`,
      ]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser reliability soak preserves hot continuity after a reopened target rejects a wrong owner", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-reliability-owner-reopen-soak-"));

  try {
    let nowTick = 16_000;
    let idTick = 0;
    const livePages: Array<Page & { __url: string; __title: string; __closed: boolean }> = [];

    const createPage = (initialUrl = "about:blank", initialTitle = "Blank") => {
      const page = {
        __url: initialUrl,
        __title: initialTitle,
        __closed: false,
        url() {
          return page.__url;
        },
        async title() {
          return page.__title;
        },
        async goto(url: string) {
          page.__url = url;
          page.__title = url.includes("pricing") ? "Pricing" : url.includes("faq") ? "FAQ" : "Example";
          return { status: () => 200 };
        },
        async waitForLoadState() {
          return undefined;
        },
        async waitForTimeout() {
          return undefined;
        },
        async screenshot() {
          return undefined;
        },
        async close() {
          page.__closed = true;
        },
      } as unknown as Page & { __url: string; __title: string; __closed: boolean };
      livePages.push(page);
      return page;
    };

    const fakeContext = {
      on() {
        return this;
      },
      pages() {
        return livePages.filter((item) => !item.__closed);
      },
      async newPage() {
        return createPage();
      },
      async close() {
        for (const page of livePages) {
          page.__closed = true;
        }
      },
    } as unknown as BrowserContext;

    const browserSessionManager = new BrowserSessionManager({
      browserProfileStore: new FileBrowserProfileStore({
        rootDir: path.join(tempDir, "profiles"),
      }),
      browserSessionStore: new FileBrowserSessionStore({
        rootDir: path.join(tempDir, "sessions"),
      }),
      browserTargetStore: new FileBrowserTargetStore({
        rootDir: path.join(tempDir, "targets"),
      }),
      profileRootDir: path.join(tempDir, "profiles"),
      now: () => ++nowTick,
      createId: (prefix) => `${prefix}-${++idTick}`,
    });
    const historyStore = new FileBrowserSessionHistoryStore({
      rootDir: path.join(tempDir, "history"),
    });
    const manager = new ChromeSessionManager({
      artifactRootDir: path.join(tempDir, "artifacts"),
      browserSessionManager,
      browserSessionHistoryStore: historyStore,
      createId: (prefix) => `${prefix}-${++idTick}`,
      launchPersistentContext: async () => fakeContext,
      createEphemeralContext: async () => fakeContext,
      captureSnapshot: async ({ page, requestedUrl }) => ({
        requestedUrl,
        finalUrl: page.url() || requestedUrl,
        title: (await page.title()) || "",
        textExcerpt: (await page.title()) || "",
        statusCode: 200,
        interactives: [],
      }),
    });

    const spawned = await manager.spawnSession({
      taskId: "task-owner-1",
      threadId: "thread-owner",
      instructions: "Open the home page",
      actions: [
        { kind: "open", url: "https://example.com/" },
        { kind: "snapshot", note: "home" },
      ],
      ownerType: "thread",
      ownerId: "thread-owner",
      profileOwnerType: "thread",
      profileOwnerId: "thread-owner",
      leaseHolderRunKey: "worker:browser:owner-a",
      leaseTtlMs: 5,
    });

    const pricingTarget = await manager.openTarget(spawned.sessionId, "https://example.com/pricing", {
      ownerType: "thread",
      ownerId: "thread-owner",
    });
    const faqTarget = await manager.openTarget(spawned.sessionId, "https://example.com/faq", {
      ownerType: "thread",
      ownerId: "thread-owner",
    });

    const faqAttach = await manager.sendSession({
      taskId: "task-owner-2",
      threadId: "thread-owner",
      instructions: "Snapshot the faq target",
      actions: [{ kind: "snapshot", note: "faq" }],
      browserSessionId: spawned.sessionId,
      targetId: faqTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-owner",
      leaseHolderRunKey: "worker:browser:owner-a",
      leaseTtlMs: 5,
    });
    assert.equal(faqAttach.resumeMode, "hot");
    assert.equal(faqAttach.targetId, faqTarget.targetId);

    const pricingPage = fakeContext
      .pages()
      .find((page) => page.url() === "https://example.com/pricing") as (Page & {
      __closed?: boolean;
    }) | undefined;
    if (pricingPage) {
      pricingPage.__closed = true;
    }
    await browserSessionManager.markTargetDetached(spawned.sessionId, pricingTarget.targetId);

    nowTick += 20;

    const reopenedPricing = await manager.resumeSession({
      taskId: "task-owner-3",
      threadId: "thread-owner",
      instructions: "Reopen the detached pricing target",
      actions: [{ kind: "open", url: "https://example.com/pricing" }],
      browserSessionId: spawned.sessionId,
      targetId: pricingTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-owner",
      leaseHolderRunKey: "worker:browser:owner-b",
    });
    assert.equal(reopenedPricing.targetResolution, "new_target");
    assert.equal(reopenedPricing.resumeMode, "cold");

    await assert.rejects(
      () =>
        manager.sendSession({
          taskId: "task-owner-4",
          threadId: "thread-owner",
          instructions: "Wrong owner should not attach to reopened pricing target",
          actions: [{ kind: "snapshot", note: "wrong-owner" }],
          browserSessionId: spawned.sessionId,
          targetId: pricingTarget.targetId,
          ownerType: "worker",
          ownerId: "other-owner",
          leaseHolderRunKey: "worker:browser:owner-c",
        }),
      /browser session owner mismatch/
    );

    const faqHotAgain = await manager.sendSession({
      taskId: "task-owner-5",
      threadId: "thread-owner",
      instructions: "Return to faq after the wrong-owner denial",
      actions: [{ kind: "snapshot", note: "faq-hot-again" }],
      browserSessionId: spawned.sessionId,
      targetId: faqTarget.targetId,
      ownerType: "thread",
      ownerId: "thread-owner",
      leaseHolderRunKey: "worker:browser:owner-b",
      leaseTtlMs: 5,
    });
    assert.equal(faqHotAgain.dispatchMode, "send");
    assert.equal(faqHotAgain.resumeMode, "hot");
    assert.equal(faqHotAgain.targetResolution, "attach");
    assert.equal(faqHotAgain.targetId, faqTarget.targetId);

    const history = await manager.getSessionHistory({ browserSessionId: spawned.sessionId });
    assert.deepEqual(
      history.map((entry) => `${entry.dispatchMode}:${entry.targetId ?? "-"}:${entry.resumeMode ?? "none"}`),
      [
        `spawn:${spawned.targetId ?? "-"}:cold`,
        `send:${faqTarget.targetId}:hot`,
        `resume:${pricingTarget.targetId}:cold`,
        `send:${faqTarget.targetId}:hot`,
      ]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
