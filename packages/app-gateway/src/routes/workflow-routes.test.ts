import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createRouteIdempotencyStore } from "../idempotency-store";
import { handleWorkflowRoutes, type WorkflowRouteDeps } from "./workflow-routes";

function createRequest(input: { method: string; url: string; body?: unknown; headers?: Record<string, string> }) {
  const body =
    input.body === undefined ? [] : [Buffer.from(typeof input.body === "string" ? input.body : JSON.stringify(input.body))];
  return Object.assign(Readable.from(body), {
    method: input.method,
    url: input.url,
    headers: input.headers ?? {},
  }) as any;
}

function createResponse() {
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
  } as any;
  return {
    res,
    headers,
    get json() {
      return payload ? JSON.parse(payload) : undefined;
    },
  };
}

function createDeps(overrides: Partial<WorkflowRouteDeps> = {}): WorkflowRouteDeps {
  return {
    coordinationEngine: {
      async handleUserPost() {},
    },
    teamEventBus: {
      async publish() {},
    },
    scheduledTaskRuntime: {
      async listByThread(threadId: string) {
        return [{ threadId }];
      },
      async schedule(input) {
        return input;
      },
      async triggerDue(now?: number) {
        return { now };
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
      now: () => 123,
    },
    idempotencyStore: createRouteIdempotencyStore({
      now: () => 123,
    }),
    ...overrides,
  };
}

test("workflow routes reject blank message content", async () => {
  const response = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/messages",
      body: { threadId: "thread-1", content: "   " },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/messages"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "content is required" });
});

test("workflow routes reject oversized message content", async () => {
  const response = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/messages",
      body: { threadId: "thread-1", content: "x".repeat(20_001) },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/messages"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "content must be at most 20000 characters" });
});

test("workflow routes return 400 for malformed message JSON", async () => {
  const response = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/messages",
      body: "{",
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/messages"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "Invalid JSON" });
});

test("workflow routes trim message body before publishing", async () => {
  let postedBody: { threadId: string; content: string } | undefined;
  let publishedEvent: unknown;
  const response = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/messages",
      body: { threadId: " thread-1 ", content: " hello world " },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/messages"),
    deps: createDeps({
      coordinationEngine: {
        async handleUserPost(body) {
          postedBody = body;
        },
      },
      teamEventBus: {
        async publish(event) {
          publishedEvent = event;
        },
      },
    }),
  });

  assert.equal(response.res.statusCode, 202);
  assert.deepEqual(postedBody, { threadId: "thread-1", content: "hello world" });
  assert.deepEqual(publishedEvent, {
    eventId: "message-1",
    threadId: "thread-1",
    kind: "message.posted",
    createdAt: 123,
    payload: {
      route: "user",
      contentLength: "hello world".length,
    },
  });
  assert.deepEqual(response.json, { accepted: true, threadId: "thread-1" });
});

test("workflow routes replay idempotent message posts without duplicating side effects", async () => {
  let handled = 0;
  let published = 0;
  const deps = createDeps({
    coordinationEngine: {
      async handleUserPost() {
        handled += 1;
      },
    },
    teamEventBus: {
      async publish() {
        published += 1;
      },
    },
  });

  const first = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/messages",
      headers: { "idempotency-key": "msg-1" },
      body: { threadId: "thread-1", content: "hello world" },
    }),
    res: first.res,
    url: new URL("http://127.0.0.1/messages"),
    deps,
  });

  const second = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/messages",
      headers: { "idempotency-key": "msg-1" },
      body: { threadId: " thread-1 ", content: " hello world " },
    }),
    res: second.res,
    url: new URL("http://127.0.0.1/messages"),
    deps,
  });

  assert.equal(handled, 1);
  assert.equal(published, 1);
  assert.equal(first.res.statusCode, 202);
  assert.equal(second.res.statusCode, 202);
  assert.equal(second.headers.get("x-turnkeyai-idempotency-status"), "replayed");
  assert.deepEqual(second.json, { accepted: true, threadId: "thread-1" });
});

