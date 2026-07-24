import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RunEffectLedger } from "./effect-ledger";
import {
  FileRunEffectWalStore,
  InMemoryRunEffectWalStore,
  replayEffectWal,
  type EffectWalEntry,
} from "./effect-wal";

const RUN_KEY = "role:lead:thread:t1";

function admit(seq: number, id: string): EffectWalEntry {
  return { seq, op: "admit", round: 1, call: { id, name: "publish", input: { v: seq } } };
}

test("file WAL store appends, reads in order, and truncates", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-wal-"));
  try {
    const store = new FileRunEffectWalStore({ rootDir });
    await store.append(RUN_KEY, admit(1, "call-1"));
    await store.append(RUN_KEY, { seq: 2, op: "start", effectId: "call-1" });
    await store.append(RUN_KEY, {
      seq: 3,
      op: "result",
      result: { toolCallId: "call-1", toolName: "publish", content: "ok" },
    });

    const entries = await store.readAll(RUN_KEY);
    assert.deepEqual(entries.map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(entries.map((e) => e.op), ["admit", "start", "result"]);

    await store.truncate(RUN_KEY);
    assert.deepEqual(await store.readAll(RUN_KEY), []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file WAL store tolerates a torn trailing line", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-wal-torn-"));
  try {
    const store = new FileRunEffectWalStore({ rootDir });
    await store.append(RUN_KEY, admit(1, "call-1"));
    await store.append(RUN_KEY, { seq: 2, op: "start", effectId: "call-1" });
    // Simulate a crash mid-append: a partial third line with no newline.
    const walFile = path.join(rootDir, `${encodeURIComponent(RUN_KEY)}.jsonl`);
    await appendFile(walFile, '{"seq":3,"op":"resu', "utf8");

    const entries = await store.readAll(RUN_KEY);
    // The torn transition never became durable; the tool it would have
    // recorded never dispatched, so dropping it is correct.
    assert.deepEqual(entries.map((e) => e.seq), [1, 2]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file WAL store returns empty for an absent run", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-wal-absent-"));
  try {
    const store = new FileRunEffectWalStore({ rootDir });
    assert.deepEqual(await store.readAll("never-written"), []);
    await store.truncate("never-written");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("replayEffectWal applies only entries above the watermark (idempotent boundary)", () => {
  const ledger = new RunEffectLedger();
  // Base ledger already reflects call-1 admitted+started (as if from a
  // snapshot at watermark 2).
  ledger.admit({ round: 1, call: { id: "call-1", name: "publish", input: {} } });
  ledger.start("call-1");

  const entries: EffectWalEntry[] = [
    admit(1, "call-1"), // <= watermark: already in base, must be skipped
    { seq: 2, op: "start", effectId: "call-1" }, // <= watermark: skipped
    {
      seq: 3,
      op: "result",
      result: { toolCallId: "call-1", toolName: "publish", content: "done" },
    },
    admit(4, "call-2"),
  ];
  const highest = replayEffectWal(ledger, entries, 2);

  assert.equal(highest, 4);
  // call-1 progressed to committed (result at seq 3 applied once), and re-
  // applying its admit/start at seq<=2 did not throw or corrupt it.
  assert.equal(ledger.get("call-1")?.status, "committed");
  assert.equal(ledger.get("call-2")?.status, "admitted");
});

test("replayEffectWal skips an inapplicable transition instead of aborting", () => {
  const ledger = new RunEffectLedger();
  // A start for an effect the base never admitted (torn/inconsistent log)
  // must not throw and strand recovery; a valid later admit still applies.
  const highest = replayEffectWal(
    ledger,
    [
      { seq: 1, op: "start", effectId: "missing" },
      admit(2, "call-2"),
    ],
    0,
  );
  assert.equal(highest, 2);
  assert.equal(ledger.get("missing"), null);
  assert.equal(ledger.get("call-2")?.status, "admitted");
});

test("in-memory WAL store round-trips and truncates", async () => {
  const store = new InMemoryRunEffectWalStore();
  await store.append(RUN_KEY, admit(1, "call-1"));
  assert.deepEqual((await store.readAll(RUN_KEY)).map((e) => e.seq), [1]);
  await store.truncate(RUN_KEY);
  assert.deepEqual(await store.readAll(RUN_KEY), []);
});
