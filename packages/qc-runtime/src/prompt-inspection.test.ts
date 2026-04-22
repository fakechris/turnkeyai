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
        contextDiagnostics: {
          continuity: {
            hasThreadSummary: true,
            hasSessionMemory: true,
            hasRoleScratchpad: true,
            hasContinuationContext: true,
            carriesPendingWork: true,
            carriesWaitingOn: true,
            carriesOpenQuestions: true,
            carriesDecisionOrConstraint: true,
          },
          recentTurns: {
            availableCount: 7,
            selectedCount: 5,
            packedCount: 3,
            salientEarlierCount: 1,
            compacted: true,
          },
          retrievedMemory: {
            availableCount: 6,
            selectedCount: 4,
            packedCount: 2,
            compacted: true,
            userPreferenceCount: 1,
            threadMemoryCount: 2,
            sessionMemoryCount: 1,
            knowledgeNoteCount: 1,
            journalNoteCount: 1,
          },
          workerEvidence: {
            totalCount: 4,
            admittedCount: 3,
            selectedCount: 2,
            packedCount: 1,
            compacted: true,
            promotableCount: 2,
            observationalCount: 1,
            fullCount: 1,
            summaryOnlyCount: 2,
            continuationRelevantCount: 1,
          },
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
        contextDiagnostics: {
          continuity: {
            hasThreadSummary: true,
            hasSessionMemory: true,
            hasRoleScratchpad: true,
            hasContinuationContext: false,
            carriesPendingWork: true,
            carriesWaitingOn: true,
            carriesOpenQuestions: false,
            carriesDecisionOrConstraint: true,
          },
          recentTurns: {
            availableCount: 7,
            selectedCount: 5,
            packedCount: 2,
            salientEarlierCount: 1,
            compacted: true,
          },
          retrievedMemory: {
            availableCount: 6,
            selectedCount: 4,
            packedCount: 1,
            compacted: true,
            userPreferenceCount: 1,
            threadMemoryCount: 2,
            sessionMemoryCount: 1,
            knowledgeNoteCount: 1,
            journalNoteCount: 1,
          },
          workerEvidence: {
            totalCount: 4,
            admittedCount: 3,
            selectedCount: 1,
            packedCount: 0,
            compacted: true,
            promotableCount: 2,
            observationalCount: 1,
            fullCount: 1,
            summaryOnlyCount: 2,
            continuationRelevantCount: 1,
          },
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
  assert.equal(report.totalRecentTurnsSelected, 10);
  assert.equal(report.totalRecentTurnsPacked, 5);
  assert.equal(report.totalRetrievedMemoryCandidates, 8);
  assert.equal(report.totalRetrievedMemoryPacked, 3);
  assert.equal(report.totalWorkerEvidenceCandidates, 3);
  assert.equal(report.totalWorkerEvidencePacked, 1);
  assert.equal(report.continuityCarryForwardCounts.continuationContext, 1);
  assert.equal(report.continuityCarryForwardCounts.pendingWork, 2);
  assert.equal(report.continuityCarryForwardCounts.waitingOn, 2);
  assert.equal(report.continuityCarryForwardCounts.openQuestions, 1);
  assert.equal(report.continuityCarryForwardCounts.decisionsOrConstraints, 2);
  assert.equal(report.contextRiskCounts.recent_turn_pressure, 2);
  assert.equal(report.contextRiskCounts.retrieved_memory_pressure, 2);
  assert.equal(report.contextRiskCounts.worker_evidence_pressure, 2);
  assert.equal(report.contextRiskCounts.missing_continuation_context, 1);
  assert.equal(report.contextRiskCounts.missing_open_questions, 1);
  assert.equal(report.contextRiskCounts.continuation_relevant_evidence_pressure, 1);
  assert.equal(report.latestBoundaries[0]?.boundaryKind, "request_envelope_reduction");
  assert.deepEqual(report.latestBoundaries[0]?.omittedSections, ["recent-turns", "worker-evidence"]);
  assert.deepEqual(report.latestBoundaries[0]?.contextRiskSignals, [
    "missing_continuation_context",
    "missing_open_questions",
    "recent_turn_pressure",
    "retrieved_memory_pressure",
    "worker_evidence_pressure",
    "continuation_relevant_evidence_pressure",
  ]);
  assert.equal(report.latestBoundaries[1]?.boundaryKind, "prompt_compaction");
  assert.deepEqual(report.latestBoundaries[1]?.usedArtifacts, ["artifact-1", "artifact-2"]);
  assert.deepEqual(report.latestBoundaries[1]?.contextRiskSignals, [
    "recent_turn_pressure",
    "retrieved_memory_pressure",
    "worker_evidence_pressure",
  ]);
  assert.equal(report.latestBoundaries[1]?.contextDiagnostics?.retrievedMemory.packedCount, 2);
});

