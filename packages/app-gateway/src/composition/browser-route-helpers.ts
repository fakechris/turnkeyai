// Browser route helpers used by the daemon's HTTP request handler.
// Lifted out of daemon.ts as part of P1.5c. Each helper closes over
// teamThreadStore / browserBridge / clock from the foundations layer; we wrap
// them in a single factory so the HTTP handler can take one cohesive helpers
// object instead of four loose function references.

import type {
  BrowserSessionOwnerType,
  BrowserTaskAction,
  BrowserTaskRequest,
  Clock,
  IdGenerator,
  TeamThreadStore,
} from "@turnkeyai/core-types/team";
import type { BrowserTransportAdapter } from "@turnkeyai/browser-bridge/transport/transport-adapter";

import type { BrowserTaskRouteBody } from "../routes/browser-routes";

export interface BrowserRouteHelpersDeps {
  teamThreadStore: TeamThreadStore;
  browserBridge: BrowserTransportAdapter;
  clock: Clock;
}

export type ResolveBrowserThreadOwnerInput = {
  threadId: string | null | undefined;
  ownerType?: string | null;
  ownerId?: string | null;
};

export type ResolveBrowserThreadOwnerResult =
  | { ownerType: BrowserSessionOwnerType; ownerId: string; threadId: string }
  | { statusCode: number; error: string };

export type RequireBrowserSessionAccessInput = {
  browserSessionId: string;
  threadId: string | null | undefined;
};

export type RequireBrowserSessionAccessResult =
  | { sessionId: string; threadId: string; ownerType: BrowserSessionOwnerType; ownerId: string }
  | { statusCode: number; error: string };

export interface BuildBrowserTaskRequestInput {
  body: BrowserTaskRouteBody;
  idGenerator: IdGenerator;
  owner: { ownerType?: BrowserSessionOwnerType; ownerId?: string };
  browserSessionId?: string;
}

export interface BrowserRouteHelpers {
  resolveBrowserThreadOwner(input: ResolveBrowserThreadOwnerInput): Promise<ResolveBrowserThreadOwnerResult>;
  requireBrowserSessionAccess(input: RequireBrowserSessionAccessInput): Promise<RequireBrowserSessionAccessResult>;
  buildBrowserTaskRequest(input: BuildBrowserTaskRequestInput): BrowserTaskRequest;
  buildBrowserTaskActions(body: BrowserTaskRouteBody): BrowserTaskAction[];
}

export function createBrowserRouteHelpers(deps: BrowserRouteHelpersDeps): BrowserRouteHelpers {
  const { teamThreadStore, browserBridge, clock } = deps;

  async function resolveBrowserThreadOwner(
    input: ResolveBrowserThreadOwnerInput
  ): Promise<ResolveBrowserThreadOwnerResult> {
    const threadId = input.threadId?.trim();
    if (!threadId) {
      return { statusCode: 400, error: "threadId is required" };
    }

    const thread = await teamThreadStore.get(threadId);
    if (!thread) {
      return { statusCode: 404, error: "thread not found" };
    }

    if (!input.ownerType && !input.ownerId) {
      return {
        threadId,
        ownerType: "thread",
        ownerId: threadId,
      };
    }

    if (!input.ownerType || !input.ownerId) {
      return { statusCode: 400, error: "ownerType and ownerId must be provided together" };
    }

    if (input.ownerType === "thread") {
      if (input.ownerId !== threadId) {
        return { statusCode: 403, error: "thread ownerId must match threadId" };
      }
      return {
        threadId,
        ownerType: "thread",
        ownerId: threadId,
      };
    }

    if (input.ownerType === "role") {
      if (!thread.roles.some((role) => role.roleId === input.ownerId)) {
        return { statusCode: 403, error: "role ownerId must belong to thread" };
      }
      return {
        threadId,
        ownerType: "role",
        ownerId: input.ownerId,
      };
    }

    return { statusCode: 403, error: `unsupported browser ownerType: ${input.ownerType}` };
  }

  async function requireBrowserSessionAccess(
    input: RequireBrowserSessionAccessInput
  ): Promise<RequireBrowserSessionAccessResult> {
    const owner = await resolveBrowserThreadOwner({
      threadId: input.threadId,
    });
    if ("error" in owner) {
      return owner;
    }

    const session =
      (await browserBridge.listSessions()).find((item) => item.browserSessionId === input.browserSessionId) ?? null;
    if (!session) {
      return { statusCode: 404, error: "browser session not found" };
    }

    if (session.ownerType === "thread") {
      if (session.ownerId !== owner.threadId) {
        return { statusCode: 403, error: "browser session does not belong to thread" };
      }
    } else if (session.ownerType === "role") {
      if (!session.ownerId || !session.ownerId.length) {
        return { statusCode: 403, error: "browser session role owner is invalid" };
      }
      const thread = await teamThreadStore.get(owner.threadId);
      if (!thread?.roles.some((role) => role.roleId === session.ownerId)) {
        return { statusCode: 403, error: "browser session role owner does not belong to thread" };
      }
    } else {
      return { statusCode: 403, error: "browser session owner type is not externally addressable" };
    }

    return {
      sessionId: session.browserSessionId,
      threadId: owner.threadId,
      ownerType: session.ownerType,
      ownerId: session.ownerId,
    };
  }

  function buildBrowserTaskRequest(input: BuildBrowserTaskRequestInput): BrowserTaskRequest {
    const threadId = input.body.threadId ?? input.owner.ownerId ?? `browser-thread:${clock.now()}`;
    const actions = buildBrowserTaskActions(input.body);
    return {
      taskId: input.body.taskId ?? input.idGenerator.taskId(),
      threadId,
      instructions:
        input.body.instructions ??
        (input.body.url
          ? `Open ${input.body.url}`
          : input.browserSessionId
            ? "Resume browser session"
            : "Open browser session"),
      actions,
      ...(input.browserSessionId ? { browserSessionId: input.browserSessionId } : {}),
      ...(input.body.targetId ? { targetId: input.body.targetId } : {}),
      ...(input.owner.ownerType ? { ownerType: input.owner.ownerType } : {}),
      ...(input.owner.ownerId ? { ownerId: input.owner.ownerId } : {}),
      ...(input.body.profileOwnerType ? { profileOwnerType: input.body.profileOwnerType } : {}),
      ...(input.body.profileOwnerId ? { profileOwnerId: input.body.profileOwnerId } : {}),
      ...(input.body.leaseHolderRunKey ? { leaseHolderRunKey: input.body.leaseHolderRunKey } : {}),
      ...(input.body.leaseTtlMs !== undefined ? { leaseTtlMs: input.body.leaseTtlMs } : {}),
    };
  }

  function buildBrowserTaskActions(body: BrowserTaskRouteBody): BrowserTaskAction[] {
    if (Array.isArray(body.actions) && body.actions.length > 0) {
      return body.actions;
    }

    if (body.url) {
      return [
        { kind: "open", url: body.url },
        { kind: "snapshot", note: "browser-session-runtime" },
      ];
    }

    return [{ kind: "snapshot", note: "resume-current-target" }];
  }

  return {
    resolveBrowserThreadOwner,
    requireBrowserSessionAccess,
    buildBrowserTaskRequest,
    buildBrowserTaskActions,
  };
}
