import type http from "node:http";
import { access, readFile } from "node:fs/promises";

import type { ModelCatalog } from "@turnkeyai/llm-adapter/types";
import { ModelRegistry } from "@turnkeyai/llm-adapter/registry";
import { writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

import { readJsonBodySafe, sendJson } from "../http-helpers";

export interface DaemonConfigRouteDeps {
  currentModelCatalogPath: string | null;
  editableModelCatalogPath: string;
  reloadActiveModelCatalog?(): Promise<void>;
}

interface ModelCatalogConfigBody {
  content?: unknown;
}

interface ModelCatalogValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  modelCount: number;
  chainCount: number;
  missingApiKeyEnvs: string[];
  missingBaseUrlEnvs: string[];
}

export async function handleDaemonConfigRoutes(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  deps: DaemonConfigRouteDeps;
}): Promise<boolean> {
  const { req, res, url, deps } = input;
  if (url.pathname !== "/daemon/config/model-catalog") {
    return false;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    const report = await buildModelCatalogConfigReport(deps);
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end();
      return true;
    }
    sendJson(res, 200, report);
    return true;
  }
  if (req.method === "PUT") {
    const body = await readJsonBodySafe<ModelCatalogConfigBody>(req);
    if (!body.ok) {
      sendJson(res, 400, { error: "Invalid JSON" });
      return true;
    }
    if (typeof body.value.content !== "string") {
      sendJson(res, 400, { error: "content must be a JSON string" });
      return true;
    }
    const parsed = parseCatalogContent(body.value.content);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return true;
    }
    const validation = await validateModelCatalog(parsed.catalog);
    if (!validation.ok) {
      sendJson(res, 400, { error: "model catalog validation failed", validation });
      return true;
    }

    await writeJsonFileAtomic(deps.editableModelCatalogPath, parsed.catalog);
    const activePathMatches = deps.currentModelCatalogPath === deps.editableModelCatalogPath;
    let restartRequired = !activePathMatches || !deps.reloadActiveModelCatalog;
    if (activePathMatches && deps.reloadActiveModelCatalog) {
      await deps.reloadActiveModelCatalog();
      restartRequired = false;
    }
    sendJson(res, 200, {
      ...(await buildModelCatalogConfigReport(deps, parsed.catalog)),
      saved: true,
      restartRequired,
    });
    return true;
  }
  return false;
}

async function buildModelCatalogConfigReport(
  deps: DaemonConfigRouteDeps,
  savedCatalog?: ModelCatalog
): Promise<{
  currentModelCatalogPath: string | null;
  editableModelCatalogPath: string;
  exists: boolean;
  content: string;
  validation: ModelCatalogValidation;
  liveReloadAvailable: boolean;
  restartRequired: boolean;
}> {
  const contentResult = savedCatalog
    ? { exists: true, content: `${JSON.stringify(savedCatalog, null, 2)}\n`, catalog: savedCatalog }
    : await readEditableCatalog(deps.editableModelCatalogPath);
  const validation = contentResult.catalog
    ? await validateModelCatalog(contentResult.catalog)
    : emptyValidation("No editable model catalog exists yet.");
  const liveReloadAvailable =
    deps.currentModelCatalogPath === deps.editableModelCatalogPath && Boolean(deps.reloadActiveModelCatalog);
  return {
    currentModelCatalogPath: deps.currentModelCatalogPath,
    editableModelCatalogPath: deps.editableModelCatalogPath,
    exists: contentResult.exists,
    content: contentResult.content,
    validation,
    liveReloadAvailable,
    restartRequired: deps.currentModelCatalogPath !== deps.editableModelCatalogPath,
  };
}

async function readEditableCatalog(filePath: string): Promise<{
  exists: boolean;
  content: string;
  catalog?: ModelCatalog;
}> {
  const exists = await access(filePath).then(() => true, () => false);
  if (!exists) {
    return { exists: false, content: `${JSON.stringify(defaultModelCatalogTemplate(), null, 2)}\n` };
  }
  const content = await readFile(filePath, "utf8");
  const parsed = parseCatalogContent(content);
  return parsed.ok
    ? { exists: true, content, catalog: parsed.catalog }
    : { exists: true, content };
}

