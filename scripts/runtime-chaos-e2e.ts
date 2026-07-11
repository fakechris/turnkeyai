import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ReplayRecord,
  RoleActivationInput,
  RuntimeProgressEvent,
  TeamMessage,
  TeamMessageStore,
} from "@turnkeyai/core-types/team";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import type {
  GenerateTextInput,
  GenerateTextResult,
  LLMToolDefinition,
  RequestEnvelopeDiagnostics,
} from "@turnkeyai/llm-adapter/index";
import { LLMRoleResponseGenerator } from "@turnkeyai/role-runtime/llm-response-generator";
import type { RolePromptPacket } from "@turnkeyai/role-runtime/prompt-policy";
import { replayEngineRunRecord } from "@turnkeyai/role-runtime/run-trace-replay";
import {
  FileToolResultArtifactStore,
} from "@turnkeyai/role-runtime/tool-result-artifact-store";
import type {
  RoleToolExecutor,
  RoleToolExecutionResult,
} from "@turnkeyai/role-runtime/tool-use";
import { FileTeamMessageStore } from "@turnkeyai/team-store/file-team-message-store";

export const RUNTIME_CHAOS_REPORT_PROTOCOL =
  "turnkeyai.runtime_chaos_report.v1" as const;
export const REQUIRED_RUNTIME_CHAOS_KILL_POINTS = [
  "before_provider_response",
  "during_tool_execution",
  "after_checkpoint_persistence",
  "during_compaction_summarization",
] as const;

type RuntimeChaosKillPoint =
  (typeof REQUIRED_RUNTIME_CHAOS_KILL_POINTS)[number];

const EARLY_EVIDENCE_MARKER = "EARLY_EVIDENCE_7F3A9C";
const CHILD_RESULT_FILE = "child-result.json";
const PROVIDER_STATE_FILE = "provider-state.json";
const SIDE_EFFECT_FILE = "side-effects.json";
const LIFECYCLE_FILE = "lifecycle.jsonl";
const STRESS_ROUNDS = 64;

export interface RuntimeChaosExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RuntimeChaosCaseReport {
  killPoint: RuntimeChaosKillPoint;
  initialExit: RuntimeChaosExit;
  resumeExitCode: number;
  sameRuntimeRoot: boolean;
  terminalJournal: boolean;
  duplicateSideEffects: number;
  duplicateToolSignatures: number;
  replayProviderCalls: number;
}

export interface RuntimeChaosStressReport {
  rounds: number;
  resumeEvents: number;
  externalizations: number;
  compactions: number;
  microcompactedToolResults: number;
  earlyEvidencePreserved: boolean;
  duplicateSideEffects: number;
  duplicateToolSignatures: number;
  terminalJournal: boolean;
  replayProviderCalls: number;
}

export interface RuntimeChaosReport {
  protocol: typeof RUNTIME_CHAOS_REPORT_PROTOCOL;
  status: "passed" | "failed";
  rootDir: string;
  killPoints: RuntimeChaosCaseReport[];
  stress: RuntimeChaosStressReport;
}

interface RunRuntimeChaosSuiteInput {
  rootDir?: string;
}

interface ChildResult {
  runtimeRoot: string;
  terminalJournal: boolean;
  durableEarlyEvidence: boolean;
  sideEffectSignatures: string[];
  toolSignatures: string[];
  replayProviderCalls: number;
  runTrace: Record<string, unknown>;
  lifecycleEvents: RuntimeProgressEvent[];
  finalText: string;
}

interface ChildOptions {
  runtimeRoot: string;
  mode: "kill-point" | "stress";
  targetRounds: number;
  killPoint?: RuntimeChaosKillPoint | "stress_checkpoint";
}

interface ProviderState {
  nextToolIndex: number;
}

interface SideEffectLedger {
  signatures: string[];
}

