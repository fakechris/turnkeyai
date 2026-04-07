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
  readJsonBodySafe,
  readOptionalJsonBodySafe,
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

type BrowserTaskMutationRoute = "spawn" | "send" | "resume";

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
    const bodyResult = await readJsonBodySafe<BrowserTaskRouteBody>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const validationError = validateBrowserTaskRouteBody(body, "spawn");
    if (validationError) {
      sendJson(res, 400, { error: validationError });
      return true;
    }
    const owner = await deps.resolveBrowserThreadOwner({
      threadId: body.threadId,
      ...(body.ownerType ? { ownerType: body.ownerType } : {}),
      ...(body.ownerId ? { ownerId: body.ownerId } : {}),
    });
    if ("error" in owner) {
      sendJson(res, owner.statusCode, { error: owner.error });
      return true;
    }
    const ownershipError = validateBrowserTaskRouteOwnership(body, owner);
    if (ownershipError) {
      sendJson(res, 400, { error: ownershipError });
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
    const bodyResult = await readJsonBodySafe<{
      url: string;
      threadId?: string;
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
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
    const bodyResult = await readJsonBodySafe<BrowserTaskRouteBody>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const validationError = validateBrowserTaskRouteBody(body, "send");
    if (validationError) {
      sendJson(res, 400, { error: validationError });
      return true;
    }
    const access = await deps.requireBrowserSessionAccess({
      browserSessionId: decodeURIComponent(browserSessionSendMatch[1]!),
      threadId: body.threadId,
    });
    if ("error" in access) {
      sendJson(res, access.statusCode, { error: access.error });
      return true;
    }
    const ownershipError = validateBrowserTaskRouteOwnership(body, access);
    if (ownershipError) {
      sendJson(res, 400, { error: ownershipError });
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
    const bodyResult = await readJsonBodySafe<BrowserTaskRouteBody>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const validationError = validateBrowserTaskRouteBody(body, "resume");
    if (validationError) {
      sendJson(res, 400, { error: validationError });
      return true;
    }
    const access = await deps.requireBrowserSessionAccess({
      browserSessionId: decodeURIComponent(browserSessionResumeMatch[1]!),
      threadId: body.threadId,
    });
    if ("error" in access) {
      sendJson(res, access.statusCode, { error: access.error });
      return true;
    }
    const ownershipError = validateBrowserTaskRouteOwnership(body, access);
    if (ownershipError) {
      sendJson(res, 400, { error: ownershipError });
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
    const bodyResult = await readJsonBodySafe<{
      targetId: string;
      threadId?: string;
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
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
    const bodyResult = await readJsonBodySafe<{
      targetId: string;
      threadId?: string;
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
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
    const bodyResult = await readOptionalJsonBodySafe<{ idleMs?: number; idleBefore?: number; reason?: string }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    if (body.idleMs !== undefined && (!Number.isFinite(body.idleMs) || body.idleMs <= 0)) {
      sendJson(res, 400, { error: "idleMs must be a positive number" });
      return true;
    }
    if (body.idleBefore !== undefined && (!Number.isFinite(body.idleBefore) || body.idleBefore <= 0)) {
      sendJson(res, 400, { error: "idleBefore must be a positive number" });
      return true;
    }
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

const EXTERNALLY_ADDRESSABLE_BROWSER_OWNER_TYPES = new Set<BrowserSessionOwnerType>(["thread", "role"]);
const BROWSER_CONSOLE_PROBES = new Set<Extract<BrowserTaskAction, { kind: "console" }>["probe"]>([
  "page-metadata",
  "interactive-summary",
]);
const BROWSER_SCROLL_DIRECTIONS = new Set<Extract<BrowserTaskAction, { kind: "scroll" }>["direction"]>([
  "up",
  "down",
]);

function validateBrowserTaskRouteBody(body: BrowserTaskRouteBody, route: BrowserTaskMutationRoute): string | null {
  if ((route === "send" || route === "resume") && (body.ownerType !== undefined || body.ownerId !== undefined)) {
    return "ownerType and ownerId are not accepted for existing browser sessions";
  }

  if (body.ownerType !== undefined && !EXTERNALLY_ADDRESSABLE_BROWSER_OWNER_TYPES.has(body.ownerType)) {
    return `unsupported browser ownerType: ${String(body.ownerType)}`;
  }

  if (body.profileOwnerType !== undefined && !EXTERNALLY_ADDRESSABLE_BROWSER_OWNER_TYPES.has(body.profileOwnerType)) {
    return `unsupported browser profileOwnerType: ${String(body.profileOwnerType)}`;
  }

  const targetId = parseOptionalRouteString(body.targetId);
  if (body.targetId !== undefined && !targetId) {
    return "targetId must be a non-empty string";
  }

  if (route === "spawn" && targetId) {
    return "targetId is not accepted when spawning a browser session";
  }

  const urlValue = parseOptionalRouteString(body.url);
  if (body.url !== undefined && !urlValue) {
    return "url must be a non-empty string";
  }

  if (body.actions !== undefined) {
    if (!Array.isArray(body.actions) || body.actions.length === 0) {
      return "actions must be a non-empty array";
    }
    const actionError = validateBrowserTaskActions(body.actions);
    if (actionError) {
      return actionError;
    }
    if (urlValue) {
      return "url cannot be combined with explicit actions";
    }
    if (targetId && body.actions.some((action) => action.kind === "open")) {
      return "targetId cannot be combined with open actions";
    }
  }

  if (
    body.leaseTtlMs !== undefined &&
    (!Number.isInteger(body.leaseTtlMs) || body.leaseTtlMs <= 0)
  ) {
    return "leaseTtlMs must be a positive integer";
  }

  if ((body.profileOwnerType === undefined) !== (body.profileOwnerId === undefined)) {
    return "profileOwnerType and profileOwnerId must be provided together";
  }

  return null;
}

function validateBrowserTaskRouteOwnership(
  body: BrowserTaskRouteBody,
  owner: { ownerType: BrowserSessionOwnerType; ownerId: string; threadId: string }
): string | null {
  if (body.profileOwnerType === undefined && body.profileOwnerId === undefined) {
    return null;
  }

  if (body.profileOwnerType !== owner.ownerType || body.profileOwnerId !== owner.ownerId) {
    return "profile owner must match the resolved browser owner";
  }

  return null;
}

function validateBrowserTaskActions(actions: BrowserTaskAction[]): string | null {
  for (const [index, action] of actions.entries()) {
    if (!action || typeof action !== "object") {
      return `actions[${index}] must be an object`;
    }

    switch (action.kind) {
      case "open": {
        const url = parseOptionalRouteString(action.url);
        if (!url) {
          return `actions[${index}] open.url must be a non-empty string`;
        }
        if (!isHttpUrl(url)) {
          return `actions[${index}] open.url must use http or https`;
        }
        break;
      }
      case "snapshot": {
        if (action.note !== undefined && !parseOptionalRouteString(action.note)) {
          return `actions[${index}] snapshot.note must be a non-empty string when provided`;
        }
        break;
      }
      case "type": {
        if (!parseOptionalRouteString(action.text)) {
          return `actions[${index}] type.text must be a non-empty string`;
        }
        const selectorError = validateActionSelectors(action.selectors, `actions[${index}] type.selectors`);
        if (selectorError) {
          return selectorError;
        }
        const refId = parseOptionalRouteString(action.refId);
        if (!refId && !action.selectors?.length) {
          return `actions[${index}] type requires refId or selectors`;
        }
        if (action.refId !== undefined && !refId) {
          return `actions[${index}] type.refId must be a non-empty string when provided`;
        }
        if (action.submit !== undefined && typeof action.submit !== "boolean") {
          return `actions[${index}] type.submit must be a boolean`;
        }
        break;
      }
      case "click": {
        const selectorError = validateActionSelectors(action.selectors, `actions[${index}] click.selectors`);
        if (selectorError) {
          return selectorError;
        }
        const refId = parseOptionalRouteString(action.refId);
        const text = parseOptionalRouteString(action.text);
        const variants = Number(Boolean(action.selectors?.length)) + Number(Boolean(refId)) + Number(Boolean(text));
        if (variants !== 1) {
          return `actions[${index}] click requires exactly one of selectors, refId, or text`;
        }
        if (action.refId !== undefined && !refId) {
          return `actions[${index}] click.refId must be a non-empty string when provided`;
        }
        if (action.text !== undefined && !text) {
          return `actions[${index}] click.text must be a non-empty string when provided`;
        }
        break;
      }
      case "scroll": {
        if (!BROWSER_SCROLL_DIRECTIONS.has(action.direction)) {
          return `actions[${index}] scroll.direction must be up or down`;
        }
        if (action.amount !== undefined && (!Number.isInteger(action.amount) || action.amount <= 0)) {
          return `actions[${index}] scroll.amount must be a positive integer`;
        }
        break;
      }
      case "console": {
        if (!BROWSER_CONSOLE_PROBES.has(action.probe)) {
          return `actions[${index}] console.probe is invalid`;
        }
        break;
      }
      case "wait": {
        if (!Number.isInteger(action.timeoutMs) || action.timeoutMs <= 0) {
          return `actions[${index}] wait.timeoutMs must be a positive integer`;
        }
        break;
      }
      case "screenshot": {
        if (action.label !== undefined && !parseOptionalRouteString(action.label)) {
          return `actions[${index}] screenshot.label must be a non-empty string when provided`;
        }
        break;
      }
      default:
        return `actions[${index}] kind is invalid`;
    }
  }

  return null;
}

function validateActionSelectors(selectors: string[] | undefined, label: string): string | null {
  if (selectors === undefined) {
    return null;
  }
  if (!Array.isArray(selectors) || selectors.length === 0) {
    return `${label} must be a non-empty array`;
  }
  if (selectors.some((selector) => !parseOptionalRouteString(selector))) {
    return `${label} must contain non-empty strings`;
  }
  return null;
}

function parseOptionalRouteString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
