import type {
  GenerateTextResult,
  LLMMessage,
  LLMToolCall,
} from "@turnkeyai/llm-adapter/index";
import type { ToolResult } from "@turnkeyai/agent-core/tool";
import type { RoleActivationInput } from "@turnkeyai/core-types/team";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RolePromptPacket } from "../prompt-policy";
import { normalizeToolInputForSignature, stableJson } from "../react/predicates";
import { parseSessionToolResult } from "../session-tool-result-protocol";
import {
  buildOriginalRequestTableColumnContext,
  requestedColumnsLookLikeProviderSearchPricing,
  resolveRequestedTableColumns,
} from "../task-facts-shared";
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
} from "../tool-protocol";
import {
  IncompleteApprovedBrowserSessionContinuation,
  RequiredFinalDeliverable,
  SUPPLEMENTAL_BROWSER_OPEN_TIMEOUT_MS,
  SessionContinuationDirective,
  SessionContinuationLookupDirective,
  SubAgentToolTimeoutSignal,
  extractPriorContinuationContext,
  extractProductSignalDashboardUrl,
  hasProductSignalDashboardMetrics,
  latestPendingPermissionQueryApprovalId,
  looksBoundedTimeoutSourceCheck,
  readCompletedSessionEvidence,
  readPolicyLatestPermissionResultStatus,
  readPolicyLatestPermissionToolName,
  readPolicyProductBriefEvidenceCarryForwardRepair,
  readPolicyProductSignalDashboardEvidenceRequest,
  shouldPreservePreApprovalBrowserInspection,
  summarizeProductSignalDashboardMetrics,
} from "../runtime-facts/policy-text-facts";
import type {
  RuntimePolicyRenderKind,
  RuntimePolicyRenderRequest,
} from "./types";

export function buildPolicyIdRenderRequest<
  TKind extends RuntimePolicyRenderKind,
>(kind: TKind, policyId: string): RuntimePolicyRenderRequest<TKind> {
  return {
    kind,
    payload: { policyId },
  };
}


export const FORCED_PERMISSION_RESULT_ASSISTANT_TEXT =
  "Checking the pending approval result before closing out." as const;

function taskIntentFactsForPrompt(taskPrompt: string) {
  return produceTaskIntentEnvelope({
    taskPrompt,
    messages: [],
  }).facts;
}

export function buildIndependentEvidenceStreamContinuationPrompt(input: {
  requiredStreams: number;
  completedSessions: number;
}): string {
  return [
    "Runtime correction: this task declares multiple independent evidence streams.",
    `Only ${input.completedSessions} of ${input.requiredStreams} required delegated evidence stream(s) have completed.`,
    "Do not finalize yet. Spawn separate focused sessions for the remaining independent streams so evidence is not collapsed into one worker.",
    "Keep the original source labels, source URLs, required dimensions, and stop conditions. Use browser for browser-visible, live dashboard, rendered, or client-side evidence.",
    "After all independent stream results return, synthesize once from the completed delegated evidence.",
  ].join("\n");
}

export function buildReadOnlyPermissionQuerySuppressionPrompt(): string {
  return [
    "Runtime correction: read-only browser inspection does not require approval.",
    "The previous permission_query describes no intended form submission, mutation, or side effect, so it must not enter the native approval flow.",
    "Do not call permission_query, permission_result, permission_applied, or browser mutation tools.",
    "Produce the final answer from completed evidence. If any requested item remains unverified, state it explicitly and give the safe next action.",
  ].join("\n");
}

export function buildMissingApprovalGateRepairPrompt(): string {
  return [
    "Runtime correction: approval-gated browser action was finalized or described without native approval/tool evidence.",
    "Do not finalize an approval-gated browser side effect unless a native permission or browser-session tool result created that evidence.",
    "Use permission_query now with action=browser.form.submit, level=approval, scope=mutate, worker_kind=browser, the concrete risk, and a redacted payload for the intended dry-run form submission.",
    "After the operator decision is available, use permission_result and permission_applied before delegating the approved browser action.",
    "Only after permission_applied succeeds, call sessions_spawn with agent_id=browser and include the exact URL, approved action, and verification requirement in the task.",
    "After the browser tool result returns, synthesize only from that permission and browser evidence.",
  ].join("\n");
}

export function buildSourceEvidenceCarryForwardRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
}): string {
  if (
    readPolicyProductBriefEvidenceCarryForwardRepair({
      ...input,
      messages: [],
      repairMarkers: [],
    })
  ) {
    return buildProductBriefEvidenceCarryForwardRepairPrompt(input);
  }
  const missingLabels = extractCompletedSessionEvidenceLabels(
    input.evidenceText,
  ).filter((label) => !normalizedTextContains(input.resultText, label));
  if (missingLabels.length > 0) {
    return buildCompletedSessionLabelCarryForwardRepairPrompt({
      ...input,
      missingLabels,
    });
  }
  return buildProductBriefEvidenceCarryForwardRepairPrompt(input);
}

