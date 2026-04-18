import assert from "node:assert/strict";
import test from "node:test";

import type {
  RelayActionRequest,
  RelayActionResult,
  RelayPeerRecord,
  RelayTargetRecord,
  RelayTargetReport,
} from "@turnkeyai/browser-bridge/transport/relay-protocol";

import { BrowserRelayPeerRuntime } from "./peer-runtime";

test("browser relay peer runtime registers, syncs targets, pulls actions, and submits results", async () => {
  const calls: string[] = [];
  const queuedActions: RelayActionRequest[] = [
    {
      actionRequestId: "relay-action-1",
      peerId: "peer-1",
      browserSessionId: "browser-session-1",
      taskId: "task-1",
      relayTargetId: "tab-1",
      actions: [{ kind: "snapshot", note: "inspect" }],
      createdAt: 1,
      expiresAt: 2,
      claimToken: "claim-1",
    },
  ];
  const submitted: RelayActionResult[] = [];

  const runtime = new BrowserRelayPeerRuntime({
    peer: {
      peerId: "peer-1",
      label: "Desktop Chrome",
      capabilities: ["open", "snapshot", "click", "type"],
    },
    client: {
      async registerPeer(input) {
        calls.push(`register:${input.peerId}`);
        return peerRecord();
      },
      async heartbeatPeer(peerId) {
        calls.push(`heartbeat:${peerId}`);
        return peerRecord();
      },
      async reportTargets(peerId, targets) {
        calls.push(`targets:${peerId}:${targets.length}`);
        return targets.map((target) => toTargetRecord(peerId, target));
      },
      async pullNextAction(peerId) {
        calls.push(`pull:${peerId}`);
        return queuedActions.shift() ?? null;
      },
      async submitActionResult(peerId, result) {
        calls.push(`submit:${peerId}:${result.actionRequestId}`);
        const payload: RelayActionResult = {
          peerId,
          ...result,
        };
        submitted.push(payload);
        return payload;
      },
    },
    targetObserver: {
      async listTargets(): Promise<RelayTargetReport[]> {
        return [
          {
            relayTargetId: "tab-1",
            url: "https://example.com/pricing",
            title: "Pricing",
            status: "attached",
          },
        ];
      },
    },
    actionExecutor: {
      async execute(request) {
        calls.push(`execute:${request.actionRequestId}`);
        return {
          url: "https://example.com/pricing",
          title: "Pricing",
          status: "completed",
          page: {
            requestedUrl: "https://example.com/pricing",
            finalUrl: "https://example.com/pricing",
            title: "Pricing",
            textExcerpt: "Pricing page",
            statusCode: 200,
            interactives: [],
          },
          trace: [],
        };
      },
    },
  });

  const result = await runtime.runCycle();

  assert.equal(result?.actionRequestId, "relay-action-1");
  assert.equal(submitted.length, 1);
  assert.deepEqual(calls, [
    "register:peer-1",
    "targets:peer-1:1",
    "heartbeat:peer-1",
    "pull:peer-1",
    "execute:relay-action-1",
    "submit:peer-1:relay-action-1",
  ]);
});

test("browser relay peer runtime stays idle when no action is queued", async () => {
  let pullCount = 0;
  const runtime = new BrowserRelayPeerRuntime({
    peer: {
      peerId: "peer-1",
      capabilities: ["snapshot"],
    },
    client: {
      async registerPeer() {
        return peerRecord();
      },
      async heartbeatPeer() {
        return peerRecord();
      },
      async reportTargets(peerId, targets) {
        return targets.map((target) => toTargetRecord(peerId, target));
      },
      async pullNextAction() {
        pullCount += 1;
        return null;
      },
      async submitActionResult() {
        throw new Error("submit should not be called when no action is queued");
      },
    },
    targetObserver: {
      async listTargets() {
        return [];
      },
    },
    actionExecutor: {
      async execute() {
        throw new Error("execute should not be called when no action is queued");
      },
    },
  });

  const result = await runtime.runCycle();
  assert.equal(result, null);
  assert.equal(pullCount, 1);
});

test("browser relay peer runtime submits a failed result when execution throws for a known relay target", async () => {
  const submitted: RelayActionResult[] = [];
  const runtime = new BrowserRelayPeerRuntime({
    peer: {
      peerId: "peer-1",
      capabilities: ["snapshot"],
    },
    client: {
      async registerPeer() {
        return peerRecord();
      },
      async heartbeatPeer() {
        return peerRecord();
      },
      async reportTargets(peerId, targets) {
        return targets.map((target) => toTargetRecord(peerId, target));
      },
      async pullNextAction() {
        return {
          actionRequestId: "relay-action-1",
          peerId: "peer-1",
          browserSessionId: "browser-session-1",
          taskId: "task-1",
          relayTargetId: "chrome-tab:7",
          actions: [{ kind: "snapshot", note: "inspect" }],
          createdAt: 1,
          expiresAt: 2,
          claimToken: "claim-1",
        };
      },
      async submitActionResult(peerId, result) {
        const payload: RelayActionResult = {
          peerId,
          ...result,
        };
        submitted.push(payload);
        return payload;
      },
    },
    targetObserver: {
      async listTargets() {
        return [];
      },
    },
    actionExecutor: {
      async execute() {
        throw new Error("content script unavailable");
      },
    },
  });

  const result = await runtime.runCycle();
  assert.equal(result?.status, "failed");
  assert.match(result?.errorMessage ?? "", /content script unavailable/);
  assert.equal(result?.relayTargetId, "chrome-tab:7");
  assert.equal(submitted.length, 1);
});

