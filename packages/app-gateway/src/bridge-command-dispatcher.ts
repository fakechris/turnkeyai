import { createHash } from "node:crypto";

import type {
  BrowserOwnerType,
  BrowserRawCdpExpertLane,
  BrowserSessionOwnerType,
  BrowserTaskAction,
  BrowserTaskRequest,
  BrowserTaskResult,
  Clock,
  IdGenerator,
} from "@turnkeyai/core-types/team";

export const TIER1_TOOLS = new Set([
  "navigate",
  "snapshot",
  "click",
  "fill",
  "key",
  "select",
  "screenshot",
  "eval",
  "wait_for",
  "upload",
  "list_tabs",
  "switch_tab",
  "close_tab",
]);

export const TIER2_TOOLS = new Set([
  "hover",
  "scroll",
  "drag",
  "dialog",
  "popup",
  "download",
  "storage",
  "cookie",
  "permission",
  "probe",
  "console",
  "pdf",
  "click_coord",
  "screenshot_clip",
  "find_tab",
  "network_capture",
  "network_mock",
  "network_block",
  "network_set_headers",
  "network_emulate",
]);

export type BridgeCommandInput = {
  token: string | null;
  tool: string;
  args?: Record<string, unknown> | null;
  sessionId?: string | null;
  threadId?: string | null;
  instructions?: string | null;
};

export type BridgeCommandResponse = {
  status: number;
  body: Record<string, unknown>;
};

export interface BridgeBrowserBridgeDeps {
  spawnSession(input: BrowserTaskRequest): Promise<BrowserTaskResult>;
  sendSession(input: BrowserTaskRequest & { browserSessionId: string }): Promise<BrowserTaskResult>;
  listTargets(browserSessionId: string): Promise<unknown>;
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
}

export interface BridgeAmbientSessionStore {
  get(token: string | null): string | null;
  set(token: string | null, sessionId: string): void;
  clear(token: string | null): void;
}

export function createInMemoryAmbientSessionStore(): BridgeAmbientSessionStore {
  const map = new Map<string, string>();
  const keyFor = (token: string | null) => token ?? "__anonymous__";
  return {
    get: (token) => map.get(keyFor(token)) ?? null,
    set: (token, sessionId) => {
      map.set(keyFor(token), sessionId);
    },
    clear: (token) => {
      map.delete(keyFor(token));
    },
  };
}

export interface BridgeCommandDispatcherOptions {
  bridge: BridgeBrowserBridgeDeps;
  ambient: BridgeAmbientSessionStore;
  idGenerator: IdGenerator;
  clock: Clock;
  expertLaneAvailable?: () => boolean;
  allowedTools?: ReadonlySet<string>;
  buildAction?: BridgeActionBuilder;
}

export type BridgeActionBuilder = (
  tool: string,
  args: Record<string, unknown>
) => BridgeActionBuildResult;

export type BridgeActionBuildResult =
  | { action: BrowserTaskAction; instructions: string }
  | { actions: BrowserTaskAction[]; instructions: string }
  | { error: string };

/**
 * Internal helper: a builder may return either a single action or a sequence
 * (e.g. `click_coord` emits press + release). Callers should use this helper
 * to normalize before pushing into a BrowserTaskRequest.actions array.
 */
function builtActionsAsList(
  built: { action: BrowserTaskAction } | { actions: BrowserTaskAction[] }
): BrowserTaskAction[] {
  if ("actions" in built) {
    return built.actions;
  }
  return [built.action];
}

export interface BridgeCommandDispatcher {
  dispatch(input: BridgeCommandInput): Promise<BridgeCommandResponse>;
}

