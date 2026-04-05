import type http from "node:http";

import type {
  BrowserSessionOwnerType,
  BrowserTaskAction,
  BrowserTaskRequest,
  BrowserTaskResult,
  Clock,
  IdGenerator,
} from "@turnkeyai/core-types/team";

import {
  parsePositiveLimit,
  parseRequiredNonEmptyString,
  readJsonBody,
  readOptionalJsonBody,
  sendJson,
} from "../http-helpers";

export interface BrowserTaskRouteBody {
  threadId?: string;
  taskId?: string;
  instructions?: string;
  url?: string;
  targetId?: string;
  actions?: BrowserTaskAction[];
  ownerType?: BrowserSessionOwnerType;
  ownerId?: string;
  profileOwnerType?: BrowserSessionOwnerType;
  profileOwnerId?: string;
  leaseHolderRunKey?: string;
  leaseTtlMs?: number;
}

interface BrowserBridgeDeps {
  spawnSession(input: BrowserTaskRequest): Promise<BrowserTaskResult>;
  listSessions(input?: { ownerType?: BrowserSessionOwnerType; ownerId?: string }): Promise<unknown[]>;
  getSessionHistory(input: { browserSessionId: string; limit?: number }): Promise<unknown>;
  listTargets(browserSessionId: string): Promise<unknown>;
  openTarget(
    browserSessionId: string,
    url: string,
    owner?: { ownerType?: BrowserSessionOwnerType; ownerId?: string }
  ): Promise<unknown>;
  sendSession(input: BrowserTaskRequest & { browserSessionId: string }): Promise<BrowserTaskResult>;
  resumeSession(input: BrowserTaskRequest & { browserSessionId: string }): Promise<BrowserTaskResult>;
  activateTarget(
    browserSessionId: string,
    targetId: string,
    owner?: { ownerType?: BrowserSessionOwnerType; ownerId?: string }
  ): Promise<unknown>;
  closeTarget(
    browserSessionId: string,
    targetId: string,
    owner?: { ownerType?: BrowserSessionOwnerType; ownerId?: string }
  ): Promise<unknown>;
  evictIdleSessions(input: { idleBefore: number; reason?: string }): Promise<unknown>;
}

export interface BrowserRouteDeps {
  browserBridge: BrowserBridgeDeps;
  idGenerator: IdGenerator;
  clock: Clock;
  resolveBrowserThreadOwner(input: {
    threadId: string | null | undefined;
    ownerType?: string | null;
    ownerId?: string | null;
  }): Promise<
    | { ownerType: BrowserSessionOwnerType; ownerId: string; threadId: string }
    | { statusCode: number; error: string }
  >;
  requireBrowserSessionAccess(input: {
    browserSessionId: string;
    threadId: string | null | undefined;
  }): Promise<
    | {
        sessionId: string;
        threadId: string;
        ownerType: BrowserSessionOwnerType;
        ownerId: string;
      }
    | { statusCode: number; error: string }
  >;
  buildBrowserTaskRequest(input: {
    body: BrowserTaskRouteBody;
    idGenerator: IdGenerator;
    owner: { ownerType?: BrowserSessionOwnerType; ownerId?: string };
    browserSessionId?: string;
  }): BrowserTaskRequest;
}