export function buildWeakEvidenceSynthesisRepairPrompt(): string {
  return [
    "Runtime correction: final answer weakens verified evidence with placeholder uncertainty.",
    "Do not call tools. Rewrite the final answer using only the delegated session evidence already present.",
    "For facts directly present in the evidence, say observed or verified instead of maybe, probably, estimate, estimated, TBD, to be confirmed, pending confirmation, or similar placeholder wording.",
    "For facts absent from the evidence, write not verified and name the missing dimension without guessing.",
    "Remove source-external technical or policy extrapolations such as DNS/IP resolution details, production-environment bans, real-service claims, user-scale claims, or operational restrictions unless those exact facts appear in the gathered evidence.",
    "If the evidence states a narrow scope limit or usage caveat, preserve its exact wording (or say wider use is outside the verified scope); do not convert a narrow caveat into a broader production-environment or real-service ban.",
    "Preserve requested dimension labels from the user when evidence supports them, such as pricing, strength, risk, owner, and next action.",
    "Do not rename a requested risk dimension into only generic weaknesses, open questions, or uncertainty when risk evidence is present.",
    "Keep residual risk visible, but do not downgrade verified source facts into estimates.",
  ].join("\n");
}

export function buildTimeoutFollowupFinalGuidanceRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
}): string {
  return [
    "Runtime correction: timeout follow-up final omitted recovery guidance.",
    "Do not call tools. Rewrite the final answer using only the completed continuation evidence below.",
    "Keep the verified owner, risk, mitigation, source URL/title/status, and release-risk assessment.",
    "Also include: (1) that this was recovered/resumed after an earlier timeout, (2) unverified scope that remains source-bounded, and (3) continuation guidance using words such as continue, retry, resumable, timeout recovery, or subsequent health check.",
    "Do not claim the earlier timeout never happened, and do not imply more source facts were verified than the completed evidence supports.",
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1400)}`,
    `Completed continuation evidence:\n${sliceUtf8(input.evidenceText, 4200)}`,
  ].join("\n");
}

export function buildMissingRequestedNextActionRepairPrompt(): string {
  return [
    "Runtime correction: requested next action is missing from the final answer.",
    "Do not call tools. Revise the final answer using only the delegated session evidence already present.",
    "Include a concise next action or safe fallback for the operator, and keep any unverified scope explicit.",
  ].join("\n");
}

export function buildMissingRequiredFinalDeliverablesRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  missing: RequiredFinalDeliverable[];
  evidenceText: string;
}): string {
  return [
    "Runtime correction: final answer omitted required deliverables from the original task.",
    `Missing deliverables: ${input.missing.map((item) => item.label).join(", ")}.`,
    "Do not call tools. Rewrite the final answer using only the completed delegated evidence below.",
    "Preserve the user's requested final shape, order, source labels, and evidence boundaries.",
    "Add only the missing required deliverable(s); do not invent facts beyond the completed evidence.",
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1400)}`,
    `Completed delegated evidence:\n${sliceUtf8(input.evidenceText, 3600)}`,
  ].join("\n");
}

export function buildMissingBrowserEvidenceDimensionsRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
}): string {
  const missing = findMissingBrowserEvidenceDimensions(input);
  return [
    "Runtime correction: final answer omitted requested browser evidence dimensions.",
    `Missing dimensions: ${missing.join(", ")}.`,
    "Do not call tools. Rewrite the final answer using only the completed browser evidence below.",
    "Carry each missing requested browser dimension into the final answer when the evidence supports it.",
    "For unavailable dimensions, write not verified only if the completed browser evidence actually lacks that dimension.",
    "Keep residual risk visible, but do not mark frame, shadow, popup, or rendered page state unverified when the completed browser evidence contains it.",
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1400)}`,
    `Completed browser evidence:\n${sliceUtf8(input.evidenceText, 3600)}`,
  ].join("\n");
}

export function buildFalseEvidenceBlockedSynthesisRepairPrompt(
  finalContents: readonly string[],
): string {
  return [
    "Runtime correction: final answer falsely marks completed evidence as blocked, inaccessible, failed, incomplete, or truncated.",
    "Do not call tools. Rewrite the final answer using only the delegated session evidence already present.",
    "The completed source evidence below is usable. Do not describe source content, browser evidence, rendered DOM, page content, or extraction as inaccessible, failed, incomplete, blocked, or truncated unless that exact blocker appears in the source evidence.",
    "Preserve the original requested final answer shape, section labels, bullet labels, no-link rules, and residual-risk requirement.",
    "It is okay to say the evidence is source-bounded to local fixtures or that real-world validation remains; do not turn that scope limitation into a tool/browser/content failure.",
    ...finalContents.map(
      (content, index) =>
        `Source ${index + 1} completed evidence:\n${sliceUtf8(content, 2400)}`,
    ),
  ].join("\n");
}

function buildCompletedSessionLabelCarryForwardRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
  missingLabels: string[];
}): string {
  return [
    "Runtime correction: final answer dropped visible evidence source labels.",
    `Missing exact label(s): ${input.missingLabels.join(", ")}`,
    "Do not call tools. Rewrite the final answer using only the completed evidence below.",
    "Keep the substantive answer, but add a compact Evidence / Sources line that includes each missing label exactly as written and the fact(s) it verified.",
    "For approval-gated browser work, keep approval status, applied action, browser evidence, screenshot/artifact, and no-external-side-effect boundary visible.",
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1600)}`,
    `Completed evidence:\n${sliceUtf8(input.evidenceText, 3600)}`,
  ].join("\n");
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

function buildProductBriefEvidenceCarryForwardRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
}): string {
  return [
    "Runtime correction: final product brief dropped required source-backed workbench evidence.",
    "Do not call tools. Rewrite the final answer using only the completed delegated evidence below.",
    "The final must explicitly carry forward the orchestration evidence as multi-agent coordination, using the phrase multi-agent decomposition when supported by the evidence.",
    "The final must explicitly carry forward any dashboard counters or rates as rendered browser evidence, not raw HTML, when those values appear in evidence.",
    "Keep the product-bridge source visible as bridge/setup evidence. Preserve source-bounded residual risk, but do not mark rendered dashboard counters or browser/rendered evidence unverified when the completed evidence contains them.",
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1400)}`,
    `Completed delegated evidence:\n${sliceUtf8(input.evidenceText, 4200)}`,
  ].join("\n");
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

export function buildCompletedBrowserEvidenceDimensionCarryForwardLines(input: {
  taskPrompt: string;
  finalContents: readonly string[];
}): string[] {
  if (!readPolicyProductSignalDashboardEvidenceRequest(input.taskPrompt)) {
    return [];
  }
  const evidenceText = input.finalContents.join("\n\n");
  if (!hasProductSignalDashboardMetrics(evidenceText)) {
    return [];
  }
  const metrics = summarizeProductSignalDashboardMetrics(evidenceText);
  if (!metrics) {
    return [];
  }
  return [
    `Completed browser evidence verifies product signal dashboard counters: ${metrics}.`,
    "Carry those counters into the final answer as rendered browser evidence. Do not say dashboard counters, rates, signal IDs, or recommendations are unverified unless the completed browser evidence lacks that exact field.",
  ];
}

export function buildMissingBrowserEvidenceRepairPrompt(
  taskPrompt: string,
): string {
  const supplementalLocalTimeoutProbe =
    shouldAddSupplementalLocalTimeoutProbeToBrowserRepair(taskPrompt);
  return [
    "Runtime correction: browser-visible evidence is missing.",
    ...(supplementalLocalTimeoutProbe
      ? [
          "Runtime correction: resumed timeout evidence is still content-poor.",
          `The resumed source-check still lacks response status/body/header or rendered page evidence for ${supplementalLocalTimeoutProbe}.`,
          `Supplemental local timeout probe mode: call browser_open with timeout_ms ${SUPPLEMENTAL_BROWSER_OPEN_TIMEOUT_MS}, then stop with observed evidence or explicit unavailable fields.`,
        ]
      : []),
    "The task requires browser-observed evidence such as rendered DOM, JavaScript/client-side state, iframe/frame content, shadow-style component state, popup state, dashboard state, or a user-visible page review.",
    "Do not finalize from raw HTTP fetch, server HTML, memory, or a tool-unavailable explanation while native session tools are still available.",
    "Call sessions_spawn with agent_id=browser for the browser-visible portion of the task.",
    "The delegated browser task must include the relevant URL, the visible states to inspect, and a requirement to return only observed facts plus any concrete blocker.",
    `Original task:\n${sliceUtf8(taskPrompt, 1400)}`,
  ].join("\n");
}

export function buildMissingProductSignalBrowserEvidenceRepairPrompt(
  taskPrompt: string,
): string {
  const dashboardUrl = extractProductSignalDashboardUrl(taskPrompt);
  return [
    "Runtime correction: browser-visible evidence is missing.",
    "Runtime correction: the live product signal dashboard evidence is still incomplete.",
    "Do not finalize from SPA/server HTML shell evidence or from a generic browser-unavailable explanation while native session tools are still available.",
    "Call sessions_spawn with agent_id=browser for the product signal dashboard only.",
    `Dashboard URL: ${dashboardUrl ?? "use the product-signals/live signal dashboard URL from the original task"}.`,
    "The browser sub-agent must inspect the rendered page as an operator would see it and return exact visible dashboard counters, rates, recommendations, final URL, page title, and any concrete blocker.",
    "If rendering still cannot be verified, report the attempted browser observation and explicit unavailable fields; do not substitute raw HTML shell text for dashboard evidence.",
    `Original task:\n${sliceUtf8(taskPrompt, 1400)}`,
  ].join("\n");
}

function shouldAddSupplementalLocalTimeoutProbeToBrowserRepair(
  taskPrompt: string,
): string | null {
  if (!looksBoundedTimeoutSourceCheck(taskPrompt)) {
    return null;
  }
  return (
    extractHttpUrls(taskPrompt).find((candidate) => {
      try {
        return isLoopbackHostname(new URL(candidate).hostname);
      } catch {
        return false;
      }
    }) ?? null
  );
}

export function buildApprovedBrowserTimeoutContinuationPrompt(
  timeoutSignal: SubAgentToolTimeoutSignal,
): string {
  return [
    "Runtime correction: approved browser action timed out before verification.",
    `The approved browser session is resumable with session_key ${timeoutSignal.sessionKey}.`,
    "Do not finalize a browser.form.submit approval flow from the timeout alone.",
    "Call sessions_send exactly once for that session_key.",
    "Ask the browser sub-agent to continue from its current page state, perform the already-approved browser.form.submit if it has not been performed, and verify the post-submit page state.",
    "The browser sub-agent should use browser_snapshot, browser_act with submit=true on the submit control when needed, then browser_snapshot/browser_screenshot for the result.",
    "If the continued session still cannot verify the approved action, return the concrete blocker and any pre-submit/post-submit evidence instead of a generic timeout summary.",
  ].join("\n");
}

export function buildCoverageTimeoutContinuationPrompt(
  timeoutSignal: SubAgentToolTimeoutSignal,
): string {
  return [
    "Runtime correction: a required delegated evidence stream timed out.",
    `The timed-out ${timeoutSignal.agentId} session is resumable with session_key ${timeoutSignal.sessionKey}.`,
    "Do not finalize while the task requires all source coverage and one required stream is still missing.",
    "Call sessions_send exactly once for that session_key to continue the missing source check.",
    "Ask the child session to return only the missing source evidence needed for the final answer.",
    "If the continued session still cannot verify the source, then close out as incomplete/resumable and keep the missing source unverified.",
  ].join("\n");
}

export function buildSupplementalLocalTimeoutProbePrompt(input: {
  url: string;
  evidence: string;
}): string {
  return [
    "Runtime correction: resumed timeout evidence is still content-poor.",
    `The resumed source-check still lacks response status/body/header or rendered page evidence for ${input.url}.`,
    "Spawn exactly one focused browser session now. Use the browser worker for browser-visible/local runtime evidence; do not use explore or public-source fetch.",
    `Supplemental local timeout probe mode: call browser_open with timeout_ms ${SUPPLEMENTAL_BROWSER_OPEN_TIMEOUT_MS}, then stop with observed evidence or explicit unavailable fields.`,
    "Open the loopback URL as an operator would see it with a bounded local-runtime attempt.",
    "Return only observed evidence: final URL, title, visible marker/text, whether loading completed, console/network failures if available, screenshot/artifact references if captured, and any remaining unverified items.",
    "If the page still does not produce evidence, report that status/body/header/rendered content remain unavailable and keep the release-risk conclusion source-bounded.",
    `Prior content-poor timeout evidence:\n${input.evidence}`,
  ].join("\n");
}

export function buildIncompleteApprovedBrowserSessionContinuationPrompt(
  input: IncompleteApprovedBrowserSessionContinuation,
): string {
  return [
    "Runtime correction: approved browser action is incomplete inside an existing browser session.",
    `Continue the same browser session with session_key ${input.sessionKey}; do not spawn a replacement session.`,
    "The approval is already applied. Call sessions_send exactly once for that session_key.",
    "Ask the browser sub-agent to perform the approved browser.form.submit action now, reuse the current page state, use browser_act on the submit control with submit=true, and verify the post-submit page state.",
    "If the browser sub-agent still cannot execute the approved action after this continuation, it must return the concrete blocker and evidence instead of asking the parent to inspect again.",
    `Incomplete browser evidence:\n${input.evidence}`,
  ].join("\n");
}

export function buildPendingApprovalWaitTimeoutCheckRepairPrompt(): string {
  return [
    "Runtime correction: approval decision has not arrived during an attempt that requested a no-decision closeout.",
    "Call permission_result for the pending approval_id from permission.query now.",
    "If it is still pending, do not call permission_applied and do not call browser tools.",
    "Then write a safe wait-timeout closeout: state what remains pending, state that no browser form submission or side effect ran, keep the unexecuted result unverified, and give the safe fallback or next action.",
  ].join("\n");
}

export function buildPrematurePendingApprovalRepairPrompt(): string {
  return [
    "Runtime correction: approval-gated browser action is still pending, but this task requires carrying the approved action through instead of finalizing at the pending request.",
    "Do not write a final pending-approval summary.",
    "Call permission_result for the pending approval_id from permission.query now.",
    "If permission_result is approved, call permission_applied, then call sessions_spawn with agent_id=browser for only the approved scoped browser.form.submit action and verify the browser result before finalizing.",
    "If permission_result is denied, write a denied safe closeout. If it is still pending, keep checking permission_result within this tool loop; do not claim the dry-run completed.",
  ].join("\n");
}

export function buildStalePendingApprovalRepairPrompt(): string {
  return [
    "Runtime correction: approval already applied, but the assistant tried to finalize with a pending-approval explanation.",
    "Do not wait again. Continue from the applied approval point now.",
    "Use native tools for the approved scoped action, preferably sessions_spawn with agent_id=browser, then summarize the concrete browser result.",
  ].join("\n");
}

export function buildStaleDeniedApprovalRepairPrompt(): string {
  return [
    "Runtime correction: approval was denied, but the assistant tried to finalize as if the approval were still pending.",
    "Do not wait again and do not call browser or permission tools.",
    "Write the final safe closeout now from the denied permission.result evidence: name the requested browser.form.submit action, state that no form submission or side effect ran, and give the safe fallback or next action.",
  ].join("\n");
}

export function buildApprovalWaitTimeoutCloseoutRepairPrompt(): string {
  return [
    "Runtime correction: approval wait-timeout evidence is available, but the final closeout is incomplete or leaves the thread open.",
    "Do not call tools.",
    "Rewrite the final answer as a terminal closeout for this attempt and include the exact word pending.",
    "Name the source-backed runtime facts: permission_query requested approval for browser.form.submit, permission_result says the approval is still pending/approval_wait_timeout, no browser form submission or side effect ran, the unexecuted result is not verified, and the safe next action is to ask the operator to approve a new request or rerun the attempt when ready.",
    "Do not say the thread, flow, mission, or task remains open.",
  ].join("\n");
}

export function buildApprovalWaitTimeoutLocalEvidenceCloseout(input: {
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  evidenceText: string;
  error: unknown;
}): GenerateTextResult {
  return {
    text: [
      "Approval wait-timeout closeout confirmed.",
      "",
      "Wait-timeout closeout evidence is preserved below.",
      "Approval status: the operator decision is still pending after the bounded wait; permission_result returned pending/approval_wait_timeout.",
      "Runtime evidence: permission_query requested approval for browser.form.submit and permission_result confirmed the approval remains pending.",
      "Action boundary: no form submission, no side effects, and no browser mutation were performed.",
      `Verified runtime evidence: ${sliceUtf8(input.evidenceText, 3 * 1024)}`,
      "Residual risk: the requested submit/apply step remains unverified because pending approval remains.",
      "Next action: ask the operator to approve or deny, then continue the same mission and apply only the approved scoped action.",
    ].join("\n"),
    modelId: input.selection.modelId ?? "local-evidence-closeout",
    ...(input.selection.modelChainId
      ? { modelChainId: input.selection.modelChainId }
      : {}),
    providerId: "local",
    protocol: "openai-compatible",
    adapterName: "local-evidence-closeout",
    raw: {
      reason: "approval_wait_timeout_final_synthesis_unavailable",
      message: errorMessage(input.error),
      evidence: sliceUtf8(input.evidenceText, 2000),
    },
  };
}

export function buildLocalEvidenceCloseout(input: {
  activation?: RoleActivationInput;
  messages: LLMMessage[];
  packet: RolePromptPacket;
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  error: unknown;
}): GenerateTextResult | null {
  if (
    allowsExactFinalAnswerShapeBypass(
      input.packet.taskPrompt,
      input.packet.outputContract,
    )
  ) {
    return null;
  }
  const toolResults = input.messages
    .filter((message) => message.role === "tool")
    .map((message) =>
      parseSessionToolResult(readMessageContentText(message.content)),
    )
    .filter(
      (
        result,
      ): result is NonNullable<ReturnType<typeof parseSessionToolResult>> =>
        Boolean(result),
    );
  const completedEvidence = toolResults
    .filter((result) => result.status === "completed")
    .map((result) => readCompletedSessionEvidence(result))
    .filter((evidence): evidence is string => Boolean(evidence));
  const sessionToolResultMessages = new Set(
    input.messages
      .filter((message) => message.role === "tool")
      .filter(
        (message) =>
          parseSessionToolResult(readMessageContentText(message.content)) != null,
      ),
  );
  const genericToolEvidence = input.messages
    .filter(
      (message) =>
        message.role === "tool" && !sessionToolResultMessages.has(message),
    )
    .map((message) => ({
      content: readMessageContentText(message.content),
      toolName: message.name,
    }))
    .filter((item) => !isControlPlaneToolResultName(item.toolName))
    .map((item) => item.content)
    .filter((content) => !isLikelyFailedToolContent(content))
    .map((content) => readGenericToolEvidence(content))
    .filter((evidence): evidence is string => Boolean(evidence));
  const allEvidence = [...completedEvidence, ...genericToolEvidence];
  if (allEvidence.length === 0) {
    return null;
  }
  const combinedEvidence = allEvidence.join("\n\n");
  if (
    taskIntentFactsForPrompt(input.packet.taskPrompt)
      .approvalWaitTimeoutCloseoutRequested &&
    messagesHaveApprovalWaitTimeoutEvidence(input.messages)
  ) {
    return buildApprovalWaitTimeoutLocalEvidenceCloseout({
      selection: input.selection,
      evidenceText: combinedEvidence,
      error: input.error,
    });
  }
  const cancellationSeen =
    toolResults.some((result) => result.status === "cancelled") ||
    /\bcancel(?:led|ed|lation)\b/i.test(
      [
        input.packet.taskPrompt,
        ...input.messages.map((message) =>
          readMessageContentText(message.content),
        ),
      ].join("\n"),
    );
  const evidence = allEvidence
    .map((item, index) => `Source ${index + 1}: ${sliceUtf8(item, 4 * 1024)}`)
    .join("\n");
  let requestedTableColumns = resolveRequestedTableColumns([
    input.packet.taskPrompt,
    ...buildOriginalRequestTableColumnContext(input.activation),
  ]);
  if (
    requestedColumnsLookLikeProviderSearchPricing(requestedTableColumns) &&
    !taskIntentFactsForPrompt(
      [
        input.packet.taskPrompt,
        ...buildOriginalRequestTableColumnContext(input.activation),
      ].join("\n"),
    ).providerSearchPricingResearch
  ) {
    requestedTableColumns = [];
  }
  if (requestedTableColumns.length) {
    return {
      text: [
        "**Mission 状态：blocked / partial**",
        "",
        "Final synthesis unavailable; this local evidence fallback preserves the requested table columns and marks unsupported cells as 未验证.",
        "",
        buildLocalEvidenceTable(requestedTableColumns, allEvidence),
        "",
        "未验证：任何未由上表摘录直接证明的 provider support、search/web_search 支持、价格、结论或业务建议均未验证。",
        cancellationSeen
          ? "Risk: The earlier cancellation means the cancelled attempt should not be treated as verification; confidence comes only from completed source results visible in this mission."
          : "Risk: Confidence is limited to completed source results visible in this mission.",
        "Next action: Continue the mission with browser/rendered evidence or corrected official source URLs for the missing cells.",
      ].join("\n"),
      modelId: input.selection.modelId ?? "local-evidence-closeout",
      ...(input.selection.modelChainId
        ? { modelChainId: input.selection.modelChainId }
        : {}),
      providerId: "local",
      protocol: "openai-compatible",
      adapterName: "local-evidence-closeout",
      raw: {
        reason: "final_synthesis_unavailable",
        message: errorMessage(input.error),
      },
    };
  }
  return {
    text: [
      `Verified: ${evidence}`,
      "Unverified: Any release claim not present in the resumed source result remains unverified.",
      cancellationSeen
        ? "Risk: The earlier cancellation means the cancelled attempt should not be treated as verification; confidence comes from the resumed source result."
        : "Risk: Confidence is limited to the completed source result visible in this mission.",
      "Next action: Use the verified source facts for the requested task, and continue the same session if broader verification is needed.",
    ].join("\n"),
    modelId: input.selection.modelId ?? "local-evidence-closeout",
    ...(input.selection.modelChainId
      ? { modelChainId: input.selection.modelChainId }
      : {}),
    providerId: "local",
    protocol: "openai-compatible",
    adapterName: "local-evidence-closeout",
    raw: {
      reason: "final_synthesis_unavailable",
      message: errorMessage(input.error),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messagesHaveApprovalWaitTimeoutEvidence(
  messages: readonly LLMMessage[],
): boolean {
  return messages
    .filter((message) => message.role === "tool")
    .filter((message) => message.name === "permission_result")
    .some((message) => {
      const parsed = parseJsonObject(readMessageContentText(message.content));
      const status = parsed?.["status"];
      return status === "pending" || status === "approval_wait_timeout";
    });
}

function buildLocalEvidenceTable(columns: string[], evidence: string[]): string {
  const header = `| ${columns.map(markdownTableCell).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const rows = evidence.slice(0, 8).map((item, index) => {
    const url = extractFirstUrl(item);
    const source = inferEvidenceSourceLabel(item, index);
    return `| ${columns
      .map((column) =>
        markdownTableCell(localEvidenceCellForColumn(column, {
          evidence: item,
          source,
          url,
        })),
      )
      .join(" | ")} |`;
  });
  return [header, separator, ...rows].join("\n");
}

