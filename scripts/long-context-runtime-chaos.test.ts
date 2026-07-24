import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONTEXT_CHECKPOINT_PROTOCOL,
  emptyContextCheckpointWorkingSet,
} from "@turnkeyai/core-types/context-checkpoint";
import {
  DYNAMIC_CONTEXT_BASELINE_PROTOCOL,
} from "@turnkeyai/core-types/dynamic-context-baseline";
import type { WorkItem } from "@turnkeyai/core-types/mission";
import type {
  RoleActivationInput,
  WorkspaceMemoryAuditRecord,
} from "@turnkeyai/core-types/team";
import type { LLMMessage } from "@turnkeyai/llm-adapter/index";
import { buildLongContextRuntimeReport } from "../packages/app-gateway/src/long-context-runtime-report";
import {
  createCompactionController,
} from "../packages/role-runtime/src/react-engine/compaction-controller";
import {
  RUN_EFFECT_INDETERMINATE_PROTOCOL,
  createRunJournal,
} from "../packages/role-runtime/src/react-engine/run-journal";
import { FileContextCheckpointStore } from "@turnkeyai/team-store/context/file-context-checkpoint-store";
import { FileDynamicContextBaselineStore } from "@turnkeyai/team-store/context/file-dynamic-context-baseline-store";
import { FileWorkspaceMemoryStore } from "@turnkeyai/team-store/context/file-workspace-memory-store";
import { SqliteMemorySearchIndex } from "@turnkeyai/team-store/context/sqlite-memory-search-index";
import { FileTeamMessageStore } from "@turnkeyai/team-store/file-team-message-store";
import { FilePermissionCacheStore } from "@turnkeyai/team-store/governance/file-permission-cache-store";
import { FileWorkItemStore } from "@turnkeyai/team-store/mission/file-work-item-store";
import { FileWorkerSessionStore } from "@turnkeyai/team-store/worker/file-worker-session-store";

