import type { GenerateTextResult, LLMMessage } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RolePromptPacket } from "../prompt-policy";
import { produceTaskIntentEnvelope } from "../runtime-facts/task-intent-producer";
import {
  SESSION_TOOL_RESULT_PROTOCOL,
  matchesAny,
  containsAnyToolCallForm,
  readSessionKeyFromToolInput,
  sliceUtf8,
  escapeRegExp,
  readMessageContentText,
  isControlPlaneToolResultName,
  parseJsonObject,
  throwIfAborted,
  llmMessageContentToText,
  readPolicyWorkerKindFromSessionKey,
  SESSION_SEND_ALIAS_NAMES,
  normalizeSessionToolAliasCalls,
  normalizeSessionToolCalls,
  normalizeUrlForComparison,
  readStringInput,
  extractHttpUrls,
  trimHttpUrlCandidate,
  isPrivateOrLoopbackHostname,
  isLoopbackHostname,
  dedupeStrings,
  ROLE_TOOL_RESULT_TRACE_CAP_BYTES,
  toNativeToolResultTrace,
  compactToolResultTraceContent,
  fitCompactToolResultTraceContent,
  compactSessionPayloadEvidenceExcerpt,
  compactSessionPayloadArtifactRefs,
  readPayloadEvidenceExcerpt,
  readPayloadEvidencePages,
  readStringArray,
  toNativeToolProgressTrace,
  buildToolCallLimitExceededResult,
  withFinalToolRoundWarning,
  resolveEffectiveToolLoopWallClockMs,
  createToolExecutionSignal,
  isAbortError,
  formatDurationMs,
  readStringField,
  extractWorkerSessionKey,
  extractKnownWorkerSessionKeys,
  resolveKnownWorkerSessionKey,
  relaxedSessionKeySignature,
  readTruncatedSessionKeyPrefix,
  buildContinuationDirectiveContext,
} from "../tool-protocol";
import {
  contextHasTimeoutSessionResult,
  extractLatestUserContinuationText,
  hasSessionTimeoutEvidence,
  hasTimeoutCloseoutGuidance,
  isExplicitSessionContinuationRequest,
  readPolicyBrowserEvidenceRequirement,
  readPolicyBrowserFailureBucketNames,
  readPolicyTimeoutContinuationCloseoutRequest,
  readPolicyTimeoutFollowupContinuationRequest,
  readPolicyTimeoutMention,
  readPolicyUnverifiedScopeMention,
  readPolicyUnverifiedTimeoutCloseoutRequest,
  toolTraceHasCall,
  toolTraceHasTimeoutResult,
} from "../runtime-facts/text-fallback-readers";
import { hasTimeoutContinuationGuidance } from "../runtime-facts/repair-marker-facts";

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

export function maybeRedactForbiddenLocalUrls(input: {
  result: GenerateTextResult;
  packet: RolePromptPacket;
}): GenerateTextResult {
  const constraintText = `${input.packet.taskPrompt}\n${input.packet.outputContract}`;
  if (!forbidsFinalUrls(constraintText)) {
    return input.result;
  }
  const redacted = input.result.text.replace(
    /\bhttps?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s)\],;]*)?/gi,
    "local fixture source",
  );
  if (redacted === input.result.text) {
    return input.result;
  }
  return {
    ...input.result,
    text: redacted,
  };
}

export function forbidsFinalUrls(text: string): boolean {
  return /\b(?:do not include (?:source )?urls?|do not use [^\n.]*links?|links? (?:are )?forbidden|no links?|bare http:\/\/\s*\/\s*https?:\/\/ URLs?)\b/i.test(
    text,
  );
}

