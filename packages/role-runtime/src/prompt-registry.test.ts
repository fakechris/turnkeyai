import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ACTIVE_PROMPT_ROUTE_IDS,
  DEFAULT_PROMPT_SECTION_DEFINITIONS,
  DEFAULT_PROMPT_SECTION_REGISTRY,
  PROMPT_ASSEMBLY_SECTION_IDS,
  PROMPT_ASSEMBLY_SEGMENTS,
  PromptSectionRegistry,
  TOOL_PROMPT_GROUP_SECTION_IDS,
  auditDefaultPromptRegistry,
  resolveActivePromptRouteIds,
} from "./prompt-registry";
import { createNativeToolCapabilityRegistry } from "./tool-capability-registry";

test("default prompt registry has one reachable owner for every section", () => {
  const audit = auditDefaultPromptRegistry();
  assert.equal(audit.valid, true);
  assert.equal(audit.unreachableSectionIds.length, 0);
  assert.equal(audit.missingRouteIds.length, 0);
  assert.equal(
    audit.definitionCount,
    DEFAULT_PROMPT_SECTION_DEFINITIONS.length,
  );
  assert.equal(
    new Set(
      DEFAULT_PROMPT_SECTION_DEFINITIONS.map(
        (definition) => definition.authorityKey,
      ),
    ).size,
    DEFAULT_PROMPT_SECTION_DEFINITIONS.length,
  );
  assert.equal(
    DEFAULT_PROMPT_SECTION_DEFINITIONS.every(
      (definition) =>
        definition.owner.startsWith("packages/") &&
        /^\d+\.\d+\.\d+$/.test(definition.version) &&
        definition.tokenPolicy.maxTokens! > 0,
    ),
    true,
  );
});

test("prompt registry rejects duplicate section and authority ownership", () => {
  const first = structuredClone(DEFAULT_PROMPT_SECTION_DEFINITIONS[0]!);
  assert.throws(
    () => new PromptSectionRegistry("test", [first, first]),
    /duplicate prompt section id/,
  );
  assert.throws(
    () =>
      new PromptSectionRegistry("test", [
        first,
        {
          ...structuredClone(DEFAULT_PROMPT_SECTION_DEFINITIONS[1]!),
          authorityKey: first.authorityKey,
        },
      ]),
    /duplicate prompt authority key/,
  );
});

test("prompt registry audit detects dead definitions and unknown active routes", () => {
  const routes = DEFAULT_ACTIVE_PROMPT_ROUTE_IDS.filter(
    (route) => route !== "compaction:summary",
  );
  const audit = DEFAULT_PROMPT_SECTION_REGISTRY.audit([
    ...routes,
    "unknown:route",
  ]);
  assert.deepEqual(audit.unreachableSectionIds, [
    "prompt.checkpoint-summary",
  ]);
  assert.deepEqual(audit.missingRouteIds, ["unknown:route"]);
  assert.equal(audit.valid, false);
});

test("live tool configuration drives audit; disabling a capability makes its section unreachable", () => {
  // Every capability enabled → every registered tool section is reachable.
  const fullRegistry = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["explore", "browser"],
    permissionsEnabled: true,
    memoryEnabled: true,
    tasksEnabled: true,
    webFetchEnabled: true,
    artifactsEnabled: true,
  });
  const fullAudit = DEFAULT_PROMPT_SECTION_REGISTRY.audit(
    resolveActivePromptRouteIds(fullRegistry.activePromptSectionIds()),
  );
  assert.equal(fullAudit.valid, true);
  assert.deepEqual(fullAudit.unreachableSectionIds, []);
  assert.deepEqual(fullAudit.missingRouteIds, []);

  // Turning permissions off is real runtime config drift the constant-route
  // audit could never see: the permissions tool section becomes unreachable and
  // the registry is flagged invalid.
  const noPermsRegistry = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["explore", "browser"],
    permissionsEnabled: false,
    memoryEnabled: true,
    tasksEnabled: true,
    webFetchEnabled: true,
    artifactsEnabled: true,
  });
  const noPermsAudit = DEFAULT_PROMPT_SECTION_REGISTRY.audit(
    resolveActivePromptRouteIds(noPermsRegistry.activePromptSectionIds()),
  );
  assert.deepEqual(noPermsAudit.unreachableSectionIds, [
    "prompt.tools.permissions",
  ]);
  assert.deepEqual(noPermsAudit.missingRouteIds, []);
  assert.equal(noPermsAudit.valid, false);
});

test("resolveActivePromptRouteIds surfaces unknown active tool sections as missing routes", () => {
  const audit = DEFAULT_PROMPT_SECTION_REGISTRY.audit(
    resolveActivePromptRouteIds([
      ...Object.values(TOOL_PROMPT_GROUP_SECTION_IDS),
      "prompt.tools.telepathy",
    ]),
  );
  assert.deepEqual(audit.missingRouteIds, ["prompt.tools.telepathy"]);
  assert.equal(audit.valid, false);
});

test("registry receipt flags over-budget sections and leaves within-budget clean", () => {
  // prompt.output-contract declares tokenPolicy.maxTokens = 2000.
  const over = DEFAULT_PROMPT_SECTION_REGISTRY.receipt({
    sectionId: "prompt.output-contract",
    state: "included",
    estimatedTokens: 2001,
  });
  assert.equal(over.overBudget, true);
  const atBudget = DEFAULT_PROMPT_SECTION_REGISTRY.receipt({
    sectionId: "prompt.output-contract",
    state: "included",
    estimatedTokens: 2000,
  });
  assert.equal(atBudget.overBudget, undefined);
});

test("section versions are content-addressed and drift with the declared contract", () => {
  for (const definition of DEFAULT_PROMPT_SECTION_DEFINITIONS) {
    assert.match(definition.version, /^1\.0\.\d+$/);
  }
  const versions = new Set(
    DEFAULT_PROMPT_SECTION_DEFINITIONS.map((definition) => definition.version),
  );
  // Distinct contracts produce distinct versions rather than a shared "1.0.0".
  assert.ok(versions.size > 1);
  assert.notEqual(
    DEFAULT_PROMPT_SECTION_REGISTRY.get("prompt.assembly.task-brief").version,
    DEFAULT_PROMPT_SECTION_REGISTRY.get("prompt.assembly.recent-turns").version,
  );
});

test("assembly and tool harness route maps are complete and distinct", () => {
  assert.deepEqual(
    Object.keys(PROMPT_ASSEMBLY_SECTION_IDS).sort(),
    [...PROMPT_ASSEMBLY_SEGMENTS].sort(),
  );
  const sectionIds = [
    ...Object.values(PROMPT_ASSEMBLY_SECTION_IDS),
    ...Object.values(TOOL_PROMPT_GROUP_SECTION_IDS),
  ];
  assert.equal(new Set(sectionIds).size, sectionIds.length);
  for (const sectionId of sectionIds) {
    assert.equal(
      DEFAULT_PROMPT_SECTION_REGISTRY.get(sectionId).sectionId,
      sectionId,
    );
  }
});
