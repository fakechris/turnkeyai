import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readJsonFile,
  writeJsonFileAtomic,
} from "./file-store-utils";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "turnkeyai-file-store-"));
}

test("writeJsonFileAtomic round-trips with strict durability", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "nested", "value.json");
  await writeJsonFileAtomic(file, { hello: "world", n: 1 }, {
    durability: "strict",
  });
  const parsed = await readJsonFile<{ hello: string; n: number }>(file);
  assert.deepEqual(parsed, { hello: "world", n: 1 });
  // Written pretty with a trailing newline (unchanged serialization).
  assert.match(await readFile(file, "utf8"), /\n$/);
});

test("writeJsonFileAtomic round-trips with default (fast) durability", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "value.json");
  await writeJsonFileAtomic(file, { a: [1, 2, 3] });
  assert.deepEqual(await readJsonFile(file), { a: [1, 2, 3] });
});

test("readJsonFile returns null for a missing file", async () => {
  const dir = await tempDir();
  assert.equal(await readJsonFile(path.join(dir, "absent.json")), null);
});

test("readJsonFile returns null for an empty file", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "empty.json");
  await writeFile(file, "", "utf8");
  assert.equal(await readJsonFile(file), null);
});

test("readJsonFile throws on corrupt content by default", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "corrupt.json");
  await writeFile(file, "{ not valid json", "utf8");
  await assert.rejects(() => readJsonFile(file));
});

test("readJsonFile quarantines corrupt content and returns null", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "corrupt.json");
  await writeFile(file, "{ truncated", "utf8");

  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const result = await readJsonFile(file, { onCorruption: "quarantine" });
    assert.equal(result, null);
  } finally {
    console.error = original;
  }

  const entries = await readdir(dir);
  // Original moved aside, bytes preserved, corruption logged.
  assert.ok(!entries.includes("corrupt.json"));
  assert.ok(entries.some((name) => name.startsWith("corrupt.json.corrupt-")));
  assert.equal(errors.length, 1);
});
