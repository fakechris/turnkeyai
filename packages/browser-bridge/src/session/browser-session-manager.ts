import type {
  BrowserProfile,
  BrowserProfileOwnerType,
  BrowserProfileStore,
  BrowserResumeMode,
  BrowserSession,
  BrowserSessionOwnerType,
  BrowserSessionStore,
  BrowserTarget,
  BrowserTargetStore,
} from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";

interface BrowserSessionManagerOptions {
  browserProfileStore: BrowserProfileStore;
  browserSessionStore: BrowserSessionStore;
  browserTargetStore: BrowserTargetStore;
  now?: () => number;
  createId?: (prefix: string) => string;
  profileRootDir?: string;
}

export interface BrowserSessionAcquireInput {
  ownerType: BrowserSessionOwnerType;
  ownerId: string;
  profileOwnerType: BrowserProfileOwnerType;
  profileOwnerId: string;
  preferredTransport?: BrowserSession["transportMode"];
  reusable: boolean;
  leaseHolderRunKey?: string;
  leaseTtlMs?: number;
}

export interface BrowserSessionResumeInput {
  browserSessionId: string;
  ownerType?: BrowserSessionOwnerType;
  ownerId?: string;
  leaseHolderRunKey?: string;
  leaseTtlMs?: number;
}

export interface EnsureBrowserTargetInput {
  browserSessionId: string;
  url?: string;
  targetId?: string;
  transportSessionId?: string;
  title?: string;
  status?: BrowserTarget["status"];
  createIfMissing?: boolean;
  lastResumeMode?: BrowserResumeMode;
}

export interface BrowserSessionLease {
  session: BrowserSession;
  profile: BrowserProfile;
}

export interface BrowserSessionReleaseInput {
  browserSessionId: string;
  leaseHolderRunKey?: string;
  resumeMode?: BrowserResumeMode;
}

const DEFAULT_SESSION_LEASE_TTL_MS = 5 * 60_000;

export class BrowserSessionManager {
  private readonly browserProfileStore: BrowserProfileStore;
  private readonly browserSessionStore: BrowserSessionStore;
  private readonly browserTargetStore: BrowserTargetStore;
  private readonly now: () => number;
  private readonly createId: (prefix: string) => string;
  private readonly profileRootDir: string;
  private readonly ownerMutex = new KeyedAsyncMutex<string>();
  private readonly profileMutex = new KeyedAsyncMutex<string>();
  private readonly sessionMutex = new KeyedAsyncMutex<string>();

  constructor(options: BrowserSessionManagerOptions) {
    this.browserProfileStore = options.browserProfileStore;
    this.browserSessionStore = options.browserSessionStore;
    this.browserTargetStore = options.browserTargetStore;
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? ((prefix) => `${prefix}-${Date.now()}`);
    this.profileRootDir = options.profileRootDir ?? ".daemon-data/browser/profiles";
  }

  async acquireSession(input: BrowserSessionAcquireInput): Promise<BrowserSessionLease> {
    return this.withOwnerLock(input.ownerType, input.ownerId, async () => {
      const profile = await this.getOrCreateProfile(input.profileOwnerType, input.profileOwnerId);
      if (input.reusable) {
        const existing = (await this.browserSessionStore.listByOwner(input.ownerType, input.ownerId)).find(
          (session) => session.status !== "closed" && session.profileId === profile.profileId
        );
        if (existing) {
          return this.claimSessionLease(
            {
              browserSessionId: existing.browserSessionId,
              ownerType: input.ownerType,
              ownerId: input.ownerId,
              ...(input.leaseHolderRunKey ? { leaseHolderRunKey: input.leaseHolderRunKey } : {}),
              ...(input.leaseTtlMs !== undefined ? { leaseTtlMs: input.leaseTtlMs } : {}),
            },
            profile
          );
        }
      }

      const now = this.now();
      const session: BrowserSession = {
        browserSessionId: this.createId("browser-session"),
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        profileId: profile.profileId,
        transportMode: input.preferredTransport ?? "local",
        status: "starting",
        ...(input.leaseHolderRunKey
          ? {
              leaseHolderRunKey: input.leaseHolderRunKey,
              leaseExpiresAt: now + (input.leaseTtlMs ?? DEFAULT_SESSION_LEASE_TTL_MS),
            }
          : {}),
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
        targetIds: [],
      };

      await this.browserSessionStore.put(session);
      return { session, profile };
    });
  }

