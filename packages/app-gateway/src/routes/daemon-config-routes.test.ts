import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import test from "node:test";

import {
  handleDaemonConfigRoutes,
  type DaemonConfigRouteDeps,
} from "./daemon-config-routes";

function createRequest(input: { method: string; url: string; body?: unknown }) {
  const body =
    input.body === undefined ? [] : [Buffer.from(typeof input.body === "string" ? input.body : JSON.stringify(input.body))];
  return Object.assign(Readable.from(body), {
    method: input.method,
    url: input.url,
    headers: {},
  }) as any;
}

function createResponse() {
  let payload = "";
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as any;
  return {
    res,
    get status() {
      return res.statusCode;
    },
    get json() {
      return payload ? JSON.parse(payload) : undefined;
    },
  };
}

function deps(overrides: Partial<DaemonConfigRouteDeps> = {}): DaemonConfigRouteDeps {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-model-config-route-"));
  return {
    currentModelCatalogPath: null,
    editableModelCatalogPath: path.join(dir, "models.local.json"),
    ...overrides,
  };
}

test("GET /daemon/config/model-catalog returns an editable template when no file exists", async () => {
  const routeDeps = deps();
  try {
    const response = createResponse();
    const handled = await handleDaemonConfigRoutes({
      req: createRequest({ method: "GET", url: "/daemon/config/model-catalog" }),
      res: response.res,
      url: new URL("http://127.0.0.1/daemon/config/model-catalog"),
      deps: routeDeps,
    });

    assert.equal(handled, true);
    assert.equal(response.status, 200);
    assert.equal(response.json.exists, false);
    assert.equal(response.json.restartRequired, true);
    assert.match(response.json.content, /primary_model/);
    assert.equal(response.json.validation.ok, false);
  } finally {
    rmSync(path.dirname(routeDeps.editableModelCatalogPath), { recursive: true, force: true });
  }
});

test("PUT /daemon/config/model-catalog validates and writes a catalog", async () => {
  const routeDeps = deps();
  const catalog = validCatalog();
  try {
    const response = createResponse();
    const handled = await handleDaemonConfigRoutes({
      req: createRequest({
        method: "PUT",
        url: "/daemon/config/model-catalog",
        body: { content: JSON.stringify(catalog) },
      }),
      res: response.res,
      url: new URL("http://127.0.0.1/daemon/config/model-catalog"),
      deps: routeDeps,
    });

    assert.equal(handled, true);
    assert.equal(response.status, 200);
    assert.equal(response.json.saved, true);
    assert.equal(response.json.restartRequired, true);
    assert.equal(response.json.validation.ok, true);
    assert.deepEqual(JSON.parse(await readFile(routeDeps.editableModelCatalogPath, "utf8")), catalog);
  } finally {
    rmSync(path.dirname(routeDeps.editableModelCatalogPath), { recursive: true, force: true });
  }
});

test("PUT /daemon/config/model-catalog rejects invalid catalogs before writing", async () => {
  const routeDeps = deps();
  try {
    const response = createResponse();
    await handleDaemonConfigRoutes({
      req: createRequest({
        method: "PUT",
        url: "/daemon/config/model-catalog",
        body: { content: JSON.stringify({ models: {} }) },
      }),
      res: response.res,
      url: new URL("http://127.0.0.1/daemon/config/model-catalog"),
      deps: routeDeps,
    });

    assert.equal(response.status, 400);
    assert.match(response.json.error, /validation failed/);
    assert.ok(response.json.validation.errors.some((entry: string) => /defaultModelId/.test(entry)));
  } finally {
    rmSync(path.dirname(routeDeps.editableModelCatalogPath), { recursive: true, force: true });
  }
});

test("PUT /daemon/config/model-catalog reloads live runtime when editing the active file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-model-config-live-"));
  const file = path.join(dir, "models.local.json");
  writeFileSync(file, JSON.stringify(validCatalog()), "utf8");
  let reloads = 0;
  try {
    const response = createResponse();
    await handleDaemonConfigRoutes({
      req: createRequest({
        method: "PUT",
        url: "/daemon/config/model-catalog",
        body: { content: JSON.stringify(validCatalog({ defaultModelId: "fallback_model" })) },
      }),
      res: response.res,
      url: new URL("http://127.0.0.1/daemon/config/model-catalog"),
      deps: {
        currentModelCatalogPath: file,
        editableModelCatalogPath: file,
        reloadActiveModelCatalog: async () => {
          reloads += 1;
        },
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.restartRequired, false);
    assert.equal(response.json.liveReloadAvailable, true);
    assert.equal(reloads, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function validCatalog(overrides: Record<string, unknown> = {}) {
  return {
    defaultModelId: "primary_model",
    models: {
      primary_model: {
        label: "Primary",
        providerId: "test",
        protocol: "openai-compatible",
        model: "primary-model",
        baseURL: "https://primary.example/v1",
        apiKeyEnv: "PRIMARY_API_KEY",
      },
      fallback_model: {
        label: "Fallback",
        providerId: "test",
        protocol: "openai-compatible",
        model: "fallback-model",
        baseURL: "https://fallback.example/v1",
        apiKeyEnv: "FALLBACK_API_KEY",
      },
    },
    modelChains: {
      primary: {
        primary: "primary_model",
        fallbacks: ["fallback_model"],
      },
    },
    ...overrides,
  };
}