test("browser relay peer runtime rejects action requests without claim tokens", async () => {
  let executed = false;
  const runtime = new BrowserRelayPeerRuntime({
    peer: {
      peerId: "peer-1",
      capabilities: ["snapshot"],
    },
    client: {
      async registerPeer() {
        return peerRecord();
      },
      async heartbeatPeer() {
        return peerRecord();
      },
      async reportTargets(peerId, targets) {
        return targets.map((target) => toTargetRecord(peerId, target));
      },
      async pullNextAction() {
        return {
          actionRequestId: "relay-action-1",
          peerId: "peer-1",
          browserSessionId: "browser-session-1",
          taskId: "task-1",
          relayTargetId: "chrome-tab:7",
          actions: [{ kind: "snapshot", note: "inspect" }],
          createdAt: 1,
          expiresAt: 2,
        };
      },
      async submitActionResult() {
        throw new Error("submit should not be called when claimToken is missing");
      },
    },
    targetObserver: {
      async listTargets() {
        return [];
      },
    },
    actionExecutor: {
      async execute() {
        executed = true;
        return {
          relayTargetId: "chrome-tab:7",
          url: "https://example.com",
          status: "completed" as const,
          trace: [],
        };
      },
    },
  });

  await assert.rejects(() => runtime.runCycle(), /relay action request is missing claimToken/);
  assert.equal(executed, false);
});

test("browser relay peer runtime heartbeats while executing a long-running action", async () => {
  const calls: string[] = [];
  const runtime = new BrowserRelayPeerRuntime({
    peer: {
      peerId: "peer-1",
      capabilities: ["snapshot"],
    },
    client: {
      async registerPeer() {
        calls.push("register");
        return peerRecord();
      },
      async heartbeatPeer() {
        calls.push("heartbeat");
        return peerRecord();
      },
      async reportTargets(peerId, targets) {
        calls.push(`targets:${peerId}:${targets.length}`);
        return targets.map((target) => toTargetRecord(peerId, target));
      },
      async pullNextAction() {
        calls.push("pull");
        return {
          actionRequestId: "relay-action-1",
          peerId: "peer-1",
          browserSessionId: "browser-session-1",
          taskId: "task-1",
          relayTargetId: "tab-1",
          actions: [{ kind: "snapshot", note: "inspect" }],
          createdAt: 1,
          expiresAt: 2,
          claimToken: "claim-1",
        };
      },
      async submitActionResult(peerId, result) {
        calls.push(`submit:${peerId}:${result.claimToken}`);
        return {
          peerId,
          ...result,
        };
      },
    },
    targetObserver: {
      async listTargets() {
        return [];
      },
    },
    actionExecutor: {
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 275));
        return {
          relayTargetId: "tab-1",
          url: "https://example.com",
          status: "completed" as const,
          trace: [],
        };
      },
    },
    executionHeartbeatIntervalMs: 250,
  });

  const result = await runtime.runCycle();
  assert.equal(result?.claimToken, "claim-1");
  assert.ok(calls.filter((entry) => entry === "heartbeat").length >= 2);
  assert.ok(calls.includes("submit:peer-1:claim-1"));
});

test("browser relay peer runtime submits results even when an execution heartbeat hangs", async () => {
  const calls: string[] = [];
  let heartbeatCalls = 0;
  const runtime = new BrowserRelayPeerRuntime({
    peer: {
      peerId: "peer-1",
      capabilities: ["snapshot"],
    },
    client: {
      async registerPeer() {
        calls.push("register");
        return peerRecord();
      },
      async heartbeatPeer() {
        heartbeatCalls += 1;
        calls.push(`heartbeat:${heartbeatCalls}`);
        if (heartbeatCalls >= 2) {
          return new Promise<RelayPeerRecord>(() => undefined);
        }
        return peerRecord();
      },
      async reportTargets(peerId, targets) {
        calls.push(`targets:${peerId}:${targets.length}`);
        return targets.map((target) => toTargetRecord(peerId, target));
      },
      async pullNextAction() {
        calls.push("pull");
        return {
          actionRequestId: "relay-action-1",
          peerId: "peer-1",
          browserSessionId: "browser-session-1",
          taskId: "task-1",
          relayTargetId: "tab-1",
          actions: [{ kind: "snapshot", note: "inspect" }],
          createdAt: 1,
          expiresAt: 2,
          claimToken: "claim-1",
        };
      },
      async submitActionResult(peerId, result) {
        calls.push(`submit:${peerId}:${result.claimToken}`);
        return {
          peerId,
          ...result,
        };
      },
    },
    targetObserver: {
      async listTargets() {
        return [];
      },
    },
    actionExecutor: {
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 275));
        return {
          relayTargetId: "tab-1",
          url: "https://example.com",
          status: "completed" as const,
          trace: [],
        };
      },
    },
    executionHeartbeatIntervalMs: 250,
  });

  const result = await Promise.race([
    runtime.runCycle(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("runCycle timed out")), 1_000)),
  ]);
  assert.equal(result?.claimToken, "claim-1");
  assert.ok(calls.includes("submit:peer-1:claim-1"));
});

function peerRecord(): RelayPeerRecord {
  return {
    peerId: "peer-1",
    capabilities: ["snapshot"],
    registeredAt: 1,
    lastSeenAt: 1,
    status: "online",
  };
}

function toTargetRecord(peerId: string, target: RelayTargetReport): RelayTargetRecord {
  return {
    peerId,
    relayTargetId: target.relayTargetId,
    url: target.url,
    ...(target.title ? { title: target.title } : {}),
    status: target.status ?? "open",
    lastSeenAt: 1,
  };
}
