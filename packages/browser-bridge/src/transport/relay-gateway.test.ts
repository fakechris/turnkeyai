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

test("relay gateway long-polls pull requests until an action is queued", async () => {
  let now = 1_000;
  const gateway = new RelayGateway({
    now: () => now,
    createId: (prefix) => `${prefix}-${++now}`,
  });
  gateway.registerPeer({
    peerId: "peer-1",
    capabilities: ["snapshot"],
  });

  const pullPromise = gateway.pullNextActionRequestWait("peer-1", 1_000);
  const dispatchPromise = gateway.dispatchActionRequest({
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [{ kind: "snapshot", note: "inspect" }],
  });

  const request = await pullPromise;
  assert.equal(request?.actionRequestId, "relay-action-1001");
  assert.equal(request?.claimToken, "relay-claim-1002");

  gateway.submitActionResult({
    actionRequestId: request!.actionRequestId,
    peerId: "peer-1",
    browserSessionId: request!.browserSessionId,
    taskId: request!.taskId,
    relayTargetId: "tab-1",
    claimToken: request!.claimToken!,
    url: "https://example.com",
    status: "completed",
    page: {
      requestedUrl: "https://example.com",
      finalUrl: "https://example.com",
      title: "Example Domain",
      textExcerpt: "Example Domain",
      statusCode: 200,
      interactives: [],
    },
    trace: [],
    screenshotPaths: [],
    screenshotPayloads: [],
    artifactIds: [],
  });

  const result = await dispatchPromise;
  assert.equal(result.status, "completed");
});

test("relay gateway dispatches wait actions to peers that advertise wait support", async () => {
  const gateway = new RelayGateway({
    now: () => 1_000,
    createId: (prefix) => `${prefix}-wait`,
  });
  gateway.registerPeer({
    peerId: "peer-1",
    capabilities: ["wait", "snapshot"],
  });

  const dispatchPromise = gateway.dispatchActionRequest({
    browserSessionId: "browser-session-1",
    taskId: "task-wait",
    actions: [
      { kind: "wait", timeoutMs: 25 },
      { kind: "snapshot", note: "after-wait" },
    ],
  });

  const request = gateway.pullNextActionRequest("peer-1");
  assert.ok(request);
  assert.deepEqual(
    request?.actions.map((action) => action.kind),
    ["wait", "snapshot"]
  );

  gateway.submitActionResult({
    actionRequestId: request!.actionRequestId,
    peerId: "peer-1",
    browserSessionId: request!.browserSessionId,
    taskId: request!.taskId,
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
    trace: [
      {
        stepId: "task-wait:browser-step:1",
        kind: "wait",
        startedAt: 1,
        completedAt: 2,
        status: "ok",
        input: { timeoutMs: 25 },
        output: { finalUrl: "https://example.com" },
      },
    ],
    screenshotPaths: [],
    screenshotPayloads: [],
    artifactIds: [],
  });

  const result = await dispatchPromise;
  assert.equal(result.taskId, "task-wait");
  assert.equal(result.trace[0]?.kind, "wait");
});

