import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type {
  FlowConsoleReport,
  FlowLedger,
  GovernanceConsoleReport,
  OperatorAttentionReport,
  OperatorSummaryReport,
  PermissionCacheRecord,
  RuntimeChain,
  RuntimeChainEvent,
  RuntimeProgressEvent,
  RuntimeChainSpan,
  RuntimeChainStatus,
  RuntimeSummaryReport,
  RecoveryConsoleReport,
  ReplayConsoleReport,
  ReplayIncidentBundle,
  RecoveryRun,
  RecoveryRunProgress,
  RecoveryRunTimelineEntry,
  TeamEvent,
  ThreadSessionMemoryRecord,
} from "@turnkeyai/core-types/team";
import {
  buildFlowConsoleReport,
  buildGovernanceConsoleReport,
} from "@turnkeyai/qc-runtime/operator-inspection";

const baseUrl = process.env.TURNKEYAI_DAEMON_URL ?? "http://127.0.0.1:4100";

const rl = readline.createInterface({ input, output });
let currentThreadId: string | null = null;

printBanner();

while (true) {
  const prompt = currentThreadId ? `turnkeyai:${currentThreadId}> ` : "turnkeyai> ";
  let line: string;
  try {
    line = (await rl.question(prompt)).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") {
      break;
    }
    throw error;
  }

  if (!line) {
    continue;
  }

  const [command, ...rest] = line.split(" ");
  const args = rest.join(" ").trim();

  try {
    if (command === "exit" || command === "quit") {
      break;
    }

    if (command === "help") {
      printHelp();
      continue;
    }

    if (command === "bootstrap") {
      const variant = args || "analyst";
      const thread = await postJson("/threads/bootstrap-demo", { variant });
      currentThreadId = thread.threadId;
      printJson(thread);
      continue;
    }

    if (command === "threads") {
      printJson(await getJson("/threads"));
      continue;
    }

    if (command === "models") {
      printJson(await getJson("/models"));
      continue;
    }

    if (command === "current") {
      printJson({ currentThreadId });
      continue;
    }

    if (command === "use") {
      if (!args) {
        console.log("usage: use <threadId>");
        continue;
      }
      currentThreadId = args;
      console.log(`current thread set to ${currentThreadId}`);
      continue;
    }

    if (command === "send") {
      if (!currentThreadId) {
        console.log("no active thread; run `bootstrap` or `use <threadId>` first");
        continue;
      }
      if (!args) {
        console.log("usage: send <message>");
        continue;
      }
      printJson(await postJson("/messages", { threadId: currentThreadId, content: args }));
      continue;
    }

    if (command === "messages") {
      if (!currentThreadId) {
        console.log("no active thread; run `bootstrap` or `use <threadId>` first");
        continue;
      }
      printJson(await getJson(`/messages?threadId=${encodeURIComponent(currentThreadId)}`));
      continue;
    }

    if (command === "session-memory") {
      if (!currentThreadId) {
        console.log("no active thread; run `bootstrap` or `use <threadId>` first");
        continue;
      }
      printSessionMemory(
        (await getJson(`/context/session-memory?threadId=${encodeURIComponent(currentThreadId)}`)) as ThreadSessionMemoryRecord
      );
      continue;
    }

    if (command === "flows") {
      if (!currentThreadId) {
        console.log("no active thread; run `bootstrap` or `use <threadId>` first");
        continue;
      }
      const limit = Number(args || "50");
      const params = new URLSearchParams({ threadId: currentThreadId });
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(limit));
      }
      printFlows((await getJson(`/flows?${params.toString()}`)) as FlowLedger[]);
      continue;
    }

    if (command === "flows-summary") {
      if (!currentThreadId) {
        console.log("no active thread; run `bootstrap` or `use <threadId>` first");
        continue;
      }
      printFlowConsole(
        (await getJson(`/flows-summary?threadId=${encodeURIComponent(currentThreadId)}`)) as FlowConsoleReport
      );
      continue;
    }

    if (command === "runtime-chains") {
      if (!currentThreadId) {
        console.log("no active thread; run `bootstrap` or `use <threadId>` first");
        continue;
      }
      const limit = Number(args || "20");
      const params = new URLSearchParams({ threadId: currentThreadId });
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(limit));
      }
      printRuntimeChains(
        (await getJson(`/runtime-chains?${params.toString()}`)) as Array<{
          chain: RuntimeChain | null;
          status: RuntimeChainStatus;
        }>
      );
      continue;
    }

    if (command === "runtime-active") {
      const limit = Number(args || "20");
      const params = new URLSearchParams();
      if (currentThreadId) {
        params.set("threadId", currentThreadId);
      }
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(limit));
      }
      printRuntimeChains(
        (await getJson(`/runtime-active?${params.toString()}`)) as Array<{
          chain: RuntimeChain | null;
          status: RuntimeChainStatus;
        }>
      );
      continue;
    }

    if (command === "runtime-summary") {
      const limit = Number(args || "10");
      const params = new URLSearchParams();
      if (currentThreadId) {
        params.set("threadId", currentThreadId);
      }
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(limit));
      }
      printRuntimeSummary((await getJson(`/runtime-summary?${params.toString()}`)) as RuntimeSummaryReport);
      continue;
    }

    if (command === "runtime-waiting") {
      const limit = Number(args || "20");
      const params = new URLSearchParams();
      if (currentThreadId) {
        params.set("threadId", currentThreadId);
      }
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(limit));
      }
      printRuntimeChains(
        (await getJson(`/runtime-waiting?${params.toString()}`)) as Array<{
          chain: RuntimeChain | null;
          status: RuntimeChainStatus;
        }>
      );
      continue;
    }

    if (command === "runtime-failed") {
      const limit = Number(args || "20");
      const params = new URLSearchParams();
      if (currentThreadId) {
        params.set("threadId", currentThreadId);
      }
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(limit));
      }
      printRuntimeChains(
        (await getJson(`/runtime-failed?${params.toString()}`)) as Array<{
          chain: RuntimeChain | null;
          status: RuntimeChainStatus;
        }>
      );
      continue;
    }

    if (command === "runtime-stale") {
      const limit = Number(args || "20");
      const params = new URLSearchParams();
      if (currentThreadId) {
        params.set("threadId", currentThreadId);
      }
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(limit));
      }
      printRuntimeChains(
        (await getJson(`/runtime-stale?${params.toString()}`)) as Array<{
          chain: RuntimeChain | null;
          status: RuntimeChainStatus;
        }>
      );
      continue;
    }

    if (command === "runtime-attention") {
      const limit = Number(args || "20");
      const params = new URLSearchParams();
      if (currentThreadId) {
        params.set("threadId", currentThreadId);
      }
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(limit));
      }
      printRuntimeSummaryEntries(
        "Runtime Attention",
        (await getJson(`/runtime-attention?${params.toString()}`)) as RuntimeSummaryReport["attentionChains"]
      );
      continue;
    }

    if (command === "runtime-chain") {
      if (!args) {
        console.log("usage: runtime-chain <chainId>");
        continue;
      }
      printRuntimeChain(
        (await getJson(`/runtime-chains/${encodeURIComponent(args)}`)) as {
          chain: RuntimeChain;
          status: RuntimeChainStatus | null;
          spans: RuntimeChainSpan[];
          events: RuntimeChainEvent[];
        }
      );
      continue;
    }

    if (command === "runtime-chain-events") {
      const [chainId, limitArg] = args.split(" ").filter(Boolean);
      if (!chainId) {
        console.log("usage: runtime-chain-events <chainId> [limit]");
        continue;
      }
      const params = new URLSearchParams();
      const limit = Number(limitArg || "20");
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(limit));
      }
      printRuntimeChainEvents(
        (await getJson(
          `/runtime-chains/${encodeURIComponent(chainId)}/events?${params.toString()}`
        )) as RuntimeChainEvent[]
      );
      continue;
    }

    if (command === "runtime-progress") {
      if (!currentThreadId) {
        console.log("no active thread; run `bootstrap` or `use <threadId>` first");
        continue;
      }
      const limit = Number(args || "20");
      const params = new URLSearchParams({ threadId: currentThreadId });
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(limit));
      }
      printRuntimeProgress(
        (await getJson(`/runtime-progress?${params.toString()}`)) as RuntimeProgressEvent[]
      );
      continue;
    }

    if (command === "runtime-chain-progress") {
      const [chainId, limitArg] = args.split(" ").filter(Boolean);
      if (!chainId) {
        console.log("usage: runtime-chain-progress <chainId> [limit]");
        continue;
      }
      const params = new URLSearchParams();
      const limit = Number(limitArg || "20");
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(limit));
      }
      printRuntimeProgress(
        (await getJson(`/runtime-chains/${encodeURIComponent(chainId)}/progress?${params.toString()}`)) as RuntimeProgressEvent[]
      );
      continue;
    }

    if (command === "operator-summary") {
      if (!currentThreadId) {
        console.log("no active thread; run `bootstrap` or `use <threadId>` first");
        continue;
      }
      const limit = Number(args || "20");
      const params = new URLSearchParams({
        threadId: currentThreadId,
      });
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(limit));
      }
      printOperatorSummary(
        (await getJson(`/operator-summary?${params.toString()}`)) as OperatorSummaryReport
      );
      continue;
    }

    if (command === "operator-attention") {
      await handleOperatorAttentionCommand(args);
      continue;
    }

    if (command === "runs") {
      if (!currentThreadId) {
        console.log("no active thread; run `bootstrap` or `use <threadId>` first");
        continue;
      }
      printJson(await getJson(`/runs?threadId=${encodeURIComponent(currentThreadId)}`));
      continue;
    }

    if (command === "inspect") {
      if (!currentThreadId) {
        console.log("no active thread; run `bootstrap` or `use <threadId>` first");
        continue;
      }
      await printInspect(currentThreadId);
      continue;
    }

    if (command === "browser") {
      await handleBrowserCommand(args);
      continue;
    }

    if (command === "governance") {
      await handleGovernanceCommand(args);
      continue;
    }

    if (command === "recovery-summary") {
      await handleRecoverySummaryCommand(args);
      continue;
    }

    if (command === "replays") {
      await handleReplaysCommand(args);
      continue;
    }

    if (command === "replay-summary") {
      await handleReplaySummaryCommand(args);
      continue;
    }

    if (command === "replay-console") {
      await handleReplayConsoleCommand(args);
      continue;
    }

    if (command === "regression-cases") {
      await handleRegressionCasesCommand();
      continue;
    }

    if (command === "regression-run") {
      await handleRegressionRunCommand(args);
      continue;
    }

    if (command === "failure-cases") {
      await handleFailureCasesCommand();
      continue;
    }

    if (command === "failure-run") {
      await handleFailureRunCommand(args);
      continue;
    }

    if (command === "replay-incidents") {
      await handleReplayIncidentsCommand(args);
      continue;
    }

    if (command === "replay-group") {
      await handleReplayGroupCommand(args);
      continue;
    }

    if (command === "replay-bundle") {
      await handleReplayBundleCommand(args);
      continue;
    }

    if (command === "replay-recoveries") {
      await handleReplayRecoveriesCommand(args);
      continue;
    }

    if (command === "replay-recovery") {
      await handleReplayRecoveryCommand(args);
      continue;
    }

    if (command === "replay-dispatch") {
      await handleReplayDispatchCommand(args);
      continue;
    }

    if (command === "recovery-runs") {
      await handleRecoveryRunsCommand(args);
      continue;
    }

    if (command === "recovery-run") {
      await handleRecoveryRunCommand(args);
      continue;
    }

    if (command === "recovery-timeline") {
      await handleRecoveryTimelineCommand(args);
      continue;
    }

    if (command === "recovery-approve") {
      await handleRecoveryActionCommand("approve", args);
      continue;
    }

    if (command === "recovery-reject") {
      await handleRecoveryActionCommand("reject", args);
      continue;
    }

    if (command === "recovery-retry") {
      await handleRecoveryActionCommand("retry", args);
      continue;
    }

    if (command === "recovery-fallback") {
      await handleRecoveryActionCommand("fallback", args);
      continue;
    }

    if (command === "recovery-resume") {
      await handleRecoveryActionCommand("resume", args);
      continue;
    }

    if (command === "replay") {
      if (!args) {
        console.log("usage: replay <replayId>");
        continue;
      }
      printJson(await getJson(`/replays/${encodeURIComponent(args)}`));
      continue;
    }

    if (command === "demo") {
      const { variant, content } = parseDemoArgs(args);
      const thread = await postJson("/threads/bootstrap-demo", { variant });
      const threadId = String(thread.threadId);
      currentThreadId = threadId;
      await postJson("/messages", { threadId, content });
      await sleep(150);
      await printInspect(threadId);
      continue;
    }

    if (command === "health") {
      printJson(await getJson("/health"));
      continue;
    }

    console.log(`unknown command: ${command}`);
    printHelp();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

