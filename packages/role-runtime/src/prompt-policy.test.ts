import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeRelayPayload,
  type DispatchContinuationContext,
  type DispatchPolicy,
  type FanOutMergeContext,
  type ParallelOrchestrationContext,
  type RoleActivationInput,
  type TeamMessageSummary,
  type WorkerKind,
} from "@turnkeyai/core-types/team";
import { FileRoleScratchpadStore } from "@turnkeyai/team-store/context/file-role-scratchpad-store";
import { FileThreadJournalStore } from "@turnkeyai/team-store/context/file-thread-journal-store";
import { FileThreadMemoryStore } from "@turnkeyai/team-store/context/file-thread-memory-store";
import { FileThreadSessionMemoryStore } from "@turnkeyai/team-store/context/file-thread-session-memory-store";
import { FileThreadSummaryStore } from "@turnkeyai/team-store/context/file-thread-summary-store";
import { FileWorkerEvidenceDigestStore } from "@turnkeyai/team-store/context/file-worker-evidence-digest-store";

import { DefaultContextBudgeter } from "./context/context-budgeter";
import { DefaultRoleMemoryResolver } from "./context/role-memory-resolver";
import { DefaultPromptAssembler } from "./prompt/prompt-assembler";
import { DefaultRolePromptPolicy } from "./prompt-policy";
import { DefaultRoleProfileRegistry } from "./role-profile";
import { DefaultCapabilityDiscoveryService } from "@turnkeyai/worker-runtime/capability-discovery-service";