test("relay gateway routes hover key select drag waitFor dialog popup storage cookie eval network and upload actions only to peers that advertise input support", async () => {
  const gateway = new RelayGateway({
    now: () => 1_000,
    createId: (prefix) => `${prefix}-input`,
  });
  gateway.registerPeer({
    peerId: "peer-snapshot",
    capabilities: ["snapshot"],
  });
  gateway.registerPeer({
    peerId: "peer-input",
    capabilities: [
      "snapshot",
      "hover",
      "key",
      "select",
      "drag",
      "waitFor",
      "dialog",
      "popup",
      "storage",
      "cookie",
      "eval",
      "network",
      "upload",
    ],
  });

  const dispatchPromise = gateway.dispatchActionRequest({
    browserSessionId: "browser-session-1",
    taskId: "task-input",
    actions: [
      { kind: "hover", text: "Open menu" },
      { kind: "key", key: "K", modifiers: ["Control"] },
      { kind: "select", selectors: ["select[name=plan]"], value: "team" },
      { kind: "drag", source: { text: "Card" }, target: { text: "Lane" } },
      { kind: "waitFor", text: "Done", timeoutMs: 1_000 },
      { kind: "dialog", action: "accept", promptText: "yes", timeoutMs: 1_000 },
      { kind: "popup", timeoutMs: 1_000 },
      { kind: "storage", area: "localStorage", action: "set", key: "token", value: "abc" },
      { kind: "cookie", action: "set", name: "sid", value: "abc", path: "/" },
      { kind: "eval", expression: "document.title", awaitPromise: true },
      { kind: "network", action: "waitForResponse", urlPattern: "/api", method: "POST", status: 201 },
      { kind: "upload", selectors: ["input[type=file]"], artifactId: "artifact-upload" },
      { kind: "snapshot", note: "after-input" },
    ],
  });

  assert.equal(gateway.pullNextActionRequest("peer-snapshot"), null);
  const request = gateway.pullNextActionRequest("peer-input");
  assert.ok(request);
  assert.deepEqual(
    request?.actions.map((action) => action.kind),
    [
      "hover",
      "key",
      "select",
      "drag",
      "waitFor",
      "dialog",
      "popup",
      "storage",
      "cookie",
      "eval",
      "network",
      "upload",
      "snapshot",
    ]
  );

  gateway.submitActionResult({
    actionRequestId: request!.actionRequestId,
    peerId: "peer-input",
    browserSessionId: request!.browserSessionId,
    taskId: request!.taskId,
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
    trace: [
      {
        stepId: "task-input:relay-hover:1",
        kind: "hover",
        startedAt: 1,
        completedAt: 2,
        status: "ok",
        input: { text: "Open menu" },
      },
      {
        stepId: "task-input:relay-key:2",
        kind: "key",
        startedAt: 3,
        completedAt: 4,
        status: "ok",
        input: { key: "K", modifiers: ["Control"] },
      },
      {
        stepId: "task-input:relay-step:3",
        kind: "select",
        startedAt: 5,
        completedAt: 6,
        status: "ok",
        input: { value: "team" },
      },
      {
        stepId: "task-input:relay-drag:4",
        kind: "drag",
        startedAt: 7,
        completedAt: 8,
        status: "ok",
        input: { source: { text: "Card" }, target: { text: "Lane" } },
      },
      {
        stepId: "task-input:relay-step:5",
        kind: "waitFor",
        startedAt: 9,
        completedAt: 10,
        status: "ok",
        input: { text: "Done", timeoutMs: 1_000 },
      },
      {
        stepId: "task-input:relay-dialog:6",
        kind: "dialog",
        startedAt: 11,
        completedAt: 12,
        status: "ok",
        input: { action: "accept", promptTextLength: 3, timeoutMs: 1_000 },
      },
      {
        stepId: "task-input:relay-popup:7",
        kind: "popup",
        startedAt: 13,
        completedAt: 14,
        status: "ok",
        input: { timeoutMs: 1_000 },
      },
      {
        stepId: "task-input:relay-step:8",
        kind: "storage",
        startedAt: 15,
        completedAt: 16,
        status: "ok",
        input: { action: "set", area: "localStorage", key: "token", valueBytes: 3 },
      },
      {
        stepId: "task-input:relay-cookie:9",
        kind: "cookie",
        startedAt: 17,
        completedAt: 18,
        status: "ok",
        input: { action: "set", name: "sid", valueBytes: 3, path: "/" },
      },
      {
        stepId: "task-input:relay-eval:10",
        kind: "eval",
        startedAt: 19,
        completedAt: 20,
        status: "ok",
        input: { expressionBytes: 14, awaitPromise: true },
      },
      {
        stepId: "task-input:relay-network:11",
        kind: "network",
        startedAt: 21,
        completedAt: 22,
        status: "ok",
        input: { action: "waitForResponse", urlPattern: "/api", method: "POST", status: 201 },
      },
      {
        stepId: "task-input:relay-step:12",
        kind: "upload",
        startedAt: 23,
        completedAt: 24,
        status: "ok",
        input: { artifactId: "artifact-upload" },
      },
    ],
    screenshotPaths: [],
    screenshotPayloads: [],
    artifactIds: [],
  });

  const result = await dispatchPromise;
  assert.equal(result.taskId, "task-input");
  assert.equal(result.trace[0]?.kind, "hover");
  assert.equal(result.trace[1]?.kind, "key");
  assert.equal(result.trace[2]?.kind, "select");
  assert.equal(result.trace[3]?.kind, "drag");
  assert.equal(result.trace[4]?.kind, "waitFor");
  assert.equal(result.trace[5]?.kind, "dialog");
  assert.equal(result.trace[6]?.kind, "popup");
  assert.equal(result.trace[7]?.kind, "storage");
  assert.equal(result.trace[8]?.kind, "cookie");
  assert.equal(result.trace[9]?.kind, "eval");
  assert.equal(result.trace[10]?.kind, "network");
  assert.equal(result.trace[11]?.kind, "upload");
});

