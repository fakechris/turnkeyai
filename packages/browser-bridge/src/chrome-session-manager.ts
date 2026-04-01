import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  BrowserArtifactStore,
  BrowserActionTrace,
  BrowserConsoleProbe,
  BrowserInteractiveElement,
  BrowserOwnerType,
  BrowserSnapshotResult,
  BrowserSessionDispatchMode,
  BrowserSessionHistoryEntry,
  BrowserSessionHistoryStore,
  BrowserSessionResumeInput,
  BrowserResumeMode,
  BrowserSession,
  BrowserSessionSendInput,
  BrowserSessionSpawnInput,
  BrowserTarget,
  FailureSummary,
  SnapshotRefStore,
  BrowserTaskAction,
  BrowserTaskRequest,
  BrowserTaskResult,
} from "@turnkeyai/core-types/team";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";

import { captureDomSnapshot } from "./dom-snapshot";
import type { BrowserSessionManager as LocalBrowserSessionManager } from "./session/browser-session-manager";

const DEFAULT_VIEWPORT = { width: 1440, height: 960 };
const DEFAULT_WAIT_MS = 800;

export class ChromeSessionManager {
  private readonly artifactRootDir: string;
  private readonly executablePath: string | undefined;
  private readonly headless: boolean;
  private readonly browserSessionManager: LocalBrowserSessionManager | undefined;
  private readonly browserSessionHistoryStore: BrowserSessionHistoryStore | undefined;
  private readonly snapshotRefStore: SnapshotRefStore | undefined;
  private readonly browserArtifactStore: BrowserArtifactStore | undefined;
  private readonly createId: (prefix: string) => string;
  private readonly pageHandleNamespace: string;
  private readonly captureSnapshot: (input: {
    page: Page;
    requestedUrl: string;
    statusCode: number;
  }) => Promise<BrowserSnapshotResult>;
  private readonly launchPersistentContext: (
    persistentDir: string
  ) => Promise<BrowserContext>;
  private readonly createEphemeralContext: () => Promise<BrowserContext>;
  private browserPromise: Promise<Browser> | null = null;
  private readonly liveContexts = new Map<string, Promise<BrowserContext>>();
  private readonly livePageHandles = new WeakMap<Page, string>();
  private pageHandleCounter = 0;

