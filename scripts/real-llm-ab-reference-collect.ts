import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ACCIO_WORK_REFERENCE_APP = "accio-work-app-asar";
const ACCIO_WORK_APP_ASAR_PATH = "/Applications/Accio.app/Contents/Resources/app.asar";
const ACCIO_WORK_REFERENCE_RUNTIME_ROOT = "artifacts/reference-runtimes/accio-work-0.4.5";
const ACCIO_WORK_REFERENCE_VERSION = "0.4.5";

type ReferenceCollectionAction = "collect_reference_artifact" | "recollect_reference_artifact";

interface ReferenceCollectionTaskManifest {
  kind?: unknown;
  suite?: unknown;
  naturalReportPath?: unknown;
  tasks?: unknown;
}

interface ReferenceCollectionTask {
  scenarioId: string;
  prompt: string;
  expectedReferenceArtifactPath: string;
  action: ReferenceCollectionAction;
}

interface ReferenceCollectOptions {
  tasksPath: string;
  baseUrl: string;
  referenceToken?: string;
  variant: string;
  accioWs?: boolean;
  accioAgentId?: string;
  accioWorkspacePath?: string;
  timeoutMs: number;
  pollMs: number;
  referenceApp: string;
  referenceBinary?: string;
  referenceRepoPath?: string;
  referenceRuntimeRoot?: string;
  referenceVersion?: string;
  referenceCommit?: string;
  check: boolean;
}

interface ReferenceCollectedArtifact {
  system: "reference";
  prompt: string;
  threadId?: string;
  missionId?: string;
  durationMs: number;
  timedOut: boolean;
  provenance: Record<string, unknown>;
  rawResponse: unknown;
  rawTranscript: unknown;
  rawToolCalls: unknown[];
  rawToolResults: unknown[];
  rawBrowserEvidence: unknown[];
  rawMemoryEvidence: unknown[];
  rawFlowEvidence: unknown[];
  rawApprovalEvidence: unknown[];
  rawCancellationEvidence?: unknown[];
  rawMemoryEvidence?: unknown[];
  artifactAdapterMappingSource: string;
  collectedAtMs: number;
  exitStatus: "success" | "timeout" | "error";
  errorReason: string;
  first: {
    summary: {
      toolCallCount: number;
      toolResultCount: number;
      pendingToolCount: number;
      finalText: string;
    };
  };
  followup?: {
    summary: {
      toolCallCount: number;
      toolResultCount: number;
      pendingToolCount: number;
      finalText: string;
    };
  };
  score: {
    useful: boolean;
    weak: boolean;
  };
}

type ReferenceApprovalDecisionPolicy = "approved" | "denied" | "pending" | "wait_timeout";

export interface ReferenceScenarioDriver {
  kind:
    | "single_prompt"
    | "mission_prompt"
    | "memory_thread"
    | "memory_pressure_flush"
    | "memory_invalidation"
    | "tool_result_pruning"
    | "followup_thread"
    | "timeout_partial"
    | "timeout_followup"
    | "cancel_active"
    | "cancel_followup";
  supported: boolean;
  missionThread: boolean;
  missionMode: string;
  approvalDecisionPolicy?: ReferenceApprovalDecisionPolicy;
  unsupportedReason?: string;
  envRequirements?: Record<string, string>;
}

interface ReferenceCollectReport {
  kind: "turnkeyai.real-llm-ab-reference-collect.report";
  status: "passed" | "failed";
  generatedAtMs: number;
  tasksPath: string;
  baseUrl: string;
  taskCount: number;
  collected: number;
  failed: number;
  artifacts: Array<{
    scenarioId: string;
    artifactPath: string;
    exitStatus: ReferenceCollectedArtifact["exitStatus"];
    errorReason: string;
    toolCallCount: number;
    toolResultCount: number;
    browserEvidenceCount: number;
  }>;
}