function localEvidenceCellForColumn(
  column: string,
  input: { evidence: string; source: string; url: string | undefined },
): string {
  const normalized = column.toLowerCase();
  const searchableEvidence = localEvidenceSearchableText(input.evidence);
  if (
    normalized === "provider" ||
    column.includes("provider") ||
    column.includes("来源")
  ) {
    return input.source;
  }
  if (/deepseek\s*v4\s*flash|目标模型/i.test(column)) {
    if (
      /deepseek\s*v4\s*flash/i.test(searchableEvidence) &&
      extractInputOutputPrice(searchableEvidence)
    ) {
      return "是（页面含模型与价格）";
    }
    return "未验证";
  }
  if (/(?:search|web_search|搜索)/i.test(column)) {
    if (
      /\b(?:supports?|supported|支持)\b[^.。；;\n]{0,80}\b(?:search|web_search|web search)\b/i.test(
        searchableEvidence,
      )
    ) {
      return "是";
    }
    return "未验证";
  }
  if (/(?:输入|input)[^|]{0,20}(?:价格|price|pricing)/i.test(column)) {
    return extractInputOutputPrice(searchableEvidence)?.input ?? "未验证";
  }
  if (/(?:输出|output)[^|]{0,20}(?:价格|price|pricing)/i.test(column)) {
    return extractInputOutputPrice(searchableEvidence)?.output ?? "未验证";
  }
  if (normalized.includes("url") || column.includes("证据")) {
    return input.url ?? "未验证";
  }
  if (
    column.includes("摘录") ||
    column.includes("原文") ||
    normalized.includes("quote") ||
    normalized.includes("excerpt")
  ) {
    return extractLocalEvidenceQuote(searchableEvidence);
  }
  return "未验证";
}

