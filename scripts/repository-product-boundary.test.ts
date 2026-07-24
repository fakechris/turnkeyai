import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const SCAN_ROOTS = ["."];
const SKIPPED_DIRECTORIES = new Set([
  ".artifacts",
  ".daemon-data",
  ".git",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "output",
  "tmp",
]);
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".scss",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

test("repository product boundary excludes vendor-specific research vocabulary", () => {
  const forbidden = String.fromCharCode(97, 99, 99, 105, 111);
  const pattern = new RegExp(forbidden, "iu");
  const violations: string[] = [];

  for (const root of SCAN_ROOTS) {
    for (const file of listTextFiles(root)) {
      if (pattern.test(file) || pattern.test(readFileSync(file, "utf8"))) {
        violations.push(file);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Vendor-specific research belongs outside this repository: ${violations.join(", ")}`,
  );
});

function listTextFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(target);
        continue;
      }
      if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(target);
      }
    }
  }
  return files.sort();
}
