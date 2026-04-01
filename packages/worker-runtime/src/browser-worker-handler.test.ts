import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { BrowserBridge, WorkerInvocationInput } from "@turnkeyai/core-types/team";
import { FileReplayRecorder } from "@turnkeyai/qc-runtime/file-replay-recorder";

import { BrowserWorkerHandler } from "./browser-worker-handler";

test("browser worker handler records replay and quality metadata on bridge failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-worker-handler-"));
  const replayRecorder = new FileReplayRecorder({
    rootDir: tempDir,
  });

  try {
    const bridge: BrowserBridge = {
      async inspectPublicPage() {
        throw new Error("not used");
      },
      async spawnSession() {
        throw new Error("browser crashed");
      },
      async sendSession() {
        throw new Error("browser crashed");
      },
      async resumeSession() {
        throw new Error("browser crashed");
      },
      async getSessionHistory() {
        return [];
      },
      async runTask() {
        throw new Error("browser crashed");
      },
      async listSessions() {
        return [];
      },
      async listTargets() {
        return [];
      },
      async evictIdleSessions() {
        return [];
      },
      async openTarget() {
        throw new Error("not used");
      },
      async activateTarget() {
        throw new Error("not used");
      },
      async closeTarget() {
        throw new Error("not used");
      },
      async closeSession() {},
    };

    const handler = new BrowserWorkerHandler({
      browserBridge: bridge,
      replayRecorder,
    });

    const result = await handler.run(buildWorkerInvocationInput());
    assert.ok(result);
    const payload = result.payload as {
      quality: {
        replayPath: string | null;
        stepReport: { ok: boolean };
        resultReport: { ok: boolean };
      };
      error: string;
    };

    assert.equal(payload.error, "browser crashed");
    assert.equal(payload.quality.stepReport.ok, false);
    assert.equal(payload.quality.resultReport.ok, false);
    assert.ok(payload.quality.replayPath);

    const replay = await replayRecorder.get(payload.quality.replayPath!);
    assert.ok(replay);
    assert.equal(replay?.status, "failed");
    assert.equal(
      ((replay?.metadata as { result?: { trace?: Array<{ errorMessage?: string }> } } | undefined)?.result?.trace?.[0]?.errorMessage ?? "")
        .includes("browser crashed"),
      true
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser worker handler records replay and quality metadata on success", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-worker-handler-success-"));
  const replayRecorder = new FileReplayRecorder({
    rootDir: tempDir,
  });

  try {
    const bridge: BrowserBridge = {
      async inspectPublicPage() {
        throw new Error("not used");
      },
      async spawnSession() {
        return {
          sessionId: "session-1",
          page: {
            requestedUrl: "https://example.com/",
            finalUrl: "https://example.com/",
            title: "Example Domain",
            textExcerpt: "Example Domain",
            statusCode: 200,
            interactives: [],
          },
          screenshotPaths: [],
          artifactIds: [],
          trace: [
            {
              stepId: "task-1:browser-step:1",
              kind: "open",
              startedAt: 1,
              completedAt: 2,
              status: "ok",
              input: { url: "https://example.com/" },
            },
            {
              stepId: "task-1:browser-step:2",
              kind: "snapshot",
              startedAt: 2,
              completedAt: 3,
              status: "ok",
              input: { note: "after-open" },
            },
            {
              stepId: "task-1:browser-step:3",
              kind: "console",
              startedAt: 3,
              completedAt: 4,
              status: "ok",
              input: { probe: "page-metadata" },
            },
            {
              stepId: "task-1:browser-step:4",
              kind: "screenshot",
              startedAt: 4,
              completedAt: 5,
              status: "ok",
              input: { label: "final" },
            },
          ],
        };
      },
      async sendSession() {
        throw new Error("not used");
      },
      async resumeSession() {
        throw new Error("not used");
      },
      async getSessionHistory() {
        return [];
      },
      async runTask() {
        return {
          sessionId: "session-1",
          page: {
            requestedUrl: "https://example.com/",
            finalUrl: "https://example.com/",
            title: "Example Domain",
            textExcerpt: "Example Domain",
            statusCode: 200,
            interactives: [],
          },
          screenshotPaths: [],
          artifactIds: [],
          trace: [
            {
              stepId: "task-1:browser-step:1",
              kind: "open",
              startedAt: 1,
              completedAt: 2,
              status: "ok",
              input: { url: "https://example.com/" },
            },
            {
              stepId: "task-1:browser-step:2",
              kind: "snapshot",
              startedAt: 2,
              completedAt: 3,
              status: "ok",
              input: { note: "after-open" },
            },
            {
              stepId: "task-1:browser-step:3",
              kind: "console",
              startedAt: 3,
              completedAt: 4,
              status: "ok",
              input: { probe: "page-metadata" },
            },
            {
              stepId: "task-1:browser-step:4",
              kind: "screenshot",
              startedAt: 4,
              completedAt: 5,
              status: "ok",
              input: { label: "final" },
            },
          ],
        };
      },
      async listSessions() {
        return [];
      },
      async listTargets() {
        return [];
      },
      async evictIdleSessions() {
        return [];
      },
      async openTarget() {
        throw new Error("not used");
      },
      async activateTarget() {
        throw new Error("not used");
      },
      async closeTarget() {
        throw new Error("not used");
      },
      async closeSession() {},
    };

    const handler = new BrowserWorkerHandler({
      browserBridge: bridge,
      replayRecorder,
    });

    const result = await handler.run(buildWorkerInvocationInput());
    assert.ok(result);
    const payload = result.payload as {
      quality: {
        replayPath: string | null;
        stepReport: { ok: boolean };
        resultReport: { ok: boolean };
      };
      sessionId: string;
    };

    assert.equal(payload.sessionId, "session-1");
    assert.equal(payload.quality.stepReport.ok, true);
    assert.equal(payload.quality.resultReport.ok, true);
    assert.ok(payload.quality.replayPath);

    const replay = await replayRecorder.get(payload.quality.replayPath!);
    assert.ok(replay);
    assert.equal(replay?.summary.includes("Example Domain"), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser worker handler emits runtime progress with browser session artifacts", async () => {
  const events: Array<{ phase: string; spanId?: string; subjectId?: string; browserSessionId?: string }> = [];
  const bridge: BrowserBridge = {
    async inspectPublicPage() {
      throw new Error("not used");
    },
    async spawnSession() {
      return {
        sessionId: "session-progress-1",
        targetId: "target-progress-1",
        resumeMode: "warm",
        page: {
          requestedUrl: "https://example.com/",
          finalUrl: "https://example.com/",
          title: "Example",
          textExcerpt: "Example",
          statusCode: 200,
          interactives: [],
        },
        screenshotPaths: [],
        artifactIds: [],
        trace: [],
      };
    },
    async sendSession() {
      throw new Error("not used");
    },
    async resumeSession() {
      throw new Error("not used");
    },
    async getSessionHistory() {
      return [];
    },
    async runTask() {
      throw new Error("not used");
    },
    async listSessions() {
      return [];
    },
    async listTargets() {
      return [];
    },
    async evictIdleSessions() {
      return [];
    },
    async openTarget() {
      throw new Error("not used");
    },
    async activateTarget() {
      throw new Error("not used");
    },
    async closeTarget() {
      throw new Error("not used");
    },
    async closeSession() {},
  };

  const handler = new BrowserWorkerHandler({
    browserBridge: bridge,
    runtimeProgressRecorder: {
      async record(event) {
        events.push({
          phase: event.phase,
          ...(event.spanId ? { spanId: event.spanId } : {}),
          ...(event.subjectId ? { subjectId: event.subjectId } : {}),
          browserSessionId: String(event.artifacts?.browserSessionId ?? ""),
        });
      },
    },
  });

  const result = await handler.run(buildWorkerInvocationInput());
  assert.equal(result?.status, "completed");
  assert.deepEqual(
    events.map((event) => `${event.phase}:${event.browserSessionId || "none"}`),
    ["started:none", "completed:session-progress-1"]
  );
  assert.deepEqual(
    [...new Set(events.map((event) => event.spanId))],
    ["browser:task:task-1"]
  );
  assert.deepEqual(
    [...new Set(events.map((event) => event.subjectId))],
    ["pending:task-1"]
  );
});