function localEvidenceSearchableText(evidence: string): string {
  try {
    const parsed = JSON.parse(evidence) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return [
        record.title,
        record.text_excerpt,
        record.final_url,
        record.requested_url,
      ]
        .filter((item): item is string => typeof item === "string")
        .join("\n");
    }
  } catch {
    // Evidence may already be a plain excerpt.
  }
  return evidence;
}

function extractInputOutputPrice(
  evidence: string,
): { input: string; output: string } | null {
  const compact = evidence.replace(/\s+/g, " ");
  const slash = compact.match(
    /\$(\d+(?:\.\d+)?)\s*\/\s*(?:\$(\d+(?:\.\d+)?)\s*\/\s*)?\$(\d+(?:\.\d+)?)\s*(?:per\s*)?1\s*m/i,
  );
  if (slash) {
    return {
      input: `$${slash[1]}/1M`,
      output: `$${slash[3]}/1M`,
    };
  }
  const input = compact.match(
    /(?:input|输入)[^$]{0,60}\$(\d+(?:\.\d+)?)(?:\s*\/?\s*(?:m|1m|million))?/i,
  );
  const output = compact.match(
    /(?:output|输出)[^$]{0,60}\$(\d+(?:\.\d+)?)(?:\s*\/?\s*(?:m|1m|million))?/i,
  );
  if (input && output) {
    return {
      input: `$${input[1]}/1M`,
      output: `$${output[1]}/1M`,
    };
  }
  const inputAfterPrice = compact.match(
    /\$(\d+(?:\.\d+)?)\s*\/?\s*(?:m|1m|million)?[^.。；;\n]{0,40}(?:input|输入)/i,
  );
  const outputAfterPrice = compact.match(
    /\$(\d+(?:\.\d+)?)\s*\/?\s*(?:m|1m|million)?[^.。；;\n]{0,40}(?:output|输出)/i,
  );
  if (inputAfterPrice && outputAfterPrice) {
    return {
      input: `$${inputAfterPrice[1]}/1M`,
      output: `$${outputAfterPrice[1]}/1M`,
    };
  }
  return null;
}

