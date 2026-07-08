import type {
  GenerateTextResult,
  LLMMessage,
  LLMToolCall,
} from "@turnkeyai/llm-adapter/index";
import type { ToolProgressEvent, ToolResult } from "@turnkeyai/agent-core/tool";
import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import { MAX_BROWSER_OPEN_TIMEOUT_MS } from "@turnkeyai/core-types/team";
import type {
  NativeToolProgressTrace,
  NativeToolResultTrace,
  NativeToolRoundTrace,
} from "../native-tool-messages";
import type { RolePromptPacket } from "../prompt-policy";
import {
  normalizeToolInputForSignature,
  stableJson,
  toolCallSignature,
} from "../react/predicates";
import { parseSessionToolResult } from "../session-tool-result-protocol";
import {
  buildOriginalRequestTableColumnContext,
  requestedColumnsLookLikeProviderSearchPricing,
  resolveRequestedTableColumns,
} from "../task-facts-shared";
import {
  produceTaskIntentEnvelope,
  taskFactLooksLikeReadOnlyBrowserPageReview,
} from "./task-intent-producer";
import {
  ROLE_TOOL_RESULT_TRACE_CAP_BYTES,
  SESSION_SEND_ALIAS_NAMES,
  SESSION_TOOL_RESULT_PROTOCOL,
  buildContinuationDirectiveContext,
  buildToolCallLimitExceededResult,
  compactSessionPayloadArtifactRefs,
  compactSessionPayloadEvidenceExcerpt,
  compactToolResultTraceContent,
  containsAnyToolCallForm,
  createToolExecutionSignal,
  dedupeStrings,
  escapeRegExp,
  extractHttpUrls,
  readTruncatedSessionKeyPrefix,
  relaxedSessionKeySignature,
  resolveKnownWorkerSessionKey,
  extractKnownWorkerSessionKeys,
  extractWorkerSessionKey,
  fitCompactToolResultTraceContent,
  formatDurationMs,
  isAbortError,
  isControlPlaneToolResultName,
  isLoopbackHostname,
  isPrivateOrLoopbackHostname,
  llmMessageContentToText,
  matchesAny,
  normalizeSessionToolAliasCalls,
  normalizeSessionToolCalls,
  normalizeUrlForComparison,
  parseJsonObject,
  readMessageContentText,
  readPayloadEvidenceExcerpt,
  readPayloadEvidencePages,
  readPolicyWorkerKindFromSessionKey,
  readSessionKeyFromToolInput,
  readStringArray,
  readStringField,
  readStringInput,
  resolveEffectiveToolLoopWallClockMs,
  sliceUtf8,
  throwIfAborted,
  toNativeToolProgressTrace,
  toNativeToolResultTrace,
  trimHttpUrlCandidate,
  withFinalToolRoundWarning,
} from "../tool-protocol";
import {
  hasApprovedBrowserTimeoutContinuationPrompt,
  hasCoverageTimeoutContinuationPrompt,
  hasIncompleteApprovedBrowserSessionContinuationPrompt,
  hasLatestSupplementalLocalTimeoutProbePrompt,
  hasMissingApprovalGateRepairPrompt,
  hasMissingRequiredFinalDeliverablesRepairPrompt,
  hasSupplementalLocalTimeoutProbePrompt,
  hasTimeoutContinuationGuidance,
} from "./repair-marker-facts";

function taskIntentFactsForPrompt(taskPrompt: string) {
  return produceTaskIntentEnvelope({
    taskPrompt,
    messages: [],
  }).facts;
}

function allowsExactFinalAnswerShapeBypass(
  taskPrompt: string,
  resultText: string,
): boolean {
  if (/^\s*(?:\{[\s\S]*\}|\[[\s\S]*\])\s*$/.test(resultText)) {
    try {
      JSON.parse(resultText);
      return true;
    } catch {
      // Fall through to prompt-shape checks.
    }
  }
  return taskIntentFactsForPrompt(taskPrompt).exactFinalAnswerShapeExpected;
}

function extractCompletedSessionEvidenceLabels(evidenceText: string): string[] {
  const labels: string[] = [];
  for (const match of evidenceText.matchAll(
    /"label"\s*:\s*"([^"\\]{3,120})"/g,
  )) {
    const label = match[1]?.trim();
    if (label && isMeaningfulEvidenceLabel(label)) {
      labels.push(label);
    }
  }
  for (const match of evidenceText.matchAll(
    /\blabel\s*=\s*"([^"]{3,120})"/g,
  )) {
    const label = match[1]?.trim();
    if (label && isMeaningfulEvidenceLabel(label)) {
      labels.push(label);
    }
  }
  return dedupeStrings(labels).slice(0, 6);
}

function isMeaningfulEvidenceLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  if (!normalized || normalized.length < 3) {
    return false;
  }
  return !/^(?:local-url-fetch|browser|explore|source|fetch|research|session)$/i.test(
    normalized,
  );
}

function normalizedTextContains(text: string, needle: string): boolean {
  const compactText = text.replace(/\s+/g, " ").trim().toLowerCase();
  const compactNeedle = needle.replace(/\s+/g, " ").trim().toLowerCase();
  return compactNeedle.length > 0 && compactText.includes(compactNeedle);
}

function findMissingBrowserEvidenceDimensions(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
}): string[] {
  const dimensions = [
    {
      label: "embedded frame source state",
      requested: /\b(?:iframe|frame|embedded source)\b/i,
      evidence:
        /\b(?:Frame panel|embedded source frame|embedded backlog source)\b[\s\S]{0,180}\b(?:backlog\s*7|Frame Captain)\b|\b(?:backlog\s*7|Frame Captain)\b[\s\S]{0,180}\b(?:Frame panel|embedded source frame|embedded backlog source)\b/i,
      result:
        /\b(?:frame|iframe|embedded source)\b[\s\S]{0,220}\b(?:backlog(?:\s*(?:count|data))?[\s\S]{0,30}\b7\b|Frame Captain)\b|\b(?:backlog(?:\s*(?:count|data))?[\s\S]{0,30}\b7\b|Frame Captain)\b[\s\S]{0,220}\b(?:frame|iframe|embedded source)\b/i,
      negated:
        /\bnot verified\b[\s\S]{0,120}\b(?:frame|iframe|embedded source)\b|\b(?:frame|iframe|embedded source)\b[\s\S]{0,120}\bnot verified\b/i,
    },
    {
      label: "shadow review state",
      requested: /\b(?:shadow|review component)\b/i,
      evidence:
        /\b(?:Shadow review|shadow component|review component)\b[\s\S]{0,180}\b(?:risk desk|approval required|approval requirement)\b|\b(?:risk desk|approval required|approval requirement)\b[\s\S]{0,180}\b(?:Shadow review|shadow component|review component)\b/i,
      result:
        /\b(?:shadow|review component)\b[\s\S]{0,220}\b(?:risk desk|approval required|approval requirement|approval is required)\b|\b(?:risk desk|approval required|approval requirement|approval is required)\b[\s\S]{0,220}\b(?:shadow|review component)\b/i,
      negated:
        /\bnot verified\b[\s\S]{0,120}\b(?:shadow|review component)\b|\b(?:shadow|review component)\b[\s\S]{0,120}\bnot verified\b/i,
    },
    {
      label: "details popup state",
      requested: /\bpopup\b/i,
      evidence:
        /\bpopup\b[\s\S]{0,180}\b(?:P-42|manager acknowledgement|opened)\b|\b(?:P-42|manager acknowledgement)\b[\s\S]{0,180}\bpopup\b/i,
      result:
        /\bpopup\b[\s\S]{0,180}\b(?:P-42|manager acknowledgement|opened)\b|\b(?:P-42|manager acknowledgement)\b[\s\S]{0,180}\bpopup\b/i,
    },
    {
      label: "product signal dashboard counters",
      requested:
        /\b(?:product-signals|live signal dashboard|product signal dashboard)\b/i,
      evidence: PRODUCT_SIGNAL_DASHBOARD_COUNTERS_PATTERN,
      result: PRODUCT_SIGNAL_DASHBOARD_RENDERED_RESULT_PATTERN,
      negated: PRODUCT_SIGNAL_DASHBOARD_COUNTERS_UNVERIFIED_PATTERN,
    },
  ] as const;

  return dimensions.flatMap((dimension) =>
    dimension.requested.test(input.taskPrompt) &&
    dimension.evidence.test(input.evidenceText) &&
    (!dimension.result.test(input.resultText) ||
      ("negated" in dimension && dimension.negated.test(input.resultText)))
      ? [dimension.label]
      : [],
  );
}

const PRODUCT_SIGNAL_NUMERIC_METRIC_PATTERN =
  "\\b[A-Za-z][A-Za-z0-9 _/-]{1,48}\\b\\s*(?:[:=\\-]|\\bis\\b)\\s*(?:\\*\\*)?\\d+(?:\\.\\d+)?(?:\\*\\*)?\\b";

const PRODUCT_SIGNAL_RATE_METRIC_PATTERN =
  "\\b[A-Za-z][A-Za-z0-9 _/-]{1,48}\\b\\s*(?:[:=\\-]|\\bis\\b)\\s*(?:\\*\\*)?\\d+(?:\\.\\d+)?%(?!\\d)(?:\\*\\*)?";

const PRODUCT_SIGNAL_DASHBOARD_COUNTERS_PATTERN = new RegExp(
  `\\b(?:dashboard|signals?|metrics?|counters?|rates?)\\b[\\s\\S]{0,360}(?:${PRODUCT_SIGNAL_NUMERIC_METRIC_PATTERN}[\\s\\S]{0,240}${PRODUCT_SIGNAL_RATE_METRIC_PATTERN}|${PRODUCT_SIGNAL_RATE_METRIC_PATTERN}[\\s\\S]{0,240}${PRODUCT_SIGNAL_NUMERIC_METRIC_PATTERN})|(?:${PRODUCT_SIGNAL_NUMERIC_METRIC_PATTERN}[\\s\\S]{0,240}${PRODUCT_SIGNAL_RATE_METRIC_PATTERN}|${PRODUCT_SIGNAL_RATE_METRIC_PATTERN}[\\s\\S]{0,240}${PRODUCT_SIGNAL_NUMERIC_METRIC_PATTERN})[\\s\\S]{0,360}\\b(?:dashboard|signals?|metrics?|counters?|rates?)\\b`,
  "i",
);

const PRODUCT_SIGNAL_DASHBOARD_RENDERED_RESULT_PATTERN = new RegExp(
  `(?:\\b(?:rendered|browser|browser-visible|visible|screenshot|snapshot|DOM)\\b[\\s\\S]{0,360}${PRODUCT_SIGNAL_DASHBOARD_COUNTERS_PATTERN.source})|(?:${PRODUCT_SIGNAL_DASHBOARD_COUNTERS_PATTERN.source}[\\s\\S]{0,360}\\b(?:rendered|browser|browser-visible|visible|screenshot|snapshot|DOM)\\b)`,
  "i",
);

const PRODUCT_SIGNAL_DASHBOARD_COUNTERS_UNVERIFIED_PATTERN =
  /\b(?:live counters?|dashboard counters?|signals? dashboard counters?|counter values?|metric values?|product signals? dashboard|product signal dashboard|live signal dashboard|signals? dashboard)\b[\s\S]{0,260}\b(?:not verified|unverified|not confirmed|unconfirmed|not extracted|not captured|not observed|not in (?:the )?(?:completed )?evidence)|\b(?:not verified|unverified|not confirmed|unconfirmed|not extracted|not captured|not observed|not in (?:the )?(?:completed )?evidence)\b[\s\S]{0,260}\b(?:live counters?|dashboard counters?|signals? dashboard counters?|counter values?|metric values?|product signals? dashboard|product signal dashboard|live signal dashboard|signals? dashboard)\b/i;

function hasToolDefinition(
  tools: readonly { name: string }[] | undefined,
  name: string,
): boolean {
  return (tools ?? []).some((tool) => tool.name === name);
}

export interface SessionContinuationDirective {
  sessionKey: string;
  messageHint: string;
  label?: string;
}

export interface SessionContinuationLookupDirective {
  messageHint: string;
  agentId?: string;
}

export interface SubAgentToolTimeoutSignal {
  toolName: string;
  sessionKey: string;
  agentId: string;
  timeoutSeconds?: number | null;
  evidenceAvailable: boolean;
}

export interface IncompleteApprovedBrowserSessionContinuation {
  sessionKey: string;
  evidence: string;
}

export const SUPPLEMENTAL_LOCAL_TIMEOUT_PROBE_TIMEOUT_SECONDS = 45;

export const SUPPLEMENTAL_BROWSER_OPEN_TIMEOUT_MS = 10_000;

export const readReadOnlyPermissionQuerySuppression =
  readPolicyReadOnlyPermissionQuerySuppression;

export const readApprovalWaitTimeoutRuntimeEvidence =
  readPolicyApprovalWaitTimeoutRuntimeEvidence;

export const readFinalRecoveryBudgetCloseoutRepair =
  readPolicyFinalRecoveryBudgetCloseoutRepair;

export const readCompletedSessionEvidenceText =
  readPolicyCompletedSessionEvidenceText;

export const readMissingBrowserEvidenceDimensionsRepair =
  readPolicyMissingBrowserEvidenceDimensionsRepair;

export const readMissingBrowserEvidenceRepair =
  readPolicyMissingBrowserEvidenceRepair;

export const readMissingProductSignalBrowserEvidenceRepair =
  readPolicyMissingProductSignalBrowserEvidenceRepair;

export const readMissingApprovalGateRepair = readPolicyMissingApprovalGateRepair;

export const readPendingApprovalWaitTimeoutCheckRepair =
  readPolicyPendingApprovalWaitTimeoutCheckRepair;

export const readPrematurePendingApprovalFinalRepair =
  readPolicyPrematurePendingApprovalFinalRepair;

export const readStalePendingApprovalRepair = readPolicyStalePendingApprovalRepair;

export const readStaleDeniedApprovalRepair = readPolicyStaleDeniedApprovalRepair;

export const readApprovalWaitTimeoutCloseoutRepair =
  readPolicyApprovalWaitTimeoutCloseoutRepair;

export const readForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair =
  readPolicyForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair;

export const readIncompleteApprovedBrowserActionRepair =
  readPolicyIncompleteApprovedBrowserActionRepair;

export const readSourceBoundedEvidenceText = readPolicySourceBoundedEvidenceText;

export const readSourceEvidenceCarryForwardRepair =
  readPolicySourceEvidenceCarryForwardRepair;

export const readWeakEvidenceSynthesisRepair = readPolicyWeakEvidenceSynthesisRepair;

export const readTimedOutApprovedBrowserSessionContinuation =
  readPolicyTimedOutApprovedBrowserSessionContinuation;

export const readTimedOutSiblingSessionContinuation =
  readPolicyTimedOutSiblingSessionContinuation;

export const readIndependentEvidenceStreamsContinuation =
  readPolicyIndependentEvidenceStreamsContinuation;

export const readIndependentEvidenceStreamCount =
  readPolicyIndependentEvidenceStreamCount;

export const readBrowserRecoverySummariesFromTrace =
  readPolicyBrowserRecoverySummariesFromToolTrace;

export const readTimeoutFollowupFinalGuidanceRepair =
  readPolicyTimeoutFollowupFinalGuidanceRepair;

export const readMissingRequestedNextActionRepair =
  readPolicyMissingRequestedNextActionRepair;

export const readFalseEvidenceBlockedSynthesisRepair =
  readPolicyFalseEvidenceBlockedSynthesisRepair;

export function readPolicySessionTranscriptRequest(taskPrompt: string): boolean {
  return /\b(?:full|complete|entire|raw)\s+(?:session\s+)?(?:transcript|history|log)\b|\b(?:show|print|dump|export)\s+(?:the\s+)?(?:session\s+)?(?:transcript|history|log)\b|完整(?:会话|历史|记录)|原始(?:会话|历史|记录)/iu.test(
    taskPrompt,
  );
}

export function findRepeatedSessionInspectionCall(
  pendingCalls: readonly LLMToolCall[],
  toolTrace: readonly NativeToolRoundTrace[],
  taskPrompt: string,
  sessionContext = "",
): { toolName: string; sessionKey: string } | null {
  if (pendingCalls.length === 0 || toolTrace.length === 0) {
    return null;
  }
  if (readPolicySessionTranscriptRequest(taskPrompt)) {
    return null;
  }
  const inspected = new Set<string>();
  for (const round of toolTrace) {
    for (const call of round.calls) {
      if (call.name !== "sessions_history") continue;
      const sessionKey = readSessionKeyFromToolInput(call.input);
      if (!sessionKey) continue;
      const result = round.results.find(
        (candidate) => candidate.toolCallId === call.id,
      );
      if (!result || result.isError || result.cancelled || result.skipped) {
        continue;
      }
      inspected.add(sessionKey);
    }
  }
  for (const call of pendingCalls) {
    if (call.name !== "sessions_history") continue;
    const sessionKey = readSessionKeyFromToolInput(call.input);
    if (sessionKey && inspected.has(sessionKey)) {
      return { toolName: call.name, sessionKey };
    }
    if (sessionKey && contextAlreadyContainsSessionHistory(sessionContext, sessionKey)) {
      return { toolName: call.name, sessionKey };
    }
  }
  return null;
}

export function findExcessiveSessionContinuationCall(
  pendingCalls: readonly LLMToolCall[],
  toolTrace: readonly NativeToolRoundTrace[],
  maxContinuations = 2,
): { toolName: string; sessionKey: string; continuationCount: number } | null {
  if (pendingCalls.length === 0 || toolTrace.length === 0) {
    return null;
  }
  const continuedCounts = countSuccessfulSessionContinuations(toolTrace);
  for (const call of pendingCalls) {
    if (call.name !== "sessions_send") continue;
    const sessionKey = readSessionKeyFromToolInput(call.input);
    if (!sessionKey) continue;
    const continuationCount = continuedCounts.get(sessionKey) ?? 0;
    if (continuationCount >= maxContinuations) {
      return {
        toolName: call.name,
        sessionKey,
        continuationCount,
      };
    }
  }
  return null;
}

function contextAlreadyContainsSessionHistory(
  context: string,
  sessionKey: string,
): boolean {
  if (!context || !sessionKey || !context.includes(sessionKey)) {
    return false;
  }
  return /\b(?:sessions_history|total_messages|has_more_after|previous_cursor)\b/i.test(
    context,
  );
}

function countSuccessfulSessionContinuations(
  toolTrace: readonly NativeToolRoundTrace[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const round of toolTrace) {
    for (const call of round.calls) {
      if (call.name !== "sessions_send") continue;
      const sessionKey = readSessionKeyFromToolInput(call.input);
      if (!sessionKey) continue;
      const result = round.results.find(
        (candidate) => candidate.toolCallId === call.id,
      );
      if (!result || result.isError || result.cancelled || result.skipped) {
        continue;
      }
      counts.set(sessionKey, (counts.get(sessionKey) ?? 0) + 1);
    }
  }
  return counts;
}

export function limitIndependentEvidenceSpawnCalls(
  toolCalls: LLMToolCall[],
  input: {
    taskPrompt: string;
    toolTrace: NativeToolRoundTrace[];
  },
): LLMToolCall[] {
  const requiredStreams = readPolicyIndependentEvidenceStreamCount(input.taskPrompt);
  if (requiredStreams < 2) {
    return toolCalls;
  }
  const spawnCalls = toolCalls.filter((call) => call.name === "sessions_spawn");
  if (spawnCalls.length <= 1) {
    return toolCalls;
  }
  const completedStreams = countCompletedSessionEvidenceResults(
    input.toolTrace,
  );
  const remainingStreams = Math.max(0, requiredStreams - completedStreams);
  if (spawnCalls.length <= remainingStreams) {
    return toolCalls;
  }
  let keptSpawns = 0;
  return toolCalls.filter((call) => {
    if (call.name !== "sessions_spawn") {
      return true;
    }
    keptSpawns += 1;
    return keptSpawns <= remainingStreams;
  });
}