  constructor(options: {
    artifactRootDir: string;
    executablePath?: string;
    headless?: boolean;
    browserSessionManager?: LocalBrowserSessionManager;
    browserSessionHistoryStore?: BrowserSessionHistoryStore;
    snapshotRefStore?: SnapshotRefStore;
    browserArtifactStore?: BrowserArtifactStore;
    createId?: (prefix: string) => string;
    captureSnapshot?: (input: {
      page: Page;
      requestedUrl: string;
      statusCode: number;
    }) => Promise<BrowserSnapshotResult>;
    launchPersistentContext?: (persistentDir: string) => Promise<BrowserContext>;
    createEphemeralContext?: () => Promise<BrowserContext>;
  }) {
    this.artifactRootDir = options.artifactRootDir;
    this.executablePath = options.executablePath;
    this.headless = options.headless ?? true;
    this.browserSessionManager = options.browserSessionManager;
    this.browserSessionHistoryStore = options.browserSessionHistoryStore;
    this.snapshotRefStore = options.snapshotRefStore;
    this.browserArtifactStore = options.browserArtifactStore;
    this.createId = options.createId ?? ((prefix) => `${prefix}-${Date.now()}`);
    this.pageHandleNamespace = this.createId("page-handle-session");
    this.captureSnapshot = options.captureSnapshot ?? captureDomSnapshot;
    this.launchPersistentContext =
      options.launchPersistentContext ??
      (async (persistentDir) => {
        const executablePath = await resolveChromeExecutablePath(this.executablePath);
        return chromium.launchPersistentContext(persistentDir, {
          executablePath,
          headless: this.headless,
          ignoreHTTPSErrors: true,
          viewport: DEFAULT_VIEWPORT,
          args: ["--ignore-certificate-errors", "--disable-dev-shm-usage"],
        });
      });
    this.createEphemeralContext =
      options.createEphemeralContext ??
      (async () => {
        const browser = await this.launchBrowser();
        return browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: DEFAULT_VIEWPORT,
        });
      });
  }

  async runTask(task: BrowserTaskRequest): Promise<BrowserTaskResult> {
    return task.browserSessionId
      ? this.sendSession({ ...task, browserSessionId: task.browserSessionId })
      : this.spawnSession(task);
  }

  async spawnSession(task: BrowserSessionSpawnInput): Promise<BrowserTaskResult> {
    return this.executeTask("spawn", task);
  }

  async sendSession(task: BrowserSessionSendInput): Promise<BrowserTaskResult> {
    return this.executeTask("send", task);
  }

  async resumeSession(task: BrowserSessionResumeInput): Promise<BrowserTaskResult> {
    return this.executeTask("resume", task);
  }

  async getSessionHistory(input: { browserSessionId: string; limit?: number }): Promise<BrowserSessionHistoryEntry[]> {
    if (!this.browserSessionHistoryStore) {
      return [];
    }

    return this.browserSessionHistoryStore.listBySession(input.browserSessionId, input.limit);
  }

  private async executeTask(
    dispatchMode: BrowserSessionDispatchMode,
    task: BrowserTaskRequest
  ): Promise<BrowserTaskResult> {
    const lease = task.browserSessionId
      ? await this.browserSessionManager?.resumeSession({
          browserSessionId: task.browserSessionId,
          ownerType: task.ownerType ?? "thread",
          ownerId: task.ownerId ?? task.threadId,
          ...(task.leaseHolderRunKey ? { leaseHolderRunKey: task.leaseHolderRunKey } : {}),
          ...(task.leaseTtlMs !== undefined ? { leaseTtlMs: task.leaseTtlMs } : {}),
        })
      : await this.browserSessionManager?.acquireSession({
          ownerType: task.ownerType ?? "thread",
          ownerId: task.ownerId ?? task.threadId,
          profileOwnerType: task.profileOwnerType ?? task.ownerType ?? "thread",
          profileOwnerId: task.profileOwnerId ?? task.ownerId ?? task.threadId,
          preferredTransport: "local",
          reusable: true,
          ...(task.leaseHolderRunKey ? { leaseHolderRunKey: task.leaseHolderRunKey } : {}),
          ...(task.leaseTtlMs !== undefined ? { leaseTtlMs: task.leaseTtlMs } : {}),
        });
    const contextHandle = await this.createContext(lease);
    const context = contextHandle.context;
    const sessionId = lease?.session.browserSessionId ?? `browser-session-${Date.now()}`;
    const sessionDir = path.join(this.artifactRootDir, sessionId);
    const taskDir = path.join(sessionDir, encodeURIComponent(task.taskId));
    const trace: BrowserActionTrace[] = [];
    const screenshotPaths: string[] = [];
    const artifactIds: string[] = [];

    let requestedUrl = "";
    let lastStatusCode = 200;
    let latestSnapshot: BrowserSnapshotResult | null = null;
    let knownRefs = new Map<string, BrowserInteractiveElement>();
    let currentTargetId = task.targetId ?? lease?.session.activeTargetId;
    let resumeMode: BrowserResumeMode = "cold";
    let targetResolution: NonNullable<BrowserTaskResult["targetResolution"]> = "new_target";
    const startedAt = Date.now();

    await mkdir(taskDir, { recursive: true });

    try {
      if (lease) {
        await this.reconcileContextTargets(sessionId, context);
      }

      const pageResolution = await this.resolvePageForTask({
        context,
        sessionId,
        liveReuse: contextHandle.liveReuse,
        actions: task.actions,
        ...(currentTargetId ? { currentTargetId } : {}),
      });
      const page = pageResolution.page;
      resumeMode = pageResolution.resumeMode;
      targetResolution = pageResolution.targetResolution;

      if (lease && this.browserSessionManager && currentTargetId && targetResolution !== "new_target") {
        const target = await this.browserSessionManager.ensureTarget({
          browserSessionId: sessionId,
          targetId: currentTargetId,
          transportSessionId: this.getOrCreatePageHandle(page),
          url: page.url(),
          title: await page.title().catch(() => ""),
          status: "attached",
          lastResumeMode: resumeMode,
          createIfMissing: true,
        });
        currentTargetId = target.targetId;
      }

      for (const [index, action] of task.actions.entries()) {
        const stepId = `${task.taskId}:browser-step:${index + 1}`;
        const startedAt = Date.now();

        try {
          const output = await this.executeAction({
            page,
            action,
            stepIndex: index + 1,
            sessionDir: taskDir,
            requestedUrl,
            lastStatusCode,
            knownRefs,
            browserSessionId: sessionId,
            ...(currentTargetId ? { currentTargetId } : {}),
          });

          if (action.kind === "open") {
            requestedUrl = action.url;
            lastStatusCode = output.statusCode ?? lastStatusCode;
            if (this.browserSessionManager) {
              const target = await this.browserSessionManager.ensureTarget({
                browserSessionId: sessionId,
                transportSessionId: this.getOrCreatePageHandle(page),
                url: page.url(),
                title: await page.title().catch(() => ""),
                status: "attached",
                lastResumeMode: resumeMode,
                createIfMissing: true,
                ...(currentTargetId ? { targetId: currentTargetId } : {}),
              });
              currentTargetId = target.targetId;
            }
          }

          if (output.snapshot) {
            latestSnapshot = output.snapshot;
            lastStatusCode = output.snapshot.statusCode;
            knownRefs = buildRefMap(output.snapshot.interactives);
            if (currentTargetId && this.snapshotRefStore && this.browserArtifactStore) {
              const snapshotId = `${stepId}:snapshot`;
              const artifactId = `${stepId}:artifact`;
              const snapshotPath = path.join(taskDir, `${String(index + 1).padStart(2, "0")}-snapshot.json`);
              const now = Date.now();
              await writeFile(snapshotPath, `${JSON.stringify(output.snapshot, null, 2)}\n`, "utf8");
              await this.snapshotRefStore.save({
                artifactId,
                snapshotId,
                browserSessionId: sessionId,
                targetId: currentTargetId,
                createdAt: now,
                finalUrl: output.snapshot.finalUrl,
                title: output.snapshot.title,
                refEntries: output.snapshot.interactives.map((item, itemIndex) => ({
                  refId: item.refId,
                  role: item.role,
                  label: item.label,
                  tagName: item.tagName,
                  ...(item.selectors ? { selectors: item.selectors } : {}),
                  ...(item.textAnchors ? { textAnchors: item.textAnchors } : {}),
                  ordinal: itemIndex + 1,
                })),
              });
              await this.browserArtifactStore.put({
                artifactId,
                browserSessionId: sessionId,
                targetId: currentTargetId,
                type: "snapshot",
                path: snapshotPath,
                createdAt: now,
                metadata: {
                  finalUrl: output.snapshot.finalUrl,
                  title: output.snapshot.title,
                },
              });
              artifactIds.push(artifactId);
            }
          }

          if (output.screenshotPath) {
            screenshotPaths.push(output.screenshotPath);
            if (this.browserArtifactStore) {
              const artifactId = `${stepId}:screenshot`;
              const now = Date.now();
              await this.browserArtifactStore.put({
                artifactId,
                browserSessionId: sessionId,
                ...(currentTargetId ? { targetId: currentTargetId } : {}),
                type: "screenshot",
                path: output.screenshotPath,
                createdAt: now,
              });
              artifactIds.push(artifactId);
            }
          }

          const traceEntry: BrowserActionTrace = {
            stepId,
            kind: action.kind,
            startedAt,
            completedAt: Date.now(),
            status: "ok",
            input: toTraceInput(action),
          };

          if (output.traceOutput) {
            traceEntry.output = output.traceOutput;
          }

          trace.push(traceEntry);
        } catch (error) {
          trace.push({
            stepId,
            kind: action.kind,
            startedAt,
            completedAt: Date.now(),
            status: "failed",
            input: toTraceInput(action),
            errorMessage: error instanceof Error ? error.message : "unknown browser action error",
          });
          throw error;
        }
      }

      if (!latestSnapshot) {
        latestSnapshot = await this.captureSnapshot({
          page,
          requestedUrl: requestedUrl || page.url(),
          statusCode: lastStatusCode,
        });
      }

      if (currentTargetId && this.browserSessionManager) {
        await this.browserSessionManager.ensureTarget({
          browserSessionId: sessionId,
          targetId: currentTargetId,
          transportSessionId: this.getOrCreatePageHandle(page),
          url: latestSnapshot.finalUrl,
          title: latestSnapshot.title,
          status: "attached",
          lastResumeMode: resumeMode,
          createIfMissing: true,
        });
      }

      const result: BrowserTaskResult = {
        sessionId,
        ...(currentTargetId ? { targetId: currentTargetId } : {}),
        dispatchMode,
        resumeMode,
        targetResolution,
        page: latestSnapshot,
        screenshotPaths,
        trace,
        artifactIds,
      };
      let historyEntryId: string | undefined;
      try {
        historyEntryId = await this.appendHistoryEntry({
          dispatchMode,
          task,
          sessionId,
          startedAt,
          result,
          ownerType: lease?.session.ownerType ?? task.ownerType ?? "thread",
          ownerId: lease?.session.ownerId ?? task.ownerId ?? task.threadId,
        });
      } catch {
        // History persistence is best-effort and must not turn a successful browser task into a failure.
      }
      return historyEntryId ? { ...result, historyEntryId } : result;
    } catch (error) {
      await this.appendHistoryEntry({
        dispatchMode,
        task,
        sessionId,
        startedAt,
        error,
        ownerType: lease?.session.ownerType ?? task.ownerType ?? "thread",
        ownerId: lease?.session.ownerId ?? task.ownerId ?? task.threadId,
      }).catch(() => {
        // Preserve the original browser error when history persistence also fails.
      });
      throw error;
    } finally {
      if (!contextHandle.keepAlive) {
        await safeClose(context);
      }
      if (lease && this.browserSessionManager) {
        await this.browserSessionManager.releaseSession({
          browserSessionId: lease.session.browserSessionId,
          ...(task.leaseHolderRunKey ? { leaseHolderRunKey: task.leaseHolderRunKey } : {}),
          resumeMode,
        });
      }
    }
  }

  private async appendHistoryEntry(input: {
    dispatchMode: BrowserSessionDispatchMode;
    task: BrowserTaskRequest;
    sessionId: string;
    startedAt: number;
    ownerType: BrowserOwnerType;
    ownerId: string;
    result?: BrowserTaskResult;
    error?: unknown;
  }): Promise<string | undefined> {
    if (!this.browserSessionHistoryStore) {
      return undefined;
    }

    const entryId = this.createId("browser-history");
    const result = input.result;
    const failure = input.error ? summarizeBrowserFailureSummary(input.error) : undefined;

    await this.browserSessionHistoryStore.append({
      entryId,
      browserSessionId: input.sessionId,
      dispatchMode: input.dispatchMode,
      threadId: input.task.threadId,
      taskId: input.task.taskId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      ...(result?.targetId ? { targetId: result.targetId } : {}),
      historyCursor: input.startedAt,
      startedAt: input.startedAt,
      completedAt: Date.now(),
      status: result ? "completed" : "failed",
      actionKinds: input.task.actions.map((action) => action.kind),
      instructions: input.task.instructions,
      ...(result?.resumeMode ? { resumeMode: result.resumeMode } : {}),
      ...(result?.targetResolution ? { targetResolution: result.targetResolution } : {}),
      summary: result
        ? summarizeBrowserHistorySuccess(input.dispatchMode, result)
        : summarizeBrowserHistoryFailure(input.dispatchMode, input.error),
      ...(result
        ? {
            finalUrl: result.page.finalUrl,
            title: result.page.title,
            traceStepCount: result.trace.length,
            screenshotCount: result.screenshotPaths.length,
            artifactCount: result.artifactIds.length,
          }
        : {}),
      ...(failure ? { failure } : {}),
    });

    return entryId;
  }

  async closeSession(browserSessionId: string, reason = "session closed"): Promise<void> {
    const liveContext = this.liveContexts.get(browserSessionId);
    this.liveContexts.delete(browserSessionId);
    if (liveContext) {
      const resolved = await liveContext.catch(() => null);
      if (resolved) {
        await safeClose(resolved);
      }
    }

    if (this.browserSessionManager) {
      await this.browserSessionManager.closeSession(browserSessionId, reason);
    }
  }

  async listTargets(browserSessionId: string): Promise<BrowserTarget[]> {
    if (!this.browserSessionManager) {
      return [];
    }

    return this.browserSessionManager.listTargets(browserSessionId);
  }

  async listSessions(input?: { ownerType?: BrowserSession["ownerType"]; ownerId?: string }): Promise<BrowserSession[]> {
    if (!this.browserSessionManager) {
      return [];
    }

    return this.browserSessionManager.listSessions(input);
  }

  async openTarget(
    browserSessionId: string,
    url: string,
    owner?: { ownerType?: BrowserSession["ownerType"]; ownerId?: string }
  ): Promise<BrowserTarget> {
    if (!this.browserSessionManager) {
      throw new Error("browser session manager is not configured");
    }

    const lease = await this.browserSessionManager.resumeSession({
      browserSessionId,
      ...(owner?.ownerType ? { ownerType: owner.ownerType } : {}),
      ...(owner?.ownerId ? { ownerId: owner.ownerId } : {}),
    });
    const contextHandle = await this.createContext(lease);
    try {
      const page = await contextHandle.context.newPage();
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      await settle(page);
      const target = await this.browserSessionManager.ensureTarget({
        browserSessionId,
        transportSessionId: this.getOrCreatePageHandle(page),
        url: page.url(),
        title: await page.title().catch(() => ""),
        status: "attached",
        lastResumeMode: contextHandle.liveReuse ? "hot" : "cold",
        createIfMissing: true,
      });
      return {
        ...target,
        status: response ? "attached" : target.status,
      };
    } finally {
      if (!contextHandle.keepAlive) {
        await safeClose(contextHandle.context);
      }
      await this.browserSessionManager.releaseSession({ browserSessionId });
    }
  }

  async activateTarget(
    browserSessionId: string,
    targetId: string,
    owner?: { ownerType?: BrowserSession["ownerType"]; ownerId?: string }
  ): Promise<BrowserTarget> {
    if (!this.browserSessionManager) {
      throw new Error("browser session manager is not configured");
    }

    const lease = await this.browserSessionManager.resumeSession({
      browserSessionId,
      ...(owner?.ownerType ? { ownerType: owner.ownerType } : {}),
      ...(owner?.ownerId ? { ownerId: owner.ownerId } : {}),
    });
    try {
      return await this.browserSessionManager.activateTarget(browserSessionId, targetId);
    } finally {
      await this.browserSessionManager.releaseSession({ browserSessionId: lease.session.browserSessionId });
    }
  }

  async closeTarget(
    browserSessionId: string,
    targetId: string,
    owner?: { ownerType?: BrowserSession["ownerType"]; ownerId?: string }
  ): Promise<BrowserTarget> {
    if (!this.browserSessionManager) {
      throw new Error("browser session manager is not configured");
    }

    const lease = await this.browserSessionManager.resumeSession({
      browserSessionId,
      ...(owner?.ownerType ? { ownerType: owner.ownerType } : {}),
      ...(owner?.ownerId ? { ownerId: owner.ownerId } : {}),
    });

    const liveContext = this.liveContexts.get(browserSessionId);
    const context = liveContext ? await liveContext.catch(() => null) : null;
    try {
      if (context) {
        const targets = await this.browserSessionManager.listTargets(browserSessionId);
        const closingTarget = targets.find((item) => item.targetId === targetId);
        if (closingTarget?.transportSessionId) {
          const page = context.pages().find((item) => this.getOrCreatePageHandle(item) === closingTarget.transportSessionId);
          if (page) {
            await safeClose(page);
          }
        }
      }

      return await this.browserSessionManager.closeTarget(browserSessionId, targetId);
    } finally {
      await this.browserSessionManager.releaseSession({ browserSessionId: lease.session.browserSessionId });
    }
  }

  async evictIdleSessions(input: { idleBefore: number; reason?: string }): Promise<BrowserSession[]> {
    if (!this.browserSessionManager) {
      return [];
    }

    const sessions = await this.browserSessionManager.listSessions();
    const evicted: BrowserSession[] = [];

    for (const session of sessions) {
      if (session.status === "busy" || session.status === "closed" || session.lastActiveAt > input.idleBefore) {
        continue;
      }

      await this.closeSession(session.browserSessionId, input.reason ?? "idle eviction");
      evicted.push({
        ...session,
        status: "closed",
        closeReason: input.reason ?? "idle eviction",
      });
    }

    return evicted;
  }

  private async createContext(
    lease: { session: { browserSessionId: string }; profile: { persistentDir: string } } | undefined
  ): Promise<{ context: BrowserContext; keepAlive: boolean; liveReuse: boolean }> {
    if (lease?.profile.persistentDir) {
      const existingLiveContext = this.liveContexts.has(lease.session.browserSessionId);
      return {
        context: await this.getOrCreatePersistentContext(lease.session.browserSessionId, lease.profile.persistentDir),
        keepAlive: true,
        liveReuse: existingLiveContext,
      };
    }

    return {
      context: await this.createEphemeralContext(),
      keepAlive: false,
      liveReuse: false,
    };
  }

  private async getOrCreatePersistentContext(browserSessionId: string, persistentDir: string): Promise<BrowserContext> {
    const existing = this.liveContexts.get(browserSessionId);
    if (existing) {
      return existing;
    }

    const created = this.launchPersistentContext(persistentDir)
      .then((context) => {
        context.on("close", () => {
          this.liveContexts.delete(browserSessionId);
        });
        return context;
      })
      .catch((error) => {
        this.liveContexts.delete(browserSessionId);
        throw error;
      });
    this.liveContexts.set(browserSessionId, created);
    return created;
  }

  private async resolvePageForTask(input: {
    context: BrowserContext;
    sessionId: string;
    liveReuse: boolean;
    currentTargetId?: string;
    actions: BrowserTaskAction[];
  }): Promise<{ page: Page; resumeMode: BrowserResumeMode; targetResolution: NonNullable<BrowserTaskResult["targetResolution"]> }> {
    const { context, sessionId, liveReuse, currentTargetId, actions } = input;
    const pages = context.pages();

    if (!this.browserSessionManager || !currentTargetId) {
      const existing = pages.at(-1);
      if (existing) {
        return {
          page: existing,
          resumeMode: liveReuse ? "hot" : "warm",
          targetResolution: liveReuse ? "attach" : "reconnect",
        };
      }
      return {
        page: await context.newPage(),
        resumeMode: "cold",
        targetResolution: "new_target",
      };
    }

    const targets = await this.browserSessionManager.listTargets(sessionId);
    const currentTarget = targets.find((target) => target.targetId === currentTargetId);
    if (!currentTarget) {
      const existing = pages.at(-1);
      if (existing) {
        return {
          page: existing,
          resumeMode: liveReuse ? "hot" : "warm",
          targetResolution: liveReuse ? "attach" : "reconnect",
        };
      }
      return {
        page: await context.newPage(),
        resumeMode: "cold",
        targetResolution: "new_target",
      };
    }

    const matchedPage = await this.findMatchingPage(pages, currentTarget);
    if (matchedPage) {
      return {
        page: matchedPage,
        resumeMode: liveReuse ? "hot" : "warm",
        targetResolution: liveReuse ? "attach" : "reconnect",
      };
    }

    const page = await context.newPage();
    const firstAction = actions[0];
    try {
      if (currentTarget.url && firstAction?.kind !== "open") {
        await page.goto(currentTarget.url, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
        await settle(page);
      } else if (currentTarget.status === "detached" && firstAction?.kind !== "open") {
        throw new Error(`invalid resume: detached target cannot be reopened without a URL (${currentTarget.targetId})`);
      }
      return {
        page,
        resumeMode: "cold",
        targetResolution: currentTarget.url && firstAction?.kind !== "open" ? "reopen" : "new_target",
      };
    } catch (error) {
      await safeClose(page);
      throw error;
    }
  }

  private async reconcileContextTargets(browserSessionId: string, context: BrowserContext): Promise<void> {
    if (!this.browserSessionManager) {
      return;
    }

    const targets = await this.browserSessionManager.listTargets(browserSessionId);
    const liveHandles = new Set(context.pages().map((page) => this.getOrCreatePageHandle(page)));

    for (const target of targets) {
      if (
        target.transportSessionId &&
        (target.status === "attached" || target.status === "open") &&
        !liveHandles.has(target.transportSessionId)
      ) {
        await this.browserSessionManager.markTargetDetached(browserSessionId, target.targetId);
      }
    }
  }

  private async findMatchingPage(pages: Page[], target: BrowserTarget): Promise<Page | null> {
    if (target.transportSessionId) {
      for (const page of pages) {
        if (this.getOrCreatePageHandle(page) === target.transportSessionId) {
          return page;
        }
      }
    }

    if (target.status === "detached") {
      return null;
    }

    const candidates: Page[] = [];
    for (const page of pages) {
      if (target.url && page.url() === target.url) {
        candidates.push(page);
        continue;
      }
      if (target.title) {
        const title = await page.title().catch(() => "");
        if (title === target.title) {
          candidates.push(page);
        }
      }
    }

    return candidates.length === 1 ? candidates[0]! : null;
  }

  private getOrCreatePageHandle(page: Page): string {
    const existing = this.livePageHandles.get(page);
    if (existing) {
      return existing;
    }

    const created = `${this.pageHandleNamespace}-${++this.pageHandleCounter}`;
    this.livePageHandles.set(page, created);
    return created;
  }

  private async launchBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = resolveChromeExecutablePath(this.executablePath)
        .then((executablePath) =>
          chromium.launch({
            executablePath,
            headless: this.headless,
            args: ["--ignore-certificate-errors", "--disable-dev-shm-usage"],
          })
        )
        .then((browser) => {
          browser.on("disconnected", () => {
            this.browserPromise = null;
          });
          return browser;
        })
        .catch((error) => {
          this.browserPromise = null;
          throw error;
        });
    }

    return this.browserPromise;
  }

  private async executeAction(input: {
    page: Page;
    action: BrowserTaskAction;
    stepIndex: number;
    sessionDir: string;
    requestedUrl: string;
    lastStatusCode: number;
    knownRefs: Map<string, BrowserInteractiveElement>;
    browserSessionId: string;
    currentTargetId?: string;
  }): Promise<{
    statusCode?: number;
    snapshot?: BrowserSnapshotResult;
    screenshotPath?: string;
    traceOutput?: Record<string, unknown>;
  }> {
    const {
      page,
      action,
      stepIndex,
      sessionDir,
      requestedUrl,
      lastStatusCode,
      knownRefs,
      browserSessionId,
      currentTargetId,
    } = input;

    if (action.kind === "open") {
      const response = await page.goto(action.url, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      await settle(page);

      return {
        statusCode: response?.status() ?? lastStatusCode,
        traceOutput: {
          finalUrl: page.url(),
          statusCode: response?.status() ?? null,
        },
      };
    }

    if (action.kind === "snapshot") {
      const snapshot = await this.captureSnapshot({
        page,
        requestedUrl: requestedUrl || page.url(),
        statusCode: lastStatusCode,
      });

      return {
        snapshot,
        traceOutput: {
          finalUrl: snapshot.finalUrl,
          title: snapshot.title,
          interactiveCount: snapshot.interactives.length,
          refs: snapshot.interactives.map((item) => ({
            refId: item.refId,
            role: item.role,
            label: item.label,
          })),
        },
      };
    }

    if (action.kind === "type") {
      const locator = await this.resolveActionLocator(page, action, knownRefs, browserSessionId, currentTargetId);
      await locator.fill(action.text);
      if (action.submit) {
        await locator.press("Enter");
        await settle(page);
      }

      return {
        traceOutput: {
          selectors: action.selectors ?? [],
          refId: action.refId ?? null,
          typedLength: action.text.length,
          submitted: Boolean(action.submit),
        },
      };
    }

    if (action.kind === "click") {
      const locator = await this.resolveActionLocator(page, action, knownRefs, browserSessionId, currentTargetId);
      await locator.click();
      await settle(page);

      return {
        traceOutput: {
          selectors: action.selectors ?? [],
          refId: action.refId ?? null,
          text: action.text ?? null,
          finalUrl: page.url(),
        },
      };
    }

    if (action.kind === "scroll") {
      const amount = action.amount ?? 800;
      const scrollY = await page.evaluate(
        ({ direction, step }) => {
          const delta = direction === "down" ? step : step * -1;
          window.scrollBy({ top: delta, behavior: "instant" });
          return window.scrollY;
        },
        { direction: action.direction, step: amount }
      );

      return {
        traceOutput: {
          direction: action.direction,
          amount,
          scrollY,
        },
      };
    }

    if (action.kind === "console") {
      const result = await executeConsoleProbe(page, action.probe);

      return {
        traceOutput: {
          probe: action.probe,
          result: serializeConsoleResult(result),
        },
      };
    }

    if (action.kind === "wait") {
      await page.waitForTimeout(action.timeoutMs);
      return {
        traceOutput: {
          timeoutMs: action.timeoutMs,
        },
      };
    }

    const screenshotPath = path.join(
      sessionDir,
      `${String(stepIndex).padStart(2, "0")}-${sanitizeLabel(action.label ?? action.kind)}.png`
    );
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });

    return {
      screenshotPath,
      traceOutput: {
        path: screenshotPath,
      },
    };
  }

  private async resolveActionLocator(
    page: Page,
    action: Extract<BrowserTaskAction, { kind: "click" | "type" }>,
    knownRefs: Map<string, BrowserInteractiveElement>,
    browserSessionId: string,
    currentTargetId?: string
  ): Promise<Locator> {
    if (action.refId) {
      if (knownRefs.has(action.refId)) {
        return resolveRefLocator(page, action.refId);
      }

      if (currentTargetId && this.snapshotRefStore) {
        const resolved = await this.snapshotRefStore.resolve({
          browserSessionId,
          targetId: currentTargetId,
          refId: action.refId,
        });
        if (resolved?.selectors?.length) {
          return resolveLocator(page, resolved.selectors);
        }
        if (resolved?.label) {
          return resolveTextLocator(page, resolved.label);
        }
      }

      throw new Error(`unknown snapshot ref requested: ${action.refId}`);
    }

    if (action.selectors?.length) {
      return resolveLocator(page, action.selectors);
    }

    if (action.kind === "click") {
      return resolveTextLocator(page, action.text ?? "");
    }

    throw new Error("type action requires selectors or refId");
  }
}