test("prompt inspection flags weak observational evidence pressure without losing carry-forward", () => {
  const report = buildPromptConsoleReport([
    {
      progressId: "progress:prompt-observational-pressure",
      threadId: "thread-1",
      chainId: "flow:flow-weak-observation",
      spanId: "role:role-lead",
      subjectKind: "role_run",
      subjectId: "role:role-lead",
      phase: "degraded",
      progressKind: "boundary",
      summary: "Weak observational browser excerpts were compacted behind continuation-critical evidence.",
      recordedAt: 40,
      flowId: "flow-weak-observation",
      taskId: "task-weak-observation",
      roleId: "role-lead",
      metadata: {
        boundaryKind: "prompt_compaction",
        modelId: "gpt-5",
        modelChainId: "real_task_pressure",
        assemblyFingerprint: "fp-weak-observation",
        compactedSegments: ["worker-evidence"],
        tokenEstimate: {
          inputTokens: 82_000,
          outputTokensReserved: 8_000,
          totalProjectedTokens: 90_000,
          overBudget: true,
        },
        contextDiagnostics: {
          continuity: {
            hasThreadSummary: true,
            hasSessionMemory: true,
            hasRoleScratchpad: true,
            hasContinuationContext: true,
            carriesPendingWork: true,
            carriesWaitingOn: true,
            carriesOpenQuestions: true,
            carriesDecisionOrConstraint: true,
          },
          recentTurns: {
            availableCount: 40,
            selectedCount: 12,
            packedCount: 8,
            salientEarlierCount: 5,
            compacted: true,
          },
          retrievedMemory: {
            availableCount: 18,
            selectedCount: 9,
            packedCount: 6,
            compacted: true,
            userPreferenceCount: 2,
            threadMemoryCount: 3,
            sessionMemoryCount: 2,
            knowledgeNoteCount: 1,
            journalNoteCount: 1,
          },
          workerEvidence: {
            totalCount: 80,
            admittedCount: 52,
            selectedCount: 18,
            packedCount: 4,
            compacted: true,
            promotableCount: 3,
            observationalCount: 49,
            fullCount: 3,
            summaryOnlyCount: 49,
            continuationRelevantCount: 9,
          },
        },
      },
    },
  ]);

  assert.equal(report.totalBoundaries, 1);
  assert.equal(report.continuityCarryForwardCounts.pendingWork, 1);
  assert.equal(report.continuityCarryForwardCounts.waitingOn, 1);
  assert.equal(report.continuityCarryForwardCounts.openQuestions, 1);
  assert.equal(report.contextRiskCounts.observational_evidence_pressure, 1);
  assert.equal(report.contextRiskCounts.continuation_relevant_evidence_pressure, 1);
  assert.deepEqual(report.latestBoundaries[0]?.contextRiskSignals, [
    "recent_turn_pressure",
    "retrieved_memory_pressure",
    "worker_evidence_pressure",
    "continuation_relevant_evidence_pressure",
    "observational_evidence_pressure",
  ]);
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
          availableCount: 3,
          selectedCount: 2,
          packedCount: 2,
          salientEarlierCount: 0,
          compacted: true,
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
      ...(boundaryKind === "request_envelope_reduction" ? { reductionLevel: "compact" } : {}),
    },
  };
}
