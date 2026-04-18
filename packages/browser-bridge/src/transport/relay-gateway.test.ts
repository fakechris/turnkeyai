import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserActionTrace } from "@turnkeyai/core-types/team";

import { RelayGateway } from "./relay-gateway";

test("relay gateway tracks peer lifecycle and reported targets", () => {
  let now = 1_000;
  const gateway = new RelayGateway({
    now: () => now,
    createId: (prefix) => `${prefix}-${now}`,
    staleAfterMs: 50,
  });

  const peer = gateway.registerPeer({
    peerId: "peer-1",
    label: "Desktop Chrome",
    capabilities: ["snapshot", "click"],
  });
  assert.equal(peer.status, "online");

  gateway.reportTargets("peer-1", [
    {
      relayTargetId: "tab-1",
      url: "https://example.com/pricing",
      title: "Pricing",
      status: "attached",
    },
  ]);
  assert.deepEqual(gateway.listTargets({ peerId: "peer-1" }).map((item) => item.relayTargetId), ["tab-1"]);

  now += 60;
  assert.equal(gateway.listPeers()[0]?.status, "stale");

  gateway.heartbeatPeer("peer-1");
  assert.equal(gateway.listPeers()[0]?.status, "online");
});

test("relay gateway dispatches queued action requests and resolves submitted results", async () => {
  let now = 1_000;
  const gateway = new RelayGateway({
    now: () => now,
    createId: (prefix) => `${prefix}-${++now}`,
  });
  gateway.registerPeer({
    peerId: "peer-1",
    capabilities: ["open", "snapshot", "click", "type"],
  });

  const dispatchPromise = gateway.dispatchActionRequest({
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [
      { kind: "open", url: "https://example.com" },
      { kind: "snapshot", note: "after-open" },
    ],
  });

  const request = gateway.pullNextActionRequest("peer-1");
  assert.ok(request);
  assert.equal(request?.taskId, "task-1");
  assert.equal(request?.actions.length, 2);

  const trace: BrowserActionTrace[] = [
    {
      stepId: "task-1:browser-step:1",
      kind: "open",
      startedAt: 1,
      completedAt: 2,
      status: "ok",
      input: { url: "https://example.com" },
      output: { finalUrl: "https://example.com" },
    },
  ];

  gateway.submitActionResult({
    actionRequestId: request!.actionRequestId,
    peerId: "peer-1",
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    relayTargetId: "tab-1",
    claimToken: request!.claimToken!,
    url: "https://example.com",
    title: "Example Domain",
    status: "completed",
    page: {
      requestedUrl: "https://example.com",
      finalUrl: "https://example.com",
      title: "Example Domain",
      textExcerpt: "Example Domain",
      statusCode: 200,
      interactives: [],
    },
    trace,
    screenshotPaths: [],
    screenshotPayloads: [],
    artifactIds: [],
  });

  const result = await dispatchPromise;
  assert.equal(result.relayTargetId, "tab-1");
  assert.equal(result.page?.finalUrl, "https://example.com");
  assert.equal(gateway.listTargets({ peerId: "peer-1" })[0]?.relayTargetId, "tab-1");
});

test("relay gateway drops timed out action requests from the pending queue", async () => {
  const gateway = new RelayGateway({
    now: () => Date.now(),
    createId: (prefix) => `${prefix}-timeout`,
    actionTimeoutMs: 10,
  });
  gateway.registerPeer({
    peerId: "peer-1",
    capabilities: ["snapshot"],
  });

  const dispatchPromise = gateway.dispatchActionRequest({
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [{ kind: "snapshot", note: "timeout" }],
  });

  await assert.rejects(dispatchPromise, /relay action request timed out/);
  assert.equal(gateway.pullNextActionRequest("peer-1"), null);
});

test("relay gateway fails fast when a locked target peer lacks required capabilities", async () => {
  const gateway = new RelayGateway({
    now: () => 1_000,
    createId: (prefix) => `${prefix}-locked-target`,
  });
  gateway.registerPeer({
    peerId: "peer-1",
    capabilities: ["snapshot"],
  });
  gateway.reportTargets("peer-1", [
    {
      relayTargetId: "tab-1",
      url: "https://example.com",
      title: "Example",
      status: "attached",
    },
  ]);

  await assert.rejects(
    () =>
      gateway.dispatchActionRequest({
        browserSessionId: "browser-session-1",
        taskId: "task-1",
        relayTargetId: "tab-1",
        actions: [{ kind: "open", url: "https://example.com/opened" }],
      }),
    /relay peer peer-1 does not support required action kinds/
  );
  assert.equal(gateway.listActionRequests().length, 0);
});

