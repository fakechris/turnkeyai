import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type {
  FlowConsoleReport,
  FlowLedger,
  GovernanceConsoleReport,
  OperatorAttentionReport,
  OperatorSummaryReport,
  OperatorTriageReport,
  PermissionCacheRecord,
  PromptConsoleReport,
  RuntimeChain,
  RuntimeChainEvent,
  RuntimeProgressEvent,
  RuntimeChainSpan,
  RuntimeChainStatus,
  RuntimeSummaryReport,
  RecoveryConsoleReport,
  ReplayConsoleReport,
  ReplayIncidentBundle,
  ReplayTimelineEntry,
  RecoveryRun,
  RecoveryRunProgress,
  RecoveryRunTimelineEntry,
  TeamEvent,
  ThreadSessionMemoryRecord,
  ValidationOpsReport,
  WorkerSessionRecord,
} from "@turnkeyai/core-types/team";
import {
  describeRecoveryRunGate,
  listAllowedRecoveryRunActions,
} from "@turnkeyai/core-types/recovery-operator-semantics";
import {
  buildFlowConsoleReport,
  buildGovernanceConsoleReport,
} from "@turnkeyai/qc-runtime/operator-inspection";

const baseUrl = process.env.TURNKEYAI_DAEMON_URL ?? "http://127.0.0.1:4100";