test("workflow routes reject idempotency key reuse with a different message body", async () => {
  let handled = 0;
  const deps = createDeps({
    coordinationEngine: {
      async handleUserPost() {
        handled += 1;
      },
    },
  });

  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/messages",
      headers: { "idempotency-key": "msg-1" },
      body: { threadId: "thread-1", content: "hello world" },
    }),
    res: createResponse().res,
    url: new URL("http://127.0.0.1/messages"),
    deps,
  });

  const conflict = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/messages",
      headers: { "idempotency-key": "msg-1" },
      body: { threadId: "thread-1", content: "different body" },
    }),
    res: conflict.res,
    url: new URL("http://127.0.0.1/messages"),
    deps,
  });

  assert.equal(handled, 1);
  assert.equal(conflict.res.statusCode, 409);
  assert.deepEqual(conflict.json, {
    error: "idempotency key reuse does not match the original request",
  });
});

test("workflow routes reject blank scheduled task fields", async () => {
  const response = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/scheduled-tasks",
      body: {
        threadId: "thread-1",
        targetRoleId: "lead",
        capsule: {
          title: "Title",
          instructions: "Instructions",
        },
        schedule: {
          kind: "cron",
          expr: "0 * * * *",
          tz: "   ",
        },
      },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/scheduled-tasks"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "schedule.tz is required" });
});

test("workflow routes trim scheduled task fields before scheduling", async () => {
  let scheduledInput: unknown;
  const response = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/scheduled-tasks",
      body: {
        threadId: " thread-1 ",
        targetRoleId: " lead ",
        capsule: {
          title: " Ship report ",
          instructions: " Verify metrics ",
        },
        schedule: {
          kind: "cron",
          expr: " 0 * * * * ",
          tz: " Asia/Shanghai ",
        },
      },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/scheduled-tasks"),
    deps: createDeps({
      scheduledTaskRuntime: {
        async listByThread(threadId: string) {
          return [{ threadId }];
        },
        async schedule(input) {
          scheduledInput = input;
          return input;
        },
        async triggerDue(now?: number) {
          return { now };
        },
      },
    }),
  });

  assert.equal(response.res.statusCode, 201);
  assert.deepEqual(scheduledInput, {
    threadId: "thread-1",
    targetRoleId: "lead",
    capsule: {
      title: "Ship report",
      instructions: "Verify metrics",
    },
    schedule: {
      kind: "cron",
      expr: "0 * * * *",
      tz: "Asia/Shanghai",
    },
  });
});

test("workflow routes replay idempotent scheduled task creation without rescheduling", async () => {
  let scheduleCalls = 0;
  const deps = createDeps({
    scheduledTaskRuntime: {
      async listByThread(threadId: string) {
        return [{ threadId }];
      },
      async schedule(input) {
        scheduleCalls += 1;
        return { taskId: "task-1", ...input };
      },
      async triggerDue(now?: number) {
        return { now };
      },
    },
  });

  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/scheduled-tasks",
      headers: { "idempotency-key": "task-1" },
      body: {
        threadId: "thread-1",
        targetRoleId: "lead",
        capsule: {
          title: "Ship report",
          instructions: "Verify metrics",
        },
        schedule: {
          kind: "cron",
          expr: "0 * * * *",
          tz: "UTC",
        },
      },
    }),
    res: createResponse().res,
    url: new URL("http://127.0.0.1/scheduled-tasks"),
    deps,
  });

  const replay = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/scheduled-tasks",
      headers: { "idempotency-key": "task-1" },
      body: {
        threadId: "thread-1",
        targetRoleId: "lead",
        capsule: {
          title: " Ship report ",
          instructions: " Verify metrics ",
        },
        schedule: {
          kind: "cron",
          expr: " 0 * * * * ",
          tz: " UTC ",
        },
      },
    }),
    res: replay.res,
    url: new URL("http://127.0.0.1/scheduled-tasks"),
    deps,
  });

  assert.equal(scheduleCalls, 1);
  assert.equal(replay.res.statusCode, 201);
  assert.equal(replay.headers.get("x-turnkeyai-idempotency-status"), "replayed");
  assert.deepEqual(replay.json, {
    taskId: "task-1",
    threadId: "thread-1",
    targetRoleId: "lead",
    capsule: {
      title: "Ship report",
      instructions: "Verify metrics",
    },
    schedule: {
      kind: "cron",
      expr: "0 * * * *",
      tz: "UTC",
    },
  });
});