async function resolveChromeExecutablePath(explicitPath?: string): Promise<string> {
  const candidates = [
    explicitPath,
    process.env.TURNKEYAI_BROWSER_PATH,
    process.env.GOOGLE_CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  throw new Error("no local Chrome executable found for browser bridge");
}

async function resolveLocator(page: Page, selectors: string[]): Promise<Locator> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      return locator;
    }
  }

  throw new Error(`no matching selector found: ${selectors.join(", ")}`);
}

async function resolveRefLocator(page: Page, refId: string): Promise<Locator> {
  const locator = page.locator(`[data-turnkeyai-ref="${refId}"]`).first();
  if (await locator.count()) {
    return locator;
  }

  throw new Error(`no element found for snapshot ref: ${refId}`);
}

async function resolveTextLocator(page: Page, text: string): Promise<Locator> {
  const trimmed = text.trim();
  const candidates = [
    page.getByRole("button", { name: trimmed, exact: false }).first(),
    page.getByRole("link", { name: trimmed, exact: false }).first(),
    page.getByText(trimmed, { exact: false }).first(),
  ];

  for (const locator of candidates) {
    if (await locator.count()) {
      return locator;
    }
  }

  throw new Error(`no clickable element found for text: ${trimmed}`);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(DEFAULT_WAIT_MS);
}

