import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";

import { createRouteIdempotencyStore } from "../idempotency-store";
import type { BridgeCommandResponse } from "../bridge-command-dispatcher";
import {
  buildBridgeStatus,
  handleBridgeRoutes,
  type BridgeRouteDeps,
  type BridgeStatusInfo,
} from "./bridge-routes";

function createRequest(input: {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}): http.IncomingMessage {
  const body =
    input.body === undefined
      ? []
      : [Buffer.from(typeof input.body === "string" ? input.body : JSON.stringify(input.body))];
  return Object.assign(Readable.from(body), {
    method: input.method,
    url: input.url,
    headers: input.headers ?? {},
  }) as unknown as http.IncomingMessage;
}

function createResponse(): {
  res: http.ServerResponse;
  headers: Map<string, string>;
  getJson: () => unknown;
  getStatus: () => number;
} {
  let payload = "";
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    headers,
    getStatus: () => res.statusCode,
    getJson: () => (payload ? JSON.parse(payload) : undefined),
  };
}

describe("bridge-routes", () => {
  it("buildBridgeStatus reports relay metadata when configured", () => {
    const now = 1_000_000;
    const status = buildBridgeStatus({
      port: 4100,
      version: "0.1.1",
      dataDir: "/data",
      logsPath: "/logs/daemon.log",
      configFile: "/cfg/config.json",
      transportMode: "relay",
      transportLabel: "chrome-relay",
      relay: {
        configured: true,
        peers: [
          {
            peerId: "peer-1",
            registeredAt: now - 5000,
            lastSeenAt: now - 1000,
            status: "active",
          } as never,
        ],
        targets: [
          { relayTargetId: "chrome-tab:1", peerId: "peer-1" } as never,
          { relayTargetId: "chrome-tab:2", peerId: "peer-1" } as never,
        ],
        actions: [],
      },
      directCdp: { configured: false, endpoint: null },
      expertLane: null,
      sessionCount: 0,
      now,
    });

    assert.equal(status.transport.mode, "relay");
    assert.equal(status.transport.label, "chrome-relay");
    assert.equal(status.relay.configured, true);
    assert.equal(status.relay.peerCount, 1);
    assert.equal(status.relay.targetCount, 2);
    assert.equal(status.relay.lastHeartbeatAgeMs, 1000);
    assert.equal(status.directCdp.configured, false);
    assert.equal(status.expertLane.available, false);
    assert.equal(status.expertLane.reason, "expert lane requires direct-cdp transport");
    assert.equal(status.sessions.count, 0);
  });

  it("buildBridgeStatus marks expert lane available when present", () => {
    const status = buildBridgeStatus({
      port: 4100,
      version: "0.1.1",
      dataDir: "/data",
      logsPath: "/logs/daemon.log",
      configFile: "/cfg/config.json",
      transportMode: "direct-cdp",
      transportLabel: "direct-cdp",
      relay: { configured: false, peers: [], targets: [], actions: [] },
      directCdp: { configured: true, endpoint: "http://127.0.0.1:9222" },
      expertLane: {} as never,
      sessionCount: 3,
      now: 1,
    });
    assert.equal(status.expertLane.available, true);
    assert.equal(status.relay.lastHeartbeatAgeMs, null);
    assert.equal(status.directCdp.endpoint, "http://127.0.0.1:9222");
    assert.equal(status.sessions.count, 3);
  });

  it("GET /bridge/status returns the status payload", async () => {
    const fakeStatus: BridgeStatusInfo = {
      port: 4100,
      version: "0.1.1",
      dataDir: "/data",
      logsPath: "/log",
      configFile: "/cfg",
      transport: { mode: "local", label: "local-automation" },
      relay: {
        configured: false,
        peerCount: 0,
        targetCount: 0,
        lastHeartbeatAgeMs: null,
        actionRequestQueueDepth: 0,
      },
      directCdp: { configured: false, endpoint: null },
      expertLane: { available: false, reason: "expert lane requires direct-cdp transport" },
      sessions: { count: 0 },
    };
    const deps: BridgeRouteDeps = {
      getStatusInfo: async () => fakeStatus,
    };
    const { res, getJson, getStatus } = createResponse();
    const handled = await handleBridgeRoutes({
      req: createRequest({ method: "GET", url: "/bridge/status" }),
      res,
      url: new URL("http://127.0.0.1/bridge/status"),
      deps,
    });
    assert.equal(handled, true);
    assert.equal(getStatus(), 200);
    const body = getJson() as { ok: boolean; transport: { mode: string } };
    assert.equal(body.ok, true);
    assert.equal(body.transport.mode, "local");
  });

  it("non-matching paths return false", async () => {
    const deps: BridgeRouteDeps = {
      getStatusInfo: async () => {
        throw new Error("should not be called");
      },
    };
    const { res } = createResponse();
    const handled = await handleBridgeRoutes({
      req: createRequest({ method: "GET", url: "/other" }),
      res,
      url: new URL("http://127.0.0.1/other"),
      deps,
    });
    assert.equal(handled, false);
  });

  // PR A — idempotency for the /bridge/* facade. The aftermath audit caught
  // that I added idempotency to /browser-sessions/* and validation /run/*,
  // but NOT to /bridge/*, which is the actual external-facing surface used
  // by Claude Code and similar agents. A retried POST during a browser
  // mutation (click / fill / upload / expert.send) must not double-execute.

  it("/bridge/command replays cached response on same Idempotency-Key", async () => {
    let dispatchCalls = 0;
    const deps: BridgeRouteDeps = {
      getStatusInfo: async () => {
        throw new Error("not used");
      },
      commandDispatcher: {
        async dispatch(): Promise<BridgeCommandResponse> {
          dispatchCalls += 1;
          return {
            status: 200,
            body: { ok: true, dispatchedAt: dispatchCalls },
          };
        },
      },
      idempotencyStore: createRouteIdempotencyStore({ now: () => 1000 }),
    };

    const first = createResponse();
    await handleBridgeRoutes({
      req: createRequest({
        method: "POST",
        url: "/bridge/command",
        headers: { "idempotency-key": "key-1" },
        body: { tool: "click", args: { selectors: ["#go"] }, sessionId: "session-1" },
      }),
      res: first.res,
      url: new URL("http://127.0.0.1/bridge/command"),
      deps,
    });
    assert.equal(first.getStatus(), 200);
    assert.equal(dispatchCalls, 1);

    const second = createResponse();
    await handleBridgeRoutes({
      req: createRequest({
        method: "POST",
        url: "/bridge/command",
        headers: { "idempotency-key": "key-1" },
        body: { tool: "click", args: { selectors: ["#go"] }, sessionId: "session-1" },
      }),
      res: second.res,
      url: new URL("http://127.0.0.1/bridge/command"),
      deps,
    });
    assert.equal(dispatchCalls, 1, "retried /bridge/command must NOT re-dispatch");
    assert.equal(second.getStatus(), 200);
    assert.equal(second.headers.get("x-turnkeyai-idempotency-status"), "replayed");
    const replayed = second.getJson() as { dispatchedAt: number };
    assert.equal(replayed.dispatchedAt, 1, "replay returns the cached body, not a fresh dispatch counter");
  });

  it("/bridge/command returns 409 on Idempotency-Key reuse with different args", async () => {
    let dispatchCalls = 0;
    const deps: BridgeRouteDeps = {
      getStatusInfo: async () => {
        throw new Error("not used");
      },
      commandDispatcher: {
        async dispatch(): Promise<BridgeCommandResponse> {
          dispatchCalls += 1;
          return { status: 200, body: { ok: true } };
        },
      },
      idempotencyStore: createRouteIdempotencyStore({ now: () => 1000 }),
    };

    await handleBridgeRoutes({
      req: createRequest({
        method: "POST",
        url: "/bridge/command",
        headers: { "idempotency-key": "collide" },
        body: { tool: "click", args: { selectors: ["#go"] } },
      }),
      res: createResponse().res,
      url: new URL("http://127.0.0.1/bridge/command"),
      deps,
    });

    const conflict = createResponse();
    await handleBridgeRoutes({
      req: createRequest({
        method: "POST",
        url: "/bridge/command",
        headers: { "idempotency-key": "collide" },
        // SAME key, DIFFERENT tool → must 409 not double-dispatch
        body: { tool: "type", args: { selectors: ["#go"], value: "x" } },
      }),
      res: conflict.res,
      url: new URL("http://127.0.0.1/bridge/command"),
      deps,
    });
    assert.equal(dispatchCalls, 1);
    assert.equal(conflict.getStatus(), 409);
  });

  it("/bridge/expert replays cached response on same Idempotency-Key", async () => {
    let expertCalls = 0;
    const deps: BridgeRouteDeps = {
      getStatusInfo: async () => {
        throw new Error("not used");
      },
      expertDispatcher: {
        async dispatch(): Promise<BridgeCommandResponse> {
          expertCalls += 1;
          return { status: 200, body: { ok: true, call: expertCalls } };
        },
      },
      idempotencyStore: createRouteIdempotencyStore({ now: () => 1000 }),
    };

    for (let i = 0; i < 2; i += 1) {
      const response = createResponse();
      await handleBridgeRoutes({
        req: createRequest({
          method: "POST",
          url: "/bridge/expert",
          headers: { "idempotency-key": "expert-1" },
          body: {
            tool: "send_command",
            args: { method: "Page.reload", params: {} },
            sessionId: "session-1",
          },
        }),
        res: response.res,
        url: new URL("http://127.0.0.1/bridge/expert"),
        deps,
      });
      if (i === 1) {
        assert.equal(response.headers.get("x-turnkeyai-idempotency-status"), "replayed");
      }
    }
    assert.equal(expertCalls, 1, "retried /bridge/expert must NOT re-dispatch CDP command");
  });

  it("/bridge/batch replays cached response on same Idempotency-Key", async () => {
    let batchCalls = 0;
    const deps: BridgeRouteDeps = {
      getStatusInfo: async () => {
        throw new Error("not used");
      },
      batchDispatcher: {
        async dispatch(): Promise<BridgeCommandResponse> {
          batchCalls += 1;
          return { status: 200, body: { ok: true } };
        },
      },
      idempotencyStore: createRouteIdempotencyStore({ now: () => 1000 }),
    };

    for (let i = 0; i < 2; i += 1) {
      const response = createResponse();
      await handleBridgeRoutes({
        req: createRequest({
          method: "POST",
          url: "/bridge/batch",
          headers: { "idempotency-key": "batch-1" },
          body: {
            actions: [
              { tool: "navigate", args: { url: "https://example.com" } },
              { tool: "click", args: { selectors: ["#a"] } },
            ],
            sessionId: "session-1",
          },
        }),
        res: response.res,
        url: new URL("http://127.0.0.1/bridge/batch"),
        deps,
      });
      if (i === 1) {
        assert.equal(response.headers.get("x-turnkeyai-idempotency-status"), "replayed");
      }
    }
    assert.equal(batchCalls, 1, "retried /bridge/batch must NOT re-dispatch the action sequence");
  });

  it("/bridge/command without Idempotency-Key still works (header is optional)", async () => {
    let dispatchCalls = 0;
    const deps: BridgeRouteDeps = {
      getStatusInfo: async () => {
        throw new Error("not used");
      },
      commandDispatcher: {
        async dispatch(): Promise<BridgeCommandResponse> {
          dispatchCalls += 1;
          return { status: 200, body: { ok: true } };
        },
      },
      idempotencyStore: createRouteIdempotencyStore({ now: () => 1000 }),
    };
    const response = createResponse();
    await handleBridgeRoutes({
      req: createRequest({
        method: "POST",
        url: "/bridge/command",
        body: { tool: "click", args: { selectors: ["#x"] } },
      }),
      res: response.res,
      url: new URL("http://127.0.0.1/bridge/command"),
      deps,
    });
    assert.equal(response.getStatus(), 200);
    assert.equal(dispatchCalls, 1);
  });
});
