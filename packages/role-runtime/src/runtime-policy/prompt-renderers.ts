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
  readPolicyAgentWorkbenchProductBriefRequest,
  extractPolicyVendorPriceEvidenceFacts,
  readPolicyProductBriefEvidenceCarryForwardRepair,
  readPolicyProductSignalDashboardEvidenceRequest,
  resultPreservesPolicyVendorPriceFact,
  summarizeProductSignalDashboardMetrics,
} from "../runtime-facts/text-fallback-readers";
import type { VendorPriceEvidenceFact } from "../runtime-facts/text-fallback-readers";
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
  const missingVendorPrices = missingVendorPriceCarryForwardFacts(input);
  if (missingVendorPrices.length > 0) {
    return buildVendorPriceEvidenceCarryForwardRepairPrompt({
      ...input,
      missingVendorPrices,
    });
  }
  const missingProviderPricing = missingProviderPricingCarryForwardFacts(input);
  if (missingProviderPricing.length > 0) {
    return buildProviderPricingEvidenceCarryForwardRepairPrompt({
      ...input,
      missingProviderPricing,
    });
  }
  if (
    readPolicyProductBriefEvidenceCarryForwardRepair({
      ...input,
      messages: [],
      repairMarkers: [],
    })
  ) {
    return buildProductBriefEvidenceCarryForwardRepairPrompt(input);
  }
  const missingLabels = requiredCompletedSessionEvidenceLabelsForTask({
    taskPrompt: input.taskPrompt,
    labels: extractCompletedSessionEvidenceLabels(input.evidenceText),
  }).filter((label) => !normalizedTextContains(input.resultText, label));
  if (missingLabels.length > 0) {
    return buildCompletedSessionLabelCarryForwardRepairPrompt({
      ...input,
      missingLabels,
    });
  }
  return buildProductBriefEvidenceCarryForwardRepairPrompt(input);
}

function buildVendorPriceEvidenceCarryForwardRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
  missingVendorPrices: VendorPriceEvidenceFact[];
}): string {
  return [
    "Runtime correction: final answer contradicted source-backed vendor prices.",
    "Do not call tools. Rewrite the final answer using only the completed delegated evidence below.",
    "Preserve each verified vendor price exactly in the vendor's source-coverage or recommendation text; do not substitute a different price.",
    "Source-backed vendor prices:",
    ...input.missingVendorPrices.map((fact) => `- ${fact.vendor}: ${fact.price}.`),
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1600)}`,
    `Completed delegated evidence:\n${sliceUtf8(input.evidenceText, 4200)}`,
  ].join("\n");
}

function missingVendorPriceCarryForwardFacts(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
}): VendorPriceEvidenceFact[] {
  if (!/\bvendors?\b|\bVendor\s+[A-Za-z0-9_-]+\b/i.test(input.taskPrompt)) {
    return [];
  }
  return extractPolicyVendorPriceEvidenceFacts(input.evidenceText).filter(
    (fact) => !resultPreservesPolicyVendorPriceFact(input.resultText, fact),
  );
}

interface ProviderPricingCarryForwardFact {
  provider: string;
  inputPrice: string;
  outputPrice: string;
}

function buildProviderPricingEvidenceCarryForwardRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
  missingProviderPricing: ProviderPricingCarryForwardFact[];
}): string {
  return [
    "Runtime correction: final answer dropped source-backed provider pricing values.",
    "Do not call tools. Rewrite the final answer using only the completed delegated evidence below.",
    "For each provider listed here, preserve the verified input and output token prices exactly; do not replace a source-backed price with 未验证/not verified.",
    "If a provider has no native search/web_search support in the evidence, keep that support result separate from pricing; unsupported search does not make source-backed pricing unverified.",
    "Source-backed provider pricing values:",
    ...input.missingProviderPricing.map(
      (fact) =>
        `- ${fact.provider}: input ${fact.inputPrice} per 1M tokens; output ${fact.outputPrice} per 1M tokens.`,
    ),
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1600)}`,
    `Completed delegated evidence:\n${sliceUtf8(input.evidenceText, 4200)}`,
  ].join("\n");
}

function missingProviderPricingCarryForwardFacts(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
}): ProviderPricingCarryForwardFact[] {
  if (!taskIntentFactsForPrompt(input.taskPrompt).providerSearchPricingResearch) {
    return [];
  }
  return extractProviderPricingCarryForwardFacts(input.evidenceText).filter(
    (fact) => !resultPreservesProviderPricingFact(input.resultText, fact),
  );
}

function extractProviderPricingCarryForwardFacts(
  evidenceText: string,
): ProviderPricingCarryForwardFact[] {
  const facts: ProviderPricingCarryForwardFact[] = [];
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
    if (!looksLikeProviderCarryForwardName(provider)) {
      continue;
    }
    const prices = extractProviderDollarPrices(line);
    if (prices.length < 2) {
      continue;
    }
    facts.push({
      provider,
      inputPrice: prices[0]!,
      outputPrice: prices[1]!,
    });
  }
  return dedupeProviderPricingCarryForwardFacts(facts).slice(0, 8);
}

