import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DYNAMIC_CONTEXT_BASELINE_PROTOCOL,
  type DynamicContextBaseline,
  type DynamicContextScope,
} from "@turnkeyai/core-types/dynamic-context-baseline";

import { FileDynamicContextBaselineStore } from "./file-dynamic-context-baseline-store";

const scope: DynamicContextScope = {
  threadId: "thread-1",
  roleId: "role-1",
  flowId: "flow-1",
};

function baseline(
  overrides: Partial<DynamicContextBaseline> = {},
): DynamicContextBaseline {
  return {
    protocol: DYNAMIC_CONTEXT_BASELINE_PROTOCOL,
    baselineId: "baseline-1",
    scope,
    promptPackVersion: "prompt-pack-1",
    modelFingerprint: "model-1",
    toolFingerprint: "tools-1",
    sections: [
      {
        name: "task-prompt",
        version: "1",
        digest: "digest-1",
        sourceRefs: ["task:1"],
        packedTokens: 10,
        omitted: false,
        updatedAt: 100,
      },
    ],
    activatedAt: 100,
    ...overrides,
  };
}

test("dynamic context baseline store atomically replaces one scope", async () => {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "turnkeyai-dynamic-context-"),
  );
  const store = new FileDynamicContextBaselineStore({ rootDir });
  await store.put(baseline());
  await store.put(baseline({
    baselineId: "baseline-2",
    activatedAt: 200,
  }));

  assert.equal((await store.get(scope))?.baselineId, "baseline-2");
  assert.equal(
    await store.get({ ...scope, roleId: "other-role" }),
    null,
  );
});

test("dynamic context baseline store rejects malformed receipts", async () => {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "turnkeyai-dynamic-context-"),
  );
  const store = new FileDynamicContextBaselineStore({ rootDir });

  await assert.rejects(
    store.put({
      ...baseline(),
      sections: [
        {
          ...baseline().sections[0]!,
          packedTokens: Number.NaN,
        },
      ],
    }),
    /invalid dynamic context baseline/,
  );
});