test("relay gateway routes cdp actions only to peers that advertise cdp support", async () => {
  const gateway = new RelayGateway({
    now: () => 1_000,
    createId: (prefix) => `${prefix}-cdp`,
  });
  gateway.registerPeer({
    peerId: "peer-snapshot",
    capabilities: ["snapshot"],
  });
  gateway.registerPeer({
    peerId: "peer-cdp",
    capabilities: ["snapshot", "cdp"],
  });

  const dispatchPromise = gateway.dispatchActionRequest({
    browserSessionId: "browser-session-1",
    taskId: "task-cdp",
    actions: [
      {
        kind: "cdp",
        method: "Runtime.evaluate",
        params: {
          expression: "document.title",
          returnByValue: true,
        },
      },
      { kind: "snapshot", note: "after-cdp" },
    ],
  });

  assert.equal(gateway.pullNextActionRequest("peer-snapshot"), null);
  const request = gateway.pullNextActionRequest("peer-cdp");
  assert.ok(request);
  assert.deepEqual(
    request?.actions.map((action) => action.kind),
    ["cdp", "snapshot"]
  );

  gateway.submitActionResult({
    actionRequestId: request!.actionRequestId,
    peerId: "peer-cdp",
    browserSessionId: request!.browserSessionId,
    taskId: request!.taskId,
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
    trace: [
      {
        stepId: "task-cdp:relay-cdp:1",
        kind: "cdp",
        startedAt: 1,
        completedAt: 2,
        status: "ok",
        input: { method: "Runtime.evaluate" },
      },
    ],
    screenshotPaths: [],
    screenshotPayloads: [],
    artifactIds: [],
  });

  const result = await dispatchPromise;
  assert.equal(result.taskId, "task-cdp");
  assert.equal(result.trace[0]?.kind, "cdp");
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

test("relay gateway default ids stay unique for same-millisecond dispatches", async () => {
  const gateway = new RelayGateway({
    now: () => 1_000,
    actionTimeoutMs: 100,
  });
  gateway.registerPeer({
    peerId: "peer-1",
    capabilities: ["snapshot"],
  });

  const firstDispatch = gateway.dispatchActionRequest({
    browserSessionId: "browser-session-1",
    taskId: "task-1",
    actions: [{ kind: "snapshot", note: "first" }],
  });
  const secondDispatch = gateway.dispatchActionRequest({
    browserSessionId: "browser-session-2",
    taskId: "task-2",
    actions: [{ kind: "snapshot", note: "second" }],
  });

  const firstClaim = gateway.pullNextActionRequest("peer-1");
  const secondClaim = gateway.pullNextActionRequest("peer-1");
  assert.ok(firstClaim);
  assert.ok(secondClaim);
  assert.notEqual(firstClaim?.actionRequestId, secondClaim?.actionRequestId);
  assert.notEqual(firstClaim?.claimToken, secondClaim?.claimToken);

  gateway.submitActionResult({
    actionRequestId: firstClaim!.actionRequestId,
    peerId: "peer-1",
    browserSessionId: firstClaim!.browserSessionId,
    taskId: firstClaim!.taskId,
    relayTargetId: "tab-1",
    claimToken: firstClaim!.claimToken!,
    url: "https://example.com/first",
    status: "completed",
    page: {
      requestedUrl: "https://example.com/first",
      finalUrl: "https://example.com/first",
      title: "First",
      textExcerpt: "First",
      statusCode: 200,
      interactives: [],
    },
    trace: [],
    screenshotPaths: [],
    screenshotPayloads: [],
    artifactIds: [],
  });
  gateway.submitActionResult({
    actionRequestId: secondClaim!.actionRequestId,
    peerId: "peer-1",
    browserSessionId: secondClaim!.browserSessionId,
    taskId: secondClaim!.taskId,
    relayTargetId: "tab-2",
    claimToken: secondClaim!.claimToken!,
    url: "https://example.com/second",
    status: "completed",
    page: {
      requestedUrl: "https://example.com/second",
      finalUrl: "https://example.com/second",
      title: "Second",
      textExcerpt: "Second",
      statusCode: 200,
      interactives: [],
    },
    trace: [],
    screenshotPaths: [],
    screenshotPayloads: [],
    artifactIds: [],
  });

  const [firstResult, secondResult] = await Promise.all([firstDispatch, secondDispatch]);
  assert.equal(firstResult.taskId, "task-1");
  assert.equal(secondResult.taskId, "task-2");
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
