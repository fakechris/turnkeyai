import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogConfigReport } from "../api/types";
import { modelCatalogFileActionState } from "./SettingsPage";

const config: ModelCatalogConfigReport = {
  currentModelCatalogPath: "/tmp/models.local.json",
  editableModelCatalogPath: "/tmp/models.local.json",
  exists: true,
  content: "{}",
  restartRequired: false,
  liveReloadAvailable: true,
  validation: {
    ok: true,
    errors: [],
    warnings: [],
    modelCount: 1,
    chainCount: 0,
    missingApiKeyEnvs: [],
    missingBaseUrlEnvs: [],
  },
};

test("model catalog file actions require admin scope and an active editable file", () => {
  assert.deepEqual(modelCatalogFileActionState(config, "read"), {
    canOpen: false,
    canReload: false,
    reloadHint: "Admin token required",
  });
  assert.deepEqual(modelCatalogFileActionState(config, "admin"), {
    canOpen: true,
    canReload: true,
    reloadHint: "Reload changes from disk",
  });
  assert.deepEqual(modelCatalogFileActionState(config, "unknown"), {
    canOpen: true,
    canReload: true,
    reloadHint: "Reload changes from disk",
  });
  assert.deepEqual(modelCatalogFileActionState({ ...config, exists: false }, "admin"), {
    canOpen: true,
    canReload: false,
    reloadHint: "Open the file to create it first",
  });
  assert.deepEqual(modelCatalogFileActionState({ ...config, liveReloadAvailable: false, restartRequired: true }, "admin"), {
    canOpen: true,
    canReload: false,
    reloadHint: "Restart the daemon to activate this file",
  });
});