test("default role prompt policy assembles context from thread and worker stores", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompt-policy-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadJournalStore = new FileThreadJournalStore({
      rootDir: path.join(tempDir, "thread-journal"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({
      rootDir: path.join(tempDir, "worker-evidence"),
    });

    await threadSummaryStore.put({
      threadId: "thread-1",
      summaryVersion: 2,
      updatedAt: 100,
      sourceMessageCount: 4,
      userGoal: "Compare two API vendors for a launch decision.",
      stableFacts: ["Need a concise executive recommendation.", "Time horizon is one month."],
      decisions: ["Need browser-backed facts before deciding."],
      openQuestions: ["Which vendor has the better entry price?"],
    });
    await threadMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 99,
      preferences: ["Prefer concise executive recommendations."],
      constraints: ["Budget must stay under $500."],
      longTermNotes: [],
    });
    await threadJournalStore.put({
      threadId: "thread-1",
      dateKey: "2026-03-29",
      updatedAt: 100,
      entries: ["[Chris] For today, prioritize Node.js over Python."],
    });
    await roleScratchpadStore.put({
      threadId: "thread-1",
      roleId: "role-finance",
      updatedAt: 101,
      sourceMessageCount: 3,
      completedWork: ["Captured pricing constraints."],
      pendingWork: ["Estimate first-month cost."],
      waitingOn: "Official pricing page",
      evidenceRefs: ["artifact-scratchpad-1"],
    });
    await workerEvidenceDigestStore.put({
      workerRunKey: "worker-1",
      threadId: "thread-1",
      workerType: "browser",
      status: "completed",
      updatedAt: 102,
      findings: ["Visited a public pricing page.", "Confirmed a published entry plan."],
      artifactIds: ["artifact-browser-1"],
      traceDigest: {
        totalSteps: 3,
        toolChain: ["open", "snapshot", "console"],
        lastStep: "console",
      },
    });
    await workerEvidenceDigestStore.put({
      workerRunKey: "worker-other-thread",
      threadId: "thread-2",
      workerType: "browser",
      status: "completed",
      updatedAt: 103,
      findings: ["Should not be injected into another thread."],
      artifactIds: ["artifact-browser-ignored"],
    });

    const contextBudgeter = new DefaultContextBudgeter();
    const roleMemoryResolver = new DefaultRoleMemoryResolver({
      threadSummaryStore,
      threadMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      workerEvidenceDigestStore,
    });
    const promptAssembler = new DefaultPromptAssembler({
      estimateTokens: (input, reservedOutputTokens, maxInputTokens) =>
        contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens),
    });
    const policy = new DefaultRolePromptPolicy({
      roleProfileRegistry: new DefaultRoleProfileRegistry(),
      contextBudgeter,
      roleMemoryResolver,
      promptAssembler,
    });

    const packet = await policy.buildPacket(buildFinanceActivationInput());

    assert.equal(packet.roleId, "role-finance");
    assert.equal(packet.seat, "member");
    assert.deepEqual(packet.suggestedMentions, ["role-lead"]);
    assert.match(packet.systemPrompt, /You are Financial Expert, a specialist role/);
    assert.match(packet.systemPrompt, /Seat: member/);
    assert.match(packet.taskPrompt, /Task brief:/);
    assert.match(packet.taskPrompt, /Compare OpenAI and Anthropic launch costs/);
    assert.match(packet.taskPrompt, /Thread summary:/);
    assert.match(packet.taskPrompt, /Role scratchpad:/);
    assert.match(packet.taskPrompt, /Worker evidence:/);
    assert.match(packet.taskPrompt, /Retrieved memory:/);
    assert.match(packet.taskPrompt, /Decisions: Need browser-backed facts before deciding/);
    assert.match(packet.taskPrompt, /Open questions: Which vendor has the better entry price/);
    assert.match(packet.taskPrompt, /Visited a public pricing page/);
    assert.doesNotMatch(packet.taskPrompt, /Should not be injected/);
    assert.ok(packet.promptAssembly);
    assert.equal(packet.promptAssembly?.tokenEstimate.overBudget, false);
    assert.deepEqual(packet.promptAssembly?.usedArtifacts.sort(), ["artifact-browser-1", "artifact-scratchpad-1"]);
    assert.equal(packet.promptAssembly?.omittedSegments.some((segment) => segment.segment === "retrieved-memory"), false);
    assert.deepEqual(packet.promptAssembly?.sectionOrder, [
      "task-brief",
      "thread-summary",
      "role-scratchpad",
      "retrieved-memory",
      "worker-evidence",
      "recent-turns",
    ]);
    assert.equal(packet.promptAssembly?.contextDiagnostics.continuity.hasThreadSummary, true);
    assert.equal(packet.promptAssembly?.contextDiagnostics.continuity.hasRoleScratchpad, true);
    assert.equal(packet.promptAssembly?.contextDiagnostics.continuity.sourceHasOpenQuestions, true);
    assert.equal(packet.promptAssembly?.contextDiagnostics.continuity.sourceHasDecisionOrConstraint, true);
    assert.equal(packet.promptAssembly?.contextDiagnostics.continuity.sourceHasPendingWork, true);
    assert.equal(packet.promptAssembly?.contextDiagnostics.continuity.sourceHasWaitingOn, true);
    assert.equal(packet.promptAssembly?.contextDiagnostics.continuity.carriesOpenQuestions, true);
    assert.equal(packet.promptAssembly?.contextDiagnostics.continuity.carriesDecisionOrConstraint, true);
    assert.equal(packet.promptAssembly?.contextDiagnostics.continuity.carriesPendingWork, true);
    assert.equal(packet.promptAssembly?.contextDiagnostics.continuity.carriesWaitingOn, true);
    assert.equal(packet.promptAssembly?.contextDiagnostics.retrievedMemory.selectedCount, 2);
    assert.equal(packet.promptAssembly?.contextDiagnostics.workerEvidence.selectedCount, 1);
    assert.equal(packet.promptAssembly?.contextDiagnostics.workerEvidence.packedCount, 1);
    assert.equal(typeof packet.promptAssembly?.assemblyFingerprint, "string");
    assert.equal(packet.promptAssembly?.assemblyFingerprint.length, 40);
    assert.equal(packet.continuityMode, "fresh");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("default role prompt policy can retrieve thread memory when the query matches stored preferences", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompt-policy-memory-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadJournalStore = new FileThreadJournalStore({
      rootDir: path.join(tempDir, "thread-journal"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({
      rootDir: path.join(tempDir, "worker-evidence"),
    });

    await threadMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 1,
      preferences: ["Prefer concise executive recommendations."],
      constraints: [],
      longTermNotes: [],
    });

    const policy = new DefaultRolePromptPolicy({
      roleProfileRegistry: new DefaultRoleProfileRegistry(),
      roleMemoryResolver: new DefaultRoleMemoryResolver({
        threadSummaryStore,
        threadMemoryStore,
        threadJournalStore,
        roleScratchpadStore,
        workerEvidenceDigestStore,
      }),
    });

    const packet = await policy.buildPacket({
      ...buildFinanceActivationInput(),
      handoff: {
        ...buildFinanceActivationInput().handoff,
        payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
          relayBrief: "Before answering, remember my preference for concise recommendations.",
        }),
      },
    });

    assert.match(packet.taskPrompt, /Retrieved memory:/);
    assert.match(packet.taskPrompt, /Prefer concise executive recommendations/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("default role prompt policy keeps a deterministic section order when session memory is included", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompt-policy-session-memory-order-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadSessionMemoryStore = new FileThreadSessionMemoryStore({
      rootDir: path.join(tempDir, "thread-session-memory"),
    });
    const threadJournalStore = new FileThreadJournalStore({
      rootDir: path.join(tempDir, "thread-journal"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({
      rootDir: path.join(tempDir, "worker-evidence"),
    });

    await threadSummaryStore.put({
      threadId: "thread-1",
      summaryVersion: 1,
      updatedAt: 10,
      sourceMessageCount: 3,
      userGoal: "Continue the supplier review.",
      stableFacts: ["Need a concise status summary."],
      decisions: [],
      openQuestions: [],
    });
    await threadSessionMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 11,
      activeTasks: ["Resume the browser-backed supplier comparison."],
      openQuestions: ["Which supplier is still waiting on approval?"],
      recentDecisions: [],
      constraints: [],
      continuityNotes: ["Pick up from the last checkpoint before writing the summary."],
      latestJournalEntries: [],
    });
    await roleScratchpadStore.put({
      threadId: "thread-1",
      roleId: "role-finance",
      updatedAt: 12,
      sourceMessageCount: 2,
      completedWork: ["Captured the current shortlist."],
      pendingWork: ["Finish the recommendation draft."],
      waitingOn: "Approval signal",
      evidenceRefs: [],
    });

    const policy = new DefaultRolePromptPolicy({
      roleProfileRegistry: new DefaultRoleProfileRegistry(),
      roleMemoryResolver: new DefaultRoleMemoryResolver({
        threadSummaryStore,
        threadMemoryStore,
        threadSessionMemoryStore,
        threadJournalStore,
        roleScratchpadStore,
        workerEvidenceDigestStore,
      }),
    });

    const packet = await policy.buildPacket({
      ...buildFinanceActivationInput(),
      handoff: {
        ...buildFinanceActivationInput().handoff,
        payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
          instructions: "Continue the same task and tell me what is pending or waiting next.",
        }),
      },
    });

    assert.match(packet.taskPrompt, /Session memory:/);
    assert.deepEqual(packet.promptAssembly?.sectionOrder, [
      "task-brief",
      "thread-summary",
      "session-memory",
      "role-scratchpad",
      "retrieved-memory",
      "recent-turns",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("default role prompt policy preserves session memory continuity under tight budgets", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompt-policy-session-memory-budget-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadSessionMemoryStore = new FileThreadSessionMemoryStore({
      rootDir: path.join(tempDir, "thread-session-memory"),
    });
    const threadJournalStore = new FileThreadJournalStore({
      rootDir: path.join(tempDir, "thread-journal"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({
      rootDir: path.join(tempDir, "worker-evidence"),
    });

    await threadSummaryStore.put({
      threadId: "thread-1",
      summaryVersion: 1,
      updatedAt: 10,
      sourceMessageCount: 8,
      userGoal: "Continue the vendor review without losing the unresolved follow-up.",
      stableFacts: ["Need a concise status summary."],
      decisions: [],
      openQuestions: ["Which supplier is still waiting on approval?"],
    });
    await threadSessionMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 11,
      activeTasks: ["Resume the browser-backed supplier comparison."],
      openQuestions: ["Which supplier is still waiting on approval?"],
      recentDecisions: ["Keep the browser evidence attached to the pricing review."],
      constraints: ["Budget must stay under $500."],
      continuityNotes: ["Follow up with the browser pricing snapshot before finalizing."],
      latestJournalEntries: ["[Chris] Keep the unresolved browser follow-up visible."],
    });
    await roleScratchpadStore.put({
      threadId: "thread-1",
      roleId: "role-finance",
      updatedAt: 12,
      sourceMessageCount: 4,
      completedWork: ["Captured the current shortlist."],
      pendingWork: ["Finish the recommendation draft."],
      waitingOn: "Approval signal",
      evidenceRefs: [],
    });
    await workerEvidenceDigestStore.put({
      workerRunKey: "worker-budget-1",
      threadId: "thread-1",
      workerType: "browser",
      status: "partial",
      updatedAt: 13,
      findings: [
        "Visited the supplier pricing page and captured the unresolved approval banner.",
        "Browser evidence is still needed before final sign-off.",
      ],
      artifactIds: ["artifact-browser-budget-1"],
      trustLevel: "observational",
      admissionMode: "summary_only",
      sourceType: "tool",
    });

    const contextBudgeter = new DefaultContextBudgeter();
    const promptAssembler = new DefaultPromptAssembler({
      estimateTokens: (input, reservedOutputTokens, maxInputTokens) =>
        contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens),
      maxRecentTurns: 6,
      maxWorkerEvidence: 2,
    });
    const policy = new DefaultRolePromptPolicy({
      roleProfileRegistry: new DefaultRoleProfileRegistry(),
      contextBudgeter: {
        async allocate(input) {
          const budget = await contextBudgeter.allocate(input);
          return {
            ...budget,
            totalBudget: 180,
            reservedOutputTokens: 20,
            compressedMemoryBudget: 80,
            workerEvidenceBudget: 18,
            recentTurnsBudget: 18,
          };
        },
        async estimate(input, reservedOutputTokens, maxInputTokens) {
          return contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens);
        },
      },
      roleMemoryResolver: new DefaultRoleMemoryResolver({
        threadSummaryStore,
        threadMemoryStore,
        threadSessionMemoryStore,
        threadJournalStore,
        roleScratchpadStore,
        workerEvidenceDigestStore,
      }),
      promptAssembler,
      reservedOutputTokens: 20,
    });

    const activation = buildFinanceActivationInput();
    const packet = await policy.buildPacket({
      ...activation,
      handoff: {
        ...activation.handoff,
        payload: withRelayPayloadOverrides(activation.handoff.payload, {
          relayBrief:
            "Continue the same supplier review, keep the unresolved browser follow-up visible, and tell me what is still waiting next. "
              .repeat(6)
              .trim(),
          recentMessages: [
            {
              messageId: "m1",
              role: "user",
              name: "Chris",
              content: "Noise turn one.",
              createdAt: 1,
            },
            {
              messageId: "m2",
              role: "assistant",
              name: "Lead",
              content: "Noise turn two.",
              createdAt: 2,
            },
            {
              messageId: "m3",
              role: "assistant",
              name: "Lead",
              content: "Noise turn three.",
              createdAt: 3,
            },
            {
              messageId: "m4",
              role: "assistant",
              name: "Lead",
              content: "Noise turn four.",
              createdAt: 4,
            },
            {
              messageId: "m5",
              role: "assistant",
              name: "Lead",
              content: "Noise turn five.",
              createdAt: 5,
            },
            {
              messageId: "m6",
              role: "assistant",
              name: "Lead",
              content: "Noise turn six.",
              createdAt: 6,
            },
          ],
        }),
      },
    });

    assert.match(packet.taskPrompt, /Execution continuity:/);
    assert.match(packet.taskPrompt, /Active tasks: Resume the browser-backed supplier comparison/);
    assert.match(packet.taskPrompt, /Recent decisions: Keep the browser evidence attached to the pricing review/);
    assert.match(packet.taskPrompt, /Which supplier is still waiting on approval/);
    assert.match(packet.taskPrompt, /Follow up with the browser pricing snapshot before finalizing/);
    assert.match(packet.taskPrompt, /Constraints: Budget must stay under \$500/);
    assert.match(packet.taskPrompt, /Keep the unresolved browser follow-up visible/);
    assert.ok(
      packet.promptAssembly?.omittedSegments.some((segment) => segment.segment === "recent-turns") ||
        packet.promptAssembly?.compactedSegments.includes("recent-turns")
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("default role prompt policy trims lower-priority prompt sections when over budget", async () => {
  const contextBudgeter = new DefaultContextBudgeter();
  const roleMemoryResolver = new DefaultRoleMemoryResolver({
    threadSummaryStore: { async get() { return null; }, async put() {} },
    threadMemoryStore: { async get() { return null; }, async put() {} },
    threadJournalStore: { async get() { return null; }, async put() {}, async listByThread() { return []; } },
    roleScratchpadStore: { async get() { return null; }, async put() {} },
    workerEvidenceDigestStore: { async get() { return null; }, async put() {}, async listByThread() { return []; } },
  });
  const promptAssembler = new DefaultPromptAssembler({
    estimateTokens: (input, reservedOutputTokens, maxInputTokens) =>
      contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens),
  });
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
    contextBudgeter: {
      async allocate(input) {
        const budget = await contextBudgeter.allocate(input);
        return {
          ...budget,
          totalBudget: 90,
          reservedOutputTokens: 20,
        };
      },
      async estimate(input, reservedOutputTokens, maxInputTokens) {
        return contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens);
      },
    },
    roleMemoryResolver,
    promptAssembler,
    reservedOutputTokens: 20,
  });

  const packet = await policy.buildPacket({
    ...buildFinanceActivationInput(),
    handoff: {
      ...buildFinanceActivationInput().handoff,
      payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
        relayBrief:
          "Compare OpenAI and Anthropic launch costs and return only the finance delta. ".repeat(10).trim(),
      }),
    },
  });

  assert.ok(packet.promptAssembly);
  assert.ok(packet.promptAssembly?.omittedSegments.some((segment) => segment.reason === "budget"));
  assert.doesNotMatch(packet.taskPrompt, /Recent turns:/);
});

