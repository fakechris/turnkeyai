import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { BrowserActionTrace } from "@turnkeyai/core-types/team";

import { RelayBrowserAdapter } from "./relay-adapter";
import type { RelayActionRequest } from "./relay-protocol";

test("relay browser adapter can attach to a reported target and execute snapshot actions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "relay-browser-adapter-"));

  try {
    const adapter = new RelayBrowserAdapter({
      artifactRootDir: path.join(tempDir, "artifacts"),
      stateRootDir: path.join(tempDir, "state"),
      relay: {
        relayPeerId: "peer-1",
      },
    });
    const gateway = adapter.getRelayControlPlane();
    gateway.registerPeer({
      peerId: "peer-1",
      capabilities: ["open", "snapshot", "click", "type"],
    });
    gateway.reportTargets("peer-1", [
      {
        relayTargetId: "tab-1",
        url: "https://example.com/pricing",
        title: "Pricing",
        status: "attached",
      },
    ]);

    const resultPromise = adapter.spawnSession({
      taskId: "task-1",
      threadId: "thread-1",
      instructions: "Inspect current tab",
      actions: [{ kind: "snapshot", note: "inspect" }],
      ownerType: "thread",
      ownerId: "thread-1",
      profileOwnerType: "thread",
      profileOwnerId: "thread-1",
    });

    const request = await waitForActionRequest(() => gateway.pullNextActionRequest("peer-1"));
    assert.ok(request);
    assert.equal(request?.relayTargetId, "tab-1");
    assert.equal(request?.actions[0]?.kind, "snapshot");

    const trace: BrowserActionTrace[] = [
      {
        stepId: "task-1:browser-step:1",
        kind: "snapshot",
        startedAt: 1,
        completedAt: 2,
        status: "ok",
        input: { note: "inspect" },
        output: { finalUrl: "https://example.com/pricing" },
      },
    ];

    gateway.submitActionResult({
      actionRequestId: request!.actionRequestId,
      peerId: "peer-1",
      browserSessionId: request!.browserSessionId,
      taskId: request!.taskId,
      relayTargetId: "tab-1",
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
      trace,
      screenshotPaths: [],
      screenshotPayloads: [],
      artifactIds: [],
    });

    const result = await resultPromise;
    assert.equal(result.dispatchMode, "spawn");
    assert.equal(result.targetResolution, "attach");
    assert.equal(result.page.finalUrl, "https://example.com/pricing");
    assert.ok(result.targetId);

    const targets = await adapter.listTargets(result.sessionId);
    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.transportSessionId, "tab-1");

    const history = await adapter.getSessionHistory({ browserSessionId: result.sessionId });
    assert.equal(history.length, 1);
    assert.equal(history[0]?.targetResolution, "attach");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("relay browser adapter persists screenshot payloads returned by a relay peer", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "relay-browser-adapter-"));

  try {
    const adapter = new RelayBrowserAdapter({
      artifactRootDir: path.join(tempDir, "artifacts"),
      stateRootDir: path.join(tempDir, "state"),
      relay: {
        relayPeerId: "peer-1",
      },
    });
    const gateway = adapter.getRelayControlPlane();
    gateway.registerPeer({
      peerId: "peer-1",
      capabilities: ["snapshot", "screenshot"],
    });
    gateway.reportTargets("peer-1", [
      {
        relayTargetId: "tab-1",
        url: "https://example.com/pricing",
        title: "Pricing",
        status: "attached",
      },
    ]);

    const resultPromise = adapter.spawnSession({
      taskId: "task-2",
      threadId: "thread-1",
      instructions: "Capture screenshot",
      actions: [{ kind: "screenshot", label: "final" }],
      ownerType: "thread",
      ownerId: "thread-1",
      profileOwnerType: "thread",
      profileOwnerId: "thread-1",
    });

    const request = await waitForActionRequest(() => gateway.pullNextActionRequest("peer-1"));
    gateway.submitActionResult({
      actionRequestId: request.actionRequestId,
      peerId: "peer-1",
      browserSessionId: request.browserSessionId,
      taskId: request.taskId,
      relayTargetId: "tab-1",
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
      trace: [
        {
          stepId: "task-2:relay-screenshot:1",
          kind: "screenshot",
          startedAt: 1,
          completedAt: 2,
          status: "ok",
          input: { label: "final" },
        },
      ],
      screenshotPaths: [],
      screenshotPayloads: [
        {
          label: "final",
          mimeType: "image/png",
          dataBase64: "c2NyZWVuc2hvdA==",
        },
      ],
      artifactIds: [],
    });

    const result = await resultPromise;
    assert.equal(result.screenshotPaths.length, 1);
    assert.match(result.screenshotPaths[0] ?? "", /final\.png$/);
    assert.equal(result.artifactIds.some((artifactId) => artifactId.includes("relay-screenshot")), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("relay browser adapter chooses a peer whose capabilities satisfy open actions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "relay-browser-adapter-"));

  try {
    const adapter = new RelayBrowserAdapter({
      artifactRootDir: path.join(tempDir, "artifacts"),
      stateRootDir: path.join(tempDir, "state"),
    });
    const gateway = adapter.getRelayControlPlane();
    gateway.registerPeer({
      peerId: "peer-snapshot-only",
      capabilities: ["snapshot"],
      transportLabel: "synthetic-relay",
    });
    gateway.reportTargets("peer-snapshot-only", [
      {
        relayTargetId: "synthetic-tab:1",
        url: "https://example.com/placeholder",
        title: "Placeholder",
        status: "attached",
      },
    ]);
    gateway.registerPeer({
      peerId: "peer-browser",
      capabilities: ["open", "snapshot", "click", "type", "scroll", "console", "screenshot"],
      transportLabel: "chrome-relay",
    });
    gateway.reportTargets("peer-browser", [
      {
        relayTargetId: "chrome-tab:1",
        url: "https://example.com/start",
        title: "Start",
        status: "attached",
      },
    ]);

    const resultPromise = adapter.spawnSession({
      taskId: "task-capability-routing",
      threadId: "thread-1",
      instructions: "Open a page through a capable relay peer",
      actions: [
        { kind: "open", url: "https://example.com/opened" },
        { kind: "snapshot", note: "after-open" },
      ],
      ownerType: "thread",
      ownerId: "thread-1",
      profileOwnerType: "thread",
      profileOwnerId: "thread-1",
    });

    const request = await waitForActionRequest(() => gateway.pullNextActionRequest("peer-browser"));
    assert.equal(request.peerId, "peer-browser");
    assert.equal(gateway.pullNextActionRequest("peer-snapshot-only"), null);

    gateway.submitActionResult({
      actionRequestId: request.actionRequestId,
      peerId: "peer-browser",
      browserSessionId: request.browserSessionId,
      taskId: request.taskId,
      relayTargetId: "chrome-tab:1",
      url: "https://example.com/opened",
      title: "Opened",
      status: "completed",
      page: {
        requestedUrl: "https://example.com/opened",
        finalUrl: "https://example.com/opened",
        title: "Opened",
        textExcerpt: "Opened page",
        statusCode: 200,
        interactives: [],
      },
      trace: [
        {
          stepId: "task-capability-routing:browser-step:1",
          kind: "open",
          startedAt: 1,
          completedAt: 2,
          status: "ok",
          input: { url: "https://example.com/opened" },
        },
        {
          stepId: "task-capability-routing:browser-step:2",
          kind: "snapshot",
          startedAt: 3,
          completedAt: 4,
          status: "ok",
          input: { note: "after-open" },
        },
      ],
      screenshotPaths: [],
      screenshotPayloads: [],
      artifactIds: [],
    });

    const result = await resultPromise;
    assert.equal(result.transportPeerId, "peer-browser");
    assert.equal(result.transportTargetId, "chrome-tab:1");
    assert.equal(result.page.finalUrl, "https://example.com/opened");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("relay browser adapter reattaches when a stored relay target disappears after reconnect", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "relay-browser-adapter-"));

  try {
    const adapter = new RelayBrowserAdapter({
      artifactRootDir: path.join(tempDir, "artifacts"),
      stateRootDir: path.join(tempDir, "state"),
      relay: {
        relayPeerId: "peer-1",
      },
    });
    const gateway = adapter.getRelayControlPlane();
    gateway.registerPeer({
      peerId: "peer-1",
      capabilities: ["snapshot", "console"],
      transportLabel: "chrome-relay",
    });
    gateway.reportTargets("peer-1", [
      {
        relayTargetId: "chrome-tab:1",
        url: "https://example.com/submitted",
        title: "Submitted",
        status: "attached",
      },
    ]);

    const spawnPromise = adapter.spawnSession({
      taskId: "task-reconnect-spawn",
      threadId: "thread-1",
      instructions: "Inspect current tab",
      actions: [{ kind: "snapshot", note: "initial" }],
      ownerType: "thread",
      ownerId: "thread-1",
      profileOwnerType: "thread",
      profileOwnerId: "thread-1",
    });

    const initialRequest = await waitForActionRequest(() => gateway.pullNextActionRequest("peer-1"));
    gateway.submitActionResult({
      actionRequestId: initialRequest.actionRequestId,
      peerId: "peer-1",
      browserSessionId: initialRequest.browserSessionId,
      taskId: initialRequest.taskId,
      relayTargetId: "chrome-tab:1",
      url: "https://example.com/submitted",
      title: "Submitted",
      status: "completed",
      page: {
        requestedUrl: "https://example.com/submitted",
        finalUrl: "https://example.com/submitted",
        title: "Submitted",
        textExcerpt: "Submitted page",
        statusCode: 200,
        interactives: [],
      },
      trace: [],
      screenshotPaths: [],
      screenshotPayloads: [],
      artifactIds: [],
    });
    const initialResult = await spawnPromise;

    gateway.reportTargets("peer-1", [
      {
        relayTargetId: "chrome-tab:2",
        url: "https://example.com/submitted",
        title: "Submitted",
        status: "attached",
      },
    ]);

    const resumePromise = adapter.resumeSession({
      taskId: "task-reconnect-resume",
      threadId: "thread-1",
      browserSessionId: initialResult.sessionId,
      instructions: "Resume after reconnect",
      actions: [{ kind: "console", probe: "page-metadata" }],
      ownerType: "thread",
      ownerId: "thread-1",
    });

    const resumedRequest = await waitForActionRequest(() => gateway.pullNextActionRequest("peer-1"));
    assert.equal(resumedRequest.relayTargetId, "chrome-tab:2");
    assert.equal(resumedRequest.actions[0]?.kind, "open");
    assert.equal((resumedRequest.actions[0] as { url?: string }).url, "https://example.com/submitted");
    assert.equal(resumedRequest.actions[1]?.kind, "console");
    gateway.submitActionResult({
      actionRequestId: resumedRequest.actionRequestId,
      peerId: "peer-1",
      browserSessionId: resumedRequest.browserSessionId,
      taskId: resumedRequest.taskId,
      relayTargetId: "chrome-tab:2",
      url: "https://example.com/submitted",
      title: "Submitted",
      status: "completed",
      page: {
        requestedUrl: "https://example.com/submitted",
        finalUrl: "https://example.com/submitted",
        title: "Submitted",
        textExcerpt: "Submitted page",
        statusCode: 200,
        interactives: [],
      },
      trace: [
        {
          stepId: "task-reconnect-resume:browser-step:1",
          kind: "open",
          startedAt: 1,
          completedAt: 2,
          status: "ok",
          input: { url: "https://example.com/submitted" },
        },
        {
          stepId: "task-reconnect-resume:browser-step:2",
          kind: "console",
          startedAt: 3,
          completedAt: 4,
          status: "ok",
          input: { probe: "page-metadata" },
          output: { result: { title: "Submitted" } },
        },
      ],
      screenshotPaths: [],
      screenshotPayloads: [],
      artifactIds: [],
    });
    const resumedResult = await resumePromise;
    assert.equal(resumedResult.transportTargetId, "chrome-tab:2");
    assert.equal(resumedResult.resumeMode, "warm");
    assert.equal(resumedResult.targetResolution, "reconnect");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function waitForActionRequest(pull: () => RelayActionRequest | null): Promise<RelayActionRequest> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const request = pull();
    if (request) {
      return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for relay action request");
}
