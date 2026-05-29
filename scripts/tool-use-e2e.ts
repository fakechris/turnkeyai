import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

import type {
  RoleActivationInput,
  TeamMessage,
  WorkerExecutionResult,
  WorkerHandler,
  WorkerInvocationInput,
  WorkerKind,
  WorkerRegistry,
  WorkerRuntime,
} from "@turnkeyai/core-types/team";
import { createBrowserBridge } from "@turnkeyai/browser-bridge/browser-bridge-factory";
import { AnthropicCompatibleClient } from "@turnkeyai/llm-adapter/anthropic-compatible-client";
import { FileModelCatalogSource } from "@turnkeyai/llm-adapter/file-model-catalog";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import { OpenAICompatibleClient } from "@turnkeyai/llm-adapter/openai-compatible-client";
import { ModelRegistry } from "@turnkeyai/llm-adapter/registry";
import type {
  GenerateTextInput,
  GenerateTextResult,
  ModelCatalog,
  ModelCatalogSource,
  ModelProtocol,
  ProtocolClient,
  ResolvedModelConfig,
} from "@turnkeyai/llm-adapter/index";
import { LLMRoleResponseGenerator } from "@turnkeyai/role-runtime/llm-response-generator";
import { createNativeToolCapabilityRegistry } from "@turnkeyai/role-runtime/tool-capability-registry";
import type { ToolPermissionService } from "@turnkeyai/role-runtime/tool-permission-service";
import { createWorkerSessionToolExecutor } from "@turnkeyai/role-runtime/tool-use";
import { LLMSubAgentWorkerHandler } from "@turnkeyai/role-runtime/sub-agent-worker-handler";
import { InMemoryWorkerRuntime } from "@turnkeyai/worker-runtime/in-memory-worker-runtime";

interface ToolUseE2eOptions {
  withBrowser: boolean;
  cdpTimeoutMs: number;
  realLlm: boolean;
  realLlmMatrix: boolean;
  scenario: ToolUseScenario;
  matrixScenarios?: ToolUseScenario[];
  modelCatalogPath?: string;
  modelId?: string;
  modelChainId?: string;
}

type ToolUseScenario = "basic" | "complex" | "acceptance" | "followup" | "timeout" | "approval";

interface RealToolUseE2eResult {
  mode: "llm-only" | "llm-browser";
  scenario: ToolUseScenario;
  modelCatalogPath: string;
  toolCallNames: string[];
  finalMarker: string;
  finalBytes: number;
  evidenceBullets: number;
  qualityFailures: number;
  spawnedSessionCount?: number;
  childTranscriptMessages?: number;
  permissionEvents?: string[];
}

function parseOptions(args: string[]): ToolUseE2eOptions {
  const options: ToolUseE2eOptions = {
    withBrowser: false,
    cdpTimeoutMs: 45_000,
    realLlm: false,
    realLlmMatrix: false,
    scenario: "basic",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--with-browser") {
      options.withBrowser = true;
      continue;
    }
    if (arg === "--real-llm") {
      options.realLlm = true;
      continue;
    }
    if (arg === "--real-llm-matrix") {
      options.realLlm = true;
      options.realLlmMatrix = true;
      continue;
    }
    if (arg === "--scenario") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --scenario");
      }
      options.scenario = parseScenarioName(value);
      index += 1;
      continue;
    }
    if (arg === "--matrix-scenarios") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --matrix-scenarios");
      }
      options.matrixScenarios = parseScenarioList(value);
      index += 1;
      continue;
    }
    if (arg === "--model-catalog") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --model-catalog");
      }
      options.modelCatalogPath = value;
      index += 1;
      continue;
    }
    if (arg === "--model-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --model-id");
      }
      options.modelId = value;
      index += 1;
      continue;
    }
    if (arg === "--model-chain-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --model-chain-id");
      }
      options.modelChainId = value;
      index += 1;
      continue;
    }
    if (arg === "--cdp-timeout-ms") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --cdp-timeout-ms");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        throw new Error("--cdp-timeout-ms must be a positive integer");
      }
      options.cdpTimeoutMs = parsed;
      index += 1;
      continue;
    }
  }
  return options;
}

function parseScenarioList(value: string): ToolUseScenario[] {
  const scenarios = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (scenarios.length === 0) {
    throw new Error("--matrix-scenarios must include at least one scenario");
  }
  return scenarios.map((scenario) => parseScenarioName(scenario));
}

function parseScenarioName(value: string): ToolUseScenario {
  if (
    value === "basic" ||
    value === "complex" ||
    value === "acceptance" ||
    value === "followup" ||
    value === "timeout" ||
    value === "approval"
  ) {
    return value;
  }
  throw new Error("--scenario must be basic, complex, acceptance, followup, timeout, or approval");
}

async function main(options: ToolUseE2eOptions): Promise<void> {
  const mock = await runMockNativeToolUseE2e();
  console.log("tool-use mock e2e passed");
  console.log(`llm-rounds: ${mock.llmRounds}`);
  console.log(`tool-call-id: ${mock.toolCallId}`);
  console.log(`native-messages: ${mock.nativeMessageCount}`);
  console.log(`permission-events: ${mock.permissionEvents.join(",")}`);

  const subAgent = await runMockSubAgentToolUseE2e();
  console.log("tool-use sub-agent mock e2e passed");
  console.log(`sub-agent-kind: ${subAgent.kind}`);
  console.log(`sub-agent-llm-rounds: ${subAgent.llmRounds}`);
  console.log(`sub-agent-private-tool: ${subAgent.privateToolName}`);

  const acceptance = runMockAcceptanceQualitySuiteE2e();
  console.log("tool-use acceptance quality suite passed");
  console.log(`acceptance-scenarios: ${acceptance.scenarios.join(",")}`);
  console.log(`acceptance-total-final-bytes: ${acceptance.totalFinalBytes}`);

  if (options.realLlm) {
    const realRuns = options.realLlmMatrix ? await runRealLlmToolUseE2eMatrix(options) : [await runRealLlmToolUseE2e(options)];
    for (const real of realRuns) {
      printRealLlmResult(real);
    }
    if (options.realLlmMatrix) {
      console.log(`tool-use real llm matrix passed: ${realRuns.map((run) => run.scenario).join(",")}`);
    }
  }

  if (options.withBrowser) {
    await runCommand("npm", ["run", "cdp:smoke", "--", "--timeout-ms", String(options.cdpTimeoutMs)]);
    console.log("tool-use browser e2e passed");
  }
}

function printRealLlmResult(real: RealToolUseE2eResult): void {
  console.log("tool-use real llm e2e passed");
  console.log(`real-mode: ${real.mode}`);
  console.log(`real-scenario: ${real.scenario}`);
  console.log(`real-model-catalog: ${real.modelCatalogPath}`);
  console.log(`real-tool-calls: ${real.toolCallNames.join(",")}`);
  console.log(`real-final: ${real.finalMarker}`);
  console.log(`real-final-bytes: ${real.finalBytes}`);
  console.log(`real-evidence-bullets: ${real.evidenceBullets}`);
  console.log(`real-quality-failures: ${real.qualityFailures}`);
  if (real.spawnedSessionCount !== undefined) {
    console.log(`real-spawned-sessions: ${real.spawnedSessionCount}`);
  }
  if (real.childTranscriptMessages !== undefined) {
    console.log(`real-child-transcript-messages: ${real.childTranscriptMessages}`);
  }
  if (real.permissionEvents !== undefined) {
    console.log(`real-permission-events: ${real.permissionEvents.join(",")}`);
  }
}

async function runRealLlmToolUseE2eMatrix(options: ToolUseE2eOptions): Promise<RealToolUseE2eResult[]> {
  const scenarios = options.matrixScenarios ?? defaultRealLlmMatrixScenarios(options.withBrowser);
  const results: RealToolUseE2eResult[] = [];
  for (const scenario of scenarios) {
    if (isMultiSourceScenario(scenario) && !options.withBrowser) {
      throw new Error(`matrix scenario ${scenario} requires --with-browser`);
    }
    results.push(
      await runRealLlmToolUseE2e({
        ...options,
        realLlmMatrix: false,
        scenario,
        withBrowser: isMultiSourceScenario(scenario),
      })
    );
  }
  return results;
}