export async function runRuntimeChaosSuite(
  input: RunRuntimeChaosSuiteInput = {},
): Promise<RuntimeChaosReport> {
  const rootDir = input.rootDir
    ? path.resolve(input.rootDir)
    : await mkdtemp(path.join(os.tmpdir(), "turnkeyai-runtime-chaos-"));
  await mkdir(rootDir, { recursive: true });

  const killPoints: RuntimeChaosCaseReport[] = [];
  for (const killPoint of REQUIRED_RUNTIME_CHAOS_KILL_POINTS) {
    const runtimeRoot = path.join(rootDir, "kill-points", killPoint);
    await mkdir(runtimeRoot, { recursive: true });
    const targetRounds =
      killPoint === "during_compaction_summarization" ? 8 : 1;
    const initialExit = await spawnChild({
      runtimeRoot,
      mode: "kill-point",
      targetRounds,
      killPoint,
    });
    assertExpectedKill(initialExit, killPoint);
    const resumeExit = await spawnChild({
      runtimeRoot,
      mode: "kill-point",
      targetRounds,
    });
    assertSuccessfulResume(resumeExit, killPoint);
    const result = await readJsonFile<ChildResult>(
      path.join(runtimeRoot, CHILD_RESULT_FILE),
    );
    const duplicateSideEffects = countDuplicates(result.sideEffectSignatures);
    const duplicateToolSignatures = countDuplicates(result.toolSignatures);
    const report: RuntimeChaosCaseReport = {
      killPoint,
      initialExit,
      resumeExitCode: resumeExit.code ?? -1,
      sameRuntimeRoot: result.runtimeRoot === runtimeRoot,
      terminalJournal: result.terminalJournal,
      duplicateSideEffects,
      duplicateToolSignatures,
      replayProviderCalls: result.replayProviderCalls,
    };
    assertCasePassed(report);
    killPoints.push(report);
  }

  const stressRoot = path.join(rootDir, "stress");
  await mkdir(stressRoot, { recursive: true });
  const stressInitial = await spawnChild({
    runtimeRoot: stressRoot,
    mode: "stress",
    targetRounds: STRESS_ROUNDS,
    killPoint: "stress_checkpoint",
  });
  assertExpectedKill(stressInitial, "stress_checkpoint");
  const stressResume = await spawnChild({
    runtimeRoot: stressRoot,
    mode: "stress",
    targetRounds: STRESS_ROUNDS,
  });
  assertSuccessfulResume(stressResume, "stress_checkpoint");
  const stressResult = await readJsonFile<ChildResult>(
    path.join(stressRoot, CHILD_RESULT_FILE),
  );
  const stress = summarizeStress(stressResult);
  assertStressPassed(stress);

  return {
    protocol: RUNTIME_CHAOS_REPORT_PROTOCOL,
    status: "passed",
    rootDir,
    killPoints,
    stress,
  };
}

async function runChild(input: ChildOptions): Promise<void> {
  await mkdir(input.runtimeRoot, { recursive: true });
  const activation = buildActivation(input.runtimeRoot);
  const packet = buildPacket(input.targetRounds);
  const baseStore = new FileTeamMessageStore({
    rootDir: path.join(input.runtimeRoot, "team-messages"),
  });
  const store = createCrashableMessageStore({
    baseStore,
    runtimeRoot: input.runtimeRoot,
    killPoint: input.killPoint,
  });
  const lifecycleFile = path.join(input.runtimeRoot, LIFECYCLE_FILE);
  const gateway = createFakeGateway({
    runtimeRoot: input.runtimeRoot,
    targetRounds: input.targetRounds,
    killPoint: input.killPoint,
  });
  const executor = createChaosToolExecutor({
    runtimeRoot: input.runtimeRoot,
    stress: input.mode === "stress",
    killPoint: input.killPoint,
  });
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: {
      executor,
      maxRounds: input.targetRounds + 4,
      maxWallClockMs: 120_000,
      maxParallelToolCalls: 1,
      maxToolCallsPerRound: 1,
    },
    nativeToolMessageStore: store,
    runJournalStore: store,
    runtimeProgressRecorder: {
      async record(event: RuntimeProgressEvent) {
        await appendFile(
          lifecycleFile,
          `${JSON.stringify(event)}\n`,
          "utf8",
        );
      },
    },
    toolResultArtifactStore: new FileToolResultArtifactStore({
      rootDir: path.join(input.runtimeRoot, "tool-artifacts"),
    }),
    deferToolObservability: false,
  });

  const reply = await generator.generate({ activation, packet });
  const terminalJournal = await readTerminalJournal(baseStore, activation);
  const sideEffectLedger = await readJsonFileOr<SideEffectLedger>(
    path.join(input.runtimeRoot, SIDE_EFFECT_FILE),
    { signatures: [] },
  );
  const toolSignatures = readToolSignatures(reply.metadata?.toolUse);
  const replayProviderCalls = await verifyZeroProviderReplay({
    activation,
    packet,
    reply,
  });
  const lifecycleEvents = await readJsonLines<RuntimeProgressEvent>(lifecycleFile);
  const runTrace = isRecord(reply.metadata?.runTrace)
    ? reply.metadata.runTrace
    : {};
  await writeJsonAtomic(path.join(input.runtimeRoot, CHILD_RESULT_FILE), {
    runtimeRoot: input.runtimeRoot,
    terminalJournal: terminalJournal.completed,
    durableEarlyEvidence: terminalJournal.serialized.includes(
      EARLY_EVIDENCE_MARKER,
    ),
    sideEffectSignatures: sideEffectLedger.signatures,
    toolSignatures,
    replayProviderCalls,
    runTrace,
    lifecycleEvents,
    finalText: reply.content,
  } satisfies ChildResult);
}

