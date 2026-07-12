import assert from "node:assert/strict";
import test from "node:test";

import {
  RunEffectLedger,
  restoreRunEffectLedger,
} from "./effect-ledger";

test("effect identity is stable across object key order and rejects semantic reuse", () => {
  const ledger = new RunEffectLedger();
  ledger.admit({
    round: 1,
    call: { id: "effect-1", name: "publish", input: { a: 1, b: 2 } },
  });

  assert.equal(
    ledger.admit({
      round: 1,
      call: { id: "effect-1", name: "publish", input: { b: 2, a: 1 } },
    }).status,
    "admitted",
  );
  assert.throws(
    () => ledger.admit({
      round: 1,
      call: { id: "effect-1", name: "publish", input: { a: 2, b: 1 } },
    }),
    /different proposal/,
  );
});

test("restoration rejects tampered signatures and duplicate effect ids", () => {
  const ledger = new RunEffectLedger();
  ledger.admit({
    round: 1,
    call: { id: "effect-1", name: "publish", input: {} },
  });
  const snapshot = ledger.snapshot();

  assert.equal(
    restoreRunEffectLedger({
      ...snapshot,
      records: [{ ...snapshot.records[0], signature: "tampered" }],
    }),
    null,
  );
  assert.equal(
    restoreRunEffectLedger({
      ...snapshot,
      records: [snapshot.records[0], snapshot.records[0]],
    }),
    null,
  );
});

test("receipt payload is released after transcript durability is established", () => {
  const ledger = new RunEffectLedger();
  ledger.admit({
    round: 1,
    call: { id: "effect-1", name: "fetch", input: {} },
  });
  ledger.start("effect-1");
  ledger.recordResult({
    toolCallId: "effect-1",
    toolName: "fetch",
    content: "large durable result",
  });

  ledger.releaseDurableResults(new Set(["effect-1"]));

  assert.equal(ledger.snapshot().records[0]?.status, "committed");
  assert.equal(ledger.snapshot().records[0]?.result, undefined);
});

test("receipt identity must match the admitted proposal", () => {
  const ledger = new RunEffectLedger();
  ledger.admit({
    round: 1,
    call: { id: "effect-1", name: "publish", input: {} },
  });
  ledger.start("effect-1");

  assert.throws(
    () => ledger.recordResult({
      toolCallId: "effect-1",
      toolName: "different_tool",
      content: "wrong receipt",
    }),
    /receipt tool does not match proposal/,
  );
});
