import type http from "node:http";

import type {
  BrowserRawCdpExpertLane,
  BrowserTransportMode,
} from "@turnkeyai/core-types/team";
import type {
  RelayPeerRecord,
  RelayTargetRecord,
  RelayActionRequestRecord,
} from "@turnkeyai/browser-bridge/transport/relay-protocol";

import type {
  BridgeBatchInput,
  BridgeCommandDispatcher,
  BridgeCommandResponse,
} from "../bridge-command-dispatcher";
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

export interface BridgeRouteDeps {
  getStatusInfo(): Promise<BridgeStatusInfo>;
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
}

interface BridgeCommandBody {
  tool?: unknown;
  args?: unknown;
  sessionId?: unknown;
  threadId?: unknown;
  instructions?: unknown;
}

interface BridgeBatchBody {
  actions?: unknown;
  sessionId?: unknown;
  threadId?: unknown;
  instructions?: unknown;
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
      scope: "bridge:command",
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
      scope: "bridge:advanced",
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
      scope: "bridge:expert",
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
    const token = deps.resolveToken ? deps.resolveToken(req) : null;
    return runIdempotently({
      req,
      res,
      store: deps.idempotencyStore,
      scope: "bridge:batch",
      fingerprint: {
        actions,
        sessionId: sessionId ?? null,
        threadId: threadId ?? null,
        instructions: instructions ?? null,
      },
      execute: async () => {
        const response = await deps.batchDispatcher!.dispatch({
          token,
          actions,
          sessionId,
          threadId,
          instructions,
        });
        return { statusCode: response.status, body: response.body };
      },
    });
  }

  return false;
}

async function dispatchSingleTool(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  dispatcher: BridgeCommandDispatcher | undefined;
  resolveToken?: (req: http.IncomingMessage) => string | null;
  idempotencyStore: RouteIdempotencyStore | undefined;
  scope: string;
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
  const token = input.resolveToken ? input.resolveToken(input.req) : null;
  return runIdempotently({
    req: input.req,
    res: input.res,
    store: input.idempotencyStore,
    scope: input.scope,
    // Token deliberately NOT fingerprinted — agent retries share the same token
    // and must replay. SessionId, threadId, tool, args, instructions all
    // describe what the agent asked the bridge to do; identical asks dedupe.
    fingerprint: {
      tool,
      args: args ?? null,
      sessionId: sessionId ?? null,
      threadId: threadId ?? null,
      instructions: instructions ?? null,
    },
    execute: async () => {
      const response = await input.dispatcher!.dispatch({
        token,
        tool,
        args,
        sessionId,
        threadId,
        instructions,
      });
      return { statusCode: response.status, body: response.body };
    },
  });
}

export interface BuildBridgeStatusInput {
  port: number;
  version: string;
  dataDir: string;
  logsPath: string;
  configFile: string;
  transportMode: BrowserTransportMode;
  transportLabel: string;
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