function createFakeGateway(input: {
  runtimeRoot: string;
  targetRounds: number;
  killPoint?: ChildOptions["killPoint"];
}): LLMGateway {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (request: GenerateTextInput) => {
    if (request.metadata?.["purpose"] === "runtime_checkpoint_compaction") {
      if (input.killPoint === "during_compaction_summarization") {
        killCurrentProcess();
      }
      const serialized = JSON.stringify(request.messages);
      const evidence = serialized.includes(EARLY_EVIDENCE_MARKER)
        ? [EARLY_EVIDENCE_MARKER]
        : [];
      return fakeResult({
        text: JSON.stringify({
          task: "Complete the deterministic runtime stress run.",
          summary: evidence.length
            ? `Checkpoint preserves ${EARLY_EVIDENCE_MARKER}.`
            : "Checkpoint preserves completed deterministic rounds.",
          decisions: [],
          evidence,
          artifacts: [],
          openQuestions: [],
          planState: [],
        }),
        stopReason: "stop",
      });
    }
    if (input.killPoint === "before_provider_response") {
      killCurrentProcess();
    }
    const statePath = path.join(input.runtimeRoot, PROVIDER_STATE_FILE);
    const state = await readJsonFileOr<ProviderState>(statePath, {
      nextToolIndex: 0,
    });
    if (state.nextToolIndex < input.targetRounds) {
      const index = state.nextToolIndex;
      await writeJsonAtomic(statePath, { nextToolIndex: index + 1 });
      return fakeResult({
        text: `Collect deterministic observation ${index}.`,
        stopReason: "tool_calls",
        toolCalls: [
          {
            id: `chaos-call-${index}`,
            name: "chaos_probe",
            input: { index },
          },
        ],
      });
    }
    return fakeResult({
      text: `Completed ${input.targetRounds} deterministic observations; preserved ${EARLY_EVIDENCE_MARKER}.`,
      stopReason: "stop",
    });
  };
  return gateway;
}

function createChaosToolExecutor(input: {
  runtimeRoot: string;
  stress: boolean;
  killPoint?: ChildOptions["killPoint"];
}): RoleToolExecutor {
  return {
    definitions: () => [chaosToolDefinition()],
    async execute({ call }): Promise<RoleToolExecutionResult> {
      const signature = stableToolSignature(call.name, call.input);
      const ledgerPath = path.join(input.runtimeRoot, SIDE_EFFECT_FILE);
      const ledger = await readJsonFileOr<SideEffectLedger>(ledgerPath, {
        signatures: [],
      });
      ledger.signatures.push(signature);
      await writeJsonAtomic(ledgerPath, ledger);
      if (input.killPoint === "during_tool_execution") {
        killCurrentProcess();
      }
      const index = Number(call.input["index"] ?? -1);
      const marker = index === 0 ? EARLY_EVIDENCE_MARKER : `observation-${index}`;
      const padding =
        input.stress && index % 2 === 0 ? "x".repeat(66 * 1024) : "";
      return {
        toolCallId: call.id,
        toolName: call.name,
        content: `${marker}\n${padding}`,
      };
    },
  };
}

