import { access } from "node:fs/promises";
import path from "node:path";

export async function resolveModelCatalogPaths(input: {
  explicitPath?: string | null;
  cwd?: string;
} = {}): Promise<{
  currentModelCatalogPath: string | null;
  editableModelCatalogPath: string;
}> {
  const cwd = input.cwd ?? process.cwd();
  const explicit = input.explicitPath === undefined
    ? process.env.TURNKEYAI_MODEL_CATALOG?.trim()
    : input.explicitPath?.trim();
  if (explicit) {
    const candidate = path.resolve(cwd, explicit);
    await access(candidate);
    return {
      currentModelCatalogPath: candidate,
      editableModelCatalogPath: candidate,
    };
  }

  const candidates = [
    path.resolve(cwd, "models.local.json"),
    path.resolve(cwd, "models.json"),
    path.resolve(cwd, "models.example.json"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return {
        currentModelCatalogPath: candidate,
        editableModelCatalogPath: candidate,
      };
    } catch {}
  }

  return {
    currentModelCatalogPath: null,
    editableModelCatalogPath: path.resolve(cwd, "models.local.json"),
  };
}
