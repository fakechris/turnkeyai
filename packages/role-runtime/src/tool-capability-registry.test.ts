import assert from "node:assert/strict";
import test from "node:test";

import { createNativeToolCapabilityRegistry } from "./tool-capability-registry";

test("native tool capability registry drives schemas and prompt harness from the same worker set", () => {
  const registry = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["browser", "explore"],
  });

  const definitions = registry.definitions();
  const spawn = definitions.find((definition) => definition.name === "sessions_spawn");
  const list = definitions.find((definition) => definition.name === "sessions_list");
  const spawnSchema = spawn?.inputSchema as {
    properties?: { agent_id?: { enum?: string[] } };
  };
  const listSchema = list?.inputSchema as {
    properties?: { agent_id?: { enum?: string[] }; kinds?: { items?: { enum?: string[] } } };
  };

  assert.deepEqual(registry.availableWorkerKinds(), ["browser", "explore"]);
  assert.deepEqual(spawnSchema.properties?.agent_id?.enum, ["browser", "explore"]);
  assert.deepEqual(listSchema.properties?.agent_id?.enum, ["browser", "explore"]);
  assert.deepEqual(listSchema.properties?.kinds?.items?.enum, ["browser", "explore"]);
  assert.deepEqual(
    registry.summaries().map((summary) => summary.name),
    ["sessions_spawn", "sessions_send", "sessions_list", "sessions_history"]
  );

  const harness = registry.renderPromptHarness({ seat: "lead" });
  assert.match(harness, /Tool Usage Discipline/);
  assert.match(harness, /Sub-Agent Sessions/);
  assert.match(harness, /browser: authenticated or interactive web work/);
  assert.match(harness, /explore: focused read-only research/);
  assert.doesNotMatch(harness, /coder:/);
});

test("native tool capability registry omits browser harness when browser is unavailable", () => {
  const registry = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["explore", "finance"],
  });

  const harness = registry.renderPromptHarness({ seat: "member" });
  assert.match(harness, /Sub-Agent Sessions/);
  assert.match(harness, /explore: focused read-only research/);
  assert.match(harness, /finance: market and financial-data lookups/);
  assert.doesNotMatch(harness, /Browser Worker Rules/);
});

test("native tool capability registry includes permission tools only when enabled", () => {
  const disabled = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["browser"],
  });
  assert.equal(disabled.definitions().some((definition) => definition.name === "permission_query"), false);
  assert.doesNotMatch(disabled.renderPromptHarness({ seat: "lead" }), /Permission Loop/);

  const enabled = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["browser"],
    permissionsEnabled: true,
  });
  assert.deepEqual(
    enabled.summaries().filter((summary) => summary.promptGroup === "permissions").map((summary) => summary.name),
    ["permission_query", "permission_result", "permission_applied"]
  );
  assert.match(enabled.renderPromptHarness({ seat: "lead" }), /Permission Loop/);
});