function createCrashableMessageStore(input: {
  baseStore: FileTeamMessageStore;
  runtimeRoot: string;
  killPoint?: ChildOptions["killPoint"];
}): Pick<TeamMessageStore, "append" | "get" | "list"> {
  return {
    async append(message: TeamMessage) {
      await input.baseStore.append(message);
      const journal = readRecord(message.metadata?.["runJournal"]);
      if (journal?.["status"] !== "in_flight") return;
      if (input.killPoint === "after_checkpoint_persistence") {
        killCurrentProcess();
      }
      if (
        input.killPoint === "stress_checkpoint" &&
        typeof journal["nextRound"] === "number" &&
        journal["nextRound"] >= 32
      ) {
        killCurrentProcess();
      }
    },
    get: (messageId) => input.baseStore.get(messageId),
    list: (threadId) => input.baseStore.list(threadId),
  };
}

function fakeResult(input: {
  text: string;
  stopReason: "stop" | "tool_calls";
  toolCalls?: GenerateTextResult["toolCalls"];
}): GenerateTextResult {
  return {
    text: input.text,
    ...(input.toolCalls ? { toolCalls: input.toolCalls } : {}),
    modelId: "chaos-model",
    providerId: "chaos-provider",
    protocol: "openai-compatible",
    adapterName: "runtime-chaos",
    stopReason: input.stopReason,
    usage: { inputTokens: 900, outputTokens: 20 },
    requestEnvelope: highPressureEnvelope(),
    raw: { deterministic: true },
  };
}

function highPressureEnvelope(): RequestEnvelopeDiagnostics {
  return {
    messageCount: 2,
    promptChars: 3_600,
    promptBytes: 3_600,
    metadataBytes: 0,
    artifactCount: 0,
    toolCount: 1,
    toolSchemaBytes: 200,
    toolResultCount: 0,
    toolResultBytes: 0,
    inlineAttachmentBytes: 0,
    inlineImageCount: 0,
    inlineImageBytes: 0,
    inlinePdfCount: 0,
    inlinePdfBytes: 0,
    multimodalPartCount: 0,
    totalSerializedBytes: 3_800,
    estimatedInputTokens: 900,
    inputTokenLimit: 100,
    overLimitKeys: [],
  };
}

async function verifyZeroProviderReplay(input: {
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  reply: Awaited<ReturnType<LLMRoleResponseGenerator["generate"]>>;
}): Promise<number> {
  const replaySeed = isRecord(input.reply.metadata?.engineRunReplay)
    ? input.reply.metadata.engineRunReplay
    : {};
  const record: ReplayRecord = {
    replayId: `chaos-replay-${input.activation.runState.runKey}`,
    layer: "role",
    status: "completed",
    recordedAt: Date.now(),
    threadId: input.activation.thread.threadId,
    flowId: input.activation.flow.flowId,
    roleId: input.activation.runState.roleId,
    taskId: input.activation.handoff.taskId,
    summary: input.reply.content,
    metadata: {
      runTrace: input.reply.metadata?.runTrace,
      engineRunReplay: {
        ...replaySeed,
        activation: input.activation,
        packet: input.packet,
        toolUse: input.reply.metadata?.toolUse,
      },
    },
  };
  const previousFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls += 1;
    throw new Error("runtime chaos replay invoked provider transport");
  }) as typeof fetch;
  try {
    await replayEngineRunRecord(record);
  } finally {
    globalThis.fetch = previousFetch;
  }
  return providerCalls;
}