test("default role prompt policy compacts evidence before dropping the section entirely", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompt-policy-compaction-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadJournalStore = new FileThreadJournalStore({
      rootDir: path.join(tempDir, "thread-journal"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({
      rootDir: path.join(tempDir, "worker-evidence"),
    });

    await workerEvidenceDigestStore.put({
      workerRunKey: "worker-1",
      threadId: "thread-1",
      workerType: "browser",
      status: "completed",
      updatedAt: 102,
      findings: ["Visited a public pricing page.", "Confirmed a published entry plan."],
      artifactIds: ["artifact-browser-1"],
      trustLevel: "promotable",
      admissionMode: "full",
      sourceType: "api",
    });
    await workerEvidenceDigestStore.put({
      workerRunKey: "worker-2",
      threadId: "thread-1",
      workerType: "explore",
      status: "completed",
      updatedAt: 103,
      findings: ["Compared two provider pricing documents.", "Captured SKU-level differences."],
      artifactIds: ["artifact-browser-2"],
      trustLevel: "promotable",
      admissionMode: "summary_only",
      sourceType: "tool",
    });

    const contextBudgeter = new DefaultContextBudgeter();
    const promptAssembler = new DefaultPromptAssembler({
      estimateTokens: (input, reservedOutputTokens, maxInputTokens) =>
        contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens),
      maxWorkerEvidence: 2,
    });
    const policy = new DefaultRolePromptPolicy({
      roleProfileRegistry: new DefaultRoleProfileRegistry(),
      contextBudgeter: {
        async allocate(input) {
          const budget = await contextBudgeter.allocate(input);
          return {
            ...budget,
            totalBudget: 170,
            reservedOutputTokens: 20,
            workerEvidenceBudget: 40,
            recentTurnsBudget: 18,
          };
        },
        async estimate(input, reservedOutputTokens, maxInputTokens) {
          return contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens);
        },
      },
      roleMemoryResolver: new DefaultRoleMemoryResolver({
        threadSummaryStore,
        threadMemoryStore,
        threadJournalStore,
        roleScratchpadStore,
        workerEvidenceDigestStore,
      }),
      promptAssembler,
      reservedOutputTokens: 20,
    });

    const packet = await policy.buildPacket(buildFinanceActivationInput());

    assert.match(packet.taskPrompt, /Worker evidence:/);
    assert.match(packet.taskPrompt, /\[compacted\]/);
    assert.match(packet.taskPrompt, /browser \[api \/ promotable \/ full\]:/);
    assert.equal(packet.promptAssembly?.omittedSegments.some((segment) => segment.segment === "worker-evidence"), false);
    assert.equal(packet.promptAssembly?.includedSegments.includes("worker-evidence"), true);
    assert.equal(packet.promptAssembly?.compactedSegments.includes("worker-evidence"), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("default role prompt policy keeps widened explicit recall memory hits with the default assembler", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompt-policy-explicit-recall-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadJournalStore = new FileThreadJournalStore({
      rootDir: path.join(tempDir, "thread-journal"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({
      rootDir: path.join(tempDir, "worker-evidence"),
    });

    await threadMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 1,
      preferences: [
        "Preference pricing-1 should stay visible.",
        "Preference pricing-2 should stay visible.",
        "Preference pricing-3 should stay visible.",
        "Preference pricing-4 should stay visible.",
        "Preference pricing-5 should stay visible.",
        "Preference pricing-6 should stay visible.",
      ],
      constraints: [],
      longTermNotes: [],
    });

    const policy = new DefaultRolePromptPolicy({
      roleProfileRegistry: new DefaultRoleProfileRegistry(),
      contextBudgeter: {
        async allocate(input) {
          const budget = await new DefaultContextBudgeter().allocate(input);
          return {
            ...budget,
            totalBudget: 800,
            reservedOutputTokens: 20,
            compressedMemoryBudget: 600,
          };
        },
        async estimate(input, reservedOutputTokens, maxInputTokens) {
          return new DefaultContextBudgeter().estimate(input, reservedOutputTokens, maxInputTokens);
        },
      },
      roleMemoryResolver: new DefaultRoleMemoryResolver({
        threadSummaryStore,
        threadMemoryStore,
        threadJournalStore,
        roleScratchpadStore,
        workerEvidenceDigestStore,
      }),
    });

    const packet = await policy.buildPacket({
      ...buildFinanceActivationInput(),
      handoff: {
        ...buildFinanceActivationInput().handoff,
        payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
          relayBrief:
            "Recall preference pricing-1, preference pricing-2, preference pricing-3, preference pricing-4, preference pricing-5, and preference pricing-6 before continuing.",
        }),
      },
    });

    assert.match(packet.taskPrompt, /Preference pricing-1 should stay visible/);
    assert.match(packet.taskPrompt, /Preference pricing-6 should stay visible/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("default role prompt policy keeps constraint memory ahead of journal recap under retrieved-memory compaction", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompt-policy-retrieved-memory-compaction-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadJournalStore = new FileThreadJournalStore({
      rootDir: path.join(tempDir, "thread-journal"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({
      rootDir: path.join(tempDir, "worker-evidence"),
    });

    await threadMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 10,
      preferences: ["Prefer concise recommendations."],
      constraints: ["Budget must stay under $500."],
      longTermNotes: ["Keep the supplier shortlist aligned with the browser review."],
    });
    await threadJournalStore.put({
      threadId: "thread-1",
      dateKey: "2026-03-30",
      updatedAt: 12,
      entries: [
        "[Lead] Today budget notes were noisy and should not crowd out the real constraint.",
        "[Lead] Recent journal recap mentioned a follow-up but not the binding limit.",
      ],
    });

    const contextBudgeter = new DefaultContextBudgeter();
    const promptAssembler = new DefaultPromptAssembler({
      estimateTokens: (input, reservedOutputTokens, maxInputTokens) =>
        contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens),
      maxMemoryHits: 4,
    });
    const policy = new DefaultRolePromptPolicy({
      roleProfileRegistry: new DefaultRoleProfileRegistry(),
      contextBudgeter: {
        async allocate(input) {
          const budget = await contextBudgeter.allocate(input);
          return {
            ...budget,
            totalBudget: 180,
            reservedOutputTokens: 20,
            compressedMemoryBudget: 56,
          };
        },
        async estimate(input, reservedOutputTokens, maxInputTokens) {
          return contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens);
        },
      },
      roleMemoryResolver: new DefaultRoleMemoryResolver({
        threadSummaryStore,
        threadMemoryStore,
        threadJournalStore,
        roleScratchpadStore,
        workerEvidenceDigestStore,
      }),
      promptAssembler,
      reservedOutputTokens: 20,
    });

    const packet = await policy.buildPacket({
      ...buildFinanceActivationInput(),
      handoff: {
        ...buildFinanceActivationInput().handoff,
        payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
          relayBrief:
            "Continue the task, keep the budget constraint visible, and recall what limit still matters before the next step.",
        }),
      },
    });

    assert.match(packet.taskPrompt, /Retrieved memory:[\s\S]*Constraint: Budget must stay un/);
    assert.doesNotMatch(packet.taskPrompt, /Retrieved memory:[\s\S]*Journal 2026-03-30/);
    assert.equal(packet.promptAssembly?.contextDiagnostics.retrievedMemory.compacted, true);
    assert.equal(packet.promptAssembly?.contextDiagnostics.retrievedMemory.packedCount <= 2, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("default role prompt policy keeps salient earlier turns during recent-turn compaction", async () => {
  const contextBudgeter = new DefaultContextBudgeter();
  const promptAssembler = new DefaultPromptAssembler({
    estimateTokens: (input, reservedOutputTokens, maxInputTokens) =>
      contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens),
    maxRecentTurns: 5,
  });
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
    promptAssembler,
  });

  const activation = buildFinanceActivationInput();
  const packet = await policy.buildPacket({
    ...activation,
    handoff: {
      ...activation.handoff,
      payload: withRelayPayloadOverrides(activation.handoff.payload, {
        recentMessages: [
          {
            messageId: "m1",
            role: "user",
            name: "Chris",
            content: "Initial setup context.",
            createdAt: 1,
          },
          {
            messageId: "m2",
            role: "assistant",
            name: "Lead",
            content: "Approval is still pending before the browser retry can continue.",
            createdAt: 2,
          },
          {
            messageId: "m3",
            role: "assistant",
            name: "Lead",
            content: "Routine note 1.",
            createdAt: 3,
          },
          {
            messageId: "m4",
            role: "assistant",
            name: "Lead",
            content: "Routine note 2.",
            createdAt: 4,
          },
          {
            messageId: "m5",
            role: "assistant",
            name: "Lead",
            content: "Routine note 3.",
            createdAt: 5,
          },
          {
            messageId: "m6",
            role: "assistant",
            name: "Lead",
            content: "Routine note 4.",
            createdAt: 6,
          },
          {
            messageId: "m7",
            role: "assistant",
            name: "Lead",
            content: "Routine note 5.",
            createdAt: 7,
          },
        ],
      }),
    },
  });

  assert.match(packet.taskPrompt, /Approval is still pending before the browser retry can continue/);
});