export function readPolicyIndependentEvidenceStreamCount(taskPrompt: string): number {
  return taskIntentFactsForPrompt(taskPrompt).requiredIndependentEvidenceStreams;
}

export function countCompletedSessionEvidenceResults(
  toolTrace: NativeToolRoundTrace[],
): number {
  const completedSessionKeys = new Set<string>();
  for (const round of toolTrace) {
    for (const result of round.results) {
      if (
        result.toolName !== "sessions_spawn" &&
        result.toolName !== "sessions_send"
      ) {
        continue;
      }
      if (!result.content) {
        continue;
      }
      const parsed = parseSessionToolResult(result.content);
      if (
        !parsed ||
        parsed.status !== "completed" ||
        !readCompletedSessionEvidence(parsed)
      ) {
        continue;
      }
      completedSessionKeys.add(parsed.session_key);
    }
  }
  return completedSessionKeys.size;
}

export function readPolicyIndependentEvidenceStreamsContinuation(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly { name: string }[];
}): boolean {
  if (!hasToolDefinition(input.tools, "sessions_spawn")) {
    return false;
  }
  const requiredStreams = readPolicyIndependentEvidenceStreamCount(input.taskPrompt);
  if (requiredStreams < 2) {
    return false;
  }
  return (
    countCompletedSessionEvidenceResults(input.toolTrace) < requiredStreams
  );
}

export function enforceSupplementalLocalTimeoutProbeToolCall(
  toolCalls: LLMToolCall[],
  messages: LLMMessage[],
): LLMToolCall[] {
  const latest = messages.at(-1);
  const latestText =
    latest?.role === "user" ? readMessageContentText(latest.content) : "";
  if (
    !latestText.includes(
      "Runtime correction: resumed timeout evidence is still content-poor.",
    )
  ) {
    return toolCalls;
  }
  const selected =
    toolCalls.find(
      (call) => call.name === "sessions_spawn" || call.name === "sessions_send",
    ) ?? toolCalls[0];
  const selectedText =
    selected?.name === "sessions_spawn"
      ? readStringInput(selected.input, "task")
      : selected?.name === "sessions_send"
        ? readStringInput(selected.input, "message")
        : null;
  const url =
    extractHttpUrls(latestText).find((candidate) => {
      try {
        return isLoopbackHostname(new URL(candidate).hostname);
      } catch {
        return false;
      }
    }) ?? extractHttpUrls(latestText)[0];
  return [
    {
      id: selected?.id ?? "runtime-supplemental-local-timeout-probe",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        label:
          (selected ? readStringInput(selected.input, "label") : undefined) ??
          "supplemental local timeout probe",
        timeout_seconds: SUPPLEMENTAL_LOCAL_TIMEOUT_PROBE_TIMEOUT_SECONDS,
        task: [
          "Use private browser page tools for browser-visible/local runtime evidence; do not spawn or continue another session.",
          `Supplemental local timeout probe mode: call browser_open with timeout_ms ${SUPPLEMENTAL_BROWSER_OPEN_TIMEOUT_MS} and then stop with observed evidence or explicit unavailable fields.`,
          selectedText,
          url
            ? `Open ${url} as an operator would see it with a bounded local-runtime attempt.`
            : "Open the loopback URL from the parent correction with a bounded local-runtime attempt.",
          "Return only observed evidence: final URL, title, visible marker/text, loading completion, console/network failures if available, screenshot/artifact references if captured, and any remaining unverified items.",
          "If the page still does not produce evidence, report that status/body/header/rendered content remain unavailable and keep the release-risk conclusion source-bounded.",
        ]
          .filter(
            (part): part is string =>
              typeof part === "string" && part.trim().length > 0,
          )
          .join("\n\n"),
      },
    },
  ];
}

export function readCompletedSessionEvidence(
  parsed: NonNullable<ReturnType<typeof parseSessionToolResult>>,
): string | null {
  const evidenceExcerpt =
    typeof parsed.evidence_excerpt === "string" &&
    parsed.evidence_excerpt.trim().length > 0
      ? parsed.evidence_excerpt.trim()
      : null;
  if (typeof parsed.final_content === "string" && parsed.final_content.trim()) {
    const finalContent = parsed.final_content.trim();
    if (parsed.agent_id === "browser") {
      const browserEvidence = [
        parsed.evidence_summary,
        evidenceExcerpt,
        finalContent,
        parsed.result,
      ]
        .filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
        .map((item) => item.trim());
      return dedupeStrings(browserEvidence).join("\n\n");
    }
    const payload = parsed.payload;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const mode = (payload as Record<string, unknown>)["mode"];
        if (mode === "llm_sub_agent") {
          return dedupeStrings([
            parsed.evidence_summary,
            parsed.result,
            evidenceExcerpt,
            finalContent,
            readBrowserFailureBucketSummary(payload as Record<string, unknown>),
          ]
            .filter((item): item is string => Boolean(item))
            .map((item) => item.trim())
            .filter((item) => item.length > 0))
            .join("\n\n");
        }
      }
    const completedEvidence = [
      finalContent,
      parsed.evidence_summary,
      evidenceExcerpt,
      parsed.result,
    ]
      .filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
      .map((item) => item.trim());
    return dedupeStrings(completedEvidence).join("\n\n");
  }
  const evidence = [parsed.result, parsed.evidence_summary, evidenceExcerpt]
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
    .map((item) => item.trim());
  return evidence.length > 0 ? [...new Set(evidence)].join("\n\n") : null;
}

export function readBrowserFailureBucketSummary(payload: Record<string, unknown>): string | null {
  const buckets = normalizeBrowserFailureBucketRecords(payload["failureBuckets"]);
  const recovery = payload["browserRecovery"];
  if (recovery && typeof recovery === "object" && !Array.isArray(recovery)) {
    buckets.push(...normalizeBrowserFailureBucketRecords((recovery as Record<string, unknown>)["failureBuckets"]));
  }
  if (buckets.length === 0) {
    return null;
  }
  const merged = new Map<string, number>();
  for (const bucket of buckets) {
    merged.set(bucket.bucket, (merged.get(bucket.bucket) ?? 0) + bucket.count);
  }
  return `Browser failure buckets: ${[...merged.entries()]
    .map(([bucket, count]) => `${bucket}=${count}`)
    .sort()
    .join(", ")}.`;
}

export function normalizeBrowserFailureBucketRecords(value: unknown): Array<{ bucket: string; count: number }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const bucket = record["bucket"];
    const count = record["count"];
    if (typeof bucket !== "string" || !bucket.trim()) {
      return [];
    }
    return [{ bucket: bucket.trim(), count: typeof count === "number" && Number.isFinite(count) ? count : 1 }];
  });
}

export function readBrowserRecoverySummary(
  payload: Record<string, unknown>,
): string | null {
  const recovery = payload["browserRecovery"];
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) {
    return null;
  }
  const record = recovery as Record<string, unknown>;
  const summary = record["summary"];
  if (typeof summary === "string" && summary.trim()) {
    return summary.trim();
  }
  const resumeMode = record["resumeMode"];
  if (resumeMode === "warm" || resumeMode === "cold") {
    return `Browser recovery metadata: Resume mode: ${resumeMode}.`;
  }
  return null;
}

