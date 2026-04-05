import type {
  FlowLedgerStore,
  RuntimeChainStartupReconcileResult,
  RuntimeChainStore,
  TeamThreadStore,
} from "@turnkeyai/core-types/team";

export async function reconcileRuntimeChainsOnStartup(input: {
  teamThreadStore: TeamThreadStore;
  flowLedgerStore: FlowLedgerStore;
  runtimeChainStore: RuntimeChainStore;
}): Promise<RuntimeChainStartupReconcileResult> {
  const threads = await input.teamThreadStore.list();
  const threadIds = new Set(threads.map((thread) => thread.threadId));
  const flows =
    (await input.flowLedgerStore.listAll?.()) ??
    (await Promise.all(threads.map((thread) => input.flowLedgerStore.listByThread(thread.threadId)))).flat();
  const chains =
    (await input.runtimeChainStore.listAll?.()) ??
    (await Promise.all(threads.map((thread) => input.runtimeChainStore.listByThread(thread.threadId)))).flat();

  const flowsById = new Map(flows.map((flow) => [flow.flowId, flow]));
  const affectedChainIds: string[] = [];
  let orphanedThreadChains = 0;
  let missingFlowChains = 0;
  let crossThreadFlowChains = 0;

  for (const chain of chains) {
    let affected = false;
    if (!threadIds.has(chain.threadId)) {
      orphanedThreadChains += 1;
      affected = true;
    }
    const flowId = chain.rootKind === "flow" ? chain.rootId : chain.flowId;
    if (!flowId) {
      if (affected) {
        affectedChainIds.push(chain.chainId);
      }
      continue;
    }
    const flow = flowsById.get(flowId);
    if (!flow) {
      missingFlowChains += 1;
      affected = true;
    } else if (flow.threadId !== chain.threadId) {
      crossThreadFlowChains += 1;
      affected = true;
    }
    if (affected) {
      affectedChainIds.push(chain.chainId);
    }
  }

  return {
    orphanedThreadChains,
    missingFlowChains,
    crossThreadFlowChains,
    affectedChainIds: [...new Set(affectedChainIds)],
  };
}