async function readTerminalJournal(
  store: FileTeamMessageStore,
  activation: RoleActivationInput,
): Promise<{ completed: boolean; serialized: string }> {
  const message = await store.get(
    `runtime-journal:${activation.runState.runKey}`,
  );
  const journal = readRecord(message?.metadata?.["runJournal"]);
  return {
    completed: journal?.["status"] === "completed",
    serialized: JSON.stringify(journal ?? {}),
  };
}

function summarizeStress(result: ChildResult): RuntimeChaosStressReport {
  const trace = result.runTrace;
  const totals = readRecord(trace["totals"]);
  const incidents = readRecord(trace["incidents"]);
  const microcompactedToolResults = result.lifecycleEvents.reduce(
    (sum, event) => {
      if (event.metadata?.["eventType"] !== "run.lifecycle") return sum;
      const value = event.metadata?.["microcompactedToolResults"];
      return sum + (typeof value === "number" ? value : 0);
    },
    0,
  );
  return {
    rounds: result.sideEffectSignatures.length,
    resumeEvents:
      typeof incidents?.["resume_after_crash"] === "number"
        ? incidents["resume_after_crash"]
        : trace["resumedAfterCrash"] === true
          ? 1
          : 0,
    externalizations:
      typeof totals?.["externalizations"] === "number"
        ? totals["externalizations"]
        : 0,
    compactions:
      typeof totals?.["compactions"] === "number" ? totals["compactions"] : 0,
    microcompactedToolResults,
    earlyEvidencePreserved:
      result.finalText.includes(EARLY_EVIDENCE_MARKER) &&
      result.durableEarlyEvidence,
    duplicateSideEffects: countDuplicates(result.sideEffectSignatures),
    duplicateToolSignatures: countDuplicates(result.toolSignatures),
    terminalJournal: result.terminalJournal,
    replayProviderCalls: result.replayProviderCalls,
  };
}

function readToolSignatures(toolUse: unknown): string[] {
  const rounds = readRecord(toolUse)?.["rounds"];
  if (!Array.isArray(rounds)) return [];
  return rounds.flatMap((round) => {
    const calls = readRecord(round)?.["calls"];
    if (!Array.isArray(calls)) return [];
    return calls.flatMap((call) => {
      const record = readRecord(call);
      return typeof record?.["name"] === "string" && isRecord(record["input"])
        ? [stableToolSignature(record["name"], record["input"])]
        : [];
    });
  });
}

function stableToolSignature(
  name: string,
  toolInput: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(`${name}\0${JSON.stringify(sortRecord(toolInput))}`)
    .digest("hex");
}

function sortRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        isRecord(value) ? sortRecord(value) : value,
      ]),
  );
}

function countDuplicates(values: string[]): number {
  return values.length - new Set(values).size;
}

function assertExpectedKill(
  result: RuntimeChaosExit,
  label: string,
): void {
  if (result.signal !== "SIGKILL") {
    throw new Error(
      `${label} did not reach its deterministic SIGKILL boundary: ${JSON.stringify(result)}`,
    );
  }
}

function assertSuccessfulResume(
  result: RuntimeChaosExit,
  label: string,
): void {
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      `${label} did not resume cleanly: ${JSON.stringify(result)}`,
    );
  }
}

function assertCasePassed(report: RuntimeChaosCaseReport): void {
  if (
    !report.sameRuntimeRoot ||
    !report.terminalJournal ||
    report.duplicateSideEffects !== 0 ||
    report.duplicateToolSignatures !== 0 ||
    report.replayProviderCalls !== 0
  ) {
    throw new Error(
      `runtime chaos boundary failed: ${JSON.stringify(report)}`,
    );
  }
}

function assertStressPassed(report: RuntimeChaosStressReport): void {
  const requiredCounts = {
    rounds: report.rounds === STRESS_ROUNDS,
    resumeEvents: report.resumeEvents > 0,
    externalizations: report.externalizations > 0,
    compactions: report.compactions > 0,
  };
  if (
    Object.values(requiredCounts).some((value) => !value) ||
    !report.earlyEvidencePreserved ||
    !report.terminalJournal ||
    report.duplicateSideEffects !== 0 ||
    report.duplicateToolSignatures !== 0 ||
    report.replayProviderCalls !== 0
  ) {
    throw new Error(`runtime stress gate failed: ${JSON.stringify(report)}`);
  }
}