function parseCatalogContent(content: string): { ok: true; catalog: ModelCatalog } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed) || Array.isArray(parsed)) {
      return { ok: false, error: "model catalog must be a JSON object" };
    }
    return { ok: true, catalog: parsed as unknown as ModelCatalog };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `invalid model catalog JSON: ${error.message}` : "invalid model catalog JSON" };
  }
}

async function validateModelCatalog(catalog: ModelCatalog): Promise<ModelCatalogValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const modelEntries = collectModelEntries(catalog, errors);
  const modelIds = new Set(modelEntries.map((entry) => entry.id));
  const chainEntries = collectChainEntries(catalog, errors);
  const missingApiKeyEnvs = unique(
    modelEntries
      .map((entry) => entry.apiKeyEnv)
      .filter((envName): envName is string => Boolean(envName && !process.env[envName]))
  );
  const missingBaseUrlEnvs = unique(
    modelEntries
      .map((entry) => entry.baseURLEnv)
      .filter((envName): envName is string => Boolean(envName && !process.env[envName]))
  );

  if (!catalog.defaultModelId && !catalog.defaultModelChainId) {
    errors.push("defaultModelId or defaultModelChainId is required");
  }
  for (const chain of chainEntries) {
    if (!modelIds.has(chain.primary)) {
      errors.push(`model chain ${chain.id} primary references unknown model ${chain.primary}`);
    }
    for (const fallback of chain.fallbacks) {
      if (!modelIds.has(fallback)) {
        errors.push(`model chain ${chain.id} fallback references unknown model ${fallback}`);
      }
    }
  }
  if (catalog.defaultModelId && !modelIds.has(catalog.defaultModelId)) {
    errors.push(`defaultModelId references unknown model ${catalog.defaultModelId}`);
  }
  if (catalog.defaultModelChainId && !chainEntries.some((chain) => chain.id === catalog.defaultModelChainId)) {
    errors.push(`defaultModelChainId references unknown chain ${catalog.defaultModelChainId}`);
  }
  if (missingApiKeyEnvs.length > 0) {
    warnings.push(`Missing API key env: ${missingApiKeyEnvs.join(", ")}`);
  }
  if (missingBaseUrlEnvs.length > 0) {
    warnings.push(`Missing base URL env: ${missingBaseUrlEnvs.join(", ")}`);
  }

  if (errors.length === 0) {
    const registry = new ModelRegistry({ load: async () => catalog });
    await registry.describeSelection({}).catch((error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    modelCount: modelEntries.length,
    chainCount: chainEntries.length,
    missingApiKeyEnvs,
    missingBaseUrlEnvs,
  };
}

function collectModelEntries(catalog: ModelCatalog, errors: string[]): Array<{
  id: string;
  apiKeyEnv?: string;
  baseURLEnv?: string;
}> {
  if (!catalog.models || (!Array.isArray(catalog.models) && !isRecord(catalog.models))) {
    errors.push("models must be a non-empty array or object");
    return [];
  }
  const entries = Array.isArray(catalog.models)
    ? catalog.models.map((entry) => ({ id: (entry as { id?: unknown }).id, entry }))
    : Object.entries(catalog.models).map(([id, entry]) => ({ id, entry }));
  if (entries.length === 0) {
    errors.push("models must contain at least one model");
  }
  return entries.flatMap(({ id, entry }, index) => {
    const label = `model ${typeof id === "string" && id.trim() ? id : `#${index + 1}`}`;
    if (typeof id !== "string" || !id.trim()) {
      errors.push(`${label} id is required`);
    }
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`);
      return [];
    }
    requireString(entry, "label", label, errors);
    requireString(entry, "providerId", label, errors);
    requireString(entry, "model", label, errors);
    const protocol = typeof entry.protocol === "string" ? entry.protocol : undefined;
    const apiType = typeof entry.apiType === "string" ? entry.apiType : undefined;
    if (
      protocol !== "openai-compatible" &&
      protocol !== "anthropic-compatible" &&
      apiType !== "openai" &&
      apiType !== "anthropic" &&
      apiType !== "openai-compatible" &&
      apiType !== "anthropic-compatible"
    ) {
      errors.push(`${label} protocol/apiType must be openai-compatible, anthropic-compatible, openai, or anthropic`);
    }
    if (typeof entry.apiKeyEnv !== "string" || !entry.apiKeyEnv.trim()) {
      errors.push(`${label} apiKeyEnv is required`);
    }
    if (
      (typeof entry.baseURL !== "string" || !entry.baseURL.trim()) &&
      (typeof entry.baseURLEnv !== "string" || !entry.baseURLEnv.trim())
    ) {
      errors.push(`${label} baseURL or baseURLEnv is required`);
    }
    return [{
      id: typeof id === "string" ? id : "",
      ...(typeof entry.apiKeyEnv === "string" ? { apiKeyEnv: entry.apiKeyEnv } : {}),
      ...(typeof entry.baseURLEnv === "string" ? { baseURLEnv: entry.baseURLEnv } : {}),
    }];
  });
}

function collectChainEntries(catalog: ModelCatalog, errors: string[]): Array<{ id: string; primary: string; fallbacks: string[] }> {
  if (!catalog.modelChains) return [];
  if (!Array.isArray(catalog.modelChains) && !isRecord(catalog.modelChains)) {
    errors.push("modelChains must be an array or object");
    return [];
  }
  const entries = Array.isArray(catalog.modelChains)
    ? catalog.modelChains.map((entry) => ({ id: (entry as { id?: unknown }).id, entry }))
    : Object.entries(catalog.modelChains).map(([id, entry]) => ({ id, entry }));
  return entries.flatMap(({ id, entry }, index) => {
    const label = `model chain ${typeof id === "string" && id.trim() ? id : `#${index + 1}`}`;
    if (typeof id !== "string" || !id.trim()) {
      errors.push(`${label} id is required`);
    }
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`);
      return [];
    }
    if (typeof entry.primary !== "string" || !entry.primary.trim()) {
      errors.push(`${label} primary is required`);
    }
    const rawFallbacks = entry.fallbacks;
    if (rawFallbacks !== undefined && (!Array.isArray(rawFallbacks) || rawFallbacks.some((item) => typeof item !== "string" || !item.trim()))) {
      errors.push(`${label} fallbacks must be non-empty strings`);
    }
    return [{
      id: typeof id === "string" ? id : "",
      primary: typeof entry.primary === "string" ? entry.primary : "",
      fallbacks: Array.isArray(rawFallbacks) ? rawFallbacks.filter((item): item is string => typeof item === "string") : [],
    }];
  });
}

function defaultModelCatalogTemplate(): ModelCatalog {
  return {
    defaultModelChainId: "primary",
    models: {
      primary_model: {
        label: "Primary model",
        providerId: "provider",
        apiType: "anthropic",
        model: "model-name",
        baseURLEnv: "ANTHROPIC_BASE_URL",
        apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
      },
    },
    modelChains: {
      primary: {
        primary: "primary_model",
        fallbacks: [],
      },
    },
  };
}

function emptyValidation(message: string): ModelCatalogValidation {
  return {
    ok: false,
    errors: [message],
    warnings: [],
    modelCount: 0,
    chainCount: 0,
    missingApiKeyEnvs: [],
    missingBaseUrlEnvs: [],
  };
}

function requireString(record: Record<string, unknown>, key: string, label: string, errors: string[]): void {
  if (typeof record[key] !== "string" || !(record[key] as string).trim()) {
    errors.push(`${label} ${key} is required`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