test("browser worker handler emits long-running heartbeat ticks while a browser session remains active", async () => {
  const phases: string[] = [];
  const bridge: BrowserBridge = {
    async inspectPublicPage() {
      throw new Error("not used");
    },
    async spawnSession() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        sessionId: "session-heartbeat-1",
        targetId: "target-heartbeat-1",
        resumeMode: "warm",
        page: {
          requestedUrl: "https://example.com/",
          finalUrl: "https://example.com/",
          title: "Example",
          textExcerpt: "Example",
          statusCode: 200,
          interactives: [],
        },
        screenshotPaths: [],
        artifactIds: [],
        trace: [],
      };
    },
    async sendSession() {
      throw new Error("not used");
    },
    async resumeSession() {
      throw new Error("not used");
    },
    async getSessionHistory() {
      return [];
    },
    async runTask() {
      throw new Error("not used");
    },
    async listSessions() {
      return [];
    },
    async listTargets() {
      return [];
    },
    async evictIdleSessions() {
      return [];
    },
    async openTarget() {
      throw new Error("not used");
    },
    async activateTarget() {
      throw new Error("not used");
    },
    async closeTarget() {
      throw new Error("not used");
    },
    async closeSession() {},
  };

  const handler = new BrowserWorkerHandler({
    browserBridge: bridge,
    heartbeatIntervalMs: 5,
    runtimeProgressRecorder: {
      async record(event) {
        phases.push(event.phase);
      },
    },
  });

  const result = await handler.run(buildWorkerInvocationInput());
  assert.equal(result?.status, "completed");
  assert.ok(phases.includes("heartbeat"));
});