export function maybeAppendBrowserFailureBucketVisibility(input: {
  result: GenerateTextResult;
  taskPrompt: string;
  evidenceText: string;
}): GenerateTextResult {
  const buckets = readPolicyBrowserFailureBucketNames(input.evidenceText);
  if (buckets.length === 0) {
    return input.result;
  }
  if (allowsExactFinalAnswerShapeBypass(input.taskPrompt, input.result.text)) {
    return input.result;
  }
  const missingBuckets = buckets.filter(
    (bucket) => !browserFailureBucketVisible(input.result.text, bucket),
  );
  if (missingBuckets.length === 0) {
    return input.result;
  }
  const limitation = buildBrowserFailureBucketVisibilityLine(missingBuckets, input.result.text);
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\n${limitation}`.trim(),
  };
}

export function maybeAppendBrowserRecoveryVisibility(input: {
  result: GenerateTextResult;
  taskPrompt: string;
  browserRecoverySummaries: string[];
}): GenerateTextResult {
  if (input.browserRecoverySummaries.length === 0) {
    return input.result;
  }
  if (
    !/continue|recover|reopen|reconnect|restart|unavailable|previous browser session|times? out|timed? out|timeout|detach(?:ed|es)?|attach(?:ed)?|CDP/i.test(
      input.taskPrompt,
    )
  ) {
    return input.result;
  }
  if (isBrowserRecoveryVisible(input.result.text, input.browserRecoverySummaries)) {
    return input.result;
  }
  if (allowsExactFinalAnswerShapeBypass(input.taskPrompt, input.result.text)) {
    return input.result;
  }
  const joinedSummaries = input.browserRecoverySummaries.join("\n");
  const resumeMode = joinedSummaries
    .match(/Resume mode:\s*(warm|cold)/i)?.[1]
    ?.toLowerCase();
  const continuity = resumeMode
    ? `Browser continuity: browser context was recovered before the page was rechecked (resume mode: ${resumeMode}).`
    : `Browser continuity: ${sliceUtf8(joinedSummaries, 600)}`;
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\n${continuity}`.trim(),
  };
}

export function isBrowserRecoveryVisible(
  resultText: string,
  browserRecoverySummaries: string[],
): boolean {
  const summaryText = browserRecoverySummaries.join("\n");
  const requiresColdSessionVisibility =
    /\b(?:cold recreation|session_not_found|new (?:cold )?browser session|new session `?browser-session-|session was unavailable|browser session .*unavailable|Resume mode:\s*cold)\b/i.test(
      summaryText,
    );
  if (requiresColdSessionVisibility) {
    return /\b(?:cold recreation|session_not_found|new (?:cold )?browser session|new session `?browser-session-|session was unavailable|browser session .*unavailable|resume mode:\s*cold|cold resume mode)\b/i.test(
      resultText,
    );
  }
  return /\b(recovered|recovery|reopen(?:ed)?|reconnect(?:ed)?|warm|cold|session was unavailable|new browser session|timed? out|timeout|cdp_command_timeout|detached|attach(?:ed)? failed|browser_cdp_unavailable)\b/i.test(
    resultText,
  );
}

export function browserFailureBucketVisible(text: string, bucket: string): boolean {
  if (bucket === "cdp_command_timeout") {
    return /\b(?:CDP|snapshot|screenshot|capture|browser)\b[\s\S]{0,160}\b(?:timed out|timeout|incomplete|not captured|not verified|unverified|bounded)\b/i.test(
      text,
    );
  }
  if (bucket === "browser_cdp_unavailable") {
    return /\b(?:browser|CDP|Chrome DevTools)\b[\s\S]{0,160}\b(?:unavailable|unreachable|not reachable|connection refused)\b/i.test(
      text,
    );
  }
  if (bucket === "detached_target") {
    return /\b(?:browser|target|tab|page)\b[\s\S]{0,160}\bdetached\b|\bdetached\b[\s\S]{0,160}\b(?:browser|target|tab|page)\b/i.test(
      text,
    );
  }
  if (new RegExp(`\\b${escapeRegExp(bucket)}\\b`, "i").test(text)) {
    return true;
  }
  return /\b(?:browser|session|target|transport|attach|detached|profile)\b[\s\S]{0,160}\b(?:recovered|failed|unavailable|not found|detached|bounded|unverified)\b/i.test(
    text,
  );
}

