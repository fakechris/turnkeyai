import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import { DirectCdpBrowserAdapter } from "@turnkeyai/browser-bridge/transport/direct-cdp-adapter";
import type { BrowserRawCdpExpertLane } from "@turnkeyai/core-types/team";

import { handleBrowserRoutes, type BrowserRouteDeps } from "./browser-routes";

function createRequest(input: { method: string; url: string; body?: unknown }) {
  const body =
    input.body === undefined ? [] : [Buffer.from(typeof input.body === "string" ? input.body : JSON.stringify(input.body))];
  return Object.assign(Readable.from(body), {
    method: input.method,
    url: input.url,
    headers: {},
  }) as any;
}

function createResponse() {
  let payload = "";
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as any;
  return {
    res,
    get json() {
      return payload ? JSON.parse(payload) : undefined;
    },
  };
}

function createDeps(expertLane: BrowserRawCdpExpertLane): BrowserRouteDeps {
  return {
    browserBridge: {
      async spawnSession() {
        throw new Error("not used");
      },
      async listSessions() {
        return [];
      },
      async getSessionHistory() {
        return [];
      },
      async listTargets() {
        return [];
      },
      async openTarget() {
        throw new Error("not used");
      },
      async sendSession() {
        throw new Error("not used");
      },
      async resumeSession() {
        throw new Error("not used");
      },
      async activateTarget() {
        throw new Error("not used");
      },
      async closeTarget() {
        throw new Error("not used");
      },
      async closeSession() {},
      async evictIdleSessions() {
        return [];
      },
    },
    browserExpert: {
      expertLane,
    },
    idGenerator: {
      teamId: () => "team-1",
      threadId: () => "thread-1",
      flowId: () => "flow-1",
      messageId: () => "message-1",
      taskId: () => "task-1",
    },
    clock: {
      now: () => 1000,
    },
    async resolveBrowserThreadOwner() {
      return { ownerType: "thread", ownerId: "thread-1", threadId: "thread-1" };
    },
    async requireBrowserSessionAccess(input) {
      return {
        sessionId: input.browserSessionId,
        threadId: "thread-1",
        ownerType: "thread",
        ownerId: "thread-1",
      };
    },
    buildBrowserTaskRequest() {
      throw new Error("not used");
    },
  };
}

async function callBrowserRoute(deps: BrowserRouteDeps, input: { method: string; url: string; body?: unknown }) {
  const response = createResponse();
  await handleBrowserRoutes({
    req: createRequest(input),
    res: response.res,
    url: new URL(input.url, "http://127.0.0.1"),
    deps,
  });
  return response;
}

class IframeAcceptanceRootCdpSession extends EventEmitter {
  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    switch (method) {
      case "Target.getTargets":
        return {
          targetInfos: [
            {
              targetId: "page-main",
              type: "page",
              title: "Main App",
              url: "https://app.example.com",
              attached: false,
              browserContextId: "context-1",
            },
            {
              targetId: "iframe-cross-origin",
              type: "iframe",
              title: "Embedded Console",
              url: "https://embed.example.net/frame",
              attached: false,
              openerId: "page-main",
              openerFrameId: "frame-main",
              browserContextId: "context-1",
            },
          ],
        };
      case "Target.attachToTarget":
        return {
          sessionId: `expert-${String(params?.targetId ?? "unknown")}`,
        };
      case "Target.detachFromTarget":
        this.emit("Target.detachedFromTarget", {
          sessionId: params?.sessionId,
          targetId: "iframe-cross-origin",
        });
        return {};
      case "Target.sendMessageToTarget": {
        const payload = JSON.parse(String(params?.message ?? "{}"));
        const sessionId = String(params?.sessionId ?? "");
        queueMicrotask(() => {
          this.emit("Target.receivedMessageFromTarget", {
            sessionId,
            message: JSON.stringify({
              method: "Runtime.executionContextCreated",
              params: {
                context: {
                  id: 7,
                  origin: "https://embed.example.net",
                  name: "iframe-oopif",
                },
              },
            }),
          });
        });
        queueMicrotask(() => {
          this.emit("Target.receivedMessageFromTarget", {
            sessionId,
            message: JSON.stringify({
              id: payload.id,
              result: {
                result: {
                  type: "string",
                  value: payload.method === "Runtime.evaluate" ? "iframe-ready" : "ok",
                },
              },
            }),
          });
        });
        return {};
      }
      default:
        throw new Error(`unexpected root method: ${method}`);
    }
  }
}

