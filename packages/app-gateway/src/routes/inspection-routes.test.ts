import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { handleInspectionRoutes, type InspectionRouteDeps } from "./inspection-routes";

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
    get json() {
      return payload ? JSON.parse(payload) : undefined;
    },
    headers,
  };
}

function createDeps(overrides: Partial<InspectionRouteDeps> = {}): InspectionRouteDeps {
  return {
    async listThreads() {
      return [];
    },
    async listRecentEvents() {
      return [];
    },
    async resolveExternalRoute(channelId: string, userId: string) {
      return { channelId, userId };
    },
    async listMessages(threadId: string) {
      return [{ threadId }];
    },
    async listFlows(threadId: string, limit: number) {
      return [{ threadId, limit }];
    },
    async buildFlowSummary(threadId: string) {
      return { threadId };
    },
    async listRuntimeChainsByThread(threadId: string, limit: number) {
      return [{ threadId, limit }];
    },
    async listActiveRuntimeChains(limit: number, threadId: string | null) {
      return [{ limit, threadId }];
    },
    async loadRuntimeSummary(threadId: string | null, limit: number) {
      return { attentionChains: [], threadId, limit };
    },
    async listRuntimeChainsByCanonicalState(state: "waiting" | "failed", limit: number, threadId: string | null) {
      return [{ state, limit, threadId }];
    },
    async listWorkerSessions(limit: number, threadId: string | null) {
      return [{ limit, threadId }];
    },
    async listStaleRuntimeChains(limit: number, threadId: string | null) {
      return [{ limit, threadId }];
    },
    async listRuntimeProgressByThread(threadId: string, limit: number) {
      return [{ threadId, limit }];
    },
    async loadRuntimeChainDetail() {
      return { events: [] };
    },
    async listRuntimeProgressByChain(chainId: string, limit: number) {
      return [{ chainId, limit }];
    },
    async listRoleRuns(threadId: string) {
      return [{ threadId }];
    },
    async getSessionMemory(threadId: string) {
      return { threadId };
    },
    async listModels() {
      return [];
    },
    async inspectCapabilities(threadId: string, roleId: string, requestedCapabilities: string[]) {
      return { threadId, roleId, requestedCapabilities };
    },
    async listGovernancePermissions(threadId: string) {
      return [{ threadId }];
    },
    async buildGovernanceSummary(threadId: string, limit: number) {
      return { threadId, limit };
    },
    async buildRecoverySummary(threadId: string, limit: number) {
      return { threadId, limit };
    },
    async buildPromptConsole(threadId: string, limit: number) {
      return { threadId, limit };
    },
    async buildOperatorSummary(threadId: string, limit: number) {
      return { threadId, limit };
    },
    async buildOperatorAttention(threadId: string, limit: number) {
      return { threadId, limit };
    },
    async buildOperatorTriage(threadId: string, limit: number) {
      return { threadId, limit };
    },
    async listGovernanceAudits(threadId: string | undefined, limit: number) {
      return [{ threadId, limit }];
    },
    async listGovernanceWorkerAudits(threadId: string | undefined, limit: number) {
      return [{ threadId, limit }];
    },
    async listReplays(input: { threadId?: string; layer?: string; limit: number }) {
      return [input];
    },
    async buildReplaySummary(threadId: string | undefined, limit: number) {
      return { threadId, limit };
    },
    async buildReplayConsole(threadId: string | undefined, limit: number) {
      return { threadId, limit };
    },
    ...overrides,
  };
}

test("inspection routes reject blank required thread ids", async () => {
  const response = createResponse();
  const handled = await handleInspectionRoutes({
    req: createRequest({ method: "GET", url: "/messages?threadId=%20%20" }),
    res: response.res,
    url: new URL("http://127.0.0.1/messages?threadId=%20%20"),
    deps: createDeps(),
  });

  assert.equal(handled, true);
  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "threadId is required" });
});

test("inspection routes trim optional thread ids for runtime summary routes", async () => {
  let receivedThreadId: string | null | undefined;
  const response = createResponse();
  await handleInspectionRoutes({
    req: createRequest({ method: "GET", url: "/runtime-worker-sessions?threadId=%20%20&limit=7" }),
    res: response.res,
    url: new URL("http://127.0.0.1/runtime-worker-sessions?threadId=%20%20&limit=7"),
    deps: createDeps({
      async listWorkerSessions(limit, threadId) {
        receivedThreadId = threadId;
        return [{ limit, threadId }];
      },
    }),
  });

  assert.equal(receivedThreadId, null);
  assert.equal(response.res.statusCode, 200);
  assert.deepEqual(response.json, [{ limit: 7, threadId: null }]);
});

