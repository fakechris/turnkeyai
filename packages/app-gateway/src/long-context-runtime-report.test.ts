import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLongContextRuntimeReport,
  LONG_CONTEXT_RUNTIME_REPORT_PROTOCOL,
} from "./long-context-runtime-report";

test("long-context runtime report joins prompt, checkpoint, memory, index, and task authority", async () => {
  const report = await buildLongContextRuntimeReport(
    {
      now: () => 500,
      teamThreadStore: {
        async get() {
          return {
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
          };
        },
      },
      flowLedgerStore: {
        async listByThread() {
          return [{ flowId: "flow-1" }];
        },
      },
      teamMessageStore: {
        async list() {
          return [{
            metadata: {
              runtimeRunJournal: true,
              runJournal: {
                status: "in_flight",
                runKey: "role:role-lead:thread:thread-1",
                taskId: "task-1",
                updatedAt: 490,
                effectLedger: {
                  protocol: "turnkeyai.effect_ledger.v1",
                  records: [{
                    effectId: "effect-1",
                    round: 4,
                    status: "indeterminate",
                    call: { id: "effect-1", name: "publish", input: {} },
                    result: {
                      toolCallId: "effect-1",
                      toolName: "publish",
                      content: "indeterminate",
                    },
                  }],
                },
              },
            },
            updatedAt: 490,
          }] as never;
        },
      },
      runtimeProgressStore: {
        async listByThread() {
          return [{
            progressId: "progress:prompt-assembly:task-1",
            threadId: "thread-1",
            subjectKind: "role_run",
            subjectId: "role:role-lead:thread:thread-1",
            phase: "heartbeat",
            progressKind: "boundary",
            summary: "Prompt assembly included 1 section.",
            recordedAt: 480,
            metadata: {
              boundaryKind: "prompt_assembly",
              tokenEstimate: {
                inputTokens: 1_000,
                outputTokensReserved: 500,
                totalProjectedTokens: 1_500,
                overBudget: false,
              },
              sectionReceipts: [{
                sectionId: "prompt.assembly.task-brief",
                version: "1.0.0",
                owner: "packages/role-runtime/src/prompt/prompt-assembler.ts",
                authority: "context-projection",
                requiredCapability: "always",
                baselineBehavior: "rehydrate-full",
                state: "included",
                estimatedTokens: 100,
              }],
            },
          }] as never;
        },
      },
      workerSessionStore: {
        async listByThread() {
          return [{
            workerRunKey: "worker:explore:1",
            executionToken: 2,
            state: {
              workerRunKey: "worker:explore:1",
              workerType: "explore",
              status: "resumable",
              createdAt: 100,
              updatedAt: 470,
            },
            context: {
              threadId: "thread-1",
              flowId: "flow-1",
              taskId: "task-1",
              roleId: "role-lead",
              parentSpanId: "role:lead",
              background: true,
            },
          }] as never;
        },
      },
      permissionCacheStore: {
        async listByThread() {
          return [{
            cacheKey: "approval:publish",
            threadId: "thread-1",
            workerType: "browser",
            requirement: {
              level: "approval",
              scope: "publish",
              rationale: "Publishing needs operator approval.",
              cacheKey: "approval:publish",
            },
            decision: "prompt_required",
            createdAt: 400,
            updatedAt: 460,
          }] as never;
        },
      },
      contextCheckpointStore: {
        async getActive() {
          return {
            protocol: "turnkeyai.context_checkpoint.v2",
            checkpointId: "checkpoint-1",
            version: 2,
            state: "activated",
            scope: {
              threadId: "thread-1",
              roleId: "role-lead",
              flowId: "flow-1",
            },
            compactedAtRound: 12,
            source: {
              transcriptDigest: "digest",
              sourceMessageCount: 100,
              sourceBytes: 1_000,
              sourceTokensEstimate: 300,
              guard: {
                protocolSafe: true,
                compacted: true,
                guardedMessageCount: 20,
                guardedBytes: 300,
                guardedTokens: 90,
                digestedMessageCount: 80,
                digestedProtocolUnitCount: 40,
                retainedProtocolUnitCount: 4,
                digestGroupCount: 3,
              },
            },
            task: {
              rootGoal: "Ship report",
              planState: ["task"],
              openQuestions: [],
              nextActions: ["task"],
            },
            summary: {
              narrative: "summary",
              decisions: [],
              evidence: [],
              errorsAndFixes: [],
            },
            workingSet: {
              files: [{ path: "/repo/report.md" }],
              skills: [],
              artifacts: ["artifact://report"],
              sessions: [],
              approvals: [],
              images: [],
            },
            dynamicContext: {
              baselineId: "baseline-1",
              sectionDigests: { task: "task-digest" },
            },
            createdAt: 100,
            updatedAt: 200,
          };
        },
        async get() {
          return null;
        },
        async put() {},
        async activate() {
          throw new Error("unused");
        },
        async listByScope() {
          return [];
        },
      },
      dynamicContextBaselineStore: {
        async get() {
          return {
            protocol: "turnkeyai.dynamic_context_baseline.v1",
            baselineId: "baseline-1",
            scope: {
              threadId: "thread-1",
              roleId: "role-lead",
              flowId: "flow-1",
            },
            promptPackVersion: "turnkeyai.role_prompt_pack.v2",
            modelFingerprint: "model",
            toolFingerprint: "tools",
            sections: [{
              name: "task-prompt",
              version: "1",
              digest: "task-digest",
              sourceRefs: ["prompt.assembly.task-brief@1.0.0"],
              packedTokens: 20,
              omitted: false,
              updatedAt: 150,
            }],
            activatedAt: 150,
          };
        },
        async put() {},
      },
      workspaceMemoryStore: {
        async getSnapshot() {
          return {
            workspaceId: "thread-1",
            records: [{
              memoryId: "memory-1",
              plane: "workspace",
              scope: { workspaceId: "thread-1", threadId: "thread-1" },
              content: "Use primary sources",
              sourceRefs: ["user:message-1"],
              createdBy: "user",
              confidence: "authoritative",
              createdAt: 1,
              lastConfirmedAt: 1,
              supersedes: [],
              invalidationKeys: [],
            }],
            cursor: {
              workspaceId: "thread-1",
              lastSequence: 10,
              lastEventId: "message-10",
              updatedAt: 100,
            },
            audits: [{
              auditId: "audit-1",
              workspaceId: "thread-1",
              trigger: "pre-compaction",
              sourceEventIds: ["message-10"],
              mutations: [],
              rejectedMutations: [],
              beforeDigest: "before",
              afterDigest: "after",
              startedAt: 90,
              completedAt: 100,
              status: "noop",
            }],
          };
        },
      } as never,
      memorySearchIndex: {
        async diagnostics() {
          return {
            backend: "sqlite-fts5-rrf",
            indexedRecords: 0,
            vectorRecords: 0,
            channels: ["fts"],
            defaults: {
              ftsCandidates: 20,
              vectorCandidates: 20,
              hits: 4,
              rrfK: 60,
              ftsWeight: 0.5,
              vectorWeight: 0.5,
            },
          };
        },
      } as never,
      activeToolPromptSectionIds: [
        "prompt.tools.general",
        "prompt.tools.tasks",
      ],
      taskSnapshotProvider: async () => [
        JSON.stringify({
          id: "wi.2",
          status: "blocked",
          specification: {
            blocked_by: ["wi.1"],
            acceptance_criteria: [{
              id: "criterion-1",
              state: "unverified",
            }],
            verification_receipts: [],
          },
        }),
      ],
    },
    "thread-1",
  );

  assert.ok(report);
  assert.equal(report.protocol, LONG_CONTEXT_RUNTIME_REPORT_PROTOCOL);
  assert.equal(report.promptRegistry.audit.valid, true);
  assert.equal(report.promptRuntime.totalBoundaries, 1);
  assert.equal(
    report.promptRuntime.promptSectionStateCounts.included,
    1,
  );
  assert.equal(report.scopes[0]?.checkpoint?.source.guard?.compacted, true);
  assert.equal(report.scopes[0]?.dynamicContext?.sections[0]?.packedTokens, 20);
  assert.equal(report.memory.recordCount, 1);
  assert.equal(report.memory.index?.channels[0], "fts");
  assert.equal(report.tasks.authority, "work-item-store");
  assert.equal(report.tasks.dependencyEdgeCount, 1);
  assert.equal(report.tasks.criterionStateCounts.unverified, 1);
  assert.equal(report.sessions.activeCount, 1);
  assert.equal(report.governance.pendingApprovalCount, 1);
  assert.equal(report.effects.indeterminateCount, 1);
  assert.deepEqual(report.attention, [
    "indeterminate_effect",
    "memory_index_snapshot_drift",
    "pending_approval",
    "task_blocked:wi.2",
  ]);
});

