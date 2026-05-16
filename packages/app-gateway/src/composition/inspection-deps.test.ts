import test from "node:test";
import assert from "node:assert/strict";

import { createInspectionRouteDeps } from "./inspection-deps";

// PR E — pin that buildOperatorTriage uses a single snapshot load instead
// of the previous double-IIFE pattern that hit each store/runtime twice.
//
// These tests substitute the foundations + runtimeServices shapes with
// minimal fakes that count how many times each upstream method is invoked.
// The bar: ONE triage request → exactly ONE call into each of the six
// upstream reads (flowLedgerStore.listByThread,
// permissionCacheStore.listByThread, teamEventBus.listRecent,
// recoveryActionService.loadRecoveryRuntime,
// runtimeProgressStore.listByThread, runtimeQueryService.loadRuntimeSummary).

interface CallCounters {
  listByThreadFlow: number;
  listByThreadPermissions: number;
  listRecentEvents: number;
  loadRecoveryRuntime: number;
  listByThreadProgress: number;
  loadRuntimeSummary: number;
}

function buildFakes(counters: CallCounters) {
  // Each store/runtime method increments its counter and returns the smallest
  // valid shape its consumer expects. The point is call counts, not report
  // content — the operator/replay report builders are tested elsewhere.
  const flowLedgerStore = {
    async listByThread() {
      counters.listByThreadFlow += 1;
      return [];
    },
    async get() {
      return null;
    },
    async put() {},
  } as never;

  const permissionCacheStore = {
    async listByThread() {
      counters.listByThreadPermissions += 1;
      return [];
    },
  } as never;

  const teamEventBus = {
    async publish() {},
    async listRecent() {
      counters.listRecentEvents += 1;
      return [];
    },
  } as never;

  const recoveryActionService = {
    async loadRecoveryRuntime() {
      counters.loadRecoveryRuntime += 1;
      return { records: [], runs: [], report: { totalReplays: 0, totalGroups: 0, incidents: [] } };
    },
    syncRecoveryRuntime: async () => undefined,
  } as never;

  const runtimeProgressStore = {
    async listByThread() {
      counters.listByThreadProgress += 1;
      return [];
    },
    async listByChain() {
      return [];
    },
  } as never;

  const runtimeQueryService = {
    async loadRuntimeSummary() {
      counters.loadRuntimeSummary += 1;
      return {
        threadIds: [],
        chains: [],
        attentionChains: [],
        staleChains: [],
        workerSessions: [],
        startupReconcile: undefined,
      };
    },
  } as never;

  // The full foundations / runtimeServices objects have many more fields;
  // we shape just what createInspectionRouteDeps destructures for the
  // operator surface methods. Other inspection methods (listThreads,
  // resolveExternalRoute, listMessages, etc.) are not exercised by these
  // tests, so they can be no-op shaped fakes.
  const foundations = {
    teamThreadStore: { async list() { return []; } },
    teamMessageStore: { async list() { return []; } },
    teamRouteMap: { findByExternalActor: () => null },
    teamEventBus,
    flowLedgerStore,
    roleRunStore: { async listByThread() { return []; } },
    runtimeProgressStore,
    threadSessionMemoryStore: { async get() { return null; } },
    permissionCacheStore,
    replayRecorder: { async list() { return []; }, async get() { return null; } },
    capabilityDiscoveryService: { inspect: () => ({}) },
    relayGateway: null,
  } as never;

  const runtimeServices = {
    runtimeQueryService,
    recoveryActionService,
    llmGateway: null,
  } as never;

  return { foundations, runtimeServices };
}

test("buildOperatorTriage loads each store/runtime exactly once per request (snapshot reuse)", async () => {
  const counters: CallCounters = {
    listByThreadFlow: 0,
    listByThreadPermissions: 0,
    listRecentEvents: 0,
    loadRecoveryRuntime: 0,
    listByThreadProgress: 0,
    loadRuntimeSummary: 0,
  };
  const { foundations, runtimeServices } = buildFakes(counters);
  const deps = createInspectionRouteDeps({
    foundations,
    runtimeServices,
    modelCatalogPath: null,
  });

  await deps.buildOperatorTriage("thread-1", 5);

  assert.equal(counters.listByThreadFlow, 1, "flowLedgerStore.listByThread");
  assert.equal(counters.listByThreadPermissions, 1, "permissionCacheStore.listByThread");
  assert.equal(counters.listRecentEvents, 1, "teamEventBus.listRecent");
  assert.equal(counters.loadRecoveryRuntime, 1, "recoveryActionService.loadRecoveryRuntime");
  assert.equal(counters.listByThreadProgress, 1, "runtimeProgressStore.listByThread");
  assert.equal(counters.loadRuntimeSummary, 1, "runtimeQueryService.loadRuntimeSummary");
});

test("buildOperatorSummary loads each store/runtime exactly once", async () => {
  const counters: CallCounters = {
    listByThreadFlow: 0,
    listByThreadPermissions: 0,
    listRecentEvents: 0,
    loadRecoveryRuntime: 0,
    listByThreadProgress: 0,
    loadRuntimeSummary: 0,
  };
  const { foundations, runtimeServices } = buildFakes(counters);
  const deps = createInspectionRouteDeps({
    foundations,
    runtimeServices,
    modelCatalogPath: null,
  });

  await deps.buildOperatorSummary("thread-1", 5);

  assert.equal(counters.listByThreadFlow, 1);
  assert.equal(counters.listByThreadPermissions, 1);
  assert.equal(counters.listRecentEvents, 1);
  assert.equal(counters.loadRecoveryRuntime, 1);
  assert.equal(counters.listByThreadProgress, 1);
  assert.equal(counters.loadRuntimeSummary, 1);
});

test("buildOperatorAttention loads the same snapshot (incl. runtimeSummary, which it does not consume) — one read each", async () => {
  // After PR E, attention uses the shared snapshot. That means it pays one
  // extra read (runtimeSummary) compared to the pre-refactor behavior. The
  // cost is one parallel call inside Promise.all — latency unchanged — and
  // the win is summary/attention being internally consistent when both
  // derive from the same snapshot in the triage path. This test pins that
  // behavior so a future "optimize attention" change knows it must replace
  // the shared snapshot with a slim variant rather than silently dropping
  // a previously-counted call.
  const counters: CallCounters = {
    listByThreadFlow: 0,
    listByThreadPermissions: 0,
    listRecentEvents: 0,
    loadRecoveryRuntime: 0,
    listByThreadProgress: 0,
    loadRuntimeSummary: 0,
  };
  const { foundations, runtimeServices } = buildFakes(counters);
  const deps = createInspectionRouteDeps({
    foundations,
    runtimeServices,
    modelCatalogPath: null,
  });

  await deps.buildOperatorAttention("thread-1", 5);

  assert.equal(counters.listByThreadFlow, 1);
  assert.equal(counters.listByThreadPermissions, 1);
  assert.equal(counters.listRecentEvents, 1);
  assert.equal(counters.loadRecoveryRuntime, 1);
  assert.equal(counters.listByThreadProgress, 1);
  assert.equal(counters.loadRuntimeSummary, 1);
});