await rl.close();

function printBanner(): void {
  console.log("Runtime Lab TUI");
  console.log(`daemon: ${baseUrl}`);
  printHelp();
}

function printHelp(): void {
  console.log("commands:");
  console.log("  help                 show commands");
  console.log("  health               check daemon health");
  console.log("  bootstrap [variant]  create a demo team thread");
  console.log("  threads              list threads");
  console.log("  models               list configured models");
  console.log("  current              show current thread");
  console.log("  use <threadId>       set current thread");
  console.log("  demo [variant] [msg] create a demo thread and run one flow");
  console.log("  send <message>       send a message to current thread");
  console.log("  messages             show current thread messages");
  console.log("  flows                show current thread flows");
  console.log("  flows-summary        show current thread flow summary");
  console.log("  runtime-chains [limit]              show runtime chains for current thread");
  console.log("  runtime-active [limit]              show active runtime chains for current thread or all");
  console.log("  runtime-summary [limit]             show runtime chain summary for current thread or all");
  console.log("  runtime-waiting [limit]             show waiting runtime chains for current thread or all");
  console.log("  runtime-failed [limit]              show failed runtime chains for current thread or all");
  console.log("  runtime-stale [limit]               show stale runtime chains for current thread or all");
  console.log("  runtime-attention [limit]           show runtime chains that need operator attention");
  console.log("  runtime-chain <chainId>             show one runtime chain with spans and events");
  console.log("  runtime-chain-events <chainId> [limit]  show recent runtime chain events");
  console.log("  runtime-progress [limit]            show recent runtime progress for current thread");
  console.log("  runtime-chain-progress <chainId> [limit] show recent runtime progress for one chain");
  console.log("  operator-summary     show current thread operator summary");
  console.log("  operator-attention [limit]           show cross-surface attention items for current thread");
  console.log("  runs                 show current thread role runs");
  console.log("  session-memory       show current thread session memory");
  console.log("  inspect              show messages, flows, and runs together");
  console.log("  browser sessions [threadId]           list browser sessions");
  console.log("  browser targets <sessionId>           list targets for a browser session");
  console.log("  browser history <sessionId> [limit]   show browser session history");
  console.log("  browser spawn <url>                   spawn a browser session and open one URL");
  console.log("  browser send <sessionId> <url>        send one open+snapshot command to a session");
  console.log("  browser resume <sessionId>            resume one browser session on its current target");
  console.log("  browser open <sessionId> <url>        open a new target in a browser session");
  console.log("  browser activate <sessionId> <id>     activate a target");
  console.log("  browser close-target <sessionId> <id> close a target");
  console.log("  browser evict [minutes]               evict idle browser sessions");
  console.log("  governance permissions                show permission cache for current thread");
  console.log("  governance summary [limit]            show governance summary for current thread");
  console.log("  recovery-summary [limit]              show recovery summary for current thread");
  console.log("  governance audits [limit]             show recent audit events");
  console.log("  governance workers [limit]            show worker governance events");
  console.log("  replays [layer] [limit]               list replay records for current thread");
  console.log("  replay-summary [limit]                show grouped replay summary for current thread");
  console.log("  replay-console [limit]                show replay console snapshot for current thread");
  console.log("  regression-cases                      list built-in bounded regression cases");
  console.log("  regression-run [caseId ...]           run bounded regression harness");
  console.log("  failure-cases                         list built-in failure injection scenarios");
  console.log("  failure-run [scenarioId ...]          run failure injection harness");
  console.log("  replay-incidents [limit] [action]     show replay incidents for current thread");
  console.log("  replay-group <groupId>                show one grouped replay task with its related replays");
  console.log("  replay-bundle <groupId>               show one incident bundle with timeline");
  console.log("  replay-recoveries [limit] [action]    show recovery plans for current thread");
  console.log("  replay-recovery <groupId>             show one recovery plan");
  console.log("  replay-dispatch <groupId>             dispatch one auto-recoverable replay group");
  console.log("  recovery-runs [limit]                 show materialized recovery runs for current thread");
  console.log("  recovery-run <recoveryRunId>          show one recovery run");
  console.log("  recovery-timeline <recoveryRunId>     show merged event/replay timeline for one recovery run");
  console.log("  recovery-approve <recoveryRunId>      approve and continue one waiting recovery run");
  console.log("  recovery-reject <recoveryRunId>       reject and abort one recovery run");
  console.log("  recovery-retry <recoveryRunId>        retry one recovery run on the same layer");
  console.log("  recovery-fallback <recoveryRunId>     run one recovery through fallback transport");
  console.log("  recovery-resume <recoveryRunId>       resume one recovery run");
  console.log("  replay <replayId>                     show one replay record");
  console.log("  exit                 quit");
}