export function readInlineBrowserRecoverySummary(values: string[]): string | null {
  const joined = values.join("\n").trim();
  if (!joined) return null;
  if (
    !/\b(?:browser_cdp_unavailable|cdp_command_timeout|detached_target|attach_failed|target_not_found|expert_session_detached|session_not_found|CDP command timed out|browser target detached|target attach failed|cold recreation|new (?:cold )?browser session|new session `?browser-session-|session was unavailable|browser session .*unavailable|dashboard reopened)\b/i.test(
      joined,
    )
  ) {
    return null;
  }
  return sliceUtf8(joined, 600);
}

export function readPolicyPermissionGateEvidence(toolTrace: NativeToolRoundTrace[]): boolean {
  return toolTrace.some(
    (round) =>
      round.calls.some((call) => call.name.startsWith("permission_")) ||
      (round.progress ?? []).some((progress) => {
        const eventType = progress.detail?.["eventType"];
        return (
          typeof eventType === "string" && eventType.startsWith("permission.")
        );
      }),
  );
}

export function readPolicyMissingApprovalGateRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: readonly LLMMessage[];
  repairMarkers: readonly LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly { name: string }[];
}): boolean {
  if (hasMissingApprovalGateRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!hasToolDefinition(input.tools, "permission_query")) {
    return false;
  }
  if (taskIntentFactsForPrompt(input.taskPrompt).approvalAlreadyApplied) {
    return false;
  }
  if (readPolicyPermissionGateEvidence(input.toolTrace)) {
    return false;
  }
  return taskIntentFactsForPrompt(input.taskPrompt)
    .approvalGatedBrowserActionRequested;
}

export function readPolicyReadOnlyPermissionQuerySuppression(
  toolCalls: LLMToolCall[],
  context: { taskPrompt: string; sessionContext: string },
): boolean {
  const taskContext = [context.taskPrompt, context.sessionContext]
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
  return toolCalls.some((call) => {
    if (call.name !== "permission_query") {
      return false;
    }
    const callText = stableJson(normalizeToolInputForSignature(call.input));
    return (
      taskFactLooksLikeReadOnlyBrowserPageReview(taskContext) ||
      isSourceBackedReadOnlyTask(taskContext) ||
      isClearlyUnrequestedReadOnlyPermissionQuery(callText, taskContext) ||
      disclaimsIntendedBrowserMutation(callText) ||
      (disclaimsIntendedBrowserMutation(taskContext) &&
        !taskIntentFactsForPrompt(taskContext)
          .approvalGatedBrowserActionRequested)
    );
  });
}

function isSourceBackedReadOnlyTask(taskPrompt: string): boolean {
  const sourceReadOnlyTask =
    /\b(?:read[- ]only|source-backed|source backed|provider|pricing|price|search\/web_search|web_search|extract|evidence source|listed sources?|research note|api provider)\b/i.test(
      taskPrompt,
    );
  if (!sourceReadOnlyTask) {
    return false;
  }
  return !/\b(?:submit|submission|form|click|press|type|fill|select|upload|download|delete|save|apply|confirm|purchase|checkout|sign\s*in|log\s*in|mutat(?:e|ion)|side[- ]effect|dry[- ]run)\b/i.test(
    taskPrompt,
  );
}

function isClearlyUnrequestedReadOnlyPermissionQuery(
  callText: string,
  taskPrompt: string,
): boolean {
  if (taskIntentFactsForPrompt(taskPrompt).permissionToolsAllowed) {
    return false;
  }
  if (!/\b(?:browser\.form\.submit|form submission|approval-gated browser form submission)\b/i.test(callText)) {
    return false;
  }
  const sourceReadOnlyTask =
    isSourceBackedReadOnlyTask(taskPrompt) ||
    taskFactLooksLikeReadOnlyBrowserPageReview(taskPrompt);
  return sourceReadOnlyTask;
}

export function readPolicyTimeoutFollowupContinuationRequest(taskPrompt: string): boolean {
  const timeoutSourceRequest = /\b(?:slow source|bounded attempt|source does not return|doesn't return|timed out|timeout|earlier timeout|previous timeout|prior timeout)\b/i.test(
    taskPrompt,
  );
  const continuationRequest = /\b(?:follow-up|followup|resume|continue|continuation|same source-check context|same source check context|existing source-check context|existing source check context)\b/i.test(
    taskPrompt,
  );
  const explicitHowToContinue = /\b(?:explain how|describe how|state how|say how)\b[\s\S]{0,120}\b(?:mission|work|source-check|source check)\b[\s\S]{0,80}\b(?:continue|resume|retry)\b/i.test(
    taskPrompt,
  );
  const resumeAfterTimeout = /\b(?:resume|continue)\b[\s\S]{0,160}\b(?:existing|same)\b[\s\S]{0,120}\b(?:source-check|source check|context)\b[\s\S]{0,220}\b(?:earlier|previous|prior)?\s*timeout\b|\b(?:earlier|previous|prior)\s*timeout\b[\s\S]{0,220}\b(?:limits?|conclusion|resume|continue|retry|source-check|source check)\b/i.test(
    taskPrompt,
  );
  return (
    timeoutSourceRequest &&
    continuationRequest &&
    (explicitHowToContinue || resumeAfterTimeout)
  );
}

export function readPolicyNativeToolTraceEvidenceText(
  rounds: NativeToolRoundTrace[],
): string {
  return rounds
    .flatMap((round) => round.results)
    .filter((result) => !result.isError && result.skipped !== true)
    .filter((result) => !isControlPlaneToolResultName(result.toolName))
    .map((result) => result.content ?? "")
    .filter((content) => content.trim().length > 0)
    .join("\n\n");
}

export function readPolicySourceBoundedEvidenceText(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): string {
  return [
    readPolicyNativeToolTraceEvidenceText(input.toolTrace),
    extractSourceBoundedEvidenceSnippets(input.taskPrompt),
    ...input.messages.map((message) =>
      extractSourceBoundedEvidenceSnippets(
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
      ),
    ),
  ]
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

export function readPolicyCompletedSessionEvidenceText(
  toolTrace: NativeToolRoundTrace[],
): string {
  const evidence: string[] = [];
  for (const round of toolTrace) {
    for (const result of round.results) {
      if (
        result.toolName !== "sessions_spawn" &&
        result.toolName !== "sessions_send"
      ) {
        continue;
      }
      const parsed = result.content
        ? parseSessionToolResult(result.content)
        : null;
      if (!parsed || parsed.status !== "completed") {
        continue;
      }
      const completedEvidence = readCompletedSessionEvidence(parsed);
      if (completedEvidence) {
        evidence.push(completedEvidence);
      }
    }
  }
  return dedupeStrings(evidence).join("\n\n");
}

export function readPolicySourceEvidenceCarryForwardRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  return (
    readPolicyProviderPricingEvidenceCarryForwardRepair(input) ||
    readPolicyVendorPriceEvidenceCarryForwardRepair(input) ||
    readPolicyProductBriefEvidenceCarryForwardRepair(input) ||
    readPolicyCompletedSessionLabelCarryForwardRepair(input)
  );
}

export function readPolicyWeakEvidenceSynthesisRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText?: string;
}): boolean {
  if (hasWeakEvidenceSynthesisRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    input.evidenceText &&
    hasUnsupportedSourceBoundedExtrapolation(
      input.resultText,
      input.evidenceText,
    )
  ) {
    return true;
  }
  if (allowsExactFinalAnswerShapeBypass(input.taskPrompt, input.resultText)) {
    return false;
  }
  if (readPolicyCoordinatorRoleHandoffEcho(input.resultText)) {
    return true;
  }
  if (matchesAny(input.resultText, WEAK_UNCERTAINTY_SYNTHESIS_PATTERNS)) {
    return true;
  }
  if (readPolicyMissingRequestedRiskDimensionRepair(input)) {
    return true;
  }
  return (
    !readPolicyEstimateRequest(input.taskPrompt) &&
    matchesAny(input.resultText, WEAK_ESTIMATE_SYNTHESIS_PATTERNS)
  );
}

export function readPolicyCoordinatorRoleHandoffEcho(text: string): boolean {
  return (
    /\bLead is operating as Lead Coordinator\b/i.test(text) &&
    /\bDelegate one next role when work remains\.?\s+Otherwise finalize\b/i.test(text) &&
    /@\{[^}]+\}/.test(text) &&
    /\bPlease take the next assigned slice and report back briefly\b/i.test(text)
  );
}

export function readPolicyTimeoutFollowupFinalGuidanceRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  if (hasTimeoutFollowupFinalGuidanceRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!readPolicyTimeoutFollowupContinuationRequest(input.taskPrompt)) {
    return false;
  }
  if (!/\b(?:timeout|timed out|resumable|recovered|recovery)\b/i.test(input.evidenceText)) {
    return false;
  }
  const hasUnverifiedScope = /\b(?:unverified|not verified|remaining scope|source-bounded|source bounded)\b/i.test(
    input.resultText,
  );
  const hasContinuationGuidance = hasTimeoutContinuationGuidance(
    input.resultText,
  );
  const hasTimeoutContext = /\b(?:timeout|timed out|recovered|recovery|resumed)\b/i.test(
    input.resultText,
  );
  return !hasUnverifiedScope || !hasContinuationGuidance || !hasTimeoutContext;
}

export function readPolicyMissingRequestedNextActionRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
}): boolean {
  if (hasMissingRequestedNextActionRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !/\b(?:next action|next step|operator should|should take|safe fallback|fallback action)\b/i.test(
      input.taskPrompt,
    )
  ) {
    return false;
  }
  return !/\b(?:next action|next step|recommended action|recommend(?:ed)?|operator should|should (?:retry|reopen|check|watch|escalate|preserve|request|continue|stop|avoid)|safe fallback|fallback action)\b/i.test(
    input.resultText,
  );
}

export type RequiredFinalDeliverable = {
  id:
    | "final_conclusion"
    | "product_workbench_next_actions_line"
    | "two_row_table";
  label: string;
  instruction: string;
};

export function readPolicyRequiredFinalSynthesisDeliverables(
  taskPrompt: string,
): RequiredFinalDeliverable[] {
  const deliverables: RequiredFinalDeliverable[] = [];
  if (readPolicyTwoRowTableRequest(taskPrompt)) {
    deliverables.push({
      id: "two_row_table",
      label: "two-row table",
      instruction:
        "Return the requested merged table with exactly two evidence rows after the header unless a source is explicitly incomplete.",
    });
  }
  if (readPolicyFinalConclusionRequest(taskPrompt)) {
    deliverables.push({
      id: "final_conclusion",
      label: "final one-sentence conclusion",
      instruction:
        "After the requested table or structured answer, include the requested final one-sentence conclusion with an explicit label such as `结论：` or `Conclusion:`.",
    });
  }
  if (
    readPolicyAgentWorkbenchProductBriefRequest(taskPrompt) &&
    /^\s*[-*+]\s+next actions\s*:/im.test(taskPrompt)
  ) {
    deliverables.push({
      id: "product_workbench_next_actions_line",
      label: "product workbench next actions line",
      instruction:
        "Include a standalone bullet exactly labeled `- next actions:` and list the three concrete build actions from the source-backed product brief.",
    });
  }
  return deliverables;
}

export function findMissingRequiredFinalDeliverables(input: {
  taskPrompt: string;
  resultText: string;
}): RequiredFinalDeliverable[] {
  return readPolicyRequiredFinalSynthesisDeliverables(input.taskPrompt).filter(
    (deliverable) => !finalDeliverableIsPresent(deliverable, input.resultText),
  );
}

export function readPolicyMissingBrowserEvidenceDimensionsRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  if (hasMissingBrowserEvidenceDimensionsRepairPrompt(input.repairMarkers)) {
    return false;
  }
  return findMissingBrowserEvidenceDimensions(input).length > 0;
}

export function readPolicyFalseEvidenceBlockedSynthesisRepair(input: {
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  if (hasFalseEvidenceBlockedSynthesisRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !matchesAny(input.resultText, FALSE_EVIDENCE_BLOCKED_SYNTHESIS_PATTERNS)
  ) {
    return false;
  }
  return !matchesAny(input.evidenceText, ACTUAL_EVIDENCE_BLOCKED_PATTERNS);
}

function extractSourceBoundedEvidenceSnippets(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const snippets: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!looksLikeSourceBoundedEvidenceLine(line)) continue;
    snippets.push(
      lines
        .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
        .join("\n"),
    );
  }
  return [...new Set(snippets)].join("\n\n");
}

function looksLikeSourceBoundedEvidenceLine(line: string): boolean {
  return (
    /\b(?:avoid use in\b|not (?:for|intended for) (?:production|operational|operations)|for (?:documentation|illustrative|example|testing) (?:use|purposes?)|without needing permission|outside the verified scope|scope[- ]limited)\b/i.test(
      line,
    ) ||
    /\b(?:Evidence|source|observed|verified|final_url|status_code|title)\b/i.test(
      line,
    ) ||
    /(?:证据|来源|已验证|关键原文|最终 URL|页面 title|取证方式|仅供(?:文档|示例|测试)|请勿用于(?:生产|运营|实际))/i.test(
      line,
    )
  );
}

const PRODUCT_BRIEF_MULTI_AGENT_EVIDENCE_PATTERN =
  /\bmulti[- ]agent decomposition\b|\bdurable sub-session history\b|\bspecialist agents?\b[\s\S]{0,120}\bdecision-ready brief\b/i;

const PRODUCT_BRIEF_MULTI_AGENT_RESULT_PATTERN =
  /\bmulti[- ]agent\b|multiple agents|specialist agents|delegated agents|agent coordination/i;

export function readPolicyProductBriefEvidenceCarryForwardRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  if (hasProductBriefEvidenceCarryForwardRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!readPolicyAgentWorkbenchProductBriefRequest(input.taskPrompt)) {
    return false;
  }
  if (!PRODUCT_BRIEF_MULTI_AGENT_EVIDENCE_PATTERN.test(input.evidenceText)) {
    return false;
  }
  const missingMultiAgent =
    !PRODUCT_BRIEF_MULTI_AGENT_RESULT_PATTERN.test(input.resultText);
  const missingRenderedSignals =
    hasProductSignalDashboardMetrics(input.evidenceText) &&
    (!PRODUCT_SIGNAL_DASHBOARD_RENDERED_RESULT_PATTERN.test(input.resultText) ||
      hasProductSignalDashboardUnverifiedContradiction(input.resultText));
  return missingMultiAgent || missingRenderedSignals;
}

export function readPolicyCompletedSessionLabelCarryForwardRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  if (hasCompletedSessionLabelCarryForwardRepairPrompt(input.repairMarkers)) {
    return false;
  }
  const labels = requiredCompletedSessionEvidenceLabelsForTask({
    taskPrompt: input.taskPrompt,
    labels: extractCompletedSessionEvidenceLabels(input.evidenceText),
  });
  if (labels.length === 0) {
    return false;
  }
  if (readPolicyAgentWorkbenchProductBriefRequest(input.taskPrompt)) {
    return false;
  }
  const labelSensitiveTask =
    (taskIntentFactsForPrompt(input.taskPrompt)
      .approvalGatedBrowserActionRequested &&
      hasAppliedApprovalEvidenceText(input.evidenceText)) ||
    /\b(?:source labels?|source URLs?|evidence streams?|source streams?|source checks?|sources?)\b/i.test(
      input.taskPrompt,
    );
  if (!labelSensitiveTask) {
    return false;
  }
  return labels.some((label) => !normalizedTextContains(input.resultText, label));
}

function requiredCompletedSessionEvidenceLabelsForTask(input: {
  taskPrompt: string;
  labels: string[];
}): string[] {
  if (!taskIntentFactsForPrompt(input.taskPrompt).exactFinalAnswerShapeExpected) {
    return input.labels;
  }
  const requiredShapeText = extractExactFinalAnswerShapeBlock(input.taskPrompt) ?? input.taskPrompt;
  return input.labels.filter((label) => normalizedTextContains(requiredShapeText, label));
}

function extractExactFinalAnswerShapeBlock(taskPrompt: string): string | null {
  const marker = taskPrompt.match(
    /(?:use this exact (?:phase\s*\d+\s+)?final answer shape[^\n]*:|use exactly this section skeleton[^\n]*:)\s*\n/i,
  );
  if (!marker?.index) {
    if (marker?.index !== 0) return null;
  }
  const start = marker.index + marker[0].length;
  const rest = taskPrompt.slice(start);
  const end = rest.search(
    /\n(?:Do not|Keep the|Never|Use plain|Do not include|Do not create|The first non-empty|If any|Wait for|Final answer must|Phase\s*\d+\s+final answer must)\b/i,
  );
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

export function readPolicyAgentWorkbenchProductBriefRequest(taskPrompt: string): boolean {
  return (
    /\bagent workbench\b/i.test(taskPrompt) &&
    /\b(?:product[- ]ready brief|product brief|audit-ready product brief|next release)\b/i.test(
      taskPrompt,
    ) &&
    /\b(?:independent evidence streams|specialist work|Mission Control|product-signals|live signal dashboard)\b/i.test(
      taskPrompt,
    )
  );
}

function hasProductBriefEvidenceCarryForwardRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final product brief dropped required source-backed workbench evidence",
      ),
  );
}

function hasCompletedSessionLabelCarryForwardRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final answer dropped visible evidence source labels",
      ),
  );
}

function hasAppliedApprovalEvidenceText(text: string): boolean {
  return /\bpermission\.applied\b|["']event_type["']\s*:\s*["']permission\.applied["']|\bapproval\b[\s\S]{0,120}\bapplied\b/i.test(
    text,
  );
}

interface ProviderPricingEvidenceFact {
  provider: string;
  inputPrice: string;
  outputPrice: string;
}

export interface VendorPriceEvidenceFact {
  vendor: string;
  price: string;
}

function readPolicyProviderPricingEvidenceCarryForwardRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  if (hasProviderPricingEvidenceCarryForwardRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!taskIntentFactsForPrompt(input.taskPrompt).providerSearchPricingResearch) {
    return false;
  }
  const facts = extractProviderPricingEvidenceFacts(input.evidenceText);
  if (facts.length === 0) {
    return false;
  }
  return facts.some((fact) => !resultPreservesProviderPricingFact(input.resultText, fact));
}

function readPolicyVendorPriceEvidenceCarryForwardRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  if (hasVendorPriceEvidenceCarryForwardRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!/\bvendors?\b|\bVendor\s+[A-Za-z0-9_-]+\b/i.test(input.taskPrompt)) {
    return false;
  }
  const facts = extractPolicyVendorPriceEvidenceFacts(input.evidenceText);
  if (facts.length === 0) {
    return false;
  }
  return facts.some((fact) => !resultPreservesPolicyVendorPriceFact(input.resultText, fact));
}

export function extractPolicyVendorPriceEvidenceFacts(
  evidenceText: string,
): VendorPriceEvidenceFact[] {
  const facts: VendorPriceEvidenceFact[] = [];
  const pattern =
    /\b(Vendor\s+[A-Za-z0-9][A-Za-z0-9_-]{0,48})\b[\s\S]{0,700}?\b(?:price|pricing)\b[\s\S]{0,100}?(\$\d+(?:\.\d+)?(?:\s+per\s+[A-Za-z0-9_-]+)?)/gi;
  for (const match of evidenceText.matchAll(pattern)) {
    const vendor = normalizeVendorEvidenceLabel(match[1] ?? "");
    const price = normalizeVendorPrice(match[2] ?? "");
    if (!vendor || !price) {
      continue;
    }
    facts.push({ vendor, price });
  }
  return dedupeVendorPriceFacts(facts).slice(0, 8);
}

function dedupeVendorPriceFacts(
  facts: VendorPriceEvidenceFact[],
): VendorPriceEvidenceFact[] {
  const seen = new Set<string>();
  const deduped: VendorPriceEvidenceFact[] = [];
  for (const fact of facts) {
    const key = `${fact.vendor.toLowerCase()}:${fact.price.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(fact);
  }
  return deduped;
}

export function resultPreservesPolicyVendorPriceFact(
  resultText: string,
  fact: VendorPriceEvidenceFact,
): boolean {
  const vendorEvidence = providerScopedResultText(resultText, fact.vendor);
  if (!vendorEvidence) {
    return false;
  }
  return (
    vendorEvidence.toLowerCase().includes(fact.price.toLowerCase()) &&
    !providerPricingMarkedUnverified(vendorEvidence)
  );
}

function extractProviderPricingEvidenceFacts(
  evidenceText: string,
): ProviderPricingEvidenceFact[] {
  const facts: ProviderPricingEvidenceFact[] = [];
  for (const line of evidenceText.split(/\r?\n/)) {
    if (!line.includes("|") || !/\$\d/.test(line)) {
      continue;
    }
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length < 3) {
      continue;
    }
    const provider = cells[0] ?? "";
    if (!looksLikeProviderName(provider)) {
      continue;
    }
    const prices = extractDollarPrices(line);
    if (prices.length < 2) {
      continue;
    }
    facts.push({
      provider,
      inputPrice: prices[0]!,
      outputPrice: prices[1]!,
    });
  }
  return dedupeProviderPricingFacts(facts).slice(0, 8);
}

function dedupeProviderPricingFacts(
  facts: ProviderPricingEvidenceFact[],
): ProviderPricingEvidenceFact[] {
  const seen = new Set<string>();
  const deduped: ProviderPricingEvidenceFact[] = [];
  for (const fact of facts) {
    const key = `${fact.provider.toLowerCase()}:${fact.inputPrice}:${fact.outputPrice}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(fact);
  }
  return deduped;
}

function resultPreservesProviderPricingFact(
  resultText: string,
  fact: ProviderPricingEvidenceFact,
): boolean {
  const providerEvidence = providerScopedResultText(resultText, fact.provider);
  if (!providerEvidence) {
    return false;
  }
  return (
    providerEvidence.includes(fact.inputPrice) &&
    providerEvidence.includes(fact.outputPrice) &&
    !providerPricingMarkedUnverified(providerEvidence)
  );
}

function providerScopedResultText(
  resultText: string,
  provider: string,
): string | null {
  const providerPattern = new RegExp(escapeRegExp(provider), "i");
  const matchingLines = resultText
    .split(/\r?\n/)
    .filter((line) => providerPattern.test(line));
  if (matchingLines.length > 0) {
    return matchingLines.join("\n");
  }
  const match = providerPattern.exec(resultText);
  if (!match) {
    return null;
  }
  const start = Math.max(0, match.index - 180);
  const end = Math.min(resultText.length, match.index + provider.length + 360);
  return resultText.slice(start, end);
}

function providerPricingMarkedUnverified(text: string): boolean {
  return /(?:未验证|not verified|unverified|not confirmed|unconfirmed)/i.test(
    text,
  );
}

function looksLikeProviderName(value: string): boolean {
  const normalized = value.trim();
  if (!/[A-Za-z]/.test(normalized)) {
    return false;
  }
  if (/^(?:provider|source|model|vendor|---+)$/i.test(normalized)) {
    return false;
  }
  return normalized.length <= 80;
}

function normalizeVendorEvidenceLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeVendorPrice(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractDollarPrices(text: string): string[] {
  return [...text.matchAll(/\$\d+(?:\.\d+)?/g)].map((match) => match[0]);
}

function hasVendorPriceEvidenceCarryForwardRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final answer contradicted source-backed vendor prices",
      ),
  );
}

function hasProviderPricingEvidenceCarryForwardRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final answer dropped source-backed provider pricing values",
      ),
  );
}

function hasUnsupportedSourceBoundedExtrapolation(
  resultText: string,
  evidenceText: string,
): boolean {
  const mentionsDnsOrIp =
    /\b(?:dns|ip address|resolves? to|resolution|a record|93\.184\.215\.14)\b/i.test(
      resultText,
    ) || /(?:DNS|解析|污染|IP\s*地址|93\.184\.215\.14)/i.test(resultText);
  if (
    mentionsDnsOrIp &&
    !/\b(?:dns|ip address|resolves? to|resolution|a record|93\.184\.215\.14)\b|(?:DNS|解析|污染|IP\s*地址|93\.184\.215\.14)/i.test(
      evidenceText,
    )
  ) {
    return true;
  }
  const strongOperationsRestriction =
    /(?:不得|不能|禁止|不可|不应)[^。；;\n]{0,120}(?:生产|运营|实际运营|真实环境|测试环境|真实服务|正式业务|真实业务|联网业务|业务场景)/.test(
      resultText,
    ) ||
    /\b(?:must not|cannot|prohibited|forbidden|not allowed)\b[\s\S]{0,120}\b(?:operations?|production|real service|real services|real environment|test environment|business use|networked business)\b/i.test(
      resultText,
    );
  if (
    strongOperationsRestriction &&
    !evidenceStatesStrictOperationsRestriction(evidenceText)
  ) {
    return true;
  }
  const unsupportedRiskMechanism =
    /(?:路由冲突|安全风险|恶意(?:测试)?流量|abuse risk|security risk|routing conflict)/i.test(
      resultText,
    ) &&
    !/(?:路由冲突|安全风险|恶意(?:测试)?流量|abuse risk|security risk|routing conflict)/i.test(
      evidenceText,
    );
  return unsupportedRiskMechanism;
}

function evidenceStatesStrictOperationsRestriction(
  evidenceText: string,
): boolean {
  return (
    /(?:不得|不能|禁止|不可|不应)[^。；;\n]{0,120}(?:生产|运营|实际运营|真实环境|测试环境|真实服务|正式业务|真实业务|联网业务|业务场景)/.test(
      evidenceText,
    ) ||
    /\b(?:must not|cannot|prohibited|forbidden|not allowed)\b[\s\S]{0,120}\b(?:operations?|production|real service|real services|real environment|test environment|business use|networked business)\b/i.test(
      evidenceText,
    )
  );
}

export function readPolicyMissingRequestedRiskDimensionRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
}): boolean {
  if (
    !/\brisks?\b/i.test(input.taskPrompt) ||
    /\brisks?\b/i.test(input.resultText)
  ) {
    return false;
  }
  return input.messages.some((message) =>
    /\brisks?\b/i.test(readMessageContentText(message.content)),
  );
}

export function readPolicyEstimateRequest(taskPrompt: string): boolean {
  return matchesAny(taskPrompt, ESTIMATE_REQUEST_PATTERNS);
}

function hasWeakEvidenceSynthesisRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final answer weakens verified evidence",
      ),
  );
}

function hasMissingRequestedNextActionRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: requested next action is missing",
      ),
  );
}

function hasTimeoutFollowupFinalGuidanceRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: timeout follow-up final omitted recovery guidance",
      ),
  );
}

function hasFalseEvidenceBlockedSynthesisRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final answer falsely marks completed evidence",
      ),
  );
}

function hasMissingBrowserEvidenceDimensionsRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final answer omitted requested browser evidence dimensions",
      ),
  );
}

export function readPolicyFinalConclusionRequest(taskPrompt: string): boolean {
  return (
    /(?:最后|最终|末尾|结尾|再给|补充)[^\n。.!?]{0,80}(?:一句话|一[个段]?简短|简短)?[^\n。.!?]{0,60}(?:结论|总结)/i.test(
      taskPrompt,
    ) ||
    /\b(?:final|last|closing)\b[\s\S]{0,120}\b(?:one[- ]sentence|single[- ]sentence|brief)\b[\s\S]{0,80}\b(?:conclusion|summary)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:one[- ]sentence|single[- ]sentence|brief)\b[\s\S]{0,80}\b(?:final|closing)?\s*(?:conclusion|summary)\b/i.test(
      taskPrompt,
    )
  );
}

export function readPolicyTwoRowTableRequest(taskPrompt: string): boolean {
  return (
    /(?:两行|2\s*行|两条|2\s*条)[^\n。.!?]{0,80}(?:表格|表)/.test(
      taskPrompt,
    ) ||
    /\b(?:two[- ]row|2[- ]row|two rows|2 rows)\b[\s\S]{0,80}\btable\b/i.test(
      taskPrompt,
    )
  );
}

function finalDeliverableIsPresent(
  deliverable: RequiredFinalDeliverable,
  resultText: string,
): boolean {
  if (deliverable.id === "final_conclusion") {
    return /(?:^|\n)\s*(?:#{1,4}\s*)?(?:[*_]{1,3}\s*)?(?:结论|一句话结论|最终结论|总结|Conclusion|Summary)\s*[:：]\s*(?:[*_]{1,3})?/i.test(
      resultText,
    );
  }
  if (deliverable.id === "two_row_table") {
    return markdownTableDataRowCount(resultText) >= 2;
  }
  if (deliverable.id === "product_workbench_next_actions_line") {
    return /^\s*[-*+]\s+next actions\s*:/im.test(resultText);
  }
  return true;
}

function markdownTableDataRowCount(resultText: string): number {
  const rows = resultText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  if (rows.length < 3) return 0;
  const separatorIndex = rows.findIndex((line) =>
    /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line),
  );
  if (separatorIndex < 1) return 0;
  return rows.slice(separatorIndex + 1).filter((line) => {
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    return cells.length > 0;
  }).length;
}

const PRODUCT_SIGNAL_BROWSER_EVIDENCE_UNVERIFIED_PATTERN =
  /\b(?:browser|rendered|rendered browser|browser-rendered|browser visible|browser-visible|DOM|screenshot|snapshot)\s+(?:evidence|inspection|verification|view|capture|signal|signals|dashboard)\b[\s\S]{0,220}\b(?:not verified|unverified|not confirmed|unconfirmed|not extracted|not captured|not observed|not in (?:the )?(?:completed )?evidence)|\b(?:not verified|unverified|not confirmed|unconfirmed|not extracted|not captured|not observed|not in (?:the )?(?:completed )?evidence)\b[\s\S]{0,220}\b(?:browser|rendered|rendered browser|browser-rendered|browser visible|browser-visible|DOM|screenshot|snapshot)\s+(?:evidence|inspection|verification|view|capture|signal|signals|dashboard)\b/i;

function hasProductSignalDashboardUnverifiedContradiction(
  text: string,
): boolean {
  return (
    PRODUCT_SIGNAL_DASHBOARD_COUNTERS_UNVERIFIED_PATTERN.test(text) ||
    PRODUCT_SIGNAL_BROWSER_EVIDENCE_UNVERIFIED_PATTERN.test(text)
  );
}

export function readPolicyProductSignalDashboardEvidenceRequest(text: string): boolean {
  return /\b(?:product-signals|live signal dashboard|product signal dashboard)\b/i.test(
    text,
  );
}

export function hasProductSignalDashboardMetrics(text: string): boolean {
  return PRODUCT_SIGNAL_DASHBOARD_COUNTERS_PATTERN.test(text);
}

export function summarizeProductSignalDashboardMetrics(
  evidenceText: string,
): string | null {
  const metrics: string[] = [];
  const seen = new Set<string>();
  const metricPattern =
    /(?:^|[\n.;,|])\s*([A-Za-z][A-Za-z0-9 _/-]{1,48}?)\s*(?::|=|-|\bis\b)\s*(\d+(?:\.\d+)?%?)(?![\d.])/g;
  for (const match of evidenceText.matchAll(metricPattern)) {
    const label = match[1]?.replace(/\s+/g, " ").trim();
    const value = match[2]?.trim();
    if (!label || !value) {
      continue;
    }
    const normalizedLabel = label.toLowerCase();
    if (
      seen.has(normalizedLabel) ||
      /^(?:http|https|port|status|code|line|id|url)$/i.test(label)
    ) {
      continue;
    }
    seen.add(normalizedLabel);
    metrics.push(`${label}: ${value}`);
    if (metrics.length >= 4) {
      break;
    }
  }
  return metrics.length > 0 ? metrics.join("; ") : null;
}

export function extractProductSignalDashboardUrl(
  taskPrompt: string,
): string | null {
  const lines = taskPrompt.split(/\r?\n/);
  for (const line of lines) {
    if (!readPolicyProductSignalDashboardEvidenceRequest(line)) {
      continue;
    }
    const url = extractHttpUrls(line)[0];
    if (url) {
      return url;
    }
  }
  return (
    extractHttpUrls(taskPrompt).find((url) => /product-signals/i.test(url)) ??
    null
  );
}

const MISSING_BROWSER_EVIDENCE_FINAL_PATTERNS = [
  /\b(?:browser|rendered|DOM|page|snapshot|screenshot|popup|iframe|frame|shadow)\b[\s\S]{0,120}\b(?:tools?|tooling|worker|agent|session)\b[\s\S]{0,80}\b(?:unavailable|not available|disabled|missing|could not be called|cannot be called|failed)\b/i,
  /\b(?:tools?|tooling|worker|agent|session)\b[\s\S]{0,80}\b(?:unavailable|not available|disabled|missing|could not be called|cannot be called|failed)\b[\s\S]{0,120}\b(?:browser|rendered|DOM|page|snapshot|screenshot|popup|iframe|frame|shadow)\b/i,
  /\b(?:static|raw|server|HTTP)\s+(?:fetch|HTML|extraction|request)\b[\s\S]{0,160}\b(?:instead of|without|not)\b[\s\S]{0,120}\b(?:browser|rendered|DOM|JavaScript|client[- ]side|popup|iframe|frame|shadow)\b/i,
  /\b(?:static|raw|server|HTTP)\s+(?:fetch|HTML|extraction|request)\b[\s\S]{0,180}\b(?:cannot|can't|could not|unable to)\b[\s\S]{0,160}\b(?:browser|rendered|DOM|JavaScript|client[- ]side|popup|iframe|frame|shadow)\b/i,
  /\blive browser session\b[\s\S]{0,120}\b(?:needed|required|necessary)\b/i,
  /\b(?:browser|rendered|DOM|JavaScript|client[- ]side|popup|iframe|frame|shadow)\b[\s\S]{0,160}\b(?:not verified|unverified|unable to verify|was not verified|could not verify)\b/i,
];

const CLAIMED_BROWSER_EVIDENCE_WITHOUT_SESSION_PATTERNS = [
  /\bTURNKEYAI_COMPLEX_BROWSER_OK\b/,
  /(?:^|\n)\s*[-*]?\s*(?:\*\*)?browser evidence(?:\*\*)?\s*:/i,
  /\b(?:browser-observed|browser-visible|rendered page|visible page|browser session)\b[\s\S]{0,120}\b(?:verified|observed|confirmed|captured|used|cited)\b/i,
  /\bcomplex browser evidence\b/i,
];

export function readPolicyMissingBrowserEvidenceRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly { name: string }[] | undefined;
}): boolean {
  if (!hasToolDefinition(input.tools, "sessions_spawn")) {
    return false;
  }
  if (hasMissingBrowserEvidenceRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!readPolicyBrowserEvidenceRequirement(input.taskPrompt)) {
    return false;
  }
  if (hasCompletedBrowserSessionEvidence(input.toolTrace)) {
    return false;
  }
  if (
    hasAttemptedBrowserSessionEvidence(input.toolTrace) ||
    contextHasBrowserSessionAttempt(
      buildBrowserEvidenceRepairContext(input.taskPrompt, input.messages),
    )
  ) {
    return false;
  }
  return (
    containsAnyToolCallForm({ text: input.resultText }) ||
    matchesAny(input.resultText, MISSING_BROWSER_EVIDENCE_FINAL_PATTERNS) ||
    matchesAny(input.resultText, CLAIMED_BROWSER_EVIDENCE_WITHOUT_SESSION_PATTERNS)
  );
}

export function readPolicyMissingProductSignalBrowserEvidenceRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly { name: string }[] | undefined;
  evidenceText?: string | undefined;
}): boolean {
  if (!hasToolDefinition(input.tools, "sessions_spawn")) {
    return false;
  }
  if (hasMissingBrowserEvidenceRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!readPolicyProductSignalDashboardEvidenceRequest(input.taskPrompt)) {
    return false;
  }
  const evidenceText = [
    input.evidenceText,
    readPolicyCompletedSessionEvidenceText(input.toolTrace),
  ]
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
    .join("\n\n");
  if (hasProductSignalDashboardMetrics(input.resultText)) {
    return false;
  }
  if (hasProductSignalDashboardMetrics(evidenceText)) {
    return false;
  }
  return (
    matchesAny(input.resultText, MISSING_BROWSER_EVIDENCE_FINAL_PATTERNS) ||
    /\b(?:SPAs?|server HTML shells?|HTML shells?|shell only|partial text|browser rendering)\b[\s\S]{0,180}\b(?:not confirmed|not verified|unconfirmed|unverified|without|lacks?)\b/i.test(
      input.resultText,
    ) ||
    /\b(?:not confirmed|not verified|unconfirmed|unverified|without|lacks?)\b[\s\S]{0,180}\b(?:SPAs?|server HTML shells?|HTML shells?|shell only|browser rendering|rendered dashboard)\b/i.test(
      input.resultText,
    )
  );
}

function hasMissingBrowserEvidenceRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: browser-visible evidence is missing",
      ),
  );
}

function hasAttemptedBrowserSessionEvidence(
  toolTrace: NativeToolRoundTrace[],
): boolean {
  return toolTrace.some(
    (round) =>
      round.calls.some(isBrowserSessionSpawn) ||
      round.results.some((result) => {
        if (
          result.toolName !== "sessions_spawn" &&
          result.toolName !== "sessions_send"
        ) {
          return false;
        }
        const parsed = result.content
          ? parseSessionToolResult(result.content)
          : null;
        return Boolean(
          parsed &&
            (parsed.agent_id === "browser" ||
              /^worker:browser:/i.test(String(parsed.session_key ?? ""))),
        );
      }),
  );
}

function contextHasBrowserSessionAttempt(context: string): boolean {
  return extractSessionToolResultRecords(context).some((result) => {
    const agentId = result["agent_id"];
    const sessionKey = result["session_key"];
    return (
      agentId === "browser" ||
      (typeof sessionKey === "string" && /^worker:browser:/i.test(sessionKey))
    );
  });
}

function buildBrowserEvidenceRepairContext(
  taskPrompt: string,
  messages: LLMMessage[],
): string {
  return [
    buildContinuationDirectiveContext(taskPrompt, messages),
    ...messages.map((message) => readMessageContentText(message.content)),
  ].join("\n");
}

const WEAK_UNCERTAINTY_SYNTHESIS_PATTERNS = [
  /\b(?:TBD|to be confirmed|needs confirmation|pending confirmation|probably|maybe)\b/i,
  /(?:^|[^A-Za-z0-9_])待确认(?![A-Za-z0-9_])/,
];

const WEAK_ESTIMATE_SYNTHESIS_PATTERNS = [
  /\b(?:estimate|estimated)\b/i,
  /(?:^|[^A-Za-z0-9_])估算(?![A-Za-z0-9_])/,
];

const ESTIMATE_REQUEST_PATTERNS = [
  /\b(?:estimate|estimated|estimation|forecast|roughly|approx(?:imate|imately)?|ballpark|range)\b/i,
  /(?:^|[^A-Za-z0-9_])(?:估算|预估|大概|大致|范围)(?![A-Za-z0-9_])/,
];

const FALSE_EVIDENCE_BLOCKED_SYNTHESIS_PATTERNS = [
  /\b(?:not accessible|not fully accessible|inaccessible)\b/i,
  /\b(?:source|content|evidence|page|dashboard|browser|rendered|DOM|extraction)\b[\s\S]{0,120}\b(?:failed|unavailable|inaccessible|incomplete|truncated|blocked)\b/i,
  /\b(?:failed|unavailable|inaccessible|incomplete|truncated|blocked)\b[\s\S]{0,120}\b(?:source|content|evidence|page|dashboard|browser|rendered|DOM|extraction)\b/i,
];

const ACTUAL_EVIDENCE_BLOCKED_PATTERNS = [
  /\b(?:could not|unable to|failed to)\s+(?:access|extract|capture|read|load|verify)\b/i,
  /\b(?:verification status:\s*failed|content extraction\b[\s\S]{0,80}\b(?:failed|incomplete|truncated))\b/i,
  /\b(?:browser|rendered|DOM|page|dashboard|tab|target|screenshot|snapshot|CDP)\b[\s\S]{0,120}\b(?:failed|unavailable|inaccessible|incomplete|truncated)\b/i,
  /\b(?:failed|unavailable|inaccessible|incomplete|truncated)\b[\s\S]{0,120}\b(?:browser|rendered|DOM|page|dashboard|tab|target|screenshot|snapshot|CDP)\b/i,
];

export function hasExecutedSessionsSend(
  toolTrace: NativeToolRoundTrace[],
  sessionKey: string,
): boolean {
  return toolTrace.some((round) =>
    round.calls.some(
      (call) =>
        call.name === "sessions_send" &&
        readStringInput(call.input, "session_key") === sessionKey,
    ),
  );
}

export function readPolicyTimedOutApprovedBrowserSessionContinuation(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  timeoutSignal: SubAgentToolTimeoutSignal;
  tools?: readonly { name: string }[];
}): boolean {
  if (!hasToolDefinition(input.tools, "sessions_send")) {
    return false;
  }
  if (input.timeoutSignal.agentId !== "browser") {
    return false;
  }
  if (!input.timeoutSignal.sessionKey) {
    return false;
  }
  if (
    hasExecutedSessionsSend(input.toolTrace, input.timeoutSignal.sessionKey)
  ) {
    return false;
  }
  if (hasApprovedBrowserTimeoutContinuationPrompt(input.messages)) {
    return false;
  }
  if (
    !taskIntentFactsForPrompt(input.taskPrompt)
      .appliedApprovalBrowserContinuation
  ) {
    return false;
  }
  return true;
}

export function readPolicyTimedOutSiblingSessionContinuation(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  timeoutSignal: SubAgentToolTimeoutSignal;
  tools?: readonly { name: string }[];
}): boolean {
  if (!hasToolDefinition(input.tools, "sessions_send")) {
    return false;
  }
  if (!input.timeoutSignal.sessionKey) {
    return false;
  }
  if (
    hasExecutedSessionsSend(input.toolTrace, input.timeoutSignal.sessionKey)
  ) {
    return false;
  }
  if (hasCoverageTimeoutContinuationPrompt(input.messages)) {
    return false;
  }
  return taskIntentFactsForPrompt(input.taskPrompt).coverageCriticalDelegation;
}

export function shouldRunSupplementalLocalTimeoutProbe(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  evidenceText: string;
  tools?: readonly { name: string }[];
  browserAvailable: boolean;
}): { url: string; evidence: string } | null {
  if (
    !input.browserAvailable ||
    !hasToolDefinition(input.tools, "sessions_spawn")
  ) {
    return null;
  }
  if (hasSupplementalLocalTimeoutProbePrompt(input.messages)) {
    return null;
  }
  const context = buildContinuationDirectiveContext(
    input.taskPrompt,
    input.messages,
  );
  const sourceContext = `${input.taskPrompt}\n${context}\n${input.evidenceText}`;
  if (explicitlyDisallowsBrowserEvidence(sourceContext)) {
    return null;
  }
  const hasTimeoutEvidence =
    hasSessionTimeoutEvidence(input) ||
    readPolicyTimeoutMention(`${context}\n${input.evidenceText}`);
  if (
    !hasTimeoutEvidence ||
    !toolTraceHasCall(input.toolTrace, "sessions_send")
  ) {
    return null;
  }
  if (hasCompletedBrowserSessionEvidence(input.toolTrace)) {
    return null;
  }
  if (!looksBoundedTimeoutSourceCheck(sourceContext)) {
    return null;
  }
  if (!isContentPoorTimeoutEvidence(`${context}\n${input.evidenceText}`)) {
    return null;
  }
  const url = extractHttpUrls(sourceContext).find((candidate) => {
    try {
      return isLoopbackHostname(new URL(candidate).hostname);
    } catch {
      return false;
    }
  });
  return url ? { url, evidence: sliceUtf8(input.evidenceText, 1800) } : null;
}

function explicitlyDisallowsBrowserEvidence(text: string): boolean {
  return /\bbrowser[- ]visible\s*\/\s*rendered evidence was not requested\b|\b(?:browser[- ]visible|rendered|browser|DOM|screenshot|snapshot)\b[\s\S]{0,80}\b(?:was not|is not|not)\s+(?:requested|required|needed)\b|\b(?:do not|don't)\s+(?:use|call|inspect|open)\b[\s\S]{0,80}\b(?:browser|rendered|DOM|screenshot|snapshot)/i.test(
    text,
  );
}

function isContentPoorTimeoutEvidence(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || !readPolicyTimeoutMention(normalized)) {
    return false;
  }
  const hasPositiveSourceEvidence =
    /\b(?:HTTP\s*(?:status\s*)?200|status\s*[:=]?\s*200|(?:response body|body text)\b[\s\S]{0,80}\b(?:observed|captured|returned)|headers?\b[\s\S]{0,80}\b(?:observed|captured|returned)|TURNKEYAI_[A-Z0-9_]+_OK|readyState\s*[:=]?\s*complete|page title|visible text|source (?:returned|responded)|returned release-risk evidence)\b/i.test(
      normalized,
    );
  if (hasPositiveSourceEvidence) {
    return false;
  }
  return (
    /\b(?:no HTTP status|status code (?:was )?not obtained|no response headers?|no response body|body (?:was )?not retrieved|no usable evidence|no source content|returned no source content|verification did not complete|unverified|timed out before)\b/i.test(
      normalized,
    ) ||
    /\b(?:sub-agent session timed out|execution paused before completion|WORKER_TIMEOUT|timed out after \d+(?:\.\d+)?s)\b/i.test(
      normalized,
    )
  );
}

export function hasCompletedBrowserSessionEvidence(
  toolTrace: NativeToolRoundTrace[],
): boolean {
  return toolTrace.some((round) =>
    round.results.some((result) => {
      if (
        result.toolName !== "sessions_spawn" &&
        result.toolName !== "sessions_send"
      ) {
        return false;
      }
      const parsed = result.content
        ? parseSessionToolResult(result.content)
        : null;
      return Boolean(
        parsed &&
          parsed.status === "completed" &&
          parsed.agent_id === "browser" &&
          readCompletedSessionEvidence(parsed),
      );
    }),
  );
}

export const INCOMPLETE_APPROVED_BROWSER_ACTION_PATTERNS = [
  /\btools? (?:are |is )?(?:disabled|unavailable|not available)\b/i,
  /\btool[- ]disabled\b/i,
  /\bnot in (?:my |the )?current function namespace\b/i,
  /\bcannot emit (?:the )?(?:approval|permission) request\b/i,
  /\b(?:final synthesis|browser_act|could not be called|cannot call|could not execute|action blocked|not executed|not completed)\b/i,
  /\b(?:re-?delegat(?:e|ed|ing|ion)|next step needed)\b/i,
  /\bdelegat(?:e|ed|ing)[\s\S]{0,120}\b(?:approved|approval)[\s\S]{0,120}\b(?:browser|form|submit|submission)\b/i,
  /\b(?:approved|approval)[\s\S]{0,120}\bdelegat(?:e|ed|ing)[\s\S]{0,120}\b(?:browser|form|submit|submission)\b/i,
  /@role-browser\b/i,
  /\b(?:not submitted|not yet submitted|submission can now be completed|submit can now be completed)\b/i,
  /\bno\s+form\s+submission\s+(?:ran|executed|was performed)\b/i,
  /\bpre[- ]approval\s+inspection\b/i,
  /\bno\s+side\s+effects?\s+(?:ran|executed|were performed)\b/i,
];

export function findIncompleteApprovedBrowserSession(input: {
  results: readonly { toolName: string; content: string }[];
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly { name: string }[];
}): IncompleteApprovedBrowserSessionContinuation | null {
  const taskFacts = taskIntentFactsForPrompt(input.taskPrompt);
  if (!hasToolDefinition(input.tools, "sessions_send")) {
    return null;
  }
  if (hasIncompleteApprovedBrowserSessionContinuationPrompt(input.messages)) {
    return null;
  }
  if (!taskFacts.approvalGatedBrowserActionRequested) {
    return null;
  }
  if (taskFacts.approvedBrowserActionExecutionForbidden) {
    return null;
  }
  if (
    !readPolicyPermissionAppliedEvidence(input.toolTrace) &&
    !taskFacts.approvalAlreadyApplied
  ) {
    return null;
  }
  for (const result of input.results) {
    if (
      result.toolName !== "sessions_spawn" &&
      result.toolName !== "sessions_send"
    ) {
      continue;
    }
    const parsed = parseSessionToolResult(result.content);
    if (
      !parsed ||
      parsed.status !== "completed" ||
      parsed.agent_id !== "browser"
    ) {
      continue;
    }
    if (typeof parsed.session_key !== "string") {
      continue;
    }
    const sessionKey = parsed.session_key.trim();
    if (!sessionKey) {
      continue;
    }
    if (hasExecutedSessionsSend(input.toolTrace, sessionKey)) {
      continue;
    }
    const evidence = readCompletedSessionEvidence(parsed) ?? "";
    if (hasCompletedApprovedBrowserActionEvidence(evidence)) {
      continue;
    }
    if (!matchesAny(evidence, INCOMPLETE_APPROVED_BROWSER_ACTION_PATTERNS)) {
      continue;
    }
    return {
      sessionKey,
      evidence: sliceUtf8(evidence, 1400),
    };
  }
  return null;
}

function hasCompletedApprovedBrowserActionEvidence(evidence: string): boolean {
  const completedIndex = lastPatternMatchIndex(evidence, [
    /\b(?:approved action|approved browser\.form\.submit|browser\.form\.submit)\b[\s\S]{0,180}\b(?:completed|complete|triggered|executed|performed|submitted|exercised)\b/i,
    /\b(?:post[- ]submit|after approval|submitted locally after approval|dry-run submitted locally)\b[\s\S]{0,180}\b(?:verified|confirmed|marker|TURNKEYAI_APPROVAL_FIXTURE_OK|no external mutation)\b/i,
    /\b(?:submitted locally after approval|dry-run submitted locally after approval|approved dry-run submit completed)\b/i,
  ]);
  if (completedIndex < 0) {
    return false;
  }
  const incompleteIndex = lastPatternMatchIndex(
    evidence,
    INCOMPLETE_APPROVED_BROWSER_ACTION_PATTERNS,
  );
  return completedIndex >= incompleteIndex;
}

function lastPatternMatchIndex(text: string, patterns: readonly RegExp[]): number {
  let lastIndex = -1;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, flags);
    for (const match of text.matchAll(globalPattern)) {
      lastIndex = Math.max(lastIndex, match.index ?? -1);
    }
  }
  return lastIndex;
}

export function readPolicyPermissionAppliedEvidence(
  toolTrace: NativeToolRoundTrace[],
): boolean {
  if (readPolicyLatestPermissionToolName(toolTrace) === "permission_applied") {
    return true;
  }
  return toolTrace.some((round) =>
    (round.progress ?? []).some(
      (progress) => progress.detail?.["eventType"] === "permission.applied",
    ),
  );
}

export function readPolicyLatestPermissionToolName(
  toolTrace: NativeToolRoundTrace[],
): string | null {
  for (
    let roundIndex = toolTrace.length - 1;
    roundIndex >= 0;
    roundIndex -= 1
  ) {
    const round = toolTrace[roundIndex]!;
    for (
      let callIndex = round.calls.length - 1;
      callIndex >= 0;
      callIndex -= 1
    ) {
      const name = round.calls[callIndex]!.name;
      if (name.startsWith("permission_")) {
        return name;
      }
    }
  }
  return null;
}

export function readPolicyLatestPermissionResultStatus(
  toolTrace: NativeToolRoundTrace[],
): string | null {
  for (
    let roundIndex = toolTrace.length - 1;
    roundIndex >= 0;
    roundIndex -= 1
  ) {
    const round = toolTrace[roundIndex]!;
    for (
      let progressIndex = (round.progress?.length ?? 0) - 1;
      progressIndex >= 0;
      progressIndex -= 1
    ) {
      const progress = round.progress![progressIndex]!;
      if (
        progress.toolName === "permission_result" &&
        progress.detail?.["eventType"] === "permission.result"
      ) {
        const status = progress.detail["status"];
        if (typeof status === "string") return status;
      }
    }
    for (
      let resultIndex = round.results.length - 1;
      resultIndex >= 0;
      resultIndex -= 1
    ) {
      const result = round.results[resultIndex]!;
      if (result.toolName !== "permission_result") continue;
      const parsed = parseJsonObject(result.content);
      const status = parsed?.["status"];
      if (typeof status === "string") return status;
    }
  }
  return null;
}

export function readPolicyPendingApprovalWaitTimeoutCheckRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: readonly LLMMessage[];
  repairMarkers: readonly LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasPendingApprovalWaitTimeoutCheckRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !taskIntentFactsForPrompt(input.taskPrompt)
      .approvalWaitTimeoutCloseoutRequested
  ) {
    return false;
  }
  return readPolicyLatestPermissionToolName(input.toolTrace) === "permission_query";
}

function hasPendingApprovalWaitTimeoutCheckRepairPrompt(
  messages: readonly LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approval decision has not arrived",
      ),
  );
}

export function readPolicyPrematurePendingApprovalFinalRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: readonly LLMMessage[];
  repairMarkers: readonly LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  const taskFacts = taskIntentFactsForPrompt(input.taskPrompt);
  if (hasPrematurePendingApprovalRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !readPolicyPendingApprovalMention(input.resultText) ||
    !taskFacts.approvalGatedBrowserActionRequested
  ) {
    return false;
  }
  if (
    taskFacts.approvalWaitTimeoutCloseoutRequested ||
    taskFacts.stopAtPendingApprovalAllowed
  ) {
    return false;
  }
  if (
    readPolicyPermissionAppliedEvidence(input.toolTrace) ||
    taskFacts.approvalAlreadyApplied
  ) {
    return false;
  }
  if (hasSessionToolEvidence(input.toolTrace)) {
    return false;
  }
  return (
    readPolicyLatestPermissionToolName(input.toolTrace) === "permission_query" ||
    readPolicyLatestPermissionResultStatus(input.toolTrace) === "pending"
  );
}

function hasPrematurePendingApprovalRepairPrompt(
  messages: readonly LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approval-gated browser action is still pending",
      ),
  );
}

function hasSessionToolEvidence(toolTrace: NativeToolRoundTrace[]): boolean {
  return toolTrace.some(
    (round) =>
      round.calls.some(
        (call) => call.name === "sessions_spawn" || call.name === "sessions_send",
      ) ||
      round.results.some(
        (result) =>
          result.toolName === "sessions_spawn" ||
          result.toolName === "sessions_send",
      ),
  );
}

export function readPolicyPendingApprovalMention(text: string): boolean {
  return /\b(?:approval pending|approval is pending|approval is still pending|approval request is pending|approval request is still pending|permission is (?:now )?pending|permission request is pending|permission request is still pending|pending operator approval|pending operator decision|awaiting (?:decision|your decision|operator approval|operator decision|operator)|waiting for (?:your|operator) decision|waiting for operator|standby for (?:the )?decision|once you approve|after you approve|before (?:the )?(?:browser worker )?can)\b/i.test(
    text,
  );
}

export function readPolicyStalePendingApprovalRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: readonly LLMMessage[];
  repairMarkers: readonly LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  const taskFacts = taskIntentFactsForPrompt(input.taskPrompt);
  if (hasStalePendingApprovalRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !readPolicyPendingApprovalMention(input.resultText) ||
    (!taskFacts.approvalGatedBrowserActionRequested &&
      !taskFacts.appliedApprovalBrowserContinuation)
  ) {
    return false;
  }
  return (
    readPolicyPermissionAppliedEvidence(input.toolTrace) ||
    taskFacts.approvalAlreadyApplied ||
    taskFacts.appliedApprovalBrowserContinuation
  );
}

function hasStalePendingApprovalRepairPrompt(
  messages: readonly LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approval already applied",
      ),
  );
}

export function readPolicyStaleDeniedApprovalRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: readonly LLMMessage[];
  repairMarkers: readonly LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  const taskFacts = taskIntentFactsForPrompt(input.taskPrompt);
  if (hasStaleDeniedApprovalRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !readPolicyPendingApprovalMention(input.resultText) ||
    !taskFacts.approvalGatedBrowserActionRequested
  ) {
    return false;
  }
  return readPolicyLatestPermissionResultStatus(input.toolTrace) === "denied";
}

function hasStaleDeniedApprovalRepairPrompt(
  messages: readonly LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approval was denied",
      ),
  );
}

export function readPolicyApprovalWaitTimeoutCloseoutRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: readonly LLMMessage[];
  repairMarkers: readonly LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasApprovalWaitTimeoutCloseoutRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !taskIntentFactsForPrompt(input.taskPrompt)
      .approvalWaitTimeoutCloseoutRequested
  ) {
    return false;
  }
  if (!hasApprovalWaitTimeoutEvidence(input.toolTrace)) {
    return false;
  }
  return !looksLikeCompleteApprovalWaitTimeoutCloseout(input.resultText);
}

export function readPolicyForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: readonly LLMMessage[];
  repairMarkers: readonly LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (
    !taskIntentFactsForPrompt(input.taskPrompt)
      .approvalWaitTimeoutCloseoutRequested
  ) {
    return false;
  }
  if (!hasApprovalWaitTimeoutCloseoutRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!hasApprovalWaitTimeoutEvidence(input.toolTrace)) {
    return false;
  }
  return !looksLikeCompleteApprovalWaitTimeoutCloseout(input.resultText);
}

function hasApprovalWaitTimeoutEvidence(
  toolTrace: NativeToolRoundTrace[],
): boolean {
  if (readPolicyLatestPermissionResultStatus(toolTrace) === "pending") {
    return true;
  }
  return toolTrace.some((round) =>
    round.results.some((result) => {
      const parsed = parseJsonObject(result.content);
      return parsed?.["status"] === "approval_wait_timeout";
    }),
  );
}

function looksLikeCompleteApprovalWaitTimeoutCloseout(text: string): boolean {
  if (
    /\b(?:thread|flow|mission|task)\b[\s\S]{0,80}\b(?:remains?|stays?)\s+open\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return (
    /\b(?:approval|permission|operator decision)\b[\s\S]{0,180}\b(?:pending|did not arrive|still pending|timed out|timeout|wait[- ]timeout)\b/i.test(
      text,
    ) &&
    readPolicyPendingApprovalMention(text) &&
    /\b(?:did not|will not|was not|not|no)\s+(?:be\s+)?(?:submit(?:ted)?|apply|perform(?:ed)?|run|complete(?:d)?|execute(?:d)?|take|taken)|\b(?:action|side effect)\s+(?:not performed|did not run)\b|\bno (?:browser form submission|form submission|browser action|browser mutation|mutation|side effects?|state) (?:was |were )?(?:(?:or will be )?performed|executed|taken|applied|changed|mutated)\b|\bno form (?:was )?submitted\b/i.test(
      text,
    ) &&
    /\b(?:residual risk|risk|unverified|not verified|pending approval remains|pending decision remains)\b/i.test(
      text,
    ) &&
    /\b(?:next action|safest next step|safe fallback|ask the operator|retry|continue|re-?run|re-?initiate|flow is complete|closeout confirmed)\b/i.test(
      text,
    )
  );
}

function hasApprovalWaitTimeoutCloseoutRepairPrompt(
  messages: readonly LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approval wait-timeout evidence is available",
      ),
  );
}

export function readPolicyApprovalWaitTimeoutRuntimeEvidence(
  toolTrace: NativeToolRoundTrace[],
): string {
  const evidence: string[] = [];
  for (const round of toolTrace) {
    for (const result of round.results) {
      if (
        result.toolName !== "permission_query" &&
        result.toolName !== "permission_result"
      ) {
        continue;
      }
      if (!result.content) {
        continue;
      }
      evidence.push(`${result.toolName}: ${sliceUtf8(result.content, 1200)}`);
    }
  }
  return evidence.length
    ? evidence.join("\n")
    : "permission_query/permission_result evidence shows the approval request remains pending.";
}

export function readPolicyIncompleteApprovedBrowserActionRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: readonly LLMMessage[];
  repairMarkers: readonly LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  const taskFacts = taskIntentFactsForPrompt(input.taskPrompt);
  if (hasIncompleteApprovedBrowserActionRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !taskFacts.approvalGatedBrowserActionRequested &&
    !taskFacts.appliedApprovalBrowserContinuation
  ) {
    return false;
  }
  if (taskFacts.approvedBrowserActionExecutionForbidden) {
    return false;
  }
  if (
    !readPolicyPermissionAppliedEvidence(input.toolTrace) &&
    !taskFacts.approvalAlreadyApplied
  ) {
    return false;
  }
  return matchesAny(
    input.resultText,
    INCOMPLETE_APPROVED_BROWSER_ACTION_PATTERNS,
  );
}

function hasIncompleteApprovedBrowserActionRepairPrompt(
  messages: readonly LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approved browser action has not executed",
      ),
  );
}

export function latestPendingPermissionQueryApprovalId(
  toolTrace: NativeToolRoundTrace[],
): string | null {
  for (
    let roundIndex = toolTrace.length - 1;
    roundIndex >= 0;
    roundIndex -= 1
  ) {
    const round = toolTrace[roundIndex]!;
    for (
      let progressIndex = (round.progress?.length ?? 0) - 1;
      progressIndex >= 0;
      progressIndex -= 1
    ) {
      const progress = round.progress![progressIndex]!;
      if (
        progress.toolName !== "permission_query" ||
        progress.detail?.["eventType"] !== "permission.query"
      ) {
        continue;
      }
      const status = progress.detail["status"];
      if (typeof status === "string" && status !== "pending") {
        continue;
      }
      const approvalId = readApprovalId(progress.detail);
      if (approvalId) return approvalId;
    }
    for (
      let resultIndex = round.results.length - 1;
      resultIndex >= 0;
      resultIndex -= 1
    ) {
      const result = round.results[resultIndex]!;
      if (result.toolName !== "permission_query") continue;
      const parsed = parseJsonObject(result.content);
      if (!parsed) continue;
      const status = parsed["status"];
      if (typeof status === "string" && status !== "pending") {
        continue;
      }
      const approvalId = readApprovalId(parsed);
      if (approvalId) return approvalId;
    }
  }
  return null;
}

function readApprovalId(value: Record<string, unknown> | undefined): string | null {
  if (!value) return null;
  const direct = value["approval_id"] ?? value["approvalId"];
  return typeof direct === "string" && direct.trim().length > 0
    ? direct.trim()
    : null;
}

export function allowsSupplementalBrowserProbe(packet: RolePromptPacket): boolean {
  const unavailable =
    packet.capabilityInspection?.unavailableCapabilities ?? [];
  return !unavailable.some((capability) => /\bbrowser\b/i.test(capability));
}

export function findSessionContinuationDirective(
  taskPrompt: string,
): SessionContinuationDirective | null {
  let latestUserText = extractLatestUserContinuationText(taskPrompt);
  if (!isExplicitSessionContinuationRequest(latestUserText)) {
    if (!readPolicyForceSlowSourceRecoveryContinuation(taskPrompt)) {
      return null;
    }
    latestUserText =
      "Continue the same slow-source source-check context after the previous timeout. Resume the existing source-check session.";
  }
  if (!isExplicitSessionContinuationRequest(latestUserText)) {
    return null;
  }
  if (sessionContinuationRequestForbidsSessionTools(latestUserText)) {
    return null;
  }
  const messageHint = buildSessionContinuationMessageHint(
    taskPrompt,
    latestUserText,
  );
  const continuationLabel = extractSessionContinuationLabel(latestUserText);
  const sessionResults = extractSessionToolResultRecords(taskPrompt);
  let selectedSessionKey: string | null = null;
  let selectedPriority = 0;
  const preferEarliestSession =
    continuationRequestPrefersEarliestSession(latestUserText);
  for (let index = sessionResults.length - 1; index >= 0; index -= 1) {
    const result = sessionResults[index]!;
    const sessionKey = result["session_key"];
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      continue;
    }
    const priority = sessionToolResultContinuationPriority(
      result,
      latestUserText,
    );
    if (priority <= selectedPriority) {
      if (
        !(
          preferEarliestSession &&
          selectedSessionKey &&
          priority === selectedPriority
        )
      ) {
        continue;
      }
    }
    if (!preferEarliestSession && priority <= selectedPriority) {
      continue;
    }
    selectedSessionKey = sessionKey.trim();
    selectedPriority = priority;
  }
  if (selectedSessionKey) {
    const listedResolvedSessionKey = resolveListedSessionKeyFromPrefix(
      taskPrompt,
      selectedSessionKey,
    );
    if (listedResolvedSessionKey) {
      return {
        sessionKey: listedResolvedSessionKey,
        messageHint,
        ...(continuationLabel ? { label: continuationLabel } : {}),
      };
    }
    if (
      extractLikelyTruncatedTimeoutSessionKeyPrefixes(
        taskPrompt,
        latestUserText,
      ).some(
        (prefix) =>
          relaxedSessionKeySignature(selectedSessionKey).startsWith(prefix) ||
          prefix.startsWith(relaxedSessionKeySignature(selectedSessionKey)),
      )
    ) {
      return null;
    }
    if (
      selectedPriority < 3 &&
      continuationRequestPrefersResumableSession({
        latestUserText,
        context: taskPrompt,
      })
    ) {
      return null;
    }
    return {
      sessionKey: selectedSessionKey,
      messageHint,
      ...(continuationLabel ? { label: continuationLabel } : {}),
    };
  }
  const explicitSessionKey = selectExplicitContinuationSessionKey(
    taskPrompt,
    latestUserText,
  );
  if (explicitSessionKey) {
    return {
      sessionKey: explicitSessionKey,
      messageHint,
      ...(continuationLabel ? { label: continuationLabel } : {}),
    };
  }
  const listedSession = selectListedContinuationSessionKey(
    taskPrompt,
    latestUserText,
  );
  const hasTruncatedTimeoutCandidate =
    contextHasTruncatedTimeoutContinuationCandidate(taskPrompt, latestUserText);
  if (
    listedSession &&
    !(hasTruncatedTimeoutCandidate && listedSession.priority < 3)
  ) {
    return {
      sessionKey: listedSession.sessionKey,
      messageHint,
      ...(continuationLabel ? { label: continuationLabel } : {}),
    };
  }
  if (hasTruncatedTimeoutCandidate) {
    return null;
  }
  const sessionMatches = [
    ...taskPrompt.matchAll(/"session_key"\s*:\s*"([^"]+)"/g),
  ];
  for (let index = sessionMatches.length - 1; index >= 0; index -= 1) {
    const match = sessionMatches[index]!;
    const sessionKey = match[1];
    if (!sessionKey) continue;
    const start = Math.max(0, (match.index ?? 0) - 1200);
    const end = Math.min(taskPrompt.length, (match.index ?? 0) + 1200);
    const context = taskPrompt.slice(start, end);
	    if (!sessionContextSupportsContinuation(context)) {
	      continue;
	    }
	    const priority = explicitSessionContinuationPriority(
	      sessionKey,
	      context,
	      latestUserText,
	    );
	    if (
	      priority <= 0 ||
	      (priority < 3 &&
	        continuationRequestPrefersResumableSession({
	          latestUserText,
	          context: taskPrompt,
	        }))
	    ) {
	      continue;
	    }
	    return {
	      sessionKey,
	      messageHint,
	      ...(continuationLabel ? { label: continuationLabel } : {}),
	    };
  }
  return null;
}

function extractSessionContinuationLabel(latestUserText: string): string | null {
  const patterns = [
    /\bsessions_send\s+input\s+must\s+include\s+label\s+["“]([^"”\n]+)["”]/i,
    /\bsessions_send\b[\s\S]{0,180}\blabel\s*[:=]\s*["“]([^"”\n]+)["”]/i,
    /\blabel\s+["“]([^"”\n]+)["”]\s+for\s+sessions_send\b/i,
  ];
  for (const pattern of patterns) {
    const label = latestUserText.match(pattern)?.[1]?.trim();
    if (label) {
      return sliceUtf8(label, 120);
    }
  }
  return null;
}

export function continuationRequestPrefersEarliestSession(
  latestUserText: string,
): boolean {
  return /\b(?:previous|prior|earlier|original|initial|same)\b[\s\S]{0,160}\b(?:thread|session|research|work|notes|context)\b|\b(?:rather than|instead of)\b[\s\S]{0,120}\b(?:starting|start)\b[\s\S]{0,80}\bfrom scratch\b/i.test(
    latestUserText,
  );
}

export function continuationRequestPrefersResumableSession(input: {
  latestUserText: string;
  context: string;
}): boolean {
  if (
    /\b(?:timeout|timed out|resumable|interrupted|cancelled|canceled|slow-source|slow source|source-check)\b/i.test(
      input.latestUserText,
    )
  ) {
    return true;
  }
  if (
    !/\b(?:timeout|timed out|WORKER_TIMEOUT|resumable|interrupted|cancelled|canceled)\b/i.test(
      input.context,
    )
  ) {
    return false;
  }
  return /\b(?:same|existing|previous|prior|attempt|source|retry|resume|continue)\b/i.test(
    input.latestUserText,
  );
}

export function findSessionContinuationLookupDirective(
  taskPrompt: string,
  context: string,
): SessionContinuationLookupDirective | null {
  let latestUserText = extractLatestUserContinuationText(taskPrompt);
  if (!isExplicitSessionContinuationRequest(latestUserText)) {
    if (!readPolicyForceSlowSourceRecoveryContinuation(context)) {
      return null;
    }
    latestUserText =
      "Continue the same slow-source source-check context after the previous timeout. Resume the existing source-check session.";
  }
  if (!isExplicitSessionContinuationRequest(latestUserText)) {
    return null;
  }
  if (sessionContinuationRequestForbidsSessionTools(latestUserText)) {
    return null;
  }
  if (contextHasSessionListResult(context)) {
    return contextHasTruncatedTimeoutContinuationCandidate(
      context,
      latestUserText,
    )
      ? {
          messageHint: buildSessionContinuationMessageHint(
            taskPrompt,
            latestUserText,
          ),
          ...optionalLookupAgentId(context, latestUserText),
        }
      : null;
  }
  return {
    messageHint: buildSessionContinuationMessageHint(
      taskPrompt,
      latestUserText,
    ),
    ...optionalLookupAgentId(context, latestUserText),
  };
}

function optionalLookupAgentId(
  context: string,
  latestUserText: string,
): { agentId: string } | {} {
  const agentId = inferSessionContinuationLookupAgentId(
    context,
    latestUserText,
  );
  return agentId ? { agentId } : {};
}

function inferSessionContinuationLookupAgentId(
  context: string,
  latestUserText: string,
): string | null {
  let selectedAgentId: string | null = null;
  let selectedPriority = 0;
  for (const result of extractSessionToolResultRecords(context)) {
    const agentId = result["agent_id"];
    if (typeof agentId !== "string" || !agentId.trim()) {
      continue;
    }
    const priority = sessionToolResultContinuationPriority(
      result,
      latestUserText,
    );
    if (priority > selectedPriority) {
      selectedAgentId = agentId.trim();
      selectedPriority = priority;
    }
  }
  if (selectedAgentId) {
    return selectedAgentId;
  }
  if (
    /\b(?:slow-source|slow source|source-check|source check|release-risk|release risk)\b/i.test(
      latestUserText,
    ) &&
    /"agent_id"\s*:\s*"explore"/i.test(context)
  ) {
    return "explore";
  }
  if (
    /\b(?:browser|dashboard|rendered|visual|page)\b/i.test(latestUserText) &&
    /"agent_id"\s*:\s*"browser"/i.test(context)
  ) {
    return "browser";
  }
  return null;
}

export function readPolicyForceSlowSourceRecoveryContinuation(context: string): boolean {
  return (
    /\bSystem recovery:\s*the previous final answer did not satisfy required goal slots\b/i.test(
      context,
    ) &&
    taskIntentFactsForPrompt(context).sourceCheckContinuationRequested &&
    contextHasTimeoutSessionResult(context) &&
    /\b(?:Resume or retry the same slow source-check context|same source-check context|required release-risk slots|release-risk slots)\b/i.test(
      context,
    )
  );
}

export function sessionContextSupportsContinuation(context: string): boolean {
  if (
    /\b(timeout|timed out|WORKER_TIMEOUT|resumable|interrupted|cancelled|canceled)\b/i.test(
      context,
    )
  ) {
    return true;
  }
  if (contextHasListedContinuableSession(context)) {
    return true;
  }
  for (const result of extractSessionToolResultRecords(context)) {
    if (sessionToolResultSupportsContinuation(result)) {
      return true;
    }
  }
  return false;
}

export function contextHasTimeoutSessionResult(context: string): boolean {
  return extractSessionToolResultRecords(context).some(
    (result) => result["status"] === "timeout",
  );
}

export function shouldCloseoutCancelledSessionWithoutContinuation(input: {
  taskPrompt: string;
  messages: LLMMessage[];
}): boolean {
  const context = buildContinuationDirectiveContext(
    input.taskPrompt,
    input.messages,
  );
  if (!contextHasCancelledSessionResult(context)) {
    return false;
  }
  return !isExplicitSessionContinuationRequest(
    extractLatestUserContinuationText(input.taskPrompt),
  );
}

function contextHasCancelledSessionResult(context: string): boolean {
  return extractSessionToolResultRecords(context).some(
    (result) => result["status"] === "cancelled",
  );
}

export function contextHasSessionListResult(context: string): boolean {
  return parseJsonObjectsFromContext(context).some((parsed) => {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    return Array.isArray((parsed as Record<string, unknown>)["sessions"]);
  });
}

export function contextHasListedContinuableSession(context: string): boolean {
  for (const parsed of parseJsonObjectsFromContext(context)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const sessions = (parsed as Record<string, unknown>)["sessions"];
    if (!Array.isArray(sessions)) {
      continue;
    }
    if (
      sessions.some((session) => {
        if (!session || typeof session !== "object" || Array.isArray(session)) {
          return false;
        }
        const record = session as Record<string, unknown>;
        const status = record["status"];
        return (
          typeof record["session_key"] === "string" &&
          typeof status === "string" &&
          /^(?:done|completed|resumable|timeout|cancelled|failed)$/.test(status)
        );
      })
    ) {
      return true;
    }
  }
  return false;
}

export function selectListedContinuationSessionKey(
  context: string,
  latestUserText: string,
): { sessionKey: string; priority: number } | null {
  let selected: {
    sessionKey: string;
    priority: number;
    lastActiveAt: number;
    createdAt: number;
    subjectMatched: boolean;
  } | null = null;
  const preferEarliestSubjectSession =
    continuationRequestPrefersEarliestSession(latestUserText) &&
    !continuationRequestPrefersResumableSession({
      latestUserText,
      context: latestUserText,
    });
  const truncatedTimeoutPrefixes =
    extractLikelyTruncatedTimeoutSessionKeyPrefixes(context, latestUserText);
  for (const parsed of parseJsonObjectsFromContext(context)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const sessions = (parsed as Record<string, unknown>)["sessions"];
    if (!Array.isArray(sessions)) {
      continue;
    }
    for (const session of sessions) {
      if (!session || typeof session !== "object" || Array.isArray(session)) {
        continue;
      }
      const record = session as Record<string, unknown>;
      const sessionKey =
        typeof record["session_key"] === "string"
          ? record["session_key"].trim()
          : "";
      let priority = listedSessionContinuationPriority(
        record,
        latestUserText,
      );
      if (
        sessionKey &&
        truncatedTimeoutPrefixes.some((prefix) =>
          relaxedSessionKeySignature(sessionKey).startsWith(prefix),
        )
      ) {
        priority = Math.max(priority, 6);
      }
      if (!sessionKey || priority <= 0) {
        continue;
      }
      const relevanceText = [
        typeof record["agent_id"] === "string" ? record["agent_id"] : "",
        typeof record["label"] === "string" ? record["label"] : "",
      ].join(" ");
      const subjectMatched = continuationTextMatchesSubject(
        relevanceText,
        latestUserText,
      );
      const createdAt = readListedSessionCreatedAt(record, sessionKey);
      const lastActiveAt =
        typeof record["last_active_at"] === "number"
          ? record["last_active_at"]
          : 0;
      if (preferEarliestSubjectSession && subjectMatched) {
        if (
          !selected ||
          !selected.subjectMatched ||
          createdAt < selected.createdAt ||
          (createdAt === selected.createdAt && priority > selected.priority)
        ) {
          selected = {
            sessionKey,
            priority,
            lastActiveAt,
            createdAt,
            subjectMatched,
          };
        }
        continue;
      }
      if (preferEarliestSubjectSession && selected?.subjectMatched) {
        continue;
      }
      if (
        !selected ||
        priority > selected.priority ||
        (priority === selected.priority &&
          lastActiveAt >= selected.lastActiveAt)
      ) {
        selected = {
          sessionKey,
          priority,
          lastActiveAt,
          createdAt,
          subjectMatched,
        };
      }
    }
  }
  return selected
    ? { sessionKey: selected.sessionKey, priority: selected.priority }
    : null;
}

function readListedSessionCreatedAt(
  record: Record<string, unknown>,
  sessionKey: string,
): number {
  const createdAt = record["created_at"];
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
    return createdAt;
  }
  const match = sessionKey.match(/\bTASK-(\d{8,})\b/);
  return match?.[1] ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function resolveListedSessionKeyFromPrefix(
  context: string,
  sessionKey: string,
): string | null {
  const signature = relaxedSessionKeySignature(sessionKey);
  if (signature.length < 24) {
    return null;
  }
  const matches: string[] = [];
  for (const parsed of parseJsonObjectsFromContext(context)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const sessions = (parsed as Record<string, unknown>)["sessions"];
    if (!Array.isArray(sessions)) {
      continue;
    }
    for (const session of sessions) {
      if (!session || typeof session !== "object" || Array.isArray(session)) {
        continue;
      }
      const candidate = (session as Record<string, unknown>)["session_key"];
      if (typeof candidate !== "string" || !candidate.trim()) {
        continue;
      }
      const candidateSignature = relaxedSessionKeySignature(candidate.trim());
      if (candidateSignature === signature) {
        return candidate.trim();
      }
      if (candidateSignature.startsWith(signature)) {
        matches.push(candidate.trim());
      }
    }
  }
  return [...new Set(matches)].length === 1 ? matches[0]! : null;
}

export function extractLikelyTruncatedTimeoutSessionKeyPrefixes(
  context: string,
  latestUserText: string,
): string[] {
  if (
    !continuationRequestPrefersResumableSession({
      latestUserText,
      context,
    }) ||
    !/\b(?:timeout|timed out|WORKER_TIMEOUT)\b/i.test(context)
  ) {
    return [];
  }
  const prefixes: string[] = [];
  const matches = [
    ...context.matchAll(
      /(?:"session_key"\s*:\s*"|session not found:\s*)(worker:[A-Za-z0-9_-]+:task(?::|-)[^\s"',|}\]\n]+)/gi,
    ),
  ];
  for (const match of matches) {
    const rawKey = match[1]?.trim();
    if (!rawKey) continue;
    const matchedText = match[0] ?? "";
    const ellipsized = /…|\.{3}/.test(rawKey);
    const notFoundPrefix = /^session not found:/i.test(matchedText);
    const likelyToolCallPrefix =
      /\bcall_(?:function_|func_)?[A-Za-z0-9]+$/i.test(rawKey) &&
      !/_\d+$/.test(rawKey);
    if (!ellipsized && !notFoundPrefix && !likelyToolCallPrefix) {
      continue;
    }
    const signature = relaxedSessionKeySignature(rawKey);
    const ellipsizedPrefix = readTruncatedSessionKeyPrefix(signature);
    const prefix = ellipsizedPrefix ?? (signature.length >= 24 ? signature : null);
    if (prefix) {
      prefixes.push(prefix);
    }
  }
  return [...new Set(prefixes)];
}

export function selectExplicitContinuationSessionKey(
  context: string,
  latestUserText: string,
): string | null {
  let selected: { sessionKey: string; priority: number; index: number } | null =
    null;
  const matches = [
    ...context.matchAll(/\bworker:[A-Za-z0-9_-]+:task(?::|-)[^\s"'`,|}\]]+/g),
  ];
  for (const match of matches) {
    const sessionKey = match[0];
    if (!sessionKey || /(?:…|\.{3})/.test(sessionKey)) {
      continue;
    }
    const index = match.index ?? 0;
    const local = context.slice(
      Math.max(0, index - 800),
      Math.min(context.length, index + 800),
    );
    if (
      /"session_key"\s*:\s*"/.test(
        context.slice(Math.max(0, index - 40), index),
      )
    ) {
      continue;
    }
    const priority = explicitSessionContinuationPriority(
      sessionKey,
      local,
      latestUserText,
    );
    if (priority <= 0) {
      continue;
    }
    if (
      !selected ||
      priority > selected.priority ||
      (priority === selected.priority && index > selected.index)
    ) {
      selected = { sessionKey, priority, index };
    }
  }
  return selected?.sessionKey ?? null;
}

