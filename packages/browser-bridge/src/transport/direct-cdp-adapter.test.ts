import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { DirectCdpBrowserAdapter } from "./direct-cdp-adapter";

class FakeRootCdpSession extends EventEmitter {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];

  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    this.sent.push(params ? { method, params } : { method });
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

class AttachFailureRootCdpSession extends FakeRootCdpSession {
  override async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (method === "Target.attachToTarget") {
      this.sent.push(params ? { method, params } : { method });
      return {};
    }
    return super.send(method, params);
  }
}

class MissingTargetRootCdpSession extends FakeRootCdpSession {
  override async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (method === "Target.attachToTarget") {
      this.sent.push(params ? { method, params } : { method });
      throw new Error("No target with given id found");
    }
    return super.send(method, params);
  }
}

class CommandTimeoutRootCdpSession extends FakeRootCdpSession {
  override async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (method === "Target.sendMessageToTarget") {
      this.sent.push(params ? { method, params } : { method });
      return {};
    }
    return super.send(method, params);
  }
}

class DetachThenRecoverRootCdpSession extends FakeRootCdpSession {
  private attachCounter = 0;
  private sendCounter = 0;

  override async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (method === "Target.attachToTarget") {
      this.sent.push(params ? { method, params } : { method });
      this.attachCounter += 1;
      return {
        sessionId: `expert-target-1-${this.attachCounter}`,
      };
    }
    if (method === "Target.sendMessageToTarget") {
      const payload = JSON.parse(String(params?.message ?? "{}"));
      const sessionId = String(params?.sessionId ?? "");
      if (payload.method === "Runtime.enable" && this.sendCounter === 0) {
        this.sent.push(params ? { method, params } : { method });
        this.sendCounter += 1;
        queueMicrotask(() => {
          this.emit("Target.detachedFromTarget", {
            sessionId,
            targetId: "target-1",
          });
        });
        return {};
      }
      this.sendCounter += 1;
    }
    return super.send(method, params);
  }
}

class GenericSessionNotFoundRootCdpSession extends FakeRootCdpSession {
  override async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (method === "Target.sendMessageToTarget") {
      this.sent.push(params ? { method, params } : { method });
      throw new Error("Protocol error: Session with given id not found");
    }
    return super.send(method, params);
  }
}

class DetachThenRetryFailureRootCdpSession extends FakeRootCdpSession {
  private attachCounter = 0;
  private sendCounter = 0;

