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
  assert.match(spawn?.description ?? "", /Use explore first for public source research/);
  assert.match(spawn?.description ?? "", /pricing\/docs pages/);
  assert.match(spawn?.description ?? "", /Use browser directly for authenticated, interactive, visual, JS-rendered, localhost/);
  assert.match(spawn?.description ?? "", /loopback, private-network, internal, dashboard, or user-session pages/);
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
  assert.match(harness, /Preserve exact user-provided entity names/);
  assert.match(harness, /spawn explore first/);
  assert.match(harness, /pricing, documentation, or read-only URL extraction/);
  assert.match(harness, /localhost, loopback, private-network, internal/);
  assert.match(harness, /spawn browser directly/);
  assert.match(harness, /Do not append guessed categories/);
  assert.match(harness, /emit at most five session tool calls total/);
  assert.match(harness, /exactly two focused calls/);
  assert.match(harness, /three or more independent evidence streams/);
  assert.match(harness, /Leave timeout_seconds unset for ordinary delegated work/);
  assert.match(harness, /Do not increase timeout_seconds on a timeout follow-up unless the user explicitly asks/);
  assert.doesNotMatch(harness, /Suggested caps/);
  assert.doesNotMatch(harness, /longer timeout/);
  assert.match(harness, /Do not downgrade the task to read-only inspection/);
  assert.match(harness, /preserve the original task's decision criteria/i);
  assert.match(harness, /use explore first/);
  assert.match(harness, /Use browser first for localhost, loopback, private-network/);
  assert.match(harness, /use browser after explore\/static extraction is blocked/);
  assert.match(harness, /Parent runtime handles permission_query/);
  assert.match(harness, /Do not substitute explore\/static fetch for that browser evidence/);
  assert.match(harness, /exact final answer skeleton/);
  assert.match(harness, /Do not add status preambles/);
  assert.match(harness, /keep each requested bullet compact/);
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

test("native tool capability registry does not advertise session tools without executable workers", () => {
  const registry = createNativeToolCapabilityRegistry();

  assert.deepEqual(registry.availableWorkerKinds(), []);
  assert.deepEqual(registry.names(), []);

  const harness = registry.renderPromptHarness({ seat: "lead" });
  assert.match(harness, /Tool Usage Discipline/);
  assert.doesNotMatch(harness, /Sub-Agent Sessions/);
  assert.doesNotMatch(harness, /Executable sub-agent kinds/);
});

test("permission tool schema remains provider-valid when no workers are executable", () => {
  const registry = createNativeToolCapabilityRegistry({
    permissionsEnabled: true,
  });
  const query = registry.definitions().find((definition) => definition.name === "permission_query");
  const schema = query?.inputSchema as {
    properties?: { worker_kind?: { type?: string; enum?: string[] } };
  };

  assert.deepEqual(registry.names(), ["permission_query", "permission_result", "permission_applied"]);
  assert.equal(schema.properties?.worker_kind?.type, "string");
  assert.equal("enum" in (schema.properties?.worker_kind ?? {}), false);
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
  const enabledHarness = enabled.renderPromptHarness({ seat: "lead" });
  assert.match(enabledHarness, /Permission Loop/);
  assert.match(enabledHarness, /Do not call permission_query for read-only browser navigation/);
  assert.match(enabledHarness, /approval is only for actions that can mutate external or account state/);
});

test("native tool capability registry includes memory tools only when enabled", () => {
  const disabled = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["explore"],
  });
  assert.equal(disabled.definitions().some((definition) => definition.name === "memory_search"), false);
  assert.doesNotMatch(disabled.renderPromptHarness({ seat: "lead" }), /Memory Tools/);

  const enabled = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["explore"],
    memoryEnabled: true,
  });
  assert.deepEqual(
    enabled.summaries().filter((summary) => summary.promptGroup === "memory").map((summary) => summary.name),
    ["memory_search", "memory_get"]
  );
  assert.match(enabled.renderPromptHarness({ seat: "lead" }), /Memory Tools/);
  assert.match(enabled.renderPromptHarness({ seat: "lead" }), /Do not fabricate remembered facts/);
});

test("native tool capability registry includes task tools only when enabled", () => {
  const disabled = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["explore"],
  });
  assert.equal(disabled.definitions().some((definition) => definition.name === "tasks_list"), false);
  assert.doesNotMatch(disabled.renderPromptHarness({ seat: "lead" }), /Mission Task Management/);

  const enabled = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["explore"],
    tasksEnabled: true,
  });
  assert.deepEqual(
    enabled.summaries().filter((summary) => summary.promptGroup === "tasks").map((summary) => summary.name),
    ["tasks_list", "tasks_create", "tasks_update"]
  );
  assert.match(enabled.renderPromptHarness({ seat: "lead" }), /Mission Task Management/);
  assert.match(enabled.renderPromptHarness({ seat: "lead" }), /Mark a task done only after/);
});
