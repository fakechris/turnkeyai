import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { composeMissionDeps } from "./composition/mission-deps";
import { createMissionTaskToolService } from "./mission-task-tool-service";

test("mission task tool service creates, lists, updates, and records timeline events", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-mission-task-tools-"));
  try {
    let now = 1_700_000_000_000;
    let taskSeq = 0;
    let msgSeq = 0;
    const missionDeps = composeMissionDeps({
      dataDir: dir,
      clock: { now: () => now++ },
    });
    await missionDeps.missionStore.putRaw({
      id: "msn.1",
      shortId: "MSN-0001",
      title: "Research launch plan",
      desc: "",
      status: "working",
      mode: "research",
      modeLabel: "Research",
      owner: "you",
      ownerLabel: "You",
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      agents: ["role-lead"],
      progress: 0,
      pendingApprovals: 0,
      blockers: 0,
      contextSummary: [],
      threadId: "thread-1",
    });
    const service = createMissionTaskToolService({
      missionStore: missionDeps.missionStore,
      workItemStore: missionDeps.workItemStore,
      activityStore: missionDeps.activityStore,
      clock: { now: () => now++ },
      idGenerator: {
        taskId: () => `task-${++taskSeq}`,
        messageId: () => `ev.${++msgSeq}`,
      },
    });

    const created = await service.create({
      threadId: "thread-1",
      roleId: "role-lead",
      title: "Verify browser evidence",
      status: "working",
      contextRefs: ["ctx.browser.1"],
    }) as { task: { id: string; n: number; status: string; context_refs: string[] } };
    assert.equal(created.task.id, "wi.task-1");
    assert.equal(created.task.n, 1);
    assert.equal(created.task.status, "working");
    assert.deepEqual(created.task.context_refs, ["ctx.browser.1"]);

    const duplicate = await service.create({
      threadId: "thread-1",
      roleId: "role-lead",
      title: "  verify   browser evidence ",
      status: "planning",
    }) as { task: { id: string; n: number; status: string }; deduped?: boolean };
    assert.equal(duplicate.deduped, true);
    assert.equal(duplicate.task.id, "wi.task-1");
    assert.equal(duplicate.task.n, 1);
    assert.equal(duplicate.task.status, "working");

    const listed = await service.list({
      threadId: "thread-1",
      roleId: "role-lead",
      status: "working",
    }) as { showing: number; tasks: Array<{ id: string }> };
    assert.equal(listed.showing, 1);
    assert.equal(listed.tasks[0]?.id, "wi.task-1");

    const updated = await service.update({
      threadId: "thread-1",
      roleId: "role-lead",
      workItemId: "wi.task-1",
      status: "done",
      output: "Evidence verified.",
      progress: 1,
    }) as { task: { status: string; output: string; progress: number } };
    assert.equal(updated.task.status, "done");
    assert.equal(updated.task.output, "Evidence verified.");
    assert.equal(updated.task.progress, 1);

    const events = await missionDeps.activityStore.listByMission("msn.1");
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => event.runtime?.eventType), ["task.update", "task.update"]);
    assert.deepEqual(events.map((event) => event.runtime?.workItemId), ["wi.task-1", "wi.task-1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mission task tool service serializes concurrent duplicate creates", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-mission-task-tools-concurrent-"));
  try {
    let now = 1_700_000_000_000;
    let taskSeq = 0;
    let msgSeq = 0;
    const missionDeps = composeMissionDeps({
      dataDir: dir,
      clock: { now: () => now++ },
    });
    await missionDeps.missionStore.putRaw({
      id: "msn.1",
      shortId: "MSN-0001",
      title: "Research launch plan",
      desc: "",
      status: "working",
      mode: "research",
      modeLabel: "Research",
      owner: "you",
      ownerLabel: "You",
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      agents: ["role-lead"],
      progress: 0,
      pendingApprovals: 0,
      blockers: 0,
      contextSummary: [],
      threadId: "thread-1",
    });
    const service = createMissionTaskToolService({
      missionStore: missionDeps.missionStore,
      workItemStore: missionDeps.workItemStore,
      activityStore: missionDeps.activityStore,
      clock: { now: () => now++ },
      idGenerator: {
        taskId: () => `task-${++taskSeq}`,
        messageId: () => `ev.${++msgSeq}`,
      },
    });

    const [first, second] = (await Promise.all([
      service.create({ threadId: "thread-1", roleId: "role-lead", title: "Verify browser evidence" }),
      service.create({ threadId: "thread-1", roleId: "role-lead", title: "verify   browser evidence" }),
    ])) as [
      { task: { id: string; n: number }; deduped?: boolean },
      { task: { id: string; n: number }; deduped?: boolean },
    ];

    assert.equal(first.task.id, "wi.task-1");
    assert.equal(second.task.id, "wi.task-1");
    assert.equal([first.deduped, second.deduped].filter(Boolean).length, 1);
    const listed = await service.list({ threadId: "thread-1", roleId: "role-lead" }) as { total: number; tasks: Array<{ id: string }> };
    assert.equal(listed.total, 1);
    assert.equal(listed.tasks[0]?.id, "wi.task-1");
    const events = await missionDeps.activityStore.listByMission("msn.1");
    assert.equal(events.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mission task tool service requires a mission-linked thread", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-mission-task-tools-missing-"));
  try {
    const missionDeps = composeMissionDeps({
      dataDir: dir,
      clock: { now: () => 1 },
    });
    const service = createMissionTaskToolService({
      missionStore: missionDeps.missionStore,
      workItemStore: missionDeps.workItemStore,
      activityStore: missionDeps.activityStore,
      clock: { now: () => 1 },
      idGenerator: {
        taskId: () => "task-1",
        messageId: () => "ev.1",
      },
    });

    await assert.rejects(
      service.list({ threadId: "thread-missing", roleId: "role-lead" }),
      /mission-linked thread/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