class IframeAcceptanceBrowser extends EventEmitter {
  constructor(private readonly rootSession: IframeAcceptanceRootCdpSession) {
    super();
  }

  contexts(): never[] {
    return [];
  }

  async newContext(): Promise<never> {
    throw new Error("newContext should not be called in raw expert acceptance");
  }

  async newBrowserCDPSession(): Promise<IframeAcceptanceRootCdpSession> {
    return this.rootSession;
  }
}

class RawCdpScenarioRootSession extends EventEmitter {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];

  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    this.sent.push(params ? { method, params } : { method });
    switch (method) {
      case "Target.getTargets":
        return {
          targetInfos: [
            {
              targetId: "page-main",
              type: "page",
              title: "Main App",
              url: "https://app.example.com",
              attached: false,
              browserContextId: "context-1",
            },
            {
              targetId: "iframe-cross-origin",
              type: "iframe",
              title: "Embedded Console",
              url: "https://embed.example.net/frame",
              attached: false,
              openerId: "page-main",
              openerFrameId: "frame-main",
              browserContextId: "context-1",
            },
            {
              targetId: "iframe-nested-shadow",
              type: "iframe",
              title: "Nested Shadow Form",
              url: "https://nested.example.net/shadow",
              attached: false,
              openerId: "iframe-cross-origin",
              openerFrameId: "frame-nested",
              browserContextId: "context-1",
              subtype: "prerender",
            },
            {
              targetId: "popup-auth",
              type: "page",
              title: "Auth Popup",
              url: "https://auth.example.net/consent",
              attached: false,
              openerId: "page-main",
              browserContextId: "context-1",
            },
          ],
        };
      case "Target.attachToTarget":
        return {
          sessionId: `expert-${String(params?.targetId ?? "unknown")}`,
        };
      case "Target.detachFromTarget":
        this.emit("Target.detachedFromTarget", {
          sessionId: params?.sessionId,
          targetId: String(params?.sessionId ?? "").replace(/^expert-/, ""),
        });
        return {};
      case "Target.sendMessageToTarget":
        return this.handleTargetMessage(params);
      default:
        throw new Error(`unexpected root method: ${method}`);
    }
  }

  emitPopupTarget(): void {
    this.emit("Target.targetCreated", {
      targetInfo: {
        targetId: "popup-auth",
        type: "page",
        title: "Auth Popup",
        url: "https://auth.example.net/consent",
        attached: false,
        openerId: "page-main",
      },
    });
  }

  private handleTargetMessage(params?: Record<string, unknown>): Record<string, never> {
    const payload = JSON.parse(String(params?.message ?? "{}"));
    const sessionId = String(params?.sessionId ?? "");
    if (payload.method === "Runtime.longTask") {
      queueMicrotask(() => {
        this.emit("Target.detachedFromTarget", {
          sessionId,
          targetId: sessionId.replace(/^expert-/, ""),
        });
      });
      return {};
    }

    if (payload.method === "Runtime.evaluate") {
      queueMicrotask(() => {
        this.emit("Target.receivedMessageFromTarget", {
          sessionId,
          message: JSON.stringify({
            method: "Runtime.consoleAPICalled",
            params: {
              type: "log",
              args: [{ type: "string", value: "shadow form ready" }],
            },
          }),
        });
      });
    }

    queueMicrotask(() => {
      this.emit("Target.receivedMessageFromTarget", {
        sessionId,
        message: JSON.stringify({
          id: payload.id,
          result: this.buildResult(payload.method, payload.params),
        }),
      });
    });
    return {};
  }

  private buildResult(method: unknown, params: unknown): Record<string, unknown> {
    if (method === "Runtime.evaluate") {
      const expression = typeof (params as { expression?: unknown })?.expression === "string"
        ? String((params as { expression?: unknown }).expression)
        : "";
      return {
        result: {
          type: "string",
          value: expression.includes("shadowRoot") ? "nested-shadow-submit-ready" : "eval-ok",
        },
      };
    }

    if (method === "Input.dispatchMouseEvent") {
      return {
        dispatched: true,
        x: (params as { x?: unknown })?.x,
        y: (params as { y?: unknown })?.y,
        type: (params as { type?: unknown })?.type,
      };
    }

    return {
      ok: true,
      echoedMethod: method,
    };
  }
}

