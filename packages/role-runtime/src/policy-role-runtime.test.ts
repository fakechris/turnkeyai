import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  PermissionCacheRecord,
  PermissionCacheStore,
  ReplayRecord,
  RoleActivationInput,
  TeamEvent,
  WorkerExecutionResult,
  WorkerRuntime,
} from "@turnkeyai/core-types/team";
import { DefaultApiExecutionVerifier } from "@turnkeyai/qc-runtime/api-execution-verifier";
import { DefaultEvidenceTrustPolicy } from "@turnkeyai/qc-runtime/evidence-trust-policy";
import { FileReplayRecorder } from "@turnkeyai/qc-runtime/file-replay-recorder";
import { DefaultPermissionGovernancePolicy } from "@turnkeyai/qc-runtime/permission-governance-policy";
import { DefaultPromptAdmissionPolicy } from "@turnkeyai/qc-runtime/prompt-admission-policy";
import { FileWorkerEvidenceDigestStore } from "@turnkeyai/team-store/context/file-worker-evidence-digest-store";
import { RequestEnvelopeOverflowError } from "@turnkeyai/llm-adapter/index";

import { DefaultContextCompressor } from "./compression/context-compressor";
import type { GeneratedRoleReply, RoleResponseGenerator } from "./deterministic-response-generator";
import { PolicyRoleRuntime } from "./policy-role-runtime";
import type { RolePromptPacket, RolePromptPolicy } from "./prompt-policy";