test("long-context runtime report caps effect records and session nodes while keeping full-set counts", async () => {
  const report = await buildLongContextRuntimeReport(
    {
      now: () => 900,
      teamThreadStore: {
        async get() {
          return {
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
          };
        },
      },
      flowLedgerStore: {
        async listByThread() {
          return [];
        },
      },
      teamMessageStore: {
        async list() {
          return [{
            metadata: {
              runtimeRunJournal: true,
              runJournal: {
                status: "in_flight",
                runKey: "role:role-lead:thread:thread-1",
                taskId: "task-1",
                updatedAt: 890,
                effectLedger: {
                  protocol: "turnkeyai.effect_ledger.v1",
                  records: Array.from({ length: 250 }, (_, index) => ({
                    effectId: `effect-${index + 1}`,
                    round: index + 1,
                    status: "completed",
                    call: { id: `effect-${index + 1}`, name: "publish", input: {} },
                  })),
                },
              },
            },
            updatedAt: 890,
          }] as never;
        },
      },
      runtimeProgressStore: {
        async listByThread() {
          return [];
        },
      },
      workerSessionStore: {
        async listByThread() {
          return Array.from({ length: 250 }, (_, index) => ({
            workerRunKey: `worker:explore:${index + 1}`,
            executionToken: 1,
            state: {
              workerRunKey: `worker:explore:${index + 1}`,
              workerType: "explore",
              status: "running",
              createdAt: 100,
              updatedAt: 100 + index,
            },
            context: {
              threadId: "thread-1",
              flowId: "flow-1",
            },
          })) as never;
        },
      },
      permissionCacheStore: {
        async listByThread() {
          return [];
        },
      },
      contextCheckpointStore: {} as never,
      dynamicContextBaselineStore: {} as never,
      workspaceMemoryStore: {
        async getSnapshot() {
          return {
            workspaceId: "thread-1",
            records: [],
            cursor: {
              workspaceId: "thread-1",
              lastSequence: 0,
              updatedAt: 0,
            },
            audits: [],
          };
        },
      } as never,
      memorySearchIndex: {} as never,
      activeToolPromptSectionIds: [],
    },
    "thread-1",
  );

  assert.ok(report);
  assert.equal(report.sessions.total, 250);
  assert.equal(report.sessions.activeCount, 250);
  assert.equal(report.sessions.truncated, true);
  assert.equal(report.sessions.nodes.length, 200);
  assert.equal(report.sessions.nodes[0]?.workerRunKey, "worker:explore:250");
  assert.equal(report.effects.journalCount, 1);
  assert.equal(report.effects.statusCounts.completed, 250);
  assert.equal(report.effects.truncated, true);
  assert.equal(report.effects.records.length, 200);
});

test("long-context runtime report returns null for an unknown thread", async () => {
  const report = await buildLongContextRuntimeReport(
    {
      now: () => 1,
      teamThreadStore: { async get() { return null; } },
      flowLedgerStore: { async listByThread() { return []; } },
      teamMessageStore: {} as never,
      runtimeProgressStore: {} as never,
      workerSessionStore: {} as never,
      permissionCacheStore: {} as never,
      contextCheckpointStore: {} as never,
      dynamicContextBaselineStore: {} as never,
      workspaceMemoryStore: {
        async getSnapshot() {
          return {
            workspaceId: "missing",
            records: [],
            cursor: {
              workspaceId: "missing",
              lastSequence: 0,
              updatedAt: 0,
            },
            audits: [],
          };
        },
      } as never,
      memorySearchIndex: {} as never,
      activeToolPromptSectionIds: [],
    },
    "missing",
  );
  assert.equal(report, null);
});
