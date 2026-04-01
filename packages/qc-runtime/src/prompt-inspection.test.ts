import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeProgressEvent } from "@turnkeyai/core-types/team";

import { buildPromptConsoleReport } from "./prompt-inspection";

test("prompt inspection summarizes prompt compaction and reduction boundaries", () => {
  const report = buildPromptConsoleReport([
    {
      progressId: "progress:session-memory",
      threadId: "thread-1",
      subjectKind: "role_run",
      subjectId: "session-memory:thread-1",
      phase: "heartbeat",
      progressKind: "boundary",
      summary: "Scheduled session memory refresh.",
      recordedAt: 1,
      metadata: {
        boundaryKind: "session_memory_refresh_scheduled",
      },
    },
    {
      progressId: "progress:prompt-assembly:task-1",
      threadId: "thread-1",
      chainId: "flow:flow-1",
      spanId: "role:role-lead",
      subjectKind: "role_run",
      subjectId: "role:role-lead",
      phase: "degraded",
      progressKind: "boundary",
      summary: "Prompt assembly entered compact boundary with 2 compacted segment(s).",
      recordedAt: 20,
      flowId: "flow-1",
      taskId: "task-1",
      roleId: "role-lead",
      metadata: {
        boundaryKind: "prompt_compaction",
        modelId: "gpt-5",
        modelChainId: "reasoning_primary",
        assemblyFingerprint: "fp-1",
        sectionOrder: ["task-brief", "recent-turns", "worker-evidence"],
        compactedSegments: ["recent-turns", "worker-evidence"],
        usedArtifacts: ["artifact-1", "artifact-2"],
        tokenEstimate: {
          inputTokens: 9_000,
          outputTokensReserved: 1_200,
          totalProjectedTokens: 10_200,
          overBudget: false,
        },
        envelopeHint: {
          toolResultCount: 3,
          toolResultBytes: 1_024,
          inlineAttachmentBytes: 0,
        },
      },
    },
    {
      progressId: "progress:prompt-reduction:task-1:reference-only",
      threadId: "thread-1",
      chainId: "flow:flow-1",
      spanId: "role:role-lead",
      subjectKind: "role_run",
      subjectId: "role:role-lead",
      phase: "degraded",
      progressKind: "boundary",
      summary: "Prompt request envelope reduced to reference-only.",
      recordedAt: 30,
      flowId: "flow-1",
      taskId: "task-1",
      roleId: "role-lead",
      metadata: {
        boundaryKind: "request_envelope_reduction",
        modelId: "gpt-5",
        modelChainId: "reasoning_primary",
        assemblyFingerprint: "fp-1",
        compactedSegments: ["recent-turns"],
        omittedSections: ["recent-turns", "worker-evidence"],
        reductionLevel: "reference-only",
        tokenEstimate: {
          inputTokens: 9_000,
          outputTokensReserved: 1_200,
          totalProjectedTokens: 10_200,
          overBudget: false,
        },
      },
    },
  ]);

  assert.equal(report.totalBoundaries, 2);
  assert.equal(report.compactionCount, 1);
  assert.equal(report.reductionCount, 1);
  assert.equal(report.boundaryKindCounts.prompt_compaction, 1);
  assert.equal(report.boundaryKindCounts.request_envelope_reduction, 1);
  assert.equal(report.reductionLevelCounts["reference-only"], 1);
  assert.equal(report.modelCounts["gpt-5"], 2);
  assert.equal(report.modelChainCounts.reasoning_primary, 2);
  assert.equal(report.roleCounts["role-lead"], 2);
  assert.equal(report.compactedSegmentCounts["recent-turns"], 2);
  assert.equal(report.compactedSegmentCounts["worker-evidence"], 1);
  assert.equal(report.uniqueAssemblyFingerprintCount, 1);
  assert.equal(report.latestBoundaries[0]?.boundaryKind, "request_envelope_reduction");
  assert.deepEqual(report.latestBoundaries[0]?.omittedSections, ["recent-turns", "worker-evidence"]);
  assert.equal(report.latestBoundaries[1]?.boundaryKind, "prompt_compaction");
  assert.deepEqual(report.latestBoundaries[1]?.usedArtifacts, ["artifact-1", "artifact-2"]);
});

test("prompt inspection limits latest prompt boundaries after sorting by recency", () => {
  const events: RuntimeProgressEvent[] = [
    buildPromptBoundary("progress-1", 10, "prompt_compaction", "fp-1"),
    buildPromptBoundary("progress-2", 30, "request_envelope_reduction", "fp-2"),
    buildPromptBoundary("progress-3", 20, "prompt_compaction", "fp-3"),
  ];

  const report = buildPromptConsoleReport(events, 2);

  assert.equal(report.totalBoundaries, 3);
  assert.equal(report.latestBoundaries.length, 2);
  assert.equal(report.latestBoundaries[0]?.progressId, "progress-2");
  assert.equal(report.latestBoundaries[1]?.progressId, "progress-3");
  assert.equal(report.uniqueAssemblyFingerprintCount, 3);
});

test("prompt inspection normalizes non-finite and negative limits", () => {
  const events: RuntimeProgressEvent[] = [
    buildPromptBoundary("progress-1", 10, "prompt_compaction", "fp-1"),
    buildPromptBoundary("progress-2", 20, "prompt_compaction", "fp-2"),
  ];

  assert.equal(buildPromptConsoleReport(events, -3).latestBoundaries.length, 0);
  assert.equal(buildPromptConsoleReport(events, Number.NaN).latestBoundaries.length, 2);
});

function buildPromptBoundary(
  progressId: string,
  recordedAt: number,
  boundaryKind: "prompt_compaction" | "request_envelope_reduction",
  assemblyFingerprint: string
): RuntimeProgressEvent {
  return {
    progressId,
    threadId: "thread-1",
    subjectKind: "role_run",
    subjectId: "role:role-lead",
    phase: "degraded",
    progressKind: "boundary",
    summary: boundaryKind,
    recordedAt,
    roleId: "role-lead",
    metadata: {
      boundaryKind,
      modelId: "gpt-5",
      modelChainId: "reasoning_primary",
      assemblyFingerprint,
      compactedSegments: ["recent-turns"],
      ...(boundaryKind === "request_envelope_reduction" ? { reductionLevel: "compact" } : {}),
    },
  };
}
