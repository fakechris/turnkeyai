import { mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  BrowserActionTrace,
  BrowserArtifactRecord,
  BrowserPageResult,
  BrowserSessionDispatchMode,
  BrowserSessionHistoryEntry,
  BrowserSessionResumeInput,
  BrowserSession,
  BrowserSessionSendInput,
  BrowserSessionSpawnInput,
  BrowserSnapshotResult,
  BrowserTarget,
  BrowserTaskAction,
  BrowserTaskRequest,
  BrowserTaskResult,
  SnapshotRefEntry,
} from "@turnkeyai/core-types/team";

import { FileBrowserArtifactStore } from "../artifacts/file-browser-artifact-store";
import { FileSnapshotRefStore } from "../refs/file-snapshot-ref-store";
import { BrowserSessionManager } from "../session/browser-session-manager";
import { FileBrowserSessionHistoryStore } from "../session/file-browser-session-history-store";
import { FileBrowserProfileStore } from "../session/file-browser-profile-store";
import { FileBrowserSessionStore } from "../session/file-browser-session-store";
import { FileBrowserTargetStore } from "../session/file-browser-target-store";
import { RelayGateway, isRelayExecutableAction } from "./relay-gateway";
import type { RelayActionRequest, RelayActionResult } from "./relay-protocol";
import type { BrowserTransportAdapter, BrowserTransportFactoryOptions, RelayControlPlane, RelayTransportOptions } from "./transport-adapter";

export class RelayBrowserAdapter implements BrowserTransportAdapter {
  readonly transportMode = "relay" as const;
  readonly transportLabel = "chrome-relay";

  private readonly sessionManager: BrowserSessionManager;
  private readonly historyStore: FileBrowserSessionHistoryStore;
  private readonly snapshotRefStore: FileSnapshotRefStore;
  private readonly artifactStore: FileBrowserArtifactStore;
  private readonly gateway: RelayGateway;
  private readonly artifactRootDir: string;
  private readonly preferredPeerId: string | null;
  private readonly createId: (prefix: string) => string;