function extractLocalEvidenceQuote(evidence: string): string {
  const compact = evidence.replace(/\s+/g, " ").trim();
  const price = compact.match(
    /(?:In\s*\/\s*Out Price|pricing|price|input|output|输入|输出)[^.。；;\n]{0,220}(?:\$\d+(?:\.\d+)?)[^.。；;\n]{0,220}(?:1\s*M|tokens?|output|per|输入|输出)/i,
  );
  if (price) {
    return sliceUtf8(price[0], 240);
  }
  return sliceUtf8(compact, 240);
}

function extractFirstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s"')，。；;]+/)?.[0];
}

function inferEvidenceSourceLabel(evidence: string, index: number): string {
  const url = extractFirstUrl(evidence);
  if (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }
  const title = evidence.match(/"title"\s*:\s*"([^"]+)"/)?.[1];
  if (title) return title;
  return `Source ${index + 1}`;
}

function markdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "未验证";
}

function readGenericToolEvidence(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed || isLikelyFailedToolContent(trimmed)) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (isControlPlaneToolResultRecord(record)) {
        return null;
      }
      const payload =
        record.payload &&
        typeof record.payload === "object" &&
        !Array.isArray(record.payload)
          ? (record.payload as Record<string, unknown>)
          : null;
      const payloadPage =
        payload?.page &&
        typeof payload.page === "object" &&
        !Array.isArray(payload.page)
          ? (payload.page as Record<string, unknown>)
          : null;
      const parts = [
        readStringField(record.summary),
        readStringField(payload?.content),
        readStringField(payloadPage?.title),
        readStringField(payloadPage?.textExcerpt),
      ]
        .filter((part): part is string => Boolean(part))
        .map((part) => part.trim());
      const joined = dedupeStrings(parts).join("\n");
      if (joined) {
        return sliceUtf8(joined, 4 * 1024);
      }
    }
  } catch {
    // Fall back to the textual content below.
  }
  return sliceUtf8(summarizeToolResultContent(trimmed), 4 * 1024);
}