export function createBridgeCommandDispatcher(
  options: BridgeCommandDispatcherOptions
): BridgeCommandDispatcher {
  const allowed = options.allowedTools ?? TIER1_TOOLS;
  const buildAction = options.buildAction ?? buildTier1Action;
  return {
    async dispatch(input: BridgeCommandInput): Promise<BridgeCommandResponse> {
      const tool = (input.tool ?? "").trim();
      if (!tool) {
        return errorResponse(400, "tool is required", "invalid_request");
      }
      if (!allowed.has(tool)) {
        return errorResponse(404, `unknown tool: ${tool}`, "unknown_tool");
      }

      const args = isRecord(input.args) ? input.args : {};
      const owner: { ownerType: BrowserOwnerType; ownerId: string } = {
        ownerType: "user",
        ownerId: deriveAmbientOwnerId(input.token),
      };

      if (tool === "list_tabs" || tool === "find_tab") {
        const sessionId = await ensureSession({ input, owner, options });
        if (typeof sessionId !== "string") return sessionId;
        try {
          const rawTargets = await options.bridge.listTargets(sessionId);
          const targets = Array.isArray(rawTargets)
            ? (rawTargets as Array<Record<string, unknown>>)
            : [];
          if (tool === "find_tab") {
            const filtered = filterTargets(targets, args);
            return successResponse({ sessionId, tool, result: filtered });
          }
          return successResponse({ sessionId, tool, result: targets });
        } catch (error) {
          return mapErrorResponse(error, `${tool} failed`);
        }
      }

      if (tool === "switch_tab" || tool === "close_tab") {
        const targetId = toRequiredString(args.targetId);
        if (!targetId) {
          return errorResponse(400, `${tool} requires args.targetId`, "invalid_request");
        }
        const sessionId = await ensureSession({ input, owner, options });
        if (typeof sessionId !== "string") return sessionId;
        try {
          const result =
            tool === "switch_tab"
              ? await options.bridge.activateTarget(sessionId, targetId, owner)
              : await options.bridge.closeTarget(sessionId, targetId, owner);
          return successResponse({ sessionId, tool, result });
        } catch (error) {
          return mapErrorResponse(error, `${tool} failed`);
        }
      }

      const built = buildAction(tool, args);
      if ("error" in built) {
        return errorResponse(400, built.error, "invalid_request");
      }

      return dispatchActionRequest({
        input,
        owner,
        tool,
        built,
        options,
      });
    },
  };
}

export async function dispatchActionRequest(args: {
  input: BridgeCommandInput;
  owner: { ownerType: BrowserOwnerType; ownerId: string };
  tool: string;
  built:
    | { action: BrowserTaskAction; instructions: string }
    | { actions: BrowserTaskAction[]; instructions: string };
  options: BridgeCommandDispatcherOptions;
}): Promise<BridgeCommandResponse> {
  const sessionId =
    args.input.sessionId?.trim() || args.options.ambient.get(args.input.token);

  const taskRequest: BrowserTaskRequest = {
    taskId: args.options.idGenerator.taskId(),
    threadId: args.input.threadId?.trim() || `bridge-ambient:${args.owner.ownerId}`,
    instructions: args.input.instructions?.trim() || args.built.instructions,
    actions: builtActionsAsList(args.built),
    ownerType: args.owner.ownerType,
    ownerId: args.owner.ownerId,
    ...(sessionId ? { browserSessionId: sessionId } : {}),
  };

  try {
    const result = sessionId
      ? await args.options.bridge.sendSession({
          ...taskRequest,
          browserSessionId: sessionId,
        })
      : await args.options.bridge.spawnSession(taskRequest);

    const resolvedSessionId = result?.sessionId ?? sessionId ?? null;
    if (resolvedSessionId) {
      args.options.ambient.set(args.input.token, resolvedSessionId);
    }

    return successResponse({
      sessionId: resolvedSessionId,
      tool: args.tool,
      result: shapeTaskResultForFacade(result),
    });
  } catch (error) {
    return mapErrorResponse(error, `${args.tool} failed`);
  }
}

export interface BridgeBatchInput {
  token: string | null;
  actions: Array<{ tool: string; args?: Record<string, unknown> | null }>;
  sessionId?: string | null;
  threadId?: string | null;
  instructions?: string | null;
}