class RawCdpScenarioBrowser extends EventEmitter {
  constructor(private readonly rootSession: RawCdpScenarioRootSession) {
    super();
  }

  contexts(): never[] {
    return [];
  }

  async newContext(): Promise<never> {
    throw new Error("newContext should not be called in raw CDP scenario tests");
  }

  async newBrowserCDPSession(): Promise<RawCdpScenarioRootSession> {
    return this.rootSession;
  }
}

function createRawCdpScenarioDeps(rootSession = new RawCdpScenarioRootSession()) {
  const adapter = new DirectCdpBrowserAdapter(
    {
      artifactRootDir: "/tmp/turnkeyai-browser-expert-scenarios",
      transportMode: "direct-cdp",
      directCdp: {
        endpoint: "ws://127.0.0.1:9222/devtools/browser/browser-id",
      },
    },
    {
      connectBrowser: async () => new RawCdpScenarioBrowser(rootSession) as any,
    }
  );
  return {
    rootSession,
    deps: createDeps(adapter.getRawCdpExpertLane()),
  };
}

test("browser expert acceptance handles iframe target attach and raw session-scoped CDP commands", async () => {
  const adapter = new DirectCdpBrowserAdapter(
    {
      artifactRootDir: "/tmp/turnkeyai-browser-expert-acceptance",
      transportMode: "direct-cdp",
      directCdp: {
        endpoint: "ws://127.0.0.1:9222/devtools/browser/browser-id",
      },
    },
    {
      connectBrowser: async () => new IframeAcceptanceBrowser(new IframeAcceptanceRootCdpSession()) as any,
    }
  );
  const deps = createDeps(adapter.getRawCdpExpertLane());

  const targetsResponse = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "GET",
      url: "/browser-sessions/session-iframe/expert/targets?threadId=thread-1",
    }),
    res: targetsResponse.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-iframe/expert/targets?threadId=thread-1"),
    deps,
  });
  assert.equal(targetsResponse.res.statusCode, 200);
  const iframeTarget = targetsResponse.json.find((target: { targetId: string }) => target.targetId === "iframe-cross-origin");
  assert.ok(iframeTarget);
  assert.equal(iframeTarget.type, "iframe");
  assert.equal(iframeTarget.browserContextId, "context-1");

  const attachResponse = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-iframe/expert/attach",
      body: { threadId: "thread-1", targetId: "iframe-cross-origin" },
    }),
    res: attachResponse.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-iframe/expert/attach"),
    deps,
  });
  assert.equal(attachResponse.res.statusCode, 200);
  assert.equal(attachResponse.json.expertSessionId, "expert-iframe-cross-origin");

  const sendResponse = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-iframe/expert/send",
      body: {
        threadId: "thread-1",
        expertSessionId: "expert-iframe-cross-origin",
        method: "Runtime.evaluate",
        params: {
          expression: "window.__bridgeReady",
          awaitPromise: true,
          returnByValue: true,
        },
      },
    }),
    res: sendResponse.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-iframe/expert/send"),
    deps,
  });
  assert.equal(sendResponse.res.statusCode, 200);
  assert.deepEqual(sendResponse.json, {
    method: "Runtime.evaluate",
    scope: "attached",
    expertSessionId: "expert-iframe-cross-origin",
    targetId: "iframe-cross-origin",
    result: {
      result: {
        type: "string",
        value: "iframe-ready",
      },
    },
  });

  const eventsResponse = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "GET",
      url: "/browser-sessions/session-iframe/expert/events?threadId=thread-1&expertSessionId=expert-iframe-cross-origin&limit=5",
    }),
    res: eventsResponse.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-iframe/expert/events?threadId=thread-1&expertSessionId=expert-iframe-cross-origin&limit=5"),
    deps,
  });
  assert.equal(eventsResponse.res.statusCode, 200);
  assert.equal(eventsResponse.json.length, 1);
  assert.equal(eventsResponse.json[0].method, "Runtime.executionContextCreated");
  assert.equal(eventsResponse.json[0].params.context.origin, "https://embed.example.net");

  const detachResponse = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-iframe/expert/detach",
      body: {
        threadId: "thread-1",
        expertSessionId: "expert-iframe-cross-origin",
      },
    }),
    res: detachResponse.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-iframe/expert/detach"),
    deps,
  });
  assert.equal(detachResponse.res.statusCode, 200);
  assert.deepEqual(detachResponse.json, {
    browserSessionId: "session-iframe",
    expertSessionId: "expert-iframe-cross-origin",
    targetId: "iframe-cross-origin",
    detached: true,
  });
});

