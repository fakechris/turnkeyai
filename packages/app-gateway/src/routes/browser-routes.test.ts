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
      async closeSession() {},
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

test("browser spawn routes reject unsupported owner/profile types and route-managed lease claims", async () => {
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
        leaseTtlMs: 30_000,
      },
    }),
    res: invalidLease.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: createDeps(),
  });
  assert.equal(invalidLease.res.statusCode, 400);
  assert.deepEqual(invalidLease.json, {
    error: "leaseHolderRunKey and leaseTtlMs are managed by browser session runtime and are not accepted by browser routes",
  });
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

test("browser task mutation routes validate cdp action contracts", async () => {
  const invalidMethod = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/spawn",
      body: {
        threadId: "thread-1",
        actions: [{ kind: "cdp", method: "Runtime" }],
      },
    }),
    res: invalidMethod.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: createDeps(),
  });
  assert.equal(invalidMethod.res.statusCode, 400);
  assert.deepEqual(invalidMethod.json, {
    error: "actions[0] cdp.method must be a valid CDP Domain.method string",
  });

  const blockedMethod = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/spawn",
      body: {
        threadId: "thread-1",
        actions: [{ kind: "cdp", method: "Target.closeTarget", params: { targetId: "target-1" } }],
      },
    }),
    res: blockedMethod.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: createDeps(),
  });
  assert.equal(blockedMethod.res.statusCode, 400);
  assert.deepEqual(blockedMethod.json, {
    error: "actions[0] cdp.method is not allowed on browser task routes",
  });

  const invalidParams = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/spawn",
      body: {
        threadId: "thread-1",
        actions: [{ kind: "cdp", method: "Runtime.evaluate", params: [] }],
      },
    }),
    res: invalidParams.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: createDeps(),
  });
  assert.equal(invalidParams.res.statusCode, 400);
  assert.deepEqual(invalidParams.json, {
    error: "actions[0] cdp.params must be an object when provided",
  });

  const invalidTimeout = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/spawn",
      body: {
        threadId: "thread-1",
        actions: [{ kind: "cdp", method: "Runtime.evaluate", timeoutMs: 30_001 }],
      },
    }),
    res: invalidTimeout.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: createDeps(),
  });
  assert.equal(invalidTimeout.res.statusCode, 400);
  assert.deepEqual(invalidTimeout.json, {
    error: "actions[0] cdp.timeoutMs must be a positive integer <= 30000",
  });

  let capturedActions: unknown;
  const validDeps = createDeps();
  validDeps.buildBrowserTaskRequest = ({ body, owner }) =>
    ({
      threadId: "thread-1",
      taskId: "task-1",
      instructions: "inspect",
      actions: body.actions,
      ...owner,
    }) as any;
  validDeps.browserBridge.spawnSession = async (input) => {
    capturedActions = input.actions;
    return {
      status: "completed",
      browserSessionId: "session-1",
      taskId: input.taskId,
      page: null,
      trace: [],
    } as any;
  };
  const valid = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/spawn",
      body: {
        threadId: "thread-1",
        actions: [
          {
            kind: "cdp",
            method: "Runtime.evaluate",
            params: { expression: "document.title", returnByValue: true },
            timeoutMs: 1_000,
          },
        ],
      },
    }),
    res: valid.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: validDeps,
  });
  assert.equal(valid.res.statusCode, 201);
  assert.deepEqual(capturedActions, [
    {
      kind: "cdp",
      method: "Runtime.evaluate",
      params: { expression: "document.title", returnByValue: true },
      timeoutMs: 1_000,
    },
  ]);
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

test("browser existing-session routes reject profile ownership overrides and blank task metadata", async () => {
  const profileOverride = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-1/send",
      body: {
        threadId: "thread-1",
        profileOwnerType: "thread",
        profileOwnerId: "thread-1",
      },
    }),
    res: profileOverride.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-1/send"),
    deps: createDeps(),
  });
  assert.equal(profileOverride.res.statusCode, 400);
  assert.deepEqual(profileOverride.json, {
    error: "profileOwnerType and profileOwnerId are not accepted for existing browser sessions",
  });

  const blankTaskId = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/spawn",
      body: {
        threadId: "thread-1",
        taskId: "   ",
      },
    }),
    res: blankTaskId.res,
    url: new URL("http://127.0.0.1/browser-sessions/spawn"),
    deps: createDeps(),
  });
  assert.equal(blankTaskId.res.statusCode, 400);
  assert.deepEqual(blankTaskId.json, {
    error: "taskId must be a non-empty string when provided",
  });
});

test("browser session revoke route closes the session with a default reason", async () => {
  let closed: { browserSessionId: string; reason: string | undefined } | null = null;
  const response = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-1/revoke",
      body: { threadId: "thread-1" },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-1/revoke"),
    deps: createDeps({
      browserBridge: {
        ...createDeps().browserBridge,
        async closeSession(browserSessionId: string, reason?: string) {
          closed = { browserSessionId, reason };
        },
      },
    }),
  });

  assert.equal(response.res.statusCode, 200);
  assert.deepEqual(response.json, {
    browserSessionId: "session-1",
    status: "closed",
    reason: "operator revoked browser session",
  });
  assert.deepEqual(closed, {
    browserSessionId: "session-1",
    reason: "operator revoked browser session",
  });
});

test("browser session revoke route rejects blank reasons and trims explicit reasons", async () => {
  const invalid = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-1/revoke",
      body: { threadId: "thread-1", reason: "   " },
    }),
    res: invalid.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-1/revoke"),
    deps: createDeps(),
  });
  assert.equal(invalid.res.statusCode, 400);
  assert.deepEqual(invalid.json, {
    error: "reason must be a non-empty string when provided",
  });

  let closed: { browserSessionId: string; reason: string | undefined } | null = null;
  const trimmed = createResponse();
  await handleBrowserRoutes({
    req: createRequest({
      method: "POST",
      url: "/browser-sessions/session-1/revoke",
      body: { threadId: "thread-1", reason: " operator handoff " },
    }),
    res: trimmed.res,
    url: new URL("http://127.0.0.1/browser-sessions/session-1/revoke"),
    deps: createDeps({
      browserBridge: {
        ...createDeps().browserBridge,
        async closeSession(browserSessionId: string, reason?: string) {
          closed = { browserSessionId, reason };
        },
      },
    }),
  });
  assert.equal(trimmed.res.statusCode, 200);
  assert.deepEqual(trimmed.json, {
    browserSessionId: "session-1",
    status: "closed",
    reason: "operator handoff",
  });
  assert.deepEqual(closed, {
    browserSessionId: "session-1",
    reason: "operator handoff",
  });
});
