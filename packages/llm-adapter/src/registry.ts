import type {
  ModelCatalog,
  ModelCatalogSource,
  ModelChainEntry,
  ModelConfigEntry,
  ModelProtocol,
  ModelSelection,
  NamedModelChainEntry,
  NamedModelConfigEntry,
  ResolvedModelConfig,
} from "./types";

interface NormalizedModelCatalog {
  defaultModelId?: string;
  defaultModelChainId?: string;
  models: ModelConfigEntry[];
  modelChains: ModelChainEntry[];
}

export class ModelRegistry {
  private readonly source: ModelCatalogSource;
  private loadedCatalog: NormalizedModelCatalog | null = null;

  constructor(source: ModelCatalogSource) {
    this.source = source;
  }

  async list(): Promise<ModelConfigEntry[]> {
    const catalog = await this.loadCatalog();
    return catalog.models.filter((item) => item.enabled !== false);
  }

  async listChains(): Promise<ModelChainEntry[]> {
    const catalog = await this.loadCatalog();
    return catalog.modelChains.filter((item) => item.enabled !== false);
  }

  async describeSelection(input: { modelId?: string; modelChainId?: string }): Promise<{
    chainId?: string;
    primary: ModelConfigEntry;
    fallbacks: ModelConfigEntry[];
  }> {
    const catalog = await this.loadCatalog();
    const selection = this.resolveSelectionFromCatalog(catalog, input);
    return {
      ...(selection.chainId ? { chainId: selection.chainId } : {}),
      primary: this.resolveModelEntry(catalog, selection.primaryModelId),
      fallbacks: selection.fallbackModelIds.map((modelId) => this.resolveModelEntry(catalog, modelId)),
    };
  }

  async resolveSelection(input: { modelId?: string; modelChainId?: string }): Promise<ModelSelection> {
    const catalog = await this.loadCatalog();
    return this.resolveSelectionFromCatalog(catalog, input);
  }

  async resolve(modelId?: string): Promise<ResolvedModelConfig> {
    const catalog = await this.loadCatalog();
    const entry = this.resolveModelEntry(catalog, modelId ?? catalog.defaultModelId);
    const apiKey = process.env[entry.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`missing API key env: ${entry.apiKeyEnv}`);
    }

    const baseURL = entry.baseURL ?? (entry.baseURLEnv ? process.env[entry.baseURLEnv] : undefined);
    if (!baseURL) {
      throw new Error(
        entry.baseURLEnv
          ? `missing base URL env: ${entry.baseURLEnv}`
          : `missing base URL for model: ${entry.id}`
      );
    }

    return {
      ...entry,
      baseURL,
      apiKey,
    };
  }

  private async loadCatalog(): Promise<NormalizedModelCatalog> {
    if (this.loadedCatalog) {
      return this.loadedCatalog;
    }

    this.loadedCatalog = normalizeCatalog(await this.source.load());
    return this.loadedCatalog;
  }

  private resolveSelectionFromCatalog(
    catalog: NormalizedModelCatalog,
    input: { modelId?: string; modelChainId?: string }
  ): ModelSelection {
    const selectedChainId = input.modelChainId ?? (!input.modelId ? catalog.defaultModelChainId : undefined);
    if (selectedChainId) {
      const chain = catalog.modelChains.find(
        (item) => item.id === selectedChainId || item.aliases?.includes(selectedChainId)
      );
      if (chain) {
        return {
          chainId: chain.id,
          primaryModelId: chain.primary,
          fallbackModelIds: dedupeModelIds(chain.fallbacks ?? []),
        };
      }
      if (input.modelId) {
        return {
          primaryModelId: input.modelId,
          fallbackModelIds: [],
        };
      }
      throw new Error(`model chain not found in catalog: ${selectedChainId}`);
    }

    const selectedModelId = input.modelId ?? catalog.defaultModelId;
    if (!selectedModelId) {
      throw new Error("no model or model chain requested and no defaults configured");
    }
    return {
      primaryModelId: selectedModelId,
      fallbackModelIds: [],
    };
  }

  private resolveModelEntry(catalog: NormalizedModelCatalog, modelId?: string): ModelConfigEntry {
    if (!modelId) {
      throw new Error("no model id requested and no defaultModelId configured");
    }
    const entry = catalog.models.find((item) => item.id === modelId || item.aliases?.includes(modelId));
    if (!entry || entry.enabled === false) {
      throw new Error(`model not found in catalog: ${modelId}`);
    }
    return entry;
  }
}