  async resumeSession(input: string | BrowserSessionResumeInput): Promise<BrowserSessionLease> {
    const request = typeof input === "string" ? { browserSessionId: input } : input;
    const session = await this.browserSessionStore.get(request.browserSessionId);
    if (!session) {
      throw new Error(`browser session not found: ${request.browserSessionId}`);
    }

    const profile = await this.browserProfileStore.get(session.profileId);
    if (!profile) {
      throw new Error(`browser profile not found: ${session.profileId}`);
    }

    return this.claimSessionLease(request, profile);
  }

  async releaseSession(input: string | BrowserSessionReleaseInput): Promise<void> {
    const request = typeof input === "string" ? { browserSessionId: input } : input;
    await this.withSessionLock(request.browserSessionId, async () => {
      const session = await this.browserSessionStore.get(request.browserSessionId);
      if (!session) {
        return;
      }

      const now = this.now();
      if (
        request.leaseHolderRunKey &&
        this.isLeaseActive(session, now) &&
        session.leaseHolderRunKey &&
        session.leaseHolderRunKey !== request.leaseHolderRunKey
      ) {
        return;
      }

      const clearedLeaseSession = this.stripSessionLease(session);
      const clearedTargets = await this.browserTargetStore.listBySession(request.browserSessionId);
      await Promise.all(
        clearedTargets.map((target) =>
          this.browserTargetStore.put({
            ...this.stripTargetLease(target),
            updatedAt: now,
          })
        )
      );
      await this.browserSessionStore.put({
        ...clearedLeaseSession,
        status: this.deriveIdleStatus(clearedLeaseSession, now),
        updatedAt: now,
        lastActiveAt: now,
        ...(request.resumeMode ? { lastResumeMode: request.resumeMode } : {}),
      });
    });
  }

  async closeSession(browserSessionId: string, reason: string): Promise<void> {
    await this.withSessionLock(browserSessionId, async () => {
      const session = await this.browserSessionStore.get(browserSessionId);
      if (!session) {
        return;
      }

      const targets = await this.browserTargetStore.listBySession(browserSessionId);
      const now = this.now();
      await Promise.all(
        targets.map((target) =>
          this.browserTargetStore.put({
            ...this.stripTargetLease(target),
            status: "closed",
            updatedAt: now,
          })
        )
      );
      const { activeTargetId: _activeTargetId, ...sessionWithoutActiveTarget } = this.stripSessionLease(session);
      await this.browserSessionStore.put({
        ...sessionWithoutActiveTarget,
        status: "closed",
        updatedAt: now,
        lastActiveAt: now,
        closeReason: reason,
      });
    });
  }

  async listTargets(browserSessionId: string): Promise<BrowserTarget[]> {
    return this.browserTargetStore.listBySession(browserSessionId);
  }

  async listSessions(input?: {
    ownerType?: BrowserSessionOwnerType;
    ownerId?: string;
  }): Promise<BrowserSession[]> {
    if (input?.ownerType && input.ownerId) {
      return this.browserSessionStore.listByOwner(input.ownerType, input.ownerId);
    }

    return this.browserSessionStore.list();
  }

