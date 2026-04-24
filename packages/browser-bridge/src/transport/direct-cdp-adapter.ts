import path from "node:path";

import type {
  BrowserContext,
  Browser,
  CDPSession,
} from "playwright-core";
import { chromium } from "playwright-core";

import type {
  BrowserExpertAttachedSession,
  BrowserExpertCommandResult,
  BrowserExpertEvent,
  BrowserExpertTargetInfo,
  BrowserPageResult,
  BrowserRawCdpExpertLane,
  BrowserSession,
  BrowserSessionHistoryEntry,
  BrowserSessionResumeInput,
  BrowserSessionSendInput,
  BrowserSessionSpawnInput,
  BrowserTarget,
  BrowserTaskRequest,
  BrowserTaskResult,
} from "@turnkeyai/core-types/team";

import { FileBrowserArtifactStore } from "../artifacts/file-browser-artifact-store";
import { ChromeSessionManager } from "../chrome-session-manager";
import { FileSnapshotRefStore } from "../refs/file-snapshot-ref-store";
import { BrowserSessionManager } from "../session/browser-session-manager";
import { FileBrowserSessionHistoryStore } from "../session/file-browser-session-history-store";
import { FileBrowserProfileStore } from "../session/file-browser-profile-store";
import { FileBrowserSessionStore } from "../session/file-browser-session-store";
import { FileBrowserTargetStore } from "../session/file-browser-target-store";
import type {
  BrowserBridgeFactoryOptions,
  BrowserTransportAdapter,
} from "./transport-adapter";

const ROOT_EXPERT_SESSION_ID = "__root__";
const MAX_EXPERT_EVENT_QUEUE = 200;

interface ExpertAttachedSessionRecord extends BrowserExpertAttachedSession {
  detached: boolean;
}

export class DirectCdpBrowserAdapter implements BrowserTransportAdapter {
  readonly transportMode = "direct-cdp" as const;
  readonly transportLabel = "direct-cdp";