test("workflow routes reject invalid scheduled task enums and ref arrays", async () => {
  const response = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/scheduled-tasks",
      body: {
        threadId: "thread-1",
        targetRoleId: "lead",
        capsule: {
          title: "Ship report",
          instructions: "Verify metrics",
          artifactRefs: ["valid", "   "],
        },
        schedule: {
          kind: "once",
          expr: "0 * * * *",
          tz: "Asia/Shanghai",
        },
        sessionTarget: "sidecar",
        targetWorker: "invalid-worker",
      },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/scheduled-tasks"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "schedule.kind must be cron" });
});

test("workflow routes reject malformed scheduled task refs after enum validation passes", async () => {
  const response = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/scheduled-tasks",
      body: {
        threadId: "thread-1",
        targetRoleId: "lead",
        capsule: {
          title: "Ship report",
          instructions: "Verify metrics",
          artifactRefs: ["valid", "   "],
        },
        schedule: {
          kind: "cron",
          expr: "0 * * * *",
          tz: "Asia/Shanghai",
        },
        sessionTarget: "main",
        targetWorker: "browser",
      },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/scheduled-tasks"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "capsule.artifactRefs must be an array of non-empty strings" });
});

test("workflow routes return 400 for malformed scheduled task JSON", async () => {
  const response = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/scheduled-tasks",
      body: "{",
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/scheduled-tasks"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "Invalid JSON" });
});

test("workflow routes return 400 for malformed trigger-due JSON", async () => {
  const response = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/scheduled-tasks/trigger-due",
      body: "{",
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/scheduled-tasks/trigger-due"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "Invalid JSON" });
});

test("workflow routes reject invalid trigger-due now values", async () => {
  const response = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/scheduled-tasks/trigger-due",
      body: { now: -1 },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/scheduled-tasks/trigger-due"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "now must be a non-negative finite number" });
});

test("workflow routes replay idempotent trigger-due requests", async () => {
  let triggerCalls = 0;
  const deps = createDeps({
    scheduledTaskRuntime: {
      async listByThread(threadId: string) {
        return [{ threadId }];
      },
      async schedule(input) {
        return input;
      },
      async triggerDue(now?: number) {
        triggerCalls += 1;
        return { now, triggerCalls };
      },
    },
  });

  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/scheduled-tasks/trigger-due",
      headers: { "idempotency-key": "trigger-1" },
      body: { now: 99 },
    }),
    res: createResponse().res,
    url: new URL("http://127.0.0.1/scheduled-tasks/trigger-due"),
    deps,
  });

  const replay = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/scheduled-tasks/trigger-due",
      headers: { "idempotency-key": "trigger-1" },
      body: { now: 99 },
    }),
    res: replay.res,
    url: new URL("http://127.0.0.1/scheduled-tasks/trigger-due"),
    deps,
  });

  assert.equal(triggerCalls, 1);
  assert.equal(replay.res.statusCode, 200);
  assert.equal(replay.headers.get("x-turnkeyai-idempotency-status"), "replayed");
  assert.deepEqual(replay.json, { now: 99, triggerCalls: 1 });
});

test("workflow routes reject invalid idempotency headers", async () => {
  const response = createResponse();
  await handleWorkflowRoutes({
    req: createRequest({
      method: "POST",
      url: "/messages",
      headers: { "idempotency-key": "   " },
      body: { threadId: "thread-1", content: "hello world" },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/messages"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "Idempotency-Key must be a single non-empty string" });
});
