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
    const waitingMission = await missionDeps.missionStore.get("msn.1");
    assert.equal(waitingMission?.status, "needs_approval");
    assert.equal(waitingMission?.pendingApprovals, 1);

    const pending = await service.result({ threadId: "thread-1", approvalId: query.approvalId! });
    assert.equal(pending.status, "pending");
    const filedApproval = (await missionDeps.approvalStore.list()).find((approval) => approval.id === query.approvalId);
    assert.ok(filedApproval);
    await missionDeps.approvalStore.put({
      ...filedApproval,
      id: "ap.thread-1.call-old",
      requestedAt: new Date(clock.now() - 1_000).toISOString(),
      requestedAtMs: clock.now() - 1_000,
      payload: {
        ...filedApproval.payload,
        toolPermission: {
          ...(filedApproval.payload?.toolPermission as Record<string, unknown>),
          toolCallId: "call-old",
        },
      },
    });
    await missionDeps.approvalStore.putDecision({
      approvalId: "ap.thread-1.call-old",
      decision: "approved",
      decidedBy: "operator",
      decidedAtMs: clock.now() - 500,
    });

    await recordApprovalDecision({
      approvalStore: missionDeps.approvalStore,
      missionStore: missionDeps.missionStore,
      activityStore: missionDeps.activityStore,
      clock,
      newEventId: () => "ev.decision",
      approvalId: query.approvalId!,
      decision: "approved",
      decidedBy: "operator",
    });

    const approved = await service.result({ threadId: "thread-1", approvalId: query.approvalId! });
    assert.equal(approved.status, "approved");
    const approvedByCacheKey = await service.result({
      threadId: "thread-1",
      approvalId: query.requirement.cacheKey,
    });
    assert.equal(approvedByCacheKey.status, "approved");
    assert.equal(approvedByCacheKey.approvalId, query.approvalId);
    const applied = await service.apply({ threadId: "thread-1", approvalId: query.approvalId! });
    assert.equal(applied.status, "applied");
    assert.equal(applied.cacheKey, "thread-1:browser:mutate:approval");
    const appliedAgain = await service.apply({ threadId: "thread-1", approvalId: query.requirement.cacheKey });
    assert.equal(appliedAgain.status, "applied");
    assert.equal(appliedAgain.approvalId, query.approvalId);
    assert.equal(appliedAgain.cacheKey, "thread-1:browser:mutate:approval");
    assert.match(appliedAgain.message, /already applied/i);
    const alreadyGranted = await service.apply({ threadId: "thread-1", approvalId: "already_granted" });
    assert.equal(alreadyGranted.status, "applied");
    assert.equal(alreadyGranted.cacheKey, "thread-1:browser:mutate:approval");
    const cached = await permissionCacheStore.get("thread-1:browser:mutate:approval");
    assert.equal(cached?.decision, "granted");
    const resumedMission = await missionDeps.missionStore.get("msn.1");
    assert.equal(resumedMission?.status, "working");
    assert.equal(resumedMission?.pendingApprovals, 0);

    const events = await missionDeps.activityStore.listByMission("msn.1");
    assert.ok(events.some((event) => event.runtime?.eventType === "permission.query"));
    assert.ok(events.some((event) => event.runtime?.eventType === "permission.result"));
    assert.equal(
      events.filter((event) => event.runtime?.eventType === "permission.applied").length,
      1,
      "re-applying the same approval must not duplicate operator timeline events"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mission tool permission service resolves already-granted cache acknowledgements to the latest granted permission", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-tool-permission-cache-latest-"));
  try {
    const clock = { now: () => 1_700_000_000_000 };
    const missionDeps = composeMissionDeps({ dataDir: dir, clock });
    const permissionCacheStore = new FilePermissionCacheStore({
      rootDir: path.join(dir, "governance", "permission-cache"),
    });
    const service = createMissionToolPermissionService({
      missionStore: missionDeps.missionStore,
      approvalStore: missionDeps.approvalStore,
      activityStore: missionDeps.activityStore,
      permissionCacheStore,
      clock,
      newEventId: () => "ev.permission",
    });

    await permissionCacheStore.put({
      cacheKey: "thread-1:browser:mutate:approval:older",
      threadId: "thread-1",
      workerType: "browser",
      requirement: {
        level: "approval",
        scope: "mutate",
        cacheKey: "thread-1:browser:mutate:approval:older",
        rationale: "Older granted permission.",
      },
      decision: "granted",
      createdAt: clock.now() - 2_000,
      updatedAt: clock.now() - 2_000,
    });
    await permissionCacheStore.put({
      cacheKey: "thread-1:browser:mutate:approval:newer",
      threadId: "thread-1",
      workerType: "browser",
      requirement: {
        level: "approval",
        scope: "mutate",
        cacheKey: "thread-1:browser:mutate:approval:newer",
        rationale: "Newer granted permission.",
      },
      decision: "granted",
      createdAt: clock.now() - 1_000,
      updatedAt: clock.now() - 1_000,
    });

    const applied = await service.apply({ threadId: "thread-1", approvalId: "already_granted" });
    assert.equal(applied.status, "applied");
    assert.equal(applied.cacheKey, "thread-1:browser:mutate:approval:newer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mission tool permission service rejects non-tool approvals and prefers pending cache-key approvals", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-tool-permission-tool-metadata-"));
  try {
    const clock = { now: () => 1_700_000_000_000 };
    const missionDeps = composeMissionDeps({ dataDir: dir, clock });
    const permissionCacheStore = new FilePermissionCacheStore({
      rootDir: path.join(dir, "governance", "permission-cache"),
    });
    const service = createMissionToolPermissionService({
      missionStore: missionDeps.missionStore,
      approvalStore: missionDeps.approvalStore,
      activityStore: missionDeps.activityStore,
      permissionCacheStore,
      clock,
      newEventId: () => "ev.permission",
    });

    await missionDeps.approvalStore.put({
      id: "ap.generic",
      severity: "med",
      missionId: "msn.1",
      missionTitle: "Generic approval",
      agent: "role-lead",
      action: "generic.action",
      title: "Generic approval",
      affects: [],
      risk: "Generic approval without tool permission metadata.",
      requestedAt: new Date(clock.now()).toISOString(),
      requestedAtMs: clock.now(),
      requestedAgo: "just now",
      policyHint: "manual",
      payload: {},
    });
    await assert.rejects(
      service.result({ threadId: "thread-1", approvalId: "ap.generic" }),
      /missing tool permission metadata/
    );

    await missionDeps.approvalStore.put({
      id: "ap.thread-1.call-old",
      severity: "high",
      missionId: "msn.1",
      missionTitle: "Submit form",
      agent: "role-lead",
      action: "browser.form.submit",
      title: "Submit pricing form",
      affects: [],
      risk: "Submits account data.",
      requestedAt: new Date(clock.now() - 1_000).toISOString(),
      requestedAtMs: clock.now() - 1_000,
      requestedAgo: "just now",
      policyHint: "approval:mutate",
      payload: {
        toolPermission: {
          threadId: "thread-1",
          roleId: "role-lead",
          roleName: "Lead",
          toolCallId: "call-old",
          action: "browser.form.submit",
          requirement: {
            level: "approval",
            scope: "mutate",
            cacheKey: "thread-1:browser:mutate:approval:submit",
            rationale: "Needed to submit the form.",
          },
          workerType: "browser",
        },
      },
    });
    await missionDeps.approvalStore.putDecision({
      approvalId: "ap.thread-1.call-old",
      decision: "approved",
      decidedBy: "operator",
      decidedAtMs: clock.now() - 500,
    });
    await missionDeps.approvalStore.put({
      id: "ap.thread-1.call-new",
      severity: "high",
      missionId: "msn.1",
      missionTitle: "Submit form",
      agent: "role-lead",
      action: "browser.form.submit",
      title: "Submit pricing form again",
      affects: [],
      risk: "Submits account data.",
      requestedAt: new Date(clock.now()).toISOString(),
      requestedAtMs: clock.now(),
      requestedAgo: "just now",
      policyHint: "approval:mutate",
      payload: {
        toolPermission: {
          threadId: "thread-1",
          roleId: "role-lead",
          roleName: "Lead",
          toolCallId: "call-new",
          action: "browser.form.submit",
          requirement: {
            level: "approval",
            scope: "mutate",
            cacheKey: "thread-1:browser:mutate:approval:submit",
            rationale: "Needed to submit the form.",
          },
          workerType: "browser",
        },
      },
    });

    const pending = await service.result({
      threadId: "thread-1",
      approvalId: "thread-1:browser:mutate:approval:submit",
    });
    assert.equal(pending.status, "pending");
    assert.equal(pending.approvalId, "ap.thread-1.call-new");
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
    const mission = await missionDeps.missionStore.get("msn.1");
    assert.equal(mission?.status, "needs_approval");
    assert.equal(mission?.pendingApprovals, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mission tool permission service reopens prematurely done missions while approval is pending", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-tool-permission-done-race-"));
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
      status: "done",
      mode: "browser",
      modeLabel: "Browser",
      owner: "you",
      ownerLabel: "You",
      createdAt: new Date(clock.now()).toISOString(),
      createdAtMs: clock.now(),
      agents: ["role-lead"],
      progress: 1,
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
      title: "Submit local form",
      risk: "Submits isolated local test data.",
      requirement: {
        level: "approval",
        scope: "mutate",
        rationale: "Needed to verify the post-submit page state.",
      },
    });

    assert.equal(query.status, "pending");
    const reopened = await missionDeps.missionStore.get("msn.1");
    assert.equal(reopened?.status, "needs_approval");
    assert.equal(reopened?.pendingApprovals, 1);
    assert.equal(reopened?.progress, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mission tool permission service synchronizes pending approval count from approval store", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-tool-permission-count-"));
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
        rationale: "Needed to submit the form.",
        cacheKey: "thread-1:browser:mutate:approval:submit",
      },
    });
    const second = await service.request({
      threadId: "thread-1",
      roleId: "role-lead",
      roleName: "Lead",
      toolCallId: "call-2",
      action: "doc.write",
      title: "Write draft",
      risk: "Writes local document content.",
      requirement: {
        level: "approval",
        scope: "mutate",
        rationale: "Needed to write the report.",
        cacheKey: "thread-1:doc:mutate:approval:write",
        workerType: "explore",
      },
    });
    assert.equal((await missionDeps.missionStore.get("msn.1"))?.pendingApprovals, 2);
    assert.equal((await missionDeps.missionStore.get("msn.1"))?.status, "needs_approval");

    await recordApprovalDecision({
      approvalStore: missionDeps.approvalStore,
      missionStore: missionDeps.missionStore,
      activityStore: missionDeps.activityStore,
      clock,
      newEventId: () => "ev.first-decision",
      approvalId: first.approvalId!,
      decision: "approved",
      decidedBy: "operator",
    });
    assert.equal((await missionDeps.missionStore.get("msn.1"))?.pendingApprovals, 1);
    assert.equal((await missionDeps.missionStore.get("msn.1"))?.status, "needs_approval");

    await recordApprovalDecision({
      approvalStore: missionDeps.approvalStore,
      missionStore: missionDeps.missionStore,
      activityStore: missionDeps.activityStore,
      clock,
      newEventId: () => "ev.second-decision",
      approvalId: second.approvalId!,
      decision: "denied",
      decidedBy: "operator",
      reason: "Not needed.",
    });
    assert.equal((await missionDeps.missionStore.get("msn.1"))?.pendingApprovals, 0);
    assert.equal((await missionDeps.missionStore.get("msn.1"))?.status, "working");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