export function buildBrowserFailureBucketVisibilityLine(buckets: string[], resultText: string): string {
  if (buckets.includes("detached_target")) {
    return [
      `Browser limitation: browser target detached during browser work (${buckets.join(", ")}).`,
      "Treat the verified page facts as bounded target evidence; browser target details beyond the reported URL, marker, screenshot, or visible text remain incomplete or unverified.",
      "Next action: retry or continue the browser task after the target is stable if additional rendered details matter.",
    ].join(" ");
  }
  if (buckets.includes("cdp_command_timeout")) {
    return [
      `Browser limitation: ${buckets.join(", ")} occurred during browser CDP capture/snapshot work.`,
      "Treat the verified page facts as bounded to recovered browser evidence; deeper CDP traversal or missing capture details remain unverified.",
      "Next action: retry or continue the browser capture with a longer timeout if those missing details matter.",
    ].join(" ");
  }
  if (hasRecoveredRenderedBrowserEvidence(resultText)) {
    return [
      `Browser limitation: ${buckets.join(", ")} occurred during browser work.`,
      "Treat the verified page facts above as bounded to recovered browser evidence; no additional browser-visible facts are claimed beyond the reported marker, URL, screenshot, or confirmation text.",
      "Next action: retry or continue the browser task only if extra rendered details beyond those reported facts matter.",
    ].join(" ");
  }
  return [
    `Browser limitation: ${buckets.join(", ")} occurred during browser work.`,
    "Verified: the browser failure bucket itself is the available source-backed evidence; rendered page content remains unverified.",
    "Next action: retry or continue the browser task after the browser target/session is stable if the missing rendered evidence matters.",
  ].join(" ");
}

export function hasRecoveredRenderedBrowserEvidence(text: string): boolean {
  if (
    /\b(?:rendered|browser-visible|visible page|page content)\b[\s\S]{0,120}\b(?:unverified|not verified|unknown|missing|blocked|not confirmed)\b/i.test(
      text
    ) ||
    /\b(?:unverified|not verified|unknown|missing|blocked|not confirmed)\b[\s\S]{0,120}\b(?:rendered|browser-visible|visible page|page content)\b/i.test(
      text
    )
  ) {
    return false;
  }
  return (
    /\b(?:marker|confirmation marker|success text|confirmation text|final URL|screenshot|snapshot|post-submit|post submission|post-submission|page confirmed|browser fixture evidence)\b/i.test(
      text
    ) ||
    /\b(?:verified|observed|confirmed|found)\b[\s\S]{0,160}\b(?:page|fixture|marker|screenshot|snapshot|URL|confirmation|success text|rendered|browser-visible)\b/i.test(
      text
    )
  );
}

export function requestsStatusVisibleTextEvidenceUrlLines(taskPrompt: string): boolean {
  return (
    /(?:只|仅|只需|仅需)(?:用|以)?(?:回答|输出|返回|给出)[^\n。；;]{0,24}(?:三|3)\s*(?:行|条|句)/i.test(
      taskPrompt,
    ) &&
    /状态/.test(taskPrompt) &&
    /最终可见文本/.test(taskPrompt) &&
    /证据\s*URL/i.test(taskPrompt)
  );
}

