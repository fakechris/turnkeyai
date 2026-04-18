import type {
  RelayActionRequest,
  RelayActionResult,
  RelayPeerRecord,
  RelayPeerRegistration,
  RelayScreenshotPayload,
  RelayTargetRecord,
  RelayTargetReport,
} from "@turnkeyai/browser-bridge/transport/relay-protocol";

export interface RelayPeerClient {
  registerPeer(input: RelayPeerRegistration): Promise<RelayPeerRecord>;
  heartbeatPeer(peerId: string): Promise<RelayPeerRecord>;
  reportTargets(peerId: string, targets: RelayTargetReport[]): Promise<RelayTargetRecord[]>;
  pullNextAction(peerId: string): Promise<RelayActionRequest | null>;
  submitActionResult(peerId: string, result: Omit<RelayActionResult, "peerId">): Promise<RelayActionResult>;
}

export interface RelayPeerTargetObserver {
  listTargets(): Promise<RelayTargetReport[]>;
}

export interface RelayPeerActionExecutor {
  execute(request: RelayActionRequest): Promise<RelayPeerExecutionResult>;
}

export interface RelayPeerExecutionResult {
  relayTargetId?: string;
  url: string;
  title?: string;
  status: "completed" | "failed";
  page?: RelayActionResult["page"];
  trace: RelayActionResult["trace"];
  screenshotPaths?: string[];
  screenshotPayloads?: RelayScreenshotPayload[];
  artifactIds?: string[];
  errorMessage?: string;
}

export interface BrowserRelayPeerRuntimeOptions {
  peer: RelayPeerRegistration;
  client: RelayPeerClient;
  targetObserver: RelayPeerTargetObserver;
  actionExecutor: RelayPeerActionExecutor;
  executionHeartbeatIntervalMs?: number;
}

export class BrowserRelayPeerRuntime {
  private readonly peer: RelayPeerRegistration;
  private readonly client: RelayPeerClient;
  private readonly targetObserver: RelayPeerTargetObserver;
  private readonly actionExecutor: RelayPeerActionExecutor;
  private readonly executionHeartbeatIntervalMs: number;
  private started = false;

  constructor(options: BrowserRelayPeerRuntimeOptions) {
    this.peer = options.peer;
    this.client = options.client;
    this.targetObserver = options.targetObserver;
    this.actionExecutor = options.actionExecutor;
    this.executionHeartbeatIntervalMs = Math.max(250, options.executionHeartbeatIntervalMs ?? 2_000);
  }

  async start(): Promise<RelayPeerRecord> {
    const registered = await this.client.registerPeer(this.peer);
    this.started = true;
    return registered;
  }

  async syncTargets(): Promise<RelayTargetRecord[]> {
    await this.ensureStarted();
    return this.client.reportTargets(this.peer.peerId, await this.targetObserver.listTargets());
  }

  async heartbeat(): Promise<RelayPeerRecord> {
    await this.ensureStarted();
    return this.client.heartbeatPeer(this.peer.peerId);
  }

  async runCycle(): Promise<RelayActionResult | null> {
    await this.ensureStarted();
    await this.syncTargets();
    await this.heartbeat();
    const request = await this.client.pullNextAction(this.peer.peerId);
    if (!request) {
      return null;
    }
    const claimToken = request.claimToken;
    if (!claimToken) {
      throw new Error(`relay action request is missing claimToken: ${request.actionRequestId}`);
    }

    let execution: RelayPeerExecutionResult;
    const heartbeatLease = this.startExecutionHeartbeat();
    try {
      execution = await this.actionExecutor.execute(request);
    } catch (error) {
      if (!request.relayTargetId) {
        throw error;
      }
      execution = {
        relayTargetId: request.relayTargetId,
        url: "",
        status: "failed",
        trace: [],
        screenshotPaths: [],
        screenshotPayloads: [],
        artifactIds: [],
        errorMessage: error instanceof Error ? error.message : "relay execution failed",
      };
    } finally {
      heartbeatLease.stop();
    }
    const relayTargetId = execution.relayTargetId ?? request.relayTargetId;
    if (!relayTargetId) {
      throw new Error(`relay execution result missing relayTargetId for request: ${request.actionRequestId}`);
    }

    return this.client.submitActionResult(this.peer.peerId, {
      actionRequestId: request.actionRequestId,
      browserSessionId: request.browserSessionId,
      taskId: request.taskId,
      relayTargetId,
      claimToken,
      url: execution.url,
      ...(execution.title ? { title: execution.title } : {}),
      status: execution.status,
      ...(execution.page ? { page: execution.page } : {}),
      trace: execution.trace,
      screenshotPaths: execution.screenshotPaths ?? [],
      screenshotPayloads: execution.screenshotPayloads ?? [],
      artifactIds: execution.artifactIds ?? [],
      ...(execution.errorMessage ? { errorMessage: execution.errorMessage } : {}),
    });
  }

  async runUntilIdle(maxIterations = 10): Promise<RelayActionResult[]> {
    const results: RelayActionResult[] = [];
    for (let index = 0; index < maxIterations; index += 1) {
      const result = await this.runCycle();
      if (!result) {
        break;
      }
      results.push(result);
    }
    return results;
  }

  private async ensureStarted(): Promise<void> {
    if (!this.started) {
      await this.start();
    }
  }

  private startExecutionHeartbeat(): { stop: () => void } {
    let stopped = false;
    let inFlightHeartbeat: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (stopped || inFlightHeartbeat) {
        return;
      }
      inFlightHeartbeat = this.client
        .heartbeatPeer(this.peer.peerId)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          inFlightHeartbeat = null;
        });
    }, this.executionHeartbeatIntervalMs);

    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }
}
