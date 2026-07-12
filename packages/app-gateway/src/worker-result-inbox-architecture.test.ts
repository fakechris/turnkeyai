import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APP_GATEWAY_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = path.resolve(APP_GATEWAY_DIR, "../..");

test("durable worker inbox store has no model, policy, prompt, or dispatch dependency", () => {
  const source = readFileSync(
    path.join(PACKAGES_DIR, "team-store/src/worker/file-worker-result-inbox-store.ts"),
    "utf8",
  );
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(imports, [
    "node:path",
    "@turnkeyai/core-types/team",
    "@turnkeyai/shared-utils/async-mutex",
    "@turnkeyai/shared-utils/file-store-utils",
  ]);
});

test("production daemon wires durable inbox without automatic late-completion compute", () => {
  const source = readFileSync(path.join(APP_GATEWAY_DIR, "daemon.ts"), "utf8");
  const bridgeStart = source.indexOf("createMissionThreadBridge({");
  assert.notEqual(bridgeStart, -1);
  const bridgeEnd = source.indexOf("});", bridgeStart);
  const bridgeWiring = source.slice(bridgeStart, bridgeEnd);
  assert.match(bridgeWiring, /workerResultInboxStore/);
  assert.doesNotMatch(bridgeWiring, /postLateWorkerCompletionFollowUp/);
});