async function getJson(pathname: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${pathname}`);
  return parseJsonResponse(response);
}

async function postJson(pathname: string, body: unknown): Promise<any> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return parseJsonResponse(response);
}

async function parseJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(json.error ?? `${response.status} ${response.statusText}`);
  }

  return json;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printFlows(flows: FlowLedger[]): void {
  const report = buildFlowConsoleReport(flows);
  const attentionByKey = new Map(
    report.attentionGroups.map((group) => [`${group.flowId}:${group.groupId}`, group] as const)
  );
  printFlowConsole(report);
  console.log(`Flows: ${flows.length}`);
  for (const flow of flows) {
    console.log(
      `- ${flow.flowId}  status=${flow.status}  mode=${flow.mode}  hop=${flow.hopCount}/${flow.maxHops}`
    );
    if (flow.activeRoleIds.length > 0) {
      console.log(`  active roles: ${flow.activeRoleIds.join(", ")}`);
    }
    if (flow.nextExpectedRoleId) {
      console.log(`  next expected: ${flow.nextExpectedRoleId}`);
    }
    if (flow.shardGroups?.length) {
      console.log(`  shard groups: ${flow.shardGroups.length}`);
      for (const group of flow.shardGroups) {
        const expected = group.expectedRoleIds.length;
        const completed = group.completedRoleIds.length;
        const failed = group.failedRoleIds.length;
        const cancelled = group.cancelledRoleIds.length;
        console.log(
          `    - ${group.groupId}  status=${group.status}  completed=${completed}/${expected}  failed=${failed}  cancelled=${cancelled}`
        );
        const attention = attentionByKey.get(`${flow.flowId}:${group.groupId}`);
        if (attention) {
          console.log(
            `      issues: case=${attention.caseState} | ${attention.reasons.map(describeAttentionReason).join(" | ")}`
          );
        }
        if (group.shardResults.length > 0) {
          for (const result of group.shardResults) {
            console.log(`      ${result.roleId} [${result.status}] ${result.summary}`);
          }
        }
      }
    }
  }
}

function printRuntimeChains(
  entries: Array<{ chain: RuntimeChain | null; status: RuntimeChainStatus }>
): void {
  console.log(`Runtime Chains: ${entries.length}`);
  for (const entry of entries) {
    const root = entry.chain
      ? `${entry.chain.rootKind}:${entry.chain.rootId}`
      : entry.status.chainId;
    const parts = [
      entry.status.chainId,
      `root=${root}`,
      `phase=${entry.status.phase}`,
      `state=${entry.status.canonicalState ?? "open"}`,
    ];
    if (entry.status.activeSubjectKind && entry.status.activeSubjectId) {
      parts.push(`active=${entry.status.activeSubjectKind}:${entry.status.activeSubjectId}`);
    }
    if (entry.status.waitingReason) {
      parts.push(`waiting=${entry.status.waitingReason}`);
    }
    if (entry.status.caseKey) {
      parts.push(`case=${entry.status.caseKey}`);
    }
    if (entry.status.caseState) {
      parts.push(`case-state=${entry.status.caseState}`);
    }
    if (entry.status.stale) {
      parts.push(`stale=${entry.status.staleReason ?? "true"}`);
    }
    if (entry.status.attention) {
      parts.push("attention=true");
    }
    console.log(`- ${parts.join("  ")}`);
    console.log(`  ${entry.status.latestSummary}`);
    if (entry.status.headline) {
      console.log(`  headline: ${entry.status.headline}`);
    }
    if (entry.status.nextStep) {
      console.log(`  next: ${entry.status.nextStep}`);
    }
    if (entry.status.currentWaitingPoint) {
      console.log(`  waiting point: ${entry.status.currentWaitingPoint}`);
    }
    if (entry.status.latestChildSpanId) {
      console.log(`  latest child: ${entry.status.latestChildSpanId}`);
    }
    if (entry.status.lastCompletedSpanId) {
      console.log(`  last completed: ${entry.status.lastCompletedSpanId}`);
    }
  }
}

function printRuntimeSummary(report: RuntimeSummaryReport): void {
  console.log("Runtime Summary");
  console.log(`  total chains: ${report.totalChains}`);
  console.log(`  active: ${report.activeCount}`);
  console.log(`  waiting: ${report.waitingCount}`);
  console.log(`  failed: ${report.failedCount}`);
  console.log(`  resolved: ${report.resolvedCount}`);
  console.log(`  stale: ${report.staleCount}`);
  console.log(`  attention: ${report.attentionCount}`);
  if (Object.keys(report.stateCounts).length > 0) {
    console.log(`  state mix: ${formatCountMap(report.stateCounts)}`);
  }
  if (Object.keys(report.continuityCounts).length > 0) {
    console.log(`  continuity mix: ${formatCountMap(report.continuityCounts)}`);
  }
  if (Object.keys(report.caseStateCounts).length > 0) {
    console.log(`  case-state mix: ${formatCountMap(report.caseStateCounts)}`);
  }
  printRuntimeSummaryEntries("  attention chains:", report.attentionChains);
  printRuntimeSummaryEntries("  active chains:", report.activeChains);
  printRuntimeSummaryEntries("  waiting chains:", report.waitingChains);
  printRuntimeSummaryEntries("  stale chains:", report.staleChains);
  printRuntimeSummaryEntries("  failed chains:", report.failedChains);
  printRuntimeSummaryEntries("  recently resolved:", report.recentlyResolved);
}

function printRuntimeSummaryEntries(
  title: string,
  entries: RuntimeSummaryReport["attentionChains"]
): void {
  if (entries.length === 0) {
    return;
  }
  console.log(title);
  for (const entry of entries) {
    const parts = [`${entry.chainId}`, `root=${entry.rootKind}:${entry.rootId}`];
    if (entry.canonicalState) {
      parts.push(`state=${entry.canonicalState}`);
    }
    if (entry.continuityState) {
      parts.push(`continuity=${entry.continuityState}`);
    }
    if (entry.caseKey) {
      parts.push(`case=${entry.caseKey}`);
    }
    if (entry.caseState) {
      parts.push(`case-state=${entry.caseState}`);
    }
    if (entry.stale) {
      parts.push(`stale=${entry.staleReason ?? "true"}`);
    }
    if (entry.lastFailedSpanId) {
      parts.push(`last-failed=${entry.lastFailedSpanId}`);
    }
    if (entry.lastCompletedSpanId) {
      parts.push(`last-completed=${entry.lastCompletedSpanId}`);
    }
    console.log(`    - ${parts.join("  ")}`);
    if (entry.currentWaitingPoint) {
      console.log(`      waiting: ${entry.currentWaitingPoint}`);
    } else if (entry.waitingReason) {
      console.log(`      waiting: ${entry.waitingReason}`);
    }
    if (entry.headline) {
      console.log(`      ${entry.headline}`);
    }
    if (entry.nextStep) {
      console.log(`      next: ${entry.nextStep}`);
    }
    if (entry.latestChildSpanId) {
      console.log(`      latest child: ${entry.latestChildSpanId}`);
    }
  }
}

function printRuntimeChain(input: {
  chain: RuntimeChain;
  status: RuntimeChainStatus | null;
  spans: RuntimeChainSpan[];
  events: RuntimeChainEvent[];
}): void {
  console.log("Runtime Chain");
  console.log(`  chain: ${input.chain.chainId}`);
  console.log(`  thread: ${input.chain.threadId}`);
  console.log(`  root: ${input.chain.rootKind}:${input.chain.rootId}`);
  if (input.status) {
    console.log(`  phase: ${input.status.phase}`);
    if (input.status.canonicalState) {
      console.log(`  state: ${input.status.canonicalState}`);
    }
    if (input.status.continuityState) {
      console.log(`  continuity: ${input.status.continuityState}`);
    }
    if (input.status.continuityReason) {
      console.log(`  continuity reason: ${input.status.continuityReason}`);
    }
    if (input.status.responseTimeoutAt) {
      console.log(`  response timeout: ${new Date(input.status.responseTimeoutAt).toISOString()}`);
    }
    if (input.status.reconnectWindowUntil) {
      console.log(`  reconnect until: ${new Date(input.status.reconnectWindowUntil).toISOString()}`);
    }
    if (input.status.closeKind) {
      console.log(`  close kind: ${input.status.closeKind}`);
    }
    console.log(`  summary: ${input.status.latestSummary}`);
    if (input.status.waitingReason) {
      console.log(`  waiting: ${input.status.waitingReason}`);
    }
    if (input.status.currentWaitingPoint) {
      console.log(`  waiting point: ${input.status.currentWaitingPoint}`);
    }
    if (input.status.stale) {
      console.log(`  stale: ${input.status.staleReason ?? "true"}`);
    }
    if (input.status.activeSubjectKind && input.status.activeSubjectId) {
      console.log(`  active: ${input.status.activeSubjectKind}:${input.status.activeSubjectId}`);
    }
    if (input.status.caseKey) {
      console.log(`  case: ${input.status.caseKey}`);
    }
    if (input.status.caseState) {
      console.log(`  case state: ${input.status.caseState}`);
    }
    if (input.status.headline) {
      console.log(`  headline: ${input.status.headline}`);
    }
    if (input.status.nextStep) {
      console.log(`  next: ${input.status.nextStep}`);
    }
    if (input.status.latestChildSpanId) {
      console.log(`  latest child: ${input.status.latestChildSpanId}`);
    }
    if (input.status.lastCompletedSpanId) {
      console.log(`  last completed: ${input.status.lastCompletedSpanId}`);
    }
    if (input.status.lastFailedSpanId) {
      console.log(`  last failed: ${input.status.lastFailedSpanId}`);
    }
  }
  if (input.spans.length > 0) {
    console.log("  spans:");
    for (const span of input.spans) {
      const parts = [`${span.subjectKind}:${span.subjectId}`];
      if (span.parentSpanId) {
        parts.push(`parent=${span.parentSpanId}`);
      }
      if (span.roleId) {
        parts.push(`role=${span.roleId}`);
      }
      if (span.workerType) {
        parts.push(`worker=${span.workerType}`);
      }
      console.log(`    - ${span.spanId}  ${parts.join("  ")}`);
    }
  }
  if (input.events.length > 0) {
    console.log("  recent events:");
    printRuntimeChainEvents(input.events);
  }
}

function printRuntimeChainEvents(events: RuntimeChainEvent[]): void {
  for (const event of events) {
    const parts = [
      `${event.subjectKind}:${event.subjectId}`,
      `phase=${event.phase}`,
    ];
    if (event.statusReason) {
      parts.push(`reason=${event.statusReason}`);
    }
    console.log(`- ${parts.join("  ")}`);
    console.log(`  ${event.summary}`);
  }
}

function printRuntimeProgress(events: RuntimeProgressEvent[]): void {
  for (const event of events) {
    const parts = [`${event.subjectKind}:${event.subjectId}`, `phase=${event.phase}`];
    if (event.progressKind) {
      parts.push(`kind=${event.progressKind}`);
    }
    if (event.chainId) {
      parts.push(`chain=${event.chainId}`);
    }
    if (event.continuityState) {
      parts.push(`continuity=${event.continuityState}`);
    }
    if (event.heartbeatSource) {
      parts.push(`heartbeat=${event.heartbeatSource}`);
    }
    if (event.workerType) {
      parts.push(`worker=${event.workerType}`);
    }
    if (event.responseTimeoutAt) {
      parts.push(`timeout=${new Date(event.responseTimeoutAt).toISOString()}`);
    }
    if (event.reconnectWindowUntil) {
      parts.push(`reconnect-until=${new Date(event.reconnectWindowUntil).toISOString()}`);
    }
    if (event.closeKind) {
      parts.push(`close=${event.closeKind}`);
    }
    if (event.statusReason) {
      parts.push(`reason=${event.statusReason}`);
    }
    console.log(`- ${parts.join("  ")}`);
    console.log(`  ${event.summary}`);
  }
}

function printSessionMemory(record: ThreadSessionMemoryRecord): void {
  console.log("Session Memory");
  console.log(`  thread: ${record.threadId}`);
  console.log(`  updated: ${new Date(record.updatedAt).toISOString()}`);
  if (record.memoryVersion != null) {
    console.log(`  version: ${record.memoryVersion}`);
  }
  if (record.sourceMessageCount != null) {
    console.log(`  source messages: ${record.sourceMessageCount}`);
  }
  if (record.sectionFingerprint) {
    console.log(`  fingerprint: ${record.sectionFingerprint}`);
  }
  printStringSection("  active tasks", record.activeTasks);
  printStringSection("  open questions", record.openQuestions);
  printStringSection("  recent decisions", record.recentDecisions);
  printStringSection("  constraints", record.constraints);
  printStringSection("  continuity notes", record.continuityNotes);
  printStringSection("  latest journal", record.latestJournalEntries);
}

function printStringSection(label: string, values: string[]): void {
  console.log(`${label}:`);
  if (values.length === 0) {
    console.log("    -");
    return;
  }
  for (const value of values) {
    console.log(`    - ${value}`);
  }
}

function printFlowConsole(report: FlowConsoleReport): void {
  console.log("Flow Console");
  console.log(`  total flows: ${report.totalFlows}`);
  console.log(`  attention groups: ${report.attentionCount}`);
  if (Object.keys(report.statusCounts).length > 0) {
    console.log(
      `  status mix: ${Object.entries(report.statusCounts)
        .map(([status, count]) => `${status}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.attentionStateCounts).length > 0) {
    console.log(`  case state: ${formatCountMap(report.attentionStateCounts)}`);
  }
  console.log(`  active roles: ${report.activeRoleCount}`);
  console.log(`  shard groups: ${report.totalShardGroups}`);
  if (Object.keys(report.shardStatusCounts).length > 0) {
    console.log(
      `  shard status: ${Object.entries(report.shardStatusCounts)
        .map(([status, count]) => `${status}=${count}`)
        .join(", ")}`
    );
  }
  const flags = [
    `missing=${report.groupsWithMissingRoles}`,
    `retries=${report.groupsWithRetries}`,
    `duplicates=${report.groupsWithDuplicates}`,
    `conflicts=${report.groupsWithConflicts}`,
  ];
  console.log(`  shard issues: ${flags.join("  ")}`);
  if (report.attentionGroups.length > 0) {
    console.log("  attention groups:");
    for (const group of report.attentionGroups) {
      console.log(
        `    - ${group.flowId}/${group.groupId}  status=${describeFlowShardStatus(group.status)}  case=${group.caseState}  reasons=${group.reasons.map(describeAttentionReason).join(", ")}`
      );
    }
  }
}

function formatCountMap(counts: Record<string, number | undefined>): string {
  const entries = Object.entries(counts).filter(([, count]) => typeof count === "number" && count > 0);
  if (entries.length === 0) {
    return "-";
  }
  return entries.map(([key, count]) => `${key}=${count}`).join(", ");
}

function printOperatorSummary(report: OperatorSummaryReport): void {
  console.log("Operator Summary");
  console.log(`  total attention: ${report.totalAttentionCount}`);
  console.log(
    `  flow=${report.flow.attentionCount}  replay=${report.replay.attentionCount}  governance=${report.governance.attentionCount}  recovery=${report.recovery.attentionCount}`
  );
  if (report.attentionOverview) {
    console.log(
      `  unique cases=${report.attentionOverview.uniqueCaseCount}  case-state=${formatCountMap(report.attentionOverview.caseStateCounts)}  severity=${formatCountMap(report.attentionOverview.severityCounts)}  lifecycle=${formatCountMap(report.attentionOverview.lifecycleCounts)}`
    );
    if (report.attentionOverview.activeCases && report.attentionOverview.activeCases.length > 0) {
      console.log("  active cases:");
      for (const entry of report.attentionOverview.activeCases) {
        const parts = [
          `${entry.caseKey}`,
          `state=${entry.caseState}`,
          `severity=${entry.severity}`,
          `lifecycle=${entry.lifecycle}`,
        ];
        if (entry.gate) {
          parts.push(`gate=${entry.gate}`);
        }
        if (entry.action) {
          parts.push(`action=${entry.action}`);
        }
        if (entry.browserContinuityState) {
          parts.push(`browser=${entry.browserContinuityState}`);
        }
        if (entry.reasonPreview) {
          parts.push(`reason=${entry.reasonPreview}`);
        }
        console.log(`    - ${parts.join("  ")}`);
        console.log(`      ${entry.headline}`);
        console.log(`      next=${entry.nextStep}  latest=${entry.latestUpdate}`);
      }
    }
    if (report.attentionOverview.resolvedRecentCases && report.attentionOverview.resolvedRecentCases.length > 0) {
      console.log("  resolved recent:");
      for (const entry of report.attentionOverview.resolvedRecentCases) {
        const parts = [`${entry.caseKey}`, `state=${entry.caseState}`, `source=${entry.source}`];
        if (entry.gate) {
          parts.push(`gate=${entry.gate}`);
        }
        if (entry.action) {
          parts.push(`action=${entry.action}`);
        }
        if (entry.browserContinuityState) {
          parts.push(`browser=${entry.browserContinuityState}`);
        }
        if (entry.reasonPreview) {
          parts.push(`reason=${entry.reasonPreview}`);
        }
        console.log(`    - ${parts.join("  ")}`);
        console.log(`      ${entry.headline}`);
        console.log(`      next=${entry.nextStep}  latest=${entry.latestUpdate}`);
      }
    }
  }
  console.log("");
  printFlowConsole(report.flow);
  console.log("");
  printReplayConsole(report.replay);
  console.log("");
  printGovernanceConsole(report.governance);
  console.log("");
  printRecoveryConsole(report.recovery);
}

function printOperatorAttention(report: OperatorAttentionReport): void {
  console.log("Operator Attention");
  console.log(`  total items: ${report.totalItems}`);
  console.log(`  returned items: ${report.returnedItems}`);
  console.log(`  unique cases: ${report.uniqueCaseCount}`);
  console.log(`  returned cases: ${report.returnedCases}`);
  if (Object.keys(report.sourceCounts).length > 0) {
    console.log(
      `  sources: ${Object.entries(report.sourceCounts)
        .map(([source, count]) => `${source}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.caseStateCounts).length > 0) {
    console.log(`  case-state: ${formatCountMap(report.caseStateCounts)}`);
  }
  if (Object.keys(report.severityCounts).length > 0) {
    console.log(
      `  severity: ${Object.entries(report.severityCounts)
        .map(([severity, count]) => `${severity}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.lifecycleCounts).length > 0) {
    console.log(
      `  lifecycle: ${Object.entries(report.lifecycleCounts)
        .map(([lifecycle, count]) => `${lifecycle}=${count}`)
        .join(", ")}`
    );
  }
  if (report.cases.length > 0) {
    console.log("  case summaries:");
    for (const entry of report.cases) {
      const parts = [
        entry.caseKey,
        `state=${entry.caseState}`,
        `severity=${entry.severity}`,
        `lifecycle=${entry.lifecycle}`,
        `items=${entry.itemCount}`,
        `sources=${entry.sources.join("+")}`,
      ];
      if (entry.gate) {
        parts.push(`gate=${entry.gate}`);
      }
      if (entry.action) {
        parts.push(`action=${entry.action}`);
      }
      if (entry.browserContinuityState) {
        parts.push(`browser=${entry.browserContinuityState}`);
      }
      console.log(`    - ${parts.join("  ")}`);
      console.log(`      ${entry.headline}`);
      console.log(`      next=${entry.nextStep}  latest=${entry.latestUpdate}`);
      if (entry.reasons && entry.reasons.length > 0) {
        console.log(`      reasons: ${entry.reasons.join(" | ")}`);
      }
    }
  }
  for (const item of report.items) {
    const parts = [
      item.source,
      item.key,
      `case=${item.caseKey}`,
      `severity=${item.severity}`,
      `lifecycle=${item.lifecycle}`,
      `status=${item.status}`,
    ];
    if (item.gate) {
      parts.push(`gate=${item.gate}`);
    }
    if (item.action) {
      parts.push(`action=${item.action}`);
    }
    if (item.browserContinuityState) {
      parts.push(`browser=${item.browserContinuityState}`);
    }
    console.log(`  - ${parts.join("  ")}`);
    console.log(`    headline: ${item.headline}`);
    console.log(`    ${item.summary}`);
    if (item.reasons && item.reasons.length > 0) {
      console.log(`    reasons: ${item.reasons.join(" | ")}`);
    }
  }
}

async function printInspect(threadId: string): Promise<void> {
  const [messages, flows, runs] = await Promise.all([
    getJson(`/messages?threadId=${encodeURIComponent(threadId)}`),
    getJson(`/flows?threadId=${encodeURIComponent(threadId)}`),
    getJson(`/runs?threadId=${encodeURIComponent(threadId)}`),
  ]);

  printJson({
    threadId,
    messages,
    flows,
    runs,
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDemoArgs(raw: string): { variant: string; content: string } {
  if (!raw) {
    return {
      variant: "analyst",
      content: "Please start the demo flow",
    };
  }

  const [first, ...rest] = raw.split(" ");
  const knownVariants = new Set(["analyst", "coder", "finance", "operator"]);

  if (first && knownVariants.has(first)) {
    const defaultContent =
      first === "operator"
        ? 'Please use browser to open https://example.com, click "Learn more", scroll down, extract the page title via console, and report back.'
        : "Please start the demo flow";
    return {
      variant: first,
      content: rest.join(" ").trim() || defaultContent,
    };
  }

  return {
    variant: "analyst",
    content: raw,
  };
}

async function handleBrowserCommand(raw: string): Promise<void> {
  const [subcommand, ...rest] = raw.split(" ").filter(Boolean);
  if (!subcommand) {
    console.log("usage: browser <sessions|targets|history|spawn|send|resume|open|activate|close-target|evict> ...");
    return;
  }

  if (subcommand === "sessions") {
    const threadId = rest[0] || currentThreadId;
    if (!threadId) {
      console.log("usage: browser sessions [threadId]");
      return;
    }
    printJson(await getJson(`/browser-sessions?threadId=${encodeURIComponent(threadId)}`));
    return;
  }

  if (subcommand === "targets") {
    const sessionId = rest[0];
    if (!sessionId) {
      console.log("usage: browser targets <sessionId>");
      return;
    }
    if (!currentThreadId) {
      console.log("no active thread; run `bootstrap` or `use <threadId>` first");
      return;
    }
    printJson(await getJson(`/browser-sessions/${encodeURIComponent(sessionId)}/targets?threadId=${encodeURIComponent(currentThreadId)}`));
    return;
  }

  if (subcommand === "history") {
    const [sessionId, limit] = rest;
    if (!sessionId) {
      console.log("usage: browser history <sessionId> [limit]");
      return;
    }
    if (!currentThreadId) {
      console.log("no active thread; run `bootstrap` or `use <threadId>` first");
      return;
    }
    const params = new URLSearchParams({ threadId: currentThreadId });
    if (limit) {
      params.set("limit", limit);
    }
    printJson(await getJson(`/browser-sessions/${encodeURIComponent(sessionId)}/history?${params.toString()}`));
    return;
  }

  if (subcommand === "spawn") {
    const url = rest.join(" ").trim();
    if (!url) {
      console.log("usage: browser spawn <url>");
      return;
    }
    if (!currentThreadId) {
      console.log("no active thread; run `bootstrap` or `use <threadId>` first");
      return;
    }
    printJson(await postJson("/browser-sessions/spawn", { threadId: currentThreadId ?? undefined, url }));
    return;
  }

  if (subcommand === "send") {
    const [sessionId, ...urlParts] = rest;
    const url = urlParts.join(" ").trim();
    if (!sessionId || !url) {
      console.log("usage: browser send <sessionId> <url>");
      return;
    }
    if (!currentThreadId) {
      console.log("no active thread; run `bootstrap` or `use <threadId>` first");
      return;
    }
    printJson(
      await postJson(`/browser-sessions/${encodeURIComponent(sessionId)}/send`, {
        threadId: currentThreadId ?? undefined,
        url,
      })
    );
    return;
  }

  if (subcommand === "resume") {
    const sessionId = rest[0];
    if (!sessionId) {
      console.log("usage: browser resume <sessionId>");
      return;
    }
    if (!currentThreadId) {
      console.log("no active thread; run `bootstrap` or `use <threadId>` first");
      return;
    }
    printJson(
      await postJson(`/browser-sessions/${encodeURIComponent(sessionId)}/resume`, {
        threadId: currentThreadId ?? undefined,
      })
    );
    return;
  }

  if (subcommand === "open") {
    const [sessionId, ...urlParts] = rest;
    const url = urlParts.join(" ").trim();
    if (!sessionId || !url) {
      console.log("usage: browser open <sessionId> <url>");
      return;
    }
    if (!currentThreadId) {
      console.log("no active thread; run `bootstrap` or `use <threadId>` first");
      return;
    }
    printJson(
      await postJson(`/browser-sessions/${encodeURIComponent(sessionId)}/targets`, {
        threadId: currentThreadId,
        url,
      })
    );
    return;
  }

  if (subcommand === "activate") {
    const [sessionId, targetId] = rest;
    if (!sessionId || !targetId) {
      console.log("usage: browser activate <sessionId> <targetId>");
      return;
    }
    if (!currentThreadId) {
      console.log("no active thread; run `bootstrap` or `use <threadId>` first");
      return;
    }
    printJson(
      await postJson(`/browser-sessions/${encodeURIComponent(sessionId)}/activate-target`, {
        threadId: currentThreadId,
        targetId,
      })
    );
    return;
  }

  if (subcommand === "close-target") {
    const [sessionId, targetId] = rest;
    if (!sessionId || !targetId) {
      console.log("usage: browser close-target <sessionId> <targetId>");
      return;
    }
    if (!currentThreadId) {
      console.log("no active thread; run `bootstrap` or `use <threadId>` first");
      return;
    }
    printJson(
      await postJson(`/browser-sessions/${encodeURIComponent(sessionId)}/close-target`, {
        threadId: currentThreadId,
        targetId,
      })
    );
    return;
  }

  if (subcommand === "evict") {
    const minutes = Number(rest[0] ?? "30");
    const idleMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 30 * 60 * 1000;
    printJson(
      await postJson("/browser-sessions/evict-idle", {
        idleMs,
      })
    );
    return;
  }

  console.log(`unknown browser subcommand: ${subcommand}`);
}

async function handleGovernanceCommand(raw: string): Promise<void> {
  const [subcommand, ...rest] = raw.split(" ").filter(Boolean);
  if (!subcommand) {
    console.log("usage: governance <summary|permissions|audits|workers> ...");
    return;
  }

  if (subcommand === "summary") {
    if (!currentThreadId) {
      console.log("no active thread; run `bootstrap` or `use <threadId>` first");
      return;
    }
    const limit = Number(rest[0] ?? "20");
    const params = new URLSearchParams({
      threadId: currentThreadId,
    });
    if (Number.isFinite(limit) && limit > 0) {
      params.set("limit", String(limit));
    }
    printGovernanceConsole(
      (await getJson(`/governance/summary?${params.toString()}`)) as GovernanceConsoleReport
    );
    return;
  }

  if (subcommand === "permissions") {
    if (!currentThreadId) {
      console.log("no active thread; run `bootstrap` or `use <threadId>` first");
      return;
    }
    printPermissionCache(
      (await getJson(`/governance/permissions?threadId=${encodeURIComponent(currentThreadId)}`)) as PermissionCacheRecord[]
    );
    return;
  }

  if (subcommand === "audits" || subcommand === "workers") {
    const limit = Number(rest[0] ?? "50");
    const basePath = subcommand === "audits" ? "/governance/audits" : "/governance/workers";
    const params = new URLSearchParams();
    if (currentThreadId) {
      params.set("threadId", currentThreadId);
    }
    if (Number.isFinite(limit) && limit > 0) {
      params.set("limit", String(limit));
    }
    printGovernanceAuditEvents(
      (await getJson(`${basePath}?${params.toString()}`)) as TeamEvent[],
      subcommand === "workers"
    );
    return;
  }

  console.log(`unknown governance subcommand: ${subcommand}`);
}

async function handleReplaysCommand(raw: string): Promise<void> {
  const [first, second] = raw.split(" ").filter(Boolean);
  const params = new URLSearchParams();
  if (currentThreadId) {
    params.set("threadId", currentThreadId);
  }
  if (first && ["scheduled", "role", "worker", "browser"].includes(first)) {
    params.set("layer", first);
  }
  const limit = Number((first && !["scheduled", "role", "worker", "browser"].includes(first) ? first : second) ?? "50");
  if (Number.isFinite(limit) && limit > 0) {
    params.set("limit", String(limit));
  }
  printJson(await getJson(`/replays?${params.toString()}`));
}

async function handleReplaySummaryCommand(raw: string): Promise<void> {
  const params = new URLSearchParams();
  if (currentThreadId) {
    params.set("threadId", currentThreadId);
  }
  const limit = Number(raw.trim() || "100");
  if (Number.isFinite(limit) && limit > 0) {
    params.set("limit", String(limit));
  }
  printJson(await getJson(`/replay-summary?${params.toString()}`));
}

async function handleRecoverySummaryCommand(raw: string): Promise<void> {
  if (!currentThreadId) {
    console.log("no active thread; run `bootstrap` or `use <threadId>` first");
    return;
  }
  const params = new URLSearchParams({
    threadId: currentThreadId,
  });
  const limit = Number(raw.trim() || "20");
  if (Number.isFinite(limit) && limit > 0) {
    params.set("limit", String(limit));
  }
  printRecoveryConsole((await getJson(`/recovery-summary?${params.toString()}`)) as RecoveryConsoleReport);
}

async function handleOperatorAttentionCommand(raw: string): Promise<void> {
  if (!currentThreadId) {
    console.log("no active thread; run `bootstrap` or `use <threadId>` first");
    return;
  }
  const params = new URLSearchParams({
    threadId: currentThreadId,
  });
  const limit = Number(raw.trim() || "20");
  if (Number.isFinite(limit) && limit > 0) {
    params.set("limit", String(limit));
  }
  printOperatorAttention(
    (await getJson(`/operator-attention?${params.toString()}`)) as OperatorAttentionReport
  );
}

async function handleReplayConsoleCommand(raw: string): Promise<void> {
  const params = new URLSearchParams();
  if (currentThreadId) {
    params.set("threadId", currentThreadId);
  }
  const limit = Number(raw.trim() || "20");
  if (Number.isFinite(limit) && limit > 0) {
    params.set("limit", String(limit));
  }
  printReplayConsole((await getJson(`/replay-console?${params.toString()}`)) as ReplayConsoleReport);
}

async function handleRegressionCasesCommand(): Promise<void> {
  printRegressionCaseList(
    (await getJson("/regression-cases")) as Array<{
      caseId: string;
      title: string;
      area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime";
      summary: string;
    }>
  );
}

async function handleRegressionRunCommand(raw: string): Promise<void> {
  const caseIds = raw.split(/\s+/).filter(Boolean);
  printRegressionRunResult(
    (await postJson("/regression-cases/run", caseIds.length > 0 ? { caseIds } : {})) as {
      totalCases: number;
      passedCases: number;
      failedCases: number;
      results: Array<{
        caseId: string;
        title: string;
        area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime";
        summary: string;
        status: "passed" | "failed";
        details: string[];
      }>;
    }
  );
}

async function handleFailureCasesCommand(): Promise<void> {
  printFailureInjectionScenarioList(
    (await getJson("/failure-cases")) as {
      totalScenarios: number;
      scenarios: Array<{
        scenarioId: string;
        area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime";
        title: string;
        summary: string;
        caseIds: string[];
      }>;
    }
  );
}

async function handleFailureRunCommand(raw: string): Promise<void> {
  const scenarioIds = raw.split(/\s+/).filter(Boolean);
  printFailureInjectionRunResult(
    (await postJson("/failure-cases/run", scenarioIds.length > 0 ? { scenarioIds } : {})) as {
      totalScenarios: number;
      passedScenarios: number;
      failedScenarios: number;
      totalCases: number;
      passedCases: number;
      failedCases: number;
      scenarios: Array<{
        scenarioId: string;
        area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime";
        title: string;
        summary: string;
        caseIds: string[];
        status: "passed" | "failed";
        totalCases: number;
        passedCases: number;
        failedCases: number;
        caseResults: Array<{
          caseId: string;
          title: string;
          area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime";
          summary: string;
          status: "passed" | "failed";
          details: string[];
        }>;
      }>;
    }
  );
}

async function handleReplayIncidentsCommand(raw: string): Promise<void> {
  const [first, second] = raw.split(" ").filter(Boolean);
  const params = new URLSearchParams();
  if (currentThreadId) {
    params.set("threadId", currentThreadId);
  }
  const limit = Number(first || "100");
  if (Number.isFinite(limit) && limit > 0) {
    params.set("limit", String(limit));
  }
  if (second) {
    params.set("action", second);
  }
  printJson(await getJson(`/replay-incidents?${params.toString()}`));
}

async function handleReplayGroupCommand(raw: string): Promise<void> {
  const groupId = raw.trim();
  if (!groupId) {
    console.log("usage: replay-group <groupId>");
    return;
  }
  if (!currentThreadId) {
    console.log("no active thread; run `bootstrap` or `use <threadId>` first");
    return;
  }
  printJson(
    await getJson(
      `/replay-groups/${encodeURIComponent(groupId)}?threadId=${encodeURIComponent(currentThreadId)}`
    )
  );
}

async function handleReplayBundleCommand(raw: string): Promise<void> {
  const groupId = raw.trim();
  if (!groupId) {
    console.log("usage: replay-bundle <groupId>");
    return;
  }
  if (!currentThreadId) {
    console.log("no active thread; run `bootstrap` or `use <threadId>` first");
    return;
  }
  const bundle = (await getJson(
    `/replay-bundles/${encodeURIComponent(groupId)}?threadId=${encodeURIComponent(currentThreadId)}`
  )) as ReplayIncidentBundle;
  printReplayBundle(bundle);
}

async function handleReplayRecoveriesCommand(raw: string): Promise<void> {
  const [first, second] = raw.split(" ").filter(Boolean);
  const params = new URLSearchParams();
  if (currentThreadId) {
    params.set("threadId", currentThreadId);
  }
  const limit = Number(first || "100");
  if (Number.isFinite(limit) && limit > 0) {
    params.set("limit", String(limit));
  }
  if (second) {
    params.set("action", second);
  }
  printJson(await getJson(`/replay-recoveries?${params.toString()}`));
}

async function handleReplayRecoveryCommand(raw: string): Promise<void> {
  const groupId = raw.trim();
  if (!groupId) {
    console.log("usage: replay-recovery <groupId>");
    return;
  }
  if (!currentThreadId) {
    console.log("no active thread; run `bootstrap` or `use <threadId>` first");
    return;
  }
  printJson(
    await getJson(
      `/replay-recoveries/${encodeURIComponent(groupId)}?threadId=${encodeURIComponent(currentThreadId)}`
    )
  );
}

async function handleReplayDispatchCommand(raw: string): Promise<void> {
  const groupId = raw.trim();
  if (!groupId) {
    console.log("usage: replay-dispatch <groupId>");
    return;
  }
  if (!currentThreadId) {
    console.log("no active thread; run `bootstrap` or `use <threadId>` first");
    return;
  }
  printJson(
    await postJson(
      `/replay-recoveries/${encodeURIComponent(groupId)}/dispatch?threadId=${encodeURIComponent(currentThreadId)}`,
      {}
    )
  );
}

async function handleRecoveryRunsCommand(raw: string): Promise<void> {
  if (!currentThreadId) {
    console.log("no active thread; run `bootstrap` or `use <threadId>` first");
    return;
  }
  const limit = Number(raw.trim() || "100");
  const params = new URLSearchParams();
  params.set("threadId", currentThreadId);
  if (Number.isFinite(limit) && limit > 0) {
    params.set("limit", String(limit));
  }
  const payload = (await getJson(`/recovery-runs?${params.toString()}`)) as {
    totalRuns: number;
    runs: RecoveryRun[];
  };
  printRecoveryRunList(payload);
}

async function handleRecoveryRunCommand(raw: string): Promise<void> {
  const recoveryRunId = raw.trim();
  if (!recoveryRunId) {
    console.log("usage: recovery-run <recoveryRunId>");
    return;
  }
  if (!currentThreadId) {
    console.log("no active thread; run `bootstrap` or `use <threadId>` first");
    return;
  }
  const run = (await getJson(
    `/recovery-runs/${encodeURIComponent(recoveryRunId)}?threadId=${encodeURIComponent(currentThreadId)}`
  )) as RecoveryRun;
  printRecoveryRun(run);
}

async function handleRecoveryTimelineCommand(raw: string): Promise<void> {
  const recoveryRunId = raw.trim();
  if (!recoveryRunId) {
    console.log("usage: recovery-timeline <recoveryRunId>");
    return;
  }
  if (!currentThreadId) {
    console.log("no active thread; run `bootstrap` or `use <threadId>` first");
    return;
  }
  const payload = (await getJson(
    `/recovery-runs/${encodeURIComponent(recoveryRunId)}/timeline?threadId=${encodeURIComponent(currentThreadId)}`
  )) as {
    recoveryRun: RecoveryRun;
    progress: RecoveryRunProgress;
    totalEntries: number;
    timeline: RecoveryRunTimelineEntry[];
  };
  printRecoveryTimeline(payload);
}

async function handleRecoveryActionCommand(
  action: "approve" | "reject" | "retry" | "fallback" | "resume",
  raw: string
): Promise<void> {
  const recoveryRunId = raw.trim();
  if (!recoveryRunId) {
    console.log(`usage: recovery-${action} <recoveryRunId>`);
    return;
  }
  if (!currentThreadId) {
    console.log("no active thread; run `bootstrap` or `use <threadId>` first");
    return;
  }
  printJson(
    await postJson(
      `/recovery-runs/${encodeURIComponent(recoveryRunId)}/${action}?threadId=${encodeURIComponent(currentThreadId)}`,
      {}
    )
  );
}

function printRecoveryRunList(payload: { totalRuns: number; runs: RecoveryRun[] }): void {
  console.log(`Recovery runs: ${payload.totalRuns}`);
  for (const run of payload.runs) {
    const parts = [
      run.recoveryRunId,
      `status=${run.status}`,
      `gate=${describeRecoveryGate(run)}`,
      `next=${describeRecoveryAction(run.nextAction)}`,
      `attempts=${run.attempts.length}`,
    ];
    if (run.currentAttemptId) {
      parts.push(`active=${run.currentAttemptId}`);
    }
    if (run.browserSession) {
      parts.push(`browser=${run.browserSession.resumeMode}`);
    }
    console.log(
      `- ${parts.join("  ")}`
    );
    console.log(`  ${run.latestSummary}`);
  }
}

function printRecoveryConsole(report: RecoveryConsoleReport): void {
  console.log("Recovery Console");
  console.log(`  total runs: ${report.totalRuns}`);
  console.log(`  attention runs: ${report.attentionCount}`);
  if (Object.keys(report.statusCounts).length > 0) {
    console.log(
      `  statuses: ${Object.entries(report.statusCounts)
        .map(([status, count]) => `${status}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.phaseCounts).length > 0) {
    console.log(
      `  phases: ${Object.entries(report.phaseCounts)
        .map(([phase, count]) => `${phase}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.nextActionCounts).length > 0) {
    console.log(
      `  next actions: ${Object.entries(report.nextActionCounts)
        .map(([action, count]) => `${action}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.browserResumeCounts).length > 0) {
    console.log(
      `  browser resume: ${Object.entries(report.browserResumeCounts)
        .map(([mode, count]) => `${mode}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.browserOutcomeCounts).length > 0) {
    console.log(
      `  browser outcomes: ${Object.entries(report.browserOutcomeCounts)
        .map(([outcome, count]) => `${outcome}=${count}`)
        .join(", ")}`
    );
  }
  if (report.latestRuns.length > 0) {
    console.log("  latest runs:");
    for (const run of report.latestRuns) {
      const parts = [
        run.recoveryRunId,
        `status=${run.status}`,
        `gate=${describeRecoveryGate(run)}`,
        `next=${describeRecoveryAction(run.nextAction)}`,
      ];
      if (run.currentAttemptId) {
        parts.push(`active=${run.currentAttemptId}`);
      }
      if (run.browserSession?.resumeMode) {
        parts.push(`browser=${run.browserSession.resumeMode}`);
      }
      console.log(`    - ${parts.join("  ")}`);
      console.log(`      ${run.latestSummary}`);
    }
  }
}

function printRecoveryRun(run: RecoveryRun): void {
  console.log(`Recovery Run: ${run.recoveryRunId}`);
  console.log(`  thread: ${run.threadId}`);
  console.log(`  source group: ${run.sourceGroupId}`);
  console.log(`  status: ${run.status}`);
  console.log(`  next action: ${describeRecoveryAction(run.nextAction)}`);
  console.log(`  latest status: ${run.latestStatus}`);
  console.log(`  current gate: ${describeRecoveryGate(run)}`);
  console.log(`  summary: ${run.latestSummary}`);
  if (run.waitingReason) {
    console.log(`  waiting reason: ${run.waitingReason}`);
  }
  if (run.targetLayer || run.targetWorker) {
    console.log(`  target: ${run.targetLayer ?? "main"}${run.targetWorker ? `/${run.targetWorker}` : ""}`);
  }
  if (run.currentAttemptId) {
    console.log(`  current attempt: ${run.currentAttemptId}`);
  }
  if (run.browserSession) {
    console.log(
      `  browser: session=${run.browserSession.sessionId} target=${run.browserSession.targetId ?? "-"} resume=${run.browserSession.resumeMode}`
    );
  }
  console.log(`  attempts: ${run.attempts.length}`);
  for (const attempt of run.attempts) {
    const parts = [
      `${attempt.attemptId}`,
      `action=${describeAttemptAction(attempt.action)}`,
      `status=${attempt.status}`,
      `next=${describeRecoveryAction(attempt.nextAction)}`,
    ];
    if (attempt.dispatchedTaskId) {
      parts.push(`task=${attempt.dispatchedTaskId}`);
    }
    if (attempt.resultingGroupId) {
      parts.push(`result=${attempt.resultingGroupId}`);
    }
    if (attempt.supersededByAttemptId) {
      parts.push(`supersededBy=${attempt.supersededByAttemptId}`);
    }
    if (attempt.triggeredByAttemptId) {
      parts.push(`from=${attempt.triggeredByAttemptId}`);
    }
    if (attempt.transitionReason) {
      parts.push(`reason=${attempt.transitionReason}`);
    }
    console.log(`    - ${parts.join("  ")}`);
    console.log(`      ${attempt.summary}`);
    if (attempt.browserOutcome || attempt.browserOutcomeSummary) {
      console.log(
        `      browser outcome: ${attempt.browserOutcome ?? "unknown"}${attempt.browserOutcomeSummary ? ` | ${attempt.browserOutcomeSummary}` : ""}`
      );
    }
  }
}

function printRecoveryTimeline(payload: {
  recoveryRun: RecoveryRun;
  progress: RecoveryRunProgress;
  totalEntries: number;
  timeline: RecoveryRunTimelineEntry[];
}): void {
  console.log(`Recovery Timeline: ${payload.recoveryRun.recoveryRunId}`);
  console.log(
    `  phase=${payload.progress.phase}  active=${payload.progress.activeAttemptId ?? "-"}  settled=${payload.progress.settledAttempts}/${payload.progress.totalAttempts}`
  );
  console.log(`  phase summary: ${payload.progress.phaseSummary}`);
  if (payload.progress.lastSettledAttemptId) {
    console.log(
      `  last settled: ${payload.progress.lastSettledAttemptId} (${payload.progress.lastSettledStatus ?? "unknown"})`
    );
  }
  console.log(`  timeline entries: ${payload.totalEntries}`);
  for (const entry of payload.timeline) {
    const parts = [
      new Date(entry.recordedAt).toISOString(),
      entry.source,
      entry.kind,
    ];
    if (entry.status) {
      parts.push(`status=${entry.status}`);
    }
    if (entry.action) {
      parts.push(`action=${entry.action}`);
    }
    if (entry.attemptId) {
      parts.push(`attempt=${entry.attemptId}`);
    }
    if (entry.triggeredByAttemptId) {
      parts.push(`from=${entry.triggeredByAttemptId}`);
    }
    if (entry.transitionReason) {
      parts.push(`reason=${entry.transitionReason}`);
    }
    if (entry.layer) {
      parts.push(`layer=${entry.layer}`);
    }
    if (entry.groupId) {
      parts.push(`group=${entry.groupId}`);
    }
    if (entry.browserOutcome) {
      parts.push(`browser=${entry.browserOutcome}`);
    }
    console.log(`    - ${parts.join("  ")}`);
    console.log(`      ${entry.summary}`);
    if (entry.failure) {
      console.log(`      failure: ${entry.failure.category} | ${entry.failure.message}`);
    }
  }
}

function printReplayBundle(bundle: ReplayIncidentBundle): void {
  console.log(`Incident Bundle: ${bundle.group.groupId}`);
  console.log(`  latest status: ${bundle.group.latestStatus}`);
  if (bundle.caseState) {
    console.log(`  case state: ${bundle.caseState}`);
  }
  if (bundle.caseHeadline) {
    console.log(`  case headline: ${bundle.caseHeadline}`);
  }
  console.log(`  layers: ${bundle.group.layersSeen.join(", ")}`);
  console.log(`  follow-up required: ${bundle.group.requiresFollowUp ? "yes" : "no"}`);
  if (bundle.browserContinuity) {
    console.log(
      `  browser continuity: ${bundle.browserContinuity.state}  ${bundle.browserContinuity.summary}`
    );
    if (bundle.browserContinuity.sessionId || bundle.browserContinuity.targetId) {
      console.log(
        `  browser session: ${bundle.browserContinuity.sessionId ?? "-"}  target=${bundle.browserContinuity.targetId ?? "-"}`
      );
    }
    if (bundle.browserContinuity.resumeMode || bundle.browserContinuity.targetResolution) {
      console.log(
        `  browser resume: ${bundle.browserContinuity.resumeMode ?? "-"}  target resolution=${bundle.browserContinuity.targetResolution ?? "-"}`
      );
    }
  }
  if (bundle.recovery) {
    console.log(`  recovery next action: ${describeRecoveryAction(bundle.recovery.nextAction)}`);
  }
  if (bundle.recoveryWorkflow) {
    console.log(
      `  workflow: ${bundle.recoveryWorkflow.status}  next=${describeRecoveryAction(bundle.recoveryWorkflow.nextAction)}  summary=${bundle.recoveryWorkflow.summary}`
    );
  }
  if (bundle.recoveryProgress) {
    console.log(
      `  recovery phase: ${bundle.recoveryProgress.phase}  active=${bundle.recoveryProgress.activeAttemptId ?? "-"}  settled=${bundle.recoveryProgress.settledAttempts}/${bundle.recoveryProgress.totalAttempts}`
    );
    console.log(`  recovery gate: ${bundle.recoveryProgress.phaseSummary}`);
  }
  console.log(`  related replays: ${bundle.relatedReplays.length}`);
  console.log(`  dispatches: ${bundle.recoveryDispatches.length}`);
  console.log(`  follow-up groups: ${bundle.followUpGroups.length}`);
  if (bundle.followUpSummary) {
    console.log(
      `  follow-up summary: total=${bundle.followUpSummary.totalGroups}  open=${bundle.followUpSummary.openGroups}  closed=${bundle.followUpSummary.closedGroups}`
    );
    if (Object.keys(bundle.followUpSummary.actionCounts).length > 0) {
      console.log(
        `  follow-up actions: ${Object.entries(bundle.followUpSummary.actionCounts)
          .map(
            ([action, count]) =>
              `${describeRecoveryHintAction(
                action as "resume" | "retry" | "fallback" | "request_approval" | "abort" | "inspect" | "none"
              )}=${count}`
          )
          .join(", ")}`
      );
    }
    if (Object.keys(bundle.followUpSummary.browserContinuityCounts).length > 0) {
      console.log(
        `  follow-up browser: ${Object.entries(bundle.followUpSummary.browserContinuityCounts)
          .map(([state, count]) => `${state}=${count}`)
          .join(", ")}`
      );
    }
  }
  if (bundle.followUpGroups.length > 0) {
    console.log("  follow-up status:");
    for (const group of bundle.followUpGroups.slice(0, 5)) {
      const parts = [
        group.groupId,
        `status=${group.latestStatus}`,
        `action=${describeRecoveryHintAction(group.recoveryHint.action)}`,
      ];
      if (group.browserContinuity) {
        parts.push(`browser=${group.browserContinuity.state}`);
      }
      console.log(`    - ${parts.join("  ")}`);
      if (group.latestFailure) {
        console.log(`      ${group.latestFailure.category}: ${group.latestFailure.message}`);
      } else if (group.browserContinuity) {
        console.log(`      ${group.browserContinuity.summary}`);
      }
    }
  }
  if (bundle.recoveryTimeline?.length) {
    console.log(`  recovery timeline entries: ${bundle.recoveryTimeline.length}`);
  }
}

function printReplayConsole(payload: ReplayConsoleReport): void {
  console.log("Replay Console");
  console.log(`  total replays: ${payload.totalReplays}`);
  console.log(`  total groups: ${payload.totalGroups}`);
  console.log(`  open incidents: ${payload.openIncidents}`);
  console.log(`  recovered groups: ${payload.recoveredGroups}`);
  console.log(`  attention items: ${payload.attentionCount}`);
  if (Object.keys(payload.actionCounts).length > 0) {
    console.log(
      `  action mix: ${Object.entries(payload.actionCounts)
        .map(([action, count]) => `${action}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(payload.browserContinuityCounts).length > 0) {
    console.log(
      `  browser continuity: ${Object.entries(payload.browserContinuityCounts)
        .map(([state, count]) => `${state}=${count}`)
        .join(", ")}`
    );
  }
  if (payload.latestIncidents.length > 0) {
    console.log("  latest incidents:");
    for (const incident of payload.latestIncidents) {
      console.log(
        `    - ${incident.groupId}  next=${describeRecoveryAction(incident.nextAction)}  latest=${incident.latestStatus}  auto=${incident.autoDispatchReady ? "yes" : "no"}`
      );
      console.log(`      ${incident.recoveryHint.reason}`);
    }
  }
  if (payload.latestGroups.length > 0) {
    console.log("  latest groups:");
    for (const group of payload.latestGroups) {
      const parts = [
        group.groupId,
        `status=${group.latestStatus}`,
        `layers=${group.layersSeen.join("/")}`,
      ];
      if (group.browserContinuity) {
        parts.push(`browser=${group.browserContinuity.state}`);
      }
      console.log(`    - ${parts.join("  ")}`);
      if (group.browserContinuity) {
        console.log(`      ${group.browserContinuity.summary}`);
      } else if (group.latestFailure) {
        console.log(`      ${group.latestFailure.message}`);
      }
    }
  }
}

function printRegressionCaseList(
  cases: Array<{
    caseId: string;
    title: string;
    area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime";
    summary: string;
  }>
): void {
  console.log(`Regression cases: ${cases.length}`);
  for (const item of cases) {
    console.log(`- ${item.caseId}  area=${item.area}  title=${item.title}`);
    console.log(`  ${item.summary}`);
  }
}

function printRegressionRunResult(payload: {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  results: Array<{
    caseId: string;
    title: string;
    area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime";
    summary: string;
    status: "passed" | "failed";
    details: string[];
  }>;
}): void {
  console.log(
    `Regression run: total=${payload.totalCases}  passed=${payload.passedCases}  failed=${payload.failedCases}`
  );
  for (const result of payload.results) {
    console.log(`- ${result.caseId}  area=${result.area}  status=${result.status}`);
    console.log(`  ${result.title}`);
    if (result.details.length > 0) {
      console.log(`  details: ${result.details.join(" | ")}`);
    }
  }
}

function printFailureInjectionScenarioList(payload: {
  totalScenarios: number;
  scenarios: Array<{
    scenarioId: string;
    area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime";
    title: string;
    summary: string;
    caseIds: string[];
  }>;
}): void {
  console.log(`Failure Injection Scenarios: ${payload.totalScenarios}`);
  for (const scenario of payload.scenarios) {
    console.log(`- ${scenario.scenarioId}  [${scenario.area}] ${scenario.title}`);
    console.log(`  ${scenario.summary}`);
    console.log(`  cases: ${scenario.caseIds.join(", ")}`);
  }
}

function printFailureInjectionRunResult(payload: {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  scenarios: Array<{
    scenarioId: string;
    area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime";
    title: string;
    summary: string;
    caseIds: string[];
    status: "passed" | "failed";
    totalCases: number;
    passedCases: number;
    failedCases: number;
    caseResults: Array<{
      caseId: string;
      title: string;
      area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime";
      summary: string;
      status: "passed" | "failed";
      details: string[];
    }>;
  }>;
}): void {
  console.log(
    `Failure Injection: ${payload.passedScenarios}/${payload.totalScenarios} scenarios passed, ${payload.passedCases}/${payload.totalCases} cases passed`
  );
  for (const scenario of payload.scenarios) {
    console.log(
      `- ${scenario.scenarioId}  [${scenario.area}] ${scenario.title}  status=${scenario.status}  cases=${scenario.passedCases}/${scenario.totalCases}`
    );
    console.log(`  ${scenario.summary}`);
    if (scenario.failedCases > 0) {
      console.log(`  failed cases: ${scenario.failedCases}`);
    }
    for (const result of scenario.caseResults) {
      console.log(`    - ${result.caseId}  status=${result.status}`);
      for (const detail of result.details) {
        console.log(`      ${detail}`);
      }
    }
  }
}

function printGovernanceConsole(report: GovernanceConsoleReport): void {
  console.log("Governance Console");
  console.log(`  permission records: ${report.totalPermissionRecords}`);
  console.log(`  attention audits: ${report.attentionCount}`);
  if (Object.keys(report.permissionDecisionCounts).length > 0) {
    console.log(
      `  decisions: ${Object.entries(report.permissionDecisionCounts)
        .map(([decision, count]) => `${decision}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.requirementLevelCounts).length > 0) {
    console.log(
      `  requirement levels: ${Object.entries(report.requirementLevelCounts)
        .map(([level, count]) => `${level}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.permissionScopeCounts).length > 0) {
    console.log(
      `  scopes: ${Object.entries(report.permissionScopeCounts)
        .map(([scope, count]) => `${scope}=${count}`)
        .join(", ")}`
    );
  }
  console.log(`  audit events: ${report.totalAuditEvents}`);
  if (Object.keys(report.transportCounts).length > 0) {
    console.log(
      `  transports: ${Object.entries(report.transportCounts)
        .map(([transport, count]) => `${transport}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.trustCounts).length > 0) {
    console.log(
      `  trust: ${Object.entries(report.trustCounts)
        .map(([trust, count]) => `${trust}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.admissionCounts).length > 0) {
    console.log(
      `  admission: ${Object.entries(report.admissionCounts)
        .map(([mode, count]) => `${mode}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.recommendedActionCounts).length > 0) {
    console.log(
      `  recommended actions: ${Object.entries(report.recommendedActionCounts)
        .map(([action, count]) => `${action}=${count}`)
        .join(", ")}`
    );
  }
  if (report.latestAudits.length > 0) {
    console.log("  latest audits:");
    for (const event of report.latestAudits) {
      const payload = event.payload ?? {};
      const parts = [
        `${event.eventId}`,
        `worker=${String(payload.workerType ?? "-")}`,
        `status=${String(payload.status ?? "-")}`,
        `transport=${String(payload.transport ?? "none")}`,
        `trust=${String(payload.trustLevel ?? "-")}`,
        `admission=${String((payload.admission as { mode?: unknown } | undefined)?.mode ?? payload.admissionMode ?? "-")}`,
      ];
      console.log(`    - ${parts.join("  ")}`);
    }
  }
}

function printPermissionCache(records: PermissionCacheRecord[]): void {
  console.log(`Permission cache: ${records.length}`);
  for (const record of records) {
    const parts = [
      record.workerType,
      `decision=${record.decision}`,
      `level=${record.requirement.level}`,
      `scope=${record.requirement.scope}`,
    ];
    if (record.expiresAt) {
      parts.push(`expires=${new Date(record.expiresAt).toISOString()}`);
    }
    console.log(`- ${parts.join("  ")}`);
    console.log(`  ${record.requirement.rationale}`);
    if (record.denialReason) {
      console.log(`  denial: ${record.denialReason}`);
    }
  }
}

function printGovernanceAuditEvents(events: TeamEvent[], workersOnly: boolean): void {
  console.log(`${workersOnly ? "Worker governance events" : "Audit events"}: ${events.length}`);
  for (const event of events) {
    const payload = event.payload ?? {};
    const parts = [
      new Date(event.createdAt).toISOString(),
      `worker=${String(payload.workerType ?? "-")}`,
      `status=${String(payload.status ?? "-")}`,
      `transport=${String(payload.transport ?? "none")}`,
      `trust=${String(payload.trustLevel ?? "-")}`,
      `admission=${String((payload.admission as { mode?: unknown } | undefined)?.mode ?? payload.admissionMode ?? "-")}`,
    ];
    if (payload.permissionRequirement) {
      parts.push(`permission=${String(payload.permissionRequirement)}`);
    }
    console.log(`- ${parts.join("  ")}`);
    const failure = typeof payload.failure === "object" && payload.failure
      ? (payload.failure as { category?: unknown; message?: unknown })
      : null;
    if (failure?.category || failure?.message) {
      console.log(`  failure: ${String(failure.category ?? "unknown")} | ${String(failure.message ?? "")}`);
    }
  }
}

function describeFlowShardStatus(status: string): string {
  switch (status) {
    case "waiting_retry":
      return "attention";
    case "ready_to_merge":
      return "merge-ready";
    default:
      return status;
  }
}

function describeAttentionReason(reason: string): string {
  switch (reason) {
    case "missing":
      return "missing coverage";
    case "retry":
      return "retry pending";
    case "duplicate":
      return "duplicate shard output";
    case "conflict":
      return "conflicting shard output";
    default:
      return reason;
  }
}

function describeRecoveryAction(
  action: "auto_resume" | "retry_same_layer" | "fallback_transport" | "request_approval" | "inspect_then_resume" | "stop" | "none"
): string {
  switch (action) {
    case "auto_resume":
      return "resume";
    case "retry_same_layer":
      return "retry";
    case "fallback_transport":
      return "fallback";
    case "request_approval":
      return "request approval";
    case "inspect_then_resume":
      return "inspect then resume";
    case "stop":
      return "stop";
    case "none":
    default:
      return "none";
  }
}

function describeRecoveryHintAction(
  action: "resume" | "retry" | "fallback" | "request_approval" | "abort" | "inspect" | "none"
): string {
  switch (action) {
    case "resume":
      return "resume";
    case "retry":
      return "retry";
    case "fallback":
      return "fallback";
    case "request_approval":
      return "request approval";
    case "abort":
      return "stop";
    case "inspect":
      return "inspect";
    case "none":
    default:
      return "none";
  }
}

function describeAttemptAction(action: "dispatch" | "retry" | "fallback" | "resume" | "approve" | "reject"): string {
  switch (action) {
    case "dispatch":
      return "dispatch";
    case "retry":
      return "retry";
    case "fallback":
      return "fallback";
    case "resume":
      return "resume";
    case "approve":
      return "approve";
    case "reject":
      return "reject";
    default:
      return action;
  }
}

function describeRecoveryGate(run: RecoveryRun): string {
  switch (run.status) {
    case "waiting_approval":
      return "waiting for approval";
    case "waiting_external":
      return "waiting for external/manual follow-up";
    case "retrying":
      return "retrying same layer";
    case "fallback_running":
      return "running fallback transport";
    case "resumed":
      return "resuming existing session";
    case "running":
      return "dispatch in progress";
    case "recovered":
      return "recovered";
    case "failed":
      return "failed and awaiting next recovery action";
    case "aborted":
      return "aborted";
    case "superseded":
      return "superseded by a newer recovery attempt";
    case "planned":
    default:
      return "planned";
  }
}
