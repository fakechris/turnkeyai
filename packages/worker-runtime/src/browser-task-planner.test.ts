import assert from "node:assert/strict";
import test from "node:test";

import type {
  FlowLedger,
  HandoffEnvelope,
  RolePromptPacketLike,
  RoleRunState,
  TeamThread,
  WorkerInvocationInput,
} from "@turnkeyai/core-types/team";

import { DefaultBrowserTaskPlanner } from "./browser-task-planner";

test("browser task planner builds structured plan for search and click flows", () => {
  const planner = new DefaultBrowserTaskPlanner();
  const input = buildTestInvocationInput({
    handoff: {
      payload: {
        instructions: 'Open https://www.google.com, search OpenAI, click "About", scroll and summarize what you find.',
      },
    },
  });

  const request = planner.buildRequest(input);
  assert.ok(request);
  assert.deepEqual(request.actions.map((action) => action.kind), [
    "open",
    "snapshot",
    "type",
    "snapshot",
    "scroll",
    "snapshot",
    "console",
    "screenshot",
  ]);
});

test("browser task planner keeps search and click mutually exclusive", () => {
  const planner = new DefaultBrowserTaskPlanner();
  const input = buildTestInvocationInput({
    runState: {
      runKey: "role:operator:thread:2",
      threadId: "thread-2",
    },
    thread: {
      threadId: "thread-2",
      teamId: "team-2",
    },
    flow: {
      flowId: "flow-2",
      threadId: "thread-2",
    },
    handoff: {
      taskId: "task-2",
      flowId: "flow-2",
      sourceMessageId: "msg-2",
      threadId: "thread-2",
      payload: {
        threadId: "thread-2",
        instructions: 'Open https://www.google.com, search for cats and click "Show more".',
      },
    },
  });

  const request = planner.buildRequest(input);
  assert.ok(request);
  assert.equal(request.actions.some((action) => action.kind === "click"), false);
});

test("browser task planner strips trailing punctuation from URLs", () => {
  const planner = new DefaultBrowserTaskPlanner();
  const input = buildTestInvocationInput({
    handoff: {
      payload: {
        instructions: 'Open "https://example.com;" and summarize what you find.',
      },
    },
  });

  const request = planner.buildRequest(input);
  assert.ok(request);
  assert.equal(request.actions[0]?.kind, "open");
  if (request.actions[0]?.kind === "open") {
    assert.equal(request.actions[0].url, "https://example.com/");
  }
});

test("browser task planner reuses the previous browser session when available", () => {
  const planner = new DefaultBrowserTaskPlanner();
  const input = buildTestInvocationInput({
    handoff: {
      payload: {
        instructions: "Open https://example.com and summarize what you find.",
      },
    },
  });
  input.sessionState = {
    workerRunKey: "worker:browser:task:1",
    workerType: "browser",
    status: "resumable",
    createdAt: 1,
    updatedAt: 2,
    currentTaskId: "task-previous",
    lastResult: {
      workerType: "browser",
      status: "partial",
      summary: "Session kept open.",
      payload: {
        sessionId: "browser-session-123",
        targetId: "target-123",
      },
    },
  };

  const request = planner.buildRequest(input);
  assert.equal(request?.browserSessionId, "browser-session-123");
  assert.equal(request?.targetId, "target-123");
});

test("browser task planner does not reuse non-resumable browser sessions", () => {
  const planner = new DefaultBrowserTaskPlanner();
  const input = buildTestInvocationInput();
  input.sessionState = {
    workerRunKey: "worker:browser:task:2",
    workerType: "browser",
    status: "done",
    createdAt: 1,
    updatedAt: 2,
    lastResult: {
      workerType: "browser",
      status: "completed",
      summary: "Already finished.",
      payload: {
        sessionId: "browser-session-stale",
      },
    },
  };

  const request = planner.buildRequest(input);
  assert.equal(request?.browserSessionId, undefined);
});

test("browser task planner reuses done browser sessions when continuity mode explicitly resumes", () => {
  const planner = new DefaultBrowserTaskPlanner();
  const input = buildTestInvocationInput({
    packet: {
      continuityMode: "resume-existing",
    },
  });
  input.sessionState = {
    workerRunKey: "worker:browser:task:4",
    workerType: "browser",
    status: "done",
    createdAt: 1,
    updatedAt: 2,
    lastResult: {
      workerType: "browser",
      status: "completed",
      summary: "Completed with browser session retained.",
      payload: {
        sessionId: "browser-session-done",
        targetId: "target-done",
      },
    },
  };

  const request = planner.buildRequest(input);
  assert.equal(request?.browserSessionId, "browser-session-done");
  assert.equal(request?.targetId, "target-done");
});

