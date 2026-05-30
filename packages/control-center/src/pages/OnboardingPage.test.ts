import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeStatus } from "../api/types";
import { bridgeReadiness } from "./OnboardingPage";

test("bridgeReadiness reports route-level failures with an error action", () => {
  const item = bridgeReadiness({
    ok: false,
    port: 4100,
    version: "0.1.1",
    dataDir: "/tmp/turnkeyai/data",
    logsPath: "/tmp/turnkeyai/logs/daemon.log",
    configFile: "/tmp/turnkeyai/config.json",
    transport: {
      mode: "local",
      label: "local-automation",
    },
    relay: {
      configured: false,
      peerCount: 0,
      targetCount: 0,
      lastHeartbeatAgeMs: null,
      actionRequestQueueDepth: 0,
    },
    directCdp: {
      configured: false,
      endpoint: null,
    },
    expertLane: {
      available: true,
    },
    sessions: {
      count: 1,
    },
  } satisfies BridgeStatus);

  assert.equal(item.state, "error");
  assert.equal(item.action, "Bridge route is not healthy; open Agent Connect for transport diagnostics.");
});