test("relay gateway reclaims expired inflight claims and reassigns them", async () => {
  let now = 1_000;
  let seq = 0;
  const gateway = new RelayGateway({
    now: () => now,
    createId: (prefix) => `${prefix}-${++seq}`,
    actionTimeoutMs: 100,
    claimLeaseMs: 10,
  });
  gateway.registerPeer({
    peerId: "peer-1",
    capabilities: ["snapshot"],
  });
  gateway.registerPeer({
    peerId: "peer-2",
    capabilities: ["snapshot"],
  });

  const dispatchPromise = gateway.dispatchActionRequest({
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [{ kind: "snapshot", note: "inspect" }],
  });

  const firstClaim = gateway.pullNextActionRequest("peer-1");
  assert.ok(firstClaim);
  assert.equal(firstClaim?.peerId, "peer-1");
  assert.equal(firstClaim?.attemptCount, 1);
  assert.equal(firstClaim?.reclaimCount, 0);

  now += 11;
  const secondClaim = gateway.pullNextActionRequest("peer-2");
  assert.ok(secondClaim);
  assert.equal(secondClaim?.peerId, "peer-2");
  assert.equal(secondClaim?.attemptCount, 2);
  assert.equal(secondClaim?.reclaimCount, 1);

  const requests = gateway.listActionRequests();
  assert.deepEqual(requests, [
    {
      actionRequestId: "relay-action-1",
      browserSessionId: "browser-session-1",
      taskId: "task-1",
      actionKinds: ["snapshot"],
      createdAt: 1_000,
      expiresAt: 1_100,
      state: "inflight",
      assignedPeerId: "peer-2",
      claimToken: "relay-claim-3",
      claimedAt: 1_011,
      claimExpiresAt: 1_021,
      attemptCount: 2,
      reclaimCount: 1,
      lastClaimExpiredAt: 1_011,
    },
  ]);

  gateway.submitActionResult({
    actionRequestId: secondClaim!.actionRequestId,
    peerId: "peer-2",
    browserSessionId: secondClaim!.browserSessionId,
    taskId: secondClaim!.taskId,
    relayTargetId: "tab-2",
    claimToken: secondClaim!.claimToken!,
    url: "https://example.com/reclaimed",
    status: "completed",
    page: {
      requestedUrl: "https://example.com/reclaimed",
      finalUrl: "https://example.com/reclaimed",
      title: "Reclaimed",
      textExcerpt: "Reclaimed page",
      statusCode: 200,
      interactives: [],
    },
    trace: [],
    screenshotPaths: [],
    screenshotPayloads: [],
    artifactIds: [],
  });
  await dispatchPromise;
});

test("relay gateway heartbeats renew inflight claim leases", async () => {
  let now = 1_000;
  let seq = 0;
  const gateway = new RelayGateway({
    now: () => now,
    createId: (prefix) => `${prefix}-${++seq}`,
    actionTimeoutMs: 100,
    claimLeaseMs: 10,
  });
  gateway.registerPeer({
    peerId: "peer-1",
    capabilities: ["snapshot"],
  });

  const dispatchPromise = gateway.dispatchActionRequest({
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [{ kind: "snapshot", note: "inspect" }],
  });

  const claim = gateway.pullNextActionRequest("peer-1");
  assert.ok(claim);
  assert.equal(claim?.claimExpiresAt, 1_010);

  now = 1_008;
  gateway.heartbeatPeer("peer-1");
  const renewed = gateway.listActionRequests()[0];
  assert.equal(renewed?.state, "inflight");
  assert.equal(renewed?.claimExpiresAt, 1_018);

  gateway.submitActionResult({
    actionRequestId: claim!.actionRequestId,
    peerId: "peer-1",
    browserSessionId: claim!.browserSessionId,
    taskId: claim!.taskId,
    relayTargetId: "tab-1",
    claimToken: claim!.claimToken!,
    url: "https://example.com",
    status: "completed",
    page: {
      requestedUrl: "https://example.com",
      finalUrl: "https://example.com",
      title: "Example",
      textExcerpt: "Example",
      statusCode: 200,
      interactives: [],
    },
    trace: [],
    screenshotPaths: [],
    screenshotPayloads: [],
    artifactIds: [],
  });
  await dispatchPromise;
});
