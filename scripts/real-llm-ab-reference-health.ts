import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface ReferenceHealthOptions {
  tasksPath: string;
  outPath: string;
  check: boolean;
}

interface ReferenceTaskManifest {
  kind?: unknown;
  tasks?: unknown;
}

interface ReferenceTask {
  scenarioId: string;
  prompt?: string;
  expectedReferenceArtifactPath: string;
}

interface ReferenceArtifactShape {
  prompt?: unknown;
  userPrompt?: unknown;
  input?: { prompt?: unknown };
  request?: { prompt?: unknown };
  durationMs?: unknown;
  timedOut?: unknown;
  threadId?: unknown;
  notes?: unknown;
  provenance?: {
    modelCatalog?: unknown;
    provider?: unknown;
    modelId?: unknown;
    exactRequestPayload?: unknown;
    rawResponse?: unknown;
    rawTranscript?: unknown;
    rawToolCalls?: unknown;
    rawToolResults?: unknown;
    rawBrowserEvidence?: unknown;
    rawApprovalEvidence?: unknown;
    rawFlowEvidence?: unknown;
    referenceScenarioDriver?: unknown;
    exitStatus?: unknown;
    errorReason?: unknown;
  };
  rawResponse?: unknown;
  rawTranscript?: unknown;
  rawToolCalls?: unknown;
  rawToolResults?: unknown;
  rawBrowserEvidence?: unknown;
  rawApprovalEvidence?: unknown;
  rawFlowEvidence?: unknown;
  first?: { summary?: { finalText?: unknown; toolCallCount?: unknown; toolResultCount?: unknown } };
  score?: { useful?: unknown; weak?: unknown };
  exitStatus?: unknown;
  errorReason?: unknown;
}

interface ReferenceHealthReport {
  kind: "turnkeyai.real-llm-ab-reference-runtime-health.report";
  status: "passed" | "failed";
  generatedAtMs: number;
  tasksPath: string;
  taskCount: number;
  healthyCount: number;
  unhealthyCount: number;
  missingArtifactCount: number;
  scenarios: ReferenceHealthScenario[];
}

interface ReferenceHealthScenario {
  scenarioId: string;
  artifactPath: string;
  status: "healthy" | "unhealthy" | "missing";
  checks: {
    artifactPresent: boolean;
    modelConfigured: boolean;
    promptReceived: boolean;
    finalAnswerCaptured: boolean;
    finalAnswerUseful: boolean;
    toolOrWorkerTriggered: boolean;
    toolOrWorkerResult: boolean;
    browserRenderedEvidence: boolean | "not_required";
    runtimeHealthy: boolean;
  };
  rootCauseBuckets: string[];
  rootCauseEvidence: ReferenceRootCauseEvidence[];
  findings: string[];
}

interface ReferenceRootCauseEvidence {
  bucket: string;
  source: string;
  detail: string;
}

export function parseRealLlmAbReferenceHealthArgs(args: string[]): ReferenceHealthOptions | { help: true } {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    return { help: true };
  }
  let tasksPath: string | undefined;
  let outPath: string | undefined;
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tasks") {
      tasksPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      outPath = readValue(args, index, arg);
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
  if (!outPath) throw new Error("missing required --out <path>");
  return { tasksPath, outPath, check };
}

export function buildRealLlmAbReferenceHealthHelpText(): string {
  return [
    "TurnkeyAI real LLM A/B reference runtime health gate",
    "",
    "Usage:",
    "  npm run acceptance:ab:reference-health -- --tasks <reference-collection-tasks.json> --out <health-report.json> [--check]",
    "",
    "The gate verifies that collected reference artifacts came from a configured model, received the same natural prompt, triggered native tool/worker execution, captured useful final text, and produced rendered browser evidence when the scenario requires browser work.",
  ].join("\n");
}

export async function runRealLlmAbReferenceHealthCli(args: string[]): Promise<void> {
  const options = parseRealLlmAbReferenceHealthArgs(args);
  if ("help" in options) {
    console.log(buildRealLlmAbReferenceHealthHelpText());
    return;
  }
  const report = buildRealLlmAbReferenceHealthReport(options);
  const resolvedOutPath = path.resolve(options.outPath);
  mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
  writeFileSync(resolvedOutPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`real LLM A/B reference runtime health report written: ${resolvedOutPath}`);
  if (options.check && report.status !== "passed") {
    console.error("real LLM A/B reference runtime health failed");
    for (const scenario of report.scenarios) {
      if (scenario.status !== "healthy") {
        console.error(`- ${scenario.scenarioId}: ${scenario.findings.join("; ")}`);
      }
    }
    process.exitCode = 1;
  }
}