function defaultRealLlmMatrixScenarios(withBrowser: boolean): ToolUseScenario[] {
  return withBrowser ? ["basic", "approval", "followup", "timeout", "complex"] : ["basic", "approval", "followup", "timeout"];
}

async function runRealLlmToolUseE2e(options: ToolUseE2eOptions): Promise<RealToolUseE2eResult> {
  const multiSourceScenario = isMultiSourceScenario(options.scenario);
  const followupScenario = options.scenario === "followup";
  const timeoutScenario = options.scenario === "timeout";
  const approvalScenario = options.scenario === "approval";
  if (multiSourceScenario && !options.withBrowser) {
    throw new Error(`--scenario ${options.scenario} requires --with-browser`);
  }
  if (approvalScenario && options.withBrowser) {
    throw new Error("--scenario approval uses a deterministic browser worker and must not be combined with --with-browser");
  }
  const modelCatalogPath = resolveModelCatalogPath(options.modelCatalogPath);
  const modelSelection = resolveRealModelSelection(modelCatalogPath, options);
  const gateway = new LLMGateway({
    registry: new ModelRegistry(new FileModelCatalogSource(modelCatalogPath)),
    clients: [new OpenAICompatibleClient(), new AnthropicCompatibleClient()],
  });
  const toolCapabilityRegistry = createNativeToolCapabilityRegistry({
    availableWorkerKinds:
      multiSourceScenario || approvalScenario ? ["explore", "browser"] : options.withBrowser ? ["browser"] : ["explore"],
    permissionsEnabled: approvalScenario,
    memoryEnabled: false,
    tasksEnabled: false,
  });
  const nativeMessages: TeamMessage[] = [];
  const approvalPermissionEvents: string[] = [];
  const fixture = options.withBrowser
    ? await startBrowserFixture({
        marker: multiSourceScenario ? "TURNKEYAI_COMPLEX_BROWSER_OK" : "TURNKEYAI_BROWSER_E2E_OK",
        evidence:
          multiSourceScenario
            ? "Browser fixture says: complex browser evidence was observed by private browser tools."
            : "Browser fixture says: private browser tools observed this page.",
      })
    : null;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-tooluse-real-e2e-"));
  let closeWorkerRuntime: (() => Promise<void>) | null = null;
  try {
    const workerRuntimeBundle = timeoutScenario
      ? { workerRuntime: buildRealTimeoutWorkerRuntime(), close: async () => {} }
      : followupScenario
      ? { workerRuntime: buildRealFollowupWorkerRuntime(), close: async () => {} }
      : approvalScenario
      ? { workerRuntime: buildRealApprovalWorkerRuntime(), close: async () => {} }
      : multiSourceScenario
      ? buildRealComplexWorkerRuntime({ gateway, fixtureUrl: fixture!.url, tempDir })
      : options.withBrowser
      ? buildRealBrowserWorkerRuntime({ gateway, fixtureUrl: fixture!.url, tempDir })
      : { workerRuntime: buildRealExploreWorkerRuntime(), close: async () => {} };
    const workerRuntime = workerRuntimeBundle.workerRuntime;
    closeWorkerRuntime = workerRuntimeBundle.close;
    const generator = new LLMRoleResponseGenerator({
      gateway,
      nativeToolMessageStore: {
        async append(message) {
          nativeMessages.push(message);
        },
      },
      toolLoop: {
        executor: createWorkerSessionToolExecutor({
          workerRuntime,
          toolCapabilityRegistry,
          ...(approvalScenario ? { toolPermissionService: buildApprovalToolPermissionService(approvalPermissionEvents) } : {}),
          maxSessionToolTimeoutMs: options.withBrowser ? 180_000 : 60_000,
          ...(timeoutScenario ? { hardTimeoutGraceMs: 20 } : {}),
        }),
        maxRounds: followupScenario || timeoutScenario || approvalScenario ? 6 : multiSourceScenario ? 8 : options.withBrowser ? 6 : 4,
        maxParallelToolCalls: multiSourceScenario ? 2 : 1,
        maxToolCallsPerRound: multiSourceScenario ? 4 : 2,
        maxWallClockMs:
          followupScenario || timeoutScenario || approvalScenario
            ? 120_000
            : multiSourceScenario
            ? 300_000
            : options.withBrowser
              ? 240_000
              : 90_000,
      },
      clock: { now: () => Date.now() },
    });
    const activation = buildActivation({
      ...(modelSelection.modelId ? { modelId: modelSelection.modelId } : {}),
      ...(modelSelection.modelChainId ? { modelChainId: modelSelection.modelChainId } : {}),
    });
    const mode = options.withBrowser ? "llm-browser" : "llm-only";
    const targetMarker =
      followupScenario
        ? "TURNKEYAI_FOLLOWUP_E2E_OK"
        : timeoutScenario
        ? "TURNKEYAI_TIMEOUT_E2E_OK"
        : approvalScenario
        ? "TURNKEYAI_APPROVAL_E2E_OK"
        : multiSourceScenario
        ? "TURNKEYAI_COMPLEX_E2E_OK"
        : options.withBrowser
          ? "TURNKEYAI_BROWSER_E2E_OK"
          : "TURNKEYAI_LLM_E2E_OK";
    const reply = await generator.generate({
      activation,
      packet: {
        roleId: "role-lead",
        roleName: "Lead",
        seat: "lead",
        systemPrompt: [
          toolCapabilityRegistry.renderPromptHarness({ seat: "lead" }),
          "You are running a release-gate E2E. Use the available session tool instead of answering from memory.",
          followupScenario
            ? [
                "You must verify same-session follow-up behavior:",
                "1. Call sessions_spawn with agent_id=explore exactly once for phase 1.",
                "2. Read the returned session_key from that partial result.",
                "3. Call sessions_send exactly once on that same session_key using the requested continuation message.",
                "4. Do not spawn a second session for the continuation.",
                "5. Finalize only after sessions_send returns TURNKEYAI_FOLLOWUP_E2E_OK.",
              ].join("\n")
            : timeoutScenario
            ? [
                "You must verify bounded timeout recovery:",
                "1. Call sessions_spawn with agent_id=explore exactly once.",
                "2. Set timeout_seconds to 0.001 so the sub-agent times out quickly.",
                "3. After the timeout result, do not call more tools or spawn fallback sessions.",
                "4. Produce an evidence-only final answer from the timeout result.",
              ].join("\n")
            : approvalScenario
            ? [
                "You must verify approval-gated browser side effects:",
                "1. Call permission_query for browser.form.submit before starting the browser worker.",
                "2. Call permission_result and permission_applied after the approval id is available.",
                "3. Call sessions_spawn with agent_id=browser exactly once after permission_applied.",
                "4. The browser task must clearly ask to submit the approved form so the runtime gate verifies the cached approval.",
                "5. Finalize only after the browser worker result confirms browser.form.submit completed.",
              ].join("\n")
            : multiSourceScenario
            ? [
                "You must gather two independent evidence sources before final answer:",
                "1. Call sessions_spawn with agent_id=explore to verify TURNKEYAI_COMPLEX_EXPLORE_OK.",
                "2. Call sessions_spawn with agent_id=browser to open the fixture page and verify TURNKEYAI_COMPLEX_BROWSER_OK.",
                "The two tasks are independent; use both session results and do not finalize from one source only.",
              ].join("\n")
            : options.withBrowser
            ? "You must call sessions_spawn with agent_id=browser exactly once, then base your final answer on browser-observed evidence."
            : "You must call sessions_spawn with agent_id=explore exactly once, then base your final answer on the tool result.",
        ].join("\n\n"),
        taskPrompt: followupScenario
          ? [
              "Run the same-session follow-up E2E.",
              "Phase 1: ask the explore sub-agent for the phase-one checkpoint.",
              "Phase 2: continue the same sub-agent session with sessions_send using the continuation instruction from phase 1.",
              `Final answer must include ${targetMarker}, the reused session_key, and a short note that no duplicate session was spawned.`,
            ].join("\n")
          : timeoutScenario
          ? [
              "Run the bounded timeout recovery E2E.",
              "Ask the explore sub-agent to perform a deliberately slow verification with timeout_seconds=0.001.",
              `Final answer must include ${targetMarker}, explain that verification timed out, and mark missing evidence as not verified.`,
            ].join("\n")
          : approvalScenario
          ? [
              "Run the approval-gated browser side-effect E2E.",
              "Request approval for browser.form.submit, apply the approval, then ask the browser sub-agent to open https://example.test/account and submit the approved form.",
              `Final answer must include ${targetMarker}, permission.query, permission.result, permission.applied, and browser.form.submit.`,
            ].join("\n")
          : multiSourceScenario
          ? [
              "Run the production-grade multi-agent tool-use E2E.",
              "Explore task: retrieve the release marker TURNKEYAI_COMPLEX_EXPLORE_OK and its deterministic source label.",
              `Browser task: open ${fixture!.url}, read the page title, marker TURNKEYAI_COMPLEX_BROWSER_OK, and evidence text.`,
              `Final answer must include ${targetMarker}, TURNKEYAI_COMPLEX_EXPLORE_OK, and TURNKEYAI_COMPLEX_BROWSER_OK.`,
            ].join("\n")
          : options.withBrowser
          ? `Open ${fixture!.url}, read the fixture marker and page title with the browser sub-agent, then answer with ${targetMarker}.`
          : `Ask the explore sub-agent for the release marker, then answer with ${targetMarker}.`,
        outputContract:
          followupScenario
            ? [
                `Final answer must include ${targetMarker}.`,
                "Use Markdown with a heading `Evidence` and at least three bullets: phase-one partial result, follow-up result, residual risk.",
                "Mention the reused session_key and state that the continuation used sessions_send rather than a duplicate sessions_spawn.",
              ].join("\n")
            : timeoutScenario
            ? [
                `Final answer must include ${targetMarker}.`,
                "Use Markdown with a heading `Evidence` and at least three bullets: timeout result, attempted verification, residual risk.",
                "State `not verified` for anything the timed-out worker did not prove.",
                "Do not claim the underlying slow verification succeeded.",
              ].join("\n")
            : approvalScenario
            ? [
                `Final answer must include ${targetMarker}.`,
                "Use Markdown with a heading `Evidence` and at least three bullets: permission.query, permission.result, permission.applied, browser worker result, residual risk.",
                "Mention browser.form.submit and state the action was not executed before permission.applied.",
              ].join("\n")
            : multiSourceScenario
            ? [
                `Final answer must include ${targetMarker}.`,
                "Use Markdown with a heading `Evidence` and at least three bullets: explore evidence, browser evidence, residual risk.",
                "Do not include the success marker unless both sub-agent results were used.",
              ].join("\n")
            : `Final answer must include ${targetMarker} and must mention the session tool evidence.`,
        suggestedMentions: [],
      },
    });
    const latestNativeMessages = [...new Map(nativeMessages.map((message) => [message.id, message])).values()];
    const toolCalls = latestNativeMessages.flatMap((message) =>
      message.role === "assistant" && message.toolCalls?.length ? message.toolCalls : []
    );
    const toolCallNames = toolCalls.map((call) => call.name);
    assert.ok(toolCallNames.includes("sessions_spawn"), "real LLM must call sessions_spawn");
    let quality: AnswerQualityReport | null = null;
    if (followupScenario) {
      const spawnedAgents = toolCalls
        .filter((call) => call.name === "sessions_spawn")
        .map((call) => readObservedToolCallInput(call)?.agent_id);
      const sessions = workerRuntime.listSessions ? await workerRuntime.listSessions() : [];
      assert.deepEqual(spawnedAgents, ["explore"], "follow-up real LLM E2E must spawn exactly one explore session");
      assert.ok(toolCallNames.includes("sessions_send"), "follow-up real LLM E2E must call sessions_send");
      assert.equal(sessions.length, 1, `follow-up real LLM E2E must reuse one sub-agent session, got ${sessions.length}`);
      assert.equal(sessions[0]?.state.status, "done");
      assert.ok((sessions[0]?.state.history?.length ?? 0) >= 4, "follow-up session should preserve spawn/send transcript");
      quality = evaluateAnswerQuality({
        scenario: options.scenario,
        answer: reply.content,
        gate: followupQualityGate(targetMarker),
        toolCallNames,
        spawnedSessionCount: sessions.length,
      });
      assertAnswerQuality(quality);
    } else if (timeoutScenario) {
      const spawnedAgents = toolCalls
        .filter((call) => call.name === "sessions_spawn")
        .map((call) => readObservedToolCallInput(call)?.agent_id);
      const sessions = workerRuntime.listSessions ? await workerRuntime.listSessions() : [];
      assert.deepEqual(spawnedAgents, ["explore"], "timeout real LLM E2E must spawn exactly one explore session");
      assert.equal(toolCallNames.includes("sessions_send"), false, "timeout real LLM E2E must not follow up automatically");
      assert.equal(sessions.length, 1, `timeout real LLM E2E must leave one resumable session, got ${sessions.length}`);
      assert.match(reply.content, /timeout|timed out/i);
      assert.match(reply.content, /not verified/i);
      quality = evaluateAnswerQuality({
        scenario: options.scenario,
        answer: reply.content,
        gate: timeoutQualityGate(targetMarker),
        toolCallNames,
        spawnedSessionCount: sessions.length,
      });
      assertAnswerQuality(quality);
    } else if (approvalScenario) {
      const spawnedAgents = toolCalls
        .filter((call) => call.name === "sessions_spawn")
        .map((call) => readObservedToolCallInput(call)?.agent_id);
      const sessions = workerRuntime.listSessions ? await workerRuntime.listSessions() : [];
      const progressEventTypes = latestNativeMessages.flatMap((message) =>
        (message.toolProgress ?? []).map((event) => String(event.detail?.eventType ?? ""))
      );
      const progressStatuses = latestNativeMessages.flatMap((message) =>
        (message.toolProgress ?? []).map((event) => String(event.detail?.status ?? ""))
      );
      assert.deepEqual(spawnedAgents, ["browser"], "approval real LLM E2E must spawn exactly one browser session");
      assert.equal(sessions.length, 1, `approval real LLM E2E must execute one browser sub-agent session, got ${sessions.length}`);
      assert.equal(sessions[0]?.state.status, "done");
      assert.ok(approvalPermissionEvents.some((event) => event.startsWith("query:")), "approval query was not requested");
      assert.ok(approvalPermissionEvents.some((event) => event.startsWith("result:")), "approval result was not observed");
      assert.ok(approvalPermissionEvents.some((event) => event.startsWith("applied:")), "approval was not applied");
      assert.equal(
        approvalPermissionEvents.filter((event) => event.startsWith("applied:")).length,
        1,
        "approval should be applied once and then reused by the runtime gate"
      );
      assert.equal(
        approvalPermissionEvents.filter((event) => event.startsWith("query:")).length,
        2,
        "approval real LLM E2E should query once explicitly and once through the runtime gate"
      );
      assert.ok(toolCallNames.includes("permission_query"), "approval real LLM E2E must call permission_query");
      assert.ok(toolCallNames.includes("permission_result"), "approval real LLM E2E must call permission_result");
      assert.ok(toolCallNames.includes("permission_applied"), "approval real LLM E2E must call permission_applied");
      assert.ok(progressEventTypes.includes("permission.query"), "assistant message must persist permission.query progress");
      assert.ok(progressEventTypes.includes("permission.result"), "assistant message must persist permission.result progress");
      assert.ok(progressEventTypes.includes("permission.applied"), "assistant message must persist permission.applied progress");
      assert.ok(progressStatuses.includes("already_granted"), "runtime gate must reuse the applied approval");
      quality = evaluateAnswerQuality({
        scenario: options.scenario,
        answer: reply.content,
        gate: approvalQualityGate(targetMarker),
        toolCallNames,
        spawnedSessionCount: sessions.length,
      });
      assertAnswerQuality(quality);
    } else if (multiSourceScenario) {
      const spawnedAgents = toolCalls
        .filter((call) => call.name === "sessions_spawn")
        .map((call) => readObservedToolCallInput(call)?.agent_id);
      assert.ok(spawnedAgents.includes("explore"), "complex real LLM E2E must spawn explore");
      assert.ok(spawnedAgents.includes("browser"), "complex real LLM E2E must spawn browser");
      const sessions = workerRuntime.listSessions ? await workerRuntime.listSessions() : [];
      const sessionKinds = sessions.map((session) => session.state.workerType);
      assert.ok(sessions.length <= 4, `complex real LLM E2E spawned too many sub-agent sessions: ${sessions.length}`);
      assert.ok(sessionKinds.includes("explore"), "complex real LLM E2E must execute explore");
      assert.ok(sessionKinds.includes("browser"), "complex real LLM E2E must execute browser");
      quality = evaluateAnswerQuality({
        scenario: options.scenario,
        answer: reply.content,
        gate: multiSourceQualityGate(targetMarker),
        toolCallNames,
        spawnedSessionCount: sessions.length,
      });
      assertAnswerQuality(quality);
    }
    assert.match(reply.content, new RegExp(targetMarker));
    const shouldReadChildTranscript = options.withBrowser || followupScenario || timeoutScenario || approvalScenario;
    const childTranscriptMessages = shouldReadChildTranscript ? (await firstWorkerHistoryLength(workerRuntime)) : undefined;
    if (options.withBrowser) {
      assert.ok((childTranscriptMessages ?? 0) >= 4, "browser sub-agent should persist child transcript entries");
    }
    return {
      mode,
      scenario: options.scenario,
      modelCatalogPath,
      toolCallNames,
      finalMarker: targetMarker,
      finalBytes: Buffer.byteLength(reply.content, "utf8"),
      evidenceBullets: countMarkdownBullets(reply.content),
      qualityFailures: quality?.failures.length ?? 0,
      ...((multiSourceScenario || followupScenario || timeoutScenario || approvalScenario) && workerRuntime.listSessions
        ? { spawnedSessionCount: (await workerRuntime.listSessions()).length }
        : {}),
      ...(childTranscriptMessages !== undefined ? { childTranscriptMessages } : {}),
      ...(approvalScenario ? { permissionEvents: approvalPermissionEvents } : {}),
    };
  } finally {
    await closeWorkerRuntime?.();
    await fixture?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

function countMarkdownBullets(value: string): number {
  return (value.match(/^\s*[-*+]\s+\S/gm) ?? []).length;
}

function readObservedToolCallInput(call: {
  arguments?: Record<string, unknown>;
  input?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  return call.arguments ?? call.input;
}

interface AnswerQualityGate {
  minBytes?: number;
  minBullets?: number;
  minEvidenceSources?: number;
  maxSpawnedSessions?: number;
  requiredPatterns?: Array<{ label: string; pattern: RegExp }>;
  forbiddenPatterns?: Array<{ label: string; pattern: RegExp }>;
  requiredToolNames?: string[];
}

interface AnswerQualityReport {
  scenario: ToolUseScenario | AcceptanceScenarioName;
  finalBytes: number;
  evidenceBullets: number;
  evidenceSourceCount: number;
  failures: string[];
}

type AcceptanceScenarioName =
  | "comparison_research"
  | "browser_dynamic_extraction"
  | "follow_up_resume"
  | "timeout_recovery"
  | "approval_gated_side_effect";

function isMultiSourceScenario(scenario: ToolUseScenario): boolean {
  return scenario === "complex" || scenario === "acceptance";
}

function multiSourceQualityGate(targetMarker: string): AnswerQualityGate {
  return {
    minBytes: 180,
    minBullets: 3,
    minEvidenceSources: 2,
    maxSpawnedSessions: 4,
    requiredToolNames: ["sessions_spawn"],
    requiredPatterns: [
      { label: "target success marker", pattern: new RegExp(escapeRegExp(targetMarker)) },
      { label: "explore evidence marker", pattern: /TURNKEYAI_COMPLEX_EXPLORE_OK/ },
      { label: "browser evidence marker", pattern: /TURNKEYAI_COMPLEX_BROWSER_OK/ },
      { label: "evidence heading", pattern: /Evidence/i },
      { label: "explore source label", pattern: /deterministic e2e worker/i },
      { label: "browser evidence text", pattern: /complex browser evidence/i },
      { label: "residual risk", pattern: /residual risk/i },
    ],
    forbiddenPatterns: [
      { label: "unsupported user-scale claim", pattern: /\b(millions of users|large community|widely adopted)\b/i },
      { label: "unsupported pricing claim", pattern: /\bfree plan|enterprise pricing|starts at \$\d+\b/i },
    ],
  };
}

function followupQualityGate(targetMarker: string): AnswerQualityGate {
  return {
    minBytes: 180,
    minBullets: 3,
    minEvidenceSources: 2,
    maxSpawnedSessions: 1,
    requiredToolNames: ["sessions_spawn", "sessions_send"],
    requiredPatterns: [
      { label: "target success marker", pattern: new RegExp(escapeRegExp(targetMarker)) },
      { label: "evidence heading", pattern: /Evidence/i },
      { label: "phase-one marker", pattern: /TURNKEYAI_FOLLOWUP_PHASE_ONE/ },
      { label: "same-session continuation", pattern: /sessions_send|same session|reused session|follow-up/i },
      { label: "session key", pattern: /session[_ -]?key/i },
      { label: "residual risk", pattern: /residual risk/i },
    ],
    forbiddenPatterns: [
      { label: "duplicate-session claim", pattern: /\b(spawned a second session|duplicate session was used)\b/i },
    ],
  };
}

function timeoutQualityGate(targetMarker: string): AnswerQualityGate {
  return {
    minBytes: 170,
    minBullets: 3,
    minEvidenceSources: 1,
    maxSpawnedSessions: 1,
    requiredToolNames: ["sessions_spawn"],
    requiredPatterns: [
      { label: "target success marker", pattern: new RegExp(escapeRegExp(targetMarker)) },
      { label: "evidence heading", pattern: /Evidence/i },
      { label: "timeout disclosure", pattern: /timeout|timed out/i },
      { label: "not verified", pattern: /not verified/i },
      { label: "residual risk", pattern: /residual risk/i },
    ],
    forbiddenPatterns: [
      { label: "successful slow verification claim", pattern: /\b(slow verification succeeded|verified the slow source)\b/i },
    ],
  };
}

function approvalQualityGate(targetMarker: string): AnswerQualityGate {
  return {
    minBytes: 220,
    minBullets: 3,
    minEvidenceSources: 2,
    maxSpawnedSessions: 1,
    requiredToolNames: ["permission_query", "permission_result", "permission_applied", "sessions_spawn"],
    requiredPatterns: [
      { label: "target success marker", pattern: new RegExp(escapeRegExp(targetMarker)) },
      { label: "evidence heading", pattern: /Evidence/i },
      { label: "permission query", pattern: /permission\.query/i },
      { label: "permission result", pattern: /permission\.result/i },
      { label: "permission applied", pattern: /permission\.applied/i },
      { label: "browser side effect", pattern: /browser\.form\.submit/i },
      { label: "residual risk", pattern: /residual risk/i },
    ],
  };
}

function evaluateAnswerQuality(input: {
  scenario: ToolUseScenario | AcceptanceScenarioName;
  answer: string;
  gate: AnswerQualityGate;
  toolCallNames?: string[];
  spawnedSessionCount?: number;
}): AnswerQualityReport {
  const finalBytes = Buffer.byteLength(input.answer, "utf8");
  const evidenceBullets = countMarkdownBullets(input.answer);
  const evidenceSourceCount = countEvidenceSources(input.answer);
  const failures: string[] = [];
  if (input.gate.minBytes !== undefined && finalBytes < input.gate.minBytes) {
    failures.push(`final answer too thin: ${finalBytes} < ${input.gate.minBytes} bytes`);
  }
  if (input.gate.minBullets !== undefined && evidenceBullets < input.gate.minBullets) {
    failures.push(`not enough evidence bullets: ${evidenceBullets} < ${input.gate.minBullets}`);
  }
  if (input.gate.minEvidenceSources !== undefined && evidenceSourceCount < input.gate.minEvidenceSources) {
    failures.push(`not enough evidence sources: ${evidenceSourceCount} < ${input.gate.minEvidenceSources}`);
  }
  if (
    input.gate.maxSpawnedSessions !== undefined &&
    input.spawnedSessionCount !== undefined &&
    input.spawnedSessionCount > input.gate.maxSpawnedSessions
  ) {
    failures.push(`too many spawned sessions: ${input.spawnedSessionCount} > ${input.gate.maxSpawnedSessions}`);
  }
  for (const required of input.gate.requiredPatterns ?? []) {
    if (!required.pattern.test(input.answer)) {
      failures.push(`missing ${required.label}`);
    }
  }
  for (const forbidden of input.gate.forbiddenPatterns ?? []) {
    if (forbidden.pattern.test(input.answer)) {
      failures.push(`forbidden unsupported claim: ${forbidden.label}`);
    }
  }
  for (const requiredTool of input.gate.requiredToolNames ?? []) {
    if (!input.toolCallNames?.includes(requiredTool)) {
      failures.push(`required tool not used: ${requiredTool}`);
    }
  }
  return {
    scenario: input.scenario,
    finalBytes,
    evidenceBullets,
    evidenceSourceCount,
    failures,
  };
}

function assertAnswerQuality(report: AnswerQualityReport): void {
  assert.deepEqual(report.failures, [], `quality gate failed for ${report.scenario}: ${report.failures.join("; ")}`);
}

function countEvidenceSources(value: string): number {
  const sourceLines = value
    .split(/\r?\n/)
    .filter((line) =>
      /\b(source|evidence|browser|explore|permission|https?:\/\/|deterministic e2e worker)\b/i.test(line)
    );
  return new Set(sourceLines.map((line) => line.trim().toLowerCase())).size;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runMockAcceptanceQualitySuiteE2e(): {
  scenarios: AcceptanceScenarioName[];
  totalFinalBytes: number;
} {
  const cases: Array<{ name: AcceptanceScenarioName; answer: string; gate: AnswerQualityGate }> = [
    {
      name: "comparison_research",
      answer: [
        "## Evidence",
        "- Source: official product page verified positioning and primary workflow.",
        "- Source: repository release notes verified update cadence.",
        "- Residual risk: pricing was not verified, so it is marked not verified.",
        "",
        "Final: comparison completed with unsupported user-scale and pricing claims marked not verified.",
      ].join("\n"),
      gate: {
        minBytes: 180,
        minBullets: 3,
        minEvidenceSources: 2,
        requiredPatterns: [
          { label: "evidence heading", pattern: /Evidence/i },
          { label: "residual risk", pattern: /Residual risk/i },
          { label: "not verified labels", pattern: /not verified/i },
        ],
        forbiddenPatterns: [{ label: "unsupported adoption claim", pattern: /\bmillions of users\b/i }],
      },
    },
    {
      name: "browser_dynamic_extraction",
      answer: [
        "## Evidence",
        "- Browser evidence: the dashboard title and live metric were observed from the rendered page.",
        "- Source: screenshot artifact captured the visible state for operator review.",
        "- Residual risk: data may change after the snapshot timestamp.",
        "",
        "Final: dynamic browser extraction completed from rendered page evidence.",
      ].join("\n"),
      gate: {
        minBytes: 170,
        minBullets: 3,
        minEvidenceSources: 2,
        requiredPatterns: [
          { label: "browser evidence", pattern: /Browser evidence/i },
          { label: "screenshot artifact", pattern: /screenshot artifact/i },
          { label: "residual risk", pattern: /Residual risk/i },
        ],
      },
    },
    {
      name: "follow_up_resume",
      answer: [
        "## Evidence",
        "- Source: existing session history supplied the original browser session id and prior finding.",
        "- Browser evidence: follow-up reused the existing session before issuing the continuation.",
        "- Residual risk: if the page expires, a cold resume may need operator confirmation.",
        "",
        "Final: follow-up continued from durable session history without starting a duplicate investigation.",
      ].join("\n"),
      gate: {
        minBytes: 210,
        minBullets: 3,
        minEvidenceSources: 2,
        requiredPatterns: [
          { label: "session history", pattern: /session history/i },
          { label: "existing session", pattern: /existing session/i },
          { label: "residual risk", pattern: /Residual risk/i },
        ],
      },
    },
    {
      name: "timeout_recovery",
      answer: [
        "## Evidence",
        "- Evidence: the worker returned a timeout summary with partial transcript before hard abort.",
        "- Source: available tool result was used for the final answer instead of inventing missing data.",
        "- Residual risk: unresolved fields are listed as not verified until the user asks to continue.",
        "",
        "Final: timeout recovery produced an evidence-only answer and preserved a continuation path.",
      ].join("\n"),
      gate: {
        minBytes: 220,
        minBullets: 3,
        minEvidenceSources: 2,
        requiredPatterns: [
          { label: "timeout summary", pattern: /timeout summary/i },
          { label: "not verified", pattern: /not verified/i },
          { label: "continue path", pattern: /continu/i },
        ],
      },
    },
    {
      name: "approval_gated_side_effect",
      answer: [
        "## Evidence",
        "- Source: permission.query recorded the proposed side effect before browser mutation.",
        "- Source: permission.applied confirmed approval before executing the action.",
        "- Residual risk: if approval is denied, the action must remain unexecuted and the final answer must explain the safe fallback.",
        "",
        "Final: side-effectful browser work remained permission-gated and auditable.",
      ].join("\n"),
      gate: {
        minBytes: 220,
        minBullets: 3,
        minEvidenceSources: 2,
        requiredPatterns: [
          { label: "permission query", pattern: /permission\.query/i },
          { label: "permission applied", pattern: /permission\.applied/i },
          { label: "residual risk", pattern: /Residual risk/i },
        ],
      },
    },
  ];
  const reports = cases.map((item) => {
    const report = evaluateAnswerQuality({ scenario: item.name, answer: item.answer, gate: item.gate });
    assertAnswerQuality(report);
    return report;
  });
  return {
    scenarios: cases.map((item) => item.name),
    totalFinalBytes: reports.reduce((sum, report) => sum + report.finalBytes, 0),
  };
}

function buildRealExploreWorkerRuntime(): WorkerRuntime {
  const handler: WorkerHandler = {
    kind: "explore",
    canHandle(input) {
      return input.packet.preferredWorkerKinds?.includes("explore") === true;
    },
    async run(): Promise<WorkerExecutionResult> {
      return {
        workerType: "explore",
        status: "completed",
        summary: "Explore sub-agent returned the release markers TURNKEYAI_LLM_E2E_OK and TURNKEYAI_COMPLEX_EXPLORE_OK.",
        payload: {
          marker: "TURNKEYAI_LLM_E2E_OK",
          complex_marker: "TURNKEYAI_COMPLEX_EXPLORE_OK",
          source: "deterministic e2e worker",
          content:
            "Explore evidence: deterministic e2e worker verified TURNKEYAI_COMPLEX_EXPLORE_OK from the release-gate source.",
        },
      };
    },
  };
  const registry: WorkerRegistry = {
    async selectHandler(input) {
      return input.packet.preferredWorkerKinds?.includes("explore") ? handler : null;
    },
    async getHandler(kind) {
      return kind === "explore" ? handler : null;
    },
  };
  return new InMemoryWorkerRuntime({ workerRegistry: registry });
}

function buildRealFollowupWorkerRuntime(): WorkerRuntime {
  const handler: WorkerHandler = {
    kind: "explore",
    canHandle(input) {
      return input.packet.preferredWorkerKinds?.includes("explore") === true;
    },
    async run(input: WorkerInvocationInput): Promise<WorkerExecutionResult> {
      const isFollowup = input.packet.continuityMode === "resume-existing";
      if (!isFollowup) {
        return {
          workerType: "explore",
          status: "partial",
          summary:
            "Phase one complete: TURNKEYAI_FOLLOWUP_PHASE_ONE. Continue this same session with sessions_send message: continue-followup-phase-two.",
          payload: {
            mode: "deterministic_followup_phase_one",
            marker: "TURNKEYAI_FOLLOWUP_PHASE_ONE",
            continuation_message: "continue-followup-phase-two",
            content:
              "Phase-one evidence: deterministic follow-up worker returned TURNKEYAI_FOLLOWUP_PHASE_ONE and requested sessions_send continuation on the same session.",
          },
        };
      }
      const message = input.packet.taskPrompt;
      const usedRequestedContinuation = /continue-followup-phase-two/i.test(message);
      return {
        workerType: "explore",
        status: "completed",
        summary: usedRequestedContinuation
          ? "Follow-up completed on the same session with TURNKEYAI_FOLLOWUP_E2E_OK."
          : "Follow-up completed, but the requested continuation phrase was not preserved.",
        payload: {
          mode: "deterministic_followup_phase_two",
          marker: "TURNKEYAI_FOLLOWUP_E2E_OK",
          phase_one_marker: "TURNKEYAI_FOLLOWUP_PHASE_ONE",
          used_requested_continuation: usedRequestedContinuation,
          content:
            "Follow-up evidence: sessions_send resumed the existing deterministic worker session and returned TURNKEYAI_FOLLOWUP_E2E_OK.",
        },
      };
    },
  };
  const registry: WorkerRegistry = {
    async selectHandler(input) {
      return input.packet.preferredWorkerKinds?.includes("explore") ? handler : null;
    },
    async getHandler(kind) {
      return kind === "explore" ? handler : null;
    },
  };
  return new InMemoryWorkerRuntime({ workerRegistry: registry });
}

function buildRealTimeoutWorkerRuntime(): WorkerRuntime {
  const handler: WorkerHandler = {
    kind: "explore",
    canHandle(input) {
      return input.packet.preferredWorkerKinds?.includes("explore") === true;
    },
    async run(): Promise<WorkerExecutionResult> {
      await new Promise(() => undefined);
      return {
        workerType: "explore",
        status: "completed",
        summary: "unreachable slow verification result",
        payload: null,
      };
    },
  };
  const registry: WorkerRegistry = {
    async selectHandler(input) {
      return input.packet.preferredWorkerKinds?.includes("explore") ? handler : null;
    },
    async getHandler(kind) {
      return kind === "explore" ? handler : null;
    },
  };
  return new InMemoryWorkerRuntime({ workerRegistry: registry });
}

function buildRealApprovalWorkerRuntime(): WorkerRuntime {
  const handler: WorkerHandler = {
    kind: "browser",
    canHandle(input) {
      return input.packet.preferredWorkerKinds?.includes("browser") === true;
    },
    async run(): Promise<WorkerExecutionResult> {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Approved browser.form.submit completed after permission.applied.",
        payload: {
          marker: "TURNKEYAI_APPROVAL_WORKER_OK",
          action: "browser.form.submit",
          content:
            "Browser evidence: browser.form.submit completed only after permission.query, permission.result, and permission.applied.",
        },
      };
    },
  };
  const registry: WorkerRegistry = {
    async selectHandler(input) {
      return input.packet.preferredWorkerKinds?.includes("browser") ? handler : null;
    },
    async getHandler(kind) {
      return kind === "browser" ? handler : null;
    },
  };
  return new InMemoryWorkerRuntime({ workerRegistry: registry });
}

function buildRealComplexWorkerRuntime(input: {
  gateway: LLMGateway;
  fixtureUrl: string;
  tempDir: string;
}): { workerRuntime: WorkerRuntime; close: () => Promise<void> } {
  const browserBridge = createBrowserBridge({
    transportMode: "local",
    artifactRootDir: path.join(input.tempDir, "browser-artifacts"),
    stateRootDir: path.join(input.tempDir, "browser-state"),
    headless: true,
  });
  const exploreHandler: WorkerHandler = {
    kind: "explore",
    canHandle(workerInput) {
      return workerInput.packet.preferredWorkerKinds?.includes("explore") === true;
    },
    async run(): Promise<WorkerExecutionResult> {
      return {
        workerType: "explore",
        status: "completed",
        summary: "Explore evidence verified TURNKEYAI_COMPLEX_EXPLORE_OK from deterministic e2e worker.",
        payload: {
          mode: "deterministic_e2e_explore",
          marker: "TURNKEYAI_COMPLEX_EXPLORE_OK",
          source: "deterministic e2e worker",
          content:
            "Explore evidence: deterministic e2e worker verified TURNKEYAI_COMPLEX_EXPLORE_OK from the release-gate source.",
        },
      };
    },
  };
  const innerBrowserHandler: WorkerHandler = {
    kind: "browser",
    canHandle(workerInput) {
      return workerInput.packet.preferredWorkerKinds?.includes("browser") === true;
    },
    async run(): Promise<WorkerExecutionResult> {
      return {
        workerType: "browser",
        status: "failed",
        summary: "Browser private tool surface was not used.",
        payload: { fixtureUrl: input.fixtureUrl },
      };
    },
  };
  const browserHandler = new LLMSubAgentWorkerHandler({
    kind: "browser",
    innerHandler: innerBrowserHandler,
    gateway: input.gateway,
    browserBridge,
    maxRounds: 6,
    maxWallClockMs: 180_000,
  });
  const registry: WorkerRegistry = {
    async selectHandler(workerInput) {
      if (workerInput.packet.preferredWorkerKinds?.includes("explore")) {
        return exploreHandler;
      }
      if (workerInput.packet.preferredWorkerKinds?.includes("browser")) {
        return browserHandler;
      }
      return null;
    },
    async getHandler(kind) {
      if (kind === "explore") {
        return exploreHandler;
      }
      if (kind === "browser") {
        return browserHandler;
      }
      return null;
    },
  };
  return {
    workerRuntime: new InMemoryWorkerRuntime({ workerRegistry: registry }),
    close: async () => {
      const sessions = await browserBridge.listSessions().catch(() => []);
      await Promise.all(
        sessions.map((session) => browserBridge.closeSession(session.browserSessionId, "real llm e2e complete").catch(() => {}))
      );
    },
  };
}

function buildRealBrowserWorkerRuntime(input: {
  gateway: LLMGateway;
  fixtureUrl: string;
  tempDir: string;
}): { workerRuntime: WorkerRuntime; close: () => Promise<void> } {
  const browserBridge = createBrowserBridge({
    transportMode: "local",
    artifactRootDir: path.join(input.tempDir, "browser-artifacts"),
    stateRootDir: path.join(input.tempDir, "browser-state"),
    headless: true,
  });
  const innerHandler: WorkerHandler = {
    kind: "browser",
    canHandle(workerInput) {
      return workerInput.packet.preferredWorkerKinds?.includes("browser") === true;
    },
    async run(): Promise<WorkerExecutionResult> {
      return {
        workerType: "browser",
        status: "failed",
        summary: "Browser private tool surface was not used.",
        payload: { fixtureUrl: input.fixtureUrl },
      };
    },
  };
  const handler = new LLMSubAgentWorkerHandler({
    kind: "browser",
    innerHandler,
    gateway: input.gateway,
    browserBridge,
    maxRounds: 6,
    maxWallClockMs: 180_000,
  });
  const registry: WorkerRegistry = {
    async selectHandler(workerInput) {
      return workerInput.packet.preferredWorkerKinds?.includes("browser") ? handler : null;
    },
    async getHandler(kind) {
      return kind === "browser" ? handler : null;
    },
  };
  return {
    workerRuntime: new InMemoryWorkerRuntime({ workerRegistry: registry }),
    close: async () => {
      const sessions = await browserBridge.listSessions().catch(() => []);
      await Promise.all(
        sessions.map((session) => browserBridge.closeSession(session.browserSessionId, "real llm e2e complete").catch(() => {}))
      );
    },
  };
}

function buildApprovalToolPermissionService(permissionEvents: string[]): ToolPermissionService {
  const pendingApprovals = new Map<string, { action: string; cacheKey: string }>();
  const appliedCacheKeys = new Set<string>();
  const appliedActions = new Set<string>();
  return {
    async request(input) {
      permissionEvents.push(`query:${input.toolCallId}`);
      const cacheKey = input.requirement.cacheKey ?? deriveApprovalCacheKey(input);
      if (appliedCacheKeys.has(cacheKey) || appliedActions.has(input.action)) {
        return {
          status: "already_granted",
          action: input.action,
          requirement: {
            level: input.requirement.level,
            scope: input.requirement.scope,
            cacheKey,
            rationale: input.requirement.rationale,
            workerType: input.requirement.workerType ?? "browser",
          },
          message: "Approval already applied.",
        };
      }
      const approvalId = `ap.${input.threadId}.${input.toolCallId}`;
      pendingApprovals.set(approvalId, { action: input.action, cacheKey });
      return {
        status: "pending",
        approvalId,
        action: input.action,
        requirement: {
          level: input.requirement.level,
          scope: input.requirement.scope,
          cacheKey,
          rationale: input.requirement.rationale,
          workerType: input.requirement.workerType ?? "browser",
        },
        message: "Approval pending.",
      };
    },
    async result(input) {
      permissionEvents.push(`result:${input.approvalId}`);
      const pending = pendingApprovals.get(input.approvalId);
      return {
        status: "approved",
        approvalId: input.approvalId,
        action: pending?.action ?? "browser.form.submit",
        message: "Approved.",
      };
    },
    async waitForDecision(input) {
      permissionEvents.push(`result:${input.approvalId}`);
      const pending = pendingApprovals.get(input.approvalId);
      return {
        status: "approved",
        approvalId: input.approvalId,
        action: pending?.action ?? "browser.form.submit",
        message: "Approved.",
      };
    },
    async apply(input) {
      permissionEvents.push(`applied:${input.approvalId}`);
      const pending = pendingApprovals.get(input.approvalId);
      const cacheKey = pending?.cacheKey ?? "thread-tool-e2e:browser:mutate:approval:browser.form.submit";
      appliedCacheKeys.add(cacheKey);
      appliedActions.add(pending?.action ?? "browser.form.submit");
      return {
        status: "applied",
        approvalId: input.approvalId,
        cacheKey,
        message: "Applied.",
      };
    },
  };
}

function deriveApprovalCacheKey(input: Parameters<ToolPermissionService["request"]>[0]): string {
  return [
    input.threadId,
    input.requirement.workerType ?? "browser",
    input.requirement.scope,
    input.requirement.level,
    input.action,
  ].join(":");
}

async function firstWorkerHistoryLength(workerRuntime: WorkerRuntime): Promise<number> {
  const sessions = workerRuntime.listSessions ? await workerRuntime.listSessions() : [];
  return sessions[0]?.state.history?.length ?? 0;
}

async function startBrowserFixture(input?: { marker?: string; evidence?: string }): Promise<{ url: string; close: () => Promise<void> }> {
  const marker = input?.marker ?? "TURNKEYAI_BROWSER_E2E_OK";
  const evidence = input?.evidence ?? "Browser fixture says: private browser tools observed this page.";
  const server = createServer((req, res) => {
    if (req.url === "/favicon.ico") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html>
        <head><title>TurnkeyAI Tool Use Browser E2E</title></head>
        <body>
          <main>
            <h1>${escapeHtml(marker)}</h1>
            <p id="evidence">${escapeHtml(evidence)}</p>
          </main>
        </body>
      </html>`);
  });
  await listen(server, "127.0.0.1");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind real browser e2e fixture server");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => closeServer(server),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function runMockSubAgentToolUseE2e(): Promise<{
  kind: WorkerKind;
  llmRounds: number;
  privateToolName: string;
}> {
  process.env.TOOL_USE_E2E_KEY = process.env.TOOL_USE_E2E_KEY || "mock-tool-use-e2e-key";
  const llmInputs: GenerateTextInput[] = [];
  const innerTaskPrompts: string[] = [];
  const gateway = new LLMGateway({
    registry: new ModelRegistry(new SingleModelCatalogSource()),
    clients: [
      new ScriptedSubAgentClient({
        privateToolName: "explore_run",
        inputs: llmInputs,
      }),
    ],
  });
  const innerHandler: WorkerHandler = {
    kind: "explore",
    canHandle(input) {
      return input.packet.preferredWorkerKinds?.includes("explore") === true;
    },
    async run(input: WorkerInvocationInput): Promise<WorkerExecutionResult> {
      innerTaskPrompts.push(input.packet.taskPrompt);
      return {
        workerType: "explore",
        status: "completed",
        summary: "Fetched and extracted the requested source.",
        payload: {
          source: "https://example.test/source",
          facts: ["source fact"],
        },
      };
    },
  };
  const handler = new LLMSubAgentWorkerHandler({
    kind: "explore",
    innerHandler,
    gateway,
  });

  const result = await handler.run({
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      systemPrompt: "Parent prompt",
      taskPrompt: "Investigate the source and summarize the verified fact.",
      outputContract: "Return a concise final answer.",
      suggestedMentions: [],
      preferredWorkerKinds: ["explore"],
    },
  });

  assert.equal(result?.status, "completed");
  assert.equal(result?.summary, "The sub-agent verified the requested source fact.");
  assert.deepEqual(innerTaskPrompts, ["Fetch the source and extract the fact."]);
  const toolNames = llmInputs[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.deepEqual(toolNames, ["explore_run"]);
  assert.equal(toolNames.includes("sessions_spawn"), false);
  assert.equal(
    ((result?.payload as { metadata?: { toolUse?: { toolCallCount?: number } } }).metadata?.toolUse?.toolCallCount),
    1
  );

  return {
    kind: "explore",
    llmRounds: llmInputs.length,
    privateToolName: "explore_run",
  };
}

async function runMockNativeToolUseE2e(): Promise<{
  llmRounds: number;
  toolCallId: string;
  nativeMessageCount: number;
  permissionEvents: string[];
}> {
  process.env.TOOL_USE_E2E_KEY = process.env.TOOL_USE_E2E_KEY || "mock-tool-use-e2e-key";
  const activation = buildActivation();
  const toolCallId = "call-browser-submit";
  const llmInputs: GenerateTextInput[] = [];
  const nativeMessages: TeamMessage[] = [];
  const permissionEvents: string[] = [];
  let workerSendToolCallId: string | undefined;

  const registry = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["browser", "explore"],
    permissionsEnabled: true,
    memoryEnabled: true,
    tasksEnabled: true,
  });
  const gateway = new LLMGateway({
    registry: new ModelRegistry(new SingleModelCatalogSource()),
    clients: [
      new ScriptedToolCallClient({
        toolCallId,
        inputs: llmInputs,
      }),
    ],
  });
  const workerRuntime: WorkerRuntime = {
    async spawn() {
      return { workerType: "browser", workerRunKey: "worker:browser:task-tool-e2e" };
    },
    async send(input) {
      workerSendToolCallId = input.toolCallId;
      return {
        workerType: "browser",
        status: "completed",
        summary: "Browser submit completed under approved permission.",
        payload: {
          sessionId: "browser-session-tool-e2e",
          finalUrl: "https://example.test/done",
        },
      };
    },
    async resume() {
      throw new Error("not used");
    },
    async interrupt() {
      throw new Error("not used");
    },
    async cancel() {
      throw new Error("not used");
    },
    async getState() {
      return null;
    },
    async maybeRunForRole() {
      throw new Error("not used");
    },
  };
  const toolPermissionService = buildApprovalToolPermissionService(permissionEvents);

  const generator = new LLMRoleResponseGenerator({
    gateway,
    nativeToolMessageStore: {
      async append(message) {
        nativeMessages.push(message);
      },
    },
    toolLoop: {
      executor: createWorkerSessionToolExecutor({
        workerRuntime,
        toolCapabilityRegistry: registry,
        toolPermissionService,
      }),
    },
    clock: { now: () => 10_000 + nativeMessages.length },
  });

  const reply = await generator.generate({
    activation,
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: registry.renderPromptHarness({ seat: "lead" }),
      taskPrompt: "Use the browser worker to submit the approved form and report the result.",
      outputContract: "Return a concise final answer.",
      suggestedMentions: [],
    },
  });

  const latestById = new Map(nativeMessages.map((message) => [message.id, message]));
  const persistedMessages = [...latestById.values()];
  const assistantToolMessage = persistedMessages.find((message) => message.role === "assistant" && message.toolCalls?.length);
  const toolResultMessage = persistedMessages.find((message) => message.role === "tool" && message.toolCallId === toolCallId);

  assert.equal(reply.content, "The approved browser form submission completed.");
  assert.equal(llmInputs.length, 2, "mock LLM should be called once for tool_use and once after tool_result");
  assert.ok(llmInputs[0]?.tools?.some((tool) => tool.name === "sessions_spawn"));
  assert.ok(llmInputs[0]?.tools?.some((tool) => tool.name === "permission_query"));
  assert.ok(llmInputs[0]?.tools?.some((tool) => tool.name === "tasks_create"));
  assert.equal(llmInputs[1]?.messages.some((message) => message.role === "tool" && message.toolCallId === toolCallId), true);
  assert.equal(workerSendToolCallId, toolCallId);
  assert.ok(assistantToolMessage);
  assert.equal(assistantToolMessage.toolCalls?.[0]?.id, toolCallId);
  assert.equal(
    assistantToolMessage.toolProgress?.some((event) => event.detail?.eventType === "permission.applied"),
    true
  );
  assert.ok(toolResultMessage);
  assert.match(toolResultMessage.content, /Browser submit completed/);

  return {
    llmRounds: llmInputs.length,
    toolCallId,
    nativeMessageCount: persistedMessages.length,
    permissionEvents,
  };
}

class SingleModelCatalogSource implements ModelCatalogSource {
  async load(): Promise<ModelCatalog> {
    return {
      models: {
        "tool-e2e-model": {
          label: "Tool E2E",
          providerId: "mock",
          protocol: "openai-compatible",
          model: "tool-e2e-model",
          baseURL: "https://mock.invalid/v1",
          apiKeyEnv: "TOOL_USE_E2E_KEY",
        },
      },
    };
  }
}

class ScriptedToolCallClient implements ProtocolClient {
  constructor(private readonly input: { toolCallId: string; inputs: GenerateTextInput[] }) {}

  supports(protocol: ModelProtocol): boolean {
    return protocol === "openai-compatible";
  }

  async generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    this.input.inputs.push(input);
    const sawToolResult = input.messages.some(
      (message) => message.role === "tool" && message.toolCallId === this.input.toolCallId
    );
    if (!sawToolResult) {
      return {
        text: "",
        toolCalls: [
          {
            id: this.input.toolCallId,
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              task: "Open https://example.test/account and submit the final form.",
            },
          },
        ],
        modelId: input.modelId ?? model.id,
        providerId: model.providerId,
        protocol: model.protocol,
        adapterName: "tool-use-e2e-mock",
        raw: { round: 1 },
      };
    }
    return {
      text: "The approved browser form submission completed.",
      modelId: input.modelId ?? model.id,
      providerId: model.providerId,
      protocol: model.protocol,
      adapterName: "tool-use-e2e-mock",
      raw: { round: 2 },
    };
  }
}

class ScriptedSubAgentClient implements ProtocolClient {
  constructor(private readonly input: { privateToolName: string; inputs: GenerateTextInput[] }) {}

  supports(protocol: ModelProtocol): boolean {
    return protocol === "openai-compatible";
  }

  async generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    this.input.inputs.push(input);
    const sawToolResult = input.messages.some(
      (message) => message.role === "tool" && message.toolCallId === "call-sub-agent-private-tool"
    );
    if (!sawToolResult) {
      return {
        text: "",
        toolCalls: [
          {
            id: "call-sub-agent-private-tool",
            name: this.input.privateToolName,
            input: {
              instruction: "Fetch the source and extract the fact.",
            },
          },
        ],
        modelId: input.modelId ?? model.id,
        providerId: model.providerId,
        protocol: model.protocol,
        adapterName: "tool-use-sub-agent-e2e-mock",
        raw: { round: 1 },
      };
    }
    return {
      text: "The sub-agent verified the requested source fact.",
      modelId: input.modelId ?? model.id,
      providerId: model.providerId,
      protocol: model.protocol,
      adapterName: "tool-use-sub-agent-e2e-mock",
      raw: { round: 2 },
    };
  }
}

function buildActivation(input: { modelId?: string; modelChainId?: string; useCatalogDefault?: boolean } = {}): RoleActivationInput {
  return {
    thread: {
      threadId: "thread-tool-e2e",
      teamId: "team-tool-e2e",
      teamName: "Tool E2E Team",
      leadRoleId: "role-lead",
      roles: [
        {
          roleId: "role-lead",
          name: "Lead",
          seat: "lead",
          runtime: "local",
          ...(input.modelId ? { modelRef: input.modelId } : input.useCatalogDefault ? {} : { modelRef: "tool-e2e-model" }),
          ...(input.modelChainId ? { modelChain: input.modelChainId } : {}),
        },
      ],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    flow: {
      flowId: "flow-tool-e2e",
      threadId: "thread-tool-e2e",
      rootMessageId: "msg-root",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: ["role-lead"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 1,
      maxHops: 4,
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    },
    runState: {
      runKey: "role:role-lead:thread:thread-tool-e2e",
      threadId: "thread-tool-e2e",
      roleId: "role-lead",
      mode: "group",
      status: "running",
      iterationCount: 1,
      maxIterations: 4,
      inbox: [],
      lastActiveAt: 1,
    },
    handoff: {
      taskId: "task-tool-e2e",
      flowId: "flow-tool-e2e",
      sourceMessageId: "msg-root",
      targetRoleId: "role-lead",
      activationType: "cascade",
      threadId: "thread-tool-e2e",
      payload: {
        threadId: "thread-tool-e2e",
        intent: {
          relayBrief: "Run tool-use e2e.",
          recentMessages: [],
        },
      },
      createdAt: 1,
    },
  };
}

function resolveModelCatalogPath(explicitPath?: string): string {
  if (explicitPath?.trim()) {
    const candidate = explicitPath.trim();
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch (error) {
      throw new Error(
        `real LLM E2E model catalog is not readable: ${candidate} (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }

  const candidates = [
    process.env.TURNKEYAI_MODEL_CATALOG,
    path.resolve(process.cwd(), "models.local.json"),
    path.resolve(process.cwd(), "models.json"),
  ].filter((item): item is string => Boolean(item?.trim()));

  for (const candidate of candidates) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {}
  }
  throw new Error(
    "real LLM E2E requires --model-catalog, TURNKEYAI_MODEL_CATALOG, models.local.json, or models.json"
  );
}

function resolveRealModelSelection(
  modelCatalogPath: string,
  options: ToolUseE2eOptions
): { modelId?: string; modelChainId?: string } {
  if (options.modelId || options.modelChainId) {
    return {
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.modelChainId ? { modelChainId: options.modelChainId } : {}),
    };
  }
  const catalog = JSON.parse(readFileSync(modelCatalogPath, "utf8")) as unknown;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error(`model catalog must be a JSON object: ${modelCatalogPath}`);
  }
  const modelCatalog = catalog as {
    defaultModelId?: unknown;
    defaultModelChainId?: unknown;
  };
  if (typeof modelCatalog.defaultModelChainId === "string" && modelCatalog.defaultModelChainId.trim()) {
    return { modelChainId: modelCatalog.defaultModelChainId.trim() };
  }
  if (typeof modelCatalog.defaultModelId === "string" && modelCatalog.defaultModelId.trim()) {
    return { modelId: modelCatalog.defaultModelId.trim() };
  }
  throw new Error("real LLM E2E requires --model-id, --model-chain-id, defaultModelChainId, or defaultModelId");
}

async function listen(server: Server, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...resolveDaemonTokenEnv(),
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? "null"}`));
      }
    });
  });
}

function resolveDaemonTokenEnv(): Record<string, string> {
  if (process.env.TURNKEYAI_DAEMON_TOKEN?.trim()) {
    return {};
  }
  try {
    const config = JSON.parse(readFileSync(path.join(os.homedir(), ".turnkeyai", "config.json"), "utf8")) as {
      token?: unknown;
    };
    return typeof config.token === "string" && config.token.trim()
      ? { TURNKEYAI_DAEMON_TOKEN: config.token.trim() }
      : {};
  } catch {
    return {};
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(parseOptions(process.argv.slice(2)));
}