export function createBridgeBatchDispatcher(
  options: BridgeCommandDispatcherOptions
): { dispatch(input: BridgeBatchInput): Promise<BridgeCommandResponse> } {
  const buildAction = options.buildAction ?? buildTier1Action;
  const allowed =
    options.allowedTools ?? new Set([...TIER1_TOOLS, ...TIER2_TOOLS]);
  return {
    async dispatch(input: BridgeBatchInput): Promise<BridgeCommandResponse> {
      if (!Array.isArray(input.actions) || input.actions.length === 0) {
        return errorResponse(400, "batch requires non-empty actions[]", "invalid_request");
      }
      const owner: { ownerType: BrowserOwnerType; ownerId: string } = {
        ownerType: "user",
        ownerId: deriveAmbientOwnerId(input.token),
      };
      const taskActions: BrowserTaskAction[] = [];
      const instructions: string[] = [];
      for (const [index, entry] of input.actions.entries()) {
        const tool = (entry.tool ?? "").trim();
        if (!tool) {
          return errorResponse(400, `actions[${index}] is missing tool`, "invalid_request");
        }
        if (!allowed.has(tool)) {
          return errorResponse(400, `actions[${index}].tool not allowed in batch: ${tool}`, "invalid_request");
        }
        if (tool === "list_tabs" || tool === "find_tab" || tool === "switch_tab" || tool === "close_tab") {
          return errorResponse(
            400,
            `actions[${index}].tool '${tool}' cannot be batched; call /bridge/command separately`,
            "invalid_request"
          );
        }
        const built = buildAction(tool, isRecord(entry.args) ? entry.args : {});
        if ("error" in built) {
          return errorResponse(400, `actions[${index}]: ${built.error}`, "invalid_request");
        }
        taskActions.push(...builtActionsAsList(built));
        instructions.push(built.instructions);
      }

      const sessionId =
        input.sessionId?.trim() || options.ambient.get(input.token);
      const taskRequest: BrowserTaskRequest = {
        taskId: options.idGenerator.taskId(),
        threadId: input.threadId?.trim() || `bridge-ambient:${owner.ownerId}`,
        instructions: input.instructions?.trim() || instructions.join(" → "),
        actions: taskActions,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        ...(sessionId ? { browserSessionId: sessionId } : {}),
      };
      try {
        const result = sessionId
          ? await options.bridge.sendSession({ ...taskRequest, browserSessionId: sessionId })
          : await options.bridge.spawnSession(taskRequest);
        const resolvedSessionId = result?.sessionId ?? sessionId ?? null;
        if (resolvedSessionId) {
          options.ambient.set(input.token, resolvedSessionId);
        }
        return successResponse({
          sessionId: resolvedSessionId,
          tool: "batch",
          result: shapeTaskResultForFacade(result),
        });
      } catch (error) {
        return mapErrorResponse(error, "batch failed");
      }
    },
  };
}

export interface BridgeExpertDispatcherOptions {
  expertLane: BrowserRawCdpExpertLane | null;
  ambient: BridgeAmbientSessionStore;
  bridge: BridgeBrowserBridgeDeps;
  idGenerator: IdGenerator;
}

export interface BridgeExpertInput {
  token: string | null;
  tool: string;
  args?: Record<string, unknown> | null;
  sessionId?: string | null;
}

