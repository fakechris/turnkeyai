import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2]?.trim();
if (!tag) throw new Error("Usage: verify-release-version.mjs <release-tag>");

const packageJson = JSON.parse(await readFile(path.join(desktopDir, "package.json"), "utf8"));
const expectedTag = `desktop-v${packageJson.version}`;
if (tag !== expectedTag) {
  throw new Error(
    `Desktop package version ${packageJson.version} requires release tag ${expectedTag}, received ${tag}`
  );
}
console.info(`[desktop] release tag matches package version: ${tag}`);
