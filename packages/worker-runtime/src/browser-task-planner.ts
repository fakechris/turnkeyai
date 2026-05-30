import { decodeBrowserSessionPayload } from "@turnkeyai/core-types/browser-session-payload";
import {
  getContinuationContext,
  getInstructions,
  getRecentMessages,
  getRelayBrief,
} from "@turnkeyai/core-types/team";
import type { BrowserTaskAction, BrowserTaskRequest, WorkerInvocationInput } from "@turnkeyai/core-types/team";

interface BrowserTaskIntent {
  url?: string;
  searchQuery?: string;
  clickText?: string;
  wantsScroll: boolean;
  wantsConsoleProbe: boolean;
  wantsScreenshot: boolean;
}

interface DefaultBrowserTaskPlannerOptions {
  searchEngineUrlTemplate?: string;
}

const DEFAULT_SEARCH_ENGINE_URL_TEMPLATE = "https://www.google.com/search?q={query}";

export class DefaultBrowserTaskPlanner {
  private readonly searchEngineUrlTemplate: string;

  constructor(options: DefaultBrowserTaskPlannerOptions = {}) {
    this.searchEngineUrlTemplate = options.searchEngineUrlTemplate?.trim() || DEFAULT_SEARCH_ENGINE_URL_TEMPLATE;
  }

  buildRequest(input: WorkerInvocationInput): BrowserTaskRequest | null {
    const sourceText = [
      input.packet.taskPrompt,
      getInstructions(input.activation.handoff.payload),
      getRelayBrief(input.activation.handoff.payload),
      ...getRecentMessages(input.activation.handoff.payload).map((item) => item.content),
    ]
      .filter(Boolean)
      .join("\n");

    const browserSessionId = extractBrowserSessionId(input);
    const browserTargetId = extractBrowserTargetId(input);
    const continuationBrowserSession = getContinuationContext(input.activation.handoff.payload)?.browserSession ?? input.packet.continuationContext?.browserSession;
    const intent = deriveIntent(sourceText, {
      allowCurrentTargetReuse: Boolean(
        (browserSessionId && browserTargetId) ||
          (continuationBrowserSession?.sessionId && continuationBrowserSession.targetId)
      ),
    });
    if (!intent) {
      return null;
    }

    const ownerType = continuationBrowserSession?.ownerType ?? "thread";
    const ownerId = continuationBrowserSession?.ownerId ?? input.activation.thread.threadId;
    const leaseHolderRunKey = continuationBrowserSession?.leaseHolderRunKey ?? input.sessionState?.workerRunKey;
    const resolvedBrowserSessionId = browserSessionId ?? continuationBrowserSession?.sessionId;
    const resolvedTargetId = browserTargetId ?? continuationBrowserSession?.targetId;

    return {
      taskId: input.activation.handoff.taskId,
      threadId: input.activation.thread.threadId,
      instructions: sourceText,
      actions: buildActionPlan(intent, this.searchEngineUrlTemplate),
      ownerType,
      ownerId,
      profileOwnerType: ownerType,
      profileOwnerId: ownerId,
      ...(leaseHolderRunKey ? { leaseHolderRunKey } : {}),
      ...(resolvedBrowserSessionId ? { browserSessionId: resolvedBrowserSessionId } : {}),
      ...(resolvedTargetId ? { targetId: resolvedTargetId } : {}),
    };
  }
}

function extractBrowserSessionId(input: WorkerInvocationInput): string | null {
  return extractBrowserSessionDetails(input)?.sessionId ?? null;
}

function extractBrowserTargetId(input: WorkerInvocationInput): string | null {
  return extractBrowserSessionDetails(input)?.targetId ?? null;
}

function extractBrowserSessionDetails(input: WorkerInvocationInput) {
  const sessionState = input.sessionState;
  if (
    !sessionState ||
    sessionState.workerType !== "browser" ||
    sessionState.status === "failed" ||
    sessionState.status === "cancelled" ||
    (sessionState.status !== "resumable" && input.packet.continuityMode !== "resume-existing")
  ) {
    return null;
  }

  return decodeBrowserSessionPayload(sessionState.lastResult?.payload);
}

