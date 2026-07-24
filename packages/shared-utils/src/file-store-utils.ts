import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Durability level for atomic JSON writes.
 * - `"fast"` (default): temp-file + atomic rename, no fsync. Preserves the
 *   historical behavior; appropriate for high-frequency derived state.
 * - `"strict"`: fsync the temp file before rename and fsync the containing
 *   directory after, so the content survives power loss. Use for
 *   authoritative stores whose loss is unrecoverable (memory, checkpoints).
 */
export type FileStoreDurability = "strict" | "fast";

/** How readJsonFile reacts to a non-empty file that fails to parse. */
export type FileStoreCorruptionPolicy = "throw" | "quarantine";

export interface ReadJsonFileOptions {
  onCorruption?: FileStoreCorruptionPolicy;
}

export async function readJsonFile<T>(
  filePath: string,
  options: ReadJsonFileOptions = {},
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (raw.length === 0) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    if (options.onCorruption !== "quarantine") {
      throw error;
    }
    // A malformed (non-empty) file must not wedge the store forever: move
    // it aside so a fresh state can be written, and surface it loudly. The
    // authoritative source can re-derive; silently returning null without
    // preserving the bytes would hide the corruption.
    await quarantineCorruptFile(filePath, error);
    return null;
  }
}

async function quarantineCorruptFile(
  filePath: string,
  error: unknown,
): Promise<void> {
  // Date.now() keeps distinct quarantine copies if a file corrupts twice.
  const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
  try {
    await rename(filePath, quarantinePath);
  } catch {
    // If the move fails the read still degrades to null; the original
    // corruption remains authoritative for logging below.
  }
  console.error("quarantined corrupt json store file", {
    filePath,
    quarantinePath,
    error: error instanceof Error ? error.message : String(error),
  });
}

export interface WriteJsonFileOptions {
  durability?: FileStoreDurability;
}

export async function writeJsonFileAtomic(
  filePath: string,
  payload: unknown,
  options: WriteJsonFileOptions = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const strict = options.durability === "strict";
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(serialized, "utf8");
    if (strict) {
      // Flush the temp file's contents to disk BEFORE the rename, so a
      // power loss between rename and flush cannot leave an empty target.
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
  if (strict) {
    await fsyncDirectory(dir);
  }
}

async function fsyncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unsupported on some platforms (e.g. Windows) and
    // the rename itself is already atomic; dir-entry durability is
    // best-effort.
  } finally {
    await handle?.close();
  }
}

export async function listJsonFiles(rootDir: string): Promise<string[]> {
  await mkdir(rootDir, { recursive: true });
  const entries = await readdir(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(rootDir, entry.name));
}

export async function removeFileIfExists(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}