  override async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (method === "Target.attachToTarget") {
      this.sent.push(params ? { method, params } : { method });
      this.attachCounter += 1;
      return {
        sessionId: `expert-target-1-${this.attachCounter}`,
      };
    }
    if (method === "Target.sendMessageToTarget") {
      const payload = JSON.parse(String(params?.message ?? "{}"));
      const sessionId = String(params?.sessionId ?? "");
      this.sent.push(params ? { method, params } : { method });
      if (payload.method === "Runtime.enable" && this.sendCounter === 0) {
        this.sendCounter += 1;
        queueMicrotask(() => {
          this.emit("Target.detachedFromTarget", {
            sessionId,
            targetId: "target-1",
          });
        });
        return {};
      }
      this.sendCounter += 1;
      throw new Error("retry transport failed");
    }
    return super.send(method, params);
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

test("direct-cdp adapter clears detached expert queues and ignores late events", async () => {
  const rootSession = new FakeRootCdpSession();
  const adapter = new DirectCdpBrowserAdapter(
    {
      artifactRootDir: "/tmp/turnkeyai-browser-direct-cdp-expert-detach-test",
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
  const attached = await expertLane.attachExpertTarget({
    browserSessionId: "browser-session-1",
    targetId: "target-1",
  });

  rootSession.emit("Target.receivedMessageFromTarget", {
    sessionId: attached.expertSessionId,
    message: JSON.stringify({
      method: "Runtime.executionContextCreated",
      params: {
        id: "ctx-1",
      },
    }),
  });

  const initialEvents = await expertLane.drainExpertEvents({
    browserSessionId: "browser-session-1",
    expertSessionId: attached.expertSessionId,
  });
  assert.equal(initialEvents.length, 1);
  assert.equal(initialEvents[0]?.method, "Runtime.executionContextCreated");

  rootSession.emit("Target.detachedFromTarget", {
    sessionId: attached.expertSessionId,
    targetId: attached.targetId,
  });

  rootSession.emit("Target.receivedMessageFromTarget", {
    sessionId: attached.expertSessionId,
    message: JSON.stringify({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "log",
      },
    }),
  });

  await assert.rejects(
    expertLane.drainExpertEvents({
      browserSessionId: "browser-session-1",
      expertSessionId: attached.expertSessionId,
    }),
    /expert session not found/
  );

  assert.equal(
    (adapter as unknown as { expertEventQueues: Map<string, unknown[]> }).expertEventQueues.has(attached.expertSessionId),
    false
  );
});

test("direct-cdp adapter classifies attach failures after relisting targets", async () => {
  const rootSession = new AttachFailureRootCdpSession();
  const adapter = new DirectCdpBrowserAdapter(
    {
      artifactRootDir: "/tmp/turnkeyai-browser-direct-cdp-expert-attach-failure-test",
      transportMode: "direct-cdp",
      directCdp: {
        endpoint: "ws://127.0.0.1:9222/devtools/browser/browser-id",
      },
    },
    {
      connectBrowser: async () => new FakeBrowser(rootSession) as any,
    }
  );

  await assert.rejects(
    adapter.getRawCdpExpertLane().attachExpertTarget({
      browserSessionId: "browser-session-1",
      targetId: "target-1",
    }),
    /attach_failed: Target\.attachToTarget did not return a sessionId/
  );
  assert.equal(rootSession.sent.some((entry) => entry.method === "Target.detachFromTarget"), false);
});

test("direct-cdp adapter classifies missing targets after attach relist", async () => {
  const rootSession = new MissingTargetRootCdpSession();
  const adapter = new DirectCdpBrowserAdapter(
    {
      artifactRootDir: "/tmp/turnkeyai-browser-direct-cdp-expert-target-missing-test",
      transportMode: "direct-cdp",
      directCdp: {
        endpoint: "ws://127.0.0.1:9222/devtools/browser/browser-id",
      },
    },
    {
      connectBrowser: async () => new FakeBrowser(rootSession) as any,
    }
  );

  await assert.rejects(
    adapter.getRawCdpExpertLane().attachExpertTarget({
      browserSessionId: "browser-session-1",
      targetId: "target-gone",
    }),
    /target_not_found: raw CDP target disappeared before attach: target-gone/
  );
});

test("direct-cdp adapter reattaches and retries once after expert session detach", async () => {
  const rootSession = new DetachThenRecoverRootCdpSession();
  const adapter = new DirectCdpBrowserAdapter(
    {
      artifactRootDir: "/tmp/turnkeyai-browser-direct-cdp-expert-reattach-test",
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
  const attached = await expertLane.attachExpertTarget({
    browserSessionId: "browser-session-1",
    targetId: "target-1",
  });
  assert.equal(attached.expertSessionId, "expert-target-1-1");

  const result = await expertLane.sendExpertCommand({
    browserSessionId: "browser-session-1",
    expertSessionId: attached.expertSessionId,
    method: "Runtime.enable",
  });
  assert.equal(result.expertSessionId, "expert-target-1-2");
  assert.deepEqual(result.result, {
    ok: true,
    echoedMethod: "Runtime.enable",
  });
  const rootEvents = await expertLane.drainExpertEvents({
    browserSessionId: "browser-session-1",
  });
  const reattachedEvent = rootEvents.find((event) => event.method === "Target.expertSessionReattached");
  assert.deepEqual(reattachedEvent?.params, {
    browserSessionId: "browser-session-1",
    targetId: "target-1",
    previousExpertSessionId: "expert-target-1-1",
    expertSessionId: "expert-target-1-2",
  });
  assert.equal(rootSession.sent.filter((entry) => entry.method === "Target.attachToTarget").length, 2);
  assert.equal(rootSession.sent.filter((entry) => entry.method === "Target.sendMessageToTarget").length, 2);
});

test("direct-cdp adapter does not retry generic protocol session misses", async () => {
  const rootSession = new GenericSessionNotFoundRootCdpSession();
  const adapter = new DirectCdpBrowserAdapter(
    {
      artifactRootDir: "/tmp/turnkeyai-browser-direct-cdp-expert-generic-session-missing-test",
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
  const attached = await expertLane.attachExpertTarget({
    browserSessionId: "browser-session-1",
    targetId: "target-1",
  });
  await assert.rejects(
    expertLane.sendExpertCommand({
      browserSessionId: "browser-session-1",
      expertSessionId: attached.expertSessionId,
      method: "Runtime.enable",
    }),
    /Protocol error: Session with given id not found/
  );
  assert.equal(rootSession.sent.filter((entry) => entry.method === "Target.attachToTarget").length, 1);
  assert.equal(rootSession.sent.filter((entry) => entry.method === "Target.sendMessageToTarget").length, 1);
});

test("direct-cdp adapter detaches replacement sessions when retry fails", async () => {
  const rootSession = new DetachThenRetryFailureRootCdpSession();
  const adapter = new DirectCdpBrowserAdapter(
    {
      artifactRootDir: "/tmp/turnkeyai-browser-direct-cdp-expert-retry-failure-test",
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
  const attached = await expertLane.attachExpertTarget({
    browserSessionId: "browser-session-1",
    targetId: "target-1",
  });
  await assert.rejects(
    expertLane.sendExpertCommand({
      browserSessionId: "browser-session-1",
      expertSessionId: attached.expertSessionId,
      method: "Runtime.enable",
    }),
    /retry transport failed/
  );

  assert.equal(rootSession.sent.filter((entry) => entry.method === "Target.attachToTarget").length, 2);
  assert.equal(rootSession.sent.filter((entry) => entry.method === "Target.sendMessageToTarget").length, 2);
  assert.equal(
    rootSession.sent.some(
      (entry) => entry.method === "Target.detachFromTarget" && entry.params?.sessionId === "expert-target-1-2"
    ),
    true
  );
  assert.equal(
    (adapter as unknown as { expertAttachedSessions: Map<string, unknown> }).expertAttachedSessions.has("expert-target-1-2"),
    false
  );
});

test("direct-cdp adapter surfaces command timeouts without retrying", async () => {
  const rootSession = new CommandTimeoutRootCdpSession();
  const adapter = new DirectCdpBrowserAdapter(
    {
      artifactRootDir: "/tmp/turnkeyai-browser-direct-cdp-expert-timeout-test",
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
  const attached = await expertLane.attachExpertTarget({
    browserSessionId: "browser-session-1",
    targetId: "target-1",
  });
  await assert.rejects(
    expertLane.sendExpertCommand({
      browserSessionId: "browser-session-1",
      expertSessionId: attached.expertSessionId,
      method: "Runtime.enable",
      timeoutMs: 1,
    }),
    /cdp_command_timeout: expert CDP command timed out: Runtime\.enable/
  );
  assert.equal(rootSession.sent.filter((entry) => entry.method === "Target.sendMessageToTarget").length, 1);
});
