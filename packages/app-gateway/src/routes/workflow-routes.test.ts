import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { handleWorkflowRoutes, type WorkflowRouteDeps } from "./workflow-routes";

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