export function parseRealLlmAbReferenceCollectArgs(args: string[]): ReferenceCollectOptions | { help: true } {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    return { help: true };
  }
  let tasksPath: string | undefined;
  let baseUrl: string | undefined;
  let referenceToken: string | undefined;
  let variant = "operator";
  let accioWs = false;
  let accioAgentId: string | undefined;
  let accioWorkspacePath: string | undefined;
  let timeoutMs = 180_000;
  let pollMs = 2_000;
  let referenceApp = "reference-workbench";
  let referenceBinary: string | undefined;
  let referenceRepoPath: string | undefined;
  let referenceRuntimeRoot: string | undefined;
  let referenceVersion: string | undefined;
  let referenceCommit: string | undefined;
  let referenceAppExplicit = false;
  let referenceBinaryExplicit = false;
  let referenceRuntimeRootExplicit = false;
  let referenceCommitExplicit = false;
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tasks") {
      tasksPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--base-url") {
      baseUrl = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-token") {
      referenceToken = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--variant") {
      variant = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--accio-ws") {
      accioWs = true;
      continue;
    }
    if (arg === "--accio-agent-id") {
      accioAgentId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--accio-workspace-path") {
      accioWorkspacePath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = readPositiveInteger(readValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--poll-ms") {
      pollMs = readPositiveInteger(readValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-app") {
      referenceApp = readValue(args, index, arg);
      referenceAppExplicit = true;
      index += 1;
      continue;
    }
    if (arg === "--reference-binary") {
      referenceBinary = readValue(args, index, arg);
      referenceBinaryExplicit = true;
      index += 1;
      continue;
    }
    if (arg === "--reference-repo-path") {
      referenceRepoPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-runtime-root") {
      referenceRuntimeRoot = readValue(args, index, arg);
      referenceRuntimeRootExplicit = true;
      index += 1;
      continue;
    }
    if (arg === "--reference-version") {
      referenceVersion = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-commit") {
      referenceCommit = readValue(args, index, arg);
      referenceCommitExplicit = true;
      index += 1;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!tasksPath) throw new Error("missing required --tasks <path>");
  if (!baseUrl) throw new Error("missing required --base-url <url>");
  const resolvedReferenceApp = accioWs && !referenceAppExplicit ? ACCIO_WORK_REFERENCE_APP : referenceApp;
  const resolvedReferenceBinary =
    accioWs && !referenceBinaryExplicit ? ACCIO_WORK_APP_ASAR_PATH : referenceBinary;
  const resolvedReferenceRuntimeRoot =
    accioWs && !referenceRuntimeRootExplicit
      ? path.resolve(ACCIO_WORK_REFERENCE_RUNTIME_ROOT)
      : referenceRuntimeRoot
        ? path.resolve(referenceRuntimeRoot)
        : undefined;
  const resolvedReferenceVersion = accioWs && !referenceVersion ? ACCIO_WORK_REFERENCE_VERSION : referenceVersion;
  const resolvedReferenceCommit =
    accioWs && !referenceCommitExplicit ? readAccioWorkAppAsarCommit() : referenceCommit;
  return {
    tasksPath,
    baseUrl,
    ...(referenceToken ? { referenceToken } : {}),
    variant,
    ...(accioWs ? { accioWs } : {}),
    ...(accioAgentId ? { accioAgentId } : {}),
    ...(accioWs || accioWorkspacePath ? { accioWorkspacePath: accioWorkspacePath ?? process.cwd() } : {}),
    timeoutMs,
    pollMs,
    referenceApp: resolvedReferenceApp,
    ...(resolvedReferenceBinary ? { referenceBinary: resolvedReferenceBinary } : {}),
    ...(referenceRepoPath ? { referenceRepoPath } : {}),
    ...(resolvedReferenceRuntimeRoot ? { referenceRuntimeRoot: resolvedReferenceRuntimeRoot } : {}),
    ...(resolvedReferenceVersion ? { referenceVersion: resolvedReferenceVersion } : {}),
    ...(resolvedReferenceCommit ? { referenceCommit: resolvedReferenceCommit } : {}),
    check,
  };
}

function readAccioWorkAppAsarCommit(): string | undefined {
  if (!existsSync(ACCIO_WORK_APP_ASAR_PATH)) return undefined;
  const hash = createHash("sha256").update(readFileSync(ACCIO_WORK_APP_ASAR_PATH)).digest("hex");
  return `app.asar:${hash}`;
}

export function buildRealLlmAbReferenceCollectHelpText(): string {
  return [
    "TurnkeyAI real LLM A/B reference artifact collector",
    "",
    "Usage:",
    "  npm run acceptance:ab:reference-collect -- --tasks <task-manifest.json> --base-url <reference-daemon-url> [--reference-token <token>] [--variant operator] [--timeout-ms 180000] [--poll-ms 2000] [--reference-repo-path <path>] [--reference-runtime-root <path>] [--reference-version <version>] [--check]",
    "  npm run acceptance:ab:reference-collect -- --tasks <task-manifest.json> --base-url http://127.0.0.1:4097 --accio-ws [--accio-agent-id DID-...] [--accio-workspace-path <path>] --reference-runtime-root artifacts/reference-runtimes/accio-work-0.4.5 [--check]",
    "",
    "The collector sends each natural prompt to a compatible reference daemon and writes provenance-complete artifacts to each task's expectedReferenceArtifactPath.",
    "The reference audit remains responsible for deciding whether collected artifacts are valid comparison evidence.",
  ].join("\n");
}

export async function runRealLlmAbReferenceCollectCli(args: string[]): Promise<void> {
  const options = parseRealLlmAbReferenceCollectArgs(args);
  if ("help" in options) {
    console.log(buildRealLlmAbReferenceCollectHelpText());
    return;
  }
  const report = await collectReferenceArtifacts(options);
  console.log(
    `reference collection complete: collected=${report.collected} failed=${report.failed} tasks=${report.taskCount}`
  );
  for (const artifact of report.artifacts) {
    console.log(`- ${artifact.scenarioId}: ${artifact.exitStatus} ${artifact.artifactPath}`);
  }
  if (options.check && report.status !== "passed") {
    process.exitCode = 1;
  }
}

export async function collectReferenceArtifacts(options: ReferenceCollectOptions): Promise<ReferenceCollectReport> {
  const tasksPath = path.resolve(options.tasksPath);
  const manifest = readJsonFile<ReferenceCollectionTaskManifest>(tasksPath);
  const tasks = readCollectionTasks(manifest);
  const naturalFixtureHashes = readNaturalFixtureContentHashes(manifest, path.dirname(tasksPath));
  const artifacts: ReferenceCollectReport["artifacts"] = [];
  for (const task of tasks) {
    const artifactPath = path.resolve(path.dirname(tasksPath), task.expectedReferenceArtifactPath);
    const artifact = await collectOneReferenceArtifact({
      task,
      artifactPath,
      options,
      fixtureContentHashes: selectFixtureContentHashesForPrompt(task.prompt, naturalFixtureHashes),
    });
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    artifacts.push({
      scenarioId: task.scenarioId,
      artifactPath,
      exitStatus: artifact.exitStatus,
      errorReason: artifact.errorReason,
      toolCallCount: artifact.first.summary.toolCallCount,
      toolResultCount: artifact.first.summary.toolResultCount,
      browserEvidenceCount: artifact.rawBrowserEvidence.length,
    });
  }
  const failed = artifacts.filter((artifact) => artifact.exitStatus !== "success").length;
  return {
    kind: "turnkeyai.real-llm-ab-reference-collect.report",
    status: failed === 0 ? "passed" : "failed",
    generatedAtMs: Date.now(),
    tasksPath,
    baseUrl: normalizeBaseUrl(options.baseUrl),
    taskCount: tasks.length,
    collected: artifacts.length - failed,
    failed,
    artifacts,
  };
}

async function collectOneReferenceArtifact(input: {
  task: ReferenceCollectionTask;
  artifactPath: string;
  options: ReferenceCollectOptions;
  fixtureContentHashes: Record<string, string>;
}): Promise<ReferenceCollectedArtifact> {
  const startedAt = Date.now();
  const collectedAtMs = Date.now();
  const baseUrl = normalizeBaseUrl(input.options.baseUrl);
  const requestAuth = buildReferenceRequestAuth(input.options.referenceToken);
  const scenarioDriver = referenceScenarioDriverFor(input.task.scenarioId);
  const accioWsUnsupportedReason = input.options.accioWs ? unsupportedAccioWsScenarioReason(scenarioDriver) : null;
  if (accioWsUnsupportedReason) {
    return buildUnsupportedReferenceArtifact({
      task: input.task,
      options: input.options,
      fixtureContentHashes: input.fixtureContentHashes,
      baseUrl,
      scenarioDriver: unsupportedScenarioDriver(
        scenarioDriver.kind,
        accioWsUnsupportedReason,
        scenarioDriver.envRequirements
      ),
      startedAt,
      collectedAtMs,
    });
  }
  if (!scenarioDriver.supported) {
    return buildUnsupportedReferenceArtifact({
      task: input.task,
      options: input.options,
      fixtureContentHashes: input.fixtureContentHashes,
      baseUrl,
      scenarioDriver,
      startedAt,
      collectedAtMs,
    });
  }
  let exactRequestPayload: Record<string, unknown> = { threadId: "", content: input.task.prompt };
  let apiEndpoint = "/messages";
  let threadId: string | undefined;
  let missionId: string | undefined;
  let rawResponse: unknown = null;
  let rawTranscript: unknown = null;
  let rawToolCalls: unknown[] = [];
  let rawToolResults: unknown[] = [];
  let rawBrowserEvidence: unknown[] = [];
  let rawFlowEvidence: unknown[] = [];
  let rawApprovalEvidence: unknown[] = [];
  let rawCancellationEvidence: unknown[] = [];
  let rawMemoryEvidence: unknown[] = [];
  let loopbackFixtureProbe: LoopbackFixtureProbeResult | undefined;
  let followupSummary: ReferenceCollectedArtifact["followup"];
  let firstSummaryToolCallCount = 0;
  let firstSummaryToolResultCount = 0;
  let finalText = "";
  let finalTextForScoring = "";
  let modelCatalog: unknown = null;
  let provider = "unknown";
  let modelId = "unknown";
  let exitStatus: ReferenceCollectedArtifact["exitStatus"] = "error";
  let errorReason = "unknown";
  let timedOut = false;
  try {
    modelCatalog = await readReferenceModelCatalog(baseUrl, requestAuth);
    const modelInfo = inferReferenceModelInfo(modelCatalog);
    provider = modelInfo.provider;
    modelId = modelInfo.modelId;
    if (input.options.accioWs) {
      loopbackFixtureProbe = await probeLoopbackFixturesForAccioWsPrompt(input.task.prompt, input.task.scenarioId);
      if (loopbackFixtureProbe.unreachable.length > 0) {
        return buildFixtureUnavailableReferenceArtifact({
          task: input.task,
          options: input.options,
          fixtureContentHashes: input.fixtureContentHashes,
          baseUrl,
          scenarioDriver,
          startedAt,
          collectedAtMs,
          modelCatalog,
          provider,
          modelId,
          probe: loopbackFixtureProbe,
        });
      }
    }
    if (input.options.accioWs) {
      const accioResult = scenarioDriver.kind === "memory_thread"
        ? await driveAccioWsMemoryRecallReferenceScenario({
            task: input.task,
            options: input.options,
            baseUrl,
            modelCatalog,
            modelInfo,
          })
        : scenarioDriver.kind === "followup_thread" || scenarioDriver.kind === "timeout_followup"
          ? await driveAccioWsFollowupReferenceScenario({
              task: input.task,
              options: input.options,
              baseUrl,
              modelCatalog,
              modelInfo,
            })
        : await driveAccioWsReferenceScenario({
        task: input.task,
        options: input.options,
        baseUrl,
        modelCatalog,
        modelInfo,
      });
      exactRequestPayload = accioResult.exactRequestPayload;
      apiEndpoint = accioResult.apiEndpoint;
      rawResponse = accioResult.rawResponse;
      threadId = accioResult.threadId;
      rawTranscript = accioResult.rawTranscript;
      rawToolCalls = accioResult.rawToolCalls;
      rawToolResults = accioResult.rawToolResults;
      rawBrowserEvidence = accioResult.rawBrowserEvidence;
      rawMemoryEvidence = accioResult.rawMemoryEvidence ?? [];
      rawFlowEvidence = accioResult.rawFlowEvidence;
      finalText = accioResult.finalText;
      timedOut = accioResult.timedOut;
      firstSummaryToolCallCount = accioResult.firstSummaryToolCallCount;
      firstSummaryToolResultCount = accioResult.firstSummaryToolResultCount;
      followupSummary = accioResult.followupSummary;
    } else if (
      scenarioDriver.kind === "memory_thread" ||
      scenarioDriver.kind === "memory_pressure_flush" ||
      scenarioDriver.kind === "memory_invalidation"
    ) {
      const memoryResult = await driveReferenceMemoryScenario({
        task: input.task,
        options: input.options,
        scenarioDriver,
        baseUrl,
        requestAuth,
        startedAt,
      });
      exactRequestPayload = memoryResult.exactRequestPayload;
      apiEndpoint = memoryResult.apiEndpoint;
      rawResponse = memoryResult.rawResponse;
      threadId = memoryResult.threadId;
      missionId = memoryResult.missionId;
      rawTranscript = memoryResult.rawTranscript;
      rawToolCalls = memoryResult.rawToolCalls;
      rawToolResults = memoryResult.rawToolResults;
      rawMemoryEvidence = memoryResult.rawMemoryEvidence;
      finalText = memoryResult.finalText;
      timedOut = memoryResult.timedOut;
      firstSummaryToolCallCount = memoryResult.firstSummaryToolCallCount;
      firstSummaryToolResultCount = memoryResult.firstSummaryToolResultCount;
    } else if (scenarioDriver.missionThread) {
      apiEndpoint = "/missions";
      exactRequestPayload = {
        title: input.task.prompt,
        desc: "",
        mode: scenarioDriver.missionMode,
        owner: "reference-collector",
        ownerLabel: "Reference Collector",
      };
      rawResponse = await postJson(baseUrl, apiEndpoint, exactRequestPayload, requestAuth, {
        timeoutMs: Math.min(input.options.timeoutMs, 30_000),
      });
      threadId = readThreadId(rawResponse);
      missionId = readString((rawResponse as { id?: unknown } | null)?.id) ?? undefined;
      if (!threadId) throw new Error("mission creation response did not include threadId");
      if (missionId && (scenarioDriver.kind === "cancel_active" || scenarioDriver.kind === "cancel_followup")) {
        rawCancellationEvidence = await driveReferenceActiveCancellation({
          baseUrl,
          missionId,
          threadId,
          startedAt,
          timeoutMs: input.options.timeoutMs,
          pollMs: input.options.pollMs,
          requestAuth,
        });
      }
    } else {
      const bootstrap = await postJson(baseUrl, "/threads/bootstrap-demo", { variant: input.options.variant }, requestAuth);
      threadId = readThreadId(bootstrap);
      if (!threadId) throw new Error("bootstrap response did not include thread.threadId");
      exactRequestPayload.threadId = threadId;
      try {
        rawResponse = await postJson(baseUrl, apiEndpoint, exactRequestPayload, requestAuth, {
          timeoutMs: Math.min(input.options.timeoutMs, 30_000),
        });
      } catch (error) {
        rawResponse = {
          status: "post_failed_polling_thread",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (
      !input.options.accioWs &&
      scenarioDriver.kind !== "memory_pressure_flush" &&
      scenarioDriver.kind !== "memory_invalidation"
    ) {
      const pollResult = await pollReferenceMessages({
        baseUrl,
        threadId,
        startedAt,
        timeoutMs:
          (scenarioDriver.kind === "cancel_active" || scenarioDriver.kind === "cancel_followup") &&
          rawCancellationEvidence.length > 0
            ? Math.min(input.options.timeoutMs, 5_000)
            : input.options.timeoutMs,
        pollMs: input.options.pollMs,
        requestAuth,
        ...(missionId && scenarioDriver.approvalDecisionPolicy
          ? { approvalDriver: { missionId, policy: scenarioDriver.approvalDecisionPolicy } }
          : {}),
      });
      rawTranscript = pollResult.messages;
      rawApprovalEvidence = pollResult.approvalEvidence;
      timedOut = pollResult.timedOut;
      finalText = pollResult.finalText;
      if (!finalText && scenarioDriver.approvalDecisionPolicy === "pending") {
        finalText = buildPendingApprovalPausedStateSummary(rawApprovalEvidence);
      }
      if (!finalText && (scenarioDriver.kind === "cancel_active" || scenarioDriver.kind === "cancel_followup")) {
        finalText = buildActiveCancellationCloseoutSummary(rawCancellationEvidence);
      }
      if (
        timedOut &&
        (scenarioDriver.kind === "cancel_active" || scenarioDriver.kind === "cancel_followup") &&
        finalText
      ) {
        timedOut = false;
      }
      const firstPhaseToolCalls = dedupeReferenceToolCalls([
        ...extractToolCalls(pollResult.messages),
        ...extractToolCallsFromCancellationEvidence(rawCancellationEvidence),
      ]);
      const firstPhaseToolResults = [
        ...extractToolResults(pollResult.messages),
        ...extractToolResultsFromCancellationEvidence(rawCancellationEvidence),
      ];
      rawToolCalls = firstPhaseToolCalls;
      rawToolResults = firstPhaseToolResults;
      firstSummaryToolCallCount = firstPhaseToolCalls.length;
      firstSummaryToolResultCount = firstPhaseToolResults.length;

      if (missionId && (scenarioDriver.kind === "cancel_followup" || scenarioDriver.kind === "timeout_followup")) {
        const followupPrompt =
          scenarioDriver.kind === "timeout_followup"
            ? buildReferenceTimeoutFollowupPrompt(input.task.prompt)
            : buildReferenceCancelFollowupPrompt();
        const followupPayload = { content: followupPrompt };
        const followupResponse = await postJson(
          baseUrl,
          `/missions/${encodeURIComponent(missionId)}/messages`,
          followupPayload,
          requestAuth,
          {
            timeoutMs: Math.min(input.options.timeoutMs, 30_000),
          }
        );
        rawResponse = {
          mission: rawResponse,
          followup: followupResponse,
        };
        exactRequestPayload = {
          ...exactRequestPayload,
          followup: followupPayload,
        };
        const followupStartedAt = Date.now();
        const followupPollResult = await pollReferenceMessages({
          baseUrl,
          threadId,
          startedAt: followupStartedAt,
          timeoutMs: input.options.timeoutMs,
          pollMs: input.options.pollMs,
          requestAuth,
          afterUserContent: followupPrompt,
        });
        const followupMessages = sliceMessagesAfterUserContent(followupPollResult.messages, followupPrompt);
        const followupToolCalls = dedupeReferenceToolCalls(extractToolCalls(followupMessages));
        const followupToolResults = extractToolResults(followupMessages);
        rawTranscript = followupPollResult.messages;
        rawToolCalls = dedupeReferenceToolCalls([...rawToolCalls, ...followupToolCalls]);
        rawToolResults = [...rawToolResults, ...followupToolResults];
        timedOut = followupPollResult.timedOut && !followupPollResult.finalText;
        if (followupPollResult.finalText) {
          followupSummary = {
            summary: {
              toolCallCount: followupToolCalls.length,
              toolResultCount: followupToolResults.length,
              pendingToolCount: readPendingReferenceToolCalls(followupMessages).length,
              finalText: followupPollResult.finalText,
            },
          };
        }
      }
    }

    if (!input.options.accioWs) {
      rawBrowserEvidence = [
        ...(await readBrowserEvidence(baseUrl, threadId, requestAuth)),
        ...extractBrowserEvidenceFromTranscript(Array.isArray(rawTranscript) ? rawTranscript : []),
      ];
      rawFlowEvidence = [
        ...(await readFlowEvidence(baseUrl, threadId, requestAuth)),
        ...rawCancellationEvidence,
        ...rawMemoryEvidence,
      ];
    }
    finalTextForScoring = followupSummary?.summary.finalText ?? finalText;
    exitStatus = timedOut ? "timeout" : finalTextForScoring ? "success" : "error";
    errorReason = timedOut
      ? "timeout waiting for assistant response"
      : finalTextForScoring
        ? "none"
        : "no assistant response";
  } catch (error) {
    exitStatus = "error";
    errorReason = error instanceof Error ? error.message : String(error);
  }
  finalTextForScoring = followupSummary?.summary.finalText ?? finalText;
  const durationMs = Date.now() - startedAt;
  const pendingApprovalPausedState =
    scenarioDriver.approvalDecisionPolicy === "pending" &&
    (hasObservedPendingApprovalEvidence(rawApprovalEvidence) ||
      isExpectedPendingApprovalFinal(finalTextForScoring));
  const approvalWaitTimeoutCloseout =
    scenarioDriver.approvalDecisionPolicy === "wait_timeout" &&
    hasObservedPendingApprovalEvidence(rawApprovalEvidence) &&
    hasApprovalWaitTimeoutCloseoutEvidence([finalText, rawToolResults, rawTranscript]);
  const activeCancellationCloseout =
    scenarioDriver.kind === "cancel_active" && hasReferenceActiveCancellationEvidence(rawCancellationEvidence);
  const cancelFollowupContinuation =
    scenarioDriver.kind === "cancel_followup" &&
    hasReferenceActiveCancellationEvidence(rawCancellationEvidence) &&
    Boolean(followupSummary?.summary.finalText);
  const weak = pendingApprovalPausedState || approvalWaitTimeoutCloseout || activeCancellationCloseout
    ? false
    : isWeakReferenceAnswer(finalTextForScoring);
  const useful =
    exitStatus === "success" &&
    finalTextForScoring.trim().length >= 80 &&
    (!weak || pendingApprovalPausedState || approvalWaitTimeoutCloseout || activeCancellationCloseout || cancelFollowupContinuation);
  const referenceRepoPath = resolveReferenceRepoPath(input.options);
  const provenance = {
    referenceApp: input.options.referenceApp,
    referenceBinary: input.options.referenceBinary ?? "unknown",
    referenceRepoPath,
    ...(input.options.referenceRuntimeRoot ? { referenceRuntimeRoot: input.options.referenceRuntimeRoot } : {}),
    referenceVersion: input.options.referenceVersion ?? "unknown",
    referenceCommit: input.options.referenceCommit ?? readGitCommit(referenceRepoPath),
    daemonUrl: baseUrl,
    apiEndpoint,
    ...(missionId ? { missionId } : {}),
    modelCatalog: modelCatalog ?? "unknown",
    provider,
    modelId,
    exactRequestPayload,
    timeout: {
      timeoutMs: input.options.timeoutMs,
      pollMs: input.options.pollMs,
    },
    rawResponse,
    rawTranscript,
    rawToolCalls,
    rawToolResults,
    rawBrowserEvidence,
    rawFlowEvidence,
    rawApprovalEvidence,
    rawCancellationEvidence,
    rawMemoryEvidence,
    fixtureContentHashes: input.fixtureContentHashes,
    referenceScenarioDriver: scenarioDriver,
    ...(loopbackFixtureProbe ? { loopbackFixtureProbe } : {}),
    artifactAdapterMappingSource: "scripts/real-llm-ab-reference-collect.ts",
    collectedAtMs,
    exitStatus,
    errorReason,
  };
  const firstSummaryPendingToolCount = Array.isArray(rawTranscript)
    ? readPendingReferenceToolCalls(rawTranscript).length
    : Math.max(0, firstSummaryToolCallCount - firstSummaryToolResultCount);
  return {
    system: "reference",
    prompt: input.task.prompt,
    ...(threadId ? { threadId } : {}),
    ...(missionId ? { missionId } : {}),
    durationMs,
    timedOut,
    provenance,
    rawResponse,
    rawTranscript,
    rawToolCalls,
    rawToolResults,
    rawBrowserEvidence,
    rawFlowEvidence,
    rawApprovalEvidence,
    ...(rawCancellationEvidence.length > 0 ? { rawCancellationEvidence } : {}),
    ...(rawMemoryEvidence.length > 0 ? { rawMemoryEvidence } : {}),
    artifactAdapterMappingSource: "scripts/real-llm-ab-reference-collect.ts",
    collectedAtMs,
    exitStatus,
    errorReason,
    first: {
      summary: {
        toolCallCount: firstSummaryToolCallCount,
        toolResultCount: firstSummaryToolResultCount,
        pendingToolCount: firstSummaryPendingToolCount,
        finalText,
      },
    },
    ...(followupSummary ? { followup: followupSummary } : {}),
    score: {
      useful,
      weak,
    },
  };
}

function buildUnsupportedReferenceArtifact(input: {
  task: ReferenceCollectionTask;
  options: ReferenceCollectOptions;
  fixtureContentHashes: Record<string, string>;
  baseUrl: string;
  scenarioDriver: ReferenceScenarioDriver;
  startedAt: number;
  collectedAtMs: number;
}): ReferenceCollectedArtifact {
  const errorReason = `unsupported_reference_scenario_driver:${input.scenarioDriver.unsupportedReason ?? input.scenarioDriver.kind}`;
  const durationMs = Date.now() - input.startedAt;
  const referenceRepoPath = resolveReferenceRepoPath(input.options);
  const provenance = {
    referenceApp: input.options.referenceApp,
    referenceBinary: input.options.referenceBinary ?? "unknown",
    referenceRepoPath,
    ...(input.options.referenceRuntimeRoot ? { referenceRuntimeRoot: input.options.referenceRuntimeRoot } : {}),
    referenceVersion: input.options.referenceVersion ?? "unknown",
    referenceCommit: input.options.referenceCommit ?? readGitCommit(referenceRepoPath),
    daemonUrl: input.baseUrl,
    apiEndpoint: "not_run",
    provider: "unknown",
    modelId: "unknown",
    exactRequestPayload: null,
    timeout: {
      timeoutMs: input.options.timeoutMs,
      pollMs: input.options.pollMs,
    },
    rawResponse: null,
    rawTranscript: null,
    rawToolCalls: [],
    rawToolResults: [],
    rawBrowserEvidence: [],
    rawFlowEvidence: [],
    rawApprovalEvidence: [],
    fixtureContentHashes: input.fixtureContentHashes,
    referenceScenarioDriver: input.scenarioDriver,
    artifactAdapterMappingSource: "scripts/real-llm-ab-reference-collect.ts",
    collectedAtMs: input.collectedAtMs,
    exitStatus: "error",
    errorReason,
  };
  return {
    system: "reference",
    prompt: input.task.prompt,
    durationMs,
    timedOut: false,
    provenance,
    rawResponse: null,
    rawTranscript: null,
    rawToolCalls: [],
    rawToolResults: [],
    rawBrowserEvidence: [],
    rawFlowEvidence: [],
    rawApprovalEvidence: [],
    artifactAdapterMappingSource: "scripts/real-llm-ab-reference-collect.ts",
    collectedAtMs: input.collectedAtMs,
    exitStatus: "error",
    errorReason,
    first: {
      summary: {
        toolCallCount: 0,
        toolResultCount: 0,
        pendingToolCount: 0,
        finalText: "",
      },
    },
    score: {
      useful: false,
      weak: true,
    },
  };
}

function buildFixtureUnavailableReferenceArtifact(input: {
  task: ReferenceCollectionTask;
  options: ReferenceCollectOptions;
  fixtureContentHashes: Record<string, string>;
  baseUrl: string;
  scenarioDriver: ReferenceScenarioDriver;
  startedAt: number;
  collectedAtMs: number;
  modelCatalog: unknown;
  provider: string;
  modelId: string;
  probe: LoopbackFixtureProbeResult;
}): ReferenceCollectedArtifact {
  const durationMs = Date.now() - input.startedAt;
  const referenceRepoPath = resolveReferenceRepoPath(input.options);
  const unreachable = input.probe.unreachable
    .map((item) => `${item.url} (${item.reason})`)
    .join("; ");
  const errorReason = `reference_fixture_unreachable:${unreachable}`;
  const provenance = {
    referenceApp: input.options.referenceApp,
    referenceBinary: input.options.referenceBinary ?? "unknown",
    referenceRepoPath,
    ...(input.options.referenceRuntimeRoot ? { referenceRuntimeRoot: input.options.referenceRuntimeRoot } : {}),
    referenceVersion: input.options.referenceVersion ?? "unknown",
    referenceCommit: input.options.referenceCommit ?? readGitCommit(referenceRepoPath),
    daemonUrl: input.baseUrl,
    apiEndpoint: "not_run",
    provider: input.provider,
    modelId: input.modelId,
    modelCatalog: input.modelCatalog,
    exactRequestPayload: {
      transport: "accio-work-websocket-sendQuery",
      prompt: input.task.prompt,
      blockedBeforeSend: true,
      loopbackFixtureProbe: input.probe,
    },
    timeout: {
      timeoutMs: input.options.timeoutMs,
      pollMs: input.options.pollMs,
    },
    rawResponse: null,
    rawTranscript: null,
    rawToolCalls: [],
    rawToolResults: [],
    rawBrowserEvidence: [],
    rawFlowEvidence: [],
    rawApprovalEvidence: [],
    fixtureContentHashes: input.fixtureContentHashes,
    referenceScenarioDriver: input.scenarioDriver,
    loopbackFixtureProbe: input.probe,
    artifactAdapterMappingSource: "scripts/real-llm-ab-reference-collect.ts",
    collectedAtMs: input.collectedAtMs,
    exitStatus: "error",
    errorReason,
  };
  return {
    system: "reference",
    prompt: input.task.prompt,
    durationMs,
    timedOut: false,
    provenance,
    rawResponse: null,
    rawTranscript: null,
    rawToolCalls: [],
    rawToolResults: [],
    rawBrowserEvidence: [],
    rawFlowEvidence: [],
    rawApprovalEvidence: [],
    artifactAdapterMappingSource: "scripts/real-llm-ab-reference-collect.ts",
    collectedAtMs: input.collectedAtMs,
    exitStatus: "error",
    errorReason,
    first: {
      summary: {
        toolCallCount: 0,
        toolResultCount: 0,
        pendingToolCount: 0,
        finalText: "",
      },
    },
    score: {
      useful: false,
      weak: true,
    },
  };
}

interface LoopbackFixtureProbeResult {
  checked: string[];
  reachable: string[];
  unreachable: Array<{ url: string; reason: string }>;
}

async function probeLoopbackFixturesForAccioWsPrompt(
  prompt: string,
  scenarioId?: string
): Promise<LoopbackFixtureProbeResult> {
  const urls = extractLoopbackUrls(prompt);
  const reachable: string[] = [];
  const unreachable: Array<{ url: string; reason: string }> = [];
  for (const url of urls) {
    const reason = await probeLoopbackUrl(url);
    if (reason) {
      if (isAllowedSlowFixtureProbeTimeout({ url, reason, prompt, scenarioId })) {
        reachable.push(url);
        continue;
      }
      unreachable.push({ url, reason });
    } else {
      reachable.push(url);
    }
  }
  return { checked: urls, reachable, unreachable };
}

function isAllowedSlowFixtureProbeTimeout(input: {
  url: string;
  reason: string;
  prompt: string;
  scenarioId?: string;
}): boolean {
  if (input.reason !== "timeout") return false;
  if (
    input.scenarioId !== "natural-timeout-followup-continuation" &&
    input.scenarioId !== "natural-timeout-partial-closeout"
  ) {
    return false;
  }
  try {
    if (new URL(input.url).pathname !== "/slow-fixture") return false;
  } catch {
    return false;
  }
  return (
    /\bslow source\b/i.test(input.prompt) &&
    /\bbounded attempt\b/i.test(input.prompt) &&
    /\b(?:timeout|does not return in time|does not respond|no response)\b/i.test(input.prompt)
  );
}

function extractLoopbackUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s"'<>),]+/gi) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.;:,]+$/g, "")))]
    .flatMap((url) => {
      try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
          return [url];
        }
      } catch {
        return [];
      }
      return [];
    })
    .sort();
}

async function probeLoopbackUrl(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    await response.arrayBuffer().catch(() => new ArrayBuffer(0));
    return response.ok || response.status < 500 ? null : `http_${response.status}`;
  } catch (error) {
    if (error instanceof Error) {
      return error.name === "AbortError" ? "timeout" : error.message;
    }
    return String(error);
  } finally {
    clearTimeout(timeout);
  }
}

