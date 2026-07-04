// Stage 8 engine cleanup — neutral task-fact helpers.
//
// These helpers are shared by the inline reference path and react-engine
// modules. Keep this file free of react-engine imports so shared fallback
// helpers can reuse task facts without making the inline path depend on
// react-engine internals.
import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import { produceTaskIntentEnvelope } from "./runtime-facts/task-intent-producer";

export const TASK_FACTS_MODULE = "task-facts" as const;

export interface TaskFactsInput {
  taskPrompt: string;
  activation?: RoleActivationInput | undefined;
  messages: LLMMessage[];
}

export interface TaskFactsSnapshot {
  requestedTableColumns: string[];
  providerSupportSchemaRequested: boolean;
  browserVisibleEvidenceRequired: boolean;
  productSignalDashboardEvidenceRequested: boolean;
  timeoutRecoveryRequested: boolean;
  awaitingContextSetupOnly: boolean;
  requiredIndependentEvidenceStreams: number;
}

export function buildTaskFacts(input: TaskFactsInput): TaskFactsSnapshot {
  return produceTaskIntentEnvelope(input).facts;
}

export function resolveRequestedTableColumns(texts: string[]): string[] {
  const inferred = inferRequestedTableColumns(texts);
  const providerColumns = inferEvidenceSensitiveProviderTableColumns(texts);
  if (providerColumns.length === 0) {
    return inferred;
  }
  if (inferred.length === 0) {
    return providerColumns;
  }
  const normalized = inferred.map((column) => column.toLowerCase());
  const hasProvider = normalized.some((column) => column.includes("provider"));
  const hasSearch = normalized.some((column) =>
    /search|web_search|搜索/.test(column),
  );
  const hasPrice =
    normalized.some((column) =>
      /price|pricing|价格|定价|输入|input/.test(column),
    ) &&
    normalized.some((column) =>
      /price|pricing|价格|定价|输出|output/.test(column),
    );
  const hasEvidence =
    normalized.some((column) => /url|证据|source/.test(column)) &&
    normalized.some((column) => /摘录|quote|excerpt|原文/.test(column));
  if (
    inferred.length < 5 ||
    !hasProvider ||
    !hasSearch ||
    !hasPrice ||
    !hasEvidence
  ) {
    return providerColumns;
  }
  return inferred;
}

function buildTaskFactTextContext(input: TaskFactsInput): string[] {
  return [
    input.taskPrompt,
    ...buildRequestedTableColumnActivationContext(input.activation),
    ...requestedTableColumnMessageContext(input.messages),
  ].filter((text) => text.trim().length > 0);
}

function taskFactRequestsProductSignalDashboardEvidence(text: string): boolean {
  return /\b(?:product-signals|live signal dashboard|product signal dashboard)\b/i.test(
    text,
  );
}