export function createBridgeExpertDispatcher(
  options: BridgeExpertDispatcherOptions
): { dispatch(input: BridgeExpertInput): Promise<BridgeCommandResponse> } {
  return {
    async dispatch(input: BridgeExpertInput): Promise<BridgeCommandResponse> {
      if (!options.expertLane) {
        return errorResponse(
          409,
          "expert lane requires direct-cdp transport",
          "expert_lane_unavailable"
        );
      }
      const tool = (input.tool ?? "").trim();
      const args = isRecord(input.args) ? input.args : {};
      const sessionId = input.sessionId?.trim() || options.ambient.get(input.token);
      if (!sessionId) {
        return errorResponse(400, "expert tools require a sessionId or active ambient session", "invalid_request");
      }
      try {
        switch (tool) {
          case "expert.list_targets": {
            return successResponse({
              tool,
              result: await options.expertLane.listExpertTargets(sessionId),
            });
          }
          case "expert.attach": {
            const targetId = toRequiredString(args.targetId);
            if (!targetId) return errorResponse(400, "expert.attach requires args.targetId", "invalid_request");
            return successResponse({
              tool,
              result: await options.expertLane.attachExpertTarget({
                browserSessionId: sessionId,
                targetId,
              }),
            });
          }
          case "expert.send": {
            const method = toRequiredString(args.method);
            if (!method) return errorResponse(400, "expert.send requires args.method", "invalid_request");
            const params = isRecord(args.params) ? args.params : undefined;
            const expertSessionId = toOptionalString(args.expertSessionId);
            const targetId = toOptionalString(args.targetId);
            const timeoutMs = toFiniteNumber(args.timeoutMs);
            return successResponse({
              tool,
              result: await options.expertLane.sendExpertCommand({
                browserSessionId: sessionId,
                method,
                ...(params !== undefined ? { params } : {}),
                ...(expertSessionId ? { expertSessionId } : {}),
                ...(targetId ? { targetId } : {}),
                ...(timeoutMs !== null ? { timeoutMs } : {}),
              }),
            });
          }
          case "expert.events": {
            const expertSessionId = toOptionalString(args.expertSessionId);
            const limit = toFiniteNumber(args.limit) ?? 50;
            return successResponse({
              tool,
              result: await options.expertLane.drainExpertEvents({
                browserSessionId: sessionId,
                ...(expertSessionId ? { expertSessionId } : {}),
                limit,
              }),
            });
          }
          case "expert.detach": {
            const expertSessionId = toRequiredString(args.expertSessionId);
            if (!expertSessionId)
              return errorResponse(400, "expert.detach requires args.expertSessionId", "invalid_request");
            return successResponse({
              tool,
              result: await options.expertLane.detachExpertSession({
                browserSessionId: sessionId,
                expertSessionId,
              }),
            });
          }
          default:
            return errorResponse(404, `unknown expert tool: ${tool}`, "unknown_tool");
        }
      } catch (error) {
        return mapErrorResponse(error, `${tool} failed`);
      }
    },
  };
}

async function ensureSession(args: {
  input: BridgeCommandInput;
  owner: { ownerType: BrowserOwnerType; ownerId: string };
  options: BridgeCommandDispatcherOptions;
}): Promise<string | BridgeCommandResponse> {
  const cached = args.input.sessionId?.trim() || args.options.ambient.get(args.input.token);
  if (cached) return cached;
  const spawned = await args.options.bridge.spawnSession({
    taskId: args.options.idGenerator.taskId(),
    threadId: `bridge-ambient:${args.owner.ownerId}`,
    instructions: "ambient bridge session bootstrap",
    actions: [{ kind: "snapshot", note: "bridge-ambient" }],
    ownerType: args.owner.ownerType,
    ownerId: args.owner.ownerId,
  });
  const sessionId = spawned?.sessionId;
  if (!sessionId) {
    return errorResponse(500, "failed to spawn ambient session", "action_failed");
  }
  args.options.ambient.set(args.input.token, sessionId);
  return sessionId;
}

function deriveAmbientOwnerId(token: string | null): string {
  return deriveBridgePrincipal(token);
}

/**
 * Stable per-principal identifier derived from the bridge auth token. Returns
 * `"anonymous"` when no token is present, or a short sha256 hex prefix
 * otherwise. Used both for ambient-session ownership AND for namespacing the
 * /bridge/* idempotency cache so two different agents cannot share each
 * other's cached responses just because they happened to pick the same
 * Idempotency-Key value.
 */
export function deriveBridgePrincipal(token: string | null): string {
  if (!token) return "anonymous";
  return createHash("sha256").update(token).digest("hex").slice(0, 24);
}

