import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileRoleScratchpadStore } from "@turnkeyai/team-store/context/file-role-scratchpad-store";
import { FileThreadJournalStore } from "@turnkeyai/team-store/context/file-thread-journal-store";
import { FileThreadMemoryStore } from "@turnkeyai/team-store/context/file-thread-memory-store";
import { FileThreadSessionMemoryStore } from "@turnkeyai/team-store/context/file-thread-session-memory-store";
import { FileThreadSummaryStore } from "@turnkeyai/team-store/context/file-thread-summary-store";
import { FileWorkerEvidenceDigestStore } from "@turnkeyai/team-store/context/file-worker-evidence-digest-store";
import { FileWorkspaceMemoryStore } from "@turnkeyai/team-store/context/file-workspace-memory-store";
import { SqliteMemorySearchIndex } from "@turnkeyai/team-store/context/sqlite-memory-search-index";

import { DefaultRoleMemoryResolver } from "./role-memory-resolver";

test("role memory resolver prefers typed hybrid-index memory and keeps direct get ranking-independent", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "role-memory-resolver-hybrid-"),
  );
  try {
    const memorySearchIndex = new SqliteMemorySearchIndex({
      dbPath: path.join(tempDir, "index", "memory.sqlite"),
    });
    const workspaceMemoryStore = new FileWorkspaceMemoryStore({
      rootDir: path.join(tempDir, "workspace"),
      index: memorySearchIndex,
    });
    await workspaceMemoryStore.commit({
      workspaceId: "thread-1",
      expectedLastSequence: 0,
      cursor: {
        workspaceId: "thread-1",
        lastSequence: 1,
        updatedAt: 10,
      },
      audit: {
        auditId: "audit-1",
        workspaceId: "thread-1",
        trigger: "manual",
        sourceEventIds: ["user:1"],
        mutations: [],
        rejectedMutations: [],
        beforeDigest: "",
        afterDigest: "",
        startedAt: 10,
        completedAt: 11,
        status: "written",
      },
      mutations: [
        {
          kind: "add",
          record: {
            memoryId: "memory:alpha-482",
            plane: "workspace",
            scope: {
              workspaceId: "thread-1",
              threadId: "thread-1",
            },
            content: "Authoritative budget identifier ALPHA-482 is 500 yuan.",
            sourceRefs: ["user:1"],
            createdBy: "user",
            confidence: "authoritative",
            createdAt: 10,
            lastConfirmedAt: 10,
            supersedes: [],
            invalidationKeys: ["budget"],
          },
        },
      ],
    });
    const resolver = new DefaultRoleMemoryResolver({
      threadSummaryStore: new FileThreadSummaryStore({
        rootDir: path.join(tempDir, "summary"),
      }),
      roleScratchpadStore: new FileRoleScratchpadStore({
        rootDir: path.join(tempDir, "scratchpad"),
      }),
      workerEvidenceDigestStore: new FileWorkerEvidenceDigestStore({
        rootDir: path.join(tempDir, "worker"),
      }),
      workspaceMemoryStore,
      memorySearchIndex,
    });

    const hits = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-lead",
      queryText: "Recall ALPHA-482",
    });
    const direct = await resolver.getMemory({
      threadId: "thread-1",
      roleId: "role-lead",
      memoryId: "memory:alpha-482",
    });

    assert.equal(hits[0]?.memoryId, "memory:alpha-482");
    assert.match(hits[0]?.rationale ?? "", /weighted RRF/);
    assert.equal(direct?.memoryId, "memory:alpha-482");
    assert.match(direct?.rationale ?? "", /direct typed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("role memory resolver ranks durable preference memory above weaker journal matches", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-memory-resolver-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({ rootDir: path.join(tempDir, "summary") });
    const threadMemoryStore = new FileThreadMemoryStore({ rootDir: path.join(tempDir, "memory") });
    const threadJournalStore = new FileThreadJournalStore({ rootDir: path.join(tempDir, "journal") });
    const roleScratchpadStore = new FileRoleScratchpadStore({ rootDir: path.join(tempDir, "scratchpad") });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({ rootDir: path.join(tempDir, "worker") });

    await threadMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 10,
      preferences: ["Prefer concise executive recommendations for pricing summaries."],
      constraints: [],
      longTermNotes: [],
    });
    await threadJournalStore.put({
      threadId: "thread-1",
      dateKey: "2026-03-30",
      updatedAt: 20,
      entries: ["[Chris] Today I glanced at a pricing summary and some rough notes."],
    });

    const resolver = new DefaultRoleMemoryResolver({
      threadSummaryStore,
      threadMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      workerEvidenceDigestStore,
    });

    const hits = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-finance",
      queryText: "Need a concise pricing summary",
    });

    assert.equal(hits[0]?.source, "user-preference");
    assert.match(hits[0]?.content ?? "", /Prefer concise executive recommendations/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("role memory resolver prioritizes session memory for continuation queries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-memory-resolver-session-memory-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({ rootDir: path.join(tempDir, "summary") });
    const threadMemoryStore = new FileThreadMemoryStore({ rootDir: path.join(tempDir, "memory") });
    const threadSessionMemoryStore = new FileThreadSessionMemoryStore({ rootDir: path.join(tempDir, "session-memory") });
    const threadJournalStore = new FileThreadJournalStore({ rootDir: path.join(tempDir, "journal") });
    const roleScratchpadStore = new FileRoleScratchpadStore({ rootDir: path.join(tempDir, "scratchpad") });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({ rootDir: path.join(tempDir, "worker") });

    await threadSessionMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 20,
      activeTasks: ["Resume pricing comparison and confirm the supplier shortlist."],
      openQuestions: ["Which supplier should we escalate for approval?"],
      recentDecisions: ["Use browser evidence before finalizing the recommendation."],
      constraints: ["Budget must stay under $500."],
      continuityNotes: ["Waiting on browser snapshot refresh before the next step."],
      latestJournalEntries: ["[Lead] Revisit pricing notes after the browser run."],
    });

    const resolver = new DefaultRoleMemoryResolver({
      threadSummaryStore,
      threadMemoryStore,
      threadSessionMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      workerEvidenceDigestStore,
    });

    const hits = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-operator",
      queryText: "Continue the task and tell me what is pending or waiting next.",
    });

    assert.equal(hits[0]?.source, "session-memory");
    assert.match(hits[0]?.content ?? "", /Resume pricing comparison|Waiting on browser snapshot refresh/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("role memory resolver reads an exact memory id without depending on search ranking", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-memory-resolver-get-memory-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({ rootDir: path.join(tempDir, "summary") });
    const threadMemoryStore = new FileThreadMemoryStore({ rootDir: path.join(tempDir, "memory") });
    const roleScratchpadStore = new FileRoleScratchpadStore({ rootDir: path.join(tempDir, "scratchpad") });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({ rootDir: path.join(tempDir, "worker") });

    await threadMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 10,
      preferences: [],
      constraints: ["Never auto-submit forms without approval."],
      longTermNotes: ["Use direct provider APIs before browser fallback."],
    });

    const resolver = new DefaultRoleMemoryResolver({
      threadSummaryStore,
      threadMemoryStore,
      roleScratchpadStore,
      workerEvidenceDigestStore,
    });

    const [candidate] = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-lead",
      queryText: "direct provider APIs",
    });
    assert.ok(candidate);
    assert.match(candidate.memoryId, /^thread-1:note:[a-f0-9]{16}$/);

    const hit = await resolver.getMemory({
      threadId: "thread-1",
      roleId: "role-lead",
      memoryId: candidate.memoryId,
    });
    const missing = await resolver.getMemory({
      threadId: "thread-1",
      roleId: "role-lead",
      memoryId: "thread-1:note:999",
    });

    assert.equal(hit?.memoryId, candidate.memoryId);
    assert.match(hit?.content ?? "", /direct provider APIs/);
    assert.equal(missing, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("role memory ids survive note reordering between search and direct get", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-memory-resolver-stable-id-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({ rootDir: path.join(tempDir, "summary") });
    const threadMemoryStore = new FileThreadMemoryStore({ rootDir: path.join(tempDir, "memory") });
    const roleScratchpadStore = new FileRoleScratchpadStore({ rootDir: path.join(tempDir, "scratchpad") });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({ rootDir: path.join(tempDir, "worker") });
    await threadMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 10,
      preferences: [],
      constraints: [],
      longTermNotes: ["Aurora-19 launches Friday at 14:15.", "Older background."],
    });
    const resolver = new DefaultRoleMemoryResolver({
      threadSummaryStore,
      threadMemoryStore,
      roleScratchpadStore,
      workerEvidenceDigestStore,
    });

    const [candidate] = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-lead",
      queryText: "Aurora-19 Friday 14:15",
    });
    assert.ok(candidate);

    await threadMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 20,
      preferences: [],
      constraints: [],
      longTermNotes: ["New compacted note.", "Older background.", "Aurora-19 launches Friday at 14:15."],
    });
    const hit = await resolver.getMemory({
      threadId: "thread-1",
      roleId: "role-lead",
      memoryId: candidate.memoryId,
    });

    assert.equal(hit?.memoryId, candidate.memoryId);
    assert.match(hit?.content ?? "", /Aurora-19 launches Friday at 14:15/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("role memory resolver suppresses weak observational evidence unless the query explicitly asks for evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-memory-resolver-evidence-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({ rootDir: path.join(tempDir, "summary") });
    const threadMemoryStore = new FileThreadMemoryStore({ rootDir: path.join(tempDir, "memory") });
    const threadJournalStore = new FileThreadJournalStore({ rootDir: path.join(tempDir, "journal") });
    const roleScratchpadStore = new FileRoleScratchpadStore({ rootDir: path.join(tempDir, "scratchpad") });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({ rootDir: path.join(tempDir, "worker") });

    await workerEvidenceDigestStore.put({
      workerRunKey: "worker-1",
      threadId: "thread-1",
      workerType: "browser",
      status: "completed",
      updatedAt: 20,
      findings: ["Observed a public pricing page with an entry tier."],
      artifactIds: [],
      trustLevel: "observational",
      admissionMode: "summary_only",
      sourceType: "browser",
    });

    const resolver = new DefaultRoleMemoryResolver({
      threadSummaryStore,
      threadMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      workerEvidenceDigestStore,
    });

    const genericHits = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-finance",
      queryText: "Need a concise pricing summary",
    });
    const routingHits = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-finance",
      queryText: "Use the browser worker to compare pricing",
    });
    const evidenceHits = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-finance",
      queryText: "Need browser evidence and source details for pricing",
    });

    assert.equal(genericHits.some((hit) => hit.source === "knowledge-note"), false);
    assert.equal(routingHits.some((hit) => hit.source === "knowledge-note"), false);
    assert.equal(evidenceHits.some((hit) => hit.source === "knowledge-note"), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("role memory resolver prioritizes pending and waiting context for continuation-style queries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-memory-resolver-continuation-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({ rootDir: path.join(tempDir, "summary") });
    const threadMemoryStore = new FileThreadMemoryStore({ rootDir: path.join(tempDir, "memory") });
    const threadJournalStore = new FileThreadJournalStore({ rootDir: path.join(tempDir, "journal") });
    const roleScratchpadStore = new FileRoleScratchpadStore({ rootDir: path.join(tempDir, "scratchpad") });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({ rootDir: path.join(tempDir, "worker") });

    await roleScratchpadStore.put({
      threadId: "thread-1",
      roleId: "role-operator",
      updatedAt: 20,
      sourceMessageCount: 5,
      completedWork: ["Collected vendor shortlist."],
      pendingWork: ["Pending: confirm the supplier shortlist and next follow up."],
      waitingOn: "Waiting on the browser pricing snapshot before final recommendation.",
      evidenceRefs: [],
    });
    await threadJournalStore.put({
      threadId: "thread-1",
      dateKey: "2026-03-30",
      updatedAt: 30,
      entries: ["[Lead] Need to revisit pricing notes if the browser run fails."],
    });

    const resolver = new DefaultRoleMemoryResolver({
      threadSummaryStore,
      threadMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      workerEvidenceDigestStore,
    });

    const hits = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-operator",
      queryText: "Continue the task and tell me what is pending or waiting next.",
    });

    assert.match(hits[0]?.content ?? "", /Pending: confirm the supplier shortlist|Waiting on the browser pricing snapshot/);
    assert.ok(hits.some((hit) => /Waiting on the browser pricing snapshot/.test(hit.content)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("role memory resolver gives evidence queries a non-zero prior for admitted evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-memory-resolver-evidence-floor-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({ rootDir: path.join(tempDir, "summary") });
    const threadMemoryStore = new FileThreadMemoryStore({ rootDir: path.join(tempDir, "memory") });
    const threadJournalStore = new FileThreadJournalStore({ rootDir: path.join(tempDir, "journal") });
    const roleScratchpadStore = new FileRoleScratchpadStore({ rootDir: path.join(tempDir, "scratchpad") });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({ rootDir: path.join(tempDir, "worker") });

    await workerEvidenceDigestStore.put({
      workerRunKey: "worker-2",
      threadId: "thread-1",
      workerType: "browser",
      status: "completed",
      updatedAt: 20,
      findings: ["Observed a published public page."],
      artifactIds: [],
      trustLevel: "observational",
      admissionMode: "summary_only",
      sourceType: "browser",
    });

    const resolver = new DefaultRoleMemoryResolver({
      threadSummaryStore,
      threadMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      workerEvidenceDigestStore,
    });

    const evidenceHits = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-finance",
      queryText: "Show me the evidence and citations for this claim.",
    });

    assert.equal(evidenceHits.some((hit) => hit.source === "knowledge-note"), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("role memory resolver keeps promotable evidence out of continuation recall when it carries no active follow-up signal", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-memory-resolver-continuation-evidence-prune-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({ rootDir: path.join(tempDir, "summary") });
    const threadMemoryStore = new FileThreadMemoryStore({ rootDir: path.join(tempDir, "memory") });
    const threadSessionMemoryStore = new FileThreadSessionMemoryStore({ rootDir: path.join(tempDir, "session-memory") });
    const threadJournalStore = new FileThreadJournalStore({ rootDir: path.join(tempDir, "journal") });
    const roleScratchpadStore = new FileRoleScratchpadStore({ rootDir: path.join(tempDir, "scratchpad") });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({ rootDir: path.join(tempDir, "worker") });

    await threadSessionMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 20,
      activeTasks: ["Resume the supplier review and finish the pending recommendation."],
      openQuestions: ["Which supplier is still waiting on approval?"],
      recentDecisions: [],
      constraints: [],
      continuityNotes: ["Waiting on the browser pricing snapshot before the next step."],
      latestJournalEntries: [],
    });
    await workerEvidenceDigestStore.put({
      workerRunKey: "worker-promotable-1",
      threadId: "thread-1",
      workerType: "browser",
      status: "completed",
      updatedAt: 30,
      findings: ["Visited the public pricing page and captured the entry plan."],
      artifactIds: [],
      trustLevel: "promotable",
      admissionMode: "full",
      sourceType: "browser",
    });

    const resolver = new DefaultRoleMemoryResolver({
      threadSummaryStore,
      threadMemoryStore,
      threadSessionMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      workerEvidenceDigestStore,
    });

    const hits = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-finance",
      queryText: "Continue the task and tell me what is pending or waiting next.",
    });

    assert.equal(hits.some((hit) => hit.source === "knowledge-note"), false);
    assert.equal(hits[0]?.source, "session-memory");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("role memory resolver keeps promotable evidence reachable for continuation recall when the evidence itself carries the blocker", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-memory-resolver-continuation-evidence-keep-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({ rootDir: path.join(tempDir, "summary") });
    const threadMemoryStore = new FileThreadMemoryStore({ rootDir: path.join(tempDir, "memory") });
    const threadSessionMemoryStore = new FileThreadSessionMemoryStore({ rootDir: path.join(tempDir, "session-memory") });
    const threadJournalStore = new FileThreadJournalStore({ rootDir: path.join(tempDir, "journal") });
    const roleScratchpadStore = new FileRoleScratchpadStore({ rootDir: path.join(tempDir, "scratchpad") });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({ rootDir: path.join(tempDir, "worker") });

    await threadSessionMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 20,
      activeTasks: ["Resume the supplier review."],
      openQuestions: ["Which supplier is still waiting on approval?"],
      recentDecisions: [],
      constraints: [],
      continuityNotes: ["Keep the approval blocker visible."],
      latestJournalEntries: [],
    });
    await workerEvidenceDigestStore.put({
      workerRunKey: "worker-promotable-2",
      threadId: "thread-1",
      workerType: "browser",
      status: "partial",
      updatedAt: 30,
      findings: ["Approval is still pending before the browser retry can continue."],
      artifactIds: [],
      trustLevel: "promotable",
      admissionMode: "summary_only",
      sourceType: "browser",
    });

    const resolver = new DefaultRoleMemoryResolver({
      threadSummaryStore,
      threadMemoryStore,
      threadSessionMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      workerEvidenceDigestStore,
    });

    const hits = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-finance",
      queryText: "Continue the task and tell me what is pending or waiting next.",
    });

    assert.equal(hits.some((hit) => hit.source === "knowledge-note"), true);
    assert.ok(hits.some((hit) => /approval is still pending before the browser retry can continue/i.test(hit.content)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("role memory resolver prioritizes merge follow-up memory for unresolved shard queries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-memory-resolver-merge-followup-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({ rootDir: path.join(tempDir, "summary") });
    const threadMemoryStore = new FileThreadMemoryStore({ rootDir: path.join(tempDir, "memory") });
    const threadJournalStore = new FileThreadJournalStore({ rootDir: path.join(tempDir, "journal") });
    const roleScratchpadStore = new FileRoleScratchpadStore({ rootDir: path.join(tempDir, "scratchpad") });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({ rootDir: path.join(tempDir, "worker") });

    await threadSummaryStore.put({
      threadId: "thread-1",
      summaryVersion: 1,
      updatedAt: 10,
      sourceMessageCount: 5,
      userGoal: "Merge the research and finance shards.",
      stableFacts: [],
      decisions: [],
      openQuestions: ["Missing finance shard follow-up because the merge still has a conflict."],
    });

    const resolver = new DefaultRoleMemoryResolver({
      threadSummaryStore,
      threadMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      workerEvidenceDigestStore,
    });

    const hits = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-lead",
      queryText: "What merge follow up remains and which shard is still missing or in conflict?",
    });

    assert.match(hits[0]?.content ?? "", /Missing finance shard follow-up/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("role memory resolver keeps approval and merge memory reachable through semantic recall", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-memory-resolver-semantic-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({ rootDir: path.join(tempDir, "summary") });
    const threadMemoryStore = new FileThreadMemoryStore({ rootDir: path.join(tempDir, "memory") });
    const threadJournalStore = new FileThreadJournalStore({ rootDir: path.join(tempDir, "journal") });
    const roleScratchpadStore = new FileRoleScratchpadStore({ rootDir: path.join(tempDir, "scratchpad") });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({ rootDir: path.join(tempDir, "worker") });

    await threadSummaryStore.put({
      threadId: "thread-1",
      summaryVersion: 1,
      updatedAt: 10,
      sourceMessageCount: 8,
      userGoal: "Finish the merge decision.",
      stableFacts: [],
      decisions: [],
      openQuestions: ["Finance shard merge is unresolved and still waiting on operator approval."],
    });
    await roleScratchpadStore.put({
      threadId: "thread-1",
      roleId: "role-lead",
      updatedAt: 20,
      sourceMessageCount: 8,
      completedWork: ["Research shard completed."],
      pendingWork: ["Pending: continue the merge after approval and resolve the missing finance shard."],
      waitingOn: "Waiting on operator approval before the resume can continue.",
      evidenceRefs: [],
    });

    const resolver = new DefaultRoleMemoryResolver({
      threadSummaryStore,
      threadMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      workerEvidenceDigestStore,
    });

    const hits = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-lead",
      queryText: "What still needs manual review before the shard merge can continue?",
    });

    assert.ok(hits.some((hit) => /operator approval/i.test(hit.content)));
    assert.ok(hits.some((hit) => /missing finance shard/i.test(hit.content)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("role memory resolver treats blocker wording as continuation recall", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-memory-resolver-blocker-"));

  try {
    const threadSummaryStore = new FileThreadSummaryStore({ rootDir: path.join(tempDir, "summary") });
    const threadMemoryStore = new FileThreadMemoryStore({ rootDir: path.join(tempDir, "memory") });
    const threadSessionMemoryStore = new FileThreadSessionMemoryStore({ rootDir: path.join(tempDir, "session-memory") });
    const threadJournalStore = new FileThreadJournalStore({ rootDir: path.join(tempDir, "journal") });
    const roleScratchpadStore = new FileRoleScratchpadStore({ rootDir: path.join(tempDir, "scratchpad") });
    const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({ rootDir: path.join(tempDir, "worker") });

    await threadSessionMemoryStore.put({
      threadId: "thread-1",
      updatedAt: 20,
      activeTasks: ["Supplier review is paused on the login checkpoint."],
      openQuestions: ["Browser blocker: login expired before the pricing capture."],
      recentDecisions: [],
      constraints: [],
      continuityNotes: ["Keep the browser blocker visible until the login checkpoint is restored."],
      latestJournalEntries: [],
    });

    const resolver = new DefaultRoleMemoryResolver({
      threadSummaryStore,
      threadMemoryStore,
      threadSessionMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      workerEvidenceDigestStore,
    });

    const hits = await resolver.retrieveMemory({
      threadId: "thread-1",
      roleId: "role-operator",
      queryText: "What blocker remains before we proceed?",
    });

    assert.ok(hits.some((hit) => /browser blocker/i.test(hit.content)));
    assert.equal(hits[0]?.source, "session-memory");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