export async function handleBrowserRoutes(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  deps: BrowserRouteDeps;
}): Promise<boolean> {
  const { req, res, url, deps } = input;

  if (req.method === "POST" && url.pathname === "/browser-sessions/spawn") {
    const body = await readJsonBody<BrowserTaskRouteBody>(req);
    const owner = await deps.resolveBrowserThreadOwner({
      threadId: body.threadId,
      ...(body.ownerType ? { ownerType: body.ownerType } : {}),
      ...(body.ownerId ? { ownerId: body.ownerId } : {}),
    });
    if ("error" in owner) {
      sendJson(res, owner.statusCode, { error: owner.error });
      return true;
    }
    const request = deps.buildBrowserTaskRequest({
      body,
      idGenerator: deps.idGenerator,
      owner,
    });
    sendJson(res, 201, await deps.browserBridge.spawnSession(request));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/browser-sessions") {
    const ownerType = url.searchParams.get("ownerType");
    const ownerId = url.searchParams.get("ownerId");
    const owner = await deps.resolveBrowserThreadOwner({
      threadId: url.searchParams.get("threadId"),
      ...(ownerType ? { ownerType } : {}),
      ...(ownerId ? { ownerId } : {}),
    });
    if ("error" in owner) {
      sendJson(res, owner.statusCode, { error: owner.error });
      return true;
    }
    sendJson(
      res,
      200,
      await deps.browserBridge.listSessions({
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      })
    );
    return true;
  }

  const browserSessionHistoryMatch = url.pathname.match(/^\/browser-sessions\/([^/]+)\/history$/);
  if (req.method === "GET" && browserSessionHistoryMatch) {
    const access = await deps.requireBrowserSessionAccess({
      browserSessionId: decodeURIComponent(browserSessionHistoryMatch[1]!),
      threadId: url.searchParams.get("threadId"),
    });
    if ("error" in access) {
      sendJson(res, access.statusCode, { error: access.error });
      return true;
    }
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit === null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(
      res,
      200,
      await deps.browserBridge.getSessionHistory({
        browserSessionId: access.sessionId,
        limit,
      })
    );
    return true;
  }

  const browserSessionTargetsMatch = url.pathname.match(/^\/browser-sessions\/([^/]+)\/targets$/);
  if (req.method === "GET" && browserSessionTargetsMatch) {
    const access = await deps.requireBrowserSessionAccess({
      browserSessionId: decodeURIComponent(browserSessionTargetsMatch[1]!),
      threadId: url.searchParams.get("threadId"),
    });
    if ("error" in access) {
      sendJson(res, access.statusCode, { error: access.error });
      return true;
    }
    sendJson(res, 200, await deps.browserBridge.listTargets(access.sessionId));
    return true;
  }

  if (req.method === "POST" && browserSessionTargetsMatch) {
    const body = await readJsonBody<{
      url: string;
      threadId?: string;
    }>(req);
    const urlValue = parseRequiredNonEmptyString(body.url);
    if (!urlValue) {
      sendJson(res, 400, { error: "url is required" });
      return true;
    }
    const access = await deps.requireBrowserSessionAccess({
      browserSessionId: decodeURIComponent(browserSessionTargetsMatch[1]!),
      threadId: body.threadId,
    });
    if ("error" in access) {
      sendJson(res, access.statusCode, { error: access.error });
      return true;
    }
    sendJson(
      res,
      201,
      await deps.browserBridge.openTarget(access.sessionId, urlValue, {
        ownerType: access.ownerType,
        ownerId: access.ownerId,
      })
    );
    return true;
  }

  const browserSessionSendMatch = url.pathname.match(/^\/browser-sessions\/([^/]+)\/send$/);
  if (req.method === "POST" && browserSessionSendMatch) {
    const body = await readJsonBody<BrowserTaskRouteBody>(req);
    const access = await deps.requireBrowserSessionAccess({
      browserSessionId: decodeURIComponent(browserSessionSendMatch[1]!),
      threadId: body.threadId,
    });
    if ("error" in access) {
      sendJson(res, access.statusCode, { error: access.error });
      return true;
    }
    const request = deps.buildBrowserTaskRequest({
      body,
      idGenerator: deps.idGenerator,
      browserSessionId: access.sessionId,
      owner: {
        ownerType: access.ownerType,
        ownerId: access.ownerId,
      },
    });
    sendJson(
      res,
      200,
      await deps.browserBridge.sendSession({ ...request, browserSessionId: request.browserSessionId! })
    );
    return true;
  }

  const browserSessionResumeMatch = url.pathname.match(/^\/browser-sessions\/([^/]+)\/resume$/);
  if (req.method === "POST" && browserSessionResumeMatch) {
    const body = await readJsonBody<BrowserTaskRouteBody>(req);
    const access = await deps.requireBrowserSessionAccess({
      browserSessionId: decodeURIComponent(browserSessionResumeMatch[1]!),
      threadId: body.threadId,
    });
    if ("error" in access) {
      sendJson(res, access.statusCode, { error: access.error });
      return true;
    }
    const request = deps.buildBrowserTaskRequest({
      body,
      idGenerator: deps.idGenerator,
      browserSessionId: access.sessionId,
      owner: {
        ownerType: access.ownerType,
        ownerId: access.ownerId,
      },
    });
    sendJson(
      res,
      200,
      await deps.browserBridge.resumeSession({ ...request, browserSessionId: request.browserSessionId! })
    );
    return true;
  }

  const browserSessionActivateMatch = url.pathname.match(/^\/browser-sessions\/([^/]+)\/activate-target$/);
  if (req.method === "POST" && browserSessionActivateMatch) {
    const body = await readJsonBody<{
      targetId: string;
      threadId?: string;
    }>(req);
    const targetId = parseRequiredNonEmptyString(body.targetId);
    if (!targetId) {
      sendJson(res, 400, { error: "targetId is required" });
      return true;
    }
    const access = await deps.requireBrowserSessionAccess({
      browserSessionId: decodeURIComponent(browserSessionActivateMatch[1]!),
      threadId: body.threadId,
    });
    if ("error" in access) {
      sendJson(res, access.statusCode, { error: access.error });
      return true;
    }
    sendJson(
      res,
      200,
      await deps.browserBridge.activateTarget(access.sessionId, targetId, {
        ownerType: access.ownerType,
        ownerId: access.ownerId,
      })
    );
    return true;
  }

  const browserSessionCloseTargetMatch = url.pathname.match(/^\/browser-sessions\/([^/]+)\/close-target$/);
  if (req.method === "POST" && browserSessionCloseTargetMatch) {
    const body = await readJsonBody<{
      targetId: string;
      threadId?: string;
    }>(req);
    const targetId = parseRequiredNonEmptyString(body.targetId);
    if (!targetId) {
      sendJson(res, 400, { error: "targetId is required" });
      return true;
    }
    const access = await deps.requireBrowserSessionAccess({
      browserSessionId: decodeURIComponent(browserSessionCloseTargetMatch[1]!),
      threadId: body.threadId,
    });
    if ("error" in access) {
      sendJson(res, access.statusCode, { error: access.error });
      return true;
    }
    sendJson(
      res,
      200,
      await deps.browserBridge.closeTarget(access.sessionId, targetId, {
        ownerType: access.ownerType,
        ownerId: access.ownerId,
      })
    );
    return true;
  }

  if (req.method === "POST" && url.pathname === "/browser-sessions/evict-idle") {
    const body = await readOptionalJsonBody<{ idleMs?: number; idleBefore?: number; reason?: string }>(req);
    const idleBefore = body.idleBefore ?? deps.clock.now() - (body.idleMs ?? 30 * 60 * 1000);
    sendJson(
      res,
      200,
      await deps.browserBridge.evictIdleSessions({
        idleBefore,
        ...(body.reason ? { reason: body.reason } : {}),
      })
    );
    return true;
  }

  return false;
}
