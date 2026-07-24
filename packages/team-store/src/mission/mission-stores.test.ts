import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ActivityEvent,
  Agent,
  ApprovalRequest,
  Artifact,
  ContextSource,
  Mission,
  WorkItem,
} from "@turnkeyai/core-types/mission";

import { FileActivityEventStore } from "./file-activity-event-store";
import { FileAgentRegistry } from "./file-agent-registry";
import { FileApprovalRequestStore } from "./file-approval-request-store";
import { FileArtifactStore } from "./file-artifact-store";
import { FileContextSourceRegistry } from "./file-context-source-registry";
import { FileMissionStore } from "./file-mission-store";
import { FileWorkItemStore } from "./file-work-item-store";

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-mission-store-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const clock = { now: () => 1_700_000_000_000 };

describe("FileMissionStore", () => {
  it("create then get round-trips a mission with status=draft", async () => {
    const t = tmp();
    try {
      const store = new FileMissionStore({ rootDir: t.dir });
      const mission = await store.create(
        {
          title: "Test mission",
          desc: "desc",
          mode: "research",
          modeLabel: "Research",
          owner: "you",
          ownerLabel: "You",
          agents: ["agent.a"],
        },
        {
          missionIdGen: () => "msn.test",
          shortIdGen: () => "MSN-TEST",
          clock,
        }
      );
      assert.equal(mission.id, "msn.test");
      assert.equal(mission.status, "draft");
      assert.equal(mission.createdAtMs, clock.now());
      const reloaded = await store.get("msn.test");
      assert.deepEqual(reloaded, mission);
    } finally {
      t.cleanup();
    }
  });

  it("list returns every persisted mission", async () => {
    const t = tmp();
    try {
      const store = new FileMissionStore({ rootDir: t.dir });
      let counter = 0;
      for (const title of ["A", "B", "C"]) {
        await store.create(
          {
            title,
            desc: "",
            mode: "custom",
            modeLabel: "Custom",
            owner: "you",
            ownerLabel: "You",
            agents: [],
          },
          {
            missionIdGen: () => `msn.${++counter}`,
            shortIdGen: () => `MSN-${counter}`,
            clock,
          }
        );
      }
      const all = await store.list();
      assert.equal(all.length, 3);
      assert.deepEqual(all.map((m) => m.title).sort(), ["A", "B", "C"]);
    } finally {
      t.cleanup();
    }
  });

  it("putRaw upserts a fully-formed mission (used by bootstrap-demo)", async () => {
    const t = tmp();
    try {
      const store = new FileMissionStore({ rootDir: t.dir });
      const mission: Mission = {
        id: "msn.fixture",
        shortId: "MSN-FX",
        title: "fixture",
        desc: "",
        status: "working",
        mode: "research",
        modeLabel: "Research",
        owner: "you",
        ownerLabel: "You",
        createdAt: "today",
        createdAtMs: clock.now(),
        agents: [],
        progress: 0.5,
        pendingApprovals: 0,
        blockers: 0,
        contextSummary: [],
      };
      await store.putRaw(mission);
      assert.deepEqual(await store.get("msn.fixture"), mission);
    } finally {
      t.cleanup();
    }
  });
});