async function spawnChild(input: ChildOptions): Promise<RuntimeChaosExit> {
  const args = [
    "--import",
    "tsx",
    fileURLToPath(import.meta.url),
    "--child",
    "--runtime-root",
    input.runtimeRoot,
    "--mode",
    input.mode,
    "--target-rounds",
    String(input.targetRounds),
    ...(input.killPoint ? ["--kill-point", input.killPoint] : []),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TURNKEYAI_LOOP_COMPACTION: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code && signal === null) {
        reject(
          new Error(
            `runtime chaos child failed (${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }
      resolve({ code, signal });
    });
  });
}

function killCurrentProcess(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not terminate runtime chaos child");
}

function chaosToolDefinition(): LLMToolDefinition {
  return {
    name: "chaos_probe",
    description: "Record one deterministic runtime observation.",
    inputSchema: {
      type: "object",
      properties: { index: { type: "integer", minimum: 0 } },
      required: ["index"],
      additionalProperties: false,
    },
  };
}

function buildPacket(targetRounds: number): RolePromptPacket {
  return {
    roleId: "role-chaos",
    roleName: "Runtime Verifier",
    seat: "lead",
    systemPrompt: "Use the supplied tool and preserve concrete evidence.",
    taskPrompt: `Collect ${targetRounds} numbered deterministic observations, then return a concise completion.`,
    outputContract: "Return the completed observation count and preserved evidence.",
    suggestedMentions: [],
  };
}

function buildActivation(runtimeRoot: string): RoleActivationInput {
  const runId = path.basename(runtimeRoot).replace(/[^a-zA-Z0-9_-]/g, "-");
  const threadId = `thread-chaos-${runId}`;
  const flowId = `flow-chaos-${runId}`;
  const runKey = `role:role-chaos:thread:${threadId}`;
  return {
    thread: {
      threadId,
      teamId: "team-runtime-chaos",
      teamName: "Runtime Chaos Verification",
      leadRoleId: "role-chaos",
      roles: [
        {
          roleId: "role-chaos",
          name: "Runtime Verifier",
          seat: "lead",
          runtime: "local",
          model: { provider: "test", name: "chaos-model" },
        },
      ],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    flow: {
      flowId,
      threadId,
      rootMessageId: `message-${runId}`,
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: ["role-chaos"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 1,
      maxHops: 6,
      edges: [],
      shardGroups: [],
      createdAt: 1,
      updatedAt: 1,
    },
    runState: {
      runKey,
      threadId,
      roleId: "role-chaos",
      mode: "group",
      status: "running",
      iterationCount: 0,
      maxIterations: 3,
      inbox: [],
      lastActiveAt: 1,
    },
    handoff: {
      taskId: `task-chaos-${runId}`,
      flowId,
      sourceMessageId: `message-${runId}`,
      targetRoleId: "role-chaos",
      activationType: "cascade",
      threadId,
      payload: {
        threadId,
        intent: {
          relayBrief: "Run deterministic runtime verification.",
          recentMessages: [],
        },
      },
      createdAt: 1,
    },
  };
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const text = await readFile(filePath, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readJsonFileOr<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes("--child")) {
    const runtimeRoot = readArg("--runtime-root");
    const mode = readArg("--mode");
    const targetRounds = Number(readArg("--target-rounds"));
    const killPoint = readArg("--kill-point") as ChildOptions["killPoint"];
    if (
      !runtimeRoot ||
      (mode !== "kill-point" && mode !== "stress") ||
      !Number.isInteger(targetRounds) ||
      targetRounds <= 0
    ) {
      throw new Error("invalid runtime chaos child arguments");
    }
    await runChild({
      runtimeRoot,
      mode,
      targetRounds,
      ...(killPoint ? { killPoint } : {}),
    });
    return;
  }
  const rootDir = readArg("--root");
  const report = await runRuntimeChaosSuite(rootDir ? { rootDir } : {});
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