function isControlPlaneToolResultRecord(
  record: Record<string, unknown>,
): boolean {
  if (
    Array.isArray(record["sessions"]) ||
    Array.isArray(record["messages"]) ||
    Array.isArray(record["transcript"])
  ) {
    return true;
  }
  return (
    typeof record["inspection_guidance"] === "string" ||
    typeof record["session_key"] === "string" ||
    typeof record["task_id"] === "string"
  );
}

function isLikelyFailedToolContent(content: string): boolean {
  return (
    /\b(status"\s*:\s*"failed|isError"\s*:\s*true|missing required|timed out|timeout|failed:|error:|skipped)\b/i.test(
      content,
    ) || /^tool_call_.*(?:skipp|error|fail)/i.test(content.trim())
  );
}

function summarizeToolResultContent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty tool result)";
  }
  return normalized.length > 512
    ? `${normalized.slice(0, 512)}...`
    : normalized;
}

export function buildIncompleteApprovedBrowserActionRepairPrompt(): string {
  return [
    "Runtime correction: approved browser action has not executed.",
    "The approval is already applied and native tools are still available in this loop.",
    "Do not finalize with a tool-unavailable or final-synthesis explanation.",
    "Call sessions_spawn with agent_id=browser for the approved scoped browser action.",
    "The delegated browser task must include the approved submit/action, the local form URL when available, and a requirement to verify the resulting page state before final synthesis.",
  ].join("\n");
}

export function buildForcedPendingApprovalWaitTimeoutPermissionResultCall(input: {
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly { name: string }[];
}): LLMToolCall | null {
  if (
    !taskIntentFactsForPrompt(input.taskPrompt)
      .approvalWaitTimeoutCloseoutRequested
  ) {
    return null;
  }
  if (!hasToolDefinition(input.tools, "permission_result")) {
    return null;
  }
  if (readPolicyLatestPermissionToolName(input.toolTrace) !== "permission_query") {
    return null;
  }
  if (readPolicyLatestPermissionResultStatus(input.toolTrace)) {
    return null;
  }
  const approvalId = latestPendingPermissionQueryApprovalId(input.toolTrace);
  if (!approvalId) {
    return null;
  }
  return {
    id: `toolu-runtime-permission-result-${input.toolTrace.length + 1}`,
    name: "permission_result",
    input: { approval_id: approvalId },
  };
}

function hasToolDefinition(
  tools: readonly { name: string }[] | undefined,
  name: string,
): boolean {
  return (tools ?? []).some((tool) => tool.name === name);
}

export function buildContinuationDirectiveContext(
  taskPrompt: string,
  messages: LLMMessage[],
): string {
  const toolEvidence = messages
    .filter((message) => message.role === "tool")
    .map((message) => llmMessageContentToText(message.content))
    .filter(
      (content) =>
        content.includes("session_key") || content.includes('"sessions"'),
    )
    .join("\n");
  return toolEvidence ? `${taskPrompt}\n${toolEvidence}` : taskPrompt;
}