async function driveAccioWsReferenceScenario(input: {
  task: ReferenceCollectionTask;
  options: ReferenceCollectOptions;
  baseUrl: string;
  modelCatalog: unknown;
  modelInfo: { provider: string; modelId: string };
}): Promise<{
  apiEndpoint: string;
  exactRequestPayload: Record<string, unknown>;
  rawResponse: unknown;
  threadId: string;
  rawTranscript: unknown[];
  rawToolCalls: unknown[];
  rawToolResults: unknown[];
  rawBrowserEvidence: unknown[];
  rawFlowEvidence: unknown[];
  finalText: string;
  timedOut: boolean;
  firstSummaryToolCallCount: number;
  firstSummaryToolResultCount: number;
  followupSummary?: ReferenceCollectedArtifact["followup"];
}> {
  const health = await getJson(input.baseUrl, "/reference/health");
  const agents = await getJson(input.baseUrl, "/agents");
  const selectedAgent = selectAccioAgent(agents, input.options.accioAgentId);
  const agentId = selectedAgent?.id ?? input.options.accioAgentId ?? "DID-F456DA-2B0D4C";
  const accountId = selectedAgent?.accountId ?? "reference-account";
  const accioHome =
    readString((health as { accioHome?: unknown } | null)?.accioHome) ??
    resolveAccioHomeFromRuntimeRoot(input.options.referenceRuntimeRoot);
  const electronUserDataDir = readString((health as { electronUserDataDir?: unknown } | null)?.electronUserDataDir);
  if (!accioHome) {
    throw new Error("Accio WS collection requires /reference/health.accioHome or --reference-runtime-root");
  }
  const workspacePath = input.options.accioWorkspacePath ?? process.cwd();
  const promptStartedAtMs = Date.now();
  const scenarioDriver = referenceScenarioDriverFor(input.task.scenarioId);
  const probe = await sendAccioWsPrompt({
    baseUrl: input.baseUrl,
    agentId,
    workspacePath,
    prompt: input.task.prompt,
    timeoutMs: Math.min(input.options.timeoutMs, 45_000),
    conversationLabel: input.task.scenarioId,
  });
  let pollResult: Awaited<ReturnType<typeof pollAccioSessionMessages>>;
  try {
    pollResult = await pollAccioSessionMessages({
      accioHome,
      accountId,
      agentId,
      conversationId: probe.conversationId,
      timeoutMs: input.options.timeoutMs,
      pollMs: input.options.pollMs,
      approvalDecisionPolicy: scenarioDriver.approvalDecisionPolicy,
    });
  } finally {
    probe.close();
  }
  let rawResponse: unknown = probe.readRawResponse();
  let transcript = pollResult.messages;
  let finalText = readLatestAssistantText(transcript);
  let timedOut = pollResult.timedOut;
  let followupSummary: ReferenceCollectedArtifact["followup"];
  if (
    scenarioDriver.approvalDecisionPolicy === "denied" &&
    isApprovalDecisionRequestFinal(finalText)
  ) {
    const followupPrompt = buildReferenceApprovalDeniedFollowupPrompt();
    const followupProbe = await sendAccioWsPrompt({
      baseUrl: input.baseUrl,
      agentId,
      workspacePath,
      prompt: followupPrompt,
      timeoutMs: Math.min(input.options.timeoutMs, 45_000),
      conversationLabel: input.task.scenarioId,
      conversationId: probe.conversationId,
    });
    let followupPoll: Awaited<ReturnType<typeof pollAccioSessionMessages>>;
    try {
      followupPoll = await pollAccioSessionMessages({
        accioHome,
        accountId,
        agentId,
        conversationId: probe.conversationId,
        timeoutMs: input.options.timeoutMs,
        pollMs: input.options.pollMs,
        afterUserContent: followupPrompt,
        approvalDecisionPolicy: scenarioDriver.approvalDecisionPolicy,
      });
    } finally {
      followupProbe.close();
    }
    transcript = followupPoll.messages.length > 0 ? followupPoll.messages : transcript;
    const followupMessages = sliceMessagesAfterUserContent(transcript, followupPrompt);
    const followupToolCalls = dedupeReferenceToolCalls(extractToolCalls(followupMessages));
    const followupToolResults = extractToolResults(followupMessages);
    finalText =
      followupPoll.completion.finalText ||
      readLatestAssistantText(followupMessages) ||
      finalText;
    timedOut = followupPoll.timedOut && !followupPoll.completion.finalText;
    rawResponse = {
      first: rawResponse,
      followup: followupProbe.readRawResponse(),
    };
    followupSummary = {
      summary: {
        toolCallCount: followupToolCalls.length,
        toolResultCount: followupToolResults.length,
        pendingToolCount: readPendingReferenceToolCalls(followupMessages).length,
        finalText,
      },
    };
  }
  const toolCalls = dedupeReferenceToolCalls(extractToolCalls(transcript));
  const toolResults = extractToolResults(transcript);
  const workspaceArtifacts = collectAccioWorkspaceArtifacts({
    workspacePath,
    sinceMs: promptStartedAtMs,
  });
  return {
    apiEndpoint: "/websocket/connect",
    exactRequestPayload: {
      transport: "accio-work-websocket-sendQuery",
      conversationId: probe.conversationId,
      agentId,
      accountId,
      modelCatalog: input.modelCatalog,
      provider: input.modelInfo.provider,
      modelId: input.modelInfo.modelId,
      prompt: input.task.prompt,
      ...(followupSummary ? { followup: { content: buildReferenceApprovalDeniedFollowupPrompt() } } : {}),
    },
    rawResponse,
    threadId: probe.conversationId,
    rawTranscript: transcript,
    rawToolCalls: toolCalls,
    rawToolResults: toolResults,
    rawBrowserEvidence: extractBrowserEvidenceFromTranscript(transcript),
    rawMemoryEvidence: [],
    rawFlowEvidence: [
      {
        source: "accio_ws_session_file",
        accioHome,
        accountId,
        agentId,
        conversationId: probe.conversationId,
        sessionPath: accioSessionMessagesPath({ accioHome, accountId, agentId, conversationId: probe.conversationId }),
      },
      {
        source: "accio_ws_sdk_log",
        conversationId: probe.conversationId,
        sdkLogPath: path.join(accioHome, "logs", "sdk.log"),
      },
      ...(electronUserDataDir
        ? [
            {
              source: "accio_ws_sdk_log",
              conversationId: probe.conversationId,
              sdkLogPath: path.join(electronUserDataDir, "logs", "sdk.log"),
            },
          ]
        : []),
      ...workspaceArtifacts,
    ],
    finalText,
    timedOut,
    firstSummaryToolCallCount: toolCalls.length,
    firstSummaryToolResultCount: toolResults.length,
    ...(followupSummary ? { followupSummary } : {}),
  };
}

