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
import type {
  ActivityEvent,
  ActivityEventStore,
  Mission,
  MissionStore,
  WorkItem,
  WorkItemStore,
} from "@turnkeyai/core-types/mission";
import { createBridgeMissionActivityRecorder } from "../bridge-mission-activity-recorder";

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
      transportHealth: {
        transportMode: "relay",
        transportLabel: "chrome-relay",
        healthy: true,
        peerCount: 1,
        activePeerCount: 1,
        checkedAt: now,
      },
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
    assert.equal(status.transport.health?.healthy, true);
    assert.equal(status.transport.health?.peerCount, 1);
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

  it("/bridge/command isolates cached responses by principal (different bridge tokens do not share cache)", async () => {
    // Codex review of PR A flagged that the original idempotency wiring used
    // a route-only scope ("bridge:command"), so two different agents
    // sending the same Idempotency-Key on the same route + body would share
    // a single cache slot — a cross-principal leak. The fix namespaces the
    // scope by deriveBridgePrincipal(token), giving each bridge token its
    // own cache namespace. This test exercises that property.
    let dispatchCalls = 0;
    const seenTokens: Array<string | null> = [];
    const deps: BridgeRouteDeps = {
      getStatusInfo: async () => {
        throw new Error("not used");
      },
      commandDispatcher: {
        async dispatch(input): Promise<BridgeCommandResponse> {
          dispatchCalls += 1;
          seenTokens.push(input.token);
          return { status: 200, body: { ok: true, byCall: dispatchCalls } };
        },
      },
      resolveToken: (req) => {
        const value = req.headers["x-bridge-token"];
        return typeof value === "string" ? value : null;
      },
      idempotencyStore: createRouteIdempotencyStore({ now: () => 1000 }),
    };

    // Agent A calls with their token + a key they happen to pick.
    const agentA = createResponse();
    await handleBridgeRoutes({
      req: createRequest({
        method: "POST",
        url: "/bridge/command",
        headers: { "idempotency-key": "shared-key", "x-bridge-token": "token-A" },
        body: { tool: "click", args: { selectors: ["#a"] }, sessionId: "s-1" },
      }),
      res: agentA.res,
      url: new URL("http://127.0.0.1/bridge/command"),
      deps,
    });
    assert.equal(agentA.getStatus(), 200);

    // Agent B uses the SAME key string but with a DIFFERENT bridge token.
    // The cache must NOT replay agent A's response; B's call must execute.
    const agentB = createResponse();
    await handleBridgeRoutes({
      req: createRequest({
        method: "POST",
        url: "/bridge/command",
        headers: { "idempotency-key": "shared-key", "x-bridge-token": "token-B" },
        body: { tool: "click", args: { selectors: ["#a"] }, sessionId: "s-1" },
      }),
      res: agentB.res,
      url: new URL("http://127.0.0.1/bridge/command"),
      deps,
    });
    assert.equal(agentB.getStatus(), 200);
    assert.equal(
      agentB.headers.get("x-turnkeyai-idempotency-status"),
      undefined,
      "agent B with a different bridge token must NOT replay agent A's cached response",
    );
    assert.equal(dispatchCalls, 2, "each principal must execute their own request");
    assert.deepEqual(seenTokens, ["token-A", "token-B"]);

    // Agent A retrying with their own token still replays.
    const agentARetry = createResponse();
    await handleBridgeRoutes({
      req: createRequest({
        method: "POST",
        url: "/bridge/command",
        headers: { "idempotency-key": "shared-key", "x-bridge-token": "token-A" },
        body: { tool: "click", args: { selectors: ["#a"] }, sessionId: "s-1" },
      }),
      res: agentARetry.res,
      url: new URL("http://127.0.0.1/bridge/command"),
      deps,
    });
    assert.equal(agentARetry.headers.get("x-turnkeyai-idempotency-status"), "replayed");
    assert.equal(dispatchCalls, 2, "agent A retry must replay, not dispatch a third time");
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

  // ── PR K3: mission/work-item metadata wiring ────────────────────────

  describe("/bridge/command — mission context wiring", () => {
    const fixtureMission: Mission = {
      id: "msn.1",
      shortId: "MSN-1",
      title: "t",
      desc: "",
      status: "working",
      mode: "research",
      modeLabel: "Research",
      owner: "you",
      ownerLabel: "You",
      createdAt: "today",
      createdAtMs: 0,
      agents: [],
      progress: 0,
      pendingApprovals: 0,
      blockers: 0,
      contextSummary: [],
    };
    const fixtureWorkItem: WorkItem = {
      id: "wi.1",
      missionId: "msn.1",
      n: 1,
      title: "t",
      agent: "agent.a",
      status: "working",
      started: "—",
      duration: "—",
      contextRefs: [],
      output: "—",
    };

    function memActivityStore(): ActivityEventStore & { events: ActivityEvent[] } {
      const events: ActivityEvent[] = [];
      return {
        events,
        async listByMission(missionId) {
          return events.filter((e) => e.missionId === missionId);
        },
        async append(event) {
          events.push(event);
        },
      };
    }

    function failingActivityStore(): ActivityEventStore {
      return {
        async listByMission() {
          return [];
        },
        async append() {
          throw new Error("disk full");
        },
      };
    }

    function buildMissionDeps(activityStore: ActivityEventStore): NonNullable<
      BridgeRouteDeps["missionContext"]
    > {
      const missionStore: Pick<MissionStore, "get"> = {
        async get(id) {
          return id === fixtureMission.id ? fixtureMission : null;
        },
      };
      const workItemStore: Pick<WorkItemStore, "listByMission"> = {
        async listByMission(missionId) {
          return missionId === "msn.1" ? [fixtureWorkItem] : [];
        },
      };
      let counter = 0;
      const recorder = createBridgeMissionActivityRecorder({
        activityStore,
        newEventId: () => `evt.${++counter}`,
        clock: { now: () => 1_700_000_000_000 },
      });
      return {
        validator: { missionStore, workItemStore },
        recorder,
      };
    }

    it("appends a tool event on success", async () => {
      const activityStore = memActivityStore();
      const deps: BridgeRouteDeps = {
        getStatusInfo: async () => {
          throw new Error("not used");
        },
        commandDispatcher: {
          async dispatch(): Promise<BridgeCommandResponse> {
            return {
              status: 200,
              body: {
                ok: true,
                sessionId: "sess_a",
                tool: "snapshot",
                result: { transport: { label: "direct-cdp" } },
              },
            };
          },
        },
        missionContext: buildMissionDeps(activityStore),
      };

      const response = createResponse();
      await handleBridgeRoutes({
        req: createRequest({
          method: "POST",
          url: "/bridge/command",
          body: { tool: "snapshot", missionId: "msn.1", workItemId: "wi.1" },
        }),
        res: response.res,
        url: new URL("http://127.0.0.1/bridge/command"),
        deps,
      });

      assert.equal(response.getStatus(), 200);
      assert.equal(activityStore.events.length, 1);
      const event = activityStore.events[0]!;
      assert.equal(event.kind, "tool");
      assert.equal(event.missionId, "msn.1");
      assert.equal(event.runtime?.workItemId, "wi.1");
    });

    it("/bridge/reconnect calls transport reconnect and appends a mission event", async () => {
      const activityStore = memActivityStore();
      const calls: string[] = [];
      const deps: BridgeRouteDeps = {
        getStatusInfo: async () => {
          throw new Error("not used");
        },
        transportControl: {
          async getHealth() {
            calls.push("health");
            return {
              transportMode: "direct-cdp",
              transportLabel: "direct-cdp",
              healthy: true,
              connected: true,
              endpoint: "http://127.0.0.1:9222",
              checkedAt: 1_700_000_000_000 + calls.length,
            };
          },
          async reconnect(input) {
            calls.push(`reconnect:${input?.browserSessionId ?? ""}:${input?.reason ?? ""}`);
            return {
              transportMode: "direct-cdp",
              ok: true,
              invalidatedConnection: true,
              reconnectedAt: 1_700_000_000_010,
            };
          },
        },
        missionContext: buildMissionDeps(activityStore),
      };

      const response = createResponse();
      await handleBridgeRoutes({
        req: createRequest({
          method: "POST",
          url: "/bridge/reconnect",
          body: {
            browserSessionId: " session-1 ",
            reason: " operator recovery ",
            missionId: "msn.1",
            workItemId: "wi.1",
          },
        }),
        res: response.res,
        url: new URL("http://127.0.0.1/bridge/reconnect"),
        deps,
      });

      assert.equal(response.getStatus(), 200);
      assert.deepEqual(calls, ["health", "reconnect:session-1:operator recovery", "health"]);
      const body = response.getJson() as {
        ok: boolean;
        result: {
          reconnect: { ok: boolean; invalidatedConnection?: boolean };
          healthBefore: { transportLabel: string };
          healthAfter: { transportLabel: string };
        };
      };
      assert.equal(body.ok, true);
      assert.equal(body.result.reconnect.ok, true);
      assert.equal(body.result.reconnect.invalidatedConnection, true);
      assert.equal(body.result.healthBefore.transportLabel, "direct-cdp");
      assert.equal(body.result.healthAfter.transportLabel, "direct-cdp");
      assert.equal(activityStore.events.length, 1);
      const event = activityStore.events[0]!;
      assert.equal(event.kind, "tool");
      assert.equal(event.text, "Browser bridge.reconnect completed.");
      assert.equal(event.target, "ctx.browser.session.session-1");
      assert.equal(event.runtime?.transport, "direct-cdp");
      assert.equal(event.runtime?.workItemId, "wi.1");
    });

    it("/bridge/reconnect records transport reconnect failures as recovery events", async () => {
      const activityStore = memActivityStore();
      const deps: BridgeRouteDeps = {
        getStatusInfo: async () => {
          throw new Error("not used");
        },
        transportControl: {
          async getHealth() {
            return {
              transportMode: "relay",
              transportLabel: "relay",
              healthy: false,
              reason: "peer missing",
              peerCount: 0,
              activePeerCount: 0,
              checkedAt: 10,
            };
          },
          async reconnect() {
            throw new Error("relay peer unavailable");
          },
        },
        missionContext: buildMissionDeps(activityStore),
      };

      const response = createResponse();
      await handleBridgeRoutes({
        req: createRequest({
          method: "POST",
          url: "/bridge/reconnect",
          body: {
            browserSessionId: "session-1",
            missionId: "msn.1",
          },
        }),
        res: response.res,
        url: new URL("http://127.0.0.1/bridge/reconnect"),
        deps,
      });

      assert.equal(response.getStatus(), 503);
      const body = response.getJson() as { code: string; error: string };
      assert.equal(body.code, "transport_reconnect_failed");
      assert.equal(body.error, "relay peer unavailable");
      assert.equal(activityStore.events.length, 1);
      const event = activityStore.events[0]!;
      assert.equal(event.kind, "recovery");
      assert.equal(event.emph, "danger");
      assert.equal(event.runtime?.bucket, "transport_reconnect_failed");
      assert.equal(event.target, "ctx.browser.session.session-1");
    });

    it("appends a recovery event on dispatcher failure", async () => {
      const activityStore = memActivityStore();
      const deps: BridgeRouteDeps = {
        getStatusInfo: async () => {
          throw new Error("not used");
        },
        commandDispatcher: {
          async dispatch(): Promise<BridgeCommandResponse> {
            return {
              status: 503,
              body: {
                ok: false,
                error: "relay peer offline",
                code: "transport_unavailable",
              },
            };
          },
        },
        missionContext: buildMissionDeps(activityStore),
      };

      const response = createResponse();
      await handleBridgeRoutes({
        req: createRequest({
          method: "POST",
          url: "/bridge/command",
          body: { tool: "click", missionId: "msn.1" },
        }),
        res: response.res,
        url: new URL("http://127.0.0.1/bridge/command"),
        deps,
      });

      // The bridge response status is preserved — the route does NOT
      // turn dispatcher errors into 200s just because the recorder ran.
      assert.equal(response.getStatus(), 503);
      assert.equal(activityStore.events.length, 1);
      const event = activityStore.events[0]!;
      assert.equal(event.kind, "recovery");
      assert.equal(event.emph, "danger");
      assert.equal(event.runtime?.bucket, "transport_unavailable");
      assert.equal(event.text, "relay peer offline");
    });

    it("rejects unknown missionId with 404 before dispatching", async () => {
      const activityStore = memActivityStore();
      let dispatched = 0;
      const deps: BridgeRouteDeps = {
        getStatusInfo: async () => {
          throw new Error("not used");
        },
        commandDispatcher: {
          async dispatch(): Promise<BridgeCommandResponse> {
            dispatched += 1;
            return { status: 200, body: { ok: true } };
          },
        },
        missionContext: buildMissionDeps(activityStore),
      };

      const response = createResponse();
      await handleBridgeRoutes({
        req: createRequest({
          method: "POST",
          url: "/bridge/command",
          body: { tool: "snapshot", missionId: "msn.ghost" },
        }),
        res: response.res,
        url: new URL("http://127.0.0.1/bridge/command"),
        deps,
      });

      assert.equal(response.getStatus(), 404);
      const body = response.getJson() as { code: string };
      assert.equal(body.code, "mission_not_found");
      assert.equal(dispatched, 0, "must not dispatch when mission validation fails");
      assert.equal(activityStore.events.length, 0);
    });

    it("rejects workItemId that does not belong to the mission with 400", async () => {
      const activityStore = memActivityStore();
      let dispatched = 0;
      const deps: BridgeRouteDeps = {
        getStatusInfo: async () => {
          throw new Error("not used");
        },
        commandDispatcher: {
          async dispatch(): Promise<BridgeCommandResponse> {
            dispatched += 1;
            return { status: 200, body: { ok: true } };
          },
        },
        missionContext: buildMissionDeps(activityStore),
      };

      const response = createResponse();
      await handleBridgeRoutes({
        req: createRequest({
          method: "POST",
          url: "/bridge/command",
          body: { tool: "snapshot", missionId: "msn.1", workItemId: "wi.other" },
        }),
        res: response.res,
        url: new URL("http://127.0.0.1/bridge/command"),
        deps,
      });

      assert.equal(response.getStatus(), 400);
      const body = response.getJson() as { code: string };
      assert.equal(body.code, "work_item_mission_mismatch");
      assert.equal(dispatched, 0);
    });

    it("returns 502 when the browser action succeeded but the timeline append failed", async () => {
      const activityStore = failingActivityStore();
      const deps: BridgeRouteDeps = {
        getStatusInfo: async () => {
          throw new Error("not used");
        },
        commandDispatcher: {
          async dispatch(): Promise<BridgeCommandResponse> {
            return {
              status: 200,
              body: { ok: true, sessionId: "sess_a", tool: "snapshot" },
            };
          },
        },
        missionContext: buildMissionDeps(activityStore),
      };

      const response = createResponse();
      await handleBridgeRoutes({
        req: createRequest({
          method: "POST",
          url: "/bridge/command",
          body: { tool: "snapshot", missionId: "msn.1" },
        }),
        res: response.res,
        url: new URL("http://127.0.0.1/bridge/command"),
        deps,
      });

      // Critical contract: the browser action ALREADY HAPPENED. The
      // caller needs to know that explicitly so they don't retry — a
      // bare 500 would suggest the dispatch failed. 502 + explicit flags
      // is the signal that the underlying mutation is durable but the
      // audit trail is missing.
      assert.equal(response.getStatus(), 502);
      const body = response.getJson() as {
        code: string;
        browserActionExecuted: boolean;
        timelineRecorded: boolean;
        timelineError: string;
        bridgeResponse: { sessionId: string };
      };
      assert.equal(body.code, "timeline_append_failed");
      assert.equal(body.browserActionExecuted, true);
      assert.equal(body.timelineRecorded, false);
      assert.equal(body.timelineError, "disk full");
      assert.equal(body.bridgeResponse.sessionId, "sess_a");
    });

    it("idempotency replay does NOT double-append the timeline event", async () => {
      const activityStore = memActivityStore();
      let dispatched = 0;
      const deps: BridgeRouteDeps = {
        getStatusInfo: async () => {
          throw new Error("not used");
        },
        commandDispatcher: {
          async dispatch(): Promise<BridgeCommandResponse> {
            dispatched += 1;
            return {
              status: 200,
              body: { ok: true, sessionId: "sess_a", tool: "snapshot" },
            };
          },
        },
        idempotencyStore: createRouteIdempotencyStore({ now: () => 1000 }),
        missionContext: buildMissionDeps(activityStore),
      };

      const body = { tool: "snapshot", missionId: "msn.1" };
      const headers = { "idempotency-key": "k3-1" };
      for (let i = 0; i < 2; i += 1) {
        const r = createResponse();
        await handleBridgeRoutes({
          req: createRequest({ method: "POST", url: "/bridge/command", headers, body }),
          res: r.res,
          url: new URL("http://127.0.0.1/bridge/command"),
          deps,
        });
      }
      assert.equal(dispatched, 1, "idempotency must dedupe the dispatch");
      assert.equal(
        activityStore.events.length,
        1,
        "replay must NOT double-append the timeline event"
      );
    });

    it("missionId differences DO break idempotency replay (409 conflict)", async () => {
      const activityStore = memActivityStore();
      const deps: BridgeRouteDeps = {
        getStatusInfo: async () => {
          throw new Error("not used");
        },
        commandDispatcher: {
          async dispatch(): Promise<BridgeCommandResponse> {
            return { status: 200, body: { ok: true } };
          },
        },
        idempotencyStore: createRouteIdempotencyStore({ now: () => 1000 }),
        missionContext: buildMissionDeps(activityStore),
      };

      const headers = { "idempotency-key": "k3-collide" };
      const first = createResponse();
      await handleBridgeRoutes({
        req: createRequest({
          method: "POST",
          url: "/bridge/command",
          headers,
          body: { tool: "snapshot", missionId: "msn.1" },
        }),
        res: first.res,
        url: new URL("http://127.0.0.1/bridge/command"),
        deps,
      });
      assert.equal(first.getStatus(), 200);

      // Same key, no missionId — must NOT silently replay (which would
      // have ended up writing the event onto the wrong mission, or
      // skipping it entirely). Fingerprint mismatch surfaces as 409.
      const collide = createResponse();
      await handleBridgeRoutes({
        req: createRequest({
          method: "POST",
          url: "/bridge/command",
          headers,
          body: { tool: "snapshot" },
        }),
        res: collide.res,
        url: new URL("http://127.0.0.1/bridge/command"),
        deps,
      });
      assert.equal(collide.getStatus(), 409);
    });

    it("rejects whitespace-only missionId with 400 (codex K3 — must not silently disable audit)", async () => {
      const activityStore = memActivityStore();
      let dispatched = 0;
      const deps: BridgeRouteDeps = {
        getStatusInfo: async () => {
          throw new Error("not used");
        },
        commandDispatcher: {
          async dispatch(): Promise<BridgeCommandResponse> {
            dispatched += 1;
            return { status: 200, body: { ok: true } };
          },
        },
        missionContext: buildMissionDeps(activityStore),
      };
      const response = createResponse();
      await handleBridgeRoutes({
        req: createRequest({
          method: "POST",
          url: "/bridge/command",
          body: { tool: "snapshot", missionId: "   " },
        }),
        res: response.res,
        url: new URL("http://127.0.0.1/bridge/command"),
        deps,
      });
      assert.equal(response.getStatus(), 400);
      const body = response.getJson() as { code: string };
      assert.equal(body.code, "invalid_mission_context");
      assert.equal(dispatched, 0, "must not dispatch when missionId is blank");
      assert.equal(activityStore.events.length, 0);
    });

    it("missionId is optional — calls without it dispatch normally without recording", async () => {
      const activityStore = memActivityStore();
      const deps: BridgeRouteDeps = {
        getStatusInfo: async () => {
          throw new Error("not used");
        },
        commandDispatcher: {
          async dispatch(): Promise<BridgeCommandResponse> {
            return { status: 200, body: { ok: true } };
          },
        },
        missionContext: buildMissionDeps(activityStore),
      };
      const response = createResponse();
      await handleBridgeRoutes({
        req: createRequest({
          method: "POST",
          url: "/bridge/command",
          body: { tool: "snapshot" },
        }),
        res: response.res,
        url: new URL("http://127.0.0.1/bridge/command"),
        deps,
      });
      assert.equal(response.getStatus(), 200);
      assert.equal(activityStore.events.length, 0);
    });
  });
});