export function explicitSessionContinuationPriority(
  sessionKey: string,
  localContext: string,
  latestUserText: string,
): number {
  if (
    !/\b(?:resume|continue|continuation|timed out|timeout|resumable|interrupted|source-check|source check)\b/i.test(
      localContext,
    )
  ) {
    return 0;
  }
  let priority = 1;
  const agentId = readPolicyWorkerKindFromSessionKey(sessionKey) ?? "";
  if (
    continuationRequestRequiresBrowserEvidence(latestUserText) &&
    agentId !== "browser"
  ) {
    return 0;
  }
  if (/\b(?:timeout|timed out|WORKER_TIMEOUT)\b/i.test(localContext)) {
    priority += 3;
  }
  if (
    /\b(?:resume|continue|continuation|same|existing)\b/i.test(localContext)
  ) {
    priority += 2;
  }
  if (
    agentId === "explore" &&
    /\b(?:slow-source|slow source|source-check|source check|source|research|release-risk|release risk)\b/i.test(
      latestUserText,
    )
  ) {
    priority += 3;
  }
  if (
    agentId === "browser" &&
    /\b(?:browser|dashboard|page|tab|rendered|visual)\b/i.test(latestUserText)
  ) {
    priority += 2;
  }
  if (
    agentId === "browser" &&
    continuationRequestTargetsResearchThread(latestUserText) &&
    !continuationRequestTargetsBrowser(latestUserText)
  ) {
    priority -= 4;
  }
  return priority;
}

