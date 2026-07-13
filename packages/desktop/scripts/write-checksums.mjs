import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.resolve(process.argv[2] ?? path.join(desktopDir, "dist", "release"));
const files = (await readdir(artifactDir))
  .filter((name) => name.endsWith(".dmg"))
  .sort();

if (files.length === 0) {
  throw new Error(`No DMG artifacts found in ${artifactDir}`);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const lines = [];
for (const name of files) {
  lines.push(`${await sha256(path.join(artifactDir, name))}  ${name}`);
}
const checksumFile = path.join(artifactDir, "SHA256SUMS.txt");
await writeFile(checksumFile, `${lines.join("\n")}\n`);
console.info(`[desktop] wrote ${checksumFile}`);