test("default role prompt policy injects capability readiness digest", async () => {
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
    capabilityDiscoveryService: new DefaultCapabilityDiscoveryService({
      availableWorkers: ["browser"],
      skills: [{ skillId: "browser", installed: true, capability: "browser" }],
      now: () => 222,
    }),
  });

  const packet = await policy.buildPacket({
    ...buildFinanceActivationInput(),
    thread: {
      ...buildFinanceActivationInput().thread,
      roles: [
        buildFinanceActivationInput().thread.roles[0]!,
        {
          ...buildFinanceActivationInput().thread.roles[1]!,
          name: "Operator",
          capabilities: ["browser"],
        },
      ],
    },
    runState: {
      ...buildFinanceActivationInput().runState,
      roleId: "role-finance",
    },
    handoff: {
      ...buildFinanceActivationInput().handoff,
      targetRoleId: "role-finance",
    },
  });

  assert.ok(packet.capabilityInspection);
  assert.equal(packet.capabilityInspection?.availableWorkers.includes("browser"), true);
  assert.match(packet.taskPrompt, /Capability readiness:/);
  assert.match(packet.taskPrompt, /Transport order:/);
});

test("default role prompt policy honors explicit preferred worker instructions", async () => {
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
  });

  const packet = await policy.buildPacket({
    ...buildFinanceActivationInput(),
    thread: {
      ...buildFinanceActivationInput().thread,
      roles: [
        buildFinanceActivationInput().thread.roles[0]!,
        {
          roleId: "role-operator",
          name: "Operator",
          seat: "member",
          runtime: "local",
          capabilities: ["browser", "explore"],
        },
      ],
      leadRoleId: "role-lead",
    },
    runState: {
      ...buildFinanceActivationInput().runState,
      roleId: "role-operator",
    },
    handoff: {
      ...buildFinanceActivationInput().handoff,
      targetRoleId: "role-operator",
      payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
        instructions: "Continue this scheduled task.\nPreferred worker: explore",
      }),
    },
  });

  assert.deepEqual(packet.preferredWorkerKinds, ["explore"]);
});

