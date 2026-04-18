import { access, readFile } from "node:fs/promises";
import path from "node:path";

interface ChromeExtensionManifest {
  background?: {
    service_worker?: string;
  };
  content_scripts?: Array<{
    js?: string[];
  }>;
}

const extensionDir = path.join(import.meta.dirname, "..", "dist", "extension");
const VERIFY_TIMEOUT_MS = 5_000;
const VERIFY_POLL_INTERVAL_MS = 50;

async function main(): Promise<void> {
  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = (await readJsonFileWithRetry(manifestPath, VERIFY_TIMEOUT_MS)) as ChromeExtensionManifest;

  const requiredFiles = [
    manifestPath,
    path.join(extensionDir, manifest.background?.service_worker ?? "service-worker.js"),
    ...((manifest.content_scripts ?? []).flatMap((entry) => (entry.js ?? []).map((file) => path.join(extensionDir, file)))),
  ];

  for (const filePath of requiredFiles) {
    await waitForFile(filePath, VERIFY_TIMEOUT_MS);
  }

  console.info(`verified relay extension dist: ${extensionDir}`);
}

async function readJsonFileWithRetry(filePath: string, timeoutMs: number): Promise<unknown> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) {
        throw error;
      }
      await sleep(VERIFY_POLL_INTERVAL_MS);
    }
  }
  throw lastError instanceof Error
    ? new Error(`timed out waiting for readable JSON file: ${filePath}`, { cause: lastError })
    : new Error(`timed out waiting for readable JSON file: ${filePath}`);
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) {
        throw error;
      }
      await sleep(VERIFY_POLL_INTERVAL_MS);
    }
  }
  throw lastError instanceof Error
    ? new Error(`timed out waiting for extension dist file: ${filePath}`, { cause: lastError })
    : new Error(`timed out waiting for extension dist file: ${filePath}`);
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof SyntaxError) {
    return true;
  }
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "EBUSY")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