function taskFactRequiresBrowserVisibleEvidence(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || taskFactExplicitlyDisclaimsBrowserRenderedEvidence(normalized)) {
    return false;
  }
  return (
    /\b(?:browser-visible|browser rendered|browser-rendered|browser-observed|as (?:a|an) (?:user|operator) would see|user-visible|visible page|rendered page|rendered DOM|client[- ]side|JavaScript-rendered|JS-rendered|dynamic dashboard|live dashboard)\b/i.test(
      normalized,
    ) ||
    /\b(?:rendered browser page|browser page rendered|fully render(?:ed)?|rendered values?|visible values?|exact visible text|exact visible values?)\b/i.test(
      normalized,
    ) ||
    /\b(?:in (?:the )?browser|browser session|browser worker)\b/i.test(
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

function taskFactExplicitlyDisclaimsBrowserRenderedEvidence(text: string): boolean {
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

function taskFactRequestsTimeoutRecovery(text: string): boolean {
  return (
    /\b(?:continue|resume|retry|recover|recovered|recovery|follow-?up)\b|继续|恢复|重试/i.test(
      text,
    ) &&
    /\b(?:timeout|timed[- ]out|bounded attempt|slow[- ]source|source[- ]check)\b|超时/i.test(
      text,
    )
  );
}

function readTaskFactIndependentEvidenceTarget(taskPrompt: string): number {
  if (isTaskFactTwoSourceComparisonTask(taskPrompt)) {
    return Math.min(6, uniqueTaskFactHttpUrlCount(taskPrompt));
  }
  if (/\b(?:three|3) independent evidence streams\b/i.test(taskPrompt)) {
    return 3;
  }
  if (
    /\b(?:three|3)\b[\s\S]{0,80}\b(?:separate|independent|distinct)\b[\s\S]{0,80}\bevidence streams\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:route|budget|live readiness)\b[\s\S]{0,120}\b(?:separate|independent|distinct)\b[\s\S]{0,80}\bevidence streams\b/i.test(
      taskPrompt,
    )
  ) {
    return 3;
  }
  if (
    /\bgather evidence from (?:three|3) independent child sessions\b/i.test(
      taskPrompt,
    )
  ) {
    return 3;
  }
  const sourceLineCount = taskPrompt
    .split(/\r?\n/)
    .filter((line) =>
      /^\s*(?:[-*]\s*)?(?:Research source|Capability source|Route source|Budget source|Live signal dashboard|Live readiness dashboard|[A-Z][\w -]{2,30}: use (?:an? )?(?:explore|browser) session)\b/i.test(
        line,
      ),
    ).length;
  return sourceLineCount >= 3 ? sourceLineCount : 0;
}

function isTaskFactTwoSourceComparisonTask(taskPrompt: string): boolean {
  if (uniqueTaskFactHttpUrlCount(taskPrompt) !== 2) return false;
  return (
    /\b(?:compare|comparison|between|versus|vs\.?|tradeoff|recommendation)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:review|check|inspect|fetch|extract)\b[\s\S]{0,120}\b(?:two|2)\b[\s\S]{0,80}\b(?:source pages?|sources?|urls?)\b/i.test(
      taskPrompt,
    ) ||
    /比较|对比|两个来源|两个页面|两个\s*URL/i.test(taskPrompt)
  );
}

function uniqueTaskFactHttpUrlCount(text: string): number {
  return new Set(
    Array.from(text.matchAll(/\bhttps?:\/\/[^\s"'`<>]+/gi), (match) =>
      match[0].replace(/[),.;，。；]+$/, ""),
    ),
  ).size;
}

export function markdownTableHasExactRequestedColumns(
  text: string,
  requestedColumns: string[],
): boolean {
  const headerRows = extractMarkdownTableHeaderRows(text);
  if (headerRows.length === 0) {
    return requestedColumns.length === 0;
  }
  const normalizedRequested = requestedColumns.map(normalizeTableHeaderCell);
  return headerRows.some((cells) => {
    const normalizedCells = cells.map(normalizeTableHeaderCell);
    return normalizedRequested.every((column) =>
      normalizedCells.includes(column),
    );
  });
}

export function normalizeColumnDetectionText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function buildRequestedTableColumnActivationContext(
  activation?: RoleActivationInput,
): string[] {
  const intent = activation?.handoff.payload.intent;
  if (!intent) return [];
  return [
    intent.relayBrief ?? "",
    intent.instructions ?? "",
    ...(intent.recentMessages ?? []).map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? ""),
    ),
  ];
}

export function buildOriginalRequestTableColumnContext(
  activation?: RoleActivationInput,
): string[] {
  const intent = activation?.handoff.payload.intent;
  if (!intent) return [];
  return [intent.relayBrief ?? "", intent.instructions ?? ""];
}

export function requestedTableColumnMessageContext(
  messages: LLMMessage[],
): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => readTaskFactMessageContentText(message.content));
}

export function resultIntroducesProviderSupportSchema(text: string): boolean {
  const normalized = normalizeColumnDetectionText(text);
  return (
    /\bprovider\b/.test(normalized) &&
    /search\/web_search|web_search|web search|是否明确支持 search|搜索/.test(
      normalized,
    ) &&
    /目标模型|model support|是否明确支持目标模型|deepseek|输入价格|input price|output price|输出价格/.test(
      normalized,
    )
  );
}

