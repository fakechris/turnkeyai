// Stage 8 engine cleanup — TaskFacts.
//
// Authority: centralize task prompt/message facts used by repair policies and
// final synthesis guards. This module does not own policy order, tool execution,
// final synthesis, or authorization.
import type { RoleActivationInput } from "@turnkeyai/core-types/team";

import type { LLMMessage } from "./types";

export const TASK_FACTS_MODULE = "task-facts" as const;

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
