import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { handleRelayRoutes } from "./relay-routes";

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

function createRelayGateway() {
  return {
    listPeers() {
      return [];
    },
    registerPeer(input: unknown) {
      return input;
    },
    heartbeatPeer(peerId: string) {
      return { peerId };
    },
    reportTargets(peerId: string, targets: unknown[]) {
      return { peerId, targets };
    },
    listTargets(input?: { peerId: string }) {
      return [input ?? null];
    },
    pullNextActionRequest(peerId: string) {
      return { peerId };
    },
    submitActionResult(input: unknown) {
      return input;
    },
  } as any;
}

test("relay routes reject missing peer ids and required action fields", async () => {
  const register = createResponse();
  await handleRelayRoutes({
    req: createRequest({
      method: "POST",
      url: "/relay/peers/register",
      body: { peerId: "   " },
    }),
    res: register.res,
    url: new URL("http://127.0.0.1/relay/peers/register"),
    relayGateway: createRelayGateway(),
  });
  assert.equal(register.res.statusCode, 400);
  assert.deepEqual(register.json, { error: "peerId is required" });

  const action = createResponse();
  await handleRelayRoutes({
    req: createRequest({
      method: "POST",
      url: "/relay/peers/peer-1/action-results",
      body: {
        actionRequestId: " ",
        browserSessionId: "session-1",
        taskId: "task-1",
        relayTargetId: "target-1",
        url: "https://example.com",
        status: "completed",
      },
    }),
    res: action.res,
    url: new URL("http://127.0.0.1/relay/peers/peer-1/action-results"),
    relayGateway: createRelayGateway(),
  });
  assert.equal(action.res.statusCode, 400);
  assert.deepEqual(action.json, {
    error: "actionRequestId, browserSessionId, taskId, and relayTargetId are required",
  });
});

test("relay routes trim optional peer ids and action result fields", async () => {
  const targets = createResponse();
  await handleRelayRoutes({
    req: createRequest({
      method: "GET",
      url: "/relay/targets?peerId=%20peer-1%20",
    }),
    res: targets.res,
    url: new URL("http://127.0.0.1/relay/targets?peerId=%20peer-1%20"),
    relayGateway: createRelayGateway(),
  });
  assert.equal(targets.res.statusCode, 200);
  assert.deepEqual(targets.json, [{ peerId: "peer-1" }]);

  const submit = createResponse();
  await handleRelayRoutes({
    req: createRequest({
      method: "POST",
      url: "/relay/peers/peer-1/action-results",
      body: {
        actionRequestId: " request-1 ",
        browserSessionId: " session-1 ",
        taskId: " task-1 ",
        relayTargetId: " target-1 ",
        url: " https://example.com ",
        title: " Example ",
        status: "completed",
      },
    }),
    res: submit.res,
    url: new URL("http://127.0.0.1/relay/peers/peer-1/action-results"),
    relayGateway: createRelayGateway(),
  });
  assert.equal(submit.res.statusCode, 200);
  assert.deepEqual(submit.json, {
    actionRequestId: "request-1",
    peerId: "peer-1",
    browserSessionId: "session-1",
    taskId: "task-1",
    relayTargetId: "target-1",
    url: "https://example.com",
    title: "Example",
    status: "completed",
    trace: [],
    screenshotPaths: [],
    screenshotPayloads: [],
    artifactIds: [],
  });
});

test("relay routes reject malformed target reports and trim nested action result fields", async () => {
  const badTargets = createResponse();
  await handleRelayRoutes({
    req: createRequest({
      method: "POST",
      url: "/relay/peers/peer-1/targets/report",
      body: {
        targets: [{ relayTargetId: "   ", url: "https://example.com" }],
      },
    }),
    res: badTargets.res,
    url: new URL("http://127.0.0.1/relay/peers/peer-1/targets/report"),
    relayGateway: createRelayGateway(),
  });
  assert.equal(badTargets.res.statusCode, 400);
  assert.deepEqual(badTargets.json, {
    error: "each target must include a non-empty relayTargetId",
  });

  const submit = createResponse();
  await handleRelayRoutes({
    req: createRequest({
      method: "POST",
      url: "/relay/peers/peer-1/action-results",
      body: {
        actionRequestId: " request-2 ",
        browserSessionId: " session-2 ",
        taskId: " task-2 ",
        relayTargetId: " target-2 ",
        url: " https://example.com/next ",
        title: " Follow-up ",
        status: "failed",
        screenshotPaths: [" shot-1.png ", " "],
        artifactIds: [" artifact-1 ", " "],
        screenshotPayloads: [{ label: " before ", mimeType: " image/png ", dataBase64: "abc123" }],
        errorMessage: " timed out ",
      },
    }),
    res: submit.res,
    url: new URL("http://127.0.0.1/relay/peers/peer-1/action-results"),
    relayGateway: createRelayGateway(),
  });
  assert.equal(submit.res.statusCode, 200);
  assert.deepEqual(submit.json, {
    actionRequestId: "request-2",
    peerId: "peer-1",
    browserSessionId: "session-2",
    taskId: "task-2",
    relayTargetId: "target-2",
    url: "https://example.com/next",
    title: "Follow-up",
    status: "failed",
    trace: [],
    screenshotPaths: ["shot-1.png"],
    screenshotPayloads: [{ label: "before", mimeType: "image/png", dataBase64: "abc123" }],
    artifactIds: ["artifact-1"],
    errorMessage: "timed out",
  });
});

test("relay routes return 400 for malformed JSON bodies", async () => {
  const response = createResponse();
  await handleRelayRoutes({
    req: createRequest({
      method: "POST",
      url: "/relay/peers/register",
      body: "{",
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/relay/peers/register"),
    relayGateway: createRelayGateway(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "Invalid JSON" });
});
