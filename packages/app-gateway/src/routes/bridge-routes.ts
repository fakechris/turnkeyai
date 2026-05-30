import type http from "node:http";

import type {
  BrowserRawCdpExpertLane,
  BrowserTransportHealth,
  BrowserTransportMode,
  BrowserTransportReconnectRequest,
  BrowserTransportReconnectResult,
} from "@turnkeyai/core-types/team";
import type {
  RelayPeerRecord,
  RelayTargetRecord,
  RelayActionRequestRecord,
} from "@turnkeyai/browser-bridge/transport/relay-protocol";

import {
  deriveBridgePrincipal,
  type BridgeBatchInput,
  type BridgeCommandDispatcher,
  type BridgeCommandResponse,
} from "../bridge-command-dispatcher";
import type {
  BridgeMissionActivityRecorder,
  BridgeMissionContext,
  BridgeRecordResult,
} from "../bridge-mission-activity-recorder";
import {
  parseBridgeMissionContext,
  validateBridgeMissionContext,
  type BridgeMissionValidatorDeps,
} from "../bridge-mission-validators";
import { readJsonBodySafe, sendJson } from "../http-helpers";
import { runIdempotently, type RouteIdempotencyStore } from "../idempotency-store";

export interface BridgeStatusInfo {
  port: number;
  version: string;
  dataDir: string;
  logsPath: string;
  configFile: string;
  transport: {
    mode: BrowserTransportMode;
    label: string;
    health?: BrowserTransportHealth;
  };
  relay: {
    configured: boolean;
    peerCount: number;
    targetCount: number;
    lastHeartbeatAgeMs: number | null;
    actionRequestQueueDepth: number;
  };
  directCdp: {
    configured: boolean;
    endpoint: string | null;
  };
  expertLane: {
    available: boolean;
    reason?: string;
  };
  sessions: {
    count: number;
  };
}

/**
 * Mission orchestration deps injected by the daemon. When supplied, the
 * /bridge/command, /bridge/advanced, and /bridge/batch routes accept
 * optional `missionId` / `workItemId` body fields, validate them, append
 * a corresponding ActivityEvent to the mission timeline on success
 * (kind=tool) or failure (kind=recovery), and surface a 502 if the
 * browser action ran but the timeline append failed (so the caller knows
 * the bridge work is real but the audit trail is missing).
 *
 * Left optional so existing /bridge/expert callers and pre-mission test
 * harnesses continue to work unchanged.
 */
export interface BridgeMissionRouteDeps {
  validator: BridgeMissionValidatorDeps;
  recorder: BridgeMissionActivityRecorder;
}

export interface BridgeRouteDeps {
  getStatusInfo(): Promise<BridgeStatusInfo>;
  transportControl?: {
    getHealth(): Promise<BrowserTransportHealth>;
    reconnect(input?: BrowserTransportReconnectRequest): Promise<BrowserTransportReconnectResult>;
  };
  commandDispatcher?: BridgeCommandDispatcher;
  advancedDispatcher?: BridgeCommandDispatcher;
  expertDispatcher?: {
    dispatch(input: {
      token: string | null;
      tool: string;
      args?: Record<string, unknown> | null;
      sessionId?: string | null;
    }): Promise<BridgeCommandResponse>;
  };
  batchDispatcher?: {
    dispatch(input: BridgeBatchInput): Promise<BridgeCommandResponse>;
  };
  resolveToken?(req: http.IncomingMessage): string | null;
  /**
   * Optional. When supplied, /bridge/* POST routes honor the `Idempotency-Key`
   * header so a retried call from an external agent (e.g. Claude Code) does
   * not re-dispatch the underlying browser/CDP action. This matters more here
   * than for /browser-sessions/* because /bridge/* IS the stable external
   * surface — a network blip during a click/upload/expert.send shouldn't
   * double-click / double-upload / double-send.
   */
  idempotencyStore?: RouteIdempotencyStore;
  missionContext?: BridgeMissionRouteDeps;
}

interface BridgeCommandBody {
  tool?: unknown;
  args?: unknown;
  sessionId?: unknown;
  threadId?: unknown;
  instructions?: unknown;
  missionId?: unknown;
  workItemId?: unknown;
}

interface BridgeBatchBody {
  actions?: unknown;
  sessionId?: unknown;
  threadId?: unknown;
  instructions?: unknown;
  missionId?: unknown;
  workItemId?: unknown;
}

