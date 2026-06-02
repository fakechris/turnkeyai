import assert from "node:assert/strict";
import test from "node:test";

import { decodeBrowserSessionPayload } from "./browser-session-payload";

test("decode browser session payload reads session, target, and resume mode", () => {
  const decoded = decodeBrowserSessionPayload({
    sessionId: "session-1",
    targetId: "target-1",
    resumeMode: "warm",
    ignored: true,
  });

  assert.deepEqual(decoded, {
    sessionId: "session-1",
    targetId: "target-1",
    resumeMode: "warm",
    source: "direct",
  });
});

test("decode browser session payload reads promoted browser recovery metadata", () => {
  const decoded = decodeBrowserSessionPayload({
    mode: "llm_sub_agent",
    browserRecovery: {
      sessionId: "session-recovered",
      targetId: "target-recovered",
      resumeMode: "cold",
    },
  });

  assert.deepEqual(decoded, {
    sessionId: "session-recovered",
    targetId: "target-recovered",
    resumeMode: "cold",
    source: "browserRecovery",
  });
});

test("decode browser session payload rejects missing session ids", () => {
  assert.equal(decodeBrowserSessionPayload({ targetId: "target-1" }), null);
  assert.equal(decodeBrowserSessionPayload(null), null);
  assert.equal(decodeBrowserSessionPayload([{ sessionId: "session-1" }]), null);
});