export function buildRealLlmAbReferenceHealthReport(input: {
  tasksPath: string;
  generatedAtMs?: number;
}): ReferenceHealthReport {
  const tasksPath = path.resolve(input.tasksPath);
  const manifest = readJsonFile<ReferenceTaskManifest>(tasksPath);
  const tasks = readReferenceTasks(manifest);
  const scenarios = tasks.map((task) => auditReferenceHealthScenario(task, path.dirname(tasksPath)));
  const healthyCount = scenarios.filter((scenario) => scenario.status === "healthy").length;
  const missingArtifactCount = scenarios.filter((scenario) => scenario.status === "missing").length;
  return {
    kind: "turnkeyai.real-llm-ab-reference-runtime-health.report",
    status: healthyCount === scenarios.length ? "passed" : "failed",
    generatedAtMs: input.generatedAtMs ?? Date.now(),
    tasksPath,
    taskCount: scenarios.length,
    healthyCount,
    unhealthyCount: scenarios.length - healthyCount,
    missingArtifactCount,
    scenarios,
  };
}

function auditReferenceHealthScenario(task: ReferenceTask, taskDir: string): ReferenceHealthScenario {
  const artifactPath = path.resolve(taskDir, task.expectedReferenceArtifactPath);
  const requiresBrowser = referenceScenarioRequiresBrowser(task.scenarioId);
  let artifact: ReferenceArtifactShape;
  try {
    artifact = readJsonFile<ReferenceArtifactShape>(artifactPath);
  } catch (error) {
    return {
      scenarioId: task.scenarioId,
      artifactPath,
      status: "missing",
      checks: {
        artifactPresent: false,
        modelConfigured: false,
        promptReceived: false,
        finalAnswerCaptured: false,
        finalAnswerUseful: false,
        toolOrWorkerTriggered: false,
        toolOrWorkerResult: false,
        browserRenderedEvidence: requiresBrowser ? false : "not_required",
        runtimeHealthy: false,
      },
      rootCauseBuckets: ["reference_artifact_missing"],
      rootCauseEvidence: [
        {
          bucket: "reference_artifact_missing",
          source: "artifact",
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
      findings: [`reference artifact missing or unreadable: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const effectiveMessages = readEffectiveReferenceArtifactMessages(artifact, artifactPath);
  const finalText = readLatestAssistantText(effectiveMessages ?? []) ?? readFinalText(artifact);
  const promptReceived = task.prompt
    ? normalizePromptForAudit(readReferencePrompt(artifact)) === normalizePromptForAudit(task.prompt) &&
      normalizePromptForAudit(readExactRequestPrompt(artifact.provenance?.exactRequestPayload)) === normalizePromptForAudit(task.prompt)
    : Boolean(readReferencePrompt(artifact) && readExactRequestPrompt(artifact.provenance?.exactRequestPayload));
  const modelConfigured = hasConfiguredModel(artifact.provenance?.modelCatalog) && hasKnownString(artifact.provenance?.provider) && hasKnownString(artifact.provenance?.modelId);
  const rawToolCalls = [
    ...readArray(artifact.provenance?.rawToolCalls ?? artifact.rawToolCalls),
    ...(effectiveMessages ? extractToolCalls(effectiveMessages) : []),
  ];
  const rawToolResults = [
    ...readArray(artifact.provenance?.rawToolResults ?? artifact.rawToolResults),
    ...(effectiveMessages ? extractToolResults(effectiveMessages) : []),
  ];
  const rawBrowserEvidence = [
    ...readArray(artifact.provenance?.rawBrowserEvidence ?? artifact.rawBrowserEvidence),
    ...(effectiveMessages ? extractBrowserEvidenceFromTranscript(effectiveMessages) : []),
  ];
  const rawApprovalEvidence = artifact.provenance?.rawApprovalEvidence ?? artifact.rawApprovalEvidence;
  const rawFlowEvidence = artifact.provenance?.rawFlowEvidence ?? artifact.rawFlowEvidence;
  const approvalWaitTimeoutBaselineLoss = isApprovalWaitTimeoutBaselineLoss({
    scenarioId: task.scenarioId,
    artifact,
    rawToolCalls,
    rawToolResults,
    rawApprovalEvidence,
  });
  const timeoutPartialBaselineLoss = isTimeoutPartialBaselineLoss({
    scenarioId: task.scenarioId,
    artifact,
    rawToolCalls,
    rawToolResults,
  });
  const successfulTimeoutCloseout = isSuccessfulTimeoutCloseout({
    scenarioId: task.scenarioId,
    artifact,
    rawToolCalls,
    rawToolResults,
  });
  const toolOrWorkerTriggered = countArrayLike(rawToolCalls) > 0 || readNumber(artifact.first?.summary?.toolCallCount) > 0;
  const toolOrWorkerResult =
    approvalWaitTimeoutBaselineLoss ||
    timeoutPartialBaselineLoss ||
    countArrayLike(rawToolResults) > 0 ||
    readNumber(artifact.first?.summary?.toolResultCount) > 0;
  const browserRenderedEvidence = requiresBrowser
    ? containsRenderedBrowserEvidence(rawBrowserEvidence)
    : "not_required";
  const runtimeHealthy =
    approvalWaitTimeoutBaselineLoss ||
    timeoutPartialBaselineLoss ||
    successfulTimeoutCloseout ||
    (readString(artifact.provenance?.exitStatus ?? artifact.exitStatus) === "success" &&
      !containsRuntimeHealthFailure([
        artifact.notes,
        artifact.provenance?.rawResponse,
        artifact.provenance?.rawTranscript,
        effectiveMessages,
        rawToolCalls,
        rawToolResults,
        rawBrowserEvidence,
        rawFlowEvidence,
      ]));
  const finalAnswerCaptured = approvalWaitTimeoutBaselineLoss || timeoutPartialBaselineLoss || Boolean(finalText);
  const finalAnswerUseful =
    approvalWaitTimeoutBaselineLoss ||
    timeoutPartialBaselineLoss ||
    Boolean(finalText && finalText.length >= 80 && !isWeakReferenceFinalText(finalText) && artifact.score?.weak !== true);
  const checks = {
    artifactPresent: true,
    modelConfigured,
    promptReceived,
    finalAnswerCaptured,
    finalAnswerUseful,
    toolOrWorkerTriggered,
    toolOrWorkerResult,
    browserRenderedEvidence,
    runtimeHealthy,
  };
  const findings = buildFindings(checks);
  const rootCauseEvidence = dedupeRootCauseEvidence([
    ...extractRootCauseEvidence("notes", artifact.notes),
    ...extractRootCauseEvidence("rawResponse", artifact.provenance?.rawResponse ?? artifact.rawResponse),
    ...extractRootCauseEvidence("rawTranscript", artifact.provenance?.rawTranscript ?? artifact.rawTranscript),
    ...extractRootCauseEvidence("lateSessionTranscript", effectiveMessages),
    ...extractRootCauseEvidence("rawToolCalls", rawToolCalls),
    ...extractRootCauseEvidence("rawToolResults", rawToolResults),
    ...extractRootCauseEvidence("rawBrowserEvidence", rawBrowserEvidence),
    ...extractRootCauseEvidence("rawApprovalEvidence", rawApprovalEvidence),
    ...extractRootCauseEvidence("rawFlowEvidence", rawFlowEvidence),
    ...extractDelegationNotExecutedEvidence({
      finalText,
      rawTranscript: effectiveMessages ?? artifact.provenance?.rawTranscript ?? artifact.rawTranscript,
      toolOrWorkerTriggered: checks.toolOrWorkerTriggered,
      toolOrWorkerResult: checks.toolOrWorkerResult,
    }),
    ...(!checks.modelConfigured
      ? [{ bucket: "model_config_unproven", source: "modelCatalog", detail: "reference model configuration was not proven" }]
      : []),
    ...(!checks.promptReceived
      ? [{ bucket: "prompt_mismatch", source: "exactRequestPayload", detail: "reference prompt receipt did not match scenario prompt" }]
      : []),
    ...(!checks.finalAnswerUseful
      ? [
          { bucket: "weak_final_answer", source: "finalText", detail: finalText ? finalText.slice(0, 240) : "missing final text" },
          ...extractRootCauseEvidence("finalText", finalText),
        ]
      : []),
    ...(!checks.toolOrWorkerTriggered
      ? [{ bucket: "missing_tool_call", source: "rawToolCalls", detail: "reference native tool/worker execution was not observed" }]
      : []),
    ...(!checks.toolOrWorkerResult
      ? [{ bucket: "missing_tool_result", source: "rawToolResults", detail: "reference native tool/worker result was not observed" }]
      : []),
    ...(checks.browserRenderedEvidence === false
      ? [{ bucket: "browser_render_missing", source: "rawBrowserEvidence", detail: "reference browser-rendered evidence was not observed" }]
      : []),
  ]);
  return {
    scenarioId: task.scenarioId,
    artifactPath,
    status: findings.length === 0 ? "healthy" : "unhealthy",
    checks,
    rootCauseBuckets: [...new Set(rootCauseEvidence.map((evidence) => evidence.bucket))],
    rootCauseEvidence,
    findings,
  };
}

function isApprovalWaitTimeoutBaselineLoss(input: {
  scenarioId: string;
  artifact: ReferenceArtifactShape;
  rawToolCalls: unknown;
  rawToolResults: unknown;
  rawApprovalEvidence: unknown;
}): boolean {
  if (input.scenarioId !== "natural-approval-wait-timeout-closeout") return false;
  const driver =
    typeof input.artifact.provenance?.referenceScenarioDriver === "object" &&
    input.artifact.provenance.referenceScenarioDriver !== null
      ? input.artifact.provenance.referenceScenarioDriver as Record<string, unknown>
      : {};
  if (readString(driver.approvalDecisionPolicy) !== "wait_timeout") return false;
  if (readString(input.artifact.provenance?.exitStatus ?? input.artifact.exitStatus) !== "timeout") return false;
  if (input.artifact.timedOut !== true) return false;
  if (!hasObservedPendingApprovalEvidence(input.rawApprovalEvidence)) return false;
  if (hasApprovalDecisionPayload(input.rawApprovalEvidence)) return false;
  if (countArrayLike(input.rawToolCalls) === 0 && readNumber(input.artifact.first?.summary?.toolCallCount) === 0) {
    return false;
  }
  if (countArrayLike(input.rawToolResults) > 0 || readNumber(input.artifact.first?.summary?.toolResultCount) > 0) {
    return false;
  }
  if (
    containsTerm(
      [
        input.artifact.provenance?.rawTranscript,
        input.artifact.rawTranscript,
        input.rawToolResults,
        input.artifact.first,
        input.rawApprovalEvidence,
      ],
      /\bpermission\.applied\b|\bpermission_applied\b|\bform submitted successfully\b|\bsubmitted to the page\b|\bsubmission completed\b/i
    )
  ) {
    return false;
  }
  return true;
}

function isTimeoutPartialBaselineLoss(input: {
  scenarioId: string;
  artifact: ReferenceArtifactShape;
  rawToolCalls: unknown;
  rawToolResults: unknown;
}): boolean {
  const driver =
    typeof input.artifact.provenance?.referenceScenarioDriver === "object" &&
    input.artifact.provenance.referenceScenarioDriver !== null
      ? input.artifact.provenance.referenceScenarioDriver as Record<string, unknown>
      : {};
  const driverKind = readString(driver.kind);
  const timeoutScenarioMatches =
    (input.scenarioId === "natural-timeout-partial-closeout" && driverKind === "timeout_partial") ||
    (input.scenarioId === "natural-timeout-followup-continuation" && driverKind === "timeout_followup");
  if (!timeoutScenarioMatches) return false;
  if (countArrayLike(input.rawToolCalls) === 0 && readNumber(input.artifact.first?.summary?.toolCallCount) === 0) {
    return false;
  }
  const finalText = readFinalText(input.artifact);
  if (finalText && input.artifact.score?.useful === true && !isWeakReferenceFinalText(finalText)) return false;
  const toolResultCount = countArrayLike(input.rawToolResults) + readNumber(input.artifact.first?.summary?.toolResultCount);
  const timedOutWithoutUsefulCloseout =
    readString(input.artifact.provenance?.exitStatus ?? input.artifact.exitStatus) === "timeout" &&
    input.artifact.timedOut === true;
  const failedWorkerCloseout =
    toolResultCount > 0 &&
    containsTerm(
      [
        input.artifact.provenance?.rawTranscript,
        input.artifact.rawTranscript,
        input.artifact.provenance?.rawToolResults,
        input.rawToolResults,
        input.artifact.first,
      ],
      /\b(?:sub-agent returned no executable result|no executable results?|requested task did not match the worker|worker's implemented capability|without live network access|localhost is inaccessible)\b/i
    );
  if (!timedOutWithoutUsefulCloseout && !failedWorkerCloseout) return false;
  if (
    containsTerm(
      [
        input.artifact.provenance?.rawToolResults,
        input.rawToolResults,
        input.artifact.first,
      ],
      /\b(?:verified|confirmed)\b[\s\S]{0,120}\b(?:response body|release-risk evidence|HTTP status|headers?)\b|\bslow source\b[\s\S]{0,120}\b(?:returned|responded)\b/i
    )
  ) {
    return false;
  }
  return true;
}

function isSuccessfulTimeoutCloseout(input: {
  scenarioId: string;
  artifact: ReferenceArtifactShape;
  rawToolCalls: unknown;
  rawToolResults: unknown;
}): boolean {
  const driver =
    typeof input.artifact.provenance?.referenceScenarioDriver === "object" &&
    input.artifact.provenance.referenceScenarioDriver !== null
      ? input.artifact.provenance.referenceScenarioDriver as Record<string, unknown>
      : {};
  const driverKind = readString(driver.kind);
  const timeoutScenarioMatches =
    (input.scenarioId === "natural-timeout-partial-closeout" && driverKind === "timeout_partial") ||
    (input.scenarioId === "natural-timeout-followup-continuation" && driverKind === "timeout_followup");
  if (!timeoutScenarioMatches) return false;
  if (readString(input.artifact.provenance?.exitStatus ?? input.artifact.exitStatus) !== "success") return false;
  if (countArrayLike(input.rawToolCalls) === 0 && readNumber(input.artifact.first?.summary?.toolCallCount) === 0) {
    return false;
  }
  if (countArrayLike(input.rawToolResults) === 0 && readNumber(input.artifact.first?.summary?.toolResultCount) === 0) {
    return false;
  }
  const finalText = readFinalText(input.artifact);
  if (!finalText || input.artifact.score?.useful !== true || isWeakReferenceFinalText(finalText)) return false;
  if (
    !containsTerm(
      finalText,
      /\b(?:timeout|timed out|unresponsive|no response body|no content|no usable content|source is unresolved|cannot be used for release|blocked until)\b/i
    )
  ) {
    return false;
  }
  if (!containsTerm(finalText, /\b(?:how (?:the )?mission can continue|how to continue|retry|alternative sources?|resolve|blocked until)\b/i)) {
    return false;
  }
  if (
    containsTerm(
      finalText,
      /\b(?:verified|confirmed)\b[\s\S]{0,120}\b(?:response body|HTTP status|headers?|source content)\b|\bslow source\b[\s\S]{0,120}\b(?:returned|responded)\b/i
    )
  ) {
    return false;
  }
  return true;
}

function hasObservedPendingApprovalEvidence(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasObservedPendingApprovalEvidence(item));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (readString(record.status) === "observed_pending" && hasKnownString(record.approvalId)) return true;
  return Object.values(record).some((item) => hasObservedPendingApprovalEvidence(item));
}

function hasApprovalDecisionPayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasApprovalDecisionPayload(item));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.decisionPayload != null) return true;
  const decision = record.decision;
  if (typeof decision === "object" && decision !== null) {
    const decisionRecord = decision as Record<string, unknown>;
    if (hasKnownString(decisionRecord.decision)) return true;
    if (
      typeof decisionRecord.decision === "object" &&
      decisionRecord.decision !== null &&
      hasKnownString((decisionRecord.decision as Record<string, unknown>).decision)
    ) {
      return true;
    }
  }
  return false;
}

function containsTerm(value: unknown, pattern: RegExp): boolean {
  if (typeof value === "string") return pattern.test(value);
  if (Array.isArray(value)) return value.some((item) => containsTerm(item, pattern));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((item) => containsTerm(item, pattern));
}

function buildFindings(checks: ReferenceHealthScenario["checks"]): string[] {
  const findings: string[] = [];
  if (!checks.modelConfigured) findings.push("reference model configuration was not proven");
  if (!checks.promptReceived) findings.push("reference artifact does not prove receipt of the same natural prompt");
  if (!checks.finalAnswerCaptured) findings.push("reference final answer was not captured");
  if (!checks.finalAnswerUseful) findings.push("reference final answer is weak, harness-like, or too short");
  if (!checks.toolOrWorkerTriggered) findings.push("reference native tool/worker execution was not observed");
  if (!checks.toolOrWorkerResult) findings.push("reference native tool/worker result was not observed");
  if (checks.browserRenderedEvidence === false) findings.push("reference browser-rendered evidence was not observed");
  if (!checks.runtimeHealthy) findings.push("reference runtime health failed");
  return findings;
}

function readReferenceTasks(manifest: ReferenceTaskManifest): ReferenceTask[] {
  if (!Array.isArray(manifest.tasks)) {
    throw new Error("reference health tasks manifest does not contain tasks[]");
  }
  return manifest.tasks.map((task, index): ReferenceTask => {
    if (typeof task !== "object" || task === null) {
      throw new Error(`reference health task ${index} is not an object`);
    }
    const record = task as { scenarioId?: unknown; prompt?: unknown; expectedReferenceArtifactPath?: unknown };
    const scenarioId = readString(record.scenarioId);
    const expectedReferenceArtifactPath = readString(record.expectedReferenceArtifactPath);
    if (!scenarioId) throw new Error(`reference health task ${index} missing scenarioId`);
    if (!expectedReferenceArtifactPath) {
      throw new Error(`reference health task ${scenarioId} missing expectedReferenceArtifactPath`);
    }
    return {
      scenarioId,
      ...(readString(record.prompt) ? { prompt: readString(record.prompt)! } : {}),
      expectedReferenceArtifactPath,
    };
  });
}

function referenceScenarioRequiresBrowser(scenarioId: string): boolean {
  return /browser|approval-dry-run|dynamic-page|complex-page|dashboard/i.test(scenarioId);
}

function hasConfiguredModel(value: unknown): boolean {
  if (typeof value === "string") return hasKnownString(value);
  if (Array.isArray(value)) return value.some((item) => hasConfiguredModel(item));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.models)) {
    return record.models.some((model) => {
      if (typeof model !== "object" || model === null) return false;
      const modelRecord = model as Record<string, unknown>;
      return (
        modelRecord.configured === true &&
        (hasKnownString(modelRecord.model) || hasKnownString(modelRecord.modelId) || hasKnownString(modelRecord.id)) &&
        (hasKnownString(modelRecord.providerId) || hasKnownString(modelRecord.provider))
      );
    });
  }
  return Object.values(record).some((item) => hasConfiguredModel(item));
}

function hasKnownString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && !/^(unknown|n\/a|null|undefined)$/i.test(value.trim());
}

function readFinalText(artifact: ReferenceArtifactShape): string | null {
  return (
    readString(artifact.first?.summary?.finalText) ??
    readString((artifact.provenance?.rawResponse as { finalText?: unknown } | undefined)?.finalText) ??
    readString((artifact.rawResponse as { finalText?: unknown } | undefined)?.finalText)
  );
}

function readReferencePrompt(artifact: ReferenceArtifactShape): string | null {
  return (
    readString(artifact.prompt) ??
    readString(artifact.userPrompt) ??
    readString(artifact.input?.prompt) ??
    readString(artifact.request?.prompt)
  );
}

function readExactRequestPrompt(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as { prompt?: unknown; content?: unknown; title?: unknown; userPrompt?: unknown; input?: { prompt?: unknown }; request?: { prompt?: unknown }; messages?: unknown };
  const direct =
    readString(record.prompt) ??
    readString(record.content) ??
    readString(record.title) ??
    readString(record.userPrompt) ??
    readString(record.input?.prompt) ??
    readString(record.request?.prompt);
  if (direct) return direct;
  if (!Array.isArray(record.messages)) return null;
  const userMessages = record.messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const candidate = message as { role?: unknown; content?: unknown };
    if (readString(candidate.role) !== "user") return [];
    const content = readString(candidate.content);
    return content ? [content] : [];
  });
  return userMessages.length > 0 ? userMessages.join("\n") : null;
}

function containsRuntimeHealthFailure(value: unknown): boolean {
  if (typeof value === "string") {
    return /blocked explore URL host|blocked host|page\.evaluate|ReferenceError|missing auth|wrong endpoint|Unexpected token '<'|browser worker failed|Explore worker failed|failed to fetch|network_error|can't reach (?:those )?URLs?|localhost addresses? .*only accessible|external infrastructure/i.test(value);
  }
  if (Array.isArray(value)) return value.some((item) => containsRuntimeHealthFailure(item));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const status = readString(record.status);
  if (status === "failed" || status === "error") return true;
  for (const key of ["content", "error", "failure", "fallbackReason", "history", "lastResult", "metadata", "messages", "workerPayload", "workerState"]) {
    if (containsRuntimeHealthFailure(record[key])) return true;
  }
  return false;
}

function extractRootCauseEvidence(source: string, value: unknown): ReferenceRootCauseEvidence[] {
  if (typeof value === "string") {
    return classifyRootCauseText(source, value);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractRootCauseEvidence(source, item));
  }
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const evidence: ReferenceRootCauseEvidence[] = [];
  const status = readString(record.status);
  if (status === "failed" || status === "error") {
    evidence.push({ bucket: "runtime_failure", source, detail: `status=${status}` });
  }
  for (const key of ["content", "error", "failure", "fallbackReason", "history", "lastResult", "metadata", "messages", "summary", "workerPayload", "workerState"]) {
    evidence.push(...extractRootCauseEvidence(`${source}.${key}`, record[key]));
  }
  return evidence;
}

function classifyRootCauseText(source: string, text: string): ReferenceRootCauseEvidence[] {
  const evidence: ReferenceRootCauseEvidence[] = [];
  if (/Unexpected token '<'|<!DOCTYPE/i.test(text)) {
    evidence.push({ bucket: "model_adapter_fallback", source, detail: truncateDetail(text) });
    evidence.push({
      bucket: "reference_endpoint_or_auth",
      source,
      detail: `model adapter received an HTML/non-JSON response: ${truncateDetail(text)}`,
    });
  }
  if (/page\.evaluate|ReferenceError|__name is not defined/i.test(text)) {
    evidence.push({ bucket: "browser_evaluate_error", source, detail: truncateDetail(text) });
  }
  if (/page\.goto: Timeout|Timeout \d+ms exceeded|waiting until "domcontentloaded"/i.test(text)) {
    evidence.push({ bucket: "browser_navigation_timeout", source, detail: truncateDetail(text) });
  }
  if (/Browser worker failed/i.test(text)) {
    evidence.push({ bucket: "browser_worker_failed", source, detail: truncateDetail(text) });
  }
  if (/no executable results?|could not process the task|without live network access|localhost is inaccessible|localhost addresses? .*only accessible|external infrastructure|can't reach (?:those )?URLs?|operating as|use the browser worker|close the flow with|please consolidate this update/i.test(text)) {
    evidence.push({ bucket: "prompt_harness_echo", source, detail: truncateDetail(text) });
  }
  if (/\b(waiting_worker|nextExpectedRoleId|activeRoleIds)\b/i.test(text)) {
    evidence.push({ bucket: "reference_flow_incomplete", source, detail: truncateDetail(text) });
  }
  if (/Explore worker failed|failed to fetch|network_error|Fetched 0\/\d+ URLs successfully/i.test(text)) {
    evidence.push({ bucket: "explore_worker_failed", source, detail: truncateDetail(text) });
  }
  if (/blocked explore URL host|blocked host|localhost addresses? .*only accessible|external infrastructure|can't reach (?:those )?URLs?/i.test(text)) {
    evidence.push({ bucket: "blocked_host", source, detail: truncateDetail(text) });
  }
  if (/missing auth|wrong endpoint/i.test(text)) {
    evidence.push({ bucket: "reference_endpoint_or_auth", source, detail: truncateDetail(text) });
  }
  return evidence;
}

function extractDelegationNotExecutedEvidence(input: {
  finalText: string | null;
  rawTranscript: unknown;
  toolOrWorkerTriggered: boolean;
  toolOrWorkerResult: boolean;
}): ReferenceRootCauseEvidence[] {
  if (input.toolOrWorkerTriggered && input.toolOrWorkerResult) return [];
  const text = [input.finalText ?? "", stringifyForEvidence(input.rawTranscript)].join("\n");
  if (!/\b(next role|delegate to|delegating to|i will delegate|let me delegate|handoff to|assign(?:ing)? this to)\b/i.test(text)) {
    return [];
  }
  const evidence: ReferenceRootCauseEvidence[] = [
    {
      bucket: "delegation_not_executed",
      source: "rawTranscript",
      detail: "reference assistant described delegation, but no native tool/worker execution and result were observed",
    },
  ];
  const textualRoleHandoff = text.match(/\b(?:next role|delegate to|handoff to|assign(?:ing)? this to)\s*:?\s*`?\*{0,2}(role-[a-z0-9_-]+)\b/i);
  if (textualRoleHandoff && !new RegExp(`@\\{${escapeRegExp(textualRoleHandoff[1] ?? "")}\\}`, "i").test(text)) {
    evidence.push({
      bucket: "delegation_text_not_dispatchable",
      source: "rawTranscript",
      detail: `reference assistant named ${textualRoleHandoff[1]} in prose instead of a dispatchable role mention`,
    });
  }
  return evidence;
}

function dedupeRootCauseEvidence(evidence: ReferenceRootCauseEvidence[]): ReferenceRootCauseEvidence[] {
  const seen = new Set<string>();
  const deduped: ReferenceRootCauseEvidence[] = [];
  for (const item of evidence) {
    const key = `${item.bucket}\0${item.source}\0${item.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function truncateDetail(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function containsRenderedBrowserEvidence(value: unknown): boolean {
  if (typeof value === "string") {
    return /(rendered|screenshot|snapshot|page title|visible page|browser page)/i.test(value) && value.trim().length > 20;
  }
  if (Array.isArray(value)) return value.some((item) => containsRenderedBrowserEvidence(item));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.rendered === true) return true;
  for (const key of ["pageSnapshot", "snapshot", "screenshot", "title", "text", "html", "history"]) {
    if (containsRenderedBrowserEvidence(record[key])) return true;
  }
  return false;
}

function isWeakReferenceFinalText(text: string): boolean {
  return /暂时无法|无法返回|待确认|估算|没有足够|cannot access|unable to access|not enough information|no executable results?|could not process the task|without live network access|localhost is inaccessible|localhost addresses? .*only accessible|external infrastructure|can't reach (?:those )?URLs?|operating as|use the browser worker|close the flow with|please consolidate this update|next role|delegate to|delegating to|i will delegate|let me delegate/i.test(text);
}

function countArrayLike(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readEffectiveReferenceArtifactMessages(artifact: ReferenceArtifactShape, artifactPath: string): unknown[] | null {
  const artifactMessages = readReferenceArtifactMessages(artifact) ?? [];
  const lateMessages = readReferenceSessionMessagesFromFlowEvidence(
    artifact.provenance?.rawFlowEvidence ?? artifact.rawFlowEvidence,
    artifactPath
  );
  const messages = lateMessages.length > artifactMessages.length ? lateMessages : artifactMessages;
  return messages.length > 0 ? messages : null;
}

function readReferenceArtifactMessages(artifact: ReferenceArtifactShape): unknown[] | null {
  const rawTranscript = artifact.provenance?.rawTranscript ?? artifact.rawTranscript;
  if (Array.isArray(rawTranscript)) return rawTranscript;
  if (typeof rawTranscript === "object" && rawTranscript !== null) {
    const messages = (rawTranscript as { messages?: unknown }).messages;
    if (Array.isArray(messages)) return messages;
  }
  return null;
}

function readReferenceSessionMessagesFromFlowEvidence(rawFlowEvidence: unknown, artifactPath: string): unknown[] {
  for (const sessionPath of readSessionPaths(rawFlowEvidence)) {
    const resolvedPath = path.isAbsolute(sessionPath) ? sessionPath : path.resolve(path.dirname(artifactPath), sessionPath);
    const messages = readJsonlMessages(resolvedPath);
    if (messages.length > 0) return messages;
  }
  return [];
}

function readSessionPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => readSessionPaths(item));
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const sessionPath = readString(record.sessionPath);
  return [
    ...(sessionPath ? [sessionPath] : []),
    ...Object.entries(record)
      .filter(([key]) => key !== "sessionPath")
      .flatMap(([, item]) => readSessionPaths(item)),
  ];
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

function readLatestAssistantText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const record = message as { role?: unknown; content?: unknown };
    if (readString(record.role) !== "assistant") continue;
    const text = readStringFromMessageContent(record.content);
    if (text) return text;
  }
  return null;
}

function readStringFromMessageContent(content: unknown): string | null {
  if (typeof content === "string") return readString(content);
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const record = part as { type?: unknown; text?: unknown };
    const type = readString(record.type);
    if (type && type !== "text") return [];
    const text = readString(record.text);
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

function extractToolCalls(messages: unknown[]): unknown[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const record = message as { toolCalls?: unknown; tool_calls?: unknown; metadata?: { toolCalls?: unknown } };
    return [...readArray(record.toolCalls), ...readArray(record.tool_calls), ...readArray(record.metadata?.toolCalls)];
  });
}

function extractToolResults(messages: unknown[]): unknown[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const record = message as { role?: unknown; toolResults?: unknown; metadata?: { toolResults?: unknown } };
    return [
      ...(readString(record.role) === "tool" ? [message] : []),
      ...readArray(record.toolResults),
      ...readArray(record.metadata?.toolResults),
    ];
  });
}

function extractBrowserEvidenceFromTranscript(messages: unknown[]): unknown[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const record = message as { role?: unknown; name?: unknown; content?: unknown; metadata?: { toolName?: unknown } };
    const toolName = readString(record.name) ?? readString(record.metadata?.toolName);
    if (readString(record.role) !== "tool" || toolName !== "sessions_spawn") return [];
    const content = readString(record.content);
    if (!content || !/^tool_chain:\s*.*\bbrowser\b/im.test(content) && !/^task_id:\s*.*:sub:browser:/im.test(content)) return [];
    const status = readAccioTextHeader(content, "status") ?? "completed";
    return [
      {
        source: "session_tool_result",
        rendered: /^completed$/i.test(status) && /(screenshot|snapshot|rendered|page title|visible page)/i.test(content),
        status,
        evidenceText: content.slice(0, 4000),
      },
    ];
  });
}

function readAccioTextHeader(content: string, key: string): string | null {
  const escaped = escapeRegExp(key);
  const match = content.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
  return readString(match?.[1]);
}

function normalizePromptForAudit(prompt: unknown): string {
  if (typeof prompt !== "string") return "";
  return prompt
    .replace(/\b(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])):\d+/gi, "$1:<loopback-port>")
    .replace(/\s+/g, " ")
    .trim();
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function readValue(args: string[], index: number, arg: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${arg}`);
  }
  return value;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function stringifyForEvidence(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRealLlmAbReferenceHealthCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