test("long-context runtime restores task, memory, session, approval, checkpoint, and effects after one crash", async () => {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "turnkeyai-long-context-chaos-"),
  );
  try {
    const roots = {
      checkpoints: path.join(rootDir, "checkpoints"),
      baselines: path.join(rootDir, "baselines"),
      memory: path.join(rootDir, "memory"),
      memoryIndex: path.join(rootDir, "memory-index.sqlite"),
      messages: path.join(rootDir, "messages"),
      permissions: path.join(rootDir, "permissions"),
      sessions: path.join(rootDir, "sessions"),
      tasks: path.join(rootDir, "tasks"),
    };
    const activation = buildActivation();
    const scope = {
      threadId: "thread-1",
      roleId: "role-lead",
      flowId: "flow-1",
    };
    const checkpointStore = new FileContextCheckpointStore({
      rootDir: roots.checkpoints,
    });
    const baselineStore = new FileDynamicContextBaselineStore({
      rootDir: roots.baselines,
    });
    const memoryIndex = new SqliteMemorySearchIndex({
      dbPath: roots.memoryIndex,
    });
    const memoryStore = new FileWorkspaceMemoryStore({
      rootDir: roots.memory,
      index: memoryIndex,
    });
    const messageStore = new FileTeamMessageStore({
      rootDir: roots.messages,
    });
    const permissionStore = new FilePermissionCacheStore({
      rootDir: roots.permissions,
    });
    const sessionStore = new FileWorkerSessionStore({
      rootDir: roots.sessions,
    });
    const taskStore = new FileWorkItemStore({
      rootDir: roots.tasks,
    });

    const dependency = workItem("wi.1", 1, "done", [], ["wi.2"]);
    const dependent = workItem(
      "wi.2",
      2,
      "working",
      ["wi.1"],
      [],
    );
    dependent.specification!.acceptanceCriteria = [{
      id: "criterion-effect",
      description: "The external effect has a verified receipt.",
      required: true,
      state: "unverified",
    }];
    await taskStore.putGraph("msn.1", [dependency, dependent]);

    await baselineStore.put({
      protocol: DYNAMIC_CONTEXT_BASELINE_PROTOCOL,
      baselineId: "baseline-1",
      scope,
      promptPackVersion: "turnkeyai.role_prompt_pack.v2",
      modelFingerprint: "model-1",
      toolFingerprint: "tools-1",
      sections: [{
        name: "task-prompt",
        version: "1",
        digest: "task-digest",
        sourceRefs: ["prompt.assembly.task-brief@1.0.0"],
        packedTokens: 50,
        omitted: false,
        updatedAt: 100,
      }],
      activatedAt: 100,
    });
    await memoryStore.commit({
      workspaceId: "thread-1",
      expectedLastSequence: 0,
      cursor: {
        workspaceId: "thread-1",
        lastSequence: 1,
        lastEventId: "event-1",
        updatedAt: 101,
      },
      audit: memoryAudit(),
      mutations: [{
        kind: "add",
        record: {
          memoryId: "memory-budget",
          plane: "workspace",
          scope: {
            workspaceId: "thread-1",
            threadId: "thread-1",
          },
          content: "Release budget is capped at 500 yuan.",
          sourceRefs: ["user:message-1"],
          createdBy: "user",
          confidence: "authoritative",
          createdAt: 100,
          lastConfirmedAt: 100,
          supersedes: [],
          invalidationKeys: ["release-budget"],
        },
      }],
    });
    await sessionStore.put({
      workerRunKey: "worker:browser:task:task-1",
      executionToken: 1,
      state: {
        workerRunKey: "worker:browser:task:task-1",
        workerType: "browser",
        status: "resumable",
        createdAt: 100,
        updatedAt: 120,
        currentTaskId: "task-1",
        continuationDigest: {
          reason: "supervisor_retry",
          summary: "Resume after the parent checkpoint.",
          createdAt: 120,
        },
      },
      context: {
        threadId: "thread-1",
        flowId: "flow-1",
        taskId: "task-1",
        roleId: "role-lead",
        parentSpanId: "role:role-lead:thread:thread-1",
        background: true,
      },
    });
    await permissionStore.put({
      cacheKey: "thread-1:browser:publish:approval",
      threadId: "thread-1",
      workerType: "browser",
      requirement: {
        level: "approval",
        scope: "publish",
        rationale: "Publishing requires operator approval.",
        cacheKey: "thread-1:browser:publish:approval",
      },
      decision: "prompt_required",
      createdAt: 110,
      updatedAt: 120,
    });

    const history = buildHistory(7);
    const journal = createRunJournal({
      store: messageStore,
      activation,
      taskFingerprint: "task-fingerprint",
      now: () => 200,
    });
    await journal.checkpoint({
      messages: history,
      nextRound: 7,
      repairMarkers: [],
      toolTrace: [],
      planState: [JSON.stringify(dependency), JSON.stringify(dependent)],
    });
    for (const effectId of ["effect-reconciled", "effect-uncertain"]) {
      await journal.effectLedger.admit({
        round: 7,
        call: {
          id: effectId,
          name: "publish_release",
          input: { releaseId: effectId },
        },
      });
      await journal.effectLedger.start(effectId);
    }

    const controller = createCompactionController({
      taskPrompt: "Publish the release after verification.",
      estimateTokenBudget: () => ({
        rawInputTokens: 900,
        estimatedInputTokens: 900,
        source: "provider_calibrated",
        inputTokenLimit: 1_000,
        utilization: 0.9,
      }),
      summarize: async () => ({
        task: "Publish the release after verification.",
        summary: "The dependency is complete and the publish task is active.",
        decisions: ["Keep the 500 yuan budget."],
        evidence: ["memory-budget"],
        artifacts: ["artifact://release-plan"],
        openQuestions: ["Confirm the uncertain effect externally."],
        planState: [],
        errorsAndFixes: [],
      }),
      readPlanState: () => [
        JSON.stringify(dependency),
        JSON.stringify(dependent),
      ],
      checkpointStore,
      checkpointScope: scope,
      dynamicContext: {
        baselineId: "baseline-1",
        sectionDigests: { "task-prompt": "task-digest" },
      },
      captureWorkingSet: () => ({
        ...emptyContextCheckpointWorkingSet(),
        artifacts: ["artifact://release-plan"],
        sessions: ["worker:browser:task:task-1"],
        approvals: ["thread-1:browser:publish:approval"],
      }),
      now: () => 210,
    });
    const compacted = await controller.applyRoundMessagesHook(history, 7);
    assert.ok(compacted.pendingCheckpointId);
    await journal.checkpoint({
      messages: compacted.messages,
      nextRound: 8,
      repairMarkers: [],
      toolTrace: [],
      planState: [JSON.stringify(dependency), JSON.stringify(dependent)],
    });
    await controller.activateCheckpoint(compacted.pendingCheckpointId!);

    // Process-style restart: rebuild every store and reconcile started
    // effects through read-only lookup. No execution function is invoked.
    let reconciliationLookups = 0;
    let effectExecutions = 0;
    const restartedMessageStore = new FileTeamMessageStore({
      rootDir: roots.messages,
    });
    const restartedJournal = createRunJournal({
      store: restartedMessageStore,
      activation,
      taskFingerprint: "task-fingerprint",
      now: () => 220,
      async reconcileEffect(effect) {
        reconciliationLookups += 1;
        if (effect.effectId !== "effect-reconciled") return null;
        return {
          toolCallId: effect.effectId,
          toolName: effect.call.name,
          content: "external receipt confirmed",
        };
      },
    });
    const restored = await restartedJournal.load();
    assert.ok(restored?.resumedAfterCrash);
    assert.equal(reconciliationLookups, 2);
    assert.equal(effectExecutions, 0);
    assert.match(
      JSON.stringify(restored?.messages),
      new RegExp(RUN_EFFECT_INDETERMINATE_PROTOCOL.replaceAll(".", "\\.")),
    );

    const restartedTaskStore = new FileWorkItemStore({
      rootDir: roots.tasks,
    });
    const restoredItems = await restartedTaskStore.listByMission("msn.1");
    assert.deepEqual(
      restoredItems[1]?.specification?.blockedBy,
      ["wi.1"],
    );
    const completed = structuredClone(restoredItems[1]!);
    completed.status = "done";
    completed.specification!.acceptanceCriteria[0]!.state = "passed";
    completed.specification!.verificationReceipts = [{
      receiptId: "receipt-effect-reconciled",
      criterionId: "criterion-effect",
      kind: "tool-receipt",
      ref: "effect-reconciled",
      verifier: "role-lead",
      result: "passed",
      verifiedAt: 220,
    }];
    await restartedTaskStore.putGraph("msn.1", [
      restoredItems[0]!,
      completed,
    ]);

    const report = await buildLongContextRuntimeReport(
      {
        now: () => 230,
        teamThreadStore: {
          async get() {
            return activation.thread;
          },
        },
        flowLedgerStore: {
          async listByThread() {
            return [{ flowId: "flow-1" }];
          },
        },
        teamMessageStore: restartedMessageStore,
        runtimeProgressStore: {
          async listByThread() {
            return [];
          },
        },
        workerSessionStore: new FileWorkerSessionStore({
          rootDir: roots.sessions,
        }),
        permissionCacheStore: new FilePermissionCacheStore({
          rootDir: roots.permissions,
        }),
        contextCheckpointStore: new FileContextCheckpointStore({
          rootDir: roots.checkpoints,
        }),
        dynamicContextBaselineStore:
          new FileDynamicContextBaselineStore({
            rootDir: roots.baselines,
          }),
        workspaceMemoryStore: new FileWorkspaceMemoryStore({
          rootDir: roots.memory,
          index: new SqliteMemorySearchIndex({
            dbPath: roots.memoryIndex,
          }),
        }),
        memorySearchIndex: new SqliteMemorySearchIndex({
          dbPath: roots.memoryIndex,
        }),
        activeToolPromptSectionIds: [
          "prompt.tools.general",
          "prompt.tools.tasks",
        ],
        taskSnapshotProvider: async () =>
          (await restartedTaskStore.listByMission("msn.1"))
            .map((item) => JSON.stringify(item)),
      },
      "thread-1",
    );

    assert.ok(report);
    assert.equal(
      report.scopes[0]?.checkpoint?.checkpointId,
      compacted.pendingCheckpointId,
    );
    assert.equal(
      report.scopes[0]?.checkpoint?.source.guard?.protocolSafe,
      true,
    );
    assert.deepEqual(
      report.scopes[0]?.checkpoint?.workingSet.sessions,
      ["worker:browser:task:task-1"],
    );
    assert.equal(report.memory.recordCount, 1);
    assert.equal(report.memory.index?.indexedRecords, 1);
    assert.equal(report.sessions.activeCount, 1);
    assert.equal(report.governance.pendingApprovalCount, 1);
    assert.equal(report.effects.statusCounts.committed, 1);
    assert.equal(report.effects.statusCounts.indeterminate, 1);
    assert.equal(report.tasks.itemCount, 2);
    assert.equal(report.tasks.receiptCount, 1);
    assert.equal(report.tasks.criterionStateCounts.passed, 1);
    assert.ok(report.attention.includes("indeterminate_effect"));
    assert.ok(report.attention.includes("pending_approval"));
    assert.equal(effectExecutions, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

function buildHistory(rounds: number): LLMMessage[] {
  return [
    { role: "system", content: "stable system" },
    { role: "user", content: "publish task" },
    ...Array.from({ length: rounds }, (_, index) => {
      const id = `call-${index + 1}`;
      return [
        {
          role: "assistant" as const,
          content: [{
            type: "tool_use" as const,
            id,
            name: "web_fetch",
            input: { url: `https://example.com/${id}` },
          }],
        },
        {
          role: "tool" as const,
          toolCallId: id,
          name: "web_fetch",
          content: `${id} evidence`,
        },
      ];
    }).flat(),
  ];
}

function workItem(
  id: string,
  n: number,
  status: WorkItem["status"],
  blockedBy: string[],
  blocks: string[],
): WorkItem {
  return {
    id,
    missionId: "msn.1",
    n,
    title: `Item ${n}`,
    agent: "role-lead",
    status,
    started: "—",
    duration: "—",
    contextRefs: [],
    output: "",
    specification: {
      objective: `Complete item ${n}`,
      inputRefs: [],
      outputRefs: [],
      constraints: [],
      blockedBy,
      blocks,
      acceptanceCriteria: [],
      verificationReceipts: [],
    },
  };
}

function memoryAudit(): WorkspaceMemoryAuditRecord {
  const digest = createHash("sha256").update("memory").digest("hex");
  return {
    auditId: "audit-1",
    workspaceId: "thread-1",
    trigger: "pre-compaction",
    sourceEventIds: ["event-1"],
    mutations: [],
    rejectedMutations: [],
    beforeDigest: digest,
    afterDigest: digest,
    startedAt: 100,
    completedAt: 101,
    status: "written",
  };
}

function buildActivation(): RoleActivationInput {
  return {
    thread: {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Team",
      leadRoleId: "role-lead",
      roles: [{
        roleId: "role-lead",
        name: "Lead",
        seat: "lead",
        runtime: "local",
      }],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    flow: {
      flowId: "flow-1",
      threadId: "thread-1",
      rootMessageId: "root",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: ["role-lead"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 1,
      maxHops: 10,
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    },
    runState: {
      runKey: "role:role-lead:thread:thread-1",
      threadId: "thread-1",
      roleId: "role-lead",
      mode: "group",
      status: "running",
      iterationCount: 0,
      maxIterations: 128,
      inbox: [],
      lastActiveAt: 1,
    },
    handoff: {
      taskId: "task-1",
      flowId: "flow-1",
      sourceMessageId: "root",
      targetRoleId: "role-lead",
      activationType: "cascade",
      threadId: "thread-1",
      payload: { threadId: "thread-1" },
      createdAt: 1,
    },
  };
}