test("default role prompt policy honors structured worker resume hints", async () => {
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
  });

  const packet = await policy.buildPacket({
    ...buildFinanceActivationInput(),
    thread: {
      ...buildFinanceActivationInput().thread,
      roles: [
        buildFinanceActivationInput().thread.roles[0]!,
        {
          roleId: "role-operator",
          name: "Operator",
          seat: "member",
          runtime: "local",
          capabilities: ["browser", "explore"],
        },
      ],
      leadRoleId: "role-lead",
    },
    runState: {
      ...buildFinanceActivationInput().runState,
      roleId: "role-operator",
    },
    handoff: {
      ...buildFinanceActivationInput().handoff,
      targetRoleId: "role-operator",
      payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
        instructions: "This string should not override structured preferences.",
        preferredWorkerKinds: ["browser"],
        sessionTarget: "worker",
        continuationContext: {
          source: "scheduled_reentry",
          workerType: "browser",
          workerRunKey: "worker:browser:task:task-existing",
          summary: "Continue the existing browser review from the partial findings.",
        },
      }),
    },
  });

  assert.deepEqual(packet.preferredWorkerKinds, ["browser"]);
  assert.equal(packet.resumeTarget, "worker");
  assert.equal(packet.continuityMode, "resume-existing");
  assert.deepEqual(packet.continuationContext, {
    source: "scheduled_reentry",
    workerType: "browser",
    workerRunKey: "worker:browser:task:task-existing",
    summary: "Continue the existing browser review from the partial findings.",
  });
  assert.match(packet.taskPrompt, /Continuation context:/);
  assert.match(packet.taskPrompt, /Worker session: worker:browser:task:task-existing/);
  assert.match(packet.taskPrompt, /Continue the existing browser review from the partial findings/);
});

