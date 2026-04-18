import type { BrowserTaskAction } from "@turnkeyai/core-types/team";

import type {
  RelayActionRequest,
  RelayActionRequestRecord,
  RelayActionResult,
  RelayExecutableBrowserAction,
  RelayPeerRecord,
  RelayPeerRegistration,
  RelayTargetRecord,
  RelayTargetReport,
} from "./relay-protocol";

interface RelayGatewayOptions {
  now?: () => number;
  createId?: (prefix: string) => string;
  staleAfterMs?: number;
  actionTimeoutMs?: number;
  claimLeaseMs?: number;
}

interface RelayPeerState {
  registration: Omit<RelayPeerRecord, "status">;
  targets: Map<string, RelayTargetRecord>;
}

interface PendingRelayActionResolution {
  resolve: (result: RelayActionResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface RelayQueuedAction {
  actionRequestId: string;
  browserSessionId: string;
  taskId: string;
  relayTargetId?: string;
  targetId?: string;
  actions: RelayExecutableBrowserAction[];
  actionKinds: RelayExecutableBrowserAction["kind"][];
  createdAt: number;
  expiresAt: number;
  preferredPeerId?: string;
  lockedPeerId?: string;
  state: RelayActionRequestRecord["state"];
  assignedPeerId?: string;
  claimToken?: string;
  claimedAt?: number;
  claimExpiresAt?: number;
  attemptCount: number;
  reclaimCount: number;
  lastClaimExpiredAt?: number;
  resolution: PendingRelayActionResolution;
}

const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_CLAIM_LEASE_MS = 10_000;

export class RelayGateway {
  private readonly now: () => number;
  private readonly createId: (prefix: string) => string;
  private readonly staleAfterMs: number;
  private readonly actionTimeoutMs: number;
  private readonly claimLeaseMs: number;
  private idSequence = 0;
  private readonly peers = new Map<string, RelayPeerState>();
  private readonly actionRequests = new Map<string, RelayQueuedAction>();
  private readonly actionRequestOrder: string[] = [];

  constructor(options: RelayGatewayOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? ((prefix) => `${prefix}-${this.now()}-${(this.idSequence += 1)}`);
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
  }

  registerPeer(input: RelayPeerRegistration): RelayPeerRecord {
    const peerId = input.peerId.trim();
    if (!peerId) {
      throw new Error("relay peerId is required");
    }

    const now = this.now();
    const existing = this.peers.get(peerId);
    const registration = {
      peerId,
      ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      capabilities: [...new Set((input.capabilities ?? []).map((value) => value.trim()).filter(Boolean))],
      ...(input.transportLabel?.trim() ? { transportLabel: input.transportLabel.trim() } : {}),
      registeredAt: existing?.registration.registeredAt ?? now,
      lastSeenAt: now,
    };
    this.peers.set(peerId, {
      registration,
      targets: existing?.targets ?? new Map<string, RelayTargetRecord>(),
    });
    return this.toPeerRecord(registration);
  }

  heartbeatPeer(peerId: string): RelayPeerRecord {
    const state = this.getPeerState(peerId);
    const now = this.now();
    state.registration.lastSeenAt = now;
    this.renewInflightClaims(peerId, now);
    return this.toPeerRecord(state.registration);
  }

  reportTargets(peerId: string, targets: RelayTargetReport[]): RelayTargetRecord[] {
    const state = this.getPeerState(peerId);
    const now = this.now();
    state.registration.lastSeenAt = now;

    const nextTargets = new Map<string, RelayTargetRecord>();
    for (const rawTarget of targets) {
      const relayTargetId = rawTarget.relayTargetId.trim();
      if (!relayTargetId) {
        throw new Error("relay targetId is required");
      }
      nextTargets.set(relayTargetId, {
        relayTargetId,
        peerId: state.registration.peerId,
        url: rawTarget.url,
        ...(rawTarget.title ? { title: rawTarget.title } : {}),
        status: rawTarget.status ?? "open",
        lastSeenAt: now,
      });
    }
    state.targets = nextTargets;
    return this.listTargets({ peerId: state.registration.peerId });
  }

  listPeers(): RelayPeerRecord[] {
    return [...this.peers.values()]
      .map((state) => this.toPeerRecord(state.registration))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.peerId.localeCompare(right.peerId));
  }

  listTargets(input?: { peerId?: string }): RelayTargetRecord[] {
    const peerId = input?.peerId?.trim();
    const targets =
      peerId && this.peers.has(peerId)
        ? [...this.peers.get(peerId)!.targets.values()]
        : [...this.peers.values()].flatMap((state) => [...state.targets.values()]);
    return targets.sort(
      (left, right) =>
        right.lastSeenAt - left.lastSeenAt ||
        left.peerId.localeCompare(right.peerId) ||
        left.relayTargetId.localeCompare(right.relayTargetId)
    );
  }

  listActionRequests(): RelayActionRequestRecord[] {
    this.reclaimExpiredActionRequests();
    return this.actionRequestOrder
      .map((actionRequestId) => this.actionRequests.get(actionRequestId) ?? null)
      .filter((record): record is RelayQueuedAction => Boolean(record))
      .map((record) => this.toActionRequestRecord(record));
  }

  async dispatchActionRequest(input: {
    browserSessionId: string;
    taskId: string;
    relayTargetId?: string;
    targetId?: string;
    actions: RelayExecutableBrowserAction[];
    preferredPeerId?: string;
  }): Promise<RelayActionResult> {
    this.reclaimExpiredActionRequests();

    if (!input.actions.length) {
      throw new Error("relay action request must include at least one action");
    }

    const relayTargetId = input.relayTargetId?.trim();
    const targetBinding = relayTargetId ? this.findTargetRecord(relayTargetId) : null;
    if (relayTargetId && !targetBinding) {
      throw new Error(`relay target not found: ${relayTargetId}`);
    }

    const preferredPeerId = input.preferredPeerId?.trim() || undefined;
    const actionKinds = [...new Set(input.actions.map((action) => action.kind))];
    if (relayTargetId) {
      const lockedPeerCapabilities = this.getPeerCapabilities(targetBinding!.peerId);
      if (!this.peerSupportsActionKinds(lockedPeerCapabilities, actionKinds)) {
        throw new Error(`relay peer ${targetBinding!.peerId} does not support required action kinds`);
      }
    } else if (!this.hasAnyClaimablePeer(actionKinds, preferredPeerId)) {
      throw new Error("relay browser transport has no compatible registered peers");
    }

    const actionRequestId = this.createId("relay-action");
    return new Promise<RelayActionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const record = this.actionRequests.get(actionRequestId);
        if (!record) {
          return;
        }
        this.actionRequests.delete(actionRequestId);
        this.removeActionRequestFromOrder(actionRequestId);
        reject(new Error(`relay action request timed out: ${actionRequestId}`));
      }, this.actionTimeoutMs);