test("policy role runtime persists worker evidence and appends worker summary to the prompt", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "policy-role-runtime-"));

  try {
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({
      rootDir: path.join(tempDir, "worker-evidence"),
    });
    const replayRecorder = new FileReplayRecorder({
      rootDir: path.join(tempDir, "replays"),
    });
    const promptPolicy: RolePromptPolicy = {
      async buildPacket(): Promise<RolePromptPacket> {
        return {
          roleId: "role-operator",
          roleName: "Operator",
          seat: "member",
          systemPrompt: "Operate carefully.",
          taskPrompt: "Open the assigned page and collect evidence.",
          outputContract: "Return a short browser-backed result.",
          suggestedMentions: ["role-lead"],
          promptAssembly: {
            tokenEstimate: {
              inputTokens: 120,
              outputTokensReserved: 800,
              totalProjectedTokens: 920,
              overBudget: false,
            },
            omittedSegments: [],
            includedSegments: ["task-brief"],
            sectionOrder: ["task-brief"],
            compactedSegments: [],
            assemblyFingerprint: "fingerprint-1",
            usedArtifacts: [],
            contextDiagnostics: {
              continuity: {
                hasThreadSummary: false,
                hasSessionMemory: false,
                hasRoleScratchpad: false,
                hasContinuationContext: false,
                carriesPendingWork: false,
                carriesWaitingOn: false,
                carriesOpenQuestions: false,
                carriesDecisionOrConstraint: false,
              },
              recentTurns: {
                availableCount: 0,
                selectedCount: 0,
                packedCount: 0,
                salientEarlierCount: 0,
                compacted: false,
              },
              retrievedMemory: {
                availableCount: 0,
                selectedCount: 0,
                packedCount: 0,
                compacted: false,
                userPreferenceCount: 0,
                threadMemoryCount: 0,
                sessionMemoryCount: 0,
                knowledgeNoteCount: 0,
                journalNoteCount: 0,
              },
              workerEvidence: {
                totalCount: 0,
                admittedCount: 0,
                selectedCount: 0,
                packedCount: 0,
                compacted: false,
                promotableCount: 0,
                observationalCount: 0,
                fullCount: 0,
                summaryOnlyCount: 0,
                continuationRelevantCount: 0,
              },
            },
          },
        };
      },
    };

    let capturedTaskPrompt: string | null = null;
    const responseGenerator: RoleResponseGenerator = {
      async generate(input): Promise<GeneratedRoleReply> {
        capturedTaskPrompt = input.packet.taskPrompt;
        return {
          content: "Browser findings returned to the lead.",
          mentions: ["role-lead"],
          metadata: {
            generator: "test",
          },
        };
      },
    };

    const workerResult: WorkerExecutionResult = {
      workerType: "browser",
      status: "partial",
      summary: "Visited the pricing page and captured the current entry offer.",
      payload: {
        artifactIds: ["artifact-browser-1"],
        trace: [
          {
            kind: "open",
            input: { url: "https://example.com/pricing" },
          },
          {
            kind: "snapshot",
          },
          {
            kind: "console",
            output: { title: "Pricing" },
          },
        ],
      },
    };
    const workerRuntime: WorkerRuntime = {
      async spawn() {
        return { workerType: "browser", workerRunKey: "worker-run-1" };
      },
      async send() {
        return workerResult;
      },
      async getState() {
        return {
          workerRunKey: "worker-run-1",
          workerType: "browser",
          status: "done",
          createdAt: 1,
          updatedAt: 2,
          lastResult: workerResult,
        };
      },
      async resume() {
        return workerResult;
      },
      async interrupt() {
        return null;
      },
      async cancel() {
        return null;
      },
      async maybeRunForRole() {
        return null;
      },
    };

    const runtime = new PolicyRoleRuntime({
      idGenerator: {
        messageId: () => "msg-operator-1",
      },
      clock: {
        now: () => 500,
      },
      promptPolicy,
      responseGenerator,
      workerRuntime,
      contextCompressor: new DefaultContextCompressor(),
      workerEvidenceDigestStore,
      replayRecorder,
    });

    const result = await runtime.runActivation(buildOperatorActivationInput());
    const assembledTaskPrompt = capturedTaskPrompt ?? "";

    assert.equal(result.status, "ok");
    assert.notEqual(capturedTaskPrompt, null);
    assert.equal(assembledTaskPrompt.includes("Worker observation (non-final):"), true);
    assert.equal(assembledTaskPrompt.includes("Visited the pricing page and captured the current entry offer."), true);
    assert.ok(result.message);
    assert.equal(result.message?.id, "msg-operator-1");
    assert.equal(result.message?.metadata?.workerUsed, true);
    assert.equal((result.message?.metadata?.workerPayload as { artifactIds: string[] }).artifactIds[0], "artifact-browser-1");
    assert.equal((result.message?.metadata?.replay as Record<string, unknown>)?.worker, "task-1:worker:worker-run-1");
    assert.equal(
      (result.message?.metadata?.replay as Record<string, unknown>)?.role,
      "task-1:role:role:role-operator:thread:thread-1"
    );
    assert.deepEqual(result.mentions, ["role-lead"]);

    const digest = await workerEvidenceDigestStore.get("worker-run-1");
    assert.ok(digest);
    assert.equal(digest?.threadId, "thread-1");
    assert.equal(digest?.workerType, "browser");
    assert.equal(digest?.status, "partial");
    assert.deepEqual(digest?.artifactIds, ["artifact-browser-1"]);
    assert.equal(digest?.traceDigest?.totalSteps, 3);
    assert.deepEqual(digest?.traceDigest?.toolChain, ["open", "snapshot", "console"]);

    const workerReplay = await replayRecorder.get("task-1:worker:worker-run-1");
    const roleReplay = await replayRecorder.get("task-1:role:role:role-operator:thread:thread-1");
    assert.equal(workerReplay?.layer, "worker");
    assert.equal(workerReplay?.status, "partial");
    assert.equal(roleReplay?.layer, "role");
    assert.equal(roleReplay?.status, "completed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("policy role runtime preserves explicit request envelope overflow errors", async () => {
  const activation = {
    thread: {
      threadId: "thread-envelope",
      teamId: "team-envelope",
      teamName: "Envelope Team",
      leadRoleId: "role-lead",
      roles: [
        {
          roleId: "role-lead",
          name: "Lead",
          seat: "lead",
          responsibilities: ["Lead the thread."],
          model: {
            provider: "anthropic",
            name: "test-model",
            temperature: 0.2,
          },
        },
        {
          roleId: "role-operator",
          name: "Operator",
          seat: "member",
          responsibilities: ["Handle execution."],
          model: {
            provider: "anthropic",
            name: "test-model",
            temperature: 0.2,
          },
        },
      ],
      participantLinks: [],
    },
    flow: {
      flowId: "flow-envelope",
      threadId: "thread-envelope",
      rootMessageId: "msg-root",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: ["role-operator"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 1,
      maxHops: 6,
      edges: [],
      shardGroups: [],
      createdAt: 1,
      updatedAt: 1,
    },
    handoff: {
      edgeId: "edge-envelope",
      flowId: "flow-envelope",
      sourceMessageId: "msg-root",
      sourceRoleId: "role-lead",
      targetRoleId: "role-operator",
      activationType: "handoff",
      createdAt: 1,
      payload: {
        instructions: "Continue the operator work.",
        relayBrief: "Continue the operator work.",
        recentMessages: [],
      },
    },
    runState: {
      runKey: "role:operator:thread:thread-envelope",
      threadId: "thread-envelope",
      roleId: "role-operator",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    },
  } as unknown as RoleActivationInput;

  const promptPolicy: RolePromptPolicy = {
    async buildPacket(): Promise<RolePromptPacket> {
      return {
        roleId: "role-operator",
        roleName: "Operator",
        seat: "member",
        systemPrompt: "Operate carefully.",
        taskPrompt: "Summarize the current case.",
        outputContract: "Return a short answer.",
        suggestedMentions: ["role-lead"],
        promptAssembly: {
          tokenEstimate: {
            inputTokens: 100,
            outputTokensReserved: 800,
            totalProjectedTokens: 900,
            overBudget: false,
          },
          omittedSegments: [],
          includedSegments: ["task-brief"],
          sectionOrder: ["task-brief"],
          compactedSegments: [],
          assemblyFingerprint: "fingerprint-envelope",
          usedArtifacts: Array.from({ length: 30 }, (_, index) => `artifact-${index + 1}`),
          contextDiagnostics: {
            continuity: {
              hasThreadSummary: false,
              hasSessionMemory: false,
              hasRoleScratchpad: false,
              hasContinuationContext: false,
              carriesPendingWork: false,
              carriesWaitingOn: false,
              carriesOpenQuestions: false,
              carriesDecisionOrConstraint: false,
            },
            recentTurns: {
              availableCount: 0,
              selectedCount: 0,
              packedCount: 0,
              salientEarlierCount: 0,
              compacted: false,
            },
            retrievedMemory: {
              availableCount: 0,
              selectedCount: 0,
              packedCount: 0,
              compacted: false,
              userPreferenceCount: 0,
              threadMemoryCount: 0,
              sessionMemoryCount: 0,
              knowledgeNoteCount: 0,
              journalNoteCount: 0,
            },
            workerEvidence: {
              totalCount: 0,
              admittedCount: 0,
              selectedCount: 0,
              packedCount: 0,
              compacted: false,
              promotableCount: 0,
              observationalCount: 0,
              fullCount: 0,
              summaryOnlyCount: 0,
              continuationRelevantCount: 0,
            },
          },
        },
      };
    },
  };

  const responseGenerator: RoleResponseGenerator = {
    async generate(): Promise<GeneratedRoleReply> {
      throw new RequestEnvelopeOverflowError({
        diagnostics: {
          messageCount: 2,
          promptChars: 121_000,
          promptBytes: 181_000,
          metadataBytes: 128,
          artifactCount: 30,
          toolCount: 0,
          toolSchemaBytes: 0,
          toolResultCount: 0,
          toolResultBytes: 0,
          inlineAttachmentBytes: 0,
          inlineImageCount: 0,
          inlineImageBytes: 0,
          inlinePdfCount: 0,
          inlinePdfBytes: 0,
          multimodalPartCount: 0,
          totalSerializedBytes: 200_000,
          overLimitKeys: ["promptChars", "promptBytes", "artifactCount"],
        },
      });
    },
  };

  const runtime = new PolicyRoleRuntime({
    idGenerator: {
      messageId: () => "msg-envelope",
    },
    clock: {
      now: () => 1,
    },
    promptPolicy,
    responseGenerator,
  });

  const result = await runtime.runActivation(activation);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "REQUEST_ENVELOPE_OVERFLOW");
  assert.equal(result.error?.retryable, false);
  const details = result.error?.details as { diagnostics?: { artifactCount?: number } } | undefined;
  assert.equal(details?.diagnostics?.artifactCount, 30);
});