test("default role prompt policy resumes worker-targeted handoffs without explicit continuation context", async () => {
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
  });

  const packet = await policy.buildPacket({
    ...buildFinanceActivationInput(),
    thread: {
      ...buildFinanceActivationInput().thread,
      roles: [
        buildFinanceActivationInput().thread.roles[0]!,
        {
          roleId: "role-operator",
          name: "Operator",
          seat: "member",
          runtime: "local",
          capabilities: ["browser", "explore"],
        },
      ],
      leadRoleId: "role-lead",
    },
    runState: {
      ...buildFinanceActivationInput().runState,
      roleId: "role-operator",
    },
    handoff: {
      ...buildFinanceActivationInput().handoff,
      targetRoleId: "role-operator",
      payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
        sessionTarget: "worker",
        instructions: "Check the pending browser follow-up.",
      }),
    },
  });

  assert.equal(packet.resumeTarget, "worker");
  assert.equal(packet.continuityMode, "resume-existing");
});

test("default role prompt policy infers continuity preference from continue-style instructions", async () => {
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
  });

  const packet = await policy.buildPacket({
    ...buildFinanceActivationInput(),
    thread: {
      ...buildFinanceActivationInput().thread,
      roles: [
        buildFinanceActivationInput().thread.roles[0]!,
        {
          roleId: "role-operator",
          name: "Operator",
          seat: "member",
          runtime: "local",
          capabilities: ["browser"],
        },
      ],
    },
    runState: {
      ...buildFinanceActivationInput().runState,
      roleId: "role-operator",
    },
    handoff: {
      ...buildFinanceActivationInput().handoff,
      targetRoleId: "role-operator",
      payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
        instructions: "Please continue with the same browser session and pick up where you left off.",
      }),
    },
  });

  assert.equal(packet.continuityMode, "prefer-existing");
});

test("default role prompt policy builds a role-level continuity section from scratchpad and summary", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompt-policy-continuity-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadJournalStore = new FileThreadJournalStore({
      rootDir: path.join(tempDir, "thread-journal"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({
      rootDir: path.join(tempDir, "worker-evidence"),
    });

    await threadSummaryStore.put({
      threadId: "thread-1",
      summaryVersion: 1,
      updatedAt: 1,
      sourceMessageCount: 3,
      userGoal: "Review pricing",
      stableFacts: [],
      decisions: [],
      openQuestions: ["Do we already have enough evidence to finalize the comparison?"],
    });
    await roleScratchpadStore.put({
      threadId: "thread-1",
      roleId: "role-finance",
      updatedAt: 1,
      sourceMessageCount: 2,
      completedWork: ["Collected partial cost evidence."],
      pendingWork: ["Finish the month-one vendor comparison."],
      waitingOn: "Official pricing confirmation",
      evidenceRefs: [],
    });

    const policy = new DefaultRolePromptPolicy({
      roleProfileRegistry: new DefaultRoleProfileRegistry(),
      roleMemoryResolver: new DefaultRoleMemoryResolver({
        threadSummaryStore,
        threadMemoryStore,
        threadJournalStore,
        roleScratchpadStore,
        workerEvidenceDigestStore,
      }),
    });

    const packet = await policy.buildPacket({
      ...buildFinanceActivationInput(),
      handoff: {
        ...buildFinanceActivationInput().handoff,
        payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
          instructions: "Continue the same finance analysis from where it paused.",
        }),
      },
    });

    assert.equal(packet.continuityMode, "prefer-existing");
    assert.match(packet.taskPrompt, /Execution continuity:/);
    assert.match(packet.taskPrompt, /Waiting on: Official pricing confirmation/);
    assert.match(packet.taskPrompt, /Pending work: Finish the month-one vendor comparison/);
    assert.match(packet.taskPrompt, /Open questions: Do we already have enough evidence to finalize the comparison/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("default role prompt policy injects merge coverage context for synthesis turns", async () => {
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
  });

  const packet = await policy.buildPacket({
    ...buildFinanceActivationInput(),
    handoff: {
      ...buildFinanceActivationInput().handoff,
      payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
        mergeContext: {
          fanOutGroupId: "msg-lead-fanout:fanout",
          expectedRoleIds: ["research", "finance"],
          completedRoleIds: ["research"],
          failedRoleIds: [],
          cancelledRoleIds: ["finance"],
          missingRoleIds: [],
          followUpRequired: true,
        },
      }),
    },
  });

  assert.deepEqual(packet.mergeContext, {
    fanOutGroupId: "msg-lead-fanout:fanout",
    expectedRoleIds: ["research", "finance"],
    completedRoleIds: ["research"],
    failedRoleIds: [],
    cancelledRoleIds: ["finance"],
    missingRoleIds: [],
    followUpRequired: true,
  });
  assert.match(packet.taskPrompt, /Merge coverage:/);
  assert.match(packet.taskPrompt, /Fan-out group: msg-lead-fanout:fanout/);
  assert.match(packet.taskPrompt, /Expected roles: research, finance/);
  assert.match(packet.taskPrompt, /Completed roles: research/);
  assert.match(packet.taskPrompt, /Cancelled roles: finance/);
  assert.match(packet.taskPrompt, /Follow-up required: yes/);
  assert.deepEqual(packet.suggestedMentions, ["role-lead"]);
});

test("default role prompt policy injects research shard packet", async () => {
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
  });

  const packet = await policy.buildPacket({
    ...buildFinanceActivationInput(),
    handoff: {
      ...buildFinanceActivationInput().handoff,
      payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
        parallelContext: {
          kind: "research_shard",
          fanOutGroupId: "msg-lead-fanout:fanout",
          shardRoleId: "role-finance",
          shardIndex: 1,
          shardCount: 2,
          expectedRoleIds: ["role-research", "role-finance"],
          mergeBackToRoleId: "role-lead",
          shardGoal: "Investigate pricing implications and return only the finance slice.",
        },
      }),
    },
    thread: {
      ...buildFinanceActivationInput().thread,
      roles: [
        buildFinanceActivationInput().thread.roles[0]!,
        {
          roleId: "role-research",
          name: "Research",
          seat: "member",
          runtime: "local",
        },
        buildFinanceActivationInput().thread.roles[1]!,
      ],
    },
  });

  assert.deepEqual(packet.parallelContext, {
    kind: "research_shard",
    fanOutGroupId: "msg-lead-fanout:fanout",
    shardRoleId: "role-finance",
    shardIndex: 1,
    shardCount: 2,
    expectedRoleIds: ["role-research", "role-finance"],
    mergeBackToRoleId: "role-lead",
    shardGoal: "Investigate pricing implications and return only the finance slice.",
  });
  assert.match(packet.taskPrompt, /Parallel shard assignment:/);
  assert.match(packet.taskPrompt, /Shard: 2\/2/);
  assert.match(packet.taskPrompt, /Only handle your shard/);
});