  private readonly endpoint: string;
  private readonly sessionManager: ChromeSessionManager;
  private readonly connectBrowser: (endpoint: string) => Promise<Browser>;
  private browserPromise: Promise<Browser> | null = null;
  private rootCdpSessionPromise: Promise<CDPSession> | null = null;
  private readonly expertAttachedSessions = new Map<string, ExpertAttachedSessionRecord>();
  private readonly expertEventQueues = new Map<string, BrowserExpertEvent[]>();
  private readonly expertPending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
      expertSessionId: string;
    }
  >();
  private expertMessageCounter = 0;

  constructor(
    options: BrowserBridgeFactoryOptions,
    deps: {
      connectBrowser?: (endpoint: string) => Promise<Browser>;
    } = {}
  ) {
    this.endpoint = options.directCdp?.endpoint?.trim() || process.env.TURNKEYAI_BROWSER_CDP_ENDPOINT?.trim() || "";
    if (!this.endpoint) {
      throw new Error("direct-cdp browser transport requires TURNKEYAI_BROWSER_CDP_ENDPOINT or directCdp.endpoint");
    }

    const stateRootDir = options.stateRootDir ?? path.join(options.artifactRootDir, "_state");
    const browserSessionManager = new BrowserSessionManager({
      browserProfileStore: new FileBrowserProfileStore({
        rootDir: path.join(stateRootDir, "profiles"),
      }),
      browserSessionStore: new FileBrowserSessionStore({
        rootDir: path.join(stateRootDir, "sessions"),
      }),
      browserTargetStore: new FileBrowserTargetStore({
        rootDir: path.join(stateRootDir, "targets"),
      }),
      profileRootDir: path.join(stateRootDir, "profiles"),
    });

    this.connectBrowser = deps.connectBrowser ?? ((endpoint: string) => chromium.connectOverCDP(endpoint));

    this.sessionManager = new ChromeSessionManager({
      artifactRootDir: options.artifactRootDir,
      transportMode: this.transportMode,
      transportLabel: this.transportLabel,
      browserSessionManager,
      browserSessionHistoryStore: new FileBrowserSessionHistoryStore({
        rootDir: path.join(stateRootDir, "history"),
      }),
      snapshotRefStore: new FileSnapshotRefStore({
        rootDir: path.join(stateRootDir, "refs"),
      }),
      browserArtifactStore: new FileBrowserArtifactStore({
        rootDir: path.join(stateRootDir, "artifacts"),
      }),
      createEphemeralContext: async () => {
        const browser = await this.getOrConnectBrowser();
        return this.createConnectedContext(browser);
      },
      launchPersistentContext: async () => {
        const browser = await this.getOrConnectBrowser();
        return this.createConnectedContext(browser);
      },
    });
  }

  getRawCdpExpertLane(): BrowserRawCdpExpertLane {
    return {
      listExpertTargets: (browserSessionId) => this.listExpertTargets(browserSessionId),
      attachExpertTarget: (input) => this.attachExpertTarget(input),
      detachExpertSession: (input) => this.detachExpertSession(input),
      sendExpertCommand: (input) => this.sendExpertCommand(input),
      drainExpertEvents: (input) => this.drainExpertEvents(input),
    };
  }

  async inspectPublicPage(url: string): Promise<BrowserPageResult> {
    const inspectId = `inspect-${Date.now()}`;
    const result = await this.runTask({
      taskId: inspectId,
      threadId: inspectId,
      instructions: `Inspect ${url}`,
      actions: [
        { kind: "open", url },
        { kind: "snapshot", note: "inspect" },
      ],
    });
    await this.closeSession(result.sessionId, "inspect complete");

    return result.page;
  }

  async runTask(input: BrowserTaskRequest): Promise<BrowserTaskResult> {
    return this.sessionManager.runTask(input);
  }

  async spawnSession(input: BrowserSessionSpawnInput): Promise<BrowserTaskResult> {
    return this.sessionManager.spawnSession(input);
  }

  async sendSession(input: BrowserSessionSendInput): Promise<BrowserTaskResult> {
    return this.sessionManager.sendSession(input);
  }

  async resumeSession(input: BrowserSessionResumeInput): Promise<BrowserTaskResult> {
    return this.sessionManager.resumeSession(input);
  }

  async getSessionHistory(input: { browserSessionId: string; limit?: number }): Promise<BrowserSessionHistoryEntry[]> {
    return this.sessionManager.getSessionHistory(input);
  }

  async listSessions(input?: { ownerType?: BrowserSession["ownerType"]; ownerId?: string }): Promise<BrowserSession[]> {
    return this.sessionManager.listSessions(input);
  }

  async listTargets(browserSessionId: string): Promise<BrowserTarget[]> {
    return this.sessionManager.listTargets(browserSessionId);
  }

  async openTarget(
    browserSessionId: string,
    url: string,
    owner?: { ownerType?: BrowserSession["ownerType"]; ownerId?: string }
  ): Promise<BrowserTarget> {
    return this.sessionManager.openTarget(browserSessionId, url, owner);
  }

  async activateTarget(
    browserSessionId: string,
    targetId: string,
    owner?: { ownerType?: BrowserSession["ownerType"]; ownerId?: string }
  ): Promise<BrowserTarget> {
    return this.sessionManager.activateTarget(browserSessionId, targetId, owner);
  }

  async closeTarget(
    browserSessionId: string,
    targetId: string,
    owner?: { ownerType?: BrowserSession["ownerType"]; ownerId?: string }
  ): Promise<BrowserTarget> {
    return this.sessionManager.closeTarget(browserSessionId, targetId, owner);
  }

  async evictIdleSessions(input: { idleBefore: number; reason?: string }): Promise<BrowserSession[]> {
    return this.sessionManager.evictIdleSessions(input);
  }

  async closeSession(browserSessionId: string, reason = "client requested"): Promise<void> {
    await this.sessionManager.closeSession(browserSessionId, reason);
  }

  async listExpertTargets(browserSessionId: string): Promise<BrowserExpertTargetInfo[]> {
    const [rootSession, sessionTargets] = await Promise.all([
      this.getOrCreateRootCdpSession(),
      this.sessionManager.listTargets(browserSessionId),
    ]);
    const targetResponse = await rootSession.send("Target.getTargets");
    const matchingTargetIdsByUrl = new Map<string, string[]>();
    for (const target of sessionTargets) {
      const normalizedUrl = target.url.trim();
      if (!normalizedUrl) {
        continue;
      }
      const matches = matchingTargetIdsByUrl.get(normalizedUrl) ?? [];
      matches.push(target.targetId);
      matchingTargetIdsByUrl.set(normalizedUrl, matches);
    }
    const targetInfos = Array.isArray(targetResponse?.targetInfos) ? targetResponse.targetInfos : [];
    return targetInfos.map((targetInfo) => {
      const url = typeof targetInfo?.url === "string" ? targetInfo.url : undefined;
      const matches = url ? matchingTargetIdsByUrl.get(url) : undefined;
      return {
        targetId: String(targetInfo?.targetId ?? ""),
        type: String(targetInfo?.type ?? "unknown"),
        ...(typeof targetInfo?.title === "string" && targetInfo.title.length > 0 ? { title: targetInfo.title } : {}),
        ...(url ? { url } : {}),
        attached: Boolean(targetInfo?.attached),
        ...(typeof targetInfo?.openerId === "string" && targetInfo.openerId.length > 0 ? { openerId: targetInfo.openerId } : {}),
        ...(typeof targetInfo?.openerFrameId === "string" && targetInfo.openerFrameId.length > 0
          ? { openerFrameId: targetInfo.openerFrameId }
          : {}),
        ...(typeof targetInfo?.browserContextId === "string" && targetInfo.browserContextId.length > 0
          ? { browserContextId: targetInfo.browserContextId }
          : {}),
        ...(typeof targetInfo?.subtype === "string" && targetInfo.subtype.length > 0 ? { subtype: targetInfo.subtype } : {}),
        ...(matches?.length ? { matchingBrowserTargetIds: matches } : {}),
      };
    });
  }

  async attachExpertTarget(input: {
    browserSessionId: string;
    targetId: string;
  }): Promise<BrowserExpertAttachedSession> {
    const existing = Array.from(this.expertAttachedSessions.values()).find(
      (record) =>
        !record.detached &&
        record.browserSessionId === input.browserSessionId &&
        record.targetId === input.targetId
    );
    if (existing) {
      return {
        expertSessionId: existing.expertSessionId,
        browserSessionId: existing.browserSessionId,
        targetId: existing.targetId,
        attachedAt: existing.attachedAt,
      };
    }

    const rootSession = await this.getOrCreateRootCdpSession();
    const attached = await rootSession.send("Target.attachToTarget", {
      targetId: input.targetId,
      flatten: false,
    });
    const expertSessionId =
      typeof attached?.sessionId === "string" && attached.sessionId.trim().length > 0 ? attached.sessionId.trim() : null;
    if (!expertSessionId) {
      throw new Error("Target.attachToTarget did not return a sessionId");
    }
    const record: ExpertAttachedSessionRecord = {
      expertSessionId,
      browserSessionId: input.browserSessionId,
      targetId: input.targetId,
      attachedAt: Date.now(),
      detached: false,
    };
    this.expertAttachedSessions.set(expertSessionId, record);
    return {
      expertSessionId: record.expertSessionId,
      browserSessionId: record.browserSessionId,
      targetId: record.targetId,
      attachedAt: record.attachedAt,
    };
  }

  async detachExpertSession(input: {
    browserSessionId: string;
    expertSessionId: string;
  }): Promise<{
    browserSessionId: string;
    expertSessionId: string;
    targetId: string;
    detached: boolean;
  }> {
    const record = this.requireExpertSession(input.browserSessionId, input.expertSessionId);
    if (!record.detached) {
      const rootSession = await this.getOrCreateRootCdpSession();
      await rootSession.send("Target.detachFromTarget", {
        sessionId: record.expertSessionId,
      });
      record.detached = true;
    }
    this.expertAttachedSessions.delete(record.expertSessionId);
    this.expertEventQueues.delete(record.expertSessionId);
    return {
      browserSessionId: record.browserSessionId,
      expertSessionId: record.expertSessionId,
      targetId: record.targetId,
      detached: true,
    };
  }

  async sendExpertCommand(input: {
    browserSessionId: string;
    method: string;
    params?: Record<string, unknown>;
    expertSessionId?: string;
    targetId?: string;
    timeoutMs?: number;
  }): Promise<BrowserExpertCommandResult> {
    const rootSession = await this.getOrCreateRootCdpSession();
    if (input.expertSessionId) {
      const record = this.requireExpertSession(input.browserSessionId, input.expertSessionId);
      return {
        method: input.method,
        scope: "attached",
        expertSessionId: record.expertSessionId,
        targetId: record.targetId,
        result: await this.sendAttachedCommand({
          rootSession,
          expertSessionId: record.expertSessionId,
          method: input.method,
          ...(input.params ? { params: input.params } : {}),
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        }),
      };
    }

    if (input.targetId) {
      const existing = Array.from(this.expertAttachedSessions.values()).find(
        (record) =>
          !record.detached &&
          record.browserSessionId === input.browserSessionId &&
          record.targetId === input.targetId
      );
      const attached = await this.attachExpertTarget({
        browserSessionId: input.browserSessionId,
        targetId: input.targetId,
      });
      const reused = Boolean(existing);
      try {
        return {
          method: input.method,
          scope: "attached",
          expertSessionId: attached.expertSessionId,
          targetId: attached.targetId,
          result: await this.sendAttachedCommand({
            rootSession,
            expertSessionId: attached.expertSessionId,
            method: input.method,
            ...(input.params ? { params: input.params } : {}),
            ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
          }),
        };
      } finally {
        if (!reused) {
          this.expertAttachedSessions.delete(attached.expertSessionId);
          this.expertEventQueues.delete(attached.expertSessionId);
          await rootSession.send("Target.detachFromTarget", {
            sessionId: attached.expertSessionId,
          }).catch(() => undefined);
        }
      }
    }

    return {
      method: input.method,
      scope: "root",
      result: await this.sendRootCommand(rootSession, input.method, input.params ?? {}),
    };
  }

  async drainExpertEvents(input: {
    browserSessionId: string;
    expertSessionId?: string;
    limit?: number;
  }): Promise<BrowserExpertEvent[]> {
    if (input.expertSessionId) {
      this.requireExpertSession(input.browserSessionId, input.expertSessionId);
    }
    const queueId = input.expertSessionId ?? ROOT_EXPERT_SESSION_ID;
    const queue = this.expertEventQueues.get(queueId) ?? [];
    const limit = Math.max(1, input.limit ?? 100);
    const drained = queue.splice(0, limit);
    if (queue.length === 0) {
      this.expertEventQueues.delete(queueId);
    } else {
      this.expertEventQueues.set(queueId, queue);
    }
    return drained;
  }

  private async getOrConnectBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = this.connectBrowser(this.endpoint)
        .then((browser) => {
          browser.on("disconnected", () => {
            this.browserPromise = null;
            this.rootCdpSessionPromise = null;
            this.clearExpertState(new Error("browser disconnected"));
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

  private async getOrCreateRootCdpSession(): Promise<CDPSession> {
    if (!this.rootCdpSessionPromise) {
      this.rootCdpSessionPromise = this.getOrConnectBrowser()
        .then(async (browser) => {
          const rootSession = await browser.newBrowserCDPSession();
          rootSession.on("Target.receivedMessageFromTarget", (event) => {
            this.handleTargetMessageEvent(event);
          });
          for (const eventName of [
            "Target.attachedToTarget",
            "Target.detachedFromTarget",
            "Target.targetCreated",
            "Target.targetDestroyed",
            "Target.targetInfoChanged",
          ]) {
            (rootSession as unknown as EventTargetLike).on(eventName, (params: unknown) => {
              this.pushExpertEvent(ROOT_EXPERT_SESSION_ID, {
                method: eventName,
                ...(isRecord(params) ? { params } : {}),
              });
              if (eventName === "Target.detachedFromTarget" && isRecord(params) && typeof params.sessionId === "string") {
                this.onExpertSessionDetached(params.sessionId);
              }
            });
          }
          return rootSession;
        })
        .catch((error) => {
          this.rootCdpSessionPromise = null;
          throw error;
        });
    }
    return this.rootCdpSessionPromise;
  }

  private async sendAttachedCommand(input: {
    rootSession: CDPSession;
    expertSessionId: string;
    method: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<unknown> {
    const requestId = ++this.expertMessageCounter;
    const pendingKey = `${input.expertSessionId}:${requestId}`;
    const timeoutMs = input.timeoutMs ?? 30_000;
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.expertPending.delete(pendingKey);
        reject(new Error(`expert CDP command timed out: ${input.method}`));
      }, timeoutMs);
      this.expertPending.set(pendingKey, {
        resolve,
        reject,
        timeout,
        expertSessionId: input.expertSessionId,
      });
      input.rootSession
        .send("Target.sendMessageToTarget", {
          sessionId: input.expertSessionId,
          message: JSON.stringify({
            id: requestId,
            method: input.method,
            params: input.params ?? {},
          }),
        })
        .catch((error) => {
          clearTimeout(timeout);
          this.expertPending.delete(pendingKey);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private async sendRootCommand(rootSession: CDPSession, method: string, params: Record<string, unknown>): Promise<unknown> {
    return await (rootSession as unknown as { send(method: string, params: Record<string, unknown>): Promise<unknown> }).send(
      method,
      params
    );
  }

  private handleTargetMessageEvent(event: unknown): void {
    if (!isRecord(event) || typeof event.sessionId !== "string" || typeof event.message !== "string") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.message);
    } catch {
      this.pushExpertEvent(event.sessionId, {
        method: "Target.receivedMessageFromTarget",
        params: {
          rawMessage: event.message,
        },
      });
      return;
    }

    if (isRecord(parsed) && typeof parsed.id === "number") {
      const pendingKey = `${event.sessionId}:${parsed.id}`;
      const pending = this.expertPending.get(pendingKey);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.expertPending.delete(pendingKey);
      if (isRecord(parsed.error)) {
        const message = typeof parsed.error.message === "string" ? parsed.error.message : JSON.stringify(parsed.error);
        pending.reject(new Error(message));
        return;
      }
      pending.resolve(isRecord(parsed) ? parsed.result : undefined);
      return;
    }

    if (isRecord(parsed) && typeof parsed.method === "string") {
      this.pushExpertEvent(event.sessionId, {
        expertSessionId: event.sessionId,
        method: parsed.method,
        ...(isRecord(parsed.params) ? { params: parsed.params } : {}),
      });
    }
  }

  private requireExpertSession(browserSessionId: string, expertSessionId: string): ExpertAttachedSessionRecord {
    const record = this.expertAttachedSessions.get(expertSessionId) ?? null;
    if (!record || record.detached) {
      throw new Error("expert session not found");
    }
    if (record.browserSessionId !== browserSessionId) {
      throw new Error("expert session does not belong to browser session");
    }
    return record;
  }

  private onExpertSessionDetached(expertSessionId: string): void {
    const record = this.expertAttachedSessions.get(expertSessionId);
    if (record) {
      record.detached = true;
      this.expertAttachedSessions.delete(expertSessionId);
    }
    this.expertEventQueues.delete(expertSessionId);
    for (const [pendingKey, pending] of this.expertPending.entries()) {
      if (pending.expertSessionId !== expertSessionId) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.expertPending.delete(pendingKey);
      pending.reject(new Error("expert session detached"));
    }
  }

  private pushExpertEvent(queueId: string, event: Omit<BrowserExpertEvent, "receivedAt">): void {
    if (queueId !== ROOT_EXPERT_SESSION_ID && !this.expertAttachedSessions.has(queueId)) {
      return;
    }
    const queue = this.expertEventQueues.get(queueId) ?? [];
    queue.push({
      ...event,
      receivedAt: Date.now(),
    });
    if (queue.length > MAX_EXPERT_EVENT_QUEUE) {
      queue.splice(0, queue.length - MAX_EXPERT_EVENT_QUEUE);
    }
    this.expertEventQueues.set(queueId, queue);
  }

  private clearExpertState(error: Error): void {
    for (const pending of this.expertPending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.expertPending.clear();
    this.expertAttachedSessions.clear();
    this.expertEventQueues.clear();
  }

  private async createConnectedContext(browser: Browser): Promise<BrowserContext> {
    const existing = browser.contexts()[0];
    if (existing && browser.contexts().length === 1) {
      return existing;
    }
    return browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 960 },
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface EventTargetLike {
  on(eventName: string, listener: (payload: unknown) => void): unknown;
}