interface BridgeReconnectBody {
  browserSessionId?: unknown;
  reason?: unknown;
  missionId?: unknown;
  workItemId?: unknown;
}

export async function handleBridgeRoutes(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  deps: BridgeRouteDeps;
}): Promise<boolean> {
  const { req, res, url, deps } = input;

  if (req.method === "GET" && url.pathname === "/bridge/status") {
    try {
      const info = await deps.getStatusInfo();
      sendJson(res, 200, { ok: true, ...info });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/bridge/command") {
    return dispatchSingleTool({
      req,
      res,
      dispatcher: deps.commandDispatcher,
      ...(deps.resolveToken ? { resolveToken: deps.resolveToken } : {}),
      idempotencyStore: deps.idempotencyStore,
      ...(deps.missionContext ? { missionContext: deps.missionContext } : {}),
      scopePrefix: "bridge:command",
      label: "command",
    });
  }

  if (req.method === "POST" && url.pathname === "/bridge/advanced") {
    return dispatchSingleTool({
      req,
      res,
      dispatcher: deps.advancedDispatcher,
      ...(deps.resolveToken ? { resolveToken: deps.resolveToken } : {}),
      idempotencyStore: deps.idempotencyStore,
      ...(deps.missionContext ? { missionContext: deps.missionContext } : {}),
      scopePrefix: "bridge:advanced",
      label: "advanced",
    });
  }

  if (req.method === "POST" && url.pathname === "/bridge/expert") {
    if (!deps.expertDispatcher) {
      sendJson(res, 501, { error: "bridge expert dispatcher not configured" });
      return true;
    }
    const bodyResult = await readJsonBodySafe<BridgeCommandBody>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value ?? {};
    const tool = typeof body.tool === "string" ? body.tool : "";
    const args = isRecord(body.args) ? body.args : null;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
    const token = deps.resolveToken ? deps.resolveToken(req) : null;
    return runIdempotently({
      req,
      res,
      store: deps.idempotencyStore,
      // Scope namespaced by principal so two agents with different bridge
      // tokens cannot share a cached response just because they happened
      // to pick the same Idempotency-Key value. See deriveBridgePrincipal.
      scope: `bridge:expert:${deriveBridgePrincipal(token)}`,
      // Token deliberately NOT in the fingerprint — two retries from the same
      // agent must dedupe. SessionId distinguishes work targeting different
      // browser sessions; tool + args distinguish what the agent asked for.
      fingerprint: { tool, args: args ?? null, sessionId: sessionId ?? null },
      execute: async () => {
        const response = await deps.expertDispatcher!.dispatch({ token, tool, args, sessionId });
        return { statusCode: response.status, body: response.body };
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/bridge/batch") {
    if (!deps.batchDispatcher) {
      sendJson(res, 501, { error: "bridge batch dispatcher not configured" });
      return true;
    }
    const bodyResult = await readJsonBodySafe<BridgeBatchBody>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value ?? {};
    const actions = Array.isArray(body.actions)
      ? body.actions.filter(isRecord).map((entry) => ({
          tool: typeof entry.tool === "string" ? entry.tool : "",
          args: isRecord(entry.args) ? entry.args : null,
        }))
      : [];
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
    const threadId = typeof body.threadId === "string" ? body.threadId : null;
    const instructions = typeof body.instructions === "string" ? body.instructions : null;
    const parsedMission = parseBridgeMissionContext({
      missionId: body.missionId,
      workItemId: body.workItemId,
    });
    const token = deps.resolveToken ? deps.resolveToken(req) : null;
    return runIdempotently({
      req,
      res,
      store: deps.idempotencyStore,
      scope: `bridge:batch:${deriveBridgePrincipal(token)}`,
      // missionId/workItemId in the fingerprint: same Idempotency-Key
      // reused under a different mission must NOT replay the cached
      // response, since the timeline event semantics differ. We serialize
      // the full tri-state (absent/blank/value) so a request that omits
      // missionId fingerprints differently from one that supplies a
      // blank string — both produce different responses (no-op vs 400)
      // and must not share a cache slot.
      fingerprint: {
        actions,
        sessionId: sessionId ?? null,
        threadId: threadId ?? null,
        instructions: instructions ?? null,
        mission: parsedMission.mission,
        workItem: parsedMission.workItem,
      },
      execute: async () => {
        const validation = deps.missionContext
          ? await validateBridgeMissionContext({
              context: parsedMission,
              deps: deps.missionContext.validator,
            })
          : ({ ok: true as const, missionId: null, workItemId: null });
        if (!validation.ok) {
          return { statusCode: validation.statusCode, body: validation.body };
        }
        const context = buildContext(validation.missionId, validation.workItemId);
        const response = await deps.batchDispatcher!.dispatch({
          token,
          actions,
          sessionId,
          threadId,
          instructions,
        });
        return recordAndEnvelope({
          deps,
          response,
          context,
          tool: "batch",
          sessionId,
          // Inside `execute` we are the path that actually ran — never
          // a replay. The idempotency store handles replay above us.
          replayed: false,
        });
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/bridge/reconnect") {
    if (!deps.transportControl) {
      sendJson(res, 501, { error: "bridge transport reconnect is not configured" });
      return true;
    }
    const bodyResult = await readJsonBodySafe<BridgeReconnectBody>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value ?? {};
    const parsed = parseBridgeReconnectBody(body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return true;
    }
    const parsedMission = parseBridgeMissionContext({
      missionId: body.missionId,
      workItemId: body.workItemId,
    });
    const token = deps.resolveToken ? deps.resolveToken(req) : null;
    return runIdempotently({
      req,
      res,
      store: deps.idempotencyStore,
      scope: `bridge:reconnect:${deriveBridgePrincipal(token)}`,
      fingerprint: {
        browserSessionId: parsed.browserSessionId ?? null,
        reason: parsed.reason ?? null,
        mission: parsedMission.mission,
        workItem: parsedMission.workItem,
      },
      execute: async () => {
        const validation = deps.missionContext
          ? await validateBridgeMissionContext({
              context: parsedMission,
              deps: deps.missionContext.validator,
            })
          : ({ ok: true as const, missionId: null, workItemId: null });
        if (!validation.ok) {
          return { statusCode: validation.statusCode, body: validation.body };
        }
        const context = buildContext(validation.missionId, validation.workItemId);
        const before = await safeGetTransportHealth(deps.transportControl!);
        try {
          const reconnect = await deps.transportControl!.reconnect({
            ...(parsed.browserSessionId ? { browserSessionId: parsed.browserSessionId } : {}),
            ...(parsed.reason ? { reason: parsed.reason } : {}),
          });
          const after = await safeGetTransportHealth(deps.transportControl!);
          return recordAndEnvelope({
            deps,
            response: {
              status: reconnect.ok ? 200 : 503,
              body: {
                ok: reconnect.ok,
                ...(reconnect.ok
                  ? {}
                  : {
                      error: reconnect.reason ?? "transport reconnect failed",
                      code: "transport_reconnect_failed",
                    }),
                tool: "bridge.reconnect",
                sessionId: parsed.browserSessionId ?? null,
                result: {
                  reconnect,
                  healthBefore: before,
                  healthAfter: after,
                  transport: { label: after?.transportLabel ?? before?.transportLabel ?? "unknown" },
                },
              },
            },
            context,
            tool: "bridge.reconnect",
            sessionId: parsed.browserSessionId ?? null,
            replayed: false,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return recordAndEnvelope({
            deps,
            response: {
              status: 503,
              body: {
                ok: false,
                error: message,
                code: "transport_reconnect_failed",
                sessionId: parsed.browserSessionId ?? null,
                result: { healthBefore: before },
              },
            },
            context,
            tool: "bridge.reconnect",
            sessionId: parsed.browserSessionId ?? null,
            replayed: false,
          });
        }
      },
    });
  }

  return false;
}

function parseBridgeReconnectBody(
  body: BridgeReconnectBody
):
  | { ok: true; browserSessionId?: string; reason?: string }
  | { ok: false; error: string } {
  const browserSessionId = parseOptionalTrimmedString(body.browserSessionId, "browserSessionId");
  if (!browserSessionId.ok) return browserSessionId;
  const reason = parseOptionalTrimmedString(body.reason, "reason");
  if (!reason.ok) return reason;
  return {
    ok: true,
    ...(browserSessionId.value ? { browserSessionId: browserSessionId.value } : {}),
    ...(reason.value ? { reason: reason.value } : {}),
  };
}

async function safeGetTransportHealth(
  transportControl: NonNullable<BridgeRouteDeps["transportControl"]>
): Promise<BrowserTransportHealth | undefined> {
  try {
    return await transportControl.getHealth();
  } catch {
    return undefined;
  }
}

function parseOptionalTrimmedString(
  value: unknown,
  label: string
): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true };
  }
  if (typeof value !== "string") {
    return { ok: false, error: `${label} must be a string when provided` };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: `${label} must be non-empty when provided` };
  }
  return { ok: true, value: trimmed };
}

async function dispatchSingleTool(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  dispatcher: BridgeCommandDispatcher | undefined;
  resolveToken?: (req: http.IncomingMessage) => string | null;
  idempotencyStore: RouteIdempotencyStore | undefined;
  missionContext?: BridgeMissionRouteDeps;
  /**
   * Route-level scope prefix (e.g. `bridge:command`). The actual idempotency
   * cache scope is built as `${scopePrefix}:${principal}` so different bridge
   * tokens have separate cache namespaces — see deriveBridgePrincipal.
   */
  scopePrefix: string;
  label: string;
}): Promise<boolean> {
  if (!input.dispatcher) {
    sendJson(input.res, 501, { error: `bridge ${input.label} dispatcher not configured` });
    return true;
  }
  const bodyResult = await readJsonBodySafe<BridgeCommandBody>(input.req);
  if (!bodyResult.ok) {
    sendJson(input.res, 400, { error: bodyResult.error });
    return true;
  }
  const body = bodyResult.value ?? {};
  const tool = typeof body.tool === "string" ? body.tool : "";
  const args = isRecord(body.args) ? body.args : null;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  const threadId = typeof body.threadId === "string" ? body.threadId : null;
  const instructions = typeof body.instructions === "string" ? body.instructions : null;
  const parsedMission = parseBridgeMissionContext({
    missionId: body.missionId,
    workItemId: body.workItemId,
  });
  const token = input.resolveToken ? input.resolveToken(input.req) : null;
  return runIdempotently({
    req: input.req,
    res: input.res,
    store: input.idempotencyStore,
    scope: `${input.scopePrefix}:${deriveBridgePrincipal(token)}`,
    // Token deliberately NOT fingerprinted — agent retries share the same token
    // and must replay. SessionId, threadId, tool, args, instructions all
    // describe what the agent asked the bridge to do; identical asks dedupe.
    // mission/workItem ARE fingerprinted: same idempotency key reused
    // under a different mission must NOT replay, because the timeline event
    // would land on the wrong mission (or get skipped silently). The full
    // tri-state (absent/blank/value) is serialized so that omitting a
    // field fingerprints differently from supplying a blank one (one
    // dispatches, the other 400s). A mismatch surfaces as 409 so the
    // caller fixes the key. Cross-principal isolation is handled by the
    // scope, not the fingerprint.
    fingerprint: {
      tool,
      args: args ?? null,
      sessionId: sessionId ?? null,
      threadId: threadId ?? null,
      instructions: instructions ?? null,
      mission: parsedMission.mission,
      workItem: parsedMission.workItem,
    },
    execute: async () => {
      const validation = input.missionContext
        ? await validateBridgeMissionContext({
            context: parsedMission,
            deps: input.missionContext.validator,
          })
        : ({ ok: true as const, missionId: null, workItemId: null });
      if (!validation.ok) {
        return { statusCode: validation.statusCode, body: validation.body };
      }
      const context = buildContext(validation.missionId, validation.workItemId);
      const response = await input.dispatcher!.dispatch({
        token,
        tool,
        args,
        sessionId,
        threadId,
        instructions,
      });
      return recordAndEnvelope({
        deps: input.missionContext ? { missionContext: input.missionContext } : {},
        response,
        context,
        tool,
        sessionId,
        replayed: false,
      });
    },
  });
}

function buildContext(
  missionId: string | null,
  workItemId: string | null
): BridgeMissionContext | null {
  if (!missionId) return null;
  const context: BridgeMissionContext = { missionId };
  if (workItemId) context.workItemId = workItemId;
  return context;
}

/**
 * Run the recorder against a dispatcher response and produce the
 * idempotency envelope the route returns. Returns a 502 (with the
 * original browser result included) when the browser action ran but the
 * timeline append failed — the caller needs to know the underlying
 * mutation actually happened so they don't retry blindly.
 */
async function recordAndEnvelope(input: {
  deps: { missionContext?: BridgeMissionRouteDeps };
  response: BridgeCommandResponse;
  context: BridgeMissionContext | null;
  tool: string;
  sessionId: string | null;
  replayed: boolean;
}): Promise<{ statusCode: number; body: unknown }> {
  const { response, context, tool, sessionId, replayed } = input;
  const recorder = input.deps.missionContext?.recorder;
  const resolvedSessionId = extractResolvedSessionId(response.body, sessionId);
  const ok = response.status >= 200 && response.status < 300;

  if (!recorder || !context) {
    return { statusCode: response.status, body: response.body };
  }

  let recordResult: BridgeRecordResult;
  if (ok) {
    recordResult = await recorder.recordSuccess({
      context,
      replayed,
      tool,
      sessionId: resolvedSessionId,
      transportLabel: extractTransportLabel(response.body),
    });
  } else {
    recordResult = await recorder.recordFailure({
      context,
      replayed,
      tool,
      sessionId: resolvedSessionId,
      bucket: extractErrorCode(response.body),
      message: extractErrorMessage(response.body) ?? `Browser ${tool} failed.`,
    });
  }

  if (recordResult.kind === "failed" && ok) {
    // Browser executed but we couldn't write the timeline. The browser
    // mutation is durable, so don't retry it; surface a 502 with both
    // pieces so the caller can decide whether to forge ahead or alert.
    return {
      statusCode: 502,
      body: {
        ok: false,
        error: "browser action succeeded but timeline append failed",
        code: "timeline_append_failed",
        browserActionExecuted: true,
        timelineRecorded: false,
        timelineError: recordResult.error,
        bridgeResponse: response.body,
      },
    };
  }

  // For failure paths where the recorder ALSO failed, return the original
  // bridge error — losing the recovery event is worse than losing the
  // ability to surface the failure, but not by enough to override the
  // dispatcher's response. Surface the timeline issue as a runtime hint.
  if (recordResult.kind === "failed" && !ok) {
    return {
      statusCode: response.status,
      body: {
        ...(isRecord(response.body) ? response.body : { raw: response.body }),
        timelineRecorded: false,
        timelineError: recordResult.error,
      },
    };
  }

  return { statusCode: response.status, body: response.body };
}

function extractResolvedSessionId(
  body: unknown,
  fallback: string | null
): string | null {
  if (isRecord(body) && typeof body.sessionId === "string" && body.sessionId.length > 0) {
    return body.sessionId;
  }
  return fallback;
}

function extractTransportLabel(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const result = body.result;
  if (!isRecord(result)) return null;
  const transport = result.transport;
  if (!isRecord(transport)) return null;
  return typeof transport.label === "string" ? transport.label : null;
}

function extractErrorCode(body: unknown): string | null {
  if (isRecord(body) && typeof body.code === "string" && body.code.length > 0) {
    return body.code;
  }
  return null;
}

function extractErrorMessage(body: unknown): string | null {
  if (isRecord(body) && typeof body.error === "string" && body.error.length > 0) {
    return body.error;
  }
  return null;
}

export interface BuildBridgeStatusInput {
  port: number;
  version: string;
  dataDir: string;
  logsPath: string;
  configFile: string;
  transportMode: BrowserTransportMode;
  transportLabel: string;
  transportHealth?: BrowserTransportHealth;
  relay: {
    configured: boolean;
    peers: RelayPeerRecord[];
    targets: RelayTargetRecord[];
    actions: RelayActionRequestRecord[];
  };
  directCdp: {
    configured: boolean;
    endpoint: string | null;
  };
  expertLane: BrowserRawCdpExpertLane | null;
  sessionCount: number;
  now: number;
}

export function buildBridgeStatus(input: BuildBridgeStatusInput): BridgeStatusInfo {
  const heartbeats = input.relay.peers
    .map((peer) => (typeof peer.lastSeenAt === "number" ? peer.lastSeenAt : null))
    .filter((value): value is number => value !== null);
  const lastHeartbeatAgeMs =
    heartbeats.length > 0 ? Math.max(0, input.now - Math.max(...heartbeats)) : null;

  return {
    port: input.port,
    version: input.version,
    dataDir: input.dataDir,
    logsPath: input.logsPath,
    configFile: input.configFile,
    transport: {
      mode: input.transportMode,
      label: input.transportLabel,
      ...(input.transportHealth ? { health: input.transportHealth } : {}),
    },
    relay: {
      configured: input.relay.configured,
      peerCount: input.relay.peers.length,
      targetCount: input.relay.targets.length,
      lastHeartbeatAgeMs,
      actionRequestQueueDepth: input.relay.actions.length,
    },
    directCdp: {
      configured: input.directCdp.configured,
      endpoint: input.directCdp.endpoint,
    },
    expertLane: input.expertLane
      ? { available: true }
      : {
          available: false,
          reason: "expert lane requires direct-cdp transport",
        },
    sessions: {
      count: input.sessionCount,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