test("browser worker handler ignores heartbeat recorder failures", async () => {
  const bridge: BrowserBridge = {
    async inspectPublicPage() {
      throw new Error("not used");
    },
    async spawnSession() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        sessionId: "session-heartbeat-failure",
        targetId: "target-heartbeat-failure",
        resumeMode: "warm",
        page: {
          requestedUrl: "https://example.com/",
          finalUrl: "https://example.com/",
          title: "Example",
          textExcerpt: "Example",
          statusCode: 200,
          interactives: [],
        },
        screenshotPaths: [],
        artifactIds: [],
        trace: [],
      };
    },
    async sendSession() {
      throw new Error("not used");
    },
    async resumeSession() {
      throw new Error("not used");
    },
    async getSessionHistory() {
      return [];
    },
    async runTask() {
      throw new Error("not used");
    },
    async listSessions() {
      return [];
    },
    async listTargets() {
      return [];
    },
    async evictIdleSessions() {
      return [];
    },
    async openTarget() {
      throw new Error("not used");
    },
    async activateTarget() {
      throw new Error("not used");
    },
    async closeTarget() {
      throw new Error("not used");
    },
    async closeSession() {},
  };

  const handler = new BrowserWorkerHandler({
    browserBridge: bridge,
    heartbeatIntervalMs: 5,
    runtimeProgressRecorder: {
      async record(event) {
        if (event.phase === "heartbeat") {
          throw new Error("heartbeat recorder unavailable");
        }
      },
    },
  });

  const result = await handler.run(buildWorkerInvocationInput());
  assert.equal(result?.status, "completed");
});