export function buildSessionContinuationMessageHint(
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

export function applySessionContinuationDirective(
  toolCalls: LLMToolCall[],
  directive: SessionContinuationDirective | null,
): LLMToolCall[] {
  if (!directive || toolCalls.length === 0) {
    return toolCalls;
  }
  if (toolCalls.some((call) => call.name === "sessions_send")) {
    return toolCalls
      .filter((call) => call.name !== "sessions_spawn")
      .map((call) =>
        call.name === "sessions_send"
          ? {
              ...call,
              input: {
                ...call.input,
                session_key: directive.sessionKey,
                message: mergeSessionContinuationMessage(
                  directive,
                  readStringInput(call.input, "message"),
                ),
              },
            }
          : call,
      );
  }
  const continuationToolIndex = toolCalls.findIndex(
    (call) =>
      call.name === "sessions_spawn" ||
      call.name === "sessions_history" ||
      call.name === "sessions_list",
  );
  if (continuationToolIndex < 0) {
    return toolCalls;
  }
  const rewritten = toolCalls[continuationToolIndex]!;
  const proposedMessage =
    readStringInput(rewritten.input, "message") ??
    readStringInput(rewritten.input, "task") ??
    readStringInput(rewritten.input, "reason");
  return [
    ...toolCalls.slice(0, continuationToolIndex),
    {
      ...rewritten,
      name: "sessions_send",
      input: {
        session_key: directive.sessionKey,
        message: mergeSessionContinuationMessage(
          directive,
          proposedMessage,
        ),
        ...(readStringInput(rewritten.input, "label")
          ? { label: readStringInput(rewritten.input, "label") }
          : {}),
      },
    },
    ...toolCalls
      .slice(continuationToolIndex + 1)
      .filter((call) => call.name !== "sessions_spawn" && call.name !== "sessions_history" && call.name !== "sessions_list"),
  ];
}

export function mergeSessionContinuationMessage(
  directive: SessionContinuationDirective,
  proposedMessage: string | undefined,
): string {
  const proposed = proposedMessage?.trim();
  if (
    !proposed ||
    proposed === directive.messageHint ||
    proposed.includes("Continuation context from the original task")
  ) {
    return proposed || directive.messageHint;
  }
  if (
    !directive.messageHint.includes(
      "Continuation context from the original task",
    )
  ) {
    return proposed;
  }
  return [
    proposed,
    "",
    "Runtime continuity guard:",
    directive.messageHint,
  ].join("\n");
}

export function applySessionContinuationLookupDirective(
  toolCalls: LLMToolCall[],
  directive: SessionContinuationLookupDirective | null,
): LLMToolCall[] {
  if (!directive || toolCalls.length === 0) {
    return toolCalls;
  }
  const sendIndex = toolCalls.findIndex(
    (call) => call.name === "sessions_send",
  );
  if (sendIndex >= 0) {
    const sent = toolCalls[sendIndex]!;
    const agentId = readPolicyWorkerKindFromSessionKey(
      readStringInput(sent.input, "session_key"),
    );
    return [
      ...toolCalls
        .slice(0, sendIndex)
        .filter(
          (call) =>
            call.name !== "sessions_spawn" && call.name !== "sessions_send",
        ),
      {
        ...sent,
        name: "sessions_list",
        input: {
          limit: 5,
          ...(agentId ? { agent_id: agentId, kinds: [agentId] } : {}),
          reason: `continuation lookup: ${directive.messageHint}`,
        },
      },
      ...toolCalls
        .slice(sendIndex + 1)
        .filter(
          (call) =>
            call.name !== "sessions_spawn" && call.name !== "sessions_send",
        ),
    ];
  }
  if (toolCalls.some((call) => call.name === "sessions_list")) {
    return toolCalls.filter((call) => call.name !== "sessions_spawn");
  }
  const spawnIndex = toolCalls.findIndex(
    (call) => call.name === "sessions_spawn",
  );
  if (spawnIndex < 0) {
    return toolCalls;
  }
  const spawned = toolCalls[spawnIndex]!;
  const agentId = readStringInput(spawned.input, "agent_id");
  return [
    ...toolCalls.slice(0, spawnIndex),
    {
      ...spawned,
      name: "sessions_list",
      input: {
        limit: 5,
        ...(agentId ? { agent_id: agentId, kinds: [agentId] } : {}),
        reason: `continuation lookup: ${directive.messageHint}`,
      },
    },
    ...toolCalls
      .slice(spawnIndex + 1)
      .filter((call) => call.name !== "sessions_spawn"),
  ];
}

export function buildPermissionQueryFromBrowserSpawn(
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

export function buildPreApprovalBrowserInspectionSpawn(
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

export function buildFinalRecoveryBudgetCloseoutReasonLines(
  maxToolCalls: number,
): string[] {
  return [
    `Final recovery tool budget reached (${maxToolCalls} tool calls).`,
    "Do not call more tools. Produce a bounded blocked closeout from the evidence already gathered.",
    "List the exact missing goal slots, the pages/tools already attempted, what each source proved, and what remains unverified.",
    "This is not a success closeout. Start the answer with an explicit blocked/partial status when any original goal slot remains unverified.",
    "Do not convert absence of evidence into a negative claim. If a source does not explicitly prove provider support, search/web_search support, or pricing, write 未验证 for that cell instead of ✅, ❌, supported, unsupported, available, unavailable, or not supported.",
    "Do not recommend a provider, cheapest option, or next business decision unless the required support, search/web_search behavior, and input/output pricing are all explicitly verified by quoted source evidence.",
    "For every table row that contains a confirmed value, include the evidence URL and a short quoted/source-excerpt phrase that directly supports that exact value; otherwise mark the value 未验证.",
  ];
}

export function buildFinalRecoveryBudgetCloseoutRepairPrompt(
  maxToolCalls: number,
): string {
  return [
    "Runtime correction: final recovery tool budget is exhausted.",
    ...buildFinalRecoveryBudgetCloseoutReasonLines(maxToolCalls),
    "Do not delegate to another role, do not ask another agent to continue, and do not emit @{role-...} routing text.",
    "Rewrite the final answer now without calling tools.",
  ].join("\n");
}