export function explicitlyRequestsProviderSupportSchema(text: string): boolean {
  const normalized = normalizeColumnDetectionText(text);
  return (
    /\bprovider\b|供应商|提供商/.test(normalized) &&
    /search\/web_search|web_search|web search|搜索/.test(normalized) &&
    /目标模型|model support|deepseek|输入价格|input price|output price|输出价格|per-token/.test(
      normalized,
    )
  );
}

export function requestedColumnsLookLikeProviderSearchPricing(
  columns: string[],
): boolean {
  if (columns.length === 0) {
    return false;
  }
  const normalized = columns.map((column) => column.toLowerCase()).join("\n");
  return (
    /\bprovider\b|供应商|服务商|厂商|平台/.test(normalized) &&
    /search|web_search|搜索/.test(normalized) &&
    /价格|价钱|费用|收费|计费|price|pricing|cost|input|output|输入|输出/.test(
      normalized,
    )
  );
}

export function recordRepairPrompt(
  repairMarkers: LLMMessage[],
  content: string,
): LLMMessage {
  const message: LLMMessage = { role: "user", content };
  repairMarkers.push(message);
  return message;
}

export function readAwaitingContextSetupNoToolSuppression(input: {
  taskPrompt: string;
  repairMarkers: LLMMessage[];
}): boolean {
  if (hasAwaitingContextSetupNoToolRepairPrompt(input.repairMarkers)) {
    return false;
  }
  return taskPromptRequestsAwaitingContextSetup(input.taskPrompt);
}

export interface AwaitingContextSetupNoToolSuppressionInput {
  taskPrompt: string;
  messages: LLMMessage[];
  lastText: string;
  repairMarkers: LLMMessage[];
}

export interface AwaitingContextSetupNoToolSuppressionResult {
  messages: LLMMessage[];
  forceToolChoice: "none";
}

export function applyAwaitingContextSetupNoToolSuppression(
  input: AwaitingContextSetupNoToolSuppressionInput,
): AwaitingContextSetupNoToolSuppressionResult | null {
  if (
    !readAwaitingContextSetupNoToolSuppression({
      taskPrompt: input.taskPrompt,
      repairMarkers: input.repairMarkers,
    })
  ) {
    return null;
  }
  return {
    messages: [
      ...input.messages,
      { role: "assistant", content: input.lastText },
      recordRepairPrompt(
        input.repairMarkers,
        buildAwaitingContextSetupNoToolRepairPrompt(input.taskPrompt),
      ),
    ],
    forceToolChoice: "none",
  };
}

export function taskPromptRequestsAwaitingContextSetup(
  taskPrompt: string,
): boolean {
  if (
    /\b(?:durable memory|memory_search|memory_get|check durable memory|inspect any candidate memory|recover the launch window|launch window|residual risk|previously captured)\b/i.test(
      taskPrompt,
    )
  ) {
    return false;
  }
  return (
    /\bno research (?:is )?(?:needed|required)\b|\bno action (?:is )?(?:needed|required)\b/i.test(
      taskPrompt,
    ) &&
    /\bbriefly acknowledge\b|\backnowledge\b/i.test(taskPrompt) &&
    /\b(?:continue|resume|proceed)\b[\s\S]{0,120}\b(?:context|details?|available|provided)\b/i.test(
      taskPrompt,
    )
  );
}

export function readMissingRequestedTableColumnsRepair(input: {
  activation?: RoleActivationInput | undefined;
  taskPrompt: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
}): boolean {
  if (hasMissingRequestedTableColumnsRepairPrompt(input.repairMarkers)) {
    return false;
  }
  const requestedColumns = resolveRequestedTableColumns([
    input.taskPrompt,
    ...buildRequestedTableColumnActivationContext(input.activation),
    ...requestedTableColumnMessageContext(input.messages),
  ]);
  if (requestedColumns.length === 0) return false;
  const normalizedResult = normalizeColumnDetectionText(input.resultText);
  if (
    !markdownTableHasExactRequestedColumns(input.resultText, requestedColumns)
  ) {
    return true;
  }
  return requestedColumns.some(
    (column) => !normalizedResult.includes(normalizeColumnDetectionText(column)),
  );
}

export function hasMissingRequestedTableColumnsRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readTaskFactMessageContentText(message.content).includes(
        "did not preserve the table columns explicitly requested",
      ),
  );
}

export function buildMissingRequestedTableColumnsRepairPrompt(input: {
  activation?: RoleActivationInput | undefined;
  taskPrompt: string;
  messages: LLMMessage[];
  resultText: string;
}): string {
  const requestedColumns = resolveRequestedTableColumns([
    input.taskPrompt,
    ...buildRequestedTableColumnActivationContext(input.activation),
    ...requestedTableColumnMessageContext(input.messages),
  ]);
  return [
    "The previous final answer did not preserve the table columns explicitly requested by the original user/task.",
    `Required table header columns: ${requestedColumns.join(" | ")}`,
    "Rewrite the final answer now without calling tools.",
    "The main table must include every required column above. Do not rename columns, transpose the table into Slot x Provider form, merge columns, or move any requested column into prose.",
    "For any cell not directly supported by source evidence already present, write 未验证.",
    "If any required goal slot remains unverified, mark the answer as blocked/partial and list the missing slots briefly after the table.",
  ].join("\n");
}

export function readExtraneousProviderTableSchemaRepair(input: {
  activation?: RoleActivationInput | undefined;
  taskPrompt: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
}): boolean {
  if (hasExtraneousProviderTableSchemaRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!resultIntroducesProviderSupportSchema(input.resultText)) {
    return false;
  }
  const originalContext = [
    input.taskPrompt,
    ...buildOriginalRequestTableColumnContext(input.activation),
  ].join("\n");
  const originalRequestedColumns = resolveRequestedTableColumns([
    originalContext,
  ]);
  if (
    originalRequestedColumns.length > 0 &&
    explicitlyRequestsProviderSupportSchema(originalContext)
  ) {
    return false;
  }
  return !explicitlyRequestsProviderSupportSchema(originalContext);
}

export function hasExtraneousProviderTableSchemaRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readTaskFactMessageContentText(message.content).includes(
        "introduced provider/search/model-support columns that were not requested",
      ),
  );
}

export function buildExtraneousProviderTableSchemaRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
}): string {
  return [
    "Runtime correction: final answer introduced provider/search/model-support columns that were not requested by the original task.",
    "Do not call tools. Rewrite the final answer using only the evidence already present.",
    "Remove the provider/search_web_search/target-model/input-price/output-price table schema unless those exact dimensions were requested by the original task.",
    "Use the original task dimensions instead: pricing, strengths, risks, tradeoff, and a clear recommendation for the product lead when those are requested.",
    "Do not mark the whole mission blocked merely because provider support, target-model support, search/web_search support, or token input/output pricing are absent when the original task did not ask for them.",
    "Keep residual risk visible only for source-bounded gaps actually relevant to the original task.",
    `Original task:\n${sliceTaskFactUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceTaskFactUtf8(input.resultText, 1400)}`,
  ].join("\n");
}

export function hasAwaitingContextSetupNoToolRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readTaskFactMessageContentText(message.content).includes(
        "Runtime correction: this turn is setup-only",
      ),
  );
}

export function buildAwaitingContextSetupNoToolRepairPrompt(
  taskPrompt: string,
): string {
  return [
    "Runtime correction: this turn is setup-only and explicitly says no research or action is needed yet.",
    "Do not call memory, browser, search, session, or task tools for this turn.",
    "Write a brief final answer that acknowledges the thread is ready, states no research is queued, and says the mission can continue when context is provided.",
    "Keep it concise and complete.",
    `Original task:\n${sliceTaskFactUtf8(taskPrompt, 1000)}`,
  ].join("\n");
}


