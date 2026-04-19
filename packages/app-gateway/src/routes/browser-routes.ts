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
  MAX_BROWSER_CDP_ACTION_EVENT_NAMES,
  MAX_BROWSER_CDP_ACTION_EVENT_TIMEOUT_MS,
  MAX_BROWSER_CDP_ACTION_EVENTS,
  MAX_BROWSER_CDP_ACTION_PARAMS_BYTES,
  MAX_BROWSER_CDP_ACTION_TIMEOUT_MS,
  MAX_BROWSER_COOKIE_NAME_LENGTH,
  MAX_BROWSER_COOKIE_VALUE_BYTES,
  MAX_BROWSER_DIALOG_TIMEOUT_MS,
  MAX_BROWSER_DOWNLOAD_TIMEOUT_MS,
  MAX_BROWSER_DOWNLOAD_URL_PATTERN_LENGTH,
  MAX_BROWSER_EVAL_EXPRESSION_BYTES,
  MAX_BROWSER_EVAL_TIMEOUT_MS,
  MAX_BROWSER_KEY_ACTION_KEY_LENGTH,
  MAX_BROWSER_NETWORK_METHOD_LENGTH,
  MAX_BROWSER_NETWORK_TIMEOUT_MS,
  MAX_BROWSER_NETWORK_URL_PATTERN_LENGTH,
  MAX_BROWSER_PERMISSION_ORIGIN_LENGTH,
  MAX_BROWSER_POPUP_TIMEOUT_MS,
  MAX_BROWSER_PROBE_ITEMS,
  MAX_BROWSER_STORAGE_KEY_LENGTH,
  MAX_BROWSER_STORAGE_VALUE_BYTES,
  MAX_BROWSER_UPLOAD_ARTIFACT_ID_LENGTH,
  MAX_BROWSER_WAIT_FOR_PATTERN_LENGTH,
  MAX_BROWSER_WAIT_FOR_TIMEOUT_MS,
  isBlockedBrowserCdpMethod,
  normalizeBrowserCdpMethod,
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
  closeSession(browserSessionId: string, reason?: string): Promise<void>;
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

  const browserSessionRevokeMatch = url.pathname.match(/^\/browser-sessions\/([^/]+)\/revoke$/);
  if (req.method === "POST" && browserSessionRevokeMatch) {
    const bodyResult = await readOptionalJsonBodySafe<{
      threadId?: string;
      reason?: string;
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    if (body.reason !== undefined && !parseOptionalRouteString(body.reason)) {
      sendJson(res, 400, { error: "reason must be a non-empty string when provided" });
      return true;
    }
    const access = await deps.requireBrowserSessionAccess({
      browserSessionId: decodeURIComponent(browserSessionRevokeMatch[1]!),
      threadId: body.threadId,
    });
    if ("error" in access) {
      sendJson(res, access.statusCode, { error: access.error });
      return true;
    }
    const reason = parseOptionalRouteString(body.reason) ?? "operator revoked browser session";
    await deps.browserBridge.closeSession(access.sessionId, reason);
    sendJson(res, 200, {
      browserSessionId: access.sessionId,
      status: "closed",
      reason,
    });
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
const BROWSER_PROBES = new Set<Extract<BrowserTaskAction, { kind: "probe" }>["probe"]>([
  "page-state",
  "forms",
  "links",
  "downloads",
]);
const BROWSER_PERMISSION_ACTIONS = new Set(["grant", "deny", "reset"]);
const BROWSER_PERMISSION_NAMES = new Set<Extract<BrowserTaskAction, { kind: "permission"; action: "grant" | "deny" }>["permissions"][number]>([
  "geolocation",
  "notifications",
  "camera",
  "microphone",
  "clipboard-read",
  "clipboard-write",
]);
const BROWSER_SCROLL_DIRECTIONS = new Set<Extract<BrowserTaskAction, { kind: "scroll" }>["direction"]>([
  "up",
  "down",
]);
const BROWSER_WAIT_FOR_STATES = new Set(["visible", "hidden", "attached", "detached"]);
const BROWSER_KEY_MODIFIERS = new Set(["Alt", "Control", "Meta", "Shift"]);
const BROWSER_STORAGE_AREAS = new Set(["localStorage", "sessionStorage"]);
const BROWSER_STORAGE_ACTIONS = new Set(["get", "set", "remove", "clear"]);
const BROWSER_COOKIE_ACTIONS = new Set(["get", "set", "remove", "clear"]);
const BROWSER_COOKIE_SAME_SITE_VALUES = new Set(["Strict", "Lax", "None"]);
const BROWSER_NETWORK_ACTIONS = new Set(["waitForResponse"]);
const BROWSER_NETWORK_METHOD_PATTERN = /^[A-Z]+$/;

function validateBrowserTaskRouteBody(body: BrowserTaskRouteBody, route: BrowserTaskMutationRoute): string | null {
  if ((route === "send" || route === "resume") && (body.ownerType !== undefined || body.ownerId !== undefined)) {
    return "ownerType and ownerId are not accepted for existing browser sessions";
  }

  if ((route === "send" || route === "resume") && (body.profileOwnerType !== undefined || body.profileOwnerId !== undefined)) {
    return "profileOwnerType and profileOwnerId are not accepted for existing browser sessions";
  }

  if (body.leaseHolderRunKey !== undefined || body.leaseTtlMs !== undefined) {
    return "leaseHolderRunKey and leaseTtlMs are managed by browser session runtime and are not accepted by browser routes";
  }

  if (body.taskId !== undefined && !parseOptionalRouteString(body.taskId)) {
    return "taskId must be a non-empty string when provided";
  }

  if (body.instructions !== undefined && !parseOptionalRouteString(body.instructions)) {
    return "instructions must be a non-empty string when provided";
  }

  if (body.ownerType !== undefined && !EXTERNALLY_ADDRESSABLE_BROWSER_OWNER_TYPES.has(body.ownerType)) {
    return `unsupported browser ownerType: ${String(body.ownerType)}`;
  }

  if (body.ownerId !== undefined && !parseOptionalRouteString(body.ownerId)) {
    return "ownerId must be a non-empty string when provided";
  }

  if (body.profileOwnerType !== undefined && !EXTERNALLY_ADDRESSABLE_BROWSER_OWNER_TYPES.has(body.profileOwnerType)) {
    return `unsupported browser profileOwnerType: ${String(body.profileOwnerType)}`;
  }

  if (body.profileOwnerId !== undefined && !parseOptionalRouteString(body.profileOwnerId)) {
    return "profileOwnerId must be a non-empty string when provided";
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
        const targetError = validateTargetedAction(action, `actions[${index}] click`);
        if (targetError) return targetError;
        break;
      }
      case "hover": {
        const targetError = validateTargetedAction(action, `actions[${index}] hover`);
        if (targetError) return targetError;
        break;
      }
      case "key": {
        const key = parseOptionalRouteString(action.key);
        if (!key) {
          return `actions[${index}] key.key must be a non-empty string`;
        }
        if (key.length > MAX_BROWSER_KEY_ACTION_KEY_LENGTH) {
          return `actions[${index}] key.key must be <= ${MAX_BROWSER_KEY_ACTION_KEY_LENGTH} characters`;
        }
        if (action.modifiers !== undefined) {
          if (!Array.isArray(action.modifiers)) {
            return `actions[${index}] key.modifiers must be an array when provided`;
          }
          if (action.modifiers.length > BROWSER_KEY_MODIFIERS.size) {
            return `actions[${index}] key.modifiers has too many entries`;
          }
          for (const modifier of action.modifiers) {
            if (!BROWSER_KEY_MODIFIERS.has(modifier)) {
              return `actions[${index}] key.modifiers contains an invalid modifier`;
            }
          }
        }
        break;
      }
      case "select": {
        const selectError = validateSelectAction(action, `actions[${index}] select`);
        if (selectError) return selectError;
        break;
      }
      case "drag": {
        const dragError = validateDragAction(action, `actions[${index}] drag`);
        if (dragError) return dragError;
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
      case "probe": {
        const probeError = validateProbeAction(action, `actions[${index}] probe`);
        if (probeError) return probeError;
        break;
      }
      case "permission": {
        const permissionError = validatePermissionAction(action, `actions[${index}] permission`);
        if (permissionError) return permissionError;
        break;
      }
      case "wait": {
        if (!Number.isInteger(action.timeoutMs) || action.timeoutMs <= 0) {
          return `actions[${index}] wait.timeoutMs must be a positive integer`;
        }
        break;
      }
      case "waitFor": {
        const waitForError = validateWaitForAction(action, `actions[${index}] waitFor`);
        if (waitForError) return waitForError;
        break;
      }
      case "dialog": {
        const dialogError = validateDialogAction(action, `actions[${index}] dialog`);
        if (dialogError) return dialogError;
        break;
      }
      case "popup": {
        const popupError = validatePopupAction(action, `actions[${index}] popup`);
        if (popupError) return popupError;
        break;
      }
      case "storage": {
        const storageError = validateStorageAction(action, `actions[${index}] storage`);
        if (storageError) return storageError;
        break;
      }
      case "cookie": {
        const cookieError = validateCookieAction(action, `actions[${index}] cookie`);
        if (cookieError) return cookieError;
        break;
      }
      case "eval": {
        const evalError = validateEvalAction(action, `actions[${index}] eval`);
        if (evalError) return evalError;
        break;
      }
      case "network": {
        const networkError = validateNetworkAction(action, `actions[${index}] network`);
        if (networkError) return networkError;
        break;
      }
      case "download": {
        const downloadError = validateDownloadAction(action, `actions[${index}] download`);
        if (downloadError) return downloadError;
        break;
      }
      case "upload": {
        const uploadError = validateUploadAction(action, `actions[${index}] upload`);
        if (uploadError) return uploadError;
        break;
      }
      case "screenshot": {
        if (action.label !== undefined && !parseOptionalRouteString(action.label)) {
          return `actions[${index}] screenshot.label must be a non-empty string when provided`;
        }
        break;
      }
      case "cdp": {
        const method = normalizeBrowserCdpMethod(action.method);
        if (!method) {
          return `actions[${index}] cdp.method must be a valid CDP Domain.method string`;
        }
        if (isBlockedBrowserCdpMethod(method)) {
          return `actions[${index}] cdp.method is not allowed on browser task routes`;
        }
        if (action.params !== undefined) {
          if (!isPlainRecord(action.params)) {
            return `actions[${index}] cdp.params must be an object when provided`;
          }
          const byteLength = Buffer.byteLength(JSON.stringify(action.params), "utf8");
          if (byteLength > MAX_BROWSER_CDP_ACTION_PARAMS_BYTES) {
            return `actions[${index}] cdp.params exceeds ${MAX_BROWSER_CDP_ACTION_PARAMS_BYTES} bytes`;
          }
        }
        if (
          action.timeoutMs !== undefined &&
          (!Number.isInteger(action.timeoutMs) ||
            action.timeoutMs <= 0 ||
            action.timeoutMs > MAX_BROWSER_CDP_ACTION_TIMEOUT_MS)
        ) {
          return `actions[${index}] cdp.timeoutMs must be a positive integer <= ${MAX_BROWSER_CDP_ACTION_TIMEOUT_MS}`;
        }
        if (action.events !== undefined) {
          const eventsError = validateBrowserCdpEvents(action.events, `actions[${index}] cdp.events`);
          if (eventsError) {
            return eventsError;
          }
        }
        break;
      }
      default:
        return `actions[${index}] kind is invalid`;
    }
  }

  return null;
}

function validateBrowserCdpEvents(events: unknown, label: string): string | null {
  if (!isPlainRecord(events)) {
    return `${label} must be an object when provided`;
  }

  if (events.waitFor !== undefined) {
    const waitFor = normalizeBrowserCdpMethod(events.waitFor);
    if (!waitFor) {
      return `${label}.waitFor must be a valid CDP Domain.event string`;
    }
    if (isBlockedBrowserCdpMethod(waitFor)) {
      return `${label}.waitFor is not allowed on browser task routes`;
    }
  }

  if (events.include !== undefined) {
    if (!Array.isArray(events.include) || events.include.length === 0) {
      return `${label}.include must be a non-empty array when provided`;
    }
    if (events.include.length > MAX_BROWSER_CDP_ACTION_EVENT_NAMES) {
      return `${label}.include must contain at most ${MAX_BROWSER_CDP_ACTION_EVENT_NAMES} events`;
    }
    for (const eventName of events.include) {
      const normalized = normalizeBrowserCdpMethod(eventName);
      if (!normalized) {
        return `${label}.include must contain valid CDP Domain.event strings`;
      }
      if (isBlockedBrowserCdpMethod(normalized)) {
        return `${label}.include contains an event that is not allowed on browser task routes`;
      }
    }
  }

  const timeoutMs = events.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_BROWSER_CDP_ACTION_EVENT_TIMEOUT_MS)
  ) {
    return `${label}.timeoutMs must be a positive integer <= ${MAX_BROWSER_CDP_ACTION_EVENT_TIMEOUT_MS}`;
  }

  const maxEvents = events.maxEvents;
  if (
    maxEvents !== undefined &&
    (typeof maxEvents !== "number" ||
      !Number.isInteger(maxEvents) ||
      maxEvents <= 0 ||
      maxEvents > MAX_BROWSER_CDP_ACTION_EVENTS)
  ) {
    return `${label}.maxEvents must be a positive integer <= ${MAX_BROWSER_CDP_ACTION_EVENTS}`;
  }

  return null;
}

