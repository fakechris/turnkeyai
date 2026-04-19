import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  BrowserArtifactStore,
  BrowserActionTrace,
  BrowserConsoleProbe,
  BrowserInteractiveElement,
  BrowserOwnerType,
  BrowserPermissionName,
  BrowserTransportMode,
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
import {
  DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_BROWSER_DIALOG_TIMEOUT_MS,
  DEFAULT_BROWSER_POPUP_TIMEOUT_MS,
  DEFAULT_BROWSER_WAIT_FOR_TIMEOUT_MS,
  MAX_BROWSER_CDP_ACTION_EVENT_TIMEOUT_MS,
  MAX_BROWSER_CDP_ACTION_EVENTS,
  MAX_BROWSER_CDP_ACTION_TIMEOUT_MS,
  MAX_BROWSER_CDP_EVENT_PARAMS_BYTES,
  MAX_BROWSER_COOKIE_READ_ENTRIES,
  MAX_BROWSER_COOKIE_READ_VALUE_BYTES,
  MAX_BROWSER_DOWNLOAD_FILE_BYTES,
  MAX_BROWSER_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_BROWSER_EVAL_TIMEOUT_MS,
  MAX_BROWSER_EVAL_RESULT_BYTES,
  MAX_BROWSER_EVAL_TIMEOUT_MS,
  DEFAULT_BROWSER_NETWORK_TIMEOUT_MS,
  MAX_BROWSER_NETWORK_TIMEOUT_MS,
  MAX_BROWSER_PERMISSION_ORIGIN_LENGTH,
  MAX_BROWSER_PROBE_ITEMS,
  MAX_BROWSER_UPLOAD_FILE_BYTES,
  MAX_BROWSER_UPLOAD_FILE_NAME_LENGTH,
  MAX_BROWSER_STORAGE_READ_ENTRIES,
  MAX_BROWSER_STORAGE_READ_VALUE_BYTES,
  isBlockedBrowserCdpMethod,
  normalizeBrowserCdpMethod,
} from "@turnkeyai/core-types/team";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Dialog, type Download, type Locator, type Page, type Response } from "playwright-core";

import { captureDomSnapshot } from "./dom-snapshot";
import type { BrowserSessionManager as LocalBrowserSessionManager } from "./session/browser-session-manager";

const DEFAULT_VIEWPORT = { width: 1440, height: 960 };
const DEFAULT_WAIT_MS = 800;
const MAX_CDP_TRACE_RESULT_BYTES = 4_096;

interface LocalCdpEvent {
  method: string;
  params?: Record<string, unknown>;
  timestamp: number;
}

interface LocalCdpActionOutput {
  result: unknown;
  events: LocalCdpEvent[];
}

interface LocalDownloadArtifact {
  artifactId: string;
  path: string;
  fileName: string;
  sizeBytes: number;
  url: string;
  mimeType?: string;
}

interface LocalCdpCookie {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
}

export class ChromeSessionManager {
  private readonly artifactRootDir: string;
  private readonly executablePath: string | undefined;
  private readonly headless: boolean;
  private readonly transportMode: BrowserTransportMode;
  private readonly transportLabel: string;
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
    transportMode?: BrowserTransportMode;
    transportLabel?: string;
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
    this.transportMode = options.transportMode ?? "local";
    this.transportLabel = options.transportLabel ?? "local-automation";
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
          preferredTransport: this.transportMode,
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
    const pendingDialogHandlers: Promise<void>[] = [];
    const pendingNetworkHandlers: Promise<void>[] = [];
    const pendingDownloadHandlers: Promise<LocalDownloadArtifact | null>[] = [];

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
      let page = pageResolution.page;
      resumeMode = pageResolution.resumeMode;
      targetResolution = pageResolution.targetResolution;
      let pendingPopupHandler: { promise: Promise<Page>; traceEntry: BrowserActionTrace } | null = null;

      const consumePendingPopup = async (): Promise<void> => {
        if (!pendingPopupHandler) {
          return;
        }
        const popupPage = await pendingPopupHandler.promise;
        pendingPopupHandler = null;
        page = popupPage;
        latestSnapshot = null;
        knownRefs = new Map<string, BrowserInteractiveElement>();
        requestedUrl = page.url();
        lastStatusCode = 200;
        if (this.browserSessionManager) {
          const target = await this.browserSessionManager.ensureTarget({
            browserSessionId: sessionId,
            transportSessionId: this.getOrCreatePageHandle(page),
            url: page.url(),
            title: await page.title().catch(() => ""),
            status: "attached",
            lastResumeMode: "hot",
            createIfMissing: true,
          });
          currentTargetId = target.targetId;
        }
      };

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
          if (action.kind === "dialog") {
            const timeoutMs = action.timeoutMs ?? DEFAULT_BROWSER_DIALOG_TIMEOUT_MS;
            const traceEntry: BrowserActionTrace = {
              stepId,
              kind: action.kind,
              startedAt,
              completedAt: Date.now(),
              status: "ok",
              input: toTraceInput(action),
              output: {
                action: action.action,
                timeoutMs,
                armed: true,
              },
            };
            trace.push(traceEntry);
            const pending = armPageDialogHandler(page, action, traceEntry, timeoutMs);
            pending.catch(() => undefined);
            pendingDialogHandlers.push(pending);
            continue;
          }

          if (action.kind === "popup") {
            if (pendingPopupHandler) {
              throw new Error("popup action is already armed");
            }
            const timeoutMs = action.timeoutMs ?? DEFAULT_BROWSER_POPUP_TIMEOUT_MS;
            const traceEntry: BrowserActionTrace = {
              stepId,
              kind: action.kind,
              startedAt,
              completedAt: Date.now(),
              status: "ok",
              input: toTraceInput(action),
              output: {
                timeoutMs,
                armed: true,
              },
            };
            trace.push(traceEntry);
            const promise = armPagePopupHandler(page, action, traceEntry, timeoutMs);
            promise.catch(() => undefined);
            pendingPopupHandler = { promise, traceEntry };
            continue;
          }