export function listedSessionContinuationPriority(
  record: Record<string, unknown>,
  latestUserText: string,
): number {
  const status = typeof record["status"] === "string" ? record["status"] : "";
  const agentId =
    typeof record["agent_id"] === "string" ? record["agent_id"] : "";
  const label = typeof record["label"] === "string" ? record["label"] : "";
  if (
    continuationRequestRequiresBrowserEvidence(latestUserText) &&
    agentId !== "browser"
  ) {
    return 0;
  }
  let priority = 0;
  if (status === "timeout") {
    priority = 5;
  } else if (
    status === "resumable" ||
    status === "waiting_input" ||
    status === "waiting_external"
  ) {
    priority = 3;
  } else if (status === "cancelled" || status === "canceled") {
    priority = 3;
  } else if (
    status === "failed" &&
    /\b(?:continue|resume|retry|cancelled|canceled|source-check|source check|release-risk|release risk)\b/i.test(
      latestUserText,
    )
  ) {
    priority = 2;
  } else if (status === "done" || status === "completed") {
    priority = 1;
  }
  if (priority === 0) {
    return 0;
  }
  const relevanceText = `${agentId} ${label}`;
  if (
    /\b(?:slow-source|slow source|source-check|source check|source|research|release-risk|release risk)\b/i.test(
      latestUserText,
    )
  ) {
    if (agentId === "explore") {
      priority += 3;
    }
    if (/\b(?:slow|source|fetch|research|risk)\b/i.test(label)) {
      priority += 2;
    }
  }
  if (
    /\b(?:browser|dashboard|page|tab|rendered|visual)\b/i.test(
      latestUserText,
    ) &&
    agentId === "browser"
  ) {
    priority += 2;
  }
  if (
    /\b(?:slow-source|slow source|source-check|source check)\b/i.test(
      latestUserText,
    ) &&
    /\bbrowser\b/i.test(relevanceText)
  ) {
    priority -= 1;
  }
  if (
    agentId === "browser" &&
    continuationRequestTargetsResearchThread(latestUserText) &&
    !continuationRequestTargetsBrowser(latestUserText)
  ) {
    priority -= 4;
  }
  if (continuationTextMatchesSubject(relevanceText, latestUserText)) {
    priority += 4;
  }
  return priority;
}