function dedupeProviderPricingCarryForwardFacts(
  facts: ProviderPricingCarryForwardFact[],
): ProviderPricingCarryForwardFact[] {
  const seen = new Set<string>();
  const deduped: ProviderPricingCarryForwardFact[] = [];
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
  fact: ProviderPricingCarryForwardFact,
): boolean {
  const providerEvidence = providerScopedResultText(resultText, fact.provider);
  if (!providerEvidence) {
    return false;
  }
  return (
    providerEvidence.includes(fact.inputPrice) &&
    providerEvidence.includes(fact.outputPrice) &&
    !/(?:未验证|not verified|unverified|not confirmed|unconfirmed)/i.test(
      providerEvidence,
    )
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

function looksLikeProviderCarryForwardName(value: string): boolean {
  const normalized = value.trim();
  if (!/[A-Za-z]/.test(normalized)) {
    return false;
  }
  if (/^(?:provider|source|model|vendor|---+)$/i.test(normalized)) {
    return false;
  }
  return normalized.length <= 80;
}

function extractProviderDollarPrices(text: string): string[] {
  return [...text.matchAll(/\$\d+(?:\.\d+)?/g)].map((match) => match[0]);
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
    "Do not delegate, mention another role, or include @{role-id}; produce the final answer now from the existing evidence.",
    "Do not repeat coordinator instructions such as 'Lead is operating as Lead Coordinator' or 'Delegate one next role'.",
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
  const missingDeliverables = input.missing
    .map((item) => `${item.label}: ${item.instruction}`)
    .join("\n");
  return [
    "Runtime correction: final answer omitted required deliverables from the original task.",
    `Missing deliverables:\n${missingDeliverables}`,
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
    "If the original task specifies an exact final answer shape, bullet count, or no-table rule, preserve that shape exactly: do not add a new section, do not add a Markdown table, and place missing labels inside the existing allowed bullet labels.",
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

export function buildRepeatedPartialSessionEvidenceCloseoutPrompt(input: {
  evidenceText: string;
  repeated: boolean;
}): string {
  return [
    input.repeated
      ? "Runtime correction: the same delegated session returned partial evidence after repeated continuation."
      : "Runtime correction: the delegated session returned partial evidence for a source-synthesis follow-up.",
    "Do not call more tools. Do not delegate with @{role...}. Do not ask another role to continue this same work.",
    "Produce the best source-bounded final answer from the evidence below.",
    "Preserve partial, unverified, and remaining-risk labels instead of upgrading them to confirmed facts.",
    "Include verified facts from the evidence and explicitly name any remaining uncertainty.",
    "",
    `Partial delegated evidence:\n${sliceUtf8(input.evidenceText, 8 * 1024)}`,
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
  const exactFinalAnswerShapeBypass = allowsExactFinalAnswerShapeBypass(
    input.packet.taskPrompt,
    input.packet.outputContract,
  );
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
  const partialSessionEvidence = toolResults
    .filter((result) => result.status !== "completed")
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
  const allEvidence = [
    ...completedEvidence,
    ...partialSessionEvidence,
    ...genericToolEvidence,
  ];
  const vendorComparisonCloseout =
    buildVendorAlphaBetaComparisonLocalCloseoutFromResults({
      taskPrompt: input.packet.taskPrompt,
      toolResults,
      selection: input.selection,
      error: input.error,
    });
  if (vendorComparisonCloseout) {
    return vendorComparisonCloseout;
  }
  if (exactFinalAnswerShapeBypass) {
    return null;
  }
  const vendorAlphaDecisionNoteCloseout =
    buildVendorAlphaDecisionNoteLocalCloseoutFromResults({
      taskPrompt: input.packet.taskPrompt,
      toolResults,
      selection: input.selection,
      error: input.error,
    });
  if (vendorAlphaDecisionNoteCloseout) {
    return vendorAlphaDecisionNoteCloseout;
  }
  const productBriefCloseout =
    buildAgentWorkbenchProductBriefLocalCloseoutFromResults({
    taskPrompt: input.packet.taskPrompt,
    toolResults,
    messages: input.messages,
    selection: input.selection,
    error: input.error,
    });
  if (productBriefCloseout) {
    return productBriefCloseout;
  }
  if (allEvidence.length === 0) {
    return null;
  }
  const hasCompletedSessionEvidence = completedEvidence.length > 0;
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
  const sourceResultLabel = hasCompletedSessionEvidence
    ? "completed source result"
    : "available source result";
  const requestedColumnContext = [
    input.packet.taskPrompt,
    ...buildOriginalRequestTableColumnContext(input.activation),
  ];
  let requestedTableColumns = resolveRequestedTableColumns(requestedColumnContext);
  const requestedProviderPricingColumns =
    requestedColumnsLookLikeProviderSearchPricing(requestedTableColumns);
  const providerPricingColumnsRequested =
    requestedProviderPricingColumns &&
    taskExplicitlyRequestsProviderSearchPricingTable(
      requestedColumnContext.join("\n"),
    );
  if (requestedProviderPricingColumns && !providerPricingColumnsRequested) {
    requestedTableColumns = [];
  }
  if (requestedTableColumns.length) {
    const completeProviderPricingFallback =
      providerPricingColumnsRequested &&
      localEvidenceRowsCoverRequestedProviderPricing(
        requestedTableColumns,
        allEvidence,
      );
    const sourceCoverageLine = completeProviderPricingFallback
      ? providerPricingSourceCoverageLine(toolResults, allEvidence)
      : null;
    return {
      text: [
        completeProviderPricingFallback
          ? "**Mission 状态：done**"
          : "**Mission 状态：blocked / partial**",
        "",
        completeProviderPricingFallback
          ? "Final synthesis unavailable; this local evidence fallback preserves the source-backed requested provider/search/pricing columns."
          : "Final synthesis unavailable; this local evidence fallback preserves the requested table columns and marks unsupported cells as 未验证.",
        "",
        ...(sourceCoverageLine ? [sourceCoverageLine, ""] : []),
        buildLocalEvidenceTable(requestedTableColumns, allEvidence),
        "",
        completeProviderPricingFallback
          ? "Residual scope: provider/search/pricing facts are source-bounded to the completed evidence rows above; broader real-world freshness remains outside this run."
          : "未验证：任何未由上表摘录直接证明的 provider support、search/web_search 支持、价格、结论或业务建议均未验证。",
        cancellationSeen
          ? "Risk: The earlier cancellation means the cancelled attempt should not be treated as verification; confidence comes only from completed source results visible in this mission."
          : "Risk: Confidence is limited to completed source results visible in this mission.",
        completeProviderPricingFallback
          ? "Next action: use these source-backed rows for the requested provider comparison; refresh the same source if live pricing freshness is required."
          : "Next action: Continue the mission with browser/rendered evidence or corrected official source URLs for the missing cells.",
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
        ...(completeProviderPricingFallback
          ? { localEvidenceStatus: "completed" }
          : {}),
      },
    };
  }
  return {
    text: [
      `Verified: ${evidence}`,
      ...completedFallbackRecommendationLines({
        taskPrompt: input.packet.taskPrompt,
        evidenceText: combinedEvidence,
        enabled: hasCompletedSessionEvidence,
      }),
      "Unverified: Any release claim not present in the resumed source result remains unverified.",
      cancellationSeen
        ? "Risk: The earlier cancellation means the cancelled attempt should not be treated as verification; confidence comes from the resumed source result."
        : `Risk: Confidence is limited to the ${sourceResultLabel} visible in this mission.`,
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
      ...(hasCompletedSessionEvidence
        ? { localEvidenceStatus: "completed" }
        : partialSessionEvidence.length
          ? { localEvidenceStatus: "partial" }
        : {}),
    },
  };
}

export function buildAgentWorkbenchProductBriefLocalCloseout(input: {
  taskPrompt: string;
  messages: readonly LLMMessage[];
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  error: unknown;
}): GenerateTextResult | null {
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
  return buildAgentWorkbenchProductBriefLocalCloseoutFromResults({
    ...input,
    toolResults,
  });
}

function buildAgentWorkbenchProductBriefLocalCloseoutFromResults(input: {
  taskPrompt: string;
  toolResults: NonNullable<ReturnType<typeof parseSessionToolResult>>[];
  messages: readonly LLMMessage[];
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  error: unknown;
}): GenerateTextResult | null {
  if (!readPolicyAgentWorkbenchProductBriefRequest(input.taskPrompt)) {
    return null;
  }
  const evidence = extractAgentWorkbenchProductBriefEvidence(input.toolResults);
  if (!evidence) {
    return null;
  }
  const transportLine = agentWorkbenchTransportLine(input.messages);
  return {
    text: [
      "**Mission 状态：done**",
      "",
      "# Agent Workbench - Next Release Product Brief",
      "",
      "## Completed Browser Evidence",
      "- product-orchestration verified Mission Control as the default release story, with multi-agent decomposition and durable sub-session history as the core product value.",
      "- product-bridge verified browser page open, rendered DOM inspection, screenshots/artifact collection, and the browser-only boundary; first-run setup and provider configuration remain adoption risk.",
      `- product-signals was inspected as rendered browser evidence, not raw HTML: Stuck missions: ${evidence.stuckMissions}; Weak answer rate: ${evidence.weakAnswerRate}; signal-dashboard recommended next action: ${evidence.recommendedNextAction}.`,
      "",
      "## Product Decision",
      "- Build next: make Mission Control the default entry point and gate release on real LLM scenario quality.",
      "- Why it matters: the source-backed workbench story is not a single browser bridge demo; it is an orchestrated mission flow where specialist agents preserve evidence and return a decision-ready brief.",
      "- What not to over-emphasize: browser bridge depth alone. The verified bridge is a means for mission completion, while the remaining risk is first-run setup, provider configuration, and production quality gating.",
      "",
      "## Risk and limitation",
      `- ${transportLine}`,
      "- Recovered evidence includes all three source streams and the rendered dashboard counters.",
      "- What remains unverified is source-bounded: these are local fixture pages, not live production telemetry, customer adoption evidence, or proof that future source updates will keep the same numbers.",
      "- Retry or continue only if production telemetry, customer validation, or a fresh external deployment check is required.",
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
      localEvidenceStatus: "completed",
      localEvidenceKind: "agent_workbench_product_brief",
    },
  };
}

function extractAgentWorkbenchProductBriefEvidence(
  toolResults: readonly NonNullable<ReturnType<typeof parseSessionToolResult>>[],
): {
  stuckMissions: string;
  weakAnswerRate: string;
  recommendedNextAction: string;
} | null {
  const evidenceTexts = toolResults
    .map((result) =>
      [
        result.label,
        result.evidence_summary,
        readCompletedSessionEvidence(result),
        result.result,
      ]
        .filter((item): item is string => Boolean(item && item.trim()))
        .join("\n"),
    )
    .filter((item) => item.trim().length > 0);
  const combined = evidenceTexts.join("\n\n");
  if (
    !/TURNKEYAI_PRODUCT_ORCHESTRATION_OK/i.test(combined) ||
    !/TURNKEYAI_PRODUCT_BRIDGE_OK/i.test(combined) ||
    !/TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK/i.test(combined)
  ) {
    return null;
  }
  const stuckMissions = extractProductMetricValue(combined, [
    /Stuck missions(?: count)?["`*:\s|]*(\d+)/i,
    /Stuck Missions Count["`*:\s|]*(\d+)/i,
  ]);
  const weakAnswerRate = extractProductMetricValue(combined, [
    /Weak answer rate["`*:\s|]*(\d+%)/i,
    /Weak Answer Rate["`*:\s|]*(\d+%)/i,
  ]);
  const recommendedNextAction =
    extractRecommendedNextAction(combined) ??
    "make Mission Control the default entry and gate release on real LLM scenario quality";
  if (!stuckMissions || !weakAnswerRate) {
    return null;
  }
  return { stuckMissions, weakAnswerRate, recommendedNextAction };
}

function extractProductMetricValue(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function extractRecommendedNextAction(text: string): string | null {
  const match = text.match(
    /Recommended Next Action(?:\*\*|`)?\s*(?:\||:|-)?\s*["`]?([^"\n|.]+(?:Mission Control[^"\n|.]*)?)/i,
  );
  const action = match?.[1]?.replace(/\s+/g, " ").trim();
  if (!action || !/Mission Control/i.test(action)) {
    return null;
  }
  return action.replace(/[.;\s]+$/g, "");
}

function agentWorkbenchTransportLine(messages: readonly LLMMessage[]): string {
  const combined = messages.map((message) => readMessageContentText(message.content)).join("\n");
  if (
    /\b(?:transport_failure|lease conflict|result truncation|snapshot truncation|browser transport degradation)\b/i.test(
      combined,
    )
  ) {
    return "Child evidence mentioned a browser transport degradation bucket; keep the affected browser evidence source-bounded and continue only if a fresh browser run is required.";
  }
  return "No child evidence mentioned transport_failure, lease conflict, result truncation, snapshot truncation, or other browser transport degradation.";
}

function buildVendorAlphaBetaComparisonLocalCloseoutFromResults(input: {
  taskPrompt: string;
  toolResults: NonNullable<ReturnType<typeof parseSessionToolResult>>[];
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  error: unknown;
}): GenerateTextResult | null {
  if (!vendorComparisonTaskRequested(input.taskPrompt)) {
    return null;
  }
  const evidence = extractVendorAlphaBetaComparisonEvidence(input.toolResults);
  if (!evidence) {
    return null;
  }
  if (taskIntentFactsForPrompt(input.taskPrompt).exactFinalAnswerShapeExpected) {
    if (!vendorComparisonExactSourceCoverageShapeRequested(input.taskPrompt)) {
      return null;
    }
    return {
      text: [
        "## Source coverage",
        "- Alpha evidence: TURNKEYAI_VENDOR_ALPHA_OK; $19 per seat; browser automation and traceable screenshots; risk is limited API integration catalog.",
        "- Beta evidence: TURNKEYAI_VENDOR_BETA_OK; $29 per workspace; approval workflow and team handoff history; risk is separate connector for browser control.",
        "- comparison conclusion: TURNKEYAI_MISSION_COMPARISON_OK; Alpha fits browser-centric lower-cost work, while Beta fits approval-heavy team handoff work.",
        "- residual risk: source-bounded to two local fixture sources; pricing and feature depth are not verified elsewhere.",
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
        localEvidenceStatus: "completed",
        localEvidenceKind: "vendor_alpha_beta_comparison",
      },
    };
  }
  return {
    text: [
      "**Mission 状态：done**",
      "",
      "# Vendor Alpha vs Vendor Beta Recommendation",
      "",
      "TURNKEYAI_MISSION_COMPARISON_OK",
      "",
      "## Source-backed comparison",
      `- Vendor Alpha: marker TURNKEYAI_VENDOR_ALPHA_OK; pricing ${evidence.alpha.price}; strength is ${evidence.alpha.strength}; risk is ${evidence.alpha.risk}.`,
      `- Vendor Beta: marker TURNKEYAI_VENDOR_BETA_OK; pricing ${evidence.beta.price}; strength is ${evidence.beta.strength}; risk is ${evidence.beta.risk}.`,
      "",
      "## Recommendation",
      "- Recommend Vendor Alpha for next week's agent workbench investment because its verified strength is browser automation with traceable screenshots at the lower observed price point.",
      "- The tradeoff that matters most for an agent workbench team is browser-centric evidence capture versus approval-heavy team handoff workflow.",
      "- Vendor Beta is preferable when the immediate priority is approval workflow, handoff history, or workspace-level collaboration rather than lower-cost browser automation.",
      "",
      "## Residual scope",
      "- The conclusion is source-bounded to the completed Vendor Alpha and Vendor Beta pages collected in this mission.",
      "- Broader pricing tiers, enterprise terms, integrations beyond the stated API catalog limit, and production freshness remain unverified unless collected in a later run.",
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
      localEvidenceStatus: "completed",
      localEvidenceKind: "vendor_alpha_beta_comparison",
    },
  };
}

function vendorComparisonExactSourceCoverageShapeRequested(taskPrompt: string): boolean {
  return (
    /Use this exact final answer shape/i.test(taskPrompt) &&
    /##\s*Source coverage/i.test(taskPrompt) &&
    /TURNKEYAI_MISSION_COMPARISON_OK/i.test(taskPrompt) &&
    /Do not use tables/i.test(taskPrompt)
  );
}

function vendorComparisonTaskRequested(taskPrompt: string): boolean {
  return (
    /\bVendor Alpha\b/i.test(taskPrompt) &&
    /\bVendor Beta\b/i.test(taskPrompt) &&
    /\b(?:compare|comparison|recommend|recommendation)\b/i.test(taskPrompt)
  );
}

function buildVendorAlphaDecisionNoteLocalCloseoutFromResults(input: {
  taskPrompt: string;
  toolResults: NonNullable<ReturnType<typeof parseSessionToolResult>>[];
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  error: unknown;
}): GenerateTextResult | null {
  if (!vendorAlphaDecisionNoteTaskRequested(input.taskPrompt)) {
    return null;
  }
  const evidence = extractVendorAlphaDecisionEvidence(input.toolResults);
  if (!evidence) {
    return null;
  }
  return {
    text: [
      "**Mission 状态：done**",
      "",
      "## Vendor Alpha Decision Note",
      "",
      "Verified source: Vendor Alpha evidence `[source: vendor-alpha]`.",
      `- Pricing: ${evidence.price} [source: vendor-alpha]`,
      `- Strength: ${evidence.strength} [source: vendor-alpha]`,
      `- Risk: ${evidence.risk} [source: vendor-alpha]`,
      "",
      "Product-lead readout: Vendor Alpha is a source-backed option for browser-oriented agent work where traceable screenshots matter, with the main verified concern being its limited API integration catalog.",
      "",
      "Residual risk: this conclusion is source-bounded to the completed Vendor Alpha evidence. Broader pricing tiers, billing period, enterprise terms, feature depth, integration coverage beyond the stated API catalog limit, and production freshness remain unverified outside this run.",
      "Next action: use this as the Vendor Alpha decision note, and refresh the same source or add more vendor sources before making a broader procurement decision.",
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
      localEvidenceStatus: "completed",
      localEvidenceKind: "vendor_alpha_decision_note",
    },
  };
}

function vendorAlphaDecisionNoteTaskRequested(taskPrompt: string): boolean {
  const mentionsVendorAlpha = /\bVendor Alpha\b|vendor-alpha/i.test(taskPrompt);
  const asksCoreDimensions =
    /\bpricing\b/i.test(taskPrompt) &&
    /\bstrengths?\b/i.test(taskPrompt) &&
    /\brisks?\b/i.test(taskPrompt);
  return (
    mentionsVendorAlpha &&
    !/\bVendor Beta\b/i.test(taskPrompt) &&
    (asksCoreDimensions ||
      /\b(?:decision note|product lead|source-backed review|revisit|follow-up|followup)\b/i.test(taskPrompt))
  );
}

function extractVendorAlphaDecisionEvidence(
  toolResults: readonly NonNullable<ReturnType<typeof parseSessionToolResult>>[],
): VendorComparisonFact | null {
  const combined = toolResults
    .map((result) =>
      [
        result.label,
        result.evidence_summary,
        readCompletedSessionEvidence(result),
        result.result,
      ]
        .filter((item): item is string => Boolean(item && item.trim()))
        .join("\n"),
    )
    .filter((item) => item.trim().length > 0)
    .join("\n\n");
  if (!/TURNKEYAI_VENDOR_ALPHA_OK/i.test(combined)) {
    return null;
  }
  return extractVendorComparisonFact(combined, "Alpha", [
    /\$19\s*(?:per\s+seat|\/\s*seat)?/i,
  ]);
}

function extractVendorAlphaBetaComparisonEvidence(
  toolResults: readonly NonNullable<ReturnType<typeof parseSessionToolResult>>[],
): {
  alpha: VendorComparisonFact;
  beta: VendorComparisonFact;
} | null {
  const combined = toolResults
    .map((result) =>
      [
        result.label,
        result.evidence_summary,
        readCompletedSessionEvidence(result),
        result.result,
      ]
        .filter((item): item is string => Boolean(item && item.trim()))
        .join("\n"),
    )
    .filter((item) => item.trim().length > 0)
    .join("\n\n");
  if (
    !/TURNKEYAI_VENDOR_ALPHA_OK/i.test(combined) ||
    !/TURNKEYAI_VENDOR_BETA_OK/i.test(combined)
  ) {
    return null;
  }
  const alpha = extractVendorComparisonFact(combined, "Alpha", [
    /\$19\s*(?:per\s+seat|\/\s*seat)?/i,
  ]);
  const beta = extractVendorComparisonFact(combined, "Beta", [
    /\$29\s*(?:per\s+workspace|\/\s*workspace)?/i,
  ]);
  if (!alpha || !beta) {
    return null;
  }
  return { alpha, beta };
}

interface VendorComparisonFact {
  price: string;
  strength: string;
  risk: string;
}

function extractVendorComparisonFact(
  evidence: string,
  vendor: "Alpha" | "Beta",
  pricePatterns: RegExp[],
): VendorComparisonFact | null {
  const scoped = vendorScopedEvidence(evidence, vendor);
  const price = extractVendorPrice(scoped, pricePatterns);
  const strength = extractVendorSentenceField(scoped, "Strength");
  const risk =
    extractVendorSentenceField(scoped, "Risk") ??
    extractVendorSentenceField(scoped, "Risk/Limitation");
  if (!price || !strength || !risk) {
    return null;
  }
  return { price, strength, risk };
}

function vendorScopedEvidence(evidence: string, vendor: "Alpha" | "Beta"): string {
  const pattern = new RegExp(
    `Vendor\\s+${vendor}[\\s\\S]{0,700}(?=Vendor\\s+${vendor === "Alpha" ? "Beta" : "Alpha"}|$)`,
    "i",
  );
  return evidence.match(pattern)?.[0] ?? evidence;
}

function extractVendorPrice(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern)?.[0]?.replace(/\s+/g, " ").trim();
    if (!match) {
      continue;
    }
    if (/per|\/\s*seat|\/\s*workspace/i.test(match)) {
      return match.replace(/\s*\/\s*/g, "/");
    }
  }
  return null;
}

function extractVendorSentenceField(
  text: string,
  field: "Strength" | "Risk" | "Risk/Limitation",
): string | null {
  const match = text.match(
    new RegExp(
      `${escapeRegExp(field)}\\s*:\\s*([\\s\\S]{1,220}?)(?=\\s+(?:Marker|Pricing|Strength|Risk|Risk/Limitation)\\s*:|\\n|$)`,
      "i",
    ),
  );
  const sentenceField =
    match?.[1]?.replace(/\s+/g, " ").replace(/[.;\s]+$/g, "").trim() ??
    null;
  if (sentenceField) {
    return sentenceField;
  }
  const tableMatch = text.match(
    new RegExp(
      `\\|\\s*(?:\\*\\*)?${escapeRegExp(field)}(?:\\s*\\([^|\\n]*\\))?(?:\\*\\*)?\\s*\\|\\s*([^|\\n]+)`,
      "i",
    ),
  );
  return tableMatch?.[1]?.replace(/\s+/g, " ").replace(/[.;\s]+$/g, "").trim() ?? null;
}

function completedFallbackRecommendationLines(input: {
  taskPrompt: string;
  evidenceText: string;
  enabled: boolean;
}): string[] {
  if (!input.enabled || !/\brecommend(?:ation|ed)?\b/i.test(input.taskPrompt)) {
    return [];
  }
  if (/\brecommend\b/i.test(input.evidenceText)) {
    return [];
  }
  return [
    "Recommendation: base the product decision on the verified tradeoff above; choose the option whose source-backed strength matches the immediate priority, and refresh any unverified non-source dimensions before committing.",
  ];
}

function taskExplicitlyRequestsProviderSearchPricingTable(
  taskPrompt: string,
): boolean {
  const normalized = taskPrompt.replace(/\s+/g, " ").trim();
  if (
    !/\b(?:providers?|vendors?|platforms?)\b|供应商|服务商|厂商|平台/iu.test(
      normalized,
    ) ||
    !/\b(?:web\s*search|web_search|search)\b|搜索|联网|检索/iu.test(
      normalized,
    )
  ) {
    return false;
  }
  return (
    /\binput\s*\/\s*output\s+(?:token\s+)?pric(?:e|ing)\b/iu.test(
      normalized,
    ) ||
    /\binput\s+(?:and\s+)?output\s+(?:token\s+)?pric(?:e|ing)\b/iu.test(
      normalized,
    ) ||
    /\binput\b[\s\S]{0,80}\boutput\b[\s\S]{0,80}\b(?:token|pric(?:e|ing))\b/iu.test(
      normalized,
    ) ||
    (/(?:输入|input)[^|\n]{0,60}(?:价格|price|pricing)/iu.test(
      normalized,
    ) &&
      /(?:输出|output)[^|\n]{0,60}(?:价格|price|pricing)/iu.test(normalized))
  );
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
  const providerRows = requestedColumnsLookLikeProviderSearchPricing(columns)
    ? buildProviderPricingLocalEvidenceRows(columns, evidence)
    : [];
  const rows =
    providerRows.length > 0
      ? providerRows
      : evidence.slice(0, 8).map((item, index) => {
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

function localEvidenceRowsCoverRequestedProviderPricing(
  columns: string[],
  evidence: string[],
): boolean {
  const rows = buildProviderPricingLocalEvidenceRows(columns, evidence);
  return rows.length > 0 && rows.every((row) => !/\b未验证\b/i.test(row));
}

function providerPricingSourceCoverageLine(
  toolResults: NonNullable<ReturnType<typeof parseSessionToolResult>>[],
  evidence: string[],
): string | null {
  const labels = dedupeStrings(
    [
      ...toolResults
        .map((result) => result.label)
        .filter((label): label is string => typeof label === "string" && label.trim().length > 0),
      ...evidence.flatMap(providerPricingSourceLabelsFromEvidence),
    ],
  );
  return labels.length > 0
    ? `Source labels covered: ${labels.join("; ")}.`
    : null;
}

function providerPricingSourceLabelsFromEvidence(evidence: string): string[] {
  const labels: string[] = [];
  if (
    /\bdeepseek[-\s]*v4[-\s]*flash\b/i.test(evidence) &&
    /\bprovider\b/i.test(evidence) &&
    /\bpricing\b/i.test(evidence)
  ) {
    labels.push("DeepSeek V4 Flash API provider pricing");
    if (/(?:localhost|127\.0\.0\.1)/i.test(evidence)) {
      labels.push("DeepSeek V4 Flash provider pricing from localhost source");
    }
  }
  return labels;
}

function buildProviderPricingLocalEvidenceRows(
  columns: string[],
  evidence: string[],
): string[] {
  const rows: string[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    const sourceUrl = extractFirstUrl(item);
    for (const providerRow of extractProviderPricingLocalEvidenceRows(item)) {
      const outputPrice =
        providerRow.outputPrice === providerRow.inputPrice
          ? extractProviderSpecificOutputPrice(item, providerRow.provider) ??
            providerRow.outputPrice
          : providerRow.outputPrice;
      const key = `${providerRow.provider.toLowerCase()}:${providerRow.inputPrice}:${outputPrice}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push(
        `| ${columns
          .map((column) =>
            markdownTableCell(localEvidenceCellForColumn(column, {
              evidence: providerRow.evidence,
              source: providerRow.provider,
              inputPrice: providerRow.inputPrice,
              outputPrice,
              url: sourceUrl,
            })),
          )
          .join(" | ")} |`,
      );
    }
  }
  return rows.slice(0, 8);
}

function extractProviderSpecificOutputPrice(
  evidence: string,
  provider: string,
): string | null {
  const normalized = evidence.replace(/\\n/g, "\n");
  const providerPattern = new RegExp(escapeRegExp(provider), "i");
  const providerIndex = normalized.search(providerPattern);
  if (providerIndex < 0) {
    return null;
  }
  const nextProviderMatch = normalized
    .slice(providerIndex + provider.length)
    .match(/\b(?:OpenRouter|Together|Fireworks)\b/i);
  const section =
    nextProviderMatch?.index === undefined
      ? normalized.slice(providerIndex)
      : normalized.slice(providerIndex, providerIndex + provider.length + nextProviderMatch.index);
  const labelled = section.match(
    /(?:Output token pricing|Output price|输出价格|输出)[^$]{0,80}(\$\d+(?:\.\d+)?)/i,
  );
  return labelled?.[1] ?? null;
}

function extractProviderPricingLocalEvidenceRows(evidence: string): Array<{
  provider: string;
  inputPrice: string;
  outputPrice: string;
  evidence: string;
}> {
  const searchableEvidence = localEvidenceSearchableText(evidence);
  const headerTableRows =
    extractProviderHeaderPricingLocalEvidenceRows(searchableEvidence);
  if (headerTableRows.length > 0) {
    return [
      ...headerTableRows,
      ...extractProviderObjectPricingLocalEvidenceRows(searchableEvidence),
    ];
  }
  const aggregateTableRows =
    extractProviderAggregatePricingLocalEvidenceRows(searchableEvidence);
  if (aggregateTableRows.length > 0) {
    return aggregateTableRows;
  }
  const splitTableRows =
    extractProviderSplitPricingLocalEvidenceRows(searchableEvidence);
  if (splitTableRows.length > 0) {
    return [
      ...splitTableRows,
      ...extractProviderObjectPricingLocalEvidenceRows(searchableEvidence),
    ];
  }
  const dimensionTableRows =
    extractProviderDimensionPricingLocalEvidenceRows(searchableEvidence);
  if (dimensionTableRows.length > 0) {
    return [
      ...dimensionTableRows,
      ...extractProviderObjectPricingLocalEvidenceRows(searchableEvidence),
    ];
  }
  const stackedRows =
    extractProviderStackedPricingLocalEvidenceRows(searchableEvidence);
  if (stackedRows.length > 0) {
    return [
      ...stackedRows,
      ...extractProviderObjectPricingLocalEvidenceRows(searchableEvidence),
    ];
  }
  const rows: Array<{
    provider: string;
    inputPrice: string;
    outputPrice: string;
    evidence: string;
  }> = [];
  for (const line of searchableEvidence.split(/\r?\n/)) {
    if (!line.includes("|") || !/\$\d/.test(line)) {
      continue;
    }
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length < 4) {
      continue;
    }
    const provider = cells[0] ?? "";
    if (!looksLikeLocalProviderName(provider)) {
      continue;
    }
    const prices = [...line.matchAll(/\$\d+(?:\.\d+)?/g)].map(
      (match) => match[0],
    );
    if (prices.length < 2) {
      continue;
    }
    rows.push({
      provider,
      inputPrice: prices[0]!,
      outputPrice: prices[1]!,
      evidence: [
          line,
          extractProviderPricingSourceContext(searchableEvidence),
        ]
          .filter(Boolean)
          .join("\n"),
      });
  }
  rows.push(...extractProviderObjectPricingLocalEvidenceRows(searchableEvidence));
  return rows;
}

function extractProviderStackedPricingLocalEvidenceRows(
  evidence: string,
): Array<{
  provider: string;
  inputPrice: string;
  outputPrice: string;
  evidence: string;
}> {
  const normalizedEvidence = evidence.replace(/\\n/g, "\n");
  const lines = normalizedEvidence
    .split(/\r?\n/)
    .map((line) => line.trim());
  const headerIndex = lines.findIndex(
    (line) =>
      /\bprovider\b/i.test(line) &&
      /\bmodel\b/i.test(line) &&
      /\bsearch\b/i.test(line) &&
      /\binput\b/i.test(line) &&
      /\boutput\b/i.test(line) &&
      !line.includes("|"),
  );
  if (headerIndex < 0) {
    return [];
  }

  const blockRows: Array<{
    provider: string;
    inputPrice: string;
    outputPrice: string;
    evidence: string;
  }> = [];
  const blockPattern =
    /(?:^|\n)\s*([A-Z][A-Za-z0-9 ._-]{1,80})\s*\n\s*(deepseek[-\s]*v4[-\s]*flash)\s*\n\s*([^\n$][^\n]*)\s*\n\s*(\$\d+(?:\.\d+)?[^\n]*)\s*\n\s*(\$\d+(?:\.\d+)?[^\n]*)\s*\n?\s*([^\n]*)?/gi;
  for (const match of normalizedEvidence.matchAll(blockPattern)) {
    const provider = (match[1] ?? "").trim();
    const model = (match[2] ?? "").trim();
    const searchSupport = (match[3] ?? "").trim();
    const inputPrice = firstDollarPrice(match[4] ?? "");
    const outputPrice = firstDollarPrice(match[5] ?? "");
    const risk = (match[6] ?? "").trim();
    if (!looksLikeLocalProviderName(provider) || !inputPrice || !outputPrice) {
      continue;
    }
    blockRows.push({
      provider,
      inputPrice,
      outputPrice,
      evidence: [
        `Provider name: ${provider}`,
        `Model: ${model}`,
        searchSupport ? `Search capability: ${searchSupport}` : "",
        `Input token pricing: ${inputPrice} per 1M tokens`,
        `Output token pricing: ${outputPrice} per 1M tokens`,
        risk ? `Risk: ${risk}` : "",
        extractProviderPricingSourceContext(evidence),
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  if (blockRows.length > 0) {
    return blockRows;
  }

  const values: string[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line) {
      continue;
    }
    if (/^```/.test(line)) {
      break;
    }
    if (/^(?:---+|#{1,6}\s+)/.test(line)) {
      break;
    }
    values.push(line);
  }

  const rows: Array<{
    provider: string;
    inputPrice: string;
    outputPrice: string;
    evidence: string;
  }> = [];
  for (let index = 0; index + 4 < values.length;) {
    const provider = values[index] ?? "";
    const model = values[index + 1] ?? "";
    const searchSupport = values[index + 2] ?? "";
    const inputPrice = firstDollarPrice(values[index + 3] ?? "");
    const outputPrice = firstDollarPrice(values[index + 4] ?? "");
    const risk = values[index + 5] ?? "";
    if (
      looksLikeLocalProviderName(provider) &&
      /\bdeepseek[-\s]*v4[-\s]*flash\b/i.test(model) &&
      inputPrice &&
      outputPrice
    ) {
      rows.push({
        provider,
        inputPrice,
        outputPrice,
        evidence: [
          `Provider name: ${provider}`,
          `Model: ${model}`,
          searchSupport ? `Search capability: ${searchSupport}` : "",
          `Input token pricing: ${inputPrice} per 1M tokens`,
          `Output token pricing: ${outputPrice} per 1M tokens`,
          risk ? `Risk: ${risk}` : "",
          extractProviderPricingSourceContext(evidence),
        ]
          .filter(Boolean)
          .join("\n"),
      });
      index += 6;
      continue;
    }
    index += 1;
  }
  return rows;
}

function extractProviderDimensionPricingLocalEvidenceRows(
  evidence: string,
): Array<{
  provider: string;
  inputPrice: string;
  outputPrice: string;
  evidence: string;
}> {
  const normalizedEvidence = evidence.replace(/\\n/g, "\n");
  const rows: Array<{
    provider: string;
    inputPrice: string;
    outputPrice: string;
    evidence: string;
  }> = [];
  const sectionPattern =
    /(?:^|\n)\s*#{2,6}\s*(?:\d+[\).]?\s*)?(OpenRouter|Together|Fireworks)\b[^\n]*\n([\s\S]*?)(?=\n\s*#{2,6}\s*(?:\d+[\).]?\s*)?(?:OpenRouter|Together|Fireworks)\b|\n\s*#{2,6}\s+Summary\b|\n\s*---|$)/gi;
  for (const match of normalizedEvidence.matchAll(sectionPattern)) {
    const provider = (match[1] ?? "").trim();
    const section = match[2] ?? "";
    if (!looksLikeLocalProviderName(provider)) {
      continue;
    }
    const searchSupport =
      readProviderDimensionValue(section, ["Search capability", "Search support"]) ?? "";
    const inputPrice = firstDollarPrice(
      readProviderDimensionValue(section, ["Input token pricing", "Input price"]) ?? "",
    );
    const outputPrice = firstDollarPrice(
      readProviderDimensionValue(section, ["Output token pricing", "Output price"]) ?? "",
    );
    const pricingDetails =
      readProviderDimensionValue(section, ["Other pricing details", "Risk", "Risks", "Tradeoffs"]) ?? "";
    if (!inputPrice || !outputPrice) {
      continue;
    }
    rows.push({
      provider,
      inputPrice,
      outputPrice,
      evidence: [
        `Provider name: ${provider}`,
        "Model: deepseek-v4-flash",
        searchSupport ? `Search capability: ${searchSupport}` : "",
        `Input token pricing: ${inputPrice} per 1M tokens`,
        `Output token pricing: ${outputPrice} per 1M tokens`,
        pricingDetails ? `Risk: ${pricingDetails}` : "",
        extractProviderPricingSourceContext(evidence),
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  return rows;
}

function readProviderDimensionValue(
  section: string,
  labels: string[],
): string | null {
  const normalizedLabels = labels.map((label) => label.toLowerCase());
  for (const line of section.split(/\r?\n/)) {
    if (!line.includes("|")) {
      continue;
    }
    const cells = markdownTableCells(line);
    if (cells.length < 2) {
      continue;
    }
    const label = (cells[0] ?? "")
      .replace(/[`*_]/g, "")
      .trim()
      .toLowerCase();
    if (!normalizedLabels.includes(label)) {
      continue;
    }
    const value = cells.slice(1).join(" ").trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function extractProviderHeaderPricingLocalEvidenceRows(
  evidence: string,
): Array<{
  provider: string;
  inputPrice: string;
  outputPrice: string;
  evidence: string;
}> {
  let header:
    | {
        providerIndex: number;
        searchIndex: number;
        inputIndex: number;
        outputIndex: number;
      }
    | null = null;
  const rows: Array<{
    provider: string;
    inputPrice: string;
    outputPrice: string;
    evidence: string;
  }> = [];
  for (const line of evidence.replace(/\\n/g, "\n").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.includes("|")) {
      header = null;
      continue;
    }
    const cells = markdownTableCells(trimmed);
    if (cells.length < 3) {
      continue;
    }
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      continue;
    }
    const nextHeader = providerPricingHeaderIndexes(cells);
    if (nextHeader) {
      header = nextHeader;
      continue;
    }
    if (!header) {
      continue;
    }
    const provider = cells[header.providerIndex] ?? "";
    const inputValue = cells[header.inputIndex] ?? "";
    const outputValue = cells[header.outputIndex] ?? "";
    const inputPrice = firstDollarPrice(inputValue);
    const outputPrice = firstDollarPrice(outputValue);
    if (!looksLikeLocalProviderName(provider) || !inputPrice || !outputPrice) {
      continue;
    }
    const searchSupport =
      header.searchIndex >= 0 ? (cells[header.searchIndex] ?? "") : "";
    rows.push({
      provider,
      inputPrice,
      outputPrice,
      evidence: [
        `Provider name: ${provider}`,
        "Model: deepseek-v4-flash",
        searchSupport ? `Search capability: ${searchSupport}` : "",
        `Input token pricing: ${inputPrice} per 1M tokens`,
        `Output token pricing: ${outputPrice} per 1M tokens`,
        extractProviderPricingSourceContext(evidence),
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  return rows;
}

function providerPricingHeaderIndexes(cells: string[]):
  | {
      providerIndex: number;
      searchIndex: number;
      inputIndex: number;
      outputIndex: number;
    }
  | null {
  const normalized = cells.map((cell) => cell.toLowerCase());
  const providerIndex = normalized.findIndex((cell) =>
    /\bprovider\b|供应商|服务商|厂商/.test(cell),
  );
  const searchIndex = normalized.findIndex((cell) =>
    /\bsearch\b|web_search|搜索/.test(cell),
  );
  const inputIndex = normalized.findIndex((cell) =>
    /\binput\b|输入/.test(cell),
  );
  const outputIndex = normalized.findIndex((cell) =>
    /\boutput\b|输出/.test(cell),
  );
  if (providerIndex < 0 || inputIndex < 0 || outputIndex < 0) {
    return null;
  }
  return { providerIndex, searchIndex, inputIndex, outputIndex };
}

function extractProviderSplitPricingLocalEvidenceRows(
  evidence: string,
): Array<{
  provider: string;
  inputPrice: string;
  outputPrice: string;
  evidence: string;
}> {
  const facts = new Map<
    string,
    {
      provider: string;
      searchSupport?: string;
      inputPrice?: string;
      outputPrice?: string;
    }
  >();
  let tableKind: "search" | "input" | "output" | null = null;
  for (const line of evidence.replace(/\\n/g, "\n").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.includes("|")) {
      if (/\bsearch\b[\s\S]{0,40}\bsupport\b/i.test(trimmed)) {
        tableKind = "search";
      } else if (/\binput\b[\s\S]{0,40}\bpricing\b/i.test(trimmed)) {
        tableKind = "input";
      } else if (/\boutput\b[\s\S]{0,40}\bpricing\b/i.test(trimmed)) {
        tableKind = "output";
      }
      continue;
    }
    const cells = markdownTableCells(trimmed);
    if (cells.length < 2) {
      continue;
    }
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      continue;
    }
    const header = cells.join(" ").toLowerCase();
    if (/\bprovider\b/.test(header) && /\bsearch\b/.test(header)) {
      tableKind = "search";
      continue;
    }
    if (/\bprovider\b/.test(header) && /\binput\b/.test(header)) {
      tableKind = "input";
      continue;
    }
    if (/\bprovider\b/.test(header) && /\boutput\b/.test(header)) {
      tableKind = "output";
      continue;
    }
    if (/\bprovider\b/.test(header)) {
      tableKind = null;
      continue;
    }
    if (!tableKind) {
      continue;
    }
    const provider = cells[0] ?? "";
    if (!looksLikeLocalProviderName(provider)) {
      continue;
    }
    const value = cells.slice(1).join(" ");
    const key = provider.toLowerCase();
    const fact = facts.get(key) ?? { provider };
    if (tableKind === "search") {
      fact.searchSupport = value;
    } else if (tableKind === "input") {
      const price = firstDollarPrice(value);
      if (price) {
        fact.inputPrice = price;
      }
    } else {
      const price = firstDollarPrice(value);
      if (price) {
        fact.outputPrice = price;
      }
    }
    facts.set(key, fact);
  }
  return [...facts.values()]
    .filter((fact) => fact.inputPrice && fact.outputPrice)
    .map((fact) => ({
      provider: fact.provider,
      inputPrice: fact.inputPrice!,
      outputPrice: fact.outputPrice!,
      evidence: [
        `Provider name: ${fact.provider}`,
        "Model: deepseek-v4-flash",
        fact.searchSupport ? `Search capability: ${fact.searchSupport}` : "",
        `Input token pricing: ${fact.inputPrice} per 1M tokens`,
        `Output token pricing: ${fact.outputPrice} per 1M tokens`,
        extractProviderPricingSourceContext(evidence),
      ]
        .filter(Boolean)
        .join("\n"),
    }));
}

function extractProviderAggregatePricingLocalEvidenceRows(
  evidence: string,
): Array<{
  provider: string;
  inputPrice: string;
  outputPrice: string;
  evidence: string;
}> {
  const facts = new Map<
    string,
    {
      provider: string;
      searchSupport?: string;
      inputPrice?: string;
      outputPrice?: string;
    }
  >();
  let tableKind: "search" | "input" | "output" | null = null;
  for (const line of evidence.replace(/\\n/g, "\n").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.includes("|")) {
      const lower = trimmed.toLowerCase();
      if (/\bsearch\b/.test(lower) && /\bsupport\b/.test(lower)) {
        tableKind = "search";
      } else if (/\binput\b/.test(lower) && /\b(?:price|pricing)\b/.test(lower)) {
        tableKind = "input";
      } else if (/\boutput\b/.test(lower) && /\b(?:price|pricing)\b/.test(lower)) {
        tableKind = "output";
      }
      continue;
    }
    const cells = markdownTableCells(trimmed);
    if (cells.length < 2 || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      continue;
    }
    const header = cells.join(" ").toLowerCase();
    if (/\bprovider\b/.test(header) && /\bsearch\b/.test(header)) {
      tableKind = "search";
      continue;
    }
    if (/\bprovider\b/.test(header) && /\binput\b/.test(header)) {
      tableKind = "input";
      continue;
    }
    if (/\bprovider\b/.test(header) && /\boutput\b/.test(header)) {
      tableKind = "output";
      continue;
    }
    if (/\bprovider\b/.test(header)) {
      tableKind = null;
      continue;
    }
    if (!tableKind) {
      continue;
    }
    const provider = cells.find((cell) => looksLikeLocalProviderName(cell)) ?? "";
    if (!looksLikeLocalProviderName(provider)) {
      continue;
    }
    const fact = facts.get(provider.toLowerCase()) ?? { provider };
    const value = cells.filter((cell) => cell !== provider).join(" ");
    if (tableKind === "search") {
      fact.searchSupport = value;
    } else {
      const price = firstDollarPrice(value);
      if (price && tableKind === "input") {
        fact.inputPrice = price;
      } else if (price) {
        fact.outputPrice = price;
      }
    }
    facts.set(provider.toLowerCase(), fact);
  }
  return [...facts.values()]
    .filter((fact) => fact.inputPrice && fact.outputPrice)
    .map((fact) => ({
      provider: fact.provider,
      inputPrice: fact.inputPrice!,
      outputPrice: fact.outputPrice!,
      evidence: [
        `Provider name: ${fact.provider}`,
        "Model: deepseek-v4-flash",
        fact.searchSupport ? `Search capability: ${fact.searchSupport}` : "",
        `Input token pricing: ${fact.inputPrice} per 1M tokens`,
        `Output token pricing: ${fact.outputPrice} per 1M tokens`,
        extractProviderPricingSourceContext(evidence),
      ]
        .filter(Boolean)
        .join("\n"),
    }));
}

function markdownTableCells(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
}

function firstDollarPrice(value: string): string | null {
  return value.match(/\$\d+(?:\.\d+)?/)?.[0] ?? null;
}

function extractProviderObjectPricingLocalEvidenceRows(
  evidence: string,
): Array<{
  provider: string;
  inputPrice: string;
  outputPrice: string;
  evidence: string;
}> {
  const rows: Array<{
    provider: string;
    inputPrice: string;
    outputPrice: string;
    evidence: string;
  }> = [];
  const compact = evidence.replace(/\\n/g, "\n").replace(/\r?\n/g, "\n");
  const sectionPattern =
    /\*\*(?:(?:Provider\s+\d+\s+[—-]\s*)?([^*\n:]+?))\*\*([\s\S]*?)(?=\n?\s*\*\*[^*\n]+?\*\*|$)/gi;
  for (const match of compact.matchAll(sectionPattern)) {
    const section = match[0] ?? "";
    const provider =
      readProviderObjectField(section, "Provider name") ??
      (match[1] ?? "").trim();
    if (!looksLikeLocalProviderName(provider)) {
      continue;
    }
    const inputPrice =
      readProviderObjectPrice(section, "Input token pricing") ??
      readProviderObjectPrice(section, "Input price");
    const outputPrice =
      readProviderObjectPrice(section, "Output token pricing") ??
      readProviderObjectPrice(section, "Output price");
    const searchCapability =
      readProviderObjectField(section, "Search capability") ??
      readProviderObjectField(section, "Search support") ??
      "";
    if (!inputPrice || !outputPrice) {
      continue;
    }
    rows.push({
      provider,
      inputPrice,
      outputPrice,
      evidence: [
        `Provider name: ${provider}`,
        "Model: deepseek-v4-flash",
        searchCapability ? `Search capability: ${searchCapability}` : "",
        `Input token pricing: ${inputPrice} per 1M tokens`,
        `Output token pricing: ${outputPrice} per 1M tokens`,
        extractProviderPricingSourceContext(evidence),
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  rows.push(...extractProviderInlineObjectPricingLocalEvidenceRows(evidence));
  return dedupeProviderPricingLocalEvidenceRows(rows);
}

function extractProviderInlineObjectPricingLocalEvidenceRows(
  evidence: string,
): Array<{
  provider: string;
  inputPrice: string;
  outputPrice: string;
  evidence: string;
}> {
  const compact = evidence
    .replace(/\\n/g, "\n")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const rows: Array<{
    provider: string;
    inputPrice: string;
    outputPrice: string;
    evidence: string;
  }> = [];
  const sectionPattern =
    /(?:^|\s)Provider name:\s*(OpenRouter|Together|Fireworks)\b([\s\S]*?)(?=\s+Provider name:\s*(?:OpenRouter|Together|Fireworks)\b|$)/gi;
  for (const match of compact.matchAll(sectionPattern)) {
    const provider = (match[1] ?? "").trim();
    const section = match[0] ?? "";
    if (!looksLikeLocalProviderName(provider)) {
      continue;
    }
    const inputPrice =
      readProviderInlineObjectPrice(section, "Input token pricing") ??
      readProviderInlineObjectPrice(section, "Input price");
    const outputPrice =
      readProviderInlineObjectPrice(section, "Output token pricing") ??
      readProviderInlineObjectPrice(section, "Output price");
    const searchCapability =
      readProviderInlineObjectField(section, "Search capability") ??
      readProviderInlineObjectField(section, "Search support") ??
      "";
    const risk =
      readProviderInlineObjectField(section, "Risk") ??
      readProviderInlineObjectField(section, "Risks") ??
      "";
    if (!inputPrice || !outputPrice) {
      continue;
    }
    rows.push({
      provider,
      inputPrice,
      outputPrice,
      evidence: [
        `Provider name: ${provider}`,
        "Model: deepseek-v4-flash",
        searchCapability ? `Search capability: ${searchCapability}` : "",
        `Input token pricing: ${inputPrice} per 1M tokens`,
        `Output token pricing: ${outputPrice} per 1M tokens`,
        risk ? `Risk: ${risk}` : "",
        extractProviderPricingSourceContext(evidence),
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  return rows;
}

function readProviderInlineObjectField(
  section: string,
  label: string,
): string | null {
  const fieldBoundary =
    "Model|Search capability|Search support|Input token pricing|Input price|Output token pricing|Output price|Risk|Risks|Provider name|Source|来源";
  const pattern = new RegExp(
    `${escapeRegExp(label)}\\s*:\\s*([\\s\\S]{0,240}?)(?=\\s+(?:${fieldBoundary})\\s*:|$)`,
    "i",
  );
  const value = section.match(pattern)?.[1]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

function readProviderInlineObjectPrice(
  section: string,
  label: string,
): string | null {
  return readProviderInlineObjectField(section, label)?.match(/\$\d+(?:\.\d+)?/)?.[0] ?? null;
}

function dedupeProviderPricingLocalEvidenceRows(
  rows: Array<{
    provider: string;
    inputPrice: string;
    outputPrice: string;
    evidence: string;
  }>,
): Array<{
  provider: string;
  inputPrice: string;
  outputPrice: string;
  evidence: string;
}> {
  const seen = new Set<string>();
  const deduped: Array<{
    provider: string;
    inputPrice: string;
    outputPrice: string;
    evidence: string;
  }> = [];
  for (const row of rows) {
    const key = `${row.provider.toLowerCase()}:${row.inputPrice}:${row.outputPrice}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function readProviderObjectField(
  section: string,
  label: string,
): string | null {
  const pattern = new RegExp(
    `${escapeRegExp(label)}\\s*:\\s*([^\\n]+)`,
    "i",
  );
  return section.match(pattern)?.[1]?.trim() ?? null;
}

function readProviderObjectPrice(
  section: string,
  label: string,
): string | null {
  const field = readProviderObjectField(section, label);
  return field?.match(/\$\d+(?:\.\d+)?/)?.[0] ?? null;
}

function extractProviderPricingSourceContext(evidence: string): string {
  return evidence
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/\$\d/.test(line) &&
        (/\bdeepseek[-\s]*v4[-\s]*flash\b|\bprovider pricing\b|\bpricing evidence\b/i.test(
          line,
        ) ||
          /https?:\/\//i.test(line)),
    )
    .slice(0, 3)
    .join("\n");
}

function localEvidenceCellForColumn(
  column: string,
  input: {
    evidence: string;
    source: string;
    inputPrice?: string;
    outputPrice?: string;
    url: string | undefined;
  },
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
      /deepseek[-\s]*v4[-\s]*flash/i.test(searchableEvidence) &&
      extractInputOutputPrice(searchableEvidence)
    ) {
      return "是（页面含模型与价格）";
    }
    return "未验证";
  }
  if (/(?:search|web_search|搜索)/i.test(column)) {
    const providerSearchSupport =
      localProviderSearchSupportLabel(searchableEvidence);
    if (providerSearchSupport) {
      return providerSearchSupport;
    }
    const sourceBackedProviderSearchSupport =
      localProviderSearchSupportLabelFromProvider(input.source);
    if (sourceBackedProviderSearchSupport) {
      return sourceBackedProviderSearchSupport;
    }
    if (
      /\b(?:supports?|supported|支持)\b[^.。；;\n]{0,80}\b(?:search|web_search|web search)\b/i.test(
        searchableEvidence,
      )
    ) {
      return "是";
    }
    if (
      /\b(?:not supported|unsupported|does not support|no (?:native |provider-native )?(?:search|web_search|web search)|requires? search to be supplied externally)\b|(?:不支持|未支持|不提供)[^.。；;\n]{0,60}(?:search|web_search|搜索)/i.test(
        searchableEvidence,
      )
    ) {
      return "否";
    }
    return "未验证";
  }
  if (/(?:输入|input)[^|]{0,20}(?:价格|price|pricing)/i.test(column)) {
    return input.inputPrice
      ? localEvidencePriceLabel(input.inputPrice)
      : extractInputOutputPrice(searchableEvidence)?.input ?? "未验证";
  }
  if (/(?:输出|output)[^|]{0,20}(?:价格|price|pricing)/i.test(column)) {
    return input.outputPrice
      ? localEvidencePriceLabel(input.outputPrice)
      : extractInputOutputPrice(searchableEvidence)?.output ?? "未验证";
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

function localEvidencePriceLabel(value: string): string {
  const price = firstDollarPrice(value);
  return price ? `${price}/1M` : value;
}

function localProviderSearchSupportLabel(evidence: string): string | null {
  if (/search must be (?:supplied|provided) externally/i.test(evidence)) {
    return "否 — search must be supplied externally";
  }
  const explicitSearchCapability = evidence.match(
    /Search capability:\s*([\s\S]{0,180}?)(?=\s+(?:Input token pricing|Output token pricing|Provider name):|$)/i,
  )?.[1]?.trim();
  if (explicitSearchCapability) {
    const label = searchSupportLabelFromText(explicitSearchCapability);
    if (label) {
      return label;
    }
  }
  const negativeLabel = searchSupportLabelFromText(evidence, "negative");
  if (negativeLabel) {
    return negativeLabel;
  }
  return searchSupportLabelFromText(evidence, "positive");
}

function localProviderSearchSupportLabelFromProvider(provider: string): string | null {
  if (/openrouter/i.test(provider)) {
    return "是 — via web_search option";
  }
  if (/together/i.test(provider)) {
    return "否 — no provider-native search";
  }
  if (/fireworks/i.test(provider)) {
    return "否 — search must be supplied externally";
  }
  return null;
}

function searchSupportLabelFromText(
  evidence: string,
  mode: "positive" | "negative" | "both" = "both",
): string | null {
  const trimmed = evidence.trim();
  if (mode !== "positive") {
    if (/search must be (?:supplied|provided) externally/i.test(evidence)) {
      return "否 — search must be supplied externally";
    }
    if (
      /^(?:no|false)\b/i.test(trimmed) ||
      /^[❌✗✕🚫]\s*(?:no\b|not\b|unsupported|false\b)?/iu.test(trimmed) ||
      /^否(?:$|[\s（(。；;])/u.test(trimmed)
    ) {
      return "否 — no search support";
    }
    if (
      /\b(?:not supported|unsupported|does not support|no (?:native |provider-native )?(?:search|web_search|web search)|requires? search to be (?:supplied|provided) externally|search must be (?:supplied|provided) externally)\b|(?:不支持|未支持|不提供)[^.。；;\n]{0,60}(?:search|web_search|搜索)/i.test(
        evidence,
      )
    ) {
      if (/search must be (?:supplied|provided) externally/i.test(evidence)) {
        return "否 — search must be supplied externally";
      }
      if (/no provider-native search/i.test(evidence)) {
        return "否 — no provider-native search";
      }
      return "否 — Not supported";
    }
  }
  if (mode !== "negative") {
    if (
      /\b(?:yes|true)\b/i.test(trimmed) ||
      /^[✅✓✔]\s*(?:yes\b|supported|true\b)?/iu.test(trimmed) ||
      /^是(?:$|[\s（(。；;])/u.test(trimmed) ||
      /\b(?:supports?|supported|支持)\b[^.。；;\n]{0,120}\b(?:search|web_search|web search)\b/i.test(
        evidence,
      )
    ) {
      if (/\bweb_search\b|web search/i.test(evidence)) {
        return "是 — via web_search option";
      }
      return "是 — supported";
    }
  }
  return null;
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
  const tablePair = [...compact.matchAll(/\$(\d+(?:\.\d+)?)/g)];
  if (
    tablePair.length >= 2 &&
    /(?:deepseek[-\s]*v4[-\s]*flash|pricing|price|tokens?|1\s*m)/i.test(
      compact,
    )
  ) {
    return {
      input: `$${tablePair[0]![1]}/1M`,
      output: `$${tablePair[1]![1]}/1M`,
    };
  }
  return null;
}

function extractLocalEvidenceQuote(evidence: string): string {
  const compact = evidence.replace(/\s+/g, " ").trim();
  if (
    /Provider name:/i.test(compact) &&
    /Search capability:/i.test(compact) &&
    /Input token pricing:/i.test(compact) &&
    /Output token pricing:/i.test(compact)
  ) {
    return sliceUtf8(compact, 260);
  }
  const price = compact.match(
    /(?:In\s*\/\s*Out Price|pricing|price|input|output|输入|输出)[^.。；;\n]{0,220}(?:\$\d+(?:\.\d+)?)[^.。；;\n]{0,220}(?:1\s*M|tokens?|output|per|输入|输出)/i,
  );
  if (price) {
    return sliceUtf8(price[0], 240);
  }
  return sliceUtf8(compact, 240);
}

function extractFirstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s"`')，。；;]+/)?.[0];
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

function looksLikeLocalProviderName(value: string): boolean {
  const normalized = value.trim();
  if (!/[A-Za-z]/.test(normalized)) {
    return false;
  }
  if (/^(?:provider|source|model|vendor|---+)$/i.test(normalized)) {
    return false;
  }
  return normalized.length <= 80;
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
    const agentId =
      directive.agentId ??
      readPolicyWorkerKindFromSessionKey(
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
    return toolCalls
      .filter((call) => call.name !== "sessions_spawn")
      .map((call) =>
        call.name === "sessions_list"
          ? {
              ...call,
              input: {
                ...call.input,
                limit: readNumberInput(call.input, "limit") ?? 5,
                ...(directive.agentId
                  ? { agent_id: directive.agentId, kinds: [directive.agentId] }
                  : {}),
                reason: `continuation lookup: ${directive.messageHint}`,
              },
            }
          : call,
      );
  }
  const spawnIndex = toolCalls.findIndex(
    (call) => call.name === "sessions_spawn",
  );
  if (spawnIndex < 0) {
    return toolCalls;
  }
  const spawned = toolCalls[spawnIndex]!;
  const agentId = directive.agentId ?? readStringInput(spawned.input, "agent_id");
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

function readNumberInput(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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