test("browser task planner can recover browser session hints from continuation context", () => {
  const planner = new DefaultBrowserTaskPlanner();
  const input = buildTestInvocationInput({
    packet: {
      continuityMode: "resume-existing",
      continuationContext: {
        source: "scheduled_reentry",
        workerType: "browser",
        workerRunKey: "worker:browser:task:5",
        browserSession: {
          sessionId: "browser-session-continuation",
          targetId: "target-continuation",
          resumeMode: "warm",
          ownerType: "thread",
          ownerId: "thread-1",
          leaseHolderRunKey: "worker:browser:task:5",
        },
      },
    },
    handoff: {
      payload: {
        instructions: "Continue on the current page and summarize what changed.",
      },
    },
  });

  const request = planner.buildRequest(input);
  assert.equal(request?.browserSessionId, "browser-session-continuation");
  assert.equal(request?.targetId, "target-continuation");
  assert.equal(request?.ownerType, "thread");
  assert.equal(request?.leaseHolderRunKey, "worker:browser:task:5");
});

test("browser task planner can continue on the current target without an explicit URL", () => {
  const planner = new DefaultBrowserTaskPlanner();
  const input = buildTestInvocationInput({
    handoff: {
      payload: {
        instructions: "Continue on the current page, scroll down, extract metadata, and take a screenshot.",
      },
    },
  });
  input.sessionState = {
    workerRunKey: "worker:browser:task:3",
    workerType: "browser",
    status: "resumable",
    createdAt: 1,
    updatedAt: 2,
    currentTaskId: "task-previous",
    lastResult: {
      workerType: "browser",
      status: "partial",
      summary: "Session kept open.",
      payload: {
        sessionId: "browser-session-continue",
        targetId: "target-continue",
      },
    },
  };

  const request = planner.buildRequest(input);
  assert.ok(request);
  assert.equal(request?.browserSessionId, "browser-session-continue");
  assert.equal(request?.targetId, "target-continue");
  assert.deepEqual(request?.actions.map((action) => action.kind), ["snapshot", "scroll", "snapshot", "console", "screenshot"]);
});

function buildTestInvocationInput(overrides?: {
  runState?: Partial<RoleRunState>;
  thread?: Partial<TeamThread>;
  flow?: Partial<FlowLedger>;
  handoff?: Partial<Omit<HandoffEnvelope, "payload">> & {
    payload?: Partial<HandoffEnvelope["payload"]>;
  };
  packet?: Partial<RolePromptPacketLike>;
}): WorkerInvocationInput {
  const handoffOverrides = overrides?.handoff;
  const handoffPayloadOverrides = handoffOverrides?.payload;
  const handoffRestOverrides = handoffOverrides
    ? Object.fromEntries(Object.entries(handoffOverrides).filter(([key]) => key !== "payload"))
    : {};

  const runState: RoleRunState = {
    runKey: "role:operator:thread:1",
    threadId: "thread-1",
    roleId: "role-operator",
    mode: "group",
    status: "idle",
    iterationCount: 0,
    maxIterations: 6,
    inbox: [],
    lastActiveAt: 1,
    ...(overrides?.runState ?? {}),
  };

  const thread: TeamThread = {
    threadId: "thread-1",
    teamId: "team-1",
    teamName: "Demo",
    leadRoleId: "role-lead",
    roles: [{ roleId: "role-operator", name: "Operator", seat: "member", runtime: "local", capabilities: ["browser"] }],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    ...(overrides?.thread ?? {}),
  };

  const flow: FlowLedger = {
    flowId: "flow-1",
    threadId: runState.threadId,
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
    ...(overrides?.flow ?? {}),
  };

  const handoff: HandoffEnvelope = {
    taskId: "task-1",
    flowId: flow.flowId,
    sourceMessageId: "msg-1",
    targetRoleId: runState.roleId,
    activationType: "mention",
    threadId: runState.threadId,
    payload: {
      threadId: runState.threadId,
      relayBrief: "",
      recentMessages: [],
      instructions: "",
      dispatchPolicy: {
        allowParallel: false,
        allowReenter: true,
        sourceFlowMode: "serial",
      },
      ...(handoffPayloadOverrides ?? {}),
    },
    createdAt: 1,
    ...handoffRestOverrides,
  };

  const packet: RolePromptPacketLike = {
    roleId: runState.roleId,
    roleName: "Operator",
    systemPrompt: "browser operator",
    taskPrompt: "Use the browser worker for the assigned task.",
    outputContract: "Return a brief result.",
    suggestedMentions: [],
    ...(overrides?.packet ?? {}),
  };

  return {
    activation: {
      runState,
      thread,
      flow,
      handoff,
    },
    packet,
  };
}
