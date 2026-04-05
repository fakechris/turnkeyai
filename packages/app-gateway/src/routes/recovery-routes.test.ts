import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { handleRecoveryRoutes, type RecoveryRouteDeps } from "./recovery-routes";

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
