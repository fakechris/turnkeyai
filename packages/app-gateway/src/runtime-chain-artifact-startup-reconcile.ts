import type {
  RuntimeChainArtifactStartupReconcileResult,
  RuntimeChainEventStore,
  RuntimeChainSpanStore,
  RuntimeChainStatusStore,
  RuntimeChainStore,
  TeamThreadStore,
} from "@turnkeyai/core-types/team";

export async function reconcileRuntimeChainArtifactsOnStartup(input: {
  teamThreadStore: TeamThreadStore;
  runtimeChainStore: RuntimeChainStore;
  runtimeChainStatusStore: RuntimeChainStatusStore;
  runtimeChainSpanStore: RuntimeChainSpanStore;
  runtimeChainEventStore: RuntimeChainEventStore;
}): Promise<RuntimeChainArtifactStartupReconcileResult> {
  const threads = await input.teamThreadStore.list();
  const threadIds = new Set(threads.map((thread) => thread.threadId));
  const chains =
    (await input.runtimeChainStore.listAll?.()) ??
    (await Promise.all(threads.map((thread) => input.runtimeChainStore.listByThread(thread.threadId)))).flat();
  const statuses =
    (await input.runtimeChainStatusStore.listAll?.()) ??
    (await Promise.all(threads.map((thread) => input.runtimeChainStatusStore.listByThread(thread.threadId)))).flat();
  const spans =
    (await input.runtimeChainSpanStore.listAll?.()) ??
    (await Promise.all(chains.map((chain) => input.runtimeChainSpanStore.listByChain(chain.chainId)))).flat();
  const events =
    (await input.runtimeChainEventStore.listAll?.()) ??
    (await Promise.all(chains.map((chain) => input.runtimeChainEventStore.listByChain(chain.chainId)))).flat();

  const chainsById = new Map(chains.map((chain) => [chain.chainId, chain]));
  const spansById = new Map(spans.map((span) => [span.spanId, span]));
  const affectedChainIds = new Set<string>();

  let orphanedStatuses = 0;
  let crossThreadStatuses = 0;
  for (const status of statuses) {
    const chain = chainsById.get(status.chainId);
    if (!chain || !threadIds.has(chain.threadId)) {
      orphanedStatuses += 1;
      affectedChainIds.add(status.chainId);
      continue;
    }
    if (status.threadId !== chain.threadId) {
      crossThreadStatuses += 1;
      affectedChainIds.add(status.chainId);
    }
  }

  let orphanedSpans = 0;
  let crossThreadSpans = 0;
  let crossFlowSpans = 0;
  for (const span of spans) {
    const chain = chainsById.get(span.chainId);
    if (!chain || !threadIds.has(chain.threadId)) {
      orphanedSpans += 1;
      affectedChainIds.add(span.chainId);
      continue;
    }
    if (span.threadId !== chain.threadId) {
      crossThreadSpans += 1;
      affectedChainIds.add(span.chainId);
    }
    const chainFlowId = chain.rootKind === "flow" ? chain.rootId : chain.flowId;
    if (span.flowId && span.flowId !== chainFlowId) {
      crossFlowSpans += 1;
      affectedChainIds.add(span.chainId);
    }
  }

  let orphanedEvents = 0;
  let missingSpanEvents = 0;
  let crossThreadEvents = 0;
  let crossChainEvents = 0;
  for (const event of events) {
    const chain = chainsById.get(event.chainId);
    if (!chain || !threadIds.has(chain.threadId)) {
      orphanedEvents += 1;
      affectedChainIds.add(event.chainId);
      continue;
    }
    let eventThreadMismatch = false;
    if (event.threadId !== chain.threadId) {
      crossThreadEvents += 1;
      affectedChainIds.add(event.chainId);
      eventThreadMismatch = true;
    }
    const span = spansById.get(event.spanId);
    if (!span) {
      missingSpanEvents += 1;
      affectedChainIds.add(event.chainId);
      continue;
    }
    if (span.chainId !== event.chainId) {
      crossChainEvents += 1;
      affectedChainIds.add(event.chainId);
      continue;
    }
    if (!eventThreadMismatch && span.threadId !== event.threadId) {
      crossThreadEvents += 1;
      affectedChainIds.add(event.chainId);
    }
  }

  return {
    orphanedStatuses,
    crossThreadStatuses,
    orphanedSpans,
    crossThreadSpans,
    crossFlowSpans,
    orphanedEvents,
    missingSpanEvents,
    crossThreadEvents,
    crossChainEvents,
    affectedChainIds: [...affectedChainIds],
  };
}