export function contextHasTruncatedTimeoutContinuationCandidate(
  context: string,
  latestUserText: string,
): boolean {
  if (
    !continuationRequestPrefersResumableSession({
      latestUserText,
      context,
    })
  ) {
    return false;
  }
  const truncatedWorkerKey =
    /"session_key"\s*:\s*"worker:[^"]*(?:…|\.{3})[^"]*"/i;
  if (!truncatedWorkerKey.test(context)) {
    return false;
  }
  return /\b(?:timeout|timed out|WORKER_TIMEOUT)\b/i.test(context);
}

export function extractSessionToolResultRecords(
  context: string,
): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const parsed of parseJsonObjectsFromContext(context)) {
    readPolicySessionToolResultRecords(parsed, records);
  }
  return records;
}

export function readPolicySessionToolResultRecords(
  value: unknown,
  records: Array<Record<string, unknown>>,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const result = value as Record<string, unknown>;
  if (result["protocol"] === SESSION_TOOL_RESULT_PROTOCOL) {
    records.push(result);
  }
  for (const key of ["content", "resultContent"]) {
    const nested = result[key];
    if (
      typeof nested !== "string" ||
      !nested.includes(SESSION_TOOL_RESULT_PROTOCOL)
    ) {
      continue;
    }
    for (const parsed of parseJsonObjectsFromContext(nested)) {
      readPolicySessionToolResultRecords(parsed, records);
    }
  }
}

export function sessionToolResultSupportsContinuation(
  result: Record<string, unknown>,
): boolean {
  return sessionToolResultContinuationPriority(result) > 0;
}

export function sessionToolResultContinuationPriority(
  result: Record<string, unknown>,
  latestUserText = "",
): number {
  if (result["protocol"] !== SESSION_TOOL_RESULT_PROTOCOL) {
    return 0;
  }
  let priority = 0;
  if (
    result["status"] === "timeout" ||
    result["status"] === "cancelled" ||
    result["resumable"] === true
  ) {
    priority = result["status"] === "timeout" ? 4 : 3;
  } else if (result["status"] === "completed") {
    priority = 1;
  }
  if (priority === 0) {
    return 0;
  }
  const agentId =
    typeof result["agent_id"] === "string" ? result["agent_id"] : "";
  if (
    continuationRequestRequiresBrowserEvidence(latestUserText) &&
    agentId !== "browser"
  ) {
    return 0;
  }
  if (
    result["status"] === "timeout" &&
    /\b(?:timeout|timed out|slow-source|slow source|source-check|source check)\b/i.test(
      latestUserText,
    )
  ) {
    priority += 3;
  }
  if (
    agentId === "explore" &&
    /\b(?:slow-source|slow source|source-check|source check|source|research)\b/i.test(
      latestUserText,
    )
  ) {
    priority += 2;
  }
  if (
    agentId === "browser" &&
    /\b(?:browser|dashboard|page|tab|rendered|visual)\b/i.test(latestUserText)
  ) {
    priority += 2;
  }
  if (
    agentId === "browser" &&
    continuationRequestTargetsResearchThread(latestUserText) &&
    !continuationRequestTargetsBrowser(latestUserText)
  ) {
    priority -= 4;
  }
  if (
    result["status"] === "cancelled" &&
    /\b(?:cancelled|canceled)\b/i.test(latestUserText)
  ) {
    priority += 3;
  }
  if (
    continuationTextMatchesSubject(
      sessionToolResultRelevanceText(result),
      latestUserText,
    )
  ) {
    priority += 4;
  }
  return priority;
}

export function continuationRequestTargetsResearchThread(latestUserText: string): boolean {
  return /\b(?:research|source|vendor|provider|notes|thread|work|evidence|comparison)\b|研究|来源|供应商|证据|对比|比较/i.test(
    latestUserText,
  );
}

export function continuationRequestTargetsBrowser(latestUserText: string): boolean {
  return /\b(?:browser|dashboard|page|tab|rendered|visual|screenshot|form|submit)\b|浏览器|页面|仪表盘|截图|渲染/i.test(
    latestUserText,
  );
}

export function continuationRequestRequiresBrowserEvidence(
  latestUserText: string,
): boolean {
  return /\b(?:rendered browser evidence|browser[- ]rendered evidence|browser-visible evidence|browser visible evidence|rendered evidence|browser evidence|visible page evidence|screenshot|snapshot)\b|浏览器证据|渲染证据|页面可见证据|截图|快照/i.test(
    latestUserText,
  );
}

export function sessionToolResultRelevanceText(
  result: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const key of [
    "agent_id",
    "label",
    "result",
    "final_content",
    "summary",
    "task",
  ]) {
    const value = result[key];
    if (typeof value === "string") {
      parts.push(value);
    }
  }
  const payload = result["payload"];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const key of ["label", "summary", "content", "result"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string") {
        parts.push(value);
      }
    }
  }
  return parts.join("\n");
}

export function continuationTextMatchesSubject(
  candidateText: string,
  latestUserText: string,
): boolean {
  const candidate = candidateText.toLowerCase();
  if (!candidate.trim()) return false;
  return continuationSubjectPhrases(latestUserText).some((phrase) =>
    candidate.includes(phrase.toLowerCase()),
  );
}

export function continuationSubjectPhrases(text: string): string[] {
  const phrases = new Set<string>();
  for (const match of text.matchAll(/[`"“]([^`"”]{3,80})[`"”]/g)) {
    addContinuationSubjectPhrase(phrases, match[1] ?? "");
  }
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[- ][A-Z][A-Za-z0-9]*)+\b/g)) {
    addContinuationSubjectPhrase(phrases, match[0]);
  }
  for (const match of text.matchAll(/\b(?:Vendor|Provider|Project|Source|Researcher|Team|Customer)\s+[A-Z][A-Za-z0-9_-]+\b/g)) {
    addContinuationSubjectPhrase(phrases, match[0]);
  }
  return [...phrases];
}