test("policy role runtime stays successful when replay and event publication fail", async () => {
  const workerResult: WorkerExecutionResult = {
    workerType: "browser",
    status: "completed",
    summary: "Completed with browser evidence.",
    payload: {
      trace: [{ kind: "snapshot" }],
    },
  };

  const runtime = new PolicyRoleRuntime({
    idGenerator: {
      messageId: () => "msg-operator-observe",
    },
    clock: {
      now: () => 910,
    },
    promptPolicy: {
      async buildPacket() {
        return {
          roleId: "role-operator",
          roleName: "Operator",
          seat: "member",
          systemPrompt: "Operate carefully.",
          taskPrompt: "Continue safely.",
          outputContract: "Return a short result.",
          suggestedMentions: ["role-lead"],
        };
      },
    },
    responseGenerator: {
      async generate() {
        return {
          content: "Primary role result survives observability failures.",
          mentions: ["role-lead"],
        };
      },
    },
    workerRuntime: {
      async spawn() {
        return { workerType: "browser", workerRunKey: "worker-run-observe" };
      },
      async send() {
        return workerResult;
      },
      async getState() {
        return {
          workerRunKey: "worker-run-observe",
          workerType: "browser",
          status: "done",
          createdAt: 1,
          updatedAt: 2,
          lastResult: workerResult,
        };
      },
      async resume() {
        return workerResult;
      },
      async interrupt() {
        return null;
      },
      async cancel() {
        return null;
      },
      async maybeRunForRole() {
        return null;
      },
    },
    replayRecorder: {
      async record() {
        throw new Error("replay unavailable");
      },
      async get() {
        return null;
      },
      async list() {
        return [];
      },
    },
    teamEventBus: {
      async publish() {
        throw new Error("event bus unavailable");
      },
      async listRecent() {
        return [];
      },
      subscribe() {
        return () => {};
      },
    },
  });

  const result = await runtime.runActivation(buildOperatorActivationInput());
  assert.equal(result.status, "ok");
  assert.ok(result.message);
  assert.equal(result.message?.content, "Primary role result survives observability failures.");
});

