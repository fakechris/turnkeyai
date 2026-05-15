import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";

import {
  buildBridgeStatus,
  handleBridgeRoutes,
  type BridgeRouteDeps,
  type BridgeStatusInfo,
} from "./bridge-routes";

function createRequest(input: { method: string; url: string; body?: unknown }): http.IncomingMessage {
  const body =
    input.body === undefined
      ? []
      : [Buffer.from(typeof input.body === "string" ? input.body : JSON.stringify(input.body))];
  return Object.assign(Readable.from(body), {
    method: input.method,
    url: input.url,
    headers: {},
  }) as unknown as http.IncomingMessage;
}

function createResponse(): {
  res: http.ServerResponse;
  getJson: () => unknown;
  getStatus: () => number;
} {
  let payload = "";
  const res = {
    statusCode: 200,
    setHeader() {
      return undefined;
    },
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as unknown as http.ServerResponse;
  return {
    res,
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
});