describe("FileWorkItemStore", () => {
  it("listByMission returns items sorted by n", async () => {
    const t = tmp();
    try {
      const store = new FileWorkItemStore({ rootDir: t.dir });
      const items: WorkItem[] = [3, 1, 2].map((n) => ({
        id: `wi.${n}`,
        missionId: "msn.test",
        n,
        title: `Item ${n}`,
        agent: "agent.a",
        status: "draft",
        started: "—",
        duration: "—",
        contextRefs: [],
        output: "—",
      }));
      for (const item of items) await store.put(item);
      const out = await store.listByMission("msn.test");
      assert.deepEqual(
        out.map((w) => w.n),
        [1, 2, 3]
      );
    } finally {
      t.cleanup();
    }
  });

  it("returns empty for an unknown mission without throwing", async () => {
    const t = tmp();
    try {
      const store = new FileWorkItemStore({ rootDir: t.dir });
      assert.deepEqual(await store.listByMission("msn.nope"), []);
    } finally {
      t.cleanup();
    }
  });

  it("read path does NOT create the per-mission directory (codex K2 #1)", async () => {
    // Regression: prior listByMission mkdir'd the per-mission folder
    // before reading, which would let any read-token caller mint
    // arbitrary mission directories on disk by polling unknown IDs.
    const t = tmp();
    try {
      const store = new FileWorkItemStore({ rootDir: t.dir });
      await store.listByMission("msn.attacker-controlled");
      const { readdir } = await import("node:fs/promises");
      let entries: string[] = [];
      try {
        entries = await readdir(t.dir);
      } catch {
        // rootDir doesn't exist at all → even better.
      }
      assert.deepEqual(
        entries,
        [],
        "rootDir must remain empty — read path must not create mission folders"
      );
    } finally {
      t.cleanup();
    }
  });

  it("persists one authoritative bidirectional dependency graph", async () => {
    const t = tmp();
    try {
      const store = new FileWorkItemStore({ rootDir: t.dir });
      const dependency = graphItem("wi.1", 1, "done", [], ["wi.2"]);
      const dependent = graphItem("wi.2", 2, "planning", ["wi.1"], []);
      await store.putGraph("msn.test", [dependent, dependency]);

      const reloaded = await store.listByMission("msn.test");
      assert.deepEqual(reloaded.map((item) => item.id), ["wi.1", "wi.2"]);
      assert.deepEqual(
        reloaded[0]?.specification?.blocks,
        ["wi.2"],
      );
      assert.deepEqual(
        reloaded[1]?.specification?.blockedBy,
        ["wi.1"],
      );
    } finally {
      t.cleanup();
    }
  });

  it("rejects dependency cycles and activation while dependencies are open", async () => {
    const t = tmp();
    try {
      const store = new FileWorkItemStore({ rootDir: t.dir });
      const valid = [
        graphItem("wi.1", 1, "planning", [], ["wi.2"]),
        graphItem("wi.2", 2, "planning", ["wi.1"], []),
      ];
      await store.putGraph("msn.test", valid);
      await assert.rejects(
        store.putGraph("msn.test", [
          graphItem("wi.1", 1, "planning", ["wi.2"], ["wi.2"]),
          graphItem("wi.2", 2, "planning", ["wi.1"], ["wi.1"]),
        ]),
        /dependency cycle/,
      );
      await assert.rejects(
        store.putGraph("msn.test", [
          graphItem("wi.1", 1, "planning", [], ["wi.2"]),
          graphItem("wi.2", 2, "working", ["wi.1"], []),
        ]),
        /blocked work item cannot be working/,
      );
      const restarted = new FileWorkItemStore({ rootDir: t.dir });
      assert.deepEqual(
        await restarted.listByMission("msn.test"),
        valid,
        "rejected graph mutations must not replace the last valid snapshot",
      );
    } finally {
      t.cleanup();
    }
  });

  it("requires receipts for completion and operator receipts for waivers", async () => {
    const t = tmp();
    try {
      const store = new FileWorkItemStore({ rootDir: t.dir });
      const incomplete = graphItem("wi.1", 1, "done", [], []);
      incomplete.specification!.acceptanceCriteria = [{
        id: "criterion-1",
        description: "Report exists",
        required: true,
        state: "unverified",
      }];
      await assert.rejects(
        store.putGraph("msn.test", [incomplete]),
        /required acceptance criterion is not satisfied/,
      );

      const invalidWaiver = structuredClone(incomplete);
      invalidWaiver.specification!.acceptanceCriteria[0]!.state = "waived";
      invalidWaiver.specification!.verificationReceipts = [{
        receiptId: "receipt.1",
        criterionId: "criterion-1",
        kind: "artifact",
        ref: "artifact://report",
        verifier: "role-lead",
        result: "waived",
        verifiedAt: 1,
      }];
      await assert.rejects(
        store.putGraph("msn.test", [invalidWaiver]),
        /waived criterion requires operator decision/,
      );

      const completed = structuredClone(incomplete);
      completed.specification!.acceptanceCriteria[0]!.state = "passed";
      completed.specification!.verificationReceipts = [{
        receiptId: "receipt.2",
        criterionId: "criterion-1",
        kind: "artifact",
        ref: "artifact://report",
        verifier: "role-lead",
        result: "passed",
        verifiedAt: 2,
      }];
      await store.putGraph("msn.test", [completed]);
      assert.equal(
        (await store.listByMission("msn.test"))[0]?.status,
        "done",
      );
    } finally {
      t.cleanup();
    }
  });
});