      this.actionRequests.set(actionRequestId, {
        actionRequestId,
        browserSessionId: input.browserSessionId,
        taskId: input.taskId,
        ...(relayTargetId ? { relayTargetId } : {}),
        ...(input.targetId ? { targetId: input.targetId } : {}),
        actions: input.actions,
        actionKinds,
        createdAt: this.now(),
        expiresAt: this.now() + this.actionTimeoutMs,
        ...(preferredPeerId ? { preferredPeerId } : {}),
        ...(targetBinding?.peerId ? { lockedPeerId: targetBinding.peerId } : {}),
        state: "pending",
        attemptCount: 0,
        reclaimCount: 0,
        resolution: {
          resolve,
          reject,
          timeout,
        },
      });
      this.actionRequestOrder.push(actionRequestId);
    });
  }

  pullNextActionRequest(peerId: string): RelayActionRequest | null {
    const state = this.getPeerState(peerId);
    state.registration.lastSeenAt = this.now();
    this.reclaimExpiredActionRequests();

    const peerRecord = this.toPeerRecord(state.registration);
    const action = this.findClaimableActionForPeer(peerRecord);
    if (!action) {
      return null;
    }

    const now = this.now();
    const claimToken = this.createId("relay-claim");
    action.state = "inflight";
    action.assignedPeerId = peerRecord.peerId;
    action.claimToken = claimToken;
    action.claimedAt = now;
    action.claimExpiresAt = Math.min(action.expiresAt, now + this.claimLeaseMs);
    action.attemptCount += 1;

    return {
      actionRequestId: action.actionRequestId,
      peerId: peerRecord.peerId,
      browserSessionId: action.browserSessionId,
      taskId: action.taskId,
      ...(action.relayTargetId ? { relayTargetId: action.relayTargetId } : {}),
      ...(action.targetId ? { targetId: action.targetId } : {}),
      actions: action.actions,
      createdAt: action.createdAt,
      expiresAt: action.expiresAt,
      claimToken,
      claimedAt: action.claimedAt,
      claimExpiresAt: action.claimExpiresAt,
      attemptCount: action.attemptCount,
      reclaimCount: action.reclaimCount,
    };
  }

  submitActionResult(input: RelayActionResult): RelayActionResult {
    const state = this.getPeerState(input.peerId);
    state.registration.lastSeenAt = this.now();

    const action = this.actionRequests.get(input.actionRequestId);
    if (!action) {
      throw new Error(`unknown relay action request: ${input.actionRequestId}`);
    }
    const isActiveClaimSubmission =
      action.state === "inflight" &&
      action.assignedPeerId === input.peerId &&
      action.claimToken === input.claimToken;
    if (!isActiveClaimSubmission) {
      this.reclaimExpiredActionRequests();
    }
    if (action.state !== "inflight" || !action.assignedPeerId || !action.claimToken) {
      throw new Error(`relay action request is not currently claimed: ${input.actionRequestId}`);
    }
    if (action.assignedPeerId !== input.peerId) {
      throw new Error(`relay action result peer mismatch: ${input.peerId}`);
    }
    if (action.claimToken !== input.claimToken) {
      throw new Error(`relay action result claim mismatch: ${input.actionRequestId}`);
    }

    clearTimeout(action.resolution.timeout);
    this.actionRequests.delete(input.actionRequestId);
    this.removeActionRequestFromOrder(input.actionRequestId);

    const knownTarget = state.targets.get(input.relayTargetId);
    state.targets.set(input.relayTargetId, {
      relayTargetId: input.relayTargetId,
      peerId: input.peerId,
      url: input.url,
      ...(input.title ? { title: input.title } : {}),
      status: input.status === "failed" ? knownTarget?.status ?? "attached" : "attached",
      lastSeenAt: this.now(),
    });

    action.resolution.resolve(input);
    return input;
  }

  private findClaimableActionForPeer(peer: RelayPeerRecord): RelayQueuedAction | null {
    for (const actionRequestId of this.actionRequestOrder) {
      const action = this.actionRequests.get(actionRequestId);
      if (!action || action.state !== "pending") {
        continue;
      }
      if (this.canPeerClaimAction(peer, action)) {
        return action;
      }
    }
    return null;
  }

  private canPeerClaimAction(peer: RelayPeerRecord, action: RelayQueuedAction): boolean {
    if (peer.status !== "online") {
      return false;
    }
    if (action.lockedPeerId && action.lockedPeerId !== peer.peerId) {
      return false;
    }
    if (
      action.preferredPeerId &&
      action.preferredPeerId !== peer.peerId &&
      this.isPeerOnline(action.preferredPeerId) &&
      this.peerSupportsActionKinds(this.getPeerCapabilities(action.preferredPeerId), action.actionKinds)
    ) {
      return false;
    }
    return this.peerSupportsActionKinds(peer.capabilities, action.actionKinds);
  }

  private reclaimExpiredActionRequests(): void {
    const now = this.now();
    for (const action of this.actionRequests.values()) {
      if (action.state !== "inflight" || action.claimExpiresAt === undefined || action.claimExpiresAt > now) {
        continue;
      }
      if (action.expiresAt <= now) {
        continue;
      }
      action.state = "pending";
      action.reclaimCount += 1;
      action.lastClaimExpiredAt = now;
      delete action.assignedPeerId;
      delete action.claimToken;
      delete action.claimedAt;
      delete action.claimExpiresAt;
    }
  }

  private renewInflightClaims(peerId: string, now: number): void {
    for (const action of this.actionRequests.values()) {
      if (action.state !== "inflight" || action.assignedPeerId !== peerId) {
        continue;
      }
      action.claimExpiresAt = Math.min(action.expiresAt, now + this.claimLeaseMs);
    }
  }

  private hasAnyClaimablePeer(
    actionKinds: RelayExecutableBrowserAction["kind"][],
    preferredPeerId?: string
  ): boolean {
    const onlinePeers = this.listPeers().filter((peer) => peer.status === "online");
    if (preferredPeerId) {
      const preferred = onlinePeers.find((peer) => peer.peerId === preferredPeerId);
      if (preferred && this.peerSupportsActionKinds(preferred.capabilities, actionKinds)) {
        return true;
      }
    }
    return onlinePeers.some((peer) => this.peerSupportsActionKinds(peer.capabilities, actionKinds));
  }

  private peerSupportsActionKinds(capabilities: string[], actionKinds: RelayExecutableBrowserAction["kind"][]): boolean {
    if (!actionKinds.length) {
      return true;
    }
    const capabilitySet = new Set(capabilities);
    return actionKinds.every((kind) => capabilitySet.has(kind));
  }

  private getPeerCapabilities(peerId: string): string[] {
    return this.peers.get(peerId)?.registration.capabilities ?? [];
  }

  private isPeerOnline(peerId: string): boolean {
    const state = this.peers.get(peerId);
    if (!state) {
      return false;
    }
    return this.getPeerStatus(state.registration.lastSeenAt) === "online";
  }

  private findTargetRecord(relayTargetId: string): RelayTargetRecord | null {
    const normalized = relayTargetId.trim();
    if (!normalized) {
      return null;
    }
    for (const state of this.peers.values()) {
      const target = state.targets.get(normalized);
      if (target) {
        return target;
      }
    }
    return null;
  }

  private removeActionRequestFromOrder(actionRequestId: string): void {
    const index = this.actionRequestOrder.indexOf(actionRequestId);
    if (index >= 0) {
      this.actionRequestOrder.splice(index, 1);
    }
  }

  private getPeerState(peerId: string): RelayPeerState {
    const trimmed = peerId.trim();
    if (!trimmed) {
      throw new Error("relay peerId is required");
    }
    const state = this.peers.get(trimmed);
    if (!state) {
      throw new Error(`relay peer not found: ${trimmed}`);
    }
    return state;
  }

  private toPeerRecord(registration: RelayPeerState["registration"]): RelayPeerRecord {
    return {
      ...registration,
      status: this.getPeerStatus(registration.lastSeenAt),
    };
  }

  private toActionRequestRecord(action: RelayQueuedAction): RelayActionRequestRecord {
    return {
      actionRequestId: action.actionRequestId,
      browserSessionId: action.browserSessionId,
      taskId: action.taskId,
      ...(action.relayTargetId ? { relayTargetId: action.relayTargetId } : {}),
      ...(action.targetId ? { targetId: action.targetId } : {}),
      actionKinds: [...action.actionKinds],
      createdAt: action.createdAt,
      expiresAt: action.expiresAt,
      state: action.state,
      ...(action.preferredPeerId ? { preferredPeerId: action.preferredPeerId } : {}),
      ...(action.lockedPeerId ? { lockedPeerId: action.lockedPeerId } : {}),
      ...(action.assignedPeerId ? { assignedPeerId: action.assignedPeerId } : {}),
      ...(action.claimToken ? { claimToken: action.claimToken } : {}),
      ...(action.claimedAt !== undefined ? { claimedAt: action.claimedAt } : {}),
      ...(action.claimExpiresAt !== undefined ? { claimExpiresAt: action.claimExpiresAt } : {}),
      attemptCount: action.attemptCount,
      reclaimCount: action.reclaimCount,
      ...(action.lastClaimExpiredAt !== undefined ? { lastClaimExpiredAt: action.lastClaimExpiredAt } : {}),
    };
  }

  private getPeerStatus(lastSeenAt: number): RelayPeerRecord["status"] {
    return this.now() - lastSeenAt > this.staleAfterMs ? "stale" : "online";
  }
}

export function isRelayExecutableAction(
  action: BrowserTaskAction
): action is RelayExecutableBrowserAction {
  return (
    action.kind === "open" ||
    action.kind === "snapshot" ||
    action.kind === "click" ||
    action.kind === "type" ||
    action.kind === "scroll" ||
    action.kind === "console" ||
    action.kind === "wait" ||
    action.kind === "screenshot"
  );
}