          if (action.kind === "network") {
            const timeoutMs = normalizeNetworkTimeoutMs(action.timeoutMs);
            const traceEntry: BrowserActionTrace = {
              stepId,
              kind: action.kind,
              startedAt,
              completedAt: Date.now(),
              status: "ok",
              input: toTraceInput(action),
              output: {
                action: action.action,
                timeoutMs,
                armed: true,
              },
            };
            trace.push(traceEntry);
            const pending = armPageNetworkHandler(page, action, traceEntry, timeoutMs);
            pending.catch(() => undefined);
            pendingNetworkHandlers.push(pending);
            continue;
          }

          if (action.kind === "download") {
            const timeoutMs = normalizeDownloadTimeoutMs(action.timeoutMs);
            const traceEntry: BrowserActionTrace = {
              stepId,
              kind: action.kind,
              startedAt,
              completedAt: Date.now(),
              status: "ok",
              input: toTraceInput(action),
              output: {
                timeoutMs,
                armed: true,
              },
            };
            trace.push(traceEntry);
            const pending = armPageDownloadHandler(page, action, traceEntry, timeoutMs, {
              taskDir,
              stepId,
              browserSessionId: sessionId,
              ...(currentTargetId ? { targetId: currentTargetId } : {}),
              ...(this.browserArtifactStore ? { browserArtifactStore: this.browserArtifactStore } : {}),
            });
            pending.catch(() => undefined);
            pendingDownloadHandlers.push(pending);
            continue;
          }

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
          await consumePendingPopup();
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

      const downloadedArtifacts = await Promise.all(pendingDownloadHandlers);
      for (const artifact of downloadedArtifacts) {
        if (artifact) {
          artifactIds.push(artifact.artifactId);
        }
      }
      await Promise.all([...pendingDialogHandlers, ...pendingNetworkHandlers]);
      await consumePendingPopup();

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
        transportMode: this.transportMode,
        transportLabel: this.transportLabel,
        transportTargetId: this.getOrCreatePageHandle(page),
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
      ...(result?.transportMode ? { transportMode: result.transportMode } : {}),
      ...(result?.transportLabel ? { transportLabel: result.transportLabel } : {}),
      ...(result?.transportPeerId ? { transportPeerId: result.transportPeerId } : {}),
      ...(result?.transportTargetId ? { transportTargetId: result.transportTargetId } : {}),
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