test("browser expert scenarios drive nested iframe shadow DOM work with session-scoped Runtime.evaluate", async () => {
  const { deps } = createRawCdpScenarioDeps();

  const targetsResponse = await callBrowserRoute(deps, {
    method: "GET",
    url: "/browser-sessions/session-shadow/expert/targets?threadId=thread-1",
  });
  assert.equal(targetsResponse.res.statusCode, 200);
  const nestedTarget = targetsResponse.json.find((target: { targetId: string }) => target.targetId === "iframe-nested-shadow");
  assert.equal(nestedTarget?.type, "iframe");
  assert.equal(nestedTarget?.subtype, "prerender");
  assert.equal(nestedTarget?.openerId, "iframe-cross-origin");

  const attachResponse = await callBrowserRoute(deps, {
    method: "POST",
    url: "/browser-sessions/session-shadow/expert/attach",
    body: {
      threadId: "thread-1",
      targetId: "iframe-nested-shadow",
    },
  });
  assert.equal(attachResponse.res.statusCode, 200);
  assert.equal(attachResponse.json.expertSessionId, "expert-iframe-nested-shadow");

  const evalResponse = await callBrowserRoute(deps, {
    method: "POST",
    url: "/browser-sessions/session-shadow/expert/send",
    body: {
      threadId: "thread-1",
      expertSessionId: "expert-iframe-nested-shadow",
      method: "Runtime.evaluate",
      params: {
        expression: "document.querySelector('host-el').shadowRoot.querySelector('button').textContent",
        returnByValue: true,
      },
    },
  });
  assert.equal(evalResponse.res.statusCode, 200);
  assert.equal(evalResponse.json.scope, "attached");
  assert.equal(evalResponse.json.result.result.value, "nested-shadow-submit-ready");

  const eventsResponse = await callBrowserRoute(deps, {
    method: "GET",
    url: "/browser-sessions/session-shadow/expert/events?threadId=thread-1&expertSessionId=expert-iframe-nested-shadow&limit=10",
  });
  assert.equal(eventsResponse.res.statusCode, 200);
  assert.equal(eventsResponse.json[0]?.method, "Runtime.consoleAPICalled");
});

