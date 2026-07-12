import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface PolicyInventory {
  baseline: string;
  repair: string[];
  continuation: string[];
  closeout: string[];
  permission: string[];
  normalizer: string[];
}

const inventory = JSON.parse(
  readFileSync("docs/design/runtime-policy-inventory.json", "utf8"),
) as PolicyInventory;
const disposition = readFileSync(
  "docs/design/runtime-policy-disposition.md",
  "utf8",
);

test("runtime policy inventory matches every active policy family", () => {
  assert.deepEqual(readRepairIds(), inventory.repair);
  assert.deepEqual(readContinuationIds(), inventory.continuation);
  assert.deepEqual(readArrayIds(
    "packages/role-runtime/src/react-engine/closeout-policy-registry.ts",
    "ENGINE_CLOSEOUT_POLICY_ORDER",
  ), inventory.closeout);
  assert.deepEqual(readPermissionIds(), inventory.permission);
  assert.deepEqual(readNormalizerSteps(), inventory.normalizer);
});

test("every inventoried policy and normalizer step has an explicit disposition", () => {
  for (const [family, ids] of Object.entries(inventory)) {
    if (family === "baseline") continue;
    for (const id of ids) {
      assert.ok(
        disposition.includes(`\`${id}\``),
        `${family} entry lacks a disposition: ${id}`,
      );
    }
  }
});

function readRepairIds(): string[] {
  const source = readFileSync(
    "packages/role-runtime/src/runtime-policy/repair-policy-core.ts",
    "utf8",
  );
  return [...source.matchAll(
    /RUNTIME_(?:NATURAL_FINISH|COMPLETED_SYNTHESIS)_REPAIR_POLICY_ORDER = \[([\s\S]*?)\] as const/g,
  )].flatMap((match) => quotedValues(match[1] ?? ""));
}

function readContinuationIds(): string[] {
  const source = readFileSync(
    "packages/role-runtime/src/runtime-policy/continuation-policy-core.ts",
    "utf8",
  );
  const union = source.match(
    /export type RuntimeContinuationPolicyId =([\s\S]*?);/,
  );
  assert.ok(union, "continuation policy union not found");
  return quotedValues(union[1] ?? "");
}

function readPermissionIds(): string[] {
  const source = readFileSync(
    "packages/role-runtime/src/runtime-policy/permission-policy-core.ts",
    "utf8",
  );
  return [...new Set(
    [...source.matchAll(/policyId:\s*"([^"]+)"/g)]
      .map((match) => match[1]!)
      .filter((id) => id !== "none"),
  )];
}

function readNormalizerSteps(): string[] {
  const source = readFileSync(
    "packages/role-runtime/src/react-engine/tool-call-normalizer.ts",
    "utf8",
  );
  const pipeline = source.match(
    /const ENGINE_TOOL_CALL_NORMALIZATION_PIPELINE[\s\S]*?= \[([\s\S]*?)\n\];/,
  );
  assert.ok(pipeline, "tool-call normalization pipeline not found");
  return [...(pipeline[1] ?? "").matchAll(/name:\s*"([^"]+)"/g)]
    .map((match) => match[1]!);
}

function readArrayIds(file: string, constantName: string): string[] {
  const source = readFileSync(file, "utf8");
  const array = source.match(
    new RegExp(`${constantName} = \\[([\\s\\S]*?)\\] as const`),
  );
  assert.ok(array, `${constantName} not found`);
  return quotedValues(array[1] ?? "");
}

function quotedValues(source: string): string[] {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}