export function addContinuationSubjectPhrase(
  phrases: Set<string>,
  rawPhrase: string,
): void {
  const phrase = rawPhrase
    .replace(/\b(?:same|previous|prior|existing|earlier|research|thread|notes|work|source|session)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (phrase.length < 4) return;
  if (/^(?:continue|resume|revisit|follow up|product lead)$/i.test(phrase)) {
    return;
  }
  if (phrase.split(/\s+/).length > 6) return;
  phrases.add(phrase);
}

export function parseJsonObjectsFromContext(context: string): unknown[] {
  const parsed: unknown[] = [];
  for (let index = 0; index < context.length; index += 1) {
    if (context[index] !== "{") {
      continue;
    }
    const end = findJsonObjectEnd(context, index);
    if (end === null) {
      continue;
    }
    try {
      parsed.push(JSON.parse(context.slice(index, end + 1)));
      index = end;
    } catch {
      // The context window may start or end inside a JSON blob. Keep scanning
      // for the next balanced object instead of falling back to raw status text.
    }
  }
  return parsed;
}

export function findJsonObjectEnd(context: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < context.length; index += 1) {
    const char = context[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

export function isExplicitSessionContinuationRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (
    !/\b(continue|continuation|resume|retry|revisit|follow-?up)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /\b(?:follow-?up|later|afterward|afterwards|future)\b.{0,120}\b(?:may|might|can|could|should)\s+(?:ask|request)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /\b(?:may|might|can|could|should)\s+(?:ask|request)\b.{0,120}\b(?:continue|resume|retry|revisit|follow-?up)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /^(?:please\s+)?(?:continue|resume|retry|revisit|follow-?up)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return /\b(?:continue|resume|retry|revisit)\s+(?:from|the|that|this|same|existing|previous|prior)\b/i.test(
    normalized,
  );
}

export function sessionContinuationRequestForbidsSessionTools(text: string): boolean {
  return (
    /\bdo\s+not\s+call\s+sessions_(?:send|spawn)\b/i.test(text) ||
    /\brewrit(?:e|ing)\s+the\s+final\s+answer\s+from\s+existing\b[\s\S]{0,120}\bevidence\s+only\b/i.test(
      text,
    )
  );
}

export function extractLatestUserContinuationText(taskPrompt: string): string {
  const verbatimDirection = extractVerbatimGoalDirection(taskPrompt);
  if (verbatimDirection) {
    return sliceUtf8(
      verbatimDirection.replace(/\s+/g, " ").trim(),
      1200,
    );
  }
  const lines = taskPrompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const latestUserLine = [...lines]
    .reverse()
    .find((line) => /^\[?user\]?(?:[:：]|\s+)/i.test(line));
  const hasSessionContinuationContext =
    extractSessionToolResultRecords(taskPrompt).length > 0 ||
    /"session_key"\s*:|worker:[A-Za-z0-9_-]+:task(?::|-)/.test(taskPrompt);
  const continuationLineIndex = latestUserLine
    ? -1
    : !hasSessionContinuationContext
      ? -1
    : (() => {
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          if (isExplicitSessionContinuationRequest(lines[index]!)) {
            return index;
          }
        }
        return -1;
      })();
  const content = latestUserLine
    ? latestUserLine.replace(/^\[?user\]?(?:[:：]|\s+)\s*/i, "")
    : continuationLineIndex >= 0
      ? lines.slice(continuationLineIndex).join("\n")
    : (lines.at(-1) ?? taskPrompt);
  return sliceUtf8(
    content.replace(/\s+/g, " ").trim() ||
      "Continue the same delegated work from the existing session.",
    1200,
  );
}

export function extractVerbatimGoalDirection(taskPrompt: string): string | null {
  const latest = extractVerbatimGoalSection(
    taskPrompt,
    "Latest user direction",
  );
  if (latest) {
    return latest;
  }
  return extractVerbatimGoalSection(taskPrompt, "Original user goal");
}

export function extractVerbatimGoalSection(
  taskPrompt: string,
  sectionLabel: "Latest user direction" | "Original user goal",
): string | null {
  const match = taskPrompt.match(
    new RegExp(
      `(?:^|\\n)\\s*${escapeRegExp(sectionLabel)}\\s*\\(verbatim\\):\\s*\\n([\\s\\S]*?)(?=\\n\\s*(?:Latest user direction|Original user goal)\\s*\\(verbatim\\):|\\n\\s*(?:\\[truncated\\]|The goal above is binding:|Task brief:|Recent turns:|Role scratchpad:|Retrieved memory:|Worker evidence:|Prior tool session evidence|Execution continuity:|Output contract:)\\b|$)`,
      "i",
    ),
  );
  const content = match?.[1]?.trim();
  return content ? content : null;
}

export function extractPriorContinuationContext(
  taskPrompt: string,
  latestUserText: string,
): string {
  const latestIndex = taskPrompt.lastIndexOf(latestUserText);
  const priorRaw =
    latestIndex > 0 ? taskPrompt.slice(0, latestIndex) : taskPrompt;
  const compact = priorRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[?tool\]?[:：\s]/i.test(line))
    .filter((line) => !line.includes(SESSION_TOOL_RESULT_PROTOCOL))
    .filter((line) => !/^\{.*"session_key".*\}$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return sliceUtf8(compact, 1600);
}

function buildSessionContinuationMessageHint(
  taskPrompt: string,
  latestUserText: string,
): string {
  const priorContext = extractPriorContinuationContext(
    taskPrompt,
    latestUserText,
  );
  if (!priorContext) {
    return latestUserText;
  }
  return [
    latestUserText,
    "",
    "Continuation context from the original task:",
    priorContext,
    "",
    "Preserve the original task's decision criteria, required dimensions, entity names, source labels, and user terminology from that context unless the latest user message explicitly changes scope.",
  ].join("\n");
}

export function normalizeExplicitContinuationHistoryCalls(
  toolCalls: LLMToolCall[],
  taskPrompt: string,
): LLMToolCall[] {
  if (
    !taskIntentFactsForPrompt(taskPrompt).explicitSessionContinuationRequested ||
    readPolicySessionTranscriptRequest(taskPrompt)
  ) {
    return toolCalls;
  }
  return toolCalls.map((call) => {
    if (call.name !== "sessions_history") {
      return call;
    }
    const sessionKey = readSessionKeyFromToolInput(call.input);
    if (!sessionKey) {
      return call;
    }
    const proposedMessage =
      readStringInput(call.input, "message") ??
      readStringInput(call.input, "reason") ??
      readStringInput(call.input, "query");
    return {
      ...call,
      name: "sessions_send",
      input: {
        session_key: sessionKey,
        message:
          proposedMessage?.trim() ||
          [
            "Continue this existing sub-agent session for the user's follow-up.",
            "Let the source-check finish with the evidence it can collect, then return verified facts, unverified scope, residual risk, and how to continue if evidence is still incomplete.",
          ].join(" "),
      },
    };
  });
}

export function normalizeLocalUrlWebFetchCalls(
  toolCalls: LLMToolCall[],
  context: { taskPrompt: string },
): LLMToolCall[] {
  return toolCalls.map((call) => {
    if (call.name !== "web_fetch") {
      return call;
    }
    const url =
      readStringInput(call.input, "url") ??
      readStringInput(call.input, "uri") ??
      readStringInput(call.input, "href");
    const inputText = [url, stableJson(call.input)].filter(Boolean).join("\n");
    if (!containsPrivateOrLoopbackHttpUrl(inputText)) {
      return call;
    }
    const targetUrl = url ?? extractHttpUrls(inputText)[0] ?? "";
    return {
      ...call,
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        label: readStringInput(call.input, "label") ?? "local-url-fetch",
        task: [
          "Open the local/private URL as a browser-visible source instead of using web_fetch.",
          targetUrl ? `URL: ${targetUrl}` : null,
          "Extract only evidence visible from the page and preserve source-bounded residual risk.",
          context.taskPrompt ? `Parent task: ${context.taskPrompt}` : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      },
    };
  });
}

export function normalizePrivateUrlResearchSpawnCalls(
  toolCalls: LLMToolCall[],
  context: { browserAvailable: boolean; taskPrompt: string },
): LLMToolCall[] {
  if (!context.browserAvailable) {
    return toolCalls;
  }
  return toolCalls.map((call) => {
    if (
      call.name !== "sessions_spawn" ||
      readStringInput(call.input, "agent_id") !== "explore"
    ) {
      return call;
    }
    const task = readStringInput(call.input, "task") ?? "";
    const label = readStringInput(call.input, "label") ?? "";
    const combined = [task, label].join("\n");
    const targetsBrowserRequiredUrl = toolCallTargetsBrowserRequiredUrl({
      toolCallText: combined,
      taskPrompt: context.taskPrompt,
    });
    if (
      !containsPrivateOrLoopbackHttpUrl(combined) &&
      !targetsBrowserRequiredUrl
    ) {
      return call;
    }
    if (
      isLoopbackReadOnlySourceExploreTask({
        toolCallText: combined,
        taskPrompt: context.taskPrompt,
        targetsBrowserRequiredUrl,
      }) ||
      (allowsLoopbackExploreForE2E() &&
        containsLoopbackHttpUrl(combined) &&
        !containsPrivateNonLoopbackHttpUrl(combined) &&
        !readPolicyBrowserEvidenceRequirement(combined) &&
        !targetsBrowserRequiredUrl)
    ) {
      return call;
    }
    const reason = targetsBrowserRequiredUrl
      ? "Use the browser worker for this browser-visible URL source; do not use public-source fetch."
      : "Use the browser worker for this local/private URL source; do not use public-source fetch.";
    return {
      ...call,
      input: {
        ...call.input,
        agent_id: "browser",
        task: [
          reason,
          "Inspect the rendered page as the user would see it, extract only observed facts, and mark missing fields as not verified.",
          task,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    };
  });
}

export function normalizeLoopbackSpawnCallUrls(
  toolCalls: LLMToolCall[],
  context: { taskPrompt: string },
): LLMToolCall[] {
  return toolCalls.map((call) => {
    if (call.name !== "sessions_spawn") {
      return call;
    }
    const nextInput: Record<string, unknown> = { ...call.input };
    let changed = false;
    for (const field of ["task", "message", "reason", "url", "uri", "href"] as const) {
      const value = readStringInput(nextInput, field);
      if (!value) {
        continue;
      }
      const rewritten = rewriteLoopbackUrlsFromTaskPrompt(value, context.taskPrompt);
      if (rewritten !== value) {
        nextInput[field] = rewritten;
        changed = true;
      }
    }
    return changed ? { ...call, input: nextInput } : call;
  });
}

function rewriteLoopbackUrlsFromTaskPrompt(text: string, taskPrompt: string): string {
  let rewritten = text;
  for (const url of extractHttpUrls(text)) {
    const replacement = findCanonicalLoopbackTaskPromptUrl(url, taskPrompt);
    if (replacement && replacement !== url) {
      rewritten = rewritten.split(url).join(replacement);
    }
  }
  return rewritten;
}

function findCanonicalLoopbackTaskPromptUrl(url: string, taskPrompt: string): string | null {
  const parsed = parseUrlOrNull(url);
  if (!parsed || !isLoopbackHostname(parsed.hostname)) {
    return null;
  }
  for (const candidate of extractHttpUrls(taskPrompt)) {
    const parsedCandidate = parseUrlOrNull(candidate);
    if (!parsedCandidate || !isLoopbackHostname(parsedCandidate.hostname)) {
      continue;
    }
    if (
      parsedCandidate.protocol === parsed.protocol &&
      parsedCandidate.port === parsed.port &&
      parsedCandidate.pathname === parsed.pathname &&
      parsedCandidate.search === parsed.search &&
      parsedCandidate.hash === parsed.hash
    ) {
      return candidate;
    }
  }
  return null;
}

function parseUrlOrNull(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function normalizeBoundedTimeoutSourceSpawnAgents(
  toolCalls: LLMToolCall[],
  context: { exploreAvailable: boolean; taskPrompt: string },
): LLMToolCall[] {
  if (
    !context.exploreAvailable ||
    !looksBoundedTimeoutSourceCheck(context.taskPrompt)
  ) {
    return toolCalls;
  }
  return toolCalls.map((call) => {
    if (
      call.name !== "sessions_spawn" ||
      readStringInput(call.input, "agent_id") !== "browser"
    ) {
      return call;
    }
    const task = readStringInput(call.input, "task") ?? "";
    const label = readStringInput(call.input, "label") ?? "";
    const callText = [task, label].join("\n");
    if (extractHttpUrls(callText).length === 0) {
      return call;
    }
    const browserRequired =
      readPolicyBrowserEvidenceRequirement(context.taskPrompt) ||
      readPolicyBrowserEvidenceRequirement(callText) ||
      hasHardBrowserRequiredSignal(context.taskPrompt) ||
      hasHardBrowserRequiredSignal(callText) ||
      toolCallTargetsBrowserRequiredUrl({
        toolCallText: callText,
        taskPrompt: context.taskPrompt,
      });
    if (browserRequired) {
      return call;
    }
    return {
      ...call,
      input: {
        ...call.input,
        agent_id: "explore",
        task: [
          "Use the explore worker for this bounded source-check; browser-visible/rendered evidence was not requested.",
          task,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    };
  });
}

export function normalizeBoundedTimeoutDuplicateSourceSpawns(
  toolCalls: LLMToolCall[],
  context: { taskPrompt: string },
): LLMToolCall[] {
  if (!looksBoundedTimeoutSourceCheck(context.taskPrompt)) {
    return toolCalls;
  }
  const selectedByUrlSet = new Map<string, { index: number; score: number }>();
  const droppedIndexes = new Set<number>();
  toolCalls.forEach((call, index) => {
    if (call.name !== "sessions_spawn") {
      return;
    }
    const urls = dedupeStrings(
      extractHttpUrls(
        [
          readStringInput(call.input, "task") ?? "",
          readStringInput(call.input, "label") ?? "",
        ].join("\n"),
      ).map(normalizeUrlForComparison),
    ).sort();
    if (urls.length !== 1) {
      return;
    }
    const urlSetKey = urls.join("\n");
    const score = scoreBoundedTimeoutSourceSpawn(call, context.taskPrompt);
    const current = selectedByUrlSet.get(urlSetKey);
    if (!current || score > current.score) {
      if (current) {
        droppedIndexes.add(current.index);
      }
      selectedByUrlSet.set(urlSetKey, { index, score });
      return;
    }
    droppedIndexes.add(index);
  });
  if (droppedIndexes.size === 0) {
    return toolCalls;
  }
  return toolCalls.filter((_, index) => !droppedIndexes.has(index));
}

export function looksBoundedTimeoutSourceCheck(text: string): boolean {
  return (
    /\b(?:bounded attempt|bounded retry|does not return|doesn't return|slow[- ]source|source[- ]check|timeout|timed out|resume(?:d)? the existing source|continue from the slow[- ]source)\b/i.test(
      text,
    ) && extractHttpUrls(text).length > 0
  );
}

export function scoreBoundedTimeoutSourceSpawn(
  call: LLMToolCall,
  taskPrompt: string,
): number {
  const agentId = readStringInput(call.input, "agent_id") ?? "";
  const callText = [
    readStringInput(call.input, "task") ?? "",
    readStringInput(call.input, "label") ?? "",
  ].join("\n");
  const browserRequired =
    readPolicyBrowserEvidenceRequirement(taskPrompt) ||
    readPolicyBrowserEvidenceRequirement(callText) ||
    toolCallTargetsBrowserRequiredUrl({ toolCallText: callText, taskPrompt });
  if (browserRequired) {
    if (agentId === "browser") return 30;
    if (agentId === "explore") return 10;
    return 0;
  }
  if (agentId === "explore") return 30;
  if (agentId === "browser") return 10;
  return 0;
}

export function normalizeApprovalGatedBrowserSpawnCalls(
  toolCalls: LLMToolCall[],
  context: {
    taskPrompt: string;
    sessionContext: string;
    toolTrace: NativeToolRoundTrace[];
  },
): LLMToolCall[] {
  const browserSpawnCalls = toolCalls.filter(isBrowserSessionSpawn);
  if (browserSpawnCalls.length === 0) {
    return toolCalls;
  }
  const contextText = [
    context.taskPrompt,
    context.sessionContext,
    ...browserSpawnCalls.flatMap((call) => [
      readStringInput(call.input, "task") ?? "",
      readStringInput(call.input, "label") ?? "",
      readStringInput(call.input, "action") ?? "",
    ]),
  ].join("\n");
  if (!looksApprovalGatedBrowserSideEffect(contextText)) {
    return toolCalls;
  }
  const prematureMutatingBrowserSpawn = browserSpawnCalls.find((call) =>
    (() => {
      const callText = [
        readStringInput(call.input, "task") ?? "",
        readStringInput(call.input, "label") ?? "",
        readStringInput(call.input, "action") ?? "",
      ].join("\n");
      return (
        looksApprovalGatedBrowserSideEffect(callText) &&
        browserSpawnPerformsMutatingAction(callText) &&
        !disclaimsIntendedBrowserMutation(callText)
      );
    })(),
  );
  if (
    prematureMutatingBrowserSpawn &&
    !taskIntentFactsForPrompt(context.taskPrompt).approvalAlreadyApplied &&
    !readPolicyPermissionGateContextEvidence(context.sessionContext) &&
    !readPolicyPermissionGateEvidence(context.toolTrace) &&
    !toolCalls.some((call) => call.name.startsWith("permission_"))
  ) {
    return toolCalls.flatMap((call) => {
      if (!isBrowserSessionSpawn(call)) {
        return [call];
      }
      if (call !== prematureMutatingBrowserSpawn) {
        return [];
      }
      const permissionQuery = buildPermissionQueryFromBrowserSpawn(
        call,
        context.taskPrompt,
      );
      const inspectionCall = buildPreApprovalBrowserInspectionSpawn(
        call,
        context.taskPrompt,
      );
      return inspectionCall ? [inspectionCall, permissionQuery] : [permissionQuery];
    });
  }
  if (browserSpawnCalls.length <= 1) {
    return toolCalls;
  }
  const seenSignatures = new Set<string>();
  return toolCalls.filter((call) => {
    if (!isBrowserSessionSpawn(call)) {
      return true;
    }
    const signature = toolCallSignature(call);
    if (!seenSignatures.has(signature)) {
      seenSignatures.add(signature);
      return true;
    }
    return false;
  });
}

export function readPolicyPermissionGateContextEvidence(context: string): boolean {
  return /\bpermission_(?:query|result|applied)\b|\bpermission\.(?:query|result|applied)\b|\bapproval_id\b|\bpermission cache\b[\s\S]{0,120}\balready applied\b/i.test(
    context,
  );
}

export function shouldPreservePreApprovalBrowserInspection(
  callText: string,
  taskPrompt: string,
): boolean {
  const combined = `${taskPrompt}\n${callText}`;
  if (!looksApprovalGatedBrowserSideEffect(combined)) {
    return false;
  }
  if (!/\b(?:approval[- ]?form|approval form|dry[- ]run|operator review|browser\.form\.submit|form submission)\b/i.test(combined)) {
    return false;
  }
  return (
    containsPrivateOrLoopbackHttpUrl(combined) ||
    /\b(?:open|inspect|observe|rendered|screenshot|snapshot|visible|page evidence|what evidence the page showed)\b/i.test(
      combined,
    )
  );
}

function buildPermissionQueryFromBrowserSpawn(
  call: LLMToolCall,
  taskPrompt: string,
): LLMToolCall {
  const task = readStringInput(call.input, "task") ?? "";
  const label = readStringInput(call.input, "label") ?? "";
  const url = extractHttpUrls(`${task}\n${taskPrompt}`)[0];
  return {
    ...call,
    name: "permission_query",
    input: {
      action: "browser.form.submit",
      title: "Approve local dry-run browser form submission",
      risk:
        "Applies an approval-gated browser form submission in an isolated local dry-run page.",
      level: "approval",
      scope: "mutate",
      worker_kind: "browser",
      rationale:
        "The user asked to carry a browser form submission through the approval gate before applying the action.",
      payload: {
        ...(url ? { url } : {}),
        task: task || label || "approval-gated browser form submission",
      },
    },
  };
}

function buildPreApprovalBrowserInspectionSpawn(
  call: LLMToolCall,
  taskPrompt: string,
): LLMToolCall | null {
  const task = readStringInput(call.input, "task") ?? "";
  const label = readStringInput(call.input, "label") ?? "";
  const callText = [task, label].join("\n");
  if (!shouldPreservePreApprovalBrowserInspection(callText, taskPrompt)) {
    return null;
  }
  const url = extractHttpUrls(`${callText}\n${taskPrompt}`)[0];
  if (!url) {
    return null;
  }
  return {
    ...call,
    id: `${call.id}-inspection`,
    input: {
      ...call.input,
      agent_id: "browser",
      label: label || "Pre-approval browser inspection",
      task: [
        "Pre-approval browser inspection only.",
        `Open ${url} as a rendered browser page and observe what is visible before any approval-gated action.`,
        "Report the final URL, page title, visible fixture/marker text, form fields, submission control, and screenshot/snapshot evidence if available.",
        "Do not submit the form, click the submit control, fill fields, save, mutate, or perform any side effect. The form submission remains blocked until permission_query/permission_result/permission_applied clears it.",
      ].join("\n"),
    },
  };
}

export function enforceMissingApprovalGateRepairToolCalls(
  toolCalls: LLMToolCall[],
  context: {
    messages: LLMMessage[];
    repairMarkers: LLMMessage[];
    taskPrompt: string;
    toolTrace: NativeToolRoundTrace[];
  },
): LLMToolCall[] {
  if (
    !hasMissingApprovalGateRepairPrompt(context.repairMarkers) ||
    !taskIntentFactsForPrompt(context.taskPrompt)
      .approvalGatedBrowserActionRequested ||
    readPolicyPermissionGateEvidence(context.toolTrace) ||
    toolCalls.some((call) => call.name === "permission_query")
  ) {
    return toolCalls;
  }
  const selected = toolCalls[0];
  return [
    buildPermissionQueryFromBrowserSpawn(
      selected ?? {
        id: "runtime-missing-approval-gate",
        name: "sessions_spawn",
        input: {},
      },
      context.taskPrompt,
    ),
  ];
}

export function disclaimsIntendedBrowserMutation(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /\b(?:not\s+(?:a\s+)?form submission|not\s+(?:a\s+)?browser mutation|do not mutate|don't mutate|without mutat(?:ing|ion)|no browser mutation|no form submission)\b/i.test(
      normalized,
    ) ||
    /\b(?:inspect|inspection|observe|review|report|summarize|read|check)\b[\s\S]{0,120}\bbefore\s+(?:submission|submit|submitting|mutation|side[- ]effect)\b/i.test(
      normalized,
    ) ||
    /\b(?:read[- ]only|inspection only|observe[- ]only|no[- ]mutation)\b[\s\S]{0,180}\b(?:no|not|without|unintended)\b[\s\S]{0,120}\b(?:submit|submission|form submission|mutat(?:e|ion)|side[- ]effects?|browser side[- ]effect)\b/i.test(
      normalized,
    ) ||
    /\b(?:no|not|without)\b[\s\S]{0,80}\b(?:form submission|submission|submit|mutat(?:e|ion)|side[- ]effects?)\b[\s\S]{0,160}\b(?:intended|needed|required|will run|will be performed|should run|should be performed)\b/i.test(
      normalized,
    ) ||
    /\b(?:submitting|submit(?:ting)? a form|form submission|browser mutation|side[- ]effect)\b[\s\S]{0,120}\b(?:would be|is)\s+(?:an\s+)?unintended\b/i.test(
      normalized,
    )
  );
}

export function isBrowserSessionSpawn(call: LLMToolCall): boolean {
  return (
    call.name === "sessions_spawn" &&
    readStringInput(call.input, "agent_id") === "browser"
  );
}

export function readPolicyBrowserEvidenceRequirement(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (explicitlyDisclaimsBrowserRenderedEvidence(normalized)) {
    return false;
  }
  return (
    /\b(?:browser-visible|browser rendered|browser-rendered|browser-observed|as (?:a|an) (?:user|operator) would see|user-visible|visible page|rendered page|rendered DOM|client[- ]side|JavaScript-rendered|JS-rendered|dynamic dashboard|live dashboard)\b/i.test(
      normalized,
    ) ||
    /\b(?:rendered browser page|browser page rendered|fully render(?:ed)?|rendered values?|visible values?|exact visible text|exact visible values?)\b/i.test(
      normalized,
    ) ||
    /\b(?:live signal|signal dashboard|real-time indicators?|visible metrics?|metrics? dashboards?)\b/i.test(
      normalized,
    ) ||
    /\b(?:dashboards?|metrics?|signal values?)\b[\s\S]{0,120}\bshown on (?:the )?page\b/i.test(
      normalized,
    ) ||
    /\b(?:iframe|embedded source frame|frame content|shadow(?:-style)? component|shadow DOM|details popup|popup workflow|open the details popup)\b/i.test(
      normalized,
    )
  );
}

export function explicitlyDisclaimsBrowserRenderedEvidence(text: string): boolean {
  return (
    /\b(?:not|never)\s+(?:a\s+)?(?:browser-visible|browser-rendered|browser rendered|browser-observed|user-visible)\b/i.test(
      text,
    ) ||
    /\b(?:no|without)\s+(?:client[- ]side|JavaScript-rendered|JS-rendered|rendered DOM|browser-rendered|browser rendered|browser-visible)\s+(?:rendering|content|evidence|required|needed)?\b/i.test(
      text,
    ) ||
    /\bstatic HTML only\b[\s\S]{0,80}\b(?:no|without)\s+(?:JavaScript|JS|client[- ]side|browser-rendered|browser rendered)\b/i.test(
      text,
    )
  );
}

export function toolCallTargetsBrowserRequiredUrl(input: {
  toolCallText: string;
  taskPrompt: string;
}): boolean {
  const urls = extractHttpUrls(input.toolCallText);
  if (urls.length === 0 || !readPolicyBrowserEvidenceRequirement(input.taskPrompt)) {
    return false;
  }
  return urls.some((url) =>
    taskPromptRequiresBrowserForUrl(input.taskPrompt, url),
  );
}

export function taskPromptRequiresBrowserForUrl(
  taskPrompt: string,
  url: string,
): boolean {
  const normalizedUrl = normalizeUrlForComparison(url);
  const lines = taskPrompt.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (
      !extractHttpUrls(line).some(
        (candidate) => normalizeUrlForComparison(candidate) === normalizedUrl,
      )
    ) {
      continue;
    }
    const localContext = [
      lines[index - 1],
      line,
      lines[index + 1],
      lines[index + 2],
    ]
      .filter((item): item is string => typeof item === "string")
      .join("\n");
    if (readPolicyBrowserEvidenceRequirement(localContext)) {
      return true;
    }
  }
  return false;
}

export function looksApprovalGatedBrowserSideEffect(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  const hasApprovalContext =
    /\b(?:approval|approve|approved|permission|authorize|authorized|operator\s+review|gate|gated|dry-?run)\b/i.test(
      normalized,
    ) || /\bbrowser\.[a-z0-9_.-]+\b/i.test(normalized);
  const hasBrowserMutation =
    /\b(?:submit|click|press|type|fill|select|upload|download|delete|save|apply|confirm|purchase|checkout|sign\s*in|log\s*in|form)\b/i.test(
      normalized,
    ) ||
    /\bbrowser\.(?:form\.submit|click|input|type|select|upload|download|permission)\b/i.test(
      normalized,
    );
  return hasApprovalContext && hasBrowserMutation;
}

export function browserSpawnPerformsMutatingAction(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /\b(?:submit|submission|form\.submit)\b[\s\S]{0,80}\b(?:form|button|control|page|browser|action|mutation|side[- ]effect|approval|approved|dry[- ]run)\b/i.test(
      normalized,
    ) ||
    /\b(?:form|button|control|page|browser|action|mutation|side[- ]effect|approval|approved|dry[- ]run)\b[\s\S]{0,80}\b(?:submit|submission|form\.submit)\b/i.test(
      normalized,
    ) ||
    /\b(?:click|press|type|fill|select|upload|download|delete|save|apply|confirm|purchase|checkout|sign\s*in|log\s*in)\b/i.test(
      normalized,
    ) ||
    /\bbrowser\.(?:form\.submit|click|input|type|select|upload|download|permission)\b/i.test(
      normalized,
    )
  );
}

export function containsPrivateOrLoopbackHttpUrl(text: string): boolean {
  return extractHttpUrls(text).some((url) => {
    try {
      const parsed = new URL(url);
      return isPrivateOrLoopbackHostname(parsed.hostname);
    } catch {
      return false;
    }
  });
}

export function containsLoopbackHttpUrl(text: string): boolean {
  return extractHttpUrls(text).some((url) => {
    try {
      const parsed = new URL(url);
      return isLoopbackHostname(parsed.hostname);
    } catch {
      return false;
    }
  });
}

export function containsPrivateNonLoopbackHttpUrl(text: string): boolean {
  return extractHttpUrls(text).some((url) => {
    try {
      const parsed = new URL(url);
      return (
        isPrivateOrLoopbackHostname(parsed.hostname) &&
        !isLoopbackHostname(parsed.hostname)
      );
    } catch {
      return false;
    }
  });
}

export function isLoopbackReadOnlySourceExploreTask(input: {
  toolCallText: string;
  taskPrompt: string;
  targetsBrowserRequiredUrl: boolean;
}): boolean {
  if (
    input.targetsBrowserRequiredUrl ||
    readPolicyBrowserEvidenceRequirement(input.taskPrompt) ||
    readPolicyBrowserEvidenceRequirement(input.toolCallText) ||
    !containsLoopbackHttpUrl(input.toolCallText) ||
    containsPrivateNonLoopbackHttpUrl(input.toolCallText)
  ) {
    return false;
  }
  const normalized = input.toolCallText.toLowerCase();
  return (
    /\b(?:source pages?|source|pricing|price|url extraction|read-only url|fetch|extract|retrieve|research|review|compare|comparison|evidence|content)\b/i.test(
      normalized,
    ) && !hasHardBrowserRequiredSignal(normalized)
  );
}

export function hasHardBrowserRequiredSignal(input: string): boolean {
  return /\b(?:authenticated|login|logged in|account|password|2fa|mfa|otp|credential|api key|secret|token|interactive|click|fill|submit|submission|form|approval|dry-run|dry run|operator review|side effect|side-effect|mutation|save|purchase|delete|update|visual|screenshot|snapshot|js-rendered|javascript-rendered|client-side|rendered dashboard|dashboard|as a user would see|active browser)\b/i.test(
    input,
  );
}

export function allowsLoopbackExploreForE2E(): boolean {
  return process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE === "1";
}

export function readPolicyBrowserRecoverySummariesFromToolTrace(
  rounds: NativeToolRoundTrace[],
): string[] {
  const summaries: string[] = [];
  for (const round of rounds) {
    for (const result of round.results) {
      if (
        result.toolName !== "sessions_spawn" &&
        result.toolName !== "sessions_send"
      ) {
        continue;
      }
      const parsed = result.content ? parseSessionToolResult(result.content) : null;
      if (!parsed) {
        continue;
      }
      const payload = parsed.payload;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const browserRecoverySummary = readBrowserRecoverySummary(
          payload as Record<string, unknown>,
        );
        if (browserRecoverySummary) {
          summaries.push(browserRecoverySummary);
        }
      }
      const inlineBrowserRecoverySummary = readInlineBrowserRecoverySummary(
        [parsed.evidence_summary, parsed.result, parsed.final_content].filter(
          (item): item is string => typeof item === "string",
        ),
      );
      if (inlineBrowserRecoverySummary) {
        summaries.push(inlineBrowserRecoverySummary);
      }
    }
  }
  return dedupeStrings(summaries);
}

export function readPolicyBrowserFailureBucketNames(text: string): string[] {
  const buckets = new Set<string>();
  const pattern =
    /\b(target_not_found|attach_failed|expert_session_detached|cdp_command_timeout|browser_cdp_unavailable|detached_target|session_not_found|wait_condition_timeout|transport_failure|owner_mismatch|lease_conflict)\b/gi;
  for (const match of text.matchAll(pattern)) {
    buckets.add(match[1]!.toLowerCase());
  }
  return [...buckets].sort();
}

export function readPolicyTimeoutContinuationCloseoutRequest(taskPrompt: string): boolean {
  return /\b(?:explain|state|say|describe)\b[\s\S]{0,160}\bwhether\b[\s\S]{0,160}\b(?:earlier|previous|prior)\s+timeouts?\b[\s\S]{0,160}\b(?:still\s+)?limits?\b[\s\S]{0,120}\bconclusion\b|\b(?:earlier|previous|prior)\s+timeouts?\b[\s\S]{0,120}\b(?:still\s+)?limits?\b[\s\S]{0,120}\bconclusion\b/i.test(
    taskPrompt,
  );
}

export function readPolicyUnverifiedTimeoutCloseoutRequest(taskPrompt: string): boolean {
  return (
    readPolicyTimeoutContinuationCloseoutRequest(taskPrompt) &&
    /\b(?:unverified|not verified|residual risk|uncertainty|uncertain)\b/i.test(
      taskPrompt,
    )
  );
}

export function readPolicyUnverifiedScopeMention(text: string): boolean {
  return /\b(?:unverified|not verified|unconfirmed|uncertain|uncertainty|not confirmed)\b/i.test(
    text,
  );
}

export function shouldPreserveRecoveredTimeoutCloseout(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  evidenceText: string;
}): boolean {
  if (shouldAppendTimeoutContinuationVisibilityFact(input)) {
    return true;
  }
  return (
    hasSessionTimeoutEvidence(input) &&
    toolTraceHasCall(input.toolTrace, "sessions_send") &&
    readPolicyTimeoutMention(input.evidenceText)
  );
}

function shouldAppendTimeoutContinuationVisibilityFact(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  const taskPromptSuffix = input.taskPrompt.slice(
    Math.max(0, input.taskPrompt.length - 4000),
  );
  if (
    !isExplicitSessionContinuationRequest(
      extractLatestUserContinuationText(taskPromptSuffix),
    ) &&
    !isExplicitSessionContinuationRequest(taskPromptSuffix)
  ) {
    return false;
  }
  if (!toolTraceHasCall(input.toolTrace, "sessions_send")) {
    return false;
  }
  return hasSessionTimeoutEvidence(input);
}

export function hasTimeoutCloseoutGuidance(text: string): boolean {
  return (
    hasTimeoutContinuationGuidance(text) ||
    /\b(?:earlier|previous|prior)\s+timeouts?\b[\s\S]{0,120}\b(?:no longer|still|does not|doesn't)\b[\s\S]{0,80}\blimits?\b[\s\S]{0,80}\bconclusion\b/i.test(
      text,
    )
  );
}

export function readPolicyTimeoutMention(text: string): boolean {
  return /\b(?:timeout|timed out)\b/i.test(text);
}

export function toolTraceHasCall(
  toolTrace: NativeToolRoundTrace[],
  toolName: string,
): boolean {
  return toolTrace.some((roundTrace) =>
    roundTrace.calls.some((call) => call.name === toolName),
  );
}

export function toolTraceHasTimeoutResult(toolTrace: NativeToolRoundTrace[]): boolean {
  return toolTrace.some((roundTrace) =>
    roundTrace.results.some((result) => {
      if (
        result.toolName !== "sessions_spawn" &&
        result.toolName !== "sessions_send"
      ) {
        return false;
      }
      if (typeof result.content !== "string") {
        return false;
      }
      return parseSessionToolResult(result.content)?.status === "timeout";
    }),
  );
}

export function hasSessionTimeoutEvidence(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (toolTraceHasTimeoutResult(input.toolTrace)) {
    return true;
  }
  return contextHasTimeoutSessionResult(
    buildContinuationDirectiveContext(input.taskPrompt, input.messages),
  );
}

export function resolveRecoveryToolBudgetForActivation(input: {
  activation: RoleActivationInput;
  taskPrompt: string;
  messages: LLMMessage[];
}): { maxToolCalls: number } | null {
  return resolveFinalRecoveryToolBudget(
    buildFinalRecoveryBudgetContext(input),
  );
}

export function countRecoveryToolCallsBeforeActivation(input: {
  activation: RoleActivationInput;
  taskPrompt: string;
  messages: LLMMessage[];
}): number {
  const context = buildFinalRecoveryBudgetContext(input);
  const marker = findLastFinalRecoveryBudgetMarker(context);
  if (marker < 0) return 0;
  return countRenderedToolCallLines(context.slice(marker));
}

export function readPolicyFinalRecoveryBudgetCloseoutRepair(input: {
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
}): boolean {
  if (hasFinalRecoveryBudgetCloseoutRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (/@\{role-[^}]+}/i.test(input.resultText)) {
    return true;
  }
  return !/(?:blocked|partial|未验证|无法验证|无法确认|not verified|unverified|needs follow-up|缺口|缺少)/i.test(
    input.resultText,
  );
}

function hasFinalRecoveryBudgetCloseoutRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readFinalRecoveryMessageContentText(message.content).includes(
        "Runtime correction: final recovery tool budget is exhausted",
      ),
  );
}