    if (action.kind === "hover") {
      const locator = await this.resolveActionLocator(page, action, knownRefs, browserSessionId, currentTargetId);
      await locator.hover();
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

    if (action.kind === "key") {
      const shortcut = formatKeyboardShortcut(action);
      await page.keyboard.press(shortcut);
      await settle(page);

      return {
        traceOutput: {
          key: action.key,
          modifiers: action.modifiers ?? [],
          shortcut,
        },
      };
    }

    if (action.kind === "select") {
      const locator = await this.resolveActionLocator(page, action, knownRefs, browserSessionId, currentTargetId);
      const selectedValues = await locator.selectOption(toPlaywrightSelectOption(action));
      await settle(page);

      return {
        traceOutput: {
          selectors: action.selectors ?? [],
          refId: action.refId ?? null,
          value: action.value ?? null,
          label: action.label ?? null,
          index: action.index ?? null,
          selectedValues,
          finalUrl: page.url(),
        },
      };
    }

    if (action.kind === "upload") {
      const locator = await this.resolveActionTargetLocator(
        page,
        action,
        knownRefs,
        browserSessionId,
        currentTargetId
      );
      const artifact = await this.resolveUploadArtifact(browserSessionId, action.artifactId);
      await locator.setInputFiles(artifact.path);
      await settle(page);

      return {
        traceOutput: {
          ...summarizeActionTarget(action),
          artifactId: action.artifactId,
          fileName: artifact.fileName,
          sizeBytes: artifact.sizeBytes,
          finalUrl: page.url(),
        },
      };
    }

    if (action.kind === "drag") {
      const sourceLocator = await this.resolveActionTargetLocator(
        page,
        action.source,
        knownRefs,
        browserSessionId,
        currentTargetId
      );
      const targetLocator = await this.resolveActionTargetLocator(
        page,
        action.target,
        knownRefs,
        browserSessionId,
        currentTargetId
      );
      await sourceLocator.dragTo(targetLocator);
      await settle(page);

      return {
        traceOutput: {
          source: summarizeActionTarget(action.source),
          target: summarizeActionTarget(action.target),
          finalUrl: page.url(),
        },
      };
    }

    if (action.kind === "scroll") {
      const amount = action.amount ?? 800;
      const scrollY = await page.evaluate(
        `(() => {
          const direction = ${JSON.stringify(action.direction)};
          const step = ${JSON.stringify(amount)};
          const delta = direction === "down" ? step : step * -1;
          window.scrollBy({ top: delta, behavior: "instant" });
          return window.scrollY;
        })()`
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

    if (action.kind === "probe") {
      const result = await executeProbeAction(page, action);

      return {
        traceOutput: {
          probe: action.probe,
          result: serializeConsoleResult(result),
        },
      };
    }

    if (action.kind === "permission") {
      const result = await executePermissionAction(page, action);

      return {
        traceOutput: result,
      };
    }

    if (action.kind === "storage") {
      const result = await executeStorageAction(page, action);
      return {
        traceOutput: result,
      };
    }

    if (action.kind === "cookie") {
      const result = await executeCookieAction(page, action);
      return {
        traceOutput: result,
      };
    }

    if (action.kind === "eval") {
      const result = await executeEvalAction(page, action);
      return {
        traceOutput: result,
      };
    }

    if (action.kind === "waitFor") {
      const timeoutMs = action.timeoutMs ?? DEFAULT_BROWSER_WAIT_FOR_TIMEOUT_MS;
      const locator = await this.resolveActionTargetLocator(
        page,
        action,
        knownRefs,
        browserSessionId,
        currentTargetId
      );
      await locator.waitFor({ state: "visible", timeout: timeoutMs });

      return {
        traceOutput: {
          ...summarizeActionTarget(action),
          timeoutMs,
          finalUrl: page.url(),
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

    if (action.kind === "cdp") {
      const result = await executeTargetCdpAction(page, action);
      return {
        traceOutput: {
          method: action.method,
          paramsBytes: jsonByteLength(action.params),
          ...summarizeCdpActionOutput(result),
        },
      };
    }

    if (action.kind === "dialog") {
      throw new Error(`${action.kind} actions must be armed by the browser task executor`);
    }

    if (action.kind === "popup") {
      throw new Error(`${action.kind} actions must be armed by the browser task executor`);
    }

    if (action.kind === "network") {
      throw new Error(`${action.kind} actions must be armed by the browser task executor`);
    }

    if (action.kind === "download") {
      throw new Error(`${action.kind} actions must be armed by the browser task executor`);
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
    action: Extract<BrowserTaskAction, { kind: "click" | "type" | "hover" | "select" }>,
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

    if (action.kind === "click" || action.kind === "hover") {
      return resolveTextLocator(page, action.text ?? "");
    }

    throw new Error(`${action.kind} action requires selectors or refId`);
  }

  private async resolveActionTargetLocator(
    page: Page,
    target: { selectors?: string[]; refId?: string; text?: string },
    knownRefs: Map<string, BrowserInteractiveElement>,
    browserSessionId: string,
    currentTargetId?: string
  ): Promise<Locator> {
    if (target.refId) {
      if (knownRefs.has(target.refId)) {
        return resolveRefLocator(page, target.refId);
      }

      if (currentTargetId && this.snapshotRefStore) {
        const resolved = await this.snapshotRefStore.resolve({
          browserSessionId,
          targetId: currentTargetId,
          refId: target.refId,
        });
        if (resolved?.selectors?.length) {
          return resolveLocator(page, resolved.selectors);
        }
        if (resolved?.label) {
          return resolveTextLocator(page, resolved.label);
        }
      }

      throw new Error(`unknown snapshot ref requested: ${target.refId}`);
    }

    if (target.selectors?.length) {
      return resolveLocator(page, target.selectors);
    }

    if (target.text) {
      return resolveTextLocator(page, target.text);
    }

    throw new Error("drag target requires selectors, refId, or text");
  }

  private async resolveUploadArtifact(
    browserSessionId: string,
    artifactId: string
  ): Promise<{ path: string; fileName: string; sizeBytes: number }> {
    if (!this.browserArtifactStore) {
      throw new Error("browser upload action requires an artifact store");
    }
    const record = await this.browserArtifactStore.get(artifactId);
    if (!record) {
      throw new Error(`browser upload artifact not found: ${artifactId}`);
    }
    if (record.browserSessionId !== browserSessionId) {
      throw new Error(`browser upload artifact belongs to a different session: ${artifactId}`);
    }
    assertPathInsideRoot(this.artifactRootDir, record.path, "browser upload artifact");
    const stats = await stat(record.path);
    if (!stats.isFile()) {
      throw new Error(`browser upload artifact is not a file: ${artifactId}`);
    }
    if (stats.size > MAX_BROWSER_UPLOAD_FILE_BYTES) {
      throw new Error(`browser upload artifact exceeds ${MAX_BROWSER_UPLOAD_FILE_BYTES} bytes: ${artifactId}`);
    }
    const metadataFileName = typeof record.metadata?.fileName === "string" ? record.metadata.fileName : "";
    return {
      path: record.path,
      fileName: sanitizeUploadFileName(metadataFileName || path.basename(record.path)),
      sizeBytes: stats.size,
    };
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

function armPageDialogHandler(
  page: Page,
  action: Extract<BrowserTaskAction, { kind: "dialog" }>,
  traceEntry: BrowserActionTrace,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };
    const fail = (error: Error) => {
      traceEntry.completedAt = Date.now();
      traceEntry.status = "failed";
      traceEntry.errorMessage = error.message;
      reject(error);
    };
    const handler = async (dialog: Dialog) => {
      clear();
      try {
        const dialogType = dialog.type();
        const message = dialog.message();
        if (action.action === "accept") {
          await dialog.accept(action.promptText);
        } else {
          await dialog.dismiss();
        }
        traceEntry.completedAt = Date.now();
        traceEntry.output = {
          action: action.action,
          timeoutMs,
          type: dialogType,
          message,
          ...(action.promptText !== undefined ? { promptTextLength: action.promptText.length } : {}),
        };
        resolve();
      } catch (error) {
        fail(error instanceof Error ? error : new Error("browser dialog handler failed"));
      }
    };

    page.once("dialog", handler);
    timeout = setTimeout(() => {
      const off = (page as unknown as { off?: (eventName: string, listener: (dialog: Dialog) => void) => void }).off;
      off?.call(page, "dialog", handler);
      fail(new Error(`browser dialog action timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

async function armPagePopupHandler(
  page: Page,
  _action: Extract<BrowserTaskAction, { kind: "popup" }>,
  traceEntry: BrowserActionTrace,
  timeoutMs: number
): Promise<Page> {
  try {
    const popup = await page.waitForEvent("popup", { timeout: timeoutMs });
    await popup.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    traceEntry.completedAt = Date.now();
    traceEntry.output = {
      timeoutMs,
      finalUrl: popup.url(),
      title: await popup.title().catch(() => ""),
    };
    return popup;
  } catch (error) {
    traceEntry.completedAt = Date.now();
    traceEntry.status = "failed";
    traceEntry.errorMessage = error instanceof Error ? error.message : "browser popup action failed";
    throw error;
  }
}

async function armPageNetworkHandler(
  page: Page,
  action: Extract<BrowserTaskAction, { kind: "network" }>,
  traceEntry: BrowserActionTrace,
  timeoutMs: number
): Promise<void> {
  try {
    const response = await page.waitForResponse((candidate) => matchesNetworkResponse(candidate, action), {
      timeout: timeoutMs,
    });
    traceEntry.completedAt = Date.now();
    traceEntry.output = summarizeNetworkResponse(response, action, timeoutMs);
  } catch (error) {
    traceEntry.completedAt = Date.now();
    traceEntry.status = "failed";
    traceEntry.errorMessage = error instanceof Error ? error.message : "browser network action failed";
    throw error;
  }
}

async function armPageDownloadHandler(
  page: Page,
  action: Extract<BrowserTaskAction, { kind: "download" }>,
  traceEntry: BrowserActionTrace,
  timeoutMs: number,
  options: {
    taskDir: string;
    stepId: string;
    browserSessionId: string;
    targetId?: string;
    browserArtifactStore?: BrowserArtifactStore;
  }
): Promise<LocalDownloadArtifact | null> {
  try {
    const download = await page.waitForEvent("download", {
      predicate: (candidate) => matchesDownload(candidate, action),
      timeout: timeoutMs,
    });
    const fileName = sanitizeUploadFileName(download.suggestedFilename() || "download.bin");
    const downloadsDir = path.join(options.taskDir, "downloads");
    await mkdir(downloadsDir, { recursive: true });
    const filePath = path.join(downloadsDir, `${sanitizeLabel(options.stepId)}-${fileName}`);
    await download.saveAs(filePath);
    const failure = await download.failure().catch(() => null);
    if (failure) {
      throw new Error(`browser download failed: ${failure}`);
    }
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      throw new Error("browser download did not produce a file");
    }
    if (stats.size > MAX_BROWSER_DOWNLOAD_FILE_BYTES) {
      await rm(filePath, { force: true });
      throw new Error(`browser download exceeds ${MAX_BROWSER_DOWNLOAD_FILE_BYTES} bytes`);
    }

    const artifactId = options.browserArtifactStore ? `${options.stepId}:download` : "";
    if (options.browserArtifactStore) {
      await options.browserArtifactStore.put({
        artifactId,
        browserSessionId: options.browserSessionId,
        ...(options.targetId ? { targetId: options.targetId } : {}),
        type: "downloaded-file",
        path: filePath,
        createdAt: Date.now(),
        metadata: {
          url: download.url(),
          fileName,
          sizeBytes: stats.size,
        },
      });
    }

    traceEntry.completedAt = Date.now();
    traceEntry.output = {
      timeoutMs,
      matched: true,
      url: download.url(),
      fileName,
      sizeBytes: stats.size,
      ...(artifactId ? { artifactId } : {}),
    };
    return artifactId
      ? {
          artifactId,
          path: filePath,
          fileName,
          sizeBytes: stats.size,
          url: download.url(),
        }
      : null;
  } catch (error) {
    traceEntry.completedAt = Date.now();
    traceEntry.status = "failed";
    traceEntry.errorMessage = error instanceof Error ? error.message : "browser download action failed";
    throw error;
  }
}

function matchesDownload(download: Download, action: Extract<BrowserTaskAction, { kind: "download" }>): boolean {
  return action.urlPattern ? matchesUrlPattern(download.url(), action.urlPattern) : true;
}

function matchesNetworkResponse(
  response: Response,
  action: Extract<BrowserTaskAction, { kind: "network" }>
): boolean {
  if (action.urlPattern && !matchesUrlPattern(response.url(), action.urlPattern)) {
    return false;
  }
  if (action.status !== undefined && response.status() !== action.status) {
    return false;
  }
  if (action.method && response.request().method() !== action.method) {
    return false;
  }
  return true;
}

function summarizeNetworkResponse(
  response: Response,
  action: Extract<BrowserTaskAction, { kind: "network" }>,
  timeoutMs: number
): Record<string, unknown> {
  return {
    action: action.action,
    matched: true,
    timeoutMs,
    url: response.url(),
    status: response.status(),
    method: response.request().method(),
  };
}

function formatKeyboardShortcut(action: Extract<BrowserTaskAction, { kind: "key" }>): string {
  return [...new Set(action.modifiers ?? []), action.key].join("+");
}

function toPlaywrightSelectOption(
  action: Extract<BrowserTaskAction, { kind: "select" }>
): string | { label: string } | { index: number } {
  if (action.value !== undefined) {
    return action.value;
  }
  if (action.label !== undefined) {
    return { label: action.label };
  }
  return { index: action.index };
}

function summarizeActionTarget(target: { selectors?: string[]; refId?: string; text?: string }): Record<string, unknown> {
  return {
    selectors: target.selectors ?? [],
    refId: target.refId ?? null,
    text: target.text ?? null,
  };
}

async function executeTargetCdpAction(
  page: Page,
  action: Extract<BrowserTaskAction, { kind: "cdp" }>
): Promise<LocalCdpActionOutput> {
  const method = normalizeBrowserCdpMethod(action.method);
  if (!method || isBlockedBrowserCdpMethod(method)) {
    throw new Error(`browser cdp action method is not allowed: ${action.method}`);
  }

  const cdpSession = await page.context().newCDPSession(page);
  const sendRaw = cdpSession.send as unknown as (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<unknown>;
  const eventOptions = normalizeCdpEventOptions(action.events);
  const capturedEvents: LocalCdpEvent[] = [];
  const passiveEventNames = (eventOptions.include ?? []).filter((eventName) => eventName !== eventOptions.waitFor);
  const removeListeners = attachCdpEventListeners(cdpSession, passiveEventNames, capturedEvents);
  const waitForEvent = eventOptions.waitFor
    ? waitForCdpEvent(cdpSession, eventOptions.waitFor, eventOptions.timeoutMs, capturedEvents)
    : null;
  try {
    const result = await withTimeout(
      sendRaw(method, action.params ?? {}),
      normalizeCdpTimeoutMs(action.timeoutMs),
      `browser cdp action timed out: ${method}`
    );
    if (waitForEvent) {
      await waitForEvent;
    }
    return {
      result,
      events: dedupeLocalCdpEvents(capturedEvents, eventOptions.maxEvents),
    };
  } finally {
    removeListeners();
    await cdpSession.detach().catch(() => undefined);
  }
}

async function executeStorageAction(
  page: Page,
  action: Extract<BrowserTaskAction, { kind: "storage" }>
): Promise<Record<string, unknown>> {
  return await page.evaluate(
    ({ area, action: storageAction, key, value, maxEntries, maxValueBytes }) => {
      const storage = area === "localStorage" ? window.localStorage : window.sessionStorage;
      const summarizeValue = (rawValue: string | null) => {
        if (rawValue === null) {
          return {
            found: false,
            value: null,
            valueBytes: 0,
            valueTruncated: false,
          };
        }
        const valueBytes = new TextEncoder().encode(rawValue).length;
        return {
          found: true,
          value: valueBytes <= maxValueBytes ? rawValue : rawValue.slice(0, maxValueBytes),
          valueBytes,
          valueTruncated: valueBytes > maxValueBytes,
        };
      };

      if (storageAction === "set") {
        storage.setItem(key!, value ?? "");
        return {
          area,
          action: storageAction,
          key,
          valueBytes: new TextEncoder().encode(value ?? "").length,
          entryCount: storage.length,
        };
      }
      if (storageAction === "remove") {
        const existed = storage.getItem(key!) !== null;
        storage.removeItem(key!);
        return {
          area,
          action: storageAction,
          key,
          removed: existed,
          entryCount: storage.length,
        };
      }
      if (storageAction === "clear") {
        const clearedCount = storage.length;
        storage.clear();
        return {
          area,
          action: storageAction,
          clearedCount,
          entryCount: storage.length,
        };
      }

      if (key) {
        return {
          area,
          action: storageAction,
          key,
          ...summarizeValue(storage.getItem(key)),
          entryCount: storage.length,
        };
      }

      const entries = Array.from({ length: Math.min(storage.length, maxEntries) }, (_, index) => {
        const entryKey = storage.key(index) ?? "";
        return {
          key: entryKey,
          ...summarizeValue(storage.getItem(entryKey)),
        };
      });
      return {
        area,
        action: storageAction,
        entries,
        entryCount: storage.length,
        entriesTruncated: storage.length > maxEntries,
      };
    },
    {
      area: action.area,
      action: action.action,
      key: "key" in action ? action.key : undefined,
      value: "value" in action ? action.value : undefined,
      maxEntries: MAX_BROWSER_STORAGE_READ_ENTRIES,
      maxValueBytes: MAX_BROWSER_STORAGE_READ_VALUE_BYTES,
    }
  );
}

async function executeCookieAction(
  page: Page,
  action: Extract<BrowserTaskAction, { kind: "cookie" }>
): Promise<Record<string, unknown>> {
  const pageUrl = page.url();
  const actionUrl = "url" in action ? action.url : undefined;
  const resolvedUrl = resolveCookieUrl(actionUrl, pageUrl);
  const cdpSession = await page.context().newCDPSession(page);
  const sendRaw = cdpSession.send as unknown as (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<unknown>;

  try {
    await sendRaw("Network.enable", {});
    if (action.action === "get") {
      const cookies = await readCdpCookies(sendRaw, resolvedUrl);
      const filteredCookies = action.name ? cookies.filter((cookie) => cookie.name === action.name) : cookies;
      return {
        action: action.action,
        name: action.name ?? null,
        url: resolvedUrl ?? null,
        ...summarizeCdpCookies(filteredCookies),
      };
    }

    if (action.action === "set") {
      if (!resolvedUrl && !action.domain) {
        throw new Error("browser cookie set requires an http(s) page URL or explicit domain");
      }
      const params = {
        name: action.name,
        value: action.value,
        ...(resolvedUrl ? { url: resolvedUrl } : {}),
        ...(action.domain ? { domain: action.domain } : {}),
        ...(action.path ? { path: action.path } : {}),
        ...(action.secure !== undefined ? { secure: action.secure } : {}),
        ...(action.httpOnly !== undefined ? { httpOnly: action.httpOnly } : {}),
        ...(action.sameSite ? { sameSite: action.sameSite } : {}),
        ...(action.expires !== undefined ? { expires: action.expires } : {}),
      };
      const result = await sendRaw("Network.setCookie", params);
      if (isCdpSetCookieFailure(result)) {
        throw new Error(`browser cookie set failed: ${action.name}`);
      }
      return {
        action: action.action,
        name: action.name,
        valueBytes: byteLength(action.value),
        url: resolvedUrl ?? null,
        domain: action.domain ?? null,
        path: action.path ?? null,
        set: true,
      };
    }

    if (action.action === "remove") {
      const params = buildCdpDeleteCookieParams(action.name, resolvedUrl, action.domain, action.path);
      await sendRaw("Network.deleteCookies", params);
      return {
        action: action.action,
        name: action.name,
        url: resolvedUrl ?? null,
        domain: action.domain ?? null,
        path: action.path ?? null,
        removed: true,
      };
    }

    const cookies = filterCdpCookiesByScope(await readCdpCookies(sendRaw, resolvedUrl), action.domain, action.path);
    const boundedCookies = cookies.slice(0, MAX_BROWSER_COOKIE_READ_ENTRIES);
    for (const cookie of boundedCookies) {
      if (!cookie.name) {
        continue;
      }
      await sendRaw(
        "Network.deleteCookies",
        buildCdpDeleteCookieParams(cookie.name, resolvedUrl, cookie.domain, cookie.path)
      );
    }
    return {
      action: action.action,
      url: resolvedUrl ?? null,
      domain: action.domain ?? null,
      path: action.path ?? null,
      clearedCount: boundedCookies.length,
      cookieCount: cookies.length,
      cookiesTruncated: cookies.length > MAX_BROWSER_COOKIE_READ_ENTRIES,
    };
  } finally {
    await cdpSession.detach().catch(() => undefined);
  }
}

async function readCdpCookies(
  sendRaw: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  url: string | undefined
): Promise<LocalCdpCookie[]> {
  const response = await sendRaw("Network.getCookies", url ? { urls: [url] } : {});
  if (!isRecord(response) || !Array.isArray(response.cookies)) {
    return [];
  }
  return response.cookies.filter(isRecord).map((cookie) => cookie as LocalCdpCookie);
}

function summarizeCdpCookies(cookies: LocalCdpCookie[]): Record<string, unknown> {
  const boundedCookies = cookies.slice(0, MAX_BROWSER_COOKIE_READ_ENTRIES);
  return {
    cookies: boundedCookies.map((cookie) => ({
      name: cookie.name ?? "",
      domain: cookie.domain ?? "",
      path: cookie.path ?? "",
      secure: cookie.secure ?? false,
      httpOnly: cookie.httpOnly ?? false,
      session: cookie.session ?? false,
      sameSite: cookie.sameSite ?? null,
      expires: typeof cookie.expires === "number" ? cookie.expires : null,
      ...summarizeCookieValue(cookie.value ?? ""),
    })),
    cookieCount: cookies.length,
    cookiesTruncated: cookies.length > MAX_BROWSER_COOKIE_READ_ENTRIES,
  };
}

function summarizeCookieValue(value: string): Record<string, unknown> {
  const valueBytes = byteLength(value);
  return {
    value: valueBytes <= MAX_BROWSER_COOKIE_READ_VALUE_BYTES ? value : value.slice(0, MAX_BROWSER_COOKIE_READ_VALUE_BYTES),
    valueBytes,
    valueTruncated: valueBytes > MAX_BROWSER_COOKIE_READ_VALUE_BYTES,
  };
}

function filterCdpCookiesByScope(
  cookies: LocalCdpCookie[],
  domain: string | undefined,
  path: string | undefined
): LocalCdpCookie[] {
  return cookies.filter((cookie) => {
    if (domain && cookie.domain !== domain) {
      return false;
    }
    if (path && cookie.path !== path) {
      return false;
    }
    return true;
  });
}

function buildCdpDeleteCookieParams(
  name: string,
  url: string | undefined,
  domain: string | undefined,
  path: string | undefined
): Record<string, unknown> {
  if (!url && !domain) {
    throw new Error("browser cookie remove requires an http(s) page URL or explicit domain");
  }
  return {
    name,
    ...(url ? { url } : {}),
    ...(domain ? { domain } : {}),
    ...(path ? { path } : {}),
  };
}

function resolveCookieUrl(actionUrl: string | undefined, pageUrl: string): string | undefined {
  const candidate = actionUrl ?? pageUrl;
  return isHttpUrl(candidate) ? candidate : undefined;
}

function isCdpSetCookieFailure(value: unknown): boolean {
  return isRecord(value) && value.success === false;
}

async function executeEvalAction(
  page: Page,
  action: Extract<BrowserTaskAction, { kind: "eval" }>
): Promise<Record<string, unknown>> {
  const cdpSession = await page.context().newCDPSession(page);
  const sendRaw = cdpSession.send as unknown as (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<unknown>;
  const timeoutMs = normalizeEvalTimeoutMs(action.timeoutMs);

  try {
    const response = await withTimeout(
      sendRaw("Runtime.evaluate", {
        expression: action.expression,
        returnByValue: true,
        awaitPromise: action.awaitPromise ?? true,
      }),
      timeoutMs,
      `browser eval action timed out after ${timeoutMs}ms`
    );
    return summarizeEvalResponse(response, timeoutMs);
  } finally {
    await cdpSession.detach().catch(() => undefined);
  }
}

function summarizeEvalResponse(response: unknown, timeoutMs: number): Record<string, unknown> {
  const responseRecord = isRecord(response) ? response : {};
  if (isRecord(responseRecord.exceptionDetails)) {
    return {
      exception: true,
      timeoutMs,
      text: typeof responseRecord.exceptionDetails.text === "string" ? responseRecord.exceptionDetails.text : null,
    };
  }

  const result = isRecord(responseRecord.result) ? responseRecord.result : {};
  const value = "value" in result ? result.value : result.description ?? null;
  const json = safeStringify(value);
  const resultBytes = byteLength(json);
  return {
    exception: false,
    timeoutMs,
    resultType: typeof result.type === "string" ? result.type : null,
    resultBytes,
    ...(resultBytes <= MAX_BROWSER_EVAL_RESULT_BYTES
      ? { result: parseSafeJson(json) }
      : { resultTruncated: true }),
  };
}

function normalizeEvalTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_BROWSER_EVAL_TIMEOUT_MS)
    : DEFAULT_BROWSER_EVAL_TIMEOUT_MS;
}

function normalizeNetworkTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_BROWSER_NETWORK_TIMEOUT_MS)
    : DEFAULT_BROWSER_NETWORK_TIMEOUT_MS;
}

function normalizeDownloadTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_BROWSER_DOWNLOAD_TIMEOUT_MS)
    : DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS;
}

function normalizeCdpTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_BROWSER_CDP_ACTION_TIMEOUT_MS)
    : MAX_BROWSER_CDP_ACTION_TIMEOUT_MS;
}

function normalizeCdpEventOptions(events: Extract<BrowserTaskAction, { kind: "cdp" }>["events"]): {
  waitFor?: string;
  include?: string[];
  timeoutMs: number;
  maxEvents: number;
} {
  const waitFor = normalizeBrowserCdpMethod(events?.waitFor);
  const include = [...new Set([...(events?.include ?? []), ...(waitFor ? [waitFor] : [])])]
    .map((eventName) => normalizeBrowserCdpMethod(eventName))
    .filter((eventName): eventName is string => Boolean(eventName && !isBlockedBrowserCdpMethod(eventName)));
  const timeoutMs =
    typeof events?.timeoutMs === "number" && Number.isInteger(events.timeoutMs) && events.timeoutMs > 0
      ? Math.min(events.timeoutMs, MAX_BROWSER_CDP_ACTION_EVENT_TIMEOUT_MS)
      : MAX_BROWSER_CDP_ACTION_EVENT_TIMEOUT_MS;
  const maxEvents =
    typeof events?.maxEvents === "number" && Number.isInteger(events.maxEvents) && events.maxEvents > 0
      ? Math.min(events.maxEvents, MAX_BROWSER_CDP_ACTION_EVENTS)
      : MAX_BROWSER_CDP_ACTION_EVENTS;
  return {
    ...(waitFor && !isBlockedBrowserCdpMethod(waitFor) ? { waitFor } : {}),
    ...(include.length ? { include } : {}),
    timeoutMs,
    maxEvents,
  };
}

function attachCdpEventListeners(
  cdpSession: CDPSession,
  eventNames: string[],
  capturedEvents: LocalCdpEvent[]
): () => void {
  const eventSource = cdpSession as unknown as {
    on(eventName: string, listener: (params?: Record<string, unknown>) => void): void;
    off(eventName: string, listener: (params?: Record<string, unknown>) => void): void;
  };
  const listeners = eventNames.map((eventName) => {
    const listener = (params?: Record<string, unknown>) => {
      capturedEvents.push({
        method: eventName,
        ...(params ? { params } : {}),
        timestamp: Date.now(),
      });
    };
    eventSource.on(eventName, listener);
    return { eventName, listener };
  });
  return () => {
    for (const { eventName, listener } of listeners) {
      eventSource.off(eventName, listener);
    }
  };
}

function waitForCdpEvent(
  cdpSession: CDPSession,
  eventName: string,
  timeoutMs: number,
  capturedEvents: LocalCdpEvent[]
): Promise<LocalCdpEvent> {
  const eventSource = cdpSession as unknown as {
    on(eventName: string, listener: (params?: Record<string, unknown>) => void): void;
    off(eventName: string, listener: (params?: Record<string, unknown>) => void): void;
  };
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const listener = (params?: Record<string, unknown>) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      const event: LocalCdpEvent = {
        method: eventName,
        ...(params ? { params } : {}),
        timestamp: Date.now(),
      };
      capturedEvents.push(event);
      eventSource.off(eventName, listener);
      resolve(event);
    };
    timeout = setTimeout(() => {
      eventSource.off(eventName, listener);
      reject(new Error(`browser cdp event timed out after ${timeoutMs}ms: ${eventName}`));
    }, timeoutMs);
    eventSource.on(eventName, listener);
  });
}

function summarizeCdpActionOutput(output: LocalCdpActionOutput): Record<string, unknown> {
  return {
    ...summarizeCdpResult(output.result),
    ...(output.events.length ? { events: summarizeLocalCdpEvents(output.events) } : {}),
  };
}

function summarizeCdpResult(result: unknown): Record<string, unknown> {
  const json = safeStringify(result);
  const resultJsonBytes = byteLength(json);
  if (resultJsonBytes <= MAX_CDP_TRACE_RESULT_BYTES) {
    return { result: parseSafeJson(json) };
  }
  return {
    resultTruncated: true,
    resultJsonBytes,
  };
}

function summarizeLocalCdpEvents(events: LocalCdpEvent[]): Array<Record<string, unknown>> {
  return events.map((event) => {
    const paramsJson = safeStringify(event.params ?? null);
    const paramsBytes = byteLength(paramsJson);
    return {
      method: event.method,
      timestamp: event.timestamp,
      paramsBytes,
      ...(paramsBytes <= MAX_BROWSER_CDP_EVENT_PARAMS_BYTES
        ? { params: parseSafeJson(paramsJson) }
        : { paramsTruncated: true }),
    };
  });
}

function dedupeLocalCdpEvents(events: LocalCdpEvent[], maxEvents: number): LocalCdpEvent[] {
  const seen = new Set<string>();
  const deduped: LocalCdpEvent[] = [];
  for (const event of events) {
    const key = `${event.timestamp}:${event.method}:${safeStringify(event.params ?? null)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }
  return deduped.slice(-maxEvents);
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value ?? null);
    return typeof json === "string" ? json : "null";
  } catch {
    return JSON.stringify(String(value));
  }
}

function parseSafeJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function jsonByteLength(value: unknown): number {
  return value === undefined ? 0 : byteLength(safeStringify(value));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function matchesUrlPattern(url: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return url.includes(pattern);
  }
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(url);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
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

  if (action.kind === "hover") {
    return {
      selectors: action.selectors ?? [],
      refId: action.refId ?? null,
      text: action.text ?? null,
    };
  }

  if (action.kind === "key") {
    return {
      key: action.key,
      modifiers: action.modifiers ?? [],
    };
  }

  if (action.kind === "select") {
    return {
      selectors: action.selectors ?? [],
      refId: action.refId ?? null,
      value: action.value ?? null,
      label: action.label ?? null,
      index: action.index ?? null,
    };
  }

  if (action.kind === "drag") {
    return {
      source: summarizeActionTarget(action.source),
      target: summarizeActionTarget(action.target),
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

  if (action.kind === "probe") {
    return {
      probe: action.probe,
      maxItems: action.maxItems ?? null,
    };
  }

  if (action.kind === "permission") {
    return {
      action: action.action,
      permissions: "permissions" in action ? action.permissions : [],
      origin: "origin" in action ? action.origin ?? null : null,
    };
  }

  if (action.kind === "waitFor") {
    return {
      ...summarizeActionTarget(action),
      timeoutMs: action.timeoutMs ?? null,
    };
  }

  if (action.kind === "wait") {
    return { timeoutMs: action.timeoutMs };
  }

  if (action.kind === "dialog") {
    return {
      action: action.action,
      promptTextLength: action.promptText?.length ?? null,
      timeoutMs: action.timeoutMs ?? null,
    };
  }

  if (action.kind === "popup") {
    return {
      timeoutMs: action.timeoutMs ?? null,
    };
  }

  if (action.kind === "storage") {
    return {
      area: action.area,
      action: action.action,
      key: "key" in action ? action.key : null,
      valueBytes: "value" in action ? byteLength(action.value) : null,
    };
  }

  if (action.kind === "cookie") {
    return {
      action: action.action,
      name: "name" in action ? action.name : null,
      valueBytes: "value" in action ? byteLength(action.value) : null,
      url: "url" in action ? action.url ?? null : null,
      domain: "domain" in action ? action.domain ?? null : null,
      path: "path" in action ? action.path ?? null : null,
    };
  }

  if (action.kind === "eval") {
    return {
      expressionBytes: byteLength(action.expression),
      awaitPromise: action.awaitPromise ?? true,
      timeoutMs: action.timeoutMs ?? null,
    };
  }

  if (action.kind === "network") {
    return {
      action: action.action,
      urlPattern: action.urlPattern ?? null,
      method: action.method ?? null,
      status: action.status ?? null,
      timeoutMs: action.timeoutMs ?? null,
    };
  }

  if (action.kind === "download") {
    return {
      urlPattern: action.urlPattern ?? null,
      timeoutMs: action.timeoutMs ?? null,
    };
  }

  if (action.kind === "upload") {
    return {
      ...summarizeActionTarget(action),
      artifactId: action.artifactId,
    };
  }

  if (action.kind === "cdp") {
    return {
      method: action.method,
      paramsBytes: jsonByteLength(action.params),
      timeoutMs: action.timeoutMs ?? null,
    };
  }

  if (action.kind === "screenshot") {
    return { label: action.label ?? null };
  }

  return { note: action.note ?? null };
}

function sanitizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function sanitizeUploadFileName(value: string): string {
  const fileName = path.basename(value).trim().replace(/[^\w .-]+/g, "-");
  return (fileName || "upload.bin").slice(0, MAX_BROWSER_UPLOAD_FILE_NAME_LENGTH);
}

function assertPathInsideRoot(rootDir: string, candidatePath: string, label: string): void {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`${label} path escapes artifact root`);
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
    result.transportLabel ? `Transport: ${result.transportLabel}.` : result.transportMode ? `Transport: ${result.transportMode}.` : null,
    result.transportTargetId ? `Transport target: ${result.transportTargetId}.` : null,
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
    return page.evaluate(`(() => ({
      title: document.title,
      href: location.href,
      interactiveCount: document.querySelectorAll(
        "a,button,input,textarea,select,[role='button'],[contenteditable='true']"
      ).length,
    }))()`);
  }

  if (probe === "interactive-summary") {
    return page.evaluate(`(() =>
      Array.from(
        document.querySelectorAll("a,button,input,textarea,select,[role='button'],[contenteditable='true']")
      )
        .slice(0, 20)
        .map((element) => {
          const html = element;
          return {
            tagName: html.tagName.toLowerCase(),
            text: html.innerText.trim().slice(0, 120),
            ariaLabel: html.getAttribute("aria-label"),
          };
        })
    )()`);
  }

  throw new Error(`unsupported console probe: ${probe}`);
}

async function executeProbeAction(
  page: Page,
  action: Extract<BrowserTaskAction, { kind: "probe" }>
): Promise<unknown> {
  const probe = JSON.stringify(action.probe);
  const maxItems = JSON.stringify(normalizeProbeMaxItems(action.maxItems));
  return page.evaluate(`(() => {
    const probe = ${probe};
    const itemLimit = Math.max(1, Math.min(${maxItems}, 50));
    const textOf = (element) => [
      element.innerText,
      element.textContent,
      element.getAttribute && element.getAttribute("aria-label"),
      element.getAttribute && element.getAttribute("title")
    ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim().slice(0, 160);
    const cssEscape = (value) =>
      globalThis.CSS && typeof globalThis.CSS.escape === "function"
        ? globalThis.CSS.escape(value)
        : value.replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
    const selectorOf = (element) => {
      if (element.id) return "#" + cssEscape(element.id);
      const name = element.getAttribute && element.getAttribute("name");
      if (name) return element.tagName.toLowerCase() + "[name=" + JSON.stringify(name) + "]";
      return null;
    };

    if (probe === "page-state") {
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        focused: document.hasFocus(),
        activeElement: document.activeElement ? {
          tagName: document.activeElement.tagName.toLowerCase(),
          role: document.activeElement.getAttribute("role"),
          text: textOf(document.activeElement),
          selector: selectorOf(document.activeElement)
        } : null,
        interactiveCount: document.querySelectorAll("a,button,input,textarea,select,[role='button'],[contenteditable='true']").length,
        formControlCount: document.querySelectorAll("input,textarea,select,button").length,
        downloadLinkCount: document.querySelectorAll("a[download]").length
      };
    }

    if (probe === "forms") {
      return Array.from(document.querySelectorAll("input,textarea,select,button")).slice(0, itemLimit).map((element) => ({
        tagName: element.tagName.toLowerCase(),
        type: element.type || (element.getAttribute && element.getAttribute("type")) || null,
        name: element.name || (element.getAttribute && element.getAttribute("name")) || null,
        id: element.id || null,
        placeholder: element.placeholder || (element.getAttribute && element.getAttribute("placeholder")) || null,
        label: textOf(element),
        valueLength: typeof element.value === "string" ? element.value.length : null,
        checked: typeof element.checked === "boolean" ? element.checked : null,
        disabled: Boolean(element.disabled),
        required: Boolean(element.required),
        selector: selectorOf(element)
      }));
    }

    if (probe === "links") {
      return Array.from(document.querySelectorAll("a,button,[role='button']")).slice(0, itemLimit).map((element) => ({
        tagName: element.tagName.toLowerCase(),
        text: textOf(element),
        href: element.href || (element.getAttribute && element.getAttribute("href")) || null,
        target: element.target || (element.getAttribute && element.getAttribute("target")) || null,
        role: element.getAttribute && element.getAttribute("role"),
        disabled: Boolean(element.disabled),
        selector: selectorOf(element)
      }));
    }

    return Array.from(document.querySelectorAll(
      "a[download],a[href$='.csv'],a[href$='.pdf'],a[href$='.zip'],a[href$='.xlsx'],a[href$='.json']"
    )).slice(0, itemLimit).map((element) => ({
      text: textOf(element),
      href: element.href || (element.getAttribute && element.getAttribute("href")) || null,
      download: element.download || (element.getAttribute && element.getAttribute("download")) || null,
      selector: selectorOf(element)
    }));
  })()`);
}

function buildRefMap(interactives: BrowserInteractiveElement[]): Map<string, BrowserInteractiveElement> {
  return new Map(interactives.map((item) => [item.refId, item]));
}

function normalizeProbeMaxItems(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_BROWSER_PROBE_ITEMS)
    : MAX_BROWSER_PROBE_ITEMS;
}

async function executePermissionAction(
  page: Page,
  action: Extract<BrowserTaskAction, { kind: "permission" }>
): Promise<Record<string, unknown>> {
  if (action.action === "reset") {
    await page.context().clearPermissions();
    return {
      action: action.action,
      resetAll: true,
    };
  }

  const permissions = [...new Set(action.permissions)];
  const origin = resolvePermissionOrigin(action.origin, page.url());
  if (action.action === "grant") {
    await page.context().grantPermissions(permissions, { origin });
  } else {
    await setPagePermissionsViaCdp(page, permissions, "denied", origin);
  }

  return {
    action: action.action,
    permissions,
    origin,
  };
}

async function setPagePermissionsViaCdp(
  page: Page,
  permissions: BrowserPermissionName[],
  setting: "denied",
  origin: string
): Promise<void> {
  const cdpSession = await page.context().newCDPSession(page);
  try {
    for (const permission of permissions) {
      await cdpSession.send("Browser.setPermission", {
        permission: toCdpPermissionDescriptor(permission),
        setting,
        origin,
      });
    }
  } finally {
    await cdpSession.detach().catch(() => {});
  }
}

function toCdpPermissionDescriptor(permission: BrowserPermissionName): { name: string; allowWithoutSanitization?: boolean } {
  if (permission === "clipboard-read") {
    return { name: "clipboardReadWrite", allowWithoutSanitization: true };
  }
  if (permission === "clipboard-write") {
    return { name: "clipboardSanitizedWrite" };
  }
  return { name: permission };
}

function resolvePermissionOrigin(origin: string | undefined, currentUrl: string): string {
  const candidate = origin ?? currentUrl;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("not http");
    }
    const resolved = parsed.origin;
    if (resolved.length > MAX_BROWSER_PERMISSION_ORIGIN_LENGTH) {
      throw new Error("too long");
    }
    return resolved;
  } catch {
    throw new Error("browser permission action requires an explicit http(s) origin or current page URL");
  }
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