function inferRequestedTableColumns(texts: string[]): string[] {
  const columns: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(
      /表格(?:列出|包含|字段|栏位|列)?\s*[:：]\s*([^\n。；;]+)/g,
    )) {
      const rawColumns = match[1] ?? "";
      for (const column of rawColumns.split(/[、,，|]+/)) {
        const normalized = normalizeRequestedTableColumn(column);
        if (!normalized) continue;
        columns.push(normalized);
      }
    }
    for (const match of text.matchAll(
      /table(?:\s+(?:with|containing|columns?))?\s*[:：]\s*([^\n.；;]+)/gi,
    )) {
      const rawColumns = match[1] ?? "";
      for (const column of rawColumns.split(/[、,，|]+/)) {
        const normalized = normalizeRequestedTableColumn(column);
        if (!normalized) continue;
        columns.push(normalized);
      }
    }
  }
  return Array.from(new Set(columns)).slice(0, 12);
}

function inferEvidenceSensitiveProviderTableColumns(texts: string[]): string[] {
  const context = texts.join("\n");
  if (
    !/(?:provider|供应商|提供商)/i.test(context) ||
    !/(?:price|pricing|价格|定价|input|output|输入|输出)/i.test(context) ||
    !/(?:search|web_search|web search|搜索)/i.test(context)
  ) {
    return [];
  }
  const targetModelName = inferRequestedTargetModelName(context);
  return [
    "provider",
    targetModelName ? `是否明确支持 ${targetModelName}` : "是否明确支持目标模型",
    "是否明确支持 search/web_search",
    "输入价格",
    "输出价格",
    "证据 URL",
    "关键原文摘录",
  ];
}

function inferRequestedTargetModelName(context: string): string | null {
  const apiModel = context.match(
    /\b([A-Z][A-Za-z0-9._-]*(?:\s+[A-Z0-9][A-Za-z0-9._-]*){1,6})\s+API\b/,
  )?.[1];
  if (apiModel) {
    return apiModel.trim();
  }
  const providerResearchModel = context.match(
    /\b(?:research|supports?|supporting|for|about|调研)\s+([A-Z][A-Za-z0-9._-]*(?:\s+[A-Z0-9][A-Za-z0-9._-]*){1,6}?)\s+(?:provider|providers|support|search|pricing|price|model|api|API|供应商|提供商|支持|搜索|价格|定价)\b/i,
  )?.[1];
  if (providerResearchModel) {
    return providerResearchModel.trim();
  }
  const supportsModel = context.match(
    /\bsupports?\s+([A-Z][A-Za-z0-9._-]*(?:\s+[A-Z0-9][A-Za-z0-9._-]*){1,6}?)(?:,|;|\.|\s+and\b|\s+whether\b)/i,
  )?.[1];
  if (supportsModel) {
    return supportsModel.trim();
  }
  const targetModel = context.match(
    /\b(?:target model|model|模型)\s*[:：]\s*([A-Za-z0-9._-]+(?:\s+[A-Za-z0-9._-]+){0,6})\b/i,
  )?.[1];
  return targetModel?.trim() || null;
}

function normalizeRequestedTableColumn(column: string): string | null {
  const normalized = column
    .replace(/^[\s`"'“”‘’]+|[\s`"'“”‘’]+$/g, "")
    .trim();
  if (!normalized) return null;
  if (normalized.length > 80) return null;
  if (/[|]/.test(normalized)) return null;
  if (/[。；;]/.test(normalized)) return null;
  if (/\.{3}|…|[*]{2,}|^---+$/.test(normalized)) return null;
  if (
    /(?:mission|status|状态|blocked|partial|final answer|source bounded)/i.test(
      normalized,
    )
  ) {
    return null;
  }
  return normalized;
}

function extractMarkdownTableHeaderRows(text: string): string[][] {
  const lines = text.split(/\r?\n/);
  const rows: string[][] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    if (
      !line.includes("|") ||
      !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)
    ) {
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  return rows;
}

function normalizeTableHeaderCell(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function readTaskFactMessageContentText(content: LLMMessage["content"]): string {
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

function sliceTaskFactUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}
