import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { BrowserContext, Page } from "playwright-core";
import type { BrowserSessionHistoryEntry, BrowserSessionHistoryStore } from "@turnkeyai/core-types/team";

import { ChromeSessionManager } from "./chrome-session-manager";
import { BrowserSessionManager } from "./session/browser-session-manager";
import { FileBrowserProfileStore } from "./session/file-browser-profile-store";
import { FileBrowserSessionHistoryStore } from "./session/file-browser-session-history-store";
import { FileBrowserSessionStore } from "./session/file-browser-session-store";
import { FileBrowserTargetStore } from "./session/file-browser-target-store";

test("browser session runtime records spawn/send/resume history for one live session", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-session-runtime-"));

  try {
    let nowTick = 100;
    let idTick = 0;
    let currentUrl = "about:blank";
    const pages: Page[] = [];
    const fakePage = {
      url() {
        return currentUrl;
      },
      async title() {
        return "Example Domain";
      },
      async goto(url: string) {
        currentUrl = url;
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
    } as unknown as Page;
    const fakeContext = {
      on() {
        return this;
      },
      pages() {
        return pages;
      },
      async newPage() {
        if (!pages.includes(fakePage)) {
          pages.push(fakePage);
        }
        return fakePage;
      },
      async close() {
        return undefined;
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
      captureSnapshot: async ({ requestedUrl }) => ({
        requestedUrl,
        finalUrl: currentUrl,
        title: "Example Domain",
        textExcerpt: "Example Domain",
        statusCode: 200,
        interactives: [],
      }),
    });

    const spawned = await manager.spawnSession({
      taskId: "task-1",
      threadId: "thread-1",
      instructions: "Open https://example.com",
      actions: [
        { kind: "open", url: "https://example.com" },
        { kind: "snapshot", note: "after-open" },
      ],
      ownerType: "thread",
      ownerId: "thread-1",
      profileOwnerType: "thread",
      profileOwnerId: "thread-1",
      leaseHolderRunKey: "worker:browser:thread-1",
    });

    const sent = await manager.sendSession({
      taskId: "task-2",
      threadId: "thread-1",
      instructions: "Snapshot current target",
      actions: [{ kind: "snapshot", note: "follow-up" }],
      browserSessionId: spawned.sessionId,
      ...(spawned.targetId ? { targetId: spawned.targetId } : {}),
      ownerType: "thread",
      ownerId: "thread-1",
      leaseHolderRunKey: "worker:browser:thread-1",
    });

    const resumed = await manager.resumeSession({
      taskId: "task-3",
      threadId: "thread-1",
      instructions: "Resume browser session",
      actions: [{ kind: "snapshot", note: "resume" }],
      browserSessionId: spawned.sessionId,
      ...(spawned.targetId ? { targetId: spawned.targetId } : {}),
      ownerType: "thread",
      ownerId: "thread-1",
      leaseHolderRunKey: "worker:browser:thread-1",
    });

    assert.equal(spawned.dispatchMode, "spawn");
    assert.equal(sent.dispatchMode, "send");
    assert.equal(resumed.dispatchMode, "resume");
    assert.ok(spawned.historyEntryId);
    assert.ok(sent.historyEntryId);
    assert.ok(resumed.historyEntryId);

    const history = await manager.getSessionHistory({ browserSessionId: spawned.sessionId });
    assert.deepEqual(
      history.map((entry) => entry.dispatchMode),
      ["spawn", "send", "resume"]
    );
    assert.equal(history.at(-1)?.targetId, spawned.targetId);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser session runtime preserves successful results when history persistence fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-session-runtime-success-history-failure-"));

  try {
    let nowTick = 100;
    let idTick = 0;
    let currentUrl = "about:blank";
    const fakePage = {
      url() {
        return currentUrl;
      },
      async title() {
        return "Example Domain";
      },
      async goto(url: string) {
        currentUrl = url;
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
    } as unknown as Page;
    const fakeContext = {
      on() {
        return this;
      },
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

    const historyStore: BrowserSessionHistoryStore = {
      async append() {
        throw new Error("history store unavailable");
      },
      async listBySession() {
        return [];
      },
    };

    const manager = new ChromeSessionManager({
      artifactRootDir: path.join(tempDir, "artifacts"),
      browserSessionManager: new BrowserSessionManager({
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
      }),
      browserSessionHistoryStore: historyStore,
      createId: (prefix) => `${prefix}-${++idTick}`,
      launchPersistentContext: async () => fakeContext,
      createEphemeralContext: async () => fakeContext,
      captureSnapshot: async ({ requestedUrl }) => ({
        requestedUrl,
        finalUrl: currentUrl,
        title: "Example Domain",
        textExcerpt: "Example Domain",
        statusCode: 200,
        interactives: [],
      }),
    });

    const result = await manager.spawnSession({
      taskId: "task-1",
      threadId: "thread-1",
      instructions: "Open https://example.com",
      actions: [
        { kind: "open", url: "https://example.com" },
        { kind: "snapshot", note: "after-open" },
      ],
      ownerType: "thread",
      ownerId: "thread-1",
      profileOwnerType: "thread",
      profileOwnerId: "thread-1",
      leaseHolderRunKey: "worker:browser:thread-1",
    });

    assert.equal(result.dispatchMode, "spawn");
    assert.equal(result.page.finalUrl, "https://example.com");
    assert.equal(result.historyEntryId, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser session runtime preserves original browser error when history persistence fails on failure path", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-session-runtime-error-history-failure-"));

  try {
    let nowTick = 100;
    let idTick = 0;
    const originalError = new Error("page goto failed");
    const fakePage = {
      url() {
        return "about:blank";
      },
      async title() {
        return "Example Domain";
      },
      async goto() {
        throw originalError;
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
    } as unknown as Page;
    const fakeContext = {
      on() {
        return this;
      },
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

    const historyStore: BrowserSessionHistoryStore = {
      async append(_entry: BrowserSessionHistoryEntry) {
        throw new Error("history write failed");
      },
      async listBySession() {
        return [];
      },
    };

    const manager = new ChromeSessionManager({
      artifactRootDir: path.join(tempDir, "artifacts"),
      browserSessionManager: new BrowserSessionManager({
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
      }),
      browserSessionHistoryStore: historyStore,
      createId: (prefix) => `${prefix}-${++idTick}`,
      launchPersistentContext: async () => fakeContext,
      createEphemeralContext: async () => fakeContext,
    });

    await assert.rejects(
      manager.spawnSession({
        taskId: "task-1",
        threadId: "thread-1",
        instructions: "Open https://example.com",
        actions: [{ kind: "open", url: "https://example.com" }],
        ownerType: "thread",
        ownerId: "thread-1",
        profileOwnerType: "thread",
        profileOwnerId: "thread-1",
        leaseHolderRunKey: "worker:browser:thread-1",
      }),
      (error: unknown) => error === originalError
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