export function buildTier1Action(
  tool: string,
  args: Record<string, unknown>
): BridgeActionBuildResult {
  switch (tool) {
    case "navigate": {
      const url = toRequiredString(args.url);
      if (!url) return { error: "navigate requires args.url" };
      return { action: { kind: "open", url }, instructions: `Open ${url}` };
    }
    case "snapshot":
      return {
        action: {
          kind: "snapshot",
          ...(toOptionalString(args.note) ? { note: toOptionalString(args.note)! } : {}),
        },
        instructions: "Take an interactive snapshot",
      };
    case "click": {
      const refId = toOptionalString(args.refId);
      const text = toOptionalString(args.text);
      const selectors = toStringArray(args.selectors);
      if (refId) {
        return {
          action: { kind: "click", refId } as BrowserTaskAction,
          instructions: `Click ref ${refId}`,
        };
      }
      if (text) {
        return {
          action: { kind: "click", text } as BrowserTaskAction,
          instructions: `Click text "${text}"`,
        };
      }
      if (selectors && selectors.length > 0) {
        return {
          action: { kind: "click", selectors } as BrowserTaskAction,
          instructions: `Click selector ${selectors[0]}`,
        };
      }
      return { error: "click requires refId, text, or selectors" };
    }
    case "fill": {
      const text = toOptionalString(args.text) ?? toOptionalString(args.value);
      if (text === undefined) return { error: "fill requires args.text" };
      const refId = toOptionalString(args.refId);
      const selectors = toStringArray(args.selectors);
      const submit = typeof args.submit === "boolean" ? args.submit : undefined;
      if (!refId && (!selectors || selectors.length === 0)) {
        return { error: "fill requires refId or selectors" };
      }
      const base: BrowserTaskAction = {
        kind: "type",
        text,
        ...(refId ? { refId } : {}),
        ...(selectors && selectors.length > 0 ? { selectors } : {}),
        ...(submit !== undefined ? { submit } : {}),
      } as BrowserTaskAction;
      return { action: base, instructions: refId ? `Fill ref ${refId}` : `Fill ${selectors![0]}` };
    }
    case "key": {
      const key = toRequiredString(args.key);
      if (!key) return { error: "key requires args.key" };
      const modifiers = toStringArray(args.modifiers);
      return {
        action: {
          kind: "key",
          key,
          ...(modifiers && modifiers.length > 0 ? { modifiers: modifiers as never } : {}),
        } as BrowserTaskAction,
        instructions: `Press ${key}`,
      };
    }
    case "select": {
      const refId = toOptionalString(args.refId);
      const selectors = toStringArray(args.selectors);
      const value = toOptionalString(args.value);
      const label = toOptionalString(args.label);
      const baseTarget = refId
        ? { refId }
        : selectors && selectors.length > 0
          ? { selectors }
          : null;
      if (!baseTarget) return { error: "select requires refId or selectors" };
      if (value === undefined && label === undefined) {
        return { error: "select requires value or label" };
      }
      return {
        action: {
          kind: "select",
          ...baseTarget,
          ...(value !== undefined ? { value } : {}),
          ...(label !== undefined ? { label } : {}),
        } as BrowserTaskAction,
        instructions: `Select ${value ?? label}`,
      };
    }
    case "screenshot": {
      const label = toOptionalString(args.label);
      return {
        action: { kind: "screenshot", ...(label ? { label } : {}) } as BrowserTaskAction,
        instructions: "Take a screenshot",
      };
    }
    case "eval": {
      const expression = toRequiredString(args.expression);
      if (!expression) return { error: "eval requires args.expression" };
      const awaitPromise = typeof args.awaitPromise === "boolean" ? args.awaitPromise : undefined;
      const timeoutMs = toFiniteNumber(args.timeoutMs);
      return {
        action: {
          kind: "eval",
          expression,
          ...(awaitPromise !== undefined ? { awaitPromise } : {}),
          ...(timeoutMs !== null ? { timeoutMs } : {}),
        } as BrowserTaskAction,
        instructions: "Evaluate expression",
      };
    }
    case "wait_for": {
      // BrowserWaitForAction uses BrowserActionTarget, which expects
      // `selectors: string[]` — NOT `selector: string`. The earlier
      // dispatcher wrote the singular form and produced an action shape
      // the browser executor could not resolve, so wait_for was a
      // silently-broken facade tool. Wrap the single selector into the
      // array the schema actually accepts.
      const action: Record<string, unknown> = { kind: "waitFor" };
      const selector = toOptionalString(args.selector);
      const refId = toOptionalString(args.refId);
      const text = toOptionalString(args.text);
      const urlPattern = toOptionalString(args.urlPattern);
      const timeoutMs = toFiniteNumber(args.timeoutMs);
      if (selector) action.selectors = [selector];
      if (refId) action.refId = refId;
      if (text) action.text = text;
      if (urlPattern) action.urlPattern = urlPattern;
      if (timeoutMs !== null) action.timeoutMs = timeoutMs;
      if (!selector && !refId && !text && !urlPattern) {
        return { error: "wait_for requires selector, refId, text, or urlPattern" };
      }
      return {
        action: action as BrowserTaskAction,
        instructions: `Wait for ${selector ?? refId ?? text ?? urlPattern}`,
      };
    }
    case "upload": {
      const refId = toOptionalString(args.refId);
      const selectors = toStringArray(args.selectors);
      const artifactId = toRequiredString(args.artifactId);
      if (!refId && (!selectors || selectors.length === 0)) {
        return { error: "upload requires refId or selectors" };
      }
      if (!artifactId) return { error: "upload requires args.artifactId" };
      return {
        action: {
          kind: "upload",
          artifactId,
          ...(refId ? { refId } : {}),
          ...(selectors && selectors.length > 0 ? { selectors } : {}),
        } as BrowserTaskAction,
        instructions: `Upload artifact ${artifactId}`,
      };
    }
    default:
      return { error: `tool not implemented in Tier 1: ${tool}` };
  }
}

