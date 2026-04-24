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
