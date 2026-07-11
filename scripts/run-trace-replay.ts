import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ReplayRecord } from "@turnkeyai/core-types/team";
import { replayEngineRunRecord } from "@turnkeyai/role-runtime/run-trace-replay";

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("usage: npm run replay:run-trace -- <replay-record.json>");
}

const absolutePath = path.resolve(inputPath);
const record = JSON.parse(await readFile(absolutePath, "utf8")) as ReplayRecord;
const previousFetch = globalThis.fetch;
let providerCalls = 0;
globalThis.fetch = (async () => {
  providerCalls += 1;
  throw new Error("RunTrace replay attempted a provider transport call");
}) as typeof fetch;
const [first, second] = await (async () => {
  try {
    return [
      await replayEngineRunRecord(record),
      await replayEngineRunRecord(record),
    ] as const;
  } finally {
    globalThis.fetch = previousFetch;
  }
})();
assert.deepEqual(second, first, "run trace replay was not deterministic");
assert.equal(providerCalls, 0, "run trace replay invoked a provider transport");

console.log(
  JSON.stringify(
    {
      replayId: record.replayId,
      deterministicRuns: 2,
      providerCalls,
      finalTextBytes: Buffer.byteLength(first.finalText, "utf8"),
      toolCalls: first.toolCalls.length,
      policyEntries: first.policy.length,
    },
    null,
    2,
  ),
);