export function buildTier2Action(
  tool: string,
  args: Record<string, unknown>
): BridgeActionBuildResult {
  switch (tool) {
    case "hover": {
      const refId = toOptionalString(args.refId);
      const text = toOptionalString(args.text);
      const selectors = toStringArray(args.selectors);
      if (refId) {
        return {
          action: { kind: "hover", refId } as BrowserTaskAction,
          instructions: `Hover ref ${refId}`,
        };
      }
      if (text) {
        return {
          action: { kind: "hover", text } as BrowserTaskAction,
          instructions: `Hover text "${text}"`,
        };
      }
      if (selectors && selectors.length > 0) {
        return {
          action: { kind: "hover", selectors } as BrowserTaskAction,
          instructions: `Hover selector ${selectors[0]}`,
        };
      }
      return { error: "hover requires refId, text, or selectors" };
    }
    case "scroll": {
      const direction = args.direction === "up" ? "up" : args.direction === "down" ? "down" : null;
      if (!direction) return { error: "scroll requires args.direction ('up' or 'down')" };
      const amount = toFiniteNumber(args.amount);
      return {
        action: {
          kind: "scroll",
          direction,
          ...(amount !== null && amount > 0 ? { amount } : {}),
        } as BrowserTaskAction,
        instructions: `Scroll ${direction}`,
      };
    }
    case "dialog": {
      const action = args.action === "accept" ? "accept" : args.action === "dismiss" ? "dismiss" : null;
      if (!action) return { error: "dialog requires args.action ('accept' or 'dismiss')" };
      const promptText = toOptionalString(args.promptText);
      const timeoutMs = toFiniteNumber(args.timeoutMs);
      return {
        action: {
          kind: "dialog",
          action,
          ...(promptText !== undefined ? { promptText } : {}),
          ...(timeoutMs !== null ? { timeoutMs } : {}),
        } as BrowserTaskAction,
        instructions: `${action} dialog`,
      };
    }
    case "popup": {
      const timeoutMs = toFiniteNumber(args.timeoutMs);
      return {
        action: {
          kind: "popup",
          ...(timeoutMs !== null ? { timeoutMs } : {}),
        } as BrowserTaskAction,
        instructions: "Arm popup capture",
      };
    }
    case "console": {
      const probe =
        args.probe === "page-metadata" || args.probe === "interactive-summary" ? args.probe : null;
      if (!probe) return { error: "console requires args.probe" };
      return {
        action: { kind: "console", probe } as BrowserTaskAction,
        instructions: `Console probe ${probe}`,
      };
    }
    case "probe": {
      const kind =
        args.kind === "page-state" ||
        args.kind === "forms" ||
        args.kind === "links" ||
        args.kind === "downloads"
          ? args.kind
          : null;
      if (!kind) return { error: "probe requires args.kind" };
      return {
        action: { kind: "probe", probe: kind } as BrowserTaskAction,
        instructions: `Probe ${kind}`,
      };
    }
    case "pdf": {
      const cdpAction: BrowserTaskAction = {
        kind: "cdp",
        method: "Page.printToPDF",
        params: isRecord(args.params) ? args.params : {},
      };
      return { action: cdpAction, instructions: "Print page to PDF" };
    }
    case "click_coord": {
      // A real click is `mousePressed` followed by `mouseReleased`. Many
      // pages only fire the JS `click`/onClick handlers when both events
      // arrive (some only check the release; others require the pair).
      // The earlier implementation only dispatched `mousePressed`, which
      // looked like a click in CDP traces but did nothing observable in
      // the page — silently broken. Emit both events as a sequence so the
      // facade tool actually clicks.
      const x = toFiniteNumber(args.x);
      const y = toFiniteNumber(args.y);
      if (x === null || y === null) return { error: "click_coord requires args.x and args.y" };
      const button = typeof args.button === "string" ? args.button : "left";
      const press: BrowserTaskAction = {
        kind: "cdp",
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x, y, button, clickCount: 1 },
      };
      const release: BrowserTaskAction = {
        kind: "cdp",
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", x, y, button, clickCount: 1 },
      };
      return { actions: [press, release], instructions: `Click coordinates (${x},${y})` };
    }
    case "screenshot_clip": {
      const x = toFiniteNumber(args.x);
      const y = toFiniteNumber(args.y);
      const width = toFiniteNumber(args.width);
      const height = toFiniteNumber(args.height);
      const scale = toFiniteNumber(args.scale) ?? 1;
      if (x === null || y === null || width === null || height === null) {
        return { error: "screenshot_clip requires args.x, .y, .width, .height" };
      }
      const cdpAction: BrowserTaskAction = {
        kind: "cdp",
        method: "Page.captureScreenshot",
        params: { clip: { x, y, width, height, scale } },
      };
      return { action: cdpAction, instructions: "Screenshot with clip" };
    }
    case "storage":
    case "cookie":
    case "permission":
    case "download":
    case "drag":
    case "network_capture":
    case "network_mock":
    case "network_block":
    case "network_set_headers":
    case "network_emulate": {
      return {
        error: `${tool} requires structured args identical to the underlying browser action; pass them via /browser-sessions/:id/send for now`,
      };
    }
    default:
      return { error: `tool not implemented in Tier 2: ${tool}` };
  }
}