test("browser worker handler marks detached-session failures as reconnecting continuity", async () => {
  const events: Array<{ continuityState?: string; closeKind?: unknown; reconnectWindowUntil?: number }> = [];
  const bridge: BrowserBridge = {
    async inspectPublicPage() {
      throw new Error("not used");
    },
    async spawnSession() {
      throw new Error("browser session not found: session-detached");
    },
    async sendSession() {
      throw new Error("not used");
    },
    async resumeSession() {
      throw new Error("not used");
    },
    async getSessionHistory() {
      return [];
    },
    async runTask() {
      throw new Error("not used");
    },
    async listSessions() {
      return [];
    },
    async listTargets() {
      return [];
    },
    async evictIdleSessions() {
      return [];
    },
    async openTarget() {
      throw new Error("not used");
    },
    async activateTarget() {
      throw new Error("not used");
    },
    async closeTarget() {
      throw new Error("not used");
    },
    async closeSession() {},
  };

  const handler = new BrowserWorkerHandler({
    browserBridge: bridge,
    runtimeProgressRecorder: {
      async record(event) {
        events.push({
          ...(event.continuityState ? { continuityState: event.continuityState } : {}),
          ...(event.closeKind ? { closeKind: event.closeKind } : {}),
          ...(event.reconnectWindowUntil ? { reconnectWindowUntil: event.reconnectWindowUntil } : {}),
        });
      },
    },
  });

  const result = await handler.run(buildWorkerInvocationInput());
  assert.equal(result?.status, "failed");
  const failed = events.at(-1);
  assert.equal(failed?.continuityState, "reconnecting");
  assert.equal(failed?.closeKind, "session_not_found");
  assert.ok((failed?.reconnectWindowUntil ?? 0) > 0);
});

test("browser worker handler preserves successful task result when verification fails", async () => {
  const bridge: BrowserBridge = {
    async inspectPublicPage() {
      throw new Error("not used");
    },
    async spawnSession() {
      return {
        sessionId: "session-verify",
        page: {
          requestedUrl: "https://example.com/",
          finalUrl: "https://example.com/",
          title: "Example Domain",
          textExcerpt: "Example Domain",
          statusCode: 200,
          interactives: [],
        },
        screenshotPaths: [],
        artifactIds: [],
        trace: [
          {
            stepId: "task-1:browser-step:1",
            kind: "open",
            startedAt: 1,
            completedAt: 2,
            status: "ok",
            input: { url: "https://example.com/" },
          },
        ],
      };
    },
    async sendSession() {
      throw new Error("not used");
    },
    async resumeSession() {
      throw new Error("not used");
    },
    async getSessionHistory() {
      return [];
    },
    async runTask() {
      return {
        sessionId: "session-verify",
        page: {
          requestedUrl: "https://example.com/",
          finalUrl: "https://example.com/",
          title: "Example Domain",
          textExcerpt: "Example Domain",
          statusCode: 200,
          interactives: [],
        },
        screenshotPaths: [],
        artifactIds: [],
        trace: [
          {
            stepId: "task-1:browser-step:1",
            kind: "open",
            startedAt: 1,
            completedAt: 2,
            status: "ok",
            input: { url: "https://example.com/" },
          },
        ],
      };
    },
    async listSessions() {
      return [];
    },
    async listTargets() {
      return [];
    },
    async evictIdleSessions() {
      return [];
    },
    async openTarget() {
      throw new Error("not used");
    },
    async activateTarget() {
      throw new Error("not used");
    },
    async closeTarget() {
      throw new Error("not used");
    },
    async closeSession() {},
  };

  const handler = new BrowserWorkerHandler({
    browserBridge: bridge,
    stepVerifier: {
      verify() {
        throw new Error("step verifier exploded");
      },
    },
  });

  const result = await handler.run(buildWorkerInvocationInput());
  assert.ok(result);
  const payload = result.payload as {
    sessionId: string;
    quality: {
      stepReport: null;
      resultReport: { ok: boolean } | null;
      replayPath: string | null;
      errors?: string[];
    };
  };

  assert.equal(payload.sessionId, "session-verify");
  assert.equal(payload.quality.stepReport, null);
  assert.ok(payload.quality.errors?.some((entry) => entry.includes("step verification failed")));
});

