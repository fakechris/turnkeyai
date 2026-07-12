import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

type PolicyFamily = "repair" | "continuation" | "closeout" | "permission" | "normalizer";
type PolicyStatus = "retained" | "migrated";

interface PolicyRow {
  id: string;
  status: PolicyStatus;
  targetOwner: string;
  evidence: string;
}

interface PolicyInventory {
  baseline: string;
  rows: Record<PolicyFamily, PolicyRow[]>;
}

const inventory = JSON.parse(
  readFileSync("docs/design/runtime-policy-inventory.json", "utf8"),
) as PolicyInventory;
const disposition = readFileSync("docs/design/runtime-policy-disposition.md", "utf8");

const characterizationSources: Record<PolicyFamily, string[]> = {
  repair: readRepairIds(),
  continuation: readContinuationIds(),
  closeout: readArrayIds(
    "packages/role-runtime/src/react-engine/closeout-policy-registry.ts",
    "RETIRED_CLOSEOUT_POLICY_CHARACTERIZATION_ORDER",
  ),
  permission: readPermissionIds(),
  normalizer: readNormalizerSteps("RETIRED_TOOL_CALL_NORMALIZATION_CHARACTERIZATION"),
};

const productionSources: Record<PolicyFamily, string[]> = {
  repair: readArrayIds(
    "packages/role-runtime/src/react-engine/repair-policy-registry.ts",
    "ENGINE_ACTIVE_REPAIR_POLICY_IDS",
  ),
  continuation: readArrayIds(
    "packages/role-runtime/src/react-engine/continuation-controller.ts",
    "ENGINE_ACTIVE_CONTINUATION_POLICY_IDS",
  ),
  closeout: readArrayIds(
    "packages/role-runtime/src/react-engine/closeout-policy-registry.ts",
    "ENGINE_CLOSEOUT_POLICY_ORDER",
  ),
  permission: readArrayIds(
    "packages/role-runtime/src/react-engine/permission-policy.ts",
    "ENGINE_ACTIVE_PERMISSION_POLICY_IDS",
  ),
  normalizer: readNormalizerSteps("ENGINE_TOOL_CALL_NORMALIZATION_PIPELINE"),
};

test("runtime policy inventory preserves every original row", () => {
  for (const family of Object.keys(inventory.rows) as PolicyFamily[]) {
    const ids = inventory.rows[family].map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, `${family} contains duplicate rows`);
    assert.deepEqual(ids, characterizationSources[family], `${family} inventory drifted`);
  }
});

test("production policy authority exactly matches retained rows", () => {
  for (const family of Object.keys(inventory.rows) as PolicyFamily[]) {
    const retained = inventory.rows[family]
      .filter((row) => row.status === "retained")
      .map((row) => row.id);
    assert.deepEqual(
      productionSources[family],
      retained,
      `${family} production authority differs from signed inventory`,
    );
  }
});

test("every row names its target owner and executable deterministic evidence", () => {
  const testSources = readFiles("packages", (file) => file.endsWith(".test.ts"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  for (const [family, rows] of Object.entries(inventory.rows)) {
    for (const row of rows) {
      assert.ok(disposition.includes(`\`${row.id}\``), `${family}:${row.id} lacks disposition`);
      assert.ok(row.targetOwner.trim().length > 3, `${family}:${row.id} lacks target owner`);
      assert.ok(row.evidence.trim().length > 3, `${family}:${row.id} lacks evidence`);
      assert.ok(
        testSources.includes(row.evidence),
        `${family}:${row.id} evidence does not name a deterministic test: ${row.evidence}`,
      );
    }
  }
});

test("retired policy characterization cannot be enabled by production composition", () => {
  const productionFiles = readFiles("packages", (file) =>
    file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
  const allowed = new Set([
    "packages/role-runtime/src/llm-response-generator.ts",
    "packages/role-runtime/src/react-engine/closeout-policy-registry.ts",
    "packages/role-runtime/src/react-engine/continuation-controller.ts",
    "packages/role-runtime/src/react-engine/permission-policy.ts",
    "packages/role-runtime/src/react-engine/repair-policy-registry.ts",
    "packages/role-runtime/src/react-engine/tool-call-normalizer.ts",
  ]);
  const tokens = [
    "testOnlyCharacterizeRetiredPolicies",
    "createCloseoutPolicyCharacterizationRegistry",
    "createContinuationCharacterizationController",
    "createPermissionPolicyCharacterization",
    "createRepairPolicyCharacterizationRegistry",
  ];
  for (const file of productionFiles) {
    if (allowed.has(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const token of tokens) {
      assert.equal(source.includes(token), false, `${file} enables retired policy token ${token}`);
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
  const union = source.match(/export type RuntimeContinuationPolicyId =([\s\S]*?);/);
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

function readNormalizerSteps(constantName: string): string[] {
  const source = readFileSync(
    "packages/role-runtime/src/react-engine/tool-call-normalizer.ts",
    "utf8",
  );
  const start = source.indexOf(`const ${constantName}`);
  assert.notEqual(start, -1, `${constantName} not found`);
  const end = source.indexOf("\n];", start);
  assert.notEqual(end, -1, `${constantName} end not found`);
  const block = source.slice(start, end);
  const explicit = [...block.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]!);
  if (constantName === "RETIRED_TOOL_CALL_NORMALIZATION_CHARACTERIZATION") {
    explicit.splice(0, 0, "sessionToolAlias");
    explicit.splice(5, 0, "sessionToolCalls");
  }
  return explicit;
}

function readArrayIds(file: string, constantName: string): string[] {
  const source = readFileSync(file, "utf8");
  const array = source.match(new RegExp(`${constantName} = \\[([\\s\\S]*?)\\] as const`));
  assert.ok(array, `${constantName} not found`);
  return quotedValues(array[1] ?? "");
}

function quotedValues(source: string): string[] {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

function readFiles(root: string, include: (file: string) => boolean): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root)) {
    const file = path.join(root, entry);
    if (statSync(file).isDirectory()) output.push(...readFiles(file, include));
    else if (include(file)) output.push(file);
  }
  return output;
}
