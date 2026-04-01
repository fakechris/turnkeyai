import type { ModelCatalog, ModelCatalogSource, ModelConfigEntry, ResolvedModelConfig } from "./types";

export class ModelRegistry {
  private readonly source: ModelCatalogSource;
  private loadedCatalog: ModelCatalog | null = null;

  constructor(source: ModelCatalogSource) {
    this.source = source;
  }

  async list(): Promise<ModelConfigEntry[]> {
    const catalog = await this.loadCatalog();
    return catalog.models.filter((item) => item.enabled !== false);
  }

  async resolve(modelId?: string): Promise<ResolvedModelConfig> {
    const catalog = await this.loadCatalog();
    const selectedId = modelId ?? catalog.defaultModelId;
    if (!selectedId) {
      throw new Error("no model id requested and no defaultModelId configured");
    }

    const entry = catalog.models.find(
      (item) => item.id === selectedId || item.aliases?.includes(selectedId)
    );

    if (!entry) {
      throw new Error(`model not found in catalog: ${selectedId}`);
    }

    const apiKey = process.env[entry.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`missing API key env: ${entry.apiKeyEnv}`);
    }

    return {
      ...entry,
      apiKey,
    };
  }

  private async loadCatalog(): Promise<ModelCatalog> {
    if (this.loadedCatalog) {
      return this.loadedCatalog;
    }

    this.loadedCatalog = await this.source.load();
    return this.loadedCatalog;
  }
}