test("policy role runtime resumes an existing worker session from role run state", async () => {
  let spawned = false;
  let resumed = false;
  let receivedSessionState: unknown = null;
  const workerResult: WorkerExecutionResult = {
    workerType: "browser",
    status: "completed",
    summary: "Reused the existing browser session.",
    payload: {
      sessionId: "browser-session-9",
      artifactIds: ["artifact-browser-9"],
      trace: [{ kind: "snapshot" }],
    },
  };

  const workerRuntime: WorkerRuntime = {
    async spawn() {
      spawned = true;
      return { workerType: "browser", workerRunKey: "worker-run-new" };
    },
    async send() {
      throw new Error("send should not be used when reusing an existing worker session");
    },
    async resume(input) {
      resumed = true;
      receivedSessionState = input.activation.runState.workerSessions;
      return workerResult;
    },
    async interrupt() {
      return null;
    },
    async cancel() {
      return null;
    },
    async getState() {
      return {
        workerRunKey: "worker-run-existing",
        workerType: "browser",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
        lastResult: {
          workerType: "browser",
          status: "completed",
          summary: "Old result",
          payload: {
            sessionId: "browser-session-9",
          },
        },
      };
    },
    async maybeRunForRole() {
      return null;
    },
  };

  const runtime = new PolicyRoleRuntime({
    idGenerator: {
      messageId: () => "msg-operator-2",
    },
    clock: {
      now: () => 700,
    },
    promptPolicy: {
      async buildPacket() {
        return {
          roleId: "role-operator",
          roleName: "Operator",
          seat: "member",
          systemPrompt: "Operate carefully.",
          taskPrompt: "Continue with the browser session.",
          outputContract: "Return a short browser-backed result.",
          suggestedMentions: ["role-lead"],
          continuityMode: "resume-existing",
        };
      },
    },
    responseGenerator: {
      async generate() {
        return {
          content: "Continued with the same worker session.",
          mentions: ["role-lead"],
        };
      },
    },
    workerRuntime,
    contextCompressor: new DefaultContextCompressor(),
    workerEvidenceDigestStore: {
      async get() {
        return null;
      },
      async put() {},
      async listByThread() {
        return [];
      },
    },
  });

  const result = await runtime.runActivation({
    ...buildOperatorActivationInput(),
    runState: {
      ...buildOperatorActivationInput().runState,
      workerSessions: {
        browser: "worker-run-existing",
      },
    },
  });

  assert.equal(spawned, false);
  assert.equal(resumed, true);
  assert.deepEqual(receivedSessionState, {
    browser: "worker-run-existing",
  });
  assert.deepEqual(result.workerBindings, [{ workerType: "browser", workerRunKey: "worker-run-existing" }]);
  assert.deepEqual(result.message?.metadata?.workerContinuation, {
    state: "resumed_existing",
    requestedMode: "resume-existing",
    requestedWorkerType: "browser",
    requestedWorkerRunKey: "worker-run-existing",
    resolvedWorkerType: "browser",
    resolvedWorkerRunKey: "worker-run-existing",
    summary: "Resumed the existing browser worker session.",
  });
});