  async activateTarget(browserSessionId: string, targetId: string): Promise<BrowserTarget> {
    const target = await this.browserTargetStore.get(targetId);
    if (!target || target.browserSessionId !== browserSessionId) {
      throw new Error(`browser target not found for session: ${targetId}`);
    }
    if (target.status === "closed") {
      throw new Error(`browser target is closed: ${targetId}`);
    }

    const session = await this.browserSessionStore.get(browserSessionId);
    if (!session || session.status === "closed") {
      throw new Error(`browser session not found: ${browserSessionId}`);
    }

    const now = this.now();
    await this.touchSessionTarget(browserSessionId, targetId, now);
    const updatedTarget: BrowserTarget = {
      ...target,
      ownerType: session.ownerType,
      ownerId: session.ownerId,
      status: target.status === "detached" ? "attached" : target.status,
      ...(session.leaseHolderRunKey ? { leaseHolderRunKey: session.leaseHolderRunKey } : {}),
      ...(session.leaseExpiresAt ? { leaseExpiresAt: session.leaseExpiresAt } : {}),
      updatedAt: now,
    };
    await this.browserTargetStore.put(updatedTarget);
    return updatedTarget;
  }

  async closeTarget(browserSessionId: string, targetId: string): Promise<BrowserTarget> {
    return this.ensureTarget({
      browserSessionId,
      targetId,
      status: "closed",
      createIfMissing: false,
    });
  }

  async markTargetDetached(browserSessionId: string, targetId: string): Promise<BrowserTarget> {
    return this.ensureTarget({
      browserSessionId,
      targetId,
      status: "detached",
      createIfMissing: false,
    });
  }

  async ensureTarget(input: EnsureBrowserTargetInput): Promise<BrowserTarget> {
    const session = await this.browserSessionStore.get(input.browserSessionId);
    if (!session || session.status === "closed") {
      throw new Error(`browser session not found: ${input.browserSessionId}`);
    }

    if (input.targetId) {
      const existing = await this.browserTargetStore.get(input.targetId);
      if (existing) {
        const now = this.now();
        if (
          existing.ownerType !== session.ownerType ||
          existing.ownerId !== session.ownerId ||
          (input.url && existing.url !== input.url) ||
          (input.title && existing.title !== input.title) ||
          (input.status && existing.status !== input.status) ||
          (input.transportSessionId && existing.transportSessionId !== input.transportSessionId) ||
          (input.lastResumeMode && existing.lastResumeMode !== input.lastResumeMode) ||
          existing.leaseHolderRunKey !== session.leaseHolderRunKey ||
          existing.leaseExpiresAt !== session.leaseExpiresAt
        ) {
          const next: BrowserTarget = {
            ...(session.leaseHolderRunKey ? existing : this.stripTargetLease(existing)),
            ownerType: session.ownerType,
            ownerId: session.ownerId,
            ...(input.url ? { url: input.url } : {}),
            ...(input.title ? { title: input.title } : {}),
            ...(input.status ? { status: input.status } : {}),
            ...(input.transportSessionId ? { transportSessionId: input.transportSessionId } : {}),
            ...(input.lastResumeMode ? { lastResumeMode: input.lastResumeMode } : {}),
            ...(session.leaseHolderRunKey ? { leaseHolderRunKey: session.leaseHolderRunKey } : {}),
            ...(session.leaseExpiresAt ? { leaseExpiresAt: session.leaseExpiresAt } : {}),
            updatedAt: now,
          };
          await this.browserTargetStore.put(next);
          if (next.status === "closed") {
            await this.reselectActiveTarget(input.browserSessionId, next.targetId, now);
          } else if (next.status === "detached") {
            await this.reselectActiveTarget(input.browserSessionId, next.targetId, now, "disconnected");
          } else {
            await this.touchSessionTarget(input.browserSessionId, next.targetId, now);
          }
          return next;
        }

        if (existing.status === "closed") {
          await this.reselectActiveTarget(input.browserSessionId, existing.targetId, now);
        } else {
          await this.touchSessionTarget(input.browserSessionId, existing.targetId, now);
        }
        return existing;
      }
    }

    if (!input.createIfMissing && !input.url) {
      throw new Error(`browser target not found: ${input.targetId ?? "(missing targetId)"}`);
    }

    const now = this.now();
    const target: BrowserTarget = {
      targetId: input.targetId ?? this.createId("target"),
      browserSessionId: input.browserSessionId,
      ownerType: session.ownerType,
      ownerId: session.ownerId,
      url: input.url ?? "",
      ...(input.transportSessionId ? { transportSessionId: input.transportSessionId } : {}),
      ...(input.title ? { title: input.title } : {}),
      status: input.status ?? "open",
      ...(input.lastResumeMode ? { lastResumeMode: input.lastResumeMode } : {}),
      ...(session.leaseHolderRunKey ? { leaseHolderRunKey: session.leaseHolderRunKey } : {}),
      ...(session.leaseExpiresAt ? { leaseExpiresAt: session.leaseExpiresAt } : {}),
      createdAt: now,
      updatedAt: now,
    };

    await this.browserTargetStore.put(target);

    if (target.status === "closed") {
      await this.reselectActiveTarget(input.browserSessionId, target.targetId, now);
    } else if (target.status === "detached") {
      await this.reselectActiveTarget(input.browserSessionId, target.targetId, now, "disconnected");
    } else {
      await this.touchSessionTarget(input.browserSessionId, target.targetId, now);
    }

    return target;
  }

