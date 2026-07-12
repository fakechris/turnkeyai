import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEAM_RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = path.resolve(TEAM_RUNTIME_DIR, "../..");

test("explicit workflow runtime cannot import model, prompt, policy, detector, or dispatch owners", () => {
  const source = readFileSync(
    path.join(TEAM_RUNTIME_DIR, "explicit-workflow-runtime.ts"),
    "utf8",
  );
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:crypto", "@turnkeyai/core-types/team"]);
  assert.doesNotMatch(source, /taskPrompt|detector|dispatchEffect|executeEffect|generate\(/);
});

test("explicit workflow file store remains a persistence-only dependency", () => {
  const source = readFileSync(
    path.join(PACKAGES_DIR, "team-store/src/workflow/file-explicit-workflow-store.ts"),
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

test("daemon foundations compose the workflow runtime over the durable inbox", () => {
  const source = readFileSync(
    path.join(PACKAGES_DIR, "app-gateway/src/composition/foundations.ts"),
    "utf8",
  );
  assert.match(source, /const explicitWorkflowStore = new FileExplicitWorkflowStore/);
  assert.match(
    source,
    /const explicitWorkflowRuntime = new ExplicitWorkflowRuntime\(\{[\s\S]*?workflowStore: explicitWorkflowStore,[\s\S]*?workerResultInboxStore/,
  );
});
