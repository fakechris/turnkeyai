import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput } from "@turnkeyai/core-types/team";

import type { RolePromptPacket } from "./prompt-policy";
import {
  recordReductionBoundarySafely,
  type RequestEnvelopeReductionSnapshot,
} from "./request-envelope-reducer";

function activation(): RoleActivationInput {
  return {
    thread: { threadId: "thread-1" },
    flow: { flowId: "flow-1" },
    handoff: { taskId: "task-1" },
    runState: {
      runKey: "run-1",
      roleId: "role:researcher",
      lastDequeuedTaskId: "dispatch-task-1",
    },
  } as unknown as RoleActivationInput;
}

function packet(): RolePromptPacket {
  return {
    roleId: "role:researcher",
    roleName: "Researcher",
    seat: "member",
    systemPrompt: "system prompt",
    taskPrompt: "task prompt",
    outputContract: "answer clearly",
    suggestedMentions: [],
    promptAssembly: {
      usedArtifacts: ["artifact-from-packet"],
      assemblyFingerprint: "fingerprint-1",
      sectionOrder: ["task", "memory"],
      tokenEstimate: 1234,
      contextDiagnostics: { source: "test" },
      compactedSegments: [{ id: "segment-1", reason: "large" }],
    },
  } as unknown as RolePromptPacket;
}

test("recordReductionBoundarySafely records reduction metadata", async () => {
  const events: Array<{
    progressId: string;
    summary: string;
    recordedAt: number;
    metadata?: Record<string, unknown>;
  }> = [];
  const reduction: RequestEnvelopeReductionSnapshot = {
    level: "minimal",
    omittedSections: ["thread-summary"],
    artifactIds: ["artifact-1"],
    envelopeHint: {
      inlineAttachmentBytes: 5,
      inlineImageCount: 1,
    },
  };

  await recordReductionBoundarySafely({
    activation: activation(),
    packet: packet(),
    runtimeProgressRecorder: {
      async record(event) {
        events.push(event as (typeof events)[number]);
      },
    },
    selection: {
      modelId: "model-a",
      modelChainId: "chain-a",
    },
    reduction,
  });

  assert.equal(events.length, 1);
  assert.match(events[0]!.progressId, /^progress:prompt-reduction:task-1:minimal:/);
  assert.match(events[0]!.summary, /reduced to minimal/);
  assert.equal(typeof events[0]!.recordedAt, "number");
  assert.deepEqual(events[0]!.metadata, {
    boundaryKind: "request_envelope_reduction",
    modelId: "model-a",
    modelChainId: "chain-a",
    assemblyFingerprint: "fingerprint-1",
    sectionOrder: ["task", "memory"],
    tokenEstimate: 1234,
    contextDiagnostics: { source: "test" },
    envelopeHint: {
      inlineAttachmentBytes: 5,
      inlineImageCount: 1,
    },
    reductionLevel: "minimal",
    omittedSections: ["thread-summary"],
    compactedSegments: [{ id: "segment-1", reason: "large" }],
    usedArtifacts: ["artifact-1"],
  });
});

test("recordReductionBoundarySafely is a no-op without recorder", async () => {
  await recordReductionBoundarySafely({
    activation: activation(),
    packet: packet(),
    selection: {},
    reduction: {
      level: "compact",
      omittedSections: [],
      artifactIds: [],
    },
  });
});
