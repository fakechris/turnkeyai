import path from "node:path";

import type {
  BrowserBridge,
  BrowserPageResult,
  BrowserSessionHistoryEntry,
  BrowserSessionResumeInput,
  BrowserSession,
  BrowserSessionSendInput,
  BrowserSessionSpawnInput,
  BrowserTarget,
  BrowserTaskRequest,
  BrowserTaskResult,
} from "@turnkeyai/core-types/team";

import { FileBrowserArtifactStore } from "./artifacts/file-browser-artifact-store";
import { ChromeSessionManager } from "./chrome-session-manager";
import { FileSnapshotRefStore } from "./refs/file-snapshot-ref-store";
import { BrowserSessionManager } from "./session/browser-session-manager";
import { FileBrowserSessionHistoryStore } from "./session/file-browser-session-history-store";
import { FileBrowserProfileStore } from "./session/file-browser-profile-store";
import { FileBrowserSessionStore } from "./session/file-browser-session-store";
import { FileBrowserTargetStore } from "./session/file-browser-target-store";

export class LocalChromeBrowserBridge implements BrowserBridge {
  private readonly sessionManager: ChromeSessionManager;

  constructor(options: {
    artifactRootDir: string;
    stateRootDir?: string;
    executablePath?: string;
    headless?: boolean;
  }) {
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

    this.sessionManager = new ChromeSessionManager({
      artifactRootDir: options.artifactRootDir,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      ...(options.headless !== undefined ? { headless: options.headless } : {}),
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
    });
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
}