async function driveAccioWsMemoryRecallReferenceScenario(input: {
  task: ReferenceCollectionTask;
  options: ReferenceCollectOptions;
  baseUrl: string;
  modelCatalog: unknown;
  modelInfo: { provider: string; modelId: string };
}): Promise<{
  apiEndpoint: string;
  exactRequestPayload: Record<string, unknown>;
  rawResponse: unknown;
  threadId: string;
  rawTranscript: unknown[];
  rawToolCalls: unknown[];
  rawToolResults: unknown[];
  rawBrowserEvidence: unknown[];
  rawMemoryEvidence: unknown[];
  rawFlowEvidence: unknown[];
  finalText: string;
  timedOut: boolean;
  firstSummaryToolCallCount: number;
  firstSummaryToolResultCount: number;
  followupSummary?: ReferenceCollectedArtifact["followup"];
}> {
  const health = await getJson(input.baseUrl, "/reference/health");
  const agents = await getJson(input.baseUrl, "/agents");
  const selectedAgent = selectAccioAgent(agents, input.options.accioAgentId);
  const agentId = selectedAgent?.id ?? input.options.accioAgentId ?? "DID-F456DA-2B0D4C";
  const accountId = selectedAgent?.accountId ?? "reference-account";
  const accioHome =
    readString((health as { accioHome?: unknown } | null)?.accioHome) ??
    resolveAccioHomeFromRuntimeRoot(input.options.referenceRuntimeRoot);
  if (!accioHome) {
    throw new Error("Accio WS memory recall collection requires /reference/health.accioHome or --reference-runtime-root");
  }
  const memorySeed = writeAccioAgentCoreMemorySeed({ accioHome, accountId, agentId });
  const probe = await sendAccioWsPrompt({
    baseUrl: input.baseUrl,
    agentId,
    workspacePath: input.options.accioWorkspacePath ?? process.cwd(),
    prompt: input.task.prompt,
    timeoutMs: Math.min(input.options.timeoutMs, 45_000),
    conversationLabel: input.task.scenarioId,
  });
  let pollResult: Awaited<ReturnType<typeof pollAccioSessionMessages>>;
  try {
    pollResult = await pollAccioSessionMessages({
      accioHome,
      accountId,
      agentId,
      conversationId: probe.conversationId,
      timeoutMs: input.options.timeoutMs,
      pollMs: input.options.pollMs,
    });
  } finally {
    probe.close();
  }
  const transcript = pollResult.messages;
  const finalText = readLatestAssistantText(transcript);
  const toolCalls = dedupeReferenceToolCalls(extractToolCalls(transcript));
  const toolResults = extractToolResults(transcript);
  return {
    apiEndpoint: "/websocket/connect",
    exactRequestPayload: {
      transport: "accio-work-websocket-sendQuery",
      conversationId: probe.conversationId,
      agentId,
      accountId,
      modelCatalog: input.modelCatalog,
      provider: input.modelInfo.provider,
      modelId: input.modelInfo.modelId,
      prompt: input.task.prompt,
      memorySeed: {
        path: memorySeed.path,
        source: "accio_agent_core_memory",
      },
    },
    rawResponse: {
      ...probe.readRawResponse(),
      memorySeed: { path: memorySeed.path },
    },
    threadId: probe.conversationId,
    rawTranscript: transcript,
    rawToolCalls: toolCalls,
    rawToolResults: toolResults,
    rawBrowserEvidence: extractBrowserEvidenceFromTranscript(transcript),
    rawMemoryEvidence: [
      {
        source: "accio_agent_core_memory",
        phase: "seed",
        memoryPath: memorySeed.path,
        content: memorySeed.content,
      },
      {
        source: "accio_ws_session_file",
        phase: "final_recall",
        timedOut: pollResult.timedOut,
        finalText,
      },
    ],
    rawFlowEvidence: [
      {
        source: "accio_ws_session_file",
        accioHome,
        accountId,
        agentId,
        conversationId: probe.conversationId,
        sessionPath: accioSessionMessagesPath({ accioHome, accountId, agentId, conversationId: probe.conversationId }),
      },
    ],
    finalText,
    timedOut: pollResult.timedOut,
    firstSummaryToolCallCount: toolCalls.length,
    firstSummaryToolResultCount: toolResults.length,
  };
}

async function driveAccioWsFollowupReferenceScenario(input: {
  task: ReferenceCollectionTask;
  options: ReferenceCollectOptions;
  baseUrl: string;
  modelCatalog: unknown;
  modelInfo: { provider: string; modelId: string };
}): Promise<{
  apiEndpoint: string;
  exactRequestPayload: Record<string, unknown>;
  rawResponse: unknown;
  threadId: string;
  rawTranscript: unknown[];
  rawToolCalls: unknown[];
  rawToolResults: unknown[];
  rawBrowserEvidence: unknown[];
  rawMemoryEvidence: unknown[];
  rawFlowEvidence: unknown[];
  finalText: string;
  timedOut: boolean;
  firstSummaryToolCallCount: number;
  firstSummaryToolResultCount: number;
  followupSummary?: ReferenceCollectedArtifact["followup"];
}> {
  const health = await getJson(input.baseUrl, "/reference/health");
  const agents = await getJson(input.baseUrl, "/agents");
  const selectedAgent = selectAccioAgent(agents, input.options.accioAgentId);
  const agentId = selectedAgent?.id ?? input.options.accioAgentId ?? "DID-F456DA-2B0D4C";
  const accountId = selectedAgent?.accountId ?? "reference-account";
  const accioHome =
    readString((health as { accioHome?: unknown } | null)?.accioHome) ??
    resolveAccioHomeFromRuntimeRoot(input.options.referenceRuntimeRoot);
  if (!accioHome) {
    throw new Error("Accio WS follow-up collection requires /reference/health.accioHome or --reference-runtime-root");
  }
  const firstProbe = await sendAccioWsPrompt({
    baseUrl: input.baseUrl,
    agentId,
    workspacePath: input.options.accioWorkspacePath ?? process.cwd(),
    prompt: input.task.prompt,
    timeoutMs: Math.min(input.options.timeoutMs, 45_000),
    conversationLabel: input.task.scenarioId,
  });
  let firstPoll: Awaited<ReturnType<typeof pollAccioSessionMessages>>;
  try {
    firstPoll = await pollAccioSessionMessages({
      accioHome,
      accountId,
      agentId,
      conversationId: firstProbe.conversationId,
      timeoutMs: input.options.timeoutMs,
      pollMs: input.options.pollMs,
    });
  } finally {
    firstProbe.close();
  }
  const followupPrompt =
    referenceScenarioDriverFor(input.task.scenarioId).kind === "timeout_followup"
      ? buildReferenceTimeoutFollowupPrompt(input.task.prompt)
      : buildReferenceFollowupContinuationPrompt(input.task.scenarioId);
  const followupProbe = await sendAccioWsPrompt({
    baseUrl: input.baseUrl,
    agentId,
    workspacePath: input.options.accioWorkspacePath ?? process.cwd(),
    prompt: followupPrompt,
    timeoutMs: Math.min(input.options.timeoutMs, 45_000),
    conversationLabel: input.task.scenarioId,
    conversationId: firstProbe.conversationId,
  });
  let followupPoll: Awaited<ReturnType<typeof pollAccioSessionMessages>>;
  try {
    followupPoll = await pollAccioSessionMessages({
      accioHome,
      accountId,
      agentId,
      conversationId: firstProbe.conversationId,
      timeoutMs: input.options.timeoutMs,
      pollMs: input.options.pollMs,
      afterUserContent: followupPrompt,
    });
  } finally {
    followupProbe.close();
  }
  const transcript = followupPoll.messages.length > 0 ? followupPoll.messages : firstPoll.messages;
  const firstToolCalls = dedupeReferenceToolCalls(extractToolCalls(firstPoll.messages));
  const firstToolResults = extractToolResults(firstPoll.messages);
  const followupMessages = sliceMessagesAfterUserContent(transcript, followupPrompt);
  const followupToolCalls = dedupeReferenceToolCalls(extractToolCalls(followupMessages));
  const followupToolResults = extractToolResults(followupMessages);
  const toolCalls = dedupeReferenceToolCalls(extractToolCalls(transcript));
  const toolResults = extractToolResults(transcript);
  const finalText = followupPoll.finalText || readLatestAssistantText(followupMessages);
  return {
    apiEndpoint: "/websocket/connect",
    exactRequestPayload: {
      transport: "accio-work-websocket-sendQuery",
      conversationId: firstProbe.conversationId,
      agentId,
      accountId,
      modelCatalog: input.modelCatalog,
      provider: input.modelInfo.provider,
      modelId: input.modelInfo.modelId,
      prompt: input.task.prompt,
      followup: { content: followupPrompt },
    },
    rawResponse: {
      first: firstProbe.readRawResponse(),
      followup: followupProbe.readRawResponse(),
    },
    threadId: firstProbe.conversationId,
    rawTranscript: transcript,
    rawToolCalls: toolCalls,
    rawToolResults: toolResults,
    rawBrowserEvidence: extractBrowserEvidenceFromTranscript(transcript),
    rawMemoryEvidence: [],
    rawFlowEvidence: [
      {
        source: "accio_ws_session_file",
        accioHome,
        accountId,
        agentId,
        conversationId: firstProbe.conversationId,
        sessionPath: accioSessionMessagesPath({ accioHome, accountId, agentId, conversationId: firstProbe.conversationId }),
      },
    ],
    finalText,
    timedOut: followupPoll.timedOut && !finalText,
    firstSummaryToolCallCount: firstToolCalls.length,
    firstSummaryToolResultCount: firstToolResults.length,
    followupSummary: {
      summary: {
        toolCallCount: followupToolCalls.length,
        toolResultCount: followupToolResults.length,
        pendingToolCount: readPendingReferenceToolCalls(followupMessages).length,
        finalText,
      },
    },
  };
}

interface AccioWsPromptProbe {
  conversationId: string;
  close(): void;
  readRawResponse(): Record<string, unknown>;
}

async function sendAccioWsPrompt(input: {
  baseUrl: string;
  agentId: string;
  workspacePath: string;
  prompt: string;
  timeoutMs: number;
  conversationLabel: string;
  conversationId?: string;
}): Promise<AccioWsPromptProbe> {
  const safeLabel = input.conversationLabel.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "reference";
  const conversationId = input.conversationId ?? `CID-${safeLabel}-${Date.now().toString(36)}`;
  const clientId = `desktop-reference-collect-${Date.now().toString(36)}`;
  const wsUrl = `${input.baseUrl.replace(/^http/i, "ws").replace(/\/+$/, "")}/websocket/connect?clientId=${encodeURIComponent(
    clientId
  )}`;
  const messages: string[] = [];
  let accepted = false;
  let errorMessage = "";
  let ws: WebSocket | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      ws?.close();
    } catch {}
  };
  const readRawResponse = (): Record<string, unknown> => ({
    route: "/websocket/connect",
    transport: "accio-work-websocket-sendQuery",
    accepted,
    keptOpenAfterAccept: true,
    conversationId,
    clientId,
    messageCount: messages.length,
    messages: parseAccioWsMessages(messages),
  });
  await new Promise<void>((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      close();
      resolve();
    }, input.timeoutMs);
    ws.addEventListener("open", () => {
      ws?.send(
        JSON.stringify({
          type: "req",
          method: "sendQuery",
          params: {
            conversationId,
            chatType: "direct",
            question: { query: input.prompt },
            path: input.workspacePath,
            agentId: input.agentId,
            targetAgentList: [{ agentId: input.agentId, isTL: true }],
            skills: [],
            language: "zh",
            ts: Date.now(),
            extra: {},
            source: {
              platform: "pcApp",
              type: "im",
              channelId: "reference-collector",
              chatId: "reference-collector-chat",
              userId: "reference-user",
              chatType: "private",
              wasMentioned: true,
              isAuthorized: true,
            },
            atIds: [],
          },
        })
      );
    });
    ws.addEventListener("message", (event) => {
      const text = String(event.data);
      messages.push(text);
      if (isAcceptedAccioWsMessage(text, conversationId)) {
        accepted = true;
        clearTimeout(timer);
        resolve();
      }
    });
    ws.addEventListener("error", () => {
      errorMessage = "websocket error";
      clearTimeout(timer);
      reject(new Error(errorMessage));
    });
  }).catch((error) => {
    errorMessage = error instanceof Error ? error.message : String(error);
  });
  if (!accepted) {
    throw new Error(`Accio WS sendQuery was not accepted${errorMessage ? `: ${errorMessage}` : ""}`);
  }
  return {
    conversationId,
    close,
    readRawResponse,
  };
}

function parseAccioWsMessages(messages: string[]): unknown[] {
  return messages.flatMap((message) => {
    try {
      return [JSON.parse(message) as unknown];
    } catch {
      return [{ raw: message }];
    }
  });
}

function isAcceptedAccioWsMessage(text: string, conversationId: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const record = parsed as { type?: unknown; payload?: { conversationId?: unknown; success?: unknown } };
  return readString(record.payload?.conversationId) === conversationId && (record.payload?.success === true || readString(record.type) === "ack");
}

async function pollAccioSessionMessages(input: {
  accioHome: string;
  accountId: string;
  agentId: string;
  conversationId: string;
  timeoutMs: number;
  pollMs: number;
  afterUserContent?: string;
  approvalDecisionPolicy?: ReferenceApprovalDecisionPolicy;
}): Promise<{ messages: unknown[]; completion: { finalText: string; ready: boolean }; timedOut: boolean }> {
  const sessionPath = accioSessionMessagesPath(input);
  const startedAt = Date.now();
  let lastCompletion = { finalText: "", ready: false };
  while (Date.now() - startedAt <= input.timeoutMs) {
    const messages = readJsonlMessages(sessionPath);
    const scopedMessages = input.afterUserContent ? sliceMessagesAfterUserContent(messages, input.afterUserContent) : messages;
    const completion = readReferenceCompletion(scopedMessages, {
      approvalDecisionPolicy: input.approvalDecisionPolicy,
    });
    lastCompletion = completion;
    if (completion.ready) return { messages, completion, timedOut: false };
    await sleep(input.pollMs);
  }
  const messages = readJsonlMessages(sessionPath);
  const scopedMessages = input.afterUserContent ? sliceMessagesAfterUserContent(messages, input.afterUserContent) : messages;
  return {
    messages,
    completion:
      readReferenceCompletion(scopedMessages, {
        approvalDecisionPolicy: input.approvalDecisionPolicy,
      }) ?? lastCompletion,
    timedOut: true,
  };
}

function accioSessionMessagesPath(input: {
  accioHome: string;
  accountId: string;
  agentId: string;
  conversationId: string;
}): string {
  return path.join(
    input.accioHome,
    "accounts",
    input.accountId,
    "agents",
    input.agentId,
    "sessions",
    `${input.agentId}_${input.conversationId}.messages.jsonl`
  );
}

const ACCIO_WORKSPACE_ARTIFACT_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".html",
  ".htm",
  ".md",
  ".txt",
  ".json",
]);

export function collectAccioWorkspaceArtifacts(input: {
  workspacePath: string;
  sinceMs: number;
  maxFiles?: number;
  maxBytes?: number;
  maxDepth?: number;
}): unknown[] {
  const root = path.resolve(input.workspacePath);
  if (!existsSync(root)) return [];
  const maxFiles = input.maxFiles ?? 25;
  const maxBytes = input.maxBytes ?? 10 * 1024 * 1024;
  const maxDepth = input.maxDepth ?? 4;
  const artifacts: Array<Record<string, unknown> & { mtimeMs: number; relativePath: string }> = [];
  let visitedEntries = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth || artifacts.length >= maxFiles || visitedEntries > 5_000) return;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (artifacts.length >= maxFiles || visitedEntries > 5_000) return;
      visitedEntries += 1;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".cache") continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!ACCIO_WORKSPACE_ARTIFACT_EXTENSIONS.has(ext)) continue;
      let stat;
      try {
        stat = statSync(absolutePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs + 1_000 < input.sinceMs) continue;
      if (stat.size <= 0 || stat.size > maxBytes) continue;
      let sha256 = "";
      try {
        sha256 = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
      } catch {
        continue;
      }
      artifacts.push({
        source: "accio_ws_workspace_artifact_after_prompt",
        status: "orphaned_workspace_artifact",
        kind: classifyAccioWorkspaceArtifactKind(ext),
        workspacePath: root,
        path: absolutePath,
        relativePath: path.relative(root, absolutePath),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: `sha256:${sha256}`,
      });
    }
  };
  visit(root, 0);
  return artifacts
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.relativePath.localeCompare(right.relativePath))
    .slice(0, maxFiles);
}

function classifyAccioWorkspaceArtifactKind(ext: string): string {
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "screenshot";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".json") return "json";
  return "text";
}

