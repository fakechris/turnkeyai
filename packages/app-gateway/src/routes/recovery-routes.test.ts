import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createRouteIdempotencyStore } from "../idempotency-store";
import { handleRecoveryRoutes, type RecoveryRouteDeps } from "./recovery-routes";

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

function createDeps(overrides: Partial<RecoveryRouteDeps> = {}): RecoveryRouteDeps {
  return {
    async buildReplayIncidents(input) {
      return input;
    },
    async buildReplayRecoveries(input) {
      return input;
    },
    async getReplayGroup(threadId: string, groupId: string) {
      return { threadId, groupId };
    },
    async getReplayBundle(threadId: string, groupId: string) {
      return { threadId, groupId };
    },
    async getReplayRecovery(threadId: string, groupId: string) {
      return { threadId, groupId };
    },
    async listRecoveryRuns(threadId: string) {
      return [{ recoveryRunId: "recovery-1", threadId }, { recoveryRunId: "recovery-2", threadId }];
    },
    async getRecoveryRun(threadId: string, recoveryRunId: string) {
      return { threadId, recoveryRunId };
    },
    async getRecoveryTimeline(threadId: string, recoveryRunId: string) {
      return { threadId, recoveryRunId };
    },
    async executeRecoveryRunAction(input) {
      return { statusCode: 200, body: input };
    },
    async dispatchReplayRecovery(input) {
      return { statusCode: 202, body: input };
    },
    async getReplay(replayId: string) {
      return { replayId };
    },
    idempotencyStore: createRouteIdempotencyStore({
      now: () => 100,
    }),
    ...overrides,
  };
}

