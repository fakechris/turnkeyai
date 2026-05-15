import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  BrowserSessionOwnershipResult,
  BrowserTransportHealth,
  BrowserTransportReconnectResult,
} from "@turnkeyai/core-types/team";

import { FileBrowserSessionStore } from "../session/file-browser-session-store";
import { LocalAutomationBrowserAdapter } from "./local-automation-adapter";
import { RelayBrowserAdapter } from "./relay-adapter";
import { DirectCdpBrowserAdapter } from "./direct-cdp-adapter";

// P0.3 — every BrowserTransportAdapter must expose store-backed ownership inspection,
// transport health observation, and idempotent reconnect signalling. These tests pin
// the contract at the interface level so future adapters can't silently regress it.

async function seedSession(
  stateRootDir: string,
  overrides: {
    browserSessionId: string;
    ownerType?: "thread" | "role" | "worker";
    ownerId?: string;
    transportMode: "local" | "relay" | "direct-cdp";
    status?: "ready" | "busy" | "closed";
    leaseHolderRunKey?: string;
    leaseExpiresAt?: number;
  }
): Promise<void> {
  const store = new FileBrowserSessionStore({ rootDir: path.join(stateRootDir, "sessions") });
  const now = Date.now();
  await store.put({
    browserSessionId: overrides.browserSessionId,
    ownerType: overrides.ownerType ?? "thread",
    ownerId: overrides.ownerId ?? "thread-1",
    profileId: "profile-1",
    transportMode: overrides.transportMode,
    status: overrides.status ?? "ready",
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
    targetIds: [],
    ...(overrides.leaseHolderRunKey !== undefined ? { leaseHolderRunKey: overrides.leaseHolderRunKey } : {}),
    ...(overrides.leaseExpiresAt !== undefined ? { leaseExpiresAt: overrides.leaseExpiresAt } : {}),
  });
}