test("policy role runtime marks missing resume-existing worker sessions as cold recreation", async () => {
  const recordedReplays: ReplayRecord[] = [];
  const workerRuntime: WorkerRuntime = {
    async spawn() {
      return { workerType: "browser", workerRunKey: "worker-run-fresh" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Started a new browser task after restart.",
        payload: { trace: [{ kind: "open" }] },
      };
    },
    async resume() {
      throw new Error("resume should not be used when the persisted worker session is missing");
    },
    async interrupt() {
      return null;
    },
    async cancel() {
      return null;
    },
    async getState(workerRunKey: string) {
      if (workerRunKey === "worker-run-missing") {
        return null;
      }
      return {
        workerRunKey,
        workerType: "browser",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async maybeRunForRole() {
      return null;
    },
  };

  const runtime = new PolicyRoleRuntime({
    idGenerator: {
      messageId: () => "msg-operator-cold",
    },
    clock: {
      now: () => 702,
    },
    promptPolicy: {
      async buildPacket() {
        return {
          roleId: "role-operator",
          roleName: "Operator",
          seat: "member",
          systemPrompt: "Operate carefully.",
          taskPrompt: "Try to continue the browser session after restart.",
          outputContract: "Return a short browser-backed result.",
          suggestedMentions: ["role-lead"],
          continuityMode: "resume-existing",
        };
      },
    },
    responseGenerator: {
      async generate() {
        return {
          content: "Work continued, but from a cold browser restart.",
          mentions: ["role-lead"],
        };
      },
    },
    workerRuntime,
    replayRecorder: {
      async record(record: ReplayRecord) {
        recordedReplays.push(record);
        return record.replayId;
      },
      async get() {
        return null;
      },
      async list() {
        return [];
      },
    },
  });

  const result = await runtime.runActivation({
    ...buildOperatorActivationInput(),
    runState: {
      ...buildOperatorActivationInput().runState,
      workerSessions: {
        browser: "worker-run-missing",
      },
    },
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.message?.metadata?.workerContinuation, {
    state: "cold_recreated",
    requestedMode: "resume-existing",
    requestedWorkerType: "browser",
    requestedWorkerRunKey: "worker-run-missing",
    resolvedWorkerType: "browser",
    resolvedWorkerRunKey: "worker-run-fresh",
    reason: "session_missing",
    summary: "Requested resume-existing but the bound worker session was missing, so work restarted cold.",
  });
  const roleReplay = recordedReplays.find((record) => record.layer === "role");
  assert.deepEqual((roleReplay?.metadata as Record<string, unknown>)?.workerContinuation, {
    state: "cold_recreated",
    requestedMode: "resume-existing",
    requestedWorkerType: "browser",
    requestedWorkerRunKey: "worker-run-missing",
    resolvedWorkerType: "browser",
    resolvedWorkerRunKey: "worker-run-fresh",
    reason: "session_missing",
    summary: "Requested resume-existing but the bound worker session was missing, so work restarted cold.",
  });
});

test("policy role runtime does not resume a worker excluded by capability inspection", async () => {
  let resumed = false;
  let spawned = false;
  const workerRuntime: WorkerRuntime = {
    async spawn() {
      spawned = true;
      return null;
    },
    async send() {
      return null;
    },
    async resume() {
      resumed = true;
      return null;
    },
    async interrupt() {
      return null;
    },
    async cancel() {
      return null;
    },
    async getState() {
      return {
        workerRunKey: "worker-run-existing",
        workerType: "browser",
        status: "running",
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async maybeRunForRole() {
      return null;
    },
  };

  const runtime = new PolicyRoleRuntime({
    idGenerator: {
      messageId: () => "msg-operator-3",
    },
    clock: {
      now: () => 701,
    },
    promptPolicy: {
      async buildPacket() {
        return {
          roleId: "role-operator",
          roleName: "Operator",
          seat: "member",
          systemPrompt: "Operate carefully.",
          taskPrompt: "Continue with the browser session.",
          outputContract: "Return a short browser-backed result.",
          suggestedMentions: ["role-lead"],
          capabilityInspection: {
            availableWorkers: [],
            connectorStates: [],
            apiStates: [],
            skillStates: [],
            transportPreferences: [],
            unavailableCapabilities: ["browser"],
            generatedAt: 1,
          },
        };
      },
    },
    responseGenerator: {
      async generate() {
        return {
          content: "No worker resumed.",
          mentions: ["role-lead"],
        };
      },
    },
    workerRuntime,
  });

  await runtime.runActivation({
    ...buildOperatorActivationInput(),
    runState: {
      ...buildOperatorActivationInput().runState,
      workerSessions: {
        browser: "worker-run-existing",
      },
    },
  });

  assert.equal(resumed, false);
  assert.equal(spawned, true);
});

test("policy role runtime prefers spawning fresh work when continuity mode is fresh", async () => {
  let resumed = false;
  let spawned = false;

  const workerRuntime: WorkerRuntime = {
    async spawn() {
      spawned = true;
      return { workerType: "browser", workerRunKey: "worker-run-fresh" };
    },
    async send() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Ran a fresh browser pass.",
        payload: {
          trace: [{ kind: "open" }],
        },
      };
    },
    async resume() {
      resumed = true;
      return null;
    },
    async interrupt() {
      return null;
    },
    async cancel() {
      return null;
    },
    async getState() {
      return {
        workerRunKey: "worker-run-existing",
        workerType: "browser",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async maybeRunForRole() {
      return null;
    },
  };

  const runtime = new PolicyRoleRuntime({
    idGenerator: {
      messageId: () => "msg-operator-fresh",
    },
    clock: {
      now: () => 702,
    },
    promptPolicy: {
      async buildPacket() {
        return {
          roleId: "role-operator",
          roleName: "Operator",
          seat: "member",
          systemPrompt: "Operate carefully.",
          taskPrompt: "Inspect the page from scratch.",
          outputContract: "Return a short browser-backed result.",
          suggestedMentions: ["role-lead"],
          continuityMode: "fresh",
        };
      },
    },
    responseGenerator: {
      async generate() {
        return {
          content: "Started fresh.",
          mentions: ["role-lead"],
        };
      },
    },
    workerRuntime,
    contextCompressor: new DefaultContextCompressor(),
    workerEvidenceDigestStore: {
      async get() {
        return null;
      },
      async put() {},
      async listByThread() {
        return [];
      },
    },
  });

  await runtime.runActivation({
    ...buildOperatorActivationInput(),
    runState: {
      ...buildOperatorActivationInput().runState,
      workerSessions: {
        browser: "worker-run-existing",
      },
    },
  });

  assert.equal(resumed, false);
  assert.equal(spawned, true);
});

test("policy role runtime attaches api diagnosis metadata from worker payload", async () => {
  const workerResult: WorkerExecutionResult = {
    workerType: "browser",
    status: "completed",
    summary: "API attempt finished.",
    payload: {
      apiAttempt: {
        apiName: "shopify-admin",
        operation: "productCreate",
        transport: "official_api",
        statusCode: 403,
        requiredScopes: ["write_products"],
        grantedScopes: [],
      },
      trace: [{ kind: "snapshot" }],
    },
  };

  const runtime = new PolicyRoleRuntime({
    idGenerator: {
      messageId: () => "msg-operator-api",
    },
    clock: {
      now: () => 900,
    },
    promptPolicy: {
      async buildPacket() {
        return {
          roleId: "role-operator",
          roleName: "Operator",
          seat: "member",
          systemPrompt: "Operate carefully.",
          taskPrompt: "Try the API flow first.",
          outputContract: "Return a short result.",
          suggestedMentions: ["role-lead"],
        };
      },
    },
    responseGenerator: {
      async generate() {
        return {
          content: "Done.",
          mentions: ["role-lead"],
        };
      },
    },
    workerRuntime: {
      async spawn() {
        return { workerType: "browser", workerRunKey: "worker-run-api" };
      },
      async send() {
        return workerResult;
      },
      async resume() {
        return workerResult;
      },
      async interrupt() {
        return null;
      },
      async cancel() {
        return null;
      },
      async getState() {
        return null;
      },
      async maybeRunForRole() {
        return null;
      },
    },
    apiExecutionVerifier: new DefaultApiExecutionVerifier(),
    contextCompressor: new DefaultContextCompressor(),
    workerEvidenceDigestStore: {
      async get() {
        return null;
      },
      async put() {},
      async listByThread() {
        return [];
      },
    },
  });

  const result = await runtime.runActivation(buildOperatorActivationInput());

  assert.equal(result.status, "ok");
  const apiDiagnosis = result.message?.metadata?.apiDiagnosis as Array<{ category: string }> | undefined;
  assert.ok(apiDiagnosis);
  assert.equal(apiDiagnosis?.[0]?.category, "scope");
});

test("policy role runtime publishes worker and audit events", async () => {
  const published: TeamEvent[] = [];
  const workerResult: WorkerExecutionResult = {
    workerType: "explore",
    status: "partial",
    summary: "Explore worker fell back to browser.",
    payload: {
      transportAudit: {
        capability: "explore",
        preferredOrder: ["official_api", "business_tool", "browser"],
        attemptedTransports: ["official_api", "browser"],
        finalTransport: "browser",
        downgraded: true,
        fallbackReason: "direct fetch returned HTTP 403",
        trustLevel: "observational",
      },
      trace: [{ kind: "open" }],
    },
  };

  const runtime = new PolicyRoleRuntime({
    idGenerator: {
      messageId: (() => {
        let seq = 0;
        return () => `event-${++seq}`;
      })(),
    },
    clock: {
      now: () => 1000,
    },
    promptPolicy: {
      async buildPacket() {
        return {
          roleId: "role-operator",
          roleName: "Operator",
          seat: "member",
          systemPrompt: "Operate carefully.",
          taskPrompt: "Research a public page.",
          outputContract: "Return a short result.",
          suggestedMentions: ["role-lead"],
        };
      },
    },
    responseGenerator: {
      async generate() {
        return {
          content: "Done.",
          mentions: ["role-lead"],
        };
      },
    },
    workerRuntime: {
      async spawn() {
        return { workerType: "explore", workerRunKey: "worker-run-explore" };
      },
      async send() {
        return workerResult;
      },
      async resume() {
        return workerResult;
      },
      async interrupt() {
        return null;
      },
      async cancel() {
        return null;
      },
      async getState() {
        return {
          workerRunKey: "worker-run-explore",
          workerType: "explore",
          status: "resumable",
          createdAt: 1,
          updatedAt: 2,
          lastResult: workerResult,
        };
      },
      async maybeRunForRole() {
        return null;
      },
    },
    teamEventBus: {
      async publish(event) {
        published.push(event);
      },
      subscribe() {
        return () => {};
      },
      async listRecent() {
        return [];
      },
    },
    contextCompressor: new DefaultContextCompressor(),
    workerEvidenceDigestStore: {
      async get() {
        return null;
      },
      async put() {},
      async listByThread() {
        return [];
      },
    },
  });

  await runtime.runActivation(buildOperatorActivationInput());

  assert.equal(published.length, 2);
  assert.equal(published[0]?.kind, "worker.updated");
  assert.equal(published[1]?.kind, "audit.logged");
  assert.equal(published[1]?.payload.permissionRequirement, "none");
  assert.equal(published[1]?.payload.transport, "browser");
  assert.equal(published[1]?.payload.trustLevel, "observational");
});

test("policy role runtime blocks denied worker results from entering prompt context", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "policy-role-runtime-governance-"));

  try {
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({
      rootDir: path.join(tempDir, "worker-evidence"),
    });
    const permissionRecords = new Map<string, PermissionCacheRecord>();
    const permissionCacheStore: PermissionCacheStore = {
      async get(cacheKey) {
        return permissionRecords.get(cacheKey) ?? null;
      },
      async put(record) {
        permissionRecords.set(record.cacheKey, record);
      },
      async listByThread(threadId) {
        return [...permissionRecords.values()].filter((record) => record.threadId === threadId);
      },
    };

    let capturedTaskPrompt = "";
    const workerResult: WorkerExecutionResult = {
      workerType: "explore",
      status: "completed",
      summary: "Fetched remote product data and prepared a write operation.",
      payload: {
        transportAudit: {
          capability: "explore",
          preferredOrder: ["official_api", "browser"],
          attemptedTransports: ["official_api"],
          finalTransport: "official_api",
          downgraded: true,
          fallbackReason: "missing scope",
          trustLevel: "observational",
        },
        apiAttempt: {
          apiName: "Shopify Admin",
          operation: "productCreate",
          transport: "official_api",
          credentialState: "present",
          requiredScopes: ["write_products"],
          grantedScopes: [],
          statusCode: 403,
          responseBody: {
            errors: [{ message: "missing scope: write_products" }],
          },
        },
        trace: [{ kind: "open" }],
      },
    };

    const runtime = new PolicyRoleRuntime({
      idGenerator: {
        messageId: (() => {
          let seq = 0;
          return () => `governance-msg-${++seq}`;
        })(),
      },
      clock: {
        now: () => 900,
      },
      promptPolicy: {
        async buildPacket() {
          return {
            roleId: "role-operator",
            roleName: "Operator",
            seat: "member",
            systemPrompt: "Operate carefully.",
            taskPrompt: "Attempt the write only if governance allows it.",
            outputContract: "Return a concise result.",
            suggestedMentions: ["role-lead"],
          };
        },
      },
      responseGenerator: {
        async generate(input) {
          capturedTaskPrompt = input.packet.taskPrompt;
          return {
            content: "Done.",
            mentions: ["role-lead"],
          };
        },
      },
      workerRuntime: {
        async spawn() {
          return { workerType: "explore", workerRunKey: "worker-run-denied" };
        },
        async send() {
          return workerResult;
        },
        async resume() {
          return workerResult;
        },
        async interrupt() {
          return null;
        },
        async cancel() {
          return null;
        },
        async getState() {
          return {
            workerRunKey: "worker-run-denied",
            workerType: "explore",
            status: "done",
            createdAt: 1,
            updatedAt: 2,
            lastResult: workerResult,
          };
        },
        async maybeRunForRole() {
          return null;
        },
      },
      apiExecutionVerifier: new DefaultApiExecutionVerifier(),
      contextCompressor: new DefaultContextCompressor(),
      workerEvidenceDigestStore,
      permissionGovernancePolicy: new DefaultPermissionGovernancePolicy(),
      evidenceTrustPolicy: new DefaultEvidenceTrustPolicy(),
      promptAdmissionPolicy: new DefaultPromptAdmissionPolicy(),
      permissionCacheStore,
    });

    const result = await runtime.runActivation(buildOperatorActivationInput());

    assert.equal(result.status, "ok");
    assert.match(capturedTaskPrompt, /Worker governance note:/);
    assert.doesNotMatch(capturedTaskPrompt, /Worker result:\nFetched remote product data/);

    const governance = result.message?.metadata?.workerGovernance as {
      permission: { decision: string };
      admission: { mode: string };
    };
    assert.equal(governance.permission.decision, "denied");
    assert.equal(governance.admission.mode, "blocked");

    const digest = await workerEvidenceDigestStore.get("worker-run-denied");
    assert.ok(digest);
    assert.equal(digest?.admissionMode, "blocked");
    assert.equal(digest?.trustLevel, "observational");
    assert.equal(digest?.sourceType, "api");
    assert.ok(permissionRecords.size > 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function buildOperatorActivationInput(): RoleActivationInput {
  return {
    runState: {
      runKey: "role:role-operator:thread:thread-1",
      threadId: "thread-1",
      roleId: "role-operator",
      mode: "group",
      status: "running",
      iterationCount: 1,
      maxIterations: 6,
      inbox: [],
      lastActiveAt: 100,
    },
    thread: {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Research Team",
      leadRoleId: "role-lead",
      roles: [
        { roleId: "role-lead", name: "Lead", seat: "lead", runtime: "local" },
        {
          roleId: "role-operator",
          name: "Operator",
          seat: "member",
          runtime: "local",
          capabilities: ["browser"],
        },
      ],
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
      activeRoleIds: ["role-operator"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 1,
      maxHops: 8,
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    },
    handoff: {
      taskId: "task-1",
      flowId: "flow-1",
      sourceMessageId: "msg-lead-1",
      sourceRoleId: "role-lead",
      targetRoleId: "role-operator",
      activationType: "mention",
      threadId: "thread-1",
      payload: {
        threadId: "thread-1",
        relayBrief: "Use the browser worker to inspect the public pricing page and return the current entry offer.",
        recentMessages: [],
        instructions: "Navigate to a public pricing page and capture the relevant result.",
        dispatchPolicy: {
          allowParallel: false,
          allowReenter: true,
          sourceFlowMode: "serial",
        },
      },
      createdAt: 2,
    },
  };
}
