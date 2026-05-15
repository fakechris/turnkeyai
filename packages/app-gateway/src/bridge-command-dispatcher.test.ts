import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  BrowserTaskAction,
  BrowserTaskRequest,
  BrowserTaskResult,
  IdGenerator,
} from "@turnkeyai/core-types/team";

import {
  TIER1_TOOLS,
  TIER2_TOOLS,
  buildTier1Action,
  buildTier2Action,
  createBridgeBatchDispatcher,
  createBridgeCommandDispatcher,
  createBridgeExpertDispatcher,
  createInMemoryAmbientSessionStore,
  type BridgeBrowserBridgeDeps,
} from "./bridge-command-dispatcher";

function makeIdGenerator(): IdGenerator {
  let seq = 0;
  return {
    teamId: () => `team-${++seq}`,
    threadId: () => `thread-${++seq}`,
    flowId: () => `flow-${++seq}`,
    messageId: () => `msg-${++seq}`,
    taskId: () => `task-${++seq}`,
  };
}

function makeFakeBridge(overrides: Partial<BridgeBrowserBridgeDeps> = {}): {
  bridge: BridgeBrowserBridgeDeps;
  history: Array<{ kind: "spawn" | "send" | "listTargets" | "activate" | "close"; payload: unknown }>;
} {
  const history: Array<{ kind: "spawn" | "send" | "listTargets" | "activate" | "close"; payload: unknown }> = [];
  const result: BrowserTaskResult = {
    sessionId: "session-spawned",
    page: { requestedUrl: "x", finalUrl: "x", title: "", textExcerpt: "", statusCode: 200, interactives: [] },
    screenshotPaths: [],
    trace: [],
    artifactIds: [],
  };
  return {
    history,
    bridge: {
      spawnSession: overrides.spawnSession ?? (async (input: BrowserTaskRequest) => {
        history.push({ kind: "spawn", payload: input });
        return result;
      }),
      sendSession: overrides.sendSession ?? (async (input) => {
        history.push({ kind: "send", payload: input });
        return { ...result, sessionId: input.browserSessionId };
      }),
      listTargets: overrides.listTargets ?? (async (sessionId) => {
        history.push({ kind: "listTargets", payload: sessionId });
        return [{ targetId: "t-1", url: "https://example.com" }];
      }),
      activateTarget: overrides.activateTarget ?? (async (sessionId, targetId) => {
        history.push({ kind: "activate", payload: { sessionId, targetId } });
        return { sessionId, targetId };
      }),
      closeTarget: overrides.closeTarget ?? (async (sessionId, targetId) => {
        history.push({ kind: "close", payload: { sessionId, targetId } });
        return { sessionId, targetId };
      }),
    },
  };
}

