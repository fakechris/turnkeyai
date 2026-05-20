import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FilePermissionCacheStore } from "@turnkeyai/team-store/governance/file-permission-cache-store";

import { composeMissionDeps } from "./composition/mission-deps";
import {
  createMissionToolPermissionService,
  recordApprovalDecision,
} from "./tool-permission-service";

test("mission tool permission service files, resolves, and applies approval decisions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-tool-permission-"));
  try {
    const clock = { now: () => 1_700_000_000_000 };
    const missionDeps = composeMissionDeps({ dataDir: dir, clock });
    const permissionCacheStore = new FilePermissionCacheStore({
      rootDir: path.join(dir, "governance", "permission-cache"),
    });
    await missionDeps.missionStore.putRaw({
      id: "msn.1",
      shortId: "MSN-0001",
      title: "Submit form",
      desc: "",
      status: "working",
      mode: "browser",
      modeLabel: "Browser",
      owner: "you",
      ownerLabel: "You",
      createdAt: new Date(clock.now()).toISOString(),
      createdAtMs: clock.now(),
      agents: ["role-lead"],
      progress: 0,
      pendingApprovals: 0,
      blockers: 0,
      contextSummary: [],
      threadId: "thread-1",
    });
    const service = createMissionToolPermissionService({
      missionStore: missionDeps.missionStore,
      approvalStore: missionDeps.approvalStore,
      activityStore: missionDeps.activityStore,
      permissionCacheStore,
      clock,
      newEventId: () => "ev.permission",
    });

    const query = await service.request({
      threadId: "thread-1",
      roleId: "role-lead",
      roleName: "Lead",
      toolCallId: "call-1",
      action: "browser.form.submit",
      title: "Submit pricing form",
      risk: "Submits account data.",
      requirement: {
        level: "approval",
        scope: "mutate",
        rationale: "Needed to inspect the post-submit result.",
      },
      payload: { url: "https://example.com/pricing" },
    });
    assert.equal(query.status, "pending");
    assert.equal(query.approvalId, "ap.thread-1.call-1");

    const pending = await service.result({ threadId: "thread-1", approvalId: query.approvalId! });
    assert.equal(pending.status, "pending");

    await recordApprovalDecision({
      approvalStore: missionDeps.approvalStore,
      activityStore: missionDeps.activityStore,
      clock,
      newEventId: () => "ev.decision",
      approvalId: query.approvalId!,
      decision: "approved",
      decidedBy: "operator",
    });

    const approved = await service.result({ threadId: "thread-1", approvalId: query.approvalId! });
    assert.equal(approved.status, "approved");
    const applied = await service.apply({ threadId: "thread-1", approvalId: query.approvalId! });
    assert.equal(applied.status, "applied");
    assert.equal(applied.cacheKey, "thread-1:browser:mutate:approval");
    const cached = await permissionCacheStore.get("thread-1:browser:mutate:approval");
    assert.equal(cached?.decision, "granted");

    const events = await missionDeps.activityStore.listByMission("msn.1");
    assert.ok(events.some((event) => event.runtime?.eventType === "permission.query"));
    assert.ok(events.some((event) => event.runtime?.eventType === "permission.result"));
    assert.ok(events.some((event) => event.runtime?.eventType === "permission.applied"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mission tool permission service reuses pending approvals for the same cache key", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-tool-permission-reuse-"));
  try {
    const clock = { now: () => 1_700_000_000_000 };
    const missionDeps = composeMissionDeps({ dataDir: dir, clock });
    const permissionCacheStore = new FilePermissionCacheStore({
      rootDir: path.join(dir, "governance", "permission-cache"),
    });
    await missionDeps.missionStore.putRaw({
      id: "msn.1",
      shortId: "MSN-0001",
      title: "Submit form",
      desc: "",
      status: "working",
      mode: "browser",
      modeLabel: "Browser",
      owner: "you",
      ownerLabel: "You",
      createdAt: new Date(clock.now()).toISOString(),
      createdAtMs: clock.now(),
      agents: ["role-lead"],
      progress: 0,
      pendingApprovals: 0,
      blockers: 0,
      contextSummary: [],
      threadId: "thread-1",
    });
    const service = createMissionToolPermissionService({
      missionStore: missionDeps.missionStore,
      approvalStore: missionDeps.approvalStore,
      activityStore: missionDeps.activityStore,
      permissionCacheStore,
      clock,
      newEventId: () => `ev.${Math.random()}`,
    });

    const first = await service.request({
      threadId: "thread-1",
      roleId: "role-lead",
      roleName: "Lead",
      toolCallId: "call-1",
      action: "browser.form.submit",
      title: "Submit pricing form",
      risk: "Submits account data.",
      requirement: {
        level: "approval",
        scope: "mutate",
        rationale: "Needed to inspect the post-submit result.",
        cacheKey: "thread-1:browser:mutate:approval:browser.form.submit",
      },
    });
    const second = await service.request({
      threadId: "thread-1",
      roleId: "role-lead",
      roleName: "Lead",
      toolCallId: "call-2",
      action: "browser.form.submit",
      title: "Submit pricing form",
      risk: "Submits account data.",
      requirement: {
        level: "approval",
        scope: "mutate",
        rationale: "Needed to inspect the post-submit result.",
        cacheKey: "thread-1:browser:mutate:approval:browser.form.submit",
      },
    });

    assert.equal(first.approvalId, "ap.thread-1.call-1");
    assert.equal(second.approvalId, first.approvalId);
    assert.equal((await missionDeps.approvalStore.list()).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
