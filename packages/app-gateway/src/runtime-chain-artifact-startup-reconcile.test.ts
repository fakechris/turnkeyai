import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeChain, RuntimeChainEvent, RuntimeChainSpan, RuntimeChainStatus, TeamThread } from "@turnkeyai/core-types/team";

import { reconcileRuntimeChainArtifactsOnStartup } from "./runtime-chain-artifact-startup-reconcile";

test("runtime chain artifact startup reconcile reports status span and event drift", async () => {
  const threads: TeamThread[] = [
    {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Demo",
      leadRoleId: "lead",
      roles: [],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const chains: RuntimeChain[] = [
    {
      chainId: "chain:ok",
      threadId: "thread-1",
      rootKind: "flow",
      rootId: "flow-1",
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const statuses: RuntimeChainStatus[] = [
    {
      chainId: "chain:ok",
      threadId: "thread-thread-mismatch",
      phase: "waiting",
      latestSummary: "thread mismatch",
      attention: true,
      updatedAt: 10,
    },
    {
      chainId: "chain:missing",
      threadId: "thread-1",
      phase: "started",
      latestSummary: "orphaned",
      attention: false,
      updatedAt: 11,
    },
  ];
  const spans: RuntimeChainSpan[] = [
    {
      spanId: "span:cross-thread",
      chainId: "chain:ok",
      subjectKind: "flow",
      subjectId: "flow-1",
      threadId: "thread-2",
      flowId: "flow-1",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      spanId: "span:cross-flow",
      chainId: "chain:ok",
      subjectKind: "flow",
      subjectId: "flow-2",
      threadId: "thread-1",
      flowId: "flow-2",
      createdAt: 2,
      updatedAt: 2,
    },
    {
      spanId: "span:orphaned",
      chainId: "chain:missing",
      subjectKind: "flow",
      subjectId: "flow-x",
      threadId: "thread-1",
      flowId: "flow-x",
      createdAt: 3,
      updatedAt: 3,
    },
  ];
  const events: RuntimeChainEvent[] = [
    {
      eventId: "event:missing-span",
      chainId: "chain:ok",
      spanId: "span:missing",
      threadId: "thread-1",
      subjectKind: "flow",
      subjectId: "flow-1",
      phase: "heartbeat",
      recordedAt: 5,
      summary: "missing span",
    },
    {
      eventId: "event:cross-chain",
      chainId: "chain:ok",
      spanId: "span:orphaned",
      threadId: "thread-1",
      subjectKind: "flow",
      subjectId: "flow-1",
      phase: "waiting",
      recordedAt: 6,
      summary: "cross chain",
    },
    {
      eventId: "event:cross-thread",
      chainId: "chain:ok",
      spanId: "span:cross-flow",
      threadId: "thread-2",
      subjectKind: "flow",
      subjectId: "flow-1",
      phase: "waiting",
      recordedAt: 7,
      summary: "cross thread",
    },
    {
      eventId: "event:orphaned",
      chainId: "chain:missing",
      spanId: "span:missing",
      threadId: "thread-1",
      subjectKind: "flow",
      subjectId: "flow-1",
      phase: "failed",
      recordedAt: 8,
      summary: "orphaned",
    },
  ];

  const result = await reconcileRuntimeChainArtifactsOnStartup({
    teamThreadStore: {
      async list() {
        return threads;
      },
    } as any,
    runtimeChainStore: {
      async listAll() {
        return chains;
      },
      async listByThread() {
        return [];
      },
    } as any,
    runtimeChainStatusStore: {
      async listAll() {
        return statuses;
      },
      async listByThread() {
        return [];
      },
    } as any,
    runtimeChainSpanStore: {
      async listAll() {
        return spans;
      },
      async listByChain() {
        return [];
      },
    } as any,
    runtimeChainEventStore: {
      async listAll() {
        return events;
      },
      async listByChain() {
        return [];
      },
    } as any,
  });

  assert.deepEqual(result, {
    orphanedStatuses: 1,
    crossThreadStatuses: 1,
    orphanedSpans: 1,
    crossThreadSpans: 1,
    crossFlowSpans: 1,
    orphanedEvents: 1,
    missingSpanEvents: 1,
    crossThreadEvents: 1,
    crossChainEvents: 1,
    affectedChainIds: ["chain:ok", "chain:missing"],
  });
});