test("default role prompt policy filters self and unknown follow-up mentions", async () => {
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
  });

  const packet = await policy.buildPacket({
    ...buildFinanceActivationInput(),
    handoff: {
      ...buildFinanceActivationInput().handoff,
      payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
        parallelContext: {
          kind: "merge_synthesis",
          fanOutGroupId: "msg-lead-fanout:fanout",
          expectedRoleIds: ["role-research", "role-finance"],
          completedRoleIds: [],
          failedRoleIds: [],
          cancelledRoleIds: ["role-finance", "role-ghost"],
          missingRoleIds: ["role-ghost"],
          duplicateRoleIds: [],
          conflictRoleIds: [],
          followUpRequired: true,
          shardSummaries: [],
        },
      }),
    },
    thread: {
      ...buildFinanceActivationInput().thread,
      roles: [
        buildFinanceActivationInput().thread.roles[0]!,
        {
          roleId: "role-research",
          name: "Research",
          seat: "member",
          runtime: "local",
        },
        buildFinanceActivationInput().thread.roles[1]!,
      ],
    },
  });

  assert.deepEqual(packet.suggestedMentions, ["role-lead"]);
});

test("default role prompt policy keeps an older unresolved turn when recent turns are compacted", async () => {
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
  });

  const recentMessages = [
    {
      messageId: "msg-user-0",
      role: "user" as const,
      name: "Chris",
      content: "We still need to follow up on the browser pricing blocker before finalizing.",
      createdAt: 0,
    },
    ...Array.from({ length: 7 }, (_, index) => ({
      messageId: `msg-${index + 1}`,
      role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
      name: index % 2 === 0 ? "Lead" : "Chris",
      content: `Recent turn ${index + 1}`,
      createdAt: index + 1,
      ...(index % 2 === 0 ? { roleId: "role-lead" } : {}),
    })),
  ];

  const packet = await policy.buildPacket({
    ...buildFinanceActivationInput(),
    handoff: {
      ...buildFinanceActivationInput().handoff,
      payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
        recentMessages,
      }),
    },
  });

  assert.match(packet.taskPrompt, /follow up on the browser pricing blocker/);
  assert.match(packet.taskPrompt, /Recent turn 7/);
});

test("default role prompt policy keeps an older merge-conflict turn when recent turns are compacted", async () => {
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
  });

  const recentMessages = [
    {
      messageId: "msg-user-merge-0",
      role: "assistant" as const,
      roleId: "role-lead",
      name: "Lead",
      content: "Merge follow-up: finance shard is still missing and research/finance outputs conflict.",
      createdAt: 0,
    },
    ...Array.from({ length: 7 }, (_, index) => ({
      messageId: `msg-merge-${index + 1}`,
      role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
      name: index % 2 === 0 ? "Lead" : "Chris",
      content: `Recent merge turn ${index + 1}`,
      createdAt: index + 1,
      ...(index % 2 === 0 ? { roleId: "role-lead" } : {}),
    })),
  ];

  const packet = await policy.buildPacket({
    ...buildFinanceActivationInput(),
    handoff: {
      ...buildFinanceActivationInput().handoff,
      payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
        recentMessages,
      }),
    },
  });

  assert.match(packet.taskPrompt, /finance shard is still missing and research\/finance outputs conflict/);
  assert.match(packet.taskPrompt, /Recent merge turn 7/);
});

test("default role prompt policy keeps an older blocker turn when recent turns are compacted", async () => {
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
  });

  const recentMessages = [
    {
      messageId: "msg-user-blocker-0",
      role: "assistant" as const,
      roleId: "role-lead",
      name: "Lead",
      content: "Browser blocker: login expired before the pricing review could proceed.",
      createdAt: 0,
    },
    ...Array.from({ length: 7 }, (_, index) => ({
      messageId: `msg-blocker-${index + 1}`,
      role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
      name: index % 2 === 0 ? "Lead" : "Chris",
      content: `Routine note ${index + 1}`,
      createdAt: index + 1,
      ...(index % 2 === 0 ? { roleId: "role-lead" } : {}),
    })),
  ];

  const packet = await policy.buildPacket({
    ...buildFinanceActivationInput(),
    handoff: {
      ...buildFinanceActivationInput().handoff,
      payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
        recentMessages,
      }),
    },
  });

  assert.match(packet.taskPrompt, /Browser blocker: login expir/);
  assert.match(packet.taskPrompt, /Routine note 7/);
});

test("default role prompt policy keeps salient blocker turns when recent-turn section itself is compacted", async () => {
  const contextBudgeter = new DefaultContextBudgeter();
  const promptAssembler = new DefaultPromptAssembler({
    estimateTokens: (input, reservedOutputTokens, maxInputTokens) =>
      contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens),
    maxRecentTurns: 5,
  });
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
    contextBudgeter: {
      async allocate(input) {
        const budget = await contextBudgeter.allocate(input);
        return {
          ...budget,
          totalBudget: 150,
          reservedOutputTokens: 20,
          recentTurnsBudget: 14,
        };
      },
      async estimate(input, reservedOutputTokens, maxInputTokens) {
        return contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens);
      },
    },
    promptAssembler,
    reservedOutputTokens: 20,
  });

  const packet = await policy.buildPacket({
    ...buildFinanceActivationInput(),
    handoff: {
      ...buildFinanceActivationInput().handoff,
      payload: withRelayPayloadOverrides(buildFinanceActivationInput().handoff.payload, {
        recentMessages: [
          {
            messageId: "msg-user-blocker-0",
            role: "assistant" as const,
            roleId: "role-lead",
            name: "Lead",
            content: "Browser blocker: login expired before the pricing review could proceed.",
            createdAt: 0,
          },
          ...Array.from({ length: 7 }, (_, index) => ({
            messageId: `msg-tight-${index + 1}`,
            role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
            name: index % 2 === 0 ? "Lead" : "Chris",
            content: `Routine continuation turn ${index + 1}`,
            createdAt: index + 1,
            ...(index % 2 === 0 ? { roleId: "role-lead" } : {}),
          })),
        ],
      }),
    },
  });

  assert.match(packet.taskPrompt, /Browser blocker: login expir/);
  assert.equal(packet.promptAssembly?.contextDiagnostics.recentTurns.compacted, true);
  assert.equal(packet.promptAssembly?.contextDiagnostics.recentTurns.salientEarlierCount >= 1, true);
});