function normalizeCatalog(catalog: ModelCatalog): NormalizedModelCatalog {
  return {
    ...(catalog.defaultModelId ? { defaultModelId: catalog.defaultModelId } : {}),
    ...(catalog.defaultModelChainId ? { defaultModelChainId: catalog.defaultModelChainId } : {}),
    models: normalizeModels(catalog.models),
    modelChains: normalizeChains(catalog.modelChains),
  };
}

function normalizeModels(
  models: ModelCatalog["models"]
): ModelConfigEntry[] {
  if (Array.isArray(models)) {
    return models.map((entry) => normalizeModelEntry(entry.id, entry));
  }

  return Object.entries(models).map(([id, entry]) => normalizeModelEntry(id, entry));
}

function normalizeChains(
  modelChains: ModelCatalog["modelChains"] | undefined
): ModelChainEntry[] {
  if (!modelChains) {
    return [];
  }
  if (Array.isArray(modelChains)) {
    return modelChains.map((entry) => normalizeChainEntry(entry.id, entry));
  }
  return Object.entries(modelChains).map(([id, entry]) => normalizeChainEntry(id, entry));
}

function normalizeModelEntry(id: string, entry: ModelConfigEntry | NamedModelConfigEntry): ModelConfigEntry {
  return {
    id,
    label: entry.label,
    providerId: entry.providerId,
    protocol: normalizeProtocol(entry),
    model: entry.model,
    ...(entry.baseURL ? { baseURL: entry.baseURL } : {}),
    ...(entry.baseURLEnv ? { baseURLEnv: entry.baseURLEnv } : {}),
    apiKeyEnv: entry.apiKeyEnv,
    ...(entry.headers ? { headers: entry.headers } : {}),
    ...(entry.query ? { query: entry.query } : {}),
    ...(entry.temperature != null ? { temperature: entry.temperature } : {}),
    ...(entry.maxOutputTokens != null ? { maxOutputTokens: entry.maxOutputTokens } : {}),
    ...(entry.aliases ? { aliases: entry.aliases } : {}),
    ...(entry.enabled != null ? { enabled: entry.enabled } : {}),
  };
}

function normalizeChainEntry(id: string, entry: ModelChainEntry | NamedModelChainEntry): ModelChainEntry {
  return {
    id,
    primary: entry.primary,
    ...(entry.fallbacks?.length ? { fallbacks: dedupeModelIds(entry.fallbacks) } : {}),
    ...(entry.aliases ? { aliases: entry.aliases } : {}),
    ...(entry.enabled != null ? { enabled: entry.enabled } : {}),
  };
}

function normalizeProtocol(entry: ModelConfigEntry | NamedModelConfigEntry): ModelProtocol {
  if (entry.protocol) {
    return entry.protocol;
  }
  if (entry.apiType === "openai") {
    return "openai-compatible";
  }
  if (entry.apiType === "anthropic") {
    return "anthropic-compatible";
  }
  if (entry.apiType === "openai-compatible" || entry.apiType === "anthropic-compatible") {
    return entry.apiType;
  }
  throw new Error(`missing protocol/apiType for model: ${entry.id ?? "unknown"}`);
}

function dedupeModelIds(modelIds: string[]): string[] {
  return [...new Set(modelIds.filter(Boolean))];
}
