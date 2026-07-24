import assert from "node:assert/strict";
import test from "node:test";

import type { RolePromptPacket } from "../prompt-policy";
import {
  buildDynamicContextSnapshot,
  prepareDynamicContext,
} from "./dynamic-context-baseline";

function packet(overrides: Partial<RolePromptPacket> = {}): RolePromptPacket {
  return {
    roleId: "role-1",
    roleName: "Lead",
    seat: "lead",
    systemPrompt: "system context",
    taskPrompt: "task context",
    outputContract: "output context",
    continuityMode: "fresh",
    suggestedMentions: [],
    ...overrides,
  };
}

function snapshot(
  overrides: {
    packet?: RolePromptPacket;
    modelId?: string;
    toolDescription?: string;
    now?: number;
  } = {},
) {
  return buildDynamicContextSnapshot({
    scope: {
      threadId: "thread-1",
      roleId: "role-1",
      flowId: "flow-1",
    },
    packet: overrides.packet ?? packet(),
    selection: { modelId: overrides.modelId ?? "model-1" },
    tools: [
      {
        name: "read",
        description: overrides.toolDescription ?? "read a file",
        inputSchema: { type: "object" },
      },
    ],
    now: overrides.now ?? 100,
  });
}

test("dynamic context sends full context without a baseline", () => {
  const current = snapshot();
  const prepared = prepareDynamicContext({
    previous: null,
    current,
  });

  assert.equal(prepared.mode, "full");
  assert.match(String(prepared.message?.content), /"mode":"full"/);
  assert.match(String(prepared.message?.content), /task context/);
});

test("dynamic context does not repeat unchanged sections", () => {
  const previous = snapshot();
  const current = snapshot({ now: 200 });
  const prepared = prepareDynamicContext({
    previous: previous.baseline,
    current,
  });

  assert.equal(prepared.mode, "unchanged");
  assert.equal(prepared.message, undefined);
});

test("dynamic context delta emits one changed section and explicit omission", () => {
  const previous = snapshot();
  const current = snapshot({
    packet: packet({
      taskPrompt: "changed task context",
      promptAssembly: {
        tokenEstimate: {
          inputTokens: 10,
          outputTokensReserved: 10,
          totalProjectedTokens: 20,
          overBudget: false,
        },
        omittedSegments: [
          { segment: "worker-evidence", reason: "budget" },
        ],
        includedSegments: ["task-brief"],
        sectionOrder: ["task-brief"],
        compactedSegments: [],
        assemblyFingerprint: "fp",
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
    }),
    now: 200,
  });
  const prepared = prepareDynamicContext({
    previous: previous.baseline,
    current,
  });
  const payload = JSON.parse(
    String(prepared.message?.content).split("\n").slice(1).join("\n"),
  ) as {
    sections: Array<{ name: string; omitted: boolean }>;
  };

  assert.equal(prepared.mode, "delta");
  assert.equal(
    payload.sections.filter((section) => section.name === "task-prompt").length,
    1,
  );
  assert.deepEqual(prepared.invalidatedSections, [
    "prompt-segment:worker-evidence",
  ]);
});

test("dynamic context forces full mode on model or tool fingerprint change", () => {
  const previous = snapshot();

  assert.equal(
    prepareDynamicContext({
      previous: previous.baseline,
      current: snapshot({ modelId: "model-2" }),
    }).reason,
    "baseline_incompatible",
  );
  assert.equal(
    prepareDynamicContext({
      previous: previous.baseline,
      current: snapshot({ toolDescription: "read a file safely" }),
    }).mode,
    "full",
  );
});

test("dynamic context forceFull overrides a matching baseline", () => {
  const current = snapshot();
  const prepared = prepareDynamicContext({
    previous: current.baseline,
    current,
    forceFull: true,
  });

  assert.equal(prepared.mode, "full");
  assert.equal(prepared.reason, "forced");
});