describe("bridge-command-dispatcher", () => {
  it("rejects unknown tools", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge } = makeFakeBridge();
    const dispatcher = createBridgeCommandDispatcher({
      bridge,
      ambient,
      idGenerator: makeIdGenerator(),
      clock: { now: () => 0 },
    });
    const response = await dispatcher.dispatch({ token: "tok", tool: "blow_up" });
    assert.equal(response.status, 404);
    assert.equal(response.body.code, "unknown_tool");
  });

  it("rejects missing tool name", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge } = makeFakeBridge();
    const dispatcher = createBridgeCommandDispatcher({
      bridge,
      ambient,
      idGenerator: makeIdGenerator(),
      clock: { now: () => 0 },
    });
    const response = await dispatcher.dispatch({ token: null, tool: "" });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "invalid_request");
  });

  it("navigate spawns ambient session on first call and reuses it", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge, history } = makeFakeBridge();
    const dispatcher = createBridgeCommandDispatcher({
      bridge,
      ambient,
      idGenerator: makeIdGenerator(),
      clock: { now: () => 0 },
    });
    const first = await dispatcher.dispatch({
      token: "tok",
      tool: "navigate",
      args: { url: "https://example.com" },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.tool, "navigate");
    assert.equal(history.filter((h) => h.kind === "spawn").length, 1);
    assert.equal(ambient.get("tok"), "session-spawned");

    const second = await dispatcher.dispatch({
      token: "tok",
      tool: "snapshot",
    });
    assert.equal(second.status, 200);
    assert.equal(history.filter((h) => h.kind === "send").length, 1);
    assert.equal(history.filter((h) => h.kind === "spawn").length, 1);
  });

  it("click requires refId/text/selectors", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge } = makeFakeBridge();
    const dispatcher = createBridgeCommandDispatcher({
      bridge,
      ambient,
      idGenerator: makeIdGenerator(),
      clock: { now: () => 0 },
    });
    const empty = await dispatcher.dispatch({ token: null, tool: "click", args: {} });
    assert.equal(empty.status, 400);
    const refOk = await dispatcher.dispatch({ token: null, tool: "click", args: { refId: "r-1" } });
    assert.equal(refOk.status, 200);
  });

  it("fill requires text and a target", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge, history } = makeFakeBridge();
    const dispatcher = createBridgeCommandDispatcher({
      bridge,
      ambient,
      idGenerator: makeIdGenerator(),
      clock: { now: () => 0 },
    });
    const noText = await dispatcher.dispatch({
      token: null,
      tool: "fill",
      args: { refId: "r-1" },
    });
    assert.equal(noText.status, 400);
    const ok = await dispatcher.dispatch({
      token: null,
      tool: "fill",
      args: { refId: "r-1", text: "hello" },
    });
    assert.equal(ok.status, 200);
    const spawned = history.find((h) => h.kind === "spawn") as { payload: BrowserTaskRequest };
    const action = spawned.payload.actions[0] as BrowserTaskAction;
    assert.equal(action.kind, "type");
    assert.equal((action as { text: string }).text, "hello");
  });

  it("list_tabs proxies through the bridge", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge, history } = makeFakeBridge();
    const dispatcher = createBridgeCommandDispatcher({
      bridge,
      ambient,
      idGenerator: makeIdGenerator(),
      clock: { now: () => 0 },
    });
    const response = await dispatcher.dispatch({ token: "tok", tool: "list_tabs" });
    assert.equal(response.status, 200);
    assert.equal(history.filter((h) => h.kind === "listTargets").length, 1);
    assert.ok(Array.isArray(response.body.result));
  });

  it("switch_tab requires targetId", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge } = makeFakeBridge();
    const dispatcher = createBridgeCommandDispatcher({
      bridge,
      ambient,
      idGenerator: makeIdGenerator(),
      clock: { now: () => 0 },
    });
    const missing = await dispatcher.dispatch({ token: null, tool: "switch_tab", args: {} });
    assert.equal(missing.status, 400);
    const ok = await dispatcher.dispatch({
      token: null,
      tool: "switch_tab",
      args: { targetId: "t-1" },
    });
    assert.equal(ok.status, 200);
  });

  it("maps transport error messages to transport_unavailable", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge } = makeFakeBridge({
      spawnSession: async () => {
        throw new Error("relay peer disconnected from transport");
      },
    });
    const dispatcher = createBridgeCommandDispatcher({
      bridge,
      ambient,
      idGenerator: makeIdGenerator(),
      clock: { now: () => 0 },
    });
    const response = await dispatcher.dispatch({
      token: null,
      tool: "navigate",
      args: { url: "https://example.com" },
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "transport_unavailable");
  });

  it("derives different ambient ids for different tokens", () => {
    const store = createInMemoryAmbientSessionStore();
    store.set("a", "session-a");
    store.set("b", "session-b");
    assert.equal(store.get("a"), "session-a");
    assert.equal(store.get("b"), "session-b");
    store.clear("a");
    assert.equal(store.get("a"), null);
  });

  it("Tier 2 'pdf' tool routes through a Page.printToPDF cdp action", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge, history } = makeFakeBridge();
    const dispatcher = createBridgeCommandDispatcher({
      bridge,
      ambient,
      idGenerator: makeIdGenerator(),
      clock: { now: () => 0 },
      allowedTools: new Set([...TIER1_TOOLS, ...TIER2_TOOLS]),
      buildAction: (tool, args) => {
        const tier1 = TIER1_TOOLS.has(tool) ? buildTier1Action(tool, args) : null;
        if (tier1 && !("error" in tier1)) return tier1;
        return buildTier2Action(tool, args);
      },
    });
    const response = await dispatcher.dispatch({ token: "tok", tool: "pdf" });
    assert.equal(response.status, 200);
    const spawn = history.find((entry) => entry.kind === "spawn") as { payload: BrowserTaskRequest };
    assert.equal(spawn.payload.actions[0]?.kind, "cdp");
    assert.equal((spawn.payload.actions[0] as { method: string }).method, "Page.printToPDF");
  });

  it("find_tab filters listTargets by url/title regex", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge } = makeFakeBridge({
      listTargets: async () => [
        { targetId: "t1", url: "https://example.com/login", title: "Sign in" },
        { targetId: "t2", url: "https://other.com", title: "Other" },
      ],
    });
    const dispatcher = createBridgeCommandDispatcher({
      bridge,
      ambient,
      idGenerator: makeIdGenerator(),
      clock: { now: () => 0 },
      allowedTools: new Set([...TIER1_TOOLS, ...TIER2_TOOLS]),
      buildAction: buildTier2Action,
    });
    const response = await dispatcher.dispatch({
      token: "tok",
      tool: "find_tab",
      args: { urlPattern: "example\\.com" },
    });
    assert.equal(response.status, 200);
    const result = response.body.result as Array<{ targetId: string }>;
    assert.equal(result.length, 1);
    assert.equal(result[0]!.targetId, "t1");
  });

  it("batch dispatcher executes multiple actions in one request", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge, history } = makeFakeBridge();
    const dispatcher = createBridgeBatchDispatcher({
      bridge,
      ambient,
      idGenerator: makeIdGenerator(),
      clock: { now: () => 0 },
      allowedTools: new Set([...TIER1_TOOLS]),
      buildAction: buildTier1Action,
    });
    const response = await dispatcher.dispatch({
      token: "tok",
      actions: [
        { tool: "navigate", args: { url: "https://example.com" } },
        { tool: "snapshot" },
      ],
    });
    assert.equal(response.status, 200);
    const spawned = history.find((entry) => entry.kind === "spawn") as { payload: BrowserTaskRequest };
    assert.equal(spawned.payload.actions.length, 2);
    assert.equal(spawned.payload.actions[0]?.kind, "open");
    assert.equal(spawned.payload.actions[1]?.kind, "snapshot");
  });

  it("batch dispatcher rejects target-mgmt tools", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge } = makeFakeBridge();
    const dispatcher = createBridgeBatchDispatcher({
      bridge,
      ambient,
      idGenerator: makeIdGenerator(),
      clock: { now: () => 0 },
      allowedTools: new Set([...TIER1_TOOLS]),
      buildAction: buildTier1Action,
    });
    const response = await dispatcher.dispatch({
      token: "tok",
      actions: [{ tool: "list_tabs" }],
    });
    assert.equal(response.status, 400);
    assert.match(String(response.body.error), /cannot be batched/);
  });

  it("expert dispatcher returns 409 when expert lane is null", async () => {
    const dispatcher = createBridgeExpertDispatcher({
      expertLane: null,
      ambient: createInMemoryAmbientSessionStore(),
      bridge: makeFakeBridge().bridge,
      idGenerator: makeIdGenerator(),
    });
    const response = await dispatcher.dispatch({
      token: "tok",
      tool: "expert.list_targets",
      sessionId: "s-1",
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "expert_lane_unavailable");
  });

  it("expert dispatcher routes expert.send to the lane", async () => {
    let captured: Record<string, unknown> | null = null;
    const fakeLane = {
      listExpertTargets: async () => [{ targetId: "t-1" }],
      attachExpertTarget: async () => ({ expertSessionId: "es-1" }),
      sendExpertCommand: async (input: Record<string, unknown>) => {
        captured = input;
        return { result: { ok: true } };
      },
      drainExpertEvents: async () => ({ events: [] }),
      detachExpertSession: async () => ({ detached: true }),
    };
    const dispatcher = createBridgeExpertDispatcher({
      expertLane: fakeLane as never,
      ambient: createInMemoryAmbientSessionStore(),
      bridge: makeFakeBridge().bridge,
      idGenerator: makeIdGenerator(),
    });
    const response = await dispatcher.dispatch({
      token: "tok",
      tool: "expert.send",
      args: { method: "Runtime.evaluate", params: { expression: "1+1" } },
      sessionId: "s-1",
    });
    assert.equal(response.status, 200);
    assert.equal((captured as Record<string, unknown> | null)?.method, "Runtime.evaluate");
  });
});