test("browser expert scenarios dispatch compositor-level coordinates inside an attached target", async () => {
  const { deps } = createRawCdpScenarioDeps();
  const attachResponse = await callBrowserRoute(deps, {
    method: "POST",
    url: "/browser-sessions/session-input/expert/attach",
    body: {
      threadId: "thread-1",
      targetId: "iframe-cross-origin",
    },
  });
  assert.equal(attachResponse.res.statusCode, 200);

  const mouseResponse = await callBrowserRoute(deps, {
    method: "POST",
    url: "/browser-sessions/session-input/expert/send",
    body: {
      threadId: "thread-1",
      expertSessionId: attachResponse.json.expertSessionId,
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mousePressed",
        x: 412,
        y: 318,
        button: "left",
        clickCount: 1,
      },
    },
  });
  assert.equal(mouseResponse.res.statusCode, 200);
  assert.deepEqual(mouseResponse.json.result, {
    dispatched: true,
    x: 412,
    y: 318,
    type: "mousePressed",
  });
});

test("browser expert scenarios support one-shot target commands and detach their temporary session", async () => {
  const { deps, rootSession } = createRawCdpScenarioDeps();

  const sendResponse = await callBrowserRoute(deps, {
    method: "POST",
    url: "/browser-sessions/session-oneshot/expert/send",
    body: {
      threadId: "thread-1",
      targetId: "iframe-nested-shadow",
      method: "Runtime.evaluate",
      params: {
        expression: "window.location.href",
        returnByValue: true,
      },
    },
  });
  assert.equal(sendResponse.res.statusCode, 200);
  assert.equal(sendResponse.json.scope, "attached");
  assert.equal(sendResponse.json.expertSessionId, "expert-iframe-nested-shadow");
  assert.equal(
    rootSession.sent.some((entry) => entry.method === "Target.detachFromTarget" && entry.params?.sessionId === "expert-iframe-nested-shadow"),
    true
  );

  const eventsResponse = await callBrowserRoute(deps, {
    method: "GET",
    url: "/browser-sessions/session-oneshot/expert/events?threadId=thread-1&expertSessionId=expert-iframe-nested-shadow",
  });
  assert.equal(eventsResponse.res.statusCode, 404);
  assert.equal(eventsResponse.json.error, "expert session not found");
});

test("browser expert scenarios expose root target events for popup discovery", async () => {
  const { deps, rootSession } = createRawCdpScenarioDeps();

  const targetsResponse = await callBrowserRoute(deps, {
    method: "GET",
    url: "/browser-sessions/session-popup/expert/targets?threadId=thread-1",
  });
  assert.equal(targetsResponse.res.statusCode, 200);
  rootSession.emitPopupTarget();

  const rootEventsResponse = await callBrowserRoute(deps, {
    method: "GET",
    url: "/browser-sessions/session-popup/expert/events?threadId=thread-1&limit=10",
  });
  assert.equal(rootEventsResponse.res.statusCode, 200);
  assert.equal(rootEventsResponse.json.length, 1);
  assert.equal(rootEventsResponse.json[0].method, "Target.targetCreated");
  assert.equal(rootEventsResponse.json[0].params.targetInfo.targetId, "popup-auth");
});

test("browser expert scenarios fail an in-flight raw command when its target detaches", async () => {
  const { deps } = createRawCdpScenarioDeps();
  const attachResponse = await callBrowserRoute(deps, {
    method: "POST",
    url: "/browser-sessions/session-detach/expert/attach",
    body: {
      threadId: "thread-1",
      targetId: "iframe-cross-origin",
    },
  });
  assert.equal(attachResponse.res.statusCode, 200);

  const sendResponse = await callBrowserRoute(deps, {
    method: "POST",
    url: "/browser-sessions/session-detach/expert/send",
    body: {
      threadId: "thread-1",
      expertSessionId: attachResponse.json.expertSessionId,
      method: "Runtime.longTask",
      params: {},
      timeoutMs: 1000,
    },
  });
  assert.equal(sendResponse.res.statusCode, 502);
  assert.equal(sendResponse.json.error, "expert session detached");

  const eventsResponse = await callBrowserRoute(deps, {
    method: "GET",
    url: `/browser-sessions/session-detach/expert/events?threadId=thread-1&expertSessionId=${attachResponse.json.expertSessionId}`,
  });
  assert.equal(eventsResponse.res.statusCode, 404);
  assert.equal(eventsResponse.json.error, "expert session not found");
});
