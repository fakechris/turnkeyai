import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { resolveModelCatalogPaths } from "./model-catalog-paths";

test("model catalog editing targets the active fallback catalog", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "tk-model-paths-"));
  const examplePath = path.join(cwd, "models.example.json");
  writeFileSync(examplePath, "{}", "utf8");
  try {
    assert.deepEqual(await resolveModelCatalogPaths({ cwd, explicitPath: null }), {
      currentModelCatalogPath: examplePath,
      editableModelCatalogPath: examplePath,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("model catalog editing falls back to models.local.json when no catalog exists", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "tk-model-paths-"));
  try {
    assert.deepEqual(await resolveModelCatalogPaths({ cwd, explicitPath: null }), {
      currentModelCatalogPath: null,
      editableModelCatalogPath: path.join(cwd, "models.local.json"),
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a missing explicit catalog remains editable without blocking daemon startup", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "tk-model-paths-"));
  const explicitPath = path.join(cwd, "config", "models.custom.json");
  try {
    assert.deepEqual(await resolveModelCatalogPaths({ cwd, explicitPath }), {
      currentModelCatalogPath: null,
      editableModelCatalogPath: explicitPath,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