test("recovery routes reject blank required thread ids", async () => {
  const response = createResponse();
  await handleRecoveryRoutes({
    req: createRequest({ method: "GET", url: "/recovery-runs?threadId=%20" }),
    res: response.res,
    url: new URL("http://127.0.0.1/recovery-runs?threadId=%20"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "threadId is required" });
});

test("recovery routes trim optional replay filters before dispatch", async () => {
  const response = createResponse();
  await handleRecoveryRoutes({
    req: createRequest({
      method: "GET",
      url: "/replay-incidents?threadId=%20thread-1%20&action=%20retry%20&category=%20browser%20&limit=7",
    }),
    res: response.res,
    url: new URL(
      "http://127.0.0.1/replay-incidents?threadId=%20thread-1%20&action=%20retry%20&category=%20browser%20&limit=7"
    ),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 200);
  assert.deepEqual(response.json, {
    threadId: "thread-1",
    action: "retry",
    category: "browser",
    limit: 7,
  });
});

test("recovery routes ignore blank optional replay filters", async () => {
  const response = createResponse();
  await handleRecoveryRoutes({
    req: createRequest({
      method: "GET",
      url: "/replay-recoveries?threadId=%20%20&action=%20%20&limit=5",
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/replay-recoveries?threadId=%20%20&action=%20%20&limit=5"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 200);
  assert.deepEqual(response.json, { limit: 5 });
});

test("recovery routes slice recovery runs when limit is provided", async () => {
  const response = createResponse();
  await handleRecoveryRoutes({
    req: createRequest({ method: "GET", url: "/recovery-runs?threadId=thread-1&limit=1" }),
    res: response.res,
    url: new URL("http://127.0.0.1/recovery-runs?threadId=thread-1&limit=1"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 200);
  assert.deepEqual(response.json, {
    totalRuns: 2,
    runs: [{ recoveryRunId: "recovery-1", threadId: "thread-1" }],
  });
});

test("recovery routes reject blank decoded path ids", async () => {
  const response = createResponse();
  await handleRecoveryRoutes({
    req: createRequest({ method: "POST", url: "/replay-recoveries/%20/dispatch?threadId=thread-1" }),
    res: response.res,
    url: new URL("http://127.0.0.1/replay-recoveries/%20/dispatch?threadId=thread-1"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "groupId is required" });
});

test("recovery routes reject malformed encoded path ids", async () => {
  const response = createResponse();
  await handleRecoveryRoutes({
    req: createRequest({ method: "GET", url: "/recovery-runs/%E0%A4%A?threadId=thread-1" }),
    res: response.res,
    url: new URL("http://127.0.0.1/recovery-runs/%E0%A4%A?threadId=thread-1"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "recoveryRunId is required" });
});

test("recovery routes replay idempotent recovery run actions", async () => {
  let actionCalls = 0;
  const deps = createDeps({
    async executeRecoveryRunAction(input) {
      actionCalls += 1;
      return {
        statusCode: 202,
        body: {
          ...input,
          actionCalls,
        },
      };
    },
  });

  await handleRecoveryRoutes({
    req: createRequest({
      method: "POST",
      url: "/recovery-runs/recovery-1/retry?threadId=thread-1",
      headers: { "idempotency-key": "recover-1" },
    }),
    res: createResponse().res,
    url: new URL("http://127.0.0.1/recovery-runs/recovery-1/retry?threadId=thread-1"),
    deps,
  });

  const replay = createResponse();
  await handleRecoveryRoutes({
    req: createRequest({
      method: "POST",
      url: "/recovery-runs/recovery-1/retry?threadId=thread-1",
      headers: { "idempotency-key": "recover-1" },
    }),
    res: replay.res,
    url: new URL("http://127.0.0.1/recovery-runs/recovery-1/retry?threadId=thread-1"),
    deps,
  });

  assert.equal(actionCalls, 1);
  assert.equal(replay.res.statusCode, 202);
  assert.equal(replay.headers.get("x-turnkeyai-idempotency-status"), "replayed");
  assert.deepEqual(replay.json, {
    threadId: "thread-1",
    recoveryRunId: "recovery-1",
    action: "retry",
    actionCalls: 1,
  });
});

test("recovery routes reject idempotency key reuse across different recovery actions", async () => {
  const deps = createDeps();
  await handleRecoveryRoutes({
    req: createRequest({
      method: "POST",
      url: "/recovery-runs/recovery-1/retry?threadId=thread-1",
      headers: { "idempotency-key": "recover-1" },
    }),
    res: createResponse().res,
    url: new URL("http://127.0.0.1/recovery-runs/recovery-1/retry?threadId=thread-1"),
    deps,
  });

  const conflict = createResponse();
  await handleRecoveryRoutes({
    req: createRequest({
      method: "POST",
      url: "/recovery-runs/recovery-1/fallback?threadId=thread-1",
      headers: { "idempotency-key": "recover-1" },
    }),
    res: conflict.res,
    url: new URL("http://127.0.0.1/recovery-runs/recovery-1/fallback?threadId=thread-1"),
    deps,
  });

  assert.equal(conflict.res.statusCode, 409);
  assert.deepEqual(conflict.json, {
    error: "idempotency key reuse does not match the original request",
  });
});

test("recovery routes replay idempotent replay dispatch requests", async () => {
  let dispatchCalls = 0;
  const deps = createDeps({
    async dispatchReplayRecovery(input) {
      dispatchCalls += 1;
      return {
        statusCode: 202,
        body: {
          ...input,
          dispatchCalls,
        },
      };
    },
  });

  await handleRecoveryRoutes({
    req: createRequest({
      method: "POST",
      url: "/replay-recoveries/group-1/dispatch?threadId=thread-1",
      headers: { "idempotency-key": "dispatch-1" },
    }),
    res: createResponse().res,
    url: new URL("http://127.0.0.1/replay-recoveries/group-1/dispatch?threadId=thread-1"),
    deps,
  });

  const replay = createResponse();
  await handleRecoveryRoutes({
    req: createRequest({
      method: "POST",
      url: "/replay-recoveries/group-1/dispatch?threadId=thread-1",
      headers: { "x-idempotency-key": "dispatch-1" },
    }),
    res: replay.res,
    url: new URL("http://127.0.0.1/replay-recoveries/group-1/dispatch?threadId=thread-1"),
    deps,
  });

  assert.equal(dispatchCalls, 1);
  assert.equal(replay.res.statusCode, 202);
  assert.equal(replay.headers.get("x-turnkeyai-idempotency-status"), "replayed");
  assert.deepEqual(replay.json, {
    threadId: "thread-1",
    groupId: "group-1",
    dispatchCalls: 1,
  });
});

test("recovery routes reject mismatched idempotency headers", async () => {
  const response = createResponse();
  await handleRecoveryRoutes({
    req: createRequest({
      method: "POST",
      url: "/replay-recoveries/group-1/dispatch?threadId=thread-1",
      headers: {
        "idempotency-key": "dispatch-1",
        "x-idempotency-key": "dispatch-2",
      },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/replay-recoveries/group-1/dispatch?threadId=thread-1"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, {
    error: "Idempotency-Key headers must match when both are provided",
  });
});