test("inspection routes reject blank route resolution participants", async () => {
  const response = createResponse();
  await handleInspectionRoutes({
    req: createRequest({ method: "GET", url: "/routes/resolve?channelId=%20&userId=user-1" }),
    res: response.res,
    url: new URL("http://127.0.0.1/routes/resolve?channelId=%20&userId=user-1"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "channelId and userId are required" });
});

test("inspection routes trim capability inputs before dispatch", async () => {
  const response = createResponse();
  await handleInspectionRoutes({
    req: createRequest({
      method: "GET",
      url: "/capabilities?threadId=%20thread-1%20&roleId=%20lead%20&requestedCapabilities=%20browser%20,%20api%20",
    }),
    res: response.res,
    url: new URL(
      "http://127.0.0.1/capabilities?threadId=%20thread-1%20&roleId=%20lead%20&requestedCapabilities=%20browser%20,%20api%20"
    ),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 200);
  assert.deepEqual(response.json, {
    threadId: "thread-1",
    roleId: "lead",
    requestedCapabilities: ["browser", "api"],
  });
});

test("inspection routes preserve runtime truth and remediation fields", async () => {
  const response = createResponse();
  await handleInspectionRoutes({
    req: createRequest({ method: "GET", url: "/runtime-summary?threadId=%20thread-1%20&limit=5" }),
    res: response.res,
    url: new URL("http://127.0.0.1/runtime-summary?threadId=%20thread-1%20&limit=5"),
    deps: createDeps({
      async loadRuntimeSummary(threadId, limit) {
        return {
          threadId,
          limit,
          attentionChains: [
            {
              chainId: "flow:thread-1",
              truthState: "stale",
              truthSource: "reconciliation",
              remediation: [{ action: "inspect_runtime_chain", scope: "runtime_summary" }],
            },
          ],
        };
      },
    }),
  });

  assert.equal(response.res.statusCode, 200);
  assert.equal(response.json.threadId, "thread-1");
  assert.equal(response.json.attentionChains[0]?.truthState, "stale");
  assert.equal(response.json.attentionChains[0]?.truthSource, "reconciliation");
  assert.deepEqual(response.json.attentionChains[0]?.remediation, [
    { action: "inspect_runtime_chain", scope: "runtime_summary" },
  ]);
});

test("inspection routes preserve replay and operator remediation surfaces", async () => {
  const replay = createResponse();
  await handleInspectionRoutes({
    req: createRequest({ method: "GET", url: "/replay-console?threadId=%20%20&limit=4" }),
    res: replay.res,
    url: new URL("http://127.0.0.1/replay-console?threadId=%20%20&limit=4"),
    deps: createDeps({
      async buildReplayConsole(threadId, limit) {
        return {
          threadId,
          limit,
          latestBundles: [
            {
              bundleId: "bundle-1",
              truthState: "inferred",
              remediation: [{ action: "inspect", scope: "replay_bundle" }],
            },
          ],
        };
      },
    }),
  });
  assert.equal(replay.res.statusCode, 200);
  assert.equal(replay.json.threadId, undefined);
  assert.equal(replay.json.latestBundles[0]?.truthState, "inferred");
  assert.deepEqual(replay.json.latestBundles[0]?.remediation, [{ action: "inspect", scope: "replay_bundle" }]);

  const operator = createResponse();
  await handleInspectionRoutes({
    req: createRequest({ method: "GET", url: "/operator-attention?threadId=thread-1&limit=3" }),
    res: operator.res,
    url: new URL("http://127.0.0.1/operator-attention?threadId=thread-1&limit=3"),
    deps: createDeps({
      async buildOperatorAttention(threadId, limit) {
        return {
          threadId,
          limit,
          items: [
            {
              caseId: "case-1",
              truthState: "stale",
              remediation: [{ action: "resume", scope: "operator_attention" }],
            },
          ],
        };
      },
    }),
  });
  assert.equal(operator.res.statusCode, 200);
  assert.equal(operator.json.items[0]?.truthState, "stale");
  assert.deepEqual(operator.json.items[0]?.remediation, [{ action: "resume", scope: "operator_attention" }]);
});