function filterTargets(
  targets: Array<Record<string, unknown>>,
  args: Record<string, unknown>
): Array<Record<string, unknown>> {
  const urlPattern = toOptionalString(args.urlPattern);
  const titlePattern = toOptionalString(args.titlePattern);
  const urlRegex = urlPattern ? buildRegex(urlPattern) : null;
  const titleRegex = titlePattern ? buildRegex(titlePattern) : null;
  return targets.filter((target) => {
    const url = typeof target.url === "string" ? target.url : "";
    const title = typeof target.title === "string" ? target.title : "";
    if (urlRegex && !urlRegex.test(url)) return false;
    if (titleRegex && !titleRegex.test(title)) return false;
    return true;
  });
}

const MAX_FIND_TAB_REGEX_LENGTH = 2048;

function buildRegex(value: string): RegExp | null {
  if (value.length > MAX_FIND_TAB_REGEX_LENGTH) return null;
  try {
    return new RegExp(value, "i");
  } catch {
    return null;
  }
}

function successResponse(body: Record<string, unknown>): BridgeCommandResponse {
  return { status: 200, body: { ok: true, ...body } };
}

function errorResponse(
  status: number,
  message: string,
  code: string,
  cause?: unknown
): BridgeCommandResponse {
  const body: Record<string, unknown> = { ok: false, error: message, code };
  if (cause !== undefined) body.cause = cause;
  return { status, body };
}

function mapErrorResponse(error: unknown, fallbackMessage: string): BridgeCommandResponse {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("not found") || lower.includes("target_not_found")) {
    return errorResponse(404, message, "target_missing", lower);
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return errorResponse(504, message, "action_timeout", lower);
  }
  if (lower.includes("transport") || lower.includes("relay") || lower.includes("cdp")) {
    return errorResponse(503, message, "transport_unavailable", lower);
  }
  return errorResponse(500, message || fallbackMessage, "action_failed");
}

function shapeTaskResultForFacade(result: BrowserTaskResult | null | undefined): Record<string, unknown> {
  if (!result) return {};
  return {
    page: result.page,
    trace: result.trace,
    screenshotPaths: result.screenshotPaths,
    artifactIds: result.artifactIds,
    transport: {
      mode: result.transportMode ?? null,
      label: result.transportLabel ?? null,
    },
    targetId: result.targetId ?? null,
  };
}

function toRequiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0);
  return out.length > 0 ? out : undefined;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