test("browser worker handler uses browser session protocol dispatch modes", async () => {
  const calls: string[] = [];
  const bridge: BrowserBridge = {
    async inspectPublicPage() {
      throw new Error("not used");
    },
    async spawnSession() {
      calls.push("spawn");
      return buildBrowserResult("session-spawn");
    },
    async sendSession() {
      calls.push("send");
      return buildBrowserResult("session-send");
    },
    async resumeSession() {
      calls.push("resume");
      return buildBrowserResult("session-resume");
    },
    async getSessionHistory() {
      return [];
    },
    async runTask() {
      throw new Error("not used");
    },
    async listSessions() {
      return [];
    },
    async listTargets() {
      return [];
    },
    async evictIdleSessions() {
      return [];
    },
    async openTarget() {
      throw new Error("not used");
    },
    async activateTarget() {
      throw new Error("not used");
    },
    async closeTarget() {
      throw new Error("not used");
    },
    async closeSession() {},
  };

  const handler = new BrowserWorkerHandler({
    browserBridge: bridge,
  });

  await handler.run(buildWorkerInvocationInput());
  await handler.run(
    buildWorkerInvocationInput({
      packet: {
        continuityMode: "prefer-existing",
        continuationContext: {
          source: "follow_up",
          browserSession: {
            sessionId: "session-send",
            targetId: "target-1",
          },
        },
      },
    })
  );
  await handler.run(
    buildWorkerInvocationInput({
      packet: { continuityMode: "resume-existing" },
      sessionState: {
        workerRunKey: "worker:browser:task-1",
        workerType: "browser",
        status: "resumable",
        createdAt: 1,
        updatedAt: 3,
        lastResult: {
          workerType: "browser",
          status: "partial",
          summary: "paused browser result",
          payload: {
            sessionId: "session-resume",
            targetId: "target-2",
          },
        },
      },
    })
  );

  assert.deepEqual(calls, ["spawn", "send", "resume"]);
});

function buildWorkerInvocationInput(overrides?: {
  packet?: Partial<WorkerInvocationInput["packet"]>;
  sessionState?: WorkerInvocationInput["sessionState"];
}): WorkerInvocationInput {
  return {
    activation: {
      runState: {
        runKey: "role:operator:thread:1",
        threadId: "thread-1",
        roleId: "role-operator",
        mode: "group",
        status: "idle",
        iterationCount: 0,
        maxIterations: 6,
        inbox: [],
        lastActiveAt: 1,
      },
      thread: {
        threadId: "thread-1",
        teamId: "team-1",
        teamName: "Demo",
        leadRoleId: "role-lead",
        roles: [{ roleId: "role-operator", name: "Operator", seat: "member", runtime: "local", capabilities: ["browser"] }],
        participantLinks: [],
        metadataVersion: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      flow: {
        flowId: "flow-1",
        threadId: "thread-1",
        rootMessageId: "msg-root",
        mode: "serial",
        status: "running",
        currentStageIndex: 0,
        activeRoleIds: [],
        completedRoleIds: [],
        failedRoleIds: [],
        hopCount: 0,
        maxHops: 5,
        edges: [],
        createdAt: 1,
        updatedAt: 1,
      },
      handoff: {
        taskId: "task-1",
        flowId: "flow-1",
        sourceMessageId: "msg-1",
        targetRoleId: "role-operator",
        activationType: "mention",
        threadId: "thread-1",
        payload: {
          threadId: "thread-1",
          relayBrief: "",
          recentMessages: [],
          instructions: "Open https://example.com",
          dispatchPolicy: {
            allowParallel: false,
            allowReenter: true,
            sourceFlowMode: "serial",
          },
        },
        createdAt: 1,
      },
    },
    packet: {
      roleId: "role-operator",
      roleName: "Operator",
      systemPrompt: "browser operator",
      taskPrompt: "Use the browser worker for the assigned task.",
      outputContract: "Return a brief result.",
      suggestedMentions: [],
      ...(overrides?.packet ?? {}),
    },
    ...(overrides?.sessionState ? { sessionState: overrides.sessionState } : {}),
  };
}

function buildBrowserResult(sessionId: string) {
  return {
    sessionId,
    page: {
      requestedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      title: "Example Domain",
      textExcerpt: "Example Domain",
      statusCode: 200,
      interactives: [],
    },
    screenshotPaths: [],
    artifactIds: [],
    trace: [
      {
        stepId: "task-1:browser-step:1",
        kind: "snapshot" as const,
        startedAt: 1,
        completedAt: 2,
        status: "ok" as const,
        input: { note: "test" },
      },
    ],
  };
}
