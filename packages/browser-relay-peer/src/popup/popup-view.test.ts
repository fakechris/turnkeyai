import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, formatRelativeMs, renderPopupBody, type PopupStatusModel } from "./popup-view";

const baseModel: PopupStatusModel = {
  daemonUrl: "http://127.0.0.1:4100",
  daemonToken: "secret-token",
  peerId: "peer-1",
  peerLabel: "Test Peer",
  connection: "connected",
  daemonReachable: true,
  peerSeenByDaemon: true,
  transportMode: "relay",
  transportLabel: "chrome-relay",
  observedTargets: 3,
  daemonPeers: 1,
  daemonTargets: 3,
  expertLane: false,
  lastHeartbeatAgeMs: 450,
  lastError: null,
  version: "0.1.1",
};

describe("popup-view", () => {
  it("renders a connected state with dot-ok", () => {
    const html = renderPopupBody(baseModel);
    assert.match(html, /dot-ok/);
    assert.match(html, /Connected/);
    assert.match(html, /Test Peer/);
    assert.match(html, /chrome-relay/);
  });

  it("renders disconnected state when not reachable", () => {
    const html = renderPopupBody({
      ...baseModel,
      connection: "disconnected",
      daemonReachable: false,
      peerSeenByDaemon: false,
    });
    assert.match(html, /dot-bad/);
    assert.match(html, /Disconnected/);
    assert.match(html, /peer not registered/);
  });

  it("renders checking state during initial load", () => {
    const html = renderPopupBody({ ...baseModel, connection: "checking" });
    assert.match(html, /dot-pending/);
    assert.match(html, /Checking/);
  });

  it("escapes user-controlled fields", () => {
    const html = renderPopupBody({
      ...baseModel,
      peerLabel: "<script>alert(1)</script>",
      lastError: "</dd><img src=x>",
    });
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(!html.includes("<img src=x>"));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it("formats relative ms", () => {
    assert.equal(formatRelativeMs(null), "—");
    assert.equal(formatRelativeMs(500), "500ms ago");
    assert.equal(formatRelativeMs(15_000), "15s ago");
    assert.equal(formatRelativeMs(90_000), "1m ago");
    assert.equal(formatRelativeMs(60 * 60 * 1000 * 3), "3h ago");
  });

  it("escapeHtml escapes the expected characters", () => {
    assert.equal(escapeHtml("<&>\"'"), "&lt;&amp;&gt;&quot;&#39;");
  });
});