function deriveIntent(content: string, options: { allowCurrentTargetReuse: boolean }): BrowserTaskIntent | null {
  const url = extractUrl(content);
  const searchQuery = extractSearchQuery(content);
  if (!url && !searchQuery && !options.allowCurrentTargetReuse) {
    return null;
  }

  const clickText = extractClickTarget(content);

  return {
    ...(url ? { url } : {}),
    ...(searchQuery ? { searchQuery } : {}),
    ...(clickText ? { clickText } : {}),
    wantsScroll: /(scroll|滚动|向下)/i.test(content),
    wantsConsoleProbe:
      /(console|extract|提取|读取|统计|metadata|interactive|标题|链接|元素)/i.test(content) ||
      /summarize what you find/i.test(content),
    wantsScreenshot: !/不要截图|no screenshot/i.test(content),
  };
}

function buildActionPlan(intent: BrowserTaskIntent, searchEngineUrlTemplate: string): BrowserTaskAction[] {
  const plan: BrowserTaskAction[] = intent.url
    ? [{ kind: "open", url: intent.url }, { kind: "snapshot", note: "after-open" }]
    : intent.searchQuery
      ? [{ kind: "open", url: buildSearchUrl(intent.searchQuery, searchEngineUrlTemplate) }, { kind: "snapshot", note: "after-search-open" }]
      : [{ kind: "snapshot", note: "reuse-current-target" }];

  if (intent.url && intent.searchQuery) {
    plan.push({
      kind: "type",
      selectors: [
        'textarea[name="q"]',
        'input[name="q"]',
        'input[type="search"]',
        'input[placeholder*="Search"]',
        '[role="searchbox"]',
      ],
      text: intent.searchQuery,
      submit: true,
    });
    plan.push({ kind: "snapshot", note: "after-search" });
  }

  if (!intent.searchQuery && intent.clickText) {
    plan.push({ kind: "click", text: intent.clickText });
    plan.push({ kind: "snapshot", note: "after-click" });
  }

  if (intent.wantsScroll) {
    plan.push({ kind: "scroll", direction: "down", amount: 900 });
    plan.push({ kind: "snapshot", note: "after-scroll" });
  }

  if (intent.wantsConsoleProbe) {
    plan.push({ kind: "console", probe: "page-metadata" });
  }

  if (intent.wantsScreenshot) {
    plan.push({ kind: "screenshot", label: "final" });
  }

  return plan;
}

function extractUrl(content: string): string | null {
  const match = content.match(/https?:\/\/[^\s)]+/i);
  const raw = match?.[0];
  if (!raw) {
    return null;
  }

  const sanitized = raw.replace(/["'`,;:.!?。，“”‘’！？：]+$/g, "");
  try {
    const url = new URL(sanitized);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function extractSearchQuery(content: string): string | null {
  const strategies = [
    /\bsearch\s+for\s+(.+?)(?:\.|,|\n|$)/i,
    /\bsearch\s+(.+?)(?:\.|,|\n|$)/i,
    /\bresearch\s+(.+?)(?:\.|,|\n|$)/i,
    /搜索\s*[“"]?(.+?)[”"]?(?:。|，|\n|$)/,
    /查询\s*[“"]?(.+?)[”"]?(?:。|，|\n|$)/,
  ];

  for (const pattern of strategies) {
    const value = content.match(pattern)?.[1]?.trim();
    if (value) {
      return stripTrailingNoise(value);
    }
  }

  return null;
}

function extractClickTarget(content: string): string | null {
  const strategies = [
    /(click|open)\s+(?:on\s+)?["“](.+?)["”]/i,
    /(点击|打开)\s*[“"](.+?)[”"]/,
    /(click|open)\s+the\s+(.+?)(?:\.|,|\n|$)/i,
  ];

  for (const pattern of strategies) {
    const value = content.match(pattern)?.[2]?.trim();
    if (value) {
      return stripTrailingNoise(value);
    }
  }

  return null;
}

function stripTrailingNoise(value: string): string {
  return value
    .replace(/\band report back.*$/i, "")
    .replace(/\band summarize.*$/i, "")
    .replace(/\bthen return.*$/i, "")
    .replace(/并汇报.*$/, "")
    .replace(/并返回.*$/, "")
    .trim();
}

function buildSearchUrl(query: string, template: string): string {
  const encoded = encodeURIComponent(query);
  if (template.includes("{query}")) {
    return template.replaceAll("{query}", encoded);
  }

  try {
    const url = new URL(template);
    url.searchParams.set("q", query);
    return url.toString();
  } catch {
    return DEFAULT_SEARCH_ENGINE_URL_TEMPLATE.replace("{query}", encoded);
  }
}
