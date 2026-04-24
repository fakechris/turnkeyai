import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { DirectCdpBrowserAdapter } from "./direct-cdp-adapter";

class FakeRootCdpSession extends EventEmitter {
  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    switch (method) {
      case "Target.getTargets":
        return {
          targetInfos: [
            {
              targetId: "target-1",
              type: "page",
              title: "Example",
              url: "https://example.com",
              attached: false,
            },
            {
              targetId: "target-2",
              type: "iframe",
              title: "Embedded",
              url: "https://iframe.example.com",
              attached: false,
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
          targetId: "target-1",
        });
        return {};
      case "Target.sendMessageToTarget": {
        const payload = JSON.parse(String(params?.message ?? "{}"));
        const sessionId = String(params?.sessionId ?? "");
        if (payload.method === "Runtime.enable") {
          this.emit("Target.receivedMessageFromTarget", {
            sessionId,
            message: JSON.stringify({
              method: "Runtime.consoleAPICalled",
              params: {
                type: "log",
              },
            }),
          });
        }
        queueMicrotask(() => {
          this.emit("Target.receivedMessageFromTarget", {
            sessionId,
            message: JSON.stringify({
              id: payload.id,
              result: {
                ok: true,
                echoedMethod: payload.method,
              },
            }),
          });
        });
        return {};
      }
      case "Browser.getVersion":
        return {
          product: "Chrome/123.0.0.0",
        };
      default:
        throw new Error(`unexpected root method: ${method}`);
    }
  }
}

class FakeBrowser extends EventEmitter {
  constructor(private readonly rootSession: FakeRootCdpSession) {
    super();
  }

  contexts(): never[] {
    return [];
  }

  async newContext(): Promise<never> {
    throw new Error("newContext should not be called in raw CDP expert lane tests");
  }

  async newBrowserCDPSession(): Promise<FakeRootCdpSession> {
    return this.rootSession;
  }
}

test("direct-cdp adapter exposes raw expert lane list/attach/send/drain/detach flow", async () => {
  const rootSession = new FakeRootCdpSession();
  const adapter = new DirectCdpBrowserAdapter(
    {
      artifactRootDir: "/tmp/turnkeyai-browser-direct-cdp-expert-test",
      transportMode: "direct-cdp",
      directCdp: {
        endpoint: "ws://127.0.0.1:9222/devtools/browser/browser-id",
      },
    },
    {
      connectBrowser: async () => new FakeBrowser(rootSession) as any,
    }
  );

  const expertLane = adapter.getRawCdpExpertLane();
  const targets = await expertLane.listExpertTargets("browser-session-1");
  assert.equal(targets.length, 2);
  assert.equal(targets[0]?.targetId, "target-1");
  assert.equal(targets[1]?.type, "iframe");

  const attached = await expertLane.attachExpertTarget({
    browserSessionId: "browser-session-1",
    targetId: "target-1",
  });
  assert.equal(attached.expertSessionId, "expert-target-1");

  const sendResult = await expertLane.sendExpertCommand({
    browserSessionId: "browser-session-1",
    expertSessionId: attached.expertSessionId,
    method: "Runtime.enable",
  });
  assert.equal(sendResult.scope, "attached");
  assert.deepEqual(sendResult.result, {
    ok: true,
    echoedMethod: "Runtime.enable",
  });

  const drained = await expertLane.drainExpertEvents({
    browserSessionId: "browser-session-1",
    expertSessionId: attached.expertSessionId,
  });
  assert.equal(drained.length, 1);
  assert.equal(drained[0]?.method, "Runtime.consoleAPICalled");

  const detached = await expertLane.detachExpertSession({
    browserSessionId: "browser-session-1",
    expertSessionId: attached.expertSessionId,
  });
  assert.deepEqual(detached, {
    browserSessionId: "browser-session-1",
    expertSessionId: "expert-target-1",
    targetId: "target-1",
    detached: true,
  });
});

test("direct-cdp adapter raw expert lane can send root-scoped commands", async () => {
  const rootSession = new FakeRootCdpSession();
  const adapter = new DirectCdpBrowserAdapter(
    {
      artifactRootDir: "/tmp/turnkeyai-browser-direct-cdp-expert-root-test",
      transportMode: "direct-cdp",
      directCdp: {
        endpoint: "ws://127.0.0.1:9222/devtools/browser/browser-id",
      },
    },
    {
      connectBrowser: async () => new FakeBrowser(rootSession) as any,
    }
  );

  const result = await adapter.getRawCdpExpertLane().sendExpertCommand({
    browserSessionId: "browser-session-1",
    method: "Browser.getVersion",
  });

  assert.equal(result.scope, "root");
  assert.deepEqual(result.result, {
    product: "Chrome/123.0.0.0",
  });
});
