import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { BrowserSession } from "@turnkeyai/core-types/team";

import { createBrowserContextSourceProvider } from "./browser-context-source-provider";

const baseSession: BrowserSession = {
  browserSessionId: "sess_a",
  ownerType: "user",
  ownerId: "owner-1",
  profileId: "p",
  transportMode: "local",
  status: "ready",
  createdAt: 0,
  updatedAt: 0,
  lastActiveAt: 0,
  targetIds: [],
};

describe("createBrowserContextSourceProvider", () => {
  it("maps live sessions to ContextSource records with the synthetic id scheme", async () => {
    const provider = createBrowserContextSourceProvider({
      browserBridge: {
        async listSessions() {
          return [
            { ...baseSession, browserSessionId: "sess_a", status: "ready", lastActiveAt: 0 },
            { ...baseSession, browserSessionId: "sess_b", status: "disconnected", lastActiveAt: 0 },
          ];
        },
        transportMode: "direct-cdp",
        transportLabel: "direct-cdp",
      },
    });
    const out = await provider.listLive();
    assert.equal(out.length, 2);
    assert.equal(out[0]!.id, "ctx.browser.session.sess_a");
    assert.equal(out[0]!.kind, "browser");
    assert.equal(out[0]!.session, "sess_a");
    assert.equal(out[0]!.state, "attached");
    assert.equal(out[0]!.transport, "direct-cdp");
    assert.equal(out[1]!.state, "detached");
  });

  it("returns [] when the bridge throws (must never 500 the read path)", async () => {
    const provider = createBrowserContextSourceProvider({
      browserBridge: {
        async listSessions() {
          throw new Error("relay heartbeat lost");
        },
        transportMode: "relay",
        transportLabel: "relay",
      },
    });
    assert.deepEqual(await provider.listLive(), []);
  });

  it("exposes raw lastUseAtMs without formatting (client formats)", async () => {
    // gemini K3 review: daemon doesn't format display strings. Server
    // returns the monotonic timestamp; client renders "Xm ago".
    const provider = createBrowserContextSourceProvider({
      browserBridge: {
        async listSessions() {
          return [{ ...baseSession, lastActiveAt: 1_700_000_000_000 }];
        },
        transportMode: "local",
        transportLabel: "local-automation",
      },
    });
    const out = await provider.listLive();
    assert.equal(out[0]!.lastUse, "");
    assert.equal(out[0]!.lastUseAtMs, 1_700_000_000_000);
  });
});