export function shouldAppendRecoveredTimeoutCloseoutVisibility(input: {
  resultText: string;
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  const recoveredTimeoutContext =
    (hasSessionTimeoutEvidence(input) ||
      readPolicyTimeoutContinuationCloseoutRequest(input.taskPrompt)) &&
    toolTraceHasCall(input.toolTrace, "sessions_send");
  if (!recoveredTimeoutContext) {
    return false;
  }
  if (
    readPolicyUnverifiedTimeoutCloseoutRequest(input.taskPrompt) &&
    !readPolicyUnverifiedScopeMention(input.resultText)
  ) {
    return true;
  }
  return (
    !hasTimeoutCloseoutGuidance(input.resultText)
  );
}

export function maybeAppendRecoveredTimeoutCloseoutVisibility(
  result: GenerateTextResult,
): GenerateTextResult {
  if (hasTimeoutCloseoutGuidance(result.text)) {
    return result;
  }
  return {
    ...result,
    text: `${result.text.trim()}\n\nTimeout closeout: the resumed source produced source-backed evidence. Continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing or if production-equivalent validation is required.`.trim(),
  };
}

export function maybeAppendTimeoutContinuationVisibility(
  result: GenerateTextResult,
): GenerateTextResult {
  if (hasTimeoutCloseoutGuidance(result.text)) {
    return result;
  }
  return {
    ...result,
    text: `${result.text.trim()}\n\nContinuation: this source check is resumable; continue the same source check if the missing evidence is still worth waiting for.`.trim(),
  };
}

export function maybeAppendRequiredTimeoutFollowupVisibility(input: {
  result: GenerateTextResult;
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): GenerateTextResult {
  if (!readPolicyTimeoutFollowupContinuationRequest(input.taskPrompt)) {
    return input.result;
  }
  const contextText = [
    input.taskPrompt,
    input.result.text,
    ...input.messages.map((message) => readMessageContentText(message.content)),
  ].join("\n");
  const hasRecoveredTimeoutEvidence =
    hasSessionTimeoutEvidence(input) ||
    /\b(?:timeout|timed out|timeout recovery|recovered after .*timeout|resumed after .*timeout|earlier timeout|previous timeout|prior timeout)\b/i.test(
      contextText,
    );
  if (!hasRecoveredTimeoutEvidence || !toolTraceHasCall(input.toolTrace, "sessions_send")) {
    return input.result;
  }
  const missingLines: string[] = [];
  if (!hasTimeoutContinuationGuidance(input.result.text)) {
    missingLines.push(
      "Continuation guidance: continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing or if production-equivalent validation is required.",
    );
  }
  if (!readPolicyUnverifiedScopeMention(input.result.text)) {
    missingLines.push(
      "Unverified scope: production-equivalent release health and any source facts beyond the recovered result remain unverified.",
    );
  }
  if (!readPolicyTimeoutMention(input.result.text)) {
    missingLines.push(
      "Timeout recovery: this answer follows a resumed source-check after an earlier timeout.",
    );
  }
  if (missingLines.length === 0) {
    return input.result;
  }
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\n${missingLines.join(" ")}`.trim(),
  };
}

export function maybeAppendBrowserRecoveryResidualRiskVisibility(input: {
  result: GenerateTextResult;
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): GenerateTextResult {
  if (requestsStatusVisibleTextEvidenceUrlLines(input.taskPrompt)) {
    return input.result;
  }
  if (!readPolicyBrowserEvidenceRequirement(input.taskPrompt)) {
    return input.result;
  }
  if (readPolicyUnverifiedScopeMention(input.result.text) || /\bresidual risks?\b/i.test(input.result.text)) {
    return input.result;
  }
  const contextText = [
    input.taskPrompt,
    input.result.text,
    ...input.messages.map((message) => readMessageContentText(message.content)),
  ].join("\n");
  if (!/\b(?:residual risk|unverified scope|remaining risk|what remains unverified)\b/i.test(contextText)) {
    return input.result;
  }
  const hasBrowserRecoveryOrTimeout =
    toolTraceHasTimeoutResult(input.toolTrace) ||
    /\b(?:browser recovery metadata|resume mode|cold resume|recovered browser|browser.*timed out|timed out.*browser|screenshot.*timed out|snapshot.*timed out|scroll.*timed out|wait_for.*timed out)\b/i.test(
      contextText,
    );
  if (!hasBrowserRecoveryOrTimeout) {
    return input.result;
  }
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\nResidual risk: this browser review is source-bounded to recovered local fixture evidence; wider production state and any browser traversal that timed out remain unverified.`.trim(),
  };
}

export function shouldAppendTimeoutContinuationVisibility(input: {
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
  if (
    !input.toolTrace.some((roundTrace) =>
      roundTrace.calls.some((call) => call.name === "sessions_send"),
    )
  ) {
    return false;
  }
  const context = buildContinuationDirectiveContext(
    input.taskPrompt,
    input.messages,
  );
  return (
    toolTraceHasTimeoutResult(input.toolTrace) ||
    contextHasTimeoutSessionResult(context)
  );
}
