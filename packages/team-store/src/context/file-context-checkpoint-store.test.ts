import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONTEXT_CHECKPOINT_PROTOCOL,
  emptyContextCheckpointWorkingSet,
  type ContextCheckpointRecord,
  type ContextCheckpointScope,
} from "@turnkeyai/core-types/context-checkpoint";

import {
  contextCheckpointScopeKey,
  FileContextCheckpointStore,
} from "./file-context-checkpoint-store";

const scope: ContextCheckpointScope = {
  threadId: "thread-1",
  roleId: "role-1",
  flowId: "flow-1",
};

function record(
  state: ContextCheckpointRecord["state"],
  overrides: Partial<ContextCheckpointRecord> = {},
): ContextCheckpointRecord {
  return {
    protocol: CONTEXT_CHECKPOINT_PROTOCOL,
    checkpointId: "checkpoint-1",
    version: 1,
    state,
    scope,
    compactedAtRound: 7,
    source: {
      transcriptDigest: "digest-1",
      sourceMessageCount: 12,
      sourceBytes: 1_200,
      sourceTokensEstimate: 300,
    },
    task: {
      rootGoal: "Compare sources.",
      planState: [],
      openQuestions: [],
      nextActions: [],
    },
    summary: {
      narrative: state === "prepared" ? "" : "Early sources compared.",
      decisions: [],
      evidence: [],
      errorsAndFixes: [],
    },
    workingSet: emptyContextCheckpointWorkingSet(),
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

async function createStore() {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "turnkeyai-context-checkpoint-"),
  );
  return {
    rootDir,
    store: new FileContextCheckpointStore({ rootDir }),
  };
}

test("context checkpoint store persists monotonic phases and activates an atomic pointer", async () => {
  const { rootDir, store } = await createStore();
  await store.put(record("prepared"));
  await store.put(record("summarized", { updatedAt: 110 }));
  await store.put(record("persisted", { updatedAt: 120 }));

  assert.equal(await store.getActive(scope), null);
  const activated = await store.activate({
    scope,
    checkpointId: "checkpoint-1",
    expectedActiveCheckpointId: null,
    activatedAt: 130,
  });

  assert.equal(activated.state, "activated");
  assert.equal((await store.getActive(scope))?.checkpointId, "checkpoint-1");
  const pointerPath = path.join(
    rootDir,
    "active",
    `${encodeURIComponent(contextCheckpointScopeKey(scope))}.json`,
  );
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
    checkpointId: string;
  };
  assert.equal(pointer.checkpointId, "checkpoint-1");
});

test("context checkpoint active pointer compare-and-set rejects stale activation", async () => {
  const { store } = await createStore();
  await store.put(record("persisted"));
  await store.activate({
    scope,
    checkpointId: "checkpoint-1",
    expectedActiveCheckpointId: null,
    activatedAt: 120,
  });
  await store.put(record("persisted", {
    checkpointId: "checkpoint-2",
    version: 2,
    source: {
      ...record("persisted").source,
      transcriptDigest: "digest-2",
      previousCheckpointId: "checkpoint-1",
    },
  }));

  await assert.rejects(
    store.activate({
      scope,
      checkpointId: "checkpoint-2",
      expectedActiveCheckpointId: null,
      activatedAt: 140,
    }),
    /active pointer conflict/,
  );
  assert.equal((await store.getActive(scope))?.checkpointId, "checkpoint-1");
});

test("context checkpoint store refuses activation before persistence", async () => {
  const { store } = await createStore();
  await store.put(record("summarized"));

  await assert.rejects(
    store.activate({
      scope,
      checkpointId: "checkpoint-1",
      activatedAt: 120,
    }),
    /not persisted/,
  );
});

test("context checkpoint store rejects phase regression and identity mutation", async () => {
  const { store } = await createStore();
  await store.put(record("persisted"));

  await assert.rejects(store.put(record("summarized")), /cannot regress/);
  await assert.rejects(
    store.put(record("persisted", {
      source: {
        ...record("persisted").source,
        transcriptDigest: "changed",
      },
    })),
    /identity changed/,
  );
});

test("context checkpoint store lists only the requested scope newest first", async () => {
  const { store } = await createStore();
  await store.put(record("persisted"));
  await store.put(record("persisted", {
    checkpointId: "checkpoint-2",
    version: 2,
    source: {
      ...record("persisted").source,
      transcriptDigest: "digest-2",
      previousCheckpointId: "checkpoint-1",
    },
  }));
  await store.put(record("persisted", {
    checkpointId: "foreign",
    scope: { ...scope, roleId: "other-role" },
  }));

  const records = await store.listByScope(scope);
  assert.deepEqual(
    records.map((item) => item.checkpointId),
    ["checkpoint-2", "checkpoint-1"],
  );
});
