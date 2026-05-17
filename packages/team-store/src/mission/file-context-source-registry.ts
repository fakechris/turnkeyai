import path from "node:path";

import type {
  ContextSource,
  ContextSourceRegistry,
} from "@turnkeyai/core-types/mission";
import {
  readJsonFile,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";

interface FileContextSourceRegistryOptions {
  rootDir: string;
}

/** Context source roster — single-file array, same shape as agents. */
export class FileContextSourceRegistry implements ContextSourceRegistry {
  private readonly file: string;

  constructor(options: FileContextSourceRegistryOptions) {
    this.file = path.join(options.rootDir, "context-sources.json");
  }

  async list(): Promise<ContextSource[]> {
    const data = await readJsonFile<{ sources: ContextSource[] }>(this.file);
    return data?.sources ?? [];
  }

  async replaceAll(sources: ContextSource[]): Promise<void> {
    await writeJsonFileAtomic(this.file, { sources });
  }
}
