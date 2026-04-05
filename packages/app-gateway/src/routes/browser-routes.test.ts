import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

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

function createDeps(overrides: Partial<BrowserRouteDeps> = {}): BrowserRouteDeps {
  return {
    browserBridge: {
      async spawnSession(input) {
        return { status: "completed", browserSessionId: "session-1", taskId: input.taskId, page: null, trace: [] } as any;
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
      async openTarget(browserSessionId: string, url: string) {
        return { browserSessionId, url };
      },
      async sendSession(input) {
        return { status: "completed", browserSessionId: input.browserSessionId, taskId: input.taskId, page: null, trace: [] } as any;
      },
      async resumeSession(input) {
        return { status: "completed", browserSessionId: input.browserSessionId, taskId: input.taskId, page: null, trace: [] } as any;
      },
      async activateTarget(browserSessionId: string, targetId: string) {
        return { browserSessionId, targetId };
      },
      async closeTarget(browserSessionId: string, targetId: string) {
        return { browserSessionId, targetId };
      },
      async evictIdleSessions(input) {
        return input;
      },
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
    buildBrowserTaskRequest({ browserSessionId, owner }) {
      return {
        threadId: "thread-1",
        taskId: "task-1",
        instructions: "inspect",
        actions: [],
        ...(browserSessionId ? { browserSessionId } : {}),
        ...owner,
      } as any;
    },
    ...overrides,
  };
}

test("browser routes reject blank open target urls", async () => {
  const response = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-1/targets",
      body: { threadId: "thread-1", url: "   " },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-1/targets"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "url is required" });
});

test("browser routes trim target urls before opening", async () => {
  const response = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-1/targets",
      body: { threadId: "thread-1", url: " https://example.com " },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-1/targets"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 201);
  assert.deepEqual(response.json, {
    browserSessionId: "session-1",
    url: "https://example.com",
  });
});

test("browser routes reject blank activate and close target ids", async () => {
  const activate = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-1/activate-target",
      body: { threadId: "thread-1", targetId: "   " },
    }),
    res: activate.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-1/activate-target"),
    deps: createDeps(),
  });
  assert.equal(activate.res.statusCode, 400);
  assert.deepEqual(activate.json, { error: "targetId is required" });

  const close = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-1/close-target",
      body: { threadId: "thread-1", targetId: "   " },
    }),
    res: close.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-1/close-target"),
    deps: createDeps(),
  });
  assert.equal(close.res.statusCode, 400);
  assert.deepEqual(close.json, { error: "targetId is required" });
});