if (wantsProcessHelp(process.argv.slice(2))) {
  printTuiUsage(0);
}

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

    if (command === "runtime-worker-sessions") {
      const limit = Number(args || "10");
      const params = new URLSearchParams();
      if (currentThreadId) {
        params.set("threadId", currentThreadId);
      }
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(limit));
      }
      printWorkerSessions(
        (await getJson(`/runtime-worker-sessions?${params.toString()}`)) as WorkerSessionRecord[]
      );
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

    if (command === "operator-triage") {
      await handleOperatorTriageCommand(args);
      continue;
    }

    if (command === "prompt-console") {
      await handlePromptConsoleCommand(args);
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

    if (command === "relay-peers") {
      await handleRelayPeersCommand();
      continue;
    }

    if (command === "relay-targets") {
      await handleRelayTargetsCommand(args);
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

    if (command === "soak-cases") {
      await handleSoakCasesCommand();
      continue;
    }

    if (command === "soak-run") {
      await handleSoakRunCommand(args);
      continue;
    }

    if (command === "acceptance-cases") {
      await handleAcceptanceCasesCommand();
      continue;
    }

    if (command === "acceptance-run") {
      await handleAcceptanceRunCommand(args);
      continue;
    }

    if (command === "realworld-cases") {
      await handleRealWorldCasesCommand();
      continue;
    }

    if (command === "realworld-run") {
      await handleRealWorldRunCommand(args);
      continue;
    }

    if (command === "soak-series") {
      await handleSoakSeriesCommand(args);
      continue;
    }

    if (command === "transport-soak") {
      await handleTransportSoakCommand(args);
      continue;
    }

    if (command === "release-verify") {
      await handleReleaseVerifyCommand();
      continue;
    }

    if (command === "validation-ops") {
      await handleValidationOpsCommand(args);
      continue;
    }

    if (command === "validation-cases") {
      await handleValidationCasesCommand();
      continue;
    }

    if (command === "validation-profiles") {
      await handleValidationProfilesCommand();
      continue;
    }

    if (command === "validation-run") {
      await handleValidationRunCommand(args);
      continue;
    }

    if (command === "validation-profile-run") {
      await handleValidationProfileRunCommand(args);
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

function wantsProcessHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h") || args.includes("help");
}

function printTuiUsage(exitCode: number): never {
  const lines = [
    "TurnkeyAI TUI",
    "",
    "Usage:",
    "  turnkeyai tui",
    "  turnkeyai tui --help",
    "",
    "Environment:",
    "  TURNKEYAI_DAEMON_URL  Override the daemon base URL",
    "  TURNKEYAI_DAEMON_TOKEN  Send bearer auth for daemon requests",
    "",
    "Run without flags to enter interactive mode.",
  ];
  const output = exitCode === 0 ? console.log : console.error;
  output(lines.join("\n"));
  process.exit(exitCode);
}

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
  console.log("  runtime-worker-sessions [limit]     show worker sessions for current thread or all");
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
  console.log("  operator-triage [limit]              show prioritized triage entry points for current thread");
  console.log("  prompt-console [limit]               show recent prompt boundary diagnostics for current thread");
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
  console.log("  relay-peers                           list active/stale relay peers");
  console.log("  relay-targets [peerId]                list relay-discovered targets");
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
  console.log("  soak-cases                            list long-chain stability soak scenarios");
  console.log("  soak-run [scenarioId ...]             run long-chain stability soak suite");
  console.log("  acceptance-cases                      list scenario parity acceptance suites");
  console.log("  acceptance-run [scenarioId ...]       run scenario parity acceptance harness");
  console.log("  realworld-cases                       list real-world runbook scenarios");
  console.log("  realworld-run [scenarioId ...]        run real-world runbook validation suite");
  console.log("  soak-series [cycles] [suite[:item] ...]  run multi-cycle validation soak across selected suites");
  console.log("  transport-soak [cycles] [transport ...] run multi-cycle relay/direct-cdp transport soak");
  console.log("  release-verify                        verify packaged CLI and npm publish dry-run readiness");
  console.log("  validation-ops [limit]               show operator-facing validation/release/soak run summary");
  console.log("  validation-cases                      list unified validation suites and items");
  console.log("  validation-profiles                   list fixed validation hardening profiles");
  console.log("  validation-run [suite[:item] ...]     run unified validation suites or individual items");
  console.log("  validation-profile-run <profileId>    run a fixed hardening profile (smoke/nightly/prerelease/weekly)");
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

async function handleRelayPeersCommand(): Promise<void> {
  printRelayPeers(
    (await getJson("/relay/peers")) as Array<{
      peerId: string;
      label?: string;
      capabilities: string[];
      transportLabel?: string;
      registeredAt: number;
      lastSeenAt: number;
      status: "online" | "stale";
    }>
  );
}

async function handleRelayTargetsCommand(args: string): Promise<void> {
  const peerId = args.trim();
  const suffix = peerId ? `?peerId=${encodeURIComponent(peerId)}` : "";
  printRelayTargets(
    (await getJson(`/relay/targets${suffix}`)) as Array<{
      relayTargetId: string;
      peerId: string;
      url: string;
      title?: string;
      status?: "open" | "attached" | "detached" | "closed";
      lastSeenAt: number;
    }>
  );
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

function printRelayPeers(
  peers: Array<{
    peerId: string;
    label?: string;
    capabilities: string[];
    transportLabel?: string;
    registeredAt: number;
    lastSeenAt: number;
    status: "online" | "stale";
  }>
): void {
  console.log(`Relay Peers: ${peers.length}`);
  for (const peer of peers) {
    console.log(
      `- ${peer.peerId}  status=${peer.status}  transport=${peer.transportLabel ?? "relay"}  capabilities=${peer.capabilities.join(", ")}`
    );
    if (peer.label) {
      console.log(`  ${peer.label}`);
    }
    console.log(`  registeredAt=${new Date(peer.registeredAt).toISOString()}  lastSeenAt=${new Date(peer.lastSeenAt).toISOString()}`);
  }
}

function printRelayTargets(
  targets: Array<{
    relayTargetId: string;
    peerId: string;
    url: string;
    title?: string;
    status?: "open" | "attached" | "detached" | "closed";
    lastSeenAt: number;
  }>
): void {
  console.log(`Relay Targets: ${targets.length}`);
  for (const target of targets) {
    console.log(
      `- ${target.relayTargetId}  peer=${target.peerId}  status=${target.status ?? "open"}  lastSeenAt=${new Date(target.lastSeenAt).toISOString()}`
    );
    console.log(`  ${target.url}`);
    if (target.title) {
      console.log(`  title: ${target.title}`);
    }
  }
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
  if (report.workerStartupReconcile) {
    console.log(
      `  worker startup reconcile: total=${report.workerStartupReconcile.totalSessions} downgraded-running=${report.workerStartupReconcile.downgradedRunningSessions}`
    );
  }
  if (report.workerSessionHealth) {
    console.log(
      `  worker sessions: total=${report.workerSessionHealth.totalSessions} active=${report.workerSessionHealth.activeSessions} orphaned=${report.workerSessionHealth.orphanedSessions} missing-context=${report.workerSessionHealth.missingContextSessions}`
    );
  }
  if (report.workerBindingReconcile) {
    console.log(
      `  worker binding reconcile: role-runs=${report.workerBindingReconcile.totalRoleRuns} bindings=${report.workerBindingReconcile.totalBindings} cleared-missing=${report.workerBindingReconcile.clearedMissingBindings} cleared-terminal=${report.workerBindingReconcile.clearedTerminalBindings} cleared-cross-thread=${report.workerBindingReconcile.clearedCrossThreadBindings} attention=${report.workerBindingReconcile.roleRunsNeedingAttention} requeued=${report.workerBindingReconcile.roleRunsRequeued} failed=${report.workerBindingReconcile.roleRunsFailed}`
    );
  }
  if (report.roleRunStartupRecovery) {
    console.log(
      `  role run startup recovery: total=${report.roleRunStartupRecovery.totalRoleRuns} restarted-queued=${report.roleRunStartupRecovery.restartedQueuedRuns} restarted-running=${report.roleRunStartupRecovery.restartedRunningRuns} restarted-resuming=${report.roleRunStartupRecovery.restartedResumingRuns} orphaned=${report.roleRunStartupRecovery.orphanedThreadRuns} failed-orphaned=${report.roleRunStartupRecovery.failedOrphanedRuns}`
    );
    console.log(
      `    cleared-invalid-handoffs=${report.roleRunStartupRecovery.clearedInvalidHandoffs} queued-idled=${report.roleRunStartupRecovery.queuedRunsIdled}`
    );
  }
  if (report.flowRecoveryStartupReconcile) {
    console.log(
      `  flow/recovery startup reconcile: orphaned-flows=${report.flowRecoveryStartupReconcile.orphanedFlows} aborted-orphaned-flows=${report.flowRecoveryStartupReconcile.abortedOrphanedFlows} orphaned-recovery-runs=${report.flowRecoveryStartupReconcile.orphanedRecoveryRuns} missing-flow-recovery-runs=${report.flowRecoveryStartupReconcile.missingFlowRecoveryRuns} cross-thread-flow-recovery-runs=${report.flowRecoveryStartupReconcile.crossThreadFlowRecoveryRuns} failed-recovery-runs=${report.flowRecoveryStartupReconcile.failedRecoveryRuns}`
    );
  }
  if (report.runtimeChainStartupReconcile) {
    console.log(
      `  runtime chain startup reconcile: orphaned-thread-chains=${report.runtimeChainStartupReconcile.orphanedThreadChains} missing-flow-chains=${report.runtimeChainStartupReconcile.missingFlowChains} cross-thread-flow-chains=${report.runtimeChainStartupReconcile.crossThreadFlowChains} affected=${report.runtimeChainStartupReconcile.affectedChainIds.length}`
    );
  }
  if (report.runtimeChainArtifactStartupReconcile) {
    console.log(
      `  runtime chain artifact startup reconcile: orphaned-statuses=${report.runtimeChainArtifactStartupReconcile.orphanedStatuses} cross-thread-statuses=${report.runtimeChainArtifactStartupReconcile.crossThreadStatuses} orphaned-spans=${report.runtimeChainArtifactStartupReconcile.orphanedSpans} cross-thread-spans=${report.runtimeChainArtifactStartupReconcile.crossThreadSpans} cross-flow-spans=${report.runtimeChainArtifactStartupReconcile.crossFlowSpans} orphaned-events=${report.runtimeChainArtifactStartupReconcile.orphanedEvents} missing-span-events=${report.runtimeChainArtifactStartupReconcile.missingSpanEvents} cross-thread-events=${report.runtimeChainArtifactStartupReconcile.crossThreadEvents} cross-chain-events=${report.runtimeChainArtifactStartupReconcile.crossChainEvents} affected=${report.runtimeChainArtifactStartupReconcile.affectedChainIds.length}`
    );
  }
  printRuntimeSummaryEntries("  attention chains:", report.attentionChains);
  printRuntimeSummaryEntries("  active chains:", report.activeChains);
  printRuntimeSummaryEntries("  waiting chains:", report.waitingChains);
  printRuntimeSummaryEntries("  stale chains:", report.staleChains);
  printRuntimeSummaryEntries("  failed chains:", report.failedChains);
  printRuntimeSummaryEntries("  recently resolved:", report.recentlyResolved);
}

function printWorkerSessions(records: WorkerSessionRecord[]): void {
  if (records.length === 0) {
    console.log("no worker sessions");
    return;
  }
  for (const record of records) {
    console.log(
      [
        `- ${record.workerRunKey}`,
        `type=${record.state.workerType}`,
        `status=${record.state.status}`,
        `updated=${new Date(record.state.updatedAt).toISOString()}`,
        record.context?.threadId ? `thread=${record.context.threadId}` : "thread=-",
        record.context?.flowId ? `flow=${record.context.flowId}` : "flow=-",
        record.context?.roleId ? `role=${record.context.roleId}` : "role=-",
        record.context?.taskId ? `task=${record.context.taskId}` : "task=-",
      ].join(" ")
    );
  }
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

function printPromptConsole(report: PromptConsoleReport): void {
  console.log("Prompt Console");
  console.log(`  total boundaries: ${report.totalBoundaries}`);
  console.log(`  compactions: ${report.compactionCount}`);
  console.log(`  reductions: ${report.reductionCount}`);
  if (Object.keys(report.boundaryKindCounts).length > 0) {
    console.log(
      `  boundary kinds: ${Object.entries(report.boundaryKindCounts)
        .map(([kind, count]) => `${kind}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.reductionLevelCounts).length > 0) {
    console.log(
      `  reduction levels: ${Object.entries(report.reductionLevelCounts)
        .map(([level, count]) => `${level}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.modelCounts).length > 0) {
    console.log(
      `  models: ${Object.entries(report.modelCounts)
        .map(([model, count]) => `${model}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.modelChainCounts).length > 0) {
    console.log(
      `  model chains: ${Object.entries(report.modelChainCounts)
        .map(([chain, count]) => `${chain}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(report.compactedSegmentCounts).length > 0) {
    console.log(
      `  compacted segments: ${Object.entries(report.compactedSegmentCounts)
        .map(([segment, count]) => `${segment}=${count}`)
        .join(", ")}`
    );
  }
  console.log(
    `  recent turns packed: ${report.totalRecentTurnsPacked}/${report.totalRecentTurnsSelected}`
  );
  console.log(
    `  retrieved memory packed: ${report.totalRetrievedMemoryPacked}/${report.totalRetrievedMemoryCandidates}`
  );
  console.log(
    `  worker evidence packed: ${report.totalWorkerEvidencePacked}/${report.totalWorkerEvidenceCandidates}`
  );
  if (Object.values(report.continuityCarryForwardCounts).some((count) => count > 0)) {
    console.log(
      `  carry-forward: continuation=${report.continuityCarryForwardCounts.continuationContext}, pending=${report.continuityCarryForwardCounts.pendingWork}, waiting=${report.continuityCarryForwardCounts.waitingOn}, open-questions=${report.continuityCarryForwardCounts.openQuestions}, decisions-or-constraints=${report.continuityCarryForwardCounts.decisionsOrConstraints}`
    );
  }
  console.log(`  unique fingerprints: ${report.uniqueAssemblyFingerprintCount}`);
  if (report.latestBoundaries.length > 0) {
    console.log("  latest boundaries:");
    for (const entry of report.latestBoundaries) {
      const parts = [
        new Date(entry.recordedAt).toISOString(),
        entry.boundaryKind,
      ];
      if (entry.roleId) {
        parts.push(`role=${entry.roleId}`);
      }
      if (entry.modelId) {
        parts.push(`model=${entry.modelId}`);
      }
      if (entry.modelChainId) {
        parts.push(`chain=${entry.modelChainId}`);
      }
      if (entry.reductionLevel) {
        parts.push(`reduction=${entry.reductionLevel}`);
      }
      console.log(`    - ${parts.join("  ")}`);
      console.log(`      ${entry.summary}`);
      if (entry.assemblyFingerprint) {
        console.log(`      fingerprint: ${entry.assemblyFingerprint}`);
      }
      if (entry.compactedSegments?.length) {
        console.log(`      compacted: ${entry.compactedSegments.join(", ")}`);
      }
      if (entry.omittedSections?.length) {
        console.log(`      omitted: ${entry.omittedSections.join(", ")}`);
      }
      if (entry.sectionOrder?.length) {
        console.log(`      sections: ${entry.sectionOrder.join(" -> ")}`);
      }
      if (entry.tokenEstimate) {
        console.log(
          `      tokens: input=${entry.tokenEstimate.inputTokens} projected=${entry.tokenEstimate.totalProjectedTokens} reserved=${entry.tokenEstimate.outputTokensReserved}`
        );
      }
      if (entry.contextDiagnostics) {
        console.log(
          `      packed: turns=${entry.contextDiagnostics.recentTurns.packedCount}/${entry.contextDiagnostics.recentTurns.selectedCount}, memory=${entry.contextDiagnostics.retrievedMemory.packedCount}/${entry.contextDiagnostics.retrievedMemory.selectedCount}, evidence=${entry.contextDiagnostics.workerEvidence.packedCount}/${entry.contextDiagnostics.workerEvidence.selectedCount}`
        );
        const carryForward: string[] = [];
        if (entry.contextDiagnostics.continuity.hasContinuationContext) {
          carryForward.push("continuation");
        }
        if (entry.contextDiagnostics.continuity.carriesPendingWork) {
          carryForward.push("pending");
        }
        if (entry.contextDiagnostics.continuity.carriesWaitingOn) {
          carryForward.push("waiting");
        }
        if (entry.contextDiagnostics.continuity.carriesOpenQuestions) {
          carryForward.push("open-questions");
        }
        if (entry.contextDiagnostics.continuity.carriesDecisionOrConstraint) {
          carryForward.push("decisions-or-constraints");
        }
        if (carryForward.length > 0) {
          console.log(`      carry-forward: ${carryForward.join(", ")}`);
        }
      }
    }
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
  if (report.workerStartupReconcile) {
    console.log(
      `  worker startup reconcile: total=${report.workerStartupReconcile.totalSessions} downgraded-running=${report.workerStartupReconcile.downgradedRunningSessions}`
    );
  }
  if (report.workerSessionHealth) {
    console.log(
      `  worker sessions: total=${report.workerSessionHealth.totalSessions} active=${report.workerSessionHealth.activeSessions} orphaned=${report.workerSessionHealth.orphanedSessions} missing-context=${report.workerSessionHealth.missingContextSessions}`
    );
  }
  if (report.workerBindingReconcile) {
    console.log(
      `  worker binding reconcile: role-runs=${report.workerBindingReconcile.totalRoleRuns} bindings=${report.workerBindingReconcile.totalBindings} cleared-missing=${report.workerBindingReconcile.clearedMissingBindings} cleared-terminal=${report.workerBindingReconcile.clearedTerminalBindings} cleared-cross-thread=${report.workerBindingReconcile.clearedCrossThreadBindings} attention=${report.workerBindingReconcile.roleRunsNeedingAttention} requeued=${report.workerBindingReconcile.roleRunsRequeued} failed=${report.workerBindingReconcile.roleRunsFailed}`
    );
  }
  if (report.roleRunStartupRecovery) {
    console.log(
      `  role run startup recovery: total=${report.roleRunStartupRecovery.totalRoleRuns} restarted-queued=${report.roleRunStartupRecovery.restartedQueuedRuns} restarted-running=${report.roleRunStartupRecovery.restartedRunningRuns} restarted-resuming=${report.roleRunStartupRecovery.restartedResumingRuns} orphaned=${report.roleRunStartupRecovery.orphanedThreadRuns} failed-orphaned=${report.roleRunStartupRecovery.failedOrphanedRuns}`
    );
    console.log(
      `  startup handoff cleanup: cleared-invalid-handoffs=${report.roleRunStartupRecovery.clearedInvalidHandoffs} queued-idled=${report.roleRunStartupRecovery.queuedRunsIdled}`
    );
  }
  if (report.flowRecoveryStartupReconcile) {
    console.log(
      `  flow/recovery startup reconcile: orphaned-flows=${report.flowRecoveryStartupReconcile.orphanedFlows} aborted-orphaned-flows=${report.flowRecoveryStartupReconcile.abortedOrphanedFlows} orphaned-recovery-runs=${report.flowRecoveryStartupReconcile.orphanedRecoveryRuns} missing-flow-recovery-runs=${report.flowRecoveryStartupReconcile.missingFlowRecoveryRuns} cross-thread-flow-recovery-runs=${report.flowRecoveryStartupReconcile.crossThreadFlowRecoveryRuns} failed-recovery-runs=${report.flowRecoveryStartupReconcile.failedRecoveryRuns}`
    );
  }
  if (report.runtimeChainStartupReconcile) {
    console.log(
      `  runtime chain startup reconcile: orphaned-thread-chains=${report.runtimeChainStartupReconcile.orphanedThreadChains} missing-flow-chains=${report.runtimeChainStartupReconcile.missingFlowChains} cross-thread-flow-chains=${report.runtimeChainStartupReconcile.crossThreadFlowChains} affected=${report.runtimeChainStartupReconcile.affectedChainIds.length}`
    );
  }
  if (report.runtimeChainArtifactStartupReconcile) {
    console.log(
      `  runtime chain artifact startup reconcile: orphaned-statuses=${report.runtimeChainArtifactStartupReconcile.orphanedStatuses} cross-thread-statuses=${report.runtimeChainArtifactStartupReconcile.crossThreadStatuses} orphaned-spans=${report.runtimeChainArtifactStartupReconcile.orphanedSpans} cross-thread-spans=${report.runtimeChainArtifactStartupReconcile.crossThreadSpans} cross-flow-spans=${report.runtimeChainArtifactStartupReconcile.crossFlowSpans} orphaned-events=${report.runtimeChainArtifactStartupReconcile.orphanedEvents} missing-span-events=${report.runtimeChainArtifactStartupReconcile.missingSpanEvents} cross-thread-events=${report.runtimeChainArtifactStartupReconcile.crossThreadEvents} cross-chain-events=${report.runtimeChainArtifactStartupReconcile.crossChainEvents} affected=${report.runtimeChainArtifactStartupReconcile.affectedChainIds.length}`
    );
  }
  console.log(
    `  flow=${report.flow.attentionCount}  replay=${report.replay.attentionCount}  governance=${report.governance.attentionCount}  recovery=${report.recovery.attentionCount}  prompt=${report.promptAttentionCount}`
  );
  if (report.prompt.totalBoundaries > 0) {
    console.log(
      `  prompt pressure: boundaries=${report.prompt.totalBoundaries}  compactions=${report.prompt.compactionCount}  reductions=${report.prompt.reductionCount}  memory=${report.prompt.totalRetrievedMemoryPacked}/${report.prompt.totalRetrievedMemoryCandidates}  evidence=${report.prompt.totalWorkerEvidencePacked}/${report.prompt.totalWorkerEvidenceCandidates}`
    );
  }
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
        if (entry.allowedActions && entry.allowedActions.length > 0) {
          parts.push(`allowed=${entry.allowedActions.map(describeAttemptAction).join("/")}`);
        }
        if (entry.browserContinuityState) {
          parts.push(`browser=${entry.browserContinuityState}`);
        }
        if (entry.browserTransportLabel) {
          parts.push(`transport=${entry.browserTransportLabel}`);
        }
        if (entry.relayDiagnosticBucket) {
          parts.push(`relay=${entry.relayDiagnosticBucket}`);
        } else if (entry.browserDiagnosticBucket) {
          parts.push(`diag=${entry.browserDiagnosticBucket}`);
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
        if (entry.browserTransportLabel) {
          parts.push(`transport=${entry.browserTransportLabel}`);
        }
        if (entry.relayDiagnosticBucket) {
          parts.push(`relay=${entry.relayDiagnosticBucket}`);
        } else if (entry.browserDiagnosticBucket) {
          parts.push(`diag=${entry.browserDiagnosticBucket}`);
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
      if (entry.allowedActions && entry.allowedActions.length > 0) {
        parts.push(`allowed=${entry.allowedActions.map(describeAttemptAction).join("/")}`);
      }
      if (entry.browserContinuityState) {
        parts.push(`browser=${entry.browserContinuityState}`);
      }
      if (entry.browserTransportLabel) {
        parts.push(`transport=${entry.browserTransportLabel}`);
      }
      if (entry.relayDiagnosticBucket) {
        parts.push(`relay=${entry.relayDiagnosticBucket}`);
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
    if (item.allowedActions && item.allowedActions.length > 0) {
      parts.push(`allowed=${item.allowedActions.map(describeAttemptAction).join("/")}`);
    }
    if (item.browserContinuityState) {
      parts.push(`browser=${item.browserContinuityState}`);
    }
    if (item.browserTransportLabel) {
      parts.push(`transport=${item.browserTransportLabel}`);
    }
    if (item.relayDiagnosticBucket) {
      parts.push(`relay=${item.relayDiagnosticBucket}`);
    } else if (item.browserDiagnosticBucket) {
      parts.push(`diag=${item.browserDiagnosticBucket}`);
    }
    console.log(`  - ${parts.join("  ")}`);
    console.log(`    headline: ${item.headline}`);
    console.log(`    ${item.summary}`);
    if (item.reasons && item.reasons.length > 0) {
      console.log(`    reasons: ${item.reasons.join(" | ")}`);
    }
  }
}

function printOperatorTriage(report: OperatorTriageReport): void {
  console.log("Operator Triage");
  console.log(`  total attention: ${report.totalAttentionCount}`);
  console.log(`  unique cases: ${report.uniqueCaseCount}`);
  console.log(
    `  blocked=${report.blockedCaseCount}  waiting_manual=${report.waitingManualCaseCount}  recovering=${report.recoveringCaseCount}`
  );
  console.log(
    `  runtime waiting=${report.runtimeWaitingCount}  stale=${report.runtimeStaleCount}  failed=${report.runtimeFailedCount}`
  );
  console.log(
    `  worker orphaned=${report.workerSessionOrphanCount}  missing_context=${report.workerSessionMissingContextCount}`
  );
  console.log(
    `  prompt reductions=${report.promptReductionCount}  prompt attention=${report.promptAttentionCount}`
  );
  if (report.recommendedEntryPoint) {
    console.log(`  recommended entry: ${report.recommendedEntryPoint}`);
  }
  if (report.focusAreas.length > 0) {
    console.log("  focus areas:");
    for (const area of report.focusAreas) {
      const parts = [
        area.label,
        `area=${area.area}`,
        `severity=${area.severity}`,
      ];
      if (area.state) {
        parts.push(`state=${area.state}`);
      }
      if (area.source) {
        parts.push(`source=${area.source}`);
      }
      if (area.gate) {
        parts.push(`gate=${area.gate}`);
      }
      if (area.browserContinuityState) {
        parts.push(`browser=${area.browserContinuityState}`);
      }
      if (area.browserTransportLabel) {
        parts.push(`transport=${area.browserTransportLabel}`);
      }
      if (area.relayDiagnosticBucket) {
        parts.push(`relay=${area.relayDiagnosticBucket}`);
      } else if (area.browserDiagnosticBucket) {
        parts.push(`diag=${area.browserDiagnosticBucket}`);
      }
      console.log(`    - ${parts.join("  ")}`);
      console.log(`      ${area.headline}`);
      console.log(`      next=${area.nextStep}  cmd=${area.commandHint}`);
      console.log(`      reason=${area.reason}`);
    }
  }
}

function printValidationOpsReport(report: ValidationOpsReport): void {
  console.log("Validation Ops");
  console.log(
    `  runs=${report.totalRuns}  failed=${report.failedRuns}  passed=${report.passedRuns}  attention=${report.attentionCount}`
  );
  if (Object.keys(report.runTypeCounts).length > 0) {
    console.log(`  run types: ${formatCountMap(report.runTypeCounts)}`);
  }
  if (Object.keys(report.bucketCounts).length > 0) {
    console.log(`  buckets: ${formatCountMap(report.bucketCounts)}`);
  }
  if (Object.keys(report.severityCounts).length > 0) {
    console.log(`  severity: ${formatCountMap(report.severityCounts)}`);
  }
  if (Object.keys(report.recommendedActionCounts).length > 0) {
    console.log(`  actions: ${formatCountMap(report.recommendedActionCounts)}`);
  }
  if (report.latestRuns.length > 0) {
    console.log("  latest runs:");
    for (const run of report.latestRuns) {
      const parts = [
        run.runId,
        `type=${run.runType}`,
        `status=${run.status}`,
        `issues=${run.issueCount}`,
        `durationMs=${run.durationMs}`,
      ];
      if (run.profileId) {
        parts.push(`profile=${run.profileId}`);
      }
      if (run.cycles) {
        parts.push(`cycles=${run.cycles}`);
      }
      if (run.targets?.length) {
        parts.push(`targets=${run.targets.join(",")}`);
      }
      console.log(`    - ${parts.join("  ")}`);
      console.log(`      ${run.title}`);
      if (run.artifactPath) {
        console.log(`      artifact=${run.artifactPath}`);
      }
    }
  }
  if (report.activeIssues.length > 0) {
    console.log("  active issues:");
    for (const issue of report.activeIssues) {
      console.log(
        `    - ${issue.runType}  ${issue.issueId}  severity=${issue.severity}  bucket=${issue.bucket}  action=${issue.recommendedAction}`
      );
      console.log(`      ${issue.summary}`);
      console.log(`      cmd=${issue.commandHint}`);
    }
  }
}

function printBrowserTransportSoakResult(result: {
  status: "passed" | "failed";
  totalCycles: number;
  passedCycles: number;
  failedCycles: number;
  totalTargetRuns: number;
  failedTargetRuns: number;
  durationMs: number;
  targets: Array<"relay" | "direct-cdp">;
  artifactPath?: string;
  cycleResults: Array<{
    cycleNumber: number;
    status: "passed" | "failed";
    durationMs: number;
    targets: Array<{
      target: "relay" | "direct-cdp";
      status: "passed" | "failed";
      durationMs: number;
      failureBucket: string;
      summary: string;
    }>;
  }>;
  targetAggregates: Array<{
    target: "relay" | "direct-cdp";
    cycles: number;
    passedCycles: number;
    failedCycles: number;
    failureBuckets: Array<{
      bucket: string;
      count: number;
    }>;
  }>;
}): void {
  console.log("Browser Transport Soak");
  console.log(
    `  status=${result.status}  cycles=${result.passedCycles}/${result.totalCycles}  targetRuns=${result.totalTargetRuns - result.failedTargetRuns}/${result.totalTargetRuns}  durationMs=${result.durationMs}`
  );
  console.log(`  targets: ${result.targets.join(", ")}`);
  if (result.artifactPath) {
    console.log(`  artifact: ${result.artifactPath}`);
  }
  for (const cycle of result.cycleResults) {
    console.log(`  cycle ${cycle.cycleNumber}: status=${cycle.status}  durationMs=${cycle.durationMs}`);
    for (const target of cycle.targets) {
      console.log(
        `    - ${target.target}  status=${target.status}  bucket=${target.failureBucket}  durationMs=${target.durationMs}`
      );
      console.log(`      ${target.summary}`);
    }
  }
  for (const aggregate of result.targetAggregates) {
    console.log(
      `  aggregate ${aggregate.target}: passed=${aggregate.passedCycles}/${aggregate.cycles}  failed=${aggregate.failedCycles}`
    );
    if (aggregate.failureBuckets.length > 0) {
      console.log(
        `    buckets: ${aggregate.failureBuckets.map((bucket) => `${bucket.bucket}=${bucket.count}`).join(", ")}`
      );
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

async function handlePromptConsoleCommand(raw: string): Promise<void> {
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
  printPromptConsole((await getJson(`/prompt-console?${params.toString()}`)) as PromptConsoleReport);
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

async function handleOperatorTriageCommand(raw: string): Promise<void> {
  if (!currentThreadId) {
    console.log("no active thread; run `bootstrap` or `use <threadId>` first");
    return;
  }
  const params = new URLSearchParams({
    threadId: currentThreadId,
  });
  const limit = Number(raw.trim() || "5");
  if (Number.isFinite(limit) && limit > 0) {
    params.set("limit", String(limit));
  }
  printOperatorTriage(
    (await getJson(`/operator-triage?${params.toString()}`)) as OperatorTriageReport
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
      area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
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
        area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
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
        area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
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
        area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
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
          area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
          summary: string;
          status: "passed" | "failed";
          details: string[];
        }>;
      }>;
    }
  );
}

async function handleSoakCasesCommand(): Promise<void> {
  printSoakScenarioList(
    (await getJson("/soak-cases")) as {
      totalScenarios: number;
      scenarios: Array<{
        scenarioId: string;
        area:
          | "dispatch"
          | "parallel"
          | "browser"
          | "recovery"
          | "context"
          | "governance"
          | "operator"
          | "observability"
          | "runtime";
        title: string;
        summary: string;
        caseIds: string[];
      }>;
    }
  );
}

async function handleSoakRunCommand(raw: string): Promise<void> {
  const scenarioIds = raw.split(/\s+/).filter(Boolean);
  printSoakRunResult(
    (await postJson("/soak-cases/run", scenarioIds.length > 0 ? { scenarioIds } : {})) as {
      totalScenarios: number;
      passedScenarios: number;
      failedScenarios: number;
      totalCases: number;
      passedCases: number;
      failedCases: number;
      scenarios: Array<{
        scenarioId: string;
        area:
          | "dispatch"
          | "parallel"
          | "browser"
          | "recovery"
          | "context"
          | "governance"
          | "operator"
          | "observability"
          | "runtime";
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
          area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
          summary: string;
          status: "passed" | "failed";
          details: string[];
        }>;
      }>;
    }
  );
}

async function handleAcceptanceCasesCommand(): Promise<void> {
  printAcceptanceScenarioList(
    (await getJson("/acceptance-cases")) as {
      totalScenarios: number;
      scenarios: Array<{
        scenarioId: string;
        area:
          | "dispatch"
          | "parallel"
          | "browser"
          | "recovery"
          | "context"
          | "governance"
          | "operator"
          | "observability";
        title: string;
        summary: string;
        caseIds: string[];
      }>;
    }
  );
}

async function handleAcceptanceRunCommand(raw: string): Promise<void> {
  const scenarioIds = raw.split(/\s+/).filter(Boolean);
  printAcceptanceRunResult(
    (await postJson("/acceptance-cases/run", scenarioIds.length > 0 ? { scenarioIds } : {})) as {
      totalScenarios: number;
      passedScenarios: number;
      failedScenarios: number;
      totalCases: number;
      passedCases: number;
      failedCases: number;
      scenarios: Array<{
        scenarioId: string;
        area:
          | "dispatch"
          | "parallel"
          | "browser"
          | "recovery"
          | "context"
          | "governance"
          | "operator"
          | "observability";
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
          area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
          summary: string;
          status: "passed" | "failed";
          details: string[];
        }>;
      }>;
    }
  );
}

async function handleRealWorldCasesCommand(): Promise<void> {
  printRealWorldScenarioList(
    (await getJson("/realworld-cases")) as {
      totalScenarios: number;
      scenarios: Array<{
        scenarioId: string;
        area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
        title: string;
        summary: string;
        caseIds: string[];
      }>;
    }
  );
}

async function handleRealWorldRunCommand(raw: string): Promise<void> {
  const scenarioIds = raw.split(/\s+/).filter(Boolean);
  printRealWorldRunResult(
    (await postJson("/realworld-cases/run", scenarioIds.length > 0 ? { scenarioIds } : {})) as {
      totalScenarios: number;
      passedScenarios: number;
      failedScenarios: number;
      totalCases: number;
      passedCases: number;
      failedCases: number;
      scenarios: Array<{
        scenarioId: string;
        area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
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
          area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
          summary: string;
          status: "passed" | "failed";
          details: string[];
        }>;
      }>;
    }
  );
}

async function handleValidationCasesCommand(): Promise<void> {
  printValidationSuiteList(
    (await getJson("/validation-cases")) as {
      totalSuites: number;
      totalItems: number;
      suites: Array<{
        suiteId: "regression" | "soak" | "failure" | "acceptance" | "realworld";
        title: string;
        summary: string;
        totalItems: number;
        items: Array<{
          suiteId: "regression" | "soak" | "failure" | "acceptance" | "realworld";
          itemId: string;
          area: string;
          title: string;
          summary: string;
          caseIds?: string[];
        }>;
      }>;
    }
  );
}

async function handleValidationProfilesCommand(): Promise<void> {
  printValidationProfileList(
    (await getJson("/validation-profiles")) as {
      totalProfiles: number;
      profiles: Array<{
        profileId: "smoke" | "nightly" | "prerelease" | "weekly";
        title: string;
        summary: string;
        focusAreas: string[];
        validationSelectors: string[];
        includeReleaseReadiness: boolean;
        soakSeriesCycles?: number;
        soakSeriesSelectors?: string[];
        transportSoakCycles?: number;
        transportSoakTargets?: Array<"relay" | "direct-cdp">;
      }>;
    }
  );
}

async function handleValidationRunCommand(raw: string): Promise<void> {
  const selectors = raw.split(/\s+/).filter(Boolean);
  try {
    const payload = await postJson("/validation-cases/run", selectors.length > 0 ? { selectors } : {});
    printValidationRunResult(
      payload as {
        totalSuites: number;
        passedSuites: number;
        failedSuites: number;
        totalItems: number;
        passedItems: number;
        failedItems: number;
        totalCases: number;
        passedCases: number;
        failedCases: number;
        suites: Array<{
          suiteId: "regression" | "soak" | "failure" | "acceptance" | "realworld";
          title: string;
          summary: string;
          totalItems: number;
          passedItems: number;
          failedItems: number;
          totalCases: number;
          passedCases: number;
          failedCases: number;
          items: Array<{
            suiteId: "regression" | "soak" | "failure" | "acceptance" | "realworld";
            itemId: string;
            area: string;
            title: string;
            summary: string;
            status: "passed" | "failed";
            totalCases: number;
            passedCases: number;
            failedCases: number;
            caseResults: Array<{
              caseId: string;
              title: string;
              area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
              summary: string;
              status: "passed" | "failed";
              details: string[];
            }>;
          }>;
        }>;
      }
    );
  } catch (error) {
    console.log(`validation run failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
}

async function handleSoakSeriesCommand(raw: string): Promise<void> {
  const tokens = raw.split(/\s+/).filter(Boolean);
  let cycles = 5;
  let selectors = tokens;
  if (tokens.length > 0 && /^\d+$/.test(tokens[0]!)) {
    cycles = Number(tokens[0]);
    selectors = tokens.slice(1);
  }

  try {
    const payload = await postJson("/soak-series/run", { cycles, selectors });
    printValidationSoakSeriesResult(
      payload as {
        status: "passed" | "failed";
        selectors: string[];
        totalCycles: number;
        passedCycles: number;
        failedCycles: number;
        totalSuites: number;
        failedSuites: number;
        totalItems: number;
        failedItems: number;
        totalCases: number;
        failedCases: number;
        durationMs: number;
        cycles: Array<{
          cycleNumber: number;
          status: "passed" | "failed";
          durationMs: number;
          totalSuites: number;
          failedSuites: number;
          totalItems: number;
          failedItems: number;
          totalCases: number;
          failedCases: number;
          suites: Array<{
            suiteId: "regression" | "soak" | "failure" | "acceptance" | "realworld";
            status: "passed" | "failed";
            totalItems: number;
            failedItems: number;
            totalCases: number;
            failedCases: number;
          }>;
        }>;
        suiteAggregates: Array<{
          suiteId: "regression" | "soak" | "failure" | "acceptance" | "realworld";
          cycles: number;
          failedCycles: number;
          totalItems: number;
          failedItems: number;
          totalCases: number;
          failedCases: number;
        }>;
      }
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

async function handleTransportSoakCommand(raw: string): Promise<void> {
  const tokens = raw.split(/\s+/).filter(Boolean);
  let cycles = 3;
  let targets = tokens;
  if (tokens.length > 0 && /^\d+$/.test(tokens[0]!)) {
    cycles = Number(tokens[0]);
    targets = tokens.slice(1);
  }

  try {
    const payload = await postJson("/transport-soak/run", { cycles, targets });
    printBrowserTransportSoakResult(
      payload as {
        status: "passed" | "failed";
        totalCycles: number;
        passedCycles: number;
        failedCycles: number;
        totalTargetRuns: number;
        failedTargetRuns: number;
        durationMs: number;
        targets: Array<"relay" | "direct-cdp">;
        artifactPath?: string;
        cycleResults: Array<{
          cycleNumber: number;
          status: "passed" | "failed";
          durationMs: number;
          targets: Array<{
            target: "relay" | "direct-cdp";
            status: "passed" | "failed";
            durationMs: number;
            failureBucket: string;
            summary: string;
          }>;
        }>;
        targetAggregates: Array<{
          target: "relay" | "direct-cdp";
          cycles: number;
          passedCycles: number;
          failedCycles: number;
          failureBuckets: Array<{
            bucket: string;
            count: number;
          }>;
        }>;
      }
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

async function handleReleaseVerifyCommand(): Promise<void> {
  printReleaseReadinessResult(
    (await postJson("/release-readiness/run", {})) as {
      status: "passed" | "failed";
      totalChecks: number;
      passedChecks: number;
      failedChecks: number;
      artifact: {
        filename: string;
        packageSize?: number;
        unpackedSize?: number;
        shasum?: string;
        integrity?: string;
        totalFiles?: number;
      } | null;
      checks: Array<{
        checkId: string;
        title: string;
        status: "passed" | "failed";
        details: string[];
      }>;
    }
  );
}

async function handleValidationOpsCommand(raw: string): Promise<void> {
  const requestedLimit = Number(raw.trim() || "10");
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 10;
  const params = new URLSearchParams({ limit: String(limit) });
  printValidationOpsReport((await getJson(`/validation-ops?${params.toString()}`)) as ValidationOpsReport);
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
    const allowedActions = listAllowedRecoveryRunActions(run.status).filter((action) => action !== "dispatch");
    if (allowedActions.length > 0) {
      console.log(`  allowed: ${allowedActions.map(describeAttemptAction).join(", ")}`);
    }
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
  if (Object.keys(report.gateCounts).length > 0) {
    console.log(
      `  gates: ${Object.entries(report.gateCounts)
        .map(([gate, count]) => `${gate}=${count}`)
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
      if (run.targetLayer || run.targetWorker) {
        parts.push(`target=${run.targetLayer ?? "main"}${run.targetWorker ? `/${run.targetWorker}` : ""}`);
      }
      const latestBrowserOutcome =
        [...run.attempts]
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .find((attempt) => attempt.browserOutcome)?.browserOutcome ?? null;
      if (latestBrowserOutcome) {
        parts.push(`outcome=${latestBrowserOutcome}`);
      }
      console.log(`    - ${parts.join("  ")}`);
      console.log(`      ${run.latestSummary}`);
      if (run.waitingReason) {
        console.log(`      waiting: ${run.waitingReason}`);
      }
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
  const allowedActions = listAllowedRecoveryRunActions(run.status).filter((action) => action !== "dispatch");
  console.log(`  allowed actions: ${allowedActions.length > 0 ? allowedActions.map(describeAttemptAction).join(", ") : "none"}`);
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
    if (bundle.browserContinuity.transportMode || bundle.browserContinuity.transportLabel || bundle.browserContinuity.transportTargetId) {
      console.log(
        `  browser transport: ${bundle.browserContinuity.transportLabel ?? bundle.browserContinuity.transportMode ?? "-"}  peer=${bundle.browserContinuity.transportPeerId ?? "-"}  transport target=${bundle.browserContinuity.transportTargetId ?? "-"}`
      );
    }
    if (
      bundle.browserContinuity.browserDiagnosticBucket ||
      bundle.browserContinuity.browserDiagnosticSummary ||
      bundle.browserContinuity.relayPeerStatus ||
      bundle.browserContinuity.relayTargetStatus ||
      bundle.browserContinuity.relayDiagnosticBucket
    ) {
      const label = bundle.browserContinuity.transportMode === "relay" || bundle.browserContinuity.relayDiagnosticBucket ? "relay diagnostics" : "browser diagnostics";
      console.log(
        `  ${label}: peer=${bundle.browserContinuity.relayPeerStatus ?? "-"}  target=${bundle.browserContinuity.relayTargetStatus ?? "-"}  bucket=${bundle.browserContinuity.relayDiagnosticBucket ?? bundle.browserContinuity.browserDiagnosticBucket ?? "-"}`
      );
      if (bundle.browserContinuity.relayDiagnosticSummary) {
        console.log(`  relay summary: ${bundle.browserContinuity.relayDiagnosticSummary}`);
      } else if (bundle.browserContinuity.browserDiagnosticSummary) {
        console.log(`  browser summary: ${bundle.browserContinuity.browserDiagnosticSummary}`);
      }
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
  if (bundle.recoveryOperator) {
    console.log(
      `  operator gate: ${bundle.recoveryOperator.currentGate}  case=${bundle.recoveryOperator.caseState}  next=${describeRecoveryAction(bundle.recoveryOperator.nextAction)}  phase=${bundle.recoveryOperator.phase}`
    );
    console.log(`  operator summary: ${bundle.recoveryOperator.phaseSummary}`);
    console.log(
      `  allowed actions: ${
        bundle.recoveryOperator.allowedActions.length > 0
          ? bundle.recoveryOperator.allowedActions.map(describeAttemptAction).join(", ")
          : "none"
      }`
    );
    if (bundle.recoveryOperator.latestBrowserOutcome) {
      console.log(`  latest browser outcome: ${bundle.recoveryOperator.latestBrowserOutcome}`);
    }
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
  const workflowLogEntries = selectBundleWorkflowLogEntries(bundle);
  if (workflowLogEntries.length > 0) {
    console.log("  workflow log:");
    for (const entry of workflowLogEntries) {
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
      if (entry.groupId) {
        parts.push(`group=${entry.groupId}`);
      }
      if (entry.layer) {
        parts.push(`layer=${entry.layer}`);
      }
      if (entry.browserOutcome) {
        parts.push(`browser=${entry.browserOutcome}`);
      }
      if (entry.failureCategory) {
        parts.push(`failure=${entry.failureCategory}`);
      }
      console.log(`    - ${parts.join("  ")}`);
      console.log(`      ${entry.summary}`);
    }
  }
}

function selectBundleWorkflowLogEntries(bundle: ReplayIncidentBundle): Array<{
  recordedAt: number;
  source: "event" | "replay";
  kind: string;
  summary: string;
  status?: string;
  action?: string;
  attemptId?: string;
  groupId?: string;
  layer?: string;
  browserOutcome?: string;
  failureCategory?: string;
}> {
  const recoveryEntries = (bundle.recoveryTimeline ?? []).map((entry) => ({
    recordedAt: entry.recordedAt,
    source: entry.source,
    kind: entry.kind,
    summary: entry.summary,
    ...(entry.status ? { status: entry.status } : {}),
    ...(entry.action ? { action: entry.action } : {}),
    ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
    ...(entry.groupId ? { groupId: entry.groupId } : {}),
    ...(entry.layer ? { layer: entry.layer } : {}),
    ...(entry.browserOutcome ? { browserOutcome: entry.browserOutcome } : {}),
    ...(entry.failure?.category ? { failureCategory: entry.failure.category } : {}),
  }));
  if (recoveryEntries.length > 0) {
    return [...recoveryEntries].sort((left, right) => left.recordedAt - right.recordedAt).slice(-6);
  }

  const replayEntries = [
    ...bundle.recoveryDispatches.map((record) => mapBundleReplayLogEntry(buildReplayBundleLogEntry(record))),
    ...bundle.followUpTimeline.map((entry) => mapBundleReplayLogEntry(entry)),
  ].sort((left, right) => left.recordedAt - right.recordedAt);
  return replayEntries.slice(-6);
}

function mapBundleReplayLogEntry(entry: ReplayTimelineEntry): {
  recordedAt: number;
  source: "replay";
  kind: string;
  summary: string;
  status?: string;
  attemptId?: string;
  groupId?: string;
  layer?: string;
  failureCategory?: string;
} {
  return {
    recordedAt: entry.recordedAt,
    source: "replay",
    kind: entry.layer,
    summary: entry.summary,
    ...(entry.status ? { status: entry.status } : {}),
    ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
    groupId: entry.groupId,
    layer: entry.layer,
    ...(entry.failure?.category ? { failureCategory: entry.failure.category } : {}),
  };
}

function buildReplayBundleLogEntry(record: ReplayIncidentBundle["recoveryDispatches"][number]): ReplayTimelineEntry {
  return {
    replayId: record.replayId,
    groupId: record.taskId ?? record.replayId,
    threadId: record.threadId,
    recordedAt: record.recordedAt,
    layer: record.layer,
    status: record.status,
    summary: record.summary,
    ...(record.flowId ? { flowId: record.flowId } : {}),
    ...(record.roleId ? { roleId: record.roleId } : {}),
    ...(record.workerType ? { workerType: record.workerType } : {}),
  };
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
  if (Object.keys(payload.workflowStatusCounts).length > 0) {
    console.log(
      `  workflow status: ${Object.entries(payload.workflowStatusCounts)
        .map(([status, count]) => `${status}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(payload.caseStateCounts).length > 0) {
    console.log(
      `  case state: ${Object.entries(payload.caseStateCounts)
        .map(([state, count]) => `${state}=${count}`)
        .join(", ")}`
    );
  }
  if (Object.keys(payload.operatorCaseStateCounts).length > 0) {
    console.log(
      `  operator case state: ${Object.entries(payload.operatorCaseStateCounts)
        .map(([state, count]) => `${state}=${count}`)
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
  if (payload.latestBundles.length > 0) {
    console.log("  latest bundles:");
    for (const bundle of payload.latestBundles) {
      const parts = [
        bundle.groupId,
        `next=${describeRecoveryAction(bundle.nextAction)}`,
        `latest=${bundle.latestStatus}`,
        `auto=${bundle.autoDispatchReady ? "yes" : "no"}`,
      ];
      if (bundle.caseState) {
        parts.push(`case=${bundle.caseState}`);
      }
      if (bundle.workflowStatus) {
        parts.push(`workflow=${bundle.workflowStatus}`);
      }
      if (bundle.browserContinuityState) {
        parts.push(`browser=${bundle.browserContinuityState}`);
      }
      if (bundle.browserTransportLabel) {
        parts.push(`transport=${bundle.browserTransportLabel}`);
      }
      if (bundle.relayDiagnosticBucket) {
        parts.push(`relay=${bundle.relayDiagnosticBucket}`);
      } else if (bundle.browserDiagnosticBucket) {
        parts.push(`diag=${bundle.browserDiagnosticBucket}`);
      }
      if (bundle.operatorCaseState) {
        parts.push(`operator=${bundle.operatorCaseState}`);
      }
      if (bundle.targetLayer || bundle.targetWorker) {
        parts.push(`target=${bundle.targetLayer ?? "main"}${bundle.targetWorker ? `/${bundle.targetWorker}` : ""}`);
      }
      console.log(`    - ${parts.join("  ")}`);
      if (bundle.caseHeadline) {
        console.log(`      ${bundle.caseHeadline}`);
      }
      if (bundle.workflowSummary) {
        console.log(`      ${bundle.workflowSummary}`);
      }
      if (bundle.operatorGate || (bundle.operatorAllowedActions && bundle.operatorAllowedActions.length > 0)) {
        const operatorParts: string[] = [];
        if (bundle.operatorGate) {
          operatorParts.push(`gate=${bundle.operatorGate}`);
        }
        if (bundle.operatorAllowedActions && bundle.operatorAllowedActions.length > 0) {
          operatorParts.push(`allowed=${bundle.operatorAllowedActions.map(describeAttemptAction).join("/")}`);
        }
        console.log(`      operator: ${operatorParts.join("  ")}`);
      }
    }
  }
  if (payload.latestResolvedBundles.length > 0) {
    console.log("  latest resolved bundles:");
    for (const bundle of payload.latestResolvedBundles) {
      const parts = [
        bundle.groupId,
        `next=${describeRecoveryAction(bundle.nextAction)}`,
        `latest=${bundle.latestStatus}`,
        `auto=${bundle.autoDispatchReady ? "yes" : "no"}`,
      ];
      if (bundle.caseState) {
        parts.push(`case=${bundle.caseState}`);
      }
      if (bundle.workflowStatus) {
        parts.push(`workflow=${bundle.workflowStatus}`);
      }
      if (bundle.browserContinuityState) {
        parts.push(`browser=${bundle.browserContinuityState}`);
      }
      if (bundle.browserTransportLabel) {
        parts.push(`transport=${bundle.browserTransportLabel}`);
      }
      if (bundle.relayDiagnosticBucket) {
        parts.push(`relay=${bundle.relayDiagnosticBucket}`);
      } else if (bundle.browserDiagnosticBucket) {
        parts.push(`diag=${bundle.browserDiagnosticBucket}`);
      }
      if (bundle.operatorCaseState) {
        parts.push(`operator=${bundle.operatorCaseState}`);
      }
      console.log(`    - ${parts.join("  ")}`);
      if (bundle.caseHeadline) {
        console.log(`      ${bundle.caseHeadline}`);
      }
      if (bundle.workflowSummary) {
        console.log(`      ${bundle.workflowSummary}`);
      }
      if (bundle.operatorGate || (bundle.operatorAllowedActions && bundle.operatorAllowedActions.length > 0)) {
        const operatorParts: string[] = [];
        if (bundle.operatorGate) {
          operatorParts.push(`gate=${bundle.operatorGate}`);
        }
        if (bundle.operatorAllowedActions && bundle.operatorAllowedActions.length > 0) {
          operatorParts.push(`allowed=${bundle.operatorAllowedActions.map(describeAttemptAction).join("/")}`);
        }
        console.log(`      operator: ${operatorParts.join("  ")}`);
      }
    }
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
    area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
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
    area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
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
    area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
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
    area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
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
      area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
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

function printSoakScenarioList(payload: {
  totalScenarios: number;
  scenarios: Array<{
    scenarioId: string;
    area:
      | "dispatch"
      | "parallel"
      | "browser"
      | "recovery"
      | "context"
      | "governance"
      | "operator"
      | "observability"
      | "runtime";
    title: string;
    summary: string;
    caseIds: string[];
  }>;
}): void {
  console.log(`Soak Scenarios: ${payload.totalScenarios}`);
  for (const scenario of payload.scenarios) {
    console.log(`- ${scenario.scenarioId}  [${scenario.area}] ${scenario.title}`);
    console.log(`  ${scenario.summary}`);
    console.log(`  cases: ${scenario.caseIds.join(", ")}`);
  }
}

function printSoakRunResult(payload: {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  scenarios: Array<{
    scenarioId: string;
    area:
      | "dispatch"
      | "parallel"
      | "browser"
      | "recovery"
      | "context"
      | "governance"
      | "operator"
      | "observability"
      | "runtime";
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
      area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
      summary: string;
      status: "passed" | "failed";
      details: string[];
    }>;
  }>;
}): void {
  console.log(
    `Soak: ${payload.passedScenarios}/${payload.totalScenarios} scenarios passed, ${payload.passedCases}/${payload.totalCases} cases passed`
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

function printAcceptanceScenarioList(payload: {
  totalScenarios: number;
  scenarios: Array<{
    scenarioId: string;
    area:
      | "dispatch"
      | "parallel"
      | "browser"
      | "recovery"
      | "context"
      | "governance"
      | "operator"
      | "observability";
    title: string;
    summary: string;
    caseIds: string[];
  }>;
}): void {
  console.log(`Acceptance Scenarios: ${payload.totalScenarios}`);
  for (const scenario of payload.scenarios) {
    console.log(`- ${scenario.scenarioId}  [${scenario.area}] ${scenario.title}`);
    console.log(`  ${scenario.summary}`);
    console.log(`  cases: ${scenario.caseIds.join(", ")}`);
  }
}

function printAcceptanceRunResult(payload: {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  scenarios: Array<{
    scenarioId: string;
    area:
      | "dispatch"
      | "parallel"
      | "browser"
      | "recovery"
      | "context"
      | "governance"
      | "operator"
      | "observability";
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
      area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
      summary: string;
      status: "passed" | "failed";
      details: string[];
    }>;
  }>;
}): void {
  console.log(
    `Acceptance: ${payload.passedScenarios}/${payload.totalScenarios} scenarios passed, ${payload.passedCases}/${payload.totalCases} cases passed`
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

function printRealWorldScenarioList(payload: {
  totalScenarios: number;
  scenarios: Array<{
    scenarioId: string;
    area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
    title: string;
    summary: string;
    caseIds: string[];
  }>;
}): void {
  console.log(`Real-World Scenarios: ${payload.totalScenarios}`);
  for (const scenario of payload.scenarios) {
    console.log(`- ${scenario.scenarioId}  [${scenario.area}] ${scenario.title}`);
    console.log(`  ${scenario.summary}`);
    console.log(`  cases: ${scenario.caseIds.join(", ")}`);
  }
}

function printRealWorldRunResult(payload: {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  scenarios: Array<{
    scenarioId: string;
    area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
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
      area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
      summary: string;
      status: "passed" | "failed";
      details: string[];
    }>;
  }>;
}): void {
  console.log(
    `Real-World: ${payload.passedScenarios}/${payload.totalScenarios} scenarios passed, ${payload.passedCases}/${payload.totalCases} cases passed`
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

async function handleValidationProfileRunCommand(raw: string): Promise<void> {
  const profileId = raw.trim();
  if (!profileId) {
    console.log("usage: validation-profile-run <smoke|nightly|prerelease|weekly>");
    return;
  }

  try {
    const payload = await postJson("/validation-profiles/run", { profileId });
    printValidationProfileRunResult(
      payload as {
        profileId: "smoke" | "nightly" | "prerelease" | "weekly";
        title: string;
        summary: string;
        focusAreas: string[];
        validationSelectors: string[];
        includeReleaseReadiness: boolean;
        soakSeriesCycles?: number;
        soakSeriesSelectors?: string[];
        transportSoakCycles?: number;
        transportSoakTargets?: Array<"relay" | "direct-cdp">;
        status: "passed" | "failed";
        durationMs: number;
        totalStages: number;
        passedStages: number;
        failedStages: number;
        issues: Array<{
          issueId: string;
          kind: "validation-item" | "release-check" | "soak-suite" | "transport-target";
          stageId: "validation-run" | "release-readiness" | "soak-series" | "transport-soak";
          scope: string;
          summary: string;
        }>;
        stages: Array<
          | {
              stageId: "validation-run";
              title: string;
              status: "passed" | "failed";
              durationMs: number;
              selectors: string[];
              result: {
                totalSuites: number;
                passedSuites: number;
                failedSuites: number;
                totalItems: number;
                passedItems: number;
                failedItems: number;
                totalCases: number;
                passedCases: number;
                failedCases: number;
              };
            }
          | {
              stageId: "release-readiness";
              title: string;
              status: "passed" | "failed";
              durationMs: number;
              result: {
                totalChecks: number;
                passedChecks: number;
                failedChecks: number;
              };
            }
          | {
              stageId: "soak-series";
              title: string;
              status: "passed" | "failed";
              durationMs: number;
              cycles: number;
              selectors: string[];
              result: {
                totalCycles: number;
                passedCycles: number;
                failedCycles: number;
                totalCases: number;
                failedCases: number;
              };
            }
          | {
              stageId: "transport-soak";
              title: string;
              status: "passed" | "failed";
              durationMs: number;
              cycles: number;
              targets: Array<"relay" | "direct-cdp">;
              result: {
                totalCycles: number;
                passedCycles: number;
                failedCycles: number;
                totalTargetRuns: number;
                failedTargetRuns: number;
              };
            }
        >;
      }
    );
  } catch (error) {
    console.log(`validation profile failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function printValidationSuiteList(payload: {
  totalSuites: number;
  totalItems: number;
  suites: Array<{
    suiteId: "regression" | "soak" | "failure" | "acceptance" | "realworld";
    title: string;
    summary: string;
    totalItems: number;
    items: Array<{
      suiteId: "regression" | "soak" | "failure" | "acceptance" | "realworld";
      itemId: string;
      area: string;
      title: string;
      summary: string;
      caseIds?: string[];
    }>;
  }>;
}): void {
  console.log(`Validation Suites: ${payload.totalSuites} suites, ${payload.totalItems} items`);
  for (const suite of payload.suites) {
    console.log(`- ${suite.suiteId}  ${suite.title}  items=${suite.totalItems}`);
    console.log(`  ${suite.summary}`);
    for (const item of suite.items) {
      const selector = `${suite.suiteId}:${item.itemId}`;
      console.log(`  - ${selector}  [${item.area}] ${item.title}`);
      console.log(`    ${item.summary}`);
      if (item.caseIds && item.caseIds.length > 0) {
        console.log(`    cases: ${item.caseIds.join(", ")}`);
      }
    }
  }
}

function printValidationProfileList(payload: {
  totalProfiles: number;
  profiles: Array<{
    profileId: "smoke" | "nightly" | "prerelease" | "weekly";
    title: string;
    summary: string;
    focusAreas: string[];
    validationSelectors: string[];
    includeReleaseReadiness: boolean;
    soakSeriesCycles?: number;
    soakSeriesSelectors?: string[];
    transportSoakCycles?: number;
    transportSoakTargets?: Array<"relay" | "direct-cdp">;
  }>;
}): void {
  console.log(`Validation Profiles: ${payload.totalProfiles}`);
  for (const profile of payload.profiles) {
    console.log(`- ${profile.profileId}  ${profile.title}`);
    console.log(`  ${profile.summary}`);
    console.log(`  focus: ${profile.focusAreas.join(", ")}`);
    console.log(`  validation selectors: ${profile.validationSelectors.join(", ")}`);
    console.log(`  release readiness: ${profile.includeReleaseReadiness ? "yes" : "no"}`);
    if (profile.soakSeriesCycles && profile.soakSeriesCycles > 0) {
      console.log(
        `  soak series: cycles=${profile.soakSeriesCycles} selectors=${(profile.soakSeriesSelectors ?? []).join(", ")}`
      );
    }
    if (profile.transportSoakCycles && profile.transportSoakCycles > 0) {
      console.log(
        `  transport soak: cycles=${profile.transportSoakCycles} targets=${(profile.transportSoakTargets ?? []).join(", ")}`
      );
    }
  }
}

function printValidationRunResult(payload: {
  totalSuites: number;
  passedSuites: number;
  failedSuites: number;
  totalItems: number;
  passedItems: number;
  failedItems: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  suites: Array<{
    suiteId: "regression" | "soak" | "failure" | "acceptance" | "realworld";
    title: string;
    summary: string;
    totalItems: number;
    passedItems: number;
    failedItems: number;
    totalCases: number;
    passedCases: number;
    failedCases: number;
    items: Array<{
      suiteId: "regression" | "soak" | "failure" | "acceptance" | "realworld";
      itemId: string;
      area: string;
      title: string;
      summary: string;
      status: "passed" | "failed";
      totalCases: number;
      passedCases: number;
      failedCases: number;
      caseResults: Array<{
        caseId: string;
        title: string;
        area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
        summary: string;
        status: "passed" | "failed";
        details: string[];
      }>;
    }>;
  }>;
}): void {
  console.log(
    `Validation: suites=${payload.passedSuites}/${payload.totalSuites}  items=${payload.passedItems}/${payload.totalItems}  cases=${payload.passedCases}/${payload.totalCases}`
  );
  for (const suite of payload.suites) {
    console.log(
      `- ${suite.suiteId}  ${suite.title}  status=${suite.failedItems === 0 ? "passed" : "failed"}  items=${suite.passedItems}/${suite.totalItems}  cases=${suite.passedCases}/${suite.totalCases}`
    );
    console.log(`  ${suite.summary}`);
    for (const item of suite.items) {
      console.log(
        `  - ${suite.suiteId}:${item.itemId}  [${item.area}] ${item.title}  status=${item.status}  cases=${item.passedCases}/${item.totalCases}`
      );
      console.log(`    ${item.summary}`);
      for (const result of item.caseResults) {
        console.log(`    - ${result.caseId}  status=${result.status}`);
        for (const detail of result.details) {
          console.log(`      ${detail}`);
        }
      }
    }
  }
}

function printValidationProfileRunResult(payload: {
  profileId: "smoke" | "nightly" | "prerelease" | "weekly";
  title: string;
  summary: string;
  focusAreas: string[];
  validationSelectors: string[];
  includeReleaseReadiness: boolean;
  soakSeriesCycles?: number;
  soakSeriesSelectors?: string[];
  transportSoakCycles?: number;
  transportSoakTargets?: Array<"relay" | "direct-cdp">;
  status: "passed" | "failed";
  durationMs: number;
  totalStages: number;
  passedStages: number;
  failedStages: number;
  issues: Array<{
    issueId: string;
    kind: "validation-item" | "release-check" | "soak-suite" | "transport-target";
    stageId: "validation-run" | "release-readiness" | "soak-series" | "transport-soak";
    scope: string;
    summary: string;
  }>;
  stages: Array<
    | {
        stageId: "validation-run";
        title: string;
        status: "passed" | "failed";
        durationMs: number;
        selectors: string[];
        result: {
          totalSuites: number;
          passedSuites: number;
          failedSuites: number;
          totalItems: number;
          passedItems: number;
          failedItems: number;
          totalCases: number;
          passedCases: number;
          failedCases: number;
        };
      }
    | {
        stageId: "release-readiness";
        title: string;
        status: "passed" | "failed";
        durationMs: number;
        result: {
          totalChecks: number;
          passedChecks: number;
          failedChecks: number;
        };
      }
    | {
        stageId: "soak-series";
        title: string;
        status: "passed" | "failed";
        durationMs: number;
        cycles: number;
        selectors: string[];
        result: {
          totalCycles: number;
          passedCycles: number;
          failedCycles: number;
          totalCases: number;
          failedCases: number;
        };
      }
    | {
        stageId: "transport-soak";
        title: string;
        status: "passed" | "failed";
        durationMs: number;
        cycles: number;
        targets: Array<"relay" | "direct-cdp">;
        result: {
          totalCycles: number;
          passedCycles: number;
          failedCycles: number;
          totalTargetRuns: number;
          failedTargetRuns: number;
        };
      }
  >;
}): void {
  console.log(
    `Validation profile: ${payload.profileId}  status=${payload.status}  stages=${payload.passedStages}/${payload.totalStages}  issues=${payload.issues.length}  durationMs=${payload.durationMs}`
  );
  console.log(`  ${payload.title}`);
  console.log(`  ${payload.summary}`);
  console.log(`  focus: ${payload.focusAreas.join(", ")}`);
  for (const stage of payload.stages) {
    if (stage.stageId === "validation-run") {
      console.log(
        `- validation-run  status=${stage.status}  suites=${stage.result.passedSuites}/${stage.result.totalSuites}  items=${stage.result.passedItems}/${stage.result.totalItems}  cases=${stage.result.passedCases}/${stage.result.totalCases}  durationMs=${stage.durationMs}`
      );
      console.log(`  selectors: ${stage.selectors.join(", ")}`);
      continue;
    }
    if (stage.stageId === "release-readiness") {
      console.log(
        `- release-readiness  status=${stage.status}  checks=${stage.result.passedChecks}/${stage.result.totalChecks}  durationMs=${stage.durationMs}`
      );
      continue;
    }
    if (stage.stageId === "soak-series") {
      console.log(
        `- soak-series  status=${stage.status}  cycles=${stage.result.passedCycles}/${stage.result.totalCycles}  cases=${stage.result.totalCases - stage.result.failedCases}/${stage.result.totalCases}  durationMs=${stage.durationMs}`
      );
      console.log(`  selectors: ${stage.selectors.join(", ")}`);
      continue;
    }
    console.log(
      `- transport-soak  status=${stage.status}  cycles=${stage.result.passedCycles}/${stage.result.totalCycles}  targetRuns=${stage.result.totalTargetRuns - stage.result.failedTargetRuns}/${stage.result.totalTargetRuns}  durationMs=${stage.durationMs}`
    );
    console.log(`  targets: ${stage.targets.join(", ")}`);
  }
  if (payload.issues.length > 0) {
    console.log("Issues:");
    for (const issue of payload.issues) {
      console.log(`- ${issue.stageId}  ${issue.kind}  ${issue.scope}`);
      console.log(`  ${issue.summary}`);
    }
  }
}

function printValidationSoakSeriesResult(payload: {
  status: "passed" | "failed";
  selectors: string[];
  totalCycles: number;
  passedCycles: number;
  failedCycles: number;
  totalSuites: number;
  failedSuites: number;
  totalItems: number;
  failedItems: number;
  totalCases: number;
  failedCases: number;
  durationMs: number;
  cycles: Array<{
    cycleNumber: number;
    status: "passed" | "failed";
    durationMs: number;
    totalSuites: number;
    failedSuites: number;
    totalItems: number;
    failedItems: number;
    totalCases: number;
    failedCases: number;
    suites: Array<{
      suiteId: "regression" | "soak" | "failure" | "acceptance" | "realworld";
      status: "passed" | "failed";
      totalItems: number;
      failedItems: number;
      totalCases: number;
      failedCases: number;
    }>;
  }>;
  suiteAggregates: Array<{
    suiteId: "regression" | "soak" | "failure" | "acceptance" | "realworld";
    cycles: number;
    failedCycles: number;
    totalItems: number;
    failedItems: number;
    totalCases: number;
    failedCases: number;
  }>;
}): void {
  console.log(
    `Validation soak series: status=${payload.status} cycles=${payload.passedCycles}/${payload.totalCycles} cases=${payload.totalCases - payload.failedCases}/${payload.totalCases} durationMs=${payload.durationMs}`
  );
  console.log(`selectors: ${payload.selectors.join(", ")}`);
  for (const cycle of payload.cycles) {
    console.log(
      `- cycle=${cycle.cycleNumber} status=${cycle.status} suites=${cycle.totalSuites} items=${cycle.totalItems} cases=${cycle.totalCases} failedCases=${cycle.failedCases} durationMs=${cycle.durationMs}`
    );
    for (const suite of cycle.suites) {
      console.log(
        `  ${suite.suiteId}  status=${suite.status}  items=${suite.totalItems} failedItems=${suite.failedItems}  cases=${suite.totalCases} failedCases=${suite.failedCases}`
      );
    }
  }
  console.log("Suite aggregates:");
  for (const suite of payload.suiteAggregates) {
    console.log(
      `- ${suite.suiteId}  cycles=${suite.cycles} failedCycles=${suite.failedCycles} items=${suite.totalItems} failedItems=${suite.failedItems} cases=${suite.totalCases} failedCases=${suite.failedCases}`
    );
  }
}

function printReleaseReadinessResult(payload: {
  status: "passed" | "failed";
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  artifact: {
    filename: string;
    packageSize?: number;
    unpackedSize?: number;
    shasum?: string;
    integrity?: string;
    totalFiles?: number;
  } | null;
  checks: Array<{
    checkId: string;
    title: string;
    status: "passed" | "failed";
    details: string[];
  }>;
}): void {
  console.log(`Release readiness: ${payload.status} checks=${payload.passedChecks}/${payload.totalChecks}`);
  if (payload.artifact) {
    console.log(
      `Artifact: ${payload.artifact.filename} files=${payload.artifact.totalFiles ?? 0} packageSize=${payload.artifact.packageSize ?? 0} unpackedSize=${payload.artifact.unpackedSize ?? 0}`
    );
  }
  for (const check of payload.checks) {
    console.log(`- ${check.checkId}  ${check.title}  status=${check.status}`);
    for (const detail of check.details) {
      console.log(`  ${detail}`);
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
  return describeRecoveryRunGate(run.status);
}
