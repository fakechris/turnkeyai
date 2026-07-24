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
} from "./prompt-registry";

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
