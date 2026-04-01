import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileBrowserProfileStore } from "./file-browser-profile-store";
import { FileBrowserSessionStore } from "./file-browser-session-store";
import { BrowserSessionManager } from "./browser-session-manager";
import { FileBrowserTargetStore } from "./file-browser-target-store";

test("browser session manager reuses sessions, profiles, and target ownership state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-session-manager-"));

  try {
    let nowTick = 10;
    let idTick = 0;
    const manager = createManager(tempDir, () => ++nowTick, () => ++idTick);

    const firstLease = await manager.acquireSession({
      ownerType: "thread",
      ownerId: "thread-1",
      profileOwnerType: "thread",
      profileOwnerId: "thread-1",
      preferredTransport: "local",
      reusable: true,
      leaseHolderRunKey: "worker:browser:thread-1",
    });
    assert.equal(firstLease.profile.profileId, "profile-1");
    assert.equal(firstLease.session.browserSessionId, "browser-session-2");
    assert.equal(firstLease.profile.ownerType, "thread");
    assert.equal(firstLease.profile.ownerId, "thread-1");
    assert.equal(firstLease.session.leaseHolderRunKey, "worker:browser:thread-1");
    assert.match(firstLease.profile.persistentDir, /profile-1\/chrome-profile$/);

    const target = await manager.ensureTarget({
      browserSessionId: firstLease.session.browserSessionId,
      url: "https://example.com/",
      lastResumeMode: "cold",
      createIfMissing: true,
    });
    assert.equal(target.targetId, "target-3");
    assert.equal(target.ownerType, "thread");
    assert.equal(target.ownerId, "thread-1");
    assert.equal(target.lastResumeMode, "cold");

    const updatedTarget = await manager.ensureTarget({
      browserSessionId: firstLease.session.browserSessionId,
      targetId: target.targetId,
      url: "https://example.com/pricing",
      lastResumeMode: "warm",
      createIfMissing: true,
    });
    assert.equal(updatedTarget.targetId, target.targetId);
    assert.equal(updatedTarget.url, "https://example.com/pricing");
    assert.equal(updatedTarget.lastResumeMode, "warm");

    await manager.releaseSession({
      browserSessionId: firstLease.session.browserSessionId,
      leaseHolderRunKey: "worker:browser:thread-1",
      resumeMode: "warm",
    });

    const secondLease = await manager.acquireSession({
      ownerType: "thread",
      ownerId: "thread-1",
      profileOwnerType: "thread",
      profileOwnerId: "thread-1",
      preferredTransport: "local",
      reusable: true,
      leaseHolderRunKey: "worker:browser:thread-1",
    });
    assert.equal(secondLease.profile.profileId, firstLease.profile.profileId);
    assert.equal(secondLease.session.browserSessionId, firstLease.session.browserSessionId);

    const resumed = await manager.resumeSession({
      browserSessionId: secondLease.session.browserSessionId,
      ownerType: "thread",
      ownerId: "thread-1",
      leaseHolderRunKey: "worker:browser:thread-1",
    });
    assert.equal(resumed.profile.profileId, firstLease.profile.profileId);
    assert.equal(resumed.session.browserSessionId, firstLease.session.browserSessionId);
    assert.equal(resumed.session.leaseHolderRunKey, "worker:browser:thread-1");

    const targets = await manager.listTargets(firstLease.session.browserSessionId);
    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.url, "https://example.com/pricing");

    const released = secondLease.session.browserSessionId;
    await manager.closeSession(released, "test complete");
    await assert.rejects(() => manager.resumeSession(released), /browser session not found/);
    const closedTargets = await manager.listTargets(released);
    assert.equal(closedTargets[0]?.status, "closed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser session manager does not create duplicate reusable sessions under concurrent acquire", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-session-manager-race-"));

  try {
    let nowTick = 20;
    let idTick = 0;
    const manager = createManager(tempDir, () => ++nowTick, () => ++idTick);

    const [leaseA, leaseB] = await Promise.all([
      manager.acquireSession({
        ownerType: "thread",
        ownerId: "thread-2",
        profileOwnerType: "thread",
        profileOwnerId: "thread-2",
        reusable: true,
        leaseHolderRunKey: "worker:browser:thread-2",
      }),
      manager.acquireSession({
        ownerType: "thread",
        ownerId: "thread-2",
        profileOwnerType: "thread",
        profileOwnerId: "thread-2",
        reusable: true,
        leaseHolderRunKey: "worker:browser:thread-2",
      }),
    ]);

    assert.equal(leaseA.profile.profileId, leaseB.profile.profileId);
    assert.equal(leaseA.session.browserSessionId, leaseB.session.browserSessionId);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser session manager reselects the active target when the current one closes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-session-manager-reselect-"));

  try {
    let nowTick = 30;
    let idTick = 0;
    const manager = createManager(tempDir, () => ++nowTick, () => ++idTick);

    const lease = await manager.acquireSession({
      ownerType: "thread",
      ownerId: "thread-3",
      profileOwnerType: "thread",
      profileOwnerId: "thread-3",
      reusable: true,
      leaseHolderRunKey: "worker:browser:thread-3",
    });
    const firstTarget = await manager.ensureTarget({
      browserSessionId: lease.session.browserSessionId,
      url: "https://example.com/",
      createIfMissing: true,
    });
    const secondTarget = await manager.ensureTarget({
      browserSessionId: lease.session.browserSessionId,
      url: "https://example.com/pricing",
      createIfMissing: true,
    });

    await manager.ensureTarget({
      browserSessionId: lease.session.browserSessionId,
      targetId: secondTarget.targetId,
      status: "closed",
      createIfMissing: true,
    });

    const resumed = await manager.resumeSession({
      browserSessionId: lease.session.browserSessionId,
      ownerType: "thread",
      ownerId: "thread-3",
      leaseHolderRunKey: "worker:browser:thread-3",
    });
    assert.equal(resumed.session.activeTargetId, firstTarget.targetId);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser session manager can explicitly activate another existing target and marks detached sessions disconnected", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-session-manager-activate-"));

  try {
    let nowTick = 40;
    let idTick = 0;
    const manager = createManager(tempDir, () => ++nowTick, () => ++idTick);

    const lease = await manager.acquireSession({
      ownerType: "thread",
      ownerId: "thread-4",
      profileOwnerType: "thread",
      profileOwnerId: "thread-4",
      reusable: true,
      leaseHolderRunKey: "worker:browser:thread-4",
    });
    const firstTarget = await manager.ensureTarget({
      browserSessionId: lease.session.browserSessionId,
      url: "https://example.com/",
      createIfMissing: true,
    });
    const secondTarget = await manager.ensureTarget({
      browserSessionId: lease.session.browserSessionId,
      url: "https://example.com/pricing",
      transportSessionId: "page-handle-2",
      createIfMissing: true,
    });

    const activated = await manager.activateTarget(lease.session.browserSessionId, firstTarget.targetId);
    const detached = await manager.markTargetDetached(lease.session.browserSessionId, secondTarget.targetId);
    const resumed = await manager.resumeSession({
      browserSessionId: lease.session.browserSessionId,
      ownerType: "thread",
      ownerId: "thread-4",
      leaseHolderRunKey: "worker:browser:thread-4",
    });

    assert.equal(activated.targetId, firstTarget.targetId);
    assert.equal(detached.status, "detached");
    assert.equal(resumed.session.activeTargetId, firstTarget.targetId);
    assert.equal(secondTarget.targetId !== firstTarget.targetId, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser session manager marks the session disconnected when all remaining targets are detached", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-session-manager-detached-all-"));

  try {
    let nowTick = 60;
    let idTick = 0;
    const manager = createManager(tempDir, () => ++nowTick, () => ++idTick);
    const sessionStore = new FileBrowserSessionStore({
      rootDir: path.join(tempDir, "sessions"),
    });

    const lease = await manager.acquireSession({
      ownerType: "thread",
      ownerId: "thread-detached-all",
      profileOwnerType: "thread",
      profileOwnerId: "thread-detached-all",
      reusable: true,
      leaseHolderRunKey: "worker:browser:thread-detached-all",
    });
    const firstTarget = await manager.ensureTarget({
      browserSessionId: lease.session.browserSessionId,
      url: "https://example.com/",
      createIfMissing: true,
    });
    const secondTarget = await manager.ensureTarget({
      browserSessionId: lease.session.browserSessionId,
      url: "https://example.com/pricing",
      createIfMissing: true,
    });

    await manager.markTargetDetached(lease.session.browserSessionId, firstTarget.targetId);
    await manager.markTargetDetached(lease.session.browserSessionId, secondTarget.targetId);

    const session = await sessionStore.get(lease.session.browserSessionId);
    assert.equal(session?.status, "disconnected");
    assert.equal(session?.activeTargetId, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser session manager expires and reclaims leases", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-session-manager-lease-"));

  try {
    let nowTick = 100;
    let idTick = 0;
    const manager = createManager(tempDir, () => nowTick, () => ++idTick);

    const firstLease = await manager.acquireSession({
      ownerType: "thread",
      ownerId: "thread-lease",
      profileOwnerType: "thread",
      profileOwnerId: "thread-lease",
      reusable: true,
      leaseHolderRunKey: "worker:browser:a",
      leaseTtlMs: 5,
    });

    await assert.rejects(
      () =>
        manager.resumeSession({
          browserSessionId: firstLease.session.browserSessionId,
          ownerType: "thread",
          ownerId: "thread-lease",
          leaseHolderRunKey: "worker:browser:b",
        }),
      /lease conflict/
    );

    nowTick += 10;

    const reclaimed = await manager.resumeSession({
      browserSessionId: firstLease.session.browserSessionId,
      ownerType: "thread",
      ownerId: "thread-lease",
      leaseHolderRunKey: "worker:browser:b",
    });
    assert.equal(reclaimed.session.leaseHolderRunKey, "worker:browser:b");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser session manager denies owner-mismatched resumes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-session-manager-owner-"));

  try {
    let nowTick = 200;
    let idTick = 0;
    const manager = createManager(tempDir, () => ++nowTick, () => ++idTick);

    const lease = await manager.acquireSession({
      ownerType: "thread",
      ownerId: "thread-owner",
      profileOwnerType: "thread",
      profileOwnerId: "thread-owner",
      reusable: true,
      leaseHolderRunKey: "worker:browser:owner",
    });

    await assert.rejects(
      () =>
        manager.resumeSession({
          browserSessionId: lease.session.browserSessionId,
          ownerType: "thread",
          ownerId: "thread-other",
          leaseHolderRunKey: "worker:browser:owner",
        }),
      /owner mismatch/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser session manager rejects mutations on closed sessions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-session-manager-closed-"));

  try {
    let nowTick = 300;
    let idTick = 0;
    const manager = createManager(tempDir, () => ++nowTick, () => ++idTick);

    const lease = await manager.acquireSession({
      ownerType: "thread",
      ownerId: "thread-closed",
      profileOwnerType: "thread",
      profileOwnerId: "thread-closed",
      reusable: true,
      leaseHolderRunKey: "worker:browser:closed",
    });
    await manager.closeSession(lease.session.browserSessionId, "done");

    await assert.rejects(
      () =>
        manager.ensureTarget({
          browserSessionId: lease.session.browserSessionId,
          url: "https://example.com/",
          createIfMissing: true,
        }),
      /browser session not found/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function createManager(tempDir: string, now: () => number, nextId: () => number): BrowserSessionManager {
  return new BrowserSessionManager({
    browserProfileStore: new FileBrowserProfileStore({
      rootDir: path.join(tempDir, "profiles"),
    }),
    browserSessionStore: new FileBrowserSessionStore({
      rootDir: path.join(tempDir, "sessions"),
    }),
    browserTargetStore: new FileBrowserTargetStore({
      rootDir: path.join(tempDir, "targets"),
    }),
    now,
    createId: (prefix) => `${prefix}-${nextId()}`,
    profileRootDir: path.join(tempDir, "profile-data"),
  });
}
