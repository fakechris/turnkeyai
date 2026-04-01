import { access, readFile } from "node:fs/promises";

import type { ModelCatalog, ModelCatalogSource } from "./types";

export class FileModelCatalogSource implements ModelCatalogSource {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<ModelCatalog> {
    await access(this.filePath);
    const raw = await readFile(this.filePath, "utf8");
    return JSON.parse(raw) as ModelCatalog;
  }
}