function toTraceInput(action: BrowserTaskAction): Record<string, unknown> {
  if (action.kind === "open") {
    return { url: action.url };
  }

  if (action.kind === "type") {
    return {
      selectors: action.selectors ?? [],
      refId: action.refId ?? null,
      textLength: action.text.length,
      submit: Boolean(action.submit),
    };
  }

  if (action.kind === "click") {
    return {
      selectors: action.selectors ?? [],
      refId: action.refId ?? null,
      text: action.text ?? null,
    };
  }

  if (action.kind === "scroll") {
    return {
      direction: action.direction,
      amount: action.amount ?? null,
    };
  }

  if (action.kind === "console") {
    return {
      probe: action.probe,
    };
  }

  if (action.kind === "wait") {
    return { timeoutMs: action.timeoutMs };
  }

  if (action.kind === "screenshot") {
    return { label: action.label ?? null };
  }

  return { note: action.note ?? null };
}

function sanitizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function summarizeBrowserHistorySuccess(
  dispatchMode: BrowserSessionDispatchMode,
  result: BrowserTaskResult
): string {
  return [
    `Browser ${dispatchMode} completed for session ${result.sessionId}.`,
    `Final URL: ${result.page.finalUrl || "n/a"}.`,
    result.page.title ? `Title: ${result.page.title}.` : null,
    result.targetId ? `Target: ${result.targetId}.` : null,
    result.resumeMode ? `Resume mode: ${result.resumeMode}.` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");
}

function summarizeBrowserHistoryFailure(dispatchMode: BrowserSessionDispatchMode, error: unknown): string {
  return `Browser ${dispatchMode} failed: ${error instanceof Error ? error.message : "browser execution failed"}.`;
}

function summarizeBrowserFailureSummary(error: unknown): FailureSummary {
  return {
    layer: "browser",
    category: "transport_failed",
    retryable: true,
    message: error instanceof Error ? error.message : "browser execution failed",
    recommendedAction: "retry",
  };
}

async function safeClose(target: BrowserContext | Browser | Page): Promise<void> {
  if (!target || typeof (target as { close?: unknown }).close !== "function") {
    return;
  }

  await target.close().catch(() => {});
}

async function executeConsoleProbe(page: Page, probe: BrowserConsoleProbe): Promise<unknown> {
  if (probe === "page-metadata") {
    return page.evaluate(() => ({
      title: document.title,
      href: location.href,
      interactiveCount: document.querySelectorAll(
        "a,button,input,textarea,select,[role='button'],[contenteditable='true']"
      ).length,
    }));
  }

  if (probe === "interactive-summary") {
    return page.evaluate(() =>
      Array.from(
        document.querySelectorAll("a,button,input,textarea,select,[role='button'],[contenteditable='true']")
      )
        .slice(0, 20)
        .map((element) => {
          const html = element as HTMLElement;
          return {
            tagName: html.tagName.toLowerCase(),
            text: html.innerText.trim().slice(0, 120),
            ariaLabel: html.getAttribute("aria-label"),
          };
        })
    );
  }

  throw new Error(`unsupported console probe: ${probe}`);
}

function buildRefMap(interactives: BrowserInteractiveElement[]): Map<string, BrowserInteractiveElement> {
  return new Map(interactives.map((item) => [item.refId, item]));
}

function serializeConsoleResult(result: unknown): unknown {
  if (result === null || typeof result === "string" || typeof result === "number" || typeof result === "boolean") {
    return result;
  }

  try {
    return JSON.parse(JSON.stringify(result));
  } catch {
    return String(result);
  }
}
