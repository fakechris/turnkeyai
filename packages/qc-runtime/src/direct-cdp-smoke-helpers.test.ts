import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { waitForRawCdpTarget } from "../../../scripts/direct-cdp-smoke";

test("direct-cdp smoke helper reports target_not_found after polling real target listings", async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, "/browser-sessions/session-1/expert/targets?threadId=thread-1");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        {
          targetId: "page-main",
          type: "page",
          url: "https://app.example.com",
        },
      ])
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await assert.rejects(
      waitForRawCdpTarget(
        {
          daemonUrl: `http://127.0.0.1:${address.port}`,
          threadId: "thread-1",
          sessionId: "session-1",
          timeoutMs: 20,
          pollIntervalMs: 1,
        },
        (target) => target.type === "iframe"
      ),
      /target_not_found: timed out waiting for raw CDP target; last targets:/
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