function readJsonlMessages(filePath: string): unknown[] {
  try {
    return readFileSync(filePath, "utf8")
      .split(/\r?\n/g)
      .flatMap((line) => {
        const trimmed = line.trim();
        if (!trimmed) return [];
        try {
          return [JSON.parse(trimmed) as unknown];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function selectAccioAgent(value: unknown, requestedAgentId: string | undefined): { id: string; accountId: string } | null {
  const agents = readAccioAgentRecords(value);
  const selected =
    agents.find((agent) => requestedAgentId && agent.id === requestedAgentId) ??
    agents.find((agent) => agent.modelName === "MiniMax-M2.7-highspeed") ??
    agents[0];
  return selected ? { id: selected.id, accountId: selected.accountId } : null;
}

function readAccioAgentRecords(value: unknown): Array<{ id: string; accountId: string; modelName?: string }> {
  if (typeof value !== "object" || value === null) return [];
  const record = value as { data?: unknown };
  const data = Array.isArray(record.data) ? record.data : Array.isArray(value) ? value : [];
  return data.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const agent = item as { id?: unknown; accountId?: unknown; model?: { name?: unknown } };
    const id = readString(agent.id);
    const accountId = readString(agent.accountId);
    if (!id || !accountId) return [];
    const modelName = readString(agent.model?.name);
    return [{ id, accountId, ...(modelName ? { modelName } : {}) }];
  });
}

function resolveAccioHomeFromRuntimeRoot(runtimeRoot: string | undefined): string | null {
  if (!runtimeRoot) return null;
  return path.join(runtimeRoot, "home", ".accio");
}

function buildPendingApprovalPausedStateSummary(approvalEvidence: unknown[]): string {
  const observed = approvalEvidence
    .filter((evidence): evidence is Record<string, unknown> => typeof evidence === "object" && evidence !== null)
    .find((evidence) => readString(evidence.status) === "observed_pending");
  if (!observed) return "";
  const approval = typeof observed.approval === "object" && observed.approval !== null ? observed.approval as Record<string, unknown> : {};
  const approvalId = readString(observed.approvalId) ?? readString(approval.id) ?? "unknown";
  const action = readString(approval.action) ?? "browser.form.submit";
  const title = readString(approval.title) ?? "approval-gated action";
  const risk = readString(approval.risk) ?? "operator decision is required before the side effect can run";
  return [
    `Requested approval for ${action} and stopped at the approval gate before the side effect ran.`,
    `Approval ID: ${approvalId}.`,
    `Pending action: ${title}.`,
    `Risk recorded by the runtime: ${risk}.`,
    "Operator decision is still pending, so no permission_result, permission_applied, browser form submission, or external mutation was performed.",
  ].join(" ");
}

function hasObservedPendingApprovalEvidence(approvalEvidence: unknown[]): boolean {
  return approvalEvidence.some(
    (evidence) =>
      typeof evidence === "object" &&
      evidence !== null &&
      readString((evidence as { status?: unknown }).status) === "observed_pending" &&
      Boolean(readString((evidence as { approvalId?: unknown }).approvalId))
  );
}

function hasApprovalWaitTimeoutCloseoutEvidence(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      /\bapproval_wait_timeout\b|\bapproval wait[- ]timeout\b|\boperator decision\b[\s\S]{0,160}\b(?:did not arrive|still pending|timed out|timeout)\b|\bpermission request\b[\s\S]{0,160}\b(?:did not arrive|still pending|timed out|timeout)\b/i.test(
        value
      ) &&
      /\bno\b[\s\S]{0,80}\b(?:permission_result|permission_applied|form submission|browser form submission|side effect|mutation)\b|\b(?:form submission|browser action|side effect|mutation)\b[\s\S]{0,80}\b(?:not|never|no)\b[\s\S]{0,40}\b(?:performed|executed|submitted|applied|ran)\b/i.test(
        value
      )
    );
  }
  if (Array.isArray(value)) return value.some((item) => hasApprovalWaitTimeoutCloseoutEvidence(item));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((item) => hasApprovalWaitTimeoutCloseoutEvidence(item));
}

async function driveReferenceActiveCancellation(input: {
  baseUrl: string;
  missionId: string;
  threadId: string;
  startedAt: number;
  timeoutMs: number;
  pollMs: number;
  requestAuth?: ReferenceRequestAuth;
}): Promise<unknown[]> {
  const evidence: unknown[] = [];
  const toolCall = await waitForReferenceTimelineToolCall({
    baseUrl: input.baseUrl,
    missionId: input.missionId,
    startedAt: input.startedAt,
    timeoutMs: Math.min(input.timeoutMs, 60_000),
    pollMs: input.pollMs,
    requestAuth: input.requestAuth,
  });
  if (toolCall) {
    evidence.push({
      source: "mission_timeline",
      status: "observed_tool_call",
      missionId: input.missionId,
      threadId: input.threadId,
      event: toolCall.event,
      timeline: toolCall.timeline,
    });
  } else {
    evidence.push({
      source: "mission_timeline",
      status: "tool_call_not_observed_before_cancel",
      missionId: input.missionId,
      threadId: input.threadId,
    });
  }
  let cancelResponse: unknown = null;
  try {
    cancelResponse = await postJson(
      input.baseUrl,
      `/missions/${encodeURIComponent(input.missionId)}/cancel`,
      { reason: "reference collector cancelled active source verification for same-scenario A/B" },
      input.requestAuth,
      { timeoutMs: 30_000 }
    );
    evidence.push({
      source: "mission_cancel",
      status: "cancel_requested",
      missionId: input.missionId,
      threadId: input.threadId,
      response: cancelResponse,
    });
  } catch (error) {
    evidence.push({
      source: "mission_cancel",
      status: "cancel_failed",
      missionId: input.missionId,
      threadId: input.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return evidence;
  }
  const cancelled = await waitForReferenceMissionCancelled({
    baseUrl: input.baseUrl,
    missionId: input.missionId,
    startedAt: Date.now(),
    timeoutMs: 20_000,
    pollMs: input.pollMs,
    requestAuth: input.requestAuth,
  });
  if (cancelled) {
    evidence.push({
      source: "mission_timeline",
      status: "mission_cancelled",
      missionId: input.missionId,
      threadId: input.threadId,
      event: cancelled.event,
      timeline: cancelled.timeline,
    });
  }
  return evidence;
}

async function waitForReferenceTimelineToolCall(input: {
  baseUrl: string;
  missionId: string;
  startedAt: number;
  timeoutMs: number;
  pollMs: number;
  requestAuth?: ReferenceRequestAuth;
}): Promise<{ event: Record<string, unknown>; timeline: unknown[] } | null> {
  let latestTimeline: unknown[] = [];
  while (Date.now() - input.startedAt <= input.timeoutMs) {
    latestTimeline = await readReferenceMissionTimeline(input.baseUrl, input.missionId, input.requestAuth);
    const event = latestTimeline.find((item): item is Record<string, unknown> => {
      if (typeof item !== "object" || item === null) return false;
      const runtime = typeof (item as { runtime?: unknown }).runtime === "object" && (item as { runtime?: unknown }).runtime !== null
        ? (item as { runtime: Record<string, unknown> }).runtime
        : {};
      return readString(runtime.toolPhase) === "call" && Boolean(readString(runtime.toolCallId));
    });
    if (event) return { event, timeline: latestTimeline };
    await sleep(input.pollMs);
  }
  return null;
}

async function waitForReferenceMissionCancelled(input: {
  baseUrl: string;
  missionId: string;
  startedAt: number;
  timeoutMs: number;
  pollMs: number;
  requestAuth?: ReferenceRequestAuth;
}): Promise<{ event: Record<string, unknown>; timeline: unknown[] } | null> {
  let latestTimeline: unknown[] = [];
  while (Date.now() - input.startedAt <= input.timeoutMs) {
    latestTimeline = await readReferenceMissionTimeline(input.baseUrl, input.missionId, input.requestAuth);
    const event = latestTimeline.find((item): item is Record<string, unknown> => isMissionCancelledTimelineEvent(item));
    if (event) return { event, timeline: latestTimeline };
    await sleep(input.pollMs);
  }
  return null;
}

async function readReferenceMissionTimeline(
  baseUrl: string,
  missionId: string,
  requestAuth?: ReferenceRequestAuth
): Promise<unknown[]> {
  const timeline = await getJson(baseUrl, `/missions/${encodeURIComponent(missionId)}/timeline?limit=300`, requestAuth);
  return readArray(timeline);
}

function buildActiveCancellationCloseoutSummary(cancellationEvidence: unknown[]): string {
  if (!hasReferenceActiveCancellationEvidence(cancellationEvidence)) return "";
  const cancelEvent = findCancellationEvidenceEvent(cancellationEvidence);
  const eventText = readString(cancelEvent?.text);
  return [
    eventText ??
      "Mission cancelled by the operator. Active work was stopped before completion; verified evidence may be incomplete, unverified source checks remain, and the user can continue later if they want to resume.",
    "Reference collector observed active cancellation evidence from the mission timeline.",
    "No source facts should be treated as verified beyond the cancellation event itself.",
  ].join(" ");
}

function hasReferenceActiveCancellationEvidence(cancellationEvidence: unknown[]): boolean {
  return cancellationEvidence.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    const record = item as Record<string, unknown>;
    return readString(record.status) === "mission_cancelled" && isMissionCancelledTimelineEvent(record.event);
  });
}

function findCancellationEvidenceEvent(cancellationEvidence: unknown[]): Record<string, unknown> | null {
  for (const item of cancellationEvidence) {
    if (typeof item !== "object" || item === null) continue;
    const event = (item as Record<string, unknown>).event;
    if (isMissionCancelledTimelineEvent(event)) return event;
  }
  return null;
}

function extractToolCallsFromCancellationEvidence(cancellationEvidence: unknown[]): unknown[] {
  return cancellationEvidence.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (readString(record.status) !== "observed_tool_call") return [];
    const event = typeof record.event === "object" && record.event !== null ? record.event as Record<string, unknown> : {};
    const runtime = typeof event.runtime === "object" && event.runtime !== null ? event.runtime as Record<string, unknown> : {};
    const toolCallId = readString(runtime.toolCallId);
    if (!toolCallId) return [];
    return [
      {
        source: "mission_timeline",
        id: toolCallId,
        messageId: readString(runtime.messageId) ?? undefined,
        name: readString(runtime.toolName) ?? "tool",
        event,
      },
    ];
  });
}

function extractToolResultsFromCancellationEvidence(cancellationEvidence: unknown[]): unknown[] {
  return cancellationEvidence.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (readString(record.status) !== "mission_cancelled") return [];
    const event = typeof record.event === "object" && record.event !== null ? record.event as Record<string, unknown> : {};
    return [
      {
        source: "mission_timeline",
        name: "mission.cancelled",
        status: "cancelled",
        content: readString(event.text) ?? "mission cancelled",
        event,
      },
    ];
  });
}

function isMissionCancelledTimelineEvent(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const runtime = typeof record.runtime === "object" && record.runtime !== null ? record.runtime as Record<string, unknown> : {};
  return readString(runtime.eventType) === "mission.cancelled" || readArray(record.tags).some((tag) => readString(tag) === "mission_cancelled");
}

async function readReferenceModelCatalog(baseUrl: string, requestAuth?: ReferenceRequestAuth): Promise<unknown> {
  try {
    return await getJson(baseUrl, "/models", requestAuth);
  } catch {
    return null;
  }
}

