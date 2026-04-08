import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createRelayPeerIdentityBindingStore } from "../daemon-auth";
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

function createAuthorization(
  overrides: Partial<{
    authorized: boolean;
    requiredAccess: "relay-peer" | "admin" | "operator" | "read" | "public";
    grantedAccess: "relay-peer" | "admin" | "operator" | "read";
    authMode: "disabled" | "token" | "token-layered";
    token: string;
  }> = {}
) {
  return {
    authorized: true,
    requiredAccess: "relay-peer" as const,
    grantedAccess: "relay-peer" as const,
    authMode: "token-layered" as const,
    token: "relay-token",
    ...overrides,
  };
}

async function invokeRelayRoute(input: {
  method: string;
  url: string;
  body?: unknown;
  relayGateway?: ReturnType<typeof createRelayGateway> | null;
  authorization?: ReturnType<typeof createAuthorization>;
  relayPeerBindingStore?: ReturnType<typeof createRelayPeerIdentityBindingStore>;
}) {
  const response = createResponse();
  await handleRelayRoutes({
    req: createRequest({
      method: input.method,
      url: input.url,
      ...(input.body !== undefined ? { body: input.body } : {}),
    }),
    res: response.res,
    url: new URL(`http://127.0.0.1${input.url}`),
    relayGateway: input.relayGateway ?? createRelayGateway(),
    authorization: input.authorization ?? createAuthorization(),
    relayPeerBindingStore: input.relayPeerBindingStore ?? createRelayPeerIdentityBindingStore(),
  });
  return response;
}

test("relay routes reject missing peer ids and required action fields", async () => {
  const register = await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/register",
    body: { peerId: "   " },
  });
  assert.equal(register.res.statusCode, 400);
  assert.deepEqual(register.json, { error: "peerId is required" });

  const relayPeerBindingStore = createRelayPeerIdentityBindingStore();
  await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/register",
    body: { peerId: "peer-1" },
    relayPeerBindingStore,
  });
  const action = await invokeRelayRoute({
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
    relayPeerBindingStore,
  });
  assert.equal(action.res.statusCode, 400);
  assert.deepEqual(action.json, {
    error: "actionRequestId, browserSessionId, taskId, and relayTargetId are required",
  });
});

test("relay routes trim optional peer ids and action result fields", async () => {
  const targets = await invokeRelayRoute({
    method: "GET",
    url: "/relay/targets?peerId=%20peer-1%20",
  });
  assert.equal(targets.res.statusCode, 200);
  assert.deepEqual(targets.json, [{ peerId: "peer-1" }]);

  const relayPeerBindingStore = createRelayPeerIdentityBindingStore();
  await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/register",
    body: { peerId: "peer-1" },
    relayPeerBindingStore,
  });
  const submit = await invokeRelayRoute({
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
    relayPeerBindingStore,
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
  const relayPeerBindingStore = createRelayPeerIdentityBindingStore();
  await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/register",
    body: { peerId: "peer-1" },
    relayPeerBindingStore,
  });
  const badTargets = await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/peer-1/targets/report",
    body: {
      targets: [{ relayTargetId: "   ", url: "https://example.com" }],
    },
    relayPeerBindingStore,
  });
  assert.equal(badTargets.res.statusCode, 400);
  assert.deepEqual(badTargets.json, {
    error: "each target must include a non-empty relayTargetId",
  });

  const submit = await invokeRelayRoute({
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
    relayPeerBindingStore,
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
  const response = await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/register",
    body: "{",
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "Invalid JSON" });
});

test("relay peer routes bind relay-peer tokens to a single peer id", async () => {
  const relayPeerBindingStore = createRelayPeerIdentityBindingStore();

  const registered = await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/register",
    body: { peerId: "peer-1" },
    relayPeerBindingStore,
  });
  assert.equal(registered.res.statusCode, 201);

  const ownHeartbeat = await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/peer-1/heartbeat",
    relayPeerBindingStore,
  });
  assert.equal(ownHeartbeat.res.statusCode, 200);
  assert.deepEqual(ownHeartbeat.json, { peerId: "peer-1" });

  const wrongHeartbeat = await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/peer-2/heartbeat",
    relayPeerBindingStore,
  });
  assert.equal(wrongHeartbeat.res.statusCode, 403);
  assert.deepEqual(wrongHeartbeat.json, {
    error: "relay peer token is not bound to a peerId",
  });
});

test("relay peer mutation routes reject unbound relay-peer tokens but allow admin bypass", async () => {
  const unbound = await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/peer-1/pull-actions",
  });
  assert.equal(unbound.res.statusCode, 403);
  assert.deepEqual(unbound.json, {
    error: "relay peer token is not bound to a peerId",
  });

  const admin = await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/peer-2/heartbeat",
    authorization: createAuthorization({
      grantedAccess: "admin",
      token: "admin-token",
    }),
  });
  assert.equal(admin.res.statusCode, 200);
  assert.deepEqual(admin.json, { peerId: "peer-2" });
});

test("relay peer routes allow multiple peer ids behind the same relay token", async () => {
  const relayPeerBindingStore = createRelayPeerIdentityBindingStore();

  const first = await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/register",
    body: { peerId: "peer-1" },
    relayPeerBindingStore,
  });
  const second = await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/register",
    body: { peerId: "peer-2" },
    relayPeerBindingStore,
  });

  assert.equal(first.res.statusCode, 201);
  assert.equal(second.res.statusCode, 201);

  const heartbeat = await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/peer-2/heartbeat",
    relayPeerBindingStore,
  });
  assert.equal(heartbeat.res.statusCode, 200);
  assert.deepEqual(heartbeat.json, { peerId: "peer-2" });
});

test("relay peer routes reject unauthorized large-body endpoints before parsing request bodies", async () => {
  const relayPeerBindingStore = createRelayPeerIdentityBindingStore();
  await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/register",
    body: { peerId: "peer-1" },
    relayPeerBindingStore,
  });

  const actionResult = await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/peer-2/action-results",
    body: "{",
    relayPeerBindingStore,
  });
  assert.equal(actionResult.res.statusCode, 403);
  assert.deepEqual(actionResult.json, {
    error: "relay peer token is not bound to a peerId",
  });

  const targetReport = await invokeRelayRoute({
    method: "POST",
    url: "/relay/peers/peer-2/targets/report",
    body: "{",
    relayPeerBindingStore,
  });
  assert.equal(targetReport.res.statusCode, 403);
  assert.deepEqual(targetReport.json, {
    error: "relay peer token is not bound to a peerId",
  });
});