  private async touchSessionTarget(browserSessionId: string, targetId: string, now: number): Promise<void> {
    await this.withSessionLock(browserSessionId, async () => {
      const session = await this.browserSessionStore.get(browserSessionId);
      if (!session || session.status === "closed") {
        return;
      }

      await this.browserSessionStore.put({
        ...session,
        activeTargetId: targetId,
        targetIds: session.targetIds.includes(targetId) ? session.targetIds : [...session.targetIds, targetId],
        status: this.deriveIdleStatus(session, now),
        updatedAt: now,
        lastActiveAt: now,
      });
    });
  }

  private async reselectActiveTarget(
    browserSessionId: string,
    closedTargetId: string,
    now: number,
    emptySessionStatus: BrowserSession["status"] = "ready"
  ): Promise<void> {
    await this.withSessionLock(browserSessionId, async () => {
      const session = await this.browserSessionStore.get(browserSessionId);
      if (!session || session.status === "closed") {
        return;
      }

      const targets = await this.browserTargetStore.listBySession(browserSessionId);
      const replacement = [...targets]
        .filter(
          (target) =>
            target.targetId !== closedTargetId &&
            target.status !== "closed" &&
            target.status !== "detached"
        )
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];

      const nextTargetIds = session.targetIds.includes(closedTargetId)
        ? session.targetIds
        : [...session.targetIds, closedTargetId];

      if (replacement) {
        await this.browserSessionStore.put({
          ...session,
          activeTargetId: replacement.targetId,
          targetIds: nextTargetIds.includes(replacement.targetId) ? nextTargetIds : [...nextTargetIds, replacement.targetId],
          status: this.deriveIdleStatus(session, now),
          updatedAt: now,
          lastActiveAt: now,
        });
        return;
      }

      const { activeTargetId: _activeTargetId, ...sessionWithoutActiveTarget } = session;
      await this.browserSessionStore.put({
        ...sessionWithoutActiveTarget,
        targetIds: nextTargetIds,
        status:
          emptySessionStatus === "disconnected"
            ? "disconnected"
            : this.isLeaseActive(session, now)
              ? "busy"
              : emptySessionStatus,
        updatedAt: now,
        lastActiveAt: now,
      });
    });
  }

  private async getOrCreateProfile(ownerType: BrowserProfileOwnerType, ownerId: string): Promise<BrowserProfile> {
    return this.withScopeLock(ownerType, ownerId, async () => {
      const existing = await this.browserProfileStore.findByOwner(ownerType, ownerId);
      if (existing) {
        return existing;
      }

      const now = this.now();
      const profileId = this.createId("profile");
      const profile: BrowserProfile = {
        profileId,
        ownerType,
        ownerId,
        persistentDir: `${this.profileRootDir}/${encodeURIComponent(profileId)}/chrome-profile`,
        loginState: "unknown",
        createdAt: now,
        updatedAt: now,
      };

      await this.browserProfileStore.put(profile);
      return profile;
    });
  }

  private async withOwnerLock<T>(ownerType: BrowserSessionOwnerType, ownerId: string, work: () => Promise<T>): Promise<T> {
    return this.ownerMutex.run(`${ownerType}:${ownerId}`, work);
  }

  private async withScopeLock<T>(
    ownerType: BrowserProfileOwnerType,
    ownerId: string,
    work: () => Promise<T>
  ): Promise<T> {
    return this.profileMutex.run(`${ownerType}:${ownerId}`, work);
  }

  private async withSessionLock<T>(browserSessionId: string, work: () => Promise<T>): Promise<T> {
    return this.sessionMutex.run(browserSessionId, work);
  }

  private async claimSessionLease(
    input: BrowserSessionResumeInput,
    profileOverride?: BrowserProfile
  ): Promise<BrowserSessionLease> {
    return this.withSessionLock(input.browserSessionId, async () => {
      const session = await this.browserSessionStore.get(input.browserSessionId);
      if (!session) {
        throw new Error(`browser session not found: ${input.browserSessionId}`);
      }

      this.assertOwnerAccess(session, input);

      const profile = profileOverride ?? (await this.browserProfileStore.get(session.profileId));
      if (!profile) {
        throw new Error(`browser profile not found: ${session.profileId}`);
      }

      if (session.status === "closed") {
        throw new Error(`browser session not found: ${input.browserSessionId}`);
      }

      const now = this.now();
      if (
        this.isLeaseActive(session, now) &&
        session.leaseHolderRunKey &&
        session.leaseHolderRunKey !== input.leaseHolderRunKey
      ) {
        throw new Error(`browser session lease conflict: ${input.browserSessionId}`);
      }

      const next: BrowserSession = {
        ...(input.leaseHolderRunKey ? session : this.stripSessionLease(session)),
        status: "busy",
        updatedAt: now,
        lastActiveAt: now,
        ...(input.leaseHolderRunKey
          ? {
              leaseHolderRunKey: input.leaseHolderRunKey,
              leaseExpiresAt: now + (input.leaseTtlMs ?? DEFAULT_SESSION_LEASE_TTL_MS),
            }
          : {}),
      };
      await this.browserSessionStore.put(next);
      return { session: next, profile };
    });
  }

  private assertOwnerAccess(session: BrowserSession, input: Pick<BrowserSessionResumeInput, "ownerType" | "ownerId">): void {
    if (!input.ownerType && !input.ownerId) {
      return;
    }

    if (input.ownerType !== session.ownerType || input.ownerId !== session.ownerId) {
      throw new Error(`browser session owner mismatch: ${session.browserSessionId}`);
    }
  }

  private isLeaseActive(session: Pick<BrowserSession, "leaseHolderRunKey" | "leaseExpiresAt">, now: number): boolean {
    return Boolean(session.leaseHolderRunKey && session.leaseExpiresAt && session.leaseExpiresAt > now);
  }

  private deriveIdleStatus(session: BrowserSession, now: number): BrowserSession["status"] {
    if (session.status === "closed") {
      return "closed";
    }
    if (this.isLeaseActive(session, now)) {
      return "busy";
    }
    if (session.status === "disconnected") {
      return "disconnected";
    }
    return "ready";
  }

  private stripSessionLease(session: BrowserSession): Omit<BrowserSession, "leaseHolderRunKey" | "leaseExpiresAt"> {
    const { leaseHolderRunKey: _leaseHolderRunKey, leaseExpiresAt: _leaseExpiresAt, ...rest } = session;
    return rest;
  }

  private stripTargetLease(target: BrowserTarget): Omit<BrowserTarget, "leaseHolderRunKey" | "leaseExpiresAt"> {
    const { leaseHolderRunKey: _leaseHolderRunKey, leaseExpiresAt: _leaseExpiresAt, ...rest } = target;
    return rest;
  }
}
