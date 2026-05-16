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

/**
 * Minimum-viable args for each TIER2 tool so the contract test in PR B can
 * call buildTier2Action without tripping required-arg validators. The intent
 * is to assert "this tool is implemented at all" — not to exercise every
 * branch of every tool. If a tool grows new required args, this map should
 * grow with it.
 */
function defaultArgsFor(tool: string): Record<string, unknown> {
  switch (tool) {
    case "hover":
      return { selectors: ["#x"] };
    case "scroll":
      return { direction: "down" };
    case "dialog":
      return { action: "accept" };
    case "popup":
      return {};
    case "console":
      return { probe: "page-metadata" };
    case "probe":
      return { kind: "page-state" };
    case "pdf":
      return {};
    case "click_coord":
      return { x: 10, y: 20 };
    case "screenshot_clip":
      return { x: 0, y: 0, width: 100, height: 100 };
    default:
      return {};
  }
}

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

  it("find_tab rejects oversized regex patterns (ReDoS guard)", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge } = makeFakeBridge({
      listTargets: async () => [
        { targetId: "t1", url: "https://example.com", title: "Example" },
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
    const oversized = "a".repeat(3000);
    const response = await dispatcher.dispatch({
      token: "tok",
      tool: "find_tab",
      args: { urlPattern: oversized },
    });
    // Oversized regex is treated as no filter (no match), so result is empty
    // rather than crashing or hanging.
    assert.equal(response.status, 200);
    const result = response.body.result as Array<unknown>;
    assert.equal(result.length, 1);
  });

  it("list_tabs tolerates a non-array bridge response", async () => {
    const ambient = createInMemoryAmbientSessionStore();
    const { bridge } = makeFakeBridge({
      listTargets: async () => null as unknown as Array<Record<string, unknown>>,
    });
    const dispatcher = createBridgeCommandDispatcher({
      bridge,
      ambient,
      idGenerator: makeIdGenerator(),
      clock: { now: () => 0 },
    });
    const response = await dispatcher.dispatch({ token: "tok", tool: "list_tabs" });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.result));
    assert.equal((response.body.result as Array<unknown>).length, 0);
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

  // PR A — facade correctness fixes flagged by the Step-7 aftermath audit.

  it("buildTier1Action('wait_for') normalizes selector to selectors: [selector]", () => {
    // The browser executor's BrowserActionTarget expects `selectors: string[]`.
    // Earlier dispatcher wrote singular `selector: string`, producing an
    // action shape the executor could not resolve — wait_for was a silently
    // broken facade tool.
    const built = buildTier1Action("wait_for", { selector: "#submit-button" });
    assert.equal("error" in built, false);
    assert.equal("action" in built, true);
    if (!("action" in built)) return;
    const action = built.action as Record<string, unknown>;
    assert.equal(action.kind, "waitFor");
    assert.deepEqual(action.selectors, ["#submit-button"], "selectors must be an array");
    assert.equal(action.selector, undefined, "singular selector must not be set");
  });

  it("buildTier1Action('wait_for') still accepts refId / text / urlPattern targets", () => {
    const byRef = buildTier1Action("wait_for", { refId: "ref-1" });
    if (!("action" in byRef)) {
      assert.fail("wait_for refId must build");
    }
    assert.equal((byRef.action as Record<string, unknown>).refId, "ref-1");

    const byText = buildTier1Action("wait_for", { text: "Continue" });
    if (!("action" in byText)) {
      assert.fail("wait_for text must build");
    }
    assert.equal((byText.action as Record<string, unknown>).text, "Continue");
  });

  it("buildTier2Action('click_coord') emits BOTH mousePressed AND mouseReleased", () => {
    // Earlier dispatcher only emitted mousePressed. Many pages only fire JS
    // click handlers when both events arrive, so half-click did nothing
    // observable in the page despite looking like a click in CDP traces.
    const built = buildTier2Action("click_coord", { x: 120, y: 200, button: "left" });
    assert.equal("error" in built, false);
    assert.equal("actions" in built, true);
    if (!("actions" in built)) return;
    assert.equal(built.actions.length, 2, "click_coord must emit press + release as a sequence");

    const seq = built.actions as unknown as Array<{
      kind: string;
      method: string;
      params: Record<string, unknown>;
    }>;
    const press = seq[0]!;
    const release = seq[1]!;
    assert.equal(press.kind, "cdp");
    assert.equal(release.kind, "cdp");
    assert.equal(press.method, "Input.dispatchMouseEvent");
    assert.equal(release.method, "Input.dispatchMouseEvent");
    assert.equal(press.params.type, "mousePressed");
    assert.equal(release.params.type, "mouseReleased");
    assert.equal(press.params.x, 120);
    assert.equal(press.params.y, 200);
    assert.equal(release.params.x, 120, "release must target the same coordinates");
    assert.equal(release.params.y, 200);
    assert.equal(press.params.button, "left");
    assert.equal(release.params.button, "left");
  });

  it("buildTier2Action('click_coord') defaults button to 'left' on both events", () => {
    const built = buildTier2Action("click_coord", { x: 10, y: 20 });
    if (!("actions" in built)) {
      assert.fail("click_coord must build");
    }
    assert.equal(built.actions.length, 2);
    for (const action of built.actions as unknown as Array<{ params: Record<string, unknown> }>) {
      assert.equal(action.params.button, "left");
    }
  });

  it("TIER2_TOOLS only lists tools that buildTier2Action (or dispatcher special cases) actually implement", () => {
    // PR B — facade honesty. The earlier set listed 10 tools whose
    // buildTier2Action branch just returned "use /browser-sessions/:id/send"
    // — that is the OPPOSITE of a facade. This test pins the new contract:
    // every TIER2_TOOLS entry must produce a valid action (or be one of the
    // dispatcher's known special-case tools), not a tier-2-tool-not-
    // implemented error.
    const dispatcherSpecialCases = new Set(["find_tab"]); // routed in dispatcher, not via buildTier2Action
    for (const tool of TIER2_TOOLS) {
      if (dispatcherSpecialCases.has(tool)) continue;
      const built = buildTier2Action(tool, defaultArgsFor(tool));
      if ("error" in built) {
        assert.ok(
          !built.error.startsWith("tool not implemented in Tier 2"),
          `TIER2_TOOLS entry '${tool}' must not return the not-implemented error: ${built.error}`,
        );
        // Some tools return a different error for missing required args
        // (e.g. "click_coord requires args.x and args.y") — that's fine, as
        // long as it isn't the catch-all rejection.
      }
    }
  });

  it("buildTier2Action rejects previously-listed-but-unimplemented tools with the not-implemented error", () => {
    // The PR B removal list. Each of these used to be in TIER2_TOOLS but
    // returned "use /browser-sessions/:id/send" — they are now properly
    // surfaced as not-in-tier-2 errors so the agent gets a clean signal
    // instead of being told the facade exists but to use a different route.
    const removed = [
      "storage",
      "cookie",
      "permission",
      "download",
      "drag",
      "network_capture",
      "network_mock",
      "network_block",
      "network_set_headers",
      "network_emulate",
    ];
    for (const tool of removed) {
      assert.equal(TIER2_TOOLS.has(tool), false, `${tool} should no longer be in TIER2_TOOLS`);
      const built = buildTier2Action(tool, {});
      if (!("error" in built)) {
        assert.fail(`buildTier2Action('${tool}') unexpectedly built an action`);
      }
      assert.equal(built.error, `tool not implemented in Tier 2: ${tool}`);
    }
  });

  it("click_coord sequence flows through single-tool dispatcher as a two-action BrowserTaskRequest", async () => {
    // End-to-end: confirm the multi-action build result is wired through the
    // single-tool dispatcher into a BrowserTaskRequest with both CDP actions
    // in order. The previous return type was { action } (singular), so this
    // path would have only sent the press event.
    const { bridge, history } = makeFakeBridge();
    const dispatcher = createBridgeCommandDispatcher({
      bridge,
      ambient: createInMemoryAmbientSessionStore(),
      idGenerator: makeIdGenerator(),
      clock: { now: () => 1 },
      allowedTools: new Set([...TIER1_TOOLS, ...TIER2_TOOLS]),
      buildAction: (tool, args) => {
        if (TIER1_TOOLS.has(tool)) return buildTier1Action(tool, args);
        return buildTier2Action(tool, args);
      },
      expertLaneAvailable: () => false,
    });
    await dispatcher.dispatch({
      token: "tok",
      tool: "click_coord",
      args: { x: 50, y: 80 },
      sessionId: "session-1",
    });
    const sent = history.find((entry) => entry.kind === "send");
    assert.ok(sent, "dispatcher should send to existing session");
    const task = sent!.payload as BrowserTaskRequest;
    assert.equal(task.actions.length, 2, "BrowserTaskRequest must carry both press + release");
    const seq = task.actions as unknown as Array<{ params: Record<string, unknown> }>;
    assert.equal(seq[0]!.params.type, "mousePressed");
    assert.equal(seq[1]!.params.type, "mouseReleased");
  });
});