async function driveReferenceMemoryScenario(input: {
  task: ReferenceCollectionTask;
  options: ReferenceCollectOptions;
  scenarioDriver: ReferenceScenarioDriver;
  baseUrl: string;
  startedAt: number;
  requestAuth?: ReferenceRequestAuth;
}): Promise<{
  apiEndpoint: string;
  exactRequestPayload: Record<string, unknown>;
  rawResponse: unknown;
  threadId: string;
  missionId?: string;
  rawTranscript: unknown[];
  rawToolCalls: unknown[];
  rawToolResults: unknown[];
  rawMemoryEvidence: unknown[];
  finalText: string;
  timedOut: boolean;
  firstSummaryToolCallCount: number;
  firstSummaryToolResultCount: number;
}> {
  const runtimeRoot = resolveReferenceRuntimeRoot(input.options);
  const setupPrompt =
    input.scenarioDriver.kind === "memory_pressure_flush"
      ? buildReferenceMemoryPressureSetupPrompt()
      : input.scenarioDriver.kind === "memory_thread"
        ? buildReferenceMemoryRecallSetupPrompt()
      : buildReferenceMemoryInvalidationSetupPrompt();
  const initialMissionPayload = {
    title:
      input.scenarioDriver.kind === "memory_pressure_flush"
        ? "Reference memory pressure flush"
        : input.scenarioDriver.kind === "memory_thread"
          ? "Reference memory recall"
        : "Reference memory invalidation",
    desc: setupPrompt,
    mode: input.scenarioDriver.missionMode,
    owner: "reference-collector",
    ownerLabel: "Reference Collector",
  };
  const rawMission = await postJson(input.baseUrl, "/missions", initialMissionPayload, input.requestAuth, {
    timeoutMs: Math.min(input.options.timeoutMs, 30_000),
  });
  const threadId = readThreadId(rawMission);
  const missionId = readString((rawMission as { id?: unknown } | null)?.id) ?? undefined;
  if (!threadId) throw new Error("memory scenario mission creation response did not include threadId");
  if (!missionId) throw new Error("memory scenario mission creation response did not include mission id");

  const rawMemoryEvidence: unknown[] = [];
  const setupPoll = await pollReferenceMessages({
    baseUrl: input.baseUrl,
    threadId,
    startedAt: input.startedAt,
    timeoutMs: input.options.timeoutMs,
    pollMs: input.options.pollMs,
    requestAuth: input.requestAuth,
    allowTextOnlyCompletion: true,
  });
  rawMemoryEvidence.push({
    source: "memory_driver",
    phase: "setup",
    timedOut: setupPoll.timedOut,
    finalText: setupPoll.finalText,
    ...(runtimeRoot ? { memory: readReferenceThreadMemorySnapshot(runtimeRoot, threadId) } : {}),
  });

  if (input.scenarioDriver.kind === "memory_thread") {
    if (!runtimeRoot) {
      throw new Error("memory_thread reference collection requires --reference-runtime-root or TURNKEYAI_HOME");
    }
    seedReferenceMemoryRecallFixture({ runtimeRoot, threadId });
    rawMemoryEvidence.push({
      source: "memory_driver",
      phase: "seed",
      memory: readReferenceThreadMemorySnapshot(runtimeRoot, threadId),
    });
  }

  let correctionPrompt: string | undefined;
  let rawCorrectionResponse: unknown = null;
  let correctionPoll: Awaited<ReturnType<typeof pollReferenceMessages>> | null = null;
  if (input.scenarioDriver.kind === "memory_invalidation") {
    if (!runtimeRoot) {
      throw new Error("memory_invalidation reference collection requires --reference-runtime-root or TURNKEYAI_HOME");
    }
    seedReferenceMemoryInvalidationFixture({ runtimeRoot, threadId });
    rawMemoryEvidence.push({
      source: "memory_driver",
      phase: "stale_seed",
      memory: readReferenceThreadMemorySnapshot(runtimeRoot, threadId),
    });
    correctionPrompt = buildReferenceMemoryInvalidationCorrectionPrompt();
    rawCorrectionResponse = await postJson(
      input.baseUrl,
      `/missions/${encodeURIComponent(missionId)}/messages`,
      { content: correctionPrompt },
      input.requestAuth,
      {
        timeoutMs: Math.min(input.options.timeoutMs, 30_000),
      }
    );
    const correctionStartedAt = Date.now();
    correctionPoll = await pollReferenceMessages({
      baseUrl: input.baseUrl,
      threadId,
      startedAt: correctionStartedAt,
      timeoutMs: input.options.timeoutMs,
      pollMs: input.options.pollMs,
      requestAuth: input.requestAuth,
      afterUserContent: correctionPrompt,
      allowTextOnlyCompletion: true,
    });
    rawMemoryEvidence.push({
      source: "memory_driver",
      phase: "correction",
      timedOut: correctionPoll.timedOut,
      finalText: correctionPoll.finalText,
      memory: readReferenceThreadMemorySnapshot(runtimeRoot, threadId),
    });
  }

  const rawFollowupResponse = await postJson(
    input.baseUrl,
    `/missions/${encodeURIComponent(missionId)}/messages`,
    { content: input.task.prompt },
    input.requestAuth,
    {
      timeoutMs: Math.min(input.options.timeoutMs, 30_000),
    }
  );
  const followupStartedAt = Date.now();
  const followupPoll = await pollReferenceMessages({
    baseUrl: input.baseUrl,
    threadId,
    startedAt: followupStartedAt,
    timeoutMs: input.options.timeoutMs,
    pollMs: input.options.pollMs,
    requestAuth: input.requestAuth,
    afterUserContent: input.task.prompt,
  });
  const followupMessages = sliceMessagesAfterUserContent(followupPoll.messages, input.task.prompt);
  const followupToolCalls = dedupeReferenceToolCalls(extractToolCalls(followupMessages));
  const followupToolResults = extractToolResults(followupMessages);
  rawMemoryEvidence.push({
    source: "memory_driver",
    phase: "final_recall",
    timedOut: followupPoll.timedOut,
    finalText: followupPoll.finalText,
    ...(runtimeRoot ? { memory: readReferenceThreadMemorySnapshot(runtimeRoot, threadId) } : {}),
  });

  return {
    apiEndpoint: "/missions",
    exactRequestPayload: {
      prompt: input.task.prompt,
      initialMissionPayload,
      ...(correctionPrompt ? { correction: { content: correctionPrompt } } : {}),
      followup: { content: input.task.prompt },
    },
    rawResponse: {
      mission: rawMission,
      setup: { timedOut: setupPoll.timedOut, finalText: setupPoll.finalText },
      ...(rawCorrectionResponse ? { correction: rawCorrectionResponse } : {}),
      ...(correctionPoll ? { correctionPoll: { timedOut: correctionPoll.timedOut, finalText: correctionPoll.finalText } } : {}),
      followup: rawFollowupResponse,
    },
    threadId,
    missionId,
    rawTranscript: followupPoll.messages,
    rawToolCalls: dedupeReferenceToolCalls(extractToolCalls(followupPoll.messages)),
    rawToolResults: extractToolResults(followupPoll.messages),
    rawMemoryEvidence,
    finalText: followupPoll.finalText,
    timedOut: followupPoll.timedOut && !followupPoll.finalText,
    firstSummaryToolCallCount: followupToolCalls.length,
    firstSummaryToolResultCount: followupToolResults.length,
  };
}

function resolveReferenceRuntimeRoot(options: ReferenceCollectOptions): string | undefined {
  return options.referenceRuntimeRoot ?? process.env.TURNKEYAI_REFERENCE_RUNTIME_ROOT ?? process.env.TURNKEYAI_HOME;
}

function buildReferenceMemoryInvalidationSetupPrompt(): string {
  return [
    "Start a launch-planning thread for Borealis-23.",
    "No research is needed yet; briefly acknowledge that the mission can continue when launch context is available.",
  ].join("\n");
}

function buildReferenceMemoryRecallSetupPrompt(): string {
  return [
    "Start a launch-planning thread for Helios-47.",
    "No research is needed yet; briefly acknowledge that the mission can continue when launch context is available.",
  ].join("\n");
}

function buildReferenceFollowupContinuationPrompt(scenarioId?: string): string {
  if (
    scenarioId === "natural-browser-followup-continuation" ||
    scenarioId === "natural-browser-restart-continuation" ||
    scenarioId === "natural-browser-cold-recreation-continuation"
  ) {
    return [
      "Continue from the previous browser dashboard review in this same conversation.",
      "Re-check the rendered dashboard state as a user would see it in the browser, using the same URL or safely reopening it if needed.",
      "Confirm whether the operational state, escalation trigger, owner, and next operator action are still supported by rendered browser evidence.",
      "Keep the answer source-bounded and call out anything that remains unverified.",
    ].join("\n");
  }
  return [
    "Continue from the previous work on this mission.",
    "Ask the same Vendor Alpha research thread to revisit its notes and turn the evidence into a decision note for a product lead.",
    "Keep continuity with that earlier research thread rather than starting the same Vendor Alpha work from scratch.",
    "Keep the answer source-bounded and call out any remaining risk or uncertainty from the collected evidence.",
  ].join("\n");
}

function buildReferenceMemoryInvalidationCorrectionPrompt(): string {
  return [
    "Update the Borealis-23 launch context.",
    "Remember this correction for Borealis-23 going forward: launch window is Thursday 16:45, owner is Ops Captain, residual risk is payment processor signoff pending.",
    "The previous Borealis-23 note is stale and must not be used going forward.",
    "Briefly acknowledge the corrected launch context.",
  ].join("\n");
}

function buildReferenceMemoryPressureSetupPrompt(): string {
  const durableBrief = [
    "Please turn this long launch handoff into a concise internal continuity note.",
    "Important durable facts near the top of the handoff:",
    "Project codename: Aurora-19.",
    "Launch window: Friday 14:15.",
    "Owner: Field Ops Lead.",
    "Hard constraint: keep the external announcement conditional until Legal Review has confirmed the data-processing addendum.",
    "Residual risk: the vendor dry-run note is still unverified, so external commitments should stay conditional.",
    "The rest of this handoff is intentionally verbose meeting background. Preserve durable decisions and constraints; do not invent external facts.",
  ].join("\n");
  const fillerParagraph = [
    "Background note:",
    "The launch team reviewed dependency owners, operational readiness, customer messaging, partner status, and handover expectations.",
    "Most of the remaining text repeats status context so the handoff behaves like a pasted planning document rather than a synthetic protocol test.",
    "Only durable decisions, owners, constraints, unresolved questions, and carry-forward risks should matter after summarization.",
  ].join(" ");
  const filler = Array.from({ length: 1_600 }, (_, index) => `${index + 1}. ${fillerParagraph}`).join("\n");
  return [durableBrief, filler, "Please summarize the durable continuity note in a short, useful way for the launch lead."].join("\n\n");
}

function seedReferenceMemoryInvalidationFixture(input: { runtimeRoot: string; threadId: string }): void {
  writeReferenceThreadMemoryRecord(input.runtimeRoot, {
    threadId: input.threadId,
    updatedAt: Date.now(),
    preferences: [],
    constraints: [
      "Borealis-23 launch window is Monday 10:15; owner is Launch Manager; residual risk is staging checklist pending.",
    ],
    longTermNotes: [],
  });
}

function seedReferenceMemoryRecallFixture(input: { runtimeRoot: string; threadId: string }): void {
  writeReferenceThreadMemoryRecord(input.runtimeRoot, {
    threadId: input.threadId,
    updatedAt: Date.now(),
    preferences: [
      "For memory recall acceptance, prefer source-backed launch briefs over unstated assumptions.",
    ],
    constraints: [
      "When asked about Helios-47, use the durable memory launch window exactly as written.",
    ],
    longTermNotes: [
      "Helios-47 launch window is Tuesday 09:30. Owner is Release Captain. Residual risk: calendar lock is remembered locally and should be verified before external release announcements.",
    ],
  });
}

function writeAccioAgentCoreMemorySeed(input: {
  accioHome: string;
  accountId: string;
  agentId: string;
}): { path: string; content: string } {
  const memoryDir = path.join(input.accioHome, "accounts", input.accountId, "agents", input.agentId, "agent-core");
  const memoryPath = path.join(memoryDir, "MEMORY.md");
  const content = [
    "## Reference A/B durable memory seed",
    "",
    "- Source: TurnkeyAI natural-memory-recall fixture parity seed, 2026-06-06.",
    "- Helios-47 launch window is Tuesday 09:30.",
    "- Owner is Release Captain.",
    "- Residual risk: calendar lock is remembered locally and should be verified before external release announcements.",
    "- When asked about Helios-47, use the durable memory launch window exactly as written and inspect the memory entry before relying on it.",
    "",
  ].join("\n");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(memoryPath, content);
  return { path: memoryPath, content };
}