test("LocalAutomationBrowserAdapter exposes the transport contract", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "transport-contract-local-"));
  try {
    const adapter = new LocalAutomationBrowserAdapter({
      artifactRootDir: path.join(tempDir, "artifacts"),
      stateRootDir: path.join(tempDir, "state"),
    });

    // ownership: missing session
    const missing: BrowserSessionOwnershipResult = await adapter.inspectSessionOwnership({
      browserSessionId: "bs-does-not-exist",
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "missing_session");

    // ownership: correct owner
    await seedSession(path.join(tempDir, "state"), {
      browserSessionId: "bs-local-1",
      transportMode: "local",
      ownerType: "thread",
      ownerId: "thread-A",
    });
    const ok = await adapter.inspectSessionOwnership({
      browserSessionId: "bs-local-1",
      ownerType: "thread",
      ownerId: "thread-A",
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.owner?.ownerId, "thread-A");

    // ownership: wrong owner
    const wrong = await adapter.inspectSessionOwnership({
      browserSessionId: "bs-local-1",
      ownerType: "thread",
      ownerId: "thread-Z",
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, "wrong_owner");

    // ownership: closed session
    await seedSession(path.join(tempDir, "state"), {
      browserSessionId: "bs-local-closed",
      transportMode: "local",
      status: "closed",
    });
    const closed = await adapter.inspectSessionOwnership({ browserSessionId: "bs-local-closed" });
    assert.equal(closed.ok, false);
    assert.equal(closed.reason, "closed");

    // health: local is always healthy
    const health: BrowserTransportHealth = await adapter.getTransportHealth();
    assert.equal(health.healthy, true);
    assert.equal(health.transportMode, "local");

    // reconnect: idempotent no-op
    const reconnect: BrowserTransportReconnectResult = await adapter.reconnect();
    assert.equal(reconnect.ok, true);
    assert.equal(reconnect.invalidatedConnection, false);
    const reconnectAgain = await adapter.reconnect({ reason: "test" });
    assert.equal(reconnectAgain.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("RelayBrowserAdapter reports peer-aware transport health and reconnect", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "transport-contract-relay-"));
  try {
    const adapter = new RelayBrowserAdapter({
      artifactRootDir: path.join(tempDir, "artifacts"),
      stateRootDir: path.join(tempDir, "state"),
    });

    // No peers registered yet
    const initialHealth = await adapter.getTransportHealth();
    assert.equal(initialHealth.healthy, false);
    assert.equal(initialHealth.reason, "no_relay_peers_registered");
    assert.equal(initialHealth.peerCount, 0);
    assert.equal(initialHealth.activePeerCount, 0);

    const initialReconnect = await adapter.reconnect();
    assert.equal(initialReconnect.ok, false);
    assert.equal(initialReconnect.peerCount, 0);

    // Register a peer
    const gateway = adapter.getRelayControlPlane();
    gateway.registerPeer({
      peerId: "peer-1",
      label: "test-peer",
      capabilities: ["open", "snapshot"],
    });

    const liveHealth = await adapter.getTransportHealth();
    assert.equal(liveHealth.peerCount, 1);
    assert.equal(liveHealth.activePeerCount, 1);
    assert.equal(liveHealth.healthy, true);

    const liveReconnect = await adapter.reconnect({ reason: "test" });
    assert.equal(liveReconnect.ok, true);
    assert.equal(liveReconnect.invalidatedConnection, false);
    assert.equal(liveReconnect.peerCount, 1);

    // ownership: store-backed check works the same way as local
    await seedSession(path.join(tempDir, "state"), {
      browserSessionId: "bs-relay-1",
      transportMode: "relay",
      ownerType: "thread",
      ownerId: "thread-R",
      leaseHolderRunKey: "run-1",
      leaseExpiresAt: Date.now() + 60_000,
    });
    const leaseConflict = await adapter.inspectSessionOwnership({
      browserSessionId: "bs-relay-1",
      ownerType: "thread",
      ownerId: "thread-R",
      leaseHolderRunKey: "run-2",
    });
    assert.equal(leaseConflict.ok, false);
    assert.equal(leaseConflict.reason, "wrong_lease_holder");
    assert.equal(leaseConflict.lease?.leaseActive, true);

    const leaseMatch = await adapter.inspectSessionOwnership({
      browserSessionId: "bs-relay-1",
      leaseHolderRunKey: "run-1",
    });
    assert.equal(leaseMatch.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("DirectCdpBrowserAdapter reconnect invalidates cached browser connection", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "transport-contract-cdp-"));
  try {
    let connectCalls = 0;
    const adapter = new DirectCdpBrowserAdapter(
      {
        artifactRootDir: path.join(tempDir, "artifacts"),
        stateRootDir: path.join(tempDir, "state"),
        directCdp: { endpoint: "http://127.0.0.1:0" },
      },
      {
        connectBrowser: async () => {
          connectCalls += 1;
          // Return a minimal stub; real Browser type is enforced at boundary only.
          return {
            on: () => undefined,
            newBrowserCDPSession: async () => ({
              on: () => undefined,
              send: async () => ({}),
            }),
            close: async () => undefined,
          } as never;
        },
      }
    );

    // Initially no connection cached.
    const idleHealth = await adapter.getTransportHealth();
    assert.equal(idleHealth.connected, false);
    assert.equal(idleHealth.transportMode, "direct-cdp");
    assert.equal(idleHealth.endpoint, "http://127.0.0.1:0");

    // No previous connection: reconnect is a clean no-op.
    const cleanReconnect = await adapter.reconnect();
    assert.equal(cleanReconnect.ok, true);
    assert.equal(cleanReconnect.invalidatedConnection, false);
    assert.equal(connectCalls, 0);

    // Provision a connection through the public expert lane.
    await adapter.listExpertTargets("bs-cdp-1");
    assert.equal(connectCalls, 1);

    const connectedHealth = await adapter.getTransportHealth();
    assert.equal(connectedHealth.connected, true);

    // Reconnect should invalidate the cached connection so the next call
    // re-establishes it. Idempotency: calling reconnect twice in a row must
    // not double-invalidate or throw.
    const flush1 = await adapter.reconnect({ reason: "test" });
    assert.equal(flush1.ok, true);
    assert.equal(flush1.invalidatedConnection, true);

    const flush2 = await adapter.reconnect();
    assert.equal(flush2.ok, true);
    assert.equal(flush2.invalidatedConnection, false);

    // ownership: store-backed
    await seedSession(path.join(tempDir, "state"), {
      browserSessionId: "bs-cdp-1",
      transportMode: "direct-cdp",
    });
    const owns = await adapter.inspectSessionOwnership({ browserSessionId: "bs-cdp-1" });
    assert.equal(owns.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