function graphItem(
  id: string,
  n: number,
  status: WorkItem["status"],
  blockedBy: string[],
  blocks: string[],
): WorkItem {
  return {
    id,
    missionId: "msn.test",
    n,
    title: `Item ${n}`,
    agent: "agent.a",
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

describe("FileActivityEventStore", () => {
  const e = (id: string, missionId: string, tMs: number, kind: ActivityEvent["kind"]): ActivityEvent => ({
    id,
    missionId,
    t: "00:00:00",
    tMs,
    kind,
    actor: "agent.a",
    text: id,
  });

  it("append then listByMission preserves order by tMs and id", async () => {
    const t = tmp();
    try {
      const store = new FileActivityEventStore({ rootDir: t.dir });
      await store.append(e("c", "msn.x", 3, "tool"));
      await store.append(e("a", "msn.x", 1, "plan"));
      await store.append(e("b", "msn.x", 2, "thought"));
      await store.append(e("b-2", "msn.x", 2, "thought"));
      const out = await store.listByMission("msn.x");
      assert.deepEqual(
        out.map((ev) => ev.id),
        ["a", "b", "b-2", "c"]
      );
    } finally {
      t.cleanup();
    }
  });

  it("limit returns the last N (tail semantics)", async () => {
    const t = tmp();
    try {
      const store = new FileActivityEventStore({ rootDir: t.dir });
      for (let i = 0; i < 10; i++) await store.append(e(`e${i}`, "msn.y", i, "tool"));
      const out = await store.listByMission("msn.y", { limit: 3 });
      assert.deepEqual(
        out.map((ev) => ev.id),
        ["e7", "e8", "e9"]
      );
    } finally {
      t.cleanup();
    }
  });

  it("before cursor returns the previous timeline page with stable tie-breaking", async () => {
    const t = tmp();
    try {
      const store = new FileActivityEventStore({ rootDir: t.dir });
      await store.append(e("e1", "msn.cursor", 1, "tool"));
      await store.append(e("e2a", "msn.cursor", 2, "tool"));
      await store.append(e("e2b", "msn.cursor", 2, "tool"));
      await store.append(e("e3", "msn.cursor", 3, "tool"));
      const out = await store.listByMission("msn.cursor", {
        before: { tMs: 2, id: "e2b" },
        limit: 2,
      });
      assert.deepEqual(
        out.map((ev) => ev.id),
        ["e1", "e2a"]
      );
    } finally {
      t.cleanup();
    }
  });

  it("listByMission returns [] for missing log file", async () => {
    const t = tmp();
    try {
      const store = new FileActivityEventStore({ rootDir: t.dir });
      assert.deepEqual(await store.listByMission("msn.nope"), []);
    } finally {
      t.cleanup();
    }
  });

  it("replaceAll wipes prior content", async () => {
    const t = tmp();
    try {
      const store = new FileActivityEventStore({ rootDir: t.dir });
      await store.append(e("old", "msn.z", 0, "tool"));
      await store.replaceAll("msn.z", [e("new", "msn.z", 1, "plan")]);
      const out = await store.listByMission("msn.z");
      assert.deepEqual(
        out.map((ev) => ev.id),
        ["new"]
      );
    } finally {
      t.cleanup();
    }
  });

  it("skips malformed JSONL lines without throwing", async () => {
    const t = tmp();
    try {
      const store = new FileActivityEventStore({ rootDir: t.dir });
      await store.append(e("good", "msn.q", 1, "tool"));
      // Forge a bad line via the underlying file.
      const { appendFile } = await import("node:fs/promises");
      await appendFile(path.join(t.dir, "msn.q.jsonl"), "not-json-here\n", "utf8");
      await store.append(e("good2", "msn.q", 2, "tool"));
      const out = await store.listByMission("msn.q");
      assert.deepEqual(
        out.map((ev) => ev.id),
        ["good", "good2"]
      );
    } finally {
      t.cleanup();
    }
  });
});

describe("FileApprovalRequestStore", () => {
  const ap = (id: string, missionId: string): ApprovalRequest => ({
    id,
    severity: "med",
    missionId,
    missionTitle: "t",
    agent: "agent.a",
    action: "browser.snapshot",
    title: id,
    affects: [],
    risk: "low",
    requestedAt: "00:00",
    requestedAtMs: clock.now(),
    requestedAgo: "now",
    policyHint: "",
  });

  it("list returns top-level approvals, ignores decisions/ subdir", async () => {
    const t = tmp();
    try {
      const store = new FileApprovalRequestStore({ rootDir: t.dir });
      await store.put(ap("ap.a", "msn.1"));
      await store.put(ap("ap.b", "msn.2"));
      await store.putDecision({
        approvalId: "ap.a",
        decision: "approved",
        decidedBy: "you",
        decidedAtMs: clock.now(),
      });
      const out = await store.list();
      assert.equal(out.length, 2);
      assert.deepEqual(out.map((a) => a.id).sort(), ["ap.a", "ap.b"]);
    } finally {
      t.cleanup();
    }
  });

  it("listByMission filters", async () => {
    const t = tmp();
    try {
      const store = new FileApprovalRequestStore({ rootDir: t.dir });
      await store.put(ap("ap.a", "msn.1"));
      await store.put(ap("ap.b", "msn.2"));
      assert.deepEqual(
        (await store.listByMission("msn.1")).map((a) => a.id),
        ["ap.a"]
      );
    } finally {
      t.cleanup();
    }
  });

  it("getDecision returns null when no decision recorded", async () => {
    const t = tmp();
    try {
      const store = new FileApprovalRequestStore({ rootDir: t.dir });
      await store.put(ap("ap.x", "msn.1"));
      assert.equal(await store.getDecision("ap.x"), null);
    } finally {
      t.cleanup();
    }
  });
});

describe("FileArtifactStore", () => {
  it("listByMission returns artifacts sorted newest-first", async () => {
    const t = tmp();
    try {
      const store = new FileArtifactStore({ rootDir: t.dir });
      const make = (id: string, ts: number): Artifact => ({
        id,
        missionId: "msn.q",
        label: id,
        kind: "json",
        path: `/tmp/${id}`,
        createdAtMs: ts,
      });
      await store.put(make("a", 1));
      await store.put(make("b", 3));
      await store.put(make("c", 2));
      const out = await store.listByMission("msn.q");
      assert.deepEqual(
        out.map((a) => a.id),
        ["b", "c", "a"]
      );
    } finally {
      t.cleanup();
    }
  });
});

describe("FileAgentRegistry / FileContextSourceRegistry", () => {
  it("agent registry round-trips", async () => {
    const t = tmp();
    try {
      const reg = new FileAgentRegistry({ rootDir: t.dir });
      assert.deepEqual(await reg.list(), []);
      const agents: Agent[] = [
        { id: "agent.a", name: "A", role: "X", provider: "p", providerNote: "n", status: "working", ava: "Aa", color: "info", capabilities: [], missions: 0, tokensIn: "—", tokensOut: "—" },
      ];
      await reg.replaceAll(agents);
      assert.deepEqual(await reg.list(), agents);
    } finally {
      t.cleanup();
    }
  });

  it("context-source registry round-trips", async () => {
    const t = tmp();
    try {
      const reg = new FileContextSourceRegistry({ rootDir: t.dir });
      assert.deepEqual(await reg.list(), []);
      const sources: ContextSource[] = [
        { id: "ctx.a", kind: "browser", title: "a", url: "https://a", state: "attached", lastUse: "now" },
      ];
      await reg.replaceAll(sources);
      assert.deepEqual(await reg.list(), sources);
    } finally {
      t.cleanup();
    }
  });
});