function readReferenceThreadMemorySnapshot(runtimeRoot: string, threadId: string): unknown {
  try {
    return JSON.parse(readFileSync(referenceThreadMemoryPath(runtimeRoot, threadId), "utf8")) as unknown;
  } catch (error) {
    return {
      missing: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function writeReferenceThreadMemoryRecord(
  runtimeRoot: string,
  record: {
    threadId: string;
    updatedAt: number;
    preferences: string[];
    constraints: string[];
    longTermNotes: string[];
  }
): void {
  const filePath = referenceThreadMemoryPath(runtimeRoot, record.threadId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

function referenceThreadMemoryPath(runtimeRoot: string, threadId: string): string {
  return path.join(runtimeRoot, "data", "context", "thread-memory", `${encodeURIComponent(threadId)}.json`);
}

export function referenceScenarioDriverFor(scenarioId: string): ReferenceScenarioDriver {
  const singlePrompt: ReferenceScenarioDriver = {
    kind: "single_prompt",
    supported: true,
    missionThread: false,
    missionMode: referenceMissionMode(scenarioId),
  };
  if (scenarioId === "natural-approval-dry-run-action") {
    return {
      kind: "mission_prompt",
      supported: true,
      missionThread: true,
      missionMode: "browser",
      approvalDecisionPolicy: "approved",
    };
  }
  if (scenarioId === "natural-approval-denied-safe-closeout") {
    return {
      kind: "mission_prompt",
      supported: true,
      missionThread: true,
      missionMode: "browser",
      approvalDecisionPolicy: "denied",
    };
  }
  if (scenarioId === "natural-approval-pending-state") {
    return {
      kind: "mission_prompt",
      supported: true,
      missionThread: true,
      missionMode: "browser",
      approvalDecisionPolicy: "pending",
    };
  }
  if (scenarioId === "natural-approval-wait-timeout-closeout") {
    return {
      kind: "mission_prompt",
      supported: true,
      missionThread: true,
      missionMode: "browser",
      approvalDecisionPolicy: "wait_timeout",
      envRequirements: {
        TURNKEYAI_TOOL_PERMISSION_WAIT_MS: "2000",
      },
    };
  }
  if (scenarioId === "natural-memory-recall") {
    return {
      kind: "memory_thread",
      supported: true,
      missionThread: true,
      missionMode: "custom",
    };
  }
  if (scenarioId === "natural-memory-pressure-flush") {
    return {
      kind: "memory_pressure_flush",
      supported: true,
      missionThread: true,
      missionMode: "custom",
      envRequirements: {
        TURNKEYAI_REQUEST_ENVELOPE_MAX_PROMPT_CHARS: "20000",
        TURNKEYAI_REQUEST_ENVELOPE_MAX_PROMPT_BYTES: "30000",
      },
    };
  }
  if (scenarioId === "natural-memory-invalidation") {
    return {
      kind: "memory_invalidation",
      supported: true,
      missionThread: true,
      missionMode: "custom",
    };
  }
  if (scenarioId === "natural-tool-result-pruning") {
    return {
      kind: "tool_result_pruning",
      supported: true,
      missionThread: true,
      missionMode: "research",
      envRequirements: {
        TURNKEYAI_TOOL_RESULT_RECENT_FULL_COUNT: "1",
        TURNKEYAI_TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES: "5000",
        TURNKEYAI_TOOL_RESULT_SOFT_PRUNE_MAX_BYTES: "1800",
        TURNKEYAI_TOOL_RESULT_HARD_PRUNE_MAX_BYTES: "12000",
      },
    };
  }
  if (scenarioId === "natural-followup-continuation") {
    return {
      kind: "followup_thread",
      supported: true,
      missionThread: true,
      missionMode: "research",
    };
  }
  if (
    scenarioId === "natural-browser-followup-continuation" ||
    scenarioId === "natural-browser-restart-continuation" ||
    scenarioId === "natural-browser-cold-recreation-continuation"
  ) {
    return {
      kind: "followup_thread",
      supported: true,
      missionThread: true,
      missionMode: "browser",
    };
  }
  if (scenarioId === "natural-timeout-partial-closeout") {
    return {
      kind: "timeout_partial",
      supported: true,
      missionThread: true,
      missionMode: "research",
    };
  }
  if (scenarioId === "natural-timeout-followup-continuation") {
    return {
      kind: "timeout_followup",
      supported: true,
      missionThread: true,
      missionMode: "research",
    };
  }
  if (scenarioId === "natural-cancel-active-tool") {
    return {
      kind: "cancel_active",
      supported: true,
      missionThread: true,
      missionMode: "research",
    };
  }
  if (scenarioId === "natural-cancel-followup-continuation") {
    return {
      kind: "cancel_followup",
      supported: true,
      missionThread: true,
      missionMode: "research",
    };
  }
  if (/approval/i.test(scenarioId)) {
    return {
      kind: "mission_prompt",
      supported: true,
      missionThread: true,
      missionMode: "browser",
      approvalDecisionPolicy: "approved",
    };
  }
  return singlePrompt;
}

function unsupportedAccioWsScenarioReason(driver: ReferenceScenarioDriver): string | null {
  if (driver.kind === "cancel_active" || driver.kind === "cancel_followup") {
    return "accio_ws_reference_does_not_expose_active_cancellation_driver";
  }
  return null;
}

function unsupportedScenarioDriver(
  kind: ReferenceScenarioDriver["kind"],
  unsupportedReason: string,
  envRequirements?: Record<string, string>
): ReferenceScenarioDriver {
  return {
    kind,
    supported: false,
    missionThread: false,
    missionMode: "custom",
    unsupportedReason,
    ...(envRequirements ? { envRequirements } : {}),
  };
}

function referenceMissionMode(scenarioId: string): string {
  if (/browser|approval/i.test(scenarioId)) return "browser";
  if (/research|comparison|long-delegation/i.test(scenarioId)) return "research";
  return "custom";
}

function inferReferenceModelInfo(modelCatalog: unknown): { provider: string; modelId: string } {
  if (typeof modelCatalog !== "object" || modelCatalog === null) {
    return { provider: "unknown", modelId: "unknown" };
  }
  const catalog = modelCatalog as { defaultModelId?: unknown; models?: unknown };
  const accioProviders = readArray((modelCatalog as { data?: unknown }).data).filter(
    (provider): provider is Record<string, unknown> => typeof provider === "object" && provider !== null
  );
  for (const provider of accioProviders) {
    const providerId = readString(provider.provider);
    const models = readArray(provider.modelList).filter(
      (model): model is Record<string, unknown> => typeof model === "object" && model !== null
    );
    const selected = models.find((model) => model.isDefault === true) ?? models[0];
    const modelId = readString(selected?.modelName);
    if (providerId && modelId) return { provider: providerId, modelId };
  }
  const models = readArray(catalog.models).filter(
    (model): model is Record<string, unknown> => typeof model === "object" && model !== null
  );
  const defaultModelId = readString(catalog.defaultModelId);
  const selected =
    models.find((model) => defaultModelId && readString(model.id) === defaultModelId) ??
    models.find((model) => model.configured === true) ??
    models[0];
  if (!selected) {
    return { provider: "unknown", modelId: "unknown" };
  }
  return {
    provider: readString(selected.providerId) ?? readString(selected.provider) ?? "unknown",
    modelId: readString(selected.model) ?? readString(selected.modelId) ?? readString(selected.id) ?? "unknown",
  };
}

async function pollReferenceMessages(input: {
  baseUrl: string;
  threadId: string;
  startedAt: number;
  timeoutMs: number;
  pollMs: number;
  requestAuth?: ReferenceRequestAuth;
  approvalDriver?: { missionId: string; policy: ReferenceApprovalDecisionPolicy };
  afterMessageCount?: number;
  afterUserContent?: string;
  allowTextOnlyCompletion?: boolean;
}): Promise<{ messages: unknown[]; finalText: string; timedOut: boolean; approvalEvidence: unknown[] }> {
  let messages: unknown[] = [];
  const approvalEvidence: unknown[] = [];
  const decidedApprovalIds = new Set<string>();
  while (Date.now() - input.startedAt <= input.timeoutMs) {
    const response = await getJson(
      input.baseUrl,
      `/messages?threadId=${encodeURIComponent(input.threadId)}`,
      input.requestAuth
    );
    messages = Array.isArray(response) ? response : Array.isArray((response as { messages?: unknown }).messages) ? (response as { messages: unknown[] }).messages : [];
    if (input.approvalDriver) {
      approvalEvidence.push(
        ...(await driveReferenceApprovalDecisions({
          baseUrl: input.baseUrl,
          missionId: input.approvalDriver.missionId,
          policy: input.approvalDriver.policy,
          requestAuth: input.requestAuth,
          decidedApprovalIds,
        }))
      );
      if (
        input.approvalDriver.policy === "pending" &&
        approvalEvidence.some((evidence) => readString((evidence as { status?: unknown }).status) === "observed_pending")
      ) {
        return { messages, finalText: readLatestAssistantText(messages), timedOut: false, approvalEvidence };
      }
    }
    const scopedMessages = scopeReferenceMessages(messages, input);
    if (input.allowTextOnlyCompletion) {
      const finalText = readLatestAssistantText(scopedMessages);
      if (finalText) return { messages, finalText, timedOut: false, approvalEvidence };
    }
    const completion = readReferenceCompletion(scopedMessages);
    if (completion.ready) return { messages, finalText: completion.finalText, timedOut: false, approvalEvidence };
    await sleep(input.pollMs);
  }
  return {
    messages,
    finalText: readLatestAssistantText(scopeReferenceMessages(messages, input)),
    timedOut: true,
    approvalEvidence,
  };
}

function scopeReferenceMessages(
  messages: unknown[],
  input: { afterMessageCount?: number; afterUserContent?: string }
): unknown[] {
  if (input.afterUserContent) return sliceMessagesAfterUserContent(messages, input.afterUserContent);
  return messages.slice(input.afterMessageCount ?? 0);
}

function sliceMessagesAfterUserContent(messages: unknown[], userContent: string): unknown[] {
  const index = findLastUserMessageIndex(messages, userContent);
  return index >= 0 ? messages.slice(index + 1) : [];
}

function findLastUserMessageIndex(messages: unknown[], userContent: string): number {
  const expected = normalizeReferenceText(userContent);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const record = message as { role?: unknown; content?: unknown; text?: unknown };
    if (readString(record.role) !== "user") continue;
    const actual = normalizeReferenceText(readMessageText(record.content) ?? readString(record.text) ?? "");
    if (actual === expected) return index;
  }
  return -1;
}

function normalizeReferenceText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildReferenceCancelFollowupPrompt(): string {
  return [
    "Continue from the cancelled source-check attempt in this mission.",
    "Resume the existing source-check context if possible, let the source finish now, and turn the outcome into a release-risk note.",
    "Separate verified facts from unverified items, describe residual risk, and explain how the earlier cancellation affects confidence.",
  ].join("\n");
}

function buildReferenceApprovalDeniedFollowupPrompt(): string {
  return [
    "Operator decision: denied.",
    "Do not submit the browser form and do not apply the approval-gated action.",
    "Close out with what approval was requested, that the dry-run form submission did not run, and the safest next action.",
  ].join("\n");
}

function buildReferenceTimeoutFollowupPrompt(originalPrompt: string): string {
  return [
    "Continue from the bounded timeout closeout in this mission.",
    "Resume the same source-check context for the slow source from the original request.",
    "Use the timeout evidence already observed in this mission; do not switch to a generic environment-access explanation.",
    "If the source still has not produced content, write the release-risk note from verified timeout evidence only and explain how the mission can continue.",
    "Original request:",
    originalPrompt,
  ].join("\n");
}

async function driveReferenceApprovalDecisions(input: {
  baseUrl: string;
  missionId: string;
  policy: ReferenceApprovalDecisionPolicy;
  requestAuth?: ReferenceRequestAuth;
  decidedApprovalIds: Set<string>;
}): Promise<unknown[]> {
  const evidence: unknown[] = [];
  let approvals: unknown;
  try {
    approvals = await getJson(input.baseUrl, "/approvals", input.requestAuth);
  } catch (error) {
    return [
      {
        source: "approvals",
        status: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      },
    ];
  }
  const pending = readArray(approvals)
    .filter((approval): approval is Record<string, unknown> => typeof approval === "object" && approval !== null)
    .filter((approval) => readString(approval.missionId) === input.missionId)
    .filter((approval) => !input.decidedApprovalIds.has(readString(approval.id) ?? ""))
    .filter((approval) => approval.decision == null);
  for (const approval of pending) {
    const approvalId = readString(approval.id);
    if (!approvalId) continue;
    if (input.policy === "pending" || input.policy === "wait_timeout") {
      input.decidedApprovalIds.add(approvalId);
      evidence.push({
        source: "approval_driver",
        status: "observed_pending",
        approvalId,
        missionId: input.missionId,
        approval,
      });
      continue;
    }
    const decisionPayload = {
      decision: input.policy,
      decidedBy: "reference-collector",
      reason:
        input.policy === "approved"
          ? `approving isolated local dry-run action ${readString(approval.action) ?? "approval-gated action"} for same-scenario A/B reference collection`
          : `denying isolated local dry-run action ${readString(approval.action) ?? "approval-gated action"} to mirror same-scenario A/B denied-approval behavior`,
    };
    try {
      const decision = await postJson(
        input.baseUrl,
        `/approvals/${encodeURIComponent(approvalId)}/decision`,
        decisionPayload,
        input.requestAuth,
        { timeoutMs: 30_000 }
      );
      input.decidedApprovalIds.add(approvalId);
      evidence.push({
        source: "approval_driver",
        approvalId,
        missionId: input.missionId,
        approval,
        decisionPayload,
        decision,
      });
    } catch (error) {
      evidence.push({
        source: "approval_driver",
        approvalId,
        missionId: input.missionId,
        status: "decision_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return evidence;
}

async function readBrowserEvidence(
  baseUrl: string,
  threadId: string,
  requestAuth?: ReferenceRequestAuth
): Promise<unknown[]> {
  try {
    const sessions = await getJson(baseUrl, `/browser-sessions?threadId=${encodeURIComponent(threadId)}`, requestAuth);
    if (!Array.isArray(sessions)) return [sessions];
    const evidence: unknown[] = [{ sessions }];
    for (const session of sessions) {
      if (typeof session !== "object" || session === null) continue;
      const sessionId =
        readString((session as { sessionId?: unknown }).sessionId) ??
        readString((session as { browserSessionId?: unknown }).browserSessionId);
      if (!sessionId) continue;
      try {
        const history = await getJson(
          baseUrl,
          `/browser-sessions/${encodeURIComponent(sessionId)}/history?threadId=${encodeURIComponent(threadId)}&limit=50`,
          requestAuth
        );
        evidence.push({ sessionId, history });
      } catch {
        evidence.push({ sessionId, historyError: "unavailable" });
      }
    }
    return evidence;
  } catch {
    return [];
  }
}

async function readFlowEvidence(
  baseUrl: string,
  threadId: string,
  requestAuth?: ReferenceRequestAuth
): Promise<unknown[]> {
  const evidence: unknown[] = [];
  try {
    evidence.push({ flows: await getJson(baseUrl, `/flows?threadId=${encodeURIComponent(threadId)}`, requestAuth) });
  } catch {
    evidence.push({ flowsError: "unavailable" });
  }
  try {
    evidence.push({
      flowsSummary: await getJson(baseUrl, `/flows-summary?threadId=${encodeURIComponent(threadId)}`, requestAuth),
    });
  } catch {
    evidence.push({ flowsSummaryError: "unavailable" });
  }
  try {
    evidence.push({
      runtimeChains: await getJson(baseUrl, `/runtime-chains?threadId=${encodeURIComponent(threadId)}`, requestAuth),
    });
  } catch {
    evidence.push({ runtimeChainsError: "unavailable" });
  }
  return evidence;
}

function readNaturalFixtureContentHashes(
  manifest: ReferenceCollectionTaskManifest,
  taskDir: string
): Record<string, string> {
  const naturalReportPath = readString(manifest.naturalReportPath);
  if (!naturalReportPath) return {};
  try {
    const report = readJsonFile<{
      fixtureContentHashes?: unknown;
      fixtureManifest?: { fixtureContentHashes?: unknown };
    }>(path.resolve(taskDir, naturalReportPath));
    const fixtureContentHashes =
      typeof report.fixtureManifest?.fixtureContentHashes === "object" &&
      report.fixtureManifest.fixtureContentHashes !== null
        ? report.fixtureManifest.fixtureContentHashes
        : report.fixtureContentHashes;
    if (typeof fixtureContentHashes !== "object" || fixtureContentHashes === null) return {};
    return Object.fromEntries(
      Object.entries(fixtureContentHashes as Record<string, unknown>).flatMap(([url, hash]) =>
        typeof hash === "string" && hash.trim() ? [[canonicalizeComparableUrl(url), hash.trim()] as const] : []
      )
    );
  } catch {
    return {};
  }
}

function selectFixtureContentHashesForPrompt(
  prompt: string,
  fixtureContentHashes: Record<string, string>
): Record<string, string> {
  const urls = extractComparableUrls(prompt);
  return Object.fromEntries(
    urls.flatMap((url) => {
      const hash = fixtureContentHashes[url];
      return hash ? [[url, hash] as const] : [];
    })
  );
}

function extractComparableUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s"'<>),]+/gi) ?? [];
  return [...new Set(matches.map((url) => canonicalizeComparableUrl(url)).filter(Boolean))].sort();
}

function canonicalizeComparableUrl(rawUrl: string): string {
  const cleaned = rawUrl.replace(/[.;:,]+$/g, "");
  if (cleaned.includes("://<loopback-host>:<loopback-port>/")) return cleaned;
  try {
    const url = new URL(cleaned);
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      return `${url.protocol}//<loopback-host>:<loopback-port>${url.pathname}${url.search}`;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function readCollectionTasks(manifest: ReferenceCollectionTaskManifest): ReferenceCollectionTask[] {
  if (manifest.kind !== "turnkeyai.real-llm-ab-reference-collection-tasks.manifest") {
    throw new Error("--tasks does not point to a reference collection task manifest");
  }
  if (!Array.isArray(manifest.tasks)) throw new Error("reference collection task manifest has no tasks array");
  return manifest.tasks.map((task, index) => {
    if (typeof task !== "object" || task === null) throw new Error(`task ${index} is not an object`);
    const record = task as {
      scenarioId?: unknown;
      prompt?: unknown;
      expectedReferenceArtifactPath?: unknown;
      action?: unknown;
    };
    const scenarioId = readString(record.scenarioId);
    const prompt = readString(record.prompt);
    const expectedReferenceArtifactPath = readString(record.expectedReferenceArtifactPath);
    if (!scenarioId) throw new Error(`task ${index} missing scenarioId`);
    if (!prompt) throw new Error(`task ${scenarioId} missing prompt`);
    if (!expectedReferenceArtifactPath) throw new Error(`task ${scenarioId} missing expectedReferenceArtifactPath`);
    if (record.action !== "collect_reference_artifact" && record.action !== "recollect_reference_artifact") {
      throw new Error(`task ${scenarioId} has invalid action`);
    }
    return {
      scenarioId,
      prompt,
      expectedReferenceArtifactPath,
      action: record.action,
    };
  });
}

async function postJson(
  baseUrl: string,
  route: string,
  body: unknown,
  requestAuth?: ReferenceRequestAuth,
  options: { timeoutMs?: number } = {}
): Promise<unknown> {
  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => {
        controller.abort();
      }, options.timeoutMs)
    : null;
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}${route}`, {
      method: "POST",
      headers: buildReferenceHeaders(true, requestAuth),
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    return await readFetchJson(response, route);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function getJson(baseUrl: string, route: string, requestAuth?: ReferenceRequestAuth): Promise<unknown> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${route}`, {
    headers: buildReferenceHeaders(false, requestAuth),
  });
  return readFetchJson(response, route);
}

interface ReferenceRequestAuth {
  authorization: string;
}

function buildReferenceRequestAuth(token: string | undefined): ReferenceRequestAuth | undefined {
  const trimmed = token?.trim();
  return trimmed ? { authorization: `Bearer ${trimmed}` } : undefined;
}

function buildReferenceHeaders(hasJsonBody: boolean, requestAuth: ReferenceRequestAuth | undefined): HeadersInit | undefined {
  const headers: Record<string, string> = {};
  if (hasJsonBody) {
    headers["content-type"] = "application/json";
  }
  if (requestAuth) {
    headers.authorization = requestAuth.authorization;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

async function readFetchJson(response: Response, route: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as unknown) : null;
}

function readThreadId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  return readString((value as { thread?: { threadId?: unknown }; threadId?: unknown }).thread?.threadId) ?? readString((value as { threadId?: unknown }).threadId);
}

function readLatestAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const record = message as { role?: unknown; content?: unknown; text?: unknown };
    if (readString(record.role) !== "assistant") continue;
    const text = readMessageText(record.content) ?? readString(record.text);
    if (text) return text;
  }
  return "";
}

export function readReferenceCompletion(
  messages: unknown[],
  options: { approvalDecisionPolicy?: ReferenceApprovalDecisionPolicy } = {}
): { finalText: string; ready: boolean } {
  const finalText = readLatestAssistantText(messages);
  if (!finalText) return { finalText: "", ready: false };
  if (!latestAssistantFollowsLatestToolResult(messages)) return { finalText, ready: false };
  const pendingToolCalls = readPendingReferenceToolCalls(messages);
  if (pendingToolCalls.length > 0) return { finalText, ready: false };
  const expectedPendingApprovalFinal =
    options.approvalDecisionPolicy === "pending" && isExpectedPendingApprovalFinal(finalText);
  if (
    isWeakReferenceAnswer(finalText) &&
    !expectedPendingApprovalFinal &&
    !hasApprovalWaitTimeoutCloseoutEvidence(finalText)
  ) {
    return { finalText, ready: false };
  }
  const toolCallCount = dedupeReferenceToolCalls(extractToolCalls(messages)).length;
  const toolResultCount = extractToolResults(messages).length;
  if (toolCallCount === 0 || toolResultCount > 0) {
    return { finalText, ready: true };
  }
  return { finalText, ready: false };
}

export function isExpectedPendingApprovalFinal(text: string): boolean {
  return (
    /\b(?:approval|authorization|permission)\b[\s\S]{0,160}\b(?:pending|awaiting|confirm|deny|decision|approval)\b/i.test(
      text
    ) &&
    /\b(?:not|no|never)\b[\s\S]{0,80}\b(?:submitted|executed|applied|performed|ran|side effect|mutation)\b|\b(?:submit|submission|side effect|mutation)\b[\s\S]{0,80}\b(?:not|never|no)\b[\s\S]{0,40}\b(?:submitted|executed|applied|performed|ran|occurred|affected)/i.test(
      text
    )
  );
}

function isApprovalDecisionRequestFinal(text: string): boolean {
  return (
    /\b(?:approval|authorization|permission|approve|deny)\b/i.test(text) &&
    /\b(?:approve|approved|yes)\b[\s\S]{0,120}\b(?:deny|denied|reject|no)\b|\b(?:deny|denied|reject|no)\b[\s\S]{0,120}\b(?:approve|approved|yes)\b/i.test(
      text
    ) &&
    /\b(?:waiting|respond|response|decision|confirm|choose)\b/i.test(text)
  );
}

function latestAssistantFollowsLatestToolResult(messages: unknown[]): boolean {
  let latestAssistantIndex = -1;
  let latestToolResultIndex = -1;
  for (const [index, message] of messages.entries()) {
    if (typeof message !== "object" || message === null) continue;
    const record = message as { role?: unknown; toolResults?: unknown; metadata?: { toolResults?: unknown; workerPayload?: unknown; workerState?: { lastResult?: unknown } } };
    if (readString(record.role) === "assistant" && readMessageText((record as { content?: unknown }).content) !== null) {
      latestAssistantIndex = index;
    }
    if (readString(record.role) === "tool" || extractToolResults([message]).length > 0) {
      latestToolResultIndex = index;
    }
  }
  return latestAssistantIndex >= 0 && latestAssistantIndex >= latestToolResultIndex;
}

function readPendingReferenceToolCalls(messages: unknown[]): unknown[] {
  const toolCalls = dedupeReferenceToolCalls(extractToolCalls(messages));
  const callNameCounts = new Map<string, number>();
  for (const call of toolCalls) {
    const name = readReferenceToolName(call);
    if (name) callNameCounts.set(name, (callNameCounts.get(name) ?? 0) + 1);
  }
  const anonymousResultNameCounts = new Map<string, number>();
  for (const result of extractToolResults(messages)) {
    if (readReferenceToolResultId(result)) continue;
    const name = readReferenceToolResultName(result);
    if (name) anonymousResultNameCounts.set(name, (anonymousResultNameCounts.get(name) ?? 0) + 1);
  }
  const resultKeys = new Set(
    extractToolResults(messages)
      .flatMap((result) => readReferenceToolResultIdentities(result))
      .filter((key): key is string => Boolean(key))
  );
  return toolCalls.filter((call) => {
    const callKeys = readReferenceToolCallIdentities(call);
    if (callKeys.length > 0 && callKeys.some((key) => resultKeys.has(key))) return false;
    const name = readReferenceToolName(call);
    if (name && (callNameCounts.get(name) ?? 0) === 1 && (anonymousResultNameCounts.get(name) ?? 0) > 0) {
      return false;
    }
    return callKeys.length > 0 || Boolean(name);
  });
}

function readMessageText(value: unknown): string | null {
  if (typeof value === "string") return readString(value);
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const text = readString((part as { text?: unknown }).text);
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

function extractToolCalls(messages: unknown[]): unknown[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const record = message as {
      toolCalls?: unknown;
      tool_calls?: unknown;
      metadata?: {
        toolCalls?: unknown;
        spawnedWorkers?: unknown;
        workerUsed?: unknown;
        workerType?: unknown;
        workerState?: { workerRunKey?: unknown; workerType?: unknown; currentTaskId?: unknown };
      };
    };
    const spawnedWorkers = readArray(record.metadata?.spawnedWorkers);
    const workerState = record.metadata?.workerState;
    const workerCall =
      spawnedWorkers.length === 0 && (record.metadata?.workerUsed === true || workerState)
        ? [
            {
              source: "metadata.worker",
              id: readString(workerState?.workerRunKey) ?? readString(workerState?.currentTaskId) ?? undefined,
              name: readString(record.metadata?.workerType) ?? readString(workerState?.workerType) ?? "worker",
              workerState,
            },
          ]
        : [];
    return [
      ...readArray(record.toolCalls),
      ...readArray(record.tool_calls),
      ...readArray(record.metadata?.toolCalls),
      ...spawnedWorkers,
      ...workerCall,
    ];
  });
}

function extractToolResults(messages: unknown[]): unknown[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const record = message as {
      role?: unknown;
      toolResults?: unknown;
      metadata?: {
        toolResults?: unknown;
        workerPayload?: unknown;
        workerState?: { status?: unknown; lastResult?: unknown };
      };
    };
    const roleResults = readString(record.role) === "tool" ? [message] : [];
    const workerResults = [
      ...readArray(record.metadata?.toolResults),
      ...readArrayOrObject(record.metadata?.workerPayload),
      ...readArrayOrObject(record.metadata?.workerState?.lastResult),
    ];
    return [...roleResults, ...readArray(record.toolResults), ...workerResults];
  });
}

function dedupeReferenceToolCalls(toolCalls: unknown[]): unknown[] {
  const seen = new Set<string>();
  const deduped: unknown[] = [];
  for (const call of toolCalls) {
    const key = readReferenceToolCallIdentity(call);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    deduped.push(call);
  }
  return deduped;
}

function readReferenceToolCallIdentity(value: unknown): string | null {
  return readReferenceToolCallIdentities(value)[0] ?? null;
}

function readReferenceToolCallIdentities(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const id = readReferenceToolCallId(value);
  const name = readReferenceToolName(value);
  if (!id) return name ? [`name:${name}`] : [];
  return [`${id}:${name ?? "unknown"}`, `${id}:unknown`];
}

function readReferenceToolResultIdentities(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const id = readReferenceToolResultId(value);
  const name = readReferenceToolResultName(value);
  if (!id) return name ? [`name:${name}`] : [];
  return [`${id}:${name ?? "unknown"}`, `${id}:unknown`];
}

function readReferenceToolCallId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return readString(record.id) ?? readString(record.toolCallId);
}