  constructor(
    private readonly options: BrowserTransportFactoryOptions & {
      relay?: RelayTransportOptions;
    }
  ) {
    const stateRootDir = options.stateRootDir ?? path.join(options.artifactRootDir, "_state");
    mkdirSync(options.artifactRootDir, { recursive: true });
    mkdirSync(stateRootDir, { recursive: true });
    mkdirSync(path.join(stateRootDir, "profiles"), { recursive: true });
    mkdirSync(path.join(stateRootDir, "sessions"), { recursive: true });
    mkdirSync(path.join(stateRootDir, "targets"), { recursive: true });
    mkdirSync(path.join(stateRootDir, "history"), { recursive: true });
    mkdirSync(path.join(stateRootDir, "refs"), { recursive: true });
    mkdirSync(path.join(stateRootDir, "artifacts"), { recursive: true });
    this.artifactRootDir = options.artifactRootDir;
    this.preferredPeerId = options.relay?.relayPeerId?.trim() || null;
    this.createId = (prefix) => `${prefix}-${Date.now()}`;
    this.sessionManager = new BrowserSessionManager({
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
    this.historyStore = new FileBrowserSessionHistoryStore({
      rootDir: path.join(stateRootDir, "history"),
    });
    this.snapshotRefStore = new FileSnapshotRefStore({
      rootDir: path.join(stateRootDir, "refs"),
    });
    this.artifactStore = new FileBrowserArtifactStore({
      rootDir: path.join(stateRootDir, "artifacts"),
    });
    this.gateway = new RelayGateway();
  }

  getRelayControlPlane(): RelayControlPlane {
    return this.gateway;
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
    return input.browserSessionId
      ? this.sendSession({ ...input, browserSessionId: input.browserSessionId })
      : this.spawnSession(input);
  }

  async spawnSession(input: BrowserSessionSpawnInput): Promise<BrowserTaskResult> {
    return this.executeTask("spawn", input);
  }

  async sendSession(input: BrowserSessionSendInput): Promise<BrowserTaskResult> {
    return this.executeTask("send", input);
  }

  async resumeSession(input: BrowserSessionResumeInput): Promise<BrowserTaskResult> {
    return this.executeTask("resume", input);
  }

  async getSessionHistory(input: { browserSessionId: string; limit?: number }): Promise<BrowserSessionHistoryEntry[]> {
    return this.historyStore.listBySession(input.browserSessionId, input.limit);
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
    const result = await this.sendSession({
      taskId: this.createId("browser-open-target"),
      threadId: owner?.ownerId ?? browserSessionId,
      instructions: `Open ${url}`,
      actions: [
        { kind: "open", url },
        { kind: "snapshot", note: "open-target" },
      ],
      browserSessionId,
      ...(owner?.ownerType ? { ownerType: owner.ownerType } : {}),
      ...(owner?.ownerId ? { ownerId: owner.ownerId } : {}),
    });
    return this.requireTarget(result.sessionId, result.targetId);
  }

  async activateTarget(
    browserSessionId: string,
    targetId: string,
    owner?: { ownerType?: BrowserSession["ownerType"]; ownerId?: string }
  ): Promise<BrowserTarget> {
    const lease = await this.sessionManager.resumeSession({
      browserSessionId,
      ...(owner?.ownerType ? { ownerType: owner.ownerType } : {}),
      ...(owner?.ownerId ? { ownerId: owner.ownerId } : {}),
    });
    try {
      return await this.sessionManager.activateTarget(browserSessionId, targetId);
    } finally {
      await this.sessionManager.releaseSession({ browserSessionId: lease.session.browserSessionId });
    }
  }

  async closeTarget(
    browserSessionId: string,
    targetId: string,
    owner?: { ownerType?: BrowserSession["ownerType"]; ownerId?: string }
  ): Promise<BrowserTarget> {
    const lease = await this.sessionManager.resumeSession({
      browserSessionId,
      ...(owner?.ownerType ? { ownerType: owner.ownerType } : {}),
      ...(owner?.ownerId ? { ownerId: owner.ownerId } : {}),
    });
    try {
      return await this.sessionManager.closeTarget(browserSessionId, targetId);
    } finally {
      await this.sessionManager.releaseSession({ browserSessionId: lease.session.browserSessionId });
    }
  }

  async evictIdleSessions(input: { idleBefore: number; reason?: string }): Promise<BrowserSession[]> {
    const sessions = await this.sessionManager.listSessions();
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

  async closeSession(browserSessionId: string, reason = "client requested"): Promise<void> {
    await this.sessionManager.closeSession(browserSessionId, reason);
  }

  private async executeTask(
    dispatchMode: BrowserSessionDispatchMode,
    task: BrowserTaskRequest
  ): Promise<BrowserTaskResult> {
    const supportedActions = task.actions.filter(isRelayExecutableAction);
    if (supportedActions.length !== task.actions.length) {
      const unsupported = task.actions
        .filter((action) => !isRelayExecutableAction(action))
        .map((action) => action.kind)
        .join(", ");
      throw new Error(`relay browser transport does not support action kinds yet: ${unsupported}`);
    }
    let relayActions = supportedActions;

    const lease = task.browserSessionId
      ? await this.sessionManager.resumeSession({
          browserSessionId: task.browserSessionId,
          ownerType: task.ownerType ?? "thread",
          ownerId: task.ownerId ?? task.threadId,
          ...(task.leaseHolderRunKey ? { leaseHolderRunKey: task.leaseHolderRunKey } : {}),
          ...(task.leaseTtlMs !== undefined ? { leaseTtlMs: task.leaseTtlMs } : {}),
        })
      : await this.sessionManager.acquireSession({
          ownerType: task.ownerType ?? "thread",
          ownerId: task.ownerId ?? task.threadId,
          profileOwnerType: task.profileOwnerType ?? task.ownerType ?? "thread",
          profileOwnerId: task.profileOwnerId ?? task.ownerId ?? task.threadId,
          preferredTransport: "relay",
          reusable: true,
          ...(task.leaseHolderRunKey ? { leaseHolderRunKey: task.leaseHolderRunKey } : {}),
          ...(task.leaseTtlMs !== undefined ? { leaseTtlMs: task.leaseTtlMs } : {}),
        });

    const sessionId = lease.session.browserSessionId;
    const startedAt = Date.now();
    let currentTargetId = task.targetId ?? lease.session.activeTargetId;
    let currentTarget = currentTargetId ? await this.findTarget(sessionId, currentTargetId) : null;
    let resumeMode: NonNullable<BrowserTaskResult["resumeMode"]> = "cold";
    let targetResolution: NonNullable<BrowserTaskResult["targetResolution"]> = "new_target";

    try {
      if (!currentTarget && relayActions[0]?.kind !== "open") {
        currentTarget = await this.attachDiscoveredTarget(sessionId, relayActions);
        currentTargetId = currentTarget.targetId;
        resumeMode = "hot";
        targetResolution = "attach";
      } else if (currentTarget?.transportSessionId) {
        if (this.hasKnownRelayTarget(currentTarget.transportSessionId)) {
          resumeMode = dispatchMode === "spawn" ? "warm" : "hot";
          targetResolution = dispatchMode === "spawn" ? "reconnect" : "attach";
        } else {
          const reconnectUrl = currentTarget.url?.trim() || "";
          currentTarget = await this.attachDiscoveredTarget(sessionId, relayActions);
          currentTargetId = currentTarget.targetId;
          if (reconnectUrl && relayActions[0]?.kind !== "open") {
            relayActions = [{ kind: "open", url: reconnectUrl }, ...relayActions];
          }
          resumeMode = "warm";
          targetResolution = "reconnect";
        }
      }

      const peerId = this.resolvePeerId(relayActions, currentTarget?.transportSessionId);
      const relayResult = await this.gateway.dispatchActionRequest({
        peerId,
        browserSessionId: sessionId,
        taskId: task.taskId,
        ...(currentTarget?.transportSessionId ? { relayTargetId: currentTarget.transportSessionId } : {}),
        ...(currentTargetId ? { targetId: currentTargetId } : {}),
        actions: relayActions,
      });

      if (relayResult.status === "failed") {
        throw new Error(relayResult.errorMessage ?? "relay action execution failed");
      }
      if (!relayResult.page) {
        throw new Error(`relay action result missing page snapshot: ${relayResult.actionRequestId}`);
      }

      const target = await this.sessionManager.ensureTarget({
        browserSessionId: sessionId,
        ...(currentTargetId ? { targetId: currentTargetId } : {}),
        transportSessionId: relayResult.relayTargetId,
        url: relayResult.url,
        ...(relayResult.title ? { title: relayResult.title } : {}),
        status: "attached",
        lastResumeMode: resumeMode,
        createIfMissing: true,
      });
      currentTargetId = target.targetId;
      currentTarget = target;

      const artifactIds = [...relayResult.artifactIds];
      const persistedScreenshots = await this.persistScreenshotArtifacts({
        task,
        sessionId,
        targetId: target.targetId,
        screenshotPayloads: relayResult.screenshotPayloads ?? [],
      });
      artifactIds.push(...persistedScreenshots.artifactIds);
      const persistedSnapshotArtifactId = await this.persistSnapshotArtifact({
        task,
        sessionId,
        targetId: target.targetId,
        page: relayResult.page,
      });
      if (persistedSnapshotArtifactId) {
        artifactIds.push(persistedSnapshotArtifactId);
      }

      const result: BrowserTaskResult = {
        sessionId,
        targetId: target.targetId,
        transportMode: this.transportMode,
        transportLabel: this.transportLabel,
        transportPeerId: peerId,
        transportTargetId: relayResult.relayTargetId,
        dispatchMode,
        resumeMode,
        targetResolution,
        page: relayResult.page,
        screenshotPaths: [...relayResult.screenshotPaths, ...persistedScreenshots.screenshotPaths],
        trace: relayResult.trace,
        artifactIds,
      };
      const historyEntryId = await this.appendHistoryEntry({
        dispatchMode,
        task: relayActions === task.actions ? task : { ...task, actions: relayActions },
        sessionId,
        startedAt,
        result,
        ownerType: lease.session.ownerType,
        ownerId: lease.session.ownerId,
      }).catch(() => undefined);
      return historyEntryId ? { ...result, historyEntryId } : result;
    } catch (error) {
      await this.appendHistoryEntry({
        dispatchMode,
        task: relayActions === task.actions ? task : { ...task, actions: relayActions },
        sessionId,
        startedAt,
        error,
        ownerType: lease.session.ownerType,
        ownerId: lease.session.ownerId,
      }).catch(() => undefined);
      throw error;
    } finally {
      await this.sessionManager.releaseSession({
        browserSessionId: lease.session.browserSessionId,
        ...(task.leaseHolderRunKey ? { leaseHolderRunKey: task.leaseHolderRunKey } : {}),
        resumeMode,
      });
    }
  }

  private async attachDiscoveredTarget(
    browserSessionId: string,
    actions: RelayActionRequest["actions"]
  ): Promise<BrowserTarget> {
    const requiredCapabilities = new Set(actions.map((action) => action.kind));
    const capablePeerIds = new Set(
      this.gateway
        .listPeers()
        .filter((peer) => peer.status === "online" && this.peerSupportsActions(peer.capabilities, requiredCapabilities))
        .map((peer) => peer.peerId)
    );
    const discoveredTarget = this.gateway
      .listTargets(this.preferredPeerId ? { peerId: this.preferredPeerId } : undefined)
      .find((item) => item.status !== "closed" && capablePeerIds.has(item.peerId));
    if (!discoveredTarget) {
      throw new Error("no relay target available for attach");
    }
    return this.sessionManager.ensureTarget({
      browserSessionId,
      transportSessionId: discoveredTarget.relayTargetId,
      url: discoveredTarget.url,
      ...(discoveredTarget.title ? { title: discoveredTarget.title } : {}),
      status: "attached",
      lastResumeMode: "hot",
      createIfMissing: true,
    });
  }

  private resolvePeerId(actions: RelayActionRequest["actions"], relayTargetId?: string): string {
    if (relayTargetId) {
      const knownTarget = this.gateway.listTargets().find((item) => item.relayTargetId === relayTargetId);
      if (knownTarget) {
        return knownTarget.peerId;
      }
    }

    if (this.preferredPeerId) {
      return this.preferredPeerId;
    }

    const requiredCapabilities = new Set(actions.map((action) => action.kind));
    const onlinePeer = this.gateway
      .listPeers()
      .find((peer) => peer.status === "online" && this.peerSupportsActions(peer.capabilities, requiredCapabilities));
    if (!onlinePeer) {
      const endpoint = this.options.relay?.endpoint?.trim();
      throw new Error(
        endpoint
          ? `relay browser transport has no compatible registered peers (endpoint=${endpoint})`
          : "relay browser transport has no compatible registered peers"
      );
    }
    return onlinePeer.peerId;
  }

  private peerSupportsActions(capabilities: string[], requiredCapabilities: ReadonlySet<string>): boolean {
    if (requiredCapabilities.size === 0) {
      return true;
    }
    const capabilitySet = new Set(capabilities);
    for (const capability of requiredCapabilities) {
      if (!capabilitySet.has(capability)) {
        return false;
      }
    }
    return true;
  }

  private hasKnownRelayTarget(relayTargetId: string): boolean {
    return this.gateway.listTargets().some((target) => target.relayTargetId === relayTargetId && target.status !== "closed");
  }

  private async persistSnapshotArtifact(input: {
    task: BrowserTaskRequest;
    sessionId: string;
    targetId: string;
    page: BrowserSnapshotResult;
  }): Promise<string | null> {
    const taskDir = path.join(this.artifactRootDir, input.sessionId, encodeURIComponent(input.task.taskId));
    await mkdir(taskDir, { recursive: true });
    const artifactId = `${input.task.taskId}:relay-snapshot`;
    const snapshotPath = path.join(taskDir, "relay-snapshot.json");
    await writeFile(snapshotPath, `${JSON.stringify(input.page, null, 2)}\n`, "utf8");
    await this.snapshotRefStore.save({
      artifactId,
      snapshotId: `${input.task.taskId}:snapshot`,
      browserSessionId: input.sessionId,
      targetId: input.targetId,
      createdAt: Date.now(),
      finalUrl: input.page.finalUrl,
      title: input.page.title,
      refEntries: input.page.interactives.map(toSnapshotRefEntry),
    });
    const artifactRecord: BrowserArtifactRecord = {
      artifactId,
      browserSessionId: input.sessionId,
      targetId: input.targetId,
      type: "snapshot",
      path: snapshotPath,
      createdAt: Date.now(),
      metadata: {
        finalUrl: input.page.finalUrl,
        title: input.page.title,
      },
    };
    await this.artifactStore.put(artifactRecord);
    return artifactId;
  }

  private async persistScreenshotArtifacts(input: {
    task: BrowserTaskRequest;
    sessionId: string;
    targetId: string;
    screenshotPayloads: RelayActionResult["screenshotPayloads"];
  }): Promise<{ screenshotPaths: string[]; artifactIds: string[] }> {
    if (!input.screenshotPayloads.length) {
      return {
        screenshotPaths: [],
        artifactIds: [],
      };
    }

    const taskDir = path.join(this.artifactRootDir, input.sessionId, encodeURIComponent(input.task.taskId));
    await mkdir(taskDir, { recursive: true });

    const screenshotPaths: string[] = [];
    const artifactIds: string[] = [];

    for (let index = 0; index < input.screenshotPayloads.length; index += 1) {
      const payload = input.screenshotPayloads[index]!;
      const label = sanitizeLabel(payload.label ?? `relay-screenshot-${index + 1}`);
      const screenshotPath = path.join(taskDir, `${String(index + 1).padStart(2, "0")}-${label}.png`);
      await writeFile(screenshotPath, Buffer.from(payload.dataBase64, "base64"));
      screenshotPaths.push(screenshotPath);

      const artifactId = `${input.task.taskId}:relay-screenshot:${index + 1}`;
      artifactIds.push(artifactId);
      await this.artifactStore.put({
        artifactId,
        browserSessionId: input.sessionId,
        targetId: input.targetId,
        type: "screenshot",
        path: screenshotPath,
        createdAt: Date.now(),
        metadata: {
          mimeType: payload.mimeType,
          label: payload.label ?? null,
        },
      });
    }

    return {
      screenshotPaths,
      artifactIds,
    };
  }

  private async appendHistoryEntry(input: {
    dispatchMode: BrowserSessionDispatchMode;
    task: BrowserTaskRequest;
    sessionId: string;
    startedAt: number;
    ownerType: BrowserSession["ownerType"];
    ownerId: string;
    result?: BrowserTaskResult;
    error?: unknown;
  }): Promise<string> {
    const entryId = this.createId("browser-history");
    await this.historyStore.append({
      entryId,
      browserSessionId: input.sessionId,
      dispatchMode: input.dispatchMode,
      threadId: input.task.threadId,
      taskId: input.task.taskId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      ...(input.result?.targetId ? { targetId: input.result.targetId } : {}),
      ...(input.result?.transportMode ? { transportMode: input.result.transportMode } : {}),
      ...(input.result?.transportLabel ? { transportLabel: input.result.transportLabel } : {}),
      ...(input.result?.transportPeerId ? { transportPeerId: input.result.transportPeerId } : {}),
      ...(input.result?.transportTargetId ? { transportTargetId: input.result.transportTargetId } : {}),
      historyCursor: input.startedAt,
      startedAt: input.startedAt,
      completedAt: Date.now(),
      status: input.result ? "completed" : "failed",
      actionKinds: input.task.actions.map((action) => action.kind),
      instructions: input.task.instructions,
      ...(input.result?.resumeMode ? { resumeMode: input.result.resumeMode } : {}),
      ...(input.result?.targetResolution ? { targetResolution: input.result.targetResolution } : {}),
      summary: input.result
        ? summarizeBrowserHistorySuccess(input.dispatchMode, input.result)
        : summarizeBrowserHistoryFailure(input.dispatchMode, input.error),
      ...(input.result
        ? {
            finalUrl: input.result.page.finalUrl,
            title: input.result.page.title,
            traceStepCount: input.result.trace.length,
            screenshotCount: input.result.screenshotPaths.length,
            artifactCount: input.result.artifactIds.length,
          }
        : {}),
      ...(input.error
        ? {
            failure: {
              layer: "browser",
              category: "transport_failed",
              retryable: true,
              message: input.error instanceof Error ? input.error.message : "relay execution failed",
              recommendedAction: "retry",
            },
          }
        : {}),
    });
    return entryId;
  }

  private async requireTarget(browserSessionId: string, targetId?: string): Promise<BrowserTarget> {
    if (!targetId) {
      throw new Error(`browser target not found for session: ${browserSessionId}`);
    }
    return this.findTarget(browserSessionId, targetId).then((target) => {
      if (!target) {
        throw new Error(`browser target not found for session: ${targetId}`);
      }
      return target;
    });
  }

  private async findTarget(browserSessionId: string, targetId: string): Promise<BrowserTarget | null> {
    const targets = await this.sessionManager.listTargets(browserSessionId);
    return targets.find((item) => item.targetId === targetId) ?? null;
  }
}

function toSnapshotRefEntry(item: BrowserSnapshotResult["interactives"][number], index: number): SnapshotRefEntry {
  return {
    refId: item.refId,
    role: item.role,
    label: item.label,
    tagName: item.tagName,
    ...(item.selectors ? { selectors: item.selectors } : {}),
    ...(item.textAnchors ? { textAnchors: item.textAnchors } : {}),
    ordinal: index + 1,
  };
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