function validateActionSelectors(selectors: unknown, label: string): string | null {
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

function validateTargetedAction(
  action: {
    selectors?: unknown;
    refId?: unknown;
    text?: unknown;
  },
  label: string
): string | null {
  const selectorError = validateActionSelectors(action.selectors, `${label}.selectors`);
  if (selectorError) {
    return selectorError;
  }
  const refId = parseOptionalRouteString(action.refId);
  const text = parseOptionalRouteString(action.text);
  const hasSelectors = Array.isArray(action.selectors) && action.selectors.length > 0;
  const variants = Number(hasSelectors) + Number(Boolean(refId)) + Number(Boolean(text));
  if (variants !== 1) {
    return `${label} requires exactly one of selectors, refId, or text`;
  }
  if (action.refId !== undefined && !refId) {
    return `${label}.refId must be a non-empty string when provided`;
  }
  if (action.text !== undefined && !text) {
    return `${label}.text must be a non-empty string when provided`;
  }
  return null;
}

function validateSelectAction(
  action: {
    selectors?: string[];
    refId?: string;
    value?: string;
    label?: string;
    index?: number;
  },
  label: string
): string | null {
  const selectorError = validateActionSelectors(action.selectors, `${label}.selectors`);
  if (selectorError) {
    return selectorError;
  }
  const refId = parseOptionalRouteString(action.refId);
  const targetVariants = Number(Boolean(action.selectors?.length)) + Number(Boolean(refId));
  if (targetVariants !== 1) {
    return `${label} requires exactly one of selectors or refId`;
  }
  if (action.refId !== undefined && !refId) {
    return `${label}.refId must be a non-empty string when provided`;
  }

  const value = parseOptionalRouteString(action.value);
  const optionLabel = parseOptionalRouteString(action.label);
  const indexValue = action.index;
  const hasIndex = indexValue !== undefined;
  const optionVariants = Number(Boolean(value)) + Number(Boolean(optionLabel)) + Number(hasIndex);
  if (optionVariants !== 1) {
    return `${label} requires exactly one of value, label, or index`;
  }
  if (action.value !== undefined && !value) {
    return `${label}.value must be a non-empty string when provided`;
  }
  if (action.label !== undefined && !optionLabel) {
    return `${label}.label must be a non-empty string when provided`;
  }
  if (hasIndex && (!Number.isInteger(indexValue) || indexValue < 0)) {
    return `${label}.index must be a non-negative integer`;
  }
  return null;
}

function validateDragAction(
  action: {
    source?: unknown;
    target?: unknown;
  },
  label: string
): string | null {
  if (!isPlainRecord(action.source)) {
    return `${label}.source must be an object`;
  }
  if (!isPlainRecord(action.target)) {
    return `${label}.target must be an object`;
  }
  const sourceError = validateTargetedAction(action.source, `${label}.source`);
  if (sourceError) {
    return sourceError;
  }
  const targetError = validateTargetedAction(action.target, `${label}.target`);
  if (targetError) {
    return targetError;
  }
  return null;
}

function validateWaitForAction(
  action: {
    selectors?: unknown;
    refId?: unknown;
    text?: unknown;
    state?: unknown;
    urlPattern?: unknown;
    titlePattern?: unknown;
    bodyTextPattern?: unknown;
    timeoutMs?: number;
  },
  label: string
): string | null {
  if (
    action.timeoutMs !== undefined &&
    (!Number.isInteger(action.timeoutMs) || action.timeoutMs <= 0 || action.timeoutMs > MAX_BROWSER_WAIT_FOR_TIMEOUT_MS)
  ) {
    return `${label}.timeoutMs must be a positive integer <= ${MAX_BROWSER_WAIT_FOR_TIMEOUT_MS}`;
  }

  const hasTarget = action.selectors !== undefined || action.refId !== undefined || action.text !== undefined;
  const conditionCount =
    (hasTarget ? 1 : 0) +
    (action.urlPattern !== undefined ? 1 : 0) +
    (action.titlePattern !== undefined ? 1 : 0) +
    (action.bodyTextPattern !== undefined ? 1 : 0);
  if (conditionCount !== 1) {
    return `${label} requires exactly one of selectors, refId, text, urlPattern, titlePattern, or bodyTextPattern`;
  }

  if (hasTarget) {
    const targetError = validateTargetedAction(action, label);
    if (targetError) {
      return targetError;
    }
    if (action.state !== undefined && !BROWSER_WAIT_FOR_STATES.has(action.state as string)) {
      return `${label}.state must be visible, hidden, attached, or detached`;
    }
    return null;
  }

  if (action.state !== undefined) {
    return `${label}.state is only accepted for element targets`;
  }
  const urlPatternError = validateWaitForPattern(action.urlPattern, `${label}.urlPattern`);
  if (action.urlPattern !== undefined && urlPatternError) {
    return urlPatternError;
  }
  const titlePatternError = validateWaitForPattern(action.titlePattern, `${label}.titlePattern`);
  if (action.titlePattern !== undefined && titlePatternError) {
    return titlePatternError;
  }
  const bodyTextPatternError = validateWaitForPattern(action.bodyTextPattern, `${label}.bodyTextPattern`);
  if (action.bodyTextPattern !== undefined && bodyTextPatternError) {
    return bodyTextPatternError;
  }
  return null;
}

function validateWaitForPattern(value: unknown, label: string): string | null {
  const pattern = parseOptionalRouteString(value);
  if (!pattern) {
    return `${label} must be a non-empty string`;
  }
  if (pattern.length > MAX_BROWSER_WAIT_FOR_PATTERN_LENGTH) {
    return `${label} must be <= ${MAX_BROWSER_WAIT_FOR_PATTERN_LENGTH} characters`;
  }
  return null;
}

function validateDialogAction(
  action: {
    action?: unknown;
    promptText?: unknown;
    timeoutMs?: number;
  },
  label: string
): string | null {
  if (action.action !== "accept" && action.action !== "dismiss") {
    return `${label}.action must be accept or dismiss`;
  }
  const promptText = parseOptionalRouteString(action.promptText);
  if (action.promptText !== undefined && !promptText) {
    return `${label}.promptText must be a non-empty string when provided`;
  }
  if (action.promptText !== undefined && action.action !== "accept") {
    return `${label}.promptText is only supported when action is accept`;
  }
  if (
    action.timeoutMs !== undefined &&
    (!Number.isInteger(action.timeoutMs) || action.timeoutMs <= 0 || action.timeoutMs > MAX_BROWSER_DIALOG_TIMEOUT_MS)
  ) {
    return `${label}.timeoutMs must be a positive integer <= ${MAX_BROWSER_DIALOG_TIMEOUT_MS}`;
  }
  return null;
}

function validatePopupAction(
  action: {
    timeoutMs?: number;
  },
  label: string
): string | null {
  if (
    action.timeoutMs !== undefined &&
    (!Number.isInteger(action.timeoutMs) || action.timeoutMs <= 0 || action.timeoutMs > MAX_BROWSER_POPUP_TIMEOUT_MS)
  ) {
    return `${label}.timeoutMs must be a positive integer <= ${MAX_BROWSER_POPUP_TIMEOUT_MS}`;
  }
  return null;
}

function validateStorageAction(
  action: {
    area?: unknown;
    action?: unknown;
    key?: unknown;
    value?: unknown;
  },
  label: string
): string | null {
  if (!BROWSER_STORAGE_AREAS.has(action.area as string)) {
    return `${label}.area must be localStorage or sessionStorage`;
  }
  if (!BROWSER_STORAGE_ACTIONS.has(action.action as string)) {
    return `${label}.action must be get, set, remove, or clear`;
  }

  const storageAction = action.action as string;
  const key = parseOptionalRouteString(action.key);
  if ((storageAction === "set" || storageAction === "remove") && !key) {
    return `${label}.key must be a non-empty string for ${storageAction}`;
  }
  if (storageAction === "clear" && action.key !== undefined) {
    return `${label}.key is not accepted for clear`;
  }
  if (action.key !== undefined) {
    if (!key) {
      return `${label}.key must be a non-empty string when provided`;
    }
    if (key.length > MAX_BROWSER_STORAGE_KEY_LENGTH) {
      return `${label}.key must be <= ${MAX_BROWSER_STORAGE_KEY_LENGTH} characters`;
    }
  }

  if (storageAction === "set") {
    if (typeof action.value !== "string") {
      return `${label}.value must be a string for set`;
    }
    if (Buffer.byteLength(action.value, "utf8") > MAX_BROWSER_STORAGE_VALUE_BYTES) {
      return `${label}.value exceeds ${MAX_BROWSER_STORAGE_VALUE_BYTES} bytes`;
    }
  } else if (action.value !== undefined) {
    return `${label}.value is only accepted for set`;
  }

  return null;
}

function validateProbeAction(
  action: {
    probe?: unknown;
    maxItems?: unknown;
  },
  label: string
): string | null {
  if (!BROWSER_PROBES.has(action.probe as Extract<BrowserTaskAction, { kind: "probe" }>["probe"])) {
    return `${label}.probe is invalid`;
  }
  if (
    action.maxItems !== undefined &&
    (typeof action.maxItems !== "number" ||
      !Number.isInteger(action.maxItems) ||
      action.maxItems <= 0 ||
      action.maxItems > MAX_BROWSER_PROBE_ITEMS)
  ) {
    return `${label}.maxItems must be a positive integer <= ${MAX_BROWSER_PROBE_ITEMS}`;
  }
  return null;
}

function validatePermissionAction(
  action: {
    action?: unknown;
    permissions?: unknown;
    origin?: unknown;
  },
  label: string
): string | null {
  if (!BROWSER_PERMISSION_ACTIONS.has(action.action as string)) {
    return `${label}.action must be grant, deny, or reset`;
  }
  if (action.action === "reset") {
    if (action.permissions !== undefined || action.origin !== undefined) {
      return `${label}.permissions and .origin are not accepted for reset`;
    }
    return null;
  }

  if (!Array.isArray(action.permissions) || action.permissions.length === 0) {
    return `${label}.permissions must be a non-empty array for ${String(action.action)}`;
  }
  if (action.permissions.length > BROWSER_PERMISSION_NAMES.size) {
    return `${label}.permissions has too many entries`;
  }
  for (const permission of action.permissions) {
    if (
      !BROWSER_PERMISSION_NAMES.has(
        permission as Extract<BrowserTaskAction, { kind: "permission"; action: "grant" | "deny" }>["permissions"][number]
      )
    ) {
      return `${label}.permissions contains an invalid permission`;
    }
  }

  const origin = parseOptionalRouteString(action.origin);
  if (action.origin !== undefined) {
    if (!origin) {
      return `${label}.origin must be a non-empty string when provided`;
    }
    if (origin.length > MAX_BROWSER_PERMISSION_ORIGIN_LENGTH) {
      return `${label}.origin must be <= ${MAX_BROWSER_PERMISSION_ORIGIN_LENGTH} characters`;
    }
    if (!isHttpUrl(origin)) {
      return `${label}.origin must be an http(s) URL`;
    }
  }

  return null;
}

function validateCookieAction(
  action: {
    action?: unknown;
    name?: unknown;
    value?: unknown;
    url?: unknown;
    domain?: unknown;
    path?: unknown;
    secure?: unknown;
    httpOnly?: unknown;
    sameSite?: unknown;
    expires?: unknown;
  },
  label: string
): string | null {
  if (!BROWSER_COOKIE_ACTIONS.has(action.action as string)) {
    return `${label}.action must be get, set, remove, or clear`;
  }

  const cookieAction = action.action as string;
  const name = parseOptionalRouteString(action.name);
  if ((cookieAction === "set" || cookieAction === "remove") && !name) {
    return `${label}.name must be a non-empty string for ${cookieAction}`;
  }
  if (action.name !== undefined) {
    if (!name) {
      return `${label}.name must be a non-empty string when provided`;
    }
    if (name.length > MAX_BROWSER_COOKIE_NAME_LENGTH) {
      return `${label}.name must be <= ${MAX_BROWSER_COOKIE_NAME_LENGTH} characters`;
    }
  }

  const url = parseOptionalRouteString(action.url);
  if (action.url !== undefined) {
    if (!url) {
      return `${label}.url must be a non-empty string when provided`;
    }
    if (!isHttpUrl(url)) {
      return `${label}.url must be an http(s) URL`;
    }
  }

  const domain = parseOptionalRouteString(action.domain);
  if (action.domain !== undefined && !domain) {
    return `${label}.domain must be a non-empty string when provided`;
  }
  const path = parseOptionalRouteString(action.path);
  if (action.path !== undefined) {
    if (!path) {
      return `${label}.path must be a non-empty string when provided`;
    }
    if (!path.startsWith("/")) {
      return `${label}.path must start with /`;
    }
  }

  if (cookieAction === "set") {
    if (typeof action.value !== "string") {
      return `${label}.value must be a string for set`;
    }
    if (Buffer.byteLength(action.value, "utf8") > MAX_BROWSER_COOKIE_VALUE_BYTES) {
      return `${label}.value exceeds ${MAX_BROWSER_COOKIE_VALUE_BYTES} bytes`;
    }
    if (action.secure !== undefined && typeof action.secure !== "boolean") {
      return `${label}.secure must be a boolean when provided`;
    }
    if (action.httpOnly !== undefined && typeof action.httpOnly !== "boolean") {
      return `${label}.httpOnly must be a boolean when provided`;
    }
    if (action.sameSite !== undefined && !BROWSER_COOKIE_SAME_SITE_VALUES.has(action.sameSite as string)) {
      return `${label}.sameSite must be Strict, Lax, or None`;
    }
    if (
      action.expires !== undefined &&
      (typeof action.expires !== "number" || !Number.isInteger(action.expires) || action.expires <= 0)
    ) {
      return `${label}.expires must be a positive integer unix timestamp when provided`;
    }
  } else {
    if (action.value !== undefined) {
      return `${label}.value is only accepted for set`;
    }
    if (action.secure !== undefined || action.httpOnly !== undefined || action.sameSite !== undefined || action.expires !== undefined) {
      return `${label}.set-only fields are only accepted for set`;
    }
  }

  if (cookieAction === "get" && (action.domain !== undefined || action.path !== undefined)) {
    return `${label}.domain and .path are not accepted for get`;
  }
  if (cookieAction === "clear" && action.name !== undefined) {
    return `${label}.name is not accepted for clear`;
  }

  return null;
}

function validateEvalAction(
  action: {
    expression?: unknown;
    awaitPromise?: unknown;
    timeoutMs?: unknown;
  },
  label: string
): string | null {
  const expression = parseOptionalRouteString(action.expression);
  if (!expression) {
    return `${label}.expression must be a non-empty string`;
  }
  if (Buffer.byteLength(expression, "utf8") > MAX_BROWSER_EVAL_EXPRESSION_BYTES) {
    return `${label}.expression exceeds ${MAX_BROWSER_EVAL_EXPRESSION_BYTES} bytes`;
  }
  if (action.awaitPromise !== undefined && typeof action.awaitPromise !== "boolean") {
    return `${label}.awaitPromise must be a boolean when provided`;
  }
  if (
    action.timeoutMs !== undefined &&
    (typeof action.timeoutMs !== "number" ||
      !Number.isInteger(action.timeoutMs) ||
      action.timeoutMs <= 0 ||
      action.timeoutMs > MAX_BROWSER_EVAL_TIMEOUT_MS)
  ) {
    return `${label}.timeoutMs must be a positive integer <= ${MAX_BROWSER_EVAL_TIMEOUT_MS}`;
  }
  return null;
}

function validateNetworkAction(
  action: {
    action?: unknown;
    urlPattern?: unknown;
    method?: unknown;
    status?: unknown;
    timeoutMs?: unknown;
  },
  label: string
): string | null {
  if (!BROWSER_NETWORK_ACTIONS.has(action.action as string)) {
    return `${label}.action must be waitForResponse`;
  }
  const urlPattern = parseOptionalRouteString(action.urlPattern);
  if (action.urlPattern !== undefined) {
    if (!urlPattern) {
      return `${label}.urlPattern must be a non-empty string when provided`;
    }
    if (urlPattern.length > MAX_BROWSER_NETWORK_URL_PATTERN_LENGTH) {
      return `${label}.urlPattern must be <= ${MAX_BROWSER_NETWORK_URL_PATTERN_LENGTH} characters`;
    }
  }
  const method = parseOptionalRouteString(action.method);
  if (action.method !== undefined) {
    if (!method) {
      return `${label}.method must be a non-empty string when provided`;
    }
    if (method.length > MAX_BROWSER_NETWORK_METHOD_LENGTH || !BROWSER_NETWORK_METHOD_PATTERN.test(method)) {
      return `${label}.method must be uppercase ASCII and <= ${MAX_BROWSER_NETWORK_METHOD_LENGTH} characters`;
    }
  }
  if (
    action.status !== undefined &&
    (typeof action.status !== "number" || !Number.isInteger(action.status) || action.status < 100 || action.status > 599)
  ) {
    return `${label}.status must be an integer HTTP status between 100 and 599 when provided`;
  }
  if (
    action.timeoutMs !== undefined &&
    (typeof action.timeoutMs !== "number" ||
      !Number.isInteger(action.timeoutMs) ||
      action.timeoutMs <= 0 ||
      action.timeoutMs > MAX_BROWSER_NETWORK_TIMEOUT_MS)
  ) {
    return `${label}.timeoutMs must be a positive integer <= ${MAX_BROWSER_NETWORK_TIMEOUT_MS}`;
  }
  return null;
}

function validateDownloadAction(
  action: {
    urlPattern?: unknown;
    timeoutMs?: unknown;
    path?: unknown;
    artifactId?: unknown;
    file?: unknown;
    dataBase64?: unknown;
  },
  label: string
): string | null {
  const urlPattern = parseOptionalRouteString(action.urlPattern);
  if (action.urlPattern !== undefined) {
    if (!urlPattern) {
      return `${label}.urlPattern must be a non-empty string when provided`;
    }
    if (urlPattern.length > MAX_BROWSER_DOWNLOAD_URL_PATTERN_LENGTH) {
      return `${label}.urlPattern must be <= ${MAX_BROWSER_DOWNLOAD_URL_PATTERN_LENGTH} characters`;
    }
  }
  if (
    action.timeoutMs !== undefined &&
    (typeof action.timeoutMs !== "number" ||
      !Number.isInteger(action.timeoutMs) ||
      action.timeoutMs <= 0 ||
      action.timeoutMs > MAX_BROWSER_DOWNLOAD_TIMEOUT_MS)
  ) {
    return `${label}.timeoutMs must be a positive integer <= ${MAX_BROWSER_DOWNLOAD_TIMEOUT_MS}`;
  }
  if (
    action.path !== undefined ||
    action.artifactId !== undefined ||
    action.file !== undefined ||
    action.dataBase64 !== undefined
  ) {
    return `${label} does not accept path, artifactId, file, or dataBase64 fields`;
  }
  return null;
}

function validateUploadAction(
  action: {
    selectors?: unknown;
    refId?: unknown;
    text?: unknown;
    artifactId?: unknown;
    file?: unknown;
  },
  label: string
): string | null {
  const targetError = validateTargetedAction(action, label);
  if (targetError) {
    return targetError;
  }
  const artifactId = parseOptionalRouteString(action.artifactId);
  if (!artifactId) {
    return `${label}.artifactId must be a non-empty string`;
  }
  if (artifactId.length > MAX_BROWSER_UPLOAD_ARTIFACT_ID_LENGTH) {
    return `${label}.artifactId must be <= ${MAX_BROWSER_UPLOAD_ARTIFACT_ID_LENGTH} characters`;
  }
  if (action.file !== undefined) {
    return `${label}.file is injected by relay transport and is not accepted by browser routes`;
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