function readReferenceToolName(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return readString(record.name) ?? readString(record.toolName);
}

function readReferenceToolResultId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return readString(record.toolCallId) ?? readString(record.tool_call_id);
}

function readReferenceToolResultName(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const metadata = typeof record.metadata === "object" && record.metadata !== null ? record.metadata as Record<string, unknown> : {};
  return readString(record.name) ?? readString(record.toolName) ?? readString(metadata.toolName);
}

function extractBrowserEvidenceFromTranscript(messages: unknown[]): unknown[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const record = message as {
      role?: unknown;
      name?: unknown;
      content?: unknown;
      toolStatus?: unknown;
      metadata?: { toolName?: unknown };
    };
    const toolName = readString(record.name) ?? readString(record.metadata?.toolName);
    if (readString(record.role) !== "tool" || toolName !== "sessions_spawn") return [];
    return extractBrowserEvidenceFromSessionToolContent(readString(record.content), readString(record.toolStatus));
  });
}

function extractBrowserEvidenceFromSessionToolContent(content: string | null, fallbackStatus: string | null): unknown[] {
  const envelope = parseToolResultEnvelope(content);
  if (envelope) return extractBrowserEvidenceFromJsonEnvelope(envelope, fallbackStatus);
  return extractBrowserEvidenceFromAccioTextSessionToolResult(content, fallbackStatus);
}

function extractBrowserEvidenceFromJsonEnvelope(envelope: Record<string, unknown>, fallbackStatus: string | null): unknown[] {
  if (!isBrowserSessionToolEnvelope(envelope)) return [];
  const payload = typeof envelope.payload === "object" && envelope.payload !== null ? envelope.payload as Record<string, unknown> : {};
  const artifactIds = readArray(payload.artifactIds);
  const screenshotPaths = readArray(payload.screenshotPaths).flatMap((value) => readString(value) ? [readString(value)!] : []);
  const evidenceText = [
    readString(envelope.evidence_summary),
    readString(envelope.evidence_excerpt),
    readString(envelope.final_content),
    readString(envelope.result),
  ].filter((value): value is string => Boolean(value));
  if (artifactIds.length === 0 && screenshotPaths.length === 0 && evidenceText.length === 0) return [];
  const status = readString(envelope.status) ?? fallbackStatus ?? "completed";
  return [
    {
      source: "session_tool_result",
      rendered: isRenderedSessionToolStatus(status) && (artifactIds.length > 0 || screenshotPaths.length > 0 || evidenceText.some(isRenderedEvidenceText)),
      status,
      agent_id: readString(envelope.agent_id) ?? "browser",
      session_key: readString(envelope.session_key) ?? null,
      artifactIds,
      screenshotPaths,
      evidenceText,
    },
  ];
}

function extractBrowserEvidenceFromAccioTextSessionToolResult(content: string | null, fallbackStatus: string | null): unknown[] {
  if (!content || !isAccioTextBrowserSessionToolResult(content)) return [];
  const status = readAccioTextHeader(content, "status") ?? fallbackStatus ?? "completed";
  const taskId = readAccioTextHeader(content, "task_id");
  const toolChain = readAccioTextHeader(content, "tool_chain");
  const taskResult = readAccioTaskResult(content) ?? content;
  const screenshotPaths = extractMarkdownImageTargets(taskResult);
  const urls = extractHttpUrls(taskResult);
  const evidenceText = compactEvidenceText([
    taskResult,
    screenshotPaths.length > 0 ? `Screenshots: ${screenshotPaths.join(", ")}` : null,
    urls.length > 0 ? `URLs: ${urls.join(", ")}` : null,
  ]);
  if (screenshotPaths.length === 0 && urls.length === 0 && evidenceText.length === 0) return [];
  return [
    {
      source: "session_tool_result",
      rendered: isRenderedSessionToolStatus(status) && (screenshotPaths.length > 0 || evidenceText.some(isRenderedEvidenceText)),
      status,
      agent_id: "browser",
      session_key: taskId,
      tool_chain: toolChain,
      screenshotPaths,
      urls,
      evidenceText,
    },
  ];
}

function isAccioTextBrowserSessionToolResult(content: string): boolean {
  return /^tool_chain:\s*.*\bbrowser\b/im.test(content) || /^task_id:\s*.*:sub:browser:/im.test(content);
}

function readAccioTextHeader(content: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
  return readString(match?.[1]);
}

function readAccioTaskResult(content: string): string | null {
  const match = content.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/i);
  return readString(match?.[1]);
}

function extractMarkdownImageTargets(text: string): string[] {
  return Array.from(text.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g))
    .flatMap((match) => readString(match[1]) ? [readString(match[1])!] : []);
}

function extractHttpUrls(text: string): string[] {
  const urls = Array.from(text.matchAll(/https?:\/\/[^\s)`>"']+/g))
    .flatMap((match) => readString(match[0]) ? [readString(match[0])!] : []);
  return [...new Set(urls)];
}

function compactEvidenceText(values: Array<string | null>): string[] {
  return values
    .filter((value): value is string => Boolean(readString(value)))
    .map((value) => value.trim().length > 4_000 ? `${value.trim().slice(0, 4_000)}...` : value.trim());
}

function isRenderedSessionToolStatus(status: string): boolean {
  return /^(completed|success|succeeded|ok|done)$/i.test(status.trim());
}

function isRenderedEvidenceText(text: string): boolean {
  return /(rendered|screenshot|snapshot|page title|visible page|browser observed|browser page)/i.test(text);
}

function parseToolResultEnvelope(content: string | null): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isBrowserSessionToolEnvelope(envelope: Record<string, unknown> | null): envelope is Record<string, unknown> {
  if (!envelope) return false;
  if (readString(envelope.agent_id) === "browser") return true;
  return readArray(envelope.tool_chain).some((entry) => readString(entry) === "browser");
}

function isWeakReferenceAnswer(text: string): boolean {
  return /暂时无法|无法返回|待确认|估算|没有足够|cannot access|unable to access|unable to collect evidence|could not (?:be reached|collect|verify)|neither source page could be accessed|source pages? could not be accessed|without the source content|cannot produce (?:a|the) comparison|cannot make a recommendation based on evidence I did not collect|nothing (?:was )?verified|not enough information|no executable results?|could not process the task|without live network access|localhost is inaccessible|operating as|use the browser worker|close the flow with|approval (?:is )?pending|approval request (?:is )?pending|awaiting (?:operator|your) (?:decision|approval)|waiting for (?:the )?(?:operator|your) (?:decision|approval)|proceed once (?:the )?operator approves/i.test(
    text
  );
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveReferenceRepoPath(options: ReferenceCollectOptions): string {
  if (options.referenceRepoPath) return options.referenceRepoPath;
  if (options.referenceRuntimeRoot) return options.referenceRuntimeRoot;
  return "unknown";
}

function readGitCommit(repoPath?: string): string {
  if (!repoPath) return "unknown";
  try {
    return execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readArrayOrObject(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return typeof value === "object" && value !== null ? [value] : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPositiveInteger(value: string, arg: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${arg} must be a positive integer`);
  return parsed;
}

function readValue(args: string[], index: number, arg: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRealLlmAbReferenceCollectCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