function resolveFinalRecoveryToolBudget(
  taskPrompt: string,
): { maxToolCalls: number } | null {
  const attempt = taskPrompt.match(/Automatic recovery attempt\s+(\d+)\s+of\s+(\d+)/i);
  if (!attempt) return null;
  const currentAttempt = Number(attempt[1]);
  const maxAttempt = Number(attempt[2]);
  if (
    !Number.isFinite(currentAttempt) ||
    !Number.isFinite(maxAttempt) ||
    currentAttempt < maxAttempt
  ) {
    return null;
  }
  const budget = taskPrompt.match(
    /at most\s+([a-z]+|\d+)\s+additional tool calls total/i,
  );
  if (!budget) return null;
  const maxToolCalls = parseSmallIntegerWord(budget[1] ?? "");
  if (!Number.isFinite(maxToolCalls) || maxToolCalls <= 0) return null;
  return { maxToolCalls };
}

function findLastFinalRecoveryBudgetMarker(text: string): number {
  let marker = -1;
  const pattern =
    /Automatic recovery attempt\s+(\d+)\s+of\s+(\d+)[\s\S]{0,600}?at most\s+([a-z]+|\d+)\s+additional tool calls total/gi;
  for (const match of text.matchAll(pattern)) {
    const currentAttempt = Number(match[1]);
    const maxAttempt = Number(match[2]);
    if (
      Number.isFinite(currentAttempt) &&
      Number.isFinite(maxAttempt) &&
      currentAttempt >= maxAttempt
    ) {
      marker = match.index ?? marker;
    }
  }
  return marker;
}

function countRenderedToolCallLines(text: string): number {
  return Array.from(
    text.matchAll(
      /(?:^|[\n\r])\s*Calling\s+[A-Za-z_][\w-]*\s*\(/g,
    ),
  ).length;
}

function buildFinalRecoveryBudgetContext(input: {
  activation: RoleActivationInput;
  taskPrompt: string;
  messages: LLMMessage[];
}): string {
  const intent = input.activation.handoff.payload.intent;
  return [
    input.taskPrompt,
    intent?.relayBrief ?? "",
    intent?.instructions ?? "",
    ...(intent?.recentMessages ?? []).map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? ""),
    ),
    ...input.messages
      .filter((message) => message.role === "user")
      .map((message) => readFinalRecoveryMessageContentText(message.content)),
  ].join("\n");
}

function readFinalRecoveryMessageContentText(
  content: LLMMessage["content"],
): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === "tool_result") return block.content;
      if (block.type === "text") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseSmallIntegerWord(value: string): number {
  const normalized = value.trim().toLowerCase();
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) return Math.floor(numeric);
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  return words[normalized] ?? Number.NaN;
}
