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

test("browser routes trim activate target ids and reject invalid evict-idle values", async () => {
  const activate = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-1/activate-target",
      body: { threadId: "thread-1", targetId: " target-1 " },
    }),
    res: activate.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-1/activate-target"),
    deps: createDeps(),
  });
  assert.equal(activate.res.statusCode, 200);
  assert.deepEqual(activate.json, {
    browserSessionId: "session-1",
    targetId: "target-1",
  });

  const invalidEvict = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/evict-idle",
      body: { idleMs: 0 },
    }),
    res: invalidEvict.res,
    url: new URL("http://127.0.0.1/browser-sessions/evict-idle"),
    deps: createDeps(),
  });
  assert.equal(invalidEvict.res.statusCode, 400);
  assert.deepEqual(invalidEvict.json, { error: "idleMs must be a positive number" });
});

test("browser routes return 400 for malformed JSON bodies", async () => {
  const response = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/spawn",
      body: "{",
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "Invalid JSON" });
});

test("browser spawn routes reject unsupported owner/profile types and invalid lease ttl", async () => {
  const invalidOwner = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/spawn",
      body: {
        threadId: "thread-1",
        ownerType: "worker",
      },
    }),
    res: invalidOwner.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: createDeps(),
  });
  assert.equal(invalidOwner.res.statusCode, 400);
  assert.deepEqual(invalidOwner.json, { error: "unsupported browser ownerType: worker" });

  const invalidProfile = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/spawn",
      body: {
        threadId: "thread-1",
        profileOwnerType: "user",
        profileOwnerId: "user-1",
      },
    }),
    res: invalidProfile.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: createDeps(),
  });
  assert.equal(invalidProfile.res.statusCode, 400);
  assert.deepEqual(invalidProfile.json, { error: "unsupported browser profileOwnerType: user" });

  const invalidLease = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/spawn",
      body: {
        threadId: "thread-1",
        leaseTtlMs: 1.5,
      },
    }),
    res: invalidLease.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: createDeps(),
  });
  assert.equal(invalidLease.res.statusCode, 400);
  assert.deepEqual(invalidLease.json, { error: "leaseTtlMs must be a positive integer" });
});

test("browser task mutation routes reject invalid actions and target combinations", async () => {
  const invalidActions = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/spawn",
      body: {
        threadId: "thread-1",
        actions: [{ kind: "click", selectors: ["button"], text: "Open" }],
      },
    }),
    res: invalidActions.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: createDeps(),
  });
  assert.equal(invalidActions.res.statusCode, 400);
  assert.deepEqual(invalidActions.json, {
    error: "actions[0] click requires exactly one of selectors, refId, or text",
  });

  const spawnTarget = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/spawn",
      body: {
        threadId: "thread-1",
        targetId: "target-1",
      },
    }),
    res: spawnTarget.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: createDeps(),
  });
  assert.equal(spawnTarget.res.statusCode, 400);
  assert.deepEqual(spawnTarget.json, {
    error: "targetId is not accepted when spawning a browser session",
  });

  const targetOpenConflict = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-1/send",
      body: {
        threadId: "thread-1",
        targetId: "target-1",
        actions: [{ kind: "open", url: "https://example.com" }],
      },
    }),
    res: targetOpenConflict.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-1/send"),
    deps: createDeps(),
  });
  assert.equal(targetOpenConflict.res.statusCode, 400);
  assert.deepEqual(targetOpenConflict.json, {
    error: "targetId cannot be combined with open actions",
  });
});

test("browser task mutation routes reject explicit actions mixed with url or foreign profile owner", async () => {
  const mixedUrl = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-1/resume",
      body: {
        threadId: "thread-1",
        url: "https://example.com",
        actions: [{ kind: "snapshot", note: "inspect" }],
      },
    }),
    res: mixedUrl.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-1/resume"),
    deps: createDeps(),
  });
  assert.equal(mixedUrl.res.statusCode, 400);
  assert.deepEqual(mixedUrl.json, {
    error: "url cannot be combined with explicit actions",
  });

  const wrongProfile = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/spawn",
      body: {
        threadId: "thread-1",
        profileOwnerType: "role",
        profileOwnerId: "role-2",
      },
    }),
    res: wrongProfile.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: createDeps(),
  });
  assert.equal(wrongProfile.res.statusCode, 400);
  assert.deepEqual(wrongProfile.json, {
    error: "profile owner must match the resolved browser owner",
  });
});