test("default role prompt policy keeps both older user approval ask and assistant merge blocker under recent-turn compaction", async () => {
  const contextBudgeter = new DefaultContextBudgeter();
  const promptAssembler = new DefaultPromptAssembler({
    estimateTokens: (input, reservedOutputTokens, maxInputTokens) =>
      contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens),
    maxRecentTurns: 5,
  });
  const policy = new DefaultRolePromptPolicy({
    roleProfileRegistry: new DefaultRoleProfileRegistry(),
    promptAssembler,
  });

  const activation = buildFinanceActivationInput();
  const packet = await policy.buildPacket({
    ...activation,
    handoff: {
      ...activation.handoff,
      payload: withRelayPayloadOverrides(activation.handoff.payload, {
        recentMessages: [
          {
            messageId: "msg-user-approval-0",
            role: "user",
            name: "Chris",
            content: "Please keep the operator approval blocker visible before the merge continues.",
            createdAt: 0,
          },
          {
            messageId: "msg-assistant-merge-1",
            role: "assistant",
            roleId: "role-lead",
            name: "Lead",
            content: "Merge blocker: the finance shard is still missing and the follow-up is unresolved.",
            createdAt: 1,
          },
          ...Array.from({ length: 7 }, (_, index) => ({
            messageId: `msg-routine-${index + 1}`,
            role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
            name: index % 2 === 0 ? "Lead" : "Chris",
            content: `Routine continuation turn ${index + 1}`,
            createdAt: index + 2,
            ...(index % 2 === 0 ? { roleId: "role-lead" } : {}),
          })),
        ],
      }),
    },
  });

  assert.match(packet.taskPrompt, /operator approval blocker visible before the merge continues/);
  assert.match(packet.taskPrompt, /finance shard is still missing and the follow-up is unresolved/);
  assert.match(packet.taskPrompt, /Routine continuation turn 7/);
});

type RelayPayloadOverrides = {
  relayBrief?: string;
  recentMessages?: TeamMessageSummary[];
  instructions?: string;
  sessionTarget?: RoleActivationInput["handoff"]["payload"]["sessionTarget"];
  dispatchPolicy?: DispatchPolicy;
  preferredWorkerKinds?: WorkerKind[];
  continuationContext?: DispatchContinuationContext;
  mergeContext?: FanOutMergeContext;
  parallelContext?: ParallelOrchestrationContext;
};

function withRelayPayloadOverrides(
  payload: RoleActivationInput["handoff"]["payload"],
  overrides: RelayPayloadOverrides
): RoleActivationInput["handoff"]["payload"] {
  const {
    relayBrief,
    recentMessages,
    instructions,
    sessionTarget,
    dispatchPolicy,
    preferredWorkerKinds,
    continuationContext,
    mergeContext,
    parallelContext,
    ...rest
  } = overrides;

  const nextRelayBrief = relayBrief ?? payload.intent?.relayBrief;
  const nextRecentMessages = recentMessages ?? payload.intent?.recentMessages;
  const nextInstructions = instructions ?? payload.intent?.instructions;
  const nextDispatchPolicy = dispatchPolicy ?? payload.constraints?.dispatchPolicy;
  const nextPreferredWorkerKinds = preferredWorkerKinds ?? payload.constraints?.preferredWorkerKinds;
  const nextContinuationContext = continuationContext ?? payload.continuity?.context;
  const nextMergeContext = mergeContext ?? payload.coordination?.merge;
  const nextParallelContext = parallelContext ?? payload.coordination?.parallel;

  return normalizeRelayPayload({
    ...payload,
    ...rest,
    ...(sessionTarget ? { sessionTarget } : {}),
    ...(nextRelayBrief !== undefined || nextRecentMessages !== undefined || nextInstructions !== undefined
      ? {
          intent: {
            relayBrief: nextRelayBrief ?? "",
            recentMessages: nextRecentMessages ?? [],
            ...(nextInstructions ? { instructions: nextInstructions } : {}),
          },
        }
      : {}),
    ...(nextDispatchPolicy
      ? {
          constraints: {
            dispatchPolicy: nextDispatchPolicy,
            ...(nextPreferredWorkerKinds?.length ? { preferredWorkerKinds: nextPreferredWorkerKinds } : {}),
          },
        }
      : {}),
    ...(nextContinuationContext
      ? {
          continuity: {
            ...(payload.continuity ?? {}),
            context: nextContinuationContext,
          },
        }
      : {}),
    ...(nextMergeContext || nextParallelContext
      ? {
          coordination: {
            ...(payload.coordination ?? {}),
            ...(nextMergeContext ? { merge: nextMergeContext } : {}),
            ...(nextParallelContext ? { parallel: nextParallelContext } : {}),
          },
        }
      : {}),
  });
}

function buildFinanceActivationInput(): RoleActivationInput {
  return {
    runState: {
      runKey: "role:role-finance:thread:thread-1",
      threadId: "thread-1",
      roleId: "role-finance",
      mode: "group",
      status: "queued",
      iterationCount: 0,
      maxIterations: 6,
      inbox: [],
      lastActiveAt: 100,
    },
    thread: {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Launch Team",
      leadRoleId: "role-lead",
      roles: [
        { roleId: "role-lead", name: "Lead", seat: "lead", runtime: "local" },
        {
          roleId: "role-finance",
          name: "Financial Expert",
          seat: "member",
          runtime: "local",
          model: { provider: "anthropic", name: "claude-opus" },
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
      activeRoleIds: ["role-finance"],
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
      targetRoleId: "role-finance",
      activationType: "mention",
      threadId: "thread-1",
      payload: normalizeRelayPayload({
        threadId: "thread-1",
        relayBrief: "Compare OpenAI and Anthropic launch costs and return only the finance delta.",
        recentMessages: [
          {
            messageId: "msg-user-1",
            role: "user",
            name: "Chris",
            content: "We need a fast vendor choice for next month.",
            createdAt: 1,
          },
          {
            messageId: "msg-lead-1",
            role: "assistant",
            roleId: "role-lead",
            name: "Lead",
            content: "Finance should estimate cost and risk.",
            createdAt: 2,
          },
        ],
        instructions: "Focus on pricing and first-month cost.",
        dispatchPolicy: {
          allowParallel: false,
          allowReenter: true,
          sourceFlowMode: "serial",
        },
      }),
      createdAt: 3,
    },
  };
}
